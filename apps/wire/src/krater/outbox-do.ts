import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectState,
} from "@cloudflare/workers-types";

export const KRATER_OUTBOX_DO_NAME = "krater-outbox-v0";
export const OUTBOX_DRAIN_BATCH_SIZE = 8;
export const OUTBOX_ALARM_BASE_MS = 25;
export const OUTBOX_ALARM_MAX_MS = 2_000;

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

interface CountRow {
  count: number;
}

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
  /** Age in ms of the oldest still-pending row (0 when the queue is empty). */
  oldest_pending_age_ms: number;
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

export async function requestKraterOutbox(
  env: KraterOutboxEnv,
  pathname: "/nudge" | "/drain-now" | "/status",
  command: OutboxCommand = { faultMode: "none" },
): Promise<Response> {
  const request = new Request(`https://krater-outbox.internal${pathname}`, {
    method: pathname === "/status" ? "GET" : "POST",
    headers: pathname === "/status" ? undefined : { "content-type": "application/json" },
    body: pathname === "/status" ? undefined : JSON.stringify({ fault_mode: command.faultMode }),
  });
  return kraterOutboxStub(env).fetch(request);
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

  /**
   * The lag metric (W2.5): the age in milliseconds of the oldest still-pending
   * outbox row. A growing lag is the backpressure signal the alarm/alert reads;
   * 0 when the queue is empty. Pure read of the authoritative queue.
   */
  private async oldestPendingAgeMs(nowMs: number): Promise<number> {
    const row = await statement(
      this.env.DB,
      "SELECT MIN(created_at) AS oldest FROM outbox WHERE state = 'pending' AND quarantined_at IS NULL",
    ).first<{ oldest: string | number | null }>();
    if (row?.oldest === null || row?.oldest === undefined) return 0;
    const oldestMs =
      typeof row.oldest === "number" ? row.oldest : Date.parse(String(row.oldest));
    if (!Number.isFinite(oldestMs)) return 0;
    return Math.max(0, nowMs - oldestMs);
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
    await this.state.storage.put(
      `quarantine:${row.id}`,
      JSON.stringify([row.event_id, row.kind, row.dedupe_key, row.payload_sha256, code]),
    );
    await this.updateCounters((current) => ({
      ...current,
      quarantined: current.quarantined + 1,
      last_quarantine_code: code,
      last_phase: "quarantined",
    }));
    return true;
  }

  private async acknowledge(row: PendingOutboxRow): Promise<boolean> {
    const result = await statement(
      this.env.DB,
      `UPDATE outbox SET state = 'delivered', delivered_at = ?
       WHERE id = ? AND state = 'pending' AND quarantined_at IS NULL`,
      new Date().toISOString(),
      row.id,
    ).run();
    return result.meta.changes === 1;
  }

  private async recordAttempt(row: PendingOutboxRow): Promise<void> {
    const key = `attempt:${row.event_id}`;
    const attempts = ((await this.state.storage.get<number>(key)) ?? 0) + 1;
    await this.state.storage.put({
      [key]: attempts,
      last_dequeued_event_id: row.event_id,
    });
    await this.updateCounters((current) => ({
      ...current,
      delivery_attempts: current.delivery_attempts + 1,
      last_phase: "dequeued",
    }));
  }

  private async retryAfterFailure(): Promise<number> {
    const counters = await this.updateCounters((current) => {
      const failures = current.failures + 1;
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
        owner_acquisitions: current.owner_acquisitions + 1,
        max_active: Math.max(current.max_active, 1),
        recovered_ownerships: current.recovered_ownerships + (recovered ? 1 : 0),
      }));

      try {
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
              delivered: current.delivered + 1,
              failures: 0,
              last_backoff_ms: null,
              last_phase: "delivered",
            }));
          } else {
            await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
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
            await this.state.storage.deleteAlarm();
          }
        } else if (scanAfterId !== 0) {
          await this.state.storage.put({
            [OUTBOX_SCAN_AFTER_ID_KEY]: 0,
            [OUTBOX_SCAN_WRAP_THROUGH_ID_KEY]: scanAfterId,
          });
          await this.setAlarm(OUTBOX_ALARM_BASE_MS);
        } else {
          await this.state.storage.deleteAlarm();
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

  private async status(): Promise<OutboxStatus> {
    return {
      ...(await this.counters()),
      active: (await this.state.storage.get<number>("active")) ?? 0,
      pending: await this.pendingCount(),
      oldest_pending_age_ms: await this.oldestPendingAgeMs(Date.now()),
      alarm_at: await this.state.storage.getAlarm(),
    };
  }
}
