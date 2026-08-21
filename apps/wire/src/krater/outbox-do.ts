import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectState,
} from "@cloudflare/workers-types";
import { canonicalClaimPayload, sha256Hex } from "./krater";

export const KRATER_OUTBOX_DO_NAME = "krater-outbox-v0";
export const OUTBOX_DRAIN_BATCH_SIZE = 8;
export const OUTBOX_ALARM_BASE_MS = 25;
export const OUTBOX_ALARM_MAX_MS = 2_000;
export const OUTBOX_IDLE_RECONCILE_MS = 5 * 60 * 1_000;
export const OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE = 8;
export const OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE = 8;
/**
 * Local observability threshold for an undrained durable outbox. This is a
 * typed status/evidence decision only; notification-provider delivery remains
 * an external deployment concern.
 */
export const OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS = 5 * 60 * 1_000;

/**
 * CONSUMER REGISTRY (W2.5 — the documented set of outbox consumers).
 *
 * Every row the outbox carries names a `kind`; this registry is the
 * authoritative list of the kinds the drainer will deliver and the contract
 * each consumer must keep. Delivery is at-least-once: a consumer MUST be
 * idempotent under duplicate delivery and MUST key its idempotency on the
 * row's `dedupe_key` (which the validator pins to `<kind>:<event_id>`).
 *
 *   kind            effect                                     idempotency key
 *   --------------  -----------------------------------------  ------------------------
 *   search.index    upsert the event's public-claim body into  search.index:<event_id>
 *                   the public FTS5 documents (public content
 *                   only — workshop/private bytes never leave
 *                   the ledger plane)
 *
 * Adding a consumer: (1) extend `validateOutboxRow` with the kind and its
 * dedupe-key shape (a kind the validator refuses is dead on arrival); (2) the
 * consumer's effect must be reconstructible from the referenced event — the
 * log is the truth, the outbox is only the handoff; (3) side effects that
 * cannot be made idempotent do not belong here — they stay synchronous in the
 * write transaction. Per-consumer checkpoints live in the drainer's Durable
 * Object state (`scan_after_id`); `GET /status` exposes the counters.
 */

const SHA256_HEX = /^[a-f0-9]{64}$/;
const OUTBOX_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OUTBOX_SCAN_AFTER_ID_KEY = "scan_after_id";
const OUTBOX_SCAN_WRAP_THROUGH_ID_KEY = "scan_wrap_through_id";
const OUTBOX_ATTEMPT_PREFIX = "attempt:";
const OUTBOX_ATTEMPT_RECLAIM_AFTER_KEY = "attempt_reclaim_after";
const OUTBOX_ATTEMPT_RECLAIM_COUNTERS_KEY = "attempt_reclaim_counters";
const OUTBOX_QUARANTINE_PREFIX = "quarantine:";
const OUTBOX_QUARANTINE_RECLAIM_AFTER_KEY = "quarantine_reclaim_after";
const OUTBOX_QUARANTINE_RECLAIM_COUNTERS_KEY = "quarantine_reclaim_counters";
/**
 * Quarantine keys are suffixed by the outbox ROW id, an integer, where attempt
 * keys are suffixed by the event id. The two id domains are why this sweep
 * cannot reuse the attempt cursor validator: an event-id pattern would reject
 * every quarantine cursor on restore and silently pin the sweep to its first
 * page forever.
 */
const OUTBOX_ROW_ID = /^[1-9][0-9]{0,18}$/;
const OUTBOX_PHASES = new Set<DurableCounters["last_phase"]>([
  "idle",
  "dequeued",
  "held-before-ack",
  "delivered",
  "quarantined",
  "retry",
]);

export type OutboxFaultMode = "none" | "fail-once" | "hold-before-ack";

export interface KraterOutboxStub {
  fetch(request: Request): Promise<Response>;
}

export interface KraterOutboxNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): KraterOutboxStub;
}

export interface KraterOutboxEnv {
  DB: D1Database;
  KRATER_OUTBOX?: KraterOutboxNamespace;
}

interface PendingOutboxRow {
  id: number;
  event_id: string;
  problem_id: string;
  kind: string;
  dedupe_key: string;
  payload_sha256: string;
}

interface SearchIndexSourceRow {
  event_id: string;
  problem_id: string;
  claim_id: string;
  payload_sha256: string;
  statement: string;
}

interface CountRow {
  count: number;
}

interface PendingAttemptEventRow {
  event_id: string;
}

interface ReclaimCounters {
  scans: number;
  keys_scanned: number;
  keys_reclaimed: number;
  failures: number;
}

interface AttemptReclaimResult {
  needsAlarm: boolean;
  scanned: number;
  reclaimed: number;
}

export interface PendingOutboxSnapshot {
  count: number;
  oldest: string | null;
  invalid_timestamp_count: number;
  future_timestamp_count: number;
}

/**
 * The single authoritative pending-count/oldest snapshot. `oldest` considers
 * only exact canonical UTC text values: malformed values, including SQLite
 * BLOBs, still contribute to the same snapshot's invalid count but can never
 * leak through `MIN` as a non-string and turn a degraded observation into a
 * status-read failure.
 */
export const OUTBOX_PENDING_SNAPSHOT_SQL = `WITH pending AS (
  SELECT created_at,
         CASE
           WHEN typeof(created_at) = 'text'
             AND created_at GLOB '????-??-??T??:??:??.???Z'
             AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at)) = created_at
           THEN 1 ELSE 0
         END AS canonical_timestamp
    FROM outbox
   WHERE state = 'pending' AND quarantined_at IS NULL
)
SELECT COUNT(*) AS count,
       MIN(CASE WHEN canonical_timestamp = 1 THEN created_at END) AS oldest,
       COALESCE(SUM(CASE WHEN canonical_timestamp = 0 THEN 1 ELSE 0 END), 0)
         AS invalid_timestamp_count,
       COALESCE(SUM(CASE
         WHEN canonical_timestamp = 1 AND created_at > ? THEN 1 ELSE 0
       END), 0) AS future_timestamp_count
  FROM pending`;

