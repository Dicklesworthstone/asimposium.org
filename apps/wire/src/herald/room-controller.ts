import {
  HERALD_ROOM_PROTOCOL,
  HERALD_ROOM_LIMITS as LIMITS,
  parseRoomSince,
  parseWorkshopRoomAuth,
  roomCursor,
  roomId,
  roomProblem,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import { type HeraldDatabase, publicRoomHead } from "./outbox.ts";
import {
  anyPublicRoomAttachment,
  closeRoomSocket,
  HeraldRoomFanout,
  type RoomIdentity,
  type RoomPort,
  type RoomSocket,
  sendWorkshopNotice,
  type WorkshopRoomAttachment,
  workshopRoomAttachment,
} from "./room-core.ts";
import type { VerifiedWorkshopRoomTicket } from "./room-ticket.ts";

export type RoomRefusal = "missing" | "query" | "auth" | "upgrade" | "capacity" | "unavailable";
export interface HeraldRoomPort extends RoomPort {
  owns(problemId: string): boolean;
  ownsWorkshop?(fellowId: string, problemId: string): boolean;
  lastPing(socket: RoomSocket): number | null;
  alarmAt(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  generation(): Promise<number>;
  rememberGeneration(generation: number): Promise<void>;
  /** Single-use ticket nonce guard in durable storage. Returns true iff the
   * nonce had NOT been used before and is now durably recorded. */
  consumeTicketNonce?(nonce: string, expMs: number, now: number): Promise<boolean>;
  pair(): { client: unknown; server: RoomSocket };
  upgraded(client: unknown, protocol: string | null): Response;
}
export interface HeraldRoomDependencies {
  db: HeraldDatabase;
  port: HeraldRoomPort;
  authenticate(tokenHash: string, now: number): Promise<RoomIdentity | undefined>;
  validToken(token: string): boolean;
  verifyWorkshopTicket?(ticket: string, now: number): Promise<VerifiedWorkshopRoomTicket | null>;
  workshopHead?(
    sponsorId: string,
    fellowId: string,
    problemId: string,
  ): Promise<{ readonly cursor: number } | null>;
  refuse(kind: RoomRefusal, method: string): Response;
  now?: () => number;
  operationTimeoutMs?: number;
}

function scopedRoomPath(pathname: string, pattern: RegExp): string | undefined {
  const encoded = pattern.exec(pathname)?.[1];
  if (encoded === undefined || encoded.length > 384) return undefined;
  try {
    const id = decodeURIComponent(encoded);
    return roomProblem(id) && (encoded === id || encoded === encodeURIComponent(id))
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only exact canonical room paths are forwarded by the public Worker. */
export function publicRoomRoute(pathname: string): string | undefined {
  return scopedRoomPath(pathname, /^\/p\/([^/]+)\/room$/);
}
function nudgeRoute(pathname: string): string | undefined {
  return scopedRoomPath(pathname, /^\/_herald\/([^/]+)\/nudge$/);
}

/** Exact canonical private sponsor workshop WS route. Tickets NEVER appear in
 * the URL query string or subprotocol; only (fellow, problem) identify the room. */
export function workshopRoomRoute(
  url: URL,
): { readonly fellowId: string; readonly problemId: string } | undefined {
  if (url.pathname !== "/v1/workshop-room") return undefined;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("fellow") || !keys.includes("problem")) return undefined;
  if (
    url.searchParams.getAll("fellow").length !== 1 ||
    url.searchParams.getAll("problem").length !== 1
  )
    return undefined;
  const fellowId = url.searchParams.get("fellow") ?? "";
  const problemId = url.searchParams.get("problem") ?? "";
  if (!roomId(fellowId) || !roomProblem(problemId)) return undefined;
  return { fellowId, problemId };
}

function workshopNudgeRoute(
  pathname: string,
): { readonly fellowId: string; readonly problemId: string } | undefined {
  const match = /^\/_herald\/workshop\/([^/]+)\/([^/]+)\/nudge$/.exec(pathname);
  if (!match) return undefined;
  const [, rawFellow, rawProblem] = match;
  if (!rawFellow || !rawProblem || rawFellow.length > 384 || rawProblem.length > 384)
    return undefined;
  try {
    const fellowId = decodeURIComponent(rawFellow);
    const problemId = decodeURIComponent(rawProblem);
    if (
      !roomId(fellowId) ||
      !roomProblem(problemId) ||
      (rawFellow !== fellowId && rawFellow !== encodeURIComponent(fellowId)) ||
      (rawProblem !== problemId && rawProblem !== encodeURIComponent(problemId))
    )
      return undefined;
    return { fellowId, problemId };
  } catch {
    return undefined;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function publicViewerBucketKey(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && cfIp.length <= 128) return `ip:${cfIp}`;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && forwarded.length <= 128) return `ip:${forwarded}`;
  return "ip:anonymous";
}
function cancelled(): Error {
  return new Error("HERALD_OPERATION_UNAVAILABLE");
}
function alive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

/** Request-owned deadline. Late D1 results are observed but cannot continue
 * into sends or further reads after timeout/disconnect. No idle JS timers. */
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  incoming?: AbortSignal,
): Promise<T> {
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
    const work = Promise.resolve().then(() => {
      alive(controller.signal);
      return run(controller.signal);
    });
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
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
    return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
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
      if (bytes > LIMITS.inputBytes) {
        cancel();
        return undefined;
      }
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const part of chunks) {
      body.set(part, offset);
      offset += part.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const match = /^\s*\{\s*"generation"\s*:\s*([1-9][0-9]{0,15})\s*\}\s*$/.exec(text);
    const generation = match ? Number(match[1]) : NaN;
    return roomCursor(generation) ? generation : undefined;
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
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
    const workshop = url.pathname === "/v1/workshop-room" ? workshopRoomRoute(url) : undefined;
    const workshopNudge = workshopNudgeRoute(url.pathname);
    try {
      if (url.pathname === "/v1/workshop-room") {
        if (request.method !== "GET") return this.deps.refuse("upgrade", request.method);
        if (
          request.headers.has("cookie") ||
          request.headers.has("authorization") ||
          request.headers.has("x-fellow-id") ||
          request.headers.has("x-sponsor-id")
        )
          return this.deps.refuse("auth", request.method);
        if (workshop === undefined) return this.deps.refuse("query", request.method);
        if (!this.deps.port.ownsWorkshop?.(workshop.fellowId, workshop.problemId))
          return this.deps.refuse("missing", request.method);
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return this.deps.refuse("upgrade", request.method);
        const protocol = request.headers.get("sec-websocket-protocol");
        if (protocol !== null && protocol !== HERALD_ROOM_PROTOCOL)
          return this.deps.refuse("query", request.method);
        return await bounded(
          async (signal) => {
            if (this.deps.port.sockets().length >= LIMITS.connections)
              return this.deps.refuse("capacity", request.method);
            const now = this.now();
            const pair = this.deps.port.pair();
            const attachment: WorkshopRoomAttachment = {
              v: 3,
              mode: "workshop",
              problemId: workshop.problemId,
              fellowId: workshop.fellowId,
              sponsorId: null,
              authenticated: false,
              cursor: 0,
              connectedAt: now,
              authDeadlineAt: now + LIMITS.authDeadlineMs,
              expiresAt: now + LIMITS.lifetimeMs,
              lastMessageAt: 0,
            };
            this.deps.port.accept(pair.server, ["workshop-pending"]);
            pair.server.serializeAttachment(attachment);
            try {
              await this.armWorkshop();
              alive(signal);
              return this.deps.port.upgraded(pair.client, protocol);
            } catch (error) {
              closeRoomSocket(pair.server, 1011, "Workshop room unavailable; use cursor polling");
              throw error;
            }
          },
          this.deps.operationTimeoutMs ?? 4_000,
          request.signal,
        );
      }

      if (workshopNudge !== undefined) {
        if (!this.deps.port.ownsWorkshop?.(workshopNudge.fellowId, workshopNudge.problemId))
          return this.deps.refuse("missing", request.method);
        if (request.method !== "POST" || url.search !== "")
          return this.deps.refuse("query", request.method);
        return await bounded(
          async (signal) => {
            await this.sweepWorkshop(workshopNudge.fellowId, workshopNudge.problemId, signal);
            alive(signal);
            await this.armWorkshop();
            alive(signal);
            return new Response(null, { status: 204 });
          },
          this.deps.operationTimeoutMs ?? 4_000,
          request.signal,
        );
      }

      if ((problem === undefined && nudge === undefined) || !this.deps.port.owns(problem ?? nudge!))
        return this.deps.refuse("missing", request.method);
      return await bounded(
        async (signal) => {
          if (nudge !== undefined) {
            if (request.method !== "POST" || url.search !== "")
              return this.deps.refuse("query", request.method);
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

          // S-6 host-only cookie isolation: cookies and spoofed identity headers
          // are NEVER accepted on a.asimposium.org, even on public rooms.
          if (
            request.headers.has("cookie") ||
            request.headers.has("x-fellow-id") ||
            request.headers.has("x-sponsor-id")
          ) {
            return this.deps.refuse("auth", request.method);
          }

          if (request.headers.has("authorization")) {
            const authorization = request.headers.get("authorization") ?? "";
            if (authorization.length > 512) return this.deps.refuse("auth", request.method);
            const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
            if (token === undefined || !this.deps.validToken(token))
              return this.deps.refuse("auth", request.method);
            const tokenHash = await sha256Hex(token);
            alive(signal);
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
            const result = this.fanout.connect(
              pair.server,
              { problemId: problem!, since, tokenHash, identity },
              head,
              this.now(),
            );
            if (result !== "accepted")
              return this.deps.refuse(result === "capacity" ? "capacity" : "query", request.method);
            try {
              await this.arm();
              alive(signal);
              return this.deps.port.upgraded(pair.client, protocol);
            } catch (error) {
              closeRoomSocket(pair.server, 1011, "Room unavailable; use event-tail recovery");
              throw error;
            }
          }

          // Unauthenticated read-only human viewer on public problem room (Fable §11).
          const head = await publicRoomHead(this.deps.db, problem!);
          alive(signal);
          if (!head) return this.deps.refuse("missing", request.method);
          if (since > head.seq) return this.deps.refuse("query", request.method);
          const ipHash = await sha256Hex(publicViewerBucketKey(request));
          alive(signal);
          const pair = this.deps.port.pair();
          const result = this.fanout.connectPublic(
            pair.server,
            { problemId: problem!, since, ipHash },
            head,
            this.now(),
          );
          if (result !== "accepted")
            return this.deps.refuse(result === "capacity" ? "capacity" : "query", request.method);
          try {
            await this.arm();
            alive(signal);
            return this.deps.port.upgraded(pair.client, protocol);
          } catch (error) {
            closeRoomSocket(pair.server, 1011, "Room unavailable; use event-tail recovery");
            throw error;
          }
        },
        this.deps.operationTimeoutMs ?? 4_000,
        request.signal,
      );
    } catch {
      return this.deps.refuse("unavailable", request.method);
    }
  }

  async webSocketMessage(socket: RoomSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const wsAttachment = workshopRoomAttachment(socket);
      if (wsAttachment !== undefined) {
        await this.handleWorkshopMessage(socket, wsAttachment, message);
        return;
      }
      const ack = this.fanout.beginAck(socket, message, this.now());
      if (ack === undefined) return;
      await bounded(async (signal) => {
        const a = anyPublicRoomAttachment(socket);
        if (!a || !this.deps.port.owns(a.problemId)) {
          closeRoomSocket(socket, 1008, "Room access ended");
          return;
        }
        const identity =
          a.v === 1 ? await this.deps.authenticate(a.tokenHash, this.now()) : undefined;
        alive(signal);
        const head = await publicRoomHead(this.deps.db, a.problemId);
        alive(signal);
        this.fanout.completeAck(socket, ack, identity, head, this.now());
      }, this.deps.operationTimeoutMs ?? 4_000);
    } catch {
      closeRoomSocket(socket, 1011, "Room unavailable; use event-tail recovery");
    }
  }

  async alarm(): Promise<void> {
    let isWorkshopRoom = false;
    try {
      await bounded(async (signal) => {
        const sockets = this.deps.port.sockets();
        const workshopAtt = sockets.map(workshopRoomAttachment).find((a) => a !== undefined);
        if (workshopAtt !== undefined) {
          isWorkshopRoom = true;
          await this.sweepWorkshop(workshopAtt.fellowId, workshopAtt.problemId, signal);
          return;
        }
        const problem = sockets
          .map(anyPublicRoomAttachment)
          .find((a) => a !== undefined)?.problemId;
        if (problem !== undefined) await this.sweep(problem, "revalidate", signal);
        else for (const socket of sockets) closeRoomSocket(socket, 1008, "Room access ended");
      }, this.deps.operationTimeoutMs ?? 4_000);
    } catch {
      for (const socket of this.deps.port.sockets())
        closeRoomSocket(socket, 1011, "Room unavailable; use event-tail recovery");
    } finally {
      if (isWorkshopRoom) await this.armWorkshop();
      else await this.arm();
    }
  }

  private async handleWorkshopMessage(
    socket: RoomSocket,
    initial: WorkshopRoomAttachment,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const now = this.now();
    if (socket.readyState !== 1) return;
    if (now < initial.connectedAt || now >= initial.expiresAt) {
      closeRoomSocket(socket, 1008, "Workshop room authorization expired");
      return;
    }
    if (initial.authenticated) {
      if (message === "ping") {
        initial.lastMessageAt = now;
        socket.serializeAttachment(initial);
        socket.send("pong");
        return;
      }
      closeRoomSocket(socket, 1008, "Unexpected workshop room message");
      return;
    }
    if (now > initial.authDeadlineAt) {
      closeRoomSocket(socket, 1008, "Workshop room auth timeout");
      return;
    }
    const ticket = parseWorkshopRoomAuth(message);
    if (ticket === undefined) {
      closeRoomSocket(socket, 1008, "Invalid workshop room auth frame");
      return;
    }
    await bounded(async (signal) => {
      if (
        !this.deps.verifyWorkshopTicket ||
        !this.deps.workshopHead ||
        !this.deps.port.consumeTicketNonce
      ) {
        closeRoomSocket(socket, 1011, "Workshop room unavailable; use cursor polling");
        return;
      }
      const verified = await this.deps.verifyWorkshopTicket(ticket, this.now());
      alive(signal);
      if (
        verified === null ||
        verified.fellowId !== initial.fellowId ||
        verified.problemId !== initial.problemId
      ) {
        closeRoomSocket(socket, 1008, "Workshop room access denied");
        return;
      }
      const fresh = await this.deps.port.consumeTicketNonce(
        verified.nonce,
        verified.expMs,
        this.now(),
      );
      alive(signal);
      if (!fresh) {
        closeRoomSocket(socket, 1008, "Workshop room ticket already used");
        return;
      }
      const head = await this.deps.workshopHead(
        verified.sponsorId,
        verified.fellowId,
        verified.problemId,
      );
      alive(signal);
      if (head === null) {
        closeRoomSocket(socket, 1008, "Workshop room access denied");
        return;
      }
      const liveAtt = workshopRoomAttachment(socket);
      if (!liveAtt || liveAtt.authenticated || socket.readyState !== 1) return;
      const sameSponsor = this.deps.port
        .sockets()
        .map(workshopRoomAttachment)
        .filter(
          (a) => a !== undefined && a.authenticated && a.sponsorId === verified.sponsorId,
        ).length;
      if (sameSponsor >= LIMITS.perSponsor) {
        closeRoomSocket(socket, 1013, "Sponsor workshop room limit reached");
        return;
      }
      liveAtt.authenticated = true;
      liveAtt.sponsorId = verified.sponsorId;
      liveAtt.lastMessageAt = this.now();
      sendWorkshopNotice(socket, liveAtt, head.cursor);
      await this.armWorkshop();
    }, this.deps.operationTimeoutMs ?? 4_000);
  }

  private async sweepWorkshop(
    fellowId: string,
    problemId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const sockets = this.deps.port.sockets();
    if (sockets.length > LIMITS.connections) {
      for (const socket of sockets)
        closeRoomSocket(socket, 1013, "Use workshop cursor polling before reconnecting");
      return;
    }
    const now = this.now();
    const bySponsor = new Map<
      string,
      { socket: RoomSocket; attachment: WorkshopRoomAttachment }[]
    >();
    for (const socket of sockets) {
      if (socket.readyState !== 1) continue;
      const a = workshopRoomAttachment(socket);
      if (
        !a ||
        a.fellowId !== fellowId ||
        a.problemId !== problemId ||
        !this.deps.port.ownsWorkshop?.(fellowId, problemId)
      ) {
        closeRoomSocket(socket, 1008, "Workshop room access ended");
        continue;
      }
      if (!a.authenticated) {
        if (now >= a.authDeadlineAt) closeRoomSocket(socket, 1008, "Workshop room auth timeout");
        continue;
      }
      if (now < a.connectedAt || now >= a.expiresAt) {
        closeRoomSocket(socket, 1008, "Workshop room authorization expired");
        continue;
      }
      const lastPing = this.deps.port.lastPing(socket) ?? 0;
      if (now - Math.max(a.connectedAt, a.lastMessageAt, lastPing) > LIMITS.silenceMs) {
        closeRoomSocket(socket, 1001, "Workshop room heartbeat expired");
        continue;
      }
      if (a.sponsorId === null) {
        closeRoomSocket(socket, 1008, "Workshop room access ended");
        continue;
      }
      const group = bySponsor.get(a.sponsorId) ?? [];
      group.push({ socket, attachment: a });
      bySponsor.set(a.sponsorId, group);
    }
    if (bySponsor.size === 0 || !this.deps.workshopHead) return;
    for (const [sponsorId, entries] of bySponsor) {
      alive(signal);
      const head = await this.deps.workshopHead(sponsorId, fellowId, problemId);
      alive(signal);
      for (const { socket, attachment } of entries) {
        if (socket.readyState !== 1) continue;
        if (head === null) {
          closeRoomSocket(socket, 1008, "Workshop room access ended");
          continue;
        }
        if (head.cursor > attachment.cursor) {
          sendWorkshopNotice(socket, attachment, head.cursor);
        }
      }
    }
  }

  private async sweep(
    problem: string,
    mode: "refresh" | "revalidate",
    signal: AbortSignal,
  ): Promise<void> {
    const sockets = this.deps.port.sockets();
    if (sockets.length > LIMITS.connections) {
      for (const socket of sockets)
        closeRoomSocket(socket, 1013, "Use event-tail polling before reconnecting");
      return;
    }
    // Four concurrent authority reads, at most 32 total; no cross-request cache.
    // Public human viewers require zero credential lookup (publicRoomHead only).
    const participants = new Map<RoomSocket, RoomIdentity | undefined>();
    for (let start = 0; start < sockets.length; start += 4) {
      alive(signal);
      await Promise.all(
        sockets.slice(start, start + 4).map(async (socket) => {
          const a = anyPublicRoomAttachment(socket);
          if (socket.readyState !== 1) return;
          if (!a || a.problemId !== problem || !this.deps.port.owns(a.problemId)) {
            closeRoomSocket(socket, 1008, "Room access ended");
            return;
          }
          if (a.v === 2) {
            participants.set(socket, undefined);
            return;
          }
          const identity = await this.deps.authenticate(a.tokenHash, this.now());
          alive(signal);
          participants.set(socket, identity);
        }),
      );
    }
    alive(signal);
    if (participants.size === 0) return;
    // Visibility and head are read last, immediately before synchronous fanout.
    const head = await publicRoomHead(this.deps.db, problem);
    alive(signal);
    for (const [socket, identity] of participants) {
      if (mode === "refresh") this.fanout.refresh(socket, identity, head, this.now());
      else
        this.fanout.revalidate(socket, identity, head, this.now(), this.deps.port.lastPing(socket));
    }
  }

  private async armWorkshop(): Promise<void> {
    const current = await this.deps.port.alarmAt();
    const liveSockets = this.deps.port.sockets().filter((socket) => socket.readyState === 1);
    if (liveSockets.length === 0) {
      if (current !== null) await this.deps.port.deleteAlarm();
      return;
    }
    const now = this.now();
    const hasPending = liveSockets.some((s) => {
      const a = workshopRoomAttachment(s);
      return a !== undefined && !a.authenticated;
    });
    const next = now + (hasPending ? LIMITS.authDeadlineMs : LIMITS.revalidateMs);
    if (current === null || current < now || current > next) await this.deps.port.setAlarm(next);
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
    if (current === null || current < this.now() || current > next)
      await this.deps.port.setAlarm(next);
  }
}
