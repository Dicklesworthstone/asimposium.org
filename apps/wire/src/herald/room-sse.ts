/**
 * Bounded persistent SSE fallback for public problem live rooms (Fable §11).
 *
 * Distinct from snapshot GET /p/:id/events?format=sse: this stream emits only
 * committed public_seq resync notices (never private/workshop bytes), carries
 * a bounded lifetime (60s) with explicit retry/reconnect guidance, and exits
 * immediately when the problem becomes private/dormant or the client aborts.
 */

import {
  HERALD_ROOM_LIMITS,
  parseRoomSince,
  roomNotice,
  roomProblem,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import { SERVICE_ENVELOPE_HEADER } from "../auth/http.ts";
import { type HeraldDatabase, publicRoomHead } from "./outbox.ts";
import { roomRefusal } from "./room-http.ts";

export interface HeraldSseOptions {
  readonly lifetimeMs?: number;
  readonly pollIntervalMs?: number;
  readonly keepaliveMs?: number;
  readonly now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_KEEPALIVE_MS = 15_000;

export function publicRoomSseRoute(pathname: string): string | undefined {
  const encoded = /^\/p\/([^/]+)\/room\/sse$/.exec(pathname)?.[1];
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

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Credentialless read-only SSE room stream. Runs inside publicWatchFetch so
 * wildcard CORS applies cleanly while cookies/credentials remain forbidden (S-6). */
export async function heraldSseFetch(
  request: Request,
  env: { readonly DB?: HeraldDatabase },
  next: () => Response | Promise<Response>,
  options: HeraldSseOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const problem = publicRoomSseRoute(url.pathname);
  if (problem === undefined) return next();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "private, no-store" },
    });
  }
  // S-6 host-only cookie isolation: cookies and spoofed identity headers are
  // never accepted on public room endpoints.
  if (
    request.headers.has("cookie") ||
    request.headers.has("authorization") ||
    request.headers.has(SERVICE_ENVELOPE_HEADER) ||
    request.headers.has("x-fellow-id") ||
    request.headers.has("x-sponsor-id")
  ) {
    return roomRefusal("auth", request.method);
  }
  const since = parseRoomSince(url.searchParams);
  if (since === undefined) return roomRefusal("query", request.method);
  let db: HeraldDatabase | undefined;
  let initialHead: { seq: number } | null;
  try {
    db = env.DB;
    if (db === undefined) return roomRefusal("unavailable", request.method);
    initialHead = await publicRoomHead(db, problem);
  } catch {
    return roomRefusal("unavailable", request.method);
  }
  if (initialHead === null) return roomRefusal("missing", request.method);
  if (since > initialHead.seq) return roomRefusal("query", request.method);

  const headers: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const now = options.now ?? Date.now;
  const lifetimeMs = Math.max(
    10,
    Math.min(options.lifetimeMs ?? HERALD_ROOM_LIMITS.sseLifetimeMs, 120_000),
  );
  const pollIntervalMs = Math.max(
    5,
    Math.min(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 5_000),
  );
  const keepaliveMs = Math.max(10, options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
  const encoder = new TextEncoder();
  const internalAbort = new AbortController();
  const onRequestAbort = () => internalAbort.abort();
  request.signal.addEventListener("abort", onRequestAbort, { once: true });
  if (request.signal.aborted) internalAbort.abort();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string) => {
        if (internalAbort.signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          internalAbort.abort();
          return false;
        }
      };
      try {
        const startedAt = now();
        let lastKeepalive = startedAt;
        let announced = initialHead.seq;
        if (!enqueue(`retry: ${HERALD_ROOM_LIMITS.retrySeconds * 1000}\n\n`)) return;
        if (!enqueue(`event: resync\ndata: ${roomNotice(problem, since, announced)}\n\n`)) return;

        while (!internalAbort.signal.aborted) {
          const elapsed = now() - startedAt;
          if (elapsed >= lifetimeMs) {
            enqueue(
              `event: reconnect\ndata: ${JSON.stringify({ retry_ms: HERALD_ROOM_LIMITS.retrySeconds * 1000 })}\n\n`,
            );
            break;
          }
          const remaining = lifetimeMs - elapsed;
          const ok = await sleep(Math.min(pollIntervalMs, remaining), internalAbort.signal);
          if (!ok || internalAbort.signal.aborted) break;

          let current: { seq: number } | null;
          try {
            current = await publicRoomHead(db, problem);
          } catch {
            enqueue(
              `event: reconnect\ndata: ${JSON.stringify({ retry_ms: HERALD_ROOM_LIMITS.retrySeconds * 1000 })}\n\n`,
            );
            break;
          }
          if (current === null) {
            enqueue(`event: closed\ndata: ${JSON.stringify({ reason: "access-ended" })}\n\n`);
            break;
          }
          if (current.seq > announced) {
            if (
              !enqueue(`event: resync\ndata: ${roomNotice(problem, announced, current.seq)}\n\n`)
            ) {
              break;
            }
            announced = current.seq;
            lastKeepalive = now();
          } else if (now() - lastKeepalive >= keepaliveMs) {
            if (!enqueue(": keepalive\n\n")) break;
            lastKeepalive = now();
          }
        }
      } finally {
        request.signal.removeEventListener("abort", onRequestAbort);
        try {
          controller.close();
        } catch {
          // Already closed or cancelled by client.
        }
      }
    },
    cancel() {
      internalAbort.abort();
      request.signal.removeEventListener("abort", onRequestAbort);
    },
  });

  return new Response(stream, { status: 200, headers });
}
