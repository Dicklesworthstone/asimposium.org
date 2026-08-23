import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectState,
} from "@cloudflare/workers-types";
import { canonicalClaimPayload } from "./krater";
import {
  boundedOutboxBackoff,
  KraterOutboxDrainer,
  OUTBOX_ALARM_BASE_MS,
  OUTBOX_ALARM_MAX_MS,
  OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE,
  OUTBOX_DRAIN_BATCH_SIZE,
  OUTBOX_IDLE_RECONCILE_MS,
  OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS,
  OUTBOX_PENDING_SNAPSHOT_SQL,
  OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE,
  oldestPendingAge,
  oldestPendingAgeAlert,
  validateOutboxRow,
} from "./outbox-do";

// This is an acceptance contract, deliberately independent of the production
// retry ceiling. It keeps a five-minute production regression observable here.
const RETRY_ALARM_CONTRACT_MAX_MS = 2_000;

const KRATER_MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0001_krater_v0.sql");
const QUARANTINE_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0007_outbox_quarantine_state.sql",
);

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const SEARCH_INDEX_SOURCE_SQL = normalizeSql(`SELECT e.id AS event_id, e.problem_id,
  e.object_id AS claim_id, e.payload_sha256, c.statement FROM events e
  JOIN claims c ON c.id = e.object_id AND c.problem_id = e.problem_id
  WHERE e.id = ? AND e.problem_id = ? AND e.type = 'claim.created'
  AND e.object_kind = 'claim' AND e.object_version = 1
  AND e.payload_sha256 = ? AND c.payload_sha256 = e.payload_sha256`);

const ACK_DELIVERED_CAS_SQL = normalizeSql(`UPDATE outbox SET state = 'delivered',
  delivered_at = ? WHERE id = ? AND state = 'pending' AND quarantined_at IS NULL
  AND event_id = ? AND problem_id = ? AND kind = ?
  AND dedupe_key = ? AND payload_sha256 = ?`);

/**
 * The immutable identity columns the delivered CAS must bind, in bind order
 * after `delivered_at` and `id`. Each one gets its own mutation plant below.
 */
const ACK_IDENTITY_COLUMNS = ["event_id", "problem_id", "kind", "dedupe_key", "payload_sha256"];

interface FakeOutboxRow {
  readonly id: number;
  readonly event_id: string;
  readonly problem_id: string;
  readonly kind: string;
  readonly dedupe_key: string;
  readonly payload_sha256: string;
  state: "pending" | "delivered";
  created_at: string;
  delivered_at: string | null;
  quarantined_at: string | null;
  quarantine_code: string | null;
}

interface FakeEventRow {
  readonly id: string;
  readonly problem_id: string;
  readonly type: string;
  readonly object_kind: string;
  readonly object_id: string;
  readonly object_version: number;
  readonly payload_sha256: string;
}

interface FakeClaimRow {
  readonly id: string;
  readonly problem_id: string;
  readonly statement: string;
  readonly payload_sha256: string;
}

interface FakeSearchDocument {
  readonly claim_id: string;
  readonly problem_id: string;
  readonly statement: string;
}

interface FakePreparedStatement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

interface OutboxHarness {
  readonly drainer: KraterOutboxDrainer;
  readonly deliver: (request: Request) => Promise<Response>;
  readonly restart: () => KraterOutboxDrainer;
  readonly alarmAt: () => number | null;
  readonly alarmScheduledAt: () => number | null;
  readonly storageValue: (key: string) => unknown;
  readonly storageKeys: () => readonly string[];
  readonly pendingRows: () => number;
  readonly statusSnapshotQueries: () => number;
  readonly searchDocuments: () => readonly FakeSearchDocument[];
}

interface FakeStorageOperation {
  readonly kind: "put" | "delete" | "list";
  readonly key: string;
}

interface OutboxHarnessOptions {
  readonly initialStorage?: Readonly<Record<string, unknown>>;
  readonly acknowledgeFailures?: number;
  readonly acknowledgeZeroChanges?: number;
  readonly searchIndexEffectFailures?: number;
  readonly missingSourceClaim?: boolean;
  readonly sourceProblemId?: string;
  readonly sourceEventType?: string;
  readonly sourceObjectVersion?: number;
  readonly sourcePayloadSha256?: string;
  readonly sourceClaimPayloadSha256?: string;
  readonly sourceStatement?: string;
  readonly beforeAcknowledge?: (
    storage: ReadonlyMap<string, unknown>,
    searchDocuments: readonly FakeSearchDocument[],
  ) => void;
  readonly afterStatusSnapshot?: () => void;
  readonly afterPendingPage?: (page: number, rows: FakeOutboxRow[]) => void | Promise<void>;
  readonly failAttemptSnapshotOnce?: boolean;
  readonly failStorageOnce?: (operation: FakeStorageOperation) => boolean;
  readonly failStorageAlways?: (operation: FakeStorageOperation) => boolean;
}

function outboxRow(id: number, valid = true, createdAt?: string): FakeOutboxRow {
  const eventId = `E-outbox-${id}`;
  const claimId = `C-outbox-${id}`;
  const statement = `Public claim ${id}`;
  const payloadSha256 = createHash("sha256")
    .update(canonicalClaimPayload({ claimId, kind: "claim", statement }))
    .digest("hex");
  return {
    id,
    event_id: eventId,
    problem_id: "P-outbox",
    kind: valid ? "search.index" : "malformed",
    dedupe_key: `search.index:${eventId}`,
    payload_sha256: payloadSha256,
    state: "pending",
    created_at: createdAt ?? new Date().toISOString(),
    delivered_at: null,
    quarantined_at: null,
    quarantine_code: null,
  };
}

function searchDocumentFor(row: FakeOutboxRow): FakeSearchDocument {
  return {
    claim_id: `C-outbox-${row.id}`,
    problem_id: row.problem_id,
    statement: `Public claim ${row.id}`,
  };
}

