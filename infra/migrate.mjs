import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
export const LOCAL_OWNER_LEASE_FRAME_MAX_BYTES = 128;
export const LOCAL_OWNER_LEASE_HANDSHAKE_MS = 1_000;
export const LOCAL_OWNER_LEASE_MAX_LIFETIME_MS = 15_000;
export const REMOTE_D1_STDOUT_MAX_BYTES = 256 * 1024;
export const REMOTE_D1_STDERR_MAX_BYTES = 65_536;
// A remote command is given its execution window before this reserve. The
// reserve is the worst bounded path an aborted `runBoundedCommand` can spend
// after `controller.abort()`, counted window by window against that function
// rather than approximated, because a reserve shorter than the real path lets
// the outer call emit a receipt while the owned child is still cleaning up:
//   1. TERM grace, also the normal fd0-watchdog retirement wait
//      before immediate fallback escalation ............... termGraceMs
//   2. `terminateOwnedProcessGroup` SIGKILL reap .......... killReapMs
//   3. `terminateOwnedProcessGroup` termination drain ..... killReapMs
//   4. post-termination `within(child.exited, killReapMs)`  killReapMs
//   5. final `within(completeBoundedPipes(...), pipeDrainMs)` pipeDrainMs
//   6. `settleBoundedPipeCleanup(...)` bounded cancellation  pipeDrainMs
// Window 6 is reachable from BOTH tails: the failed-drain branch always spends
// it, and the settled-drain non-exit branch spends it too. Bounding the
// cancellation wait was necessary to stop a hang, but it is a real window and
// must be counted here — an uncounted wait is how the outer race comes back.
// It is part of the one observation deadline, not a second deadline after it.
export const REMOTE_D1_CONTAINMENT_RESERVE_MS =
  LOCAL_D1_TERM_GRACE_MS + LOCAL_D1_KILL_REAP_MS * 3 + LOCAL_D1_PIPE_DRAIN_MS * 2;
// The smallest execution window worth spawning a child for. Below this, starting
// a command only guarantees it will be aborted before it can answer.
export const REMOTE_D1_EXECUTION_FLOOR_MS = 1_000;
// Timers fire no earlier than their delay and the event loop is shared, so each
// composed window above is a LOWER bound on real elapsed time. The margin must
// therefore sit inside the reserved cleanup tail, not merely inside the
// pre-start check: if it were only added to the start window, execution would be
// free to consume it and cleanup would still be allocated exactly the composed
// sum with no slack, so one late timer re-creates the outer race this reserve
// exists to remove.
export const REMOTE_D1_SCHEDULING_MARGIN_MS = 250;
/** What is actually withheld from execution: the composed windows plus slack. */
export const REMOTE_D1_CLEANUP_RESERVE_MS =
  REMOTE_D1_CONTAINMENT_RESERVE_MS + REMOTE_D1_SCHEDULING_MARGIN_MS;
// A default command may only START if this whole window still remains on the one
// absolute deadline: the cleanup tail, plus an execution floor ON TOP of it. A
// budget shared across describe plus N queries shrinks as it is spent, and a
// later call that starts with a truncated reserve is exactly how a real child
// outlives the outer receipt: the outer expires, reports settlement unproven,
// and the child keeps cleaning. Refusing before the spawn is the only point at
// which that is still preventable.
export const REMOTE_D1_COMMAND_WINDOW_MS =
  REMOTE_D1_CLEANUP_RESERVE_MS + REMOTE_D1_EXECUTION_FLOOR_MS;
// Local orchestration uses the same bounded executor and therefore owes the
// same complete cleanup tail before its caller's absolute deadline. Its fd0
// owner lease adds one sequential, bounded FileSink `end()` observation before
// the historical cleanup path starts; admission must reserve that functional
// wait separately instead of pretending it overlaps the six remote windows.
export const LOCAL_D1_OWNER_LEASE_CLOSE_RESERVE_MS = LOCAL_D1_PIPE_DRAIN_MS;
export const LOCAL_D1_CLEANUP_RESERVE_MS =
  REMOTE_D1_CLEANUP_RESERVE_MS + LOCAL_D1_OWNER_LEASE_CLOSE_RESERVE_MS;
// The larger floor reflects a real Wrangler/workerd startup rather than a
// remote HTTP request. With no caller deadline, localD1 keeps its standalone
// fixed timeout.
export const LOCAL_D1_EXECUTION_FLOOR_MS = 3_000;
export const LOCAL_D1_COMMAND_WINDOW_MS = LOCAL_D1_CLEANUP_RESERVE_MS + LOCAL_D1_EXECUTION_FLOOR_MS;
const RESOLVED_STAGING_WRANGLER_CONFIG = "infra/deploy-resolved/staging.wrangler.toml";

function immutableEmptyWranglerConfigOrRefuse() {
  // Wrangler's parser treats this extensionless POSIX character device as an
  // empty configuration. Passing it explicitly prevents parent-directory
  // discovery of a workspace config while the captured account id below selects
  // the account. Windows has no equivalent path with this exact parser contract,
  // so the default remote transport refuses there rather than silently falling
  // back to a mutable config search.
  if (process.platform === "win32") {
    fail(
      "REMOTE_IMMUTABLE_CONFIG_UNAVAILABLE",
      "The default remote D1 transport requires an immutable empty Wrangler configuration on this platform.",
    );
  }
  return "/dev/null";
}

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
 * The one remote tool environment is deliberately smaller than the parent
 * environment, but retains the two documented Wrangler authentication paths:
 * an explicit API token or Wrangler's credential store under HOME. No diagnostic
 * ever serialises this object or a child's raw output.
 */
function minimalRemoteToolEnvironment(accountId) {
  const environment = minimalLocalToolEnvironment();
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "CLOUDFLARE_API_TOKEN"]) {
    const value = process.env[key];
    if (typeof value === "string" && value !== "") environment[key] = value;
  }
  // The resolved staging artifact is consumed once at transport construction.
  // Every child receives this captured authority, not an account selected from a
  // mutable Wrangler config or from the ambient process environment.
  environment.CLOUDFLARE_ACCOUNT_ID = accountId;
  return environment;
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
// The remote (hosted) D1 runtime carries `_cf_KV` instead of `_cf_METADATA`.
// Captured byte-exact from a freshly provisioned remote database; like the
// local metadata table it is platform control only in this exact shape.
const WRANGLER_REMOTE_KV_SQL = `CREATE TABLE _cf_KV (
        key TEXT PRIMARY KEY,
        value BLOB
      ) WITHOUT ROWID`;

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

// Same discipline for the hosted runtime's `_cf_KV`: exact bytes or it is
// catalog evidence, never platform metadata.
function isExactWranglerRemoteKv(entry) {
  return (
    entry.type === "table" &&
    entry.name === "_cf_KV" &&
    entry.table === "_cf_KV" &&
    entry.sql === WRANGLER_REMOTE_KV_SQL
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
    isExactWranglerLocalMetadata(entry) ||
    isExactWranglerRemoteKv(entry)
  );
}

function isEmptyTargetControl(entry) {
  return (
    isSqliteInternalCatalogObject(entry) ||
    isExactWranglerLocalMetadata(entry) ||
    isExactWranglerRemoteKv(entry)
  );
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
 * A remote target fails before the callback that would open/read D1 runs —
 * unless the operator has explicitly authorized a disposable remote run, in
 * which case the caller supplies that observation here. The authorization
 * decision (flag + staging-preview topology) is made by the caller; this
 * function enforces only that no remote observation happens without one.
 */
export async function readBootstrapSnapshotOrRefuse(
  environment,
  observeLocalD1,
  observeAuthorizedRemoteD1 = undefined,
) {
  if (environment.kind !== "local") {
    if (typeof observeAuthorizedRemoteD1 !== "function") {
      fail(
        "BOOTSTRAP_REMOTE_UNAVAILABLE",
        "Bootstrap is intentionally local-only until an operator authorizes a disposable remote D1 run.",
      );
    }
    return observeAuthorizedRemoteD1();
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
 * `getReader()` threw), and safe after `done` has already released. The normal
 * drain window remains bounded, but a failed drain does not receive a receipt
 * until cancellation has actually unwound the parked read and released its
 * lock. Returning while that promise is still pending would leave a detached
 * OS-pipe holder behind after an ostensibly contained command.
 */
/**
 * One shared, capture-free rejection handler for cancel promises.
 *
 * Attaching a rejection reaction to an arbitrary promise is unavoidable —
 * omitting it turns a rejecting source hook into a late unhandled rejection —
 * and no JavaScript API detaches one. What IS controllable is what that
 * reaction keeps alive. Because this function is module-level and closes over
 * nothing, a hostile never-settling hook retains a pointer to this one global
 * and to no reader, pipe, command, run, or OS resource.
 */
const ignoreCancellationRejection = () => undefined;

/** Cancellation is represented as "initiated", never as "settled". */
const CANCELLATION_INITIATED = Promise.resolve();

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
  /**
   * Release the handle after a cancellation promise that did not settle, and
   * report honestly whether it worked. It is deliberately not called "force":
   * nothing here can force a stream, and none is needed.
   *
   * Per the Streams standard, `reader.cancel()` closes the stream as part of
   * *initiating* cancellation: every pending read request is fulfilled with
   * `{done: true}` right then, before the underlying source's `cancel` hook is
   * awaited. So a source hook that never settles leaves only the outer
   * cancellation promise pending — the parked read has already been freed, the
   * drain loop has already broken out, and its finalizer has already released
   * the lock. That is why bounding the wait on that promise strands nothing.
   *
   * This remains as the honest belt-and-braces for that expiry path: retry the
   * lock release and report the result rather than asserting a release that may
   * not have happened. It deliberately does NOT retry `stream.cancel()` — a
   * second call would attach a second reaction to another externally rooted
   * promise for no gain, since cancellation has already been initiated once.
   * `settleBoundedPipeCleanup` returns this report instead of claiming
   * containment.
   */
  const releaseHandleOrReport = () => {
    release();
    return released;
  };
  /**
   * Initiate cancellation WITHOUT taking a dependency on its promise.
   *
   * `reader.cancel()` returns a promise resolved by the underlying source's
   * `cancel` hook, which is arbitrary code that may never settle. Awaiting it —
   * even inside a bounded observation — creates a reaction record on that
   * promise that cannot be detached, and `Promise.all` in
   * `completeBoundedPipes` then retains it for the process lifetime. The bound
   * limits how long the caller *waits*; it does not release what the wait
   * retained.
   *
   * Nothing needs that promise. Per the Streams standard, `cancel()` closes the
   * stream while initiating: pending reads are fulfilled with `{done: true}`
   * before the source hook is invoked. So the drain loop exits and its
   * finalizer releases the lock on the strength of `done` alone.
   *
   * The guarantee this makes is therefore narrow and exact. It calls
   * `reader.cancel()` once, attaches only the module-level capture-free
   * rejection handler, releases the lock immediately, and returns a resolved
   * module sentinel meaning CANCELLATION WAS INITIATED — never that it settled.
   * The hook's promise is not stored, not awaited, and never enters a
   * `Promise.all`, so no completion path depends on it and `done` remains the
   * only thing a caller bounds.
   *
   * What that does not claim: a hostile never-settling hook still holds one
   * reaction record pointing at `ignoreCancellationRejection`. That is
   * unavoidable, and it retains no reader, pipe, command, run context, or OS
   * resource — which is the whole of the claim.
   */
  const cancel = () => {
    if (cancellation !== undefined) return cancellation;
    if (reader !== undefined && !drainFinished) {
      try {
        const initiated = reader.cancel();
        if (initiated !== null && typeof initiated?.then === "function") {
          // Rejection safety only. Never stored, awaited, or composed.
          void initiated.then(undefined, ignoreCancellationRejection);
        }
      } catch {
        // A synchronous throw is cleanup noise; the caller keeps its own refusal.
      }
    }
    // The standard has already fulfilled any parked read, so this either
    // succeeds now or succeeds in the drain finalizer that `done` awaits.
    release();
    cancellation = CANCELLATION_INITIATED;
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
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      markFailed();
    }
    return { failed, overrun: exceeded, text };
  })();
  return { cancel, done, failure, overrun, release, releaseHandleOrReport };
}

/**
 * Bound the cleanup that follows a failed drain.
 *
 * Awaiting cancellation without a bound was the previous behaviour and it is a
 * hang: a source whose `cancel` hook never settles never returns a receipt at
 * all. A command that cannot answer is strictly worse than one that answers
 * "unproven", so this settles in bounded time and reports which happened.
 *
 * What expiry does and does not mean is precise. Cancelling a standards stream
 * fulfils its pending reads immediately, so by this point the drain loops have
 * already exited and released their locks; only the source hook's promise is
 * still outstanding. The retry below therefore normally confirms an already
 * released handle rather than rescuing a held one. The boolean is returned, not
 * asserted, so a caller never records cleanup it did not observe.
 */
async function settleBoundedPipeCleanup(pipes, cancellation, timeoutMs) {
  const settled = await within(completeBoundedPipes(pipes, cancellation), timeoutMs);
  if (settled.settled) return true;
  const stdoutReleased = pipes.stdout.releaseHandleOrReport();
  const stderrReleased = pipes.stderr.releaseHandleOrReport();
  return stdoutReleased && stderrReleased;
}

/**
 * Start cancellation of both owned readers. The caller may use a bounded
 * observation to decide that draining is unproven, but it must await this
 * completion before returning a command receipt: otherwise a losing cleanup
 * promise can retain a reader lock after the process result was reported.
 */
function cancelBoundedPipes(pipes) {
  const cancellation = Promise.all([pipes.stdout.cancel(), pipes.stderr.cancel()]);
  // Each pipe swallows its own cancellation error. The caller includes this
  // promise in its existing bounded drain observation; do not detach an
  // unbounded completion that might retain a reader lock after return.
  pipes.stdout.release();
  pipes.stderr.release();
  return cancellation;
}

