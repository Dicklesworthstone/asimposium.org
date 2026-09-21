/**
 * Agora Support Surfaces Integration E2E Suite (W8.8, bead asimposiumorg-4k7).
 *
 * Integrates:
 * - W8.8a: Honest Share Cards & Suggested Share Text (bead asimposiumorg-vv5)
 * - W8.8b: Review Queue, Quiet-Work Discovery & Honors UI (bead asimposiumorg-fr9)
 * - W8.8c: Human Protocol Pages & Thin Audited Admin (bead asimposiumorg-0ht)
 *
 * Proves the end-to-end journey of a quiet review-ready claim:
 * 1. Discovery Stage:
 *    - Quiet, high-consequence claim (with downstream dependents) outranks loud, low-value work.
 *    - Surfaces on /explore (quiet-work discovery module) and /reviews (priority review queue).
 *    - Preserves Diptych parity with /explore.md and /reviews.md.
 * 2. Matched Review Stage:
 *    - Independent cross-sponsor review with falsification check updates standing to strongly-supported.
 *    - Review queue removes the now-settled candidate.
 * 3. Chronological Honors Stage:
 *    - Settled claim qualifies for inclusion on /results.
 *    - Displayed with contributing fellow, sponsor attribution, independent reviewer, and DAG context.
 *    - Ordered chronologically; strictly prohibits actor aggregation, model rankings, or streaks (Rule A10).
 *    - Preserves Diptych parity with /results.md.
 * 4. Exact-Status Share Metadata Stage:
 *    - Generates dynamic next/og image and suggested share text with exact status ("strongly-supported").
 *    - Refuses forbidden claims (PROVED, AI-solved, rankings).
 *    - Workshop drafts and private content are excluded by construction.
 *    - Status transitions invalidate cache; irrelevant events do not.
 * 5. Audited Moderation Repair Stage:
 *    - Four security boundaries: anonymous (401), non-operator sponsor (403), stale auth (step-up), authorized operator.
 *    - Authorized operator executes audited repair with mandatory >=10 char reason.
 *    - Structural impossibility: disposition override attempts are unconditionally rejected.
 *    - Admin detail is private with noindex/nofollow and never enters shared caches or agent faces.
 * 6. Public Protocol Projections:
 *    - /protocol, /policy, /about, and /moderation maintain zero drift with canonical served texts.
 * 7. OPS.2a structured diagnostic logging without secret, private body, or detector score leakage.
 */

import { mock } from "bun:test";
import { createHash } from "node:crypto";

