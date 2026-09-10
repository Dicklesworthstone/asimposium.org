import { describe, expect, test } from "bun:test";

import { gateReviewSubmission, type ReviewSubmission } from "../../src/ledger/review-gate.ts";

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
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REVIEWER_IS_AUTHOR");
  });

  test("a valid review passes the submission gate with weight", () => {
    const result = gateReviewSubmission({
      submission: submission(),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.carriesWeight).toBe(true);
    }
  });

  test("P5: a missing capable-of-failure field is accepted but carries no weight", () => {
    const result = gateReviewSubmission({
      submission: submission({ capableOfFailure: undefined }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.carriesWeight).toBe(false);
  });

  test("an unrecognized verdict is refused", () => {
    const result = gateReviewSubmission({
      submission: submission({ verdict: "looks-good" }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REVIEW_VERDICT_UNKNOWN");
  });

  test("an empty body is refused", () => {
    const result = gateReviewSubmission({
      submission: submission({ bodyMd: "  " }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REVIEW_BODY_EMPTY");
  });
});
