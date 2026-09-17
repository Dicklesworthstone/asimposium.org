import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  PublicLedgerWatch, type PublicWatchRuntime, type PublicWatchState,
} from "../../lib/public-watch.ts";
import { type PublicWatchTarget } from "@asimposium/contracts/public-watch";

const ORIGIN = "https://a.asimposium.org";
const PATH = "/p/P-DEMO.json";
const INITIAL: readonly PublicWatchTarget[] = [{ path: PATH, etag: '"problem-1"' }];
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

class Clock {
  now = 0;
  private id = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  setTimer: PublicWatchRuntime["setTimer"] = (callback, delay) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer: PublicWatchRuntime["clearTimer"] = (id) => { this.timers.delete(id as unknown as number); };
  async advance(by: number) {
    const target = this.now + by;
    for (let iterations = 0; ; iterations++) {
      assert.ok(iterations < 1_000, "scheduler must not enter a hot loop");
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.now = target;
    await settle();
  }
}
interface Call { url: URL; init: RequestInit; }
function fixture(targets = INITIAL, origin = ORIGIN) {
  const clock = new Clock();
  const calls: Call[] = [];
  const states: PublicWatchState[] = [];
  const tags = new Map(targets.map((target) => [target.path, target.etag]));
  let cursor = 1;
  let refreshes = 0;
  let allowRefresh = true;
  let handler: ((call: Call) => Response | Promise<Response> | undefined) | undefined;
  const runtime: PublicWatchRuntime = {
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0,
    fetch: async (input, init = {}) => {
      const call = { url: new URL(String(input)), init };
      calls.push(call);
      const custom = handler?.(call);
      if (custom !== undefined) return custom;
      const path = `${call.url.pathname}${call.url.search}`;
      const etag = path === "/cursor" ? `"cursor-${cursor}"` : tags.get(path);
      const conditional = new Headers(init.headers).get("if-none-match");
      if (!etag) return new Response(null, { status: 404 });
      if (etag === conditional) return new Response(null, { status: 304, headers: { etag } });
      return new Response(path === "/cursor" ? String(cursor) : null, { headers: { etag } });
    },
  };
  const watch = new PublicLedgerWatch({ origin, targets, runtime,
    onState: (state) => states.push(state),
    onRefresh: () => { if (!allowRefresh) return false; refreshes++; return true; },
  });
  return { watch, clock, calls, states, tags,
    cursor: (value: number) => { cursor = value; },
    refreshes: () => refreshes,
    allow: (value: boolean) => { allowRefresh = value; },
    handler: (value?: typeof handler) => { handler = value; },
    start: async (active = true) => { watch.start(active); await settle(); },
    last: () => states.at(-1),
  };
}

// These are production controller/network tests with a deterministic scheduler,
// not a claim of browser, React, Next.js or deployed Cloudflare integration.
test("idle polls transfer only the cursor, with one initial validator reconciliation", async () => {
  const f = fixture(); await f.start();
  assert.equal(f.calls.length, 2);
  await f.clock.advance(50_000);
  assert.equal(f.calls.filter((c) => c.init.method === "HEAD").length, 1);
  assert.equal(f.calls.filter((c) => c.url.pathname === "/cursor").length, 6);
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(f.states, [{ status: "checking" }, { status: "current" }]);
  f.watch.stop(); assert.equal(f.clock.timers.size, 0);
});

test("unrelated ledger changes revalidate but do not refresh an unchanged face", async () => {
  const f = fixture(); await f.start(); f.cursor(2); await f.clock.advance(10_000);
  assert.equal(f.calls.length, 4); assert.equal(f.refreshes(), 0);
  assert.equal(f.last()?.status, "current"); f.watch.stop();
});

test("a stale initial server render is detected before the first cursor baseline is accepted", async () => {
  const f = fixture(); f.tags.set(PATH, '"problem-2"'); await f.start();
  assert.equal(f.refreshes(), 1); assert.equal(f.last()?.status, "refreshing"); f.watch.stop();
});

test("only a new rendered manifest acknowledges a refresh; unchanged props cannot lose updates", async () => {
  const f = fixture(); await f.start(); f.cursor(2); f.tags.set(PATH, '"problem-2"');
  await f.clock.advance(10_000); assert.equal(f.refreshes(), 1);
  await f.clock.advance(10_000); assert.equal(f.refreshes(), 2);
  f.watch.replaceTargets([{ path: PATH, etag: '"problem-2"' }]); await settle();
  assert.equal(f.last()?.status, "current");
  const heads = f.calls.filter((c) => c.init.method === "HEAD").length;
  await f.clock.advance(30_000);
  assert.equal(f.calls.filter((c) => c.init.method === "HEAD").length, heads);
  assert.equal(f.refreshes(), 2); f.watch.stop();
});

test("failed render convergence stops automatic refresh attempts and retains an actionable update", async () => {
  const f = fixture(); f.tags.set(PATH, '"problem-2"'); await f.start();
  await f.clock.advance(60_000);
  assert.equal(f.refreshes(), 3); assert.equal(f.last()?.status, "update-available");
  f.watch.checkNow(); await settle(); assert.equal(f.refreshes(), 4); f.watch.stop();
});

test("a later distinct change is not hidden by the refresh-attempt ceiling", async () => {
  const f = fixture(); f.tags.set(PATH, '"problem-2"'); await f.start();
  await f.clock.advance(30_000); assert.equal(f.refreshes(), 3);
  f.tags.set(PATH, '"problem-3"'); f.cursor(3); await f.clock.advance(10_000);
  assert.equal(f.refreshes(), 4); f.watch.stop();
});

test("paused editing defers refresh without spending retry attempts", async () => {
  const f = fixture(); f.allow(false); f.tags.set(PATH, '"problem-2"'); await f.start();
  await f.clock.advance(50_000); assert.equal(f.refreshes(), 0);
  assert.equal(f.last()?.status, "update-available");
  f.allow(true); await f.clock.advance(10_000); assert.equal(f.refreshes(), 1); f.watch.stop();
});

test("cursor decreases also force revalidation; global and local cursor namespaces are never mixed", async () => {
  const f = fixture(); f.cursor(100); await f.start();
  f.cursor(2); f.tags.set(PATH, '"problem-2"'); await f.clock.advance(10_000);
  assert.equal(f.refreshes(), 1);
  assert.ok(f.calls.every((call) => !call.url.searchParams.has("since"))); f.watch.stop();
});

test("all rendered dependencies can invalidate a view, but probes stop at the first changed resource", async () => {
  const targets = [INITIAL[0]!, { path: "/p/P-DEMO/claims/C-1%402.json?through=7", etag: '"claim-1"' },
    { path: "/p/P-DEMO/claims/C-2.json?through=7", etag: '"claim-2"' }];
  const f = fixture(targets); await f.start(); assert.equal(f.calls.length, 4);
  f.cursor(2); f.tags.set(targets[1]!.path, '"claim-redacted"'); await f.clock.advance(10_000);
  assert.equal(f.calls.length, 7); assert.equal(f.refreshes(), 1);
  assert.equal(f.calls.at(-1)?.url.search, "?through=7"); f.watch.stop();
});

test("requests omit credentials, referrers and redirects and carry only public read validators", async () => {
  const f = fixture(); await f.start();
  for (const call of f.calls) {
    assert.equal(call.init.credentials, "omit"); assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.mode, "cors");
    assert.ok(["GET", "HEAD"].includes(String(call.init.method)));
    const headers = new Headers(call.init.headers);
    assert.equal(headers.has("authorization"), false); assert.equal(headers.has("cookie"), false);
  }
  f.watch.stop();
});

