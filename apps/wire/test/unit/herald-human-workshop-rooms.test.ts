import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  HERALD_ROOM_LIMITS,
  HERALD_ROOM_PROTOCOL,
  parseWorkshopRoomAuth,
  workshopRoomName,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import { publicWatchPath } from "../../../../packages/contracts/src/public-watch.ts";
import { SERVICE_ENVELOPE_HEADER } from "../../src/auth/http.ts";
import type { Env } from "../../src/env.ts";
import type { HeraldDatabase } from "../../src/herald/outbox.ts";
import {
  HeraldRoomController,
  type HeraldRoomPort,
  workshopRoomRoute,
} from "../../src/herald/room-controller.ts";
import type { RoomSocket } from "../../src/herald/room-core.ts";
import { roomRefusal } from "../../src/herald/room-http.ts";
import { heraldSseFetch } from "../../src/herald/room-sse.ts";
import {
  liveWorkshopRoomHead,
  mintWorkshopRoomTicket,
  verifyWorkshopRoomTicket,
} from "../../src/herald/room-ticket.ts";
import { publicWatchFetch } from "../../src/http/public-watch-cors.ts";
import { createSponsorWorkshopRoomTicketRouter } from "../../src/sessions/sponsor-workshop-room-ticket.ts";
import { migratedSqlite } from "../support/migrated-sqlite.ts";

const TEST_ED25519_KEY = JSON.stringify({
  kid: "test-ed25519-k1",
  seedHex: "11".repeat(32),
});

class MockSocket implements RoomSocket {
  readyState = 1;
  saved: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  send(text: string) {
    this.sent.push(text);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  serializeAttachment(value: unknown) {
    this.saved = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.saved);
  }
}

function localD1(sqlite: ReturnType<typeof migratedSqlite>): D1Database & HeraldDatabase {
  const prepare = (query: string) => {
    const bound = (...values: (string | number | null)[]) => ({
      async all<T>() {
        return { success: true as const, results: sqlite.prepare(query).all(...values) as T[] };
      },
      async first<T>() {
        const row = sqlite.prepare(query).get(...values);
        return (row ?? null) as T | null;
      },
      async run() {
        const res = sqlite.prepare(query).run(...values);
        return { success: true as const, results: [], meta: { changes: res.changes } };
      },
    });
    return { bind: bound, ...bound() };
  };
  return { prepare } as unknown as D1Database & HeraldDatabase;
}

