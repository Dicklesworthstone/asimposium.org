import {
  SponsorIdSchema,
  SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES,
  SponsorWorkshopCursorRequestSchema,
  SponsorWorkshopCursorResponseSchema,
} from "@asimposium/contracts";

export const WORKSHOP_WATCH_INTERVAL_MS = 3_000;
export const WORKSHOP_WATCH_TIMEOUT_MS = 8_000;
export const WORKSHOP_WATCH_MAX_BACKOFF_MS = 60_000;
export const WORKSHOP_WATCH_MAX_REFRESHES = 3;

export interface WorkshopWatchState {
  readonly status:
    | "checking"
    | "current"
    | "refreshing"
    | "update-available"
    | "paused"
    | "unavailable"
    | "access-ended";
}
type Timer = ReturnType<typeof setTimeout>;
export interface WorkshopWatchRuntime {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly setTimer: (callback: () => void, delay: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
  readonly random: () => number;
}
const browserRuntime: WorkshopWatchRuntime = {
  fetch: (...args) => fetch(...args),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
  random: () => Math.random(),
};

export interface WorkshopWatchOptions {
  readonly sponsorId: string;
  readonly fellowId: string;
  readonly problemId: string;
  /** Only the newest server-rendered page supplies a baseline. Older pages
   * watch for later changes without replacing the reader's selected page. */
  readonly renderedCursor?: number;
  readonly onState: (state: WorkshopWatchState) => void;
  readonly onRefresh: (reason: "change" | "access") => boolean | void;
  readonly runtime?: WorkshopWatchRuntime;
}

class CursorReadError extends Error {
  constructor(
    readonly reason: "unavailable" | "cancelled" | "access",
    readonly retryAfter = 0,
  ) {
    super("WORKSHOP_CURSOR_UNAVAILABLE");
  }
}

/** One same-origin, cookie-authenticated read of a small cursor envelope. Its
 * deadline covers both headers and streamed bytes, including transports that
 * ignore abort. Neither the browser nor this helper receives a Fellow token. */
async function readCursor(
  options: WorkshopWatchOptions,
  runtime: WorkshopWatchRuntime,
  parent: AbortSignal,
): Promise<number> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort();
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        void reader?.cancel().catch(() => undefined);
        reject(new CursorReadError(parent.aborted ? "cancelled" : "unavailable"));
      },
      { once: true },
    );
  });
  parent.addEventListener("abort", abort, { once: true });
  const timer = runtime.setTimer(abort, WORKSHOP_WATCH_TIMEOUT_MS);
  if (parent.aborted) abort();
  const operation = async () => {
    if (controller.signal.aborted) throw new CursorReadError("cancelled");
    const path = `/console/workshop/${encodeURIComponent(options.fellowId)}/${encodeURIComponent(options.problemId)}/cursor`;
    const response = await runtime.fetch(path, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new CursorReadError("cancelled");
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      if ([401, 403, 404].includes(response.status)) throw new CursorReadError("access");
      const delay = response.headers.get("retry-after");
      throw new CursorReadError(
        "unavailable",
        delay !== null && /^\d+$/.test(delay)
          ? Math.min(WORKSHOP_WATCH_MAX_BACKOFF_MS, Number(delay) * 1_000)
          : 0,
      );
    }
    const declared = response.headers.get("content-length");
    if (
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "") ||
      (declared !== null &&
        /^\d+$/.test(declared) &&
        Number(declared) > SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new CursorReadError("unavailable");
    }
    reader = response.body?.getReader();
    const bytes = new Uint8Array(SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES);
    let length = 0;
    try {
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (controller.signal.aborted) throw new CursorReadError("cancelled");
          if (part.done) break;
          if (length + part.value.byteLength > bytes.byteLength) {
            void reader.cancel().catch(() => undefined);
            throw new CursorReadError("unavailable");
          }
          bytes.set(part.value, length);
          length += part.value.byteLength;
        }
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      const result = SponsorWorkshopCursorResponseSchema.safeParse(JSON.parse(decoded));
      if (
        !result.success ||
        result.data.fellow_id !== options.fellowId ||
        result.data.problem_id !== options.problemId
      )
        throw new CursorReadError("unavailable");
      // An account change may legitimately produce another sponsor's response.
      // It cannot acknowledge or update the previous sponsor's rendered page.
      if (result.data.sponsor_id !== options.sponsorId) throw new CursorReadError("access");
      return result.data.workshop_cursor;
    } finally {
      reader?.releaseLock();
    }
  };
  try {
    return await Promise.race([operation(), stopped]);
  } catch (error) {
    if (parent.aborted) throw new CursorReadError("cancelled");
    if (error instanceof CursorReadError) throw error;
    throw new CursorReadError("unavailable");
  } finally {
    runtime.clearTimer(timer);
    parent.removeEventListener("abort", abort);
  }
}

