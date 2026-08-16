import { describe, expect, test } from "bun:test";
import {
  ContractProblemSchema,
  DeviceCodeStartResponseSchema,
  DeviceLookupResponseSchema,
  encodeSponsorFellowCursor,
  MintEnrollmentResponseSchema,
  OpaqueProblemSchema,
  ProblemDocumentSchema,
  SponsorCredentialRevokeResponseSchema,
  SponsorEnrollmentDecisionResponseSchema,
  SponsorFellowLifecycleResponseSchema,
  SponsorFellowListResponseSchema,
  SponsorPanicResponseSchema,
  SponsorProposalListResponseSchema,
} from "@asimposium/contracts";
import type { Hono } from "hono";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { toHex } from "../../src/auth/canonical";
import { authenticateServiceEnvelopeRequest } from "../../src/auth/http";
import { VerificationKeyring } from "../../src/auth/keyring";
import { MemoryNonceStore } from "../../src/auth/nonce";
import { createEnrollmentRouter, type EnrollmentRouterOptions } from "../../src/enrollment/router";
import {
  EnrollmentError,
  EnrollmentPersistenceError,
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
  InMemoryEnrollmentStore,
  SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS,
  SPONSOR_STEP_UP_WINDOW_SECONDS,
  SponsorEnrollmentRateLimitError,
} from "../../src/enrollment/service";

/**
 * Sponsor-route proof for Propylon W3.3/W3.4: mint, proposal list, decision,
 * and the Fellows list, all behind the signed service envelope. Uses the
 * Agora signer with a real Ed25519 keypair and the in-memory reference store;
 * the D1 path is covered by the production loop proof, not by a mock.
 */

const NOW = 1_786_000_000;
const origin = "https://a.asimposium.invalid";
const TEST_STOA_ORIGIN = "https://a.asimposium.org";
const SPONSOR = "usr_01JXYZSPONSOR0000000000";
const FOREIGN_SPONSOR = "usr_01JXYZFOREIGN000000000";
let signedRequestSequence = 0;

interface Harness {
  app: Hono;
  service: EnrollmentService;
  sign(
    body: string,
    route: string,
    action: string,
    method?: string,
    principalId?: string,
  ): Promise<Headers>;
}

async function harness(options?: {
  readonly withSponsorSeam?: false;
  readonly verifiedSponsor?: EnrollmentRouterOptions["verifiedSponsor"];
  readonly clock?: { now(): number };
  readonly store?: InMemoryEnrollmentStore;
}): Promise<Harness> {
  const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const keyring = new VerificationKeyring([
    {
      kid: "agora-sponsor-test",
      publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey))),
      notBefore: 0,
    },
  ]);
  const nonces = new MemoryNonceStore();
  const service = new EnrollmentService({
    stoaOrigin: TEST_STOA_ORIGIN,
    store: options?.store ?? new InMemoryEnrollmentStore(),
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
    clock: options?.clock ?? { now: () => NOW * 1_000 },
  });

  const sign: Harness["sign"] = async (body, route, action, method = "POST", principalId) => {
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "agora-sponsor-test",
      now: NOW,
      method,
      route,
      action,
      principalId: principalId ?? SPONSOR,
      body,
    });
    const headers = new Headers(serviceEnvelopeHeaders(envelope));
    if (method === "POST") {
      signedRequestSequence += 1;
      headers.set("idempotency-key", `sponsor-route-${signedRequestSequence}`);
    }
    return headers;
  };

  const app = createEnrollmentRouter({
    service,
    ...(options?.withSponsorSeam === false
      ? {}
      : {
          verifiedSponsor:
            options?.verifiedSponsor ??
            (async (request, route, action) => {
              const result = await authenticateServiceEnvelopeRequest(request, {
                keyring,
                nonces,
                now: NOW,
                issuer: "agora",
                audience: "stoa",
                route,
                permittedActions: [action],
              });
              if (!result.ok) return result.response;
              return {
                principal: {
                  type: "sponsor",
                  sponsorId: result.verification.principal.id,
                } as const,
                rawBody: result.rawBody,
              };
            }),
        }),
  });

  return { app, service, sign };
}

function envelopeRequest(path: string, headers: Headers, method: string, body?: string): Request {
  return new Request(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function mintOne(
  h: Harness,
  scopes = '["promote","review"]',
): Promise<{
  enrollmentId: string;
  secret: string;
  joinUrl: string;
}> {
  const body = `{"requested_scopes":${scopes}}`;
  const headers = await h.sign(body, "/v1/enrollments", "enrollment.mint");
  const response = await h.app.fetch(envelopeRequest("/v1/enrollments", headers, "POST", body));
  expect(response.status).toBe(201);
  const json = MintEnrollmentResponseSchema.parse(await response.json());
  const [url, fragment] = json.join_url.split("#");
  expect(url).toBe(`https://a.asimposium.org/join/${json.enrollment_id}`);
  expect(fragment).toBe(json.secret);
  return {
    enrollmentId: json.enrollment_id,
    secret: json.secret,
    joinUrl: json.join_url,
  };
}

async function claimOne(
  h: Harness,
  enrollmentId: string,
  secret: string,
  name = "orchid-vector",
): Promise<string> {
  const body = JSON.stringify({
    enrollment_id: enrollmentId,
    secret,
    name,
    model: "anthropic/fable-5",
    harness: "claude-code",
  });
  const response = await h.app.fetch(
    new Request(`${origin}/v1/fellows`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `claim-${enrollmentId}`,
      },
      body,
    }),
  );
  expect(response.status).toBe(202);
  const json = (await response.json()) as { flow_handle: string };
  return json.flow_handle;
}

async function issuedLifecycleFixture(
  h: Harness,
  name: string,
  principal: { readonly type: "sponsor"; readonly sponsorId: string } = {
    type: "sponsor",
    sponsorId: SPONSOR,
  },
) {
  await h.service.bootstrapSponsor(principal);
  const minted = await h.service.mint(principal, { requested_scopes: ["review"] });
  const claimed = await h.service.claim({
    enrollment_id: minted.enrollmentId,
    secret: minted.secret,
    name,
    model: "anthropic/fable-5",
    harness: "claude-code",
  });
  await h.service.decide(principal, minted.enrollmentId, {
    enrollment_id: minted.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: NOW,
  });
  const outcome = await h.service.poll({ flow_handle: claimed.flowHandle });
  if (outcome.status !== "approved") throw new Error("lifecycle fixture token was not issued");
  const fellow = (await h.service.fellows(principal))[0];
  const credential = fellow?.credentials[0];
  if (fellow === undefined || credential === undefined) {
    throw new Error("lifecycle fixture credential was not listed");
  }
  return { principal, token: outcome.token, fellow, credential };
}

