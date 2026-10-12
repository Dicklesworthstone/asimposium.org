import { test } from "bun:test";
import assert from "node:assert/strict";
import { HypothesisItemQuerySchema } from "../../src/hypotheses.ts";
import { generateHypothesesSchema } from "../../src/hypotheses-schema.ts";

test("exact item query reuses the safe canonical problem-cursor vocabulary", () => {
  for (const query of [{}, { through: "0" }, { through: "10" }, { through: String(Number.MAX_SAFE_INTEGER) }])
    assert.ok(HypothesisItemQuerySchema.safeParse(query).success);
  for (const through of ["01", "-1", "+1", "1.0", "1e3", "1\n", " 1", String(Number.MAX_SAFE_INTEGER + 1), 1, null])
    assert.equal(HypothesisItemQuerySchema.safeParse({ through }).success, false);
});
test("an exact item cannot silently accept a list cursor or unknown authority", () => {
  for (const query of [{ after: "0" }, { through: "2", after: "1" }, { target: "H-1" }, { include_private: true }])
    assert.equal(HypothesisItemQuerySchema.safeParse(query).success, false);
});
test("the canonical source generator exposes the exact-item query without a handwritten copy", () => {
  const schema = JSON.parse(generateHypothesesSchema());
  assert.deepEqual(schema.properties.item_query.properties.through, schema.properties.query.properties.through);
  assert.equal(schema.properties.item_query.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties.item_query.properties, "after"), false);
});
