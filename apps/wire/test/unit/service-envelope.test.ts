import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app";
import {
  canonicalBytes,
  canonicalDigest,
  constantTimeEqual,
  ENVELOPE_VERSION,
  payloadDigest,
  type ServiceEnvelopeClaims,
  toHex,
} from "../../src/auth/canonical";
import { parseEnvelope, verifyServiceEnvelope } from "../../src/auth/envelope";
import { KeyringConfigError, VerificationKeyring } from "../../src/auth/keyring";
import { MemoryNonceStore } from "../../src/auth/nonce";

/**
 * S-6 cross-plane auth (asimposiumorg-vw3).
 *
 * These are unit vectors for the signed service envelope: canonicalization,
 * signature, expiry, replay, tamper, key rotation and attribution. They run
 * real Ed25519 through WebCrypto — the same primitive the Worker runs — with no
 * network, no D1 and no deployment.
 *
 * SCOPE, read before citing: nothing here proves Auth.js issues a host-only
 * cookie, that Google sign-in works, or that a deployed Worker refuses anything.
 * That is the preview spike, and it is blocked on credentials.
 */

const NOW = 1786000000;
const ROUTE = "/v1/p/:id/directives";
const BODY = '{"focus":"the simply-connected case"}';

async function makeKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
}

async function publicKeyHex(key: CryptoKey): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

async function sign(privateKey: CryptoKey, claims: ServiceEnvelopeClaims): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    canonicalBytes(claims).slice().buffer,
  );
  return toHex(new Uint8Array(signature));
}

async function baseClaims(overrides: Partial<ServiceEnvelopeClaims> = {}) {
  const claims: ServiceEnvelopeClaims = {
    v: ENVELOPE_VERSION,
    kid: "agora-2026-08-a",
    alg: "Ed25519",
    iss: "agora",
    aud: "stoa",
    iat: NOW,
    exp: NOW + 60,
    nonce: "n".repeat(43),
    method: "POST",
    route: ROUTE,
    action: "directive.create",
    principal_type: "sponsor",
    principal_id: "usr_01JXYZ0000000000000000",
    payload_sha256: await payloadDigest(BODY),
    ...overrides,
  };
  return claims;
}

interface Harness {
  keypair: CryptoKeyPair;
  keyring: VerificationKeyring;
  nonces: MemoryNonceStore;
  verify: (
    envelope: unknown,
    overrides?: Partial<Parameters<typeof verifyServiceEnvelope>[1]>,
  ) => ReturnType<typeof verifyServiceEnvelope>;
}

async function harness(keyValidity?: { notBefore: number; notAfter?: number }): Promise<Harness> {
  const keypair = await makeKeypair();
  const keyring = new VerificationKeyring([
    {
      kid: "agora-2026-08-a",
      publicKeyHex: await publicKeyHex(keypair.publicKey),
      notBefore: keyValidity?.notBefore ?? 0,
      ...(keyValidity?.notAfter === undefined ? {} : { notAfter: keyValidity.notAfter }),
    },
  ]);
  const nonces = new MemoryNonceStore();
  return {
    keypair,
    keyring,
    nonces,
    verify: (envelope, overrides = {}) =>
      verifyServiceEnvelope(envelope, {
        keyring,
        nonces,
        now: NOW,
        issuer: "agora",
        audience: "stoa",
        body: BODY,
        method: "POST",
        route: ROUTE,
        permittedActions: ["directive.create"],
        ...overrides,
      }),
  };
}

async function signedEnvelope(
  h: Harness,
  overrides: Partial<ServiceEnvelopeClaims> = {},
): Promise<{ claims: ServiceEnvelopeClaims; signature: string }> {
  const claims = await baseClaims(overrides);
  return { claims, signature: await sign(h.keypair.privateKey, claims) };
}

