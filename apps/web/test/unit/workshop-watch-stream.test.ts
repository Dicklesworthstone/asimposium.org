import { expect, test } from "bun:test";
import {
  WORKSHOP_WATCH_TIMEOUT_MS,
  WorkshopWatch,
  type WorkshopWatchRuntime,
  type WorkshopWatchSocket,
  type WorkshopWatchState,
} from "../../lib/workshop-watch.ts";

const scope = {
  sponsor_id: "usr_stream_owner",
  fellow_id: "fellow-stream",
  problem_id: "P-STREAM",
};
const url = "wss://a.asimposium.org/v1/workshop-room?fellow=fellow-stream&problem=P-STREAM";
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
class Clock {
  now = 0;
  private id = 0;
  readonly timers = new Map<number, { at: number; run: () => void }>();
  set: WorkshopWatchRuntime["setTimer"] = (run, delay) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.now + delay, run });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clear: WorkshopWatchRuntime["clearTimer"] = (id) => {
    this.timers.delete(id as unknown as number);
  };
  async advance(by: number) {
    const end = this.now + by;
    for (let turns = 0; ; turns++) {
      expect(turns).toBeLessThan(1000);
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].run();
      await settle();
    }
    this.now = end;
    await settle();
  }
}
class Socket implements WorkshopWatchSocket {
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void,
  ) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
function fixture(websocket = true) {
  const clock = new Clock();
  const socket = new Socket();
  const states: WorkshopWatchState["status"][] = [];
  const refreshes: string[] = [];
  const tickets: string[] = [];
  const streams: { url: string; init: RequestInit }[] = [];
  let output: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  let polls = 0;
  let access = true;
  let delayHeaders: ((response: Response) => void) | undefined;
  let stalledHeaders = false;
  let holdPoll = false;
  let delayedPoll: ((response: Response) => void) | undefined;
  const response = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "private, no-store" } },
    );
  const runtime: WorkshopWatchRuntime = {
    setTimer: clock.set,
    clearTimer: clock.clear,
    random: () => 0,
    openWebSocket: websocket ? () => socket : undefined,
    fetch: async (input) => {
      if (String(input).endsWith("/room-ticket")) {
        const ticket = `${"a".repeat(63)}${tickets.length}.${"b".repeat(86)}`;
        tickets.push(ticket);
        return Response.json(
          {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            ...scope,
            ticket,
            expires_at: "2026-11-26T18:00:00.000Z",
            workshop_cursor: 7,
            room_url: url,
          },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      expect(String(input)).toBe(`/console/workshop/${scope.fellow_id}/${scope.problem_id}/cursor`);
      polls++;
      if (holdPoll)
        return new Promise<Response>((resolve) => {
          delayedPoll = resolve;
        });
      return access
        ? Response.json(
            {
              schema: "https://a.asimposium.org/schemas/sessions.v1.json",
              ...scope,
              workshop_cursor: 7,
            },
            { headers: { "cache-control": "private, no-store" } },
          )
        : new Response(null, { status: 403 });
    },
    openSse: async (input, init) => {
      streams.push({ url: String(input), init });
      if (stalledHeaders)
        return new Promise<Response>((resolve) => {
          delayHeaders = resolve;
        });
      return response();
    },
  };
  const watch = new WorkshopWatch({
    sponsorId: scope.sponsor_id,
    fellowId: scope.fellow_id,
    problemId: scope.problem_id,
    renderedCursor: 7,
    runtime,
    onState: ({ status }) => states.push(status),
    onRefresh: (reason) => {
      refreshes.push(reason);
    },
  });
  return {
    watch,
    clock,
    socket,
    states,
    refreshes,
    tickets,
    streams,
    polls: () => polls,
    cancelled: () => cancelled,
    revoke() {
      access = false;
    },
    stallHeaders() {
      stalledHeaders = true;
    },
    holdPoll() {
      holdPoll = true;
    },
    latePoll() {
      holdPoll = false;
      delayedPoll?.(
        Response.json(
          {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            ...scope,
            workshop_cursor: 999,
          },
          { headers: { "cache-control": "private, no-store" } },
        ),
      );
    },
    lateHeaders() {
      delayHeaders?.(response());
    },
    async push(text: string) {
      output.enqueue(new TextEncoder().encode(text));
      await settle();
    },
    async notice(cursor: number, fellow = scope.fellow_id) {
      output.enqueue(
        new TextEncoder().encode(
          `event: workshop-update\ndata: ${JSON.stringify({ control: "workshop-update", fellow_id: fellow, problem_id: scope.problem_id, workshop_cursor: cursor })}\n\n`,
        ),
      );
      await settle();
    },
    async start() {
      watch.start();
      await settle();
    },
  };
}

test("WS failure uses a fresh POST-only SSE ticket, then recovers through authoritative polling", async () => {
  const f = fixture();
  await f.start();
  expect(f.watch.transport).toBe("ws");
  f.socket.fire("open");
  expect(JSON.parse(f.socket.sent[0]!).auth).toBe(f.tickets[0]);
  f.socket.fire("error");
  await settle();
  expect(f.watch.transport).toBe("sse");
  expect(f.tickets.length).toBe(2);
  expect(f.tickets[1]).not.toBe(f.tickets[0]);
  expect(f.streams[0]!.url).toBe(url.replace("wss:", "https:"));
  const init = f.streams[0]!.init;
  expect(init.method).toBe("POST");
  expect(init.credentials).toBe("omit");
  expect(init.mode).toBe("cors");
  expect(init.redirect).toBe("error");
  expect(JSON.parse(String(init.body))).toEqual({ auth: f.tickets[1] });
  expect(new Headers(init.headers).has("authorization")).toBe(false);
  expect(f.polls()).toBe(0);
  await f.notice(7);
  await f.notice(8);
  expect(f.refreshes).toEqual(["change"]);
  await f.push('event: reconnect\ndata: {"retry_ms":5000}\n\n');
  expect(f.watch.transport).toBe("poll");
  expect(f.polls()).toBe(1);
  expect(f.cancelled()).toBe(1);
  f.watch.stop();
  expect(f.clock.timers.size).toBe(0);
});

test("foreign notices never refresh a private view and only the cursor response ends access", async () => {
  const f = fixture(false);
  await f.start();
  await f.notice(7);
  f.revoke();
  await f.notice(999, "fellow-other-sponsor");
  expect(f.refreshes).toEqual(["access"]);
  expect(f.states.at(-1)).toBe("access-ended");
  expect(f.watch.transport).toBe("poll");
  expect(f.cancelled()).toBe(1);
  f.watch.stop();
  expect(f.clock.timers.size).toBe(0);
});

test("silent stream handshakes and headers that ignore abort cannot strand the watcher", async () => {
  const silent = fixture(false);
  await silent.start();
  await silent.push(": keepalive\n\n");
  await silent.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS);
  expect(silent.watch.transport).toBe("poll");
  expect(silent.polls()).toBe(1);
  expect(silent.cancelled()).toBe(1);
  silent.watch.stop();
  expect(silent.clock.timers.size).toBe(0);

  const late = fixture(false);
  late.stallHeaders();
  await late.start();
  await late.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS);
  expect(late.polls()).toBe(1);
  late.lateHeaders();
  await settle();
  expect(late.watch.transport).toBe("poll");
  expect(late.cancelled()).toBe(1);
  late.watch.stop();
  expect(late.clock.timers.size).toBe(0);
});

