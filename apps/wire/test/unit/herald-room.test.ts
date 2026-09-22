import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  HERALD_ROOM_LIMITS as LIMITS,
  parseRoomAck,
  parseRoomSince,
  roomNotice,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import {
  HeraldRoomFanout,
  type RoomIdentity,
  type RoomSocket,
  roomAttachment,
} from "../../src/herald/room-core.ts";

class Socket implements RoomSocket {
  readyState = 1;
  attachment: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  failSend = false;
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(text: string) {
    if (this.failSend) throw new Error("PRIVATE-SOCKET-DETAIL");
    this.sent.push(text);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}
const NOW = 1_000_000;
const HASH = "a".repeat(64);
const ID: RoomIdentity = { fellowId: "F-1", sponsorId: "S-1" };
function fixture() {
  const sockets: Socket[] = [];
  const port = {
    sockets: () => sockets,
    accept: (s: RoomSocket) => {
      sockets.push(s as Socket);
    },
  };
  let room = new HeraldRoomFanout(port);
  function open(since = 0, seq = 1, identity = ID) {
    const socket = new Socket();
    const result = room.connect(
      socket,
      { problemId: "P-DEMO", since, tokenHash: HASH, identity },
      { seq },
      NOW,
    );
    return { socket, result };
  }
  return {
    sockets,
    open,
    get room() {
      return room;
    },
    hibernate() {
      room = new HeraldRoomFanout(port);
    },
  };
}
function acknowledge(
  f: ReturnType<typeof fixture>,
  socket: Socket,
  seq: number,
  head = seq,
  now = NOW + 1000,
) {
  const ack = f.room.beginAck(socket, JSON.stringify({ ack: seq }), now);
  assert.equal(ack, seq);
  f.room.completeAck(socket, ack!, ID, { seq: head }, now);
}

describe("W7 hibernatable public room state machine", () => {
  test("connection emits a bounded pointer, not event bodies or private attachment fields", () => {
    const f = fixture();
    const { socket, result } = f.open(2, 9);
    assert.equal(result, "accepted");
    const frame = JSON.parse(socket.sent[0]!);
    assert.equal(frame.control, "resync");
    assert.equal(frame.since, 2);
    assert.equal(frame.through, 9);
    assert.equal(frame.events, "/p/P-DEMO/events.ndjson?since=2&limit=200&through=9");
    assert.equal(frame.poll, "/p/P-DEMO/events.ndjson?since=2&limit=200&wait=25");
    assert.equal(frame.invalidate_cached_objects, true);
    for (const canary of [HASH, "F-1", "S-1", "tokenHash", "payload", "workshop"])
      assert.ok(!socket.sent[0]!.includes(canary));
    assert.ok(Buffer.byteLength(socket.sent[0]!) <= LIMITS.frameBytes);
    assert.equal(roomAttachment(socket)?.acknowledged, 2);
  });
  test("1000 committed wake-ups remain one outstanding frame, then coalesce after ACK", () => {
    const f = fixture();
    const { socket } = f.open(0, 1);
    for (let seq = 2; seq <= 1001; seq++) f.room.refresh(socket, ID, { seq }, NOW + 500);
    assert.equal(socket.sent.length, 1);
    assert.equal(roomAttachment(socket)?.acknowledged, 0);
    acknowledge(f, socket, 1, 1001);
    assert.equal(socket.sent.length, 2);
    assert.equal(JSON.parse(socket.sent[1]!).since, 1);
    assert.equal(JSON.parse(socket.sent[1]!).through, 1001);
    assert.equal(roomAttachment(socket)?.acknowledged, 1);
  });
  test("ACK cannot acknowledge a cursor that was never announced", () => {
    const f = fixture();
    const { socket } = f.open(0, 3);
    assert.equal(f.room.beginAck(socket, '{"ack":4}', NOW + 1000), undefined);
    assert.equal(socket.closed?.code, 1008);
    assert.equal(roomAttachment(socket)?.acknowledged, 0);
  });
  test("partial or rewound ACKs cannot silently move the recovery cursor", () => {
    for (const ack of [0, 1, 2]) {
      const f = fixture();
      const { socket } = f.open(1, 3);
      assert.equal(f.room.beginAck(socket, JSON.stringify({ ack }), NOW + 1000), undefined);
      assert.equal(roomAttachment(socket)?.acknowledged, 1);
    }
  });
  test("duplicate completed ACK does no binding work and sends no frame", () => {
    const f = fixture();
    const { socket } = f.open();
    acknowledge(f, socket, 1);
    assert.equal(f.room.beginAck(socket, '{"ack":1}', NOW + 1001), undefined);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.closed, undefined);
  });
  test("hibernation reconstructs ACK/backpressure state entirely from attachments", () => {
    const f = fixture();
    const { socket } = f.open(0, 1);
    f.room.refresh(socket, ID, { seq: 2 }, NOW + 100);
    f.hibernate();
    acknowledge(f, socket, 1, 2);
    assert.equal(socket.sent.length, 2);
    assert.equal(roomAttachment(socket)?.announced, 2);
    f.hibernate();
    acknowledge(f, socket, 2, 2, NOW + 2000);
    assert.equal(roomAttachment(socket)?.acknowledged, 2);
    assert.equal(roomAttachment(socket)?.pending, false);
  });
  test("same-cursor content invalidation remains deliverable after a completed ACK", () => {
    const f = fixture();
    const { socket } = f.open(1, 1);
    acknowledge(f, socket, 1);
    f.room.refresh(socket, ID, { seq: 1 }, NOW + 2000);
    assert.equal(socket.sent.length, 2);
    assert.equal(JSON.parse(socket.sent[1]!).invalidate_cached_objects, true);
  });
  test("privacy withdrawal closes a pending connection without another frame", () => {
    const f = fixture();
    const { socket } = f.open();
    f.room.refresh(socket, ID, null, NOW + 1);
    assert.equal(socket.closed?.code, 1008);
    assert.equal(socket.sent.length, 1);
  });
  for (const [name, auth] of [
    ["revoked", undefined],
    ["transferred sponsor", { fellowId: "F-1", sponsorId: "S-OTHER" }],
    ["other fellow", { fellowId: "F-OTHER", sponsorId: "S-1" }],
    ["wrong problem grant", { ...ID, problemBinding: "P-OTHER" }],
  ] as const) {
    test(`${name} cannot receive a cursor on refresh or finish a pending ACK`, () => {
      const f = fixture();
      const { socket } = f.open();
      const ack = f.room.beginAck(socket, '{"ack":1}', NOW + 1000);
      f.room.completeAck(socket, ack!, auth, { seq: 2 }, NOW + 1000);
      assert.equal(socket.closed?.code, 1008);
      assert.equal(socket.sent.length, 1);
      assert.equal(roomAttachment(socket)?.acknowledged, 0);
    });
  }
  for (const seq of [-1, NaN, 0.5, 9007199254740992, 0]) {
    test(`invalid or regressed head ${String(seq)} cannot confirm an ACK`, () => {
      const f = fixture();
      const { socket } = f.open(0, 1);
      f.room.completeAck(socket, 1, ID, { seq }, NOW + 1000);
      assert.equal(socket.closed?.code, 1011);
      assert.equal(roomAttachment(socket)?.acknowledged, 0);
    });
  }
  test("unacknowledged client is disconnected at the exact bounded deadline", () => {
    const f = fixture();
    const { socket } = f.open();
    f.room.revalidate(socket, ID, { seq: 1 }, NOW + LIMITS.acknowledgementMs, NOW + 59_000);
    assert.equal(socket.closed?.code, 1013);
    assert.equal(socket.sent.length, 1);
  });
  test("active pings do not extend a session's credential reauthentication lifetime", () => {
    const f = fixture();
    const { socket } = f.open();
    acknowledge(f, socket, 1);
    f.room.revalidate(socket, ID, { seq: 1 }, NOW + LIMITS.lifetimeMs, NOW + LIMITS.lifetimeMs);
    assert.equal(socket.closed?.code, 1008);
  });
  test("idle acknowledged clients must send the documented hibernating heartbeat", () => {
    const f = fixture();
    const { socket } = f.open();
    acknowledge(f, socket, 1);
    f.room.revalidate(socket, ID, { seq: 1 }, NOW + 92_000, null);
    assert.equal(socket.closed?.code, 1001);
  });
  test("hibernating ping timestamp keeps a healthy acknowledged client alive", () => {
    const f = fixture();
    const { socket } = f.open();
    acknowledge(f, socket, 1);
    f.room.revalidate(socket, ID, { seq: 1 }, NOW + 120_000, NOW + 119_000);
    assert.equal(socket.closed, undefined);
  });
  test("ACK flood is rejected before repeated D1 work can be scheduled", () => {
    const f = fixture();
    const { socket } = f.open();
    assert.equal(f.room.beginAck(socket, '{"ack":1}', NOW + 1000), 1);
    assert.equal(f.room.beginAck(socket, '{"ack":1}', NOW + 1001), undefined);
    assert.equal(socket.closed?.code, 1013);
  });
  test("late duplicate completion cannot overwrite a newer outstanding announcement", () => {
    const f = fixture();
    const { socket } = f.open();
    acknowledge(f, socket, 1, 2);
    f.room.completeAck(socket, 1, ID, { seq: 3 }, NOW + 1001);
    assert.equal(roomAttachment(socket)?.announced, 2);
    assert.equal(roomAttachment(socket)?.acknowledged, 1);
    assert.equal(socket.sent.length, 2);
  });
  test("Fellow and sponsor admission limits survive hibernation", () => {
    const f = fixture();
    assert.equal(f.open().result, "accepted");
    assert.equal(f.open().result, "accepted");
    f.hibernate();
    assert.equal(f.open().result, "capacity");
    for (let i = 2; i < LIMITS.perSponsor; i++)
      assert.equal(f.open(0, 1, { ...ID, fellowId: `F-${i}` }).result, "accepted");
    assert.equal(f.open(0, 1, { ...ID, fellowId: "F-LAST" }).result, "capacity");
  });
  test("room capacity is bounded across distinct Fellows and sponsors", () => {
    const f = fixture();
    for (let i = 0; i < LIMITS.connections; i++)
      assert.equal(f.open(0, 1, { fellowId: `F-${i}`, sponsorId: `S-${i}` }).result, "accepted");
    assert.equal(f.open(0, 1, { fellowId: "F-LAST", sponsorId: "S-LAST" }).result, "capacity");
  });
  test("future cursors and foreign problem grants never accept a socket", () => {
    const f = fixture();
    assert.equal(f.open(2, 1).result, "invalid");
    assert.equal(f.open(0, 1, { ...ID, problemBinding: "P-OTHER" }).result, "invalid");
    assert.equal(f.sockets.length, 0);
  });
  test("oversized and binary input is closed without reflection", () => {
    for (const input of ["PRIVATE-CANARY".repeat(100), new ArrayBuffer(512)]) {
      const f = fixture();
      const { socket } = f.open();
      assert.equal(f.room.beginAck(socket, input, NOW + 1000), undefined);
      assert.ok(!socket.closed?.reason.includes("PRIVATE-"));
    }
  });
  test("corrupt and extended attachments fail closed instead of restoring authority", () => {
    for (const extra of [
      { token: "PRIVATE-CANARY" },
      { acknowledged: 99 },
      { tokenHash: "bad" },
      { pending: "true" },
    ]) {
      const f = fixture();
      const { socket } = f.open();
      socket.attachment = { ...(socket.attachment as object), ...extra };
      f.hibernate();
      f.room.refresh(socket, ID, { seq: 2 }, NOW + 1);
      assert.equal(socket.closed?.code, 1008);
      assert.equal(socket.sent.length, 1);
    }
  });
  test("a failed socket send cannot abort fanout to healthy peers", () => {
    const f = fixture();
    const first = f.open().socket;
    const second = f.open().socket;
    acknowledge(f, first, 1);
    acknowledge(f, second, 1);
    first.failSend = true;
    for (const socket of f.sockets) f.room.refresh(socket, ID, { seq: 2 }, NOW + 2000);
    assert.equal(first.closed?.code, 1011);
    assert.equal(second.sent.length, 2);
  });
});

describe("room wire grammar", () => {
  test("strict safe decimal since cursor and bounded ACK grammar", () => {
    for (const n of [0, 1, 9007199254740991]) {
      assert.equal(parseRoomSince(new URLSearchParams({ since: String(n) })), n);
      assert.equal(parseRoomAck(JSON.stringify({ ack: n })), n);
    }
    for (const q of [
      "since=01",
      "since=1&since=1",
      "token=secret",
      "since=-1",
      "since=9007199254740992",
      "wait=25",
      "since=1e1",
    ])
      assert.equal(parseRoomSince(new URLSearchParams(q)), undefined);
    for (const text of [
      '{"ack":1,"ack":1}',
      '{"ack":1,"extra":true}',
      '{"ack":1e1}',
      '{"ack":1.0}',
      '{"ack":"1"}',
      '{"ack":-1}',
    ])
      assert.equal(parseRoomAck(text), undefined);
  });
  test("maximum valid identifiers/cursors fit one bounded canonical frame", () => {
    const text = roomNotice("P".repeat(128), 9007199254740991, 9007199254740991);
    assert.ok(Buffer.byteLength(text) <= LIMITS.frameBytes);
    assert.throws(() => roomNotice("P/PRIVATE", 0, 1));
  });
});
