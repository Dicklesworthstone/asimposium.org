import { test } from "bun:test";
import assert from "node:assert/strict";
import { HYPOTHESES_PUBLIC_READS, hypothesesParameters, hypothesesResponses } from "../../src/discovery/hypotheses-discovery.ts";
const origin="https://a-staging.asimposium.org";
for(const suffix of ["json","md","html"]) test(`${suffix} evidence discovery names the mounted path and source-generated query`,()=>{
  const path=`/p/{id}/hypotheses/{hid}/evidence.${suffix}`;
  assert.ok(HYPOTHESES_PUBLIC_READS[`GET /p/:id/hypotheses/:hid/evidence.${suffix}`]);
  const params=hypothesesParameters(path,origin) as any[];
  assert.deepEqual(params.map(p=>p.name),["through","after"]);
  for(const p of params)assert.equal(p.schema.$ref,`${origin}/schemas/hypotheses.v1.json#/properties/evidence_index_query/properties/${p.name}`);
  const responses=hypothesesResponses(path,origin) as any;
  assert.ok(responses[200]);assert.ok(responses[304]);assert.ok(responses.default);
  if(suffix==="json")assert.equal(responses[200].content["application/json"].schema.$ref,`${origin}/schemas/hypotheses.v1.json#/properties/evidence_index_response`);
});
test("unsuffixed evidence discovery describes a redirect, not a fabricated success body",()=>{
  const res=hypothesesResponses("/p/{id}/hypotheses/{hid}/evidence",origin);
  assert.ok(res?.["308"]);assert.equal(res?.["200"],undefined);
});
test("exact hypothesis reads advertise only through; list reads keep after",()=>{
  assert.deepEqual((hypothesesParameters("/p/{id}/hypotheses/{target}",origin) as any[]).map(p=>p.name),["through"]);
  assert.deepEqual((hypothesesParameters("/p/{id}/hypotheses.json",origin) as any[]).map(p=>p.name),["through","after"]);
});
test("gap discovery and unknown-path ownership are preserved",()=>{
  assert.deepEqual((hypothesesParameters("/p/{id}/gaps.json",origin) as any[]).map(p=>p.name),["through","after","target"]);
  assert.equal(hypothesesResponses("/p/{id}/unowned.json",origin),undefined);
});
