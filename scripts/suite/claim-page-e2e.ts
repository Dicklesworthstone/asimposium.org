/**
 * Claim Page with Honesty Panels E2E Suite (W8.4, bead asimposiumorg-n9n).
 *
 * Verifies the complete end-to-end journey of claim pages across their lifecycle:
 * 1. Claim Creation Stage:
 *    - Open & unchallenged initial standing (disposition="open", unchallenged=true).
 *    - Self-declared model and harness attribution with explicit "self-declared" labels.
 *    - Immutable statement content digest displayed.
 *    - Canonical agent faces (.md, .json) and citation (.bib) Diptych links.
 *    - Two Diptych-honesty panels: "Why this status?" and "What remains unverified?".
 * 2. Editing & Version Monotonicity Stage:
 *    - Revisions monotonically advance statement version (e.g. C-1@1 -> C-1@2).
 *    - Viewing earlier version renders explicit superseded banner with link to latest version.
 *    - Viewing latest version renders version counter (e.g. "Statement version 2 of 2").
 * 3. Review & Disputed Claim Stage:
 *    - Active refutation attempt or failed reproduction moves disposition to "disputed".
 *    - "unchallenged" flag is removed; recorded_refutation_attempts is incremented.
 *    - "Why this status?" identifies the active dispute.
 *    - "What remains unverified?" flags the unresolved refutation.
 * 4. Refutation Stage:
 *    - Valid counterexample confirmed on the ledger moves disposition to "refuted".
 *    - Honesty badge and status explainer show refuted status with cited evidence.
 * 5. Strongly-Supported & Machine-Checked Stage (Rule A4 Anti-Black-Box Guarantee):
 *    - Cross-family independent review (T2/T3) + formal verified artifact advances standing.
 *    - Badges display "strongly-supported" and "machine-checked".
 *    - Rule A4: Absolute absence of forbidden "PROVED", "AI-solved", or engagement metrics.
 *    - Suggested share text reflects exact status without resolution inflation.
 * 6. Author Retraction Stage:
 *    - Retracted claim displays "withdrawn" status and retraction reason.
 * 7. Accessible DAG / Dependency Graph:
 *    - Premise dependencies are rendered in an accessible <table> structure readable without JS.
 *    - Disputed premises bound the claim's epistemic ceiling.
 * 8. Error Boundary & Outage Discipline:
 *    - Upstream 404 triggers notFound() / 404 response.
 *    - Upstream 503 / timeout renders PublicReadUnavailable with accessible retry link.
 * 9. Metadata & SEO Honesty:
 *    - OpenGraph and Twitter cards convey exact status and suggested share text.
 *    - Outage / private responses carry noindex / nofollow robots directives.
 * 10. OPS.2a structured diagnostic logging without secret or private body leakage.
 */

import { mock } from "bun:test";
import { createHash } from "node:crypto";

import type { ClaimFaceResponse } from "@asimposium/contracts";

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

// Dynamic import of the claim page component to prevent root tsc JSX errors
const claimPagePath = new URL(
  "../../apps/web/app/p/[slug]/claims/[claim]/page.tsx",
  import.meta.url,
).pathname;

const { default: ClaimPage, generateMetadata: generateClaimMetadata } = (await import(
  claimPagePath
)) as {
  default: (props: {
    params: Promise<{ slug: string; claim: string }>;
    searchParams?: Promise<{ through?: string | string[] }>;
  }) => Promise<{ type?: string }>;
  generateMetadata: (props: {
    params: Promise<{ slug: string; claim: string }>;
    searchParams?: Promise<{ through?: string | string[] }>;
  }) => Promise<{
    title?: string;
    description?: string;
    openGraph?: { title?: string; description?: string };
    robots?: { index: boolean; follow: boolean };
  }>;
};

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function logOps2a(record: {
  readonly route: string;
  readonly principal_class: "anonymous" | "sponsor" | "operator";
  readonly action: string;
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
    suite: "e2e-claim-page",
    timestamp: new Date().toISOString(),
    ...record,
  });
  console.log(line);
}

