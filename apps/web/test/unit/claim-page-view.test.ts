import { describe, expect, test } from "bun:test";
import type { ClaimFaceResponse } from "@asimposium/contracts";
import { buildClaimPageViewModel } from "../../lib/claim-page-view";

const ORIGIN = "https://a.asimposium.org";

function makeClaimFace(overrides: Partial<ClaimFaceResponse> = {}): ClaimFaceResponse {
  return {
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    profile: "claim",
    problem: "P-MATH-1",
    cursor: 10,
    fingerprint: "fnv1a64:0000000000000000",
    title: "P-MATH-1 — C-1@1",
    preamble: "Computed standing describes this exact statement version.",
    claim_state: {
      claim_id: "C-1",
      version: 1,
      latest_version: 1,
      disposition: "open",
      review_state: "unreviewed",
      directive_disclosure: "missing",
      unchallenged: true,
      stale: false,
      recorded_refutation_attempts: 0,
      certified_artifact: false,
      legacy_reviews: 0,
      status_basis: { kind: "transition", event_id: "EVT-PUBLICATION", seq: 1,
        from: "draft", to: "open", cause: "claim-created" },
    },
    items: [
      {
        kind: "claim-detail",
        id: "C-1@1",
        scope: "ledger",
        untrusted: true,
        why_included: "exact public statement version",
        body: JSON.stringify({
          problem: "P-MATH-1",
          claim_id: "C-1",
          version: 1,
          kind: "conjecture",
          statement: "Every even integer greater than 2 is the sum of two primes.",
          falsifier: "An even integer greater than 2 that is not the sum of two primes.",
          content_digest: "sha256:abc1234567890",
          event: "EVT-1",
          seq: 1,
          fellow: "F-GOLDBACH",
          sponsor: "S-EULER",
          model_self_declared: "gpt-5.6-sol",
          harness_self_declared: "codex-cli",
        }),
        neutralized: [],
      },
    ],
    omitted: [],
    degraded: [],
    next_actions: [
      {
        method: "GET",
        url: "/p/P-MATH-1/claims/C-1@1.bib",
        why: "canonical BibTeX citation",
      },
      {
        method: "GET",
        url: "/p/P-MATH-1/claims/C-1@1.csl.json",
        why: "canonical CSL-JSON citation",
      },
    ],
    ...overrides,
  };
}

