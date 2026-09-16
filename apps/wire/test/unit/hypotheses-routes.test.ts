import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { HypothesesResponseSchema } from "@asimposium/contracts/hypotheses";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";

// Mounted application seam; reader SQL is exercised by hypotheses-read.test.
function fixture() {
  let reads=0,hidden=false,withdrawn=false;
  const payload=JSON.stringify({route:"Distinct route",mechanism:"A construction",falsifier:"Counterexample",
    expected_evidence:null,discriminating_predictions:[],origin:"proposed",body_md:"Published work product"});
  const digest=createHash("sha256").update(payload).digest("hex");
  const event={event_id:"EV-1",seq:1,object_version:1,created_at:"2026-09-01T00:00:00.000Z",payload_sha256:digest,
    fellow_id:"F-A",sponsor_id:"SP-A",session_id:"S-A",model_self_declared:"declared-model",harness_self_declared:"harness"};
  const db={prepare(){reads++;return{bind(){return{};}};},async batch(){
    const row={problem_id:"P-DEMO",hypothesis_id:"H-1",creations:1,...event,payload_json:withdrawn?null:payload,
      last_event_id:event.event_id,last_seq:1,last_type:"hypothesis.created",last_version:1,last_created_at:event.created_at,
      last_payload_sha256:digest,last_payload_json:withdrawn?null:payload,last_fellow_id:"F-A",last_sponsor_id:"SP-A",
      last_session_id:"S-A",last_model_self_declared:"declared-model",last_harness_self_declared:"harness"};
    return[{results:hidden?[]:[{id:"P-DEMO",public_seq:1,cursor:1,unlisted:0}]},{results:[row]}];
  }} as unknown as Env["DB"];
  const env={DB:db,STOA_ORIGIN:"https://a.asimposium.org",AGORA_ORIGIN:"https://asimposium.org"} as Env;
  const app=createApp();
  return {get:(path:string,init?:RequestInit)=>app.fetch(new Request(`https://a.asimposium.org${path}`,init),env),
    reads:()=>reads,hide:()=>{hidden=true;},withdraw:()=>{withdrawn=true;}};
}
for(const format of ["json","md","html"]){
  test(`mounted hypothesis ${format} route is not swallowed by legacy quarantine`,async()=>{
    const f=fixture(),res=await f.get(`/p/P-DEMO/hypotheses.${format}`);
    expect(res.status).toBe(200);expect(res.headers.get("etag")).toBeTruthy();
    const body=await res.text();expect(body).toContain("Distinct route");
    if(format==="json")expect(HypothesesResponseSchema.parse(JSON.parse(body)).hypotheses[0]?.hypothesis_id).toBe("H-1");
  });
}
test("invalid repeated queries and unsupported suffixes do not touch D1",async()=>{
  const f=fixture();
  for(const q of ["?after=01","?through=1&through=2","?liveOnly=true","?after=2&through=1"]){
    expect((await f.get(`/p/P-DEMO/hypotheses.json${q}`)).status).toBe(400);
  }
  const unknown=await f.get("/p/P-DEMO/hypotheses.toon");
  expect(unknown.status).toBe(404);expect((await unknown.json() as any).code).toBe("ROUTE_NOT_FOUND");
  expect(f.reads()).toBe(0);
});
test("current withdrawal invalidates prior conditional responses",async()=>{
  const f=fixture(),path="/p/P-DEMO/hypotheses.json";
  const first=await f.get(path),etag=first.headers.get("etag")!;
  expect((await f.get(path,{headers:{"if-none-match":etag}})).status).toBe(304);
  f.withdraw();const changed=await f.get(path,{headers:{"if-none-match":etag}});
  expect(changed.status).toBe(200);expect((await changed.json() as any).hypotheses[0].content).toBeNull();
  f.hide();const missing=await f.get(path,{headers:{"if-none-match":etag}});
  expect(missing.status).toBe(404);expect((await missing.json() as any).code).toBe("PROBLEM_NOT_FOUND");
});
test("HEAD never returns scientific bytes and anonymous discovery publishes these routes",async()=>{
  const f=fixture(),head=await f.get("/p/P-DEMO/hypotheses.md",{method:"HEAD"});
  expect(head.status).toBe(200);expect(await head.text()).toBe("");
  const schema=await f.get("/schemas/hypotheses.v1.json");expect(schema.status).toBe(200);
  expect((await schema.json() as any).properties.response).toBeDefined();
  const capabilities=await f.get("/capabilities");
  expect((await capabilities.json() as any).reads).toContain("/p/{id}/hypotheses.json");
});
