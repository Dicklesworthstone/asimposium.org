import type { MoveKind, NextMoveCandidate } from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import { rankReviewQueue } from "../discovery/review-queue-selection.ts";

/** One policy for both per-problem next and cross-problem triage. Review
 * consequence ranks within a move tier; it cannot override a higher-priority
 * integrity check, idle close or ceremony breaker. */
export const MOVE_PRIORITY_TIER: Readonly<Record<MoveKind, number>> = {
  "back-to-the-object": 1,
  "idle-close": 2,
  "sharpen-statement": 3,
  "add-refuter-from-friction": 4,
  "kill-or-stand": 5,
  "add-refuter": 6,
  review: 7,
  "close-gap": 8,
  "retry-dead-end": 9,
  "normalize-conflict": 10,
  "collapse-duplicate": 11,
  "re-anchor": 12,
  "third-alternative": 13,
  discriminate: 14,
  formalize: 15,
  "state-claim": 16,
  "record-dead-end": 17,
  synthesize: 18,
};

export function compareMovePriority(a: NextMoveCandidate, b: NextMoveCandidate): number {
  return (MOVE_PRIORITY_TIER[a.move] ?? 99) - (MOVE_PRIORITY_TIER[b.move] ?? 99);
}

/** Keep distinct scientific needs for the same object. A target is not a
 * move identity: review, re-anchor and formalize can legitimately share it.
 * JSON tuple keys also preserve all pins without delimiter collisions. */
export function uniqueMoves(moves: readonly NextMoveCandidate[]): NextMoveCandidate[] {
  const seen = new Set<string>();
  return moves.filter((move) => {
    const key = JSON.stringify([move.move, move.refs]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Inputs have already passed each problem's central permission filter.
 * Never manufacture candidates from queue metadata: match the move kind,
 * problem AND exact target version, then reuse the actual move/contract.
 * Other equal-tier candidates retain their source ordering (the provider
 * examines problems in ASCII order and keeps each selector's stable order).
 */
export function selectTriageMove(
  candidates: readonly NextMoveCandidate[],
  items: readonly ReviewQueueItem[],
): NextMoveCandidate | null {
  const moves = uniqueMoves(candidates).sort(compareMovePriority);
  const first = moves[0];
  if (!first) return null;
  const tier = moves.filter((move) => compareMovePriority(first, move) === 0);
  if (first.move !== "review" && first.move !== "add-refuter") return first;

  const byTarget = new Map<string, NextMoveCandidate>();
  for (const move of tier) {
    if (move.move !== first.move || move.refs.length !== 2) continue;
    const key = JSON.stringify(move.refs);
    if (!byTarget.has(key)) byTarget.set(key, move);
  }
  const eligible = items.filter((item) =>
    (item.need === "falsification-attempt" ? "add-refuter" : "review") === first.move &&
    byTarget.has(JSON.stringify([item.problem_id, `${item.claim_id}@${item.version}`])),
  );
  const ranked = rankReviewQueue(eligible);
  const best = ranked[0];
  return best
    ? byTarget.get(JSON.stringify([best.problem_id, `${best.claim_id}@${best.version}`])) ?? first
    : first;
}