/** Release already-drained readers without cancelling a successful command. */
function releaseBoundedPipes(pipes) {
  pipes.stdout.release();
  pipes.stderr.release();
}

function completeBoundedPipes(pipes, cancellation) {
  if (cancellation === undefined) {
    return Promise.all([pipes.stdout.done, pipes.stderr.done]);
  }
  return Promise.all([pipes.stdout.done, pipes.stderr.done, cancellation]).then(
    ([stdout, stderr]) => [stdout, stderr],
  );
}

async function observeBoundedPipesOrAbort(pipes, cancellation, timeoutMs, aborted) {
  const drained = within(completeBoundedPipes(pipes, cancellation), timeoutMs).then((result) => ({
    kind: "pipes",
    result,
  }));
  return aborted === undefined ? drained : Promise.race([drained, aborted]);
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

function signalDirectChild(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // Exit between the deadline and signal delivery is an expected race.
  }
}

export const OWNED_PROCESS_GROUP = "owned-process-group";
export const PARENT_PROCESS_GROUP = "parent-process-group";

const LOCAL_OWNER_LEASE_PREFIX = "ASIMP_LOCAL_OWNER_LEASE_V1";
const LOCAL_OWNER_WATCHDOG_PREFIX = "ASIMP_LOCAL_OWNER_WATCHDOG_V1";
const LOCAL_OWNER_REFUSAL_PREFIX = "ASIMP_LOCAL_OWNER_REFUSED_V1";
const LOCAL_OWNER_NONCE = /^[0-9a-f]{64}$/;
const authenticatedLocalOwnerLeases = new WeakSet();

function canonicalLocalOwnerLeaseFrame(nonce, deadlineAtMs) {
  if (!LOCAL_OWNER_NONCE.test(nonce) || !Number.isSafeInteger(deadlineAtMs)) {
    fail("LOCAL_D1_OWNER_LEASE_FRAME_INVALID", "The local owner lease frame is invalid.");
  }
  const frame = `${LOCAL_OWNER_LEASE_PREFIX} ${nonce} ${deadlineAtMs}\n`;
  if (Buffer.byteLength(frame) > LOCAL_OWNER_LEASE_FRAME_MAX_BYTES) {
    fail("LOCAL_D1_OWNER_LEASE_FRAME_INVALID", "The local owner lease frame is too large.");
  }
  return frame;
}

function localOwnerWatchdogSource() {
  return `
import { fstatSync } from "node:fs";
const LEASE = ${JSON.stringify(LOCAL_OWNER_LEASE_PREFIX)};
const READY = ${JSON.stringify(LOCAL_OWNER_WATCHDOG_PREFIX)};
const REFUSED = ${JSON.stringify(LOCAL_OWNER_REFUSAL_PREFIX)};
const MAX_BYTES = ${LOCAL_OWNER_LEASE_FRAME_MAX_BYTES};
const PREAUTH_MS = ${LOCAL_OWNER_LEASE_HANDSHAKE_MS};
const MAX_LIFETIME_MS = ${LOCAL_OWNER_LEASE_MAX_LIFETIME_MS};
const TERM_GRACE_MS = ${LOCAL_D1_TERM_GRACE_MS};
let terminal = false;
process.on("SIGTERM", () => {});
const refuse = (code) => {
  if (terminal) return;
  terminal = true;
  process.stdout.write(REFUSED + " " + code + "\\n");
  setTimeout(() => process.exit(1), 0);
};
const retireGroup = async () => {
  if (terminal) return;
  terminal = true;
  try { process.kill(0, "SIGTERM"); } catch {}
  await Bun.sleep(TERM_GRACE_MS);
  try { process.kill(0, "SIGKILL"); } catch { process.exit(1); }
};
let stat;
try { stat = fstatSync(0); } catch { refuse("ABSENT"); }
// Bun 1.3.8 implements stdin pipe mode with an anonymous local socket on
// macOS, while other supported runtimes expose a FIFO. Both are live,
// kernel-owned duplex capabilities whose EOF is tied to the retained parent
// writer. A regular file or terminal has no such owner-liveness authority.
if (!terminal && !stat.isFIFO() && !stat.isSocket()) {
  refuse(stat.isCharacterDevice() ? "TERMINAL" : "REGULAR");
}
if (!terminal) {
  const preauth = setTimeout(() => refuse("STUCK"), PREAUTH_MS);
  const reader = Bun.stdin.stream().getReader();
  const chunks = [];
  let retained = 0;
  let sawLine = false;
  let ended = false;
  try {
    while (!sawLine && !terminal) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      if (next.value !== undefined) {
        retained += next.value.byteLength;
        if (retained > MAX_BYTES) break;
        chunks.push(next.value);
        sawLine = next.value.includes(10);
      }
    }
  } catch { ended = true; }
  clearTimeout(preauth);
  if (!terminal) {
    if (ended) refuse("DEAD");
    else {
      const bytes = new Uint8Array(retained);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let frame;
      try { frame = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
      const match = /^(ASIMP_LOCAL_OWNER_LEASE_V1) ([0-9a-f]{64}) (0|[1-9][0-9]*)\\n$/.exec(frame ?? "");
      const deadlineAtMs = match === null ? NaN : Number(match[3]);
      if (match === null || !Number.isSafeInteger(deadlineAtMs)) refuse("MALFORMED");
      else {
        const clampedDeadlineAtMs = Math.min(deadlineAtMs, Date.now() + MAX_LIFETIME_MS);
        setTimeout(retireGroup, Math.max(0, clampedDeadlineAtMs - Date.now()));
        process.stdout.write(READY + " " + match[2] + " " + deadlineAtMs + "\\n");
        for (;;) {
          let next;
          try { next = await reader.read(); } catch { await retireGroup(); break; }
          if (next.done || (next.value?.byteLength ?? 0) > 0) { await retireGroup(); break; }
        }
      }
    }
  }
}
`;
}

async function stopLocalOwnerWatchdog(child, timeoutMs = LOCAL_D1_KILL_REAP_MS) {
  try {
    child.kill("SIGTERM");
  } catch {}
  const observeExit = async () => {
    try {
      const observed = await within(Promise.resolve(child.exited), timeoutMs);
      return observed.settled;
    } catch {
      return false;
    }
  };
  let exited = await observeExit();
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {}
    exited = await observeExit();
  }
  return exited;
}

