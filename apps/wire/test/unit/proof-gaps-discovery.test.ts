import { test } from "bun:test";
import assert from "node:assert/strict";
import { PROOF_GAPS_PUBLIC_READS, proofGapParameters, proofGapResponses } from "../../src/discovery/proof-gaps-discovery.ts";
import { HYPOTHESES_PUBLIC_READS, hypothesesParameters, hypothesesResponses } from "../../src/discovery/hypotheses-discovery.ts";

const origin = "https://a-staging.asimposium.org";
test("the mounted gap reads reach the manifest consumed by capabilities and OpenAPI", () => {
  assert.equal(Object.keys(PROOF_GAPS_PUBLIC_READS).length, 4);
  for (const [route, description] of Object.entries(PROOF_GAPS_PUBLIC_READS)) {
    assert.equal(HYPOTHESES_PUBLIC_READS[route], description);
    assert.match(route, /^GET \/p\/:id\/gaps/);
  }
});
test("all gap representations document the actual target and snapshot contracts", () => {
  for (const suffix of ["", ".json", ".md", ".html"]) {
    const params = hypothesesParameters(`/p/{id}/gaps${suffix}`, origin) as any[];
    assert.deepEqual(params.map(item => item.name), ["through", "after", "target"]);
    assert.ok(params.every(item => item.schema.$ref.startsWith(`${origin}/schemas/proof-gaps.v1.json#`)));
    assert.match(params[2].description, /Cannot be combined with after/);
  }
});
test("gap JSON is structured while Markdown and HTML expose reading representations", () => {
  const result = hypothesesResponses("/p/{id}/gaps.json", origin) as any;
  assert.equal(result["200"].content["application/json"].schema.$ref, `${origin}/schemas/proof-gaps.v1.json#/properties/response`);
  assert.ok(result["304"]);
  for (const [suffix, media] of [["md", "text/markdown"], ["html", "text/html"]]) {
    assert.ok((hypothesesResponses(`/p/{id}/gaps.${suffix}`, origin) as any)["200"].content[media]);
  }
});
test("the suffixless gap route promises a redirect rather than a fabricated 200", () => {
  const response = hypothesesResponses("/p/{id}/gaps", origin) as any;
  assert.ok(response["308"]); assert.equal(response["200"], undefined);
});
test("existing hypothesis queries and schema references remain unchanged", () => {
  const parameters = hypothesesParameters("/p/{id}/hypotheses.json", origin) as any[];
  assert.deepEqual(parameters.map(item => item.name), ["through", "after"]);
  assert.match(parameters[0].schema.$ref, /schemas\/hypotheses.v1.json#/);
  assert.match((hypothesesResponses("/p/{id}/hypotheses.json", origin) as any)["200"].content["application/json"].schema.$ref, /schemas\/hypotheses.v1.json#/);
});
test("unrelated and unsupported paths cannot borrow a gap contract", () => {
  for (const path of ["/p/{id}/gaps.toon", "/p/{id}/gaps.json/extra", "/v1/p/{id}/gaps", "/p/{id}/gaps.json\n"]) {
    assert.equal(proofGapParameters(path, origin), undefined);
    assert.equal(proofGapResponses(path, origin), undefined);
  }
});
