import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { INSERT_INBOX_NOTICE_SQL } from "../../src/inbox/notice-write.ts";
import {
  ackInboxNotices,
  createInboxNotice,
  getInboxNotices,
  type NoticeCreateInput,
  notifyProblemFollowersOfStatementRevision,
} from "../../src/inbox/store.ts";

// Real SQLite SQL and the shipped notice schema; D1 transport is an adapter.
async function fixture(run: (f: { db: D1Database; sql: Database; failAt: (index: number) => void }) => Promise<void>) {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY);
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT);
    INSERT INTO enrollment_fellows VALUES ('fellow-a'),('fellow-b');
    INSERT INTO problems VALUES ('P-DEMO','active'),('P-OTHER','active');`);
  sql.exec(readFileSync(new URL("../../../../db/migrations/0064_inbox_and_follows.sql", import.meta.url), "utf8"));
  let failure = -1;
  function prepare(text: string) {
    let values: (string | number | null)[] = [];
    return {
      bind(...bound: (string | number | null)[]) { values = bound; return this; },
      async all() { return { results: sql.query(text).all(...values) }; },
      async first() { return sql.query(text).get(...values); },
      async run() { return { meta: { changes: sql.query(text).run(...values).changes } }; },
      execute() { return { results: sql.query(text).all(...values) }; },
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sql.exec("BEGIN");
      try {
        const results = statements.map((statement, index) => {
          if (index === failure) throw new Error("planted receipt failure");
          return statement.execute();
        });
        sql.exec("COMMIT");
        return results;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  try { await run({ db, sql, failAt: (index) => { failure = index; } }); }
  finally { sql.close(); }
}

const input: NoticeCreateInput = {
  fellowId: "fellow-a", problemId: "P-DEMO", noticeType: "statement_revision",
  title: "Statement revised", detail: "Re-orient before writing", causedByEventId: "E-revision",
  createdAt: 100, expiresAt: 1000,
};
const count = (sql: Database) =>
  (sql.query("SELECT COUNT(*) AS n FROM fellow_inbox_notices").get() as { n: number }).n;

describe("causal inbox delivery survives retries", () => {
  test("replaying a causal notice returns the original content and cursor", async () => {
    await fixture(async ({ db, sql }) => {
      const first = await createInboxNotice(db, input);
      const replay = await createInboxNotice(db, { ...input, title: "New template", detail: "Changed", createdAt: 200, expiresAt: 5000 });
      expect(replay).toEqual(first);
      expect(count(sql)).toBe(1);
      expect(first.seq).toBe(1);
    });
  });

  test("acknowledged or expired notices are not resurrected by delivery retry", async () => {
    await fixture(async ({ db }) => {
      const first = await createInboxNotice(db, input);
      await ackInboxNotices(db, "fellow-a", { notice_ids: [first.id] }, 200);
      const replay = await createInboxNotice(db, { ...input, createdAt: 2000, expiresAt: 9000 });
      expect(replay.acknowledged_at).toBe(200);
      expect(replay.created_at).toBe(100);
      expect(replay.expires_at).toBe(1000);
      expect((await getInboxNotices(db, "fellow-a", { unread_only: true, limit: 50 })).items).toEqual([]);
    });
  });

  test("thirty concurrent retries allocate exactly one logical delivery", async () => {
    await fixture(async ({ db, sql }) => {
      const replies = await Promise.all(Array.from({ length: 30 }, () => createInboxNotice(db, input)));
      expect(new Set(replies.map((row) => row.id)).size).toBe(1);
      expect(new Set(replies.map((row) => row.seq)).size).toBe(1);
      expect(count(sql)).toBe(1);
      const next = await createInboxNotice(db, { ...input, causedByEventId: "E-next" });
      expect(next.seq).toBe(2);
    });
  });

  test("each recipient, problem, cause, type, target and impact has its own identity", async () => {
    await fixture(async ({ db, sql }) => {
      const variants: NoticeCreateInput[] = [
        input,
        { ...input, fellowId: "fellow-b" },
        { ...input, problemId: "P-OTHER" },
        { ...input, causedByEventId: "E-other" },
        { ...input, noticeType: "review_request" },
        { ...input, targetId: "C-1" },
        { ...input, impactKind: "citation_reused" },
      ];
      const ids = new Set<string>();
      for (const variant of variants) ids.add((await createInboxNotice(db, variant)).id);
      expect(ids.size).toBe(variants.length);
      expect(count(sql)).toBe(variants.length);
    });
  });

  test("legacy random IDs are recognized without changing or deleting history", async () => {
    await fixture(async ({ db, sql }) => {
      sql.query(INSERT_INBOX_NOTICE_SQL).get("NOT-legacy", "fellow-a", "P-DEMO", "statement_revision", "fellow-a",
        "Original legacy text", null, null, "E-revision", null, 1000, 50);
      const before = sql.query("SELECT * FROM fellow_inbox_notices").all();
      const replay = await createInboxNotice(db, input);
      expect(replay.id).toBe("NOT-legacy");
      expect(replay.title).toBe("Original legacy text");
      expect(replay.created_at).toBe(50);
      expect(sql.query("SELECT * FROM fellow_inbox_notices").all()).toEqual(before);
    });
  });

  test("uncausal notices stay distinct unless the producer supplies an explicit ID", async () => {
    await fixture(async ({ db, sql }) => {
      const uncaused = { ...input, causedByEventId: null };
      const one = await createInboxNotice(db, uncaused);
      const two = await createInboxNotice(db, uncaused);
      expect(one.id === two.id).toBe(false);
      const explicit = { ...uncaused, id: "NOT-explicit" };
      expect(await createInboxNotice(db, explicit)).toEqual(await createInboxNotice(db, explicit));
      expect(count(sql)).toBe(3);
    });
  });

  test("an explicit ID collision cannot return another recipient's notice", async () => {
    await fixture(async ({ db, sql }) => {
      await createInboxNotice(db, { ...input, id: "NOT-fixed" });
      await expect(createInboxNotice(db, { ...input, id: "NOT-fixed", fellowId: "fellow-b" }))
        .rejects.toThrow("no valid cursor receipt");
      expect(count(sql)).toBe(1);
    });
  });

  test("a receipt read failure rolls the insertion and its cursor back", async () => {
    await fixture(async ({ db, sql, failAt }) => {
      failAt(1);
      await expect(createInboxNotice(db, input)).rejects.toThrow("planted receipt failure");
      expect(count(sql)).toBe(0);
      failAt(-1);
      expect((await createInboxNotice(db, input)).seq).toBe(1);
    });
  });

  test("statement-revision fan-out can be replayed without repeated notifications", async () => {
    await fixture(async ({ db, sql }) => {
      sql.exec(`INSERT INTO problem_follows VALUES ('fellow-a','P-DEMO',1),('fellow-b','P-DEMO',1);
        INSERT INTO problem_memberships VALUES ('P-DEMO','fellow-a');`);
      await notifyProblemFollowersOfStatementRevision(db, "P-DEMO", 2, "E-revision");
      await notifyProblemFollowersOfStatementRevision(db, "P-DEMO", 2, "E-revision");
      expect(count(sql)).toBe(2);
      expect((await getInboxNotices(db, "fellow-a", { limit: 50 })).items.length).toBe(1);
      expect((await getInboxNotices(db, "fellow-b", { limit: 50 })).items.length).toBe(1);
    });
  });
});
