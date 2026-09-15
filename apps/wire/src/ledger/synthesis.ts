/**
 * W5.8b Synthesis lifecycle and P13 ledger anchoring (Fable §6.1, §6.3, Rule P13).
 *
 * A synthesis is a periodic state-of-the-problem digest generated from a frozen cursor.
 * Rule P13: Synthesis follows the ledger. Declared anchors that do not resolve
 * to the specified ledger objects at covers_through fail with SYNTHESIS_UNANCHORED.
 *
 * Reference validation establishes event identity, not the truth or completeness
 * of free-form scientific assertions in the synthesis body.
 */

import type { SynthesisAnchor, SynthesisItem } from "@asimposium/contracts";
import { escapeHtml, neutralizeUntrustedBody, safeCodeSpan } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";

export interface SynthesisValidationResult {
  readonly valid: boolean;
  readonly unanchored: readonly string[];
  readonly maxLedgerSeq: number;
  readonly reason?: string;
}

/**
 * Validates that all synthesis anchors exist on the specified problem and
 * were recorded at or before covers_through (seq <= covers_through).
 * Per Rule P13, any missing object or object published after covers_through
 * is flagged as unanchored.
 */
export async function validateSynthesisAnchors(
  db: D1Database,
  problemId: string,
  coversThrough: number,
  anchors: readonly SynthesisAnchor[],
): Promise<SynthesisValidationResult> {
  const maxSeqRow = await db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE problem_id = ?")
    .bind(problemId)
    .first<{ max_seq: number }>();
  const maxLedgerSeq = maxSeqRow?.max_seq ?? 0;

  if (coversThrough < 0 || coversThrough > maxLedgerSeq) {
    return {
      valid: false,
      unanchored: [],
      maxLedgerSeq,
      reason: `covers_through ${coversThrough} exceeds highest recorded problem sequence ${maxLedgerSeq}`,
    };
  }

  if (anchors.length === 0) {
    if (maxLedgerSeq > 0) {
      return {
        valid: false,
        unanchored: ["EMPTY_ANCHORS"],
        maxLedgerSeq,
        reason:
          "A synthesis on an active problem with recorded events must reference at least one anchor",
      };
    }
    return { valid: true, unanchored: [], maxLedgerSeq };
  }

  // Resolve all anchors in one bounded D1 query. Each supplied pin must match
  // the SAME event, and later writes cannot invalidate this retained window.
  // Statements use the problem identity and only formulation-bearing events;
  // a statement review or lifecycle transition cannot stand in for a version.
  const unanchored = await db
    .prepare(
      `SELECT json_extract(a.value, '$.target_id') AS target_id
       FROM json_each(?) a
       WHERE NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.problem_id = ? AND e.seq <= ?
           AND e.object_id = json_extract(a.value, '$.target_id')
           AND e.object_kind = CASE json_extract(a.value, '$.target_kind')
             WHEN 'statement' THEN 'problem'
             ELSE json_extract(a.value, '$.target_kind') END
           AND (json_extract(a.value, '$.target_kind') != 'statement'
             OR e.type IN ('problem.admitted', 'problem.statement-revised'))
           AND (json_extract(a.value, '$.target_version') IS NULL
             OR e.object_version = json_extract(a.value, '$.target_version'))
           AND (json_extract(a.value, '$.target_seq') IS NULL
             OR e.seq = json_extract(a.value, '$.target_seq'))
       )
       ORDER BY a.key`,
    )
    .bind(JSON.stringify(anchors), problemId, coversThrough)
    .all<{ target_id: string }>();
  const unanchoredIds = unanchored.results.map((row) => row.target_id);

  if (unanchoredIds.length > 0) {
    return {
      valid: false,
      unanchored: unanchoredIds,
      maxLedgerSeq,
      reason: `Anchors not grounded in ledger at or before covers_through=${coversThrough}: ${unanchoredIds.join(", ")}`,
    };
  }

  return {
    valid: true,
    unanchored: [],
    maxLedgerSeq,
  };
}

