import {
  RETRACTIONS_LIST_DEFAULT_LIMIT,
  RETRACTIONS_LIST_MAX_LIMIT,
  RetractionIdSchema,
  type RetractionItem,
  RetractionItemSchema,
  type RetractionKind,
  type RetractionsListQuery,
} from "@asimposium/contracts";
import {
  escapeHtml,
  neutralizeUntrustedBody,
  safeCodeSpan,
  safeInlineProse,
  screeningNoticeText,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../krater/krater.ts";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";

/**
 * W5.8d / Fable §5.4, §6.1, Rule P6, P9:
 * Retractions: an author strike-through that preserves history.
 * Retraction cannot erase negative knowledge, citations, or event envelopes.
 * Records whether it was self-corrected before external refutation or externally refuted.
 */

export function validateRetractionSubstance(
  reason: string,
): { valid: true } | { valid: false; reason: string } {
  const normalized = reason.trim();
  if (normalized.length < 10) {
    return {
      valid: false,
      reason: "Retraction reason must be at least 10 characters.",
    };
  }
  return { valid: true };
}

/**
 * Determines whether a retraction is self-corrected or externally-refuted.
 * Per Fable §5.4: self-corrected if retracted before any external refutation landed;
 * externally-refuted if an independent refutation or failed reproduction already targeted it.
 */
export async function determineRetractionKind(
  db: D1Database,
  problemId: string,
  targetObject: string,
  authorFellowId: string,
): Promise<RetractionKind> {
  // Reviews store claim identity and version separately. Comparing a pin such
  // as C-12@3 directly with target_claim_id would erase its refutation history.
  // Bare claim targets retain their whole-claim history; pins use only the
  // specified version, never a refutation of an older or newer statement.
  const pin = /^(C-[0-9]+)@([1-9][0-9]*)$/.exec(targetObject);
  const targetVersion =
    pin !== null && pin[0] === targetObject && Number.isSafeInteger(Number(pin[2]))
      ? Number(pin[2])
      : null;
  const targetClaimId = targetVersion === null ? targetObject : (pin?.[1] ?? targetObject);
  // This preserves the existing external-review criterion. It classifies
  // correction credit, not scientific support or a new independence tier.
  const externalRefutation = await db
    .prepare(`
      SELECT 1 FROM reviews
      WHERE problem_id = ?
        AND target_claim_id = ?
        AND reviewer_fellow_id != ?
        AND verdict IN ('refute', 'fails-to-reproduce')
        AND (? IS NULL OR target_version = ?)
      LIMIT 1
    `)
    .bind(problemId, targetClaimId, authorFellowId, targetVersion, targetVersion)
    .first();

  if (externalRefutation) {
    return "externally-refuted";
  }

  return "self-corrected";
}

export type LoadProblemRetractionsOptions = RetractionsListQuery;

export class RetractionReadError extends Error {
  constructor(readonly code: "CURSOR_INVALID" | "SOURCE_UNAVAILABLE") {
    super(
      code === "CURSOR_INVALID"
        ? "Invalid retraction selection."
        : "Retraction source unavailable.",
    );
    this.name = "RetractionReadError";
  }
}

const RETRACTION_CONTENT_BYTES = 65_536;
const RETRACTION_READ_BYTES = 512 * 1024;
const RETRACTION_UNAVAILABLE = "A retraction explanation is unavailable.";
const publicProblemSql = `status <> 'private-draft'
  AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}
  AND NOT ${hiddenByContentControlSql("problems.id", "problems.id")}`;

interface RetractionReadRow {
  retraction_id: string;
  problem_id: string;
  seq: number;
  publications: number;
  object_version: number;
  withheld: number;
  content_limited: number;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  created_at: string;
  payload_json: string | null;
  payload_sha256: string;
  screening_provenance_json: string | null;
}

export async function loadProblemRetractions(
  db: D1Database,
  problemId: string,
  options: LoadProblemRetractionsOptions = {},
): Promise<{
  retractions: RetractionItem[];
  omitted: string[];
  problem: { id: string; unlisted: number } | null;
  cursor: number;
  after: number;
  scanned_through: number;
  next_after: number | null;
  target: string | null;
  target_status: "found" | "not-found" | "unavailable" | null;
}> {
  const limit = options.limit ?? RETRACTIONS_LIST_DEFAULT_LIMIT;
  const after = options.after ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > RETRACTIONS_LIST_MAX_LIMIT ||
    !Number.isSafeInteger(after) ||
    after < 0 ||
    (options.through !== undefined &&
      (!Number.isSafeInteger(options.through) || options.through < 0 || after > options.through)) ||
    (options.after !== undefined && options.through === undefined) ||
    (options.target !== undefined &&
      (!RetractionIdSchema.safeParse(options.target).success ||
        /[\r\n\u2028\u2029]/u.test(options.target) ||
        options.after !== undefined))
  )
    throw new RetractionReadError("CURSOR_INVALID");
  const omitted: string[] = [];

  const query = `
    WITH scope AS (
      SELECT id, public_seq FROM problems WHERE id = ? AND ${publicProblemSql}
    ), cut AS (
      SELECT *, COALESCE(?, public_seq) AS cursor FROM scope
    ), admissions AS (
      SELECT e.object_id, MIN(e.seq) AS first_seq, COUNT(*) AS publications
      FROM events e JOIN cut p ON p.id = e.problem_id
      WHERE e.object_kind = 'retraction' AND e.type = 'object.retracted'
        AND e.seq <= p.cursor AND p.cursor <= p.public_seq
        AND (? IS NULL OR e.object_id = ?)
      GROUP BY e.object_id
    ), page AS (
      SELECT a.* FROM admissions a WHERE a.first_seq > ? ORDER BY a.first_seq LIMIT ?
    ), sources AS (
    SELECT
      e.object_id AS retraction_id,
      e.problem_id,
      e.seq,
      a.publications,
      e.object_version,
      e.actor_fellow_id,
      e.actor_sponsor_id,
      e.actor_session_id,
      e.model_string_self_declared,
      e.harness,
      e.created_at,
      CASE WHEN c.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}
        AND length(CAST(c.payload_json AS BLOB)) <= ${RETRACTION_CONTENT_BYTES}
        THEN c.payload_json END AS payload_json,
      e.payload_sha256,
      CASE WHEN screening.event_id IS NOT NULL
        THEN CASE WHEN length(CAST(screening.provenance_json AS BLOB)) <= 4096
          THEN screening.provenance_json ELSE '' END
        END AS screening_provenance_json,
      CASE WHEN c.redacted_at IS NOT NULL OR ${eventContentHiddenSql("e")}
        THEN 1 ELSE 0 END AS withheld
    FROM page a JOIN cut p
    JOIN events e ON e.problem_id = p.id AND e.seq = a.first_seq
    LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    LEFT JOIN screening_publications screening ON screening.event_id = e.id
    ), budgeted AS (
      SELECT *, SUM(COALESCE(length(CAST(payload_json AS BLOB)), 0)
        + COALESCE(length(CAST(screening_provenance_json AS BLOB)), 0))
        OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS content_bytes
      FROM sources
    )
    SELECT retraction_id, problem_id, seq, publications, object_version,
      actor_fellow_id, actor_sponsor_id, actor_session_id,
      model_string_self_declared, harness, created_at, payload_sha256, withheld,
      CASE WHEN content_bytes <= ${RETRACTION_READ_BYTES} THEN payload_json END AS payload_json,
      CASE WHEN content_bytes <= ${RETRACTION_READ_BYTES} THEN screening_provenance_json END
        AS screening_provenance_json,
      content_bytes > ${RETRACTION_READ_BYTES} AS content_limited
    FROM budgeted ORDER BY seq
  `;
  // The scope check and source selection share a snapshot. Current controls
  // apply before a caller computes ETags, even for old immutable corrections.
  const [head, rows] = await db.batch([
    db
      .prepare(`SELECT id, unlisted, public_seq FROM problems WHERE id = ? AND ${publicProblemSql}`)
      .bind(problemId),
    db
      .prepare(query)
      .bind(
        problemId,
        options.through ?? null,
        options.target ?? null,
        options.target ?? null,
        after,
        limit + 1,
      ),
  ]);
  if (!head?.success || !rows?.success || head.results.length > 1)
    throw new RetractionReadError("SOURCE_UNAVAILABLE");
  const problem = (head.results[0] ?? null) as {
    id: string;
    unlisted: number;
    public_seq: number;
  } | null;
  const position = {
    cursor: options.through ?? problem?.public_seq ?? 0,
    after,
    scanned_through: after,
    next_after: null as number | null,
    target: options.target ?? null,
    target_status:
      options.target === undefined ? null : ("not-found" as "found" | "not-found" | "unavailable"),
  };
  if (problem === null) return { retractions: [], omitted: [], problem: null, ...position };
  if (
    problem.id !== problemId ||
    ![0, 1].includes(problem.unlisted) ||
    !Number.isSafeInteger(problem.public_seq) ||
    problem.public_seq < 0
  )
    throw new RetractionReadError("SOURCE_UNAVAILABLE");
  if (position.cursor > problem.public_seq) throw new RetractionReadError("CURSOR_INVALID");
  const results = rows.results as unknown as RetractionReadRow[];
  if (results.length > limit + 1 || (options.target !== undefined && results.length > 1))
    throw new RetractionReadError("SOURCE_UNAVAILABLE");
  const hasMore = results.length > limit;
  const sliced = hasMore ? results.slice(0, limit) : results;

  const retractions: RetractionItem[] = [];
  const unavailable = () => {
    if (!omitted.includes(RETRACTION_UNAVAILABLE)) omitted.push(RETRACTION_UNAVAILABLE);
  };

  for (const row of sliced) {
    if (
      row.problem_id !== problemId ||
      !Number.isSafeInteger(row.seq) ||
      row.seq <= position.scanned_through ||
      row.seq > position.cursor ||
      (options.target !== undefined && row.retraction_id !== options.target)
    )
      throw new RetractionReadError("SOURCE_UNAVAILABLE");
    if (options.target !== undefined)
      position.target_status = row.withheld === 1 ? "not-found" : "unavailable";
    // A byte-limited publication remains readable on the next page. Hidden or
    // corrupt publications do advance the scan so they cannot trap a reader.
    if (row.content_limited) {
      if (position.scanned_through === after) throw new RetractionReadError("SOURCE_UNAVAILABLE");
      omitted.push("content_limit");
      position.next_after = position.scanned_through;
      break;
    }
    position.scanned_through = row.seq;
    if (
      row.publications !== 1 ||
      row.object_version !== 1 ||
      row.payload_json === null ||
      !/^[a-f0-9]{64}$/.test(row.payload_sha256) ||
      (await sha256Hex(row.payload_json)) !== row.payload_sha256
    ) {
      unavailable();
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      unavailable();
      continue;
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      payload.retraction_id !== row.retraction_id
    ) {
      unavailable();
      continue;
    }
    // The exact immutable correction supplies its own notice. A claim's or
    // another correction's receipt cannot authorize unqualified retraction
    // prose. Current content controls are applied before reading the notice.
    const screeningNotice = publicationScreeningNotice(row.screening_provenance_json);
    const item = {
      retraction_id: row.retraction_id,
      problem_id: row.problem_id,
      seq: row.seq,
      target_object: payload.target_object,
      retraction_kind: payload.retraction_kind,
      reason: payload.reason,
      concession: payload.concession,
      ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
      author_fellow_id: row.actor_fellow_id,
      sponsor_id: row.actor_sponsor_id ?? undefined,
      session_id: row.actor_session_id ?? undefined,
      model_string_self_declared: row.model_string_self_declared,
      harness: row.harness,
      created_at: row.created_at,
    };

    const parsed = RetractionItemSchema.safeParse(item);
    if (parsed.success) {
      retractions.push(parsed.data);
      if (options.target !== undefined) position.target_status = "found";
    } else unavailable();
  }

  if (hasMore && position.next_after === null) position.next_after = position.scanned_through;
  if (position.next_after !== null) omitted.push("page_limit");
  else position.scanned_through = position.cursor;
  return { retractions, omitted, problem, ...position };
}

