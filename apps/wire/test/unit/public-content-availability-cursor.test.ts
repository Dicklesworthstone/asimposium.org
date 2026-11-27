import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../../db/migrations/0165_public_content_availability_cursor.sql", import.meta.url),
  "utf8",
);
const databases: Database[] = [];
afterEach(() => {
  for (const sql of databases.splice(0)) sql.close();
});

/** Real SQLite trigger controls; the area-discovery native lane owns the
 * Workerd/D1 proof with actual publication routes and directory continuations. */
function fixture() {
  const sql = new Database(":memory:");
  databases.push(sql);
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT,
      redacted_at TEXT, redaction_reason TEXT);
    CREATE TABLE public_cursor(singleton INTEGER PRIMARY KEY, cursor INTEGER);
    CREATE TABLE workshop_objects(body TEXT);
    INSERT INTO public_cursor VALUES (1, 10);
    INSERT INTO problems VALUES ('P-PUBLIC', 'active', 4), ('P-PRIVATE', 'private-draft', 1);
    INSERT INTO events VALUES ('E-VISIBLE', 'P-PUBLIC', 1, 'visible-digest'),
      ('E-MISSING', 'P-PUBLIC', 2, 'missing-digest'),
      ('E-REDACTED', 'P-PUBLIC', 3, 'redacted-digest'),
      ('E-MISMATCH', 'P-PUBLIC', 4, 'correct-digest'),
      ('E-FUTURE', 'P-PUBLIC', 5, 'future-digest'),
      ('E-PRIVATE', 'P-PRIVATE', 1, 'private-digest');
    INSERT INTO event_content VALUES ('E-VISIBLE', 'visible-digest', '{}', NULL, NULL),
      ('E-REDACTED', 'redacted-digest', '{}', '2026-11-01T00:00:00.000Z', 'privacy'),
      ('E-MISMATCH', 'wrong-digest', '{}', NULL, NULL),
      ('E-FUTURE', 'future-digest', '{}', NULL, NULL),
      ('E-PRIVATE', 'private-digest', '{}', NULL, NULL);`);
  sql.exec(migration);
  const cursor = () =>
    (sql.query("SELECT cursor FROM public_cursor").get() as { cursor: number }).cursor;
  const witnesses = () =>
    sql.query("SELECT event_id FROM public_content_removals ORDER BY event_id").all();
  return { sql, cursor, witnesses };
}

describe("public content availability change token", () => {
  test("backfills missing public payloads without inventing a change, then invalidates their restoration", () => {
    const f = fixture();
    expect(f.cursor()).toBe(10);
    expect(f.witnesses()).toEqual([{ event_id: "E-MISSING" }]);
    f.sql.exec("INSERT INTO event_content VALUES('E-MISSING','missing-digest','{}',NULL,NULL)");
    expect(f.cursor()).toBe(11);
    expect(f.witnesses()).toEqual([]);
  });

  test("redaction advances once; timestamp edits and rollback do not add committed changes", () => {
    const f = fixture();
    f.sql.exec(
      "BEGIN; UPDATE event_content SET redacted_at='first',redaction_reason='privacy' WHERE event_id='E-VISIBLE'",
    );
    expect(f.cursor()).toBe(11);
    f.sql.exec("ROLLBACK");
    expect(f.cursor()).toBe(10);
    f.sql.exec(
      "UPDATE event_content SET redacted_at='first',redaction_reason='privacy' WHERE event_id='E-VISIBLE'",
    );
    expect(f.cursor()).toBe(11);
    f.sql.exec("UPDATE event_content SET redacted_at='later' WHERE event_id='E-VISIBLE'");
    expect(f.cursor()).toBe(11);
  });

  test("visible removal and exact restoration change only the public token and sparse witness", () => {
    const f = fixture();
    const envelopes = f.sql.query("SELECT * FROM events ORDER BY id").all();
    const heads = f.sql.query("SELECT * FROM problems ORDER BY id").all();
    f.sql.exec("DELETE FROM event_content WHERE event_id='E-VISIBLE'");
    expect(f.cursor()).toBe(11);
    expect(f.witnesses()).toContainEqual({ event_id: "E-VISIBLE" });
    f.sql.exec("INSERT INTO event_content VALUES('E-VISIBLE','visible-digest','{}',NULL,NULL)");
    expect(f.cursor()).toBe(12);
    expect(f.witnesses()).not.toContainEqual({ event_id: "E-VISIBLE" });
    expect(f.sql.query("SELECT * FROM events ORDER BY id").all()).toEqual(envelopes);
    expect(f.sql.query("SELECT * FROM problems ORDER BY id").all()).toEqual(heads);
  });

  test("ordinary initial content insertion leaves the existing publication transaction as token owner", () => {
    const f = fixture();
    f.sql.exec(`UPDATE problems SET public_seq=6 WHERE id='P-PUBLIC';
      INSERT INTO events VALUES('E-NEW','P-PUBLIC',6,'new-digest');
      INSERT INTO event_content VALUES('E-NEW','new-digest','{}',NULL,NULL);`);
    expect(f.cursor()).toBe(10);
    f.sql.exec("UPDATE public_cursor SET cursor=cursor+1 WHERE singleton=1");
    expect(f.cursor()).toBe(11);
  });

  test("private content, future events and private workshop work never allocate public invalidations", () => {
    const f = fixture();
    f.sql.exec(`INSERT INTO workshop_objects VALUES('PRIVATE-CANARY');
      UPDATE event_content SET redacted_at='now' WHERE event_id IN ('E-PRIVATE','E-FUTURE');
      DELETE FROM event_content WHERE event_id IN ('E-PRIVATE','E-FUTURE');
      INSERT INTO event_content VALUES('E-PRIVATE','private-digest','{}',NULL,NULL),
        ('E-FUTURE','future-digest','{}',NULL,NULL);`);
    expect(f.cursor()).toBe(10);
    expect(f.witnesses()).toEqual([{ event_id: "E-MISSING" }]);
  });

  test("removing unavailable rows is quiet, but replacing a mismatched row with public content invalidates", () => {
    const f = fixture();
    f.sql.exec("DELETE FROM event_content WHERE event_id IN ('E-REDACTED','E-MISMATCH')");
    expect(f.cursor()).toBe(10);
    f.sql.exec(
      "INSERT INTO event_content VALUES('E-REDACTED','redacted-digest','{}','still-redacted','privacy')",
    );
    expect(f.cursor()).toBe(10);
    f.sql.exec("INSERT INTO event_content VALUES('E-MISMATCH','correct-digest','{}',NULL,NULL)");
    expect(f.cursor()).toBe(11);
    expect(f.witnesses()).not.toContainEqual({ event_id: "E-MISMATCH" });
  });
});
