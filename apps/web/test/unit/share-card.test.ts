/**
 * Unit & Golden test suite for W8.8a Honest Share Cards & Suggested Share Text (Fable §8.8).
 */

import { describe, expect, test } from "bun:test";
import type {
  ClaimFaceResponse,
  HonorsResponse,
  ProblemFaceResponse,
} from "@asimposium/contracts";
import {
  assertShareHonesty,
  buildClaimShareCardData,
  buildProblemShareCardData,
  buildResultsShareCardData,
  computeShareCardCacheKey,
  isFamousProblem,
  isRelevantPublicEvent,
  PrivateDraftExclusionError,
  sanitizeShareText,
  ShareHonestyViolationError,
} from "../../lib/share-card";
import {
  generateShareCardImageResponse,
  renderShareCard,
} from "../../lib/share-card-render";

function createMinimalProblemFace(overrides: Partial<ProblemFaceResponse> = {}): ProblemFaceResponse {
  return {
    schema: "asimposium.problem-face.v1",
    face: "json",
    kind: "problem-face",
    problem: "P-100",
    profile: "face",
    cursor: 42,
    fingerprint: "fnv1a64:0123456789abcdef",
    title: "Minimal Test Problem",
    preamble: "Untrusted problem face preamble",
    problem_status: "active",
    items: [
      {
        scope: "ledger",
        kind: "problem-title",
        id: "title-1",
        body: "Minimal Test Problem Title",
        why_included: "problem title",
        untrusted: true,
        neutralized: [],
      },
      {
        scope: "ledger",
        kind: "problem-statement",
        id: "stmt-1",
        body: "Statement of the problem",
        why_included: "problem statement",
        untrusted: true,
        neutralized: [],
      },
      {
        scope: "ledger",
        kind: "claim",
        id: "C-1",
        body: "First claim under problem",
        why_included: "standing claim",
        untrusted: true,
        neutralized: [],
      },
    ],
    omitted: [{ reason: "budget_limit", detail: "omitted remaining" }],
    next_actions: [],
    degraded: [],
    ...overrides,
  };
}

function createMinimalClaimFace(overrides: Partial<ClaimFaceResponse> = {}): ClaimFaceResponse {
  return {
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    problem: "P-100",
    profile: "claim",
    cursor: 42,
    fingerprint: "fnv1a64:0123456789abcdef",
    title: "C-1@1: Test Claim",
    preamble: "Untrusted claim preamble",
    claim_state: {
      claim_id: "C-1",
      version: 1,
      latest_version: 1,
      disposition: "open",
      unchallenged: true,
      stale: false,
      recorded_refutation_attempts: 0,
      certified_artifact: false,
      legacy_reviews: 0,
    },
    items: [
      {
        scope: "ledger",
        kind: "claim-detail",
        id: "C-1@1",
        body: "Let X be a smooth 4-manifold. Then X satisfies property Q.",
        why_included: "claim detail",
        untrusted: true,
        neutralized: [],
      },
    ],
    omitted: [{ reason: "none" }],
    next_actions: [],
    degraded: [],
    ...overrides,
  };
}

function createMinimalHonorsRecord(overrides: Partial<HonorsResponse> = {}): HonorsResponse {
  return {
    results: [
      {
        kind: "claim",
        problem_id: "P-100",
        result_id: "C-1@1",
        title: "Test Settled Claim",
        status: "strongly-supported",
        settled_at: "2026-09-01T12:00:00.000Z",
        sequence: 1,
        contributing_fellows: [
          {
            fellow_id: "FEL-1",
            name: "Agent Alpha",
            sponsor_id: "usr_1",
            model: "claude-3-7-sonnet",
            model_provenance: "self_declared",
            harness: "claude-code",
            harness_provenance: "self_declared",
          },
        ],
        carrying_reviewers: [],
        dag_context: { depends_on: [], unlocks: [], closes_gaps: [] },
        evidence_trail: [],
      },
    ],
    cursor: 50,
    omitted: [],
    ...overrides,
  };
}

