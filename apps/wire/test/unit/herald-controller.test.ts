import { Database } from "bun:sqlite";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { HERALD_ROOM_LIMITS as LIMITS } from "../../../../packages/contracts/src/herald-room-model.ts";
import type { HeraldDatabase } from "../../src/herald/outbox.ts";
import {
  HeraldRoomController,
  type HeraldRoomPort,
  publicRoomRoute,
  type RoomRefusal,
} from "../../src/herald/room-controller.ts";
import {
  type RoomIdentity,
  type RoomSocket,
  roomAttachment,
  workshopRoomAttachment,
} from "../../src/herald/room-core.ts";

/** A transport/storage unit port, not a fake Cloudflare integration result.
 * Head/visibility SQL executes on real SQLite. The authority seam supplies
 * lifecycle outcomes; production delegates to D1EnrollmentStore unchanged. */
class Socket implements RoomSocket {
  readyState = 1;
  saved: unknown = null;
  sent: string[] = [];
  closed: number | undefined;
  send(text: string) {
    this.sent.push(text);
  }
  close(code: number) {
    this.closed = code;
    this.readyState = 3;
  }
  serializeAttachment(value: unknown) {
    this.saved = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.saved);
  }
}
const NOW = 1_000_000;
const TOKEN = "test-fixture-token-not-a-real-credential";
function fixture(timeout = 4000) {
  const sql = new Database(":memory:");
  sql.exec(
    `CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    INSERT INTO problems VALUES ('P-DEMO',1,'active'),('P-PRIVATE',0,'private-draft')`,
  );
  const queries: string[] = [];
  const db: HeraldDatabase = {
    prepare(query) {
      queries.push(query);
      return {
        bind(...values) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  };
  const sockets: Socket[] = [];
  let now = NOW,
    alarm: number | null = null,
    generation = 0,
    lastPing: number | null = NOW;
  let identity: RoomIdentity | undefined = { fellowId: "F-1", sponsorId: "S-1" };
  let authority: (hash: string) => Promise<RoomIdentity | undefined> = async () => identity;
  const authReads: string[] = [];
  let pairCount = 0;
  const port: HeraldRoomPort = {
    owns: (problem) => problem === "P-DEMO" || problem === "P-PRIVATE" || problem === "P-MISSING",
    sockets: () => sockets,
    accept: (socket) => {
      sockets.push(socket as Socket);
    },
    lastPing: () => lastPing,
    alarmAt: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    generation: async () => generation,
    rememberGeneration: async (value) => {
      generation = Math.max(generation, value);
    },
    pair: () => {
      pairCount++;
      return { client: "fixture-client", server: new Socket() };
    },
    // Node deliberately cannot construct provider 101 responses. This seam
    // witnesses the upgrade branch without claiming a real WebSocket handshake.
    upgraded: (client, protocol) =>
      new Response(JSON.stringify({ client, protocol }), { status: 200 }),
  };
  const refused: RoomRefusal[] = [];
  const deps = {
    db,
    port,
    now: () => now,
    operationTimeoutMs: timeout,
    authenticate: async (hash: string) => {
      authReads.push(hash);
      return authority(hash);
    },
    validToken: (token: string) => token === TOKEN,
    refuse: (kind: RoomRefusal) => {
      refused.push(kind);
      return new Response(kind, {
        status:
          kind === "auth"
            ? 401
            : kind === "missing"
              ? 404
              : kind === "query"
                ? 400
                : kind === "capacity"
                  ? 429
                  : kind === "upgrade"
                    ? 426
                    : 503,
      });
    },
  };
  let controller = new HeraldRoomController(deps);
  const connect = (path = "/p/P-DEMO/room?since=0", init: RequestInit = {}) =>
    controller.fetch(
      new Request(`https://a.asimposium.org${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          upgrade: "websocket",
          "sec-websocket-protocol": "asimposium.room.v1",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    );
  const nudge = (value = 1) =>
    controller.fetch(
      new Request("https://herald.internal/_herald/P-DEMO/nudge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation: value }),
      }),
    );
  return {
    sql,
    port,
    sockets,
    queries,
    authReads,
    refused,
    connect,
    nudge,
    get controller() {
      return controller;
    },
    hibernate: () => {
      controller = new HeraldRoomController(deps);
    },
    setIdentity: (value: RoomIdentity | undefined) => {
      identity = value;
    },
    setAuthority: (fn: typeof authority) => {
      authority = fn;
    },
    setNow: (value: number) => {
      now = value;
    },
    setPing: (value: number | null) => {
      lastPing = value;
    },
    alarm: () => alarm,
    generation: () => generation,
    pairCount: () => pairCount,
  };
}

describe("Herald production controller ports", () => {
  test("exact routes cannot forward internal nudge paths or encoded traversal", () => {
    assert.equal(publicRoomRoute("/p/P-DEMO/room"), "P-DEMO");
    assert.equal(publicRoomRoute("/p/P%3ADEMO/room"), "P:DEMO");
    assert.equal(publicRoomRoute("/p/P:DEMO/room"), "P:DEMO");
    for (const path of [
      "/_herald/P-DEMO/nudge",
      "/p/P-DEMO/room/extra",
      "/p/P%2FPRIVATE/room",
      "/p/P--PRIVATE/room",
      "/p/P-DEMO/room.json",
      "/p/P%253ADEMO/room",
      "/p/P%2dDEMO/room",
    ])
      assert.equal(publicRoomRoute(path), undefined);
  });
  test("upgrade authenticates only the bearer and emits a canonical SQLite head pointer", async () => {
    const f = fixture();
    try {
      assert.equal((await f.connect()).status, 200);
      assert.equal(f.authReads.length, 1);
      assert.match(f.authReads[0]!, /^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(f.sockets[0]!.saved).includes(TOKEN));
      assert.equal(JSON.parse(f.sockets[0]!.sent[0]!).through, 1);
      assert.equal(f.alarm(), NOW + 60_000);
      assert.equal(f.queries.length, 1);
    } finally {
      f.sql.close();
    }
  });
  for (const [name, path, headers, expected] of [
    ["query bearer", "/p/P-DEMO/room?token=PRIVATE-CANARY", {}, 400],
    ["repeated cursor", "/p/P-DEMO/room?since=1&since=1", {}, 400],
    ["noncanonical cursor", "/p/P-DEMO/room?since=01", {}, 400],
    ["absent upgrade", "/p/P-DEMO/room", { upgrade: "" }, 426],
    [
      "cookie-only identity",
      "/p/P-DEMO/room",
      { authorization: "", cookie: "sponsor=PRIVATE-CANARY" },
      401,
    ],
    [
      "identity headers",
      "/p/P-DEMO/room",
      { authorization: "", "x-fellow-id": "F-1", "x-sponsor-id": "S-1" },
      401,
    ],
    [
      "credential subprotocol",
      "/p/P-DEMO/room",
      { "sec-websocket-protocol": "PRIVATE-CANARY" },
      400,
    ],
    ["oversized bearer", "/p/P-DEMO/room", { authorization: "Bearer " + "x".repeat(1000) }, 401],
  ] as const) {
    test(`${name} is refused before authority or head work`, async () => {
      const f = fixture();
      try {
        const result = await f.connect(path, { headers });
        assert.equal(result.status, expected);
        assert.ok(!(await result.text()).includes("PRIVATE-"));
        assert.equal(f.authReads.length, 0);
        assert.equal(f.queries.length, 0);
        assert.equal(f.pairCount(), 0);
      } finally {
        f.sql.close();
      }
    });
  }
  test("revoked and wrong-problem credentials never get a socket", async () => {
    const f = fixture();
    try {
      f.setIdentity(undefined);
      assert.equal((await f.connect()).status, 401);
      f.setIdentity({ fellowId: "F-1", sponsorId: "S-1", problemBinding: "P-OTHER" });
      assert.equal((await f.connect()).status, 404);
      assert.equal(f.queries.length, 0);
      assert.equal(f.pairCount(), 0);
    } finally {
      f.sql.close();
    }
  });
  test("private and missing problems are indistinguishable; future cursors cannot connect", async () => {
    const f = fixture();
    try {
      const hidden = await f.connect("/p/P-PRIVATE/room");
      const missing = await f.connect("/p/P-MISSING/room");
      assert.equal(hidden.status, 404);
      assert.equal(await hidden.text(), await missing.text());
      assert.equal((await f.connect("/p/P-DEMO/room?since=2")).status, 400);
      assert.equal(f.pairCount(), 0);
    } finally {
      f.sql.close();
    }
  });
  test("a commit between handshake head read and first ACK is recovered, not lost", async () => {
    const f = fixture();
    try {
      await f.connect();
      f.sql.exec("UPDATE problems SET public_seq=2 WHERE id='P-DEMO'");
      f.setNow(NOW + 1000);
      await f.controller.webSocketMessage(f.sockets[0]!, '{"ack":1}');
      assert.equal(f.sockets[0]!.sent.length, 2);
      assert.equal(JSON.parse(f.sockets[0]!.sent[1]!).through, 2);
    } finally {
      f.sql.close();
    }
  });
  test("committed wake uses current D1 head and rechecks attachments after hibernation", async () => {
    const f = fixture();
    try {
      await f.connect();
      f.setNow(NOW + 1000);
      await f.controller.webSocketMessage(f.sockets[0]!, '{"ack":1}');
      f.hibernate();
      f.sql.exec("UPDATE problems SET public_seq=9 WHERE id='P-DEMO'");
      assert.equal((await f.nudge(700)).status, 204);
      assert.equal(f.generation(), 700);
      assert.equal(JSON.parse(f.sockets[0]!.sent[1]!).through, 9);
      assert.equal(roomAttachment(f.sockets[0]!)?.acknowledged, 1);
      const reads = f.authReads.length;
      assert.equal((await f.nudge(699)).status, 204);
      assert.equal(f.authReads.length, reads);
    } finally {
      f.sql.close();
    }
  });
  test("coalesced nudges do not buffer another application frame before ACK", async () => {
    const f = fixture();
    try {
      await f.connect();
      f.sql.exec("UPDATE problems SET public_seq=3 WHERE id='P-DEMO'");
      await f.nudge(1);
      await f.nudge(2);
      assert.equal(f.sockets[0]!.sent.length, 1);
      f.setNow(NOW + 1000);
      await f.controller.webSocketMessage(f.sockets[0]!, '{"ack":1}');
      assert.equal(f.sockets[0]!.sent.length, 2);
      assert.equal(JSON.parse(f.sockets[0]!.sent[1]!).through, 3);
    } finally {
      f.sql.close();
    }
  });
  test("privacy withdrawal wins even when delivery generation is much larger than the public cursor", async () => {
    const f = fixture();
    try {
      await f.connect();
      f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
      assert.equal((await f.nudge(900)).status, 204);
      assert.equal(f.sockets[0]!.closed, 1008);
      assert.equal(f.sockets[0]!.sent.length, 1);
      assert.equal(f.alarm(), null);
    } finally {
      f.sql.close();
    }
  });
  for (const refresh of ["nudge", "ack", "alarm"] as const) {
    test(`moderation closes an existing room on ${refresh} and restoration permits a new connection`, async () => {
      const f = fixture();
      try {
        await f.connect();
        const socket = f.sockets[0];
        assert.ok(socket);
        f.setNow(NOW + 1000);
        if (refresh === "alarm") {
          await f.controller.webSocketMessage(socket, '{"ack":1}');
          f.hibernate();
          f.setNow(NOW + 60_000);
        }
        // Moderation can change visibility without moving the public cursor.
        f.sql.exec("INSERT INTO content_controls VALUES ('P-DEMO', 'problem', 'hidden', 1)");
        if (refresh === "nudge") assert.equal((await f.nudge()).status, 204);
        else if (refresh === "ack") await f.controller.webSocketMessage(socket, '{"ack":1}');
        else await f.controller.alarm();
        assert.equal(socket.closed, 1008, "hidden problems cannot retain room connections");
        assert.equal(socket.sent.length, 1, "no cursor is announced after withdrawal");
        // An ACK closes the socket synchronously; its already-scheduled alarm
        // retires when it next observes the empty room.
        if (refresh === "ack") {
          f.setNow(NOW + 60_000);
          await f.controller.alarm();
        }
        assert.equal(f.alarm(), null);
        const pairs = f.pairCount();
        const hidden = await f.connect();
        const missing = await f.connect("/p/P-MISSING/room");
        assert.equal(hidden.status, 404);
        assert.equal(await hidden.text(), await missing.text());
        assert.equal(f.pairCount(), pairs, "a hidden problem does not construct a socket");
        f.sql.exec("INSERT INTO content_controls VALUES ('P-DEMO', 'problem', 'visible', 2)");
        assert.equal((await f.connect()).status, 200);
        const notice = f.sockets.at(-1)?.sent[0];
        assert.ok(notice);
        assert.equal(JSON.parse(notice).through, 1, "restore uses the unchanged canonical head");
      } finally {
        f.sql.close();
      }
    });
    test(`dormancy evicts on ${refresh}, refuses reconnects, and material reactivation reopens the room`, async () => {
      const f = fixture();
      try {
        await f.connect();
        const socket = f.sockets[0];
        assert.ok(socket);
        f.setNow(NOW + 1000);
        if (refresh === "alarm") {
          await f.controller.webSocketMessage(socket, '{"ack":1}');
          f.setNow(NOW + 60_000);
        }
        f.sql.exec("UPDATE problems SET status='dormant', public_seq=2 WHERE id='P-DEMO'");
        if (refresh === "nudge") assert.equal((await f.nudge()).status, 204);
        else if (refresh === "ack") await f.controller.webSocketMessage(socket, '{"ack":1}');
        else await f.controller.alarm();
        assert.equal(socket.closed, 1008, "dormancy closes the existing room connection");
        const pairs = f.pairCount();
        assert.equal((await f.connect()).status, 404);
        assert.equal(f.pairCount(), pairs, "a dormant problem never constructs a new socket");
        f.sql.exec("UPDATE problems SET status='active', public_seq=3 WHERE id='P-DEMO'");
        assert.equal((await f.connect()).status, 200);
        const notice = f.sockets.at(-1)?.sent[0];
        assert.ok(notice);
        assert.equal(JSON.parse(notice).through, 3);
      } finally {
        f.sql.close();
      }
    });
  }
  test("durable alarm revalidates revocation and has no idle event-broadcast timer", async () => {
    const f = fixture();
    try {
      await f.connect();
      f.setNow(NOW + 1000);
      await f.controller.webSocketMessage(f.sockets[0]!, '{"ack":1}');
      f.hibernate();
      f.setIdentity(undefined);
      f.setNow(NOW + 60_000);
      await f.controller.alarm();
      assert.equal(f.sockets[0]!.closed, 1008);
      assert.equal(f.alarm(), null);
      assert.equal(f.sockets[0]!.sent.length, 1);
    } finally {
      f.sql.close();
    }
  });
  test("alarm scheduling is not postponed indefinitely by new connections", async () => {
    const f = fixture();
    try {
      await f.connect();
      f.setNow(NOW + 30_000);
      await f.connect();
      assert.equal(f.alarm(), NOW + 60_000);
    } finally {
      f.sql.close();
    }
  });
  test("empty room nudges and alarms never read D1 or construct a socket", async () => {
    const f = fixture();
    try {
      assert.equal((await f.nudge()).status, 204);
      await f.controller.alarm();
      assert.equal(f.queries.length, 0);
      assert.equal(f.authReads.length, 0);
      assert.equal(f.alarm(), null);
    } finally {
      f.sql.close();
    }
  });
  test("malformed private delivery bodies cannot become cursor authority", async () => {
    const f = fixture();
    try {
      for (const body of [
        '{"generation":1,"generation":2}',
        '{"generation":1,"through":99}',
        '{"generation":1e1}',
        "x".repeat(200),
      ]) {
        const result = await f.controller.fetch(
          new Request("https://herald.internal/_herald/P-DEMO/nudge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
        assert.equal(result.status, 400);
      }
      assert.equal(f.generation(), 0);
      assert.equal(f.queries.length, 0);
    } finally {
      f.sql.close();
    }
  });
  test("wrong room namespace refuses before parsing credentials or reading the ledger", async () => {
    const f = fixture();
    try {
      f.port.owns = () => false;
      assert.equal((await f.connect()).status, 404);
      assert.equal((await f.nudge()).status, 404);
      assert.equal(f.authReads.length, 0);
      assert.equal(f.queries.length, 0);
    } finally {
      f.sql.close();
    }
  });
  test("an authority timeout cannot issue late head reads or accept a socket", async () => {
    const f = fixture(5);
    let finish: ((value: RoomIdentity) => void) | undefined;
    try {
      f.setAuthority(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      assert.equal((await f.connect()).status, 503);
      finish?.({ fellowId: "F-1", sponsorId: "S-1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(f.queries.length, 0);
      assert.equal(f.pairCount(), 0);
    } finally {
      f.sql.close();
    }
  });
  test("cancelled upgrade does not touch the authority or database", async () => {
    const f = fixture();
    try {
      const c = new AbortController();
      c.abort("PRIVATE-ABORT-REASON");
      const result = await f.connect("/p/P-DEMO/room", { signal: c.signal });
      assert.equal(result.status, 503);
      assert.equal(f.authReads.length, 0);
      assert.equal(f.queries.length, 0);
    } finally {
      f.sql.close();
    }
  });

  test("alarm recovers a lost wake after hibernation without fabricating activity", async () => {
    const f = fixture();
    try {
      assert.equal((await f.connect()).status, 200);
      const socket = f.sockets[0]!;
      f.setNow(NOW + 1000);
      await f.controller.webSocketMessage(socket, '{"ack":1}');
      f.sql.exec("UPDATE problems SET public_seq=3 WHERE id='P-DEMO'");
      f.hibernate();
      f.setNow(NOW + LIMITS.revalidateMs);
      f.setPing(NOW + LIMITS.revalidateMs - 1000);
      await f.controller.alarm();
      assert.equal(socket.closed, undefined);
      assert.deepEqual(
        socket.sent.map((frame) => JSON.parse(frame).through),
        [1, 3],
      );
      assert.equal(roomAttachment(socket)?.acknowledged, 1);
      assert.equal(roomAttachment(socket)?.pending, true);
      await f.controller.webSocketMessage(socket, '{"ack":3}');
      f.setNow(NOW + 2 * LIMITS.revalidateMs);
      f.setPing(NOW + 2 * LIMITS.revalidateMs - 1000);
      await f.controller.alarm();
      assert.equal(socket.sent.length, 2, "an unchanged authorized head emits no activity");
      assert.equal(roomAttachment(socket)?.acknowledged, 3);
    } finally {
      f.sql.close();
    }
  });

  test("missed wakes coalesce behind one frame and still require authorization", async () => {
    const f = fixture();
    try {
      await f.connect();
      const socket = f.sockets[0]!;
      for (const seq of [2, 3]) {
        f.sql.prepare("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(seq);
        f.setNow(NOW + seq * 500);
        await f.controller.alarm();
      }
      assert.equal(socket.sent.length, 1);
      assert.equal(roomAttachment(socket)?.dirty, true);
      f.setNow(NOW + 2000);
      await f.controller.webSocketMessage(socket, '{"ack":1}');
      assert.deepEqual(
        socket.sent.map((frame) => JSON.parse(frame).through),
        [1, 3],
      );
      f.setIdentity(undefined);
      f.sql.exec("UPDATE problems SET public_seq=4 WHERE id='P-DEMO'");
      await f.controller.alarm();
      assert.equal(socket.closed, 1008);
      assert.equal(socket.sent.length, 2, "revocation never reveals the later cursor");
    } finally {
      f.sql.close();
    }
  });

  for (const outcome of ["newer-head", "revoked", "expired"] as const) {
    test(`a delayed private workshop head cannot overwrite ${outcome} socket state`, async () => {
      const f = fixture();
      let releaseRead!: (head: { cursor: number } | null) => void;
      const delayedHead = new Promise<{ cursor: number } | null>((resolve) => {
        releaseRead = resolve;
      });
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      let now = NOW;
      let headReads = 0;
      const socket = new Socket();
      socket.serializeAttachment({
        v: 3,
        mode: "workshop",
        problemId: "P-DEMO",
        fellowId: "F-1",
        sponsorId: "S-1",
        authenticated: true,
        cursor: 1,
        connectedAt: NOW,
        authDeadlineAt: NOW + LIMITS.authDeadlineMs,
        expiresAt: NOW + LIMITS.lifetimeMs,
        lastMessageAt: NOW,
      });
      f.sockets.push(socket);
      const controller = new HeraldRoomController({
        db: {
          prepare() {
            throw new Error("private room must use its scoped authority reader");
          },
        },
        port: {
          ...f.port,
          ownsWorkshop: (fellow, problem) => fellow === "F-1" && problem === "P-DEMO",
        },
        now: () => now,
        validToken: () => false,
        authenticate: async () => undefined,
        workshopHead: async () => {
          headReads++;
          if (headReads === 1) {
            readStarted();
            return delayedHead;
          }
          return outcome === "revoked" ? null : { cursor: 3 };
        },
        refuse: (kind) => new Response(kind, { status: 503 }),
      });
      const wake = () =>
        controller.fetch(
          new Request("https://herald.internal/_herald/workshop/F-1/P-DEMO/nudge", {
            method: "POST",
          }),
        );
      const olderWake = wake();
      try {
        await started;
        if (outcome === "expired") now = NOW + LIMITS.lifetimeMs;
        else assert.equal((await wake()).status, 204);
        releaseRead({ cursor: 2 });
        assert.equal((await olderWake).status, 204);
        if (outcome === "newer-head") {
          assert.deepEqual(
            socket.sent.map((frame) => JSON.parse(frame).workshop_cursor),
            [3],
          );
          assert.equal(workshopRoomAttachment(socket)?.cursor, 3);
          assert.equal(socket.closed, undefined);
        } else {
          assert.deepEqual(socket.sent, []);
          assert.equal(socket.closed, 1008);
        }
      } finally {
        releaseRead(null);
        await olderWake;
        f.sql.close();
      }
    });
  }
});