test("active streams still have a hard lifetime and pausing cancels all timers and reads", async () => {
  const f = fixture(false);
  await f.start();
  await f.notice(7);
  for (let i = 0; i < 3; i++) {
    await f.clock.advance(20_000);
    await f.push(": keepalive\n\n");
    expect(f.watch.transport).toBe("sse");
  }
  await f.clock.advance(WORKSHOP_WATCH_TIMEOUT_MS);
  expect(f.watch.transport).toBe("poll");
  expect(f.polls()).toBe(1);
  f.watch.stop();
  expect(f.clock.timers.size).toBe(0);
  const paused = fixture(false);
  await paused.start();
  await paused.notice(7);
  paused.watch.setActive(false);
  await settle();
  expect(paused.cancelled()).toBe(1);
  expect(paused.clock.timers.size).toBe(0);
  expect(paused.polls()).toBe(0);
  expect(paused.states.at(-1)).toBe("paused");
  paused.watch.stop();
});

test("a retired poll cannot take ownership from a resumed stream handshake", async () => {
  const f = fixture(false);
  await f.start();
  await f.notice(7);
  f.holdPoll();
  await f.push('event: reconnect\ndata: {"retry_ms":5000}\n\n');
  expect(f.polls()).toBe(1);
  f.stallHeaders();
  f.watch.setActive(false);
  f.watch.setActive(true);
  await settle();
  expect(f.watch.transport).toBe("sse");
  expect(f.streams.length).toBe(2);
  const resumed = f.streams.at(-1);
  expect(resumed?.init.signal?.aborted).toBe(false);
  expect(f.polls()).toBe(1);
  f.watch.setActive(false);
  await settle();
  expect(resumed?.init.signal?.aborted).toBe(true);
  f.lateHeaders();
  f.latePoll();
  await settle();
  expect(f.refreshes).toEqual([]);
  expect(f.polls()).toBe(1);
  expect(f.clock.timers.size).toBe(0);
  expect(f.cancelled()).toBe(2);
  f.watch.stop();
});
