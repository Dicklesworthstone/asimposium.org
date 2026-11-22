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
      ALTER TABLE problems ADD COLUMN public_seq INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE events(id TEXT,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
        object_id TEXT,object_version INTEGER,payload_sha256 TEXT,actor_fellow_id TEXT);
      CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
      CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
      CREATE TABLE scientific_withdrawals(event_id TEXT,problem_id TEXT,seq INTEGER,event_sha256 TEXT,
        retraction_id TEXT,target_kind TEXT,target_object TEXT,source_event_id TEXT,source_sha256 TEXT);
      CREATE TABLE retractions(problem_id TEXT,seq INTEGER,target_object TEXT,author_fellow_id TEXT);
      CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY);
      CREATE TABLE problem_memberships (problem_id TEXT, fellow_id TEXT, PRIMARY KEY(problem_id, fellow_id));
      CREATE TABLE problem_follows (principal_id TEXT, problem_id TEXT, created_at INTEGER, PRIMARY KEY(principal_id, problem_id));
      CREATE TABLE fellow_inbox_notices (
        id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT, seq INTEGER, acknowledged_at INTEGER,
        notice_type TEXT DEFAULT 'statement_revision', target_id TEXT, caused_by_event_id TEXT,
        expires_at INTEGER
      );
      INSERT INTO problems(id,status,unlisted) VALUES ('P-PUBLIC', 'active', 0), ('P-UNLISTED', 'active', 1), ('P-PRIVATE', 'private-draft', 1);
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
  db.query(
    "INSERT INTO fellow_inbox_notices(id,fellow_id,problem_id,seq,acknowledged_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(id, fellow, problem, seq);
}

function visible(db: Database, fellow: string, since = 0, limit = 50) {
  return db
    .query(`SELECT id, seq FROM fellow_inbox_notices
      WHERE fellow_id = ? AND ${VISIBLE_INBOX_NOTICE_SQL} AND seq > ? ORDER BY seq LIMIT ?`)
    .all(fellow, since, limit) as { id: string; seq: number }[];
}

function unacknowledged(db: Database, fellow: string) {
  return (db.query(INBOX_UNACKNOWLEDGED_SQL).get(fellow, 100) as { unack: number }).unack;
}

function claimCritique(db: Database, kind: "review" | "evidence") {
  const sourceId = kind === "review" ? "R-1" : "E-1";
  const payload =
    kind === "review"
      ? { target_claim_id: "C-1", target_version: 1 }
      : { bears_on_kind: "claim", bears_on_id: "C-1", bears_on_version: 1 };
  db.exec(`UPDATE problems SET public_seq = 10 WHERE id = 'P-PUBLIC';
    INSERT INTO events VALUES
      ('claim-source','P-PUBLIC',1,'claim.created','claim','C-1',1,'claim-digest','fellow-a');
    INSERT INTO event_content VALUES ('claim-source','claim-digest','{}',NULL);`);
  db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)").run(
    "critique-source",
    "P-PUBLIC",
    2,
    `${kind}.created`,
    kind,
    sourceId,
    1,
    "critique-digest",
    "fellow-b",
  );
  db.query("INSERT INTO event_content VALUES (?,?,?,NULL)").run(
    "critique-source",
    "critique-digest",
    JSON.stringify(payload),
  );
  notice(db, "critique", "fellow-a", "P-PUBLIC", 1);
  db.exec(`UPDATE fellow_inbox_notices SET notice_type='object_critique',
    target_id='C-1@1', caused_by_event_id='critique-source' WHERE id='critique'`);
  return sourceId;
}

function acknowledgeVisible(db: Database) {
  return db
    .query(`UPDATE fellow_inbox_notices SET acknowledged_at = 100
      WHERE fellow_id = 'fellow-a' AND id = 'critique'
        AND acknowledged_at IS NULL AND ${VISIBLE_INBOX_NOTICE_SQL}`)
    .run().changes;
}

