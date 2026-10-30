import { isTrustedStoaOrigin } from "@asimposium/contracts";
import type { Env } from "../env";
import { cursorEtag, cursorEtagMatches, cursorUnavailable } from "./public-cursor";

export const PUBLIC_CURSOR_CACHE_MAX_AGE_MS = 5_000;
export const PUBLIC_CURSOR_CACHE_IO_TIMEOUT_MS = 100;
const OBSERVED_AT = "x-asimp-internal-cursor-observed-at";
const GENERATION = "x-asimp-internal-cursor-generation";
const BODY_LIMIT = 16;
const RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "cache-control",
  "asimp-protocol-version",
  "link",
  "vary",
] as const;

/** The provider Cache API is optional. An unavailable cache never disables the
 * canonical public D1 read, and cache state never becomes ledger authority. */
export interface PublicCursorCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<unknown>;
  delete(request: Request): Promise<unknown>;
}

type CursorEnv = Pick<Env, "DB" | "STOA_ORIGIN">;
interface Snapshot {
  readonly body: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly observedAt: number;
  readonly generation: number;
}
interface Scope {
  readonly key: Request;
  generation: number;
  pending?: Promise<Snapshot | Response>;
}

/** Cache failures must not strand a read or a response to an already committed
 * write. A late provider promise remains observed by Promise.race; callers
 * fence late writes separately because Cache API I/O cannot be cancelled. */
async function cacheOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("PUBLIC_CURSOR_CACHE_TIMEOUT"));
      }, PUBLIC_CURSOR_CACHE_IO_TIMEOUT_MS);
    });
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function providerCache(): Promise<PublicCursorCache | undefined> {
  // Use a structural boundary because the Worker and Bun's web types have
  // different CacheStorage declarations. No provider capability is invented.
  const storage = (globalThis as { caches?: { open(name: string): Promise<PublicCursorCache> } })
    .caches;
  return storage?.open("asimposium-public-cursor-v1");
}

function cacheOrigin(request: Request, env: CursorEnv): string | undefined {
  const origin = env.STOA_ORIGIN;
  if (!origin || !isTrustedStoaOrigin(origin) || typeof env.DB !== "object" || env.DB === null)
    return undefined;
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    url.pathname !== "/cursor" ||
    url.search !== "" ||
    !["GET", "HEAD"].includes(request.method) ||
    [
      "authorization",
      "cookie",
      "asimp-protocol-version",
      "range",
      "if-match",
      "if-unmodified-since",
    ].some((header) => request.headers.has(header))
  )
    return undefined;
  return origin;
}