/**
 * Computes the count of single-author findings on a problem that are omitted from the synthesis anchors.
 * Per Fable §6.1 / Rev 3.1: ledger objects promoted by exactly one Fellow and cited by no other.
 * Checks claims, hypotheses, and dead ends.
 */
export async function computeDroppedSingleAuthorCount(
  db: D1Database,
  problemId: string,
  coversThrough: number,
  anchoredTargetIds: ReadonlySet<string> | readonly string[],
): Promise<number> {
  const targetSet =
    anchoredTargetIds instanceof Set ? anchoredTargetIds : new Set(anchoredTargetIds);
  let singleAuthorDropped = 0;

  // 1. Claims
  const claims = await db
    .prepare(
      `SELECT DISTINCT object_id AS claim_id, actor_fellow_id AS author_fellow_id FROM events
       WHERE problem_id = ? AND object_kind = 'claim' AND seq <= ?`,
    )
    .bind(problemId, coversThrough)
    .all<{ claim_id: string; author_fellow_id: string }>();

  for (const c of claims?.results ?? []) {
    if (targetSet.has(c.claim_id)) continue;
    // Check if any other Fellow reviewed this claim at or before coversThrough
    const otherReviews = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM reviews
         WHERE problem_id = ? AND target_claim_id = ? AND reviewer_fellow_id != ? AND source_seq <= ?`,
      )
      .bind(problemId, c.claim_id, c.author_fellow_id, coversThrough)
      .first<{ count: number }>();

    if ((otherReviews?.count ?? 0) > 0) continue;

    // Check if any other Fellow referenced this claim in a relation
    const otherRelations = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM claim_relations r
         JOIN events e ON e.id = r.asserted_by_event AND e.problem_id = r.problem_id
         WHERE r.problem_id = ? AND e.seq <= ?
           AND (r.source_claim_id = ? OR r.target_ref LIKE ? || '@%')
           AND r.asserted_by_fellow != ?`,
      )
      .bind(problemId, coversThrough, c.claim_id, c.claim_id, c.author_fellow_id)
      .first<{ count: number }>();

    if ((otherRelations?.count ?? 0) > 0) continue;

    singleAuthorDropped++;
  }

  // 2. Hypotheses
  const hypotheses = await db
    .prepare(
      `SELECT DISTINCT object_id AS hypothesis_id, actor_fellow_id AS author_fellow_id FROM events
       WHERE problem_id = ? AND object_kind = 'hypothesis' AND seq <= ?`,
    )
    .bind(problemId, coversThrough)
    .all<{ hypothesis_id: string; author_fellow_id: string }>();

  for (const h of hypotheses?.results ?? []) {
    if (targetSet.has(h.hypothesis_id)) continue;
    // Check if any other Fellow cited this hypothesis in evidence at or before coversThrough
    const otherEvidence = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM events e
         JOIN event_content c ON c.event_id = e.id
         WHERE e.problem_id = ? AND e.object_kind = 'evidence' AND e.actor_fellow_id != ? AND e.seq <= ?
           AND json_extract(c.payload_json, '$.hypothesis_id') = ?`,
      )
      .bind(problemId, h.author_fellow_id, coversThrough, h.hypothesis_id)
      .first<{ count: number }>();
    if ((otherEvidence?.count ?? 0) > 0) continue;

    singleAuthorDropped++;
  }

  // 3. Dead ends
  const deadEnds = await db
    .prepare(
      `SELECT DISTINCT object_id AS dead_end_id, actor_fellow_id AS author_fellow_id FROM events
       WHERE problem_id = ? AND object_kind = 'dead_end' AND seq <= ?`,
    )
    .bind(problemId, coversThrough)
    .all<{ dead_end_id: string; author_fellow_id: string }>();

  for (const de of deadEnds?.results ?? []) {
    if (targetSet.has(de.dead_end_id)) continue;
    // Check if another Fellow superseded this dead end in a retry at or before coversThrough
    const otherRetries = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM dead_ends
         WHERE problem_id = ? AND supersedes_dead_end_id = ? AND author_fellow_id != ? AND seq <= ?`,
      )
      .bind(problemId, de.dead_end_id, de.author_fellow_id, coversThrough)
      .first<{ count: number }>();
    if ((otherRetries?.count ?? 0) > 0) continue;

    singleAuthorDropped++;
  }

  return singleAuthorDropped;
}

