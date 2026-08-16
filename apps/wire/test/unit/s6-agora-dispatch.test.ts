import { describe, expect, test } from "bun:test";

import { mintServiceEnvelope } from "../../../web/lib/service-envelope.ts";
import { dispatchSignedSponsorRequest } from "../../../web/lib/stoa-sponsor.ts";
import { toHex } from "../../src/auth/canonical";
import {
  authenticateServiceEnvelopeRequest,
  type ServiceEnvelopeIngressOptions,
} from "../../src/auth/http";
import { VerificationKeyring } from "../../src/auth/keyring";
import { MemoryNonceStore } from "../../src/auth/nonce";
import { routePrincipal } from "../../src/auth/principal";

/**
 * S-6's minimal non-UI production seam.  The test uses a real Agora signer
 * and the actual Worker ingress adapter, but it intentionally makes no claim
 * about a deployed Vercel cookie or preview host boundary.
 */
const NOW = 1_786_000_000;
const STOA = "https://a.asimposium.org";
const ROUTE = "/v1/enrollments";
const ACTION = "enrollment.mint";
const SPONSOR = "usr_01JXYZSPONSOR0000000000";

interface Harness {
  readonly privateKey: CryptoKey;
  readonly ingress: ServiceEnvelopeIngressOptions;
}

async function harness(): Promise<Harness> {
  const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const keyring = new VerificationKeyring([
    {
      kid: "agora-dispatch-test",
      publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey))),
      notBefore: 0,
    },
  ]);

  return {
    privateKey: keypair.privateKey,
    ingress: {
      keyring,
      nonces: new MemoryNonceStore(),
      now: NOW,
      issuer: "agora",
      audience: "stoa",
      route: ROUTE,
      permittedActions: [ACTION],
    },
  };
}

function dispatchOptions(h: Harness, rawBody: string | ArrayBufferView | ArrayBuffer) {
  return {
    // The exact production/staging Worker origin every dispatch must name.
    // Required, never defaulted: a missing origin is a configuration failure,
    // not something the seam may infer.
    stoaOrigin: STOA,
    path: "/v1/enrollments",
    method: "POST",
    route: ROUTE,
    action: ACTION,
    sponsorId: SPONSOR,
    rawBody,
    privateKey: h.privateKey,
    kid: "agora-dispatch-test",
    now: NOW,
  };
}

/**
 * A real CryptoKey that is structurally unable to sign. Passing it as the
 * signing key turns "was the envelope minted?" into something the test can
 * observe: reaching the signer raises `InvalidAccessError` (a DOMException),
 * while every destination refusal is a `TypeError` raised before it. The
 * plants below assert that ordering rather than a message, so rewording a
 * refusal cannot quietly move it after the signature.
 */
async function unsignableKey(): Promise<CryptoKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  return pair.publicKey;
}

/** Await a dispatch that must fail closed, and hand back what it refused with. */
async function rejectionOf(dispatch: Promise<unknown>): Promise<unknown> {
  try {
    await dispatch;
  } catch (error) {
    return error;
  }
  throw new Error("expected the dispatch to fail closed, but it resolved");
}

