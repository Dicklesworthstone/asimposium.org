import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import {
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_SCHEMA_ID,
  ReviewQueueResponseSchema,
  type ReviewQueueResponse,
  type ReviewQueueItem,
} from "@asimposium/contracts/review-queue";
import { renderToStaticMarkup } from "react-dom/server";
import { humanReviewQueuePath, normalizeReviewQueueForm, reviewQueueClaimPath, reviewQueueMatchesQuery } from "../../lib/review-queue-view";

mock.module("server-only", () => ({}));
const { default: ReviewsPage } = await import("../../app/reviews/page");

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

test("review candidates render safe mathematics and retain distinct complete sources and canonical order", async () => {
  const statement = String.raw`**A finite check:** $\frac{n(n+1)}{2}$.[^source]

| n | sum |
| --- | --- |
| 2 | 3 |

<script>window.__reviewXss=1</script><img src=x onerror="window.__reviewXss=2">
[unsafe](javascript:window.__reviewXss=3)

[^source]: An independently checkable calculation.`;
  const falsifier = String.raw`A finite $n$ with $\frac{n(n+1)}{2} \ne \sum_{k=1}^n k$.[^source]

Malformed TeX remains readable: $\frac{1}{$.

[^source]: A specific counterexample, not a claim of certainty.`;
  const candidate = (claim_id: string, body: string, counterexample: string | null) => ({
    problem_id: "P-MATH", claim_id, version: 2, cursor: 5, kind: "conjecture",
    statement: body, falsifier: counterexample, disposition: "open", need: "cross-family-review",
    best_recorded_tier: "T1", direct_dependents: 2, dependents_capped: false,
    author_fellow_id: "F-AUTHOR", author_sponsor_id: "usr_author",
    created_at: "2026-11-14T00:00:00.000Z",
    read_url: `/p/P-MATH/claims/${claim_id}@2.md?through=5`,
    screening_notice: { action: "published-with-warning", notice: "off-scope", category: "off-topic" },
  });
  const data = ReviewQueueResponseSchema.parse({
    schema: REVIEW_QUEUE_SCHEMA_ID, policy: "review-discovery-v1", problem: "P-MATH",
    candidates: [candidate("C-2", statement, falsifier), candidate("C-1", statement, falsifier),
      candidate("C-3", "A claim kind with no recorded falsifier.", null)],
    scanned: 3, next_after: null, selection_boundary: REVIEW_QUEUE_BOUNDARY, omitted: [],
  });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      assert.equal(new URL(request.url).pathname, "/reviews.json");
      assert.equal(new URL(request.url).search, "?problem=P-MATH");
      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.headers.get("cookie"), null);
      return Response.json(data);
    },
  });
  const previous = process.env.STOA_ORIGIN;
  try {
    process.env.STOA_ORIGIN = `http://127.0.0.1:${server.port}`;
    const html = renderToStaticMarkup(await ReviewsPage({
      searchParams: Promise.resolve({ problem: "P-MATH" }),
    }));
    assert.ok(html.includes('class="katex"'));
    assert.ok(html.includes("<mfrac>"));
    assert.ok(html.includes("<strong>A finite check:</strong>"));
    assert.ok(html.includes("<table>"));
    assert.ok(html.includes('data-math-rendered="false"'));
    assert.equal((html.match(/class="asimp-source"/g) ?? []).length, 5);
    const footnotes = [...html.matchAll(/id="([^"]+-fn-1)"/g)].map(match => match[1]);
    assert.equal(footnotes.length, 4);
    assert.equal(new Set(footnotes).size, 4, "claim and field namespaces cannot borrow another footnote");
    assert.ok(html.includes("&lt;script&gt;window.__reviewXss=1&lt;/script&gt;"));
    assert.ok(!html.includes("<script>window.__reviewXss"));
    assert.ok(!html.includes('<img src="x"'));
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(html.includes("Not recorded for this claim kind."));
    assert.ok(html.indexOf("P-MATH / C-2@2") < html.indexOf("P-MATH / C-1@2"));
    assert.ok(html.includes('href="/p/P-MATH/claims/C-2@2?through=5"'));
    assert.ok(html.includes("review=C-2%402&amp;review_through=5"));
    assert.ok(html.includes('href="' + process.env.STOA_ORIGIN + '/reviews.md?problem=P-MATH"'));
    assert.ok(html.includes("Best recorded qualifying review tier: T1"));
    assert.ok(html.includes("F-AUTHOR") && html.includes("usr_author"));
    assert.ok(html.indexOf("Off-scope science") < html.indexOf("A finite check:"));
    assert.ok(html.includes(REVIEW_QUEUE_BOUNDARY));
  } finally {
    if (previous === undefined) delete process.env.STOA_ORIGIN;
    else process.env.STOA_ORIGIN = previous;
    await server.stop(true);
  }
});