describe("W8.8a Share Honesty & Forbidden Words (Rule A4)", () => {
  test("passes honest scientific phrasing", () => {
    expect(() => assertShareHonesty("Status: strongly-supported (multi-tier independent review)")).not.toThrow();
    expect(() => assertShareHonesty("Status: open · unchallenged (no refutations attempted)")).not.toThrow();
    expect(() => assertShareHonesty("Status: under result review · validation in progress")).not.toThrow();
    expect(() => assertShareHonesty("Status: resolved (qualified scope)")).not.toThrow();
    expect(() => assertShareHonesty("Unresolved — open for independent investigation")).not.toThrow();
  });

  test("strictly forbids PROVED, PROVEN, and case variants", () => {
    expect(() => assertShareHonesty("This theorem has been PROVED!")).toThrow(ShareHonestyViolationError);
    expect(() => assertShareHonesty("The claim is proven by agent.")).toThrow(ShareHonestyViolationError);
    expect(() => assertShareHonesty("mathematically Proved")).toThrow(ShareHonestyViolationError);
  });

  test("strictly forbids unqualified 'solved' and AI-solved marketing", () => {
    expect(() => assertShareHonesty("Problem Solved by Frontier Agent")).toThrow(ShareHonestyViolationError);
    expect(() => assertShareHonesty("AI-solved 4D conjecture")).toThrow(ShareHonestyViolationError);
    expect(() => assertShareHonesty("AI solved Poincaré")).toThrow(ShareHonestyViolationError);
  });

  test("strictly forbids sensational buzzwords and rankings", () => {
    expect(() => assertShareHonesty("Major breakthrough in mathematics")).toThrow(ShareHonestyViolationError);
    expect(() => assertShareHonesty("Agent rankings and top contributors")).toThrow(ShareHonestyViolationError);
    expect(() => assertShareHonesty("Unverified novelty reported")).toThrow(ShareHonestyViolationError);
  });
});

describe("Problem Share Card View Model", () => {
  test("builds active problem share card with honest counts", () => {
    const face = createMinimalProblemFace();
    const data = buildProblemShareCardData(face);

    expect(data.code).toBe("P-100");
    expect(data.title).toBe("Minimal Test Problem Title");
    expect(data.statusKind).toBe("active");
    expect(data.statusBadge).toBe("ACTIVE");
    expect(data.status).toBe("active · open for investigation");
    expect(data.cursor).toBe(42);
    expect(data.counts).toEqual([
      { label: "Claims", value: 1 },
      { label: "Formulations", value: 2 },
      { label: "Cursor", value: "#42" },
    ]);
    expect(data.suggestedShareText).toContain("[P-100] Minimal Test Problem Title");
    expect(data.suggestedShareText).toContain("Status: active · open for investigation");
    expect(data.suggestedShareText).toContain("https://asimposium.org/p/P-100");
  });

  test("famous-problem guardrail (§6.2): SP4D and famous problems display standing disclaimer", () => {
    const face = createMinimalProblemFace({
      problem: "P-4DSP",
      title: "Smooth 4-Dimensional Poincaré Conjecture",
      problem_status: "active",
      items: [
        {
          scope: "ledger",
          kind: "problem-title",
          id: "title-1",
          body: "Smooth 4-Dimensional Poincaré Conjecture",
          why_included: "title",
          untrusted: true,
          neutralized: [],
        },
      ],
    });

    expect(isFamousProblem("P-4DSP")).toBe(true);
    const data = buildProblemShareCardData(face);

    expect(data.isFamousProblem).toBe(true);
    expect(data.guardrailNotice).toBe(
      "Famous-problem guardrail: no resolution displayed without extraordinary evidence.",
    );
    expect(data.status).toContain("(unresolved)");
    expect(data.suggestedShareText).toContain("Famous-problem guardrail");
  });

  test("single-team problem banner displayed when unreviewed", () => {
    const face = createMinimalProblemFace({
      preamble: "Single-team problem — nothing here has been independently reviewed yet.",
    });
    const data = buildProblemShareCardData(face);

    expect(data.isSingleTeam).toBe(true);
    expect(data.singleTeamNotice).toContain("Single-team problem — nothing has been independently reviewed yet.");
    expect(data.suggestedShareText).toContain("Single-team problem");
  });

  test("resolved problem with scope boundary", () => {
    const face = createMinimalProblemFace({
      problem_status: "resolved",
    });
    const data = buildProblemShareCardData(face);

    expect(data.statusKind).toBe("resolved");
    expect(data.statusBadge).toBe("RESOLVED (WITH SCOPE)");
    expect(data.scopeNotice).toContain("Qualified resolution: bound strictly to verified scope");
    expect(data.suggestedShareText).toContain("Scope: Qualified resolution");
  });

  test("private-draft problems are strictly excluded", () => {
    const face = createMinimalProblemFace({
      // @ts-expect-error testing private-draft refusal
      problem_status: "private-draft",
    });

    expect(() => buildProblemShareCardData(face)).toThrow(PrivateDraftExclusionError);
  });
});

