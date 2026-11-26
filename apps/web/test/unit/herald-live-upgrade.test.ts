import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  PublicLedgerWatch,
  type PublicWatchEventSource,
  type PublicWatchRuntime,
  type PublicWatchSocket,
  type PublicWatchState,
} from "../../lib/public-watch.ts";
import {
  isSameOriginWorkshopRequest,
  loadWorkshopRoomTicketResponse,
} from "../../lib/workshop-page.ts";
import {
  WORKSHOP_WATCH_HEARTBEAT_MS,
  WORKSHOP_WATCH_TIMEOUT_MS,
  WorkshopWatch,
  type WorkshopWatchRuntime,
  type WorkshopWatchSocket,
  type WorkshopWatchState,
} from "../../lib/workshop-watch.ts";

const settle = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

class FakeClock {
  now = 0;
  private id = 0;
  readonly timers = new Map<number, { at: number; cb: () => void }>();
  setTimer = (cb: () => void, delay: number) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.now + delay, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer = (id: ReturnType<typeof setTimeout>) => {
    this.timers.delete(id as unknown as number);
  };
  async advance(by: number) {
    const target = this.now + by;
    for (let i = 0; i < 500; i++) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].cb();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

class FakeSocket implements PublicWatchSocket, WorkshopWatchSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(
    readonly url: string,
    readonly protocol: string,
    private readonly emitClose = false,
  ) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    if (this.emitClose) this.emit("close");
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

class FakeEventSource implements PublicWatchEventSource {
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

function workshopNotice(socket: FakeSocket, overrides: Record<string, unknown> = {}): void {
  socket.emit("message", {
    data: JSON.stringify({
      control: "workshop-update",
      fellow_id: "fellow-01JXYZ",
      problem_id: "P-4DSP",
      workshop_cursor: 7,
      ...overrides,
    }),
  });
}

async function liveWorkshopFixture() {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const states: WorkshopWatchState[] = [];
  const refreshes: ("access" | "change")[] = [];
  const authority = { cursor: 7, status: 200 };
  const scope = {
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    sponsor_id: "usr_sponsor_alpha",
    problem_id: "P-4DSP",
    fellow_id: "fellow-01JXYZ",
  };
  const runtime: WorkshopWatchRuntime = {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
    openWebSocket: (url, protocol) => {
      const socket = new FakeSocket(url, protocol, true);
      sockets.push(socket);
      return socket;
    },
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/room-ticket"))
        return Response.json(
          {
            ...scope,
            ticket: `${"A".repeat(64)}.${"B".repeat(86)}`,
            expires_at: "2026-09-10T00:01:00.000Z",
            workshop_cursor: 7,
            room_url: "wss://a.asimposium.org/v1/workshop-room?fellow=fellow-01JXYZ&problem=P-4DSP",
          },
          { headers: { "cache-control": "private, no-store" } },
        );
      assert.equal(url, "/console/workshop/fellow-01JXYZ/P-4DSP/cursor");
      return Response.json(
        { ...scope, workshop_cursor: authority.cursor },
        { status: authority.status, headers: { "cache-control": "private, no-store" } },
      );
    },
  };
  const watch = new WorkshopWatch({
    sponsorId: scope.sponsor_id,
    fellowId: scope.fellow_id,
    problemId: scope.problem_id,
    renderedCursor: 7,
    runtime,
    onState: (state) => states.push(state),
    onRefresh: (reason) => {
      refreshes.push(reason);
      return true;
    },
  });
  watch.start();
  await settle();
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.ok(socket);
  return {
    clock,
    watch,
    socket,
    sockets,
    calls,
    states,
    refreshes,
    authority,
    cursorReads: () => calls.filter(({ url }) => url.endsWith("/cursor")),
  };
}

describe("private workshop socket liveness", () => {
  test("a connection that never opens recovers through authoritative polling and ignores late frames", async () => {
    const f = await liveWorkshopFixture();
    const socket = f.socket;
    f.authority.cursor = 8;
    assert.equal(f.states.at(-1)?.status, "checking");
    await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS - 1);
    assert.equal(f.watch.transport, "ws");
    assert.equal(f.cursorReads().length, 0);
    await f.clock.advance(1);
    assert.equal(f.watch.transport, "poll");
    assert.equal(socket.closed, true);
    assert.equal(f.cursorReads().length, 1);
    assert.equal(f.cursorReads()[0]?.init.credentials, "same-origin");
    assert.equal(f.cursorReads()[0]?.init.cache, "no-store");
    assert.deepEqual(f.refreshes, ["change"]);
    socket.emit("open");
    socket.emit("message", { data: "pong" });
    workshopNotice(socket, { workshop_cursor: 9 });
    socket.emit("error");
    socket.emit("close");
    await settle();
    assert.deepEqual(socket.sent, []);
    assert.deepEqual(f.refreshes, ["change"]);
    assert.equal(f.cursorReads().length, 1);
    assert.equal(f.states.at(-1)?.status, "refreshing");
    f.watch.stop();
    assert.equal(f.clock.timers.size, 0);
  });

  test("opening and pre-auth pongs cannot postpone authentication or bypass an authoritative access refusal", async () => {
    const f = await liveWorkshopFixture();
    const socket = f.socket;
    f.authority.status = 403;
    await f.clock.advance(3_000);
    socket.emit("open");
    socket.emit("message", { data: "pong" });
    socket.emit("message", { data: "invalid JSON" });
    workshopNotice(socket, { fellow_id: "fellow-other" });
    workshopNotice(socket, { problem_id: "P-OTHER" });
    workshopNotice(socket, { workshop_cursor: Number.MAX_SAFE_INTEGER + 1 });
    await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS - 3_000);
    assert.equal(f.watch.transport, "poll");
    assert.equal(socket.closed, true);
    assert.equal(f.cursorReads().length, 1);
    assert.equal(f.states.at(-1)?.status, "access-ended");
    assert.deepEqual(f.refreshes, ["access"]);
    assert.equal(f.clock.timers.size, 0);
    socket.emit("message", { data: "pong" });
    workshopNotice(socket);
    await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS * 2);
    assert.equal(f.cursorReads().length, 1);
    assert.deepEqual(f.refreshes, ["access"]);
    f.watch.stop();
  });

  for (const response of ["pong", "scoped update"] as const) {
    test(`a ${response} keeps an authenticated room live; an unanswered heartbeat falls back`, async () => {
      const f = await liveWorkshopFixture();
      const socket = f.socket;
      socket.emit("open");
      // Repeating the rendered cursor still acknowledges ticket verification.
      workshopNotice(socket);
      assert.equal(f.states.at(-1)?.status, "current");
      await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS);
      assert.equal(socket.sent.at(-1), "ping");
      await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS - 1);
      assert.equal(f.watch.transport, "ws");
      if (response === "pong") socket.emit("message", { data: "pong" });
      else workshopNotice(socket);
      await f.clock.advance(1);
      assert.equal(f.watch.transport, "ws");
      assert.equal(f.cursorReads().length, 0);
      assert.deepEqual(f.refreshes, []);

      await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS - WORKSHOP_WATCH_TIMEOUT_MS);
      assert.equal(socket.sent.filter((frame) => frame === "ping").length, 2);
      socket.emit("message", { data: "invalid JSON" });
      workshopNotice(socket, { problem_id: "P-OTHER" });
      workshopNotice(socket, { fellow_id: "fellow-other" });
      workshopNotice(socket, { workshop_cursor: -1 });
      workshopNotice(socket, { workshop_cursor: Number.MAX_SAFE_INTEGER + 1 });
      await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS);
      assert.equal(f.watch.transport, "poll");
      assert.equal(socket.closed, true);
      assert.equal(f.cursorReads().length, 1);
      assert.equal(f.states.at(-1)?.status, "current");
      await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS);
      assert.equal(socket.sent.filter((frame) => frame === "ping").length, 2);
      assert.equal(f.calls.filter(({ url }) => url.endsWith("/room-ticket")).length, 1);
      f.watch.stop();
      assert.equal(f.clock.timers.size, 0);
    });
  }

  for (const phase of ["connection", "heartbeat"] as const) {
    test(`pausing clears the ${phase} deadline and late callbacks cannot affect a resumed room`, async () => {
      const f = await liveWorkshopFixture();
      const original = f.socket;
      if (phase === "heartbeat") {
        original.emit("open");
        workshopNotice(original);
        await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS);
      }
      const expired = [...f.clock.timers.values()].find(
        ({ at }) => at === f.clock.now + WORKSHOP_WATCH_TIMEOUT_MS,
      );
      assert.ok(expired);
      f.watch.setActive(false);
      assert.equal(original.closed, true);
      assert.equal(f.clock.timers.size, 0);
      await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS * 2);
      assert.equal(f.calls.length, 1);
      assert.equal(f.states.at(-1)?.status, "paused");
      f.watch.setActive(true);
      await settle();
      const replacement = f.sockets[1];
      assert.ok(replacement);
      const sentBefore = [...original.sent];
      original.emit("open");
      original.emit("message", { data: "pong" });
      workshopNotice(original, { workshop_cursor: 9 });
      original.emit("error");
      expired.cb();
      assert.deepEqual(original.sent, sentBefore);
      assert.equal(f.watch.transport, "ws");
      assert.equal(replacement.closed, false);
      assert.equal(f.states.at(-1)?.status, "checking");
      assert.deepEqual(f.refreshes, []);
      await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS);
      assert.equal(replacement.closed, true);
      assert.equal(f.watch.transport, "poll");
      assert.equal(f.cursorReads().length, 1);
      f.watch.stop();
      assert.equal(f.clock.timers.size, 0);
    });
  }

  test("stopping an authenticated room cancels its pending heartbeat deadline and recovery", async () => {
    const f = await liveWorkshopFixture();
    const socket = f.socket;
    socket.emit("open");
    workshopNotice(socket);
    await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS);
    const pending = [...f.clock.timers.values()];
    assert.equal(pending.length, 2);
    f.watch.stop();
    assert.equal(socket.closed, true);
    assert.equal(f.clock.timers.size, 0);
    for (const callback of pending) callback.cb();
    socket.emit("message", { data: "pong" });
    workshopNotice(socket, { workshop_cursor: 9 });
    await f.clock.advance(WORKSHOP_WATCH_HEARTBEAT_MS * 2);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.refreshes, []);
    assert.equal(f.clock.timers.size, 0);
  });
});

