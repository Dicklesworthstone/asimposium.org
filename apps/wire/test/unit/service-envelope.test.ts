import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  test("is independent of object key order", async () => {
    const ordered = await baseClaims();
    const shuffled = Object.fromEntries(
      Object.entries(ordered).reverse(),
    ) as unknown as ServiceEnvelopeClaims;

    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(ordered)[0]);
    expect(await canonicalDigest(shuffled)).toBe(await canonicalDigest(ordered));
  });

  test("length prefixes defeat the concatenation collision", async () => {
    // ("a:1","b") and ("a","1:b") are the classic pair a delimiter-only scheme
    // cannot tell apart. If these ever collide, one signature authorises a
    // different principal than the one that was signed for.
    const left = await canonicalDigest(await baseClaims({ action: "a:1", principal_id: "b" }));
    const right = await canonicalDigest(await baseClaims({ action: "a", principal_id: "1:b" }));
    expect(left).not.toBe(right);
  });

  test("a record separator inside a value cannot reframe the field list", async () => {
    const injected = await canonicalDigest(
      await baseClaims({ action: `ab14:principal_id:5:evil` }),
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
    ["principal_id", "usr_01"],
    ["kid", "agora a"],
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
    const claims = await baseClaims({ action: "ab\nc:d" });
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
    const keyring = new VerificationKeyring([
      {
        kid: "agora-old",
        publicKeyHex: await publicKeyHex(retired.publicKey),
        notBefore: 0,
        notAfter: NOW - 1,
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

describe("keyring configuration fails at construction, never at request time", () => {
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

  test("only the newest current key may be open-ended", () => {
    expect(
      () =>
        new VerificationKeyring([
          { kid: "previous", publicKeyHex: "ab".repeat(32), notBefore: 0 },
          { kid: "current", publicKeyHex: "cd".repeat(32), notBefore: 10 },
        ]),
    ).toThrow(/only the newest current key/);
    expect(
      () =>
        new VerificationKeyring([
          { kid: "previous", publicKeyHex: "ab".repeat(32), notBefore: 0, notAfter: 20 },
          { kid: "current", publicKeyHex: "cd".repeat(32), notBefore: 10 },
        ]),
    ).not.toThrow();
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
