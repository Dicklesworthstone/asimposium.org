import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { REDACTED_TOKEN, redactCredentials } from "@asimposium/contracts/diagnostic-safety";
import {
  assertRepositoryContained,
  EnvironmentValidationError,
  maskAbsolutePaths,
  redactDiagnostic,
  selectEnvironment,
  validateEnvironments,
} from "./validate-environments.mjs";

/**
 * D1 migration planner and runner (bead asimposiumorg-p1g, OPS.3).
 *
 * `db/migrations/` is owned by W2/S-2 and is read-only here: this file decides
 * how migrations are *applied*, never what they contain.
 *
 * The planner is a pure function over (files on disk, records already applied).
 * That is deliberate: every ordering, checksum, and idempotency rule below is
 * unit-testable without a database, and the only part that needs a real D1 is
 * reading the applied-record table and executing the SQL. Where that is
 * unavailable the runner refuses and says so; it never simulates a result.
 *
 * Forward-only. There are no down-migrations. A mistake is corrected by writing
 * the next numbered migration, because a rollback that runs against a schema
 * other than the one it was written for is how a data-loss incident starts.
 */

export class MigrationError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.name = "MigrationError";
    if (cause !== undefined) {
      // `causalOutput`, not `causalStderr`: Wrangler invoked with `--json`
      // writes its failure to *stdout* and leaves stderr empty, so pinning the
      // field to one stream would have reported an empty cause for every real
      // failure. `causalStream` records which stream actually carried it.
      this.causalOutput = cause.output;
      this.causalStream = cause.stream;
    }
  }
}

/**
 * Every refusal this module raises goes through here, so redacting once at the
 * throw site covers every structured diagnostic. `--env <value>` and
 * `--config <path>` are caller-controlled and reach a message, so a caller who
 * passes a credential — or an absolute path — as either would otherwise have it
 * printed back by the tool that refuses it. Both passes apply, so a `--config
 * /Users/<name>/…` refusal keeps its home directory out of the log even though
 * a path is not a credential family.
 */
function fail(code, message, cause) {
  throw new MigrationError(code, redactDiagnostic(message), cause);
}

/** Digest recorded in the ledger: sha256 hex, nothing else. */
export const DIGEST = /^[0-9a-f]{64}$/;

const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const WIRE_PACKAGE_MANIFEST = "apps/wire/package.json";
const INSTALLED_WRANGLER_MANIFEST = "apps/wire/node_modules/wrangler/package.json";
const INSTALLED_WRANGLER_ENTRY = "apps/wire/node_modules/wrangler/bin/wrangler.js";

const MAX_CAUSAL_STDERR = 600;
export const LOCAL_D1_COMMAND_TIMEOUT_MS = 15_000;
export const LOCAL_D1_TERM_GRACE_MS = 500;
export const LOCAL_D1_KILL_REAP_MS = 500;
export const LOCAL_D1_PIPE_DRAIN_MS = 500;
export const LOCAL_D1_STDOUT_MAX_BYTES = 1_048_576;
export const LOCAL_D1_STDERR_MAX_BYTES = 65_536;

function minimalLocalToolEnvironment() {
  // The command and pinned Wrangler entry are absolute, so neither a Cloudflare
  // credential nor a caller-selected PATH needs to cross this local-only
  // boundary. Keep only the platform basics that Bun and child diagnostics
  // need. In particular, do not inherit CLOUDFLARE_*, WRANGLER_*, or any S2
  // authority from the parent process.
  if (process.platform === "win32") {
    return {
      LANG: "C",
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TZ: "UTC",
    };
  }
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TZ: "UTC",
  };
}

/**
 * Turn a tool's stderr into something safe to put in a diagnostic.
 *
 * Suppressing it entirely loses the cause; forwarding it raw can carry absolute
 * paths and, if a tool ever echoes its environment, secret bytes.
 *
 * The known credential families — agent tokens, join-URL fragments, Bearer and
 * Basic headers, third-party key shapes, PEM private keys, labelled fields such
 * as `password:` and `cookie:`, and their clipped tails — are **not** restated
 * here. They come from `@asimposium/contracts/diagnostic-safety`, which is the
 * one place that list is maintained; a second copy in this file would drift
 * behind it silently and every consumer would believe it was covered.
 *
 * What stays is what is specific to running a migration tool, and none of it is
 * a credential family:
 *
 *  - `NAME=value`, because a child that echoes its environment prints
 *    assignments this scanner has no shape rule for;
 *  - absolute paths, which disclose the operator's filesystem rather than a
 *    secret — applied here but *defined* alongside the topology validator, so
 *    the two runners cannot drift to different notions of a masked path;
 *  - long hex runs, which are how a digest, an id, or a raw key appears here;
 *  - whitespace collapse and a length bound, so one diagnostic stays paste-able.
 */
export function redactStderr(text) {
  if (typeof text !== "string" || text.trim() === "") return "";
  let safe = maskAbsolutePaths(
    redactCredentials(text)
      // The name is captured and echoed so an operator knows *which* variable
      // was withheld. Without the named group `$<name>` is emitted literally,
      // which is what this line used to do — the value was safe but the label
      // was lost.
      //
      // The value class is escape-aware and tries the quoted forms first. A
      // bare `\S+` stops at the first space, so `TOKEN="abc def"` printed
      // ` def"` — the tail of the very value it claimed to withhold — and
      // `"…(?:\\.|[^"\\])*"` is needed rather than `"[^"]*"` because a value
      // containing `\"` would otherwise close the match early and leak the
      // remainder the same way.
      .replace(
        /\b(?<name>[A-Z][A-Z0-9_]{2,})=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g,
        `$<name>=${REDACTED_TOKEN}`,
      ),
  )
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<redacted-hex>")
    .replace(/\s+/g, " ")
    .trim();
  if (safe.length > MAX_CAUSAL_STDERR) safe = `${safe.slice(0, MAX_CAUSAL_STDERR)}…`;
  return safe;
}

/** The fixed name shape declared by db/migrations/README.md. */
export const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * Split SQL into executable code and its comments.
 *
 * Regexes over raw SQL are not good enough for a safety guard, and the previous
 * whole-file patterns here were bypassable three ways: a comment inside a
 * keyword (`DROP/comment/TABLE`) hid the statement; a `WHERE` belonging to a
 * *later* statement satisfied the "has a WHERE" lookahead for an unscoped
 * `UPDATE`; and a keyword inside a string literal could trip a false positive.
 *
 * So: scan once, replace every comment and every string literal with a space,
 * and keep the comment bodies separately. Detection then runs on code that no
 * longer contains anything a reviewer cannot see, and the opt-in marker is read
 * only from real comments — never from inside a string.
 */
export function scanSql(sql) {
  let code = "";
  const comments = [];
  let index = 0;

  while (index < sql.length) {
    const two = sql.slice(index, index + 2);

    if (two === "--") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      comments.push(sql.slice(index + 2, stop));
      code += " ";
      index = stop;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        fail("UNTERMINATED_SQL_COMMENT", "A migration contains an unterminated block comment.");
      }
      const stop = end + 2;
      comments.push(sql.slice(index + 2, end === -1 ? sql.length : end));
      code += " ";
      index = stop;
      continue;
    }
    const character = sql[index];
    if (character === "[") {
      const end = sql.indexOf("]", index + 1);
      if (end === -1) {
        fail(
          "UNTERMINATED_SQL_QUOTE",
          "A migration contains an unterminated quoted literal or identifier.",
        );
      }
      code += " '' ";
      index = end + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      // Consume the literal, honouring doubled-quote escaping.
      let cursor = index + 1;
      let closed = false;
      while (cursor < sql.length) {
        if (sql[cursor] === character) {
          if (sql[cursor + 1] === character) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        fail(
          "UNTERMINATED_SQL_QUOTE",
          "A migration contains an unterminated quoted literal or identifier.",
        );
      }
      code += " '' ";
      index = cursor;
      continue;
    }
    code += character;
    index += 1;
  }

  return { code, comments };
}

/** Split scanned code into statements. Literals are already neutralised. */
export function splitStatements(code) {
  return code
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement !== "");
}

/**
 * Statements that can destroy or silently rewrite committed history.
 *
 * Each predicate sees ONE statement, so a `WHERE` in a neighbouring statement
 * can never vouch for this one.
 */
