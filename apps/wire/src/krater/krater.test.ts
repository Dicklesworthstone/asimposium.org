import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  cursorMatchesEvents,
  deterministicWorkload,
  eventChainDigest,
  eventChainMatches,
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
  validateFtsReadInput,
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

/**
 * Pure contract checks only. The real D1 transaction, FTS, trigger, pagination,
 * disconnect, and restart evidence is executed by scripts/e2e-s2-krater.sh.
 * No D1-shaped substitute is constructed here.
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
