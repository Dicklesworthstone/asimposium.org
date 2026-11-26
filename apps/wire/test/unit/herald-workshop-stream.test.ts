import { describe, expect, test } from "bun:test";
import { SERVICE_ENVELOPE_HEADER } from "../../src/auth/http.ts";
import { roomRefusal } from "../../src/herald/room-http.ts";
import { mintWorkshopRoomTicket, verifyWorkshopRoomTicket } from "../../src/herald/room-ticket.ts";
import { WorkshopRoomStreams } from "../../src/herald/room-workshop-sse.ts";
import {
  type HeraldRuntimeEnv,
  heraldRoomFetch,
  isWorkshopRoomStream,
} from "../../src/herald/runtime.ts";

const KEY = JSON.stringify({ kid: "workshop-stream-test", seedHex: "22".repeat(32) });
const scope = { fellowId: "fellow-stream", problemId: "P-STREAM" };
const sponsorId = "usr_stream_owner";
const route = "https://a.asimposium.org/v1/workshop-room?fellow=fellow-stream&problem=P-STREAM";
const origin = "https://asimposium.org";
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(route, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
async function mint(sponsor = sponsorId) {
  const ticket = await mintWorkshopRoomTicket({ ...scope, sponsorId: sponsor }, KEY);
  if (!ticket) throw new Error("ticket fixture unavailable");
  return ticket.ticket;
}

function fixture(options: { lifetimeMs?: number; operationTimeoutMs?: number } = {}) {
  const used = new Set<string>();
  let cursor = 7;
  let allowed = true;
  let headReads = 0;
  let stalled = false;
  const streams = new WorkshopRoomStreams({
    verifyWorkshopTicket: (ticket, now) =>
      verifyWorkshopRoomTicket(ticket, { signingKey: KEY }, now),
    consumeTicketNonce: async (nonce) => {
      if (used.has(nonce)) return false;
      used.add(nonce);
      return true;
    },
    workshopHead: async (sponsor, fellow, problem) => {
      headReads++;
      if (stalled) return new Promise<never>(() => {});
      return allowed &&
        sponsor === sponsorId &&
        fellow === scope.fellowId &&
        problem === scope.problemId
        ? { cursor }
        : null;
    },
    refuse: roomRefusal,
    socketCount: () => 0,
    lifetimeMs: options.lifetimeMs ?? 2_000,
    operationTimeoutMs: options.operationTimeoutMs ?? 1_000,
    pollIntervalMs: 5,
  });
  return {
    streams,
    used,
    update(value: number) {
      cursor = value;
    },
    revoke() {
      allowed = false;
    },
    stall() {
      stalled = true;
    },
    reads: () => headReads,
  };
}

describe("private workshop streamed-fetch fallback", () => {
  test("strict ticket auth refuses anonymous, extra fields, scope changes, other sponsors, and replay", async () => {
    const f = fixture();
    for (const body of [
      {},
      { auth: "invalid" },
      { auth: await mint(), extra: true },
      { auth: "x".repeat(2048) },
    ]) {
      expect((await f.streams.fetch(request(body), scope)).status).toBe(401);
    }
    expect(
      (await f.streams.fetch(request({ auth: await mint() }), { ...scope, problemId: "P-OTHER" }))
        .status,
    ).toBe(401);
    expect(
      (await f.streams.fetch(request({ auth: await mint("usr_other_sponsor") }), scope)).status,
    ).toBe(401);
    const ticket = await mint();
    const response = await f.streams.fetch(request({ auth: ticket }), scope);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await f.streams.fetch(request({ auth: ticket }), scope)).status).toBe(401);
    await response.body!.cancel();
    expect(f.streams.count()).toBe(0);
  });

  test("only scoped cursors stream, current ownership is rechecked, and cancellation releases capacity", async () => {
    const f = fixture();
    const response = await f.streams.fetch(request({ auth: await mint() }), scope);
    const reader = response.body!.getReader();
    const decode = (part: Awaited<ReturnType<typeof reader.read>>) =>
      new TextDecoder().decode(part.value);
    expect(decode(await reader.read())).toContain('"workshop_cursor":7');
    f.update(8);
    const update = decode(await reader.read());
    expect(update).toContain('"workshop_cursor":8');
    expect(update).not.toMatch(/body_md|cas_hash|ticket|sponsor_id/);
    f.revoke();
    expect(decode(await reader.read())).toContain('event: closed\ndata: {"reason":"access-ended"}');
    expect((await reader.read()).done).toBe(true);
    expect(f.streams.count()).toBe(0);
    const reads = f.reads();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(f.reads()).toBe(reads);
  });

  test("stalled authority and unread request bodies cannot outlive their deadlines", async () => {
    const f = fixture({ operationTimeoutMs: 10, lifetimeMs: 40 });
    const response = await f.streams.fetch(request({ auth: await mint() }), scope);
    const reader = response.body!.getReader();
    await reader.read();
    f.stall();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: reconnect");
    expect((await reader.read()).done).toBe(true);
    expect(f.streams.count()).toBe(0);
    let cancelled = false;
    const unread = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const slow = new Request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: unread,
    });
    expect((await f.streams.fetch(slow, scope)).status).toBe(503);
    expect(cancelled).toBe(true);
    expect(f.streams.count()).toBe(0);
  });

  test("a hard lifetime and shared WebSocket sponsor caps bound stream work", async () => {
    const f = fixture({ lifetimeMs: 25 });
    const response = await f.streams.fetch(request({ auth: await mint() }), scope);
    const text = await response.text();
    expect(text).toContain("event: workshop-update");
    expect(text).toContain("event: reconnect");
    expect(f.streams.count()).toBe(0);
    const capped = new WorkshopRoomStreams({
      verifyWorkshopTicket: (ticket, now) =>
        verifyWorkshopRoomTicket(ticket, { signingKey: KEY }, now),
      consumeTicketNonce: async () => true,
      workshopHead: async () => ({ cursor: 7 }),
      socketCount: (sponsor) => (sponsor === undefined ? 8 : 8),
      refuse: roomRefusal,
    });
    expect((await capped.fetch(request({ auth: await mint() }), scope)).status).toBe(429);
    expect(capped.count()).toBe(0);
  });

  test("gateway permits only configured-origin POST preflight, without cookies or bearer credentials", async () => {
    let forwards = 0;
    const env = {
      AGORA_ORIGIN: origin,
      HERALD_ROOMS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => {
            forwards++;
            return new Response("cursor");
          },
        }),
      },
    } as unknown as HeraldRuntimeEnv;
    const fetch = (req: Request) =>
      heraldRoomFetch(req, env, () => new Response(null, { status: 599 }));
    const preflight = await fetch(
      new Request(route, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.has("access-control-allow-credentials")).toBe(false);
    expect(forwards).toBe(0);
    const auth = { auth: await mint() };
    const rejectedHeaders: Record<string, string>[] = [
      { origin: "https://elsewhere.invalid" },
      { cookie: "session=private" },
      { authorization: "Bearer private" },
      { [SERVICE_ENVELOPE_HEADER]: "spoof" },
    ];
    for (const headers of rejectedHeaders) {
      const response = await fetch(request(auth, headers));
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(auth.auth);
    }
    expect(forwards).toBe(0);
    const response = await fetch(request(auth));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    expect(forwards).toBe(1);
    expect(isWorkshopRoomStream(request(auth))).toBe(true);
    expect(isWorkshopRoomStream(new Request(route))).toBe(false);
  });
});
