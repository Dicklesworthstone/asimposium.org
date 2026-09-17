import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { INSERT_INBOX_NOTICE_SQL } from "../../src/inbox/notice-write.ts";

function fixture(run: (db: Database) => void) {
  const db = new Database(":memory:");
  try {
    // Deliberately keep the production migration's non-unique cursor index:
    // correctness must come from atomic allocation, not a hidden test constraint.
    db.exec(`CREATE TABLE fellow_inbox_notices (
      id TEXT PRIMARY KEY, fellow_id TEXT NOT NULL, problem_id TEXT, notice_type TEXT NOT NULL,
      seq INTEGER NOT NULL, title TEXT NOT NULL, detail TEXT, impact_kind TEXT,
      caused_by_event_id TEXT, target_id TEXT, acknowledged_at INTEGER, expires_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX fellow_inbox_notices_fellow_seq_idx ON fellow_inbox_notices(fellow_id, seq);`);
    run(db);
  } finally {
    db.close();
  }
}

function insert(db: Database, id: string, fellow = "fellow-a", now = 100): number {
  const row = db.query(INSERT_INBOX_NOTICE_SQL).get(
    id, fellow, "P-DEMO", "statement_revision", fellow, "Statement revised",
    "Read the new version", null, "E-synthetic", null, null, now,
  ) as { seq: number };
  return row.seq;
}

function nextLegacyCursor(db: Database, fellow = "fellow-a") {
  return (db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM fellow_inbox_notices WHERE fellow_id = ?")
    .get(fellow) as { seq: number }).seq;
}

describe("atomic inbox notice allocation", () => {
  test("the returned cursor and all metadata belong to the inserted notice", () => {
    fixture((db) => {
      expect(insert(db, "N-1")).toBe(1);
      expect(db.query("SELECT * FROM fellow_inbox_notices WHERE id = ?").get("N-1")).toEqual({
        id: "N-1", fellow_id: "fellow-a", problem_id: "P-DEMO", notice_type: "statement_revision",
        seq: 1, title: "Statement revised", detail: "Read the new version", impact_kind: null,
        caused_by_event_id: "E-synthetic", target_id: null, acknowledged_at: null,
        expires_at: null, created_at: 100,
      });
    });
  });

  test("interleaved recipients have independent monotonic cursors", () => {
    fixture((db) => {
      expect(insert(db, "A-1", "fellow-a")).toBe(1);
      expect(insert(db, "B-1", "fellow-b")).toBe(1);
      expect(insert(db, "A-2", "fellow-a")).toBe(2);
      expect(insert(db, "B-2", "fellow-b")).toBe(2);
      expect(insert(db, "A-3", "fellow-a")).toBe(3);
    });
  });

  test("two preflight reads reproduce the old duplicate-cursor pagination loss", () => {
    fixture((db) => {
      const first = nextLegacyCursor(db);
      const second = nextLegacyCursor(db);
      expect(first).toBe(second);
      const oldInsert = db.query(`INSERT INTO fellow_inbox_notices
        (id, fellow_id, notice_type, seq, title, created_at) VALUES (?, 'fellow-a', 'statement_revision', ?, 'old writer', 1)`);
      oldInsert.run("legacy-a", first);
      oldInsert.run("legacy-b", second);
      const page = db.query("SELECT id, seq FROM fellow_inbox_notices WHERE fellow_id = ? ORDER BY seq, id LIMIT 1")
        .get("fellow-a") as { seq: number };
      expect(db.query("SELECT id FROM fellow_inbox_notices WHERE fellow_id = ? AND seq > ?")
        .all("fellow-a", page.seq)).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS total FROM fellow_inbox_notices").get()).toEqual({ total: 2 });
    });
  });

  test("atomic writers cannot reuse the same preflight cursor", () => {
    fixture((db) => {
      expect(nextLegacyCursor(db)).toBe(1);
      expect(nextLegacyCursor(db)).toBe(1);
      expect(insert(db, "N-1")).toBe(1);
      expect(insert(db, "N-2")).toBe(2);
      expect(db.query("SELECT id FROM fellow_inbox_notices WHERE fellow_id = ? AND seq > ? ORDER BY seq")
        .all("fellow-a", 1)).toEqual([{ id: "N-2" }]);
    });
  });

  test("new allocation advances past legacy duplicate heads without rewriting history", () => {
    fixture((db) => {
      insert(db, "legacy-a");
      insert(db, "legacy-b");
      db.exec("UPDATE fellow_inbox_notices SET seq = 7");
      expect(insert(db, "N-new")).toBe(8);
      expect(db.query("SELECT id, seq FROM fellow_inbox_notices WHERE id LIKE 'legacy-%' ORDER BY id")
        .all()).toEqual([{ id: "legacy-a", seq: 7 }, { id: "legacy-b", seq: 7 }]);
    });
  });

  test("acknowledgment and expiration cannot rewind the recipient's head", () => {
    fixture((db) => {
      insert(db, "N-1");
      db.exec("UPDATE fellow_inbox_notices SET acknowledged_at = 200, expires_at = 200");
      expect(insert(db, "N-2", "fellow-a", 300)).toBe(2);
    });
  });

  test("a failed duplicate ID creates no partial notice or fictional cursor", () => {
    fixture((db) => {
      insert(db, "N-1");
      let failed = false;
      try {
        insert(db, "N-1");
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(insert(db, "N-2")).toBe(2);
      expect(db.query("SELECT COUNT(*) AS total FROM fellow_inbox_notices").get()).toEqual({ total: 2 });
    });
  });

  test("rolling back a producer transaction rolls back the cursor with its notice", () => {
    fixture((db) => {
      insert(db, "N-1");
      db.exec("BEGIN");
      expect(insert(db, "rolled-back")).toBe(2);
      db.exec("ROLLBACK");
      expect(insert(db, "N-2")).toBe(2);
      expect(db.query("SELECT id FROM fellow_inbox_notices WHERE id = 'rolled-back'").get()).toBe(null);
    });
  });

  test("polling over a burst visits every notice exactly once", () => {
    fixture((db) => {
      for (let index = 1; index <= 100; index++) expect(insert(db, `N-${index}`)).toBe(index);
      let since = 0;
      const seen: string[] = [];
      for (;;) {
        const page = db.query("SELECT id, seq FROM fellow_inbox_notices WHERE fellow_id = ? AND seq > ? ORDER BY seq LIMIT 7")
          .all("fellow-a", since) as { id: string; seq: number }[];
        if (page.length === 0) break;
        seen.push(...page.map((row) => row.id));
        since = page[page.length - 1]?.seq ?? since;
      }
      expect(seen).toEqual(Array.from({ length: 100 }, (_, index) => `N-${index + 1}`));
      expect(since).toBe(100);
    });
  });

  test("notice IDs and recipients remain parameters rather than SQL", () => {
    fixture((db) => {
      const id = "N-'; DROP TABLE fellow_inbox_notices; --";
      expect(insert(db, id, "fellow-'quoted")).toBe(1);
      expect(insert(db, "N-normal")).toBe(1);
      expect(db.query("SELECT fellow_id FROM fellow_inbox_notices WHERE id = ?").get(id))
        .toEqual({ fellow_id: "fellow-'quoted" });
    });
  });
});