/** Cursor checks do not acknowledge new rendered work. Only new server props
 * supply that baseline; a failed refresh remains pending with bounded retries.
 * Every poll rechecks ownership, even when the workshop is idle. */
export class WorkshopWatch {
  private readonly runtime: WorkshopWatchRuntime;
  private readonly configured: boolean;
  private running = false;
  private active = true;
  private polling = false;
  private generation = 0;
  private timer: Timer | undefined;
  private controller: AbortController | undefined;
  private historyCursor: number | undefined;
  private pendingCursor: number | undefined;
  private refreshes = 0;
  private failures = 0;
  private accessEnded = false;
  private state: WorkshopWatchState["status"] | undefined;

  constructor(private readonly options: WorkshopWatchOptions) {
    this.runtime = options.runtime ?? browserRuntime;
    this.configured =
      SponsorIdSchema.safeParse(options.sponsorId).success &&
      SponsorWorkshopCursorRequestSchema.safeParse({
        fellow_id: options.fellowId,
        problem_id: options.problemId,
      }).success &&
      (options.renderedCursor === undefined ||
        (Number.isSafeInteger(options.renderedCursor) && options.renderedCursor >= 0));
  }

  start(active = true): void {
    if (this.running) return;
    this.running = true;
    this.active = active;
    if (!this.configured) {
      this.emit("unavailable");
      return;
    }
    if (!active) {
      this.emit("paused");
      return;
    }
    this.emit("checking");
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
    if (!this.running || !this.configured || this.accessEnded) return;
    if (!active) {
      this.emit("paused");
      return;
    }
    this.emit("checking");
    void this.poll();
  }

  private invalidate(): void {
    this.generation++;
    this.controller?.abort();
    if (this.timer !== undefined) this.runtime.clearTimer(this.timer);
    this.timer = undefined;
  }

  private emit(status: WorkshopWatchState["status"]): void {
    if (!this.running || this.state === status) return;
    this.state = status;
    this.options.onState({ status });
  }

  private changed(cursor: number): void {
    if (this.options.renderedCursor === undefined) {
      this.historyCursor ??= cursor;
      this.emit(cursor === this.historyCursor ? "current" : "update-available");
      return;
    }
    if (cursor === this.options.renderedCursor) {
      this.pendingCursor = undefined;
      this.refreshes = 0;
      this.emit("current");
      return;
    }
    if (cursor !== this.pendingCursor) {
      this.pendingCursor = cursor;
      this.refreshes = 0;
    }
    if (this.refreshes >= WORKSHOP_WATCH_MAX_REFRESHES) {
      this.emit("update-available");
    } else if (this.options.onRefresh("change") === false) {
      this.emit("update-available");
    } else {
      this.refreshes++;
      this.emit("refreshing");
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.active || !this.configured || this.polling || this.accessEnded)
      return;
    this.polling = true;
    const generation = this.generation;
    this.controller = new AbortController();
    let delay = WORKSHOP_WATCH_INTERVAL_MS;
    try {
      const cursor = await readCursor(this.options, this.runtime, this.controller.signal);
      if (generation !== this.generation || !this.running || !this.active) return;
      this.failures = 0;
      this.changed(cursor);
    } catch (error) {
      if (generation !== this.generation || !this.running || !this.active) return;
      if (error instanceof CursorReadError && error.reason === "access") {
        this.accessEnded = true;
        this.emit("access-ended");
        this.options.onRefresh("access");
        return;
      }
      this.failures++;
      delay = Math.min(
        WORKSHOP_WATCH_MAX_BACKOFF_MS,
        Math.max(
          WORKSHOP_WATCH_INTERVAL_MS * 2 ** Math.min(this.failures, 5),
          error instanceof CursorReadError ? error.retryAfter : 0,
        ),
      );
      this.emit("unavailable");
    } finally {
      this.polling = false;
      this.controller = undefined;
      if (this.running && this.active && this.configured && !this.accessEnded) {
        if (generation !== this.generation) void this.poll();
        else {
          const jitter = Math.floor(Math.max(0, Math.min(1, this.runtime.random())) * 300);
          this.timer = this.runtime.setTimer(() => {
            this.timer = undefined;
            void this.poll();
          }, delay + jitter);
        }
      }
    }
  }
}

export function workshopWatchStatusText(state: WorkshopWatchState, olderPage: boolean): string {
  switch (state.status) {
    case "checking":
      return "Checking for workshop changes.";
    case "current":
      return olderPage
        ? "Watching for changes while you read this earlier page."
        : "No workshop change detected at the last check.";
    case "refreshing":
      return "New private work is available. Refreshing this view.";
    case "update-available":
      return olderPage
        ? "The workshop has changed. Open newest work when you are ready."
        : "The workshop has changed. Refresh this view when you are ready.";
    case "paused":
      return "Automatic workshop checks are paused.";
    case "unavailable":
      return "Live checks are unavailable. This is the last rendered workshop snapshot.";
    case "access-ended":
      return "Access to this workshop changed. Refresh or sign in again.";
  }
}
