import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENROLLMENT_SECRET_TTL_MS,
  FELLOW_ACTIVE_CREDENTIAL_LIMIT,
  PENDING_PROPOSAL_TTL_MS,
  SPONSOR_FELLOW_PAGE_SIZE,
  STAGING_STOA_ORIGIN,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

import { createApp } from "../../src/app";
import { D1EnrollmentStore, FELLOW_CREDENTIAL_CAP_SQL_TOKEN } from "../../src/enrollment/d1-store";
import {
  AesGcmEnrollmentReplayProtector,
  DEVICE_CODE_TTL_MS,
  DEVICE_LOOKUP_LOCKOUT_FAILURES,
  DEVICE_LOOKUP_LOCKOUT_WINDOW_MS,
  DEVICE_START_RATE_LIMIT_ATTEMPTS,
  DEVICE_START_RATE_LIMIT_WINDOW_MS,
  type DeviceCreateInput,
  type DeviceLookupAttempt,
  EnrollmentError,
  EnrollmentIdempotencyRaceError,
  EnrollmentIdentifierCollisionError,
  EnrollmentPersistenceError,
  type EnrollmentRecord,
  EnrollmentService,
  InMemoryEnrollmentStore,
  SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS,
  SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS,
  SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS,
  SPONSOR_STEP_UP_WINDOW_SECONDS,
} from "../../src/enrollment/service";
import type { Env } from "../../src/env";
import { boundEnv } from "../support/bindings";

/**
 * One explicit trusted origin for every service built here.
 *
 * Staging rather than production on purpose: these fixtures must never be able
 * to pass by accidentally matching the canonical production string, so a
 * regression that reintroduced a production default would fail these tests
 * instead of hiding behind them.
 */
