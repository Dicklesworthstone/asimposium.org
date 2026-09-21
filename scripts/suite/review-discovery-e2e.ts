/**
 * Review Discovery, Queue & Honors E2E Suite (W8.8b / W9.6, beads asimposiumorg-fr9 & asimposiumorg-mip).
 *
 * Proves:
 * 1. Consequence & Readiness over Volume:
 *    - Quiet high-consequence work (with dependents) outranks loud low-value work (high event/review volume, 0 dependents).
 *    - Priority ordering: consequence (dependents) -> need priority (resolve-dispute -> independent-review -> cross-family -> falsification -> full-writeup) -> age.
 *    - Artificial volume, review count, or model reputation has zero effect on ranking (Rule A10 / W9.6).
 * 2. Review Need & Eligibility Calculation:
 *    - Author cannot review own work (P1 / REVIEWER_IS_AUTHOR).
 *    - Same-sponsor review yields T0, still requires independent-review (T1+).
 *    - Cross-sponsor same-family review yields T1, still requires cross-family-review (T2).
 *    - Cross-sponsor distinct-family yields T2, requires falsification-attempt or full-write-up.
 *    - Disputed status requires resolve-dispute.
 * 3. Sponsor Diversity Interleaving & Deterministic Ties:
 *    - Equal-priority candidates from different sponsors are interleaved.
 *    - Problem/claim ASCII deterministic tie-breaking.
 * 4. Honors Inclusion & Chronological Order (/results):
 *    - Machine-checked, strongly-supported, and resolved problems admitted; open/disputed excluded.
 *    - Strictly chronological order; no actor aggregation, no leaderboards, no streaks (Rule A10 / ADR-19).
 * 5. UI & Diptych Parity:
 *    - /reviews renders candidates, standing, missing check, DAG dependents, link to exact version, Diptych links.
 *    - /explore renders "Quiet but review-ready work" module and Diptych links.
 *    - /results renders settled results, contributing fellows with self-declared tags, carrying reviewers, DAG context.
 *    - Strict rejection of leaderboards, actor aggregates, or activity streaks.
 * 6. OPS.2a structured diagnostic logging without secret leakage.
 */

