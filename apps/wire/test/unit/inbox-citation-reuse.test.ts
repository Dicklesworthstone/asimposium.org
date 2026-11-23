import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  INBOX_UNACKNOWLEDGED_SQL,
  VISIBLE_INBOX_NOTICE_SQL,
} from "../../src/inbox/follow-access.ts";
import { ledgerNoticeActions } from "../../src/inbox/ledger-notice-actions.ts";

// Shipped trigger and visibility SQL on SQLite. The mounted HTTP/D1 journey
// lives in citations-real-bindings.mjs; these tests do not replace that gate.
function fixture(run: (db: Database) => void) {
  const db = new Database(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY);
      CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT NOT NULL, public_seq INTEGER NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
        object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
        actor_fellow_id TEXT, created_at TEXT);
      CREATE TABLE event_content (event_id TEXT, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
      CREATE TABLE content_controls (problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
      CREATE TABLE scientific_withdrawals (event_id TEXT,problem_id TEXT,seq INTEGER,event_sha256 TEXT,
        retraction_id TEXT,target_kind TEXT,target_object TEXT,source_event_id TEXT,source_sha256 TEXT);
      CREATE TABLE retractions (problem_id TEXT,seq INTEGER,target_object TEXT,author_fellow_id TEXT);
      CREATE TABLE problem_memberships (problem_id TEXT,fellow_id TEXT);
      CREATE TABLE citations (problem_id TEXT,citation_id TEXT,author_fellow_id TEXT,
        canonical_locator TEXT,locator_kind TEXT,version INTEGER,seq INTEGER,created_at TEXT,
        PRIMARY KEY (problem_id,citation_id));
      INSERT INTO enrollment_fellows VALUES ('fellow-a'),('fellow-b'),('fellow-c');
      INSERT INTO problems VALUES ('P-ORIGIN','active',0),('P-REUSE','active',0),('P-OTHER','active',0);`);
    for (const name of [
      "0064_inbox_and_follows.sql",
      "0082_citation_reused_impact_echo.sql",
      "0153_citation_reuse_source_pins.sql",
    ]) {
      db.exec(readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8"));
    }
    run(db);
  } finally {
    db.close();
  }
}

function publication(
  db: Database,
  problem: string,
  fellow: string,
  seq: number,
  version = 1,
  locator = "10.1234/source",
) {
  const id = `${problem}-${seq}`;
  const payload = JSON.stringify({
    citation_id: "L-1",
    locator_kind: "doi",
    canonical_locator: locator,
  });
  const digest = createHash("sha256").update(payload).digest("hex");
  db.query("UPDATE problems SET public_seq = ? WHERE id = ?").run(seq, problem);
  db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id,
    problem,
    seq,
    version === 1 ? "citation.recorded" : "citation.corrected",
    "citation",
    "L-1",
    version,
    digest,
    fellow,
    `2026-11-23T00:00:0${seq}.000Z`,
  );
  db.query("INSERT INTO event_content VALUES (?,?,?,NULL)").run(id, digest, payload);
  if (version === 1) {
    db.query("INSERT INTO citations VALUES (?,'L-1',?,?,'doi',1,?,?)").run(
      problem,
      fellow,
      locator,
      seq,
      `2026-11-23T00:00:0${seq}.000Z`,
    );
  } else {
    db.query("UPDATE citations SET version=?,seq=?,canonical_locator=? WHERE problem_id=?").run(
      version,
      seq,
      locator,
      problem,
    );
  }
  return { id, digest };
}

const visible = (db: Database, limit = 50) =>
  db
    .query(`
  SELECT id,seq,detail FROM fellow_inbox_notices WHERE fellow_id='fellow-a'
    AND ${VISIBLE_INBOX_NOTICE_SQL} ORDER BY seq LIMIT ?`)
    .all(limit) as { id: string; seq: number; detail: string | null }[];
const count = (db: Database) =>
  (db.query(INBOX_UNACKNOWLEDGED_SQL).get("fellow-a", 0) as { unack: number }).unack;
const acknowledge = (db: Database) =>
  db
    .query(`UPDATE fellow_inbox_notices SET acknowledged_at=100
  WHERE fellow_id='fellow-a' AND impact_kind='citation_reused' AND acknowledged_at IS NULL
    AND ${VISIBLE_INBOX_NOTICE_SQL}`)
    .run().changes;
const pair = (db: Database) => {
  const origin = publication(db, "P-ORIGIN", "fellow-a", 1);
  const reuse = publication(db, "P-REUSE", "fellow-b", 2);
  return { origin, reuse };
};

describe("citation reuse notices retain exact public sources", () => {
  test("the publication transaction captures both event commitments and one private echo", () => {
    fixture((db) => {
      const { origin, reuse } = pair(db);
      const notices = visible(db);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.detail).toContain("L-1@1 on P-ORIGIN");
      expect(notices[0]?.detail).toContain("L-1@1 on P-REUSE");
      expect(
        db
          .query(`SELECT origin_event_id,origin_sha256,reuse_event_id,reuse_sha256
        FROM citation_reuse_notice_sources`)
          .get(),
      ).toEqual({
        origin_event_id: origin.id,
        origin_sha256: origin.digest,
        reuse_event_id: reuse.id,
        reuse_sha256: reuse.digest,
      });
      expect(count(db)).toBe(1);
      expect(acknowledge(db)).toBe(1);
      expect(acknowledge(db)).toBe(0);
      expect(
        db.query("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE fellow_id='fellow-b'").get(),
      ).toEqual({ n: 0 });
    });
  });

  test.each(["origin", "reuse"] as const)(
    "a current %s hide governs reads, pagination, counts and acknowledgments",
    (side) => {
      for (const target of [
        "problem",
        side === "origin" ? "P-ORIGIN" : "P-REUSE",
        "L-1",
        "L-1@1",
        side === "origin" ? "#1" : "#2",
      ]) {
        fixture((db) => {
          pair(db);
          db.exec(`INSERT INTO fellow_inbox_notices
          (id,fellow_id,notice_type,seq,title,created_at)
          VALUES ('N-later','fellow-a','protocol_notice',2,'Later account notice',0)`);
          const problem = side === "origin" ? "P-ORIGIN" : "P-REUSE";
          db.query("INSERT INTO content_controls VALUES (?,?,1,'hidden')").run(problem, target);
          expect(visible(db, 1).map((row) => row.id)).toEqual(["N-later"]);
          expect(count(db)).toBe(1);
          expect(acknowledge(db)).toBe(0);
          db.query("INSERT INTO content_controls VALUES (?,?,2,'visible')").run(problem, target);
          expect(visible(db)).toHaveLength(2);
          expect(count(db)).toBe(2);
        });
      }
    },
  );

  test.each(["origin", "reuse"] as const)(
    "a redacted %s or mismatched content commitment cannot survive as a notice",
    (side) => {
      fixture((db) => {
        const sources = pair(db);
        const source = sources[side];
        db.query("UPDATE event_content SET redacted_at='redacted' WHERE event_id=?").run(source.id);
        expect(visible(db)).toEqual([]);
        expect(count(db)).toBe(0);
        expect(acknowledge(db)).toBe(0);
        db.query("UPDATE event_content SET redacted_at=NULL,payload_sha256=? WHERE event_id=?").run(
          "0".repeat(64),
          source.id,
        );
        expect(visible(db)).toEqual([]);
        expect(count(db)).toBe(0);
        db.query("UPDATE event_content SET payload_sha256=? WHERE event_id=?").run(
          source.digest,
          source.id,
        );
        expect(visible(db)).toHaveLength(1);
      });
    },
  );

  test("legacy unpinned notices and a substituted cause never infer authority from prose", () => {
    fixture((db) => {
      pair(db);
      db.exec(`INSERT INTO fellow_inbox_notices
        (id,fellow_id,problem_id,notice_type,seq,title,detail,impact_kind,caused_by_event_id,target_id,created_at)
        SELECT 'N-legacy',fellow_id,problem_id,notice_type,2,title,detail,impact_kind,caused_by_event_id,target_id,created_at
        FROM fellow_inbox_notices LIMIT 1`);
      expect(visible(db)).toHaveLength(1);
      db.exec("UPDATE fellow_inbox_notices SET caused_by_event_id='P-ORIGIN-1'");
      expect(visible(db)).toEqual([]);
      expect(count(db)).toBe(0);
      expect(acknowledge(db)).toBe(0);
    });
  });

  test.each(["private", "hidden", "redacted"])(
    "an earlier %s source cannot suppress the first eligible recorder",
    (kind) => {
      fixture((db) => {
        publication(db, "P-OTHER", "fellow-c", 1);
        if (kind === "private")
          db.exec("UPDATE problems SET status='private-draft' WHERE id='P-OTHER'");
        if (kind === "hidden")
          db.exec("INSERT INTO content_controls VALUES ('P-OTHER','L-1',1,'hidden')");
        if (kind === "redacted")
          db.exec("UPDATE event_content SET redacted_at='redacted' WHERE event_id='P-OTHER-1'");
        publication(db, "P-ORIGIN", "fellow-a", 2);
        publication(db, "P-REUSE", "fellow-b", 3);
        expect(visible(db)).toHaveLength(1);
        expect(visible(db)[0]?.detail).toContain("L-1@1 on P-ORIGIN");
        expect(
          db
            .query("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE fellow_id='fellow-c'")
            .get(),
        ).toEqual({ n: 0 });
      });
    },
  );

  test.each(["origin", "reuse"] as const)(
    "later corrections cannot silently replace the pinned %s",
    (side) => {
      fixture((db) => {
        pair(db);
        const problem = side === "origin" ? "P-ORIGIN" : "P-REUSE";
        publication(
          db,
          problem,
          side === "origin" ? "fellow-a" : "fellow-b",
          3,
          2,
          "10.1234/corrected-source",
        );
        expect(visible(db)).toHaveLength(1);
        expect(visible(db)[0]?.detail).toContain("L-1@1 on P-ORIGIN");
        expect(
          ledgerNoticeActions("impact_echo", "P-REUSE", "L-1", "citation_reused")[0]?.url,
        ).toBe("/p/P-REUSE/citations/L-1@1.json");
        db.query("INSERT INTO content_controls VALUES (?,'L-1@1',1,'hidden')").run(problem);
        expect(visible(db)).toEqual([]);
      });
    },
  );

  test.each(["private", "hidden"])(
    "a %s reuse creates no notice and self-reuse has no recipient",
    (kind) => {
      fixture((db) => {
        publication(db, "P-ORIGIN", "fellow-a", 1);
        if (kind === "private")
          db.exec("UPDATE problems SET status='private-draft' WHERE id='P-REUSE'");
        else db.exec("INSERT INTO content_controls VALUES ('P-REUSE','L-1@1',1,'hidden')");
        publication(db, "P-REUSE", "fellow-b", 2);
        publication(db, "P-OTHER", "fellow-a", 3);
        expect(db.query("SELECT COUNT(*) AS n FROM fellow_inbox_notices").get()).toEqual({ n: 0 });
        expect(db.query("SELECT COUNT(*) AS n FROM citation_reuse_notice_sources").get()).toEqual({
          n: 0,
        });
      });
    },
  );

  test("the first recorder re-citing after somebody else creates no echo to the later recorder", () => {
    fixture((db) => {
      pair(db);
      publication(db, "P-OTHER", "fellow-a", 3);
      expect(visible(db)).toHaveLength(1);
      expect(
        db.query("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE fellow_id='fellow-b'").get(),
      ).toEqual({ n: 0 });
      expect(db.query("SELECT COUNT(*) AS n FROM citation_reuse_notice_sources").get()).toEqual({
        n: 1,
      });
    });
  });

  test("an aborted citation rolls back its source pins and notification", () => {
    fixture((db) => {
      publication(db, "P-ORIGIN", "fellow-a", 1);
      db.exec("BEGIN");
      publication(db, "P-REUSE", "fellow-b", 2);
      expect(visible(db)).toHaveLength(1);
      db.exec("ROLLBACK");
      expect(visible(db)).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS n FROM citation_reuse_notice_sources").get()).toEqual({
        n: 0,
      });
    });
  });

  test("repairing citation projections cannot authorize legacy notices or invent historical echoes", () => {
    fixture((db) => {
      publication(db, "P-ORIGIN", "fellow-a", 1);
      db.exec("UPDATE problems SET status='private-draft' WHERE id='P-REUSE'");
      publication(db, "P-REUSE", "fellow-b", 2);
      db.exec(`UPDATE problems SET status='active' WHERE id='P-REUSE';
        INSERT INTO fellow_inbox_notices
          (id,fellow_id,problem_id,notice_type,seq,title,detail,impact_kind,caused_by_event_id,target_id,created_at)
        VALUES ('N-citation-reused-P-REUSE-L-1','fellow-a','P-REUSE','impact_echo',1,
          'Legacy citation echo','No source pins','citation_reused','P-REUSE-2','L-1',0);
        DELETE FROM citations WHERE problem_id='P-REUSE';
        INSERT INTO citations VALUES ('P-REUSE','L-1','fellow-b','10.1234/source','doi',1,2,'2026-11-23T00:00:02.000Z');`);
      expect(visible(db)).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS n FROM citation_reuse_notice_sources").get()).toEqual({
        n: 0,
      });
      db.exec(`DELETE FROM fellow_inbox_notices;
        DELETE FROM citations WHERE problem_id='P-REUSE';
        INSERT INTO citations VALUES ('P-REUSE','L-1','fellow-b','10.1234/source','doi',1,2,'2026-11-23T00:00:02.000Z');`);
      expect(db.query("SELECT COUNT(*) AS n FROM fellow_inbox_notices").get()).toEqual({ n: 0 });
    });
  });
});
