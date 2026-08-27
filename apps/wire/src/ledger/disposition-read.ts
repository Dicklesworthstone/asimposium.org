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
  type VerifiedReview,
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

export type VersionedClaimTimelineEvent =
  | {
      readonly kind: "claim-created";
      readonly sequence: number;
      readonly version: number;
    }
  | {
      readonly kind: "claim-revised";
      readonly sequence: number;
      readonly version: number;
    }
  | {
      readonly kind: "review-created";
      readonly sequence: number;
      readonly targetVersion: number;
      readonly carriesWeight: boolean;
      readonly verdict: string;
      readonly review: Omit<VerifiedReview, "finding">;
    }
  | {
      readonly kind: "refuting-evidence";
      readonly sequence: number;
      readonly targetVersion: number;
      readonly evidenceId: string;
    };

export interface CurrentClaimDispositionFold {
  readonly disposition: ClaimDisposition;
  readonly currentVersion: number | null;
  readonly context: ClaimTransitionContext;
}

function reviewFinding(verdict: string): VerifiedReview["finding"] | null {
  if (verdict === "confirm" || verdict === "reproduces") return "support";
  if (verdict === "refute" || verdict === "fails-to-reproduce") return "dispute";
  // inform, bounds, and cannot-verify are useful review records, but none says
  // either that the exact statement is supported or that it is malformed.
  return null;
}

/**
 * Fold the actual version-pinned ledger timeline for one claim head.
 *
 * The generic state-machine fold above intentionally knows nothing about
 * storage sequence or claim versions. Pack consumers do: a review of @1 must
 * never move @2, a review committed after a revision must stay in its real
 * chronological position, and an assertion-only review moves nothing. This
 * adapter enforces those facts before handing typed events to the machine.
 */
export function computeCurrentClaimDisposition(
  timeline: readonly VersionedClaimTimelineEvent[],
): CurrentClaimDispositionFold {
  const ordered = [...timeline].sort((left, right) => left.sequence - right.sequence);
  let priorSequence = 0;
  let currentVersion: number | null = null;
  let disposition: ClaimDisposition = "draft";
  let recordedRefutationAttempts = 0;
  let verifiedReviews: VerifiedReview[] = [];

  const context = (): ClaimTransitionContext => ({
    recorded_refutation_attempts: recordedRefutationAttempts,
    verified_reviews: verifiedReviews,
    has_certified_artifact: false,
  });
  const apply = (event: ClaimEvent): void => {
    const result = evaluateClaimTransition(disposition, event, context());
    if (result.allowed) disposition = result.next;
  };

  for (const event of ordered) {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= priorSequence ||
      ("version" in event && (!Number.isSafeInteger(event.version) || event.version < 1)) ||
      ("targetVersion" in event &&
        (!Number.isSafeInteger(event.targetVersion) || event.targetVersion < 1))
    ) {
      throw new TypeError("claim disposition timeline is not a strict safe-integer sequence");
    }
    priorSequence = event.sequence;

    if (event.kind === "claim-created") {
      if (currentVersion !== null || event.version !== 1) {
        throw new TypeError("claim disposition timeline has an invalid creation version");
      }
      currentVersion = 1;
      recordedRefutationAttempts = 0;
      verifiedReviews = [];
      apply({ kind: "promote" });
      continue;
    }
    if (event.kind === "claim-revised") {
      if (currentVersion === null || event.version !== currentVersion + 1) {
        throw new TypeError("claim disposition timeline has a non-contiguous revision");
      }
      apply({ kind: "new-version", new_version: event.version });
      currentVersion = event.version;
      recordedRefutationAttempts = 0;
      verifiedReviews = [];
      continue;
    }
    if (currentVersion === null || event.targetVersion !== currentVersion) {
      // Old/future pins remain visible on their own timelines but never move
      // the current head merely because the identity later revised.
      continue;
    }
    if (event.kind === "refuting-evidence") {
      apply({
        kind: "evidence-refuted",
        evidence_id: event.evidenceId,
        confirmed_by_independent_review: false,
        unanswered_hours: 0,
      });
      recordedRefutationAttempts += 1;
      continue;
    }
    if (!event.carriesWeight) continue;
    const finding = reviewFinding(event.verdict);
    if (finding === null) continue;
    const review: VerifiedReview = { ...event.review, finding };
    apply({ kind: "review-verified", review });
    if (finding === "support") verifiedReviews = [...verifiedReviews, review];
    if (finding === "dispute") recordedRefutationAttempts += 1;
  }

  return { disposition, currentVersion, context: context() };
}