const DESTRUCTIVE_RULES = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+DATABASE\b/i, "DROP DATABASE"],
  [/\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b/i, "DROP VIEW"],
  [/\bDROP\s+INDEX\b/i, "DROP INDEX"],
  [/\bDROP\s+TRIGGER\b/i, "DROP TRIGGER"],
  [/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i, "ALTER TABLE RENAME"],
  [/\bTRUNCATE\b/i, "TRUNCATE"],
  [/\bVACUUM\b/i, "VACUUM"],
  [/\b(?:ATTACH|DETACH)\b/i, "ATTACH/DETACH DATABASE"],
  [/\bPRAGMA\s+writable_schema\b/i, "PRAGMA writable_schema"],
  [/\bREPLACE\s+INTO\b/i, "REPLACE INTO"],
  [/\bINSERT\s+OR\s+REPLACE\b/i, "INSERT OR REPLACE"],
  [/\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i, "DELETE without WHERE"],
  [/\bUPDATE\b[\s\S]*\bSET\b(?![\s\S]*\bWHERE\b)/i, "UPDATE without WHERE"],
];

/** An explicit, reviewable opt-in that must appear as a real comment. */
const DESTRUCTIVE_ACKNOWLEDGEMENT = /^\s*asimposium:allow-destructive\b/;

/** True when the migration carries the opt-in marker in an actual comment. */
export function declaresDestructive(sql) {
  return scanSql(sql).comments.some((comment) => DESTRUCTIVE_ACKNOWLEDGEMENT.test(comment));
}

export function digestOf(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function readMigrationDirectory(directory) {
  if (!existsSync(directory)) {
    fail("MISSING_MIGRATIONS_DIRECTORY", "The migrations directory does not exist.");
  }
  // lstat, not stat: a symlinked migrations directory could point anywhere, and
  // stat() would happily follow it out of the repository.
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink()) {
    fail("SYMLINKED_MIGRATIONS_DIRECTORY", "The migrations directory must not be a symlink.");
  }
  if (!directoryStat.isDirectory()) {
    fail("MISSING_MIGRATIONS_DIRECTORY", "The migrations path is not a directory.");
  }
  const migrations = [];
  const seen = new Map();

  for (const entry of readdirSync(directory).sort()) {
    const entryStat = lstatSync(join(directory, entry));
    // A symlinked migration is a file whose contents the digest cannot pin: the
    // link can be repointed after review without changing anything in the repo.
    if (entryStat.isSymbolicLink()) {
      fail(
        "SYMLINKED_MIGRATION_FILE",
        `"${entry}" is a symlink; migrations must be regular files.`,
      );
    }
    if (!entryStat.isFile()) {
      fail("NON_REGULAR_MIGRATION_FILE", `"${entry}" is not a regular file.`);
    }
    if (entry.endsWith(".md")) continue;
    if (!entry.endsWith(".sql")) {
      fail(
        "UNEXPECTED_MIGRATION_FILE",
        `"${entry}" is neither a .sql migration nor documentation.`,
      );
    }
    // Forward-only is enforced at the filename, before anyone can run one.
    if (/\.(down|rollback|undo)\.sql$/.test(entry) || /^\d+_down_/.test(entry)) {
      fail(
        "DOWN_MIGRATION_REJECTED",
        `"${entry}" looks like a down-migration; the rollback policy is forward-only. Write the next numbered migration instead.`,
      );
    }
    const match = MIGRATION_FILENAME.exec(entry);
    if (match === null) {
      fail("MALFORMED_MIGRATION_NAME", `"${entry}" must be named NNNN_short_purpose.sql.`);
    }
    const sequence = Number(match[1]);
    const held = seen.get(sequence);
    if (held !== undefined) {
      fail(
        "DUPLICATE_MIGRATION_SEQUENCE",
        `Migrations "${held}" and "${entry}" share sequence ${match[1]}.`,
      );
    }
    seen.set(sequence, entry);

    const sql = readFileSync(join(directory, entry), "utf8");
    if (sql.trim() === "") {
      fail("EMPTY_MIGRATION", `"${entry}" is empty.`);
    }
    // Reject lexical incompleteness while loading the file, before either a
    // plan or an apply path can open local D1. In particular, appending the
    // runner's journal INSERT after an open comment must never be executable.
    scanSql(sql);
    migrations.push({ id: entry, sequence, name: match[2], sql, digest: digestOf(sql) });
  }

  migrations.sort((a, b) => a.sequence - b.sequence);
  return migrations;
}

export function describeDestructiveStatements(sql) {
  const found = new Set();
  for (const statement of splitStatements(scanSql(sql).code)) {
    for (const [pattern, label] of DESTRUCTIVE_RULES) {
      if (pattern.test(statement)) found.add(label);
    }
  }
  return [...found];
}

/**
 * Decide what to apply.
 *
 * @param migrations  from readMigrationDirectory, ascending
 * @param applied     records already in the target database:
 *                    [{ id, sequence, digest }]
 * @param options     { environmentName, destructiveAllowed }
 */
export function planMigrations(migrations, applied, options) {
  const { environmentName, destructiveAllowed, baseline } = options;
  const baselineHead = baseline?.head ?? 0;
  const appliedById = new Map(applied.map((record) => [record.id, record]));
  const highestApplied = applied.reduce(
    (max, record) => Math.max(max, record.sequence),
    baselineHead,
  );

  for (const record of applied) {
    if (!migrations.some((migration) => migration.id === record.id)) {
      fail(
        "APPLIED_MIGRATION_MISSING",
        `Migration "${record.id}" is recorded as applied to ${environmentName} but is no longer in the directory; the history has been rewritten.`,
      );
    }
  }

  const toApply = [];
  const skipped = [];

  for (const migration of migrations) {
    if (migration.sequence <= baselineHead) {
      skipped.push({ id: migration.id, reason: "bootstrap_baseline" });
      continue;
    }
    const record = appliedById.get(migration.id);
    if (record !== undefined) {
      // Drift: the file changed after it ran, so the database and the
      // repository no longer describe the same schema.
      if (record.digest !== migration.digest) {
        // The remedy differs by target, and saying which is the difference
        // between a five-second fix and a panic. It is never "update the
        // recorded digest": that would assert the new SQL ran when it did not.
        const remedy =
          environmentName === "local"
            ? "Recreate the disposable local database so the migration re-runs from scratch."
            : "Do not edit an applied migration; write the next numbered migration instead, and treat the difference as an incident.";
        fail(
          "MIGRATION_DRIFT",
          `Migration "${migration.id}" changed after it was applied to ${environmentName}; its recorded digest no longer matches the file. ${remedy}`,
        );
      }
      skipped.push({ id: migration.id, reason: "already_applied" });
      continue;
    }
    // Out-of-order: a lower-numbered migration appearing after a higher one has
    // already run would execute against a schema its author never saw.
    if (migration.sequence < highestApplied) {
      fail(
        "OUT_OF_ORDER_MIGRATION",
        `Migration "${migration.id}" is unapplied but sorts below sequence ${highestApplied} already applied to ${environmentName}; renumber it above the applied head.`,
      );
    }
    const destructive = describeDestructiveStatements(migration.sql);
    if (destructive.length > 0) {
      if (!declaresDestructive(migration.sql)) {
        fail(
          "UNDECLARED_DESTRUCTIVE_MIGRATION",
          `Migration "${migration.id}" contains ${destructive.join(", ")} without an "-- asimposium:allow-destructive" marker.`,
        );
      }
      if (!destructiveAllowed) {
        fail(
          "DESTRUCTIVE_TARGET_REFUSED",
          `Migration "${migration.id}" contains ${destructive.join(", ")}, which ${environmentName} does not permit.`,
        );
      }
    }
    toApply.push({
      id: migration.id,
      sequence: migration.sequence,
      digest: migration.digest,
      destructive: destructive.length > 0,
    });
  }

  return {
    environment: environmentName,
    head: highestApplied,
    to_apply: toApply,
    skipped,
    // Idempotence is observable, not asserted: a second plan over the same
    // inputs plus the records this one would write has an empty to_apply.
    idempotent: toApply.length === 0,
  };
}

/**
 * The runner's own bookkeeping table.
 *
 * It is created by the runner rather than by a numbered migration, because
 * `db/migrations/` belongs to W2/S-2 and because the ledger must exist before
 * the first migration it records. It holds no product data.
 */
export const LEDGER_TABLE = "_asimposium_migrations";
export const LINEAGE_TABLE = "_asimposium_schema_lineage";
export const BOOTSTRAP_MANIFEST_PATH = "db/bootstrap/manifest.json";
export const MAX_CATALOG_ROWS = 512;
export const MAX_JOURNAL_ROWS = 256;
export const MAX_LINEAGE_ROWS = 8;