async function readLocalOwnerWatchdogFrame(stream, timeoutMs) {
  if (stream === null || stream === undefined) return { kind: "dead" };
  let reader;
  try {
    reader = stream.getReader();
  } catch {
    return { kind: "malformed" };
  }
  try {
    const read = (async () => {
      let retained = 0;
      const chunks = [];
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return { kind: "dead" };
          if (next.value === undefined) continue;
          retained += next.value.byteLength;
          if (retained > LOCAL_OWNER_LEASE_FRAME_MAX_BYTES) return { kind: "malformed" };
          chunks.push(next.value);
          if (next.value.includes(10)) break;
        }
      } catch {
        return { kind: "malformed" };
      }
      const bytes = new Uint8Array(retained);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return {
          kind: "frame",
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      } catch {
        return { kind: "malformed" };
      }
    })();
    const observed = await within(read, timeoutMs);
    return observed.settled ? observed.value : { kind: "stuck" };
  } finally {
    try {
      const initiated = reader.cancel();
      if (initiated !== null && typeof initiated?.then === "function") {
        void initiated.then(undefined, ignoreCancellationRejection);
      }
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}

export async function authenticateLocalOwnerLease(
  deadlineAtMs,
  {
    spawn = Bun.spawn,
    handshakeMs = LOCAL_OWNER_LEASE_HANDSHAKE_MS,
    platform = process.platform,
    processLeadsOwnedGroup = currentProcessLeadsOwnedGroup,
    toolEnvironment = minimalLocalToolEnvironment(),
  } = {},
) {
  if (!Number.isSafeInteger(deadlineAtMs)) {
    fail("LOCAL_D1_OWNER_LEASE_MISMATCH", "The local owner lease deadline is invalid.");
  }
  if (platform === "win32") {
    fail(
      "LOCAL_D1_OWNER_LEASE_UNAVAILABLE",
      "The deadline-bearing local owner lease requires POSIX process-group ownership.",
    );
  }
  if (!processLeadsOwnedGroup()) {
    fail(
      "LOCAL_D1_PARENT_PROCESS_GROUP_UNPROVEN",
      "The deadline-bearing local migration CLI is not the leader of its outer owner's process group; no watchdog was started.",
    );
  }
  let watchdog;
  try {
    watchdog = spawn({
      cmd: [process.execPath, "-e", localOwnerWatchdogSource()],
      stdin: "inherit",
      stdout: "pipe",
      stderr: "ignore",
      detached: false,
      env: toolEnvironment,
    });
  } catch {
    fail("LOCAL_D1_OWNER_WATCHDOG_UNAVAILABLE", "The local owner watchdog could not start.");
  }

  let observed;
  try {
    observed = await readLocalOwnerWatchdogFrame(watchdog.stdout, handshakeMs);
  } catch {
    observed = { kind: "malformed" };
  }
  if (observed.kind !== "frame") {
    const reaped = await stopLocalOwnerWatchdog(watchdog);
    if (!reaped) {
      fail(
        "LOCAL_D1_OWNER_WATCHDOG_REAP_UNPROVEN",
        "The refused local owner watchdog did not settle after bounded TERM and KILL.",
      );
    }
    fail(
      observed.kind === "stuck"
        ? "LOCAL_D1_OWNER_LEASE_STUCK"
        : observed.kind === "dead"
          ? "LOCAL_D1_OWNER_LEASE_DEAD"
          : "LOCAL_D1_OWNER_LEASE_MALFORMED",
      "The local owner lease watchdog did not authenticate one canonical frame.",
    );
  }
  const refusal = new RegExp(
    `^${LOCAL_OWNER_REFUSAL_PREFIX} (ABSENT|REGULAR|TERMINAL|MALFORMED|DEAD|STUCK)\\n$`,
  ).exec(observed.text);
  if (refusal !== null) {
    const reaped = await stopLocalOwnerWatchdog(watchdog);
    if (!reaped) {
      fail(
        "LOCAL_D1_OWNER_WATCHDOG_REAP_UNPROVEN",
        "The refused local owner watchdog did not settle after bounded TERM and KILL.",
      );
    }
    const code = refusal[1];
    fail(
      `LOCAL_D1_OWNER_LEASE_${code}`,
      "The local owner lease watchdog refused fd0 before local work started.",
    );
  }
  const authenticated = new RegExp(
    `^${LOCAL_OWNER_WATCHDOG_PREFIX} ([0-9a-f]{64}) (0|[1-9][0-9]*)\\n$`,
  ).exec(observed.text);
  if (authenticated === null) {
    const reaped = await stopLocalOwnerWatchdog(watchdog);
    if (!reaped) {
      fail(
        "LOCAL_D1_OWNER_WATCHDOG_REAP_UNPROVEN",
        "The malformed local owner watchdog did not settle after bounded TERM and KILL.",
      );
    }
    fail(
      "LOCAL_D1_OWNER_LEASE_MALFORMED",
      "The local owner lease watchdog returned a malformed authentication frame.",
    );
  }
  const echoedDeadlineAtMs = Number(authenticated[2]);
  if (!Number.isSafeInteger(echoedDeadlineAtMs) || echoedDeadlineAtMs !== deadlineAtMs) {
    const reaped = await stopLocalOwnerWatchdog(watchdog);
    if (!reaped) {
      fail(
        "LOCAL_D1_OWNER_WATCHDOG_REAP_UNPROVEN",
        "The mismatched local owner watchdog did not settle after bounded TERM and KILL.",
      );
    }
    fail(
      "LOCAL_D1_OWNER_LEASE_MISMATCH",
      "The local owner lease watchdog did not echo the exact CLI deadline.",
    );
  }
  try {
    watchdog.unref();
  } catch {}
  const lease = Object.freeze({});
  authenticatedLocalOwnerLeases.add(lease);
  return lease;
}

function currentProcessLeadsOwnedGroup({
  pid = process.pid,
  platform = process.platform,
  signalGroup = process.kill,
} = {}) {
  if (platform === "win32") return false;
  try {
    signalGroup(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function ownedProcessGroupExists(
  child,
  { platform = process.platform, signalGroup = process.kill } = {},
) {
  if (platform === "win32") return false;
  try {
    signalGroup(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExistsOrAssumePresent(child, groupExists) {
  try {
    // Only an explicit false is absence authority. An injected or platform
    // census that throws, returns undefined, or otherwise cannot answer must
    // keep ownership live and force a bounded containment refusal.
    return groupExists(child) !== false;
  } catch {
    return true;
  }
}

async function groupGoneWithin(child, groupExists, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (processGroupExistsOrAssumePresent(child, groupExists)) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)));
  }
  return true;
}

async function terminateOwnedProcessGroup(
  child,
  pipes,
  pipeCancellation,
  signalGroup,
  groupExists,
  termGraceMs,
  killReapMs,
  directChildOnly,
) {
  signalGroup(child, "SIGTERM");
  let reaped;
  let directExit;
  if (directChildOnly) {
    // Windows has no POSIX process-group signal equivalent. Parent-owned mode
    // also signals only its direct child: signalling the current process group
    // would hit the outer CLI and make nested cleanup race its owner.
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
  const drained = await within(completeBoundedPipes(pipes, pipeCancellation), killReapMs);
  return { directExit, pipesDrained: drained.settled, reaped };
}

async function writeLocalOwnerLease(writer, frame, timeoutMs) {
  if (writer === null || writer === undefined) return false;
  try {
    const written = await within(
      (async () => {
        await writer.write(frame);
        await writer.flush();
        await writer.ref();
        return true;
      })(),
      timeoutMs,
    );
    return written.settled && written.value === true;
  } catch {
    return false;
  }
}

async function closeLocalOwnerLease(writer, timeoutMs) {
  if (writer === null || writer === undefined) return true;
  try {
    const closed = await within(Promise.resolve(writer.end()), timeoutMs);
    return closed.settled;
  } catch {
    return false;
  }
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
  signalChild = signalDirectChild,
  groupExists = ownedProcessGroupExists,
  platform = process.platform,
  ownershipMode = OWNED_PROCESS_GROUP,
  ownerLeaseDeadlineAtMs = undefined,
  ownerLeaseNonce = () => randomBytes(32).toString("hex"),
  signal = undefined,
  toolEnvironment = minimalLocalToolEnvironment(),
}) {
  if (ownershipMode !== OWNED_PROCESS_GROUP && ownershipMode !== PARENT_PROCESS_GROUP) {
    fail("COMMAND_OWNERSHIP_MODE_INVALID", "The bounded command ownership mode is invalid.");
  }
  const parentOwnsProcessGroup = ownershipMode === PARENT_PROCESS_GROUP;
  const directChildOnly = platform === "win32" || parentOwnsProcessGroup;
  const containmentScope = parentOwnsProcessGroup
    ? "parent-process-group/direct-child"
    : platform === "win32"
      ? "direct-child-only"
      : "process-group-only";
  const terminateSignal = parentOwnsProcessGroup ? signalChild : signalGroup;
  const ownerLeaseFrame =
    ownerLeaseDeadlineAtMs === undefined
      ? undefined
      : canonicalLocalOwnerLeaseFrame(ownerLeaseNonce(), ownerLeaseDeadlineAtMs);
  const abortedResult = () => ({
    containment_scope: containmentScope,
    outcome: "aborted",
    stderr: "",
    stdout: "",
  });
  if (signal?.aborted) return abortedResult();

  let resolveAbort;
  let abortListener;
  let aborted;
  if (signal !== undefined) {
    aborted = new Promise((resolve) => {
      resolveAbort = resolve;
    });
    abortListener = () => resolveAbort({ kind: "aborted" });
    signal.addEventListener("abort", abortListener, { once: true });
    // An abort between the first check and listener installation is still a
    // pre-spawn abort. Never create a child after observing it.
    if (signal.aborted) abortListener();
  }

  let deadlineTimer;
  let child;
  const commandDeadlineAt = performance.now() + timeoutMs;
  try {
    if (signal?.aborted) return abortedResult();
    try {
      child = spawn({
        cmd,
        cwd,
        stdin: ownerLeaseFrame === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: !parentOwnsProcessGroup,
        env: toolEnvironment,
      });
    } catch {
      return { outcome: "spawn-failed", stderr: "", stdout: "" };
    }

    const pipes = {
      stderr: captureBoundedPipe(child.stderr, stderrMaxBytes),
      stdout: captureBoundedPipe(child.stdout, stdoutMaxBytes),
    };
    const ownerLeaseWriter = ownerLeaseFrame === undefined ? undefined : child.stdin;
    let pipeCancellation;
    const cancelPipes = () => {
      if (pipeCancellation === undefined) {
        pipeCancellation = cancelBoundedPipes(pipes);
      }
      return pipeCancellation;
    };
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve({ kind: "timeout" }),
        Math.max(0, commandDeadlineAt - performance.now()),
      );
    });
    const ownerLeaseWritten =
      ownerLeaseFrame === undefined
        ? true
        : await writeLocalOwnerLease(
            ownerLeaseWriter,
            ownerLeaseFrame,
            Math.min(pipeDrainMs, Math.max(0, commandDeadlineAt - performance.now())),
          );
    let first = ownerLeaseWritten
      ? await Promise.race([
          child.exited.then((exitCode) => ({ kind: "exited", exitCode })),
          pipes.stdout.failure.then(() => ({ kind: "pipe-drain-unproven" })),
          pipes.stderr.failure.then(() => ({ kind: "pipe-drain-unproven" })),
          pipes.stdout.overrun.then(() => ({ kind: "output-overrun" })),
          pipes.stderr.overrun.then(() => ({ kind: "output-overrun" })),
          deadline,
          ...(aborted === undefined ? [] : [aborted]),
        ])
      : { kind: "owner-lease-write-unproven" };
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    const ownerLeaseClosed = await closeLocalOwnerLease(ownerLeaseWriter, pipeDrainMs);

    let outcome = "exited";
    let exitCode;
    if (first.kind === "exited") {
      exitCode = first.exitCode;
      const leaseRetirementExpected = ownerLeaseFrame !== undefined && !directChildOnly;
      let expectedLeaseRetirementFailed = false;
      if (leaseRetirementExpected) {
        // Closing fd0 tells the independently armed watchdog to TERM its group,
        // wait the same TERM grace counted by the cleanup reserve, and KILL it.
        // The scheduling margin is already part of that reserve; this wait
        // consumes the existing first cleanup window rather than adding one.
        const retired = await groupGoneWithin(
          child,
          groupExists,
          termGraceMs + REMOTE_D1_SCHEDULING_MARGIN_MS,
        );
        if (!retired) {
          expectedLeaseRetirementFailed = true;
          const cancellation = cancelPipes();
          // The watchdog has already had its full TERM grace. Re-signal TERM for
          // deterministic polarity, then escalate immediately so the fallback
          // does not allocate a second uncounted grace window.
          await terminateOwnedProcessGroup(
            child,
            pipes,
            cancellation,
            terminateSignal,
            groupExists,
            0,
            killReapMs,
            false,
          );
          outcome = "owner-lease-retirement-unproven";
        }
      }
      if (!expectedLeaseRetirementFailed) {
        const pipeObservation = await observeBoundedPipesOrAbort(
          pipes,
          pipeCancellation,
          pipeDrainMs,
          aborted,
        );
        if (pipeObservation.kind === "aborted") {
          first = pipeObservation;
        } else {
          const drained = pipeObservation.result;
          // This can observe only the owned process group. It cannot establish that
          // a grandchild which called setsid() has exited; in particular, a later
          // pipe close is not proof about that escaped process.
          const processGroupMemberRemains =
            directChildOnly || leaseRetirementExpected
              ? false
              : processGroupExistsOrAssumePresent(child, groupExists);
          if (!drained.settled || processGroupMemberRemains) {
            const cancellation = cancelPipes();
            const termination = await terminateOwnedProcessGroup(
              child,
              pipes,
              cancellation,
              terminateSignal,
              groupExists,
              termGraceMs,
              killReapMs,
              directChildOnly,
            );
            if (!termination.reaped) {
              outcome = directChildOnly ? "direct-child-reap-unproven" : "process-reap-unproven";
            } else if (!termination.pipesDrained) outcome = "pipe-drain-unproven";
            else if (processGroupMemberRemains) outcome = "process-group-survivor-observed";
            else outcome = "pipe-drain-unproven";
          }
        }
      }
    }
    // `first` can change from an initial direct-child exit to an abort while
    // the inherited pipes are still draining. That abort has the same owned
    // process-group cleanup obligation as every other non-exit trigger.
    if (first.kind !== "exited") {
      const cancellation = cancelPipes();
      const termination = await terminateOwnedProcessGroup(
        child,
        pipes,
        cancellation,
        terminateSignal,
        groupExists,
        termGraceMs,
        killReapMs,
        directChildOnly,
      );
      if (!termination.reaped) {
        outcome = directChildOnly ? "direct-child-reap-unproven" : "process-reap-unproven";
      } else if (!termination.pipesDrained) outcome = "pipe-drain-unproven";
      else outcome = first.kind;
      if (termination.directExit?.settled) exitCode = termination.directExit.value;
      else if (!directChildOnly) {
        const exited = await within(child.exited, killReapMs);
        if (exited.settled) exitCode = exited.value;
      }
    }

    if (!ownerLeaseClosed) outcome = "owner-lease-close-unproven";

    const settledPipes = await within(completeBoundedPipes(pipes, pipeCancellation), pipeDrainMs);
    if (!settledPipes.settled) {
      if (outcome === "exited") outcome = "pipe-drain-unproven";
      // The bounded observation above establishes only that the drains were not
      // timely. Cancellation is then given its own bounded window rather than an
      // unbounded await: a stream that never honours `cancel()` must not be able
      // to withhold the receipt forever, because a command that never answers is
      // worse than one that answers `pipe-drain-unproven`. The outcome here is
      // already an unproven one, so nothing below claims cleanup was observed.
      // Cancelling a standards stream frees its pending reads at initiation, so
      // the locks are already released by the drain finalizers by this point;
      // what the bound gives up on is the source hook's promise, not a handle.
      await settleBoundedPipeCleanup(pipes, cancelPipes(), pipeDrainMs);
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
    // Same bound on the non-exit path: the drains settled, but cancellation is
    // still a promise that a hostile stream can park forever.
    else if (!(await settleBoundedPipeCleanup(pipes, cancelPipes(), pipeDrainMs))) {
      if (outcome === "exited") outcome = "pipe-drain-unproven";
    }
    return {
      containment_scope: containmentScope,
      exitCode,
      outcome,
      stderr: stderr.text,
      stdout: stdout.text,
    };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

/**
 * Run a local D1 command through Wrangler.
 *
 * `--local` only. This function never accepts a `--remote` flag and never reads
 * a credential; a remote application is refused earlier, by the caller.
 */
export function localD1ExecutionWindowOrRefuse(deadlineAtMs, observedAtMs = Date.now()) {
  if (deadlineAtMs === undefined) return LOCAL_D1_COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(deadlineAtMs) || !Number.isSafeInteger(observedAtMs)) {
    fail(
      "LOCAL_D1_ORCHESTRATION_DEADLINE_INVALID",
      "The local D1 orchestration deadline must be an absolute safe-integer epoch millisecond.",
    );
  }
  const remainingMs = Math.max(0, deadlineAtMs - observedAtMs);
  const executionWindowMs = Math.max(0, remainingMs - LOCAL_D1_CLEANUP_RESERVE_MS);
  if (executionWindowMs < LOCAL_D1_EXECUTION_FLOOR_MS) {
    fail(
      "LOCAL_D1_ORCHESTRATION_BUDGET_EXHAUSTED",
      `The local D1 orchestration budget left ${remainingMs}ms total, providing ${executionWindowMs}ms for execution after its ${LOCAL_D1_CLEANUP_RESERVE_MS}ms cleanup reserve, below the ${LOCAL_D1_EXECUTION_FLOOR_MS}ms execution floor; no command was started.`,
    );
  }
  return Math.min(LOCAL_D1_COMMAND_TIMEOUT_MS, executionWindowMs);
}

/** The one local-D1 pre-spawn seam, shared by production and causal plants. */
export async function runLocalD1Command(
  command,
  {
    deadlineAtMs,
    observedAtMs,
    ownerLease,
    runner = runBoundedCommand,
    processLeadsOwnedGroup = currentProcessLeadsOwnedGroup,
  } = {},
) {
  const timeoutMs = localD1ExecutionWindowOrRefuse(deadlineAtMs, observedAtMs);
  const ownershipMode = deadlineAtMs === undefined ? OWNED_PROCESS_GROUP : PARENT_PROCESS_GROUP;
  if (ownershipMode === PARENT_PROCESS_GROUP && !authenticatedLocalOwnerLeases.has(ownerLease)) {
    fail(
      "LOCAL_D1_OWNER_LEASE_UNAUTHENTICATED",
      "The deadline-bearing local migration CLI has no authenticated fd0 owner lease; no command was started.",
    );
  }
  if (ownershipMode === PARENT_PROCESS_GROUP && !processLeadsOwnedGroup()) {
    fail(
      "LOCAL_D1_PARENT_PROCESS_GROUP_UNPROVEN",
      "The deadline-bearing local migration CLI is not the leader of its outer owner's process group; no command was started.",
    );
  }
  return await runner({ ...command, ownershipMode, timeoutMs });
}

export async function localD1(
  root,
  databaseName,
  args,
  localPersistTo = undefined,
  localDeadlineAtMs = undefined,
  localOwnerLease = undefined,
) {
  const result = await runLocalD1Command(
    {
      cmd: [
        ...resolvePinnedWranglerCommand(root),
        "d1",
        "execute",
        databaseName,
        "--local",
        "--config",
        "infra/wrangler.toml",
        ...(localPersistTo === undefined ? [] : ["--persist-to", localPersistTo]),
        "--json",
        ...args,
      ],
      cwd: root,
    },
    { deadlineAtMs: localDeadlineAtMs, ownerLease: localOwnerLease },
  );
  return localD1StdoutOrRefuse(result);
}

/**
 * Accept one local D1 result only when execution and containment both proved
 * the exact success pair. A zero process exit cannot upgrade an explicitly
 * unproven cleanup outcome into a usable migration response.
 */
export function localD1StdoutOrRefuse(result) {
  let refusal;
  switch (result.outcome) {
    case "timeout":
      refusal = ["LOCAL_D1_COMMAND_TIMEOUT", "A local D1 command exceeded its fixed deadline."];
      break;
    case "output-overrun":
      refusal = ["LOCAL_D1_OUTPUT_OVERRUN", "A local D1 command exceeded its fixed output limit."];
      break;
    case "pipe-drain-unproven":
      refusal = [
        "LOCAL_D1_PIPE_DRAIN_UNPROVEN",
        "A local D1 command did not close its pipes after exit.",
      ];
      break;
    case "process-reap-unproven":
      refusal = [
        "LOCAL_D1_PROCESS_REAP_UNPROVEN",
        "A local D1 process group could not be reaped safely.",
      ];
      break;
    case "direct-child-reap-unproven":
      refusal = [
        "LOCAL_D1_DIRECT_CHILD_REAP_UNPROVEN",
        "A local D1 direct child could not be reaped safely.",
      ];
      break;
    case "process-group-survivor-observed":
      refusal = [
        "LOCAL_D1_PROCESS_GROUP_SURVIVOR",
        "A local D1 command left a process-group member after its direct child exited.",
      ];
      break;
    case "aborted":
      refusal = [
        "LOCAL_D1_COMMAND_ABORTED",
        "A local D1 command was aborted before a contained result was available.",
      ];
      break;
    case "owner-lease-write-unproven":
      refusal = [
        "LOCAL_D1_OWNER_LEASE_WRITE_UNPROVEN",
        "The local D1 owner lease could not be delivered before execution.",
      ];
      break;
    case "owner-lease-close-unproven":
      refusal = [
        "LOCAL_D1_OWNER_LEASE_CLOSE_UNPROVEN",
        "The local D1 owner lease did not close within its bounded window.",
      ];
      break;
    case "owner-lease-retirement-unproven":
      refusal = [
        "LOCAL_D1_OWNER_LEASE_RETIREMENT_UNPROVEN",
        "The local D1 owner watchdog did not retire its process group before receipt.",
      ];
      break;
  }
  if (refusal !== undefined) fail(refusal[0], refusal[1]);

  if (result.outcome !== "exited" && result.outcome !== "spawn-failed") {
    fail(
      "LOCAL_D1_COMMAND_OUTCOME_UNRECOGNIZED",
      "A local D1 command returned an unrecognized containment outcome.",
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
async function readLocalCatalog(
  root,
  databaseName,
  localPersistTo = undefined,
  localDeadlineAtMs = undefined,
  localOwnerLease = undefined,
) {
  const rows = parseLocalD1Rows(
    await localD1(
      root,
      databaseName,
      [
        "--command",
        `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT ${MAX_CATALOG_ROWS + 1};`,
      ],
      localPersistTo,
      localDeadlineAtMs,
      localOwnerLease,
    ),
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
  localPersistTo = undefined,
  localDeadlineAtMs = undefined,
  localOwnerLease = undefined,
) {
  if (!catalog.some((entry) => entry.type === "table" && entry.name === table)) return [];
  return assertReadLimit(
    parseLocalD1Rows(
      await localD1(
        root,
        databaseName,
        ["--command", `SELECT ${columns} FROM ${table} ORDER BY 1 LIMIT ${maximum + 1};`],
        localPersistTo,
        localDeadlineAtMs,
        localOwnerLease,
      ),
      "LOCAL_D1_CATALOG_UNREADABLE",
    ),
    maximum,
    overrunCode,
  );
}

async function readLocalLineageSnapshot(
  root,
  databaseName,
  localPersistTo = undefined,
  localDeadlineAtMs = undefined,
  localOwnerLease = undefined,
) {
  const catalog = await readLocalCatalog(
    root,
    databaseName,
    localPersistTo,
    localDeadlineAtMs,
    localOwnerLease,
  );
  const journal = (
    await readOptionalLocalRows(
      root,
      databaseName,
      catalog,
      LEDGER_TABLE,
      "id, sequence, digest",
      MAX_JOURNAL_ROWS,
      "LOCAL_D1_JOURNAL_OVERRUN",
      localPersistTo,
      localDeadlineAtMs,
      localOwnerLease,
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
      localPersistTo,
      localDeadlineAtMs,
      localOwnerLease,
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

/**
 * Remote D1 metadata observation (bead asimposiumorg-doa, staging slice 1).
 *
 * `readLocalLineageSnapshot` above needs no credential, because Wrangler's local
 * D1 is workerd's own SQLite. A remote target has neither that property nor a
 * local fallback, so this reader takes an explicit transport. The CLI later
 * constructs the one default transport only for a resolved staging artifact;
 * direct callers without a transport get a typed refusal, never a silent
 * downgrade to local.
 *
 * Scope here is deliberately observation only. The separately capability-gated
 * remote apply seam below is the only writer and cites the D1 query-transaction
 * contract it relies on; bootstrap remains local-only.
 */

/**
 * The transport contract, validated before use.
 *
 * `describeTarget({signal})` returns provider-supplied database identity. A
 * `query({sql, database_id, signal})` runs one read against the named target
 * and returns the transport's immutable request-target assertion alongside its
 * rows. D1 query responses do not contain a database UUID, so this field is not
 * mislabelled as a provider echo; the default transport binds it by captured
 * account + UUID command operands before Wrangler starts.
 *
 * The methods must be **own data properties**. `typeof transport.query` also
 * accepts an inherited method or an accessor, and an accessor can hand a
 * different function to the check than to the call.
 */
/**
 * Module-private provenance for transports whose settlement this file guarantees.
 *
 * A public `ownsBoundedCommand` property was FORGEABLE: any caller could set it,
 * and the observation runner reads this to decide whether to await a command's
 * cleanup unconditionally instead of bounding it. A forged marker therefore
 * bought an unbounded await for a transport nothing had promised would settle —
 * a hang, granted by a value the hanging party supplied.
 *
 * A `WeakSet` cannot be forged, enumerated, or reached from outside this module.
 * Membership is added at exactly one place — the factory below, and only when it
 * is using this module's own `runBoundedCommand`, whose TERM/KILL/reap/drain
 * bounds are what make the await terminate. An injected runner never receives
 * the privilege, because this file cannot promise anything about a function it
 * did not write. Such a transport keeps the bounded, spawn-free treatment and a
 * non-settling one is refused rather than waited on.
 */
const SETTLEMENT_GUARANTEED_TRANSPORTS = new WeakSet();

function transportOwnsBoundedCommand(transport) {
  return (
    typeof transport === "object" &&
    transport !== null &&
    !Array.isArray(transport) &&
    SETTLEMENT_GUARANTEED_TRANSPORTS.has(transport)
  );
}

function assertRemoteTransport(transport) {
  assertRemotePlainObject(transport, "REMOTE_TRANSPORT_UNAVAILABLE");
  for (const method of ["describeTarget", "query"]) {
    if (typeof ownDataValue(transport, method, "REMOTE_TRANSPORT_UNAVAILABLE") !== "function") {
      fail(
        "REMOTE_TRANSPORT_UNAVAILABLE",
        "A remote D1 observation requires an explicit transport exposing describeTarget and query as own methods; this runner never opens one itself.",
      );
    }
  }
}

/** One deadline covers describe plus every query, measured monotonically. */
export const REMOTE_OBSERVATION_DEADLINE_MS = 15_000;
/** Any single string a remote target may return. Generous enough for DDL. */
export const MAX_REMOTE_STRING_BYTES = 8_192;
/** The bootstrap install batch is an upload; bound it well past the current artifact. */
export const REMOTE_BOOTSTRAP_SQL_MAX_BYTES = 512 * 1024;
/** Every string across one whole observation, summed. */
export const MAX_REMOTE_RESPONSE_BYTES = 256 * 1024;

function createRemoteBudget(deadlineMs = REMOTE_OBSERVATION_DEADLINE_MS) {
  // Clamped to the fixed ceiling, so a caller-supplied value can only ever be
  // stricter. Monotonic, not wall-clock: a clock step must not extend or
  // collapse the deadline, and `Date.now()` would let it do both.
  const bounded =
    typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && deadlineMs > 0
      ? Math.min(deadlineMs, REMOTE_OBSERVATION_DEADLINE_MS)
      : REMOTE_OBSERVATION_DEADLINE_MS;
  return { deadlineAt: performance.now() + bounded, bytes: 0 };
}

function assertRemotePlainObject(record, code) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    fail(code, "A remote response must be a plain object.");
  }
}

/**
 * Read one property that must be present, **own**, and a plain data property.
 *
 * `in` and ordinary member access both consult the prototype chain, so a
 * response inheriting `database_id` from a polluted `Object.prototype` would
 * satisfy either. An accessor is refused for a second and sharper reason: a
 * getter can return one value to the identity check and another to the row
 * reader, which is the exact split-brain this reader exists to close.
 */
function ownDataValue(record, key, code) {
  assertRemotePlainObject(record, code);
  if (!Object.hasOwn(record, key)) {
    fail(code, "A remote response is missing a required own property.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    typeof descriptor.get === "function" ||
    typeof descriptor.set === "function"
  ) {
    fail(code, "A remote response property must be a data property, not an accessor.");
  }
  return descriptor.value;
}

/**
 * The response carries these keys and nothing else.
 *
 * `Object.getOwnPropertyNames` rather than `Object.keys`, so a non-enumerable
 * own property cannot ride along unseen, and symbols are refused outright.
 */
function assertExactOwnKeys(record, allowed, code) {
  assertRemotePlainObject(record, code);
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== allowed.length || Object.getOwnPropertySymbols(record).length !== 0) {
    fail(code, "A remote response carried an unexpected key set.");
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) {
      fail(code, "A remote response carried an unexpected key set.");
    }
  }
}

/** Charge one string against both the per-field and whole-observation bounds. */
function chargeRemoteBytes(budget, text, code) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_REMOTE_STRING_BYTES) {
    fail(code, "A remote response string exceeded its fixed size limit.");
  }
  budget.bytes += bytes;
  if (budget.bytes > MAX_REMOTE_RESPONSE_BYTES) {
    fail(code, "A remote observation exceeded its fixed total response size.");
  }
  return text;
}

function ownBoundedString(record, key, budget, code) {
  const value = ownDataValue(record, key, code);
  if (typeof value !== "string") fail(code, "A remote response field must be a string.");
  return chargeRemoteBytes(budget, value, code);
}

function ownNullableBoundedString(record, key, budget, code) {
  const value = ownDataValue(record, key, code);
  if (value === null) return null;
  if (typeof value !== "string") fail(code, "A remote response field must be a string or null.");
  return chargeRemoteBytes(budget, value, code);
}

function ownSafeInteger(record, key, code) {
  const value = ownDataValue(record, key, code);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(code, "A remote response field must be a safe integer.");
  }
  return value;
}

function assertRemoteReadLimit(rows, maximum, code) {
  if (rows.length > maximum) {
    fail(code, "A remote D1 metadata read exceeded its fixed safety limit.");
  }
  return rows;
}

/**
 * Allocate one call's remaining monotonic budget between execution and cleanup.
 *
 * This tiny pure seam is exported so the exact arithmetic is testable without
 * turning a 250 ms scheduling margin into a flaky subprocess timing oracle.
 * The runtime below consumes this result directly. A transport backed by this
 * module's owned runner withholds the entire composed cleanup reserve; an
 * injected transport owns no process and receives only a bounded half-window.
 */
export function remoteExecutionAllocation(remainingMs, ownsBoundedCommand) {
  if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs) || remainingMs < 0) {
    throw new TypeError("remainingMs must be a finite non-negative number");
  }
  const containmentReserveMs = ownsBoundedCommand
    ? REMOTE_D1_CLEANUP_RESERVE_MS
    : Math.min(REMOTE_D1_CLEANUP_RESERVE_MS, Math.floor(remainingMs / 2));
  return {
    containmentReserveMs,
    executionMs: Math.max(0, remainingMs - containmentReserveMs),
  };
}

/**
 * Bound one transport call in time, and flatten whatever it throws.
 *
 * A never-settling call is the failure mode a row cap cannot reach, so the
 * deadline is enforced here rather than trusted to the transport. A default
 * Wrangler child receives the execution share of that deadline, leaving the
 * containment reserve for its TERM/KILL/group/pipe proof. On expiry the runner
 * aborts, then waits only through the already-reserved remainder. It never
 * emits a deadline receipt while the owned child is still reaping; a transport
 * that cannot settle within that remainder is a typed reap-unproven refusal.
 *
 * The caught value is discarded deliberately. A transport failure is data from
 * outside this process and may carry a provider message, a credential, or an
 * absolute path; replacing it with a fixed code is the only way to guarantee
 * none of that reaches a diagnostic.
 */
async function awaitBoundedRemote(budget, invoke, code, { ownsBoundedCommand = false } = {}) {
  if (performance.now() >= budget.deadlineAt) {
    fail(
      "REMOTE_OBSERVATION_DEADLINE_EXCEEDED",
      "The remote observation exceeded its fixed deadline.",
    );
  }
  const remaining = Math.max(0, budget.deadlineAt - performance.now());
  // Refuse BEFORE the transport is entered, so no owned child is ever spawned
  // into a window that cannot also hold its cleanup. This is checked against the
  // one absolute deadline every call on this budget shares, which is what makes
  // a late call safe: earlier describes and queries have already spent part of
  // it, and the remainder — not a fresh fraction of it — is what is available.
  if (ownsBoundedCommand && remaining < REMOTE_D1_COMMAND_WINDOW_MS) {
    fail(
      "REMOTE_D1_COMMAND_WINDOW_EXHAUSTED",
      "The remote observation has too little of its deadline left to start and contain another command.",
    );
  }
  const controller = new AbortController();
  // A command-backed call is guaranteed the full cleanup tail — composed windows
  // AND the scheduling margin — by the refusal above, so the margin is withheld
  // from execution rather than left for it to spend. A pure injected transport
  // may still be observed inside a deliberately tiny budget: split that evenly,
  // because it spawns nothing and its failure to settle costs no OS resource.
  const allocation = remoteExecutionAllocation(remaining, ownsBoundedCommand);
  const containmentReserve = allocation.containmentReserveMs;
  const executionDeadlineAt = budget.deadlineAt - containmentReserve;
  let executionTimer;
  let containmentTimer;
  const timerResult = (deadlineAt, kind) =>
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ kind }),
        Math.max(0, deadlineAt - performance.now()),
      );
      timer.unref?.();
      if (kind === "execution-deadline") executionTimer = timer;
      else containmentTimer = timer;
    });
  const preserveContainmentRefusal = (error) =>
    error instanceof MigrationError &&
    [
      "REMOTE_D1_TRANSPORT_TIMEOUT",
      "REMOTE_D1_TRANSPORT_ABORTED",
      "REMOTE_D1_TRANSPORT_OUTPUT_OVERRUN",
      "REMOTE_D1_TRANSPORT_REAP_UNPROVEN",
      // The in-callback window recheck rejects before the transport is entered.
      // It must reach the caller as itself: flattening it into the generic
      // "did not complete" code would hide a refusal that spawned nothing.
      "REMOTE_D1_COMMAND_WINDOW_EXHAUSTED",
    ].includes(error.code);
  // Set exactly when the command promise settles, so every classification below
  // can be proven to happen after settlement rather than merely intended to.
  let commandSettled = false;
  try {
    // Set the timer before calling the transport. A synchronously hostile test
    // double still cannot be pre-empted by JavaScript, but it cannot delay timer
    // creation until after it has been entered either.
    const settled = Promise.resolve()
      .then(() => {
        // The precheck above and this callback are separated by a microtask
        // checkpoint, and the engine drains the whole microtask queue — running
        // each job to completion — before any timer fires. An already-queued job
        // can therefore burn the window AFTER the precheck passed, and neither
        // the abort controller (whose timer is a macrotask) nor
        // `runBoundedCommand` (which has no zero-timeout guard) would stop the
        // spawn. Re-checking here is what makes the guarantee atomic with
        // respect to entering the transport: this is the last instruction before
        // it, so nothing can intervene between the check and the call.
        if (ownsBoundedCommand) {
          const beforeInvoke = Math.max(0, budget.deadlineAt - performance.now());
          if (beforeInvoke < REMOTE_D1_COMMAND_WINDOW_MS) {
            fail(
              "REMOTE_D1_COMMAND_WINDOW_EXHAUSTED",
              "The remote observation lost its command window before the transport was entered.",
            );
          }
        }
        return invoke(controller.signal, Math.max(0, executionDeadlineAt - performance.now()));
      })
      .then(
        (value) => {
          commandSettled = true;
          return { kind: "settled", value };
        },
        (error) => {
          commandSettled = true;
          return { kind: "rejected", error };
        },
      );
    const first = await Promise.race([
      settled,
      timerResult(executionDeadlineAt, "execution-deadline"),
    ]);
    if (first.kind === "settled") return first.value;
    if (first.kind === "rejected") {
      if (preserveContainmentRefusal(first.error)) throw first.error;
      fail(code, "A remote D1 metadata call did not complete.");
    }

    // The execution share expired. Do not abandon the losing command promise:
    // the reserved part of this exact monotonic deadline is for its containment
    // result. `runBoundedCommand` returns `aborted` only after bounded cleanup,
    // and `process-reap-unproven` is preserved below.
    controller.abort();
    // AN OWNED COMMAND IS AWAITED, NEVER RACED.
    //
    // Racing the reserve against a real `runBoundedCommand` let the timer win
    // while that command's cleanup promise was still pending: this function then
    // returned `SETTLEMENT_UNPROVEN` — itself a statement ABOUT cleanup — while
    // the child was still being signalled and reaped. That is the exact defect
    // this composition exists to remove, and a bound cannot remove it, because
    // the only thing a deadline can do once a child is running is stop
    // OBSERVING the cleanup. It cannot stop the cleanup, and a receipt written
    // while a child is still being reaped is a claim this process has not
    // earned.
    //
    // Awaiting is bounded by construction rather than by a second timer. The
    // pre-entry `REMOTE_D1_COMMAND_WINDOW_MS` refusal admits a command only when
    // the whole composed cleanup tail still remains on the one monotonic
    // deadline, and `runBoundedCommand` owns its own TERM grace, KILL, reap and
    // pipe-drain bounds, so it always settles. If it ever did not, hanging here
    // is still the honest outcome: this call would be waiting on a child it
    // genuinely owns, rather than reporting a containment result it never saw.
    //
    // An injected transport owns no child and no OS resource, so a double that
    // never settles is bounded by the reserve and reported as unproven below.
    const containment = ownsBoundedCommand
      ? await settled
      : await Promise.race([settled, timerResult(budget.deadlineAt, "containment-deadline")]);
    if (containment.kind === "containment-deadline") {
      // Unreachable for an owned command by the branch above; this is the
      // injected-transport path only. Such a call has observed nothing about
      // cleanup, so it refuses with a code that says exactly that instead of
      // borrowing a reap classification that was never made: a bounded refusal
      // is honest, a fabricated containment claim is not.
      fail(
        "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN",
        "The staging D1 transport did not settle within its reserved containment window.",
      );
    }
    if (!commandSettled) {
      // Defensive: every branch below classifies a settled command. If this ever
      // trips, the race above admitted a receipt while the command was still
      // running, which is the exact defect this reserve exists to prevent.
      fail(
        "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN",
        "The staging D1 transport was classified before it settled.",
      );
    }
    if (containment.kind === "settled") {
      // A successful value after abort has no evidence that a generic injected
      // transport contained anything. The default runner instead rejects with
      // one of the typed outcomes handled below after its owned child is reaped.
      fail(
        "REMOTE_D1_TRANSPORT_REAP_UNPROVEN",
        "The staging D1 transport could not prove cleanup before the observation deadline.",
      );
    }
    if (containment.kind === "rejected") {
      if (containment.error instanceof MigrationError) {
        if (containment.error.code === "REMOTE_D1_TRANSPORT_REAP_UNPROVEN") {
          throw containment.error;
        }
        if (
          containment.error.code === "REMOTE_D1_TRANSPORT_ABORTED" ||
          containment.error.code === "REMOTE_D1_TRANSPORT_TIMEOUT"
        ) {
          fail(
            "REMOTE_OBSERVATION_DEADLINE_EXCEEDED",
            "The remote observation exceeded its fixed deadline after bounded transport cleanup.",
          );
        }
      }
      fail(
        "REMOTE_D1_TRANSPORT_REAP_UNPROVEN",
        "The staging D1 transport did not prove cleanup before the observation deadline.",
      );
    }
    // Every `containment.kind` is handled above. This is an exhaustiveness guard,
    // not a cleanup observation, so it must not borrow the reap wording: saying
    // "did not prove cleanup" here would report a containment result for a state
    // in which none was ever computed.
    fail(
      "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN",
      "The staging D1 transport produced an unhandled containment state.",
    );
  } finally {
    clearTimeout(executionTimer);
    clearTimeout(containmentTimer);
  }
}