describe("canonicalization", () => {
  test("PLANTED: a Buffer subview digest excludes its surrounding allocation", async () => {
    const prefix = "outside-before:";
    const bodyText = '{"focus":"exact Worker view"}';
    const backing = Buffer.from(`${prefix}${bodyText}:outside-after`);
    const body = backing.subarray(prefix.length, prefix.length + bodyText.length);
    const expected = toHex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText))),
    );

    expect(await payloadDigest(body)).toBe(expected);
    expect(await payloadDigest(body)).not.toBe(await payloadDigest(backing));
  });

  test("is independent of object key order", async () => {
    const ordered = await baseClaims();
    const shuffled = Object.fromEntries(
      Object.entries(ordered).reverse(),
    ) as unknown as ServiceEnvelopeClaims;

    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(ordered)[0]);
    expect(await canonicalDigest(shuffled)).toBe(await canonicalDigest(ordered));
  });

  test("a colon inside a signed value is carried literally, not as framing", async () => {
    // `action` and `principal_id` are NOT adjacent in CANONICAL_FIELDS —
    // `principal_type` sits between them — so a value-joined encoding does not
    // actually collide on this pair, and calling it "the classic collision"
    // overstated what it proves. What it does prove is still worth keeping: a
    // `:` inside a value changes the digest instead of being read as a
    // delimiter. The genuine adjacent-field collision, where a delimiter-only
    // scheme really cannot tell two claim sets apart, is planted in
    // auth-canonical-vectors.test.ts against `principal_type`/`principal_id`.
    const left = await canonicalDigest(await baseClaims({ action: "a:1", principal_id: "b" }));
    const right = await canonicalDigest(await baseClaims({ action: "a", principal_id: "1:b" }));
    expect(left).not.toBe(right);
  });

  test("a record separator inside a value cannot reframe the field list", async () => {
    const injected = await canonicalDigest(
      await baseClaims({ action: `ab\x1e14:principal_id:5:evil\x1e` }),
    );
    const honest = await canonicalDigest(await baseClaims({ action: "ab" }));
    expect(injected).not.toBe(honest);
  });

  test("lengths are UTF-8 bytes, not UTF-16 code units", async () => {
    // "\u{1D518}" is one code point, two UTF-16 units, four UTF-8 bytes. An
    // implementation using String.length here disagrees with the Worker and
    // every sponsor write fails with a signature error.
    const claims = await baseClaims({ action: "\u{1D518}" });
    const text = new TextDecoder().decode(canonicalBytes(claims));
    expect(text).toContain("6:action:4:");
  });

  test("a non-integer timestamp is refused rather than silently rendered", async () => {
    const claims = await baseClaims();
    expect(() => canonicalBytes({ ...claims, iat: 1.5 })).toThrow(/safe integer/);
    expect(() => canonicalBytes({ ...claims, exp: Number.NaN })).toThrow(/safe integer/);
  });

  test("constantTimeEqual agrees with equality on the cases that matter", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("golden vectors — the two planes must agree byte for byte", () => {
  const corpus = JSON.parse(
    readFileSync(
      join(dirname(dirname(import.meta.dir)), "src", "auth", "service-envelope-vectors.json"),
      "utf8",
    ),
  ) as { vectors: Record<string, { claims: ServiceEnvelopeClaims; canonical_sha256: string }> };

  const names = Object.keys(corpus.vectors);

  test("the corpus is non-trivial", () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  test.each(names)("vector %s canonicalizes to its pinned digest", async (name) => {
    const vector = corpus.vectors[name];
    if (vector === undefined) throw new Error(`corpus is missing vector ${name}`);
    expect(await canonicalDigest(vector.claims)).toBe(vector.canonical_sha256);
  });

  test("every vector has a distinct digest", async () => {
    const digests = await Promise.all(
      Object.values(corpus.vectors).map(async (vector) => canonicalDigest(vector.claims)),
    );
    expect(new Set(digests).size).toBe(digests.length);
  });
});

describe("parseEnvelope — untrusted input", () => {
  test("accepts a well-formed envelope", async () => {
    const h = await harness();
    expect(parseEnvelope(await signedEnvelope(h))).toBeDefined();
  });

  test.each([
    ["not an object", 42],
    ["null", null],
    ["array", []],
    ["missing signature", { claims: {} }],
    ["signature not hex", { claims: {}, signature: "zz" }],
  ])("refuses %s", (_label, value) => {
    expect(parseEnvelope(value)).toBeUndefined();
  });

  test("refuses an extra unsigned field on the envelope", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h);
    expect(parseEnvelope({ ...envelope, extra: 1 })).toBeUndefined();
  });

  test("refuses an extra unsigned field inside claims", async () => {
    // An unsigned field on a signed object is meaning the verifier never
    // authenticated. Tolerating it is how signature-stripping bugs begin.
    const h = await harness();
    const envelope = await signedEnvelope(h);
    expect(
      parseEnvelope({ ...envelope, claims: { ...envelope.claims, elevated: true } }),
    ).toBeUndefined();
  });

  test("refuses a short or malformed nonce", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h, { nonce: "short" });
    expect(parseEnvelope(envelope)).toBeUndefined();
    const bad = await signedEnvelope(h, { nonce: `${"n".repeat(42)}!` });
    expect(parseEnvelope(bad)).toBeUndefined();
  });

  test("refuses a signature of the wrong length", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h);
    expect(
      parseEnvelope({ ...envelope, signature: envelope.signature.slice(0, 126) }),
    ).toBeUndefined();
  });
});

