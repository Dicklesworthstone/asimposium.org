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

import type { SynthesisAnchor } from "@asimposium/contracts";
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
 * A single-author finding is a claim or hypothesis authored by exactly one Fellow and cited by no other.
 */
export async function computeDroppedSingleAuthorCount(
  db: D1Database,
  problemId: string,
  coversThrough: number,
  anchoredTargetIds: ReadonlySet<string> | readonly string[],
): Promise<number> {
  const targetSet =
    anchoredTargetIds instanceof Set ? anchoredTargetIds : new Set(anchoredTargetIds);
  const claims = await db
    .prepare(
      `SELECT DISTINCT object_id AS claim_id, actor_fellow_id AS author_fellow_id FROM events
       WHERE problem_id = ? AND object_kind = 'claim' AND seq <= ?`,
    )
    .bind(problemId, coversThrough)
    .all<{ claim_id: string; author_fellow_id: string }>();

  const claimsList = claims?.results ?? [];
  let singleAuthorDropped = 0;

  for (const c of claimsList) {
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

  return singleAuthorDropped;
}
