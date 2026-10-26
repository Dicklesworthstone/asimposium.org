import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";
import type { GapFileRequest, GapTransitionRequest } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  composeProofGapSnapshot, prepareProofGapSnapshot, readProofGaps,
  type ProofGapDecoders,
} from "../../src/ledger/proof-gaps-read.ts";

// Decoder seams are intentional: these tests exercise the canonical SQL,
// cryptographic/lifecycle composer and transaction composition, not Zod.
const decoders: ProofGapDecoders = {
  filed(value) {
    const v = value as GapFileRequest;
    return v && typeof v.obligation === "string" && typeof v.target_claim_id === "string"
      && Number.isSafeInteger(v.target_version) && v.target_version > 0 ? v : null;
  },
  settled(value) {
    const v = value as GapTransitionRequest;
    return v && typeof v.gap_id === "string" && ["closed-by", "withdrawn"].includes(v.outcome)
      ? v : null;
  },
};
const hash = async (body: string) => [...new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(body),
))].map(b => b.toString(16).padStart(2, "0")).join("");
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, unlisted INTEGER, status TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_kind TEXT,
      object_id TEXT, object_version INTEGER, type TEXT, payload_sha256 TEXT, created_at TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE leases (problem_id TEXT, object_id TEXT, object_ref TEXT, status TEXT, leased_until TEXT);
    INSERT INTO problems VALUES ('P-TEST', 0, 0, 'active'), ('P-OTHER', 0, 0, 'active');
  `);
  let sequence = 0;
  const prepared = new WeakMap<object, () => unknown[]>();
  const batches: number[] = [];
  const d1 = {
    prepare(sql: string) { return { bind(...values: (string | number | null)[]) {
      const run = () => db.prepare(sql).all(...values);
      const statement = { all: async () => ({ results: run() }), first: async () => run()[0] ?? null };
      prepared.set(statement, run); return statement;
    } }; },
    async batch(statements: D1PreparedStatement[]) {
      batches.push(statements.length); db.exec("BEGIN");
      try {
        const result = statements.map(s => ({ results: prepared.get(s)!() }));
        db.exec("COMMIT"); return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  const add = async (type: string, gap: string | null, payload: object, problem = "P-TEST") => {
    const seq = ++sequence, id = `EV-${seq}`;
    const gapId = gap ?? `G-${seq}`, body = JSON.stringify(payload), digest = await hash(body);
    db.prepare(`INSERT INTO events VALUES (?, ?, ?, 'gap', ?, 1, ?, ?, '2026-10-01T00:00:00.000Z',
      'F-A', 'SP-A', 'S-A', 'self-declared-family', 'self-declared-harness')`)
      .run(id, problem, seq, gapId, type, digest);
    db.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, digest, body);
    db.prepare("UPDATE problems SET public_seq=? WHERE id=?").run(seq, problem);
    return { gapId, id, seq };
  };
  const file = (claim = "C-1", version = 1, problem = "P-TEST") => add("gap.filed", null, {
    target_claim_id: claim, target_version: version, obligation: "Establish the missing compactness step.",
    closes_what: "The limit passage in the stated argument.",
  }, problem);
  const settle = (gap: string, outcome = "closed-by") => add(`gap.${outcome}`, gap,
    { gap_id: gap, outcome, closed_by: outcome === "closed-by" ? "C-9@1" : null });
  const read = (through = sequence) => readProofGaps(d1, "P-TEST", { through }, decoders);
  const snapshot = async (through = sequence) => {
    const query = { through };
    const batch = await d1.batch(prepareProofGapSnapshot(d1, "P-TEST", query));
    return composeProofGapSnapshot(batch, "P-TEST", query, decoders);
  };
  return { db, d1, file, settle, add, read, snapshot, batches, cut: () => sequence };
}

test("prepared snapshots and the ordinary gap read share the exact lifecycle", async () => {
  const f = fixture(); const gap = await f.file(); await f.settle(gap.gapId);
  assert.deepEqual(await f.snapshot(), await f.read());
  assert.equal((await f.snapshot()).face.gaps[0]?.status, "closed-by");
  assert.equal((await f.snapshot(gap.seq)).face.gaps[0]?.status, "open");
});

test("gap reads compose inside a caller's existing transaction with no preliminary read", async () => {
  const f = fixture(); await f.file();
  const result = await f.d1.batch([
    f.d1.prepare("SELECT public_seq AS cursor FROM problems WHERE id=?").bind("P-TEST"),
    ...prepareProofGapSnapshot(f.d1, "P-TEST", { through: 1 }),
  ]);
  const page = await composeProofGapSnapshot(result.slice(1), "P-TEST", { through: 1 }, decoders);
  assert.deepEqual(f.batches, [3]);
  assert.equal(page.face.cursor, (result[0]!.results[0] as { cursor: number }).cursor);
  assert.equal(page.face.gaps.length, 1);
});

for (const outcome of ["closed-by", "withdrawn"]) {
  for (const failure of ["redacted", "missing", "digest-detached", "corrupt", "hidden"]) {
    test(`${failure} ${outcome} evidence does not settle a proof obligation`, async () => {
      const f = fixture(), gap = await f.file(), end = await f.settle(gap.gapId, outcome);
      if (failure === "redacted") f.db.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(end.id);
      if (failure === "missing") f.db.prepare("DELETE FROM event_content WHERE event_id=?").run(end.id);
      if (failure === "digest-detached") f.db.prepare("UPDATE event_content SET payload_sha256='detached' WHERE event_id=?").run(end.id);
      if (failure === "corrupt") f.db.prepare("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(end.id);
      if (failure === "hidden") f.db.prepare("INSERT INTO content_controls VALUES ('P-TEST', ?, 'hidden', 1)").run(`#${end.seq}`);
      const page = (await f.snapshot()).face;
      assert.equal(page.gaps[0]?.status, "unavailable");
      assert.equal(page.gaps[0]?.closed_by, null);
      assert.ok(page.omitted.includes("content_unavailable"));
      assert.ok(page.omitted.includes("history_unavailable"));
      assert.equal((await f.snapshot(gap.seq)).face.gaps[0]?.status, "open");
    });
  }
}

