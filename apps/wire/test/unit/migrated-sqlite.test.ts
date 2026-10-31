import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migratedSqlite } from "../support/migrated-sqlite";

function fingerprint(database: Database) {
  const schema = database
    .query<{ type: string; name: string }, []>(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )
    .all();
  const tables = schema
    .filter((row) => row.type === "table")
    .map(({ name }) => ({
      name,
      rows: database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    schema: hash(schema),
    tables: hash(tables),
    tableCount: tables.length,
    foreignKeys: database.query("PRAGMA foreign_keys").get(),
    violations: database.query("PRAGMA foreign_key_check").all(),
    version: database.query("PRAGMA user_version").get(),
  };
}

function migrationDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "asimposium-unit-sqlite-image."));
  writeFileSync(
    join(directory, "0001_seed.sql"),
    "CREATE TABLE seed(value TEXT); INSERT INTO seed VALUES ('original');",
    { flag: "wx" },
  );
  return directory;
}

test("the unit image matches cold migrations, including all seed and FTS shadow tables", () => {
  const cold = new Database(":memory:", { strict: true });
  const directory = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const fresh = migratedSqlite({ strict: true });
  try {
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      cold.exec(readFileSync(join(directory, name), "utf8"));
    }
    expect(fingerprint(fresh)).toEqual(fingerprint(cold));
  } finally {
    cold.close();
    fresh.close();
  }
});

test("each fixture is an independent writable connection with foreign keys enforced", () => {
  const first = migratedSqlite({ strict: true });
  const second = migratedSqlite({ strict: true });
  try {
    first.exec(
      "CREATE TABLE image_isolation_probe(value TEXT); INSERT INTO image_isolation_probe VALUES ('first');",
    );
    expect(
      second
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name='image_isolation_probe'")
        .get(),
    ).toEqual({ n: 0 });
    second.exec(
      "CREATE TABLE image_isolation_probe(value TEXT); INSERT INTO image_isolation_probe VALUES ('second');",
    );
    expect(first.query("SELECT value FROM image_isolation_probe").all()).toEqual([
      { value: "first" },
    ]);
    second.exec(
      "CREATE TABLE image_fk_parent(id INTEGER PRIMARY KEY); CREATE TABLE image_fk_child(parent_id INTEGER REFERENCES image_fk_parent(id));",
    );
    expect(() => second.exec("INSERT INTO image_fk_child VALUES (42)")).toThrow(
      "FOREIGN KEY constraint failed",
    );
    expect(second.query("SELECT count(*) AS n FROM image_fk_child").get()).toEqual({ n: 0 });
  } finally {
    first.close();
    second.close();
  }
  const third = migratedSqlite();
  try {
    expect(
      third
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name='image_isolation_probe'")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    third.close();
  }
});

test("the new connection preserves requested strict binding and integer behavior", () => {
  const strict = migratedSqlite({ strict: true, safeIntegers: true });
  const legacy = migratedSqlite();
  try {
    expect(() => strict.query("SELECT $value AS n").get({})).toThrow();
    expect(legacy.query("SELECT $value AS n").get({})).toEqual({ n: null });
    expect(strict.query("SELECT 9007199254740993 AS n").get()).toEqual({ n: 9007199254740993n });
    expect(legacy.query("SELECT 42 AS n").get()).toEqual({ n: 42 });
  } finally {
    strict.close();
    legacy.close();
  }
});

test("changed SQL bytes and new migration names cannot reuse an earlier image", () => {
  const directory = migrationDirectory();
  const first = migratedSqlite({ migrationsDirectory: directory });
  try {
    expect(first.query("SELECT value FROM seed").all()).toEqual([{ value: "original" }]);
  } finally {
    first.close();
  }
  appendFileSync(join(directory, "0001_seed.sql"), "INSERT INTO seed VALUES ('changed');");
  const changedBytes = migratedSqlite({ migrationsDirectory: directory });
  try {
    expect(changedBytes.query("SELECT value FROM seed ORDER BY value").all()).toEqual([
      { value: "changed" },
      { value: "original" },
    ]);
  } finally {
    changedBytes.close();
  }
  writeFileSync(
    join(directory, "0002_extra.sql"),
    "CREATE TABLE added_by_new_migration(value INTEGER);",
    { flag: "wx" },
  );
  const changed = migratedSqlite({ migrationsDirectory: directory });
  try {
    expect(changed.query("SELECT value FROM seed ORDER BY value").all()).toEqual([
      { value: "changed" },
      { value: "original" },
    ]);
    expect(changed.query("SELECT count(*) AS n FROM added_by_new_migration").get()).toEqual({
      n: 0,
    });
  } finally {
    changed.close();
  }
});

test("a failed changed migration never falls back to the last valid image", () => {
  const directory = migrationDirectory();
  const valid = migratedSqlite({ migrationsDirectory: directory });
  valid.close();
  appendFileSync(join(directory, "0001_seed.sql"), "BROKEN MIGRATION;");
  expect(() => migratedSqlite({ migrationsDirectory: directory })).toThrow();
  expect(() => migratedSqlite({ migrationsDirectory: directory })).toThrow();
});
