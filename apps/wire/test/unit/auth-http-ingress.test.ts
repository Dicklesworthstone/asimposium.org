import { describe, expect, test } from "bun:test";

import {
  SERVICE_ENVELOPE_HEADER as AGORA_SERVICE_ENVELOPE_HEADER,
  mintServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../../web/lib/service-envelope.ts";
import { toHex } from "../../src/auth/canonical";
import {
  authenticateServiceEnvelopeRequest,
  MAX_SERVICE_ENVELOPE_BODY_BYTES,
  parseAuthenticatedJsonBody,
  SERVICE_ENVELOPE_HEADER,
  type ServiceEnvelopeIngressOptions,
} from "../../src/auth/http";
import { VerificationKeyring } from "../../src/auth/keyring";
import { MemoryNonceStore } from "../../src/auth/nonce";

/**
 * HTTP-level S-6 vectors for the unmounted Worker ingress adapter.
 *
 * These use actual Request bodies and the Agora signer, but remain local unit
 * proof only: no deployed Worker, D1 binding, Vercel action, or Google cookie
 * behavior is claimed.
 */

const NOW = 1_786_000_000;
const ROUTE = "/v1/p/:id/directives";
const ACTION = "directive.create";
const origin = "https://a.asimposium.invalid";

interface HttpHarness {
  options: ServiceEnvelopeIngressOptions;
  makeRequest(
    body: string,
    overrides?: {
      action?: string;
      envelopeMethod?: string;
      envelopeRoute?: string;
      requestMethod?: string;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<Request>;
}

async function harness(): Promise<HttpHarness> {
  const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const keyring = new VerificationKeyring([
    {
      kid: "agora-http-test",
      publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey))),
      notBefore: 0,
    },
  ]);
  const options: ServiceEnvelopeIngressOptions = {
    keyring,
    nonces: new MemoryNonceStore(),
    now: NOW,
    issuer: "agora",
    audience: "stoa",
    route: ROUTE,
    permittedActions: [ACTION],
  };

  return {
    options,
    async makeRequest(body, overrides = {}) {
      const envelope = await mintServiceEnvelope({
        privateKey: keypair.privateKey,
        kid: "agora-http-test",
        now: NOW,
        method: overrides.envelopeMethod ?? "POST",
        route: overrides.envelopeRoute ?? ROUTE,
        action: overrides.action ?? ACTION,
        principalId: "usr_01JXYZ0000000000000000",
        body,
      });
      const headers = new Headers(serviceEnvelopeHeaders(envelope));
      for (const [name, value] of new Headers(overrides.extraHeaders)) headers.set(name, value);
      return new Request(`${origin}/internal/auth-spike`, {
        method: overrides.requestMethod ?? "POST",
        headers,
        body,
      });
    },
  };
}

async function expectUnauthorized(
  result: Awaited<ReturnType<typeof authenticateServiceEnvelopeRequest>>,
) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.response.status).toBe(401);
  expect(await result.response.json()).toMatchObject({ code: "UNAUTHORIZED" });
}

describe("service-envelope Worker ingress", () => {
  test("uses the same header name as Agora and accepts a signed Worker request", async () => {
    expect(SERVICE_ENVELOPE_HEADER).toBe(AGORA_SERVICE_ENVELOPE_HEADER);
    const h = await harness();
    const request = await h.makeRequest('{"directive":"hold the boundary"}');
    const result = await authenticateServiceEnvelopeRequest(request, h.options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verification.principal).toMatchObject({ type: "sponsor", action: ACTION });
  });

  test("does not read Cookie: an agent-host Cookie is classified as no credential", async () => {
    const realHeaders = new Headers({ Cookie: "asimp.session=canary-cookie-never-read" });
    const headers = {
      get(name: string) {
        if (name.toLowerCase() === "cookie") {
          throw new Error("Cookie header must never be consulted by service-envelope ingress");
        }
        return realHeaders.get(name);
      },
    } as unknown as Headers;
    const request = {
      method: "POST",
      headers,
      async arrayBuffer() {
        return new TextEncoder().encode('{"unused":true}').buffer;
      },
    } as unknown as Request;
    const h = await harness();
    const result = await authenticateServiceEnvelopeRequest(request, h.options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject({ code: "WRONG_PRINCIPAL" });
  });

  test("rejects bearer and envelope confusion before consuming the signed nonce", async () => {
    for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
      const h = await harness();
      const body = JSON.stringify({ directive: `same nonce survives ${scheme} confusion` });
      const signedRequest = await h.makeRequest(body);
      const bearerHeaders = new Headers(signedRequest.headers);
      bearerHeaders.set("authorization", `${scheme} asimp_ag_canary_never_accepted`);
      const bearerRequest = new Request(`${origin}/internal/auth-spike`, {
        method: "POST",
        headers: bearerHeaders,
        body,
      });
      const confused = await authenticateServiceEnvelopeRequest(bearerRequest, h.options);
      expect(confused.ok).toBe(false);
      if (!confused.ok) {
        expect(confused.response.status).toBe(403);
        expect(await confused.response.json()).toMatchObject({ code: "WRONG_PRINCIPAL" });
      }

      // The same signed envelope remains usable: each confused request stopped
      // before verification and therefore could not burn its nonce.
      const accepted = await authenticateServiceEnvelopeRequest(
        new Request(`${origin}/internal/auth-spike`, {
          method: "POST",
          headers: signedRequest.headers,
          body,
        }),
        h.options,
      );
      expect(accepted.ok).toBe(true);
    }
  });
});

