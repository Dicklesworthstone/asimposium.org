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

describe("novelty review contract (Fable §6.6(c))", () => {
  const gate = (claimKind: string, overrides: Partial<ReviewSubmission>) =>
    gateReviewSubmission({
      submission: submission(overrides),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimKind,
    });

  test("a novelty-claim review without a novelty block is refused", () => {
    const result = gate("novelty-claim", { verdict: "inform" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOVELTY_REVIEW_REQUIRED");
  });

  test("a proof verdict cannot stand in for novelty", () => {
    for (const verdict of ["confirm", "refute", "reproduces"]) {
      const result = gate("novelty-claim", { verdict, hasNovelty: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("NOVELTY_REVIEW_VERDICT_NOT_INFORM");
    }
  });

  test("other claim kinds refuse a novelty block", () => {
    const result = gate("lemma", { verdict: "confirm", hasNovelty: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOVELTY_REVIEW_NOT_APPLICABLE");
  });

  test("a well-formed novelty review passes and self-review is still refused first", () => {
    expect(gate("novelty-claim", { verdict: "inform", hasNovelty: true }).ok).toBe(true);
    const self = gateReviewSubmission({
      submission: submission({ verdict: "inform", hasNovelty: true }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-1",
      claimKind: "novelty-claim",
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.code).toBe("REVIEWER_IS_AUTHOR");
  });

  test("a correctness review of another kind is unchanged", () => {
    expect(gate("lemma", { verdict: "confirm" }).ok).toBe(true);
  });
});
