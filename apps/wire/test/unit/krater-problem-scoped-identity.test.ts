import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Causal storage proofs for asimposiumorg-yxmo (Fable Rev 3 §6.1): public
 * claim identifiers are problem-scoped, so C-1 on one problem is distinct
 * from C-1 on another. Migration 0021 performs the cutover from the
 * accidental global identity in 0001; these tests pin its boundaries:
 * the migrated shape, retention of existing rows, refusal of contaminated
 * projections, and the atomicity of that refusal.
 */

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

const MIGRATION_FILES = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const CUTOVER = "0021_problem_scoped_claim_identity.sql";
const BEFORE_CUTOVER = MIGRATION_FILES.filter((file) => file < CUTOVER);
const FROM_CUTOVER = MIGRATION_FILES.filter((file) => file >= CUTOVER);

function openDb(): Database {
  const db = new Database(":memory:");
  // D1 enforces foreign keys; the PRAGMA inside a migration file is a no-op
  // inside the applying transaction, so the connection enables it up front.
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}

/** A database at the exact pre-cutover shape: the global-identity nucleus. */
function legacyDb(): Database {
  const db = openDb();
  for (const file of BEFORE_CUTOVER) db.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  return db;
}

/** A database at the fully migrated (current) shape. */
function migratedDb(): Database {
  const db = openDb();
  for (const file of MIGRATION_FILES) db.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  return db;
}

/** Apply one forward migration the way D1 does: alone, inside a transaction. */
function applyForward(db: Database, file: string): void {
  db.run("BEGIN IMMEDIATE;");
  try {
    db.run(readFileSync(join(MIGRATIONS, file), "utf8"));
    db.run("COMMIT;");
  } catch (error) {
    db.run("ROLLBACK;");
    throw error;
  }
}

const NOW = "2026-08-20T00:00:00Z";
const DIGEST_A = "aa".repeat(32);
const DIGEST_B = "bb".repeat(32);

function insertProblem(db: Database, id: string, digest: string): void {
  db.run(
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest) VALUES (?, 1, ?, ?, ?)",
    id,
    NOW,
    NOW,
    digest,
  );
}

function insertClaim(
  db: Database,
  problemId: string,
  id: string,
  statement: string,
  payloadSha256: string,
  sourceSeq: number,
): void {
  db.run(
    "INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    problemId,
    statement,
    payloadSha256,
    sourceSeq,
    NOW,
  );
}

function insertProjection(
  db: Database,
  claimId: string,
  problemId: string,
  sourceSeq: number,
  buildDigest: string,
): void {
  db.run(
    "INSERT INTO claim_projections (claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at) VALUES (?, ?, ?, 1, ?, 0, ?)",
    claimId,
    problemId,
    sourceSeq,
    buildDigest,
    NOW,
  );
}

interface ClaimRow {
  readonly id: string;
  readonly problem_id: string;
  readonly statement: string;
  readonly payload_sha256: string;
  readonly source_seq: number;
  readonly created_at: string;
}

interface ProjectionRow {
  readonly claim_id: string;
  readonly problem_id: string;
  readonly source_seq: number;
  readonly projection_version: number;
  readonly build_digest: string;
  readonly stale: number;
  readonly updated_at: string;
}

/** bun:sqlite returns untyped row objects; every read casts once at the boundary. */
function claimRows(db: Database): ClaimRow[] {
  return db
    .prepare(
      "SELECT id, problem_id, statement, payload_sha256, source_seq, created_at FROM claims ORDER BY problem_id, id",
    )
    .all() as ClaimRow[];
}

function projectionRows(db: Database): ProjectionRow[] {
  return db
    .prepare(
      "SELECT claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at FROM claim_projections ORDER BY problem_id, claim_id",
    )
    .all() as ProjectionRow[];
}

interface StatementRow {
  readonly statement: string;
}

interface CountRow {
  readonly count: number;
}

interface PrimaryKeyColumn {
  readonly name: string;
  readonly pk: number;
}