for (const settled of [false, true]) {
  test(`unreadable filing has no known settlement (${settled})`, async () => {
    const f = fixture(), gap = await f.file(); if (settled) await f.settle(gap.gapId);
    f.db.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(gap.id);
    const result = (await f.snapshot()).face.gaps[0]!;
    assert.equal(result.status, "unavailable"); assert.equal(result.content, null); assert.equal(result.closed_by, null);
  });
}

test("restoration restores original settled history without changing the cursor", async () => {
  const f = fixture(), gap = await f.file(), end = await f.settle(gap.gapId);
  f.db.prepare("INSERT INTO content_controls VALUES ('P-TEST', ?, 'hidden', 1)").run(`#${end.seq}`);
  assert.equal((await f.read()).face.gaps[0]?.status, "unavailable");
  f.db.prepare("INSERT INTO content_controls VALUES ('P-TEST', ?, 'public', 2)").run(`#${end.seq}`);
  const restored = await f.snapshot(); assert.equal(restored.face.gaps[0]?.closed_by, "C-9@1");
  assert.equal(restored.face.cursor, end.seq);
});

test("lookahead is body-free and continuation resumes after examined filings", async () => {
  const f = fixture(); for (let n = 0; n < 10; n++) await f.file();
  const query = { through: f.cut() };
  const raw = await f.d1.batch(prepareProofGapSnapshot(f.d1, "P-TEST", query));
  assert.equal(raw[1]?.results.length, 9);
  const probe = raw[1]!.results[8] as { filed_body: unknown; last_body: unknown };
  assert.equal(probe.filed_body, null); assert.equal(probe.last_body, null);
  const first = await composeProofGapSnapshot(raw, "P-TEST", query, decoders);
  assert.equal(first.face.next_after, 8); assert.equal(first.face.gaps.length, 8);
  const next = { through: f.cut(), after: first.face.next_after! };
  const second = await composeProofGapSnapshot(await f.d1.batch(prepareProofGapSnapshot(f.d1, "P-TEST", next)), "P-TEST", next, decoders);
  assert.deepEqual(second.face.gaps.map(g => g.gap_id), ["G-9", "G-10"]);
  assert.equal(second.face.next_after, null);
});

test("query and privacy failures are never fabricated empty histories", async () => {
  const f = fixture(); await f.file();
  for (const query of [{ through: -1 }, { through: 1, after: 2 }, { through: 1, target: "G-1", after: 0 }])
    assert.throws(() => prepareProofGapSnapshot(f.d1, "P-TEST", query));
  f.db.exec("INSERT INTO content_controls VALUES ('P-TEST', 'problem', 'hidden', 1)");
  await assert.rejects(f.snapshot(), /not-found/);
});

test("foreign filings and settlements never enter this problem's cut", async () => {
  const f = fixture(); await f.file(); await f.file("C-1", 1, "P-OTHER");
  const page = await f.snapshot(1);
  assert.deepEqual(page.face.gaps.map(g => g.gap_id), ["G-1"]);
});

test("inconsistent result shape, reordered history and ambiguous lifecycle fail closed", async () => {
  const f = fixture(), gap = await f.file(); await f.file();
  const query = { through: f.cut() }, rows = await f.d1.batch(prepareProofGapSnapshot(f.d1, "P-TEST", query));
  await assert.rejects(composeProofGapSnapshot(rows.slice(1), "P-TEST", query, decoders));
  const backwards = [{ results: rows[0]!.results }, { results: [...rows[1]!.results].reverse() }];
  await assert.rejects(composeProofGapSnapshot(backwards, "P-TEST", query, decoders));
  await f.settle(gap.gapId); await f.settle(gap.gapId, "withdrawn");
  assert.equal((await f.snapshot()).face.gaps[0]?.status, "unavailable");
});

test("a visible empty problem still has an honest empty snapshot", async () => {
  const f = fixture(), page = await f.snapshot();
  assert.deepEqual(page.face.gaps, []); assert.deepEqual(page.face.omitted, []);
  assert.equal(page.face.cursor, 0);
});
