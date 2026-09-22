import {
  HERALD_ROOM_LIMITS as LIMITS,
  parseRoomAck,
  roomCursor,
  roomId,
  roomNotice,
  roomProblem,
} from "../../../../packages/contracts/src/herald-room-model.ts";

/** Provider-neutral hibernation port. This is a socket unit-test seam, not a D1 mock. */
export interface RoomSocket {
  readonly readyState: number;
  send(text: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface RoomPort {
  sockets(): RoomSocket[];
  accept(socket: RoomSocket, tags: string[]): void;
}
export interface RoomIdentity {
  readonly fellowId: string;
  readonly sponsorId: string;
  readonly problemBinding?: string;
}
export interface RoomHead {
  readonly seq: number;
}

/** Private runtime state only. No raw bearer, workshop bytes, event bodies or profile names.
 * The verifier hash is required to re-run the existing lifecycle authority after hibernation. */
export interface RoomAttachment {
  v: 1;
  problemId: string;
  fellowId: string;
  sponsorId: string;
  tokenHash: string;
  acknowledged: number;
  announced: number;
  pending: boolean;
  dirty: boolean;
  connectedAt: number;
  expiresAt: number;
  sentAt: number;
  lastMessageAt: number;
}
const KEYS = [
  "v",
  "problemId",
  "fellowId",
  "sponsorId",
  "tokenHash",
  "acknowledged",
  "announced",
  "pending",
  "dirty",
  "connectedAt",
  "expiresAt",
  "sentAt",
  "lastMessageAt",
];

export function roomAttachment(socket: RoomSocket): RoomAttachment | undefined {
  let raw: unknown;
  try {
    raw = socket.deserializeAttachment();
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as RoomAttachment;
  if (
    Object.keys(raw).length !== KEYS.length ||
    Object.keys(raw).some((key) => !KEYS.includes(key)) ||
    a.v !== 1 ||
    !roomProblem(a.problemId) ||
    !roomId(a.fellowId) ||
    !roomId(a.sponsorId) ||
    typeof a.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(a.tokenHash) ||
    !roomCursor(a.acknowledged) ||
    !roomCursor(a.announced) ||
    a.acknowledged > a.announced ||
    typeof a.pending !== "boolean" ||
    typeof a.dirty !== "boolean" ||
    !roomCursor(a.connectedAt) ||
    !roomCursor(a.expiresAt) ||
    !roomCursor(a.sentAt) ||
    !roomCursor(a.lastMessageAt) ||
    a.expiresAt !== a.connectedAt + LIMITS.lifetimeMs ||
    a.sentAt < a.connectedAt ||
    a.sentAt >= a.expiresAt ||
    (!a.pending && a.acknowledged !== a.announced)
  )
    return undefined;
  return { ...a };
}
export function closeRoomSocket(socket: RoomSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    /* A dead socket cannot poison its peers. */
  }
}
export function roomIdentityMatches(
  a: RoomAttachment,
  identity: RoomIdentity | undefined,
): boolean {
  return (
    identity !== undefined &&
    identity.fellowId === a.fellowId &&
    identity.sponsorId === a.sponsorId &&
    (identity.problemBinding === undefined || identity.problemBinding === a.problemId)
  );
}

/** One outstanding frame per client is the backpressure bound. Further commits
 * set one dirty bit, never enqueue another frame. All methods are synchronous:
 * the runtime obtains fresh authority/head first and re-reads attachments here
 * after awaited I/O, so an intervening ACK cannot be overwritten by stale state. */
export class HeraldRoomFanout {
  private readonly port: RoomPort;
  constructor(port: RoomPort) {
    this.port = port;
  }

  connect(
    socket: RoomSocket,
    input: {
      problemId: string;
      since: number;
      tokenHash: string;
      identity: RoomIdentity;
    },
    head: RoomHead,
    now: number,
  ): "accepted" | "capacity" | "invalid" {
    const { identity, problemId, since, tokenHash } = input;
    if (
      !roomProblem(problemId) ||
      !roomCursor(since) ||
      !roomCursor(head.seq) ||
      since > head.seq ||
      !roomCursor(now) ||
      !roomCursor(now + LIMITS.lifetimeMs) ||
      !roomId(identity.fellowId) ||
      !roomId(identity.sponsorId) ||
      !/^[a-f0-9]{64}$/.test(tokenHash) ||
      (identity.problemBinding !== undefined && identity.problemBinding !== problemId)
    )
      return "invalid";
    // Include closing sockets in the room cap until the runtime releases them.
    const sockets = this.port.sockets();
    const attachments = sockets.map(roomAttachment).filter((a) => a !== undefined);
    if (
      sockets.length >= LIMITS.connections ||
      attachments.filter((a) => a.fellowId === identity.fellowId).length >= LIMITS.perFellow ||
      attachments.filter((a) => a.sponsorId === identity.sponsorId).length >= LIMITS.perSponsor
    )
      return "capacity";
    const a: RoomAttachment = {
      v: 1,
      problemId,
      fellowId: identity.fellowId,
      sponsorId: identity.sponsorId,
      tokenHash,
      acknowledged: since,
      announced: since,
      pending: false,
      dirty: false,
      connectedAt: now,
      expiresAt: now + LIMITS.lifetimeMs,
      sentAt: now,
      lastMessageAt: 0,
    };
    this.port.accept(socket, [`fellow:${identity.fellowId}`, `sponsor:${identity.sponsorId}`]);
    this.send(socket, a, head.seq, now);
    return "accepted";
  }

  /** Reserve an ACK's read budget before the runtime starts any D1 work. */
  beginAck(socket: RoomSocket, message: string | ArrayBuffer, now: number): number | undefined {
    const ack = parseRoomAck(message);
    const a = this.live(socket, now);
    if (!a) return undefined;
    if (ack === undefined || ack !== a.announced) {
      closeRoomSocket(
        socket,
        typeof message === "string" ? 1008 : 1003,
        "Invalid room acknowledgement",
      );
      return undefined;
    }
    if (!a.pending) return undefined; // Duplicate ACK, no read or write work.
    if (a.lastMessageAt !== 0 && now - a.lastMessageAt < LIMITS.acknowledgementIntervalMs) {
      closeRoomSocket(socket, 1013, "Use event-tail polling before reconnecting");
      return undefined;
    }
    a.lastMessageAt = now;
    socket.serializeAttachment(a);
    return ack;
  }

  completeAck(
    socket: RoomSocket,
    ack: number,
    identity: RoomIdentity | undefined,
    head: RoomHead | null,
    now: number,
  ): void {
    const a = this.authorized(socket, identity, head, now);
    if (!a || !head || !a.pending || ack !== a.announced) return;
    const refresh = a.dirty;
    a.acknowledged = ack;
    a.pending = false;
    a.dirty = false;
    socket.serializeAttachment(a);
    if (head.seq > ack || refresh) this.send(socket, a, Math.max(head.seq, ack), now);
  }

  refresh(
    socket: RoomSocket,
    identity: RoomIdentity | undefined,
    head: RoomHead | null,
    now: number,
  ): void {
    const a = this.authorized(socket, identity, head, now);
    if (!a || !head) return;
    if (a.pending) {
      a.dirty = true;
      socket.serializeAttachment(a);
    } else {
      this.send(socket, a, Math.max(head.seq, a.acknowledged), now);
    }
  }

  /** Periodic bounded revocation/expiry sweep; not an event polling loop. */
  revalidate(
    socket: RoomSocket,
    identity: RoomIdentity | undefined,
    head: RoomHead | null,
    now: number,
    lastPingAt: number | null,
  ): void {
    const a = this.authorized(socket, identity, head, now);
    if (a && now - Math.max(a.connectedAt, a.lastMessageAt, lastPingAt ?? 0) > LIMITS.silenceMs)
      closeRoomSocket(socket, 1001, "Room heartbeat expired");
  }

  private live(socket: RoomSocket, now: number): RoomAttachment | undefined {
    if (socket.readyState !== 1) return undefined;
    const a = roomAttachment(socket);
    if (!a || !roomCursor(now) || now < a.connectedAt || now >= a.expiresAt) {
      closeRoomSocket(socket, 1008, "Room authorization expired");
      return undefined;
    }
    if (a.pending && now - a.sentAt >= LIMITS.acknowledgementMs) {
      closeRoomSocket(socket, 1013, "Read the event tail before reconnecting");
      return undefined;
    }
    return a;
  }
  private authorized(
    socket: RoomSocket,
    identity: RoomIdentity | undefined,
    head: RoomHead | null,
    now: number,
  ): RoomAttachment | undefined {
    const a = this.live(socket, now);
    if (!a) return undefined;
    if (!roomIdentityMatches(a, identity) || head === null) {
      closeRoomSocket(socket, 1008, "Room access ended");
      return undefined;
    }
    if (!roomCursor(head.seq) || head.seq < a.announced) {
      closeRoomSocket(socket, 1011, "Room unavailable; use event-tail recovery");
      return undefined;
    }
    return a;
  }
  private send(socket: RoomSocket, a: RoomAttachment, through: number, now: number): void {
    try {
      const frame = roomNotice(a.problemId, a.acknowledged, through);
      a.announced = through;
      a.pending = true;
      a.dirty = false;
      a.sentAt = now;
      // Retain pending state before send: a throw or wake can never cause an
      // untracked frame to be followed by an unbounded application queue.
      socket.serializeAttachment(a);
      socket.send(frame);
    } catch {
      closeRoomSocket(socket, 1011, "Room unavailable; use event-tail recovery");
    }
  }
}
