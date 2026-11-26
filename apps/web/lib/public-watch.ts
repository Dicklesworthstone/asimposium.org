import { HERALD_ROOM_LIMITS, HERALD_ROOM_PROTOCOL } from "@asimposium/contracts/herald-room-model";
import {
  PUBLIC_WATCH_INTERVAL_MS,
  PUBLIC_WATCH_MAX_BACKOFF_MS,
  PUBLIC_WATCH_MAX_REFRESH_ATTEMPTS,
  PUBLIC_WATCH_REQUEST_TIMEOUT_MS,
  type PublicWatchTarget,
  parsePublicWatchCursor,
  publicWatchEtag,
  publicWatchOrigin,
  publicWatchRetryAfter,
  validPublicWatchTargets,
} from "@asimposium/contracts/public-watch";

/** Reconcile visibility/redaction even when no public append moves the cursor. */
export const PUBLIC_WATCH_RECONCILE_POLLS = 6;

export type PublicWatchStatus =
  | "checking"
  | "current"
  | "refreshing"
  | "update-available"
  | "paused"
  | "unavailable";
export interface PublicWatchState {
  readonly status: PublicWatchStatus;
  readonly reason?: "configuration" | "http" | "invalid_response" | "timeout" | "network";
}

type Timer = ReturnType<typeof setTimeout>;
export type PublicWatchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type PublicWatchTransport = "ws" | "sse" | "poll";

