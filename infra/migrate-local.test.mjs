import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  assertReadLimit,
  authenticateLocalOwnerLease,
  bootstrapInstallSql,
  REMOTE_D1_SCHEDULING_MARGIN_MS as CLEANUP_SCHEDULING_MARGIN_MS,
  catalogFingerprint,
  classifySchemaLineage,
  digestOf,
  LOCAL_D1_KILL_REAP_MS as KILL_REAP_MS,
  LEDGER_TABLE,
  LINEAGE_TABLE,
  localD1StdoutOrRefuse,
  MAX_CATALOG_ROWS,
  MAX_JOURNAL_ROWS,
  MAX_LINEAGE_ROWS,
  MigrationError,
  migrationCommandSql,
  LOCAL_D1_PIPE_DRAIN_MS as OUTPUT_DRAIN_MS,
  OWNED_PROCESS_GROUP,
  LOCAL_D1_OWNER_LEASE_CLOSE_RESERVE_MS as OWNER_LEASE_CLOSE_RESERVE_MS,
  LOCAL_OWNER_LEASE_HANDSHAKE_MS as OWNER_LEASE_HANDSHAKE_MS,
  ownedProcessGroupExists,
  PARENT_PROCESS_GROUP,
  planMigrations,
  readBootstrapManifest,
  readMigrationDirectory,
  redactStderr,
  resolvePinnedWranglerCommand,
  runBoundedCommand,
  runLocalD1Command,
  runMigrationCli,
  LOCAL_D1_CLEANUP_RESERVE_MS as SHIPPED_LOCAL_CLEANUP_RESERVE_MS,
  LOCAL_D1_COMMAND_WINDOW_MS as SHIPPED_LOCAL_COMMAND_WINDOW_MS,
  LOCAL_D1_EXECUTION_FLOOR_MS as SHIPPED_LOCAL_EXECUTION_FLOOR_MS,
  LOCAL_D1_TERM_GRACE_MS as TERMINATE_GRACE_MS,
} from "./migrate.mjs";

/**
 * Integration suite: this one DOES touch local D1 through Wrangler/workerd.
 *
 * It does not contact remote D1 or start a long-lived Worker. Every command is
 * `wrangler d1 execute --local`, bounded independently and as one suite. The
 * persistence directory is unique, outside the repository, and deliberately
 * retained so a failure can be inspected without any cleanup/delete path.
 */

const startedAt = performance.now();
const reproduce = "bun infra/migrate-local.test.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const persistenceRoot = resolve(
  tmpdir(),
  `asimposium-migrate-local-${randomUUID().replaceAll("-", "")}`,
);
const PER_COMMAND_TIMEOUT_MS = 15_000;
// Keep every sequential bounded cleanup window used by `runBoundedCommand` in
// `infra/migrate.mjs`: owner-lease FileSink close; TERM grace; SIGKILL reap;
// termination drain; direct-child reap; final pipe drain; and bounded
// pipe-cancellation settlement.
const COMMAND_CONTAINMENT_RESERVE_MS =
  OWNER_LEASE_CLOSE_RESERVE_MS + TERMINATE_GRACE_MS + KILL_REAP_MS * 3 + OUTPUT_DRAIN_MS * 2;
const COMMAND_REAP_RESERVE_MS = COMMAND_CONTAINMENT_RESERVE_MS + CLEANUP_SCHEDULING_MARGIN_MS;
/**
 * The smallest execution window worth spawning a local D1 command into.
 *
 * The reap reserve alone is NOT a floor on execution: it only reserves the tail
 * needed to terminate a child, so a nearly exhausted whole-suite budget still
 * cleared it and handed a real `wrangler d1 execute` a window far too small to
 * finish in. The command then timed out and was reported as
 * "did not complete through the bounded executor" — a statement about the
 * MIGRATION, when the actual cause was the suite budget being spent. That
 * misattribution is the defect: a reader is sent to the migration and to
 * Wrangler for a failure neither one caused.
 *
 * This mirrors `REMOTE_D1_EXECUTION_FLOOR_MS` in `infra/migrate.mjs`, where the
 * same rule already refuses BEFORE the spawn rather than starting a command the
 * remaining budget cannot contain. Refusing early is the only point at which the
 * distinction is still recoverable; once a doomed child is running, every
 * outcome looks like a command failure.
 */
const LOCAL_D1_EXECUTION_FLOOR_MS = 3_000;
const LOCAL_D1_COMMAND_WINDOW_MS = COMMAND_REAP_RESERVE_MS + LOCAL_D1_EXECUTION_FLOOR_MS;
const TOTAL_TIMEOUT_MS = 180_000;
const deadlineAt = startedAt + TOTAL_TIMEOUT_MS;
const appliedAt = "2026-08-16T00:00:00.000Z";
const localConfigPaths = new Map();

const migrations = readMigrationDirectory(resolve(root, "db/migrations"));
const migrationBySequence = new Map(migrations.map((migration) => [migration.sequence, migration]));
const migration0015 = migrationBySequence.get(15);
const bootstrapManifest = readBootstrapManifest(root);
const bootstrapArtifact = bootstrapManifest.artifacts[0];
assert.ok(migration0015, "0015 must exist before the local rollback gate can run");
assert.equal(
  migration0015.id,
  "0015_sponsor_enrollment_bootstrap_invariant.sql",
  "sequence 0015 must remain the sponsor-bootstrap invariant",
);

const localPlanOptions = { environmentName: "local", destructiveAllowed: true };

const MIGRATION_OBJECTS = [
  "sponsor_enrollment_bootstrap_migration_witness",
  "sponsor_enrollment_bootstrap_migration_witness_immutable_update",
  "sponsor_enrollment_bootstrap_migration_witness_immutable_delete",
  "enrollment_proposals_sponsor_bootstrap_decision",
  "enrollment_fellows_sponsor_bootstrap_insert",
  "enrollment_grants_sponsor_bootstrap_insert",
  "sponsors_enrollment_authority_delete",
  "sponsors_identity_history_immutable",
  "sponsors_enrollment_authority_duplicate_insert",
];
const MIGRATION_TRIGGERS = MIGRATION_OBJECTS.slice(1);

const fixture = {
  sponsorId: "usr_migrate_0015",
  enrollmentId: "ASIMP-EN-0123456789ABCDEF",
  proposalId: "proposal-0015",
  fellowId: "fellow-0015",
  fellowName: "migrate-fellow",
  model: "test-model",
  harness: "wrangler-test",
  secretHash: "a".repeat(64),
  flowHandleHash: "b".repeat(64),
  scopesJson: '["review"]',
  resourcesJson: "{}",
  createdAt: 1_700_000_000_000,
};

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function hexLiteral(value) {
  return sqlLiteral(Buffer.from(value, "utf8").toString("hex").toUpperCase());
}

function uniqueDatabaseName(label) {
  return `asimposium-local-${label}-${randomUUID().replaceAll("-", "")}`;
}

function localConfigPath(databaseName) {
  const existing = localConfigPaths.get(databaseName);
  if (existing !== undefined) return existing;

  // Wrangler resolves `d1 execute <name>` only through the supplied config;
  // the repository config deliberately names its shared developer database.
  // A unique, retained external config is therefore necessary to make each
  // integration case address an isolated local D1 without mutating the repo.
  mkdirSync(persistenceRoot, { recursive: true });
  const configPath = resolve(persistenceRoot, `${databaseName}.toml`);
  writeFileSync(
    configPath,
    `name = ${sqlLiteral(databaseName)}\ncompatibility_date = "2026-08-08"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = ${sqlLiteral(databaseName)}\ndatabase_id = ${sqlLiteral(randomUUID())}\n`,
    "utf8",
  );
  localConfigPaths.set(databaseName, configPath);
  return configPath;
}

function commandDeadline(observedAt = performance.now()) {
  const suiteRemainingMs = Math.max(0, Math.floor(deadlineAt - observedAt));
  const remainingMs = Math.min(PER_COMMAND_TIMEOUT_MS, suiteRemainingMs);
  return { deadlineAt: observedAt + remainingMs, remainingMs };
}

/**
 * Decide, from the remaining budget alone, whether a command may start.
 *
 * PURE on purpose. The allocation is the whole decision, so keeping it free of
 * clocks, spawns and I/O is what lets the boundary be proven at exact values
 * instead of provoked by timing. Every spawn site below takes its `timeoutMs`
 * from this function's window, so a refusal is structurally the only way for a
 * truncated budget to reach a child: there is no second path to a timeout.
 */
function localExecutionAllocation(remainingMs) {
  const executionWindowMs = Math.max(0, remainingMs - COMMAND_REAP_RESERVE_MS);
  if (executionWindowMs < LOCAL_D1_EXECUTION_FLOOR_MS) {
    return { kind: "budget-exhausted", remainingMs, executionWindowMs };
  }
  return { kind: "ok", remainingMs, executionWindowMs };
}

/**
 * The window a command may use, or a typed refusal naming the real cause.
 *
 * The code is distinct from `LOCAL_D1_COMMAND_TIMEOUT` and
 * `LOCAL_D1_COMMAND_FAILED` precisely so the two cannot be confused again: this
 * one says the SUITE ran out of budget and nothing was started, which is a fact
 * about the harness, not about the migration it was about to apply.
 */
function localExecutionWindowOrRefuse(remainingMs, label) {
  const allocation = localExecutionAllocation(remainingMs);
  if (allocation.kind !== "ok") {
    throw new MigrationError(
      "LOCAL_D1_SUITE_BUDGET_EXHAUSTED",
      `The local D1 suite budget left ${allocation.remainingMs}ms total for ${label}, providing ${allocation.executionWindowMs}ms for execution after its ${COMMAND_REAP_RESERVE_MS}ms cleanup reserve, below the ${LOCAL_D1_EXECUTION_FLOOR_MS}ms execution floor; no command was started.`,
    );
  }
  return allocation.executionWindowMs;
}

/**
 * The ONE pre-spawn seam. Every local child in this file is started here.
 *
 * Sharing it is what makes "a doomed command is never started" provable rather
 * than merely arranged: the guard and the spawn are the same two lines for every
 * caller, so there is no second site that could compute a window differently and
 * quietly reintroduce the truncated-window launch.
 *
 * `runner`, `remainingMs`, `observedAt`, and `epochNow` are injectable ONLY so
 * the boundary can be driven at an exact budget with a runner that records
 * entry. Production callers pass none of them and get the real bounded executor
 * and the real shared deadline, so the seam a plant exercises is the seam that
 * ships.
 */
async function runBoundedLocalCommand(
  label,
  command,
  { runner, remainingMs, observedAt, epochNow = Date.now } = {},
) {
  const remaining = remainingMs ?? commandDeadline(observedAt).remainingMs;
  // The refusal happens HERE, before `runner` is named on the next line. That
  // ordering is the property under test: a plant whose runner counts entries
  // must observe zero.
  const timeoutMs = localExecutionWindowOrRefuse(remaining, label);
  const preparedCommand =
    typeof command === "function"
      ? command({ deadlineAtMs: epochNow() + timeoutMs, timeoutMs })
      : command;
  return await (runner ?? runBoundedCommand)({ ...preparedCommand, timeoutMs });
}

/**
 * This uses the shipped bounded executor with an outside-repository persistence
 * root, so this integration lane exercises the same group/pipe containment as
 * the real local migration CLI while retaining its isolated test databases.
 */
async function boundedLocalD1(
  databaseName,
  args,
  label,
  configPath = localConfigPath(databaseName),
) {
  const result = await runBoundedLocalCommand(label, {
    cmd: [
      ...resolvePinnedWranglerCommand(root),
      "d1",
      "execute",
      databaseName,
      "--local",
      "--config",
      configPath,
      "--persist-to",
      persistenceRoot,
      "--json",
      ...args,
    ],
    cwd: root,
  });
  if (result.outcome !== "exited") {
    throw new MigrationError(
      result.outcome === "timeout" ? "LOCAL_D1_COMMAND_TIMEOUT" : "LOCAL_D1_COMMAND_FAILED",
      `Local D1 ${label} did not complete through the bounded executor.`,
    );
  }
  if (result.exitCode !== 0) {
    const safeStderr = redactStderr(result.stderr);
    const safeStdout = redactStderr(result.stdout);
    throw new MigrationError(
      "LOCAL_D1_COMMAND_FAILED",
      `A local D1 ${label} command failed.`,
      safeStderr !== ""
        ? { output: safeStderr, stream: "stderr" }
        : { output: safeStdout, stream: "stdout" },
    );
  }
  return result.stdout;
}

