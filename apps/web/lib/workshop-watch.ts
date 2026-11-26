import {
  SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES,
  SPONSOR_WORKSHOP_ROOM_TICKET_MAX_RESPONSE_BYTES,
  SponsorIdSchema,
  SponsorWorkshopCursorRequestSchema,
  SponsorWorkshopCursorResponseSchema,
  type SponsorWorkshopRoomTicketResponse,
  SponsorWorkshopRoomTicketResponseSchema,
} from "@asimposium/contracts";

export const WORKSHOP_WATCH_INTERVAL_MS = 3_000;
export const WORKSHOP_WATCH_TIMEOUT_MS = 8_000;
export const WORKSHOP_WATCH_MAX_BACKOFF_MS = 60_000;
export const WORKSHOP_WATCH_MAX_REFRESHES = 3;
export const WORKSHOP_WATCH_HEARTBEAT_MS = 20_000;

export type WorkshopWatchTransport = "ws" | "sse" | "poll";

export interface WorkshopWatchSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void,
  ): void;
}

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
  readonly openWebSocket?: (url: string, protocol: string) => WorkshopWatchSocket;
  /** Streamed fetch permits POST auth without placing a ticket in an EventSource URL. */
  readonly openSse?: (input: RequestInfo | URL, init: RequestInit) => Promise<Response>;
}
const browserRuntime: WorkshopWatchRuntime = {
  fetch: (...args) => fetch(...args),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
  random: () => Math.random(),
  openWebSocket:
    typeof WebSocket === "function" ? (url, protocol) => new WebSocket(url, protocol) : undefined,
  openSse: typeof ReadableStream === "function" ? (input, init) => fetch(input, init) : undefined,
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

/** Request a short-lived (60s), single-use Ed25519 workshop room ticket from
 * Agora's same-origin facade. The sponsor's host-only cookie never leaves
 * asimposium.org (S-6). Returns null on 503/unavailable so caller degrades to
 * same-origin cursor polling without unhandled errors. */
async function requestRoomTicket(
  options: WorkshopWatchOptions,
  runtime: WorkshopWatchRuntime,
  parent: AbortSignal,
): Promise<SponsorWorkshopRoomTicketResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new CursorReadError(parent.aborted ? "cancelled" : "unavailable")),
      { once: true },
    );
  });
  parent.addEventListener("abort", abort, { once: true });
  const timer = runtime.setTimer(abort, WORKSHOP_WATCH_TIMEOUT_MS);
  if (parent.aborted) abort();
  const operation = async (): Promise<SponsorWorkshopRoomTicketResponse> => {
    if (controller.signal.aborted) throw new CursorReadError("cancelled");
    const path = `/console/workshop/${encodeURIComponent(options.fellowId)}/${encodeURIComponent(options.problemId)}/room-ticket`;
    const response = await runtime.fetch(path, {
      method: "POST",
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
      throw new CursorReadError("unavailable");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > SPONSOR_WORKSHOP_ROOM_TICKET_MAX_RESPONSE_BYTES)
      throw new CursorReadError("unavailable");
    const parsed = SponsorWorkshopRoomTicketResponseSchema.safeParse(JSON.parse(text));
    if (
      !parsed.success ||
      parsed.data.fellow_id !== options.fellowId ||
      parsed.data.problem_id !== options.problemId
    )
      throw new CursorReadError("unavailable");
    if (parsed.data.sponsor_id !== options.sponsorId) throw new CursorReadError("access");
    return parsed.data;
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

function parseWorkshopNoticeCursor(
  raw: unknown,
  fellowId: string,
  problemId: string,
): number | undefined {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      control?: unknown;
      fellow_id?: unknown;
      problem_id?: unknown;
      workshop_cursor?: unknown;
    };
    if (
      parsed.control === "workshop-update" &&
      parsed.fellow_id === fellowId &&
      parsed.problem_id === problemId &&
      typeof parsed.workshop_cursor === "number" &&
      Number.isSafeInteger(parsed.workshop_cursor) &&
      parsed.workshop_cursor >= 0
    )
      return parsed.workshop_cursor;
  } catch {
    return undefined;
  }
  return undefined;
}

