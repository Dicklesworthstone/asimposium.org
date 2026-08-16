import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  LEDGER_TABLE,
  MigrationError,
  readMigrationDirectory,
  redactStderr,
  resolvePinnedWranglerCommand,
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
const TERMINATE_GRACE_MS = 500;
const KILL_REAP_MS = 500;
const OUTPUT_DRAIN_MS = 500;
const COMMAND_REAP_RESERVE_MS = TERMINATE_GRACE_MS + KILL_REAP_MS + OUTPUT_DRAIN_MS;
const TOTAL_TIMEOUT_MS = 180_000;
const deadlineAt = startedAt + TOTAL_TIMEOUT_MS;
const appliedAt = "2026-08-16T00:00:00.000Z";
const localConfigPaths = new Map();

const migrations = readMigrationDirectory(resolve(root, "db/migrations"));
const migrationBySequence = new Map(migrations.map((migration) => [migration.sequence, migration]));
const migration0015 = migrationBySequence.get(15);
assert.ok(migration0015, "0015 must exist before the local rollback gate can run");
assert.equal(
  migration0015.id,
  "0015_sponsor_enrollment_bootstrap_invariant.sql",
  "sequence 0015 must remain the sponsor-bootstrap invariant",
);

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

function commandDeadline(label) {
  const remaining = Math.floor(deadlineAt - performance.now());
  const commandBudget = Math.min(PER_COMMAND_TIMEOUT_MS, remaining);
  assert.ok(
    commandBudget > COMMAND_REAP_RESERVE_MS,
    `local D1 suite exhausted its deadline before ${label}`,
  );
  return performance.now() + commandBudget;
}

function remainingBefore(deadline, label) {
  const remaining = Math.floor(deadline - performance.now());
  assert.ok(remaining > 0, `local D1 ${label} exceeded its deadline`);
  return remaining;
}

async function waitForChildExit(child, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ exited: false }), timeoutMs);
  });
  const exited = child.exited.then((exitCode) => ({ exited: true, exitCode }));
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  return result;
}

function signalDirectChild(child, signal) {
  // Signal the Bun-owned handle, never process.kill(child.pid): a PID can be
  // reused if the child exits between checks, whereas this handle remains tied
  // to the direct Wrangler process that Bun spawned.
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

async function reapBoundedChild(
  child,
  executionWindowMs,
  { terminateGraceMs = TERMINATE_GRACE_MS, killReapMs = KILL_REAP_MS } = {},
) {
  const initial = await waitForChildExit(child, executionWindowMs);
  if (initial.exited) {
    return {
      exitCode: initial.exitCode,
      forcedSignal: null,
      reaped: true,
      timedOut: false,
    };
  }

  assert.ok(
    Number.isSafeInteger(child.pid) && child.pid > 0,
    "local D1 command must retain a direct Bun child PID for timeout reaping",
  );
  signalDirectChild(child, "SIGTERM");
  const afterTerminate = await waitForChildExit(child, terminateGraceMs);
  if (afterTerminate.exited) {
    return {
      exitCode: afterTerminate.exitCode,
      forcedSignal: "SIGTERM",
      reaped: true,
      timedOut: true,
    };
  }

  signalDirectChild(child, "SIGKILL");
  const afterKill = await waitForChildExit(child, killReapMs);
  return {
    exitCode: afterKill.exited ? afterKill.exitCode : undefined,
    forcedSignal: "SIGKILL",
    reaped: afterKill.exited,
    timedOut: true,
  };
}

async function readChildOutput(child, timeoutMs) {
  let timer;
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([stdout, stderr]) => ({ complete: true, stderr, stdout }));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ complete: false }), timeoutMs);
  });
  const result = await Promise.race([output, timeout]);
  clearTimeout(timer);
  return result;
}

/**
 * This is intentionally test-local rather than a shared helper change: it is
 * the same local Wrangler D1 arguments and JSON transport as `localD1()`, with
 * an outside-repository persistence root and explicit deadlines. It shares the
 * runner's lock-pinned command resolver, so neither lane can select a global
 * Wrangler through PATH.
 */
async function boundedLocalD1(databaseName, args, label) {
  const deadline = commandDeadline(label);
  let child;
  try {
    child = Bun.spawn({
      cmd: [
        ...resolvePinnedWranglerCommand(root),
        "d1",
        "execute",
        databaseName,
        "--local",
        "--config",
        localConfigPath(databaseName),
        "--persist-to",
        persistenceRoot,
        "--json",
        ...args,
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new MigrationError("LOCAL_D1_COMMAND_FAILED", `Could not start local D1 ${label}.`);
  }

  const executionWindowMs = remainingBefore(deadline, label) - COMMAND_REAP_RESERVE_MS;
  assert.ok(executionWindowMs > 0, `local D1 ${label} lacks time for bounded child reaping`);
  const reaped = await reapBoundedChild(child, executionWindowMs);
  if (reaped.timedOut) {
    throw new MigrationError(
      "LOCAL_D1_COMMAND_TIMEOUT",
      reaped.reaped
        ? `Local D1 ${label} exceeded its deadline and was reaped.`
        : `Local D1 ${label} exceeded its deadline after SIGKILL.`,
    );
  }
  const output = await readChildOutput(
    child,
    Math.min(OUTPUT_DRAIN_MS, remainingBefore(deadline, label)),
  );
  if (!output.complete) {
    throw new MigrationError(
      "LOCAL_D1_COMMAND_TIMEOUT",
      `Local D1 ${label} exceeded its deadline while draining output.`,
    );
  }
  if (reaped.exitCode !== 0) {
    const safeStderr = redactStderr(output.stderr);
    const safeStdout = redactStderr(output.stdout);
    throw new MigrationError(
      "LOCAL_D1_COMMAND_FAILED",
      `A local D1 ${label} command failed.`,
      safeStderr !== ""
        ? { output: safeStderr, stream: "stderr" }
        : { output: safeStdout, stream: "stdout" },
    );
  }
  return output.stdout;
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
  // This is byte-for-byte the runner's production command shape: migration
  // SQL followed by the journal insert in the same Wrangler `--command` call.
  return `${migration.sql}\nINSERT INTO ${LEDGER_TABLE} (id, sequence, digest, applied_at) VALUES (${sqlLiteral(migration.id)}, ${migration.sequence}, ${sqlLiteral(migration.digest)}, ${sqlLiteral(appliedAt)});`;
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
    name: "a-timeout-controller-escalates-a-stuck-direct-child-without-awaiting-it",
    async execute() {
      const signals = [];
      const neverExits = new Promise(() => {});
      const reaped = await reapBoundedChild(
        {
          exited: neverExits,
          kill(signal) {
            signals.push(signal);
            return true;
          },
          pid: 24_680,
        },
        1,
        { killReapMs: 1, terminateGraceMs: 1 },
      );

      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.deepEqual(reaped, {
        exitCode: undefined,
        forcedSignal: "SIGKILL",
        reaped: false,
        timedOut: true,
      });
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

const failed = [];
for (const testCase of cases) {
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
      cases_executed: cases.map(({ name }) => name),
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