test("hidden/offline pause stops timers and resume reconciles even an unchanged global cursor", async () => {
  const f = fixture(); await f.start(); f.watch.setActive(false);
  const count = f.calls.length; await f.clock.advance(1_000_000); assert.equal(f.calls.length, count);
  assert.equal(f.last()?.status, "paused");
  f.tags.set(PATH, '"withdrawn-source"'); f.watch.setActive(true); await settle();
  assert.equal(f.refreshes(), 1); f.watch.stop();
});

test("starting in a hidden tab performs no request", async () => {
  const f = fixture(); await f.start(false); await f.clock.advance(100_000);
  assert.equal(f.calls.length, 0); f.watch.setActive(true); await settle();
  assert.equal(f.calls.length, 2); f.watch.stop();
});

test("pause cancels an in-flight request and retires a late response without updating the view", async () => {
  const f = fixture(); const pending = Promise.withResolvers<Response>(); let cancelled = 0;
  f.handler(() => pending.promise); await f.start(); f.watch.setActive(false); await settle();
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
  pending.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await settle(); assert.equal(cancelled, 1); assert.equal(f.refreshes(), 0);
  assert.equal(f.last()?.status, "paused"); assert.equal(f.clock.timers.size, 0); f.watch.stop();
});

test("unmount suppresses late refreshes and state callbacks", async () => {
  const f = fixture(); const pending = Promise.withResolvers<Response>();
  f.handler(() => pending.promise); await f.start(); f.watch.stop();
  const count = f.states.length; pending.resolve(new Response("2", { headers: { etag: '"cursor-2"' } }));
  await settle(); assert.equal(f.states.length, count); assert.equal(f.refreshes(), 0);
  assert.equal(f.clock.timers.size, 0);
});