describe.each(["review", "evidence"] as const)("current claim %s notice visibility", (kind) => {
  test("keeps the exact published version readable after a later revision", () => {
    fixture((db) => {
      claimCritique(db, kind);
      expect(visible(db, "fellow-a")).toEqual([{ id: "critique", seq: 1 }]);
      db.exec(`INSERT INTO events VALUES
        ('claim-v2','P-PUBLIC',3,'claim.revised','claim','C-1',2,'v2-digest','fellow-a');
        INSERT INTO event_content VALUES ('claim-v2','v2-digest','{}',NULL);
        INSERT INTO content_controls VALUES ('P-PUBLIC','C-1@2',1,'hidden');`);
      expect(visible(db, "fellow-a")).toEqual([{ id: "critique", seq: 1 }]);
      expect(unacknowledged(db, "fellow-a")).toBe(1);
      expect(acknowledgeVisible(db)).toBe(1);
    });
  });

  test.each([
    "source",
    "source-version",
    "source-event",
    "target",
    "target-version",
    "target-event",
    "problem",
  ] as const)(
    "current %s hide suppresses the entire notice, counts and acknowledgment until restored",
    (hidden) => {
      fixture((db) => {
        const source = claimCritique(db, kind);
        const target = {
          source,
          "source-version": `${source}@1`,
          "source-event": "#2",
          target: "C-1",
          "target-version": "C-1@1",
          "target-event": "#1",
          problem: "problem",
        }[hidden];
        db.query("INSERT INTO content_controls VALUES ('P-PUBLIC',?,1,'hidden')").run(target);
        expect(visible(db, "fellow-a")).toEqual([]);
        expect(unacknowledged(db, "fellow-a")).toBe(0);
        expect(acknowledgeVisible(db)).toBe(0);
        expect(db.query("SELECT acknowledged_at FROM fellow_inbox_notices").get()).toEqual({
          acknowledged_at: null,
        });
        db.query("INSERT INTO content_controls VALUES ('P-PUBLIC',?,2,'visible')").run(target);
        expect(visible(db, "fellow-a")).toEqual([{ id: "critique", seq: 1 }]);
        expect(unacknowledged(db, "fellow-a")).toBe(1);
      });
    },
  );

  test.each(["critique-source", "claim-source"])(
    "redacting %s removes the retained notice from every read",
    (source) => {
      fixture((db) => {
        claimCritique(db, kind);
        db.query("UPDATE event_content SET redacted_at='redacted' WHERE event_id=?").run(source);
        notice(db, "later-account", "fellow-a", null, 2);
        expect(visible(db, "fellow-a", 0, 1)).toEqual([{ id: "later-account", seq: 2 }]);
        expect(unacknowledged(db, "fellow-a")).toBe(1);
        expect(acknowledgeVisible(db)).toBe(0);
      });
    },
  );

  test("a recorded source withdrawal still applies when its rationale is hidden", () => {
    fixture((db) => {
      const source = claimCritique(db, kind);
      db.exec(`INSERT INTO events VALUES
        ('withdraw-source','P-PUBLIC',4,'object.retracted','retraction','RT-1',1,'withdraw-digest','fellow-b');
        INSERT INTO content_controls VALUES ('P-PUBLIC','RT-1',1,'hidden');`);
      db.query("INSERT INTO scientific_withdrawals VALUES (?,?,?,?,?,?,?,?,?)").run(
        "withdraw-source",
        "P-PUBLIC",
        4,
        "withdraw-digest",
        "RT-1",
        kind,
        source,
        "critique-source",
        "critique-digest",
      );
      expect(visible(db, "fellow-a")).toEqual([]);
      expect(unacknowledged(db, "fellow-a")).toBe(0);
      expect(acknowledgeVisible(db)).toBe(0);
    });
  });

  test.each(["C-1", "C-1@1"])(
    "withdrawing the target %s removes obsolete actionability",
    (target) => {
      fixture((db) => {
        claimCritique(db, kind);
        db.exec(`INSERT INTO events VALUES
        ('withdraw-target','P-PUBLIC',4,'object.retracted','retraction','RT-2',1,'withdraw-digest','fellow-a');`);
        db.query("INSERT INTO retractions VALUES ('P-PUBLIC',4,?,'fellow-a')").run(target);
        expect(visible(db, "fellow-a")).toEqual([]);
        expect(unacknowledged(db, "fellow-a")).toBe(0);
        expect(acknowledgeVisible(db)).toBe(0);
      });
    },
  );

  test.each(["target", "version", "problem", "recipient", "cause", "digest"])(
    "a mismatched %s cannot make a retained notice actionable",
    (mismatch) => {
      fixture((db) => {
        claimCritique(db, kind);
        if (mismatch === "target") db.exec("UPDATE fellow_inbox_notices SET target_id='C-2@1'");
        if (mismatch === "version") db.exec("UPDATE fellow_inbox_notices SET target_id='C-1@2'");
        if (mismatch === "problem")
          db.exec("UPDATE fellow_inbox_notices SET problem_id='P-UNLISTED'");
        if (mismatch === "recipient")
          db.exec("UPDATE events SET actor_fellow_id='fellow-b' WHERE id='claim-source'");
        if (mismatch === "cause")
          db.exec("UPDATE fellow_inbox_notices SET caused_by_event_id='claim-source'");
        if (mismatch === "digest")
          db.exec(
            "UPDATE event_content SET payload_sha256='other' WHERE event_id='critique-source'",
          );
        expect(visible(db, "fellow-a")).toEqual([]);
        expect(unacknowledged(db, "fellow-a")).toBe(0);
        expect(acknowledgeVisible(db)).toBe(0);
      });
    },
  );

  test("legacy source-target notices retain history but obey current source controls", () => {
    fixture((db) => {
      const source = claimCritique(db, kind);
      db.query("UPDATE fellow_inbox_notices SET target_id=?").run(source);
      expect(visible(db, "fellow-a")).toEqual([{ id: "critique", seq: 1 }]);
      db.query("INSERT INTO content_controls VALUES ('P-PUBLIC',?,1,'hidden')").run(source);
      expect(visible(db, "fellow-a")).toEqual([]);
      expect(unacknowledged(db, "fellow-a")).toBe(0);
    });
  });
});