export interface PublicWatchSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void,
  ): void;
}
export interface PublicWatchEventSource {
  close(): void;
  addEventListener(
    type: "resync" | "reconnect" | "closed" | "error",
    listener: (event: unknown) => void,
  ): void;
}
export interface PublicWatchRuntime {
  readonly fetch: PublicWatchFetch;
  readonly setTimer: (callback: () => void, delay: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
  readonly random: () => number;
  readonly openWebSocket?: (url: string, protocol: string) => PublicWatchSocket;
  readonly openEventSource?: (url: string) => PublicWatchEventSource;
}
const browserRuntime: PublicWatchRuntime = {
  fetch: (...args) => fetch(...args),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
  random: () => Math.random(),
  openWebSocket:
    typeof WebSocket === "function" ? (url, protocol) => new WebSocket(url, protocol) : undefined,
  openEventSource:
    typeof EventSource === "function"
      ? (url) => new EventSource(url, { withCredentials: false })
      : undefined,
};

const HERALD_WS_HEARTBEAT_MS = HERALD_ROOM_LIMITS.heartbeatSeconds * 1_000;
const HERALD_WS_FALLBACK_COOLDOWN_MS = 30_000;

function singleProblemId(targets: readonly PublicWatchTarget[]): string | undefined {
  let found: string | undefined;
  for (const target of targets) {
    const match = /^\/p\/([^/.]+)(?:\.json|\/)/.exec(target.path);
    if (!match?.[1]) return undefined;
    if (found === undefined) found = match[1];
    else if (found !== match[1]) return undefined;
  }
  return found;
}

function wsUrlForOrigin(origin: string, path: string): string | undefined {
  try {
    const url = new URL(path, origin);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseResyncThrough(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const parsed = JSON.parse(raw) as { control?: unknown; through?: unknown };
    if (
      parsed.control === "resync" &&
      typeof parsed.through === "number" &&
      Number.isSafeInteger(parsed.through) &&
      parsed.through >= 0
    )
      return parsed.through;
  } catch {
    return undefined;
  }
  return undefined;
}

type ReadFailure = NonNullable<PublicWatchState["reason"]> | "cancelled";
class WatchReadError extends Error {
  constructor(
    readonly reason: ReadFailure,
    readonly retryAfter?: number,
  ) {
    super(`PUBLIC_WATCH_${reason.toUpperCase()}`);
  }
}
interface ReadResult {
  readonly status: number;
  readonly etag?: string;
  readonly cursor?: number;
}

/** One bounded public request. A deadline races BOTH headers and body reads;
 * abort-ignoring transports cannot strand the scheduler or deliver late UI
 * updates. No scientific body is parsed here. HEAD response bodies are retired
 * even when a server erroneously supplies one. */
async function read(
  runtime: PublicWatchRuntime,
  url: string,
  method: "GET" | "HEAD",
  etag: string | undefined,
  parent: AbortSignal,
): Promise<ReadResult> {
  const controller = new AbortController();
  let abortReason: ReadFailure = "cancelled";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort();
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        void reader?.cancel().catch(() => undefined);
        reject(new WatchReadError(abortReason));
      },
      { once: true },
    );
  });
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = runtime.setTimer(() => {
    abortReason = "timeout";
    controller.abort();
  }, PUBLIC_WATCH_REQUEST_TIMEOUT_MS);
  const operation = async (): Promise<ReadResult> => {
    if (controller.signal.aborted) throw new WatchReadError(abortReason);
    const response = await runtime.fetch(url, {
      method,
      headers: {
        accept: method === "GET" ? "text/plain" : "application/json",
        ...(etag === undefined ? {} : { "if-none-match": etag }),
      },
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      // The bare global signal has its own bounded Worker Cache API entry.
      // Scientific validators must still reach their disclosure checks.
      cache: method === "GET" ? "default" : "no-cache",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new WatchReadError(abortReason);
    }
    const tag = publicWatchEtag(response.headers.get("etag"));
    const result = { status: response.status, ...(tag === undefined ? {} : { etag: tag }) };
    if (response.status === 304) {
      void response.body?.cancel().catch(() => undefined);
      if (etag === undefined || tag !== etag) throw new WatchReadError("invalid_response");
      return result;
    }
    if (method === "HEAD" && (response.status === 404 || response.status === 410)) {
      void response.body?.cancel().catch(() => undefined);
      return result;
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      throw new WatchReadError("http", publicWatchRetryAfter(response.headers.get("retry-after")));
    }
    if (method === "HEAD") {
      void response.body?.cancel().catch(() => undefined);
      if (tag === undefined) throw new WatchReadError("invalid_response");
      return result;
    }
    // A decimal safe integer needs at most 16 ASCII bytes. Use a small hard
    // ceiling before decoding, including when Content-Length is absent/false.
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > 32) {
      void response.body?.cancel().catch(() => undefined);
      throw new WatchReadError("invalid_response");
    }
    reader = response.body?.getReader();
    const bytes = new Uint8Array(32);
    let size = 0;
    try {
      if (reader) {
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new WatchReadError(abortReason);
          if (chunk.done) break;
          if (size + chunk.value.byteLength > bytes.byteLength) {
            void reader.cancel().catch(() => undefined);
            throw new WatchReadError("invalid_response");
          }
          bytes.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
      }
      const cursor = parsePublicWatchCursor(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
      );
      if (cursor === undefined) throw new WatchReadError("invalid_response");
      return { ...result, cursor };
    } finally {
      reader?.releaseLock();
    }
  };
  try {
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (controller.signal.aborted) throw new WatchReadError(abortReason);
    if (error instanceof WatchReadError) throw error;
    throw new WatchReadError("network");
  } finally {
    runtime.clearTimer(timer);
    parent.removeEventListener("abort", abort);
  }
}

export interface PublicWatchOptions {
  readonly origin: string;
  readonly targets: readonly PublicWatchTarget[];
  readonly onState: (state: PublicWatchState) => void;
  /** Return false to defer while the user edits/selects text. A true/void
   * return requests a refresh; it does NOT acknowledge new rendered bytes. */
  readonly onRefresh: () => boolean | void;
  readonly runtime?: PublicWatchRuntime;
}

/** One cursor poller per rendered view, not one poller per claim card.
 * Between bounded withdrawal reconciliations, unchanged global cursors cause
 * no face request or route refresh. Changes
 * probe the exact rendered resources by HEAD/ETag, stopping at the first
 * mismatch. A refreshed server manifest is the ONLY acknowledgment; failed
 * refreshes cannot silently advance past unseen data. */
