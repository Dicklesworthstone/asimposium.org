import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import {
  LEASE_WARNING_SWEEP_LIMIT,
  LEASE_WARNING_WINDOW_MS,
  warnExpiringLeases,
} from "../../src/sessions/lease-warnings.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const migration = (name: string) =>
  readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8");

// Shipped lease/inbox DDL with minimal identity fixtures. These tests execute
// the production SQL in SQLite; the session-presence journey owns native D1 proof.
function fixture() {
  const sql = new Database(":memory:", { strict: true });
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
    INSERT INTO enrollment_fellows VALUES ('fellow-active', 'active'), ('fellow-paused', 'paused');
    INSERT INTO problems VALUES ('P-PUBLIC', 'active'), ('P-PRIVATE', 'private-draft');
    INSERT INTO sessions VALUES ('S-test');`);
  const leases = migration("0056_leases_and_replay_scope.sql");
  const start = leases.indexOf("CREATE TABLE leases (");
  if (start < 0) throw new Error("The shipped lease table is required");
  sql.exec(leases.slice(start));
  sql.exec(migration("0064_inbox_and_follows.sql"));
  let beforeBatch: (() => void) | undefined;
  const batches: number[] = [];
  function prepare(text: string) {
    let values: (string | number | null)[] = [];
    return {
      bind(...bound: (string | number | null)[]) {
        values = bound;
        return this;
      },
      async all() {
        return { success: true, results: sql.query(text).all(...values) };
      },
      execute() {
        return { success: true, meta: { changes: sql.query(text).run(...values).changes } };
      },
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      batches.push(statements.length);
      const hook = beforeBatch;
      beforeBatch = undefined;
      hook?.();
      return sql.transaction(() => statements.map((statement) => statement.execute()))();
    },
  } as unknown as D1Database;
  const add = (
    id: string,
    options: { fellow?: string; problem?: string; status?: string; deadline?: number } = {},
  ) => {
    sql
      .query(`INSERT INTO leases (lease_id, problem_id, object_ref, object_kind, object_id,
        session_id, fellow_id, sponsor_id, objective, deliverable, status,
        leased_at, leased_until, created_at, updated_at)
        VALUES (?, ?, 'C-1', 'claim', 'C-1', 'S-test', ?, 'sponsor-test',
          'PRIVATE_OBJECTIVE', 'PRIVATE_DELIVERABLE', ?, ?, ?, ?, ?)`)
      .run(
        id,
        options.problem ?? "P-PUBLIC",
        options.fellow ?? "fellow-active",
        options.status ?? "active",
        iso(-60_000),
        iso(options.deadline ?? 60_000),
        iso(-60_000),
        iso(-60_000),
      );
  };
  return {
    sql,
    db,
    add,
    batches,
    notices: () => sql.query("SELECT * FROM fellow_inbox_notices ORDER BY seq").all(),
    before: (hook: () => void) => {
      beforeBatch = hook;
    },
  };
}

async function withFixture(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    await run(f);
  } finally {
    f.sql.close();
  }
}

describe("lease expiry warning eligibility", () => {
  for (const [label, ineligible] of [
    ["paused Fellows", { fellow: "fellow-paused" }],
    ["private drafts", { problem: "P-PRIVATE" }],
  ] as const) {
    test(`more than a full batch of ${label} cannot starve an eligible lease`, async () => {
      await withFixture(async (f) => {
        for (let index = 0; index <= LEASE_WARNING_SWEEP_LIMIT; index++)
          f.add(`L-ineligible-${index}`, ineligible);
        f.add("L-eligible", { deadline: 120_000, status: "challenged" });

        expect(await warnExpiringLeases(f.db, { now: NOW })).toEqual({
          warned: 1,
          hasMore: false,
        });
        expect(f.batches).toEqual([1]);
        expect(f.notices()).toMatchObject([
          {
            fellow_id: "fellow-active",
            problem_id: "P-PUBLIC",
            target_id: "L-eligible",
            notice_type: "lease_expiry_warning",
            expires_at: NOW + 120_000,
          },
        ]);
        expect(JSON.stringify(f.notices())).not.toContain("P-PRIVATE");
        expect(JSON.stringify(f.notices())).not.toContain("PRIVATE_OBJECTIVE");
        expect(JSON.stringify(f.notices())).not.toContain("PRIVATE_DELIVERABLE");
        expect(await warnExpiringLeases(f.db, { now: NOW })).toEqual({
          warned: 0,
          hasMore: false,
        });
        expect(f.batches).toEqual([1]);
      });
    });
  }

  test("only eligible rows consume the bounded batch and remaining-work signal", async () => {
    await withFixture(async (f) => {
      f.add("L-inactive", { fellow: "fellow-paused" });
      f.add("L-private", { problem: "P-PRIVATE" });
      for (let index = 0; index <= LEASE_WARNING_SWEEP_LIMIT; index++)
        f.add(`L-active-${String(index).padStart(3, "0")}`, { deadline: 120_000 });
      expect(await warnExpiringLeases(f.db, { now: NOW })).toEqual({
        warned: LEASE_WARNING_SWEEP_LIMIT,
        hasMore: true,
      });
      expect(await warnExpiringLeases(f.db, { now: NOW })).toEqual({
        warned: 1,
        hasMore: false,
      });
      expect(f.batches).toEqual([LEASE_WARNING_SWEEP_LIMIT, 1]);
      expect(f.notices()).toHaveLength(LEASE_WARNING_SWEEP_LIMIT + 1);
    });
  });

  test("no eligible leases means no write batch or private warning", async () => {
    await withFixture(async (f) => {
      f.add("L-inactive", { fellow: "fellow-paused" });
      f.add("L-private", { problem: "P-PRIVATE" });
      f.add("L-released", { status: "released" });
      f.add("L-expired", { deadline: 0 });
      f.add("L-outside-window", { deadline: LEASE_WARNING_WINDOW_MS + 1 });
      expect(await warnExpiringLeases(f.db, { now: NOW })).toEqual({
        warned: 0,
        hasMore: false,
      });
      expect(f.batches).toEqual([]);
      expect(f.notices()).toEqual([]);
    });
  });

  for (const [label, mutation] of [
    ["Fellow pause", "UPDATE enrollment_fellows SET status = 'paused'"],
    ["problem becoming private", "UPDATE problems SET status = 'private-draft'"],
    ["lease release", "UPDATE leases SET status = 'released'"],
    ["lease renewal", `UPDATE leases SET leased_until = '${iso(LEASE_WARNING_WINDOW_MS + 1)}'`],
  ] as const) {
    test(`a ${label} between selection and commit still prevents the warning`, async () => {
      await withFixture(async (f) => {
        f.add("L-raced");
        f.before(() => f.sql.exec(mutation));
        expect(await warnExpiringLeases(f.db, { now: NOW })).toEqual({
          warned: 0,
          hasMore: false,
        });
        expect(f.batches).toEqual([1]);
        expect(f.notices()).toEqual([]);
      });
    });
  }

  test("overlapping sweeps retain one notice for the same lease term", async () => {
    await withFixture(async (f) => {
      f.add("L-on-boundary", { deadline: LEASE_WARNING_WINDOW_MS });
      const results = await Promise.all([
        warnExpiringLeases(f.db, { now: NOW }),
        warnExpiringLeases(f.db, { now: NOW }),
      ]);
      expect(results.reduce((total, result) => total + result.warned, 0)).toBe(1);
      expect(f.notices()).toHaveLength(1);
    });
  });
});
