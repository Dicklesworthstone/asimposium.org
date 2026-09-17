import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import type { FormalRecord, FormalRecordPage } from "../../src/ledger/formal-records.ts";
import type { ProofGapPage } from "../../src/ledger/proof-gaps-read.ts";
import { readFormalPack, type FormalPackDependencies } from "../../src/sessions/formal-pack.ts";

// Source responses and neutralizer are explicit composition fixtures. Real
// SQLite/hash behavior is tested in formal-records.test.ts; this is not the
// complete shared-renderer or Zod application acceptance test.
const db={} as D1Database;
function item(seq=2, kind:FormalRecord["kind"]="formal-artifact"):FormalRecord {
  return {kind,publication:{event_id:`EV-${seq}`,object_id:`E-${seq}`,seq,payload_sha256:"a".repeat(64),fellow_id:"F-author",
    sponsor_id:"usr-author",session_id:"S-author",model_string_self_declared:"declared-model",harness:"harness",created_at:"2026-09-01T00:00:00.000Z"},
    target:{claim_id:"C-1",version:3},content:{bears_on_kind:"claim",bears_on_id:"C-1",bears_on_version:3,
      kind:"certificate",direction:"supports",mode:"confirmatory",source:{kind:"model_memory"},body_md:"AUTHOR-CONTENT",
      formal_artifact:{language:"lean",declaration:"example",source:"SOURCE-SENTINEL",toolchain:"local-only",axiom_report:"reported"}}};
}
function recordPage(records:FormalRecord[]=[],after=0,next_after:number|null=null):FormalRecordPage {
  return {problem_id:"P-DEMO",cursor:100,after,next_after,records,omitted:next_after===null?[]:["page_limit"]};
}
function gapPage(after=0,next_after:number|null=null):ProofGapPage {
  return {unlisted:false,problemStatus:"active",face:{schema:"https://a.asimposium.org/schemas/proof-gaps.v1.json",problem_id:"P-DEMO",cursor:100,after,target:null,next_after,
    gaps:[],omitted:next_after===null?[]:["page_limit"]}};
}
function gap(seq=1) {
  const event={event_id:`G-EV-${seq}`,seq,payload_sha256:"b".repeat(64),created_at:"2026-09-01T00:00:00.000Z",
    fellow_id:"F-gap",sponsor_id:"usr-gap",session_id:"S-gap",model_string_self_declared:"declared",harness:"harness"};
  return {gap_id:`G-${seq}`,status:"open" as const,filing:event,last_event:event,
    content:{target_claim_id:"C-1",target_version:3,obligation:"GAP-OBLIGATION-SENTINEL",closes_what:"A missing step"},closed_by:null};
}
function deps(overrides:Partial<FormalPackDependencies>={}):FormalPackDependencies {
  return {records:async()=>recordPage([item()]),gaps:async()=>({...gapPage(),face:{...gapPage().face,gaps:[gap()]}}),neutralize:s=>s,...overrides};
}

