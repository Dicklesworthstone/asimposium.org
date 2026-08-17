import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { REDACTED_TOKEN } from "@asimposium/contracts/diagnostic-safety";
import {
  applyPendingLocalMigrationsOrRefuse,
  assertReadLimit,
  assertReadOnlySql,
  assertRehearsalIsNotAnApplication,
  assertRemoteTargetIdentity,
  bootstrapTargetDisposition,
  catalogFingerprint,
  classifySchemaLineage,
  declaresDestructive,
  describeDestructiveStatements,
  digestOf,
  localPlanState,
  MAX_REMOTE_RESPONSE_BYTES,
  MAX_REMOTE_STRING_BYTES,
  MigrationError,
  migrationCommandSql,
  planMigrations,
  REMOTE_OBSERVATION_DEADLINE_MS,
  readBootstrapManifest,
  readBootstrapSnapshotOrRefuse,
  readMigrationDirectory,
  readRemoteLineageSnapshotOrRefuse,
  readStateFile,
  redactStderr,
  resolvePinnedWranglerCommand,
  runBoundedCommand,
} from "./migrate.mjs";
import {
  maskAbsolutePaths,
  selectEnvironment,
  validateEnvironments,
} from "./validate-environments.mjs";

/**
 * Negative corpus for the migration planner.
 *
 * The planner is pure, so every ordering, checksum, idempotency, and
 * destructive-guard rule is exercised here against synthetic migration
 * directories in temporary space. `db/migrations/` is owned by W2/S-2 and is
 * never written to by this suite.
 *
 * What this does NOT do: apply anything. No D1, local or remote, is created,
 * opened, or written. A green run here says the planner decides correctly, not
 * that a migration has ever executed.
 */

const startedAt = performance.now();
const reproduce = "bun infra/migrate.test.mjs";
const space = mkdtempSync(join(tmpdir(), "asimposium-migrations-"));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const INSTALLED_WRANGLER_ENTRY = join(
  repositoryRoot,
  "apps/wire/node_modules/wrangler/bin/wrangler.js",
);
const INSTALLED_WRANGLER_MANIFEST = join(
  repositoryRoot,
  "apps/wire/node_modules/wrangler/package.json",
);
const HISTORICAL_0015_GOLDEN_PINS = Object.freeze([
  {
    id: "0001_krater_v0.sql",
    sha256: "d2a9964bdc0b75401d4bce52f1ddcefc195ff369690739644217bd3df9589c78",
  },
  {
    id: "0002_enrollment_g0.sql",
    sha256: "2e2921e092912e70ce5236cb6fe6d7301169e635c69ce84d342a91ca7c765ddd",
  },
  {
    id: "0003_auth_nonce_replay.sql",
    sha256: "36f88d5bc61099f48df7af96773aefb56f5b98c8e3d73d3229cf712d2d35574e",
  },
  {
    id: "0004_krater_integrity_v1.sql",
    sha256: "8bdc5e6064b8792e39896805fe93ef0d9a79ff6dcac1d13d8010047f8736714d",
  },
  {
    id: "0005_krater_undigested_index.sql",
    sha256: "db4bc775f41bc55b1c497fede98ff4f2a6a1ae103e1397435bb320de6e9bdb11",
  },
  {
    id: "0006_fellow_credential_lifecycle.sql",
    sha256: "9637f5c7d5fddfbe45b7c105f7e5d312931f3b2a3f5dd80eb7a5bc102a890721",
  },
  {
    id: "0007_outbox_quarantine_state.sql",
    sha256: "ae49578397bedacf96b9104ab86b1336aa79d6f22a2a969b01134091215613e5",
  },
  {
    id: "0008_sponsors_bootstrap.sql",
    sha256: "d6f29f63b7bda0d48fd15f9a2c426d7b8cd83113214a5c54fe3444b963081f72",
  },
  {
    id: "0009_device_flow.sql",
    sha256: "a7cfe8162cdd1cbc55fe402eab83614c0747e8e4900087d53134f83439222211",
  },
  {
    id: "0010_device_flow_hardening.sql",
    sha256: "6df3d5ba4af806b5ebea4badff463da1ea4eca5d984435f69930b99b4714438a",
  },
  {
    id: "0011_fellow_credential_hardening.sql",
    sha256: "65b9d1e2e1b1ab59432766f44a085e38497d9d6b729ffa49fadd4637c3105abe",
  },
  {
    id: "0012_fellow_lifecycle_commands.sql",
    sha256: "75b302cb83bd93e9d00ff8a6b0f682b9ecd48f5c7b294606e9c306bbb954815e",
  },
  {
    id: "0013_sponsor_fellow_cap.sql",
    sha256: "d103880cdf3cc5addf8b2e86569fc83fc13238ff05e77c8ef402f43675a372a5",
  },
  {
    id: "0014_sponsor_enrollment_rate_limit.sql",
    sha256: "0852b831ab725f8ae59e88f11afe6fa6f663f7e4f4b978b8f7159c3c77858136",
  },
  {
    id: "0015_sponsor_enrollment_bootstrap_invariant.sql",
    sha256: "9ecad74b937992efbb43732a9511f7bb00ab1a4064810114b7e3087a2b83d307",
  },
]);

function pinnedWranglerFileSystem(overrides = {}) {
  return {
    existsSync: overrides.existsSync ?? existsSync,
    lstatSync: overrides.lstatSync ?? lstatSync,
    readFileSync: overrides.readFileSync ?? readFileSync,
  };
}

function exactDeclaredWranglerVersion() {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "apps/wire/package.json"), "utf8"));
  return manifest.devDependencies.wrangler;
}

/**
 * Run the real CLI and return what a caller would actually see.
 *
 * The redaction rule is about what reaches stdout and stderr, so asserting on a
 * thrown error object would test one layer above the one that matters. This
 * refuses before it reaches a database: an unknown environment cannot be
 * resolved to a target, so no D1 is opened.
 */
function runCli(args) {
  const result = Bun.spawnSync(["bun", "infra/migrate.mjs", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return { exitCode: result.exitCode, stdout, stderr, combined: `${stdout}${stderr}` };
}

/** The last JSON line a run emitted on stderr. */
function refusalOf(run) {
  return JSON.parse(run.stderr.trim().split("\n").at(-1));
}

function directory(name, files) {
  const root = join(space, name);
  mkdirSync(root, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(root, filename), content, "utf8");
  }
  return root;
}

function bootstrapFixtureRoot(name, artifactSql, artifactDigest = digestOf(artifactSql)) {
  const root = join(space, name);
  const bootstrap = join(root, "db", "bootstrap");
  mkdirSync(bootstrap, { recursive: true });
  writeFileSync(join(bootstrap, "0015_final_schema_v1.sql"), artifactSql, "utf8");
  writeFileSync(
    join(bootstrap, "manifest.json"),
    JSON.stringify({
      version: 1,
      default_artifact_id: "0015-final-schema-v1",
      artifacts: [
        {
          id: "0015-final-schema-v1",
          file: "0015_final_schema_v1.sql",
          head_sequence: 15,
          digest: artifactDigest,
          schema_digest: "a".repeat(64),
          legacy_0009_schema_digest: "b".repeat(64),
        },
      ],
      historical_migrations: HISTORICAL_0015_GOLDEN_PINS,
      schema_heads: [{ sequence: 15, schema_digest: "a".repeat(64) }],
    }),
    "utf8",
  );
  return root;
}

function closedPipe(bytes = []) {
  return new ReadableStream({
    start(controller) {
      for (const value of bytes) controller.enqueue(value);
      controller.close();
    },
  });
}

function neverClosingPipe() {
  return new ReadableStream({ start() {} });
}

/** A reader whose pending drain and cancellation both remain unproven. */
function unprovenPipe() {
  return {
    getReader() {
      return {
        cancel() {
          return new Promise(() => {});
        },
        read() {
          return new Promise(() => {});
        },
        releaseLock() {
          throw new TypeError("fixture reader remains locked");
        },
      };
    },
  };
}

/**
 * A pipe that parks a reader exactly the way a stuck child does, and records
 * whether anything ever let go of it. `pull` never settles, so the drain loop
 * sits inside `read()` until something cancels the reader; the underlying
 * `cancel` hook is the only way that can be observed from outside.
 */
function parkedPipe() {
  const state = { cancelCount: 0 };
  state.stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      state.cancelCount += 1;
    },
  });
  return state;
}

/** One over-limit chunk followed by a parked read, with cancellation observed. */
function overflowThenParkedPipe() {
  const state = { cancelCount: 0, sent: false };
  state.stream = new ReadableStream({
    pull(controller) {
      if (!state.sent) {
        state.sent = true;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        return;
      }
      return new Promise(() => {});
    },
    cancel() {
      state.cancelCount += 1;
    },
  });
  return state;
}

