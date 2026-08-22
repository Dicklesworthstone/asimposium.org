/**
 * The claim-disposition read (W5.4's read side): a claim's current disposition
 * is COMPUTED by folding its ledger events through the state machine — never a
 * stored field (Rule A4/P4: dispositions move only via the machine). This is
 * the fold: read the events in order, apply each through the evaluator, and the
 * result is the claim's honest standing.
 */

import {
  type ClaimDisposition,
  type ClaimEvent,
  type ClaimTransitionContext,
  EMPTY_CLAIM_CONTEXT,
  evaluateClaimTransition,
} from "./dispositions.ts";

/**
 * Fold a claim's events (in ledger order) into its current disposition. A claim
 * starts at draft; promote moves it to open; each subsequent event routes it.
 * Events that the evaluator refuses (an illegal transition) are skipped — the
 * log is the truth, and a refused transition is simply not a move.
 */
export function computeClaimDisposition(
  events: readonly ClaimEvent[],
  contextFor: (event: ClaimEvent) => ClaimTransitionContext = () => EMPTY_CLAIM_CONTEXT,
): ClaimDisposition {
  let current: ClaimDisposition = "draft";
  for (const event of events) {
    const result = evaluateClaimTransition(current, event, contextFor(event));
    if (result.allowed) current = result.next;
  }
  return current;
}