test("formal pack contains whole artifacts and gaps with exact source and claim links",async()=>{
  const section=await readFormalPack(db,"P-DEMO",100,deps());
  assert.deepEqual(section.candidates.map(i=>i.kind),["standing-context","proof-gap","formal-artifact"]);
  const artifact=JSON.parse(section.candidates[2]!.body);
  assert.equal(artifact.content.formal_artifact.source,"SOURCE-SENTINEL");
  assert.equal(artifact.target_read,"/p/P-DEMO/claims/C-1@3.md?through=100");
  assert.equal(artifact.source,"/p/P-DEMO/events.json?since=1");
  const obligation=JSON.parse(section.candidates[1]!.body);
  assert.equal(obligation.source,"/p/P-DEMO/gaps.md?through=100&target=G-1");
  assert.equal(obligation.content.obligation,"GAP-OBLIGATION-SENTINEL");
});
test("all authored bodies are untrusted; the trusted notice contains no authored prose",async()=>{
  const section=await readFormalPack(db,"P-DEMO",100,deps());
  for(const record of section.candidates.filter(i=>i.scope!=="system")){assert.equal(record.scope,"ledger");assert.equal(record.untrusted,true);}
  assert.ok(!section.candidates.filter(i=>i.scope==="system").some(i=>/AUTHOR-CONTENT|SOURCE-SENTINEL|GAP-OBLIGATION/.test(i.body)));
  assert.match(section.candidates[0]!.body,/not platform execution/);
  assert.match(section.candidates[0]!.body,/may be historical/);
});
test("verification failure and friction reports remain readable without certifying the claim",async()=>{
  const section=await readFormalPack(db,"P-DEMO",100,deps({records:async()=>recordPage([item(2,"formalization-friction"),item(3,"verification-report")])}));
  assert.deepEqual(section.candidates.slice(2).map(i=>i.kind),["formalization-friction","verification-report"]);
  assert.ok(section.candidates.slice(2).every(i=>JSON.parse(i.body).notice.includes("does not assign")));
});
test("a large artifact becomes a whole-record reference, never a truncated proof",async()=>{
  const large=item();large.content.body_md="PRIVATE-SENTINEL-START"+"x".repeat(19000)+"PRIVATE-SENTINEL-END";
  const section=await readFormalPack(db,"P-DEMO",100,deps({records:async()=>recordPage([large])}));
  const record=JSON.parse(section.candidates.find(i=>i.kind==="formal-artifact")!.body);
  assert.equal(record.content,null);assert.equal(record.content_omitted,"whole-record-size-limit");
  assert.equal(record.publication.payload_sha256,"a".repeat(64));assert.ok(!JSON.stringify(record).includes("PRIVATE-SENTINEL"));
  assert.ok(section.omitted.some(i=>i.reason==="item_too_large"&&i.detail.includes("events.json?since=1")));
});
test("neutralizer expansion cannot turn a fitting record into an oversized pack item",async()=>{
  const section=await readFormalPack(db,"P-DEMO",100,deps({neutralize:body=>body.includes("SOURCE-SENTINEL")?body+"x".repeat(18000):body}));
  assert.equal(JSON.parse(section.candidates.find(i=>i.kind==="formal-artifact")!.body).content,null);
});
test("record-source outage preserves valid gaps and states the omission",async()=>{
  const section=await readFormalPack(db,"P-DEMO",100,deps({records:async()=>{throw new Error("sensitive SQL secret");}}));
  assert.ok(section.candidates.some(i=>i.kind==="proof-gap"));assert.ok(!section.candidates.some(i=>i.id==="SYS-formal-empty"));
  assert.deepEqual(section.omitted,[{reason:"formal_records_unavailable",detail:"Canonical artifact/friction/verification history is unavailable; proof-gap context remains separate."}]);
  assert.ok(!JSON.stringify(section).includes("sensitive SQL"));
});
test("gap-source outage preserves valid artifacts and does not fabricate an empty gap history",async()=>{
  const section=await readFormalPack(db,"P-DEMO",100,deps({gaps:async()=>{throw new Error("failure");}}));
  assert.ok(section.candidates.some(i=>i.kind==="formal-artifact"));assert.equal(section.omitted[0]?.reason,"formal_gaps_unavailable");
});
test("clean empty baseline requires both complete sources",async()=>{
  const section=await readFormalPack(db,"P-DEMO",100,deps({records:async()=>recordPage(),gaps:async()=>gapPage()}));
  assert.ok(section.candidates.some(i=>i.id==="SYS-formal-empty"));assert.deepEqual(section.omitted,[]);
  const missing=await readFormalPack(db,"P-DEMO",100,deps({records:async()=>({...recordPage(),omitted:["content_unavailable"]}),gaps:async()=>gapPage()}));
  assert.ok(!missing.candidates.some(i=>i.id==="SYS-formal-empty"));assert.equal(missing.omitted[0]?.reason,"content_unavailable");
});
test("ordinary source admissions advance to later formal work without shifting the snapshot",async()=>{
  const calls:number[]=[];
  const section=await readFormalPack(db,"P-DEMO",100,deps({records:async(_db,p,c,a)=>{
    assert.equal(p,"P-DEMO");assert.equal(c,100);calls.push(a);return a===0?recordPage([],0,8):recordPage([item(10)],8);
  }}));
  assert.deepEqual(calls,[0,8]);assert.ok(section.candidates.some(i=>i.id==="E-10"));
  assert.ok(!section.omitted.some(i=>i.reason==="candidate_limit"));
});
test("two-page cap gives reachable continuation instead of silently claiming completeness",async()=>{
  const calls:number[]=[];
  const section=await readFormalPack(db,"P-DEMO",100,deps({records:async(_db,_p,_c,a)=>{calls.push(a);return recordPage([],a,a+8);}}));
  assert.deepEqual(calls,[0,8]);assert.ok(section.omitted.some(i=>i.reason==="candidate_limit"&&i.detail.includes("since=16")));
});
for(const error of ["scope","cursor","duplicate","rewind"]){
  test(`invalid ${error} source does not publish a misleading partial prefix`,async()=>{
    const section=await readFormalPack(db,"P-DEMO",100,deps({records:async(_db,_p,_c,a)=>{
      if(a===0)return recordPage([item(2)],0,8);
      return error==="scope"?{...recordPage([item(10)],8),problem_id:"P-OTHER"}:
        error==="cursor"?{...recordPage([item(10)],8),cursor:101}:
        error==="duplicate"?recordPage([item(2)],8):recordPage([],8,8);
    }}));
    assert.ok(!section.candidates.some(i=>i.kind==="formal-artifact"));assert.ok(section.candidates.some(i=>i.kind==="proof-gap"));
    assert.ok(section.omitted.some(i=>i.reason==="formal_records_unavailable"));
  });
}
test("source completion order cannot reorder formal output",async()=>{
  const expected=await readFormalPack(db,"P-DEMO",100,deps());
  const actual=await readFormalPack(db,"P-DEMO",100,deps({gaps:async(...args)=>{await new Promise(r=>setTimeout(r,5));return deps().gaps(...args);}}));
  assert.deepEqual(actual,expected);
});
