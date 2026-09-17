import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { composePack, neutralizeUntrustedBody } from "@asimposium/render";
import { EvidenceRequestSchema, WorkshopPushRequestSchema } from "@asimposium/contracts";
import { loadFormalRecords } from "../../src/ledger/formal-records-service.ts";
import { readFormalPack } from "../../src/sessions/formal-pack.ts";
import { workingRetryDeadEndMove } from "../../src/sessions/ledger-pack.ts";
import type { FiredDeadEndTriggerRow } from "../../src/ledger/dead-ends.ts";

// Requires the actual Bun/Zod/shared-renderer workspace. A source-row fixture
// here tests adapter contracts, not D1 authentication or the migration lineage.
function source(payload: object) {
  const text=JSON.stringify(payload), digest=createHash("sha256").update(text).digest("hex");
  return {prepare:()=>({bind(){return this;}}),async batch(){return [
    {results:[{id:"P-DEMO",public_seq:10,status:"active"}]},
    {results:[{event_id:"EV-2",object_id:"E-2",seq:2,event_type:"evidence.created",object_version:1,
      payload_sha256:digest,payload_json:text,fellow_id:"F-author",sponsor_id:"usr-author",session_id:"S-author",
      model_string_self_declared:"declared",harness:"harness",created_at:"2026-09-01T00:00:00.000Z"}]},
  ];}} as unknown as D1Database;
}
const request={bears_on_kind:"claim",bears_on_id:"C-1",bears_on_version:1,kind:"certificate",direction:"supports",mode:"confirmatory",
  source:{kind:"locator",locator:"local/reproduction.lean",excerpt:"An intentionally submitted source artifact."},body_md:"Deliberate work product.",
  formal_artifact:{language:"lean",declaration:"example",source:"theorem example : True := True.intro",toolchain:"lean fixture",axiom_report:"Self-declared axioms."}};

test("formal service uses the real evidence contract and drops stored computed authority fields",async()=>{
  assert.ok(EvidenceRequestSchema.safeParse(request).success);
  const page=await loadFormalRecords(source({...request,evidence_id:"E-2",computed_class:"certified",drives_promotion:true}),"P-DEMO",10);
  assert.equal(page.records.length,1);assert.equal(page.records[0]?.kind,"formal-artifact");
  assert.ok(!Object.hasOwn(page.records[0]!.content,"computed_class"));
  assert.deepEqual(page.records[0]!.content,EvidenceRequestSchema.parse(request));
});
test("invalid formal artifacts fail canonical decoding instead of being silently promoted into the pack",async()=>{
  const page=await loadFormalRecords(source({...request,formal_artifact:{...request.formal_artifact,language:"unknown"}}),"P-DEMO",10);
  assert.equal(page.records.length,0);assert.ok(page.omitted.includes("unsupported_record"));
});
test("real shared composer accepts formal candidates under every supported token budget",async()=>{
  const database=source(request);
  const section=await readFormalPack(database,"P-DEMO",10,{
    records:loadFormalRecords,
    gaps:async()=>({unlisted:false,problemStatus:"active",face:{schema:"https://a.asimposium.org/schemas/proof-gaps.v1.json",
      problem_id:"P-DEMO",cursor:10,after:0,target:null,next_after:null,gaps:[],omitted:[]}}),
    neutralize:body=>neutralizeUntrustedBody(body).text,
  });
  for(const requested_max_tokens of [800,1500,2500,4000,8000]){
    const pack=composePack({schema:"asimposium.pack.v1",session:"S-EXAMPLE",problem:"P-DEMO",profile:"formal",cursor:10,requested_max_tokens,
      viewer:{audience:"session",membership:"contributor",effective_permissions:["read"]},candidates:section.candidates,omitted:section.omitted,action_candidates:[]});
    assert.ok(pack.tokens_estimate<=pack.budget_tokens);
    assert.ok(pack.items.filter(i=>i.kind==="formal-artifact").every(i=>i.untrusted&&i.scope==="ledger"));
  }
});
test("working-pack retry starts a private scratch and cannot forge author-only supersession",()=>{
  const trigger={dead_end_id:"DE-1",reason:"UNTRUSTED-TRIGGER-TEXT",approach:"AUTHORED-APPROACH"} as FiredDeadEndTriggerRow;
  const move=workingRetryDeadEndMove(trigger);assert.ok(move);
  const body=JSON.parse(move.body);assert.equal(body.contract.request.path,"/v1/sessions/{id}/workshop");
  assert.deepEqual(body.contract.prefilled_hints,{type:"scratch"});
  assert.ok(WorkshopPushRequestSchema.safeParse({...body.contract.prefilled_hints,title:"A new attempt",body_md:"My deliberate investigation."}).success);
  assert.ok(!move.body.includes("UNTRUSTED-TRIGGER-TEXT"));assert.ok(!move.body.includes("AUTHORED-APPROACH"));
  assert.ok(!Object.hasOwn(body.contract.prefilled_hints,"supersedes_dead_end_id"));
});