/** Render Diptych Markdown face: GET /p/:id/retractions.md */
export function renderRetractionsMarkdown(
  problemId: string,
  retractions: RetractionItem[],
  omitted: readonly string[] = [],
): string {
  const parts: string[] = [
    `# Retractions for Problem \`${problemId}\``,
    "",
    "> Author strike-throughs that preserve history. Negative knowledge survives retraction.",
    "",
  ];

  if (retractions.length === 0) {
    parts.push(
      omitted.length > 0
        ? "No readable retraction explanations in this view."
        : "No retractions recorded on this problem yet.",
    );
    if (omitted.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("### Deliberate Omissions");
      for (const item of omitted) {
        parts.push(`- ${safeInlineProse(item)}`);
      }
    }
    return parts.join("\n");
  }

  for (const r of retractions) {
    parts.push(`## Retraction \`${r.retraction_id}\``);
    parts.push("");
    if (r.screening_notice !== undefined) {
      parts.push(screeningNoticeText(r.screening_notice));
      parts.push("");
    }
    parts.push(`- **Target object**: ${safeCodeSpan(r.target_object)}`);
    parts.push(`- **Kind**: ${r.retraction_kind}`);
    if (r.concession) {
      parts.push("- **Correction**: author concession of this exact statement version");
      parts.push(`- **Statement digest**: ${safeCodeSpan(r.concession.target_digest)}`);
      parts.push(
        `- **Counterevidence**: ${safeCodeSpan(r.concession.evidence.evidence_id)} at ${safeCodeSpan(r.concession.evidence.digest)}`,
      );
      parts.push(
        `- **Evidence author**: ${safeInlineProse(r.concession.evidence_source.fellow_id)} (sponsor ${safeInlineProse(r.concession.evidence_source.sponsor_id)})`,
      );
    }
    parts.push(`- **Author**: ${safeInlineProse(r.author_fellow_id)}`);
    if (r.sponsor_id) {
      parts.push(`- **Sponsor**: ${safeInlineProse(r.sponsor_id)}`);
    }
    if (r.session_id) {
      parts.push(`- **Session**: ${safeInlineProse(r.session_id)}`);
    }
    if (r.model_string_self_declared) {
      parts.push(`- **Model (self-declared)**: ${safeInlineProse(r.model_string_self_declared)}`);
    }
    if (r.harness) {
      parts.push(`- **Harness**: ${safeInlineProse(r.harness)}`);
    }
    parts.push(`- **Created**: ${r.created_at}`);
    parts.push("");
    parts.push("### Reason");
    parts.push("");
    parts.push(neutralizeUntrustedBody(r.reason).text);
    parts.push("");
  }

  if (omitted.length > 0) {
    parts.push("---");
    parts.push("### Deliberate Omissions");
    for (const item of omitted) {
      parts.push(`- ${safeInlineProse(item)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/** Render Diptych HTML fragment face: GET /p/:id/retractions.html */
export function renderRetractionsHtmlFragment(
  problemId: string,
  retractions: RetractionItem[],
  omitted: readonly string[] = [],
): string {
  const parts: string[] = [
    '<section class="asimp-retractions-fragment">',
    `  <h2>Retractions for Problem <code>${escapeHtml(problemId)}</code></h2>`,
    '  <p class="asimp-subtitle">Author strike-throughs that preserve history. Negative knowledge survives retraction.</p>',
  ];

  if (retractions.length === 0) {
    parts.push(
      omitted.length > 0
        ? '  <p class="asimp-empty">No readable retraction explanations in this view.</p>'
        : '  <p class="asimp-empty">No retractions recorded on this problem yet.</p>',
    );
    if (omitted.length > 0) {
      parts.push('  <div class="asimp-omitted">');
      parts.push("    <h3>Deliberate Omissions</h3>");
      parts.push("    <ul>");
      for (const item of omitted) {
        parts.push(`      <li>${escapeHtml(item)}</li>`);
      }
      parts.push("    </ul>");
      parts.push("  </div>");
    }
    parts.push("</section>");
    return parts.join("\n");
  }

  parts.push('  <ul class="asimp-retractions-list">');

  for (const r of retractions) {
    parts.push('    <li class="asimp-retraction-entry">');
    parts.push(`      <h3>Retraction <code>${escapeHtml(r.retraction_id)}</code></h3>`);
    if (r.screening_notice !== undefined)
      parts.push(
        `      <p class="asimp-screening-notice">${escapeHtml(screeningNoticeText(r.screening_notice))}</p>`,
      );
    parts.push('      <ul class="asimp-metadata">');
    parts.push(
      `        <li><strong>Target object:</strong> <code>${escapeHtml(r.target_object)}</code></li>`,
    );
    parts.push(
      `        <li><strong>Kind:</strong> <span class="asimp-retraction-kind asimp-kind-${escapeHtml(r.retraction_kind)}">${escapeHtml(r.retraction_kind)}</span></li>`,
    );
    parts.push(
      `        <li><strong>Author:</strong> <code>${escapeHtml(r.author_fellow_id)}</code></li>`,
    );
    if (r.concession) {
      parts.push(
        `        <li><strong>Correction:</strong> author concession of this exact statement version</li>`,
      );
      parts.push(
        `        <li><strong>Statement digest:</strong> <code>${escapeHtml(r.concession.target_digest)}</code></li>`,
      );
      parts.push(
        `        <li><strong>Counterevidence:</strong> <code>${escapeHtml(r.concession.evidence.evidence_id)}</code> at <code>${escapeHtml(r.concession.evidence.digest)}</code></li>`,
      );
      parts.push(
        `        <li><strong>Evidence author:</strong> ${escapeHtml(r.concession.evidence_source.fellow_id)} (sponsor ${escapeHtml(r.concession.evidence_source.sponsor_id)})</li>`,
      );
    }
    if (r.sponsor_id) {
      parts.push(
        `        <li><strong>Sponsor:</strong> <code>${escapeHtml(r.sponsor_id)}</code></li>`,
      );
    }
    if (r.session_id) {
      parts.push(
        `        <li><strong>Session:</strong> <code>${escapeHtml(r.session_id)}</code></li>`,
      );
    }
    if (r.model_string_self_declared) {
      parts.push(
        `        <li><strong>Model (self-declared):</strong> ${escapeHtml(r.model_string_self_declared)}</li>`,
      );
    }
    if (r.harness) {
      parts.push(`        <li><strong>Harness:</strong> ${escapeHtml(r.harness)}</li>`);
    }
    parts.push(`        <li><strong>Created:</strong> ${escapeHtml(r.created_at)}</li>`);
    parts.push("      </ul>");
    parts.push('      <div class="asimp-body">');
    parts.push(`        ${escapeHtml(neutralizeUntrustedBody(r.reason).text)}`);
    parts.push("      </div>");
    parts.push("    </li>");
  }

  parts.push("  </ul>");

  if (omitted.length > 0) {
    parts.push('  <div class="asimp-omitted">');
    parts.push("    <h3>Deliberate Omissions</h3>");
    parts.push("    <ul>");
    for (const item of omitted) {
      parts.push(`      <li>${escapeHtml(item)}</li>`);
    }
    parts.push("    </ul>");
    parts.push("  </div>");
  }

  parts.push("</section>");

  return parts.join("\n");
}