export class PublicLedgerWatch {
  private readonly runtime: PublicWatchRuntime;
  private targets: readonly PublicWatchTarget[];
  private configured: boolean;
  private running = false;
  private active = true;
  private polling = false;
  private generation = 0;
  private timer: Timer | undefined;
  private controller: AbortController | undefined;
  private immediate = false;
  private forceProbe = true;
  private cursorValue: number | undefined;
  private roomCursor = 0;
  private checkedCursor: number | undefined;
  private quietPolls = 0;
  private pendingChange: string | undefined;
  private refreshAttempts = 0;
  private failures = 0;
  private state: PublicWatchState | undefined;
  private socket: PublicWatchSocket | undefined;
  private eventSource: PublicWatchEventSource | undefined;
  private heartbeatTimer: Timer | undefined;
  private liveDeadline: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private liveTransport: PublicWatchTransport = "poll";

  constructor(private readonly options: PublicWatchOptions) {
    this.runtime = options.runtime ?? browserRuntime;
    this.targets = options.targets.map((target) => ({ ...target }));
    this.configured = publicWatchOrigin(options.origin) && validPublicWatchTargets(this.targets);
  }

  /** Active liveness transport: "ws" (Herald DO), "sse" (persistent fallback), or "poll". */
  get transport(): PublicWatchTransport {
    return this.liveTransport;
  }

  start(active = true): void {
    if (this.running) return;
    this.running = true;
    this.active = active;
    if (!this.configured) {
      this.emit({ status: "unavailable", reason: "configuration" });
      return;
    }
    if (!active) {
      this.emit({ status: "paused" });
      return;
    }
    this.emit({ status: "checking" });
    this.connectLiveOrPoll();
  }

  stop(): void {
    this.running = false;
    this.invalidate();
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.invalidate();
    if (!this.running || !this.configured) return;
    if (!active) {
      this.emit({ status: "paused" });
      return;
    }
    this.forceProbe = true;
    this.immediate = true;
    this.connectLiveOrPoll();
  }

  /** Called only with validators obtained from freshly rendered server data. */
  replaceTargets(targets: readonly PublicWatchTarget[]): void {
    const previousProblem = singleProblemId(this.targets);
    this.targets = targets.map((target) => ({ ...target }));
    this.configured =
      publicWatchOrigin(this.options.origin) && validPublicWatchTargets(this.targets);
    this.pendingChange = undefined;
    this.refreshAttempts = 0;
    this.failures = 0;
    const nextProblem = singleProblemId(this.targets);
    if (previousProblem !== nextProblem) {
      this.roomCursor = 0;
      this.invalidate();
      this.forceProbe = true;
      if (this.running && this.active && this.configured) {
        this.connectLiveOrPoll();
        return;
      }
    }
    // Keep an already-open live WS/SSE room alive across same-problem refreshes
    // (such as Next.js router.refresh()) instead of tearing it down to polling.
    if (
      this.running &&
      this.active &&
      this.configured &&
      (this.liveTransport === "ws" || this.liveTransport === "sse") &&
      previousProblem !== undefined &&
      previousProblem === nextProblem
    ) {
      this.forceProbe = true;
      if (!this.polling) void this.probeTargetsOnly(this.generation);
      return;
    }
    this.checkNow();
  }

  checkNow(): void {
    const keepLive =
      this.running &&
      this.active &&
      this.configured &&
      (this.liveTransport === "ws" || this.liveTransport === "sse");
    if (keepLive) {
      this.forceProbe = true;
      this.refreshAttempts = 0;
      if (!this.polling) void this.probeTargetsOnly(this.generation);
      return;
    }
    this.invalidate();
    this.forceProbe = true;
    this.refreshAttempts = 0;
    if (!this.running) return;
    if (!this.configured) {
      this.emit({ status: "unavailable", reason: "configuration" });
      return;
    }
    this.immediate = true;
    if (this.active && !this.polling) {
      this.immediate = false;
      void this.poll();
    }
  }

  private closeLiveTransports(): void {
    this.clearLiveDeadline();
    if (this.heartbeatTimer !== undefined) {
      this.runtime.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      this.runtime.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket !== undefined) {
      const sock = this.socket;
      this.socket = undefined;
      try {
        sock.close(1000, "Client paused");
      } catch {
        // Ignore close errors on already-closed sockets.
      }
    }
    if (this.eventSource !== undefined) {
      const es = this.eventSource;
      this.eventSource = undefined;
      try {
        es.close();
      } catch {
        // Ignore close errors.
      }
    }
    this.liveTransport = "poll";
  }

