import { describe, expect, test } from "bun:test";

import {
  CLAIM_DISPOSITIONS,
  type ClaimDisposition,
  type ClaimEvent,
  type ClaimTransitionContext,
  computeIndependenceTier,
  computeReviewStateFacet,
  computeStalenessFacet,
  displayClaimDisposition,
  displayHypothesisDisposition,
  EMPTY_CLAIM_CONTEXT,
  evaluateClaimTransition,
  evaluateHypothesisTransition,
  HYPOTHESIS_DISPOSITIONS,
  type HypothesisDisposition,
  type HypothesisEvent,
  pinIndependenceAtReviewTime,
  recomputePinnedIndependence,
  type VerifiedReview,
  wearsMachineCheckedBadge,
} from "../../src/ledger/dispositions.ts";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let reviewSeq = 0;
function review(overrides: Partial<VerifiedReview> = {}): VerifiedReview {
  reviewSeq += 1;
  return {
    review_id: `R-${reviewSeq}`,
    reviewer_id: `F-${reviewSeq}`,
    tier: "T2",
    cross_family: true,
    full_write_up: true,
    finding: "support",
    ...overrides,
  };
}

function context(overrides: Partial<ClaimTransitionContext> = {}): ClaimTransitionContext {
  return { ...EMPTY_CLAIM_CONTEXT, ...overrides };
}

const T2_REVIEW = review({ tier: "T2" });
const T1_REVIEW = review({ tier: "T1", cross_family: false });
const T0_REVIEW = review({ tier: "T0", cross_family: false });

function expectAllowed(
  current: ClaimDisposition,
  event: ClaimEvent,
  ctx: ClaimTransitionContext,
  next: ClaimDisposition,
) {
  const result = evaluateClaimTransition(current, event, ctx);
  expect(result).toEqual({ allowed: true, next });
}

function expectRefused(
  current: ClaimDisposition,
  event: ClaimEvent,
  ctx: ClaimTransitionContext,
  unmet: string[],
) {
  const result = evaluateClaimTransition(current, event, ctx);
  expect(result).toEqual({ allowed: false, unmet });
}

// ---------------------------------------------------------------------------
// The legal transition table (Fable §6.4)
// ---------------------------------------------------------------------------