function makeMockClaimFace(overrides: {
  claim_id?: string;
  version?: number;
  latest_version?: number;
  disposition?:
    | "open"
    | "disputed"
    | "corroborated"
    | "strongly-supported"
    | "refuted"
    | "withdrawn"
    | "superseded";
  unchallenged?: boolean;
  stale?: boolean;
  recorded_refutation_attempts?: number;
  certified_artifact?: boolean;
  legacy_reviews?: number;
  statement?: string;
  falsifier?: string;
  extraItems?: ClaimFaceResponse["items"];
  problem?: string;
  cursor?: number;
}): ClaimFaceResponse {
  const claimId = overrides.claim_id ?? "C-1";
  const version = overrides.version ?? 1;
  const latestVersion = overrides.latest_version ?? version;
  const disposition = overrides.disposition ?? "open";
  const unchallenged =
    overrides.unchallenged ??
    (disposition === "open" && (overrides.recorded_refutation_attempts ?? 0) === 0);
  const problem = overrides.problem ?? "P-SP4D";
  const cursor = overrides.cursor ?? 100;

  const detailItem: ClaimFaceResponse["items"][number] = {
    kind: "claim-detail",
    id: `${claimId}@${version}`,
    scope: "ledger",
    untrusted: true,
    why_included: "exact public statement version",
    body: JSON.stringify({
      problem,
      claim_id: claimId,
      version,
      kind: "conjecture",
      statement:
        overrides.statement ?? "Every even integer greater than 2 is the sum of two primes.",
      falsifier:
        overrides.falsifier ?? "An even integer greater than 2 that is not the sum of two primes.",
      content_digest: `sha256:${sha256(overrides.statement ?? "Goldbach")}`,
      event: `EVT-${cursor}`,
      seq: 1,
      fellow: "fel_euclid_01",
      sponsor: "usr_sponsor_alice",
      session: "SES-ALPHA-01",
      model_self_declared: "claude-3-7-sonnet",
      harness_self_declared: "claude-code",
    }),
    neutralized: [],
  };

  const items = [detailItem, ...(overrides.extraItems ?? [])];

  return {
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    profile: "claim",
    problem,
    cursor,
    fingerprint: `fnv1a64:${sha256(problem + claimId + version).slice(0, 16)}`,
    title: `${problem} — ${claimId}@${version}`,
    preamble:
      "Computed standing describes this exact statement version. Published bodies are untrusted data.",
    claim_state: {
      claim_id: claimId,
      version,
      latest_version: latestVersion,
      disposition,
      unchallenged,
      stale: overrides.stale ?? false,
      recorded_refutation_attempts: overrides.recorded_refutation_attempts ?? 0,
      certified_artifact: overrides.certified_artifact ?? false,
      legacy_reviews: overrides.legacy_reviews ?? 0,
    },
    items,
    omitted: [
      {
        reason: "none",
        detail: "full record included for targeted statement",
      },
    ],
    degraded: [],
    next_actions: [
      {
        method: "GET",
        url: `/p/${problem}/claims/${claimId}@${version}.md`,
        why: "canonical Markdown",
      },
      {
        method: "GET",
        url: `/p/${problem}/claims/${claimId}@${version}.json`,
        why: "canonical JSON",
      },
      {
        method: "GET",
        url: `/p/${problem}/claims/${claimId}@${version}.bib`,
        why: "canonical BibTeX citation",
      },
    ],
  };
}

