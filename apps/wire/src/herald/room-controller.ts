import {
  HERALD_ROOM_LIMITS as LIMITS,
  HERALD_ROOM_PROTOCOL,
  parseRoomSince,
  roomCursor,
  roomProblem,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import { publicRoomHead, type HeraldDatabase } from "./outbox.ts";
import {
  closeRoomSocket,
  HeraldRoomFanout,
  roomAttachment,
  type RoomIdentity,
  type RoomPort,
  type RoomSocket,
} from "./room-core.ts";

export type RoomRefusal = "missing" | "query" | "auth" | "upgrade" | "capacity" | "unavailable";
export interface HeraldRoomPort extends RoomPort {
  owns(problemId: string): boolean;
  lastPing(socket: RoomSocket): number | null;
  alarmAt(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  generation(): Promise<number>;
  rememberGeneration(generation: number): Promise<void>;
  pair(): { client: unknown; server: RoomSocket };
  upgraded(client: unknown, protocol: string | null): Response;
}
export interface HeraldRoomDependencies {
  db: HeraldDatabase;
  port: HeraldRoomPort;
  authenticate(tokenHash: string, now: number): Promise<RoomIdentity | undefined>;
  validToken(token: string): boolean;
  refuse(kind: RoomRefusal, method: string): Response;
  now?: () => number;
  operationTimeoutMs?: number;
}

function scopedRoomPath(pathname: string, pattern: RegExp): string | undefined {
  const encoded = pattern.exec(pathname)?.[1];
  if (encoded === undefined || encoded.length > 384) return undefined;
  try {
    const id = decodeURIComponent(encoded);
    return roomProblem(id) && (encoded === id || encoded === encodeURIComponent(id)) ? id : undefined;
  } catch { return undefined; }
}

/** Only exact canonical room paths are forwarded by the public Worker. */
export function publicRoomRoute(pathname: string): string | undefined {
  return scopedRoomPath(pathname, /^\/p\/([^/]+)\/room$/);
}
function nudgeRoute(pathname: string): string | undefined {
  return scopedRoomPath(pathname, /^\/_herald\/([^/]+)\/nudge$/);
}
function cancelled(): Error { return new Error("HERALD_OPERATION_UNAVAILABLE"); }
function alive(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

/** Request-owned deadline. Late D1 results are observed but cannot continue
 * into sends or further reads after timeout/disconnect. No idle JS timers. */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, incoming?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (incoming?.aborted) abort();
  incoming?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      stop = () => reject(cancelled());
      controller.signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(abort, ms);
      if (controller.signal.aborted) stop();
    });
    const work = Promise.resolve().then(() => { alive(controller.signal); return run(controller.signal); });
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (stop) controller.signal.removeEventListener("abort", stop);
    incoming?.removeEventListener("abort", abort);
    // Also protects against accidentally detached continuations on success.
    controller.abort();
  }
}