async function boundedBody(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let body = "";
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const item = await reader.read();
      if (signal?.aborted) return undefined;
      if (item.done) return body + decoder.decode();
      bytes += item.value.byteLength;
      if (bytes > BODY_LIMIT) return undefined;
      body += decoder.decode(item.value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    signal?.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function snapshot(
  response: Response,
  observedAt: number,
  generation: number,
  signal?: AbortSignal,
): Promise<Snapshot | undefined> {
  if (
    response.status !== 200 ||
    response.headers.has("set-cookie") ||
    response.headers.get("content-type") !== "text/plain; charset=utf-8" ||
    response.headers.get("cache-control") !== "public, max-age=5" ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return undefined;
  const body = await boundedBody(response, signal);
  if (
    body === undefined ||
    !/^(?:0|[1-9][0-9]{0,15})$/.test(body) ||
    !Number.isSafeInteger(Number(body)) ||
    response.headers.get("etag") !== (await cursorEtag(body))
  ) {
    return undefined;
  }
  const headers: [string, string][] = [];
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.push([name, value]);
  }
  return { body, headers, observedAt, generation };
}

function asResponse(value: Snapshot, request: Request, now: number): Response {
  const headers = new Headers(value.headers.map(([name, field]) => [name, field]));
  // Round age upward, so a response near expiry never gains another second
  // of browser freshness. Cache entries also have an absolute five-second cap.
  headers.set("age", String(Math.max(0, Math.ceil((now - value.observedAt) / 1_000))));
  // Cache API storage is explicit and bounded above. Do not also retain the
  // signal in a browser: its automatic conditional GET would force a fresh
  // D1 read on every poll. Callers that explicitly send a validator still get
  // authoritative conditional semantics, including after moderation changes.
  headers.set("cache-control", "no-store");
  const etag = headers.get("etag") ?? "";
  if (cursorEtagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : value.body, { headers });
}

/** Cache only the opaque global integer, never a public scientific face or a
 * private scope. A cache hit matching a caller's validator is re-read from D1:
 * a cached cursor cannot issue a false 304 after a moderation change.
 *
 * Scope keys include an opaque per-D1-capability token. Equal origins/keys do
 * not authorize sharing between two database handles. This deliberately gives
 * up cross-isolate cache reuse until deployment has a stable binding identity.
 * Other isolates and missed purges converge within the absolute five-second
 * age bound; per-problem reads always perform their own disclosure checks. */
export function createPublicCursorCache(
  options: {
    readonly cache?: () => Promise<PublicCursorCache | undefined>;
    readonly now?: () => number;
  } = {},
) {
  const states = new WeakMap<object, Map<string, Scope>>();
  const cacheProvider = options.cache ?? providerCache;
  const now = options.now ?? Date.now;

  function scope(env: CursorEnv, origin: string): Scope {
    let origins = states.get(env.DB);
    if (!origins) {
      origins = new Map();
      states.set(env.DB, origins);
    }
    let state = origins.get(origin);
    if (!state) {
      state = {
        key: new Request(`${origin}/cursor?__asimp_cursor_cache_v1=${crypto.randomUUID()}`),
        generation: 0,
      };
      origins.set(origin, state);
    }
    return state;
  }

  async function cacheOrUndefined(): Promise<PublicCursorCache | undefined> {
    try {
      return await cacheOperation(() => cacheProvider());
    } catch {
      return undefined;
    }
  }

  return {
    async fetch(
      request: Request,
      env: CursorEnv,
      next: (request: Request) => Promise<Response>,
    ): Promise<Response> {
      const origin = cacheOrigin(request, env);
      if (origin === undefined) return next(request);
      if (
        request.cache === "no-store" ||
        /(?:^|,)\s*no-store\s*(?:,|$)/i.test(request.headers.get("cache-control") ?? "")
      ) {
        // An explicit no-store request neither reads nor populates Cache API.
        // Retire a prior local snapshot without I/O so a later normal poll
        // cannot regress behind the authoritative value this read observes.
        const previous = states.get(env.DB)?.get(origin);
        if (previous) {
          previous.generation++;
          previous.pending = undefined;
        }
        return next(request);
      }
      const cache = await cacheOrUndefined();
      if (!cache) return next(request);
      const state = scope(env, origin);
      const generation = state.generation;
      const forceRevalidate =
        ["reload", "no-cache"].includes(request.cache) ||
        /(?:^|,)\s*(?:no-cache|max-age=0)(?:\s*(?:,|$))/i.test(
          request.headers.get("cache-control") ?? "",
        ) ||
        request.headers.has("pragma");
      if (!forceRevalidate) {
        try {
          const value = await cacheOperation(async (signal) => {
            const cached = await cache.match(state.key);
            if (!cached) return undefined;
            if (signal.aborted) {
              void cached.body?.cancel().catch(() => {});
              return undefined;
            }
            const observed = cached.headers.get(OBSERVED_AT);
            const storedGeneration = cached.headers.get(GENERATION);
            return observed !== null && storedGeneration !== null
              ? snapshot(cached, Number(observed), Number(storedGeneration), signal)
              : undefined;
          });
          if (value) {
            const age = value === undefined ? -1 : now() - value.observedAt;
            if (
              value &&
              value.generation === state.generation &&
              generation === state.generation &&
              age >= 0 &&
              age < PUBLIC_CURSOR_CACHE_MAX_AGE_MS &&
              !cursorEtagMatches(
                request.headers.get("if-none-match"),
                new Headers(value.headers.map(([k, v]) => [k, v])).get("etag") ?? "",
              )
            ) {
              return asResponse(value, request, now());
            }
          }
        } catch {
          /* Cache failure is a miss, never authority for an error. */
        }
      }

      let pending = state.pending;
      if (!pending) {
        const readGeneration = state.generation;
        const observedAt = now();
        const headers = new Headers(request.headers);
        headers.delete("if-none-match");
        headers.delete("if-modified-since");
        const canonical = new Request(`${origin}/cursor`, { method: "GET", headers });
        pending = (async () => {
          const response = await next(canonical);
          if (response.status !== 200) return response;
          let value = await snapshot(response, observedAt, readGeneration);
          if (!value) return cursorUnavailable();
          if (
            state.generation === readGeneration &&
            now() - observedAt < PUBLIC_CURSOR_CACHE_MAX_AGE_MS
          ) {
            const storedHeaders = new Headers(value.headers.map(([key, field]) => [key, field]));
            storedHeaders.set(OBSERVED_AT, String(observedAt));
            storedHeaders.set(GENERATION, String(readGeneration));
            try {
              const storedResponse = new Response(value.body, { headers: storedHeaders });
              await cacheOperation(() => cache.put(state.key, storedResponse));
            } catch {
              // A timed-out put may finish after a later fill. Fence its old
              // generation before returning so it cannot overwrite newer
              // authority. A concurrent mutation retains its stronger fence.
              if (state.generation === readGeneration) {
                state.generation++;
                value = { ...value, generation: state.generation };
              }
            }
          }
          return value;
        })();
        state.pending = pending;
        const selected = pending;
        void pending
          .finally(() => {
            if (state.pending === selected) state.pending = undefined;
          })
          .catch(() => {});
      }
      const value = await pending;
      if (!(value instanceof Response) && value.generation !== state.generation) {
        // The authority changed while this read was in flight. In particular,
        // never turn that pre-write snapshot into a post-write 304.
        return next(request);
      }
      return value instanceof Response
        ? new Response(value.clone().body, {
            status: value.status,
            statusText: value.statusText,
            headers: [...value.headers],
          })
        : asResponse(value, request, now());
    },

    /** Invalidate after every mutation attempt, including partial batches whose
     * final response failed. It never advances the cursor or touches D1. Bump
     * the generation before awaiting I/O so an older in-flight fill cannot
     * resurrect a value after this write, even if Cache.delete fails. */
    async invalidate(env: CursorEnv): Promise<void> {
      const origins = states.get(env.DB);
      if (!origins) return;
      for (const state of origins.values()) {
        state.generation++;
        state.pending = undefined;
      }
      const cache = await cacheOrUndefined();
      if (!cache) return;
      await Promise.all(
        [...origins.values()].map(async (state) => {
          try {
            await cacheOperation(() => cache.delete(state.key));
          } catch {
            /* Absolute expiry remains the fallback. */
          }
        }),
      );
    },
  };
}

export const publicCursorCache = createPublicCursorCache();