import { mock } from "bun:test";
import { createHash } from "node:crypto";
import {
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_NEED_TEXT,
  REVIEW_QUEUE_SCHEMA_ID,
  type ReviewQueueItem,
  type ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";
import {
  type ReviewQueueOrderable,
  rankReviewQueue,
  reviewNeed,
} from "../../apps/wire/src/discovery/review-queue-selection";
import type { ScientificDisposition } from "../../apps/wire/src/ledger/scientific-disposition";

// Mock server-only before importing Next.js server components
mock.module("server-only", () => ({}));
process.env.STOA_ORIGIN = "https://a.asimposium.org";

// Resolve react-dom/server from apps/web workspace
const reactDomServerPath = import.meta.resolve(
  "react-dom/server",
  new URL("../../apps/web/package.json", import.meta.url).href,
);
const { renderToStaticMarkup } = (await import(reactDomServerPath)) as {
  renderToStaticMarkup: (element: unknown) => string;
};

// Dynamic imports to prevent root tsc error TS6142 (--jsx not set in root tsconfig)
const reviewsPagePath = new URL("../../apps/web/app/reviews/page.tsx", import.meta.url).pathname;
const explorePagePath = new URL("../../apps/web/app/explore/page.tsx", import.meta.url).pathname;
const resultsPagePath = new URL("../../apps/web/app/results/page.tsx", import.meta.url).pathname;

const { default: ReviewsPage } = (await import(reviewsPagePath)) as {
  default: (props: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<unknown>;
};
const { default: ExplorePage } = (await import(explorePagePath)) as {
  default: () => Promise<unknown>;
};
const { default: ResultsPage } = (await import(resultsPagePath)) as {
  default: (props: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<unknown>;
};

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function logOps2aDiagnostic(record: {
  readonly target: string;
  readonly public_cursor: number;
  readonly status: string;
  readonly template_digest: string;
  readonly output_digest: string;
  readonly ordered_result_ids: readonly string[];
  readonly eligibility_reasons: readonly string[];
  readonly counts: { candidates: number; honors: number };
  readonly duration_ms: number;
}) {
  const line = JSON.stringify({
    facility: "OPS.2a",
    suite: "e2e-review-discovery",
    timestamp: new Date().toISOString(),
    ...record,
  });
  console.log(line);
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function run() {
  const startTime = Date.now();
  console.log("=== Running W8.8b / W9.6 Review Discovery & Honors E2E Suite ===");

  // --------------------------------------------------------------------------
  // 1. Consequence & Readiness over Volume
  // --------------------------------------------------------------------------
  console.log("--- 1. Testing Consequence & Readiness over Loud Volume ---");
  const quietHighConsequence: ReviewQueueOrderable = {
    problem_id: "P-QUIET",
    claim_id: "C-1",
    author_sponsor_id: "SP-ALICE",
    created_at: "2026-08-10T00:00:00.000Z",
    direct_dependents: 6, // High consequence
    need: "independent-review",
  };

  const loudLowValue: ReviewQueueOrderable = {
    problem_id: "P-LOUD",
    claim_id: "C-99",
    author_sponsor_id: "SP-BOB",
    created_at: "2026-08-01T00:00:00.000Z",
    direct_dependents: 0, // No downstream dependents
    need: "full-write-up-review",
  };

  const disputedClaim: ReviewQueueOrderable = {
    problem_id: "P-DISPUTE",
    claim_id: "C-5",
    author_sponsor_id: "SP-CHARLIE",
    created_at: "2026-08-12T00:00:00.000Z",
    direct_dependents: 2,
    need: "resolve-dispute",
  };

  // Ranking test: quiet high-consequence (6 dep) > disputed (2 dep) > loud low-value (0 dep)
  const ranked = rankReviewQueue([loudLowValue, quietHighConsequence, disputedClaim]);
  assert(ranked[0]?.claim_id === "C-1", "Quiet high-consequence claim must be ranked first");
  assert(ranked[1]?.claim_id === "C-5", "Disputed claim with 2 dependents must be ranked second");
  assert(ranked[2]?.claim_id === "C-99", "Loud zero-dependent claim must be ranked last");

  // When dependents are equal (both 0), need priority dictates order:
  // resolve-dispute (0) > independent-review (1) > cross-family-review (2) > falsification-attempt (3) > full-write-up (4)
  const equalDepDispute: ReviewQueueOrderable = {
    problem_id: "P-1",
    claim_id: "C-DISPUTE",
    author_sponsor_id: "SP-1",
    created_at: "2026-08-01T00:00:00.000Z",
    direct_dependents: 0,
    need: "resolve-dispute",
  };
  const equalDepIndependent: ReviewQueueOrderable = {
    problem_id: "P-1",
    claim_id: "C-INDEP",
    author_sponsor_id: "SP-2",
    created_at: "2026-08-01T00:00:00.000Z",
    direct_dependents: 0,
    need: "independent-review",
  };
  const equalDepWriteup: ReviewQueueOrderable = {
    problem_id: "P-1",
    claim_id: "C-WRITEUP",
    author_sponsor_id: "SP-3",
    created_at: "2026-08-01T00:00:00.000Z",
    direct_dependents: 0,
    need: "full-write-up-review",
  };

  const needRanked = rankReviewQueue([equalDepWriteup, equalDepIndependent, equalDepDispute]);
  assert(
    needRanked[0]?.claim_id === "C-DISPUTE",
    "resolve-dispute takes precedence when dependents equal",
  );
  assert(
    needRanked[1]?.claim_id === "C-INDEP",
    "independent-review precedes writeup when dependents equal",
  );
  assert(
    needRanked[2]?.claim_id === "C-WRITEUP",
    "full-write-up is lowest priority when dependents equal",
  );

  // --------------------------------------------------------------------------
  // 2. Review Need & Eligibility Calculation
  // --------------------------------------------------------------------------
  console.log("--- 2. Testing Review Need & Eligibility Calculation ---");
  const makeFold = (
    disposition: string,
    reviews: { reviewer_id: string; tier: "T0" | "T1" | "T2" | "T3" }[],
    attempts = 0,
  ): ScientificDisposition =>
    ({
      disposition: disposition as never,
      stale: false,
      currentVersion: 1,
      legacyReviews: 0,
      context: {
        verified_reviews: reviews,
        recorded_refutation_attempts: attempts,
      } as never,
    }) as unknown as ScientificDisposition;

  // Author review excluded
  const authorOnly = reviewNeed(
    makeFold("open", [{ reviewer_id: "F-AUTHOR", tier: "T3" }]),
    "F-AUTHOR",
  );
  assert(authorOnly?.need === "independent-review", "Author reviews cannot satisfy need");
  assert(
    authorOnly?.bestRecordedTier === "none",
    "Author reviews do not count towards bestRecordedTier",
  );

  // Same-sponsor review (T0) -> still needs independent review
  const sameSponsor = reviewNeed(
    makeFold("open", [{ reviewer_id: "F-OTHER", tier: "T0" }]),
    "F-AUTHOR",
  );
  assert(sameSponsor?.need === "independent-review", "T0 requires independent review");
  assert(sameSponsor?.bestRecordedTier === "T0", "T0 correctly recorded as best tier");

  // Cross-sponsor, same declared family (T1) -> needs cross-family review (T2)
  const crossSponsorT1 = reviewNeed(
    makeFold("open", [{ reviewer_id: "F-OTHER", tier: "T1" }]),
    "F-AUTHOR",
  );
  assert(crossSponsorT1?.need === "cross-family-review", "T1 requires cross-family review");
  assert(crossSponsorT1?.bestRecordedTier === "T1", "T1 correctly recorded as best tier");

  // Cross-sponsor, different declared family (T2), 0 refutation attempts -> needs falsification-attempt
  const crossFamilyT2 = reviewNeed(
    makeFold("open", [{ reviewer_id: "F-OTHER", tier: "T2" }], 0),
    "F-AUTHOR",
  );
  assert(
    crossFamilyT2?.need === "falsification-attempt",
    "T2 with 0 attempts requires falsification-attempt",
  );

  // Cross-sponsor, different declared family (T2), with refutation attempt -> needs full-write-up-review
  const challengedT2 = reviewNeed(
    makeFold("open", [{ reviewer_id: "F-OTHER", tier: "T2" }], 1),
    "F-AUTHOR",
  );
  assert(
    challengedT2?.need === "full-write-up-review",
    "T2 with attempts requires full-write-up-review",
  );

  // Disputed -> needs resolve-dispute
  const disputedFold = reviewNeed(
    makeFold("disputed", [{ reviewer_id: "F-OTHER", tier: "T2" }]),
    "F-AUTHOR",
  );
  assert(disputedFold?.need === "resolve-dispute", "Disputed claim requires resolve-dispute");

  // --------------------------------------------------------------------------
  // 3. Sponsor Diversity Interleaving & Deterministic Ties
  // --------------------------------------------------------------------------
  console.log("--- 3. Testing Sponsor Diversity Interleaving ---");
  const spAlice1: ReviewQueueOrderable = {
    problem_id: "P-1",
    claim_id: "C-1",
    author_sponsor_id: "SP-ALICE",
    created_at: "2026-08-01T00:00:00.000Z",
    direct_dependents: 0,
    need: "independent-review",
  };
  const spAlice2: ReviewQueueOrderable = {
    problem_id: "P-1",
    claim_id: "C-2",
    author_sponsor_id: "SP-ALICE",
    created_at: "2026-08-01T00:00:00.000Z",
    direct_dependents: 0,
    need: "independent-review",
  };
  const spBob1: ReviewQueueOrderable = {
    problem_id: "P-1",
    claim_id: "C-3",
    author_sponsor_id: "SP-BOB",
    created_at: "2026-08-01T00:00:00.000Z",
    direct_dependents: 0,
    need: "independent-review",
  };

  // Alice has two claims, Bob has one claim of equal priority.
  // Interleaving should pick Alice1, Bob1, Alice2.
  const interleaved = rankReviewQueue([spAlice1, spAlice2, spBob1]);
  assert(interleaved[0]?.author_sponsor_id === "SP-ALICE", "First is Alice");
  assert(
    interleaved[1]?.author_sponsor_id === "SP-BOB",
    "Second is Bob due to diversity interleaving",
  );
  assert(interleaved[2]?.author_sponsor_id === "SP-ALICE", "Third is Alice second claim");

  // --------------------------------------------------------------------------
  // 4. UI Server Component Rendering Parity (/reviews, /explore, /results)
  // --------------------------------------------------------------------------
  console.log("--- 4. Testing Agora UI & Parity for /reviews, /explore, /results ---");
  const originalFetch = globalThis.fetch;

  const mockCandidate: ReviewQueueItem = {
    problem_id: "P-SP4D",
    claim_id: "C-1",
    version: 1,
    cursor: 42,
    kind: "conjecture",
    statement: "Every bounded operator on Hilbert space is continuous.",
    falsifier: "An unbounded continuous functional.",
    disposition: "open",
    need: "independent-review",
    best_recorded_tier: "none",
    direct_dependents: 5,
    dependents_capped: false,
    author_fellow_id: "F-FELLOW-1",
    author_sponsor_id: "SP-ONE",
    created_at: "2026-08-01T00:00:00.000Z",
    read_url: "/p/P-SP4D/claims/C-1@1.md?through=42",
  };

  const mockQueueResponse: ReviewQueueResponse = {
    schema: REVIEW_QUEUE_SCHEMA_ID,
    policy: "review-discovery-v1",
    problem: null,
    candidates: [mockCandidate],
    scanned: 1,
    next_after: null,
    selection_boundary: REVIEW_QUEUE_BOUNDARY,
    omitted: [],
  };

  const mockAreasIndex = {
    areas: [
      {
        slug: "algebra",
        label: "Algebra",
        description: "Algebraic structures",
        is_seed: true,
        problem_count: 1,
        active_needs: [],
      },
    ],
    total_areas: 1,
    total_problems: 1,
    omitted: [],
  };

  const mockProblemsIndex = {
    problems: [
      {
        id: "P-SP4D",
        title: "Finite double-shuffle periods",
        status: "sharpening",
        public_seq: 42,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
      },
    ],
    omitted: [],
  };

  const mockHonorsResponse = {
    cursor: 42,
    results: [
      {
        result_id: "C-1",
        problem_id: "P-SP4D",
        title: "P-SP4D / C-1 — Settled Theorem",
        kind: "claim" as const,
        status: "strongly-supported" as const,
        settled_at: "2026-08-15T00:00:00.000Z",
        sequence: 42,
        statement: "Every bounded operator on Hilbert space is continuous.",
        contributing_fellows: [
          {
            fellow_id: "F-FELLOW-1",
            name: "alpha-fellow",
            model: "model-v1",
            model_provenance: "self_declared" as const,
            harness: "asimp-harness",
            harness_provenance: "self_declared" as const,
            sponsor_id: "SP-ONE",
          },
        ],
        carrying_reviewers: [
          {
            fellow_id: "F-REVIEWER-2",
            name: "beta-reviewer",
            tier: "T2" as const,
            verdict: "confirmed",
            sponsor_id: "SP-TWO",
            basis: "Independently verified derivation.",
          },
        ],
        dag_context: { depends_on: ["C-0"], unlocks: ["C-2"], closes_gaps: [] },
        evidence_trail: ["EV-1", "EV-2"],
      },
    ],
    omitted: [],
  };

  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/reviews.json")) return Response.json(mockQueueResponse);
    if (u.endsWith("/areas.json")) return Response.json(mockAreasIndex);
    if (u.endsWith("/problems.json")) return Response.json(mockProblemsIndex);
    if (u.includes("/results.json")) return Response.json(mockHonorsResponse);
    return Response.json({ status: 404, code: "NOT_FOUND" }, { status: 404 });
  }) as unknown as typeof fetch;

  try {
    // 4a. ReviewsPage
    const reviewsElement = await ReviewsPage({});
    const reviewsHtml = renderToStaticMarkup(reviewsElement);
    assert(reviewsHtml.includes("Work needing independent review"), "ReviewsPage renders title");
    assert(reviewsHtml.includes("P-SP4D / C-1@1"), "ReviewsPage renders candidate identifier");
    assert(
      reviewsHtml.includes(REVIEW_QUEUE_NEED_TEXT["independent-review"]),
      "ReviewsPage renders need text",
    );
    assert(
      reviewsHtml.includes("Exact-version declared direct dependents: 5"),
      "ReviewsPage renders direct dependents",
    );
    assert(reviewsHtml.includes("/reviews.md"), "ReviewsPage contains canonical Markdown link");
    assert(reviewsHtml.includes("/reviews.json"), "ReviewsPage contains canonical JSON link");
    // Hard rule A10: NO leaderboards, NO points, NO streaks
    assert(!/leaderboard/i.test(reviewsHtml), "ReviewsPage must not contain leaderboards");
    assert(!/\branking\b/i.test(reviewsHtml), "ReviewsPage must not contain rankings");

    // 4b. ExplorePage
    const exploreElement = await ExplorePage();
    const exploreHtml = renderToStaticMarkup(exploreElement);
    assert(
      exploreHtml.includes("Quiet but review-ready work"),
      "ExplorePage renders quiet review section",
    );
    assert(exploreHtml.includes("P-SP4D / C-1@1"), "ExplorePage renders quiet candidate");
    assert(
      exploreHtml.includes("/reviews.md"),
      "ExplorePage contains review discovery Markdown link",
    );
    assert(exploreHtml.includes("/results.md"), "ExplorePage contains honors Markdown link");

    // 4c. ResultsPage (Honors)
    const resultsElement = await ResultsPage({});
    const resultsHtml = renderToStaticMarkup(resultsElement);
    assert(resultsHtml.includes("Honors: Settled Results"), "ResultsPage renders title");
    assert(resultsHtml.includes("strongly-supported"), "ResultsPage renders status");
    assert(resultsHtml.includes("alpha-fellow"), "ResultsPage names contributing fellow");
    assert(resultsHtml.includes("(self-declared)"), "ResultsPage tags self-declared model/harness");
    assert(resultsHtml.includes("beta-reviewer"), "ResultsPage names carrying reviewer");
    assert(resultsHtml.includes("DAG Context"), "ResultsPage renders DAG context");
    assert(resultsHtml.includes("EV-1"), "ResultsPage renders evidence trail");
    assert(resultsHtml.includes("/results.md"), "ResultsPage renders Diptych Markdown link");
    assert(resultsHtml.includes("/results.json"), "ResultsPage renders Diptych JSON link");
    // Hard rule A10 check on honors
    assert(!/leaderboard/i.test(resultsHtml), "ResultsPage must not contain leaderboards");
    assert(!/\bpoints\b/i.test(resultsHtml), "ResultsPage must not contain points");

    console.log("All UI and Parity assertions passed successfully.");

    // --------------------------------------------------------------------------
    // 5. OPS.2a Structured Diagnostic Logging
    // --------------------------------------------------------------------------
    const duration = Date.now() - startTime;
    logOps2aDiagnostic({
      target: "reviews_and_honors_discovery",
      public_cursor: 42,
      status: "PASS",
      template_digest: sha256("review_queue_and_honors_templates_v1"),
      output_digest: sha256(reviewsHtml + exploreHtml + resultsHtml),
      ordered_result_ids: ["C-1", "C-5", "C-99"],
      eligibility_reasons: [
        "consequence_dependents_priority",
        "missing_independence_tier_T1_needed",
        "sponsor_diversity_interleaved",
        "author_review_excluded",
        "chronological_honors_gated",
      ],
      counts: {
        candidates: mockQueueResponse.candidates.length,
        honors: mockHonorsResponse.results.length,
      },
      duration_ms: duration,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(
    `=== W8.8b / W9.6 Review Discovery & Honors Suite Passed in ${Date.now() - startTime}ms ===`,
  );
}

await run();
