import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

import {
  canonicalBytes,
  ENVELOPE_VERSION,
  payloadDigest,
  type ServiceEnvelopeClaims,
  toHex,
} from "../../src/auth/canonical";
import { parseEnvelope, verifyServiceEnvelope } from "../../src/auth/envelope";
import { VerificationKeyring } from "../../src/auth/keyring";
import {
  D1NonceStore,
  MemoryNonceStore,
  type NonceStore,
  NonceStoreInputError,
} from "../../src/auth/nonce";
import { envelopeRefusalProblem, wrongPrincipalProblem } from "../../src/auth/refusal";

/**
 * S-6 hardening vectors for the auth boundary.
 *
 * The D1 tests execute the migration and adapter SQL against local SQLite only
 * as a dialect/atomic-statement contract. They are deliberately unit tests,
 * not a claim about a deployed D1 binding, Worker isolate, Vercel, or Google.
 */

const NOW = 1_786_000_000;
const BODY = '{"focus":"nonce replay hardening"}';
const ROUTE = "/v1/p/:id/directives";
const migration = readFileSync(
  resolve(import.meta.dir, "../../../../db/migrations/0003_auth_nonce_replay.sql"),
  "utf8",
);

type LocalBinding = string | number | boolean | null | Uint8Array;

/**
 * A narrow D1-shape adapter over an actual in-memory SQLite engine. It does
 * not emulate SQLite conflict semantics: the migration and UPSERT run in the
 * engine. The cast is only the Worker API's broader unused surface.
 */
function localD1(sqlite: Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              const result = sqlite
                .prepare<unknown, LocalBinding[]>(query)
                .run(...(values as LocalBinding[]));
              return { meta: { changes: result.changes } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function nonceDatabase(cleanupBatchSize = 100): { sqlite: Database; store: D1NonceStore } {
  const sqlite = new Database(":memory:", { strict: true });
  sqlite.exec(migration);
  return { sqlite, store: new D1NonceStore(localD1(sqlite), cleanupBatchSize) };
}

async function keypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
}

async function sign(privateKey: CryptoKey, claims: ServiceEnvelopeClaims): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        canonicalBytes(claims).slice().buffer,
      ),
    ),
  );
}

async function claims(
  overrides: Partial<ServiceEnvelopeClaims> = {},
): Promise<ServiceEnvelopeClaims> {
  return {
    v: ENVELOPE_VERSION,
    kid: "agora-2026-08-a",
    alg: "Ed25519",
    iss: "agora",
    aud: "stoa",
    iat: NOW,
    exp: NOW + 60,
    nonce: "s".repeat(43),
    method: "POST",
    route: ROUTE,
    action: "directive.create",
    principal_type: "sponsor",
    principal_id: "usr_01JXYZ0000000000000000",
    payload_sha256: await payloadDigest(BODY),
    ...overrides,
  };
}

async function envelopeHarness() {
  const keys = await keypair();
  const keyring = new VerificationKeyring([
    {
      kid: "agora-2026-08-a",
      publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
      notBefore: 0,
    },
  ]);

  return {
    async signed(overrides: Partial<ServiceEnvelopeClaims> = {}) {
      const signedClaims = await claims(overrides);
      return { claims: signedClaims, signature: await sign(keys.privateKey, signedClaims) };
    },
    verify(envelope: unknown, nonces: D1NonceStore | MemoryNonceStore, now = NOW) {
      return verifyServiceEnvelope(envelope, {
        keyring,
        nonces,
        now,
        issuer: "agora",
        audience: "stoa",
        body: BODY,
        method: "POST",
        route: ROUTE,
        permittedActions: ["directive.create"],
      });
    },
  };
}

