import { test } from "bun:test";
import assert from "node:assert/strict";
import type { FormalRecordsResponse } from "@asimposium/contracts/formal-records";
import { FORMAL_READ_MAX_RESPONSE_BYTES, formalRecordResponse } from "../../src/ledger/formal-records-http.ts";

const face: FormalRecordsResponse = {
  schema:"https://a.asimposium.org/schemas/formal-records.v1.json",problem_id:"P-DEMO",cursor:90,after:0,
  target:null,next_after:8,records:[],omitted:["page_limit"],
};
const request=(method="GET",headers:Record<string,string>={})=>new Request("https://a.asimposium.org/p/P-DEMO/formal.json",{method,headers});

test("full JSON source bodies survive transport beyond the pack summary cap",async()=>{
  const original={source:"-- αβγ\n"+"theorem reported : True := True.intro\n".repeat(2000)};
  const text=JSON.stringify(original);assert.ok(text.length>64000);
  const response=await formalRecordResponse(request(),text,"json",face,false);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),original);
  assert.equal(response.headers.get("content-length"),String(new TextEncoder().encode(text).byteLength));
  assert.equal(response.headers.get("content-type"),"application/json; charset=utf-8");
});
test("HEAD matches GET metadata and returns no proof/source body",async()=>{
  const text=JSON.stringify({source:"α source"});
  const get=await formalRecordResponse(request(),text,"json",face,false);
  const head=await formalRecordResponse(request("HEAD"),text,"json",face,false);
  assert.equal(head.status,200);assert.equal(await head.text(),"");
  for(const key of ["content-length","content-type","content-location","etag","link","cache-control"])
    assert.equal(head.headers.get(key),get.headers.get(key));
});
test("conditional reads accept weak matching validators and return bodyless 304",async()=>{
  const text="record";const get=await formalRecordResponse(request(),text,"md",face,false);
  for(const method of ["GET","HEAD"]){
    const response=await formalRecordResponse(request(method,{"if-none-match":`"unrelated", W/${get.headers.get("etag")}`}),text,"md",face,false);
    assert.equal(response.status,304);assert.equal(await response.text(),"");
    assert.equal(response.headers.get("content-length"),null);assert.equal(response.headers.get("etag"),get.headers.get("etag"));
  }
});
test("representations cannot cross-validate even when their bytes coincide",async()=>{
  const json=await formalRecordResponse(request(),"same bytes","json",face,false);
  const html=await formalRecordResponse(request("GET",{"if-none-match":json.headers.get("etag")!}),"same bytes","html",face,false);
  assert.equal(html.status,200);assert.notEqual(html.headers.get("etag"),json.headers.get("etag"));
});
test("current withdrawal changes ETag rather than validating an old body",async()=>{
  const original=await formalRecordResponse(request(),"published source","json",face,false);
  const withdrawn=await formalRecordResponse(request("GET",{"if-none-match":original.headers.get("etag")!}),"content unavailable","json",face,false);
  assert.equal(withdrawn.status,200);assert.notEqual(withdrawn.headers.get("etag"),original.headers.get("etag"));
});
test("unlisted responses are never shared-cacheable, including a 304",async()=>{
  const original=await formalRecordResponse(request(),"source","json",face,true);
  assert.equal(original.headers.get("cache-control"),"private, no-store");
  const unchanged=await formalRecordResponse(request("GET",{"if-none-match":original.headers.get("etag")!}),"source","json",face,true);
  assert.equal(unchanged.status,304);assert.equal(unchanged.headers.get("cache-control"),"private, no-store");
});
test("exact read locations and chronological continuations retain their cursor",async()=>{
  const list=await formalRecordResponse(request(),"source","md",face,false);
  assert.match(list.headers.get("link")!,/formal.md\?through=90&after=8/);
  assert.match(list.headers.get("link")!,/schemas\/formal-records.v1.json/);
  const exact=await formalRecordResponse(request(),"source","json",{...face,target:"E-20",next_after:null},false);
  assert.equal(exact.headers.get("content-location"),"/p/P-DEMO/formal.json?through=90&target=E-20");
  assert.ok(!exact.headers.get("link")?.includes('rel="next"'));
});
test("large Unicode output is refused whole by byte bound, never clipped",async()=>{
  const text="𝒙".repeat(FORMAL_READ_MAX_RESPONSE_BYTES/4+1);
  assert.ok(text.length<FORMAL_READ_MAX_RESPONSE_BYTES);
  await assert.rejects(formalRecordResponse(request(),text,"json",face,false),/TOO_LARGE/);
});
test("HTML is a non-executing reading face and all representations are nosniff",async()=>{
  for(const format of ["json","md","html"] as const){
    const response=await formalRecordResponse(request(),"safe source",format,face,false);
    assert.equal(response.headers.get("x-content-type-options"),"nosniff");
    if(format==="html")assert.match(response.headers.get("content-security-policy")!,/default-src 'none'/);
  }
});