async function localJson(databaseName, command, label) {
  const raw = await boundedLocalD1(databaseName, ["--command", command], label);
  try {
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed), `local D1 ${label} must return a JSON result array`);
    return parsed;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.fail(`local D1 ${label} must return parseable JSON`);
  }
}

async function runnerConfigJson(command, label) {
  const raw = await boundedLocalD1(
    "asimposium-local",
    ["--command", command],
    label,
    "infra/wrangler.toml",
  );
  try {
    const parsed = JSON.parse(raw);
    assert.ok(
      Array.isArray(parsed),
      `runner-config local D1 ${label} must return a JSON result array`,
    );
    return parsed;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.fail(`runner-config local D1 ${label} must return parseable JSON`);
  }
}

async function runActualLocalMigrationCli(args, label, commandOptions = undefined) {
  const result = await runBoundedLocalCommand(
    label,
    ({ deadlineAtMs }) => ({
      cmd: [
        process.execPath,
        "infra/migrate.mjs",
        ...args,
        "--local-command-deadline-at-ms",
        String(deadlineAtMs),
      ],
      cwd: root,
      ownerLeaseDeadlineAtMs: deadlineAtMs,
    }),
    commandOptions,
  );
  assert.equal(result.outcome, "exited", `actual local CLI ${label} must exit normally`);
  try {
    return {
      exitCode: result.exitCode,
      diagnostic: JSON.parse((result.exitCode === 0 ? result.stdout : result.stderr).trim()),
    };
  } catch {
    assert.fail(`actual local CLI ${label} must emit one JSON diagnostic`);
  }
}

const PARENT_OWNED_TOPOLOGY_FIXTURE = "--parent-owned-topology-fixture";
const OWNER_LEASE_EOF_FIXTURE = "--owner-lease-eof-fixture";
const OWNER_WATCHDOG_PREFIX = "ASIMP_LOCAL_OWNER_WATCHDOG_V1";
const OWNER_REFUSAL_PREFIX = "ASIMP_LOCAL_OWNER_REFUSED_V1";

function fakeOwnerWatchdogSpawn(frame, { observation = {}, stdout: suppliedStdout } = {}) {
  return (options) => {
    assert.equal(options.stdin, "inherit");
    assert.equal(options.stdout, "pipe");
    assert.equal(options.detached, false);
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const stdout =
      suppliedStdout ??
      new ReadableStream({
        start(controller) {
          if (typeof frame === "string") {
            controller.enqueue(new TextEncoder().encode(frame));
          } else if (frame === null) {
            controller.close();
          }
        },
      });
    return {
      exited,
      stdout,
      kill: (signal) => {
        observation.kills ??= [];
        observation.kills.push(signal);
        resolveExit(1);
      },
      unref: () => {
        observation.unrefs = (observation.unrefs ?? 0) + 1;
      },
    };
  };
}

function authenticatedOwnerWatchdogFrame(deadlineAtMs, nonce = "a".repeat(64)) {
  return `${OWNER_WATCHDOG_PREFIX} ${nonce} ${deadlineAtMs}\n`;
}

async function runShippedOwnerWatchdogPreauthPlant({
  endAfterInput,
  expectedCode,
  expectedFrame,
  input,
}) {
  let actualWatchdog;
  let ownerWriter;
  let writeSettled = Promise.resolve(undefined);
  let writeFailure;
  let observedStdout = "";
  let refusal;
  try {
    await authenticateLocalOwnerLease(Date.now() + 5_000, {
      handshakeMs: OWNER_LEASE_HANDSHAKE_MS + 1_000,
      processLeadsOwnedGroup: () => true,
      spawn: (options) => {
        assert.equal(options.stdin, "inherit");
        assert.equal(options.detached, false);
        actualWatchdog = Bun.spawn({ ...options, detached: true, stdin: "pipe" });
        ownerWriter = actualWatchdog.stdin;
        const stdout = actualWatchdog.stdout.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              observedStdout += new TextDecoder().decode(chunk);
              controller.enqueue(chunk);
            },
          }),
        );
        writeSettled = (async () => {
          if (input !== "") {
            await ownerWriter.write(input);
            await ownerWriter.flush();
          }
          if (endAfterInput) await ownerWriter.end();
        })().then(
          () => undefined,
          (error) => error,
        );
        return {
          exited: actualWatchdog.exited,
          kill: (signal) => actualWatchdog.kill(signal),
          stdout,
          unref: () => actualWatchdog.unref(),
        };
      },
    });
    assert.fail(`${expectedCode} shipped watchdog plant must refuse`);
  } catch (error) {
    refusal = error;
  } finally {
    writeFailure = await writeSettled;
    if (!endAfterInput && ownerWriter !== undefined) {
      try {
        await ownerWriter.end();
      } catch {}
    }
  }
  if (writeFailure instanceof Error && writeFailure?.code !== "EPIPE") throw writeFailure;
  assert.ok(refusal instanceof MigrationError);
  assert.equal(refusal.code, expectedCode);
  assert.equal(observedStdout, expectedFrame);
  const reaped = await Promise.race([
    actualWatchdog.exited.then(() => true),
    Bun.sleep(100).then(() => false),
  ]);
  if (!reaped) {
    try {
      process.kill(-actualWatchdog.pid, "SIGKILL");
    } catch {
      try {
        actualWatchdog.kill("SIGKILL");
      } catch {}
    }
    await Promise.race([actualWatchdog.exited, Bun.sleep(500)]);
  }
  assert.equal(reaped, true, `${expectedCode} watchdog was not reaped before refusal receipt`);
}

