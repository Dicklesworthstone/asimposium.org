import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";

import { D1EnrollmentStore } from "../../src/enrollment/d1-store";
import {
  type DeviceCreateInput,
  type EnrollmentError,
  EnrollmentPersistenceError,
  type EnrollmentRecord,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service";

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
const LIFECYCLE_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0006_fellow_credential_lifecycle.sql",
);
const DEVICE_MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0009_device_flow.sql");

/** The exact column definition the abort depends on. */
const LOAD_BEARING_COLUMN = "request_digest TEXT NOT NULL";

type LocalBinding = string | number | null;

/**
 * A D1 shim over `bun:sqlite`. `batch` is the part that matters: one
 * transaction, sequential statements, rollback on any error, error rethrown.
 */
function localD1(
  sqlite: Database,
  options: {
    readonly afterFirstRead?: (query: string) => Promise<void>;
    readonly serializeBatches?: boolean;
  } = {},
): D1Database {
  const prepare = (query: string) => ({
    bind(...values: LocalBinding[]) {
      return {
        async run() {
          const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
          return { meta: { changes: result.changes } };
        },
        async first<T>(): Promise<T | null> {
          const row = (sqlite.prepare<T, LocalBinding[]>(query).get(...values) ?? null) as T | null;
          await options.afterFirstRead?.(query);
          return row;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[] };
        },
      };
    },
  });
  const runBatch = async (
    statements: readonly { run(): Promise<{ meta: { changes: number } }> }[],
  ) => {
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
  };
  let batchTail: Promise<void> = Promise.resolve();
  return {
    prepare,
    batch(statements: readonly { run(): Promise<{ meta: { changes: number } }> }[]) {
      if (options.serializeBatches !== true) return runBatch(statements);
      const result = batchTail.then(
        () => runBatch(statements),
        () => runBatch(statements),
      );
      batchTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
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
  sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
  return sqlite;
}

function deviceDatabase(): Database {
  const sqlite = database();
  sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
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

function deviceInput(suffix: string): DeviceCreateInput {
  return {
    record: {
      enrollmentId: `ASIMP-EN-DEVICE-${suffix}`,
      sponsorId: "",
      secretHash: `device-secret-${suffix}`,
      createdAt: NOW,
      secretExpiresAt: NOW,
      requestedScopes: ["review"],
      requestedResources: {},
      kind: "device",
      invalidated: false,
    },
    proposal: {
      proposalId: `proposal-device-${suffix}`,
      fellowId: `fellow-device-${suffix}`,
      flowHandleHash: `flow-device-${suffix}`,
      name: `device-${suffix.toLowerCase()}`,
      model: "test-model",
      harness: "codex",
      createdAt: NOW,
      expiresAt: NOW + 24 * 60 * 60_000,
      status: "pending",
      pollIntervalSeconds: 5,
    },
    userCodeHash: `user-code-${suffix}`,
    deviceExpiresAt: NOW + 30 * 60_000,
  };
}

function isUnboundDeviceProposalQuery(query: string): boolean {
  return (
    query.includes("JOIN enrollment_proposals p") &&
    query.includes("e.sponsor_id = ''") &&
    query.includes("e.kind = 'device'")
  );
}

describe("device enrollment first-decider SQL", () => {
  test.each(["approve", "deny"] as const)(
    "a stale pending pre-read cannot partially bind a sponsor before %s",
    async (decision) => {
      const sqlite = deviceDatabase();
      let invalidatedPreRead = false;
      const store = new D1EnrollmentStore(
        localD1(sqlite, {
          afterFirstRead: async (query) => {
            if (invalidatedPreRead || !isUnboundDeviceProposalQuery(query)) {
              return;
            }
            invalidatedPreRead = true;
            sqlite
              .prepare(
                "UPDATE enrollment_proposals SET status = 'expired' WHERE status = 'pending'",
              )
              .run();
          },
        }),
      );
      const input = deviceInput(`stale-${decision}`);
      await store.deviceCreate(input);

      await expect(
        store.decision({
          enrollmentId: input.record.enrollmentId,
          sponsorId: "usr_stale_pre_read",
          decision: { enrollment_id: input.record.enrollmentId, decision },
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "PROPOSAL_NOT_PENDING" } satisfies Partial<EnrollmentError>);

      const state = sqlite
        .prepare<{ sponsor_id: string; status: string }, [string]>(`SELECT e.sponsor_id, p.status
             FROM enrollment_records e
             JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
            WHERE e.enrollment_id = ?`)
        .get(input.record.enrollmentId);
      expect(invalidatedPreRead).toBe(true);
      expect(state).toEqual({ sponsor_id: "", status: "expired" });
      expect(
        sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_fellows").get()?.n,
      ).toBe(0);
      expect(
        sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
      ).toBe(0);
    },
  );

  test.each([
    ["approve", "approve"],
    ["deny", "approve"],
  ] as const)(
    "two pre-read sponsors racing %s/%s commit exactly one verdict",
    async (left, right) => {
      const sqlite = deviceDatabase();
      let arrivals = 0;
      let releaseBarrier: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const store = new D1EnrollmentStore(
        localD1(sqlite, {
          serializeBatches: true,
          afterFirstRead: async (query) => {
            if (!isUnboundDeviceProposalQuery(query)) return;
            arrivals += 1;
            if (arrivals === 2) releaseBarrier?.();
            await barrier;
          },
        }),
      );
      const input = deviceInput(`${left}-${right}`);
      await store.deviceCreate(input);

      const decisions = [left, right] as const;
      const sponsors = ["usr_device_left", "usr_device_right"] as const;
      const outcomes = await Promise.allSettled(
        decisions.map((decision, index) =>
          store.decision({
            enrollmentId: input.record.enrollmentId,
            sponsorId: sponsors[index] as string,
            decision: { enrollment_id: input.record.enrollmentId, decision },
            now: NOW,
          }),
        ),
      );

      const winner = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
      const loser = outcomes.findIndex((outcome) => outcome.status === "rejected");
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(loser).toBeGreaterThanOrEqual(0);
      expect((outcomes[loser] as PromiseRejectedResult).reason).toMatchObject({
        code: "PROPOSAL_NOT_PENDING",
      } satisfies Partial<EnrollmentError>);

      const recordRow = sqlite
        .prepare<{ sponsor_id: string }, [string]>(
          "SELECT sponsor_id FROM enrollment_records WHERE enrollment_id = ?",
        )
        .get(input.record.enrollmentId);
      expect(recordRow?.sponsor_id).toBe(sponsors[winner]);
      const expectedBindings = decisions[winner] === "deny" ? 0 : 1;
      expect(
        sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_fellows").get()?.n,
      ).toBe(expectedBindings);
      expect(
        sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
      ).toBe(expectedBindings);
      expect(
        sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_idempotency").get()
          ?.n,
      ).toBe(0);
    },
  );
});

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

const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const LIFECYCLE_SPONSOR = "usr_lifecycle_sponsor";
const LIFECYCLE_FELLOW = "fellow-lifecycle";
const LIFECYCLE_PROPOSAL = "proposal-lifecycle";

function seedLifecycleIdentity(sqlite: Database): void {
  sqlite
    .prepare(
      `INSERT INTO enrollment_records (
         enrollment_id, sponsor_id, secret_hash, secret_expires_at,
         requested_scopes_json, requested_resources_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ASIMP-EN-LIFECYCLE",
      LIFECYCLE_SPONSOR,
      "lifecycle-secret-hash",
      NOW + 30 * 60_000,
      '["review"]',
      "{}",
      NOW,
    );
  sqlite
    .prepare(
      `INSERT INTO enrollment_proposals (
         proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
         created_at, expires_at, status, granted_scopes_json, granted_resources_json,
         token_hash, token_issued_at, poll_interval_seconds
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, 5)`,
    )
    .run(
      LIFECYCLE_PROPOSAL,
      "ASIMP-EN-LIFECYCLE",
      LIFECYCLE_FELLOW,
      "lifecycle-flow-hash",
      "lifecycle-fellow",
      "test-model",
      "codex",
      NOW,
      NOW + 30 * 60_000,
      '["review"]',
      "{}",
      "token-hash-1",
      NOW,
    );
  sqlite
    .prepare(
      `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(LIFECYCLE_FELLOW, LIFECYCLE_SPONSOR, "lifecycle-fellow", "test-model", "codex", NOW);
  sqlite
    .prepare(
      `INSERT INTO enrollment_grants (
         proposal_id, fellow_id, sponsor_id, granted_scopes_json,
         granted_resources_json, granted_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(LIFECYCLE_PROPOSAL, LIFECYCLE_FELLOW, LIFECYCLE_SPONSOR, '["review"]', "{}", NOW);
}

function insertLifecycleCredential(
  sqlite: Database,
  input: {
    readonly id: string;
    readonly hash: string;
    readonly issuedAt: number;
    readonly proposalId?: string;
    readonly sponsorId?: string;
    readonly scopesJson?: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO fellow_tokens (
         credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
         granted_scopes_json, granted_resources_json, issued_at, expires_at,
         credential_profile, credential_origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bearer', ?)`,
    )
    .run(
      input.id,
      input.proposalId ?? null,
      LIFECYCLE_FELLOW,
      input.sponsorId ?? LIFECYCLE_SPONSOR,
      input.hash,
      input.scopesJson ?? '["review"]',
      "{}",
      input.issuedAt,
      input.issuedAt + TOKEN_TTL_MS,
      input.proposalId === undefined ? "harness-migration" : "enrollment",
    );
}

describe("Fellow credential lifecycle constraints and authentication", () => {
  test("0006 preserves the original credential, permits migration tokens, and enforces the active cap", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(sqlite);
    sqlite
      .prepare(
        `INSERT INTO enrollment_credentials (
           credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
           granted_scopes_json, granted_resources_json, issued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "credential-1",
        LIFECYCLE_PROPOSAL,
        LIFECYCLE_FELLOW,
        LIFECYCLE_SPONSOR,
        "token-hash-1",
        '["review"]',
        "{}",
        NOW,
      );

    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    const migrated = sqlite
      .prepare<{ expires_at: number; credential_profile: string; proposal_id: string | null }, []>(
        `SELECT expires_at, credential_profile, proposal_id
           FROM fellow_tokens WHERE credential_id = 'credential-1'`,
      )
      .get();
    expect(migrated).toEqual({
      expires_at: NOW + TOKEN_TTL_MS,
      credential_profile: "bearer",
      proposal_id: LIFECYCLE_PROPOSAL,
    });
    expect(() =>
      sqlite.prepare("UPDATE enrollment_credentials SET issued_at = issued_at + 1").run(),
    ).toThrow("legacy enrollment credential table is frozen");
    expect(() => sqlite.prepare("DELETE FROM enrollment_credentials").run()).toThrow(
      "legacy enrollment credential table is frozen",
    );
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO enrollment_credentials (
             credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
             granted_scopes_json, granted_resources_json, issued_at
           ) SELECT 'legacy-write', proposal_id, fellow_id, sponsor_id,
                    'legacy-write-hash', granted_scopes_json,
                    granted_resources_json, issued_at
               FROM enrollment_credentials LIMIT 1`,
        )
        .run(),
    ).toThrow("legacy enrollment credential table is frozen");

    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-duplicate-origin",
        hash: "token-hash-duplicate-origin",
        issuedAt: NOW + 1,
        proposalId: LIFECYCLE_PROPOSAL,
      }),
    ).toThrow();
    insertLifecycleCredential(sqlite, {
      id: "credential-2",
      hash: "token-hash-2",
      issuedAt: NOW + 1,
    });
    insertLifecycleCredential(sqlite, {
      id: "credential-3",
      hash: "token-hash-3",
      issuedAt: NOW + 2,
    });
    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-4",
        hash: "token-hash-4",
        issuedAt: NOW + 3,
      }),
    ).toThrow("active credential cap reached");
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(3);
  });

  test("identity splices and a backwards sponsor panic are refused by the database", () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-cross-sponsor",
        hash: "token-hash-cross-sponsor",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
        sponsorId: "usr_attacker",
      }),
    ).toThrow("credential authority binding mismatch");
    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-null-origin-cross-sponsor",
        hash: "token-hash-null-origin-cross-sponsor",
        issuedAt: NOW,
        sponsorId: "usr_attacker",
      }),
    ).toThrow("credential authority binding mismatch");
    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-escalated-grant",
        hash: "token-hash-escalated-grant",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
        scopesJson: '["promote"]',
      }),
    ).toThrow("credential authority binding mismatch");

    sqlite
      .prepare(
        `INSERT INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(LIFECYCLE_SPONSOR, NOW + 10, NOW + 10);
    expect(() =>
      sqlite
        .prepare(
          `UPDATE enrollment_sponsor_security SET panic_at = ?, updated_at = ?
            WHERE sponsor_id = ?`,
        )
        .run(NOW + 9, NOW + 11, LIFECYCLE_SPONSOR),
    ).toThrow("sponsor panic boundary is monotonic");
    expect(() =>
      sqlite
        .prepare("DELETE FROM enrollment_sponsor_security WHERE sponsor_id = ?")
        .run(LIFECYCLE_SPONSOR),
    ).toThrow("sponsor panic boundary cannot be deleted");
    expect(() =>
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(LIFECYCLE_SPONSOR, NOW + 9, NOW + 12),
    ).toThrow("sponsor panic boundary already exists");
  });

  test("credential authority and revocation are immutable while last-used evidence is monotonic", () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-1",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });

    expect(() =>
      sqlite
        .prepare("UPDATE fellow_tokens SET issued_at = ? WHERE credential_id = ?")
        .run(NOW + 1, "credential-1"),
    ).toThrow("credential authority is immutable");
    expect(() =>
      sqlite
        .prepare("UPDATE fellow_tokens SET granted_scopes_json = ? WHERE credential_id = ?")
        .run('["promote"]', "credential-1"),
    ).toThrow("credential authority is immutable");
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_grants SET granted_scopes_json = ? WHERE fellow_id = ?")
        .run('["promote"]', LIFECYCLE_FELLOW),
    ).toThrow("enrollment grant is immutable");
    expect(() =>
      sqlite.prepare("DELETE FROM enrollment_grants WHERE fellow_id = ?").run(LIFECYCLE_FELLOW),
    ).toThrow("enrollment grant cannot be deleted");
    expect(() =>
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO enrollment_grants (
             proposal_id, fellow_id, sponsor_id, granted_scopes_json,
             granted_resources_json, granted_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(LIFECYCLE_PROPOSAL, LIFECYCLE_FELLOW, LIFECYCLE_SPONSOR, '["promote"]', "{}", NOW),
    ).toThrow("enrollment grant already exists");
    expect(() =>
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO fellow_tokens (
             credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
             granted_scopes_json, granted_resources_json, issued_at, expires_at,
             credential_profile, credential_origin
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bearer', 'enrollment')`,
        )
        .run(
          "credential-1",
          LIFECYCLE_PROPOSAL,
          LIFECYCLE_FELLOW,
          LIFECYCLE_SPONSOR,
          "token-hash-replaced",
          '["review"]',
          "{}",
          NOW + 1,
          NOW + TOKEN_TTL_MS,
        ),
    ).toThrow("credential identity already exists");

    sqlite
      .prepare("UPDATE fellow_tokens SET last_used_at = ? WHERE credential_id = ?")
      .run(NOW + 5, "credential-1");
    expect(() =>
      sqlite
        .prepare("UPDATE fellow_tokens SET last_used_at = ? WHERE credential_id = ?")
        .run(NOW + 4, "credential-1"),
    ).toThrow("credential last-used time is monotonic");

    sqlite
      .prepare("UPDATE fellow_tokens SET revoked_at = ? WHERE credential_id = ?")
      .run(NOW + 6, "credential-1");
    expect(() =>
      sqlite
        .prepare("UPDATE fellow_tokens SET revoked_at = NULL WHERE credential_id = ?")
        .run("credential-1"),
    ).toThrow("credential revocation is monotonic");
    expect(() =>
      sqlite.prepare("DELETE FROM fellow_tokens WHERE credential_id = ?").run("credential-1"),
    ).toThrow("credential history cannot be deleted");
  });

  test("successful authentication alone stamps last_used and every lifecycle refusal is opaque", async () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-1",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    const store = new D1EnrollmentStore(localD1(sqlite));

    const authenticated = await store.authenticateCredential("token-hash-1", NOW + 1);
    expect(authenticated?.lastUsedAt).toBe(NOW + 1);
    expect(authenticated?.fellowStatus).toBe("active");
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, []>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-1'",
        )
        .get()?.last_used_at,
    ).toBe(NOW + 1);
    expect(await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 1)).toMatchObject([
      {
        fellowId: LIFECYCLE_FELLOW,
        status: "active",
        credentials: [{ credentialId: "credential-1", lastUsedAt: NOW + 1, active: true }],
      },
    ]);

    expect(await store.authenticateCredential("token-hash-1", NOW + TOKEN_TTL_MS)).toBeUndefined();
    expect(
      (await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + TOKEN_TTL_MS))[0]?.credentials,
    ).toEqual([]);
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, []>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-1'",
        )
        .get()?.last_used_at,
    ).toBe(NOW + 1);

    for (const status of ["paused", "revoked", "archived", "compromised"] as const) {
      sqlite
        .prepare("UPDATE enrollment_fellows SET status = ? WHERE fellow_id = ?")
        .run(status, LIFECYCLE_FELLOW);
      expect(await store.authenticateCredential("token-hash-1", NOW + 2)).toBeUndefined();
      expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 2))[0]).toMatchObject({
        status,
        credentials: [{ credentialId: "credential-1", active: false }],
      });
    }
    sqlite
      .prepare("UPDATE enrollment_fellows SET status = 'suspicious_review' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);
    expect((await store.authenticateCredential("token-hash-1", NOW + 3))?.fellowStatus).toBe(
      "suspicious_review",
    );
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 3))[0]).toMatchObject({
      status: "suspicious_review",
      credentials: [{ credentialId: "credential-1", active: true }],
    });
    expect((await store.authenticateCredential("token-hash-1", NOW + 2))?.lastUsedAt).toBe(NOW + 3);

    sqlite
      .prepare("UPDATE enrollment_fellows SET status = 'active' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);
    sqlite
      .prepare(
        `INSERT INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    expect(await store.authenticateCredential("token-hash-1", NOW + 4)).toBeUndefined();
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 4))[0]?.credentials).toEqual([]);

    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, []>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-1'",
        )
        .get()?.last_used_at,
    ).toBe(NOW + 3);
  });

  test("a future-issued credential is inactive until its issuance boundary", async () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-future",
      hash: "token-hash-future",
      issuedAt: NOW + 1_000,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    const store = new D1EnrollmentStore(localD1(sqlite));

    expect(await store.authenticateCredential("token-hash-future", NOW + 999)).toBeUndefined();
    expect((await store.authenticateCredential("token-hash-future", NOW + 1_000))?.lastUsedAt).toBe(
      NOW + 1_000,
    );
  });
});

/**
 * Bounded exact name suggestions, proven against the real migration.
 *
 * The prior implementation issued one indexed point lookup per candidate, so a
 * stem whose low suffixes were occupied cost one D1 round trip per occupied
 * suffix — up to 9_998 sequential statements in a single request, repeatable
 * for free because the name path runs after `verifyClaimCredentials` reads the
 * join secret but before `claim` consumes it.
 *
 * The replacement is a single statement: a recursive CTE generates the suffix
 * series inside SQLite, left-joins each generated name against the NOCASE
 * unique index on `enrollment_fellows.name`, and returns the first free
 * candidates in numeric order. One query and five bound parameters, against
 * D1's 50-query and 100-parameter budgets, at any density.
 *
 * Three of the cases below are now structural rather than behavioural, and are
 * kept as regression locks: comparing generated text to stored text means
 * `-02`, `-foo` and `-2-alpha` are names that never equal a candidate, and
 * ordering on the generated integer cannot degrade to lexicographic order.
 *
 * The cases below are the regressions that would otherwise return silently.
 * The query-count case is the one that catches a correct-but-unbounded rewrite:
 * it asserts statements, not wall time.
 */
const NAME_COLLATION_COLUMN = "name TEXT NOT NULL COLLATE NOCASE UNIQUE";

function insertFellow(sqlite: Database, name: string, ordinal: number): void {
  sqlite
    .prepare<unknown, [string, string, string, string, string, number]>(
      `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`fellow-${ordinal}`, "usr_fixture_sponsor", name, "test-model", "codex", NOW);
}