/**
 * Every statement this reader is permitted to emit.
 *
 * Enforcing read-only by inspecting statements at the test boundary would only
 * describe the ones a test happened to look at. Refusing here makes it
 * structural: a write cannot reach the transport at all. Stacked statements are
 * refused for the same reason one `SELECT` is allowed — `SELECT 1; DROP TABLE x`
 * is not a read, and a reader that accepted it would be read-only in name only.
 */
export function assertReadOnlySql(sql) {
  const trimmed = typeof sql === "string" ? sql.trim() : "";
  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed;
  if (body === "" || body.includes(";") || !/^SELECT\s/i.test(body)) {
    fail(
      "REMOTE_READ_NOT_READ_ONLY",
      "A remote observation may emit exactly one SELECT statement.",
    );
  }
  return sql;
}

/**
 * Canonical D1 identifier shape.
 *
 * Deliberately not imported from `resolve-wrangler-deploy.mjs`: that module
 * loads a platform `openat` binding at import time for its publication path, and
 * a metadata reader must not drag an FFI dependency into the migration runner to
 * borrow one regular expression.
 */
const REMOTE_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REMOTE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/**
 * Bind the database that answered to the one deploy resolution chose, before a
 * single row is trusted.
 *
 * The topology carries `${ASIMP_D1_DATABASE_ID_STAGING}` — a placeholder, not an
 * identity — so the declared id can never be the value compared. The resolved id
 * comes from the caller that performed deploy resolution; the observed id comes
 * from the database that actually responded. Name alone is not enough: two
 * accounts can each hold an `asimposium-staging`, and the wrong-account case is
 * precisely what this exists to catch.
 */
