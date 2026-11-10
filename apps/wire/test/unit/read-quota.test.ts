// SQLite counter semantics; native Workerd/D1 behavior is covered separately.
import { afterEach, describe, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  admitFellowRead,
  FELLOW_READ_RATE_LIMIT,
  FELLOW_READ_RATE_WINDOW_MS,
  fellowReadBudgetHeaders,
  reserveFellowRead,
} from "../../src/sessions/read-quota";
import { migratedSqlite } from "../support/migrated-sqlite";

const databases: ReturnType<typeof migratedSqlite>[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function fixture() {
  const sqlite = migratedSqlite({ strict: true });
  databases.push(sqlite);
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (sqlite.prepare(query).get(...(values as any[])) ?? null) as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const count = (fellow = "F-ONE") =>
    (
      sqlite
        .query(
          "SELECT json_array_length(admitted_at_json) AS n FROM fellow_read_windows WHERE fellow_id = ?",
        )
        .get(fellow) as { n: number } | null
    )?.n ?? 0;
  return { db, sqlite, count };
}

const NOW = 1_800_000_000_000;

describe("Fellow rolling read admission", () => {
  test("competing reads share exactly 120 slots and other Fellows retain their own allowance", async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 140 }, () => reserveFellowRead(f.db, "F-ONE", NOW)),
    );
    expect(results.filter((result) => result.admitted)).toHaveLength(120);
    expect(results.filter((result) => !result.admitted)).toHaveLength(20);
    expect(
      results.filter((result) => result.admitted).map((result) => result.budget.remaining),
    ).toEqual(Array.from({ length: 120 }, (_, index) => 119 - index));
    expect(results[139]).toEqual({
      admitted: false,
      budget: { limit: 120, remaining: 0, window_seconds: 60, retry_after_seconds: 60 },
    });
    expect(f.count()).toBe(120);
    expect(await reserveFellowRead(f.db, "F-TWO", NOW)).toEqual({
      admitted: true,
      budget: { limit: 120, remaining: 119, window_seconds: 60 },
    });
    expect(f.count("F-TWO")).toBe(1);
  });

  test("every identical read consumes a slot; expiry frees only the elapsed timestamps", async () => {
    const f = fixture();
    for (let index = 0; index < 120; index++)
      await reserveFellowRead(f.db, "F-ONE", NOW + index * 100);
    expect(await reserveFellowRead(f.db, "F-ONE", NOW + 59_999)).toEqual({
      admitted: false,
      budget: { limit: 120, remaining: 0, window_seconds: 60, retry_after_seconds: 1 },
    });
    expect(await reserveFellowRead(f.db, "F-ONE", NOW + FELLOW_READ_RATE_WINDOW_MS)).toEqual({
      admitted: true,
      budget: { limit: 120, remaining: 0, window_seconds: 60, retry_after_seconds: 1 },
    });
    expect(
      (await reserveFellowRead(f.db, "F-ONE", NOW + FELLOW_READ_RATE_WINDOW_MS)).admitted,
    ).toBe(false);
    expect(f.count()).toBe(120);
    expect(await reserveFellowRead(f.db, "F-ONE", NOW + 120_000)).toEqual({
      admitted: true,
      budget: { limit: 120, remaining: 119, window_seconds: 60 },
    });
    expect(f.count()).toBe(1);
  });

  test("future timestamps remain charged and retry waits for their earliest expiry", async () => {
    const f = fixture();
    f.sqlite
      .query("INSERT INTO fellow_read_windows VALUES (?, ?)")
      .run("F-ONE", JSON.stringify(Array.from({ length: 120 }, () => NOW + 10_000)));
    const result = await reserveFellowRead(f.db, "F-ONE", NOW);
    expect(result).toEqual({
      admitted: false,
      budget: { limit: 120, remaining: 0, window_seconds: 60, retry_after_seconds: 70 },
    });
    expect(fellowReadBudgetHeaders(result.budget)).toEqual({
      "ratelimit-limit": "120",
      "ratelimit-remaining": "0",
      "ratelimit-reset": "70",
    });
  });

  test("malformed persisted windows never reset into a fresh allowance", async () => {
    const f = fixture();
    // Explicit corrupted-storage fault injection, beyond the migration CHECK.
    f.sqlite.exec("PRAGMA ignore_check_constraints = ON");
    const malformed = [
      "not json",
      "{}",
      "[]",
      "null",
      '["1800000000000"]',
      "[1]",
      "[null]",
      "[true]",
      "[1800000000000.5]",
      "[9007199254740992]",
      JSON.stringify(Array.from({ length: 121 }, () => NOW)),
      `[${" ".repeat(2161)}${NOW}]`,
    ];
    for (const [index, value] of malformed.entries()) {
      const fellow = `F-CORRUPT-${index}`;
      f.sqlite.query("INSERT INTO fellow_read_windows VALUES (?, ?)").run(fellow, value);
      await expect(reserveFellowRead(f.db, fellow, NOW)).rejects.toThrow();
      expect(
        f.sqlite
          .query("SELECT admitted_at_json FROM fellow_read_windows WHERE fellow_id = ?")
          .get(fellow),
      ).toEqual({ admitted_at_json: value });
    }
  });

  test("unavailable stores fail closed, with a private retryable 503", async () => {
    const absent = await admitFellowRead(undefined, "F-ONE");
    expect(absent).toBeInstanceOf(Response);
    const f = fixture();
    f.sqlite.exec(
      "CREATE TRIGGER fail_read_admission BEFORE INSERT ON fellow_read_windows BEGIN SELECT RAISE(ABORT, 'injected-read-store-fault'); END",
    );
    const failed = await admitFellowRead(f.db, "F-ONE");
    for (const response of [absent, failed]) {
      if (!(response instanceof Response)) throw new Error("Expected admission refusal");
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("retry-after")).toBe("1");
      expect(ProblemDocumentSchema.parse(await response.json()).code).toBe("INTERNAL_ERROR");
    }
    expect(f.count()).toBe(0);
  });

  test("exhaustion returns the teaching contract, exact budget and retry headers", async () => {
    const f = fixture();
    const now = Date.now();
    f.sqlite
      .query("INSERT INTO fellow_read_windows VALUES (?, ?)")
      .run("F-ONE", JSON.stringify(Array.from({ length: FELLOW_READ_RATE_LIMIT }, () => now)));
    const response = await admitFellowRead(f.db, "F-ONE");
    if (!(response instanceof Response)) throw new Error("Expected rate refusal");
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("ratelimit-limit")).toBe("120");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    const retry = Number(response.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(response.headers.get("ratelimit-reset")).toBe(String(retry));
    const problem = ProblemDocumentSchema.parse(await response.json());
    expect(problem).toMatchObject({ code: "RATE_LIMITED", rule: "A5" });
    expect(problem.fix_hint).toContain("public cursor");
    expect(problem).toHaveProperty("schema");
    expect(problem).toHaveProperty("example");
    expect(f.count()).toBe(120);
  });

  test("invalid clocks refuse before touching the counter", async () => {
    const f = fixture();
    for (const now of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(reserveFellowRead(f.db, "F-ONE", now)).rejects.toThrow("CLOCK_INVALID");
    expect(f.count()).toBe(0);
  });
});
