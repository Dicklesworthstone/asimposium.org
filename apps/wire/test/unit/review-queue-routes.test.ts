import { test } from "bun:test";
import assert from "node:assert/strict";
import { ReviewQueueResponseSchema } from "@asimposium/contracts/review-queue";
import { createDiscoveryRoutes } from "../../src/discovery/router";
import type { Env } from "../../src/env";

/** Unit boundary only: SQL, real D1 and scientific-state behavior have separate tests. */
function emptyDatabase() {
  let reads = 0;
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            reads += 1;
            return { results: [] };
          },
        }),
      }),
    },
  } as unknown as Env;
  return { env, reads: () => reads };
}
for (const face of ["json", "md", "html"]) {
  test(`the production discovery router mounts public reviews.${face}`, async () => {
    const fixture = emptyDatabase();
    const app = createDiscoveryRoutes();
    const response = await app.request(`https://a.asimposium.org/reviews.${face}`, {}, fixture.env);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(fixture.reads(), 1);
    if (face === "json") assert.equal(ReviewQueueResponseSchema.parse(JSON.parse(text)).scanned, 0);
    else assert.ok(text.includes("No eligible candidates"));
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const head = await app.request(
      `https://a.asimposium.org/reviews.${face}`,
      { method: "HEAD" },
      fixture.env,
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const conditional = await app.request(
      `https://a.asimposium.org/reviews.${face}`,
      { headers: { "if-none-match": response.headers.get("etag") ?? "" } },
      fixture.env,
    );
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    assert.equal(
      fixture.reads(),
      3,
      "conditional reads must still recheck current public visibility",
    );
  });
}
for (const query of [
  "?problem=P-ONE&problem=P-TWO",
  "?after=bad",
  "?unknown=x",
  "?problem=../private",
]) {
  test(`invalid query is rejected before database access: ${query}`, async () => {
    const fixture = emptyDatabase();
    const app = createDiscoveryRoutes();
    const response = await app.request(
      `https://a.asimposium.org/reviews.json${query}`,
      {},
      fixture.env,
    );
    assert.equal(response.status, 400);
    assert.equal(fixture.reads(), 0);
    const error = (await response.json()) as { code: string; fix_hint: string };
    assert.equal(error.code, "CURSOR_INVALID");
    assert.ok(error.fix_hint);
  });
}
test("a storage failure is not reported as an empty public queue", async () => {
  const app = createDiscoveryRoutes();
  const env = {
    DB: {
      prepare: () => {
        throw new Error("PRIVATE SQL CANARY");
      },
    },
  } as unknown as Env;
  const response = await app.request("https://a.asimposium.org/reviews.json", {}, env);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.text();
  assert.equal(body.includes("PRIVATE SQL CANARY"), false);
  assert.equal(body.includes('"candidates":[]'), false);
});
test("bare entry redirects to the canonical face without changing the scope", async () => {
  const fixture = emptyDatabase();
  const app = createDiscoveryRoutes();
  const response = await app.request(
    "https://a.asimposium.org/reviews?problem=P-MATH",
    {},
    fixture.env,
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/reviews.md?problem=P-MATH");
  assert.equal(fixture.reads(), 0);
});