describe("Fable §11 Herald human public rooms, SSE fallback, and Ed25519 workshop rooms (kfag)", () => {
  test("unauthenticated human WS connects to /p/:id/room without bearer, receives public_seq only, caps per-IP, and rejects cookies (S-6)", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    sqlite.run(
      "INSERT INTO problems (id, title, status, public_seq, created_at, updated_at) VALUES ('P-DEMO', 'Demo', 'active', 2, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
    );
    sqlite.run(
      "INSERT INTO problems (id, title, status, public_seq, created_at, updated_at) VALUES ('P-PRIV', 'Priv', 'private-draft', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
    );

    const sockets: MockSocket[] = [];
    let authCalls = 0;
    let generation = 0;
    let alarm: number | null = null;
    const now = 1_700_000_000_000;

    const port: HeraldRoomPort = {
      owns: (p) => p === "P-DEMO" || p === "P-PRIV",
      sockets: () => sockets,
      accept: (s) => sockets.push(s as MockSocket),
      lastPing: () => now,
      alarmAt: async () => alarm,
      setAlarm: async (t) => {
        alarm = t;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
      generation: async () => generation,
      rememberGeneration: async (g) => {
        generation = Math.max(generation, g);
      },
      pair: () => ({ client: "c", server: new MockSocket() }),
      upgraded: () => new Response("upgraded", { status: 200 }),
    };

    const controller = new HeraldRoomController({
      db,
      port,
      now: () => now,
      validToken: () => false,
      authenticate: async () => {
        authCalls++;
        return undefined;
      },
      refuse: roomRefusal,
    });

    // S-6 should-fail: cookies are NEVER accepted on public rooms on a.asimposium.org.
    const cookieRes = await controller.fetch(
      new Request("https://a.asimposium.org/p/P-DEMO/room?since=0", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": HERALD_ROOM_PROTOCOL,
          cookie: "asimp.session=SECRET_COOKIE",
        },
      }),
    );
    expect(cookieRes.status).toBe(401);
    expect(sockets.length).toBe(0);

    // Private-draft problem must return 404.
    const privRes = await controller.fetch(
      new Request("https://a.asimposium.org/p/P-PRIV/room?since=0", {
        headers: { upgrade: "websocket", "sec-websocket-protocol": HERALD_ROOM_PROTOCOL },
      }),
    );
    expect(privRes.status).toBe(404);

    // Positive: unauthenticated read-only human connection succeeds without auth queries.
    const okRes = await controller.fetch(
      new Request("https://a.asimposium.org/p/P-DEMO/room?since=0", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": HERALD_ROOM_PROTOCOL,
          "cf-connecting-ip": "203.0.113.10",
        },
      }),
    );
    expect(okRes.status).toBe(200);
    expect(authCalls).toBe(0);
    expect(sockets.length).toBe(1);
    const frame0 = JSON.parse(sockets[0]!.sent[0]!);
    expect(frame0.control).toBe("resync");
    expect(frame0.through).toBe(2);
    expect(sockets[0]!.sent[0]).not.toContain("workshop");

    // Acknowledge frame 2, advance public_seq to 3, and nudge -> immediate live push!
    await controller.webSocketMessage(sockets[0]!, JSON.stringify({ ack: 2 }));
    sqlite.run("UPDATE problems SET public_seq = 3 WHERE id = 'P-DEMO'");
    const nudgeRes = await controller.fetch(
      new Request("https://herald.internal/_herald/P-DEMO/nudge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation: 1 }),
      }),
    );
    expect(nudgeRes.status).toBe(204);
    expect(sockets[0]!.sent.length).toBe(2);
    expect(JSON.parse(sockets[0]!.sent[1]!).through).toBe(3);
    expect(authCalls).toBe(0);

    // Per-IP cap enforced for unauthenticated human viewers (limit = 4).
    for (let i = 1; i < HERALD_ROOM_LIMITS.perPublicIp; i++) {
      const r = await controller.fetch(
        new Request("https://a.asimposium.org/p/P-DEMO/room?since=0", {
          headers: {
            upgrade: "websocket",
            "cf-connecting-ip": "203.0.113.10",
          },
        }),
      );
      expect(r.status).toBe(200);
    }
    const capped = await controller.fetch(
      new Request("https://a.asimposium.org/p/P-DEMO/room?since=0", {
        headers: {
          upgrade: "websocket",
          "cf-connecting-ip": "203.0.113.10",
        },
      }),
    );
    expect(capped.status).toBe(429);

    // Privacy transition closes all public sockets immediately with 1008.
    sqlite.run("UPDATE problems SET status = 'dormant' WHERE id = 'P-DEMO'");
    await controller.alarm();
    expect(sockets[0]!.closed?.code).toBe(1008);
    sqlite.close();
  });

  test("bounded persistent SSE fallback (/p/:id/room/sse) streams live public_seq with credentialless CORS and rejects cookies", async () => {
    expect(publicWatchPath("/p/P-DEMO/room/sse")).toBe("sse");
    expect(publicWatchPath("/p/P-DEMO/room/sse?since=0")).toBe("sse");
    expect(publicWatchPath("/p/P-DEMO/room/sse?token=bad")).toBeUndefined();

    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    sqlite.run(
      "INSERT INTO problems (id, title, status, public_seq, created_at, updated_at) VALUES ('P-DEMO', 'Demo', 'active', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
    );

    // S-6: cookie and service-envelope headers rejected with 401.
    const cookieRes = await publicWatchFetch(
      new Request("https://a.asimposium.org/p/P-DEMO/room/sse?since=0", {
        headers: { cookie: "asimp.session=nope" },
      }),
      () =>
        heraldSseFetch(
          new Request("https://a.asimposium.org/p/P-DEMO/room/sse?since=0", {
            headers: { cookie: "asimp.session=nope" },
          }),
          { DB: db },
          () => new Response("miss", { status: 404 }),
        ),
    );
    expect(cookieRes.status).toBe(401);

    const envReq = new Request("https://a.asimposium.org/p/P-DEMO/room/sse?since=0", {
      headers: { [SERVICE_ENVELOPE_HEADER]: "v1.fake" },
    });
    const envRes = await publicWatchFetch(envReq, () =>
      heraldSseFetch(envReq, { DB: db }, () => new Response("miss", { status: 404 })),
    );
    expect(envRes.status).toBe(401);

    // Positive: live push over SSE + wildcard CORS without credentials + bounded reconnect termination.
    const req = new Request("https://a.asimposium.org/p/P-DEMO/room/sse?since=0");
    const res = await publicWatchFetch(req, () =>
      heraldSseFetch(req, { DB: db }, () => new Response("miss", { status: 404 }), {
        lifetimeMs: 80,
        pollIntervalMs: 15,
        keepaliveMs: 500,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();

    setTimeout(() => {
      sqlite.run("UPDATE problems SET public_seq = 2 WHERE id = 'P-DEMO'");
    }, 20);

    const body = await res.text();
    expect(body).toContain("retry: 5000");
    expect(body).toContain('"through":1');
    expect(body).toContain('"through":2');
    expect(body).toContain("event: reconnect");
    sqlite.close();
  });

  test("private sponsor workshop DO room authenticates via 60s single-use Ed25519 ticket, refuses replay/cross-sponsor/revoked/suspended, and pushes live workshop_cursor", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    const now = 1_700_000_000_000;
    const sponsorA = "usr_sponsor_alpha";
    const sponsorB = "usr_sponsor_beta";
    const fellowA = "F-01KFAGFELLOW00000000000001";
    const problemId = "P-WORK1";
    const sessionId = "S-KFAG-01";
    const ts = "2026-09-10T00:00:00.000Z";

    sqlite.run(
      "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?), (?, ?, ?)",
      [sponsorA, now, now, sponsorB, now, now],
    );
    sqlite.run(
      "INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at, status) VALUES (?, ?, 'kfag-fellow', 'm', 'h', ?, 'active')",
      [fellowA, sponsorA, now],
    );
    sqlite.run(
      "INSERT INTO problems (id, title, status, public_seq, created_at, updated_at) VALUES (?, 'Work', 'active', 0, ?, ?)",
      [problemId, ts, ts],
    );
    sqlite.run(
      "INSERT INTO sessions (session_id, fellow_id, problem_id, opened_at, last_heartbeat_at, idle_close_at) VALUES (?, ?, ?, ?, ?, ?)",
      [sessionId, fellowA, problemId, ts, ts, "2026-09-10T12:00:00.000Z"],
    );
    sqlite.run(
      `INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, cas_hash, relates_to_json, force_note, created_at)
       VALUES ('W-SECRET-1', ?, ?, ?, 1, 'note', 'PRIVATE_DRAFT_CANARY_TITLE', 'PRIVATE_DRAFT_CANARY_BODY', NULL, '[]', 0, ?)`,
      [problemId, fellowA, sessionId, ts],
    );

    // 1. Router mints a 60s Ed25519 ticket for Sponsor A, refuses Sponsor B (404), and fails closed (503) without key/binding.
    const makeRouter = (sponsorId: string) =>
      createSponsorWorkshopRoomTicketRouter({
        verifiedSponsor: async (rawReq) => ({
          principal: { type: "sponsor" as const, sponsorId },
          rawBody: new Uint8Array(await rawReq.arrayBuffer()),
        }),
      });
    const fakeHeraldNs = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    };
    const envWithKey = {
      DB: db,
      STOA_ORIGIN: "https://a.asimposium.org",
      CHECKPOINT_SIGNING_KEY: TEST_ED25519_KEY,
      HERALD_ROOMS: fakeHeraldNs,
    } as unknown as Env;

    const noKeyRes = await makeRouter(sponsorA).fetch(
      new Request("https://a.asimposium.org/v1/sponsors/workshop/room-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fellow_id: fellowA, problem_id: problemId }),
      }),
      { ...envWithKey, CHECKPOINT_SIGNING_KEY: undefined } as unknown as Env,
    );
    expect(noKeyRes.status).toBe(503);

    const crossSponsorRes = await makeRouter(sponsorB).fetch(
      new Request("https://a.asimposium.org/v1/sponsors/workshop/room-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fellow_id: fellowA, problem_id: problemId }),
      }),
      envWithKey,
    );
    expect(crossSponsorRes.status).toBe(404);

    // Wave 15 regression: Sponsor A cannot mint a workshop room ticket for a nonexistent
    // problem or another sponsor's private-draft problem without membership (404).
    const otherPrivateProblem = "P-PRIVB";
    sqlite.run(
      "INSERT INTO problems (id, title, status, sponsor_id, public_seq, created_at, updated_at) VALUES (?, 'Secret B', 'private-draft', ?, 0, ?, ?)",
      [otherPrivateProblem, sponsorB, ts, ts],
    );
    const missingProblemRes = await makeRouter(sponsorA).fetch(
      new Request("https://a.asimposium.org/v1/sponsors/workshop/room-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fellow_id: fellowA, problem_id: "P-NOPE1" }),
      }),
      envWithKey,
    );
    expect(missingProblemRes.status).toBe(404);
    const otherPrivateRes = await makeRouter(sponsorA).fetch(
      new Request("https://a.asimposium.org/v1/sponsors/workshop/room-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fellow_id: fellowA, problem_id: otherPrivateProblem }),
      }),
      envWithKey,
    );
    expect(otherPrivateRes.status).toBe(404);

    const mintRes = await makeRouter(sponsorA).fetch(
      new Request("https://a.asimposium.org/v1/sponsors/workshop/room-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fellow_id: fellowA, problem_id: problemId }),
      }),
      envWithKey,
    );
    expect(mintRes.status).toBe(200);
    expect(mintRes.headers.get("cache-control")).toBe("private, no-store");
    const minted = (await mintRes.json()) as {
      ticket: string;
      room_url: string;
      workshop_cursor: number;
    };
    expect(minted.workshop_cursor).toBe(1);
    expect(minted.room_url).toBe(
      `wss://a.asimposium.org/v1/workshop-room?fellow=${fellowA}&problem=${problemId}`,
    );
    expect(minted.room_url).not.toContain(minted.ticket);
    expect(parseWorkshopRoomAuth(JSON.stringify({ auth: minted.ticket }))).toBe(minted.ticket);
    expect(workshopRoomRoute(new URL(minted.room_url.replace("wss:", "https:")))).toEqual({
      fellowId: fellowA,
      problemId,
    });
    expect(workshopRoomName(fellowA, problemId)).toBe(
      `private-workshop-v1:${fellowA}:${problemId}`,
    );

    // 2. Workshop room DO accepts WS in pending state, authenticates first frame, rejects replay, pushes live cursor, and evicts on revoke.
    const sockets: MockSocket[] = [];
    const usedNonces = new Set<string>();
    const currentTime = now;
    let alarm: number | null = null;
    const port: HeraldRoomPort = {
      owns: () => false,
      ownsWorkshop: (f, p) => f === fellowA && p === problemId,
      sockets: () => sockets,
      accept: (s) => sockets.push(s as MockSocket),
      lastPing: () => currentTime,
      alarmAt: async () => alarm,
      setAlarm: async (t) => {
        alarm = t;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
      generation: async () => 0,
      rememberGeneration: async () => {},
      consumeTicketNonce: async (nonce) => {
        if (usedNonces.has(nonce)) return false;
        usedNonces.add(nonce);
        return true;
      },
      pair: () => ({ client: "c", server: new MockSocket() }),
      upgraded: () => new Response("upgraded", { status: 200 }),
    };

    const controller = new HeraldRoomController({
      db,
      port,
      now: () => currentTime,
      validToken: () => false,
      authenticate: async () => undefined,
      verifyWorkshopTicket: (ticket, t) =>
        verifyWorkshopRoomTicket(ticket, { signingKey: TEST_ED25519_KEY }, t),
      workshopHead: (s, f, p) => liveWorkshopRoomHead(db, s, f, p),
      refuse: roomRefusal,
    });

    // Reject cookie on WS upgrade (S-6) AND reject ticket in query string!
    expect(
      (
        await controller.fetch(
          new Request(
            `https://a.asimposium.org/v1/workshop-room?fellow=${fellowA}&problem=${problemId}`,
            { headers: { upgrade: "websocket", cookie: "asimp.session=forbidden" } },
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await controller.fetch(
          new Request(
            `https://a.asimposium.org/v1/workshop-room?fellow=${fellowA}&problem=${problemId}&ticket=${minted.ticket}`,
            { headers: { upgrade: "websocket" } },
          ),
        )
      ).status,
    ).toBe(400);

    // Connect cleanly, zero frames sent before auth!
    const wsRes = await controller.fetch(
      new Request(
        `https://a.asimposium.org/v1/workshop-room?fellow=${fellowA}&problem=${problemId}`,
        { headers: { upgrade: "websocket", "sec-websocket-protocol": HERALD_ROOM_PROTOCOL } },
      ),
    );
    expect(wsRes.status).toBe(200);
    const sock1 = sockets[0]!;
    expect(sock1.sent.length).toBe(0);

    // Present freshly minted ticket (Note: router used real Date.now(); mint a clock-aligned ticket for deterministic time tests!)
    const deterministicTicket = await mintWorkshopRoomTicket(
      { sponsorId: sponsorA, fellowId: fellowA, problemId },
      TEST_ED25519_KEY,
      currentTime,
    );
    expect(deterministicTicket).not.toBeNull();
    await controller.webSocketMessage(sock1, JSON.stringify({ auth: deterministicTicket!.ticket }));
    expect(sock1.closed).toBeUndefined();
    expect(sock1.sent.length).toBe(1);
    const notice1 = JSON.parse(sock1.sent[0]!);
    expect(notice1.control).toBe("workshop-update");
    expect(notice1.workshop_cursor).toBe(1);
    // Rule A2: zero private draft title or body text ever crosses the room wire.
    expect(sock1.sent[0]).not.toContain("PRIVATE_DRAFT_CANARY");

    // Should-fail: replaying the EXACT SAME ticket on a second socket MUST close 1008 with zero bytes!
    await controller.fetch(
      new Request(
        `https://a.asimposium.org/v1/workshop-room?fellow=${fellowA}&problem=${problemId}`,
        { headers: { upgrade: "websocket" } },
      ),
    );
    const replaySock = sockets[1]!;
    await controller.webSocketMessage(
      replaySock,
      JSON.stringify({ auth: deterministicTicket!.ticket }),
    );
    expect(replaySock.closed?.code).toBe(1008);
    expect(replaySock.sent.length).toBe(0);

    // Should-fail: expired ticket (> 60s) closes 1008!
    const expiredTicket = await mintWorkshopRoomTicket(
      { sponsorId: sponsorA, fellowId: fellowA, problemId },
      TEST_ED25519_KEY,
      currentTime - 120_000,
    );
    await controller.fetch(
      new Request(
        `https://a.asimposium.org/v1/workshop-room?fellow=${fellowA}&problem=${problemId}`,
        { headers: { upgrade: "websocket" } },
      ),
    );
    const expiredSock = sockets[2]!;
    await controller.webSocketMessage(expiredSock, JSON.stringify({ auth: expiredTicket!.ticket }));
    expect(expiredSock.closed?.code).toBe(1008);
    expect(expiredSock.sent.length).toBe(0);

    // Should-fail: Sponsor B forged/cross-sponsor ticket closes 1008!
    const crossTicket = await mintWorkshopRoomTicket(
      { sponsorId: sponsorB, fellowId: fellowA, problemId },
      TEST_ED25519_KEY,
      currentTime,
    );
    await controller.fetch(
      new Request(
        `https://a.asimposium.org/v1/workshop-room?fellow=${fellowA}&problem=${problemId}`,
        { headers: { upgrade: "websocket" } },
      ),
    );
    const crossSock = sockets[3]!;
    await controller.webSocketMessage(crossSock, JSON.stringify({ auth: crossTicket!.ticket }));
    expect(crossSock.closed?.code).toBe(1008);
    expect(crossSock.sent.length).toBe(0);

    // Positive: Fellow pushes new workshop object -> internal nudge wakes sock1 immediately!
    sqlite.run(
      `INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, cas_hash, relates_to_json, force_note, created_at)
       VALUES ('W-SECRET-2', ?, ?, ?, 2, 'note', 'PRIVATE_DRAFT_CANARY_2', 'BODY_2', NULL, '[]', 0, ?)`,
      [problemId, fellowA, sessionId, ts],
    );
    const nudgeRes = await controller.fetch(
      new Request(`https://herald.internal/_herald/workshop/${fellowA}/${problemId}/nudge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: 2 }),
      }),
    );
    expect(nudgeRes.status).toBe(204);
    expect(sock1.sent.length).toBe(2);
    expect(JSON.parse(sock1.sent[1]!).workshop_cursor).toBe(2);
    expect(sock1.sent[1]).not.toContain("PRIVATE_DRAFT_CANARY");

    // Revoking the Fellow via canonical causal lifecycle event immediately evicts sock1 on alarm()!
    const revokeEventId = "LEV-01KFAGREVKE000000000000001";
    const revokeAt = currentTime + 1000;
    sqlite.run(
      "UPDATE sponsors SET lifecycle_lease_token = ?, lifecycle_lease_expires_at = ? WHERE sponsor_id = ?",
      [revokeEventId, revokeAt + 60_000, sponsorA],
    );
    sqlite.run(
      `INSERT INTO fellow_lifecycle_events
         (event_id, sponsor_id, sponsor_seq, action, fellow_id, credential_id, from_status, to_status, effective_at, review_from, request_id, created_at)
       VALUES (?, ?, 1, 'fellow-status-changed', ?, NULL, 'active', 'revoked', ?, NULL, ?, ?)`,
      [revokeEventId, sponsorA, fellowA, revokeAt, "a".repeat(64), revokeAt],
    );
    sqlite.run(
      "UPDATE enrollment_fellows SET status = 'revoked', status_changed_at = ?, status_event_id = ? WHERE fellow_id = ?",
      [revokeAt, revokeEventId, fellowA],
    );
    sqlite.run(
      "UPDATE sponsors SET lifecycle_seq = 1, lifecycle_lease_token = NULL, lifecycle_lease_expires_at = NULL WHERE sponsor_id = ?",
      [sponsorA],
    );
    await controller.alarm();
    expect(sock1.closed?.code).toBe(1008);
    sqlite.close();
  });
});
