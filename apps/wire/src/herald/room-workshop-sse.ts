import {
  HERALD_ROOM_LIMITS as LIMITS,
  parseWorkshopRoomAuth,
  workshopRoomNotice,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import type { HeraldRoomDependencies } from "./room-controller.ts";

type WorkshopScope = { readonly fellowId: string; readonly problemId: string };
interface WorkshopStreamDependencies
  extends Pick<
    HeraldRoomDependencies,
    "verifyWorkshopTicket" | "workshopHead" | "refuse" | "now" | "operationTimeoutMs"
  > {
  consumeTicketNonce(nonce: string, expMs: number, now: number): Promise<boolean>;
  socketCount(sponsorId?: string): number;
  readonly lifetimeMs?: number;
  readonly pollIntervalMs?: number;
}

function alive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("WORKSHOP_STREAM_STOPPED");
}

/** Observe late provider results, but never let them continue after a deadline. */
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  incoming: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  incoming.addEventListener("abort", abort, { once: true });
  if (incoming.aborted) abort();
  let stop: (() => void) | undefined;
  const timer = setTimeout(abort, milliseconds);
  try {
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("WORKSHOP_STREAM_STOPPED"));
      controller.signal.addEventListener("abort", stop, { once: true });
      if (controller.signal.aborted) stop();
    });
    const work = Promise.resolve().then(() => {
      alive(controller.signal);
      return run(controller.signal);
    });
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    incoming.removeEventListener("abort", abort);
    if (stop) controller.signal.removeEventListener("abort", stop);
    controller.abort();
  }
}

async function readAuth(request: Request, signal: AbortSignal): Promise<string | undefined> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
    return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const bytes = new Uint8Array(LIMITS.authInputBytes);
  let length = 0;
  try {
    while (true) {
      alive(signal);
      const part = await reader.read();
      alive(signal);
      if (part.done) break;
      if (length + part.value.byteLength > bytes.byteLength) {
        cancel();
        return undefined;
      }
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    return parseWorkshopRoomAuth(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** These bounded streams live in the same DO as WebSockets, sharing the durable
 * one-use ticket authority and connection caps. Only cursor notices cross the
 * stream; each D1 read rechecks the current sponsor and Fellow lifecycle. */
export class WorkshopRoomStreams {
  private readonly connections = new Map<symbol, string | null>();
  constructor(private readonly deps: WorkshopStreamDependencies) {}

  count(sponsorId?: string): number {
    return sponsorId === undefined
      ? this.connections.size
      : [...this.connections.values()].filter((sponsor) => sponsor === sponsorId).length;
  }

  async fetch(request: Request, scope: WorkshopScope): Promise<Response> {
    const deps = this.deps;
    const now = deps.now ?? Date.now;
    const verifyWorkshopTicket = deps.verifyWorkshopTicket;
    const workshopHead = deps.workshopHead;
    if (!verifyWorkshopTicket || !workshopHead)
      return deps.refuse("unavailable", request.method);
    if (this.count() + deps.socketCount() >= LIMITS.connections)
      return deps.refuse("capacity", request.method);
    const connection = Symbol();
    this.connections.set(connection, null);
    let streaming = false;
    try {
      const authorized = await bounded(
        async (signal) => {
          const ticket = await readAuth(request, signal);
          alive(signal);
          if (ticket === undefined) return null;
          const verified = await verifyWorkshopTicket(ticket, now());
          alive(signal);
          if (
            verified === null ||
            verified.fellowId !== scope.fellowId ||
            verified.problemId !== scope.problemId
          )
            return null;
          const fresh = await deps.consumeTicketNonce(verified.nonce, verified.expMs, now());
          alive(signal);
          if (!fresh) return null;
          const head = await workshopHead(
            verified.sponsorId,
            scope.fellowId,
            scope.problemId,
          );
          alive(signal);
          return head === null ? null : { sponsorId: verified.sponsorId, cursor: head.cursor };
        },
        deps.operationTimeoutMs ?? 4_000,
        request.signal,
      );
      if (authorized === null) return deps.refuse("auth", request.method);
      if (
        this.count(authorized.sponsorId) + deps.socketCount(authorized.sponsorId) >=
        LIMITS.perSponsor
      )
        return deps.refuse("capacity", request.method);
      this.connections.set(connection, authorized.sponsorId);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const release = () => {
        abort();
        request.signal.removeEventListener("abort", abort);
        this.connections.delete(connection);
      };
      const lifetimeMs = Math.max(
        10,
        Math.min(deps.lifetimeMs ?? LIMITS.sseLifetimeMs, LIMITS.sseLifetimeMs),
      );
      const pollIntervalMs = Math.max(5, Math.min(deps.pollIntervalMs ?? 1_500, 5_000));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(output) {
          const enqueue = (chunk: string): boolean => {
            if (controller.signal.aborted || (output.desiredSize ?? 0) <= 0) return false;
            output.enqueue(encoder.encode(chunk));
            return true;
          };
          const reconnect = () => enqueue('event: reconnect\ndata: {"retry_ms":5000}\n\n');
          const lifetime = setTimeout(() => {
            reconnect();
            abort();
          }, lifetimeMs);
          try {
            const started = now();
            let announced = authorized.cursor;
            let lastKeepalive = started;
            if (
              !enqueue(
                `retry: ${LIMITS.retrySeconds * 1000}\nevent: workshop-update\ndata: ${workshopRoomNotice(scope.problemId, scope.fellowId, announced)}\n\n`,
              )
            )
              return;
            while (!controller.signal.aborted) {
              await pause(pollIntervalMs, controller.signal);
              alive(controller.signal);
              if (now() < started || now() - started >= lifetimeMs) break;
              const head = await bounded(
                () => workshopHead(authorized.sponsorId, scope.fellowId, scope.problemId),
                deps.operationTimeoutMs ?? 4_000,
                controller.signal,
              );
              alive(controller.signal);
              if (head === null) {
                enqueue('event: closed\ndata: {"reason":"access-ended"}\n\n');
                break;
              }
              if (head.cursor < announced) break;
              if (head.cursor > announced) {
                if (
                  !enqueue(
                    `event: workshop-update\ndata: ${workshopRoomNotice(scope.problemId, scope.fellowId, head.cursor)}\n\n`,
                  )
                )
                  break;
                announced = head.cursor;
                lastKeepalive = now();
              } else if (now() - lastKeepalive >= 15_000) {
                if (!enqueue(": keepalive\n\n")) break;
                lastKeepalive = now();
              }
            }
          } catch {
            if (!controller.signal.aborted) reconnect();
          } finally {
            clearTimeout(lifetime);
            release();
            try {
              output.close();
            } catch {
              // Cancellation already closed the consumer's stream.
            }
          }
        },
        cancel: release,
      });
      streaming = true;
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return deps.refuse("unavailable", request.method);
    } finally {
      if (!streaming) this.connections.delete(connection);
    }
  }
}