describe("claim machine: the full legal transition table", () => {
  const LEGAL: readonly [ClaimDisposition, ClaimEvent, ClaimTransitionContext, ClaimDisposition][] =
    [
      ["draft", { kind: "promote" }, EMPTY_CLAIM_CONTEXT, "open"],
      // open → corroborated: ≥1 independent verified review AND ≥1 recorded refutation attempt.
      [
        "open",
        { kind: "review-verified", review: T1_REVIEW },
        context({ recorded_refutation_attempts: 1 }),
        "corroborated",
      ],
      // open → disputed: live unresolved refuting evidence lands.
      [
        "open",
        {
          kind: "evidence-refuted",
          evidence_id: "E-1",
          confirmed_by_independent_review: false,
          unanswered_hours: 0,
        },
        EMPTY_CLAIM_CONTEXT,
        "disputed",
      ],
      // open → refuted in one step when the refuting evidence already stands confirmed + 72h unanswered.
      [
        "open",
        {
          kind: "evidence-refuted",
          evidence_id: "E-1",
          confirmed_by_independent_review: true,
          unanswered_hours: 96,
        },
        EMPTY_CLAIM_CONTEXT,
        "refuted",
      ],
      // corroborated → strongly-supported via a certified-class artifact at tier ≥ T2.
      [
        "corroborated",
        { kind: "review-verified", review: T2_REVIEW },
        context({ has_certified_artifact: true, recorded_refutation_attempts: 1 }),
        "strongly-supported",
      ],
      // corroborated → strongly-supported via two cross-family full-write-up reviews.
      [
        "corroborated",
        {
          kind: "review-verified",
          review: review({
            review_id: "R-STRONG-B",
            reviewer_id: "F-STRONG-B",
            tier: "T2",
          }),
        },
        context({
          verified_reviews: [
            review({ review_id: "R-STRONG-A", reviewer_id: "F-STRONG-A", tier: "T2" }),
          ],
          recorded_refutation_attempts: 1,
        }),
        "strongly-supported",
      ],
      // corroborated/strongly-supported knocked back to disputed by live refuting evidence.
      [
        "corroborated",
        {
          kind: "evidence-refuted",
          evidence_id: "E-9",
          confirmed_by_independent_review: false,
          unanswered_hours: 3,
        },
        context({ verified_reviews: [T2_REVIEW], recorded_refutation_attempts: 1 }),
        "disputed",
      ],
      [
        "strongly-supported",
        {
          kind: "evidence-refuted",
          evidence_id: "E-9",
          confirmed_by_independent_review: false,
          unanswered_hours: 3,
        },
        context({ verified_reviews: [T2_REVIEW], recorded_refutation_attempts: 1 }),
        "disputed",
      ],
      // disputed → refuted once the refutation stands confirmed and 72h unanswered.
      [
        "disputed",
        {
          kind: "evidence-refuted",
          evidence_id: "E-1",
          confirmed_by_independent_review: true,
          unanswered_hours: 72,
        },
        EMPTY_CLAIM_CONTEXT,
        "refuted",
      ],
      // author concession refutes from any live state.
      ["open", { kind: "author-concession" }, EMPTY_CLAIM_CONTEXT, "refuted"],
      ["disputed", { kind: "author-concession" }, EMPTY_CLAIM_CONTEXT, "refuted"],
      [
        "corroborated",
        { kind: "author-concession" },
        context({ verified_reviews: [T2_REVIEW], recorded_refutation_attempts: 1 }),
        "refuted",
      ],
      // withdrawal from live states.
      ["open", { kind: "author-withdrawal" }, EMPTY_CLAIM_CONTEXT, "withdrawn"],
      ["reduced-to", { kind: "author-withdrawal" }, EMPTY_CLAIM_CONTEXT, "withdrawn"],
      // reduced-to is bookkeeping, from any live state, with a target.
      ["open", { kind: "reduced-to", target_claim_id: "C-2" }, EMPTY_CLAIM_CONTEXT, "reduced-to"],
      [
        "disputed",
        { kind: "reduced-to", target_claim_id: "C-2" },
        EMPTY_CLAIM_CONTEXT,
        "reduced-to",
      ],
      // a supporting review that finds the statement defective routes to malformed.
      [
        "open",
        { kind: "review-verified", review: review({ finding: "statement-defect" }) },
        EMPTY_CLAIM_CONTEXT,
        "malformed",
      ],
      [
        "disputed",
        { kind: "review-verified", review: review({ finding: "statement-defect" }) },
        EMPTY_CLAIM_CONTEXT,
        "malformed",
      ],
      // a dispute finding on a verified review opens a live contest.
      [
        "open",
        { kind: "review-verified", review: review({ finding: "dispute" }) },
        EMPTY_CLAIM_CONTEXT,
        "disputed",
      ],
      // a refutation attempt recorded against an open claim leaves it open.
      [
        "open",
        { kind: "refutation-attempt-recorded", attempt_id: "RA-1" },
        EMPTY_CLAIM_CONTEXT,
        "open",
      ],
      // new-version supersedes every published non-terminal state.
      ["open", { kind: "new-version", new_version: 2 }, EMPTY_CLAIM_CONTEXT, "superseded"],
      ["malformed", { kind: "new-version", new_version: 2 }, EMPTY_CLAIM_CONTEXT, "superseded"],
      ["disputed", { kind: "new-version", new_version: 2 }, EMPTY_CLAIM_CONTEXT, "superseded"],
      [
        "corroborated",
        { kind: "new-version", new_version: 2 },
        context({ verified_reviews: [T2_REVIEW], recorded_refutation_attempts: 1 }),
        "superseded",
      ],
      ["reduced-to", { kind: "new-version", new_version: 2 }, EMPTY_CLAIM_CONTEXT, "superseded"],
      // operator repair reaches any state, reason mandatory.
      [
        "superseded",
        { kind: "operator-repair", reason: "W5.4 evaluator bug mis-fired RA-7", to: "open" },
        EMPTY_CLAIM_CONTEXT,
        "open",
      ],
      [
        "malformed",
        {
          kind: "operator-repair",
          reason: "statement-defect finding recorded against the wrong claim id",
          to: "open",
        },
        EMPTY_CLAIM_CONTEXT,
        "open",
      ],
    ];

  for (const [current, event, ctx, next] of LEGAL) {
    test(`${current} --${event.kind}--> ${next}`, () => {
      expectAllowed(current, event, ctx, next);
    });
  }
});