export function assertResolvedDatabaseId(resolvedDatabaseId) {
  // Its own function and its own call site, ahead of every injected method. An
  // earlier revision passed `await transport.describeTarget()` as an *argument*
  // to the identity check, so the transport ran first and an unresolved caller
  // still reached the network: the check was correct and simply arrived after
  // the thing it was meant to prevent.
  if (typeof resolvedDatabaseId !== "string" || !REMOTE_DATABASE_ID.test(resolvedDatabaseId)) {
    fail(
      "REMOTE_TARGET_ID_UNRESOLVED",
      "A remote observation requires the resolved D1 database id; the topology placeholder is not an identity.",
    );
  }
  return resolvedDatabaseId;
}

export function assertRemoteTargetIdentity(
  environment,
  observed,
  resolvedDatabaseId,
  budget = createRemoteBudget(),
) {
  assertResolvedDatabaseId(resolvedDatabaseId);
  assertExactOwnKeys(observed, ["database_id", "database_name"], "REMOTE_TARGET_UNDESCRIBED");
  const databaseId = ownBoundedString(observed, "database_id", budget, "REMOTE_TARGET_UNDESCRIBED");
  const databaseName = ownBoundedString(
    observed,
    "database_name",
    budget,
    "REMOTE_TARGET_UNDESCRIBED",
  );
  if (databaseId !== resolvedDatabaseId) {
    fail(
      "REMOTE_TARGET_IDENTITY_MISMATCH",
      "The database that answered is not the resolved deploy target.",
    );
  }
  if (databaseName !== environment.d1.database_name) {
    fail(
      "REMOTE_TARGET_IDENTITY_MISMATCH",
      "The database that answered does not carry the declared topology database name.",
    );
  }
  return { database_id: databaseId, database_name: databaseName };
}

/**
 * One bounded read, bound to the resolved identity in both directions.
 *
 * Checking `describeTarget()` once and then letting an independent query choose
 * its own target is split-brain. The resolved id therefore travels *into* every
 * request and is required back as the transport's own immutable request-target
 * assertion. This confirms the default seam did not lose its captured operand;
 * provider identity itself is established by the separate D1-info response.
 */
async function readRemoteRows(transport, budget, sql, resolvedDatabaseId, unreadableCode) {
  // Outside the bounded call on purpose: a read-only violation is this runner's
  // own defect and must surface as itself, not be flattened into a transport
  // failure code.
  const statement = assertReadOnlySql(sql);
  const response = await awaitBoundedRemote(
    budget,
    (signal, timeoutMs) =>
      transport.query({ sql: statement, database_id: resolvedDatabaseId, signal, timeoutMs }),
    unreadableCode,
    { ownsBoundedCommand: transportOwnsBoundedCommand(transport) },
  );
  assertExactOwnKeys(response, ["database_id", "rows"], unreadableCode);
  if (ownBoundedString(response, "database_id", budget, unreadableCode) !== resolvedDatabaseId) {
    fail(
      "REMOTE_TARGET_IDENTITY_MISMATCH",
      "A remote result was not issued with the resolved target identity.",
    );
  }
  const rows = ownDataValue(response, "rows", unreadableCode);
  if (!Array.isArray(rows)) fail(unreadableCode, "Remote D1 did not return a result array.");
  return rows;
}

async function readOptionalRemoteRows(
  transport,
  budget,
  catalog,
  table,
  columns,
  maximum,
  resolvedDatabaseId,
  unreadableCode,
  overrunCode,
) {
  if (!catalog.some((entry) => entry.type === "table" && entry.name === table)) return [];
  return assertRemoteReadLimit(
    await readRemoteRows(
      transport,
      budget,
      `SELECT ${columns} FROM ${table} ORDER BY 1 LIMIT ${maximum + 1};`,
      resolvedDatabaseId,
      unreadableCode,
    ),
    maximum,
    overrunCode,
  );
}

/**
 * The remote counterpart of `readLocalLineageSnapshot`.
 *
 * `catalog`, `journal` and `lineage` are shape-identical to the local reader's,
 * so `classifySchemaLineage` consumes either without knowing which target it
 * came from — the classification rules stay one implementation. `target` is
 * additive and carries the proven identity for a receipt; the classifier
 * ignores it.
 */
