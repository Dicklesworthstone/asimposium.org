import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { HERALD_ROOM_LIMITS } from "@asimposium/contracts/herald-room-model";
import { PUBLIC_WATCH_REQUEST_TIMEOUT_MS } from "@asimposium/contracts/public-watch";
import {
  HeraldRoomFanout,
  publicRoomAttachment,
  type RoomSocket,
} from "../../../wire/src/herald/room-core.ts";
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
  function publicRoom(fetch: PublicWatchRuntime["fetch"]) {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const sources: FakeEventSource[] = [];
    let refreshes = 0;
    const watch = new PublicLedgerWatch({
      origin: "https://a.asimposium.org",
      targets: [{ path: "/p/P-DEMO.json", etag: '"p1"' }],
      onState: () => {},
      onRefresh: () => {
        refreshes++;
      },
      runtime: {
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        random: () => 0,
        fetch,
        openWebSocket(url, protocol) {
          const socket = new FakeSocket(url, protocol, true);
          sockets.push(socket);
          return socket;
        },
        openEventSource(url) {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        },
      },
    });
    watch.start();
    return { clock, watch, sockets, sources, refreshes: () => refreshes };
  }

  const notice = { data: JSON.stringify({ control: "resync", through: 2 }) };

  test("bursts of same-cursor refreshes respect the actual room ACK budget without disconnecting", async () => {
    let heads = 0;
    const f = publicRoom(async (url, init) => {
      assert.equal(String(url), "https://a.asimposium.org/p/P-DEMO.json");
      assert.equal(init?.method, "HEAD");
      heads++;
      return new Response(null, { status: 304, headers: { etag: '"p1"' } });
    });
    const client = f.sockets[0];
    assert.ok(client);
    const closed: number[] = [];
    const acknowledgements: { at: number; data: string }[] = [];
    let attachment: unknown;
    const server: RoomSocket = {
      get readyState() {
        return closed.length === 0 ? 1 : 3;
      },
      send: (data) => client.emit("message", { data }),
      close: (code) => {
        closed.push(code);
        client.emit("close");
      },
      serializeAttachment: (value) => {
        attachment = structuredClone(value);
      },
      deserializeAttachment: () => structuredClone(attachment),
    };
    const peers: RoomSocket[] = [];
    const room = new HeraldRoomFanout({
      sockets: () => peers,
      accept: (socket) => peers.push(socket),
    });
    const now = () => 1_000_000 + f.clock.now;
    client.send = (data) => {
      client.sent.push(data);
      acknowledgements.push({ at: f.clock.now, data });
      const ack = room.beginAck(server, data, now());
      if (ack !== undefined) room.completeAck(server, ack, undefined, { seq: 2 }, now());
    };
    client.emit("open");
    assert.equal(
      room.connectPublic(
        server,
        { problemId: "P-DEMO", since: 0, ipHash: "a".repeat(64) },
        { seq: 2 },
        now(),
      ),
      "accepted",
    );
    await settle();
    assert.equal(heads, 1, "validator reads start immediately, without waiting for the ACK");
    for (let i = 0; i < 200; i++) room.refresh(server, undefined, { seq: 2 }, now());
    assert.deepEqual(closed, [], "a valid same-cursor refresh must not trigger a 1013 refusal");
    const interval = HERALD_ROOM_LIMITS.acknowledgementIntervalMs;
    await f.clock.advance(interval);
    for (let i = 0; i < 200; i++) room.refresh(server, undefined, { seq: 2 }, now());
    await f.clock.advance(interval * 2);
    assert.deepEqual(acknowledgements, [
      { at: interval, data: '{"ack":2}' },
      { at: interval * 2, data: '{"ack":2}' },
      { at: interval * 3, data: '{"ack":2}' },
    ]);
    assert.deepEqual(closed, []);
    assert.equal(publicRoomAttachment(server)?.pending, false);
    assert.equal(heads, 3, "each coalesced same-cursor notice revalidates rendered bytes");
    assert.equal(f.watch.transport, "ws");
    assert.equal(f.sources.length, 0);
    f.watch.stop();
    assert.equal(f.clock.timers.size, 0);
  });

  for (const transition of ["stop", "pause", "fallback"]) {
    test(`${transition} cancels a queued ACK and ignores late room notices`, async () => {
      const f = publicRoom(
        async () => new Response(null, { status: 304, headers: { etag: '"p1"' } }),
      );
      const client = f.sockets[0];
      assert.ok(client);
      client.emit("message", notice);
      await settle();
      if (transition === "stop") f.watch.stop();
      else if (transition === "pause") f.watch.setActive(false);
      else client.emit("error");
      client.emit("message", notice);
      await f.clock.advance(HERALD_ROOM_LIMITS.acknowledgementIntervalMs);
      assert.deepEqual(client.sent, [], "a closed transport must never send its queued ACK");
      assert.equal(client.closed, true);
      if (transition === "fallback") assert.equal(f.watch.transport, "sse");
      f.watch.stop();
      assert.equal(f.clock.timers.size, 0);
    });
  }

  test("duplicate notices share one bounded ACK deadline and a failed send falls back to SSE", async () => {
    const f = publicRoom(
      async () => new Response(null, { status: 304, headers: { etag: '"p1"' } }),
    );
    const client = f.sockets[0];
    assert.ok(client);
    let sends = 0;
    client.send = () => {
      sends++;
      throw new Error("The socket closed before its ACK");
    };
    client.emit("message", notice);
    const interval = HERALD_ROOM_LIMITS.acknowledgementIntervalMs;
    await f.clock.advance(interval - 1);
    for (let i = 0; i < 200; i++) client.emit("message", notice);
    assert.equal(sends, 0);
    await f.clock.advance(1);
    assert.equal(sends, 1, "duplicate notices cannot defer or multiply the queued ACK");
    assert.equal(f.watch.transport, "sse");
    assert.equal(f.sources.length, 1);
    f.watch.stop();
    assert.equal(f.clock.timers.size, 0);
  });

  for (const transport of ["ws", "sse"]) {
    test(`a quiet healthy ${transport} reconciles a hidden object when its wake is lost`, async () => {
      let heads = 0;
      let hidden = false;
      const f = publicRoom(async (url, init) => {
        assert.equal(String(url), "https://a.asimposium.org/p/P-DEMO.json");
        assert.equal(init?.method, "HEAD", "live recovery reads validators, not global cursors");
        heads++;
        return hidden
          ? new Response(null, { headers: { etag: '"withheld-object"' } })
          : new Response(null, { status: 304, headers: { etag: '"p1"' } });
      });
      const socket = f.sockets[0]!;
      if (transport === "ws") {
        socket.emit("open");
        socket.emit("message", notice);
      } else {
        socket.emit("error");
        f.sources[0]!.emit("resync", notice);
      }
      await settle();
      assert.equal(heads, 1);
      hidden = true;
      // The scientific cursor and transport stay healthy; no second resync
      // arrives to rescue the reader from an omitted notification.
      for (let i = 0; i < 3; i++) {
        await f.clock.advance(20_000);
        if (transport === "ws") socket.emit("message", { data: "pong" });
      }
      await settle();
      assert.equal(f.watch.transport, transport);
      assert.equal(heads, 2, "bounded reconciliation must inspect the exact rendered resource");
      assert.equal(f.refreshes(), 1, "withdrawn bytes must trigger a server reread");
      f.watch.stop();
      assert.equal(f.clock.timers.size, 0);
    });
  }

  for (const transport of ["ws", "sse"]) {
    test(`a single ${transport} notice recovers a failed validator read without another push`, async () => {
      let heads = 0;
      let polls = 0;
      const backoff = transport === "ws" ? 20_000 : 33_000;
      const f = publicRoom(async (url, init) => {
        if (String(url).endsWith("/cursor")) {
          polls++;
          return new Response("2");
        }
        assert.equal(init?.method, "HEAD");
        assert.equal(new Headers(init?.headers).get("if-none-match"), '"p1"');
        if (++heads === 1) {
          if (transport === "ws") throw new TypeError("Connection lost");
          return new Response(null, { status: 429, headers: { "retry-after": "33" } });
        }
        return new Response(null, { headers: { etag: '"p2"' } });
      });
      const socket = f.sockets[0];
      assert.ok(socket);
      if (transport === "ws") socket.emit("message", notice);
      else {
        socket.emit("error");
        const source = f.sources[0];
        assert.ok(source);
        source.emit("resync", notice);
      }
      await settle();
      assert.equal(f.watch.transport, "poll");
      await f.clock.advance(backoff - 1);
      assert.deepEqual([heads, polls, f.refreshes()], [1, 0, 0]);
      await f.clock.advance(1);
      assert.deepEqual([heads, polls, f.refreshes()], [2, 1, 1]);
      f.watch.stop();
      assert.equal(f.clock.timers.size, 0);
    });
  }

  test("pausing cancels recovery from a failed live HEAD before its backoff expires", async () => {
    let reads = 0;
    const f = publicRoom(async () => {
      reads++;
      return new Response(null, { status: 503 });
    });
    const socket = f.sockets[0];
    assert.ok(socket);
    socket.emit("message", notice);
    await settle();
    f.watch.setActive(false);
    await f.clock.advance(120_000);
    assert.equal(reads, 1);
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.refreshes(), 0);
    f.watch.stop();
  });

  test("silent handshakes fall through both transports, then poll exact validators", async () => {
    const f = publicRoom(async (url, init) => {
      if (String(url).endsWith("/cursor")) return new Response("100");
      assert.equal(new Headers(init?.headers).get("if-none-match"), '"p1"');
      return new Response(null, { headers: { etag: '"p2"' } });
    });
    const socket = f.sockets[0]!;
    socket.emit("open");
    socket.emit("message", { data: "pong" });
    await f.clock.advance(PUBLIC_WATCH_REQUEST_TIMEOUT_MS);
    assert.equal(f.watch.transport, "sse");
    socket.emit("close");
    socket.emit("message", notice);
    f.sources[0]!.emit("resync", { data: "{}" });
    await f.clock.advance(PUBLIC_WATCH_REQUEST_TIMEOUT_MS);
    assert.equal(f.watch.transport, "poll");
    assert.equal(f.refreshes(), 1);
    assert.equal(f.sources.length, 1);
    assert.ok(f.sources[0]!.closed);

    f.watch.setActive(false);
    f.watch.setActive(true);
    assert.match(f.sockets[1]!.url, /since=0$/, "global cursor cannot resume a scoped room");
    f.watch.stop();
    await f.clock.advance(120_000);
    assert.equal(f.sources.length, 1);
    assert.equal(f.clock.timers.size, 0);
  });

  test("valid pongs keep a room live; a missed heartbeat and a lost SSE terminal event recover", async () => {
    const calls: string[] = [];
    const f = publicRoom(async (url) => {
      calls.push(String(url));
      return String(url).endsWith("/cursor")
        ? new Response("30")
        : new Response(null, { status: 304, headers: { etag: '"p1"' } });
    });
    const socket = f.sockets[0]!;
    socket.emit("open");
    socket.emit("message", notice);
    await settle();
    await f.clock.advance(HERALD_ROOM_LIMITS.heartbeatSeconds * 1000);
    assert.equal(socket.sent.at(-1), "ping");
    socket.emit("message", { data: "pong" });
    await f.clock.advance(HERALD_ROOM_LIMITS.heartbeatSeconds * 1000);
    assert.equal(f.watch.transport, "ws");
    await f.clock.advance(PUBLIC_WATCH_REQUEST_TIMEOUT_MS);
    assert.equal(f.watch.transport, "sse");
    const source = f.sources[0]!;
    assert.match(source.url, /since=2$/);
    source.emit("resync", notice);
    await settle();
    await f.clock.advance(HERALD_ROOM_LIMITS.sseLifetimeMs);
    assert.equal(f.watch.transport, "sse");
    assert.ok(calls.every((url) => !url.endsWith("/cursor")));
    await f.clock.advance(PUBLIC_WATCH_REQUEST_TIMEOUT_MS);
    assert.equal(f.watch.transport, "poll");
    assert.ok(calls.some((url) => url.endsWith("/cursor")));
    assert.equal(f.refreshes(), 0);
    f.watch.stop();
    assert.equal(f.clock.timers.size, 0);
  });

  test("losing both transports during a HEAD check hands off to continuous polling", async () => {
    const held = Promise.withResolvers<Response>();
    let heads = 0;
    let polls = 0;
    const f = publicRoom(async (url) => {
      if (String(url).endsWith("/cursor")) return new Response(String(++polls));
      if (++heads === 1) return held.promise;
      return new Response(null, { headers: { etag: '"p2"' } });
    });
    f.sockets[0]!.emit("message", notice);
    f.sockets[0]!.emit("error");
    f.sources[0]!.emit("error");
    assert.equal(f.watch.transport, "poll");
    assert.equal(heads, 1);
    held.resolve(new Response(null, { status: 304, headers: { etag: '"p1"' } }));
    await settle();
    assert.equal(polls, 1);
    assert.equal(f.refreshes(), 1);
    await f.clock.advance(10_000);
    assert.equal(polls, 2);
    f.watch.stop();
    assert.equal(f.clock.timers.size, 0);
  });

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
    assert.deepEqual(sockets[0]!.sent, []);
    assert.equal(calls.filter((c) => c.url.endsWith("/cursor")).length, 0);
    assert.equal(calls.filter((c) => c.method === "HEAD").length, 1);
    assert.equal(calls[0]!.credentials, "omit");
    assert.equal(refreshes, 1);
    await clock.advance(HERALD_ROOM_LIMITS.acknowledgementIntervalMs);
    assert.deepEqual(sockets[0]!.sent, ['{"ack":2}']);

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
