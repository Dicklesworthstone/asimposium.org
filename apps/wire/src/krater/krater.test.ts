import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  backfillKraterIntegrity,
  type ClaimProjection,
  canonicalJson,
  checkpointDigest,
  cursorMatchesEvents,
  deterministicWorkload,
  ensureProblem,
  eventChainDigest,
  eventChainMatches,
  eventEnvelopeRowDigest,
  eventRowDigest,
  genesisChainDigest,
  type KraterEvent,
  type KraterOutboxRecord,
  KraterReplayError,
  KraterValidationError,
  outboxMatchesEvents,
  projectionReplayMatches,
  replayClaimProjections,
  serverAuthoredOutboxTimestamp,
  sha256Hex,
  transactionBoundaryMatches,
  UNDIGESTED_EVENT_INDEX,
  UNDIGESTED_EVENT_PROBE_SQL,
  validateFtsReadInput,
  validateKraterIngressTimestamp,
  writeClaim,
} from "./krater";

function event(
  problemId: string,
  seq: number,
  payloadSha256: string,
  rowDigest = `${seq}`.repeat(64).slice(0, 64),
  chainDigest = `${seq + 4}`.repeat(64).slice(0, 64),
): KraterEvent {
  return {
    eventId: `E-${problemId}-${seq}`,
    problemId,
    seq,
    type: "claim.created",
    objectKind: "claim",
    objectId: `C-${problemId}-${seq}`,
    objectVersion: 1,
    payloadSha256,
    rowDigest,
    chainDigest,
    chainVersion: 2,
    createdAt: "2026-08-14T00:00:00.000Z",
    actorFellowId: null,
    actorSponsorId: null,
    actorSessionId: null,
    modelStringSelfDeclared: null,
    harness: null,
    writerCredentialId: null,
  };
}

async function canonicalEventRow(eventValue: KraterEvent): Promise<string> {
  return eventEnvelopeRowDigest({
    eventId: eventValue.eventId,
    problemId: eventValue.problemId,
    seq: eventValue.seq,
    type: eventValue.type,
    objectKind: eventValue.objectKind,
    objectId: eventValue.objectId,
    objectVersion: eventValue.objectVersion,
    payloadSha256: eventValue.payloadSha256,
    createdAt: eventValue.createdAt,
    actorFellowId: eventValue.actorFellowId,
    actorSponsorId: eventValue.actorSponsorId,
    actorSessionId: eventValue.actorSessionId,
    modelStringSelfDeclared: eventValue.modelStringSelfDeclared,
    harness: eventValue.harness,
    writerCredentialId: eventValue.writerCredentialId,
  });
}

interface ObservedD1Statement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

function fakeD1Result<T>(results: readonly T[] = []): {
  readonly success: true;
  readonly results: readonly T[];
  readonly meta: { readonly rows_read: number; readonly rows_written: number };
} {
  return {
    success: true,
    results,
    meta: { rows_read: 0, rows_written: 0 },
  };
}

const PROJECTION_READ_SQL =
  "SELECT claim_id, problem_id, source_seq, projection_version, build_digest, stale FROM claim_projections WHERE claim_id = ? AND problem_id = ? AND source_seq = ?";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const EVENT_READ_SQL = normalizeSql(`SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind,
  e.object_id, e.object_version, e.payload_sha256, c.row_digest, c.chain_digest,
  c.chain_version, e.created_at, e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
  e.model_string_self_declared, e.harness, e.writer_credential_id FROM events e
  LEFT JOIN event_chain_v2 c ON c.event_id = e.id WHERE e.id = ?`);
const CLAIM_READ_SQL = normalizeSql(`SELECT id, problem_id, statement, payload_sha256, source_seq
  FROM claims WHERE id = ? AND problem_id = ? AND source_seq = ?`);
const OUTBOX_READ_SQL = normalizeSql(`SELECT event_id, problem_id, kind, dedupe_key,
  payload_sha256, state FROM outbox
  WHERE event_id = ? AND problem_id = ? AND kind = 'search.index'`);
const CLAIM_INSERT_SELECT_SQL = normalizeSql(`INSERT INTO claims
  (id, problem_id, statement, payload_sha256, norm_hash, source_seq, created_at)
  SELECT ?, p.id, ?, ?, ?, p.public_seq, ? FROM problems p
  JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
  WHERE p.id = ? AND i.event_id IS NULL`);
const EVENT_INSERT_SELECT_SQL = normalizeSql(`INSERT INTO events
  (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
  row_digest, chain_digest, created_at,
  actor_fellow_id, actor_sponsor_id, actor_session_id,
  model_string_self_declared, harness, writer_credential_id)
  SELECT ?, p.id, p.public_seq, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ? FROM problems p
  JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
  WHERE p.id = ? AND i.event_id IS NULL`);
const OUTBOX_INSERT_SELECT_SQL = normalizeSql(`INSERT INTO outbox
  (event_id, problem_id, kind, dedupe_key, payload_sha256, created_at)
  SELECT ?, ?, 'search.index', ?, ?, ? FROM idempotency i
  WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.event_id IS NULL`);

function ensureProblemHarness(): {
  readonly db: Parameters<typeof ensureProblem>[0];
  readonly inserts: readonly (readonly unknown[])[];
  readonly batches: readonly (readonly ObservedD1Statement[])[];
} {
  const inserts: (readonly unknown[])[] = [];
  const batches: (readonly ObservedD1Statement[])[] = [];
  const prepared = (sql: string) => {
    let bindings: readonly unknown[] = [];
    const statement = {
      sql,
      get bindings(): readonly unknown[] {
        return bindings;
      },
      bind: (...next: unknown[]) => {
        bindings = next;
        return statement;
      },
      all: async () => {
        if (sql.includes("SELECT public_seq, chain_digest, chain_version FROM problems")) {
          return fakeD1Result([{ public_seq: 0, chain_digest: null, chain_version: null }]);
        }
        if (sql.includes("FROM krater_integrity_backfill")) return fakeD1Result();
        if (sql.includes("FROM events e") && sql.includes("WHERE e.problem_id")) {
          return fakeD1Result();
        }
        throw new Error(`unexpected ensureProblem all query: ${sql}`);
      },
      first: async () => null,
      run: async () => {
        if (!sql.includes("INSERT INTO problems")) {
          throw new Error(`unexpected ensureProblem run query: ${sql}`);
        }
        inserts.push(bindings);
        return fakeD1Result();
      },
    };
    return statement;
  };
  const db = {
    prepare: prepared,
    batch: async (statements: readonly unknown[]) => {
      const observed = statements as readonly ObservedD1Statement[];
      batches.push(observed);
      return observed.map(() => fakeD1Result());
    },
  } as unknown as Parameters<typeof ensureProblem>[0];
  return { db, inserts, batches };
}

