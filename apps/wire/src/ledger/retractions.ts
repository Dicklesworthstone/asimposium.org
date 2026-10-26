import {
  type RetractionItem,
  RetractionItemSchema,
  type RetractionKind,
} from "@asimposium/contracts";
import {
  escapeHtml,
  neutralizeUntrustedBody,
  safeCodeSpan,
  safeInlineProse,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../krater/krater.ts";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";

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

export interface LoadProblemRetractionsOptions {
  limit?: number;
}

const RETRACTION_CONTENT_BYTES = 65_536;
const RETRACTION_UNAVAILABLE = "A retraction explanation is unavailable.";
const publicProblemSql = `status <> 'private-draft'
  AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`;

interface RetractionReadRow {
  retraction_id: string;
  problem_id: string;
  seq: number;
  publications: number;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  created_at: string;
  payload_json: string | null;
  payload_sha256: string;
}

export async function loadProblemRetractions(
  db: D1Database,
  problemId: string,
  options: LoadProblemRetractionsOptions = {},
): Promise<{
  retractions: RetractionItem[];
  omitted: string[];
  problem: { id: string; unlisted: number } | null;
}> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const omitted: string[] = [];

  const query = `
    WITH scope AS (
      SELECT id, public_seq FROM problems WHERE id = ? AND ${publicProblemSql}
    ), admissions AS (
      SELECT e.object_id, MIN(e.seq) AS first_seq, COUNT(*) AS publications
      FROM events e JOIN scope p ON p.id = e.problem_id
      WHERE e.object_kind = 'retraction' AND e.type = 'object.retracted'
        AND e.seq <= p.public_seq
      GROUP BY e.object_id
    ), page AS (
      SELECT a.* FROM admissions a ORDER BY a.first_seq LIMIT ?
    )
    SELECT
      e.object_id AS retraction_id,
      e.problem_id,
      e.seq,
      a.publications,
      e.actor_fellow_id,
      e.actor_sponsor_id,
      e.actor_session_id,
      e.model_string_self_declared,
      e.harness,
      e.created_at,
      CASE WHEN c.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}
        AND length(CAST(c.payload_json AS BLOB)) <= ${RETRACTION_CONTENT_BYTES}
        THEN c.payload_json END AS payload_json,
      e.payload_sha256
    FROM page a JOIN scope p
    JOIN events e ON e.problem_id = p.id AND e.seq = a.first_seq
    LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    ORDER BY e.seq
  `;
  // The scope check and source selection share a snapshot. Current controls
  // apply before a caller computes ETags, even for old immutable corrections.
  const [head, rows] = await db.batch([
    db
      .prepare(`SELECT id, unlisted FROM problems WHERE id = ? AND ${publicProblemSql}`)
      .bind(problemId),
    db.prepare(query).bind(problemId, limit + 1),
  ]);
  if (!head?.success || !rows?.success) throw new Error("Retraction read failed.");
  const problem = (head.results[0] ?? null) as { id: string; unlisted: number } | null;
  if (problem === null) return { retractions: [], omitted: [], problem: null };
  const results = rows.results as unknown as RetractionReadRow[];
  const hasMore = results.length > limit;
  const sliced = hasMore ? results.slice(0, limit) : results;

  if (hasMore) {
    omitted.push(`truncated at limit of ${limit} retractions`);
  }

  const retractions: RetractionItem[] = [];
  const unavailable = () => {
    if (!omitted.includes(RETRACTION_UNAVAILABLE)) omitted.push(RETRACTION_UNAVAILABLE);
  };

  for (const row of sliced) {
    if (
      row.publications !== 1 ||
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
    const item = {
      retraction_id: row.retraction_id,
      problem_id: row.problem_id,
      seq: row.seq,
      target_object: payload.target_object,
      retraction_kind: payload.retraction_kind,
      reason: payload.reason,
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
    } else unavailable();
  }

  return { retractions, omitted, problem };
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
    parts.push(`- **Target object**: ${safeCodeSpan(r.target_object)}`);
    parts.push(`- **Kind**: ${r.retraction_kind}`);
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
