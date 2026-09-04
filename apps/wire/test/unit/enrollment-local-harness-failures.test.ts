import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { OpaqueProblemSchema } from "@asimposium/contracts";
import { getDocument } from "@asimposium/protocol";

import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

import {
  bodyEchoesBearer,
  firstSafeReadUrl,
  isTrustedLocalD1Origin,
  SAFE_FIRST_READ_PATHS,
} from "../../src/enrollment/local-d1-client";
import worker from "../../src/enrollment/local-d1-worker";

/**
 * Failure faces of the local S-1 harness.
 *
 * The harness is the only thing that currently drives the enrollment router
 * against a real D1 binding, so its failure faces are the ones an S-1 run reads.
 * Two properties are asserted here because both were previously wrong:
 *
 *  - a missing or malformed `ENROLLMENT_REPLAY_KEY`, and a replay row that will
 *    not decrypt, are **typed** operational refusals — 503 `ENROLLMENT_UNAVAILABLE`
 *    — not an exception escaping `fetch` as a raw runtime 500, and not a 4xx that
 *    blames the caller for an operator's misconfiguration;
 *  - the codes the S-1 contract depends on survive: 409 for a same-key /
 *    different-digest collision, 403 for `WRONG_PRINCIPAL`, and the exact code at
 *    400 for typed contract/state failures.
 *
 * No response may carry the key, a ciphertext, a digest, or a raw message.
 */

const MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0002_enrollment_g0.sql");
const LIFECYCLE_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0006_fellow_credential_lifecycle.sql",
);
const DEVICE_MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0009_device_flow.sql");
const DEVICE_HARDENING_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0010_device_flow_hardening.sql",
);

type LocalBinding = string | number | null;