export async function readRemoteLineageSnapshotOrRefuse(
  environment,
  transport,
  resolvedDatabaseId,
  // Clamped, never loosened: a caller may tighten the deadline but cannot
  // disable or extend it. The option exists so a never-settling transport can be
  // proven bounded in milliseconds instead of asserted in a comment; omitting it
  // yields the fixed default.
  { deadlineMs = REMOTE_OBSERVATION_DEADLINE_MS } = {},
) {
  if (environment.kind === "local") {
    fail(
      "REMOTE_READER_WRONG_TARGET",
      "A local environment has a credential-free reader of its own; the remote reader must not stand in for it.",
    );
  }
  // Local validation first, and in this order: neither line below may run
  // before the resolved id is known good, or an unresolved caller still reaches
  // an injected method. `assertRemoteTransport` inspects shape only.
  const targetId = assertResolvedDatabaseId(resolvedDatabaseId);
  assertRemoteTransport(transport);

  const budget = createRemoteBudget(deadlineMs);
  const target = assertRemoteTargetIdentity(
    environment,
    await awaitBoundedRemote(
      budget,
      (signal, timeoutMs) => transport.describeTarget({ signal, timeoutMs }),
      "REMOTE_TARGET_UNDESCRIBED",
      { ownsBoundedCommand: transportOwnsBoundedCommand(transport) },
    ),
    targetId,
    budget,
  );

  const catalog = assertRemoteReadLimit(
    await readRemoteRows(
      transport,
      budget,
      `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT ${MAX_CATALOG_ROWS + 1};`,
      targetId,
      "REMOTE_D1_CATALOG_UNREADABLE",
    ),
    MAX_CATALOG_ROWS,
    "REMOTE_D1_CATALOG_OVERRUN",
  ).map((row) => {
    // `String(row.type)` accepted an inherited value, an accessor, and an object
    // with a hostile `toString`. Each field is now an own data property of a
    // declared primitive type, against an exact key set.
    assertExactOwnKeys(row, ["type", "name", "tbl_name", "sql"], "REMOTE_D1_CATALOG_UNREADABLE");
    return {
      type: ownBoundedString(row, "type", budget, "REMOTE_D1_CATALOG_UNREADABLE"),
      name: ownBoundedString(row, "name", budget, "REMOTE_D1_CATALOG_UNREADABLE"),
      table: ownBoundedString(row, "tbl_name", budget, "REMOTE_D1_CATALOG_UNREADABLE"),
      sql: ownNullableBoundedString(row, "sql", budget, "REMOTE_D1_CATALOG_UNREADABLE"),
    };
  });

  const journal = (
    await readOptionalRemoteRows(
      transport,
      budget,
      catalog,
      LEDGER_TABLE,
      "id, sequence, digest",
      MAX_JOURNAL_ROWS,
      targetId,
      "REMOTE_D1_JOURNAL_UNREADABLE",
      "REMOTE_D1_JOURNAL_OVERRUN",
    )
  ).map((row) => {
    assertExactOwnKeys(row, ["id", "sequence", "digest"], "REMOTE_D1_JOURNAL_UNREADABLE");
    return {
      id: ownBoundedString(row, "id", budget, "REMOTE_D1_JOURNAL_UNREADABLE"),
      sequence: ownSafeInteger(row, "sequence", "REMOTE_D1_JOURNAL_UNREADABLE"),
      digest: ownBoundedString(row, "digest", budget, "REMOTE_D1_JOURNAL_UNREADABLE"),
    };
  });

  const lineage = (
    await readOptionalRemoteRows(
      transport,
      budget,
      catalog,
      LINEAGE_TABLE,
      "singleton, lineage, artifact_id, artifact_digest, schema_digest, empty_guard",
      MAX_LINEAGE_ROWS,
      targetId,
      "REMOTE_D1_LINEAGE_UNREADABLE",
      "REMOTE_D1_LINEAGE_OVERRUN",
    )
  ).map((row) => {
    const code = "REMOTE_D1_LINEAGE_UNREADABLE";
    assertExactOwnKeys(
      row,
      ["singleton", "lineage", "artifact_id", "artifact_digest", "schema_digest", "empty_guard"],
      code,
    );
    return {
      singleton: ownSafeInteger(row, "singleton", code),
      lineage: ownBoundedString(row, "lineage", budget, code),
      artifact_id: ownBoundedString(row, "artifact_id", budget, code),
      artifact_digest: ownBoundedString(row, "artifact_digest", budget, code),
      schema_digest: ownBoundedString(row, "schema_digest", budget, code),
      empty_guard: ownSafeInteger(row, "empty_guard", code),
    };
  });

  return { catalog, journal, lineage, target };
}

/**
 * The checked-in topology deliberately carries a staging placeholder. The
 * resolver writes the real staging account and D1 id into this ignored artifact.
 * The default transport reads it once as an authority source, then passes neither
 * its path nor its mutable D1 binding to a child. In particular, callers cannot
 * substitute a production configuration, an account, or a database name for the
 * captured UUID authority.
 */
function readResolvedStagingAuthority(root, environmentName, environment, resolvedDatabaseId) {
  if (
    environmentName !== "staging" ||
    environment.kind !== "remote" ||
    environment.is_preview !== true ||
    environment.may_hold_production_keys !== false
  ) {
    fail(
      "REMOTE_STAGING_ONLY",
      "The default remote D1 transport is restricted to the resolved staging preview target.",
    );
  }
  const configPath = assertRepositoryContained(
    root,
    RESOLVED_STAGING_WRANGLER_CONFIG,
    "The resolved staging Wrangler configuration",
  );
  if (!existsSync(configPath)) {
    fail(
      "REMOTE_RESOLVED_CONFIG_UNAVAILABLE",
      "The resolved staging Wrangler configuration is unavailable; resolve staging before remote observation.",
    );
  }
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > REMOTE_D1_STDOUT_MAX_BYTES) {
    fail(
      "REMOTE_RESOLVED_CONFIG_INVALID",
      "The resolved staging Wrangler configuration is not a bounded regular file.",
    );
  }
  let parsed;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  } catch {
    fail(
      "REMOTE_RESOLVED_CONFIG_INVALID",
      "The resolved staging Wrangler configuration is not valid TOML.",
    );
  }
  const databases = parsed?.d1_databases;
  const database = Array.isArray(databases) && databases.length === 1 ? databases[0] : undefined;
  const accountId = parsed?.account_id;
  if (
    database === null ||
    typeof database !== "object" ||
    database.binding !== environment.d1.binding ||
    database.database_name !== environment.d1.database_name ||
    database.database_id !== resolvedDatabaseId ||
    typeof accountId !== "string" ||
    !REMOTE_ACCOUNT_ID.test(accountId)
  ) {
    fail(
      "REMOTE_RESOLVED_CONFIG_INVALID",
      "The resolved staging configuration does not bind the selected account and D1 identity exactly.",
    );
  }
  return { account_id: accountId };
}

function remoteCommandJsonOrRefuse(result) {
  const code = "REMOTE_D1_TRANSPORT_FAILED";
  // `runCommand` is injectable for causal plants. Do not let an inherited
  // outcome/stdout/exitCode or an accessor turn that test seam into ambient
  // authority at the default transport boundary.
  assertRemotePlainObject(result, code);
  const outcome = ownDataValue(result, "outcome", code);
  if (outcome === "timeout") {
    fail("REMOTE_D1_TRANSPORT_TIMEOUT", "The staging D1 transport exceeded its fixed deadline.");
  }
  if (outcome === "aborted") {
    fail("REMOTE_D1_TRANSPORT_ABORTED", "The staging D1 transport was cancelled and reaped.");
  }
  if (outcome === "output-overrun") {
    fail(
      "REMOTE_D1_TRANSPORT_OUTPUT_OVERRUN",
      "The staging D1 transport exceeded its fixed output limit.",
    );
  }
  if (
    outcome === "pipe-drain-unproven" ||
    outcome === "process-reap-unproven" ||
    outcome === "direct-child-reap-unproven" ||
    outcome === "process-group-survivor-observed"
  ) {
    fail(
      "REMOTE_D1_TRANSPORT_REAP_UNPROVEN",
      "The staging D1 transport could not be reaped safely.",
    );
  }
  const exitCode = ownDataValue(result, "exitCode", code);
  const stdout = ownDataValue(result, "stdout", code);
  if (outcome !== "exited" || exitCode !== 0 || typeof stdout !== "string") {
    // Provider output and child stderr are intentionally not attached. A
    // Wrangler/API diagnostic may echo credentials; this fixed refusal is safe
    // even when the transport boundary is hostile.
    fail("REMOTE_D1_TRANSPORT_FAILED", "The staging D1 transport did not complete.");
  }
  if (Buffer.byteLength(stdout, "utf8") > REMOTE_D1_STDOUT_MAX_BYTES) {
    fail(
      "REMOTE_D1_TRANSPORT_OUTPUT_OVERRUN",
      "The staging D1 transport exceeded its fixed output limit.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("REMOTE_D1_TRANSPORT_FAILED", "The staging D1 transport did not return JSON rows.");
  }
  return parsed;
}

function remoteCommandResultsOrRefuse(result) {
  const parsed = remoteCommandJsonOrRefuse(result);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail(
      "REMOTE_D1_TRANSPORT_FAILED",
      "The staging D1 transport returned an unexpected result shape.",
    );
  }
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(
        "REMOTE_D1_TRANSPORT_FAILED",
        "The staging D1 transport returned an unsuccessful result.",
      );
    }
    const success = ownDataValue(entry, "success", "REMOTE_D1_TRANSPORT_FAILED");
    const rows = ownDataValue(entry, "results", "REMOTE_D1_TRANSPORT_FAILED");
    if (success !== true || !Array.isArray(rows)) {
      fail(
        "REMOTE_D1_TRANSPORT_FAILED",
        "The staging D1 transport returned an unsuccessful result.",
      );
    }
  }
  return parsed;
}

function remoteDatabaseInfoOrRefuse(result, resolvedDatabaseId, expectedName) {
  const info = remoteCommandJsonOrRefuse(result);
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    fail(
      "REMOTE_TARGET_UNDESCRIBED",
      "The staging D1 identity transport returned an unexpected result.",
    );
  }
  const uuid = ownDataValue(info, "uuid", "REMOTE_TARGET_UNDESCRIBED");
  const name = ownDataValue(info, "name", "REMOTE_TARGET_UNDESCRIBED");
  const replication = ownDataValue(info, "read_replication", "REMOTE_TARGET_UNDESCRIBED");
  if (
    uuid !== resolvedDatabaseId ||
    name !== expectedName ||
    replication === null ||
    typeof replication !== "object" ||
    Array.isArray(replication) ||
    ownDataValue(replication, "mode", "REMOTE_TARGET_UNDESCRIBED") !== "disabled"
  ) {
    fail(
      "REMOTE_TARGET_IDENTITY_MISMATCH",
      "The staging D1 identity or read-replication mode does not match the resolved target.",
    );
  }
  return { database_id: uuid, database_name: name };
}

function remotePrimaryRowsOrRefuse(result) {
  const results = remoteCommandResultsOrRefuse(result);
  if (results.length !== 1) {
    fail(
      "REMOTE_D1_TRANSPORT_FAILED",
      "The staging D1 read transport returned multiple result sets.",
    );
  }
  const meta = ownDataValue(results[0], "meta", "REMOTE_D1_TRANSPORT_FAILED");
  if (
    meta === null ||
    typeof meta !== "object" ||
    Array.isArray(meta) ||
    ownDataValue(meta, "served_by_primary", "REMOTE_D1_TRANSPORT_FAILED") !== true
  ) {
    fail(
      "REMOTE_D1_REPLICA_REFUSED",
      "The staging D1 operation was not confirmed by the primary database.",
    );
  }
  return results[0].results;
}

/**
 * File-import responses carry one summary group per upload rather than one
 * row set per statement. Every group must be a primary-confirmed success; a
 * failed group fails the whole install and leaves the post-install lineage
 * reclassification to report the true catalog state.
 *
 * The file-import child prefixes its JSON array with an upload banner on
 * stdout ("Checking if file needs uploading", the upload hash line). The
 * extraction is exact: the response body begins at the first line that opens
 * the top-level array; anything else still fails JSON validation below.
 */
function remotePrimaryFileResultsOrRefuse(result) {
  if (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result.stdout === "string" &&
    !result.stdout.startsWith("[")
  ) {
    const marker = result.stdout.indexOf("\n[");
    if (marker >= 0) result = { ...result, stdout: result.stdout.slice(marker + 1) };
  }
  const results = remoteCommandResultsOrRefuse(result);
  for (const group of results) {
    const meta = ownDataValue(group, "meta", "REMOTE_D1_TRANSPORT_FAILED");
    if (
      meta === null ||
      typeof meta !== "object" ||
      Array.isArray(meta) ||
      ownDataValue(meta, "served_by_primary", "REMOTE_D1_TRANSPORT_FAILED") !== true
    ) {
      fail(
        "REMOTE_D1_BOOTSTRAP_FAILED",
        "The staging D1 file import was not confirmed as a primary-served success.",
      );
    }
  }
}

/**
 * Build the only default remote transport. It is staging-only and consumes the
 * locally resolved authority exactly once before a child process is started.
 * Each child receives the captured account id in its deliberately minimal
 * environment and the captured D1 UUID as Wrangler's positional operand. It is
 * given the immutable empty config device, never the mutable resolved config
 * path, so a concurrent deploy resolver can rewrite that path after
 * `describeTarget()` without changing any later child target.
 *
 * D1 query responses do not echo a database UUID. `describeTarget` obtains the
 * documented D1-info UUID/name and requires replication disabled; the query
 * result's `database_id` below is explicitly a transport assertion about the
 * immutable request operand, not a provider-returned identity field.
 *
 * Cloudflare documents that the D1 query endpoint accepts semicolon-joined SQL
 * as a batch and that each D1 query is an implicit transaction:
 * https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
 * https://developers.cloudflare.com/d1/sql-api/foreign-keys/
 * This seam therefore submits one `--command` batch for a forward migration and
 * its journal row. The bootstrap install uses the separate file-import seam
 * (`executeFile`): the hosted --command path mis-parses large trigger-bearing
 * batches, and the file seam's summary groups carry the same primary-confirmation
 * metadata. The in-batch empty guard and the post-install lineage
 * reclassification remain the race and truth authorities for both paths.
 */
