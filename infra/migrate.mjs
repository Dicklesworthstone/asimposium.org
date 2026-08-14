import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  assertRepositoryContained,
  EnvironmentValidationError,
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

function fail(code, message, cause) {
  throw new MigrationError(code, message, cause);
}

/** Digest recorded in the ledger: sha256 hex, nothing else. */
export const DIGEST = /^[0-9a-f]{64}$/;

const MAX_CAUSAL_STDERR = 600;

/**
 * Turn a tool's stderr into something safe to put in a diagnostic.
 *
 * Suppressing it entirely loses the cause; forwarding it raw can carry absolute
 * paths and, if a tool ever echoes its environment, secret bytes. So: drop
 * anything that looks assigned (`NAME=value`) or credential-shaped, replace
 * absolute paths with a placeholder, collapse whitespace, and bound the length.
 */
export function redactStderr(text) {
  if (typeof text !== "string" || text.trim() === "") return "";
  let safe = text
    .replace(/\b[A-Z][A-Z0-9_]{2,}=\S+/g, "$<name>=<redacted>")
    .replace(/[A-Za-z]*\/(?:Users|home|private|tmp|var|opt|etc|Volumes)\/[^\s"']*/g, "<path>")
    .replace(/-----BEGIN [A-Z ]*-----[\s\S]*?-----END [A-Z ]*-----/g, "<redacted-key>")
    .replace(/\basimp_ag_[A-Za-z0-9]+/g, "<redacted-token>")
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
      const stop = end === -1 ? sql.length : end + 2;
      comments.push(sql.slice(index + 2, end === -1 ? sql.length : end));
      code += " ";
      index = stop;
      continue;
    }
    const character = sql[index];
    if (character === "'" || character === '"' || character === "`") {
      // Consume the literal, honouring doubled-quote escaping.
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === character) {
          if (sql[cursor + 1] === character) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
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
      fail("SYMLINKED_MIGRATION_FILE", `"${entry}" is a symlink; migrations must be regular files.`);
    }
    if (!entryStat.isFile()) {
      fail("NON_REGULAR_MIGRATION_FILE", `"${entry}" is not a regular file.`);
    }
    if (entry.endsWith(".md")) continue;
    if (!entry.endsWith(".sql")) {
      fail("UNEXPECTED_MIGRATION_FILE", `"${entry}" is neither a .sql migration nor documentation.`);
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
      fail("DUPLICATE_MIGRATION_SEQUENCE", `Migrations "${held}" and "${entry}" share sequence ${match[1]}.`);
    }
    seen.set(sequence, entry);

    const sql = readFileSync(join(directory, entry), "utf8");
    if (sql.trim() === "") {
      fail("EMPTY_MIGRATION", `"${entry}" is empty.`);
    }
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
  const { environmentName, destructiveAllowed } = options;
  const appliedById = new Map(applied.map((record) => [record.id, record]));
  const highestApplied = applied.reduce((max, record) => Math.max(max, record.sequence), 0);

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

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  digest TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Run a local D1 command through Wrangler.
 *
 * `--local` only. This function never accepts a `--remote` flag and never reads
 * a credential; a remote application is refused earlier, by the caller.
 */
export function localD1(root, databaseName, args) {
  const result = Bun.spawnSync({
    cmd: [
      "bunx",
      "wrangler",
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
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    // Wrangler's stderr is the only account of *why* this failed, so it is
    // carried through rather than swallowed — but bounded and redacted, so the
    // diagnostic stays safe to paste into an issue.
    const stderrText = redactStderr(result.stderr.toString());
    const stdoutText = redactStderr(stdout);
    fail(
      "LOCAL_D1_COMMAND_FAILED",
      `A local D1 command exited ${result.exitCode}.`,
      stderrText !== ""
        ? { output: stderrText, stream: "stderr" }
        : { output: stdoutText, stream: "stdout" },
    );
  }
  return stdout;
}

function readLocalLedger(root, databaseName) {
  localD1(root, databaseName, ["--command", LEDGER_DDL]);
  const raw = localD1(root, databaseName, [
    "--command",
    `SELECT id, sequence, digest FROM ${LEDGER_TABLE} ORDER BY sequence;`,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("LOCAL_D1_UNREADABLE", "Could not parse the local D1 response as JSON.");
  }
  const rows = Array.isArray(parsed) ? (parsed[0]?.results ?? []) : [];
  return rows.map((row) => ({ id: String(row.id), sequence: Number(row.sequence), digest: String(row.digest) }));
}

/**
 * Apply one migration and record it in the same call, so a migration can never
 * be applied without leaving the record that makes the next run idempotent.
 *
 * Sent as a single `--command` rather than through a temporary file: this
 * process creates no file it would then have to remove, so it has no delete
 * path at all.
 */
function applyLocalMigration(root, databaseName, migration, appliedAt) {
  const sql = `${migration.sql}\nINSERT INTO ${LEDGER_TABLE} (id, sequence, digest, applied_at) VALUES (${sqlLiteral(migration.id)}, ${migration.sequence}, ${sqlLiteral(migration.digest)}, ${sqlLiteral(appliedAt)});`;
  localD1(root, databaseName, ["--command", sql]);
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
      fail("UNORDERED_STATE_FILE", `State file record ${index} (sequence ${sequence}) is not in ascending order.`);
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
}

function parseArguments(argv) {
  const options = { env: undefined, state: undefined, apply: false, confirmProduction: false };
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
    } else if (argument === "--i-understand-this-is-production") {
      options.confirmProduction = true;
    } else {
      fail(
        "INVALID_ARGUMENT",
        "Usage: bun infra/migrate.mjs --env <local|staging|production> [--state-file <path>] [--apply]",
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

function main() {
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
    // A local environment has a real (miniflare) D1 available with no
    // credential, so its applied-records come from the database itself rather
    // than from a rehearsal file.
    const applied =
      options.state !== undefined
        ? readStateFile(assertRepositoryContained(root, options.state, "The state file path"))
        : localDatabase !== undefined
          ? readLocalLedger(root, localDatabase)
          : [];
    const plan = planMigrations(migrations, applied, {
      environmentName: options.env,
      // The configured flag, not a guess re-derived from the environment name.
      // The topology is the authority on what each target permits; recomputing
      // it here would make `destructive_operations_allowed` decorative.
      destructiveAllowed: environment.destructive_operations_allowed,
    });

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
      applyLocalMigration(root, localDatabase, migration, appliedAt);
      appliedNow.push({ id: migration.id, digest: migration.digest });
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
            detail: error.message,
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
  main();
}