function retryingWriteHarness(
  options: {
    readonly forceProjectionPredicateMiss?: boolean;
    readonly forceProjectionReadSequenceBindingMiss?: boolean;
    readonly forceClaimPredicateMiss?: boolean;
    readonly forceOutboxPredicateMiss?: boolean;
    readonly failOnSynchronousFts?: boolean;
  } = {},
): {
  readonly db: Parameters<typeof writeClaim>[0];
  readonly armConflict: () => void;
  readonly companionPhaseWrites: () => Readonly<{ pending: number; settled: number }>;
  readonly persistedOutboxCreatedAt: () => string | null;
  readonly synchronousFtsStatements: () => number;
  readonly persistedWrite: () =>
    | Readonly<{
        event: KraterEvent;
        projection: ClaimProjection;
        outbox: KraterOutboxRecord;
      }>
    | undefined;
} {
  let publicSeq = 0;
  let chainDigest = "a".repeat(64);
  let conflictArmed = false;
  let outboxCreatedAt: string | null = null;
  let companionPhaseWrites = { pending: 0, settled: 0 };
  let synchronousFtsStatements = 0;
  let idempotency: {
    request_digest: string;
    event_id: string | null;
    event_seq: number | null;
  } | null = null;
  let persistedEvent: Record<string, unknown> | null = null;
  let persistedClaim: Record<string, unknown> | null = null;
  let persistedProjection: Record<string, unknown> | null = null;
  let persistedCheckpoint: Record<string, unknown> | null = null;
  let persistedOutbox: Record<string, unknown> | null = null;
  let claimObserved = false;
  let observedEvent: KraterEvent | undefined;
  let observedProjection: ClaimProjection | undefined;
  let observedOutbox: KraterOutboxRecord | undefined;

  const prepared = (sql: string) => {
    let bindings: readonly unknown[] = [];
    const statement = {
      sql,
      get bindings(): readonly unknown[] {
        return bindings;
      },
      bind: (...next: unknown[]) => {
        bindings = next;
        return statement;
      },
      all: async () => {
        if (sql.includes("SELECT public_seq, chain_digest, chain_version FROM problems")) {
          return fakeD1Result([
            { public_seq: publicSeq, chain_digest: chainDigest, chain_version: 2 },
          ]);
        }
        if (sql.includes("FROM krater_integrity_backfill")) {
          return fakeD1Result([
            { state: "complete", legacy_event_count: publicSeq, chain_version: 2 },
          ]);
        }
        if (sql.includes("SELECT id FROM events")) return fakeD1Result();
        throw new Error(`unexpected retry-harness all query: ${sql}`);
      },
      first: async () => {
        if (sql.includes("SELECT public_seq, chain_digest, chain_version FROM problems")) {
          return { public_seq: publicSeq, chain_digest: chainDigest, chain_version: 2 };
        }
        if (
          sql.includes("SELECT request_digest, event_id, event_seq") &&
          sql.includes("FROM idempotency WHERE problem_id")
        ) {
          return idempotency;
        }
        if (sql.includes("FROM events WHERE id = ?")) {
          if (normalizeSql(sql) !== EVENT_READ_SQL || bindings.length !== 1) {
            throw new Error("retry-harness event observation SQL drifted");
          }
          const persistedEventSnapshot = persistedEvent;
          if (persistedEventSnapshot === null || persistedEventSnapshot.id !== bindings[0]) {
            return null;
          }
          observedEvent = {
            eventId: persistedEventSnapshot.id as string,
            problemId: persistedEventSnapshot.problem_id as string,
            seq: persistedEventSnapshot.seq as number,
            type: persistedEventSnapshot.type as "claim.created",
            objectKind: persistedEventSnapshot.object_kind as string,
            objectId: persistedEventSnapshot.object_id as string,
            objectVersion: persistedEventSnapshot.object_version as number,
            payloadSha256: persistedEventSnapshot.payload_sha256 as string,
            rowDigest: persistedEventSnapshot.row_digest as string,
            chainDigest: persistedEventSnapshot.chain_digest as string,
            chainVersion: 2,
            createdAt: persistedEventSnapshot.created_at as string,
            actorFellowId: persistedEventSnapshot.actor_fellow_id as string | null,
            actorSponsorId: persistedEventSnapshot.actor_sponsor_id as string | null,
            actorSessionId: persistedEventSnapshot.actor_session_id as string | null,
            modelStringSelfDeclared: persistedEventSnapshot.model_string_self_declared as
              | string
              | null,
            harness: persistedEventSnapshot.harness as string | null,
            writerCredentialId: persistedEventSnapshot.writer_credential_id as string | null,
          };
          return { ...persistedEventSnapshot, chain_version: 2 };
        }
        if (sql.includes("FROM claims WHERE id = ?")) {
          if (normalizeSql(sql) !== CLAIM_READ_SQL || bindings.length !== 3) {
            throw new Error("retry-harness claim observation SQL drifted");
          }
          const matches =
            persistedClaim !== null &&
            persistedClaim.id === bindings[0] &&
            persistedClaim.problem_id === bindings[1] &&
            persistedClaim.source_seq === bindings[2];
          claimObserved = matches;
          return matches ? persistedClaim : null;
        }
        if (sql.includes("FROM outbox") && sql.includes("kind = 'search.index'")) {
          if (normalizeSql(sql) !== OUTBOX_READ_SQL || bindings.length !== 2) {
            throw new Error("retry-harness outbox observation SQL drifted");
          }
          const matches =
            persistedOutbox !== null &&
            persistedOutbox.event_id === bindings[0] &&
            persistedOutbox.problem_id === bindings[1] &&
            persistedOutbox.kind === "search.index";
          if (!matches || persistedOutbox === null) return null;
          observedOutbox = {
            eventId: persistedOutbox.event_id as string,
            kind: "search.index",
            state: persistedOutbox.state as "pending" | "delivered",
          };
          return persistedOutbox;
        }
        if (sql.includes("FROM claim_projections")) {
          if (normalizeSql(sql) !== PROJECTION_READ_SQL) {
            throw new Error("retry-harness projection read lost its exact event identity query");
          }
          if (persistedProjection === null) return null;
          const expectedSourceSeq = options.forceProjectionReadSequenceBindingMiss
            ? Number(persistedProjection.source_seq) + 1
            : persistedProjection.source_seq;
          const readsExactPersistedProjection =
            bindings.length === 3 &&
            bindings[0] === persistedProjection.claim_id &&
            bindings[1] === persistedProjection.problem_id &&
            bindings[2] === expectedSourceSeq;
          return readsExactPersistedProjection ? persistedProjection : null;
        }
        if (sql.includes("FROM integrity_checkpoints")) return persistedCheckpoint;
        throw new Error(`unexpected retry-harness first query: ${sql}`);
      },
      run: async () => {
        throw new Error(`unexpected retry-harness run query: ${sql}`);
      },
    };
    return statement;
  };

  const db = {
    prepare: prepared,
    batch: async (statements: readonly unknown[]) => {
      const observed = statements as readonly ObservedD1Statement[];
      if (conflictArmed) {
        conflictArmed = false;
        throw new Error("KRATER_CHAIN_HEAD_MISMATCH");
      }
      synchronousFtsStatements += observed.filter((statement) =>
        statement.sql.includes("public_claim_fts"),
      ).length;
      if (options.failOnSynchronousFts && synchronousFtsStatements > 0) {
        throw new Error("PLANTED_SYNCHRONOUS_FTS_UNAVAILABLE");
      }
      const one = (needle: string): ObservedD1Statement => {
        const found = observed.find((statement) => statement.sql.includes(needle));
        if (found === undefined) throw new Error(`retry-harness statement missing: ${needle}`);
        return found;
      };
      const updateProblem = one("UPDATE problems SET public_seq = public_seq + 1");
      const idempotencyInsert = one("INSERT INTO idempotency");
      const claimInsert = one("INSERT INTO claims");
      const eventInsert = one("INSERT INTO events");
      const projectionInsert = one("INSERT INTO claim_projections");
      const checkpointInsert = one("INSERT INTO integrity_checkpoints");
      const outboxInsert = one("INSERT INTO outbox");
      if (normalizeSql(claimInsert.sql) !== CLAIM_INSERT_SELECT_SQL) {
        throw new Error("retry-harness claim INSERT SELECT contract drifted");
      }
      if (normalizeSql(eventInsert.sql) !== EVENT_INSERT_SELECT_SQL) {
        throw new Error("retry-harness event INSERT SELECT contract drifted");
      }
      if (normalizeSql(outboxInsert.sql) !== OUTBOX_INSERT_SELECT_SQL) {
        throw new Error("retry-harness outbox INSERT SELECT contract drifted");
      }
      const idempotencyBindings = idempotencyInsert.bindings;
      const problemId = idempotencyBindings[0];
      const idempotencyKey = idempotencyBindings[1];
      if (
        typeof problemId !== "string" ||
        typeof idempotencyKey !== "string" ||
        idempotencyBindings[4] !== problemId ||
        !idempotencyInsert.sql.includes("WHERE EXISTS (SELECT 1 FROM problems WHERE id = ?)")
      ) {
        throw new Error("retry-harness idempotency ownership predicate missing");
      }
      if (
        updateProblem.bindings[2] !== problemId ||
        updateProblem.bindings[5] !== problemId ||
        updateProblem.bindings[6] !== idempotencyKey
      ) {
        throw new Error("retry-harness problem advance lost pending idempotency ownership");
      }
      const projectionOwnsPendingIdempotency =
        /FROM problems p\s+JOIN idempotency i ON i\.problem_id = p\.id AND i\.idempotency_key = \?\s+WHERE p\.id = \? AND i\.event_id IS NULL/.test(
          projectionInsert.sql,
        ) &&
        projectionInsert.bindings[3] === idempotencyKey &&
        projectionInsert.bindings[4] === problemId;
      if (!projectionOwnsPendingIdempotency) {
        throw new Error(
          "retry-harness projection INSERT lost selected pending-idempotency authority",
        );
      }
      if (idempotency === null) {
        idempotency = {
          request_digest: idempotencyBindings[2] as string,
          event_id: null,
          event_seq: null,
        };
      }
      if (idempotency.event_id !== null) {
        return observed.map(() => fakeD1Result());
      }
      const claimBindings = claimInsert.bindings;
      const eventBindings = eventInsert.bindings;
      const projectionBindings = projectionInsert.bindings;
      const checkpointBindings = checkpointInsert.bindings;
      const outboxBindings = outboxInsert.bindings;
      const ownsPendingIdempotency = idempotency.request_digest === idempotencyBindings[2];
      const projectionSelects =
        projectionOwnsPendingIdempotency &&
        !options.forceProjectionPredicateMiss &&
        ownsPendingIdempotency;
      const nextSeq = publicSeq + 1;
      chainDigest = updateProblem.bindings[0] as string;
      publicSeq = nextSeq;
      const claimExecutionBindings = [...claimBindings] as (string | number | null)[];
      const eventExecutionBindings = [...eventBindings] as (string | number | null)[];
      const outboxExecutionBindings = [...outboxBindings] as (string | number | null)[];
      if (options.forceClaimPredicateMiss) {
        claimExecutionBindings[5] = `${idempotencyKey}:missing`;
      }
      if (options.forceOutboxPredicateMiss) {
        outboxExecutionBindings[6] = `${idempotencyKey}:missing`;
      }
      const scratch = new Database(":memory:");
      try {
        scratch.run(`
          CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER NOT NULL);
          CREATE TABLE idempotency (
            problem_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            event_id TEXT,
            event_seq INTEGER,
            PRIMARY KEY (problem_id, idempotency_key)
          );
          CREATE TABLE companion_effects (
            phase TEXT PRIMARY KEY,
            writes INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE claims (
            id TEXT PRIMARY KEY,
            problem_id TEXT NOT NULL,
            statement TEXT NOT NULL,
            payload_sha256 TEXT NOT NULL,
            norm_hash TEXT,
            source_seq INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE events (
            id TEXT PRIMARY KEY,
            problem_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            object_kind TEXT NOT NULL,
            object_id TEXT NOT NULL,
            object_version INTEGER NOT NULL,
            payload_sha256 TEXT NOT NULL,
            row_digest TEXT,
            chain_digest TEXT,
            created_at TEXT NOT NULL,
            actor_fellow_id TEXT,
            actor_sponsor_id TEXT,
            actor_session_id TEXT,
            model_string_self_declared TEXT,
            harness TEXT,
            writer_credential_id TEXT
          );
          CREATE TABLE outbox (
            id INTEGER PRIMARY KEY,
            event_id TEXT NOT NULL,
            problem_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            dedupe_key TEXT NOT NULL UNIQUE,
            payload_sha256 TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL
          );
        `);
        scratch
          .query("INSERT INTO problems (id, public_seq) VALUES (?, ?)")
          .run(problemId, nextSeq);
        scratch
          .query(
            "INSERT INTO idempotency (problem_id, idempotency_key, event_id, event_seq) VALUES (?, ?, NULL, NULL)",
          )
          .run(problemId, idempotencyKey);
        scratch.run("INSERT INTO companion_effects (phase) VALUES ('pending'), ('settled')");
        scratch.query(claimInsert.sql).run(...claimExecutionBindings);
        scratch.query(eventInsert.sql).run(...eventExecutionBindings);
        scratch.query(outboxInsert.sql).run(...outboxExecutionBindings);
        for (const current of observed) {
          if (
            current.sql.includes("UPDATE idempotency") &&
            current.sql.includes("SET event_id = ?")
          ) {
            scratch
              .query(current.sql)
              .run(...(current.bindings as readonly (string | number | null)[]));
          } else if (current.sql.includes("UPDATE companion_effects")) {
            scratch
              .query(current.sql)
              .run(...(current.bindings as readonly (string | number | null)[]));
          }
        }
        const companionRows = scratch
          .query("SELECT phase, writes FROM companion_effects ORDER BY phase")
          .all() as { phase: "pending" | "settled"; writes: number }[];
        companionPhaseWrites = {
          pending: companionRows.find((row) => row.phase === "pending")?.writes ?? 0,
          settled: companionRows.find((row) => row.phase === "settled")?.writes ?? 0,
        };
        persistedClaim = scratch
          .query("SELECT id, problem_id, statement, payload_sha256, source_seq FROM claims LIMIT 1")
          .get() as Record<string, unknown> | null;
        persistedEvent = scratch
          .query(
            `SELECT id, problem_id, seq, type, object_kind, object_id, object_version,
                    payload_sha256, row_digest, chain_digest, created_at,
                    actor_fellow_id, actor_sponsor_id, actor_session_id,
                    model_string_self_declared, harness, writer_credential_id
             FROM events LIMIT 1`,
          )
          .get() as Record<string, unknown> | null;
        persistedOutbox = scratch
          .query(
            `SELECT event_id, problem_id, kind, dedupe_key, payload_sha256, state, created_at
             FROM outbox LIMIT 1`,
          )
          .get() as Record<string, unknown> | null;
      } finally {
        scratch.close();
      }
      if (projectionSelects) {
        persistedProjection = {
          claim_id: projectionBindings[0],
          problem_id: projectionBindings[4],
          source_seq: nextSeq,
          projection_version: 1,
          build_digest: projectionBindings[1],
          stale: 0,
        };
        observedProjection = {
          claimId: projectionBindings[0] as string,
          problemId: projectionBindings[4] as string,
          sourceSeq: nextSeq,
          projectionVersion: 1,
          buildDigest: projectionBindings[1] as string,
          stale: false,
        };
      }
      if (ownsPendingIdempotency) {
        persistedCheckpoint = {
          problem_id: checkpointBindings[3],
          checkpoint_seq: nextSeq,
          root_chain_digest: chainDigest,
          checkpoint_digest: checkpointBindings[0],
          checkpoint_version: 1,
          chain_version: 2,
          checkpoint_mode: "unsigned-v0",
        };
      }
      if (typeof persistedOutbox?.created_at === "string") {
        outboxCreatedAt = persistedOutbox.created_at;
      }
      idempotency = {
        request_digest: idempotencyBindings[2] as string,
        event_id: persistedEvent === null ? null : (persistedEvent.id as string),
        event_seq: persistedEvent === null ? null : nextSeq,
      };
      return observed.map((_statement, index) =>
        index === 1 ? fakeD1Result([{ public_seq: nextSeq }]) : fakeD1Result(),
      );
    },
  } as unknown as Parameters<typeof writeClaim>[0];
  return {
    db,
    armConflict: () => {
      conflictArmed = true;
    },
    companionPhaseWrites: () => companionPhaseWrites,
    persistedOutboxCreatedAt: () => outboxCreatedAt,
    synchronousFtsStatements: () => synchronousFtsStatements,
    persistedWrite: () => {
      if (
        observedEvent === undefined ||
        observedProjection === undefined ||
        observedOutbox === undefined ||
        !claimObserved
      ) {
        return undefined;
      }
      return {
        event: observedEvent,
        projection: observedProjection,
        outbox: observedOutbox,
      };
    },
  };
}