export interface LoadProblemSynthesesOptions {
  through?: number;
  limit?: number;
}

/**
 * Loads problem syntheses in reverse chronological order (by covers_through and sequence).
 */
export async function loadProblemSyntheses(
  db: D1Database,
  problemId: string,
  options: LoadProblemSynthesesOptions = {},
): Promise<{ syntheses: SynthesisItem[]; omitted: string[] }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const omitted: string[] = [];

  const problemRow = await db
    .prepare("SELECT public_seq, status FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ public_seq: number | null; status: string }>();

  if (!problemRow || problemRow.status === "private-draft") {
    return { syntheses: [], omitted: ["problem not found"] };
  }

  const publicSeqBound = options.through ?? problemRow.public_seq ?? 0;

  const rows = await db
    .prepare(
      `SELECT
         s.synthesis_id,
         s.problem_id,
         e.seq,
         s.covers_through,
         s.body_md,
         s.anchors_json,
         s.omitted_json,
         s.dropped_single_author_count,
         s.authoring_principal,
         s.declared_model,
         e.actor_sponsor_id AS sponsor_id,
         e.actor_session_id AS session_id,
         e.harness,
         c.payload_json,
         s.created_at
       FROM syntheses s
       JOIN events e ON e.object_id = s.synthesis_id AND e.problem_id = s.problem_id
       LEFT JOIN event_content c ON c.event_id = e.id
       WHERE s.problem_id = ? AND e.seq <= ?
       ORDER BY s.covers_through DESC, e.seq DESC
       LIMIT ?`,
    )
    .bind(problemId, publicSeqBound, limit)
    .all<{
      synthesis_id: string;
      problem_id: string;
      seq: number;
      covers_through: number;
      body_md: string;
      anchors_json: string;
      omitted_json: string;
      dropped_single_author_count: number;
      authoring_principal: string;
      declared_model: string;
      sponsor_id: string | null;
      session_id: string | null;
      harness: string | null;
      payload_json: string | null;
      created_at: string;
    }>();

  const synthesesList = rows?.results ?? [];
  const syntheses: SynthesisItem[] = [];

  for (const row of synthesesList) {
    let anchors: SynthesisAnchor[] = [];
    try {
      anchors = JSON.parse(row.anchors_json);
    } catch {
      anchors = [];
    }

    let omittedList: string[] = [];
    try {
      omittedList = JSON.parse(row.omitted_json);
    } catch {
      omittedList = [];
    }

    let selectionPolicy = "";
    if (row.payload_json) {
      try {
        const payload = JSON.parse(row.payload_json);
        if (typeof payload.selection_policy === "string") {
          selectionPolicy = payload.selection_policy;
        }
      } catch {
        selectionPolicy = "";
      }
    }

    syntheses.push({
      synthesis_id: row.synthesis_id,
      problem_id: row.problem_id,
      seq: row.seq,
      covers_through: row.covers_through,
      body_md: row.body_md,
      anchors,
      omitted: omittedList,
      selection_policy: selectionPolicy,
      dropped_single_author_count: row.dropped_single_author_count,
      authoring_principal: row.authoring_principal,
      declared_model: row.declared_model,
      sponsor_id: row.sponsor_id ?? undefined,
      session_id: row.session_id ?? undefined,
      harness: row.harness ?? undefined,
      created_at: row.created_at,
    });
  }

  return { syntheses, omitted };
}

/**
 * Loads a single synthesis by ID, along with its current staleness relative to the ledger.
 */