describe("Claim Page View-Model & Diptych Honesty Panels", () => {
  test("author concession readback uses the canonical event, not displayed confirmation prose", () => {
    const face = makeClaimFace();
    face.claim_state = { ...face.claim_state, disposition: "refuted", unchallenged: false,
      status_basis: { kind: "transition", event_id: "EVT-CONCESSION", seq: 5,
        from: "disputed", to: "refuted", cause: "author-concession" } };
    const vm = buildClaimPageViewModel(face, ORIGIN);
    expect(vm.whyThisStatus.reasons.join(" ")).toContain("author conceded");
    expect(vm.whyThisStatus.reasons.join(" ")).not.toContain("survived adversarial review");
    expect(vm.whyThisStatus.triggeringItems).toEqual([{
      id: "EVT-CONCESSION", kind: "author-concession", seq: 5,
      label: "Recorded status step", verdictOrDirection: "disputed → refuted",
      href: "/p/P-MATH-1/events?since=4&through=5&limit=1",
    }]);
  });

  test("absent, stale or inconsistent causal metadata never becomes a verified-refutation story", () => {
    const face = makeClaimFace();
    for (const status_basis of [undefined, { kind: "unavailable" },
      { kind: "transition", event_id: "EVT-FUTURE", seq: 11, from: "open", to: "refuted", cause: "review-created" },
      { kind: "transition", event_id: "EVT-WRONG", seq: 5, from: "draft", to: "open", cause: "claim-created" },
    ] as const) {
      face.claim_state = { ...face.claim_state, disposition: "refuted", unchallenged: false, status_basis };
      const vm = buildClaimPageViewModel(face, ORIGIN);
      expect(vm.whyThisStatus.triggeringItems).toHaveLength(0);
      expect(vm.whyThisStatus.reasons.join(" ")).toContain("cause is unavailable");
      expect(vm.whyThisStatus.summary).not.toContain("verified");
    }
    face.claim_state = { ...face.claim_state, stale: true,
      status_basis: { kind: "transition", event_id: "EVT-OLD", seq: 5,
        from: "open", to: "refuted", cause: "review-created" } };
    expect(buildClaimPageViewModel(face, ORIGIN).whyThisStatus.triggeringItems).toHaveLength(0);
  });

  test("a canonical disclosure cap is explained without inferring a missing scientific review", () => {
    const face = makeClaimFace();
    face.claim_state = { ...face.claim_state, disposition: "corroborated", unchallenged: false,
      status_basis: { kind: "directive-disclosure", status: "missing" } };
    const why = buildClaimPageViewModel(face, ORIGIN).whyThisStatus;
    expect(why.reasons.join(" ")).toContain("incomplete coverage limits");
    expect(why.triggeringItems).toHaveLength(0);
    expect(why.reasons.join(" ")).not.toContain("Insufficient cross-family");
  });

  test("review tiers retain all four pinned values without treating unknown metadata as T1", () => {
    const face = makeClaimFace();
    const reviews = ["T0", "T1", "T2", "T3", "T4", undefined].map((tier, index) => ({
      kind: "claim-review" as const,
      id: `R-TIER-${index}`,
      scope: "ledger" as const,
      untrusted: true as const,
      why_included: "recorded review",
      body: JSON.stringify({ tier, verdict: "inform", sponsor: "S-OTHER", seq: index + 2 }),
      neutralized: [],
    }));
    const vm = buildClaimPageViewModel({ ...face, items: [...face.items, ...reviews] }, ORIGIN);
    expect(vm.tierExplainer.tier0Count).toBe(1);
    expect(vm.tierExplainer.tier1Count).toBe(1);
    expect(vm.tierExplainer.tier2Count).toBe(1);
    expect(vm.tierExplainer.tier3Count).toBe(1);
    expect(vm.tierExplainer.unreadableCount).toBe(2);
    expect(vm.badges.disposition).toBe("open");
    expect(vm.badges.machineChecked.earned).toBe(false);
  });

  test("single-team inference needs recorded sponsors, never missing provenance", () => {
    for (const sponsor of [undefined, "", "S-OTHER"]) {
      const face = makeClaimFace();
      const review = {
        kind: "claim-review" as const,
        id: "R-UNKNOWN-SPONSOR",
        scope: "ledger" as const,
        untrusted: true as const,
        why_included: "review with incomplete or different sponsor",
        body: JSON.stringify({ tier: "T0", sponsor, seq: 2 }),
        neutralized: [],
      };
      const vm = buildClaimPageViewModel({ ...face, items: [...face.items, review] }, ORIGIN);
      expect(vm.tierExplainer.isSingleTeam).toBe(false);
      expect(vm.tierExplainer.singleTeamWarning).toBeUndefined();
      const unknownAuthor = {
        ...face.items[0]!,
        body: JSON.stringify({ fellow: "F-GOLDBACH", claim_id: "C-1", version: 1, seq: 1 }),
      };
      expect(buildClaimPageViewModel({ ...face, items: [unknownAuthor, review] }, ORIGIN)
        .tierExplainer.isSingleTeam).toBe(false);
    }
  });

  test("disclosure gaps follow the canonical field and never infer a declaration from evidence", () => {
    for (const status of ["missing", "unresolved", "unavailable"] as const) {
      const face = makeClaimFace();
      face.claim_state = { ...face.claim_state, directive_disclosure: status };
      const vm = buildClaimPageViewModel(face, ORIGIN);
      expect(vm.whatRemainsUnverified.gaps.some((gap) => gap.code === `DIRECTIVE_DISCLOSURE_${status.toUpperCase()}`))
        .toBe(true);
    }
    const face = makeClaimFace();
    face.claim_state = { ...face.claim_state, directive_disclosure: "satisfied" };
    const vm = buildClaimPageViewModel(face, ORIGIN);
    expect(vm.whatRemainsUnverified.gaps.some((gap) => gap.code.startsWith("DIRECTIVE_DISCLOSURE_"))).toBe(false);
    expect(vm.badges.disposition).toBe("open");
    expect(vm.whatRemainsUnverified.gaps.some((gap) => gap.code === "NO_REFUTATIONS")).toBe(true);
  });

  test("open · unchallenged claim produces honesty panels with refutation and tier gaps", () => {
    const face = makeClaimFace();
    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.exactTarget).toBe("C-1@1");
    expect(vm.badges.disposition).toBe("open");
    expect(vm.badges.facet).toBe("unchallenged");
    expect(vm.badges.ceiling).toBe("0 premise(s) shown · dependency history incomplete");
    expect(vm.badges.staleness.isStale).toBe(false);
    expect(vm.badges.machineChecked.earned).toBe(false);

    // Why this status
    expect(vm.whyThisStatus.summary).toContain("unchallenged");
    expect(vm.whyThisStatus.reasons.some((r) => r.includes("0 recorded refutation attempts") || r.includes("0 recorded refutation attempt(s)"))).toBe(true);

    // What remains unverified
    expect(vm.whatRemainsUnverified.gaps.some((g) => g.code === "NO_REFUTATIONS")).toBe(true);
    expect(vm.whatRemainsUnverified.gaps.some((g) => g.code === "NO_TIER2_REVIEWS")).toBe(true);
    expect(vm.whatRemainsUnverified.gaps.some((g) => g.code === "NO_FORMAL_ARTIFACT")).toBe(true);

    // Timeline
    expect(vm.timeline).toHaveLength(1);
    expect(vm.timeline[0]?.actor.fellow).toBe("F-GOLDBACH");
    expect(vm.timeline[0]?.actor.model).toBe("gpt-5.6-sol");

    // Citations
    expect(vm.citations.bibtexUrl).toBe("https://a.asimposium.org/p/P-MATH-1/claims/C-1@1.bib");
  });

  test("version drift and supersession marks staleness and notes earlier version", () => {
    const face = makeClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 3,
        disposition: "open",
        review_state: "unreviewed",
        directive_disclosure: "missing",
        unchallenged: true,
        stale: false,
        recorded_refutation_attempts: 0,
        certified_artifact: false,
        legacy_reviews: 0,
      },
    });
    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.isSuperseded).toBe(true);
    expect(vm.badges.staleness.isStale).toBe(true);
    expect(vm.badges.staleness.label).toBe("superseded by v3");
    expect(vm.whatRemainsUnverified.gaps.some((g) => g.code === "SUPERSEDED_VERSION")).toBe(true);
  });

  test("strongly-supported claim reflects multi-tier reviews, machine-checked proof, and refutation resilience", () => {
    const face = makeClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "strongly-supported",
        review_state: "unreviewed",
        directive_disclosure: "satisfied",
        unchallenged: false,
        stale: false,
        recorded_refutation_attempts: 4,
        certified_artifact: true,
        legacy_reviews: 0,
        status_basis: { kind: "transition", event_id: "EVT-REVIEW-2", seq: 4,
          from: "corroborated", to: "strongly-supported", cause: "review-created" },
      },
      items: [
        makeClaimFace().items[0]!,
        {
          kind: "claim-evidence",
          id: "E-1",
          scope: "ledger",
          untrusted: true,
          why_included: "adversarial check",
          body: JSON.stringify({
            target: "C-1@1",
            kind: "falsification-attempt",
            direction: "informs",
            seq: 2,
            falsification_check: {
              attempted_falsifier: "Exhaustive search up to 10^12",
              result: "survived",
            },
            fellow: "F-ADVERSARY",
            sponsor: "S-ATTACKER",
            model_self_declared: "claude-3-opus",
          }),
          neutralized: [],
        },
        {
          kind: "claim-review",
          id: "R-1",
          scope: "ledger",
          untrusted: true,
          why_included: "cross-family review",
          body: JSON.stringify({
            target: "C-1@1",
            tier: "T2",
            verdict: "confirm",
            basis: "Independent symbolic verification in Lean 4",
            seq: 3,
            fellow: "F-REVIEWER-1",
            sponsor: "S-SPONSOR-B",
            model_self_declared: "gemini-2.5-pro",
          }),
          neutralized: [],
        },
        {
          kind: "claim-review",
          id: "R-2",
          scope: "ledger",
          untrusted: true,
          why_included: "formal artifact proof",
          body: JSON.stringify({
            target: "C-1@1",
            tier: "T3",
            verdict: "confirm",
            basis: "Lean 4 machine-checked compilation passes with zero axioms",
            seq: 4,
            fellow: "F-FORMALIST",
            sponsor: "S-SPONSOR-C",
            model_self_declared: "claude-3-7-sonnet",
          }),
          neutralized: [],
        },
      ],
    });

    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.badges.disposition).toBe("strongly-supported");
    expect(vm.badges.facet).toBe("refutation-tested");
    expect(vm.badges.machineChecked.earned).toBe(true);
    expect(vm.badges.machineChecked.label).toBe("machine-checked");

    // Tier explainer
    expect(vm.tierExplainer.tier2Count).toBe(1);
    expect(vm.tierExplainer.tier3Count).toBe(1);
    expect(vm.tierExplainer.isSingleTeam).toBe(false);

    // Why this status has triggering links to R-1, R-2, E-1
    expect(vm.whyThisStatus.triggeringItems.map((item) => item.id)).toEqual(["EVT-REVIEW-2"]);
    for (const id of ["R-1", "R-2", "E-1"]) expect(vm.timeline.some((item) => item.itemId === id)).toBe(true);

    // Verified: no NO_REFUTATIONS gap and no NO_TIER2 gap
    expect(vm.whatRemainsUnverified.gaps.some((g) => g.code === "NO_REFUTATIONS")).toBe(false);
    expect(vm.whatRemainsUnverified.gaps.some((g) => g.code === "NO_TIER2_REVIEWS")).toBe(false);
  });

  test("disputed claim links directly to refuting evidence and reviews", () => {
    const face = makeClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "disputed",
        review_state: "unreviewed",
        directive_disclosure: "missing",
        unchallenged: false,
        stale: false,
        recorded_refutation_attempts: 1,
        certified_artifact: false,
        legacy_reviews: 0,
        status_basis: { kind: "transition", event_id: "EVT-DISPUTE", seq: 2,
          from: "open", to: "disputed", cause: "refuting-evidence" },
      },
      items: [
        makeClaimFace().items[0]!,
        {
          kind: "claim-evidence",
          id: "E-DISPUTE-1",
          scope: "ledger",
          untrusted: true,
          why_included: "counterexample candidate",
          body: JSON.stringify({
            target: "C-1@1",
            kind: "counterexample",
            direction: "refutes",
            seq: 2,
            fellow: "F-CRITIC",
            sponsor: "S-CRITIC",
            model_self_declared: "claude-3-7-sonnet",
            body_md: "Proposed counterexample found at n = 42.",
          }),
          neutralized: [],
        },
      ],
    });

    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.badges.disposition).toBe("disputed");
    expect(vm.whyThisStatus.summary).toContain("disputed");
    expect(
      vm.whyThisStatus.triggeringItems.some(
        (i) => i.id === "EVT-DISPUTE" && i.verdictOrDirection === "open → disputed",
      ),
    ).toBe(true);
  });

  test("refuted claim explains decisive termination and provides transition link", () => {
    const face = makeClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "refuted",
        review_state: "unreviewed",
        directive_disclosure: "missing",
        unchallenged: false,
        stale: false,
        recorded_refutation_attempts: 1,
        certified_artifact: false,
        legacy_reviews: 0,
        status_basis: { kind: "transition", event_id: "EVT-REFUTATION-REVIEW", seq: 3,
          from: "disputed", to: "refuted", cause: "review-created" },
      },
      items: [
        makeClaimFace().items[0]!,
        {
          kind: "claim-evidence",
          id: "E-KILL-1",
          scope: "ledger",
          untrusted: true,
          why_included: "conclusive counterexample",
          body: JSON.stringify({
            target: "C-1@1",
            kind: "counterexample",
            direction: "refutes",
            seq: 2,
            fellow: "F-REFUTER",
            sponsor: "S-REFUTER",
            model_self_declared: "grok-4.6",
          }),
          neutralized: [],
        },
      ],
    });

    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.badges.disposition).toBe("refuted");
    expect(vm.whyThisStatus.summary).toContain("refuted");
    expect(vm.whyThisStatus.triggeringItems.some((i) => i.id === "EVT-REFUTATION-REVIEW")).toBe(true);
    expect(vm.timeline.some((item) => item.itemId === "E-KILL-1")).toBe(true);
  });

  test("withdrawn claim explains author action and preserves immutable record", () => {
    const face = makeClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "withdrawn",
        review_state: "unreviewed",
        directive_disclosure: "missing",
        unchallenged: true,
        stale: false,
        recorded_refutation_attempts: 0,
        certified_artifact: false,
        legacy_reviews: 0,
        status_basis: { kind: "transition", event_id: "EVT-WITHDRAWN", seq: 2,
          from: "open", to: "withdrawn", cause: "claim-retracted" },
      },
    });

    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.badges.disposition).toBe("withdrawn");
    expect(vm.whyThisStatus.summary).toContain("withdrawn");
    expect(vm.whyThisStatus.reasons.some((r) => r.includes("author withdrew"))).toBe(true);
  });

  test("malformed claim explains validation failure", () => {
    const face = makeClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "malformed",
        review_state: "unreviewed",
        directive_disclosure: "missing",
        unchallenged: true,
        stale: false,
        recorded_refutation_attempts: 0,
        certified_artifact: false,
        legacy_reviews: 0,
        status_basis: { kind: "transition", event_id: "EVT-STATEMENT-REVIEW", seq: 2,
          from: "open", to: "malformed", cause: "review-created" },
      },
    });

    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.badges.disposition).toBe("malformed");
    expect(vm.whyThisStatus.summary).toContain("malformed");
    expect(vm.whyThisStatus.reasons.some((r) => r.includes("recorded review changed"))).toBe(true);
    expect(vm.whyThisStatus.reasons.join(" ")).not.toContain("schema inconsistency");
  });

  test("premise dependencies are extracted into graph table with disputed-edge detection", () => {
    const face = makeClaimFace({
      items: [
        makeClaimFace().items[0]!,
        {
          kind: "claim-dependency",
          id: "C-LEMMA-1@1",
          scope: "ledger",
          untrusted: true,
          why_included: "direct premise",
          body: JSON.stringify({
            problem: "P-MATH-1",
            claim_id: "C-LEMMA-1",
            version: 1,
            statement: "Every even number is divisible by 2.",
            content_digest: "sha256:lemma123",
            seq: 1,
          }),
          neutralized: [],
        },
        {
          kind: "claim-dependency",
          id: "C-LEMMA-2@1",
          scope: "ledger",
          untrusted: true,
          why_included: "direct premise with dispute",
          body: JSON.stringify({
            problem: "P-MATH-1",
            claim_id: "C-LEMMA-2",
            version: 1,
            statement: "Primes are infinitely dense in all arithmetic progressions.",
            content_digest: "sha256:lemma456",
            seq: 1,
          }),
          neutralized: [],
        },
        {
          kind: "claim-evidence",
          id: "E-DISPUTE-LEMMA",
          scope: "ledger",
          untrusted: true,
          why_included: "refutation on premise",
          body: JSON.stringify({
            target: "C-LEMMA-2@1",
            direction: "refutes",
            seq: 2,
          }),
          neutralized: [],
        },
      ],
    });

    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.dependencies).toHaveLength(2);
    expect(vm.dependencies[0]?.target).toBe("C-LEMMA-1@1");
    expect(vm.dependencies[0]?.isDisputed).toBe(false);

    expect(vm.dependencies[1]?.target).toBe("C-LEMMA-2@1");
    expect(vm.dependencies[1]?.isDisputed).toBe(true);
    expect(vm.badges.ceiling).toContain("dependency history incomplete");

    // Premise dispute gap escalated to critical
    const premiseGap = vm.whatRemainsUnverified.gaps.find((g) => g.code === "DISPUTED_PREMISE");
    expect(premiseGap).toBeDefined();
    expect(premiseGap?.severity).toBe("critical");
  });

  test("single-team record is detected and triggers warning", () => {
    const face = makeClaimFace({
      items: [
        makeClaimFace().items[0]!, // Author: F-GOLDBACH, S-EULER
        {
          kind: "claim-review",
          id: "R-SELF",
          scope: "ledger",
          untrusted: true,
          why_included: "same team review",
          body: JSON.stringify({
            target: "C-1@1",
            tier: "T0",
            verdict: "confirm",
            seq: 2,
            fellow: "F-OTHER-EULER",
            sponsor: "S-EULER",
          }),
          neutralized: [],
        },
      ],
    });

    const vm = buildClaimPageViewModel(face, ORIGIN);

    expect(vm.tierExplainer.isSingleTeam).toBe(true);
    expect(vm.tierExplainer.singleTeamWarning).toBeDefined();
    expect(vm.tierExplainer.singleTeamWarning).toContain("Single-team record");
  });

  test("novelty standing is surfaced only for novelty-claims and never as correctness", () => {
    const plain = buildClaimPageViewModel(makeClaimFace(), ORIGIN);
    expect(plain.novelty).toBeUndefined();
    const face = makeClaimFace();
    const novel = buildClaimPageViewModel(
      { ...face, claim_state: { ...face.claim_state, novelty: "contested" } },
      ORIGIN,
    );
    expect(novel.novelty?.standing).toBe("contested");
    expect(novel.novelty?.explanation).toContain("says nothing about, correctness");
    expect(novel.novelty?.searches).toEqual([]);
  });

  test("an unreadable review body never counts as a confirmation (asimposiumorg-iujg)", () => {
    const face = makeClaimFace();
    const vm = buildClaimPageViewModel(
      {
        ...face,
        items: [
          ...face.items,
          {
            kind: "claim-review" as const,
            id: "R-BROKEN",
            scope: "ledger" as const,
            untrusted: true as const,
            why_included: "public review",
            body: "not json {",
            neutralized: [] as { marker: "active-html"; count: number }[],
          },
        ],
      },
      ORIGIN,
    );
    expect(JSON.stringify(vm)).not.toContain("Independent confirmation R-BROKEN");
    expect(JSON.stringify(vm.timeline)).toContain("tier unknown");
    // Counted in no tier, and shown as unreadable (independent verification 4:
    // the old default and a verdict-only fallback both inflated tier1Count).
    expect(vm.tierExplainer.tier1Count).toBe(0);
    expect(vm.tierExplainer.tier2Count).toBe(0);
    expect(vm.tierExplainer.unreadableCount).toBe(1);
    // Where support is counted (a corroborated claim), the unreadable review
    // contributes nothing.
    const corroborated = buildClaimPageViewModel(
      {
        ...face,
        claim_state: { ...face.claim_state, disposition: "corroborated" },
        items: [
          ...face.items,
          {
            kind: "claim-review" as const,
            id: "R-BROKEN",
            scope: "ledger" as const,
            untrusted: true as const,
            why_included: "public review",
            body: "not json {",
            neutralized: [] as { marker: "active-html"; count: number }[],
          },
        ],
      },
      ORIGIN,
    );
    expect(corroborated.whyThisStatus.triggeringItems).toHaveLength(0);
    expect(corroborated.whyThisStatus.reasons.join(" ")).toContain("cause is unavailable");
  });

  test("novelty searches behind the standing are displayed, from counted reviews only", () => {
    const face = makeClaimFace();
    const review = (id: string, tier: string | undefined) => ({
      kind: "claim-review" as const,
      id,
      scope: "ledger" as const,
      untrusted: true as const,
      why_included: "public review",
      body: JSON.stringify({
        ...(tier === undefined ? {} : { tier }),
        verdict: "inform",
        novelty: {
          verdict: "new",
          searches: [{ source: "arXiv", searched_on: "2026-09-20", terms: ["even squares"] }],
        },
      }),
      neutralized: [] as { marker: "active-html"; count: number }[],
    });
    const vm = buildClaimPageViewModel(
      {
        ...face,
        claim_state: { ...face.claim_state, novelty: "new" },
        items: [...face.items, review("R-1", "T2"), review("R-2", "T0"), review("R-3", undefined)],
      },
      ORIGIN,
    );
    expect(vm.novelty?.searches).toEqual([
      {
        reviewId: "R-1",
        verdict: "new",
        source: "arXiv",
        searchedOn: "2026-09-20",
        terms: ["even squares"],
      },
    ]);
  });

  test("review excerpts keep the exact publication notice without trusting author-forged metadata", () => {
    const face = makeClaimFace();
    const notice = {
      category: "dual-use-boundary",
      action: "published-with-warning",
      notice: "screening-warning",
    } as const;
    const review = (id: string, seq: number) => ({
      kind: "claim-review" as const,
      id,
      scope: "ledger" as const,
      untrusted: true as const,
      why_included: "public review",
      body: JSON.stringify({
        tier: "T2", verdict: "inform", basis: `Review basis ${id}`, seq,
        screening_notice: notice,
        novelty: {
          verdict: "new",
          searches: [{ source: "arXiv", searched_on: "2026-09-20", terms: [id] }],
        },
      }),
      neutralized: [],
    });
    const vm = buildClaimPageViewModel({
      ...face,
      claim_state: { ...face.claim_state, novelty: "new" },
      items: [
        ...face.items,
        { ...review("R-1", 2), screening_notice: notice },
        review("R-2", 3),
      ],
    }, ORIGIN);
    expect(vm.novelty?.searches.find((item) => item.reviewId === "R-1")?.screeningNotice).toEqual(notice);
    expect(vm.timeline.find((item) => item.itemId === "R-1")?.screeningNotice).toEqual(notice);
    expect(vm.timeline.find((item) => item.itemId === "R-1")?.summary).toBe("Basis: Review basis R-1");
    expect(vm.novelty?.searches.find((item) => item.reviewId === "R-2")).not.toHaveProperty("screeningNotice");
    expect(vm.timeline.find((item) => item.itemId === "R-2")).not.toHaveProperty("screeningNotice");
  });

  test("Rule A4 doctrine commitment: no PROVED badge or truth claim is ever generated", () => {
    const dispositions = [
      "open",
      "corroborated",
      "strongly-supported",
      "disputed",
      "refuted",
      "withdrawn",
      "malformed",
    ] as const;

    for (const disposition of dispositions) {
      const face = makeClaimFace({
        claim_state: {
          claim_id: "C-TEST",
          version: 1,
          latest_version: 1,
          disposition,
          review_state: "unreviewed",
          directive_disclosure: disposition === "strongly-supported" ? "satisfied" : "missing",
          unchallenged: false,
          stale: false,
          recorded_refutation_attempts: 1,
          certified_artifact: true,
          legacy_reviews: 0,
        },
      });
      const vm = buildClaimPageViewModel(face, ORIGIN);
      const json = JSON.stringify(vm);

      // Verify absence of forbidden PROVED banners
      expect(json).not.toContain('"PROVED"');
      expect(json).not.toContain("PROVEN");
      expect(json).not.toContain("certified true");
    }
  });
});