// ---------------------------------------------------------------------------
// Illegal transitions refused with the EXACT unmet conditions
// ---------------------------------------------------------------------------

describe("claim machine: illegal transitions refuse with exact unmet conditions", () => {
  const ILLEGAL: readonly [
    string,
    ClaimDisposition,
    ClaimEvent,
    ClaimTransitionContext,
    string[],
  ][] = [
    [
      "corroborated refuses support with no refutation attempt, however many reviews",
      "open",
      { kind: "review-verified", review: T2_REVIEW },
      context({ verified_reviews: [T2_REVIEW, T2_REVIEW] }),
      ["requires ≥1 recorded refutation attempt"],
    ],
    [
      "corroborated refuses a T0 (same-sponsor) review even with an attempt recorded",
      "open",
      { kind: "review-verified", review: T0_REVIEW },
      context({ recorded_refutation_attempts: 1 }),
      ["requires ≥1 independent verified review (tier ≥ T1)"],
    ],
    [
      "corroborated lists both unmet conditions when both fail",
      "open",
      { kind: "review-verified", review: T0_REVIEW },
      EMPTY_CLAIM_CONTEXT,
      [
        "requires ≥1 independent verified review (tier ≥ T1)",
        "requires ≥1 recorded refutation attempt",
      ],
    ],
    [
      "a high-tier dispute cannot lend independence to a same-sponsor supporting review",
      "open",
      { kind: "review-verified", review: T0_REVIEW },
      context({
        recorded_refutation_attempts: 1,
        verified_reviews: [review({ tier: "T3", finding: "dispute" })],
      }),
      ["requires ≥1 independent verified review (tier ≥ T1)"],
    ],
    [
      "strongly-supported refuses corroborated without artifact or two cross-family full-write-up reviews",
      "corroborated",
      { kind: "review-verified", review: review({ tier: "T2", full_write_up: false }) },
      context({ recorded_refutation_attempts: 1 }),
      [
        "requires a certified-class artifact or two cross-family verified reviews of a full write-up",
      ],
    ],
    [
      "strongly-supported refuses independence below T2 with the exact tier",
      "corroborated",
      { kind: "review-verified", review: T1_REVIEW },
      context({ verified_reviews: [T1_REVIEW], recorded_refutation_attempts: 1 }),
      [
        "requires a certified-class artifact or two cross-family verified reviews of a full write-up",
        "requires independence tier ≥ T2, got T1",
      ],
    ],
    [
      "strongly-supported reports only the tier when the artifact leg is satisfied",
      "corroborated",
      { kind: "review-verified", review: T1_REVIEW },
      context({ has_certified_artifact: true, recorded_refutation_attempts: 1 }),
      ["requires independence tier ≥ T2, got T1"],
    ],
    [
      "a dispute cannot complete the two-review strong-support leg",
      "corroborated",
      { kind: "review-verified", review: review({ tier: "T2" }) },
      context({
        recorded_refutation_attempts: 1,
        verified_reviews: [review({ tier: "T3", finding: "dispute" })],
      }),
      [
        "requires a certified-class artifact or two cross-family verified reviews of a full write-up",
      ],
    ],
    [
      "a statement-defect cannot lend independence to strong support",
      "corroborated",
      { kind: "review-verified", review: review({ tier: "T1" }) },
      context({
        has_certified_artifact: true,
        recorded_refutation_attempts: 1,
        verified_reviews: [review({ tier: "T3", finding: "statement-defect" })],
      }),
      ["requires independence tier ≥ T2, got T1"],
    ],
    [
      "one reviewer's replayed review cannot complete the strong-support leg",
      "corroborated",
      {
        kind: "review-verified",
        review: review({ review_id: "R-DUPLICATE", reviewer_id: "F-DUPLICATE" }),
      },
      context({
        recorded_refutation_attempts: 1,
        verified_reviews: [review({ review_id: "R-DUPLICATE", reviewer_id: "F-DUPLICATE" })],
      }),
      [
        "requires a certified-class artifact or two cross-family verified reviews of a full write-up",
      ],
    ],
    [
      "one reviewer cannot use two review ids to complete the strong-support leg",
      "corroborated",
      {
        kind: "review-verified",
        review: review({ review_id: "R-SAME-REVIEWER-B", reviewer_id: "F-SAME-REVIEWER" }),
      },
      context({
        recorded_refutation_attempts: 1,
        verified_reviews: [
          review({ review_id: "R-SAME-REVIEWER-A", reviewer_id: "F-SAME-REVIEWER" }),
        ],
      }),
      [
        "requires a certified-class artifact or two cross-family verified reviews of a full write-up",
      ],
    ],
    [
      "conflicting copies of one review id provide no supporting tier",
      "corroborated",
      { kind: "review-verified", review: review({ review_id: "R-CONFLICT", tier: "T1" }) },
      context({
        has_certified_artifact: true,
        recorded_refutation_attempts: 1,
        verified_reviews: [review({ review_id: "R-CONFLICT", tier: "T3" })],
      }),
      ["requires independence tier ≥ T2, got none"],
    ],
    [
      "disputed refuses refuted while the refutation is unconfirmed",
      "disputed",
      {
        kind: "evidence-refuted",
        evidence_id: "E-1",
        confirmed_by_independent_review: false,
        unanswered_hours: 200,
      },
      EMPTY_CLAIM_CONTEXT,
      ["requires the refuting evidence to be confirmed by an independent review"],
    ],
    [
      "disputed refuses refuted before 72h unanswered, with the exact elapsed time",
      "disputed",
      {
        kind: "evidence-refuted",
        evidence_id: "E-1",
        confirmed_by_independent_review: true,
        unanswered_hours: 24,
      },
      EMPTY_CLAIM_CONTEXT,
      ["requires the refuting evidence to stand unanswered for 72h, got 24h"],
    ],
    [
      "disputed lists both refuted preconditions when both fail",
      "disputed",
      {
        kind: "evidence-refuted",
        evidence_id: "E-1",
        confirmed_by_independent_review: false,
        unanswered_hours: 1,
      },
      EMPTY_CLAIM_CONTEXT,
      [
        "requires the refuting evidence to be confirmed by an independent review",
        "requires the refuting evidence to stand unanswered for 72h, got 1h",
      ],
    ],
    [
      "promote requires draft",
      "open",
      { kind: "promote" },
      EMPTY_CLAIM_CONTEXT,
      ["promote requires draft, got open"],
    ],
    [
      "terminal states refuse everything",
      "refuted",
      { kind: "review-verified", review: T2_REVIEW },
      context({ recorded_refutation_attempts: 1 }),
      ["refuted is a terminal disposition"],
    ],
    [
      "withdrawn is terminal",
      "withdrawn",
      { kind: "author-concession" },
      EMPTY_CLAIM_CONTEXT,
      ["withdrawn is a terminal disposition"],
    ],
    [
      "superseded is terminal",
      "superseded",
      { kind: "new-version", new_version: 3 },
      EMPTY_CLAIM_CONTEXT,
      ["superseded is a terminal disposition"],
    ],
    [
      "reduced-to requires a target claim",
      "open",
      { kind: "reduced-to", target_claim_id: "  " },
      EMPTY_CLAIM_CONTEXT,
      ["reduced-to requires a target claim"],
    ],
    [
      "reduced-to is not legal from draft",
      "draft",
      { kind: "reduced-to", target_claim_id: "C-2" },
      EMPTY_CLAIM_CONTEXT,
      ["reduced-to is not legal from draft"],
    ],
    [
      "operator repair requires a public reason",
      "open",
      { kind: "operator-repair", reason: "", to: "corroborated" },
      EMPTY_CLAIM_CONTEXT,
      ["operator repair requires a public reason recorded on the ledger event"],
    ],
    [
      "a draft does not mint versions",
      "draft",
      { kind: "new-version", new_version: 2 },
      EMPTY_CLAIM_CONTEXT,
      ["drafts are edited in place; only a published claim mints a new version"],
    ],
  ];

  for (const [name, current, event, ctx, unmet] of ILLEGAL) {
    test(name, () => {
      const result = evaluateClaimTransition(current, event, ctx);
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect([...result.unmet]).toEqual(unmet);
    });
  }

  test("strongly-supported cannot be reached directly from open; the machine steps through corroborated", () => {
    // Even with a certified artifact, a T3 review, and a recorded attempt all
    // present at once, one event moves open exactly one step.
    expectAllowed(
      "open",
      { kind: "review-verified", review: review({ tier: "T3" }) },
      context({ has_certified_artifact: true, recorded_refutation_attempts: 1 }),
      "corroborated",
    );
  });

  test("a supporting review on an already strongly-supported claim is refused, not silently absorbed", () => {
    expectRefused(
      "strongly-supported",
      { kind: "review-verified", review: T2_REVIEW },
      context({ has_certified_artifact: true, recorded_refutation_attempts: 1 }),
      ["a supporting review is not legal from strongly-supported"],
    );
  });
});