describe("S-6 Agora signed dispatch seam", () => {
  test("signs and delivers the exact raw JSON bytes with no ambient credentials", async () => {
    const h = await harness();
    // This is intentionally valid JSON with a duplicate key and unusual
    // whitespace: parsed-value equality is not an authorization boundary.
    const rawBody = '{ "requested_scopes" : ["promote"], "requested_scopes":["review"] }';
    let sent: Request | undefined;
    let init: RequestInit | undefined;

    const response = await dispatchSignedSponsorRequest({
      ...dispatchOptions(h, rawBody),
      idempotencyKey: "console-01JXYZ4K6Q",
      fetchImpl: async (input, requestInit) => {
        init = requestInit;
        sent = new Request(input, requestInit);
        const result = await authenticateServiceEnvelopeRequest(sent, h.ingress);
        if (!result.ok) return result.response;
        expect(new TextDecoder().decode(result.rawBody)).toBe(rawBody);
        return new Response(null, { status: 204 });
      },
    });

    expect(response.status).toBe(204);
    expect(sent?.url).toBe(`${STOA}/v1/enrollments`);
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("cookie")).toBeNull();
    expect(sent?.headers.has("asimp-service-envelope")).toBe(true);
    expect(sent?.headers.get("idempotency-key")).toBe("console-01JXYZ4K6Q");
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
  });

  test("rejects any in-transit reserialization of signed raw bytes", async () => {
    const h = await harness();
    const rawBody = '{"requested_scopes":["promote"]}';

    const response = await dispatchSignedSponsorRequest({
      ...dispatchOptions(h, rawBody),
      fetchImpl: async (input, requestInit) => {
        const sent = new Request(input, requestInit);
        const altered = new Request(sent.url, {
          method: sent.method,
          headers: sent.headers,
          body: '{ "requested_scopes": ["promote"] }',
        });
        const result = await authenticateServiceEnvelopeRequest(altered, h.ingress);
        return result.ok ? new Response(null, { status: 204 }) : result.response;
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("fails closed before signing if a destination leaves the configured Stoa origin", async () => {
    const h = await harness();
    const options = dispatchOptions(h, '{"requested_scopes":["promote"]}');

    await expect(
      dispatchSignedSponsorRequest({ ...options, path: "//outside.asimposium.invalid/steal" }),
    ).rejects.toThrow(/absolute path/);
    await expect(
      dispatchSignedSponsorRequest({ ...options, path: "/v1/enrollments?unbound=query" }),
    ).rejects.toThrow(/query-free path/);
  });

  test("rejects an unsafe product idempotency key before signing or dispatch", async () => {
    const h = await harness();
    let signerCalls = 0;
    let fetchCalls = 0;

    await expect(
      dispatchSignedSponsorRequest({
        ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
        idempotencyKey: "contains a space",
        mintEnvelopeImpl: async (...args) => {
          signerCalls += 1;
          return mintServiceEnvelope(...args);
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow(/Idempotency-Key/);
    expect(signerCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});

describe("S-6 planted transport negatives", () => {
  test("PLANTED: Buffer.slice is an alias, so the transport may not rely on it", () => {
    // The premise the next test depends on, asserted rather than assumed:
    // `Buffer.prototype.slice` is Node's deprecated alias for `subarray`, so a
    // transport that "copies" a caller body with `.slice()` keeps handing out
    // the caller's own memory. (`view.buffer` may additionally be a larger
    // pooled allocation, which is why the copy below reads through an explicit
    // byteOffset/byteLength window rather than trusting `.buffer`; whether a
    // given runtime pools a given size is not asserted here.)
    const owned = Buffer.from('{"requested_scopes":["promote"]}');
    const supposedCopy = owned.slice();
    supposedCopy[0] = 0x7a;

    expect(owned[0]).toBe(0x7a);
    expect(supposedCopy.buffer).toBe(owned.buffer);
  });

  test("PLANTED: a caller Buffer mutated after signing cannot alter transmitted bytes", async () => {
    const h = await harness();
    const text = '{"requested_scopes":["promote"]}';
    const shared = Buffer.from(text);
    let delivered: string | undefined;

    const response = await dispatchSignedSponsorRequest({
      ...dispatchOptions(h, shared),
      fetchImpl: async (input, requestInit) => {
        // The write lands after the envelope digest was computed and before the
        // request is constructed: exactly the window an aliased view leaves open.
        shared.fill(0x20);
        const result = await authenticateServiceEnvelopeRequest(
          new Request(input, requestInit),
          h.ingress,
        );
        if (!result.ok) return result.response;
        delivered = new TextDecoder().decode(result.rawBody);
        return new Response(null, { status: 204 });
      },
    });

    // Before the copy, the mutation reached both the wire and the digest input,
    // and the Worker refused the write with 401.
    expect(response.status).toBe(204);
    expect(delivered).toBe(text);
  });

  test("PLANTED: a never-resolving Stoa fetch is bounded, not hung", async () => {
    const h = await harness();
    const startedAt = performance.now();
    let observed: AbortSignal | undefined;

    await expect(
      dispatchSignedSponsorRequest({
        ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
        timeoutMs: 75,
        // Deliberately ignores the signal: the bound is the transport's
        // responsibility and must not be delegated to the fetch implementation.
        fetchImpl: (_input, requestInit) => {
          observed = requestInit.signal ?? undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toThrow();

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(observed?.aborted).toBe(true);
  });

  test("PLANTED: the dispatch deadline also bounds a never-resolving signer", async () => {
    const h = await harness();
    const startedAt = performance.now();
    let fetchAttempted = false;

    await expect(
      dispatchSignedSponsorRequest({
        ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
        timeoutMs: 75,
        mintEnvelopeImpl: () => new Promise(() => {}),
        fetchImpl: async () => {
          fetchAttempted = true;
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow(/timed out/);

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(fetchAttempted).toBe(false);
  });

  test("PLANTED: a pre-aborted caller never enters the signer", async () => {
    const h = await harness();
    const caller = new AbortController();
    const reason = new DOMException("cancelled before dispatch", "AbortError");
    caller.abort(reason);
    let signingAttempted = false;
    let caught: unknown;

    try {
      await dispatchSignedSponsorRequest({
        ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
        privateKey: {} as CryptoKey,
        signal: caller.signal,
        mintEnvelopeImpl: async () => {
          signingAttempted = true;
          throw new TypeError("pre-aborted dispatch entered signer");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(reason);
    expect(signingAttempted).toBe(false);
  });

  test("PLANTED: caller cancellation rejects a dispatch already in flight", async () => {
    const h = await harness();
    const caller = new AbortController();

    const dispatch = dispatchSignedSponsorRequest({
      ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
      timeoutMs: 30_000,
      signal: caller.signal,
      fetchImpl: () => new Promise<Response>(() => {}),
    });
    queueMicrotask(() => caller.abort());

    await expect(dispatch).rejects.toThrow();
  });

  test("PLANTED: synchronous caller cancellation cannot lose the abort race", async () => {
    const h = await harness();
    const caller = new AbortController();

    const dispatch = dispatchSignedSponsorRequest({
      ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
      signal: caller.signal,
      fetchImpl: () => {
        // A nonstandard transport may synchronously cancel its owner before it
        // returns a settled response. Installing the abort race afterwards
        // misses that event and incorrectly reports this cancelled write as 204.
        caller.abort();
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await expect(dispatch).rejects.toThrow();
  });

  test("PLANTED: a settled dispatch leaves no timer able to abort afterwards", async () => {
    const h = await harness();
    let observed: AbortSignal | undefined;

    const response = await dispatchSignedSponsorRequest({
      ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
      timeoutMs: 60,
      fetchImpl: async (_input, requestInit) => {
        observed = requestInit.signal ?? undefined;
        return new Response(null, { status: 204 });
      },
    });
    expect(response.status).toBe(204);

    // An uncleared deadline would fire here and abort a signal whose request
    // already completed, which is the observable shadow of a leaked timer.
    await Bun.sleep(200);
    expect(observed?.aborted).toBe(false);
  });

  test("PLANTED: a plaintext origin fails closed before an envelope is minted", async () => {
    const h = await harness();
    let attempted = false;
    const options = {
      ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
      privateKey: await unsignableKey(),
      fetchImpl: async () => {
        attempted = true;
        return new Response(null, { status: 204 });
      },
    };

    // Non-vacuity: with the trusted origin the same call does reach the signer,
    // so the key really is unusable and the discriminator below means something.
    const signerFailure = await rejectionOf(dispatchSignedSponsorRequest(options));
    expect(signerFailure).toBeInstanceOf(DOMException);

    const originFailure = await rejectionOf(
      dispatchSignedSponsorRequest({ ...options, stoaOrigin: "http://a.asimposium.invalid" }),
    );
    expect(originFailure).toBeInstanceOf(TypeError);
    expect(originFailure).not.toBeInstanceOf(DOMException);
    expect(attempted).toBe(false);
  });

  test("PLANTED: another HTTPS host is not a trusted Stoa destination", async () => {
    const h = await harness();
    let attempted = false;

    // TLS is not trust: an attacker-controlled HTTPS host is refused on the
    // same path as plaintext, and still before the signer runs.
    const failure = await rejectionOf(
      dispatchSignedSponsorRequest({
        ...dispatchOptions(h, '{"requested_scopes":["promote"]}'),
        stoaOrigin: "https://attacker.invalid",
        privateKey: await unsignableKey(),
        fetchImpl: async () => {
          attempted = true;
          return new Response(null, { status: 204 });
        },
      }),
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(DOMException);
    expect(attempted).toBe(false);
  });

  test("PLANTED: an insecure allowance may only name the configured loopback origin", async () => {
    const h = await harness();
    const base = dispatchOptions(h, '{"requested_scopes":["promote"]}');

    // A remote host can never be allowed, however explicitly it is named. The
    // allowance never gets a hearing: the destination is not trusted at all, so
    // this is refused one gate earlier than the loopback rules.
    await expect(
      dispatchSignedSponsorRequest({
        ...base,
        stoaOrigin: "http://a.asimposium.invalid",
        insecureLoopbackOrigin: "http://a.asimposium.invalid",
      }),
    ).rejects.toBeInstanceOf(TypeError);

    // And on the real HTTPS origin an allowance is refused rather than quietly
    // ignored, so a staging flag left set in production fails closed.
    await expect(
      dispatchSignedSponsorRequest({
        ...base,
        stoaOrigin: STOA,
        insecureLoopbackOrigin: "http://127.0.0.1:8787",
      }),
    ).rejects.toThrow(/plaintext loopback/);

    // An allowance for a different origin than the configured one is refused.
    await expect(
      dispatchSignedSponsorRequest({
        ...base,
        stoaOrigin: "http://127.0.0.1:8787",
        insecureLoopbackOrigin: "http://127.0.0.1:9999",
      }),
    ).rejects.toThrow(/configured origin exactly/);

    // Even a matching loopback host is not an origin declaration if it carries
    // a path, query, fragment, or credentials. The allowance is compared as an
    // exact string, so this is refused before a signature exists to be replayed
    // — which is the property worth pinning, not the sentence that reports it.
    let attempted = false;
    const pathAllowanceFailure = await rejectionOf(
      dispatchSignedSponsorRequest({
        ...base,
        stoaOrigin: "http://127.0.0.1:8787",
        insecureLoopbackOrigin: "http://127.0.0.1:8787/not-an-origin",
        privateKey: await unsignableKey(),
        fetchImpl: async () => {
          attempted = true;
          return new Response(null, { status: 204 });
        },
      }),
    );
    expect(pathAllowanceFailure).toBeInstanceOf(TypeError);
    expect(pathAllowanceFailure).not.toBeInstanceOf(DOMException);
    expect(attempted).toBe(false);

    // The one supported staging shape: plaintext loopback, named exactly.
    let destination: string | undefined;
    const response = await dispatchSignedSponsorRequest({
      ...base,
      stoaOrigin: "http://127.0.0.1:8787",
      insecureLoopbackOrigin: "http://127.0.0.1:8787",
      fetchImpl: async (input) => {
        destination = input;
        return new Response(null, { status: 204 });
      },
    });

    expect(response.status).toBe(204);
    expect(destination).toBe("http://127.0.0.1:8787/v1/enrollments");
  });
});

describe("S-6 planted wrong-principal refusals", () => {
  test("PLANTED: a Fellow bearer on an Agora sponsor route is WRONG_PRINCIPAL", () => {
    const decision = routePrincipal({
      host: "apex",
      routeClass: "sponsor-write",
      presented: { bearer: true, envelope: false },
    });

    expect(decision).toMatchObject({
      ok: false,
      code: "WRONG_PRINCIPAL",
      reason: "bearer_on_sponsor_route",
    });
  });

  test("PLANTED: an apex cookie on a. cannot authenticate a Worker request", async () => {
    const h = await harness();
    const request = new Request(`${STOA}/v1/enrollments`, {
      method: "POST",
      headers: {
        Cookie: "asimp.session=planted-never-a-service-envelope",
        "content-type": "application/json",
      },
      body: '{"requested_scopes":["promote"]}',
    });
    const result = await authenticateServiceEnvelopeRequest(request, h.ingress);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject({ code: "WRONG_PRINCIPAL" });
  });
});