async function runOwnerLeaseWriteFailurePlant(failureMode) {
  const events = [];
  const stdout = new ReadableStream({
    cancel() {
      events.push("stdout-cancel");
    },
  });
  const stderr = new ReadableStream({
    cancel() {
      events.push("stderr-cancel");
    },
  });
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let groupAlive = true;
  const epipe = () => Object.assign(new Error(`synthetic ${failureMode} EPIPE`), { code: "EPIPE" });
  const failAt = (operation) => {
    if (failureMode === `sync-${operation}`) throw epipe();
    if (failureMode === `async-${operation}`) return Promise.reject(epipe());
    return undefined;
  };
  const writer = {
    write() {
      events.push("write");
      return failAt("write");
    },
    flush() {
      events.push("flush");
      return failAt("flush");
    },
    ref() {
      events.push("ref");
      return failAt("ref");
    },
    end() {
      events.push("end");
    },
  };
  const result = await runBoundedCommand({
    cmd: [process.execPath, "--version"],
    cwd: root,
    timeoutMs: 20,
    termGraceMs: 0,
    killReapMs: 10,
    pipeDrainMs: 10,
    ownerLeaseDeadlineAtMs: 1,
    ownerLeaseNonce: () => "b".repeat(64),
    spawn: (options) => {
      assert.equal(options.stdin, "pipe");
      assert.equal(options.detached, true);
      return { pid: 91_101, exited, stdin: writer, stdout, stderr };
    },
    signalGroup: (_child, signal) => {
      events.push(signal);
      if (signal === "SIGKILL") {
        groupAlive = false;
        resolveExit(137);
      }
    },
    groupExists: () => groupAlive,
    toolEnvironment: {},
  });
  return { events, result, stderr, stdout };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function runParentOwnedTopologyFixture(deadlineAtMs) {
  const ownerLease = await authenticateLocalOwnerLease(deadlineAtMs);
  mkdirSync(persistenceRoot, { recursive: true });
  const pidRecordPath = resolve(persistenceRoot, `owned-topology-${randomUUID()}.json`);
  process.stdout.write(`${pidRecordPath}\n`);
  const descendantSource = `
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(124), 20_000);
setInterval(() => {}, 1_000);
process.stdout.write("ready\\n");
`;
  const directChildSource = `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(124), 20_000);
setInterval(() => {}, 1_000);
const descendant = Bun.spawn({
  cmd: [process.execPath, "-e", ${JSON.stringify(descendantSource)}],
  detached: false,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "ignore",
});
const reader = descendant.stdout.getReader();
let acknowledgement = "";
while (!acknowledgement.includes("\\n") && acknowledgement.length <= 16) {
  const chunk = await reader.read();
  if (chunk.done) break;
  acknowledgement += new TextDecoder().decode(chunk.value);
}
reader.releaseLock();
if (acknowledgement !== "ready\\n") process.exit(125);
writeFileSync(
  process.env.ASIMP_TOPOLOGY_PID_PATH,
  JSON.stringify({ direct_child: process.pid, descendant: descendant.pid }),
  "utf8",
);
`;
  void runLocalD1Command(
    {
      cmd: [process.execPath, "-e", directChildSource],
      cwd: root,
      toolEnvironment: { ASIMP_TOPOLOGY_PID_PATH: pidRecordPath },
    },
    { deadlineAtMs, ownerLease },
  );

  const readinessDeadline = Date.now() + 3_000;
  while (!existsSync(pidRecordPath) && Date.now() < readinessDeadline) {
    await Bun.sleep(10);
  }
  if (!existsSync(pidRecordPath)) process.exit(125);

  // Stall beyond both deadlines. The inner JavaScript timer cannot fire, so
  // only the independent outer controller can retire this process, its direct
  // child, and the TERM-resistant descendant in their one owned group.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
  process.exit(124);
}

async function runOwnerLeaseEofFixture(deadlineAtMs) {
  const ownerLease = await authenticateLocalOwnerLease(deadlineAtMs);
  await runLocalD1Command(
    { cmd: [process.execPath, "--version"], cwd: root },
    {
      deadlineAtMs,
      ownerLease,
      runner: (options) => {
        assert.equal(options.ownershipMode, PARENT_PROCESS_GROUP);
        return { outcome: "exited", exitCode: 0, stderr: "", stdout: "" };
      },
    },
  );
  const descendantSource = `
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(124), 5_000);
setInterval(() => {}, 1_000);
process.stdout.write("ready\\n");
`;
  const descendant = Bun.spawn({
    cmd: [process.execPath, "-e", descendantSource],
    detached: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = descendant.stdout.getReader();
  let acknowledgement = "";
  try {
    while (!acknowledgement.includes("\n") && acknowledgement.length <= 16) {
      const chunk = await reader.read();
      if (chunk.done) break;
      acknowledgement += new TextDecoder().decode(chunk.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
  if (acknowledgement !== "ready\n") process.exit(125);
  descendant.unref();
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(`${JSON.stringify({ descendant: descendant.pid })}\n`, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function oneRow(result, label) {
  const row = result?.find((statement) => statement?.results?.[0] !== undefined)?.results?.[0];
  assert.ok(row !== undefined && row !== null, `local D1 ${label} must return one row`);
  return row;
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  digest TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

function migrationJournalCommand(migration) {
  // Exercise the runner's actual production command seam. A local duplicate
  // would not prove the real journal append stays coupled to the migration.
  return migrationCommandSql(migration, appliedAt);
}

async function applyMigration(databaseName, sequence) {
  const migration = migrationBySequence.get(sequence);
  assert.ok(migration, `migration ${sequence} must exist`);
  await localJson(databaseName, migrationJournalCommand(migration), `apply-${sequence}`);
}

async function applyMigrations(databaseName, first, last) {
  for (let sequence = first; sequence <= last; sequence += 1) {
    await applyMigration(databaseName, sequence);
  }
}

const CATALOG_QUERY = `SELECT type, name, tbl_name, sql
  FROM sqlite_schema
 ORDER BY type, name
 LIMIT ${MAX_CATALOG_ROWS + 1};`;
const JOURNAL_QUERY = `SELECT id, sequence, digest
  FROM ${LEDGER_TABLE}
 ORDER BY sequence
 LIMIT ${MAX_JOURNAL_ROWS + 1};`;
const LINEAGE_QUERY = `SELECT singleton, lineage, artifact_id, artifact_digest, schema_digest, empty_guard
  FROM _asimposium_schema_lineage
 LIMIT ${MAX_LINEAGE_ROWS + 1};`;

function statementRows(result, index, label) {
  const statement = result[index];
  assert.ok(
    statement !== undefined && statement !== null && Array.isArray(statement.results),
    `local D1 ${label} statement ${index} must return rows`,
  );
  return statement.results;
}

function catalogFromRows(rows) {
  return assertReadLimit(rows, MAX_CATALOG_ROWS, "LOCAL_D1_CATALOG_OVERRUN").map((row) => ({
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl_name),
    sql: row.sql === null ? null : String(row.sql),
  }));
}

function journalFromRows(rows) {
  return assertReadLimit(rows, MAX_JOURNAL_ROWS, "LOCAL_D1_JOURNAL_OVERRUN").map((row) => ({
    id: String(row.id),
    sequence: Number(row.sequence),
    digest: String(row.digest),
  }));
}

function lineageFromRows(rows) {
  return assertReadLimit(rows, MAX_LINEAGE_ROWS, "LOCAL_D1_LINEAGE_OVERRUN").map((row) => ({
    singleton: Number(row.singleton),
    lineage: String(row.lineage),
    artifact_id: String(row.artifact_id),
    artifact_digest: String(row.artifact_digest),
    schema_digest: String(row.schema_digest),
    empty_guard: Number(row.empty_guard),
  }));
}

async function readCatalog(databaseName, label) {
  const result = await localJson(databaseName, CATALOG_QUERY, label);
  return catalogFromRows(statementRows(result, 0, label));
}

// These are independent readbacks of the same local D1 snapshot. Combining
// them into one Wrangler command preserves every raw catalog/journal/lineage
// assertion while keeping the fixed suite deadline meaningful on real D1.
async function readSnapshot(databaseName, label, includeLineage = false) {
  const statements = includeLineage
    ? `${CATALOG_QUERY}\n${JOURNAL_QUERY}\n${LINEAGE_QUERY}`
    : `${CATALOG_QUERY}\n${JOURNAL_QUERY}`;
  const result = await localJson(databaseName, statements, label);
  const snapshot = {
    catalog: catalogFromRows(statementRows(result, 0, label)),
    journal: journalFromRows(statementRows(result, 1, label)),
  };
  if (includeLineage) snapshot.lineage = lineageFromRows(statementRows(result, 2, label));
  return snapshot;
}

function stableCurrent0016Inputs() {
  const migrationPath = resolve(root, "db/migrations/0016_operator_fellow_cap_override.sql");
  const manifestPath = resolve(root, "db/bootstrap/manifest.json");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = {
      migration: digestOf(readFileSync(migrationPath, "utf8")),
      manifest: digestOf(readFileSync(manifestPath, "utf8")),
    };
    const currentMigrations = readMigrationDirectory(resolve(root, "db/migrations"));
    const currentManifest = readBootstrapManifest(root);
    const after = {
      migration: digestOf(readFileSync(migrationPath, "utf8")),
      manifest: digestOf(readFileSync(manifestPath, "utf8")),
    };
    if (before.migration !== after.migration || before.manifest !== after.manifest) continue;

    const migration0016 = currentMigrations.find((migration) => migration.sequence === 16);
    assert.ok(migration0016, "current W3 migration 0016 must exist");
    assert.equal(migration0016.id, "0016_operator_fellow_cap_override.sql");
    assert.equal(
      migration0016.digest,
      before.migration,
      "the production migration command must use the exact current 0016 bytes",
    );
    const schemaHead16 = currentManifest.schema_heads.filter((head) => head.sequence === 16);
    assert.equal(
      schemaHead16.length,
      1,
      "the production manifest must register exactly one head 16",
    );
    const migrationsThrough0016 = currentMigrations.filter((migration) => migration.sequence <= 16);
    assert.equal(
      migrationsThrough0016.length,
      16,
      "the current proof requires contiguous 0001-0016",
    );
    return {
      migration0016,
      migrationsThrough0016,
      manifest: currentManifest,
      schemaHead16: schemaHead16[0],
      sourceDigests: before,
    };
  }
  assert.fail("W3-owned 0016 or bootstrap manifest moved during local-proof input capture");
}

function assertCurrent0016InputsUnchanged(inputs) {
  assert.equal(
    digestOf(
      readFileSync(resolve(root, "db/migrations/0016_operator_fellow_cap_override.sql"), "utf8"),
    ),
    inputs.sourceDigests.migration,
    "W3 migration 0016 moved during the local proof; reject the mixed snapshot",
  );
  assert.equal(
    digestOf(readFileSync(resolve(root, "db/bootstrap/manifest.json"), "utf8")),
    inputs.sourceDigests.manifest,
    "W3 bootstrap manifest moved during the local proof; reject the mixed snapshot",
  );
}

function productCatalog(catalog) {
  return catalog.filter(
    (entry) =>
      !entry.name.startsWith("sqlite_") &&
      entry.name !== "_asimposium_migrations" &&
      entry.name !== "_asimposium_schema_lineage" &&
      entry.name !== "_cf_METADATA",
  );
}

function wranglerPlatformMetadata(catalog) {
  return catalog.filter((entry) => entry.name === "_cf_METADATA");
}

const WRANGLER_LOCAL_METADATA_SQL = `CREATE TABLE _cf_METADATA (
        key INTEGER PRIMARY KEY,
        value BLOB
      )`;

function exactWranglerPlatformMetadata(catalog) {
  return catalog.filter(
    (entry) =>
      entry.type === "table" &&
      entry.name === "_cf_METADATA" &&
      entry.table === "_cf_METADATA" &&
      entry.sql === WRANGLER_LOCAL_METADATA_SQL,
  );
}

function validAuthoritySeed() {
  const expiresAt = fixture.createdAt + 1_800_000;
  const proposalExpiresAt = fixture.createdAt + 86_400_000;
  return `
INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
VALUES (${sqlLiteral(fixture.sponsorId)}, ${fixture.createdAt}, ${fixture.createdAt});
INSERT INTO enrollment_records (
  enrollment_id, sponsor_id, secret_hash, secret_expires_at,
  requested_scopes_json, requested_resources_json, invalidated, created_at, kind
) VALUES (
  ${sqlLiteral(fixture.enrollmentId)}, ${sqlLiteral(fixture.sponsorId)},
  ${sqlLiteral(fixture.secretHash)}, ${expiresAt},
  ${sqlLiteral(fixture.scopesJson)}, ${sqlLiteral(fixture.resourcesJson)},
  0, ${fixture.createdAt}, 'join-url'
);
INSERT INTO enrollment_proposals (
  proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
  created_at, expires_at, status, granted_scopes_json, granted_resources_json,
  token_hash, token_issued_at, poll_interval_seconds
) VALUES (
  ${sqlLiteral(fixture.proposalId)}, ${sqlLiteral(fixture.enrollmentId)},
  ${sqlLiteral(fixture.fellowId)}, ${sqlLiteral(fixture.flowHandleHash)},
  ${sqlLiteral(fixture.fellowName)}, ${sqlLiteral(fixture.model)}, ${sqlLiteral(fixture.harness)},
  ${fixture.createdAt}, ${proposalExpiresAt}, 'approved',
  ${sqlLiteral(fixture.scopesJson)}, ${sqlLiteral(fixture.resourcesJson)},
  NULL, NULL, 5
);
INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
VALUES (
  ${sqlLiteral(fixture.fellowId)}, ${sqlLiteral(fixture.sponsorId)},
  ${sqlLiteral(fixture.fellowName)}, ${sqlLiteral(fixture.model)},
  ${sqlLiteral(fixture.harness)}, ${fixture.createdAt}
);
INSERT INTO enrollment_grants (
  proposal_id, fellow_id, sponsor_id, granted_scopes_json, granted_resources_json, granted_at
) VALUES (
  ${sqlLiteral(fixture.proposalId)}, ${sqlLiteral(fixture.fellowId)},
  ${sqlLiteral(fixture.sponsorId)}, ${sqlLiteral(fixture.scopesJson)},
  ${sqlLiteral(fixture.resourcesJson)}, ${fixture.createdAt}
);`;
}

function historyAndResidueQuery() {
  const objects = MIGRATION_OBJECTS.map(sqlLiteral).join(", ");
  return `SELECT
  (SELECT COUNT(*) FROM enrollment_fellows
    WHERE hex(fellow_id) = ${hexLiteral(fixture.fellowId)}
      AND hex(sponsor_id) = ${hexLiteral(fixture.sponsorId)}
      AND hex(name) = ${hexLiteral(fixture.fellowName)}
      AND hex(model) = ${hexLiteral(fixture.model)}
      AND hex(harness) = ${hexLiteral(fixture.harness)}
      AND created_at = ${fixture.createdAt}) AS fellow_bytes,
  (SELECT COUNT(*) FROM enrollment_grants
    WHERE hex(proposal_id) = ${hexLiteral(fixture.proposalId)}
      AND hex(fellow_id) = ${hexLiteral(fixture.fellowId)}
      AND hex(sponsor_id) = ${hexLiteral(fixture.sponsorId)}
      AND hex(granted_scopes_json) = ${hexLiteral(fixture.scopesJson)}
      AND hex(granted_resources_json) = ${hexLiteral(fixture.resourcesJson)}
      AND granted_at = ${fixture.createdAt}) AS grant_bytes,
  (SELECT COUNT(*) FROM enrollment_records
    WHERE hex(enrollment_id) = ${hexLiteral(fixture.enrollmentId)}
      AND hex(sponsor_id) = ${hexLiteral(fixture.sponsorId)}
      AND hex(secret_hash) = ${hexLiteral(fixture.secretHash)}) AS record_bytes,
  (SELECT COUNT(*) FROM enrollment_proposals
    WHERE hex(proposal_id) = ${hexLiteral(fixture.proposalId)}
      AND hex(enrollment_id) = ${hexLiteral(fixture.enrollmentId)}
      AND hex(fellow_id) = ${hexLiteral(fixture.fellowId)}
      AND hex(granted_scopes_json) = ${hexLiteral(fixture.scopesJson)}
      AND hex(granted_resources_json) = ${hexLiteral(fixture.resourcesJson)}) AS proposal_bytes,
  (SELECT COUNT(*) FROM sponsors
    WHERE hex(sponsor_id) = ${hexLiteral(fixture.sponsorId)}) AS sponsor_rows,
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE name = 'sponsor_enrollment_bootstrap_migration_witness') AS witness_table,
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (${objects})) AS migration_triggers,
  (SELECT COUNT(*) FROM ${LEDGER_TABLE}
    WHERE id = ${sqlLiteral(migration0015.id)}
      AND sequence = 15
      AND digest = ${sqlLiteral(migration0015.digest)}) AS migration_journal;`;
}

function assertHistoricalRows(row, sponsorRows, witnessTable, triggers, journal, label) {
  for (const field of ["fellow_bytes", "grant_bytes", "record_bytes", "proposal_bytes"]) {
    assert.equal(Number(row[field]), 1, `${label} must retain the exact ${field} row`);
  }
  assert.equal(Number(row.sponsor_rows), sponsorRows, `${label} sponsor count mismatch`);
  assert.equal(Number(row.witness_table), witnessTable, `${label} witness-table residue mismatch`);
  assert.equal(Number(row.migration_triggers), triggers, `${label} trigger residue mismatch`);
  assert.equal(Number(row.migration_journal), journal, `${label} migration journal mismatch`);
}

function assertSafeCause(error) {
  assert.ok(error instanceof MigrationError, "failed local D1 command must surface MigrationError");
  assert.equal(error.code, "LOCAL_D1_COMMAND_FAILED");
  assert.equal(typeof error.causalOutput, "string");
  assert.ok(
    error.causalOutput.length > 0,
    "failed local D1 diagnostic must retain a redacted cause",
  );
  assert.ok(error.causalOutput.length <= 601, "failed local D1 diagnostic must stay bounded");
  for (const forbidden of [
    "/Users/",
    "/private/",
    "/var/folders",
    "asimp_ag_",
    "BEGIN PRIVATE KEY",
  ]) {
    assert.equal(
      error.causalOutput.includes(forbidden),
      false,
      "failed local D1 diagnostic leaked forbidden material",
    );
  }
  assert.equal(
    /[A-Fa-f0-9]{32,}/.test(error.causalOutput),
    false,
    "failed local D1 diagnostic leaked a long hex run",
  );
}

const cases = [
  {
    name: "bounded-command-refuses-malformed-utf8-before-returning-child-output",
    async execute() {
      const closedPipe = (bytes = []) =>
        new ReadableStream({
          start(controller) {
            for (const value of bytes) controller.enqueue(value);
            controller.close();
          },
        });
      const result = await runBoundedCommand({
        cmd: ["fixture"],
        cwd: root,
        groupExists: () => false,
        killReapMs: 1,
        pipeDrainMs: 1,
        signalGroup() {},
        spawn() {
          return {
            exited: Promise.resolve(0),
            pid: 40,
            stderr: closedPipe(),
            stdout: closedPipe([new Uint8Array([0x7b, 0xff, 0x7d])]),
          };
        },
        termGraceMs: 1,
        timeoutMs: 10,
      });
      assert.equal(result.outcome, "pipe-drain-unproven");
      assert.equal(result.stdout, "");
    },
  },
  {
    name: "owned-process-group-absence-requires-esrch-and-inspection-errors-refuse",
    async execute() {
      const child = { pid: 41 };
      assert.equal(
        ownedProcessGroupExists(child, {
          platform: "linux",
          signalGroup(group, signal) {
            assert.equal(group, -41);
            assert.equal(signal, 0);
          },
        }),
        true,
      );
      assert.equal(
        ownedProcessGroupExists(child, {
          platform: "linux",
          signalGroup() {
            const error = new Error("absent");
            error.code = "ESRCH";
            throw error;
          },
        }),
        false,
      );
      assert.throws(
        () =>
          ownedProcessGroupExists(child, {
            platform: "linux",
            signalGroup() {
              const error = new Error("inspection denied");
              error.code = "EPERM";
              throw error;
            },
          }),
        (error) => error?.code === "EPERM",
      );

      const closedPipe = () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      const signals = [];
      const result = await runBoundedCommand({
        cmd: ["fixture"],
        cwd: root,
        groupExists() {
          const error = new Error("inspection unavailable");
          error.code = "EPERM";
          throw error;
        },
        killReapMs: 1,
        pipeDrainMs: 1,
        signalGroup(_child, signal) {
          signals.push(signal);
        },
        spawn() {
          return {
            exited: new Promise(() => {}),
            pid: 42,
            stderr: closedPipe(),
            stdout: closedPipe(),
          };
        },
        termGraceMs: 1,
        timeoutMs: 1,
      });
      assert.equal(result.outcome, "process-reap-unproven");
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    },
  },
  {
    name: "local-d1-result-classification-refuses-every-unproven-zero-exit-outcome",
    execute() {
      const refusals = [
        ["timeout", "LOCAL_D1_COMMAND_TIMEOUT"],
        ["output-overrun", "LOCAL_D1_OUTPUT_OVERRUN"],
        ["pipe-drain-unproven", "LOCAL_D1_PIPE_DRAIN_UNPROVEN"],
        ["process-reap-unproven", "LOCAL_D1_PROCESS_REAP_UNPROVEN"],
        ["direct-child-reap-unproven", "LOCAL_D1_DIRECT_CHILD_REAP_UNPROVEN"],
        ["process-group-survivor-observed", "LOCAL_D1_PROCESS_GROUP_SURVIVOR"],
        ["aborted", "LOCAL_D1_COMMAND_ABORTED"],
        ["owner-lease-write-unproven", "LOCAL_D1_OWNER_LEASE_WRITE_UNPROVEN"],
        ["owner-lease-close-unproven", "LOCAL_D1_OWNER_LEASE_CLOSE_UNPROVEN"],
        ["owner-lease-retirement-unproven", "LOCAL_D1_OWNER_LEASE_RETIREMENT_UNPROVEN"],
        ["future-unrecognized-outcome", "LOCAL_D1_COMMAND_OUTCOME_UNRECOGNIZED"],
      ];
      for (const [outcome, expectedCode] of refusals) {
        let refusal;
        try {
          localD1StdoutOrRefuse({
            outcome,
            exitCode: 0,
            stderr: "",
            stdout: '[{"results":[{"must_not_parse":1}]}]',
          });
          assert.fail(`${outcome} with exit zero must not become a local D1 success`);
        } catch (error) {
          refusal = error;
        }
        assert.ok(refusal instanceof MigrationError, outcome);
        assert.equal(refusal.code, expectedCode, outcome);
      }

      let spawnRefusal;
      try {
        localD1StdoutOrRefuse({ outcome: "spawn-failed", stderr: "", stdout: "" });
        assert.fail("spawn failure must refuse");
      } catch (error) {
        spawnRefusal = error;
      }
      assert.ok(spawnRefusal instanceof MigrationError);
      assert.equal(spawnRefusal.code, "LOCAL_D1_COMMAND_FAILED");

      let nonzeroRefusal;
      try {
        localD1StdoutOrRefuse({ outcome: "exited", exitCode: 7, stderr: "", stdout: "" });
        assert.fail("a nonzero exit must refuse");
      } catch (error) {
        nonzeroRefusal = error;
      }
      assert.ok(nonzeroRefusal instanceof MigrationError);
      assert.equal(nonzeroRefusal.code, "LOCAL_D1_COMMAND_FAILED");

      const exactSuccess = '[{"results":[]}]';
      assert.equal(
        localD1StdoutOrRefuse({
          outcome: "exited",
          exitCode: 0,
          stderr: "",
          stdout: exactSuccess,
        }),
        exactSuccess,
      );
    },
  },
  {
    // PLANTED: a truncated execution window must never reach a child.
    //
    // The observed failure was `apply-6` reported as "did not complete through
    // the bounded executor" 1.4s before the whole-suite deadline: the reap
    // reserve cleared, a real `wrangler d1 execute` was handed ~1400ms, and its
    // inevitable timeout was attributed to the migration. This plant fixes the
    // boundary at exact values instead of provoking it, so it is deterministic
    // and does not move `TOTAL_TIMEOUT_MS` or `PER_COMMAND_TIMEOUT_MS`.
    name: "a-nearly-exhausted-suite-budget-refuses-before-spawning-a-doomed-command",
    async execute() {
      // CAUSAL: drive the real pre-spawn seam at the exact reported budget with
      // a runner that records entry. This is the no-spawn proof — not the
      // arithmetic below, and not a source-shape count. If the pre-spawn floor
      // refusal were removed, the seam would enter the runner with the
      // truncated window and `runnerEntries` would be 1.
      // Historical observation, deliberately literal rather than derived from
      // the reserve whose composition this case is meant to catch.
      const REPORTED_REMAINING_MS = 2_900;
      let runnerEntries = 0;
      const recordingRunner = () => {
        runnerEntries += 1;
        throw new Error("a truncated execution window reached the runner");
      };

      let refusedBeforeSpawn;
      try {
        await runBoundedLocalCommand(
          "apply-6",
          { cmd: [process.execPath, "--version"], cwd: root },
          { runner: recordingRunner, remainingMs: REPORTED_REMAINING_MS },
        );
        assert.fail("a truncated window must refuse before any spawn");
      } catch (error) {
        refusedBeforeSpawn = error;
      }
      assert.ok(refusedBeforeSpawn instanceof MigrationError);
      assert.equal(refusedBeforeSpawn.code, "LOCAL_D1_SUITE_BUDGET_EXHAUSTED");
      assert.equal(runnerEntries, 0, "the seam entered the runner with a doomed window");
      assert.equal(
        refusedBeforeSpawn.message,
        "The local D1 suite budget left 2900ms total for apply-6, providing 0ms for execution after its 3750ms cleanup reserve, below the 3000ms execution floor; no command was started.",
      );

      // The production deadline calculator must feed the SAME typed refusal.
      // Previously its assertion fired first, replacing this code with a generic
      // AssertionError and hiding the exact remaining-budget diagnosis.
      let expiredDeadlineRunnerEntries = 0;
      let expiredDeadlineRefusal;
      try {
        await runBoundedLocalCommand(
          "expired-deadline",
          { cmd: [process.execPath, "--version"], cwd: root },
          {
            runner: () => {
              expiredDeadlineRunnerEntries += 1;
              throw new Error("an expired suite deadline reached the runner");
            },
            observedAt: deadlineAt + 1,
          },
        );
        assert.fail("an expired suite deadline must refuse before any spawn");
      } catch (error) {
        expiredDeadlineRefusal = error;
      }
      assert.ok(expiredDeadlineRefusal instanceof MigrationError);
      assert.equal(expiredDeadlineRefusal.code, "LOCAL_D1_SUITE_BUDGET_EXHAUSTED");
      assert.equal(expiredDeadlineRunnerEntries, 0);
      assert.equal(
        expiredDeadlineRefusal.message,
        "The local D1 suite budget left 0ms total for expired-deadline, providing 0ms for execution after its 3750ms cleanup reserve, below the 3000ms execution floor; no command was started.",
      );

      // POSITIVE CONTROL: the same seam DOES spawn when the budget allows, and
      // hands over exactly the guarded window. Without this the refusal above
      // could pass by refusing everything.
      let admittedEntries = 0;
      let handedTimeoutMs;
      const admittingRunner = (options) => {
        admittedEntries += 1;
        handedTimeoutMs = options.timeoutMs;
        return { outcome: "exited", exitCode: 0, stdout: "", stderr: "" };
      };
      const admittedRemainingMs = 6_750;
      const admittedResult = await runBoundedLocalCommand(
        "apply-6",
        { cmd: [process.execPath, "--version"], cwd: root },
        { runner: admittingRunner, remainingMs: admittedRemainingMs },
      );
      assert.equal(admittedEntries, 1, "an admitted budget must reach the runner exactly once");
      assert.equal(handedTimeoutMs, LOCAL_D1_EXECUTION_FLOOR_MS);
      assert.equal(admittedResult.outcome, "exited");

      // STANDALONE CONTROL: callers that do not receive an outer orchestration
      // deadline retain the shipped fixed 15s command timeout. The new shared
      // deadline is containment supplied by the suite, not a hidden requirement
      // for using localD1 directly.
      let standaloneEntries = 0;
      let standaloneTimeoutMs;
      const standaloneResult = await runLocalD1Command(
        { cmd: [process.execPath, "--version"], cwd: root },
        {
          runner: (options) => {
            standaloneEntries += 1;
            standaloneTimeoutMs = options.timeoutMs;
            assert.equal(options.ownershipMode, OWNED_PROCESS_GROUP);
            return { outcome: "exited", exitCode: 0, stdout: "", stderr: "" };
          },
        },
      );
      assert.equal(standaloneEntries, 1);
      assert.equal(standaloneTimeoutMs, 15_000);
      assert.equal(standaloneResult.outcome, "exited");

      // FD0 OWNER LEASE: only an opaque lease minted after the watchdog's exact
      // canonical echo may admit a deadline-bearing local child.
      const leaseDeadlineAtMs = 306_250;
      const authenticatedWatchdogObservation = {};
      const authenticatedLease = await authenticateLocalOwnerLease(leaseDeadlineAtMs, {
        processLeadsOwnedGroup: () => true,
        spawn: fakeOwnerWatchdogSpawn(authenticatedOwnerWatchdogFrame(leaseDeadlineAtMs), {
          observation: authenticatedWatchdogObservation,
        }),
      });
      assert.equal(authenticatedWatchdogObservation.unrefs, 1);
      let leasedRunnerEntries = 0;
      const leasedResult = await runLocalD1Command(
        { cmd: [process.execPath, "--version"], cwd: root },
        {
          deadlineAtMs: leaseDeadlineAtMs,
          observedAtMs: 300_000,
          ownerLease: authenticatedLease,
          processLeadsOwnedGroup: () => true,
          runner: (options) => {
            leasedRunnerEntries += 1;
            assert.equal(options.ownershipMode, PARENT_PROCESS_GROUP);
            return { outcome: "exited", exitCode: 0, stdout: "", stderr: "" };
          },
        },
      );
      assert.equal(leasedRunnerEntries, 1);
      assert.equal(leasedResult.outcome, "exited");

      let topologyRunnerEntries = 0;
      let topologyRefusal;
      try {
        await runLocalD1Command(
          { cmd: [process.execPath, "--version"], cwd: root },
          {
            deadlineAtMs: leaseDeadlineAtMs,
            observedAtMs: 300_000,
            ownerLease: authenticatedLease,
            processLeadsOwnedGroup: () => false,
            runner: () => {
              topologyRunnerEntries += 1;
              throw new Error("an authenticated but topologically unowned command reached spawn");
            },
          },
        );
      } catch (error) {
        topologyRefusal = error;
      }
      assert.ok(topologyRefusal instanceof MigrationError);
      assert.equal(topologyRefusal.code, "LOCAL_D1_PARENT_PROCESS_GROUP_UNPROVEN");
      assert.equal(topologyRunnerEntries, 0);

      for (const [label, frame, expectedCode, handshakeMs] of [
        ["absent", `${OWNER_REFUSAL_PREFIX} ABSENT\n`, "LOCAL_D1_OWNER_LEASE_ABSENT"],
        ["regular", `${OWNER_REFUSAL_PREFIX} REGULAR\n`, "LOCAL_D1_OWNER_LEASE_REGULAR"],
        ["terminal", `${OWNER_REFUSAL_PREFIX} TERMINAL\n`, "LOCAL_D1_OWNER_LEASE_TERMINAL"],
        [
          "forged",
          authenticatedOwnerWatchdogFrame(leaseDeadlineAtMs, "A".repeat(64)),
          "LOCAL_D1_OWNER_LEASE_MALFORMED",
        ],
        ["dead-owner", null, "LOCAL_D1_OWNER_LEASE_DEAD"],
        ["stuck-owner", undefined, "LOCAL_D1_OWNER_LEASE_STUCK", 0],
        [
          "deadline-mismatch",
          authenticatedOwnerWatchdogFrame(leaseDeadlineAtMs + 1),
          "LOCAL_D1_OWNER_LEASE_MISMATCH",
        ],
      ]) {
        let refusal;
        try {
          await authenticateLocalOwnerLease(leaseDeadlineAtMs, {
            processLeadsOwnedGroup: () => true,
            spawn: fakeOwnerWatchdogSpawn(frame),
            ...(handshakeMs === undefined ? {} : { handshakeMs }),
          });
          assert.fail(`${label} owner lease must refuse`);
        } catch (error) {
          refusal = error;
        }
        assert.ok(refusal instanceof MigrationError, `${label} must be a typed refusal`);
        assert.equal(refusal.code, expectedCode, `${label} refusal code mismatch`);
      }

      for (const preauthPlant of [
        {
          input: "ASIMP_LOCAL_OWNER_LEASE_V1 partial\n",
          endAfterInput: false,
          expectedCode: "LOCAL_D1_OWNER_LEASE_MALFORMED",
          expectedFrame: `${OWNER_REFUSAL_PREFIX} MALFORMED\n`,
        },
        {
          input: "ASIMP_LOCAL_OWNER_LEASE_V1 ",
          endAfterInput: true,
          expectedCode: "LOCAL_D1_OWNER_LEASE_DEAD",
          expectedFrame: `${OWNER_REFUSAL_PREFIX} DEAD\n`,
        },
        {
          input: "ASIMP_LOCAL_OWNER_LEASE_V1 ",
          endAfterInput: false,
          expectedCode: "LOCAL_D1_OWNER_LEASE_STUCK",
          expectedFrame: `${OWNER_REFUSAL_PREFIX} STUCK\n`,
        },
      ]) {
        await runShippedOwnerWatchdogPreauthPlant(preauthPlant);
      }

      const readerFailureObservation = { cancels: 0, releases: 0 };
      for (const [label, stdout, readerObservation] of [
        [
          "get-reader-throws",
          {
            getReader() {
              throw new Error("synthetic getReader failure");
            },
          },
          undefined,
        ],
        [
          "read-rejects",
          {
            getReader() {
              const observation = readerFailureObservation;
              return {
                read: () => Promise.reject(new Error("synthetic read failure")),
                cancel: () => {
                  observation.cancels += 1;
                  return Promise.resolve();
                },
                releaseLock: () => {
                  observation.releases += 1;
                },
              };
            },
          },
          readerFailureObservation,
        ],
      ]) {
        const watchdogObservation = {};
        let refusal;
        try {
          await authenticateLocalOwnerLease(leaseDeadlineAtMs, {
            processLeadsOwnedGroup: () => true,
            spawn: fakeOwnerWatchdogSpawn(undefined, {
              observation: watchdogObservation,
              stdout,
            }),
          });
        } catch (error) {
          refusal = error;
        }
        assert.ok(refusal instanceof MigrationError, `${label} must be a typed refusal`);
        assert.equal(refusal.code, "LOCAL_D1_OWNER_LEASE_MALFORMED");
        assert.deepEqual(watchdogObservation.kills, ["SIGTERM"]);
        if (readerObservation !== undefined) {
          assert.equal(readerObservation.cancels, 1);
          assert.equal(readerObservation.releases, 1);
        }
      }

      let unauthenticatedRunnerEntries = 0;
      let unauthenticatedRefusal;
      try {
        await runLocalD1Command(
          { cmd: [process.execPath, "--version"], cwd: root },
          {
            deadlineAtMs: leaseDeadlineAtMs,
            observedAtMs: 300_000,
            ownerLease: Object.freeze({}),
            runner: () => {
              unauthenticatedRunnerEntries += 1;
              throw new Error("a forged opaque lease reached the runner");
            },
          },
        );
      } catch (error) {
        unauthenticatedRefusal = error;
      }
      assert.ok(unauthenticatedRefusal instanceof MigrationError);
      assert.equal(unauthenticatedRefusal.code, "LOCAL_D1_OWNER_LEASE_UNAUTHENTICATED");
      assert.equal(unauthenticatedRunnerEntries, 0);

      // SECONDARY: the boundary arithmetic itself, at exact values, no clock.
      const reported = localExecutionAllocation(REPORTED_REMAINING_MS);
      assert.equal(reported.kind, "budget-exhausted");
      assert.equal(reported.remainingMs, 2_900);
      assert.equal(reported.executionWindowMs, 0);

      // INDEPENDENT COMPOSITION: these literal expectations prevent a wrong
      // reserve from making its own derived boundary plant pass. The canonical
      // bounded executor has seven 500ms cleanup windows plus 250ms of scheduling
      // margin, and the local execution floor adds another 3000ms.
      assert.equal(TERMINATE_GRACE_MS, 500);
      assert.equal(KILL_REAP_MS, 500);
      assert.equal(OUTPUT_DRAIN_MS, 500);
      assert.equal(OWNER_LEASE_CLOSE_RESERVE_MS, 500);
      assert.equal(CLEANUP_SCHEDULING_MARGIN_MS, 250);
      assert.equal(COMMAND_CONTAINMENT_RESERVE_MS, 3_500);
      assert.equal(COMMAND_REAP_RESERVE_MS, 3_750);
      assert.equal(LOCAL_D1_EXECUTION_FLOOR_MS, 3_000);
      assert.equal(LOCAL_D1_COMMAND_WINDOW_MS, 6_750);
      assert.equal(SHIPPED_LOCAL_CLEANUP_RESERVE_MS, COMMAND_REAP_RESERVE_MS);
      assert.equal(SHIPPED_LOCAL_EXECUTION_FLOOR_MS, LOCAL_D1_EXECUTION_FLOOR_MS);
      assert.equal(SHIPPED_LOCAL_COMMAND_WINDOW_MS, LOCAL_D1_COMMAND_WINDOW_MS);

      // Exact boundary, both sides, with no clock involved.
      const oneMillisecondShort = localExecutionAllocation(6_749);
      assert.equal(oneMillisecondShort.kind, "budget-exhausted");
      assert.equal(oneMillisecondShort.executionWindowMs, 2_999);
      const admitted = localExecutionAllocation(6_750);
      assert.equal(admitted.kind, "ok");
      // An admitted window still withholds the whole reap tail, so a command
      // that uses all of it can still be terminated inside the same budget.
      assert.equal(admitted.executionWindowMs, LOCAL_D1_EXECUTION_FLOOR_MS);

      let preauthWatchdogEntries = 0;
      let preauthLocalEntries = 0;
      let preauthStderr = "";
      const preauthExitCode = await runMigrationCli(
        ["--env", "local", "--local-command-deadline-at-ms", String(leaseDeadlineAtMs)],
        {
          root,
          localProcessLeadsOwnedGroup: () => false,
          ownerLeaseWatchdogSpawn: () => {
            preauthWatchdogEntries += 1;
            throw new Error("unowned topology reached watchdog spawn");
          },
          localReadLineageSnapshot: async () => {
            preauthLocalEntries += 1;
            throw new Error("unowned topology reached local work");
          },
          stderr: (line) => {
            preauthStderr += line;
          },
          stdout: () => {},
        },
      );
      assert.equal(preauthExitCode, 1);
      assert.equal(preauthWatchdogEntries, 0);
      assert.equal(preauthLocalEntries, 0);
      assert.equal(JSON.parse(preauthStderr).code, "LOCAL_D1_PARENT_PROCESS_GROUP_UNPROVEN");

      // ACTUAL CLI ORCHESTRATION: the deadline parsed by runMigrationCli must
      // reach the nested local-D1 pre-spawn seam. The outer controller reserves
      // its own cleanup tail, so one millisecond below that tail plus the
      // complete inner command window must refuse without entering the inner
      // runner. A fixed epoch makes the exact absolute argv deadline causal too.
      const REFUSAL_EPOCH_MS = 100_000;
      const ACTUAL_CLI_REFUSAL_BUDGET_MS =
        COMMAND_REAP_RESERVE_MS + SHIPPED_LOCAL_COMMAND_WINDOW_MS - 1;
      let nestedRunnerEntries = 0;
      const actualCliRefusal = await runActualLocalMigrationCli(
        ["--env", "local"],
        "nested-deadline-refusal",
        {
          epochNow: () => REFUSAL_EPOCH_MS,
          remainingMs: ACTUAL_CLI_REFUSAL_BUDGET_MS,
          runner: async ({ cmd, timeoutMs }) => {
            assert.equal(timeoutMs, SHIPPED_LOCAL_COMMAND_WINDOW_MS - 1);
            assert.deepEqual(cmd.slice(-2), [
              "--local-command-deadline-at-ms",
              String(REFUSAL_EPOCH_MS + SHIPPED_LOCAL_COMMAND_WINDOW_MS - 1),
            ]);
            let stderr = "";
            let stdout = "";
            const exitCode = await runMigrationCli(cmd.slice(2), {
              root,
              localProcessLeadsOwnedGroup: () => true,
              ownerLeaseWatchdogSpawn: fakeOwnerWatchdogSpawn(
                authenticatedOwnerWatchdogFrame(
                  REFUSAL_EPOCH_MS + SHIPPED_LOCAL_COMMAND_WINDOW_MS - 1,
                ),
              ),
              localReadLineageSnapshot: async (
                _root,
                _databaseName,
                _localPersistTo,
                receivedDeadlineAtMs,
                receivedOwnerLease,
              ) => {
                assert.ok(Number.isSafeInteger(receivedDeadlineAtMs));
                return await runLocalD1Command(
                  { cmd: [process.execPath, "--version"], cwd: root },
                  {
                    deadlineAtMs: receivedDeadlineAtMs,
                    observedAtMs: REFUSAL_EPOCH_MS,
                    ownerLease: receivedOwnerLease,
                    processLeadsOwnedGroup: () => true,
                    runner: () => {
                      nestedRunnerEntries += 1;
                      throw new Error("an under-budget nested Wrangler command reached its runner");
                    },
                  },
                );
              },
              stderr: (line) => {
                stderr += line;
              },
              stdout: (line) => {
                stdout += line;
              },
            });
            return { outcome: "exited", exitCode, stderr, stdout };
          },
        },
      );
      assert.equal(actualCliRefusal.exitCode, 1);
      assert.equal(nestedRunnerEntries, 0);
      assert.equal(actualCliRefusal.diagnostic.code, "LOCAL_D1_ORCHESTRATION_BUDGET_EXHAUSTED");

      // RECEIPT ORDER: runMigrationCli may emit only after the nested runner's
      // promise — the production cleanup-settlement boundary — has completed.
      const SETTLEMENT_EPOCH_MS = 200_000;
      const ACTUAL_CLI_ADMISSION_BUDGET_MS =
        COMMAND_REAP_RESERVE_MS + SHIPPED_LOCAL_COMMAND_WINDOW_MS;
      const settlementOrder = [];
      const actualCliSettlement = await runActualLocalMigrationCli(
        ["--env", "local"],
        "nested-cleanup-settlement",
        {
          epochNow: () => SETTLEMENT_EPOCH_MS,
          remainingMs: ACTUAL_CLI_ADMISSION_BUDGET_MS,
          runner: async ({ cmd, timeoutMs }) => {
            assert.equal(timeoutMs, SHIPPED_LOCAL_COMMAND_WINDOW_MS);
            assert.deepEqual(cmd.slice(-2), [
              "--local-command-deadline-at-ms",
              String(SETTLEMENT_EPOCH_MS + SHIPPED_LOCAL_COMMAND_WINDOW_MS),
            ]);
            let stderr = "";
            let stdout = "";
            const exitCode = await runMigrationCli(cmd.slice(2), {
              root,
              localProcessLeadsOwnedGroup: () => true,
              ownerLeaseWatchdogSpawn: fakeOwnerWatchdogSpawn(
                authenticatedOwnerWatchdogFrame(
                  SETTLEMENT_EPOCH_MS + SHIPPED_LOCAL_COMMAND_WINDOW_MS,
                ),
              ),
              localReadLineageSnapshot: async (
                _root,
                _databaseName,
                _localPersistTo,
                receivedDeadlineAtMs,
                receivedOwnerLease,
              ) => {
                await runLocalD1Command(
                  { cmd: [process.execPath, "--version"], cwd: root },
                  {
                    deadlineAtMs: receivedDeadlineAtMs,
                    observedAtMs: SETTLEMENT_EPOCH_MS,
                    ownerLease: receivedOwnerLease,
                    processLeadsOwnedGroup: () => true,
                    runner: async (options) => {
                      assert.equal(options.ownershipMode, PARENT_PROCESS_GROUP);
                      settlementOrder.push("cleanup-started");
                      await Promise.resolve();
                      settlementOrder.push("cleanup-settled");
                      return { outcome: "exited", exitCode: 0, stderr: "", stdout: "" };
                    },
                  },
                );
                return { catalog: [], journal: [], lineage: [] };
              },
              stderr: (line) => {
                settlementOrder.push("outer-receipt");
                stderr += line;
              },
              stdout: (line) => {
                settlementOrder.push("outer-receipt");
                stdout += line;
              },
            });
            return { outcome: "exited", exitCode, stderr, stdout };
          },
        },
      );
      assert.equal(actualCliSettlement.exitCode, 1);
      assert.ok(settlementOrder.indexOf("cleanup-started") >= 0);
      assert.ok(
        settlementOrder.indexOf("cleanup-settled") < settlementOrder.indexOf("outer-receipt"),
        "the outer CLI receipt preceded nested cleanup settlement",
      );

      for (const failureMode of [
        "sync-write",
        "async-write",
        "sync-flush",
        "async-flush",
        "sync-ref",
        "async-ref",
      ]) {
        const writeFailure = await runOwnerLeaseWriteFailurePlant(failureMode);
        assert.equal(writeFailure.result.outcome, "owner-lease-write-unproven", failureMode);
        assert.deepEqual(
          writeFailure.events.filter((event) => event === "SIGTERM" || event === "SIGKILL"),
          ["SIGTERM", "SIGKILL"],
          `${failureMode} did not retire the exact owned group`,
        );
        assert.ok(
          writeFailure.events.indexOf("end") < writeFailure.events.indexOf("SIGTERM"),
          `${failureMode} signalled before closing the owner lease`,
        );
        assert.ok(
          writeFailure.events.indexOf("stdout-cancel") < writeFailure.events.indexOf("SIGTERM") &&
            writeFailure.events.indexOf("stderr-cancel") < writeFailure.events.indexOf("SIGTERM"),
          `${failureMode} signalled before cancelling both owned readers`,
        );
        assert.equal(writeFailure.stdout.locked, false);
        assert.equal(writeFailure.stderr.locked, false);
      }

      // MODE POLARITY: parent-owned execution must inherit the outer group and
      // signal only its direct child. Any negative-PID/group signal here could
      // terminate the CLI that owns this executor and race its outer receipt.
      let resolveModeChildExit;
      const modeChildExit = new Promise((resolve) => {
        resolveModeChildExit = resolve;
      });
      let modeSpawnDetached;
      let modeGroupSignals = 0;
      const modeChildSignals = [];
      const parentOwnedModeResult = await runBoundedCommand({
        cmd: [process.execPath, "--version"],
        cwd: root,
        timeoutMs: 0,
        termGraceMs: 1,
        killReapMs: 1,
        pipeDrainMs: 1,
        ownershipMode: PARENT_PROCESS_GROUP,
        spawn: (options) => {
          modeSpawnDetached = options.detached;
          return { pid: 91_001, exited: modeChildExit, stdout: null, stderr: null };
        },
        signalChild: (_child, signal) => {
          modeChildSignals.push(signal);
          resolveModeChildExit(143);
        },
        signalGroup: () => {
          modeGroupSignals += 1;
          throw new Error("parent-owned mode signalled the outer process group");
        },
        groupExists: () => {
          throw new Error("parent-owned mode inspected a group it does not own");
        },
        toolEnvironment: {},
      });
      assert.equal(modeSpawnDetached, false);
      assert.deepEqual(modeChildSignals, ["SIGTERM"]);
      assert.equal(modeGroupSignals, 0);
      assert.equal(parentOwnedModeResult.outcome, "timeout");
      assert.equal(parentOwnedModeResult.containment_scope, "parent-process-group/direct-child");

      // WATCHDOG-ONLY EOF RETIREMENT: the detached fixture authenticates the
      // real fd0 capability, proves its parent-owned local seam is admitted,
      // waits for a TERM-resistant descendant's readiness acknowledgement, and
      // then exits normally. Closing the retained writer is the only expected
      // retirement trigger; this outer signal seam is fallback cleanup and a
      // causal witness that deletion of the watchdog's post-auth EOF loop is red.
      const eofDeadlineAtMs = Date.now() + 10_000;
      const eofFallbackSignals = [];
      const eofResult = await runBoundedCommand({
        cmd: [
          process.execPath,
          "infra/migrate-local.test.mjs",
          OWNER_LEASE_EOF_FIXTURE,
          String(eofDeadlineAtMs),
        ],
        cwd: root,
        timeoutMs: 10_000,
        ownerLeaseDeadlineAtMs: eofDeadlineAtMs,
        signalGroup: (child, signal) => {
          eofFallbackSignals.push(signal);
          try {
            process.kill(-child.pid, signal);
          } catch {
            try {
              child.kill(signal);
            } catch {}
          }
        },
      });
      assert.equal(eofResult.outcome, "exited");
      assert.equal(eofResult.exitCode, 0);
      assert.deepEqual(eofFallbackSignals, []);
      const eofPids = JSON.parse(eofResult.stdout.trim());
      assert.ok(Number.isSafeInteger(eofPids.descendant));
      assert.equal(
        processExists(eofPids.descendant),
        false,
        "watchdog EOF retirement left its TERM-resistant descendant alive",
      );

      // REAL PROCESS TOPOLOGY: the CLI fixture is the detached leader of the
      // outer executor's owned group. Its production local-D1 seam starts a
      // non-detached direct child which starts a non-detached descendant; both
      // ignore TERM, and the fixture stalls its event loop before the inner
      // deadline can run. The outer controller must therefore escalate against
      // its one exact group and observe both nested PIDs gone before receipt.
      const topologyResult = await runBoundedLocalCommand(
        "parent-owned-real-process-topology",
        ({ deadlineAtMs }) => ({
          cmd: [
            process.execPath,
            "infra/migrate-local.test.mjs",
            PARENT_OWNED_TOPOLOGY_FIXTURE,
            String(deadlineAtMs),
          ],
          cwd: root,
          ownerLeaseDeadlineAtMs: deadlineAtMs,
        }),
        {
          remainingMs: COMMAND_REAP_RESERVE_MS + SHIPPED_LOCAL_COMMAND_WINDOW_MS,
        },
      );
      assert.equal(topologyResult.outcome, "timeout");
      assert.equal(topologyResult.containment_scope, "process-group-only");
      const topologyPidRecord = topologyResult.stdout.trim();
      assert.match(
        topologyPidRecord,
        /^\/[^\n]*\/asimposium-migrate-local-[A-Za-z0-9]+\/owned-topology-[0-9a-f-]+\.json$/,
      );
      const topologyPids = JSON.parse(readFileSync(topologyPidRecord, "utf8"));
      assert.ok(Number.isSafeInteger(topologyPids.direct_child));
      assert.ok(Number.isSafeInteger(topologyPids.descendant));
      assert.equal(
        processExists(topologyPids.direct_child),
        false,
        "the outer receipt left the TERM-resistant nested direct child alive",
      );
      assert.equal(
        processExists(topologyPids.descendant),
        false,
        "the outer receipt left the TERM-resistant nested descendant alive",
      );

      // The refusal is typed, and typed DISTINCTLY: reusing the command codes
      // would recreate the misattribution this plant exists to prevent.
      let refusal;
      try {
        localExecutionWindowOrRefuse(2_900, "apply-6");
        assert.fail("a truncated window must refuse before any spawn");
      } catch (error) {
        refusal = error;
      }
      assert.ok(refusal instanceof MigrationError);
      assert.equal(refusal.code, "LOCAL_D1_SUITE_BUDGET_EXHAUSTED");
      assert.notEqual(refusal.code, "LOCAL_D1_COMMAND_TIMEOUT");
      assert.notEqual(refusal.code, "LOCAL_D1_COMMAND_FAILED");
      assert.ok(
        refusal.message.includes("no command was started"),
        "the refusal must say nothing was started",
      );

      // No source-shape assertion here on purpose. Counting occurrences of the
      // runner's name in this file counts its own literal, its comments, and the
      // assertion message, so it fails for edits that change nothing and proves
      // nothing about behaviour. The causal seam test above is the proof; every
      // real site reaching it is enforced by the seam owning both the guard and
      // the spawn, which no caller can partially adopt.
    },
  },
  {
    name: "a-successful-local-command-returns-json",
    async execute() {
      const result = await localJson(uniqueDatabaseName("json"), "SELECT 1 AS ok;", "json-success");
      assert.equal(oneRow(result, "json-success").ok, 1);
    },
  },
  {
    name: "a-failing-local-command-surfaces-a-redacted-cause",
    async execute() {
      let thrown;
      try {
        await localJson(
          uniqueDatabaseName("diagnostic"),
          "SELECT * FROM a_table_that_does_not_exist;",
          "diagnostic-failure",
        );
        assert.fail("invalid local SQL must fail");
      } catch (error) {
        thrown = error;
      }
      assertSafeCause(thrown);
    },
  },
  {
    name: "actual CLI pristine local plan is side-effect-free and repeatable",
    async execute() {
      const arguments_ = ["--env", "local", "--local-persist-to", persistenceRoot];
      const first = await runActualLocalMigrationCli(arguments_, "pristine-plan-first");
      const second = await runActualLocalMigrationCli(arguments_, "pristine-plan-second");
      assert.equal(first.exitCode, 1, "the historical destructive guard must refuse before apply");
      assert.equal(second.exitCode, 1, "the repeated pristine plan must refuse identically");
      assert.equal(first.diagnostic.phase, "plan");
      assert.equal(second.diagnostic.phase, "plan");
      assert.equal(first.diagnostic.code, "UNDECLARED_DESTRUCTIVE_MIGRATION");
      assert.equal(second.diagnostic.code, first.diagnostic.code);
      assert.equal(second.diagnostic.detail, first.diagnostic.detail);
      const catalogResult = await runnerConfigJson(CATALOG_QUERY, "pristine-plan-control-readback");
      const catalog = catalogFromRows(
        statementRows(catalogResult, 0, "pristine-plan-control-readback"),
      );
      assert.equal(
        catalog.some((entry) => entry.name === LEDGER_TABLE || entry.name === LINEAGE_TABLE),
        false,
        "two actual CLI plan-only runs must not create runner control tables",
      );
    },
  },
  {
    name: "unterminated migration SQL is rejected before local D1 can mutate",
    async execute() {
      const databaseName = uniqueDatabaseName("unterminated-sql");
      await localJson(
        databaseName,
        "CREATE TABLE retained_sentinel (id TEXT PRIMARY KEY);",
        "unterminated-sql-seed",
      );
      const malformed = "CREATE TABLE swallowed_journal (id TEXT); /*";
      let rejected;
      try {
        migrationCommandSql(
          {
            id: "0001_unterminated.sql",
            sequence: 1,
            digest: "a".repeat(64),
            sql: malformed,
          },
          appliedAt,
        );
        assert.fail("unterminated SQL must not produce an executable local D1 command");
      } catch (error) {
        rejected = error;
      }
      assert.ok(rejected instanceof MigrationError);
      assert.equal(rejected.code, "UNTERMINATED_SQL_COMMENT");
      const catalog = await readCatalog(databaseName, "unterminated-sql-no-residue");
      assert.equal(
        catalog.some((entry) => entry.name === "retained_sentinel"),
        true,
      );
      assert.equal(
        catalog.some((entry) => entry.name === "swallowed_journal"),
        false,
      );
      assert.equal(
        catalog.some((entry) => entry.name === LEDGER_TABLE),
        false,
      );
    },
  },
  {
    name: "bootstrap baseline applies only to empty local D1 and leaves an empty journal",
    async execute() {
      const databaseName = uniqueDatabaseName("bootstrap");
      // A real Wrangler D1 command creates its own exact `_cf_METADATA`
      // table. It is platform control metadata, not caller contamination:
      // classification and the atomic bootstrap guard must still admit the
      // otherwise empty database, while any other table remains a refusal.
      await localJson(databaseName, "SELECT 1 AS ok;", "bootstrap-platform-metadata");
      const beforeBootstrap = await readCatalog(databaseName, "bootstrap-preflight-catalog");
      assert.equal(exactWranglerPlatformMetadata(beforeBootstrap).length, 1);
      assert.deepEqual(
        classifySchemaLineage({
          catalog: beforeBootstrap,
          journal: [],
          lineage: [],
          migrations,
          manifest: bootstrapManifest,
        }),
        { kind: "provably-empty", head: 0 },
        "the exact Wrangler platform table must not defeat empty-only bootstrap",
      );
      await localJson(
        databaseName,
        bootstrapInstallSql(bootstrapArtifact, appliedAt),
        "bootstrap-empty-apply",
      );
      const { catalog, journal, lineage } = await readSnapshot(
        databaseName,
        "bootstrap-snapshot",
        true,
      );
      assert.equal(catalogFingerprint(catalog), bootstrapArtifact.schema_digest);
      const witness = (
        await localJson(
          databaseName,
          "SELECT singleton, rule_version, passed FROM sponsor_enrollment_bootstrap_migration_witness;",
          "bootstrap-witness",
        )
      ).flatMap((statement) => statement.results ?? []);
      assert.equal(journal.length, 0, "bootstrap must not fabricate historical journal rows");
      assert.deepEqual(
        witness.map((row) => ({
          singleton: Number(row.singleton),
          rule_version: Number(row.rule_version),
          passed: Number(row.passed),
        })),
        [{ singleton: 1, rule_version: 1, passed: 1 }],
        "bootstrap must record exactly the immutable 0015 witness tuple",
      );
      assert.equal(
        classifySchemaLineage({
          catalog,
          journal,
          lineage,
          migrations,
          manifest: bootstrapManifest,
        }).kind,
        "bootstrap-baseline15",
      );

      // The installer is idempotent by classifier, rather than collision
      // masking: a second raw apply fails, while the durable lineage is the
      // positive proof that a runner must no-op.
      let secondApply;
      try {
        await localJson(
          databaseName,
          bootstrapInstallSql(bootstrapArtifact, appliedAt),
          "bootstrap-rerun",
        );
      } catch (error) {
        secondApply = error;
      }
      assertSafeCause(secondApply);

      const contaminated = uniqueDatabaseName("bootstrap-contaminated");
      await localJson(
        contaminated,
        "CREATE TABLE contamination (id TEXT);",
        "bootstrap-contamination",
      );
      let contaminatedApply;
      try {
        await localJson(
          contaminated,
          bootstrapInstallSql(bootstrapArtifact, appliedAt),
          "bootstrap-contamination-refusal",
        );
      } catch (error) {
        contaminatedApply = error;
      }
      assertSafeCause(contaminatedApply);
      const residue = oneRow(
        await localJson(
          contaminated,
          `SELECT COUNT(*) AS objects
             FROM sqlite_schema
            WHERE substr(name, 1, 7) <> 'sqlite_'
              AND NOT (
                type = 'table'
                AND name = '_cf_METADATA'
                AND tbl_name = '_cf_METADATA'
                AND sql = ${sqlLiteral(WRANGLER_LOCAL_METADATA_SQL)}
              );`,
          "bootstrap-contamination-residue",
        ),
        "bootstrap-contamination-residue",
      );
      assert.equal(
        Number(residue.objects),
        1,
        "contamination must refuse before lineage or schema apply",
      );

      // SQLite LIKE treats `_` as a wildcard and can fold case, but the
      // catalog classifier only excludes an exact lowercase `sqlite_` prefix.
      // This real D1 object must therefore refuse atomically and remain the
      // only non-platform residue after the failed CAS install.
      const sqlitePrefixLookalike = uniqueDatabaseName("bootstrap-sqlite-prefix-lookalike");
      await localJson(
        sqlitePrefixLookalike,
        "CREATE TABLE sqliteX_intruder (id TEXT);",
        "bootstrap-sqlite-prefix-lookalike",
      );
      const lookalikeCatalog = await readCatalog(
        sqlitePrefixLookalike,
        "bootstrap-sqlite-prefix-lookalike-catalog",
      );
      assert.equal(
        classifySchemaLineage({
          catalog: lookalikeCatalog,
          journal: [],
          lineage: [],
          migrations,
          manifest: bootstrapManifest,
        }).kind,
        "unknown-or-contaminated",
      );
      let lookalikeApply;
      try {
        await localJson(
          sqlitePrefixLookalike,
          bootstrapInstallSql(bootstrapArtifact, appliedAt),
          "bootstrap-sqlite-prefix-lookalike-refusal",
        );
      } catch (error) {
        lookalikeApply = error;
      }
      assertSafeCause(lookalikeApply);
      const lookalikeResidue = oneRow(
        await localJson(
          sqlitePrefixLookalike,
          `SELECT COUNT(*) AS objects,
                  SUM(CASE WHEN type = 'table' AND name = 'sqliteX_intruder' THEN 1 ELSE 0 END) AS intruder
             FROM sqlite_schema
            WHERE substr(name, 1, 7) <> 'sqlite_'
              AND NOT (
                type = 'table'
                AND name = '_cf_METADATA'
                AND tbl_name = '_cf_METADATA'
                AND sql = ${sqlLiteral(WRANGLER_LOCAL_METADATA_SQL)}
              );`,
          "bootstrap-sqlite-prefix-lookalike-residue",
        ),
        "bootstrap-sqlite-prefix-lookalike-residue",
      );
      assert.equal(Number(lookalikeResidue.objects), 1);
      assert.equal(Number(lookalikeResidue.intruder), 1);

      // Model the only relevant race point inside the same atomic command: a
      // trigger named like the lineage control object arrives after the exact
      // lineage table is created but before its empty-CAS INSERT evaluates.
      // A name-only exception would let this batch commit. The exact type,
      // table, and DDL predicate must make the CHECK fail and roll back every
      // artifact, the trigger, and both runner controls.
      const raced = uniqueDatabaseName("bootstrap-same-name-trigger-race");
      await localJson(raced, "SELECT 1 AS ok;", "bootstrap-race-platform-metadata");
      const trigger = `CREATE TRIGGER ${LINEAGE_TABLE}
AFTER INSERT ON ${LINEAGE_TABLE}
BEGIN
  SELECT 1;
END;`;
      const installer = bootstrapInstallSql(bootstrapArtifact, appliedAt);
      const racedInstaller = installer.replace(
        `INSERT INTO ${LINEAGE_TABLE}`,
        `${trigger}\nINSERT INTO ${LINEAGE_TABLE}`,
      );
      assert.notEqual(racedInstaller, installer, "race plant must reach the atomic guard window");
      let racedApply;
      try {
        await localJson(raced, racedInstaller, "bootstrap-same-name-trigger-race-refusal");
        assert.fail("same-name trigger race must fail the atomic empty guard");
      } catch (error) {
        racedApply = error;
      }
      assertSafeCause(racedApply);
      const racedCatalog = await readCatalog(raced, "bootstrap-same-name-trigger-race-no-residue");
      assert.equal(
        racedCatalog.some((entry) => entry.name === LEDGER_TABLE || entry.name === LINEAGE_TABLE),
        false,
        "same-name trigger race must leave no runner control residue",
      );
      assert.equal(
        racedCatalog.some(
          (entry) => entry.name === "sponsor_enrollment_bootstrap_migration_witness",
        ),
        false,
        "same-name trigger race must leave no bootstrap artifact residue",
      );
      assert.equal(
        racedCatalog.filter(
          (entry) => !entry.name.startsWith("sqlite_") && entry.name !== "_cf_METADATA",
        ).length,
        0,
        "same-name trigger race must roll back every non-platform object",
      );
    },
  },
  {
    name: "counterfeit runner control tables cannot establish bootstrap lineage",
    async execute() {
      const databaseName = uniqueDatabaseName("bootstrap-counterfeit-controls");
      // The prior successful bootstrap supplies exact real D1 control tables.
      // A same-name trigger is a counterfeit control object: it must remain in
      // the product fingerprint rather than letting the next bootstrap call
      // no-op based solely on the table's name and one lineage row.
      await localJson(
        databaseName,
        bootstrapInstallSql(bootstrapArtifact, appliedAt),
        "bootstrap-counterfeit-control-seed",
      );
      await localJson(
        databaseName,
        `CREATE TRIGGER _asimposium_schema_lineage
AFTER INSERT ON _asimposium_migrations
BEGIN
  SELECT 1;
END;`,
        "bootstrap-counterfeit-same-name-trigger",
      );
      const snapshot = await readSnapshot(
        databaseName,
        "bootstrap-counterfeit-control-snapshot",
        true,
      );
      assert.equal(
        classifySchemaLineage({
          ...snapshot,
          migrations,
          manifest: bootstrapManifest,
        }).kind,
        "unknown-or-contaminated",
        "a counterfeit control object must be product evidence, never a bootstrap no-op",
      );
    },
  },
  {
    name: "0015-real-wrangler-rolls-back-a-reachable-combined-orphan-and-retries-exactly",
    async execute() {
      const databaseName = uniqueDatabaseName("0015");

      await localJson(databaseName, LEDGER_DDL, "journal-create");
      await applyMigrations(databaseName, 1, 10);
      await localJson(databaseName, validAuthoritySeed(), "seed-valid-through-0010");
      await applyMigrations(databaseName, 11, 14);

      // This is the reachable pre-0015 history: 0011 validates the complete
      // authority chain, then the still-unguarded raw DELETE creates coupled
      // orphan Fellow+grant evidence. An independently manufactured grant-only
      // mismatch is intentionally not attempted: 0011 already rejects it.
      const deleted = await localJson(
        databaseName,
        `DELETE FROM sponsors WHERE sponsor_id = ${sqlLiteral(fixture.sponsorId)};
         SELECT COUNT(*) AS remaining
           FROM sponsors
          WHERE hex(sponsor_id) = ${hexLiteral(fixture.sponsorId)};`,
        "pre-0015-sponsor-delete",
      );
      assert.equal(
        Number(oneRow(deleted, "pre-0015-sponsor-delete").remaining),
        0,
        "pre-0015 sponsor delete must be reachable",
      );

      const exact0015Command = migrationJournalCommand(migration0015);
      let rejected;
      try {
        await localJson(databaseName, exact0015Command, "apply-0015-orphan-rejection");
        assert.fail("0015 must reject the reachable orphan Fellow+grant history");
      } catch (error) {
        rejected = error;
      }
      assertSafeCause(rejected);

      const afterFailure = oneRow(
        await localJson(databaseName, historyAndResidueQuery(), "0015-failure-residue"),
        "0015-failure-residue",
      );
      assertHistoricalRows(afterFailure, 0, 0, 0, 0, "failed 0015");

      // Repair exactly the missing durable authority row; historical evidence
      // remains untouched. Reuse the identical migration+journal command.
      await localJson(
        databaseName,
        `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
         VALUES (${sqlLiteral(fixture.sponsorId)}, ${fixture.createdAt}, ${fixture.createdAt});`,
        "restore-only-missing-sponsor",
      );
      await localJson(databaseName, exact0015Command, "apply-0015-retry");

      const afterRetry = oneRow(
        await localJson(databaseName, historyAndResidueQuery(), "0015-retry-proof"),
        "0015-retry-proof",
      );
      assertHistoricalRows(afterRetry, 1, 1, MIGRATION_TRIGGERS.length, 1, "successful 0015 retry");
      const witness = oneRow(
        await localJson(
          databaseName,
          `SELECT singleton, rule_version, passed
             FROM sponsor_enrollment_bootstrap_migration_witness
            WHERE singleton = 1;`,
          "0015-retry-witness",
        ),
        "0015-retry-witness",
      );
      assert.deepEqual(
        {
          singleton: Number(witness.singleton),
          rule_version: Number(witness.rule_version),
          passed: Number(witness.passed),
        },
        { singleton: 1, rule_version: 1, passed: 1 },
        "successful 0015 retry must retain the exact singleton witness",
      );

      // Snapshot W3-owned forward bytes with an before/after stability check.
      // Nothing in this lane writes those inputs; if they move, a mixed proof
      // is rejected rather than asserting against a stale synthetic head.
      const current0016 = stableCurrent0016Inputs();
      const {
        migration0016,
        migrationsThrough0016,
        manifest: currentManifest,
        schemaHead16,
      } = current0016;
      const currentArtifact = currentManifest.artifacts[0];

      // One causal convergence case starts from the committed historical 0015
      // state, a newly installed bootstrap state, and the committed legacy
      // 0009 shape. Both forward lanes execute W3's actual 0016 through the
      // runner command seam and compare their post-apply catalogs to the
      // production-loaded manifest head rather than manufacturing a digest.
      const { catalog: historicalCatalog, journal: historicalJournal } = await readSnapshot(
        databaseName,
        "historical-0015-snapshot",
      );
      assert.equal(
        catalogFingerprint(historicalCatalog),
        currentArtifact.schema_digest,
        "actual historical 0015 must match the committed baseline fingerprint",
      );
      assert.deepEqual(
        classifySchemaLineage({
          catalog: historicalCatalog,
          journal: historicalJournal,
          lineage: [],
          migrations: migrationsThrough0016,
          manifest: currentManifest,
        }),
        { kind: "historical-current-0015", head: 15 },
      );

      const legacyDatabase = uniqueDatabaseName("legacy-0009");
      await localJson(legacyDatabase, LEDGER_DDL, "legacy-journal-create");
      await applyMigrations(legacyDatabase, 1, 9);
      const { catalog: legacyCatalog, journal: legacyJournal } = await readSnapshot(
        legacyDatabase,
        "legacy-0009-snapshot",
      );
      assert.equal(
        catalogFingerprint(legacyCatalog),
        currentArtifact.legacy_0009_schema_digest,
        "actual exact legacy 0009 must match the committed legacy fingerprint",
      );
      assert.deepEqual(
        classifySchemaLineage({
          catalog: legacyCatalog,
          journal: legacyJournal,
          lineage: [],
          migrations: migrationsThrough0016,
          manifest: currentManifest,
        }),
        { kind: "legacy-0009", head: 9 },
      );

      const bootstrapDatabase = uniqueDatabaseName("lineage-bootstrap");
      await localJson(
        bootstrapDatabase,
        bootstrapInstallSql(currentArtifact, appliedAt),
        "lineage-bootstrap-apply",
      );
      const {
        catalog: bootstrapCatalog,
        journal: bootstrapJournal,
        lineage: bootstrapLineage,
      } = await readSnapshot(bootstrapDatabase, "lineage-bootstrap-snapshot", true);
      assert.equal(catalogFingerprint(bootstrapCatalog), currentArtifact.schema_digest);
      assert.deepEqual(
        wranglerPlatformMetadata(bootstrapCatalog),
        wranglerPlatformMetadata(historicalCatalog),
        "historical and bootstrap local D1 catalogs must carry identical platform metadata",
      );
      assert.deepEqual(productCatalog(bootstrapCatalog), productCatalog(historicalCatalog));
      assert.deepEqual(
        classifySchemaLineage({
          catalog: bootstrapCatalog,
          journal: bootstrapJournal,
          lineage: bootstrapLineage,
          migrations: migrationsThrough0016,
          manifest: currentManifest,
        }),
        {
          kind: "bootstrap-baseline15",
          head: 15,
          artifact_id: currentArtifact.id,
          journal_records: 0,
        },
      );

      assert.deepEqual(
        planMigrations(migrationsThrough0016, historicalJournal, localPlanOptions).to_apply.map(
          (migration) => migration.id,
        ),
        [migration0016.id],
      );
      assert.deepEqual(
        planMigrations(migrationsThrough0016, bootstrapJournal, {
          ...localPlanOptions,
          baseline: { head: 15 },
        }).to_apply.map((migration) => migration.id),
        [migration0016.id],
      );
      await localJson(
        databaseName,
        migrationJournalCommand(migration0016),
        "historical-forward-apply",
      );
      await localJson(
        bootstrapDatabase,
        migrationJournalCommand(migration0016),
        "bootstrap-forward-apply",
      );
      const { catalog: historicalForwardCatalog, journal: historicalForwardJournal } =
        await readSnapshot(databaseName, "historical-forward-snapshot");
      const { catalog: bootstrapForwardCatalog, journal: bootstrapForwardJournal } =
        await readSnapshot(bootstrapDatabase, "bootstrap-forward-snapshot");
      assertCurrent0016InputsUnchanged(current0016);
      assert.equal(
        catalogFingerprint(historicalForwardCatalog),
        catalogFingerprint(bootstrapForwardCatalog),
        "the actual shared 0016 must leave byte-identical product catalog fingerprints",
      );
      assert.equal(
        catalogFingerprint(historicalForwardCatalog),
        schemaHead16.schema_digest,
        "historical 0016 must equal the production manifest's exact head-16 fingerprint",
      );
      assert.equal(
        catalogFingerprint(bootstrapForwardCatalog),
        schemaHead16.schema_digest,
        "bootstrap 0016 must equal the production manifest's exact head-16 fingerprint",
      );
      assert.deepEqual(
        productCatalog(historicalForwardCatalog),
        productCatalog(bootstrapForwardCatalog),
        "the shared 0016 must leave byte-identical product catalog entries",
      );
      const expectedForwardJournal = {
        id: migration0016.id,
        sequence: migration0016.sequence,
        digest: migration0016.digest,
      };
      assert.deepEqual(
        historicalForwardJournal.at(-1),
        expectedForwardJournal,
        "historical 0016 must append the exact production migration journal record",
      );
      assert.deepEqual(
        bootstrapForwardJournal,
        [expectedForwardJournal],
        "bootstrap 0016 must append only the exact production migration journal record",
      );
      const historicalForwardLineage = classifySchemaLineage({
        catalog: historicalForwardCatalog,
        journal: historicalForwardJournal,
        lineage: [],
        migrations: migrationsThrough0016,
        manifest: currentManifest,
      });
      assert.deepEqual(historicalForwardLineage, { kind: "historical-forward", head: 16 });
      const bootstrapForwardLineage = classifySchemaLineage({
        catalog: bootstrapForwardCatalog,
        journal: bootstrapForwardJournal,
        lineage: bootstrapLineage,
        migrations: migrationsThrough0016,
        manifest: currentManifest,
      });
      assert.deepEqual(bootstrapForwardLineage, {
        kind: "bootstrap-baseline15",
        head: 16,
        artifact_id: currentArtifact.id,
        journal_records: 1,
      });
      assert.equal(
        planMigrations(migrationsThrough0016, historicalForwardJournal, localPlanOptions)
          .idempotent,
        true,
        "historical-forward lineage must reclassify to an empty second plan",
      );
      assert.equal(
        planMigrations(migrationsThrough0016, bootstrapForwardJournal, {
          ...localPlanOptions,
          baseline: { head: bootstrapForwardLineage.head },
        }).idempotent,
        true,
        "bootstrap-forward lineage must reclassify to an empty second plan",
      );
      await localJson(
        bootstrapDatabase,
        "CREATE TABLE planted_divergent_forward (id TEXT PRIMARY KEY);",
        "bootstrap-forward-divergent-ddl",
      );
      const divergent = await readSnapshot(
        bootstrapDatabase,
        "bootstrap-forward-divergent-snapshot",
      );
      assert.equal(
        classifySchemaLineage({
          catalog: divergent.catalog,
          journal: divergent.journal,
          lineage: bootstrapLineage,
          migrations: migrationsThrough0016,
          manifest: currentManifest,
        }).kind,
        "unknown-or-contaminated",
        "divergent DDL must not ride the shared 0016 suffix",
      );

      for (const [label, statement] of [
        [
          "0015-witness-update-immutable",
          "UPDATE sponsor_enrollment_bootstrap_migration_witness SET rule_version = rule_version + 1;",
        ],
        [
          "0015-witness-delete-immutable",
          "DELETE FROM sponsor_enrollment_bootstrap_migration_witness WHERE singleton = 1;",
        ],
      ]) {
        let immutable;
        try {
          await localJson(databaseName, statement, label);
          assert.fail(`${label} must fail`);
        } catch (error) {
          immutable = error;
        }
        assertSafeCause(immutable);
      }
    },
  },
];

const topologyFixtureIndex = process.argv.indexOf(PARENT_OWNED_TOPOLOGY_FIXTURE);
const ownerLeaseEofFixtureIndex = process.argv.indexOf(OWNER_LEASE_EOF_FIXTURE);
if (ownerLeaseEofFixtureIndex >= 0) {
  const deadline = process.argv[ownerLeaseEofFixtureIndex + 1];
  if (!/^(?:0|[1-9][0-9]*)$/.test(deadline ?? "") || !Number.isSafeInteger(Number(deadline))) {
    throw new Error("the owner-lease EOF fixture requires one exact epoch deadline");
  }
  await runOwnerLeaseEofFixture(Number(deadline));
} else if (topologyFixtureIndex >= 0) {
  const deadline = process.argv[topologyFixtureIndex + 1];
  if (!/^(?:0|[1-9][0-9]*)$/.test(deadline ?? "") || !Number.isSafeInteger(Number(deadline))) {
    throw new Error("the parent-owned topology fixture requires one exact epoch deadline");
  }
  await runParentOwnedTopologyFixture(Number(deadline));
} else {
  const requestedCaseNames = process.env.ASIMPOSIUM_MIGRATE_LOCAL_CASES?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const selectedCases =
    requestedCaseNames === undefined
      ? cases
      : cases.filter((testCase) => requestedCaseNames.includes(testCase.name));
  if (requestedCaseNames !== undefined && selectedCases.length !== requestedCaseNames.length) {
    throw new Error(
      "ASIMPOSIUM_MIGRATE_LOCAL_CASES must name existing exact local migration cases.",
    );
  }

  const failed = [];
  for (const testCase of selectedCases) {
    try {
      await testCase.execute();
    } catch (error) {
      failed.push({
        name: testCase.name,
        detail: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  const base = {
    tool: "bun",
    package: "infra",
    suite: "d1-migration-local-integration",
    version: Bun.version,
    duration_ms: Math.round(performance.now() - startedAt),
    reproduce,
    migration_0015_sha256: migration0015.digest,
  };

  if (failed.length === 0) {
    process.stdout.write(
      `${JSON.stringify({
        ...base,
        status: "pass",
        cases_executed: selectedCases.map(({ name }) => name),
        database: "unique Wrangler local D1/workerd databases; no remote resource touched",
      })}\n`,
    );
  } else {
    process.stderr.write(
      `${JSON.stringify({
        ...base,
        status: "fail",
        code: "CONTRACT_CASES_FAILED",
        failed_cases: failed.map(({ name }) => name),
        assertion_diff: failed,
      })}\n`,
    );
    process.exitCode = 1;
  }
}