export type OldestPendingAgeStatus =
  | "empty"
  | "measured"
  | "degraded-invalid-timestamp"
  | "degraded-future-timestamp";

export type OldestPendingAgeAlert =
  | "not-pending"
  | "below-threshold"
  | "at-or-above-threshold"
  | "degraded";

interface DurableCounters {
  owner_acquisitions: number;
  max_active: number;
  recovered_ownerships: number;
  delivery_attempts: number;
  delivered: number;
  quarantined: number;
  failures: number;
  last_backoff_ms: number | null;
  last_quarantine_code: string | null;
  last_phase: "idle" | "dequeued" | "held-before-ack" | "delivered" | "quarantined" | "retry";
}

interface OutboxStatus extends DurableCounters {
  active: number;
  pending: number;
  alarm_at: number | null;
  /** Age in ms of the oldest still-pending row; null when timestamp storage is degraded. */
  oldest_pending_age_ms: number | null;
  oldest_pending_age_status: OldestPendingAgeStatus;
  oldest_pending_age_alert: OldestPendingAgeAlert;
  oldest_pending_age_alert_threshold_ms: number;
  attempt_reclamation: ReclaimCounters;
  quarantine_reclamation: ReclaimCounters;
}

interface OutboxCommand {
  faultMode: OutboxFaultMode;
}

interface StaleWrapFixtureCommand {
  scanAfterId: number;
  scanWrapThroughId: number;
}

export class KraterOutboxBindingError extends Error {
  readonly code = "KRATER_OUTBOX_BINDING_UNAVAILABLE";
}

function statement(db: D1Database, sql: string, ...values: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...values);
}

function attemptKey(eventId: string): string {
  return `${OUTBOX_ATTEMPT_PREFIX}${eventId}`;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseFaultMode(value: unknown): OutboxFaultMode {
  if (value === undefined || value === "none") return "none";
  if (value === "fail-once" || value === "hold-before-ack") return value;
  throw new Error("KRATER_OUTBOX_COMMAND_INVALID");
}

async function requestCommand(request: Request): Promise<OutboxCommand> {
  if (request.method !== "POST") return { faultMode: "none" };
  const body = asRecord(await request.json());
  if (body === null) throw new Error("KRATER_OUTBOX_COMMAND_INVALID");
  return { faultMode: parseFaultMode(body.fault_mode) };
}

function parseStaleWrapFixtureCommand(value: unknown): StaleWrapFixtureCommand {
  const body = asRecord(value);
  const scanAfterId = body?.scan_after_id;
  const scanWrapThroughId = body?.scan_wrap_through_id;
  if (
    !isNonNegativeInteger(scanAfterId) ||
    !isNonNegativeInteger(scanWrapThroughId) ||
    scanWrapThroughId === 0 ||
    scanAfterId >= scanWrapThroughId
  ) {
    throw new Error("KRATER_OUTBOX_STALE_WRAP_FIXTURE_INVALID");
  }
  return { scanAfterId, scanWrapThroughId };
}

function emptyCounters(): DurableCounters {
  return {
    owner_acquisitions: 0,
    max_active: 0,
    recovered_ownerships: 0,
    delivery_attempts: 0,
    delivered: 0,
    quarantined: 0,
    failures: 0,
    last_backoff_ms: null,
    last_quarantine_code: null,
    last_phase: "idle",
  };
}

function emptyReclaimCounters(): ReclaimCounters {
  return { scans: 0, keys_scanned: 0, keys_reclaimed: 0, failures: 0 };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Keep derived diagnostic counters valid for every lifetime of the singleton DO. */
function saturatingCounterAdd(current: number, increment = 1): number {
  return current + Math.min(increment, Number.MAX_SAFE_INTEGER - current);
}

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function oldestPendingAgeAlert(
  ageMs: number | null,
  status: OldestPendingAgeStatus,
): OldestPendingAgeAlert {
  if (status === "empty") return "not-pending";
  if (status !== "measured" || ageMs === null) return "degraded";
  return ageMs >= OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS
    ? "at-or-above-threshold"
    : "below-threshold";
}

export function oldestPendingAge(
  snapshot: PendingOutboxSnapshot,
  nowMs: number,
): { ageMs: number | null; status: OldestPendingAgeStatus } {
  if (snapshot.count === 0) return { ageMs: 0, status: "empty" };
  if (snapshot.invalid_timestamp_count > 0 || snapshot.oldest === null) {
    return { ageMs: null, status: "degraded-invalid-timestamp" };
  }
  if (snapshot.future_timestamp_count > 0) {
    return { ageMs: null, status: "degraded-future-timestamp" };
  }
  if (!isCanonicalUtcTimestamp(snapshot.oldest)) {
    return { ageMs: null, status: "degraded-invalid-timestamp" };
  }
  const oldestMs = Date.parse(snapshot.oldest);
  if (!Number.isSafeInteger(oldestMs) || oldestMs > nowMs) {
    return { ageMs: null, status: "degraded-future-timestamp" };
  }
  return { ageMs: nowMs - oldestMs, status: "measured" };
}

function isDurableCounters(value: unknown): value is DurableCounters {
  const record = asRecord(value);
  if (record === null) return false;
  return (
    isNonNegativeInteger(record.owner_acquisitions) &&
    isNonNegativeInteger(record.max_active) &&
    isNonNegativeInteger(record.recovered_ownerships) &&
    isNonNegativeInteger(record.delivery_attempts) &&
    isNonNegativeInteger(record.delivered) &&
    isNonNegativeInteger(record.quarantined) &&
    isNonNegativeInteger(record.failures) &&
    (record.last_backoff_ms === null || isNonNegativeInteger(record.last_backoff_ms)) &&
    (record.last_quarantine_code === null || typeof record.last_quarantine_code === "string") &&
    typeof record.last_phase === "string" &&
    OUTBOX_PHASES.has(record.last_phase as DurableCounters["last_phase"])
  );
}

function isReclaimCounters(value: unknown): value is ReclaimCounters {
  const record = asRecord(value);
  return (
    record !== null &&
    isNonNegativeInteger(record.scans) &&
    isNonNegativeInteger(record.keys_scanned) &&
    isNonNegativeInteger(record.keys_reclaimed) &&
    isNonNegativeInteger(record.failures)
  );
}

export function boundedOutboxBackoff(failures: number): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new Error("KRATER_OUTBOX_BACKOFF_INVALID");
  }
  return Math.min(OUTBOX_ALARM_BASE_MS * 2 ** Math.min(failures - 1, 7), OUTBOX_ALARM_MAX_MS);
}