describe("claim bounds are enforced before canonicalization or crypto", () => {
  test.each([
    ["kid", "not a kid!"],
    ["iss", "AGORA"],
    ["aud", "sto a"],
    ["method", "TRACE"],
    ["route", "v1/no-leading-slash"],
    ["route", "/v1/x?query=1"],
    ["action", "Directive.Create"],
    ["action", "directive..create"],
    ["principal_type", "Sponsor1"],
    ["principal_id", "usr:01"],
  ])("refuses a %s outside its character class: %j", async (field, value) => {
    const h = await harness();
    const envelope = await signedEnvelope(h, { [field]: value } as never);
    expect(parseEnvelope(envelope)).toBeUndefined();
  });

  test.each([
    ["kid", 65],
    ["action", 65],
    ["principal_id", 65],
    ["principal_type", 33],
    ["route", 257],
  ])("refuses an oversized %s (%i bytes)", async (field, size) => {
    const h = await harness();
    const filler = field === "route" ? `/${"a".repeat(size - 1)}` : "a".repeat(size);
    const envelope = await signedEnvelope(h, { [field]: filler } as never);
    expect(parseEnvelope(envelope)).toBeUndefined();
  });

  test.each([
    ["action", "directive\ncreate"],
    ["principal_id", "usr_01\x1e"],
    ["kid", "agora\x00a"],
    ["route", "/v1/x\n"],
  ])("refuses a control character in %s", async (field, value) => {
    const h = await harness();
    const envelope = await signedEnvelope(h, { [field]: value } as never);
    expect(parseEnvelope(envelope)).toBeUndefined();
  });

  test("an out-of-bounds claim never reaches the signature check", async () => {
    // A megabyte of `action` would otherwise cost a megabyte of hashing per
    // request before any signature was verified.
    const h = await harness();
    const envelope = await signedEnvelope(h, { action: "a".repeat(1_000_000) });
    const result = await h.verify(envelope);
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("valid boundary values are accepted", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h, {
      kid: "a".repeat(64),
      action: "a".repeat(64),
      principal_id: "a".repeat(64),
      route: `/${"a".repeat(255)}`,
    });
    expect(parseEnvelope(envelope)).toBeDefined();
  });

  test("canonicalization stays total even for claims the verifier refuses", async () => {
    // Framing must be correct for input validation would reject; the two jobs
    // are separate on purpose (defence in depth).
    const claims = await baseClaims({ action: `a${String.fromCharCode(0x1e)}b\nc:d` });
    expect(() => canonicalBytes(claims)).not.toThrow();
    expect(parseEnvelope({ claims, signature: "0".repeat(128) })).toBeUndefined();
  });
});

describe("verification — the happy path attributes the write", () => {
  test("a valid envelope is accepted and names the acting human", async () => {
    const h = await harness();
    const result = await h.verify(await signedEnvelope(h));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toEqual({
      type: "sponsor",
      id: "usr_01JXYZ0000000000000000",
      action: "directive.create",
      kid: "agora-2026-08-a",
    });
  });
});

