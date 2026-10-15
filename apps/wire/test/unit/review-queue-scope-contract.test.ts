import { test } from "bun:test";
import assert from "node:assert/strict";
import { ReviewQueueQuerySchema } from "@asimposium/contracts/review-queue";

// Canonical Zod boundary. These tests are separate from the explicit fixture-
// fold SQL lane; source-side snapshot options are never public request fields.
for (const field of ["includeUnlisted", "include_unlisted", "through", "snapshot"]) {
  test(`public review discovery refuses the internal ${field} option`, () => {
    assert.equal(ReviewQueueQuerySchema.safeParse({ problem: "P-DEMO", [field]: true }).success, false);
  });
}
test("ordinary problem-scoped public query remains unchanged", () => {
  assert.deepEqual(ReviewQueueQuerySchema.parse({ problem: "P-DEMO" }), { problem: "P-DEMO" });
});