/** Ordered primary-key column names straight from the catalog. */
function primaryKeyColumns(db: Database, table: string): string[] {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as PrimaryKeyColumn[];
  return info
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

describe("the problem-scoped claim identity cutover (asimposiumorg-yxmo)", () => {
  test("the migrated schema keys claims by (problem_id, id)", () => {
    const db = migratedDb();
    expect(primaryKeyColumns(db, "claims")).toEqual(["problem_id", "id"]);
    expect(primaryKeyColumns(db, "claim_projections")).toEqual(["problem_id", "claim_id"]);
  });

  test("two problems each hold their own C-1 and cannot alias", () => {
    const db = migratedDb();
    insertProblem(db, "P-ALPHA", DIGEST_A);
    insertProblem(db, "P-BETA", DIGEST_B);
    insertClaim(db, "P-ALPHA", "C-1", "alpha's first claim", DIGEST_A, 1);
    insertClaim(db, "P-BETA", "C-1", "beta's first claim", DIGEST_B, 1);

    // Within one problem the identifier stays unique.
    expect(() =>
      insertClaim(db, "P-ALPHA", "C-1", "duplicate on the same problem", DIGEST_A, 2),
    ).toThrow();

    // A lookup scoped to one problem resolves only that problem's row...
    const beta = db
      .prepare("SELECT statement FROM claims WHERE id = ? AND problem_id = ?")
      .get("C-1", "P-BETA") as StatementRow | null;
    expect(beta?.statement).toBe("beta's first claim");
    // ...while the bare identifier now names two distinct identities.
    const unscoped = db
      .prepare("SELECT COUNT(*) AS count FROM claims WHERE id = ?")
      .get("C-1") as CountRow;
    expect(unscoped.count).toBe(2);

    // Each problem's board reads only its own claim (ledger-face shape).
    const alphaBoard = db
      .prepare("SELECT statement FROM claims WHERE problem_id = ? ORDER BY source_seq ASC")
      .all("P-ALPHA") as StatementRow[];
    expect(alphaBoard.map((row) => row.statement)).toEqual(["alpha's first claim"]);
  });

  test("the cutover preserves every retained row exactly and keeps them readable", () => {
    const db = legacyDb();
    insertProblem(db, "P-ALPHA", DIGEST_A);
    insertProblem(db, "P-BETA", DIGEST_B);
    insertClaim(db, "P-ALPHA", "C-1", "retained claim", DIGEST_A, 1);
    insertProjection(db, "C-1", "P-ALPHA", 1, DIGEST_B);

    const claimsBefore = claimRows(db);
    const projectionsBefore = projectionRows(db);

    // Pre-cutover, the second problem cannot mint its own C-1: the bug.
    expect(() => insertClaim(db, "P-BETA", "C-1", "collides globally", DIGEST_B, 1)).toThrow();

    for (const file of FROM_CUTOVER) applyForward(db, file);

    expect(claimRows(db)).toEqual(claimsBefore);
    expect(projectionRows(db)).toEqual(projectionsBefore);

    // Post-cutover the second problem mints C-1; the first still refuses a copy.
    insertClaim(db, "P-BETA", "C-1", "beta's own first claim", DIGEST_B, 1);
    expect(() =>
      insertClaim(db, "P-ALPHA", "C-1", "still unique per problem", DIGEST_A, 2),
    ).toThrow();
  });

  test("a projection whose source sequence is not its claim's refuses the cutover atomically", () => {
    const db = legacyDb();
    insertProblem(db, "P-ALPHA", DIGEST_A);
    insertProblem(db, "P-BETA", DIGEST_B);
    insertClaim(db, "P-ALPHA", "C-1", "clean claim", DIGEST_A, 1);
    // Representable under the old nucleus: the projection names the claim but
    // carries a source sequence the claim never had. The rebuilt triple foreign
    // key (problem_id, claim_id, source_seq) must refuse exactly this row.
    insertProjection(db, "C-1", "P-ALPHA", 2, DIGEST_B);

    const claimsBefore = claimRows(db);
    const projectionsBefore = projectionRows(db);
    expect(() => applyForward(db, CUTOVER)).toThrow();

    // Rollback restores the old world bit-for-bit, global identity included:
    // the second problem still cannot mint C-1 against the rolled-back schema.
    expect(claimRows(db)).toEqual(claimsBefore);
    expect(projectionRows(db)).toEqual(projectionsBefore);
    expect(() =>
      insertClaim(db, "P-BETA", "C-1", "global identity persists", DIGEST_B, 1),
    ).toThrow();

    // Repairing the contamination lets the same migration succeed.
    db.run("DELETE FROM claim_projections WHERE claim_id = 'C-1' AND problem_id = 'P-ALPHA'");
    applyForward(db, CUTOVER);
    insertClaim(db, "P-BETA", "C-1", "beta's own first claim", DIGEST_B, 1);
  });
});
