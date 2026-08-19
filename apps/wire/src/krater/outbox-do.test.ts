import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const KRATER_MIGRATION = resolve(import.meta.dir, "../../../../db/migrations/0001_krater_v0.sql");
const QUARANTINE_MIGRATION = resolve(
  import.meta.dir,
  "../../../../db/migrations/0007_outbox_quarantine_state.sql",
);

interface FakeOutboxRow {
  readonly id: number;
  readonly event_id: string;
  readonly problem_id: string;
  readonly kind: string;
  readonly dedupe_key: string;
  readonly payload_sha256: string;
  state: "pending" | "delivered";
  created_at: string;
  delivered_at: string | null;
  quarantined_at: string | null;
  quarantine_code: string | null;
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

function outboxRow(id: number, valid = true, createdAt?: string): FakeOutboxRow {
  const eventId = `E-outbox-${id}`;
  return {
    id,
    event_id: eventId,
    problem_id: "P-outbox",
    kind: valid ? "search.index" : "malformed",
    dedupe_key: `search.index:${eventId}`,
    payload_sha256: "a".repeat(64),
    state: "pending",
    created_at: createdAt ?? new Date().toISOString(),
    delivered_at: null,
    quarantined_at: null,
    quarantine_code: null,
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
          if (
            !sql.includes("FROM outbox") ||
            !sql.includes("state = 'pending' AND quarantined_at IS NULL AND id > ?")
          ) {
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
                row.quarantined_at === null &&
                row.id > afterId &&
                (throughId === undefined || row.id <= throughId),
            )
            .sort((left, right) => left.id - right.id)
            .slice(0, limit);
          return { results: results as T[], success: true, meta: {} };
        },
        first: async <T>() => {
          if (
            sql.includes(
              "SELECT COUNT(*) AS count FROM outbox WHERE state = 'pending' AND quarantined_at IS NULL",
            )
          ) {
            return {
              count: rows.filter((row) => row.state === "pending" && row.quarantined_at === null)
                .length,
            } as T;
          }
          if (
            sql.includes(
              "SELECT MIN(created_at) AS oldest FROM outbox WHERE state = 'pending' AND quarantined_at IS NULL",
            )
          ) {
            const pendingRows = rows.filter(
              (row) => row.state === "pending" && row.quarantined_at === null,
            );
            const oldest = pendingRows
              .map((row) => row.created_at)
              .sort()
              .at(0);
            return { oldest: oldest ?? null } as T;
          }
          throw new Error(`unexpected first query: ${sql}`);
        },
        run: async () => {
          if (sql.includes("SET quarantined_at = ?")) {
            const [quarantinedAt, quarantineCode, id] = bindings;
            const row = rows.find(
              (candidate) =>
                candidate.id === id &&
                candidate.state === "pending" &&
                candidate.quarantined_at === null,
            );
            if (
              row !== undefined &&
              typeof quarantinedAt === "string" &&
              typeof quarantineCode === "string"
            ) {
              row.quarantined_at = quarantinedAt;
              row.quarantine_code = quarantineCode;
            }
            return { success: true, meta: { changes: row === undefined ? 0 : 1 } };
          }
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
            (candidate) =>
              candidate.id === id &&
              candidate.state === "pending" &&
              candidate.quarantined_at === null,
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
  test("0007 preserves existing rows and makes quarantine terminal without rebuilding outbox", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec(readFileSync(KRATER_MIGRATION, "utf8"));
    sqlite
      .prepare("INSERT INTO problems (id, created_at, updated_at) VALUES (?, ?, ?)")
      .run("P-outbox", "2026-08-14T00:00:00Z", "2026-08-14T00:00:00Z");
    for (const id of [1, 2]) {
      sqlite
        .prepare(
          `INSERT INTO events (
             id, problem_id, seq, type, object_kind, object_id,
             object_version, payload_sha256, created_at
           ) VALUES (?, 'P-outbox', ?, 'claim.promoted', 'claim', ?, 1, ?, ?)`,
        )
        .run(`E-outbox-${id}`, id, `C-outbox-${id}`, "a".repeat(64), "2026-08-14T00:00:00Z");
    }
    sqlite
      .prepare(
        `INSERT INTO outbox (
           id, event_id, problem_id, kind, dedupe_key, payload_sha256,
           state, created_at, delivered_at
         ) VALUES
           (1, 'E-outbox-1', 'P-outbox', 'search.index', 'search.index:E-outbox-1', ?,
            'pending', '2026-08-14T00:00:00Z', NULL),
           (2, 'E-outbox-2', 'P-outbox', 'search.index', 'search.index:E-outbox-2', ?,
            'delivered', '2026-08-14T00:00:00Z', '2026-08-14T00:01:00Z')`,
      )
      .run("a".repeat(64), "b".repeat(64));

    sqlite.exec(readFileSync(QUARANTINE_MIGRATION, "utf8"));

    expect(
      sqlite
        .prepare<
          {
            id: number;
            state: string;
            quarantined_at: string | null;
            quarantine_code: string | null;
          },
          []
        >("SELECT id, state, quarantined_at, quarantine_code FROM outbox ORDER BY id")
        .all(),
    ).toEqual([
      { id: 1, state: "pending", quarantined_at: null, quarantine_code: null },
      { id: 2, state: "delivered", quarantined_at: null, quarantine_code: null },
    ]);
    sqlite
      .prepare("UPDATE outbox SET quarantined_at = ?, quarantine_code = ? WHERE id = 1")
      .run("2026-08-14T00:02:00Z", "OUTBOX_PAYLOAD_INVALID");
    expect(() =>
      sqlite
        .prepare("UPDATE outbox SET state = 'delivered', delivered_at = ? WHERE id = 1")
        .run("2026-08-14T00:03:00Z"),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare("UPDATE outbox SET quarantined_at = ?, quarantine_code = ? WHERE id = 2")
        .run("2026-08-14T00:02:00Z", "OUTBOX_PAYLOAD_INVALID"),
    ).toThrow();
    expect(
      sqlite
        .prepare<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .some((row) => row.name === "outbox_drainable_idx"),
    ).toBe(true);
  });

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

  test("the local stale-wrap fixture accepts only a forward bounded cursor interval", async () => {
    const harness = outboxHarness([]);
    const fixtureRequest = (scanAfterId: number, scanWrapThroughId: number) =>
      new Request("https://krater-outbox.internal/__s2/plant-stale-wrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scan_after_id: scanAfterId,
          scan_wrap_through_id: scanWrapThroughId,
        }),
      });

