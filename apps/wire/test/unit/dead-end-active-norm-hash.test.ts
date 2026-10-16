import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../../db/migrations/0100_dead_end_active_norm_hash.sql", import.meta.url),
  "utf8",
);

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE dead_ends (
    dead_end_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    norm_hash TEXT,
    superseded_by TEXT
  );`);
  db.exec(migration);
  return db;
}

test("one problem cannot retain two active dead ends with the same normalized route", () => {
  const db = fixture();
  try {
    db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-1", "P-1", "hash-a");
    assert.throws(
      () => db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-2", "P-1", "hash-a"),
      /UNIQUE/,
    );
  } finally {
    db.close();
  }
});

test("the same normalized route remains independent across problems", () => {
  const db = fixture();
  try {
    db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-1", "P-1", "hash-a");
    db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-2", "P-2", "hash-a");
    assert.equal(
      (db.query("SELECT COUNT(*) AS n FROM dead_ends WHERE norm_hash='hash-a'").get() as { n: number }).n,
      2,
    );
  } finally {
    db.close();
  }
});

test("retire-before-insert permits an atomic supersession of the same normalized route", () => {
  const db = fixture();
  try {
    db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-1", "P-1", "hash-a");
    db.exec("BEGIN");
    try {
      db.query("UPDATE dead_ends SET superseded_by=? WHERE problem_id=? AND dead_end_id=? AND superseded_by IS NULL")
        .run("DE-2", "P-1", "DE-1");
      db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-2", "P-1", "hash-a");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const rows = db.query("SELECT dead_end_id,superseded_by FROM dead_ends ORDER BY dead_end_id").all();
    assert.deepEqual(rows, [
      { dead_end_id: "DE-1", superseded_by: "DE-2" },
      { dead_end_id: "DE-2", superseded_by: null },
    ]);
  } finally {
    db.close();
  }
});

test("insert-before-retire is rejected, pinning statement order in the writer", () => {
  const db = fixture();
  try {
    db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-1", "P-1", "hash-a");
    assert.throws(() => {
      db.exec("BEGIN");
      try {
        db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-2", "P-1", "hash-a");
        db.query("UPDATE dead_ends SET superseded_by=? WHERE dead_end_id=?").run("DE-2", "DE-1");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }, /UNIQUE/);
    assert.deepEqual(
      db.query("SELECT dead_end_id,superseded_by FROM dead_ends").all(),
      [{ dead_end_id: "DE-1", superseded_by: null }],
    );
  } finally {
    db.close();
  }
});

test("superseded history may contain repeated normalized routes", () => {
  const db = fixture();
  try {
    db.query("INSERT INTO dead_ends VALUES(?,?,?,?)").run("DE-1", "P-1", "hash-a", "DE-2");
    db.query("INSERT INTO dead_ends VALUES(?,?,?,?)").run("DE-2", "P-1", "hash-a", "DE-3");
    db.query("INSERT INTO dead_ends VALUES(?,?,?,NULL)").run("DE-3", "P-1", "hash-a");
    assert.equal(
      (db.query("SELECT COUNT(*) AS n FROM dead_ends").get() as { n: number }).n,
      3,
    );
  } finally {
    db.close();
  }
});