function occupy(sqlite: Database, names: readonly string[]): void {
  names.forEach((name, index) => {
    insertFellow(sqlite, name, index);
  });
}

/** `localD1`, plus the exact SQL of every statement the store issues. */
function recordingD1(sqlite: Database): { db: D1Database; issued: readonly string[] } {
  const base = localD1(sqlite) as unknown as { prepare(query: string): unknown };
  const issued: string[] = [];
  const db = {
    prepare(query: string) {
      issued.push(query);
      return base.prepare(query);
    },
  } as unknown as D1Database;
  return { db, issued };
}

describe("availabilitySuggestions is bounded, exact and deterministic", () => {
  test("the NOCASE unique index this join depends on is still declared", () => {
    // The join states `COLLATE NOCASE` explicitly so it matches this index. If
    // the column's collation ever changes, the join silently stops agreeing
    // with the equality lookups elsewhere in the store — and, per the plan
    // assertion below, stops being an index probe at all.
    expect(readFileSync(MIGRATION, "utf8")).toContain(NAME_COLLATION_COLUMN);
  });

  test("PLANTED: the gap is numeric, not lexicographic", async () => {
    const sqlite = database();
    occupy(sqlite, ["orchid-2"]);
    // `orchid-10` sorts before `orchid-2` as text. Ordering the candidates as
    // text, rather than on the generated integer, would offer it first.
    expect(await new D1EnrollmentStore(localD1(sqlite)).availabilitySuggestions("orchid")).toEqual([
      "orchid-3",
      "orchid-4",
      "orchid-5",
    ]);
  });

  test("PLANTED: a non-numeric or deeper name in the namespace occupies nothing", async () => {
    const sqlite = database();
    occupy(sqlite, ["orchid-foo", "orchid-2-alpha"]);
    // Neither is equal to any generated candidate, so neither can occupy one.
    expect(await new D1EnrollmentStore(localD1(sqlite)).availabilitySuggestions("orchid")).toEqual([
      "orchid-2",
      "orchid-3",
      "orchid-4",
    ]);
  });

  test("PLANTED: a leading-zero spelling does not suppress the canonical name", async () => {
    const sqlite = database();
    occupy(sqlite, ["orchid-02"]);
    // `orchid-02` is a different name. Any implementation that recovered the
    // suffix from stored text instead of comparing against generated text
    // would read it as 2 and wrongly retire a free candidate.
    expect(await new D1EnrollmentStore(localD1(sqlite)).availabilitySuggestions("orchid")).toEqual([
      "orchid-2",
      "orchid-3",
      "orchid-4",
    ]);
  });

  test("PLANTED: a reserved candidate is skipped even though its stem is clean", async () => {
    const sqlite = database();
    occupy(sqlite, ["gpt-5-2", "gpt-5-3", "gpt-5-4", "gpt-5-5"]);
    // `gpt-5` passes the name policy but `gpt-5-6` is reserved, so the
    // per-candidate check must survive; hoisting it to the stem returns it.
    expect(await new D1EnrollmentStore(localD1(sqlite)).availabilitySuggestions("gpt-5")).toEqual([
      "gpt-5-7",
      "gpt-5-8",
      "gpt-5-9",
    ]);
  });

  test("PLANTED: a saturated range returns fewer suggestions, never an error", async () => {
    const sqlite = database();
    const stem = "zzz";
    occupy(
      sqlite,
      Array.from({ length: 9_997 }, (_, offset) => `${stem}-${offset + 2}`),
    );
    // 2..9_998 held; the suffix law stops at 9_999, so exactly one remains.
    expect(await new D1EnrollmentStore(localD1(sqlite)).availabilitySuggestions(stem)).toEqual([
      "zzz-9999",
    ]);
  });

  test("PLANTED: 500 occupied suffixes still cost exactly one statement", async () => {
    const sqlite = database();
    occupy(
      sqlite,
      Array.from({ length: 500 }, (_, offset) => `orchid-${offset + 2}`),
    );
    const recording = recordingD1(sqlite);
    const suggestions = await new D1EnrollmentStore(recording.db).availabilitySuggestions("orchid");
    expect(suggestions).toEqual(["orchid-502", "orchid-503", "orchid-504"]);
    // The point-lookup implementation issued 503 statements for this shape, and
    // a batched one would issue 8. D1 allows 50 per invocation.
    expect(recording.issued.length).toBe(1);
  });

  test("PLANTED: a namespace of >10k non-numeric siblings costs one statement and keeps early gaps", async () => {
    const sqlite = database();
    occupy(sqlite, [
      ...Array.from({ length: 10_400 }, (_, offset) => `orchid-tag${offset}`),
      "orchid-2",
      "orchid-4",
    ]);
    const recording = recordingD1(sqlite);
    const suggestions = await new D1EnrollmentStore(recording.db).availabilitySuggestions("orchid");
    // Siblings that are not canonical numeric candidates occupy nothing, so the
    // early gaps at 3, 5 and 6 survive a namespace with more siblings than the
    // whole suffix series, none of which is ever returned to the Worker.
    expect(suggestions).toEqual(["orchid-3", "orchid-5", "orchid-6"]);
    expect(recording.issued.length).toBe(1);
  });

  test("the generated-suffix join uses the name index rather than scanning fellows", async () => {
    const sqlite = database();
    occupy(sqlite, ["orchid-2"]);
    const recording = recordingD1(sqlite);
    await new D1EnrollmentStore(recording.db).availabilitySuggestions("orchid");
    const [issued] = recording.issued;
    expect(issued).toBeDefined();
    // Plan the statement the store actually issued, so this cannot drift from it.
    const plan = sqlite
      .prepare<{ detail: string }, [number, number, string, string, number]>(
        `EXPLAIN QUERY PLAN ${issued as string}`,
      )
      .all(2, 9_999, "orchid-", "orchid-", 11)
      .map((step) => step.detail)
      .join(" | ");
    expect(plan).toContain("enrollment_fellows");
    expect(plan).toMatch(/USING (COVERING )?INDEX/);
    // A bare `SCAN enrollment_fellows` would mean 9_998 full table scans.
    expect(plan).not.toContain("SCAN enrollment_fellows");
  });

  test("PLANTED: a failing D1 query becomes the typed refusal, carrying no driver text", async () => {
    const raw = "D1_ERROR: no such table: enrollment_fellows at /var/secret/path.sql";
    const failing = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                throw new Error(raw);
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    let caught: unknown;
    try {
      await new D1EnrollmentStore(failing).availabilitySuggestions("orchid");
    } catch (error) {
      caught = error;
    }
    // Typed, so the router answers 503 ENROLLMENT_UNAVAILABLE instead of
    // letting a raw driver Error reach the route boundary.
    expect(caught).toBeInstanceOf(EnrollmentPersistenceError);
    // And the driver's text — table names, paths — never rides along.
    const surface = `${(caught as Error).message} ${(caught as Error).stack ?? ""}`;
    expect(surface).not.toContain("D1_ERROR");
    expect(surface).not.toContain("no such table");
    expect(surface).not.toContain("/var/secret/path.sql");
    expect((caught as Error).message).toBe("enrollment persistence is unavailable");
  });

  test("PLANTED: the policy invariant's typed refusal survives the query wrap", async () => {
    // A full page whose every row fails the name policy. The query itself
    // succeeds, so this refusal can only come from the post-query invariant —
    // which proves that branch fires and that placing the try/catch around the
    // query alone did not swallow or re-wrap it.
    let queried = false;
    const fullPageOfReservedNames = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                queried = true;
                return { results: Array.from({ length: 11 }, () => ({ name: "admin" })) };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    let caught: unknown;
    try {
      await new D1EnrollmentStore(fullPageOfReservedNames).availabilitySuggestions("orchid");
    } catch (error) {
      caught = error;
    }
    expect(queried).toBe(true);
    expect(caught).toBeInstanceOf(EnrollmentPersistenceError);
    // Never two suggestions passed off as a saturated range.
    expect(caught).toBeDefined();
  });

  test("PLANTED: the in-memory and D1 stores agree on stem policy and order", async () => {
    const sqlite = database();
    const d1 = new D1EnrollmentStore(localD1(sqlite));
    const memory = new InMemoryEnrollmentStore();
    for (const input of [
      "orchid",
      "gpt-5",
      "GPT-5",
      "!!!",
      "",
      "  spaced  name  ",
      "a",
      "x".repeat(40),
      "trailing---",
    ]) {
      expect(await d1.availabilitySuggestions(input)).toEqual(
        await memory.availabilitySuggestions(input),
      );
    }
  });
});