const TEST_STOA_ORIGIN = STAGING_STOA_ORIGIN;

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
const FELLOW_LIFECYCLE_COMMANDS_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0012_fellow_lifecycle_commands.sql",
);
const SPONSOR_FELLOW_CAP_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0013_sponsor_fellow_cap.sql",
);
const SPONSOR_ENROLLMENT_RATE_LIMIT_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0014_sponsor_enrollment_rate_limit.sql",
);
const SPONSOR_ENROLLMENT_BOOTSTRAP_INVARIANT_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0015_sponsor_enrollment_bootstrap_invariant.sql",
);
const OPERATOR_FELLOW_CAP_OVERRIDE_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0016_operator_fellow_cap_override.sql",
);
const DEVICE_MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0009_device_flow.sql");
const SPONSOR_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0008_sponsors_bootstrap.sql",
);
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
    readonly afterBatchCommit?: () => Promise<void>;
    readonly afterFirstRead?: (query: string) => Promise<void>;
    readonly onStatement?: (query: string) => void;
    readonly serializeBatches?: boolean;
  } = {},
): D1Database {
  const prepare = (query: string) => ({
    bind(...values: LocalBinding[]) {
      return {
        async run() {
          options.onStatement?.(query);
          const statement = sqlite.prepare<unknown, LocalBinding[]>(query);
          if (/^\s*SELECT\b/i.test(query)) {
            return { results: statement.all(...values), meta: { changes: 0 } };
          }
          const result = statement.run(...values);
          return { results: [], meta: { changes: result.changes } };
        },
        async first<T>(): Promise<T | null> {
          options.onStatement?.(query);
          const row = (sqlite.prepare<T, LocalBinding[]>(query).get(...values) ?? null) as T | null;
          await options.afterFirstRead?.(query);
          return row;
        },
        async all<T>(): Promise<{ results: T[] }> {
          options.onStatement?.(query);
          return {
            results: sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[],
          };
        },
      };
    },
  });
  const runBatch = async (
    statements: readonly {
      run(): Promise<{
        readonly results?: readonly unknown[];
        readonly meta: { changes: number };
      }>;
    }[],
  ) => {
    sqlite.run("BEGIN");
    let committed = false;
    try {
      const results: {
        readonly results?: readonly unknown[];
        readonly meta: { changes: number };
      }[] = [];
      for (const statement of statements) results.push(await statement.run());
      sqlite.run("COMMIT");
      committed = true;
      await options.afterBatchCommit?.();
      return results;
    } catch (error) {
      if (!committed) sqlite.run("ROLLBACK");
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
  const sqlite = databaseBeforeCredentialHardening(options);
  sqlite.exec(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8"));
  return sqlite;
}

function databaseBeforeLifecycleCommands(): Database {
  const sqlite = lifecycleDatabase();
  sqlite.exec(readFileSync(SPONSOR_MIGRATION, "utf8"));
  sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
  sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
  sqlite.exec(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8"));
  return sqlite;
}

function lifecycleCommandDatabase(): Database {
  const sqlite = databaseBeforeLifecycleCommands();
  sqlite.exec(readFileSync(FELLOW_LIFECYCLE_COMMANDS_MIGRATION, "utf8"));
  return sqlite;
}

function sponsorFellowCapDatabase(): Database {
  const sqlite = lifecycleCommandDatabase();
  sqlite.exec(readFileSync(SPONSOR_FELLOW_CAP_MIGRATION, "utf8"));
  return sqlite;
}

function sponsorEnrollmentRateDatabase(): Database {
  const sqlite = sponsorFellowCapDatabase();
  sqlite.exec(readFileSync(SPONSOR_ENROLLMENT_RATE_LIMIT_MIGRATION, "utf8"));
  return sqlite;
}

const BOOTSTRAP_INVARIANT_MIGRATION_ID = "0015_sponsor_enrollment_bootstrap_invariant.sql";
const BOOTSTRAP_INVARIANT_MIGRATION_SEQUENCE = 15;
const BOOTSTRAP_INVARIANT_MIGRATION_OBJECTS = [
  "sponsor_enrollment_bootstrap_migration_witness",
  "sponsor_enrollment_bootstrap_migration_witness_immutable_update",
  "sponsor_enrollment_bootstrap_migration_witness_immutable_delete",
  "enrollment_proposals_sponsor_bootstrap_decision",
  "enrollment_fellows_sponsor_bootstrap_insert",
  "enrollment_grants_sponsor_bootstrap_insert",
  "sponsors_enrollment_authority_delete",
  "sponsors_identity_history_immutable",
  "sponsors_enrollment_authority_duplicate_insert",
] as const;

/**
 * Mirrors the runner's one-command unit: the full migration followed by its
 * journal entry is one D1 transaction. A migration failure must leave neither
 * its durable witness nor an applied-history row behind, so a corrected retry
 * starts from exactly the preflight schema.
 */
function applyBootstrapInvariantMigrationBatch(sqlite: Database): void {
  const migration = readFileSync(SPONSOR_ENROLLMENT_BOOTSTRAP_INVARIANT_MIGRATION, "utf8");
  sqlite.run("BEGIN");
  let committed = false;
  try {
    sqlite.exec(migration);
    const witness = sqlite
      .prepare<{ singleton: number }, []>(
        `SELECT singleton
           FROM sponsor_enrollment_bootstrap_migration_witness
          WHERE singleton = 1`,
      )
      .get();
    // bun:sqlite's `exec` continues after this CHECK refusal, while Wrangler
    // reports the failed command. Treat the absent source-authored witness as
    // that command failure before committing so the explicit D1 transaction
    // still proves full-DDL and journal rollback.
    if (witness === null) {
      throw new Error("sponsor enrollment bootstrap witness CHECK rejected legacy history");
    }
    sqlite
      .prepare(
        `INSERT INTO _asimposium_migrations (id, sequence, digest, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        BOOTSTRAP_INVARIANT_MIGRATION_ID,
        BOOTSTRAP_INVARIANT_MIGRATION_SEQUENCE,
        createHash("sha256").update(migration).digest("hex"),
        "2026-08-16T00:00:00.000Z",
      );
    sqlite.run("COMMIT");
    committed = true;
  } catch (error) {
    if (!committed) sqlite.run("ROLLBACK");
    throw error;
  }
}

function createMigrationJournal(sqlite: Database): void {
  sqlite.exec(`CREATE TABLE _asimposium_migrations (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    digest TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
}

function expectBootstrapInvariantMigrationUnapplied(sqlite: Database): void {
  expect(
    sqlite
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM _asimposium_migrations WHERE id = ?",
      )
      .get(BOOTSTRAP_INVARIANT_MIGRATION_ID)?.n,
  ).toBe(0);
  for (const name of BOOTSTRAP_INVARIANT_MIGRATION_OBJECTS) {
    expect(
      sqlite
        .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?")
        .get(name)?.n,
    ).toBe(0);
  }
}

function expectBootstrapInvariantMigrationApplied(sqlite: Database): void {
  expect(
    sqlite
      .prepare<{ singleton: number; rule_version: number; passed: number }, []>(
        `SELECT singleton, rule_version, passed
           FROM sponsor_enrollment_bootstrap_migration_witness`,
      )
      .get(),
  ).toEqual({ singleton: 1, rule_version: 1, passed: 1 });
  expect(() =>
    sqlite
      .prepare(
        "UPDATE sponsor_enrollment_bootstrap_migration_witness SET rule_version = rule_version + 1",
      )
      .run(),
  ).toThrow("sponsor enrollment bootstrap witness is immutable");
  expect(() =>
    sqlite.prepare("DELETE FROM sponsor_enrollment_bootstrap_migration_witness").run(),
  ).toThrow("sponsor enrollment bootstrap witness cannot be deleted");
}

function sponsorEnrollmentBootstrapInvariantDatabase(): Database {
  const sqlite = sponsorEnrollmentRateDatabase();
  sqlite.exec(readFileSync(SPONSOR_ENROLLMENT_BOOTSTRAP_INVARIANT_MIGRATION, "utf8"));
  return sqlite;
}

function operatorFellowCapOverrideDatabase(): Database {
  const sqlite = sponsorEnrollmentBootstrapInvariantDatabase();
  sqlite.exec(readFileSync(OPERATOR_FELLOW_CAP_OVERRIDE_MIGRATION, "utf8"));
  return sqlite;
}

function databaseBeforeCredentialHardening(
  options: { readonly nullableDigest?: boolean } = {},
): Database {
  const sqlite = lifecycleDatabase(options);
  sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
  const deviceHardening = readFileSync(DEVICE_HARDENING_MIGRATION, "utf8");
  sqlite.exec(
    options.nullableDigest === true
      ? deviceHardening.replace("request_digest TEXT NOT NULL", "request_digest TEXT")
      : deviceHardening,
  );
  return sqlite;
}

function deviceDatabase(): Database {
  const sqlite = database();
  sqlite.exec(readFileSync(SPONSOR_MIGRATION, "utf8"));
  return sqlite;
}

const NOW = 1_786_000_000_000;
const STEP_UP_AT = Math.floor(NOW / 1_000);

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
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
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
          {
            device_expires_at: number | null;
            device_mapping_reclaimed_at: number | null;
          },
          [string]
        >(
          "SELECT device_expires_at, device_mapping_reclaimed_at FROM enrollment_records WHERE enrollment_id = ?",
        )
        .get(enrollmentId),
    ).toEqual({
      device_expires_at: deviceExpiresAt,
      device_mapping_reclaimed_at: null,
    });
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

  test("nzee: losing both pacing CAS attempts answers coarse slow-down for a healthy pending row", async () => {
    // Three-plus concurrent polls of one flow handle can lose the pacing CAS
    // twice; before the fix the post-loop check then threw FLOW_INVALID,
    // telling a legitimate poller its valid handle was bad. A concurrent
    // winner is simulated deterministically by bumping last_poll_at ahead of
    // every pacing UPDATE, so both in-poll attempts lose on stale snapshots.
    const sqlite = deviceDatabase();
    const input = deviceInput("nzee-race");
    let sabotages = 0;
    let armed = false; // arm only for the poll; deviceCreate writes the same column
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        onStatement: (query) => {
          if (armed && query.includes("poll_interval_seconds")) {
            sabotages += 1;
            sqlite
              .prepare(
                "UPDATE enrollment_proposals SET last_poll_at = COALESCE(last_poll_at, ?) + 1 WHERE proposal_id = ?",
              )
              .run(input.deviceExpiresAt - 2, input.proposal.proposalId);
          }
        },
      }),
    );
    await store.deviceCreate(input);
    armed = true;

    await expect(
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: input.deviceExpiresAt - 1,
        createToken: async () => {
          throw new Error("contention must not reach the token factory");
        },
      }),
    ).resolves.toMatchObject({ kind: "slow-down" });
    expect(sabotages).toBeGreaterThanOrEqual(2);
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(input.proposal.proposalId),
    ).toEqual({ status: "pending" });
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
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: NOW,
        createToken,
      }),
    ).resolves.toEqual({ kind: "pending", retryAfterSeconds: 5 });
    await expect(
      store.poll({
        flowHandleHash: input.proposal.flowHandleHash,
        now: NOW + 1,
        createToken,
      }),
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
    const sponsor = {
      type: "sponsor",
      sponsorId: "usr_stable_poll_d1",
    } as const;
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
    const approveOptions = {
      idempotencyKey: "d1-stable-poll-approve-1",
    } as const;
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
      step_up_authenticated_at: STEP_UP_AT,
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
    const denyCard = await service.deviceLookup(sponsor, {
      user_code: denyStart.user_code,
    });
    await service.decide(sponsor, denyCard.enrollmentId, {
      enrollment_id: denyCard.enrollmentId,
      decision: "deny",
      step_up_authenticated_at: STEP_UP_AT,
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
    const expireOptions = {
      idempotencyKey: "d1-stable-poll-expire-1",
    } as const;
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

  test("PLANTED: mounted device-token cap refusal rolls back, then expiry frees the same key", async () => {
    const { clock, service, sqlite } = d1DeviceServiceFixture();
    // `deviceDatabase()` applies shipped migrations 0002, 0006, 0009, 0010,
    // 0011, then 0008. Migration 0011 owns the active-credential cap trigger;
    // later enrollment migrations remain outside this fixture's proof boundary.
    const fixtureNow = NOW;
    clock.value = fixtureNow;
    const sponsor = { type: "sponsor", sponsorId: "usr_mounted_device_cap" } as const;
    const started = await service.deviceStart(
      {
        name: "mounted-device-cap",
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
      step_up_authenticated_at: Math.floor(fixtureNow / 1_000),
    });

    const target = sqlite
      .prepare<
        {
          proposal_id: string;
          fellow_id: string;
          sponsor_id: string;
          granted_scopes_json: string;
          granted_resources_json: string;
        },
        [string]
      >(
        `SELECT proposal.proposal_id, proposal.fellow_id, grant_row.sponsor_id,
                grant_row.granted_scopes_json, grant_row.granted_resources_json
           FROM enrollment_proposals AS proposal
           JOIN enrollment_grants AS grant_row ON grant_row.proposal_id = proposal.proposal_id
          WHERE proposal.enrollment_id = ?`,
      )
      .get(card.enrollmentId);
    if (target === null) throw new Error("approved device flow is missing its durable grant");

    // These use the approved Fellow's literal grant, so the real identity and
    // lifecycle triggers accept them. Two remain live; the third expires only
    // after the first mounted refusal, making the retry's capacity observable.
    expect(FELLOW_ACTIVE_CREDENTIAL_LIMIT).toBe(3);
    const capacityExpiryStepMs = 60_000;
    expect(capacityExpiryStepMs * 2).toBeLessThan(DEVICE_CODE_TTL_MS);
    const expiredSeedAt = fixtureNow + capacityExpiryStepMs;
    const seededHashes: string[] = [];
    const seedCredential = sqlite.prepare(
      `INSERT INTO fellow_tokens (
         credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
         granted_scopes_json, granted_resources_json, issued_at, expires_at,
         revoked_at, last_used_at, credential_profile, credential_origin
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'bearer', 'harness-migration')`,
    );
    for (let index = 0; index < FELLOW_ACTIVE_CREDENTIAL_LIMIT; index += 1) {
      const tokenHash = fixtureDigest(`mounted-device-cap-seed-${index}`);
      seededHashes.push(tokenHash);
      seedCredential.run(
        `cred-mounted-device-cap-${index}`,
        target.fellow_id,
        target.sponsor_id,
        tokenHash,
        target.granted_scopes_json,
        target.granted_resources_json,
        fixtureNow,
        index === FELLOW_ACTIVE_CREDENTIAL_LIMIT - 1
          ? expiredSeedAt
          : expiredSeedAt + capacityExpiryStepMs,
      );
    }
    const activeCredentialsAt = (at: number): number =>
      sqlite
        .prepare<{ n: number }, [string, number, number, number]>(
          `SELECT COUNT(*) AS n
             FROM fellow_tokens AS existing
             LEFT JOIN enrollment_sponsor_security AS security
               ON security.sponsor_id = existing.sponsor_id
            WHERE existing.fellow_id = ?
              AND existing.revoked_at IS NULL
              AND existing.issued_at <= ?
              AND existing.expires_at > ?
              AND (
                json_type(existing.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
                OR json_extract(existing.granted_resources_json, '$.fellowGrantExpiresAt') > ?
              )
              AND existing.issued_at > COALESCE(security.panic_at, -1)`,
        )
        .get(target.fellow_id, at, at, at)?.n ?? -1;
    expect(activeCredentialsAt(fixtureNow)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT);

    const key = "mounted-device-cap-retry-1";
    const body = JSON.stringify({ flow_handle: started.device_code });
    const mountedD1 = localD1(sqlite);
    const mountedStore = new D1EnrollmentStore(mountedD1);
    let mountedNow = fixtureNow;
    const app = createApp({
      createEnrollmentStore: () => mountedStore,
      enrollmentClock: { now: () => mountedNow },
    });
    const mountedEnv: Env = boundEnv({
      DB: mountedD1,
      ENROLLMENT_REPLAY_KEY: "A".repeat(43),
      STOA_ORIGIN: TEST_STOA_ORIGIN,
      AGORA_ORIGIN: "https://asimposium.org",
    });
    const poll = () =>
      app.fetch(
        new Request(`${TEST_STOA_ORIGIN}/v1/device-token`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body,
        }),
        mountedEnv,
      );
    const durableSnapshot = () => ({
      proposal:
        sqlite
          .prepare<
            { status: string; token_hash: string | null; token_issued_at: number | null },
            [string]
          >(
            `SELECT status, token_hash, token_issued_at
               FROM enrollment_proposals
              WHERE proposal_id = ?`,
          )
          .get(target.proposal_id) ?? null,
      credentials: sqlite
        .prepare<
          {
            credential_id: string;
            proposal_id: string | null;
            token_hash: string;
            issued_at: number;
            expires_at: number;
            revoked_at: number | null;
          },
          [string]
        >(
          `SELECT credential_id, proposal_id, token_hash, issued_at, expires_at, revoked_at
             FROM fellow_tokens
            WHERE fellow_id = ?
            ORDER BY credential_id`,
        )
        .all(target.fellow_id),
      pollReplays: sqlite
        .prepare<
          {
            scope: string;
            principal_scope: string;
            idempotency_key: string;
            request_digest: string;
            expires_at: number;
          },
          [string]
        >(
          `SELECT scope, principal_scope, idempotency_key, request_digest, expires_at
             FROM enrollment_idempotency
            WHERE scope = 'poll' AND idempotency_key = ?`,
        )
        .all(key),
    });
    const beforeRefusal = durableSnapshot();

    const refused = await poll();
    expect(refused.status).toBe(409);
    expect(refused.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    const refusedText = await refused.text();
    expect(JSON.parse(refusedText)).toEqual({
      type: "https://asimposium.org/errors/FELLOW_CREDENTIAL_CAP_REACHED",
      title: "Fellow credential capacity is reached",
      status: 409,
      code: "FELLOW_CREDENTIAL_CAP_REACHED",
      detail: "This Fellow already holds the most active credentials it may hold.",
      fix_hint:
        "Revoke an active credential from your console's Fellows list, then retry the exact request with a new Idempotency-Key.",
    });
    expect(refusedText).not.toContain(started.device_code);
    expect(refusedText).not.toContain(target.fellow_id);
    expect(refusedText).not.toContain(FELLOW_CREDENTIAL_CAP_SQL_TOKEN);
    for (const tokenHash of seededHashes) expect(refusedText).not.toContain(tokenHash);
    // The SQL abort must roll back both the proposed token and its encrypted
    // replay write. Otherwise this exact retry would replay a refusal forever.
    expect(durableSnapshot()).toEqual(beforeRefusal);

    // The expiry is a durable SQLite fact. Advance only this mounted app's
    // injected EnrollmentClock to that exact boundary, so one formerly live
    // seed expires without a timing-dependent wait or a process-global clock.
    expect(activeCredentialsAt(expiredSeedAt)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT - 1);
    mountedNow = expiredSeedAt;
    const issued = await poll();
    expect(issued.status).toBe(200);
    const issuedText = await issued.text();
    expect(JSON.parse(issuedText)).toEqual({
      status: "approved",
      token: expect.any(String),
      hello_url: `${TEST_STOA_ORIGIN}/v1/hello`,
      suggested_next: "GET /v1/hello with the bearer token",
    });
    expect(activeCredentialsAt(expiredSeedAt)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT);
    const afterIssue = durableSnapshot();
    expect(afterIssue.proposal).toEqual({
      status: "approved",
      token_hash: expect.any(String),
      token_issued_at: expiredSeedAt,
    });
    expect(
      afterIssue.credentials.filter((credential) => credential.proposal_id !== null),
    ).toHaveLength(1);
    expect(afterIssue.pollReplays).toHaveLength(1);

    const replay = await poll();
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(issuedText);
    expect(durableSnapshot()).toEqual(afterIssue);
  });

  test("D1 decision step-up refuses without mutation and replays a committed result after expiry", async () => {
    const { clock, service, sqlite } = d1DeviceServiceFixture();
    const sponsor = { type: "sponsor", sponsorId: "usr_decision_step_up_d1" } as const;
    const started = await service.deviceStart(
      {
        name: "d1-decision-step-up",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.67" },
    );
    const card = await service.deviceLookup(sponsor, { user_code: started.user_code });
    const options = { idempotencyKey: "d1-decision-step-up-1" } as const;
    await expect(
      service.decide(
        sponsor,
        card.enrollmentId,
        {
          enrollment_id: card.enrollmentId,
          decision: "approve",
          step_up_authenticated_at:
            STEP_UP_AT - SPONSOR_STEP_UP_WINDOW_SECONDS - SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS - 1,
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE enrollment_id = ?",
        )
        .get(card.enrollmentId),
    ).toEqual({ status: "pending" });
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'decision'",
        )
        .get()?.n,
    ).toBe(0);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(0);

    const committed = {
      enrollment_id: card.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: STEP_UP_AT,
    } as const;
    await expect(
      service.decide(sponsor, card.enrollmentId, committed, options),
    ).resolves.toBeUndefined();
    clock.value +=
      (SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1) * 1_000;
    await expect(
      service.decide(sponsor, card.enrollmentId, committed, options),
    ).resolves.toBeUndefined();
    await expect(
      service.decide(
        sponsor,
        card.enrollmentId,
        { ...committed, step_up_authenticated_at: Math.floor(clock.value / 1_000) },
        options,
      ),
    ).resolves.toBeUndefined();
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'decision'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(1);
  });

  test("D1 same-key decisions converge after both replay preflights miss", async () => {
    const clock = new DeviceTestClock();
    const sqlite = deviceDatabase();
    let barrierEnabled = false;
    let preflightReaders = 0;
    let releasePreflights: (() => void) | undefined;
    const bothPreflightsRead = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    const db = localD1(sqlite, {
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!barrierEnabled || !query.includes("FROM enrollment_idempotency")) return;
        preflightReaders += 1;
        if (preflightReaders === 2) {
          barrierEnabled = false;
          releasePreflights?.();
        }
        await bothPreflightsRead;
      },
    });
    const service = new EnrollmentService({
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
      clock,
      store: new D1EnrollmentStore(db),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const sponsor = { type: "sponsor", sponsorId: "usr_decision_race_d1" } as const;
    const started = await service.deviceStart(
      {
        name: "d1-decision-race-replay",
        model: "test-model",
        harness: "codex",
        requested_scopes: ["review"],
      },
      { trustedClientAddress: "198.51.100.68" },
    );
    const card = await service.deviceLookup(sponsor, { user_code: started.user_code });
    const command = {
      enrollment_id: card.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: STEP_UP_AT,
    } as const;
    const options = { idempotencyKey: "d1-decision-race-replay-1" } as const;

    barrierEnabled = true;
    await expect(
      Promise.all([
        service.decide(sponsor, card.enrollmentId, command, options),
        service.decide(sponsor, card.enrollmentId, command, options),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    expect(preflightReaders).toBe(2);
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE enrollment_id = ?",
        )
        .get(card.enrollmentId),
    ).toEqual({ status: "approved" });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'decision'",
        )
        .get()?.n,
    ).toBe(1);
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
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
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
    const card = await service.deviceLookup(sponsor, {
      user_code: started.user_code,
    });
    await service.decide(sponsor, card.enrollmentId, {
      enrollment_id: card.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: STEP_UP_AT,
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
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
      clock,
      store: new D1EnrollmentStore(localD1(sqlite)),
      replayProtector: protector,
    });
    const sponsor = {
      type: "sponsor",
      sponsorId: "usr_legacy_poll_replay_d1",
    } as const;
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
      step_up_authenticated_at: STEP_UP_AT,
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
    const issuedCard = await service.deviceLookup(sponsor, {
      user_code: issuedStart.user_code,
    });
    await service.decide(sponsor, issuedCard.enrollmentId, {
      enrollment_id: issuedCard.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: STEP_UP_AT,
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
    ).rejects.toMatchObject({
      code: "FLOW_INVALID",
    } satisfies Partial<EnrollmentError>);
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
      await store.deviceCreate({
        ...deviceInput(`rate-${index}`),
        clientBucket: bucket,
      });
    }
    await expect(
      store.deviceCreate({
        ...deviceInput("rate-refused"),
        clientBucket: bucket,
      }),
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
      store.deviceCreate({
        ...deviceInput("other-source"),
        clientBucket: "c".repeat(64),
      }),
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
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    } satisfies Partial<EnrollmentError>);

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
          {
            device_mapping_reclaimed_at: number | null;
            device_expires_at: number | null;
          },
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
    ).rejects.toMatchObject({
      code: "DEVICE_CODE_UNKNOWN",
    } satisfies Partial<EnrollmentError>);
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
        decision: {
          enrollment_id: input.record.enrollmentId,
          decision: "approve",
        },
        now: input.deviceExpiresAt,
      }),
    ).rejects.toMatchObject({
      code: "PAIRING_INVALID",
    } satisfies Partial<EnrollmentError>);

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
          decision: {
            enrollment_id: input.record.enrollmentId,
            decision: "approve",
          },
          now: NOW + elapsedMs,
        }),
      ).rejects.toMatchObject({
        code: "PROPOSAL_EXPIRED",
      } satisfies Partial<EnrollmentError>);
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
          decision: {
            enrollment_id: input.record.enrollmentId,
            decision: "approve",
          },
          now: NOW + elapsedMs,
        }),
      ).rejects.toMatchObject({
        code: "PROPOSAL_EXPIRED",
      } satisfies Partial<EnrollmentError>);
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
      ).rejects.toMatchObject({
        code: "PROPOSAL_NOT_PENDING",
      } satisfies Partial<EnrollmentError>);

      const state = sqlite
        .prepare<{ sponsor_id: string; status: string }, [string]>(
          `SELECT e.sponsor_id, p.status
             FROM enrollment_records e
             JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
            WHERE e.enrollment_id = ?`,
        )
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
  decisionStatus: "approved" | "reduced" = "approved",
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
          SET status = ?, granted_scopes_json = ?, granted_resources_json = ?
        WHERE proposal_id = ?`,
    )
    .run(decisionStatus, scopesJson, resourcesJson, LIFECYCLE_PROPOSAL);
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

/** Raw D1 fixture for pagination: all authority joins stay real, no mocked rows. */
function seedSponsorFellowPage(sqlite: Database, tiedCount: number): void {
  const insertRecord = sqlite.prepare(
    `INSERT INTO enrollment_records (
       enrollment_id, sponsor_id, secret_hash, secret_expires_at,
       requested_scopes_json, requested_resources_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertProposal = sqlite.prepare(
    `INSERT INTO enrollment_proposals (
       proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
       created_at, expires_at, status, granted_scopes_json, granted_resources_json,
       token_hash, token_issued_at, poll_interval_seconds
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 5)`,
  );
  const approveProposal = sqlite.prepare(
    `UPDATE enrollment_proposals
        SET status = 'approved', granted_scopes_json = ?, granted_resources_json = ?
      WHERE proposal_id = ?`,
  );
  const insertFellow = sqlite.prepare(
    `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertGrant = sqlite.prepare(
    `INSERT INTO enrollment_grants (
       proposal_id, fellow_id, sponsor_id, granted_scopes_json,
       granted_resources_json, granted_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const scopes = '["review"]';
  const resources = "{}";

  for (let index = 0; index <= tiedCount; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const enrollmentId = fixtureEnrollmentId(`pagination-${suffix}`);
    const proposalId = `proposal-pagination-${suffix}`;
    const fellowId = `fellow-page-${suffix}`;
    const name = `page-fellow-${suffix}`;
    const grantedAt = index === tiedCount ? NOW - 1 : NOW;
    insertRecord.run(
      enrollmentId,
      LIFECYCLE_SPONSOR,
      fixtureDigest(`pagination-secret-${suffix}`),
      NOW + 30 * 60_000,
      scopes,
      resources,
      NOW,
    );
    insertProposal.run(
      proposalId,
      enrollmentId,
      fellowId,
      fixtureDigest(`pagination-flow-${suffix}`),
      name,
      "test-model",
      "codex",
      grantedAt,
      grantedAt + PENDING_PROPOSAL_TTL_MS,
    );
    approveProposal.run(scopes, resources, proposalId);
    insertFellow.run(fellowId, LIFECYCLE_SPONSOR, name, "test-model", "codex", NOW);
    insertGrant.run(proposalId, fellowId, LIFECYCLE_SPONSOR, scopes, resources, grantedAt);
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

/**
 * W3.7 per-Fellow active credential cap (asimposiumorg-kj90).
 *
 * The authority is `enrollment_credentials_active_cap` in the SHIPPED 0006
 * migration, re-asserted by 0011 — `database()` loads both, so these run the
 * real trigger and not a fixture of it. Rows are seeded inline rather than
 * through `insertLifecycleCredential`, which pins fellow_id to LIFECYCLE_FELLOW
 * and so cannot express the isolation cases.
 */
const CAP_FELLOW = "fellow-cap-subject";
const CAP_OTHER_FELLOW = "fellow-cap-neighbour";
const CAP_OTHER_SPONSOR = "usr_cap_other_sponsor";
const CAP_AT = 1_760_000_000_000;

function seedCapAuthority(
  sqlite: Database,
  input: {
    readonly label: string;
    readonly fellowId: string;
    readonly sponsorId: string;
    readonly name: string;
  },
): void {
  const enrollmentId = fixtureEnrollmentId(`cap-${input.label}`);
  const proposalId = `proposal-cap-${input.label}`;
  const recordCreatedAt = CAP_AT - 1;
  const scopes = '["review"]';
  const resources = "{}";
  sqlite
    .prepare(
      `INSERT INTO enrollment_records (
         enrollment_id, sponsor_id, secret_hash, secret_expires_at,
         requested_scopes_json, requested_resources_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      enrollmentId,
      input.sponsorId,
      fixtureDigest(`cap-secret-${input.label}`),
      recordCreatedAt + ENROLLMENT_SECRET_TTL_MS,
      scopes,
      resources,
      recordCreatedAt,
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
      proposalId,
      enrollmentId,
      input.fellowId,
      fixtureDigest(`cap-flow-${input.label}`),
      input.name,
      "test-model",
      "codex",
      CAP_AT - 1,
      recordCreatedAt + PENDING_PROPOSAL_TTL_MS,
    );
  sqlite
    .prepare(
      `UPDATE enrollment_proposals
          SET status = 'approved', granted_scopes_json = ?, granted_resources_json = ?
        WHERE proposal_id = ?`,
    )
    .run(scopes, resources, proposalId);
  sqlite
    .prepare(
      `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.fellowId, input.sponsorId, input.name, "test-model", "codex", CAP_AT);
  sqlite
    .prepare(
      `INSERT INTO enrollment_grants (
         proposal_id, fellow_id, sponsor_id, granted_scopes_json,
         granted_resources_json, granted_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(proposalId, input.fellowId, input.sponsorId, scopes, resources, CAP_AT);
}

function capDatabase(): Database {
  const sqlite = database();
  seedCapAuthority(sqlite, {
    label: "subject",
    fellowId: CAP_FELLOW,
    sponsorId: LIFECYCLE_SPONSOR,
    name: "cap-subject",
  });
  seedCapAuthority(sqlite, {
    label: "neighbour",
    fellowId: CAP_OTHER_FELLOW,
    sponsorId: LIFECYCLE_SPONSOR,
    name: "cap-neighbour",
  });
  seedCapAuthority(sqlite, {
    label: "other-sponsor",
    fellowId: CAP_OTHER_SPONSOR,
    sponsorId: CAP_OTHER_SPONSOR,
    name: "other-sponsor-fellow",
  });
  return sqlite;
}

function mintCredential(
  sqlite: Database,
  input: {
    readonly label: string;
    readonly fellowId?: string;
    readonly sponsorId?: string;
    readonly issuedAt?: number;
    readonly expiresAt?: number;
    readonly revokedAt?: number | null;
  },
): void {
  const issuedAt = input.issuedAt ?? CAP_AT;
  sqlite
    .prepare(
      `INSERT INTO fellow_tokens (
         credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
         granted_scopes_json, granted_resources_json, issued_at, expires_at,
         revoked_at, last_used_at, credential_profile, credential_origin
       ) VALUES (?, NULL, ?, ?, ?, '["review"]', '{}', ?, ?, ?, NULL, 'bearer', 'harness-migration')`,
    )
    .run(
      `cred-${input.label}`,
      input.fellowId ?? CAP_FELLOW,
      input.sponsorId ?? LIFECYCLE_SPONSOR,
      fixtureDigest(`cap-${input.label}`),
      issuedAt,
      input.expiresAt ?? issuedAt + TOKEN_TTL_MS,
      input.revokedAt ?? null,
    );
}

function activeCount(sqlite: Database, fellowId: string, at: number): number {
  return (
    sqlite
      .prepare<{ n: number }, [string, number, number]>(
        `SELECT COUNT(*) AS n FROM fellow_tokens
          WHERE fellow_id = ? AND revoked_at IS NULL AND issued_at <= ? AND expires_at > ?`,
      )
      .get(fellowId, at, at)?.n ?? -1
  );
}

function fillToCap(sqlite: Database): void {
  for (let index = 0; index < FELLOW_ACTIVE_CREDENTIAL_LIMIT; index += 1) {
    mintCredential(sqlite, { label: `seed-${index}` });
  }
}

describe("W3.7 per-Fellow active credential cap", () => {
  test("the shipped migration raises the exact token this store matches", () => {
    const shipped = readFileSync(LIFECYCLE_MIGRATION, "utf8");
    expect(shipped).toContain(`RAISE(ABORT, '${FELLOW_CREDENTIAL_CAP_SQL_TOKEN}')`);
    // The threshold in SQL and the contract's exported limit are one number in
    // two files. Pin them together or the response bound and the storage
    // authority can drift apart without any test noticing.
    expect(shipped).toContain(`) >= ${FELLOW_ACTIVE_CREDENTIAL_LIMIT}`);
    expect(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8")).toContain(
      `RAISE(ABORT, '${FELLOW_CREDENTIAL_CAP_SQL_TOKEN}')`,
    );
  });

  test("a fourth active credential is refused and leaves exactly three", () => {
    const sqlite = capDatabase();
    fillToCap(sqlite);
    expect(activeCount(sqlite, CAP_FELLOW, CAP_AT)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT);
    expect(() => mintCredential(sqlite, { label: "fourth" })).toThrow(
      FELLOW_CREDENTIAL_CAP_SQL_TOKEN,
    );
    // The abort rolled the row back rather than leaving a fourth behind.
    expect(activeCount(sqlite, CAP_FELLOW, CAP_AT)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM fellow_tokens WHERE credential_id = ?",
        )
        .get("cred-fourth")?.n,
    ).toBe(0);
    sqlite.close();
  });

  test("revocation frees exactly one slot", () => {
    const sqlite = capDatabase();
    fillToCap(sqlite);
    expect(() => mintCredential(sqlite, { label: "blocked" })).toThrow(
      FELLOW_CREDENTIAL_CAP_SQL_TOKEN,
    );
    sqlite
      .prepare("UPDATE fellow_tokens SET revoked_at = ? WHERE credential_id = ?")
      .run(CAP_AT + 1, "cred-seed-0");
    mintCredential(sqlite, { label: "after-revoke", issuedAt: CAP_AT + 2 });
    expect(activeCount(sqlite, CAP_FELLOW, CAP_AT + 2)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT);
    // And the freed slot is not a second slot: the cap still bites.
    expect(() => mintCredential(sqlite, { label: "still-capped", issuedAt: CAP_AT + 3 })).toThrow(
      FELLOW_CREDENTIAL_CAP_SQL_TOKEN,
    );
    sqlite.close();
  });

  test("expiry measured against the new row's issue instant frees a slot", () => {
    const sqlite = capDatabase();
    mintCredential(sqlite, { label: "short", expiresAt: CAP_AT + 10 });
    mintCredential(sqlite, { label: "long-a" });
    mintCredential(sqlite, { label: "long-b" });
    // At CAP_AT the short credential is still live, so the cap refuses.
    expect(() => mintCredential(sqlite, { label: "too-early", issuedAt: CAP_AT + 5 })).toThrow(
      FELLOW_CREDENTIAL_CAP_SQL_TOKEN,
    );
    // At its expiry instant it is expired — the predicate is strict `>`.
    mintCredential(sqlite, { label: "after-expiry", issuedAt: CAP_AT + 10 });
    expect(activeCount(sqlite, CAP_FELLOW, CAP_AT + 10)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT);
    sqlite.close();
  });

  test("a sponsor panic frees every pre-panic slot", () => {
    const sqlite = capDatabase();
    fillToCap(sqlite);
    sqlite
      .prepare(
        `INSERT INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(LIFECYCLE_SPONSOR, CAP_AT + 100, CAP_AT + 100);
    // Pre-panic rows stop consuming capacity, so a post-panic mint is admitted.
    mintCredential(sqlite, { label: "post-panic", issuedAt: CAP_AT + 101 });
    // A credential minted on the panic boundary itself is still refused.
    expect(() =>
      mintCredential(sqlite, { label: "on-boundary", issuedAt: CAP_AT + 100 }),
    ).toThrow();
    sqlite.close();
  });

  test("the cap is scoped to one Fellow and does not cross sponsors", () => {
    const sqlite = capDatabase();
    fillToCap(sqlite);
    expect(() => mintCredential(sqlite, { label: "capped" })).toThrow(
      FELLOW_CREDENTIAL_CAP_SQL_TOKEN,
    );
    // A different Fellow under the SAME sponsor is unaffected.
    mintCredential(sqlite, { label: "neighbour", fellowId: CAP_OTHER_FELLOW });
    // As is a Fellow under a different sponsor.
    mintCredential(sqlite, {
      label: "other-sponsor",
      fellowId: CAP_OTHER_SPONSOR,
      sponsorId: CAP_OTHER_SPONSOR,
    });
    expect(activeCount(sqlite, CAP_OTHER_FELLOW, CAP_AT)).toBe(1);
    expect(activeCount(sqlite, CAP_OTHER_SPONSOR, CAP_AT)).toBe(1);
    expect(activeCount(sqlite, CAP_FELLOW, CAP_AT)).toBe(FELLOW_ACTIVE_CREDENTIAL_LIMIT);
    sqlite.close();
  });
});

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
      .prepare<
        {
          expires_at: number;
          credential_profile: string;
          proposal_id: string | null;
        },
        []
      >(
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
    expect(inventoryQuery).toContain("sponsor_fellow_keys AS MATERIALIZED");
    expect(inventoryQuery).toContain("LIMIT 501");
    expect(inventoryQuery).toContain("LIMIT 1501");
    expect(sponsorPlan).toContain("enrollment_grants_sponsor_page_idx");
    expect(sponsorPlan).toContain("enrollment_credentials_sponsor_fellow_lifecycle_idx");
    expect(sponsorPlan).not.toContain("SCAN grant_key");
  });

  test("PLANTED: 501 tied Fellow grants use both bounded 0011 keyset branches before authority joins", async () => {
    const sqlite = database();
    // 501 equal timestamps prove the Fellow-id tie-breaker. One older grant
    // proves the continuation's second, independently bounded index branch.
    seedSponsorFellowPage(sqlite, SPONSOR_FELLOW_PAGE_SIZE + 1);
    const recording = recordingD1(sqlite);
    const store = new D1EnrollmentStore(recording.db);

    const first = await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW);
    expect(first.fellows).toHaveLength(SPONSOR_FELLOW_PAGE_SIZE);
    expect(first.fellows[0]?.fellowId).toBe("fellow-page-0000");
    expect(first.fellows.at(-1)?.fellowId).toBe("fellow-page-0499");
    expect(first.nextCursor).toEqual({
      granted_at: NOW,
      fellow_id: "fellow-page-0499",
    });

    const after = first.nextCursor;
    if (after === undefined) throw new Error("tied 501st row did not mint a continuation key");
    const second = await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW, after);
    expect(second).toMatchObject({
      fellows: [
        { fellowId: "fellow-page-0500", grantedAt: NOW },
        { fellowId: "fellow-page-0501", grantedAt: NOW - 1 },
      ],
    });
    expect(second.fellows).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();

    const continuationQuery = recording.issued.at(-1);
    expect(continuationQuery).toBeDefined();
    const query = continuationQuery as string;
    expect(query).toContain("same_timestamp_keys AS MATERIALIZED");
    expect(query).toContain("older_timestamp_keys AS MATERIALIZED");
    expect(query).toContain("AND grant_key.granted_at = ?");
    expect(query).toContain("AND grant_key.fellow_id > ?");
    expect(query).toContain("AND grant_key.granted_at < ?");
    expect(query.match(/INDEXED BY enrollment_grants_sponsor_page_idx/g)?.length).toBe(2);
    expect(query.match(/LIMIT 501/g)?.length).toBeGreaterThanOrEqual(3);
    expect(query).toContain("LIMIT 1501");
    expect(query.indexOf("sponsor_fellow_keys AS MATERIALIZED")).toBeLessThan(
      query.indexOf("LEFT JOIN enrollment_fellows fellow"),
    );
    expect(query).toContain(
      "ORDER BY f.granted_at DESC, f.fellow_id ASC, c.issued_at DESC, c.credential_id ASC",
    );

    const plan = sqlite
      .prepare<{ detail: string }, LocalBinding[]>(`EXPLAIN QUERY PLAN ${query}`)
      .all(
        LIFECYCLE_SPONSOR,
        after.granted_at,
        after.fellow_id,
        LIFECYCLE_SPONSOR,
        after.granted_at,
        NOW,
        NOW,
        NOW,
      )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("MATERIALIZE same_timestamp_keys");
    expect(plan).toContain("MATERIALIZE older_timestamp_keys");
    expect(plan).toContain(
      "SEARCH grant_key USING INDEX enrollment_grants_sponsor_page_idx (sponsor_id=? AND granted_at=? AND fellow_id>?)",
    );
    expect(plan).toContain(
      "SEARCH grant_key USING INDEX enrollment_grants_sponsor_page_idx (sponsor_id=? AND granted_at<?)",
    );
    expect(plan.match(/enrollment_grants_sponsor_page_idx/g)?.length).toBeGreaterThanOrEqual(2);
    expect(plan).toContain("enrollment_credentials_sponsor_fellow_lifecycle_idx");
    expect(plan).not.toContain("SCAN grant_key");
  });

  test("PLANTED: a real corrupt top key fails closed instead of truncating its valid later Fellow", async () => {
    const sqlite = database();
    // Seed two real, valid durable grants: the later timestamp is the page
    // head; the older one must stay valid and reachable if the corrupt head
    // were ever silently inner-joined away.
    seedSponsorFellowPage(sqlite, 1);
    const store = new D1EnrollmentStore(localD1(sqlite));
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW)).fellows).toMatchObject([
      { fellowId: "fellow-page-0000", grantedAt: NOW },
      { fellowId: "fellow-page-0001", grantedAt: NOW - 1 },
    ]);

    // This is the one guard that makes the planted authority mismatch
    // impossible in current D1 history. Disable only it in this in-memory
    // fixture, then leave the older authority chain untouched.
    sqlite.exec("DROP TRIGGER enrollment_proposals_identity_immutable");
    sqlite
      .prepare("UPDATE enrollment_proposals SET harness = 'corrupt-harness' WHERE proposal_id = ?")
      .run("proposal-pagination-0000");
    expect(
      sqlite
        .prepare<{ harness: string }, [string]>(
          "SELECT harness FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get("proposal-pagination-0001"),
    ).toEqual({ harness: "codex" });

    await expect(store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW)).rejects.toBeInstanceOf(
      EnrollmentPersistenceError,
    );
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
        resources: JSON.stringify({
          fellowGrantExpiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        }),
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
      {
        label: "duplicate scope",
        scopes: '["review","review"]',
        resources: "{}",
      },
      {
        label: "unknown resource",
        scopes: '["review"]',
        resources: '{"mystery":true}',
      },
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
        resources: JSON.stringify({
          fellowGrantExpiresAt: NOW + 31_536_000_001,
        }),
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
      {
        label: "duplicate scope",
        scopes: '["review","review"]',
        resources: "{}",
      },
      {
        label: "unknown resource",
        scopes: '["review"]',
        resources: '{"mystery":1}',
      },
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
        resources: JSON.stringify({
          firstDirective: `x\u0000${"a".repeat(2_100)}`,
        }),
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
        resources: JSON.stringify({
          firstDirective: `x\u0000${"a".repeat(2_100)}`,
        }),
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
      {
        grantedAt: NOW + 0.5,
        expected: "enrollment grant evidence schema invalid",
      },
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
      {
        id: `credential\u0000${"x".repeat(200)}`,
        expiresAt: NOW + TOKEN_TTL_MS,
      },
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

  test("requested authority is a ceiling for upgrade, future grants, polling, and authentication", async () => {
    const cases = [
      {
        label: "reduced event cap removed",
        status: "reduced",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"eventBudget":10}',
        grantedResources: "{}",
      },
      {
        label: "reduced artifact cap removed",
        status: "reduced",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"artifactBudgetBytes":4096}',
        grantedResources: "{}",
      },
      {
        label: "reduced grant expiry removed",
        status: "reduced",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: JSON.stringify({
          fellowGrantExpiresAt: NOW + 10_000,
        }),
        grantedResources: "{}",
      },
      {
        label: "reduced authority is unchanged",
        status: "reduced",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: "{}",
        grantedResources: "{}",
      },
      {
        label: "reduced scopes are empty",
        status: "reduced",
        requestedScopes: '["review"]',
        grantedScopes: "[]",
        requestedResources: "{}",
        grantedResources: "{}",
        futureError: "enrollment grant authority schema invalid",
        authError: true,
      },
      {
        label: "reduced text binding is added",
        status: "reduced",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: "{}",
        grantedResources: '{"problemBinding":"P-4DSP"}',
      },
      {
        label: "reduced text binding is replaced",
        status: "reduced",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"problemBinding":"P-4DSP"}',
        grantedResources: '{"problemBinding":"P-OTHER"}',
      },
      {
        label: "approved scope escalated",
        status: "approved",
        requestedScopes: '["review"]',
        grantedScopes: '["promote"]',
        requestedResources: "{}",
        grantedResources: "{}",
      },
      {
        label: "approved event cap escalated",
        status: "approved",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"eventBudget":10}',
        grantedResources: '{"eventBudget":11}',
      },
      {
        label: "approved scope narrowed",
        status: "approved",
        requestedScopes: '["promote","review"]',
        grantedScopes: '["review"]',
        requestedResources: "{}",
        grantedResources: "{}",
      },
      {
        label: "approved text binding dropped",
        status: "approved",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"problemBinding":"P-4DSP"}',
        grantedResources: "{}",
      },
      {
        label: "approved event cap narrowed",
        status: "approved",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"eventBudget":10}',
        grantedResources: '{"eventBudget":5}',
      },
      {
        label: "approved finite cap introduced",
        status: "approved",
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: "{}",
        grantedResources: '{"eventBudget":5}',
      },
    ] as const;

    for (const fixture of cases) {
      const retained = new Database(":memory:", { strict: true });
      retained.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(
        retained,
        fixture.grantedResources,
        fixture.grantedScopes,
        NOW,
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
        fixture.requestedResources,
        fixture.requestedScopes,
        false,
        fixture.status,
      );
      retained.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      expectCredentialHardeningGuardRollback(retained);

      const future = database();
      expect(() =>
        seedLifecycleIdentity(
          future,
          fixture.grantedResources,
          fixture.grantedScopes,
          NOW,
          NOW,
          NOW + PENDING_PROPOSAL_TTL_MS,
          fixture.requestedResources,
          fixture.requestedScopes,
          false,
          fixture.status,
        ),
      ).toThrow(
        "futureError" in fixture
          ? fixture.futureError
          : "enrollment grant approval binding mismatch",
      );
      expect(
        future.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
        fixture.label,
      ).toBe(0);

      const pollDatabase = databaseBeforeCredentialHardening();
      seedLifecycleIdentity(
        pollDatabase,
        fixture.grantedResources,
        fixture.grantedScopes,
        NOW,
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
        fixture.requestedResources,
        fixture.requestedScopes,
        false,
        fixture.status,
      );
      const pollStore = new D1EnrollmentStore(localD1(pollDatabase));
      let tokenFactoryCalls = 0;
      let pollFailure: unknown;
      try {
        await pollStore.poll({
          flowHandleHash: "lifecycle-flow-hash",
          now: NOW + 1,
          createToken: async () => {
            tokenFactoryCalls += 1;
            return { token: "must-not-escape", tokenHash: "must-not-persist" };
          },
        });
      } catch (error) {
        pollFailure = error;
      }
      expect(pollFailure, fixture.label).toBeInstanceOf(EnrollmentPersistenceError);
      expect(tokenFactoryCalls, fixture.label).toBe(0);
      expect(
        pollDatabase
          .prepare<{ token_hash: string | null }, [string]>(
            "SELECT token_hash FROM enrollment_proposals WHERE proposal_id = ?",
          )
          .get(LIFECYCLE_PROPOSAL)?.token_hash,
        fixture.label,
      ).toBeNull();

      const authDatabase = databaseBeforeCredentialHardening();
      seedLifecycleIdentity(
        authDatabase,
        fixture.grantedResources,
        fixture.grantedScopes,
        NOW,
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
        fixture.requestedResources,
        fixture.requestedScopes,
        true,
        fixture.status,
      );
      insertLifecycleCredential(authDatabase, {
        id: `credential-request-ceiling-${fixture.label.replaceAll(" ", "-")}`,
        hash: "token-hash-1",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
        scopesJson: fixture.grantedScopes,
        resourcesJson: fixture.grantedResources,
      });
      const authStore = new D1EnrollmentStore(localD1(authDatabase));
      let authFailure: unknown;
      let authBinding: unknown;
      try {
        authBinding = await authStore.authenticateCredential("token-hash-1", NOW + 1, "bearer");
      } catch (error) {
        authFailure = error;
      }
      if ("authError" in fixture) {
        expect(authFailure, fixture.label).toBeInstanceOf(EnrollmentPersistenceError);
      } else {
        expect(authFailure, fixture.label).toBeUndefined();
        expect(authBinding, fixture.label).toBeUndefined();
      }
      expect(
        authDatabase
          .prepare<{ last_used_at: number | null }, [string]>(
            "SELECT last_used_at FROM fellow_tokens WHERE token_hash = ?",
          )
          .get("token-hash-1")?.last_used_at,
        fixture.label,
      ).toBeNull();
    }
  });

  test("valid strict reductions survive upgrade, future issuance, and authentication", async () => {
    const validCases = [
      {
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: "{}",
        grantedResources: '{"eventBudget":5}',
      },
      {
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"eventBudget":10}',
        grantedResources: '{"eventBudget":5}',
      },
      {
        requestedScopes: '["promote","review"]',
        grantedScopes: '["review"]',
        requestedResources: "{}",
        grantedResources: "{}",
      },
      {
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"problemBinding":"P-4DSP"}',
        grantedResources: "{}",
      },
      {
        requestedScopes: '["review"]',
        grantedScopes: '["review"]',
        requestedResources: '{"problemBinding":"P-4DSP","eventBudget":10}',
        grantedResources: '{"problemBinding":"P-4DSP","eventBudget":5}',
      },
    ] as const;

    for (const [index, fixture] of validCases.entries()) {
      const retained = databaseBeforeCredentialHardening();
      seedLifecycleIdentity(
        retained,
        fixture.grantedResources,
        fixture.grantedScopes,
        NOW,
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
        fixture.requestedResources,
        fixture.requestedScopes,
        true,
        "reduced",
      );
      insertLifecycleCredential(retained, {
        id: `credential-retained-valid-reduction-${index}`,
        hash: "token-hash-1",
        issuedAt: NOW,
        proposalId: LIFECYCLE_PROPOSAL,
        scopesJson: fixture.grantedScopes,
        resourcesJson: fixture.grantedResources,
      });
      expect(() =>
        retained.exec(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8")),
      ).not.toThrow();
      const retainedBinding = await new D1EnrollmentStore(localD1(retained)).authenticateCredential(
        "token-hash-1",
        NOW + 1,
        "bearer",
      );
      expect(retainedBinding?.grantedScopes).toEqual(JSON.parse(fixture.grantedScopes));
      expect(retainedBinding?.grantedResources).toEqual(JSON.parse(fixture.grantedResources));

      const sqlite = database();
      seedLifecycleIdentity(
        sqlite,
        fixture.grantedResources,
        fixture.grantedScopes,
        NOW,
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
        fixture.requestedResources,
        fixture.requestedScopes,
        false,
        "reduced",
      );
      const store = new D1EnrollmentStore(localD1(sqlite));
      let tokenFactoryCalls = 0;
      const tokenHash = fixtureDigest(`valid-reduction-${index}`);
      const result = await store.poll({
        flowHandleHash: "lifecycle-flow-hash",
        now: NOW + 1,
        createToken: async () => {
          tokenFactoryCalls += 1;
          return {
            token:
              "asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            tokenHash,
          };
        },
      });
      expect(result).toMatchObject({ kind: "issued" });
      expect(tokenFactoryCalls).toBe(1);
      const binding = await store.authenticateCredential(tokenHash, NOW + 2, "bearer");
      expect(binding?.grantedScopes).toEqual(JSON.parse(fixture.grantedScopes));
      expect(binding?.grantedResources).toEqual(JSON.parse(fixture.grantedResources));
    }
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

  test("pre-0011 polling refuses a durable grant that differs from the recorded approval", async () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(
      sqlite,
      "{}",
      '["review"]',
      NOW,
      NOW,
      NOW + PENDING_PROPOSAL_TTL_MS,
      "{}",
      '["promote","review"]',
      false,
      "reduced",
    );
    sqlite
      .prepare(
        `UPDATE enrollment_grants
            SET granted_scopes_json = '["promote"]'
          WHERE proposal_id = ?`,
      )
      .run(LIFECYCLE_PROPOSAL);
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
    let tokenFactoryCalls = 0;
    await expect(
      new D1EnrollmentStore(localD1(sqlite)).poll({
        flowHandleHash: "lifecycle-flow-hash",
        now: NOW + 1,
        createToken: async () => {
          tokenFactoryCalls += 1;
          return {
            token:
              "asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            tokenHash: fixtureDigest("mismatched-approval-token"),
          };
        },
      }),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(tokenFactoryCalls).toBe(0);
    expect(
      sqlite
        .prepare<{ token_hash: string | null }, [string]>(
          "SELECT token_hash FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(LIFECYCLE_PROPOSAL)?.token_hash,
    ).toBeNull();
    expect(
      sqlite.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM fellow_tokens").get()
        ?.count,
    ).toBe(0);
  });

  test.each([
    ["before proposal creation", NOW - 1, NOW + 1],
    ["at proposal expiry", NOW + PENDING_PROPOSAL_TTL_MS, NOW + PENDING_PROPOSAL_TTL_MS - 1],
    ["in the future", NOW + 100, NOW + 1],
  ] as const)(
    "pre-0011 polling refuses durable grant evidence %s without burning the flow",
    async (_case, grantedAt, pollNow) => {
      const sqlite = new Database(":memory:", { strict: true });
      sqlite.run(readFileSync(MIGRATION, "utf8"));
      seedLifecycleIdentity(
        sqlite,
        "{}",
        '["review"]',
        grantedAt,
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
        "{}",
        '["review"]',
        false,
      );
      sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
      sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
      sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
      let tokenFactoryCalls = 0;

      await expect(
        new D1EnrollmentStore(localD1(sqlite)).poll({
          flowHandleHash: "lifecycle-flow-hash",
          now: pollNow,
          createToken: async () => {
            tokenFactoryCalls += 1;
            return {
              token:
                "asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              tokenHash: fixtureDigest(`invalid-grant-evidence-${_case}`),
            };
          },
        }),
      ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
      expect(tokenFactoryCalls).toBe(0);
      expect(
        sqlite
          .prepare<{ token_hash: string | null }, [string]>(
            "SELECT token_hash FROM enrollment_proposals WHERE proposal_id = ?",
          )
          .get(LIFECYCLE_PROPOSAL)?.token_hash,
      ).toBeNull();
      expect(
        sqlite.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM fellow_tokens").get()
          ?.count,
      ).toBe(0);
    },
  );

  test("a requested-authority change during token generation cannot burn the one-time flow", async () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run(readFileSync(MIGRATION, "utf8"));
    seedLifecycleIdentity(
      sqlite,
      '{"eventBudget":10}',
      '["review"]',
      NOW,
      NOW,
      NOW + PENDING_PROPOSAL_TTL_MS,
      '{"eventBudget":10}',
      '["review"]',
      false,
    );
    sqlite.exec(readFileSync(LIFECYCLE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
    let tokenFactoryCalls = 0;

    await expect(
      new D1EnrollmentStore(localD1(sqlite)).poll({
        flowHandleHash: "lifecycle-flow-hash",
        now: NOW + 1,
        createToken: async () => {
          tokenFactoryCalls += 1;
          // The first read validated eventBudget=10. A pre-0011 database does
          // not freeze enrollment_records, so plant the exact TOCTOU window
          // after validation but before the issuance batch commits.
          sqlite
            .prepare(
              `UPDATE enrollment_records
                  SET requested_resources_json = '{"eventBudget":5}'
                WHERE enrollment_id = ?`,
            )
            .run(LIFECYCLE_ENROLLMENT);
          return {
            token:
              "asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            tokenHash: fixtureDigest("request-change-during-token-generation"),
          };
        },
      }),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(tokenFactoryCalls).toBe(1);
    expect(
      sqlite
        .prepare<{ token_hash: string | null }, [string]>(
          "SELECT token_hash FROM enrollment_proposals WHERE proposal_id = ?",
        )
        .get(LIFECYCLE_PROPOSAL)?.token_hash,
    ).toBeNull();
    expect(
      sqlite.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM fellow_tokens").get()
        ?.count,
    ).toBe(0);
  });

  test("pre-0011 authentication rejects malformed requested authority without stamping use", async () => {
    const sqlite = databaseBeforeCredentialHardening();
    seedLifecycleIdentity(
      sqlite,
      '{"eventBudget":10}',
      '["review"]',
      NOW,
      NOW,
      NOW + PENDING_PROPOSAL_TTL_MS,
      '{"eventBudget":"5"}',
      '["review"]',
      true,
      "reduced",
    );
    insertLifecycleCredential(sqlite, {
      id: "credential-malformed-requested-authority",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
      scopesJson: '["review"]',
      resourcesJson: '{"eventBudget":10}',
    });
    await expect(
      new D1EnrollmentStore(localD1(sqlite)).authenticateCredential(
        "token-hash-1",
        NOW + 1,
        "bearer",
      ),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM fellow_tokens WHERE token_hash = ?",
        )
        .get("token-hash-1")?.last_used_at,
    ).toBeNull();
  });

  test("pre-0011 authentication rejects a requested grant expiry beyond its mint-time ceiling", async () => {
    const sqlite = databaseBeforeCredentialHardening();
    const resources = JSON.stringify({
      fellowGrantExpiresAt: NOW + TOKEN_TTL_MS + 1,
    });
    seedLifecycleIdentity(sqlite, resources, '["review"]');
    insertLifecycleCredential(sqlite, {
      id: "credential-overlong-requested-grant",
      // Match the proposal token facts so the planted failure reaches the
      // requested-grant ceiling instead of short-circuiting as an unrelated
      // credential/proposal binding miss.
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
      resourcesJson: resources,
    });

    await expect(
      new D1EnrollmentStore(localD1(sqlite)).authenticateCredential(
        "token-hash-1",
        NOW + 1,
        "bearer",
      ),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM fellow_tokens WHERE token_hash = ?",
        )
        .get("token-hash-1")?.last_used_at,
    ).toBeNull();
  });

  test("a request creation-time change between auth parsing and last-used update wins the race", async () => {
    const sqlite = databaseBeforeCredentialHardening();
    const resources = JSON.stringify({
      fellowGrantExpiresAt: NOW + TOKEN_TTL_MS,
    });
    seedLifecycleIdentity(sqlite, resources, '["review"]');
    insertLifecycleCredential(sqlite, {
      id: "credential-request-time-race",
      // Keep the initial chain exact so only the post-read created_at change
      // can defeat the guarded last-used update.
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
      resourcesJson: resources,
    });
    let mutated = false;
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        afterFirstRead: async (query) => {
          if (mutated || !query.includes("FROM fellow_tokens WHERE token_hash")) return;
          mutated = true;
          sqlite
            .prepare("UPDATE enrollment_records SET created_at = ? WHERE enrollment_id = ?")
            .run(NOW + 1, LIFECYCLE_ENROLLMENT);
        },
      }),
    );

    expect(await store.authenticateCredential("token-hash-1", NOW + 2, "bearer")).toBeUndefined();
    expect(mutated).toBe(true);
    expect(
      sqlite
        .prepare<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM fellow_tokens WHERE token_hash = ?",
        )
        .get("token-hash-1")?.last_used_at,
    ).toBeNull();
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
      {
        label: "BLOB",
        expression: "CAST(? AS BLOB)",
        value: "credential-blob-runtime",
      },
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
      ).toEqual({
        last_used_at: null,
        storage_class: fixture.label.toLowerCase(),
      });
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
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 1)).fellows).toMatchObject([
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
      (await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + TOKEN_TTL_MS)).fellows[0]?.credentials,
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
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 3)).fellows[0]).toMatchObject({
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
    expect(
      (await store.fellowsBySponsor(LIFECYCLE_SPONSOR, NOW + 4)).fellows[0]?.credentials,
    ).toEqual([]);

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
    const resourcesJson = JSON.stringify({
      fellowGrantExpiresAt: grantExpiresAt,
    });
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
      (await store.fellowsBySponsor(LIFECYCLE_SPONSOR, grantExpiresAt)).fellows[0]?.credentials,
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
    const resourcesJson = JSON.stringify({
      fellowGrantExpiresAt: grantExpiresAt,
    });
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
    expect((await store.fellowsBySponsor(LIFECYCLE_SPONSOR, grantExpiresAt)).fellows).toMatchObject(
      [
        {
          fellowId: LIFECYCLE_FELLOW,
          status: "active",
          grantedResources: { fellowGrantExpiresAt: grantExpiresAt },
          credentials: [],
        },
      ],
    );
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
      {
        label: "real expiry",
        scopes: '["review"]',
        resources: '{"fellowGrantExpiresAt":1.5}',
      },
      {
        label: "zero expiry",
        scopes: '["review"]',
        resources: '{"fellowGrantExpiresAt":0}',
      },
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
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
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
function recordingD1(sqlite: Database): {
  db: D1Database;
  issued: readonly string[];
} {
  const base = localD1(sqlite) as unknown as {
    prepare(query: string): unknown;
  };
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

  // The ~10k-row occupy() setup dominates wall time on loaded machines; the
  // assertions below are behavioral (suggestion output), never a time budget.
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
  }, 30_000);

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
  }, 30_000);

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
                return {
                  results: Array.from({ length: 11 }, () => ({
                    name: "admin",
                  })),
                };
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

