#!/usr/bin/env bun
/**
 * OPS.2a D1 adapter — real local Cloudflare D1, real transaction, real rollback.
 *
 * This replaces an `ADAPTER_UNAVAILABLE` placeholder with an assertion that can
 * only pass if a genuine D1 transaction rolled back. It runs against workerd's
 * own SQLite through `wrangler d1 execute --local`. It deliberately does **not**
 * use `bun:sqlite` or any in-process double: the property under test is D1 batch
 * atomicity, and only D1 can demonstrate it.
 *
 * ## The proof
 *
 * 1. Seed a table with a sentinel row.
 * 2. Submit one batch that first inserts a row and *then* violates a UNIQUE
 *    constraint. The failure is planted **late**, after a successful write in
 *    the same batch, because an early failure would prove nothing about
 *    rollback — nothing would have been written yet.
 * 3. Read the table back in a separate invocation. The doomed row must be gone
 *    and the sentinel must remain.
 *
 * Reading state afterwards is the whole point: a batch that reports an error is
 * not evidence of rollback, only evidence of an error.
 *
 * ## Modes
 *
 * `--mode ok`            the batch contains the planted late failure; rollback
 *                        must be observed. Exits 0 only if it was.
 * `--mode planted-fail`  the same assertion runs against a batch with **no**
 *                        failing statement, so the row commits and the rollback
 *                        assertion correctly fails. This proves the check is
 *                        capable of failing rather than vacuously passing.
 *
 * Exits 78 with a named blocker when wrangler cannot run at all.
 *
 * Output is a single JSON line of bounded, non-secret fields. It never prints an
 * absolute path, an environment value, or SQL containing caller data.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  assertRetainedD1StateDirectory,
  assertRetainedIntegrationCapacity,
  MAX_D1_ADAPTER_STATE_BYTES,
  realFilesystemRetentionPreflight,
  repositoryRoot,
} from "../runner.ts";

const BLOCKED_EXIT_CODE = 78;
const DATABASE = "harness-ops2a";
const TABLE = "harness_rollback_probe";
/** Bound every wrangler invocation so a hung CLI cannot outlive the step. */
const WRANGLER_TIMEOUT_MS = 20_000;
/** A hostile D1 state tree must not turn the post-run audit into an unbounded walk. */
const MAX_D1_ADAPTER_STATE_ENTRIES = 2_048;

type Mode = "ok" | "planted-fail";

interface ExecResult {
  readonly ok: boolean;
  /** True only after Bun actually created the wrangler subprocess. */
  readonly executed: boolean;
  readonly errorClass: string | undefined;
}