const BOOTSTRAP_LINEAGE = "bootstrap-baseline15";
const LEGACY_HEAD = 9;
// `sqlite_schema.sql` records the CREATE statement without its trailing
// semicolon and removes `IF NOT EXISTS`. Keep the stored forms explicit: the
// classifier must distinguish runner-owned metadata from a product table that
// only borrows a runner control name.
const LEDGER_CATALOG_SQL = `CREATE TABLE ${LEDGER_TABLE} (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  digest TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;
const BOOTSTRAP_LEDGER_DDL = `${LEDGER_CATALOG_SQL};`;
const LINEAGE_CATALOG_SQL = `CREATE TABLE ${LINEAGE_TABLE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lineage TEXT NOT NULL CHECK (lineage = '${BOOTSTRAP_LINEAGE}'),
  artifact_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  schema_digest TEXT NOT NULL CHECK (length(schema_digest) = 64),
  empty_guard INTEGER NOT NULL CHECK (empty_guard = 1),
  installed_at TEXT NOT NULL
)`;
const BOOTSTRAP_LINEAGE_DDL = `${LINEAGE_CATALOG_SQL};`;
const WRANGLER_LOCAL_METADATA_SQL = `CREATE TABLE _cf_METADATA (
        key INTEGER PRIMARY KEY,
        value BLOB
      )`;

function isSqliteInternalCatalogObject(entry) {
  return entry.name.startsWith("sqlite_");
}

// `_cf_METADATA` is created by the Wrangler/Miniflare D1 runtime, not by any
// ASImposium migration. It is platform control only in this exact catalog
// shape. A product object that merely borrows its name remains visible and
// contaminates the target rather than being silently ignored.
function isExactWranglerLocalMetadata(entry) {
  return (
    entry.type === "table" &&
    entry.name === "_cf_METADATA" &&
    entry.table === "_cf_METADATA" &&
    entry.sql === WRANGLER_LOCAL_METADATA_SQL
  );
}

function isExactRunnerControl(entry, name, sql) {
  return entry.type === "table" && entry.name === name && entry.table === name && entry.sql === sql;
}

function isExactLedgerControl(entry) {
  return isExactRunnerControl(entry, LEDGER_TABLE, LEDGER_CATALOG_SQL);
}

function isExactLineageControl(entry) {
  return isExactRunnerControl(entry, LINEAGE_TABLE, LINEAGE_CATALOG_SQL);
}

function isCatalogFingerprintControl(entry) {
  return (
    isSqliteInternalCatalogObject(entry) ||
    isExactLedgerControl(entry) ||
    isExactLineageControl(entry) ||
    isExactWranglerLocalMetadata(entry)
  );
}

function isEmptyTargetControl(entry) {
  return isSqliteInternalCatalogObject(entry) || isExactWranglerLocalMetadata(entry);
}

/**
 * A product-schema catalog is the only safe bootstrap authority. Migration
 * journal rows are a claim about the past, not proof that the target is empty
 * or has the expected DDL. The digest deliberately excludes runner metadata:
 * historical-current and bootstrap-baseline15 carry different bookkeeping but
 * must expose the same product semantics to a later 0016 migration. The
 * manifest pins the raw sqlite_schema fingerprint at every admitted head, so
 * a bootstrap's exact forward journal suffix cannot vouch for contaminated
 * DDL by itself.
 */
export function catalogFingerprint(catalog) {
  const canonical = catalog
    // Only the two runner-owned tables are metadata. A product object merely
    // *named* `_asimposium_*` is catalog evidence and must contaminate the
    // target rather than disappear from the classifier's authority.
    .filter((entry) => !isCatalogFingerprintControl(entry))
    .map((entry) => ({
      type: entry.type,
      name: entry.name,
      table: entry.table,
      // sqlite_schema.sql is the authority: do not normalize whitespace,
      // especially not inside string literals where it changes semantics.
      sql: typeof entry.sql === "string" ? entry.sql : null,
    }));
  canonical.sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.type}\u0000${left.name}`, "utf8"),
      Buffer.from(`${right.type}\u0000${right.name}`, "utf8"),
    ),
  );
  return digestOf(JSON.stringify(canonical));
}

export function assertReadLimit(rows, maximum, code) {
  if (rows.length > maximum) {
    fail(code, "The local D1 metadata read exceeded its fixed safety limit.");
  }
  return rows;
}

function exactAppliedPrefix(applied, migrations, head) {
  if (applied.length !== head) return false;
  return applied.every((record, index) => {
    const migration = migrations[index];
    return (
      migration !== undefined &&
      record.id === migration.id &&
      record.sequence === migration.sequence &&
      record.digest === migration.digest &&
      record.sequence === index + 1
    );
  });
}

function exactAppliedSuffix(applied, migrations, baselineHead, head) {
  if (head < baselineHead || applied.length !== head - baselineHead) return false;
  return applied.every((record, index) => {
    const sequence = baselineHead + index + 1;
    const migration = migrations[sequence - 1];
    return (
      migration !== undefined &&
      record.id === migration.id &&
      record.sequence === sequence &&
      record.digest === migration.digest
    );
  });
}

function schemaHeadsDescending(manifest) {
  return [...manifest.schema_heads].sort((left, right) => right.sequence - left.sequence);
}

/**
 * The bootstrap artifact represents the 0015 product schema without replaying
 * history, so its manifest must independently pin the historical bytes it
 * intentionally does not execute. A changed or reordered 0001-0015 file is
 * not a harmless documentation edit: it invalidates every lineage claim.
 */
function assertPinnedHistoricalMigrations(manifest, migrations) {
  const pinned = manifest.historical_migrations;
  if (migrations.length < pinned.length) {
    fail(
      "BOOTSTRAP_HISTORICAL_MIGRATION_DRIFT",
      "The migration directory no longer contains the manifest-pinned historical baseline.",
    );
  }
  for (const [index, expected] of pinned.entries()) {
    const actual = migrations[index];
    if (
      actual === undefined ||
      actual.id !== expected.id ||
      actual.sequence !== index + 1 ||
      actual.digest !== expected.sha256
    ) {
      fail(
        "BOOTSTRAP_HISTORICAL_MIGRATION_DRIFT",
        "The historical migration baseline differs from the immutable bootstrap manifest.",
      );
    }
  }
}

/**
 * Classify only catalog facts read from the target. It never creates a ledger
 * while inspecting emptiness: doing so would contaminate the very target whose
 * empty-only eligibility it is deciding.
 */
export function classifySchemaLineage({ catalog, journal, lineage, migrations, manifest }) {
  assertPinnedHistoricalMigrations(manifest, migrations);
  // The local Wrangler table does not make an empty target nonempty. Runner
  // bookkeeping does: a lone or forged ledger/lineage table cannot be treated
  // as a fresh database, even though those tables are excluded from the
  // product fingerprint used for exact historical classification.
  const visible = catalog.filter((entry) => !isEmptyTargetControl(entry));
  if (visible.length === 0) return { kind: "provably-empty", head: 0 };

  const productDigest = catalogFingerprint(catalog);
  const artifact = manifest.artifacts.find(
    (candidate) => candidate.id === manifest.default_artifact_id,
  );
  if (artifact === undefined)
    fail("BOOTSTRAP_MANIFEST_INVALID", "The bootstrap manifest has no default artifact.");

  const hasLineageTable = catalog.some(isExactLineageControl);
  const hasJournal = catalog.some(isExactLedgerControl);
  const expectedHead = artifact.head_sequence;

  const schemaHeads = schemaHeadsDescending(manifest);
  const bootstrapHead = schemaHeads.find(
    (candidate) =>
      exactAppliedSuffix(journal, migrations, expectedHead, candidate.sequence) &&
      productDigest === candidate.schema_digest,
  );
  if (
    hasLineageTable &&
    hasJournal &&
    lineage.length === 1 &&
    lineage[0].lineage === BOOTSTRAP_LINEAGE &&
    lineage[0].singleton === 1 &&
    lineage[0].artifact_id === artifact.id &&
    lineage[0].artifact_digest === artifact.digest &&
    lineage[0].schema_digest === artifact.schema_digest &&
    lineage[0].empty_guard === 1 &&
    bootstrapHead !== undefined
  ) {
    return {
      kind: BOOTSTRAP_LINEAGE,
      head: bootstrapHead.sequence,
      artifact_id: artifact.id,
      journal_records: journal.length,
    };
  }

  const historicalHead = schemaHeads.find(
    (candidate) =>
      exactAppliedPrefix(journal, migrations, candidate.sequence) &&
      productDigest === candidate.schema_digest,
  );
  if (!hasLineageTable && hasJournal && historicalHead !== undefined) {
    return {
      kind:
        historicalHead.sequence === expectedHead ? "historical-current-0015" : "historical-forward",
      head: historicalHead.sequence,
    };
  }

  if (
    !hasLineageTable &&
    hasJournal &&
    exactAppliedPrefix(journal, migrations, LEGACY_HEAD) &&
    productDigest === artifact.legacy_0009_schema_digest
  ) {
    return { kind: "legacy-0009", head: LEGACY_HEAD };
  }

  return { kind: "unknown-or-contaminated", head: 0, product_digest: productDigest };
}

