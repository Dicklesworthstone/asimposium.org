/**
 * W5.7 the review route's core: validate a review submission before it commits.
 * P1 (the author can never review their own object), the capable-of-failure
 * field is mandatory for the review to carry weight (a check that cannot fail
 * is not evidence, P5), and the verdict must be a recognized value. Pure — the
 * same submission, the same verdict.
 */

import { reviewerIsAuthor } from "./review-independence.ts";

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
  readonly rubric?: readonly string[];
  readonly bodyMd: string;
  /** Present when the reviewer sent a novelty block (Fable §6.6(c)). */
  readonly hasNovelty?: boolean;
}

export type ReviewRefusalCode =
  | "REVIEWER_IS_AUTHOR"
  | "REVIEW_VERDICT_UNKNOWN"
  | "REVIEW_MISSING_CAPABLE_OF_FAILURE"
  | "REVIEW_BODY_EMPTY"
  | "NOVELTY_REVIEW_REQUIRED"
  | "NOVELTY_REVIEW_NOT_APPLICABLE"
  | "NOVELTY_REVIEW_VERDICT_NOT_INFORM";

export type ReviewGateResult =
  | { readonly ok: true; readonly carriesWeight: boolean }
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
 * assertion-only (no weight, Fable §6.4). Independence is evaluated separately
 * after resolving the exact claim and scientific evidence.
 */
export function gateReviewSubmission(input: {
  readonly submission: ReviewSubmission;
  readonly claimAuthorFellowId: string;
  readonly reviewerFellowId: string;
  /** The reviewed claim version's kind; novelty-claims take their own contract. */
  readonly claimKind?: string;
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

  // Novelty is a separate claim with a separate review (Fable §6.6(c), ADR-21):
  // a novelty-claim is judged only by its novelty block, and a proof or
  // correctness verdict can never stand in for a literature search.
  const isNoveltyClaim = input.claimKind === "novelty-claim";
  if (isNoveltyClaim && submission.hasNovelty !== true) {
    return {
      ok: false,
      code: "NOVELTY_REVIEW_REQUIRED",
      rule: "A5",
      fixHint:
        "This claim is a novelty-claim. Add a novelty block: verdict (new, reformulation, special-case, rediscovery, unresolved), searches (source, searched_on, terms), nearest_prior_art and semantic_difference.",
    };
  }
  if (!isNoveltyClaim && submission.hasNovelty === true) {
    return {
      ok: false,
      code: "NOVELTY_REVIEW_NOT_APPLICABLE",
      rule: "A5",
      fixHint:
        "Only a novelty-claim takes a novelty block. Remove it and review the statement's correctness; assert novelty separately as a novelty-claim.",
    };
  }
  if (isNoveltyClaim && submission.verdict !== "inform") {
    return {
      ok: false,
      code: "NOVELTY_REVIEW_VERDICT_NOT_INFORM",
      rule: "P2/P4",
      fixHint:
        "A novelty-claim is judged only by its novelty block. Set verdict to inform; a correctness or proof verdict cannot establish novelty.",
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
  return { ok: true, carriesWeight };
}