// ---------------------------------------------------------------------------
// Refuter-first display: open · unchallenged
// ---------------------------------------------------------------------------

describe("refuter-first display", () => {
  test("100 supports without a refutation attempt never displays corroborated", () => {
    const supports = Array.from({ length: 100 }, () => review({ tier: "T3" }));
    const ctx = context({ verified_reviews: supports });
    expect(displayClaimDisposition("open", ctx)).toBe("open · unchallenged");
    // And the machine agrees: the 101st supporting review still cannot corroborate.
    expectRefused("open", { kind: "review-verified", review: review({ tier: "T3" }) }, ctx, [
      "requires ≥1 recorded refutation attempt",
    ]);
  });

  test("a bare open claim with no reviews displays plain open", () => {
    expect(displayClaimDisposition("open", EMPTY_CLAIM_CONTEXT)).toBe("open");
  });

  test("an open claim with a recorded attempt displays plain open until corroborated", () => {
    expect(
      displayClaimDisposition(
        "open",
        context({ verified_reviews: [T2_REVIEW], recorded_refutation_attempts: 1 }),
      ),
    ).toBe("open");
  });

  test("non-open dispositions display as themselves", () => {
    expect(displayClaimDisposition("strongly-supported", EMPTY_CLAIM_CONTEXT)).toBe(
      "strongly-supported",
    );
  });
});

