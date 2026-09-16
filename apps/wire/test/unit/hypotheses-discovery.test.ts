import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  HYPOTHESES_PUBLIC_READS,
  hypothesesParameters,
  hypothesesResponses,
} from "../../src/discovery/hypotheses-discovery";

test("the hypothesis census advertises only the three mounted public reading faces", () => {
  assert.deepEqual(Object.keys(HYPOTHESES_PUBLIC_READS), [
    "GET /p/:id/hypotheses.json",
    "GET /p/:id/hypotheses.md",
    "GET /p/:id/hypotheses.html",
  ]);
  assert.equal(
    hypothesesResponses("/p/{id}/hypotheses.toon", "https://a.asimposium.org"),
    undefined,
  );
  assert.deepEqual(hypothesesParameters("/p/{id}/hypotheses", "https://a.asimposium.org"), []);
});
test("query pointers use the same deployment origin and expose no internal selection controls", () => {
  const q = hypothesesParameters(
    "/p/{id}/hypotheses.json",
    "https://a-staging.asimposium.org",
  ) as any[];
  assert.deepEqual(
    q.map((x) => x.name),
    ["through", "after"],
  );
  assert.ok(
    q.every((x) =>
      x.schema.$ref.startsWith("https://a-staging.asimposium.org/schemas/hypotheses.v1.json"),
    ),
  );
  assert.ok(!JSON.stringify(q).includes("liveOnly"));
});
test("representation metadata matches the suffix and pins canonical JSON response shape", () => {
  for (const [suffix, media] of [
    ["json", "application/json"],
    ["md", "text/markdown"],
    ["html", "text/html"],
  ] as const) {
    const r = hypothesesResponses(
      `/p/{id}/hypotheses.${suffix}`,
      "https://a.asimposium.org",
    ) as any;
    assert.deepEqual(Object.keys(r["200"].content), [media]);
    assert.ok(r["304"]);
    if (suffix === "json")
      assert.equal(
        r["200"].content[media].schema.$ref,
        "https://a.asimposium.org/schemas/hypotheses.v1.json#/properties/response",
      );
  }
});