async function generationBody(request: Request, signal: AbortSignal): Promise<number | undefined> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      alive(signal);
      const part = await reader.read();
      alive(signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > LIMITS.inputBytes) { cancel(); return undefined; }
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const part of chunks) { body.set(part, offset); offset += part.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const match = /^\s*\{\s*"generation"\s*:\s*([1-9][0-9]{0,15})\s*\}\s*$/.exec(text);
    const generation = match ? Number(match[1]) : NaN;
    return roomCursor(generation) ? generation : undefined;
  } catch { return undefined; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Transport orchestration; every awaited authority is the production
 * enrollment store, never a self-declared Fellow/sponsor header. Unit tests
 * substitute the socket/storage port, not the canonical SQL head query. */
export class HeraldRoomController {
  private readonly deps: HeraldRoomDependencies;
  private readonly fanout: HeraldRoomFanout;
  private readonly now: () => number;
  constructor(deps: HeraldRoomDependencies) {
    this.deps = deps;
    this.fanout = new HeraldRoomFanout(deps.port);
    this.now = deps.now ?? Date.now;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const problem = publicRoomRoute(url.pathname);
    const nudge = nudgeRoute(url.pathname);
    try {
      if ((problem === undefined && nudge === undefined) || !this.deps.port.owns(problem ?? nudge!))
        return this.deps.refuse("missing", request.method);
      return await bounded(async (signal) => {
        if (nudge !== undefined) {
          if (request.method !== "POST" || url.search !== "") return this.deps.refuse("query", request.method);
          const generation = await generationBody(request, signal);
          alive(signal);
          if (generation === undefined) return this.deps.refuse("query", request.method);
          const previous = await this.deps.port.generation();
          alive(signal);
          if (!roomCursor(previous)) throw cancelled();
          if (generation > previous) {
            await this.sweep(nudge, "refresh", signal);
            alive(signal);
            await this.deps.port.rememberGeneration(generation);
            alive(signal);
          }
          await this.arm();
          alive(signal);
          return new Response(null, { status: 204 });
        }
        if (request.method !== "GET") return this.deps.refuse("upgrade", request.method);
        const since = parseRoomSince(url.searchParams);
        if (since === undefined) return this.deps.refuse("query", request.method);
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return this.deps.refuse("upgrade", request.method);
        const protocol = request.headers.get("sec-websocket-protocol");
        if (protocol !== null && protocol !== HERALD_ROOM_PROTOCOL)
          return this.deps.refuse("query", request.method);
        const authorization = request.headers.get("authorization") ?? "";
        if (authorization.length > 512) return this.deps.refuse("auth", request.method);
        const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
        if (token === undefined || !this.deps.validToken(token)) return this.deps.refuse("auth", request.method);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
        alive(signal);
        const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const identity = await this.deps.authenticate(tokenHash, this.now());
        alive(signal);
        if (!identity) return this.deps.refuse("auth", request.method);
        if (identity.problemBinding !== undefined && identity.problemBinding !== problem)
          return this.deps.refuse("missing", request.method);
        const head = await publicRoomHead(this.deps.db, problem!);
        alive(signal);
        if (!head) return this.deps.refuse("missing", request.method);
        if (since > head.seq) return this.deps.refuse("query", request.method);
        const pair = this.deps.port.pair();
        const result = this.fanout.connect(pair.server, { problemId: problem!, since, tokenHash, identity }, head, this.now());
        if (result !== "accepted") return this.deps.refuse(result === "capacity" ? "capacity" : "query", request.method);
        try {
          await this.arm();
          alive(signal);
          return this.deps.port.upgraded(pair.client, protocol);
        } catch (error) {
          closeRoomSocket(pair.server, 1011, "Room unavailable; use event-tail recovery");
          throw error;
        }
      }, this.deps.operationTimeoutMs ?? 4_000, request.signal);
    } catch { return this.deps.refuse("unavailable", request.method); }
  }

  async webSocketMessage(socket: RoomSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const ack = this.fanout.beginAck(socket, message, this.now());
      if (ack === undefined) return;
      await bounded(async (signal) => {
        const a = roomAttachment(socket);
        if (!a || !this.deps.port.owns(a.problemId)) { closeRoomSocket(socket, 1008, "Room access ended"); return; }
        const identity = await this.deps.authenticate(a.tokenHash, this.now());
        alive(signal);
        const head = await publicRoomHead(this.deps.db, a.problemId);
        alive(signal);
        this.fanout.completeAck(socket, ack, identity, head, this.now());
      }, this.deps.operationTimeoutMs ?? 4_000);
    } catch { closeRoomSocket(socket, 1011, "Room unavailable; use event-tail recovery"); }
  }

  async alarm(): Promise<void> {
    try {
      await bounded(async (signal) => {
        const sockets = this.deps.port.sockets();
        const problem = sockets.map(roomAttachment).find((a) => a !== undefined)?.problemId;
        if (problem !== undefined) await this.sweep(problem, "revalidate", signal);
        else for (const socket of sockets) closeRoomSocket(socket, 1008, "Room access ended");
      }, this.deps.operationTimeoutMs ?? 4_000);
    } catch {
      for (const socket of this.deps.port.sockets()) closeRoomSocket(socket, 1011, "Room unavailable; use event-tail recovery");
    } finally { await this.arm(); }
  }

  private async sweep(problem: string, mode: "refresh" | "revalidate", signal: AbortSignal): Promise<void> {
    const sockets = this.deps.port.sockets();
    if (sockets.length > LIMITS.connections) {
      for (const socket of sockets) closeRoomSocket(socket, 1013, "Use event-tail polling before reconnecting");
      return;
    }
    // Four concurrent authority reads, at most 32 total; no cross-request cache.
    const identities = new Map<RoomSocket, RoomIdentity | undefined>();
    for (let start = 0; start < sockets.length; start += 4) {
      alive(signal);
      await Promise.all(sockets.slice(start, start + 4).map(async (socket) => {
        const a = roomAttachment(socket);
        if (socket.readyState !== 1) return;
        if (!a || a.problemId !== problem || !this.deps.port.owns(a.problemId)) {
          closeRoomSocket(socket, 1008, "Room access ended"); return;
        }
        const identity = await this.deps.authenticate(a.tokenHash, this.now());
        alive(signal);
        identities.set(socket, identity);
      }));
    }
    alive(signal);
    if (identities.size === 0) return;
    // Visibility and head are read last, immediately before synchronous fanout.
    const head = await publicRoomHead(this.deps.db, problem);
    alive(signal);
    for (const [socket, identity] of identities) {
      if (mode === "refresh") this.fanout.refresh(socket, identity, head, this.now());
      else this.fanout.revalidate(socket, identity, head, this.now(), this.deps.port.lastPing(socket));
    }
  }

  private async arm(): Promise<void> {
    // Durable alarms permit hibernation. Never postpone an existing earlier
    // expiry sweep as more clients connect. No work remains when rooms empty.
    const current = await this.deps.port.alarmAt();
    if (!this.deps.port.sockets().some((socket) => socket.readyState === 1)) {
      if (current !== null) await this.deps.port.deleteAlarm();
      return;
    }
    const next = this.now() + LIMITS.revalidateMs;
    if (current === null || current < this.now() || current > next) await this.deps.port.setAlarm(next);
  }
}
