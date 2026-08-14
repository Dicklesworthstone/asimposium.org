import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectState,
} from "@cloudflare/workers-types";

export const KRATER_OUTBOX_DO_NAME = "krater-outbox-v0";
export const OUTBOX_DRAIN_BATCH_SIZE = 8;
export const OUTBOX_ALARM_BASE_MS = 25;
export const OUTBOX_ALARM_MAX_MS = 2_000;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const OUTBOX_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type OutboxFaultMode = "none" | "fail-once" | "hold-before-ack";

interface KraterOutboxStub {
  fetch(request: Request): Promise<Response>;
}

interface KraterOutboxNamespace {
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
}

interface OutboxCommand {
  faultMode: OutboxFaultMode;
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
 * Explicit post-transaction handoff seam. Production wiring owns the binding;
 * Krater does not define a namespace or mount a class in the shared Worker.
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

/**
 * Unmounted production-shaped Durable Object. The shared app entrypoint must
 * explicitly export/mount this class and bind KRATER_OUTBOX before deployment.
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
    return (await this.state.storage.get<DurableCounters>("counters")) ?? emptyCounters();
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

  private async pendingRows(): Promise<PendingOutboxRow[]> {
    const rows = await statement(
      this.env.DB,
      `SELECT id, event_id, problem_id, kind, dedupe_key, payload_sha256
       FROM outbox WHERE state = 'pending' ORDER BY id ASC LIMIT ?`,
      OUTBOX_DRAIN_BATCH_SIZE,
    ).all<PendingOutboxRow>();
    return rows.results;
  }

  private async pendingCount(): Promise<number> {
    const row = await statement(
      this.env.DB,
      "SELECT COUNT(*) AS count FROM outbox WHERE state = 'pending'",
    ).first<CountRow>();
    return row?.count ?? 0;
  }

  private async isQuarantined(outboxId: number): Promise<boolean> {
    return (await this.state.storage.get<boolean>(`quarantine:${outboxId}`)) === true;
  }

  private async quarantine(
    row: PendingOutboxRow,
    code: NonNullable<ReturnType<typeof validateOutboxRow>>,
  ): Promise<void> {
    const key = `quarantine:${row.id}`;
    if (!(await this.isQuarantined(row.id))) {
      await this.state.storage.put(key, true);
      await this.updateCounters((current) => ({
        ...current,
        quarantined: current.quarantined + 1,
        last_quarantine_code: code,
        last_phase: "quarantined",
      }));
    }
  }

  private async acknowledge(row: PendingOutboxRow): Promise<boolean> {
    const result = await statement(
      this.env.DB,
      `UPDATE outbox SET state = 'delivered', delivered_at = ?
       WHERE id = ? AND state = 'pending'`,
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
        const rows = await this.pendingRows();
        let delivered = 0;
        let quarantined = 0;
        let faultMode = requestedFault;
        for (const row of rows) {
          if (await this.isQuarantined(row.id)) continue;
          const malformed = validateOutboxRow(row);
          if (malformed !== null) {
            await this.quarantine(row, malformed);
            quarantined += 1;
            continue;
          }

          await this.recordAttempt(row);
          if (faultMode === "hold-before-ack") {
            await this.state.storage.put("fault_mode", "none");
            await this.updateCounters((current) => ({ ...current, last_phase: "held-before-ack" }));
            await this.setAlarm(OUTBOX_ALARM_MAX_MS);
            return { source, delivered, quarantined, held_before_ack: true };
          }
          if (faultMode === "fail-once") {
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
          }
          faultMode = "none";
        }

        const pending = await this.pendingRows();
        const hasDeliverablePending = await Promise.all(
          pending.map(async (row) => !(await this.isQuarantined(row.id))),
        ).then((values) => values.some(Boolean));
        if (hasDeliverablePending) {
          await this.setAlarm(OUTBOX_ALARM_BASE_MS);
        } else {
          await this.state.storage.deleteAlarm();
        }
        return { source, delivered, quarantined, held_before_ack: false };
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
      alarm_at: await this.state.storage.getAlarm(),
    };
  }
}