test("an abort-ignoring fetch times out and a late body is cancelled", async () => {
  const f = fixture(); const pending = Promise.withResolvers<Response>(); let cancelled = 0;
  f.handler(() => pending.promise); await f.start(); await f.clock.advance(3_000);
  assert.deepEqual(f.last(), { status: "unavailable", reason: "timeout" });
  pending.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await settle(); assert.equal(cancelled, 1); assert.equal(f.refreshes(), 0); f.watch.stop();
});

test("body reads are covered by the same deadline", async () => {
  const f = fixture(); let cancelled = 0;
  f.handler(() => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { etag: '"cursor-1"' } }));
  await f.start(); await f.clock.advance(3_000);
  assert.deepEqual(f.last(), { status: "unavailable", reason: "timeout" });
  assert.equal(cancelled, 1); assert.equal(f.calls.length, 1); f.watch.stop();
});

test("oversized cursor streams are cancelled before any scientific resource is requested", async () => {
  const f = fixture(); let cancelled = 0;
  f.handler(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_024)); }, cancel() { cancelled++; },
  })));
  await f.start(); assert.deepEqual(f.last(), { status: "unavailable", reason: "invalid_response" });
  assert.equal(cancelled, 1); assert.equal(f.calls.length, 1); f.watch.stop();
});

test("noncanonical cursors never become a polling baseline", async () => {
  for (const body of ["", "01", "1\n", "-1", "1.0", "1e3", "9007199254740992", "{\"cursor\":1}"]) {
    const f = fixture(); f.handler(() => new Response(body)); await f.start();
    assert.equal(f.last()?.reason, "invalid_response", body); assert.equal(f.calls.length, 1); f.watch.stop();
  }
});

test("304 without a prior validator and mismatched 304 tags fail closed", async () => {
  const f = fixture(); f.handler(() => new Response(null, { status: 304, headers: { etag: '"unknown"' } }));
  await f.start(); assert.equal(f.last()?.reason, "invalid_response"); f.watch.stop();
  const g = fixture(); await g.start();
  g.handler(() => new Response(null, { status: 304, headers: { etag: '"wrong"' } }));
  await g.clock.advance(10_000); assert.equal(g.last()?.reason, "invalid_response"); g.watch.stop();
});

test("missing or weak face tags do not falsely declare the view current", async () => {
  for (const etag of [undefined, 'W/"weak"', "*"]) {
    const f = fixture(); f.handler((call) => call.init.method === "HEAD"
      ? new Response(null, { headers: etag === undefined ? {} : { etag } }) : undefined);
    await f.start(); assert.equal(f.last()?.reason, "invalid_response"); assert.equal(f.refreshes(), 0); f.watch.stop();
  }
});

test("withdrawal/not-found responses request a server re-read instead of preserving a false live status", async () => {
  for (const status of [404, 410]) {
    const f = fixture(); f.handler((call) => call.init.method === "HEAD" ? new Response(null, { status }) : undefined);
    await f.start(); assert.equal(f.refreshes(), 1); assert.equal(f.last()?.status, "refreshing"); f.watch.stop();
  }
});

