import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  assertReadLimit,
  bootstrapInstallSql,
  catalogFingerprint,
  classifySchemaLineage,
  LEDGER_TABLE,
  MAX_CATALOG_ROWS,
  MAX_JOURNAL_ROWS,
  MAX_LINEAGE_ROWS,
  MigrationError,
  planMigrations,
  readBootstrapManifest,
  readMigrationDirectory,
  redactStderr,
  resolvePinnedWranglerCommand,
  runBoundedCommand,
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
const bootstrapManifest = readBootstrapManifest(root);
const bootstrapArtifact = bootstrapManifest.artifacts[0];
assert.ok(migration0015, "0015 must exist before the local rollback gate can run");
assert.equal(
  migration0015.id,
  "0015_sponsor_enrollment_bootstrap_invariant.sql",
  "sequence 0015 must remain the sponsor-bootstrap invariant",
);

const syntheticForwardMigration = {
  id: "0016_bootstrap_lineage_convergence.sql",
  sequence: 16,
  digest: "c".repeat(64),
  sql: "CREATE TABLE bootstrap_lineage_forward (id TEXT PRIMARY KEY);",
};
const migrationsWithSyntheticForward = [...migrations, syntheticForwardMigration];
const localPlanOptions = { environmentName: "local", destructiveAllowed: false };

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

/**
 * This uses the shipped bounded executor with an outside-repository persistence
 * root, so this integration lane exercises the same group/pipe containment as
 * the real local migration CLI while retaining its isolated test databases.
 */
