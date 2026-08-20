import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  backfillKraterIntegrity,
  canonicalJson,
  checkpointDigest,
  ensureProblem,
  serverAuthoredOutboxTimestamp,
  cursorMatchesEvents,
  deterministicWorkload,
  eventChainDigest,
  eventChainMatches,
  eventRowDigest,
  genesisChainDigest,
  type KraterEvent,
  KraterReplayError,
  KraterValidationError,
  outboxMatchesEvents,
  projectionReplayMatches,
  replayClaimProjections,
  sha256Hex,
  transactionBoundaryMatches,
  UNDIGESTED_EVENT_INDEX,
  UNDIGESTED_EVENT_PROBE_SQL,
  validateKraterIngressTimestamp,
  validateFtsReadInput,
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
    objectId: `C-${problemId}-${seq}`,
    payloadSha256,
    rowDigest,
    chainDigest,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
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
        if (sql.includes("SELECT public_seq, chain_digest FROM problems")) {
          return fakeD1Result([{ public_seq: 0, chain_digest: null }]);
        }
        if (sql.includes("FROM krater_integrity_backfill")) return fakeD1Result();
        if (sql.includes("FROM events WHERE problem_id")) return fakeD1Result();
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

function retryingWriteHarness(): {
  readonly db: Parameters<typeof writeClaim>[0];
  readonly armConflict: () => void;
  readonly persistedOutboxCreatedAt: () => string | null;
} {
  let publicSeq = 0;
  let chainDigest = "a".repeat(64);
  let conflictArmed = false;
  let outboxCreatedAt: string | null = null;
  let idempotency: { request_digest: string; event_id: string; event_seq: number } | null = null;
  let persistedEvent: Record<string, unknown> | null = null;
  let persistedProjection: Record<string, unknown> | null = null;
  let persistedCheckpoint: Record<string, unknown> | null = null;

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
        if (sql.includes("SELECT public_seq, chain_digest FROM problems")) {
          return fakeD1Result([{ public_seq: publicSeq, chain_digest: chainDigest }]);
        }
        if (sql.includes("FROM krater_integrity_backfill")) {
          return fakeD1Result([{ state: "complete", legacy_event_count: publicSeq }]);
        }
        if (sql.includes("SELECT id FROM events")) return fakeD1Result();
        throw new Error(`unexpected retry-harness all query: ${sql}`);
      },
      first: async () => {
        if (sql.includes("SELECT public_seq, chain_digest FROM problems")) {
          return { public_seq: publicSeq, chain_digest: chainDigest };
        }
        if (
          sql.includes("SELECT request_digest, event_id, event_seq") &&
          sql.includes("FROM idempotency WHERE problem_id")
        ) {
          return idempotency;
        }
        if (sql.includes("FROM events WHERE id = ?")) return persistedEvent;
        if (sql.includes("FROM claim_projections")) return persistedProjection;
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
      const one = (needle: string): ObservedD1Statement => {
        const found = observed.find((statement) => statement.sql.includes(needle));
        if (found === undefined) throw new Error(`retry-harness statement missing: ${needle}`);
        return found;
      };
      const updateProblem = one("UPDATE problems SET public_seq = public_seq + 1");
      const idempotencyInsert = one("INSERT INTO idempotency");
      const eventInsert = one("INSERT INTO events");
      const projectionInsert = one("INSERT INTO claim_projections");
      const checkpointInsert = one("INSERT INTO integrity_checkpoints");
      const outboxInsert = one("INSERT INTO outbox");
      const nextSeq = publicSeq + 1;
      chainDigest = updateProblem.bindings[0] as string;
      publicSeq = nextSeq;
      const eventBindings = eventInsert.bindings;
      const projectionBindings = projectionInsert.bindings;
      const checkpointBindings = checkpointInsert.bindings;
      const idempotencyBindings = idempotencyInsert.bindings;
      const outboxBindings = outboxInsert.bindings;
      idempotency = {
        request_digest: idempotencyBindings[2] as string,
        event_id: eventBindings[0] as string,
        event_seq: nextSeq,
      };
      persistedEvent = {
        id: eventBindings[0],
        problem_id: eventBindings[7],
        seq: nextSeq,
        type: "claim.created",
        object_kind: "claim",
        object_id: eventBindings[1],
        object_version: 1,
        payload_sha256: eventBindings[2],
        row_digest: eventBindings[3],
        chain_digest: eventBindings[4],
        created_at: eventBindings[5],
      };
      persistedProjection = {
        claim_id: projectionBindings[0],
        problem_id: projectionBindings[4],
        source_seq: nextSeq,
        projection_version: 1,
        build_digest: projectionBindings[1],
        stale: 0,
      };
      persistedCheckpoint = {
        problem_id: checkpointBindings[3],
        checkpoint_seq: nextSeq,
        root_chain_digest: chainDigest,
        checkpoint_digest: checkpointBindings[0],
        checkpoint_version: 1,
        checkpoint_mode: "unsigned-v0",
      };
      outboxCreatedAt = outboxBindings[4] as string;
      return observed.map((statement, index) =>
        index === 1 ? fakeD1Result([{ public_seq: nextSeq }]) : fakeD1Result(),
      );
    },
  } as unknown as Parameters<typeof writeClaim>[0];
  return {
    db,
    armConflict: () => {
      conflictArmed = true;
    },
    persistedOutboxCreatedAt: () => outboxCreatedAt,
  };
}

/**
 * Pure contracts plus narrow test-only statement observers for ingress and retry
 * binding. The real D1 transaction, FTS, trigger, pagination, disconnect, and
 * restart evidence is executed by scripts/e2e-s2-krater.sh.
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
    const firstChain = await eventChainDigest(problemId, 1, firstPayload, genesis);
    const secondChain = await eventChainDigest(problemId, 2, secondPayload, firstChain);
    const first = event(problemId, 1, firstPayload, "1".repeat(64), firstChain);
    const second = event(problemId, 2, secondPayload, "2".repeat(64), secondChain);
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

    await expect(eventChainDigest(input.problemId, max, payload, prior)).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
    await expect(eventRowDigest(input, max, payload)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(checkpointDigest(input.problemId, max, prior)).resolves.toMatch(/^[a-f0-9]{64}$/);
    for (const invalid of [max + 1, 1.5]) {
      await expect(eventChainDigest(input.problemId, invalid, payload, prior)).rejects.toThrow(
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