    for (const [scanAfterId, scanWrapThroughId] of [
      [2, 2],
      [2, 1],
      [-1, 2],
    ] as const) {
      const refused = await harness.drainer.fetch(fixtureRequest(scanAfterId, scanWrapThroughId));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ code: "KRATER_OUTBOX_STALE_WRAP_FIXTURE_INVALID" });
    }

    const planted = await harness.drainer.fetch(fixtureRequest(8, 20));
    expect(planted.status).toBe(201);
    expect(await planted.json()).toEqual({ planted: true });
    expect(harness.storageValue("scan_after_id")).toBe(8);
    expect(harness.storageValue("scan_wrap_through_id")).toBe(20);
    expect(harness.storageValue("fault_mode")).toBe("hold-before-ack");
    expect(harness.alarmAt()).toBeNull();
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
    expect(
      rows
        .slice(0, OUTBOX_DRAIN_BATCH_SIZE)
        .every((row) => row.state === "pending" && row.quarantined_at !== null),
    ).toBe(true);
    expect(rows.at(-1)?.state).toBe("pending");

    const second = await harness.drainer.fetch(drainRequest());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ delivered: 1, quarantined: 0 });
    expect(rows.at(-1)?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    const status = await harness.drainer.fetch(
      new Request("https://krater-outbox.internal/status", { method: "GET" }),
    );
    expect(await status.json()).toMatchObject({ pending: 0, quarantined: OUTBOX_DRAIN_BATCH_SIZE });
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

  test("PLANTED: an alarm ACK failure uses only the durably re-armed bounded retry", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, { acknowledgeFailures: 1 });

    await expect(harness.drainer.alarm()).resolves.toBeUndefined();

    expect(rows[0]?.state).toBe("pending");
    expect(harness.alarmAt()).not.toBeNull();
    expect(harness.storageValue("counters")).toMatchObject({
      failures: 1,
      last_backoff_ms: OUTBOX_ALARM_BASE_MS,
      last_phase: "retry",
    });

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
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

  test("PLANTED: an equal wrap checkpoint left by a crash cannot strand lower rows", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: {
        scan_after_id: 101,
        scan_wrap_through_id: 101,
      },
    });

    const response = await harness.drainer.fetch(drainRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: 1 });
    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
    expect(harness.storageValue("scan_after_id")).toBe(1);
    expect(harness.storageValue("scan_wrap_through_id")).toBeUndefined();
  });

  test("PLANTED: a completed stale wrap cannot clear the only alarm above restored D1 work", async () => {
    const rows = [outboxRow(1)];
    const harness = outboxHarness(rows, {
      initialStorage: {
        scan_after_id: 8,
        scan_wrap_through_id: 20,
      },
    });

    const first = await harness.drainer.fetch(drainRequest());

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ delivered: 0, quarantined: 0 });
    expect(rows[0]?.state).toBe("pending");
    expect(harness.storageValue("scan_after_id")).toBe(0);
    expect(harness.storageValue("scan_wrap_through_id")).toBeUndefined();
    expect(harness.alarmAt()).not.toBeNull();

    await harness.drainer.alarm();

    expect(rows[0]?.state).toBe("delivered");
    await drainScheduledAlarms(harness);
  });
});

test("the status face exposes the oldest-pending lag metric (W2.5)", async () => {
  // A row created 5s ago and a fresh one: the lag is the OLDEST pending age.
  const old = outboxRow(1, true, new Date(Date.now() - 5000).toISOString());
  const fresh = outboxRow(2, true, new Date().toISOString());
  const harness = outboxHarness([old, fresh]);
  const status = await harness.drainer.fetch(
    new Request("https://krater-outbox.internal/status", { method: "GET" }),
  );
  expect(status.status).toBe(200);
  const body = (await status.json()) as { pending: number; oldest_pending_age_ms: number };
  expect(body.pending).toBe(2);
  // The lag reflects the 5s-old row, not the fresh one (within timing slack).
  expect(body.oldest_pending_age_ms).toBeGreaterThanOrEqual(4000);
});

test("an empty queue reports zero lag", async () => {
  const harness = outboxHarness([]);
  const status = await harness.drainer.fetch(
    new Request("https://krater-outbox.internal/status", { method: "GET" }),
  );
  const body = (await status.json()) as { pending: number; oldest_pending_age_ms: number };
  expect(body.pending).toBe(0);
  expect(body.oldest_pending_age_ms).toBe(0);
});
