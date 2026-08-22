import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

/**
 * Split a migration file into complete statements. A bare ";" split is wrong
 * for this corpus: trigger bodies contain semicolons, including nested
 * `CASE ... END;` inside `BEGIN ... END;` and single-line triggers. This is
 * the sqlite3_complete() rule specialized to these files: quoted strings and
 * comments never terminate; elsewhere a ";" ends a statement unless an open
 * CREATE TRIGGER body has not reached its closing END (CASE nests inside the
 * body and consumes its own ENDs).
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let token = "";
  let priorToken = "";
  let caseDepth = 0;
  let inTrigger = false;
  let triggerBodyClosed = false;
  let index = 0;

  const finishToken = (): void => {
    if (token.length === 0) return;
    const upper = token.toUpperCase();
    if (priorToken === "CREATE" && upper === "TRIGGER") inTrigger = true;
    else if (upper === "CASE") caseDepth += 1;
    else if (upper === "END" && inTrigger) {
      if (caseDepth > 0) caseDepth -= 1;
      else triggerBodyClosed = true;
    }
    priorToken = upper;
    token = "";
  };

  while (index < sql.length) {
    const ch = sql[index] as string;
    if (/[A-Za-z0-9_]/.test(ch)) {
      token += ch;
      statement += ch;
      index += 1;
      continue;
    }
    finishToken();
    if (ch === "'" || ch === '"') {
      const quote = ch;
      statement += ch;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index] as string;
        statement += inner;
        if (inner === quote) {
          if (sql[index + 1] === quote) {
            statement += sql[index + 1] as string;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (ch === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (ch === ";" && (!inTrigger || triggerBodyClosed)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      statement = "";
      inTrigger = false;
      triggerBodyClosed = false;
      caseDepth = 0;
      priorToken = "";
      index += 1;
      continue;
    }
    statement += ch;
    index += 1;
  }
  finishToken();
  const rest = statement.trim();
  if (rest.length > 0) statements.push(rest);
  return statements;
}

/**
 * Apply one migration file statement by statement. D1 prepares and steps each
 * statement and aborts the applying transaction on the first refusal; the seam
 * below matches that. bun:sqlite's bulk db.run(file) must never be used here:
 * it silently skips a statement that fails mid-file (observed with an
 * FK-violating INSERT..SELECT during 0021), which would hide exactly the
 * contamination refusal this cutover promises.
 */
function applyMigrationStatements(db: Database, file: string): void {
  for (const statement of splitSqlStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) {
    db.run(statement);
  }
}

let savepointSeq = 0;

/** Apply one forward migration atomically, composable inside an outer transaction. */
function applyAtomically(db: Database, file: string): void {
  savepointSeq += 1;
  const savepoint = `yxmo_${savepointSeq}`;
  db.run(`SAVEPOINT ${savepoint};`);
  try {
    applyMigrationStatements(db, file);
    db.run(`RELEASE ${savepoint};`);
  } catch (error) {
    db.run(`ROLLBACK TO ${savepoint};`);
    db.run(`RELEASE ${savepoint};`);
    throw error;
  }
}

const NOW = "2026-08-20T00:00:00Z";
const DIGEST_A = "aa".repeat(32);
const DIGEST_B = "bb".repeat(32);