async function boundedLocalD1(databaseName, args, label) {
  const deadline = commandDeadline(label);
  const executionWindowMs = remainingBefore(deadline, label) - COMMAND_REAP_RESERVE_MS;
  assert.ok(executionWindowMs > 0, `local D1 ${label} lacks time for bounded child reaping`);
  const result = await runBoundedCommand({
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
    timeoutMs: executionWindowMs,
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

async function readCatalog(databaseName, label) {
  const rows = (
    await localJson(
      databaseName,
      `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT ${MAX_CATALOG_ROWS + 1};`,
      label,
    )
  ).flatMap((statement) => statement.results ?? []);
  return assertReadLimit(rows, MAX_CATALOG_ROWS, "LOCAL_D1_CATALOG_OVERRUN").map((row) => ({
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl_name),
    sql: row.sql === null ? null : String(row.sql),
  }));
}

async function readJournal(databaseName, label) {
  const rows = (
    await localJson(
      databaseName,
      `SELECT id, sequence, digest FROM ${LEDGER_TABLE} ORDER BY sequence LIMIT ${MAX_JOURNAL_ROWS + 1};`,
      label,
    )
  ).flatMap((statement) => statement.results ?? []);
  return assertReadLimit(rows, MAX_JOURNAL_ROWS, "LOCAL_D1_JOURNAL_OVERRUN").map((row) => ({
    id: String(row.id),
    sequence: Number(row.sequence),
    digest: String(row.digest),
  }));
}

function manifestWithSyntheticForward(catalog) {
  return {
    ...bootstrapManifest,
    schema_heads: [
      ...bootstrapManifest.schema_heads,
      {
        sequence: syntheticForwardMigration.sequence,
        schema_digest: catalogFingerprint(catalog),
      },
    ],
  };
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

async function readLineage(databaseName, label) {
  const rows = (
    await localJson(
      databaseName,
      `SELECT lineage, artifact_id, artifact_digest, schema_digest FROM _asimposium_schema_lineage LIMIT ${MAX_LINEAGE_ROWS + 1};`,
      label,
    )
  ).flatMap((statement) => statement.results ?? []);
  return assertReadLimit(rows, MAX_LINEAGE_ROWS, "LOCAL_D1_LINEAGE_OVERRUN").map((row) => ({
    lineage: String(row.lineage),
    artifact_id: String(row.artifact_id),
    artifact_digest: String(row.artifact_digest),
    schema_digest: String(row.schema_digest),
  }));
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
      const catalog = await readCatalog(databaseName, "bootstrap-catalog");
      assert.equal(catalogFingerprint(catalog), bootstrapArtifact.schema_digest);
      const journal = await readJournal(databaseName, "bootstrap-empty-journal");
      const lineage = await readLineage(databaseName, "bootstrap-lineage");
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
            WHERE name NOT LIKE 'sqlite_%'
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

      // One causal convergence case starts from the committed historical 0015
      // state, a newly installed bootstrap state, and the committed legacy
      // 0009 shape. The later 0016 manifest is derived once from historical
      // output and is deliberately reused for both 0016 classifications.
      const historicalCatalog = await readCatalog(databaseName, "historical-0015-catalog");
      const historicalJournal = await readJournal(databaseName, "historical-0015-journal");
      assert.equal(
        catalogFingerprint(historicalCatalog),
        bootstrapArtifact.schema_digest,
        "actual historical 0015 must match the committed baseline fingerprint",
      );
      assert.deepEqual(
        classifySchemaLineage({
          catalog: historicalCatalog,
          journal: historicalJournal,
          lineage: [],
          migrations,
          manifest: bootstrapManifest,
        }),
        { kind: "historical-current-0015", head: 15 },
      );

      const legacyDatabase = uniqueDatabaseName("legacy-0009");
      await localJson(legacyDatabase, LEDGER_DDL, "legacy-journal-create");
      await applyMigrations(legacyDatabase, 1, 9);
      const legacyCatalog = await readCatalog(legacyDatabase, "legacy-0009-catalog");
      const legacyJournal = await readJournal(legacyDatabase, "legacy-0009-journal");
      assert.equal(
        catalogFingerprint(legacyCatalog),
        bootstrapArtifact.legacy_0009_schema_digest,
        "actual exact legacy 0009 must match the committed legacy fingerprint",
      );
      assert.deepEqual(
        classifySchemaLineage({
          catalog: legacyCatalog,
          journal: legacyJournal,
          lineage: [],
          migrations,
          manifest: bootstrapManifest,
        }),
        { kind: "legacy-0009", head: 9 },
      );

      const bootstrapDatabase = uniqueDatabaseName("lineage-bootstrap");
      await localJson(
        bootstrapDatabase,
        bootstrapInstallSql(bootstrapArtifact, appliedAt),
        "lineage-bootstrap-apply",
      );
      const bootstrapCatalog = await readCatalog(bootstrapDatabase, "lineage-bootstrap-catalog");
      const bootstrapJournal = await readJournal(bootstrapDatabase, "lineage-bootstrap-journal");
      const bootstrapLineage = await readLineage(bootstrapDatabase, "lineage-bootstrap-lineage");
      assert.equal(catalogFingerprint(bootstrapCatalog), bootstrapArtifact.schema_digest);
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
          migrations,
          manifest: bootstrapManifest,
        }),
        {
          kind: "bootstrap-baseline15",
          head: 15,
          artifact_id: bootstrapArtifact.id,
          journal_records: 0,
        },
      );

      assert.deepEqual(
        planMigrations(
          migrationsWithSyntheticForward,
          historicalJournal,
          localPlanOptions,
        ).to_apply.map((migration) => migration.id),
        [syntheticForwardMigration.id],
      );
      assert.deepEqual(
        planMigrations(migrationsWithSyntheticForward, bootstrapJournal, {
          ...localPlanOptions,
          baseline: { head: 15 },
        }).to_apply.map((migration) => migration.id),
        [syntheticForwardMigration.id],
      );
      await localJson(
        databaseName,
        migrationJournalCommand(syntheticForwardMigration),
        "historical-forward-apply",
      );
      await localJson(
        bootstrapDatabase,
        migrationJournalCommand(syntheticForwardMigration),
        "bootstrap-forward-apply",
      );
      const historicalForwardCatalog = await readCatalog(
        databaseName,
        "historical-forward-catalog",
      );
      const historicalForwardJournal = await readJournal(
        databaseName,
        "historical-forward-journal",
      );
      const bootstrapForwardCatalog = await readCatalog(
        bootstrapDatabase,
        "bootstrap-forward-catalog",
      );
      const bootstrapForwardJournal = await readJournal(
        bootstrapDatabase,
        "bootstrap-forward-journal",
      );
      const sharedForwardManifest = manifestWithSyntheticForward(historicalForwardCatalog);
      assert.equal(
        catalogFingerprint(historicalForwardCatalog),
        catalogFingerprint(bootstrapForwardCatalog),
        "the shared 0016 must leave byte-identical product catalog fingerprints",
      );
      assert.deepEqual(
        productCatalog(historicalForwardCatalog),
        productCatalog(bootstrapForwardCatalog),
        "the shared 0016 must leave byte-identical product catalog entries",
      );
      const historicalForwardLineage = classifySchemaLineage({
        catalog: historicalForwardCatalog,
        journal: historicalForwardJournal,
        lineage: [],
        migrations: migrationsWithSyntheticForward,
        manifest: sharedForwardManifest,
      });
      assert.deepEqual(historicalForwardLineage, { kind: "historical-forward", head: 16 });
      const bootstrapForwardLineage = classifySchemaLineage({
        catalog: bootstrapForwardCatalog,
        journal: bootstrapForwardJournal,
        lineage: bootstrapLineage,
        migrations: migrationsWithSyntheticForward,
        manifest: sharedForwardManifest,
      });
      assert.deepEqual(bootstrapForwardLineage, {
        kind: "bootstrap-baseline15",
        head: 16,
        artifact_id: bootstrapArtifact.id,
        journal_records: 1,
      });
      assert.equal(
        planMigrations(migrationsWithSyntheticForward, historicalForwardJournal, localPlanOptions)
          .idempotent,
        true,
        "historical-forward lineage must reclassify to an empty second plan",
      );
      assert.equal(
        planMigrations(migrationsWithSyntheticForward, bootstrapForwardJournal, {
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
      assert.equal(
        classifySchemaLineage({
          catalog: await readCatalog(bootstrapDatabase, "bootstrap-forward-divergent-catalog"),
          journal: await readJournal(bootstrapDatabase, "bootstrap-forward-divergent-journal"),
          lineage: bootstrapLineage,
          migrations: migrationsWithSyntheticForward,
          manifest: sharedForwardManifest,
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