function durableCountersWithFailures(failures: number) {
  return {
    owner_acquisitions: 0,
    max_active: 0,
    recovered_ownerships: 0,
    delivery_attempts: 0,
    delivered: 0,
    quarantined: 0,
    failures,
    last_backoff_ms: null,
    last_quarantine_code: null,
    last_phase: "retry",
  };
}

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function outboxHarness(rows: FakeOutboxRow[], options: OutboxHarnessOptions = {}): OutboxHarness {
  const storage = new Map<string, unknown>(Object.entries(options.initialStorage ?? {}));
  const events = new Map<string, FakeEventRow>();
  const claims = new Map<string, FakeClaimRow>();
  const searchDocuments: FakeSearchDocument[] = [];
  const materializeSource = (row: FakeOutboxRow): void => {
    if (events.has(row.event_id)) return;
    const claimId = `C-outbox-${row.id}`;
    const payloadSha256 = options.sourcePayloadSha256 ?? row.payload_sha256;
    const problemId = options.sourceProblemId ?? row.problem_id;
    events.set(row.event_id, {
      id: row.event_id,
      problem_id: problemId,
      type: options.sourceEventType ?? "claim.created",
      object_kind: "claim",
      object_id: claimId,
      object_version: options.sourceObjectVersion ?? 1,
      payload_sha256: payloadSha256,
    });
    if (options.missingSourceClaim) return;
    claims.set(claimId, {
      id: claimId,
      problem_id: problemId,
      statement: options.sourceStatement ?? `Public claim ${row.id}`,
      payload_sha256: options.sourceClaimPayloadSha256 ?? payloadSha256,
    });
  };
  for (const row of rows) materializeSource(row);
  let acknowledgeFailures = options.acknowledgeFailures ?? 0;
  let acknowledgeZeroChanges = options.acknowledgeZeroChanges ?? 0;
  let searchIndexEffectFailures = options.searchIndexEffectFailures ?? 0;
  let alarmAt: number | null = null;
  let alarmScheduledAt: number | null = null;
  let statusSnapshotQueries = 0;
  let storageFailureInjected = false;
  let pendingPageQueries = 0;
  let failAttemptSnapshot = options.failAttemptSnapshotOnce ?? false;
  let eventsBlocked = false;
  const blockedEventWaiters: Array<() => void> = [];

  const rejectPlantedStorageOperation = (operation: FakeStorageOperation): void => {
    const failOnce = !storageFailureInjected && options.failStorageOnce?.(operation) === true;
    if (failOnce) {
      storageFailureInjected = true;
    }
    if (failOnce || options.failStorageAlways?.(operation) === true) {
      throw new Error(`PLANTED_STORAGE_${operation.kind.toUpperCase()}_FAILURE:${operation.key}`);
    }
  };

  const durableState = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries === "string") {
          rejectPlantedStorageOperation({ kind: "put", key: keyOrEntries });
          storage.set(keyOrEntries, value);
        } else {
          for (const [key, entry] of Object.entries(keyOrEntries)) {
            rejectPlantedStorageOperation({ kind: "put", key });
            storage.set(key, entry);
          }
        }
      },
      delete: async (key: string) => {
        rejectPlantedStorageOperation({ kind: "delete", key });
        return storage.delete(key);
      },
      list: async (options?: { prefix?: string; startAfter?: string; limit?: number }) => {
        const prefix = options?.prefix ?? "";
        rejectPlantedStorageOperation({ kind: "list", key: prefix });
        const entries = [...storage.entries()]
          .filter(
            ([key]) =>
              key.startsWith(prefix) &&
              (options?.startAfter === undefined || key > options.startAfter),
          )
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .slice(0, options?.limit);
        return new Map(entries);
      },
      setAlarm: async (scheduledTime: number) => {
        alarmScheduledAt = Date.now();
        alarmAt = scheduledTime;
      },
      deleteAlarm: async () => {
        alarmAt = null;
      },
      getAlarm: async () => alarmAt,
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => {
      if (eventsBlocked) throw new Error("PLANTED_NESTED_BLOCK_CONCURRENCY_WINDOW");
      eventsBlocked = true;
      try {
        return await callback();
      } finally {
        eventsBlocked = false;
        for (const release of blockedEventWaiters.splice(0)) release();
      }
    },
  } as unknown as DurableObjectState;

  const database = {
    prepare: (sql: string) => {
      let bindings: readonly unknown[] = [];
      const prepared = {
        get sql(): string {
          return sql;
        },
        get bindings(): readonly unknown[] {
          return bindings;
        },
        bind: (...values: unknown[]) => {
          bindings = values;
          return prepared as unknown as D1PreparedStatement;
        },
        all: async <T>() => {
          if (sql.includes("SELECT event_id FROM outbox") && sql.includes("event_id IN")) {
            if (failAttemptSnapshot) {
              failAttemptSnapshot = false;
              throw new Error("PLANTED_ATTEMPT_SNAPSHOT_FAILURE");
            }
            const wanted = new Set(
              bindings.filter((value): value is string => typeof value === "string"),
            );
            return {
              results: rows
                .filter(
                  (row) =>
                    wanted.has(row.event_id) &&
                    row.state === "pending" &&
                    row.quarantined_at === null,
                )
                .map((row) => ({ event_id: row.event_id })) as T[],
              success: true,
              meta: {},
            };
          }
          if (
            !sql.includes("FROM outbox") ||
            !sql.includes("state = 'pending' AND quarantined_at IS NULL AND id > ?")
          ) {
            throw new Error(`unexpected all query: ${sql}`);
          }
          const [afterId, middle, final] = bindings;
          const throughId = sql.includes("AND id <= ?") ? middle : undefined;
          const limit = throughId === undefined ? middle : final;
          if (
            typeof afterId !== "number" ||
            (throughId !== undefined && typeof throughId !== "number") ||
            typeof limit !== "number"
          ) {
            throw new Error("outbox page bindings missing");
          }
          const results = rows
            .filter(
              (row) =>
                row.state === "pending" &&
                row.quarantined_at === null &&
                row.id > afterId &&
                (throughId === undefined || row.id <= throughId),
            )
            .sort((left, right) => left.id - right.id)
            .slice(0, limit);
          pendingPageQueries += 1;
          await options.afterPendingPage?.(pendingPageQueries, rows);
          return { results: results as T[], success: true, meta: {} };
        },
        first: async <T>() => {
          if (sql.includes("FROM events e") || sql.includes("JOIN claims c")) {
            if (normalizeSql(sql) !== SEARCH_INDEX_SOURCE_SQL) {
              throw new Error("PLANTED_SEARCH_INDEX_SOURCE_SQL_DRIFT");
            }
            if (bindings.length !== 3) {
              throw new Error("PLANTED_SEARCH_INDEX_SOURCE_BINDING_DRIFT");
            }
            const [eventId, problemId, payloadSha256] = bindings;
            if (
              typeof eventId !== "string" ||
              typeof problemId !== "string" ||
              typeof payloadSha256 !== "string"
            ) {
              throw new Error("PLANTED_SEARCH_INDEX_SOURCE_BINDING_DRIFT");
            }
            const queued = rows.find((candidate) => candidate.event_id === eventId);
            if (queued !== undefined) materializeSource(queued);
            const event = events.get(eventId);
            const claim = event === undefined ? undefined : claims.get(event.object_id);
            if (
              event === undefined ||
              claim === undefined ||
              event.problem_id !== problemId ||
              event.type !== "claim.created" ||
              event.object_kind !== "claim" ||
              event.object_version !== 1 ||
              event.payload_sha256 !== payloadSha256 ||
              claim.problem_id !== event.problem_id ||
              claim.payload_sha256 !== event.payload_sha256
            ) {
              return null;
            }
            return {
              event_id: event.id,
              problem_id: event.problem_id,
              claim_id: claim.id,
              payload_sha256: event.payload_sha256,
              statement: claim.statement,
            } as T;
          }
          if (sql === OUTBOX_PENDING_SNAPSHOT_SQL) {
            const [now] = bindings;
            if (typeof now !== "string" || !isCanonicalUtcTimestamp(now)) {
              throw new Error("outbox status snapshot binding missing");
            }
            statusSnapshotQueries += 1;
            const pendingRows = rows.filter(
              (row) => row.state === "pending" && row.quarantined_at === null,
            );
            const invalidTimestampCount = pendingRows.filter(
              (row) => !isCanonicalUtcTimestamp(row.created_at),
            ).length;
            const futureTimestampCount = pendingRows.filter(
              (row) => isCanonicalUtcTimestamp(row.created_at) && row.created_at > now,
            ).length;
            const snapshot = {
              count: pendingRows.length,
              oldest:
                pendingRows
                  .map((row) => row.created_at)
                  .sort()
                  .at(0) ?? null,
              invalid_timestamp_count: invalidTimestampCount,
              future_timestamp_count: futureTimestampCount,
            };
            options.afterStatusSnapshot?.();
            return snapshot as T;
          }
          if (
            sql.includes(
              "SELECT COUNT(*) AS count FROM outbox WHERE state = 'pending' AND quarantined_at IS NULL",
            )
          ) {
            return {
              count: rows.filter((row) => row.state === "pending" && row.quarantined_at === null)
                .length,
            } as T;
          }
          if (
            sql.includes(
              "SELECT MIN(created_at) AS oldest FROM outbox WHERE state = 'pending' AND quarantined_at IS NULL",
            )
          ) {
            const pendingRows = rows.filter(
              (row) => row.state === "pending" && row.quarantined_at === null,
            );
            const oldest = pendingRows
              .map((row) => row.created_at)
              .sort()
              .at(0);
            return { oldest: oldest ?? null } as T;
          }
          throw new Error(`unexpected first query: ${sql}`);
        },
        run: async () => {
          if (sql.includes("SET quarantined_at = ?")) {
            const [quarantinedAt, quarantineCode, id] = bindings;
            const row = rows.find(
              (candidate) =>
                candidate.id === id &&
                candidate.state === "pending" &&
                candidate.quarantined_at === null,
            );
            if (
              row !== undefined &&
              typeof quarantinedAt === "string" &&
              typeof quarantineCode === "string"
            ) {
              row.quarantined_at = quarantinedAt;
              row.quarantine_code = quarantineCode;
            }
            return { success: true, meta: { changes: row === undefined ? 0 : 1 } };
          }
          if (!sql.includes("UPDATE outbox SET state = 'delivered'")) {
            throw new Error(`unexpected run query: ${sql}`);
          }
          if (normalizeSql(sql) !== ACK_DELIVERED_CAS_SQL) {
            throw new Error("PLANTED_ACK_CAS_SQL_DRIFT");
          }
          if (bindings.length !== 7) {
            throw new Error("PLANTED_ACK_CAS_BINDING_DRIFT");
          }
          // Honour every bound predicate, not only `id`. A fake that matched on
          // the primary key alone would report deliveries that real D1 refuses,
          // which is exactly the false-green this repair exists to remove. The
          // authoritative proof still runs against SQLite further below.
          const matchesCas = (candidate: FakeOutboxRow): boolean => {
            const [, id, eventId, problemId, kind, dedupeKey, payloadSha256] = bindings;
            return (
              candidate.id === id &&
              candidate.state === "pending" &&
              candidate.quarantined_at === null &&
              candidate.event_id === eventId &&
              candidate.problem_id === problemId &&
              candidate.kind === kind &&
              candidate.dedupe_key === dedupeKey &&
              candidate.payload_sha256 === payloadSha256
            );
          };
          options.beforeAcknowledge?.(
            storage,
            searchDocuments.map((document) => ({ ...document })),
          );
          if (acknowledgeFailures > 0) {
            acknowledgeFailures -= 1;
            throw new Error("PLANTED_D1_ACKNOWLEDGEMENT_FAILURE");
          }
          if (acknowledgeZeroChanges > 0) {
            acknowledgeZeroChanges -= 1;
            const row = rows.find(matchesCas);
            if (row !== undefined) {
              // Model the real zero-row CAS: another writer terminalized the
              // row after selection but before this owner's guarded update.
              row.state = "delivered";
              row.delivered_at = new Date().toISOString();
            }
            return { success: true, meta: { changes: 0 } };
          }
          const [deliveredAt] = bindings;
          const row = rows.find(matchesCas);
          if (row !== undefined && typeof deliveredAt === "string") {
            row.state = "delivered";
            row.delivered_at = deliveredAt;
          }
          return { success: true, meta: { changes: row === undefined ? 0 : 1 } };
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
    batch: async (statements: readonly D1PreparedStatement[]) => {
      const [deletion, insertion] = statements as unknown as readonly FakePreparedStatement[];
      if (
        statements.length !== 2 ||
        deletion === undefined ||
        insertion === undefined ||
        !deletion.sql.includes(
          "DELETE FROM public_claim_fts WHERE claim_id = ? AND problem_id = ?",
        ) ||
        !insertion.sql.includes("INSERT INTO public_claim_fts")
      ) {
        throw new Error("PLANTED_SEARCH_INDEX_BATCH_INVALID");
      }
      const [claimId, problemId, statement] = insertion.bindings;
      if (
        typeof claimId !== "string" ||
        typeof problemId !== "string" ||
        typeof statement !== "string" ||
        deletion.bindings[0] !== claimId ||
        deletion.bindings[1] !== problemId
      ) {
        throw new Error("PLANTED_SEARCH_INDEX_BINDINGS_INVALID");
      }
      if (searchIndexEffectFailures > 0) {
        searchIndexEffectFailures -= 1;
        throw new Error("PLANTED_SEARCH_INDEX_EFFECT_FAILURE");
      }
      const retained = searchDocuments.filter(
        (document) => document.claim_id !== claimId || document.problem_id !== problemId,
      );
      searchDocuments.splice(0, searchDocuments.length, ...retained, {
        claim_id: claimId,
        problem_id: problemId,
        statement,
      });
      return [
        { success: true, meta: { changes: searchDocuments.length - retained.length } },
        { success: true, meta: { changes: 1 } },
      ];
    },
  } as unknown as D1Database;

  const restart = () => new KraterOutboxDrainer(durableState, { DB: database });
  const drainer = restart();
  const deliver = async (request: Request): Promise<Response> => {
    while (eventsBlocked) {
      await new Promise<void>((resolve) => blockedEventWaiters.push(resolve));
    }
    return drainer.fetch(request);
  };
  return {
    drainer,
    deliver,
    restart,
    alarmAt: () => alarmAt,
    alarmScheduledAt: () => alarmScheduledAt,
    storageValue: (key) => storage.get(key),
    storageKeys: () => [...storage.keys()].sort(),
    pendingRows: () =>
      rows.filter((row) => row.state === "pending" && row.quarantined_at === null).length,
    statusSnapshotQueries: () => statusSnapshotQueries,
    searchDocuments: () => searchDocuments.map((document) => ({ ...document })),
  };
}

function scheduledAlarmDelayMs(harness: OutboxHarness): number {
  const scheduledAt = harness.alarmAt();
  const observedAt = harness.alarmScheduledAt();
  if (scheduledAt === null || observedAt === null) {
    throw new Error("PLANTED_ALARM_NOT_SCHEDULED");
  }
  return scheduledAt - observedAt;
}

function drainRequest(faultMode: "none" | "fail-once" | "hold-before-ack" = "none"): Request {
  return new Request("https://krater-outbox.internal/drain-now", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault_mode: faultMode }),
  });
}