export function bootstrapTargetDisposition(lineage) {
  if (lineage.kind === "provably-empty") return "ready";
  if (lineage.kind === BOOTSTRAP_LINEAGE) return "idempotent";
  if (lineage.kind === "legacy-0009") {
    fail(
      "LEGACY_0009_BRIDGE_BLOCKED",
      "Exact legacy 0001-0009 is recognized, but no authority bridge is approved. Obtain an operator disposition before any bridge exists.",
    );
  }
  if (lineage.kind === "historical-current-0015" || lineage.kind === "historical-forward") {
    fail(
      "BOOTSTRAP_HISTORICAL_LINEAGE_REFUSED",
      "The target already has exact historical migration lineage; bootstrap never replaces history.",
    );
  }
  fail(
    "BOOTSTRAP_TARGET_REFUSED",
    "Bootstrap requires a provably empty catalog; the target has unknown or contaminated schema state.",
  );
}

/**
 * Derive a local plan's applied records solely from the read-only snapshot.
 * `readLocalLineageSnapshot` already returns an empty journal when the runner
 * table is absent, so creating that table merely to plan would mutate a
 * pristine target and make the second plan fail classification.
 */
export function localPlanState(snapshot, migrations, manifest) {
  const lineage = classifySchemaLineage({ ...snapshot, migrations, manifest });
  if (lineage.kind === "legacy-0009") {
    fail(
      "LEGACY_0009_BRIDGE_BLOCKED",
      "Exact legacy 0001-0009 is recognized, but an authority bridge requires a separate operator disposition.",
    );
  }
  if (lineage.kind === "unknown-or-contaminated") {
    fail(
      "SCHEMA_LINEAGE_REFUSED",
      "The local D1 catalog is neither exact historical nor an authorized bootstrap lineage.",
    );
  }
  return {
    applied: snapshot.journal,
    ...(lineage.kind === BOOTSTRAP_LINEAGE ? { baseline: { head: lineage.head } } : {}),
  };
}

/**
 * The local-only bootstrap boundary is testable with an injected observation.
 * A remote target must fail before the callback that would open/read D1 runs.
 */
export async function readBootstrapSnapshotOrRefuse(environment, observeLocalD1) {
  if (environment.kind !== "local") {
    fail(
      "BOOTSTRAP_REMOTE_UNAVAILABLE",
      "Bootstrap is intentionally local-only until an operator authorizes a disposable remote D1 run.",
    );
  }
  return observeLocalD1();
}

export function readBootstrapManifest(root) {
  const path = assertRepositoryContained(root, BOOTSTRAP_MANIFEST_PATH, "The bootstrap manifest");
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    fail("BOOTSTRAP_MANIFEST_INVALID", "The bootstrap manifest must be a regular repository file.");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("BOOTSTRAP_MANIFEST_INVALID", "The bootstrap manifest must be JSON.");
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.version !== 1 ||
    typeof manifest.default_artifact_id !== "string" ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 1 ||
    !Array.isArray(manifest.schema_heads) ||
    manifest.schema_heads.length < 1
  ) {
    fail(
      "BOOTSTRAP_MANIFEST_INVALID",
      "The bootstrap manifest must name exactly one version-1 artifact.",
    );
  }
  if (
    Object.keys(manifest).some(
      (key) =>
        ![
          "version",
          "default_artifact_id",
          "artifacts",
          "historical_migrations",
          "schema_heads",
        ].includes(key),
    )
  ) {
    fail("BOOTSTRAP_MANIFEST_INVALID", "The bootstrap manifest carries an unknown root key.");
  }
  const artifact = manifest.artifacts[0];
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    Array.isArray(artifact) ||
    artifact.id !== manifest.default_artifact_id ||
    artifact.file !== "0015_final_schema_v1.sql" ||
    !DIGEST.test(artifact.digest) ||
    !DIGEST.test(artifact.schema_digest) ||
    !DIGEST.test(artifact.legacy_0009_schema_digest) ||
    artifact.head_sequence !== 15
  ) {
    fail(
      "BOOTSTRAP_MANIFEST_INVALID",
      "The bootstrap manifest artifact is not the exact baseline-0015 shape.",
    );
  }
  if (
    Object.keys(artifact).some(
      (key) =>
        ![
          "id",
          "file",
          "head_sequence",
          "digest",
          "schema_digest",
          "legacy_0009_schema_digest",
        ].includes(key),
    )
  ) {
    fail("BOOTSTRAP_MANIFEST_INVALID", "The bootstrap artifact carries an unknown key.");
  }
  if (
    !Array.isArray(manifest.historical_migrations) ||
    manifest.historical_migrations.length !== artifact.head_sequence
  ) {
    fail(
      "BOOTSTRAP_MANIFEST_INVALID",
      "The bootstrap manifest must pin every 0001-0015 historical migration.",
    );
  }
  for (const [index, historical] of manifest.historical_migrations.entries()) {
    const expectedSequence = index + 1;
    if (
      historical === null ||
      typeof historical !== "object" ||
      Array.isArray(historical) ||
      Object.keys(historical).some((key) => !["id", "sha256"].includes(key)) ||
      typeof historical.id !== "string" ||
      !MIGRATION_FILENAME.test(historical.id) ||
      Number(MIGRATION_FILENAME.exec(historical.id)?.[1]) !== expectedSequence ||
      typeof historical.sha256 !== "string" ||
      !DIGEST.test(historical.sha256)
    ) {
      fail(
        "BOOTSTRAP_MANIFEST_INVALID",
        "Historical bootstrap migration pins must be ordered exact id and SHA-256 pairs.",
      );
    }
  }
  let previousHead = 0;
  for (const schemaHead of manifest.schema_heads) {
    if (
      schemaHead === null ||
      typeof schemaHead !== "object" ||
      Array.isArray(schemaHead) ||
      !Number.isSafeInteger(schemaHead.sequence) ||
      schemaHead.sequence <= previousHead ||
      !DIGEST.test(schemaHead.schema_digest) ||
      Object.keys(schemaHead).some((key) => !["sequence", "schema_digest"].includes(key))
    ) {
      fail(
        "BOOTSTRAP_MANIFEST_INVALID",
        "Bootstrap schema heads must be ascending exact raw catalog digests.",
      );
    }
    previousHead = schemaHead.sequence;
  }
  const baselineSchemaHead = manifest.schema_heads[0];
  if (
    baselineSchemaHead.sequence !== artifact.head_sequence ||
    baselineSchemaHead.schema_digest !== artifact.schema_digest
  ) {
    fail(
      "BOOTSTRAP_MANIFEST_INVALID",
      "The first bootstrap schema head must pin the selected baseline artifact digest.",
    );
  }
  const artifactPath = assertRepositoryContained(
    root,
    `db/bootstrap/${artifact.file}`,
    "The bootstrap artifact",
  );
  if (
    !existsSync(artifactPath) ||
    lstatSync(artifactPath).isSymbolicLink() ||
    !lstatSync(artifactPath).isFile()
  ) {
    fail(
      "BOOTSTRAP_ARTIFACT_INVALID",
      "The selected bootstrap artifact must be a regular repository file.",
    );
  }
  const sql = readFileSync(artifactPath, "utf8");
  if (digestOf(sql) !== artifact.digest) {
    fail(
      "BOOTSTRAP_ARTIFACT_DRIFT",
      "The selected bootstrap artifact digest does not match its manifest.",
    );
  }
  if (/\bIF\s+NOT\s+EXISTS\b/i.test(scanSql(sql).code)) {
    fail(
      "BOOTSTRAP_ARTIFACT_COLLISION_MASKING",
      "The bootstrap artifact must not mask an existing schema object.",
    );
  }
  return { ...manifest, artifacts: [{ ...artifact, sql }] };
}

