import { test } from "bun:test";
import assert from "node:assert/strict";
import { hypothesisKillAdmissionResponse, isHypothesisKillSourceError } from "../../src/sessions/hypothesis-kill-admission.ts";

const marker = "HYPOTHESIS_KILL_SOURCE_INVALID";
const refusal = () => Response.json({code:"EVIDENCE_BODY_INVALID"},{status:422,headers:{"cache-control":"private, no-store"}});
for (const message of [marker, `D1_ERROR: ${marker}: SQLITE_CONSTRAINT`, `SQLITE_CONSTRAINT_TRIGGER: ${marker}`]) {
  test(`recognizes the fixed database marker in ${message}`, () => {
    assert.equal(isHypothesisKillSourceError(new Error(message)),true);
    assert.equal(hypothesisKillAdmissionResponse(new Error(message),new Response(null,{status:500}),refusal).status,422);
  });
}
test("recognizes a bounded D1 cause chain without reflecting database contents", async () => {
  const error=new Error("outer PRIVATE-DETAIL",{cause:new Error(marker+": PRIVATE-SQL")});
  const response=hypothesisKillAdmissionResponse(error,new Response("internal",{status:500}),refusal);
  assert.equal(response.status,422); assert.doesNotMatch(await response.text(),/PRIVATE|SQL/);
  assert.equal(response.headers.get("cache-control"),"private, no-store");
});
for(const status of [200,201,204,400,401,403,409,422,429]) {
  test(`preserves original ${status} responses even with a prior guard error`, () => {
    const original=new Response(null,{status}); let called=0;
    assert.equal(hypothesisKillAdmissionResponse(new Error(marker),original,()=>{called++;return refusal();}),original);
    assert.equal(called,0);
  });
}
for(const message of ["connection lost", "other constraint", "X_HYPOTHESIS_KILL_SOURCE_INVALID", marker+"_OTHER", "", "x".repeat(4100)+marker]) {
  test(`does not misclassify a different final failure: ${message.slice(0,60)}`, () => {
    const original=new Response(null,{status:500});
    assert.equal(hypothesisKillAdmissionResponse(new Error(message),original,refusal),original);
  });
}
test("a guard-shaped response body is not evidence of a database abort", () => {
  const original=new Response(marker,{status:500});
  assert.equal(hypothesisKillAdmissionResponse(undefined,original,refusal),original);
});
test("a final ambiguous failure after an earlier abort is not declared rolled back", () => {
  const earlier=new Error(marker); assert.ok(isHypothesisKillSourceError(earlier));
  const original=new Response("Retry the same key",{status:503});
  assert.equal(hypothesisKillAdmissionResponse(new Error("replay read unavailable"),original,refusal),original);
});
test("cyclic, deep and throwing error objects fail closed", () => {
  const cyclic:{cause?:unknown}={};cyclic.cause=cyclic;
  assert.equal(isHypothesisKillSourceError(cyclic),false);
  let deep:Error=new Error(marker); for(let n=0;n<8;n++) deep=new Error("wrapper",{cause:deep});
  assert.equal(isHypothesisKillSourceError(deep),false);
  assert.equal(isHypothesisKillSourceError({get message(){throw new Error("do not reflect");}}),false);
  for(const value of [null,undefined,0,marker,{}]) assert.equal(isHypothesisKillSourceError(value),false);
});
