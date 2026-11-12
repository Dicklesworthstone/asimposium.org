import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  WorkshopWatch,
  type WorkshopWatchRuntime,
  type WorkshopWatchState,
  WORKSHOP_WATCH_TIMEOUT_MS,
  workshopWatchStatusText,
} from "../../lib/workshop-watch";

const SPONSOR = "usr_workshop_watcher";
const FELLOW = "fellow-01JXYZ";
const PROBLEM = "P-4DSP";
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

class Clock {
  now = 0;
  private id = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  setTimer: WorkshopWatchRuntime["setTimer"] = (callback, delay) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer: WorkshopWatchRuntime["clearTimer"] = (id) => {
    this.timers.delete(id as unknown as number);
  };
  async advance(by: number) {
    const target = this.now + by;
    for (let turns = 0; ; turns++) {
      assert.ok(turns < 1_000, "workshop checks must not enter a hot loop");
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

function cursorResponse(cursor = 7, extra: Record<string, unknown> = {}) {
  return Response.json(
    {
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      sponsor_id: SPONSOR,
      fellow_id: FELLOW,
      problem_id: PROBLEM,
      workshop_cursor: cursor,
      ...extra,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

function fixture(renderedCursor: number | undefined = 7) {
  const clock = new Clock();
  const calls: { input: string; init: RequestInit }[] = [];
  const states: WorkshopWatchState[] = [];
  const refreshes: ("access" | "change")[] = [];
  let cursor = 7;
  let allow = true;
  let handler: (() => Response | Promise<Response>) | undefined;
  const runtime: WorkshopWatchRuntime = {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
    fetch: async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return handler ? handler() : cursorResponse(cursor);
    },
  };
  const options = {
    sponsorId: SPONSOR,
    fellowId: FELLOW,
    problemId: PROBLEM,
    renderedCursor,
    runtime,
    onState: (state: WorkshopWatchState) => states.push(state),
    onRefresh: (reason: "access" | "change") => {
      if (reason === "change" && !allow) return false;
      refreshes.push(reason);
      return true;
    },
  };
  const watch = new WorkshopWatch(options);
  return {
    watch,
    options,
    runtime,
    clock,
    calls,
    states,
    refreshes,
    cursor: (value: number) => {
      cursor = value;
    },
    allow: (value: boolean) => {
      allow = value;
    },
    handler: (value?: typeof handler) => {
      handler = value;
    },
    start: async (active = true) => {
      watch.start(active);
      await settle();
    },
    last: () => states.at(-1)?.status,
  };
}

// Controller and transport tests, not a claim of browser or hosted authority proof.
test("idle workshop checks fetch only the same-origin cursor and never rerender bodies", async () => {
  const f = fixture();
  await f.start();
  await f.clock.advance(15_000);
  assert.equal(f.calls.length, 6);
  assert.equal(f.refreshes.length, 0);
  assert.equal(f.last(), "current");
  for (const { input, init } of f.calls) {
    assert.equal(input, `/console/workshop/${FELLOW}/${PROBLEM}/cursor`);
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.mode, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(new Headers(init.headers).has("cookie"), false);
  }
  f.watch.stop();
  assert.equal(f.clock.timers.size, 0);
});

test("a missed initial write stays pending until new server-rendered props acknowledge it", async () => {
  const f = fixture();
  f.cursor(8);
  await f.start();
  assert.equal(f.refreshes.length, 1);
  await f.clock.advance(30_000);
  assert.equal(f.refreshes.length, 3);
  assert.equal(f.last(), "update-available");
  f.watch.stop();
  const rendered = new WorkshopWatch({ ...f.options, renderedCursor: 8 });
  rendered.start();
  await settle();
  await f.clock.advance(9_000);
  assert.equal(f.refreshes.length, 3);
  assert.equal(f.last(), "current");
  f.cursor(9);
  await f.clock.advance(3_000);
  assert.equal(f.refreshes.length, 4);
  rendered.stop();
});

test("later changes and cursor decreases cannot hide behind refresh retry exhaustion", async () => {
  const f = fixture();
  f.cursor(8);
  await f.start();
  await f.clock.advance(20_000);
  assert.equal(f.refreshes.length, 3);
  f.cursor(9);
  await f.clock.advance(3_000);
  assert.equal(f.refreshes.length, 4);
  f.cursor(0);
  await f.clock.advance(3_000);
  assert.equal(f.refreshes.length, 5);
  f.watch.stop();
});

test("editing or selecting private work defers refresh without consuming the retry budget", async () => {
  const f = fixture();
  f.allow(false);
  f.cursor(8);
  await f.start();
  await f.clock.advance(30_000);
  assert.equal(f.refreshes.length, 0);
  assert.equal(f.last(), "update-available");
  f.allow(true);
  await f.clock.advance(3_000);
  assert.equal(f.refreshes.length, 1);
  f.watch.stop();
});

test("an older workshop page announces later changes without replacing its selected page", async () => {
  const f = fixture();
  const watch = new WorkshopWatch({ ...f.options, renderedCursor: undefined });
  watch.start();
  await settle();
  assert.equal(f.last(), "current");
  f.cursor(8);
  await f.clock.advance(30_000);
  assert.equal(f.last(), "update-available");
  assert.equal(f.refreshes.length, 0);
  assert.match(workshopWatchStatusText({ status: "update-available" }, true), /Open newest work/);
  watch.stop();
});

test("hidden or offline checks stop and resume detects work from the paused interval", async () => {
  const f = fixture();
  await f.start();
  f.watch.setActive(false);
  assert.equal(f.last(), "paused");
  assert.equal(f.clock.timers.size, 0);
  f.cursor(8);
  await f.clock.advance(100_000);
  assert.equal(f.calls.length, 1);
  f.watch.setActive(true);
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.refreshes.length, 1);
  f.watch.stop();
});

test("access loss or changed browser account requests one authoritative refresh then stops", async () => {
  for (const response of [
    () => new Response("private diagnostics", { status: 401 }),
    () => new Response("private diagnostics", { status: 403 }),
    () => new Response("private diagnostics", { status: 404 }),
    () => cursorResponse(7, { sponsor_id: "usr_other_owner" }),
  ]) {
    const f = fixture();
    f.handler(response);
    await f.start();
    assert.equal(f.last(), "access-ended");
    assert.deepEqual(f.refreshes, ["access"]);
    await f.clock.advance(100_000);
    assert.equal(f.calls.length, 1);
    f.watch.stop();
  }
});

test("wrong scope, invalid cursor, unknown fields and cacheable responses cannot acknowledge work", async () => {
  for (const response of [
    () => cursorResponse(7, { fellow_id: "fellow-other" }),
    () => cursorResponse(7, { problem_id: "P-OTHER" }),
    () => cursorResponse(-1),
    () => cursorResponse(Number.MAX_SAFE_INTEGER + 1),
    () => cursorResponse(7, { body_md: "private unexpected bytes" }),
    () =>
      new Response("not JSON", {
        headers: { "content-type": "application/json", "cache-control": "private, no-store" },
      }),
    () => {
      const r = cursorResponse();
      r.headers.set("cache-control", "public, max-age=60");
      return r;
    },
  ]) {
    const f = fixture();
    f.handler(response);
    await f.start();
    assert.equal(f.last(), "unavailable");
    assert.equal(f.refreshes.length, 0);
    f.watch.stop();
  }
});

test("private request configuration rejects invalid authority or path before fetching", async () => {
  for (const extra of [
    { sponsorId: "owner@example.com" },
    { fellowId: "" },
    { problemId: "P-4DSP?upstream=https://evil.invalid" },
    { renderedCursor: -1 },
  ]) {
    const f = fixture();
    const watch = new WorkshopWatch({ ...f.options, ...extra });
    watch.start();
    await settle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.last(), "unavailable");
    watch.stop();
  }
});

test("a Fellow identifier is encoded as one fixed route segment, never as a proxy URL", async () => {
  const f = fixture();
  const fellowId = "fellow/a?b=c";
  f.handler(() => cursorResponse(7, { fellow_id: fellowId }));
  const watch = new WorkshopWatch({ ...f.options, fellowId });
  watch.start();
  await settle();
  assert.equal(f.calls[0]?.input, `/console/workshop/fellow%2Fa%3Fb%3Dc/${PROBLEM}/cursor`);
  assert.equal(f.last(), "current");
  watch.stop();
});

test("failed checks back off and respect bounded Retry-After without refreshing stale data", async () => {
  const f = fixture();
  f.handler(
    () =>
      new Response("private diagnostic", {
        status: 503,
        headers: { "retry-after": "45" },
      }),
  );
  await f.start();
  assert.equal(f.last(), "unavailable");
  await f.clock.advance(44_000);
  assert.equal(f.calls.length, 1);
  await f.clock.advance(1_000);
  assert.equal(f.calls.length, 2);
  f.handler();
  await f.clock.advance(45_000);
  assert.equal(f.last(), "current");
  assert.equal(f.refreshes.length, 0);
  f.watch.stop();
});

test("declared and streamed oversized replies are cancelled under the cursor byte bound", async () => {
  for (const declared of [true, false]) {
    let pulls = 0;
    let cancelled = false;
    const f = fixture();
    f.handler(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++;
                controller.enqueue(new Uint8Array(2049));
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          {
            headers: {
              "content-type": "application/json",
              "cache-control": "private, no-store",
              ...(declared ? { "content-length": "2049" } : {}),
            },
          },
        ),
    );
    await f.start();
    assert.equal(f.last(), "unavailable");
    assert.equal(f.refreshes.length, 0);
    assert.equal(cancelled, true);
    assert.equal(pulls, declared ? 0 : 1);
    f.watch.stop();
  }
});

test("a header timeout releases the scheduler and ignores a late changed response", async () => {
  const f = fixture();
  let resolve: ((response: Response) => void) | undefined;
  f.handler(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await f.start();
  await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS - 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.refreshes.length, 0);
  await f.clock.advance(1);
  assert.equal(f.last(), "unavailable");
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
  resolve?.(cursorResponse(8));
  await settle();
  assert.equal(f.refreshes.length, 0);
  f.handler();
  await f.clock.advance(6_000);
  assert.equal(f.last(), "current");
  f.watch.stop();
});

test("a hung body is cancelled by the same deadline and never replaces the page", async () => {
  const f = fixture();
  let cancelled = false;
  f.handler(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"schema":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json", "cache-control": "private, no-store" } },
      ),
  );
  await f.start();
  await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS);
  assert.equal(cancelled, true);
  assert.equal(f.last(), "unavailable");
  assert.equal(f.refreshes.length, 0);
  f.watch.stop();
});

test("unmount aborts a pending request and late replies cannot revive polling or refreshes", async () => {
  const f = fixture();
  let resolve: ((response: Response) => void) | undefined;
  f.handler(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await f.start();
  f.watch.stop();
  await settle();
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
  resolve?.(cursorResponse(8));
  await settle();
  await f.clock.advance(100_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.refreshes.length, 0);
  assert.equal(f.clock.timers.size, 0);
});

test("pause followed by immediate resume starts one fresh check after cancellation", async () => {
  const f = fixture();
  f.handler(() => new Promise<Response>(() => undefined));
  await f.start();
  f.watch.setActive(false);
  f.handler();
  f.cursor(8);
  f.watch.setActive(true);
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.refreshes.length, 1);
  f.watch.stop();
});
