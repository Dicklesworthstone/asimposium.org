// SQLite transaction/unit coverage; Workerd/D1/R2 is a separate native lane.
import { describe, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  getWorkshopBudget,
  reserveWorkshopWrite,
  WORKSHOP_RATE_WINDOW_MS,
  workshopRateLimitedProblem,
} from "../../src/sessions/workshop-quota";
import { migratedSqlite } from "../support/migrated-sqlite";

function fixture() {
  const sqlite = migratedSqlite({ strict: true });
  let tail: Promise<unknown> = Promise.resolve();
  const prepare = (query: string) => {
    const bound = (values: unknown[]) => ({
      async run() {
        const result = sqlite.prepare(query).run(...(values as any[]));
        return { success: true, results: [], meta: { changes: result.changes } };
      },
      async first<T>() {
        return (sqlite.prepare(query).get(...(values as any[])) ?? null) as T | null;
      },
    });
    return { ...bound([]), bind: (...values: unknown[]) => bound(values) };
  };
  const db = {
    prepare,
    batch(statements: readonly { run(): Promise<unknown> }[]) {
      const result = tail.then(async () => {
        sqlite.run("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.run("COMMIT");
          return results;
        } catch (error) {
          sqlite.run("ROLLBACK");
          throw error;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

const NOW = 1_800_000_000_000;
const input = (key: string, now = NOW, fellowId = "fellow-one") => ({
  fellowId,
  idempotencyKey: key,
  requestDigest: `request-${key}`,
  now,
});

describe("workshop rolling admission", () => {
  test("competing requests cannot exceed 60 and each Fellow has its own allowance", async () => {
    const { db, sqlite } = fixture();
    try {
      const results = await Promise.all(
        Array.from({ length: 80 }, (_, index) => reserveWorkshopWrite(db, input(`race-${index}`))),
      );
      expect(results.filter((result) => result.status === "admitted")).toHaveLength(60);
      expect(results.filter((result) => result.status === "limited")).toHaveLength(20);
      expect(await getWorkshopBudget(db, "fellow-one", NOW)).toEqual({
        limit: 60,
        remaining: 0,
        window_seconds: 60,
        retry_after_seconds: 60,
      });
      expect(await reserveWorkshopWrite(db, input("peer", NOW, "fellow-two"))).toEqual({
        status: "admitted",
      });
      expect(sqlite.query("SELECT COUNT(*) AS n FROM workshop_write_attempts").get()).toEqual({
        n: 61,
      });
    } finally {
      sqlite.close();
    }
  });

  test("same in-flight key is charged once and a changed payload never gets admission", async () => {
    const { db, sqlite } = fixture();
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => reserveWorkshopWrite(db, input("shared"))),
      );
      expect(results.filter((result) => result.status === "admitted")).toHaveLength(1);
      expect(results.filter((result) => result.status === "pending")).toHaveLength(7);
      expect(
        await reserveWorkshopWrite(db, { ...input("shared"), requestDigest: "changed-payload" }),
      ).toEqual({ status: "conflict" });
      expect((await getWorkshopBudget(db, "fellow-one", NOW)).remaining).toBe(59);
      for (let index = 0; index < 59; index++)
        await reserveWorkshopWrite(db, input(`fill-${index}`));
      expect(await reserveWorkshopWrite(db, input("shared"))).toEqual({ status: "pending" });
      expect((await getWorkshopBudget(db, "fellow-one", NOW)).remaining).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("rolling expiry admits only the expired slots and bounds retained rows", async () => {
    const { db, sqlite } = fixture();
    try {
      for (let index = 0; index < 60; index++)
        await reserveWorkshopWrite(db, input(`stagger-${index}`, NOW + index * 100));
      expect(await getWorkshopBudget(db, "fellow-one", NOW + 59_999)).toMatchObject({
        remaining: 0,
        retry_after_seconds: 1,
      });
      expect(await getWorkshopBudget(db, "fellow-one", NOW + WORKSHOP_RATE_WINDOW_MS)).toEqual({
        limit: 60,
        remaining: 1,
        window_seconds: 60,
      });
      expect(
        await reserveWorkshopWrite(db, input("new-window", NOW + WORKSHOP_RATE_WINDOW_MS)),
      ).toEqual({ status: "admitted" });
      expect(
        await reserveWorkshopWrite(db, input("still-full", NOW + WORKSHOP_RATE_WINDOW_MS)),
      ).toMatchObject({ status: "limited", budget: { remaining: 0, retry_after_seconds: 1 } });
      expect(sqlite.query("SELECT COUNT(*) AS n FROM workshop_write_attempts").get()).toEqual({
        n: 60,
      });
    } finally {
      sqlite.close();
    }
  });

  test("D1 failure, missing migration and a clock error cannot grant capacity", async () => {
    const { db, sqlite } = fixture();
    try {
      const unavailable = {
        ...db,
        batch: async () => {
          throw new Error("storage unavailable");
        },
      } as D1Database;
      await expect(reserveWorkshopWrite(unavailable, input("unavailable"))).rejects.toThrow();
      await expect(reserveWorkshopWrite(db, input("bad-clock", Number.NaN))).rejects.toThrow(
        "WORKSHOP_RATE_CLOCK_INVALID",
      );
      expect((await getWorkshopBudget(db, "fellow-one", NOW)).remaining).toBe(60);
      const missing = {
        prepare: () => {
          throw new Error("no such table");
        },
      } as unknown as D1Database;
      await expect(reserveWorkshopWrite(missing, input("missing"))).rejects.toThrow();
    } finally {
      sqlite.close();
    }
  });

  test("quota refusal teaches retry without echoing a key or private body", async () => {
    const response = workshopRateLimitedProblem({
      limit: 60,
      remaining: 0,
      window_seconds: 60,
      retry_after_seconds: 7,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(ProblemDocumentSchema.parse(await response.json())).toMatchObject({
      code: "RATE_LIMITED",
      limit: 60,
      remaining: 0,
      window_seconds: 60,
      retry_after_seconds: 7,
      rule: "A5",
    });
  });
});