describe("follow and inbox visibility is current authority, not a subscription", () => {
  test.each(["problem", "P-PUBLIC"])(
    "a current %s hide refuses new follows, status reads and revision fan-out until restored",
    (target) => {
      fixture((db) => {
        follow(db, "fellow-a", "P-PUBLIC");
        db.exec("INSERT INTO problem_memberships VALUES ('P-PUBLIC','fellow-a')");
        db.query("INSERT INTO content_controls VALUES ('P-PUBLIC',?,1,'hidden')").run(target);
        follow(db, "fellow-b", "P-PUBLIC");
        expect(status(db, "fellow-a", "P-PUBLIC")).toBe(null);
        expect(status(db, "fellow-b", "P-PUBLIC")).toBe(null);
        expect(db.query(FOLLOW_RECIPIENTS_SQL).all("P-PUBLIC")).toEqual([]);
        expect(db.query("SELECT principal_id FROM problem_follows").all()).toEqual([
          { principal_id: "fellow-a" },
        ]);
        db.query("INSERT INTO content_controls VALUES ('P-PUBLIC',?,2,'visible')").run(target);
        expect(status(db, "fellow-a", "P-PUBLIC")?.created_at).toBe(100);
        expect(db.query(FOLLOW_RECIPIENTS_SQL).all("P-PUBLIC")).toEqual([
          { principal_id: "fellow-a" },
        ]);
        follow(db, "fellow-b", "P-PUBLIC");
        expect(status(db, "fellow-b", "P-PUBLIC")?.created_at).toBe(100);
      });
    },
  );

  test.each(["problem", "P-PUBLIC"])(
    "a %s hide suppresses retained scientific notices before pagination, counts and acknowledgments",
    (target) => {
      fixture((db) => {
        const researchTypes = [
          "review_request",
          "review_decline",
          "disposition_change",
          "statement_revision",
          "impact_echo",
        ];
        researchTypes.forEach((type, index) => {
          notice(db, type, "fellow-a", "P-PUBLIC", index + 1);
          db.query("UPDATE fellow_inbox_notices SET notice_type=? WHERE id=?").run(type, type);
        });
        notice(db, "account", "fellow-a", null, 6);
        notice(db, "private-member", "fellow-a", "P-PRIVATE", 7);
        notice(db, "unlisted", "fellow-a", "P-UNLISTED", 8);
        db.query("INSERT INTO content_controls VALUES ('P-PUBLIC',?,1,'hidden')").run(target);
        expect(visible(db, "fellow-a", 0, 1)).toEqual([{ id: "account", seq: 6 }]);
        expect(visible(db, "fellow-a").map((row) => row.id)).toEqual([
          "account",
          "private-member",
          "unlisted",
        ]);
        expect(unacknowledged(db, "fellow-a")).toBe(3);
        expect(
          db
            .query(`UPDATE fellow_inbox_notices SET acknowledged_at=100
            WHERE fellow_id='fellow-a' AND seq <= 5 AND ${VISIBLE_INBOX_NOTICE_SQL}`)
            .run().changes,
        ).toBe(0);
        db.query("INSERT INTO content_controls VALUES ('P-PUBLIC',?,2,'visible')").run(target);
        expect(unacknowledged(db, "fellow-a")).toBe(8);
        expect(
          visible(db, "fellow-a")
            .slice(0, 5)
            .map((row) => row.id),
        ).toEqual(researchTypes);
      });
    },
  );

  test("known public and unlisted IDs remain followable without membership", () => {
    fixture((db) => {
      for (const id of ["P-PUBLIC", "P-UNLISTED"]) {
        expect(status(db, "fellow-b", id)?.created_at).toBe(null);
        follow(db, "fellow-b", id);
        expect(status(db, "fellow-b", id)?.created_at).toBe(100);
      }
    });
  });

  test("restoring only one whole-problem control cannot reveal the problem", () => {
    fixture((db) => {
      db.exec(`INSERT INTO content_controls VALUES
        ('P-PUBLIC','problem',1,'hidden'),('P-PUBLIC','P-PUBLIC',1,'hidden'),
        ('P-PUBLIC','problem',2,'visible')`);
      notice(db, "research", "fellow-a", "P-PUBLIC", 1);
      follow(db, "fellow-a", "P-PUBLIC");
      expect(status(db, "fellow-a", "P-PUBLIC")).toBe(null);
      expect(visible(db, "fellow-a")).toEqual([]);
      db.exec("INSERT INTO content_controls VALUES ('P-PUBLIC','P-PUBLIC',2,'visible')");
      expect(status(db, "fellow-a", "P-PUBLIC")?.created_at).toBeNull();
      expect(visible(db, "fellow-a")).toEqual([{ id: "research", seq: 1 }]);
    });
  });

  test("hiding research preserves the recipient's private recovery and directive channels", () => {
    fixture((db) => {
      const privateTypes = [
        "sponsor_directive",
        "protocol_notice",
        "moderation_outcome",
        "lease_expiry_warning",
      ];
      privateTypes.forEach((type, index) => {
        notice(db, type, "fellow-a", "P-PUBLIC", index + 1);
        db.query("UPDATE fellow_inbox_notices SET notice_type=? WHERE id=?").run(type, type);
      });
      db.exec("INSERT INTO content_controls VALUES ('P-PUBLIC','problem',1,'hidden')");
      expect(visible(db, "fellow-a").map((row) => row.id)).toEqual(privateTypes);
      expect(unacknowledged(db, "fellow-a")).toBe(privateTypes.length);
      expect(visible(db, "fellow-b")).toEqual([]);
      db.exec("UPDATE problems SET status='private-draft' WHERE id='P-PUBLIC'");
      expect(visible(db, "fellow-a")).toEqual([]);
      db.exec("INSERT INTO problem_memberships VALUES ('P-PUBLIC','fellow-a')");
      expect(visible(db, "fellow-a").map((row) => row.id)).toEqual(privateTypes);
    });
  });

  test("unfollow removes only the caller's preference after hide or loss of private membership", () => {
    fixture((db) => {
      follow(db, "fellow-a", "P-PUBLIC");
      follow(db, "fellow-b", "P-PUBLIC");
      follow(db, "fellow-a", "P-PRIVATE");
      db.exec(`INSERT INTO content_controls VALUES ('P-PUBLIC','problem',1,'hidden');
        DELETE FROM problem_memberships WHERE fellow_id='fellow-a'`);
      db.query(FOLLOW_DELETE_SQL).run("fellow-a", "P-PUBLIC");
      db.query(FOLLOW_DELETE_SQL).run("fellow-a", "P-PRIVATE");
      db.query(FOLLOW_DELETE_SQL).run("fellow-a", "P-MISSING");
      expect(db.query("SELECT principal_id,problem_id FROM problem_follows").all()).toEqual([
        { principal_id: "fellow-b", problem_id: "P-PUBLIC" },
      ]);
      db.exec("INSERT INTO content_controls VALUES ('P-PUBLIC','problem',2,'visible')");
      expect(status(db, "fellow-a", "P-PUBLIC")?.created_at).toBeNull();
      expect(status(db, "fellow-b", "P-PUBLIC")?.created_at).toBe(100);
    });
  });

  test("private outsiders and nonexistent targets are indistinguishable", () => {
    fixture((db) => {
      for (const id of ["P-PRIVATE", "P-MISSING"]) {
        follow(db, "fellow-b", id);
        expect(status(db, "fellow-b", id)).toBe(null);
        db.query(FOLLOW_DELETE_SQL).run("fellow-b", id);
      }
      expect(db.query("SELECT * FROM problem_follows").all()).toEqual([]);
    });
  });

  test("current private members can follow and unfollow", () => {
    fixture((db) => {
      follow(db, "fellow-a", "P-PRIVATE");
      expect(status(db, "fellow-a", "P-PRIVATE")?.created_at).toBe(100);
      db.query(FOLLOW_DELETE_SQL).run("fellow-a", "P-PRIVATE");
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
      db.query(FOLLOW_DELETE_SQL).run("fellow-b", "P-PUBLIC");
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