export function createWranglerRemoteTransport({
  root,
  environmentName = "staging",
  environment,
  resolvedDatabaseId,
  runCommand = runBoundedCommand,
}) {
  // This order is a security property: a placeholder or malformed id must fail
  // before config parsing, pinned-Wrangler resolution, or any transport call.
  const databaseId = assertResolvedDatabaseId(resolvedDatabaseId);
  const authority = readResolvedStagingAuthority(root, environmentName, environment, databaseId);
  const pinnedWranglerCommand = resolvePinnedWranglerCommand(root);
  const immutableConfig = immutableEmptyWranglerConfigOrRefuse();
  const run = async (args, signal, timeoutMs) =>
    await runCommand({
      cmd: [
        ...pinnedWranglerCommand,
        // Do not pass the resolved config to a separate child. The explicit
        // empty config prevents discovery; Wrangler resolves this UUID through
        // the captured account authority, so a resolver rewrite cannot redirect
        // a binding between operations.
        "--config",
        immutableConfig,
        ...args,
      ],
      cwd: root,
      timeoutMs,
      stdoutMaxBytes: REMOTE_D1_STDOUT_MAX_BYTES,
      stderrMaxBytes: REMOTE_D1_STDERR_MAX_BYTES,
      signal,
      toolEnvironment: minimalRemoteToolEnvironment(authority.account_id),
    });
  const transport = {
    // The string is deliberately a narrow capability, not a generic claim about
    // Wrangler. Only this D1-query command batch is covered by the cited D1
    // transaction documentation.
    atomicity: "d1-query-implicit-transaction-v1",
    describeTarget: async ({ signal, timeoutMs }) =>
      remoteDatabaseInfoOrRefuse(
        await run(["d1", "info", databaseId, "--json"], signal, timeoutMs),
        databaseId,
        environment.d1.database_name,
      ),
    query: async ({ sql, database_id, signal, timeoutMs }) => {
      if (database_id !== databaseId) {
        fail(
          "REMOTE_TARGET_IDENTITY_MISMATCH",
          "The remote query target was not the resolved staging identity.",
        );
      }
      assertReadOnlySql(sql);
      return {
        database_id: databaseId,
        rows: remotePrimaryRowsOrRefuse(
          await run(
            ["d1", "execute", databaseId, "--remote", "--yes", "--json", "--command", sql],
            signal,
            timeoutMs,
          ),
        ),
      };
    },
    execute: async ({ sql, database_id, signal, timeoutMs }) => {
      if (database_id !== databaseId) {
        fail(
          "REMOTE_TARGET_IDENTITY_MISMATCH",
          "The remote apply target was not the resolved staging identity.",
        );
      }
      // A successful result envelope is insufficient: REST reads can be served
      // by replicas, and the apply receipt must not claim a forward write unless
      // Wrangler's result metadata confirms the primary.
      remotePrimaryRowsOrRefuse(
        await run(
          ["d1", "execute", databaseId, "--remote", "--yes", "--json", "--command", sql],
          signal,
          timeoutMs,
        ),
      );
      return { database_id: databaseId };
    },
    // The bootstrap install batch is far past the size at which the hosted
    // /query --command path mis-parses trigger bodies (observed 2026-08-17:
    // "incomplete input" on an 88KB batch that parses cleanly via upload).
    // File import is one server-side processing unit; the in-batch empty
    // guard remains the race authority and the post-install reclassification
    // remains the truth check.
    executeFile: async ({ sql, database_id, signal, timeoutMs }) => {
      if (database_id !== databaseId) {
        fail(
          "REMOTE_TARGET_IDENTITY_MISMATCH",
          "The remote bootstrap target was not the resolved staging identity.",
        );
      }
      if (
        typeof sql !== "string" ||
        sql.length === 0 ||
        sql.length > REMOTE_BOOTSTRAP_SQL_MAX_BYTES
      ) {
        fail("REMOTE_D1_BOOTSTRAP_SQL_INVALID", "The remote bootstrap batch is not bounded SQL.");
      }
      const directory = mkdtempSync(join(tmpdir(), "asimposium-bootstrap-"));
      try {
        const file = join(directory, "install.sql");
        writeFileSync(file, sql, { mode: 0o600, flag: "wx" });
        remotePrimaryFileResultsOrRefuse(
          await run(
            ["d1", "execute", databaseId, "--remote", "--yes", "--json", "--file", file],
            signal,
            timeoutMs,
          ),
        );
        return { database_id: databaseId };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
  // The privilege is granted here and nowhere else, and ONLY for this module's
  // own bounded runner. An injected `runCommand` is an arbitrary function this
  // file cannot vouch for: granting it the unconditional-await path would let a
  // never-settling injection hang the observation forever, which is precisely
  // what a deadline exists to prevent. Such a transport stays on the bounded
  // path and a non-settling one is refused as settlement-unproven.
  // WeakSet provenance is meaningful only while the branded methods cannot be
  // replaced. Freeze first, then grant the private capability to this exact
  // immutable identity. Otherwise a caller could obtain a genuine transport,
  // overwrite `describeTarget` with a never-settling function, and retain the
  // unconditional-await privilege.
  Object.freeze(transport);
  if (runCommand === runBoundedCommand) SETTLEMENT_GUARANTEED_TRANSPORTS.add(transport);
  return transport;
}

export function bootstrapInstallSql(artifact, appliedAt) {
  // The CAS-like empty guard is evaluated inside one D1 command batch with
  // every CREATE. A racing or contaminated target hits the CHECK, rolling back
  // the lineage table, the empty journal, the witness, and every artifact
  // statement together. D1 command batches are the transaction boundary here;
  // explicit BEGIN/COMMIT is not portable through `wrangler d1 execute`.
  const guard = `(SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_' AND NOT ((type = 'table' AND name = ${sqlLiteral(LINEAGE_TABLE)} AND tbl_name = ${sqlLiteral(LINEAGE_TABLE)} AND sql = ${sqlLiteral(LINEAGE_CATALOG_SQL)}) OR (type = 'table' AND name = '_cf_METADATA' AND tbl_name = '_cf_METADATA' AND sql = ${sqlLiteral(WRANGLER_LOCAL_METADATA_SQL)}) OR (type = 'table' AND name = '_cf_KV' AND tbl_name = '_cf_KV' AND sql = ${sqlLiteral(WRANGLER_REMOTE_KV_SQL)})))`;
  const sql = `${BOOTSTRAP_LINEAGE_DDL}
INSERT INTO ${LINEAGE_TABLE} (singleton, lineage, artifact_id, artifact_digest, schema_digest, empty_guard, installed_at)
VALUES (1, ${sqlLiteral(BOOTSTRAP_LINEAGE)}, ${sqlLiteral(artifact.id)}, ${sqlLiteral(artifact.digest)}, ${sqlLiteral(artifact.schema_digest)}, ${guard}, ${sqlLiteral(appliedAt)});
${BOOTSTRAP_LEDGER_DDL}
${artifact.sql}
INSERT INTO sponsor_enrollment_bootstrap_migration_witness (singleton, rule_version, passed)
VALUES (1, 1, 1);`;
  return sql;
}

async function bootstrapLocalSchema(
  root,
  databaseName,
  artifact,
  appliedAt,
  localPersistTo,
  localDeadlineAtMs = undefined,
  localOwnerLease = undefined,
) {
  await localD1(
    root,
    databaseName,
    ["--command", bootstrapInstallSql(artifact, appliedAt)],
    localPersistTo,
    localDeadlineAtMs,
    localOwnerLease,
  );
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

async function applyLocalMigration(
  root,
  databaseName,
  migration,
  appliedAt,
  localPersistTo,
  localDeadlineAtMs = undefined,
  localOwnerLease = undefined,
) {
  await localD1(
    root,
    databaseName,
    ["--command", migrationCommandSql(migration, appliedAt)],
    localPersistTo,
    localDeadlineAtMs,
    localOwnerLease,
  );
}

/**
 * An ordinary remote application must fail before it can reach the callback
 * that opens local D1. Keeping that observer at the actual pending-migration
 * seam makes the no-remote-D1 property causally testable rather than inferred
 * from a refusal string.
 */
export async function applyPendingLocalMigrationsOrRefuse(
  environment,
  pending,
  observeLocalMigration,
) {
  if (environment.kind !== "local") {
    fail(
      "APPLY_UNAVAILABLE",
      `Cannot apply migrations to ${environment.name}: no D1 binding or deployment credential is available in this environment. ` +
        "Provision the environment first; this runner will not simulate an application.",
    );
  }
  const applied = [];
  for (const migration of pending) {
    await observeLocalMigration(migration);
    applied.push({ id: migration.id, digest: migration.digest });
  }
  return applied;
}

/**
 * Forward-only remote application is intentionally narrower than the local
 * executor: it needs the D1-query transaction capability and an own `execute`
 * method in addition to the observation methods. An injected observer cannot
 * accidentally become a writer merely because somebody passed `--apply`.
 */
function assertRemoteApplyTransport(transport) {
  assertRemoteTransport(transport);
  if (
    ownDataValue(transport, "atomicity", "REMOTE_APPLY_ATOMICITY_UNSUPPORTED") !==
      "d1-query-implicit-transaction-v1" ||
    typeof ownDataValue(transport, "execute", "REMOTE_APPLY_ATOMICITY_UNSUPPORTED") !== "function"
  ) {
    fail(
      "REMOTE_APPLY_ATOMICITY_UNSUPPORTED",
      "Remote application requires the verified D1 query-transaction transport capability.",
    );
  }
}

/**
 * Install the authorized bootstrap artifact on a disposable remote staging
 * target as one D1 query batch (guard + lineage + ledger + artifact +
 * witness, all-or-nothing). Same target guards as the forward path: remote
 * staging preview only, exact resolved identity, bounded deadline.
 */
export async function applyRemoteBootstrapOrRefuse(
  environment,
  transport,
  resolvedDatabaseId,
  artifact,
  appliedAt,
  { deadlineMs = REMOTE_OBSERVATION_DEADLINE_MS } = {},
) {
  if (environment.kind !== "remote") {
    fail(
      "REMOTE_APPLY_WRONG_TARGET",
      "Remote bootstrap application requires a remote staging target.",
    );
  }
  if (environment.is_preview !== true || environment.may_hold_production_keys !== false) {
    fail(
      "REMOTE_APPLY_PRODUCTION_REFUSED",
      "Remote bootstrap application is restricted to a non-production staging preview target.",
    );
  }
  const targetId = assertResolvedDatabaseId(resolvedDatabaseId);
  assertRemoteApplyTransport(transport);
  if (
    typeof ownDataValue(transport, "executeFile", "REMOTE_BOOTSTRAP_TRANSPORT_UNSUPPORTED") !==
    "function"
  ) {
    fail(
      "REMOTE_BOOTSTRAP_TRANSPORT_UNSUPPORTED",
      "Remote bootstrap requires the file-import transport capability.",
    );
  }
  const budget = createRemoteBudget(deadlineMs);
  const response = await awaitBoundedRemote(
    budget,
    (signal, timeoutMs) =>
      transport.executeFile({
        sql: bootstrapInstallSql(artifact, appliedAt),
        database_id: targetId,
        signal,
        timeoutMs,
      }),
    "REMOTE_D1_BOOTSTRAP_FAILED",
    { ownsBoundedCommand: transportOwnsBoundedCommand(transport) },
  );
  assertExactOwnKeys(response, ["database_id"], "REMOTE_D1_BOOTSTRAP_FAILED");
  if (
    ownBoundedString(response, "database_id", budget, "REMOTE_D1_BOOTSTRAP_FAILED") !== targetId
  ) {
    fail(
      "REMOTE_TARGET_IDENTITY_MISMATCH",
      "A remote bootstrap result was not served by the resolved staging target.",
    );
  }
  return { database_id: targetId };
}

/**
 * Apply each forward migration as one D1 query batch containing both its SQL and
 * the durable migration-record insert. The Cloudflare D1 query transaction
 * documentation cited at `createWranglerRemoteTransport` is the authority for
 * this one seam; callers with any other transport get a typed refusal.
 */
export async function applyPendingRemoteMigrationsOrRefuse(
  environment,
  transport,
  resolvedDatabaseId,
  pending,
  appliedAt,
  { deadlineMs = REMOTE_OBSERVATION_DEADLINE_MS } = {},
) {
  if (environment.kind !== "remote") {
    fail(
      "REMOTE_APPLY_WRONG_TARGET",
      "Remote migration application requires a remote staging target.",
    );
  }
  if (environment.is_preview !== true || environment.may_hold_production_keys !== false) {
    fail(
      "REMOTE_APPLY_PRODUCTION_REFUSED",
      "Remote migration application is restricted to a non-production staging preview target.",
    );
  }
  const targetId = assertResolvedDatabaseId(resolvedDatabaseId);
  assertRemoteApplyTransport(transport);
  const budget = createRemoteBudget(deadlineMs);
  const applied = [];
  for (const migration of pending) {
    const response = await awaitBoundedRemote(
      budget,
      (signal, timeoutMs) =>
        transport.execute({
          sql: migrationCommandSql(migration, appliedAt),
          database_id: targetId,
          signal,
          timeoutMs,
        }),
      "REMOTE_D1_APPLY_FAILED",
      { ownsBoundedCommand: transportOwnsBoundedCommand(transport) },
    );
    assertExactOwnKeys(response, ["database_id"], "REMOTE_D1_APPLY_FAILED");
    if (ownBoundedString(response, "database_id", budget, "REMOTE_D1_APPLY_FAILED") !== targetId) {
      fail(
        "REMOTE_TARGET_IDENTITY_MISMATCH",
        "A remote application result was not served by the resolved staging target.",
      );
    }
    applied.push({ id: migration.id, digest: migration.digest });
  }
  return applied;
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
    localDeadlineAtMs: undefined,
    localPersistTo: undefined,
    confirmProduction: false,
    resolvedDatabaseId: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env") {
      options.env = argv[index + 1];
      index += 1;
    } else if (argument === "--state-file") {
      const state = argv[index + 1];
      if (typeof state !== "string" || state === "" || state.startsWith("--")) {
        fail("INVALID_ARGUMENT", "--state-file requires one non-option path argument.");
      }
      options.state = state;
      index += 1;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--bootstrap") {
      const artifact = argv[index + 1];
      if (typeof artifact !== "string" || artifact === "" || artifact.startsWith("--")) {
        fail("INVALID_ARGUMENT", "--bootstrap requires one non-option artifact id argument.");
      }
      options.bootstrap = artifact;
      index += 1;
    } else if (argument === "--i-authorize-disposable-remote-bootstrap") {
      // The operator's explicit authorization for one disposable remote run.
      // It never applies to production: the staging-preview topology check
      // below and the transport's own guard both refuse it there.
      options.authorizeDisposableRemoteBootstrap = true;
    } else if (argument === "--local-persist-to") {
      const directory = argv[index + 1];
      if (typeof directory !== "string" || directory === "" || directory.startsWith("--")) {
        fail("INVALID_ARGUMENT", "--local-persist-to requires one non-option directory argument.");
      }
      options.localPersistTo = directory;
      index += 1;
    } else if (argument === "--local-command-deadline-at-ms") {
      const deadline = argv[index + 1];
      if (!/^(?:0|[1-9][0-9]*)$/.test(deadline ?? "") || !Number.isSafeInteger(Number(deadline))) {
        fail(
          "INVALID_ARGUMENT",
          "--local-command-deadline-at-ms requires one canonical safe-integer epoch millisecond.",
        );
      }
      options.localDeadlineAtMs = Number(deadline);
      index += 1;
    } else if (argument === "--resolved-database-id") {
      const databaseId = argv[index + 1];
      if (typeof databaseId !== "string" || databaseId === "" || databaseId.startsWith("--")) {
        fail(
          "INVALID_ARGUMENT",
          "--resolved-database-id requires one non-option D1 UUID argument.",
        );
      }
      options.resolvedDatabaseId = databaseId;
      index += 1;
    } else if (argument === "--i-understand-this-is-production") {
      options.confirmProduction = true;
    } else {
      fail(
        "INVALID_ARGUMENT",
        "Usage: bun infra/migrate.mjs --env <local|staging|production> [--state-file <path>] [--bootstrap <artifact-id> [--i-authorize-disposable-remote-bootstrap]] [--local-persist-to <directory>] [--local-command-deadline-at-ms <epoch-ms>] [--resolved-database-id <uuid>] [--apply]",
      );
    }
  }
  if (options.authorizeDisposableRemoteBootstrap === true && options.bootstrap === undefined) {
    fail(
      "INVALID_ARGUMENT",
      "--i-authorize-disposable-remote-bootstrap is meaningful only together with --bootstrap.",
    );
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

/**
 * CLI orchestration is injectable so its remote safety ordering is proven
 * without a provider call. The executable entrypoint below supplies only the
 * default staging Wrangler transport; tests supply an inert recording transport.
 */
export async function runMigrationCli(
  argv = process.argv.slice(2),
  {
    root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    environmentValidator = validateEnvironments,
    remoteTransportFactory = createWranglerRemoteTransport,
    localReadLineageSnapshot = readLocalLineageSnapshot,
    localBootstrapSchema = bootstrapLocalSchema,
    remoteBootstrapSchema = applyRemoteBootstrapOrRefuse,
    localApplyMigration = applyLocalMigration,
    ownerLeaseWatchdogSpawn = Bun.spawn,
    localProcessLeadsOwnedGroup = currentProcessLeadsOwnedGroup,
    stdout = (line) => process.stdout.write(line),
    stderr = (line) => process.stderr.write(line),
    now = () => new Date().toISOString(),
  } = {},
) {
  const startedAt = performance.now();
  let phase = "arguments";
  try {
    const options = parseArguments(argv);

    assertRehearsalIsNotAnApplication(options);

    phase = "environment";
    const report = environmentValidator(root);
    // Explicit selection: there is no default environment, so no command can
    // reach production by omission.
    const environment = selectEnvironment(report, options.env);
    if (options.localPersistTo !== undefined && environment.kind !== "local") {
      fail(
        "LOCAL_PERSISTENCE_REMOTE_REFUSED",
        "--local-persist-to is available only for the explicitly selected local environment.",
      );
    }
    if (options.localDeadlineAtMs !== undefined && environment.kind !== "local") {
      fail(
        "LOCAL_D1_ORCHESTRATION_DEADLINE_REMOTE_REFUSED",
        "--local-command-deadline-at-ms is available only for the explicitly selected local environment.",
      );
    }
    // Production is not a fallback for a stale staging id. It is refused before
    // constructing a transport, resolving an id, or observing a remote catalog;
    // the legacy production-confirmation flag intentionally cannot override it.
    if (options.apply && options.env === "production") {
      fail(
        "REMOTE_APPLY_PRODUCTION_REFUSED",
        "Remote migration application is staging-only; production is never an apply target for this runner.",
      );
    }

    let localOwnerLease;
    if (options.localDeadlineAtMs !== undefined) {
      phase = "owner-lease";
      if (!localProcessLeadsOwnedGroup()) {
        fail(
          "LOCAL_D1_PARENT_PROCESS_GROUP_UNPROVEN",
          "The deadline-bearing local migration CLI is not the leader of its outer owner's process group; no watchdog or local command was started.",
        );
      }
      localOwnerLease = await authenticateLocalOwnerLease(options.localDeadlineAtMs, {
        processLeadsOwnedGroup: localProcessLeadsOwnedGroup,
        spawn: ownerLeaseWatchdogSpawn,
      });
    }

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
      // The remote observer is constructed lazily and exists at all only when
      // the operator's flag authorizes this disposable staging-preview run.
      // Production never gets one: the topology fields, not the env name, are
      // the authority on that.
      let remoteDatabaseId;
      let remoteTransport;
      const observeRemote = async () => {
        remoteDatabaseId = assertResolvedDatabaseId(options.resolvedDatabaseId);
        remoteTransport = remoteTransportFactory({
          root,
          environmentName: options.env,
          environment,
          resolvedDatabaseId: remoteDatabaseId,
        });
        return readRemoteLineageSnapshotOrRefuse(environment, remoteTransport, remoteDatabaseId);
      };
      const authorizedRemoteObserver =
        environment.kind === "remote" &&
        environment.is_preview === true &&
        environment.may_hold_production_keys === false &&
        options.authorizeDisposableRemoteBootstrap === true
          ? observeRemote
          : undefined;
      const snapshot = await readBootstrapSnapshotOrRefuse(
        environment,
        () =>
          localReadLineageSnapshot(
            root,
            localDatabase,
            options.localPersistTo,
            options.localDeadlineAtMs,
            localOwnerLease,
          ),
        authorizedRemoteObserver,
      );
      const lineage = classifySchemaLineage({ ...snapshot, migrations, manifest });
      if (bootstrapTargetDisposition(lineage) === "idempotent") {
        stdout(
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
        return 0;
      }
      if (!options.apply) {
        stdout(
          `${JSON.stringify(
            diagnostic("pass", startedAt, "bootstrap-plan", {
              environment: options.env,
              bootstrap_artifact: artifact.id,
              lineage: lineage.kind,
              ready_to_apply: true,
            }),
          )}\n`,
        );
        return 0;
      }
      if (environment.kind === "local") {
        await localBootstrapSchema(
          root,
          localDatabase,
          artifact,
          now(),
          options.localPersistTo,
          options.localDeadlineAtMs,
          localOwnerLease,
        );
      } else {
        await remoteBootstrapSchema(
          environment,
          remoteTransport,
          remoteDatabaseId,
          artifact,
          now(),
        );
      }
      const afterSnapshot =
        environment.kind === "local"
          ? await localReadLineageSnapshot(
              root,
              localDatabase,
              options.localPersistTo,
              options.localDeadlineAtMs,
              localOwnerLease,
            )
          : await readRemoteLineageSnapshotOrRefuse(environment, remoteTransport, remoteDatabaseId);
      const after = classifySchemaLineage({
        ...afterSnapshot,
        migrations,
        manifest,
      });
      if (after.kind !== BOOTSTRAP_LINEAGE || after.artifact_id !== artifact.id) {
        fail(
          "BOOTSTRAP_LINEAGE_UNVERIFIED",
          "Bootstrap completed without the expected durable baseline lineage.",
        );
      }
      stdout(
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
      return 0;
    }

    let localSnapshot;
    let localManifest;
    let localPlan;
    let remoteSnapshot;
    let remoteManifest;
    let remotePlan;
    let remoteTransport;
    let remoteDatabaseId;
    if (localDatabase !== undefined && options.state === undefined) {
      localManifest = readBootstrapManifest(root);
      localSnapshot = await localReadLineageSnapshot(
        root,
        localDatabase,
        options.localPersistTo,
        options.localDeadlineAtMs,
        localOwnerLease,
      );
      localPlan = localPlanState(localSnapshot, migrations, localManifest);
      baseline = localPlan.baseline;
    } else if (environment.kind === "remote" && options.state === undefined) {
      // Validate before the factory: an injected factory is a transport boundary
      // too, so an unresolved id must not even reach a pure test double.
      remoteDatabaseId = assertResolvedDatabaseId(options.resolvedDatabaseId);
      remoteManifest = readBootstrapManifest(root);
      remoteTransport = remoteTransportFactory({
        root,
        environmentName: options.env,
        environment,
        resolvedDatabaseId: remoteDatabaseId,
      });
      remoteSnapshot = await readRemoteLineageSnapshotOrRefuse(
        environment,
        remoteTransport,
        remoteDatabaseId,
      );
      // This is deliberately the same classifier used for local D1. A remote
      // catalog is not allowed to claim a weaker or a second authority model.
      remotePlan = localPlanState(remoteSnapshot, migrations, remoteManifest);
      baseline = remotePlan.baseline;
    }
    // A local environment has a real (miniflare) D1 available with no
    // credential, so its applied-records come from the database itself rather
    // than from a rehearsal file.
    const applied =
      options.state !== undefined
        ? readStateFile(assertRepositoryContained(root, options.state, "The state file path"))
        : localDatabase !== undefined
          ? localPlan.applied
          : remotePlan.applied;
    const plan = planMigrations(migrations, applied, {
      environmentName: options.env,
      // The configured flag, not a guess re-derived from the environment name.
      // The topology is the authority on what each target permits; recomputing
      // it here would make `destructive_operations_allowed` decorative.
      destructiveAllowed: environment.destructive_operations_allowed,
      baseline,
    });

    if (localManifest !== undefined) assertForwardHeadsRegistered(plan, localManifest);
    if (remoteManifest !== undefined) assertForwardHeadsRegistered(plan, remoteManifest);

    if (!options.apply) {
      stdout(
        `${JSON.stringify(
          diagnostic("pass", startedAt, "plan", {
            environment: options.env,
            environment_kind: environment.kind,
            is_preview: environment.is_preview,
            d1_binding: environment.d1.binding,
            ...(remoteDatabaseId === undefined ? {} : { resolved_database_id: remoteDatabaseId }),
            migrations_discovered: migrations.length,
            ...plan,
          }),
        )}\n`,
      );
      return 0;
    }

    phase = "apply";
    // Local is genuinely available: Wrangler's local D1 is workerd's own
    // SQLite, needs no account, and is not a mock of D1.
    const appliedAt = now();
    let appliedNow;
    let afterSnapshot;
    let afterLineage;
    if (environment.kind === "local") {
      appliedNow = await applyPendingLocalMigrationsOrRefuse(
        environment,
        plan.to_apply,
        async (pending) => {
          const migration = migrations.find((candidate) => candidate.id === pending.id);
          await localApplyMigration(
            root,
            localDatabase,
            migration,
            appliedAt,
            options.localPersistTo,
            options.localDeadlineAtMs,
            localOwnerLease,
          );
        },
      );
      afterSnapshot = await localReadLineageSnapshot(
        root,
        localDatabase,
        options.localPersistTo,
        options.localDeadlineAtMs,
        localOwnerLease,
      );
      afterLineage = classifySchemaLineage({
        ...afterSnapshot,
        migrations,
        manifest: localManifest,
      });
    } else {
      // `plan.to_apply` is an audit receipt shape (id, sequence, digest), not
      // executable SQL. Bind each approved receipt back to the exact discovered
      // migration byte before crossing the remote write seam; otherwise a
      // successful CLI --apply reaches `migrationCommandSql` with no SQL and
      // fails only as an opaque transport error.
      const pendingMigrations = plan.to_apply.map((pending) => {
        const migration = migrations.find(
          (candidate) =>
            candidate.id === pending.id &&
            candidate.sequence === pending.sequence &&
            candidate.digest === pending.digest,
        );
        if (migration === undefined) {
          fail(
            "MIGRATION_PLAN_UNRESOLVED",
            "The approved remote migration plan does not map to an exact discovered migration byte.",
          );
        }
        return migration;
      });
      appliedNow = await applyPendingRemoteMigrationsOrRefuse(
        environment,
        remoteTransport,
        remoteDatabaseId,
        pendingMigrations,
        appliedAt,
      );
      afterSnapshot = await readRemoteLineageSnapshotOrRefuse(
        environment,
        remoteTransport,
        remoteDatabaseId,
      );
      afterLineage = classifySchemaLineage({
        ...afterSnapshot,
        migrations,
        manifest: remoteManifest,
      });
    }
    if (afterLineage.kind === "unknown-or-contaminated") {
      fail(
        "SCHEMA_LINEAGE_UNVERIFIED",
        "Applied migrations did not leave an exact reclassifiable schema lineage.",
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

    stdout(
      `${JSON.stringify(
        diagnostic("pass", startedAt, "apply", {
          environment: options.env,
          environment_kind: environment.kind,
          d1_binding: environment.d1.binding,
          ...(remoteDatabaseId === undefined ? {} : { resolved_database_id: remoteDatabaseId }),
          applied: appliedNow,
          skipped: plan.skipped,
          head_before: plan.head,
          second_plan_idempotent: true,
        }),
      )}\n`,
    );
    return 0;
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
    stderr(`${JSON.stringify(diagnostic("fail", startedAt, phase, details))}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMigrationCli();
}