describe("verification — tamper", () => {
  test.each([
    ["principal_id", { principal_id: "usr_someone_else" }],
    ["action", { action: "directive.delete" }],
    ["route", { route: "/v1/p/:id/claims" }],
    ["method", { method: "DELETE" }],
    ["exp", { exp: NOW + 119 }],
    ["kid", { kid: "agora-2026-08-b" }],
  ])("a claim altered after signing is refused: %s", async (_label, overrides) => {
    const h = await harness();
    const envelope = await signedEnvelope(h);
    const tampered = { ...envelope, claims: { ...envelope.claims, ...overrides } };

    const result = await h.verify(tampered, {
      // Route/method are also checked against the request, so point the
      // request at the tampered values to isolate the signature check.
      method: (tampered.claims.method as string) ?? "POST",
      route: (tampered.claims.route as string) ?? ROUTE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNAUTHORIZED");
  });

  test("a flipped signature bit is refused", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h);
    const flipped = `${envelope.signature.slice(0, 8)}${envelope.signature[8] === "0" ? "1" : "0"}${envelope.signature.slice(9)}`;

    const result = await h.verify({ ...envelope, signature: flipped });
    expect(result).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  test("a signature from another key is refused", async () => {
    const h = await harness();
    const other = await makeKeypair();
    const claims = await baseClaims();
    const result = await h.verify({ claims, signature: await sign(other.privateKey, claims) });
    expect(result).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  test("an altered payload is refused even with a valid signature", async () => {
    // The digest is inside the signed claims, so the signature stays valid and
    // the body no longer matches it. This is the check that stops a proxy from
    // rewriting a directive in flight.
    const h = await harness();
    const result = await h.verify(await signedEnvelope(h), { body: '{"focus":"something else"}' });
    expect(result).toMatchObject({ ok: false, reason: "payload_mismatch" });
  });

  test("an envelope for one route cannot be lifted onto another", async () => {
    const h = await harness();
    const result = await h.verify(await signedEnvelope(h), { route: "/v1/p/:id/claims" });
    expect(result).toMatchObject({ ok: false, reason: "action_not_permitted" });
  });

  test("an action outside the permitted set is refused", async () => {
    const h = await harness();
    const result = await h.verify(await signedEnvelope(h), {
      permittedActions: ["directive.revoke"],
    });
    expect(result).toMatchObject({ ok: false, reason: "action_not_permitted" });
  });
});

describe("verification — clock", () => {
  test("an expired envelope is refused", async () => {
    const h = await harness();
    const result = await h.verify(await signedEnvelope(h), { now: NOW + 61 + 60 + 1 });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  test("expiry tolerates bounded clock skew", async () => {
    const h = await harness();
    const result = await h.verify(await signedEnvelope(h), { now: NOW + 61 });
    expect(result.ok).toBe(true);
  });

  test("a configurable skew must be a non-negative safe integer", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h);

    for (const clockSkewSeconds of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await h.verify(envelope, { clockSkewSeconds })).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("an envelope issued in the future is refused", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h, { iat: NOW + 3600, exp: NOW + 3660 });
    const result = await h.verify(envelope);
    expect(result).toMatchObject({ ok: false, reason: "issued_in_future" });
  });

  test("an over-long lifetime is refused even if unexpired", async () => {
    // Without this bound a signer could mint a decade-long envelope and the
    // replay window would have to remember its nonce for a decade.
    const h = await harness();
    const envelope = await signedEnvelope(h, { exp: NOW + 86_400 });
    const result = await h.verify(envelope);
    expect(result).toMatchObject({ ok: false, reason: "lifetime_too_long" });
  });

  test("a finite positive maximum lifetime control is load-bearing", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h, { exp: NOW + 61 });

    expect(await h.verify(envelope, { maxLifetimeSeconds: 60 })).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      reason: "lifetime_too_long",
    });
    expect(h.nonces.size).toBe(0);
    expect(await h.verify(envelope, { maxLifetimeSeconds: 61 })).toMatchObject({ ok: true });
  });

  test.each([
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["fraction", 1.5],
    ["zero", 0],
    ["negative", -1],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "a %s maximum lifetime is refused before nonce claim without reflection",
    async (_label, maxLifetimeSeconds) => {
      const h = await harness();
      const envelope = await signedEnvelope(h);

      expect(await h.verify(envelope, { maxLifetimeSeconds })).toEqual({
        ok: false,
        code: "UNAUTHORIZED",
        reason: "malformed",
      });
      expect(h.nonces.size).toBe(0);
      expect(await h.verify(envelope)).toMatchObject({ ok: true });
    },
  );

  test("exp before iat is malformed", async () => {
    const h = await harness();
    const result = await h.verify(await signedEnvelope(h, { exp: NOW - 1 }));
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("verification — replay", () => {
  test("the first presentation is accepted and the second is refused", async () => {
    const h = await harness();
    const envelope = await signedEnvelope(h);

    expect((await h.verify(envelope)).ok).toBe(true);
    expect(await h.verify(envelope)).toMatchObject({ ok: false, reason: "replayed" });
  });

  test("PLANTED: a fast-isolate cleanup cannot forget a nonce still replayable to a slow isolate", async () => {
    const h = await harness();
    const skew = 60;
    const a = await signedEnvelope(h, { nonce: "a".repeat(43) });
    const fastNow = a.claims.exp + 3 * skew;
    const b = await signedEnvelope(h, {
      iat: fastNow - 60,
      exp: fastNow + 60,
      nonce: "b".repeat(43),
    });

    // A is accepted normally. B is a distinct valid envelope whose claim runs
    // the real MemoryNonceStore cleanup at the fast clock boundary. At the same
    // real instant a slow isolate reads exp + S, where A remains valid.
    expect((await h.verify(a, { clockSkewSeconds: skew })).ok).toBe(true);
    expect((await h.verify(b, { now: fastNow, clockSkewSeconds: skew })).ok).toBe(true);
    expect(await h.verify(a, { now: a.claims.exp + skew, clockSkewSeconds: skew })).toMatchObject({
      ok: false,
      reason: "replayed",
    });
  });

  test("a nonce is not consumed by an envelope that fails verification", async () => {
    // Otherwise an unauthenticated attacker burns nonces by replaying garbage,
    // and the legitimate write that follows is refused as a replay.
    const h = await harness();
    const envelope = await signedEnvelope(h);
    const forged = { ...envelope, signature: "0".repeat(128) };

    expect((await h.verify(forged)).ok).toBe(false);
    expect(h.nonces.size).toBe(0);
    expect((await h.verify(envelope)).ok).toBe(true);
  });

  test("distinct nonces are independent", async () => {
    const h = await harness();
    expect((await h.verify(await signedEnvelope(h, { nonce: "a".repeat(43) }))).ok).toBe(true);
    expect((await h.verify(await signedEnvelope(h, { nonce: "b".repeat(43) }))).ok).toBe(true);
  });

  test("the replay window fails closed when it cannot answer", async () => {
    const h = await harness();
    const full = new MemoryNonceStore(0);
    const result = await h.verify(await signedEnvelope(h), { nonces: full });
    expect(result).toMatchObject({ ok: false, reason: "store_unavailable" });
  });

  test("expired entries are evicted rather than accumulated", async () => {
    const store = new MemoryNonceStore();
    expect(await store.claim("n1", NOW + 10, NOW)).toBe(true);
    expect(store.size).toBe(1);
    expect(await store.claim("n2", NOW + 3600, NOW + 11)).toBe(true);
    expect(store.size).toBe(1);
  });
});

describe("verification — key rotation overlap", () => {
  test("both keys verify during the overlap window", async () => {
    const outgoing = await makeKeypair();
    const incoming = await makeKeypair();
    const keyring = new VerificationKeyring([
      {
        kid: "agora-2026-07",
        publicKeyHex: await publicKeyHex(outgoing.publicKey),
        notBefore: 0,
        notAfter: NOW + 3600,
      },
      {
        kid: "agora-2026-08",
        publicKeyHex: await publicKeyHex(incoming.publicKey),
        notBefore: NOW - 3600,
      },
    ]);

    for (const [kid, keypair] of [
      ["agora-2026-07", outgoing],
      ["agora-2026-08", incoming],
    ] as const) {
      const claims = await baseClaims({ kid, nonce: `${kid}${"x".repeat(30)}` });
      const result = await verifyServiceEnvelope(
        { claims, signature: await sign(keypair.privateKey, claims) },
        {
          keyring,
          nonces: new MemoryNonceStore(),
          now: NOW,
          issuer: "agora",
          audience: "stoa",
          body: BODY,
          method: "POST",
          route: ROUTE,
          permittedActions: ["directive.create"],
        },
      );
      expect(result.ok).toBe(true);
    }
  });

  test("a retired key cannot sign a newly issued envelope", async () => {
    const retired = await makeKeypair();
    const current = await makeKeypair();
    const keyring = new VerificationKeyring([
      {
        kid: "agora-old",
        publicKeyHex: await publicKeyHex(retired.publicKey),
        notBefore: 0,
        notAfter: NOW - 1,
      },
      {
        kid: "agora-current",
        publicKeyHex: await publicKeyHex(current.publicKey),
        notBefore: NOW - 100,
      },
    ]);
    const claims = await baseClaims({ kid: "agora-old" });
    const result = await verifyServiceEnvelope(
      { claims, signature: await sign(retired.privateKey, claims) },
      {
        keyring,
        nonces: new MemoryNonceStore(),
        now: NOW,
        issuer: "agora",
        audience: "stoa",
        body: BODY,
        method: "POST",
        route: ROUTE,
        permittedActions: ["directive.create"],
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "key_retired" });
  });

  test("a key not yet valid cannot backdate an envelope", async () => {
    const h = await harness({ notBefore: NOW + 100 });
    const result = await h.verify(await signedEnvelope(h));
    expect(result).toMatchObject({ ok: false, reason: "key_not_yet_valid" });
  });

  test("an unknown kid is refused", async () => {
    const h = await harness();
    const claims = await baseClaims({ kid: "agora-nonexistent" });
    const result = await h.verify({ claims, signature: await sign(h.keypair.privateKey, claims) });
    expect(result).toMatchObject({ ok: false, reason: "unknown_kid" });
  });

  test("a keyring cannot hold two keys under one id", async () => {
    expect(
      () =>
        new VerificationKeyring([
          { kid: "dup", publicKeyHex: "00".repeat(32), notBefore: 0 },
          { kid: "dup", publicKeyHex: "11".repeat(32), notBefore: 0 },
        ]),
    ).toThrow(/duplicate key identifier/);
  });
});

describe("keyring constructor configuration", () => {
  const good = { kid: "k", publicKeyHex: "ab".repeat(32), notBefore: 0 };

  test.each([
    ["an empty kid", { ...good, kid: "" }],
    ["a kid with spaces", { ...good, kid: "agora key" }],
    ["an over-long kid", { ...good, kid: "k".repeat(65) }],
    ["a short public key", { ...good, publicKeyHex: "ab".repeat(31) }],
    ["a long public key", { ...good, publicKeyHex: "ab".repeat(33) }],
    ["an uppercase public key", { ...good, publicKeyHex: "AB".repeat(32) }],
    ["a non-hex public key", { ...good, publicKeyHex: "zz".repeat(32) }],
    ["a negative notBefore", { ...good, notBefore: -1 }],
    ["a fractional notBefore", { ...good, notBefore: 1.5 }],
    ["a fractional notAfter", { ...good, notBefore: 0, notAfter: 1.5 }],
    ["notAfter equal to notBefore", { ...good, notBefore: 10, notAfter: 10 }],
    ["notAfter before notBefore", { ...good, notBefore: 20, notAfter: 10 }],
  ])("refuses %s", (_label, record) => {
    expect(() => new VerificationKeyring([record])).toThrow(KeyringConfigError);
  });

  test("a well-formed record is accepted", () => {
    expect(() => new VerificationKeyring([good])).not.toThrow();
    expect(new VerificationKeyring([good]).kids).toEqual(["k"]);
  });

  test("validated key records cannot be mutated through either caller reference", async () => {
    const pair = await makeKeypair();
    const configured = {
      kid: "sealed-current",
      publicKeyHex: await publicKeyHex(pair.publicKey),
      notBefore: NOW - 10,
    };
    const keyring = new VerificationKeyring([configured]);
    configured.publicKeyHex = "00".repeat(32);
    configured.notBefore = NOW + 10;

    const lookup = await keyring.lookup("sealed-current", NOW);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error("sealed key record became unusable after caller mutation");
    expect(lookup.record).not.toBe(configured);
    expect(lookup.record.publicKeyHex).toBe(await publicKeyHex(pair.publicKey));
    expect(lookup.record.notBefore).toBe(NOW - 10);
    expect(Object.isFrozen(lookup.record)).toBe(true);
    expect(() => Object.assign(lookup.record, { notBefore: NOW + 10 })).toThrow(TypeError);
  });

  test("an invalid configured kid is never echoed by its startup error", () => {
    const canary = "kid-should-not-appear-in-an-error!";
    let message = "";
    try {
      new VerificationKeyring([{ ...good, kid: canary }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("invalid key identifier");
    expect(message).not.toContain(canary);
  });

  test("exactly the newest current key must be open-ended", () => {
    expect(
      () =>
        new VerificationKeyring([
          { kid: "previous", publicKeyHex: "ab".repeat(32), notBefore: 0 },
          { kid: "current", publicKeyHex: "cd".repeat(32), notBefore: 10 },
        ]),
    ).toThrow(/exactly the newest current key/);
    expect(
      () =>
        new VerificationKeyring([
          { kid: "previous", publicKeyHex: "ab".repeat(32), notBefore: 0, notAfter: 20 },
          { kid: "current", publicKeyHex: "cd".repeat(32), notBefore: 10 },
        ]),
    ).not.toThrow();
    expect(
      () =>
        new VerificationKeyring([
          { kid: "retired", publicKeyHex: "ab".repeat(32), notBefore: 0, notAfter: 10 },
        ]),
    ).toThrow(/exactly the newest current key/);
    expect(
      () =>
        new VerificationKeyring([
          { kid: "old-current", publicKeyHex: "ab".repeat(32), notBefore: 0 },
          {
            kid: "newer-retired",
            publicKeyHex: "cd".repeat(32),
            notBefore: 10,
            notAfter: 20,
          },
        ]),
    ).toThrow(/exactly the newest current key/);
  });

  test.each([
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    1.5,
  ])("a malformed issued-at value %s cannot select a verification key", async (issuedAt) => {
    const keyring = new VerificationKeyring([good]);
    expect(await keyring.lookup(good.kid, issuedAt)).toEqual({
      ok: false,
      reason: "key_unusable",
    });
  });

  test("non-object records fail as typed configuration errors", () => {
    expect(() => new VerificationKeyring([null] as never)).toThrow(KeyringConfigError);
  });

  test.each([42, true])("a non-string key id %p fails as a typed configuration error", (kid) => {
    expect(() => new VerificationKeyring([{ ...good, kid }] as never)).toThrow(KeyringConfigError);
  });

  test("a symbol public key fails as a typed configuration error", () => {
    expect(
      () => new VerificationKeyring([{ ...good, publicKeyHex: Symbol("public-key") }] as never),
    ).toThrow(KeyringConfigError);
  });

  test("throwing record and array accessors fail as nonsecret typed configuration errors", () => {
    const canary = "PRIVATE_PROXY_DIAGNOSTIC";
    const throwingRecord = new Proxy(good, {
      ownKeys() {
        throw new Error(canary);
      },
    });
    const throwingRecords = new Proxy([good], {
      get(target, property, receiver) {
        if (property === "length") throw new Error(canary);
        return Reflect.get(target, property, receiver);
      },
    });
    for (const construct of [
      () => new VerificationKeyring([throwingRecord]),
      () => new VerificationKeyring(throwingRecords),
    ]) {
      let caught: unknown;
      try {
        construct();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KeyringConfigError);
      expect((caught as Error).message).toBe("keyring records could not be read");
      expect((caught as Error).message).not.toContain(canary);
    }
  });

  test("a trap-thrown forged configuration error is normalized rather than trusted", () => {
    const canary = "CALLER_FORGED_KEYRING_ERROR";
    const throwingRecord = new Proxy(good, {
      ownKeys() {
        throw new KeyringConfigError(canary);
      },
    });

    let caught: unknown;
    try {
      new VerificationKeyring([throwingRecord]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KeyringConfigError);
    expect((caught as Error).message).toBe("keyring records could not be read");
    expect((caught as Error).message).not.toContain(canary);
  });

  test("a syntactically valid key the runtime rejects fails closed, not by throwing", async () => {
    // 32 lowercase hex bytes that are not a valid Ed25519 point. Construction
    // cannot tell; `lookup` must refuse rather than let an exception escape
    // verifyServiceEnvelope and become a 500 carrying a stack trace.
    const keyring = new VerificationKeyring([
      { kid: "bad-point", publicKeyHex: "ff".repeat(32), notBefore: 0 },
    ]);
    const claims = await baseClaims({ kid: "bad-point" });
    let result: Awaited<ReturnType<typeof verifyServiceEnvelope>> | undefined;
    let threw = false;
    try {
      result = await verifyServiceEnvelope(
        { claims, signature: "0".repeat(128) },
        {
          keyring,
          nonces: new MemoryNonceStore(),
          now: NOW,
          issuer: "agora",
          audience: "stoa",
          body: BODY,
          method: "POST",
          route: ROUTE,
          permittedActions: ["directive.create"],
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
    if (result !== undefined && !result.ok) {
      expect(["key_unusable", "bad_signature"]).toContain(result.reason);
    }
  });
});

const MOUNTED_REPLAY_KEY = "A".repeat(43);
const MOUNTED_STOA_ORIGIN = "https://a.asimposium.org";
const MOUNTED_AGORA_ORIGIN = "https://asimposium.org";
const MOUNTED_MINT_URL = `${MOUNTED_STOA_ORIGIN}/v1/enrollments`;
const mountedContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as never;

function nonceClaimingD1(): { readonly db: never; readonly preparedSql: string[] } {
  const preparedSql: string[] = [];
  const db = {
    prepare(sql: string) {
      preparedSql.push(sql);
      return {
        bind: (..._parameters: unknown[]) => ({
          run: async () => ({
            meta: { changes: sql.includes("INSERT INTO auth_envelope_nonces") ? 1 : 0 },
          }),
        }),
      };
    },
  };
  return { db: db as never, preparedSql };
}

function mountedEnv(db: unknown, serviceEnvelopeKeys?: string): never {
  return {
    DB: db,
    ENROLLMENT_REPLAY_KEY: MOUNTED_REPLAY_KEY,
    STOA_ORIGIN: MOUNTED_STOA_ORIGIN,
    AGORA_ORIGIN: MOUNTED_AGORA_ORIGIN,
    ...(serviceEnvelopeKeys === undefined ? {} : { SERVICE_ENVELOPE_KEYS: serviceEnvelopeKeys }),
  } as never;
}

describe("mounted createApp service-envelope keyring configuration", () => {
  test("absent config retains the sponsor 503 while malformed-present fails mounted construction before downstream work", async () => {
    const { db, preparedSql } = nonceClaimingD1();
    const malformed = "MOUNTED_KEYRING_CONFIG_CANARY";
    const diagnostics: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      diagnostics.push(values);
    };
    try {
      // `createApp()` has no binding yet. Parsing occurs only once a mounted
      // enrollment path receives an environment, not at module startup.
      const app = createApp();
      expect(diagnostics).toEqual([]);

      const absent = await app.fetch(
        new Request(MOUNTED_MINT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
        }),
        mountedEnv(db),
        mountedContext,
      );
      expect(absent.status).toBe(503);
      expect(await absent.json()).toMatchObject({ code: "SPONSOR_AUTH_UNAVAILABLE" });
      expect(diagnostics).toEqual([]);
      expect(preparedSql).toEqual([]);

      // Same app and D1 handle: only absent versus present-malformed config
      // changes. This kills a cache key that collapses those two states.
      let failure: unknown;
      try {
        await app.fetch(
          new Request(MOUNTED_MINT_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
          }),
          mountedEnv(db, malformed),
          mountedContext,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KeyringConfigError);
      expect((failure as Error).message).toBe("configured keyring must be valid JSON");
      expect(preparedSql).toEqual([]);

      // A configuration failure on an owned write path must not poison an
      // unrelated public read, which never constructs the enrollment stack.
      const publicRead = await app.fetch(
        new Request(`${MOUNTED_STOA_ORIGIN}/`),
        mountedEnv(db, malformed),
        mountedContext,
      );
      expect(publicRead.status).toBe(200);
    } finally {
      console.error = originalError;
    }
    expect(diagnostics).toEqual([
      ["[wire] invalid service-envelope keyring", { error: "KEYRING_CONFIG_INVALID" }],
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(malformed);
  });

  test.each([
    ["empty string", "", "configured keyring must be valid JSON"],
    ["empty JSON array", "[]", "configured keyring must be a nonempty array"],
  ])(
    "a present %s keyring fails at mounted configuration before downstream work",
    async (_label, keyring, expectedMessage) => {
      const { db, preparedSql } = nonceClaimingD1();
      const diagnostics: unknown[][] = [];
      const originalError = console.error;
      console.error = (...values: unknown[]) => {
        diagnostics.push(values);
      };
      try {
        const app = createApp();
        expect(diagnostics).toEqual([]);

        let failure: unknown;
        try {
          await app.fetch(
            new Request(MOUNTED_MINT_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
            }),
            mountedEnv(db, keyring),
            mountedContext,
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(KeyringConfigError);
        expect((failure as Error).message).toBe(expectedMessage);
        expect(preparedSql).toEqual([]);
      } finally {
        console.error = originalError;
      }
      expect(diagnostics).toEqual([
        ["[wire] invalid service-envelope keyring", { error: "KEYRING_CONFIG_INVALID" }],
      ]);
    },
  );

  test("an all-retired mounted keyring fails typed configuration construction", async () => {
    const { db, preparedSql } = nonceClaimingD1();
    const retiredKeyring = JSON.stringify([
      {
        kid: "mounted-retired",
        publicKeyHex: "ab".repeat(32),
        notBefore: 0,
        notAfter: 1,
      },
    ]);
    const diagnostics: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      diagnostics.push(values);
    };
    try {
      let failure: unknown;
      try {
        await createApp().fetch(
          new Request(MOUNTED_MINT_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
          }),
          mountedEnv(db, retiredKeyring),
          mountedContext,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KeyringConfigError);
      expect((failure as Error).message).toBe(
        "exactly the newest current key must have an open-ended validity window",
      );
      expect(preparedSql).toEqual([]);
    } finally {
      console.error = originalError;
    }
    expect(diagnostics).toEqual([
      ["[wire] invalid service-envelope keyring", { error: "KEYRING_CONFIG_INVALID" }],
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(retiredKeyring);
  });

  test.each([
    ["privateKey", "MOUNTED_PRIVATE_KEY_CANARY"],
    ["secret", "MOUNTED_SECRET_CANARY"],
  ] as const)(
    "mounted app rejects an extra %s keyring field without reflecting its value",
    async (field, canary) => {
      const { db, preparedSql } = nonceClaimingD1();
      const diagnostics: unknown[][] = [];
      const originalConsoleError = console.error;
      console.error = (...values: unknown[]) => {
        diagnostics.push(values);
      };

      let failure: unknown;
      try {
        const keyring = JSON.stringify([
          {
            kid: "mounted-current",
            publicKeyHex: "ab".repeat(32),
            notBefore: 0,
            [field]: canary,
          },
        ]);

        try {
          await createApp().fetch(
            new Request(MOUNTED_MINT_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
            }),
            mountedEnv(db, keyring),
            mountedContext,
          );
        } catch (error) {
          failure = error;
        }
      } finally {
        console.error = originalConsoleError;
      }

      expect(failure).toBeInstanceOf(KeyringConfigError);
      expect((failure as Error).message).toBe("key record contains an unsupported field");
      expect(JSON.stringify(diagnostics)).not.toContain(canary);
      expect(preparedSql).toEqual([]);
    },
  );

  test("a current key reaches mounted signature and nonce ingress before the typed mint refusal", async () => {
    const { db, preparedSql } = nonceClaimingD1();
    const keypair = await makeKeypair();
    const kid = "mounted-current";
    const keyring = JSON.stringify([
      {
        kid,
        publicKeyHex: await publicKeyHex(keypair.publicKey),
        notBefore: 0,
      },
    ]);
    const now = Math.floor(Date.now() / 1_000);
    const body = "{}";
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid,
      now,
      method: "POST",
      route: "/v1/enrollments",
      action: "enrollment.mint",
      principalId: "usr_01JXYZ0000000000000000",
      body,
    });

    const response = await createApp().fetch(
      new Request(MOUNTED_MINT_URL, {
        method: "POST",
        headers: { ...serviceEnvelopeHeaders(envelope), "idempotency-key": "mounted-current-key" },
        body,
      }),
      mountedEnv(db, keyring),
      mountedContext,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "MINT_BODY_INVALID" });
    expect(preparedSql).toHaveLength(2);
    expect(preparedSql[0]).toContain("DELETE FROM auth_envelope_nonces");
    expect(preparedSql[1]).toContain("INSERT INTO auth_envelope_nonces");
  });

  test("both keys reach mounted ingress during an overlapping rotation", async () => {
    const { db, preparedSql } = nonceClaimingD1();
    const previous = await makeKeypair();
    const current = await makeKeypair();
    const now = Math.floor(Date.now() / 1_000);
    const keyring = JSON.stringify([
      {
        kid: "mounted-previous",
        publicKeyHex: await publicKeyHex(previous.publicKey),
        notBefore: 0,
        notAfter: now + 3600,
      },
      {
        kid: "mounted-current",
        publicKeyHex: await publicKeyHex(current.publicKey),
        notBefore: now - 3600,
      },
    ]);
    const app = createApp();

    for (const [kid, privateKey, idempotencyKey] of [
      ["mounted-previous", previous.privateKey, "mounted-previous-key"],
      ["mounted-current", current.privateKey, "mounted-current-key"],
    ] as const) {
      const body = "{}";
      const envelope = await mintServiceEnvelope({
        privateKey,
        kid,
        now,
        method: "POST",
        route: "/v1/enrollments",
        action: "enrollment.mint",
        principalId: "usr_mounted_rotation",
        body,
      });

      const response = await app.fetch(
        new Request(MOUNTED_MINT_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            ...serviceEnvelopeHeaders(envelope),
          },
          body,
        }),
        mountedEnv(db, keyring),
        mountedContext,
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "MINT_BODY_INVALID" });
    }

    expect(preparedSql).toHaveLength(4);
    expect(
      preparedSql.filter((sql) => sql.includes("DELETE FROM auth_envelope_nonces")),
    ).toHaveLength(2);
    expect(
      preparedSql.filter((sql) => sql.includes("INSERT INTO auth_envelope_nonces")),
    ).toHaveLength(2);
  });
});

describe("verification — plane binding", () => {
  test("an envelope minted for another audience is refused", async () => {
    const h = await harness();
    const claims = await baseClaims({ aud: "somewhere-else" });
    const result = await h.verify({ claims, signature: await sign(h.keypair.privateKey, claims) });
    expect(result).toMatchObject({ ok: false, reason: "wrong_audience" });
  });

  test("an envelope from an unexpected issuer is refused", async () => {
    const h = await harness();
    const claims = await baseClaims({ iss: "not-agora" });
    const result = await h.verify({ claims, signature: await sign(h.keypair.privateKey, claims) });
    expect(result).toMatchObject({ ok: false, reason: "wrong_issuer" });
  });

  test("an unsupported version or algorithm is refused", async () => {
    const h = await harness();
    for (const [overrides, reason] of [
      [{ v: "asimp-env-0" }, "unsupported_version"],
      [{ alg: "HS256" }, "unsupported_alg"],
    ] as const) {
      const claims = await baseClaims(overrides);
      const result = await h.verify({
        claims,
        signature: await sign(h.keypair.privateKey, claims),
      });
      expect(result).toMatchObject({ ok: false, reason });
    }
  });
});

describe("refusals do not teach a forger", () => {
  test("every refusal carries the same external code and no detail", async () => {
    const h = await harness();
    const cases: unknown[] = [
      { claims: await baseClaims(), signature: "0".repeat(128) },
      "not-an-envelope",
      { claims: await baseClaims({ aud: "elsewhere" }), signature: "0".repeat(128) },
    ];
    for (const value of cases) {
      const result = await h.verify(value);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("UNAUTHORIZED");
      // `reason` is an internal enum for metrics; it is never free text and
      // never derived from attacker input.
      expect(typeof result.reason).toBe("string");
      expect(result.reason).not.toContain(" ");
    }
  });
});