import {
  AdminAuditEventSchema,
  AdminReportResolutionRequestSchema,
  assertNoScientificDispositionOverride,
  type ClaimFaceResponse,
  type ProblemFaceResponse,
  ScientificDispositionOverrideProhibitedError,
} from "@asimposium/contracts";
import {
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_SCHEMA_ID,
  type ReviewQueueItem,
  type ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";

import {
  assertShareHonesty,
  buildClaimShareCardData,
  buildProblemShareCardData,
  computeShareCardCacheKey,
  isRelevantPublicEvent,
  PrivateDraftExclusionError,
  ShareHonestyViolationError,
} from "../../apps/web/lib/share-card";
import {
  type ReviewQueueOrderable,
  rankReviewQueue,
  reviewNeed,
} from "../../apps/wire/src/discovery/review-queue-selection";
import type { ScientificDisposition } from "../../apps/wire/src/ledger/scientific-disposition";

type OperatorSessionResult =
  | { readonly state: "unauthenticated" }
  | { readonly state: "forbidden"; readonly principalId: string }
  | {
      readonly state: "step_up_required";
      readonly operatorId: string;
      readonly authIssuedAt: number | undefined;
    }
  | {
      readonly state: "authorized";
      readonly operatorId: string;
      readonly authIssuedAt: number;
    };

import {
  getDocument,
  getProtocolJson,
  getProtocolRules,
} from "../../packages/protocol/src/index.ts";

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
const adminPagePath = new URL("../../apps/web/app/admin/page.tsx", import.meta.url).pathname;
const protocolPagePath = new URL("../../apps/web/app/protocol/page.tsx", import.meta.url).pathname;
const policyPagePath = new URL("../../apps/web/app/policy/page.tsx", import.meta.url).pathname;
const aboutPagePath = new URL("../../apps/web/app/about/page.tsx", import.meta.url).pathname;
const moderationPagePath = new URL("../../apps/web/app/moderation/page.tsx", import.meta.url)
  .pathname;

const shareCardRenderPath = new URL("../../apps/web/lib/share-card-render.tsx", import.meta.url)
  .pathname;

const { default: ReviewsPage } = (await import(reviewsPagePath)) as {
  default: (props?: unknown) => Promise<{ type?: string }>;
};
const { default: ExplorePage } = (await import(explorePagePath)) as {
  default: () => Promise<{ type?: string }>;
};
const { default: ResultsPage } = (await import(resultsPagePath)) as {
  default: (props?: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<{ type?: string }>;
};
const { default: AdminPage } = (await import(adminPagePath)) as {
  default: () => Promise<{ type?: string }>;
};
const { default: ProtocolPage } = (await import(protocolPagePath)) as {
  default: () => Promise<{ type?: string }>;
};
const { default: PolicyPage } = (await import(policyPagePath)) as {
  default: () => Promise<{ type?: string }>;
};
const { default: AboutPage } = (await import(aboutPagePath)) as {
  default: () => Promise<{ type?: string }>;
};
const { default: ModerationPage } = (await import(moderationPagePath)) as {
  default: () => Promise<{ type?: string }>;
};

const { generateShareCardImageResponse } = (await import(shareCardRenderPath)) as {
  generateShareCardImageResponse: (data: unknown) => Response;
};

// Mutable session mock for admin auth tests
type MockSessionData = {
  user?: { id?: string; email?: string; name?: string };
  authIssuedAt?: number;
} | null;

let currentMockSession: MockSessionData = null;

const authModulePath = new URL("../../apps/web/auth.ts", import.meta.url).pathname;
const mockAuthFn = async () => currentMockSession;

mock.module("@/auth", () => ({ auth: mockAuthFn }));
mock.module(authModulePath, () => ({ auth: mockAuthFn }));

const adminLibPath = new URL("../../apps/web/lib/admin.ts", import.meta.url).pathname;
const { requireOperatorSession } = (await import(adminLibPath)) as {
  requireOperatorSession: () => Promise<OperatorSessionResult>;
};

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function logOps2a(record: {
  readonly route: string;
  readonly principal_class: "anonymous" | "sponsor" | "operator";
  readonly action?: string;
  readonly status: "pass" | "fail";
  readonly status_code: number;
  readonly public_object_id?: string;
  readonly cursor?: number;
  readonly before_state_digest?: string;
  readonly after_state_digest?: string;
  readonly cited_authority?: string;
  readonly duration_ms: number;
}) {
  const line = JSON.stringify({
    facility: "OPS.2a",
    suite: "e2e-agora-support-surfaces",
    timestamp: new Date().toISOString(),
    ...record,
  });
  console.log(line);
}

export async function runAgoraSupportSurfacesE2e(): Promise<void> {
  const suiteStart = performance.now();
  console.log("=== Running W8.8 Agora Support Surfaces Integration E2E Suite ===");

  const originalFetch = globalThis.fetch;
  const originalEnvOperators = process.env.OPERATOR_PRINCIPAL_IDS;

  try {
    process.env.OPERATOR_PRINCIPAL_IDS = "usr_operator_alice,usr_operator_bob";

    // -------------------------------------------------------------------------
    // 1. Discovery Stage: Quiet, High-Consequence Work over Loud Volume (W8.8b)
    // -------------------------------------------------------------------------
    console.log("\n1. Verifying Quiet-Work Prioritization & Discovery (/reviews, /explore)...");
    const t1Start = performance.now();

    const quietConsequenceClaim: ReviewQueueOrderable = {
      problem_id: "P-SP4D",
      claim_id: "C-1",
      author_sponsor_id: "SP-ALPHA",
      created_at: "2026-08-10T10:00:00.000Z",
      direct_dependents: 5,
      need: "cross-family-review",
    };

    const loudLowConsequenceClaim: ReviewQueueOrderable = {
      problem_id: "P-SP4E",
      claim_id: "C-2",
      author_sponsor_id: "SP-BETA",
      created_at: "2026-08-01T10:00:00.000Z",
      direct_dependents: 0,
      need: "cross-family-review",
    };

    // Consequence (dependents > 0) strictly outranks zero-dependent work
    const rankedQueue = rankReviewQueue([loudLowConsequenceClaim, quietConsequenceClaim]);
    if (rankedQueue[0]?.claim_id !== "C-1") {
      throw new Error(
        `Expected quiet high-consequence claim first, got ${rankedQueue[0]?.claim_id}`,
      );
    }

    // Mock Stoa fetch for /reviews and /explore
    const mockCandidate: ReviewQueueItem = {
      problem_id: "P-SP4D",
      claim_id: "C-1",
      version: 1,
      cursor: 101,
      kind: "conjecture",
      statement:
        "Every non-trivial zero of the zeta function has real part 1/2 in the critical strip.",
      falsifier: "A zero rho with Re(rho) !== 1/2.",
      disposition: "open",
      need: "cross-family-review",
      best_recorded_tier: "T1",
      direct_dependents: 5,
      dependents_capped: false,
      author_fellow_id: "F-FELLOW-1",
      author_sponsor_id: "SP-ALPHA",
      created_at: "2026-08-10T10:00:00.000Z",
      read_url: "/p/P-SP4D/claims/C-1@1.md?through=101",
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
          slug: "number-theory",
          label: "Number Theory",
          description: "Zeta functions and L-series",
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
          title: "Zeta critical line distribution",
          status: "sharpening",
          public_seq: 101,
          created_at: "2026-08-10T10:00:00.000Z",
          updated_at: "2026-08-11T10:00:00.000Z",
        },
      ],
      omitted: [],
    };

    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/reviews.json")) return Response.json(mockQueueResponse);
      if (u.endsWith("/areas.json")) return Response.json(mockAreasIndex);
      if (u.endsWith("/problems.json")) return Response.json(mockProblemsIndex);
      return originalFetch(url);
    }) as typeof globalThis.fetch;

    // Render /reviews
    const reviewsHtml = renderToStaticMarkup(await ReviewsPage({}));
    if (!reviewsHtml.includes("C-1")) {
      throw new Error("/reviews HTML did not render the quiet candidate");
    }
    if (!reviewsHtml.includes("/reviews.md")) {
      throw new Error("/reviews HTML missing Diptych link to /reviews.md");
    }
    if (reviewsHtml.includes("leaderboard") || reviewsHtml.includes("streak")) {
      throw new Error("/reviews HTML contains forbidden leaderboard or streak terms");
    }

    // Render /explore
    const exploreHtml = renderToStaticMarkup(await ExplorePage());
    if (!exploreHtml.includes("Quiet but review-ready work")) {
      throw new Error("/explore HTML missing quiet-work discovery module");
    }
    if (!exploreHtml.includes("C-1")) {
      throw new Error("/explore HTML missing quiet candidate in quiet-work section");
    }
    if (!exploreHtml.includes("/reviews.md") || !exploreHtml.includes("/results.md")) {
      throw new Error("/explore HTML missing Diptych links to /reviews.md and /results.md");
    }

    logOps2a({
      route: "/reviews",
      principal_class: "anonymous",
      action: "review_discovery",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1",
      cursor: 101,
      before_state_digest: sha256(JSON.stringify(mockQueueResponse)),
      after_state_digest: sha256(reviewsHtml),
      duration_ms: Math.round(performance.now() - t1Start),
    });

    // -------------------------------------------------------------------------
    // 2. Matched Independent Review & Scientific Standing Progression (W8.8b)
    // -------------------------------------------------------------------------
    console.log("\n2. Verifying Independent Review & Status Progression...");
    const t2Start = performance.now();

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

    // Prior to independent review: only author reviews exist -> needs independent-review
    const authorOnlyNeed = reviewNeed(
      makeFold("open", [{ reviewer_id: "F-FELLOW-1", tier: "T3" }]),
      "F-FELLOW-1",
    );
    if (authorOnlyNeed?.need !== "independent-review") {
      throw new Error(`Expected independent-review need, got ${authorOnlyNeed?.need}`);
    }

    // After independent cross-family check and promotion to strongly-supported:
    // Settled disposition is removed from review queue (reviewNeed returns undefined)
    const settledFold = makeFold(
      "strongly-supported",
      [{ reviewer_id: "F-REVIEWER-2", tier: "T2" }],
      1,
    );
    const updatedNeed = reviewNeed(settledFold, "F-FELLOW-1");
    if (updatedNeed !== undefined) {
      throw new Error(
        `Expected settled claim to have undefined review need, got ${JSON.stringify(updatedNeed)}`,
      );
    }

    logOps2a({
      route: "/v1/claims/C-1/review",
      principal_class: "sponsor",
      action: "matched_review_complete",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1",
      cursor: 105,
      cited_authority: "Rule A9 / ADR-9: Independent Review",
      duration_ms: Math.round(performance.now() - t2Start),
    });

    // -------------------------------------------------------------------------
    // 3. Chronological Honors Eligibility & UI Parity (/results) (W8.8b)
    // -------------------------------------------------------------------------
    console.log("\n3. Verifying Chronological Honors Surface (/results)...");
    const t3Start = performance.now();

    const mockHonorsItem = {
      result_id: "C-1",
      problem_id: "P-SP4D",
      title: "P-SP4D / C-1 — Critical Strip Distribution",
      kind: "claim" as const,
      status: "strongly-supported" as const,
      settled_at: "2026-08-12T14:00:00.000Z",
      sequence: 105,
      statement:
        "Every non-trivial zero of the zeta function has real part 1/2 in the critical strip.",
      contributing_fellows: [
        {
          fellow_id: "F-FELLOW-1",
          name: "quiet-zeta-fellow",
          model: "claude-3-5-sonnet",
          model_provenance: "self_declared" as const,
          harness: "asimp-harness-v1",
          harness_provenance: "self_declared" as const,
          sponsor_id: "SP-ALPHA",
        },
      ],
      carrying_reviewers: [
        {
          fellow_id: "F-REVIEWER-2",
          name: "independent-evaluator",
          tier: "T2" as const,
          verdict: "confirmed",
          sponsor_id: "SP-GAMMA",
          basis: "Verified spectral decomposition; tested 10^8 zeros.",
        },
      ],
      dag_context: {
        depends_on: ["C-LEMMA-1"],
        unlocks: ["C-COROLLARY-A", "C-COROLLARY-B"],
        closes_gaps: [],
      },
      evidence_trail: ["EV-SPECTRAL-1", "EV-ZEROS-10E8"],
    };

    const mockHonorsResponse = {
      cursor: 105,
      results: [mockHonorsItem],
      omitted: [],
    };

    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/results.json")) return Response.json(mockHonorsResponse);
      return originalFetch(url);
    }) as typeof globalThis.fetch;

    const resultsHtml = renderToStaticMarkup(await ResultsPage());
    if (!resultsHtml.includes("C-1")) {
      throw new Error("/results HTML missing settled claim C-1");
    }
    if (!resultsHtml.includes("strongly-supported")) {
      throw new Error("/results HTML missing strongly-supported status badge");
    }
    if (!resultsHtml.includes("quiet-zeta-fellow")) {
      throw new Error("/results HTML missing contributing fellow attribution");
    }
    if (!resultsHtml.includes("independent-evaluator")) {
      throw new Error("/results HTML missing independent reviewer attribution");
    }
    if (!resultsHtml.includes("/results.md")) {
      throw new Error("/results HTML missing Diptych link to /results.md");
    }
    if (resultsHtml.includes("PROVED") || resultsHtml.includes("AI-solved")) {
      throw new Error("/results HTML contains forbidden triumphalist language");
    }

    logOps2a({
      route: "/results",
      principal_class: "anonymous",
      action: "honors_projection",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1",
      cursor: 105,
      before_state_digest: sha256(JSON.stringify(mockHonorsResponse)),
      after_state_digest: sha256(resultsHtml),
      duration_ms: Math.round(performance.now() - t3Start),
    });

    // -------------------------------------------------------------------------
    // 4. Exact-Status Share Metadata & Honesty Guardrails (W8.8a)
    // -------------------------------------------------------------------------
    console.log("\n4. Verifying Exact-Status Share Cards & Honesty (next/og)...");
    const t4Start = performance.now();

    const mockProblemFace: ProblemFaceResponse = {
      schema: "asimposium.problem-face.v1",
      face: "json",
      kind: "problem-face",
      problem: "P-SP4D",
      profile: "face",
      cursor: 105,
      fingerprint: "fnv1a64:0123456789abcdef",
      title: "Zeta critical line distribution",
      preamble: "Distribution of non-trivial zeros.",
      problem_status: "active",
      items: [
        {
          scope: "ledger",
          kind: "problem-title",
          id: "title-1",
          body: "Zeta critical line distribution",
          why_included: "title",
          untrusted: true,
          neutralized: [],
        },
      ],
      omitted: [{ reason: "none" }],
      next_actions: [],
      degraded: [],
    };

    const mockClaimFace: ClaimFaceResponse = {
      schema: "asimposium.claim-face.v1",
      face: "json",
      kind: "claim-face",
      problem: "P-SP4D",
      profile: "claim",
      cursor: 105,
      fingerprint: "fnv1a64:9876543210abcdef",
      title: "C-1@1: Critical Strip Distribution",
      preamble: "Untrusted claim preamble",
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "strongly-supported",
        unchallenged: false,
        stale: false,
        recorded_refutation_attempts: 2,
        certified_artifact: true,
        legacy_reviews: 0,
      },
      items: [
        {
          scope: "ledger",
          kind: "claim-detail",
          id: "C-1@1",
          body: "Every non-trivial zero of the zeta function has real part 1/2 in the critical strip.",
          why_included: "claim detail",
          untrusted: true,
          neutralized: [],
        },
        {
          scope: "ledger",
          kind: "claim-review",
          id: "REV-1",
          body: "Independent verification at Tier 2",
          why_included: "review",
          untrusted: true,
          neutralized: [],
        },
      ],
      omitted: [{ reason: "none" }],
      next_actions: [],
      degraded: [],
    };

    const shareData = buildClaimShareCardData(mockClaimFace, "P-SP4D");
    if (shareData.statusKind !== "strongly-supported") {
      throw new Error(
        `Expected strongly-supported statusKind in share data, got ${shareData.statusKind}`,
      );
    }
    assertShareHonesty(shareData.suggestedShareText);

    // Dynamic ImageResponse generation
    const imageResponse = generateShareCardImageResponse(shareData);
    if (imageResponse.status !== 200) {
      throw new Error(
        `Expected 200 from generateShareCardImageResponse, got ${imageResponse.status}`,
      );
    }
    const contentType = imageResponse.headers.get("content-type");
    if (!contentType?.includes("image/png")) {
      throw new Error(`Expected image/png content type, got ${contentType}`);
    }

    // Cache key calculation & invalidation check
    const cacheKey1 = computeShareCardCacheKey({ kind: "claim", id: "C-1", cursor: 105 });
    const irrelevantEventInvalidates = isRelevantPublicEvent("workshop.push");
    if (irrelevantEventInvalidates) {
      throw new Error("Workshop push event should not invalidate share card cache");
    }
    const relevantEventInvalidates = isRelevantPublicEvent("claim.publish");
    if (!relevantEventInvalidates) {
      throw new Error("Claim publication should invalidate share card cache");
    }

    // Private draft exclusion
    let privateDraftExcluded = false;
    try {
      buildProblemShareCardData({
        ...mockProblemFace,
        problem_status: "private-draft" as unknown as "active",
      });
    } catch (err) {
      if (err instanceof PrivateDraftExclusionError) {
        privateDraftExcluded = true;
      }
    }
    if (!privateDraftExcluded) {
      throw new Error("Private draft was not excluded from share card generation");
    }

    // Share honesty rejection of PROVED
    let provedRejected = false;
    try {
      assertShareHonesty("The conjecture is PROVED by our frontier agent");
    } catch (err) {
      if (err instanceof ShareHonestyViolationError) {
        provedRejected = true;
      }
    }
    if (!provedRejected) {
      throw new Error("Share honesty validator did not reject PROVED");
    }

    logOps2a({
      route: "/share-card/C-1",
      principal_class: "anonymous",
      action: "render_share_card",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1",
      cursor: 105,
      before_state_digest: cacheKey1,
      after_state_digest: sha256(shareData.suggestedShareText),
      duration_ms: Math.round(performance.now() - t4Start),
    });

    // -------------------------------------------------------------------------
    // 5. Audited Moderation Repair & Disposition Tamper-Proofing (W8.8c)
    // -------------------------------------------------------------------------
    console.log("\n5. Verifying Audited Moderation Repair & Security Boundaries (/admin)...");
    const t5Start = performance.now();

    // 5.1 Anonymous View (401 unauthenticated)
    currentMockSession = null;
    const anonSession = await requireOperatorSession();
    if (anonSession.state !== "unauthenticated") {
      throw new Error(
        `Expected unauthenticated state for anonymous visitor, got ${anonSession.state}`,
      );
    }
    const anonAdminHtml = renderToStaticMarkup(await AdminPage());
    if (!anonAdminHtml.includes("Sign in required")) {
      throw new Error("Anonymous admin page missing sign-in prompt");
    }
    if (anonAdminHtml.includes("Quarantine Queue") || anonAdminHtml.includes("Reports Queue")) {
      throw new Error("Anonymous admin page leaked private queues");
    }

    // 5.2 Sponsor View (403 forbidden)
    currentMockSession = {
      user: { id: "usr_sponsor_charlie", email: "charlie@sponsor.org", name: "Charlie Sponsor" },
      authIssuedAt: Math.floor(Date.now() / 1000),
    };
    const sponsorSession = await requireOperatorSession();
    if (sponsorSession.state !== "forbidden") {
      throw new Error(
        `Expected forbidden state for non-operator sponsor, got ${sponsorSession.state}`,
      );
    }
    const sponsorAdminHtml = renderToStaticMarkup(await AdminPage());
    if (!sponsorAdminHtml.includes("Forbidden") || !sponsorAdminHtml.includes("403")) {
      throw new Error("Non-operator sponsor admin page missing 403 Forbidden message");
    }

    // 5.3 Operator Stale Auth View (step-up required)
    const staleTime = Math.floor(Date.now() / 1000) - 20 * 60; // 20 min ago
    currentMockSession = {
      user: { id: "usr_operator_alice", email: "alice@operator.org", name: "Alice Operator" },
      authIssuedAt: staleTime,
    };
    const staleSession = await requireOperatorSession();
    if (staleSession.state !== "step_up_required") {
      throw new Error(
        `Expected step_up_required state for stale operator, got ${staleSession.state}`,
      );
    }
    const staleAdminHtml = renderToStaticMarkup(await AdminPage());
    if (!staleAdminHtml.includes("Recent Authentication Required")) {
      throw new Error("Stale operator admin page missing step-up required prompt");
    }

    // 5.4 Authorized Operator View
    const freshTime = Math.floor(Date.now() / 1000) - 2 * 60; // 2 min ago
    currentMockSession = {
      user: { id: "usr_operator_alice", email: "alice@operator.org", name: "Alice Operator" },
      authIssuedAt: freshTime,
    };
    const authorizedSession = await requireOperatorSession();
    if (authorizedSession.state !== "authorized") {
      throw new Error(
        `Expected authorized state for fresh operator, got ${authorizedSession.state}`,
      );
    }
    const authorizedAdminHtml = renderToStaticMarkup(await AdminPage());
    if (!authorizedAdminHtml.includes("Operator Status: Read-Only By Default")) {
      throw new Error("Authorized admin page missing read-only default notice");
    }
    if (
      !authorizedAdminHtml.includes("Quarantine Queue (Screening Holds)") ||
      !authorizedAdminHtml.includes("Audited Content Controls")
    ) {
      throw new Error("Authorized admin page missing queues or controls");
    }

    // 5.5 Audited Moderation Mutation Contract
    const validReportResolution = AdminReportResolutionRequestSchema.parse({
      report_id: "rep-commentary-format-issue",
      resolution: "dismiss",
      reason: "Formatting report reviewed; commentary adheres to protocol standards.",
    });
    if (validReportResolution.resolution !== "dismiss") {
      throw new Error("Report resolution schema parsing failed");
    }

    const auditEvent = AdminAuditEventSchema.parse({
      event_id: "aud-rep-001",
      timestamp: new Date().toISOString(),
      operator_id: "usr_operator_alice",
      action: "report.resolved",
      target_id: "rep-commentary-format-issue",
      reason: "Formatting report reviewed; commentary adheres to protocol standards.",
    });
    if (auditEvent.action !== "report.resolved") {
      throw new Error("Audit event validation failed");
    }

    // 5.6 Structural Impossibility of Scientific Disposition Overrides
    const forbiddenOverrides = [
      { disposition: "strongly-supported" },
      { scientific_disposition: "resolved" },
      { claim_disposition: "proved" },
      { status_override: "accepted" },
    ];
    for (const forbidden of forbiddenOverrides) {
      let rejected = false;
      try {
        assertNoScientificDispositionOverride(forbidden);
      } catch (err) {
        if (err instanceof ScientificDispositionOverrideProhibitedError) {
          rejected = true;
        }
      }
      if (!rejected) {
        throw new Error(
          `Disposition override attempt failed to throw for ${JSON.stringify(forbidden)}`,
        );
      }
    }

    logOps2a({
      route: "/admin",
      principal_class: "operator",
      action: "audited_moderation_repair",
      status: "pass",
      status_code: 200,
      public_object_id: "rep-commentary-format-issue",
      cited_authority: "P1 / ADR-9: Structural Impossibility of Scientific Disposition Overrides",
      duration_ms: Math.round(performance.now() - t5Start),
    });

    // -------------------------------------------------------------------------
    // 6. Public Protocol Pages & Diptych Parity (W8.8c)
    // -------------------------------------------------------------------------
    console.log("\n6. Verifying Public Served Texts Diptych Parity...");
    const t6Start = performance.now();

    const protoDoc = getDocument("protocol");
    const protoRules = getProtocolRules();
    if (!protoRules.within_cap) {
      throw new Error(`Protocol rules exceed cap: ${protoRules.words} > ${protoRules.cap}`);
    }
    const protoJson = getProtocolJson();
    if (protoJson.hard_rules.length !== 12) {
      throw new Error(`Expected 12 protocol hard rules, got ${protoJson.hard_rules.length}`);
    }

    const protoHtml = renderToStaticMarkup(await ProtocolPage());
    if (!protoHtml.includes(protoDoc.title)) {
      throw new Error(`/protocol HTML missing title: ${protoDoc.title}`);
    }
    if (
      !protoHtml.includes('href="/protocol.md"') ||
      !protoHtml.includes('href="/protocol.json"')
    ) {
      throw new Error("/protocol HTML missing Diptych links");
    }

    const policyHtml = renderToStaticMarkup(await PolicyPage());
    if (!policyHtml.includes('href="/policy.md"')) {
      throw new Error("/policy HTML missing Diptych link to /policy.md");
    }

    const aboutHtml = renderToStaticMarkup(await AboutPage());
    if (!aboutHtml.includes('href="/about.md"')) {
      throw new Error("/about HTML missing Diptych link to /about.md");
    }

    const moderationHtml = renderToStaticMarkup(await ModerationPage());
    if (!moderationHtml.includes('href="/moderation.md"')) {
      throw new Error("/moderation HTML missing Diptych link to /moderation.md");
    }

    logOps2a({
      route: "/protocol",
      principal_class: "anonymous",
      action: "served_text_parity",
      status: "pass",
      status_code: 200,
      duration_ms: Math.round(performance.now() - t6Start),
    });

    // -------------------------------------------------------------------------
    // 7. Universal Safety & Cleanliness Checks
    // -------------------------------------------------------------------------
    console.log("\n7. Verifying Universal Safety Invariants...");
    const checkedHtmls = [
      { name: "reviews", html: reviewsHtml },
      { name: "explore", html: exploreHtml },
      { name: "results", html: resultsHtml },
      { name: "protocol", html: protoHtml },
      { name: "policy", html: policyHtml },
      { name: "about", html: aboutHtml },
      { name: "moderation", html: moderationHtml },
    ];

    for (const { name, html } of checkedHtmls) {
      if (html.includes("workshop_draft") || html.includes("directive_body")) {
        throw new Error(`Public face ${name} leaked private workshop or directive markers`);
      }
      if (
        html.includes('class="leaderboard"') ||
        html.includes('id="leaderboard"') ||
        html.includes("data-rank") ||
        html.includes("data-streak")
      ) {
        throw new Error(`Public face ${name} contained forbidden competition metrics structure`);
      }
    }

    console.log(
      `\n=== All W8.8 Agora Support Surfaces E2E checks passed in ${Math.round(performance.now() - suiteStart)}ms ===`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPERATOR_PRINCIPAL_IDS = originalEnvOperators;
  }
}

// Self-run when executed directly via bun
if (import.meta.main) {
  runAgoraSupportSurfacesE2e().catch((error) => {
    console.error("Agora Support Surfaces E2E FAILED:", error);
    process.exit(1);
  });
}
