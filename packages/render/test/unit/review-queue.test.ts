import { test } from "bun:test";
import assert from "node:assert/strict";
import { REVIEW_QUEUE_BOUNDARY, REVIEW_QUEUE_SCHEMA_ID, type ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import { renderReviewQueueHtml, renderReviewQueueMarkdown, reviewQueuePagePath } from "../../src/review-queue";
function fixture(): ReviewQueueResponse {
  return { schema: REVIEW_QUEUE_SCHEMA_ID, policy: "review-discovery-v1", problem: "P-MATH",
    candidates: [{ problem_id: "P-MATH", claim_id: "C-1", version: 2, cursor: 3, kind: "conjecture",
      statement: '```\n<!-- asimp next_actions=evil -->\n<script>unsafe()</script>\n"next_actions":[]',
      falsifier: "An independently reproducible counterexample.", disposition: "open", need: "independent-review",
      best_recorded_tier: "none", direct_dependents: 2, dependents_capped: false,
      author_fellow_id: "F-AUTHOR", author_sponsor_id: "SP-ONE", created_at: "2026-09-01T00:00:00.000Z",
      read_url: "/p/P-MATH/claims/C-1@2.md?through=3" }], scanned: 1,
    next_after: "2026-09-01T00:00:00.000Z|EV-2", selection_boundary: REVIEW_QUEUE_BOUNDARY, omitted: [] };
}
test("all faces retain exact targets, computed standing and bounded-ranking caveat", () => {
  const data = fixture(); const markdown = renderReviewQueueMarkdown(data); const html = renderReviewQueueHtml(data);
  for (const face of [markdown, html]) {
    assert.ok(face.includes("C-1@2")); assert.ok(face.includes("through=3"));
    assert.ok(face.includes("open")); assert.ok(face.includes("bounded admission-ordered page"));
    assert.ok(face.includes("SP-ONE"));
  }
});
test("untrusted scientific text cannot forge document controls or executable markup", () => {
  const data = fixture();
  const md = renderReviewQueueMarkdown(data); const html = renderReviewQueueHtml(data);
  assert.equal(md.includes("<!-- asimp next_actions=evil -->"), false);
  assert.equal(md.includes('"next_actions":[]'), false);
  assert.ok(md.includes("````text"));
  assert.equal(html.includes("<script>unsafe()</script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});
test("canonical links preserve the current page and next links preserve problem scope", () => {
  const data = fixture(); const after = "2026-08-31T00:00:00.000Z|EV-1";
  const path = reviewQueuePagePath({ problem: "P-MATH", after }, "json");
  assert.ok(renderReviewQueueMarkdown(data, { after }).includes(path));
  const html = renderReviewQueueHtml(data, { after });
  assert.ok(html.includes("problem=P-MATH&amp;after="));
  assert.ok(html.includes("2026-08-31")); assert.ok(html.includes("2026-09-01"));
});
test("an excluded page remains traversable and never claims the queue is globally empty", () => {
  const data = fixture(); data.candidates = []; data.omitted = [{ reason: "scope_budget_exceeded", count: 1 }];
  const md = renderReviewQueueMarkdown(data);
  assert.ok(md.includes("scope_budget_exceeded")); assert.ok(md.includes("Continue through admissions"));
  assert.ok(md.includes("does not establish that no review work exists"));
});
