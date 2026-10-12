import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { type HypothesisDecoders, HypothesisReadError, readHypotheses } from "../../src/ledger/hypotheses-read.ts";

// Real SQL and SHA-256; deliberate fixture decoding, not a substitute for
// canonical Zod integration tests. No mutable hypotheses projection exists.
const decoders: HypothesisDecoders = {
  publication(value) {
    return value && typeof value === "object" && "route" in value ? value as never : null;
  },
  kill(value) {
    return value && typeof value === "object" && "hypothesis_id" in value ? value as never : null;
  },
};
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    INSERT INTO problems VALUES('P-DEMO',0,'active',0),('P-OTHER',0,'active',0);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT,
      object_id TEXT, object_version INTEGER, created_at TEXT, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT);
    CREATE INDEX event_object ON events(problem_id,object_kind,object_id,seq);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, version INTEGER, visibility TEXT);`);
  let batches = 0, statements = 0, rows = 0;
  const db = {
    prepare: (query: string) => ({ bind: (...values: unknown[]) => ({
      all: () => {
        statements++;
        const result = sql.prepare(query).all(...values as never[]);
        rows += result.length;
        return { results: result, success: true, meta: {} };
      },
    }) }),
    batch: async (prepared: { all(): unknown }[]) => {
      batches++;
      sql.exec("BEGIN");
      try { const results = prepared.map((s) => s.all()); sql.exec("COMMIT"); return results; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  function event(seq: number, id = `H-${seq}`, type = "hypothesis.created", pid = "P-DEMO", overrides = {}) {
    const payload = type === "hypothesis.created"
      ? { route: `Route ${id}`, mechanism: "Independent construction", falsifier: "Finite witness",
          origin: "proposed", expected_evidence: null, discriminating_predictions: [], body_md: `Body ${id}`, ...overrides }
      : { hypothesis_id: id, killed_by_evidence_id: "E-1", reason: "An observed witness defeats this route", ...overrides };
    const text = JSON.stringify(payload);
    const hash = createHash("sha256").update(text).digest("hex");
    const eid = `${pid}-${seq}`;
    sql.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(eid,pid,seq,type,"hypothesis",id,1,
      "2026-09-01T00:00:00.000Z",hash,"F-ORIGINAL","SP-ORIGINAL","S-ORIGINAL","declared-model","declared-harness");
    sql.prepare("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eid,hash,text);
    sql.prepare("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq,pid);
    return eid;
  }
  return { sql, event, db, counts: () => ({ batches, statements, rows }),
    read: (target = "H-1", query = {}, pid = "P-DEMO") => readHypotheses(db,pid,query,decoders,{target}),
    list: (query = {}) => readHypotheses(db,"P-DEMO",query,decoders) };
}
function check(name: string, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  test(name, async () => { const f=fixture(); try { await run(f); } finally { f.sql.close(); } });
}
check("exact reads find an admission beyond the old 2048-record search ceiling in one bounded batch", async f => {
  for(let n=1;n<=2500;n++) f.event(n);
  // Unrelated malformed history no longer sabotages an exact target lookup.
  f.sql.exec("UPDATE events SET created_at='bad' WHERE seq=1");
  const result=await f.read("H-2500");
  assert.equal(result?.face.hypotheses[0]?.content?.route,"Route H-2500");
  assert.equal(result?.face.next_after,null);
  assert.equal(result?.face.after,0);
  assert.deepEqual(f.counts(),{batches:1,statements:2,rows:2});
});
check("the item matches the same list entry, including immutable attribution", async f => {
  f.event(1); f.event(2,"H-2");
  const list=await f.list(), item=await f.read();
  assert.deepEqual(item?.face.hypotheses[0],list?.face.hypotheses[0]);
  assert.equal(item?.face.hypotheses[0]?.publication.sponsor_id,"SP-ORIGINAL");
});
check("a historical item preserves active status before its later recorded elimination", async f => {
  f.event(1); f.event(2,"H-1","hypothesis.killed");
  assert.equal((await f.read("H-1",{through:1}))?.face.hypotheses[0]?.status,"active");
  assert.equal((await f.read())?.face.hypotheses[0]?.status,"killed");
});
check("no admission before the requested cursor is missing, not a later head", async f => {
  f.event(2);
  assert.equal(await f.read("H-2",{through:1}),null);
});
check("future cursor is refused even when the target is absent", async f => {
  f.event(1);
  await assert.rejects(f.read("H-9",{through:2}),{code:"CURSOR_INVALID"});
});
check("same hypothesis ID on another problem never substitutes", async f => {
  f.event(1,"H-1","hypothesis.created","P-OTHER");
  assert.equal(await f.read(),null);
  assert.equal((await f.read("H-1",{},"P-OTHER"))?.face.problem_id,"P-OTHER");
});
for(const status of ["private-draft"]) check(`${status} is never a public exact item`,async f=>{
  f.event(1);f.sql.prepare("UPDATE problems SET status=? WHERE id='P-DEMO'").run(status);
  assert.equal(await f.read(),null);
});
check("unlisted known-URL items remain readable and marked unlisted",async f=>{
  f.event(1);f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'");
  assert.equal((await f.read())?.unlisted,true);
});
for(const target of ["H-1","problem"]) check(`current ${target} hide overrides a historical cut and later restore preserves the publication`,async f=>{
  f.event(1);const before=await f.read();
  f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(target);
  assert.equal(await f.read("H-1",{through:1}),null);
  f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(target);
  assert.deepEqual(await f.read(),before);
});
check("a foreign or unrelated content control does not hide this item",async f=>{
  f.event(1);f.sql.exec("INSERT INTO content_controls VALUES('P-OTHER','H-1',1,'hidden'),('P-DEMO','H-2',1,'hidden')");
  assert.ok(await f.read());
});
check("redacted publication is an explicitly unavailable record without its body",async f=>{
  f.event(1);f.sql.exec("UPDATE event_content SET redacted_at='now'");
  const result=await f.read();
  assert.equal(result?.face.hypotheses[0]?.content,null);
  assert.deepEqual(result?.face.omitted,["content_unavailable"]);
  assert.equal(JSON.stringify(result).includes("Body H-1"),false);
});
check("body tampering with a retained matching digest column is detected by actual hashing",async f=>{
  f.event(1);f.sql.exec("UPDATE event_content SET payload_json='{\"route\":\"forged body\"}'");
  assert.equal((await f.read())?.face.hypotheses[0]?.content,null);
});
check("a mismatched content digest cannot serve source text",async f=>{
  f.event(1);f.sql.exec("UPDATE event_content SET payload_sha256='bad'");
  assert.equal((await f.read())?.face.hypotheses[0]?.content,null);
});
check("missing content does not invent an empty scientific body",async f=>{
  f.event(1);f.sql.exec("UPDATE event_content SET payload_json=NULL");
  assert.equal((await f.read())?.face.hypotheses[0]?.content,null);
});
check("duplicate admissions mark lifecycle unavailable rather than choosing one as truth",async f=>{
  f.event(1);f.event(2,"H-1");
  const r=await f.read();assert.equal(r?.face.hypotheses[0]?.status,"unavailable");
  assert.ok(r?.face.omitted.includes("lifecycle_unavailable"));
});
check("unknown lifecycle events are not silently reinterpreted as active",async f=>{
  f.event(1);f.event(2,"H-1","hypothesis.unknown");
  assert.equal((await f.read())?.face.hypotheses[0]?.status,"unavailable");
});
check("an elimination payload for a different hypothesis cannot settle the target",async f=>{
  f.event(1);f.event(2,"H-1","hypothesis.killed","P-DEMO",{hypothesis_id:"H-2"});
  const r=await f.read();assert.equal(r?.face.hypotheses[0]?.status,"unavailable");
  assert.equal(r?.face.hypotheses[0]?.kill,null);
});
check("list lookahead and continuation remain admission-ordered",async f=>{
  for(let n=1;n<=10;n++)f.event(n);
  const page=await f.list();assert.equal(page?.face.next_after,8);
  assert.deepEqual((await f.list({after:8,through:10}))?.face.hypotheses.map(h=>h.hypothesis_id),["H-9","H-10"]);
});
check("a later append never changes an earlier exact item",async f=>{
  f.event(1);const before=await f.read("H-1",{through:1});f.event(2,"H-2");
  assert.deepEqual(await f.read("H-1",{through:1}),before);
});
check("legacy lowercase hexadecimal hypothesis identities remain addressable",async f=>{
  const id=`H-${"abcdef01".repeat(8)}`;f.event(1,id);
  assert.equal((await f.read(id))?.face.hypotheses[0]?.hypothesis_id,id);
});
for(const target of ["H-nope","H-1\n","H-1/other",""]) check(`invalid target ${JSON.stringify(target)} is refused before database work`,async f=>{
  await assert.rejects(f.read(target),HypothesisReadError);
  assert.deepEqual(f.counts(),{batches:0,statements:0,rows:0});
});
for(const query of [{after:0},{after:1},{through:-1},{through:1.5},{through:Number.MAX_SAFE_INTEGER+1}]) check(`exact query ${JSON.stringify(query)} is refused before database work`,async f=>{
  await assert.rejects(f.read("H-1",query),HypothesisReadError);
  assert.equal(f.counts().batches,0);
});
