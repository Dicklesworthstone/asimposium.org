import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_SCHEMA_ID,
  ReviewQueueQuerySchema,
  ReviewQueueResponseSchema,
} from "../../src/review-queue";
import { generatedReviewQueueArtifact } from "../../src/review-queue-artifact";

function candidate(problem = "P-MATH") {
  return {
    problem_id: problem,
    claim_id: "C-1",
    version: 2,
    cursor: 5,
    kind: "conjecture",
    statement: "An exact, falsifiable example statement.",
    falsifier: "A counterexample in the declared domain.",
    disposition: "open",
    need: "independent-review",
    best_recorded_tier: "none",
    direct_dependents: 0,
    dependents_capped: false,
    author_fellow_id: "F-AUTHOR",
    author_sponsor_id: "SP-ONE",
    created_at: "2026-09-01T00:00:00.000Z",
    read_url: `/p/${problem}/claims/C-1@2.md?through=5`,
  };
}
function response() {
  return {
    schema: REVIEW_QUEUE_SCHEMA_ID,
    policy: "review-discovery-v1",
    problem: null,
    candidates: [candidate()],
    scanned: 1,
    next_after: null,
    selection_boundary: REVIEW_QUEUE_BOUNDARY,
    omitted: [],
  };
}
test("generated review discovery schema is an exact canonical contract artifact", () => {
  const artifact = generatedReviewQueueArtifact();
  assert.equal(artifact.relativePath, "generated/review-queue.schema.json");
  assert.equal(
    readFileSync(new URL("../../generated/review-queue.schema.json", import.meta.url), "utf8"),
    artifact.content,
  );
});
test("empty and populated public queues validate", () => {
  assert.equal(ReviewQueueResponseSchema.safeParse(response()).success, true);
  assert.equal(
    ReviewQueueResponseSchema.safeParse({ ...response(), candidates: [], scanned: 0 }).success,
    true,
  );
});
test("a global queue can contain the same local claim ID in two different problems", () => {
  assert.equal(
    ReviewQueueResponseSchema.safeParse({
      ...response(),
      scanned: 2,
      candidates: [candidate("P-ONE"), candidate("P-TWO")],
    }).success,
    true,
  );
});
for (const field of ["problem", "after", "unknown"]) {
  test(`arrays and uncontracted query fields are refused: ${field}`, () => {
    assert.equal(
      ReviewQueueQuerySchema.safeParse({ [field]: ["P-MATH", "P-OTHER"] }).success,
      false,
    );
  });
}
for (const path of [
  "/p/P-OTHER/claims/C-1@2.md?through=5",
  "/p/P-MATH/claims/C-1.md?through=5",
  "/p/P-MATH/claims/C-1@3.md?through=5",
  "/p/P-MATH/claims/C-1@2.md?through=6",
  "https://external.invalid/",
]) {
  test(`a response cannot retarget its exact read link: ${path}`, () => {
    assert.equal(
      ReviewQueueResponseSchema.safeParse({
        ...response(),
        candidates: [{ ...candidate(), read_url: path }],
      }).success,
      false,
    );
  });
}
test("duplicate targets and mismatched problem scope fail closed", () => {
  assert.equal(
    ReviewQueueResponseSchema.safeParse({
      ...response(),
      scanned: 2,
      candidates: [candidate(), candidate()],
    }).success,
    false,
  );
  assert.equal(
    ReviewQueueResponseSchema.safeParse({ ...response(), problem: "P-OTHER" }).success,
    false,
  );
});
test("untrusted/private extra fields and invented status are not part of this face", () => {
  assert.equal(
    ReviewQueueResponseSchema.safeParse({ ...response(), workshop: "secret" }).success,
    false,
  );
  assert.equal(
    ReviewQueueResponseSchema.safeParse({
      ...response(),
      candidates: [{ ...candidate(), disposition: "proved" }],
    }).success,
    false,
  );
  assert.equal(
    ReviewQueueResponseSchema.safeParse({
      ...response(),
      candidates: [{ ...candidate(), token: "secret" }],
    }).success,
    false,
  );
});
test("future-looking invalid calendar dates and actual trailing controls are refused", () => {
  assert.equal(
    ReviewQueueQuerySchema.safeParse({ after: "2026-02-30T00:00:00.000Z|EV-1" }).success,
    false,
  );
  assert.equal(
    ReviewQueueQuerySchema.safeParse({ after: "2026-09-01T00:00:00.000Z|EV-1\n" }).success,
    false,
  );
  assert.equal(ReviewQueueResponseSchema.safeParse({ ...response(), scanned: 0 }).success, false);
});
