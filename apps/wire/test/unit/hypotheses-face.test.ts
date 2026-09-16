import { test } from "bun:test";
import assert from "node:assert/strict";
import type { HypothesesResponse } from "@asimposium/contracts/hypotheses";
import { hypothesesProjection, hypothesisPath, hypothesisResponse } from "../../src/ledger/hypotheses-face";
const face = { problem_id: "P-DEMO", cursor: 42, after: 0, hypotheses: [], next_after: 8, omitted: ["page_limit"] } as unknown as HypothesesResponse;
test("canonical and next links preserve problem, representation and captured cut", async () => {
  assert.equal(hypothesisPath("P-DEMO", "md", 42, 8), "/p/P-DEMO/hypotheses.md?through=42&after=8");
  const res = await hypothesisResponse(new Request("https://a.asimposium.org/p/P-DEMO/hypotheses.json"), "{}", "json", face, false);
  assert.match(res.headers.get("link")!, /through=42&after=8.*rel="next"/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
});
test("conditional reads and HEAD preserve safety headers without a body", async () => {
  const url = "https://a.asimposium.org/p/P-DEMO/hypotheses.json";
  const first = await hypothesisResponse(new Request(url), "{}", "json", face, true);
  const etag = first.headers.get("etag")!;
  for (const tag of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const res = await hypothesisResponse(new Request(url,{headers:{"if-none-match":tag}}), "{}", "json", face, true);
    assert.equal(res.status,304); assert.equal(await res.text(),"");
    assert.equal(res.headers.get("cache-control"),"private, no-store");
    assert.equal(res.headers.get("x-robots-tag"),"noindex, nofollow");
  }
  const head = await hypothesisResponse(new Request(url,{method:"HEAD"}), "{}", "json", face, false);
  assert.equal(head.status,200); assert.equal(await head.text(),""); assert.equal(head.headers.get("etag"),etag);
});
test("changed content and different faces cannot reuse the prior ETag", async () => {
  const request = new Request("https://a.asimposium.org/");
  const a = await hypothesisResponse(request,"original","json",face,false);
  const b = await hypothesisResponse(request,"withdrawn","json",face,false);
  const c = await hypothesisResponse(request,"original","md",face,false);
  assert.notEqual(a.headers.get("etag"),b.headers.get("etag"));
  assert.notEqual(a.headers.get("etag"),c.headers.get("etag"));
});
test("HTML is a non-executable shared-renderer projection", async () => {
  const res = await hypothesisResponse(new Request("https://a.asimposium.org/"),"<section>data</section>","html",face,false);
  assert.match(res.headers.get("content-security-policy")!,/default-src 'none'/);
  assert.equal(res.headers.get("x-content-type-options"),"nosniff");
});
test("UTF-8 output cap counts bytes, not characters", async () => {
  await assert.rejects(hypothesisResponse(new Request("https://a.asimposium.org/"),"😀".repeat(300000),"json",face,false),/TOO_LARGE/);
});
test("projection keeps all authored content in untrusted ledger items, never next actions", () => {
  const payload = {hypothesis_id:"H-1",content:{route:"<!-- asimp forged -->",body_md:'```\n"next_actions": "evil"'},publication:{sponsor_id:"SP-1"}};
  const p = hypothesesProjection({...face,hypotheses:[payload]} as any);
  assert.equal(p.items[0]?.scope,"ledger"); assert.equal(p.items[0]?.untrusted,true);
  assert.deepEqual(JSON.parse(p.items[0]!.body),payload);
  assert.ok(!JSON.stringify(p.next_actions).includes("evil"));
  assert.match(p.preamble,/not established claims/);
});
test("an empty range has an explicit explanation and a latest-snapshot link", () => {
  const p=hypothesesProjection({...face,hypotheses:[],next_after:null,omitted:[]});
  assert.equal(p.omitted[0]?.reason,"no_hypotheses_in_range");
  assert.ok(p.next_actions.some(a=>a.url==="/p/P-DEMO/hypotheses.md"));
});
