import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CANONICAL_FIELDS,
  canonicalBytes,
  ENVELOPE_VERSION,
  importEd25519PrivateSeedHex,
  mintNonce,
  mintServiceEnvelope,
  payloadDigest,
  SERVICE_ENVELOPE_HEADER,
  type ServiceEnvelopeClaims,
  serviceEnvelopeHeaders,
  sha256Hex,
  toHex,
} from "../../lib/service-envelope.ts";

/**
 * S-6 cross-plane auth, apex signing side (asimposiumorg-vw3).
 *
 * `apps/web` signs; `apps/wire` verifies. They are independent implementations
 * of the same canonical form on purpose — a shared helper would hide a
 * disagreement rather than surface it — so the agreement is asserted against
 * the golden corpus the Worker owns.
 *
 * SCOPE: this proves the bytes and the signature. It proves nothing about
 * Auth.js issuing a host-only cookie, Google sign-in, or a deployed Worker.
 */

/**
 * The corpus lives with the authoritative verifier. It is read from disk rather
 * than imported so neither package takes a build-time dependency on the other;
 * it moves to `packages/contracts` at W1.1 (asimposiumorg-phg).
 */
const CORPUS_PATH = join(
  dirname(dirname(dirname(import.meta.dir))),
  "wire",
  "src",
  "auth",
  "service-envelope-vectors.json",
);

interface Corpus {
  vectors: Record<
    string,
    { note: string; claims: ServiceEnvelopeClaims; canonical_sha256: string }
  >;
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
const vectorNames = Object.keys(corpus.vectors);

const NOW = 1786000000;
const BODY = '{"focus":"the simply-connected case"}';

async function makeKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

describe("canonicalization agrees with the Worker, byte for byte", () => {
  test("the corpus was found and is non-trivial", () => {
    expect(vectorNames.length).toBeGreaterThanOrEqual(8);
  });

  test.each(vectorNames)("vector %s canonicalizes to the pinned digest", async (name) => {
    const vector = corpus.vectors[name];
    expect(vector).toBeDefined();
    expect(await sha256Hex(canonicalBytes(vector!.claims))).toBe(vector!.canonical_sha256);
  });

  test("the field list and version match the Worker's", () => {
    expect(ENVELOPE_VERSION).toBe("asimp-env-1");
    expect([...CANONICAL_FIELDS]).toEqual([
      "v",
      "kid",
      "alg",
      "iss",
      "aud",
      "iat",
      "exp",
      "nonce",
      "method",
      "route",
      "action",
      "principal_type",
      "principal_id",
      "payload_sha256",
    ]);
  });

  test("key order in the claims object does not change the bytes", async () => {
    const vector = corpus.vectors.minimal;
    expect(vector).toBeDefined();
    const reversed = Object.fromEntries(
      Object.entries(vector!.claims).reverse(),
    ) as unknown as ServiceEnvelopeClaims;
    expect(await sha256Hex(canonicalBytes(reversed))).toBe(vector!.canonical_sha256);
  });

  test("a non-integer timestamp is refused rather than silently rendered", () => {
    const vector = corpus.vectors.minimal;
    expect(() => canonicalBytes({ ...vector!.claims, iat: 1.5 })).toThrow(/safe integer/);
  });
});

describe("minting", () => {
  test("imports a 32-byte Ed25519 seed as a PKCS#8 signing key", async () => {
    const keypair = await makeKeypair();
    const exported = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keypair.privateKey));
    expect(exported.length).toBe(48);

    const imported = await importEd25519PrivateSeedHex(toHex(exported.slice(-32)));
    expect(imported.extractable).toBe(false);
    expect(imported.usages).toEqual(["sign"]);

    const envelope = await mintServiceEnvelope({
      privateKey: imported,
      kid: "seed-import",
      now: NOW,
      method: "POST",
      route: "/v1/enrollments",
      action: "enrollment.mint",
      principalId: "usr_1",
      body: BODY,
    });
    const signature = new Uint8Array(
      (envelope.signature.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)),
    );
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        keypair.publicKey,
        signature.slice().buffer,
        canonicalBytes(envelope.claims).slice().buffer,
      ),
    ).toBe(true);
  });

  test("rejects malformed private seeds before WebCrypto", async () => {
    for (const malformed of ["00", "g".repeat(64), "A".repeat(64), "0".repeat(66)]) {
      await expect(importEd25519PrivateSeedHex(malformed)).rejects.toThrow(
        /64 lowercase hex characters/,
      );
    }
  });

  test("binds method, route, action and payload digest into the signature", async () => {
    const keypair = await makeKeypair();
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "agora-2026-08-a",
      now: NOW,
      method: "POST",
      route: "/v1/p/:id/directives",
      action: "directive.create",
      principalId: "usr_01JXYZ0000000000000000",
      body: BODY,
    });

    expect(envelope.claims.method).toBe("POST");
    expect(envelope.claims.route).toBe("/v1/p/:id/directives");
    expect(envelope.claims.action).toBe("directive.create");
    expect(envelope.claims.payload_sha256).toBe(await payloadDigest(BODY));
    expect(envelope.claims.v).toBe(ENVELOPE_VERSION);
    expect(envelope.claims.alg).toBe("Ed25519");
    expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  test("PLANTED: a Buffer subview hashes only its body bytes", async () => {
    const prefix = "outside-before:";
    const bodyText = '{"focus":"exact Buffer view"}';
    const suffix = ":outside-after";
    const backing = Buffer.from(`${prefix}${bodyText}${suffix}`);
    const body = backing.subarray(prefix.length, prefix.length + bodyText.length);
    const originalBacking = Buffer.from(backing);
    const expected = toHex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText))),
    );

    // Under the old `bytes.slice().buffer` implementation, both calls hashed
    // the same Buffer backing allocation and this planted assertion failed.
    expect(await sha256Hex(body)).toBe(expected);
    expect(await sha256Hex(body)).not.toBe(await sha256Hex(backing));
    expect(await payloadDigest(body)).toBe(expected);
    expect(backing).toEqual(originalBacking);

    const keypair = await makeKeypair();
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "buffer-subview",
      now: NOW,
      method: "POST",
      route: "/v1/x",
      action: "a",
      principalId: "usr_1",
      body,
    });
    expect(envelope.claims.payload_sha256).toBe(expected);
  });

  test("the signature verifies against the matching public key", async () => {
    const keypair = await makeKeypair();
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "k",
      now: NOW,
      method: "POST",
      route: "/v1/x",
      action: "a",
      principalId: "usr_1",
      body: BODY,
    });
    const verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      keypair.publicKey,
      new Uint8Array(
        (envelope.signature.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)),
      ) as BufferSource,
      canonicalBytes(envelope.claims) as BufferSource,
    );
    expect(verified).toBe(true);
  });

  test("the envelope is short-lived by default", async () => {
    const keypair = await makeKeypair();
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "k",
      now: NOW,
      method: "POST",
      route: "/v1/x",
      action: "a",
      principalId: "usr_1",
      body: BODY,
    });
    expect(envelope.claims.exp - envelope.claims.iat).toBeLessThanOrEqual(120);
    expect(envelope.claims.exp).toBeGreaterThan(envelope.claims.iat);
  });

  test("a non-integer or non-positive lifetime is refused", async () => {
    const keypair = await makeKeypair();
    const base = {
      privateKey: keypair.privateKey,
      kid: "k",
      method: "POST",
      route: "/v1/x",
      action: "a",
      principalId: "usr_1",
      body: BODY,
    };
    await expect(mintServiceEnvelope({ ...base, now: 1.5 })).rejects.toThrow(/integer/);
    await expect(mintServiceEnvelope({ ...base, now: NOW, lifetimeSeconds: 0 })).rejects.toThrow(
      /positive/,
    );
  });
});

