import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migrationRoot = new URL("../../../../db/migrations/", import.meta.url);
const capacityMigration = readFileSync(
  new URL("0096_workshop_publication_capacity.sql", migrationRoot),
  "utf8",
);
const PUBLICATION_BYTES = 512 * 1024;

/** SQLite migration evidence, with only external identity tables reduced to
 * their real referenced keys. Workshop tables/triggers come from the actual
 * historical migrations; the production route has a separate Workerd proof. */
function fixture() {
  const db = new Database(":memory:", { strict: true });
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE problems(id TEXT PRIMARY KEY);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY);
    CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY);
    CREATE TABLE events(id TEXT PRIMARY KEY);
    INSERT INTO problems VALUES('P-TEST');
    INSERT INTO enrollment_fellows VALUES('fellow-test');
    INSERT INTO sponsors VALUES('usr_test');
    INSERT INTO events VALUES('E-published');`);
  for (const name of [
    "0017_sessions_workshop_cursor.sql",
    "0022_workshop_cas_spill.sql",
    "0046_workshop_revision.sql",
    "0057_workshop_revisions_and_archival.sql",
    "0074_workshop_publication_drafts.sql",
    "0093_workshop_revision_head.sql",
    "0094_workshop_sponsor_attribution.sql",
    "0095_sponsor_workshop_index.sql",
  ]) {
    db.exec(readFileSync(new URL(name, migrationRoot), "utf8"));
  }
  db.exec(`INSERT INTO sessions
    (session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at,closed_at)
    VALUES('ASIMP-SN-one','fellow-test','P-TEST','2026-01-01','2026-01-01','2026-01-02','2026-01-02'),
      ('ASIMP-SN-two','fellow-test','P-TEST','2026-01-03','2026-01-03','2026-01-04',NULL);
    INSERT INTO workshop_objects
      (workshop_id,problem_id,fellow_id,session_id,workshop_seq,type,title,body_md,cas_hash,
       force_note,revision_json,current_version,state,ledger_intent_json,created_at,updated_at,publication_json)
    VALUES('W-history','P-TEST','fellow-test','ASIMP-SN-one',3,'claim-draft','Private title',
      'Private CAS extract','sha256:abcd',1,'{"claim_id":"C-1","statement":"replacement"}',
      3,'archived','{"kind":"create","target_kind":"claim"}','2026-01-01','2026-01-04',
      '{ "kind": "conjecture", "statement": "exact original bytes" }'),
      ('W-open','P-TEST','fellow-test','ASIMP-SN-two',4,'scratch','Open draft','Private body',
       NULL,0,NULL,1,'open',NULL,'2026-01-03',NULL,NULL);
    INSERT INTO workshop_revisions
      (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,
       ledger_intent_json,revision_json,revise_action,created_at,publication_json,acting_sponsor_id,publication_event_id)
    SELECT workshop_id,1,problem_id,fellow_id,session_id,type,'First version','Original private body',NULL,
      NULL,NULL,'create',created_at,NULL,NULL,NULL FROM workshop_objects;
    INSERT INTO workshop_revisions
      (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,
       ledger_intent_json,revision_json,revise_action,created_at,publication_json,acting_sponsor_id,publication_event_id)
    SELECT workshop_id,2,problem_id,fellow_id,'ASIMP-SN-two',type,title,body_md,cas_hash,
      ledger_intent_json,revision_json,'edit','2026-01-03',publication_json,NULL,NULL
      FROM workshop_objects WHERE workshop_id='W-history';
    INSERT INTO workshop_revisions
      (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,
       ledger_intent_json,revision_json,revise_action,created_at,publication_json,acting_sponsor_id,publication_event_id)
    SELECT workshop_id,3,problem_id,fellow_id,'ASIMP-SN-two',type,title,body_md,cas_hash,
      ledger_intent_json,revision_json,'archive','2026-01-04',publication_json,'usr_test','E-published'
      FROM workshop_objects WHERE workshop_id='W-history';`);
  return db;
}

function snapshot(db: Database) {
  return {
    heads: db.query("SELECT * FROM workshop_objects ORDER BY workshop_id").all(),
    history: db.query("SELECT * FROM workshop_revisions ORDER BY workshop_id,version").all(),
    guards: db
      .query(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('workshop_objects','workshop_revisions')
        AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`)
      .all()
      .map((row) => {
        const guard = row as { type: string; name: string; sql: string };
        return { ...guard, sql: guard.sql.replace(/\s+/g, " ").trim() };
      }),
  };
}

