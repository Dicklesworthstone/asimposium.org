import { test } from "bun:test";
import assert from "node:assert/strict";
import { rankReviewQueue, reviewNeed } from "../../src/discovery/review-queue-selection";
import type { ScientificDisposition } from "../../src/ledger/scientific-disposition";

function state(overrides: Partial<ScientificDisposition> = {}): ScientificDisposition {
  return {
    disposition: "open",
    currentVersion: 1,
    stale: false,
    legacyReviews: 0,
    context: {
      recorded_refutation_attempts: 0,
      verified_reviews: [],
      has_certified_artifact: false,
    },
    ...overrides,
  };
}
function review(tier: "T0" | "T1" | "T2" | "T3", reviewer = "F-OTHER") {
  return {
    review_id: "R-1",
    reviewer_id: reviewer,
    tier,
    cross_family: tier === "T2" || tier === "T3",
    full_write_up: false,
    finding: "support" as const,
  };
}
for (const disposition of [
  "draft",
  "malformed",
  "refuted",
  "withdrawn",
  "superseded",
  "strongly-supported",
] as const) {
  test(`queue excludes ${disposition} without changing its canonical standing`, () => {
    const fold = state({ disposition });
    assert.equal(reviewNeed(fold, "F-AUTHOR"), undefined);
    assert.equal(fold.disposition, disposition);
  });
}
test("stale and unavailable-version claims do not masquerade as review ready", () => {
  assert.equal(reviewNeed(state({ stale: true }), "F-AUTHOR"), undefined);
  assert.equal(reviewNeed(state({ currentVersion: null }), "F-AUTHOR"), undefined);
});
test("missing independent review is explicit and no author review can satisfy it", () => {
  const fold = state();
  assert.deepEqual(reviewNeed(fold, "F-AUTHOR"), {
    need: "independent-review",
    bestRecordedTier: "none",
  });
  const authored = state({
    context: { ...fold.context, verified_reviews: [review("T3", "F-AUTHOR")] },
  });
  assert.deepEqual(reviewNeed(authored, "F-AUTHOR"), {
    need: "independent-review",
    bestRecordedTier: "none",
  });
});
test("same-sponsor verification cannot stand in for a second sponsor", () => {
  const base = state();
  const fold = state({ context: { ...base.context, verified_reviews: [review("T0")] } });
  assert.deepEqual(reviewNeed(fold, "F-AUTHOR"), {
    need: "independent-review",
    bestRecordedTier: "T0",
  });
});
test("T1 needs cross-family review; a recorded family tier is not inferred from harness", () => {
  const base = state();
  const fold = state({ context: { ...base.context, verified_reviews: [review("T1")] } });
  assert.deepEqual(reviewNeed(fold, "F-AUTHOR"), {
    need: "cross-family-review",
    bestRecordedTier: "T1",
  });
});
test("cross-family confirmations without a falsification attempt name the missing challenge", () => {
  const fold = state({ context: { ...state().context, verified_reviews: [review("T2")] } });
  assert.deepEqual(reviewNeed(fold, "F-AUTHOR"), {
    need: "falsification-attempt",
    bestRecordedTier: "T2",
  });
});
test("challenge plus tier still directs a full write-up review, never self-certifies", () => {
  const fold = state({
    disposition: "corroborated",
    context: {
      ...state().context,
      verified_reviews: [review("T2")],
      recorded_refutation_attempts: 1,
    },
  });
  assert.equal(reviewNeed(fold, "F-AUTHOR")?.need, "full-write-up-review");
  assert.equal(fold.disposition, "corroborated");
});
test("an unresolved dispute takes precedence over piled-up supporting reviews", () => {
  const fold = state({
    disposition: "disputed",
    context: {
      ...state().context,
      verified_reviews: Array.from({ length: 40 }, () => review("T3")),
      recorded_refutation_attempts: 1,
    },
  });
  assert.equal(reviewNeed(fold, "F-AUTHOR")?.need, "resolve-dispute");
});
test("duplicate reviews cannot change the missing check", () => {
  const context = { ...state().context, verified_reviews: [review("T1")] };
  const once = reviewNeed(state({ context }), "F-AUTHOR");
  assert.deepEqual(
    reviewNeed(
      state({
        context: { ...context, verified_reviews: Array.from({ length: 100 }, () => review("T1")) },
      }),
      "F-AUTHOR",
    ),
    once,
  );
});
function candidate(id: string, overrides = {}) {
  return {
    problem_id: "P-MATH",
    claim_id: id,
    author_sponsor_id: "SP-A",
    created_at: "2026-09-01T00:00:00.000Z",
    direct_dependents: 0,
    need: "independent-review" as const,
    ...overrides,
  };
}
test("quiet work with dependencies outranks a busy unrelated claim", () => {
  const quiet = candidate("C-1", { direct_dependents: 2, event_count: 1, tokens: 1 });
  const busy = candidate("C-2", { event_count: 100000, tokens: 1000000 });
  assert.deepEqual(
    rankReviewQueue([busy, quiet]).map((x) => x.claim_id),
    ["C-1", "C-2"],
  );
});
test("missing-check priority precedes age but not consequence", () => {
  const records = [
    candidate("C-1", { need: "cross-family-review" as const }),
    candidate("C-2", { need: "resolve-dispute" as const, created_at: "2026-09-02T00:00:00.000Z" }),
    candidate("C-3", { direct_dependents: 1 }),
  ];
  assert.deepEqual(
    rankReviewQueue(records).map((x) => x.claim_id),
    ["C-3", "C-2", "C-1"],
  );
});
test("age precedes sponsor-diversity tie breaking", () => {
  const records = [
    candidate("C-1"),
    candidate("C-2"),
    candidate("C-3", { author_sponsor_id: "SP-B", created_at: "2026-09-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    rankReviewQueue(records).map((x) => x.claim_id),
    ["C-1", "C-2", "C-3"],
  );
});
test("equal priorities interleave sponsor families without a sponsor score", () => {
  assert.deepEqual(
    rankReviewQueue([
      candidate("C-2"),
      candidate("C-3", { author_sponsor_id: "SP-B" }),
      candidate("C-1"),
    ]).map((x) => x.claim_id),
    ["C-1", "C-3", "C-2"],
  );
});
test("all input permutations give the same order and leave inputs untouched", () => {
  const rows = [
    candidate("C-1"),
    candidate("C-2", { author_sponsor_id: "SP-B" }),
    candidate("C-3", { direct_dependents: 3 }),
    candidate("C-4"),
  ];
  const expected = rankReviewQueue(rows);
  function permutations<T>(values: T[]): T[][] {
    return values.length === 0
      ? [[]]
      : values.flatMap((value, i) =>
          permutations(values.filter((_, j) => i !== j)).map((tail) => [value, ...tail]),
        );
  }
  for (const input of permutations(rows)) {
    const before = JSON.stringify(input);
    assert.deepEqual(rankReviewQueue(input), expected);
    assert.equal(JSON.stringify(input), before);
  }
});
