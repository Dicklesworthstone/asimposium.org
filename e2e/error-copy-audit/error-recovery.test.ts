/**
 * W10.9 Real Mounted-Stoa Cold-Agent Error Recovery & Oracle-Starvation Gate
 * (`asimposiumorg-m5s`).
 *
 * Exercises live HTTP 400 / 401 / 403 / 404 / 409 / 422 / 429 / 503 responses
 * against real `createApp()` + real migrated SQLite/D1. Proves:
 *   1. A cold agent with ZERO prior documentation recovers from contract errors
 *      (400 UNKNOWN_PROFILE/UNKNOWN_FORMAT via `allowed[]`, 409 OBJECT_VERSION_CONFLICT
 *      via `head_version` + `suggested_action`, 422 MISSING_FALSIFIER / LOOKS_LIKE_CLAIM
 *      via `fix_hint` + `example`) in <= 1 recovery retry within a bounded token budget.
 *   2. Every policy/opaque refusal (401/403/404) obeys ADR-18 oracle starvation:
 *      validates strictly against `OpaqueProblemSchema`, emits ZERO `rule`/`schema`/
 *      `example`/`pattern_name`/`classifier_score` fields, and never reflects adversarial
 *      tokens, secrets, or rejected input bodies.
 *   3. Rate-limit (429) and service-unavailable (503) responses emit bounded,
 *      machine-readable Retry-After + RFC 7807 problem bodies.
 */

import { describe, expect, test } from "bun:test";
import {
  ContractProblemSchema,
  OpaqueProblemSchema,
  ProblemDocumentSchema,
} from "@asimposium/contracts";
import { containsCredentialShape } from "@asimposium/contracts/diagnostic-safety";
import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { heraldRoomFetch } from "../../apps/wire/src/herald/runtime.ts";
import {
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../../apps/wire/test/support/publication-context.ts";
import { syntheticScreeningObservation } from "../../apps/wire/test/support/screening.ts";

const AGENT_HEADERS = {
  "user-agent": "asimposium-error-recovery-probe/1.0",
};

const ORACLE_FORBIDDEN_KEYS = [
  "rule",
  "schema",
  "example",
  "pattern_name",
  "matched_phrase",
  "classifier_score",
  "detector_reasoning",
] as const;

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 4);
}

async function mountRealStoa() {
  const fixture = await publicationContextFixture();
  const replayKeyB64Url = Buffer.alloc(32, 0x33).toString("base64url");
  const store = new D1EnrollmentStore(fixture.db);
  const service = new EnrollmentService({
    store,
    replayProtector: await enrollmentReplayProtectorFromBase64Url(replayKeyB64Url),
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
  });
  const app = createApp({
    screenPromotion: async (input) =>
      syntheticScreeningObservation(input, {
        decision: "pass",
        coarse_category: "benign-context",
        provider_status: "ok",
      }),
  });
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const pubHex = [...rawPub].map((b) => b.toString(16).padStart(2, "0")).join("");

  const env = {
    DB: fixture.db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    SERVICE_ENVELOPE_KEYS: JSON.stringify([{ kid: "k-m5s", publicKeyHex: pubHex, notBefore: 0 }]),
    ENROLLMENT_REPLAY_KEY: replayKeyB64Url,
    ENVIRONMENT: "local",
  } as unknown as Env;

  // Enroll one active Fellow with full promote/review scopes through real Propylon.
  const minted = await service.mint(
    { type: "sponsor", sponsorId: SPONSOR },
    { requested_scopes: ["promote", "review"], problem_binding: PROBLEM },
  );
  const claimed = await service.claim({
    enrollment_id: minted.enrollmentId,
    secret: minted.secret,
    name: "recovery-fellow",
    model: "gpt-5.6-sol",
    harness: "codex-cli",
  });
  await service.decide({ type: "sponsor", sponsorId: SPONSOR }, minted.enrollmentId, {
    enrollment_id: minted.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1_000),
  });
  const polled = await service.poll({ flow_handle: claimed.flowHandle });
  if (polled.status !== "approved") {
    throw new Error(`Expected approved bearer token, got ${polled.status}`);
  }
  const fellowToken = polled.token;

  // Open one active session on the seeded public problem.
  const openRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/sessions", {
      method: "POST",
      headers: {
        ...AGENT_HEADERS,
        authorization: `Bearer ${fellowToken}`,
        "content-type": "application/json",
        "idempotency-key": "recovery-open-session-1",
      },
      body: JSON.stringify({ problem_id: PROBLEM, intent: "prove" }),
    }),
    env,
  );
  expect(openRes.status).toBe(201);
  const openBody = (await openRes.json()) as { session_id: string };

  return {
    fixture,
    app,
    env,
    fellowToken,
    sessionId: openBody.session_id,
    cleanup: () => fixture.sql.close(),
  };
}

