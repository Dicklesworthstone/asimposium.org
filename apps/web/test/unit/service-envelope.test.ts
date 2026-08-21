import { describe, expect, mock, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SponsorWorkshopViewSchema } from "@asimposium/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
import {
  boundedWorkshopPreviewPlan,
  dispatchSignedSponsorRequest,
  loadBoundedWorkshopPreviewPrefix,
  MAX_SPONSOR_WORKSHOP_PREVIEW_REQUESTS,
  newestWorkshopPreview,
  newestWorkshopPreviewIfValid,
  SPONSOR_WORKSHOP_PREVIEW_RENDER_TIMEOUT_MS,
  WORKSHOP_PREVIEW_ORDER_ERROR,
} from "../../lib/stoa-sponsor.ts";

// The production-only marker correctly rejects a direct Bun import. Replacing
// only that marker lets this unit file exercise the unchanged public server
// API; no production test seam or client import is introduced.
mock.module("server-only", () => ({}));
const {
  MAX_STOA_FELLOW_LIST_RESPONSE_BYTES,
  MAX_STOA_OPERATOR_AUDIT_RESPONSE_BYTES,
  MAX_STOA_PROPOSAL_LIST_RESPONSE_BYTES,
  MAX_STOA_REFUSAL_RESPONSE_BYTES,
  MAX_STOA_SPONSOR_WORKSHOP_PREVIEW_ACCEPTED_BYTES,
  MAX_STOA_SPONSOR_WORKSHOP_RESPONSE_BYTES,
  MAX_STOA_SUCCESS_RESPONSE_BYTES,
  operatorPrincipalIsAllowed,
  readBoundedStoaJson,
  sponsorWorkshopRefusalNotice,
  STOA_RESPONSE_READ_TIMEOUT_MS,
  stoaConfigured,
  stoaFellows,
  stoaMintEnrollment,
  stoaOperatorFellowCapAudit,
  stoaOperatorOverrideFellowCap,
  stoaPendingProposals,
  stoaSponsorWorkshop,
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

function corpusVector(name: string): Corpus["vectors"][string] {
  const vector = corpus.vectors[name];
  if (vector === undefined) throw new Error(`Missing service-envelope corpus vector: ${name}`);
  return vector;
}

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

test("the sponsor workshop preview preserves newest-first rows", () => {
  const descendingWorkshopSeqs = [6, 5, 4, 3, 2, 1].map((workshop_seq) => ({ workshop_seq }));
  const preview = newestWorkshopPreview(descendingWorkshopSeqs);

  expect(preview.map((object) => object.workshop_seq)).toEqual([6, 5, 4, 3, 2]);
  expect(preview.map((object) => object.workshop_seq)).not.toContain(1);
});

test("a malformed workshop preview can degrade without crashing the sponsor console", () => {
  const descending = [3, 2, 1].map((workshop_seq) => ({ workshop_seq }));
  const ascending = [1, 2, 3].map((workshop_seq) => ({ workshop_seq }));

  expect(newestWorkshopPreviewIfValid(descending)).toEqual(descending);
  expect(newestWorkshopPreviewIfValid(ascending)).toBeUndefined();
});

test("PLANTED: a 500-Fellow console page loads only the bounded workshop prefix", async () => {
  const candidates = Array.from({ length: 500 }, (_value, index) => ({
    fellow_id: `fellow-${index}`,
  }));
  const plan = boundedWorkshopPreviewPlan(candidates);
  const deadlines: number[] = [];
  let dispatches = 0;
  const loaded = await loadBoundedWorkshopPreviewPrefix(
    candidates,
    async (candidate, deadlineAtMs) => {
      dispatches += 1;
      deadlines.push(deadlineAtMs);
      return candidate.fellow_id;
    },
    () => 10_000,
  );

  expect([...plan.selected]).toEqual(candidates.slice(0, MAX_SPONSOR_WORKSHOP_PREVIEW_REQUESTS));
  expect(plan.omittedCount).toBe(500 - MAX_SPONSOR_WORKSHOP_PREVIEW_REQUESTS);
  expect(loaded.loaded.map((entry) => entry.candidate)).toEqual([...plan.selected]);
  expect(loaded.omittedCount).toBe(plan.omittedCount);
  expect(dispatches).toBe(2);
  expect(deadlines).toEqual(
    Array.from(
      { length: MAX_SPONSOR_WORKSHOP_PREVIEW_REQUESTS },
      () => 10_000 + SPONSOR_WORKSHOP_PREVIEW_RENDER_TIMEOUT_MS,
    ),
  );
  expect(MAX_SPONSOR_WORKSHOP_PREVIEW_REQUESTS).toBe(2);
  expect(MAX_STOA_SPONSOR_WORKSHOP_RESPONSE_BYTES).toBe(16_777_216);
  expect(MAX_STOA_SPONSOR_WORKSHOP_PREVIEW_ACCEPTED_BYTES).toBe(33_554_432);
});

test("PLANTED: the shared render deadline omits an unstarted second preview", async () => {
  const candidates = [{ id: "first" }, { id: "second" }, { id: "third" }];
  const ticks = [1_000, 1_000, 1_000 + SPONSOR_WORKSHOP_PREVIEW_RENDER_TIMEOUT_MS];
  let tick = 0;
  const loaded = await loadBoundedWorkshopPreviewPrefix(
    candidates,
    async (candidate) => candidate.id,
    () => ticks[Math.min(tick++, ticks.length - 1)] ?? Number.POSITIVE_INFINITY,
  );

  expect(loaded.loaded).toEqual([{ candidate: { id: "first" }, value: "first" }]);
  expect(loaded.omittedCount).toBe(2);
});

// e7j.3 consumer closure. A bare `slice` cannot tell newest-first from
// oldest-first, so an upstream `ORDER BY workshop_seq DESC` regression would
// render the OLDEST five under a "newest" label with every existing assertion
// still green. Each refusal below varies exactly ONE axis away from the valid
// descending page, so no case can pass for an unrelated reason.
test("PLANTED: an ascending page is refused, so an ORDER BY regression cannot green", () => {
  const ascending = [1, 2, 3, 4, 5, 6].map((workshop_seq) => ({ workshop_seq }));

  expect(() => newestWorkshopPreview(ascending)).toThrow(WORKSHOP_PREVIEW_ORDER_ERROR);
});

test("PLANTED: a duplicated workshop_seq is refused rather than previewed as a tie", () => {
  const duplicated = [6, 6, 5, 4, 3, 2].map((workshop_seq) => ({ workshop_seq }));

  expect(() => newestWorkshopPreview(duplicated)).toThrow(WORKSHOP_PREVIEW_ORDER_ERROR);
});

test("PLANTED: a non-safe-positive workshop_seq is refused before any row is taken", () => {
  // Every page below is STRICTLY DESCENDING on its own, so deleting the
  // safe-positive clause would let it through instead of tripping the descent
  // clause. That is what makes each row an isolating proof of THIS clause
  // rather than an incidental second witness for the other one. `NaN` and
  // `Infinity` sit where their comparisons cannot raise a descent refusal:
  // `NaN >= previous` is always false, and a leading `Infinity` has no
  // predecessor to be compared against.
  const cases: readonly { readonly label: string; readonly page: readonly number[] }[] = [
    { label: "0", page: [4, 3, 2, 1, 0] },
    { label: "-1", page: [4, 3, 2, 1, -1] },
    { label: "1.5", page: [4, 3, 2, 1.5, 1] },
    { label: "NaN", page: [4, 3, 2, 1, Number.NaN] },
    { label: "Infinity", page: [Number.POSITIVE_INFINITY, 4, 3, 2, 1] },
    {
      label: "finite unsafe integer",
      page: [Number.MAX_SAFE_INTEGER + 1, 4, 3, 2, 1],
    },
  ];

  for (const { label, page } of cases) {
    const rows = page.map((workshop_seq) => ({ workshop_seq }));

    expect(() => newestWorkshopPreview(rows), label).toThrow(WORKSHOP_PREVIEW_ORDER_ERROR);
  }
});

test("PLANTED: the preview refusal never reflects the rejected ordering back", () => {
  const leaking = [4321, 9999].map((workshop_seq) => ({ workshop_seq }));
  let message = "";
  try {
    newestWorkshopPreview(leaking);
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  }

  expect(message).toBe(WORKSHOP_PREVIEW_ORDER_ERROR);
  expect(message).not.toContain("4321");
  expect(message).not.toContain("9999");
});

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

async function mintSponsorProbeEnvelope(privateKey: CryptoKey, kid: string) {
  return mintServiceEnvelope({
    privateKey,
    kid,
    now: NOW,
    method: "POST",
    route: "/v1/sponsor-probe",
    action: "sponsor.probe",
    principalId: "usr_1",
    body: BODY,
  });
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
    const vector = corpusVector(name);
    expect(await sha256Hex(canonicalBytes(vector.claims))).toBe(vector.canonical_sha256);
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
    const vector = corpusVector("minimal");
    const reversed = Object.fromEntries(
      Object.entries(vector.claims).reverse(),
    ) as unknown as ServiceEnvelopeClaims;
    expect(await sha256Hex(canonicalBytes(reversed))).toBe(vector.canonical_sha256);
  });

  test("a non-integer timestamp is refused rather than silently rendered", () => {
    const vector = corpusVector("minimal");
    expect(() => canonicalBytes({ ...vector.claims, iat: 1.5 })).toThrow(/safe integer/);
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

  test.each([production, staging])(
    "dispatches only to configured trusted HTTPS %s",
    async (origin) => {
      const counters: DispatchCounters = { signed: 0, destinations: [] };
      await expect(dispatchToConfiguredOrigin(origin, counters)).resolves.toMatchObject({
        status: 204,
      });
      expect(counters.signed).toBe(1);
      expect(counters.destinations).toEqual([`${origin}/v1/sponsor-probe`]);
    },
  );

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

  test("PLANTED: a transport response arriving after the deadline has its body cancelled", async () => {
    const keypair = await makeKeypair();
    const envelope = await mintSponsorProbeEnvelope(keypair.privateKey, "late-response-test");
    let resolveFetch: ((response: Response) => void) | undefined;
    let transportSignal: AbortSignal | null | undefined;
    const operation = dispatchSignedSponsorRequest({
      stoaOrigin: staging,
      path: "/v1/sponsor-probe",
      method: "POST",
      route: "/v1/sponsor-probe",
      action: "sponsor.probe",
      sponsorId: "usr_1",
      rawBody: BODY,
      privateKey: keypair.privateKey,
      kid: "late-response-test",
      now: NOW,
      timeoutMs: 5,
      mintEnvelopeImpl: async () => envelope,
      fetchImpl: (_input, init) => {
        transportSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });

    await expect(operation).rejects.toMatchObject({ name: "TimeoutError" });
    expect(transportSignal?.aborted).toBe(true);

    let cancelled = false;
    const lateBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    if (resolveFetch === undefined) throw new Error("late response transport was not entered");
    resolveFetch(new Response(lateBody));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  // ggv.3: the canonical-principal guard is the only thing standing between an
  // upstream caller bug and a Google subject or an email being SIGNED into a
  // request header. Fable §14.3 treats a header exactly as it treats a log
  // line, so the refusal has to land before the signer and before the
  // transport — not merely before Stoa answers. Both impls below throw if
  // reached, which is what makes "before" a proof rather than an ordering
  // claim, and the guard carries no coverage at all without it.
  test("PLANTED: a non-canonical sponsor principal is refused before signer and transport", async () => {
    const keypair = await makeKeypair();
    const unreachable = (stage: string) => () => {
      throw new Error(`PLANTED_NON_CANONICAL_PRINCIPAL_REACHED_${stage}`);
    };

    for (const [label, sponsorId] of [
      ["an email", "sponsor@example.org"],
      ["a Google subject", "104283719283746152938"],
      ["empty", ""],
      ["one over the canonical length", `usr_${"a".repeat(61)}`],
      ["a wrong prefix", `user_${"a".repeat(8)}`],
    ] as const) {
      const rejected = dispatchSignedSponsorRequest({
        stoaOrigin: staging,
        path: "/v1/sponsor-probe",
        method: "POST",
        route: "/v1/sponsor-probe",
        action: "sponsor.probe",
        sponsorId,
        rawBody: BODY,
        privateKey: keypair.privateKey,
        kid: "non-canonical-principal-test",
        now: NOW,
        mintEnvelopeImpl: unreachable("MINT"),
        fetchImpl: unreachable("FETCH"),
      });

      // One await, then assert on the captured error: re-awaiting the same
      // rejection to check a second field is avoidable indirection.
      // The refusal must not echo the rejected principal — reflecting it moves
      // the same bytes into a message, a stack, and whatever collects them,
      // which is the leak this guard exists to prevent.
      await expect(rejected, label).rejects.toMatchObject({
        name: "TypeError",
        message: "Stoa sponsor id must be a canonical opaque Worker principal",
      });
    }
  });

  test("PLANTED: the canonical length boundary admits the longest lawful principal", async () => {
    // One past this is refused above. Without this positive the guard could be
    // narrowed to reject every principal and the negatives would all still
    // pass, so the two tests are only load-bearing together.
    const keypair = await makeKeypair();
    const longest = `usr_${"a".repeat(60)}`;
    let signedPrincipal: string | undefined;
    const envelope = await mintSponsorProbeEnvelope(keypair.privateKey, "canonical-boundary-test");
    const response = await dispatchSignedSponsorRequest({
      stoaOrigin: staging,
      path: "/v1/sponsor-probe",
      method: "POST",
      route: "/v1/sponsor-probe",
      action: "sponsor.probe",
      sponsorId: longest,
      rawBody: BODY,
      privateKey: keypair.privateKey,
      kid: "canonical-boundary-test",
      now: NOW,
      mintEnvelopeImpl: async (options) => {
        signedPrincipal = options.principalId;
        return envelope;
      },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    expect(response.status).toBe(200);
    expect(signedPrincipal).toBe(longest);
  });

  test("PLANTED: a transport rejection after the deadline remains observed", async () => {
    const keypair = await makeKeypair();
    const envelope = await mintSponsorProbeEnvelope(keypair.privateKey, "late-rejection-test");
    let rejectFetch: ((reason?: unknown) => void) | undefined;
    const operation = dispatchSignedSponsorRequest({
      stoaOrigin: staging,
      path: "/v1/sponsor-probe",
      method: "POST",
      route: "/v1/sponsor-probe",
      action: "sponsor.probe",
      sponsorId: "usr_1",
      rawBody: BODY,
      privateKey: keypair.privateKey,
      kid: "late-rejection-test",
      now: NOW,
      timeoutMs: 5,
      mintEnvelopeImpl: async () => envelope,
      fetchImpl: () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    });

    await expect(operation).rejects.toMatchObject({ name: "TimeoutError" });
    if (rejectFetch === undefined) throw new Error("late rejection transport was not entered");
    const planted = new Error("PLANTED_LATE_TRANSPORT_REJECTION");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      if (reason === planted) unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      rejectFetch(planted);
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

  test("PLANTED: an expired aggregate workshop deadline refuses before signing or fetch", async () => {
    const importKeySpy = spyOn(crypto.subtle, "importKey");
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("an expired workshop render must not dispatch"),
    );
    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        await expect(
          stoaSponsorWorkshop(
            "usr_origin-runtime-test",
            "P-4DSP",
            "fellow-01JXYZ",
            performance.now() - 1,
          ),
        ).resolves.toEqual({ ok: false, reason: "unreachable" });
      });
      expect(importKeySpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      importKeySpy.mockRestore();
    }
  });

  test.each([
    ["missing", undefined],
    ["malformed trailing slash", `${staging}/`],
  ] as const)(
    "PLANTED: %s STOA_ORIGIN refuses before crypto import or fetch",
    async (_label, origin) => {
      const importKeySpy = spyOn(crypto.subtle, "importKey");
      const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("untrusted Stoa origin must not reach fetch"),
      );

      try {
        await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: origin }, async () => {
          await expect(stoaConfigured()).resolves.toBe(false);
          await expect(
            stoaMintEnrollment(
              "usr_origin-runtime-test",
              { requested_scopes: ["review"] },
              "origin-runtime-refusal-1",
            ),
          ).resolves.toEqual({ ok: false, reason: "unconfigured" });
        });

        expect(importKeySpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        importKeySpy.mockRestore();
      }
    },
  );

  test("configured staging ignores hostile Host-style environment values and fetches only staging", async () => {
    const importKeySpy = spyOn(crypto.subtle, "importKey");
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );

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
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaMintEnrollment(
          "usr_origin-runtime-test",
          { requested_scopes: ["review"] },
          "origin-runtime-cross-environment-1",
        );
        expect(result).toEqual({ ok: false, reason: "unreachable" });
        expect("data" in result).toBe(false);
      });

      expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
        `${staging}/v1/enrollments`,
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: a streamed oversized 2xx body is refused before JSON parsing", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_STOA_SUCCESS_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array([0x7b]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(response.headers.get("content-length")).toBeNull();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        await expect(
          stoaMintEnrollment(
            "usr_origin-runtime-test",
            { requested_scopes: ["review"] },
            "origin-runtime-oversize-1",
          ),
        ).resolves.toEqual({ ok: false, reason: "unreachable" });
      });
      await Promise.resolve();
      expect(cancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: malformed UTF-8 in a bounded 2xx body is refused", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        await expect(
          stoaMintEnrollment(
            "usr_origin-runtime-test",
            { requested_scopes: ["review"] },
            "origin-runtime-invalid-utf8-1",
          ),
        ).resolves.toEqual({ ok: false, reason: "unreachable" });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: a nonterminating response body is refused by the body-read deadline", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readBoundedStoaJson(response, 64, 5)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("the response reader refuses unbounded byte and time configurations", async () => {
    for (const maximum of [0, -1, 1.5, MAX_STOA_FELLOW_LIST_RESPONSE_BYTES + 1]) {
      await expect(readBoundedStoaJson(new Response("{}"), maximum)).rejects.toThrow(
        "outside the supported bounded range",
      );
    }
    for (const timeout of [0, -1, 1.5, STOA_RESPONSE_READ_TIMEOUT_MS + 1]) {
      await expect(readBoundedStoaJson(new Response("{}"), 64, timeout)).rejects.toThrow(
        "outside the supported bounded range",
      );
    }
  });

  test("PLANTED: endless empty chunks cannot starve the absolute body-read deadline", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array());
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readBoundedStoaJson(response, 64, 5)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("PLANTED: the bounded reader admits a contract-valid Fellow page above the small cap", async () => {
    const controlText = "\u0001".repeat(1_000);
    const fellow = {
      fellow_id: "fellow-large-response",
      name: "large-response-fellow",
      model: "model",
      harness: "harness",
      status: "active",
      granted_scopes: ["review"],
      granted_resources: { first_directive: controlText },
      granted_at: 1,
      credentials: [],
    };
    const responseText = JSON.stringify({ fellows: Array(500).fill(fellow), next_cursor: null });
    const responseBytes = new TextEncoder().encode(responseText).byteLength;
    expect(responseBytes).toBeGreaterThan(MAX_STOA_SUCCESS_RESPONSE_BYTES);
    expect(responseBytes).toBeLessThan(MAX_STOA_FELLOW_LIST_RESPONSE_BYTES);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseText, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaFellows("usr_origin-runtime-test");
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data.fellows).toHaveLength(500);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: the proposal client admits its contract-bounded maximum page above the small cap", async () => {
    const controlText = "\u0001";
    const resources = {
      problem_binding: `P-${"A".repeat(26)}`,
      first_directive: controlText.repeat(2_000),
      event_budget: 10_000,
      artifact_budget_bytes: 1_073_741_824,
      fellow_grant_expires_at: Number.MAX_SAFE_INTEGER,
    };
    const proposal = {
      enrollment_id: `ASIMP-EN-${"A".repeat(32)}`,
      proposal_id: "p".repeat(80),
      status: "approved",
      name: "large-proposal-response",
      model: controlText.repeat(160),
      harness: controlText.repeat(160),
      reasoning_effort: controlText.repeat(80),
      tools_note: controlText.repeat(1_000),
      requested_scopes: ["promote", "review", "propose-problems", "upload-artifacts"],
      requested_resources: resources,
      effective_granted_scopes: ["promote", "review", "propose-problems", "upload-artifacts"],
      effective_granted_resources: resources,
      proposal_expires_at: Number.MAX_SAFE_INTEGER,
    };
    const responseText = JSON.stringify({ proposals: Array(100).fill(proposal) });
    const responseBytes = new TextEncoder().encode(responseText).byteLength;
    expect(responseBytes).toBeGreaterThan(MAX_STOA_SUCCESS_RESPONSE_BYTES);
    expect(responseBytes).toBeLessThan(MAX_STOA_PROPOSAL_LIST_RESPONSE_BYTES);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseText, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaPendingProposals("usr_origin-runtime-test");
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data.proposals).toHaveLength(100);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: the sponsor workshop client refuses a malformed private-data response", async () => {
    const valid = {
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      problem_id: "P-4DSP",
      fellow_id: "fellow-01JXYZ",
      objects: [
        {
          workshop_id: `W-${"A".repeat(26)}`,
          type: "note",
          title: "Private note",
          body_md: "Private bytes",
          relates_to: [],
          workshop_seq: 1,
          created_at: "2026-08-19T00:00:00.000Z",
        },
      ],
    };

    for (const [label, body, expected, schemaValid] of [
      ["exact response identity", valid, true, true],
      ["unexpected public field", { ...valid, unexpected_public_field: true }, false, false],
      ["different problem", { ...valid, problem_id: "P-OTHER" }, false, true],
      ["different fellow", { ...valid, fellow_id: "fellow-other" }, false, true],
    ] as const) {
      expect(SponsorWorkshopViewSchema.safeParse(body).success, label).toBe(schemaValid);
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      try {
        await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
          const result = await stoaSponsorWorkshop(
            "usr_origin-runtime-test",
            "P-4DSP",
            "fellow-01JXYZ",
          );
          expect(result.ok, label).toBe(expected);
          if (!expected) expect(result, label).toEqual({ ok: false, reason: "unreachable" });
          if (expected) {
            const call = fetchSpy.mock.calls[0];
            expect(String(call?.[0])).toBe(`${staging}/v1/sponsors/workshop`);
            expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
            expect((call?.[1] as RequestInit | undefined)?.body).toBe(
              JSON.stringify({ problem_id: "P-4DSP", fellow_id: "fellow-01JXYZ" }),
            );
          }
        });
      } finally {
        fetchSpy.mockRestore();
      }
    }
  });

  test("PLANTED: sponsor workshop accepts its exact declared cap and rejects plus one without a large body", async () => {
    const responseText = JSON.stringify({
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      problem_id: "P-4DSP",
      fellow_id: "fellow-01JXYZ",
      objects: [],
    });
    const exactBytes = new TextEncoder().encode(responseText);
    expect(exactBytes.byteLength).toBeLessThan(1_024);

    const exactCapResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(exactBytes);
          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          "content-length": String(MAX_STOA_SPONSOR_WORKSHOP_RESPONSE_BYTES),
          "content-type": "application/json",
        },
      },
    );
    let plusOneRead = false;
    let plusOneCancelled = false;
    const plusOneResponse = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            plusOneRead = true;
            controller.enqueue(new TextEncoder().encode(responseText));
            controller.close();
          },
          cancel() {
            plusOneCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status: 200,
        headers: {
          "content-length": String(MAX_STOA_SPONSOR_WORKSHOP_RESPONSE_BYTES + 1),
          "content-type": "application/json",
        },
      },
    );
    expect(exactCapResponse.headers.get("content-length")).toBe("16777216");
    expect(plusOneResponse.headers.get("content-length")).toBe("16777217");
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(exactCapResponse)
      .mockResolvedValueOnce(plusOneResponse);

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        await expect(
          stoaSponsorWorkshop("usr_origin-runtime-test", "P-4DSP", "fellow-01JXYZ"),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          stoaSponsorWorkshop("usr_origin-runtime-test", "P-4DSP", "fellow-01JXYZ"),
        ).resolves.toEqual({ ok: false, reason: "unreachable" });
      });
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(plusOneRead).toBe(false);
      expect(plusOneCancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: registered workshop refusals retain bounded metadata and unknown codes do not", async () => {
    for (const [problem, expected] of [
      [
        {
          type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
          title: "Workshop read body is invalid",
          status: 422,
          code: "WORKSHOP_READ_BODY_INVALID",
          detail: "The signed JSON body must contain exactly problem_id and fellow_id.",
          fix_hint: "Send the problem and one of your own Fellows in the signed JSON body.",
          rule: "A5",
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { problem_id: "P-4DSP", fellow_id: "fellow-01JXYZ" },
        },
        {
          ok: false,
          reason: "refused",
          status: 422,
          detail: "Workshop read body is invalid",
          problemCode: "WORKSHOP_READ_BODY_INVALID",
        },
      ],
      [
        {
          type: "https://asimposium.org/errors/WORKSHOP_NOT_FOUND",
          title: "No such workshop",
          status: 404,
          code: "WORKSHOP_NOT_FOUND",
          detail: "No workshop visible to this sponsor matches the query.",
          fix_hint: "Check the fellow id against your console's Fellows list.",
        },
        {
          ok: false,
          reason: "refused",
          status: 404,
          detail: "No such workshop",
          problemCode: "WORKSHOP_NOT_FOUND",
        },
      ],
      [
        {
          type: "https://asimposium.org/errors/WORKSHOP_UNKNOWN",
          title: "Private workshop bytes must not survive",
          status: 404,
          code: "WORKSHOP_UNKNOWN",
          detail: "body_md=private-canary",
          fix_hint: "Do not retain this unregistered refusal.",
        },
        { ok: false, reason: "refused", status: 404 },
      ],
    ] as const) {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(problem), {
          status: problem.status,
          headers: { "content-type": "application/problem+json" },
        }),
      );
      try {
        await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
          await expect(
            stoaSponsorWorkshop("usr_origin-runtime-test", "P-4DSP", "fellow-01JXYZ"),
          ).resolves.toEqual(expected);
        });
      } finally {
        fetchSpy.mockRestore();
      }
    }
  });

  test("PLANTED: a contract-class workshop refusal notice retains only its registered code and title", async () => {
    const privateDetailCanary = "private-contract-refusal-detail-canary";
    const privateFixHintCanary = "private-contract-refusal-fix-hint-canary";
    const privateExampleCanary = "private-contract-refusal-example-canary";
    const title = "Workshop read body is invalid";
    const problem = {
      type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
      title,
      status: 422,
      code: "WORKSHOP_READ_BODY_INVALID",
      detail: privateDetailCanary,
      fix_hint: privateFixHintCanary,
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { body_md: privateExampleCanary },
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(problem), {
        status: 422,
        headers: { "content-type": "application/problem+json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const notice = sponsorWorkshopRefusalNotice(
          await stoaSponsorWorkshop("usr_origin-runtime-test", "P-4DSP", "fellow-01JXYZ"),
        );
        expect(notice).toEqual({ problemCode: "WORKSHOP_READ_BODY_INVALID", title });
        expect(Object.keys(notice ?? {}).sort()).toEqual(["problemCode", "title"]);
        const surfaced = JSON.stringify(notice);
        expect(surfaced).not.toContain(privateDetailCanary);
        expect(surfaced).not.toContain(privateFixHintCanary);
        expect(surfaced).not.toContain(privateExampleCanary);
        expect(surfaced).not.toContain("rule");
        expect(surfaced).not.toContain("schema");
        expect(surfaced).not.toContain("example");
        expect(surfaced).not.toContain("fix_hint");
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: an opaque workshop refusal notice retains only its registered code and title", async () => {
    const privateDetailCanary = "private-opaque-refusal-detail-canary";
    const title = "No such workshop";
    const problem = {
      type: "https://asimposium.org/errors/WORKSHOP_NOT_FOUND",
      title,
      status: 404,
      code: "WORKSHOP_NOT_FOUND",
      detail: privateDetailCanary,
      fix_hint: "The generic opaque refusal contract requires a nonempty field.",
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(problem), {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const notice = sponsorWorkshopRefusalNotice(
          await stoaSponsorWorkshop("usr_origin-runtime-test", "P-4DSP", "fellow-01JXYZ"),
        );
        expect(notice).toEqual({ problemCode: "WORKSHOP_NOT_FOUND", title });
        expect(JSON.stringify(notice)).not.toContain(privateDetailCanary);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: a forged unregistered code cannot become a workshop refusal notice", () => {
    const forged = {
      ok: false,
      reason: "refused",
      detail: "An unregistered Worker code must remain coarse.",
      problemCode: "WORKSHOP_UNKNOWN",
      rawCode: "WORKSHOP_READ_BODY_INVALID",
    } as unknown as Parameters<typeof sponsorWorkshopRefusalNotice>[0];

    expect(sponsorWorkshopRefusalNotice(forged)).toBeUndefined();
  });

  test("PLANTED: a workshop refusal notice defensively caps a title at 200 characters", () => {
    const titleTailCanary = "title-tail-must-not-render";
    const notice = sponsorWorkshopRefusalNotice({
      ok: false,
      reason: "refused",
      detail: `${"T".repeat(200)}${titleTailCanary}`,
      problemCode: "WORKSHOP_READ_BODY_INVALID",
    });

    expect(notice).toEqual({
      problemCode: "WORKSHOP_READ_BODY_INVALID",
      title: "T".repeat(200),
    });
    expect(notice?.title).toHaveLength(200);
    expect(JSON.stringify(notice)).not.toContain(titleTailCanary);
  });

  test("PLANTED: workshop refusal notice projection never copies teaching fields", () => {
    const fixHintCanary = "private-notice-fix-hint-canary";
    const schemaCanary = "private-notice-schema-canary";
    const exampleCanary = "private-notice-example-canary";
    const notice = sponsorWorkshopRefusalNotice({
      ok: false,
      reason: "refused",
      detail: "Workshop request refused",
      problemCode: "WORKSHOP_READ_BODY_INVALID",
      fix_hint: fixHintCanary,
      rule: "A5",
      schema: schemaCanary,
      example: { body_md: exampleCanary },
    } as unknown as Parameters<typeof sponsorWorkshopRefusalNotice>[0]);

    expect(notice).toEqual({
      problemCode: "WORKSHOP_READ_BODY_INVALID",
      title: "Workshop request refused",
    });
    const surfaced = JSON.stringify(notice);
    expect(surfaced).not.toContain(fixHintCanary);
    expect(surfaced).not.toContain(schemaCanary);
    expect(surfaced).not.toContain(exampleCanary);
    expect(surfaced).not.toContain("fix_hint");
    expect(surfaced).not.toContain("rule");
    expect(surfaced).not.toContain("schema");
    expect(surfaced).not.toContain("example");
  });

  test("PLANTED: a known workshop Problem whose status disagrees with HTTP stays opaque", async () => {
    const privateCanary = "private-workshop-status-mismatch-canary";
    const problem = {
      type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
      title: `Workshop input rejected: ${privateCanary}`,
      status: 404,
      code: "WORKSHOP_READ_BODY_INVALID",
      detail: `body_md=${privateCanary}`,
      fix_hint: "Send the problem and one of your own Fellows in the signed JSON body.",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { problem_id: "P-4DSP", fellow_id: "fellow-01JXYZ" },
    };
    const responseBody = JSON.stringify(problem);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseBody, {
        status: 422,
        headers: { "content-type": "application/problem+json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaSponsorWorkshop(
          "usr_origin-runtime-test",
          "P-4DSP",
          "fellow-01JXYZ",
        );
        // Removing the production status-equality guard would retain this
        // known code and title, exposing the planted private canary.
        expect(result).toEqual({ ok: false, reason: "refused", status: 422 });
        const retained = JSON.stringify(result);
        expect(retained).not.toContain(privateCanary);
        expect(retained).not.toContain("body_md");
        expect(retained).not.toContain(responseBody);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: an oversized workshop 4xx body is discarded before known metadata can reflect", async () => {
    const privateCanary = "private-workshop-oversized-refusal-canary";
    let cancelled = false;
    let readAttempted = false;
    const responseBody = JSON.stringify({
      type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
      title: `Workshop input rejected: ${privateCanary}`,
      status: 422,
      code: "WORKSHOP_READ_BODY_INVALID",
      detail: "The signed JSON body must contain exactly problem_id and fellow_id.",
      fix_hint: "Send the problem and one of your own Fellows in the signed JSON body.",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { body_md: privateCanary.repeat(2_048) },
    });
    expect(new TextEncoder().encode(responseBody).byteLength).toBeGreaterThan(
      MAX_STOA_REFUSAL_RESPONSE_BYTES,
    );
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          readAttempted = true;
          controller.enqueue(new TextEncoder().encode(responseBody));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 422,
        headers: {
          "content-length": String(MAX_STOA_REFUSAL_RESPONSE_BYTES + 1),
          "content-type": "application/problem+json",
        },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaSponsorWorkshop(
          "usr_origin-runtime-test",
          "P-4DSP",
          "fellow-01JXYZ",
        );
        // Removing the declared-size guard attempts to read this body; removing
        // the streamed-size guard then admits the known title/code. Both cases
        // make this plant red rather than silently retaining refusal bytes.
        expect(result).toEqual({ ok: false, reason: "refused", status: 422 });
        const retained = JSON.stringify(result);
        expect(retained).not.toContain(privateCanary);
        expect(retained).not.toContain("body_md");
        expect(retained).not.toContain(responseBody);
      });
      await Promise.resolve();
      expect(readAttempted).toBe(false);
      expect(cancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: a streamed workshop 4xx over 65,536 bytes cancels after the reader starts", async () => {
    const refusalLimit = 65_536;
    const privateCanary = "private-workshop-streamed-refusal-canary";
    const firstChunk = new Uint8Array(refusalLimit);
    const secondChunk = new TextEncoder().encode(`body_md=${privateCanary}`);
    expect(firstChunk.byteLength).toBe(65_536);
    expect(firstChunk.byteLength + secondChunk.byteLength).toBeGreaterThan(65_536);
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) {
            controller.enqueue(firstChunk);
          } else if (pullCount === 2) {
            controller.enqueue(secondChunk);
          } else {
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, {
      status: 422,
      headers: { "content-type": "application/problem+json" },
    });
    expect(response.headers.get("content-length")).toBeNull();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaSponsorWorkshop(
          "usr_origin-runtime-test",
          "P-4DSP",
          "fellow-01JXYZ",
        );
        // This must stream: a declared-size early return cannot make both the
        // reader-count and cancellation assertions pass.
        expect(result).toEqual({ ok: false, reason: "refused", status: 422 });
        const retained = JSON.stringify(result);
        expect(retained).not.toContain(privateCanary);
        expect(retained).not.toContain("body_md");
      });
      await Promise.resolve();
      expect(pullCount).toBeGreaterThanOrEqual(2);
      expect(cancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: fatal UTF-8 rejects a workshop 4xx before known metadata can reflect", async () => {
    const privateCanary = "private-workshop-invalid-utf8-canary";
    const responseText = JSON.stringify({
      type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
      title: `Workshop input rejected: ${privateCanary}`,
      status: 422,
      code: "WORKSHOP_READ_BODY_INVALID",
      detail: "The signed JSON body must contain exactly problem_id and fellow_id.",
      fix_hint: "Send the problem and one of your own Fellows in the signed JSON body.",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { body_md: "x" },
    });
    const invalidUtf8 = new Uint8Array(new TextEncoder().encode(responseText));
    const marker = '"x"';
    const markerOffset = responseText.lastIndexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    invalidUtf8[new TextEncoder().encode(responseText.slice(0, markerOffset + 1)).byteLength] =
      0xff;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(invalidUtf8, {
        status: 422,
        headers: { "content-type": "application/problem+json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaSponsorWorkshop(
          "usr_origin-runtime-test",
          "P-4DSP",
          "fellow-01JXYZ",
        );
        // A non-fatal decoder would replace the planted byte inside `example`,
        // then retain the known title/code and the private canary.
        expect(result).toEqual({ ok: false, reason: "refused", status: 422 });
        const retained = JSON.stringify(result);
        expect(retained).not.toContain(privateCanary);
        expect(retained).not.toContain("body_md");
        expect(retained).not.toContain(responseText);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: imported client retains a contract-valid 160-character workshop Problem title", async () => {
    const privateBodyCanary = "private-workshop-boundary-body-canary";
    const title = "T".repeat(160);
    expect(title).toHaveLength(160);
    const problem = {
      type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
      title,
      status: 422,
      code: "WORKSHOP_READ_BODY_INVALID",
      detail: "The signed JSON body must contain exactly problem_id and fellow_id.",
      fix_hint: "Send the problem and one of your own Fellows in the signed JSON body.",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { body_md: privateBodyCanary },
    };
    const responseBody = JSON.stringify(problem);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseBody, {
        status: 422,
        headers: { "content-type": "application/problem+json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaSponsorWorkshop(
          "usr_origin-runtime-test",
          "P-4DSP",
          "fellow-01JXYZ",
        );
        // The imported client accepts this contract-boundary title but projects
        // only its validated title/code, never the teaching payload.
        expect(result).toEqual({
          ok: false,
          reason: "refused",
          status: 422,
          detail: title,
          problemCode: "WORKSHOP_READ_BODY_INVALID",
        });
        const retained = JSON.stringify(result);
        expect(retained).not.toContain(privateBodyCanary);
        expect(retained).not.toContain("body_md");
        expect(retained).not.toContain(responseBody);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: a workshop Problem title one character above 160 fails closed", async () => {
    const titleTailCanary = "X";
    const privateBodyCanary = "private-workshop-overlong-title-body-canary";
    const title = `${"T".repeat(160)}${titleTailCanary}`;
    expect(title).toHaveLength(161);
    const problem = {
      type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
      title,
      status: 422,
      code: "WORKSHOP_READ_BODY_INVALID",
      detail: "The signed JSON body must contain exactly problem_id and fellow_id.",
      fix_hint: "Send the problem and one of your own Fellows in the signed JSON body.",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { body_md: privateBodyCanary },
    };
    const responseBody = JSON.stringify(problem);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseBody, {
        status: 422,
        headers: { "content-type": "application/problem+json" },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        const result = await stoaSponsorWorkshop(
          "usr_origin-runtime-test",
          "P-4DSP",
          "fellow-01JXYZ",
        );
        // The imported client schema must reject this response before either
        // the title-tail marker or teaching payload can be retained.
        expect(result).toEqual({ ok: false, reason: "refused", status: 422 });
        const retained = JSON.stringify(result);
        expect(retained).not.toContain(titleTailCanary);
        expect(retained).not.toContain(privateBodyCanary);
        expect(retained).not.toContain("body_md");
        expect(retained).not.toContain(responseBody);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: the audit client admits its contract-bounded maximum page above the small cap", async () => {
    const operatorId = "usr_operator_fixture";
    const sponsorId = "usr_target_fixture";
    const auditEvent = {
      audit_event_id: `OFC-${"A".repeat(26)}`,
      sponsor_id: sponsorId,
      operator_id: operatorId,
      sponsor_seq: Number.MAX_SAFE_INTEGER,
      previous_active_fellow_limit: 5,
      active_fellow_limit: 500,
      reason: `x${"\u0001".repeat(998)}x`,
      step_up_authenticated_at: Number.MAX_SAFE_INTEGER,
      signer_kid: "k".repeat(64),
      effective_at: Number.MAX_SAFE_INTEGER,
    };
    const responseText = JSON.stringify({
      audit_events: Array(100).fill(auditEvent),
      next_cursor: null,
    });
    const responseBytes = new TextEncoder().encode(responseText).byteLength;
    expect(responseBytes).toBeGreaterThan(MAX_STOA_SUCCESS_RESPONSE_BYTES);
    expect(responseBytes).toBeLessThan(MAX_STOA_OPERATOR_AUDIT_RESPONSE_BYTES);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseText, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      await withStoaEnvironment(
        {
          ...signingEnvironment,
          STOA_ORIGIN: staging,
          OPERATOR_PRINCIPAL_IDS: operatorId,
        },
        async () => {
          const result = await stoaOperatorFellowCapAudit(operatorId, sponsorId);
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.data.audit_events).toHaveLength(100);
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("PLANTED: a declared oversized problem body is discarded before retention", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 422,
        headers: {
          "content-length": String(MAX_STOA_REFUSAL_RESPONSE_BYTES + 1),
          "content-type": "application/problem+json",
        },
      }),
    );

    try {
      await withStoaEnvironment({ ...signingEnvironment, STOA_ORIGIN: staging }, async () => {
        await expect(
          stoaMintEnrollment(
            "usr_origin-runtime-test",
            { requested_scopes: ["review"] },
            "origin-runtime-refusal-overrun-1",
          ),
        ).resolves.toEqual({ ok: false, reason: "refused", status: 422 });
      });
      await Promise.resolve();
      expect(cancelled).toBe(true);
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

/**
 * The transport refuses a non-canonical principal BEFORE it signs (ggv.3).
 *
 * The predicate above proves the shape rule; these prove the transport applies
 * it at the only moment that matters. A caller bug that hands over a Google
 * subject or an email must not produce a signed envelope: once minted, those
 * bytes have already left in a request header, and Stoa refusing them later
 * does not un-send them. So each case asserts zero signer calls and zero fetch
 * calls, not merely that the promise rejected.
 */
const PRINCIPAL_TEST_ORIGIN = "https://a-staging.asimposium.org";

const NONCANONICAL_SPONSOR_IDS = [
  ["an email", "sponsor@example.com"],
  ["a Google-subject-like id", "105234567890123456789"],
  ["an empty principal", ""],
  ["a wrong prefix", "user_1TR8kQ"],
  ["an overlong principal", `usr_${"a".repeat(61)}`],
] as const;

async function dispatchWithSponsorId(
  sponsorId: string,
  counters: DispatchCounters,
): Promise<Response> {
  const keypair = await makeKeypair();
  return dispatchSignedSponsorRequest({
    stoaOrigin: PRINCIPAL_TEST_ORIGIN,
    path: "/v1/sponsor-probe",
    method: "POST",
    route: "/v1/sponsor-probe",
    action: "sponsor.probe",
    sponsorId,
    rawBody: BODY,
    privateKey: keypair.privateKey,
    kid: "principal-test",
    now: NOW,
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

describe("the sponsor principal is enforced before anything is signed", () => {
  test.each(NONCANONICAL_SPONSOR_IDS)(
    "%s is refused with no signature and no request",
    async (_label, sponsorId) => {
      const counters: DispatchCounters = { signed: 0, destinations: [] };
      let caught: unknown;
      try {
        await dispatchWithSponsorId(sponsorId, counters);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TypeError);
      // The refusal is what stops the leak, so prove nothing left: an assertion
      // that only checked the throw would pass against an implementation that
      // signed first and rejected afterwards.
      expect(counters.signed, "signer must not run").toBe(0);
      expect(counters.destinations, "no request may be dispatched").toEqual([]);

      // The rejected principal must not reappear in the message, a stack, or
      // anything that collects them. Skipped for the empty case, where every
      // string trivially contains "" and the assertion would be vacuous.
      if (sponsorId.length > 0) {
        const surfaced = `${String(caught)}${(caught as Error).stack ?? ""}`;
        expect(surfaced.includes(sponsorId), "refusal must not reflect the principal").toBe(false);
      }
    },
  );

  test("a canonical usr_ principal still signs and dispatches unchanged", async () => {
    const counters: DispatchCounters = { signed: 0, destinations: [] };
    const response = await dispatchWithSponsorId("usr_1TR8kQ", counters);

    expect(response.status).toBe(204);
    expect(counters.signed).toBe(1);
    expect(counters.destinations).toEqual([`${PRINCIPAL_TEST_ORIGIN}/v1/sponsor-probe`]);
  });
});

// asimposiumorg-mqib: the mounted console refusal list, proven by RENDER, not by
// reading page source. `sponsorWorkshopRefusalNotice` and the coarse
// `unavailableWorkshopPreviewCount` are unit-proven above, but nothing exercised
// the async `Console` server component that MOUNTS them: an edit that dropped the
// refusal <ul>, surfaced a private teaching field, or miscounted the unavailable
// previews would leave every unit assertion green. This block renders the real
// `Console` to static markup with the network isolated and asserts on the emitted
// HTML. `@/lib/stoa` and `@/lib/stoa-sponsor` stay REAL — they are the projection
// under test. Only `@/auth`, `@/lib/plane-status`, the two `use client` +
// useRouter children, and `next/link` are isolated, because renderToStaticMarkup
// has no AppRouterContext to give them.
describe("PLANTED: the mounted sponsor console renders only bounded workshop refusals", () => {
  const SPONSOR_ID = "usr_origin-runtime-test";
  const STAGING = "https://a-staging.asimposium.org";
  const consoleEnvironment = {
    STOA_ORIGIN: STAGING,
    SERVICE_ENVELOPE_PRIVATE_KEY_HEX: "11".repeat(32),
    SERVICE_ENVELOPE_KID: "origin-runtime-test",
  } as const;

  // Two problem-bound Fellows, so the bounded prefix (MAX = 2) dispatches exactly
  // two workshop reads whose refusals populate the list. The base shape is the one
  // the bounded-reader test above proves parse-valid; only distinct ids and a
  // `problem_binding` are added so the workshop router can answer per Fellow.
  const fellow = (fellowId: string, name: string, problemId: string) => ({
    fellow_id: fellowId,
    name,
    model: "model",
    harness: "harness",
    status: "active",
    granted_scopes: ["review"],
    granted_resources: { problem_binding: problemId },
    granted_at: 1,
    credentials: [],
  });
  const fellowsResponse = JSON.stringify({
    fellows: [
      fellow("fellow-01JXYZ", "alpha-fellow", "P-4DSP"),
      fellow("fellow-02KQZ9", "bravo-fellow", "P-7KQZ"),
    ],
    next_cursor: null,
  });

  const problemResponse = (problem: object, httpStatus: number): Response =>
    new Response(JSON.stringify(problem), {
      status: httpStatus,
      headers: { "content-type": "application/problem+json" },
    });

  // Isolate exactly the client/context surfaces; keep the projection real. bun's
  // mock.module keys by resolved module path, so `@/app/console/cards` intercepts
  // the page's own `./cards` import (same file), and likewise for the sentinel.
  mock.module("@/auth", () => ({
    auth: async () => ({ user: { name: "Test Sponsor", id: SPONSOR_ID } }),
    signIn: async () => undefined,
  }));
  mock.module("@/lib/plane-status", () => ({
    consolePlaneStatusRows: () => [],
    planeStatusFreshnessCopy: () => "Plane status pending.",
    resolveCachedPlaneStatus: async () => undefined,
  }));
  mock.module("@/app/console/cards", () => ({
    MintCard: () => null,
    ProposalManager: () => null,
    LifecycleManager: () => null,
  }));
  mock.module("@/app/enrollment-recovery-sentinel", () => ({
    EnrollmentRecoveryFence: (props: { children?: ReactNode }) => props.children ?? null,
  }));
  mock.module("next/link", () => ({
    default: (props: { href?: unknown; children?: ReactNode }) =>
      createElement(
        "a",
        { href: typeof props.href === "string" ? props.href : String(props.href) },
        props.children,
      ),
  }));

  // Route the isolated network: real stoaFellows must succeed so the workshop
  // prefix has candidates; each workshop read is answered per SIGNED fellow_id
  // (the loop dispatches sequentially, but branching on the body is order-free);
  // every other signed call (proposals, bootstrap) degrades without crashing.
  const routeStoa = (workshop: (fellowId: string) => Response) =>
    spyOn(globalThis, "fetch").mockImplementation((async (
      input: unknown,
      init?: { body?: unknown },
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/fellows")) {
        return new Response(fellowsResponse, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/sponsors/workshop")) {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
          fellow_id?: string;
        };
        return workshop(body.fellow_id ?? "");
      }
      // Proposals and bootstrap are bookkeeping for this render; a refusal keeps
      // the console honest without needing their success schemas.
      return new Response("{}", {
        status: 503,
        headers: { "content-type": "application/problem+json" },
      });
    }) as unknown as typeof fetch);

  const renderConsole = async (): Promise<string> => {
    const { default: Console } = await import("@/app/console/page");
    return renderToStaticMarkup(await Console({ searchParams: Promise.resolve({}) }));
  };

  test("registered contract and opaque refusals surface only their code and bounded title", async () => {
    const contractDetailCanary = "private-contract-refusal-detail-canary";
    const contractFixHintCanary = "private-contract-refusal-fix-hint-canary";
    const contractExampleCanary = "private-contract-refusal-example-canary";
    const contractSchemaCanary =
      "https://a.asimposium.org/schemas/private-schema-canary.v1.json";
    const opaqueDetailCanary = "private-opaque-refusal-detail-canary";
    const fetchSpy = routeStoa((fellowId) =>
      fellowId === "fellow-01JXYZ"
        ? problemResponse(
            {
              type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
              title: "Workshop read body is invalid",
              status: 422,
              code: "WORKSHOP_READ_BODY_INVALID",
              detail: contractDetailCanary,
              fix_hint: contractFixHintCanary,
              rule: "A5",
              schema: contractSchemaCanary,
              example: { body_md: contractExampleCanary },
            },
            422,
          )
        : problemResponse(
            {
              type: "https://asimposium.org/errors/WORKSHOP_NOT_FOUND",
              title: "No such workshop",
              status: 404,
              code: "WORKSHOP_NOT_FOUND",
              detail: opaqueDetailCanary,
              fix_hint: "The generic opaque refusal contract requires a nonempty field.",
            },
            404,
          ),
    );
    try {
      const html = await withStoaEnvironment(consoleEnvironment, renderConsole);

      // Both registered refusals appear, each as its code plus registered title.
      expect(html).toContain("<code>WORKSHOP_READ_BODY_INVALID</code>");
      expect(html).toContain("Workshop read body is invalid");
      expect(html).toContain("<code>WORKSHOP_NOT_FOUND</code>");
      expect(html).toContain("No such workshop");
      // Exactly two refusal rows. `</code>: ` is this list item's own separator and
      // occurs nowhere else in the render, so it counts the mounted notices.
      expect((html.match(/<\/code>: /g) ?? []).length).toBe(2);
      // The coarse count reflects both unavailable previews, exactly (plural form).
      expect(html).toContain("2 selected private workshop");
      expect(html).toContain("previews were");
      // The empty-preview branch renders because every candidate was a refusal.
      expect(html).toContain("No available workshop preview contains a push.");
      // No private teaching byte from either refusal body survives the projection
      // — detail, fix_hint, example, and the schema URL (acceptance names schema
      // non-reflection explicitly) are all absent from the render.
      for (const canary of [
        contractDetailCanary,
        contractFixHintCanary,
        contractExampleCanary,
        contractSchemaCanary,
        opaqueDetailCanary,
      ]) {
        expect(html).not.toContain(canary);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("an unregistered code and a status-mismatched refusal starve to a count with no notice", async () => {
    const unknownDetailCanary = "unregistered-workshop-detail-canary";
    const mismatchDetailCanary = "status-mismatch-workshop-detail-canary";
    const mismatchFixHintCanary = "status-mismatch-workshop-fix-hint-canary";
    const mismatchExampleCanary = "status-mismatch-workshop-example-canary";
    const mismatchSchemaCanary =
      "https://a.asimposium.org/schemas/status-mismatch-schema-canary.v1.json";
    const fetchSpy = routeStoa((fellowId) =>
      fellowId === "fellow-01JXYZ"
        ? // Unregistered code: ProblemDocumentSchema rejects WORKSHOP_UNKNOWN, so the
          // refusal parses to nothing — its raw teaching bytes must not leak.
          problemResponse(
            {
              type: "https://asimposium.org/errors/WORKSHOP_UNKNOWN",
              title: "Private workshop bytes must not survive",
              status: 404,
              code: "WORKSHOP_UNKNOWN",
              detail: `body_md=${unknownDetailCanary}`,
              fix_hint: "Do not retain this unregistered refusal.",
            },
            404,
          )
        : // Status mismatch, and ONLY that. This body is a FULLY schema-valid
          // contract refusal (every teaching field present and valid), so
          // ProblemDocumentSchema.safeParse SUCCEEDS; the sole reason refusalInfo
          // discards it is the status-equality guard (body 422 vs HTTP 500).
          // Deleting that guard would surface a WORKSHOP_READ_BODY_INVALID notice
          // and fail the assertions below — which is what makes the guard proven.
          problemResponse(
            {
              type: "https://asimposium.org/errors/WORKSHOP_READ_BODY_INVALID",
              title: "Workshop read body is invalid",
              status: 422,
              code: "WORKSHOP_READ_BODY_INVALID",
              detail: mismatchDetailCanary,
              fix_hint: mismatchFixHintCanary,
              rule: "A5",
              schema: mismatchSchemaCanary,
              example: { body_md: mismatchExampleCanary },
            },
            500,
          ),
    );
    try {
      const html = await withStoaEnvironment(consoleEnvironment, renderConsole);

      // Neither refusal is a registered, status-consistent problem, so no notice
      // row is emitted and no code text leaks into the render.
      expect((html.match(/<\/code>: /g) ?? []).length).toBe(0);
      expect(html).not.toContain("WORKSHOP_UNKNOWN");
      expect(html).not.toContain("WORKSHOP_READ_BODY_INVALID");
      // Both still count as unavailable previews.
      expect(html).toContain("2 selected private workshop");
      expect(html).toContain("previews were");
      expect(html).toContain("No available workshop preview contains a push.");
      // No teaching byte survives — neither the unregistered refusal's raw
      // `body_md=` fragment nor any field of the valid-but-mismatched contract body.
      for (const canary of [
        unknownDetailCanary,
        mismatchDetailCanary,
        mismatchFixHintCanary,
        mismatchExampleCanary,
        mismatchSchemaCanary,
      ]) {
        expect(html).not.toContain(canary);
      }
      expect(html).not.toContain("body_md=");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