const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Resolve the exact Wrangler installed by this workspace's lockfile.
 *
 * The migration runner must never treat `bunx`, its shared cache, or the
 * operator's PATH as an authority on the Wrangler version. `apps/wire` owns
 * the exact devDependency; its installed manifest is compared with that
 * declaration before the direct entrypoint is returned. A missing or stale
 * workspace install refuses before a D1 command can be spawned.
 */
export function resolvePinnedWranglerCommand(root, fileSystem = {}) {
  const fs = {
    existsSync: fileSystem.existsSync ?? existsSync,
    lstatSync: fileSystem.lstatSync ?? lstatSync,
    readFileSync: fileSystem.readFileSync ?? readFileSync,
  };

  const requireRegularFile = (workspacePath) => {
    const target = assertRepositoryContained(root, workspacePath, "Pinned Wrangler path");
    if (!fs.existsSync(target)) {
      fail(
        "PINNED_WRANGLER_UNAVAILABLE",
        "The repository-pinned Wrangler is not installed. Run bun install --frozen-lockfile.",
      );
    }
    try {
      if (!fs.lstatSync(target).isFile()) {
        fail(
          "PINNED_WRANGLER_UNAVAILABLE",
          "The repository-pinned Wrangler installation is not usable. Run bun install --frozen-lockfile.",
        );
      }
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      fail(
        "PINNED_WRANGLER_UNAVAILABLE",
        "The repository-pinned Wrangler installation is not usable. Run bun install --frozen-lockfile.",
      );
    }
    return target;
  };

  const readJsonObject = (workspacePath) => {
    const target = requireRegularFile(workspacePath);
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("manifest is not an object");
      }
      return parsed;
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      fail(
        "PINNED_WRANGLER_UNAVAILABLE",
        "The repository-pinned Wrangler installation is not usable. Run bun install --frozen-lockfile.",
      );
    }
  };

  const declaredPackage = readJsonObject(WIRE_PACKAGE_MANIFEST);
  const declaredVersion = declaredPackage.devDependencies?.wrangler;
  if (typeof declaredVersion !== "string" || !EXACT_SEMVER.test(declaredVersion)) {
    fail(
      "PINNED_WRANGLER_CONFIGURATION_INVALID",
      "The declared apps/wire Wrangler version must be an exact semver.",
    );
  }

  const installedPackage = readJsonObject(INSTALLED_WRANGLER_MANIFEST);
  const installedVersion = installedPackage.version;
  if (typeof installedVersion !== "string" || installedVersion !== declaredVersion) {
    fail(
      "PINNED_WRANGLER_VERSION_MISMATCH",
      "The installed repository-pinned Wrangler does not match apps/wire/package.json. Run bun install --frozen-lockfile.",
    );
  }

  const entry = requireRegularFile(INSTALLED_WRANGLER_ENTRY);
  return [process.execPath, entry];
}

function within(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  return Promise.race([promise.then((value) => ({ settled: true, value })), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Drain one child pipe under a byte bound, and hand the caller a way to let go.
 *
 * The `cancel` seam is not a convenience. `runBoundedCommand` reports a bounded
 * failure the moment a drain cannot be proven, and every such exit abandons
 * `done` while the reader is still parked inside `reader.read()`. Abandoning a
 * promise does not close anything: the reader keeps its lock on the OS pipe for
 * the lifetime of the process, so a run that truthfully reported
 * `pipe-drain-unproven` still left a detached holder behind. Cancelling is what
 * makes that report complete rather than merely honest.
 *
 * `cancel` is idempotent, safe before the reader exists (a stream whose
 * `getReader()` threw), and safe after `done` has already released. It starts
 * cleanup but never becomes another deadline: the caller lets the existing
 * drain window observe `done` while cancellation unwinds the parked read.
 */
function captureBoundedPipe(stream, maximumBytes) {
  let resolveOverrun;
  const overrun = new Promise((resolve) => {
    resolveOverrun = resolve;
  });
  let resolveFailure;
  const failure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  let reader;
  let cancellation;
  let drainFinished = false;
  let released = false;
  const release = () => {
    if (released || reader === undefined) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      // A parked read holds the lock until cancellation settles. The
      // cancellation completion path below retries this exact release.
    }
  };
  const cancel = () => {
    if (cancellation !== undefined) return cancellation;
    cancellation = (async () => {
      if (reader === undefined || drainFinished) return;
      try {
        // Rejects the parked read, which unwinds the drain loop below.
        await reader.cancel();
      } catch {
        // The caller preserves its pre-existing typed refusal; cancellation is
        // cleanup and must not replace it with an unbounded exception.
      } finally {
        release();
      }
    })();
    // An already-idle reader can be released synchronously. A parked read
    // throws here, then the bounded cancellation completion retries it.
    release();
    return cancellation;
  };
  const done = (async () => {
    if (stream === null || stream === undefined) {
      return { failed: false, overrun: false, text: "" };
    }
    const chunks = [];
    let retained = 0;
    let exceeded = false;
    let failed = false;
    const markFailed = () => {
      if (!failed) {
        failed = true;
        resolveFailure();
      }
    };
    try {
      reader = stream.getReader();
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        if (!exceeded && value !== undefined) {
          if (retained + value.byteLength > maximumBytes) {
            exceeded = true;
            resolveOverrun();
          } else {
            chunks.push(value);
            retained += value.byteLength;
          }
        }
        // After an overrun, continue draining instead of retaining bytes. The
        // controller simultaneously kills the owned process group, and this
        // drain prevents a pipe-full child from blocking reaping.
      }
    } catch {
      markFailed();
    } finally {
      drainFinished = true;
      release();
    }
    const bytes = new Uint8Array(retained);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { failed, overrun: exceeded, text: new TextDecoder().decode(bytes) };
  })();
  return { cancel, done, failure, overrun, release };
}

/**
 * Start cancellation of both owned readers without adding a second deadline.
 * The existing pipe-drain observation remains the only time budget for the
 * caller. A malformed stream may leave its cancellation promise unresolved,
 * but it cannot make `runBoundedCommand` wait beyond that pre-existing window.
 */
function cancelBoundedPipes(pipes) {
  const cancellation = Promise.all([pipes.stdout.cancel(), pipes.stderr.cancel()]);
  // Each pipe swallows its own cancellation error. Keep this final release as a
  // second chance for a reader whose parked read only unlocked asynchronously.
  void cancellation.finally(() => {
    pipes.stdout.release();
    pipes.stderr.release();
  });
  pipes.stdout.release();
  pipes.stderr.release();
  return cancellation;
}

/** Release already-drained readers without cancelling a successful command. */
function releaseBoundedPipes(pipes) {
  pipes.stdout.release();
  pipes.stderr.release();
}

function signalOwnedProcessGroup(child, signal) {
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    // Bun detached=true calls setsid() on POSIX. The child PID is therefore
    // the process-group leader, and a negative PID reaches its process-group
    // members instead of only the direct wrapper. A descendant that performs
    // another setsid() escapes this observable boundary; pipe closure is not
    // evidence that such a self-detached process has exited.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Exit between the deadline and signal delivery is an expected race.
    }
  }
}

function ownedProcessGroupExists(child) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function groupGoneWithin(child, groupExists, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (groupExists(child)) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)));
  }
  return true;
}

async function terminateOwnedProcessGroup(
  child,
  pipes,
  signalGroup,
  groupExists,
  termGraceMs,
  killReapMs,
  platform,
) {
  signalGroup(child, "SIGTERM");
  let reaped;
  let directExit;
  if (platform === "win32") {
    // Bun has no POSIX process-group signal equivalent on Windows. This is a
    // direct-child-only claim, and it must prove that direct child reaped.
    directExit = await within(child.exited, termGraceMs);
    if (!directExit.settled) {
      signalGroup(child, "SIGKILL");
      directExit = await within(child.exited, killReapMs);
    }
    reaped = directExit.settled;
  } else {
    reaped = await groupGoneWithin(child, groupExists, termGraceMs);
    if (!reaped) {
      signalGroup(child, "SIGKILL");
      reaped = await groupGoneWithin(child, groupExists, killReapMs);
    }
  }
  const drained = await within(Promise.all([pipes.stdout.done, pipes.stderr.done]), killReapMs);
  return { directExit, pipesDrained: drained.settled, reaped };
}

/**
 * Execute an owned command with a wall-clock deadline, process-group teardown,
 * and bounded concurrent pipe drains. The injectable spawn and group-signal
 * seams exist so containment refusal paths are testable without launching
 * Wrangler, Workerd, or local D1.
 */
