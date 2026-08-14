import { describe, expect, test } from "bun:test";
import {
  MintEnrollmentResponseSchema,
  SponsorEnrollmentDecisionResponseSchema,
  SponsorFellowListResponseSchema,
  SponsorProposalListResponseSchema,
} from "@asimposium/contracts";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { toHex } from "../../src/auth/canonical";
import { authenticateServiceEnvelopeRequest } from "../../src/auth/http";
import { VerificationKeyring } from "../../src/auth/keyring";
import { MemoryNonceStore } from "../../src/auth/nonce";
import { createEnrollmentRouter } from "../../src/enrollment/router";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service";

/**
 * Sponsor-route proof for Propylon W3.3/W3.4: mint, proposal list, decision,
 * and the Fellows list, all behind the signed service envelope. Uses the
 * Agora signer with a real Ed25519 keypair and the in-memory reference store;
 * the D1 path is covered by the production loop proof, not by a mock.
 */

const NOW = 1_786_000_000;
const origin = "https://a.asimposium.invalid";
const SPONSOR = "usr_01JXYZSPONSOR0000000000";

interface Harness {
  app: ReturnType<typeof createEnrollmentRouter>;
  service: EnrollmentService;
  sign(
    body: string,
    route: string,
    action: string,
    method?: string,
    principalId?: string,
  ): Promise<Headers>;
}

async function harness(options?: { withSponsorSeam: false }): Promise<Harness> {
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
    store: new InMemoryEnrollmentStore(),
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
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
    return new Headers(serviceEnvelopeHeaders(envelope));
  };

  const app = createEnrollmentRouter({
    service,
    ...(options?.withSponsorSeam === false
      ? {}
      : {
          verifiedSponsor: async (request, route, action) => {
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
              principal: { type: "sponsor", sponsorId: result.verification.principal.id } as const,
              rawBody: result.rawBody,
            };
          },
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
  return { enrollmentId: json.enrollment_id, secret: json.secret, joinUrl: json.join_url };
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
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  expect(response.status).toBe(202);
  const json = (await response.json()) as { flow_handle: string };
  return json.flow_handle;
}

describe("sponsor enrollment routes", () => {
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
    expect(await response.json()).toMatchObject({ code: "SPONSOR_AUTH_UNAVAILABLE" });
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
    const decisionBody = JSON.stringify({ enrollment_id: enrollmentId, decision: "approve" });
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
        headers: { "content-type": "application/json" },
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
    const fellows = SponsorFellowListResponseSchema.parse(await fellowsResponse.json());
    expect(fellows.fellows).toHaveLength(1);
    expect(fellows.fellows[0]).toMatchObject({
      name: "orchid-vector",
      model: "anthropic/fable-5",
      harness: "claude-code",
      granted_scopes: ["promote", "review"],
    });
  });

  test("deny ends the flow and lists no fellow", async () => {
    const h = await harness();
    const { enrollmentId, secret } = await mintOne(h);
    const flowHandle = await claimOne(h, enrollmentId, secret, "delta-ringer");

    const body = JSON.stringify({ enrollment_id: enrollmentId, decision: "deny" });
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
        headers: { "content-type": "application/json" },
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
    const body = JSON.stringify({ enrollment_id: enrollmentId, decision: "approve" });
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

    const body = JSON.stringify({ enrollment_id: first.enrollmentId, decision: "approve" });
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
    expect(await consumedNonceReplay.json()).toMatchObject({ code: "UNAUTHORIZED" });

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

  test("signed malformed decision bodies teach the contract without lying about proposal state", async () => {
    const h = await harness();
    const pathTarget = "ASIMP-EN-0000000000";
    const cases = [
      "",
      "{not-json",
      '{"decision":"approve"}',
      JSON.stringify({ enrollment_id: pathTarget, decision: "unknown" }),
      JSON.stringify({ enrollment_id: pathTarget, decision: "deny", extra: true }),
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
        example: { enrollment_id: "ASIMP-EN-01JXYZ4K6Q", decision: "approve" },
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
    const body = JSON.stringify({ enrollment_id: target, decision: "approve" });
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
    expect(JSON.parse(responseText)).toMatchObject({ code: "ENROLLMENT_UNAVAILABLE" });
    expect(responseText).not.toContain("private planted service fault");
    expect(responseText).not.toContain("PROPOSAL_NOT_PENDING");
  });
});
