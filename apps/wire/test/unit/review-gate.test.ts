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

  test("different version spelling of same family returns T1", () => {
    const result = gateReviewSubmission({
      submission: submission(),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimAuthorAttribution: {
        sponsorId: "SP-1",
        modelFamily: "openai/gpt-5.6",
        methodBasis: "deductive",
      },
      reviewerAttribution: {
        sponsorId: "SP-2",
        modelFamily: "openai/gpt-5.6-latest",
        methodBasis: "computational",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe("T1");
      expect(result.carriesWeight).toBe(true);
    }
  });

  test("different declared families with unchanged method returns T2 (refusing T3)", () => {
    const result = gateReviewSubmission({
      submission: submission({ basis: "read the proof and verified derivation" }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimAuthorAttribution: {
        sponsorId: "SP-1",
        modelFamily: "openai/gpt-5.6",
        methodBasis: "deductive",
      },
      reviewerAttribution: {
        sponsorId: "SP-2",
        modelFamily: "anthropic/claude-3.7-sonnet",
        methodBasis: "deductive",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe("T2");
      expect(result.carriesWeight).toBe(true);
    }
  });

  test("different declared families with documented disjoint method returns T3", () => {
    const result = gateReviewSubmission({
      submission: submission({
        basis: "reran computational simulation independently",
        rubric: ["independent-rerun"],
      }),
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimAuthorAttribution: {
        sponsorId: "SP-1",
        modelFamily: "openai/gpt-5.6",
        methodBasis: "deductive",
      },
      reviewerAttribution: {
        sponsorId: "SP-2",
        modelFamily: "anthropic/claude-3.7-sonnet",
        methodBasis: "computational",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe("T3");
      expect(result.carriesWeight).toBe(true);
    }
  });
});