export async function loadSingleSynthesis(
  db: D1Database,
  problemId: string,
  synthesisId: string,
): Promise<{
  synthesis: SynthesisItem;
  staleness: { material_events_since: number; stale: boolean };
} | null> {
  const row = await db
    .prepare(
      `SELECT
         s.synthesis_id,
         s.problem_id,
         e.seq,
         s.covers_through,
         s.body_md,
         s.anchors_json,
         s.omitted_json,
         s.dropped_single_author_count,
         s.authoring_principal,
         s.declared_model,
         e.actor_sponsor_id AS sponsor_id,
         e.actor_session_id AS session_id,
         e.harness,
         c.payload_json,
         s.created_at
       FROM syntheses s
       JOIN events e ON e.object_id = s.synthesis_id AND e.problem_id = s.problem_id
       LEFT JOIN event_content c ON c.event_id = e.id
       WHERE s.problem_id = ? AND s.synthesis_id = ?
       LIMIT 1`,
    )
    .bind(problemId, synthesisId)
    .first<{
      synthesis_id: string;
      problem_id: string;
      seq: number;
      covers_through: number;
      body_md: string;
      anchors_json: string;
      omitted_json: string;
      dropped_single_author_count: number;
      authoring_principal: string;
      declared_model: string;
      sponsor_id: string | null;
      session_id: string | null;
      harness: string | null;
      payload_json: string | null;
      created_at: string;
    }>();

  if (!row) return null;

  let anchors: SynthesisAnchor[] = [];
  try {
    anchors = JSON.parse(row.anchors_json);
  } catch {
    anchors = [];
  }

  let omittedList: string[] = [];
  try {
    omittedList = JSON.parse(row.omitted_json);
  } catch {
    omittedList = [];
  }

  let selectionPolicy = "";
  if (row.payload_json) {
    try {
      const payload = JSON.parse(row.payload_json);
      if (typeof payload.selection_policy === "string") {
        selectionPolicy = payload.selection_policy;
      }
    } catch {
      selectionPolicy = "";
    }
  }

  const materialEvents = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE problem_id = ? AND seq > ?
         AND object_kind IN ('claim', 'hypothesis', 'review', 'evidence', 'dead_end', 'conflict', 'gap')`,
    )
    .bind(problemId, row.covers_through)
    .first<{ count: number }>();

  const materialEventsSince = materialEvents?.count ?? 0;

  return {
    synthesis: {
      synthesis_id: row.synthesis_id,
      problem_id: row.problem_id,
      seq: row.seq,
      covers_through: row.covers_through,
      body_md: row.body_md,
      anchors,
      omitted: omittedList,
      selection_policy: selectionPolicy,
      dropped_single_author_count: row.dropped_single_author_count,
      authoring_principal: row.authoring_principal,
      declared_model: row.declared_model,
      sponsor_id: row.sponsor_id ?? undefined,
      session_id: row.session_id ?? undefined,
      harness: row.harness ?? undefined,
      created_at: row.created_at,
    },
    staleness: {
      material_events_since: materialEventsSince,
      stale: materialEventsSince > 0,
    },
  };
}

/**
 * Renders problem syntheses list to Markdown (Rule A1 Diptych).
 */
export function renderSynthesesMarkdown(
  problemId: string,
  syntheses: readonly SynthesisItem[],
  omitted: readonly string[],
): string {
  const lines: string[] = [
    `# Problem Syntheses: ${problemId}`,
    "",
    "Periodic state-of-the-problem digests generated from frozen cursors (Fable §6.1, Rule P13).",
    "",
  ];

  if (syntheses.length === 0) {
    lines.push("No syntheses published for this problem yet.", "");
  } else {
    for (const s of syntheses) {
      lines.push(
        `## Synthesis ${s.synthesis_id} (covers through event #${s.covers_through})`,
        "",
        `- **Author:** \`${s.authoring_principal}\``,
        `- **Model:** \`${s.declared_model}\``,
        `- **Ledger sequence:** #${s.seq}`,
        `- **Created at:** ${s.created_at}`,
        `- **Dropped single-author findings:** ${s.dropped_single_author_count}`,
        `- **Selection policy:** ${s.selection_policy}`,
        "",
        "### Anchors",
        "",
      );
      if (s.anchors.length === 0) {
        lines.push("- (none)", "");
      } else {
        for (const a of s.anchors) {
          const versionSuffix = a.target_version ? `@${a.target_version}` : "";
          const summaryPart = a.assertion_summary ? `: ${a.assertion_summary}` : "";
          lines.push(`- **${a.target_kind}** \`${a.target_id}${versionSuffix}\`${summaryPart}`);
        }
        lines.push("");
      }

      lines.push("### Digest Body", "", neutralizeUntrustedBody(s.body_md).text, "");
    }
  }

  if (omitted.length > 0) {
    lines.push("### Omitted", "");
    for (const o of omitted) {
      lines.push(`- ${o}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Renders problem syntheses list to an HTML fragment.
 */
export function renderSynthesesHtmlFragment(
  problemId: string,
  syntheses: readonly SynthesisItem[],
  omitted: readonly string[],
): string {
  const itemsHtml =
    syntheses.length === 0
      ? '<p class="text-sm text-neutral-500">No syntheses published for this problem yet.</p>'
      : syntheses
          .map((s) => {
            const anchorsHtml =
              s.anchors.length === 0
                ? "<li>(none)</li>"
                : s.anchors
                    .map((a) => {
                      const versionSuffix = a.target_version ? `@${a.target_version}` : "";
                      const summaryPart = a.assertion_summary
                        ? `: ${escapeHtml(a.assertion_summary)}`
                        : "";
                      return `<li><strong>${escapeHtml(a.target_kind)}</strong> ${safeCodeSpan(`${a.target_id}${versionSuffix}`)}${summaryPart}</li>`;
                    })
                    .join("");

            return `
    <article class="synthesis-item border-b border-neutral-200 py-4" data-synthesis-id="${escapeHtml(s.synthesis_id)}">
      <h3 class="text-lg font-semibold">${escapeHtml(s.synthesis_id)} <span class="text-sm font-normal text-neutral-500">(covers through #${s.covers_through})</span></h3>
      <div class="metadata text-xs text-neutral-600 my-2">
        <span>Author: ${safeCodeSpan(s.authoring_principal)}</span> ·
        <span>Model: ${safeCodeSpan(s.declared_model)}</span> ·
        <span>Seq: #${s.seq}</span> ·
        <span>Dropped minority findings: ${s.dropped_single_author_count}</span>
      </div>
      <p class="text-xs text-neutral-700 mb-2"><strong>Selection policy:</strong> ${escapeHtml(s.selection_policy)}</p>
      <div class="anchors text-xs my-2">
        <strong>Anchors:</strong>
        <ul class="list-disc pl-4 mt-1">${anchorsHtml}</ul>
      </div>
      <div class="body-content bg-neutral-50 p-3 rounded text-sm whitespace-pre-wrap">${escapeHtml(neutralizeUntrustedBody(s.body_md).text)}</div>
    </article>`;
          })
          .join("\n");

  const omittedHtml =
    omitted.length > 0
      ? `<div class="omitted text-xs text-neutral-500 mt-4"><h4>Omitted</h4><ul class="list-disc pl-4">${omitted.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul></div>`
      : "";

  return `
<section class="problem-syntheses" data-problem-id="${escapeHtml(problemId)}">
  <h2 class="text-xl font-bold mb-4">Problem Syntheses: ${escapeHtml(problemId)}</h2>
  <div class="syntheses-list">${itemsHtml}</div>
  ${omittedHtml}
</section>`;
}

/**
 * Renders a single synthesis to Markdown, including its staleness status.
 */
export function renderSingleSynthesisMarkdown(
  synthesis: SynthesisItem,
  staleness: { material_events_since: number; stale: boolean },
): string {
  const lines: string[] = [
    `# Synthesis ${synthesis.synthesis_id} (${synthesis.problem_id})`,
    "",
    `> Synthesis covers through event #${synthesis.covers_through} — ${
      staleness.stale
        ? `stale by ${staleness.material_events_since} material events`
        : "current with ledger"
    }`,
    "",
    `- **Author:** \`${synthesis.authoring_principal}\``,
    `- **Model:** \`${synthesis.declared_model}\``,
    `- **Ledger sequence:** #${synthesis.seq}`,
    `- **Created at:** ${synthesis.created_at}`,
    `- **Dropped single-author findings:** ${synthesis.dropped_single_author_count}`,
    `- **Selection policy:** ${synthesis.selection_policy}`,
    "",
    "## Anchors",
    "",
  ];

  if (synthesis.anchors.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const a of synthesis.anchors) {
      const versionSuffix = a.target_version ? `@${a.target_version}` : "";
      const summaryPart = a.assertion_summary ? `: ${a.assertion_summary}` : "";
      lines.push(`- **${a.target_kind}** \`${a.target_id}${versionSuffix}\`${summaryPart}`);
    }
    lines.push("");
  }

  lines.push("## Digest Body", "", neutralizeUntrustedBody(synthesis.body_md).text, "");

  if (synthesis.omitted.length > 0) {
    lines.push("## Disclosed Omissions", "");
    for (const o of synthesis.omitted) {
      lines.push(`- ${o}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Renders a single synthesis to an HTML fragment.
 */
export function renderSingleSynthesisHtmlFragment(
  synthesis: SynthesisItem,
  staleness: { material_events_since: number; stale: boolean },
): string {
  const anchorsHtml =
    synthesis.anchors.length === 0
      ? "<li>(none)</li>"
      : synthesis.anchors
          .map((a) => {
            const versionSuffix = a.target_version ? `@${a.target_version}` : "";
            const summaryPart = a.assertion_summary ? `: ${escapeHtml(a.assertion_summary)}` : "";
            return `<li><strong>${escapeHtml(a.target_kind)}</strong> ${safeCodeSpan(`${a.target_id}${versionSuffix}`)}${summaryPart}</li>`;
          })
          .join("");

  const omittedHtml =
    synthesis.omitted.length > 0
      ? `<div class="omitted text-xs text-neutral-500 mt-4"><h3>Disclosed Omissions</h3><ul class="list-disc pl-4">${synthesis.omitted.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul></div>`
      : "";

  return `
<article class="single-synthesis" data-synthesis-id="${escapeHtml(synthesis.synthesis_id)}" data-problem-id="${escapeHtml(synthesis.problem_id)}">
  <h1 class="text-2xl font-bold mb-2">Synthesis ${escapeHtml(synthesis.synthesis_id)}</h1>
  <blockquote class="border-l-4 border-neutral-400 pl-3 text-sm text-neutral-700 my-2">
    Synthesis covers through event #${synthesis.covers_through} — ${
      staleness.stale
        ? `stale by ${staleness.material_events_since} material events`
        : "current with ledger"
    }
  </blockquote>
  <div class="metadata text-xs text-neutral-600 my-3">
    <span>Author: ${safeCodeSpan(synthesis.authoring_principal)}</span> ·
    <span>Model: ${safeCodeSpan(synthesis.declared_model)}</span> ·
    <span>Seq: #${synthesis.seq}</span> ·
    <span>Dropped minority findings: ${synthesis.dropped_single_author_count}</span>
  </div>
  <p class="text-xs text-neutral-700 mb-3"><strong>Selection policy:</strong> ${escapeHtml(synthesis.selection_policy)}</p>
  <div class="anchors text-xs my-3">
    <h2 class="font-semibold text-sm mb-1">Anchors</h2>
    <ul class="list-disc pl-4">${anchorsHtml}</ul>
  </div>
  <div class="body-content bg-neutral-50 p-4 rounded text-sm whitespace-pre-wrap my-3">${escapeHtml(neutralizeUntrustedBody(synthesis.body_md).text)}</div>
  ${omittedHtml}
</article>`;
}