  private invalidate(): void {
    this.generation++;
    this.controller?.abort();
    if (this.timer !== undefined) this.runtime.clearTimer(this.timer);
    this.timer = undefined;
    this.closeLiveTransports();
  }

  private connectLiveOrPoll(): void {
    this.immediate = false;
    const problem = singleProblemId(this.targets);
    if (problem !== undefined && this.runtime.openWebSocket !== undefined) {
      if (this.tryOpenWebSocket(problem)) return;
    }
    if (problem !== undefined && this.runtime.openEventSource !== undefined) {
      if (this.tryOpenEventSource(problem)) return;
    }
    this.startPolling();
  }

  private startPolling(): void {
    this.forceProbe = true;
    this.liveTransport = "poll";
    this.immediate = this.polling;
    if (!this.polling) void this.poll();
  }

  private clearLiveDeadline(): void {
    if (this.liveDeadline !== undefined) this.runtime.clearTimer(this.liveDeadline);
    this.liveDeadline = undefined;
  }

  private armLiveDeadline(onTimeout: () => void, delay = PUBLIC_WATCH_REQUEST_TIMEOUT_MS): void {
    this.clearLiveDeadline();
    this.liveDeadline = this.runtime.setTimer(onTimeout, delay);
  }

  private scheduleHeartbeat(
    sock: PublicWatchSocket,
    generation: number,
    onFailure: () => void,
  ): void {
    if (this.heartbeatTimer !== undefined) this.runtime.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.runtime.setTimer(() => {
      if (!this.running || !this.active || this.generation !== generation || this.socket !== sock)
        return;
      try {
        this.armLiveDeadline(onFailure);
        sock.send("ping");
        this.scheduleHeartbeat(sock, generation, onFailure);
      } catch {
        onFailure();
      }
    }, HERALD_WS_HEARTBEAT_MS);
  }

  private tryOpenWebSocket(problem: string): boolean {
    const openWs = this.runtime.openWebSocket;
    if (!openWs) return false;
    const since = this.roomCursor;
    const url = wsUrlForOrigin(
      this.options.origin,
      `/p/${encodeURIComponent(problem)}/room?since=${since}`,
    );
    if (!url) return false;
    const generation = this.generation;
    let sock: PublicWatchSocket;
    try {
      sock = openWs(url, HERALD_ROOM_PROTOCOL);
    } catch {
      return false;
    }
    this.socket = sock;
    this.liveTransport = "ws";
    let receivedNotice = false;
    const failToNext = () => {
      if (this.socket !== sock) return;
      this.fallbackAfterWsFailure(generation);
    };
    // Establish liveness with the initial cursor notice, not merely an open socket.
    this.armLiveDeadline(failToNext);
    sock.addEventListener("open", () => {
      if (!this.running || !this.active || this.generation !== generation || this.socket !== sock)
        return;
      this.failures = 0;
      this.scheduleHeartbeat(sock, generation, failToNext);
    });
    sock.addEventListener("message", (event) => {
      if (!this.running || !this.active || this.generation !== generation || this.socket !== sock)
        return;
      const data = (event as { data?: unknown })?.data;
      if (data === "pong") {
        if (receivedNotice) this.clearLiveDeadline();
        return;
      }
      const through = parseResyncThrough(data);
      if (through === undefined) return;
      receivedNotice = true;
      this.clearLiveDeadline();
      try {
        sock.send(JSON.stringify({ ack: through }));
      } catch {
        failToNext();
        return;
      }
      this.roomCursor = through;
      this.forceProbe = true;
      if (!this.polling) void this.probeTargetsOnly(generation);
    });
    sock.addEventListener("error", failToNext);
    sock.addEventListener("close", failToNext);
    return true;
  }

  private fallbackAfterWsFailure(generation: number): void {
    if (!this.running || !this.active || this.generation !== generation) return;
    this.closeLiveTransports();
    const problem = singleProblemId(this.targets);
    if (problem !== undefined && this.runtime.openEventSource !== undefined) {
      if (this.tryOpenEventSource(problem)) return;
    }
    this.startPolling();
  }

