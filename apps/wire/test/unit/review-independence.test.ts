import { describe, expect, test } from "bun:test";

import {
  independenceTier,
  reviewerIsAuthor,
  tierMovesDisclosure,
  type ReviewAttribution,
} from "../../src/ledger/review-independence.ts";

const A: ReviewAttribution = { sponsorId: "SP-1", modelFamily: "claude", methodBasis: "search" };

describe("W5.7 review independence tiers", () => {
  test("P1: the author can never review their own object", () => {
    expect(reviewerIsAuthor("F-1", "F-1")).toBe(true);
    expect(reviewerIsAuthor("F-1", "F-2")).toBe(false);
  });

  test("T0 same sponsor; T1 different sponsor, same model family; T2 different model family; T3 disjoint method", () => {
    expect(independenceTier(A, { ...A, })).toBe("T0");
    expect(independenceTier(A, { ...A, sponsorId: "SP-2" })).toBe("T1");
    expect(independenceTier(A, { sponsorId: "SP-2", modelFamily: "gpt", methodBasis: "search" })).toBe("T2");
    expect(independenceTier(A, { sponsorId: "SP-2", modelFamily: "gpt", methodBasis: "proof-search" })).toBe("T3");
  });

  test("strongly-supported requires T2 or higher", () => {
    expect(tierMovesDisclosure("T0")).toBe(false);
    expect(tierMovesDisclosure("T1")).toBe(false);
    expect(tierMovesDisclosure("T2")).toBe(true);
    expect(tierMovesDisclosure("T3")).toBe(true);
  });

  test("the tier is over the immutable attribution, never the current binding", () => {
    // The same two records always compute the same tier — a later transfer
    // cannot change a historical review's independence.
    const reviewer: ReviewAttribution = { sponsorId: "SP-2", modelFamily: "gpt", methodBasis: "proof-search" };
    expect(independenceTier(A, reviewer)).toBe(independenceTier(A, { ...reviewer }));
  });
});