describe("Claim Share Card View Model", () => {
  test("open unchallenged claim indicates zero refutations", () => {
    const face = createMinimalClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "open",
        unchallenged: true,
        stale: false,
        recorded_refutation_attempts: 0,
        certified_artifact: false,
        legacy_reviews: 0,
      },
    });

    const data = buildClaimShareCardData(face, "P-100");
    expect(data.code).toBe("P-100 · C-1@1");
    expect(data.statusKind).toBe("open");
    expect(data.statusBadge).toBe("OPEN · UNCHALLENGED");
    expect(data.status).toContain("unchallenged (no refutations attempted)");
    expect(data.suggestedShareText).toContain("[P-100 · C-1@1]");
    expect(data.suggestedShareText).toContain("Status: open · unchallenged");
  });

  test("corroborated claim with surviving refutation attempts", () => {
    const face = createMinimalClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "corroborated",
        unchallenged: false,
        stale: false,
        recorded_refutation_attempts: 3,
        certified_artifact: false,
        legacy_reviews: 0,
      },
    });

    const data = buildClaimShareCardData(face, "P-100");
    expect(data.statusKind).toBe("corroborated");
    expect(data.statusBadge).toBe("CORROBORATED");
    expect(data.counts.find((c) => c.label === "Refutation attempts")?.value).toBe(3);
  });

  test("strongly-supported claim with certified artifact", () => {
    const face = createMinimalClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "strongly-supported",
        unchallenged: false,
        stale: false,
        recorded_refutation_attempts: 4,
        certified_artifact: true,
        legacy_reviews: 0,
      },
    });

    const data = buildClaimShareCardData(face, "P-100");
    expect(data.statusKind).toBe("strongly-supported");
    expect(data.statusBadge).toBe("STRONGLY-SUPPORTED");
    expect(data.counts.find((c) => c.label === "Machine-checked")?.value).toBe("Yes");
  });

  test("disputed claim displays counterevidence warning", () => {
    const face = createMinimalClaimFace({
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "disputed",
        unchallenged: false,
        stale: false,
        recorded_refutation_attempts: 1,
        certified_artifact: false,
        legacy_reviews: 0,
      },
    });

    const data = buildClaimShareCardData(face, "P-100");
    expect(data.statusKind).toBe("disputed");
    expect(data.statusBadge).toBe("DISPUTED");
    expect(data.status).toContain("disputed · counterevidence on record");
  });
});

describe("False-Solution Incident Path (§16.6 / Runbook 6)", () => {
  test("incident freeze freezes sensational metadata and displays pinned alert", () => {
    const face = createMinimalProblemFace({
      problem: "P-4DSP",
      title: "Smooth 4D Poincaré Solution Claim",
    });

    const data = buildProblemShareCardData(face, {
      incident: "freeze",
      incidentMessage: "INCIDENT NOTICE: Claimed solution under critical review. Metadata frozen at source.",
    });

    expect(data.incidentState).toBe("freeze");
    expect(data.statusKind).toBe("incident");
    expect(data.statusBadge).toBe("INCIDENT FREEZE");
    expect(data.incidentNotice).toContain("Metadata frozen at source");
    expect(data.suggestedShareText).toContain("[FREEZE NOTICE]");
    expect(data.suggestedShareText).toContain("Metadata frozen at source");
  });

  test("incident correction pins retraction/correction notice", () => {
    const face = createMinimalProblemFace({
      problem: "P-4DSP",
      title: "Smooth 4D Poincaré Solution Claim",
    });

    const data = buildProblemShareCardData(face, {
      incident: "correction",
      incidentMessage: "INCIDENT NOTICE: Prior claimed resolution refuted by independent multi-tier review.",
    });

    expect(data.incidentState).toBe("correction");
    expect(data.statusBadge).toBe("CORRECTION");
    expect(data.suggestedShareText).toContain("[CORRECTION NOTICE]");
    expect(data.suggestedShareText).toContain("refuted by independent multi-tier review");
  });
});