function say(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ adapter: "d1", ...record })}\n`);
}

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..");

/**
 * A short, non-reversible tag for the disposable state directory.
 *
 * The absolute path names a machine and a user, so it never reaches a
 * diagnostic. A truncated digest of the final path segment is enough to tell
 * two runs apart without disclosing where either one lived.
 */
function stateDirDigest(stateDir: string): string {
  const leaf = basename(stateDir);
  return Bun.hash(leaf).toString(16).slice(0, 12);
}

/**
 * The adapter's direct JSON output is an audit surface. System errors often
 * include absolute paths, syscall arguments, and host-specific messages, so
 * they are classified before any diagnostic is emitted.
 */
function safeFilesystemClass(error: unknown): "access_denied" | "missing" | "unavailable" {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "access_denied";
  if (code === "ENOENT") return "missing";
  return "unavailable";
}

function safeFilesystemDetail(operation: string, error: unknown): string {
  const failure = safeFilesystemClass(error);
  if (failure === "access_denied") {
    return `${operation} was denied by the filesystem. No unsafe diagnostic text was retained.`;
  }
  if (failure === "missing") {
    return `${operation} could not find the already-authorized retained state location.`;
  }
  return `${operation} could not complete safely; no raw syscall diagnostic was emitted.`;
}

/**
 * Absolute path to wrangler's entry script, or undefined.
 *
 * The harness runs every child with a scrubbed PATH that contains only system
 * directories — it must, or a child could inherit an unlabelled secret from the
 * ambient environment. That means `bunx` is not resolvable, so this adapter
 * cannot rely on a PATH lookup and instead locates wrangler by absolute path
 * and runs it with `process.execPath`, which is absolute by construction.
 *
 * wrangler is a devDependency of `apps/wire`; the root is checked too in case a
 * future install hoists it.
 */
function resolveWranglerEntry(): string | undefined {
  const candidates = [
    join(REPOSITORY_ROOT, "apps", "wire", "node_modules", "wrangler", "bin", "wrangler.js"),
    join(REPOSITORY_ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function parseMode(argv: readonly string[]): Mode {
  const index = argv.indexOf("--mode");
  const value = index >= 0 ? argv[index + 1] : "ok";
  if (value !== "ok" && value !== "planted-fail") {
    say({
      status: "fail",
      code: "USAGE",
      detail:
        "usage: d1-rollback.ts --mode <ok|planted-fail> --state-dir <retained-integration-path> --integration-namespace <safe-component>",
    });
    process.exit(2);
  }
  return value;
}

/**
 * A real D1 probe never chooses its own state location. It must receive a
 * validated, direct child of a retained integration run that its parent has
 * already reserved. In particular this rejects `/tmp`, relative paths, nested
 * arbitrary directories, and an old state directory that would be reused.
 */
function parseStateDirectory(argv: readonly string[]): {
  stateDir: string;
  artifactNamespace: string;
} {
  const index = argv.indexOf("--state-dir");
  const value = index >= 0 ? argv[index + 1] : undefined;
  const namespaceIndex = argv.indexOf("--integration-namespace");
  const artifactNamespace = namespaceIndex >= 0 ? argv[namespaceIndex + 1] : undefined;
  if (
    argv.length !== 6 ||
    argv[0] !== "--mode" ||
    (argv[1] !== "ok" && argv[1] !== "planted-fail") ||
    index !== 2 ||
    typeof value !== "string" ||
    value.length === 0 ||
    namespaceIndex !== 4 ||
    typeof artifactNamespace !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(artifactNamespace)
  ) {
    say({
      status: "fail",
      code: "USAGE",
      detail:
        "usage: d1-rollback.ts --mode <ok|planted-fail> --state-dir <retained-integration-path> --integration-namespace <safe-component>",
    });
    process.exit(2);
  }
  try {
    const stateDir = assertRetainedD1StateDirectory(REPOSITORY_ROOT, value);
    if (integrationNamespaceForState(stateDir) !== artifactNamespace) {
      throw new Error("D1 state namespace does not match the explicit integration namespace");
    }
    return { stateDir, artifactNamespace };
  } catch (error) {
    say({
      status: "fail",
      code: "D1_STATE_DIRECTORY_INVALID",
      detail: safeFilesystemDetail("D1 state path validation", error),
    });
    process.exit(2);
  }
}

/**
 * Count retained D1 bytes without following a symlink or disclosing a path.
 *
 * The audit is deliberately bounded: once the exact at-cap condition is
 * reached it has enough information to refuse further work, and must not turn
 * an overgrown retained tree into an unbounded recursive scan.
 */
function stateUsage(directory: string): {
  bytes: number;
  files: number;
  entries: number;
  truncated: boolean;
} {
  let bytes = 0;
  let files = 0;
  let entries = 0;
  let truncated = false;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (bytes >= MAX_D1_ADAPTER_STATE_BYTES || entries >= MAX_D1_ADAPTER_STATE_ENTRIES) {
        truncated = true;
        return;
      }
      if (!/^[.A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) {
        throw new Error("unsafe_state_entry_name");
      }
      entries += 1;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("unsafe_state_symlink");
      if (entry.isDirectory()) {
        walk(path);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) throw new Error("unsafe_state_entry");
      bytes += statSync(path).size;
      files += 1;
      if (bytes >= MAX_D1_ADAPTER_STATE_BYTES || entries >= MAX_D1_ADAPTER_STATE_ENTRIES) {
        truncated = true;
        return;
      }
    }
  };
  walk(directory);
  return { bytes, files, entries, truncated };
}

/** Create exactly the already-authorized state leaf, never an arbitrary parent. */
function prepareStateDirectory(stateDir: string): void {
  const parent = dirname(stateDir);
  if (
    !existsSync(parent) ||
    lstatSync(parent).isSymbolicLink() ||
    !lstatSync(parent).isDirectory()
  ) {
    throw new Error(
      "the retained integration run directory must already exist as a real directory",
    );
  }
  if (existsSync(stateDir)) {
    throw new Error(
      "the retained D1 state directory already exists and will not be reused or overwritten",
    );
  }
  mkdirSync(stateDir);
}

function integrationNamespaceForState(stateDir: string): string {
  const artifacts = join(REPOSITORY_ROOT, "e2e", "artifacts");
  const namespace = relative(artifacts, stateDir).split(sep)[0];
  if (namespace === undefined) throw new Error("D1 state is missing an integration namespace");
  return namespace;
}

function integrationDirectoryForState(stateDir: string): string {
  return join(REPOSITORY_ROOT, "e2e", "artifacts", integrationNamespaceForState(stateDir));
}

/**
 * Classify a wrangler failure without echoing its output.
 *
 * The stderr of a CLI can contain an absolute path or an account hint, so only
 * a fixed vocabulary of classes reaches the diagnostic.
 */
function classifyFailure(text: string): string {
  if (/UNIQUE constraint failed/i.test(text)) return "sqlite_constraint_unique";
  if (/no such table/i.test(text)) return "sqlite_no_such_table";
  if (/not found|ENOENT|command not found/i.test(text)) return "wrangler_missing";
  return "unclassified";
}

interface WranglerRun {
  readonly ok: boolean;
  readonly executed: boolean;
  readonly stdout: string;
  readonly errorClass: string | undefined;
}

/**
 * Run one bounded `wrangler d1 execute --local` and capture its JSON.
 *
 * The child gets a fixed, minimal environment. `HOME` points at the disposable
 * state directory so wrangler's cache is hermetic and this probe can never read
 * or write the developer's real Wrangler configuration.
 */
async function wrangler(
  entry: string,
  stateDir: string,
  configPath: string,
  sql: string,
): Promise<WranglerRun> {
  // Narrowed to the stdio shape actually requested below, so `child.stdout` and
  // `child.stderr` are ReadableStreams rather than the general union that also
  // admits a file descriptor number or undefined.
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [
        process.execPath,
        entry,
        "d1",
        "execute",
        DATABASE,
        "--local",
        "--persist-to",
        join(stateDir, ".state"),
        "--config",
        configPath,
        "--command",
        sql,
        "--json",
      ],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: stateDir,
        LANG: "C",
        TZ: "UTC",
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
      },
    });
  } catch (error) {
    return {
      ok: false,
      executed: false,
      stdout: "",
      errorClass: error instanceof Error ? "spawn_failed" : "unclassified",
    };
  }
  const watchdog = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, WRANGLER_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(watchdog);
  const succeeded = exitCode === 0 && !/"error"/.test(stdout);
  return {
    ok: succeeded,
    executed: true,
    stdout,
    errorClass: succeeded ? undefined : classifyFailure(`${stdout}\n${stderr}`),
  };
}

async function execute(
  entry: string,
  stateDir: string,
  configPath: string,
  sql: string,
): Promise<ExecResult> {
  const run = await wrangler(entry, stateDir, configPath, sql);
  return { ok: run.ok, executed: run.executed, errorClass: run.errorClass };
}

async function readRows(
  entry: string,
  stateDir: string,
  configPath: string,
): Promise<{ readonly executed: boolean; readonly rows: string[] }> {
  const run = await wrangler(
    entry,
    stateDir,
    configPath,
    `SELECT label FROM ${TABLE} ORDER BY id;`,
  );
  try {
    const parsed = JSON.parse(run.stdout) as { results?: { label?: string }[] }[];
    return {
      executed: run.executed,
      rows: (parsed[0]?.results ?? []).map((row) => String(row.label)),
    };
  } catch {
    return { executed: run.executed, rows: [] };
  }
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  const { stateDir, artifactNamespace } = parseStateDirectory(process.argv.slice(2));

  // The adapter repeats the write-free real-authority/capacity preflight so a
  // copied command cannot bypass its parent runner and create state at a cap.
  // This runs before the namespace leaf or any state/config file is created.
  const capacity = realFilesystemRetentionPreflight(repositoryRoot(), undefined, artifactNamespace);
  if (capacity.exceeded) {
    say({
      status: "blocked",
      code: "ARTIFACT_RETENTION_EXCEEDED",
      detail:
        "No D1 state was created: retained integration preflight is at capacity. " +
        capacity.remedy,
    });
    return BLOCKED_EXIT_CODE;
  }

  const wranglerEntry = resolveWranglerEntry();
  if (wranglerEntry === undefined) {
    say({
      status: "blocked",
      code: "D1_ADAPTER_UNAVAILABLE",
      missing: "wrangler",
      detail:
        "wrangler does not resolve from this checkout (expected apps/wire/node_modules/wrangler); install the workspace. No D1 behavior was exercised.",
    });
    return BLOCKED_EXIT_CODE;
  }

  try {
    // Reserve the state leaf and a bounded maximum before the adapter creates
    // either the directory or its first config/database byte. The parent run
    // id, self-test ids, resume ids, cases, and retained staging all appear in
    // the same recursive accounting report.
    assertRetainedIntegrationCapacity(integrationDirectoryForState(stateDir), {
      additionalDirectories: 1,
      additionalBytes: MAX_D1_ADAPTER_STATE_BYTES,
    });
  } catch {
    say({
      status: "blocked",
      code: "INTEGRATION_RETENTION_EXCEEDED",
      detail:
        "No D1 state was created because retained integration capacity is insufficient. " +
        "Inspect the retained integration evidence before an explicit archive or move.",
    });
    return BLOCKED_EXIT_CODE;
  }

  try {
    prepareStateDirectory(stateDir);
  } catch (error) {
    say({
      status: "fail",
      code: "D1_STATE_DIRECTORY_INVALID",
      detail: safeFilesystemDetail("D1 state directory preparation", error),
    });
    return 2;
  }
  const configPath = join(stateDir, "wrangler.toml");
  try {
    writeFileSync(
      configPath,
      [
        `name = "harness-ops2a-d1"`,
        `compatibility_date = "2026-08-13"`,
        ``,
        `[[d1_databases]]`,
        `binding = "DB"`,
        `database_name = "${DATABASE}"`,
        `database_id = "00000000-0000-0000-0000-000000000000"`,
        ``,
      ].join("\n"),
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    say({
      status: "blocked",
      code: "D1_STATE_WRITE_DENIED",
      syscall_class: safeFilesystemClass(error),
      detail: safeFilesystemDetail("D1 state configuration write", error),
    });
    return BLOCKED_EXIT_CODE;
  }

  const seeded = await execute(
    wranglerEntry,
    stateDir,
    configPath,
    `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE);` +
      ` INSERT INTO ${TABLE} (id, label) VALUES (1, 'sentinel');`,
  );
  if (!seeded.ok) {
    // No database means the adapter cannot run at all — a blocker, not a failure.
    say({
      status: "blocked",
      code: "D1_ADAPTER_UNAVAILABLE",
      error_class: seeded.errorClass,
      detail:
        "wrangler could not open a local D1 database; install the pinned wrangler and retry. No D1 behavior was exercised.",
    });
    return BLOCKED_EXIT_CODE;
  }

  // The transaction under test. In `ok` mode the second statement violates the
  // UNIQUE constraint *after* the first has already written — a late failure.
  const doomedBatch =
    mode === "ok"
      ? `INSERT INTO ${TABLE} (id, label) VALUES (2, 'doomed');` +
        ` INSERT INTO ${TABLE} (id, label) VALUES (3, 'sentinel');`
      : `INSERT INTO ${TABLE} (id, label) VALUES (2, 'doomed');`;
  const batch = await execute(wranglerEntry, stateDir, configPath, doomedBatch);

  const postRead = await readRows(wranglerEntry, stateDir, configPath);
  const labels = postRead.rows;
  const doomedSurvived = labels.includes("doomed");
  const sentinelIntact = labels.includes("sentinel");
  const sentinelOnly = labels.length === 1 && labels[0] === "sentinel";
  const lateFailureObserved =
    batch.executed && !batch.ok && batch.errorClass === "sqlite_constraint_unique";
  const rolledBack =
    mode === "ok" && seeded.executed && lateFailureObserved && postRead.executed && sentinelOnly;
  let usage: { bytes: number; files: number; entries: number; truncated: boolean } | undefined;
  try {
    usage = stateUsage(stateDir);
  } catch (error) {
    say({
      status: "fail",
      code: "D1_STATE_AUDIT_UNSAFE",
      syscall_class: safeFilesystemClass(error),
      detail: safeFilesystemDetail("D1 retained-state audit", error),
    });
    return 1;
  }
  if (usage.bytes >= MAX_D1_ADAPTER_STATE_BYTES) {
    say({
      status: "fail",
      code: "D1_STATE_CAPACITY_EXCEEDED",
      state_bytes: usage.bytes,
      state_byte_limit: MAX_D1_ADAPTER_STATE_BYTES,
      state_audit_truncated: usage.truncated,
      detail:
        "The retained D1 state exceeded its reserved byte ceiling; evidence was retained and no further state was created.",
    });
    return 1;
  }
  if (usage.entries >= MAX_D1_ADAPTER_STATE_ENTRIES) {
    say({
      status: "fail",
      code: "D1_STATE_AUDIT_ENTRY_LIMIT",
      state_entries: usage.entries,
      state_entry_limit: MAX_D1_ADAPTER_STATE_ENTRIES,
      state_audit_truncated: usage.truncated,
      detail:
        "The retained D1 state reached the bounded audit entry limit; no further audit or write was attempted.",
    });
    return 1;
  }
  try {
    // Re-audit after workerd has written its state. The reservation prevents
    // ordinary overgrowth; this catches a concurrent writer or an unexpected
    // implementation expansion without modifying the retained evidence.
    assertRetainedIntegrationCapacity(integrationDirectoryForState(stateDir));
  } catch {
    say({
      status: "fail",
      code: "INTEGRATION_RETENTION_EXCEEDED_AFTER_D1",
      state_bytes: usage.bytes,
      detail:
        "D1 completed, but the retained integration census is now over its cap; no cleanup or further write was attempted.",
    });
    return 1;
  }

  say({
    status: rolledBack ? "pass" : "fail",
    code: rolledBack ? "D1_TRANSACTION_ROLLED_BACK" : "D1_TRANSACTION_LEAKED",
    mode,
    batch_rejected: !batch.ok,
    batch_error_class: batch.errorClass ?? null,
    seed_command_executed: seeded.executed,
    batch_command_executed: batch.executed,
    post_read_command_executed: postRead.executed,
    late_failure_observed: lateFailureObserved,
    rows_after: labels.length,
    doomed_row_present: doomedSurvived,
    sentinel_present: sentinelIntact,
    sentinel_only_after: sentinelOnly,
    state_bytes: usage.bytes,
    state_files: usage.files,
    state_entries: usage.entries,
    state_audit_truncated: usage.truncated,
    // Path *class* and a short digest of the directory name, never the path
    // itself: enough to correlate two runs, useless for locating a machine.
    state_dir_class: "retained-integration",
    state_dir_digest: stateDirDigest(stateDir),
    detail: rolledBack
      ? "A late failure inside one D1 batch rolled back the earlier write in the same batch; state was re-read to confirm."
      : mode === "planted-fail"
        ? "PLANTED: no late constraint failure was supplied, so the earlier write remained and the rollback assertion failed."
        : "The late D1 constraint failure, exact post-read sentinel state, or both rollback witnesses were absent.",
  });
  return rolledBack ? 0 : 1;
}

process.exit(await main());
