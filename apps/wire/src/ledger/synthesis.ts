/**
 * W5.8b Synthesis lifecycle and P13 ledger anchoring (Fable §6.1, §6.3, Rule P13).
 *
 * A synthesis is a periodic state-of-the-problem digest generated from a frozen cursor.
 * Rule P13: Synthesis follows the ledger. A synthesis assertion about scientific state
 * must reference the ledger objects it summarizes; unreferenced assertions or assertions
 * referencing objects beyond covers_through fail with SYNTHESIS_UNANCHORED.
 *
 * Automated syntheses are drafts until a steward or authoring Fellow's sponsor publishes;
 * prior versions remain accessible.
 */

import type { D1Database } from "@cloudflare/workers-types";

export interface SynthesisAnchorInput {
  readonly target_kind:
    | "claim"
    | "evidence"
    | "hypothesis"
    | "gap"
    | "conflict"
    | "citation"
    | "statement";
  readonly target_id: string;
  readonly target_version?: number;
  readonly target_seq?: number;
  readonly assertion_summary?: string;
}

export interface SynthesisOmittedInput {
  readonly selection_policy: string;
  readonly dropped_findings?: readonly string[];
  readonly dropped_single_author_count?: number;
  readonly reasoning?: string;
}

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
  anchors: readonly SynthesisAnchorInput[],
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

  const unanchoredIds: string[] = [];

  for (const anchor of anchors) {
    let sourceSeq: number | null = null;

    if (anchor.target_kind === "statement") {
      const version = anchor.target_version ?? (Number(anchor.target_id) || 1);
      const row = await db
        .prepare(
          `SELECT seq FROM events
           WHERE problem_id = ? AND object_kind = 'problem'
             AND (object_version = ? OR type IN ('problem.created', 'problem.statement.updated'))
           ORDER BY seq DESC LIMIT 1`,
        )
        .bind(problemId, version)
        .first<{ seq: number }>();
      sourceSeq = row?.seq ?? null;
    } else {
      const row = await db
        .prepare(
          `SELECT seq FROM events
           WHERE problem_id = ? AND object_kind = ? AND object_id = ?
             AND (object_version = ? OR ? IS NULL)
           ORDER BY seq DESC LIMIT 1`,
        )
        .bind(
          problemId,
          anchor.target_kind,
          anchor.target_id,
          anchor.target_version ?? null,
          anchor.target_version ?? null,
        )
        .first<{ seq: number }>();
      sourceSeq = row?.seq ?? null;
    }

    if (sourceSeq === null || sourceSeq > coversThrough) {
      unanchoredIds.push(anchor.target_id);
    }
  }

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
        `SELECT COUNT(*) AS count FROM claim_relations
         WHERE problem_id = ?
           AND (source_claim_id = ? OR target_ref LIKE ? || '@%')
           AND asserted_by_fellow != ?`,
      )
      .bind(problemId, c.claim_id, c.claim_id, c.author_fellow_id)
      .first<{ count: number }>();

    if ((otherRelations?.count ?? 0) > 0) continue;

    singleAuthorDropped++;
  }

  return singleAuthorDropped;
}