test("429 Retry-After is respected and recovery revalidates all sources", async () => {
  const f = fixture(); f.handler(() => new Response(null, { status: 429, headers: { "retry-after": "90" } }));
  await f.start(); await f.clock.advance(89_999); assert.equal(f.calls.length, 1);
  f.handler(); await f.clock.advance(1); assert.equal(f.calls.length, 3);
  assert.equal(f.last()?.status, "current"); f.watch.stop();
});

test("a failed scope probe is retried even when the subsequent global response is 304", async () => {
  const f = fixture(); await f.start(); f.cursor(2);
  f.handler((call) => call.init.method === "HEAD" ? new Response(null, { status: 503 }) : undefined);
  await f.clock.advance(10_000); assert.equal(f.last()?.status, "unavailable");
  f.handler(); f.tags.set(PATH, '"problem-2"'); await f.clock.advance(20_000);
  assert.equal(f.refreshes(), 1); f.watch.stop();
});

test("invalid origins, private paths and unseeded manifests produce no network request", async () => {
  for (const f of [fixture(INITIAL, "https://evil.test"), fixture([{ path: "/v1/inbox", etag: '"x"' }]),
    fixture([{ path: PATH, etag: "" }]), fixture([])]) {
    await f.start(); assert.equal(f.calls.length, 0); assert.equal(f.last()?.reason, "configuration"); f.watch.stop();
  }
});

test("changing targets cancels the old probe and cannot refresh a newly navigated view", async () => {
  const f = fixture(); const pending = Promise.withResolvers<Response>();
  f.handler((call) => call.init.method === "HEAD" ? pending.promise : undefined);
  await f.start(); f.handler();
  const path = "/p/P-OTHER.json"; f.tags.set(path, '"other"');
  f.watch.replaceTargets([{ path, etag: '"other"' }]); await settle(); await f.clock.advance(0);
  pending.resolve(new Response(null, { headers: { etag: '"late-change"' } })); await settle();
  assert.equal(f.refreshes(), 0); assert.equal(f.last()?.status, "current"); f.watch.stop();
});


test("quiet-cursor reconciliation observes changed resources without inventing a public append", async () => {
  const f = fixture(); await f.start(); f.tags.set(PATH, '"withdrawal-without-append"');
  await f.clock.advance(50_000); assert.equal(f.refreshes(), 0);
  await f.clock.advance(10_000); assert.equal(f.refreshes(), 1);
  assert.equal(f.calls.filter((call) => call.init.method === "HEAD").length, 2);
  f.watch.stop();
});

test("a newly private or removed resource is re-read even while the global cursor stays unchanged", async () => {
  const f = fixture(); await f.start();
  f.handler((call) => call.init.method === "HEAD" ? new Response(null, { status: 404 }) : undefined);
  await f.clock.advance(60_000);
  assert.equal(f.refreshes(), 1); assert.equal(f.last()?.status, "refreshing"); f.watch.stop();
});

test("periodic checks are bounded and do not refresh or announce an unchanged view", async () => {
  const f = fixture(); await f.start(); await f.clock.advance(180_000);
  assert.equal(f.calls.filter((call) => call.init.method === "HEAD").length, 4);
  assert.equal(f.calls.filter((call) => call.url.pathname === "/cursor").length, 19);
  assert.equal(f.refreshes(), 0); assert.equal(f.states.length, 2); f.watch.stop();
});

test("discovery pagination and negative-evidence history remain the same view on every refresh", async () => {
  for (const path of ["/now.json?before=opaque%3Acursor",
    "/reviews.json?problem=P-DEMO&after=opaque%3Acursor",
    "/p/P-DEMO/dead-ends.json?include_superseded=true"]) {
    const f = fixture([{ path, etag: '"old"' }]); await f.start();
    f.tags.set(path, '"changed"'); f.cursor(2); await f.clock.advance(10_000);
    assert.equal(f.refreshes(), 1);
    assert.ok(f.calls.filter((call) => call.init.method === "HEAD")
      .every((call) => `${call.url.pathname}${call.url.search}` === path));
    f.watch.stop();
  }
});