test("publication capacity migration preserves private history, guards and source foreign keys", () => {
  const db = fixture();
  try {
    const before = snapshot(db);
    const large = JSON.stringify({
      object_kind: "hypothesis",
      payload: { body_md: "\u0001".repeat(65536) },
    });
    expect(new TextEncoder().encode(large).byteLength).toBeGreaterThan(65536);
    expect(() =>
      db
        .query("UPDATE workshop_objects SET publication_json=? WHERE workshop_id='W-open'")
        .run(large),
    ).toThrow();
    db.transaction(() => db.exec(capacityMigration))();
    expect(snapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const foreignKeys = db.query("PRAGMA foreign_key_list(workshop_revisions)").all();
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({
        table: "workshop_objects",
        from: "workshop_id",
        on_delete: "CASCADE",
      }),
    );
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({ table: "sponsors", from: "acting_sponsor_id" }),
    );
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({ table: "events", from: "publication_event_id" }),
    );

    db.query("UPDATE workshop_objects SET publication_json=? WHERE workshop_id='W-open'").run(
      large,
    );
    db.query(`INSERT INTO workshop_revisions
      (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,revise_action,created_at,publication_json)
      SELECT workshop_id,2,problem_id,fellow_id,session_id,type,title,body_md,'edit','2026-01-05',publication_json
      FROM workshop_objects WHERE workshop_id='W-open'`).run();
    expect(
      db
        .query(
          "SELECT publication_json FROM workshop_revisions WHERE workshop_id='W-open' AND version=2",
        )
        .get(),
    ).toEqual({ publication_json: large });
    const exactLimit = JSON.stringify({ body: "x".repeat(PUBLICATION_BYTES - 11) });
    expect(new TextEncoder().encode(exactLimit).byteLength).toBe(PUBLICATION_BYTES);
    db.query("UPDATE workshop_objects SET publication_json=? WHERE workshop_id='W-open'").run(
      exactLimit,
    );
    const overLimit = JSON.stringify({ body: "x".repeat(PUBLICATION_BYTES - 10) });
    for (const invalid of [overLimit, "[]", "broken-json"]) {
      expect(() =>
        db
          .query("UPDATE workshop_objects SET publication_json=? WHERE workshop_id='W-open'")
          .run(invalid),
      ).toThrow();
      expect(() =>
        db
          .query(`INSERT INTO workshop_revisions
        (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,created_at,publication_json)
        SELECT workshop_id,5,problem_id,fellow_id,session_id,type,title,body_md,'2026-01-05',?
        FROM workshop_objects WHERE workshop_id='W-open'`)
          .run(invalid),
      ).toThrow();
    }
    expect(() =>
      db
        .query("UPDATE workshop_revisions SET publication_json='{}' WHERE workshop_id='W-history'")
        .run(),
    ).toThrow("WORKSHOP_REVISION_IMMUTABLE");
    expect(() =>
      db
        .query("UPDATE workshop_objects SET revision_json='{}' WHERE workshop_id='W-history'")
        .run(),
    ).toThrow("WORKSHOP_REVISION_IMMUTABLE");
    expect(() =>
      db
        .query(
          "UPDATE workshop_objects SET session_id='ASIMP-SN-two' WHERE workshop_id='W-history'",
        )
        .run(),
    ).toThrow("WORKSHOP_REVISION_IMMUTABLE");
    expect(() =>
      db
        .query("UPDATE workshop_objects SET body_md=? WHERE workshop_id='W-history'")
        .run("x".repeat(281)),
    ).toThrow("WORKSHOP_CAS_SPILL_EXTRACT_TOO_LONG");
    expect(() =>
      db
        .query(`INSERT INTO workshop_revisions
      (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,created_at)
      VALUES('W-missing',1,'P-TEST','fellow-test','ASIMP-SN-two','scratch','Missing','Body','2026-01-05')`)
        .run(),
    ).toThrow("FOREIGN KEY");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("a failed capacity migration transaction retains both original tables and all history", () => {
  const db = fixture();
  try {
    const before = snapshot(db);
    expect(() =>
      db.transaction(() => {
        db.exec(capacityMigration);
        throw new Error("synthetic-late-migration-failure");
      })(),
    ).toThrow("synthetic-late-migration-failure");
    expect(snapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '%_capacity'").all()).toEqual(
      [],
    );
  } finally {
    db.close();
  }
});