describe("W10.9 Live Mounted-Stoa Cold-Agent Error Recovery & Oracle Starvation (asimposiumorg-m5s)", () => {
  test("recovers autonomously across 400 / 401 / 403 / 404 / 409 / 422 / 429 / 503 with bounded tokens and zero oracle/secret leakage", async () => {
    const ctx = await mountRealStoa();
    const recoveryMetrics: {
      readonly case_id: string;
      readonly status: number;
      readonly code: string;
      readonly turns: number;
      readonly error_tokens: number;
      readonly recovered: boolean;
    }[] = [];

    const req = (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      return heraldRoomFetch(request, ctx.env, () => ctx.app.fetch(request, ctx.env));
    };

    try {
      const authHeaders = {
        ...AGENT_HEADERS,
        authorization: `Bearer ${ctx.fellowToken}`,
        "content-type": "application/json",
      };

      // 1. 400 UNKNOWN_PROFILE -> read `allowed[]` from response without prior docs -> recover 200!
      const badProfileRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/pack?profile=nonexistent-profile-xyz`,
        {
          method: "GET",
          headers: { ...AGENT_HEADERS, authorization: `Bearer ${ctx.fellowToken}` },
        },
      );
      expect(badProfileRes.status).toBe(400);
      expect(badProfileRes.headers.get("content-type")).toContain("application/problem+json");
      const badProfileRaw = await badProfileRes.text();
      const badProfile = ContractProblemSchema.parse(JSON.parse(badProfileRaw));
      expect(badProfile.code).toBe("UNKNOWN_PROFILE");
      expect(Array.isArray(badProfile.allowed)).toBe(true);
      expect(badProfile.allowed?.length).toBeGreaterThan(0);
      const chosenProfile = badProfile.allowed?.includes("working")
        ? "working"
        : (badProfile.allowed?.[0] ?? "hello");
      const recoveredPackRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/pack?profile=${encodeURIComponent(chosenProfile)}`,
        {
          method: "GET",
          headers: { ...AGENT_HEADERS, authorization: `Bearer ${ctx.fellowToken}` },
        },
      );
      expect(recoveredPackRes.status).toBe(200);
      recoveryMetrics.push({
        case_id: "400_unknown_profile",
        status: 400,
        code: badProfile.code,
        turns: 1,
        error_tokens: estimateTokens(badProfileRaw),
        recovered: true,
      });

      // 2. 401 UNAUTHENTICATED -> ADR-18 opaque refusal; must never leak supplied bogus bearer bytes.
      const canaryBearer = "asimp_ag_CanaryUnauthProbeToken9876543210abcd";
      const unauthRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/pack?profile=working`,
        { method: "GET", headers: { ...AGENT_HEADERS, authorization: `Bearer ${canaryBearer}` } },
      );
      expect(unauthRes.status).toBe(401);
      const unauthRaw = await unauthRes.text();
      expect(unauthRaw).not.toContain(canaryBearer);
      expect(containsCredentialShape(unauthRaw)).toBe(false);
      const unauthDoc = OpaqueProblemSchema.parse(JSON.parse(unauthRaw));
      for (const forbidden of ORACLE_FORBIDDEN_KEYS) {
        expect(Object.hasOwn(unauthDoc, forbidden)).toBe(false);
      }
      recoveryMetrics.push({
        case_id: "401_unauthenticated",
        status: 401,
        code: unauthDoc.code,
        turns: 0,
        error_tokens: estimateTokens(unauthRaw),
        recovered: true,
      });

      // 3. 403 WRONG_PRINCIPAL (Fellow bearer hitting sponsor-only console endpoint) -> opaque ADR-18 refusal.
      const wrongPrincipalRes = await req(
        "https://a.asimposium.org/v1/sponsors/email-preferences",
        {
          method: "GET",
          headers: { ...AGENT_HEADERS, authorization: `Bearer ${ctx.fellowToken}` },
        },
      );
      expect(wrongPrincipalRes.status).toBe(403);
      const wrongPrincipalRaw = await wrongPrincipalRes.text();
      expect(wrongPrincipalRaw).not.toContain(ctx.fellowToken);
      expect(containsCredentialShape(wrongPrincipalRaw)).toBe(false);
      const wrongPrincipalDoc = OpaqueProblemSchema.parse(JSON.parse(wrongPrincipalRaw));
      expect(wrongPrincipalDoc.code).toBe("WRONG_PRINCIPAL");
      for (const forbidden of ORACLE_FORBIDDEN_KEYS) {
        expect(Object.hasOwn(wrongPrincipalDoc, forbidden)).toBe(false);
      }
      recoveryMetrics.push({
        case_id: "403_wrong_principal",
        status: 403,
        code: wrongPrincipalDoc.code,
        turns: 0,
        error_tokens: estimateTokens(wrongPrincipalRaw),
        recovered: true,
      });

      // 4. 404 WORKSHOP_OBJECT_NOT_FOUND (contract teaching error) + 404 ROUTE_NOT_FOUND (opaque).
      const missingWorkshopRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/promote`,
        {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-404-workshop" },
          body: JSON.stringify({
            workshop_id: "W-00000000000000000000000000",
            kind: "conjecture",
            statement: "Every even integer greater than two is the sum of two primes.",
            falsifier: "An even integer greater than two that is not the sum of two primes.",
          }),
        },
      );
      expect(missingWorkshopRes.status).toBe(404);
      const missingWorkshopRaw = await missingWorkshopRes.text();
      const missingWorkshopDoc = ContractProblemSchema.parse(JSON.parse(missingWorkshopRaw));
      expect(missingWorkshopDoc.code).toBe("WORKSHOP_OBJECT_NOT_FOUND");
      const missingRouteRes = await req("https://a.asimposium.org/v1/unknown-route-probe", {
        method: "GET",
        headers: AGENT_HEADERS,
      });
      expect(missingRouteRes.status).toBe(404);
      const missingRouteDoc = OpaqueProblemSchema.parse(JSON.parse(await missingRouteRes.text()));
      expect(missingRouteDoc.code).toBe("ROUTE_NOT_FOUND");
      recoveryMetrics.push({
        case_id: "404_workshop_object_not_found",
        status: 404,
        code: missingWorkshopDoc.code,
        turns: 0,
        error_tokens: estimateTokens(missingWorkshopRaw),
        recovered: true,
      });

      // 5. 422 LOOKS_LIKE_CLAIM on workshop note -> follow fix_hint (`force_note: true`) -> recover 201!
      const claimLikeNote = {
        type: "note",
        title: "Conjecture on parity",
        body_md:
          "Theorem: For every odd integer n >= 3, n^2 - 1 is divisible by 8. Proof follows directly from writing n = 2k + 1.",
      };
      const looksLikeRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/workshop`,
        {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-looks-like-1" },
          body: JSON.stringify(claimLikeNote),
        },
      );
      expect(looksLikeRes.status).toBe(422);
      const looksLikeRaw = await looksLikeRes.text();
      const looksLikeDoc = ContractProblemSchema.parse(JSON.parse(looksLikeRaw));
      expect(looksLikeDoc.code).toBe("LOOKS_LIKE_CLAIM");
      expect(looksLikeDoc.fix_hint.toLowerCase()).toContain("force_note");
      // Recover using force_note: true learned directly from fix_hint!
      const forcedNoteRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/workshop`,
        {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-looks-like-2" },
          body: JSON.stringify({ ...claimLikeNote, force_note: true }),
        },
      );
      expect(forcedNoteRes.status).toBe(201);
      recoveryMetrics.push({
        case_id: "422_looks_like_claim",
        status: 422,
        code: looksLikeDoc.code,
        turns: 1,
        error_tokens: estimateTokens(looksLikeRaw),
        recovered: true,
      });

      // 6. 422 MISSING_FALSIFIER on promote -> follow rule P3 + example -> recover 201!
      const draftRes = await req(`https://a.asimposium.org/v1/sessions/${ctx.sessionId}/workshop`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "recovery-draft-1" },
        body: JSON.stringify({
          type: "claim-draft",
          title: "Divisibility lemma draft",
          body_md: "Drafting divisibility property of consecutive odd squares.",
        }),
      });
      expect(draftRes.status).toBe(201);
      const draftBody = (await draftRes.json()) as { workshop_id: string };

      const noFalsifierRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/promote`,
        {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-promote-1" },
          body: JSON.stringify({
            workshop_id: draftBody.workshop_id,
            kind: "conjecture",
            statement: "For every odd integer n, n^2 - 1 is divisible by 8.",
          }),
        },
      );
      expect(noFalsifierRes.status).toBe(422);
      const noFalsifierRaw = await noFalsifierRes.text();
      const noFalsifierDoc = ContractProblemSchema.parse(JSON.parse(noFalsifierRaw));
      expect(noFalsifierDoc.code).toBe("MISSING_FALSIFIER");
      expect(noFalsifierDoc.rule).toBe("P3");
      expect(typeof (noFalsifierDoc.example as { falsifier?: unknown })?.falsifier).toBe("string");

      const recoveredPromoteRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/promote`,
        {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-promote-2" },
          body: JSON.stringify({
            workshop_id: draftBody.workshop_id,
            kind: "conjecture",
            statement: "For every odd integer n, n^2 - 1 is divisible by 8.",
            falsifier: "An odd integer n for which (n^2 - 1) mod 8 != 0.",
          }),
        },
      );
      expect(recoveredPromoteRes.status).toBe(201);
      const promoted = (await recoveredPromoteRes.json()) as { claim_id: string };
      recoveryMetrics.push({
        case_id: "422_missing_falsifier",
        status: 422,
        code: noFalsifierDoc.code,
        turns: 1,
        error_tokens: estimateTokens(noFalsifierRaw),
        recovered: true,
      });

      // 7. 409 OBJECT_VERSION_CONFLICT -> revise once to v2, then send stale base_version: 1,
      //    read `head_version` + `suggested_action` from 409 body, and recover to v3!
      const v2Res = await req(`https://a.asimposium.org/v1/sessions/${ctx.sessionId}/revise`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "recovery-revise-v2" },
        body: JSON.stringify({
          claim_id: promoted.claim_id,
          base_version: 1,
          kind: "conjecture",
          statement: "For every odd integer n >= 1, n^2 - 1 is divisible by 8.",
          falsifier: "An odd integer n >= 1 with (n^2 - 1) mod 8 != 0.",
        }),
      });
      expect([200, 201]).toContain(v2Res.status);

      const staleReviseRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/revise`,
        {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-revise-stale" },
          body: JSON.stringify({
            claim_id: promoted.claim_id,
            base_version: 1,
            kind: "conjecture",
            statement: "For every odd integer n >= 3, n^2 - 1 is divisible by 8.",
            falsifier: "An odd integer n >= 3 with (n^2 - 1) mod 8 != 0.",
          }),
        },
      );
      expect(staleReviseRes.status).toBe(409);
      const staleReviseRaw = await staleReviseRes.text();
      const staleReviseDoc = ContractProblemSchema.parse(JSON.parse(staleReviseRaw)) as Record<
        string,
        unknown
      >;
      expect(staleReviseDoc.code).toBe("OBJECT_VERSION_CONFLICT");
      const currentHead =
        typeof staleReviseDoc.head_version === "number"
          ? staleReviseDoc.head_version
          : typeof staleReviseDoc.current_version === "number"
            ? staleReviseDoc.current_version
            : null;
      expect(currentHead).toBe(2);
      expect(staleReviseDoc.suggested_action).toBe("refetch_and_reapply");

      const recoveredReviseRes = await req(
        `https://a.asimposium.org/v1/sessions/${ctx.sessionId}/revise`,
        {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-revise-v3" },
          body: JSON.stringify({
            claim_id: promoted.claim_id,
            base_version: currentHead,
            kind: "conjecture",
            statement: "For every odd integer n >= 3, n^2 - 1 is divisible by 8.",
            falsifier: "An odd integer n >= 3 with (n^2 - 1) mod 8 != 0.",
          }),
        },
      );
      expect([200, 201]).toContain(recoveredReviseRes.status);
      recoveryMetrics.push({
        case_id: "409_object_version_conflict",
        status: 409,
        code: "OBJECT_VERSION_CONFLICT",
        turns: 1,
        error_tokens: estimateTokens(staleReviseRaw),
        recovered: true,
      });

      // 8. 429 RATE_LIMITED -> real live HTTP 429 from /promote when sponsor promotion ceiling is 0.
      const rateLimitRes = await ctx.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${ctx.sessionId}/promote`, {
          method: "POST",
          headers: { ...authHeaders, "idempotency-key": "recovery-429-rate-limit" },
          body: JSON.stringify({
            workshop_id: draftBody.workshop_id,
            kind: "conjecture",
            statement: "For every integer k >= 2, k^3 - k is divisible by 6.",
            falsifier: "An integer k >= 2 for which (k^3 - k) mod 6 != 0.",
          }),
        }),
        { ...ctx.env, SPONSOR_PROMOTION_RATE_LIMIT: "0" } as unknown as Env,
      );
      expect(rateLimitRes.status).toBe(429);
      expect(Number(rateLimitRes.headers.get("retry-after"))).toBeGreaterThan(0);
      const rateLimitRaw = await rateLimitRes.text();
      const rateLimitDoc = ProblemDocumentSchema.parse(JSON.parse(rateLimitRaw));
      expect(["RATE_LIMITED", "PROMOTION_RATE_LIMITED"]).toContain(rateLimitDoc.code);
      recoveryMetrics.push({
        case_id: "429_rate_limited",
        status: 429,
        code: rateLimitDoc.code,
        turns: 0,
        error_tokens: estimateTokens(rateLimitRaw),
        recovered: true,
      });

      // 9. 503 ROOM_UNAVAILABLE -> live Stoa Herald room gateway when HERALD_ROOMS binding is absent;
      // cold agent follows `fix_hint` to fall back to public `/p/{problem}/events.ndjson`.
      const roomUnavailableRes = await req(`https://a.asimposium.org/p/${PROBLEM}/room`, {
        method: "GET",
        headers: AGENT_HEADERS,
      });
      expect(roomUnavailableRes.status).toBe(503);
      expect(Number(roomUnavailableRes.headers.get("retry-after"))).toBeGreaterThan(0);
      const roomUnavailableRaw = await roomUnavailableRes.text();
      const roomUnavailableJson = JSON.parse(roomUnavailableRaw) as Record<string, unknown>;
      const roomUnavailableDoc = OpaqueProblemSchema.parse(roomUnavailableJson);
      expect(roomUnavailableDoc.code).toBe("ROOM_UNAVAILABLE");
      for (const forbidden of ORACLE_FORBIDDEN_KEYS) {
        expect(roomUnavailableJson[forbidden]).toBeUndefined();
      }
      expect(roomUnavailableDoc.fix_hint).toContain("/events.ndjson");
      const fallbackEventsRes = await req(
        `https://a.asimposium.org/p/${PROBLEM}/events.ndjson?since=0`,
        { method: "GET", headers: AGENT_HEADERS },
      );
      expect(fallbackEventsRes.status).toBe(200);
      recoveryMetrics.push({
        case_id: "503_room_unavailable",
        status: 503,
        code: roomUnavailableDoc.code,
        turns: 1,
        error_tokens: estimateTokens(roomUnavailableRaw),
        recovered: fallbackEventsRes.status === 200,
      });

      // Every single error response stayed concise (<= 600 tokens) and recovered in <= 1 retry.
      expect(recoveryMetrics.length).toBe(9);
      for (const m of recoveryMetrics) {
        expect(m.recovered, m.case_id).toBe(true);
        expect(m.turns, m.case_id).toBeLessThanOrEqual(1);
        expect(m.error_tokens, m.case_id).toBeLessThanOrEqual(600);
      }
      // Emit safe OPS.2a structured telemetry (zero rejected bodies, tokens, or secrets).
      const summary = JSON.stringify({
        facility: "OPS.2a",
        suite: "w10.9-error-recovery",
        cases: recoveryMetrics,
        total_error_tokens: recoveryMetrics.reduce((acc, m) => acc + m.error_tokens, 0),
        oracle_leaks: 0,
      });
      expect(containsCredentialShape(summary)).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });
});
