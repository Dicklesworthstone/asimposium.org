import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import { readAllCheckpointSignatures, readCheckpointSignatures } from "../../src/krater/checkpoint-face.ts";

/** Real query execution; signatures are shape-correct recorded-data fixtures,
 * not evidence of cryptographic signing or an actual D1/Hono deployment. */
function fixture(count: number) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE checkpoint_chain_v2(problem_id TEXT,checkpoint_seq INTEGER,root_chain_digest TEXT,checkpoint_digest TEXT,
      PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE checkpoint_signatures(problem_id TEXT,checkpoint_seq INTEGER,key_id TEXT,signature TEXT,signed_at TEXT,
      PRIMARY KEY(problem_id,checkpoint_seq,key_id));
    INSERT INTO problems VALUES('P-DEMO','active');`);
  function sign(seq: number, key = "key-a") {
    sql.query("INSERT INTO checkpoint_signatures VALUES('P-DEMO',?,?,?,'2026-10-01T00:00:00.000Z')")
      .run(seq, key, "c".repeat(128));
  }
  function checkpoint(seq: number, signed = true) {
    sql.query("INSERT INTO checkpoint_chain_v2 VALUES('P-DEMO',?,?,?)")
      .run(seq, "a".repeat(64), "b".repeat(64));
    if (signed) sign(seq);
  }
  for (let seq = 1; seq <= count; seq++) checkpoint(seq);
  const calls: string[] = [];
  const db = { prepare(query: string) { return { bind(...values: (string | number | null)[]) {
    const read = () => { calls.push(query); return sql.query(query).all(...values); };
    return { all: async () => ({ results: read() }), first: async () => read()[0] ?? null };
  } }; } } as unknown as D1Database;
  return { sql, db, calls, checkpoint, sign };
}

test("a 600-checkpoint backup can read a bounded terminal anchor without an oversized face", async () => {
  const f = fixture(600);
  try {
    const face = await readCheckpointSignatures(f.db, undefined, "P-DEMO", 599, 600);
    assert.deepEqual(face?.signatures.map((s) => s.checkpoint_seq), [600]);
    assert.equal(face?.next_after, null);
    assert.equal(face?.unsigned, 0);
  } finally { f.sql.close(); }
});

test("every rotated key at the terminal checkpoint is retained", async () => {
  const f = fixture(600);
  try {
    f.sign(600, "key-b"); f.sign(600, "key-c");
    const face = await readCheckpointSignatures(f.db, undefined, "P-DEMO", 599, 600);
    assert.deepEqual(face?.signatures.map((s) => s.key_id), ["key-a", "key-b", "key-c"]);
    assert.equal(face?.next_after, null);
  } finally { f.sql.close(); }
});

test("newer signed and unsigned checkpoints are excluded from a captured backup cut", async () => {
  const f = fixture(2);
  try {
    f.checkpoint(3, false); f.checkpoint(4); f.checkpoint(5, false);
    const face = await readCheckpointSignatures(f.db, undefined, "P-DEMO", 0, 3);
    assert.deepEqual(face?.signatures.map((s) => s.checkpoint_seq), [1, 2]);
    assert.equal(face?.unsigned, 1);
    assert.equal(face?.next_after, null);
    const empty = await readCheckpointSignatures(f.db, undefined, "P-DEMO", 0, 0);
    assert.deepEqual(empty?.signatures, []);
    assert.equal(empty?.unsigned, 0);
  } finally { f.sql.close(); }
});

test("all-page reads carry the same internal cut", async () => {
  const f = fixture(600);
  try {
    const face = await readAllCheckpointSignatures(f.db, undefined, "P-DEMO", 100);
    assert.equal(face?.signatures.length, 100);
    assert.equal(face?.next_after, null);
  } finally { f.sql.close(); }
});

test("a page boundary cannot discard the second key of a rotated checkpoint", async () => {
  const f = fixture(501);
  try {
    f.sign(500, "key-b");
    const first = await readCheckpointSignatures(f.db, undefined, "P-DEMO", 0);
    assert.equal(first?.signatures.length, 499);
    assert.equal(first?.next_after, 499);
    const second = await readCheckpointSignatures(f.db, undefined, "P-DEMO", first!.next_after!);
    assert.deepEqual(second?.signatures.map((s) => [s.checkpoint_seq, s.key_id]),
      [[500, "key-a"], [500, "key-b"], [501, "key-a"]]);
    assert.equal(second?.next_after, null);
  } finally { f.sql.close(); }
});

test("ordinary pages keep their 500-signature bound and forward cursor", async () => {
  const f = fixture(501);
  try {
    const first = await readCheckpointSignatures(f.db, undefined, "P-DEMO", 0);
    assert.equal(first?.signatures.length, 500);
    assert.equal(first?.next_after, 500);
    const second = await readCheckpointSignatures(f.db, undefined, "P-DEMO", 500);
    assert.deepEqual(second?.signatures.map((s) => s.checkpoint_seq), [501]);
  } finally { f.sql.close(); }
});

test("an unpageable single-checkpoint key set fails rather than dropping signatures or looping", async () => {
  const f = fixture(1);
  try {
    for (let key = 0; key < 500; key++) f.sign(1, `extra-${key}`);
    await assert.rejects(readCheckpointSignatures(f.db, undefined, "P-DEMO", 0), /PAGE_OVERFLOW/);
  } finally { f.sql.close(); }
});

for (const through of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
  test(`invalid cut ${through} refuses before a database read`, async () => {
    const f = fixture(1);
    try {
      await assert.rejects(readCheckpointSignatures(f.db, undefined, "P-DEMO", 0, through), /CUT_INVALID/);
      assert.equal(f.calls.length, 0);
    } finally { f.sql.close(); }
  });

for (const state of ["missing", "private"])
  test(`${state} problems do not expose a backup signature face`, async () => {
    const f = fixture(1);
    try {
      f.sql.exec(state === "missing" ? "DELETE FROM problems" : "UPDATE problems SET status='private-draft'");
      assert.equal(await readCheckpointSignatures(f.db, undefined, "P-DEMO", 0, 1), null);
      assert.equal(f.calls.length, 1);
    } finally { f.sql.close(); }
  });