function nudgeRequest(): Request {
  return new Request("https://krater-outbox.internal/nudge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault_mode: "none" }),
  });
}

async function drainScheduledAlarms(harness: OutboxHarness): Promise<void> {
  for (let attempts = 0; attempts < 16; attempts += 1) {
    const hasPendingRows = harness.pendingRows() > 0;
    const hasAttemptKeys = harness.storageKeys().some((key) => key.startsWith("attempt:"));
    const hasDerivedCursor =
      harness.storageValue("attempt_reclaim_after") !== undefined ||
      harness.storageValue("scan_wrap_through_id") !== undefined;
    if (!hasPendingRows && !hasAttemptKeys && !hasDerivedCursor) break;
    expect(harness.alarmAt()).not.toBeNull();
    await harness.drainer.alarm();
  }
  expect(harness.pendingRows()).toBe(0);
  expect(harness.storageKeys().some((key) => key.startsWith("attempt:"))).toBe(false);
  expect(harness.storageValue("attempt_reclaim_after")).toBeUndefined();
  expect(harness.storageValue("scan_wrap_through_id")).toBeUndefined();
  expect(harness.alarmAt()).not.toBeNull();
}

describe("Krater outbox Durable Object contracts", () => {
  test("0007 preserves existing rows and makes quarantine terminal without rebuilding outbox", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec(readFileSync(KRATER_MIGRATION, "utf8"));
    sqlite
      .prepare("INSERT INTO problems (id, created_at, updated_at) VALUES (?, ?, ?)")
      .run("P-outbox", "2026-08-14T00:00:00Z", "2026-08-14T00:00:00Z");
    for (const id of [1, 2]) {
      sqlite
        .prepare(
          `INSERT INTO events (
             id, problem_id, seq, type, object_kind, object_id,
             object_version, payload_sha256, created_at
           ) VALUES (?, 'P-outbox', ?, 'claim.promoted', 'claim', ?, 1, ?, ?)`,
        )
        .run(`E-outbox-${id}`, id, `C-outbox-${id}`, "a".repeat(64), "2026-08-14T00:00:00Z");
    }
    sqlite
      .prepare(
        `INSERT INTO outbox (
           id, event_id, problem_id, kind, dedupe_key, payload_sha256,
           state, created_at, delivered_at
         ) VALUES
           (1, 'E-outbox-1', 'P-outbox', 'search.index', 'search.index:E-outbox-1', ?,
            'pending', '2026-08-14T00:00:00Z', NULL),
           (2, 'E-outbox-2', 'P-outbox', 'search.index', 'search.index:E-outbox-2', ?,
            'delivered', '2026-08-14T00:00:00Z', '2026-08-14T00:01:00Z')`,
      )
      .run("a".repeat(64), "b".repeat(64));

    sqlite.exec(readFileSync(QUARANTINE_MIGRATION, "utf8"));

    expect(
      sqlite
        .prepare<
          {
            id: number;
            state: string;
            quarantined_at: string | null;
            quarantine_code: string | null;
          },
          []
        >("SELECT id, state, quarantined_at, quarantine_code FROM outbox ORDER BY id")
        .all(),
    ).toEqual([
      { id: 1, state: "pending", quarantined_at: null, quarantine_code: null },
      { id: 2, state: "delivered", quarantined_at: null, quarantine_code: null },
    ]);
    sqlite
      .prepare("UPDATE outbox SET quarantined_at = ?, quarantine_code = ? WHERE id = 1")
      .run("2026-08-14T00:02:00Z", "OUTBOX_PAYLOAD_INVALID");
    expect(() =>
      sqlite
        .prepare("UPDATE outbox SET state = 'delivered', delivered_at = ? WHERE id = 1")
        .run("2026-08-14T00:03:00Z"),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare("UPDATE outbox SET quarantined_at = ?, quarantine_code = ? WHERE id = 2")
        .run("2026-08-14T00:02:00Z", "OUTBOX_PAYLOAD_INVALID"),
    ).toThrow();
    expect(
      sqlite
        .prepare<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .some((row) => row.name === "outbox_drainable_idx"),
    ).toBe(true);
  });

  test("runs the shipped search.index source query against real SQLite", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec(readFileSync(KRATER_MIGRATION, "utf8"));
    const digest = "c".repeat(64);
    const driftedDigest = "d".repeat(64);
    for (const problemId of ["P-src", "P-other"]) {
      sqlite
        .prepare("INSERT INTO problems (id, created_at, updated_at) VALUES (?, ?, ?)")
        .run(problemId, "2026-08-17T00:00:00Z", "2026-08-17T00:00:00Z");
    }
    const insertClaim = sqlite.prepare(
      `INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
         VALUES (?, ?, ?, ?, ?, '2026-08-17T00:00:00Z')`,
    );
    const insertEvent = sqlite.prepare(
      `INSERT INTO events (
           id, problem_id, seq, type, object_kind, object_id,
           object_version, payload_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-17T00:00:00Z')`,
    );
    // The one row the shipped predicate must accept.
    insertClaim.run("C-ok", "P-src", "public claim", digest, 1);
    insertEvent.run("E-ok", "P-src", 1, "claim.created", "claim", "C-ok", 1, digest);
    // One negative row per conjunct, so each conjunct has something to exclude.
    insertClaim.run("C-type", "P-src", "wrong event type", digest, 2);
    insertEvent.run("E-type", "P-src", 2, "claim.promoted", "claim", "C-type", 1, digest);
    insertClaim.run("C-ver", "P-src", "wrong object version", digest, 3);
    insertEvent.run("E-ver", "P-src", 3, "claim.created", "claim", "C-ver", 2, digest);
    insertClaim.run("C-kind", "P-src", "wrong object kind", digest, 4);
    insertEvent.run("E-kind", "P-src", 4, "claim.created", "problem", "C-kind", 1, digest);
    // The security-critical negative: the stored claim body no longer agrees
    // with the digest that was queued, so its text must not reach the index.
    insertClaim.run("C-dig", "P-src", "claim body drifted", driftedDigest, 5);
    insertEvent.run("E-dig", "P-src", 5, "claim.created", "claim", "C-dig", 1, digest);
    // A different problem may not reach through the join to another's claim row.
    insertEvent.run("E-cross", "P-other", 1, "claim.created", "claim", "C-ok", 1, digest);

    const shipped = sqlite.prepare(SEARCH_INDEX_SOURCE_SQL);
    expect(shipped.all("E-ok", "P-src", digest)).toEqual([
      {
        event_id: "E-ok",
        problem_id: "P-src",
        claim_id: "C-ok",
        payload_sha256: digest,
        statement: "public claim",
      },
    ]);
    for (const eventId of ["E-type", "E-ver", "E-kind", "E-dig"]) {
      expect(shipped.all(eventId, "P-src", digest)).toEqual([]);
    }
    expect(shipped.all("E-cross", "P-other", digest)).toEqual([]);

    // Non-vacuity: deleting a conjunct from the shipped text must let its
    // matching negative row through. If a mutated query still returned nothing
    // the negatives above would be proving nothing about the predicate.
    const withoutDigestAgreement = SEARCH_INDEX_SOURCE_SQL.replace(
      " AND c.payload_sha256 = e.payload_sha256",
      "",
    );
    expect(withoutDigestAgreement).not.toBe(SEARCH_INDEX_SOURCE_SQL);
    expect(sqlite.prepare(withoutDigestAgreement).all("E-dig", "P-src", digest)).toHaveLength(1);
    const withoutVersionPin = SEARCH_INDEX_SOURCE_SQL.replace(" AND e.object_version = 1", "");
    expect(withoutVersionPin).not.toBe(SEARCH_INDEX_SOURCE_SQL);
    expect(sqlite.prepare(withoutVersionPin).all("E-ver", "P-src", digest)).toHaveLength(1);
    sqlite.close();
  });

  test("delivered CAS refuses a row whose selected identity changed under it", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec(readFileSync(KRATER_MIGRATION, "utf8"));
    const digest = "e".repeat(64);
    sqlite
      .prepare("INSERT INTO problems (id, created_at, updated_at) VALUES (?, ?, ?)")
      .run("P-ack", "2026-08-17T00:00:00Z", "2026-08-17T00:00:00Z");
    sqlite
      .prepare(
        `INSERT INTO events (
             id, problem_id, seq, type, object_kind, object_id,
             object_version, payload_sha256, created_at
           ) VALUES (?, 'P-ack', ?, 'claim.created', 'claim', ?, 1, ?, '2026-08-17T00:00:00Z')`,
      )
      .run("E-ack", 1, "C-ack", digest);
    const insertOutbox = sqlite.prepare(
      `INSERT INTO outbox (
           id, event_id, problem_id, kind, dedupe_key, payload_sha256, state, created_at
         ) VALUES (?, 'E-ack', 'P-ack', 'search.index', ?, ?, 'pending', '2026-08-17T00:00:00Z')`,
    );
    insertOutbox.run(1, "search.index:E-ack", digest);
    insertOutbox.run(2, "search.index:E-ack-legacy", digest);
    sqlite.exec(readFileSync(QUARANTINE_MIGRATION, "utf8"));

    const selected = {
      id: 1,
      event_id: "E-ack",
      problem_id: "P-ack",
      kind: "search.index",
      dedupe_key: "search.index:E-ack",
      payload_sha256: digest,
    };
    const bindingsFor = (row: typeof selected): (string | number)[] => [
      "2026-08-17T00:05:00Z",
      row.id,
      row.event_id,
      row.problem_id,
      row.kind,
      row.dedupe_key,
      row.payload_sha256,
    ];
    const cas = sqlite.prepare(ACK_DELIVERED_CAS_SQL);
    const stateQuery = sqlite.prepare("SELECT state FROM outbox WHERE id = ?");
    const stateOf = (id: number): unknown[] => stateQuery.all(id);

    // One plant per immutable identity column. The drain holds the tuple it
    // validated while the stored row disagrees in exactly one field, so the CAS
    // must change nothing. Binding a differing value is equivalent to another
    // writer having replaced the handoff under the same primary key.
    const identityPlants: ReadonlyArray<readonly [string, typeof selected]> = [
      ["event_id", { ...selected, event_id: "E-ack-other" }],
      ["problem_id", { ...selected, problem_id: "P-ack-other" }],
      ["kind", { ...selected, kind: "search.reindex" }],
      ["dedupe_key", { ...selected, dedupe_key: "search.index:E-ack-other" }],
      ["payload_sha256", { ...selected, payload_sha256: "f".repeat(64) }],
    ];
    expect(identityPlants.map(([column]) => column)).toEqual(ACK_IDENTITY_COLUMNS);
    for (const [, mutated] of identityPlants) {
      expect(cas.run(...bindingsFor(mutated)).changes).toBe(0);
      expect(stateOf(1)).toEqual([{ state: "pending" }]);
    }

    // Non-vacuity: the pre-repair CAS consulted no identity column at all, so it
    // terminalizes row 2 on primary key alone. That is precisely the check the
    // strengthened predicate adds, and the reason a handoff swapped under a
    // reused id could not be detected before this repair.
    const legacyCas = sqlite.prepare(
      `UPDATE outbox SET state = 'delivered', delivered_at = ?
       WHERE id = ? AND state = 'pending' AND quarantined_at IS NULL`,
    );
    expect(legacyCas.run("2026-08-17T00:06:00Z", 2).changes).toBe(1);
    expect(stateOf(2)).toEqual([{ state: "delivered" }]);

    // Positive control: the tuple the drain actually selected still delivers,
    // so the plants above are rejections rather than a CAS that never matches.
    expect(cas.run(...bindingsFor(selected)).changes).toBe(1);
    expect(stateOf(1)).toEqual([{ state: "delivered" }]);

    // Honest limit: this proves the CAS predicate directly at the SQL layer.
    // The drain harness models the crash window cooperatively (`hold-before-ack`
    // returns before the acknowledgement), so nothing here claims proof against
    // abrupt process death between the effect and the acknowledgement.
    sqlite.close();
  });

  test("keeps exponential alarm backoff inside the explicit local safety bound", () => {
    expect(boundedOutboxBackoff(1)).toBe(OUTBOX_ALARM_BASE_MS);
    expect(boundedOutboxBackoff(2)).toBe(OUTBOX_ALARM_BASE_MS * 2);
    expect(boundedOutboxBackoff(99)).toBe(OUTBOX_ALARM_MAX_MS);
    expect(() => boundedOutboxBackoff(0)).toThrow("KRATER_OUTBOX_BACKOFF_INVALID");
  });

  test("rejects malformed rows before a Durable Object can acknowledge them", () => {
    const valid = {
      event_id: "E-outbox-001",
      kind: "search.index",
      dedupe_key: "search.index:E-outbox-001",
      payload_sha256: "a".repeat(64),
    };
    expect(validateOutboxRow(valid)).toBeNull();
    expect(validateOutboxRow({ ...valid, payload_sha256: "malformed" })).toBe(
      "OUTBOX_PAYLOAD_INVALID",
    );
    expect(validateOutboxRow({ ...valid, kind: "other" })).toBe("OUTBOX_KIND_INVALID");
    expect(validateOutboxRow({ ...valid, dedupe_key: "wrong" })).toBe("OUTBOX_DEDUPE_INVALID");
  });

  test("PLANTED: the real search document exists before the delivered-state acknowledgement", async () => {
    const row = outboxRow(1);
    const rows = [row];
    let documentsObservedBeforeAcknowledge: readonly FakeSearchDocument[] | undefined;
    const harness = outboxHarness(rows, {
      beforeAcknowledge: (_storage, searchDocuments) => {
        documentsObservedBeforeAcknowledge = searchDocuments;
      },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(documentsObservedBeforeAcknowledge).toEqual([searchDocumentFor(row)]);
    expect(row.state).toBe("delivered");
    expect(harness.searchDocuments()).toEqual([searchDocumentFor(row)]);
  });

  test("PLANTED: a search effect failure leaves the outbox pending and retries the effect", async () => {
    const row = outboxRow(1);
    const rows = [row];
    const harness = outboxHarness(rows, { searchIndexEffectFailures: 1 });

    const failed = await harness.drainer.fetch(drainRequest());

    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ code: "PLANTED_SEARCH_INDEX_EFFECT_FAILURE" });
    expect(row.state).toBe("pending");
    expect(harness.searchDocuments()).toEqual([]);
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(row.state).toBe("delivered");
    expect(harness.searchDocuments()).toEqual([searchDocumentFor(row)]);
  });

  const invalidSearchSources: readonly (readonly [string, OutboxHarnessOptions])[] = [
    ["missing claim", { missingSourceClaim: true }],
    ["wrong problem", { sourceProblemId: "P-other" }],
    ["workshop event type", { sourceEventType: "workshop.pushed" }],
    ["wrong object version", { sourceObjectVersion: 2 }],
    ["claim/event digest mismatch", { sourceClaimPayloadSha256: "b".repeat(64) }],
    ["event/outbox digest mismatch", { sourcePayloadSha256: "b".repeat(64) }],
    ["statement-only mutation", { sourceStatement: "Mutated after its canonical digest." }],
  ];
  for (const [label, options] of invalidSearchSources) {
    test(`PLANTED: ${label} cannot index or acknowledge search work`, async () => {
      const row = outboxRow(1);
      const rows = [row];
      const harness = outboxHarness(rows, options);

      const failed = await harness.drainer.fetch(drainRequest());

      expect(failed.status).toBe(400);
      expect(await failed.json()).toEqual({ code: "KRATER_OUTBOX_SEARCH_SOURCE_INVALID" });
      expect(row.state).toBe("pending");
      expect(harness.searchDocuments()).toEqual([]);
      expect(harness.alarmAt()).not.toBeNull();
    });
  }

  test("PLANTED: crash-window restart and duplicate delivery keep one canonical document", async () => {
    const row = outboxRow(1);
    const rows = [row];
    const harness = outboxHarness(rows);
    const expected = [searchDocumentFor(row)];

    const held = await harness.drainer.fetch(drainRequest("hold-before-ack"));
    expect(await held.json()).toMatchObject({ delivered: 0, held_before_ack: true });
    expect(row.state).toBe("pending");
    expect(harness.searchDocuments()).toEqual(expected);

    const replayedAfterRestart = await harness.restart().fetch(drainRequest("hold-before-ack"));
    expect(await replayedAfterRestart.json()).toMatchObject({
      delivered: 0,
      held_before_ack: true,
    });
    expect(row.state).toBe("pending");
    expect(harness.searchDocuments()).toEqual(expected);

    const deliveredAfterSecondRestart = await harness.restart().fetch(drainRequest());
    expect(await deliveredAfterSecondRestart.json()).toMatchObject({ delivered: 1 });
    expect(row.state).toBe("delivered");
    expect(harness.searchDocuments()).toEqual(expected);

    await harness.restart().alarm();
    expect(harness.searchDocuments()).toEqual(expected);
  });

  test("the local stale-wrap fixture accepts only a forward bounded cursor interval", async () => {
    const harness = outboxHarness([]);
    const fixtureRequest = (scanAfterId: number, scanWrapThroughId: number) =>
      new Request("https://krater-outbox.internal/__s2/plant-stale-wrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scan_after_id: scanAfterId,
          scan_wrap_through_id: scanWrapThroughId,
        }),
      });

    for (const [scanAfterId, scanWrapThroughId] of [
      [2, 2],
      [2, 1],
      [-1, 2],
    ] as const) {
      const refused = await harness.drainer.fetch(fixtureRequest(scanAfterId, scanWrapThroughId));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ code: "KRATER_OUTBOX_STALE_WRAP_FIXTURE_INVALID" });
    }

    const planted = await harness.drainer.fetch(fixtureRequest(8, 20));
    expect(planted.status).toBe(201);
    expect(await planted.json()).toEqual({ planted: true });
    expect(harness.storageValue("scan_after_id")).toBe(8);
    expect(harness.storageValue("scan_wrap_through_id")).toBe(20);
    expect(harness.storageValue("fault_mode")).toBe("hold-before-ack");
    expect(harness.alarmAt()).toBeNull();
  });

  test("PLANTED: a full quarantined page cannot starve the next valid pending row", async () => {
    const rows = [
      ...Array.from({ length: OUTBOX_DRAIN_BATCH_SIZE }, (_, index) => outboxRow(index + 1, false)),
      outboxRow(OUTBOX_DRAIN_BATCH_SIZE + 1),
    ];
    const harness = outboxHarness(rows);

    const first = await harness.drainer.fetch(drainRequest());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      delivered: 0,
      quarantined: OUTBOX_DRAIN_BATCH_SIZE,
      held_before_ack: false,
    });
    expect(harness.alarmAt()).not.toBeNull();
    expect(
      rows
        .slice(0, OUTBOX_DRAIN_BATCH_SIZE)
        .every((row) => row.state === "pending" && row.quarantined_at !== null),
    ).toBe(true);
    expect(rows.at(-1)?.state).toBe("pending");

    const second = await harness.drainer.fetch(drainRequest());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ delivered: 1, quarantined: 0 });
    expect(rows.at(-1)?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    const status = await harness.drainer.fetch(
      new Request("https://krater-outbox.internal/status", { method: "GET" }),
    );
    expect(await status.json()).toMatchObject({ pending: 0, quarantined: OUTBOX_DRAIN_BATCH_SIZE });
    expect(harness.storageValue("scan_after_id")).toBe(OUTBOX_DRAIN_BATCH_SIZE + 1);
  });

  test("PLANTED: a maxed fail-once retry never advances past its unacknowledged row", async () => {
    const rows = [outboxRow(1, false), outboxRow(2)];
    const harness = outboxHarness(rows, {
      initialStorage: { counters: durableCountersWithFailures(7) },
    });

    const failed = await harness.drainer.fetch(drainRequest("fail-once"));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      delivered: 0,
      retry_scheduled_ms: RETRY_ALARM_CONTRACT_MAX_MS,
    });
    expect(scheduledAlarmDelayMs(harness)).toBeLessThanOrEqual(RETRY_ALARM_CONTRACT_MAX_MS);
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 8,
      last_backoff_ms: RETRY_ALARM_CONTRACT_MAX_MS,
      last_phase: "retry",
    });
    expect(harness.storageValue("scan_after_id")).toBe(1);
    expect(rows[1]?.state).toBe("pending");

    const retried = await harness.drainer.fetch(drainRequest());
    expect(await retried.json()).toMatchObject({ delivered: 1 });
    expect(rows[1]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: delivery retires the per-event attempt tally without weakening retries", async () => {
    const rows = [outboxRow(1)];
    const attemptKey = `attempt:${rows[0]?.event_id}`;
    let attemptObservedByAcknowledge: unknown;
    const harness = outboxHarness(rows, {
      beforeAcknowledge: (storage) => {
        attemptObservedByAcknowledge = storage.get(attemptKey);
      },
    });

    const held = await harness.drainer.fetch(drainRequest("hold-before-ack"));
    expect(held.status).toBe(200);
    expect(await held.json()).toMatchObject({ delivered: 0, held_before_ack: true });
    expect(harness.storageValue(attemptKey)).toBe(1);

    const delivered = await harness.drainer.fetch(drainRequest());
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ delivered: 1 });
    expect(attemptObservedByAcknowledge).toBe(2);
    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue(attemptKey)).toBeUndefined();
    expect(harness.storageValue("counters")).toMatchObject({
      delivery_attempts: 2,
      delivered: 1,
      failures: 0,
    });
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: malformed or saturated live attempt tallies recover to bounded integers", async () => {
    for (const [stored, expected] of [
      ["7", 1],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ] as const) {
      const rows = [outboxRow(1)];
      const attemptKey = `attempt:${rows[0]?.event_id}`;
      const harness = outboxHarness(rows, {
        initialStorage: { [attemptKey]: stored },
      });

      const failed = await harness.drainer.fetch(drainRequest("fail-once"));

      expect(failed.status).toBe(200);
      expect(await failed.json()).toMatchObject({ delivered: 0, retry_scheduled_ms: 25 });
      expect(rows[0]?.state).toBe("pending");
      expect(harness.storageValue(attemptKey)).toBe(expected);
    }
  });

  test("PLANTED: a live pending retry saturates every aggregate diagnostic counter", async () => {
    const saturated = Number.MAX_SAFE_INTEGER;
    const rows = [outboxRow(1)];
    const attemptKey = `attempt:${rows[0]?.event_id}`;
    const harness = outboxHarness(rows, {
      initialStorage: {
        active: 1,
        [attemptKey]: saturated,
        counters: {
          owner_acquisitions: saturated,
          max_active: saturated,
          recovered_ownerships: saturated,
          delivery_attempts: saturated,
          delivered: saturated,
          quarantined: saturated,
          failures: saturated,
          last_backoff_ms: OUTBOX_ALARM_MAX_MS,
          last_quarantine_code: null,
          last_phase: "retry",
        },
        attempt_reclaim_counters: {
          scans: saturated,
          keys_scanned: saturated,
          keys_reclaimed: saturated,
          failures: saturated,
        },
      },
    });

    const failed = await harness.drainer.fetch(drainRequest("fail-once"));

    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ delivered: 0, retry_scheduled_ms: 2_000 });
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue(attemptKey)).toBe(saturated);
    expect(harness.storageValue("counters")).toMatchObject({
      owner_acquisitions: saturated,
      max_active: saturated,
      recovered_ownerships: saturated,
      delivery_attempts: saturated,
      delivered: saturated,
      quarantined: saturated,
      failures: saturated,
    });
    expect(harness.storageValue("attempt_reclaim_counters")).toEqual({
      scans: saturated,
      keys_scanned: saturated,
      keys_reclaimed: saturated,
      failures: saturated,
    });
  });

  test("a stale cursor beyond the restored D1 range wraps before declaring the outbox empty", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, { initialStorage: { scan_after_id: 999 } });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1 });
    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    expect(harness.storageValue("scan_after_id")).toBe(1);
  });

  test("PLANTED: corrupt derived cursor state cannot wedge authoritative D1 work", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: { scan_after_id: "not-an-integer" },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1 });
    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    expect(harness.storageValue("scan_after_id")).toBe(1);
  });

  test("PLANTED: an actual D1 acknowledgement failure re-arms and retries through alarm()", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, { acknowledgeFailures: 1 });

    const failed = await harness.drainer.fetch(drainRequest());

    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ code: "PLANTED_D1_ACKNOWLEDGEMENT_FAILURE" });
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue("scan_after_id") ?? 0).toBe(0);
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 1,
      last_backoff_ms: OUTBOX_ALARM_BASE_MS,
      last_phase: "retry",
    });
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue("counters")).toMatchObject({
      delivered: 1,
      failures: 0,
      last_backoff_ms: null,
      last_phase: "delivered",
    });
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: an alarm ACK failure uses only the durably re-armed bounded retry", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, { acknowledgeFailures: 1 });

    await expect(harness.drainer.alarm()).resolves.toBeUndefined();

    expect(rows[0]?.state).toBe("pending");
    expect(harness.alarmAt()).not.toBeNull();
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 1,
      last_backoff_ms: OUTBOX_ALARM_BASE_MS,
      last_phase: "retry",
    });

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: a zero-change acknowledgement observes a terminal row and retires its tally", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      acknowledgeZeroChanges: 1,
      initialStorage: { counters: durableCountersWithFailures(7) },
    });
    const attemptKey = `attempt:${rows[0]?.event_id}`;

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      delivered: 0,
      retry_scheduled_ms: RETRY_ALARM_CONTRACT_MAX_MS,
    });
    expect(scheduledAlarmDelayMs(harness)).toBeLessThanOrEqual(RETRY_ALARM_CONTRACT_MAX_MS);
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 8,
      last_backoff_ms: RETRY_ALARM_CONTRACT_MAX_MS,
      last_phase: "retry",
    });
    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue(attemptKey)).toBeUndefined();
    expect(harness.storageValue("scan_after_id") ?? 0).toBe(0);
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue(attemptKey)).toBeUndefined();
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: a post-delivery counter failure is followed by bounded D1-backed reclamation", async () => {
    const rows = [outboxRow(1)];
    const attemptKey = `attempt:${rows[0]?.event_id}`;
    const harness = outboxHarness(rows, {
      failStorageOnce: ({ kind, key }) =>
        kind === "put" && key === "counters" && rows[0]?.state === "delivered",
    });

    const failed = await harness.drainer.fetch(drainRequest());

    expect(failed.status).toBe(400);
    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue(attemptKey)).toBe(1);
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(harness.storageValue(attemptKey)).toBeUndefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      keys_reclaimed: 1,
      failures: 0,
    });
    await drainScheduledAlarms(harness);
  });

  // 6js.3: this plant's property is key-independent and worth keeping — a
  // Durable Object storage failure AFTER the authoritative D1 CAS must not undo
  // the quarantine or strand the attempt tally. The injection used to target
  // the per-row `quarantine:<id>` put, which no longer exists. It targets the
  // counters put that still runs inside `quarantine()` after the CAS, and it
  // MUST stay guarded on `quarantined_at`: the drain preamble's
  // owner-acquisition counters write happens before any row is examined, and
  // an unguarded one-shot fault would abort the drain there instead of
  // striking the post-CAS forensic write this property is about.
  test("PLANTED: a post-quarantine forensic failure cannot strand a legacy tally", async () => {
    const rows = [outboxRow(1, false)];
    const attemptKey = `attempt:${rows[0]?.event_id}`;
    const harness = outboxHarness(rows, {
      initialStorage: { [attemptKey]: 3 },
      failStorageOnce: ({ kind, key }) =>
        kind === "put" && key === "counters" && rows[0]?.quarantined_at !== null,
    });

    const failed = await harness.drainer.fetch(drainRequest());

    expect(failed.status).toBe(400);
    expect(rows[0]?.quarantined_at).not.toBeNull();
    expect(harness.storageValue(attemptKey)).toBe(3);
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(harness.storageValue(attemptKey)).toBeUndefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      keys_reclaimed: 1,
    });
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: D1 attempt-snapshot failure deletes no tally and re-arms reclamation", async () => {
    const terminal = outboxRow(1);
    terminal.state = "delivered";
    terminal.delivered_at = new Date().toISOString();
    const attemptKey = `attempt:${terminal.event_id}`;
    const harness = outboxHarness([terminal], {
      initialStorage: { [attemptKey]: 3 },
      failAttemptSnapshotOnce: true,
    });

    const refusedSweep = await harness.drainer.fetch(drainRequest());

    expect(refusedSweep.status).toBe(200);
    expect(harness.storageValue(attemptKey)).toBe(3);
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      failures: 1,
      keys_reclaimed: 0,
    });
    expect(harness.alarmAt()).not.toBeNull();
    expect(scheduledAlarmDelayMs(harness)).toBeLessThanOrEqual(RETRY_ALARM_CONTRACT_MAX_MS);

    await harness.drainer.alarm();

    expect(harness.storageValue(attemptKey)).toBeUndefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      failures: 1,
      keys_reclaimed: 1,
    });
  });

  test("PLANTED: a storage-list failure preserves legacy progress before bounded re-arm", async () => {
    const terminal = outboxRow(1);
    terminal.state = "delivered";
    terminal.delivered_at = new Date().toISOString();
    const attemptKey = `attempt:${terminal.event_id}`;
    const reclaimCursor = "attempt:E-outbox-0";
    const reclaimCounters = {
      scans: 7,
      keys_scanned: 11,
      keys_reclaimed: 5,
      failures: 3,
    };
    const harness = outboxHarness([terminal], {
      initialStorage: {
        [attemptKey]: 3,
        attempt_reclaim_after: reclaimCursor,
        attempt_reclaim_counters: reclaimCounters,
        scan_after_id: 0,
      },
      failStorageOnce: ({ kind, key }) => kind === "list" && key === "attempt:",
    });

    const refusedSweep = await harness.drainer.fetch(drainRequest());

    expect(refusedSweep.status).toBe(200);
    expect(await refusedSweep.json()).toMatchObject({ delivered: 0, quarantined: 0 });
    expect(terminal.state).toBe("delivered");
    expect(harness.storageValue(attemptKey)).toBe(3);
    expect(harness.storageValue("attempt_reclaim_after")).toBe(reclaimCursor);
    expect(harness.storageValue("scan_after_id")).toBe(0);
    // Only the truthful failure diagnostic changes; no successful scan,
    // reclamation, or cursor advancement is allowed after list() rejects.
    expect(harness.storageValue("attempt_reclaim_counters")).toEqual({
      ...reclaimCounters,
      failures: reclaimCounters.failures + 1,
    });
    expect(scheduledAlarmDelayMs(harness)).toBeLessThanOrEqual(RETRY_ALARM_CONTRACT_MAX_MS);
  });

  test("PLANTED: D1 authority preserves a pending tally while reclaiming a terminal peer", async () => {
    const pending = outboxRow(1);
    const terminal = outboxRow(2);
    terminal.state = "delivered";
    terminal.delivered_at = new Date().toISOString();
    const pendingKey = `attempt:${pending.event_id}`;
    const terminalKey = `attempt:${terminal.event_id}`;
    const harness = outboxHarness([pending, terminal], {
      initialStorage: { [pendingKey]: 4, [terminalKey]: 4 },
    });

    const held = await harness.drainer.fetch(drainRequest("hold-before-ack"));

    expect(held.status).toBe(200);
    expect(await held.json()).toMatchObject({ held_before_ack: true });
    expect(harness.storageValue(pendingKey)).toBe(5);
    expect(harness.storageValue(terminalKey)).toBeUndefined();
    expect(pending.state).toBe("pending");
  });

  test("PLANTED: a malformed attempt reclamation cursor resets before the D1-backed sweep", async () => {
    const terminal = outboxRow(1);
    terminal.state = "delivered";
    terminal.delivered_at = new Date().toISOString();
    const attemptKey = `attempt:${terminal.event_id}`;
    const harness = outboxHarness([terminal], {
      initialStorage: {
        [attemptKey]: 4,
        // This retains the prefix and sorts after every attempt key, but its
        // control-character suffix is not an event id. Treating it as a live
        // cursor would skip the terminal tally instead of recovering from the
        // prefix start.
        attempt_reclaim_after: "attempt:zzzz\u0000",
      },
    });

    const recovered = await harness.drainer.fetch(drainRequest());

    expect(recovered.status).toBe(200);
    expect(harness.storageValue("attempt_reclaim_after")).toBeUndefined();
    expect(harness.storageValue(attemptKey)).toBeUndefined();
  });

  test("PLANTED: a full retained attempt page advances past live keys to a terminal tail", async () => {
    const rows = Array.from({ length: OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE + 1 }, (_, index) =>
      outboxRow(index + 1),
    );
    const liveRows = rows.slice(0, OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE);
    const terminal = rows.at(-1);
    if (terminal === undefined) throw new Error("PLANTED_TERMINAL_TAIL_MISSING");
    terminal.state = "delivered";
    terminal.delivered_at = new Date().toISOString();
    const terminalKey = `attempt:${terminal.event_id}`;
    const initialStorage = Object.fromEntries(rows.map((row) => [`attempt:${row.event_id}`, 4]));
    const harness = outboxHarness(rows, { initialStorage });

    const first = await harness.drainer.fetch(drainRequest("hold-before-ack"));

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ held_before_ack: true });
    expect(harness.storageValue(terminalKey)).toBe(4);
    expect(harness.storageValue("attempt_reclaim_after")).toBe(
      `attempt:${liveRows.at(-1)?.event_id}`,
    );
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      scans: 1,
      keys_scanned: OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE,
      keys_reclaimed: 0,
    });

    await harness.restart().alarm();

    expect(harness.storageValue("attempt_reclaim_after")).toBeUndefined();
    expect(harness.storageValue(terminalKey)).toBeUndefined();
  });

  test("PLANTED: legacy reclamation is bounded, restart-safe, and D1-cross-checked", async () => {
    const rows = Array.from({ length: OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE * 2 + 1 }, (_, index) =>
      outboxRow(index + 1),
    );
    for (const row of rows) {
      row.state = "delivered";
      row.delivered_at = new Date().toISOString();
    }
    const initialStorage = Object.fromEntries(rows.map((row) => [`attempt:${row.event_id}`, 4]));
    const harness = outboxHarness(rows, { initialStorage });

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(harness.storageKeys().filter((key) => key.startsWith("attempt:")).length).toBe(
      rows.length - OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE,
    );
    expect(harness.storageValue("attempt_reclaim_after")).toBeDefined();
    expect(harness.alarmAt()).not.toBeNull();

    // Reconstruct the DO before resuming: progress is owned entirely by
    // durable cursor/counter state rather than this instance's memory.
    await harness.restart().alarm();
    await drainScheduledAlarms(harness);

    expect(harness.storageKeys().filter((key) => key.startsWith("attempt:"))).toEqual([]);
    expect(harness.storageValue("attempt_reclaim_after")).toBeUndefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      scans: 3,
      keys_scanned: rows.length,
      keys_reclaimed: rows.length,
      failures: 0,
    });
    const status = await harness.drainer.fetch(
      new Request("https://krater-outbox.internal/status", { method: "GET" }),
    );
    expect(await status.json()).toMatchObject({
      attempt_reclamation: {
        scans: 3,
        keys_scanned: rows.length,
        keys_reclaimed: rows.length,
        failures: 0,
      },
    });
  });

  test("PLANTED: a permanent attempt-key delete failure cannot starve later keys", async () => {
    const rows: FakeOutboxRow[] = [];
    const seeded = OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE * 2 + 1;
    const keys = Array.from({ length: seeded }, (_, index) => `attempt:E-outbox-${index + 1}`);
    const poisonKey = keys[0];
    if (poisonKey === undefined) throw new Error("PLANTED_ATTEMPT_POISON_KEY_MISSING");
    const harness = outboxHarness(rows, {
      initialStorage: Object.fromEntries(keys.map((key) => [key, 4])),
      failStorageAlways: ({ kind, key }) => kind === "delete" && key === poisonKey,
    });
    const retained = () => keys.filter((key) => harness.storageValue(key) !== undefined);

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(retained()).toHaveLength(seeded - OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE + 1);
    expect(harness.storageValue("attempt_reclaim_after")).toBeDefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      failures: 1,
      keys_reclaimed: OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE - 1,
    });

    await harness.drainer.alarm();

    // The full second page advances past the poison key rather than retrying
    // it immediately, and still reclaims every terminal peer after the cursor.
    expect(retained()).toHaveLength(2);
    expect(harness.storageValue("attempt_reclaim_after")).toBeDefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({ failures: 1 });

    await harness.drainer.alarm();

    // The short tail clears the cursor. The next retry of the poison waits for
    // the bounded idle wrap instead of holding the active retry cadence hot.
    expect(retained()).toEqual([poisonKey]);
    expect(harness.storageValue("attempt_reclaim_after")).toBeUndefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({ failures: 1 });
    expect((harness.alarmAt() ?? 0) - Date.now()).toBeGreaterThan(OUTBOX_IDLE_RECONCILE_MS - 1_000);

    const authoritative = outboxRow(100);
    rows.push(authoritative);
    await harness.drainer.alarm();

    expect(authoritative.state).toBe("delivered");
    expect(retained()).toEqual([poisonKey]);
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({ failures: 2 });
    const status = await harness.drainer.fetch(
      new Request("https://krater-outbox.internal/status", { method: "GET" }),
    );
    expect(await status.json()).toMatchObject({
      attempt_reclamation: {
        failures: 2,
        keys_reclaimed: seeded - 1,
      },
    });
  });

  test("PLANTED: a short lexical tail keeps an idle alarm to wrap below the reclaim cursor", async () => {
    const terminal = outboxRow(1);
    terminal.state = "delivered";
    terminal.delivered_at = new Date().toISOString();
    const attemptKey = `attempt:${terminal.event_id}`;
    const harness = outboxHarness([terminal], {
      initialStorage: {
        [attemptKey]: 2,
        attempt_reclaim_after: "attempt:E-outbox-9",
      },
    });

    const tail = await harness.drainer.fetch(drainRequest());

    expect(tail.status).toBe(200);
    expect(harness.storageValue(attemptKey)).toBe(2);
    expect(harness.storageValue("attempt_reclaim_after")).toBeUndefined();
    expect(harness.alarmAt()).not.toBeNull();
    expect((harness.alarmAt() ?? 0) - Date.now()).toBeGreaterThan(OUTBOX_IDLE_RECONCILE_MS - 1_000);

    await harness.drainer.alarm();

    expect(harness.storageValue(attemptKey)).toBeUndefined();
    expect(harness.storageValue("attempt_reclaim_counters")).toMatchObject({
      scans: 2,
      keys_scanned: 1,
      keys_reclaimed: 1,
    });
    expect(harness.alarmAt()).not.toBeNull();
  });

  test("PLANTED: enqueue after the terminal D1 observation retains an idle recovery alarm", async () => {
    const rows: FakeOutboxRow[] = [];
    const harness = outboxHarness(rows, {
      afterPendingPage: (page, liveRows) => {
        if (page === 2) liveRows.push(outboxRow(1));
      },
    });

    const emptySnapshot = await harness.drainer.fetch(drainRequest());

    expect(emptySnapshot.status).toBe(200);
    expect(await emptySnapshot.json()).toMatchObject({ delivered: 0, quarantined: 0 });
    expect(rows[0]?.state).toBe("pending");
    expect(harness.alarmAt()).not.toBeNull();
    expect((harness.alarmAt() ?? 0) - Date.now()).toBeGreaterThan(OUTBOX_IDLE_RECONCILE_MS - 1_000);

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    expect(harness.alarmAt()).not.toBeNull();
  });

  test("PLANTED: a concurrent nudge cannot be overwritten by terminal idle re-arming", async () => {
    let markTerminalObserved: (() => void) | undefined;
    const terminalObserved = new Promise<void>((resolve) => {
      markTerminalObserved = resolve;
    });
    let releaseTerminalRead: (() => void) | undefined;
    const terminalReadReleased = new Promise<void>((resolve) => {
      releaseTerminalRead = resolve;
    });
    const harness = outboxHarness([], {
      afterPendingPage: async (page) => {
        if (page !== 2) return;
        markTerminalObserved?.();
        await terminalReadReleased;
      },
    });

    const draining = harness.deliver(drainRequest());
    await terminalObserved;

    let nudgeSettled = false;
    const nudging = harness.deliver(nudgeRequest()).then((response) => {
      nudgeSettled = true;
      return response;
    });
    await Promise.resolve();
    expect(nudgeSettled).toBe(false);

    if (releaseTerminalRead === undefined) throw new Error("terminal read release was not armed");
    releaseTerminalRead();
    expect((await draining).status).toBe(200);

    expect((await nudging).status).toBe(202);
    expect((harness.alarmAt() ?? Number.POSITIVE_INFINITY) - Date.now()).toBeLessThanOrEqual(
      OUTBOX_ALARM_BASE_MS,
    );
  });

  test("PLANTED: quarantine records forensics before retiring a stale attempt tally", async () => {
    const rows = [outboxRow(1, false)];
    const attemptKey = `attempt:${rows[0]?.event_id}`;
    const harness = outboxHarness(rows, {
      initialStorage: { [attemptKey]: 3 },
      // The canary lives only in the reconstructed ledger source. If any
      // quarantine-path byte ever echoed claim payload material into the
      // drain response, the counters record, or retained DO state, the
      // no-reflection assertions below red.
      sourceStatement: "SECRET-CANARY-quarantine-must-not-echo-payload",
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    const responseBody = (await response.json()) as Record<string, unknown>;
    expect(responseBody).toMatchObject({ delivered: 0, quarantined: 1 });
    // 6js.3: quarantining writes NO per-row Durable Object key. D1 already
    // holds the identifiers, digest, code and timestamp, so a DO copy was
    // duplicate state that grew without bound. This is the assertion that reds
    // if the write is reintroduced.
    expect(harness.storageValue("quarantine:1")).toBeUndefined();
    expect(rows[0]?.quarantined_at).not.toBeNull();
    expect(rows[0]?.quarantine_code).toBe("OUTBOX_KIND_INVALID");
    expect(harness.storageValue("counters")).toMatchObject({
      quarantined: 1,
      last_phase: "quarantined",
    });
    expect(harness.storageValue(attemptKey)).toBeUndefined();
    // 6js.3 no-reflection property: the quarantine path reads identifier,
    // digest, and code fields but echoes none of them — nor any ledger payload
    // material — through the drain response, the counters record, or retained
    // Durable Object state.
    const reflected = JSON.stringify([
      responseBody,
      harness.storageValue("counters"),
      harness.storageValue(attemptKey),
      harness.storageValue("quarantine:1"),
    ]);
    expect(reflected).not.toContain("SECRET-CANARY");
    expect(reflected).not.toContain((rows[0]?.payload_sha256 ?? "").slice(0, 24));
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: stale quarantine state cannot suppress a different restored row", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: {
        "quarantine:1": JSON.stringify([
          rows[0]?.event_id,
          "malformed",
          rows[0]?.dedupe_key,
          rows[0]?.payload_sha256,
        ]),
      },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1, quarantined: 0 });
    expect(rows[0]?.state).toBe("delivered");
    // 6js.3: the same drain reclaims the legacy key. Delivery is unaffected by
    // the housekeeping, and the redundant forensic copy does not survive it.
    expect(harness.storageValue("quarantine:1")).toBeUndefined();
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: legacy quarantine keys reclaim in bounded pages and then stop", async () => {
    // One more than a page, so the first sweep must fill a page, persist a
    // cursor and re-arm, and the second must take the remainder and clear it.
    const legacy: Record<string, string> = {};
    const seeded = OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE + 1;
    for (let id = 1; id <= seeded; id += 1) {
      legacy[`quarantine:${id}`] = JSON.stringify(["E-legacy", "search.index", "d", "h", "code"]);
    }
    const harness = outboxHarness([outboxRow(1)], { initialStorage: { ...legacy } });

    const first = await harness.drainer.fetch(drainRequest());
    expect(first.status).toBe(200);
    const remaining = () =>
      Object.keys(legacy).filter((key) => harness.storageValue(key) !== undefined);
    // Exactly one page gone, and a cursor left behind pointing into the prefix.
    expect(remaining()).toHaveLength(seeded - OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE);
    expect(harness.storageValue("quarantine_reclaim_after")).toBeDefined();

    await harness.drainer.alarm();

    expect(remaining()).toHaveLength(0);
    // A short page ends the interval, so the cursor is cleared rather than left
    // pointing at a deleted key.
    expect(harness.storageValue("quarantine_reclaim_after")).toBeUndefined();
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: a permanent quarantine-key delete failure cannot starve later keys", async () => {
    const rows: FakeOutboxRow[] = [];
    const seeded = OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE * 2 + 1;
    const keys = Array.from({ length: seeded }, (_, index) => `quarantine:${index + 1}`);
    const poisonKey = keys[0];
    if (poisonKey === undefined) throw new Error("PLANTED_QUARANTINE_POISON_KEY_MISSING");
    const harness = outboxHarness(rows, {
      initialStorage: Object.fromEntries(keys.map((key) => [key, "legacy forensic copy"])),
      failStorageAlways: ({ kind, key }) => kind === "delete" && key === poisonKey,
    });
    const retained = () => keys.filter((key) => harness.storageValue(key) !== undefined);

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(retained()).toHaveLength(seeded - OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE + 1);
    expect(harness.storageValue("quarantine_reclaim_after")).toBeDefined();
    expect(harness.storageValue("quarantine_reclaim_counters")).toMatchObject({
      failures: 1,
      keys_reclaimed: OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE - 1,
    });

    await harness.drainer.alarm();

    expect(retained()).toHaveLength(2);
    expect(harness.storageValue("quarantine_reclaim_after")).toBeDefined();
    expect(harness.storageValue("quarantine_reclaim_counters")).toMatchObject({ failures: 1 });

    await harness.drainer.alarm();

    expect(retained()).toEqual([poisonKey]);
    expect(harness.storageValue("quarantine_reclaim_after")).toBeUndefined();
    expect(harness.storageValue("quarantine_reclaim_counters")).toMatchObject({ failures: 1 });
    expect((harness.alarmAt() ?? 0) - Date.now()).toBeGreaterThan(OUTBOX_IDLE_RECONCILE_MS - 1_000);

    const authoritative = outboxRow(100, false);
    rows.push(authoritative);
    await harness.drainer.alarm();

    expect(authoritative.quarantined_at).not.toBeNull();
    expect(authoritative.quarantine_code).toBe("OUTBOX_KIND_INVALID");
    expect(harness.storageValue("quarantine:100")).toBeUndefined();
    expect(retained()).toEqual([poisonKey]);
    expect(harness.storageValue("quarantine_reclaim_counters")).toMatchObject({ failures: 2 });
    const status = await harness.drainer.fetch(
      new Request("https://krater-outbox.internal/status", { method: "GET" }),
    );
    expect(await status.json()).toMatchObject({
      quarantine_reclamation: {
        failures: 2,
        keys_reclaimed: seeded - 1,
      },
    });
  });

  test("PLANTED: a corrupt quarantine cursor is discarded, not trusted", async () => {
    // The attempt sweep validates its cursor against an EVENT id; this one must
    // validate against a ROW id. A cursor that survives the wrong validator
    // would pin the sweep to one interval forever, so a non-numeric suffix has
    // to be dropped and the sweep restarted from the prefix start.
    const harness = outboxHarness([outboxRow(1)], {
      initialStorage: {
        "quarantine:1": JSON.stringify(["E-legacy", "search.index", "d", "h", "code"]),
        quarantine_reclaim_after: "quarantine:not-a-row-id",
      },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(harness.storageValue("quarantine:1")).toBeUndefined();
    expect(harness.storageValue("quarantine_reclaim_after")).toBeUndefined();
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: corrupt diagnostic counters cannot disable failure re-arming", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      acknowledgeFailures: 1,
      initialStorage: { counters: { failures: "not-a-number" } },
    });

    const failed = await harness.drainer.fetch(drainRequest());

    expect(failed.status).toBe(400);
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 1,
      last_backoff_ms: OUTBOX_ALARM_BASE_MS,
      last_phase: "retry",
    });
    expect(harness.alarmAt()).not.toBeNull();
  });

  test("PLANTED: a mixed restore range wraps before clearing the only alarm", async () => {
    const rows = [outboxRow(1), outboxRow(101)];
    const harness = outboxHarness(rows, {
      initialStorage: { scan_after_id: 100 },
    });

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(rows[0]?.state).toBe("pending");
    expect(rows[1]?.state).toBe("delivered");
    expect(harness.alarmAt()).not.toBeNull();

    await drainScheduledAlarms(harness);

    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue("scan_after_id")).toBe(101);
  });

  test("PLANTED: an equal wrap checkpoint left by a crash cannot strand lower rows", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: {
        scan_after_id: 101,
        scan_wrap_through_id: 101,
      },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1 });
    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    expect(harness.storageValue("scan_after_id")).toBe(1);
    expect(harness.storageValue("scan_wrap_through_id")).toBeUndefined();
  });

  test("PLANTED: a completed stale wrap cannot clear the only alarm above restored D1 work", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: {
        scan_after_id: 8,
        scan_wrap_through_id: 20,
      },
    });

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ delivered: 0, quarantined: 0 });
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue("scan_after_id")).toBe(0);
    expect(harness.storageValue("scan_wrap_through_id")).toBeUndefined();
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
  });
});

