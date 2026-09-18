import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  FOLLOW_DELETE_SQL,
  FOLLOW_INSERT_SQL,
  FOLLOW_RECIPIENTS_SQL,
  FOLLOW_STATUS_SQL,
  INBOX_UNACKNOWLEDGED_SQL,
  VISIBLE_INBOX_NOTICE_SQL,
} from "../../src/inbox/follow-access.ts";

// Exercise the production SQL on SQLite, not canned D1 query responses.
// These are unit-level SQL proofs; real D1 transaction integration is separate.
function fixture(run: (db: Database) => void) {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT NOT NULL, unlisted INTEGER NOT NULL);
      CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY);
      CREATE TABLE problem_memberships (problem_id TEXT, fellow_id TEXT, PRIMARY KEY(problem_id, fellow_id));
      CREATE TABLE problem_follows (principal_id TEXT, problem_id TEXT, created_at INTEGER, PRIMARY KEY(principal_id, problem_id));
      CREATE TABLE fellow_inbox_notices (
        id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT, seq INTEGER, acknowledged_at INTEGER
      );
      INSERT INTO problems VALUES ('P-PUBLIC', 'active', 0), ('P-UNLISTED', 'active', 1), ('P-PRIVATE', 'private-draft', 1);
      INSERT INTO enrollment_fellows VALUES ('fellow-a'), ('fellow-b');
      INSERT INTO problem_memberships VALUES ('P-PRIVATE', 'fellow-a');
    `);
    run(db);
  } finally {
    db.close();
  }
}

function status(db: Database, fellow: string, problem: string) {
  return db.query(FOLLOW_STATUS_SQL).get(fellow, problem, fellow) as {
    problem_id: string;
    created_at: number | null;
  } | null;
}

function follow(db: Database, fellow: string, problem: string, now = 100) {
  db.query(FOLLOW_INSERT_SQL).run(fellow, now, problem, fellow);
}

function notice(db: Database, id: string, fellow: string, problem: string | null, seq: number) {
  db.query("INSERT INTO fellow_inbox_notices VALUES (?, ?, ?, ?, NULL)").run(
    id,
    fellow,
    problem,
    seq,
  );
}

function visible(db: Database, fellow: string, since = 0, limit = 50) {
  return db
    .query(`SELECT id, seq FROM fellow_inbox_notices
      WHERE fellow_id = ? AND ${VISIBLE_INBOX_NOTICE_SQL} AND seq > ? ORDER BY seq LIMIT ?`)
    .all(fellow, since, limit) as { id: string; seq: number }[];
}

function unacknowledged(db: Database, fellow: string) {
  return (db.query(INBOX_UNACKNOWLEDGED_SQL).get(fellow) as { unack: number }).unack;
}

describe("follow and inbox visibility is current authority, not a subscription", () => {
  test("known public and unlisted IDs remain followable without membership", () => {
    fixture((db) => {
      for (const id of ["P-PUBLIC", "P-UNLISTED"]) {
        expect(status(db, "fellow-b", id)?.created_at).toBe(null);
        follow(db, "fellow-b", id);
        expect(status(db, "fellow-b", id)?.created_at).toBe(100);
      }
    });
  });

  test("private outsiders and nonexistent targets are indistinguishable", () => {
    fixture((db) => {
      for (const id of ["P-PRIVATE", "P-MISSING"]) {
        follow(db, "fellow-b", id);
        expect(status(db, "fellow-b", id)).toBe(null);
        db.query(FOLLOW_DELETE_SQL).run("fellow-b", id, "fellow-b");
      }
      expect(db.query("SELECT * FROM problem_follows").all()).toEqual([]);
    });
  });

  test("current private members can follow and unfollow", () => {
    fixture((db) => {
      follow(db, "fellow-a", "P-PRIVATE");
      expect(status(db, "fellow-a", "P-PRIVATE")?.created_at).toBe(100);
      db.query(FOLLOW_DELETE_SQL).run("fellow-a", "P-PRIVATE", "fellow-a");
      expect(status(db, "fellow-a", "P-PRIVATE")?.created_at).toBe(null);
    });
  });

  test("a duplicate follow preserves its original receipt timestamp", () => {
    fixture((db) => {
      follow(db, "fellow-a", "P-PUBLIC", 100);
      follow(db, "fellow-a", "P-PUBLIC", 200);
      expect(status(db, "fellow-a", "P-PUBLIC")?.created_at).toBe(100);
    });
  });

  test("Fellows cannot inspect or remove each other's follow", () => {
    fixture((db) => {
      follow(db, "fellow-a", "P-PUBLIC");
      expect(status(db, "fellow-b", "P-PUBLIC")?.created_at).toBe(null);
      db.query(FOLLOW_DELETE_SQL).run("fellow-b", "P-PUBLIC", "fellow-b");
      expect(status(db, "fellow-a", "P-PUBLIC")?.created_at).toBe(100);
    });
  });

  test("visibility changing after preflight cannot authorize the INSERT", () => {
    fixture((db) => {
      expect(status(db, "fellow-b", "P-PUBLIC")?.created_at).toBe(null);
      db.exec("UPDATE problems SET status = 'private-draft' WHERE id = 'P-PUBLIC'");
      follow(db, "fellow-b", "P-PUBLIC");
      expect(db.query("SELECT * FROM problem_follows").all()).toEqual([]);
      expect(status(db, "fellow-b", "P-PUBLIC")).toBe(null);
    });
  });

  test("membership removal after preflight cannot authorize the INSERT", () => {
    fixture((db) => {
      expect(status(db, "fellow-a", "P-PRIVATE")?.created_at).toBe(null);
      db.exec("DELETE FROM problem_memberships WHERE fellow_id = 'fellow-a'");
      follow(db, "fellow-a", "P-PRIVATE");
      expect(db.query("SELECT * FROM problem_follows").all()).toEqual([]);
    });
  });

  test("an old subscription grants no access after membership removal", () => {
    fixture((db) => {
      follow(db, "fellow-a", "P-PRIVATE");
      db.exec("DELETE FROM problem_memberships WHERE fellow_id = 'fellow-a'");
      expect(status(db, "fellow-a", "P-PRIVATE")).toBe(null);
      expect(db.query(FOLLOW_RECIPIENTS_SQL).all("P-PRIVATE")).toEqual([]);
    });
  });

  test("private fan-out includes members but not stale or fabricated followers", () => {
    fixture((db) => {
      db.exec(`INSERT INTO problem_follows VALUES
        ('fellow-a', 'P-PRIVATE', 1), ('fellow-b', 'P-PRIVATE', 1), ('forged-principal', 'P-PRIVATE', 1)`);
      expect(db.query(FOLLOW_RECIPIENTS_SQL).all("P-PRIVATE")).toEqual([
        { principal_id: "fellow-a" },
      ]);
    });
  });

  test("public fan-out deduplicates members and subscribers and requires a Fellow", () => {
    fixture((db) => {
      db.exec(`INSERT INTO problem_follows VALUES
        ('fellow-a', 'P-PUBLIC', 1), ('fellow-b', 'P-PUBLIC', 1), ('forged-principal', 'P-PUBLIC', 1);
        INSERT INTO problem_memberships VALUES ('P-PUBLIC', 'fellow-a');`);
      expect(db.query(FOLLOW_RECIPIENTS_SQL).all("P-PUBLIC")).toEqual([
        { principal_id: "fellow-a" },
        { principal_id: "fellow-b" },
      ]);
      expect(db.query(FOLLOW_RECIPIENTS_SQL).all("P-MISSING")).toEqual([]);
    });
  });

  test("queued private or missing-problem notices do not leak into items or counts", () => {
    fixture((db) => {
      notice(db, "hidden", "fellow-b", "P-PRIVATE", 1);
      notice(db, "missing", "fellow-b", "P-MISSING", 2);
      notice(db, "account", "fellow-b", null, 3);
      notice(db, "public", "fellow-b", "P-PUBLIC", 4);
      notice(db, "unlisted", "fellow-b", "P-UNLISTED", 5);
      expect(visible(db, "fellow-b").map((row) => row.id)).toEqual([
        "account",
        "public",
        "unlisted",
      ]);
      expect(unacknowledged(db, "fellow-b")).toBe(3);
    });
  });

  test("filtering happens before the page limit and preserves visible cursor order", () => {
    fixture((db) => {
      for (let seq = 1; seq <= 10; seq++) notice(db, `hidden-${seq}`, "fellow-b", "P-PRIVATE", seq);
      notice(db, "visible-1", "fellow-b", "P-PUBLIC", 11);
      notice(db, "visible-2", "fellow-b", null, 12);
      expect(visible(db, "fellow-b", 0, 1)).toEqual([{ id: "visible-1", seq: 11 }]);
      expect(visible(db, "fellow-b", 11, 1)).toEqual([{ id: "visible-2", seq: 12 }]);
      expect(visible(db, "fellow-b", 12, 1)).toEqual([]);
    });
  });

  test("revocation hides previously queued notices, while account notices survive", () => {
    fixture((db) => {
      notice(db, "private", "fellow-a", "P-PRIVATE", 1);
      notice(db, "account", "fellow-a", null, 2);
      expect(unacknowledged(db, "fellow-a")).toBe(2);
      db.exec("DELETE FROM problem_memberships WHERE fellow_id = 'fellow-a'");
      expect(visible(db, "fellow-a")).toEqual([{ id: "account", seq: 2 }]);
      expect(unacknowledged(db, "fellow-a")).toBe(1);
    });
  });

  test("a public-to-private transition hides notices from nonmembers immediately", () => {
    fixture((db) => {
      notice(db, "old-public", "fellow-b", "P-PUBLIC", 1);
      expect(unacknowledged(db, "fellow-b")).toBe(1);
      db.exec("UPDATE problems SET status = 'private-draft' WHERE id = 'P-PUBLIC'");
      expect(visible(db, "fellow-b")).toEqual([]);
      expect(unacknowledged(db, "fellow-b")).toBe(0);
    });
  });

  test("acknowledgment cannot expose hidden IDs or cross Fellow boundaries", () => {
    fixture((db) => {
      notice(db, "hidden", "fellow-b", "P-PRIVATE", 1);
      notice(db, "other-fellow", "fellow-a", "P-PUBLIC", 1);
      notice(db, "visible", "fellow-b", "P-PUBLIC", 2);
      const result = db
        .query(`UPDATE fellow_inbox_notices SET acknowledged_at = 100
        WHERE fellow_id = ? AND id IN (?, ?, ?) AND acknowledged_at IS NULL AND ${VISIBLE_INBOX_NOTICE_SQL}`)
        .run("fellow-b", "hidden", "other-fellow", "visible");
      expect(result.changes).toBe(1);
      expect(
        db.query("SELECT id FROM fellow_inbox_notices WHERE acknowledged_at = 100").all(),
      ).toEqual([{ id: "visible" }]);
      expect(unacknowledged(db, "fellow-b")).toBe(0);
      expect(unacknowledged(db, "fellow-a")).toBe(1);
    });
  });

  test("bulk acknowledgment leaves inaccessible queued notices untouched", () => {
    fixture((db) => {
      notice(db, "hidden", "fellow-b", "P-PRIVATE", 1);
      notice(db, "visible", "fellow-b", null, 2);
      const result = db
        .query(`UPDATE fellow_inbox_notices SET acknowledged_at = ?
        WHERE fellow_id = ? AND seq <= ? AND acknowledged_at IS NULL AND ${VISIBLE_INBOX_NOTICE_SQL}`)
        .run(100, "fellow-b", 100);
      expect(result.changes).toBe(1);
      expect(
        db.query("SELECT acknowledged_at FROM fellow_inbox_notices WHERE id = 'hidden'").get(),
      ).toEqual({ acknowledged_at: null });
    });
  });
});
