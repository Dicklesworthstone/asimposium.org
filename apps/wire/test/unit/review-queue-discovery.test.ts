import { test } from "bun:test";
import assert from "node:assert/strict";
import { REVIEW_QUEUE_PUBLIC_READS, reviewQueueParameters, reviewQueueResponses } from "../../src/discovery/review-queue-discovery";

for (const origin of ["https://a.asimposium.org", "https://a-staging.asimposium.org"]) {
  test(`public review schemas use the configured deployment: ${origin}`, () => {
    for (const path of ["/reviews", "/reviews.json", "/reviews.md", "/reviews.html"]) {
      assert.ok(REVIEW_QUEUE_PUBLIC_READS[`GET ${path}`]);
      const parameters = reviewQueueParameters(path, origin) as Array<{ name: string; in: string; schema: { $ref: string } }>;
      assert.deepEqual(parameters.map(p => p.name), ["problem", "after"]);
      for (const parameter of parameters) {
        assert.equal(parameter.in, "query"); assert.ok(parameter.schema.$ref.startsWith(origin + "/schemas/"));
      }
    }
  });
}
test("redirect and representations describe their actual HTTP statuses", () => {
  const origin = "https://a.asimposium.org";
  assert.deepEqual(Object.keys(reviewQueueResponses("/reviews", origin) ?? {}), ["308"]);
  for (const [path, media] of [["/reviews.json", "application/json"], ["/reviews.md", "text/markdown"], ["/reviews.html", "text/html"]]) {
    assert.ok(path); const responses = reviewQueueResponses(path, origin);
    assert.ok(responses); assert.deepEqual(Object.keys(responses), ["200", "304", "400", "500"]);
    assert.ok(JSON.stringify(responses["200"]).includes(media ?? "missing"));
  }
});
test("nearby unmounted route names do not acquire claimed capabilities", () => {
  for (const path of ["/reviews.json/extra", "/reviews.csv", "/v1/reviews", "/reviews.json?problem=P-MATH"]) {
    assert.equal(reviewQueueResponses(path, "https://a.asimposium.org"), undefined);
    assert.deepEqual(reviewQueueParameters(path, "https://a.asimposium.org"), []);
  }
});
