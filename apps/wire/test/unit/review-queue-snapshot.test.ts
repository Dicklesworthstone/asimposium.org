import { test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import { readReviewAdmissions } from "../../src/discovery/review-queue-admissions";
import { reviewQueueAfter } from "@asimposium/contracts/review-queue";

/** Real SQLite execution of the shared admission SQL. This is not a complete
 * D1/application or scientific-evaluator fixture. */
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_kind TEXT,
      type TEXT, object_id TEXT, object_version INTEGER, created_at TEXT, UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_json TEXT);
    INSERT INTO problems VALUES('P-DEMO',0,'active',0),('P-OTHER',0,'active',0);`);
  let prepares = 0;
  class Statement {
    bindings: (string | number | null)[] = [];
    constructor(readonly sql: string) {}
    bind(...values: (string | number | null)[]) { this.bindings = values; return this; }
    rows() { return sqlite.query(this.sql).all(...this.bindings); }
    async all() { return { results: this.rows() }; }
  }
  const db = {
    prepare(sql: string) { prepares++; return new Statement(sql); },
    async batch(statements: Statement[]) {
      return sqlite.transaction(() => statements.map(statement => ({ results: statement.rows() })))();
    },
  } as unknown as D1Database;
  const at = (seq: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString();
  function add(seq: number, options: { problem?: string; claim?: string; version?: number; at?: string; body?: string; publish?: boolean } = {}) {
    const problem = options.problem ?? "P-DEMO", version = options.version ?? 1;
    const id = `${problem}-EV-${String(seq).padStart(4,"0")}`;
    sqlite.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(id,problem,seq,"claim",
      version === 1 ? "claim.created" : "claim.revised",options.claim ?? `C-${seq}`,version,options.at ?? at(seq));
    sqlite.query("INSERT INTO event_content VALUES(?,?)").run(id,options.body ?? "{}");
    if (options.publish !== false) sqlite.query("UPDATE problems SET public_seq = MAX(public_seq,?) WHERE id = ?").run(seq,problem);
    return id;
  }
  return { sqlite, db, add, at, prepares: () => prepares,
    read: (through: number, after?: string) => readReviewAdmissions(db,
      { problem: "P-DEMO", ...(after === undefined ? {} : { after }) },
      { problemId: "P-DEMO", through }) };
}

test("a captured queue keeps the earlier head instead of borrowing a later revision", async () => {
  const f = fixture(); try {
    f.add(1, { claim:"C-1" }); f.add(2); f.add(3, { claim:"C-1",version:2 });
    const old = await f.read(2);
    assert.deepEqual(old.map(r=>[r.claim_id,r.version,r.cursor,r.scope_events]), [["C-1",1,2,2],["C-2",1,2,2]]);
    const live = await readReviewAdmissions(f.db,{problem:"P-DEMO"});
    assert.equal(live[0]?.version,2); assert.equal(live[0]?.cursor,3);
  } finally { f.sqlite.close(); }
});

test("pagination retains the same cut across new admissions and revisions", async () => {
  const f = fixture(); try {
    for(let seq=1;seq<=12;seq++) f.add(seq);
    const first = await f.read(12); assert.equal(first.length,9);
    const eighth = first[7]!; const after=reviewQueueAfter(eighth.created_at,eighth.admission_id);
    f.add(13, { at:f.at(9) }); f.add(14,{claim:"C-10",version:2});
    const second=await f.read(12,after);
    assert.deepEqual(second.map(r=>r.claim_id),["C-9","C-10","C-11","C-12"]);
    assert.ok(second.every(r=>r.cursor===12 && r.version===1 && r.scope_events===12));
    const current=await readReviewAdmissions(f.db,{problem:"P-DEMO",after});
    assert.ok(current.some(r=>r.claim_id==="C-13"));
    assert.equal(current.find(r=>r.claim_id==="C-10")?.version,2);
  } finally { f.sqlite.close(); }
});

test("scope byte and event budgets count the captured ledger, not later traffic", async () => {
  const f = fixture(); try {
    f.add(1,{body:"é"});
    for(let seq=2;seq<=514;seq++) f.add(seq,{body:"x".repeat(2200)});
    const frozen=await f.read(1);
    assert.equal(frozen[0]?.scope_events,1); assert.equal(frozen[0]?.scope_bytes,2);
    const live=await readReviewAdmissions(f.db,{problem:"P-DEMO"});
    assert.equal(live[0]?.scope_events,513); assert.ok(live[0]!.scope_bytes>1024*1024);
  } finally { f.sqlite.close(); }
});

for(const posture of ["private-draft","resolved","retired","archived","unlisted"]) {
  test(`present-day ${posture} prevents a frozen recommendation read`, async () => {
    const f=fixture(); try {
      f.add(1); assert.equal((await f.read(1)).length,1);
      if(posture==="unlisted")f.sqlite.query("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'").run();
      else f.sqlite.query("UPDATE problems SET status=? WHERE id='P-DEMO'").run(posture);
      await assert.rejects(f.read(1),/REVIEW_QUEUE_SNAPSHOT_UNAVAILABLE/);
    } finally {f.sqlite.close();}
  });
}

test("future and missing snapshots are not reported as empty scientific queues", async () => {
  const f=fixture(); try {
    f.add(1); await assert.rejects(f.read(2),/SNAPSHOT_UNAVAILABLE/);
    await assert.rejects(readReviewAdmissions(f.db,{problem:"P-MISSING"},{problemId:"P-MISSING",through:0}),/SNAPSHOT_UNAVAILABLE/);
  } finally {f.sqlite.close();}
});

test("zero is a valid captured empty baseline; unpublished envelopes stay out", async () => {
  const f=fixture(); try {
    f.add(1,{publish:false}); assert.deepEqual(await f.read(0),[]);
    await assert.rejects(f.read(1),/SNAPSHOT_UNAVAILABLE/);
  } finally {f.sqlite.close();}
});

test("invalid cuts and cross-problem snapshots fail before any database access", async () => {
  const f=fixture(); try {
    for(const through of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(f.read(through),/SNAPSHOT_INVALID/);
    await assert.rejects(readReviewAdmissions(f.db,{problem:"P-OTHER"},{problemId:"P-DEMO",through:0}),/SNAPSHOT_INVALID/);
    await assert.rejects(readReviewAdmissions(f.db,{}, {problemId:"P-DEMO",through:0}),/SNAPSHOT_INVALID/);
    assert.equal(f.prepares(),0);
  } finally {f.sqlite.close();}
});

test("same local claim IDs cannot cross problem boundaries", async () => {
  const f=fixture(); try {
    f.add(1,{claim:"C-1"}); f.add(1,{problem:"P-OTHER",claim:"C-1"});
    f.add(2,{problem:"P-OTHER",claim:"C-1",version:2});
    const rows=await f.read(1); assert.equal(rows.length,1);
    assert.equal(rows[0]?.problem_id,"P-DEMO"); assert.equal(rows[0]?.version,1);
  } finally {f.sqlite.close();}
});

test("unavailable bodies remain admissions rather than changing page traversal", async () => {
  const f=fixture(); try {
    for(let seq=1;seq<=10;seq++)f.add(seq);
    f.sqlite.query("UPDATE event_content SET payload_json=NULL").run();
    const rows=await f.read(10); assert.equal(rows.length,9);
    assert.equal(rows[0]?.scope_events,10); assert.equal(rows[0]?.scope_bytes,0);
    const eighth=rows[7]!;
    assert.deepEqual((await f.read(10,reviewQueueAfter(eighth.created_at,eighth.admission_id))).map(r=>r.claim_id),["C-9","C-10"]);
  } finally {f.sqlite.close();}
});

test("public discovery still serves different per-problem live cuts", async () => {
  const f=fixture(); try {
    f.add(1); f.add(2); f.add(1,{problem:"P-OTHER"});
    const rows=await readReviewAdmissions(f.db,{});
    assert.ok(rows.some(r=>r.problem_id==="P-DEMO" && r.cursor===2));
    assert.ok(rows.some(r=>r.problem_id==="P-OTHER" && r.cursor===1));
  } finally {f.sqlite.close();}
});
