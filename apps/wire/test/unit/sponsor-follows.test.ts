import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import {
  SPONSOR_FOLLOW_LIMIT,
  SponsorFollowListResponseSchema,
} from "@asimposium/contracts";
import { createSponsorFollowRouter } from "../../src/inbox/sponsor-follow-router.ts";
import {
  currentSponsorFollowRows,
  listSponsorFollowRows,
  setSponsorFollow,
  SponsorFollowError,
} from "../../src/inbox/sponsor-follows.ts";
import type { Env } from "../../src/env.ts";

const SPONSOR = "usr_alice";
const OTHER = "usr_bob";
const NOW = 1_800_000_000_000;

// Production SQL on actual SQLite transactions. This is unit proof, not a
// Workerd/D1 deployment claim. Nothing supplies canned query result rows.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sponsors (sponsor_id TEXT PRIMARY KEY);
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER, unlisted INTEGER);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE problem_follows (
      principal_id TEXT, problem_id TEXT REFERENCES problems(id), created_at INTEGER,
      PRIMARY KEY (principal_id, problem_id));
    CREATE TABLE problem_memberships (problem_id TEXT, fellow_id TEXT);
    INSERT INTO sponsors VALUES ('usr_alice'), ('usr_bob');
    INSERT INTO problems VALUES ('P-DEMO','active',0,0), ('P-UNLISTED','active',0,1),
      ('P-PRIVATE','private-draft',0,1), ('P-HIDDEN','active',0,0);
    INSERT INTO content_controls VALUES ('P-HIDDEN','problem','hidden',1);`);
  sql.exec(readFileSync(new URL("../../../../db/migrations/0102_sponsor_follow_replays.sql", import.meta.url), "utf8"));
  type Values = (string | number | null)[];
  const prepare = (query: string) => {
    const statement = (...values: Values) => ({
      bind: (...bound: Values) => statement(...bound),
      run: async () => {
        if (/^\s*(SELECT|WITH)\b/i.test(query)) {
          const rows = sql.query(query).all(...values);
          return { success: true, results: rows, meta: { changes: 0 } };
        }
        const result = sql.query(query).run(...values);
        return { success: true, results: [], meta: { changes: result.changes } };
      },
      first: async <T>() => (sql.query(query).get(...values) ?? null) as T | null,
      all: async <T>() => ({ success: true, results: sql.query(query).all(...values) as T[] }),
    });
    return statement();
  };
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    prepare,
    batch: (statements: readonly { run(): Promise<unknown> }[]) => {
      const result = tail.then(async () => {
        sql.exec("BEGIN");
        try {
          const rows = [];
          for (const statement of statements) rows.push(await statement.run());
          sql.exec("COMMIT");
          return rows;
        } catch (error) { sql.exec("ROLLBACK"); throw error; }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  } as unknown as D1Database;
  return { sql, db };
}
async function refusal(run: () => Promise<unknown>, reason: SponsorFollowError["reason"]) {
  try { await run(); throw new Error("expected refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(SponsorFollowError);
    expect((error as SponsorFollowError).reason).toBe(reason);
  }
}
function count(sql: Database, table: string) {
  return (sql.query("SELECT COUNT(*) AS n FROM " + table).get() as { n: number }).n;
}

describe("private sponsor follow preference transactions", () => {
  test("public and known unlisted problems follow without membership or public events", async () => {
    const f = fixture();
    try {
      for (const problem_id of ["P-DEMO", "P-UNLISTED"]) {
        const receipt = await setSponsorFollow(f.db, SPONSOR, { problem_id, following: true }, problem_id, NOW);
        expect(receipt).toEqual({ problem_id, following: true, followed_at: NOW });
      }
      expect(count(f.sql, "problem_memberships")).toBe(0);
      expect(await listSponsorFollowRows(f.db, OTHER)).toEqual([]);
      expect((await listSponsorFollowRows(f.db, SPONSOR)).map(row => row.problem_id))
        .toEqual(["P-DEMO", "P-UNLISTED"]);
    } finally { f.sql.close(); }
  });

  test("private, hidden and missing problems all refuse without reserving the retry key", async () => {
    const f = fixture();
    try {
      for (const problem_id of ["P-PRIVATE", "P-HIDDEN", "P-MISSING"])
        await refusal(() => setSponsorFollow(f.db, SPONSOR, { problem_id, following: true }, "retry", NOW), "missing");
      expect(count(f.sql, "problem_follows")).toBe(0);
      expect(count(f.sql, "sponsor_follow_replays")).toBe(0);
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: true }, "retry", NOW);
      expect(count(f.sql, "problem_follows")).toBe(1);
    } finally { f.sql.close(); }
  });

  test("delayed follow replay cannot undo a later explicit unfollow", async () => {
    const f = fixture();
    try {
      const command = { problem_id: "P-DEMO", following: true };
      const first = await setSponsorFollow(f.db, SPONSOR, command, "add", NOW);
      expect(await setSponsorFollow(f.db, SPONSOR, command, "add-again", NOW + 1)).toEqual(first);
      const removed = await setSponsorFollow(f.db, SPONSOR, { ...command, following: false }, "remove", NOW + 2);
      expect(removed).toEqual({ problem_id: "P-DEMO", following: false, followed_at: null });
      expect(await setSponsorFollow(f.db, SPONSOR, command, "add", NOW + 3)).toEqual(first);
      expect(count(f.sql, "problem_follows")).toBe(0);
      expect(await listSponsorFollowRows(f.db, SPONSOR)).toEqual([]);
    } finally { f.sql.close(); }
  });

  test("same-key different body conflicts; other sponsors own separate receipt keys", async () => {
    const f = fixture();
    try {
      const command = { problem_id: "P-DEMO", following: true };
      await setSponsorFollow(f.db, SPONSOR, command, "key", NOW);
      await refusal(() => setSponsorFollow(f.db, SPONSOR, { ...command, following: false }, "key", NOW + 1), "conflict");
      await setSponsorFollow(f.db, OTHER, { ...command, following: false }, "key", NOW + 1);
      expect((await listSponsorFollowRows(f.db, SPONSOR)).length).toBe(1);
      expect(await listSponsorFollowRows(f.db, OTHER)).toEqual([]);
    } finally { f.sql.close(); }
  });

  test("unfollow remains usable after visibility changes and final preview checks suppress it", async () => {
    const f = fixture();
    try {
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: true }, "add", NOW);
      f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
      expect(await currentSponsorFollowRows(f.db, SPONSOR, ["P-DEMO"]))
        .toEqual([{ problem_id: "P-DEMO", followed_at: NOW, cursor: null }]);
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: false }, "remove", NOW + 1);
      expect(await currentSponsorFollowRows(f.db, SPONSOR, ["P-DEMO"])).toEqual([]);
      expect(count(f.sql, "problem_memberships")).toBe(0);
    } finally { f.sql.close(); }
  });

  test("the cap is enforced inside the transaction but never blocks removal or an existing follow", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < SPONSOR_FOLLOW_LIMIT; i++) {
        const id = "P-Q" + i.toString().padStart(3, "0");
        f.sql.query("INSERT INTO problems VALUES (?, 'active', 0, 0)").run(id);
        f.sql.query("INSERT INTO problem_follows VALUES (?, ?, ?)").run(SPONSOR, id, NOW);
      }
      await refusal(() => setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: true }, "overflow", NOW), "limit");
      expect(count(f.sql, "sponsor_follow_replays")).toBe(0);
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-Q000", following: true }, "same", NOW);
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-Q000", following: false }, "free", NOW);
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: true }, "overflow", NOW);
      expect(count(f.sql, "problem_follows")).toBe(SPONSOR_FOLLOW_LIMIT);
      const rows = await listSponsorFollowRows(f.db, SPONSOR);
      expect(rows.length).toBe(6); // five items and one lookahead
      expect((await listSponsorFollowRows(f.db, SPONSOR, rows[4]!.problem_id))[0]!.problem_id)
        .toBe(rows[5]!.problem_id);
    } finally { f.sql.close(); }
  });

  test("late database failure rolls back the preference and its receipt, leaving the key retryable", async () => {
    const f = fixture();
    try {
      f.sql.exec(`CREATE TRIGGER reject_follow BEFORE INSERT ON problem_follows
        BEGIN SELECT RAISE(ABORT, 'late planted fault'); END;`);
      await expect(setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: true }, "retry", NOW))
        .rejects.toThrow("late planted fault");
      expect(count(f.sql, "problem_follows")).toBe(0);
      expect(count(f.sql, "sponsor_follow_replays")).toBe(0);
      f.sql.exec("DROP TRIGGER reject_follow");
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: true }, "retry", NOW);
      expect(count(f.sql, "problem_follows")).toBe(1);
    } finally { f.sql.close(); }
  });

  test("expired receipts allow a new decision after the full 24-hour replay window", async () => {
    const f = fixture();
    try {
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: true }, "key", NOW);
      await setSponsorFollow(f.db, SPONSOR, { problem_id: "P-DEMO", following: false }, "key", NOW + 86_400_000);
      expect(count(f.sql, "problem_follows")).toBe(0);
      expect(count(f.sql, "sponsor_follow_replays")).toBe(1);
    } finally { f.sql.close(); }
  });
});

describe("mounted sponsor follow handlers", () => {
  test("the route calls the sponsor verifier before any database access", async () => {
    const seen: unknown[] = [];
    const app = createSponsorFollowRouter({ verifiedSponsor: async (_request, route, action) => {
      seen.push([route, action]);
      return new Response(null, { status: 401 });
    } });
    expect((await app.request("/v1/sponsors/follows")).status).toBe(401);
    expect((await app.request("/v1/sponsors/follows", { method: "POST", body: "{}" })).status).toBe(401);
    expect(seen).toEqual([
      ["/v1/sponsors/follows", "list-follows"],
      ["/v1/sponsors/follows", "set-follow"],
    ]);
  });

  test("signed verified bytes drive changes; malformed queries never turn into broad lists", async () => {
    const f = fixture();
    try {
      const app = createSponsorFollowRouter({ verifiedSponsor: async request => ({
        principal: { type: "sponsor", sponsorId: SPONSOR },
        rawBody: new Uint8Array(await request.arrayBuffer()),
      }) });
      const env = { DB: f.db } as Env;
      const post = await app.request("/v1/sponsors/follows", {
        method: "POST", headers: { "idempotency-key": "mounted", "content-type": "application/json" },
        body: JSON.stringify({ problem_id: "P-DEMO", following: true }),
      }, env);
      expect(post.status).toBe(200);
      expect(post.headers.get("cache-control")).toBe("private, no-store");
      f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
      const list = await app.request("/v1/sponsors/follows", {}, env);
      const page = SponsorFollowListResponseSchema.parse(await list.json());
      expect(page.sponsor_id).toBe(SPONSOR);
      expect(page.follows[0]?.cursor).toBeNull();
      expect(page.follows[0]?.events).toEqual([]);
      expect(page.follows[0]?.reviews).toEqual([]);
      for (const query of ["?after=P-DEMO&after=P-DEMO", "?other=x", "?after=bad"]) {
        expect((await app.request("/v1/sponsors/follows" + query, {}, env)).status).toBe(400);
      }
    } finally { f.sql.close(); }
  });
});
