import { describe, expect, test } from "bun:test";
import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectState,
} from "@cloudflare/workers-types";
import {
  boundedOutboxBackoff,
  KraterOutboxDrainer,
  OUTBOX_ALARM_BASE_MS,
  OUTBOX_ALARM_MAX_MS,
  OUTBOX_DRAIN_BATCH_SIZE,
  validateOutboxRow,
} from "./outbox-do";

interface FakeOutboxRow {
  readonly id: number;
  readonly event_id: string;
  readonly problem_id: string;
  readonly kind: string;
  readonly dedupe_key: string;
  readonly payload_sha256: string;
  state: "pending" | "delivered";
  delivered_at: string | null;
}

interface OutboxHarness {
  readonly drainer: KraterOutboxDrainer;
  readonly alarmAt: () => number | null;
  readonly storageValue: (key: string) => unknown;
}

interface OutboxHarnessOptions {
  readonly initialStorage?: Readonly<Record<string, unknown>>;
  readonly acknowledgeFailures?: number;
  readonly acknowledgeZeroChanges?: number;
}

function outboxRow(id: number, valid = true): FakeOutboxRow {
  const eventId = `E-outbox-${id}`;
  return {
    id,
    event_id: eventId,
    problem_id: "P-outbox",
    kind: valid ? "search.index" : "malformed",
    dedupe_key: `search.index:${eventId}`,
    payload_sha256: "a".repeat(64),
    state: "pending",
    delivered_at: null,
  };
}

function outboxHarness(rows: FakeOutboxRow[], options: OutboxHarnessOptions = {}): OutboxHarness {
  const storage = new Map<string, unknown>(Object.entries(options.initialStorage ?? {}));
  let acknowledgeFailures = options.acknowledgeFailures ?? 0;
  let acknowledgeZeroChanges = options.acknowledgeZeroChanges ?? 0;
  let alarmAt: number | null = null;

  const durableState = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries === "string") storage.set(keyOrEntries, value);
        else for (const [key, entry] of Object.entries(keyOrEntries)) storage.set(key, entry);
      },
      delete: async (key: string) => storage.delete(key),
      setAlarm: async (scheduledTime: number) => {
        alarmAt = scheduledTime;
      },
      deleteAlarm: async () => {
        alarmAt = null;
      },
      getAlarm: async () => alarmAt,
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;

  const database = {
    prepare: (sql: string) => {
      let bindings: readonly unknown[] = [];
      const prepared = {
        bind: (...values: unknown[]) => {
          bindings = values;
          return prepared as unknown as D1PreparedStatement;
        },
        all: async <T>() => {
          if (!sql.includes("FROM outbox") || !sql.includes("state = 'pending' AND id > ?")) {
            throw new Error(`unexpected all query: ${sql}`);
          }
          const [afterId, middle, final] = bindings;
          const throughId = sql.includes("AND id <= ?") ? middle : undefined;
          const limit = throughId === undefined ? middle : final;
          if (
            typeof afterId !== "number" ||
            (throughId !== undefined && typeof throughId !== "number") ||
            typeof limit !== "number"
          ) {
            throw new Error("outbox page bindings missing");
          }
          const results = rows
            .filter(
              (row) =>
                row.state === "pending" &&
                row.id > afterId &&
                (throughId === undefined || row.id <= throughId),
            )
            .sort((left, right) => left.id - right.id)
            .slice(0, limit);
          return { results: results as T[], success: true, meta: {} };
        },
        run: async () => {
          if (!sql.includes("UPDATE outbox SET state = 'delivered'")) {
            throw new Error(`unexpected run query: ${sql}`);
          }
          if (acknowledgeFailures > 0) {
            acknowledgeFailures -= 1;
            throw new Error("PLANTED_D1_ACKNOWLEDGEMENT_FAILURE");
          }
          if (acknowledgeZeroChanges > 0) {
            acknowledgeZeroChanges -= 1;
            return { success: true, meta: { changes: 0 } };
          }
          const [deliveredAt, id] = bindings;
          const row = rows.find(
            (candidate) => candidate.id === id && candidate.state === "pending",
          );
          if (row !== undefined && typeof deliveredAt === "string") {
            row.state = "delivered";
            row.delivered_at = deliveredAt;
          }
          return { success: true, meta: { changes: row === undefined ? 0 : 1 } };
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;

  return {
    drainer: new KraterOutboxDrainer(durableState, { DB: database }),
    alarmAt: () => alarmAt,
    storageValue: (key) => storage.get(key),
  };
}

function drainRequest(faultMode: "none" | "fail-once" = "none"): Request {
  return new Request("https://krater-outbox.internal/drain-now", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault_mode: faultMode }),
  });
}

async function drainScheduledAlarms(harness: OutboxHarness): Promise<void> {
  for (let attempts = 0; attempts < 16 && harness.alarmAt() !== null; attempts += 1) {
    await harness.drainer.alarm();
  }
  expect(harness.alarmAt()).toBeNull();
}

