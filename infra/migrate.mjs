import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { EnvironmentValidationError, selectEnvironment, validateEnvironments } from "./validate-environments.mjs";

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
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "MigrationError";
  }
}

function fail(code, message) {
  throw new MigrationError(code, message);
}

/** The fixed name shape declared by db/migrations/README.md. */
export const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * Statements that can destroy committed history. A migration may still need
 * one, but it must say so out loud in a marker comment, and the environment
 * must permit it. Silence plus destruction is the combination this refuses.
 */
const DESTRUCTIVE_PATTERNS = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+DATABASE\b/i, "DROP DATABASE"],
  [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bTRUNCATE\b/i, "TRUNCATE"],
  [/\bDELETE\s+FROM\s+(?!\S*\s+WHERE)/i, "DELETE without WHERE"],
  [/\bUPDATE\s+\S+\s+SET\b(?![\s\S]*\bWHERE\b)/i, "UPDATE without WHERE"],
];

/** An explicit, reviewable opt-in that must appear in the migration itself. */
const DESTRUCTIVE_ACKNOWLEDGEMENT = /^--\s*asimposium:allow-destructive\b/m;

export function digestOf(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function readMigrationDirectory(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail("MISSING_MIGRATIONS_DIRECTORY", "The migrations directory does not exist.");
  }
  const migrations = [];
  const seen = new Map();

  for (const entry of readdirSync(directory).sort()) {
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
  return DESTRUCTIVE_PATTERNS.filter(([pattern]) => pattern.test(sql)).map(([, label]) => label);
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
        fail(
          "MIGRATION_DRIFT",
          `Migration "${migration.id}" changed after it was applied to ${environmentName}; its recorded digest no longer matches the file.`,
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
      if (!DESTRUCTIVE_ACKNOWLEDGEMENT.test(migration.sql)) {
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
function localD1(root, databaseName, args) {
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
    // Wrangler's stderr can carry a local filesystem path, so it is summarised
    // rather than echoed into a diagnostic that may be pasted into an issue.
    fail(
      "LOCAL_D1_COMMAND_FAILED",
      `A local D1 command exited ${result.exitCode}. Re-run the same command manually to see Wrangler's output.`,
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

/** Applied records as they would be read from D1; also the rehearsal format. */
export function readStateFile(path) {
  if (!existsSync(path)) {
    fail("MISSING_STATE_FILE", "The applied-migration state file does not exist.");
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
  return parsed.map((record, index) => {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.id !== "string" ||
      typeof record.digest !== "string" ||
      typeof record.sequence !== "number"
    ) {
      fail("MALFORMED_STATE_FILE", `State record ${index} must carry id, sequence and digest.`);
    }
    return { id: record.id, sequence: record.sequence, digest: record.digest };
  });
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

    phase = "environment";
    const report = validateEnvironments(root);
    // Explicit selection: there is no default environment, so no command can
    // reach production by omission.
    const environment = selectEnvironment(report, options.env);

    phase = "plan";
    const migrations = readMigrationDirectory(join(root, "db/migrations"));
    const localDatabase = environment.kind === "local" ? "asimposium-local" : undefined;
    // A local environment has a real (miniflare) D1 available with no
    // credential, so its applied-records come from the database itself rather
    // than from a rehearsal file.
    const applied =
      options.state !== undefined
        ? readStateFile(resolve(root, options.state))
        : localDatabase !== undefined
          ? readLocalLedger(root, localDatabase)
          : [];
    const plan = planMigrations(migrations, applied, {
      environmentName: options.env,
      destructiveAllowed: environment.kind === "local" ? true : options.env !== "production",
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
        ? { code: error.code, detail: error.message }
        : { code: "UNEXPECTED", detail: "Unexpected migration failure." };
    process.stderr.write(`${JSON.stringify(diagnostic("fail", startedAt, phase, details))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