describe("exact request bytes are bound before JSON parsing", () => {
  test("accepts individually signed JSON spellings and exposes the same raw bytes", async () => {
    const forms = [
      '{ "a" : 1 }',
      '{"b":2,"a":1}',
      '{"a":1,"a":2}',
      '{"a":"\\u0061"}',
      '{"a":1.0}',
      '{"a":1e0}',
    ];
    const h = await harness();
    for (const body of forms) {
      const result = await authenticateServiceEnvelopeRequest(await h.makeRequest(body), h.options);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(new TextDecoder().decode(result.rawBody)).toBe(body);
      // Parsing is deliberately after byte authentication. The duplicate-key
      // vector demonstrates why parsed-value equality is not an auth binding.
      expect(parseAuthenticatedJsonBody(result)).toBeDefined();
    }
  });

  test("rejects whitespace, action, route, and method substitutions", async () => {
    const h = await harness();
    const signedBody = '{"a":1,"b":2}';
    const signedRequest = await h.makeRequest(signedBody);
    const headers = new Headers(signedRequest.headers);
    await expectUnauthorized(
      await authenticateServiceEnvelopeRequest(
        new Request(`${origin}/internal/auth-spike`, {
          method: "POST",
          headers,
          body: '{ "a": 1, "b": 2 }',
        }),
        h.options,
      ),
    );
    await expectUnauthorized(
      await authenticateServiceEnvelopeRequest(
        await h.makeRequest(signedBody, { action: "pairing.mint" }),
        h.options,
      ),
    );
    await expectUnauthorized(
      await authenticateServiceEnvelopeRequest(
        await h.makeRequest(signedBody, { envelopeRoute: "/v1/p/:id/claims" }),
        h.options,
      ),
    );
    await expectUnauthorized(
      await authenticateServiceEnvelopeRequest(
        await h.makeRequest(signedBody, { requestMethod: "PUT" }),
        h.options,
      ),
    );
  });

  test("an empty required action allowlist fails closed", async () => {
    const h = await harness();
    await expectUnauthorized(
      await authenticateServiceEnvelopeRequest(await h.makeRequest('{"a":1}'), {
        ...h.options,
        permittedActions: [],
      }),
    );
  });
});