describe("Krater outbox Durable Object contracts", () => {
  test("keeps exponential alarm backoff inside the explicit local safety bound", () => {
    expect(boundedOutboxBackoff(1)).toBe(OUTBOX_ALARM_BASE_MS);
    expect(boundedOutboxBackoff(2)).toBe(OUTBOX_ALARM_BASE_MS * 2);
    expect(boundedOutboxBackoff(99)).toBe(OUTBOX_ALARM_MAX_MS);
    expect(() => boundedOutboxBackoff(0)).toThrow("KRATER_OUTBOX_BACKOFF_INVALID");
  });

  test("rejects malformed rows before a Durable Object can acknowledge them", () => {
    const valid = {
      event_id: "E-outbox-001",
      kind: "search.index",
      dedupe_key: "search.index:E-outbox-001",
      payload_sha256: "a".repeat(64),
    };
    expect(validateOutboxRow(valid)).toBeNull();
    expect(validateOutboxRow({ ...valid, payload_sha256: "malformed" })).toBe(
      "OUTBOX_PAYLOAD_INVALID",
    );
    expect(validateOutboxRow({ ...valid, kind: "other" })).toBe("OUTBOX_KIND_INVALID");
    expect(validateOutboxRow({ ...valid, dedupe_key: "wrong" })).toBe("OUTBOX_DEDUPE_INVALID");
  });

  test("PLANTED: a full quarantined page cannot starve the next valid pending row", async () => {
    const rows = [
      ...Array.from({ length: OUTBOX_DRAIN_BATCH_SIZE }, (_, index) => outboxRow(index + 1, false)),
      outboxRow(OUTBOX_DRAIN_BATCH_SIZE + 1),
    ];
    const harness = outboxHarness(rows);

    const first = await harness.drainer.fetch(drainRequest());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      delivered: 0,
      quarantined: OUTBOX_DRAIN_BATCH_SIZE,
      held_before_ack: false,
    });
    expect(harness.alarmAt()).not.toBeNull();
    expect(rows.at(-1)?.state).toBe("pending");

    const second = await harness.drainer.fetch(drainRequest());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ delivered: 1, quarantined: 0 });
    expect(rows.at(-1)?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    expect(harness.storageValue("scan_after_id")).toBe(OUTBOX_DRAIN_BATCH_SIZE + 1);
  });

  test("a retry fault never advances the durable scan cursor past the unacknowledged row", async () => {
    const rows = [outboxRow(1, false), outboxRow(2)];
    const harness = outboxHarness(rows);

    const failed = await harness.drainer.fetch(drainRequest("fail-once"));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ delivered: 0, retry_scheduled_ms: 25 });
    expect(harness.storageValue("scan_after_id")).toBe(1);
    expect(rows[1]?.state).toBe("pending");

    const retried = await harness.drainer.fetch(drainRequest());
    expect(await retried.json()).toMatchObject({ delivered: 1 });
    expect(rows[1]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
  });

  test("a stale cursor beyond the restored D1 range wraps before declaring the outbox empty", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, { initialStorage: { scan_after_id: 999 } });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1 });
    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    expect(harness.storageValue("scan_after_id")).toBe(1);
  });

  test("PLANTED: corrupt derived cursor state cannot wedge authoritative D1 work", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: { scan_after_id: "not-an-integer" },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1 });
    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    expect(harness.storageValue("scan_after_id")).toBe(1);
  });

  test("PLANTED: an actual D1 acknowledgement failure re-arms and retries through alarm()", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, { acknowledgeFailures: 1 });

    const failed = await harness.drainer.fetch(drainRequest());

    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ code: "PLANTED_D1_ACKNOWLEDGEMENT_FAILURE" });
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue("scan_after_id") ?? 0).toBe(0);
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 1,
      last_backoff_ms: OUTBOX_ALARM_BASE_MS,
      last_phase: "retry",
    });
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue("counters")).toMatchObject({
      delivered: 1,
      failures: 0,
      last_backoff_ms: null,
      last_phase: "delivered",
    });
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: a zero-change acknowledgement retains the pending row for alarm retry", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, { acknowledgeZeroChanges: 1 });

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ delivered: 0, retry_scheduled_ms: 25 });
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue("scan_after_id") ?? 0).toBe(0);
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: stale quarantine state cannot suppress a different restored row", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: {
        "quarantine:1": JSON.stringify([
          rows[0]?.event_id,
          "malformed",
          rows[0]?.dedupe_key,
          rows[0]?.payload_sha256,
        ]),
      },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1, quarantined: 0 });
    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
  });

  test("PLANTED: corrupt diagnostic counters cannot disable failure re-arming", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      acknowledgeFailures: 1,
      initialStorage: { counters: { failures: "not-a-number" } },
    });

    const failed = await harness.drainer.fetch(drainRequest());

    expect(failed.status).toBe(400);
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 1,
      last_backoff_ms: OUTBOX_ALARM_BASE_MS,
      last_phase: "retry",
    });
    expect(harness.alarmAt()).not.toBeNull();
  });

  test("PLANTED: a mixed restore range wraps before clearing the only alarm", async () => {
    const rows = [outboxRow(1), outboxRow(101)];
    const harness = outboxHarness(rows, {
      initialStorage: { scan_after_id: 100 },
    });

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(rows[0]?.state).toBe("pending");
    expect(rows[1]?.state).toBe("delivered");
    expect(harness.alarmAt()).not.toBeNull();

    await drainScheduledAlarms(harness);

    expect(rows[0]?.state).toBe("delivered");
    expect(harness.storageValue("scan_after_id")).toBe(101);
  });
});
