import { test } from "bun:test";
import assert from "node:assert/strict";
import { HypothesisEvidenceIndexResponseSchema } from "../../src/hypotheses.ts";
import { generateHypothesesSchema } from "../../src/hypotheses-schema.ts";
function fixture() {
  const pin={event_id:"EV-H1",seq:1,created_at:"2026-09-01T00:00:00.000Z",payload_sha256:"a".repeat(64),
    fellow_id:"F-1",sponsor_id:"SP-1",session_id:"S-1",model_self_declared:"model",harness_self_declared:"harness"};
  return {schema:"asimposium.hypothesis-evidence-index.v1",problem_id:"P-DEMO",hypothesis_id:"H-1",
    hypothesis_publication:pin,cursor:10,after:0,scanned:1,scanned_through:2,next_after:null,
    evidence:[{evidence_id:"E-2",publication:{...pin,event_id:"EV-E2",seq:2},direction:"informs",kind:"argument",mode:"exploratory",withdrawn:false,read_url:"/p/P-DEMO/evidence/E-2.json"}],omitted:["index_scope"]};
}
test("the source schema accepts a complete bounded index and an explicit empty page",()=>{
  assert.ok(HypothesisEvidenceIndexResponseSchema.safeParse(fixture()).success);
  assert.ok(HypothesisEvidenceIndexResponseSchema.safeParse({...fixture(),scanned:0,scanned_through:0,evidence:[]}).success);
});
for(const [name,alter] of [
  ["wrong link",(v:any)=>{v.evidence[0].read_url="https://other.invalid/";}],
  ["claiming unsampled data",(v:any)=>{v.scanned=0;}],
  ["future evidence",(v:any)=>{v.evidence[0].publication.seq=11;}],
  ["before parent",(v:any)=>{v.evidence[0].publication.seq=1;}],
  ["unexplained omission",(v:any)=>{v.evidence=[];}],
  ["missing scope limit",(v:any)=>{v.omitted=[];}],
  ["invented verdict",(v:any)=>{v.evidence[0].verified=true;}],
  ["wrong continuation",(v:any)=>{v.next_after=9;v.omitted.push("page_limit");}],
] as const)test(`index contract refuses ${name}`,()=>{const f=fixture();alter(f);assert.equal(HypothesisEvidenceIndexResponseSchema.safeParse(f).success,false);});
test("canonical generator includes both index roots and shared cursors",()=>{
  const p=JSON.parse(generateHypothesesSchema()).properties;
  assert.ok(p.evidence_index_response);
  assert.deepEqual(p.evidence_index_query,p.query);
});
