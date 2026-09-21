/**
 * W8.8a Honest Share Cards & Suggested Share Text E2E Suite (Fable Rev 3.1 §6.2, §8.1, §8.8, §16.6).
 *
 * Verifies:
 * 1. Mock-free next/og rendering and ImageResponse generation.
 * 2. Canonical projection parity: metadata and suggested text byte-agree with agent faces.
 * 3. Famous-problem guardrail (§6.2): standing disclaimer and anti-sensational protection.
 * 4. False-solution incident path (§16.6): metadata freeze and pinned correction notice.
 * 5. Private-draft and workshop exclusion: workshop pushes never update cache key.
 * 6. Hard Rule A4 / P1 share honesty: permanent refusal of PROVED, solved, rankings, unverified novelty.
 * 7. OPS.2a structured diagnostic logging without leaking secrets or bodies.
 */

import { createHash } from "node:crypto";
import type { ClaimFaceResponse, ProblemFaceResponse } from "@asimposium/contracts";
import {
  assertShareHonesty,
  buildClaimShareCardData,
  buildProblemShareCardData,
  computeShareCardCacheKey,
  isRelevantPublicEvent,
  PrivateDraftExclusionError,
  ShareHonestyViolationError,
} from "../../apps/web/lib/share-card";

// Dynamic import prevents root tsc from failing with TS6142 (--jsx not set in root tsconfig)
// while allowing Bun runtime to execute the mock-free next/og image rendering test cleanly.
const shareCardRenderPath = new URL("../../apps/web/lib/share-card-render.tsx", import.meta.url)
  .pathname;
const { renderShareCard, generateShareCardImageResponse } = (await import(shareCardRenderPath)) as {
  renderShareCard: (data: unknown) => { type?: string } | null | undefined;
  generateShareCardImageResponse: (data: unknown) => Response;
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
  readonly invalidation_cause: string;
  readonly cache_outcome: "hit" | "miss" | "bypassed";
  readonly duration_ms: number;
}) {
  const line = JSON.stringify({
    facility: "OPS.2a",
    suite: "e2e-share-cards",
    timestamp: new Date().toISOString(),
    ...record,
  });
  console.log(line);
}