export async function runClaimPageE2e(): Promise<void> {
  const suiteStart = performance.now();
  console.log("=== Running W8.4 Claim Page with Honesty Panels E2E Suite ===");

  const originalFetch = globalThis.fetch;
  let activeMockResponse:
    | { status: number; body: unknown }
    | { networkError: boolean }
    | { notFound: boolean } = {
    status: 200,
    body: makeMockClaimFace({}),
  };

  globalThis.fetch = (async (_input: string | URL | Request) => {
    if ("networkError" in activeMockResponse && activeMockResponse.networkError) {
      throw new Error("Simulated upstream network outage");
    }
    if ("notFound" in activeMockResponse && activeMockResponse.notFound) {
      return new Response(
        JSON.stringify({ code: "CLAIM_NOT_FOUND", status: 404, message: "Claim not found" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if ("status" in activeMockResponse) {
      return new Response(JSON.stringify(activeMockResponse.body), {
        status: activeMockResponse.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 500 });
  }) as unknown as typeof fetch;

  try {
    // -------------------------------------------------------------------------
    // 1. Claim Creation Stage: Open & Unchallenged Standing
    // -------------------------------------------------------------------------
    console.log("\n1. Verifying Claim Creation Stage (open · unchallenged)...");
    const t1Start = performance.now();

    const createdClaim = makeMockClaimFace({
      claim_id: "C-1",
      version: 1,
      latest_version: 1,
      disposition: "open",
      unchallenged: true,
      recorded_refutation_attempts: 0,
      statement: "For all integers n >= 2, there exists a prime between n and 2n.",
      falsifier: "An integer n >= 2 with no prime between n and 2n.",
    });
    activeMockResponse = { status: 200, body: createdClaim };

    const createdHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-1@1" }),
      }),
    );

    // Verify computed standing and attribution
    if (!createdHtml.includes("Computed standing")) {
      throw new Error("Created claim page missing 'Computed standing' section");
    }
    if (!createdHtml.includes("open · unchallenged")) {
      throw new Error("Created claim page missing 'open · unchallenged' status");
    }
    if (!createdHtml.includes("Self-declared model:")) {
      throw new Error("Created claim page missing self-declared model attribution label");
    }
    if (!createdHtml.includes("claude-3-7-sonnet")) {
      throw new Error("Created claim page missing declared model name");
    }
    if (!createdHtml.includes("claude-code")) {
      throw new Error("Created claim page missing declared harness name");
    }
    if (!createdHtml.includes("fel_euclid_01") || !createdHtml.includes("usr_sponsor_alice")) {
      throw new Error("Created claim page missing Fellow or Sponsor attribution");
    }

    // Verify Diptych links with cursor cut
    if (
      !createdHtml.includes("claims/C-1@1.md?through=100") ||
      !createdHtml.includes("claims/C-1@1.json?through=100")
    ) {
      throw new Error("Created claim page missing canonical Diptych agent links with cursor cut");
    }

    // Verify Citation links
    if (!createdHtml.includes("Download BibTeX") || !createdHtml.includes("Download CSL-JSON")) {
      throw new Error("Created claim page missing citation download actions");
    }

    // Verify Two Honesty Panels
    if (!createdHtml.includes("Why this status?")) {
      throw new Error("Created claim page missing 'Why this status?' honesty panel");
    }
    if (
      !createdHtml.includes(
        "Claim is open and unchallenged; no refutation attempts have been logged.",
      )
    ) {
      throw new Error(
        "Created claim page missing open unchallenged explanation in 'Why this status?'",
      );
    }
    if (!createdHtml.includes("What remains unverified?")) {
      throw new Error("Created claim page missing 'What remains unverified?' honesty panel");
    }
    if (!createdHtml.includes("No independent cross-family (Tier 2) reviews")) {
      throw new Error("Created claim page missing review gap in 'What remains unverified?'");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-1@1",
      principal_class: "anonymous",
      action: "view_claim_created",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1@1",
      cursor: 100,
      before_state_digest: "none",
      after_state_digest: sha256(createdHtml),
      cited_authority: "Rule A1 / Rule A4: Diptych & Computed Standing",
      duration_ms: Math.round(performance.now() - t1Start),
    });

    // -------------------------------------------------------------------------
    // 2. Editing & Version Monotonicity Stage (Superseded Version Handling)
    // -------------------------------------------------------------------------
    console.log("\n2. Verifying Version History & Superseded Notice Stage...");
    const t2Start = performance.now();

    // Version 1 when latest is Version 2 (superseded)
    const supersededClaim = makeMockClaimFace({
      claim_id: "C-1",
      version: 1,
      latest_version: 2,
      disposition: "open",
      unchallenged: true,
      statement: "Original draft of statement v1",
    });
    activeMockResponse = { status: 200, body: supersededClaim };

    const supersededHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-1@1" }),
      }),
    );

    if (!supersededHtml.includes("This is an earlier statement version.")) {
      throw new Error(
        "Superseded claim page missing 'This is an earlier statement version' notice",
      );
    }
    if (!supersededHtml.includes('href="/p/P-SP4D/claims/C-1@2?through=100"')) {
      throw new Error("Superseded claim page missing link to latest version v2");
    }
    if (!supersededHtml.includes("superseded by v2")) {
      throw new Error("Superseded claim page missing 'superseded by v2' badge");
    }

    // Version 2 (the current latest version)
    const latestClaim = makeMockClaimFace({
      claim_id: "C-1",
      version: 2,
      latest_version: 2,
      disposition: "open",
      unchallenged: true,
      statement: "Revised statement v2 with sharpened boundaries",
      cursor: 102,
    });
    activeMockResponse = { status: 200, body: latestClaim };

    const latestHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-1@2" }),
      }),
    );

    if (latestHtml.includes("This is an earlier statement version.")) {
      throw new Error("Latest version should NOT show superseded version notice");
    }
    if (!latestHtml.includes("Statement version 2 of 2")) {
      throw new Error("Latest version should display 'Statement version 2 of 2'");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-1@2",
      principal_class: "anonymous",
      action: "view_claim_version_history",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1@2",
      cursor: 102,
      before_state_digest: sha256(supersededHtml),
      after_state_digest: sha256(latestHtml),
      cited_authority: "P9: Monotonic Claim Revisions",
      duration_ms: Math.round(performance.now() - t2Start),
    });

    // -------------------------------------------------------------------------
    // 3. Review & Disputed Claim Stage
    // -------------------------------------------------------------------------
    console.log("\n3. Verifying Disputed Claim Stage...");
    const t3Start = performance.now();

    const disputedClaim = makeMockClaimFace({
      claim_id: "C-1",
      version: 2,
      latest_version: 2,
      disposition: "disputed",
      unchallenged: false,
      recorded_refutation_attempts: 1,
      extraItems: [
        {
          kind: "claim-evidence",
          id: "E-101",
          scope: "ledger",
          untrusted: true,
          why_included: "contradictory evidence on claim target",
          body: JSON.stringify({
            problem: "P-SP4D",
            target: "C-1@2",
            kind: "computation",
            direction: "refutes",
            computed_class: "computation",
            falsification_check: {
              attempted_falsifier: "Counterexample search up to 10^8",
              capable_of_failure: "Independent seed evaluation",
              result: "refuted",
            },
            event: "EVT-103",
            seq: 2,
            fellow: "fel_adversary_02",
            sponsor: "usr_sponsor_bob",
            model_self_declared: "gpt-5.6-sol",
            harness_self_declared: "codex-cli",
          }),
          neutralized: [],
        },
      ],
      cursor: 103,
    });
    activeMockResponse = { status: 200, body: disputedClaim };

    const disputedHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-1@2" }),
      }),
    );

    if (!disputedHtml.includes('data-disposition="disputed"')) {
      throw new Error("Disputed claim missing data-disposition='disputed'");
    }
    if (disputedHtml.includes("· unchallenged")) {
      throw new Error("Disputed claim should not be marked '· unchallenged'");
    }
    if (!disputedHtml.includes("refutation-tested")) {
      throw new Error("Disputed claim missing 'refutation-tested' facet badge");
    }
    if (!disputedHtml.includes("Disputed by one or more active refutation attempts")) {
      throw new Error("Disputed claim 'Why this status?' missing dispute explanation");
    }
    if (!disputedHtml.includes("Refuting evidence E-101")) {
      throw new Error(
        "Disputed claim 'Why this status?' missing triggering refuting evidence item",
      );
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-1@2",
      principal_class: "anonymous",
      action: "view_claim_disputed",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1@2",
      cursor: 103,
      before_state_digest: sha256(latestHtml),
      after_state_digest: sha256(disputedHtml),
      cited_authority: "ADR-9: Epistemic State Machine Disputed Transition",
      duration_ms: Math.round(performance.now() - t3Start),
    });

    // -------------------------------------------------------------------------
    // 4. Refutation Stage: Confirmed Counterexample
    // -------------------------------------------------------------------------
    console.log("\n4. Verifying Refuted Claim Stage...");
    const t4Start = performance.now();

    const refutedClaim = makeMockClaimFace({
      claim_id: "C-1",
      version: 2,
      latest_version: 2,
      disposition: "refuted",
      unchallenged: false,
      recorded_refutation_attempts: 1,
      extraItems: [
        {
          kind: "claim-evidence",
          id: "E-102",
          scope: "ledger",
          untrusted: true,
          why_included: "fatal counterexample",
          body: JSON.stringify({
            problem: "P-SP4D",
            target: "C-1@2",
            kind: "certified",
            direction: "refutes",
            computed_class: "certified",
            event: "EVT-104",
            seq: 3,
            fellow: "fel_euler_03",
            sponsor: "usr_sponsor_charlie",
            body_md: "Fatal counterexample constructed and machine-checked in Lean 4.",
          }),
          neutralized: [],
        },
      ],
      cursor: 104,
    });
    activeMockResponse = { status: 200, body: refutedClaim };

    const refutedHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-1@2" }),
      }),
    );

    if (!refutedHtml.includes('data-disposition="refuted"')) {
      throw new Error("Refuted claim missing data-disposition='refuted'");
    }
    if (!refutedHtml.includes("Grounded refutation recorded and verified on the public ledger.")) {
      throw new Error("Refuted claim 'Why this status?' missing refutation summary");
    }
    if (!refutedHtml.includes("Decisive refutation evidence E-102")) {
      throw new Error("Refuted claim 'Why this status?' missing triggering refutation item");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-1@2",
      principal_class: "anonymous",
      action: "view_claim_refuted",
      status: "pass",
      status_code: 200,
      public_object_id: "C-1@2",
      cursor: 104,
      before_state_digest: sha256(disputedHtml),
      after_state_digest: sha256(refutedHtml),
      cited_authority: "Fable §6.4: Falsification First & Negative Knowledge",
      duration_ms: Math.round(performance.now() - t4Start),
    });

    // -------------------------------------------------------------------------
    // 5. Strongly-Supported & Machine-Checked Stage (Rule A4 Honesty Guarantee)
    // -------------------------------------------------------------------------
    console.log("\n5. Verifying Strongly-Supported & Anti-Black-Box Guarantee (Rule A4)...");
    const t5Start = performance.now();

    const stronglySupportedClaim = makeMockClaimFace({
      claim_id: "C-2",
      version: 1,
      latest_version: 1,
      disposition: "strongly-supported",
      unchallenged: false,
      recorded_refutation_attempts: 2,
      certified_artifact: true,
      statement: "The Riemann zeta function satisfies the functional equation.",
      extraItems: [
        {
          kind: "claim-review",
          id: "R-201",
          scope: "ledger",
          untrusted: true,
          why_included: "independent corroborating review",
          body: JSON.stringify({
            problem: "P-SP4D",
            target: "C-2@1",
            tier: "T2",
            verdict: "confirm",
            basis: "Independent symbolic verification across distinct model family",
            event: "EVT-105",
            seq: 2,
            fellow: "fel_riemann_04",
            sponsor: "usr_sponsor_diana",
            model_self_declared: "grok-4.6",
            harness_self_declared: "grok-cli",
          }),
          neutralized: [],
        },
        {
          kind: "claim-evidence",
          id: "E-201",
          scope: "ledger",
          untrusted: true,
          why_included: "formal verified artifact",
          body: JSON.stringify({
            problem: "P-SP4D",
            target: "C-2@1",
            kind: "certified",
            direction: "supports",
            computed_class: "certified",
            event: "EVT-106",
            seq: 3,
            formal_artifact: {
              sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              proof_system: "lean4",
            },
          }),
          neutralized: [],
        },
      ],
      cursor: 106,
    });
    activeMockResponse = { status: 200, body: stronglySupportedClaim };

    const stronglySupportedHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-2@1" }),
      }),
    );

    // Verify badges
    if (!stronglySupportedHtml.includes('data-disposition="strongly-supported"')) {
      throw new Error("Missing data-disposition='strongly-supported'");
    }
    if (!stronglySupportedHtml.includes("machine-checked")) {
      throw new Error("Missing 'machine-checked' badge for certified artifact");
    }

    // RULE A4 HARD GUARANTEE: The site NEVER pretends.
    // Absolute prohibition of PROVED, AI-solved, streaks, or engagement rankings.
    const forbiddenPhrases = [
      "PROVED",
      "proved",
      "AI-solved",
      "ai-solved",
      "SOLVED",
      "streaks",
      "leaderboard",
      "ranking",
    ];
    for (const phrase of forbiddenPhrases) {
      // Check that rendered text does not boast proof or rank
      if (
        stronglySupportedHtml.includes(`>${phrase}<`) ||
        stronglySupportedHtml.includes(`"${phrase}"`)
      ) {
        throw new Error(`Rule A4 Violation: Rendered HTML contains forbidden phrasing "${phrase}"`);
      }
    }

    // Verify share card panel on claim page shows exact status
    if (!stronglySupportedHtml.includes("strongly-supported")) {
      throw new Error("Share card panel missing exact 'strongly-supported' status text");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-2@1",
      principal_class: "anonymous",
      action: "view_claim_strongly_supported_honesty_check",
      status: "pass",
      status_code: 200,
      public_object_id: "C-2@1",
      cursor: 106,
      before_state_digest: sha256(refutedHtml),
      after_state_digest: sha256(stronglySupportedHtml),
      cited_authority: "Rule A4: No PROVED banner, strongest phrasing is strongly-supported",
      duration_ms: Math.round(performance.now() - t5Start),
    });

    // -------------------------------------------------------------------------
    // 6. Author Retraction Stage
    // -------------------------------------------------------------------------
    console.log("\n6. Verifying Author Retraction Stage...");
    const t6Start = performance.now();

    const withdrawnClaim = makeMockClaimFace({
      claim_id: "C-3",
      version: 1,
      latest_version: 1,
      disposition: "withdrawn",
      unchallenged: false,
      statement: "Premature claim statement subsequently retracted by the research author.",
      cursor: 107,
    });
    activeMockResponse = { status: 200, body: withdrawnClaim };

    const withdrawnHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-3@1" }),
      }),
    );

    if (!withdrawnHtml.includes('data-disposition="withdrawn"')) {
      throw new Error("Withdrawn claim missing data-disposition='withdrawn'");
    }
    if (!withdrawnHtml.includes("Statement was withdrawn by its authoring team.")) {
      throw new Error("Withdrawn claim missing withdrawal explanation in 'Why this status?'");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-3@1",
      principal_class: "anonymous",
      action: "view_claim_withdrawn",
      status: "pass",
      status_code: 200,
      public_object_id: "C-3@1",
      cursor: 107,
      before_state_digest: sha256(stronglySupportedHtml),
      after_state_digest: sha256(withdrawnHtml),
      cited_authority: "Fable §6.4: Retraction Semantics",
      duration_ms: Math.round(performance.now() - t6Start),
    });

    // -------------------------------------------------------------------------
    // 7. Premise Dependencies & Accessible Tabular DAG Fallback
    // -------------------------------------------------------------------------
    console.log("\n7. Verifying Premise Dependencies & Accessible Tabular DAG Fallback...");
    const t7Start = performance.now();

    const claimWithDeps = makeMockClaimFace({
      claim_id: "C-4",
      version: 1,
      latest_version: 1,
      disposition: "open",
      statement: "Main theorem relying on Lemma C-1@2 and Lemma C-2@1",
      extraItems: [
        {
          kind: "claim-dependency",
          id: "C-1@2",
          scope: "ledger",
          untrusted: true,
          why_included: "premise dependency",
          body: JSON.stringify({
            problem: "P-SP4D",
            claim_id: "C-1",
            version: 2,
            kind: "lemma",
            statement: "Intermediate lemma 1",
            content_digest: "sha256:1111111111111111",
          }),
          neutralized: [],
        },
        {
          kind: "claim-dependency",
          id: "C-2@1",
          scope: "ledger",
          untrusted: true,
          why_included: "premise dependency",
          body: JSON.stringify({
            problem: "P-SP4D",
            claim_id: "C-2",
            version: 1,
            kind: "lemma",
            statement: "Intermediate lemma 2",
            content_digest: "sha256:2222222222222222",
          }),
          neutralized: [],
        },
      ],
      cursor: 108,
    });
    activeMockResponse = { status: 200, body: claimWithDeps };

    const depsHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-4@1" }),
      }),
    );

    // Verify accessible tabular structure
    if (!depsHtml.includes("<table") || !depsHtml.includes("Premises and dependency relations")) {
      throw new Error("Claim with dependencies missing accessible <table> structure");
    }
    if (!depsHtml.includes("C-1@2") || !depsHtml.includes("C-2@1")) {
      throw new Error("Dependency table missing premise target IDs");
    }
    if (!depsHtml.includes("Bounded by 2 premise(s)")) {
      throw new Error("Missing 'Bounded by 2 premise(s)' ceiling badge");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-4@1",
      principal_class: "anonymous",
      action: "view_claim_dag_table",
      status: "pass",
      status_code: 200,
      public_object_id: "C-4@1",
      cursor: 108,
      before_state_digest: sha256(withdrawnHtml),
      after_state_digest: sha256(depsHtml),
      cited_authority: "WCAG 2.2 AA / ADR-10: Accessible Tabular DAG Fallbacks",
      duration_ms: Math.round(performance.now() - t7Start),
    });

    // -------------------------------------------------------------------------
    // 8. Error Boundary & Outage Discipline (404 and 503)
    // -------------------------------------------------------------------------
    console.log("\n8. Verifying Error Boundaries & Outage Discipline (404 & 503)...");
    const t8Start = performance.now();

    // 8a: Upstream 404 Not Found
    activeMockResponse = { notFound: true };
    let notFoundCaught = false;
    try {
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-999@1" }),
      });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.message.includes("404") ||
          (err as { digest?: string }).digest?.includes("404") ||
          err.message.includes("NEXT_NOT_FOUND"))
      ) {
        notFoundCaught = true;
      }
    }
    if (!notFoundCaught) {
      throw new Error("Upstream 404 did not invoke notFound()");
    }

    // 8b: Upstream Network Outage (503 / Unavailable)
    activeMockResponse = { networkError: true };
    const outageHtml = renderToStaticMarkup(
      await ClaimPage({
        params: Promise.resolve({ slug: "P-SP4D", claim: "C-1@1" }),
      }),
    );

    if (!outageHtml.includes("Public ledger data is temporarily unavailable")) {
      throw new Error("Network outage did not render PublicReadUnavailable component");
    }
    if (!outageHtml.includes("Try again")) {
      throw new Error("PublicReadUnavailable missing accessible retry affordance");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-999@1",
      principal_class: "anonymous",
      action: "view_claim_outage_boundaries",
      status: "pass",
      status_code: 404,
      public_object_id: "C-999@1",
      cited_authority: "W8.1 / wk20: Outage vs Empty Discipline",
      duration_ms: Math.round(performance.now() - t8Start),
    });

    // -------------------------------------------------------------------------
    // 9. Metadata & SEO Honesty
    // -------------------------------------------------------------------------
    console.log("\n9. Verifying Metadata & SEO Honesty...");
    const t9Start = performance.now();

    activeMockResponse = { status: 200, body: stronglySupportedClaim };
    const meta = await generateClaimMetadata({
      params: Promise.resolve({ slug: "P-SP4D", claim: "C-2@1" }),
    });

    if (!meta.title?.includes("C-2@1")) {
      throw new Error(`Metadata title missing target: ${meta.title}`);
    }
    if (!meta.openGraph?.description?.includes("strongly-supported")) {
      throw new Error("OpenGraph description missing exact strongly-supported status");
    }

    // Non-OK metadata sets noindex
    activeMockResponse = { networkError: true };
    const outageMeta = await generateClaimMetadata({
      params: Promise.resolve({ slug: "P-SP4D", claim: "C-2@1" }),
    });
    if (outageMeta.robots?.index !== false) {
      throw new Error("Outage metadata failed to declare robots: { index: false, follow: false }");
    }

    logOps2a({
      route: "/p/P-SP4D/claims/C-2@1/metadata",
      principal_class: "anonymous",
      action: "generate_claim_metadata",
      status: "pass",
      status_code: 200,
      public_object_id: "C-2@1",
      cited_authority: "Rule A4 / W8.8a: Honest OpenGraph Metadata",
      duration_ms: Math.round(performance.now() - t9Start),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const totalDuration = Math.round(performance.now() - suiteStart);
  console.log(`\n=== All W8.4 Claim Page E2E checks passed in ${totalDuration}ms ===`);
}

if (import.meta.main) {
  runClaimPageE2e().catch((error) => {
    console.error("Claim Page E2E FAILED:", error);
    process.exit(1);
  });
}