describe("Honors / Results Share Card", () => {
  test("builds chronological honors record share card without rankings", () => {
    const honors = createMinimalHonorsRecord();
    const data = buildResultsShareCardData(honors);

    expect(data.code).toBe("HONORS");
    expect(data.statusBadge).toBe("SETTLED RESULTS");
    expect(data.counts.find((c) => c.label === "Ordering")?.value).toBe("Chronological");
    expect(data.suggestedShareText).toContain("[HONORS] Honors: Conclusively Settled Results");
    expect(data.suggestedShareText).not.toContain("ranking");
    expect(data.suggestedShareText).not.toContain("top");
  });
});

describe("Sanitization, Cache Keys, & Invalidation Selection", () => {
  test("sanitizes markdown symbols and control characters in untrusted titles", () => {
    const dirty = "Title with `backticks` and **bold** and <script>alert(1)</script> & math: $\\pi$";
    const cleaned = sanitizeShareText(dirty, 100);
    expect(cleaned).not.toContain("<script>");
    expect(cleaned).not.toContain("`");
    expect(cleaned).not.toContain("**");
    expect(cleaned).toContain("Title with backticks and bold");
  });

  test("cache keys are deterministically bound to cursor and incident state", () => {
    const key1 = computeShareCardCacheKey({ kind: "problem", id: "P-4DSP", cursor: 100 });
    const key2 = computeShareCardCacheKey({ kind: "problem", id: "P-4DSP", cursor: 100 });
    expect(key1).toBe(key2);

    const key3 = computeShareCardCacheKey({ kind: "problem", id: "P-4DSP", cursor: 101 });
    expect(key1).not.toBe(key3);

    const keyIncident = computeShareCardCacheKey({
      kind: "problem",
      id: "P-4DSP",
      cursor: 100,
      incidentState: "freeze",
    });
    expect(key1).not.toBe(keyIncident);
  });

  test("isRelevantPublicEvent: public events invalidate, workshop events do not", () => {
    // Public events that advance cursor
    expect(isRelevantPublicEvent("problem.publish")).toBe(true);
    expect(isRelevantPublicEvent("claim.publish")).toBe(true);
    expect(isRelevantPublicEvent("evidence.publish")).toBe(true);
    expect(isRelevantPublicEvent("review.publish")).toBe(true);
    expect(isRelevantPublicEvent("problem.resolve")).toBe(true);
    expect(isRelevantPublicEvent("incident.declare")).toBe(true);

    // Private workshop events that must NEVER invalidate public share cards
    expect(isRelevantPublicEvent("workshop.push")).toBe(false);
    expect(isRelevantPublicEvent("workshop.draft")).toBe(false);
    expect(isRelevantPublicEvent("directive.send")).toBe(false);
    expect(isRelevantPublicEvent("session.open")).toBe(false);
    expect(isRelevantPublicEvent("session.close")).toBe(false);
  });
});

describe("Dynamic Image Rendering", () => {
  test("renderShareCard produces valid JSX tree", () => {
    const face = createMinimalProblemFace();
    const data = buildProblemShareCardData(face);
    const element = renderShareCard(data);

    expect(element).toBeDefined();
    expect(element.type).toBe("div");
    const props = (element as unknown as { props: { style: { width: string; height: string } } }).props;
    expect(props.style.width).toBe("100%");
    expect(props.style.height).toBe("100%");
  });

  test("generateShareCardImageResponse produces valid ImageResponse", () => {
    const face = createMinimalProblemFace();
    const data = buildProblemShareCardData(face);
    const response = generateShareCardImageResponse(data);

    expect(response).toBeDefined();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
  });
});
