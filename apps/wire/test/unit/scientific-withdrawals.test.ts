import assert from "node:assert/strict";
import { test } from "bun:test";
import { withdrawScientificInput, ScientificWithdrawalError } from "../../src/ledger/scientific-withdrawals.ts";
import { NOW, SESSION, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

type Fixture=ReturnType<typeof withdrawalFixture>;
async function using(fn:(f:Fixture)=>Promise<void>){const f=withdrawalFixture();try{await fn(f)}finally{f.close()}}
const run=(f:Fixture,s:ReturnType<Fixture["source"]>,key="withdrawal-1")=>
  withdrawScientificInput(f.options,f.actor,SESSION,s.kind,s.id,s.request,key);
const count=(f:Fixture,table:string)=>(f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n;

for(const kind of ["review","evidence"] as const) {
  test(`records an author ${kind} withdrawal without editing the original`,()=>using(async f=>{
    const s=f.source(kind);const sourceBefore=f.sql.query("SELECT * FROM event_content WHERE event_id=?").get(s.event.id);
    const head=(f.sql.query("SELECT public_seq FROM problems WHERE id='P-DEMO'").get() as {public_seq:number}).public_seq;
    const result=await run(f,s);
    assert.equal(result.target_event_id,s.event.id);assert.equal(result.target_kind,kind);
    assert.equal(result.claim_id,"C-1");assert.equal(result.seq,head+1);
    assert.equal(count(f,"scientific_withdrawals"),1);assert.equal(count(f,"retractions"),1);
    assert.deepEqual(f.sql.query("SELECT * FROM event_content WHERE event_id=?").get(s.event.id),sourceBefore);
    assert.equal((f.sql.query("SELECT cursor FROM public_cursor").get() as {cursor:number}).cursor,1);
    assert.equal((f.sql.query("SELECT status FROM public_write_attempt_reservations").get() as {status:string}).status,"settled_published");
    assert.equal(f.counts.screens,1);
  }));
}
test("exact replay survives closed session without rescreening or moving the cursor",()=>using(async f=>{
  const s=f.source("review"), first=await run(f,s);
  f.sql.exec("UPDATE sessions SET closed_at='closed'");
  const second=await run(f,s);assert.deepEqual(second,first);assert.equal(f.counts.screens,1);
  assert.equal(f.counts.reservations,1);assert.equal(count(f,"retractions"),1);
}));
test("same key with a changed reason conflicts even after the original session closes",()=>using(async f=>{
  const s=f.source("review");await run(f,s);f.sql.exec("UPDATE sessions SET closed_at='closed'");
  await assert.rejects(run(f,{...s,request:{...s.request,reason:"A different reason must not replace the original."}}),{code:"CONFLICT"});
}));
test("another key cannot create a second withdrawal or buy another screen",()=>using(async f=>{
  const s=f.source("review");await run(f,s);
  await assert.rejects(run(f,s,"another-key"),{code:"CONFLICT"});assert.equal(f.counts.screens,1);
}));
test("thirty overlapping same-key requests converge on one committed event",()=>using(async f=>{
  const s=f.source("review");const results=await Promise.all(Array.from({length:30},()=>run(f,s)));
  assert.equal(new Set(results.map(r=>r.event_id)).size,1);assert.equal(count(f,"scientific_withdrawals"),1);
  assert.equal((f.sql.query("SELECT cursor FROM public_cursor").get() as {cursor:number}).cursor,1);
}));
test("a lost post-commit acknowledgment returns the durable receipt",()=>using(async f=>{
  const s=f.source("evidence");f.loseAcknowledgment();const first=await run(f,s);
  assert.deepEqual(await run(f,s),first);assert.equal(f.counts.settlements,0);
}));
test("one author cannot withdraw somebody else's evidence or review",()=>using(async f=>{
  for(const kind of ["review","evidence"] as const){const s=f.source(kind,kind==="review"?"REV-other":"E-other",{},"fellow-b");
    await assert.rejects(run(f,s),{code:"NOT_ALLOWED"});}
  assert.equal(f.counts.reservations,0);assert.equal(count(f,"retractions"),0);
}));
test("target id, event pin and content digest must identify the same source",()=>using(async f=>{
  const a=f.source("review","REV-first"),b=f.source("review","REV-second");
  await assert.rejects(run(f,{...a,request:b.request}),{code:"NOT_ALLOWED"});
  await assert.rejects(run(f,{...a,request:{...a.request,source_digest:`sha256:${"0".repeat(64)}`}}),{code:"NOT_ALLOWED"});
  assert.equal(f.counts.reservations,0);
}));
test("projection routing that disagrees with the hashed source cannot select a different claim",()=>using(async f=>{
  const s=f.source("review");f.sql.exec("UPDATE reviews SET target_version=2");
  await assert.rejects(run(f,s),{code:"UNAVAILABLE"});assert.equal(f.counts.screens,0);
}));
test("matching stored hash labels cannot conceal modified source bytes",()=>using(async f=>{
  const s=f.source("evidence");f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(s.event.id);
  await assert.rejects(run(f,s),{code:"UNAVAILABLE"});assert.equal(f.counts.screens,0);
}));
for(const [name,mutation] of [
  ["revocation","UPDATE fellow_tokens SET revoked_at=1"],
  ["pause","UPDATE enrollment_fellows SET status='paused'"],
  ["panic",`INSERT INTO enrollment_sponsor_security VALUES('sponsor-a',${NOW})`],
  ["membership removal","DELETE FROM problem_memberships"],
  ["privacy change","UPDATE problems SET status='private-draft' WHERE id='P-DEMO'"],
  ["session closure","UPDATE sessions SET closed_at='closed'"],
  ["scope change","UPDATE fellow_tokens SET granted_scopes_json='[]'"],
  ["source redaction","UPDATE event_content SET redacted_at='redacted' WHERE event_id LIKE 'source-%'"],
  ["source substitution","UPDATE event_content SET payload_json='{}' WHERE event_id LIKE 'source-%'"],
] as const) {
  test(`${name} during screening rolls back event, index, replay and cursor together`,()=>using(async f=>{
    const s=f.source("review"), events=count(f,"events");f.before(()=>f.sql.exec(mutation));
    await assert.rejects(run(f,s));assert.equal(count(f,"events"),events);
    assert.equal(count(f,"scientific_withdrawals"),0);assert.equal(count(f,"retractions"),0);
    assert.equal((f.sql.query("SELECT cursor FROM public_cursor").get() as {cursor:number}).cursor,0);
  }));
}
test("an expired verifier cannot commit a withdrawal with an earlier authority timestamp",()=>using(async f=>{
  const s=f.source("review");f.before(()=>f.clock(NOW+3600001));
  await assert.rejects(run(f,s));assert.equal(count(f,"retractions"),0);
}));
for(const decision of ["allow-with-warning","quarantine","reject"] as const) {
  test(`${decision} does not publish an unscreened reason or pretend a correction committed`,()=>using(async f=>{
    const s=f.source("evidence"), screen=f.options.screen;
    const options={...f.options,screen:async(input:Parameters<typeof screen>[0])=>({...await screen(input),decision})};
    await assert.rejects(withdrawScientificInput(options,f.actor,SESSION,s.kind,s.id,s.request,"held-key"),{code:"HELD"});
    assert.equal(count(f,"retractions"),0);
    assert.equal((f.sql.query("SELECT status FROM public_write_attempt_reservations").get() as {status:string}).status,"settled_held");
  }));
}
test("wrong screening digest cannot authorize another reason",()=>using(async f=>{
  const s=f.source("review"),screen=f.options.screen;
  const options={...f.options,screen:async(input:Parameters<typeof screen>[0])=>({...await screen(input),evaluated_body_digest:`sha256:${"0".repeat(64)}`})};
  await assert.rejects(withdrawScientificInput(options,f.actor,SESSION,s.kind,s.id,s.request,"bad-screen"),{code:"UNAVAILABLE"});
  assert.equal(count(f,"retractions"),0);
}));
test("observer reviewers can withdraw their own reviews but cannot withdraw promotion evidence",()=>using(async f=>{
  f.sql.exec("UPDATE problem_memberships SET role='observer'");
  await run(f,f.source("review"));
  await assert.rejects(run(f,f.source("evidence")),{code:"NOT_ALLOWED"});
}));
test("private and closed problems fail before quota or paid screening",()=>using(async f=>{
  const s=f.source("review");for(const status of ["private-draft","resolved","retired"]){
    f.sql.query("UPDATE problems SET status=? WHERE id='P-DEMO'").run(status);
    await assert.rejects(run(f,s),{code:"NOT_ALLOWED"});}
  assert.equal(f.counts.screens,0);assert.equal(f.counts.reservations,0);
}));
test("withdrawal history cannot be updated or deleted",()=>using(async f=>{
  await run(f,f.source("review"));assert.throws(()=>f.sql.exec("UPDATE scientific_withdrawals SET seq=999"),/IMMUTABLE/);
  assert.throws(()=>f.sql.exec("DELETE FROM scientific_withdrawals"),/IMMUTABLE/);
}));
test("no caller-controlled provider extras are retained in the screening receipt",()=>using(async f=>{
  const s=f.source("review"),screen=f.options.screen;
  await withdrawScientificInput({...f.options,screen:async input=>({...await screen(input),raw_body:"SENTINEL-PRIVATE-EXTRA"})},f.actor,SESSION,s.kind,s.id,s.request,"safe-receipt");
  const r=f.sql.query("SELECT screen_receipt_json FROM scientific_withdrawals").get() as {screen_receipt_json:string};
  assert.equal(r.screen_receipt_json.includes("SENTINEL"),false);
}));
