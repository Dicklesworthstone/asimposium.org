import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * W2.1 schema census: the D1 schema after every migration must carry the
 * launch-scoped object inventory with the append-only envelope enforced by
 * DDL, workshop cursors scoped per (fellow, problem), and FTS over public
 * claims only. This is the mechanical census the bead requires — a drift in
 * any of these is a schema regression, not a convention lapse.
 */

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const MIGRATIONS_README = join(MIGRATIONS, "README.md");

function freshMigratedDb(): Database {
  const sqlite = new Database(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return sqlite;
}

function names(db: Database, type: "table" | "trigger" | "index"): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all(type) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** The launch-scoped object inventory the bead's census names as present. */
const CENSUS_TABLES = [
  "events",
  "event_content",
  "outbox",
  "idempotency",
  "public_cursor",
  "problems",
  "problem_memberships",
  "claims",
  "sessions",
  "session_write_replays",
  "fellow_tokens",
  "enrollment_fellows",
  "enrollment_proposals",
  "enrollment_records",
  "enrollment_grants",
  "enrollment_credentials",
  "public_claim_fts",
] as const;

/** Append-only / immutability triggers the census requires. */
const CENSUS_TRIGGERS = [
  "events_immutable_before_update",
  "events_immutable_before_delete",
  "events_chain_head_before_insert",
  "event_content_lawful_redaction_only",
  // The W3.7 per-Fellow credential cap and the three guards that make its
  // capacity release one-way. 0011 already rebuilt fellow_tokens once; if a
  // future rebuild drops any of these, the cap silently stops existing and a
  // fourth credential mints without a word.
  "enrollment_credentials_active_cap",
  "enrollment_credentials_revocation_monotonic",
  "enrollment_credentials_authority_immutable",
  "enrollment_credentials_no_delete",
] as const;

describe("W2.1 schema census", () => {
  test("every census table exists after all migrations", () => {
    const db = freshMigratedDb();
    const tables = names(db, "table");
    for (const table of CENSUS_TABLES) {
      expect(tables, `missing census table ${table}`).toContain(table);
    }
    db.close();
  });

  test("append-only envelope triggers exist", () => {
    const db = freshMigratedDb();
    const triggers = names(db, "trigger");
    for (const trigger of CENSUS_TRIGGERS) {
      expect(triggers, `missing append-only trigger ${trigger}`).toContain(trigger);
    }
    db.close();
  });

  test("the append-only triggers abort UPDATE and DELETE on event envelopes", () => {
    const db = freshMigratedDb();
    const defs = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'`)
      .all() as Array<{ name: string; sql: string }>;
    const update = defs.find((d) => d.name === "events_immutable_before_update");
    const del = defs.find((d) => d.name === "events_immutable_before_delete");
    // The envelope's append-only guarantee is enforced in DDL, not convention:
    // both triggers must exist and abort.
    expect(update?.sql).toContain("RAISE(ABORT");
    expect(del?.sql).toContain("RAISE(ABORT");
    // Lawful redaction is the ONLY sanctioned mutation path, and it touches
    // event_content — never the envelope.
    const redaction = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'event_content_lawful_redaction_only'`,
      )
      .get() as { sql: string } | null;
    expect(redaction?.sql).toContain("RAISE(ABORT");
    db.close();
  });

  test("workshop cursors are per-(fellow, problem), never one global counter", () => {
    const db = freshMigratedDb();
    const columns = db.prepare(`PRAGMA table_info(workshop_objects)`).all() as Array<{
      name: string;
    }>;
    const names_ = columns.map((c) => c.name);
    expect(names_).toContain("fellow_id");
    expect(names_).toContain("problem_id");
    expect(names_).toContain("workshop_seq");
    db.close();
  });

  test("FTS covers public claims only — no workshop FTS table exists", () => {
    const db = freshMigratedDb();
    const tables = names(db, "table");
    expect(tables).toContain("public_claim_fts");
    const workshopFts = tables.filter(
      (t) => t.includes("fts") && (t.includes("workshop") || t.includes("private")),
    );
    expect(workshopFts).toEqual([]);
    db.close();
  });

  test("migrations are numbered and apply in order on a fresh database", () => {
    const files = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    // Numbered, no gaps in the applied prefix.
    for (const [index, file] of files.entries()) {
      const expected = String(index + 1).padStart(4, "0");
      expect(file.startsWith(expected), `migration ${file} breaks the numbering`).toBe(true);
    }
    // freshMigratedDb succeeding at all proves ordered application on fresh D1.
    const db = freshMigratedDb();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get()).not.toBeNull();
    db.close();
  });

  test("the migration boundary document names the actual checked-in head", () => {
    const files = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const head = files.at(-1);
    expect(head).toBeDefined();
    if (head === undefined) throw new Error("the migration directory has no numbered SQL");
    expect(readFileSync(MIGRATIONS_README, "utf8")).toContain(`through \`${head}\``);
  });

  test("the census names the load-bearing indexes, not just the tables", () => {
    const db = freshMigratedDb();
    const indexes = names(db, "index");
    // The census tables' query paths are index-backed; a dropped index is a
    // latent scan regression, so the census names the ones the routes depend on.
    const required = [
      "enrollment_credentials_token_idx",
      "enrollment_proposals_status_idx",
      "enrollment_fellows_sponsor_status_idx",
    ];
    for (const index of required) {
      expect(indexes, `missing census index ${index}`).toContain(index);
    }
    // Every index serves exactly one census-known table (no orphan indexes).
    const rows = db
      .prepare(
        `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string; tbl_name: string }>;
    const tables = new Set(names(db, "table"));
    for (const row of rows) {
      expect(tables.has(row.tbl_name), `index ${row.name} on unknown table ${row.tbl_name}`).toBe(
        true,
      );
    }
    db.close();
  });
});