describe("sponsor enrollment routes", () => {
  test("an invalid decision-path id teaches before sponsor auth or state lookup", async () => {
    let sponsorAuthCalls = 0;
    const h = await harness({
      verifiedSponsor: async () => {
        sponsorAuthCalls += 1;
        throw new Error("invalid enrollment ids must not reach sponsor authentication");
      },
    });
    const response = await h.app.fetch(
      new Request(`${origin}/v1/enrollments/not-an-enrollment-id/decision`, {
        method: "POST",
        body: '{"private":"must not be parsed or echoed"}',
      }),
    );

    expect(response.status).toBe(422);
    const problem = ProblemDocumentSchema.parse(await response.json());
    expect(problem).toMatchObject({
      code: "ENROLLMENT_ID_INVALID",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
      example: {
        method: "POST",
        path: "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
      },
    });
    expect(JSON.stringify(problem)).not.toContain("not-an-enrollment-id");
    expect(JSON.stringify(problem)).not.toContain("must not be parsed or echoed");
    expect(sponsorAuthCalls).toBe(0);
  });

  test("mint requires the envelope and returns the one-time join URL", async () => {
    const h = await harness();

    const unsigned = await h.app.fetch(
      new Request(`${origin}/v1/enrollments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"requested_scopes":["promote"]}',
      }),
    );
    expect(unsigned.status).toBe(403);
    expect(await unsigned.json()).toMatchObject({ code: "WRONG_PRINCIPAL" });

    const minted = await mintOne(h);
    expect(minted.joinUrl.startsWith("https://a.asimposium.org/join/ASIMP-EN-")).toBe(true);
  });

  test("a Fellow bearer token is refused on sponsor routes", async () => {
    const h = await harness();
    const body = '{"requested_scopes":["promote"]}';
    const headers = await h.sign(body, "/v1/enrollments", "enrollment.mint");
    headers.set("authorization", "Bearer asimp_ag_canary");
    const response = await h.app.fetch(envelopeRequest("/v1/enrollments", headers, "POST", body));
    expect([401, 403]).toContain(response.status);
  });

  test("sponsor routes answer 503 when the auth seam is not configured", async () => {
    const h = await harness({ withSponsorSeam: false });
    const response = await h.app.fetch(new Request(`${origin}/v1/fellows`, { method: "GET" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SPONSOR_AUTH_UNAVAILABLE",
    });
  });

  test("auth-seam throws become one coarse 503 on every sponsor route", async () => {
    const privateMessage = "private keyring or nonce-store failure";
    const h = await harness({
      verifiedSponsor: async () => {
        throw new Error(privateMessage);
      },
    });
    const cases = [
      { method: "POST", path: "/v1/enrollments", body: "{}" },
      { method: "GET", path: "/v1/enrollments/proposals" },
      {
        method: "POST",
        path: "/v1/enrollments/ASIMP-EN-0000000000/decision",
        body: "{}",
      },
      {
        method: "POST",
        path: "/v1/device-lookup",
        examplePath: "/v1/device-lookup",
        body: "{}",
      },
      { method: "GET", path: "/v1/fellows" },
      { method: "POST", path: "/v1/fellows/credentials/revoke", body: "{}" },
      { method: "POST", path: "/v1/fellows/lifecycle", body: "{}" },
      { method: "POST", path: "/v1/sponsors/panic", body: "{}" },
    ] as const;

    for (const scenario of cases) {
      const response = await h.app.fetch(
        new Request(`${origin}${scenario.path}`, {
          method: scenario.method,
          ...(scenario.method === "POST"
            ? { headers: { "content-type": "application/json" } }
            : {}),
          ...("body" in scenario ? { body: scenario.body } : {}),
        }),
      );
      expect(response.status, scenario.path).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text), scenario.path).toMatchObject({
        code: "SPONSOR_AUTH_UNAVAILABLE",
        fix_hint:
          "Retry later. If the failure persists, check the service-envelope keyring and nonce store before re-signing the request.",
      });
      expect(text, scenario.path).not.toContain(privateMessage);
    }
  });

  test("malformed auth-seam success values fail closed as operational errors", async () => {
    const malformed = [
      undefined,
      { principal: { type: "sponsor", sponsorId: SPONSOR } },
      { rawBody: new Uint8Array() },
      {
        principal: { type: "sponsor", sponsorId: "" },
        rawBody: new Uint8Array(),
      },
    ];

    for (const value of malformed) {
      const verifiedSponsor = (async () => value) as unknown as NonNullable<
        EnrollmentRouterOptions["verifiedSponsor"]
      >;
      const h = await harness({ verifiedSponsor });
      const response = await h.app.fetch(
        new Request(`${origin}/v1/enrollments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "SPONSOR_AUTH_UNAVAILABLE",
      });
    }
  });

  test("sponsor JSON writes reject missing and non-JSON media types before authentication", async () => {
    let sponsorAuthCalls = 0;
    const h = await harness({
      verifiedSponsor: async () => {
        sponsorAuthCalls += 1;
        throw new Error("media-type refusal must precede sponsor authentication");
      },
    });
    const routes = [
      "/v1/enrollments",
      "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
      "/v1/sponsors/bootstrap",
      "/v1/device-lookup",
      "/v1/fellows/credentials/revoke",
      "/v1/fellows/lifecycle",
      "/v1/sponsors/panic",
    ] as const;
    for (const route of routes) {
      for (const contentType of [undefined, "text/plain", "application/json-seq"] as const) {
        const response = await h.app.fetch(
          new Request(`${origin}${route}`, {
            method: "POST",
            ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
            body: contentType === undefined ? new TextEncoder().encode("{}") : "{}",
          }),
        );
        expect(response.status, `${route}:${contentType ?? "missing"}`).toBe(415);
        expect(await response.json(), `${route}:${contentType ?? "missing"}`).toMatchObject({
          code: "JSON_CONTENT_TYPE_REQUIRED",
          rule: "A5",
          schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
          example: {
            method: "POST",
            headers: { "content-type": "application/json" },
          },
        });
      }
    }
    expect(sponsorAuthCalls).toBe(0);
  });

  test("sponsor routes reject unsigned query components before authentication", async () => {
    const h = await harness({ withSponsorSeam: false });
    const canary = "query-canary-must-not-echo";
    const cases = [
      {
        method: "POST",
        path: "/v1/enrollments",
        examplePath: "/v1/enrollments",
        body: "{}",
      },
      {
        method: "GET",
        path: "/v1/enrollments/proposals",
        examplePath: "/v1/enrollments/proposals",
      },
      {
        method: "POST",
        path: "/v1/enrollments/ASIMP-EN-0000000000/decision",
        examplePath: "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
        body: "{}",
      },
      {
        method: "POST",
        path: "/v1/sponsors/bootstrap",
        examplePath: "/v1/sponsors/bootstrap",
        body: "{}",
      },
      {
        method: "POST",
        path: "/v1/device-lookup",
        examplePath: "/v1/device-lookup",
        body: '{"user_code":"ABCD-2345"}',
      },
      { method: "GET", path: "/v1/fellows", examplePath: "/v1/fellows" },
      {
        method: "GET",
        path: "/v1/fellows/after/f1.djF8MTM6MTc4NjgwMDAwMDAwMHwxMzpmZWxsb3ctMDFKWFla",
        examplePath: "/v1/fellows/after/<cursor>",
      },
      {
        method: "POST",
        path: "/v1/fellows/credentials/revoke",
        examplePath: "/v1/fellows/credentials/revoke",
        body: "{}",
      },
      {
        method: "POST",
        path: "/v1/fellows/lifecycle",
        examplePath: "/v1/fellows/lifecycle",
        body: "{}",
      },
      {
        method: "POST",
        path: "/v1/sponsors/panic",
        examplePath: "/v1/sponsors/panic",
        body: "{}",
      },
    ] as const;

    for (const scenario of cases) {
      const response = await h.app.fetch(
        new Request(`${origin}${scenario.path}?credential=${canary}`, {
          method: scenario.method,
          ...("body" in scenario ? { body: scenario.body } : {}),
        }),
      );
      expect(response.status, scenario.path).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text), scenario.path).toMatchObject({
        code: "PATH_ONLY_REQUIRED",
        rule: "A5",
        schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
        example: {
          method: scenario.method,
          path: scenario.examplePath,
          query: "none",
        },
      });
      expect(text, scenario.path).not.toContain(canary);
      expect(text, scenario.path).not.toContain("SPONSOR_AUTH_UNAVAILABLE");
    }
  });

  test("a malformed signed mint body teaches the mint contract", async () => {
    const h = await harness();
    const body = "{not-json";
    const headers = await h.sign(body, "/v1/enrollments", "enrollment.mint");
    const response = await h.app.fetch(envelopeRequest("/v1/enrollments", headers, "POST", body));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "MINT_BODY_INVALID",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
      example: {
        method: "POST",
        path: "/v1/enrollments",
        headers: { "content-type": "application/json" },
        body: { requested_scopes: ["promote"] },
      },
    });
  });

  test("a decision-time name collision gives an executable deny-and-remint recovery", async () => {
    const h = await harness();
    const first = await mintOne(h);
    await claimOne(h, first.enrollmentId, first.secret, "collision-orchid");
    const second = await mintOne(h);
    await claimOne(h, second.enrollmentId, second.secret, "collision-orchid");

    const approve = async (
      enrollmentId: string,
      decisionSegment = "decision",
    ): Promise<Response> => {
      const body = JSON.stringify({
        enrollment_id: enrollmentId,
        decision: "approve",
        step_up_authenticated_at: NOW,
      });
      const headers = await h.sign(
        body,
        "/v1/enrollments/:enrollmentId/decision",
        "enrollment.decide",
      );
      return h.app.fetch(
        envelopeRequest(
          `/v1/enrollments/${enrollmentId}/${decisionSegment}`,
          headers,
          "POST",
          body,
        ),
      );
    };

    expect((await approve(first.enrollmentId)).status).toBe(200);
    const collision = await approve(second.enrollmentId, "%64ecision");
    expect(collision.status).toBe(422);
    expect(await collision.json()).toMatchObject({
      code: "NAME_TAKEN",
      suggestions: expect.arrayContaining([expect.any(String)]),
      example: {
        enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
        decision: "deny",
        step_up_authenticated_at: 1_786_800_000,
      },
    });

    const impossibleRenameBody = JSON.stringify({
      enrollment_id: second.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW,
      name: "one-suggestion-cannot-go-here",
    });
    const impossibleRenameHeaders = await h.sign(
      impossibleRenameBody,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const impossibleRename = await h.app.fetch(
      envelopeRequest(
        `/v1/enrollments/${second.enrollmentId}/decision`,
        impossibleRenameHeaders,
        "POST",
        impossibleRenameBody,
      ),
    );
    expect(impossibleRename.status).toBe(422);
    expect(await impossibleRename.json()).toMatchObject({
      code: "DECISION_BODY_INVALID",
    });

    const denyBody = JSON.stringify({
      enrollment_id: second.enrollmentId,
      decision: "deny",
      step_up_authenticated_at: NOW,
    });
    const denyHeaders = await h.sign(
      denyBody,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const denied = await h.app.fetch(
      envelopeRequest(
        `/v1/enrollments/${second.enrollmentId}/decision`,
        denyHeaders,
        "POST",
        denyBody,
      ),
    );
    expect(denied.status).toBe(200);
  });

  test("the full loop: mint, claim, card, approve, token, hello, fellows", async () => {
    const h = await harness();
    const { enrollmentId, secret } = await mintOne(h);
    const flowHandle = await claimOne(h, enrollmentId, secret);

    // The approval card list shows the pending proposal in contract shape.
    const listHeaders = await h.sign(
      "",
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
      "GET",
    );
    const list = await h.app.fetch(
      envelopeRequest("/v1/enrollments/proposals", listHeaders, "GET"),
    );
    expect(list.status).toBe(200);
    const cards = SponsorProposalListResponseSchema.parse(await list.json());
    expect(cards.proposals).toHaveLength(1);
    expect(cards.proposals[0]).toMatchObject({
      enrollment_id: enrollmentId,
      status: "pending",
      name: "orchid-vector",
      effective_granted_scopes: null,
    });

    // Approve.
    const decisionBody = JSON.stringify({
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const decisionHeaders = await h.sign(
      decisionBody,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const decided = await h.app.fetch(
      envelopeRequest(
        `/v1/enrollments/${enrollmentId}/decision`,
        decisionHeaders,
        "POST",
        decisionBody,
      ),
    );
    expect(decided.status).toBe(200);
    expect(SponsorEnrollmentDecisionResponseSchema.parse(await decided.json())).toEqual({
      acknowledged: true,
    });

    // The proposal list is empty after the decision.
    const listHeaders2 = await h.sign(
      "",
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
      "GET",
    );
    const list2 = await h.app.fetch(
      envelopeRequest("/v1/enrollments/proposals", listHeaders2, "GET"),
    );
    expect(SponsorProposalListResponseSchema.parse(await list2.json()).proposals).toHaveLength(0);

    // The agent polls and wins the one token.
    const poll = await h.app.fetch(
      new Request(`${origin}/v1/fellows/flow`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "full-loop-poll",
        },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
    );
    expect(poll.status).toBe(200);
    const outcome = (await poll.json()) as { status: string; token?: string };
    expect(outcome.status).toBe("approved");
    expect(outcome.token?.startsWith("asimp_ag_")).toBe(true);

    // Hello works with the issued bearer.
    const hello = await h.app.fetch(
      new Request(`${origin}/v1/hello`, {
        headers: { authorization: `Bearer ${outcome.token}` },
      }),
    );
    expect(hello.status).toBe(200);

    // The Fellows list shows the approved grant, newest first.
    const fellowsHeaders = await h.sign("", "/v1/fellows", "fellows.list", "GET");
    const fellowsResponse = await h.app.fetch(
      envelopeRequest("/v1/fellows", fellowsHeaders, "GET"),
    );
    expect(fellowsResponse.status).toBe(200);
    const fellowPayload = await fellowsResponse.json();
    const fellows = SponsorFellowListResponseSchema.parse(fellowPayload);
    expect(fellows.fellows).toHaveLength(1);
    expect(fellows.fellows[0]).toMatchObject({
      status: "active",
      name: "orchid-vector",
      model: "anthropic/fable-5",
      harness: "claude-code",
      granted_scopes: ["promote", "review"],
      credentials: [
        {
          profile: "bearer",
          active: true,
        },
      ],
    });
    expect(fellows.fellows[0]?.fellow_id.startsWith("F-")).toBe(true);
    expect(fellows.fellows[0]?.credentials[0]?.last_used_at).toBeInteger();
    expect(
      (fellows.fellows[0]?.credentials[0]?.expires_at ?? 0) -
        (fellows.fellows[0]?.credentials[0]?.issued_at ?? 0),
    ).toBe(365 * 24 * 60 * 60 * 1_000);
    const serializedFellows = JSON.stringify(fellowPayload);
    expect(serializedFellows).not.toContain(outcome.token as string);
    expect(serializedFellows).not.toContain("token_hash");
  });

  test("PLANTED: tied 501st Fellow is reachable only through its signed keyset continuation", async () => {
    const store = new InMemoryEnrollmentStore();
    const h = await harness({ store });
    const grantedAt = NOW * 1_000;
    const dayPlusOne = 24 * 60 * 60 * 1_000 + 1;

    for (let index = 0; index <= 500; index += 1) {
      const suffix = String(index).padStart(4, "0");
      await store.create({
        enrollmentId: `ASIMP-EN-PAGE${suffix}`,
        sponsorId: SPONSOR,
        secretHash: `page-secret-${suffix}`,
        createdAt: grantedAt + index * dayPlusOne,
        secretExpiresAt: grantedAt + index * dayPlusOne + 1,
        requestedScopes: ["review"],
        requestedResources: {},
        invalidated: false,
        proposal: {
          proposalId: `page-proposal-${suffix}`,
          fellowId: `F-page-${suffix}`,
          flowHandleHash: `page-flow-${suffix}`,
          name: `page-fellow-${suffix}`,
          model: "example/page-model",
          harness: "codex",
          createdAt: grantedAt + index * dayPlusOne,
          expiresAt: grantedAt + index * dayPlusOne + 1,
          status: "approved",
          grantedScopes: ["review"],
          grantedResources: {},
          grantedAt,
          pollIntervalSeconds: 5,
        },
      });
    }

    const firstHeaders = await h.sign("", "/v1/fellows", "fellows.list", "GET");
    const firstResponse = await h.app.fetch(envelopeRequest("/v1/fellows", firstHeaders, "GET"));
    expect(firstResponse.status).toBe(200);
    const first = SponsorFellowListResponseSchema.parse(await firstResponse.json());
    expect(first.fellows).toHaveLength(500);
    expect(first.fellows[0]?.fellow_id).toBe("F-page-0000");
    expect(first.fellows.at(-1)?.fellow_id).toBe("F-page-0499");
    expect(first.next_cursor).not.toBeNull();
    if (first.next_cursor === null) throw new Error("501st Fellow did not produce a continuation");

    const afterHeaders = await h.sign("", "/v1/fellows/after/:cursor", "fellows.list", "GET");
    const afterResponse = await h.app.fetch(
      envelopeRequest(`/v1/fellows/after/${first.next_cursor}`, afterHeaders, "GET"),
    );
    expect(afterResponse.status).toBe(200);
    const after = SponsorFellowListResponseSchema.parse(await afterResponse.json());
    expect(after).toMatchObject({
      fellows: [{ fellow_id: "F-page-0500", granted_at: grantedAt }],
      next_cursor: null,
    });
    expect(after.fellows).toHaveLength(1);
  });

  test("PLANTED: an invalid cursor is refused before sponsor auth, while a query wins that order", async () => {
    let sponsorAuthCalls = 0;
    const h = await harness({
      verifiedSponsor: async () => {
        sponsorAuthCalls += 1;
        throw new Error("cursor rejection must happen before authentication");
      },
    });
    const invalid = await h.app.fetch(
      new Request(`${origin}/v1/fellows/after/f1.not-a-canonical-cursor`, { method: "GET" }),
    );
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      code: "FELLOW_LIST_CURSOR_INVALID",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
      example: { method: "GET", path: expect.stringContaining("/v1/fellows/after/f1.") },
    });
    expect(sponsorAuthCalls).toBe(0);

    const queryCanary = "cursor-query-must-win-order";
    const query = await h.app.fetch(
      new Request(
        `${origin}/v1/fellows/after/f1.not-a-canonical-cursor?credential=${queryCanary}`,
        { method: "GET" },
      ),
    );
    expect(query.status).toBe(400);
    const queryText = await query.text();
    expect(JSON.parse(queryText)).toMatchObject({ code: "PATH_ONLY_REQUIRED" });
    expect(queryText).not.toContain(queryCanary);
    expect(sponsorAuthCalls).toBe(0);
  });

  test("PLANTED: a signed Fellow continuation is sponsor-scoped and its envelope cannot replay", async () => {
    const h = await harness();
    const fixture = await issuedLifecycleFixture(h, "cursor-owner");
    const ownerListHeaders = await h.sign("", "/v1/fellows", "fellows.list", "GET");
    const ownerList = SponsorFellowListResponseSchema.parse(
      await (await h.app.fetch(envelopeRequest("/v1/fellows", ownerListHeaders, "GET"))).json(),
    );
    expect(ownerList.next_cursor).toBeNull();
    expect(ownerList.fellows[0]?.fellow_id).toBe(fixture.fellow.fellowId);
    const ownerGrantedAt = ownerList.fellows[0]?.granted_at;
    if (ownerGrantedAt === undefined)
      throw new Error("owner Fellow was not present on the first page");
    // This key is immediately before the owner in descending grant order. If
    // the continuation lost its sponsor predicate, the foreign call below
    // would return cursor-owner; a key past that row would hide the regression.
    const ownerCursor = encodeSponsorFellowCursor({
      granted_at: ownerGrantedAt + 1,
      fellow_id: "fellow-cursor-floor",
    });
    const ownerHeaders = await h.sign("", "/v1/fellows/after/:cursor", "fellows.list", "GET");
    const ownerResponse = await h.app.fetch(
      envelopeRequest(`/v1/fellows/after/${ownerCursor}`, ownerHeaders, "GET"),
    );
    expect(ownerResponse.status).toBe(200);
    expect(SponsorFellowListResponseSchema.parse(await ownerResponse.json()).fellows).toEqual([
      expect.objectContaining({ fellow_id: fixture.fellow.fellowId }),
    ]);
    const foreignHeaders = await h.sign(
      "",
      "/v1/fellows/after/:cursor",
      "fellows.list",
      "GET",
      FOREIGN_SPONSOR,
    );
    const foreignResponse = await h.app.fetch(
      envelopeRequest(`/v1/fellows/after/${ownerCursor}`, foreignHeaders, "GET"),
    );
    expect(foreignResponse.status).toBe(200);
    expect(SponsorFellowListResponseSchema.parse(await foreignResponse.json())).toEqual({
      fellows: [],
      next_cursor: null,
    });
    expect((await h.service.fellows(fixture.principal))[0]?.fellowId).toBe(fixture.fellow.fellowId);

    const replayHeaders = await h.sign("", "/v1/fellows/after/:cursor", "fellows.list", "GET");
    const first = await h.app.fetch(
      envelopeRequest(`/v1/fellows/after/${ownerCursor}`, replayHeaders, "GET"),
    );
    expect(first.status).toBe(200);
    const replay = await h.app.fetch(
      envelopeRequest(`/v1/fellows/after/${ownerCursor}`, replayHeaders, "GET"),
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("signed lifecycle routes revoke, replay after step-up expiry, and hide foreign targets", async () => {
    const clock = {
      value: NOW * 1_000,
      now() {
        return this.value;
      },
    };
    const h = await harness({ clock });
    const fixture = await issuedLifecycleFixture(h, "route-revoke-orchid");
    const foreignBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      credential_id: fixture.credential.credentialId,
      confirm: "revoke-credential",
      step_up_authenticated_at: NOW,
    });
    const foreignHeaders = await h.sign(
      foreignBody,
      "/v1/fellows/credentials/revoke",
      "fellow.credential.revoke",
      "POST",
      "usr_foreign_sponsor",
    );
    const foreign = await h.app.fetch(
      envelopeRequest("/v1/fellows/credentials/revoke", foreignHeaders, "POST", foreignBody),
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: "FELLOW_LIFECYCLE_NOT_CURRENT" });
    expect(await h.service.credentialBinding(fixture.token)).toBeDefined();

    const body = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      credential_id: fixture.credential.credentialId,
      confirm: "revoke-credential",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(
      body,
      "/v1/fellows/credentials/revoke",
      "fellow.credential.revoke",
    );
    const replayKey = headers.get("idempotency-key");
    const firstResponse = await h.app.fetch(
      envelopeRequest("/v1/fellows/credentials/revoke", headers, "POST", body),
    );
    expect(firstResponse.status).toBe(200);
    const first = SponsorCredentialRevokeResponseSchema.parse(await firstResponse.json());
    expect(first).toMatchObject({
      acknowledged: true,
      fellow_id: fixture.fellow.fellowId,
      credential_id: fixture.credential.credentialId,
      sponsor_seq: 1,
    });
    const refusedHello = await h.app.fetch(
      new Request(`${origin}/v1/hello`, {
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
    );
    expect(refusedHello.status).toBe(401);

    clock.value += 16 * 60 * 1_000;
    const replayHeaders = await h.sign(
      body,
      "/v1/fellows/credentials/revoke",
      "fellow.credential.revoke",
    );
    if (replayKey === null) throw new Error("fixture idempotency key missing");
    replayHeaders.set("idempotency-key", replayKey);
    const replayResponse = await h.app.fetch(
      envelopeRequest("/v1/fellows/credentials/revoke", replayHeaders, "POST", body),
    );
    expect(replayResponse.status).toBe(200);
    expect(SponsorCredentialRevokeResponseSchema.parse(await replayResponse.json())).toEqual(first);
  });

  test("PLANTED: a foreign sponsor cannot transition another sponsor's Fellow or poison its key", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    const fixture = await issuedLifecycleFixture(h, "route-foreign-transition-target");
    const foreignPrincipal = { type: "sponsor", sponsorId: FOREIGN_SPONSOR } as const;
    const foreignFixture = await issuedLifecycleFixture(
      h,
      "route-foreign-transition-owner",
      foreignPrincipal,
    );
    const key = "foreign-lifecycle-transition-key";
    const foreignBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: NOW,
    });
    const foreignHeaders = await h.sign(
      foreignBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
      "POST",
      FOREIGN_SPONSOR,
    );
    foreignHeaders.set("idempotency-key", key);
    const foreign = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", foreignHeaders, "POST", foreignBody),
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: "FELLOW_LIFECYCLE_NOT_CURRENT" });
    expect((await h.service.fellows(fixture.principal))[0]?.status).toBe("active");
    expect(await h.service.credentialBinding(fixture.token)).toBeDefined();

    // Same foreign principal and key, but a valid target: the refusal above
    // must not leave an idempotency record that turns this into a replay/conflict.
    const ownedBody = JSON.stringify({
      fellow_id: foreignFixture.fellow.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: NOW,
    });
    const ownedHeaders = await h.sign(
      ownedBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
      "POST",
      FOREIGN_SPONSOR,
    );
    ownedHeaders.set("idempotency-key", key);
    const owned = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", ownedHeaders, "POST", ownedBody),
    );
    expect(owned.status).toBe(200);
    expect(SponsorFellowLifecycleResponseSchema.parse(await owned.json())).toMatchObject({
      fellow_id: foreignFixture.fellow.fellowId,
      status: "paused",
    });
  });

  test("PLANTED: an illegal lifecycle transition neither mutates nor claims its key", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    const fixture = await issuedLifecycleFixture(h, "route-illegal-transition");
    const key = "illegal-lifecycle-transition-key";
    const illegalBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      status: "archived",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: NOW,
    });
    const illegalHeaders = await h.sign(
      illegalBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    illegalHeaders.set("idempotency-key", key);
    const illegal = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", illegalHeaders, "POST", illegalBody),
    );
    expect(illegal.status).toBe(404);
    expect(await illegal.json()).toMatchObject({ code: "FELLOW_LIFECYCLE_NOT_CURRENT" });
    expect((await h.service.fellows(fixture.principal))[0]?.status).toBe("active");
    expect(await h.service.credentialBinding(fixture.token)).toBeDefined();

    const legalBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: NOW,
    });
    const legalHeaders = await h.sign(
      legalBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    legalHeaders.set("idempotency-key", key);
    const legal = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", legalHeaders, "POST", legalBody),
    );
    expect(legal.status).toBe(200);
    expect(SponsorFellowLifecycleResponseSchema.parse(await legal.json())).toMatchObject({
      fellow_id: fixture.fellow.fellowId,
      status: "paused",
    });
  });

  test("PLANTED: a first-use stale step-up cannot mutate or reserve a lifecycle key", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    const fixture = await issuedLifecycleFixture(h, "route-stale-lifecycle-step-up");
    const key = "stale-lifecycle-step-up-key";
    const staleBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at:
        NOW - SPONSOR_STEP_UP_WINDOW_SECONDS - SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS - 1,
    });
    const staleHeaders = await h.sign(
      staleBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    staleHeaders.set("idempotency-key", key);
    const stale = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", staleHeaders, "POST", staleBody),
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect((await h.service.fellows(fixture.principal))[0]?.status).toBe("active");
    expect(await h.service.credentialBinding(fixture.token)).toBeDefined();

    // The timestamp is not part of the stable intent digest. A reauthenticated
    // retry must be the first committed use of this key, not a stale replay.
    const freshBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: NOW,
    });
    const freshHeaders = await h.sign(
      freshBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    freshHeaders.set("idempotency-key", key);
    const fresh = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", freshHeaders, "POST", freshBody),
    );
    expect(fresh.status).toBe(200);
    expect(SponsorFellowLifecycleResponseSchema.parse(await fresh.json())).toMatchObject({
      fellow_id: fixture.fellow.fellowId,
      status: "paused",
    });
  });

  test("PLANTED: a live lifecycle key rejects a different intent without mutation or replay drift", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    const fixture = await issuedLifecycleFixture(h, "route-lifecycle-key-conflict");
    const key = "lifecycle-intent-conflict-key";
    const pausedBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: NOW,
    });
    const pausedHeaders = await h.sign(
      pausedBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    pausedHeaders.set("idempotency-key", key);
    const first = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", pausedHeaders, "POST", pausedBody),
    );
    expect(first.status).toBe(200);
    const firstPayload = SponsorFellowLifecycleResponseSchema.parse(await first.json());

    const resumeBody = JSON.stringify({
      fellow_id: fixture.fellow.fellowId,
      status: "active",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: NOW,
    });
    const resumeHeaders = await h.sign(
      resumeBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    resumeHeaders.set("idempotency-key", key);
    const conflict = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", resumeHeaders, "POST", resumeBody),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await h.service.fellows(fixture.principal))[0]?.status).toBe("paused");

    const replayHeaders = await h.sign(
      pausedBody,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    replayHeaders.set("idempotency-key", key);
    const replay = await h.app.fetch(
      envelopeRequest("/v1/fellows/lifecycle", replayHeaders, "POST", pausedBody),
    );
    expect(replay.status).toBe(200);
    expect(SponsorFellowLifecycleResponseSchema.parse(await replay.json())).toEqual(firstPayload);
  });

  test("pause, resume, compromise, and panic return typed sponsor-only audit acknowledgements", async () => {
    const clock = {
      value: NOW * 1_000,
      now() {
        return this.value;
      },
    };
    const h = await harness({ clock });
    const fixture = await issuedLifecycleFixture(h, "route-lifecycle-orchid");
    let expectedSequence = 1;
    for (const status of ["paused", "active", "suspicious_review", "compromised"] as const) {
      const body = JSON.stringify({
        fellow_id: fixture.fellow.fellowId,
        status,
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: NOW,
      });
      const headers = await h.sign(body, "/v1/fellows/lifecycle", "fellow.lifecycle.change");
      const response = await h.app.fetch(
        envelopeRequest("/v1/fellows/lifecycle", headers, "POST", body),
      );
      expect(response.status).toBe(200);
      expect(SponsorFellowLifecycleResponseSchema.parse(await response.json())).toMatchObject({
        acknowledged: true,
        fellow_id: fixture.fellow.fellowId,
        status,
        sponsor_seq: expectedSequence,
      });
      expectedSequence += 1;
    }
    expect((await h.service.fellows(fixture.principal))[0]?.status).toBe("compromised");

    const panicBody = JSON.stringify({
      confirm: "revoke-all-fellow-credentials",
      step_up_authenticated_at: NOW,
    });
    const panicHeaders = await h.sign(panicBody, "/v1/sponsors/panic", "sponsor.panic");
    const panic = await h.app.fetch(
      envelopeRequest("/v1/sponsors/panic", panicHeaders, "POST", panicBody),
    );
    expect(panic.status).toBe(200);
    expect(SponsorPanicResponseSchema.parse(await panic.json())).toMatchObject({
      acknowledged: true,
      sponsor_seq: expectedSequence,
    });
  });

  test("sponsor panic immediately disables a live route-issued credential", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    const fixture = await issuedLifecycleFixture(h, "route-live-panic-orchid");
    expect(await h.service.credentialBinding(fixture.token)).toBeDefined();
    const body = JSON.stringify({
      confirm: "revoke-all-fellow-credentials",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(body, "/v1/sponsors/panic", "sponsor.panic");
    const response = await h.app.fetch(
      envelopeRequest("/v1/sponsors/panic", headers, "POST", body),
    );
    expect(response.status).toBe(200);
    expect(SponsorPanicResponseSchema.parse(await response.json())).toMatchObject({
      acknowledged: true,
      sponsor_seq: 1,
    });
    expect(await h.service.credentialBinding(fixture.token)).toBeUndefined();
  });

  test("lifecycle route contract and idempotency failures teach without target evidence", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    const malformedBody = JSON.stringify({
      fellow_id: "F-example",
      credential_id: "cred-example",
      confirm: "wrong-confirmation",
      step_up_authenticated_at: NOW,
    });
    const malformedHeaders = await h.sign(
      malformedBody,
      "/v1/fellows/credentials/revoke",
      "fellow.credential.revoke",
    );
    const malformed = await h.app.fetch(
      envelopeRequest("/v1/fellows/credentials/revoke", malformedHeaders, "POST", malformedBody),
    );
    expect(malformed.status).toBe(422);
    expect(ContractProblemSchema.parse(await malformed.json())).toMatchObject({
      code: "CREDENTIAL_REVOKE_BODY_INVALID",
      rule: "A5",
    });

    const validBody = JSON.stringify({
      confirm: "revoke-all-fellow-credentials",
      step_up_authenticated_at: NOW,
    });
    const noKeyHeaders = await h.sign(validBody, "/v1/sponsors/panic", "sponsor.panic");
    noKeyHeaders.delete("idempotency-key");
    const noKey = await h.app.fetch(
      envelopeRequest("/v1/sponsors/panic", noKeyHeaders, "POST", validBody),
    );
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });
  });

  test("lifecycle contention is a coarse retryable 429 rather than a database outage", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    h.service.panicSponsor = async () => {
      throw new EnrollmentError("LIFECYCLE_BUSY");
    };
    const body = JSON.stringify({
      confirm: "revoke-all-fellow-credentials",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(body, "/v1/sponsors/panic", "sponsor.panic");
    const response = await h.app.fetch(
      envelopeRequest("/v1/sponsors/panic", headers, "POST", body),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    const payload = await response.json();
    expect(OpaqueProblemSchema.parse(payload)).toMatchObject({
      code: "LIFECYCLE_BUSY",
      status: 429,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SPONSOR);
    expect(serialized).not.toContain("database");
  });

  test("the sponsor Fellow cap is a coarse 409 and exposes no policy internals", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    h.service.decide = async () => {
      throw new EnrollmentError("FELLOW_CAP_REACHED");
    };
    const enrollmentId = "ASIMP-EN-01JXYZ4K6Q";
    const body = JSON.stringify({
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const response = await h.app.fetch(
      envelopeRequest(`/v1/enrollments/${enrollmentId}/decision`, headers, "POST", body),
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(OpaqueProblemSchema.parse(payload)).toMatchObject({
      code: "FELLOW_CAP_REACHED",
      status: 409,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SPONSOR);
    expect(serialized).not.toContain("active_fellow_limit");
    expect(serialized).not.toContain("database");
  });

  test("the sponsor enrollment budget is an opaque retryable 429", async () => {
    const h = await harness({ clock: { now: () => NOW * 1_000 } });
    h.service.decide = async () => {
      throw new SponsorEnrollmentRateLimitError(90_001);
    };
    const enrollmentId = "ASIMP-EN-01JXYZ4K6Q";
    const body = JSON.stringify({
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const response = await h.app.fetch(
      envelopeRequest(`/v1/enrollments/${enrollmentId}/decision`, headers, "POST", body),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90001");
    expect(response.headers.get("ratelimit-limit")).toBe("10");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(response.headers.get("ratelimit-reset")).toBe("90001");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const payload = await response.json();
    expect(OpaqueProblemSchema.parse(payload)).toMatchObject({
      code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
      status: 429,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SPONSOR);
    expect(serialized).not.toContain("database");
  });

  test("an elapsed pre-approval grant leaves no impossible card or misleading retry loop", async () => {
    const clock = {
      value: NOW * 1_000,
      now() {
        return this.value;
      },
    };
    const h = await harness({ clock });
    const mintBody = JSON.stringify({
      requested_scopes: ["review"],
      fellow_grant_expires_in_ms: 1,
    });
    const mintHeaders = await h.sign(mintBody, "/v1/enrollments", "enrollment.mint");
    const mintResponse = await h.app.fetch(
      envelopeRequest("/v1/enrollments", mintHeaders, "POST", mintBody),
    );
    expect(mintResponse.status).toBe(201);
    const minted = MintEnrollmentResponseSchema.parse(await mintResponse.json());
    await claimOne(h, minted.enrollment_id, minted.secret, "elapsed-grant");
    clock.value += 1;

    const decide = async (): Promise<Response> => {
      const body = JSON.stringify({
        enrollment_id: minted.enrollment_id,
        decision: "approve",
        step_up_authenticated_at: NOW,
      });
      const headers = await h.sign(
        body,
        "/v1/enrollments/:enrollmentId/decision",
        "enrollment.decide",
      );
      return h.app.fetch(
        envelopeRequest(`/v1/enrollments/${minted.enrollment_id}/decision`, headers, "POST", body),
      );
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await decide();
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "PROPOSAL_EXPIRED",
        title: "No pending proposal here",
      });
    }

    const listHeaders = await h.sign(
      "",
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
      "GET",
    );
    const list = await h.app.fetch(
      envelopeRequest("/v1/enrollments/proposals", listHeaders, "GET"),
    );
    expect(list.status).toBe(200);
    expect(SponsorProposalListResponseSchema.parse(await list.json()).proposals).toEqual([]);
    expect(await h.service.fellows({ type: "sponsor", sponsorId: SPONSOR })).toEqual([]);
  });

  test("deny ends the flow and lists no fellow", async () => {
    const h = await harness();
    const { enrollmentId, secret } = await mintOne(h);
    const flowHandle = await claimOne(h, enrollmentId, secret, "delta-ringer");

    const body = JSON.stringify({
      enrollment_id: enrollmentId,
      decision: "deny",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const decided = await h.app.fetch(
      envelopeRequest(`/v1/enrollments/${enrollmentId}/decision`, headers, "POST", body),
    );
    expect(decided.status).toBe(200);

    const poll = await h.app.fetch(
      new Request(`${origin}/v1/fellows/flow`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "deny-loop-poll",
        },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
    );
    expect(await poll.json()).toMatchObject({ status: "access_denied" });

    const fellowsHeaders = await h.sign("", "/v1/fellows", "fellows.list", "GET");
    const fellows = SponsorFellowListResponseSchema.parse(
      await (await h.app.fetch(envelopeRequest("/v1/fellows", fellowsHeaders, "GET"))).json(),
    );
    expect(fellows.fellows).toHaveLength(0);
  });

  test("one sponsor never reads another sponsor's proposals or fellows", async () => {
    const h = await harness();
    const { enrollmentId, secret } = await mintOne(h);
    await claimOne(h, enrollmentId, secret, "border-keeper");

    const outsiderHeaders = await h.sign(
      "",
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
      "GET",
      "usr_01JXYZOUTSIDER000000000",
    );
    const list = await h.app.fetch(
      envelopeRequest("/v1/enrollments/proposals", outsiderHeaders, "GET"),
    );
    expect(SponsorProposalListResponseSchema.parse(await list.json()).proposals).toHaveLength(0);

    // The outsider's decision attempt is not a pending proposal of theirs.
    const body = JSON.stringify({
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const decisionHeaders = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
      "POST",
      "usr_01JXYZOUTSIDER000000000",
    );
    const decided = await h.app.fetch(
      envelopeRequest(`/v1/enrollments/${enrollmentId}/decision`, decisionHeaders, "POST", body),
    );
    expect([403, 404]).toContain(decided.status);
  });

  test("a signed decision cannot be retargeted through the route template", async () => {
    const h = await harness();
    const first = await mintOne(h);
    const second = await mintOne(h);
    await claimOne(h, first.enrollmentId, first.secret, "first-orchid");
    await claimOne(h, second.enrollmentId, second.secret, "second-orchid");

    const body = JSON.stringify({
      enrollment_id: first.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const retargetHeaders = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    retargetHeaders.set("idempotency-key", "IK-retarget-proof");

    const retargeted = await h.app.fetch(
      envelopeRequest(
        `/v1/enrollments/${second.enrollmentId}/decision`,
        retargetHeaders,
        "POST",
        body,
      ),
    );
    expect(retargeted.status).toBe(422);
    expect(await retargeted.json()).toMatchObject({
      code: "DECISION_TARGET_MISMATCH",
      rule: "ADR-20",
    });

    // Authentication consumes the envelope nonce even though target binding
    // later refuses the product write. Replaying those exact credentials to
    // the correct path therefore fails at authentication.
    const consumedNonceReplay = await h.app.fetch(
      envelopeRequest(
        `/v1/enrollments/${first.enrollmentId}/decision`,
        retargetHeaders,
        "POST",
        body,
      ),
    );
    expect(consumedNonceReplay.status).toBe(401);
    expect(await consumedNonceReplay.json()).toMatchObject({
      code: "UNAUTHORIZED",
    });

    // The mismatch created neither an enrollment-store effect nor a product
    // idempotency row: a fresh envelope with the same product key succeeds for
    // the body-named target, while the path target remains pending.
    const correctHeaders = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    correctHeaders.set("idempotency-key", "IK-retarget-proof");
    const correct = await h.app.fetch(
      envelopeRequest(
        `/v1/enrollments/${first.enrollmentId}/decision`,
        correctHeaders,
        "POST",
        body,
      ),
    );
    expect(correct.status).toBe(200);

    const listHeaders = await h.sign(
      "",
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
      "GET",
    );
    const list = SponsorProposalListResponseSchema.parse(
      await (
        await h.app.fetch(envelopeRequest("/v1/enrollments/proposals", listHeaders, "GET"))
      ).json(),
    );
    expect(list.proposals.map((proposal) => proposal.enrollment_id)).toEqual([second.enrollmentId]);
  });

  test("the Worker owns decision step-up while committed product replay survives expiry", async () => {
    const clock = {
      value: NOW * 1_000,
      now() {
        return this.value;
      },
    };
    const h = await harness({ clock });
    const minted = await mintOne(h);
    await claimOne(h, minted.enrollmentId, minted.secret, "step-up-orchid");

    const send = async (
      command: Record<string, unknown>,
      idempotencyKey: string,
    ): Promise<Response> => {
      const body = JSON.stringify(command);
      const headers = await h.sign(
        body,
        "/v1/enrollments/:enrollmentId/decision",
        "enrollment.decide",
      );
      headers.set("idempotency-key", idempotencyKey);
      return h.app.fetch(
        envelopeRequest(`/v1/enrollments/${minted.enrollmentId}/decision`, headers, "POST", body),
      );
    };

    const missing = await send(
      { enrollment_id: minted.enrollmentId, decision: "approve" },
      "decision-step-up-missing",
    );
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ code: "DECISION_BODY_INVALID" });

    for (const [label, stepUp] of [
      ["stale", NOW - SPONSOR_STEP_UP_WINDOW_SECONDS - SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS - 1],
      ["future", NOW + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1],
    ] as const) {
      const refused = await send(
        {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: stepUp,
        },
        `decision-step-up-${label}`,
      );
      expect(refused.status, label).toBe(403);
      expect(await refused.json(), label).toMatchObject({ code: "STEP_UP_REQUIRED" });
    }
    expect(await h.service.pendingApprovals({ type: "sponsor", sponsorId: SPONSOR })).toHaveLength(
      1,
    );

    const committedCommand = {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS,
    } as const;
    expect(await send(committedCommand, "decision-step-up-replay")).toMatchObject({ status: 200 });
    // The accepted +skew timestamp must itself age past window+skew before the
    // second call, so this proves replay precedence rather than fresh evidence.
    clock.value +=
      (SPONSOR_STEP_UP_WINDOW_SECONDS + 2 * SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1) * 1_000;
    expect(await send(committedCommand, "decision-step-up-replay")).toMatchObject({ status: 200 });
    expect(await h.service.pendingApprovals({ type: "sponsor", sponsorId: SPONSOR })).toEqual([]);
    expect(await h.service.fellows({ type: "sponsor", sponsorId: SPONSOR })).toHaveLength(1);
  });

  test("signed malformed decision bodies teach the contract without lying about proposal state", async () => {
    const h = await harness();
    const pathTarget = "ASIMP-EN-0000000000";
    const cases = [
      "",
      "{not-json",
      '{"decision":"approve"}',
      JSON.stringify({ enrollment_id: pathTarget, decision: "unknown" }),
      JSON.stringify({
        enrollment_id: pathTarget,
        decision: "deny",
        step_up_authenticated_at: NOW,
        extra: true,
      }),
    ];

    for (const body of cases) {
      const headers = await h.sign(
        body,
        "/v1/enrollments/:enrollmentId/decision",
        "enrollment.decide",
      );
      const response = await h.app.fetch(
        envelopeRequest(`/v1/enrollments/${pathTarget}/decision`, headers, "POST", body),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        code: "DECISION_BODY_INVALID",
        rule: "ADR-20",
        schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
        example: {
          method: "POST",
          path: "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "decision-01JXYZ4K6Q",
          },
          body: {
            enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
            decision: "approve",
            step_up_authenticated_at: 1_786_800_000,
          },
        },
      });
    }
  });

  test("authenticated invalid reductions identify the actionable grant error", async () => {
    const h = await harness();
    const { enrollmentId, secret } = await mintOne(h);
    await claimOne(h, enrollmentId, secret);
    const cases = [
      {
        code: "SCOPE_ESCALATION",
        reduction: { scopes: ["upload-artifacts"] },
      },
      {
        code: "SCOPE_NOT_REDUCED",
        reduction: { scopes: ["promote", "review"] },
      },
    ] as const;

    for (const scenario of cases) {
      const body = JSON.stringify({
        enrollment_id: enrollmentId,
        decision: "reduce",
        reduction: scenario.reduction,
        step_up_authenticated_at: NOW,
      });
      const headers = await h.sign(
        body,
        "/v1/enrollments/:enrollmentId/decision",
        "enrollment.decide",
      );
      const response = await h.app.fetch(
        envelopeRequest(`/v1/enrollments/${enrollmentId}/decision`, headers, "POST", body),
      );
      expect(response.status, scenario.code).toBe(422);
      expect(await response.json(), scenario.code).toMatchObject({
        code: scenario.code,
        rule: "ADR-20",
        schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
        example: {
          enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
          decision: "reduce",
          reduction: { scopes: ["review"] },
          step_up_authenticated_at: 1_786_800_000,
        },
      });
    }
  });

  test("an unexpected decision-service fault is an operational refusal, never false state", async () => {
    const h = await harness();
    const target = "ASIMP-EN-0000000000";
    Object.defineProperty(h.service, "decide", {
      value: async () => {
        throw new Error("private planted service fault");
      },
    });
    const body = JSON.stringify({
      enrollment_id: target,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const response = await h.app.fetch(
      envelopeRequest(`/v1/enrollments/${target}/decision`, headers, "POST", body),
    );
    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toMatchObject({
      code: "ENROLLMENT_UNAVAILABLE",
    });
    expect(responseText).not.toContain("private planted service fault");
    expect(responseText).not.toContain("PROPOSAL_NOT_PENDING");
  });

  test("table-driven sponsor service and response-schema faults stay coarse", async () => {
    const privateMessage = "private sponsor service fault PROPOSAL_NOT_PENDING";
    const cases: readonly {
      readonly name: string;
      readonly path: string;
      readonly route: string;
      readonly action: string;
      readonly method: "GET" | "POST";
      readonly body: string;
      readonly plant: (service: EnrollmentService) => void;
      readonly forbidden: readonly string[];
    }[] = [
      {
        name: "mint service Error",
        path: "/v1/enrollments",
        route: "/v1/enrollments",
        action: "enrollment.mint",
        method: "POST",
        body: '{"requested_scopes":["promote"]}',
        plant: (service) => {
          Object.defineProperty(service, "mint", {
            value: async () => {
              throw new Error(privateMessage);
            },
          });
        },
        forbidden: [privateMessage, "PROPOSAL_NOT_PENDING", "PAIRING_INVALID"],
      },
      {
        name: "mint response schema fault",
        path: "/v1/enrollments",
        route: "/v1/enrollments",
        action: "enrollment.mint",
        method: "POST",
        body: '{"requested_scopes":["promote"]}',
        plant: (service) => {
          Object.defineProperty(service, "mint", {
            value: async () => ({
              enrollmentId: "private-schema-state-code",
              expiresAt: 0,
            }),
          });
        },
        forbidden: ["private-schema-state-code", "PAIRING_INVALID"],
      },
      {
        name: "proposal-list service Error",
        path: "/v1/enrollments/proposals",
        route: "/v1/enrollments/proposals",
        action: "enrollment.proposals.list",
        method: "GET",
        body: "",
        plant: (service) => {
          Object.defineProperty(service, "pendingApprovals", {
            value: async () => {
              throw new Error(privateMessage);
            },
          });
        },
        forbidden: [privateMessage, "PROPOSAL_NOT_PENDING", "PAIRING_INVALID"],
      },
      {
        name: "decision service Error",
        path: "/v1/enrollments/ASIMP-EN-0000000000/decision",
        route: "/v1/enrollments/:enrollmentId/decision",
        action: "enrollment.decide",
        method: "POST",
        body: '{"enrollment_id":"ASIMP-EN-0000000000","decision":"approve","step_up_authenticated_at":1786000000}',
        plant: (service) => {
          Object.defineProperty(service, "decide", {
            value: async () => {
              throw new Error(privateMessage);
            },
          });
        },
        forbidden: [privateMessage, "PROPOSAL_NOT_PENDING", "PAIRING_INVALID"],
      },
      {
        name: "fellow-list service Error",
        path: "/v1/fellows",
        route: "/v1/fellows",
        action: "fellows.list",
        method: "GET",
        body: "",
        plant: (service) => {
          Object.defineProperty(service, "fellowPage", {
            value: async () => {
              throw new Error(privateMessage);
            },
          });
        },
        forbidden: [privateMessage, "PROPOSAL_NOT_PENDING", "PAIRING_INVALID"],
      },
      {
        name: "fellow-list response schema fault",
        path: "/v1/fellows",
        route: "/v1/fellows",
        action: "fellows.list",
        method: "GET",
        body: "",
        plant: (service) => {
          Object.defineProperty(service, "fellowPage", {
            value: async () => ({
              fellows: [
                {
                  name: "private-schema-state-code",
                  model: "",
                  harness: "",
                  grantedScopes: [],
                  grantedResources: {},
                  grantedAt: 0,
                },
              ],
            }),
          });
        },
        forbidden: ["private-schema-state-code", "PAIRING_INVALID"],
      },
      {
        name: "fellow continuation authority-corruption fault",
        path: "/v1/fellows/after/f1.djF8MTM6MTc4NjgwMDAwMDAwMHwxMzpmZWxsb3ctMDFKWFla",
        route: "/v1/fellows/after/:cursor",
        action: "fellows.list",
        method: "GET",
        body: "",
        plant: (service) => {
          Object.defineProperty(service, "fellowPage", {
            value: async () => {
              throw new EnrollmentPersistenceError();
            },
          });
        },
        forbidden: [privateMessage, "PROPOSAL_NOT_PENDING", "PAIRING_INVALID"],
      },
    ];

    for (const scenario of cases) {
      const h = await harness();
      scenario.plant(h.service);
      const headers = await h.sign(scenario.body, scenario.route, scenario.action, scenario.method);
      const response = await h.app.fetch(
        envelopeRequest(scenario.path, headers, scenario.method, scenario.body),
      );
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        code: "ENROLLMENT_UNAVAILABLE",
        fix_hint:
          "Retry later. For an authority-producing write, reuse its required original Idempotency-Key. Retry a read-only request normally.",
      });
      for (const forbidden of scenario.forbidden) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  test("a keyed poll replays the issued token; an unkeyed retry is refused", async () => {
    const h = await harness();
    const { enrollmentId, secret } = await mintOne(h);
    const flowHandle = await claimOne(h, enrollmentId, secret, "replay-warden");

    const body = JSON.stringify({
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const headers = await h.sign(
      body,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const decided = await h.app.fetch(
      envelopeRequest(`/v1/enrollments/${enrollmentId}/decision`, headers, "POST", body),
    );
    expect(decided.status).toBe(200);

    const pollBody = JSON.stringify({ flow_handle: flowHandle });
    const keyed = await h.app.fetch(
      new Request(`${origin}/v1/fellows/flow`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "IK-replay-suite",
        },
        body: pollBody,
      }),
    );
    const first = (await keyed.json()) as { status: string; token?: string };
    expect(first.status).toBe("approved");
    expect(first.token?.startsWith("asimp_ag_")).toBe(true);

    // Same key, same body: the exact approval body replays, token included.
    const replay = await h.app.fetch(
      new Request(`${origin}/v1/fellows/flow`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "IK-replay-suite",
        },
        body: pollBody,
      }),
    );
    const second = (await replay.json()) as { status: string; token?: string };
    expect(second.status).toBe("approved");
    expect(second.token).toBe(first.token);

    // No key is refused before one-time state is consulted.
    const unkeyed = await h.app.fetch(
      new Request(`${origin}/v1/fellows/flow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pollBody,
      }),
    );
    expect(unkeyed.status).toBe(400);
  });

  test("sponsor bootstrap creates the row once and is idempotent after", async () => {
    const h = await harness();
    const call = async (body: string) => {
      const headers = await h.sign(body, "/v1/sponsors/bootstrap", "sponsor.bootstrap", "POST");
      return h.app.fetch(envelopeRequest("/v1/sponsors/bootstrap", headers, "POST", body));
    };

    for (const malformed of ["", "not-json", '{"unexpected":true}']) {
      const refusal = await call(malformed);
      expect(refusal.status, malformed).toBe(422);
      expect(await refusal.json(), malformed).toMatchObject({
        code: "SPONSOR_BOOTSTRAP_BODY_INVALID",
        rule: "A5",
        schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
        example: {},
      });
    }

    const first = await call("{}");
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      created: boolean;
      sponsor_id: string;
    };
    expect(created.created).toBe(true);
    expect(created.sponsor_id).toBe(SPONSOR);

    const second = await call("{}");
    expect(second.status).toBe(200);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
  });

  test("the device loop: start, lookup, approve, keyed poll, hello", async () => {
    const h = await harness();

    // An unaffiliated agent starts the flow with its full proposal.
    const start = await h.app.fetch(
      new Request(`${origin}/v1/device-code`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.40",
          "idempotency-key": "device-loop-start",
        },
        body: JSON.stringify({
          name: "device-drifter",
          model: "kimi-code/k3",
          harness: "omp",
          requested_scopes: ["review"],
        }),
      }),
    );
    expect(start.status).toBe(201);
    const started = DeviceCodeStartResponseSchema.parse(await start.json());
    expect(started.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // The unbound proposal appears in NO sponsor's pending list.
    const listHeaders = await h.sign(
      "",
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
      "GET",
    );
    const list = await h.app.fetch(
      envelopeRequest("/v1/enrollments/proposals", listHeaders, "GET"),
    );
    expect(SponsorProposalListResponseSchema.parse(await list.json()).proposals).toHaveLength(0);

    // The sponsor looks it up by the human code and gets the full card.
    const lookupBody = JSON.stringify({ user_code: started.user_code });
    const lookupHeaders = await h.sign(lookupBody, "/v1/device-lookup", "enrollment.device.lookup");
    const lookup = await h.app.fetch(
      envelopeRequest("/v1/device-lookup", lookupHeaders, "POST", lookupBody),
    );
    expect(lookup.status).toBe(200);
    const card = DeviceLookupResponseSchema.parse(await lookup.json()).card;
    expect(card).toMatchObject({ name: "device-drifter", status: "pending" });

    // The decision binds the sponsor and the agent's keyed poll wins the token.
    const decisionBody = JSON.stringify({
      enrollment_id: card.enrollment_id,
      decision: "approve",
      step_up_authenticated_at: NOW,
    });
    const decisionHeaders = await h.sign(
      decisionBody,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    const decided = await h.app.fetch(
      envelopeRequest(
        `/v1/enrollments/${card.enrollment_id}/decision`,
        decisionHeaders,
        "POST",
        decisionBody,
      ),
    );
    expect(decided.status).toBe(200);

    const pollBody = JSON.stringify({ flow_handle: started.device_code });
    const poll = await h.app.fetch(
      new Request(`${origin}/v1/device-token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "IK-device-loop",
        },
        body: pollBody,
      }),
    );
    const outcome = (await poll.json()) as { status: string; token?: string };
    expect(outcome.status).toBe("approved");

    const hello = await h.app.fetch(
      new Request(`${origin}/v1/hello`, {
        headers: { authorization: `Bearer ${outcome.token}` },
      }),
    );
    expect(hello.status).toBe(200);

    // The fellow now appears in the sponsor's list.
    const fellowsHeaders = await h.sign("", "/v1/fellows", "fellows.list", "GET");
    const fellows = SponsorFellowListResponseSchema.parse(
      await (await h.app.fetch(envelopeRequest("/v1/fellows", fellowsHeaders, "GET"))).json(),
    );
    expect(fellows.fellows.map((f) => f.name)).toContain("device-drifter");
  });

  test("device lookup lockout: five failures refuse the sixth", async () => {
    const h = await harness();
    const badBody = JSON.stringify({ user_code: "ABCD-2345" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const headers = await h.sign(badBody, "/v1/device-lookup", "enrollment.device.lookup");
      const res = await h.app.fetch(envelopeRequest("/v1/device-lookup", headers, "POST", badBody));
      expect(res.status).toBe(404);
    }
    const headers = await h.sign(badBody, "/v1/device-lookup", "enrollment.device.lookup");
    const locked = await h.app.fetch(
      envelopeRequest("/v1/device-lookup", headers, "POST", badBody),
    );
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("901");
    expect(await locked.json()).toMatchObject({ code: "DEVICE_LOOKUP_LOCKED" });
  });

  test("a malformed user code teaches the format, not the state", async () => {
    const h = await harness();
    const badBody = JSON.stringify({ user_code: "not-a-code" });
    const headers = await h.sign(badBody, "/v1/device-lookup", "enrollment.device.lookup");
    const res = await h.app.fetch(envelopeRequest("/v1/device-lookup", headers, "POST", badBody));
    expect(res.status).toBe(422);
    const problem = await res.json();
    expect(problem).toMatchObject({
      code: "DEVICE_LOOKUP_BODY_INVALID",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
      example: { user_code: "ABCD-2345" },
    });
    expect(ContractProblemSchema.safeParse(problem).success).toBe(true);
    expect(OpaqueProblemSchema.safeParse(problem).success).toBe(false);
  });

  test("valid-but-unknown user codes remain one opaque non-oracle face", async () => {
    const h = await harness();
    const body = JSON.stringify({ user_code: "ABCD-2345" });
    const headers = await h.sign(body, "/v1/device-lookup", "enrollment.device.lookup");
    const res = await h.app.fetch(envelopeRequest("/v1/device-lookup", headers, "POST", body));
    expect(res.status).toBe(404);
    const problem = await res.json();
    expect(problem).toMatchObject({ code: "DEVICE_CODE_UNKNOWN" });
    expect(problem).not.toHaveProperty("rule");
    expect(problem).not.toHaveProperty("schema");
    expect(problem).not.toHaveProperty("example");
    expect(OpaqueProblemSchema.safeParse(problem).success).toBe(true);
    expect(ContractProblemSchema.safeParse(problem).success).toBe(false);
  });

  test("malformed signed JSON is a teaching lookup error, never a false outage", async () => {
    const h = await harness();
    const body = '{"user_code":';
    const headers = await h.sign(body, "/v1/device-lookup", "enrollment.device.lookup");
    const res = await h.app.fetch(envelopeRequest("/v1/device-lookup", headers, "POST", body));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "DEVICE_LOOKUP_BODY_INVALID",
      rule: "A5",
    });
  });
});
