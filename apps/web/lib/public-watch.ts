import {
  parsePublicWatchCursor,
  PUBLIC_WATCH_INTERVAL_MS,
  PUBLIC_WATCH_MAX_BACKOFF_MS,
  PUBLIC_WATCH_MAX_REFRESH_ATTEMPTS,
  PUBLIC_WATCH_REQUEST_TIMEOUT_MS,
  publicWatchEtag,
  publicWatchOrigin,
  publicWatchRetryAfter,
  type PublicWatchTarget,
  validPublicWatchTargets,
} from "@asimposium/contracts/public-watch";

/** Reconcile visibility/redaction even when no public append moves the cursor. */
export const PUBLIC_WATCH_RECONCILE_POLLS = 6;

export type PublicWatchStatus =
  | "checking" | "current" | "refreshing" | "update-available" | "paused" | "unavailable";
export interface PublicWatchState {
  readonly status: PublicWatchStatus;
  readonly reason?: "configuration" | "http" | "invalid_response" | "timeout" | "network";
}

type Timer = ReturnType<typeof setTimeout>;
export type PublicWatchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface PublicWatchRuntime {
  readonly fetch: PublicWatchFetch;
  readonly setTimer: (callback: () => void, delay: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
  readonly random: () => number;
}
const browserRuntime: PublicWatchRuntime = {
  fetch: (...args) => fetch(...args),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
  random: () => Math.random(),
};

type ReadFailure = NonNullable<PublicWatchState["reason"]> | "cancelled";
class WatchReadError extends Error {
  constructor(readonly reason: ReadFailure, readonly retryAfter?: number) {
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
    controller.signal.addEventListener("abort", () => {
      void reader?.cancel().catch(() => undefined);
      reject(new WatchReadError(abortReason));
    }, { once: true });
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
      headers: { accept: method === "GET" ? "text/plain" : "application/json",
        ...(etag === undefined ? {} : { "if-none-match": etag }) },
      credentials: "omit", mode: "cors", redirect: "error", cache: "no-cache",
      referrerPolicy: "no-referrer", signal: controller.signal,
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
      const cursor = parsePublicWatchCursor(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      if (cursor === undefined) throw new WatchReadError("invalid_response");
      return { ...result, cursor };
    } finally { reader?.releaseLock(); }
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
  private cursorEtag: string | undefined;
  private checkedCursor: number | undefined;
  private quietPolls = 0;
  private pendingChange: string | undefined;
  private refreshAttempts = 0;
  private failures = 0;
  private state: PublicWatchState | undefined;

  constructor(private readonly options: PublicWatchOptions) {
    this.runtime = options.runtime ?? browserRuntime;
    this.targets = options.targets.map((target) => ({ ...target }));
    this.configured = publicWatchOrigin(options.origin) && validPublicWatchTargets(this.targets);
  }

  start(active = true): void {
    if (this.running) return;
    this.running = true;
    this.active = active;
    if (!this.configured) { this.emit({ status: "unavailable", reason: "configuration" }); return; }
    if (!active) { this.emit({ status: "paused" }); return; }
    this.emit({ status: "checking" });
    void this.poll();
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
    if (!active) { this.emit({ status: "paused" }); return; }
    this.forceProbe = true;
    this.immediate = true;
    if (!this.polling) { this.immediate = false; void this.poll(); }
  }

  /** Called only with validators obtained from freshly rendered server data. */
  replaceTargets(targets: readonly PublicWatchTarget[]): void {
    this.targets = targets.map((target) => ({ ...target }));
    this.configured = publicWatchOrigin(this.options.origin) && validPublicWatchTargets(this.targets);
    this.pendingChange = undefined;
    this.refreshAttempts = 0;
    this.failures = 0;
    this.checkNow();
  }

  checkNow(): void {
    this.invalidate();
    this.forceProbe = true;
    this.refreshAttempts = 0;
    if (!this.running) return;
    if (!this.configured) { this.emit({ status: "unavailable", reason: "configuration" }); return; }
    this.immediate = true;
    if (this.active && !this.polling) { this.immediate = false; void this.poll(); }
  }

  private invalidate(): void {
    this.generation++;
    this.controller?.abort();
    if (this.timer !== undefined) this.runtime.clearTimer(this.timer);
    this.timer = undefined;
  }

  private emit(state: PublicWatchState): void {
    if (!this.running || (this.state?.status === state.status && this.state.reason === state.reason)) return;
    this.state = state;
    this.options.onState(state);
  }

  private schedule(delay: number): void {
    if (!this.running || !this.active || !this.configured) return;
    const jitter = Math.floor(Math.max(0, Math.min(1, this.runtime.random())) * 1_000);
    this.timer = this.runtime.setTimer(() => {
      this.timer = undefined;
      void this.poll();
    }, delay === 0 ? 0 : Math.min(PUBLIC_WATCH_MAX_BACKOFF_MS, delay + jitter));
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
      const global = await read(this.runtime, `${this.options.origin}/cursor`, "GET", this.cursorEtag, controller.signal);
      if (!valid()) return;
      if (global.status === 200) {
        this.cursorValue = global.cursor;
        this.cursorEtag = global.etag;
      }
      const cursor = this.cursorValue;
      if (cursor === undefined) throw new WatchReadError("invalid_response");
      // Inequality, not >: cache rollback/reset is a reason to revalidate, not
      // a reason to suppress updates until an old high-water mark is reached.
      this.quietPolls++;
      if (this.forceProbe || cursor !== this.checkedCursor || this.pendingChange !== undefined ||
        this.quietPolls >= PUBLIC_WATCH_RECONCILE_POLLS) {
        this.quietPolls = 0;
        let changed: string | undefined;
        for (const target of this.targets) {
          const probe = await read(this.runtime, `${this.options.origin}${target.path}`, "HEAD", target.etag, controller.signal);
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
      delay = Math.min(PUBLIC_WATCH_MAX_BACKOFF_MS,
        Math.max(failure.retryAfter ?? 0, PUBLIC_WATCH_INTERVAL_MS * 2 ** Math.min(this.failures, 4)));
      this.emit({ status: "unavailable", reason: failure.reason });
    } finally {
      this.polling = false;
      if (this.controller === controller) this.controller = undefined;
      if (this.running && this.active && this.configured) {
        const immediate = this.immediate;
        this.immediate = false;
        this.schedule(immediate ? 0 : delay);
      }
    }
  }
}
