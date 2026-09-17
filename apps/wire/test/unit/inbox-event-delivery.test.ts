import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import {
  deliverInboxEvents, INBOX_DELIVERY_JOB_LIMIT, INBOX_DELIVERY_RECIPIENT_LIMIT,
} from "../../src/inbox/event-delivery.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const migration = (name: string) =>
  readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8");

// Real base ledger/inbox DDL and the new migration; minimal identity and
// publication fixture extensions. This adapter tests SQLite batch rollback,
// not the full migration chain or a deployed Cloudflare D1 binding.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(migration("0001_krater_v0.sql"));
  sql.exec(`ALTER TABLE problems ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE events ADD COLUMN actor_fellow_id TEXT;
    ALTER TABLE event_content ADD COLUMN redacted_at TEXT;
    CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY);
    CREATE TABLE problem_memberships (problem_id TEXT, fellow_id TEXT, joined_at TEXT,
      PRIMARY KEY (problem_id, fellow_id));
    INSERT INTO problems (id, created_at, updated_at) VALUES
      ('P-DEMO', '${iso(-10000)}', '${iso(-10000)}'),
      ('P-OTHER', '${iso(-10000)}', '${iso(-10000)}');
    INSERT INTO enrollment_fellows VALUES ('fellow-a'), ('fellow-b'), ('fellow-c');`);
  sql.exec(migration("0064_inbox_and_follows.sql"));
  sql.exec(migration("0066_inbox_event_delivery.sql"));
  let beforeBatch: (() => void) | undefined;
  let failAt = -1;
  function prepare(text: string) {
    let values: (string | number | null)[] = [];
    const execute = () => ({
      results: sql.query(text).all(...values),
      meta: { changes: (sql.query("SELECT changes() AS n").get() as { n: number }).n },
    });
    return {
      bind(...bound: (string | number | null)[]) { values = bound; return this; },
      async all() { return execute(); },
      async run() { return execute(); },
      execute,
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      const hook = beforeBatch; beforeBatch = undefined; hook?.();
      sql.exec("BEGIN");
      try {
        const result = statements.map((statement, index) => {
          if (index === failAt) { failAt = -1; throw new Error("planted failure"); }
          return statement.execute();
        });
        sql.exec("COMMIT");
        return result;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  function append(id: string, type: string, object: string, payload: unknown = {},
    actor = "fellow-b", problem = "P-DEMO", version = 1) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const digest = createHash("sha256").update(body).digest("hex");
    const seq = (sql.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE problem_id = ?")
      .get(problem) as { n: number }).n;
    const kind = type === "problem.statement-revised" ? "problem"
      : type === "review.created" ? "review" : "claim";
    sql.query(`INSERT INTO events
      (id, problem_id, seq, type, object_kind, object_id, object_version,
       payload_sha256, created_at, actor_fellow_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, problem, seq, type, kind, object, version, digest, iso(-1000), actor);
    sql.query("INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES (?, ?, ?)")
      .run(id, digest, body);
  }
  const review = (id = "E-review", problem = "P-DEMO") =>
    append(id, "review.created", `R-${id}`, { target_claim_id: "C-1", target_version: 1,
      body_md: "PRIVATE-CONTENT-SENTINEL not copied into notices" }, "fellow-b", problem);
  const statement = (id = "E-statement") => append(id, "problem.statement-revised", "P-DEMO");
  const follow = (fellow: string, offset = -5000, problem = "P-DEMO") =>
    sql.query("INSERT INTO problem_follows VALUES (?, ?, ?)").run(fellow, problem, NOW + offset);
  const notices = () => sql.query("SELECT * FROM fellow_inbox_notices ORDER BY fellow_id, seq").all() as {
    id: string; fellow_id: string; seq: number; notice_type: string; target_id: string | null;
    acknowledged_at: number | null; title: string; detail: string; created_at: number;
  }[];
  const jobs = () => sql.query("SELECT * FROM inbox_event_deliveries ORDER BY id").all() as {
    state: string; after_fellow_id: string; claim_token: string | null; failure_code: string | null;
  }[];
  append("E-author", "claim.created", "C-1", {}, "fellow-a");
  return { sql, db, append, review, statement, follow, notices, jobs,
    before: (hook: () => void) => { beforeBatch = hook; },
    fail: (index: number) => { failAt = index; },
  };
}
async function using(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture(); try { await run(f); } finally { f.sql.close(); }
}
const drain = (f: ReturnType<typeof fixture>, offset = 0) => deliverInboxEvents(f.db, { now: NOW + offset });

describe("durable ledger-to-inbox delivery", () => {
  test("enqueues only supported public appends and rolls the queue back with the event", async () => {
    await using(async (f) => {
      expect(f.jobs()).toEqual([]);
      f.sql.exec("BEGIN"); f.review(); expect(f.jobs().length).toBe(1); f.sql.exec("ROLLBACK");
      expect(f.jobs()).toEqual([]);
      f.sql.exec("UPDATE problems SET status = 'private-draft' WHERE id = 'P-DEMO'");
      f.statement(); expect(f.jobs()).toEqual([]);
      f.append("E-unrelated", "workshop.pushed", "W-private");
      expect(f.jobs()).toEqual([]);
    });
  });
  test("notifies the immutable claim author, not another problem's C-1 or the reviewer", async () => {
    await using(async (f) => {
      f.append("E-other-author", "claim.created", "C-1", {}, "fellow-c", "P-OTHER");
      f.review(); const before = f.sql.query("SELECT * FROM events ORDER BY id").all();
      expect((await drain(f)).notices).toBe(1);
      expect(f.notices().map((n) => n.fellow_id)).toEqual(["fellow-a"]);
      expect(f.notices()[0]?.target_id).toBe("R-E-review");
      expect(JSON.stringify(f.notices())).not.toContain("PRIVATE-CONTENT-SENTINEL");
      expect(f.sql.query("SELECT * FROM events ORDER BY id").all()).toEqual(before);
      expect(f.jobs()[0]?.state).toBe("delivered");
    });
  });
  test("fans out revisions to members and followers once, excluding future and unrelated subscriptions", async () => {
    await using(async (f) => {
      f.follow("fellow-a"); f.follow("fellow-b", 0); f.follow("fellow-c", -5000, "P-OTHER");
      f.sql.query("INSERT INTO problem_memberships VALUES ('P-DEMO', 'fellow-a', ?)").run(iso(-5000));
      f.sql.query("INSERT INTO problem_memberships VALUES ('P-DEMO', 'fellow-c', ?)").run(iso(-5000));
      f.statement();
      expect((await drain(f)).notices).toBe(2);
      expect(f.notices().map((n) => n.fellow_id)).toEqual(["fellow-a", "fellow-c"]);
      expect(f.notices().every((n) => n.notice_type === "statement_revision")).toBe(true);
    });
  });
  test("resumes a bounded recipient page without losing the lookahead recipient", async () => {
    await using(async (f) => {
      const count = INBOX_DELIVERY_RECIPIENT_LIMIT * 2 + 3;
      for (let i = 0; i < count; i++) {
        const fellow = `fellow-${String(i).padStart(3, "0")}`;
        f.sql.query("INSERT INTO enrollment_fellows VALUES (?)").run(fellow); f.follow(fellow);
      }
      f.statement();
      expect((await drain(f)).notices).toBe(INBOX_DELIVERY_RECIPIENT_LIMIT);
      expect(f.jobs()[0]?.state).toBe("pending");
      expect((await drain(f, 1)).notices).toBe(INBOX_DELIVERY_RECIPIENT_LIMIT);
      expect((await drain(f, 2)).notices).toBe(3);
      expect(new Set(f.notices().map((n) => n.fellow_id)).size).toBe(count);
      expect(f.jobs()[0]?.claim_token).toBe(null);
    });
  });
  test("bounds jobs and gives other queued events a turn", async () => {
    await using(async (f) => {
      for (let i = 0; i < INBOX_DELIVERY_JOB_LIMIT + 2; i++) f.review(`E-review-${i}`);
      const first = await drain(f);
      expect(first.examined).toBe(INBOX_DELIVERY_JOB_LIMIT);
      expect(first.notices).toBe(INBOX_DELIVERY_JOB_LIMIT);
      expect((await drain(f, 1)).notices).toBe(2);
      expect(f.notices().map((n) => n.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    });
  });
  test("overlapping deliveries elect one winner and do not mint duplicate unread notices", async () => {
    await using(async (f) => {
      f.review();
      const results = await Promise.all(Array.from({ length: 30 }, () => drain(f)));
      expect(results.reduce((sum, r) => sum + r.notices, 0)).toBe(1);
      expect(f.notices().length).toBe(1);
      expect(f.jobs()[0]?.state).toBe("delivered");
    });
  });
  test("recognizes legacy/synchronous delivery without resetting text, time, cursor or acknowledgment", async () => {
    await using(async (f) => {
      f.follow("fellow-a"); f.statement();
      f.sql.query(`INSERT INTO fellow_inbox_notices
        (id, fellow_id, problem_id, notice_type, seq, title, detail, caused_by_event_id,
         acknowledged_at, created_at) VALUES ('legacy-notice', 'fellow-a', 'P-DEMO',
         'statement_revision', 7, 'Original title', 'Original detail', 'E-statement', ?, ?)`)
        .run(NOW - 500, NOW - 900);
      const before = f.notices(); expect((await drain(f)).notices).toBe(0);
      expect(f.notices()).toEqual(before); expect(f.jobs()[0]?.state).toBe("delivered");
    });
  });
  test("rolls every notice and progress back when a batch fails halfway", async () => {
    await using(async (f) => {
      f.follow("fellow-a"); f.follow("fellow-c"); f.statement(); f.fail(2);
      expect((await drain(f)).failed).toBe(1);
      expect(f.notices()).toEqual([]); expect(f.jobs()[0]?.after_fellow_id).toBe("");
      expect(f.jobs()[0]?.claim_token).toBe(null);
      expect((await drain(f, 1)).notices).toBe(2);
    });
  });
  test("rechecks subscription removal inside the delivery transaction", async () => {
    await using(async (f) => {
      f.follow("fellow-a"); f.follow("fellow-c"); f.statement();
      f.before(() => { f.sql.exec("DELETE FROM problem_follows WHERE principal_id = 'fellow-a'"); });
      expect((await drain(f)).notices).toBe(1);
      expect(f.notices().map((n) => n.fellow_id)).toEqual(["fellow-c"]);
    });
  });
  test("a problem made private during delivery produces no notice and is then suppressed", async () => {
    await using(async (f) => {
      f.review(); f.before(() => { f.sql.exec("UPDATE problems SET status = 'private-draft' WHERE id = 'P-DEMO'"); });
      expect((await drain(f)).notices).toBe(0); expect(f.jobs()[0]?.state).toBe("pending");
      expect((await drain(f, 1)).suppressed).toBe(1); expect(f.notices()).toEqual([]);
    });
  });
  test("redaction between source verification and commit suppresses delivery", async () => {
    await using(async (f) => {
      f.review(); f.before(() => { f.sql.exec("UPDATE event_content SET redacted_at = 'redacted' WHERE event_id = 'E-review'"); });
      expect((await drain(f)).notices).toBe(0);
      expect((await drain(f, 1)).suppressed).toBe(1); expect(f.notices()).toEqual([]);
    });
  });
  test("guards the exact verified bytes, not only the stored digest label", async () => {
    await using(async (f) => {
      f.review(); f.before(() => { f.sql.exec("UPDATE event_content SET payload_json = '{}' WHERE event_id = 'E-review'"); });
      expect((await drain(f)).notices).toBe(0); expect(f.jobs()[0]?.state).toBe("pending");
      expect((await drain(f, 1)).quarantined).toBe(1); expect(f.notices()).toEqual([]);
    });
  });
  test("quarantines malformed, missing, oversized and mismatched sources without blocking valid work", async () => {
    await using(async (f) => {
      f.append("E-json", "review.created", "R-json", "not json");
      f.append("E-shape", "review.created", "R-shape", { target_claim_id: "C-1", target_version: -1 });
      f.review("E-missing"); f.sql.exec("DELETE FROM event_content WHERE event_id = 'E-missing'");
      f.append("E-large", "review.created", "R-large", "x".repeat(512 * 1024 + 1));
      f.review("E-digest"); f.sql.exec("UPDATE event_content SET payload_sha256 = 'wrong' WHERE event_id = 'E-digest'");
      f.review("E-good");
      const result = await drain(f); expect(result.quarantined).toBe(5); expect(result.notices).toBe(1);
      expect(f.jobs().filter((j) => j.state === "quarantined").every((j) => j.failure_code === "SOURCE_INVALID")).toBe(true);
    });
  });
  test("a transient job failure leaves a durable retry and does not block the next job", async () => {
    await using(async (f) => {
      f.review("E-first"); f.review("E-second"); f.fail(0);
      const first = await drain(f); expect(first.failed).toBe(1); expect(first.notices).toBe(1);
      expect((await drain(f, 1)).notices).toBe(1); expect(f.notices().length).toBe(2);
    });
  });
  test("does not create unsafe inbox sequence numbers or acknowledge a failed delivery", async () => {
    await using(async (f) => {
      f.review(); f.sql.exec(`INSERT INTO fellow_inbox_notices
        (id, fellow_id, notice_type, seq, title, created_at)
        VALUES ('at-limit', 'fellow-a', 'protocol_notice', 9007199254740991, 'old', 1)`);
      expect((await drain(f)).failed).toBe(1); expect(f.notices().length).toBe(1);
      expect(f.jobs()[0]?.state).toBe("pending");
    });
  });
  test("rejects an invalid clock before touching storage", async () => {
    await using(async (f) => {
      await expect(deliverInboxEvents(f.db, { now: Number.NaN })).rejects.toThrow("INBOX_DELIVERY_CLOCK_INVALID");
    });
  });
});
