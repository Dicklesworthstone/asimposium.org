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
  applyPendingRemoteMigrationsOrRefuse,
  assertReadLimit,
  assertReadOnlySql,
  assertRehearsalIsNotAnApplication,
  assertRemoteTargetIdentity,
  bootstrapInstallSql,
  bootstrapTargetDisposition,
  catalogFingerprint,
  classifySchemaLineage,
  createWranglerRemoteTransport,
  declaresDestructive,
  describeDestructiveStatements,
  digestOf,
  LOCAL_D1_KILL_REAP_MS,
  LOCAL_D1_PIPE_DRAIN_MS,
  LOCAL_D1_TERM_GRACE_MS,
  localPlanState,
  MAX_REMOTE_RESPONSE_BYTES,
  MAX_REMOTE_STRING_BYTES,
  MigrationError,
  migrationCommandSql,
  planMigrations,
  REMOTE_D1_CLEANUP_RESERVE_MS,
  REMOTE_D1_COMMAND_WINDOW_MS,
  REMOTE_D1_CONTAINMENT_RESERVE_MS,
  REMOTE_D1_EXECUTION_FLOOR_MS,
  REMOTE_D1_SCHEDULING_MARGIN_MS,
  REMOTE_D1_STDOUT_MAX_BYTES,
  REMOTE_OBSERVATION_DEADLINE_MS,
  readBootstrapManifest,
  readBootstrapSnapshotOrRefuse,
  readMigrationDirectory,
  readRemoteLineageSnapshotOrRefuse,
  readStateFile,
  redactStderr,
  remoteExecutionAllocation,
  resolvePinnedWranglerCommand,
  runBoundedCommand,
  runMigrationCli,
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

/**
 * A REAL `ReadableStream` whose underlying `cancel` hook never settles.
 *
 * This is the production-relevant shape, and it is deliberately not a
 * hand-written reader. Per the Streams standard, `reader.cancel()` closes the
 * stream while *initiating* cancellation: pending reads are fulfilled with
 * `{done: true}` before the source hook is awaited. A hand-rolled fake that
 * keeps its read parked until its cancel promise settles couples two things the
 * platform keeps separate, and would "prove" a stranded lock that a real stream
 * cannot produce. Here only the outer cancellation promise stays pending, which
 * is exactly what the bounded cleanup window exists to stop waiting on.
 */
function neverSettlingCancelPipe() {
  const state = { cancelCount: 0 };
  state.stream = new ReadableStream({
    pull() {
      // Park the drain inside read() until cancellation closes the stream.
      return new Promise(() => {});
    },
    cancel() {
      state.cancelCount += 1;
      // The source never acknowledges. The reader's pending read is already
      // fulfilled by this point; only this promise is left outstanding.
      return new Promise(() => {});
    },
  });
  return state;
}

/**
 * A pipe that parks a reader exactly the way a stuck child does, and records
 * whether anything ever let go of it. `pull` never settles, so the drain loop
 * sits inside `read()` until something cancels the reader; the underlying
 * `cancel` hook is the only way that can be observed from outside.
 */
