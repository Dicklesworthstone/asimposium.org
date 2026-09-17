import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { expireIdleSessions, IDLE_SESSION_SWEEP_LIMIT } from "../../src/sessions/idle.ts";
import { recoverIdleSessionSlots } from "../../src/sessions/admission-recovery.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const migration = (name: string) =>
  readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8");

// Execute the production queries against SQLite and the relevant shipped DDL.
// The adapter models D1 batch rollback; it is not a deployed D1 integration test.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY);
    CREATE TABLE problems (id TEXT PRIMARY KEY);
    INSERT INTO enrollment_fellows VALUES ('fellow-a'), ('fellow-b');
    INSERT INTO problems VALUES ('P-DEMO');
    CREATE TABLE events (id TEXT PRIMARY KEY);
    INSERT INTO events VALUES ('existing-public-event');`);
  sql.exec(migration("0017_sessions_workshop_cursor.sql"));
  const leases = migration("0056_leases_and_replay_scope.sql");
  const start = leases.indexOf("CREATE TABLE leases (");
  expect(start).toBeGreaterThanOrEqual(0);
  sql.exec(leases.slice(start));
  sql.exec(migration("0064_inbox_and_follows.sql"));
  let beforeBatch: (() => void) | undefined;
  let failAt = -1;
  let batches = 0;
  function prepare(text: string) {
    let values: (string | number | null)[] = [];
    return {
      bind(...bound: (string | number | null)[]) { values = bound; return this; },
      async all() { return { results: sql.query(text).all(...values) }; },
      execute() { return { results: sql.query(text).all(...values) }; },
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      batches++;
      const hook = beforeBatch;
      beforeBatch = undefined;
      hook?.();
      sql.exec("BEGIN");
      try {
        const result = statements.map((statement, index) => {
          if (index === failAt) throw new Error("planted batch failure");
          return statement.execute();
        });
        sql.exec("COMMIT");
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const add = (id: string, deadline = iso(), fellow = "fellow-a") => {
    sql.query(`INSERT INTO sessions (session_id, fellow_id, problem_id,
      opened_at, last_heartbeat_at, idle_close_at) VALUES (?, ?, 'P-DEMO', ?, ?, ?)`)
      .run(id, fellow, iso(-86_400_000), iso(-43_200_000), deadline);
  };
  const lease = (id: string, session = "S-one", status = "active") => {
    sql.query(`INSERT INTO leases (lease_id, problem_id, object_ref, object_kind,
      object_id, session_id, fellow_id, sponsor_id, objective, deliverable, status,
      leased_at, leased_until, created_at, updated_at)
      VALUES (?, 'P-DEMO', 'C-1', 'claim', 'C-1', ?, 'fellow-a', 'sponsor-a',
      'Check the claim', 'A review', ?, ?, ?, ?, ?)`)
      .run(id, session, status, iso(-1000), iso(43_200_000), iso(-1000), iso(-1000));
  };
  const rows = (table: string) => sql.query(`SELECT * FROM ${table}`).all();
  const closed = (id: string) =>
    (sql.query("SELECT closed_at FROM sessions WHERE session_id = ?").get(id) as { closed_at: string | null }).closed_at;
  return { sql, db, add, lease, rows, closed,
    before: (hook: () => void) => { beforeBatch = hook; },
    fail: (index: number) => { failAt = index; },
    batches: () => batches,
  };
}

async function withFixture(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try { await run(f); } finally { f.sql.close(); }
}

const sweep = (f: ReturnType<typeof fixture>, extra = {}) =>
  expireIdleSessions(f.db, { now: NOW, ...extra });

describe("idle sessions release abandoned work slots", () => {
  test("closes at the exact deadline and keeps workshop and public state unchanged", async () => {
    await withFixture(async (f) => {
      f.add("S-one");
      f.sql.query(`INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id,
        session_id, workshop_seq, type, title, body_md, created_at)
        VALUES ('W-one', 'P-DEMO', 'fellow-a', 'S-one', 1, 'draft', 'Private draft', 'Never auto-publish this', ?)`)
        .run(iso(-1000));
      const workshops = f.rows("workshop_objects");
      const events = f.rows("events");
      const cursor = f.rows("public_cursor");
      expect(await sweep(f)).toEqual({ closed: 1, hasMore: false });
      expect(f.closed("S-one")).toBe(iso());
      expect(f.rows("workshop_objects")).toEqual(workshops);
      expect(f.rows("events")).toEqual(events);
      expect(f.rows("public_cursor")).toEqual(cursor);
      expect((f.rows("sessions")[0] as { handback: string | null }).handback).toBe(null);
      const notice = f.rows("fellow_inbox_notices")[0] as Record<string, unknown>;
      expect(notice.fellow_id).toBe("fellow-a");
      expect(notice.target_id).toBe("S-one");
      expect(notice.notice_type).toBe("protocol_notice");
      expect(notice.caused_by_event_id).toBe(null);
      expect(notice.seq).toBe(1);
      expect(String(notice.detail).includes("Never auto-publish")).toBe(false);
      expect(String(notice.id).length).toBe(64);
      // The shipped partial UNIQUE index now admits a replacement work session.
      f.add("S-new", iso(43_200_000));
    });
  });

  test("does not close a session one millisecond before its deadline", async () => {
    await withFixture(async (f) => {
      f.add("S-one", iso(1));
      expect(await sweep(f)).toEqual({ closed: 0, hasMore: false });
      expect(f.batches()).toBe(0);
      expect(f.closed("S-one")).toBe(null);
    });
  });

  test("expires active/challenged leases, preserving previously released history", async () => {
    await withFixture(async (f) => {
      f.add("S-one");
      f.add("S-other", iso(1000), "fellow-b");
      f.lease("L-active"); f.lease("L-challenge", "S-one", "challenged");
      f.lease("L-released", "S-one", "released"); f.lease("L-other", "S-other");
      await sweep(f);
      const states = f.sql.query("SELECT lease_id, status FROM leases ORDER BY lease_id").all();
      expect(states).toEqual([
        { lease_id: "L-active", status: "expired" },
        { lease_id: "L-challenge", status: "expired" },
        { lease_id: "L-other", status: "active" },
        { lease_id: "L-released", status: "released" },
      ]);
    });
  });

  test("a heartbeat between selection and commit wins with no side effects", async () => {
    await withFixture(async (f) => {
      f.add("S-one"); f.lease("L-active");
      f.before(() => f.sql.query("UPDATE sessions SET idle_close_at = ?, last_heartbeat_at = ? WHERE session_id = 'S-one'")
        .run(iso(43_200_000), iso()));
      expect(await sweep(f)).toEqual({ closed: 0, hasMore: false });
      expect(f.closed("S-one")).toBe(null);
      expect(f.rows("fellow_inbox_notices")).toEqual([]);
      expect((f.rows("leases")[0] as { status: string }).status).toBe("active");
    });
  });

  test("an explicit close wins without replacing its real handback", async () => {
    await withFixture(async (f) => {
      f.add("S-one");
      f.before(() => f.sql.query("UPDATE sessions SET closed_at = ?, handback = 'Author handback' WHERE session_id = 'S-one'").run(iso(-1)));
      expect((await sweep(f)).closed).toBe(0);
      expect(f.closed("S-one")).toBe(iso(-1));
      expect((f.rows("sessions")[0] as { handback: string }).handback).toBe("Author handback");
      expect(f.rows("fellow_inbox_notices")).toEqual([]);
    });
  });

  test("a changed deadline is not mistaken for the observed expired session", async () => {
    await withFixture(async (f) => {
      f.add("S-one", iso(-1000));
      f.before(() => f.sql.query("UPDATE sessions SET idle_close_at = ?").run(iso(-500)));
      expect((await sweep(f)).closed).toBe(0);
      expect((await sweep(f)).closed).toBe(1);
    });
  });

  for (const failure of [1, 2]) {
    test(`failure at batch statement ${failure} rolls back all preceding effects`, async () => {
      await withFixture(async (f) => {
        f.add("S-one"); f.lease("L-active");
        f.fail(failure);
        await expect(sweep(f)).rejects.toThrow("planted batch failure");
        expect(f.closed("S-one")).toBe(null);
        expect(f.rows("fellow_inbox_notices")).toEqual([]);
        expect((f.rows("leases")[0] as { status: string }).status).toBe("active");
        f.fail(-1);
        expect((await sweep(f)).closed).toBe(1);
        expect((f.rows("fellow_inbox_notices")[0] as { seq: number }).seq).toBe(1);
      });
    });
  }

  test("concurrent sweeps notify and close only once", async () => {
    await withFixture(async (f) => {
      f.add("S-one");
      const results = await Promise.all([sweep(f), sweep(f), sweep(f)]);
      expect(results.reduce((sum, result) => sum + result.closed, 0)).toBe(1);
      expect(f.rows("fellow_inbox_notices").length).toBe(1);
      expect((await sweep(f)).closed).toBe(0);
    });
  });

  test("bounded passes drain oldest sessions before newer deadlines", async () => {
    await withFixture(async (f) => {
      f.add("S-newer", iso(), "fellow-a");
      f.add("S-older", iso(-1000), "fellow-b");
      expect(await sweep(f, { limit: 1 })).toEqual({ closed: 1, hasMore: true });
      expect(f.closed("S-older")).toBe(iso());
      expect(f.closed("S-newer")).toBe(null);
      expect(await sweep(f, { limit: 1 })).toEqual({ closed: 1, hasMore: false });
    });
  });

  test("an authenticated Fellow-scoped sweep cannot retire another Fellow", async () => {
    await withFixture(async (f) => {
      f.add("S-one"); f.add("S-other", iso(-1000), "fellow-b");
      expect(await sweep(f, { fellowId: "fellow-a" })).toEqual({ closed: 1, hasMore: false });
      expect(f.closed("S-other")).toBe(null);
    });
  });

  test("invalid bounds are refused before any mutation", async () => {
    await withFixture(async (f) => {
      f.add("S-one");
      for (const extra of [{ limit: 0 }, { limit: IDLE_SESSION_SWEEP_LIMIT + 1 }, { limit: 1.5 }, { now: NaN }, { now: -1 }, { fellowId: "" }]) {
        await expect(sweep(f, extra)).rejects.toThrow("Invalid idle session sweep bounds");
      }
      expect(f.batches()).toBe(0);
      expect(f.closed("S-one")).toBe(null);
    });
  });
});

// Admission uses the same transaction, not a second cleanup implementation.
describe("session-open recovery", () => {
  const authority = {
    async credentialBinding(token: string) {
      return token === "approved" ? { fellowId: "fellow-a" } : undefined;
    },
  };
  const request = (headers: Record<string, string> = {}, method = "POST", path = "/v1/sessions") =>
    new Request(`https://a.asimposium.org${path}`, {
      method,
      headers: { "idempotency-key": "recovery-1", ...headers },
      ...(method === "POST" ? { body: '{"problem_id":"P-DEMO"}' } : {}),
    });

  test("a returning Fellow recovers expired slots immediately without consuming the body", async () => {
    await withFixture(async (f) => {
      f.add("S-one", "2000-01-02T00:00:00.000Z");
      f.add("S-other", "2000-01-02T00:00:00.000Z", "fellow-b");
      const req = request({ authorization: "Bearer approved", "x-sponsor-id": "fellow-b" });
      await recoverIdleSessionSlots(req, f.db, authority);
      expect(f.closed("S-one") === null).toBe(false);
      expect(f.closed("S-other")).toBe(null);
      expect(req.bodyUsed).toBe(false);
      expect(await req.text()).toBe('{"problem_id":"P-DEMO"}');
      f.add("S-new", "9999-12-31T00:00:00.000Z");
    });
  });

  const unverifiedHeaders: Record<string, string>[] = [
    { "x-sponsor-id": "fellow-a" },
    { cookie: "session=fellow-a" },
    { authorization: "Bearer asimp_sp_fellow-a" },
    { authorization: "Bearer revoked" },
  ];
  for (const headers of unverifiedHeaders) {
    test(`unverified admission does not trigger maintenance: ${JSON.stringify(headers)}`, async () => {
      await withFixture(async (f) => {
        f.add("S-one", "2000-01-02T00:00:00.000Z");
        await recoverIdleSessionSlots(request(headers), f.db, authority);
        expect(f.closed("S-one")).toBe(null);
        expect(f.batches()).toBe(0);
      });
    });
  }

  test("unrelated routes, reads and malformed idempotency keys do not trigger maintenance", async () => {
    await withFixture(async (f) => {
      f.add("S-one", "2000-01-02T00:00:00.000Z");
      for (const req of [
        request({ authorization: "Bearer approved" }, "GET"),
        request({ authorization: "Bearer approved" }, "POST", "/v1/sessions/S-one/heartbeat"),
        request({ authorization: "Bearer approved", "idempotency-key": "" }),
      ]) {
        await recoverIdleSessionSlots(req, f.db, authority);
      }
      expect(f.batches()).toBe(0);
    });
  });

  test("recovery failures propagate without consuming the request or partially closing", async () => {
    await withFixture(async (f) => {
      f.add("S-one", "2000-01-02T00:00:00.000Z");
      f.fail(2);
      const req = request({ authorization: "Bearer approved" });
      await expect(recoverIdleSessionSlots(req, f.db, authority)).rejects.toThrow("planted batch failure");
      expect(f.closed("S-one")).toBe(null);
      expect(f.rows("fellow_inbox_notices")).toEqual([]);
      expect(req.bodyUsed).toBe(false);
    });
  });
});