describe("pre-crypto envelope selectors", () => {
  test.each([
    ["v", "x".repeat(4096)],
    ["alg", "x".repeat(4096)],
  ])("rejects a planted 4096-byte %s before canonicalization or crypto", async (field, value) => {
    const malformedClaims = await claims({ [field]: value } as Partial<ServiceEnvelopeClaims>);
    const envelope = { claims: malformedClaims, signature: "0".repeat(128) };

    // parseEnvelope performs no key lookup or crypto. Rejection here is the
    // direct proof that the oversized selector cannot reach either operation.
    expect(parseEnvelope(envelope)).toBeUndefined();
    const h = await envelopeHarness();
    const result = await h.verify(envelope, new MemoryNonceStore());
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("retains compact unknown selectors for the non-oracular internal enum", async () => {
    const h = await envelopeHarness();
    for (const [overrides, reason] of [
      [{ v: "asimp-env-0" }, "unsupported_version"],
      [{ alg: "HS256" }, "unsupported_alg"],
    ] as const) {
      expect(await h.verify(await h.signed(overrides), new MemoryNonceStore())).toMatchObject({
        ok: false,
        reason,
      });
    }
  });
});

describe("D1 nonce replay contract", () => {
  test("migration stores only a fixed-width nonce digest and supports bounded expiry lookup", () => {
    expect(migration).toContain("CREATE TABLE auth_envelope_nonces");
    expect(migration).toContain("nonce_hash TEXT PRIMARY KEY");
    expect(migration).toContain("auth_envelope_nonces_expires_idx");
    expect(migration).not.toContain("nonce TEXT");
  });

  test("one atomic UPSERT accepts exactly one concurrent duplicate across store instances", async () => {
    const { sqlite, store } = nonceDatabase();
    try {
      const duplicate = "d".repeat(43);
      const secondIsolateStore = new D1NonceStore(localD1(sqlite));
      const outcomes = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          (index % 2 === 0 ? store : secondIsolateStore).claim(duplicate, NOW + 120, NOW),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);

      const rows = sqlite
        .query<{ nonce_hash: string; expires_at: number }, []>(
          "SELECT nonce_hash, expires_at FROM auth_envelope_nonces",
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.nonce_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.nonce_hash).not.toBe(duplicate);
      expect(rows[0]?.expires_at).toBe(NOW + 120);
    } finally {
      sqlite.close();
    }
  });

  test("cleanup is TTL-based and bounded, while an expired nonce can be reclaimed atomically", async () => {
    const { sqlite, store } = nonceDatabase(2);
    try {
      sqlite.run(
        "INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at) VALUES (?, ?, ?)",
        ["a".repeat(64), 10, 1],
      );
      sqlite.run(
        "INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at) VALUES (?, ?, ?)",
        ["b".repeat(64), 10, 1],
      );
      sqlite.run(
        "INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at) VALUES (?, ?, ?)",
        ["c".repeat(64), 10, 1],
      );

      expect(await store.cleanupExpired(10)).toBe(2);
      expect(
        sqlite
          .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_envelope_nonces")
          .get()?.count,
      ).toBe(1);
      expect(await store.cleanupExpired(10)).toBe(1);

      const nonce = "r".repeat(43);
      expect(await store.claim(nonce, 20, 11)).toBe(true);
      expect(await store.cleanupExpired(20)).toBe(1);
      expect(await store.claim(nonce, 40, 21)).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

/**
 * Both `NonceStore` implementations must refuse exactly the same windows.
 *
 * The guard used to live only in `D1NonceStore`, which made the in-memory
 * double the more permissive of the two. A regression narrowing the verifier's
 * expiry margin would then keep every `MemoryNonceStore` test green while
 * production turned an ordinary expired credential into a coarse
 * replay-store outage. Running one table against both closes that asymmetry.
 */
describe("shared NonceStore input contract", () => {
  const CONTRACT_NONCE = "n".repeat(43);

  /** Windows no store may accept: unusable `now`, unusable expiry, or no margin. */
  const INVALID_WINDOWS = [
    ["expiry equal to now", NOW, NOW],
    ["expiry before now", NOW - 1, NOW],
    ["fractional expiry", NOW + 0.5, NOW],
    ["fractional now", NOW + 60, NOW + 0.5],
    ["negative now", NOW + 60, -1],
    ["negative expiry", -1, NOW],
    ["NaN now", NOW + 60, Number.NaN],
    ["infinite expiry", Number.POSITIVE_INFINITY, NOW],
    ["unsafe-integer expiry", Number.MAX_SAFE_INTEGER + 1, NOW],
  ] as const;

  const STORE_FACTORIES = [
    [
      "MemoryNonceStore",
      (): { store: NonceStore; close: () => void } => ({
        store: new MemoryNonceStore(),
        close: () => {},
      }),
    ],
    [
      "D1NonceStore",
      (): { store: NonceStore; close: () => void } => {
        // The existing shim: real SQLite, real migration, real UPSERT.
        const { sqlite, store } = nonceDatabase();
        return { store, close: () => sqlite.close() };
      },
    ],
  ] as const;

  for (const [storeName, makeStore] of STORE_FACTORIES) {
    describe(storeName, () => {
      test.each(INVALID_WINDOWS)(
        "PLANTED: refuses %s as a typed input error, never a replay decision",
        async (_label, expiresAt, now) => {
          const { store, close } = makeStore();
          try {
            // Captured rather than matched so the assertion proves the typed
            // error, not merely that something threw: a TypeError from a
            // broken store would otherwise satisfy a bare `rejects.toThrow`.
            const outcome = await store.claim(CONTRACT_NONCE, expiresAt, now).then(
              (accepted) => accepted as unknown,
              (error: unknown) => error,
            );
            expect(outcome).toBeInstanceOf(NonceStoreInputError);
            expect((outcome as NonceStoreInputError).code).toBe("NONCE_STORE_INPUT");
          } finally {
            close();
          }
        },
      );

      test("accepts the exact one-second margin and still refuses its replay", async () => {
        const { store, close } = makeStore();
        try {
          // `verifyServiceEnvelope` retains through `exp + skew + 1`, so the
          // narrowest window a real claim ever presents is exactly one second.
          // This is the boundary the invalid table sits directly beneath, and
          // accepting it is what keeps the table a contract rather than a
          // blanket refusal.
          expect(await store.claim(CONTRACT_NONCE, NOW + 1, NOW)).toBe(true);
          expect(await store.claim(CONTRACT_NONCE, NOW + 1, NOW)).toBe(false);
        } finally {
          close();
        }
      });
    });
  }
});

describe("signed authorization and replay ordering", () => {
  test("a forged signature cannot burn a D1 nonce; the valid request then claims it through skew", async () => {
    const { sqlite, store } = nonceDatabase();
    try {
      const h = await envelopeHarness();
      const signed = await h.signed();
      const forged = { ...signed, signature: "0".repeat(128) };

      expect(await h.verify(forged, store)).toMatchObject({ ok: false, reason: "bad_signature" });
      expect(
        sqlite
          .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_envelope_nonces")
          .get()?.count,
      ).toBe(0);

      const withinSkew = NOW + 60 + 60;
      expect((await h.verify(signed, store, withinSkew)).ok).toBe(true);
      expect(await h.verify(signed, store, withinSkew)).toMatchObject({
        ok: false,
        reason: "replayed",
      });
      expect(
        sqlite
          .query<{ expires_at: number }, []>("SELECT expires_at FROM auth_envelope_nonces")
          .get()?.expires_at,
      ).toBe(NOW + 60 + 60 + 1);
    } finally {
      sqlite.close();
    }
  });

  test("a valid non-sponsor envelope is refused before its nonce is claimed", async () => {
    const { sqlite, store } = nonceDatabase();
    try {
      const h = await envelopeHarness();
      const fellow = await h.signed({ principal_type: "fellow" });
      expect(await h.verify(fellow, store)).toMatchObject({
        ok: false,
        reason: "wrong_principal_type",
      });
      expect(
        sqlite
          .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_envelope_nonces")
          .get()?.count,
      ).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

describe("safe RFC 7807 auth refusal faces", () => {
  test("signature, binding, and replay refusals share the same non-oracular 401 face", async () => {
    const signatures = await Promise.all(
      (["bad_signature", "payload_mismatch", "wrong_principal_type"] as const).map(
        async (reason) => {
          const response = envelopeRefusalProblem(reason);
          return { status: response.status, body: await response.text() };
        },
      ),
    );
    expect(new Set(signatures.map(({ status, body }) => `${status}:${body}`)).size).toBe(1);
    const signatureDocument: unknown = await new Response(signatures[0]?.body ?? "").json();
    expect(ProblemDocumentSchema.safeParse(signatureDocument).success).toBe(true);
    expect(signatures[0]?.body).toContain('"code":"UNAUTHORIZED"');
    expect(signatures[0]?.body).not.toContain("bad_signature");
    expect(signatures[0]?.body).not.toContain("payload_mismatch");
    expect(signatures[0]?.body).not.toContain("wrong_principal_type");
  });

  test("replay-store outage and credential-class confusion map to precise safe RFC 7807 classes", async () => {
    const unavailable = envelopeRefusalProblem("store_unavailable");
    const wrongPrincipal = wrongPrincipalProblem();
    expect(unavailable.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(unavailable.status).toBe(503);
    expect(ProblemDocumentSchema.parse(await unavailable.json())).toMatchObject({
      code: "AUTH_REPLAY_STORE_UNAVAILABLE",
    });
    expect(wrongPrincipal.status).toBe(403);
    expect(ProblemDocumentSchema.parse(await wrongPrincipal.json())).toMatchObject({
      code: "WRONG_PRINCIPAL",
    });
  });
});
