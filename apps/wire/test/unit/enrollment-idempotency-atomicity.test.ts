import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";

import { D1EnrollmentStore } from "../../src/enrollment/d1-store";
import type { EnrollmentRecord } from "../../src/enrollment/service";

/**
 * The active-key abort, proven against the real migration.
 *
 * `enrollment_idempotency.request_digest NOT NULL` is load-bearing: the conflict
 * path in `idempotencyStatement` assigns NULL on a still-live key, which fails
 * the statement and rolls the *whole batch* back — product effect included. That
 * is what refuses a concurrent second writer under one key atomically, with no
 * read-then-write window for a racing isolate.
 *
 * Two directions are asserted here, and the second is what makes the constraint
 * load-bearing rather than decorative:
 *
 *  1. against the shipped schema, a colliding write leaves *neither* its own
 *     effect nor a mutated replay row behind;
 *  2. against the same schema with only that NOT NULL relaxed, the identical
 *     write **succeeds and destroys the first caller's row** — so if anyone ever
 *     relaxes the column, case 1 fails and this file says why.
 *
 * ## What this proves, and what it does not
 *
 * The statements, the schema and the rollback are real SQLite. `batch()` is a
 * shim that models D1's documented contract — statements execute sequentially on
 * one connection, implicitly wrapped in a transaction, rolled back on error. It
 * is not proof that deployed D1 implements that contract, and it cannot exercise
 * two Worker isolates; `local-d1-client.ts` drives the same store through real
 * workerd, and the deployed claim is still owed. `changes()` visibility between
 * statements is likewise SQLite's here.
 */

const MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0002_enrollment_g0.sql");

/** The exact column definition the abort depends on. */
const LOAD_BEARING_COLUMN = "request_digest TEXT NOT NULL";

type LocalBinding = string | number | null;

/**
 * A D1 shim over `bun:sqlite`. `batch` is the part that matters: one
 * transaction, sequential statements, rollback on any error, error rethrown.
 */
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

function database(options: { readonly nullableDigest?: boolean } = {}): Database {
  const schema = readFileSync(MIGRATION, "utf8");
  expect(schema).toContain(LOAD_BEARING_COLUMN);
  const sqlite = new Database(":memory:", { strict: true });
  sqlite.run(
    options.nullableDigest === true
      ? schema.replace(LOAD_BEARING_COLUMN, "request_digest TEXT")
      : schema,
  );
  return sqlite;
}

const NOW = 1_786_000_000_000;

function record(id: string): EnrollmentRecord {
  return {
    enrollmentId: id,
    sponsorId: "usr_fixture_sponsor",
    secretHash: `sha256-fixture-${id}`,
    createdAt: NOW,
    secretExpiresAt: NOW + 30 * 60_000,
    requestedScopes: ["review"],
    requestedResources: {},
    invalidated: false,
  } as EnrollmentRecord;
}

const KEY = "local-mint-collision-1";

/** Distinct 64-hex digests, the shape `sha256Hex` produces for a request body. */
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function write(digest: string, marker: string, now = NOW) {
  return {
    scope: "mint" as const,
    principalScope: "usr_fixture_sponsor",
    key: KEY,
    digest,
    now,
    encryptedResponse: {
      ciphertext: `ciphertext-${marker}`,
      initializationVector: `iv-${marker}`,
    },
  };
}

interface ReplayRow {
  request_digest: string | null;
  response_ciphertext: string;
  response_initialization_vector: string;
  expires_at: number;
}

function replayRow(sqlite: Database): ReplayRow | null {
  return (
    (sqlite
      .prepare<ReplayRow, []>(
        `SELECT request_digest, response_ciphertext, response_initialization_vector, expires_at
           FROM enrollment_idempotency WHERE idempotency_key = '${KEY}'`,
      )
      .get() as ReplayRow | undefined) ?? null
  );
}

function recordExists(sqlite: Database, id: string): boolean {
  const row = sqlite
    .prepare<{ enrollment_id: string }, [string]>(
      "SELECT enrollment_id FROM enrollment_records WHERE enrollment_id = ?",
    )
    .get(id);
  return row !== undefined && row !== null;
}

