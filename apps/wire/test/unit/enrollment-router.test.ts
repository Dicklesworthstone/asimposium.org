import { describe, expect, test } from "bun:test";

import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";

class FixedClock {
  now(): number {
    return 1_700_000_000_000;
  }
}

class FixedRandom {
  #next = 11;

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

const sponsor = { type: "sponsor", sponsorId: "sponsor-router-1" } as const;
const malformedSecret = ["v1", "short"].join(".");

function routerFixture() {
  const random = new FixedRandom();
  const service = new EnrollmentService({
    clock: new FixedClock(),
    random,
    store: new InMemoryEnrollmentStore(),
    replayProtector: new AesGcmEnrollmentReplayProtector(
      Uint8Array.from({ length: 32 }, (_value, index) => index),
      random,
    ),
  });
  return { service, router: createEnrollmentRouter({ service }) };
}

async function request(
  router: ReturnType<typeof createEnrollmentRouter>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return router.fetch(new Request(`https://a.asimposium.org${path}`, init));
}

describe("S-1 mountable enrollment router", () => {
  test("GET join is path-only and offers original Markdown, canonical JSON, and tiny HTML without a secret", async () => {
    const { router, service } = routerFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });

    const markdown = await request(router, `/join/${minted.enrollmentId}`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const markdownBody = await markdown.text();
    expect(markdownBody).toContain("# ASImposium enrollment capsule");
    expect(markdownBody).toContain(minted.enrollmentId);
    expect(markdownBody).not.toContain(minted.secret);
    expect(markdownBody).not.toContain("v1.");

    const json = await request(router, `/join/${minted.enrollmentId}`, {
      headers: { accept: "application/json" },
    });
    expect(json.status).toBe(200);
    expect(await json.json()).toMatchObject({
      schema: "https://a.asimposium.org/schemas/enrollment-capsule.v1.json",
      enrollment_id: minted.enrollmentId,
      claim: { method: "POST", path: "/v1/fellows", secret_transport: "JSON request body only" },
    });

    const jsonEtag = json.headers.get("etag");
    expect(jsonEtag).toMatch(/^"[a-f0-9]{64}"$/);
    const notModified = await request(router, `/join/${minted.enrollmentId}`, {
      headers: { accept: "application/json", "if-none-match": jsonEtag ?? "" },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    const qZero = await request(router, `/join/${minted.enrollmentId}`, {
      headers: { accept: "application/json;q=0, */*;q=1" },
    });
    expect(qZero.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const wildcard = await request(router, `/join/${minted.enrollmentId}`, {
      headers: { accept: "*/*" },
    });
    expect(wildcard.headers.get("content-type")).toBe("text/markdown; charset=utf-8");

    const html = await request(router, `/join/${minted.enrollmentId}`, {
      headers: { accept: "text/html" },
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("<h1>ASImposium enrollment</h1>");

    const escaped = await request(router, `/join/${minted.enrollmentId}?secret=v1.ignored`);
    expect(escaped.status).toBe(400);
    expect(await escaped.json()).toMatchObject({ code: "PATH_ONLY_REQUIRED" });

    const unavailable = ["/join/not-an-enrollment-id", "/join/ASIMP-EN-7F3K9M2Q8R"];
    for (const path of unavailable) {
      const response = await request(router, path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "CAPSULE_UNAVAILABLE" });
    }
    await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "consumed-orchid",
      model: "test-model",
      harness: "test-harness",
    });
    const consumed = await request(router, `/join/${minted.enrollmentId}`);
    expect(consumed.status).toBe(404);
    expect(await consumed.json()).toMatchObject({ code: "CAPSULE_UNAVAILABLE" });
  });

  test("registration makes name errors teachable only after opaque credential fields validate", async () => {
    const { router, service } = routerFixture();
    const valid = await service.mint(sponsor, { requested_scopes: ["review"] });
    const named = await request(router, "/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_id: valid.enrollmentId,
        secret: valid.secret,
        name: "codex",
        model: "test-model",
        harness: "test-harness",
      }),
    });
    expect(named.status).toBe(422);
    const namedBody = (await named.json()) as { code: string; suggestions: string[] };
    expect(namedBody.code).toBe("MODEL_AS_NAME");
    expect(namedBody.suggestions).toHaveLength(3);

    const opaque = await request(router, "/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_id: valid.enrollmentId,
        secret: malformedSecret,
        name: "codex",
        model: "test-model",
        harness: "test-harness",
      }),
    });
    expect(opaque.status).toBe(400);
    const opaqueText = await opaque.text();
    expect(opaqueText).toContain('"code":"PAIRING_INVALID"');
    expect(opaqueText).not.toContain("MODEL_AS_NAME");
    expect(opaqueText).not.toContain("suggestions");
    expect(opaqueText).not.toContain(malformedSecret);
  });

  test("body-only flow routes issue a token once and minimal hello authenticates the resulting binding", async () => {
    const { router, service } = routerFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const registration = await request(router, "/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: "router-orchid",
        model: "test-model",
        harness: "test-harness",
      }),
    });
    expect(registration.status).toBe(202);
    const { flow_handle: flowHandle } = (await registration.json()) as { flow_handle: string };

    const queryPoll = await request(router, `/v1/fellows/flow?flow_handle=${flowHandle}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(queryPoll.status).toBe(400);
    expect(await queryPoll.json()).toMatchObject({ code: "BODY_ONLY_REQUIRED" });

    const pending = await request(router, "/v1/fellows/flow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_handle: flowHandle }),
    });
    expect(await pending.json()).toEqual({
      status: "authorization_pending",
      retry_after_seconds: 5,
    });
    await service.decide(sponsor, minted.enrollmentId, { decision: "approve" });

    const issued = await request(router, "/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_handle: flowHandle }),
    });
    expect(issued.status).toBe(200);
    const issuedBody = (await issued.json()) as { status: string; token: string };
    expect(issuedBody.status).toBe("approved");

    const denied = await request(router, "/v1/hello");
    expect(denied.status).toBe(401);
    const oversized = await request(router, "/v1/hello", {
      headers: { authorization: `Bearer asimp_ag_${"A".repeat(8_192)}` },
    });
    expect(oversized.status).toBe(401);
    expect(await oversized.json()).toMatchObject({ code: "FELLOW_TOKEN_INVALID" });
    const hello = await request(router, "/v1/hello", {
      headers: { authorization: `Bearer ${issuedBody.token}` },
    });
    expect(hello.status).toBe(200);
    expect(await hello.json()).toMatchObject({
      fellow: { name: "router-orchid", model: "test-model", harness: "test-harness" },
      granted_scopes: ["review"],
    });
  });
});
