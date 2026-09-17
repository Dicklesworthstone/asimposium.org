import assert from "node:assert/strict";
import { test } from "bun:test";
import { publicWatchFetch } from "../../src/http/public-watch-cors.ts";

const request = (path = "/cursor", init: RequestInit = {}) =>
  new Request(`https://a.asimposium.org${path}`, { ...init,
    headers: { origin: "https://asimposium.org", ...Object.fromEntries(new Headers(init.headers)) },
  });

test("public cursor and face validators are visible cross-origin without credential permission", async () => {
  for (const path of ["/cursor", "/p/P-DEMO.json", "/p/P-DEMO/claims/C-1%402.json?through=3", "/reviews.json"]) {
    const response = await publicWatchFetch(request(path), () => new Response("public", {
      headers: { etag: '"digest"', "cache-control": "public, max-age=10", "x-robots-tag": "noindex" },
    }));
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(response.headers.get("etag"), '"digest"');
    assert.equal(response.headers.get("cache-control"), "public, max-age=10");
    assert.match(response.headers.get("access-control-expose-headers") ?? "", /ETag/);
    assert.equal(await response.text(), "public");
  }
});

test("HEAD conditional preflight succeeds without invoking application or storage", async () => {
  let invoked = 0;
  const response = await publicWatchFetch(request("/p/P-DEMO.json", { method: "OPTIONS", headers: {
    "access-control-request-method": "HEAD", "access-control-request-headers": "if-none-match",
  } }), () => { invoked++; return new Response("app"); });
  assert.equal(response.status, 204); assert.equal(invoked, 0);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD");
  assert.equal(response.headers.get("access-control-max-age"), "600");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("preflight never authorizes bearer, service-envelope or cookie headers", async () => {
  for (const header of ["authorization", "cookie", "x-asimp-signature"]) {
    const response = await publicWatchFetch(request("/cursor", { method: "OPTIONS", headers: {
      "access-control-request-method": "GET", "access-control-request-headers": header,
    } }), () => new Response("wrong"));
    assert.equal(response.status, 403); assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});

test("private, signed and bearer route traffic remains byte-for-byte untouched", async () => {
  for (const path of ["/v1/inbox", "/v1/sessions/S-1/pack", "/v1/enrollments", "/cursor?secret=oops"] ) {
    const original = new Response("private", { headers: { "cache-control": "no-store" } });
    const response = await publicWatchFetch(request(path), () => original);
    assert.equal(response, original); assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});

test("credential-bearing requests and cookie-setting responses are not made public by CORS", async () => {
  for (const headers of [{ authorization: "Bearer private" }, { cookie: "session=private" }] as Array<Record<string, string>>) {
    const original = new Response("private");
    assert.equal(await publicWatchFetch(request("/cursor", { headers }), () => original), original);
  }
  const original = new Response("private", { headers: { "set-cookie": "secret=1" } });
  assert.equal(await publicWatchFetch(request(), () => original), original);
});

test("writes to a read path receive no new cross-origin authority", async () => {
  const original = new Response("refused", { status: 405 });
  assert.equal(await publicWatchFetch(request("/cursor", { method: "POST", body: "{}" }), () => original), original);
});

test("304 validators and public withdrawal/throttle statuses remain observable without changing their semantics", async () => {
  for (const status of [304, 404, 410, 429, 503]) {
    const response = await publicWatchFetch(request(), () => new Response(null, {
      status, headers: { etag: '"digest"', "retry-after": "60", "cache-control": "no-store" },
    }));
    assert.equal(response.status, status); assert.equal(response.body, null);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("retry-after"), "60");
  }
});

test("the wrapper does not buffer the next handler's streamed public response", async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const response = await publicWatchFetch(request(), () => new Response(body));
  assert.equal(response.body, body); await response.body?.cancel(); assert.equal(cancelled, 1);
});