test("the status face exposes the oldest-pending lag metric (W2.5)", async () => {
  // A row created 5s ago and a fresh one: the lag is the OLDEST pending age.
  const old = outboxRow(1, true, new Date(Date.now() - 5000).toISOString());
  const fresh = outboxRow(2, true, new Date().toISOString());
  const harness = outboxHarness([old, fresh]);
  const status = await harness.drainer.fetch(
    new Request("https://krater-outbox.internal/status", { method: "GET" }),
  );
  expect(status.status).toBe(200);
  const body = (await status.json()) as {
    pending: number;
    oldest_pending_age_ms: number | null;
    oldest_pending_age_status: string;
    oldest_pending_age_alert: string;
  };
  expect(body.pending).toBe(2);
  // The lag reflects the 5s-old row, not the fresh one (within timing slack).
  expect(body.oldest_pending_age_ms).toBeGreaterThanOrEqual(4000);
  expect(body.oldest_pending_age_status).toBe("measured");
  expect(body.oldest_pending_age_alert).toBe("below-threshold");
  expect(harness.statusSnapshotQueries()).toBe(1);
});

test("an empty queue reports zero lag without raising the local threshold alert", async () => {
  const harness = outboxHarness([]);
  const status = await harness.drainer.fetch(
    new Request("https://krater-outbox.internal/status", { method: "GET" }),
  );
  const body = (await status.json()) as {
    pending: number;
    oldest_pending_age_ms: number | null;
    oldest_pending_age_status: string;
    oldest_pending_age_alert: string;
  };
  expect(body.pending).toBe(0);
  expect(body.oldest_pending_age_ms).toBe(0);
  expect(body.oldest_pending_age_status).toBe("empty");
  expect(body.oldest_pending_age_alert).toBe("not-pending");
});