function insertProblem(db: Database, id: string, digest: string): void {
  db.run(
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest) VALUES (?, 1, ?, ?, ?)",
    [id, NOW, NOW, digest],
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
    [id, problemId, statement, payloadSha256, sourceSeq, NOW],
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
    [claimId, problemId, sourceSeq, buildDigest, NOW],
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

// The full 28-migration schema costs seconds to build, so both worlds are
// constructed once and every test runs inside a savepoint that is rolled back
// afterwards. SQLite DDL is transactional, which makes even the 0021 cutover
// itself cleanly reversible between tests.
let legacyWorld: Database;
let currentWorld: Database;

beforeAll(() => {
  legacyWorld = openDb();
  for (const file of BEFORE_CUTOVER) applyMigrationStatements(legacyWorld, file);
  currentWorld = openDb();
  for (const file of MIGRATION_FILES) applyMigrationStatements(currentWorld, file);
}, 120_000);

afterAll(() => {
  legacyWorld.close();
  currentWorld.close();
});

beforeEach(() => {
  legacyWorld.run("SAVEPOINT test_case;");
  currentWorld.run("SAVEPOINT test_case;");
});

afterEach(() => {
  for (const world of [legacyWorld, currentWorld]) {
    world.run("ROLLBACK TO test_case;");
    world.run("RELEASE test_case;");
  }
});

describe("the problem-scoped claim identity cutover (asimposiumorg-yxmo)", () => {
  test("the migrated schema keys claims by (problem_id, id)", () => {
    expect(primaryKeyColumns(currentWorld, "claims")).toEqual(["problem_id", "id"]);
    expect(primaryKeyColumns(currentWorld, "claim_projections")).toEqual([
      "problem_id",
      "claim_id",
    ]);
  });

  test("two problems each hold their own C-1 and cannot alias", () => {
    insertProblem(currentWorld, "P-ALPHA", DIGEST_A);
    insertProblem(currentWorld, "P-BETA", DIGEST_B);
    insertClaim(currentWorld, "P-ALPHA", "C-1", "alpha's first claim", DIGEST_A, 1);
    insertClaim(currentWorld, "P-BETA", "C-1", "beta's first claim", DIGEST_B, 1);

    // Within one problem the identifier stays unique.
    expect(() =>
      insertClaim(currentWorld, "P-ALPHA", "C-1", "duplicate on the same problem", DIGEST_A, 2),
    ).toThrow();

    // A lookup scoped to one problem resolves only that problem's row...
    const beta = currentWorld
      .prepare("SELECT statement FROM claims WHERE id = ? AND problem_id = ?")
      .get("C-1", "P-BETA") as StatementRow | null;
    expect(beta?.statement).toBe("beta's first claim");
    // ...while the bare identifier now names two distinct identities.
    const unscoped = currentWorld
      .prepare("SELECT COUNT(*) AS count FROM claims WHERE id = ?")
      .get("C-1") as CountRow;
    expect(unscoped.count).toBe(2);

    // Each problem's board reads only its own claim (ledger-face shape).
    const alphaBoard = currentWorld
      .prepare("SELECT statement FROM claims WHERE problem_id = ? ORDER BY source_seq ASC")
      .all("P-ALPHA") as StatementRow[];
    expect(alphaBoard.map((row) => row.statement)).toEqual(["alpha's first claim"]);
  });

  test("the cutover preserves every retained row exactly and keeps them readable", () => {
    insertProblem(legacyWorld, "P-ALPHA", DIGEST_A);
    insertProblem(legacyWorld, "P-BETA", DIGEST_B);
    insertClaim(legacyWorld, "P-ALPHA", "C-1", "retained claim", DIGEST_A, 1);
    insertProjection(legacyWorld, "C-1", "P-ALPHA", 1, DIGEST_B);

    const claimsBefore = claimRows(legacyWorld);
    const projectionsBefore = projectionRows(legacyWorld);

    // Pre-cutover, the second problem cannot mint its own C-1: the bug.
    expect(() =>
      insertClaim(legacyWorld, "P-BETA", "C-1", "collides globally", DIGEST_B, 1),
    ).toThrow();

    for (const file of FROM_CUTOVER) applyAtomically(legacyWorld, file);

    expect(claimRows(legacyWorld)).toEqual(claimsBefore);
    expect(projectionRows(legacyWorld)).toEqual(projectionsBefore);

    // Post-cutover the second problem mints C-1; the first still refuses a copy.
    insertClaim(legacyWorld, "P-BETA", "C-1", "beta's own first claim", DIGEST_B, 1);
    expect(() =>
      insertClaim(legacyWorld, "P-ALPHA", "C-1", "still unique per problem", DIGEST_A, 2),
    ).toThrow();
  });

  test("a projection whose source sequence is not its claim's refuses the cutover atomically", () => {
    insertProblem(legacyWorld, "P-ALPHA", DIGEST_A);
    insertProblem(legacyWorld, "P-BETA", DIGEST_B);
    insertClaim(legacyWorld, "P-ALPHA", "C-1", "clean claim", DIGEST_A, 1);
    // Representable under the old nucleus: the projection names the claim but
    // carries a source sequence the claim never had. The rebuilt triple foreign
    // key (problem_id, claim_id, source_seq) must refuse exactly this row.
    insertProjection(legacyWorld, "C-1", "P-ALPHA", 2, DIGEST_B);

    const claimsBefore = claimRows(legacyWorld);
    const projectionsBefore = projectionRows(legacyWorld);
    expect(() => applyAtomically(legacyWorld, CUTOVER)).toThrow();

    // Refusal restores the old world bit-for-bit, global identity included:
    // the second problem still cannot mint C-1 against the retained schema.
    expect(claimRows(legacyWorld)).toEqual(claimsBefore);
    expect(projectionRows(legacyWorld)).toEqual(projectionsBefore);
    expect(() =>
      insertClaim(legacyWorld, "P-BETA", "C-1", "global identity persists", DIGEST_B, 1),
    ).toThrow();

    // Repairing the contamination lets the same migration succeed.
    legacyWorld.run(
      "DELETE FROM claim_projections WHERE claim_id = 'C-1' AND problem_id = 'P-ALPHA'",
    );
    applyAtomically(legacyWorld, CUTOVER);
    insertClaim(legacyWorld, "P-BETA", "C-1", "beta's own first claim", DIGEST_B, 1);
  });
  // asimposiumorg-s5mx: the two application seams must disagree on exactly
  // this scenario, so the footgun stays documented by an executable proof
  // instead of a comment.
  test("bun:sqlite bulk exec silently skips a refused mid-file statement and disarms the seam", () => {
    insertProblem(legacyWorld, "P-ALPHA", DIGEST_A);
    insertClaim(legacyWorld, "P-ALPHA", "C-1", "doomed rebuild source", DIGEST_A, 1);
    insertProjection(legacyWorld, "C-1", "P-ALPHA", 2, DIGEST_B);

    // The bulk seam: bun:sqlite executes the whole file and swallows the
    // mid-file refusal. Statements after it still apply, so the database is
    // left half-migrated and committed - the data-loss footgun itself.
    expect(() => legacyWorld.exec(readFileSync(join(MIGRATIONS, CUTOVER), "utf8"))).not.toThrow();
    expect(primaryKeyColumns(legacyWorld, "claims")).toEqual(["problem_id", "id"]);
    expect(projectionRows(legacyWorld)).toEqual([]);

    // Sharper still: the bulk seam already dropped the offending row, so the
    // statement-wise seam now sees no contamination at all - the refusal that
    // protects this cutover has been silently disarmed.
    expect(() => applyAtomically(legacyWorld, CUTOVER)).not.toThrow();
  });
});