function expectFailure(label, expectedCode, fn) {
  try {
    fn();
    assert.fail(`${label}: expected ${expectedCode}, but it succeeded`);
  } catch (error) {
    assert.ok(error instanceof MigrationError, `${label}: unexpected ${error}`);
    assert.equal(error.code, expectedCode, `${label}: ${error.message}`);
    assert.equal(/(?:^|\s)\/(?:Users|home|private|tmp|var)\//.test(error.message), false, label);
  }
}

/**
 * The awaited sibling of `expectFailure`, with the same assertions.
 *
 * The remote observation seam is async, and `expectFailure` would see a pending
 * promise rather than a refusal — a rejected promise would surface as an
 * unhandled rejection while the case reported success.
 */
async function expectAsyncFailure(label, expectedCode, fn) {
  try {
    await fn();
    assert.fail(`${label}: expected ${expectedCode}, but it succeeded`);
  } catch (error) {
    assert.ok(error instanceof MigrationError, `${label}: unexpected ${error}`);
    assert.equal(error.code, expectedCode, `${label}: ${error.message}`);
    assert.equal(/(?:^|\s)\/(?:Users|home|private|tmp|var)\//.test(error.message), false, label);
  }
}

// --- remote observation fixtures (staging slice 1) ---------------------------
//
// Every remote case below runs against an injected transport. None opens a
// network connection, names a credential, or reaches Wrangler — the reader under
// test has no default transport, which is exactly what makes these pure.

/**
 * Canonical-shaped D1 ids that name no real database.
 *
 * Deliberately patterned rather than random-looking: these have to satisfy the
 * RFC-4122 version/variant nibbles the identity check enforces, while reading at
 * a glance as fixtures. A plausible-looking id would be indistinguishable from a
 * leaked resource identifier to both a reviewer and a secret scanner.
 */
const STAGING_DATABASE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_DATABASE_ID = "00000000-0000-4000-8000-000000000002";
const STAGING_DATABASE_NAME = "asimposium-staging";

const remoteCatalogRow = (type, name, sql) => ({ type, name, tbl_name: name, sql });

/**
 * A transport that records every statement, every requested identity, and a call
 * count per method.
 *
 * The recording is the point three times over: the zero-write proof asserts over
 * the exact statements that reached the boundary; the identity proof asserts the
 * resolved id travelled *into* every request; and the call counters let a case
 * prove a refusal happened *before* any injected method ran, which no assertion
 * on the thrown code alone can show.
 */
function recordingTransport(options = {}) {
  const {
    catalog = [],
    journal = [],
    lineage = [],
    describe,
    servedBy,
    onDescribe,
    onQuery,
  } = options;
  const calls = { describe: 0, query: 0 };
  const statements = [];
  const requestedIds = [];
  return {
    calls,
    statements,
    requestedIds,
    describeTarget: async (request) => {
      calls.describe += 1;
      if (onDescribe !== undefined) return onDescribe(request);
      return describe ?? { database_id: STAGING_DATABASE_ID, database_name: STAGING_DATABASE_NAME };
    },
    query: async (request) => {
      calls.query += 1;
      statements.push(request?.sql);
      requestedIds.push(request?.database_id);
      if (onQuery !== undefined) return onQuery(request);
      const sql = String(request?.sql ?? "");
      const rows = sql.includes("FROM sqlite_schema")
        ? catalog
        : sql.includes("_asimposium_migrations")
          ? journal
          : sql.includes("_asimposium_schema_lineage")
            ? lineage
            : undefined;
      if (rows === undefined) throw new Error("unexpected statement reached the transport");
      return { database_id: servedBy ?? STAGING_DATABASE_ID, rows };
    },
  };
}

/**
 * A transport whose methods both count and throw.
 *
 * Used where the reader must refuse *before* touching it: the counter proves no
 * call happened, and the sentinel throw means a regression that did call it would
 * surface as the sentinel rather than as the expected refusal — two independent
 * ways for the same mistake to be caught.
 */
function forbiddenTransport() {
  const calls = { describe: 0, query: 0 };
  return {
    calls,
    describeTarget: async () => {
      calls.describe += 1;
      throw new Error("describeTarget must not be reached");
    },
    query: async () => {
      calls.query += 1;
      throw new Error("query must not be reached");
    },
  };
}

let stagingEnvironmentCache;
function stagingEnvironment() {
  // The real validated topology, not a hand-built stand-in: the reader depends
  // on `kind` and `d1.database_name`, and a fixture would let those drift.
  stagingEnvironmentCache ??= validateEnvironments(repositoryRoot);
  return selectEnvironment(stagingEnvironmentCache, "staging");
}

const CREATE_A = "CREATE TABLE a (id TEXT PRIMARY KEY);\n";
const CREATE_B = "CREATE TABLE b (id TEXT PRIMARY KEY);\n";
const plainOptions = { environmentName: "staging", destructiveAllowed: false };
const record = (migration) => ({
  id: migration.id,
  sequence: migration.sequence,
  digest: migration.digest,
});
const runnerLedgerCatalog = {
  type: "table",
  name: "_asimposium_migrations",
  table: "_asimposium_migrations",
  sql: `CREATE TABLE _asimposium_migrations (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  digest TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`,
};
const runnerLineageCatalog = {
  type: "table",
  name: "_asimposium_schema_lineage",
  table: "_asimposium_schema_lineage",
  sql: `CREATE TABLE _asimposium_schema_lineage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lineage TEXT NOT NULL CHECK (lineage = 'bootstrap-baseline15'),
  artifact_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  schema_digest TEXT NOT NULL CHECK (length(schema_digest) = 64),
  empty_guard INTEGER NOT NULL CHECK (empty_guard = 1),
  installed_at TEXT NOT NULL
)`,
};
const bootstrapLineageRow = (schemaDigest) => ({
  singleton: 1,
  lineage: "bootstrap-baseline15",
  artifact_id: "0015-final-schema-v1",
  artifact_digest: "a".repeat(64),
  schema_digest: schemaDigest,
  empty_guard: 1,
});

const cases = [
  {
    name: "0001-0015 historical baseline has literal immutable golden pins",
    execute() {
      const migrations = readMigrationDirectory(join(repositoryRoot, "db", "migrations"));
      const actual = migrations
        .filter((migration) => migration.sequence <= 15)
        .map((migration) => ({ id: migration.id, sha256: migration.digest }));
      assert.deepEqual(actual, HISTORICAL_0015_GOLDEN_PINS);
      assert.deepEqual(
        readBootstrapManifest(repositoryRoot).historical_migrations,
        HISTORICAL_0015_GOLDEN_PINS,
      );
      const pristineSnapshot = { catalog: [], journal: [], lineage: [] };
      assert.deepEqual(
        localPlanState(pristineSnapshot, migrations, readBootstrapManifest(repositoryRoot)),
        { applied: [] },
        "a pristine plan derives its empty journal from the read-only snapshot",
      );
    },
  },
  {
    name: "catalog-first bootstrap lineage distinguishes empty, historical, baseline, legacy, and contamination",
    execute() {
      const migrations = readMigrationDirectory(join(repositoryRoot, "db/migrations"));
      const productCatalog = [
        {
          type: "table",
          name: "product",
          table: "product",
          sql: "CREATE TABLE product (id TEXT);",
        },
      ];
      const currentDigest = catalogFingerprint(productCatalog);
      const legacyCatalog = [
        { type: "table", name: "legacy", table: "legacy", sql: "CREATE TABLE legacy (id TEXT);" },
      ];
      const manifest = {
        default_artifact_id: "0015-final-schema-v1",
        artifacts: [
          {
            id: "0015-final-schema-v1",
            head_sequence: 15,
            digest: "a".repeat(64),
            schema_digest: currentDigest,
            legacy_0009_schema_digest: catalogFingerprint(legacyCatalog),
          },
        ],
        historical_migrations: HISTORICAL_0015_GOLDEN_PINS,
        schema_heads: [{ sequence: 15, schema_digest: currentDigest }],
      };
      const historical = migrations.slice(0, 15).map(record);
      const legacy = migrations.slice(0, 9).map(record);

      assert.equal(
        classifySchemaLineage({ catalog: [], journal: [], lineage: [], migrations, manifest }).kind,
        "provably-empty",
      );
      const wranglerPlatformMetadata = {
        type: "table",
        name: "_cf_METADATA",
        table: "_cf_METADATA",
        sql: `CREATE TABLE _cf_METADATA (
        key INTEGER PRIMARY KEY,
        value BLOB
      )`,
      };
      assert.equal(
        catalogFingerprint([...productCatalog, wranglerPlatformMetadata]),
        currentDigest,
        "the exact Wrangler D1 metadata table must not rewrite product authority",
      );
      assert.deepEqual(
        classifySchemaLineage({
          catalog: [wranglerPlatformMetadata],
          journal: [],
          lineage: [],
          migrations,
          manifest,
        }),
        { kind: "provably-empty", head: 0 },
        "the exact Wrangler D1 metadata table must not contaminate an otherwise empty target",
      );
      assert.equal(
        classifySchemaLineage({
          catalog: [
            {
              type: "table",
              name: "sqliteX_intruder",
              table: "sqliteX_intruder",
              sql: "CREATE TABLE sqliteX_intruder (id TEXT);",
            },
          ],
          journal: [],
          lineage: [],
          migrations,
          manifest,
        }).kind,
        "unknown-or-contaminated",
        "only an exact lowercase sqlite_ prefix is SQLite control metadata",
      );
      for (const [label, lookalike] of [
        [
          "wrong type",
          {
            ...wranglerPlatformMetadata,
            type: "view",
            sql: "CREATE VIEW _cf_METADATA AS SELECT 1",
          },
        ],
        ["wrong table", { ...wranglerPlatformMetadata, table: "product_metadata" }],
        [
          "wrong SQL",
          {
            ...wranglerPlatformMetadata,
            sql: "CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value BLOB)",
          },
        ],
      ]) {
        assert.equal(
          classifySchemaLineage({
            catalog: [lookalike],
            journal: [],
            lineage: [],
            migrations,
            manifest,
          }).kind,
          "unknown-or-contaminated",
          `Wrangler metadata lookalike with ${label} must remain product evidence`,
        );
      }
      for (const name of ["_asimposium_migrations", "_asimposium_schema_lineage"]) {
        assert.equal(
          classifySchemaLineage({
            catalog: [
              {
                type: "table",
                name,
                table: name,
                sql: `CREATE TABLE ${name} (id TEXT);`,
              },
            ],
            journal: [],
            lineage: [],
            migrations,
            manifest,
          }).kind,
          "unknown-or-contaminated",
          `a lone ${name} table must not make a target bootstrap-empty`,
        );
      }
      assert.equal(
        classifySchemaLineage({
          catalog: [
            {
              type: "table",
              name: "_asimposium_unowned_control_like_object",
              table: "_asimposium_unowned_control_like_object",
              sql: "CREATE TABLE _asimposium_unowned_control_like_object (id TEXT);",
            },
          ],
          journal: [],
          lineage: [],
          migrations,
          manifest,
        }).kind,
        "unknown-or-contaminated",
      );
      assert.equal(
        classifySchemaLineage({
          catalog: [...productCatalog, runnerLedgerCatalog],
          journal: historical,
          lineage: [],
          migrations,
          manifest,
        }).kind,
        "historical-current-0015",
      );
      assert.equal(
        classifySchemaLineage({
          catalog: [...productCatalog, runnerLedgerCatalog, runnerLineageCatalog],
          journal: [],
          lineage: [bootstrapLineageRow(currentDigest)],
          migrations,
          manifest,
        }).kind,
        "bootstrap-baseline15",
      );
      for (const [label, catalog] of [
        [
          "wrong control DDL",
          [
            ...productCatalog,
            { ...runnerLedgerCatalog, sql: "CREATE TABLE _asimposium_migrations (id TEXT);" },
            runnerLineageCatalog,
          ],
        ],
        [
          "wrong control object type",
          [
            ...productCatalog,
            {
              ...runnerLedgerCatalog,
              type: "view",
              sql: "CREATE VIEW _asimposium_migrations AS SELECT 1",
            },
            runnerLineageCatalog,
          ],
        ],
        [
          "same-name trigger",
          [
            ...productCatalog,
            runnerLedgerCatalog,
            runnerLineageCatalog,
            {
              type: "trigger",
              name: "_asimposium_schema_lineage",
              table: "_asimposium_migrations",
              sql: "CREATE TRIGGER _asimposium_schema_lineage AFTER INSERT ON _asimposium_migrations BEGIN SELECT 1; END",
            },
          ],
        ],
      ]) {
        assert.equal(
          classifySchemaLineage({
            catalog,
            journal: [],
            lineage: [bootstrapLineageRow(currentDigest)],
            migrations,
            manifest,
          }).kind,
          "unknown-or-contaminated",
          `${label} must be catalog evidence, never bootstrap metadata`,
        );
      }
      for (const [label, lineage] of [
        [
          "extra control row",
          [bootstrapLineageRow(currentDigest), bootstrapLineageRow(currentDigest)],
        ],
        ["wrong singleton", [{ ...bootstrapLineageRow(currentDigest), singleton: 2 }]],
        ["wrong empty guard", [{ ...bootstrapLineageRow(currentDigest), empty_guard: 0 }]],
      ]) {
        assert.equal(
          classifySchemaLineage({
            catalog: [...productCatalog, runnerLedgerCatalog, runnerLineageCatalog],
            journal: [],
            lineage,
            migrations,
            manifest,
          }).kind,
          "unknown-or-contaminated",
          `${label} must not establish bootstrap lineage`,
        );
      }
      const driftedHistoryManifest = {
        ...manifest,
        historical_migrations: manifest.historical_migrations.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "c".repeat(64) } : entry,
        ),
      };
      expectFailure("historical manifest pin", "BOOTSTRAP_HISTORICAL_MIGRATION_DRIFT", () =>
        classifySchemaLineage({
          catalog: [],
          journal: [],
          lineage: [],
          migrations,
          manifest: driftedHistoryManifest,
        }),
      );
      assert.equal(
        classifySchemaLineage({
          catalog: [...legacyCatalog, runnerLedgerCatalog],
          journal: legacy,
          lineage: [],
          migrations,
          manifest,
        }).kind,
        "legacy-0009",
      );
      assert.equal(
        classifySchemaLineage({
          catalog: [
            ...productCatalog,
            {
              type: "table",
              name: "contamination",
              table: "contamination",
              sql: "CREATE TABLE contamination (id TEXT);",
            },
          ],
          journal: [],
          lineage: [],
          migrations,
          manifest,
        }).kind,
        "unknown-or-contaminated",
      );

      // The real local-D1 lane executes and fingerprints current 0016. This
      // static lane only establishes that planning consumes the same W3-owned
      // file and the production-loaded head-16 registration, not an invented
      // migration or a duplicate in-memory schema head.
      const productionMigrations = readMigrationDirectory(join(repositoryRoot, "db/migrations"));
      const actual0016 = productionMigrations.find((migration) => migration.sequence === 16);
      assert.ok(actual0016, "current migration 0016 must exist");
      assert.equal(actual0016.id, "0016_operator_fellow_cap_override.sql");
      const productionManifest = readBootstrapManifest(repositoryRoot);
      const schemaHead16 = productionManifest.schema_heads.filter((head) => head.sequence === 16);
      assert.equal(
        schemaHead16.length,
        1,
        "the production manifest must register exactly one head 16",
      );
      const migrationsThrough0016 = productionMigrations.filter(
        (migration) => migration.sequence <= actual0016.sequence,
      );
      assert.equal(migrationsThrough0016.length, 16);
      const actualHistorical = migrationsThrough0016.slice(0, 15).map(record);
      const forwardOptions = { environmentName: "local", destructiveAllowed: true };
      assert.deepEqual(
        planMigrations(migrationsThrough0016, actualHistorical, forwardOptions).to_apply.map(
          (migration) => migration.id,
        ),
        [actual0016.id],
      );
      assert.deepEqual(
        planMigrations(migrationsThrough0016, [], {
          ...forwardOptions,
          baseline: { head: 15 },
        }).to_apply.map((migration) => migration.id),
        [actual0016.id],
      );

      assert.equal(bootstrapTargetDisposition({ kind: "provably-empty" }), "ready");
      assert.equal(
        bootstrapTargetDisposition({ kind: "bootstrap-baseline15", head: 15 }),
        "idempotent",
      );
      expectFailure("legacy 0009 bridge refusal", "LEGACY_0009_BRIDGE_BLOCKED", () =>
        bootstrapTargetDisposition({ kind: "legacy-0009", head: 9 }),
      );
      expectFailure(
        "historical current bootstrap refusal",
        "BOOTSTRAP_HISTORICAL_LINEAGE_REFUSED",
        () => bootstrapTargetDisposition({ kind: "historical-current-0015", head: 15 }),
      );
      expectFailure(
        "historical forward bootstrap refusal",
        "BOOTSTRAP_HISTORICAL_LINEAGE_REFUSED",
        () => bootstrapTargetDisposition({ kind: "historical-forward", head: 16 }),
      );
      expectFailure("contaminated bootstrap refusal", "BOOTSTRAP_TARGET_REFUSED", () =>
        bootstrapTargetDisposition({ kind: "unknown-or-contaminated", head: 0 }),
      );

      // The fingerprint is over sqlite_schema.sql bytes. Collapsing whitespace
      // would turn these distinct string literals into the same authority.
      assert.notEqual(
        catalogFingerprint([
          {
            type: "table",
            name: "literal",
            table: "literal",
            sql: "CREATE TABLE literal (v TEXT DEFAULT 'a b');",
          },
        ]),
        catalogFingerprint([
          {
            type: "table",
            name: "literal",
            table: "literal",
            sql: "CREATE TABLE literal (v TEXT DEFAULT 'a  b');",
          },
        ]),
      );
      const binaryOrderedCatalog = [
        {
          type: "table",
          name: "zeta",
          table: "zeta",
          sql: "CREATE TABLE zeta (id TEXT);",
        },
        {
          type: "table",
          name: "éclair",
          table: "éclair",
          sql: "CREATE TABLE éclair (id TEXT);",
        },
      ];
      assert.equal(
        catalogFingerprint(binaryOrderedCatalog),
        catalogFingerprint([...binaryOrderedCatalog].reverse()),
        "catalog fingerprints must use byte-stable ordering, independent of sqlite_schema row order",
      );

      expectFailure("catalog overrun", "LOCAL_D1_CATALOG_OVERRUN", () =>
        assertReadLimit(new Array(513).fill({}), 512, "LOCAL_D1_CATALOG_OVERRUN"),
      );
      expectFailure("journal overrun", "LOCAL_D1_JOURNAL_OVERRUN", () =>
        assertReadLimit(new Array(257).fill({}), 256, "LOCAL_D1_JOURNAL_OVERRUN"),
      );
      expectFailure("lineage overrun", "LOCAL_D1_LINEAGE_OVERRUN", () =>
        assertReadLimit(new Array(9).fill({}), 8, "LOCAL_D1_LINEAGE_OVERRUN"),
      );

      const exactManifest = readBootstrapManifest(repositoryRoot);
      assert.equal(exactManifest.artifacts.length, 1);
      assert.equal(/\bIF\s+NOT\s+EXISTS\b/i.test(exactManifest.artifacts[0].sql), false);
    },
  },
  {
    name: "bootstrap artifact loader refuses collision masking and digest drift before any apply",
    execute() {
      const collisionMasking = "CREATE TABLE IF NOT EXISTS collision_masking (id TEXT);\n";
      expectFailure("collision-masking artifact", "BOOTSTRAP_ARTIFACT_COLLISION_MASKING", () =>
        readBootstrapManifest(bootstrapFixtureRoot("bootstrap-if-not-exists", collisionMasking)),
      );
      const digestDrift = "CREATE TABLE digest_drift (id TEXT);\n";
      expectFailure("artifact digest drift", "BOOTSTRAP_ARTIFACT_DRIFT", () =>
        readBootstrapManifest(
          bootstrapFixtureRoot("bootstrap-digest-drift", digestDrift, "c".repeat(64)),
        ),
      );
    },
  },
  {
    name: "remote bootstrap refusal never invokes the injected D1 observation",
    async execute() {
      for (const environment of ["staging", "production"]) {
        let d1Observations = 0;
        let injectedFailure;
        try {
          await readBootstrapSnapshotOrRefuse({ kind: "remote", name: environment }, async () => {
            d1Observations += 1;
            throw new Error("remote D1 observation sentinel was reached");
          });
        } catch (error) {
          injectedFailure = error;
        }
        assert.ok(injectedFailure instanceof MigrationError);
        assert.equal(injectedFailure.code, "BOOTSTRAP_REMOTE_UNAVAILABLE");
        assert.equal(d1Observations, 0, `${environment} refusal must precede every D1 observation`);

        // The real CLI is still exercised for its JSON refusal contract. The
        // injected counter above is the causal no-D1 proof; output text alone
        // would not establish that a provider invocation never occurred.
        const run = runCli(["--env", environment, "--bootstrap", "0015-final-schema-v1"]);
        assert.equal(run.exitCode, 1, `${environment} bootstrap must refuse`);
        const refusal = refusalOf(run);
        assert.equal(refusal.code, "BOOTSTRAP_REMOTE_UNAVAILABLE");
        assert.equal(refusal.phase, "plan");
      }
    },
  },
  {
    name: "ordinary remote apply never invokes the injected local-D1 migration observer",
    async execute() {
      const pending = [{ id: "0001_observer.sql", sequence: 1, digest: "a".repeat(64) }];
      for (const environment of ["staging", "production"]) {
        let localD1Observations = 0;
        let injectedFailure;
        try {
          await applyPendingLocalMigrationsOrRefuse(
            { kind: "remote", name: environment },
            pending,
            async () => {
              localD1Observations += 1;
              throw new Error("remote ordinary apply reached local D1 observer");
            },
          );
        } catch (error) {
          injectedFailure = error;
        }
        assert.ok(injectedFailure instanceof MigrationError);
        assert.equal(injectedFailure.code, "APPLY_UNAVAILABLE");
        assert.equal(
          localD1Observations,
          0,
          `${environment} ordinary apply refusal must precede every local-D1 observation`,
        );
      }
    },
  },
  {
    name: "bounded local command strips parent authority and refuses unsafe containment outcomes",
    async execute() {
      const plantedAuthority = {
        CLOUDFLARE_API_TOKEN: "cf-local-executor-test-authority",
        WRANGLER_API_TOKEN: "wrangler-local-executor-test-authority",
        S2_RUN_TOKEN: "s2-local-executor-test-authority",
      };
      const priorAuthority = Object.fromEntries(
        Object.keys(plantedAuthority).map((name) => [name, process.env[name]]),
      );
      const expectedChildEnvironment =
        process.platform === "win32"
          ? {
              LANG: "C",
              PATH: "C:\\Windows\\System32",
              SystemRoot: "C:\\Windows",
              TZ: "UTC",
            }
          : {
              LANG: "C",
              LC_ALL: "C",
              PATH: "/usr/local/bin:/usr/bin:/bin",
              TZ: "UTC",
            };
      const observedChildEnvironments = [];
      Object.assign(process.env, plantedAuthority);
      const outputSignals = [];
      try {
        const output = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          stdoutMaxBytes: 3,
          spawn(options) {
            assert.equal(options.detached, true);
            assert.equal(options.stdin, "ignore");
            assert.equal(options.stdout, "pipe");
            assert.equal(options.stderr, "pipe");
            assert.deepEqual(options.env, expectedChildEnvironment);
            observedChildEnvironments.push(options.env);
            return {
              pid: 41,
              exited: new Promise(() => {}),
              stderr: closedPipe(),
              stdout: closedPipe([new Uint8Array([1, 2, 3, 4])]),
            };
          },
          signalGroup(_child, signal) {
            outputSignals.push(signal);
          },
          groupExists() {
            return false;
          },
        });
        assert.equal(output.outcome, "output-overrun");
        assert.deepEqual(outputSignals, ["SIGTERM"]);
        assert.equal(output.stdout, "");

        const pipeSignals = [];
        const pipe = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          spawn() {
            return {
              pid: 42,
              exited: Promise.resolve(0),
              stderr: closedPipe(),
              stdout: unprovenPipe(),
            };
          },
          signalGroup(_child, signal) {
            pipeSignals.push(signal);
          },
          groupExists() {
            return pipeSignals.length < 2;
          },
        });
        assert.equal(pipe.outcome, "pipe-drain-unproven");
        assert.deepEqual(pipeSignals, ["SIGTERM", "SIGKILL"]);

        const lockedPipeSignals = [];
        const lockedPipe = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          spawn() {
            return {
              pid: 43,
              exited: new Promise(() => {}),
              stderr: closedPipe(),
              stdout: {
                getReader() {
                  throw new Error("fixture locked stream");
                },
              },
            };
          },
          signalGroup(_child, signal) {
            lockedPipeSignals.push(signal);
          },
          groupExists() {
            return false;
          },
        });
        assert.equal(lockedPipe.outcome, "pipe-drain-unproven");
        assert.deepEqual(lockedPipeSignals, ["SIGTERM"]);

        const timeoutSignals = [];
        const timeout = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          spawn() {
            return {
              pid: 44,
              exited: new Promise(() => {}),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
          },
          signalGroup(_child, signal) {
            timeoutSignals.push(signal);
          },
          groupExists() {
            return timeoutSignals.length < 2;
          },
        });
        assert.equal(timeout.outcome, "timeout");
        assert.deepEqual(timeoutSignals, ["SIGTERM", "SIGKILL"]);

        const unreapedSignals = [];
        const unreaped = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          spawn() {
            return {
              pid: 45,
              exited: Promise.resolve(0),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
          },
          signalGroup(_child, signal) {
            unreapedSignals.push(signal);
          },
          groupExists() {
            return true;
          },
        });
        assert.equal(unreaped.outcome, "process-reap-unproven");
        assert.deepEqual(unreapedSignals, ["SIGTERM", "SIGKILL"]);

        const processGroupSignals = [];
        const processGroupMember = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          spawn() {
            return {
              pid: 46,
              exited: Promise.resolve(0),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
          },
          signalGroup(_child, signal) {
            processGroupSignals.push(signal);
          },
          groupExists() {
            return processGroupSignals.length === 0;
          },
        });
        // The signal is for an observed member of the owned process group.
        // A process that escaped with setsid() is intentionally outside this
        // proof boundary; pipe closure cannot make a claim about it.
        assert.equal(processGroupMember.containment_scope, "process-group-only");
        assert.equal(processGroupMember.outcome, "process-group-survivor-observed");
        assert.deepEqual(processGroupSignals, ["SIGTERM"]);

        let resolveWindowsChild;
        const windowsSignals = [];
        const windowsDirectChild = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          platform: "win32",
          spawn() {
            return {
              pid: 47,
              exited: new Promise((resolve) => {
                resolveWindowsChild = resolve;
              }),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
          },
          signalGroup(_child, signal) {
            windowsSignals.push(signal);
            if (signal === "SIGKILL") resolveWindowsChild(137);
          },
          groupExists() {
            assert.fail("Windows containment must not claim or inspect a POSIX process group");
          },
        });
        assert.equal(windowsDirectChild.containment_scope, "direct-child-only");
        assert.equal(windowsDirectChild.outcome, "timeout");
        assert.equal(windowsDirectChild.exitCode, 137);
        assert.deepEqual(windowsSignals, ["SIGTERM", "SIGKILL"]);

        const windowsUnreapedSignals = [];
        const windowsUnreaped = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          pipeDrainMs: 1,
          platform: "win32",
          spawn() {
            return {
              pid: 48,
              exited: new Promise(() => {}),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
          },
          signalGroup(_child, signal) {
            windowsUnreapedSignals.push(signal);
          },
          groupExists() {
            assert.fail("Windows containment must not claim or inspect a POSIX process group");
          },
        });
        assert.equal(windowsUnreaped.containment_scope, "direct-child-only");
        assert.equal(windowsUnreaped.outcome, "direct-child-reap-unproven");
        assert.deepEqual(windowsUnreapedSignals, ["SIGTERM", "SIGKILL"]);

        assert.equal(observedChildEnvironments.length, 1);
        for (const environment of observedChildEnvironments) {
          for (const [name, value] of Object.entries(plantedAuthority)) {
            assert.equal(name in environment, false, `${name} must not reach a local child`);
            assert.equal(
              Object.values(environment).includes(value),
              false,
              `${name} value must not reach a local child`,
            );
          }
        }
      } finally {
        for (const [name, prior] of Object.entries(priorAuthority)) {
          if (prior === undefined) delete process.env[name];
          else process.env[name] = prior;
        }
      }
    },
  },
  {
    name: "a bounded failure releases both pipe readers instead of stranding them",
    async execute() {
      // Both pipes park, so no drain can be proven and the run must report a
      // bounded failure. The question this case exists for is what happens to
      // the readers afterwards: reporting `pipe-drain-unproven` while a reader
      // stays parked on the OS pipe leaves a detached holder alive for the rest
      // of the process, which is a leak the outcome string does not mention.
      const stdout = parkedPipe();
      const stderr = parkedPipe();
      const signals = [];
      const stuck = await runBoundedCommand({
        cmd: ["fixture"],
        cwd: repositoryRoot,
        timeoutMs: 10,
        termGraceMs: 1,
        killReapMs: 1,
        pipeDrainMs: 1,
        spawn() {
          return {
            pid: 44,
            exited: Promise.resolve(0),
            stderr: stderr.stream,
            stdout: stdout.stream,
          };
        },
        signalGroup(_child, signal) {
          signals.push(signal);
        },
        groupExists() {
          return false;
        },
      });

      // The bounded report is unchanged; this case adds to it rather than
      // relaxing it, and the deadlines above are the same ones the sibling
      // cases use.
      assert.equal(stuck.outcome, "pipe-drain-unproven");
      assert.equal(stuck.containment_scope, "process-group-only");
      assert.deepEqual(signals, ["SIGTERM"]);

      // Causal: without a cancel seam these are 0, because abandoning `done`
      // closes nothing.
      assert.equal(stdout.cancelCount, 1, "stdout reader was never cancelled");
      assert.equal(stderr.cancelCount, 1, "stderr reader was never cancelled");

      // The detached-holder proof itself. A reader that still owns the stream
      // leaves it locked; both must be released by the time the caller is told
      // the run is over.
      assert.equal(stdout.stream.locked, false, "stdout stream is still locked");
      assert.equal(stderr.stream.locked, false, "stderr stream is still locked");

      // The overrun path reaches the same bounded cancellation before process
      // teardown. It starts with a real over-limit chunk, then parks the next
      // read, so a missing cancellation would leave `cancelCount` at zero even
      // though the outcome string remained output-overrun.
      const overflow = overflowThenParkedPipe();
      const overflowStderr = neverClosingPipe();
      const overflowSignals = [];
      const outputOverrun = await runBoundedCommand({
        cmd: ["fixture"],
        cwd: repositoryRoot,
        timeoutMs: 10,
        termGraceMs: 1,
        killReapMs: 1,
        pipeDrainMs: 1,
        stdoutMaxBytes: 3,
        spawn() {
          return {
            pid: 47,
            exited: new Promise(() => {}),
            stderr: overflowStderr,
            stdout: overflow.stream,
          };
        },
        signalGroup(_child, signal) {
          overflowSignals.push(signal);
        },
        groupExists() {
          return false;
        },
      });
      assert.equal(outputOverrun.outcome, "output-overrun");
      assert.deepEqual(overflowSignals, ["SIGTERM"]);
      assert.equal(overflow.cancelCount, 1, "overrun reader was never cancelled");
      assert.equal(overflow.stream.locked, false, "overrun stream is still locked");
      assert.equal(overflowStderr.locked, false, "overrun stderr stream is still locked");

      // A reaping refusal starts the same cleanup before it reports failure.
      // This is separate from the process-group signal proof above: the group
      // never disappears here, while the pipe itself can be released.
      const reapPipe = parkedPipe();
      const reapSignals = [];
      const unreapedReader = await runBoundedCommand({
        cmd: ["fixture"],
        cwd: repositoryRoot,
        timeoutMs: 10,
        termGraceMs: 1,
        killReapMs: 1,
        pipeDrainMs: 1,
        spawn() {
          return {
            pid: 48,
            exited: Promise.resolve(0),
            stderr: closedPipe(),
            stdout: reapPipe.stream,
          };
        },
        signalGroup(_child, signal) {
          reapSignals.push(signal);
        },
        groupExists() {
          return true;
        },
      });
      assert.equal(unreapedReader.outcome, "process-reap-unproven");
      assert.deepEqual(reapSignals, ["SIGTERM", "SIGKILL"]);
      assert.equal(reapPipe.cancelCount, 1, "unreaped reader was never cancelled");
      assert.equal(reapPipe.stream.locked, false, "unreaped stream is still locked");

      // Idempotent: the successful path releases too, and a stream whose
      // `getReader()` threw has nothing to release but must not throw on the
      // way out either.
      const clean = await runBoundedCommand({
        cmd: ["fixture"],
        cwd: repositoryRoot,
        timeoutMs: 10,
        termGraceMs: 1,
        killReapMs: 1,
        pipeDrainMs: 10,
        spawn() {
          return {
            pid: 45,
            exited: Promise.resolve(0),
            stderr: closedPipe(),
            stdout: {
              getReader() {
                throw new Error("fixture locked stream");
              },
            },
          };
        },
        signalGroup(_child, signal) {
          signals.push(signal);
        },
        groupExists() {
          return false;
        },
      });
      assert.equal(clean.outcome, "pipe-drain-unproven");
    },
  },
  {
    name: "the pinned Wrangler command ignores PATH and executes the exact workspace entry",
    requiresWrangler: true,
    execute() {
      const declaredVersion = exactDeclaredWranglerVersion();
      const command = resolvePinnedWranglerCommand(repositoryRoot);
      assert.deepEqual(command, [process.execPath, INSTALLED_WRANGLER_ENTRY]);

      // `process.execPath` and the entry are both absolute. This PATH excludes
      // the ambient Bun-global Wrangler, so the version result cannot come from
      // the shell command that previously made the local migration lane drift.
      const result = Bun.spawnSync({
        cmd: [...command, "--version"],
        cwd: repositoryRoot,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(result.stdout.toString().trim(), declaredVersion);
    },
  },
  {
    name: "a-missing-pinned-Wrangler-refuses-before-any-fallback-can-run",
    execute() {
      let thrown;
      try {
        resolvePinnedWranglerCommand(
          repositoryRoot,
          pinnedWranglerFileSystem({
            existsSync(path) {
              return path === INSTALLED_WRANGLER_ENTRY ? false : existsSync(path);
            },
          }),
        );
        assert.fail("a missing installed Wrangler must refuse");
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof MigrationError, `unexpected error: ${thrown}`);
      assert.equal(thrown.code, "PINNED_WRANGLER_UNAVAILABLE");
      assert.equal(
        thrown.message,
        "The repository-pinned Wrangler is not installed. Run bun install --frozen-lockfile.",
      );
      assert.equal(thrown.message.includes("bunx"), false);
      assert.equal(/(?:^|\s)\/(?:Users|home|private|tmp|var)\//.test(thrown.message), false);
    },
  },
  {
    name: "a-stale-pinned-Wrangler-version-refuses-without-echoing-either-version",
    execute() {
      let thrown;
      try {
        resolvePinnedWranglerCommand(
          repositoryRoot,
          pinnedWranglerFileSystem({
            readFileSync(path, options) {
              if (path === INSTALLED_WRANGLER_MANIFEST) return '{"version":"4.120.0"}';
              return readFileSync(path, options);
            },
          }),
        );
        assert.fail("a stale installed Wrangler must refuse");
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof MigrationError, `unexpected error: ${thrown}`);
      assert.equal(thrown.code, "PINNED_WRANGLER_VERSION_MISMATCH");
      assert.equal(
        thrown.message,
        "The installed repository-pinned Wrangler does not match apps/wire/package.json. Run bun install --frozen-lockfile.",
      );
      assert.equal(thrown.message.includes("4.120.0"), false);
      assert.equal(thrown.message.includes(exactDeclaredWranglerVersion()), false);
    },
  },
  {
    name: "reads-and-orders-a-well-formed-directory",
    execute() {
      const migrations = readMigrationDirectory(
        directory("ok", {
          "0002_second.sql": CREATE_B,
          "0001_first.sql": CREATE_A,
          "README.md": "docs\n",
        }),
      );
      assert.deepEqual(
        migrations.map((m) => m.id),
        ["0001_first.sql", "0002_second.sql"],
      );
      assert.equal(migrations[0].digest, digestOf(CREATE_A));
      assert.equal(migrations[0].digest.length, 64);
    },
  },
  {
    name: "an-empty-directory-plans-nothing-and-is-idempotent",
    execute() {
      // The repository is in exactly this state today: the boundary README and
      // no SQL. It must be a clean no-op, not an error.
      const migrations = readMigrationDirectory(
        directory("only-readme", { "README.md": "docs\n" }),
      );
      assert.deepEqual(migrations, []);
      const plan = planMigrations(migrations, [], plainOptions);
      assert.deepEqual(plan.to_apply, []);
      assert.equal(plan.idempotent, true);
    },
  },
  {
    name: "applying-twice-is-a-no-op",
    execute() {
      const migrations = readMigrationDirectory(
        directory("twice", { "0001_first.sql": CREATE_A, "0002_second.sql": CREATE_B }),
      );
      const first = planMigrations(migrations, [], plainOptions);
      assert.deepEqual(
        first.to_apply.map((m) => m.id),
        ["0001_first.sql", "0002_second.sql"],
      );
      assert.equal(first.idempotent, false);

      // Second plan, given the records the first run would have written.
      const second = planMigrations(migrations, migrations.map(record), plainOptions);
      assert.deepEqual(second.to_apply, []);
      assert.equal(second.idempotent, true);
      assert.deepEqual(
        second.skipped.map((s) => s.reason),
        ["already_applied", "already_applied"],
      );

      // And a third is still a no-op: idempotency is stable, not a one-shot.
      assert.deepEqual(
        planMigrations(migrations, migrations.map(record), plainOptions).to_apply,
        [],
      );
    },
  },
  {
    name: "a-partially-applied-directory-applies-only-the-remainder",
    execute() {
      const migrations = readMigrationDirectory(
        directory("partial", { "0001_first.sql": CREATE_A, "0002_second.sql": CREATE_B }),
      );
      const plan = planMigrations(migrations, [record(migrations[0])], plainOptions);
      assert.deepEqual(
        plan.to_apply.map((m) => m.id),
        ["0002_second.sql"],
      );
      assert.equal(plan.head, 1);
    },
  },

  // --- ordering -------------------------------------------------------------
  {
    name: "out-of-order-migration-is-refused",
    execute() {
      const migrations = readMigrationDirectory(
        directory("ooo", {
          "0001_first.sql": CREATE_A,
          "0003_third.sql": CREATE_B,
          "0002_late.sql": "CREATE TABLE c (id TEXT);\n",
        }),
      );
      // 0001 and 0003 applied; 0002 then appears unapplied beneath the head.
      const applied = [record(migrations[0]), record(migrations[2])];
      expectFailure("out-of-order", "OUT_OF_ORDER_MIGRATION", () =>
        planMigrations(migrations, applied, plainOptions),
      );
    },
  },
  {
    name: "duplicate-sequence-number-is-refused",
    execute() {
      expectFailure("dup-seq", "DUPLICATE_MIGRATION_SEQUENCE", () =>
        readMigrationDirectory(
          directory("dup", { "0001_first.sql": CREATE_A, "0001_other.sql": CREATE_B }),
        ),
      );
    },
  },
  {
    name: "malformed-migration-name-is-refused",
    execute() {
      for (const [label, filename] of [
        ["no-number", "first.sql"],
        ["short-number", "001_first.sql"],
        ["uppercase", "0001_First.sql"],
        ["spaces", "0001 first.sql"],
        ["trailing-underscore", "0001_first_.sql"],
      ]) {
        expectFailure(label, "MALFORMED_MIGRATION_NAME", () =>
          readMigrationDirectory(directory(`name-${label}`, { [filename]: CREATE_A })),
        );
      }
    },
  },
  {
    name: "non-sql-file-is-refused",
    execute() {
      expectFailure("stray", "UNEXPECTED_MIGRATION_FILE", () =>
        readMigrationDirectory(
          directory("stray", { "0001_first.sql": CREATE_A, "notes.txt": "x" }),
        ),
      );
    },
  },
  {
    name: "empty-migration-is-refused",
    execute() {
      expectFailure("empty", "EMPTY_MIGRATION", () =>
        readMigrationDirectory(directory("empty", { "0001_first.sql": "  \n" })),
      );
    },
  },
  {
    name: "missing-directory-is-refused",
    execute() {
      expectFailure("missing-dir", "MISSING_MIGRATIONS_DIRECTORY", () =>
        readMigrationDirectory(join(space, "does-not-exist")),
      );
    },
  },

  // --- rollback-forward policy ---------------------------------------------
  {
    name: "down-migrations-are-refused-by-name",
    execute() {
      for (const filename of [
        "0002_second.down.sql",
        "0002_second.rollback.sql",
        "0002_second.undo.sql",
        "0002_down_second.sql",
      ]) {
        expectFailure(filename, "DOWN_MIGRATION_REJECTED", () =>
          readMigrationDirectory(
            directory(`down-${filename}`, {
              "0001_first.sql": CREATE_A,
              [filename]: "DROP TABLE a;\n",
            }),
          ),
        );
      }
    },
  },

  // --- checksums and drift --------------------------------------------------
  {
    name: "editing-an-applied-migration-is-drift",
    execute() {
      const migrations = readMigrationDirectory(directory("drift", { "0001_first.sql": CREATE_A }));
      const applied = [
        {
          id: "0001_first.sql",
          sequence: 1,
          digest: digestOf("CREATE TABLE something_else (id TEXT);\n"),
        },
      ];
      expectFailure("drift", "MIGRATION_DRIFT", () =>
        planMigrations(migrations, applied, plainOptions),
      );
    },
  },
  {
    name: "deleting-an-applied-migration-is-a-rewritten-history",
    execute() {
      const migrations = readMigrationDirectory(
        directory("vanished", { "0002_second.sql": CREATE_B }),
      );
      const applied = [{ id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) }];
      expectFailure("vanished", "APPLIED_MIGRATION_MISSING", () =>
        planMigrations(migrations, applied, plainOptions),
      );
    },
  },
  {
    name: "digest-is-content-addressed-not-name-addressed",
    execute() {
      const a = readMigrationDirectory(directory("dig-a", { "0001_first.sql": CREATE_A }))[0];
      const b = readMigrationDirectory(directory("dig-b", { "0001_renamed.sql": CREATE_A }))[0];
      assert.equal(a.digest, b.digest);
      assert.notEqual(a.digest, digestOf(CREATE_B));
    },
  },

  // --- destructive-target guards -------------------------------------------
  {
    name: "destructive-guard-resists-obfuscation",
    execute() {
      // Each of these was a live bypass of the previous whole-file regexes.
      const bypasses = {
        "cross-statement WHERE vouching for an unscoped UPDATE":
          "UPDATE claims SET disposition = 1;\nSELECT * FROM problems WHERE id = 1;",
        "cross-statement WHERE vouching for an unscoped DELETE":
          "DELETE FROM events;\nSELECT 1 FROM problems WHERE id = 1;",
        "comment inside the keyword pair": "DROP/**/TABLE claims;",
        "comment between the keywords": "DROP /* hi */ TABLE claims;",
        "comment splitting DELETE FROM": "DELETE/**/FROM events;",
        "DROP INDEX": "DROP INDEX idx_claims;",
        "DROP VIEW": "DROP VIEW v_claims;",
        "DROP TRIGGER": "DROP TRIGGER t_claims;",
        "ALTER TABLE RENAME TO": "ALTER TABLE claims RENAME TO claims_old;",
        "ALTER TABLE RENAME COLUMN": "ALTER TABLE claims RENAME COLUMN a TO b;",
        "REPLACE INTO": "REPLACE INTO claims (id) VALUES (1);",
        "INSERT OR REPLACE": "INSERT OR REPLACE INTO claims (id) VALUES (1);",
        "PRAGMA writable_schema": "PRAGMA writable_schema = ON;",
        VACUUM: "VACUUM;",
        "ATTACH DATABASE": "ATTACH DATABASE 'other.db' AS other;",
      };
      for (const [label, sql] of Object.entries(bypasses)) {
        assert.ok(
          describeDestructiveStatements(sql).length > 0,
          `undetected destructive form: ${label}`,
        );
      }
    },
  },
  {
    name: "destructive-guard-does-not-fire-on-comments-or-strings",
    execute() {
      // A keyword a reviewer can see is inert must stay inert, or the guard
      // becomes noise and gets routed around.
      assert.deepEqual(
        describeDestructiveStatements("-- DROP TABLE claims\nCREATE TABLE ok (id TEXT);"),
        [],
      );
      assert.deepEqual(
        describeDestructiveStatements("/* DROP TABLE claims */\nCREATE TABLE ok (id TEXT);"),
        [],
      );
      assert.deepEqual(
        describeDestructiveStatements("INSERT INTO notes (body) VALUES ('DROP TABLE claims');"),
        [],
      );
    },
  },
  {
    name: "unterminated SQL comments and quotes are refused before planning or journal construction",
    execute() {
      for (const [label, sql, code] of [
        [
          "open block comment",
          "CREATE TABLE leaked_comment (id TEXT); /*",
          "UNTERMINATED_SQL_COMMENT",
        ],
        [
          "open string quote",
          "CREATE TABLE leaked_quote (note TEXT DEFAULT 'unterminated);",
          "UNTERMINATED_SQL_QUOTE",
        ],
        [
          "open identifier quote",
          "CREATE TABLE `leaked_identifier (id TEXT);",
          "UNTERMINATED_SQL_QUOTE",
        ],
        [
          "open double-quoted identifier",
          'CREATE TABLE "leaked_identifier (id TEXT);',
          "UNTERMINATED_SQL_QUOTE",
        ],
        [
          "open bracket identifier",
          "CREATE TABLE [leaked_identifier (id TEXT);",
          "UNTERMINATED_SQL_QUOTE",
        ],
      ]) {
        expectFailure(label, code, () =>
          readMigrationDirectory(directory(`unterminated-${label}`, { "0001_invalid.sql": sql })),
        );
        expectFailure(`${label} execution seam`, code, () =>
          migrationCommandSql(
            { id: "0001_invalid.sql", sequence: 1, digest: digestOf(sql), sql },
            "2026-08-17T00:00:00.000Z",
          ),
        );
      }
    },
  },
  {
    name: "the-opt-in-marker-must-be-a-real-comment",
    execute() {
      assert.equal(declaresDestructive("-- asimposium:allow-destructive\nDROP TABLE a;"), true);
      assert.equal(declaresDestructive("/* asimposium:allow-destructive */\nDROP TABLE a;"), true);
      // Smuggled through a string literal: the marker is data, not a decision.
      assert.equal(
        declaresDestructive(
          "INSERT INTO t VALUES ('\n-- asimposium:allow-destructive\n');\nDROP TABLE a;",
        ),
        false,
      );
      assert.equal(declaresDestructive("DROP TABLE a;"), false);
    },
  },
  {
    name: "obfuscated-destruction-is-refused-end-to-end",
    execute() {
      // The whole point: an obfuscated DROP with no marker must be refused by
      // the planner, on every environment, not merely "detected".
      const sneaky = "DROP/**/TABLE claims;\n";
      const migrations = readMigrationDirectory(directory("sneaky", { "0001_sneaky.sql": sneaky }));
      expectFailure("sneaky-permissive", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], { environmentName: "local", destructiveAllowed: true }),
      );
      expectFailure("sneaky-strict", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], plainOptions),
      );
    },
  },
  {
    name: "destructive-statements-are-detected",
    execute() {
      assert.deepEqual(describeDestructiveStatements("DROP TABLE claims;"), ["DROP TABLE"]);
      assert.deepEqual(describeDestructiveStatements("drop table claims;"), ["DROP TABLE"]);
      assert.deepEqual(describeDestructiveStatements("DELETE FROM events;"), [
        "DELETE without WHERE",
      ]);
      assert.deepEqual(describeDestructiveStatements("TRUNCATE events;"), ["TRUNCATE"]);
      assert.deepEqual(describeDestructiveStatements("ALTER TABLE a DROP COLUMN b;"), [
        "DROP COLUMN",
      ]);
      assert.deepEqual(describeDestructiveStatements("UPDATE claims SET disposition = 'x';"), [
        "UPDATE without WHERE",
      ]);
      // Scoped statements are ordinary migrations, not destruction.
      assert.deepEqual(describeDestructiveStatements("DELETE FROM events WHERE seq < 10;"), []);
      assert.deepEqual(
        describeDestructiveStatements("UPDATE claims SET x = 1 WHERE id = 'C-1';"),
        [],
      );
      assert.deepEqual(describeDestructiveStatements(CREATE_A), []);
    },
  },
  {
    name: "undeclared-destructive-migration-is-refused-everywhere",
    execute() {
      const migrations = readMigrationDirectory(
        directory("undeclared", { "0001_drop.sql": "DROP TABLE claims;\n" }),
      );
      // Refused even where destruction is permitted: the marker is what makes
      // it reviewable, and an unmarked DROP is indistinguishable from a slip.
      expectFailure("undeclared-permissive", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], { environmentName: "local", destructiveAllowed: true }),
      );
      expectFailure("undeclared-strict", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], plainOptions),
      );
    },
  },
  {
    name: "declared-destructive-migration-is-refused-on-a-protected-target",
    execute() {
      const declared = "-- asimposium:allow-destructive\nDROP TABLE claims;\n";
      const migrations = readMigrationDirectory(
        directory("declared", { "0001_drop.sql": declared }),
      );
      expectFailure("protected", "DESTRUCTIVE_TARGET_REFUSED", () =>
        planMigrations(migrations, [], {
          environmentName: "production",
          destructiveAllowed: false,
        }),
      );
      // …and permitted where the environment allows it.
      const plan = planMigrations(migrations, [], {
        environmentName: "local",
        destructiveAllowed: true,
      });
      assert.equal(plan.to_apply[0].destructive, true);
    },
  },
  {
    name: "production records through 0014 begins with non-destructive 0015",
    execute() {
      const historicalMigrations = readMigrationDirectory(
        join(repositoryRoot, "db", "migrations"),
      ).filter((migration) => migration.sequence <= 15);
      const applied = historicalMigrations
        .filter((migration) => migration.sequence <= 14)
        .map(record);
      const plan = planMigrations(historicalMigrations, applied, {
        environmentName: "production",
        destructiveAllowed: false,
      });
      assert.equal(plan.head, 14);
      assert.deepEqual(plan.to_apply.slice(0, 1), [
        {
          id: "0015_sponsor_enrollment_bootstrap_invariant.sql",
          sequence: 15,
          digest: historicalMigrations.find((migration) => migration.sequence === 15)?.digest,
          destructive: false,
        },
      ]);
      assert.ok(
        plan.to_apply.every((migration) => migration.destructive === false),
        "a protected production plan must never admit a destructive pending migration",
      );
    },
  },
  {
    name: "the actual pending 0012 rebuild remains refused on production",
    execute() {
      const migrations = readMigrationDirectory(join(repositoryRoot, "db", "migrations"));
      const lifecycle = migrations.find((migration) => migration.sequence === 12);
      assert.ok(lifecycle, "0012 lifecycle migration is missing");
      assert.ok(describeDestructiveStatements(lifecycle.sql).length > 0);
      expectFailure("actual-0012-production", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(
          migrations,
          migrations.filter((migration) => migration.sequence <= 11).map(record),
          { environmentName: "production", destructiveAllowed: false },
        ),
      );
    },
  },

  // --- applied-state parsing ------------------------------------------------
  {
    name: "state-file-must-be-well-formed",
    execute() {
      const root = directory("state", {
        "bad.json": "{not json",
        "object.json": JSON.stringify({ id: "x" }),
        "incomplete.json": JSON.stringify([{ id: "0001_first.sql" }]),
        "good.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) },
        ]),
      });
      expectFailure("missing", "MISSING_STATE_FILE", () =>
        readStateFile(join(root, "absent.json")),
      );
      expectFailure("bad", "MALFORMED_STATE_FILE", () => readStateFile(join(root, "bad.json")));
      expectFailure("object", "MALFORMED_STATE_FILE", () =>
        readStateFile(join(root, "object.json")),
      );
      expectFailure("incomplete", "MALFORMED_STATE_FILE", () =>
        readStateFile(join(root, "incomplete.json")),
      );
      assert.equal(readStateFile(join(root, "good.json")).length, 1);
    },
  },

  // --- state records are bounded (parent audit) -----------------------------
  {
    name: "state-record-fields-are-bounded",
    execute() {
      const good = digestOf(CREATE_A);
      const bad = {
        "id-not-a-migration.json": [{ id: "../../etc/passwd", sequence: 1, digest: good }],
        "id-arbitrary.json": [{ id: "whatever", sequence: 1, digest: good }],
        "sequence-float.json": [{ id: "0001_first.sql", sequence: 1.5, digest: good }],
        "sequence-negative.json": [{ id: "0001_first.sql", sequence: -1, digest: good }],
        "sequence-string.json": [{ id: "0001_first.sql", sequence: "1", digest: good }],
        "sequence-mismatch.json": [{ id: "0001_first.sql", sequence: 7, digest: good }],
        "digest-short.json": [{ id: "0001_first.sql", sequence: 1, digest: "abc" }],
        "digest-uppercase.json": [
          { id: "0001_first.sql", sequence: 1, digest: good.toUpperCase() },
        ],
        "digest-nonhex.json": [{ id: "0001_first.sql", sequence: 1, digest: "z".repeat(64) }],
        "extra-key.json": [
          { id: "0001_first.sql", sequence: 1, digest: good, applied_by: "someone" },
        ],
        "record-array.json": [[{ id: "0001_first.sql", sequence: 1, digest: good }]],
      };
      const files = Object.fromEntries(
        Object.entries(bad).map(([name, value]) => [name, JSON.stringify(value)]),
      );
      const root = directory("state-bounds", files);
      for (const name of Object.keys(bad)) {
        expectFailure(name, "MALFORMED_STATE_FILE", () => readStateFile(join(root, name)));
      }
    },
  },
  {
    name: "state-records-must-be-unique-and-ascending",
    execute() {
      const a = digestOf(CREATE_A);
      const b = digestOf(CREATE_B);
      const root = directory("state-order", {
        "dup-id.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: a },
          { id: "0001_first.sql", sequence: 1, digest: a },
        ]),
        "dup-seq.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: a },
          { id: "0001_other.sql", sequence: 1, digest: b },
        ]),
        "descending.json": JSON.stringify([
          { id: "0002_second.sql", sequence: 2, digest: b },
          { id: "0001_first.sql", sequence: 1, digest: a },
        ]),
      });
      expectFailure("dup-id", "DUPLICATE_STATE_RECORD", () =>
        readStateFile(join(root, "dup-id.json")),
      );
      expectFailure("dup-seq", "DUPLICATE_STATE_RECORD", () =>
        readStateFile(join(root, "dup-seq.json")),
      );
      expectFailure("descending", "UNORDERED_STATE_FILE", () =>
        readStateFile(join(root, "descending.json")),
      );
    },
  },
  {
    name: "state-file-must-be-a-regular-file",
    execute() {
      const root = directory("state-symlink", {
        "real.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) },
        ]),
      });
      symlinkSync(join(root, "real.json"), join(root, "linked.json"), "file");
      expectFailure("symlinked-state", "UNSAFE_STATE_FILE", () =>
        readStateFile(join(root, "linked.json")),
      );
      expectFailure("directory-as-state", "UNSAFE_STATE_FILE", () => readStateFile(root));
    },
  },

  // --- migration files must be real files (parent audit) --------------------
  {
    name: "symlinked-migration-file-is-refused",
    execute() {
      const outside = directory("outside-sql", { "evil.sql": "DROP TABLE claims;\n" });
      const root = directory("symlink-migration", { "0001_first.sql": CREATE_A });
      symlinkSync(join(outside, "evil.sql"), join(root, "0002_linked.sql"), "file");
      expectFailure("symlinked-migration", "SYMLINKED_MIGRATION_FILE", () =>
        readMigrationDirectory(root),
      );
    },
  },
  {
    name: "symlinked-migrations-directory-is-refused",
    execute() {
      const real = directory("real-migrations", { "0001_first.sql": CREATE_A });
      const linkParent = directory("link-parent", {});
      const link = join(linkParent, "migrations");
      symlinkSync(real, link, "dir");
      expectFailure("symlinked-dir", "SYMLINKED_MIGRATIONS_DIRECTORY", () =>
        readMigrationDirectory(link),
      );
    },
  },
  {
    name: "special-file-in-the-migrations-directory-is-refused",
    execute() {
      const root = directory("special", { "0001_first.sql": CREATE_A });
      mkdirSync(join(root, "0002_subdir.sql"), { recursive: true });
      expectFailure("subdirectory", "NON_REGULAR_MIGRATION_FILE", () =>
        readMigrationDirectory(root),
      );
    },
  },

  // --- a rehearsal may never stand in for an application (parent audit) -----
  {
    name: "state-file-cannot-be-combined-with-apply",
    execute() {
      expectFailure("rehearsal-as-apply", "STATE_FILE_WITH_APPLY", () =>
        assertRehearsalIsNotAnApplication({ apply: true, state: "infra/rehearsal.json" }),
      );
      // Each alone is fine: a plan may use a rehearsal, and an apply may run
      // without one by reading the target's ledger.
      assertRehearsalIsNotAnApplication({ apply: false, state: "infra/rehearsal.json" });
      assertRehearsalIsNotAnApplication({ apply: true, state: undefined });
      assertRehearsalIsNotAnApplication({ apply: false, state: undefined });
    },
  },

  // --- stderr is surfaced, bounded and redacted (parent audit) --------------
  {
    name: "causal-stderr-is-redacted-and-bounded",
    execute() {
      assert.equal(redactStderr(""), "");
      assert.equal(redactStderr(undefined), "");

      const noisy = [
        "wrangler failed reading /Users/someone/projects/asimposium.org/infra/wrangler.toml",
        "CLOUDFLARE_API_TOKEN=abcdef0123456789abcdef",
        "token asimp_ag_deadbeefdeadbeefdeadbeef",
        `digest ${"a1b2c3d4".repeat(8)}`,
        "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----",
      ].join("\n");
      const safe = redactStderr(noisy);

      // The cause survives...
      assert.ok(safe.includes("wrangler failed"), safe);
      // ...but nothing that identifies a machine or carries a secret does.
      assert.equal(safe.includes("/Users/"), false, safe);
      assert.equal(safe.includes("abcdef0123456789"), false, safe);
      assert.equal(safe.includes("asimp_ag_"), false, safe);
      assert.equal(safe.includes("BEGIN PRIVATE KEY"), false, safe);
      assert.equal(/[A-Fa-f0-9]{32,}/.test(safe), false, safe);
      // Newlines collapse so one record stays one line.
      assert.equal(safe.includes("\n"), false, safe);

      // Bounded: a runaway log cannot flood a diagnostic.
      const long = redactStderr("x".repeat(50_000));
      assert.ok(long.length <= 601, String(long.length));
      assert.ok(long.endsWith("…"));
    },
  },
  {
    // Families this file never declared. They can only be redacted by the
    // shared module, so each one failing here means the delegation is gone.
    name: "credential-families-only-the-shared-module-knows-are-redacted",
    execute() {
      for (const [label, noisy, leaked] of [
        ["bearer", "Authorization: Bearer abcdefgh12345678", "abcdefgh12345678"],
        ["basic", "Authorization: Basic YWxhZGRpbjpvcGVuc2U=", "YWxhZGRpbjpvcGVuc2U"],
        ["github pat", "remote said github_pat_1234567890123456789012ab", "github_pat_1234"],
        ["stripe-shaped", "child printed sk_live_abcdefghijkl", "sk_live_abcdefghijkl"],
        ["google api key", "key AIzaSyA1234567890123456789012", "AIzaSyA1234567890"],
        ["join fragment", "url #v1.abcdefghijkl", "#v1.abcdefghijkl"],
        ["labelled password", "password: hunter2", "hunter2"],
      ]) {
        const safe = redactStderr(noisy);
        assert.equal(safe.includes(leaked), false, `${label}: ${safe}`);
        assert.ok(safe.includes(REDACTED_TOKEN), `${label}: ${safe}`);
      }
    },
  },
  {
    // Line-valued fields consume to end of line: a cookie attribute list or a
    // private body must not survive past the first `;` or `,`.
    name: "labelled-cookie-and-body-values-are-redacted-to-the-line-tail",
    execute() {
      for (const [noisy, leaked] of [
        ["cookie: sid=abc; other=secret", "other=secret"],
        ["set-cookie: a=1; Secure; HttpOnly", "HttpOnly"],
        ["directive_body: prove the lemma, then reveal the witness", "witness"],
        ["workshop_body: draft one, draft two", "draft two"],
      ]) {
        const safe = redactStderr(noisy);
        assert.equal(safe.includes(leaked), false, safe);
      }
    },
  },
  {
    // Every occurrence, not just the first: a child that echoes its environment
    // twice must not have the second copy printed.
    name: "every-occurrence-of-a-credential-family-is-replaced",
    execute() {
      const safe = redactStderr(
        "first asimp_ag_AAAABBBBCCCC then asimp_ag_DDDDEEEEFFFF and PGPASSWORD=one API_TOKEN=two",
      );
      assert.equal(safe.includes("asimp_ag_AAAA"), false, safe);
      assert.equal(safe.includes("asimp_ag_DDDD"), false, safe);
      assert.equal(safe.includes("one"), false, safe);
      assert.equal(safe.includes("two"), false, safe);
      // The labels survive so an operator knows which variables were withheld.
      assert.ok(safe.includes("PGPASSWORD="), safe);
      assert.ok(safe.includes("API_TOKEN="), safe);
    },
  },
  {
    // The scanner must not eat the diagnostic. A migration id, a short digest
    // prefix, and ordinary prose are what make a failure legible.
    name: "safe-migration-prose-and-identifiers-survive-redaction",
    execute() {
      const safe = redactStderr(
        "0004_krater_integrity_v1.sql applied in 12 ms; sequence 4; sha256 prefix a1b2c3d4",
      );
      assert.equal(
        safe,
        "0004_krater_integrity_v1.sql applied in 12 ms; sequence 4; sha256 prefix a1b2c3d4",
      );
      assert.equal(safe.includes(REDACTED_TOKEN), false, safe);
    },
  },
  {
    // Structural: the credential families live in one place. A copy reappearing
    // here is the drift this consolidation removed, and it would pass every
    // behavioural case above while silently falling behind the shared list.
    name: "migrate-does-not-restate-a-shared-credential-family",
    execute() {
      const source = readFileSync(new URL("./migrate.mjs", import.meta.url), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const duplicated of [
        "asimp_ag_",
        "BEGIN ",
        "Bearer",
        "Basic",
        "github_pat_",
        "AIza",
        "password",
        "cookie",
      ]) {
        assert.equal(code.includes(duplicated), false, `restated credential family: ${duplicated}`);
      }
      // ...while the migration-specific guards stay local to this file.
      assert.ok(code.includes("A-Z0-9_]{2,})="), "env-assignment guard missing");
      assert.ok(code.includes("A-Fa-f0-9]{32,}"), "long-hex guard missing");
      assert.ok(code.includes("MAX_CAUSAL_STDERR"), "size bound missing");
      // Absolute-path masking is still applied here, but it is defined once
      // beside the topology validator so the two runners cannot drift to
      // different notions of a masked path. Reached, not restated.
      assert.ok(code.includes("maskAbsolutePaths"), "absolute-path masking is not applied");
      assert.equal(code.includes("Volumes"), false, "absolute-path rule was restated locally");
    },
  },
  {
    // A caller who fat-fingers a token into `--env` must not have the tool that
    // refuses the value print it back into the log. The contrast run is the
    // causal half: the two invocations differ in exactly one dimension —
    // whether the argument is credential-shaped — and reach the same refusal by
    // the same path, so the redaction is shown to fire on the credential and
    // only on the credential.
    name: "a-credential-passed-as-an-environment-name-is-not-echoed",
    execute() {
      // Synthetic, shaped like a Fellow bearer token. Never a live value.
      const planted = "asimp_ag_LIVEabc123XYZdefg456";
      const refused = runCli(["--env", planted]);
      assert.equal(refused.exitCode, 1);

      const diagnostic = refusalOf(refused);
      assert.equal(diagnostic.status, "fail");
      assert.equal(diagnostic.code, "UNKNOWN_ENVIRONMENT");

      // Neither the whole token nor the distinctive tail survives anywhere a
      // caller can see, on either stream.
      assert.equal(refused.combined.includes(planted), false, "token reached the output");
      assert.equal(
        refused.combined.includes("abc123XYZdefg456"),
        false,
        "token tail reached the output",
      );
      assert.ok(diagnostic.detail.includes(REDACTED_TOKEN), "detail was not redacted");

      // The refusal is still useful: the safe prose that tells a caller what to
      // do instead is not collateral damage of the redaction.
      assert.ok(
        diagnostic.detail.includes("expected one of local, staging, production"),
        "safe prose did not survive redaction",
      );

      // Causal contrast: a non-credential name takes the same path to the same
      // code and is echoed verbatim, so the assertions above are load-bearing
      // rather than passing because nothing is ever echoed.
      const benign = runCli(["--env", "prod"]);
      const echoed = refusalOf(benign);
      assert.equal(echoed.code, "UNKNOWN_ENVIRONMENT");
      assert.ok(echoed.detail.includes('"prod"'), "a safe environment name should be echoed");
      assert.equal(echoed.detail.includes(REDACTED_TOKEN), false);
    },
  },
  {
    // A path is not a credential family, so the canonical scanner declines it.
    // Caller-controlled path diagnostics keep the absolute-path masking they
    // have always had, rather than losing it to the credential delegation.
    //
    // `--env` is the emission path under test because it is a *supported* flag
    // whose value is genuinely interpolated into the refusal. An earlier
    // revision of this case passed `--config`, which this CLI does not accept:
    // it took the INVALID_ARGUMENT branch, never interpolated the plant, and
    // "passed" only because the usage string literally contains
    // `[--state-file <path>]`. Pinning the code and refusing the usage text is
    // what keeps that false green from coming back.
    name: "an-absolute-caller-path-is-masked-in-the-diagnostic",
    execute() {
      const planted = "/Users/planted-operator/private-keys";
      const refused = runCli(["--env", planted]);
      assert.equal(refused.exitCode, 1);

      const diagnostic = refusalOf(refused);
      assert.equal(diagnostic.status, "fail");
      assert.equal(diagnostic.code, "UNKNOWN_ENVIRONMENT", "a non-interpolating branch ran");
      assert.equal(
        diagnostic.detail.includes("Usage:"),
        false,
        "took the usage branch, whose static text contains <path> and proves nothing",
      );

      // Exact, so a partial mask that left a fragment behind cannot pass.
      assert.equal(
        diagnostic.detail,
        'Unknown environment "<path>"; expected one of local, staging, production.',
      );
      assert.equal(refused.combined.includes("planted-operator"), false, "home directory leaked");
      assert.equal(refused.combined.includes(planted), false, "absolute path leaked");

      // Causal contrast: a value with no absolute path reaches the same code by
      // the same route and is echoed verbatim.
      const benign = refusalOf(runCli(["--env", "prod"]));
      assert.equal(benign.code, "UNKNOWN_ENVIRONMENT");
      assert.ok(benign.detail.includes('"prod"'), "a safe environment name should be echoed");
      assert.equal(benign.detail.includes("<path>"), false, "nothing to mask, yet masked");

      // This CLI's own path-bearing flag never interpolates the caller's path
      // at all: `--state-file` refusals are fixed strings. That is the stronger
      // property, so it is asserted as non-disclosure only and is deliberately
      // NOT offered as evidence of masking.
      const escaped = runCli(["--env", "local", "--state-file", `${planted}/state.json`]);
      assert.equal(refusalOf(escaped).code, "PATH_ESCAPE");
      assert.equal(escaped.combined.includes("planted-operator"), false, "home directory leaked");
      assert.equal(
        refusalOf(escaped).detail.includes("<path>"),
        false,
        "this refusal is a fixed string; a <path> here would mean it echoes after all",
      );

      // The masking primitive itself, which every diagnostic this file prints
      // is routed through.
      assert.equal(
        maskAbsolutePaths("read /Users/planted-operator/k.pem failed"),
        "read <path> failed",
      );
      assert.equal(
        redactStderr("wrangler: cannot open /Users/planted-operator/k.pem"),
        "wrangler: cannot open <path>",
      );
    },
  },
  {
    // A bare `\S+` value class stopped at the first space, so a quoted
    // assignment printed the tail of the value it claimed to withhold. Each
    // plant differs from the working case in exactly one dimension: where the
    // value ends.
    name: "a-quoted-environment-assignment-is-withheld-to-its-closing-quote",
    execute() {
      // Spaces inside the value: the old rule emitted ` def ghi"`.
      const spaced = redactStderr('child failed: TOKEN="abc def ghi" NEXT=keepme');
      assert.equal(spaced.includes("def"), false, "quoted value tail leaked");
      assert.equal(spaced.includes("ghi"), false, "quoted value tail leaked");
      assert.ok(spaced.includes(`TOKEN=${REDACTED_TOKEN}`), "label was not preserved");

      // An escaped quote inside the value: `"[^"]*"` would close early here and
      // leak the remainder, which is why the class consumes `\\.` as a unit.
      const escaped = redactStderr('child failed: TOKEN="abc \\" def" tail');
      assert.equal(escaped.includes("def"), false, "value past an escaped quote leaked");
      assert.ok(escaped.includes(`TOKEN=${REDACTED_TOKEN}`), "label was not preserved");

      // Single quotes are the same value class.
      const single = redactStderr("child failed: SECRET='a b c' after");
      assert.equal(single.includes(" b "), false, "single-quoted value tail leaked");

      // The bound is the closing quote and not the rest of the line: an
      // adjacent assignment is still redacted on its own terms, and ordinary
      // trailing prose survives, so the widened class did not become a
      // line-eating rule.
      assert.ok(spaced.includes(`NEXT=${REDACTED_TOKEN}`), "adjacent assignment was not redacted");
      assert.ok(escaped.endsWith("tail"), "prose after a quoted value did not survive");
      assert.ok(single.endsWith("after"), "prose after a quoted value did not survive");
    },
  },

  // --- remote observation, staging slice 1 -----------------------------------
  //
  // Observation only. No case here applies a migration, writes a journal row, or
  // decides the remote atomicity question — that design is deliberately open.
  {
    name: "a-remote-snapshot-plans-a-real-target-without-emitting-one-write",
    async execute() {
      const environment = stagingEnvironment();
      const transport = recordingTransport({ catalog: [] });
      const snapshot = await readRemoteLineageSnapshotOrRefuse(
        environment,
        transport,
        STAGING_DATABASE_ID,
      );

      // Shape parity with the local reader: the classifier must not be able to
      // tell which target produced a snapshot.
      assert.deepEqual(Object.keys(snapshot).sort(), ["catalog", "journal", "lineage", "target"]);
      assert.deepEqual(snapshot.journal, []);
      assert.deepEqual(snapshot.lineage, []);
      assert.deepEqual(snapshot.target, {
        database_id: STAGING_DATABASE_ID,
        database_name: STAGING_DATABASE_NAME,
      });

      // The real migration directory and manifest, because the classifier
      // validates one against the other: a synthetic pair would prove the
      // remote snapshot reaches a classifier this repository does not run.
      const migrations = readMigrationDirectory(join(repositoryRoot, "db/migrations"));
      assert.equal(
        classifySchemaLineage({
          ...snapshot,
          migrations,
          manifest: readBootstrapManifest(repositoryRoot),
        }).kind,
        "provably-empty",
      );

      // The plan is now an observation of the remote journal rather than the
      // `applied = []` guess a remote environment falls back to today.
      //
      // Synthetic migrations here on purpose, and it is not a mismatch with the
      // classifier above: `planMigrations` takes no manifest, and replaying the
      // real history from zero is correctly refused — 0010 is destructive
      // without a marker, because a real empty target is bootstrapped to the
      // pinned baseline rather than replayed. What this asserts is the narrow
      // new fact: the observed remote journal is what the planner consumes.
      const planned = readMigrationDirectory(
        directory("remote-plan", { "0001_first.sql": CREATE_A, "0002_second.sql": CREATE_B }),
      );
      const plan = planMigrations(planned, snapshot.journal, {
        environmentName: "staging",
        destructiveAllowed: environment.destructive_operations_allowed,
      });
      assert.equal(plan.idempotent, false);
      assert.deepEqual(
        plan.to_apply.map((migration) => migration.id),
        ["0001_first.sql", "0002_second.sql"],
      );

      // The zero-write proof, over every statement that actually reached the
      // boundary. Asserting only the count would pass a reader that sent one
      // very wrong statement.
      assert.ok(transport.statements.length >= 1, "no statement reached the transport");
      for (const statement of transport.statements) {
        assert.ok(/^SELECT\s/i.test(statement.trim()), `not a read: ${statement}`);
        assert.equal(
          /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|VACUUM|PRAGMA)\b/i.test(
            statement,
          ),
          false,
          `a write reached the transport: ${statement}`,
        );
      }
    },
  },
  {
    // The classifier already refuses this shape; what is proven here is that a
    // *remote* snapshot reaches it intact rather than being flattened into an
    // empty journal that would plan as a clean first run.
    name: "PLANTED-a-contaminated-remote-catalog-classifies-as-unknown",
    async execute() {
      const snapshot = await readRemoteLineageSnapshotOrRefuse(
        stagingEnvironment(),
        recordingTransport({
          catalog: [remoteCatalogRow("table", "stray_table", "CREATE TABLE stray_table (id TEXT)")],
        }),
        STAGING_DATABASE_ID,
      );
      assert.equal(
        classifySchemaLineage({
          ...snapshot,
          migrations: readMigrationDirectory(join(repositoryRoot, "db/migrations")),
          manifest: readBootstrapManifest(repositoryRoot),
        }).kind,
        "unknown-or-contaminated",
      );
    },
  },
  {
    // A truncated journal is worse than an unreadable one: it plans a migration
    // that already ran. The cap must refuse rather than return its first page.
    name: "PLANTED-a-remote-journal-over-its-row-cap-is-refused-not-truncated",
    async execute() {
      const catalog = [
        remoteCatalogRow("table", "_asimposium_migrations", "CREATE TABLE _asimposium_migrations"),
      ];
      const journal = Array.from({ length: 257 }, (_unused, index) => ({
        id: `${String(index + 1).padStart(4, "0")}_m.sql`,
        sequence: index + 1,
        digest: "0".repeat(64),
      }));
      await expectAsyncFailure("journal-overrun", "REMOTE_D1_JOURNAL_OVERRUN", () =>
        readRemoteLineageSnapshotOrRefuse(
          stagingEnvironment(),
          recordingTransport({ catalog, journal }),
          STAGING_DATABASE_ID,
        ),
      );
    },
  },
  {
    // The wrong-account case. Both plants differ from the accepted call in
    // exactly one dimension, and neither is detectable from the topology alone,
    // whose declared id is a `${VAR}` placeholder rather than an identity.
    name: "PLANTED-a-remote-target-that-is-not-the-resolved-one-is-refused",
    async execute() {
      const environment = stagingEnvironment();
      const other = OTHER_DATABASE_ID;

      await expectAsyncFailure("wrong-id", "REMOTE_TARGET_IDENTITY_MISMATCH", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({
            describe: { database_id: other, database_name: STAGING_DATABASE_NAME },
          }),
          STAGING_DATABASE_ID,
        ),
      );

      await expectAsyncFailure("wrong-name", "REMOTE_TARGET_IDENTITY_MISMATCH", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({
            describe: { database_id: STAGING_DATABASE_ID, database_name: "asimposium-production" },
          }),
          STAGING_DATABASE_ID,
        ),
      );

      // Causal control: the same call with the matching pair is accepted, so the
      // refusals above are caused by identity and not by the fixture.
      const accepted = await readRemoteLineageSnapshotOrRefuse(
        environment,
        recordingTransport({ catalog: [] }),
        STAGING_DATABASE_ID,
      );
      assert.equal(accepted.target.database_id, STAGING_DATABASE_ID);
    },
  },
  {
    name: "PLANTED-an-unresolved-database-id-is-not-an-identity",
    async execute() {
      const environment = stagingEnvironment();
      // Exactly what the topology carries before deploy resolution runs. Built
      // by concatenation, the idiom `resolve-wrangler-deploy.mjs` already uses,
      // so the literal is not mistaken for an interpolation that failed.
      const placeholder = "$" + "{ASIMP_D1_DATABASE_ID_STAGING}";
      assert.equal(environment.d1.database_id, placeholder);
      for (const [label, candidate] of [
        ["placeholder", environment.d1.database_id],
        ["absent", undefined],
        ["not-a-uuid", "asimposium-staging"],
        ["nil-uuid", "00000000-0000-0000-0000-000000000000"],
      ]) {
        await expectAsyncFailure(label, "REMOTE_TARGET_ID_UNRESOLVED", () =>
          readRemoteLineageSnapshotOrRefuse(environment, recordingTransport(), candidate),
        );
      }
      // The identity binding is reachable directly, so a caller cannot satisfy
      // it by supplying a target object without a resolved id.
      expectFailure("undescribed", "REMOTE_TARGET_UNDESCRIBED", () =>
        assertRemoteTargetIdentity(environment, null, STAGING_DATABASE_ID),
      );
    },
  },
  {
    // No local fallback: without an explicit transport the reader refuses, and
    // it must refuse *before* describing or querying anything.
    name: "PLANTED-a-remote-observation-without-a-transport-refuses-rather-than-falling-back",
    async execute() {
      const environment = stagingEnvironment();
      for (const [label, candidate] of [
        ["absent", undefined],
        ["null", null],
        ["query-only", { query: async () => [] }],
        ["describe-only", { describeTarget: async () => ({}) }],
      ]) {
        await expectAsyncFailure(label, "REMOTE_TRANSPORT_UNAVAILABLE", () =>
          readRemoteLineageSnapshotOrRefuse(environment, candidate, STAGING_DATABASE_ID),
        );
      }
    },
  },
  {
    name: "the-remote-reader-cannot-reach-the-local-executor",
    execute() {
      // Structural, because a behavioural test can only show that the paths it
      // happened to drive stayed remote. The local executor holds the only
      // credential-free D1 handle in this file; the remote reader must not be
      // able to name it at all.
      const source = readFileSync(new URL("./migrate.mjs", import.meta.url), "utf8");
      const start = source.indexOf("export async function readRemoteLineageSnapshotOrRefuse");
      assert.ok(start > 0, "the remote reader was renamed or removed");
      const end = source.indexOf("\nexport function bootstrapInstallSql", start);
      assert.ok(end > start, "could not bound the remote reader");
      const body = source.slice(start, end);
      assert.equal(body.includes("localD1"), false, "the remote reader can reach local D1");
      assert.equal(body.includes("localPersistTo"), false, "the remote reader takes local state");
    },
  },
  {
    // Read-only is enforced at the seam, not described in a comment: a write
    // cannot reach the transport even if a future caller composes one.
    name: "PLANTED-a-write-cannot-reach-the-remote-transport",
    execute() {
      for (const [label, statement] of [
        ["delete", "DELETE FROM _asimposium_migrations;"],
        ["insert", "INSERT INTO _asimposium_migrations VALUES ('x', 1, 'y', 'z');"],
        ["stacked", "SELECT 1; DROP TABLE _asimposium_migrations;"],
        ["ddl", "CREATE TABLE t (id TEXT);"],
        ["empty", "   "],
      ]) {
        expectFailure(label, "REMOTE_READ_NOT_READ_ONLY", () => assertReadOnlySql(statement));
      }
      // Causal control: the reader's own statement shape passes the same gate,
      // so the refusals above are caused by the statement and not by the guard
      // refusing everything.
      assert.equal(assertReadOnlySql("SELECT 1;"), "SELECT 1;");
      assert.equal(
        assertReadOnlySql("SELECT type, name FROM sqlite_schema ORDER BY type LIMIT 2;"),
        "SELECT type, name FROM sqlite_schema ORDER BY type LIMIT 2;",
      );
    },
  },
  {
    name: "PLANTED-a-local-environment-is-refused-by-the-remote-reader",
    async execute() {
      // Local has a credential-free reader of its own; letting the remote one
      // stand in for it would make the local/remote distinction decorative.
      const local = selectEnvironment(validateEnvironments(repositoryRoot), "local");
      assert.equal(local.kind, "local");
      await expectAsyncFailure("local-through-remote", "REMOTE_READER_WRONG_TARGET", () =>
        readRemoteLineageSnapshotOrRefuse(local, recordingTransport(), STAGING_DATABASE_ID),
      );
    },
  },

  // --- audit repairs: TOCTOU, own-properties, bytes, opacity, deadline --------
  {
    // The gap the audit found. `describeTarget` was checked once and every query
    // was then independent, so a transport could describe the authorized target
    // and serve every row from somewhere else.
    name: "PLANTED-a-transport-that-describes-staging-then-serves-another-database-is-refused",
    async execute() {
      const environment = stagingEnvironment();
      const splitBrain = recordingTransport({ catalog: [], servedBy: OTHER_DATABASE_ID });
      await expectAsyncFailure("split-brain", "REMOTE_TARGET_IDENTITY_MISMATCH", () =>
        readRemoteLineageSnapshotOrRefuse(environment, splitBrain, STAGING_DATABASE_ID),
      );
      // It passed the one-time describe, so the refusal can only have come from
      // the per-result check.
      assert.equal(splitBrain.calls.describe, 1);
      assert.ok(splitBrain.calls.query >= 1, "no query was attempted");

      // The resolved id travels into every request, not merely out of the first
      // response: a reader that verified replies without binding requests would
      // still let a transport choose which database to read.
      const bound = recordingTransport({ catalog: [] });
      await readRemoteLineageSnapshotOrRefuse(environment, bound, STAGING_DATABASE_ID);
      assert.ok(bound.requestedIds.length >= 1);
      for (const requested of bound.requestedIds) {
        assert.equal(requested, STAGING_DATABASE_ID);
      }
    },
  },
  {
    name: "PLANTED-inherited-and-accessor-response-fields-are-refused",
    async execute() {
      const environment = stagingEnvironment();

      // Inherited, not own: `in` and member access both consult the prototype.
      const inherited = Object.create({ database_name: STAGING_DATABASE_NAME });
      inherited.database_id = STAGING_DATABASE_ID;
      await expectAsyncFailure("inherited-identity", "REMOTE_TARGET_UNDESCRIBED", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({ describe: inherited }),
          STAGING_DATABASE_ID,
        ),
      );

      // A getter is the sharper case: it can answer the identity check with the
      // authorized id and the row reader with anything at all.
      let reads = 0;
      const twoFaced = {
        database_name: STAGING_DATABASE_NAME,
        get database_id() {
          reads += 1;
          return reads === 1 ? STAGING_DATABASE_ID : OTHER_DATABASE_ID;
        },
      };
      await expectAsyncFailure("accessor-identity", "REMOTE_TARGET_UNDESCRIBED", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({ describe: twoFaced }),
          STAGING_DATABASE_ID,
        ),
      );

      // A catalog row whose field is inherited from a polluted prototype.
      const pollutedRow = Object.create({ sql: null });
      Object.assign(pollutedRow, { type: "table", name: "t", tbl_name: "t" });
      await expectAsyncFailure("inherited-row", "REMOTE_D1_CATALOG_UNREADABLE", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({ catalog: [pollutedRow] }),
          STAGING_DATABASE_ID,
        ),
      );

      // An extra own key is a different response than the one this reader
      // models, so it is refused rather than silently narrowed.
      await expectAsyncFailure("extra-key", "REMOTE_D1_CATALOG_UNREADABLE", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({
            catalog: [{ type: "table", name: "t", tbl_name: "t", sql: null, extra: 1 }],
          }),
          STAGING_DATABASE_ID,
        ),
      );

      // A non-enumerable own key would be invisible to `Object.keys`.
      const hidden = { type: "table", name: "t", tbl_name: "t", sql: null };
      Object.defineProperty(hidden, "smuggled", { value: 1, enumerable: false });
      await expectAsyncFailure("non-enumerable-key", "REMOTE_D1_CATALOG_UNREADABLE", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({ catalog: [hidden] }),
          STAGING_DATABASE_ID,
        ),
      );

      // A transport whose method is inherited rather than own.
      await expectAsyncFailure("inherited-method", "REMOTE_TRANSPORT_UNAVAILABLE", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          Object.create({ describeTarget: async () => ({}), query: async () => ({}) }),
          STAGING_DATABASE_ID,
        ),
      );

      // Causal control: the same shapes as own data properties are accepted, so
      // the refusals above are caused by inheritance and accessors alone.
      const accepted = await readRemoteLineageSnapshotOrRefuse(
        environment,
        recordingTransport({ catalog: [remoteCatalogRow("table", "t", null)] }),
        STAGING_DATABASE_ID,
      );
      assert.deepEqual(accepted.catalog, [{ type: "table", name: "t", table: "t", sql: null }]);
    },
  },
  {
    // Row caps alone bound cardinality, not size: 256 journal rows carrying a
    // megabyte each is within every count limit.
    name: "PLANTED-oversized-strings-and-aggregate-bytes-are-refused",
    async execute() {
      const environment = stagingEnvironment();

      const huge = "x".repeat(MAX_REMOTE_STRING_BYTES + 1);
      await expectAsyncFailure("single-string", "REMOTE_D1_CATALOG_UNREADABLE", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({ catalog: [remoteCatalogRow("table", "t", huge)] }),
          STAGING_DATABASE_ID,
        ),
      );

      // Each row is individually under the per-string bound; together they are
      // over the whole-observation bound.
      const chunk = "y".repeat(MAX_REMOTE_STRING_BYTES);
      const rows = Array.from(
        { length: Math.ceil(MAX_REMOTE_RESPONSE_BYTES / MAX_REMOTE_STRING_BYTES) + 1 },
        (_unused, index) => remoteCatalogRow("table", `t${index}`, chunk),
      );
      await expectAsyncFailure("aggregate", "REMOTE_D1_CATALOG_UNREADABLE", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({ catalog: rows }),
          STAGING_DATABASE_ID,
        ),
      );

      // Causal control: one row of exactly the per-string bound is accepted, so
      // the refusals are caused by size and not by the shape of the fixture.
      const accepted = await readRemoteLineageSnapshotOrRefuse(
        environment,
        recordingTransport({ catalog: [remoteCatalogRow("table", "t", chunk)] }),
        STAGING_DATABASE_ID,
      );
      assert.equal(accepted.catalog[0].sql.length, MAX_REMOTE_STRING_BYTES);
    },
  },
  {
    // A transport failure is data from outside this process. It may carry a
    // provider message, a credential, or an operator's absolute path, and none of
    // it may reach a diagnostic.
    name: "PLANTED-a-transport-failure-cannot-carry-its-message-secret-or-path",
    async execute() {
      const environment = stagingEnvironment();
      const secret = "asimp_ag_LIVEabc123XYZdefg456";
      const absolute = "/Users/planted-operator/.cloudflare/credentials";
      const hostile = () => {
        throw new Error(`provider said ${secret} while reading ${absolute}`);
      };

      for (const [label, options, code] of [
        ["describe", { onDescribe: hostile }, "REMOTE_TARGET_UNDESCRIBED"],
        ["query", { onQuery: hostile }, "REMOTE_D1_CATALOG_UNREADABLE"],
      ]) {
        let captured;
        try {
          await readRemoteLineageSnapshotOrRefuse(
            environment,
            recordingTransport(options),
            STAGING_DATABASE_ID,
          );
          assert.fail(`${label}: expected ${code}`);
        } catch (error) {
          captured = error;
        }
        assert.ok(captured instanceof MigrationError, label);
        assert.equal(captured.code, code, label);
        assert.equal(captured.message.includes(secret), false, `${label}: secret leaked`);
        assert.equal(captured.message.includes("abc123XYZdefg456"), false, `${label}: tail leaked`);
        assert.equal(captured.message.includes("planted-operator"), false, `${label}: path leaked`);
        assert.equal(captured.message.includes("provider said"), false, `${label}: message leaked`);
      }
    },
  },
  {
    // A never-settling call is the failure a row cap cannot reach. The deadline
    // is monotonic and the abort signal is the cooperative half.
    name: "PLANTED-a-never-settling-transport-is-bounded-and-cancelled",
    async execute() {
      const environment = stagingEnvironment();
      const stall = () => new Promise(() => {});

      for (const [label, options] of [
        ["describe", { onDescribe: stall }],
        ["query", { onQuery: stall }],
      ]) {
        const startedAtMs = performance.now();
        await expectAsyncFailure(label, "REMOTE_OBSERVATION_DEADLINE_EXCEEDED", () =>
          readRemoteLineageSnapshotOrRefuse(
            environment,
            recordingTransport(options),
            STAGING_DATABASE_ID,
            { deadlineMs: 60 },
          ),
        );
        // Bounded in fact, not merely in intent.
        assert.ok(performance.now() - startedAtMs < 5_000, `${label}: not bounded`);
      }

      // Cancellation reaches the transport, so a cooperative one can stop work.
      let observed;
      await expectAsyncFailure("cancelled", "REMOTE_OBSERVATION_DEADLINE_EXCEEDED", () =>
        readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({
            onDescribe: (request) => {
              observed = request?.signal;
              return new Promise(() => {});
            },
          }),
          STAGING_DATABASE_ID,
          { deadlineMs: 60 },
        ),
      );
      assert.ok(observed !== undefined, "no abort signal was handed to the transport");
      assert.equal(observed.aborted, true, "the signal was never aborted");

      // The clamp only tightens: an absurd request cannot extend the ceiling.
      assert.ok(MAX_REMOTE_STRING_BYTES > 0 && REMOTE_OBSERVATION_DEADLINE_MS === 15_000);
    },
  },
  {
    // The sixth blocker: the resolved id was validated *inside* a call whose
    // argument was `await transport.describeTarget()`, so the transport ran
    // first and an unresolved caller still reached the network.
    name: "PLANTED-an-unresolved-id-refuses-before-any-transport-method-runs",
    async execute() {
      const environment = stagingEnvironment();
      const placeholder = "$" + "{ASIMP_D1_DATABASE_ID_STAGING}";
      for (const [label, candidate] of [
        ["placeholder", placeholder],
        ["absent", undefined],
        ["null", null],
        ["not-a-uuid", "asimposium-staging"],
        ["nil-uuid", "00000000-0000-0000-0000-000000000000"],
      ]) {
        const sentinel = forbiddenTransport();
        await expectAsyncFailure(label, "REMOTE_TARGET_ID_UNRESOLVED", () =>
          readRemoteLineageSnapshotOrRefuse(environment, sentinel, candidate),
        );
        // Both mechanisms: the counters stay at zero, and had either method run
        // its sentinel throw would have replaced the expected refusal above.
        assert.equal(sentinel.calls.describe, 0, `${label}: describeTarget was reached`);
        assert.equal(sentinel.calls.query, 0, `${label}: query was reached`);
      }

      // Causal control: the identical sentinel transport is reached once the id
      // resolves, so the zero counts above are caused by the id and not by a
      // transport that is never called at all.
      const reached = forbiddenTransport();
      await expectAsyncFailure("resolved", "REMOTE_TARGET_UNDESCRIBED", () =>
        readRemoteLineageSnapshotOrRefuse(environment, reached, STAGING_DATABASE_ID),
      );
      assert.equal(reached.calls.describe, 1, "the resolved path never reached the transport");
    },
  },
];

