import { test } from "bun:test";
import assert from "node:assert/strict";
import type { HypothesisEvidenceIndexResponse } from "@asimposium/contracts/hypotheses";
import { HYPOTHESIS_EVIDENCE_INDEX_FACE_BYTES, hypothesisEvidenceIndexResponse } from "../../src/ledger/hypothesis-evidence-index-face.ts";
const face = { problem_id:"P-DEMO",hypothesis_id:"H-1",cursor:20,after:0,next_after:9 } as HypothesisEvidenceIndexResponse;
for(const format of ["json","md","html"] as const)test(`${format} navigation and caching preserve the exact problem, hypothesis and cut`,async()=>{
  const response=await hypothesisEvidenceIndexResponse(new Request("https://a.asimposium.org/"),"source bytes",format,face,false);
  assert.equal(response.status,200);assert.equal(await response.text(),"source bytes");
  assert.ok(response.headers.get("link")?.includes(`/p/P-DEMO/hypotheses/H-1/evidence.${format}?through=20&after=9`));
  assert.ok(response.headers.get("link")?.includes('rel="next"'));
  assert.ok(response.headers.get("link")?.includes('rel="canonical"'));
  assert.match(response.headers.get("etag")!,/^"[a-f0-9]{64}"$/);
  assert.equal(response.headers.get("cache-control"),"public, max-age=0, must-revalidate");
  if(format==="html")assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'none'"));
});
test("weak, strong and wildcard validators match only the already-verified representation",async()=>{
  const make=(headers={})=>new Request("https://a.asimposium.org/",{headers});
  const first=await hypothesisEvidenceIndexResponse(make(),"one","json",face,false);
  for(const value of [first.headers.get("etag")!,`W/${first.headers.get("etag")}`,"*",`"unrelated", ${first.headers.get("etag")}`]){
    const r=await hypothesisEvidenceIndexResponse(make({"if-none-match":value}),"one","json",face,false);
    assert.equal(r.status,304);assert.equal(await r.text(),"");
  }
  const changed=await hypothesisEvidenceIndexResponse(make({"if-none-match":first.headers.get("etag")!}),"two","json",face,false);
  assert.equal(changed.status,200);assert.notEqual(changed.headers.get("etag"),first.headers.get("etag"));
});
test("HEAD keeps GET headers and has no body",async()=>{
  const get=await hypothesisEvidenceIndexResponse(new Request("https://a.asimposium.org/"),"source","json",face,false);
  const head=await hypothesisEvidenceIndexResponse(new Request("https://a.asimposium.org/",{method:"HEAD"}),"source","json",face,false);
  assert.equal(await head.text(),"");assert.deepEqual([...head.headers],[...get.headers]);
});
test("unlisted evidence navigation is never eligible for shared caching or indexing",async()=>{
  const r=await hypothesisEvidenceIndexResponse(new Request("https://a.asimposium.org/"),"body","json",face,true);
  assert.equal(r.headers.get("cache-control"),"private, no-store");
  assert.equal(r.headers.get("x-robots-tag"),"noindex, nofollow");
});
test("a complete terminal page has no continuation",async()=>{
  const r=await hypothesisEvidenceIndexResponse(new Request("https://a.asimposium.org/"),"body","json",{...face,next_after:null},false);
  assert.ok(!r.headers.get("link")?.includes('rel="next"'));
});
test("response size is enforced in UTF-8 bytes before serialization can be served",async()=>{
  const req=new Request("https://a.asimposium.org/");
  await assert.rejects(hypothesisEvidenceIndexResponse(req,"é".repeat(HYPOTHESIS_EVIDENCE_INDEX_FACE_BYTES/2+1),"json",face,false),/TOO_LARGE/);
  const r=await hypothesisEvidenceIndexResponse(req,"x".repeat(HYPOTHESIS_EVIDENCE_INDEX_FACE_BYTES),"json",face,false);
  assert.equal((await r.text()).length,HYPOTHESIS_EVIDENCE_INDEX_FACE_BYTES);
});
test("format is part of the ETag even for identical source text",async()=>{
  const req=new Request("https://a.asimposium.org/");
  const a=await hypothesisEvidenceIndexResponse(req,"same","json",face,false);
  const b=await hypothesisEvidenceIndexResponse(req,"same","md",face,false);
  assert.notEqual(a.headers.get("etag"),b.headers.get("etag"));
});