/**
 * Pure contracts plus narrow test-only statement observers for ingress and retry
 * binding. The producer harness executes the literal claim/event/outbox INSERT
 * SELECT statements in SQLite; full D1 transaction, FTS, trigger, pagination,
 * disconnect, and restart evidence is executed by scripts/e2e-s2-krater.sh.
 */
describe("Krater deterministic contracts", () => {
  test("canonicalizes object keys independently of construction order", async () => {
    const left = canonicalJson({ statement: "synthetic", claim_id: "C-1", kind: "claim" });
    const right = canonicalJson({ kind: "claim", claim_id: "C-1", statement: "synthetic" });

    expect(left).toBe(right);
    expect(await sha256Hex(left)).toBe(await sha256Hex(right));
  });

  test("generates a stable large bounded synthetic workload with unique idempotency keys", () => {
    const first = deterministicWorkload("s2seed", 201, "2026-08-14T00:00:00.000Z");
    const second = deterministicWorkload("s2seed", 201, "2026-08-14T00:00:00.000Z");

    expect(first).toEqual(second);
    expect(first[0]?.idempotencyKey).toBe("IK-s2seed-001");
    expect(first[200]?.idempotencyKey).toBe("IK-s2seed-201");
    expect(new Set(first.map((item) => item.idempotencyKey)).size).toBe(201);
  });

  test("keeps sequence allocation per problem scope", () => {
    const alpha = [event("P-alpha", 1, "a".repeat(64))];
    const beta = [event("P-beta", 1, "b".repeat(64))];

    expect(replayClaimProjections(alpha)[0]).toMatchObject({ problemId: "P-alpha", sourceSeq: 1 });
    expect(replayClaimProjections(beta)[0]).toMatchObject({ problemId: "P-beta", sourceSeq: 1 });
    expect(cursorMatchesEvents(1, alpha)).toBe(true);
    expect(cursorMatchesEvents(1, beta)).toBe(true);
  });

  test("models one-event transaction boundaries across cursor, projection, and outbox", () => {
    const events = [event("P-s2", 1, "a".repeat(64)), event("P-s2", 2, "b".repeat(64))];
    const projections = replayClaimProjections(events);
    const outbox = events.map((current) => ({
      eventId: current.eventId,
      kind: "search.index" as const,
      state: "pending" as const,
    }));

    expect(projectionReplayMatches(events, projections)).toBe(true);
    expect(outboxMatchesEvents(events, outbox)).toBe(true);
    expect(transactionBoundaryMatches(2, events, projections, outbox)).toBe(true);
    expect(transactionBoundaryMatches(1, events, projections, outbox)).toBe(false);

    const wrongBuildDigest = projections.map((projection, index) =>
      index === 0 ? { ...projection, buildDigest: "corrupt-row-digest" } : projection,
    );
    expect(projectionReplayMatches(events, wrongBuildDigest)).toBe(false);
    expect(transactionBoundaryMatches(2, events, wrongBuildDigest, outbox)).toBe(false);
  });

  test("PLANTED: an independently specified V2 builder row fails replay without changing its persisted boundary", () => {
    const persistedBody = Object.freeze({
      statement:
        "The durable event body stays identical while a V2 projection builder changes its projection digest.",
    });
    const persistedEvents: readonly KraterEvent[] = [
      {
        ...event("P-v2-builder", 1, "a".repeat(64)),
        eventId: "E-v2-builder",
        objectId: "C-v2-builder",
        rowDigest: "b".repeat(64),
        chainDigest: "c".repeat(64),
      },
    ];
    // This V2 row is deliberately hand-specified, not derived through
    // replayClaimProjections: it models a persisted changed-builder result.
    const persistedProjections: readonly ClaimProjection[] = [
      {
        claimId: "C-v2-builder",
        problemId: "P-v2-builder",
        sourceSeq: 1,
        projectionVersion: 2,
        buildDigest: "v2:independently-specified-projection-digest",
        stale: false,
      },
    ];
    const persistedOutbox: readonly KraterOutboxRecord[] = [
      { eventId: "E-v2-builder", kind: "search.index", state: "pending" },
    ];
    const persistedCursor = 1;
    const before = JSON.stringify({
      body: persistedBody,
      events: persistedEvents,
      projections: persistedProjections,
      outbox: persistedOutbox,
      cursor: persistedCursor,
    });

    expect(projectionReplayMatches(persistedEvents, persistedProjections)).toBe(false);
    expect(
      transactionBoundaryMatches(
        persistedCursor,
        persistedEvents,
        persistedProjections,
        persistedOutbox,
      ),
    ).toBe(false);
    expect(
      JSON.stringify({
        body: persistedBody,
        events: persistedEvents,
        projections: persistedProjections,
        outbox: persistedOutbox,
        cursor: persistedCursor,
      }),
    ).toBe(before);
  });

  test("validates bounded FTS read inputs before the real-D1 FTS query", () => {
    expect(() => validateFtsReadInput("synthetic AND claim", 10)).not.toThrow();
    expect(() => validateFtsReadInput("", 10)).toThrow(KraterValidationError);
    expect(() => validateFtsReadInput("synthetic", 51)).toThrow(KraterValidationError);
  });

  test("PLANTED: Krater ingress rejects noncanonical and future timestamps while retaining exact UTC", () => {
    const serverNowMs = Date.parse("2026-08-19T00:00:00.000Z");
    const canonical = "2026-08-19T00:00:00.000Z";

    expect(validateKraterIngressTimestamp(canonical, serverNowMs)).toBe(canonical);
    for (const invalid of [
      "2026-08-19",
      "2026-08-19T00:00:00+00:00",
      "2026-02-30T00:00:00.000Z",
      "2026-08-19T00:00:00.001Z",
    ]) {
      expect(() => validateKraterIngressTimestamp(invalid, serverNowMs)).toThrow(
        KraterValidationError,
      );
    }
  });

  test("PLANTED: ensureProblem and direct backfill cannot bypass canonical timestamp ingress", async () => {
    const serverNowMs = Date.parse("2026-08-19T00:00:00.000Z");
    const problemId = "P-ingress-seam";
    const canonical = "2000-01-01T00:00:00.000Z";
    const untouchedDb = {
      prepare: () => {
        throw new Error("KRATER_INGRESS_DB_TOUCHED");
      },
    } as unknown as Parameters<typeof ensureProblem>[0];
    for (const invalid of [
      "2026-08-19",
      "2026-08-19T00:00:00+00:00",
      "2026-02-30T00:00:00.000Z",
      "2026-08-19T00:00:00.001Z",
    ]) {
      await expect(ensureProblem(untouchedDb, problemId, invalid, serverNowMs)).rejects.toThrow(
        KraterValidationError,
      );
      await expect(
        backfillKraterIntegrity(untouchedDb, problemId, invalid, serverNowMs),
      ).rejects.toThrow(KraterValidationError);
    }

    const harness = ensureProblemHarness();
    await ensureProblem(harness.db, problemId, canonical, serverNowMs);
    expect(harness.inserts).toEqual([[problemId, canonical, canonical]]);
    const completion = harness.batches
      .flat()
      .find((statement) => statement.sql.includes("UPDATE krater_integrity_backfill"));
    expect(completion?.bindings).toEqual([0, canonical, problemId]);
  });

  test("captures a deterministic server-authored canonical UTC outbox instant", () => {
    const serverNowMs = Date.parse("2026-08-19T00:00:00.123Z");

    expect(serverAuthoredOutboxTimestamp(serverNowMs)).toBe("2026-08-19T00:00:00.123Z");
    expect(serverAuthoredOutboxTimestamp(serverNowMs)).toBe(
      serverAuthoredOutboxTimestamp(serverNowMs),
    );
  });

  test("PLANTED: writeClaim retry retains one entry-time server outbox timestamp", async () => {
    const entryTime = Date.parse("2026-08-19T00:00:10.000Z");
    const laterRetryTime = Date.parse("2026-08-19T00:00:20.000Z");
    const harness = retryingWriteHarness();
    const originalNow = Date.now;
    let nowCalls = 0;
    let headReads = 0;
    Date.now = () => {
      const value = nowCalls === 0 ? entryTime : laterRetryTime;
      nowCalls += 1;
      return value;
    };
    try {
      const result = await writeClaim(
        harness.db,
        {
          problemId: "P-retry-outbox-time",
          claimId: "C-retry-outbox-time",
          eventId: "E-retry-outbox-time",
          idempotencyKey: "IK-retry-outbox-time",
          statement: "The retry must retain its entry-time outbox timestamp.",
          createdAt: "2026-08-19T00:00:00.000Z",
        },
        {
          afterReadHead: async () => {
            headReads += 1;
            if (headReads === 1) harness.armConflict();
          },
        },
      );
      expect(result.retryCount).toBe(1);
      expect(headReads).toBe(2);
      expect(nowCalls).toBe(1);
      expect(harness.persistedOutboxCreatedAt()).toBe("2026-08-19T00:00:10.000Z");
    } finally {
      Date.now = originalNow;
    }
  });

  test("PLANTED: atomic companions execute only against the exact settled idempotency owner", async () => {
    const harness = retryingWriteHarness();
    let suppliedSettlement:
      | Readonly<{ sequence: number; claimId: string; eventId: string }>
      | undefined;

    const result = await writeClaim(
      harness.db,
      {
        problemId: "P-companion-settlement",
        claimId: "C-companion-settlement",
        eventId: "E-companion-settlement",
        idempotencyKey: "IK-companion-settlement",
        statement: "A companion owns the event only after idempotency settlement.",
        createdAt: "2026-08-19T00:00:00.000Z",
      },
      {},
      {
        statementsAfterIdempotencySettlement: (settlement) => {
          suppliedSettlement = settlement;
          return [
            harness.db
              .prepare(
                `UPDATE companion_effects SET writes = writes + 1
                 WHERE phase = 'pending' AND EXISTS (
                   SELECT 1 FROM idempotency
                   WHERE problem_id = ? AND idempotency_key = ? AND event_id IS NULL
                 )`,
              )
              .bind("P-companion-settlement", "IK-companion-settlement"),
            harness.db
              .prepare(
                `UPDATE companion_effects SET writes = writes + 1
                 WHERE phase = 'settled' AND EXISTS (
                   SELECT 1 FROM idempotency
                   WHERE problem_id = ? AND idempotency_key = ?
                     AND event_id = ? AND event_seq = ?
                 )`,
              )
              .bind(
                "P-companion-settlement",
                "IK-companion-settlement",
                settlement.eventId,
                settlement.sequence,
              ),
          ];
        },
      },
    );

    expect(suppliedSettlement).toEqual({
      sequence: 1,
      claimId: "C-companion-settlement",
      eventId: "E-companion-settlement",
    });
    expect(result).toMatchObject({ eventId: "E-companion-settlement", seq: 1 });
    expect(harness.companionPhaseWrites()).toEqual({ pending: 0, settled: 1 });
  });

  test("PLANTED: writeClaim persists the v1 projection digest from its authoritative event row", async () => {
    const harness = retryingWriteHarness();
    const result = await writeClaim(harness.db, {
      problemId: "P-projection-digest-v1",
      claimId: "C-projection-digest-v1",
      eventId: "E-projection-digest-v1",
      idempotencyKey: "IK-projection-digest-v1",
      statement: "A lossless one-event projection keeps the authoritative event row digest.",
      createdAt: new Date().toISOString(),
    });
    const persisted = harness.persistedWrite();
    if (persisted === undefined) throw new Error("writeClaim did not persist its fake-D1 records");

    expect(result.buildDigest).toBe(result.rowDigest);
    expect(persisted.projection.buildDigest).toBe(persisted.event.rowDigest);
    expect(result.buildDigest).toBe(persisted.event.rowDigest);
    expect(projectionReplayMatches([persisted.event], [persisted.projection])).toBe(true);
    expect(
      transactionBoundaryMatches(
        result.postCursor,
        [persisted.event],
        [persisted.projection],
        [persisted.outbox],
      ),
    ).toBe(true);
  });

  test("PLANTED: the retained 0001 upgrade fixture carries the current envelope projection digest", async () => {
    const database = new Database(":memory:", { strict: true });
    database.run(
      readFileSync(
        resolve(import.meta.dir, "fixtures/legacy-migrations/0001_krater_v0.sql"),
        "utf8",
      ),
    );
    database.run(
      readFileSync(resolve(import.meta.dir, "fixtures/legacy-existing-event.sql"), "utf8"),
    );
    const projection = database
      .query<{ build_digest: string }, []>(
        "SELECT build_digest FROM claim_projections WHERE problem_id = 'P-upgrade-existing' AND claim_id = 'C-upgrade-existing-001'",
      )
      .get();
    const expected = await eventRowDigest(
      {
        problemId: "P-upgrade-existing",
        claimId: "C-upgrade-existing-001",
        eventId: "E-upgrade-existing-001",
        idempotencyKey: "IK-upgrade-existing-001",
        statement: "Legacy retained claim.",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
      1,
      "4478d240c1c16feba4147299312ababf59e5b21738913577e967754f8cac2050",
    );

    expect(projection).toEqual({ build_digest: expected });
  });

  test("PLANTED: core claim writes enqueue search work without touching synchronous FTS", async () => {
    const harness = retryingWriteHarness({ failOnSynchronousFts: true });

    await expect(
      writeClaim(harness.db, {
        problemId: "P-outbox-only-search",
        claimId: "C-outbox-only-search",
        eventId: "E-outbox-only-search",
        idempotencyKey: "IK-outbox-only-search",
        statement: "Search backlog must not make the authoritative ledger write unavailable.",
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ eventId: "E-outbox-only-search" });

    expect(harness.synchronousFtsStatements()).toBe(0);
    expect(harness.persistedWrite()?.outbox).toEqual({
      eventId: "E-outbox-only-search",
      kind: "search.index",
      state: "pending",
    });
  });

  test("PLANTED: a zero-row claim INSERT SELECT cannot produce a successful write receipt", async () => {
    const harness = retryingWriteHarness({ forceClaimPredicateMiss: true });

    await expect(
      writeClaim(harness.db, {
        problemId: "P-missing-claim-insert",
        claimId: "C-missing-claim-insert",
        eventId: "E-missing-claim-insert",
        idempotencyKey: "IK-missing-claim-insert",
        statement: "A durable event cannot substitute for its missing claim source.",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Krater write did not persist its claim row.");
    expect(harness.persistedWrite()).toBeUndefined();
  });

  test("PLANTED: a zero-row outbox INSERT SELECT cannot produce a successful write receipt", async () => {
    const harness = retryingWriteHarness({ forceOutboxPredicateMiss: true });

    await expect(
      writeClaim(harness.db, {
        problemId: "P-missing-outbox-insert",
        claimId: "C-missing-outbox-insert",
        eventId: "E-missing-outbox-insert",
        idempotencyKey: "IK-missing-outbox-insert",
        statement: "A write receipt requires the durable search handoff row.",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Krater write did not persist its search outbox handoff.");
    expect(harness.persistedWrite()).toBeUndefined();
  });

  test("PLANTED: writeClaim refuses a projection INSERT SELECT that produces no owned row", async () => {
    const harness = retryingWriteHarness({ forceProjectionPredicateMiss: true });

    await expect(
      writeClaim(harness.db, {
        problemId: "P-projection-predicate-miss",
        claimId: "C-projection-predicate-miss",
        eventId: "E-projection-predicate-miss",
        idempotencyKey: "IK-projection-predicate-miss",
        statement: "A missing selected projection row must fail the write receipt.",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Krater write did not persist a projection.");
    expect(harness.persistedWrite()).toBeUndefined();
  });

  test("PLANTED: writeClaim refuses one wrong source-sequence projection read binding without a receipt", async () => {
    const harness = retryingWriteHarness({ forceProjectionReadSequenceBindingMiss: true });
    let receipt: Awaited<ReturnType<typeof writeClaim>> | undefined;

    await expect(
      writeClaim(harness.db, {
        problemId: "P-projection-read-sequence-miss",
        claimId: "C-projection-read-sequence-miss",
        eventId: "E-projection-read-sequence-miss",
        idempotencyKey: "IK-projection-read-sequence-miss",
        statement: "An exact projection read must not accept a source-sequence mismatch.",
        createdAt: new Date().toISOString(),
      }).then((result) => {
        receipt = result;
      }),
    ).rejects.toThrow("Krater write did not persist a projection.");

    expect(receipt).toBeUndefined();
    expect(harness.persistedWrite()).toBeDefined();
  });

  test("replays contiguous envelopes and rejects sequence gaps or mixed scopes", () => {
    const first = event("P-s2", 1, "a".repeat(64));
    const second = event("P-s2", 2, "b".repeat(64));
    const events = [first, second];
    expect(replayClaimProjections(events)).toHaveLength(2);
    expect(() => replayClaimProjections([event("P-s2", 2, "c".repeat(64))])).toThrow(
      KraterReplayError,
    );
    expect(() => replayClaimProjections([first, event("P-other", 2, "d".repeat(64))])).toThrow(
      KraterReplayError,
    );
  });

  test("derives a per-problem chain and detects a planted envelope mutation", async () => {
    const problemId = "P-chain";
    const firstPayload = "a".repeat(64);
    const secondPayload = "b".repeat(64);
    const genesis = await genesisChainDigest(problemId);
    const firstDraft = event(problemId, 1, firstPayload);
    const firstRow = await canonicalEventRow(firstDraft);
    const firstChain = await eventChainDigest(problemId, 1, firstPayload, firstRow, genesis);
    const first = { ...firstDraft, rowDigest: firstRow, chainDigest: firstChain };
    const secondDraft = event(problemId, 2, secondPayload);
    const secondRow = await canonicalEventRow(secondDraft);
    const secondChain = await eventChainDigest(
      problemId,
      2,
      secondPayload,
      secondRow,
      firstChain,
    );
    const second = { ...secondDraft, rowDigest: secondRow, chainDigest: secondChain };
    const valid = [first, second];

    expect(await eventChainMatches(valid)).toBe(true);
    expect(await eventChainMatches([first, { ...second, payloadSha256: "c".repeat(64) }])).toBe(
      false,
    );
  });

  test("accepts exact sequence maxima but rejects unsafe or fractional digest ingress", async () => {
    const input = {
      problemId: "P-safe-sequence",
      claimId: "C-safe-sequence",
      eventId: "E-safe-sequence",
      idempotencyKey: "IK-safe-sequence",
      statement: "A sequence boundary must stay exact.",
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const max = Number.MAX_SAFE_INTEGER;
    const payload = "a".repeat(64);
    const prior = "b".repeat(64);

    await expect(eventChainDigest(input.problemId, max, payload, "c".repeat(64), prior)).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
    await expect(eventRowDigest(input, max, payload)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(checkpointDigest(input.problemId, max, prior)).resolves.toMatch(/^[a-f0-9]{64}$/);
    for (const invalid of [max + 1, 1.5]) {
      await expect(
        eventChainDigest(input.problemId, invalid, payload, "c".repeat(64), prior),
      ).rejects.toThrow(
        KraterValidationError,
      );
      await expect(eventRowDigest(input, invalid, payload)).rejects.toThrow(KraterValidationError);
      await expect(checkpointDigest(input.problemId, invalid, prior)).rejects.toThrow(
        KraterValidationError,
      );
    }
  });

  test("rejects an invalid deterministic-workload seed", () => {
    expect(() => deterministicWorkload("seed with spaces", 1, "2026-08-14T00:00:00.000Z")).toThrow(
      KraterValidationError,
    );
  });
});

describe("migration 0001 event sequence ownership", () => {
  test("PLANTED: duplicate problem sequence fails while the same sequence in another problem succeeds", () => {
    const db = new Database(":memory:");
    try {
      const migration = resolve(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "db",
        "migrations",
        "0001_krater_v0.sql",
      );
      db.run(readFileSync(migration, "utf8"));
      const createdAt = "2026-08-19T00:00:00.000Z";
      const insertProblem = db.query(
        "INSERT INTO problems (id, created_at, updated_at) VALUES (?, ?, ?)",
      );
      insertProblem.run("P-sequence-alpha", createdAt, createdAt);
      insertProblem.run("P-sequence-beta", createdAt, createdAt);

      const insertEvent = (eventId: string, problemId: string, sequence: number): void => {
        db.query(
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version,
              payload_sha256, created_at)
           VALUES (?, ?, ?, 'claim.created', 'claim', ?, 1, ?, ?)`,
        ).run(eventId, problemId, sequence, `C-${eventId}`, "a".repeat(64), createdAt);
      };

      insertEvent("E-sequence-alpha-1", "P-sequence-alpha", 1);
      expect(() => insertEvent("E-sequence-alpha-duplicate", "P-sequence-alpha", 1)).toThrow(
        /UNIQUE constraint failed: events\.problem_id, events\.seq/,
      );
      expect(() => insertEvent("E-sequence-beta-1", "P-sequence-beta", 1)).not.toThrow();
      expect(db.query("SELECT problem_id, seq FROM events ORDER BY problem_id").all()).toEqual([
        { problem_id: "P-sequence-alpha", seq: 1 },
        { problem_id: "P-sequence-beta", seq: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("migration 0005 forward-applies onto an exact 0004 database", () => {
  // The index this proves is the difference between the completeness probe seeking and the
  // probe searching a problem's whole log on every write. The migration files are read from
  // disk and applied in order, so the thing under test is the shipped SQL, not a restatement
  // of it, and the query explained is the constant the probe itself executes.
  const MIGRATIONS = resolve(import.meta.dir, "..", "..", "..", "..", "db", "migrations");
  const THROUGH_0004 = [
    "0001_krater_v0.sql",
    "0002_enrollment_g0.sql",
    "0003_auth_nonce_replay.sql",
    "0004_krater_integrity_v1.sql",
  ];
  const INDEX_MIGRATION = "0005_krater_undigested_index.sql";

  function planSteps(db: Database): string[] {
    const rows = db
      .query(`EXPLAIN QUERY PLAN ${UNDIGESTED_EVENT_PROBE_SQL}`)
      .all("P-plan-probe") as { detail: string }[];
    return rows.map((row) => row.detail);
  }

  function indexNames(db: Database): string[] {
    return (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
        .all() as { name: string }[]
    ).map((row) => row.name);
  }

  function openAt0004(): Database {
    const db = new Database(":memory:");
    for (const migration of THROUGH_0004) {
      db.run(readFileSync(join(MIGRATIONS, migration), "utf8"));
    }
    return db;
  }

  test("an exact 0004 database has no partial index and does not use one", () => {
    const db = openAt0004();
    expect(indexNames(db)).not.toContain(UNDIGESTED_EVENT_INDEX);
    const steps = planSteps(db);
    expect(steps.length).toBeGreaterThan(0);
    // The pre-0005 plan is the defect this migration exists to fix: a seek to the problem
    // followed by a walk of its log. Asserting it keeps the test able to tell the two apart.
    expect(steps.some((step) => step.includes(UNDIGESTED_EVENT_INDEX))).toBe(false);
    db.close();
  });

  test("applying 0005 creates the index and the probe then uses it", () => {
    const db = openAt0004();
    db.run(readFileSync(join(MIGRATIONS, INDEX_MIGRATION), "utf8"));
    expect(indexNames(db)).toContain(UNDIGESTED_EVENT_INDEX);
    const steps = planSteps(db);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.includes(UNDIGESTED_EVENT_INDEX))).toBe(true);
    // A seek, not a scan: SCAN would mean the partial predicate stopped implying the query's.
    expect(steps.some((step) => step.startsWith("SCAN"))).toBe(false);
    db.close();
  });

  test("0005 is idempotent, so a database that already has it re-applies cleanly", () => {
    const db = openAt0004();
    const sql = readFileSync(join(MIGRATIONS, INDEX_MIGRATION), "utf8");
    db.run(sql);
    expect(() => db.run(sql)).not.toThrow();
    expect(indexNames(db).filter((name) => name === UNDIGESTED_EVENT_INDEX)).toHaveLength(1);
    db.close();
  });
});

describe("migration 0039 replays an exact completed v1 history into one v2 authority", () => {
  const MIGRATIONS = resolve(import.meta.dir, "..", "..", "..", "..", "db", "migrations");

  interface LocalPreparedStatement {
    readonly query: string;
    readonly values: readonly unknown[];
    all<T>(): Promise<{
      results: T[];
      meta: { rows_read: number; rows_written: number };
    }>;
    first<T>(): Promise<T | null>;
    run(): Promise<{ meta: { rows_read: number; rows_written: number } }>;
  }

  function localD1(sqlite: Database): Parameters<typeof backfillKraterIntegrity>[0] {
    const prepared = (query: string, values: readonly unknown[]): LocalPreparedStatement => ({
      query,
      values,
      all: async <T>() => {
        const results = sqlite.query(query).all(...(values as never)) as T[];
        return { results, meta: { rows_read: results.length, rows_written: 0 } };
      },
      first: async <T>() => (sqlite.query(query).get(...(values as never)) as T) ?? null,
      run: async () => {
        const result = sqlite.query(query).run(...(values as never));
        return { meta: { rows_read: 0, rows_written: result.changes } };
      },
    });
    return {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => prepared(query, values),
      }),
      batch: async (statements: readonly LocalPreparedStatement[]) =>
        sqlite.transaction(() => statements.map((statement) => {
          const result = sqlite.query(statement.query).run(...(statement.values as never));
          return {
            success: true,
            results: [],
            meta: { rows_read: 0, rows_written: result.changes },
          };
        }))(),
    } as never;
  }

  test("preserves verified v1 bytes and atomically installs exact v2 sidecars and projection authority", async () => {
    const sqlite = new Database(":memory:");
    try {
      const migrations = readdirSync(MIGRATIONS)
        .filter((name) => /^00(?:0[1-9]|[12][0-9]|3[0-8])_.*\.sql$/u.test(name))
        .sort();
      expect(migrations.at(-1)).toBe("0038_events_writer_credential.sql");
      for (const migration of migrations) {
        sqlite.run(readFileSync(join(MIGRATIONS, migration), "utf8"));
      }

      const problemId = "P-v1-complete-upgrade";
      const eventId = "E-v1-complete-upgrade-1";
      const claimId = "C-v1-complete-upgrade-1";
      const payloadSha256 = "ab".repeat(32);
      const createdAt = "2026-08-24T18:00:00.000Z";
      const actorFellowId = "F-v1-upgrade";
      const actorSponsorId = "S-v1-upgrade";
      const actorSessionId = "SE-v1-upgrade";
      const modelStringSelfDeclared = "gpt-5.6-sol";
      const harness = "codex-cli";
      const writerCredentialId = "FC-v1-upgrade";
      const legacyGenesis = await sha256Hex(
        canonicalJson({ kind: "krater.v0.genesis", problem_id: problemId }),
      );
      const legacyRowDigest = await sha256Hex(
        canonicalJson({
          created_at: createdAt,
          event_id: eventId,
          object_id: claimId,
          object_kind: "claim",
          object_version: 1,
          payload_sha256: payloadSha256,
          problem_id: problemId,
          seq: 1,
          type: "claim.created",
        }),
      );
      const legacyChainDigest = await sha256Hex(
        canonicalJson({
          payload_sha256: payloadSha256,
          previous_chain_digest: legacyGenesis,
          problem_id: problemId,
          seq: 1,
        }),
      );
      const legacyCheckpointDigest = await sha256Hex(
        canonicalJson({
          checkpoint_version: 1,
          problem_id: problemId,
          root_chain_digest: legacyChainDigest,
          seq: 1,
        }),
      );

      sqlite
        .query(
          `INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest)
           VALUES (?, 1, ?, ?, ?)`,
        )
        .run(problemId, createdAt, createdAt, legacyChainDigest);
      sqlite
        .query(
          `INSERT INTO krater_integrity_backfill
             (problem_id, state, legacy_event_count, completed_at)
           VALUES (?, 'complete', 1, ?)`,
        )
        .run(problemId, createdAt);
      sqlite
        .query(
          `INSERT INTO claims
             (id, problem_id, statement, payload_sha256, source_seq, created_at, norm_hash)
           VALUES (?, ?, 'completed v1 claim', ?, 1, ?, ?)`,
        )
        .run(claimId, problemId, payloadSha256, createdAt, "cd".repeat(32));
      sqlite
        .query(
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version,
              payload_sha256, created_at, row_digest, chain_digest,
              actor_fellow_id, actor_sponsor_id, actor_session_id,
              model_string_self_declared, harness, writer_credential_id)
           VALUES (?, ?, 1, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          problemId,
          claimId,
          payloadSha256,
          createdAt,
          legacyRowDigest,
          legacyChainDigest,
          actorFellowId,
          actorSponsorId,
          actorSessionId,
          modelStringSelfDeclared,
          harness,
          writerCredentialId,
        );
      sqlite
        .query(
          `INSERT INTO claim_projections
             (claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at)
           VALUES (?, ?, 1, 1, ?, 0, ?)`,
        )
        .run(claimId, problemId, legacyRowDigest, createdAt);
      sqlite
        .query(
          `INSERT INTO integrity_checkpoints
             (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest,
              checkpoint_version, checkpoint_mode, created_at)
           VALUES (?, 1, ?, ?, 1, 'unsigned-v0', ?)`,
        )
        .run(problemId, legacyChainDigest, legacyCheckpointDigest, createdAt);

      sqlite.run(readFileSync(join(MIGRATIONS, "0039_krater_chain_v2.sql"), "utf8"));
      expect(
        sqlite
          .query(
            "SELECT state, completed_at, chain_version FROM krater_integrity_backfill WHERE problem_id = ?",
          )
          .get(problemId),
      ).toEqual({ state: "required", completed_at: null, chain_version: null });
      expect(
        sqlite.query("SELECT row_digest, chain_digest FROM events WHERE id = ?").get(eventId),
      ).toEqual({ row_digest: legacyRowDigest, chain_digest: legacyChainDigest });
      expect(
        sqlite
          .query(
            "SELECT root_chain_digest, checkpoint_digest FROM integrity_checkpoints WHERE problem_id = ? AND checkpoint_seq = 1",
          )
          .get(problemId),
      ).toEqual({
        root_chain_digest: legacyChainDigest,
        checkpoint_digest: legacyCheckpointDigest,
      });

      // Causal negative: the event rows/head remain a valid completed-v1
      // history, but one checkpoint digest changes. Replay must refuse before
      // installing even one v2 byte, then the untouched control can proceed.
      sqlite
        .query(
          "UPDATE integrity_checkpoints SET checkpoint_digest = ? WHERE problem_id = ? AND checkpoint_seq = 1",
        )
        .run("ff".repeat(32), problemId);
      await expect(
        backfillKraterIntegrity(
          localD1(sqlite),
          problemId,
          "2026-08-24T18:30:00.000Z",
          Date.parse("2026-08-24T18:30:00.000Z"),
        ),
      ).rejects.toThrow("stored v1 checkpoint bytes disagree");
      expect(
        sqlite.query("SELECT COUNT(*) AS count FROM event_chain_v2").get(),
      ).toEqual({ count: 0 });
      expect(
        sqlite.query("SELECT COUNT(*) AS count FROM checkpoint_chain_v2").get(),
      ).toEqual({ count: 0 });
      expect(
        sqlite.query("SELECT chain_digest, chain_version FROM problems WHERE id = ?").get(problemId),
      ).toEqual({ chain_digest: legacyChainDigest, chain_version: null });
      sqlite
        .query(
          "UPDATE integrity_checkpoints SET checkpoint_digest = ? WHERE problem_id = ? AND checkpoint_seq = 1",
        )
        .run(legacyCheckpointDigest, problemId);

      const completedAt = "2026-08-24T19:00:00.000Z";
      const expectedRowDigest = await eventEnvelopeRowDigest({
        eventId,
        problemId,
        seq: 1,
        type: "claim.created",
        objectKind: "claim",
        objectId: claimId,
        objectVersion: 1,
        payloadSha256,
        createdAt,
        actorFellowId,
        actorSponsorId,
        actorSessionId,
        modelStringSelfDeclared,
        harness,
        writerCredentialId,
      });
      const expectedChainDigest = await eventChainDigest(
        problemId,
        1,
        payloadSha256,
        expectedRowDigest,
        await genesisChainDigest(problemId),
      );
      const expectedCheckpointDigest = await checkpointDigest(
        problemId,
        1,
        expectedChainDigest,
      );
      await backfillKraterIntegrity(
        localD1(sqlite),
        problemId,
        completedAt,
        Date.parse(completedAt),
      );

      expect(
        sqlite
          .query(
            "SELECT row_digest, chain_digest, chain_version FROM event_chain_v2 WHERE event_id = ?",
          )
          .get(eventId),
      ).toEqual({
        row_digest: expectedRowDigest,
        chain_digest: expectedChainDigest,
        chain_version: 2,
      });
      expect(
        sqlite
          .query(
            "SELECT root_chain_digest, checkpoint_digest, chain_version FROM checkpoint_chain_v2 WHERE problem_id = ? AND checkpoint_seq = 1",
          )
          .get(problemId),
      ).toEqual({
        root_chain_digest: expectedChainDigest,
        checkpoint_digest: expectedCheckpointDigest,
        chain_version: 2,
      });
      expect(
        sqlite
          .query("SELECT public_seq, chain_digest, chain_version FROM problems WHERE id = ?")
          .get(problemId),
      ).toEqual({ public_seq: 1, chain_digest: expectedChainDigest, chain_version: 2 });
      expect(
        sqlite
          .query(
            "SELECT state, legacy_event_count, completed_at, chain_version FROM krater_integrity_backfill WHERE problem_id = ?",
          )
          .get(problemId),
      ).toEqual({
        state: "complete",
        legacy_event_count: 1,
        completed_at: completedAt,
        chain_version: 2,
      });
      expect(
        sqlite
          .query("SELECT build_digest, updated_at FROM claim_projections WHERE problem_id = ?")
          .get(problemId),
      ).toEqual({ build_digest: expectedRowDigest, updated_at: completedAt });
      expect(
        sqlite.query("SELECT row_digest, chain_digest FROM events WHERE id = ?").get(eventId),
      ).toEqual({ row_digest: legacyRowDigest, chain_digest: legacyChainDigest });
      expect(
        sqlite
          .query(
            "SELECT root_chain_digest, checkpoint_digest FROM integrity_checkpoints WHERE problem_id = ? AND checkpoint_seq = 1",
          )
          .get(problemId),
      ).toEqual({
        root_chain_digest: legacyChainDigest,
        checkpoint_digest: legacyCheckpointDigest,
      });
    } finally {
      sqlite.close();
    }
  });

  test("sidecar table guards bind direct inserts to the exact event and checkpoint root", () => {
    const sqlite = new Database(":memory:");
    try {
      for (const migration of readdirSync(MIGRATIONS)
        .filter((name) => /^00(?:0[1-9]|[12][0-9]|3[0-8])_.*\.sql$/u.test(name))
        .sort()) {
        sqlite.run(readFileSync(join(MIGRATIONS, migration), "utf8"));
      }
      const createdAt = "2026-08-24T18:00:00.000Z";
      const problemId = "P-v2-binding";
      const otherProblemId = "P-v2-binding-other";
      const eventId = "E-v2-binding-1";
      const root = "11".repeat(32);
      const row = "22".repeat(32);
      const checkpoint = "33".repeat(32);
      sqlite
        .query(
          "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest) VALUES (?, 1, ?, ?, ?), (?, 0, ?, ?, NULL)",
        )
        .run(
          problemId,
          createdAt,
          createdAt,
          root,
          otherProblemId,
          createdAt,
          createdAt,
        );
      sqlite
        .query(
          `INSERT INTO krater_integrity_backfill
             (problem_id, state, legacy_event_count, completed_at)
           VALUES (?, 'complete', 1, ?), (?, 'complete', 0, ?)`,
        )
        .run(problemId, createdAt, otherProblemId, createdAt);
      sqlite
        .query(
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version,
              payload_sha256, created_at, row_digest, chain_digest)
           VALUES (?, ?, 1, 'claim.created', 'claim', 'C-v2-binding-1', 1, ?, ?, ?, ?)`,
        )
        .run(eventId, problemId, "44".repeat(32), createdAt, row, root);
      sqlite
        .query(
          `INSERT INTO integrity_checkpoints
             (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest,
              checkpoint_version, checkpoint_mode, created_at)
           VALUES (?, 1, ?, ?, 1, 'unsigned-v0', ?)`,
        )
        .run(problemId, root, checkpoint, createdAt);
      sqlite.run(readFileSync(join(MIGRATIONS, "0039_krater_chain_v2.sql"), "utf8"));

      const insertEventSidecar = (
        candidateEventId: string,
        candidateProblemId: string,
        sequence: number,
      ): void => {
        sqlite
          .query(
            `INSERT INTO event_chain_v2
               (event_id, problem_id, seq, row_digest, chain_digest, chain_version)
             VALUES (?, ?, ?, ?, ?, 2)`,
          )
          .run(candidateEventId, candidateProblemId, sequence, row, root);
      };
      expect(() => insertEventSidecar("E-v2-binding-absent", problemId, 1)).toThrow(
        "KRATER_CHAIN_V2_EVENT_BINDING_MISMATCH",
      );
      expect(() => insertEventSidecar(eventId, otherProblemId, 1)).toThrow(
        "KRATER_CHAIN_V2_EVENT_BINDING_MISMATCH",
      );
      expect(() => insertEventSidecar(eventId, problemId, 2)).toThrow(
        "KRATER_CHAIN_V2_EVENT_BINDING_MISMATCH",
      );
      expect(sqlite.query("SELECT COUNT(*) AS count FROM event_chain_v2").get()).toEqual({
        count: 0,
      });
      expect(() => insertEventSidecar(eventId, problemId, 1)).not.toThrow();

      const insertCheckpointSidecar = (sequence: number, candidateRoot: string): void => {
        sqlite
          .query(
            `INSERT INTO checkpoint_chain_v2
               (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, chain_version)
             VALUES (?, ?, ?, ?, 2)`,
          )
          .run(problemId, sequence, candidateRoot, checkpoint);
      };
      expect(() => insertCheckpointSidecar(1, "55".repeat(32))).toThrow(
        "KRATER_CHECKPOINT_CHAIN_V2_BINDING_MISMATCH",
      );
      expect(() => insertCheckpointSidecar(2, root)).toThrow(
        "KRATER_CHECKPOINT_CHAIN_V2_BINDING_MISMATCH",
      );
      expect(sqlite.query("SELECT COUNT(*) AS count FROM checkpoint_chain_v2").get()).toEqual({
        count: 0,
      });
      expect(() => insertCheckpointSidecar(1, root)).not.toThrow();
    } finally {
      sqlite.close();
    }
  });
});