const pureOnly = process.env.MIGRATE_TEST_PURE_ONLY === "1";
const executed = [];
const skipped = [];
const failed = [];
for (const testCase of cases) {
  if (pureOnly && testCase.requiresWrangler === true) {
    skipped.push(testCase.name);
    continue;
  }
  try {
    await testCase.execute();
    executed.push(testCase.name);
  } catch (error) {
    failed.push({
      name: testCase.name,
      detail: error instanceof Error ? error.message : "unknown",
    });
  }
}

if (failed.length === 0) {
  process.stdout.write(
    `${JSON.stringify({
      tool: "bun",
      package: "infra",
      suite: "d1-migration-contract",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "pass",
      reproduce,
      cases_executed: executed,
      ...(pureOnly ? { cases_skipped_for_s2_isolation: skipped } : {}),
      temporary_space_fixtures_retained: true,
      no_database_touched: true,
    })}\n`,
  );
} else {
  process.stderr.write(
    `${JSON.stringify({
      tool: "bun",
      package: "infra",
      suite: "d1-migration-contract",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "fail",
      reproduce,
      code: "CONTRACT_CASES_FAILED",
      failed_cases: failed.map(({ name }) => name),
      assertion_diff: failed,
    })}\n`,
  );
  process.exitCode = 1;
}
