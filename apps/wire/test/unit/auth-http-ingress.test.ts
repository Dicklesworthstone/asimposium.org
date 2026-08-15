import { describe, expect, test } from "bun:test";

import {
  SERVICE_ENVELOPE_HEADER as AGORA_SERVICE_ENVELOPE_HEADER,
  mintServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../../web/lib/service-envelope.ts";
import { toHex } from "../../src/auth/canonical";
import {
  authenticateServiceEnvelopeRequest,
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
