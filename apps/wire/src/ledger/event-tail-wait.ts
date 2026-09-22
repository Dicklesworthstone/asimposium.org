import {
  EVENT_TAIL_MAX_WAIT_SECONDS,
  type EventTailQuery,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import {
  type EventTailDatabase,
  EventTailReadError,
  readPublicEventTail,
} from "./event-tail-read.ts";

/** W7.3 polling fallback. These are admission limits per Worker isolate, not
 * durable per-Fellow quotas or a claim of cross-isolate coordination. Only
 * counters are shared: timers, promises, D1 I/O and response data stay in the
 * request that owns them (Workers cannot share request-scoped I/O).
 */
export const EVENT_WAIT_LIMITS = {
  total: 64,
  perProblem: 8,
  probeIntervalMs: 5_000,
  readTimeoutMs: 5_000,
  admissionTtlMs: 35_000,
} as const;

export type EventWaitOutcome = "immediate" | "changed" | "timeout" | "capacity";

export class EventWaitAdmission {
  private readonly active = new Map<symbol, {
    binding: object;
    problemId: string;
    expiresAt: number;
  }>();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  acquire(db: object, problemId: string): (() => void) | undefined {
    const now = this.now();
    let count = 0;
    for (const [id, lease] of this.active) {
      // Lazy expiry also recovers a slot if the runtime cancelled an entire
      // request context without running its JavaScript finally block.
      if (lease.expiresAt <= now) this.active.delete(id);
      else if (lease.binding === db && lease.problemId === problemId) count += 1;
    }
    if (this.active.size >= EVENT_WAIT_LIMITS.total || count >= EVENT_WAIT_LIMITS.perProblem)
      return undefined;
    const id = Symbol();
    this.active.set(id, { binding: db, problemId, expiresAt: now + EVENT_WAIT_LIMITS.admissionTtlMs });
    return () => { this.active.delete(id); };
  }
}

const admission = new EventWaitAdmission();

/** Read just the public head and visibility while idle. No event/content scan,
 * site-wide cursor, private session, workshop or user-controlled body read. */
export const EVENT_WAIT_HEAD_SELECT = `SELECT public_seq, unlisted
  FROM problems WHERE id = ? AND status != 'private-draft'`;

export function eventWaitAborted(): Error {
  return new DOMException("Event wait cancelled", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw eventWaitAborted();
}

export function eventWaitDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(eventWaitAborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** D1 has no request cancellation API. Race the already-issued read, observe
 * late rejection, and never issue subsequent work after cancellation/timeout. */
function boundedRead<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
  milliseconds: number,
): Promise<T> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(eventWaitAborted());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new EventTailReadError("EVENT_TAIL_UNAVAILABLE"));
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      checkAbort(signal);
      return run();
    }).then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(eventWaitAborted());
        else resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(signal.aborted ? eventWaitAborted() :
          error instanceof EventTailReadError ? error :
          new EventTailReadError("EVENT_TAIL_UNAVAILABLE"));
      },
    );
  });
}

export interface EventWaitRuntime {
  readonly now: () => number;
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly admission: EventWaitAdmission;
}

const runtime: EventWaitRuntime = {
  now: () => performance.now(),
  delay: eventWaitDelay,
  admission,
};

/** The same canonical reader handles immediate, changed and timeout pages.
 * Waiting never authorizes disclosure or advances a cursor by itself. Existing
 * events, frozen snapshot pagination, HEAD and missing problems return without
 * holding a connection. Saturation falls back to an ordinary page with a
 * capacity outcome (the HTTP adapter supplies a retry delay).
 */
export async function readPublicEventTailWithWait(
  db: EventTailDatabase,
  problemId: string,
  query: EventTailQuery,
  request: Pick<Request, "method" | "signal">,
  timing: EventWaitRuntime = runtime,
) {
  checkAbort(request.signal);
  if (
    query.wait !== undefined &&
    (!Number.isInteger(query.wait) || query.wait < 0 || query.wait > EVENT_TAIL_MAX_WAIT_SECONDS)
  )
    throw new EventTailReadError("CURSOR_INVALID");
  const read = () => readPublicEventTail(db, problemId, query);
  // Preserve canonical input errors from the initial read; the public router
  // already bounds/parses its query before this seam.
  const initial = await boundedRead(read, request.signal, EVENT_WAIT_LIMITS.readTimeoutMs);
  checkAbort(request.signal);
  if (initial === null) return null;
  const wait = query.wait ?? 0;
  if (wait === 0 || request.method !== "GET" || query.through !== undefined || initial.page.events.length > 0)
    return { ...initial, waitOutcome: "immediate" as const };

  const release = timing.admission.acquire(db, problemId);
  if (release === undefined) return { ...initial, waitOutcome: "capacity" as const };
  try {
    const deadline = timing.now() + wait * 1_000;
    let budget = wait * 1_000;
    let outcome: EventWaitOutcome = "timeout";
    while (budget > 0) {
      const remaining = Math.min(budget, Math.max(0, deadline - timing.now()));
      if (remaining === 0) break;
      const pause = Math.min(remaining, EVENT_WAIT_LIMITS.probeIntervalMs);
      await timing.delay(pause, request.signal);
      checkAbort(request.signal);
      budget -= pause;
      const readBudget = Math.min(budget, deadline - timing.now(), EVENT_WAIT_LIMITS.readTimeoutMs);
      if (readBudget <= 0) break;
      const head = await boundedRead(
        () => db.prepare(EVENT_WAIT_HEAD_SELECT).bind(problemId).all<{
          public_seq: number;
          unlisted: number;
        }>(),
        request.signal,
        readBudget,
      );
      if (head.results.length === 0) return null;
      const row = head.results[0];
      if (
        head.results.length !== 1 || !row ||
        !Number.isSafeInteger(row.public_seq) || row.public_seq < initial.page.page_end.through ||
        (row.unlisted !== 0 && row.unlisted !== 1)
      ) throw new EventTailReadError("EVENT_TAIL_UNAVAILABLE");
      if (row.public_seq > initial.page.page_end.through || (row.unlisted === 1) !== initial.unlisted) {
        outcome = "changed";
        break;
      }
    }
    // A final fresh read also captures a commit at the timeout boundary and a
    // privacy/redaction change between the head hint and the actual page read.
    const result = await boundedRead(read, request.signal, EVENT_WAIT_LIMITS.readTimeoutMs);
    if (result === null) return null;
    if (result.page.events.length > 0) outcome = "changed";
    return { ...result, waitOutcome: outcome };
  } finally {
    release();
  }
}
