import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ReviewQueueResponse, ReviewQueueItem } from "@asimposium/contracts/review-queue";
import { humanReviewQueuePath, normalizeReviewQueueForm, reviewQueueClaimPath, reviewQueueMatchesQuery } from "../../lib/review-queue-view";

function face(problem: string | null = null, next: string | null = null, scanned = 8): ReviewQueueResponse {
  return { problem, next_after: next, scanned } as ReviewQueueResponse;
}
test("blank form clears only the problem field", () => {
  assert.deepEqual(normalizeReviewQueueForm({ problem: "", after: undefined }), {});
  assert.deepEqual(normalizeReviewQueueForm({ problem: "P-MATH", after: "cursor" }), { problem: "P-MATH", after: "cursor" });
});
test("duplicate/unknown form fields are not silently dropped before schema validation", () => {
  const input = { problem: ["P-ONE", "P-TWO"], unknown: "x" };
  assert.deepEqual(normalizeReviewQueueForm(input), input);
  assert.deepEqual(normalizeReviewQueueForm({ after: "" }), { after: "" });
});
test("global and scoped responses cannot impersonate one another", () => {
  assert.equal(reviewQueueMatchesQuery({}, face()), true);
  assert.equal(reviewQueueMatchesQuery({}, face("P-MATH")), false);
  assert.equal(reviewQueueMatchesQuery({ problem: "P-MATH" }, face()), false);
  assert.equal(reviewQueueMatchesQuery({ problem: "P-MATH" }, face("P-OTHER")), false);
  assert.equal(reviewQueueMatchesQuery({ problem: "P-MATH" }, face("P-MATH")), true);
});
test("continuations must advance past the requested admission", () => {
  const after = "2026-09-01T00:00:00.000Z|EV-2";
  assert.equal(reviewQueueMatchesQuery({ after }, face(null, after)), false);
  assert.equal(reviewQueueMatchesQuery({ after }, face(null, "2026-09-01T00:00:00.000Z|EV-1")), false);
  assert.equal(reviewQueueMatchesQuery({ after }, face(null, "2026-09-01T00:00:00.000Z|EV-3")), true);
  assert.equal(reviewQueueMatchesQuery({ after }, face()), true);
});
test("a zero-scan response cannot invent another page", () => {
  assert.equal(reviewQueueMatchesQuery({}, face(null, "2026-09-01T00:00:00.000Z|EV-3", 0)), false);
});
test("human queue links retain scope and cursor without query injection", () => {
  const after = "2026-09-01T00:00:00.000Z|EV-2";
  const url = new URL(humanReviewQueuePath({ problem: "P-MATH", after }), "https://asimposium.org");
  assert.equal(url.pathname, "/reviews"); assert.equal(url.searchParams.get("problem"), "P-MATH");
  assert.equal(url.searchParams.get("after"), after); assert.equal(url.searchParams.size, 2);
  assert.equal(humanReviewQueuePath({}), "/reviews");
});
test("claim links retain both immutable version and problem-local cut", () => {
  const item = { problem_id: "P-MATH", claim_id: "C-1", version: 2, cursor: 5 } as ReviewQueueItem;
  assert.equal(reviewQueueClaimPath(item), "/p/P-MATH/claims/C-1@2?through=5");
  assert.equal(reviewQueueClaimPath({ ...item, problem_id: "P-OTHER" }), "/p/P-OTHER/claims/C-1@2?through=5");
});