  private tryOpenEventSource(problem: string): boolean {
    const openEs = this.runtime.openEventSource;
    if (!openEs) return false;
    const since = this.roomCursor;
    const url = `${this.options.origin}/p/${encodeURIComponent(problem)}/room/sse?since=${since}`;
    const generation = this.generation;
    let es: PublicWatchEventSource;
    try {
      es = openEs(url);
    } catch {
      return false;
    }
    this.eventSource = es;
    this.liveTransport = "sse";
    let receivedNotice = false;
    const dropToPolling = () => {
      if (this.eventSource !== es) return;
      this.closeLiveTransports();
      this.startPolling();
    };
    this.armLiveDeadline(dropToPolling);
    es.addEventListener("resync", (event) => {
      if (
        !this.running ||
        !this.active ||
        this.generation !== generation ||
        this.eventSource !== es
      )
        return;
      const through = parseResyncThrough((event as { data?: unknown })?.data);
      if (through === undefined) return;
      if (!receivedNotice) {
        receivedNotice = true;
        // EventSource hides keepalive comments. Even a quiet stream sends a
        // terminal event at the server's lifetime limit.
        this.armLiveDeadline(
          dropToPolling,
          HERALD_ROOM_LIMITS.sseLifetimeMs + PUBLIC_WATCH_REQUEST_TIMEOUT_MS,
        );
      }
      this.roomCursor = through;
      this.forceProbe = true;
      if (!this.polling) void this.probeTargetsOnly(generation);
    });
    es.addEventListener("closed", dropToPolling);
    es.addEventListener("reconnect", () => {
      if (this.eventSource !== es) return;
      this.closeLiveTransports();
      this.reconnectTimer = this.runtime.setTimer(() => {
        this.reconnectTimer = undefined;
        if (this.running && this.active && this.generation === generation) {
          this.connectLiveOrPoll();
        }
      }, HERALD_WS_FALLBACK_COOLDOWN_MS);
      this.forceProbe = true;
      if (!this.polling) void this.probeTargetsOnly(generation);
    });
    es.addEventListener("error", dropToPolling);
    return true;
  }

  /** Authoritative HEAD/ETag check triggered by a live WS or SSE push notice.
   * Never reschedules the /cursor poll loop while a live transport owns liveness. */
  private async probeTargetsOnly(generation: number): Promise<void> {
    if (!this.running || !this.active || !this.configured || this.polling) return;
    this.polling = true;
    const controller = new AbortController();
    this.controller = controller;
    const valid = () => this.running && this.active && generation === this.generation;
    // Clear before awaiting HEAD so any concurrent WS/SSE push or replaceTargets
    // arriving during flight flips forceProbe back to true and triggers a follow-up probe.
    this.forceProbe = false;
    try {
      let changed: string | undefined;
      for (const target of this.targets) {
        const probe = await read(
          this.runtime,
          `${this.options.origin}${target.path}`,
          "HEAD",
          target.etag,
          controller.signal,
        );
        if (!valid()) return;
        if (probe.status !== 304 && (probe.status !== 200 || probe.etag !== target.etag)) {
          changed = `${target.path}\n${probe.status}\n${probe.etag ?? ""}`;
          break;
        }
      }
      if (changed === undefined) {
        this.pendingChange = undefined;
        this.refreshAttempts = 0;
        this.emit({ status: "current" });
      } else {
        if (changed !== this.pendingChange) this.refreshAttempts = 0;
        this.pendingChange = changed;
        if (this.refreshAttempts >= PUBLIC_WATCH_MAX_REFRESH_ATTEMPTS) {
          this.emit({ status: "update-available" });
        } else if (this.options.onRefresh() === false) {
          this.emit({ status: "update-available" });
        } else {
          this.refreshAttempts++;
          this.emit({ status: "refreshing" });
        }
      }
      this.failures = 0;
    } catch (error) {
      if (!valid()) return;
      const failure = error instanceof WatchReadError ? error : new WatchReadError("network");
      if (failure.reason === "cancelled") return;
      this.failures++;
      this.emit({ status: "unavailable", reason: failure.reason });
    } finally {
      this.polling = false;
      if (this.controller === controller) this.controller = undefined;
      if (this.running && this.active && this.configured) {
        if (this.liveTransport === "poll" && this.immediate) {
          this.immediate = false;
          void this.poll();
        } else if (this.liveTransport !== "poll" && this.forceProbe) {
          void this.probeTargetsOnly(this.generation);
        }
      }
    }
  }

