import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { type HypothesisEvidenceIndexDecoders, readHypothesisEvidenceIndex } from "../../src/ledger/hypothesis-evidence-index.ts";

// Deliberate fixture decoders: these tests exercise production SQLite queries,
// cryptographic source binding and pagination, not canonical Zod integration.
const decode: HypothesisEvidenceIndexDecoders = {
  hypothesis(value: any) { return value && typeof value.route === "string" ? value : null; },
  evidence(value: any) { return value && value.bears_on_kind === "hypothesis" && typeof value.body_md === "string" ? value : null; },
  envelope(value: any) { return value && typeof value.event_id === "string" && Number.isSafeInteger(value.seq) && value.seq > 0 && /^[a-f0-9]{64}$/.test(value.payload_sha256) ? value : null; },
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    INSERT INTO problems VALUES('P-DEMO',0,'active',0),('P-OTHER',0,'active',0);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      object_version INTEGER,created_at TEXT,payload_sha256 TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT,
      actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
    CREATE TABLE evidence(evidence_id TEXT,problem_id TEXT,bears_on_kind TEXT,bears_on_id TEXT,bears_on_version INTEGER,
      source_event_id TEXT,source_seq INTEGER,author_fellow_id TEXT);
    CREATE TABLE scientific_withdrawals(problem_id TEXT,event_id TEXT,seq INTEGER,event_sha256 TEXT,retraction_id TEXT,
      target_kind TEXT,target_object TEXT,source_event_id TEXT,source_sha256 TEXT);`);
  let batches=0,statements=0,payloadBytes=0;
  const db={prepare:(query:string)=>({bind:(...args: any[])=>({all:()=>{
    statements++;const rows=sql.prepare(query).all(...args) as any[];
    for(const row of rows)payloadBytes+=new TextEncoder().encode(row.payload_json??"").length;
    return {results:rows,success:true,meta:{}};
  }})}),batch:async(prepared:any[])=>{
    batches++;sql.exec("BEGIN");
    try{const rows=prepared.map(s=>s.all());sql.exec("COMMIT");return rows;}
    catch(error){sql.exec("ROLLBACK");throw error;}
  }} as unknown as D1Database;
  function event(seq:number,id:string,kind:string,payload:unknown,pid="P-DEMO",type=`${kind}.created`) {
    const eid=`${pid}-${seq}`,text=JSON.stringify(payload),hash=sha(text);
    sql.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?)").run(eid,pid,seq,type,kind,id,
      "2026-09-01T00:00:00.000Z",hash,"F-AUTHOR","SP-AUTHOR","S-ORIGINAL","declared model","declared harness");
    sql.prepare("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eid,hash,text);
    sql.prepare("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq,pid);
    return {eid,hash};
  }
  function hypothesis(seq=1,id="H-1",pid="P-DEMO") {return event(seq,id,"hypothesis",{route:"A proposed construction",body_md:"A deliberate work product"},pid);}
  function evidence(seq:number,id=`E-${seq}`,target="H-1",extra={},pid="P-DEMO") {
    const e=event(seq,id,"evidence",{bears_on_kind:"hypothesis",bears_on_id:target,bears_on_version:null,
      direction:"informs",kind:"computation",mode:"exploratory",source:{kind:"model_memory"},
      body_md:"Measured observation",...extra},pid);
    sql.prepare("INSERT INTO evidence VALUES(?,?,'hypothesis',?,NULL,?,?,?)").run(id,pid,target,e.eid,seq,"F-AUTHOR");
    return e;
  }
  function withdraw(seq:number,id:string,source:{eid:string;hash:string},pid="P-DEMO") {
    const e=event(seq,`RET-${seq}`,"retraction",{},pid,"object.retracted");
    sql.prepare("INSERT INTO scientific_withdrawals VALUES(?,?,?,?,?,'evidence',?,?,?)").run(pid,e.eid,seq,e.hash,`RET-${seq}`,id,source.eid,source.hash);
  }
  return {sql,event,hypothesis,evidence,withdraw,
    counts:()=>({batches,statements,payloadBytes}),
    read:(query={},pid="P-DEMO",target="H-1")=>readHypothesisEvidenceIndex(db,pid,target,query,decode)};
}
function check(name:string,run:(f:ReturnType<typeof fixture>)=>Promise<void>) {
  test(name,async()=>{const f=fixture();try{await run(f);}finally{f.sql.close();}});
}
check("one atomic bounded page exposes actual source pins and no scientific body or computed standing",async f=>{
  f.hypothesis();f.evidence(2,"E-2","H-1",{direction:"supports"});f.evidence(3,"E-3","H-1",{direction:"refutes"});
  const r=await f.read();assert.ok(r);
  assert.deepEqual(r.face.evidence.map(x=>x.direction),["supports","refutes"]);
  assert.equal(r.face.evidence[0]?.publication.session_id,"S-ORIGINAL");
  assert.equal(r.face.evidence[0]?.read_url,"/p/P-DEMO/evidence/E-2.json");
  assert.deepEqual(r.face.omitted,["index_scope"]);
  assert.equal(JSON.stringify(r).includes("Measured observation"),false);
  assert.equal(JSON.stringify(r).includes("computed_class"),false);
  assert.equal(f.counts().batches,1);assert.equal(f.counts().statements,2);
});
check("missing and private hypotheses do not expose evidence navigation",async f=>{
  assert.equal(await f.read(),null);f.hypothesis();f.evidence(2);
  f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");assert.equal(await f.read(),null);
});
check("empty valid index is distinct from a missing target",async f=>{
  f.hypothesis();const r=await f.read();assert.ok(r);
  assert.equal(r.face.scanned,0);assert.equal(r.face.scanned_through,0);
  assert.equal(r.face.next_after,null);assert.deepEqual(r.face.evidence,[]);
});
check("same-ID scopes stay isolated",async f=>{
  f.hypothesis();f.hypothesis(1,"H-1","P-OTHER");f.evidence(2,"E-2","H-1",{},"P-OTHER");
  assert.equal((await f.read())?.face.evidence.length,0);
  assert.equal((await f.read({},"P-OTHER"))?.face.evidence.length,1);
});
check("other hypotheses and claim-target evidence are not indexed here",async f=>{
  f.hypothesis();f.hypothesis(2,"H-2");f.evidence(3,"E-3","H-2");f.evidence(4);
  f.sql.exec("UPDATE evidence SET bears_on_kind='claim',bears_on_version=1 WHERE evidence_id='E-4'");
  assert.equal((await f.read())?.face.evidence.length,0);
});
check("a malformed or retargeted index cannot override the source association",async f=>{
  f.hypothesis();f.evidence(2,"E-2","H-2");
  f.sql.exec("UPDATE evidence SET bears_on_id='H-1'");
  const r=await f.read();assert.equal(r?.face.scanned,1);assert.equal(r?.face.evidence.length,0);
  assert.ok(r?.face.omitted.includes("content_unavailable"));
});
check("page continuation advances through unavailable rows and preserves the cut",async f=>{
  f.hypothesis();for(let n=2;n<=12;n++)f.evidence(n);
  f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id<>'P-DEMO-1'");
  const page=await f.read();assert.ok(page);assert.equal(page.face.evidence.length,0);
  assert.equal(page.face.next_after,9);assert.equal(page.face.scanned,8);
  const next=await f.read({through:page.face.cursor,after:page.face.next_after});
  assert.equal(next?.face.scanned,3);assert.equal(next?.face.next_after,null);
});
check("new observations do not enter a continued historical index",async f=>{
  f.hypothesis();for(let n=2;n<=10;n++)f.evidence(n);
  const page=await f.read();assert.ok(page);f.evidence(11);
  const next=await f.read({through:page.face.cursor,after:page.face.next_after});
  assert.deepEqual(next?.face.evidence.map(x=>x.evidence_id),["E-10"]);
  assert.equal(next?.face.cursor,10);
});
check("older reference pages remain byte-identical after later observations",async f=>{
  f.hypothesis();f.evidence(2);const before=await f.read({through:2});f.evidence(3);
  assert.deepEqual(await f.read({through:2}),before);
});
check("withdrawn evidence remains discoverable without retroactively changing older snapshots",async f=>{
  f.hypothesis();const e=f.evidence(2);f.withdraw(3,"E-2",e);
  assert.equal((await f.read())?.face.evidence[0]?.withdrawn,true);
  assert.equal((await f.read({through:2}))?.face.evidence[0]?.withdrawn,false);
});
for(const column of ["source_sha256","event_sha256","source_event_id","target_object"])check(`a withdrawal with wrong ${column} cannot relabel this evidence`,async f=>{
  f.hypothesis();const e=f.evidence(2);f.withdraw(3,"E-2",e);
  f.sql.exec(`UPDATE scientific_withdrawals SET ${column}='mismatch'`);
  assert.equal((await f.read())?.face.evidence[0]?.withdrawn,false);
});
for(const target of ["H-1","H-1@1","#1","problem"])check(`current ${target} hide overrides historical evidence discovery`,async f=>{
  f.hypothesis();f.evidence(2);const before=await f.read({through:2});
  f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(target);
  assert.equal(await f.read({through:2}),null);
  f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(target);
  assert.deepEqual(await f.read({through:2}),before);
});
for(const target of ["E-2","E-2@1","#2"])check(`hidden ${target} has neither source metadata nor link in a historical evidence index`,async f=>{
  f.hypothesis();const source=f.evidence(2);const original=await f.read({through:2});
  f.evidence(3);
  f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(target);
  const r=await f.read({through:2});assert.equal(r?.face.evidence.length,0);
  for(const value of ["E-2",source.eid,source.hash])assert.equal(JSON.stringify(r).includes(value),false);
  assert.equal(r?.face.scanned_through,2);assert.equal(r?.face.scanned,1);
  assert.ok(r?.face.omitted.includes("content_unavailable"));
  f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(target);
  assert.deepEqual(await f.read({through:2}),original);
});
for(const [target,eventRef] of [["H-1","#1"],["E-2","#2"]])check(`each independent ${target} control must be restored before evidence discovery returns`,async f=>{
  f.hypothesis();const source=f.evidence(2);const original=await f.read({through:2});
  for(const reference of [target,`${target}@1`,eventRef])
    f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(reference);
  for(const reference of [target,`${target}@1`]) {
    f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(reference);
    const hidden=await f.read({through:2});
    if(target==="H-1")assert.equal(hidden,null);
    else {
      assert.equal(hidden?.face.evidence.length,0);
      for(const value of ["E-2",source.eid,source.hash])assert.equal(JSON.stringify(hidden).includes(value),false);
    }
  }
  f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(eventRef);
  assert.deepEqual(await f.read({through:2}),original);
});
check("unrelated versions and problems cannot hide an exact hypothesis evidence index",async f=>{
  f.hypothesis();f.evidence(2);const original=await f.read({through:2});
  for(const target of ["H-1@2","E-2@2","#3"])
    f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(target);
  for(const target of ["problem","H-1@1","E-2@1","#1","#2"])
    f.sql.prepare("INSERT INTO content_controls VALUES('P-OTHER',?,1,'hidden')").run(target);
  assert.deepEqual(await f.read({through:2}),original);
});
check("exact hidden observations retain bounded pagination and cannot shift a frozen continuation",async f=>{
  f.hypothesis();for(let n=2;n<=12;n++)f.evidence(n);
  for(let n=2;n<=9;n++)
    f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(n%2===0?`E-${n}@1`:`#${n}`);
  const first=await f.read({through:12});assert.ok(first);
  assert.equal(first.face.evidence.length,0);assert.equal(first.face.next_after,9);
  assert.equal(first.face.scanned,8);assert.equal(first.face.scanned_through,9);
  f.evidence(13);
  const next=await f.read({through:first.face.cursor,after:first.face.next_after});
  assert.deepEqual(next?.face.evidence.map(item=>item.evidence_id),["E-10","E-11","E-12"]);
  assert.equal(next?.face.next_after,null);
});
check("unlisted known-URL discovery retains private cache classification",async f=>{
  f.hypothesis();f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'");
  assert.equal((await f.read())?.unlisted,true);
});
check("redacted or cryptographically altered parent withholds the complete index",async f=>{
  f.hypothesis();f.evidence(2);
  f.sql.exec("UPDATE event_content SET payload_json='{\"route\":\"forged\"}' WHERE event_id='P-DEMO-1'");
  assert.equal(await f.read(),null);
});
check("altered evidence bytes with the old digest do not lend their direction",async f=>{
  f.hypothesis();f.evidence(2);
  f.sql.exec("UPDATE event_content SET payload_json=replace(payload_json,'informs','refutes') WHERE event_id='P-DEMO-2'");
  const r=await f.read();assert.equal(r?.face.evidence.length,0);assert.ok(r?.face.omitted.includes("content_unavailable"));
});
for(const column of ["source_event_id","source_seq","author_fellow_id"])check(`mismatched projection ${column} does not create a reference`,async f=>{
  f.hypothesis();f.evidence(2);f.sql.exec(`UPDATE evidence SET ${column}='wrong'`);
  assert.equal((await f.read())?.face.scanned,0);
});
check("oversized source is omitted without preventing a smaller later observation",async f=>{
  f.hypothesis();f.evidence(2,"E-2","H-1",{body_md:"x".repeat(524288)});f.evidence(3);
  const r=await f.read();assert.deepEqual(r?.face.evidence.map(x=>x.evidence_id),["E-3"]);
  assert.ok(r?.face.omitted.includes("payload_budget"));assert.ok(f.counts().payloadBytes<1024);
});
check("the cumulative source budget is enforced inside SQL, not after fetching every body",async f=>{
  f.hypothesis();for(let n=2;n<=10;n++)f.evidence(n,`E-${n}`,"H-1",{body_md:"x".repeat(400000)});
  const r=await f.read();assert.equal(r?.face.evidence.length,2);assert.equal(r?.face.scanned,8);
  assert.equal(r?.face.next_after,9);assert.ok(r?.face.omitted.includes("payload_budget"));
  assert.ok(f.counts().payloadBytes<=1048576);
});
check("duplicate parent admissions fail rather than silently choosing a new identity",async f=>{
  f.hypothesis();f.hypothesis(2);await assert.rejects(f.read(),{code:"HYPOTHESES_UNAVAILABLE"});
});
check("a known eliminated hypothesis retains its negative evidence history",async f=>{
  f.hypothesis();f.evidence(2);f.event(3,"H-1","hypothesis",{hypothesis_id:"H-1"},"P-DEMO","hypothesis.killed");
  assert.equal((await f.read())?.face.evidence.length,1);
});
for(const query of [{through:100},{after:100},{through:2,after:3},{through:-1},{through:1.5}])check(`invalid/future evidence window ${JSON.stringify(query)} is refused`,async f=>{
  f.hypothesis();await assert.rejects(f.read(query),{code:"CURSOR_INVALID"});
});
check("redacting the parent withholds the entire index even when evidence content is intact",async f=>{
  f.hypothesis();f.evidence(2);f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='P-DEMO-1'");
  assert.equal(await f.read(),null);
});
check("evidence that predates its claimed parent is not a valid indexed source",async f=>{
  f.hypothesis(3);f.evidence(2);
  assert.equal((await f.read())?.face.scanned,0);
});