export function validateOutboxRow(
  row: Pick<PendingOutboxRow, "event_id" | "kind" | "dedupe_key" | "payload_sha256">,
):
  | null
  | "OUTBOX_EVENT_INVALID"
  | "OUTBOX_KIND_INVALID"
  | "OUTBOX_DEDUPE_INVALID"
  | "OUTBOX_PAYLOAD_INVALID" {
  if (!OUTBOX_EVENT_ID.test(row.event_id)) return "OUTBOX_EVENT_INVALID";
  if (row.kind !== "search.index") return "OUTBOX_KIND_INVALID";
  if (row.dedupe_key !== `search.index:${row.event_id}`) return "OUTBOX_DEDUPE_INVALID";
  if (!SHA256_HEX.test(row.payload_sha256)) return "OUTBOX_PAYLOAD_INVALID";
  return null;
}

/**
 * Explicit post-transaction handoff seam. The production entrypoint owns the
 * binding; this helper centralizes selection of the one named retry owner.
 */
export function kraterOutboxStub(env: KraterOutboxEnv): KraterOutboxStub {
  if (env.KRATER_OUTBOX === undefined) throw new KraterOutboxBindingError();
  return env.KRATER_OUTBOX.get(env.KRATER_OUTBOX.idFromName(KRATER_OUTBOX_DO_NAME));
}

/**
 * Wall-clock bound for one best-effort post-commit handoff to the retry owner.
 *
 * Short on purpose: the caller has already committed and is holding a response,
 * and the five-minute scheduled reconciliation remains the delivery authority.
 * This only shortens the common case; it is never the thing that makes delivery
 * correct.
 */
export const KRATER_OUTBOX_NUDGE_DEADLINE_MS = 1_000;

/**
 * setTimeout clamps delays above this, so a larger value would fire immediately
 * and turn a "generous" deadline into an instant abort.
 */
const MAX_OUTBOX_DEADLINE_MS = 2_147_483_647;

/**
 * Typed, non-secret deadline failure. Carries a stable code and nothing else:
 * no URL, no binding name, no elapsed timing. A caller may distinguish it from a
 * transport failure; it teaches an attacker nothing.
 */
export class KraterOutboxDeadlineError extends Error {
  readonly code = "KRATER_OUTBOX_DEADLINE_EXCEEDED";

  constructor() {
    super("KRATER_OUTBOX_DEADLINE_EXCEEDED");
  }
}

/**
 * `deadlineMs` is opt-in. Callers that omit it keep exactly today's unbounded
 * behaviour, so the scheduled and operator paths are unchanged.
 *
 * When a deadline is supplied the bound does NOT depend on the transport
 * honouring `Request.signal`. `DurableObjectStub.fetch` is free to ignore an
 * AbortSignal, and an abort-only implementation would then leave this promise --
 * and any `waitUntil` holding it -- pending forever. So the deadline races the
 * handoff against a timer that both aborts (best effort, for a transport that
 * does honour it) and rejects with a typed error (the actual guarantee). The
 * timer is cleared in `finally`, so a handoff that settles first is never
 * aborted afterwards and leaves no pending timer holding the isolate open.
 *
 * `Promise.race` installs its own handlers on the handoff, so a transport that
 * loses the race and fails long afterwards is already observed and cannot
 * surface as an unhandled rejection.
 */
export async function requestKraterOutbox(
  env: KraterOutboxEnv,
  pathname: "/nudge" | "/drain-now" | "/status",
  command: OutboxCommand = { faultMode: "none" },
  deadlineMs?: number,
): Promise<Response> {
  const buildRequest = (signal?: AbortSignal): Request =>
    new Request(`https://krater-outbox.internal${pathname}`, {
      method: pathname === "/status" ? "GET" : "POST",
      headers: pathname === "/status" ? undefined : { "content-type": "application/json" },
      body: pathname === "/status" ? undefined : JSON.stringify({ fault_mode: command.faultMode }),
      ...(signal === undefined ? {} : { signal }),
    });

  if (deadlineMs === undefined) {
    return kraterOutboxStub(env).fetch(buildRequest());
  }
  // `Number.isSafeInteger` is the whole finite/integer/safe test in one: it is
  // false for NaN, both infinities, and any fraction. Applied to `deadlineMs`
  // itself rather than a truncation of it, so 0.5 is refused rather than
  // silently floored to a zero delay.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_OUTBOX_DEADLINE_MS) {
    throw new Error("KRATER_OUTBOX_DEADLINE_INVALID");
  }

  const controller = new AbortController();
  const handoff = kraterOutboxStub(env).fetch(buildRequest(controller.signal));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new KraterOutboxDeadlineError());
    }, deadlineMs);
  });
  try {
    return await Promise.race([handoff, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Local S-2 harness seam: production routing never exposes this request. */
export async function plantKraterOutboxStaleWrapForHarness(
  env: KraterOutboxEnv,
  scanAfterId: number,
  scanWrapThroughId: number,
): Promise<Response> {
  return kraterOutboxStub(env).fetch(
    new Request("https://krater-outbox.internal/__s2/plant-stale-wrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scan_after_id: scanAfterId,
        scan_wrap_through_id: scanWrapThroughId,
      }),
    }),
  );
}