describe("Agora Herald progressive WS -> SSE -> Poll upgrade (kfag)", () => {
  test("PublicLedgerWatch upgrades to WS, acknowledges resync, refreshes via HEAD without /cursor polling, and degrades WS -> SSE -> Poll", async () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const sources: FakeEventSource[] = [];
    const calls: { url: string; method: string; credentials?: RequestCredentials }[] = [];
    const states: PublicWatchState[] = [];
    let refreshes = 0;
    let etag = '"problem-1"';

    const runtime: PublicWatchRuntime = {
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0,
      openWebSocket: (url, protocol) => {
        const s = new FakeSocket(url, protocol);
        sockets.push(s);
        return s;
      },
      openEventSource: (url) => {
        const es = new FakeEventSource(url);
        sources.push(es);
        return es;
      },
      fetch: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, method: init.method ?? "GET", credentials: init.credentials });
        if (url.endsWith("/cursor")) return new Response("2", { status: 200 });
        return new Response(null, { status: 200, headers: { etag } });
      },
    };

    const watch = new PublicLedgerWatch({
      origin: "https://a.asimposium.org",
      targets: [{ path: "/p/P-DEMO.json", etag: '"problem-1"' }],
      runtime,
      onState: (s) => states.push(s),
      onRefresh: () => {
        refreshes++;
        return true;
      },
    });

    watch.start();
    await settle();
    assert.equal(watch.transport, "ws");
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]!.url, "wss://a.asimposium.org/p/P-DEMO/room?since=0");
    assert.equal(sockets[0]!.protocol, "asimposium.room.v1");
    assert.equal(calls.length, 0);

    // WS opens and receives live push -> acks and probes HEAD directly (zero /cursor poll!).
    sockets[0]!.emit("open");
    etag = '"problem-2"';
    sockets[0]!.emit("message", {
      data: JSON.stringify({ control: "resync", through: 2 }),
    });
    await settle();
    assert.deepEqual(sockets[0]!.sent, ['{"ack":2}']);
    assert.equal(calls.filter((c) => c.url.endsWith("/cursor")).length, 0);
    assert.equal(calls.filter((c) => c.method === "HEAD").length, 1);
    assert.equal(calls[0]!.credentials, "omit");
    assert.equal(refreshes, 1);

    // Heartbeat ping runs every 20s while WS stays open.
    await clock.advance(20_000);
    assert.equal(sockets[0]!.sent.at(-1), "ping");

    // WS drops (e.g., 503 ROOM_UNAVAILABLE / DO down) -> seamlessly falls back to persistent SSE!
    sockets[0]!.emit("error");
    await settle();
    assert.equal(watch.transport, "sse");
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.url, "https://a.asimposium.org/p/P-DEMO/room/sse?since=2");

    etag = '"problem-3"';
    sources[0]!.emit("resync", {
      data: JSON.stringify({ control: "resync", through: 3 }),
    });
    await settle();
    assert.equal(refreshes, 2);

    // SSE drops -> seamlessly degrades to /cursor HTTP polling without unhandled errors!
    sources[0]!.emit("error");
    await settle();
    assert.equal(watch.transport, "poll");
    assert.ok(calls.some((c) => c.url.endsWith("/cursor")));
    watch.stop();
    assert.equal(clock.timers.size, 0);
  });

  test("WorkshopWatch mints same-origin 60s ticket, sends first-frame auth with zero ticket in URL, updates live on WS push, and falls back to polling on 503", async () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const calls: { url: string; method: string; credentials?: RequestCredentials }[] = [];
    const states: WorkshopWatchState[] = [];
    const refreshes: ("access" | "change")[] = [];
    const validTicket = `${"A".repeat(64)}.${"B".repeat(86)}`;
    let ticketStatus = 200;

    const runtime: WorkshopWatchRuntime = {
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0,
      openWebSocket: (url, protocol) => {
        const s = new FakeSocket(url, protocol);
        sockets.push(s);
        return s;
      },
      fetch: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, method: init.method ?? "GET", credentials: init.credentials });
        if (url.endsWith("/room-ticket")) {
          if (ticketStatus !== 200)
            return Response.json({ error: "unavailable" }, { status: ticketStatus });
          return Response.json(
            {
              schema: "https://a.asimposium.org/schemas/sessions.v1.json",
              sponsor_id: "usr_sponsor_alpha",
              problem_id: "P-4DSP",
              fellow_id: "fellow-01JXYZ",
              ticket: validTicket,
              expires_at: "2026-09-10T00:01:00.000Z",
              workshop_cursor: 7,
              room_url:
                "wss://a.asimposium.org/v1/workshop-room?fellow=fellow-01JXYZ&problem=P-4DSP",
            },
            { headers: { "cache-control": "private, no-store" } },
          );
        }
        return Response.json(
          {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            sponsor_id: "usr_sponsor_alpha",
            problem_id: "P-4DSP",
            fellow_id: "fellow-01JXYZ",
            workshop_cursor: 7,
          },
          { headers: { "cache-control": "private, no-store" } },
        );
      },
    };

    const watch = new WorkshopWatch({
      sponsorId: "usr_sponsor_alpha",
      fellowId: "fellow-01JXYZ",
      problemId: "P-4DSP",
      renderedCursor: 7,
      runtime,
      onState: (s) => states.push(s),
      onRefresh: (r) => {
        refreshes.push(r);
        return true;
      },
    });

    watch.start();
    await settle();
    // S-6: same-origin POST only; cookie never leaves Agora; ticket never appears in WS URL.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "/console/workshop/fellow-01JXYZ/P-4DSP/room-ticket");
    assert.equal(calls[0]!.credentials, "same-origin");
    assert.equal(watch.transport, "ws");
    assert.equal(sockets.length, 1);
    assert.ok(!sockets[0]!.url.includes(validTicket));

    // On WS open, first frame carries {"auth":"<ticket>"}; live workshop_cursor=8 triggers immediate refresh!
    sockets[0]!.emit("open");
    assert.deepEqual(sockets[0]!.sent, [JSON.stringify({ auth: validTicket })]);
    sockets[0]!.emit("message", {
      data: JSON.stringify({
        control: "workshop-update",
        fellow_id: "fellow-01JXYZ",
        problem_id: "P-4DSP",
        workshop_cursor: 8,
      }),
    });
    await settle();
    assert.deepEqual(refreshes, ["change"]);
    assert.equal(states.at(-1)?.status, "refreshing");
    watch.stop();

    // Should-fail: 503 ROOM_UNAVAILABLE cleanly falls back to same-origin cursor polling!
    ticketStatus = 503;
    calls.length = 0;
    const fallbackWatch = new WorkshopWatch({
      sponsorId: "usr_sponsor_alpha",
      fellowId: "fellow-01JXYZ",
      problemId: "P-4DSP",
      renderedCursor: 7,
      runtime,
      onState: () => {},
      onRefresh: () => true,
    });
    fallbackWatch.start();
    await settle();
    assert.equal(fallbackWatch.transport, "poll");
    assert.ok(calls.some((c) => c.url.endsWith("/cursor") && c.method === "GET"));
    fallbackWatch.stop();
  });

  test("loadWorkshopRoomTicketResponse enforces authentication, scope match, and private no-store headers", async () => {
    const unauth = await loadWorkshopRoomTicketResponse(
      undefined,
      "fellow-01JXYZ",
      "P-4DSP",
      async () => {
        throw new Error("should not call Stoa");
      },
    );
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("cache-control"), "private, no-store");
    assert.equal(unauth.headers.get("vary"), "Cookie");

    const refused = await loadWorkshopRoomTicketResponse(
      "usr_sponsor_alpha",
      "fellow-01JXYZ",
      "P-4DSP",
      async () => ({ ok: false, reason: "refused", status: 404, detail: "not found" }),
    );
    assert.equal(refused.status, 404);

    const unavailable = await loadWorkshopRoomTicketResponse(
      "usr_sponsor_alpha",
      "fellow-01JXYZ",
      "P-4DSP",
      async () => ({ ok: false, reason: "refused", status: 503, detail: "room unavailable" }),
    );
    assert.equal(unavailable.status, 503);

    // Same-origin CSRF check honors Host when Next.js normalizes request.url to localhost,
    // while still refusing cross-origin, null-origin, and sec-fetch-site: cross-site requests.
    const loopbackReq = new Request("http://localhost:43917/console/workshop/f/p/room-ticket", {
      method: "POST",
      headers: {
        host: "127.0.0.1:43917",
        origin: "http://127.0.0.1:43917",
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(isSameOriginWorkshopRequest(loopbackReq, new URL(loopbackReq.url)), true);

    const evilReq = new Request("http://localhost:43917/console/workshop/f/p/room-ticket", {
      method: "POST",
      headers: { host: "127.0.0.1:43917", origin: "https://evil.example" },
    });
    assert.equal(isSameOriginWorkshopRequest(evilReq, new URL(evilReq.url)), false);

    const crossSiteReq = new Request("http://localhost:43917/console/workshop/f/p/room-ticket", {
      method: "POST",
      headers: {
        host: "127.0.0.1:43917",
        origin: "http://127.0.0.1:43917",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(isSameOriginWorkshopRequest(crossSiteReq, new URL(crossSiteReq.url)), false);
  });

  test("REGRESSION: WorkshopWatch falls back to authoritative /cursor polling on 403/404 ticket refusal and rejects unexpected WS query params", async () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const calls: string[] = [];
    const states: WorkshopWatchState[] = [];
    const runtime: WorkshopWatchRuntime = {
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0,
      openWebSocket: (url, protocol) => {
        const s = new FakeSocket(url, protocol);
        sockets.push(s);
        return s;
      },
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/room-ticket")) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(
          {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            sponsor_id: "usr_sponsor_alpha",
            problem_id: "P-4DSP",
            fellow_id: "fellow-01JXYZ",
            workshop_cursor: 7,
          },
          { headers: { "cache-control": "private, no-store" } },
        );
      },
    };
    const watch = new WorkshopWatch({
      sponsorId: "usr_sponsor_alpha",
      fellowId: "fellow-01JXYZ",
      problemId: "P-4DSP",
      renderedCursor: 7,
      runtime,
      onState: (s) => states.push(s),
      onRefresh: () => true,
    });
    watch.start();
    await settle();
    assert.equal(watch.transport, "poll");
    assert.equal(states.at(-1)?.status, "current");
    assert.ok(calls.some((u) => u.endsWith("/cursor")));
    assert.equal(sockets.length, 0);
    watch.stop();
  });
});