function workshopRoomUrl(roomUrl: string, options: WorkshopWatchOptions): URL {
  const url = new URL(roomUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "wss:" || (url.protocol === "ws:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/v1/workshop-room" ||
    [...url.searchParams.entries()].length !== 2 ||
    url.searchParams.get("fellow") !== options.fellowId ||
    url.searchParams.get("problem") !== options.problemId ||
    url.hash !== ""
  )
    throw new CursorReadError("unavailable");
  return url;
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
  private heartbeatTimer: Timer | undefined;
  private socketDeadlineTimer: Timer | undefined;
  private controller: AbortController | undefined;
  private socket: WorkshopWatchSocket | undefined;
  private liveTransport: WorkshopWatchTransport = "poll";
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

  get transport(): WorkshopWatchTransport {
    return this.liveTransport;
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
    this.startLiveOrPoll();
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
    this.startLiveOrPoll();
  }

  private closeSocket(): void {
    this.clearSocketDeadline();
    if (this.heartbeatTimer !== undefined) {
      this.runtime.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.socket !== undefined) {
      const sock = this.socket;
      this.socket = undefined;
      try {
        sock.close(1000, "Client paused");
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
    this.closeSocket();
  }

  private startLiveOrPoll(): void {
    if (this.runtime.openWebSocket !== undefined) {
      void this.connectWorkshopRoom();
      return;
    }
    this.startSseOrPoll();
  }

  private isCurrentSocket(sock: WorkshopWatchSocket, generation: number): boolean {
    return (
      this.running &&
      this.active &&
      !this.accessEnded &&
      this.generation === generation &&
      this.socket === sock
    );
  }

  private clearSocketDeadline(): void {
    if (this.socketDeadlineTimer !== undefined) {
      this.runtime.clearTimer(this.socketDeadlineTimer);
      this.socketDeadlineTimer = undefined;
    }
  }

  /** A socket must prove authorization, then answer each heartbeat with a pong
   * or scoped workshop activity. A silent connection may never emit close/error. */
  private armSocketDeadline(sock: WorkshopWatchSocket, generation: number): void {
    if (!this.isCurrentSocket(sock, generation)) return;
    this.clearSocketDeadline();
    this.socketDeadlineTimer = this.runtime.setTimer(() => {
      if (!this.isCurrentSocket(sock, generation)) return;
      this.socketDeadlineTimer = undefined;
      this.dropFromSocket(generation);
    }, WORKSHOP_WATCH_TIMEOUT_MS);
  }

  private scheduleHeartbeat(sock: WorkshopWatchSocket, generation: number): void {
    if (!this.isCurrentSocket(sock, generation)) return;
    if (this.heartbeatTimer !== undefined) this.runtime.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.runtime.setTimer(() => {
      if (!this.isCurrentSocket(sock, generation)) return;
      this.heartbeatTimer = undefined;
      try {
        this.armSocketDeadline(sock, generation);
        sock.send("ping");
        this.scheduleHeartbeat(sock, generation);
      } catch {
        this.dropFromSocket(generation);
      }
    }, WORKSHOP_WATCH_HEARTBEAT_MS);
  }

  private dropFromSocket(generation: number): void {
    if (!this.running || !this.active || this.accessEnded || this.generation !== generation) return;
    this.closeSocket();
    this.startSseOrPoll();
  }

  private startSseOrPoll(): void {
    if (this.runtime.openSse) {
      void this.connectWorkshopStream();
      return;
    }
    this.liveTransport = "poll";
    void this.poll();
  }

  private async connectWorkshopStream(): Promise<void> {
    const openSse = this.runtime.openSse;
    if (!openSse || !this.running || !this.active || this.accessEnded) return;
    this.liveTransport = "sse";
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let deadline: Timer | undefined;
    let lifetime: Timer | undefined;
    const armDeadline = (milliseconds: number) => {
      if (deadline !== undefined) this.runtime.clearTimer(deadline);
      deadline = this.runtime.setTimer(() => controller.abort(), milliseconds);
    };
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          void reader?.cancel().catch(() => undefined);
          reject(new CursorReadError("cancelled"));
        },
        { once: true },
      );
    });
    const current = () =>
      this.running &&
      this.active &&
      !this.accessEnded &&
      this.generation === generation &&
      !controller.signal.aborted;
    try {
      // A failed WebSocket may already have consumed its ticket. Every transport
      // attempt obtains a new capability through the same-origin sponsor facade.
      const minted = await Promise.race([
        requestRoomTicket(this.options, this.runtime, controller.signal),
        stopped,
      ]);
      if (!current()) return;
      const url = workshopRoomUrl(minted.room_url, this.options);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      armDeadline(WORKSHOP_WATCH_TIMEOUT_MS);
      const response = await Promise.race([
        openSse(url.toString(), {
          method: "POST",
          headers: { accept: "text/event-stream", "content-type": "application/json" },
          body: JSON.stringify({ auth: minted.ticket }),
          credentials: "omit",
          mode: "cors",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        }).then((result) => {
          if (!current()) void result.body?.cancel().catch(() => undefined);
          return result;
        }),
        stopped,
      ]);
      if (!current()) return;
      if (
        response.status !== 200 ||
        !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
        !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "") ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new CursorReadError("unavailable");
      }
      reader = response.body.getReader();
      this.liveTransport = "sse";
      lifetime = this.runtime.setTimer(
        () => controller.abort(),
        60_000 + WORKSHOP_WATCH_TIMEOUT_MS,
      );
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let bytes = 0;
      let authenticated = false;
      while (current()) {
        const part = await Promise.race([reader.read(), stopped]);
        if (!current() || part.done) return;
        bytes += part.value.byteLength;
        if (bytes > 128 * 1024) throw new CursorReadError("unavailable");
        buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, "\n");
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.length > 2176) throw new CursorReadError("unavailable");
          const lines = frame.split("\n");
          const event = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          if (event === "closed" || event === "reconnect") return;
          if (event === "workshop-update") {
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            const cursor = parseWorkshopNoticeCursor(
              data,
              this.options.fellowId,
              this.options.problemId,
            );
            if (cursor === undefined) throw new CursorReadError("unavailable");
            authenticated = true;
            this.failures = 0;
            this.changed(cursor);
          } else if (event !== undefined) throw new CursorReadError("unavailable");
        }
        if (buffer.length > 2176) throw new CursorReadError("unavailable");
        if (authenticated) armDeadline(WORKSHOP_WATCH_HEARTBEAT_MS + WORKSHOP_WATCH_TIMEOUT_MS);
      }
    } catch {
      // The same-origin cursor read owns the access-ended decision, including
      // ticket refusal, lost CORS/stream support, and silent transport failures.
    } finally {
      if (deadline !== undefined) this.runtime.clearTimer(deadline);
      if (lifetime !== undefined) this.runtime.clearTimer(lifetime);
      controller.abort();
      reader?.releaseLock();
      if (this.controller === controller) this.controller = undefined;
      if (this.running && this.active && !this.accessEnded && this.generation === generation) {
        this.liveTransport = "poll";
        void this.poll();
      }
    }
  }

  private async connectWorkshopRoom(): Promise<void> {
    const openWs = this.runtime.openWebSocket;
    if (!openWs || !this.running || !this.active || !this.configured || this.accessEnded) return;
    this.liveTransport = "ws";
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const minted = await requestRoomTicket(this.options, this.runtime, controller.signal);
      if (generation !== this.generation || !this.running || !this.active || this.accessEnded)
        return;
      const parsedUrl = workshopRoomUrl(minted.room_url, this.options);
      const sock = openWs(parsedUrl.toString(), "asimposium.room.v1");
      this.socket = sock;
      this.liveTransport = "ws";
      this.armSocketDeadline(sock, generation);
      let authenticated = false;
      let closed = false;
      const onDisconnect = () => {
        if (closed || !this.isCurrentSocket(sock, generation)) return;
        closed = true;
        this.dropFromSocket(generation);
      };
      sock.addEventListener("open", () => {
        if (!this.isCurrentSocket(sock, generation)) return;
        try {
          sock.send(JSON.stringify({ auth: minted.ticket }));
          this.scheduleHeartbeat(sock, generation);
        } catch {
          onDisconnect();
        }
      });
      sock.addEventListener("message", (event) => {
        if (!this.isCurrentSocket(sock, generation)) return;
        const data = (event as { data?: unknown })?.data;
        if (data === "pong") {
          // Hibernation auto-responses can precede ticket verification. Only
          // a scoped workshop notice establishes an authorized connection.
          if (authenticated) this.clearSocketDeadline();
          return;
        }
        const cursor = parseWorkshopNoticeCursor(
          data,
          this.options.fellowId,
          this.options.problemId,
        );
        if (cursor === undefined) return;
        authenticated = true;
        this.clearSocketDeadline();
        this.failures = 0;
        this.changed(cursor);
      });
      sock.addEventListener("error", onDisconnect);
      sock.addEventListener("close", onDisconnect);
    } catch {
      if (generation !== this.generation || !this.running || !this.active) return;
      // Optional WS ticket upgrade must never strand the workshop view in
      // access-ended on 403/404/503/network; degrade cleanly to authoritative
      // same-origin GET /cursor polling, which owns the access-ended decision.
      this.dropFromSocket(generation);
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
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
    const controller = new AbortController();
    this.controller = controller;
    let delay = WORKSHOP_WATCH_INTERVAL_MS;
    try {
      const cursor = await readCursor(this.options, this.runtime, controller.signal);
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
      if (this.controller === controller) this.controller = undefined;
      if (
        this.running &&
        this.active &&
        this.configured &&
        !this.accessEnded &&
        this.liveTransport === "poll"
      ) {
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
