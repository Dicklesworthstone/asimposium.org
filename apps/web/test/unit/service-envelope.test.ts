import { describe, expect, mock, spyOn, test } from "bun:test";
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
import { dispatchSignedSponsorRequest } from "../../lib/stoa-sponsor.ts";

// The production-only marker correctly rejects a direct Bun import. Replacing
// only that marker lets this unit file exercise the unchanged public server
// API; no production test seam or client import is introduced.
mock.module("server-only", () => ({}));
const {
  operatorPrincipalIsAllowed,
  stoaConfigured,
  stoaMintEnrollment,
  stoaOperatorOverrideFellowCap,
} = await import("../../lib/stoa.ts");

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
const STOA_ENVIRONMENT_KEYS = [
  "STOA_ORIGIN",
  "SERVICE_ENVELOPE_PRIVATE_KEY_HEX",
  "SERVICE_ENVELOPE_KID",
  "HOST",
  "X_FORWARDED_HOST",
  "X_FORWARDED_PROTO",
  "OPERATOR_PRINCIPAL_IDS",
] as const;

type StoaEnvironmentKey = (typeof STOA_ENVIRONMENT_KEYS)[number];
type StoaEnvironment = Partial<Record<StoaEnvironmentKey, string>>;

async function withStoaEnvironment<T>(
  values: StoaEnvironment,
  operation: () => Promise<T>,
): Promise<T> {
  const original = new Map<StoaEnvironmentKey, string | undefined>();
  for (const key of STOA_ENVIRONMENT_KEYS) original.set(key, process.env[key]);

  try {
    for (const key of STOA_ENVIRONMENT_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await operation();
  } finally {
    for (const key of STOA_ENVIRONMENT_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makeKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

interface DispatchCounters {
  signed: number;
  readonly destinations: string[];
}

async function dispatchToConfiguredOrigin(
  stoaOrigin: unknown,
  counters: DispatchCounters,
  insecureLoopbackOrigin?: string,
): Promise<Response> {
  const keypair = await makeKeypair();
  return dispatchSignedSponsorRequest({
    stoaOrigin: stoaOrigin as string,
    path: "/v1/sponsor-probe",
    method: "POST",
    route: "/v1/sponsor-probe",
    action: "sponsor.probe",
    sponsorId: "usr_1",
    rawBody: BODY,
    privateKey: keypair.privateKey,
    kid: "origin-test",
    now: NOW,
    ...(insecureLoopbackOrigin === undefined ? {} : { insecureLoopbackOrigin }),
    mintEnvelopeImpl: async (options) => {
      counters.signed += 1;
      return mintServiceEnvelope(options);
    },
    fetchImpl: async (input) => {
      counters.destinations.push(String(input));
      return new Response(null, { status: 204 });
    },
  });
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

describe("configured Stoa origin binding", () => {
  const production = "https://a.asimposium.org";
  const staging = "https://a-staging.asimposium.org";
  const loopback = "http://127.0.0.1:8787";

  test.each([production, staging])("dispatches only to configured trusted HTTPS %s", async (origin) => {
    const counters: DispatchCounters = { signed: 0, destinations: [] };
    await expect(dispatchToConfiguredOrigin(origin, counters)).resolves.toMatchObject({ status: 204 });
    expect(counters.signed).toBe(1);
    expect(counters.destinations).toEqual([`${origin}/v1/sponsor-probe`]);
  });

  test("exact configured loopback still requires and accepts its explicit allowance", async () => {
    const counters: DispatchCounters = { signed: 0, destinations: [] };
    await expect(dispatchToConfiguredOrigin(loopback, counters, loopback)).resolves.toMatchObject({
      status: 204,
    });
    expect(counters.signed).toBe(1);
    expect(counters.destinations).toEqual([`${loopback}/v1/sponsor-probe`]);
  });

  test.each([
    ["missing", undefined],
    ["malformed trailing slash", `${production}/`],
    ["lookalike", "https://a-staging.asimposium.org.evil.invalid"],
    ["foreign", "https://evil.invalid"],
  ])("PLANTED: %s origin refuses before signing or fetch", async (_label, origin) => {
    const counters: DispatchCounters = { signed: 0, destinations: [] };
    await expect(dispatchToConfiguredOrigin(origin, counters)).rejects.toThrow(
      "trusted configured origin",
    );
    expect(counters.signed).toBe(0);
    expect(counters.destinations).toEqual([]);
  });

  test("PLANTED: loopback allowance cannot be used to widen configured HTTPS", async () => {
    const counters: DispatchCounters = { signed: 0, destinations: [] };
    await expect(dispatchToConfiguredOrigin(staging, counters, staging)).rejects.toThrow(
      "limited to plaintext loopback",
    );
    expect(counters.signed).toBe(0);
    expect(counters.destinations).toEqual([]);
  });
});

describe("public Agora Stoa origin binding", () => {
  const staging = "https://a-staging.asimposium.org";
  const production = "https://a.asimposium.org";
  const enrollmentId = "ASIMP-EN-ABCDEFGHJK";
  const enrollmentSecret = `v1.${"A".repeat(43)}`;
  const signingEnvironment = {
    SERVICE_ENVELOPE_PRIVATE_KEY_HEX: "11".repeat(32),
    SERVICE_ENVELOPE_KID: "origin-runtime-test",
  } as const;

  test.each([
    ["missing", undefined],
    ["malformed trailing slash", `${staging}/`],
  ] as const)("PLANTED: %s STOA_ORIGIN refuses before crypto import or fetch", async (_label, origin) => {
    const importKeySpy = spyOn(crypto.subtle, "importKey");
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("untrusted Stoa origin must not reach fetch"),
    );

    try {
      await withStoaEnvironment(
        { ...signingEnvironment, STOA_ORIGIN: origin },
        async () => {
          await expect(stoaConfigured()).resolves.toBe(false);
          await expect(
            stoaMintEnrollment(
              "usr_origin-runtime-test",
              { requested_scopes: ["review"] },
              "origin-runtime-refusal-1",
            ),
          ).resolves.toEqual({ ok: false, reason: "unconfigured" });
        },
      );

      expect(importKeySpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      importKeySpy.mockRestore();
    }
  });

  test("configured staging ignores hostile Host-style environment values and fetches only staging", async () => {
    const importKeySpy = spyOn(crypto.subtle, "importKey");
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));

    try {
      await withStoaEnvironment(
        {
          ...signingEnvironment,
          STOA_ORIGIN: staging,
          HOST: "a.asimposium.org",
          X_FORWARDED_HOST: "evil.invalid",
          X_FORWARDED_PROTO: "http",
        },
        async () => {
          await expect(stoaConfigured()).resolves.toBe(true);
          await expect(
            stoaMintEnrollment(
              "usr_origin-runtime-test",
              { requested_scopes: ["review"] },
              "origin-runtime-staging-1",
            ),
          ).resolves.toEqual({ ok: false, reason: "refused", status: 503 });
          expect(process.env.HOST).toBe("a.asimposium.org");
          expect(process.env.X_FORWARDED_HOST).toBe("evil.invalid");
          expect(process.env.X_FORWARDED_PROTO).toBe("http");
        },
      );

      expect(importKeySpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
        `${staging}/v1/enrollments`,
      ]);
    } finally {
      fetchSpy.mockRestore();
      importKeySpy.mockRestore();
    }
  });

  test("PLANTED: staging rejects a coherent production mint response before it becomes paste data", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          enrollment_id: enrollmentId,
          join_url: `${production}/join/${enrollmentId}#${enrollmentSecret}`,
          secret: enrollmentSecret,
          expires_at: 1_700_000_000_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      await withStoaEnvironment(
        { ...signingEnvironment, STOA_ORIGIN: staging },
        async () => {
          const result = await stoaMintEnrollment(
            "usr_origin-runtime-test",
            { requested_scopes: ["review"] },
            "origin-runtime-cross-environment-1",
          );
          expect(result).toEqual({ ok: false, reason: "unreachable" });
          expect("data" in result).toBe(false);
        },
      );

      expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
        `${staging}/v1/enrollments`,
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("operator dispatch is allowlisted twice and signs the distinct operator envelope", async () => {
    const operatorId = "usr_operator_fixture";
    const sponsorId = "usr_target_fixture";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged: true,
          audit_event_id: `OFC-${"A".repeat(26)}`,
          sponsor_id: sponsorId,
          sponsor_seq: 1,
          previous_active_fellow_limit: 5,
          active_fellow_limit: 6,
          step_up_authenticated_at: 1_786_000_000,
          signer_kid: "origin-runtime-test",
          effective_at: 1_786_000_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      expect(operatorPrincipalIsAllowed(operatorId, operatorId)).toBe(true);
      expect(operatorPrincipalIsAllowed(operatorId, `${operatorId},${operatorId}`)).toBe(false);
      await withStoaEnvironment(
        {
          ...signingEnvironment,
          STOA_ORIGIN: staging,
          OPERATOR_PRINCIPAL_IDS: operatorId,
        },
        async () => {
          await expect(
            stoaOperatorOverrideFellowCap(
              operatorId,
              {
                sponsor_id: sponsorId,
                expected_active_fellow_limit: 5,
                expected_sponsor_seq: 0,
                active_fellow_limit: 6,
                reason: "Capacity was reviewed for the active Fellows.",
                confirm: "override-fellow-cap",
                step_up_authenticated_at: 1_786_000_000,
              },
              "console-operator-runtime-1",
            ),
          ).resolves.toMatchObject({ ok: true, data: { sponsor_seq: 1 } });
        },
      );

      const firstCall = fetchSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(String(firstCall?.[0])).toBe(`${staging}/v1/operators/fellow-cap`);
      const headers = new Headers((firstCall?.[1] as RequestInit | undefined)?.headers);
      const signed = JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}") as {
        readonly claims?: ServiceEnvelopeClaims;
      };
      expect(signed.claims).toMatchObject({
        method: "POST",
        route: "/v1/operators/fellow-cap",
        action: "operator.fellow-cap.override",
        principal_id: operatorId,
        principal_type: "operator",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("hex helpers", () => {
  test("toHex is lowercase and zero-padded", () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  });
});

describe("canonical sponsor ids", () => {
  test("a Google subject deterministically derives one bounded opaque sponsor id", async () => {
    const { isCanonicalSponsorId, sponsorIdFromGoogleSubject } = await import(
      "../../lib/sponsor-id.ts"
    );
    const first = await sponsorIdFromGoogleSubject("105234567890123456789");
    const retry = await sponsorIdFromGoogleSubject("105234567890123456789");
    const second = await sponsorIdFromGoogleSubject("205234567890123456789");
    expect(first).toBe(retry);
    expect(first).not.toBe(second);
    expect(isCanonicalSponsorId(first)).toBe(true);
    expect(isCanonicalSponsorId(await sponsorIdFromGoogleSubject("Z".repeat(255)))).toBe(true);
    expect(await sponsorIdFromGoogleSubject("Z".repeat(256))).toBeUndefined();
    expect(await sponsorIdFromGoogleSubject("subject\u0000suffix")).toBeUndefined();
    expect(await sponsorIdFromGoogleSubject(undefined)).toBeUndefined();
    // Raw provider subjects, emails, and empty suffixes never reach an
    // envelope's principal_id.
    expect(isCanonicalSponsorId("105234567890123456789")).toBe(false);
    expect(isCanonicalSponsorId("usr_")).toBe(false);
    expect(isCanonicalSponsorId("sponsor@example.com")).toBe(false);
    expect(isCanonicalSponsorId(undefined)).toBe(false);
  });
});