function localD1(sqlite: Database): D1Database {
  const prepare = (query: string) => ({
    bind(...values: LocalBinding[]) {
      return {
        async run() {
          const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
          return { meta: { changes: result.changes } };
        },
        async first<T>(): Promise<T | null> {
          return (sqlite.prepare<T, LocalBinding[]>(query).get(...values) ?? null) as T | null;
        },
      };
    },
  });
  return {
    prepare,
    async batch(statements: readonly { run(): Promise<{ meta: { changes: number } }> }[]) {
      sqlite.run("BEGIN");
      try {
        const results: { meta: { changes: number } }[] = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function freshDatabase(): D1Database {
  const sqlite = new Database(":memory:", { strict: true });
  sqlite.run(readFileSync(MIGRATION, "utf8"));
  sqlite.run(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
  sqlite.run(readFileSync(DEVICE_MIGRATION, "utf8"));
  sqlite.run(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
  return localD1(sqlite);
}

/** Distinct, well-formed 256-bit base64url keys. */
const KEY_A = "A".repeat(43);
const KEY_B = "B".repeat(43);
const KEY_C = "C".repeat(43);
const LOCAL_STOA_ORIGIN = "http://127.0.0.1:8787";
const LOCAL_AGORA_ORIGIN = "https://asimposium.org";
const STAGING_STOA_ORIGIN = "https://a-staging.asimposium.org";
const MISSING_STOA_ORIGIN = Symbol("missing-stoa-origin");
const syntheticJoinSecret = (): string => `v1.${"x".repeat(43)}`;

const context = {} as ExecutionContext;

async function call(
  db: D1Database,
  replayKey: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  stoaOrigin: unknown | typeof MISSING_STOA_ORIGIN = LOCAL_STOA_ORIGIN,
): Promise<{
  status: number;
  contentType: string | null;
  body: Record<string, unknown>;
  raw: string;
}> {
  const env: Record<string, unknown> = {
    DB: db,
    ENROLLMENT_REPLAY_KEY: replayKey,
    AGORA_ORIGIN: LOCAL_AGORA_ORIGIN,
  };
  if (stoaOrigin !== MISSING_STOA_ORIGIN) env.STOA_ORIGIN = stoaOrigin;
  const response = await worker.fetch(
    new Request(`https://local.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env as never,
    context,
  );
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: parsed,
    raw,
  };
}

const mintBody = { sponsor_id: "usr_harness_sponsor", request: { requested_scopes: ["review"] } };

async function enrollmentWriteCounts(db: D1Database): Promise<{
  readonly records: number;
  readonly proposals: number;
  readonly fellows: number;
  readonly grants: number;
  readonly credentials: number;
  readonly idempotency: number;
}> {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM enrollment_records) AS records,
         (SELECT COUNT(*) FROM enrollment_proposals) AS proposals,
         (SELECT COUNT(*) FROM enrollment_fellows) AS fellows,
         (SELECT COUNT(*) FROM enrollment_grants) AS grants,
         (SELECT COUNT(*) FROM enrollment_credentials) AS credentials,
         (SELECT COUNT(*) FROM enrollment_idempotency) AS idempotency`,
    )
    .bind()
    .first<{
      readonly records: number;
      readonly proposals: number;
      readonly fellows: number;
      readonly grants: number;
      readonly credentials: number;
      readonly idempotency: number;
    }>();
  if (counts === null) throw new Error("enrollment-write-counts-unavailable");
  return counts;
}

describe("the trusted local Stoa origin is an explicit fixture boundary", () => {
  test.each([
    ["default HTTP port", "http://127.0.0.1:80"],
    ["leading-zero port", "http://127.0.0.1:08787"],
    ["zero port", "http://127.0.0.1:0"],
    ["out-of-range port", "http://127.0.0.1:65536"],
  ])("PLANTED: a %s is not a trusted local D1 origin", (_label, origin) => {
    expect(isTrustedLocalD1Origin(origin)).toBe(false);
  });

  test("a canonical high loopback port remains a trusted local D1 origin", () => {
    expect(isTrustedLocalD1Origin("http://127.0.0.1:65535")).toBe(true);
  });

  const loopbackAliases = [
    ["hostname alias", "http://localhost:8787"],
    ["short IPv4 alias", "http://127.1:8787"],
    ["IPv6 loopback alias", "http://[::1]:8787"],
    ["integer-form IPv4 alias", "http://2130706433:8787"],
  ] as const;

  test.each(loopbackAliases)("PLANTED: a %s is not a trusted local D1 origin", (_label, origin) => {
    expect(isTrustedLocalD1Origin(origin)).toBe(false);
  });

  test.each([
    ["absent", MISSING_STOA_ORIGIN],
    ["foreign", "https://evil.test"],
    ["noncanonical loopback", "http://127.0.0.1:08787"],
  ])("PLANTED: a %s origin refuses before minting", async (_label, origin) => {
    const result = await call(freshDatabase(), KEY_A, "/__s1/mint", mintBody, {}, origin);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ code: "ENROLLMENT_UNAVAILABLE" });
    expect(result.raw).not.toContain(LOCAL_STOA_ORIGIN);
  });

  test.each(loopbackAliases)(
    "PLANTED: mounted %s leaves the D1 enrollment state unchanged and mints nothing",
    async (_label, origin) => {
      const db = freshDatabase();
      const before = await enrollmentWriteCounts(db);

      const result = await call(db, KEY_A, "/__s1/mint", mintBody, {}, origin);

      expect(result.status).toBe(503);
      expect(result.body).toEqual({ code: "ENROLLMENT_UNAVAILABLE" });
      expect(await enrollmentWriteCounts(db)).toEqual(before);
    },
  );

  test("PLANTED: an invalid origin cannot reuse the same D1/key service cache entry", async () => {
    const db = freshDatabase();
    const valid = await call(db, KEY_A, "/__s1/mint", mintBody);
    expect(valid.status).toBe(201);

    const refused = await call(db, KEY_A, "/__s1/mint", mintBody, {}, "https://evil.test");
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ code: "ENROLLMENT_UNAVAILABLE" });
  });
});

describe("a replay key the operator did not supply is a typed 503", () => {
  for (const [label, key] of [
    ["absent", ""],
    ["too short", "A".repeat(42)],
    ["wrong alphabet", `${"A".repeat(42)}+`],
    ["obviously not a key", "not-a-key"],
  ] as const) {
    test(`a ${label} key refuses with ENROLLMENT_UNAVAILABLE, never a raw 500`, async () => {
      const result = await call(freshDatabase(), key, "/__s1/mint", mintBody);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ code: "ENROLLMENT_UNAVAILABLE" });
      // Nothing about the key material, not even its length or which check failed.
      if (key.length > 0) expect(result.raw).not.toContain(key.slice(0, 8));
      expect(result.raw.length).toBeLessThan(120);
    });
  }

  test("the refusal reaches the mounted router surface too, not only the setup routes", async () => {
    const secret = syntheticJoinSecret();
    const result = await call(freshDatabase(), "", "/v1/fellows", {
      enrollment_id: "ASIMP-EN-0000000000",
      secret,
      name: "orchid-vector",
      model: "m",
      harness: "h",
    });
    expect(result.status).toBe(503);
    expect(result.contentType).toBe("application/problem+json; charset=utf-8");
    expect(OpaqueProblemSchema.safeParse(result.body).success).toBe(true);
    expect(result.body).toMatchObject({
      type: "https://asimposium.org/errors/ENROLLMENT_UNAVAILABLE",
      status: 503,
      code: "ENROLLMENT_UNAVAILABLE",
    });
    expect(result.raw).not.toContain(secret);
    expect(result.raw).not.toContain(secret.slice("v1.".length));
  });
});

describe("a replay row that will not decrypt is operational, not a client error", () => {
  test("PLANTED: a rotated key turns a valid replay into 503, never 409 and never 200", async () => {
    const db = freshDatabase();
    const key = "harness-rotated-1";

    const first = await call(db, KEY_A, "/__s1/mint", mintBody, { "idempotency-key": key });
    expect(first.status).toBe(201);

    // Same request, same key, different replay key: the stored ciphertext cannot
    // be opened. That is a configuration failure, and it must not be dressed up
    // as a digest conflict or answered with a second minted enrollment.
    const replayed = await call(db, KEY_B, "/__s1/mint", mintBody, { "idempotency-key": key });
    expect(replayed.status).toBe(503);
    expect(replayed.body).toEqual({ code: "ENROLLMENT_UNAVAILABLE" });
    expect(replayed.body.code).not.toBe("IDEMPOTENCY_CONFLICT");
    expect(replayed.raw).not.toContain("ciphertext");
    expect(replayed.raw).not.toContain(KEY_A.slice(0, 8));
    expect(replayed.raw).not.toContain(KEY_B.slice(0, 8));
  });
});

test("the local isolate cache never reuses a service across D1 binding identities", async () => {
  const first = await call(freshDatabase(), KEY_C, "/__s1/mint", mintBody);
  expect(first.status).toBe(201);
  const enrollmentId = first.body.enrollmentId as string;

  const absentFromSecondBinding = await call(freshDatabase(), KEY_C, "/__s1/card", {
    sponsor_id: mintBody.sponsor_id,
    enrollment_id: enrollmentId,
  });
  expect(absentFromSecondBinding.status).toBe(403);
  expect(absentFromSecondBinding.body).toEqual({ code: "WRONG_PRINCIPAL" });
});

describe("the codes the S-1 contract depends on survive the harness", () => {
  test("an identical retry under one key replays instead of minting twice", async () => {
    const db = freshDatabase();
    const key = "harness-replay-1";
    const first = await call(db, KEY_A, "/__s1/mint", mintBody, { "idempotency-key": key });
    const second = await call(db, KEY_A, "/__s1/mint", mintBody, { "idempotency-key": key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  test("PLANTED: the same key with a different request keeps its 409 and its exact code", async () => {
    const db = freshDatabase();
    const key = "harness-conflict-1";
    const first = await call(db, KEY_A, "/__s1/mint", mintBody, { "idempotency-key": key });
    expect(first.status).toBe(201);

    const conflicting = await call(
      db,
      KEY_A,
      "/__s1/mint",
      { sponsor_id: mintBody.sponsor_id, request: { requested_scopes: ["promote"] } },
      { "idempotency-key": key },
    );
    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("a sponsor asking for another sponsor's card keeps 403 WRONG_PRINCIPAL", async () => {
    const db = freshDatabase();
    const minted = await call(db, KEY_A, "/__s1/mint", mintBody);
    expect(minted.status).toBe(201);
    const enrollmentId = minted.body.enrollmentId as string;

    const card = await call(db, KEY_A, "/__s1/card", {
      sponsor_id: "usr_someone_else",
      enrollment_id: enrollmentId,
    });
    expect(card.status).toBe(403);
    expect(card.body).toEqual({ code: "WRONG_PRINCIPAL" });
  });

  test("a typed enrollment target failure keeps its exact code at 400", async () => {
    const db = freshDatabase();
    const minted = await call(db, KEY_A, "/__s1/mint", mintBody);
    expect(minted.status).toBe(201);

    // The owning sponsor sends a structurally valid command whose signed target
    // differs from the local route target, so this reaches the service's target
    // binding rather than the local-input or step-up boundary.
    const approval = await call(db, KEY_A, "/__s1/approve", {
      sponsor_id: mintBody.sponsor_id,
      enrollment_id: minted.body.enrollmentId as string,
      decision: {
        enrollment_id: "ASIMP-EN-0000000000",
        decision: "approve",
        step_up_authenticated_at: Math.floor(Date.now() / 1_000),
      },
    });
    expect(approval.status).toBe(400);
    expect(approval.body).toEqual({ code: "DECISION_TARGET_MISMATCH" });
    // The old harness collapsed every failure here into one local label.
    expect(approval.body.code).not.toBe("LOCAL_APPROVAL_FAILED");
    expect(approval.body.code).not.toBe("ENROLLMENT_UNAVAILABLE");
  });

  test("an unknown enrollment id still hides its own existence behind 403", async () => {
    // Not a 404: an id that does not exist and an id belonging to another sponsor
    // must be indistinguishable, so the harness must not "improve" this to a
    // more specific status.
    const approval = await call(freshDatabase(), KEY_A, "/__s1/approve", {
      sponsor_id: mintBody.sponsor_id,
      enrollment_id: "ASIMP-EN-0000000000",
      decision: {
        enrollment_id: "ASIMP-EN-0000000000",
        decision: "deny",
        step_up_authenticated_at: Math.floor(Date.now() / 1_000),
      },
    });
    expect(approval.status).toBe(403);
    expect(approval.body).toEqual({ code: "WRONG_PRINCIPAL" });
  });

  test("malformed local input is still a plain 400, distinct from an operational refusal", async () => {
    const result = await call(freshDatabase(), KEY_A, "/__s1/mint", { sponsor_id: 42 });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ code: "LOCAL_INPUT_INVALID" });
  });

  test("a keyless write on a fresh enrollment is refused and leaves no proposal", async () => {
    const db = freshDatabase();
    const minted = await call(db, KEY_A, "/__s1/mint", mintBody, {
      "idempotency-key": "harness-mint-1",
    });
    expect(minted.status).toBe(201);
    const { enrollmentId, secret } = minted.body as { enrollmentId: string; secret: string };

    const claim = {
      enrollment_id: enrollmentId,
      secret,
      name: "harness-orchid",
      model: "harness-model",
      harness: "codex",
    };
    const cardState = async () => {
      const card = await call(db, KEY_A, "/__s1/card", {
        sponsor_id: mintBody.sponsor_id,
        enrollment_id: enrollmentId,
      });
      return { status: card.status, body: card.body, raw: `${card.status}:${card.raw}` };
    };

    // The refusal comes *first*, on an enrollment that has never been claimed.
    // Ordering it after a successful claim would make the assertions below
    // insensitive: the proposal would exist either way.
    const before = await cardState();
    // This test drives the D1 store over in-memory SQLite. That adapter joins
    // through proposals and therefore exposes a fresh enrollment through the
    // coarser WRONG_PRINCIPAL face; the real local-D1 client asserts the same
    // adapter-specific privacy boundary.
    expect(before.status).toBe(403);
    expect(before.body).toEqual({ code: "WRONG_PRINCIPAL" });
    const refused = await call(db, KEY_A, "/v1/fellows", claim);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect((await cardState()).raw).toBe(before.raw);

    // The enrollment is still unspent: a first keyed claim succeeds as a fresh
    // 202. Had the refused attempt written a proposal, this could not.
    const accepted = await call(db, KEY_A, "/v1/fellows", claim, {
      "idempotency-key": "harness-claim-1",
    });
    expect(accepted.status).toBe(202);
    expect(typeof accepted.body.flow_handle).toBe("string");

    // Causal closer: the observed state does move when a write really lands, so
    // the unchanged-state assertion above is not vacuous.
    const pending = await cardState();
    expect(pending.status).toBe(200);
    expect(pending.body.card).toMatchObject({ enrollmentId, status: "pending" });
    expect(pending.raw).not.toBe(before.raw);
  });
});

/**
 * The first safe read has to be a real successful canonical read, not a 200 this
 * harness invented. These drive the local worker's own `fetch` — no network, no
 * Wrangler — and assert the bytes are the production document.
 */
describe("the public texts hello names are served by the production handler", () => {
  const publicRead = async (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ): Promise<Response> =>
    worker.fetch(
      new Request(`https://local.invalid${path}`, { method, headers }),
      {
        DB: freshDatabase(),
        ENROLLMENT_REPLAY_KEY: KEY_A,
        STOA_ORIGIN: LOCAL_STOA_ORIGIN,
      } as never,
      context,
    );

  for (const path of SAFE_FIRST_READ_PATHS) {
    test(`${path} is a 200 canonical markdown read with a non-empty body`, async () => {
      const response = await publicRead(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect((await response.text()).trim().length).toBeGreaterThan(0);
    });

    test(`${path} serves the exact production document, not a harness fixture`, async () => {
      // The causal half. A fixture body would satisfy the status and
      // content-type assertions above; only comparing against the registry the
      // deployed Worker reads proves the production handler is what ran.
      const expected = getDocument(path === "/protocol.md" ? "protocol" : "skill");
      const served = await publicRead(path);
      expect(await served.text()).toBe(expected.body);
      expect(served.headers.get("etag")).toBe(`"${expected.digest}"`);
    });

    test(`${path} needs no Authorization header`, async () => {
      // Reads are free (Rule A5). The S-1 driver sends this request with no
      // credential, so a 401/403 here would mean its first action cannot work.
      const response = await publicRead(path);
      expect(response.status).toBe(200);
    });
  }

  test("the public-text delegation does not inherit an enrollment misconfiguration", async () => {
    // Enrollment is unusable with an empty replay key — that must not make a
    // free public read fail, because the read does not depend on it.
    const response = await worker.fetch(
      new Request("https://local.invalid/protocol.md"),
      { DB: freshDatabase(), ENROLLMENT_REPLAY_KEY: "", STOA_ORIGIN: LOCAL_STOA_ORIGIN } as never,
      context,
    );
    expect(response.status).toBe(200);
  });

  test("PLANTED: the delegation is read-only and path-exact", async () => {
    // A write verb on a public-text path, and a neighbouring path, must not be
    // handed to the production app by this narrow delegation.
    const written = await publicRead("/protocol.md", {}, "POST");
    expect(written.status).not.toBe(200);
    const neighbour = await publicRead("/protocol.md/extra");
    expect(neighbour.status).not.toBe(200);
  });
});

/**
 * These are source documents exercised locally. They cannot choose their
 * origin from a request: all executable operations are relative to the issued
 * join URL's configured origin. The production identifier remains in the
 * canonical join-URL example, but is never a destination in staging or local
 * onboarding instructions.
 */
describe("the complete local onboarding source stays same-origin", () => {
  const onboardingDocuments = ["handbook", "skill", "llms", "capsule"] as const;
  const relativeOperationPaths = (body: string): string[] =>
    [...body.matchAll(/\b(?:GET|POST)\s+`?(\/[^\s`]+)/g)].map((match) => match[1] ?? "");

  test.each([STAGING_STOA_ORIGIN, LOCAL_STOA_ORIGIN])(
    "%s has no executable production destination in any onboarding document",
    (origin) => {
      for (const id of onboardingDocuments) {
        const body = getDocument(id).body;
        expect(body).not.toMatch(/\b(?:GET|POST)\s+https:\/\/a\.asimposium\.org(?:\/|\b)/);
        expect(body).not.toMatch(/\bcurl\b[^\n]*https:\/\/a\.asimposium\.org(?:\/|\b)/);

        const paths = relativeOperationPaths(body);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          expect(new URL(path, origin).origin).toBe(origin);
        }
      }
    },
  );

  test("keeps the production join URL as a non-executable canonical identifier", () => {
    const capsule = getDocument("capsule").body;
    expect(capsule).toContain(
      "https://a.asimposium.org/join/ASIMP-EN-<enrollment-id>#v1.<enrollment-secret>",
    );
    expect(capsule).toContain("STOA_ORIGIN='<origin-from-issued-join-url>'");
  });
});

/**
 * The first-safe-read seam, planted without sending a single attacker request.
 *
 * The S-1 local lane follows hello's own `next_actions`, which means a hostile or
 * misconfigured `STOA_ORIGIN` could otherwise aim a freshly issued bearer at a
 * host of someone else's choosing. Proving that refusal by *making* the request
 * would mean this suite contacts an attacker-controlled URL to demonstrate that
 * it does not. Importing the pure validator instead keeps the proof causal and
 * the network untouched — and it is the reason the client exports it.
 */
describe("hello's first next_action is validated before the driver follows it", () => {
  const localOrigin = "http://127.0.0.1:23992";
  const helloWith = (first: unknown): unknown => ({ next_actions: [first, { action: "read" }] });
  const safeFirst = { action: "read", url: `${localOrigin}/protocol.md`, reason: "the rules" };

  test("accepts the exact read action the Worker composes from its trusted origin", () => {
    expect(firstSafeReadUrl(helloWith(safeFirst), localOrigin)).toBe(`${localOrigin}/protocol.md`);
  });

  for (const path of SAFE_FIRST_READ_PATHS) {
    test(`accepts the allow-listed path ${path}`, () => {
      expect(
        firstSafeReadUrl(helloWith({ ...safeFirst, url: `${localOrigin}${path}` }), localOrigin),
      ).toBe(`${localOrigin}${path}`);
    });
  }

  test.each([
    ["a cross-origin host", { ...safeFirst, url: "https://evil.test/protocol.md" }],
    ["a same-host different-port origin", { ...safeFirst, url: "http://127.0.0.1:1/protocol.md" }],
    ["a different scheme", { ...safeFirst, url: "https://127.0.0.1:23992/protocol.md" }],
    ["userinfo smuggling", { ...safeFirst, url: "http://a:b@127.0.0.1:23992/protocol.md" }],
    ["a query string", { ...safeFirst, url: `${localOrigin}/protocol.md?token=x` }],
    ["a fragment", { ...safeFirst, url: `${localOrigin}/protocol.md#v1.x` }],
    ["an unlisted path", { ...safeFirst, url: `${localOrigin}/v1/hello` }],
    // These three are the reason the rule is raw string equality. Each one
    // *parses* to the canonical value — `pathname === "/protocol.md"`, and
    // `search`/`hash` both empty string — so a parsed origin+pathname comparison
    // accepts all three and the driver follows bytes the Worker never composed.
    [
      "a path-traversal spelling that normalizes to canonical",
      { ...safeFirst, url: `${localOrigin}/v1/../protocol.md` },
    ],
    ["a bare trailing question mark", { ...safeFirst, url: `${localOrigin}/protocol.md?` }],
    ["a bare trailing hash", { ...safeFirst, url: `${localOrigin}/protocol.md#` }],
    [
      "a traversal spelling with a suffix",
      { ...safeFirst, url: `${localOrigin}/v1/../protocol.md/x` },
    ],
    ["a double slash before the path", { ...safeFirst, url: `${localOrigin}//protocol.md` }],
    ["a percent-encoded path", { ...safeFirst, url: `${localOrigin}/protocol%2Emd` }],
    ["a trailing slash", { ...safeFirst, url: `${localOrigin}/protocol.md/` }],
    ["a write action", { ...safeFirst, action: "write" }],
    ["a promote action", { ...safeFirst, action: "promote" }],
    ["a missing action verb", { url: `${localOrigin}/protocol.md` }],
    ["a non-string url", { action: "read", url: 42 }],
    ["an unparseable url", { action: "read", url: "not-a-url" }],
    ["a null action entry", null],
    ["an array action entry", []],
  ])("PLANTED: %s is refused without a follow-up request", (_label, first) => {
    expect(() => firstSafeReadUrl(helloWith(first), localOrigin)).toThrow("next-action-unsafe");
  });

  test.each([
    ["/v1/../protocol.md", `${localOrigin}/v1/../protocol.md`],
    ["/protocol.md?", `${localOrigin}/protocol.md?`],
    ["/protocol.md#", `${localOrigin}/protocol.md#`],
  ])(
    "PLANTED: %s normalizes to canonical, so only raw equality can refuse it",
    (_label, hostile) => {
      // The causal half of the three plants above. This asserts the *old* rule
      // would have accepted them: parsed pathname is exactly the canonical path
      // and both search and hash are empty. Without this, "rejected" proves
      // nothing — a typo would be rejected too. No request is made here; the
      // validator is pure, which is the point of exporting it.
      const parsed = new URL(hostile);
      expect(parsed.pathname).toBe("/protocol.md");
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
      expect(parsed.origin).toBe(localOrigin);
      expect(hostile).not.toBe(`${localOrigin}/protocol.md`);

      expect(() =>
        firstSafeReadUrl(helloWith({ ...safeFirst, url: hostile }), localOrigin),
      ).toThrow("next-action-unsafe");
    },
  );

  test("returns the raw canonical string it was given, not a reparse of it", () => {
    const canonical = `${localOrigin}/skill.md`;
    expect(firstSafeReadUrl(helloWith({ ...safeFirst, url: canonical }), localOrigin)).toBe(
      canonical,
    );
  });

  test.each([
    ["an absent next_actions list", {}],
    ["an empty next_actions list", { next_actions: [] }],
    ["a non-array next_actions", { next_actions: "read /protocol.md" }],
    ["a null hello body", null],
  ])("PLANTED: %s is a contract failure, not an unsafe action", (_label, hello) => {
    expect(() => firstSafeReadUrl(hello, localOrigin)).toThrow("next-actions-missing");
  });

  test("PLANTED: a safe action is still refused when the issuing origin is unparseable", () => {
    expect(() => firstSafeReadUrl(helloWith(safeFirst), "not-an-origin")).toThrow(
      "next-actions-missing",
    );
  });
});

describe("no response body may echo the bearer", () => {
  const token = `asimp_ag_${"A".repeat(26)}_${"z".repeat(43)}`;

  test("PLANTED: an exact bearer in the body is an echo", () => {
    expect(bodyEchoesBearer(`{"debug":"${token}"}`, token)).toBe(true);
  });

  test("PLANTED: the prefix-stripped material is an echo too", () => {
    // A face that renders the opaque half without `asimp_ag_` has still
    // published the credential; matching only the whole string would miss it.
    expect(bodyEchoesBearer(`{"debug":"${token.slice("asimp_ag_".length)}"}`, token)).toBe(true);
  });

  test("an ordinary hello body is not an echo", () => {
    expect(
      bodyEchoesBearer('{"fellow":{"name":"local-orchid"},"granted_scopes":["review"]}', token),
    ).toBe(false);
  });

  test("the bare prefix by itself is not an echo", () => {
    expect(bodyEchoesBearer('{"token_prefix":"asimp_ag_"}', token)).toBe(false);
  });

  test("an empty token can never report an echo", () => {
    expect(bodyEchoesBearer("anything at all", "")).toBe(false);
  });
});
