import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import type { MoveTemplate, NextMoveCandidate } from "@asimposium/contracts";
import type { RetryPage, VerifiedDeadEndRetry } from "../../src/ledger/dead-end-retries.ts";
import { loadRetryMove, retryMoveFor, withRetryMove } from "../../src/mega-commands/retry-moves.ts";
const db={} as D1Database;
const template={move:"retry-dead-end",availability:"available",request:{method:"POST",path:"/v1/sessions/{id}/dead-ends"},
  prefilled_hints:{why_it_fails:"invented failure",supersedes:"DE-OLD"}} as MoveTemplate;
const item:VerifiedDeadEndRetry={problem_id:"P-DEMO",cursor:20,dead_end_id:"DE-1",author_fellow_id:"F-1",
  publication:{event_id:"SOURCE",seq:1,payload_sha256:"a".repeat(64)},firing:{event_id:"FIRED",seq:10,payload_sha256:"b".repeat(64)},
  source:{approach:"UNTRUSTED-APPROACH",why_it_fails:"UNTRUSTED-FAILURE",retry_predicate:"UNTRUSTED-PREDICATE",retry_when:{kind:"statement-revised"}}};
const permissions={session_open:true,promote:true,workshop_push:true};
const fake=(move:string)=>({move,refs:["P-DEMO",move],why:"fixture"} as NextMoveCandidate);

test("retry action is private investigation with no fabricated result or copied instruction",()=>{
  const move=retryMoveFor(item,"F-1",template)!;const contract=move.contract as Record<string,any>;
  assert.equal(contract.request.path,"/v1/sessions/{id}/workshop");
  assert.deepEqual(contract.required_fields,["type","title","body_md"]);
  assert.deepEqual(contract.prefilled_hints,{type:"scratch"});
  assert.ok(!JSON.stringify(move).includes("UNTRUSTED"));assert.ok(!JSON.stringify(move).includes("invented failure"));
  assert.equal(contract.preparation.dead_end_pin.event_id,"SOURCE");
  assert.equal(contract.preparation.firing_pin.event_id,"FIRED");assert.equal(contract.preparation.author_may_supersede,true);
});

test("another Fellow receives investigation, not authority to supersede someone else's negative result",()=>{
  const move=retryMoveFor(item,"F-2",template)!;const contract=move.contract as any;
  assert.equal(contract.preparation.author_may_supersede,false);
  assert.equal(contract.prefilled_hints.supersedes_dead_end_id,undefined);
});

test("typed condition reads distinguish exact gap, claim and current statement",()=>{
  for(const trigger of [{kind:"statement-revised"},{kind:"gap-closed",gap_id:"G-3"},{kind:"claim-reaches",claim_id:"C-2",reaches:"corroborated"}] as const){
    const selected={...item,source:{...item.source,retry_when:trigger}};
    const contract=retryMoveFor(selected,"F-1",template)!.contract as any;
    const paths=contract.preparation.additional_reads.map((x:any)=>x.path);
    assert.ok(paths.includes("/p/P-DEMO/events.json?since=9"));
    assert.ok(paths.includes(trigger.kind==="gap-closed"?"/p/P-DEMO/gaps.md?through=20&target=G-3":trigger.kind==="claim-reaches"?"/p/P-DEMO/claims/C-2.md?through=20":"/p/P-DEMO.md"));
  }
});

test("filtered first page advances to a real retry without mixing cursors",async()=>{
  const seen:unknown[]=[];
  const result=await loadRetryMove(db,"P-DEMO",20,"F-1",{template:()=>template,async page(_db,p,c,after){
    assert.equal(p,"P-DEMO");assert.equal(c,20);seen.push(after);
    return after?{items:[item],next:null,omitted:[]}:{items:[],next:{seq:8,id:"DE-0"},omitted:["content_unavailable","page_limit"]};
  }});
  assert.equal(result.move?.move,"retry-dead-end");assert.ok(result.degraded);assert.equal(seen.length,2);
});

test("only two pages are examined; filtered backlog is explicit partial discovery",async()=>{
  let calls=0;
  const result=await loadRetryMove(db,"P-DEMO",20,"F-1",{template:()=>template,async page(){calls++;return {items:[],omitted:["page_limit"],next:{seq:calls,id:`DE-${calls}`}};}});
  assert.equal(calls,2);assert.equal(result.move,null);assert.ok(result.degraded);
});

test("wrong scope, cursor and nonadvancing continuation are refused",async()=>{
  for(const bad of [{...item,problem_id:"P-OTHER"},{...item,cursor:21}]){
    await assert.rejects(loadRetryMove(db,"P-DEMO",20,"F-1",{template:()=>template,async page(){return {items:[bad],next:null,omitted:[]};}}),/INVALID/);
  }
  await assert.rejects(loadRetryMove(db,"P-DEMO",20,"F-1",{template:()=>template,async page(){return {items:[],next:{seq:1,id:"DE-1"},omitted:["page_limit"]};}}),/INVALID/);
});

test("review and gap work precede retries; retries precede new exploration",async()=>{
  const moves=[fake("review"),fake("close-gap"),fake("third-alternative"),fake("state-claim")];
  const result=await withRetryMove(db,"P-DEMO",20,"F-1",permissions,{moves,degraded:false},{async load(){return {move:retryMoveFor(item,"F-1",template),degraded:false};}});
  assert.deepEqual(result.moves.map(x=>x.move),["review","close-gap","retry-dead-end","third-alternative","state-claim"]);
});
for(const denied of ["session_open","promote","workshop_push"])test(`missing ${denied} skips retry source entirely`,async()=>{
  const selected={moves:[fake("review")],degraded:false};
  const result=await withRetryMove(db,"P-DEMO",20,"F-1",{...permissions,[denied]:false},selected,{async load(){assert.fail("unauthorized discovery");}});
  assert.equal(result,selected);
});

test("retry outage preserves unrelated valid recommendations with a partial flag",async()=>{
  const moves=[fake("review")];
  const result=await withRetryMove(db,"P-DEMO",20,"F-1",permissions,{moves,degraded:false},{async load(){throw new Error("database details must not leak");}});
  assert.equal(result.moves,moves);assert.ok(result.degraded);assert.ok(!JSON.stringify(result).includes("database details"));
});

test("an unavailable template produces no executable recommendation",()=>{
  assert.equal(retryMoveFor(item,"F-1",{move:"retry-dead-end",availability:"unavailable"} as MoveTemplate),null);
});