  private emit(state: PublicWatchState): void {
    if (
      !this.running ||
      (this.state?.status === state.status && this.state.reason === state.reason)
    )
      return;
    this.state = state;
    this.options.onState(state);
  }

  private schedule(delay: number): void {
    if (!this.running || !this.active || !this.configured) return;
    const jitter = Math.floor(Math.max(0, Math.min(1, this.runtime.random())) * 1_000);
    this.timer = this.runtime.setTimer(
      () => {
        this.timer = undefined;
        void this.poll();
      },
      delay === 0 ? 0 : Math.min(PUBLIC_WATCH_MAX_BACKOFF_MS, delay + jitter),
    );
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.active || !this.configured || this.polling) return;
    this.polling = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const valid = () => this.running && this.active && generation === this.generation;
    let delay = PUBLIC_WATCH_INTERVAL_MS;
    try {
      // Fetch the tiny integer without a conditional validator. Stoa keeps it
      // for at most five seconds in its explicit cache; a matching conditional
      // validator instead asks Stoa for an authoritative D1 revalidation.
      const global = await read(
        this.runtime,
        `${this.options.origin}/cursor`,
        "GET",
        undefined,
        controller.signal,
      );
      if (!valid()) return;
      if (global.status === 200) {
        this.cursorValue = global.cursor;
      }
      const cursor = this.cursorValue;
      if (cursor === undefined) throw new WatchReadError("invalid_response");
      // Inequality, not >: cache rollback/reset is a reason to revalidate, not
      // a reason to suppress updates until an old high-water mark is reached.
      this.quietPolls++;
      if (
        this.forceProbe ||
        cursor !== this.checkedCursor ||
        this.pendingChange !== undefined ||
        this.quietPolls >= PUBLIC_WATCH_RECONCILE_POLLS
      ) {
        this.quietPolls = 0;
        let changed: string | undefined;
        for (const target of this.targets) {
          const probe = await read(
            this.runtime,
            `${this.options.origin}${target.path}`,
            "HEAD",
            target.etag,
            controller.signal,
          );
          if (!valid()) return;
          if (probe.status !== 304 && (probe.status !== 200 || probe.etag !== target.etag)) {
            changed = `${target.path}\n${probe.status}\n${probe.etag ?? ""}`;
            break;
          }
        }
        this.forceProbe = false;
        this.checkedCursor = cursor;
        if (changed === undefined) {
          this.pendingChange = undefined;
          this.refreshAttempts = 0;
          this.emit({ status: "current" });
        } else {
          if (changed !== this.pendingChange) this.refreshAttempts = 0;
          this.pendingChange = changed;
          if (this.refreshAttempts >= PUBLIC_WATCH_MAX_REFRESH_ATTEMPTS) {
            this.emit({ status: "update-available" });
          } else if (this.options.onRefresh() === false) {
            this.emit({ status: "update-available" });
          } else {
            this.refreshAttempts++;
            this.emit({ status: "refreshing" });
          }
        }
      } else {
        this.emit({ status: "current" });
      }
      this.failures = 0;
    } catch (error) {
      if (!valid()) return;
      const failure = error instanceof WatchReadError ? error : new WatchReadError("network");
      if (failure.reason === "cancelled") return;
      this.failures++;
      this.forceProbe = true;
      delay = Math.min(
        PUBLIC_WATCH_MAX_BACKOFF_MS,
        Math.max(
          failure.retryAfter ?? 0,
          PUBLIC_WATCH_INTERVAL_MS * 2 ** Math.min(this.failures, 4),
        ),
      );
      this.emit({ status: "unavailable", reason: failure.reason });
    } finally {
      this.polling = false;
      if (this.controller === controller) this.controller = undefined;
      if (this.running && this.active && this.configured && this.liveTransport === "poll") {
        const immediate = this.immediate;
        this.immediate = false;
        this.schedule(immediate ? 0 : delay);
      } else if (this.running && this.active && this.configured && this.forceProbe) {
        void this.probeTargetsOnly(this.generation);
      }
    }
  }
}