function parkedPipe(onPull = undefined) {
  const state = { cancelCount: 0 };
  state.stream = new ReadableStream({
    pull() {
      onPull?.();
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
const STAGING_ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ACCOUNT_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

/** A writer-capable in-memory transport for the forward-only seam. */
function recordingRemoteApplyTransport(options = {}) {
  const transport = recordingTransport(options);
  const executions = [];
  return Object.assign(transport, {
    atomicity: "d1-query-implicit-transaction-v1",
    executions,
    execute: async (request) => {
      executions.push(request);
      if (options.onExecute !== undefined) return options.onExecute(request);
      return { database_id: STAGING_DATABASE_ID };
    },
    executeFile: async (request) => {
      executions.push(request);
      if (options.onExecute !== undefined) return options.onExecute(request);
      return { database_id: STAGING_DATABASE_ID };
    },
  });
}

function successfulRemoteCommand(rows) {
  return {
    outcome: "exited",
    exitCode: 0,
    stdout: JSON.stringify([{ success: true, results: rows, meta: { served_by_primary: true } }]),
    stderr: "",
  };
}

function successfulRemoteInfo() {
  return {
    outcome: "exited",
    exitCode: 0,
    stdout: JSON.stringify({
      uuid: STAGING_DATABASE_ID,
      name: STAGING_DATABASE_NAME,
      read_replication: { mode: "disabled" },
    }),
    stderr: "",
  };
}

/**
 * A tiny workspace-shaped root for default-transport tests. Its pinned
 * Wrangler files exist only so path/version validation runs. Most callers
 * inject a pure command runner; the owned-settlement plants instead replace
 * this local entrypoint and exercise the real bounded child path. Neither form
 * reaches a provider.
 */
function defaultRemoteTransportRoot(
  name,
  databaseId = STAGING_DATABASE_ID,
  wranglerSource = "// command runner is injected by this pure fixture\n",
) {
  const root = join(space, name);
  mkdirSync(join(root, "infra", "deploy-resolved"), { recursive: true });
  mkdirSync(join(root, "apps", "wire", "node_modules", "wrangler", "bin"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "infra", "deploy-resolved", "staging.wrangler.toml"),
    `account_id = "${STAGING_ACCOUNT_ID}"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${STAGING_DATABASE_NAME}"\ndatabase_id = "${databaseId}"\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "apps", "wire", "package.json"),
    JSON.stringify({ devDependencies: { wrangler: "4.123.0" } }),
    "utf8",
  );
  writeFileSync(
    join(root, "apps", "wire", "node_modules", "wrangler", "package.json"),
    JSON.stringify({ version: "4.123.0" }),
    "utf8",
  );
  writeFileSync(
    join(root, "apps", "wire", "node_modules", "wrangler", "bin", "wrangler.js"),
    wranglerSource,
    "utf8",
  );
  return root;
}

async function waitForFixturePath(path, timeoutMs, label) {
  const deadlineAt = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadlineAt) {
      assert.fail(`${label} was not published within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5);
      timer.unref?.();
    });
  }
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

/**
 * A real `runMigrationCli` fixture root: its first fifteen migration bytes are
 * copied from the repository so the immutable historical pins still bind, and
 * its forward migration is the current production 0016 byte. Only the catalog
 * returned by the inert transport is synthetic; this plant proves CLI receipt,
 * re-observation, and idempotence orchestration rather than a provider write.
 */
function remoteCliApplyFixtureRoot(name) {
  const root = join(space, name);
  const migrationRoot = join(root, "db", "migrations");
  const bootstrapRoot = join(root, "db", "bootstrap");
  mkdirSync(migrationRoot, { recursive: true });
  mkdirSync(bootstrapRoot, { recursive: true });

  const productionMigrations = readMigrationDirectory(join(repositoryRoot, "db", "migrations"));
  const migrations = productionMigrations.filter((migration) => migration.sequence <= 16);
  assert.equal(migrations.length, 16, "the current real 0016 migration must be present");
  assert.equal(migrations.at(-1)?.id, "0016_operator_fellow_cap_override.sql");
  for (const migration of migrations) {
    writeFileSync(
      join(migrationRoot, migration.id),
      readFileSync(join(repositoryRoot, "db", "migrations", migration.id), "utf8"),
      "utf8",
    );
  }

  const artifactSql = readFileSync(
    join(repositoryRoot, "db", "bootstrap", "0015_final_schema_v1.sql"),
    "utf8",
  );
  writeFileSync(join(bootstrapRoot, "0015_final_schema_v1.sql"), artifactSql, "utf8");
  const baselineProduct = {
    type: "table",
    name: "remote_cli_baseline",
    table: "remote_cli_baseline",
    sql: "CREATE TABLE remote_cli_baseline (id TEXT PRIMARY KEY);",
  };
  const forwardProduct = {
    type: "table",
    name: "remote_cli_forward_0016",
    table: "remote_cli_forward_0016",
    sql: "CREATE TABLE remote_cli_forward_0016 (id TEXT PRIMARY KEY);",
  };
  const baselineDigest = catalogFingerprint([baselineProduct]);
  const forwardDigest = catalogFingerprint([baselineProduct, forwardProduct]);
  writeFileSync(
    join(bootstrapRoot, "manifest.json"),
    JSON.stringify({
      version: 1,
      default_artifact_id: "0015-final-schema-v1",
      artifacts: [
        {
          id: "0015-final-schema-v1",
          file: "0015_final_schema_v1.sql",
          head_sequence: 15,
          digest: digestOf(artifactSql),
          schema_digest: baselineDigest,
          legacy_0009_schema_digest: "b".repeat(64),
        },
      ],
      historical_migrations: HISTORICAL_0015_GOLDEN_PINS,
      schema_heads: [
        { sequence: 15, schema_digest: baselineDigest },
        { sequence: 16, schema_digest: forwardDigest },
      ],
    }),
    "utf8",
  );
  const rawCatalog = (products) => [
    ...products.map(({ type, name: objectName, table, sql }) => ({
      type,
      name: objectName,
      tbl_name: table,
      sql,
    })),
    remoteCatalogRow("table", runnerLedgerCatalog.name, runnerLedgerCatalog.sql),
  ];
  return {
    root,
    migrations,
    forward: migrations.at(-1),
    beforeCatalog: rawCatalog([baselineProduct]),
    afterCatalog: rawCatalog([baselineProduct, forwardProduct]),
  };
}

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

      const actual0020 = productionMigrations.find((migration) => migration.sequence === 20);
      assert.ok(actual0020, "current migration 0020 must exist");
      assert.equal(actual0020.id, "0020_session_replay_atomic_claim.sql");
      const schemaHead20 = productionManifest.schema_heads.filter((head) => head.sequence === 20);
      assert.equal(
        schemaHead20.length,
        1,
        "the production manifest must register exactly one measured head 20",
      );
      const migrationsThrough0020 = productionMigrations.filter(
        (migration) => migration.sequence <= actual0020.sequence,
      );
      assert.equal(migrationsThrough0020.length, 20, "the replay-claim proof requires 0001-0020");
      assert.deepEqual(
        planMigrations(migrationsThrough0020, actualHistorical, forwardOptions).to_apply.map(
          (migration) => migration.id,
        ),
        migrationsThrough0020.slice(15).map((migration) => migration.id),
        "the production planner must admit the complete registered 0016-0020 suffix",
      );

      const actual0021 = productionMigrations.find((migration) => migration.sequence === 21);
      assert.ok(actual0021, "current migration 0021 must exist");
      assert.equal(actual0021.id, "0021_problem_scoped_claim_identity.sql");
      const schemaHead21 = productionManifest.schema_heads.filter((head) => head.sequence === 21);
      assert.equal(
        schemaHead21.length,
        1,
        "the production manifest must register exactly one measured head 21",
      );
      const migrationsThrough0021 = productionMigrations.filter(
        (migration) => migration.sequence <= actual0021.sequence,
      );
      assert.equal(
        migrationsThrough0021.length,
        21,
        "the problem-scoped claim proof requires 0001-0021",
      );
      assert.deepEqual(
        planMigrations(migrationsThrough0021, actualHistorical, forwardOptions).to_apply.map(
          (migration) => migration.id,
        ),
        migrationsThrough0021.slice(15).map((migration) => migration.id),
        "the production planner must admit the complete registered 0016-0021 suffix",
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
    name: "hosted _cf_KV is platform metadata only in its exact catalog shape",
    execute() {
      const migrations = readMigrationDirectory(join(repositoryRoot, "db/migrations"));
      const manifest = readBootstrapManifest(repositoryRoot);
      const exactKv = {
        type: "table",
        name: "_cf_KV",
        table: "_cf_KV",
        sql: "CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID",
      };
      assert.equal(
        classifySchemaLineage({
          catalog: [exactKv],
          journal: [],
          lineage: [],
          migrations,
          manifest,
        }).kind,
        "provably-empty",
        "a fresh hosted D1 carries only the runtime's own _cf_KV",
      );
      assert.equal(
        classifySchemaLineage({
          catalog: [{ ...exactKv, sql: "CREATE TABLE _cf_KV (id TEXT);" }],
          journal: [],
          lineage: [],
          migrations,
          manifest,
        }).kind,
        "unknown-or-contaminated",
        "a _cf_KV whose bytes drifted is catalog evidence, not metadata",
      );
      // The fingerprint must ignore the exact platform table so local and
      // remote catalogs of the same product schema pin the same digest.
      const product = {
        type: "table",
        name: "product",
        table: "product",
        sql: "CREATE TABLE product (id TEXT);",
      };
      assert.equal(catalogFingerprint([product]), catalogFingerprint([product, exactKv]));
    },
  },
  {
    name: "authorized remote bootstrap installs byte-exactly and reclassifies idempotently",
    async execute() {
      const capture = () => {
        const stdout = [];
        const stderr = [];
        return {
          stdout,
          stderr,
          dependencies: {
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line),
            now: () => "2026-08-17T00:00:00.000Z",
          },
        };
      };
      const fixture = remoteCliApplyFixtureRoot("remote-cli-bootstrap");
      const manifest = readBootstrapManifest(fixture.root);
      const artifact = manifest.artifacts[0];
      const FIXED_APPLIED_AT = "2026-08-17T00:00:00.000Z";
      const expectedSql = bootstrapInstallSql(artifact, FIXED_APPLIED_AT);
      const cfKvRow = remoteCatalogRow(
        "table",
        "_cf_KV",
        "CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID",
      );
      const catalog = [cfKvRow];
      const journal = [];
      const lineage = [];
      let executeCalls = 0;
      const transport = recordingRemoteApplyTransport({
        catalog,
        journal,
        lineage,
        onExecute(request) {
          executeCalls += 1;
          // Strict byte equality before any state moves, same discipline as
          // the forward-apply plant.
          if (request.sql !== expectedSql) throw new Error("REMOTE_BOOTSTRAP_SQL_MISMATCH");
          catalog.splice(
            0,
            catalog.length,
            cfKvRow,
            ...fixture.beforeCatalog.filter((row) => row.tbl_name !== "_cf_KV"),
            remoteCatalogRow("table", runnerLineageCatalog.name, runnerLineageCatalog.sql),
          );
          lineage.push({
            ...bootstrapLineageRow(artifact.schema_digest),
            artifact_digest: artifact.digest,
          });
          return { database_id: STAGING_DATABASE_ID };
        },
      });
      const runCapture = capture();
      const validatedTopology = validateEnvironments(repositoryRoot);
      const args = [
        "--env",
        "staging",
        "--resolved-database-id",
        STAGING_DATABASE_ID,
        "--bootstrap",
        "0015-final-schema-v1",
        "--i-authorize-disposable-remote-bootstrap",
        "--apply",
      ];
      const applyExit = await runMigrationCli(args, {
        ...runCapture.dependencies,
        root: fixture.root,
        environmentValidator: () => validatedTopology,
        remoteTransportFactory: () => transport,
      });
      assert.equal(applyExit, 0, runCapture.stderr.join(""));
      assert.equal(executeCalls, 1, "exactly one install batch crossed the seam");
      const receipt = JSON.parse(runCapture.stdout.join("").trim());
      assert.equal(receipt.phase, "bootstrap");
      assert.equal(receipt.lineage, "bootstrap-baseline15");
      assert.equal(receipt.idempotent, false);

      // A second identical run re-observes the installed lineage and applies
      // nothing.
      const secondCapture = capture();
      const secondExit = await runMigrationCli(args, {
        ...secondCapture.dependencies,
        root: fixture.root,
        environmentValidator: () => validatedTopology,
        remoteTransportFactory: () => transport,
      });
      assert.equal(secondExit, 0, secondCapture.stderr.join(""));
      assert.equal(executeCalls, 1, "the repeated authorized run must stay read-only");
      const secondReceipt = JSON.parse(secondCapture.stdout.join("").trim());
      assert.equal(secondReceipt.idempotent, true);

      // Without the operator flag the same target refuses before any
      // observation, even though authorization succeeded moments ago.
      const flaggedOffCapture = capture();
      const describeBefore = transport.calls.describe;
      const flaggedOffExit = await runMigrationCli(
        args.filter((argument) => argument !== "--i-authorize-disposable-remote-bootstrap"),
        {
          ...flaggedOffCapture.dependencies,
          root: fixture.root,
          environmentValidator: () => validatedTopology,
          remoteTransportFactory: () => transport,
        },
      );
      assert.equal(flaggedOffExit, 1);
      assert.equal(transport.calls.describe, describeBefore, "no observation without the flag");
      assert.equal(
        JSON.parse(flaggedOffCapture.stderr.join("").trim()).code,
        "BOOTSTRAP_REMOTE_UNAVAILABLE",
      );

      // The flag is scoped to the staging preview: production with the flag
      // still refuses before a transport exists.
      let productionFactoryCalls = 0;
      const productionCapture = capture();
      const productionExit = await runMigrationCli(
        [
          "--env",
          "production",
          "--resolved-database-id",
          STAGING_DATABASE_ID,
          "--bootstrap",
          "0015-final-schema-v1",
          "--i-authorize-disposable-remote-bootstrap",
          "--apply",
        ],
        {
          ...productionCapture.dependencies,
          root: fixture.root,
          environmentValidator: () => validatedTopology,
          remoteTransportFactory: () => {
            productionFactoryCalls += 1;
            throw new Error("production reached remote transport factory");
          },
        },
      );
      assert.equal(productionExit, 1);
      assert.equal(productionFactoryCalls, 0);

      // The flag without --bootstrap is an argument error, not a silent no-op.
      const bareFlagCapture = capture();
      const bareFlagExit = await runMigrationCli(
        ["--env", "staging", "--i-authorize-disposable-remote-bootstrap"],
        {
          ...bareFlagCapture.dependencies,
          root: fixture.root,
          environmentValidator: () => validatedTopology,
        },
      );
      assert.equal(bareFlagExit, 1);
      assert.equal(JSON.parse(bareFlagCapture.stderr.join("").trim()).code, "INVALID_ARGUMENT");
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
        const heldPipe = neverSettlingCancelPipe();
        let pipeReceiptIssued = false;
        const runningPipe = runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          timeoutMs: 10,
          termGraceMs: 1,
          killReapMs: 1,
          // Deliberately generous: if anything still awaited the never-settling
          // source hook, the receipt could only arrive when this bound expired.
          // A prompt receipt is therefore evidence that nothing depends on it.
          pipeDrainMs: 400,
          spawn() {
            return {
              pid: 42,
              exited: Promise.resolve(0),
              stderr: closedPipe(),
              stdout: heldPipe.stream,
            };
          },
          signalGroup(_child, signal) {
            pipeSignals.push(signal);
          },
          groupExists() {
            return false;
          },
        }).then((result) => {
          pipeReceiptIssued = true;
          return result;
        });

        // PLANTED: a real stream whose source `cancel` hook never settles.
        //
        // The previous version of this case used a hand-written reader and
        // called `finishCancellation()` before awaiting, which masked the hang:
        // the runner awaited cancellation unbounded, so a source that never
        // acknowledges withheld the receipt forever. Both halves are now fixed —
        // the wait is bounded, and the fixture is a stream the platform can
        // actually produce.
        const heldStartedAtMs = performance.now();
        const pipe = await runningPipe;
        const heldElapsedMs = performance.now() - heldStartedAtMs;
        assert.equal(pipeReceiptIssued, true, "a never-settling source cancel hung the run");
        // ONE window, not two. The first 400ms window is the legitimate drain
        // observation, which this parked stream cannot satisfy until cancel
        // closes it. What must not happen is a SECOND 400ms window spent
        // waiting on the never-settling source hook: cancellation is only
        // initiated, never awaited, so cleanup resolves on `done` alone.
        assert.ok(
          heldElapsedMs < 2 * 400,
          `the receipt waited ${Math.round(heldElapsedMs)}ms, i.e. a second window spent awaiting the source cancel`,
        );
        assert.equal(pipe.outcome, "pipe-drain-unproven");
        assert.deepEqual(pipeSignals, ["SIGTERM"]);
        // Causal, observable close: cancellation was initiated, the standard
        // fulfilled the parked read, the drain finalizer released the reader,
        // and no lock survives the bounded receipt. This is the handle-release
        // proof — not a bounded return alone.
        assert.equal(heldPipe.cancelCount, 1, "the held reader was never cancelled");
        // Cancellation is initiated exactly once — never retried — so a hostile
        // hook accumulates one reaction, not one per cleanup attempt.
        assert.equal(heldPipe.cancelCount, 1, "cancellation was initiated more than once");
        assert.equal(
          heldPipe.stream.locked,
          false,
          "a reader lock survived the bounded cleanup receipt",
        );

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
    name: "AbortSignal bounded-command cleanup is causal, contained, and ordered",
    async execute() {
      const bounds = {
        timeoutMs: 80,
        termGraceMs: 10,
        killReapMs: 10,
        pipeDrainMs: 10,
      };
      const platforms = [
        { platform: "linux", containmentScope: "process-group-only" },
        { platform: "win32", containmentScope: "direct-child-only" },
      ];
      const trackedAbort = () => {
        const controller = new AbortController();
        let added = 0;
        let removed = 0;
        return {
          controller,
          listenerCounts: () => ({ added, removed }),
          signal: {
            get aborted() {
              return controller.signal.aborted;
            },
            addEventListener(...args) {
              added += 1;
              controller.signal.addEventListener(...args);
            },
            removeEventListener(...args) {
              removed += 1;
              controller.signal.removeEventListener(...args);
            },
          },
        };
      };
      const assertBounded = (startedAt, label) => {
        assert.ok(
          performance.now() - startedAt < bounds.timeoutMs + bounds.termGraceMs + 100,
          `${label} exceeded its single command deadline plus bounded cleanup`,
        );
      };

      // A signal already aborted at entry must not even create the otherwise
      // detached child. This is distinct from a post-spawn abort, whose cleanup
      // obligation is established below.
      for (const { platform, containmentScope } of platforms) {
        const tracked = trackedAbort();
        tracked.controller.abort();
        let spawned = 0;
        const result = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          ...bounds,
          platform,
          signal: tracked.signal,
          spawn() {
            spawned += 1;
            assert.fail("a pre-aborted signal must refuse before spawn");
          },
        });
        assert.equal(spawned, 0);
        assert.equal(result.outcome, "aborted");
        assert.equal(result.containment_scope, containmentScope);
        assert.deepEqual(tracked.listenerCounts(), { added: 0, removed: 0 });
      }

      // TERM-responsive child: abort is reported only after both owned readers
      // were cancelled and the platform's honest containment scope has reaped.
      for (const { platform, containmentScope } of platforms) {
        const tracked = trackedAbort();
        const stdout = parkedPipe();
        const stderr = parkedPipe();
        const signals = [];
        let groupLive = true;
        let groupInspections = 0;
        let resolveExit;
        const started = performance.now();
        const result = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          ...bounds,
          platform,
          signal: tracked.signal,
          spawn() {
            const child = {
              pid: 61,
              exited: new Promise((resolve) => {
                resolveExit = resolve;
              }),
              stderr: stderr.stream,
              stdout: stdout.stream,
            };
            queueMicrotask(() => tracked.controller.abort());
            return child;
          },
          signalGroup(_child, signal) {
            signals.push(signal);
            if (signal === "SIGTERM") {
              groupLive = false;
              resolveExit(143);
            }
          },
          groupExists() {
            groupInspections += 1;
            return groupLive;
          },
        });
        assertBounded(started, `${platform} TERM-responsive abort`);
        assert.equal(result.outcome, "aborted");
        assert.equal(result.containment_scope, containmentScope);
        assert.deepEqual(signals, ["SIGTERM"]);
        assert.equal(stdout.cancelCount, 1);
        assert.equal(stderr.cancelCount, 1);
        assert.equal(stdout.stream.locked, false);
        assert.equal(stderr.stream.locked, false);
        assert.equal(groupInspections === 0, platform === "win32");
        assert.deepEqual(tracked.listenerCounts(), { added: 1, removed: 1 });
      }

      // The same injected child resists TERM. KILL is then the one and only
      // escalation, and its reaping proof permits the typed abort outcome.
      for (const { platform, containmentScope } of platforms) {
        const tracked = trackedAbort();
        const signals = [];
        let groupLive = true;
        let groupInspections = 0;
        let resolveExit;
        const started = performance.now();
        const result = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          ...bounds,
          platform,
          signal: tracked.signal,
          spawn() {
            const child = {
              pid: 62,
              exited: new Promise((resolve) => {
                resolveExit = resolve;
              }),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
            queueMicrotask(() => tracked.controller.abort());
            return child;
          },
          signalGroup(_child, signal) {
            signals.push(signal);
            if (signal === "SIGKILL") {
              groupLive = false;
              resolveExit(137);
            }
          },
          groupExists() {
            groupInspections += 1;
            return groupLive;
          },
        });
        assertBounded(started, `${platform} TERM-resistant abort`);
        assert.equal(result.outcome, "aborted");
        assert.equal(result.containment_scope, containmentScope);
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
        assert.equal(groupInspections === 0, platform === "win32");
        assert.deepEqual(tracked.listenerCounts(), { added: 1, removed: 1 });
      }

      // The direct wrapper exits before its descendant closes either inherited
      // pipe. Resolve that exit from the second parked read, then delay abort
      // by three microtasks: child exit reaction, first-race reaction, and the
      // exited-first continuation that begins pipe observation. An old
      // `if/else` skipped TERM/KILL here after `first` changed during that
      // observation, leaving the direct-exit descendant outside teardown.
      for (const directExitCase of [
        { label: "reaped", expectedOutcome: "aborted", groupNeverReaps: false },
        {
          label: "unreaped",
          expectedOutcome: "process-reap-unproven",
          groupNeverReaps: true,
        },
      ]) {
        const tracked = trackedAbort();
        const signals = [];
        let groupLive = true;
        let parkedPulls = 0;
        let resolveDirectExit;
        const releaseDirectExit = () => {
          if (++parkedPulls !== 2) return;
          resolveDirectExit(0);
          queueMicrotask(() => {
            queueMicrotask(() => {
              queueMicrotask(() => tracked.controller.abort());
            });
          });
        };
        const stdout = parkedPipe(releaseDirectExit);
        const stderr = parkedPipe(releaseDirectExit);
        const started = performance.now();
        const result = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          ...bounds,
          platform: "linux",
          signal: tracked.signal,
          spawn() {
            return {
              pid: 621,
              exited: new Promise((resolve) => {
                resolveDirectExit = resolve;
              }),
              stderr: stderr.stream,
              stdout: stdout.stream,
            };
          },
          signalGroup(_child, signal) {
            signals.push(signal);
            if (signal === "SIGKILL" && !directExitCase.groupNeverReaps) groupLive = false;
          },
          groupExists() {
            return groupLive;
          },
        });
        assertBounded(started, `direct-exit parked-descendant ${directExitCase.label}`);
        assert.equal(parkedPulls, 2, "both inherited pipes must park before direct exit");
        assert.equal(result.outcome, directExitCase.expectedOutcome);
        assert.equal(result.containment_scope, "process-group-only");
        assert.equal(result.exitCode, 0);
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
        assert.equal(stdout.cancelCount, 1);
        assert.equal(stderr.cancelCount, 1);
        assert.equal(stdout.stream.locked, false);
        assert.equal(stderr.stream.locked, false);
        assert.deepEqual(tracked.listenerCounts(), { added: 1, removed: 1 });
      }

      // Abort never claims success when the owned scope cannot be reaped. POSIX
      // and Windows deliberately report different, equally conservative facts.
      for (const { platform, containmentScope } of platforms) {
        const tracked = trackedAbort();
        const stdout = parkedPipe();
        const stderr = parkedPipe();
        const signals = [];
        let groupInspections = 0;
        const started = performance.now();
        const result = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          ...bounds,
          platform,
          signal: tracked.signal,
          spawn() {
            queueMicrotask(() => tracked.controller.abort());
            return {
              pid: 63,
              exited: new Promise(() => {}),
              stderr: stderr.stream,
              stdout: stdout.stream,
            };
          },
          signalGroup(_child, signal) {
            signals.push(signal);
          },
          groupExists() {
            groupInspections += 1;
            return true;
          },
        });
        assertBounded(started, `${platform} unreaped abort`);
        assert.equal(
          result.outcome,
          platform === "win32" ? "direct-child-reap-unproven" : "process-reap-unproven",
        );
        assert.equal(result.containment_scope, containmentScope);
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
        assert.equal(groupInspections === 0, platform === "win32");
        assert.equal(stdout.cancelCount, 1);
        assert.equal(stderr.cancelCount, 1);
        assert.equal(stdout.stream.locked, false);
        assert.equal(stderr.stream.locked, false);
        assert.deepEqual(tracked.listenerCounts(), { added: 1, removed: 1 });
      }

      // Timeout wins when the abort is triggered by its own cleanup signal;
      // abort wins when it is already observed after the child exists. Neither
      // ordering may start a second TERM/KILL sequence.
      for (const { platform, containmentScope } of platforms) {
        const timeoutTracked = trackedAbort();
        const timeoutSignals = [];
        let timeoutGroupLive = true;
        let resolveTimeoutExit;
        const timeoutResult = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          ...bounds,
          platform,
          signal: timeoutTracked.signal,
          spawn() {
            return {
              pid: 64,
              exited: new Promise((resolve) => {
                resolveTimeoutExit = resolve;
              }),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
          },
          signalGroup(_child, signal) {
            timeoutSignals.push(signal);
            if (signal === "SIGTERM") {
              timeoutTracked.controller.abort();
              timeoutGroupLive = false;
              resolveTimeoutExit(143);
            }
          },
          groupExists() {
            return timeoutGroupLive;
          },
        });
        assert.equal(timeoutResult.outcome, "timeout");
        assert.equal(timeoutResult.containment_scope, containmentScope);
        assert.deepEqual(timeoutSignals, ["SIGTERM"]);
        assert.deepEqual(timeoutTracked.listenerCounts(), { added: 1, removed: 1 });

        const abortTracked = trackedAbort();
        const abortSignals = [];
        let abortGroupLive = true;
        let resolveAbortExit;
        const abortResult = await runBoundedCommand({
          cmd: ["fixture"],
          cwd: repositoryRoot,
          ...bounds,
          platform,
          signal: abortTracked.signal,
          spawn() {
            const child = {
              pid: 65,
              exited: new Promise((resolve) => {
                resolveAbortExit = resolve;
              }),
              stderr: closedPipe(),
              stdout: closedPipe(),
            };
            abortTracked.controller.abort();
            return child;
          },
          signalGroup(_child, signal) {
            abortSignals.push(signal);
            if (signal === "SIGTERM") {
              abortGroupLive = false;
              resolveAbortExit(143);
            }
          },
          groupExists() {
            return abortGroupLive;
          },
        });
        assert.equal(abortResult.outcome, "aborted");
        assert.equal(abortResult.containment_scope, containmentScope);
        assert.deepEqual(abortSignals, ["SIGTERM"]);
        assert.deepEqual(abortTracked.listenerCounts(), { added: 1, removed: 1 });
      }
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
    // is monotonic and the abort signal is the cooperative half. A transport
    // that never settles has produced no containment observation at all, so it
    // receives neither the softer observation-deadline receipt nor a reap
    // classification it never earned: the refusal names the missing settlement.
    name: "PLANTED-a-never-settling-transport-is-bounded-cancelled-and-settlement-unproven",
    async execute() {
      const environment = stagingEnvironment();
      const stall = () => new Promise(() => {});

      for (const [label, options] of [
        ["describe", { onDescribe: stall }],
        ["query", { onQuery: stall }],
      ]) {
        const startedAtMs = performance.now();
        await expectAsyncFailure(label, "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN", () =>
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
      await expectAsyncFailure("cancelled", "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN", () =>
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
    // THE UNCONDITIONAL AWAIT IS A PRIVILEGE, AND IT MUST BE UNFORGEABLE.
    //
    // Awaiting an owned command's cleanup without a second timer is only safe
    // when THIS module guarantees the command settles. A public
    // `ownsBoundedCommand` property could be set by the caller, so a transport
    // could hand itself the unbounded path and then never settle — a hang
    // granted by a value the hanging party supplied. Provenance now lives in a
    // module-private WeakSet, so both plants below must remain bounded.
    name: "PLANTED-a-forged-owned-bounded-marker-buys-no-unbounded-await",
    async execute() {
      const environment = stagingEnvironment();

      // A hand-built transport asserting the old marker, which never settles.
      const forged = {
        ownsBoundedCommand: true,
        describeTarget: () => new Promise(() => {}),
        query: () => new Promise(() => {}),
      };
      const forgedStartedAtMs = performance.now();
      await expectAsyncFailure("forged-marker", "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN", () =>
        readRemoteLineageSnapshotOrRefuse(environment, forged, STAGING_DATABASE_ID, {
          deadlineMs: 120,
        }),
      );
      assert.ok(
        performance.now() - forgedStartedAtMs < 5_000,
        "a forged owned-bounded marker bought an unbounded await",
      );

      // The same forgery on the apply seam, which has its own capability gate.
      const forgedApply = {
        ownsBoundedCommand: true,
        atomicity: "d1-query-implicit-transaction-v1",
        describeTarget: () => new Promise(() => {}),
        query: () => new Promise(() => {}),
        execute: () => new Promise(() => {}),
      };
      const forgedApplyStartedAtMs = performance.now();
      await expectAsyncFailure(
        "forged-marker-apply",
        "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN",
        () =>
          applyPendingRemoteMigrationsOrRefuse(
            environment,
            forgedApply,
            STAGING_DATABASE_ID,
            [{ id: "0001_forged.sql", sequence: 1, digest: "a".repeat(64), sql: "SELECT 1;" }],
            "2026-08-17T00:00:00.000Z",
            { deadlineMs: 120 },
          ),
      );
      assert.ok(
        performance.now() - forgedApplyStartedAtMs < 5_000,
        "a forged owned-bounded marker bought an unbounded apply await",
      );
    },
  },
  {
    // The factory used to grant the privilege unconditionally, so an injected
    // `runCommand` inherited a guarantee this module never made about it. A
    // never-settling injected runner then hung the observation forever. The
    // grant is now conditioned on the factory using its own bounded runner.
    name: "PLANTED-a-factory-transport-with-an-injected-never-settling-runner-stays-bounded",
    async execute() {
      const environment = stagingEnvironment();
      const root = defaultRemoteTransportRoot("injected-never-settler");
      let runnerEntries = 0;
      const transport = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
        runCommand: () => {
          runnerEntries += 1;
          return new Promise(() => {});
        },
      });

      const startedAtMs = performance.now();
      await expectAsyncFailure(
        "injected-never-settler",
        "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN",
        () =>
          readRemoteLineageSnapshotOrRefuse(environment, transport, STAGING_DATABASE_ID, {
            deadlineMs: 120,
          }),
      );
      assert.ok(
        performance.now() - startedAtMs < 5_000,
        "an injected runner inherited the unconditional await and hung",
      );
      assert.equal(runnerEntries, 1, "the injected runner was not the thing that stalled");
    },
  },
  {
    // PRODUCTION-SHAPE CLEANUP EXHAUSTION.
    //
    // The rejected composition RACED the containment reserve against the owned
    // command, so the absolute timer could return SETTLEMENT_UNPROVEN — itself a
    // claim ABOUT cleanup — while a real `runBoundedCommand` was still
    // signalling and reaping its child.
    //
    // An injected promise that resolves on abort cannot expose that: it settles
    // instantly, so the race is never contested and the bug stays green. This
    // plant spends the real windows instead. The child installs a SIGTERM
    // listener that does not exit, so cleanup MUST escalate through the whole
    // composed path — TERM, grace, KILL, reap, drain — before the real runner
    // can settle.
    //
    // The assertion is an ORDERING, not a code: the outer refusal must not be
    // observable before the owned command has settled. That is the property a
    // deadline cannot buy, because once a child is running a timer can only stop
    // this process OBSERVING the cleanup; it cannot stop the cleanup.
    name: "PLANTED-an-owned-command-exhausting-real-cleanup-phases-settles-before-the-outer-refusal",
    async execute() {
      const environment = stagingEnvironment();
      const readyPath = join(space, "owned-default-ready");
      const termPath = join(space, "owned-default-term");
      const root = defaultRemoteTransportRoot(
        "owned-default-cleanup",
        STAGING_DATABASE_ID,
        `import { writeFileSync } from "node:fs";
const readyPath = ${JSON.stringify(readyPath)};
const termPath = ${JSON.stringify(termPath)};
const publish = (path) => {
  try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
};
process.on("SIGTERM", () => publish(termPath));
publish(readyPath);
await new Promise(() => {});
`,
      );
      const ownedTransport = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
      });

      // WeakSet provenance is safe only if this exact identity cannot have its
      // guaranteed methods replaced after branding.
      assert.equal(Object.isFrozen(ownedTransport), true);
      assert.throws(() =>
        Object.defineProperty(ownedTransport, "describeTarget", {
          value: () => new Promise(() => {}),
        }),
      );

      // Attach the rejection handler before the deliberate event-loop stall so
      // the losing-promise mutation cannot surface as an unhandled rejection.
      const observation = readRemoteLineageSnapshotOrRefuse(
        environment,
        ownedTransport,
        STAGING_DATABASE_ID,
        { deadlineMs: REMOTE_D1_COMMAND_WINDOW_MS + 1_000 },
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

      await waitForFixturePath(readyPath, 4_000, "default Wrangler readiness");
      await waitForFixturePath(termPath, 4_000, "default Wrangler TERM receipt");
      const childPid = Number(readFileSync(readyPath, "utf8"));
      assert.equal(Number.isSafeInteger(childPid) && childPid > 1, true);

      // Make the old absolute containment timer due while the real runner is
      // still between TERM and KILL. A Promise.race implementation returns as
      // soon as this stall ends; the fixed implementation resumes the runner,
      // sends KILL, reaps, and only then classifies the deadline.
      const stalledUntil = performance.now() + REMOTE_D1_CLEANUP_RESERVE_MS + 500;
      while (performance.now() < stalledUntil) {
        // Deliberately synchronous: this is the causal scheduler-delay plant.
      }

      const observed = await observation;
      assert.equal(Object.hasOwn(observed, "value"), false, "an aborted observation succeeded");
      assert.ok(observed.error instanceof MigrationError, `unexpected ${observed.error}`);
      assert.notEqual(
        observed.error.code,
        "REMOTE_D1_TRANSPORT_SETTLEMENT_UNPROVEN",
        "the outer call abandoned a real default command before cleanup settled",
      );
      assert.equal(observed.error.code, "REMOTE_OBSERVATION_DEADLINE_EXCEEDED");

      let childStillExists = true;
      try {
        process.kill(childPid, 0);
      } catch (error) {
        assert.equal(error?.code, "ESRCH");
        childStillExists = false;
      }
      assert.equal(
        childStillExists,
        false,
        "the default Wrangler child was not reaped before refusal",
      );
    },
  },
  {
    // The containment reserve exists so the outer observation never emits a
    // receipt while the owned command is still cleaning up. A reserve shorter
    // than the real composed path would look correct on every fast plant and
    // fail only against a command that actually spends its windows, so this
    // plant composes the real production windows end to end and asserts the
    // ordering directly: the receipt may not precede the command's settlement.
    // A budget is shared by describe plus every query. Earlier calls spend it,
    // so a later one can find too little left to both run and clean up. Starting
    // a real child there is unrecoverable: the outer expires, reports settlement
    // unproven, and the child keeps cleaning after the receipt. The only fix is
    // to refuse BEFORE the spawn, which is what this plant pins.
    name: "PLANTED-a-shared-budget-spent-by-earlier-calls-refuses-a-later-default-command-before-it-starts",
    async execute() {
      const environment = stagingEnvironment();
      const infoStartedPath = join(space, "shared-budget-info-started");
      const executeStartedPath = join(space, "shared-budget-execute-started");
      const spent = 600;
      const root = defaultRemoteTransportRoot(
        "shared-budget-default",
        STAGING_DATABASE_ID,
        `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const publish = (path) => writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
if (args.includes("info")) {
  publish(${JSON.stringify(infoStartedPath)});
  await Bun.sleep(${spent});
  writeFileSync(1, ${JSON.stringify(`${JSON.stringify({ uuid: STAGING_DATABASE_ID, name: STAGING_DATABASE_NAME, read_replication: { mode: "disabled" } })}\n`)});
} else {
  publish(${JSON.stringify(executeStartedPath)});
  writeFileSync(1, ${JSON.stringify(`${JSON.stringify([{ success: true, results: [], meta: { served_by_primary: true } }])}\n`)});
}
`,
      );
      const transport = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
      });

      await expectAsyncFailure(
        "exhausted shared budget",
        "REMOTE_D1_COMMAND_WINDOW_EXHAUSTED",
        () =>
          readRemoteLineageSnapshotOrRefuse(environment, transport, STAGING_DATABASE_ID, {
            deadlineMs: spent + REMOTE_D1_COMMAND_WINDOW_MS - 200,
          }),
      );
      assert.equal(existsSync(infoStartedPath), true, "the first default command never ran");
      assert.equal(
        existsSync(executeStartedPath),
        false,
        "a later default command was started without room to contain it",
      );
    },
  },
  {
    // The precheck and the deferred invocation are separated by a microtask
    // checkpoint. The engine drains the whole microtask queue, running each job
    // to completion, before any timer fires — so a job queued ahead of the
    // invocation callback can burn the window after the precheck already passed.
    // Neither the abort controller (macrotask) nor `runBoundedCommand` (no
    // zero-timeout guard) would stop the spawn, so only a recheck inside the
    // callback closes it.
    name: "PLANTED-a-microtask-that-burns-the-window-after-the-precheck-still-never-enters-the-runner",
    async execute() {
      const environment = stagingEnvironment();
      const spawnedPath = join(space, "post-precheck-default-spawned");
      const root = defaultRemoteTransportRoot(
        "post-precheck-default",
        STAGING_DATABASE_ID,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(spawnedPath)}, String(process.pid), { flag: "wx", mode: 0o600 });
writeFileSync(1, ${JSON.stringify(`${JSON.stringify({ uuid: STAGING_DATABASE_ID, name: STAGING_DATABASE_NAME, read_replication: { mode: "disabled" } })}\n`)});
`,
      );
      const transport = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
      });

      // Queued BEFORE the synchronous entry, so the ordering is deterministic
      // rather than a race: the runner's precheck and its callback enqueue both
      // happen synchronously first, then this job runs, then the callback.
      const burnMs = 400;
      queueMicrotask(() => {
        const until = performance.now() + burnMs;
        while (performance.now() < until) {
          // Deliberately blocking: a microtask cannot be pre-empted, which is
          // precisely why the precheck alone is not sufficient.
        }
      });

      let captured;
      try {
        await readRemoteLineageSnapshotOrRefuse(environment, transport, STAGING_DATABASE_ID, {
          // Passes the precheck with room to spare, and cannot survive the burn.
          deadlineMs: REMOTE_D1_COMMAND_WINDOW_MS + 200,
        });
        assert.fail("a command was started after its window was consumed");
      } catch (error) {
        captured = error;
      }
      assert.ok(captured instanceof MigrationError, `unexpected ${captured}`);
      assert.equal(captured.code, "REMOTE_D1_COMMAND_WINDOW_EXHAUSTED");
      // The message distinguishes the in-callback recheck from the outer
      // precheck, so this cannot pass by accidentally exercising the old path.
      assert.match(captured.message, /before the transport was entered/);
      assert.equal(
        existsSync(spawnedPath),
        false,
        "the default runner spawned after its containable window was consumed",
      );
    },
  },
  {
    // The composed windows are lower bounds, so the reserve must also carry the
    // scheduling margin. If the margin were added only to the pre-start check,
    // execution would be free to spend it and cleanup would run with none.
    name: "PLANTED-the-scheduling-margin-is-withheld-from-execution-not-spent-by-it",
    async execute() {
      const deadlineMs = REMOTE_D1_COMMAND_WINDOW_MS + 1_000;
      const allocation = remoteExecutionAllocation(deadlineMs, true);

      // The execution share may never reach into the reserved tail. Allocating
      // the margin to execution would push this above the bound and fail here.
      assert.deepEqual(
        allocation,
        {
          containmentReserveMs: REMOTE_D1_CLEANUP_RESERVE_MS,
          executionMs: deadlineMs - REMOTE_D1_CLEANUP_RESERVE_MS,
        },
        "the owned allocation did not withhold the exact cleanup reserve",
      );
      // ...and the floor is genuinely available, so the bound is not vacuous.
      assert.ok(
        allocation.executionMs >= REMOTE_D1_EXECUTION_FLOOR_MS,
        `execution share ${allocation.executionMs}ms is below the promised floor`,
      );
      assert.equal(
        remoteExecutionAllocation(deadlineMs, false).containmentReserveMs,
        Math.floor(deadlineMs / 2),
        "an injected transport accidentally inherited the owned cleanup reserve",
      );

      const source = readFileSync(new URL("./migrate.mjs", import.meta.url), "utf8");
      assert.equal(
        source.split("const allocation = remoteExecutionAllocation(remaining, ownsBoundedCommand);")
          .length - 1,
        1,
        "the runtime stopped consuming the tested allocation seam",
      );
    },
  },
  {
    name: "PLANTED-the-reserve-covers-the-real-composed-cleanup-and-no-receipt-precedes-settlement",
    async execute() {
      const environment = stagingEnvironment();

      // Window-by-window, exactly what an aborted `runBoundedCommand` spends:
      // TERM grace, SIGKILL reap, termination drain, post-termination
      // `child.exited`, and the final pipe settlement.
      // Composition, not a magic number: retuning any window must move the
      // reserve with it, and a literal would silently decouple the two.
      assert.equal(
        REMOTE_D1_CONTAINMENT_RESERVE_MS,
        LOCAL_D1_TERM_GRACE_MS + LOCAL_D1_KILL_REAP_MS * 3 + LOCAL_D1_PIPE_DRAIN_MS * 2,
        "the reserve no longer matches the composed cleanup path",
      );
      // Six windows, not five: the bounded cancellation wait is the sixth and is
      // reachable from both the failed-drain and settled-drain non-exit tails.
      assert.equal(
        REMOTE_D1_CONTAINMENT_RESERVE_MS,
        LOCAL_D1_TERM_GRACE_MS +
          LOCAL_D1_KILL_REAP_MS + // TERM grace, then SIGKILL reap
          LOCAL_D1_KILL_REAP_MS + // termination drain
          LOCAL_D1_KILL_REAP_MS + // post-termination child.exited
          LOCAL_D1_PIPE_DRAIN_MS + // final drain observation
          LOCAL_D1_PIPE_DRAIN_MS, // bounded cancellation settlement
        "the reserve does not count all six post-abort waits",
      );
      // The margin belongs to cleanup, and the floor is required on top of it.
      assert.equal(
        REMOTE_D1_CLEANUP_RESERVE_MS,
        REMOTE_D1_CONTAINMENT_RESERVE_MS + REMOTE_D1_SCHEDULING_MARGIN_MS,
        "the scheduling margin is not withheld inside the cleanup tail",
      );
      assert.equal(
        REMOTE_D1_COMMAND_WINDOW_MS,
        REMOTE_D1_CLEANUP_RESERVE_MS + REMOTE_D1_EXECUTION_FLOOR_MS,
        "the start window does not require an execution floor above the cleanup tail",
      );
      assert.ok(REMOTE_D1_SCHEDULING_MARGIN_MS > 0 && REMOTE_D1_EXECUTION_FLOOR_MS > 0);

      // Half the deadline must be at least the full reserve, otherwise the
      // observation tightens it and this plant would not exhaust the real path.
      const deadlineMs = REMOTE_D1_CONTAINMENT_RESERVE_MS * 2;
      // Settle inside the reserve but after the whole composed path would have
      // begun: the command ignores cancellation until its cleanup budget is
      // nearly spent, which is precisely the case a 2s reserve truncated.
      const settleAfterAbortMs = REMOTE_D1_CONTAINMENT_RESERVE_MS - 100;

      let abortedAtMs;
      let settledAtMs;
      let receiptAtMs;
      let captured;
      try {
        await readRemoteLineageSnapshotOrRefuse(
          environment,
          recordingTransport({
            onDescribe: (request) =>
              new Promise((resolve) => {
                request.signal.addEventListener("abort", () => {
                  abortedAtMs = performance.now();
                  const timer = setTimeout(() => {
                    settledAtMs = performance.now();
                    // A value returned after abort proves nothing about
                    // containment; the outer must still refuse. What this
                    // plant fixes in place is the ORDER of that refusal.
                    resolve({ result: [] });
                  }, settleAfterAbortMs);
                  timer.unref?.();
                });
              }),
          }),
          STAGING_DATABASE_ID,
          { deadlineMs },
        );
        assert.fail("composed cleanup: expected REMOTE_D1_TRANSPORT_REAP_UNPROVEN");
      } catch (error) {
        receiptAtMs = performance.now();
        captured = error;
      }
      assert.ok(captured instanceof MigrationError, `composed cleanup: unexpected ${captured}`);
      assert.equal(captured.code, "REMOTE_D1_TRANSPORT_REAP_UNPROVEN", captured.message);

      assert.ok(abortedAtMs !== undefined, "the command was never cancelled");
      assert.ok(settledAtMs !== undefined, "the receipt was emitted before the command settled");
      assert.ok(
        receiptAtMs >= settledAtMs,
        "a remote receipt preceded command settlement inside the reserve",
      );
      // The reserve was genuinely exercised, not skipped by an early return.
      assert.ok(
        settledAtMs - abortedAtMs >= settleAfterAbortMs - 50,
        "the composed cleanup window was not actually spent",
      );
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
  {
    name: "PLANTED-default-Wrangler-commands-capture-account-and-UUID-before-a-resolved-config-rewrite",
    async execute() {
      const environment = stagingEnvironment();
      const root = defaultRemoteTransportRoot("default-remote-transport");
      const commands = [];
      const resolvedConfig = join(root, "infra", "deploy-resolved", "staging.wrangler.toml");
      let rewroteResolvedConfig = false;
      const transport = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
        runCommand: async (command) => {
          commands.push(command);
          if (command.cmd.includes("info")) {
            // Causal race: another resolver rewrites the shared artifact between
            // the identity operation and the next Wrangler child. The command
            // must retain its captured account and UUID, never name this path.
            writeFileSync(
              resolvedConfig,
              `account_id = "${OTHER_ACCOUNT_ID}"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "other-database"\ndatabase_id = "${OTHER_DATABASE_ID}"\n`,
              "utf8",
            );
            rewroteResolvedConfig = true;
          }
          return command.cmd.includes("info")
            ? successfulRemoteInfo()
            : successfulRemoteCommand([]);
        },
      });

      const snapshot = await readRemoteLineageSnapshotOrRefuse(
        environment,
        transport,
        STAGING_DATABASE_ID,
      );
      assert.deepEqual(snapshot.catalog, []);
      assert.equal(commands.length, 2, "identity plus an empty catalog require two remote calls");
      const [identity, command] = commands;
      assert.ok(identity.cmd.includes("info"));
      assert.ok(identity.cmd.includes(STAGING_DATABASE_ID));
      assert.ok(command.cmd.includes("--remote"));
      assert.ok(
        command.cmd.includes(STAGING_DATABASE_ID),
        "the resolved UUID is not the command target",
      );
      assert.equal(rewroteResolvedConfig, true, "the config-rewrite plant never ran");
      for (const request of commands) {
        const configFlag = request.cmd.indexOf("--config");
        assert.notEqual(configFlag, -1, "the child was allowed to discover workspace config");
        assert.equal(
          request.cmd[configFlag + 1],
          "/dev/null",
          "a child received the mutable resolved config path",
        );
        assert.equal(
          request.cwd,
          root,
          "the explicit immutable config must make the workspace cwd irrelevant",
        );
        assert.equal(
          request.toolEnvironment.CLOUDFLARE_ACCOUNT_ID,
          STAGING_ACCOUNT_ID,
          "a config rewrite or ambient account altered captured child authority",
        );
      }
      assert.equal(command.cmd.includes("--file"), false, "no file-import atomicity claim is used");
      assert.equal(command.cmd.at(-1).trimStart().startsWith("SELECT"), true);
      assert.equal(command.timeoutMs > 0, true, "the shared remaining deadline was not passed");
      assert.equal(command.stdoutMaxBytes, REMOTE_D1_STDOUT_MAX_BYTES);
      assert.equal(
        Object.keys(command.toolEnvironment).every((key) =>
          [
            "LANG",
            "LC_ALL",
            "PATH",
            "TZ",
            "SystemRoot",
            "HOME",
            "USERPROFILE",
            "XDG_CONFIG_HOME",
            "CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_ACCOUNT_ID",
          ].includes(key),
        ),
        true,
        "the default remote transport inherited an ambient environment variable",
      );

      // Subsequent independent plants need a valid construction artifact; the
      // race proof above has already captured and inspected its rewritten bytes.
      writeFileSync(
        resolvedConfig,
        `account_id = "${STAGING_ACCOUNT_ID}"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${STAGING_DATABASE_NAME}"\ndatabase_id = "${STAGING_DATABASE_ID}"\n`,
        "utf8",
      );

      // The exact same injected runner must remain untouched for an unresolved
      // id; this proves target validation precedes config and command setup.
      let unreachable = 0;
      expectFailure("unresolved-default-id", "REMOTE_TARGET_ID_UNRESOLVED", () =>
        createWranglerRemoteTransport({
          root,
          environmentName: "staging",
          environment,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the unexpanded CI placeholder from environments.toml, asserted verbatim as an id that must be refused; interpolating it would delete the case.
          resolvedDatabaseId: "${ASIMP_D1_DATABASE_ID_STAGING}",
          runCommand: async () => {
            unreachable += 1;
            return successfulRemoteCommand([]);
          },
        }),
      );
      assert.equal(unreachable, 0);

      const replica = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
        runCommand: async (request) =>
          request.cmd.includes("info")
            ? successfulRemoteInfo()
            : {
                ...successfulRemoteCommand([]),
                stdout: JSON.stringify([
                  { success: true, results: [], meta: { served_by_primary: false } },
                ]),
              },
      });
      await expectAsyncFailure("replica-read", "REMOTE_D1_CATALOG_UNREADABLE", () =>
        readRemoteLineageSnapshotOrRefuse(environment, replica, STAGING_DATABASE_ID),
      );
      await expectAsyncFailure("replica-apply", "REMOTE_D1_REPLICA_REFUSED", () =>
        replica.execute({
          sql: "CREATE TABLE remote_apply_replica_fixture (id TEXT PRIMARY KEY);",
          database_id: STAGING_DATABASE_ID,
          signal: new AbortController().signal,
          timeoutMs: 100,
        }),
      );

      // The injected command runner is a trust boundary too. Required fields
      // must be own data properties, not inherited values or getters.
      const inheritedResult = Object.create({
        outcome: "exited",
        exitCode: 0,
        stdout: JSON.stringify([{ success: true, results: [], meta: { served_by_primary: true } }]),
      });
      const inherited = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
        runCommand: async () => inheritedResult,
      });
      await expectAsyncFailure("inherited-command-result", "REMOTE_D1_TRANSPORT_FAILED", () =>
        inherited.query({
          sql: "SELECT 1;",
          database_id: STAGING_DATABASE_ID,
          signal: new AbortController().signal,
          timeoutMs: 100,
        }),
      );

      const accessorResult = { exitCode: 0, stdout: "{}" };
      Object.defineProperty(accessorResult, "outcome", {
        get() {
          return "exited";
        },
      });
      const accessor = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
        runCommand: async () => accessorResult,
      });
      await expectAsyncFailure("accessor-command-result", "REMOTE_D1_TRANSPORT_FAILED", () =>
        accessor.query({
          sql: "SELECT 1;",
          database_id: STAGING_DATABASE_ID,
          signal: new AbortController().signal,
          timeoutMs: 100,
        }),
      );
    },
  },
  {
    name: "PLANTED-default-Wrangler-transport-hides-provider-output-and-cancels-the-owned-command",
    async execute() {
      const environment = stagingEnvironment();
      const root = defaultRemoteTransportRoot("default-remote-transport-diagnostics");
      const secret = "asimp_ag_LIVEabc123XYZdefg456";
      const absolute = "/Users/planted-operator/.cloudflare/credentials";
      const failed = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
        runCommand: async () => ({
          outcome: "exited",
          exitCode: 1,
          stdout: `${secret} ${absolute}`,
          stderr: `${secret} ${absolute}`,
        }),
      });
      let received;
      try {
        await failed.query({
          sql: "SELECT 1;",
          database_id: STAGING_DATABASE_ID,
          signal: new AbortController().signal,
          timeoutMs: 100,
        });
        assert.fail("failed command was accepted");
      } catch (error) {
        received = error;
      }
      assert.ok(received instanceof MigrationError);
      assert.equal(received.code, "REMOTE_D1_TRANSPORT_FAILED");
      assert.equal(received.message.includes(secret), false);
      assert.equal(received.message.includes("planted-operator"), false);

      let abortSignal;
      const stalled = createWranglerRemoteTransport({
        root,
        environmentName: "staging",
        environment,
        resolvedDatabaseId: STAGING_DATABASE_ID,
        runCommand: ({ signal }) =>
          new Promise((resolve) => {
            abortSignal = signal;
            signal.addEventListener(
              "abort",
              () => resolve({ outcome: "aborted", stdout: "", stderr: "" }),
              { once: true },
            );
          }),
      });
      await expectAsyncFailure(
        "default-command-timeout",
        "REMOTE_OBSERVATION_DEADLINE_EXCEEDED",
        () =>
          readRemoteLineageSnapshotOrRefuse(environment, stalled, STAGING_DATABASE_ID, {
            // A command-backed transport is refused before it starts unless the
            // whole start window remains, so this case must supply one to reach
            // the timeout path it is actually about. Composed, never a literal.
            deadlineMs: REMOTE_D1_COMMAND_WINDOW_MS + 100,
          }),
      );
      assert.ok(abortSignal !== undefined, "the owned command did not receive an abort signal");
      assert.equal(abortSignal.aborted, true, "the owned command was not cancelled");
      // `runBoundedCommand` has separate POSIX/Windows plants above that prove
      // the signal reaps its owned child/process group before it reports
      // `aborted`; this transport maps that proven outcome to a fixed refusal.
    },
  },
  {
    // This composes the default transport with the actual bounded command runner
    // and deliberately held pipes. It is not an injected runner that reports
    // `aborted` immediately when its signal flips: only `runBoundedCommand` can
    // release the readers and establish (or refuse) owned-group containment.
    name: "PLANTED-default-runner-timeout-reaps-held-pipes-before-the-observation-deadline-receipt",
    async execute() {
      const environment = stagingEnvironment();
      const root = defaultRemoteTransportRoot("default-runner-timeout-composition");
      for (const [label, groupNeverReaps, expectedCode] of [
        ["reaped", false, "REMOTE_OBSERVATION_DEADLINE_EXCEEDED"],
        ["unreaped", true, "REMOTE_D1_TRANSPORT_REAP_UNPROVEN"],
      ]) {
        const stdout = parkedPipe();
        const stderr = parkedPipe();
        const signals = [];
        let groupLive = true;
        let resolveExit;
        let cleanupObservedBeforeReceipt = false;
        const transport = createWranglerRemoteTransport({
          root,
          environmentName: "staging",
          environment,
          resolvedDatabaseId: STAGING_DATABASE_ID,
          runCommand: (request) =>
            runBoundedCommand({
              ...request,
              termGraceMs: 1,
              killReapMs: 1,
              pipeDrainMs: 1,
              spawn() {
                return {
                  pid: groupNeverReaps ? 78 : 77,
                  exited: new Promise((resolve) => {
                    resolveExit = resolve;
                  }),
                  stderr: stderr.stream,
                  stdout: stdout.stream,
                };
              },
              signalGroup(_child, signal) {
                signals.push(signal);
                if (signal === "SIGTERM" && !groupNeverReaps) {
                  groupLive = false;
                  resolveExit(143);
                }
              },
              groupExists() {
                return groupLive;
              },
            }).then((result) => {
              cleanupObservedBeforeReceipt =
                stdout.cancelCount === 1 &&
                stderr.cancelCount === 1 &&
                stdout.stream.locked === false &&
                stderr.stream.locked === false;
              return result;
            }),
        });

        await expectAsyncFailure(label, expectedCode, () =>
          readRemoteLineageSnapshotOrRefuse(environment, transport, STAGING_DATABASE_ID, {
            // Enough room for the actual runner's owned-reader cancellation
            // and process-group census, while the command still has no route
            // to a real provider. A command-backed transport is refused before
            // it starts unless the whole start window remains, so this is
            // composed from that window rather than an independent literal.
            deadlineMs: REMOTE_D1_COMMAND_WINDOW_MS + 100,
          }),
        );
        assert.ok(signals.includes("SIGTERM"), `${label}: default runner never began containment`);
        assert.equal(stdout.cancelCount, 1, `${label}: stdout reader was not cancelled`);
        assert.equal(stderr.cancelCount, 1, `${label}: stderr reader was not cancelled`);
        assert.equal(stdout.stream.locked, false, `${label}: stdout remained locked`);
        assert.equal(stderr.stream.locked, false, `${label}: stderr remained locked`);
        assert.equal(
          cleanupObservedBeforeReceipt,
          true,
          `${label}: observation receipt preceded bounded default-runner cleanup`,
        );
        if (groupNeverReaps) assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      }
    },
  },
  {
    name: "PLANTED-remote-apply-is-forward-only-transaction-capability-gated-and-records-the-journal-in-the-same-command",
    async execute() {
      const environment = stagingEnvironment();
      const migration = {
        id: "0017_remote_forward_fixture.sql",
        sequence: 17,
        sql: "CREATE TABLE remote_forward_fixture (id TEXT PRIMARY KEY);\n",
        digest: digestOf("CREATE TABLE remote_forward_fixture (id TEXT PRIMARY KEY);\n"),
      };
      const transport = recordingRemoteApplyTransport();
      const applied = await applyPendingRemoteMigrationsOrRefuse(
        environment,
        transport,
        STAGING_DATABASE_ID,
        [migration],
        "2026-08-17T00:00:00.000Z",
      );
      assert.deepEqual(applied, [{ id: migration.id, digest: migration.digest }]);
      assert.equal(transport.executions.length, 1);
      const sql = transport.executions[0].sql;
      assert.ok(sql.includes(migration.sql.trim()));
      assert.ok(sql.includes("INSERT INTO _asimposium_migrations"));
      assert.equal(transport.executions[0].database_id, STAGING_DATABASE_ID);

      const unsupported = recordingTransport();
      await expectAsyncFailure("unsupported-atomicity", "REMOTE_APPLY_ATOMICITY_UNSUPPORTED", () =>
        applyPendingRemoteMigrationsOrRefuse(
          environment,
          unsupported,
          STAGING_DATABASE_ID,
          [migration],
          "2026-08-17T00:00:00.000Z",
        ),
      );
      assert.equal(unsupported.calls.describe, 0);
      assert.equal(unsupported.calls.query, 0);

      const productionDirect = recordingRemoteApplyTransport();
      await expectAsyncFailure("production-direct", "REMOTE_APPLY_PRODUCTION_REFUSED", () =>
        applyPendingRemoteMigrationsOrRefuse(
          { ...environment, is_preview: false, may_hold_production_keys: true },
          productionDirect,
          STAGING_DATABASE_ID,
          [migration],
          "2026-08-17T00:00:00.000Z",
        ),
      );
      assert.equal(productionDirect.executions.length, 0);
    },
  },
  {
    name: "PLANTED-CLI-remote-observation-is-read-only-and-refuses-unresolved-production-and-unknown-targets-before-apply",
    async execute() {
      const capture = () => {
        const stdout = [];
        const stderr = [];
        return {
          stdout,
          stderr,
          dependencies: {
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line),
            now: () => "2026-08-17T00:00:00.000Z",
          },
        };
      };

      // These are actual argv runs through the CLI orchestration, not direct
      // parser calls. If either missing operand were silently stored as
      // `undefined`, the local path would reach this injected runner before it
      // could refuse; all three counters therefore prove no read, bootstrap, or
      // apply seam was touched.
      for (const flag of ["--state-file", "--bootstrap"]) {
        const missingOperand = capture();
        const localCalls = { read: 0, bootstrap: 0, apply: 0 };
        const exit = await runMigrationCli(["--env", "local", "--apply", flag], {
          ...missingOperand.dependencies,
          localReadLineageSnapshot: async () => {
            localCalls.read += 1;
            throw new Error("missing operand reached local snapshot runner");
          },
          localBootstrapSchema: async () => {
            localCalls.bootstrap += 1;
            throw new Error("missing operand reached local bootstrap runner");
          },
          localApplyMigration: async () => {
            localCalls.apply += 1;
            throw new Error("missing operand reached local apply runner");
          },
        });
        assert.equal(exit, 1, `${flag} must refuse`);
        assert.equal(JSON.parse(missingOperand.stderr.join("").trim()).code, "INVALID_ARGUMENT");
        assert.deepEqual(localCalls, { read: 0, bootstrap: 0, apply: 0 });
      }

      const successful = capture();
      const observer = recordingTransport({ catalog: [] });
      let factoryCalls = 0;
      const planExit = await runMigrationCli(
        ["--env", "staging", "--resolved-database-id", STAGING_DATABASE_ID],
        {
          ...successful.dependencies,
          remoteTransportFactory: (request) => {
            factoryCalls += 1;
            assert.equal(request.resolvedDatabaseId, STAGING_DATABASE_ID);
            return observer;
          },
        },
      );
      // A truly pristine remote target is deliberately not an implicit historic
      // install: current 0010 is marked destructive and its historical byte
      // lacks the required marker. The relevant CLI property here is that it
      // reached the real remote-observation/planner route using SELECTs only,
      // then refused before any execute transport existed.
      assert.equal(planExit, 1);
      assert.equal(factoryCalls, 1);
      assert.equal(successful.stdout.length, 0);
      const planDiagnostic = JSON.parse(successful.stderr.join("").trim());
      assert.equal(planDiagnostic.phase, "plan");
      assert.equal(planDiagnostic.code, "UNDECLARED_DESTRUCTIVE_MIGRATION");
      assert.ok(observer.statements.length >= 1);
      for (const statement of observer.statements) assertReadOnlySql(statement);

      // This is the complete remote CLI apply route, using current 0001-0016
      // bytes under a temporary fixture root and an inert stateful transport.
      // The production topology is validated from the real workspace; the
      // fixture supplies only a small catalog whose exact head digests are
      // pinned in its manifest. No network, Wrangler child, or D1 is opened.
      const applyFixture = remoteCliApplyFixtureRoot("remote-cli-apply");
      const journal = applyFixture.migrations.slice(0, 15).map(record);
      const catalog = [...applyFixture.beforeCatalog];
      let remoteFactoryCalls = 0;
      let executeCalls = 0;
      let executeRequest;
      // `capture()` pins the CLI clock, so the command the CLI must send is a
      // fixed byte string rather than a shape. Comparing against it is the whole
      // point of this fake: a fake that mutates its catalog and journal for
      // whatever SQL it receives proves the CLI called something, not that the
      // CLI sent the migration. Substring checks have the same hole, because
      // they pass for a command carrying extra statements around the real ones.
      const FIXED_APPLIED_AT = "2026-08-17T00:00:00.000Z";
      const expectedApplySql = migrationCommandSql(applyFixture.forward, FIXED_APPLIED_AT);
      let executeMutations = 0;
      // The guard is a named seam so the planted negatives below can exercise
      // the exact comparison the successful run depends on.
      const applyExecuteGuard = (request) => {
        if (request.sql !== expectedApplySql) {
          throw new Error("REMOTE_CLI_APPLY_SQL_MISMATCH");
        }
        executeMutations += 1;
        catalog.splice(0, catalog.length, ...applyFixture.afterCatalog);
        journal.push(record(applyFixture.forward));
        return { database_id: STAGING_DATABASE_ID };
      };
      const applyTransport = recordingRemoteApplyTransport({
        catalog,
        journal,
        onExecute(request) {
          executeCalls += 1;
          executeRequest = request;
          // Strict equality is checked before any state moves: a mismatched
          // command must leave the catalog and journal exactly as they were.
          return applyExecuteGuard(request);
        },
      });
      const applyCapture = capture();
      const validatedTopology = validateEnvironments(repositoryRoot);
      const applyExit = await runMigrationCli(
        ["--env", "staging", "--resolved-database-id", STAGING_DATABASE_ID, "--apply"],
        {
          ...applyCapture.dependencies,
          root: applyFixture.root,
          environmentValidator: () => validatedTopology,
          remoteTransportFactory(request) {
            remoteFactoryCalls += 1;
            assert.equal(request.root, applyFixture.root);
            assert.equal(request.environmentName, "staging");
            assert.equal(request.resolvedDatabaseId, STAGING_DATABASE_ID);
            return applyTransport;
          },
        },
      );
      assert.equal(applyExit, 0, applyCapture.stderr.join(""));
      assert.equal(applyCapture.stderr.length, 0);
      const applyReceipt = JSON.parse(applyCapture.stdout.join("").trim());
      assert.equal(applyReceipt.phase, "apply");
      assert.equal(applyReceipt.environment, "staging");
      assert.equal(applyReceipt.resolved_database_id, STAGING_DATABASE_ID);
      assert.equal(applyReceipt.head_before, 15);
      assert.deepEqual(applyReceipt.applied, [
        { id: applyFixture.forward.id, digest: applyFixture.forward.digest },
      ]);
      assert.equal(applyReceipt.second_plan_idempotent, true);
      assert.equal(remoteFactoryCalls, 1);
      assert.equal(executeCalls, 1);
      assert.equal(executeRequest.database_id, STAGING_DATABASE_ID);
      assert.equal(
        executeRequest.sql,
        expectedApplySql,
        "the CLI apply command was not byte-equal to migrationCommandSql(forward, fixedAppliedAt)",
      );
      assert.equal(
        executeMutations,
        1,
        "the apply fake mutated state exactly once, after the check",
      );
      // One describe/catalog/journal observation occurs before apply and a
      // second occurs afterwards. The receipt must therefore follow an actual
      // reclassification of the state the execute seam just mutated.
      assert.equal(applyTransport.calls.describe, 2);
      assert.ok(applyTransport.calls.query >= 4);
      assert.deepEqual(journal, applyFixture.migrations.map(record));
      assert.deepEqual(catalog, applyFixture.afterCatalog);

      // INDEPENDENT ORACLE: the equality above compares the CLI against
      // `migrationCommandSql`, so it pins the caller but not the helper — a
      // format change inside the helper moves both sides together and stays
      // invisible. These bytes are written out by hand instead: a planted
      // migration with fixed inputs, and the exact command it must produce,
      // including the journal column order and every literal. Derived from the
      // contract, never from the function under test.
      const plantedOracleMigration = {
        id: "0001_planted_oracle.sql",
        sequence: 1,
        digest: "a".repeat(64),
        sql: "CREATE TABLE planted_oracle (id TEXT);",
      };
      const plantedOracleSql =
        "CREATE TABLE planted_oracle (id TEXT);\n" +
        "INSERT INTO _asimposium_migrations (id, sequence, digest, applied_at) VALUES " +
        `('0001_planted_oracle.sql', 1, '${"a".repeat(64)}', '${FIXED_APPLIED_AT}');`;
      // A golden digest of those exact bytes, so a whitespace or ordering drift
      // that survives a careless edit to the literal above still fails here.
      const PLANTED_ORACLE_SHA256 =
        "80694c32f32ef98d04365ff9405bb9f2098a299005b7e02439d83993febf8cfc";
      assert.equal(digestOf(plantedOracleSql), PLANTED_ORACLE_SHA256);
      assert.equal(
        migrationCommandSql(plantedOracleMigration, FIXED_APPLIED_AT),
        plantedOracleSql,
        "migrationCommandSql no longer produces the pinned canonical command bytes",
      );
      // The oracle is discriminating: appending a statement or moving a byte
      // must break it, exactly as it must break the CLI comparison above.
      assert.notEqual(digestOf(`${plantedOracleSql}\nSELECT 1;`), PLANTED_ORACLE_SHA256);
      assert.notEqual(
        digestOf(plantedOracleSql.replace("planted_oracle (id TEXT)", "planted_oracle (id TEXTX)")),
        PLANTED_ORACLE_SHA256,
      );

      // PLANTED NEGATIVES: the equality above must be capable of failing, and it
      // must fail before the fake moves any state. Without these, a guard that
      // accepted anything would look identical on a green run.
      const forwardDigest = applyFixture.forward.digest;
      const flippedDigest = `${forwardDigest.slice(0, -1)}${forwardDigest.endsWith("0") ? "1" : "0"}`;
      for (const [label, tamperedSql] of [
        // Exactly one byte changed, inside the digest this command records in the
        // ledger: the shape is identical and only the recorded fact differs.
        ["changed byte", expectedApplySql.replace(forwardDigest, flippedDigest)],
        // The exact expected command plus one appended statement: this is the
        // case every substring assertion accepts.
        ["appended extra statement", `${expectedApplySql}\nSELECT 1;`],
      ]) {
        const journalBefore = [...journal];
        const catalogBefore = [...catalog];
        const mutationsBefore = executeMutations;
        assert.notEqual(tamperedSql, expectedApplySql, `${label} plant was not actually tampered`);
        assert.throws(
          () => applyExecuteGuard({ database_id: STAGING_DATABASE_ID, sql: tamperedSql }),
          /REMOTE_CLI_APPLY_SQL_MISMATCH/,
          `${label} was accepted by the apply guard`,
        );
        assert.equal(executeMutations, mutationsBefore, `${label} moved the mutation counter`);
        assert.deepEqual(journal, journalBefore, `${label} appended to the journal`);
        assert.deepEqual(catalog, catalogBefore, `${label} rewrote the catalog`);
      }
      // The guard still accepts the exact command, so the negatives above proved
      // discrimination rather than a permanently closed door.
      assert.equal(executeMutations, 1);

      const idempotentCapture = capture();
      const idempotentExit = await runMigrationCli(
        ["--env", "staging", "--resolved-database-id", STAGING_DATABASE_ID],
        {
          ...idempotentCapture.dependencies,
          root: applyFixture.root,
          environmentValidator: () => validatedTopology,
          remoteTransportFactory: () => applyTransport,
        },
      );
      assert.equal(idempotentExit, 0);
      assert.equal(idempotentCapture.stderr.length, 0);
      const secondReceipt = JSON.parse(idempotentCapture.stdout.join("").trim());
      assert.equal(secondReceipt.phase, "plan");
      assert.equal(secondReceipt.idempotent, true);
      assert.deepEqual(secondReceipt.to_apply, []);
      assert.equal(executeCalls, 1, "the second CLI plan must remain read-only");

      const unresolved = capture();
      let unresolvedFactoryCalls = 0;
      const unresolvedExit = await runMigrationCli(["--env", "staging"], {
        ...unresolved.dependencies,
        remoteTransportFactory: () => {
          unresolvedFactoryCalls += 1;
          throw new Error("unresolved id reached remote transport factory");
        },
      });
      assert.equal(unresolvedExit, 1);
      assert.equal(unresolvedFactoryCalls, 0);
      assert.equal(
        JSON.parse(unresolved.stderr.join("").trim()).code,
        "REMOTE_TARGET_ID_UNRESOLVED",
      );

      const production = capture();
      let productionFactoryCalls = 0;
      const productionExit = await runMigrationCli(["--env", "production", "--apply"], {
        ...production.dependencies,
        remoteTransportFactory: () => {
          productionFactoryCalls += 1;
          throw new Error("production reached remote transport factory");
        },
      });
      assert.equal(productionExit, 1);
      assert.equal(productionFactoryCalls, 0);
      assert.equal(
        JSON.parse(production.stderr.join("").trim()).code,
        "REMOTE_APPLY_PRODUCTION_REFUSED",
      );

      const contaminated = capture();
      const contaminatedTransport = recordingTransport({
        catalog: [remoteCatalogRow("table", "counterfeit", "CREATE TABLE counterfeit (id TEXT);")],
      });
      const contaminatedExit = await runMigrationCli(
        ["--env", "staging", "--resolved-database-id", STAGING_DATABASE_ID, "--apply"],
        {
          ...contaminated.dependencies,
          remoteTransportFactory: () => contaminatedTransport,
        },
      );
      assert.equal(contaminatedExit, 1);
      assert.equal(JSON.parse(contaminated.stderr.join("").trim()).code, "SCHEMA_LINEAGE_REFUSED");
      assert.equal(contaminatedTransport.calls.describe, 1);
      assert.ok(contaminatedTransport.calls.query >= 1);
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