export async function runBoundedCommand({
  cmd,
  cwd,
  timeoutMs = LOCAL_D1_COMMAND_TIMEOUT_MS,
  termGraceMs = LOCAL_D1_TERM_GRACE_MS,
  killReapMs = LOCAL_D1_KILL_REAP_MS,
  pipeDrainMs = LOCAL_D1_PIPE_DRAIN_MS,
  stdoutMaxBytes = LOCAL_D1_STDOUT_MAX_BYTES,
  stderrMaxBytes = LOCAL_D1_STDERR_MAX_BYTES,
  spawn = Bun.spawn,
  signalGroup = signalOwnedProcessGroup,
  groupExists = ownedProcessGroupExists,
  platform = process.platform,
}) {
  let child;
  try {
    child = spawn({
      cmd,
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: minimalLocalToolEnvironment(),
    });
  } catch {
    return { outcome: "spawn-failed", stderr: "", stdout: "" };
  }

  const pipes = {
    stderr: captureBoundedPipe(child.stderr, stderrMaxBytes),
    stdout: captureBoundedPipe(child.stdout, stdoutMaxBytes),
  };
  const containmentScope = platform === "win32" ? "direct-child-only" : "process-group-only";
  let pipeCancellation;
  const cancelPipes = () => {
    if (pipeCancellation === undefined) {
      pipeCancellation = cancelBoundedPipes(pipes);
    }
    return pipeCancellation;
  };
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const first = await Promise.race([
    child.exited.then((exitCode) => ({ kind: "exited", exitCode })),
    pipes.stdout.failure.then(() => ({ kind: "pipe-drain-unproven" })),
    pipes.stderr.failure.then(() => ({ kind: "pipe-drain-unproven" })),
    pipes.stdout.overrun.then(() => ({ kind: "output-overrun" })),
    pipes.stderr.overrun.then(() => ({ kind: "output-overrun" })),
    deadline,
  ]);
  clearTimeout(deadlineTimer);

  let outcome = "exited";
  let exitCode;
  if (first.kind === "exited") {
    exitCode = first.exitCode;
    const drained = await within(Promise.all([pipes.stdout.done, pipes.stderr.done]), pipeDrainMs);
    // This can observe only the owned process group. It cannot establish that
    // a grandchild which called setsid() has exited; in particular, a later
    // pipe close is not proof about that escaped process.
    const processGroupMemberRemains = platform === "win32" ? false : groupExists(child);
    if (!drained.settled || processGroupMemberRemains) {
      cancelPipes();
      const termination = await terminateOwnedProcessGroup(
        child,
        pipes,
        signalGroup,
        groupExists,
        termGraceMs,
        killReapMs,
        platform,
      );
      if (!termination.reaped) {
        outcome = platform === "win32" ? "direct-child-reap-unproven" : "process-reap-unproven";
      } else if (!termination.pipesDrained) outcome = "pipe-drain-unproven";
      else if (processGroupMemberRemains) outcome = "process-group-survivor-observed";
      else outcome = "pipe-drain-unproven";
    }
  } else {
    cancelPipes();
    const termination = await terminateOwnedProcessGroup(
      child,
      pipes,
      signalGroup,
      groupExists,
      termGraceMs,
      killReapMs,
      platform,
    );
    if (!termination.reaped) {
      outcome = platform === "win32" ? "direct-child-reap-unproven" : "process-reap-unproven";
    } else if (!termination.pipesDrained) outcome = "pipe-drain-unproven";
    else outcome = first.kind;
    if (termination.directExit?.settled) exitCode = termination.directExit.value;
    else if (platform !== "win32") {
      const exited = await within(child.exited, killReapMs);
      if (exited.settled) exitCode = exited.value;
    }
  }

  const settledPipes = await within(
    Promise.all([pipes.stdout.done, pipes.stderr.done]),
    pipeDrainMs,
  );
  if (!settledPipes.settled) {
    if (outcome === "exited") outcome = "pipe-drain-unproven";
    // The drains are still parked. This is the exit that used to strand them.
    cancelPipes();
    return {
      containment_scope: containmentScope,
      exitCode,
      outcome,
      stderr: "",
      stdout: "",
    };
  }
  const [stdout, stderr] = settledPipes.value;
  if ((stdout.failed || stderr.failed) && outcome === "exited") outcome = "pipe-drain-unproven";
  if (outcome === "exited") releaseBoundedPipes(pipes);
  else cancelPipes();
  return {
    containment_scope: containmentScope,
    exitCode,
    outcome,
    stderr: stderr.text,
    stdout: stdout.text,
  };
}

/**
 * Run a local D1 command through Wrangler.
 *
 * `--local` only. This function never accepts a `--remote` flag and never reads
 * a credential; a remote application is refused earlier, by the caller.
 */
export async function localD1(root, databaseName, args) {
  const result = await runBoundedCommand({
    cmd: [
      ...resolvePinnedWranglerCommand(root),
      "d1",
      "execute",
      databaseName,
      "--local",
      "--config",
      "infra/wrangler.toml",
      "--json",
      ...args,
    ],
    cwd: root,
  });
  if (result.outcome === "timeout") {
    fail("LOCAL_D1_COMMAND_TIMEOUT", "A local D1 command exceeded its fixed deadline.");
  }
  if (result.outcome === "output-overrun") {
    fail("LOCAL_D1_OUTPUT_OVERRUN", "A local D1 command exceeded its fixed output limit.");
  }
  if (result.outcome === "pipe-drain-unproven") {
    fail("LOCAL_D1_PIPE_DRAIN_UNPROVEN", "A local D1 command did not close its pipes after exit.");
  }
  if (result.outcome === "process-reap-unproven") {
    fail("LOCAL_D1_PROCESS_REAP_UNPROVEN", "A local D1 process group could not be reaped safely.");
  }
  if (result.outcome === "direct-child-reap-unproven") {
    fail(
      "LOCAL_D1_DIRECT_CHILD_REAP_UNPROVEN",
      "A local D1 direct child could not be reaped safely.",
    );
  }
  if (result.outcome === "process-group-survivor-observed") {
    fail(
      "LOCAL_D1_PROCESS_GROUP_SURVIVOR",
      "A local D1 command left a process-group member after its direct child exited.",
    );
  }
  if (result.outcome === "spawn-failed" || result.exitCode !== 0) {
    // Wrangler's stderr is the only account of *why* this failed, so it is
    // carried through rather than swallowed — but bounded and redacted, so the
    // diagnostic stays safe to paste into an issue.
    const stderrText = redactStderr(result.stderr.toString());
    const stdoutText = redactStderr(result.stdout);
    fail(
      "LOCAL_D1_COMMAND_FAILED",
      result.outcome === "spawn-failed"
        ? "A local D1 command could not be started."
        : `A local D1 command exited ${result.exitCode}.`,
      stderrText !== ""
        ? { output: stderrText, stream: "stderr" }
        : { output: stdoutText, stream: "stdout" },
    );
  }
  return result.stdout;
}

function parseLocalD1Rows(raw, unreadableCode) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(unreadableCode, "Could not parse the local D1 response as JSON.");
  }
  const rows = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (!Array.isArray(rows)) fail(unreadableCode, "Local D1 did not return a result array.");
  return rows;
}

/** Read-only catalog snapshot used before any bootstrap metadata exists. */
async function readLocalCatalog(root, databaseName) {
  const rows = parseLocalD1Rows(
    await localD1(root, databaseName, [
      "--command",
      `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT ${MAX_CATALOG_ROWS + 1};`,
    ]),
    "LOCAL_D1_CATALOG_UNREADABLE",
  );
  return assertReadLimit(rows, MAX_CATALOG_ROWS, "LOCAL_D1_CATALOG_OVERRUN").map((row) => ({
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl_name),
    sql: row.sql === null ? null : String(row.sql),
  }));
}

async function readOptionalLocalRows(
  root,
  databaseName,
  catalog,
  table,
  columns,
  maximum,
  overrunCode,
) {
  if (!catalog.some((entry) => entry.type === "table" && entry.name === table)) return [];
  return assertReadLimit(
    parseLocalD1Rows(
      await localD1(root, databaseName, [
        "--command",
        `SELECT ${columns} FROM ${table} ORDER BY 1 LIMIT ${maximum + 1};`,
      ]),
      "LOCAL_D1_CATALOG_UNREADABLE",
    ),
    maximum,
    overrunCode,
  );
}