describe("0012 sponsor lifecycle commands", () => {
  test("0012 refuses lifecycle projections that have no causal event history", () => {
    const expectGuardRollback = (sqlite: Database) => {
      expect(
        sqlite
          .prepare<{ invalid: number }, []>(
            `SELECT EXISTS (
               SELECT 1 FROM enrollment_fellows WHERE status <> 'active'
             ) OR EXISTS (
               SELECT 1 FROM fellow_tokens WHERE revoked_at IS NOT NULL
             ) OR EXISTS (
               SELECT 1 FROM enrollment_sponsor_security
                WHERE panic_at <> 0 OR updated_at <> 0
             ) AS invalid`,
          )
          .get()?.invalid,
      ).toBe(1);
      const migration = readFileSync(FELLOW_LIFECYCLE_COMMANDS_MIGRATION, "utf8");
      const guardEnd = migration.indexOf(
        "\n\nDROP TRIGGER fellow_lifecycle_migration_guard_reject;",
      );
      if (guardEnd < 0) throw new Error("0012 lifecycle guard boundary disappeared");
      sqlite.run("BEGIN");
      // Bun's multi-statement exec can continue after a middle-statement
      // constraint error. End this exact-source execution at the guard insert
      // so the planted failure cannot be masked by later successful DDL.
      expect(() => sqlite.exec(migration.slice(0, guardEnd))).toThrow(
        "fellow lifecycle history must be resolved before migration",
      );
      sqlite.run("ROLLBACK");
      expect(
        sqlite
          .prepare<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM pragma_table_info('sponsors') WHERE name = 'lifecycle_seq'",
          )
          .get()?.n,
      ).toBe(0);
    };

    const nonActive = databaseBeforeLifecycleCommands();
    nonActive
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    seedLifecycleIdentity(nonActive);
    nonActive
      .prepare("UPDATE enrollment_fellows SET status = 'paused' WHERE fellow_id = ?")
      .run(LIFECYCLE_FELLOW);
    expect(
      nonActive
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_fellows WHERE fellow_id = ?",
        )
        .get(LIFECYCLE_FELLOW)?.status,
    ).toBe("paused");
    expectGuardRollback(nonActive);

    const revoked = databaseBeforeLifecycleCommands();
    revoked
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    seedLifecycleIdentity(revoked);
    insertLifecycleCredential(revoked, {
      id: "cred-retained-revocation",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    revoked
      .prepare("UPDATE fellow_tokens SET revoked_at = ? WHERE credential_id = ?")
      .run(NOW + 1, "cred-retained-revocation");
    expectGuardRollback(revoked);

    const panicked = databaseBeforeLifecycleCommands();
    panicked
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    panicked
      .prepare(
        "INSERT INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at) VALUES (?, ?, ?)",
      )
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    expectGuardRollback(panicked);

    const neutral = databaseBeforeLifecycleCommands();
    neutral
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    neutral
      .prepare(
        "INSERT INTO enrollment_sponsor_security (sponsor_id, panic_at, updated_at) VALUES (?, 0, 0)",
      )
      .run(LIFECYCLE_SPONSOR);
    expect(() =>
      neutral.exec(readFileSync(FELLOW_LIFECYCLE_COMMANDS_MIGRATION, "utf8")),
    ).not.toThrow();
  });

  function lifecycleServiceFixture(options: Parameters<typeof localD1>[1] = {}) {
    const clock = new DeviceTestClock();
    const sqlite = lifecycleCommandDatabase();
    const service = new EnrollmentService({
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
      clock,
      store: new D1EnrollmentStore(localD1(sqlite, options)),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const sponsor = { type: "sponsor", sponsorId: "usr_lifecycle_service" } as const;
    return { clock, service, sponsor, sqlite };
  }

  async function approvedLifecycleServiceFellow(
    fixture: ReturnType<typeof lifecycleServiceFixture>,
    name: string,
  ) {
    await fixture.service.bootstrapSponsor(fixture.sponsor);
    const minted = await fixture.service.mint(fixture.sponsor, { requested_scopes: ["review"] });
    const claimed = await fixture.service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name,
      model: "test-model",
      harness: "test-harness",
    });
    await fixture.service.decide(fixture.sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
    });
    return { minted, claimed };
  }

  async function issuedLifecycleServiceCredential(
    fixture: ReturnType<typeof lifecycleServiceFixture>,
    name: string,
  ): Promise<{ readonly fellowId: string; readonly credentialId: string }> {
    const approved = await approvedLifecycleServiceFellow(fixture, name);
    const issued = await fixture.service.poll({ flow_handle: approved.claimed.flowHandle });
    if (issued.status !== "approved") throw new Error("fixture token was not issued");
    const fellow = (await fixture.service.fellows(fixture.sponsor)).find(
      (candidate) => candidate.name === name,
    );
    const credential = fellow?.credentials.find((candidate) => candidate.active);
    if (fellow === undefined || credential === undefined) {
      throw new Error("fixture credential was not listed");
    }
    return { fellowId: fellow.fellowId, credentialId: credential.credentialId };
  }

  function seededLifecycleCommandDatabase(): Database {
    const sqlite = lifecycleCommandDatabase();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    seedLifecycleIdentity(sqlite);
    insertLifecycleCredential(sqlite, {
      id: "cred-lifecycle-command",
      hash: "token-hash-1",
      issuedAt: NOW,
      proposalId: LIFECYCLE_PROPOSAL,
    });
    return sqlite;
  }

  function lifecycleReplay(
    scope: "credential-revoke" | "fellow-lifecycle" | "sponsor-panic",
    key: string,
    marker: string,
  ) {
    return {
      scope,
      principalScope: `sponsor:${LIFECYCLE_SPONSOR}`,
      key,
      digest: fixtureDigest(`lifecycle-${marker}`),
      now: NOW + 1,
      encryptedResponse: {
        ciphertext: `ciphertext-${marker}`,
        initializationVector: `iv-${marker}`,
      },
    };
  }

  test("individual revoke appends one causal event, advances the head, and commits replay", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    const d1 = localD1(sqlite);
    const store = new D1EnrollmentStore(d1);
    expect(
      sqlite
        .prepare<{ lifecycle_seq: number; issued_at: number; last_used_at: number | null }, []>(
          `SELECT sponsor.lifecycle_seq, credential.issued_at, credential.last_used_at
             FROM sponsors sponsor JOIN fellow_tokens credential
               ON credential.sponsor_id = sponsor.sponsor_id
            WHERE credential.credential_id = 'cred-lifecycle-command'`,
        )
        .get(),
    ).toEqual({ lifecycle_seq: 0, issued_at: NOW, last_used_at: null });
    expect(
      await d1
        .prepare(
          `SELECT sponsor.lifecycle_seq, security.panic_at,
                  credential.issued_at, credential.last_used_at
             FROM sponsors sponsor
             JOIN fellow_tokens credential ON credential.sponsor_id = sponsor.sponsor_id
             LEFT JOIN enrollment_sponsor_security security
               ON security.sponsor_id = sponsor.sponsor_id
            WHERE sponsor.sponsor_id = ?
              AND credential.fellow_id = ?
              AND credential.credential_id = ?
              AND credential.revoked_at IS NULL`,
        )
        .bind(LIFECYCLE_SPONSOR, LIFECYCLE_FELLOW, "cred-lifecycle-command")
        .first<{
          lifecycle_seq: number;
          panic_at: number | null;
          issued_at: number;
          last_used_at: number | null;
        }>(),
    ).toEqual({ lifecycle_seq: 0, panic_at: null, issued_at: NOW, last_used_at: null });
    const result = await store.revokeCredential({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      credentialId: "cred-lifecycle-command",
      eventId: `LEV-${"0".repeat(26)}`,
      requestId: "a".repeat(64),
      effectiveAt: NOW + 1,
      replayFor: async () => lifecycleReplay("credential-revoke", "revoke-key", "revoke"),
    });

    expect(result).toEqual({ sponsorSeq: 1, effectiveAt: NOW + 1 });
    expect(
      sqlite
        .prepare<{ revoked_at: number; revocation_event_id: string }, []>(
          "SELECT revoked_at, revocation_event_id FROM fellow_tokens WHERE credential_id = 'cred-lifecycle-command'",
        )
        .get(),
    ).toEqual({
      revoked_at: NOW + 1,
      revocation_event_id: `LEV-${"0".repeat(26)}`,
    });
    expect(
      sqlite
        .prepare<{ lifecycle_seq: number }, []>(
          `SELECT lifecycle_seq FROM sponsors WHERE sponsor_id = '${LIFECYCLE_SPONSOR}'`,
        )
        .get()?.lifecycle_seq,
    ).toBe(1);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(1);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_idempotency").get()
        ?.n,
    ).toBe(1);
    expect(() =>
      sqlite
        .prepare("UPDATE fellow_lifecycle_events SET effective_at = ? WHERE event_id = ?")
        .run(NOW + 2, `LEV-${"0".repeat(26)}`),
    ).toThrow("lifecycle event is immutable");
  });

  test("a concurrent successful authentication cannot defeat individual revocation", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    let raced = false;
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        afterFirstRead: async (query) => {
          if (raced || !query.includes("credential.issued_at, credential.last_used_at")) return;
          raced = true;
          expect(
            await new D1EnrollmentStore(localD1(sqlite)).authenticateCredential(
              "token-hash-1",
              NOW + 10,
              "bearer",
            ),
          ).toBeDefined();
        },
      }),
    );
    const result = await store.revokeCredential({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      credentialId: "cred-lifecycle-command",
      eventId: `LEV-${"A".repeat(26)}`,
      requestId: "a".repeat(64),
      effectiveAt: NOW + 1,
    });
    expect(result).toEqual({ sponsorSeq: 1, effectiveAt: NOW + 1 });
    expect(
      sqlite
        .prepare<{ last_used_at: number; revoked_at: number }, [string]>(
          "SELECT last_used_at, revoked_at FROM fellow_tokens WHERE credential_id = ?",
        )
        .get("cred-lifecycle-command"),
    ).toEqual({ last_used_at: NOW + 10, revoked_at: NOW + 10 });
    expect(await store.authenticateCredential("token-hash-1", NOW + 11, "bearer")).toBeUndefined();
  });

  test("status changes are event-bound and compromise creates family and review projections", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));

    expect(() =>
      sqlite
        .prepare("UPDATE enrollment_fellows SET status = 'paused' WHERE fellow_id = ?")
        .run(LIFECYCLE_FELLOW),
    ).toThrow("fellow lifecycle transition lacks event");

    const paused = await store.transitionFellow({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      toStatus: "paused",
      eventId: `LEV-${"1".repeat(26)}`,
      requestId: "b".repeat(64),
      effectiveAt: NOW + 1,
      replayFor: async () => lifecycleReplay("fellow-lifecycle", "pause-key", "pause"),
    });
    expect(paused.sponsorSeq).toBe(1);

    const compromised = await store.transitionFellow({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      toStatus: "compromised",
      eventId: `LEV-${"2".repeat(26)}`,
      requestId: "c".repeat(64),
      effectiveAt: NOW + 2,
      replayFor: async () => lifecycleReplay("fellow-lifecycle", "compromise-key", "compromise"),
    });
    expect(compromised.sponsorSeq).toBe(2);
    expect(
      sqlite
        .prepare<{ status: string; status_changed_at: number; status_event_id: string }, []>(
          "SELECT status, status_changed_at, status_event_id FROM enrollment_fellows WHERE fellow_id = 'fellow-lifecycle'",
        )
        .get(),
    ).toEqual({
      status: "compromised",
      status_changed_at: NOW + 2,
      status_event_id: `LEV-${"2".repeat(26)}`,
    });
    expect(
      sqlite
        .prepare<{ reason: string; family_revoked_through: number; event_id: string }, []>(
          "SELECT reason, family_revoked_through, event_id FROM enrollment_fellow_security",
        )
        .get(),
    ).toEqual({
      reason: "compromised",
      family_revoked_through: NOW + 2,
      event_id: `LEV-${"2".repeat(26)}`,
    });
    expect(
      sqlite
        .prepare<{ review_from: number; flagged_at: number; state: string }, []>(
          "SELECT review_from, flagged_at, state FROM fellow_write_review_windows",
        )
        .get(),
    ).toEqual({ review_from: NOW, flagged_at: NOW + 2, state: "open" });
    expect(await store.authenticateCredential("token-hash-1", NOW + 3, "bearer")).toBeUndefined();
  });

  test("a reordered status command never regresses lifecycle evidence time", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const paused = await store.transitionFellow({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      toStatus: "paused",
      eventId: `LEV-${"B".repeat(26)}`,
      requestId: "b".repeat(64),
      effectiveAt: NOW + 10_000,
    });
    const resumed = await store.transitionFellow({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      toStatus: "active",
      eventId: `LEV-${"C".repeat(26)}`,
      requestId: "c".repeat(64),
      effectiveAt: NOW + 1,
    });
    expect(paused.effectiveAt).toBe(NOW + 10_000);
    expect(resumed).toEqual({ sponsorSeq: 2, effectiveAt: NOW + 10_000 });
    expect(
      sqlite
        .prepare<{ status: string; status_changed_at: number }, [string]>(
          "SELECT status, status_changed_at FROM enrollment_fellows WHERE fellow_id = ?",
        )
        .get(LIFECYCLE_FELLOW),
    ).toEqual({ status: "active", status_changed_at: NOW + 10_000 });
  });

  test("sponsor panic invalidates existing credentials and every pre-panic grant", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const result = await store.panicSponsor({
      sponsorId: LIFECYCLE_SPONSOR,
      eventId: `LEV-${"3".repeat(26)}`,
      requestId: "d".repeat(64),
      effectiveAt: NOW + 1,
      replayFor: async () => lifecycleReplay("sponsor-panic", "panic-key", "panic"),
    });
    expect(result.sponsorSeq).toBe(1);
    expect(
      sqlite
        .prepare<{ panic_at: number; panic_event_id: string }, []>(
          "SELECT panic_at, panic_event_id FROM enrollment_sponsor_security",
        )
        .get(),
    ).toEqual({ panic_at: NOW + 1, panic_event_id: `LEV-${"3".repeat(26)}` });
    expect(await store.authenticateCredential("token-hash-1", NOW + 2, "bearer")).toBeUndefined();
    expect(() =>
      insertLifecycleCredential(sqlite, {
        id: "cred-after-panic-from-old-grant",
        hash: "token-after-panic-from-old-grant",
        issuedAt: NOW + 2,
      }),
    ).toThrow("credential grant predates sponsor panic boundary");
  });

  test("foreign and missing targets stay one opaque store error", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const attempts = [
      {
        sponsorId: "usr_foreign_sponsor",
        fellowId: LIFECYCLE_FELLOW,
        credentialId: "cred-lifecycle-command",
      },
      {
        sponsorId: LIFECYCLE_SPONSOR,
        fellowId: "missing-fellow",
        credentialId: "missing-credential",
      },
    ];
    for (const [index, target] of attempts.entries()) {
      let code: string | undefined;
      try {
        await store.revokeCredential({
          ...target,
          eventId: `LEV-${String(index + 4).repeat(26)}`,
          requestId: String(index + 5).repeat(64),
          effectiveAt: NOW + 1,
        });
      } catch (error) {
        code = (error as EnrollmentError).code;
      }
      expect(code).toBe("FELLOW_LIFECYCLE_NOT_CURRENT");
    }
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(0);
  });

  test("D1 lifecycle replay survives stale step-up without duplicating the command event", async () => {
    const fixture = lifecycleServiceFixture();
    const approved = await approvedLifecycleServiceFellow(fixture, "d1-replay-orchid");
    const issued = await fixture.service.poll({ flow_handle: approved.claimed.flowHandle });
    if (issued.status !== "approved") throw new Error("fixture token was not issued");
    const fellow = (await fixture.service.fellows(fixture.sponsor))[0];
    const credential = fellow?.credentials[0];
    if (fellow === undefined || credential === undefined) {
      throw new Error("fixture credential was not listed");
    }
    const request = {
      fellow_id: fellow.fellowId,
      credential_id: credential.credentialId,
      confirm: "revoke-credential",
      step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
    } as const;
    const first = await fixture.service.revokeCredential(fixture.sponsor, request, {
      idempotencyKey: "d1-lifecycle-replay-one",
    });

    fixture.clock.value += 16 * 60 * 1_000;
    await expect(
      fixture.service.revokeCredential(fixture.sponsor, request, {
        idempotencyKey: "d1-lifecycle-replay-one",
      }),
    ).resolves.toEqual(first);
    expect(
      fixture.sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events")
        .get()?.n,
    ).toBe(1);
    expect(
      fixture.sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_idempotency")
        .get()?.n,
    ).toBe(1);
  });

  test("PLANTED: same-key same-body revoke contenders wait at replay preflight and recover one byte-identical receipt", async () => {
    let preflightReaders = 0;
    let barrierArmed = false;
    let releasePreflights: (() => void) | undefined;
    let bothPreflightsRead: (() => void) | undefined;
    const preflightsMayContinue = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    const bothPreflightsObserved = new Promise<void>((resolve) => {
      bothPreflightsRead = resolve;
    });
    const fixture = lifecycleServiceFixture({
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!barrierArmed || !query.includes("FROM enrollment_idempotency")) return;
        preflightReaders += 1;
        if (preflightReaders === 2) {
          barrierArmed = false;
          bothPreflightsRead?.();
        }
        await preflightsMayContinue;
      },
    });
    const target = await issuedLifecycleServiceCredential(fixture, "d1-revoke-race-same-body");
    const request = {
      fellow_id: target.fellowId,
      credential_id: target.credentialId,
      confirm: "revoke-credential" as const,
      step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
    };
    const options = { idempotencyKey: "d1-revoke-race-same-body" } as const;

    barrierArmed = true;
    const first = fixture.service.revokeCredential(fixture.sponsor, request, options);
    const second = fixture.service.revokeCredential(fixture.sponsor, request, options);
    await Promise.race([
      bothPreflightsObserved,
      Bun.sleep(1_000).then(() => {
        throw new Error("both revoke contenders did not reach replay preflight");
      }),
    ]);
    releasePreflights?.();
    const [left, right] = await Promise.all([first, second]);

    expect(preflightReaders).toBe(2);
    expect(JSON.stringify(right)).toBe(JSON.stringify(left));
    expect(
      fixture.sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM fellow_lifecycle_events WHERE action = 'credential-revoked'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      fixture.sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'credential-revoke' AND idempotency_key = ?",
        )
        .get(options.idempotencyKey)?.n,
    ).toBe(1);
    expect(
      fixture.sqlite
        .prepare<{ lifecycle_seq: number }, [string]>(
          "SELECT lifecycle_seq FROM sponsors WHERE sponsor_id = ?",
        )
        .get(fixture.sponsor.sponsorId)?.lifecycle_seq,
    ).toBe(1);
    await expect(
      fixture.service.revokeCredential(fixture.sponsor, request, options),
    ).resolves.toEqual(left);
  });

  test("PLANTED: same-key different-body revoke contenders wait at replay preflight, commit one event, and conflict the loser", async () => {
    let preflightReaders = 0;
    let barrierArmed = false;
    let releasePreflights: (() => void) | undefined;
    let bothPreflightsRead: (() => void) | undefined;
    const preflightsMayContinue = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    const bothPreflightsObserved = new Promise<void>((resolve) => {
      bothPreflightsRead = resolve;
    });
    const fixture = lifecycleServiceFixture({
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!barrierArmed || !query.includes("FROM enrollment_idempotency")) return;
        preflightReaders += 1;
        if (preflightReaders === 2) {
          barrierArmed = false;
          bothPreflightsRead?.();
        }
        await preflightsMayContinue;
      },
    });
    const firstTarget = await issuedLifecycleServiceCredential(fixture, "d1-revoke-race-first");
    const secondTarget = await issuedLifecycleServiceCredential(fixture, "d1-revoke-race-second");
    const requests = [
      {
        fellow_id: firstTarget.fellowId,
        credential_id: firstTarget.credentialId,
        confirm: "revoke-credential" as const,
        step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
      },
      {
        fellow_id: secondTarget.fellowId,
        credential_id: secondTarget.credentialId,
        confirm: "revoke-credential" as const,
        step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
      },
    ] as const;
    const options = { idempotencyKey: "d1-revoke-race-different-body" } as const;

    barrierArmed = true;
    const first = fixture.service.revokeCredential(fixture.sponsor, requests[0], options);
    const second = fixture.service.revokeCredential(fixture.sponsor, requests[1], options);
    await Promise.race([
      bothPreflightsObserved,
      Bun.sleep(1_000).then(() => {
        throw new Error("both revoke contenders did not reach replay preflight");
      }),
    ]);
    releasePreflights?.();
    const outcomes = await Promise.allSettled([first, second]);

    expect(preflightReaders).toBe(2);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    expect(loser?.status).toBe("rejected");
    if (loser?.status === "rejected") {
      expect(loser.reason).toBeInstanceOf(EnrollmentError);
      expect((loser.reason as EnrollmentError).code).toBe("IDEMPOTENCY_CONFLICT");
    }
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    const winner = outcomes.at(winnerIndex);
    const winningRequest = requests.at(winnerIndex);
    if (winner?.status !== "fulfilled" || winningRequest === undefined) {
      throw new Error("same-key revoke race did not retain a winning receipt");
    }
    const losingRequest = requests[winnerIndex === 0 ? 1 : 0];
    expect(winner.value).toMatchObject({
      fellow_id: winningRequest.fellow_id,
      credential_id: winningRequest.credential_id,
      sponsor_seq: 1,
    });
    expect(
      fixture.sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM fellow_lifecycle_events WHERE action = 'credential-revoked'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      fixture.sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'credential-revoke' AND idempotency_key = ?",
        )
        .get(options.idempotencyKey)?.n,
    ).toBe(1);
    expect(
      fixture.sqlite
        .prepare<{ lifecycle_seq: number }, [string]>(
          "SELECT lifecycle_seq FROM sponsors WHERE sponsor_id = ?",
        )
        .get(fixture.sponsor.sponsorId)?.lifecycle_seq,
    ).toBe(1);
    await expect(
      fixture.service.revokeCredential(fixture.sponsor, winningRequest, options),
    ).resolves.toEqual(winner.value);
    await expect(
      fixture.service.revokeCredential(fixture.sponsor, losingRequest, options),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("D1 sponsor panic prevents delayed issuance from a pre-panic approval", async () => {
    const fixture = lifecycleServiceFixture();
    const approved = await approvedLifecycleServiceFellow(fixture, "d1-panic-before-poll");
    await fixture.service.panicSponsor(
      fixture.sponsor,
      {
        confirm: "revoke-all-fellow-credentials",
        step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
      },
      { idempotencyKey: "d1-panic-before-poll-one" },
    );

    let code: string | undefined;
    try {
      await fixture.service.poll({ flow_handle: approved.claimed.flowHandle });
    } catch (error) {
      code = (error as EnrollmentError).code;
    }
    expect(code).toBe("FLOW_INVALID");
    expect(
      fixture.sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_tokens").get()?.n,
    ).toBe(0);
    expect(
      fixture.sqlite
        .prepare<{ token_hash: string | null }, [string]>(
          "SELECT token_hash FROM enrollment_proposals WHERE enrollment_id = ?",
        )
        .get(approved.minted.enrollmentId)?.token_hash,
    ).toBeNull();
  });

  test("initial lifecycle projections cannot begin after the event head", () => {
    const sqlite = lifecycleCommandDatabase();
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at, lifecycle_seq) VALUES (?, ?, ?, ?)",
        )
        .run("usr_bad_initial_head", NOW, NOW, 1),
    ).toThrow("sponsor lifecycle head must begin at zero");

    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO enrollment_fellows (
             fellow_id, sponsor_id, name, model, harness, created_at, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "fellow-illegal-initial-state",
          LIFECYCLE_SPONSOR,
          "illegal-initial-state",
          "test-model",
          "test-harness",
          NOW,
          "paused",
        ),
    ).toThrow("Fellow lifecycle must begin active");
  });

  test("old events, heads, revocation evidence, and fabricated projections cannot be replayed", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    const pausedEvent = `LEV-${"6".repeat(26)}`;
    await store.transitionFellow({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      toStatus: "paused",
      eventId: pausedEvent,
      requestId: "6".repeat(64),
      effectiveAt: NOW + 1,
    });
    await store.transitionFellow({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      toStatus: "active",
      eventId: `LEV-${"7".repeat(26)}`,
      requestId: "7".repeat(64),
      effectiveAt: NOW + 2,
    });

    expect(() =>
      sqlite
        .prepare(
          "UPDATE enrollment_fellows SET status = 'paused', status_changed_at = ?, status_event_id = ? WHERE fellow_id = ?",
        )
        .run(NOW + 1, pausedEvent, LIFECYCLE_FELLOW),
    ).toThrow("fellow lifecycle transition lacks event");
    expect(() =>
      sqlite
        .prepare("UPDATE sponsors SET lifecycle_seq = 1 WHERE sponsor_id = ?")
        .run(LIFECYCLE_SPONSOR),
    ).toThrow("sponsor lifecycle head lacks event");
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO enrollment_fellow_security (
             fellow_id, sponsor_id, family_revoked_through, reason, event_id, updated_at
           ) VALUES (?, ?, ?, 'revoked', ?, ?)`,
        )
        .run(LIFECYCLE_FELLOW, LIFECYCLE_SPONSOR, NOW + 1, pausedEvent, NOW + 1),
    ).toThrow("Fellow family revocation lacks event");
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO fellow_write_review_windows (
             fellow_id, sponsor_id, review_from, flagged_at, event_id, state
           ) VALUES (?, ?, ?, ?, ?, 'open')`,
        )
        .run(LIFECYCLE_FELLOW, LIFECYCLE_SPONSOR, NOW, NOW + 1, pausedEvent),
    ).toThrow("Fellow review window lacks event");

    await store.revokeCredential({
      sponsorId: LIFECYCLE_SPONSOR,
      fellowId: LIFECYCLE_FELLOW,
      credentialId: "cred-lifecycle-command",
      eventId: `LEV-${"8".repeat(26)}`,
      requestId: "8".repeat(64),
      effectiveAt: NOW + 3,
    });
    expect(() =>
      sqlite
        .prepare("UPDATE fellow_tokens SET revocation_event_id = NULL WHERE credential_id = ?")
        .run("cred-lifecycle-command"),
    ).toThrow("credential revocation evidence is immutable");
  });

  test("nine contending sponsor commands serialize without a retry cliff and retain exact replay", async () => {
    const sqlite = lifecycleCommandDatabase();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    let leaseProbes = 0;
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        serializeBatches: true,
        afterFirstRead: async (query) => {
          if (query.includes("SET lifecycle_lease_token = ?")) leaseProbes += 1;
        },
      }),
    );
    const replayProtector = new AesGcmEnrollmentReplayProtector(new Uint8Array(32));
    const commands = Array.from({ length: 9 }, (_, index) => {
      const ordinal = index + 1;
      return {
        eventId: `LEV-${String(ordinal).repeat(26)}`,
        idempotencyKey: `panic-concurrency-${ordinal}`,
        requestId: fixtureDigest(`panic-concurrency-request-${ordinal}`),
      };
    });

    const results = await Promise.all(
      commands.map((command) =>
        store.panicSponsor({
          sponsorId: LIFECYCLE_SPONSOR,
          eventId: command.eventId,
          requestId: command.requestId,
          effectiveAt: NOW + 1,
          replayFor: async (result) => ({
            ...lifecycleReplay("sponsor-panic", command.idempotencyKey, command.idempotencyKey),
            encryptedResponse: await replayProtector.seal(
              JSON.stringify({
                eventId: command.eventId,
                idempotencyKey: command.idempotencyKey,
                ...result,
              }),
            ),
          }),
        }),
      ),
    );
    expect(results.map((result) => result.sponsorSeq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(new Set(results.map((result) => result.effectiveAt)).size).toBe(9);
    expect(leaseProbes).toBeGreaterThan(9);
    expect(
      sqlite
        .prepare<
          {
            lifecycle_seq: number;
            lifecycle_lease_token: string | null;
            lifecycle_lease_expires_at: number | null;
          },
          [string]
        >(
          `SELECT lifecycle_seq, lifecycle_lease_token, lifecycle_lease_expires_at
             FROM sponsors WHERE sponsor_id = ?`,
        )
        .get(LIFECYCLE_SPONSOR),
    ).toEqual({
      lifecycle_seq: 9,
      lifecycle_lease_token: null,
      lifecycle_lease_expires_at: null,
    });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(9);
    const replayRows = sqlite
      .prepare<
        {
          idempotency_key: string;
          response_ciphertext: string;
          response_initialization_vector: string;
        },
        []
      >(
        `SELECT idempotency_key, response_ciphertext, response_initialization_vector
           FROM enrollment_idempotency
          WHERE scope = 'sponsor-panic'
          ORDER BY idempotency_key`,
      )
      .all();
    expect(replayRows).toHaveLength(9);
    for (const row of replayRows) {
      const command = commands.find(
        (candidate) => candidate.idempotencyKey === row.idempotency_key,
      );
      if (command === undefined) throw new Error("unexpected lifecycle replay key");
      const response = JSON.parse(
        await replayProtector.open({
          ciphertext: row.response_ciphertext,
          initializationVector: row.response_initialization_vector,
        }),
      ) as {
        eventId: string;
        idempotencyKey: string;
        sponsorSeq: number;
        effectiveAt: number;
      };
      const result = results[commands.indexOf(command)];
      if (result === undefined) throw new Error("missing lifecycle command result");
      expect(response).toEqual({
        eventId: command.eventId,
        idempotencyKey: command.idempotencyKey,
        sponsorSeq: result.sponsorSeq,
        effectiveAt: result.effectiveAt,
      });
    }
  });

  test("a live lifecycle lease is not stolen and exhaustion writes no event or replay", async () => {
    const sqlite = lifecycleCommandDatabase();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    const heldEvent = `LEV-${"A".repeat(26)}`;
    sqlite
      .prepare(
        `UPDATE sponsors
            SET lifecycle_lease_token = ?, lifecycle_lease_expires_at = ?
          WHERE sponsor_id = ?`,
      )
      .run(heldEvent, NOW + 5_000, LIFECYCLE_SPONSOR);
    let issuedStatements = 0;
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        onStatement: () => {
          issuedStatements += 1;
        },
      }),
    );

    let refusal: unknown;
    try {
      await store.panicSponsor({
        sponsorId: LIFECYCLE_SPONSOR,
        eventId: `LEV-${"B".repeat(26)}`,
        requestId: "b".repeat(64),
        effectiveAt: NOW + 1,
        replayFor: async () => lifecycleReplay("sponsor-panic", "busy-panic", "busy-panic"),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "LIFECYCLE_BUSY" });
    expect(issuedStatements).toBe(17);
    expect(
      sqlite
        .prepare<{ lifecycle_seq: number; lifecycle_lease_token: string | null }, [string]>(
          "SELECT lifecycle_seq, lifecycle_lease_token FROM sponsors WHERE sponsor_id = ?",
        )
        .get(LIFECYCLE_SPONSOR),
    ).toEqual({ lifecycle_seq: 0, lifecycle_lease_token: heldEvent });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(0);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_idempotency").get()
        ?.n,
    ).toBe(0);
  });

  test("an expired lifecycle lease is reclaimed and fences its stale owner", async () => {
    const sqlite = lifecycleCommandDatabase();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    const staleEvent = `LEV-${"C".repeat(26)}`;
    sqlite
      .prepare(
        `UPDATE sponsors
            SET lifecycle_lease_token = ?, lifecycle_lease_expires_at = ?
          WHERE sponsor_id = ?`,
      )
      .run(staleEvent, NOW, LIFECYCLE_SPONSOR);
    const store = new D1EnrollmentStore(localD1(sqlite));
    const winnerEvent = `LEV-${"D".repeat(26)}`;

    expect(
      await store.panicSponsor({
        sponsorId: LIFECYCLE_SPONSOR,
        eventId: winnerEvent,
        requestId: "d".repeat(64),
        effectiveAt: NOW + 1,
      }),
    ).toEqual({ sponsorSeq: 1, effectiveAt: NOW + 1 });
    expect(
      sqlite
        .prepare<
          {
            lifecycle_seq: number;
            lifecycle_lease_token: string | null;
            lifecycle_lease_expires_at: number | null;
          },
          [string]
        >(
          `SELECT lifecycle_seq, lifecycle_lease_token, lifecycle_lease_expires_at
             FROM sponsors WHERE sponsor_id = ?`,
        )
        .get(LIFECYCLE_SPONSOR),
    ).toEqual({
      lifecycle_seq: 1,
      lifecycle_lease_token: null,
      lifecycle_lease_expires_at: null,
    });
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO fellow_lifecycle_events (
             event_id, sponsor_id, sponsor_seq, action, fellow_id, credential_id,
             from_status, to_status, effective_at, review_from, request_id, created_at
           ) VALUES (?, ?, 2, 'sponsor-panic', NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
        )
        .run(staleEvent, LIFECYCLE_SPONSOR, NOW + 2, "c".repeat(64), NOW + 2),
    ).toThrow("lifecycle command is not current");
  });

  test("a failed lifecycle batch releases only its own lease", async () => {
    const sqlite = lifecycleCommandDatabase();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    const collision = lifecycleReplay("sponsor-panic", "collision-panic", "first");
    sqlite
      .prepare(
        `INSERT INTO enrollment_idempotency (
           scope, principal_scope, idempotency_key, request_digest,
           response_ciphertext, response_initialization_vector, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        collision.scope,
        collision.principalScope,
        collision.key,
        collision.digest,
        collision.encryptedResponse.ciphertext,
        collision.encryptedResponse.initializationVector,
        collision.now + 24 * 60 * 60_000,
      );
    const store = new D1EnrollmentStore(localD1(sqlite));

    let refusal: unknown;
    try {
      await store.panicSponsor({
        sponsorId: LIFECYCLE_SPONSOR,
        eventId: `LEV-${"E".repeat(26)}`,
        requestId: "e".repeat(64),
        effectiveAt: NOW + 1,
        replayFor: async () => lifecycleReplay("sponsor-panic", "collision-panic", "different"),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(
      sqlite
        .prepare<{ lifecycle_seq: number; lifecycle_lease_token: string | null }, [string]>(
          "SELECT lifecycle_seq, lifecycle_lease_token FROM sponsors WHERE sponsor_id = ?",
        )
        .get(LIFECYCLE_SPONSOR),
    ).toEqual({ lifecycle_seq: 0, lifecycle_lease_token: null });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(0);
  });

  test("an ambiguous lease acquisition conditionally releases the acquired token", async () => {
    const sqlite = lifecycleCommandDatabase();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(LIFECYCLE_SPONSOR, NOW, NOW);
    let injectLoss = true;
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        afterFirstRead: async (query) => {
          if (!injectLoss || !query.includes("SET lifecycle_lease_token = ?")) return;
          injectLoss = false;
          throw new Error("planted lost lease-acquisition response");
        },
      }),
    );

    await expect(
      store.panicSponsor({
        sponsorId: LIFECYCLE_SPONSOR,
        eventId: `LEV-${"F".repeat(26)}`,
        requestId: "f".repeat(64),
        effectiveAt: NOW + 1,
      }),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(
      sqlite
        .prepare<{ lifecycle_seq: number; lifecycle_lease_token: string | null }, [string]>(
          "SELECT lifecycle_seq, lifecycle_lease_token FROM sponsors WHERE sponsor_id = ?",
        )
        .get(LIFECYCLE_SPONSOR),
    ).toEqual({ lifecycle_seq: 0, lifecycle_lease_token: null });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(0);
  });

  test("a committed lifecycle batch with a lost response is recovered from exact ciphertext", async () => {
    const sqlite = seededLifecycleCommandDatabase();
    let injectLoss = true;
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        afterBatchCommit: async () => {
          if (!injectLoss) return;
          injectLoss = false;
          throw new Error("planted lost committed lifecycle response");
        },
      }),
    );
    const protector = new AesGcmEnrollmentReplayProtector(new Uint8Array(32));
    const response = {
      eventId: `LEV-${"G".repeat(26)}`,
      sponsorSeq: 1,
      effectiveAt: NOW + 1,
    };
    const replay = {
      ...lifecycleReplay("credential-revoke", "lost-commit-revoke", "lost-commit-revoke"),
      encryptedResponse: await protector.seal(JSON.stringify(response)),
    };

    await expect(
      store.revokeCredential({
        sponsorId: LIFECYCLE_SPONSOR,
        fellowId: LIFECYCLE_FELLOW,
        credentialId: "cred-lifecycle-command",
        eventId: response.eventId,
        requestId: "1".repeat(64),
        effectiveAt: response.effectiveAt,
        replayFor: async () => replay,
      }),
    ).rejects.toBeInstanceOf(EnrollmentIdempotencyRaceError);
    const persisted = await store.idempotencyReplay(replay);
    if (persisted === undefined) throw new Error("committed lifecycle replay was not retained");
    expect(JSON.parse(await protector.open(persisted.encryptedResponse))).toEqual(response);
    expect(
      sqlite
        .prepare<{ lifecycle_seq: number; lifecycle_lease_token: string | null }, [string]>(
          "SELECT lifecycle_seq, lifecycle_lease_token FROM sponsors WHERE sponsor_id = ?",
        )
        .get(LIFECYCLE_SPONSOR),
    ).toEqual({ lifecycle_seq: 1, lifecycle_lease_token: null });
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(1);
  });

  test("the sponsor service returns the exact committed lifecycle response after transport loss", async () => {
    let armed = false;
    let responseLost = false;
    const fixture = lifecycleServiceFixture({
      afterBatchCommit: async () => {
        if (!armed || responseLost) return;
        responseLost = true;
        throw new Error("planted lost sponsor lifecycle response");
      },
    });
    await fixture.service.bootstrapSponsor(fixture.sponsor);
    const request = {
      confirm: "revoke-all-fellow-credentials",
      step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
    } as const;
    armed = true;

    const recovered = await fixture.service.panicSponsor(fixture.sponsor, request, {
      idempotencyKey: "lost-commit-service-panic",
    });
    expect(responseLost).toBe(true);
    expect(recovered).toMatchObject({
      acknowledged: true,
      sponsor_seq: 1,
      effective_at: fixture.clock.value,
    });
    expect(recovered.event_id).toMatch(/^LEV-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      fixture.sqlite
        .prepare<{ event_id: string; sponsor_seq: number; effective_at: number }, [string]>(
          `SELECT event_id, sponsor_seq, effective_at
             FROM fellow_lifecycle_events WHERE sponsor_id = ?`,
        )
        .get(fixture.sponsor.sponsorId),
    ).toEqual({
      event_id: recovered.event_id,
      sponsor_seq: recovered.sponsor_seq,
      effective_at: recovered.effective_at,
    });
    expect(
      fixture.sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_idempotency")
        .get()?.n,
    ).toBe(1);

    fixture.clock.value += 16 * 60 * 1_000;
    await expect(
      fixture.service.panicSponsor(fixture.sponsor, request, {
        idempotencyKey: "lost-commit-service-panic",
      }),
    ).resolves.toEqual(recovered);
    expect(
      fixture.sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events")
        .get()?.n,
    ).toBe(1);
  });

  test("an expired lifecycle replay key can name a new command without permanent event collision", async () => {
    const fixture = lifecycleServiceFixture();
    const approved = await approvedLifecycleServiceFellow(fixture, "reclaimed-lifecycle-key");
    const fellow = (await fixture.service.fellows(fixture.sponsor))[0];
    if (fellow === undefined) throw new Error("approved Fellow was not listed");
    const key = "reclaimed-lifecycle-key-one";
    await fixture.service.transitionFellow(
      fixture.sponsor,
      {
        fellow_id: fellow.fellowId,
        status: "paused",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
      },
      { idempotencyKey: key },
    );
    fixture.clock.value += 24 * 60 * 60_000 + 1;
    const resumed = await fixture.service.transitionFellow(
      fixture.sponsor,
      {
        fellow_id: fellow.fellowId,
        status: "active",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
      },
      { idempotencyKey: key },
    );
    expect(resumed).toMatchObject({ status: "active", sponsor_seq: 2 });
    expect(
      fixture.sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events")
        .get()?.n,
    ).toBe(2);
    expect(approved.claimed.flowHandle).toMatch(/^flow_v1\./);
  });

  test("panic that commits after approval read rolls the stale approval batch back", async () => {
    const clock = new DeviceTestClock();
    const sqlite = lifecycleCommandDatabase();
    let armed = false;
    let releaseDecision: (() => void) | undefined;
    let decisionRead: (() => void) | undefined;
    const decisionReadObserved = new Promise<void>((resolve) => {
      decisionRead = resolve;
    });
    const decisionMayContinue = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const store = new D1EnrollmentStore(
      localD1(sqlite, {
        afterFirstRead: async (query) => {
          if (!armed || !query.includes("JOIN enrollment_proposals p")) return;
          armed = false;
          decisionRead?.();
          await decisionMayContinue;
        },
      }),
    );
    const service = new EnrollmentService({
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
      clock,
      store,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const sponsor = { type: "sponsor", sponsorId: "usr_panic_approval_race" } as const;
    await service.bootstrapSponsor(sponsor);
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const claimed = await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "panic-race-fellow",
      model: "test-model",
      harness: "test-harness",
    });
    armed = true;
    const decision = service.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(clock.value / 1_000),
    });
    await decisionReadObserved;
    await new D1EnrollmentStore(localD1(sqlite)).panicSponsor({
      sponsorId: sponsor.sponsorId,
      eventId: `LEV-${"9".repeat(26)}`,
      requestId: "9".repeat(64),
      effectiveAt: clock.value,
    });
    releaseDecision?.();
    await expect(decision).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE enrollment_id = ?",
        )
        .get(minted.enrollmentId)?.status,
    ).toBe("pending");
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(0);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_fellows").get()?.n,
    ).toBe(0);
    expect(claimed.flowHandle).toMatch(/^flow_v1\./);
  });
});

describe("0013 sponsor Fellow capacity", () => {
  const sponsorId = "usr_fellow_cap";

  async function approveFellow(
    service: EnrollmentService,
    sponsor: { readonly type: "sponsor"; readonly sponsorId: string },
    ordinal: number,
    decisionKey?: string,
    fellowGrantExpiresInMs?: number,
  ): Promise<string> {
    const minted = await service.mint(sponsor, {
      requested_scopes: ["review"],
      ...(fellowGrantExpiresInMs === undefined
        ? {}
        : { fellow_grant_expires_in_ms: fellowGrantExpiresInMs }),
    });
    await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: `service-cap-${ordinal}`,
      model: "test-model",
      harness: "test-harness",
    });
    await service.decide(
      sponsor,
      minted.enrollmentId,
      {
        enrollment_id: minted.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: STEP_UP_AT,
      },
      decisionKey === undefined ? {} : { idempotencyKey: decisionKey },
    );
    return minted.enrollmentId;
  }

  function insertSponsor(sqlite: Database): void {
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(sponsorId, NOW, NOW);
  }

  function insertFellow(sqlite: Database, ordinal: number): void {
    sqlite
      .prepare(
        `INSERT INTO enrollment_fellows (
           fellow_id, sponsor_id, name, model, harness, created_at
         ) VALUES (?, ?, ?, 'test-model', 'test-harness', ?)`,
      )
      .run(`F-CAP-${ordinal}`, sponsorId, `cap-fellow-${ordinal}`, NOW + ordinal);
  }

  test("0013 preserves retained over-cap Fellows but blocks growth until the sponsor converges", async () => {
    const sqlite = lifecycleCommandDatabase();
    insertSponsor(sqlite);
    for (let ordinal = 1; ordinal <= 6; ordinal += 1) insertFellow(sqlite, ordinal);

    const migration = readFileSync(SPONSOR_FELLOW_CAP_MIGRATION, "utf8");
    sqlite.exec(migration);

    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM pragma_table_info('sponsors') WHERE name = 'active_fellow_limit'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_fellows").get()?.n,
    ).toBe(6);
    expect(() => insertFellow(sqlite, 7)).toThrow("active Fellow cap reached");

    const store = new D1EnrollmentStore(localD1(sqlite));
    await store.transitionFellow({
      sponsorId,
      fellowId: "F-CAP-6",
      toStatus: "paused",
      eventId: `LEV-${"7".repeat(26)}`,
      requestId: "7".repeat(64),
      effectiveAt: NOW + 100,
    });
    expect(() => insertFellow(sqlite, 7)).toThrow("active Fellow cap reached");

    await store.transitionFellow({
      sponsorId,
      fellowId: "F-CAP-5",
      toStatus: "paused",
      eventId: `LEV-${"8".repeat(26)}`,
      requestId: "8".repeat(64),
      effectiveAt: NOW + 101,
    });
    insertFellow(sqlite, 7);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_fellows WHERE status IN ('active', 'suspicious_review')",
        )
        .get()?.n,
    ).toBe(5);
  });

  test("0013 enforces five live Fellows, permits a bounded operator raise, and guards resume", async () => {
    const sqlite = lifecycleCommandDatabase();
    insertSponsor(sqlite);
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) insertFellow(sqlite, ordinal);
    sqlite.exec(readFileSync(SPONSOR_FELLOW_CAP_MIGRATION, "utf8"));

    expect(
      sqlite
        .prepare<{ active_fellow_limit: number }, [string]>(
          "SELECT active_fellow_limit FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId)?.active_fellow_limit,
    ).toBe(5);
    expect(() => insertFellow(sqlite, 6)).toThrow("active Fellow cap reached");

    sqlite
      .prepare("UPDATE sponsors SET active_fellow_limit = 6 WHERE sponsor_id = ?")
      .run(sponsorId);
    insertFellow(sqlite, 6);
    expect(() =>
      sqlite
        .prepare("UPDATE sponsors SET active_fellow_limit = 5 WHERE sponsor_id = ?")
        .run(sponsorId),
    ).toThrow("active Fellow limit is below current use");

    const store = new D1EnrollmentStore(localD1(sqlite));
    await store.transitionFellow({
      sponsorId,
      fellowId: "F-CAP-6",
      toStatus: "paused",
      eventId: `LEV-${"6".repeat(26)}`,
      requestId: "6".repeat(64),
      effectiveAt: NOW + 100,
    });
    sqlite
      .prepare("UPDATE sponsors SET active_fellow_limit = 5 WHERE sponsor_id = ?")
      .run(sponsorId);

    try {
      await store.transitionFellow({
        sponsorId,
        fellowId: "F-CAP-6",
        toStatus: "active",
        eventId: `LEV-${"7".repeat(26)}`,
        requestId: "7".repeat(64),
        effectiveAt: NOW + 101,
      });
      throw new Error("expected FELLOW_CAP_REACHED");
    } catch (error) {
      expect(error).toBeInstanceOf(EnrollmentError);
      expect((error as EnrollmentError).code).toBe("FELLOW_CAP_REACHED");
    }
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_fellows WHERE fellow_id = ?",
        )
        .get("F-CAP-6")?.status,
    ).toBe("paused");
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM fellow_lifecycle_events").get()
        ?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ lifecycle_lease_token: string | null }, [string]>(
          "SELECT lifecycle_lease_token FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId)?.lifecycle_lease_token,
    ).toBeNull();
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'fellow-lifecycle'",
        )
        .get()?.n,
    ).toBe(0);

    const plan = sqlite
      .prepare<{ detail: string }, [string]>(
        `EXPLAIN QUERY PLAN
         SELECT COUNT(*) FROM enrollment_fellows
          WHERE sponsor_id = ? AND status IN ('active', 'suspicious_review')`,
      )
      .all(sponsorId)
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("enrollment_fellows_sponsor_status_idx");
  });

  test("0013 keeps the operator limit within the bounded sponsor inventory contract", () => {
    const sqlite = sponsorFellowCapDatabase();
    insertSponsor(sqlite);
    for (const limit of [4, 501, 1.5]) {
      expect(() =>
        sqlite
          .prepare("UPDATE sponsors SET active_fellow_limit = ? WHERE sponsor_id = ?")
          .run(limit, sponsorId),
      ).toThrow();
    }
    sqlite
      .prepare("UPDATE sponsors SET active_fellow_limit = 500 WHERE sponsor_id = ?")
      .run(sponsorId);
    expect(
      sqlite
        .prepare<{ active_fellow_limit: number }, [string]>(
          "SELECT active_fellow_limit FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId)?.active_fellow_limit,
    ).toBe(500);
  });

  test("memory and D1 approval refuse Fellow six without consuming its pending decision key", async () => {
    const d1Sqlite = sponsorFellowCapDatabase();
    const sponsor = { type: "sponsor", sponsorId } as const;
    const memoryClock = new DeviceTestClock();
    const d1Clock = new DeviceTestClock();
    const fixtures = [
      {
        name: "memory",
        clock: memoryClock,
        service: new EnrollmentService({
          stoaOrigin: TEST_STOA_ORIGIN,
          agoraOrigin: "https://asimposium.org",
          clock: memoryClock,
          store: new InMemoryEnrollmentStore(),
          replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
        }),
      },
      {
        name: "d1",
        clock: d1Clock,
        service: new EnrollmentService({
          stoaOrigin: TEST_STOA_ORIGIN,
          agoraOrigin: "https://asimposium.org",
          clock: d1Clock,
          store: new D1EnrollmentStore(localD1(d1Sqlite)),
          replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
        }),
      },
    ] as const;

    for (const fixture of fixtures) {
      await fixture.service.bootstrapSponsor(sponsor);
      for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
        await approveFellow(fixture.service, sponsor, ordinal, undefined, 1);
      }
      const firstFellow = (await fixture.service.fellows(sponsor))[0];
      if (firstFellow === undefined) throw new Error("cap fixture Fellow was not listed");
      await fixture.service.transitionFellow(
        sponsor,
        {
          fellow_id: firstFellow.fellowId,
          status: "suspicious_review",
          confirm: "change-fellow-lifecycle",
          step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
        },
        { idempotencyKey: `cap-review-${fixture.name}` },
      );
      fixture.clock.value += 1;
      await fixture.service.panicSponsor(
        sponsor,
        {
          confirm: "revoke-all-fellow-credentials",
          step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
        },
        { idempotencyKey: `cap-panic-${fixture.name}` },
      );
      fixture.clock.value += 1;
      const minted = await fixture.service.mint(sponsor, { requested_scopes: ["review"] });
      await fixture.service.claim({
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: "service-cap-six",
        model: "test-model",
        harness: "test-harness",
      });
      try {
        await fixture.service.decide(
          sponsor,
          minted.enrollmentId,
          {
            enrollment_id: minted.enrollmentId,
            decision: "approve",
            step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
          },
          { idempotencyKey: `cap-six-${fixture.name}` },
        );
        throw new Error("expected FELLOW_CAP_REACHED");
      } catch (error) {
        expect(error).toBeInstanceOf(EnrollmentError);
        expect((error as EnrollmentError).code).toBe("FELLOW_CAP_REACHED");
      }
      expect((await fixture.service.fellows(sponsor)).length, fixture.name).toBe(5);
      expect(
        (await fixture.service.pendingApprovals(sponsor)).some(
          (proposal) =>
            proposal.enrollmentId === minted.enrollmentId && proposal.status === "pending",
        ),
        fixture.name,
      ).toBe(true);

      fixture.clock.value += 1;
      await fixture.service.transitionFellow(
        sponsor,
        {
          fellow_id: firstFellow.fellowId,
          status: "paused",
          confirm: "change-fellow-lifecycle",
          step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
        },
        { idempotencyKey: `cap-pause-${fixture.name}` },
      );
      await expect(
        fixture.service.decide(
          sponsor,
          minted.enrollmentId,
          {
            enrollment_id: minted.enrollmentId,
            decision: "approve",
            step_up_authenticated_at: Math.floor(fixture.clock.value / 1_000),
          },
          { idempotencyKey: `cap-six-${fixture.name}` },
        ),
      ).resolves.toBeUndefined();
      const fellows = await fixture.service.fellows(sponsor);
      expect(fellows.length, fixture.name).toBe(6);
      expect(
        fellows.filter(
          (fellow) => fellow.status === "active" || fellow.status === "suspicious_review",
        ).length,
        fixture.name,
      ).toBe(5);
      expect(
        (await fixture.service.pendingApprovals(sponsor)).some(
          (proposal) => proposal.enrollmentId === minted.enrollmentId,
        ),
        fixture.name,
      ).toBe(false);
    }

    expect(
      d1Sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'decision'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      d1Sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(6);
  });

  test("a shared key conflict outranks the cap after concurrent approval preflights miss", async () => {
    const sponsor = { type: "sponsor", sponsorId } as const;
    const fixtures = ["memory", "d1"] as const;

    for (const fixture of fixtures) {
      const clock = new DeviceTestClock();
      // Keep the current sponsor-row invariant on the D1 branch: this race
      // remains a capacity/idempotency proof, while ensuring 0015's guards do
      // not alter the winner-before-cap precedence.
      const sqlite = fixture === "d1" ? sponsorEnrollmentBootstrapInvariantDatabase() : undefined;
      let armed = false;
      let concurrentReads = 0;
      let releaseReads: (() => void) | undefined;
      let bothReads: (() => void) | undefined;
      const readsMayContinue = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      const bothReadsObserved = new Promise<void>((resolve) => {
        bothReads = resolve;
      });
      const memoryStore = new InMemoryEnrollmentStore();
      const store =
        sqlite === undefined
          ? new Proxy(memoryStore, {
              get(target, property) {
                if (property === "idempotencyReplay") {
                  return async (...args: Parameters<typeof target.idempotencyReplay>) => {
                    const replay = await target.idempotencyReplay(...args);
                    if (armed) {
                      concurrentReads += 1;
                      if (concurrentReads === 2) {
                        armed = false;
                        bothReads?.();
                      }
                      await readsMayContinue;
                    }
                    return replay;
                  };
                }
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            })
          : new D1EnrollmentStore(
              localD1(sqlite, {
                serializeBatches: true,
                afterFirstRead: async (query) => {
                  if (!armed || !query.includes("JOIN enrollment_proposals p")) return;
                  concurrentReads += 1;
                  if (concurrentReads === 2) {
                    armed = false;
                    bothReads?.();
                  }
                  await readsMayContinue;
                },
              }),
            );
      const service = new EnrollmentService({
        stoaOrigin: TEST_STOA_ORIGIN,
        agoraOrigin: "https://asimposium.org",
        clock,
        store,
        replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
      });

      await service.bootstrapSponsor(sponsor);
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        await approveFellow(service, sponsor, ordinal);
      }
      const pending = [] as string[];
      for (const ordinal of [5, 6]) {
        const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
        await service.claim({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name: `service-cap-shared-${fixture}-${ordinal}`,
          model: "test-model",
          harness: "test-harness",
        });
        pending.push(minted.enrollmentId);
      }

      armed = true;
      const decisions = pending.map((enrollmentId) =>
        service.decide(
          sponsor,
          enrollmentId,
          {
            enrollment_id: enrollmentId,
            decision: "approve",
            step_up_authenticated_at: STEP_UP_AT,
          },
          { idempotencyKey: `cap-shared-key-${fixture}` },
        ),
      );
      await bothReadsObserved;
      releaseReads?.();
      const outcomes = await Promise.allSettled(decisions);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled").length, fixture).toBe(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected?.status, fixture).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason, fixture).toBeInstanceOf(EnrollmentError);
        expect((rejected.reason as EnrollmentError).code, fixture).toBe("IDEMPOTENCY_CONFLICT");
      }
      expect(
        (await service.fellows(sponsor)).filter(
          (fellow) => fellow.status === "active" || fellow.status === "suspicious_review",
        ).length,
        fixture,
      ).toBe(5);
      expect(
        (await service.pendingApprovals(sponsor)).filter((proposal) =>
          pending.includes(proposal.enrollmentId),
        ).length,
        fixture,
      ).toBe(1);
      expect(concurrentReads).toBe(2);
      if (sqlite !== undefined) {
        expect(
          sqlite
            .prepare<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE idempotency_key = ?",
            )
            .get(`cap-shared-key-${fixture}`)?.n,
        ).toBe(1);
      }
    }
  });

  test("a fifth approval racing a paused-Fellow resume commits exactly one capacity consumer", async () => {
    const sqlite = sponsorFellowCapDatabase();
    const clock = new DeviceTestClock();
    const sponsor = { type: "sponsor", sponsorId } as const;
    const observed = new Set<"decision" | "resume">();
    let armed = false;
    let releaseReads: (() => void) | undefined;
    let bothReads: (() => void) | undefined;
    const readsMayContinue = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const bothReadsObserved = new Promise<void>((resolve) => {
      bothReads = resolve;
    });
    const service = new EnrollmentService({
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
      clock,
      store: new D1EnrollmentStore(
        localD1(sqlite, {
          serializeBatches: true,
          afterFirstRead: async (query) => {
            if (!armed) return;
            let matched = false;
            if (query.includes("JOIN enrollment_proposals p")) {
              observed.add("decision");
              matched = true;
            }
            if (query.includes("SELECT sponsor.lifecycle_seq") && query.includes("fellow.status")) {
              observed.add("resume");
              matched = true;
            }
            if (!matched) return;
            if (observed.size === 2) {
              armed = false;
              bothReads?.();
            }
            await readsMayContinue;
          },
        }),
      ),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });

    await service.bootstrapSponsor(sponsor);
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      await approveFellow(service, sponsor, ordinal);
    }
    const paused = (await service.fellows(sponsor))[0];
    if (paused === undefined) throw new Error("race fixture Fellow was not listed");
    await service.transitionFellow(
      sponsor,
      {
        fellow_id: paused.fellowId,
        status: "paused",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(clock.value / 1_000),
      },
      { idempotencyKey: "cap-race-pause" },
    );
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "service-cap-racer",
      model: "test-model",
      harness: "test-harness",
    });

    armed = true;
    const approval = service.decide(
      sponsor,
      minted.enrollmentId,
      {
        enrollment_id: minted.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(clock.value / 1_000),
      },
      { idempotencyKey: "cap-race-approve" },
    );
    const resume = service.transitionFellow(
      sponsor,
      {
        fellow_id: paused.fellowId,
        status: "active",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(clock.value / 1_000),
      },
      { idempotencyKey: "cap-race-resume" },
    );
    await bothReadsObserved;
    releaseReads?.();
    const outcomes = await Promise.allSettled([approval, resume]);

    expect(observed).toEqual(new Set(["decision", "resume"]));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled").length).toBe(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(EnrollmentError);
      expect((rejected.reason as EnrollmentError).code).toBe("FELLOW_CAP_REACHED");
    }
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM enrollment_fellows
            WHERE sponsor_id = ? AND status IN ('active', 'suspicious_review')`,
        )
        .get(sponsorId)?.n,
    ).toBe(5);
    expect(
      sqlite
        .prepare<{ lifecycle_lease_token: string | null }, [string]>(
          "SELECT lifecycle_lease_token FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId)?.lifecycle_lease_token,
    ).toBeNull();
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM enrollment_idempotency
            WHERE idempotency_key IN ('cap-race-approve', 'cap-race-resume')`,
        )
        .get()?.n,
    ).toBe(1);
  });
});

describe("0016 operator Fellow-cap override audit", () => {
  const sponsorId = "usr_operator_cap_target";
  const operator = {
    type: "operator",
    operatorId: "usr_operator_cap_actor",
    serviceEnvelopeKid: "operator-cap-test",
  } as const;
  const sponsor = { type: "sponsor", sponsorId } as const;

  function overrideRequest(
    activeFellowLimit: number,
    expectedActiveFellowLimit = 5,
    expectedSponsorSeq = 0,
    reason = "operator capacity review",
    stepUpAuthenticatedAt = STEP_UP_AT,
  ) {
    return {
      sponsor_id: sponsorId,
      expected_active_fellow_limit: expectedActiveFellowLimit,
      expected_sponsor_seq: expectedSponsorSeq,
      active_fellow_limit: activeFellowLimit,
      reason,
      confirm: "override-fellow-cap" as const,
      step_up_authenticated_at: stepUpAuthenticatedAt,
    };
  }

  function serviceFixture(options: Parameters<typeof localD1>[1] = {}) {
    const sqlite = operatorFellowCapOverrideDatabase();
    const clock = new DeviceTestClock();
    const service = new EnrollmentService({
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
      clock,
      store: new D1EnrollmentStore(localD1(sqlite, options)),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    return { sqlite, clock, service };
  }

  test("rebuilds the closed replay scope and makes the immutable audit row the only cap-transition authority", async () => {
    const { sqlite, clock, service } = serviceFixture();
    // These are direct SQLite writes, not bootstrap helpers: a new sponsor
    // cannot start at a raised cap or nonzero causal sequence outside the
    // immutable operator event path.
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run("usr_raw_cap_baseline", NOW, NOW);
    expect(
      sqlite
        .prepare<{ active_fellow_limit: number; fellow_cap_seq: number }, [string]>(
          "SELECT active_fellow_limit, fellow_cap_seq FROM sponsors WHERE sponsor_id = ?",
        )
        .get("usr_raw_cap_baseline"),
    ).toEqual({ active_fellow_limit: 5, fellow_cap_seq: 0 });
    for (const [activeFellowLimit, fellowCapSeq] of [
      [500, 0],
      [5, 42],
    ] as const) {
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sponsors (
               sponsor_id, created_at, last_seen_at, active_fellow_limit, fellow_cap_seq
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            `usr_raw_cap_${activeFellowLimit}_${fellowCapSeq}`,
            NOW,
            NOW,
            activeFellowLimit,
            fellowCapSeq,
          ),
      ).toThrow("new sponsor Fellow-cap state must be 5/0");
    }
    await service.bootstrapSponsor(sponsor);

    // A JavaScript lone surrogate cannot be represented faithfully in D1's
    // UTF-8 binding. Reject it before the signed/idempotent intent can differ
    // from the durable reason; a valid astral scalar still reaches D1.
    for (const reason of [`\ud800${"a".repeat(9)}`, `\udc00${"a".repeat(9)}`]) {
      await expect(
        service.overrideSponsorFellowCap(operator, overrideRequest(6, 5, 0, reason), {
          idempotencyKey: `operator-cap-lone-surrogate-${reason.charCodeAt(0)}`,
        }),
      ).rejects.toMatchObject({ code: "OPERATOR_FELLOW_CAP_BODY_INVALID" });
    }
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(0);

    const receipt = await service.overrideSponsorFellowCap(
      operator,
      overrideRequest(6, 5, 0, `😀${"a".repeat(9)}`),
      { idempotencyKey: "operator-cap-first" },
    );

    expect(receipt).toMatchObject({
      acknowledged: true,
      sponsor_id: sponsorId,
      sponsor_seq: 1,
      previous_active_fellow_limit: 5,
      active_fellow_limit: 6,
      step_up_authenticated_at: STEP_UP_AT,
      signer_kid: operator.serviceEnvelopeKid,
    });
    expect(receipt.audit_event_id).toMatch(/^OFC-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      sqlite
        .prepare<
          {
            operator_id: string;
            sponsor_seq: number;
            previous_active_fellow_limit: number;
            active_fellow_limit: number;
            reason_length: number;
            step_up_authenticated_at: number;
            signer_kid: string;
          },
          [string]
        >(
          `SELECT operator_id, sponsor_seq, previous_active_fellow_limit,
                  active_fellow_limit, length(reason) AS reason_length,
                  step_up_authenticated_at, signer_kid
             FROM sponsor_fellow_cap_audit_events
            WHERE audit_event_id = ?`,
        )
        .get(receipt.audit_event_id),
    ).toEqual({
      operator_id: operator.operatorId,
      sponsor_seq: 1,
      previous_active_fellow_limit: 5,
      active_fellow_limit: 6,
      reason_length: 10,
      step_up_authenticated_at: STEP_UP_AT,
      signer_kid: operator.serviceEnvelopeKid,
    });
    expect(
      sqlite
        .prepare<{ active_fellow_limit: number; fellow_cap_seq: number }, [string]>(
          "SELECT active_fellow_limit, fellow_cap_seq FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId),
    ).toEqual({ active_fellow_limit: 6, fellow_cap_seq: 1 });
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'operator-fellow-cap'",
        )
        .get()?.n,
    ).toBe(1);

    // These are raw SQL plants, not helper assertions. They prove that no
    // transient permit or old audit row can authorize a later cap-only,
    // sequence-only, or fabricated next-transition update.
    for (const statement of [
      "UPDATE sponsors SET active_fellow_limit = 7 WHERE sponsor_id = 'usr_operator_cap_target'",
      "UPDATE sponsors SET fellow_cap_seq = 2 WHERE sponsor_id = 'usr_operator_cap_target'",
      "UPDATE sponsors SET active_fellow_limit = 7, fellow_cap_seq = 2 WHERE sponsor_id = 'usr_operator_cap_target'",
    ]) {
      expect(() => sqlite.exec(statement)).toThrow(
        "Fellow-cap transition requires immutable operator audit",
      );
    }
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO sponsor_fellow_cap_audit_events (
             audit_event_id, sponsor_id, operator_id, sponsor_seq,
             previous_active_fellow_limit, active_fellow_limit, reason,
             step_up_authenticated_at, signer_kid, request_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `OFC-${"B".repeat(26)}`,
          sponsorId,
          operator.operatorId,
          1,
          5,
          7,
          "stale raw audit row",
          STEP_UP_AT,
          operator.serviceEnvelopeKid,
          "b".repeat(64),
          NOW + 1,
        ),
    ).toThrow("operator Fellow-cap audit is stale");
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO sponsor_fellow_cap_audit_events (
             audit_event_id, sponsor_id, operator_id, sponsor_seq,
             previous_active_fellow_limit, active_fellow_limit, reason,
             step_up_authenticated_at, signer_kid, request_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `OFC-${"C".repeat(26)}`,
          sponsorId,
          operator.operatorId,
          2,
          6,
          7,
          "NUL-bearing audit reason\u0000must not persist",
          STEP_UP_AT,
          operator.serviceEnvelopeKid,
          "c".repeat(64),
          NOW + 1,
        ),
    ).toThrow();
    // The immutable record does not normalize bytes. The exact 10–1,000
    // code-point boundary and ECMAScript-whitespace endpoints are enforced
    // even when a raw SQLite caller bypasses Zod entirely.
    for (const reason of [
      "a".repeat(9),
      `\t${"a".repeat(10)}`,
      `${"a".repeat(10)}\u3000`,
      "a".repeat(1_001),
    ]) {
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sponsor_fellow_cap_audit_events (
               audit_event_id, sponsor_id, operator_id, sponsor_seq,
               previous_active_fellow_limit, active_fellow_limit, reason,
               step_up_authenticated_at, signer_kid, request_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `OFC-${"D".repeat(26)}`,
            sponsorId,
            operator.operatorId,
            2,
            6,
            5,
            reason,
            STEP_UP_AT,
            operator.serviceEnvelopeKid,
            "d".repeat(64),
            NOW + 1,
          ),
      ).toThrow();
    }
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sponsor_fellow_cap_apply_permits'",
        )
        .get()?.n,
    ).toBe(0);
    expect(() =>
      sqlite
        .prepare("UPDATE sponsor_fellow_cap_audit_events SET reason = ? WHERE audit_event_id = ?")
        .run("altered reason", receipt.audit_event_id),
    ).toThrow("operator Fellow-cap audit events are immutable");
    expect(() =>
      sqlite
        .prepare("DELETE FROM sponsor_fellow_cap_audit_events WHERE audit_event_id = ?")
        .run(receipt.audit_event_id),
    ).toThrow("operator Fellow-cap audit events cannot be deleted");

    // A committed receipt remains replayable after step-up expiry. A different
    // payload under the same key cannot overwrite it, and a fresh stale-CAS
    // attempt adds neither audit nor replay state.
    clock.value += (SPONSOR_STEP_UP_WINDOW_SECONDS + 1) * 1_000;
    await expect(
      service.overrideSponsorFellowCap(operator, overrideRequest(6, 5, 0, `😀${"a".repeat(9)}`), {
        idempotencyKey: "operator-cap-first",
      }),
    ).resolves.toEqual(receipt);
    await expect(
      service.overrideSponsorFellowCap(
        operator,
        overrideRequest(7, 5, 0, "different stable intent"),
        { idempotencyKey: "operator-cap-first" },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const otherSponsorId = "usr_operator_cap_other";
    await service.bootstrapSponsor({ type: "sponsor", sponsorId: otherSponsorId });
    await expect(
      service.overrideSponsorFellowCap(
        operator,
        {
          ...overrideRequest(6, 5, 0, "same key cannot retarget a sponsor"),
          sponsor_id: otherSponsorId,
        },
        { idempotencyKey: "operator-cap-first" },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(service.operatorFellowCapState(operator, otherSponsorId)).resolves.toEqual({
      sponsorId: otherSponsorId,
      activeFellowLimit: 5,
      sponsorSeq: 0,
    });
    await expect(
      service.overrideSponsorFellowCap(
        operator,
        overrideRequest(7, 5, 0, "fresh but stale precondition", Math.floor(clock.value / 1_000)),
        { idempotencyKey: "operator-cap-stale" },
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_FELLOW_CAP_NOT_CURRENT" });

    const raiseAtMaximumReason = await service.overrideSponsorFellowCap(
      operator,
      overrideRequest(7, 6, 1, "a".repeat(1_000), Math.floor(clock.value / 1_000)),
      { idempotencyKey: "operator-cap-max-reason" },
    );
    expect(raiseAtMaximumReason.sponsor_seq).toBe(2);

    // ABA plant: a delayed command that observed cap=5/seq=0 must not become
    // current merely because a later operator returned the cap to five.
    const returnToFive = await service.overrideSponsorFellowCap(
      operator,
      overrideRequest(5, 7, 2, "deliberate capacity return", Math.floor(clock.value / 1_000)),
      { idempotencyKey: "operator-cap-return" },
    );
    expect(returnToFive.sponsor_seq).toBe(3);
    await expect(
      service.overrideSponsorFellowCap(
        operator,
        overrideRequest(7, 5, 0, "delayed ABA command must lose", Math.floor(clock.value / 1_000)),
        { idempotencyKey: "operator-cap-aba-stale" },
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_FELLOW_CAP_NOT_CURRENT" });
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(3);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'operator-fellow-cap'",
        )
        .get()?.n,
    ).toBe(3);
  });

  test("two commands that observed the same cap leave exactly one sequenced receipt", async () => {
    let reads = 0;
    let releaseReads: (() => void) | undefined;
    let bothReads: (() => void) | undefined;
    const readsMayContinue = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const bothReadsObserved = new Promise<void>((resolve) => {
      bothReads = resolve;
    });
    const { sqlite, service } = serviceFixture({
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!query.includes("SELECT active_fellow_limit, fellow_cap_seq")) return;
        reads += 1;
        if (reads === 2) bothReads?.();
        await readsMayContinue;
      },
    });
    await service.bootstrapSponsor(sponsor);

    const first = service.overrideSponsorFellowCap(
      operator,
      overrideRequest(6, 5, 0, "first concurrent command"),
      { idempotencyKey: "operator-cap-race-1" },
    );
    const second = service.overrideSponsorFellowCap(
      operator,
      overrideRequest(7, 5, 0, "second concurrent command"),
      { idempotencyKey: "operator-cap-race-2" },
    );
    await bothReadsObserved;
    releaseReads?.();
    const outcomes = await Promise.allSettled([first, second]);

    expect(reads).toBe(2);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "OPERATOR_FELLOW_CAP_NOT_CURRENT" });
    }
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ active_fellow_limit: number; fellow_cap_seq: number }, [string]>(
          "SELECT active_fellow_limit, fellow_cap_seq FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId),
    ).toMatchObject({ fellow_cap_seq: 1 });
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'operator-fellow-cap'",
        )
        .get()?.n,
    ).toBe(1);
  });

  test("same-key same-body contenders recover one byte-identical immutable receipt", async () => {
    let preflightReaders = 0;
    let releasePreflights: (() => void) | undefined;
    let bothPreflightsRead: (() => void) | undefined;
    const preflightsMayContinue = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    const bothPreflightsObserved = new Promise<void>((resolve) => {
      bothPreflightsRead = resolve;
    });
    let barrierEnabled = false;
    const { sqlite, service } = serviceFixture({
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!barrierEnabled || !query.includes("FROM enrollment_idempotency")) return;
        preflightReaders += 1;
        if (preflightReaders === 2) {
          barrierEnabled = false;
          bothPreflightsRead?.();
        }
        await preflightsMayContinue;
      },
    });
    await service.bootstrapSponsor(sponsor);
    const options = { idempotencyKey: "operator-cap-same-key-race" } as const;
    const request = overrideRequest(6, 5, 0, "same body must converge exactly");

    barrierEnabled = true;
    const first = service.overrideSponsorFellowCap(operator, request, options);
    const second = service.overrideSponsorFellowCap(operator, request, options);
    await bothPreflightsObserved;
    releasePreflights?.();
    const [left, right] = await Promise.all([first, second]);

    expect(preflightReaders).toBe(2);
    expect(right).toEqual(left);
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'operator-fellow-cap'",
        )
        .get()?.n,
    ).toBe(1);
  });

  test("same-key different-body contenders commit one immutable receipt and conflict the loser", async () => {
    let preflightReaders = 0;
    let releasePreflights: (() => void) | undefined;
    let bothPreflightsRead: (() => void) | undefined;
    const preflightsMayContinue = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    const bothPreflightsObserved = new Promise<void>((resolve) => {
      bothPreflightsRead = resolve;
    });
    let barrierEnabled = false;
    const { sqlite, service } = serviceFixture({
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!barrierEnabled || !query.includes("FROM enrollment_idempotency")) return;
        preflightReaders += 1;
        if (preflightReaders === 2) {
          barrierEnabled = false;
          bothPreflightsRead?.();
        }
        await preflightsMayContinue;
      },
    });
    await service.bootstrapSponsor(sponsor);
    const options = { idempotencyKey: "operator-cap-same-key-different-body-race" } as const;

    barrierEnabled = true;
    const requests = [
      overrideRequest(6, 5, 0, "first same-key intent must be durable"),
      overrideRequest(7, 5, 0, "second same-key intent must conflict"),
    ] as const;
    const first = service.overrideSponsorFellowCap(operator, requests[0], options);
    const second = service.overrideSponsorFellowCap(operator, requests[1], options);
    await bothPreflightsObserved;
    releasePreflights?.();
    const outcomes = await Promise.allSettled([first, second]);

    expect(preflightReaders).toBe(2);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(EnrollmentError);
      expect((rejected.reason as EnrollmentError).code).toBe("IDEMPOTENCY_CONFLICT");
    }
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const winner = outcomes.at(winnerIndex);
    const winningRequest = requests.at(winnerIndex);
    if (winner?.status !== "fulfilled" || winningRequest === undefined) {
      throw new Error("same-key race did not retain a winning immutable receipt");
    }
    const losingRequest = requests[winnerIndex === 0 ? 1 : 0];
    expect(winner.value).toMatchObject({
      active_fellow_limit: winningRequest.active_fellow_limit,
      sponsor_seq: winningRequest.expected_sponsor_seq + 1,
    });
    expect(
      sqlite
        .prepare<{ active_fellow_limit: number; fellow_cap_seq: number }, [string]>(
          "SELECT active_fellow_limit, fellow_cap_seq FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId),
    ).toEqual({
      active_fellow_limit: winningRequest.active_fellow_limit,
      fellow_cap_seq: winningRequest.expected_sponsor_seq + 1,
    });
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE idempotency_key = ?",
        )
        .get(options.idempotencyKey)?.n,
    ).toBe(1);
    await expect(
      service.overrideSponsorFellowCap(operator, winningRequest, options),
    ).resolves.toEqual(winner.value);
    await expect(
      service.overrideSponsorFellowCap(operator, losingRequest, options),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("cap lowering and paused-Fellow activation serialize to one lawful capacity state", async () => {
    const observed = new Set<"lower" | "activate">();
    let armed = false;
    let releaseObservations: (() => void) | undefined;
    let bothObservations: (() => void) | undefined;
    const observationsMayContinue = new Promise<void>((resolve) => {
      releaseObservations = resolve;
    });
    const bothObservationsReached = new Promise<void>((resolve) => {
      bothObservations = resolve;
    });
    const { clock, sqlite, service } = serviceFixture({
      serializeBatches: true,
      afterFirstRead: async (query) => {
        if (!armed) return;
        let observation: "lower" | "activate" | undefined;
        if (query.includes("SELECT active_fellow_limit, fellow_cap_seq")) {
          observation = "lower";
        } else if (
          query.includes("SELECT sponsor.lifecycle_seq") &&
          query.includes("fellow.status")
        ) {
          observation = "activate";
        }
        if (observation === undefined) return;
        observed.add(observation);
        if (observed.size === 2) {
          armed = false;
          bothObservations?.();
        }
        await observationsMayContinue;
      },
    });
    await service.bootstrapSponsor(sponsor);
    await service.overrideSponsorFellowCap(
      operator,
      overrideRequest(6, 5, 0, "raise once to prepare capacity race"),
      { idempotencyKey: "operator-cap-lower-activation-raise" },
    );
    for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
      const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
      await service.claim({
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: `operator-cap-activation-${ordinal}`,
        model: "test-model",
        harness: "test-harness",
      });
      await service.decide(
        sponsor,
        minted.enrollmentId,
        {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: Math.floor(clock.value / 1_000),
        },
        { idempotencyKey: `operator-cap-lower-activation-approve-${ordinal}` },
      );
    }
    const paused = (await service.fellows(sponsor))[0];
    if (paused === undefined) throw new Error("capacity-race Fellow was not listed");
    await service.transitionFellow(
      sponsor,
      {
        fellow_id: paused.fellowId,
        status: "paused",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(clock.value / 1_000),
      },
      { idempotencyKey: "operator-cap-lower-activation-pause" },
    );

    armed = true;
    const lowering = service.overrideSponsorFellowCap(
      operator,
      overrideRequest(5, 6, 1, "lowering must not overrun active Fellows"),
      { idempotencyKey: "operator-cap-lower-activation-lower" },
    );
    const activation = service.transitionFellow(
      sponsor,
      {
        fellow_id: paused.fellowId,
        status: "active",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(clock.value / 1_000),
      },
      { idempotencyKey: "operator-cap-lower-activation-resume" },
    );
    await bothObservationsReached;
    releaseObservations?.();
    const [loweringOutcome, activationOutcome] = await Promise.allSettled([lowering, activation]);

    expect(observed).toEqual(new Set(["lower", "activate"]));
    expect(
      [loweringOutcome, activationOutcome].filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const loweringCommitted = loweringOutcome.status === "fulfilled";
    if (loweringCommitted) {
      expect(activationOutcome.status).toBe("rejected");
      if (activationOutcome.status === "rejected") {
        expect(activationOutcome.reason).toMatchObject({ code: "FELLOW_CAP_REACHED" });
      }
    } else {
      expect(loweringOutcome.status).toBe("rejected");
      if (loweringOutcome.status === "rejected") {
        expect(loweringOutcome.reason).toMatchObject({ code: "OPERATOR_FELLOW_CAP_NOT_CURRENT" });
      }
      expect(activationOutcome.status).toBe("fulfilled");
    }

    const current = sqlite
      .prepare<{ active_fellow_limit: number; fellow_cap_seq: number }, [string]>(
        "SELECT active_fellow_limit, fellow_cap_seq FROM sponsors WHERE sponsor_id = ?",
      )
      .get(sponsorId);
    const activeFellows = sqlite
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM enrollment_fellows
          WHERE sponsor_id = ? AND status IN ('active', 'suspicious_review')`,
      )
      .get(sponsorId)?.n;
    expect(activeFellows).toBeLessThanOrEqual(current?.active_fellow_limit ?? -1);
    expect(current).toEqual(
      loweringCommitted
        ? { active_fellow_limit: 5, fellow_cap_seq: 2 }
        : { active_fellow_limit: 6, fellow_cap_seq: 1 },
    );
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(loweringCommitted ? 2 : 1);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events WHERE reason = ?",
        )
        .get("lowering must not overrun active Fellows")?.n,
    ).toBe(loweringCommitted ? 1 : 0);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE idempotency_key = ?",
        )
        .get("operator-cap-lower-activation-lower")?.n,
    ).toBe(loweringCommitted ? 1 : 0);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE idempotency_key = ?",
        )
        .get("operator-cap-lower-activation-resume")?.n,
    ).toBe(loweringCommitted ? 0 : 1);
  });

  test("audit history uses bounded descending sequence keysets across same-time inserts", async () => {
    const { clock, service } = serviceFixture();
    await service.bootstrapSponsor(sponsor);
    let activeFellowLimit = 5;
    let sponsorSeq = 0;
    for (let sequence = 1; sequence <= 102; sequence += 1) {
      const nextLimit = activeFellowLimit === 5 ? 6 : 5;
      const receipt = await service.overrideSponsorFellowCap(
        operator,
        overrideRequest(
          nextLimit,
          activeFellowLimit,
          sponsorSeq,
          `operator history receipt ${sequence}`,
        ),
        { idempotencyKey: `operator-cap-history-${sequence}` },
      );
      activeFellowLimit = nextLimit;
      sponsorSeq = receipt.sponsor_seq;
    }

    const first = await service.operatorFellowCapAuditPage(operator, sponsorId);
    expect(first.auditEvents).toHaveLength(100);
    expect(first.auditEvents.map((event) => event.sponsorSeq)).toEqual(
      Array.from({ length: 100 }, (_unused, index) => 102 - index),
    );
    expect(first.nextCursor).toEqual({ sponsor_seq: 3 });
    expect(new Set(first.auditEvents.map((event) => event.effectiveAt))).toEqual(
      new Set([clock.value]),
    );

    const newest = await service.overrideSponsorFellowCap(
      operator,
      overrideRequest(6, activeFellowLimit, sponsorSeq, "new same-time audit receipt"),
      { idempotencyKey: "operator-cap-history-newest" },
    );
    expect(newest.sponsor_seq).toBe(103);
    const second = await service.operatorFellowCapAuditPage(operator, sponsorId, first.nextCursor);
    expect(second.auditEvents.map((event) => event.sponsorSeq)).toEqual([2, 1]);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("0014 sponsor enrollment rolling-day budget", () => {
  const sponsorId = "usr_fixture_sponsor";

  function rateRecord(label: string, at = NOW): EnrollmentRecord {
    return {
      ...record(`rate:${label}`),
      sponsorId,
      createdAt: at,
      secretExpiresAt: at + 30 * 60_000,
    };
  }

  test("the migration preserves retained attempts and immediately includes them", async () => {
    const withDevice = sponsorFellowCapDatabase();
    const withDeviceStore = new D1EnrollmentStore(localD1(withDevice));
    for (let ordinal = 1; ordinal < SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS; ordinal += 1) {
      expect(await withDeviceStore.create(rateRecord(`retained-${ordinal}`))).toBe(true);
    }
    const retainedDevice = deviceInput("retained-device-attempt");
    await withDeviceStore.deviceCreate(retainedDevice);
    await withDeviceStore.decision({
      enrollmentId: retainedDevice.record.enrollmentId,
      sponsorId,
      decision: { enrollment_id: retainedDevice.record.enrollmentId, decision: "approve" },
      now: NOW,
    });

    withDevice.exec(readFileSync(SPONSOR_ENROLLMENT_RATE_LIMIT_MIGRATION, "utf8"));
    const currentStore = new D1EnrollmentStore(localD1(withDevice));
    await expect(currentStore.create(rateRecord("retained-refusal"))).rejects.toMatchObject({
      code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
    } satisfies Partial<EnrollmentError>);
    expect(
      withDevice.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(1);
    expect(
      withDevice
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_device_enrollment_attempts")
        .get()?.n,
    ).toBe(1);
    expect(() =>
      withDevice
        .prepare("UPDATE sponsor_device_enrollment_attempts SET attempted_at = attempted_at + 1")
        .run(),
    ).toThrow("device enrollment attempt is immutable");
    expect(() =>
      withDevice.prepare("DELETE FROM sponsor_device_enrollment_attempts").run(),
    ).toThrow("device enrollment attempt is immutable");

    const withoutDevice = sponsorFellowCapDatabase();
    const withoutDeviceStore = new D1EnrollmentStore(localD1(withoutDevice));
    for (let ordinal = 1; ordinal < SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS; ordinal += 1) {
      expect(await withoutDeviceStore.create(rateRecord(`join-only-${ordinal}`))).toBe(true);
    }
    withoutDevice.exec(readFileSync(SPONSOR_ENROLLMENT_RATE_LIMIT_MIGRATION, "utf8"));
    await expect(withoutDeviceStore.create(rateRecord("join-only-tenth"))).resolves.toBe(true);

    const retainedOverLimit = sponsorFellowCapDatabase();
    const retainedOverLimitStore = new D1EnrollmentStore(localD1(retainedOverLimit));
    const retainedAttempts = SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS + 25;
    for (let ordinal = 1; ordinal <= retainedAttempts; ordinal += 1) {
      expect(await retainedOverLimitStore.create(rateRecord(`over-limit-${ordinal}`))).toBe(true);
    }
    retainedOverLimit.exec(readFileSync(SPONSOR_ENROLLMENT_RATE_LIMIT_MIGRATION, "utf8"));
    await expect(
      retainedOverLimitStore.create(rateRecord("over-limit-refusal")),
    ).rejects.toMatchObject({ code: "SPONSOR_ENROLLMENT_RATE_LIMITED" });
    expect(
      retainedOverLimit
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_records")
        .get()?.n,
    ).toBe(retainedAttempts);
  });

  test("the full migration uses indexed durable facts and opens the oldest slot at 24 hours", async () => {
    const migration = readFileSync(SPONSOR_ENROLLMENT_RATE_LIMIT_MIGRATION, "utf8");
    expect(migration.match(/LIMIT 11/g)).toHaveLength(2);
    expect(migration.match(/\) > 10 THEN/g)).toHaveLength(2);
    expect(migration).toContain("sponsor_device_enrollment_attempts_sponsor_time_idx");
    expect(migration).toContain("created_at > NEW.created_at - 86400000");
    expect(migration).toContain("attempted_at > NEW.granted_at - 86400000");

    const reordered = sponsorEnrollmentRateDatabase();
    const reorderedStore = new D1EnrollmentStore(localD1(reordered));
    await expect(reorderedStore.create(rateRecord("later-clock", NOW + 1))).resolves.toBe(true);
    await expect(reorderedStore.create(rateRecord("earlier-clock", NOW))).resolves.toBe(true);

    const reorderedAtLimit = sponsorEnrollmentRateDatabase();
    const reorderedAtLimitStore = new D1EnrollmentStore(localD1(reorderedAtLimit));
    for (let ordinal = 1; ordinal < SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS; ordinal += 1) {
      await reorderedAtLimitStore.create(rateRecord(`reordered-seed-${ordinal}`, NOW - 1));
    }
    await expect(
      reorderedAtLimitStore.create(rateRecord("reordered-later-final", NOW + 1)),
    ).resolves.toBe(true);
    await expect(
      reorderedAtLimitStore.create(rateRecord("reordered-earlier-refusal", NOW)),
    ).rejects.toMatchObject({
      code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
      retryAfterSeconds: 86402,
    });

    const sqlite = sponsorEnrollmentRateDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite));
    for (let ordinal = 1; ordinal <= SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS; ordinal += 1) {
      expect(await store.create(rateRecord(`seed-${ordinal}`))).toBe(true);
    }
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_records").get()?.n,
    ).toBe(SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS);

    const refusedWrite = {
      ...write(fixtureDigest("rate-refused"), "rate-refused"),
      key: "rate-refused-key",
    };
    await expect(
      store.create(rateRecord("keyed-refusal"), undefined, refusedWrite),
    ).rejects.toMatchObject({
      code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
    } satisfies Partial<EnrollmentError>);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE idempotency_key = ?",
        )
        .get(refusedWrite.key)?.n,
    ).toBe(0);

    const predecessorId = rateRecord("seed-1").enrollmentId;
    await expect(
      store.create(rateRecord("replacement-refusal"), predecessorId),
    ).rejects.toMatchObject({
      code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
    } satisfies Partial<EnrollmentError>);
    expect(
      sqlite
        .prepare<{ invalidated: number }, [string]>(
          "SELECT invalidated FROM enrollment_records WHERE enrollment_id = ?",
        )
        .get(predecessorId),
    ).toEqual({ invalidated: 0 });
    await expect(
      store.create({ ...rateRecord("other-sponsor"), sponsorId: "usr_rate_other" }),
    ).resolves.toBe(true);

    await expect(store.create(rateRecord("clock-regression", NOW - 1))).rejects.toMatchObject({
      code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
      retryAfterSeconds: 86402,
    });
    await expect(
      store.create(
        rateRecord("boundary-minus-one", NOW + SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS - 1),
      ),
    ).rejects.toMatchObject({
      code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
    } satisfies Partial<EnrollmentError>);
    await expect(
      store.create(rateRecord("boundary", NOW + SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS)),
    ).resolves.toBe(true);

    const recordPlan = sqlite
      .prepare<{ detail: string }, [string, number]>(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM enrollment_records
          WHERE sponsor_id = ? AND kind = 'join-url' AND created_at > ?`,
      )
      .all(sponsorId, NOW)
      .map((row) => row.detail)
      .join("\n");
    expect(recordPlan).toContain("enrollment_records_sponsor_kind_created_idx");
    const grantPlan = sqlite
      .prepare<{ detail: string }, [string, number]>(
        `EXPLAIN QUERY PLAN SELECT COUNT(*)
           FROM sponsor_device_enrollment_attempts
          WHERE sponsor_id = ? AND attempted_at > ?`,
      )
      .all(sponsorId, NOW)
      .map((row) => row.detail)
      .join("\n");
    expect(grantPlan).toContain("sponsor_device_enrollment_attempts_sponsor_time_idx");
  });

  test("independent join and device keys contend for one final sponsor slot", async () => {
    const sqlite = sponsorEnrollmentRateDatabase();
    const store = new D1EnrollmentStore(localD1(sqlite, { serializeBatches: true }));
    for (let ordinal = 1; ordinal < SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS; ordinal += 1) {
      expect(await store.create(rateRecord(`cross-path-seed-${ordinal}`))).toBe(true);
    }
    const device = deviceInput("cross-path-device");
    await store.deviceCreate(device);

    const joinIdempotency = {
      ...write(fixtureDigest("cross-path-join"), "cross-path-join"),
      key: "cross-path-join-key",
    };
    const deviceIdempotency = {
      ...write(fixtureDigest("cross-path-device"), "cross-path-device"),
      scope: "decision" as const,
      key: "cross-path-device-key",
    };
    const outcomes = await Promise.allSettled([
      store.create(rateRecord("cross-path-join"), undefined, joinIdempotency),
      store.decision(
        {
          enrollmentId: device.record.enrollmentId,
          sponsorId,
          decision: { enrollment_id: device.record.enrollmentId, decision: "approve" },
          now: NOW,
        },
        deviceIdempotency,
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refusal = outcomes.find((outcome) => outcome.status === "rejected");
    expect(refusal?.status).toBe("rejected");
    if (refusal?.status === "rejected") {
      expect(refusal.reason).toMatchObject({
        code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
      } satisfies Partial<EnrollmentError>);
    }
    const occupied = sqlite
      .prepare<{ n: number }, [string, string]>(
        `SELECT
           (SELECT COUNT(*) FROM enrollment_records
             WHERE sponsor_id = ? AND kind = 'join-url')
           +
           (SELECT COUNT(*) FROM enrollment_grants
             WHERE sponsor_id = ?) AS n`,
      )
      .get(sponsorId, sponsorId)?.n;
    expect(occupied).toBe(SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_idempotency").get()
        ?.n,
    ).toBe(1);

    const joinWon = outcomes[0]?.status === "fulfilled";
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_records WHERE enrollment_id = ?",
        )
        .get(rateRecord("cross-path-join").enrollmentId)?.n,
    ).toBe(joinWon ? 1 : 0);
    await expect(
      store.deviceApprovalCardForDecision(device.record.enrollmentId, NOW),
    ).resolves.toMatchObject({ status: joinWon ? "pending" : "approved" });
  });

  test("memory and D1 share one budget while defensive device denials stay free", async () => {
    const fixtures = [
      { name: "memory", store: new InMemoryEnrollmentStore(), sqlite: undefined },
      {
        name: "d1",
        sqlite: sponsorEnrollmentRateDatabase(),
        get store() {
          return new D1EnrollmentStore(localD1(this.sqlite));
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const store = fixture.store;
      for (let ordinal = 1; ordinal < SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS; ordinal += 1) {
        expect(
          await store.create(rateRecord(`${fixture.name}-join-${ordinal}`)),
          fixture.name,
        ).toBe(true);
      }

      const denied = deviceInput(`${fixture.name}-free-deny`);
      await store.deviceCreate(denied);
      await store.decision({
        enrollmentId: denied.record.enrollmentId,
        sponsorId,
        decision: { enrollment_id: denied.record.enrollmentId, decision: "deny" },
        now: NOW,
      });

      const accepted = deviceInput(`${fixture.name}-accepted`);
      await store.deviceCreate(accepted);
      await store.decision({
        enrollmentId: accepted.record.enrollmentId,
        sponsorId,
        decision: { enrollment_id: accepted.record.enrollmentId, decision: "approve" },
        now: NOW,
      });

      const refused = deviceInput(`${fixture.name}-refused`);
      await store.deviceCreate(refused);
      await expect(
        store.decision({
          enrollmentId: refused.record.enrollmentId,
          sponsorId,
          decision: { enrollment_id: refused.record.enrollmentId, decision: "approve" },
          now: NOW,
        }),
      ).rejects.toMatchObject({
        code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
      } satisfies Partial<EnrollmentError>);
      await expect(
        store.create(rateRecord(`${fixture.name}-regressed-clock`, NOW - 1)),
        fixture.name,
      ).rejects.toMatchObject({
        code: "SPONSOR_ENROLLMENT_RATE_LIMITED",
        retryAfterSeconds: 86402,
      });
      await expect(
        store.deviceApprovalCardForDecision(refused.record.enrollmentId, NOW),
      ).resolves.toMatchObject({ status: "pending" });
      await expect(
        store.create(
          rateRecord(
            `${fixture.name}-exact-window-boundary`,
            NOW + SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS,
          ),
        ),
        fixture.name,
      ).resolves.toBe(true);

      if (fixture.sqlite !== undefined) {
        expect(
          fixture.sqlite
            .prepare<{ sponsor_id: string; status: string }, [string]>(
              `SELECT record.sponsor_id, proposal.status
                 FROM enrollment_records record
                 JOIN enrollment_proposals proposal
                   ON proposal.enrollment_id = record.enrollment_id
                WHERE record.enrollment_id = ?`,
            )
            .get(refused.record.enrollmentId),
          fixture.name,
        ).toEqual({ sponsor_id: "", status: "pending" });
        expect(
          fixture.sqlite
            .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants")
            .get()?.n,
          fixture.name,
        ).toBe(1);
        expect(
          fixture.sqlite
            .prepare<{ n: number }, []>(
              "SELECT COUNT(*) AS n FROM sponsor_device_enrollment_attempts",
            )
            .get()?.n,
          fixture.name,
        ).toBe(1);
      }
    }
  });

  test("exact mint replay and conflict both outrank a full sponsor budget", async () => {
    const fixtures = ["memory", "d1"] as const;
    for (const fixture of fixtures) {
      const clock = new DeviceTestClock();
      const sqlite = fixture === "d1" ? sponsorEnrollmentRateDatabase() : undefined;
      const service = new EnrollmentService({
        stoaOrigin: TEST_STOA_ORIGIN,
        agoraOrigin: "https://asimposium.org",
        clock,
        store:
          sqlite === undefined
            ? new InMemoryEnrollmentStore()
            : new D1EnrollmentStore(localD1(sqlite)),
        replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
      });
      const sponsor = { type: "sponsor", sponsorId: `usr_rate_${fixture}` } as const;
      const request = { requested_scopes: ["review" as const] };
      const first = await service.mint(sponsor, request, {
        idempotencyKey: `rate-${fixture}-1`,
      });
      for (let ordinal = 2; ordinal <= SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS; ordinal += 1) {
        await service.mint(sponsor, request, {
          idempotencyKey: `rate-${fixture}-${ordinal}`,
        });
      }

      await expect(
        service.mint(sponsor, request, { idempotencyKey: `rate-${fixture}-1` }),
      ).resolves.toEqual(first);
      await expect(
        service.mint(
          sponsor,
          { requested_scopes: ["promote"] },
          { idempotencyKey: `rate-${fixture}-1` },
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(
        service.mint(sponsor, request, { idempotencyKey: `rate-${fixture}-11` }),
      ).rejects.toMatchObject({ code: "SPONSOR_ENROLLMENT_RATE_LIMITED" });

      if (sqlite !== undefined) {
        expect(
          sqlite
            .prepare<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM enrollment_records WHERE sponsor_id = ?",
            )
            .get(sponsor.sponsorId)?.n,
        ).toBe(SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS);
        expect(
          sqlite
            .prepare<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE principal_scope = ?",
            )
            .get(`sponsor:${sponsor.sponsorId}`)?.n,
        ).toBe(SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS);
      }
    }
  });
});

describe("0015 sponsor enrollment bootstrap invariant", () => {
  test("0015 rejects a retained orphan Fellow without schema or journal residue, then permits the corrected retry", () => {
    const sqlite = sponsorEnrollmentRateDatabase();
    const orphanSponsorId = "usr_bootstrap_orphan_fellow";
    createMigrationJournal(sqlite);
    sqlite
      .prepare(
        `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fellow-bootstrap-orphan",
        orphanSponsorId,
        "bootstrap-orphan-fellow",
        "test-model",
        "test-harness",
        NOW,
      );

    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n
             FROM enrollment_fellows fellow
             LEFT JOIN sponsors sponsor ON sponsor.sponsor_id = fellow.sponsor_id
            WHERE fellow.sponsor_id = ? AND sponsor.sponsor_id IS NULL`,
        )
        .get(orphanSponsorId)?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n
             FROM enrollment_grants grant_row
             LEFT JOIN sponsors sponsor ON sponsor.sponsor_id = grant_row.sponsor_id
            WHERE grant_row.sponsor_id = ? AND sponsor.sponsor_id IS NULL`,
        )
        .get(orphanSponsorId)?.n,
    ).toBe(0);

    expect(() => applyBootstrapInvariantMigrationBatch(sqlite)).toThrow(
      "sponsor enrollment bootstrap witness CHECK rejected legacy history",
    );
    expectBootstrapInvariantMigrationUnapplied(sqlite);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_fellows WHERE sponsor_id = ?",
        )
        .get(orphanSponsorId)?.n,
    ).toBe(1);

    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(orphanSponsorId, NOW, NOW);
    expect(() => applyBootstrapInvariantMigrationBatch(sqlite)).not.toThrow();
    expect(
      sqlite
        .prepare<{ sequence: number }, [string]>(
          "SELECT sequence FROM _asimposium_migrations WHERE id = ?",
        )
        .get(BOOTSTRAP_INVARIANT_MIGRATION_ID),
    ).toEqual({ sequence: BOOTSTRAP_INVARIANT_MIGRATION_SEQUENCE });
    expectBootstrapInvariantMigrationApplied(sqlite);
  });

  test("0015 rejects a retained orphan grant without schema or journal residue, then permits the corrected retry", () => {
    const sqlite = lifecycleDatabase();
    const fellowSponsorId = "usr_bootstrap_grant_fellow";
    const orphanGrantSponsorId = "usr_bootstrap_orphan_grant";
    const enrollmentId = fixtureEnrollmentId("bootstrap-orphan-grant");
    const proposalId = "proposal-bootstrap-orphan-grant";
    const fellowId = "fellow-bootstrap-grant";
    sqlite.exec(readFileSync(SPONSOR_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(DEVICE_HARDENING_MIGRATION, "utf8"));
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(fellowSponsorId, NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        enrollmentId,
        fellowSponsorId,
        fixtureDigest("bootstrap-orphan-grant-secret"),
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
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 5)`,
      )
      .run(
        proposalId,
        enrollmentId,
        fellowId,
        fixtureDigest("bootstrap-orphan-grant-flow"),
        "bootstrap-orphan-grant",
        "test-model",
        "test-harness",
        NOW,
        NOW + PENDING_PROPOSAL_TTL_MS,
      );
    sqlite
      .prepare(
        `UPDATE enrollment_proposals
            SET status = 'approved', granted_scopes_json = ?, granted_resources_json = ?
          WHERE proposal_id = ?`,
      )
      .run('["review"]', "{}", proposalId);
    sqlite
      .prepare(
        `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fellowId, fellowSponsorId, "bootstrap-orphan-grant", "test-model", "test-harness", NOW);
    sqlite
      .prepare(
        `INSERT INTO enrollment_grants (
           proposal_id, fellow_id, sponsor_id, granted_scopes_json, granted_resources_json, granted_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(proposalId, fellowId, orphanGrantSponsorId, '["review"]', "{}", NOW);
    // This retained grant predates 0011's future-write binding trigger. Apply
    // the remaining pre-0015 source history only after seeding it, so the sole
    // 0015 preflight defect is the absent grant sponsor, not an invalid new
    // write under today's guard.
    sqlite.exec(readFileSync(CREDENTIAL_HARDENING_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(FELLOW_LIFECYCLE_COMMANDS_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(SPONSOR_FELLOW_CAP_MIGRATION, "utf8"));
    sqlite.exec(readFileSync(SPONSOR_ENROLLMENT_RATE_LIMIT_MIGRATION, "utf8"));
    createMigrationJournal(sqlite);

    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n
             FROM enrollment_fellows fellow
             LEFT JOIN sponsors sponsor ON sponsor.sponsor_id = fellow.sponsor_id
            WHERE fellow.sponsor_id = ? AND sponsor.sponsor_id IS NULL`,
        )
        .get(fellowSponsorId)?.n,
    ).toBe(0);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n
             FROM enrollment_grants grant_row
             LEFT JOIN sponsors sponsor ON sponsor.sponsor_id = grant_row.sponsor_id
            WHERE grant_row.sponsor_id = ? AND sponsor.sponsor_id IS NULL`,
        )
        .get(orphanGrantSponsorId)?.n,
    ).toBe(1);

    expect(() => applyBootstrapInvariantMigrationBatch(sqlite)).toThrow(
      "sponsor enrollment bootstrap witness CHECK rejected legacy history",
    );
    expectBootstrapInvariantMigrationUnapplied(sqlite);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM enrollment_grants WHERE sponsor_id = ?",
        )
        .get(orphanGrantSponsorId)?.n,
    ).toBe(1);

    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(orphanGrantSponsorId, NOW, NOW);
    expect(() => applyBootstrapInvariantMigrationBatch(sqlite)).not.toThrow();
    expect(
      sqlite
        .prepare<{ sequence: number }, [string]>(
          "SELECT sequence FROM _asimposium_migrations WHERE id = ?",
        )
        .get(BOOTSTRAP_INVARIANT_MIGRATION_ID),
    ).toEqual({ sequence: BOOTSTRAP_INVARIANT_MIGRATION_SEQUENCE });
    expectBootstrapInvariantMigrationApplied(sqlite);
  });

  test("0015 keeps a sponsor's legitimate capacity update available after it anchors a Fellow", () => {
    const sqlite = sponsorEnrollmentBootstrapInvariantDatabase();
    const sponsorId = "usr_bootstrap_capacity";
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(sponsorId, NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fellow-bootstrap-capacity",
        sponsorId,
        "bootstrap-capacity-fellow",
        "test-model",
        "test-harness",
        NOW,
      );

    expect(
      sqlite
        .prepare("UPDATE sponsors SET active_fellow_limit = ? WHERE sponsor_id = ?")
        .run(6, sponsorId).changes,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ active_fellow_limit: number }, [string]>(
          "SELECT active_fellow_limit FROM sponsors WHERE sponsor_id = ?",
        )
        .get(sponsorId)?.active_fellow_limit,
    ).toBe(6);
  });

  test("a fresh device approval bootstraps its sponsor, replays exactly, and remains lifecycle-operable in memory and D1", async () => {
    for (const kind of ["memory", "d1"] as const) {
      const clock = new DeviceTestClock();
      const sqlite = kind === "d1" ? sponsorEnrollmentBootstrapInvariantDatabase() : undefined;
      const memoryStore = kind === "memory" ? new InMemoryEnrollmentStore() : undefined;
      const service = new EnrollmentService({
        stoaOrigin: TEST_STOA_ORIGIN,
        agoraOrigin: "https://asimposium.org",
        clock,
        store: memoryStore ?? new D1EnrollmentStore(localD1(sqlite as Database)),
        replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
      });
      const sponsor = { type: "sponsor", sponsorId: `usr_bootstrap_device_${kind}` } as const;
      const started = await service.deviceStart(
        {
          name: `bootstrap-${kind}-device`,
          model: "test-model",
          harness: "codex",
          requested_scopes: ["promote", "review"],
        },
        { trustedClientAddress: kind === "memory" ? "198.51.100.71" : "198.51.100.72" },
      );
      const card = await service.deviceLookup(sponsor, { user_code: started.user_code });
      const decision = {
        enrollment_id: card.enrollmentId,
        decision: "reduce" as const,
        reduction: { scopes: ["review" as const] },
        step_up_authenticated_at: Math.floor(clock.value / 1_000),
      };
      const options = { idempotencyKey: `bootstrap-device-${kind}` } as const;
      const firstDecisionAt = clock.value;

      await expect(
        service.decide(sponsor, card.enrollmentId, decision, options),
      ).resolves.toBeUndefined();
      clock.value +=
        (SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1) * 1_000;
      await expect(
        service.decide(sponsor, card.enrollmentId, decision, options),
      ).resolves.toBeUndefined();
      await expect(
        service.decide(
          sponsor,
          card.enrollmentId,
          {
            enrollment_id: card.enrollmentId,
            decision: "deny",
            step_up_authenticated_at: Math.floor(clock.value / 1_000),
          },
          options,
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      // A later decision by the same sponsor must refresh accountability
      // contact, without rewriting identity, creation history, or capacity.
      clock.value += 1_000;
      const later = await service.deviceStart(
        {
          name: `bootstrap-${kind}-second-device`,
          model: "test-model",
          harness: "codex",
          requested_scopes: ["review"],
        },
        { trustedClientAddress: kind === "memory" ? "198.51.100.73" : "198.51.100.74" },
      );
      const laterCard = await service.deviceLookup(sponsor, { user_code: later.user_code });
      await expect(
        service.decide(
          sponsor,
          laterCard.enrollmentId,
          {
            enrollment_id: laterCard.enrollmentId,
            decision: "deny",
            step_up_authenticated_at: Math.floor(clock.value / 1_000),
          },
          { idempotencyKey: `bootstrap-device-later-${kind}` },
        ),
      ).resolves.toBeUndefined();

      if (memoryStore !== undefined) {
        expect(await memoryStore.sponsorSnapshot(sponsor.sponsorId)).toEqual({
          createdAt: firstDecisionAt,
          lastSeenAt: clock.value,
          activeFellowLimit: 5,
        });
      }

      if (sqlite !== undefined) {
        const afterLaterDecision = sqlite
          .prepare<
            {
              sponsor_id: string;
              created_at: number;
              last_seen_at: number;
              active_fellow_limit: number;
            },
            [string]
          >(
            `SELECT sponsor_id, created_at, last_seen_at, active_fellow_limit
               FROM sponsors WHERE sponsor_id = ?`,
          )
          .get(sponsor.sponsorId);
        expect(afterLaterDecision).toEqual({
          sponsor_id: sponsor.sponsorId,
          created_at: firstDecisionAt,
          last_seen_at: clock.value,
          active_fellow_limit: 5,
        });
      }

      // Bootstrap remains an allowed last-seen update, but cannot rewrite the
      // identity/history/cap fields that the raw negative plants below defend.
      clock.value += 1_000;
      const rebootstrap = await service.bootstrapSponsor(sponsor);
      expect(rebootstrap).toEqual({ created: false, at: clock.value });
      if (memoryStore !== undefined) {
        expect(await memoryStore.sponsorSnapshot(sponsor.sponsorId)).toEqual({
          createdAt: firstDecisionAt,
          lastSeenAt: clock.value,
          activeFellowLimit: 5,
        });
      }

      if (sqlite !== undefined) {
        const original = sqlite
          .prepare<
            {
              sponsor_id: string;
              created_at: number;
              last_seen_at: number;
              active_fellow_limit: number;
            },
            [string]
          >(
            `SELECT sponsor_id, created_at, last_seen_at, active_fellow_limit
               FROM sponsors WHERE sponsor_id = ?`,
          )
          .get(sponsor.sponsorId);
        if (original == null) throw new Error("fresh decision did not retain its sponsor row");
        expect(original.last_seen_at).toBe(clock.value);
        expect(() =>
          sqlite.prepare("DELETE FROM sponsors WHERE sponsor_id = ?").run(sponsor.sponsorId),
        ).toThrow("sponsor enrollment authority cannot be deleted");
        expect(() =>
          sqlite
            .prepare("UPDATE sponsors SET sponsor_id = ? WHERE sponsor_id = ?")
            .run("usr_bootstrap_device_rebound", sponsor.sponsorId),
        ).toThrow("sponsor identity and creation history are immutable");
        expect(() =>
          sqlite
            .prepare("UPDATE sponsors SET created_at = created_at + 1 WHERE sponsor_id = ?")
            .run(sponsor.sponsorId),
        ).toThrow("sponsor identity and creation history are immutable");
        expect(() =>
          sqlite
            .prepare(
              "INSERT OR REPLACE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)",
            )
            .run(sponsor.sponsorId, original.created_at + 1, clock.value + 1),
        ).toThrow("sponsor enrollment authority cannot be replaced");
        expect(
          sqlite
            .prepare<
              {
                sponsor_id: string;
                created_at: number;
                last_seen_at: number;
                active_fellow_limit: number;
              },
              [string]
            >(
              `SELECT sponsor_id, created_at, last_seen_at, active_fellow_limit
                 FROM sponsors WHERE sponsor_id = ?`,
            )
            .get(sponsor.sponsorId),
        ).toEqual(original);
      }

      const issued = await service.poll({ flow_handle: started.device_code });
      if (issued.status !== "approved") throw new Error("fixture token was not issued");
      const fellow = (await service.fellows(sponsor))[0];
      const credential = fellow?.credentials[0];
      if (fellow === undefined || credential === undefined) {
        throw new Error("fresh sponsor did not retain the approved Fellow credential");
      }
      await expect(
        service.revokeCredential(
          sponsor,
          {
            fellow_id: fellow.fellowId,
            credential_id: credential.credentialId,
            confirm: "revoke-credential",
            step_up_authenticated_at: Math.floor(clock.value / 1_000),
          },
          { idempotencyKey: `bootstrap-device-revoke-${kind}` },
        ),
      ).resolves.toMatchObject({ acknowledged: true, sponsor_seq: 1 });
      await expect(service.credentialBinding(issued.token)).resolves.toBeUndefined();
      await expect(
        service.panicSponsor(
          sponsor,
          {
            confirm: "revoke-all-fellow-credentials",
            step_up_authenticated_at: Math.floor(clock.value / 1_000),
          },
          { idempotencyKey: `bootstrap-device-panic-${kind}` },
        ),
      ).resolves.toMatchObject({ acknowledged: true, sponsor_seq: 2 });

      if (sqlite !== undefined) {
        expect(
          sqlite
            .prepare<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM sponsors WHERE sponsor_id = ?",
            )
            .get(sponsor.sponsorId)?.n,
        ).toBe(1);
        expect(
          sqlite
            .prepare<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM enrollment_fellows WHERE sponsor_id = ?",
            )
            .get(sponsor.sponsorId)?.n,
        ).toBe(1);
        expect(
          sqlite
            .prepare<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM enrollment_grants WHERE sponsor_id = ?",
            )
            .get(sponsor.sponsorId)?.n,
        ).toBe(1);
        expect(
          sqlite
            .prepare<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE principal_scope = ? AND scope = 'decision'",
            )
            .get(`sponsor:${sponsor.sponsorId}`)?.n,
        ).toBe(2);
      }
    }
  });

  test("D1 rolls back first-contact bootstrap, join approval, and replay together on a planted Fellow insert failure", async () => {
    const clock = new DeviceTestClock();
    const sqlite = sponsorEnrollmentBootstrapInvariantDatabase();
    let failFellowInsert = true;
    const service = new EnrollmentService({
      stoaOrigin: TEST_STOA_ORIGIN,
      agoraOrigin: "https://asimposium.org",
      clock,
      store: new D1EnrollmentStore(
        localD1(sqlite, {
          onStatement: (query) => {
            if (failFellowInsert && query.includes("INSERT INTO enrollment_fellows")) {
              throw new Error("planted fellow insert failure");
            }
          },
        }),
      ),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const sponsor = { type: "sponsor", sponsorId: "usr_bootstrap_join" } as const;
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "bootstrap-join-fellow",
      model: "test-model",
      harness: "test-harness",
    });
    const decision = {
      enrollment_id: minted.enrollmentId,
      decision: "approve" as const,
      step_up_authenticated_at: Math.floor(clock.value / 1_000),
    };
    const options = { idempotencyKey: "bootstrap-join-atomic" } as const;

    await expect(
      service.decide(sponsor, minted.enrollmentId, decision, options),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    expect(
      sqlite
        .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sponsors WHERE sponsor_id = ?")
        .get(sponsor.sponsorId)?.n,
    ).toBe(0);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_fellows").get()?.n,
    ).toBe(0);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(0);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'decision'",
        )
        .get()?.n,
    ).toBe(0);
    expect(
      sqlite
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM enrollment_proposals WHERE enrollment_id = ?",
        )
        .get(minted.enrollmentId)?.status,
    ).toBe("pending");

    failFellowInsert = false;
    await expect(
      service.decide(sponsor, minted.enrollmentId, decision, options),
    ).resolves.toBeUndefined();
    clock.value +=
      (SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1) * 1_000;
    await expect(
      service.decide(sponsor, minted.enrollmentId, decision, options),
    ).resolves.toBeUndefined();
    await expect(
      service.decide(
        sponsor,
        minted.enrollmentId,
        {
          enrollment_id: minted.enrollmentId,
          decision: "deny",
          step_up_authenticated_at: Math.floor(clock.value / 1_000),
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(
      sqlite
        .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sponsors WHERE sponsor_id = ?")
        .get(sponsor.sponsorId)?.n,
    ).toBe(1);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_fellows").get()?.n,
    ).toBe(1);
    expect(
      sqlite.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_grants").get()?.n,
    ).toBe(1);
    expect(
      sqlite
        .prepare<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM enrollment_idempotency WHERE scope = 'decision'",
        )
        .get()?.n,
    ).toBe(1);
  });
});
