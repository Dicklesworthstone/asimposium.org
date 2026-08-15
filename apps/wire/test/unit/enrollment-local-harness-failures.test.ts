import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

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
 *    400 for everything else typed.
 *
 * No response may carry the key, a ciphertext, a digest, or a raw message.
 */

const MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0002_enrollment_g0.sql");
const LIFECYCLE_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0006_fellow_credential_lifecycle.sql",
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
  return localD1(sqlite);
}

/** Two distinct, well-formed 256-bit base64url keys. */
const KEY_A = "A".repeat(43);
const KEY_B = "B".repeat(43);
const syntheticJoinSecret = (): string => `v1.${"x".repeat(43)}`;

const context = {} as ExecutionContext;

async function call(
  db: D1Database,
  replayKey: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await worker.fetch(
    new Request(`https://local.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { DB: db, ENROLLMENT_REPLAY_KEY: replayKey },
    context,
  );
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, raw };
}

const mintBody = { sponsor_id: "usr_harness_sponsor", request: { requested_scopes: ["review"] } };

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
    const result = await call(freshDatabase(), "", "/v1/fellows", {
      enrollment_id: "ASIMP-EN-0000000000",
      secret: syntheticJoinSecret(),
      name: "orchid-vector",
      model: "m",
      harness: "h",
    });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ code: "ENROLLMENT_UNAVAILABLE" });
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

  test("a typed enrollment failure keeps its exact code at 400", async () => {
    const db = freshDatabase();
    const minted = await call(db, KEY_A, "/__s1/mint", mintBody);
    expect(minted.status).toBe(201);

    // The owning sponsor decides an enrollment nobody has claimed yet. Note the
    // payload shape matters to the service: an explicit decision object reaches
    // the proposal-status check, while omitting it is answered by the principal
    // boundary instead (see the sibling existence-hiding test).
    const approval = await call(db, KEY_A, "/__s1/approve", {
      sponsor_id: mintBody.sponsor_id,
      enrollment_id: minted.body.enrollmentId as string,
      decision: {
        enrollment_id: minted.body.enrollmentId as string,
        decision: "reduce",
      },
    });
    expect(approval.status).toBe(400);
    expect(approval.body).toEqual({ code: "PROPOSAL_NOT_PENDING" });
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
    });
    expect(approval.status).toBe(403);
    expect(approval.body).toEqual({ code: "WRONG_PRINCIPAL" });
  });

  test("malformed local input is still a plain 400, distinct from an operational refusal", async () => {
    const result = await call(freshDatabase(), KEY_A, "/__s1/mint", { sponsor_id: 42 });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ code: "LOCAL_INPUT_INVALID" });
  });
});
