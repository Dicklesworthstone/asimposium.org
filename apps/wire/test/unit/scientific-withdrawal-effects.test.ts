import assert from "node:assert/strict";
import { test } from "bun:test";
import { scientificWithdrawalEffects } from "../../src/ledger/scientific-withdrawal-effects.ts";
import { foldScientificRows, prepareScientificDispositions, type ScientificRow } from "../../src/ledger/scientific-disposition.ts";
import { withdrawScientificInput } from "../../src/ledger/scientific-withdrawals.ts";
import { SESSION, sha, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

type Fixture=ReturnType<typeof withdrawalFixture>;
async function using(fn:(f:Fixture)=>Promise<void>){const f=withdrawalFixture();try{await fn(f)}finally{f.close()}}
const rows=(f:Fixture,cut=1000,target?:{claimId:string;version:number})=>prepareScientificDispositions(f.db,"P-DEMO",cut,100,target).all<ScientificRow>();
const withdraw=(f:Fixture,s:ReturnType<Fixture["source"]>)=>withdrawScientificInput(f.options,f.actor,SESSION,s.kind,s.id,s.request,"correction-1");
function support(f:Fixture){
  const base=f.source("evidence","E-base",{kind:"argument"});
  f.source("evidence","E-check",{falsification_check:{target_digest:`sha256:${sha("statement")}`,
    attempted_falsifier:"Search for n=0 violating the bound.",capable_of_failure:"The observed output could exceed it.",result:"survived",
    evidence:[{evidence_id:base.id,digest:base.request.source_digest}]}});
  const review=f.source("review");
  return {base,review};
}
test("a withdrawn supporting review no longer corroborates its target claim",()=>using(async f=>{
  const s=support(f);assert.equal((await foldScientificRows((await rows(f)).results)).disposition,"corroborated");
  await withdraw(f,s.review);const after=await foldScientificRows((await rows(f)).results);
  assert.equal(after.disposition,"open");assert.equal(after.context.verified_reviews.length,0);assert.equal(after.stale,true);
}));
test("withdrawing grounding evidence invalidates its surviving checks and dependent support",()=>using(async f=>{
  const s=support(f);await withdraw(f,s.base);const after=await foldScientificRows((await rows(f)).results);
  assert.equal(after.disposition,"open");assert.equal(after.context.recorded_refutation_attempts,0);assert.equal(after.stale,true);
}));
test("an earlier cursor cut retains its original standing without seeing a future withdrawal",()=>using(async f=>{
  const s=support(f),cut=(f.sql.query("SELECT public_seq FROM problems WHERE id='P-DEMO'").get() as {public_seq:number}).public_seq;
  await withdraw(f,s.review);
  assert.equal((await foldScientificRows((await rows(f,cut)).results)).disposition,"corroborated");
  assert.equal((await foldScientificRows((await rows(f)).results)).disposition,"open");
}));
test("a redacted withdrawal explanation cannot resurrect a withdrawn supporting review",()=>using(async f=>{
  const s=support(f),w=await withdraw(f,s.review);
  f.sql.query("UPDATE event_content SET redacted_at='redacted' WHERE event_id=?").run(w.event_id);
  const after=await foldScientificRows((await rows(f)).results);assert.equal(after.disposition,"open");assert.equal(after.stale,true);
}));
for(const kind of ["review","evidence"] as const){
  test(`withdrawing ${kind} cannot erase a recorded refutation`,()=>using(async f=>{
    const s=f.source(kind,kind==="review"?"REV-negative":"E-negative",kind==="review"?{verdict:"refute"}:{direction:"refutes"});
    assert.equal((await foldScientificRows((await rows(f)).results)).disposition,"disputed");
    await withdraw(f,s);assert.equal((await foldScientificRows((await rows(f)).results)).disposition,"disputed");
  }));
}
test("withdrawal of a statement-defect review does not silently repair the statement",()=>using(async f=>{
  const s=f.source("review","REV-defect",{rubric:["statement-defect"]});
  assert.equal((await foldScientificRows((await rows(f)).results)).disposition,"malformed");
  await withdraw(f,s);assert.equal((await foldScientificRows((await rows(f)).results)).disposition,"malformed");
}));
test("withdrawing an input on @1 never withdraws or contaminates the fresh @2 head",()=>using(async f=>{
  const s=support(f);await withdraw(f,s.review);
  f.append("E-revision","claim.revised","claim","C-1",{claim_id:"C-1",base_version:1,statement:"A revised bound."},"fellow-b","P-DEMO",2);
  f.sql.query("INSERT INTO claim_versions VALUES('P-DEMO','C-1',2,?,?,'conjecture')").run(`sha256:${sha("revision")}`,"A revised bound.");
  const after=await foldScientificRows((await rows(f)).results);assert.equal(after.currentVersion,2);assert.equal(after.disposition,"open");assert.equal(after.stale,false);
  assert.equal((await rows(f,1000,{claimId:"C-1",version:1})).results.some(r=>r.withdrawn_event_id===s.review.event.id),true);
}));
test("withdrawal of one full-write-up review removes unsupported strong standing",()=>using(async f=>{
  f.sql.exec("UPDATE events SET actor_fellow_id='fellow-z',actor_sponsor_id='sponsor-z' WHERE id='E-claim'");
  const base=f.source("evidence","E-argument",{kind:"argument"},"fellow-b");
  f.source("evidence","E-check",{falsification_check:{target_digest:`sha256:${sha("statement")}`,
    attempted_falsifier:"Check the excluded case.",capable_of_failure:"The bound could fail.",result:"survived",
    evidence:[{evidence_id:base.id,digest:base.request.source_digest}]}});
  const verification={kind:"full-write-up",target_digest:`sha256:${sha("statement")}`,
    evidence:{evidence_id:base.id,digest:base.request.source_digest},coverage:["Every case in the statement."],result:"verified"};
  const own=f.source("review","REV-first",{tier:"T2",verification});
  const peer=f.source("review","REV-second",{tier:"T2",verification},"fellow-c");
  f.sql.query("UPDATE events SET actor_sponsor_id='sponsor-c' WHERE id=?").run(peer.event.id);
  assert.equal((await foldScientificRows((await rows(f)).results)).disposition,"strongly-supported");
  await withdraw(f,own);const after=await foldScientificRows((await rows(f)).results);
  assert.equal(after.disposition,"corroborated");assert.equal(after.context.verified_reviews.length,1);
}));
test("a forged marker cannot withdraw a source written by a different Fellow",()=>using(async f=>{
  const s=support(f);await withdraw(f,s.review);const all=(await rows(f)).results;
  const marker=all.find(r=>r.withdrawn_event_id)!;marker.fellow_id="fellow-forged";
  const contents=new Map(all.filter(r=>r.payload_json!==null).map(r=>[r.event_id,JSON.parse(r.payload_json!)]));
  assert.equal(scientificWithdrawalEffects(all,contents).withdrawnEvents.size,0);
}));
test("free-form references cannot make unrelated evidence dependent on a withdrawal",()=>using(async f=>{
  const s=support(f),other=f.source("evidence","E-unrelated",{body_md:`Discuss ${s.base.id} without using it as a grounding reference.`});
  await withdraw(f,s.base);const all=(await rows(f)).results;
  const effects=scientificWithdrawalEffects(all,new Map(all.map(r=>[r.event_id,JSON.parse(r.payload_json!)])));
  assert.equal(effects.invalidatedEvidence.has(s.base.id),true);assert.equal(effects.invalidatedEvidence.has(other.id),false);
}));
test("transitive structured grounding dependencies are invalidated to arbitrary depth",()=>using(async f=>{
  const base=f.source("evidence","E-base");let previous=base;
  for(let i=0;i<100;i++) previous=f.source("evidence",`E-derived${i}`,{scientific_provenance:{model_family_self_declared:null,
    method:{category:"computation",procedure:"Use the previous bounded result.",evidence:[{evidence_id:previous.id,digest:previous.request.source_digest}]}}});
  await withdraw(f,base);const all=(await rows(f)).results;
  const effects=scientificWithdrawalEffects(all,new Map(all.map(r=>[r.event_id,JSON.parse(r.payload_json!)])));
  assert.equal(effects.invalidatedEvidence.size,101);assert.equal(effects.invalidatedEvidence.has(previous.id),true);
}));
test("markers with wrong source digest, kind, claim, version or chronology cannot remove support",()=>using(async f=>{
  const s=support(f);await withdraw(f,s.review);const all=(await rows(f)).results;
  const index=all.findIndex(r=>r.withdrawn_event_id);
  const contents=new Map(all.map(r=>[r.event_id,JSON.parse(r.payload_json!)]));
  for(const change of [{withdrawn_sha256:"0".repeat(64)},{withdrawn_kind:"evidence"},{claim_id:"C-99"},{target_version:2},{seq:1}]){
    const changed=all.map((r,i)=>i===index?{...r,...change}:r);
    assert.equal(scientificWithdrawalEffects(changed,contents).withdrawnEvents.size,0);
  }
}));
