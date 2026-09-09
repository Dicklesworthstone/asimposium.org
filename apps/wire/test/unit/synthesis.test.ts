import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import {
  computeDroppedSingleAuthorCount,
  type SynthesisAnchorInput,
  validateSynthesisAnchors,
} from "../../src/ledger/synthesis.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

function createTestDb(): D1Database {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  const prepare = (query: string) => {
    const methods = (...values: unknown[]) => ({
      async run() {
        const statement = sqlite.prepare(query);
        if (/^\s*SELECT\b/i.test(query)) {
          const rows = statement.all(...(values as any[]));
          return { results: rows, meta: { changes: 0 } };
        }
        const result = statement.run(...(values as any[]));
        return { results: [], meta: { changes: result.changes } };
      },
      async first<T>(): Promise<T | null> {
        const row = (sqlite.prepare(query) as any).get(...(values as any[]));
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const rows = (sqlite.prepare(query) as any).all(...(values as any[])) as T[];
        return { results: rows };
      },
    });
    return {
      bind: methods,
      ...methods(),
    };
  };

  return {
    prepare,
  } as unknown as D1Database;
}

const DUMMY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function createProblem(db: D1Database, problemId: string, now: string) {
  await db
    .prepare(
      "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_version, chain_digest) VALUES (?, 0, ?, ?, 2, 'genesis')",
    )
    .bind(problemId, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
    )
    .bind(problemId, now)
    .run();
}