describe("nonces", () => {
  test("are 256 bits of CSPRNG output, base64url, and do not repeat", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 512; index += 1) {
      const nonce = mintNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.has(nonce)).toBe(false);
      seen.add(nonce);
    }
  });
});

describe("the session never crosses the seam", () => {
  test("headers carry the envelope and nothing else", async () => {
    const keypair = await makeKeypair();
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "k",
      now: NOW,
      method: "POST",
      route: "/v1/x",
      action: "a",
      principalId: "usr_1",
      body: BODY,
    });
    const headers = serviceEnvelopeHeaders(envelope);

    expect(Object.keys(headers).sort()).toEqual([SERVICE_ENVELOPE_HEADER, "content-type"].sort());
    // Structural: there is no parameter through which a cookie or an
    // Authorization header could be forwarded to the agent plane.
    const serialized = JSON.stringify(headers).toLowerCase();
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("bearer");
  });

  test("the envelope names an opaque principal, never an email", async () => {
    const keypair = await makeKeypair();
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "k",
      now: NOW,
      method: "POST",
      route: "/v1/x",
      action: "a",
      principalId: "usr_01JXYZ0000000000000000",
      body: BODY,
    });
    expect(JSON.stringify(envelope)).not.toContain("@");
    expect(envelope.claims.principal_type).toBe("sponsor");
  });

  test("the payload appears only as a digest", async () => {
    const keypair = await makeKeypair();
    const secretish = '{"focus":"do-not-log-this-directive-body"}';
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "k",
      now: NOW,
      method: "POST",
      route: "/v1/x",
      action: "a",
      principalId: "usr_1",
      body: secretish,
    });
    expect(JSON.stringify(envelope)).not.toContain("do-not-log-this");
    expect(envelope.claims.payload_sha256).toBe(await payloadDigest(secretish));
  });
});

describe("hex helpers", () => {
  test("toHex is lowercase and zero-padded", () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  });
});

describe("canonical sponsor ids", () => {
  test("usr_ plus a Google sub is the only accepted shape", async () => {
    const { isCanonicalSponsorId } = await import("../../lib/sponsor-id.ts");
    // A real Google sub is 1-60 chars of digits; usr_-prefixed is canonical.
    expect(isCanonicalSponsorId("usr_105234567890123456789")).toBe(true);
    // The bare sub, an email, and an empty suffix are all non-canonical and
    // must never reach an envelope's principal_id.
    expect(isCanonicalSponsorId("105234567890123456789")).toBe(false);
    expect(isCanonicalSponsorId("usr_")).toBe(false);
    expect(isCanonicalSponsorId("sponsor@example.com")).toBe(false);
    expect(isCanonicalSponsorId(undefined)).toBe(false);
  });
});