async function readLocalLineageSnapshot(root, databaseName) {
  const catalog = await readLocalCatalog(root, databaseName);
  const journal = (
    await readOptionalLocalRows(
      root,
      databaseName,
      catalog,
      LEDGER_TABLE,
      "id, sequence, digest",
      MAX_JOURNAL_ROWS,
      "LOCAL_D1_JOURNAL_OVERRUN",
    )
  ).map((row) => ({
    id: String(row.id),
    sequence: Number(row.sequence),
    digest: String(row.digest),
  }));
  const lineage = (
    await readOptionalLocalRows(
      root,
      databaseName,
      catalog,
      LINEAGE_TABLE,
      "singleton, lineage, artifact_id, artifact_digest, schema_digest, empty_guard",
      MAX_LINEAGE_ROWS,
      "LOCAL_D1_LINEAGE_OVERRUN",
    )
  ).map((row) => ({
    singleton: Number(row.singleton),
    lineage: String(row.lineage),
    artifact_id: String(row.artifact_id),
    artifact_digest: String(row.artifact_digest),
    schema_digest: String(row.schema_digest),
    empty_guard: Number(row.empty_guard),
  }));
  return { catalog, journal, lineage };
}

export function bootstrapInstallSql(artifact, appliedAt) {
  // The CAS-like empty guard is evaluated inside one D1 command batch with
  // every CREATE. A racing or contaminated target hits the CHECK, rolling back
  // the lineage table, the empty journal, the witness, and every artifact
  // statement together. D1 command batches are the transaction boundary here;
  // explicit BEGIN/COMMIT is not portable through `wrangler d1 execute`.
  const guard = `(SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_' AND NOT ((type = 'table' AND name = ${sqlLiteral(LINEAGE_TABLE)} AND tbl_name = ${sqlLiteral(LINEAGE_TABLE)} AND sql = ${sqlLiteral(LINEAGE_CATALOG_SQL)}) OR (type = 'table' AND name = '_cf_METADATA' AND tbl_name = '_cf_METADATA' AND sql = ${sqlLiteral(WRANGLER_LOCAL_METADATA_SQL)})))`;
  const sql = `${BOOTSTRAP_LINEAGE_DDL}
INSERT INTO ${LINEAGE_TABLE} (singleton, lineage, artifact_id, artifact_digest, schema_digest, empty_guard, installed_at)
VALUES (1, ${sqlLiteral(BOOTSTRAP_LINEAGE)}, ${sqlLiteral(artifact.id)}, ${sqlLiteral(artifact.digest)}, ${sqlLiteral(artifact.schema_digest)}, ${guard}, ${sqlLiteral(appliedAt)});
${BOOTSTRAP_LEDGER_DDL}
${artifact.sql}
INSERT INTO sponsor_enrollment_bootstrap_migration_witness (singleton, rule_version, passed)
VALUES (1, 1, 1);`;
  return sql;
}

async function bootstrapLocalSchema(root, databaseName, artifact, appliedAt) {
  await localD1(root, databaseName, ["--command", bootstrapInstallSql(artifact, appliedAt)]);
}

function assertForwardHeadsRegistered(plan, manifest) {
  const artifact = manifest.artifacts.find(
    (candidate) => candidate.id === manifest.default_artifact_id,
  );
  for (const pending of plan.to_apply) {
    if (
      pending.sequence > artifact.head_sequence &&
      !manifest.schema_heads.some((schemaHead) => schemaHead.sequence === pending.sequence)
    ) {
      fail(
        "SCHEMA_HEAD_FINGERPRINT_MISSING",
        `Migration ${pending.sequence} has no pinned post-apply catalog fingerprint.`,
      );
    }
  }
}

/**
 * Apply one migration and record it in the same call, so a migration can never
 * be applied without leaving the record that makes the next run idempotent.
 *
 * Sent as a single `--command` rather than through a temporary file: this
 * process creates no file it would then have to remove, so it has no delete
 * path at all.
 */
export function migrationCommandSql(migration, appliedAt) {
  // Keep the lexical preflight at the execution seam too. Normal CLI inputs
  // were checked by readMigrationDirectory, but this protects every direct
  // caller and proves the journal append cannot be swallowed by malformed SQL.
  scanSql(migration.sql);
  return `${migration.sql}\nINSERT INTO ${LEDGER_TABLE} (id, sequence, digest, applied_at) VALUES (${sqlLiteral(migration.id)}, ${migration.sequence}, ${sqlLiteral(migration.digest)}, ${sqlLiteral(appliedAt)});`;
}

async function applyLocalMigration(root, databaseName, migration, appliedAt) {
  await localD1(root, databaseName, ["--command", migrationCommandSql(migration, appliedAt)]);
}

/**
 * Applied records as they would be read from D1; also the rehearsal format.
 *
 * Every field is bounded, because this file is caller-supplied: a rehearsal
 * state that claims a migration was applied is exactly how a real one gets
 * skipped. Ids must name a real migration shape, sequences must be the id's own
 * number, digests must be sha256 hex, and the list must be duplicate-free and
 * ascending.
 */
export function readStateFile(path) {
  if (!existsSync(path)) {
    fail("MISSING_STATE_FILE", "The applied-migration state file does not exist.");
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    fail("UNSAFE_STATE_FILE", "The applied-migration state file must not be a symlink.");
  }
  if (!stat.isFile()) {
    fail("UNSAFE_STATE_FILE", "The applied-migration state file must be a regular file.");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("MALFORMED_STATE_FILE", "The applied-migration state file must be JSON.");
  }
  if (!Array.isArray(parsed)) {
    fail("MALFORMED_STATE_FILE", "The applied-migration state file must be a JSON array.");
  }

  const records = [];
  const seenIds = new Set();
  const seenSequences = new Set();
  let previousSequence = 0;

  for (const [index, record] of parsed.entries()) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail("MALFORMED_STATE_FILE", `State record ${index} must be an object.`);
    }
    for (const key of Object.keys(record)) {
      if (!["id", "sequence", "digest"].includes(key)) {
        fail("MALFORMED_STATE_FILE", `State record ${index} carries unknown key "${key}".`);
      }
    }
    const { id, sequence, digest } = record;
    if (typeof id !== "string") {
      fail("MALFORMED_STATE_FILE", `State record ${index} must carry a string id.`);
    }
    const match = MIGRATION_FILENAME.exec(id);
    if (match === null) {
      fail("MALFORMED_STATE_FILE", `State record ${index} id "${id}" is not a migration filename.`);
    }
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
      fail("MALFORMED_STATE_FILE", `State record ${index} must carry a positive integer sequence.`);
    }
    if (sequence !== Number(match[1])) {
      fail(
        "MALFORMED_STATE_FILE",
        `State record ${index} sequence ${sequence} does not match the number in "${id}".`,
      );
    }
    if (typeof digest !== "string" || !DIGEST.test(digest)) {
      fail("MALFORMED_STATE_FILE", `State record ${index} must carry a 64-character hex digest.`);
    }
    if (seenIds.has(id)) {
      fail("DUPLICATE_STATE_RECORD", `State file records "${id}" more than once.`);
    }
    if (seenSequences.has(sequence)) {
      fail("DUPLICATE_STATE_RECORD", `State file records sequence ${sequence} more than once.`);
    }
    if (sequence <= previousSequence) {
      fail(
        "UNORDERED_STATE_FILE",
        `State file record ${index} (sequence ${sequence}) is not in ascending order.`,
      );
    }
    seenIds.add(id);
    seenSequences.add(sequence);
    previousSequence = sequence;
    records.push({ id, sequence, digest });
  }
  return records;
}

/**
 * A rehearsal state is a *claim* about what has already been applied. Trusting
 * it while actually applying would let a caller hand in a file saying "0001 is
 * done" and have the runner skip a migration that never ran. An application
 * reads the target's own ledger, or it does not apply.
 */
export function assertRehearsalIsNotAnApplication(options) {
  if (options.apply && options.state !== undefined) {
    fail(
      "STATE_FILE_WITH_APPLY",
      "--state-file describes a rehearsal and cannot be combined with --apply; an application reads the target's own ledger.",
    );
  }
  if (options.bootstrap !== undefined && options.state !== undefined) {
    fail(
      "STATE_FILE_WITH_BOOTSTRAP",
      "--bootstrap reads the target catalog and cannot be combined with a rehearsal state file.",
    );
  }
}

