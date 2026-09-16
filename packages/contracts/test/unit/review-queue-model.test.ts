import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseReviewQueueAfter, reviewQueueAfter } from "../../src/review-queue-model";

test("no cursor means the first admission-ordered page", () => {
  assert.equal(parseReviewQueueAfter(undefined), undefined);
});
test("cursor round trips immutable event identity and real timestamp", () => {
  const createdAt = "2026-09-01T12:30:00.000Z";
  assert.deepEqual(parseReviewQueueAfter(reviewQueueAfter(createdAt, "E-ABC123")), { createdAt, eventId: "E-ABC123" });
});
for (const invalid of ["", "0", "2026-02-30T00:00:00.000Z|E-1", "2026-09-01T00:00:00Z|E-1",
  "2026-09-01T00:00:00.000Z|", "2026-09-01T00:00:00.000Z|E-1|extra",
  "2026-09-01T00:00:00.000Z|../private", "2026-09-01T00:00:00.000Z|E-1\n",
  `2026-09-01T00:00:00.000Z|${"E".repeat(129)}`]) {
  test(`noncanonical continuation is rejected: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => parseReviewQueueAfter(invalid), /REVIEW_QUEUE_CURSOR_INVALID/);
  });
}