/**
 * Durable retry owner exported by the shared Worker and mounted through the
 * environment-specific Wrangler configuration.
 */
export class KraterOutboxDrainer {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: KraterOutboxEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname === "/status" && request.method === "GET") return response(await this.status());
      if (pathname === "/nudge") {
        const command = await requestCommand(request);
        await this.state.storage.put("fault_mode", command.faultMode);
        await this.setAlarm(OUTBOX_ALARM_BASE_MS);
        return response({ accepted: true, fault_mode: command.faultMode }, 202);
      }
      if (pathname === "/drain-now") {
        const command = await requestCommand(request);
        return response(await this.drain("fetch", command.faultMode));
      }
      if (pathname === "/__s2/plant-stale-wrap" && request.method === "POST") {
        const fixture = parseStaleWrapFixtureCommand(await request.json());
        await this.state.storage.put({
          [OUTBOX_SCAN_AFTER_ID_KEY]: fixture.scanAfterId,
          [OUTBOX_SCAN_WRAP_THROUGH_ID_KEY]: fixture.scanWrapThroughId,
          // If the first recovery alarm wins the race with the harness's
          // observation, hold the restored row before ACK and keep it armed.
          fault_mode: "hold-before-ack",
        });
        await this.state.storage.deleteAlarm();
        return response({ planted: true }, 201);
      }
      return response({ code: "KRATER_OUTBOX_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      return response(
        { code: error instanceof Error ? error.message : "KRATER_OUTBOX_FAILED" },
        400,
      );
    }
  }

  async alarm(): Promise<void> {
    const faultMode = (await this.state.storage.get<OutboxFaultMode>("fault_mode")) ?? "none";
    await this.drain("alarm", faultMode);
  }

  private async counters(): Promise<DurableCounters> {
    const stored = await this.state.storage.get<unknown>("counters");
    if (stored === undefined) return emptyCounters();
    if (isDurableCounters(stored)) return stored;
    const recovered = emptyCounters();
    await this.state.storage.put("counters", recovered);
    return recovered;
  }

  private async updateCounters(
    update: (counters: DurableCounters) => DurableCounters,
  ): Promise<DurableCounters> {
    const next = update(await this.counters());
    await this.state.storage.put("counters", next);
    return next;
  }

  private async reclaimCounters(key: string): Promise<ReclaimCounters> {
    const stored = await this.state.storage.get<unknown>(key);
    if (stored === undefined) return emptyReclaimCounters();
    if (isReclaimCounters(stored)) return stored;
    const recovered = emptyReclaimCounters();
    await this.state.storage.put(key, recovered);
    return recovered;
  }

  private async updateReclaimCounters(
    key: string,
    update: (counters: ReclaimCounters) => ReclaimCounters,
  ): Promise<ReclaimCounters> {
    const next = update(await this.reclaimCounters(key));
    await this.state.storage.put(key, next);
    return next;
  }

  private async setAlarm(delayMs: number): Promise<void> {
    const bounded = Math.min(Math.max(delayMs, OUTBOX_ALARM_BASE_MS), OUTBOX_ALARM_MAX_MS);
    await this.state.storage.setAlarm(Date.now() + bounded);
  }

  private async pendingRows(afterId: number, wrapThroughId?: number): Promise<PendingOutboxRow[]> {
    const rows = await (wrapThroughId === undefined
      ? statement(
          this.env.DB,
          `SELECT id, event_id, problem_id, kind, dedupe_key, payload_sha256
           FROM outbox
           WHERE state = 'pending' AND quarantined_at IS NULL AND id > ?
           ORDER BY id ASC LIMIT ?`,
          afterId,
          OUTBOX_DRAIN_BATCH_SIZE,
        )
      : statement(
          this.env.DB,
          `SELECT id, event_id, problem_id, kind, dedupe_key, payload_sha256
           FROM outbox
           WHERE state = 'pending' AND quarantined_at IS NULL AND id > ? AND id <= ?
           ORDER BY id ASC LIMIT ?`,
          afterId,
          wrapThroughId,
          OUTBOX_DRAIN_BATCH_SIZE,
        )
    ).all<PendingOutboxRow>();
    return rows.results;
  }

  private async scanAfterId(): Promise<number> {
    const value = await this.state.storage.get<unknown>(OUTBOX_SCAN_AFTER_ID_KEY);
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      // The cursor is only a bounded-scan optimization. D1 remains the source
      // of truth, so corrupt derived state is recovered by a safe full rescan.
      await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, 0);
      return 0;
    }
    return value;
  }

  private async scanWrapThroughId(scanAfterId: number): Promise<number | undefined> {
    const value = await this.state.storage.get<unknown>(OUTBOX_SCAN_WRAP_THROUGH_ID_KEY);
    if (value === undefined) return undefined;
    if (!isNonNegativeInteger(value) || value === 0 || scanAfterId >= value) {
      // Equality is also inconsistent: it can be left by a crash after the
      // bounded wrap cursor is persisted but before the wrap marker is
      // cleared. Rescan authoritative D1 rather than querying an empty
      // (id > value AND id <= value) interval and clearing the only alarm.
      await this.state.storage.delete(OUTBOX_SCAN_WRAP_THROUGH_ID_KEY);
      await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, 0);
      return undefined;
    }
    return value;
  }

  private async pendingCount(): Promise<number> {
    const row = await statement(
      this.env.DB,
      "SELECT COUNT(*) AS count FROM outbox WHERE state = 'pending' AND quarantined_at IS NULL",
    ).first<CountRow>();
    return row?.count ?? 0;
  }

  private async attemptReclaimAfter(): Promise<string | undefined> {
    const stored = await this.state.storage.get<unknown>(OUTBOX_ATTEMPT_RECLAIM_AFTER_KEY);
    if (stored === undefined) return undefined;
    if (
      typeof stored !== "string" ||
      !stored.startsWith(OUTBOX_ATTEMPT_PREFIX) ||
      stored.length > OUTBOX_ATTEMPT_PREFIX.length + 128 ||
      !OUTBOX_EVENT_ID.test(stored.slice(OUTBOX_ATTEMPT_PREFIX.length))
    ) {
      await this.state.storage.delete(OUTBOX_ATTEMPT_RECLAIM_AFTER_KEY);
      return undefined;
    }
    return stored;
  }

  private async pendingAttemptEventIds(eventIds: readonly string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const placeholders = eventIds.map(() => "?").join(", ");
    const rows = await statement(
      this.env.DB,
      `SELECT event_id FROM outbox
       WHERE state = 'pending' AND quarantined_at IS NULL
         AND event_id IN (${placeholders})`,
      ...eventIds,
    ).all<PendingAttemptEventRow>();
    const pending = new Set<string>();
    for (const row of rows.results) {
      if (typeof row.event_id !== "string" || !eventIds.includes(row.event_id)) {
        throw new Error("KRATER_OUTBOX_ATTEMPT_RECLAIM_SNAPSHOT_INVALID");
      }
      pending.add(row.event_id);
    }
    return pending;
  }

  /**
   * Incrementally reclaims derived per-event attempt tallies. D1 is the only
   * terminal-state authority: a key is deleted only after this bounded page's
   * event id is absent from the authoritative pending set. The lexical cursor
   * wraps after a short page, so retained pending keys cannot starve later
   * terminal keys and a restart may safely replay any incomplete page.
   */
  private async reclaimAttemptKeys(): Promise<AttemptReclaimResult> {
    const after = await this.attemptReclaimAfter();
    const entries = await this.state.storage.list<unknown>({
      prefix: OUTBOX_ATTEMPT_PREFIX,
      ...(after === undefined ? {} : { startAfter: after }),
      limit: OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE,
    });
    const keys = [...entries.keys()];
    const eventIds = keys.map((key) => key.slice(OUTBOX_ATTEMPT_PREFIX.length));
    const pending = await this.pendingAttemptEventIds(eventIds);
    let reclaimed = 0;
    let failures = 0;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const eventId = eventIds[index];
      if (key !== undefined && eventId !== undefined && !pending.has(eventId)) {
        try {
          await this.state.storage.delete(key);
          reclaimed += 1;
        } catch (_deleteError) {
          // Derived tallies are never D1 authority. Finish this bounded page
          // so one permanent delete failure cannot pin every later key.
          failures += 1;
        }
      }
    }

    const pageIsFull = keys.length === OUTBOX_ATTEMPT_RECLAIM_BATCH_SIZE;
    // A short page reached through startAfter ends this lexical interval. The
    // cursor is cleared below; the terminal five-minute alarm then revisits the
    // prefix start. Do not force an immediate wrap: eight retained *pending*
    // keys would otherwise keep the two-second retry cadence hot forever.
    const needsAlarm = pageIsFull;
    if (pageIsFull) {
      const lastKey = keys.at(-1);
      if (lastKey === undefined) throw new Error("KRATER_OUTBOX_ATTEMPT_RECLAIM_CURSOR_INVALID");
      await this.state.storage.put(OUTBOX_ATTEMPT_RECLAIM_AFTER_KEY, lastKey);
    } else {
      await this.state.storage.delete(OUTBOX_ATTEMPT_RECLAIM_AFTER_KEY);
    }
    await this.updateReclaimCounters(OUTBOX_ATTEMPT_RECLAIM_COUNTERS_KEY, (current) => ({
      ...current,
      scans: saturatingCounterAdd(current.scans),
      keys_scanned: saturatingCounterAdd(current.keys_scanned, keys.length),
      keys_reclaimed: saturatingCounterAdd(current.keys_reclaimed, reclaimed),
      failures: saturatingCounterAdd(current.failures, failures),
    }));
    return { needsAlarm, scanned: keys.length, reclaimed };
  }

  private async quarantineReclaimAfter(): Promise<string | undefined> {
    const stored = await this.state.storage.get<unknown>(OUTBOX_QUARANTINE_RECLAIM_AFTER_KEY);
    if (stored === undefined) return undefined;
    if (
      typeof stored !== "string" ||
      !stored.startsWith(OUTBOX_QUARANTINE_PREFIX) ||
      stored.length > OUTBOX_QUARANTINE_PREFIX.length + 19 ||
      !OUTBOX_ROW_ID.test(stored.slice(OUTBOX_QUARANTINE_PREFIX.length))
    ) {
      await this.state.storage.delete(OUTBOX_QUARANTINE_RECLAIM_AFTER_KEY);
      return undefined;
    }
    return stored;
  }

  /**
   * Reclaims legacy per-row quarantine keys in bounded pages.
   *
   * Unlike an attempt tally, a quarantine key is redundant the MOMENT it is
   * written: D1 already holds the identifiers, digest, quarantine code and
   * timestamp for that row. There is therefore no pending-set cross-check to
   * make here — gating deletion on one would ask a question whose answer never
   * changes — and this sweep must never be "aligned" with reclaimAttemptKeys by
   * copying that guard.
   *
   * The cursor exists for starvation, not for correctness: deletion is
   * idempotent, so a cursorless sweep would still converge, but one key whose
   * delete keeps failing would be retried forever and block every key behind
   * it. Advancing past a full page lets the next alarm make progress regardless.
   * Lexical order over numeric ids means `quarantine:10` precedes
   * `quarantine:9`; that is still a total order, so every key is visited once
   * per cycle and nothing needs zero-padding to make it look sorted.
   */
  private async reclaimQuarantineKeys(): Promise<AttemptReclaimResult> {
    const after = await this.quarantineReclaimAfter();
    const entries = await this.state.storage.list<unknown>({
      prefix: OUTBOX_QUARANTINE_PREFIX,
      ...(after === undefined ? {} : { startAfter: after }),
      limit: OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE,
    });
    const keys = [...entries.keys()];
    let reclaimed = 0;
    let failures = 0;
    for (const key of keys) {
      try {
        await this.state.storage.delete(key);
        reclaimed += 1;
      } catch (_deleteError) {
        // The legacy copy is derived state. Finish this bounded page so a
        // permanent poison key cannot starve later legacy quarantine keys.
        failures += 1;
      }
    }

    const pageIsFull = keys.length === OUTBOX_QUARANTINE_RECLAIM_BATCH_SIZE;
    if (pageIsFull) {
      const lastKey = keys.at(-1);
      if (lastKey === undefined) {
        throw new Error("KRATER_OUTBOX_QUARANTINE_RECLAIM_CURSOR_INVALID");
      }
      await this.state.storage.put(OUTBOX_QUARANTINE_RECLAIM_AFTER_KEY, lastKey);
    } else {
      // A short page ends this lexical interval. Clearing the cursor sends the
      // next terminal alarm back to the prefix start, which is what reclaims
      // anything a failed delete left behind earlier in the interval.
      await this.state.storage.delete(OUTBOX_QUARANTINE_RECLAIM_AFTER_KEY);
    }
    await this.updateReclaimCounters(OUTBOX_QUARANTINE_RECLAIM_COUNTERS_KEY, (current) => ({
      ...current,
      scans: saturatingCounterAdd(current.scans),
      keys_scanned: saturatingCounterAdd(current.keys_scanned, keys.length),
      keys_reclaimed: saturatingCounterAdd(current.keys_reclaimed, reclaimed),
      failures: saturatingCounterAdd(current.failures, failures),
    }));
    return { needsAlarm: pageIsFull, scanned: keys.length, reclaimed };
  }

  /**
   * One authoritative D1 snapshot for every status face. Once timestamps pass
   * the canonical UTC predicate, lexical MIN(created_at) is chronological. The
   * same statement counts invalid/future rows so no corrupted pending record
   * can be hidden behind a valid oldest row or coerced into a zero-lag report.
   */
  private async pendingSnapshot(now: string): Promise<PendingOutboxSnapshot> {
    const row = await statement(
      this.env.DB,
      OUTBOX_PENDING_SNAPSHOT_SQL,
      now,
    ).first<PendingOutboxSnapshot>();
    if (
      row === null ||
      !isNonNegativeInteger(row.count) ||
      !isNonNegativeInteger(row.invalid_timestamp_count) ||
      !isNonNegativeInteger(row.future_timestamp_count) ||
      (row.oldest !== null && typeof row.oldest !== "string")
    ) {
      throw new Error("KRATER_OUTBOX_STATUS_SNAPSHOT_INVALID");
    }
    return row;
  }

  private async quarantine(
    row: PendingOutboxRow,
    code: NonNullable<ReturnType<typeof validateOutboxRow>>,
  ): Promise<boolean> {
    // D1 is the authoritative queue. Moving poison out of `pending` prevents a
    // bounded wrap from paying for the same malformed prefix forever. The CAS
    // also makes concurrent/retried drains increment diagnostics at most once.
    const result = await statement(
      this.env.DB,
      `UPDATE outbox
          SET quarantined_at = ?, quarantine_code = ?
        WHERE id = ? AND state = 'pending' AND quarantined_at IS NULL`,
      new Date().toISOString(),
      code,
      row.id,
    ).run();
    if (result.meta.changes !== 1) return false;
    // No per-event forensic key is written here. D1 is the authority and the
    // CAS above already persisted quarantined_at and quarantine_code beside the
    // row's own event_id, kind, dedupe_key and payload_sha256, so a DO copy was
    // duplicate state that grew without bound. Legacy copies are reclaimed by
    // reclaimQuarantineKeys; dead-letter visibility is unchanged.
    await this.updateCounters((current) => ({
      ...current,
      quarantined: saturatingCounterAdd(current.quarantined),
      last_quarantine_code: code,
      last_phase: "quarantined",
    }));
    // Attempt tallies are only diagnostics for a row while it is pending.
    // Retaining one key per terminal event would grow this singleton DO
    // forever; retry/backoff authority lives in the fixed-size counters record.
    await this.state.storage.delete(attemptKey(row.event_id));
    return true;
  }

  /**
   * Terminalize exactly the row this drain validated, or nothing at all.
   *
   * `id` is not the row's identity. A reclaim, a replayed migration or a
   * repaired dedupe key can leave a different logical handoff under the same
   * primary key between selection and this update, and delivering that row
   * would record work as done that was never performed for it. Binding the
   * whole immutable tuple the drain actually read makes the CAS fail closed:
   * any single-field disagreement changes zero rows, the row stays pending and
   * a later alarm re-drains it against its current bytes.
   */
  private async acknowledge(row: PendingOutboxRow): Promise<boolean> {
    const result = await statement(
      this.env.DB,
      `UPDATE outbox SET state = 'delivered', delivered_at = ?
       WHERE id = ? AND state = 'pending' AND quarantined_at IS NULL
         AND event_id = ? AND problem_id = ? AND kind = ?
         AND dedupe_key = ? AND payload_sha256 = ?`,
      new Date().toISOString(),
      row.id,
      row.event_id,
      row.problem_id,
      row.kind,
      row.dedupe_key,
      row.payload_sha256,
    ).run();
    return result.meta.changes === 1;
  }

  /**
   * Reconstruct and idempotently apply the one real `search.index` effect.
   *
   * The immutable public event is the authority. The join admits only a public
   * claim event whose problem, object identity and payload digest agree with the
   * queued handoff; workshop/private tables are deliberately unreachable here.
   * Replacing the FTS row in one D1 batch makes replay after a crash between the
   * effect and the delivered-state CAS safe and leaves exactly one document.
   */
  private async applySearchIndexEffect(row: PendingOutboxRow): Promise<void> {
    const source = await statement(
      this.env.DB,
      `SELECT e.id AS event_id, e.problem_id, e.object_id AS claim_id,
              e.payload_sha256, c.statement
       FROM events e
       JOIN claims c ON c.id = e.object_id AND c.problem_id = e.problem_id
       WHERE e.id = ? AND e.problem_id = ?
         AND e.type = 'claim.created' AND e.object_kind = 'claim' AND e.object_version = 1
         AND e.payload_sha256 = ? AND c.payload_sha256 = e.payload_sha256`,
      row.event_id,
      row.problem_id,
      row.payload_sha256,
    ).first<SearchIndexSourceRow>();
    if (
      source === null ||
      source.event_id !== row.event_id ||
      source.problem_id !== row.problem_id ||
      source.payload_sha256 !== row.payload_sha256 ||
      typeof source.claim_id !== "string" ||
      source.claim_id.length === 0 ||
      typeof source.statement !== "string"
    ) {
      throw new Error("KRATER_OUTBOX_SEARCH_SOURCE_INVALID");
    }
    const observedPayloadSha256 = await sha256Hex(
      canonicalClaimPayload({
        claimId: source.claim_id,
        kind: "claim",
        statement: source.statement,
      }),
    );
    if (observedPayloadSha256 !== source.payload_sha256) {
      throw new Error("KRATER_OUTBOX_SEARCH_SOURCE_INVALID");
    }

    await this.env.DB.batch([
      statement(
        this.env.DB,
        "DELETE FROM public_claim_fts WHERE claim_id = ? AND problem_id = ?",
        source.claim_id,
        source.problem_id,
      ),
      statement(
        this.env.DB,
        `INSERT INTO public_claim_fts (claim_id, problem_id, statement)
         VALUES (?, ?, ?)`,
        source.claim_id,
        source.problem_id,
        source.statement,
      ),
    ]);
  }

  private async recordAttempt(row: PendingOutboxRow): Promise<void> {
    const key = attemptKey(row.event_id);
    const stored = await this.state.storage.get<unknown>(key);
    const attempts = isNonNegativeInteger(stored)
      ? Math.min(stored + 1, Number.MAX_SAFE_INTEGER)
      : 1;
    await this.state.storage.put({
      [key]: attempts,
      last_dequeued_event_id: row.event_id,
    });
    await this.updateCounters((current) => ({
      ...current,
      delivery_attempts: saturatingCounterAdd(current.delivery_attempts),
      last_phase: "dequeued",
    }));
  }

  private async retryAfterFailure(): Promise<number> {
    const counters = await this.updateCounters((current) => {
      const failures = saturatingCounterAdd(current.failures);
      return {
        ...current,
        failures,
        last_backoff_ms: boundedOutboxBackoff(failures),
        last_phase: "retry",
      };
    });
    const backoff = counters.last_backoff_ms ?? OUTBOX_ALARM_BASE_MS;
    await this.setAlarm(backoff);
    return backoff;
  }

  private async drain(
    source: "alarm" | "fetch",
    requestedFault: OutboxFaultMode,
  ): Promise<Record<string, unknown>> {
    return this.state.blockConcurrencyWhile(async () => {
      const active = (await this.state.storage.get<number>("active")) ?? 0;
      const recovered = active > 0;
      await this.state.storage.put("active", 1);
      await this.updateCounters((current) => ({
        ...current,
        owner_acquisitions: saturatingCounterAdd(current.owner_acquisitions),
        max_active: Math.max(current.max_active, 1),
        recovered_ownerships: saturatingCounterAdd(current.recovered_ownerships, recovered ? 1 : 0),
      }));

      try {
        let reclaimNeedsAlarm = false;
        try {
          const attemptReclaim = await this.reclaimAttemptKeys();
          reclaimNeedsAlarm = attemptReclaim.needsAlarm;
        } catch (_attemptReclaimError) {
          reclaimNeedsAlarm = true;
          try {
            await this.updateReclaimCounters(OUTBOX_ATTEMPT_RECLAIM_COUNTERS_KEY, (current) => ({
              ...current,
              failures: saturatingCounterAdd(current.failures),
            }));
          } catch (_counterError) {
            // Reclamation is maintenance for derived keys. Authoritative D1
            // delivery must continue even when Durable Object diagnostics are
            // temporarily unavailable; the alarm below retries the sweep.
          }
        }
        try {
          // Legacy quarantine keys are reclaimed independently. A failure in
          // either sweep re-arms the alarm rather than failing authoritative
          // D1 delivery, and each family keeps its own truthful diagnostics.
          const quarantineReclaim = await this.reclaimQuarantineKeys();
          reclaimNeedsAlarm = reclaimNeedsAlarm || quarantineReclaim.needsAlarm;
        } catch (_quarantineReclaimError) {
          reclaimNeedsAlarm = true;
          try {
            await this.updateReclaimCounters(OUTBOX_QUARANTINE_RECLAIM_COUNTERS_KEY, (current) => ({
              ...current,
              failures: saturatingCounterAdd(current.failures),
            }));
          } catch (_counterError) {
            // Reclamation is maintenance for derived keys. Authoritative D1
            // delivery must continue even when Durable Object diagnostics are
            // temporarily unavailable; the alarm below retries the sweep.
          }
        }
        let scanAfterId = await this.scanAfterId();
        const wrapThroughId = await this.scanWrapThroughId(scanAfterId);
        if (wrapThroughId === undefined) {
          scanAfterId = await this.scanAfterId();
        }
        let rows = await this.pendingRows(scanAfterId, wrapThroughId);
        if (rows.length === 0 && scanAfterId !== 0 && wrapThroughId === undefined) {
          // A cursor beyond D1's current maximum can survive a restore. Wrap
          // once so that stale derived state cannot hide the first page.
          scanAfterId = 0;
          await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
          rows = await this.pendingRows(scanAfterId);
        }
        let delivered = 0;
        let quarantined = 0;
        let faultMode = requestedFault;
        for (const row of rows) {
          const malformed = validateOutboxRow(row);
          if (malformed !== null) {
            if (await this.quarantine(row, malformed)) quarantined += 1;
            scanAfterId = row.id;
            continue;
          }

          await this.recordAttempt(row);
          await this.applySearchIndexEffect(row);
          if (faultMode === "hold-before-ack") {
            await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
            await this.state.storage.put("fault_mode", "none");
            await this.updateCounters((current) => ({ ...current, last_phase: "held-before-ack" }));
            await this.setAlarm(OUTBOX_ALARM_MAX_MS);
            return { source, delivered, quarantined, held_before_ack: true };
          }
          if (faultMode === "fail-once") {
            await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
            await this.state.storage.put("fault_mode", "none");
            const backoff = await this.retryAfterFailure();
            return { source, delivered, quarantined, retry_scheduled_ms: backoff };
          }

          if (await this.acknowledge(row)) {
            delivered += 1;
            await this.updateCounters((current) => ({
              ...current,
              delivered: saturatingCounterAdd(current.delivered),
              failures: 0,
              last_backoff_ms: null,
              last_phase: "delivered",
            }));
            await this.state.storage.delete(attemptKey(row.event_id));
          } else {
            await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
            // A zero-row CAS means this selected row is no longer pending.
            // Discard the diagnostic tally even when another writer won.
            await this.state.storage.delete(attemptKey(row.event_id));
            const backoff = await this.retryAfterFailure();
            return { source, delivered, quarantined, retry_scheduled_ms: backoff };
          }
          scanAfterId = row.id;
          faultMode = "none";
        }

        await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
        if ((await this.pendingRows(scanAfterId, wrapThroughId)).length > 0) {
          await this.setAlarm(OUTBOX_ALARM_BASE_MS);
        } else if (wrapThroughId !== undefined) {
          await this.state.storage.delete(OUTBOX_SCAN_WRAP_THROUGH_ID_KEY);
          await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, wrapThroughId);
          if ((await this.pendingRows(wrapThroughId)).length > 0) {
            await this.setAlarm(OUTBOX_ALARM_BASE_MS);
          } else if ((await this.pendingCount()) > 0) {
            // The wrap cursor is derived Durable Object state, while D1 is
            // authoritative. A D1 restore (or other stale cursor state) can
            // reintroduce a pending row below the interval this wrap just
            // finished. Never clear the only alarm while authoritative work
            // remains: discard the optimization and rescan from the start.
            await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, 0);
            await this.setAlarm(OUTBOX_ALARM_BASE_MS);
          } else {
            if (reclaimNeedsAlarm) await this.setAlarm(OUTBOX_ALARM_BASE_MS);
            else await this.setIdleReconcileAlarm();
          }
        } else if (scanAfterId !== 0) {
          await this.state.storage.put({
            [OUTBOX_SCAN_AFTER_ID_KEY]: 0,
            [OUTBOX_SCAN_WRAP_THROUGH_ID_KEY]: scanAfterId,
          });
          await this.setAlarm(OUTBOX_ALARM_BASE_MS);
        } else {
          if (reclaimNeedsAlarm) await this.setAlarm(OUTBOX_ALARM_BASE_MS);
          else await this.setIdleReconcileAlarm();
        }
        return { source, delivered, quarantined, held_before_ack: false };
      } catch (error) {
        // Re-arm explicitly so fetch- and alarm-driven drains use the same
        // bounded retry policy. Once an alarm is durably re-armed, returning
        // successfully keeps that code-owned schedule authoritative instead
        // of also asking the runtime to create an independent failed-alarm
        // retry. If re-arming itself fails, throw and leave the runtime as the
        // final retry authority.
        try {
          await this.retryAfterFailure();
        } catch (_retryError) {
          throw error;
        }
        if (source === "alarm") return { source, retry_armed: true };
        // Fetch callers still receive the causal D1 failure after the retry is
        // safe; a 2xx response would falsely report a successful direct drain.
        throw error;
      } finally {
        await this.state.storage.put("active", 0);
      }
    });
  }

  /**
   * Keep a low-frequency alarm even after an empty authoritative snapshot.
   * D1 enqueue and the DO nudge are separate operations, so deleting the alarm
   * after an empty read has an unavoidable enqueue-between-read-and-delete
   * race. The five-minute heartbeat matches the configured recovery cron and
   * bounds that failure without paying the two-second active retry cadence.
   */
  private async setIdleReconcileAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + OUTBOX_IDLE_RECONCILE_MS);
  }

  private async status(): Promise<OutboxStatus> {
    const observedAtMs = Date.now();
    const snapshot = await this.pendingSnapshot(new Date(observedAtMs).toISOString());
    const oldestPending = oldestPendingAge(snapshot, observedAtMs);
    return {
      ...(await this.counters()),
      active: (await this.state.storage.get<number>("active")) ?? 0,
      pending: snapshot.count,
      oldest_pending_age_ms: oldestPending.ageMs,
      oldest_pending_age_status: oldestPending.status,
      oldest_pending_age_alert: oldestPendingAgeAlert(oldestPending.ageMs, oldestPending.status),
      oldest_pending_age_alert_threshold_ms: OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS,
      attempt_reclamation: await this.reclaimCounters(OUTBOX_ATTEMPT_RECLAIM_COUNTERS_KEY),
      quarantine_reclamation: await this.reclaimCounters(OUTBOX_QUARANTINE_RECLAIM_COUNTERS_KEY),
      alarm_at: await this.state.storage.getAlarm(),
    };
  }
}