test("PLANTED: count and oldest age come from one immutable status snapshot", async () => {
  const rows = [outboxRow(1, true, new Date(Date.now() - 10_000).toISOString())];
  const harness = outboxHarness(rows, {
    afterStatusSnapshot: () => {
      rows.push(outboxRow(2, true, new Date(Date.now() - 20_000).toISOString()));
    },
  });

  const status = await harness.drainer.fetch(
    new Request("https://krater-outbox.internal/status", { method: "GET" }),
  );
  const body = (await status.json()) as {
    pending: number;
    oldest_pending_age_ms: number | null;
    oldest_pending_age_status: string;
  };

  expect(body.pending).toBe(1);
  expect(body.oldest_pending_age_ms).toBeGreaterThanOrEqual(9000);
  expect(body.oldest_pending_age_status).toBe("measured");
  expect(rows).toHaveLength(2);
  expect(harness.statusSnapshotQueries()).toBe(1);
});

test("PLANTED: noncanonical, malformed, and future storage degrades instead of reporting zero lag", async () => {
  const cases = [
    {
      createdAt: "2026-08-19T00:00:00+05:00",
      status: "degraded-invalid-timestamp",
    },
    {
      createdAt: "2026-08-19",
      status: "degraded-invalid-timestamp",
    },
    {
      createdAt: "2026-02-30T00:00:00.000Z",
      status: "degraded-invalid-timestamp",
    },
    {
      createdAt: "2099-01-01T00:00:00.000Z",
      status: "degraded-future-timestamp",
    },
  ] as const;

  for (const fixture of cases) {
    const harness = outboxHarness([outboxRow(1, true, fixture.createdAt)]);
    const response = await harness.drainer.fetch(
      new Request("https://krater-outbox.internal/status", { method: "GET" }),
    );
    const body = (await response.json()) as {
      pending: number;
      oldest_pending_age_ms: number | null;
      oldest_pending_age_status: string;
      oldest_pending_age_alert: string;
    };
    expect(body.pending).toBe(1);
    expect(body.oldest_pending_age_ms).toBeNull();
    expect(body.oldest_pending_age_status).toBe(fixture.status);
    expect(body.oldest_pending_age_alert).toBe("degraded");
  }
});