describe("pre-authentication request bodies are byte bounded", () => {
  test("accepts an exact-limit body without requiring Content-Length", async () => {
    const h = await harness();
    const body = "x".repeat(MAX_SERVICE_ENVELOPE_BODY_BYTES);
    const request = await h.makeRequest(body);
    request.headers.delete("content-length");

    const result = await authenticateServiceEnvelopeRequest(request, h.options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rawBody.byteLength).toBe(MAX_SERVICE_ENVELOPE_BODY_BYTES);
  });

  test("rejects an honestly declared oversized body before consuming it", async () => {
    const h = await harness();
    const body = "x".repeat(MAX_SERVICE_ENVELOPE_BODY_BYTES + 1);
    const request = await h.makeRequest(body);
    request.headers.set("content-length", String(body.length));

    const result = await authenticateServiceEnvelopeRequest(request, h.options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
    expect(await result.response.json()).toMatchObject({ code: "REQUEST_BODY_TOO_LARGE" });
  });

  test("a false-low Content-Length cannot bypass the streamed byte cap", async () => {
    const h = await harness();
    const body = "x".repeat(MAX_SERVICE_ENVELOPE_BODY_BYTES + 1);
    const request = await h.makeRequest(body);
    request.headers.set("content-length", "1");

    const result = await authenticateServiceEnvelopeRequest(request, h.options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
    expect(await result.response.json()).toMatchObject({ code: "REQUEST_BODY_TOO_LARGE" });
  });

  test("ambiguous lengths, compressed bodies, and stream failures fail closed", async () => {
    const h = await harness();
    const signed = await h.makeRequest("{}");
    const cases = [
      { headers: { "content-length": "1, 2" }, body: signed.body },
      { headers: { "content-encoding": "gzip" }, body: signed.body },
      {
        headers: {},
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("private stream failure"));
          },
        }),
      },
    ] as const;

    for (const [index, scenario] of cases.entries()) {
      const headers = new Headers(signed.headers);
      for (const [name, value] of Object.entries(scenario.headers)) headers.set(name, value);
      const request = {
        method: "POST",
        headers,
        body: scenario.body,
      } as unknown as Request;
      const result = await authenticateServiceEnvelopeRequest(request, h.options);
      expect(result.ok, String(index)).toBe(false);
      if (!result.ok) {
        expect(result.response.status, String(index)).toBe(401);
        expect(await result.response.json(), String(index)).toMatchObject({ code: "UNAUTHORIZED" });
      }
    }
  });

  test("early size and encoding refusals cancel the body and preserve the signed nonce", async () => {
    for (const refusalHeader of [
      ["content-length", String(MAX_SERVICE_ENVELOPE_BODY_BYTES + 1)],
      ["content-encoding", "gzip"],
    ] as const) {
      const h = await harness();
      const body = '{"bounded":true}';
      const signed = await h.makeRequest(body);
      const refusedHeaders = new Headers(signed.headers);
      refusedHeaders.set(refusalHeader[0], refusalHeader[1]);
      let cancellations = 0;
      const refusedBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
        cancel() {
          cancellations += 1;
        },
      });
      const refused = await authenticateServiceEnvelopeRequest(
        { method: "POST", headers: refusedHeaders, body: refusedBody } as unknown as Request,
        h.options,
      );
      expect(refused.ok).toBe(false);
      expect(cancellations).toBe(1);

      const retry = await authenticateServiceEnvelopeRequest(
        new Request(`${origin}/internal/auth-spike`, {
          method: "POST",
          headers: signed.headers,
          body,
        }),
        h.options,
      );
      expect(retry.ok).toBe(true);
    }
  });

  test("locked bodies and both oversized chunk shapes become typed refusals", async () => {
    const lockedHarness = await harness();
    const locked = await lockedHarness.makeRequest("{}");
    const lock = locked.body?.getReader();
    const lockedResult = await authenticateServiceEnvelopeRequest(locked, lockedHarness.options);
    expect(lockedResult.ok).toBe(false);
    if (!lockedResult.ok) expect(lockedResult.response.status).toBe(401);
    await lock?.cancel();
    lock?.releaseLock();

    for (const chunks of [
      [new Uint8Array(MAX_SERVICE_ENVELOPE_BODY_BYTES), new Uint8Array(1)],
      [new Uint8Array(MAX_SERVICE_ENVELOPE_BODY_BYTES + 1)],
    ]) {
      const h = await harness();
      const signed = await h.makeRequest("{}");
      const headers = new Headers(signed.headers);
      headers.delete("content-length");
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(0));
          for (const chunk of chunks) controller.enqueue(chunk);
        },
        cancel() {
          cancellations += 1;
        },
      });
      const result = await authenticateServiceEnvelopeRequest(
        { method: "POST", headers, body } as unknown as Request,
        h.options,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(413);
      expect(cancellations).toBe(1);
    }
  });

  test("identity encoding and a truthful low length preserve exact bytes", async () => {
    const h = await harness();
    const body = '{"identity":true}';
    const request = await h.makeRequest(body, {
      extraHeaders: {
        "content-encoding": "identity",
        "content-length": String(new TextEncoder().encode(body).byteLength),
      },
    });
    const result = await authenticateServiceEnvelopeRequest(request, h.options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.rawBody)).toBe(body);
  });

  test("a byte stream exercises the BYOB path without detaching retained request bytes", async () => {
    const h = await harness();
    const bodyText = '{"byob":true}';
    const signed = await h.makeRequest(bodyText);
    const headers = new Headers(signed.headers);
    headers.delete("content-length");
    const bodyBytes = new TextEncoder().encode(bodyText);
    const byteStream = new ReadableStream<Uint8Array>({
      type: "bytes",
      start(controller: { enqueue(chunk: Uint8Array): void; close(): void }) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    } as never);

    const result = await authenticateServiceEnvelopeRequest(
      { method: "POST", headers, body: byteStream } as unknown as Request,
      h.options,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.rawBody)).toBe(bodyText);
  });
});
