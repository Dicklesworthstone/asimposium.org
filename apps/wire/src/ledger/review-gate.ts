/**
 * W5.7 the review route's core: validate a review submission before it commits.
 * P1 (the author can never review their own object), the capable-of-failure
 * field is mandatory for the review to carry weight (a check that cannot fail
 * is not evidence, P5), and the verdict must be a recognized value. Pure — the
 * same submission, the same verdict.
 */

import type { ReviewAttribution } from "./review-independence.ts";
import {
  type IndependenceTier,
  independenceTier,
  reviewerIsAuthor,
} from "./review-independence.ts";

export type ReviewVerdict =
  | "confirm"
  | "refute"
  | "inform"
  | "bounds"
  | "reproduces"
  | "fails-to-reproduce"
  | "cannot-verify";

const VERDICTS: ReadonlySet<string> = new Set([
  "confirm",
  "refute",
  "inform",
  "bounds",
  "reproduces",
  "fails-to-reproduce",
  "cannot-verify",
]);

export interface ReviewSubmission {
  readonly targetClaimId: string;
  readonly targetVersion: number;
  readonly verdict: string;
  readonly basis: string;
  readonly capableOfFailure: string | undefined;
  readonly bodyMd: string;
}

export type ReviewRefusalCode =
  | "REVIEWER_IS_AUTHOR"
  | "REVIEW_VERDICT_UNKNOWN"
  | "REVIEW_MISSING_CAPABLE_OF_FAILURE"
  | "REVIEW_BODY_EMPTY";

export type ReviewGateResult =
  | { readonly ok: true; readonly tier: IndependenceTier; readonly carriesWeight: boolean }
  | {
      readonly ok: false;
      readonly code: ReviewRefusalCode;
      readonly rule: string;
      readonly fixHint: string;
    };

/**
 * Gate a review submission. The author can never review their own object (P1).
 * The verdict must be recognized. The capable-of-failure field is mandatory for
 * the review to carry weight; absent, the review is accepted but tagged
 * assertion-only (no weight, Fable §6.4). Returns the computed independence
 * tier on success.
 */
export function gateReviewSubmission(input: {
  readonly submission: ReviewSubmission;
  readonly claimAuthorFellowId: string;
  readonly reviewerFellowId: string;
  readonly claimAuthorAttribution: ReviewAttribution;
  readonly reviewerAttribution: ReviewAttribution;
}): ReviewGateResult {
  const { submission } = input;

  // P1: no self-certification. The author can never review their own object.
  if (reviewerIsAuthor(input.claimAuthorFellowId, input.reviewerFellowId)) {
    return {
      ok: false,
      code: "REVIEWER_IS_AUTHOR",
      rule: "P1",
      fixHint:
        "Reviews are independent by construction. A different Fellow must review this claim.",
    };
  }

  if (!VERDICTS.has(submission.verdict)) {
    return {
      ok: false,
      code: "REVIEW_VERDICT_UNKNOWN",
      rule: "P1",
      fixHint: `verdict must be one of: ${[...VERDICTS].join(", ")}.`,
    };
  }

  if (submission.bodyMd.trim().length === 0) {
    return {
      ok: false,
      code: "REVIEW_BODY_EMPTY",
      rule: "P1",
      fixHint: "the review body states what was actually checked.",
    };
  }

  // P5: the capable-of-failure field is mandatory for the review to carry
  // weight. Absent, the review is accepted but tagged assertion-only.
  const carriesWeight =
    submission.capableOfFailure !== undefined && submission.capableOfFailure.trim().length > 0;
  const tier = independenceTier(input.claimAuthorAttribution, input.reviewerAttribution);

  return { ok: true, tier, carriesWeight };
}