test("PLANTED: production SQLite snapshot excludes malformed lexical minima and BLOB-only minima", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(`CREATE TABLE outbox (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      quarantined_at TEXT,
      created_at TEXT NOT NULL
    )`);
    const insert = sqlite.prepare(
      "INSERT INTO outbox (id, state, quarantined_at, created_at) VALUES (?, 'pending', NULL, ?)",
    );
    insert.run(1, "2026-08-19T00:00:00.000Z");
    // This is 00:30Z, but its earlier local calendar date would win a raw lexical MIN.
    insert.run(2, "2026-08-18T23:30:00.000-01:00");
    insert.run(3, "2026-02-30T00:00:00.000Z");
    const insertBlob = sqlite.prepare(
      "INSERT INTO outbox (id, state, quarantined_at, created_at) VALUES (?, 'pending', NULL, CAST(? AS BLOB))",
    );
    insertBlob.run(4, "2026-01-01T00:00:00.000Z");
    insert.run(5, "2026-08-21T00:00:00.000Z");

    const now = "2026-08-20T00:00:00.000Z";
    const snapshot = sqlite
      .prepare<
        {
          count: number;
          oldest: string | null;
          invalid_timestamp_count: number;
          future_timestamp_count: number;
        },
        [string]
      >(OUTBOX_PENDING_SNAPSHOT_SQL)
      .get(now);

    expect(snapshot).toEqual({
      count: 5,
      oldest: "2026-08-19T00:00:00.000Z",
      invalid_timestamp_count: 3,
      future_timestamp_count: 1,
    });
    if (snapshot === null) throw new Error("PLANTED_SQLITE_SNAPSHOT_MISSING");
    expect(oldestPendingAge(snapshot, Date.parse(now))).toEqual({
      ageMs: null,
      status: "degraded-invalid-timestamp",
    });

    sqlite.exec("DELETE FROM outbox");
    insertBlob.run(1, "2026-01-01T00:00:00.000Z");
    const blobOnlySnapshot = sqlite
      .prepare<
        {
          count: number;
          oldest: string | null;
          invalid_timestamp_count: number;
          future_timestamp_count: number;
        },
        [string]
      >(OUTBOX_PENDING_SNAPSHOT_SQL)
      .get(now);
    expect(blobOnlySnapshot).toEqual({
      count: 1,
      oldest: null,
      invalid_timestamp_count: 1,
      future_timestamp_count: 0,
    });
    if (blobOnlySnapshot === null) throw new Error("PLANTED_SQLITE_BLOB_SNAPSHOT_MISSING");
    expect(oldestPendingAge(blobOnlySnapshot, Date.parse(now))).toEqual({
      ageMs: null,
      status: "degraded-invalid-timestamp",
    });
  } finally {
    sqlite.close();
  }
});

test("the declared local oldest-age threshold has below, at, and above polarity", () => {
  expect(oldestPendingAgeAlert(OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS - 1, "measured")).toBe(
    "below-threshold",
  );
  expect(oldestPendingAgeAlert(OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS, "measured")).toBe(
    "at-or-above-threshold",
  );
  expect(oldestPendingAgeAlert(OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS + 1, "measured")).toBe(
    "at-or-above-threshold",
  );
  expect(oldestPendingAgeAlert(null, "degraded-invalid-timestamp")).toBe("degraded");
});