// ---------------------------------------------------------------------------
// No proved state; machine-checked is a badge
// ---------------------------------------------------------------------------

describe("no proved state anywhere", () => {
  test("the vocabulary contains no proved", () => {
    expect(CLAIM_DISPOSITIONS).not.toContain("proved");
    expect(HYPOTHESIS_DISPOSITIONS).not.toContain("proved");
  });

  test("machine-checked is a display badge over strongly-supported-via-certified-artifact, not a disposition", () => {
    expect(
      wearsMachineCheckedBadge("strongly-supported", context({ has_certified_artifact: true })),
    ).toBe(true);
    expect(
      wearsMachineCheckedBadge("strongly-supported", context({ has_certified_artifact: false })),
    ).toBe(false);
    expect(
      wearsMachineCheckedBadge("corroborated", context({ has_certified_artifact: true })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The malformed exit rule
// ---------------------------------------------------------------------------

describe("malformed exits only via a new claim version", () => {
  test("a machine-checked proof of a mis-stated theorem lands in malformed, never strongly-supported", () => {
    // The review verifies the artifact compiles AND finds the statement
    // addresses the wrong object: proof evidence cannot cure a statement defect.
    const proofOfMisstatedTheorem = review({
      tier: "T3",
      cross_family: true,
      full_write_up: true,
      finding: "statement-defect",
    });
    expectAllowed(
      "open",
      { kind: "review-verified", review: proofOfMisstatedTheorem },
      context({ has_certified_artifact: true, recorded_refutation_attempts: 3 }),
      "malformed",
    );
  });

  test("no review or evidence volume rehabilitates a malformed claim in place", () => {
    const events: ClaimEvent[] = [
      { kind: "review-verified", review: review({ tier: "T3" }) },
      { kind: "refutation-attempt-recorded", attempt_id: "RA-1" },
      {
        kind: "evidence-refuted",
        evidence_id: "E-1",
        confirmed_by_independent_review: true,
        unanswered_hours: 720,
      },
      { kind: "author-concession" },
      { kind: "author-withdrawal" },
      { kind: "reduced-to", target_claim_id: "C-2" },
      { kind: "promote" },
    ];
    for (const event of events) {
      expectRefused(
        "malformed",
        event,
        context({
          verified_reviews: [T2_REVIEW],
          recorded_refutation_attempts: 5,
          has_certified_artifact: true,
        }),
        ["malformed exits only via a new claim version"],
      );
    }
  });

  test("the sole exit supersedes the malformed version", () => {
    expectAllowed(
      "malformed",
      { kind: "new-version", new_version: 2 },
      EMPTY_CLAIM_CONTEXT,
      "superseded",
    );
  });
});

// ---------------------------------------------------------------------------
// Hypothesis sub-machine
// ---------------------------------------------------------------------------

describe("hypothesis sub-machine", () => {
  const LEGAL: readonly [HypothesisDisposition, HypothesisEvent, HypothesisDisposition][] = [
    ["active", { kind: "narrow" }, "narrowed"],
    ["narrowed", { kind: "narrow" }, "narrowed"],
    ["active", { kind: "kill", killed_by: "E-4" }, "killed"],
    ["narrowed", { kind: "kill", killed_by: "R-2" }, "killed"],
    ["deferred", { kind: "kill", killed_by: "R-2" }, "killed"],
    ["active", { kind: "defer" }, "deferred"],
    ["narrowed", { kind: "defer" }, "deferred"],
    ["deferred", { kind: "resume" }, "active"],
    ["active", { kind: "supersede", successor_id: "H-9" }, "superseded"],
    ["deferred", { kind: "supersede", successor_id: "H-9" }, "superseded"],
  ];
  for (const [current, event, next] of LEGAL) {
    test(`${current} --${event.kind}--> ${next}`, () => {
      expect(evaluateHypothesisTransition(current, event)).toEqual({ allowed: true, next });
    });
  }

  test("kill requires killed_by pointing at the evidence or review that fired the falsifier", () => {
    expect(evaluateHypothesisTransition("active", { kind: "kill" })).toEqual({
      allowed: false,
      unmet: [
        "kill requires killed_by pointing at the evidence or review that fired the falsifier",
      ],
    });
    expect(evaluateHypothesisTransition("narrowed", { kind: "kill", killed_by: " " })).toEqual({
      allowed: false,
      unmet: [
        "kill requires killed_by pointing at the evidence or review that fired the falsifier",
      ],
    });
  });

  test("killed and superseded are terminal", () => {
    expect(evaluateHypothesisTransition("killed", { kind: "resume" })).toEqual({
      allowed: false,
      unmet: ["killed is a terminal disposition"],
    });
    expect(evaluateHypothesisTransition("superseded", { kind: "narrow" })).toEqual({
      allowed: false,
      unmet: ["superseded is a terminal disposition"],
    });
  });

  test("deferred cannot narrow without resuming; active cannot resume", () => {
    expect(evaluateHypothesisTransition("deferred", { kind: "narrow" })).toEqual({
      allowed: false,
      unmet: ["narrow is not legal from deferred"],
    });
    expect(evaluateHypothesisTransition("active", { kind: "resume" })).toEqual({
      allowed: false,
      unmet: ["resume is not legal from active"],
    });
  });

  test("surviving current tests is displayed as exactly that, never a green check", () => {
    expect(displayHypothesisDisposition("active")).toBe("surviving current tests");
    expect(displayHypothesisDisposition("narrowed")).toBe("narrowed · surviving current tests");
    for (const disposition of HYPOTHESIS_DISPOSITIONS) {
      const display = displayHypothesisDisposition(disposition);
      expect(display).not.toMatch(/✓|✔|☑|green|proved/i);
    }
    expect(displayHypothesisDisposition("killed")).toBe("killed");
  });
});

// ---------------------------------------------------------------------------
// Independence tiers (§6.6)
// ---------------------------------------------------------------------------

describe("independence tiers", () => {
  test("T0 same sponsor", () => {
    expect(computeIndependenceTier("S-1", "S-1", "family-b", "family-a", true)).toBe("T0");
  });
  test("T1 different sponsor, same model family", () => {
    expect(computeIndependenceTier("S-2", "S-1", "family-a", "family-a", true)).toBe("T1");
  });
  test("T2 different sponsor and different family", () => {
    expect(computeIndependenceTier("S-2", "S-1", "family-b", "family-a", false)).toBe("T2");
  });
  test("T3 = T2 + disjoint method", () => {
    expect(computeIndependenceTier("S-2", "S-1", "family-b", "family-a", true)).toBe("T3");
  });
  test("disjoint method cannot lift a same-sponsor review past T0, nor a same-family review past T1", () => {
    expect(computeIndependenceTier("S-1", "S-1", "family-b", "family-a", true)).toBe("T0");
    expect(computeIndependenceTier("S-2", "S-1", "family-a", "family-a", true)).toBe("T1");
  });

  test("a review's tier is pinned at review time from the facts at that moment", () => {
    const pinned = pinIndependenceAtReviewTime(
      "S-2",
      "S-1",
      "family-b",
      "family-a",
      false,
      "2026-08-18T00:00:00Z",
    );
    expect(pinned.tier).toBe("T2");
    expect(pinned.pinned_at.reviewer_sponsor_id).toBe("S-2");
    expect(pinned.pinned_at.reviewed_at).toBe("2026-08-18T00:00:00Z");
  });

  test("a later sponsorship transfer never retroactively upgrades a recorded tier", () => {
    // Pinned T0: reviewer and author shared a sponsor at review time. The
    // reviewer later transfers to a different sponsor and re-declares a
    // different family — recomputation now says T3, and that is refused.
    const pinned = pinIndependenceAtReviewTime(
      "S-1",
      "S-1",
      "family-a",
      "family-a",
      false,
      "2026-08-01T00:00:00Z",
    );
    expect(pinned.tier).toBe("T0");
    const result = recomputePinnedIndependence(pinned, "S-9", "S-1", "family-b", "family-a", true);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.unmet).toEqual([
        "independence tier is pinned at review time (T0); a later sponsorship transfer, re-declaration, or roster change never retroactively upgrades a recorded tier (recomputed T3)",
      ]);
    }
  });

  test("recomputation that agrees with the pin is a no-op returning the pinned tier", () => {
    const pinned = pinIndependenceAtReviewTime(
      "S-2",
      "S-1",
      "family-b",
      "family-a",
      true,
      "2026-08-01T00:00:00Z",
    );
    expect(recomputePinnedIndependence(pinned, "S-2", "S-1", "family-b", "family-a", true)).toEqual(
      {
        allowed: true,
        next: "T3",
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Computed facets
// ---------------------------------------------------------------------------

describe("review-state facet", () => {
  const checked = { status: "completed", verified: true, tier: "T2", finding: "support" } as const;

  test("unreviewed when nothing requested and no reviews", () => {
    expect(computeReviewStateFacet({ review_requested: false }, [])).toBe("unreviewed");
  });
  test("review-requested", () => {
    expect(computeReviewStateFacet({ review_requested: true }, [])).toBe("review-requested");
  });
  test("under-review while a review is in flight", () => {
    expect(
      computeReviewStateFacet({ review_requested: true }, [
        { status: "in-progress", verified: false, tier: "T1", finding: "support" },
      ]),
    ).toBe("under-review");
  });
  test("independently-checked requires a completed, verified, tier ≥ T1 review", () => {
    expect(computeReviewStateFacet({ review_requested: false }, [checked])).toBe(
      "independently-checked",
    );
    // A same-sponsor (T0) review does not independently check.
    expect(computeReviewStateFacet({ review_requested: false }, [{ ...checked, tier: "T0" }])).toBe(
      "unreviewed",
    );
    // An unverified completed review does not independently check.
    expect(
      computeReviewStateFacet({ review_requested: false }, [{ ...checked, verified: false }]),
    ).toBe("unreviewed");
  });
  test("contested outranks independently-checked: a live dispute is what reviewers need to see", () => {
    expect(
      computeReviewStateFacet({ review_requested: false }, [
        checked,
        { status: "completed", verified: true, tier: "T3", finding: "dispute" },
      ]),
    ).toBe("contested");
  });
});

describe("staleness facet", () => {
  test("invalidated evidence flags the dependent disposition stale rather than cosmetically green", () => {
    const facet = computeStalenessFacet({ resting_on_evidence_ids: ["E-1", "E-2"] }, [
      { kind: "evidence-invalidated", evidence_id: "E-2" },
    ]);
    expect(facet).toEqual({ stale: true, flagged_evidence_ids: ["E-2"], display: "stale" });
  });

  test("retracted and superseded evidence also flag dependents", () => {
    for (const kind of ["evidence-retracted", "evidence-superseded"] as const) {
      const facet = computeStalenessFacet({ resting_on_evidence_ids: ["E-7"] }, [
        { kind, evidence_id: "E-7" },
      ]);
      expect(facet.stale).toBe(true);
      expect(facet.display).toBe("stale");
    }
  });

  test("evidence the disposition does not rest on leaves it fresh", () => {
    const facet = computeStalenessFacet({ resting_on_evidence_ids: ["E-1"] }, [
      { kind: "evidence-invalidated", evidence_id: "E-99" },
    ]);
    expect(facet).toEqual({ stale: false, flagged_evidence_ids: [], display: "fresh" });
  });

  test("a disposition resting on nothing cannot go stale", () => {
    const facet = computeStalenessFacet({ resting_on_evidence_ids: [] }, [
      { kind: "evidence-invalidated", evidence_id: "E-1" },
    ]);
    expect(facet.stale).toBe(false);
  });
});
