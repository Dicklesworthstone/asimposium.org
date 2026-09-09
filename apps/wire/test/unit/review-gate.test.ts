import { describe, expect, test } from "bun:test";

import { gateReviewSubmission, type ReviewSubmission } from "../../src/ledger/review-gate.ts";
import type { ReviewAttribution } from "../../src/ledger/review-independence.ts";

const AUTHOR: ReviewAttribution = {
  sponsorId: "SP-1",
  modelFamily: "claude",
  methodBasis: "search",
};
const REVIEWER: ReviewAttribution = {
  sponsorId: "SP-2",
  modelFamily: "gpt",
  methodBasis: "proof-search",
};

function submission(overrides: Partial<ReviewSubmission> = {}): ReviewSubmission {
  return {
    targetClaimId: "C-1",
    targetVersion: 1,
    verdict: "confirm",
    basis: "read the proof",
    capableOfFailure: "a counterexample on the 4-path",
    bodyMd: "I verified the statement match and the quantifier scope.",
    ...overrides,
  };
}

describe("W5.7 the review gate", () => {
  test("P1: the author can never review their own object", () => {
    const result = gateReviewSubmission({
      submission: submission(),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-1",
      claimAuthorAttribution: AUTHOR,
      reviewerAttribution: AUTHOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REVIEWER_IS_AUTHOR");
  });

  test("a valid independent review passes with the computed tier and weight", () => {
    const result = gateReviewSubmission({
      submission: submission(),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimAuthorAttribution: AUTHOR,
      reviewerAttribution: REVIEWER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe("T3");
      expect(result.carriesWeight).toBe(true);
    }
  });

  test("P5: a missing capable-of-failure field is accepted but carries no weight", () => {
    const result = gateReviewSubmission({
      submission: submission({ capableOfFailure: undefined }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimAuthorAttribution: AUTHOR,
      reviewerAttribution: REVIEWER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.carriesWeight).toBe(false);
  });

  test("an unrecognized verdict is refused", () => {
    const result = gateReviewSubmission({
      submission: submission({ verdict: "looks-good" }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimAuthorAttribution: AUTHOR,
      reviewerAttribution: REVIEWER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REVIEW_VERDICT_UNKNOWN");
  });

  test("an empty body is refused", () => {
    const result = gateReviewSubmission({
      submission: submission({ bodyMd: "  " }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimAuthorAttribution: AUTHOR,
      reviewerAttribution: REVIEWER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REVIEW_BODY_EMPTY");
  });
});
