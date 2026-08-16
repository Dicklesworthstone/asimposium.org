import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PENDING_PROPOSAL_TTL_MS } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

import { D1EnrollmentStore } from "../../src/enrollment/d1-store";
import {
  AesGcmEnrollmentReplayProtector,
  DEVICE_CODE_TTL_MS,
  DEVICE_LOOKUP_LOCKOUT_FAILURES,
  DEVICE_LOOKUP_LOCKOUT_WINDOW_MS,
  DEVICE_START_RATE_LIMIT_ATTEMPTS,
  DEVICE_START_RATE_LIMIT_WINDOW_MS,
  type DeviceCreateInput,
  type DeviceLookupAttempt,
  type EnrollmentError,
  EnrollmentIdempotencyRaceError,
  EnrollmentIdentifierCollisionError,
  EnrollmentPersistenceError,
  type EnrollmentRecord,
  EnrollmentService,
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
const CREDENTIAL_HARDENING_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0011_fellow_credential_hardening.sql",
);
const DEVICE_MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0009_device_flow.sql");
const DEVICE_HARDENING_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0010_device_flow_hardening.sql",
);

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
          const statement = sqlite.prepare<unknown, LocalBinding[]>(query);
          if (/^\s*SELECT\b/i.test(query)) {
            return { results: statement.all(...values), meta: { changes: 0 } };
          }
          const result = statement.run(...values);
          return { results: [], meta: { changes: result.changes } };
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
    statements: readonly {
      run(): Promise<{ readonly results?: readonly unknown[]; readonly meta: { changes: number } }>;
    }[],
  ) => {
    sqlite.run("BEGIN");
    try {
      const results: {
        readonly results?: readonly unknown[];
        readonly meta: { changes: number };
      }[] = [];
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
    batch(
      statements: readonly {
        run(): Promise<{
          readonly results?: readonly unknown[];
          readonly meta: { changes: number };
        }>;
      }[],
    ) {
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

function lifecycleDatabase(options: { readonly nullableDigest?: boolean } = {}): Database {
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

function database(options: { readonly nullableDigest?: boolean } = {}): Database {
  const sqlite = lifecycleDatabase(options);
  sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
  const deviceHardening = readFileSync(DEVICE_HARDENING_MIGRATION, "utf8");
  sqlite.exec(
    options.nullableDigest === true
      ? deviceHardening.replace("request_digest TEXT NOT NULL", "request_digest TEXT")
      : deviceHardening,
  );
  sqlite.exec(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8"));
  return sqlite;
}

function deviceDatabase(): Database {
  return database();
}

const NOW = 1_786_000_000_000;

function fixtureDigest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function fixtureEnrollmentId(label: string): string {
  if (/^ASIMP-EN-[A-HJKMNP-TV-Z0-9]{10,32}$/.test(label)) return label;
  return `ASIMP-EN-${fixtureDigest(label).slice(0, 16).toUpperCase()}`;
}

class DeviceTestClock {
  value = NOW;

  now(): number {
    return this.value;
  }
}

function d1DeviceServiceFixture(): {
  readonly clock: DeviceTestClock;
  readonly service: EnrollmentService;
  readonly sqlite: Database;
} {
  const clock = new DeviceTestClock();
  const sqlite = deviceDatabase();
  return {
    clock,
    sqlite,
    service: new EnrollmentService({
      clock,
      store: new D1EnrollmentStore(localD1(sqlite)),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    }),
  };
}

function record(id: string): EnrollmentRecord {
  const enrollmentId = fixtureEnrollmentId(id);
  return {
    enrollmentId,
    sponsorId: "usr_fixture_sponsor",
    secretHash: fixtureDigest(`record-secret:${id}`),
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

function deviceInput(suffix: string, at = NOW): DeviceCreateInput {
  let digestState = 2_166_136_261;
  for (const byte of new TextEncoder().encode(suffix)) {
    digestState ^= byte;
    digestState = Math.imul(digestState, 16_777_619) >>> 0;
  }
  const userCodeHash = digestState.toString(16).padStart(8, "0").repeat(8);
  return {
    record: {
      enrollmentId: fixtureEnrollmentId(`device:${suffix}`),
      sponsorId: "",
      secretHash: fixtureDigest(`device-secret:${suffix}`),
      createdAt: at,
      secretExpiresAt: at,
      requestedScopes: ["review"],
      requestedResources: {},
      kind: "device",
      deviceExpiresAt: at + DEVICE_CODE_TTL_MS,
      invalidated: false,
    },
    proposal: {
      proposalId: `proposal-device-${suffix}`,
      fellowId: `fellow-device-${suffix}`,
      flowHandleHash: `flow-device-${suffix}`,
      // Keep every generated fixture inside the public Fellow-name contract;
      // long descriptive test suffixes are identifiers for humans, not names.
      name: `device-${digestState.toString(16).padStart(8, "0")}`,
      model: "test-model",
      harness: "codex",
      createdAt: at,
      expiresAt: at + 24 * 60 * 60_000,
      status: "pending",
      pollIntervalSeconds: 5,
    },
    userCodeHash,
    deviceExpiresAt: at + DEVICE_CODE_TTL_MS,
    clientBucket: "b".repeat(64),
    startWindowBeginning: at - DEVICE_START_RATE_LIMIT_WINDOW_MS,
    startLimit: DEVICE_START_RATE_LIMIT_ATTEMPTS,
    reclaimBatchSize: 100,
  };
}

function deviceLookupAttempt(
  sponsorId: string,
  userCodeHash: string,
  now = NOW,
): DeviceLookupAttempt {
  return {
    sponsorId,
    userCodeHash,
    now,
    windowBeginning: now - DEVICE_LOOKUP_LOCKOUT_WINDOW_MS,
    failureLimit: DEVICE_LOOKUP_LOCKOUT_FAILURES,
    reclaimBatchSize: 100,
  };
}

function isUnboundDeviceProposalQuery(query: string): boolean {
  return (
    query.includes("JOIN enrollment_proposals p") &&
    query.includes("e.sponsor_id = ''") &&
    query.includes("e.kind = 'device'")
  );
}

function expectHardeningMigrationGuardRollback(sqlite: Database): void {
  const migration = readFileSync(DEVICE_HARDENING_MIGRATION, "utf8");
  const guardCreateStart = migration.indexOf("CREATE TABLE device_flow_migration_guard");
  const guardInsertStart = migration.indexOf("INSERT INTO device_flow_migration_guard");
  const guardDropStart = migration.indexOf("DROP TABLE device_flow_migration_guard");
  expect(guardCreateStart).toBeGreaterThan(0);
  expect(guardInsertStart).toBeGreaterThan(guardCreateStart);
  expect(guardDropStart).toBeGreaterThan(guardInsertStart);

  let guardFailed = false;
  sqlite.run("BEGIN");
  try {
    sqlite.exec(migration.slice(0, guardCreateStart));
    sqlite.run(migration.slice(guardCreateStart, guardInsertStart));
    try {
      sqlite.prepare(migration.slice(guardInsertStart, guardDropStart)).run();
    } catch {
      guardFailed = true;
    }
  } finally {
    sqlite.run("ROLLBACK");
  }

  expect(guardFailed).toBe(true);
  const columns = sqlite
    .prepare<{ name: string }, []>("PRAGMA table_info(enrollment_records)")
    .all()
    .map((column) => column.name);
  expect(columns).not.toContain("device_expires_at");
  expect(
    sqlite
      .prepare<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'device_start_attempts'",
      )
      .get()?.n,
  ).toBe(0);
}

describe("device enrollment first-decider SQL", () => {
  test("0010 backfills a populated valid 0009 triple and installs its invariants", () => {
    const sqlite = lifecycleDatabase();
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    const enrollmentId = "ASIMP-EN-DEVICE-legacy-valid";
    const proposalId = "proposal-device-legacy-valid";
    const deviceExpiresAt = NOW + DEVICE_CODE_TTL_MS;
    sqlite
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, invalidated, created_at, kind
         ) VALUES (?, '', ?, ?, '["review"]', '{}', 0, ?, 'device')`,
      )
      .run(enrollmentId, "legacy-valid-secret", NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO enrollment_proposals (
           proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
           created_at, expires_at, status, poll_interval_seconds
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 5)`,
      )
      .run(
        proposalId,
        enrollmentId,
        "fellow-device-legacy-valid",
        "flow-device-legacy-valid",
        "legacy-valid",
        "test-model",
        "codex",
        NOW,
        NOW + 24 * 60 * 60_000,
      );
    sqlite
      .prepare(
        "INSERT INTO device_codes (enrollment_id, user_code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(enrollmentId, "a".repeat(64), NOW, deviceExpiresAt);
    sqlite
      .prepare(
        `INSERT INTO enrollment_idempotency (
           scope, principal_scope, idempotency_key, request_digest,
           response_ciphertext, response_initialization_vector, expires_at
         ) VALUES ('mint', 'usr_legacy', 'legacy-replay', ?, 'ciphertext', 'iv', ?)`,
      )
      .run("c".repeat(64), NOW + 1);

    sqlite.run("BEGIN");
    sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
    sqlite.run("COMMIT");

    expect(
      sqlite
        .prepare<
          { device_expires_at: number | null; device_mapping_reclaimed_at: number | null },
          [string]
        >(
          "SELECT device_expires_at, device_mapping_reclaimed_at FROM enrollment_records WHERE enrollment_id = ?",
        )
        .get(enrollmentId),
    ).toEqual({ device_expires_at: deviceExpiresAt, device_mapping_reclaimed_at: null });
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_records SET device_expires_at = ? WHERE enrollment_id = ?")
        .run(deviceExpiresAt + 1, enrollmentId),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_records SET created_at = ? WHERE enrollment_id = ?")
        .run(NOW + 1, enrollmentId),
    ).toThrow("DEVICE_RECORD_CREATED_AT_IMMUTABLE");
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_proposals SET expires_at = ? WHERE proposal_id = ?")
        .run(NOW + 24 * 60 * 60_000 + 1, proposalId),
    ).toThrow("DEVICE_PROPOSAL_EXPIRY_IMMUTABLE");
    expect(() =>
      sqlite
        .prepare(
          "UPDATE enrollment_records SET kind = 'join-url', device_expires_at = NULL WHERE enrollment_id = ?",
        )
        .run(enrollmentId),
    ).toThrow();
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_proposals WHERE proposal_id = ? AND status = 'pending'",
        )
        .get(proposalId)?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ request_digest: string }, []>(
          "SELECT request_digest FROM enrollment_idempotency WHERE idempotency_key = 'legacy-replay'",
        )
        .get()?.request_digest,
    ).toBe("c".repeat(64));
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO enrollment_idempotency (
             scope, principal_scope, idempotency_key, request_digest,
             response_ciphertext, response_initialization_vector, expires_at
           ) VALUES ('device-start', 'source:test', 'device-replay', ?, 'ciphertext', 'iv', ?)`,
        )
        .run("d".repeat(64), NOW + 1),
    ).not.toThrow();
    const indexColumns = (indexName: string): string[] =>
      sqlite
        .prepare<{ name: string }, [string]>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(indexName)
        .map((column) => column.name);
    expect(indexColumns("device_lookup_attempts_sponsor_time")).toEqual([
      "sponsor_id",
      "attempted_at",
    ]);
    expect(indexColumns("device_lookup_attempts_time")).toEqual(["attempted_at", "id"]);
    expect(indexColumns("device_codes_expiry")).toEqual(["expires_at", "enrollment_id"]);
    const queryPlan = (statement: string, ...parameters: (string | number)[]): string =>
      sqlite
        .prepare<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${statement}`)
        .all(...parameters)
        .map((step) => step.detail)
        .join("\n");
    expect(
      queryPlan(
        `SELECT id FROM device_lookup_attempts
          WHERE attempted_at < ? ORDER BY attempted_at, id LIMIT ?`,
        NOW,
        100,
      ),
    ).toContain("device_lookup_attempts_time");
    expect(
      queryPlan(
        `SELECT COUNT(*) FROM device_lookup_attempts
          WHERE sponsor_id = ? AND success = 0
            AND attempted_at >= ? AND attempted_at <= ?`,
        "usr_index_proof",
        NOW - DEVICE_LOOKUP_LOCKOUT_WINDOW_MS,
        NOW,
      ),
    ).toContain("device_lookup_attempts_sponsor_time");
    expect(
      queryPlan(
        `SELECT d.enrollment_id
           FROM device_codes d
           JOIN enrollment_records e ON e.enrollment_id = d.enrollment_id
          WHERE d.expires_at <= ? AND e.device_mapping_reclaimed_at IS NULL
          ORDER BY d.expires_at, d.enrollment_id LIMIT ?`,
        NOW,
        100,
      ),
    ).toContain("device_codes_expiry");
  });

  test("0010 migration refuses a pre-existing device record without its proposal/code triple", () => {
    const sqlite = lifecycleDatabase();
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, invalidated, created_at, kind
         ) VALUES (?, '', ?, ?, '[]', '{}', 0, ?, 'device')`,
      )
      .run("ASIMP-EN-DEVICE-legacy-impossible", "legacy-impossible-secret", NOW, NOW);

    expectHardeningMigrationGuardRollback(sqlite);
  });

  test("0010 migration refuses a pre-existing enrollment kind outside its closed vocabulary", () => {
    const sqlite = lifecycleDatabase();
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite.prepare("UPDATE enrollment_records SET kind = 'legacy-unknown'").run();
    sqlite
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, invalidated, created_at, kind
         ) VALUES (?, ?, ?, ?, '[]', '{}', 0, ?, 'legacy-unknown')`,
      )
      .run("ASIMP-EN-legacy-kind", "usr_legacy_kind", "legacy-kind-secret", NOW, NOW);

    expectHardeningMigrationGuardRollback(sqlite);
  });

  test("device polling expires at thirty minutes without rewriting the 24-hour proposal", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const input = deviceInput("poll-expiry");
    let tokenFactoryCalls = 0;
    const createToken = async () => {
      tokenFactoryCalls += 1;
      throw new Error("expired device polling reached the token factory");
    };
    await store.deviceCreate(input);

    await expect(
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: input.deviceExpiresAt - 1,
        createToken,
      }),
    ).resolves.toEqual({ kind: "pending", retryAfterSeconds: 5 });
    await expect(
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: input.deviceExpiresAt,
        createToken,
      }),
    ).resolves.toEqual({ kind: "expired" });

    expect(tokenFactoryCalls).toBe(0);
    expect(
      sqlite
        .prepare<{ expires_at: number; status: string }, [string]>(
          "SELECT expires_at, status FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(input.proposal.proposalId),
    ).toEqual({ expires_at: input.proposal.expiresAt, status: "pending" });

    await expect(
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: input.proposal.expiresAt,
        createToken,
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(input.proposal.proposalId),
    ).toEqual({ status: "expired" });
  });

  test("D1 polling first at the requested grant boundary expires without a credential", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const base = deviceInput("pending-grant-poll");
    const input: DeviceCreateInput = {
      ...base,
      record: {
        ...base.record,
        requestedResources: { fellowGrantExpiresAt: NOW + 1 },
      },
    };
    let tokenFactoryCalls = 0;
    const createToken = async () => {
      tokenFactoryCalls += 1;
      return { token: "must-not-escape", tokenHash: "must-not-persist" };
    };
    await store.deviceCreate(input);

    await expect(
      store.poll({ flowHandleHash: input.proposal.flowHandleHash, now: NOW, createToken }),
    ).resolves.toEqual({ kind: "pending", retryAfterSeconds: 5 });
    await expect(
      store.poll({ flowHandleHash: input.proposal.flowHandleHash, now: NOW + 1, createToken }),
    ).resolves.toEqual({ kind: "expired" });

    expect(tokenFactoryCalls).toBe(0);
    expect(
      sqlite
        .prepare<{ status: string; token_hash: string | null }, [string]>(
          "SELECT status, token_hash FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(input.proposal.proposalId),
    ).toEqual({ status: "expired", token_hash: null });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(0);
  });

  test("D1 leaves one stable poll key free until approve, deny, or expiry is terminal", async () => {
    const { clock, service, sqlite } = d1DeviceServiceFixture();
    const sponsor = { type: "sponsor", sponsorId: "usr_stable_poll_d1" } as const;
    const terminalCount = (): number =>
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'poll'",
        )
        .get()?.n ?? -1;

    const approveStart = await service.deviceStart(
      {
        name: "d1-stable-poll-approve",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.61" },
    );
    const approveOptions = { idempotencyKey: "d1-stable-poll-approve-1" } as const;
    expect(
      (await service.poll({ flow_handle: approveStart.device_code }, approveOptions)).status,
    ).toBe("authorization_pending");
    expect(terminalCount()).toBe(0);
    const approveCard = await service.deviceLookup(sponsor, {
      user_code: approveStart.user_code,
    });
    await service.decide(sponsor, approveCard.enrollmentId, {
      enrollment_id: approveCard.enrollmentId,
      decision: "approve",
    });
    const approved = await service.poll({ flow_handle: approveStart.device_code }, approveOptions);
    expect(approved.status).toBe("approved");
    expect(await service.poll({ flow_handle: approveStart.device_code }, approveOptions)).toEqual(
      approved,
    );
    expect(terminalCount()).toBe(1);

    const denyStart = await service.deviceStart(
      {
        name: "d1-stable-poll-deny",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.62" },
    );
    const denyOptions = { idempotencyKey: "d1-stable-poll-deny-1" } as const;
    expect((await service.poll({ flow_handle: denyStart.device_code }, denyOptions)).status).toBe(
      "authorization_pending",
    );
    expect(terminalCount()).toBe(1);
    const denyCard = await service.deviceLookup(sponsor, { user_code: denyStart.user_code });
    await service.decide(sponsor, denyCard.enrollmentId, {
      enrollment_id: denyCard.enrollmentId,
      decision: "deny",
    });
    expect(await service.poll({ flow_handle: denyStart.device_code }, denyOptions)).toEqual({
      status: "access_denied",
    });
    expect(terminalCount()).toBe(2);

    const expireStart = await service.deviceStart(
      {
        name: "d1-stable-poll-expire",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.63" },
    );
    const expireOptions = { idempotencyKey: "d1-stable-poll-expire-1" } as const;
    expect(
      (await service.poll({ flow_handle: expireStart.device_code }, expireOptions)).status,
    ).toBe("authorization_pending");
    expect(terminalCount()).toBe(2);
    clock.value += DEVICE_CODE_TTL_MS;
    expect(await service.poll({ flow_handle: expireStart.device_code }, expireOptions)).toEqual({
      status: "expired_token",
    });
    expect(terminalCount()).toBe(2);
    expect(await service.poll({ flow_handle: expireStart.device_code }, expireOptions)).toEqual({
      status: "expired_token",
    });
    expect(terminalCount()).toBe(2);

    clock.value += PENDING_PROPOSAL_TTL_MS - DEVICE_CODE_TTL_MS;
    expect(await service.poll({ flow_handle: expireStart.device_code }, expireOptions)).toEqual({
      status: "expired_token",
    });
    expect(terminalCount()).toBe(3);
    expect(
      sqlite
        .prepare<{ status: string }, []>(
          "SELECT status FROM enrollment_proposals WHERE name = 'd1-stable-poll-expire'",
        )
        .get(),
    ).toEqual({ status: "expired" });
  });

  test("D1 same-key terminal polls recover after both replay preflights miss", async () => {
    const clock = new DeviceTestClock();
    const sqlite = deviceDatabase();
    let preflightReaders = 0;
    let releasePreflights: (() => void) | undefined;
    const bothPreflightsRead = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    const db = localD1(sqlite, {
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!query.includes("FROM enrollment_idempotency")) return;
        preflightReaders += 1;
        if (preflightReaders === 2) releasePreflights?.();
        await bothPreflightsRead;
      },
    });
    const service = new EnrollmentService({
      clock,
      store: new D1EnrollmentStore(db),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const sponsor = { type: "sponsor", sponsorId: "usr_poll_race_d1" } as const;
    const started = await service.deviceStart(
      {
        name: "d1-poll-race-replay",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.64" },
    );
    const card = await service.deviceLookup(sponsor, { user_code: started.user_code });
    await service.decide(sponsor, card.enrollmentId, {
      enrollment_id: card.enrollmentId,
      decision: "approve",
    });
    const options = { idempotencyKey: "d1-poll-race-replay-1" } as const;
    const results = await Promise.all([
      service.poll({ flow_handle: started.device_code }, options),
      service.poll({ flow_handle: started.device_code }, options),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.status).toBe("approved");
    expect(preflightReaders).toBeGreaterThanOrEqual(3);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'poll'",
        )
        .get()?.n,
    ).toBe(1);
  });

  test("versioned poll replay ignores raw-key legacy transients and recovers a raw-key issued token", async () => {
    const clock = new DeviceTestClock();
    const sqlite = deviceDatabase();
    const replayRoot = new Uint8Array(32);
    const protector = new AesGcmEnrollmentReplayProtector(replayRoot);
    const predecessorReplayKey = await crypto.subtle.importKey(
      "raw",
      replayRoot.slice().buffer,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    let predecessorIv = 0;
    const service = new EnrollmentService({
      clock,
      store: new D1EnrollmentStore(localD1(sqlite)),
      replayProtector: protector,
    });
    const sponsor = { type: "sponsor", sponsorId: "usr_legacy_poll_replay_d1" } as const;
    const insertLegacyReplay = async (
      flowHandle: string,
      key: string,
      replayResponse: unknown,
    ): Promise<void> => {
      const flowHash = createHash("sha256").update(flowHandle).digest("hex");
      const digest = createHash("sha256")
        .update(JSON.stringify({ flow_handle: flowHandle }))
        .digest("hex");
      const initializationVector = new Uint8Array(12);
      predecessorIv += 1;
      initializationVector[initializationVector.length - 1] = predecessorIv;
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: initializationVector.slice().buffer },
        predecessorReplayKey,
        new TextEncoder().encode(JSON.stringify(replayResponse)).buffer,
      );
      const encrypted = {
        ciphertext: Buffer.from(ciphertext).toString("base64url"),
        initializationVector: Buffer.from(initializationVector).toString("base64url"),
      };
      sqlite
        .prepare(
          `INSERT INTO enrollment_idempotency (
             scope, principal_scope, idempotency_key, request_digest,
             response_ciphertext, response_initialization_vector, expires_at
           ) VALUES ('poll', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `flow:${flowHash}`,
          key,
          digest,
          encrypted.ciphertext,
          encrypted.initializationVector,
          clock.value + 24 * 60 * 60_000,
        );
    };

    const pendingStart = await service.deviceStart(
      {
        name: "legacy-pending-replay",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.65" },
    );
    const pendingKey = "legacy-pending-replay-1";
    const pending = await service.poll(
      { flow_handle: pendingStart.device_code },
      { idempotencyKey: pendingKey },
    );
    expect(pending.status).toBe("authorization_pending");
    await insertLegacyReplay(pendingStart.device_code, pendingKey, pending);
    const pendingCard = await service.deviceLookup(sponsor, {
      user_code: pendingStart.user_code,
    });
    await service.decide(sponsor, pendingCard.enrollmentId, {
      enrollment_id: pendingCard.enrollmentId,
      decision: "deny",
    });
    expect(
      await service.poll({ flow_handle: pendingStart.device_code }, { idempotencyKey: pendingKey }),
    ).toEqual({ status: "access_denied" });

    const issuedStart = await service.deviceStart(
      {
        name: "legacy-issued-replay",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.66" },
    );
    const issuedCard = await service.deviceLookup(sponsor, { user_code: issuedStart.user_code });
    await service.decide(sponsor, issuedCard.enrollmentId, {
      enrollment_id: issuedCard.enrollmentId,
      decision: "approve",
    });
    const issued = await service.poll({ flow_handle: issuedStart.device_code });
    expect(issued.status).toBe("approved");
    const issuedKey = "legacy-issued-replay-1";
    await insertLegacyReplay(issuedStart.device_code, issuedKey, issued);
    expect(
      await service.poll({ flow_handle: issuedStart.device_code }, { idempotencyKey: issuedKey }),
    ).toEqual(issued);

    const principalScopes = sqlite
      .prepare<{ principal_scope: string }, []>(
        "SELECT principal_scope FROM enrollment_idempotency WHERE scope = 'poll' ORDER BY principal_scope",
      )
      .all()
      .map((row) => row.principal_scope);
    expect(principalScopes.filter((scope) => scope.startsWith("flow:"))).toHaveLength(2);
    expect(principalScopes.filter((scope) => scope.startsWith("flow-terminal-v1:"))).toHaveLength(
      1,
    );
  });

  test("a device proposal whose code mapping disappeared fails closed", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const input = deviceInput("missing-code-row");
    await store.deviceCreate(input);
    sqlite
      .prepare("DELETE FROM device_codes WHERE enrollment_id = ?")
      .run(input.record.enrollmentId);

    await expect(
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: NOW,
        createToken: async () => {
          throw new Error("a missing device mapping reached the token factory");
        },
      }),
    ).rejects.toMatchObject({ code: "FLOW_INVALID" } satisfies Partial<EnrollmentError>);
  });

  test("concurrent D1 lookup failures admit exactly five rows and atomically lock the sixth", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite, { serializeBatches: true }));
    const input = deviceInput("atomic-lookup");
    await store.deviceCreate(input);
    const sponsorId = "usr_atomic_lookup";
    const unknownHash = "f".repeat(64);
    const outcomes = await Promise.allSettled(
      Array.from({ length: DEVICE_LOOKUP_LOCKOUT_FAILURES + 1 }, () =>
        store.deviceLookup(deviceLookupAttempt(sponsorId, unknownHash)),
      ),
    );
    const codes = outcomes
      .map((outcome) =>
        outcome.status === "rejected" &&
        typeof outcome.reason === "object" &&
        outcome.reason !== null &&
        "code" in outcome.reason
          ? String(outcome.reason.code)
          : "UNEXPECTED_SUCCESS",
      )
      .sort();
    expect(codes).toEqual([
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_LOOKUP_LOCKED",
    ]);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM device_lookup_attempts WHERE sponsor_id = ? AND success = 0",
        )
        .get(sponsorId)?.n,
    ).toBe(DEVICE_LOOKUP_LOCKOUT_FAILURES);
    await expect(
      store.deviceLookup(deviceLookupAttempt(sponsorId, input.userCodeHash)),
    ).rejects.toMatchObject({ code: "DEVICE_LOOKUP_LOCKED" });

    const reopenedAt = NOW + DEVICE_LOOKUP_LOCKOUT_WINDOW_MS + 1;
    await expect(
      store.deviceLookup(deviceLookupAttempt(sponsorId, input.userCodeHash, reopenedAt)),
    ).resolves.toMatchObject({ name: input.proposal.name });
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM device_lookup_attempts WHERE sponsor_id = ? AND success = 0",
        )
        .get(sponsorId)?.n,
    ).toBe(0);
  });

  test("repeated successful D1 lookups create no rate-table rows", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const input = deviceInput("successful-lookup-no-write");
    await store.deviceCreate(input);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await expect(
        store.deviceLookup(deviceLookupAttempt("usr_success_lookup", input.userCodeHash)),
      ).resolves.toMatchObject({ proposalId: input.proposal.proposalId });
    }

    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_lookup_attempts").get()
        ?.n,
    ).toBe(0);
  });

  test("D1 source throttling is transactional, isolated, and reopens after its window", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const bucket = "b".repeat(64);
    for (let index = 0; index < DEVICE_START_RATE_LIMIT_ATTEMPTS; index += 1) {
      await store.deviceCreate({ ...deviceInput(`rate-${index}`), clientBucket: bucket });
    }
    await expect(
      store.deviceCreate({ ...deviceInput("rate-refused"), clientBucket: bucket }),
    ).rejects.toMatchObject({ code: "DEVICE_START_RATE_LIMITED" });
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM device_start_attempts WHERE client_bucket = ?",
        )
        .get(bucket)?.n,
    ).toBe(DEVICE_START_RATE_LIMIT_ATTEMPTS);
    expect(recordExists(sqlite, deviceInput("rate-refused").record.enrollmentId)).toBe(false);

    await expect(
      store.deviceCreate({ ...deviceInput("other-source"), clientBucket: "c".repeat(64) }),
    ).resolves.toBeUndefined();
    const reopenedAt = NOW + DEVICE_START_RATE_LIMIT_WINDOW_MS + 1;
    await expect(
      store.deviceCreate({
        ...deviceInput("rate-reopened", reopenedAt),
        clientBucket: bucket,
      }),
    ).resolves.toBeUndefined();
  });

  test("D1 identifier collisions are typed and consume no source slot", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const first = deviceInput("typed-identifier-collision-first");
    const collision = {
      ...deviceInput("typed-identifier-collision-second"),
      userCodeHash: first.userCodeHash,
    };
    await store.deviceCreate(first);

    await expect(store.deviceCreate(collision)).rejects.toBeInstanceOf(
      EnrollmentIdentifierCollisionError,
    );

    expect(recordExists(sqlite, collision.record.enrollmentId)).toBe(false);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_start_attempts").get()?.n,
    ).toBe(1);
  });

  test("device-start idempotency conflicts roll back both the product and rate reservation", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const first = deviceInput("device-idempotency-first");
    const conflicting = deviceInput("device-idempotency-conflict");
    await store.deviceCreate(first, deviceWrite(DIGEST_A, "device-first"));
    const before = replayRow(sqlite);

    await expect(
      store.deviceCreate(conflicting, deviceWrite(DIGEST_B, "device-conflict")),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<EnrollmentError>);

    expect(recordExists(sqlite, first.record.enrollmentId)).toBe(true);
    expect(recordExists(sqlite, conflicting.record.enrollmentId)).toBe(false);
    expect(replayRow(sqlite)).toEqual(before);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_start_attempts").get()?.n,
    ).toBe(1);
  });

  test("same-key replay wins over the source limit when another caller fills slot ten", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    for (let index = 0; index < DEVICE_START_RATE_LIMIT_ATTEMPTS - 1; index += 1) {
      await store.deviceCreate(deviceInput(`replay-edge-fill-${index}`));
    }
    const winner = deviceInput("replay-edge-winner");
    const loser = deviceInput("replay-edge-loser");
    await store.deviceCreate(winner, deviceWrite(DIGEST_A, "edge-winner"));

    await expect(
      store.deviceCreate(loser, deviceWrite(DIGEST_A, "edge-loser")),
    ).rejects.toBeInstanceOf(EnrollmentIdempotencyRaceError);

    expect(recordExists(sqlite, winner.record.enrollmentId)).toBe(true);
    expect(recordExists(sqlite, loser.record.enrollmentId)).toBe(false);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_start_attempts").get()?.n,
    ).toBe(DEVICE_START_RATE_LIMIT_ATTEMPTS);
  });

  test("stale start-attempt reclamation is capped per transaction", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const staleAt = NOW - DEVICE_START_RATE_LIMIT_WINDOW_MS - 1;
    const insert = sqlite.prepare(
      "INSERT INTO device_start_attempts (client_bucket, attempted_at) VALUES (?, ?)",
    );
    for (let index = 0; index < 125; index += 1) {
      insert.run(index.toString(16).padStart(64, "0"), staleAt);
    }

    await store.deviceCreate(deviceInput("bounded-start-reclaim"));

    expect(
      sqlite
        .prepare<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM device_start_attempts WHERE attempted_at = ?",
        )
        .get(staleAt)?.n,
    ).toBe(25);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_start_attempts").get()?.n,
    ).toBe(26);
  });

  test("authorized mapping cleanup retains the live proposal and a durable expired poll verdict", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const input = deviceInput("reclaimed-mapping");
    await store.deviceCreate(input);
    const cleanupAt = input.deviceExpiresAt;
    await store.deviceCreate({
      ...deviceInput("cleanup-trigger", cleanupAt),
      clientBucket: "d".repeat(64),
    });

    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM device_codes WHERE enrollment_id = ?",
        )
        .get(input.record.enrollmentId)?.n,
    ).toBe(0);
    expect(
      sqlite
        .prepare<
          { device_mapping_reclaimed_at: number | null; device_expires_at: number | null },
          [string]
        >(
          `SELECT device_mapping_reclaimed_at, device_expires_at
             FROM enrollment_records WHERE enrollment_id = ?`,
        )
        .get(input.record.enrollmentId),
    ).toEqual({
      device_mapping_reclaimed_at: cleanupAt,
      device_expires_at: input.deviceExpiresAt,
    });
    expect(() =>
      sqlite
        .prepare(
          "UPDATE enrollment_records SET device_mapping_reclaimed_at = NULL WHERE enrollment_id = ?",
        )
        .run(input.record.enrollmentId),
    ).toThrow("DEVICE_MAPPING_RECLAMATION_IMMUTABLE");
    expect(() =>
      sqlite
        .prepare(
          "UPDATE enrollment_records SET device_mapping_reclaimed_at = ? WHERE enrollment_id = ?",
        )
        .run(cleanupAt + 1, input.record.enrollmentId),
    ).toThrow("DEVICE_MAPPING_RECLAMATION_IMMUTABLE");
    expect(
      sqlite
        .prepare<{ status: string; expires_at: number }, [string]>(
          "SELECT status, expires_at FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(input.proposal.proposalId),
    ).toEqual({ status: "pending", expires_at: input.proposal.expiresAt });
    await expect(
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: cleanupAt,
        createToken: async () => {
          throw new Error("reclaimed expired mapping reached the token factory");
        },
      }),
    ).resolves.toEqual({ kind: "expired" });
  });

  test("0010 rejects impossible device triples and rolls back the source reservation", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const input = deviceInput("impossible-expiry");
    await expect(
      store.deviceCreate({
        ...input,
        proposal: { ...input.proposal, expiresAt: input.deviceExpiresAt - 1 },
      }),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(recordExists(sqlite, input.record.enrollmentId)).toBe(false);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_start_attempts").get()?.n,
    ).toBe(0);
    expect(() =>
      sqlite
        .prepare("INSERT INTO device_start_attempts (client_bucket, attempted_at) VALUES (?, ?)")
        .run("198.51.100.8", NOW),
    ).toThrow();
  });

  test("persisted device-card corruption is operational, not a policy refusal", async () => {
    // Keep this runtime-defense fixture on the immediately preceding schema;
    // 0011 now prevents the corrupt UPDATE mechanically.
    const sqlite = lifecycleDatabase();
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
    const store = new D1EnrollmentStore(localD1(sqlite));
    const input = deviceInput("corrupt-card");
    await store.deviceCreate(input);
    sqlite
      .prepare("UPDATE enrollment_records SET requested_scopes_json = '[]' WHERE enrollment_id = ?")
      .run(input.record.enrollmentId);

    await expect(
      store.deviceApprovalCardForDecision(input.record.enrollmentId, NOW),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
  });

  test("D1 device lookup hides and expires a card at its requested grant boundary", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const base = deviceInput("expired-requested-grant");
    const input = {
      ...base,
      record: {
        ...base.record,
        requestedResources: { fellowGrantExpiresAt: NOW + 1 },
      },
    };
    await store.deviceCreate(input);

    await expect(
      store.deviceLookup(
        deviceLookupAttempt("usr_expired_requested_grant", input.userCodeHash, NOW + 1),
      ),
    ).rejects.toMatchObject({ code: "DEVICE_CODE_UNKNOWN" } satisfies Partial<EnrollmentError>);
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(input.proposal.proposalId),
    ).toEqual({ status: "expired" });
    await expect(
      store.deviceApprovalCardForDecision(input.record.enrollmentId, NOW + 1),
    ).resolves.toMatchObject({ status: "expired" });
  });

  test("a stale loaded card cannot bind a sponsor after its device code expires", async () => {
    const sqlite = deviceDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const input = deviceInput("stale-card");
    await store.deviceCreate(input);

    await expect(
      store.decision({
        enrollmentId: input.record.enrollmentId,
        sponsorId: "usr_stale_card",
        decision: { enrollment_id: input.record.enrollmentId, decision: "approve" },
        now: input.deviceExpiresAt,
      }),
    ).rejects.toMatchObject({ code: "PAIRING_INVALID" } satisfies Partial<EnrollmentError>);

    expect(
      sqlite
        .prepare<{ sponsor_id: string; status: string }, [string]>(
          `SELECT e.sponsor_id, p.status
             FROM enrollment_records e
             JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
            WHERE e.enrollment_id = ?`,
        )
        .get(input.record.enrollmentId),
    ).toEqual({ sponsor_id: "", status: "pending" });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_fellows").get()?.n,
    ).toBe(0);
  });

  test.each([1, 2])(
    "D1 refuses approval at or after the Fellow grant boundary at offset %i",
    async (elapsedMs) => {
      const sqlite = deviceDatabase();
      const store = new D1EnrollmentStore(localD1(sqlite));
      const base = deviceInput(`dead-grant-${elapsedMs}`);
      const input = {
        record: {
          ...record(base.record.enrollmentId),
          requestedResources: { fellowGrantExpiresAt: NOW + 1 },
        },
        proposal: base.proposal,
      };
      expect(await store.create(input.record)).toBe(true);
      await store.claim({
        enrollmentId: input.record.enrollmentId,
        secretHash: input.record.secretHash,
        proposal: input.proposal,
        now: NOW,
      });
      expect(await store.pendingApprovalCardsBySponsor("usr_fixture_sponsor", NOW)).toHaveLength(1);

      await expect(
        store.decision({
          enrollmentId: input.record.enrollmentId,
          sponsorId: "usr_fixture_sponsor",
          decision: { enrollment_id: input.record.enrollmentId, decision: "approve" },
          now: NOW + elapsedMs,
        }),
      ).rejects.toMatchObject({ code: "PROPOSAL_EXPIRED" } satisfies Partial<EnrollmentError>);
      expect(
        sqlite
          .prepare<{ sponsor_id: string; status: string }, [string]>(
            `SELECT e.sponsor_id, p.status
               FROM enrollment_records e
               JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
              WHERE e.enrollment_id = ?`,
          )
          .get(input.record.enrollmentId),
      ).toEqual({ sponsor_id: "usr_fixture_sponsor", status: "expired" });
      expect(
        sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
      ).toBe(0);
      expect(
        await store.pendingApprovalCardsBySponsor("usr_fixture_sponsor", NOW + elapsedMs),
      ).toEqual([]);
      await expect(
        store.decision({
          enrollmentId: input.record.enrollmentId,
          sponsorId: "usr_fixture_sponsor",
          decision: { enrollment_id: input.record.enrollmentId, decision: "approve" },
          now: NOW + elapsedMs,
        }),
      ).rejects.toMatchObject({ code: "PROPOSAL_EXPIRED" } satisfies Partial<EnrollmentError>);
    },
  );

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

function deviceWrite(digest: string, marker: string, now = NOW) {
  return {
    ...write(digest, marker, now),
    scope: "device-start" as const,
    principalScope: `source:${"b".repeat(64)}`,
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
    .get(fixtureEnrollmentId(id));
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
const LIFECYCLE_ENROLLMENT = fixtureEnrollmentId("lifecycle");
const LIFECYCLE_SECRET_HASH = fixtureDigest("lifecycle-secret");

function seedLifecycleIdentity(
  sqlite: Database,
  resourcesJson = "{}",
  scopesJson = '["review"]',
  grantedAt = NOW,
  proposalCreatedAt = NOW,
  proposalExpiresAt = NOW + PENDING_PROPOSAL_TTL_MS,
  requestedResourcesJson = resourcesJson,
  requestedScopesJson = scopesJson,
  withTokenFacts = true,
): void {
  sqlite
    .prepare(
      `INSERT INTO enrollment_records (
         enrollment_id, sponsor_id, secret_hash, secret_expires_at,
         requested_scopes_json, requested_resources_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      LIFECYCLE_ENROLLMENT,
      LIFECYCLE_SPONSOR,
      LIFECYCLE_SECRET_HASH,
      NOW + 30 * 60_000,
      requestedScopesJson,
      requestedResourcesJson,
      NOW,
    );
  sqlite
    .prepare(
      `INSERT INTO enrollment_proposals (
         proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
         created_at, expires_at, status, granted_scopes_json, granted_resources_json,
         token_hash, token_issued_at, poll_interval_seconds
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 5)`,
    )
    .run(
      LIFECYCLE_PROPOSAL,
      LIFECYCLE_ENROLLMENT,
      LIFECYCLE_FELLOW,
      "lifecycle-flow-hash",
      "lifecycle-fellow",
      "test-model",
      "codex",
      proposalCreatedAt,
      proposalExpiresAt,
    );
  sqlite
    .prepare(
      `UPDATE enrollment_proposals
          SET status = 'approved', granted_scopes_json = ?, granted_resources_json = ?
        WHERE proposal_id = ?`,
    )
    .run(scopesJson, resourcesJson, LIFECYCLE_PROPOSAL);
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
    .run(
      LIFECYCLE_PROPOSAL,
      LIFECYCLE_FELLOW,
      LIFECYCLE_SPONSOR,
      scopesJson,
      resourcesJson,
      grantedAt,
    );
  if (withTokenFacts) {
    sqlite
      .prepare(
        `UPDATE enrollment_proposals
            SET token_hash = ?, token_issued_at = ?
          WHERE proposal_id = ?`,
      )
      .run("token-hash-1", NOW, LIFECYCLE_PROPOSAL);
  }
}

function insertLifecycleCredential(
  sqlite: Database,
  input: {
    readonly id: string | null;
    readonly hash: string;
    readonly issuedAt: number;
    readonly proposalId?: string;
    readonly sponsorId?: string;
    readonly scopesJson?: string;
    readonly resourcesJson?: string;
    readonly profile?: "bearer" | "dpop" | "http-message-signature";
    readonly expiresAt?: number;
    readonly lastUsedAt?: number | null;
    readonly revokedAt?: number | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO fellow_tokens (
         credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
         granted_scopes_json, granted_resources_json, issued_at, expires_at,
         revoked_at, last_used_at, credential_profile, credential_origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.proposalId ?? null,
      LIFECYCLE_FELLOW,
      input.sponsorId ?? LIFECYCLE_SPONSOR,
      input.hash,
      input.scopesJson ?? '["review"]',
      input.resourcesJson ?? "{}",
      input.issuedAt,
      input.expiresAt ?? input.issuedAt + TOKEN_TTL_MS,
      input.revokedAt ?? null,
      input.lastUsedAt ?? null,
      input.profile ?? "bearer",
      input.proposalId === undefined ? "harness-migration" : "enrollment",
    );
}

function ensureDeviceSchema(sqlite: Database): void {
  const hasKind = sqlite
    .prepare<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM pragma_table_info('enrollment_records') WHERE name = 'kind'",
    )
    .get()?.n;
  if (hasKind === 1) return;
  sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
  sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
}

function expectCredentialHardeningGuardRollback(
  sqlite: Database,
  migration = readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8"),
): void {
  ensureDeviceSchema(sqlite);
  const guardInsert = "INSERT INTO fellow_credential_migration_guard (valid)";
  const guardInsertStart = migration.indexOf(guardInsert);
  const guardDropStart = migration.indexOf("DROP TABLE fellow_credential_migration_guard");
  expect(guardInsertStart).toBeGreaterThan(0);
  expect(guardDropStart).toBeGreaterThan(guardInsertStart);
  let guardFailed = false;
  let guardMessage = "";
  sqlite.run("BEGIN");
  try {
    sqlite.exec(migration.slice(0, guardInsertStart));
    const guardStatements = migration
      .slice(guardInsertStart, guardDropStart)
      .split(guardInsert)
      .slice(1)
      .map((suffix) => `${guardInsert}${suffix}`);
    // Keep the structural inventory explicit as well as exercising each guard.
    // A removed guard must fail even if another planted row would coincidentally
    // be rejected by a different invariant.
    expect(guardStatements.length).toBe(15);
    // Bun's multi-statement exec stops after the first zero-row INSERT for
    // this shape. Prepare each migration statement so every independent guard
    // is causally executed by the planted rollback proof.
    for (const statement of guardStatements) sqlite.prepare(statement).run();
  } catch (error) {
    guardFailed = true;
    guardMessage = error instanceof Error ? error.message : String(error);
  } finally {
    sqlite.run("ROLLBACK");
  }

  expect(guardFailed).toBe(true);
  expect(guardMessage).toContain("fellow_credential_hardening_guard");
  expect(
    sqlite
      .prepare<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM sqlite_master
          WHERE name IN (
            'fellow_credential_migration_guard',
            'enrollment_records_evidence_schema_insert',
            'enrollment_records_authority_schema_insert',
            'enrollment_proposals_evidence_schema_insert',
            'enrollment_proposals_identity_immutable',
            'enrollment_credentials_issuance_monotonic',
            'enrollment_fellows_status_transition',
            'enrollment_credentials_sponsor_fellow_lifecycle_idx'
          )`,
      )
      .get()?.n,
  ).toBe(0);
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

  test("0011 accepts valid 0006 state without rewriting credential evidence", async () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-valid-upgrade",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    const before = sqlite
      .prepare<Record<string, string | number | null>, []>(
        "SELECT * FROM fellow_tokens WHERE credential_id = 'credential-valid-upgrade'",
      )
      .get();

    ensureDeviceSchema(sqlite);
    sqlite.run("BEGIN");
    sqlite.exec(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8"));
    sqlite.run("COMMIT");

    expect(
      sqlite
        .prepare<Record<string, string | number | null>, []>(
          "SELECT * FROM fellow_tokens WHERE credential_id = 'credential-valid-upgrade'",
        )
        .get(),
    ).toEqual(before);
    const monotonicPlan = sqlite
      .prepare<{ detail: string }, [string, number]>(
        "EXPLAIN QUERY PLAN SELECT 1 FROM fellow_tokens WHERE fellow_id = ? AND issued_at > ?",
      )
      .all(LIFECYCLE_FELLOW, NOW)
      .map((row) => row.detail)
      .join("\n");
    expect(monotonicPlan).toContain("enrollment_credentials_fellow_issued_idx");
    const recording = recordingD1(sqlite);
    await new D1EnrollmentStore(recording.db).fellowsBySponsor(LIFECYCLE_SPONSOR, NOW);
    const [inventoryQuery] = recording.issued;
    expect(inventoryQuery).toBeDefined();
    const sponsorPlan = sqlite
      .prepare<{ detail: string }, LocalBinding[]>(`EXPLAIN QUERY PLAN ${inventoryQuery as string}`)
      .all(LIFECYCLE_SPONSOR, NOW, NOW, NOW)
      .map((row) => row.detail)
      .join("\n");
    expect(sponsorPlan).toContain("MATERIALIZE sponsor_fellow_page");
    expect(sponsorPlan).toContain("enrollment_grants_sponsor_page_idx");
    expect(sponsorPlan).toContain("enrollment_credentials_sponsor_fellow_lifecycle_idx");
    expect(sponsorPlan).not.toContain("SCAN grant_row");
  });

  test("0011 preserves an expired durable grant that never issued a credential", async () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    seedLifecycleIdentity(sqlite, `{"fellowGrantExpiresAt":${NOW + 1}}`);
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
    sqlite
      .prepare(
        `UPDATE enrollment_proposals
            SET token_hash = NULL, token_issued_at = NULL
          WHERE proposal_id = ?`,
      )
      .run(LIFECYCLE_PROPOSAL);
    expect(
      await new D1EnrollmentStore(localD1(sqlite)).poll({
        flowHandleHash: "lifecycle-flow-hash",
        now: NOW + 1,
        createToken: async () => {
          throw new Error("expired grant must not mint");
        },
      }),
    ).toEqual({ kind: "expired" });
    const grantBefore = sqlite
      .prepare<Record<string, string | number>, []>("SELECT * FROM enrollment_grants")
      .get();

    sqlite.run("BEGIN");
    sqlite.exec(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8"));
    sqlite.run("COMMIT");

    expect(
      sqlite.prepare<Record<string, string | number>, []>("SELECT * FROM enrollment_grants").get(),
    ).toEqual(grantBefore);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(0);
  });

  test("0011 refuses an expired proposal without an elapsed grant-expiry cause", () => {
    const cases = [
      { label: "missing expiry", resources: "{}" },
      {
        label: "future expiry",
        resources: JSON.stringify({ fellowGrantExpiresAt: Date.now() + 24 * 60 * 60 * 1_000 }),
      },
    ] as const;
    for (const fixture of cases) {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(sqlite, fixture.resources);
      sqlite
        .prepare(
          `UPDATE enrollment_proposals
              SET status = 'expired', token_hash = NULL, token_issued_at = NULL
            WHERE proposal_id = ?`,
        )
        .run(LIFECYCLE_PROPOSAL);
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));

      try {
        expectCredentialHardeningGuardRollback(sqlite);
      } catch (error) {
        throw new Error(`fixture failed: ${fixture.label}`, { cause: error });
      }
    }
  });

  test("0011 compares retained grant expiry at millisecond resolution", () => {
    const migration = readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8");
    const liveClock = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
    expect(migration.split(liveClock)).toHaveLength(2);
    const fixedInstant = "2026-08-15 14:00:00.500";
    const fixedNow = Date.parse(`${fixedInstant.replace(" ", "T")}Z`);
    const elapsedWithinSecond = fixedNow - 250;
    const fixedMigration = migration.replace(
      liveClock,
      `CAST(unixepoch('${fixedInstant}', 'subsec') * 1000 AS INTEGER)`,
    );
    const secondFloorMigration = migration.replace(
      liveClock,
      `unixepoch('${fixedInstant}') * 1000`,
    );

    const fixture = () => {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(
        sqlite,
        JSON.stringify({ fellowGrantExpiresAt: elapsedWithinSecond }),
        '["review"]',
        fixedNow - 1_000,
      );
      sqlite
        .prepare(
          `UPDATE enrollment_proposals
              SET created_at = ?, expires_at = ?, status = 'expired',
                  token_hash = NULL, token_issued_at = NULL
            WHERE proposal_id = ?`,
        )
        .run(fixedNow - 2_000, fixedNow - 2_000 + PENDING_PROPOSAL_TTL_MS, LIFECYCLE_PROPOSAL);
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      ensureDeviceSchema(sqlite);
      return sqlite;
    };

    const exact = fixture();
    exact.exec(fixedMigration);
    expect(
      exact
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(LIFECYCLE_PROPOSAL),
    ).toEqual({ status: "expired" });

    expectCredentialHardeningGuardRollback(fixture(), secondFloorMigration);
  });

  test("0011 rejects fractional proposal evidence before it can break sponsor cards", () => {
    const enrollmentId = fixtureEnrollmentId("proposal-evidence");
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    sqlite
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        enrollmentId,
        LIFECYCLE_SPONSOR,
        fixtureDigest("proposal-evidence-secret"),
        NOW + 30 * 60_000,
        '["review"]',
        "{}",
        NOW,
      );
    sqlite
      .prepare(
        `INSERT INTO enrollment_proposals (
           proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
           created_at, expires_at, status, poll_interval_seconds
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        "proposal-evidence",
        enrollmentId,
        "fellow-proposal-evidence",
        "proposal-evidence-flow",
        "proposal-evidence",
        "test-model",
        "codex",
        NOW + 0.5,
        NOW + 0.5 + PENDING_PROPOSAL_TTL_MS,
        5,
      );
    expect(
      sqlite
        .prepare<{ created_class: string; expires_class: string }, []>(
          `SELECT typeof(created_at) AS created_class,
                  typeof(expires_at) AS expires_class
             FROM enrollment_proposals`,
        )
        .get(),
    ).toEqual({ created_class: "real", expires_class: "real" });

    expectCredentialHardeningGuardRollback(sqlite);
  });

  test("0011 guards future proposal evidence while preserving legitimate poll updates", () => {
    const enrollmentId = fixtureEnrollmentId("proposal-trigger");
    const sqlite = database();
    sqlite
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        enrollmentId,
        LIFECYCLE_SPONSOR,
        fixtureDigest("proposal-trigger-secret"),
        NOW + 30 * 60_000,
        '["review"]',
        "{}",
        NOW,
      );
    const insert = sqlite.prepare(
      `INSERT INTO enrollment_proposals (
         proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
         created_at, expires_at, status, poll_interval_seconds, last_poll_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const fractionalCases = [
      {
        proposalId: "proposal-trigger-created-and-expires-real",
        createdAt: NOW + 0.5,
        expiresAt: NOW + 0.5 + PENDING_PROPOSAL_TTL_MS,
      },
    ];
    for (const fixture of fractionalCases) {
      expect(() =>
        insert.run(
          fixture.proposalId,
          enrollmentId,
          `fellow-${fixture.proposalId}`,
          `flow-${fixture.proposalId}`,
          "proposal-trigger-invalid",
          "test-model",
          "codex",
          fixture.createdAt,
          fixture.expiresAt,
          5,
          null,
        ),
      ).toThrow("proposal evidence schema invalid");
    }

    insert.run(
      "proposal-trigger-valid",
      enrollmentId,
      "fellow-proposal-trigger-valid",
      "proposal-trigger-flow-valid",
      "proposal-trigger-valid",
      "test-model",
      "codex",
      NOW,
      NOW + PENDING_PROPOSAL_TTL_MS,
      5,
      null,
    );
    expect(() =>
      sqlite
        .prepare(
          "UPDATE enrollment_proposals SET poll_interval_seconds = 5.5 WHERE proposal_id = ?",
        )
        .run("proposal-trigger-valid"),
    ).toThrow("proposal evidence schema invalid");
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_proposals SET last_poll_at = ? WHERE proposal_id = ?")
        .run(NOW + 0.5, "proposal-trigger-valid"),
    ).toThrow("proposal evidence schema invalid");
    expect(() =>
      sqlite
        .prepare(
          `UPDATE enrollment_proposals
              SET status = 'approved', granted_scopes_json = '["review"]',
                  granted_resources_json = '{}'
            WHERE proposal_id = ?`,
        )
        .run("proposal-trigger-valid"),
    ).not.toThrow();
    expect(() =>
      sqlite
        .prepare(
          "UPDATE enrollment_proposals SET token_hash = ?, token_issued_at = ? WHERE proposal_id = ?",
        )
        .run("fractional-token-hash", NOW + 0.5, "proposal-trigger-valid"),
    ).toThrow("proposal evidence schema invalid");
    expect(() =>
      sqlite
        .prepare(
          "UPDATE enrollment_proposals SET expires_at = expires_at + 1 WHERE proposal_id = ?",
        )
        .run("proposal-trigger-valid"),
    ).toThrow("proposal timing is immutable");
    expect(
      sqlite
        .prepare(
          `UPDATE enrollment_proposals
              SET poll_interval_seconds = ?, last_poll_at = ?
            WHERE proposal_id = ?`,
        )
        .run(10, NOW + 1, "proposal-trigger-valid").changes,
    ).toBe(1);
  });

  test("0011 refuses sponsor-card identity drift in retained and future proposals", () => {
    const retainedEnrollmentId = fixtureEnrollmentId("proposal-identity-retained");
    const retained = new Database(":memory:", { strict: true });
    retained.run(readFileSync(MIGRATION, "utf8"));
    retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    retained
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        retainedEnrollmentId,
        LIFECYCLE_SPONSOR,
        fixtureDigest("proposal-identity-secret"),
        NOW + PENDING_PROPOSAL_TTL_MS,
        '["review"]',
        "{}",
        NOW,
      );
    retained
      .prepare(
        `INSERT INTO enrollment_proposals (
           proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
           created_at, expires_at, status, poll_interval_seconds
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 5)`,
      )
      .run(
        "proposal-identity-retained",
        retainedEnrollmentId,
        "fellow-identity-retained",
        "flow-identity-retained",
        "identity-retained",
        "model\u0000suffix",
        "codex",
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
      );
    expectCredentialHardeningGuardRollback(retained);

    const futureEnrollmentId = fixtureEnrollmentId("proposal-identity-future");
    const future = database();
    future
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        futureEnrollmentId,
        LIFECYCLE_SPONSOR,
        fixtureDigest("proposal-future-secret"),
        NOW + 30 * 60_000,
        '["review"]',
        "{}",
        NOW,
      );
    const insert = future.prepare(
      `INSERT INTO enrollment_proposals (
         proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
         created_at, expires_at, status, poll_interval_seconds
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 5)`,
    );
    expect(() =>
      insert.run(
        "proposal-identity-future-bad",
        futureEnrollmentId,
        "fellow-identity-future-bad",
        "flow-identity-future-bad",
        "identity-future-bad",
        "model\u0000suffix",
        "codex",
        NOW,
        NOW + 30 * 60_000,
      ),
    ).toThrow("proposal evidence schema invalid");
    insert.run(
      "proposal-identity-future-valid",
      futureEnrollmentId,
      "fellow-identity-future-valid",
      "flow-identity-future-valid",
      "identity-future-valid",
      "test-model",
      "codex",
      NOW,
      NOW + PENDING_PROPOSAL_TTL_MS,
    );
    expect(() =>
      future
        .prepare("UPDATE enrollment_proposals SET model = ? WHERE proposal_id = ?")
        .run("changed-model", "proposal-identity-future-valid"),
    ).toThrow("proposal identity is immutable");
  });

  test("0011 refuses malformed requested authority in retained and future enrollment records", async () => {
    const corruptCases = [
      { label: "empty scopes", scopes: "[]", resources: "{}" },
      { label: "unknown scope", scopes: '["admin"]', resources: "{}" },
      { label: "duplicate scope", scopes: '["review","review"]', resources: "{}" },
      { label: "unknown resource", scopes: '["review"]', resources: '{"mystery":true}' },
      {
        label: "wrong budget type",
        scopes: '["review"]',
        resources: '{"eventBudget":"10"}',
      },
      {
        label: "unicode-trimmed empty directive",
        scopes: '["review"]',
        resources: JSON.stringify({ firstDirective: "\t\u00a0\ufeff" }),
      },
      {
        label: "grant expires at creation",
        scopes: '["review"]',
        resources: JSON.stringify({ fellowGrantExpiresAt: NOW }),
      },
      {
        label: "grant exceeds the one-year request ceiling",
        scopes: '["review"]',
        resources: JSON.stringify({ fellowGrantExpiresAt: NOW + 31_536_000_001 }),
      },
    ] as const;

    for (const fixture of corruptCases) {
      const retained = lifecycleDatabase();
      retained
        .prepare(
          `INSERT INTO enrollment_records (
             enrollment_id, sponsor_id, secret_hash, secret_expires_at,
             requested_scopes_json, requested_resources_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ASIMP-EN-ABCDEFGHJK",
          LIFECYCLE_SPONSOR,
          fixtureDigest("retained-record-secret"),
          NOW + 30 * 60_000,
          fixture.scopes,
          fixture.resources,
          NOW,
        );
      expectCredentialHardeningGuardRollback(retained);

      const future = database();
      expect(() =>
        future
          .prepare(
            `INSERT INTO enrollment_records (
               enrollment_id, sponsor_id, secret_hash, secret_expires_at,
               requested_scopes_json, requested_resources_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "ASIMP-EN-ABCDEFGHJK",
            LIFECYCLE_SPONSOR,
            fixtureDigest("future-record-secret"),
            NOW + 30 * 60_000,
            fixture.scopes,
            fixture.resources,
            NOW,
          ),
      ).toThrow("enrollment record authority schema invalid");
      expect(
        future.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_records").get()?.n,
      ).toBe(0);
    }

    const valid = database();
    const store = new D1EnrollmentStore(localD1(valid));
    expect(await store.create(record("ASIMP-EN-ABCDEFGHJK"))).toBe(true);
  });

  test("0011 refuses invalid record identities, hashes, and JSON storage classes", () => {
    const validId = "ASIMP-EN-ABCDEFGHJK";
    const validHash = fixtureDigest("record-shape-secret");
    const cases = [
      {
        label: "invalid enrollment id",
        enrollmentId: "bad-id",
        secretHash: validHash,
        scopes: '["review"]',
        resources: "{}",
        message: "enrollment record evidence schema invalid",
      },
      {
        label: "short secret hash",
        enrollmentId: validId,
        secretHash: "not-a-hash",
        scopes: '["review"]',
        resources: "{}",
        message: "enrollment record evidence schema invalid",
      },
      {
        label: "non-canonical sponsor",
        enrollmentId: validId,
        sponsorId: "sponsor-without-prefix",
        secretHash: validHash,
        scopes: '["review"]',
        resources: "{}",
        message: "enrollment record evidence schema invalid",
      },
      {
        label: "uppercase secret hash",
        enrollmentId: validId,
        secretHash: "A".repeat(64),
        scopes: '["review"]',
        resources: "{}",
        message: "enrollment record evidence schema invalid",
      },
      {
        label: "BLOB scopes",
        enrollmentId: validId,
        secretHash: validHash,
        scopes: Buffer.from('["review"]'),
        resources: "{}",
        message: "enrollment record authority schema invalid",
      },
      {
        label: "BLOB resources",
        enrollmentId: validId,
        secretHash: validHash,
        scopes: '["review"]',
        resources: Buffer.from("{}"),
        message: "enrollment record authority schema invalid",
      },
    ] as const;

    for (const fixture of cases) {
      const insert = (sqlite: Database) =>
        sqlite
          .prepare(
            `INSERT INTO enrollment_records (
               enrollment_id, sponsor_id, secret_hash, secret_expires_at,
               requested_scopes_json, requested_resources_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fixture.enrollmentId,
            "sponsorId" in fixture ? fixture.sponsorId : LIFECYCLE_SPONSOR,
            fixture.secretHash,
            NOW + 30 * 60_000,
            fixture.scopes,
            fixture.resources,
            NOW,
          );

      const retained = lifecycleDatabase();
      insert(retained);
      expectCredentialHardeningGuardRollback(retained);

      const future = database();
      expect(() => insert(future)).toThrow(fixture.message);
      expect(
        future.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_records").get()?.n,
      ).toBe(0);
    }
  });

  test("text and fractional record deadlines cannot survive upgrade or authorize a late claim", async () => {
    const secretHash = fixtureDigest("retained-record-secret");
    const retained = lifecycleDatabase();
    retained
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "ASIMP-EN-ABCDEFGHJK",
        LIFECYCLE_SPONSOR,
        secretHash,
        "forever",
        '["review"]',
        "{}",
        NOW,
      );

    ensureDeviceSchema(retained);
    const store = new D1EnrollmentStore(localD1(retained));
    await expect(
      store.verifyClaimCredentials("ASIMP-EN-ABCDEFGHJK", secretHash, Number.MAX_SAFE_INTEGER),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    await expect(
      store.claim({
        enrollmentId: "ASIMP-EN-ABCDEFGHJK",
        secretHash,
        now: Number.MAX_SAFE_INTEGER,
        proposal: {
          proposalId: "proposal-record-deadline",
          fellowId: "fellow-record-deadline",
          flowHandleHash: "flow-record-deadline",
          name: "deadline-fellow",
          model: "test-model",
          harness: "codex",
          createdAt: Number.MAX_SAFE_INTEGER,
          expiresAt: Number.MAX_SAFE_INTEGER,
          status: "pending",
          pollIntervalSeconds: 5,
        },
      }),
    ).rejects.toMatchObject({ code: "PAIRING_INVALID" });
    expect(
      retained
        .prepare<{ secret_consumed_at: number | null }, []>(
          "SELECT secret_consumed_at FROM enrollment_records",
        )
        .get()?.secret_consumed_at,
    ).toBeNull();
    expect(
      retained.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_proposals").get()
        ?.n,
    ).toBe(0);
    expectCredentialHardeningGuardRollback(retained);

    for (const deadline of ["forever", NOW + 30 * 60_000 + 0.5] as const) {
      const future = database();
      expect(() =>
        future
          .prepare(
            `INSERT INTO enrollment_records (
               enrollment_id, sponsor_id, secret_hash, secret_expires_at,
               requested_scopes_json, requested_resources_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "ASIMP-EN-ABCDEFGHJK",
            LIFECYCLE_SPONSOR,
            fixtureDigest("future-record-secret"),
            deadline,
            '["review"]',
            "{}",
            NOW,
          ),
      ).toThrow("enrollment record evidence schema invalid");
    }
  });

  test("record authority is immutable and mutable state advances only once", async () => {
    const sqlite = database();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const first = record("record-state-first");
    expect(await store.create(first)).toBe(true);

    const authorityMutations = [
      "enrollment_id = 'ASIMP-EN-ZYXWVTSRQP'",
      `secret_hash = '${"f".repeat(64)}'`,
      `secret_expires_at = ${NOW + 30 * 60_000 + 1}`,
      `requested_scopes_json = '["promote"]'`,
      `requested_resources_json = '{"eventBudget":1}'`,
      `created_at = ${NOW + 1}`,
    ] as const;
    for (const assignment of authorityMutations) {
      expect(() =>
        sqlite
          .prepare(`UPDATE enrollment_records SET ${assignment} WHERE enrollment_id = ?`)
          .run(first.enrollmentId),
      ).toThrow("enrollment record authority is immutable");
    }
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_records SET sponsor_id = ? WHERE enrollment_id = ?")
        .run("usr_other_sponsor", first.enrollmentId),
    ).toThrow("enrollment record state transition invalid");
    expect(
      sqlite
        .prepare("UPDATE enrollment_records SET invalidated = 1 WHERE enrollment_id = ?")
        .run(first.enrollmentId).changes,
    ).toBe(1);
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_records SET invalidated = 0 WHERE enrollment_id = ?")
        .run(first.enrollmentId),
    ).toThrow("enrollment record state transition invalid");

    const second = record("record-state-second");
    expect(await store.create(second)).toBe(true);
    expect(
      sqlite
        .prepare("UPDATE enrollment_records SET secret_consumed_at = ? WHERE enrollment_id = ?")
        .run(NOW + 1, second.enrollmentId).changes,
    ).toBe(1);
    for (const next of [null, NOW + 2] as const) {
      expect(() =>
        sqlite
          .prepare("UPDATE enrollment_records SET secret_consumed_at = ? WHERE enrollment_id = ?")
          .run(next, second.enrollmentId),
      ).toThrow("enrollment record state transition invalid");
    }

    const device = deviceInput("record-state-device");
    await store.deviceCreate(device);
    expect(
      sqlite
        .prepare("UPDATE enrollment_records SET sponsor_id = ? WHERE enrollment_id = ?")
        .run("usr_device_bound", device.record.enrollmentId).changes,
    ).toBe(1);
    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_records SET sponsor_id = ? WHERE enrollment_id = ?")
        .run("usr_device_other", device.record.enrollmentId),
    ).toThrow("enrollment record state transition invalid");
  });

  test("0011 refuses retained authority outside the complete persisted schema", () => {
    const corruptCases = [
      { label: "unknown scope", scopes: '["admin"]', resources: "{}" },
      { label: "duplicate scope", scopes: '["review","review"]', resources: "{}" },
      { label: "unknown resource", scopes: '["review"]', resources: '{"mystery":1}' },
      {
        label: "wrong budget type",
        scopes: '["review"]',
        resources: '{"eventBudget":"10"}',
      },
      {
        label: "budget beyond contract",
        scopes: '["review"]',
        resources: '{"artifactBudgetBytes":1073741825}',
      },
      {
        label: "invalid problem binding",
        scopes: '["review"]',
        resources: '{"problemBinding":"P-abcd"}',
      },
      {
        label: "NUL-suffixed problem binding",
        scopes: '["review"]',
        resources: JSON.stringify({ problemBinding: "P-ABCD\u0000TRAIL" }),
      },
      {
        label: "duplicate resource key",
        scopes: '["review"]',
        resources: '{"eventBudget":1,"eventBudget":2}',
      },
      {
        label: "unicode-trimmed empty directive",
        scopes: '["review"]',
        resources: JSON.stringify({ firstDirective: "\t\u00a0\ufeff" }),
      },
      {
        label: "directive beyond UTF-16 contract",
        scopes: '["review"]',
        resources: JSON.stringify({ firstDirective: "😀".repeat(2_000) }),
      },
      {
        label: "NUL-truncated overlong directive",
        scopes: '["review"]',
        resources: JSON.stringify({ firstDirective: `x\u0000${"a".repeat(2_100)}` }),
      },
    ] as const;

    for (const fixture of corruptCases) {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(
        sqlite,
        fixture.resources,
        fixture.scopes,
        NOW,
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
        "{}",
        '["review"]',
      );
      sqlite
        .prepare(
          `UPDATE enrollment_proposals
              SET token_hash = NULL, token_issued_at = NULL
            WHERE proposal_id = ?`,
        )
        .run(LIFECYCLE_PROPOSAL);
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));

      expectCredentialHardeningGuardRollback(sqlite);
    }
  });

  test("0011 keeps malformed authority out of every future durable grant", () => {
    const corruptCases = [
      { scopes: '["admin"]', resources: "{}" },
      { scopes: '["review","review"]', resources: "{}" },
      { scopes: '["review"]', resources: '{"unknown":true}' },
      { scopes: '["review"]', resources: '{"eventBudget":0}' },
      {
        scopes: '["review"]',
        resources: JSON.stringify({ firstDirective: "\t\u00a0\ufeff" }),
      },
      {
        scopes: '["review"]',
        resources: JSON.stringify({ firstDirective: "😀".repeat(2_000) }),
      },
      {
        scopes: '["review"]',
        resources: JSON.stringify({ problemBinding: "P-ABCD\u0000TRAIL" }),
      },
      {
        scopes: '["review"]',
        resources: JSON.stringify({ firstDirective: `x\u0000${"a".repeat(2_100)}` }),
      },
    ] as const;

    for (const fixture of corruptCases) {
      const sqlite = database();
      // Isolate the schema trigger from the separately planted request-ceiling
      // trigger so removing this guard makes this exact test go green.
      sqlite.run("DROP TRIGGER enrollment_grants_approval_binding_insert");
      expect(() =>
        seedLifecycleIdentity(
          sqlite,
          fixture.resources,
          fixture.scopes,
          NOW,
          NOW,
          NOW + PENDING_PROPOSAL_TTL_MS,
          "{}",
          '["review"]',
        ),
      ).toThrow("enrollment grant authority schema invalid");
      expect(
        sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
      ).toBe(0);
    }
  });

  test("0011 rejects SQLite BLOB storage classes for retained and future authority", () => {
    const retained = new Database(":memory:", { strict: true });
    retained.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(retained);
    retained
      .prepare(
        `UPDATE enrollment_proposals
            SET granted_scopes_json = CAST(? AS BLOB),
                token_hash = NULL,
                token_issued_at = NULL
          WHERE proposal_id = ?`,
      )
      .run('["review"]', LIFECYCLE_PROPOSAL);
    retained
      .prepare(
        `UPDATE enrollment_grants
            SET granted_scopes_json = CAST(? AS BLOB)
          WHERE proposal_id = ?`,
      )
      .run('["review"]', LIFECYCLE_PROPOSAL);
    retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    expectCredentialHardeningGuardRollback(retained);

    const currentEnrollmentId = fixtureEnrollmentId("blob-authority");
    const current = database();
    current
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        currentEnrollmentId,
        LIFECYCLE_SPONSOR,
        fixtureDigest("blob-authority-secret"),
        NOW + 30 * 60_000,
        '["review"]',
        "{}",
        NOW,
      );
    current
      .prepare(
        `INSERT INTO enrollment_proposals (
           proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
           created_at, expires_at, status, granted_scopes_json, granted_resources_json,
           token_hash, token_issued_at, poll_interval_seconds
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 5)`,
      )
      .run(
        "proposal-blob-authority",
        currentEnrollmentId,
        "fellow-blob-authority",
        "blob-authority-flow-hash",
        "blob-authority-fellow",
        "test-model",
        "codex",
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
      );
    current
      .prepare(
        `UPDATE enrollment_proposals
            SET status = 'approved', granted_scopes_json = CAST(? AS BLOB),
                granted_resources_json = ?
          WHERE proposal_id = ?`,
      )
      .run('["review"]', "{}", "proposal-blob-authority");
    current
      .prepare(
        `INSERT INTO enrollment_fellows (
           fellow_id, sponsor_id, name, model, harness, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fellow-blob-authority",
        LIFECYCLE_SPONSOR,
        "blob-authority-fellow",
        "test-model",
        "codex",
        NOW,
      );
    expect(() =>
      current
        .prepare(
          `INSERT INTO enrollment_grants (
             proposal_id, fellow_id, sponsor_id, granted_scopes_json,
             granted_resources_json, granted_at
           ) VALUES (?, ?, ?, CAST(? AS BLOB), ?, ?)`,
        )
        .run(
          "proposal-blob-authority",
          "fellow-blob-authority",
          LIFECYCLE_SPONSOR,
          '["review"]',
          "{}",
          NOW,
        ),
    ).toThrow("enrollment grant authority schema invalid");
  });

  test("0011 rejects retained and future Fellow identities outside the hello contract", () => {
    const identityCases = [
      { field: "model", value: "" },
      { field: "model", value: "😀".repeat(100) },
      { field: "model", value: `x\u0000${"a".repeat(200)}` },
      { field: "harness", value: "\t\u00a0\ufeff" },
      { field: "harness", value: "😀".repeat(100) },
      { field: "harness", value: `x\u0000${"a".repeat(200)}` },
    ] as const;

    for (const fixture of identityCases) {
      const retained = new Database(":memory:", { strict: true });
      retained.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(retained);
      retained
        .prepare(`UPDATE enrollment_fellows SET ${fixture.field} = ? WHERE fellow_id = ?`)
        .run(fixture.value, LIFECYCLE_FELLOW);
      retained
        .prepare(`UPDATE enrollment_proposals SET ${fixture.field} = ? WHERE proposal_id = ?`)
        .run(fixture.value, LIFECYCLE_PROPOSAL);
      retained
        .prepare(
          `UPDATE enrollment_proposals
              SET token_hash = NULL, token_issued_at = NULL
            WHERE proposal_id = ?`,
        )
        .run(LIFECYCLE_PROPOSAL);
      retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      expectCredentialHardeningGuardRollback(retained);

      const current = database();
      expect(() =>
        current
          .prepare(
            `INSERT INTO enrollment_fellows (
               fellow_id, sponsor_id, name, model, harness, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `invalid-fellow-${fixture.field}`,
            LIFECYCLE_SPONSOR,
            "invalid-fellow",
            fixture.field === "model" ? fixture.value : "model",
            fixture.field === "harness" ? fixture.value : "harness",
            NOW,
          ),
      ).toThrow("Fellow identity schema invalid");
    }

    const invalidName = database();
    expect(() =>
      invalidName
        .prepare(
          `INSERT INTO enrollment_fellows (
             fellow_id, sponsor_id, name, model, harness, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("invalid-fellow-name", LIFECYCLE_SPONSOR, "Invalid", "model", "harness", NOW),
    ).toThrow("Fellow identity schema invalid");

    const retainedNullId = new Database(":memory:", { strict: true });
    retainedNullId.run(readFileSync(MIGRATION, "utf8"));
    retainedNullId
      .prepare(
        `INSERT INTO enrollment_fellows (
           fellow_id, sponsor_id, name, model, harness, created_at
         ) VALUES (NULL, ?, ?, ?, ?, ?)`,
      )
      .run(LIFECYCLE_SPONSOR, "orphan-fellow", "model", "harness", NOW);
    retainedNullId.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    expectCredentialHardeningGuardRollback(retainedNullId);

    const currentNullId = database();
    expect(() =>
      currentNullId
        .prepare(
          `INSERT INTO enrollment_fellows (
             fellow_id, sponsor_id, name, model, harness, created_at
           ) VALUES (NULL, ?, ?, ?, ?, ?)`,
        )
        .run(LIFECYCLE_SPONSOR, "orphan-fellow", "model", "harness", NOW),
    ).toThrow("Fellow identity schema invalid");

    const identityIdCases = [
      {
        label: "fellow-id",
        fellowId: "😀".repeat(50),
        sponsorId: LIFECYCLE_SPONSOR,
      },
      {
        label: "sponsor-id",
        fellowId: "orphan-sponsor-id-fellow",
        sponsorId: "😀".repeat(100),
      },
    ] as const;
    for (const fixture of identityIdCases) {
      const retained = new Database(":memory:", { strict: true });
      retained.run(readFileSync(MIGRATION, "utf8"));
      retained
        .prepare(
          `INSERT INTO enrollment_fellows (
             fellow_id, sponsor_id, name, model, harness, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fixture.fellowId,
          fixture.sponsorId,
          `orphan-${fixture.label}`,
          "model",
          "harness",
          NOW,
        );
      retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      expectCredentialHardeningGuardRollback(retained);

      const current = database();
      expect(() =>
        current
          .prepare(
            `INSERT INTO enrollment_fellows (
               fellow_id, sponsor_id, name, model, harness, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fixture.fellowId,
            fixture.sponsorId,
            `orphan-${fixture.label}`,
            "model",
            "harness",
            NOW,
          ),
      ).toThrow("Fellow identity schema invalid");
    }

    const retainedBlob = new Database(":memory:", { strict: true });
    retainedBlob.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(retainedBlob);
    retainedBlob
      .prepare("UPDATE enrollment_fellows SET model = CAST(? AS BLOB) WHERE fellow_id = ?")
      .run("test-model", LIFECYCLE_FELLOW);
    retainedBlob
      .prepare(
        `UPDATE enrollment_proposals
            SET model = CAST(? AS BLOB), token_hash = NULL, token_issued_at = NULL
          WHERE proposal_id = ?`,
      )
      .run("test-model", LIFECYCLE_PROPOSAL);
    retainedBlob.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    expectCredentialHardeningGuardRollback(retainedBlob);

    const currentBlob = database();
    expect(() =>
      currentBlob
        .prepare(
          `INSERT INTO enrollment_fellows (
             fellow_id, sponsor_id, name, model, harness, created_at
           ) VALUES (?, ?, ?, CAST(? AS BLOB), ?, ?)`,
        )
        .run(
          "invalid-blob-model",
          LIFECYCLE_SPONSOR,
          "invalid-blob-model",
          "test-model",
          "codex",
          NOW,
        ),
    ).toThrow("Fellow identity schema invalid");
  });

  test("0011 rejects credentials whose issuance predates their durable grant", () => {
    const retained = new Database(":memory:", { strict: true });
    retained.run(readFileSync(MIGRATION, "utf8"));
    retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    seedLifecycleIdentity(retained, "{}", '["review"]', NOW + 1);
    insertLifecycleCredential(retained, {
      id: "credential-before-grant",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    expectCredentialHardeningGuardRollback(retained);

    const current = database();
    seedLifecycleIdentity(current, "{}", '["review"]', NOW + 1);
    expect(() =>
      insertLifecycleCredential(current, {
        id: "credential-before-grant",
        hash: "token-hash-1",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
      }),
    ).toThrow("credential durable authority mismatch");
  });

  test("durable grants must be recorded inside the proposal decision window", async () => {
    const cases = [
      {
        label: "before-proposal-creation",
        proposalCreatedAt: NOW + 1_000,
        proposalExpiresAt: NOW + 1_000 + PENDING_PROPOSAL_TTL_MS,
        grantedAt: NOW,
      },
      {
        label: "at-proposal-expiry",
        proposalCreatedAt: NOW,
        proposalExpiresAt: NOW + PENDING_PROPOSAL_TTL_MS,
        grantedAt: NOW + PENDING_PROPOSAL_TTL_MS,
      },
    ] as const;

    for (const fixture of cases) {
      const retained = new Database(":memory:", { strict: true });
      retained.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(
        retained,
        "{}",
        '["review"]',
        fixture.grantedAt,
        fixture.proposalCreatedAt,
        fixture.proposalExpiresAt,
      );
      retained
        .prepare(
          `UPDATE enrollment_proposals
              SET token_hash = NULL, token_issued_at = NULL
            WHERE proposal_id = ?`,
        )
        .run(LIFECYCLE_PROPOSAL);
      retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      expectCredentialHardeningGuardRollback(retained);

      const current = database();
      expect(() =>
        seedLifecycleIdentity(
          current,
          "{}",
          '["review"]',
          fixture.grantedAt,
          fixture.proposalCreatedAt,
          fixture.proposalExpiresAt,
        ),
      ).toThrow("enrollment grant approval binding mismatch");

      const runtime = new Database(":memory:", { strict: true });
      runtime.run(readFileSync(MIGRATION, "utf8"));
      runtime.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      seedLifecycleIdentity(
        runtime,
        "{}",
        '["review"]',
        fixture.grantedAt,
        fixture.proposalCreatedAt,
        fixture.proposalExpiresAt,
      );
      const tokenHash = `token-hash-${fixture.label}`;
      const credentialId = `credential-${fixture.label}-runtime`;
      runtime
        .prepare(
          `UPDATE enrollment_proposals
              SET token_hash = ?, token_issued_at = ?
            WHERE proposal_id = ?`,
        )
        .run(tokenHash, fixture.grantedAt, LIFECYCLE_PROPOSAL);
      insertLifecycleCredential(runtime, {
        id: credentialId,
        hash: tokenHash,
        issuedAt: fixture.grantedAt,
        proposalId: LIFECYCLE_PROPOSAL,
      });
      expect(
        await new D1EnrollmentStore(localD1(runtime)).authenticateCredential(
          tokenHash,
          fixture.grantedAt + 1,
          "bearer",
        ),
      ).toBeUndefined();
      expect(
        runtime
          .prepare<{ last_used_at: number | null }, [string]>(
            "SELECT last_used_at FROM fellow_tokens WHERE credential_id = ?",
          )
          .get(credentialId)?.last_used_at,
      ).toBeNull();
    }
  });

  test("0011 rejects retained and future sponsor-visible evidence outside safe schemas", () => {
    const invalidGrantTimes = [
      { grantedAt: -1, expected: "enrollment grant approval binding mismatch" },
      { grantedAt: NOW + 0.5, expected: "enrollment grant evidence schema invalid" },
      {
        grantedAt: 9_007_199_254_740_992,
        expected: "enrollment grant approval binding mismatch",
      },
    ] as const;
    for (const { grantedAt, expected } of invalidGrantTimes) {
      // Keep the proposal itself inside the newly enforced safe evidence
      // schema. Only the grant time is malformed; the future-insert assertion
      // below must therefore reach the grant trigger rather than failing while
      // the proposal is seeded.
      const proposalCreatedAt = NOW;
      const proposalExpiresAt = NOW + PENDING_PROPOSAL_TTL_MS;
      const retainedGrant = new Database(":memory:", { strict: true });
      retainedGrant.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(
        retainedGrant,
        "{}",
        '["review"]',
        grantedAt,
        proposalCreatedAt,
        proposalExpiresAt,
      );
      retainedGrant
        .prepare(
          `UPDATE enrollment_proposals
              SET token_hash = NULL, token_issued_at = NULL
            WHERE proposal_id = ?`,
        )
        .run(LIFECYCLE_PROPOSAL);
      retainedGrant.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      expectCredentialHardeningGuardRollback(retainedGrant);

      const currentGrant = database();
      expect(() =>
        seedLifecycleIdentity(
          currentGrant,
          "{}",
          '["review"]',
          grantedAt,
          proposalCreatedAt,
          proposalExpiresAt,
        ),
      ).toThrow(expected);
    }

    const credentialCases = [
      { id: null, expiresAt: NOW + TOKEN_TTL_MS },
      { id: "😀".repeat(100), expiresAt: NOW + TOKEN_TTL_MS },
      { id: `credential\u0000${"x".repeat(200)}`, expiresAt: NOW + TOKEN_TTL_MS },
      { id: "credential-unsafe-expiry", expiresAt: 9_007_199_254_740_992 },
    ] as const;
    for (const fixture of credentialCases) {
      const retained = new Database(":memory:", { strict: true });
      retained.run(readFileSync(MIGRATION, "utf8"));
      retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      seedLifecycleIdentity(retained);
      insertLifecycleCredential(retained, {
        id: fixture.id,
        hash: "token-hash-1",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
        expiresAt: fixture.expiresAt,
      });
      expectCredentialHardeningGuardRollback(retained);

      const current = database();
      seedLifecycleIdentity(current);
      expect(() =>
        insertLifecycleCredential(current, {
          id: fixture.id,
          hash: "token-hash-1",
          issuedAt: NOW,
          proposalId: LIFECYCLE_PROPOSAL,
          expiresAt: fixture.expiresAt,
        }),
      ).toThrow("credential output schema invalid");
    }
  });

  test("0011 refuses issued proposal facts without their exact credential row", () => {
    const tokenFacts = [
      { label: "both", hash: "orphan-token", issuedAt: NOW },
      { label: "hash only", hash: "orphan-token", issuedAt: null },
      { label: "time only", hash: null, issuedAt: NOW },
    ] as const;

    for (const fixture of tokenFacts) {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(sqlite);
      sqlite
        .prepare(
          `UPDATE enrollment_proposals
              SET token_hash = ?, token_issued_at = ?
            WHERE proposal_id = ?`,
        )
        .run(fixture.hash, fixture.issuedAt, LIFECYCLE_PROPOSAL);
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));

      expectCredentialHardeningGuardRollback(sqlite);
    }
  });

  test("0011 refuses an approved proposal whose atomic Fellow and grant rows are missing", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(sqlite);
    sqlite.prepare("DELETE FROM enrollment_grants WHERE proposal_id = ?").run(LIFECYCLE_PROPOSAL);
    sqlite
      .prepare(
        `UPDATE enrollment_proposals
            SET token_hash = NULL, token_issued_at = NULL
          WHERE proposal_id = ?`,
      )
      .run(LIFECYCLE_PROPOSAL);
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));

    expectCredentialHardeningGuardRollback(sqlite);
  });

  test("0011 refuses an over-authorized 0006 legacy copy and rolls back its own schema", () => {
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
        "credential-legacy-escalated",
        LIFECYCLE_PROPOSAL,
        LIFECYCLE_FELLOW,
        LIFECYCLE_SPONSOR,
        "token-hash-legacy-escalated",
        '["promote"]',
        "{}",
        NOW,
      );
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));

    expectCredentialHardeningGuardRollback(sqlite);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(1);
  });

  test("0011 refuses a durable grant that exceeds its recorded approval", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(sqlite);
    sqlite.prepare("UPDATE enrollment_grants SET granted_scopes_json = '[\"promote\"]'").run();
    sqlite
      .prepare(
        `INSERT INTO enrollment_credentials (
           credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
           granted_scopes_json, granted_resources_json, issued_at
         ) VALUES (?, ?, ?, ?, ?, '["promote"]', '{}', ?)`,
      )
      .run(
        "credential-escalated-grant",
        LIFECYCLE_PROPOSAL,
        LIFECYCLE_FELLOW,
        LIFECYCLE_SPONSOR,
        "token-hash-1",
        NOW,
      );
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));

    expectCredentialHardeningGuardRollback(sqlite);
  });

  test("0011 refuses enrollment credential token and issuance facts that disagree with the proposal", () => {
    for (const mismatch of ["token", "issuance"] as const) {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(sqlite);
      sqlite
        .prepare(
          `INSERT INTO enrollment_credentials (
             credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
             granted_scopes_json, granted_resources_json, issued_at
           ) VALUES (?, ?, ?, ?, ?, '["review"]', '{}', ?)`,
        )
        .run(
          `credential-${mismatch}-mismatch`,
          LIFECYCLE_PROPOSAL,
          LIFECYCLE_FELLOW,
          LIFECYCLE_SPONSOR,
          mismatch === "token" ? "token-hash-mismatch" : "token-hash-1",
          mismatch === "issuance" ? NOW + 1 : NOW,
        );
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));

      expectCredentialHardeningGuardRollback(sqlite);
    }
  });

  test("0011 refuses a pre-existing four-token overlap created by backdated issuance", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-future-1",
      hash: "token-hash-future-1",
      issuedAt: NOW + 200,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    insertLifecycleCredential(sqlite, {
      id: "credential-future-2",
      hash: "token-hash-future-2",
      issuedAt: NOW + 201,
    });
    insertLifecycleCredential(sqlite, {
      id: "credential-future-3",
      hash: "token-hash-future-3",
      issuedAt: NOW + 202,
    });
    insertLifecycleCredential(sqlite, {
      id: "credential-backdated",
      hash: "token-hash-backdated",
      issuedAt: NOW + 100,
    });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(4);

    expectCredentialHardeningGuardRollback(sqlite);
  });

  test("0011 rejects a backdated insert before it can bypass the active-token cap", () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-current-1",
      hash: "token-hash-current-1",
      issuedAt: NOW + 200,
    });
    insertLifecycleCredential(sqlite, {
      id: "credential-current-2",
      hash: "token-hash-current-2",
      issuedAt: NOW + 201,
    });
    insertLifecycleCredential(sqlite, {
      id: "credential-current-3",
      hash: "token-hash-current-3",
      issuedAt: NOW + 202,
    });

    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-current-backdated",
        hash: "token-hash-current-backdated",
        issuedAt: NOW + 100,
      }),
    ).toThrow("credential issuance cannot move backward");
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(3);
  });

  test("authentication refuses a legacy credential whose copied authority exceeds its durable grant", async () => {
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
        "credential-legacy-escalated",
        LIFECYCLE_PROPOSAL,
        LIFECYCLE_FELLOW,
        LIFECYCLE_SPONSOR,
        "token-hash-legacy-escalated",
        '["promote"]',
        "{}",
        NOW,
      );
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    const store = new D1EnrollmentStore(localD1(sqlite));

    expect(
      await store.authenticateCredential("token-hash-legacy-escalated", NOW + 1, "bearer"),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, []>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-legacy-escalated'",
        )
        .get()?.last_used_at,
    ).toBeNull();
  });

  test("pre-0011 authentication refuses credentials before their grant or outside timestamp schema", async () => {
    const beforeGrant = new Database(":memory:", { strict: true });
    beforeGrant.run(readFileSync(MIGRATION, "utf8"));
    beforeGrant.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    seedLifecycleIdentity(beforeGrant, "{}", '["review"]', NOW + 100);
    insertLifecycleCredential(beforeGrant, {
      id: "credential-before-grant-runtime",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    const beforeGrantStore = new D1EnrollmentStore(localD1(beforeGrant));
    expect(await beforeGrantStore.authenticateCredential("token-hash-1", NOW + 1, "bearer")).toBe(
      undefined,
    );
    expect(
      beforeGrant
        .prepare<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = ?",
        )
        .get("credential-before-grant-runtime")?.last_used_at,
    ).toBeNull();

    const fractional = new Database(":memory:", { strict: true });
    fractional.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(fractional);
    fractional
      .prepare(
        `UPDATE enrollment_proposals
            SET token_hash = ?, token_issued_at = ?
          WHERE proposal_id = ?`,
      )
      .run("token-hash-fractional", NOW + 0.5, LIFECYCLE_PROPOSAL);
    fractional
      .prepare(
        `INSERT INTO enrollment_credentials (
           credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
           granted_scopes_json, granted_resources_json, issued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "credential-fractional-runtime",
        LIFECYCLE_PROPOSAL,
        LIFECYCLE_FELLOW,
        LIFECYCLE_SPONSOR,
        "token-hash-fractional",
        '["review"]',
        "{}",
        NOW + 0.5,
      );
    fractional.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    const fractionalStore = new D1EnrollmentStore(localD1(fractional));
    let caught: unknown;
    try {
      await fractionalStore.authenticateCredential("token-hash-fractional", NOW + 1, "bearer");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnrollmentPersistenceError);
    expect(
      fractional
        .prepare<{ last_used_at: number | null; storage_class: string }, [string]>(
          `SELECT last_used_at, typeof(issued_at) AS storage_class
             FROM fellow_tokens WHERE credential_id = ?`,
        )
        .get("credential-fractional-runtime"),
    ).toEqual({ last_used_at: null, storage_class: "real" });
  });

  test("pre-0011 authentication refuses non-text credential identifiers without stamping use", async () => {
    const fixtures = [
      { label: "BLOB", expression: "CAST(? AS BLOB)", value: "credential-blob-runtime" },
      { label: "NULL", expression: "?", value: null },
    ] as const;

    for (const fixture of fixtures) {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(sqlite);
      const tokenHash = `token-hash-${fixture.label.toLowerCase()}-id`;
      sqlite
        .prepare(
          `UPDATE enrollment_proposals
              SET token_hash = ?, token_issued_at = ?
            WHERE proposal_id = ?`,
        )
        .run(tokenHash, NOW, LIFECYCLE_PROPOSAL);
      sqlite
        .prepare(
          `INSERT INTO enrollment_credentials (
             credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
             granted_scopes_json, granted_resources_json, issued_at
           ) VALUES (${fixture.expression}, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fixture.value,
          LIFECYCLE_PROPOSAL,
          LIFECYCLE_FELLOW,
          LIFECYCLE_SPONSOR,
          tokenHash,
          '["review"]',
          "{}",
          NOW,
        );
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      const store = new D1EnrollmentStore(localD1(sqlite));
      let caught: unknown;
      try {
        await store.authenticateCredential(tokenHash, NOW + 1, "bearer");
      } catch (error) {
        caught = error;
      }
      expect(caught, fixture.label).toBeInstanceOf(EnrollmentPersistenceError);
      expect(
        sqlite
          .prepare<{ last_used_at: number | null; storage_class: string }, [string]>(
            `SELECT last_used_at, typeof(credential_id) AS storage_class
               FROM fellow_tokens WHERE token_hash = ?`,
          )
          .get(tokenHash),
        fixture.label,
      ).toEqual({ last_used_at: null, storage_class: fixture.label.toLowerCase() });
    }
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
    ).toThrow("credential durable authority mismatch");
    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-null-origin-cross-sponsor",
        hash: "token-hash-null-origin-cross-sponsor",
        issuedAt: NOW,
        sponsorId: "usr_attacker",
      }),
    ).toThrow("credential durable authority mismatch");
    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "credential-escalated-grant",
        hash: "token-hash-escalated-grant",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
        scopesJson: '["promote"]',
      }),
    ).toThrow("credential durable authority mismatch");

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

    for (const [column, value] of [
      ["sponsor_id", "usr_rewritten_sponsor"],
      ["name", "rewritten-fellow"],
      ["model", "rewritten-model"],
      ["harness", "rewritten-harness"],
      ["created_at", NOW + 1],
    ] as const) {
      expect(() =>
        sqlite
          .prepare(`UPDATE enrollment_fellows SET ${column} = ? WHERE fellow_id = ?`)
          .run(value, LIFECYCLE_FELLOW),
      ).toThrow("Fellow identity is immutable");
    }
    sqlite
      .prepare("UPDATE enrollment_fellows SET status = 'paused' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);
    sqlite
      .prepare("UPDATE enrollment_fellows SET status = 'active' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);

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
    expect(() =>
      sqlite
        .prepare("UPDATE fellow_tokens SET last_used_at = ? WHERE credential_id = ?")
        .run(NOW + 5.5, "credential-1"),
    ).toThrow("credential last-used evidence schema invalid");
    expect(
      sqlite
        .prepare<{ last_used_at: number; storage_class: string }, [string]>(
          `SELECT last_used_at, typeof(last_used_at) AS storage_class
             FROM fellow_tokens
            WHERE credential_id = ?`,
        )
        .get("credential-1"),
    ).toEqual({ last_used_at: NOW + 5, storage_class: "integer" });

    for (const invalidRevocation of [NOW + 5.5, 9_007_199_254_740_992]) {
      expect(() =>
        sqlite
          .prepare("UPDATE fellow_tokens SET revoked_at = ? WHERE credential_id = ?")
          .run(invalidRevocation, "credential-1"),
      ).toThrow("credential revocation evidence schema invalid");
      expect(
        sqlite
          .prepare<{ revoked_at: number | null }, [string]>(
            "SELECT revoked_at FROM fellow_tokens WHERE credential_id = ?",
          )
          .get("credential-1")?.revoked_at,
      ).toBeNull();
    }
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

  test("terminal Fellow identity cannot be deleted or resurrected through REPLACE", async () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-terminal-replace",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    sqlite
      .prepare("UPDATE fellow_tokens SET revoked_at = ? WHERE credential_id = ?")
      .run(NOW + 1, "credential-terminal-replace");
    sqlite
      .prepare("UPDATE enrollment_fellows SET status = 'revoked' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);

    expect(() =>
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO enrollment_fellows (
             fellow_id, sponsor_id, name, model, harness, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(LIFECYCLE_FELLOW, LIFECYCLE_SPONSOR, "lifecycle-fellow", "test-model", "codex", NOW),
    ).toThrow("Fellow identity already exists");
    expect(() =>
      sqlite.prepare("DELETE FROM enrollment_fellows WHERE fellow_id = ?").run(LIFECYCLE_FELLOW),
    ).toThrow("Fellow identity cannot be deleted");
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_fellows WHERE fellow_id = ?",
        )
        .get(LIFECYCLE_FELLOW),
    ).toEqual({ status: "revoked" });
    expect(
      await new D1EnrollmentStore(localD1(sqlite)).authenticateCredential(
        "token-hash-1",
        NOW + 2,
        "bearer",
      ),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = ?",
        )
        .get("credential-terminal-replace")?.last_used_at,
    ).toBeNull();
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

    const authenticated = await store.authenticateCredential("token-hash-1", NOW + 1, "bearer");
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

    expect(
      await store.authenticateCredential("token-hash-1", NOW + TOKEN_TTL_MS, "bearer"),
    ).toBeUndefined();
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

    sqlite
      .prepare("UPDATE enrollment_fellows SET status = 'suspicious_review' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);
    expect(
      (await store.authenticateCredential("token-hash-1", NOW + 3, "bearer"))?.fellowStatus,
    ).toBe("suspicious_review");
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 3))[0]).toMatchObject({
      status: "suspicious_review",
      credentials: [{ credentialId: "credential-1", active: true }],
    });
    expect(
      (await store.authenticateCredential("token-hash-1", NOW + 2, "bearer"))?.lastUsedAt,
    ).toBe(NOW + 3);

    sqlite
      .prepare("UPDATE enrollment_fellows SET status = 'active' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);
    sqlite
      .prepare(
        `INSERT INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    expect(await store.authenticateCredential("token-hash-1", NOW + 4, "bearer")).toBeUndefined();
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 4))[0]?.credentials).toEqual([]);

    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, []>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-1'",
        )
        .get()?.last_used_at,
    ).toBe(NOW + 3);
  });

  test("an auth-state change between candidate parsing and last-used update wins the race", async () => {
    const races = [
      {
        label: "revocation",
        mutate: (sqlite: Database) =>
          sqlite
            .prepare(
              "UPDATE fellow_tokens SET revoked_at = ? WHERE credential_id = 'credential-race'",
            )
            .run(NOW + 1),
      },
      {
        label: "pause",
        mutate: (sqlite: Database) =>
          sqlite
            .prepare("UPDATE enrollment_fellows SET status = 'paused' WHERE fellow_id = ?")
            .run(LIFECYCLE_FELLOW),
      },
      {
        label: "panic",
        mutate: (sqlite: Database) =>
          sqlite
            .prepare(
              `INSERT INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at)
               VALUES (?, ?, ?)`,
            )
            .run(LIFECYCLE_SPONSOR, NOW + 1, NOW + 1),
      },
    ] as const;

    for (const race of races) {
      const sqlite = database();
      seedLifecycleIdentity(sqlite);
      insertLifecycleCredential(sqlite, {
        id: "credential-race",
        hash: "token-hash-1",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
      });
      let mutated = false;
      const store = new D1EnrollmentStore(
        localD1(sqlite, {
          afterFirstRead: async (query) => {
            if (mutated || !query.includes("FROM fellow_tokens WHERE token_hash")) return;
            mutated = true;
            race.mutate(sqlite);
          },
        }),
      );

      expect(
        await store.authenticateCredential("token-hash-1", NOW + 2, "bearer"),
        race.label,
      ).toBeUndefined();
      expect(mutated, race.label).toBe(true);
      expect(
        sqlite
          .prepare<{ last_used_at: number | null }, []>(
            "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-race'",
          )
          .get()?.last_used_at,
        race.label,
      ).toBeNull();
    }
  });

  test("terminal Fellow states cannot resurrect and compromise requires prior family revocation", async () => {
    for (const terminal of ["revoked", "compromised"] as const) {
      const sqlite = database();
      seedLifecycleIdentity(sqlite);
      insertLifecycleCredential(sqlite, {
        id: `credential-${terminal}`,
        hash: `token-hash-${terminal}`,
        issuedAt: NOW,
      });
      const store = new D1EnrollmentStore(localD1(sqlite));

      if (terminal === "compromised") {
        expect(() =>
          sqlite
            .prepare("UPDATE enrollment_fellows SET status = 'compromised' WHERE fellow_id = ?")
            .run(LIFECYCLE_FELLOW),
        ).toThrow("compromise requires credential family revocation");
        sqlite
          .prepare("UPDATE fellow_tokens SET revoked_at = ? WHERE fellow_id = ?")
          .run(NOW + 1, LIFECYCLE_FELLOW);
      }
      sqlite
        .prepare("UPDATE enrollment_fellows SET status = ? WHERE fellow_id = ?")
        .run(terminal, LIFECYCLE_FELLOW);
      expect(
        await store.authenticateCredential(`token-hash-${terminal}`, NOW + 2, "bearer"),
      ).toBeUndefined();
      expect(() =>
        insertLifecycleCredential(sqlite, {
          id: `credential-${terminal}-late`,
          hash: `token-hash-${terminal}-late`,
          issuedAt: NOW + 2,
        }),
      ).toThrow("terminal Fellow cannot receive live credential");
      expect(() =>
        sqlite
          .prepare("UPDATE enrollment_fellows SET status = 'active' WHERE fellow_id = ?")
          .run(LIFECYCLE_FELLOW),
      ).toThrow("fellow lifecycle transition invalid");
      sqlite
        .prepare("UPDATE enrollment_fellows SET status = 'archived' WHERE fellow_id = ?")
        .run(LIFECYCLE_FELLOW);
      expect(() =>
        insertLifecycleCredential(sqlite, {
          id: `credential-${terminal}-archived-late`,
          hash: `token-hash-${terminal}-archived-late`,
          issuedAt: NOW + 3,
        }),
      ).toThrow("terminal Fellow cannot receive live credential");
      expect(() =>
        sqlite
          .prepare("UPDATE enrollment_fellows SET status = 'active' WHERE fellow_id = ?")
          .run(LIFECYCLE_FELLOW),
      ).toThrow("fellow lifecycle transition invalid");
    }
  });

  test("a future-issued credential is inactive until its issuance boundary", async () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "credential-future",
      hash: "token-hash-future",
      issuedAt: NOW + 1_000,
    });
    const store = new D1EnrollmentStore(localD1(sqlite));

    expect(
      await store.authenticateCredential("token-hash-future", NOW + 999, "bearer"),
    ).toBeUndefined();
    expect(
      (await store.authenticateCredential("token-hash-future", NOW + 1_000, "bearer"))?.lastUsedAt,
    ).toBe(NOW + 1_000);
  });

  test("the approval-time Fellow grant expiry is an exclusive authentication boundary", async () => {
    const sqlite = database();
    const grantExpiresAt = NOW + 1_000;
    const resourcesJson = JSON.stringify({ fellowGrantExpiresAt: grantExpiresAt });
    seedLifecycleIdentity(sqlite, resourcesJson);
    insertLifecycleCredential(sqlite, {
      id: "credential-grant-expiry",
      hash: "token-hash-grant-expiry",
      issuedAt: NOW,
      resourcesJson,
    });
    const store = new D1EnrollmentStore(localD1(sqlite));

    expect(
      (await store.authenticateCredential("token-hash-grant-expiry", grantExpiresAt - 1, "bearer"))
        ?.lastUsedAt,
    ).toBe(grantExpiresAt - 1);
    expect(
      await store.authenticateCredential("token-hash-grant-expiry", grantExpiresAt, "bearer"),
    ).toBeUndefined();
    expect(
      (await store.fellowsBySponsor(LIFECYCLE_SPONSOR, grantExpiresAt))[0]?.credentials,
    ).toEqual([]);
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, []>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-grant-expiry'",
        )
        .get()?.last_used_at,
    ).toBe(grantExpiresAt - 1);
  });

  test("polling at the grant boundary expires without manufacturing a dead credential", async () => {
    const sqlite = deviceDatabase();
    const grantExpiresAt = NOW + 1_000;
    const resourcesJson = JSON.stringify({ fellowGrantExpiresAt: grantExpiresAt });
    seedLifecycleIdentity(
      sqlite,
      resourcesJson,
      '["review"]',
      NOW,
      NOW,
      NOW + PENDING_PROPOSAL_TTL_MS,
      resourcesJson,
      '["review"]',
      false,
    );
    const store = new D1EnrollmentStore(localD1(sqlite));
    let tokenFactoryCalls = 0;

    expect(
      await store.poll({
        flowHandleHash: "lifecycle-flow-hash",
        now: grantExpiresAt,
        createToken: async () => {
          tokenFactoryCalls += 1;
          return { token: "must-not-escape", tokenHash: "must-not-persist" };
        },
      }),
    ).toEqual({ kind: "expired" });
    expect(tokenFactoryCalls).toBe(0);
    expect(
      sqlite
        .prepare<{ status: string; token_hash: string | null }, []>(
          "SELECT status, token_hash FROM enrollment_proposals WHERE proposal_id = 'proposal-lifecycle'",
        )
        .get(),
    ).toEqual({ status: "expired", token_hash: null });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(0);
    expect(await store.fellowsBySponsor(LIFECYCLE_SPONSOR, grantExpiresAt)).toMatchObject([
      {
        fellowId: LIFECYCLE_FELLOW,
        status: "active",
        grantedResources: { fellowGrantExpiresAt: grantExpiresAt },
        credentials: [],
      },
    ]);
  });

  test("polling refuses corrupt durable scopes before the one-time token factory runs", async () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    seedLifecycleIdentity(sqlite, "{}", '["admin"]');
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
    sqlite
      .prepare(
        `UPDATE enrollment_proposals
            SET token_hash = NULL, token_issued_at = NULL
          WHERE proposal_id = ?`,
      )
      .run(LIFECYCLE_PROPOSAL);
    const store = new D1EnrollmentStore(localD1(sqlite));
    let tokenFactoryCalls = 0;
    let caught: unknown;

    try {
      await store.poll({
        flowHandleHash: "lifecycle-flow-hash",
        now: NOW + 1,
        createToken: async () => {
          tokenFactoryCalls += 1;
          return { token: "must-not-escape", tokenHash: "must-not-persist" };
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnrollmentPersistenceError);
    expect(tokenFactoryCalls).toBe(0);
    expect(
      sqlite
        .prepare<{ status: string; token_hash: string | null }, []>(
          "SELECT status, token_hash FROM enrollment_proposals WHERE proposal_id = 'proposal-lifecycle'",
        )
        .get(),
    ).toEqual({ status: "approved", token_hash: null });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(0);
  });

  test("schema-corrupt retained authority cannot stamp last-used evidence", async () => {
    const corruptCases = [
      {
        label: "string expiry",
        scopes: '["review"]',
        resources: '{"fellowGrantExpiresAt":"soon"}',
      },
      { label: "real expiry", scopes: '["review"]', resources: '{"fellowGrantExpiresAt":1.5}' },
      { label: "zero expiry", scopes: '["review"]', resources: '{"fellowGrantExpiresAt":0}' },
      {
        label: "overflow expiry",
        scopes: '["review"]',
        resources: '{"fellowGrantExpiresAt":1e100}',
      },
      { label: "unknown scope", scopes: '["admin"]', resources: "{}" },
    ] as const;
    for (const fixture of corruptCases) {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      seedLifecycleIdentity(sqlite, fixture.resources, fixture.scopes);
      insertLifecycleCredential(sqlite, {
        id: `credential-corrupt-${fixture.label.replaceAll(" ", "-")}`,
        hash: `token-hash-corrupt-${fixture.label.replaceAll(" ", "-")}`,
        issuedAt: NOW,
        scopesJson: fixture.scopes,
        resourcesJson: fixture.resources,
      });
      const store = new D1EnrollmentStore(localD1(sqlite));
      let caught: unknown;
      try {
        await store.authenticateCredential(
          `token-hash-corrupt-${fixture.label.replaceAll(" ", "-")}`,
          NOW + 1,
          "bearer",
        );
      } catch (error) {
        caught = error;
      }
      expect(caught, fixture.label).toBeInstanceOf(EnrollmentPersistenceError);
      expect(
        sqlite
          .prepare<{ last_used_at: number | null }, [string]>(
            "SELECT last_used_at FROM fellow_tokens WHERE credential_id = ?",
          )
          .get(`credential-corrupt-${fixture.label.replaceAll(" ", "-")}`)?.last_used_at,
        fixture.label,
      ).toBeNull();
    }
  });

  test("schema-corrupt retained Fellow identity cannot stamp last-used evidence", async () => {
    const corruptCases = [
      { label: "empty model", column: "model", value: "" },
      { label: "NUL model", column: "model", value: "model\0suffix" },
      { label: "whitespace harness", column: "harness", value: "\u2003" },
      { label: "NUL harness", column: "harness", value: "harness\0suffix" },
    ] as const;
    for (const fixture of corruptCases) {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      seedLifecycleIdentity(sqlite);
      insertLifecycleCredential(sqlite, {
        id: "credential-corrupt-identity",
        hash: "token-hash-1",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
      });
      sqlite
        .prepare(`UPDATE enrollment_fellows SET ${fixture.column} = ? WHERE fellow_id = ?`)
        .run(fixture.value, LIFECYCLE_FELLOW);
      sqlite
        .prepare(`UPDATE enrollment_proposals SET ${fixture.column} = ? WHERE proposal_id = ?`)
        .run(fixture.value, LIFECYCLE_PROPOSAL);
      const store = new D1EnrollmentStore(localD1(sqlite));
      let caught: unknown;

      try {
        await store.authenticateCredential("token-hash-1", NOW + 1, "bearer");
      } catch (error) {
        caught = error;
      }

      expect(caught, fixture.label).toBeInstanceOf(EnrollmentPersistenceError);
      expect(
        sqlite
          .prepare<{ last_used_at: number | null }, []>(
            "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-corrupt-identity'",
          )
          .get()?.last_used_at,
        fixture.label,
      ).toBeNull();
    }
  });

  test("bearer authentication cannot downgrade a stronger credential profile", async () => {
    const sqlite = database();
    seedLifecycleIdentity(sqlite);
    const rawToken = `asimp_ag_${"A".repeat(26)}_${"A".repeat(43)}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    insertLifecycleCredential(sqlite, {
      id: "credential-dpop",
      hash: tokenHash,
      issuedAt: NOW,
      profile: "dpop",
    });
    const store = new D1EnrollmentStore(localD1(sqlite));
    const random = { bytes: (length: number) => new Uint8Array(length) };
    const service = new EnrollmentService({
      clock: { now: () => NOW + 1 },
      random,
      store,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32), random),
    });

    expect(await service.credentialBinding(rawToken)).toBeUndefined();
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, []>(
          "SELECT last_used_at FROM fellow_tokens WHERE credential_id = 'credential-dpop'",
        )
        .get()?.last_used_at,
    ).toBeNull();
    expect(
      (await store.authenticateCredential(tokenHash, NOW + 1, "dpop"))?.credentialProfile,
    ).toBe("dpop");
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