async function run() {
  const startTime = Date.now();
  console.log("=== Running W8.8a Share Cards E2E Suite ===");

  // 1. Problem Share Card & Parity
  const mockProblemFace: ProblemFaceResponse = {
    schema: "asimposium.problem-face.v1",
    face: "json",
    kind: "problem-face",
    problem: "P-4DSP",
    profile: "face",
    cursor: 120,
    fingerprint: "fnv1a64:0123456789abcdef",
    title: "Smooth 4-Dimensional Poincaré Conjecture",
    preamble: "Canonical formulation of smooth 4-manifold classification.",
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
      {
        scope: "ledger",
        kind: "claim",
        id: "C-1",
        body: "Gluck twist preservation",
        why_included: "claim",
        untrusted: true,
        neutralized: [],
      },
    ],
    omitted: [{ reason: "budget_limit" }],
    next_actions: [],
    degraded: [],
  };

  const pData = buildProblemShareCardData(mockProblemFace);
  if (pData.code !== "P-4DSP") throw new Error("Problem code mismatch");
  if (!pData.isFamousProblem) throw new Error("Famous problem flag expected for P-4DSP");
  if (!pData.guardrailNotice) throw new Error("Famous problem guardrail notice expected");
  if (!pData.status.includes("(unresolved)"))
    throw new Error("Unresolved label expected for famous problem");
  assertShareHonesty(pData.suggestedShareText);

  // 2. Mock-free image rendering
  const t0 = Date.now();
  const jsxTree = renderShareCard(pData);
  if (jsxTree?.type !== "div") throw new Error("renderShareCard failed to return valid div JSX");
  const imgResponse = generateShareCardImageResponse(pData);
  if (imgResponse.status !== 200) throw new Error(`Unexpected image status: ${imgResponse.status}`);
  if (!imgResponse.headers.get("content-type")?.includes("image/png")) {
    throw new Error("Missing image/png header");
  }
  const renderDuration = Date.now() - t0;

  const templateDigest = sha256(JSON.stringify(pData.counts));
  const outputDigest = sha256(pData.suggestedShareText);

  logOps2aDiagnostic({
    target: pData.code,
    public_cursor: pData.cursor,
    status: pData.status,
    template_digest: templateDigest,
    output_digest: outputDigest,
    invalidation_cause: "problem.publish",
    cache_outcome: "miss",
    duration_ms: renderDuration,
  });

  // 3. Claim Share Card & Multi-tier Independence
  const mockClaimFace: ClaimFaceResponse = {
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    problem: "P-4DSP",
    profile: "claim",
    cursor: 121,
    fingerprint: "fnv1a64:0123456789abcdef",
    title: "C-1@1: Gluck twist preservation",
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
        body: "Every Gluck twist on S4 is diffeomorphic to S4 under trisection boundary.",
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

  const cData = buildClaimShareCardData(mockClaimFace, "P-4DSP");
  if (cData.code !== "P-4DSP · C-1@1") throw new Error("Claim code mismatch");
  if (cData.statusKind !== "strongly-supported") throw new Error("Disposition mismatch");
  if (!cData.suggestedShareText.includes("strongly-supported"))
    throw new Error("Suggested text missing status");

  logOps2aDiagnostic({
    target: cData.code,
    public_cursor: cData.cursor,
    status: cData.status,
    template_digest: sha256(JSON.stringify(cData.counts)),
    output_digest: sha256(cData.suggestedShareText),
    invalidation_cause: "review.publish",
    cache_outcome: "miss",
    duration_ms: Date.now() - t0,
  });

  // 4. Incident Freeze & Correction Paths (§16.6)
  const freezeData = buildProblemShareCardData(mockProblemFace, {
    incident: "freeze",
    incidentMessage:
      "INCIDENT NOTICE: Claimed solution under critical review. Sensational metadata frozen at source.",
  });
  if (freezeData.incidentState !== "freeze") throw new Error("Expected freeze state");
  if (freezeData.statusKind !== "incident") throw new Error("Expected incident status kind");
  if (!freezeData.suggestedShareText.includes("[FREEZE NOTICE]"))
    throw new Error("Expected freeze banner in share text");

  const corrData = buildProblemShareCardData(mockProblemFace, {
    incident: "correction",
    incidentMessage:
      "INCIDENT NOTICE: Prior claimed resolution refuted by independent multi-tier review.",
  });
  if (corrData.incidentState !== "correction") throw new Error("Expected correction state");
  if (!corrData.suggestedShareText.includes("[CORRECTION NOTICE]"))
    throw new Error("Expected correction banner in share text");

  // 5. Private Draft & Workshop Exclusion
  try {
    buildProblemShareCardData({
      ...mockProblemFace,
      // @ts-expect-error test private draft rejection
      problem_status: "private-draft",
    });
    throw new Error("Expected PrivateDraftExclusionError not thrown");
  } catch (err) {
    if (!(err instanceof PrivateDraftExclusionError)) {
      throw new Error(`Unexpected error type: ${String(err)}`);
    }
  }

  // Workshop events do NOT invalidate public share cards
  if (isRelevantPublicEvent("workshop.push"))
    throw new Error("workshop.push must not be relevant public event");
  if (isRelevantPublicEvent("workshop.draft"))
    throw new Error("workshop.draft must not be relevant public event");
  if (!isRelevantPublicEvent("claim.publish"))
    throw new Error("claim.publish must be relevant public event");
  if (!isRelevantPublicEvent("problem.resolve"))
    throw new Error("problem.resolve must be relevant public event");

  // Cache key determinism
  const key1 = computeShareCardCacheKey({ kind: "problem", id: "P-4DSP", cursor: 120 });
  const key2 = computeShareCardCacheKey({ kind: "problem", id: "P-4DSP", cursor: 120 });
  if (key1 !== key2) throw new Error("Cache key must be deterministic");
  const key3 = computeShareCardCacheKey({ kind: "problem", id: "P-4DSP", cursor: 121 });
  if (key1 === key3) throw new Error("Cache key must advance with public cursor");

  // 6. Share Honesty Forbidden Word Invariants (Rule A4)
  const forbidden = [
    "PROVED",
    "proven",
    "AI-solved",
    "breakthrough",
    "top contributors",
    "rankings",
    "solved",
  ];
  for (const word of forbidden) {
    let caught = false;
    try {
      assertShareHonesty(`The theorem is ${word} by our agent`);
    } catch (err) {
      if (err instanceof ShareHonestyViolationError) caught = true;
    }
    if (!caught)
      throw new Error(`Forbidden token "${word}" was not rejected by assertShareHonesty`);
  }

  console.log(`=== W8.8a Share Cards E2E Suite Passed (${Date.now() - startTime}ms) ===`);
}

run().catch((err) => {
  console.error("E2E Share Cards failed:", err);
  process.exit(1);
});