function parseArguments(argv) {
  const options = {
    env: undefined,
    state: undefined,
    apply: false,
    bootstrap: undefined,
    confirmProduction: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env") {
      options.env = argv[index + 1];
      index += 1;
    } else if (argument === "--state-file") {
      options.state = argv[index + 1];
      index += 1;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--bootstrap") {
      options.bootstrap = argv[index + 1];
      index += 1;
    } else if (argument === "--i-understand-this-is-production") {
      options.confirmProduction = true;
    } else {
      fail(
        "INVALID_ARGUMENT",
        "Usage: bun infra/migrate.mjs --env <local|staging|production> [--state-file <path>] [--bootstrap <artifact-id>] [--apply]",
      );
    }
  }
  return options;
}

function diagnostic(status, startedAt, phase, details = {}) {
  return {
    tool: "bun",
    package: "infra",
    suite: "d1-migration-plan",
    version: Bun.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status,
    phase,
    reproduce: "bun infra/migrate.mjs --env <environment>",
    ...details,
  };
}

async function main() {
  const startedAt = performance.now();
  let phase = "arguments";
  try {
    const options = parseArguments(process.argv.slice(2));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    assertRehearsalIsNotAnApplication(options);

    phase = "environment";
    const report = validateEnvironments(root);
    // Explicit selection: there is no default environment, so no command can
    // reach production by omission.
    const environment = selectEnvironment(report, options.env);

    phase = "plan";
    const migrations = readMigrationDirectory(
      assertRepositoryContained(root, "db/migrations", "The migrations directory"),
    );
    const localDatabase = environment.kind === "local" ? "asimposium-local" : undefined;
    let baseline;

    if (options.bootstrap !== undefined) {
      const manifest = readBootstrapManifest(root);
      const artifact = manifest.artifacts.find((candidate) => candidate.id === options.bootstrap);
      if (artifact === undefined) {
        fail(
          "BOOTSTRAP_ARTIFACT_REFUSED",
          "The requested bootstrap artifact id is not in the manifest.",
        );
      }
      const snapshot = await readBootstrapSnapshotOrRefuse(environment, () =>
        readLocalLineageSnapshot(root, localDatabase),
      );
      const lineage = classifySchemaLineage({ ...snapshot, migrations, manifest });
      if (bootstrapTargetDisposition(lineage) === "idempotent") {
        process.stdout.write(
          `${JSON.stringify(
            diagnostic("pass", startedAt, "bootstrap", {
              environment: options.env,
              bootstrap_artifact: artifact.id,
              lineage: BOOTSTRAP_LINEAGE,
              idempotent: true,
              journal_records: lineage.journal_records,
            }),
          )}\n`,
        );
        return;
      }
      if (!options.apply) {
        process.stdout.write(
          `${JSON.stringify(
            diagnostic("pass", startedAt, "bootstrap-plan", {
              environment: options.env,
              bootstrap_artifact: artifact.id,
              lineage: lineage.kind,
              ready_to_apply: true,
            }),
          )}\n`,
        );
        return;
      }
      await bootstrapLocalSchema(root, localDatabase, artifact, new Date().toISOString());
      const after = classifySchemaLineage({
        ...(await readLocalLineageSnapshot(root, localDatabase)),
        migrations,
        manifest,
      });
      if (after.kind !== BOOTSTRAP_LINEAGE || after.artifact_id !== artifact.id) {
        fail(
          "BOOTSTRAP_LINEAGE_UNVERIFIED",
          "Bootstrap completed without the expected durable baseline lineage.",
        );
      }
      process.stdout.write(
        `${JSON.stringify(
          diagnostic("pass", startedAt, "bootstrap", {
            environment: options.env,
            bootstrap_artifact: artifact.id,
            lineage: BOOTSTRAP_LINEAGE,
            idempotent: false,
            journal_records: 0,
          }),
        )}\n`,
      );
      return;
    }

    let localSnapshot;
    let localManifest;
    let localPlan;
    if (localDatabase !== undefined && options.state === undefined) {
      localManifest = readBootstrapManifest(root);
      localSnapshot = await readLocalLineageSnapshot(root, localDatabase);
      localPlan = localPlanState(localSnapshot, migrations, localManifest);
      baseline = localPlan.baseline;
    }
    // A local environment has a real (miniflare) D1 available with no
    // credential, so its applied-records come from the database itself rather
    // than from a rehearsal file.
    const applied =
      options.state !== undefined
        ? readStateFile(assertRepositoryContained(root, options.state, "The state file path"))
        : localDatabase !== undefined
          ? localPlan.applied
          : [];
    const plan = planMigrations(migrations, applied, {
      environmentName: options.env,
      // The configured flag, not a guess re-derived from the environment name.
      // The topology is the authority on what each target permits; recomputing
      // it here would make `destructive_operations_allowed` decorative.
      destructiveAllowed: environment.destructive_operations_allowed,
      baseline,
    });

    if (localManifest !== undefined) assertForwardHeadsRegistered(plan, localManifest);

    if (!options.apply) {
      process.stdout.write(
        `${JSON.stringify(
          diagnostic("pass", startedAt, "plan", {
            environment: options.env,
            environment_kind: environment.kind,
            is_preview: environment.is_preview,
            d1_binding: environment.d1_binding,
            key_ids: environment.key_ids,
            migrations_discovered: migrations.length,
            ...plan,
          }),
        )}\n`,
      );
      return;
    }

    phase = "apply";
    // Destructive-target guard: naming production is not the same as intending
    // it, so the intent must be stated separately from the target.
    if (options.env === "production" && !options.confirmProduction) {
      fail(
        "PRODUCTION_CONFIRMATION_REQUIRED",
        "Applying to production requires --i-understand-this-is-production in addition to --env production.",
      );
    }
    if (localDatabase === undefined) {
      // The honest wall for remote environments. Applying needs a provisioned
      // D1 and a deployment credential; neither exists here, and inventing a
      // success would be the exact failure this bead's criteria forbid.
      fail(
        "APPLY_UNAVAILABLE",
        `Cannot apply migrations to ${options.env}: no D1 binding or deployment credential is available in this environment. ` +
          "Provision the environment first; this runner will not simulate an application.",
      );
    }

    // Local is genuinely available: Wrangler's local D1 is workerd's own
    // SQLite, needs no account, and is not a mock of D1.
    const appliedAt = new Date().toISOString();
    const appliedNow = [];
    for (const pending of plan.to_apply) {
      const migration = migrations.find((candidate) => candidate.id === pending.id);
      await applyLocalMigration(root, localDatabase, migration, appliedAt);
      appliedNow.push({ id: migration.id, digest: migration.digest });
    }

    const afterSnapshot = await readLocalLineageSnapshot(root, localDatabase);
    const afterLineage = classifySchemaLineage({
      ...afterSnapshot,
      migrations,
      manifest: localManifest,
    });
    if (afterLineage.kind === "unknown-or-contaminated") {
      fail(
        "SCHEMA_LINEAGE_UNVERIFIED",
        "Applied migrations did not leave an exact reclassifiable local schema lineage.",
      );
    }
    const secondPlan = planMigrations(migrations, afterSnapshot.journal, {
      environmentName: options.env,
      destructiveAllowed: environment.destructive_operations_allowed,
      ...(afterLineage.kind === BOOTSTRAP_LINEAGE ? { baseline: { head: afterLineage.head } } : {}),
    });
    if (!secondPlan.idempotent) {
      fail(
        "MIGRATION_RECLASSIFY_NOT_IDEMPOTENT",
        "Applied migrations did not produce an empty second migration plan.",
      );
    }

    process.stdout.write(
      `${JSON.stringify(
        diagnostic("pass", startedAt, "apply", {
          environment: options.env,
          environment_kind: environment.kind,
          d1_binding: environment.d1_binding,
          key_ids: environment.key_ids,
          applied: appliedNow,
          skipped: plan.skipped,
          head_before: plan.head,
        }),
      )}\n`,
    );
  } catch (error) {
    const details =
      error instanceof MigrationError || error instanceof EnvironmentValidationError
        ? {
            code: error.code,
            // Redacted again at the emission boundary, not only at the throw
            // site. `fail()` covers what this module raises, but this branch
            // also serialises errors constructed elsewhere, and the boundary
            // that writes to stderr is the one that must be safe. Redaction is
            // idempotent, so covering both costs nothing.
            detail: redactStderr(error.message),
            ...(error.causalOutput
              ? { causal_output: error.causalOutput, causal_stream: error.causalStream }
              : {}),
          }
        : { code: "UNEXPECTED", detail: "Unexpected migration failure." };
    process.stderr.write(`${JSON.stringify(diagnostic("fail", startedAt, phase, details))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