describe("the active-key abort rolls back the product effect with the replay row", () => {
  test("PLANTED: a colliding second write commits neither its effect nor a mutated replay row", async () => {
    const sqlite = database();
    const store = new D1EnrollmentStore(localD1(sqlite));

    // First caller completes: effect and encrypted replay row in one batch.
    expect(await store.create(record("ASIMP-EN-FIRST"), undefined, write(DIGEST_A, "first"))).toBe(
      true,
    );
    expect(recordExists(sqlite, "ASIMP-EN-FIRST")).toBe(true);
    const before = replayRow(sqlite);
    expect(before?.request_digest).toBe(DIGEST_A);
    expect(before?.response_ciphertext).toBe("ciphertext-first");

    // A concurrent second caller reached the effect stage under the same live key
    // with a different request. This is the window the abort exists to close: it
    // passed the service's pre-check because the row did not exist yet.
    let refused = false;
    try {
      await store.create(record("ASIMP-EN-SECOND"), undefined, write(DIGEST_B, "second"));
    } catch {
      refused = true;
    }

    expect(refused).toBe(true);
    // The second caller's product effect is gone with its replay attempt.
    expect(recordExists(sqlite, "ASIMP-EN-SECOND")).toBe(false);
    // The first caller's stored result is byte-for-byte what it was.
    expect(replayRow(sqlite)).toEqual(before);
    // Exactly one replay row, and exactly one enrollment record.
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_idempotency").get()
        ?.n,
    ).toBe(1);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_records").get()?.n,
    ).toBe(1);
  });

  test("PLANTED: with the NOT NULL relaxed, the same collision succeeds and destroys the row", async () => {
    // This is why the constraint is load-bearing rather than hygiene. If the real
    // migration is ever relaxed, the case above stops refusing and starts
    // behaving like this one: the first caller's result is replaced by another
    // request's, under the first caller's key.
    const sqlite = database({ nullableDigest: true });
    const store = new D1EnrollmentStore(localD1(sqlite));

    expect(await store.create(record("ASIMP-EN-FIRST"), undefined, write(DIGEST_A, "first"))).toBe(
      true,
    );
    expect(
      await store.create(record("ASIMP-EN-SECOND"), undefined, write(DIGEST_B, "second")),
    ).toBe(true);

    const after = replayRow(sqlite);
    expect(after?.request_digest).toBeNull();
    expect(after?.response_ciphertext).toBe("ciphertext-second");
    expect(recordExists(sqlite, "ASIMP-EN-SECOND")).toBe(true);
  });

  test("an expired replay row is reclaimable by a new completed operation", async () => {
    const sqlite = database();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const stale = NOW - 48 * 60 * 60 * 1_000;

    expect(
      await store.create(record("ASIMP-EN-STALE"), undefined, write(DIGEST_A, "stale", stale)),
    ).toBe(true);
    expect(replayRow(sqlite)?.expires_at).toBeLessThan(NOW);

    expect(await store.create(record("ASIMP-EN-FRESH"), undefined, write(DIGEST_B, "fresh"))).toBe(
      true,
    );
    const reclaimed = replayRow(sqlite);
    expect(reclaimed?.request_digest).toBe(DIGEST_B);
    expect(reclaimed?.response_ciphertext).toBe("ciphertext-fresh");
    expect(reclaimed?.expires_at).toBeGreaterThan(NOW);
    expect(recordExists(sqlite, "ASIMP-EN-FRESH")).toBe(true);
  });

  test("an effect that changes nothing writes no replay row, so the key is not poisoned", async () => {
    const sqlite = database();
    const store = new D1EnrollmentStore(localD1(sqlite));

    // `replacesEnrollmentId` names a record that does not exist, so the guarded
    // UPDATE matches nothing, the chained INSERT is skipped by `changes() = 1`,
    // and the replay row must be skipped with it.
    let refused = false;
    try {
      await store.create(record("ASIMP-EN-NOOP"), "ASIMP-EN-ABSENT", write(DIGEST_A, "noop"));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(recordExists(sqlite, "ASIMP-EN-NOOP")).toBe(false);
    expect(replayRow(sqlite)).toBeNull();

    // The key is still free: a later completed operation claims it normally.
    expect(await store.create(record("ASIMP-EN-AFTER"), undefined, write(DIGEST_A, "after"))).toBe(
      true,
    );
    expect(replayRow(sqlite)?.response_ciphertext).toBe("ciphertext-after");
  });

  test("a digest mismatch on a live key is a conflict, and the reader never sees a NULL digest", async () => {
    const sqlite = database();
    const store = new D1EnrollmentStore(localD1(sqlite));
    expect(await store.create(record("ASIMP-EN-FIRST"), undefined, write(DIGEST_A, "first"))).toBe(
      true,
    );

    // Same key, different request: the sequential path refuses before any effect.
    let code: string | undefined;
    try {
      await store.idempotencyReplay({
        scope: "mint",
        principalScope: "usr_fixture_sponsor",
        key: KEY,
        digest: DIGEST_B,
        now: NOW,
      });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("IDEMPOTENCY_CONFLICT");

    // And the identical request replays, carrying the ciphertext untouched.
    const replay = await store.idempotencyReplay({
      scope: "mint",
      principalScope: "usr_fixture_sponsor",
      key: KEY,
      digest: DIGEST_A,
      now: NOW,
    });
    expect(replay?.encryptedResponse.ciphertext).toBe("ciphertext-first");
  });
});
