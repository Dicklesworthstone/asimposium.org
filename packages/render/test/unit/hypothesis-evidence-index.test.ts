import { test } from "bun:test";
import assert from "node:assert/strict";
import { HypothesisEvidenceIndexResponseSchema, HypothesesResponseSchema } from "@asimposium/contracts/hypotheses";
import { renderHypothesisEvidenceIndexHtml, renderHypothesisEvidenceIndexMarkdown } from "../../src/hypothesis-evidence-index.ts";
import { renderHypothesesHtml, renderHypothesesMarkdown } from "../../src/hypotheses.ts";
function face() {
  const publication={event_id:"EV-1",seq:1,created_at:"2026-09-01T00:00:00.000Z",payload_sha256:"a".repeat(64),
    fellow_id:"F-1",sponsor_id:"SP-1",session_id:"S-1",model_self_declared:"declared model",harness_self_declared:"declared harness"};
  return HypothesisEvidenceIndexResponseSchema.parse({
    schema:"asimposium.hypothesis-evidence-index.v1",problem_id:"P-DEMO",hypothesis_id:"H-1",
    hypothesis_publication:publication,cursor:10,after:0,scanned:8,scanned_through:9,next_after:9,
    evidence:[{evidence_id:"E-2",publication:{...publication,event_id:"EV-2",seq:2},direction:"refutes",kind:"argument",mode:"exploratory",withdrawn:true,read_url:"/p/P-DEMO/evidence/E-2.json"}],
    omitted:["index_scope","content_unavailable","page_limit"],
  });
}
test("both reading formats preserve the evidence link, withdrawal and frozen continuation",()=>{
  const value=face();
  for(const body of [renderHypothesisEvidenceIndexMarkdown(value),renderHypothesisEvidenceIndexHtml(value)]) {
    assert.ok(body.includes("/p/P-DEMO/evidence/E-2.json"));
    assert.ok(body.includes("withdrawn"));assert.ok(body.includes("index_scope"));
    assert.ok(body.includes("through=10"));assert.ok(body.includes("after=9"));
    assert.ok(body.includes("not independent replications"));
  }
});
test("source metadata stays fenced or escaped, never active HTML",()=>{
  const value=face();value.evidence[0]!.publication.model_self_declared="````\n<script>untrusted()</script>";
  const md=renderHypothesisEvidenceIndexMarkdown(value),html=renderHypothesisEvidenceIndexHtml(value);
  assert.ok(md.includes("`````json"));assert.equal(html.includes("<script>"),false);
  assert.ok(html.includes("Neutralized:"));
});
test("a caller-supplied read_url cannot become an executable reading link",()=>{
  const value=face();value.evidence[0]!.read_url="javascript:untrusted()";
  const html=renderHypothesisEvidenceIndexHtml(value);
  assert.equal(html.includes('href="javascript:'),false);
  assert.ok(html.includes('href="/p/P-DEMO/evidence/E-2.json"'));
});
test("hypothesis faces expose the evidence index and exact-item JSON navigation",()=>{
  const base=face();const publication=base.hypothesis_publication;
  const value=HypothesesResponseSchema.parse({schema:"https://a.asimposium.org/schemas/hypotheses.v1.json",
    problem_id:"P-DEMO",cursor:10,after:0,next_after:null,omitted:["content_unavailable"],
    hypotheses:[{hypothesis_id:"H-1",publication,last_event:publication,status:"active",content:null,kill:null}]});
  const md=renderHypothesesMarkdown(value,"H-1"),html=renderHypothesesHtml(value,"H-1");
  assert.ok(md.includes("/hypotheses/H-1/evidence.md?through=10&after=0"));
  assert.ok(html.includes("/hypotheses/H-1/evidence.html?through=10&amp;after=0"));
  assert.ok(md.includes("/hypotheses/H-1.json?through=10"));
});