async function insertEvent(
  db: D1Database,
  problemId: string,
  seq: number,
  id: string,
  type: string,
  objectKind: string,
  objectId: string,
  objectVersion: number,
  actorFellowId: string,
  now: string,
) {
  const digest = `chain-digest-${problemId}-${seq}`;
  const rowDigest = `row-digest-${problemId}-${seq}`;
  await db
    .prepare("UPDATE problems SET public_seq = ?, chain_digest = ?, chain_version = 2 WHERE id = ?")
    .bind(seq, digest, problemId)
    .run();
  await db
    .prepare(
      `INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at, actor_fellow_id, row_digest, chain_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      problemId,
      seq,
      type,
      objectKind,
      objectId,
      objectVersion,
      DUMMY_SHA,
      now,
      actorFellowId,
      rowDigest,
      digest,
    )
    .run();
}

describe("W5.8b Synthesis anchor validation (Rule P13)", () => {
  test("accepts anchors grounded in ledger events at or before covers_through", async () => {
    const db = createTestDb();
    const problemId = "P-SYNTH-TEST";
    const now = new Date().toISOString();

    await createProblem(db, problemId, now);

    // Event 1: problem statement
    await insertEvent(
      db,
      problemId,
      1,
      "E-1",
      "problem.created",
      "problem",
      problemId,
      1,
      "F-0",
      now,
    );

    // Event 2: claim C-1@1
    await insertEvent(db, problemId, 2, "E-2", "claim.promoted", "claim", "C-1", 1, "F-1", now);

    // Event 3: evidence E-1
    await insertEvent(
      db,
      problemId,
      3,
      "E-3",
      "evidence.created",
      "evidence",
      "E-1",
      1,
      "F-1",
      now,
    );

    const anchors: SynthesisAnchorInput[] = [
      { target_kind: "claim", target_id: "C-1", target_version: 1 },
      { target_kind: "evidence", target_id: "E-1" },
    ];

    const result = await validateSynthesisAnchors(db, problemId, 3, anchors);
    expect(result.valid).toBe(true);
    expect(result.unanchored).toEqual([]);
    expect(result.maxLedgerSeq).toBe(3);
  });

  test("P13: flags missing objects as unanchored", async () => {
    const db = createTestDb();
    const problemId = "P-SYNTH-MISSING";
    const now = new Date().toISOString();

    await createProblem(db, problemId, now);
    await insertEvent(
      db,
      problemId,
      1,
      "E-1",
      "problem.created",
      "problem",
      problemId,
      1,
      "F-0",
      now,
    );

    const anchors: SynthesisAnchorInput[] = [
      { target_kind: "claim", target_id: "C-GHOST", target_version: 1 },
      { target_kind: "hypothesis", target_id: "H-NONEXISTENT" },
    ];

    const result = await validateSynthesisAnchors(db, problemId, 1, anchors);
    expect(result.valid).toBe(false);
    expect(result.unanchored).toContain("C-GHOST");
    expect(result.unanchored).toContain("H-NONEXISTENT");
  });

  test("P13: flags objects created after covers_through as unanchored", async () => {
    const db = createTestDb();
    const problemId = "P-SYNTH-FUTURE";
    const now = new Date().toISOString();

    await createProblem(db, problemId, now);

    // Contiguous events 1..5
    await insertEvent(
      db,
      problemId,
      1,
      "E-1",
      "problem.created",
      "problem",
      problemId,
      1,
      "F-0",
      now,
    );
    await insertEvent(db, problemId, 2, "E-2", "claim.promoted", "claim", "C-OLD", 1, "F-1", now);
    await insertEvent(
      db,
      problemId,
      3,
      "E-3",
      "evidence.created",
      "evidence",
      "EV-1",
      1,
      "F-1",
      now,
    );
    await insertEvent(db, problemId, 4, "E-4", "review.created", "review", "R-1", 1, "F-2", now);
    await insertEvent(db, problemId, 5, "E-5", "claim.promoted", "claim", "C-LATE", 1, "F-1", now);

    // covers_through is 3, but claim was created at seq 5
    const anchors: SynthesisAnchorInput[] = [
      { target_kind: "claim", target_id: "C-LATE", target_version: 1 },
    ];

    const result = await validateSynthesisAnchors(db, problemId, 3, anchors);
    expect(result.valid).toBe(false);
    expect(result.unanchored).toContain("C-LATE");
  });

  test("refuses covers_through exceeding the problem's current max seq", async () => {
    const db = createTestDb();
    const problemId = "P-SYNTH-CURSOR";
    const now = new Date().toISOString();

    await createProblem(db, problemId, now);

    await insertEvent(
      db,
      problemId,
      1,
      "E-1",
      "problem.created",
      "problem",
      problemId,
      1,
      "F-0",
      now,
    );

    const result = await validateSynthesisAnchors(db, problemId, 100, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("exceeds highest recorded problem sequence");
  });

  test("calculates dropped single-author finding count", async () => {
    const db = createTestDb();
    const problemId = "P-SYNTH-SINGLE-AUTHOR";
    const now = new Date().toISOString();

    await createProblem(db, problemId, now);

    // Event 1: Claim C-1 authored by F-1
    await insertEvent(db, problemId, 1, "E-1", "claim.promoted", "claim", "C-1", 1, "F-1", now);

    // Event 2: Review R-1 on C-1 by F-2 (external reviewer)
    await insertEvent(db, problemId, 2, "E-2", "review.created", "review", "R-1", 1, "F-2", now);
    await db
      .prepare(
        `INSERT INTO reviews (review_id, problem_id, target_claim_id, target_version, reviewer_fellow_id, tier, verdict, basis, body_md, created_at, source_event_id, source_seq)
         VALUES ('R-1', ?, 'C-1', 1, 'F-2', 'T1', 'confirm', 'Checked.', 'Good.', ?, 'E-2', 2)`,
      )
      .bind(problemId, now)
      .run();

    // Event 3: Claim C-2 authored by F-3, NO other review or citation
    await insertEvent(db, problemId, 3, "E-3", "claim.promoted", "claim", "C-2", 1, "F-3", now);

    // If anchors include only C-1, C-2 is omitted. Since C-2 has no external reviews, it counts as dropped single-author finding.
    const droppedCount = await computeDroppedSingleAuthorCount(db, problemId, 3, new Set(["C-1"]));
    expect(droppedCount).toBe(1);

    // If anchors include both, droppedCount is 0.
    const droppedCountAll = await computeDroppedSingleAuthorCount(
      db,
      problemId,
      3,
      new Set(["C-1", "C-2"]),
    );
    expect(droppedCountAll).toBe(0);
  });

  test("excludes claims referenced in claim_relations by another fellow from single-author count", async () => {
    const db = createTestDb();
    const problemId = "P-SYNTH-RELATIONS";
    const now = new Date().toISOString();

    await createProblem(db, problemId, now);

    // Event 1: Claim C-1 authored by F-1
    await insertEvent(db, problemId, 1, "E-1", "claim.promoted", "claim", "C-1", 1, "F-1", now);

    // Claims table rows for foreign key
    await db
      .prepare(
        `INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
         VALUES ('C-2', ?, 'Claim 2 statement', ?, 99, ?)`,
      )
      .bind(problemId, DUMMY_SHA, now)
      .run();

    // Event 2: Relation asserted by F-2 pointing to C-1@1
    await insertEvent(
      db,
      problemId,
      2,
      "E-2",
      "relation.asserted",
      "relation",
      "rel-1",
      1,
      "F-2",
      now,
    );
    await db
      .prepare(
        `INSERT INTO claim_relations (problem_id, kind, source_claim_id, source_version, target_ref, status, asserted_by_event, asserted_by_fellow, created_at)
         VALUES (?, 'implies', 'C-2', 1, 'C-1@1', 'asserted', 'E-2', 'F-2', ?)`,
      )
      .bind(problemId, now)
      .run();

    // Since F-2 referenced C-1, C-1 is not a single-author finding even if omitted
    const droppedCount = await computeDroppedSingleAuthorCount(db, problemId, 2, new Set());
    expect(droppedCount).toBe(0);
  });
});
