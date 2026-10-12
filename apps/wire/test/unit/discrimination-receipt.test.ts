import { test } from "bun:test";
import assert from "node:assert/strict";
import { discriminationReceiptLinks, withDiscriminationReadLinks } from "../../src/sessions/discrimination-receipt.ts";
const context = { problemId: "P-TEST", hypotheses: ["H-1", "H-2"] };
function receipt() {
  return { ok: true, problem_id: "P-TEST", results: [
    { tempId: "tmp:discriminate-H-1", action: "evidence", id: "E-ABC", seq: 12 },
    { tempId: "tmp:discriminate-H-2", action: "evidence", id: "E-DEF", seq: 13 },
  ] };
}
function response(value: unknown, status = 201) {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json", "cache-control": "private, no-store", "x-writer": "canonical",
    link: '</protocol.md>; rel="help"',
  } });
}
test("complete receipt links each target to its actual returned evidence", () => {
  assert.deepEqual(discriminationReceiptLinks(receipt(), context), [
    '</p/P-TEST/evidence/E-ABC.json>; rel="item"; type="application/json"; title="Evidence for H-1"',
    '</p/P-TEST/evidence/E-DEF.json>; rel="item"; type="application/json"; title="Evidence for H-2"',
  ]);
});
test("topological receipt order is mapped back to target order", () => {
  const value = receipt(); value.results.reverse();
  assert.deepEqual(discriminationReceiptLinks(value, context), discriminationReceiptLinks(receipt(), context));
});
for (const status of [200, 201]) {
  test(`fresh/replayed ${status} keeps exact body and existing headers`, async () => {
    const original = response(receipt(), status);
    const linked = await withDiscriminationReadLinks(original, context);
    assert.equal(linked.status, status);
    assert.equal(linked.headers.get("cache-control"), "private, no-store");
    assert.equal(linked.headers.get("x-writer"), "canonical");
    assert.match(linked.headers.get("link")!, /rel="help"/);
    assert.match(linked.headers.get("link")!, /rel="describedby"/);
    assert.match(linked.headers.get("link")!, /E-ABC.json/);
    assert.match(linked.headers.get("link")!, /E-DEF.json/);
    assert.equal(await linked.text(), JSON.stringify(receipt()));
  });
}
for (const status of [400, 401, 403, 409, 422, 429, 500, 503]) {
  test(`never turns writer refusal ${status} into successful evidence links`, async () => {
    const original = response(receipt(), status);
    assert.equal(await withDiscriminationReadLinks(original, context), original);
  });
}
for (const [name, alter] of [
  ["wrong problem", (v: any) => { v.problem_id = "P-OTHER"; }],
  ["missing member", (v: any) => { v.results.pop(); }],
  ["extra member", (v: any) => { v.results.push(v.results[0]); }],
  ["wrong action", (v: any) => { v.results[0].action = "claim"; }],
  ["wrong temporary target", (v: any) => { v.results[0].tempId = "tmp:discriminate-H-9"; }],
  ["duplicate target", (v: any) => { v.results[1].tempId = v.results[0].tempId; }],
  ["duplicate evidence", (v: any) => { v.results[1].id = v.results[0].id; }],
  ["duplicate sequence", (v: any) => { v.results[1].seq = v.results[0].seq; }],
  ["unsafe sequence", (v: any) => { v.results[0].seq = Number.MAX_SAFE_INTEGER + 1; }],
  ["zero sequence", (v: any) => { v.results[0].seq = 0; }],
  ["fractional sequence", (v: any) => { v.results[0].seq = 1.5; }],
  ["unexpected version", (v: any) => { v.results[0].version = 2; }],
  ["unsafe ID", (v: any) => { v.results[0].id = 'E-X>; rel="hijack"'; }],
  ["newline ID", (v: any) => { v.results[0].id += "\n"; }],
  ["not successful", (v: any) => { v.ok = false; }],
] as const) {
  test(`withholds all navigation for ${name}`, async () => {
    const value = receipt(); alter(value);
    assert.deepEqual(discriminationReceiptLinks(value, context), []);
    const original = response(value);
    assert.equal(await withDiscriminationReadLinks(original, context), original);
    assert.equal(await original.text(), JSON.stringify(value));
  });
}
test("explicit immutable evidence version one is accepted", () => {
  const value: any = receipt(); value.results.forEach((r: any) => { r.version = 1; });
  assert.equal(discriminationReceiptLinks(value, context).length, 2);
});
test("malformed expected context cannot create links", () => {
  for (const hypotheses of [[], ["H-1"], ["H-1", "H-1"], ["H-1", "H-2\n"], Array(9).fill("H-1")]) {
    assert.deepEqual(discriminationReceiptLinks(receipt(), { ...context, hypotheses }), []);
  }
  for (const problemId of ["", "P-TEST/OTHER", "P-TEST\n", "P-X?key=1"]) {
    assert.deepEqual(discriminationReceiptLinks({ ...receipt(), problem_id: problemId }, { ...context, problemId }), []);
  }
});
test("malformed or non-JSON successful body is returned unchanged", async () => {
  for (const [body, type] of [["{", "application/json"], [JSON.stringify(receipt()), "text/plain"]]) {
    const original = new Response(body, { status: 200, headers: { "content-type": type! } });
    assert.equal(await withDiscriminationReadLinks(original, context), original);
    assert.equal(await original.text(), body);
  }
});
test("oversized receipt adds no links and preserves the full original stream", async () => {
  const value = { ...receipt(), padding: "x".repeat(16384) };
  const original = response(value);
  assert.equal(await withDiscriminationReadLinks(original, context), original);
  assert.equal(await original.text(), JSON.stringify(value));
});
test("ordinary receipt remains one experiment, not new scientific verification", async () => {
  const linked = await withDiscriminationReadLinks(response(receipt()), context);
  const body = await linked.json();
  assert.deepEqual(body, receipt());
  for (const name of ["verified", "independence_tier", "experiment_passed"]) assert.equal(Object.hasOwn(body, name), false);
});
