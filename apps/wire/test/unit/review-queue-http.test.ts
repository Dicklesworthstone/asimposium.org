import { test } from "bun:test";
import assert from "node:assert/strict";
import { reviewQueueResponse, REVIEW_QUEUE_MAX_RESPONSE_BYTES } from "../../src/discovery/review-queue-http";

const request = (method = "GET", etag?: string) => new Request("https://a.asimposium.org/reviews.json", {
  method, ...(etag ? { headers: { "if-none-match": etag } } : {}),
});
for (const format of ["json", "md", "html"] as const) {
  test(`${format}: HEAD, cache headers, weak and multiple ETags preserve representation`, async () => {
    const first = await reviewQueueResponse(request(), "public exact version", format);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    const etag = first.headers.get("etag"); assert.ok(etag);
    const head = await reviewQueueResponse(request("HEAD"), "public exact version", format);
    assert.equal(await head.text(), ""); assert.equal(head.headers.get("etag"), etag);
    for (const conditional of [etag, `W/${etag}`, `"another", ${etag}`, "*"]) {
      const next = await reviewQueueResponse(request("GET", conditional), "public exact version", format);
      assert.equal(next.status, 304); assert.equal(await next.text(), "");
      assert.equal(next.headers.get("cache-control"), first.headers.get("cache-control"));
    }
  });
}
test("a withdrawal/omission changes bytes and cannot match an earlier ETag", async () => {
  const old = await reviewQueueResponse(request(), '{"candidates":["old"]}', "json");
  const fresh = await reviewQueueResponse(request("GET", old.headers.get("etag") ?? ""), '{"candidates":[]}', "json");
  assert.equal(fresh.status, 200); assert.notEqual(old.headers.get("etag"), fresh.headers.get("etag"));
});
test("identical text in different formats cannot share a strong ETag", async () => {
  const json = await reviewQueueResponse(request(), "same", "json");
  const md = await reviewQueueResponse(request("GET", json.headers.get("etag") ?? ""), "same", "md");
  assert.equal(md.status, 200); assert.notEqual(json.headers.get("etag"), md.headers.get("etag"));
});
test("exact byte budget is accepted; oversized UTF-8 is refused without truncation", async () => {
  const exact = "x".repeat(REVIEW_QUEUE_MAX_RESPONSE_BYTES);
  assert.equal((await reviewQueueResponse(request(), exact, "md")).status, 200);
  await assert.rejects(() => reviewQueueResponse(request(), exact + "x", "md"), /TOO_LARGE/);
  await assert.rejects(() => reviewQueueResponse(request(), "😀".repeat(REVIEW_QUEUE_MAX_RESPONSE_BYTES / 2), "md"), /TOO_LARGE/);
});
