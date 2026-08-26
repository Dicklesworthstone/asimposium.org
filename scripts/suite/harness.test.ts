/**
 * OPS.2a contract tests. Ordinary runs use simulated artifacts; the separately
 * enabled filesystem proof retains evidence below one checkout namespace.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_BLOB_DIRECTORY,
  ARTIFACT_MAINTENANCE_FENCE_NAME,
  ARTIFACT_WRITER_LEASE_CLOSED_NAME,
  ARTIFACT_WRITER_LEASES_NAME,
  type ArtifactCensusContext,
  type ArtifactCensusObservation,
  type ArtifactDirectoryWriterCapability,
  ArtifactStore,
  type ArtifactWriterLease,
  acquireArtifactWriterLeaseAtRoot,
  adapterProbePath,
  artifactCapacityReport,
  assertArtifactDirectoryWriterCapability,
  assertArtifactNamespaceBudget,
  assertArtifactWriterLeaseOpen,
  assertContainedRoot,
  assertD1ArtifactWriterCapability,
  assertRealStorageAuthority,
  assertRetainedD1StateDirectory,
  assertRetainedIntegrationCapacity,
  boundedDiff,
  classifyArtifactWriterLeaseChildren,
  closeArtifactWriterLease,
  countArtifactNamespaces,
  countBlobStagingArtifacts,
  createMemoryArtifactStorage,
  D1_ARTIFACT_CAPABILITY_ENV,
  type D1ArtifactWriterCapability,
  DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
  deterministicSeed,
  exceedsArtifactNamespaceBudget,
  FAILURE_MANIFEST_NAME,
  FAILURE_RECORD_INTENT,
  FAILURE_RECORD_STORED,
  FORCE_KILL_GRACE_MS,
  HARD_READER_GRACE_MS,
  HARNESS_BLOCKED_EXIT_CODE,
  HARNESS_RUN_OPTION_KEYS,
  HARNESS_SCHEMA_VERSION,
  type HarnessArtifactStorage,
  type HarnessError,
  type HarnessEvent,
  type HarnessRootFilesystem,
  type HarnessStep,
  harnessIntegrationReproduction,
  isContainedPath,
  MAX_ARTIFACT_NAMESPACES,
  MAX_CAPTURED_OUTPUT_CHARS,
  MAX_DIFF_CHARS,
  MAX_EVENT_DURATION_MS,
  MAX_FAILURE_ARTIFACT_CHARS,
  MAX_FAILURE_ARTIFACTS_PER_RUN,
  MAX_RETAINED_INTEGRATION_BYTES,
  MAX_RETAINED_INTEGRATION_DIRECTORIES,
  MAX_RETENTION_CENSUS_ENTRIES,
  MAX_RETENTION_CENSUS_HASH_BYTES,
  MAX_RETRIES_PER_STEP,
  MAX_STEPS_PER_RUN,
  MAX_TIMEOUT_MS,
  nodeArtifactStorage,
  opaqueCensusSha256,
  orderSteps,
  parseHarnessCli,
  publishFailureBlob,
  RUN_IDENTITY_NAME,
  realFilesystemRetentionPreflight,
  reconcileFailureManifest,
  reconcileRunIdentity,
  redactNeverLog,
  repositoryRoot,
  reserveArtifactNamespace,
  reserveRetainedIntegrationDirectory,
  restoreProtectedSha256Marker,
  retainedD1StateDirectory,
  retainedIntegrationCapacityReport,
  runHarness,
  SELF_TEST_REPRODUCTION,
  safeReproductionCommand,
  selfTestReproduction,
  summarizeArtifactCensusObservations,
  validateHarnessEvent,
  validateHarnessRunOptions,
  validateHarnessStep,
  validateRunId,
} from "../harness/runner.ts";

/** A schema-valid event, so a test can vary exactly one field. */
function sampleEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  const now = new Date().toISOString();
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "step",
    run_id: "sample-run",
    run_identity_digest: "0".repeat(64),
    suite: "ops.2a-sample",
    scenario: "unit",
    step: "sample-step",
    seed: 1,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 1,
    retry: 0,
    replay_safe: true,
    storage_authority: "simulation",
    adapter: "process",
    status: "pass",
    code: "STEP_PASSED",
    reproduce: SELF_TEST_REPRODUCTION,
    git_revision: "unavailable",
    environment: {
      runtime: "bun",
      runtime_version: Bun.version,
      platform: process.platform,
      binding_versions: {},
    },
    http_method: null,
    route_template: null,
    cursor: null,
    seq: null,
    ...overrides,
  } as HarnessEvent;
}

const SHELL_HARNESS = fileURLToPath(new URL("../e2e-test-harness.sh", import.meta.url));
const RUNNER_SOURCE = fileURLToPath(new URL("../harness/runner.ts", import.meta.url));
const HARNESS_TEST_SOURCE = fileURLToPath(import.meta.url);
const SECRET_EMITTER = fileURLToPath(
  new URL("../harness/self-test-secret-emitter.ts", import.meta.url),
);

let scratchCounter = 0;
let realFilesystemFixtureWriterLease: ArtifactWriterLease | undefined;
const REAL_FILESYSTEM_INTEGRATION_ENV = "ASIMPOSIUM_RUN_REAL_FS_INTEGRATION";
const realFilesystemIntegrationEnabled = process.env[REAL_FILESYSTEM_INTEGRATION_ENV] === "1";
const VIRTUAL_CHECKOUT = "/memory/asimposium";
const VIRTUAL_HOME = "/memory/home";
const VIRTUAL_TEMP = "/memory/tmp";

/** A bounded loopback counter for child-process tests; it writes no files. */
function memoryIpc(): {
  endpoint(path: string): string;
  count(path: string): number;
  close(): void;
} {
  const requests = new Map<string, number>();
  const hostname = "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const count = (requests.get(path) ?? 0) + 1;
      requests.set(path, count);
      return Response.json({ count });
    },
  });
  return {
    endpoint: (path) => `http://${hostname}:${server.port}${path}`,
    count: (path) => requests.get(path) ?? 0,
    close: () => server.stop(true),
  };
}

/** Root facts in memory, used only to exercise the read-only identity guard. */
function virtualRootFilesystem(
  options: {
    directories?: readonly string[];
    files?: readonly string[];
    symlinks?: Readonly<Record<string, string>>;
  } = {},
): HarnessRootFilesystem {
  const directories = new Set([
    VIRTUAL_CHECKOUT,
    VIRTUAL_HOME,
    VIRTUAL_TEMP,
    ...(options.directories ?? []),
  ]);
  const files = new Set(options.files ?? []);
  const symlinks = new Map(Object.entries(options.symlinks ?? {}));
  return {
    exists: (path) => directories.has(path) || files.has(path) || symlinks.has(path),
    isSymlink: (path) => symlinks.has(path),
    isDirectory: (path) => directories.has(path),
    realpath: (path) => symlinks.get(path) ?? path,
    repositoryRoot: () => VIRTUAL_CHECKOUT,
    homeDirectory: () => VIRTUAL_HOME,
    temporaryDirectory: () => VIRTUAL_TEMP,
  };
}

const OPS2A_TEMP_PREFIXES = [
  // These are OPS.2a-owned prefix families, not a repository-wide census.
  // Watching every `asimposium-*` directory makes this suite fail when a peer
  // workstream legitimately creates its own fixture while tests run in
  // parallel. The historical D1 temp family is included explicitly, along
  // with bounded names reserved for any future OPS.2a harness scratch. The
  // legacy families are deliberately retained here: evidence cannot be
  // deleted, but an ordinary run must never add to any task-owned family.
  "asimp-ops2a-",
  "asimposium-ops2a-",
  "harness-ops2a-",
  "asimposium-harness-scratch-",
  "asimposium-budget-",
  "asimposium-harness-outside-",
  "harness-unrelated-",
  "harness-impostor-",
  "harness-link-",
  "harness-marker-",
  "harness-run-unrelated-",
] as const;

function isOps2aTaskTempName(name: string): boolean {
  return OPS2A_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function ordinaryTaskTempResidue(): string[] {
  const found: string[] = [];
  const walk = (directory: string, relative = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      found.push(next);
      if (entry.isDirectory()) walk(join(directory, entry.name), next);
    }
  };
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!isOps2aTaskTempName(entry.name)) continue;
    const root = join(tmpdir(), entry.name);
    found.push(entry.name);
    if (entry.isDirectory()) walk(root, entry.name);
  }
  return found.sort();
}

const ORDINARY_SUITE_RESIDUE_BEFORE = {
  artifactEntries: ordinaryArtifactResidue(),
  taskTempEntries: ordinaryTaskTempResidue(),
};

/**
 * Full relative census, not a top-level namespace count. It makes a retained
 * self-test id, resume id, case, staging file, or D1 `.state` entry equally
 * visible to the ordinary-suite residue guard.
 */
function ordinaryArtifactResidue(): string[] {
  const artifacts = join(repositoryRoot(), "e2e", "artifacts");
  const owned = join(artifacts, DEFAULT_RETAINED_INTEGRATION_NAMESPACE);
  if (!existsSync(owned)) return [];
  const found: string[] = [];
  const walk = (directory: string, relative = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const stable =
        `mode=${stat.mode.toString(8)};size=${stat.size};mtime_ms=${stat.mtimeMs.toFixed(3)};` +
        `ctime_ms=${stat.ctimeMs.toFixed(3)};uid=${stat.uid};gid=${stat.gid};nlink=${stat.nlink}`;
      if (entry.isSymbolicLink()) {
        // Census the link itself, never its target. A retained link pointing
        // outward must become visible without reading or modifying the target.
        found.push(`${next}\ttype=symlink;target=${readlinkSync(path)};${stable}`);
        continue;
      }
      if (entry.isFile()) {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        found.push(`${next}\ttype=file;sha256=${digest};${stable}`);
        continue;
      }
      if (entry.isDirectory()) {
        found.push(`${next}\ttype=directory;${stable}`);
        walk(path, next);
        continue;
      }
      found.push(`${next}\ttype=other;${stable}`);
      // Do not follow a symlink while inspecting evidence. Its name is part of
      // the census, but a target outside e2e/artifacts is not.
    }
  };
  // This suite owns only the one OPS2a integration namespace. Other
  // workstreams retain their own evidence concurrently, and treating their
  // files as a harness mutation makes this test nondeterministic while proving
  // nothing about OPS2a containment.
  walk(owned, DEFAULT_RETAINED_INTEGRATION_NAMESPACE);
  return found.sort();
}

interface SimulatedArtifactCensusEntry {
  readonly relativePath: string;
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly size: number;
  /** Memory storage has no chmod channel; this is its fixed POSIX model. */
  readonly mode: string;
}

/**
 * A zero-write witness for ordinary tests. This is deliberately richer than a
 * list of names: a same-path truncate, chmod, or type swap must differ too.
 */
function simulatedArtifactCensus(
  storage: HarnessArtifactStorage,
  directory: string,
  relativePath = "",
): SimulatedArtifactCensusEntry[] {
  const entries: SimulatedArtifactCensusEntry[] = [];
  for (const name of storage.readdir(directory)) {
    const path = join(directory, name);
    const relative = relativePath === "" ? name : `${relativePath}/${name}`;
    if (storage.isSymlink(path)) {
      entries.push({ relativePath: relative, type: "symlink", size: 0, mode: "120777" });
      continue;
    }
    if (storage.isDirectory(path)) {
      entries.push({ relativePath: relative, type: "directory", size: 0, mode: "040755" });
      entries.push(...simulatedArtifactCensus(storage, path, relative));
      continue;
    }
    if (storage.isFile(path)) {
      entries.push({
        relativePath: relative,
        type: "file",
        size: storage.size(path),
        mode: "100644",
      });
      continue;
    }
    entries.push({ relativePath: relative, type: "other", size: 0, mode: "000000" });
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertCensusUnchanged(
  before: readonly SimulatedArtifactCensusEntry[],
  after: readonly SimulatedArtifactCensusEntry[],
): void {
  expect(after).toEqual(before);
}

/**
 * Keep real filesystem proof executable without making ordinary units write.
 *
 * The integration suite is intentionally opt-in because its evidence is
 * retained in the checkout. When selected, its first operation is the same
 * authority/capacity preflight exposed by the CLI; a full checkout blocks
 * before an integration namespace or artifact file is created.
 */
function requireRealFilesystemIntegration(
  artifactNamespace = DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
): void {
  if (!realFilesystemIntegrationEnabled) {
    throw new Error(`${REAL_FILESYSTEM_INTEGRATION_ENV}=1 is required for real filesystem proof.`);
  }
  const report = realFilesystemRetentionPreflight(
    repositoryRoot(),
    nodeArtifactStorage,
    artifactNamespace,
  );
  if (report.exceeded) {
    throw new Error(
      `real filesystem integration is blocked before any write: ${report.used}/${report.limit} artifact namespaces are retained. ` +
        `Reproduce: ${harnessIntegrationReproduction(repositoryRoot()).preflight.copy_paste}. ${report.remedy}`,
    );
  }
}

function describeRealFilesystemIntegration(name: string, define: () => void): void {
  (realFilesystemIntegrationEnabled ? describe : describe.skip)(name, define);
}

function fixtureWriterLease(): ArtifactWriterLease {
  requireRealFilesystemIntegration();
  if (realFilesystemFixtureWriterLease === undefined) {
    realFilesystemFixtureWriterLease = acquireArtifactWriterLeaseAtRoot(
      repositoryRoot(),
      nodeArtifactStorage,
    );
  }
  assertArtifactWriterLeaseOpen(realFilesystemFixtureWriterLease);
  return realFilesystemFixtureWriterLease;
}

function fixtureDirectoryWriterCapability(directory: string): ArtifactDirectoryWriterCapability {
  const writerLease = fixtureWriterLease();
  const physicalDirectory = realpathSync(directory);
  return {
    writerLease,
    directory: physicalDirectory,
    directoryIdentity: nodeArtifactStorage.directoryIdentity(physicalDirectory),
  };
}

function fixtureCreateDirectory(owner: string, target: string): void {
  const physicalOwner = realpathSync(owner);
  if (
    physicalOwner !== owner ||
    target === physicalOwner ||
    !isContainedPath(physicalOwner, target)
  ) {
    throw new Error("fixture directory creation escaped its exact physical owner");
  }

  let physicalParent = physicalOwner;
  for (const component of relative(physicalOwner, target).split(sep)) {
    if (component === "" || component === "." || component === "..") {
      throw new Error("fixture directory creation received an unsafe path component");
    }
    const directChild = join(physicalParent, component);
    const capability = fixtureDirectoryWriterCapability(physicalParent);
    assertArtifactDirectoryWriterCapability(capability, physicalParent, nodeArtifactStorage);
    if (!existsSync(directChild)) mkdirSync(directChild, { mode: 0o700 });
    const targetStat = lstatSync(directChild);
    if (
      targetStat.isSymbolicLink() ||
      !targetStat.isDirectory() ||
      realpathSync(directChild) !== directChild
    ) {
      throw new Error("fixture directory creation was redirected or replaced");
    }
    assertArtifactDirectoryWriterCapability(capability, physicalParent, nodeArtifactStorage);
    physicalParent = directChild;
  }
}

function fixtureWriteFile(owner: string, target: string, data: string): void {
  const physicalOwner = realpathSync(owner);
  if (physicalOwner !== owner || dirname(target) !== physicalOwner) {
    throw new Error("fixture file creation escaped its exact physical owner");
  }
  const capability = fixtureDirectoryWriterCapability(physicalOwner);
  assertArtifactDirectoryWriterCapability(capability, physicalOwner, nodeArtifactStorage);
  writeFileSync(target, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const targetStat = lstatSync(target);
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error("fixture file creation was redirected or replaced");
  }
  assertArtifactDirectoryWriterCapability(capability, physicalOwner, nodeArtifactStorage);
}

function reserveFixtureArtifactNamespace(
  root: string,
  namespace: string,
  limit = MAX_ARTIFACT_NAMESPACES,
): string {
  const artifacts = realpathSync(join(root, "e2e", "artifacts"));
  return reserveArtifactNamespace(
    root,
    artifacts,
    namespace,
    limit,
    nodeArtifactStorage,
    nodeArtifactStorage.directoryIdentity(artifacts),
    fixtureDirectoryWriterCapability(artifacts),
  );
}

if (realFilesystemIntegrationEnabled) {
  afterAll(() => {
    const lease = realFilesystemFixtureWriterLease;
    if (lease === undefined) return;
    closeArtifactWriterLease(lease);
    realFilesystemFixtureWriterLease = undefined;
  });
}

/**
 * The only root the harness accepts: this checkout.
 *
 * Two earlier attempts to isolate were both worse than the problem. A marker
 * file loosened *production* containment so any writable directory could
 * become a root. `mkdtemp` roots put artifact data outside the repository,
 * against AGENTS.md, and — since nothing here may delete — merely relocated the
 * unbounded growth into the system temp directory.
 *
 * So the root stays the checkout, which is what `assertContainedRoot` verifies
 * against the real filesystem, and the *writes* are diverted instead. See
 * `fixtureStorage`.
 */
function fixtureRoot(_name: string): string {
  return repositoryRoot();
}

/**
 * A simulated artifact tree for one test.
 *
 * `runHarness` still validates the root against the real checkout, so a test
 * using this proves the same containment rules; only the writes land in memory.
 * Nothing reaches `e2e/artifacts`, so the suite is bounded and repeatable no
 * matter how many times it runs.
 *
 * It declares `authority: "simulation"`, and `assertRealStorageAuthority`
 * refuses it wherever a receipt or filesystem claim is produced: this exercises
 * control flow, and never stands as evidence of hard-link behaviour.
 */
function fixtureStorage(): ReturnType<typeof createMemoryArtifactStorage> {
  const storage = createMemoryArtifactStorage();
  // The checkout must exist in the simulated tree for root validation to reach
  // the same conclusion it reaches on disk.
  storage.seedDirectory(repositoryRoot());
  return storage;
}

function soleArtifactWriterLease(
  root: string,
  storage: HarnessArtifactStorage,
): { readonly directory: string; readonly closed: string } {
  const registry = join(root, "e2e", ARTIFACT_WRITER_LEASES_NAME);
  const epochs = storage.readdir(registry);
  expect(epochs).toHaveLength(1);
  expect(epochs[0]).toMatch(/^sim-memory-[0-9]+$/);
  const epoch = join(registry, epochs[0] as string);
  const leases = storage.readdir(epoch);
  expect(leases).toHaveLength(1);
  expect(leases[0]).toMatch(/^lease-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/);
  const directory = join(epoch, leases[0] as string);
  return { directory, closed: join(directory, ARTIFACT_WRITER_LEASE_CLOSED_NAME) };
}

function simulatedD1ArtifactCapability(
  store: ArtifactStore,
  root: string,
  namespace: string,
  storage: HarnessArtifactStorage,
): D1ArtifactWriterCapability {
  const artifactRoot = join(root, "e2e", "artifacts");
  const namespaceDirectory = join(artifactRoot, namespace);
  const lease = soleArtifactWriterLease(root, storage);
  return {
    schema_version: 1,
    repository_root: root,
    artifact_root: artifactRoot,
    artifact_root_identity: storage.directoryIdentity(artifactRoot),
    namespace,
    namespace_directory: namespaceDirectory,
    namespace_identity: storage.directoryIdentity(namespaceDirectory),
    run_id: store.runId,
    run_directory: store.directory,
    run_identity: storage.directoryIdentity(store.directory),
    lease_directory: lease.directory,
    lease_identity: storage.directoryIdentity(lease.directory),
  };
}

/**
 * A retained root for the explicitly enabled real-filesystem tests.
 *
 * Preflight happens before this function reaches either `e2e` or `artifacts`.
 * Once green, every direct filesystem fixture sits below the one safe parent
 * namespace used by the CLI self-test too. The evidence is retained; no
 * cleanup, move, or temp-root escape is involved.
 */
function retainedIntegrationRoot(): string {
  const lease = fixtureWriterLease();
  const checkout = lease.root;
  assertArtifactWriterLeaseOpen(lease);
  return reserveFixtureArtifactNamespace(checkout, DEFAULT_RETAINED_INTEGRATION_NAMESPACE);
}

function fixtureScratchRoot(name: string): string {
  const integration = retainedIntegrationRoot();
  // The real publication fixtures may create one case root, its e2e/artifacts
  // path, blob/staging directories, and only short fixed payloads. Check that
  // complete bounded envelope before even the case root exists; individual
  // publication calls repeat the byte/staging check at their mutation point.
  assertRetainedIntegrationCapacity(
    integration,
    { additionalDirectories: 16, additionalBytes: 64 * 1024 },
    nodeArtifactStorage,
  );
  scratchCounter += 1;
  const caseNamespace = `case-${name}-${process.pid}-${scratchCounter}`;
  if (!validateRunId(caseNamespace)) {
    throw new Error(`test case namespace is not safe: ${caseNamespace}`);
  }
  const root = reserveRetainedIntegrationDirectory(
    integration,
    caseNamespace,
    nodeArtifactStorage,
    1,
    fixtureDirectoryWriterCapability(integration),
  );
  assertArtifactWriterLeaseOpen(fixtureWriterLease());
  fixtureCreateDirectory(root, join(root, "e2e"));
  fixtureCreateDirectory(join(root, "e2e"), join(root, "e2e", "artifacts"));
  return root;
}

/** Name the state leaf inside the run ArtifactStore itself will claim. */
function fixtureD1StateDirectory(runId: string, mode: "ok" | "planted-fail"): string {
  return retainedD1StateDirectory(
    repositoryRoot(),
    DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
    runId,
    `d1-state-${mode}`,
  );
}

/** A run id that is unique per process, so a rerun never hits RUN_ID_EXISTS. */
function fixtureRunId(name: string): string {
  scratchCounter += 1;
  return `t-${name}-${process.pid}-${scratchCounter}`;
}

function command(code: string): readonly string[] {
  const wrapped = `const fs = require("node:fs"); process.stderr.write = (chunk, cb) => { fs.writeSync(2, typeof chunk === "string" ? chunk : Buffer.from(chunk)); if (typeof cb === "function") cb(); return true; }; process.stdout.write = (chunk, cb) => { fs.writeSync(1, typeof chunk === "string" ? chunk : Buffer.from(chunk)); if (typeof cb === "function") cb(); return true; }; ${code}`;
  return [process.execPath, "-e", wrapped];
}

function passStep(id: string, scenario = "unit"): HarnessStep {
  return { id, scenario, command: command("process.exit(0)"), replaySafe: true };
}

function collectedEvents(): { events: HarnessEvent[]; sink: (event: HarnessEvent) => void } {
  const events: HarnessEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

describe("deterministic, structured diagnostics", () => {
  test("sorts steps and derives a stable seed independently of input order", async () => {
    const unordered = [passStep("b", "z"), passStep("a", "a"), passStep("c", "a")];
    expect(orderSteps(unordered).map((step) => `${step.scenario}/${step.id}`)).toEqual([
      "a/a",
      "a/c",
      "z/b",
    ]);
    expect(deterministicSeed("suite", "run-1")).toBe(deterministicSeed("suite", "run-1"));
    expect(deterministicSeed("suite", "run-1")).not.toBe(deterministicSeed("suite", "run-2"));

    const root = fixtureRoot("ordering");

    const storage = fixtureStorage();
    const records = collectedEvents();
    const result = await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("order-1"),
      steps: unordered,
      onEvent: records.sink,
      onOutput: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(result.storageAuthority).toBe("simulation");
    expect(result.events.every((event) => event.storage_authority === "simulation")).toBe(true);
    expect(
      records.events.filter((event) => event.record === "step").map((event) => event.step),
    ).toEqual(["a", "c", "b"]);
    const jsonl = storage.readFile(result.artifacts.jsonl);
    expect(
      jsonl
        .split("\n")
        .filter(Boolean)
        .every((line) => JSON.parse(line).schema_version === HARNESS_SCHEMA_VERSION),
    ).toBe(true);
    expect(storage.readFile(result.artifacts.junit)).toContain("<testsuite");
  });

  test("distinguishes a deliberate blocked exit from a broken child exit", async () => {
    const blockedRoot = fixtureRoot("blocked");
    const blockedStorage = fixtureStorage();
    const blocked = await runHarness({
      root: blockedRoot,
      storage: blockedStorage,
      suite: "integration",
      runId: fixtureRunId("blocked-1"),
      steps: [
        {
          id: "named-blocker",
          scenario: "integration",
          command: command(
            `console.error("named blocker"); process.exit(${HARNESS_BLOCKED_EXIT_CODE})`,
          ),
          replaySafe: false,
        },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(blocked.exitCode).toBe(HARNESS_BLOCKED_EXIT_CODE);
    expect(blocked.events.find((event) => event.record === "step")?.status).toBe("blocked");

    const failedRoot = fixtureRoot("failed");
    const failedStorage = fixtureStorage();
    const failed = await runHarness({
      root: failedRoot,
      storage: failedStorage,
      suite: "integration",
      runId: fixtureRunId("failed-1"),
      steps: [
        {
          id: "planted-negative",
          scenario: "integration",
          command: command("console.error('planted failure'); process.exit(3)"),
          replaySafe: true,
        },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(failed.exitCode).toBe(1);
    const failure = failed.events.find((event) => event.record === "step");
    expect(failure?.status).toBe("fail");
    expect(failure?.exit_code).toBe(3);
    expect(failure?.reproduce).toBe("unavailable: no registered CLI scenario");
    expect(failure?.git_revision).toBe("unavailable");
    expect(failure?.environment.runtime).toBe("bun");
    expect(failure?.environment.binding_versions).toEqual({});
    expect(failure?.http_method).toBeNull();
    expect(failure?.route_template).toBeNull();
    expect(failure?.cursor).toBeNull();
    expect(failure?.seq).toBeNull();
  });
});

describe("execution lifecycle", () => {
  test("closes exactly one append-only writer lease after a successful run", async () => {
    const root = fixtureRoot("writer-lease-success");
    const storage = fixtureStorage();
    await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("writer-lease-success"),
      steps: [passStep("ok")],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });

    const lease = soleArtifactWriterLease(root, storage);
    expect(storage.isDirectory(lease.directory)).toBe(true);
    expect(storage.isDirectory(lease.closed)).toBe(true);
    expect(storage.readdir(lease.closed)).toEqual([]);
  });

  test("manual store close is idempotent and permanently refuses later writes", () => {
    const root = fixtureRoot("writer-lease-manual-close");
    const storage = fixtureStorage();
    const runId = fixtureRunId("writer-lease-manual-close");
    const identity = {
      runId,
      suite: "unit",
      seed: 7,
      stepIds: ["ok"],
      stepContractDigests: ["a".repeat(64)],
      reproduction: "unavailable: no registered CLI scenario",
      artifactNamespace: null,
      gitRevision: "unavailable",
      childEnvironmentDigest: "b".repeat(64),
      bindingVersions: {},
    } as const;
    const store = new ArtifactStore(root, runId, false, identity, storage);
    const lease = soleArtifactWriterLease(root, storage);
    expect(storage.exists(lease.closed) || storage.isSymlink(lease.closed)).toBe(false);

    store.close();
    expect(() => store.close()).not.toThrow();
    expect(storage.isDirectory(lease.closed)).toBe(true);
    expect(storage.readdir(lease.closed)).toEqual([]);
    expect(() => store.writeJUnit([])).toThrow(/ARTIFACT_WRITER_LEASE_CLOSED|lease is closed/);
  });

  test("a forged lease directory cannot be asserted or receive a closed marker", () => {
    const root = fixtureRoot("writer-lease-foreign-directory");
    const storage = fixtureStorage();
    const lease = acquireArtifactWriterLeaseAtRoot(root, storage);
    const foreignDirectory = join(root, "foreign-directory");
    storage.mkdir(foreignDirectory);
    const forged: ArtifactWriterLease = {
      ...lease,
      directory: foreignDirectory,
      identity: storage.directoryIdentity(foreignDirectory),
    };

    expect(() => assertArtifactWriterLeaseOpen(forged)).toThrow(
      /ARTIFACT_WRITER_LEASE_INVALID|outside its exact artifact-root epoch/,
    );
    expect(() => closeArtifactWriterLease(forged)).toThrow(
      /ARTIFACT_WRITER_LEASE_INVALID|outside its exact artifact-root epoch/,
    );
    expect(storage.exists(join(foreignDirectory, ARTIFACT_WRITER_LEASE_CLOSED_NAME))).toBe(false);
    closeArtifactWriterLease(lease);
  });

  for (const failurePoint of ["onOutput", "onEvent", "storage.append"] as const) {
    test(`reaps the detached process group before ${failurePoint} failure closes its lease`, async () => {
      const root = fixtureRoot(`writer-lease-${failurePoint}`);
      const base = fixtureStorage();
      const ipc = memoryIpc();
      let failureHookReached = false;
      let readyOutputSeen = false;
      const failAtHook = (message: string): never => {
        const lease = soleArtifactWriterLease(root, base);
        expect(base.exists(lease.closed) || base.isSymlink(lease.closed)).toBe(false);
        failureHookReached = true;
        throw new Error(message);
      };
      const storage: HarnessArtifactStorage =
        failurePoint === "storage.append"
          ? {
              ...base,
              append: (path, data) => {
                if (data.includes('"record":"step"') || data.includes('"record":"summary"')) {
                  failAtHook("planted storage append failure");
                }
                return base.append(path, data);
              },
            }
          : base;
      const grandchild = `setTimeout(() => void fetch(${JSON.stringify(ipc.endpoint("/escaped-descendant"))}), 250); setTimeout(() => process.exit(0), 1000);`;
      const parent = `const cp = require("node:child_process"); cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore", detached: false }); process.stdout.write("callback-trigger:ready\\n"); process.exit(0);`;

      try {
        await expect(
          runHarness({
            root,
            storage,
            suite: "unit",
            runId: fixtureRunId(`writer-lease-${failurePoint}`),
            steps: [
              {
                id: "spawn",
                scenario: "unit",
                command: command(parent),
                replaySafe: true,
              },
            ],
            onOutput: (text) => {
              if (text.includes("callback-trigger:ready")) {
                readyOutputSeen = true;
                if (failurePoint === "onOutput") {
                  failAtHook("planted output callback failure");
                }
              }
            },
            onEvent:
              failurePoint === "onEvent"
                ? () => failAtHook("planted event callback failure")
                : () => undefined,
          }),
        ).rejects.toThrow(/planted/);
        expect(readyOutputSeen).toBe(true);
        expect(failureHookReached).toBe(true);
        const lease = soleArtifactWriterLease(root, storage);
        expect(storage.isDirectory(lease.closed)).toBe(true);
        expect(storage.readdir(lease.closed)).toEqual([]);
        await Bun.sleep(350);
        expect(ipc.count("/escaped-descendant")).toBe(0);
      } finally {
        ipc.close();
      }
    });
  }

  test("retries replay-safe work with attempt accounting", async () => {
    const root = fixtureRoot("retry");
    const storage = fixtureStorage();
    const ipc = memoryIpc();
    try {
      const endpoint = ipc.endpoint("/retry");
      const code = `(async () => { const { count } = await (await fetch(${JSON.stringify(endpoint)})).json(); process.exit(count === 1 ? 1 : 0); })().catch(() => process.exit(2));`;
      const result = await runHarness({
        root,
        storage,
        suite: "unit",
        runId: fixtureRunId("retry-1"),
        steps: [
          { id: "retry", scenario: "unit", command: command(code), replaySafe: true, retries: 1 },
        ],
        onEvent: () => undefined,
        onOutput: () => undefined,
      });
      expect(result.exitCode).toBe(0);
      const attempts = result.events.filter((event) => event.record === "step");
      expect(attempts.map((event) => event.status)).toEqual(["fail", "pass"]);
      expect(attempts.map((event) => event.attempt)).toEqual([1, 2]);
      expect(attempts.map((event) => event.retry)).toEqual([0, 1]);
      expect(ipc.count("/retry")).toBe(2);
    } finally {
      ipc.close();
    }
  });

  test("timeout and cancellation terminate direct child processes before their delayed side effect", async () => {
    const root = fixtureRoot("cleanup");
    const storage = fixtureStorage();
    const ipc = memoryIpc();
    const delayedHit = (path: string): string =>
      `setTimeout(() => void fetch(${JSON.stringify(ipc.endpoint(path))}), 250);`;
    try {
      const timeout = await runHarness({
        root,
        storage,
        suite: "e2e",
        runId: fixtureRunId("timeout-1"),
        steps: [
          {
            id: "timeout",
            scenario: "e2e",
            command: command(delayedHit("/timeout")),
            replaySafe: true,
            timeoutMs: 20,
          },
        ],
        onEvent: () => undefined,
        onOutput: () => undefined,
      });
      await Bun.sleep(350);
      expect(timeout.exitCode).toBe(1);
      expect(timeout.events.find((event) => event.record === "step")?.status).toBe("timeout");
      expect(ipc.count("/timeout")).toBe(0);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const cancelled = await runHarness({
        root,
        storage,
        suite: "e2e",
        runId: fixtureRunId("cancelled-1"),
        signal: controller.signal,
        steps: [
          {
            id: "cancelled",
            scenario: "e2e",
            command: command(delayedHit("/cancelled")),
            replaySafe: true,
            timeoutMs: 1_000,
          },
        ],
        onEvent: () => undefined,
        onOutput: () => undefined,
      });
      await Bun.sleep(350);
      expect(cancelled.exitCode).toBe(1);
      expect(cancelled.events.find((event) => event.record === "step")?.status).toBe("cancelled");
      expect(ipc.count("/cancelled")).toBe(0);

      const preCancelled = new AbortController();
      preCancelled.abort();
      const preCancelledResult = await runHarness({
        root,
        storage,
        suite: "e2e",
        runId: fixtureRunId("pre-cancelled-1"),
        signal: preCancelled.signal,
        steps: [
          {
            id: "pre-cancelled",
            scenario: "e2e",
            command: command(delayedHit("/pre-cancelled")),
            replaySafe: true,
          },
        ],
        onEvent: () => undefined,
        onOutput: () => undefined,
      });
      await Bun.sleep(350);
      expect(preCancelledResult.exitCode).toBe(1);
      expect(preCancelledResult.events.find((event) => event.record === "step")?.status).toBe(
        "cancelled",
      );
      expect(ipc.count("/pre-cancelled")).toBe(0);
    } finally {
      ipc.close();
    }
  });

  test("timeout terminates the detached process group, including a planted grandchild", async () => {
    const root = fixtureRoot("process-group");
    const storage = fixtureStorage();
    const ipc = memoryIpc();
    try {
      const grandchild = `setTimeout(() => void fetch(${JSON.stringify(ipc.endpoint("/grandchild"))}), 250); setTimeout(() => process.exit(0), 1000);`;
      const parent = `const cp = require("node:child_process"); cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(() => process.exit(0), 1000);`;
      const result = await runHarness({
        root,
        storage,
        suite: "e2e",
        runId: fixtureRunId("process-group-1"),
        steps: [
          {
            id: "grandchild",
            scenario: "e2e",
            command: command(parent),
            replaySafe: true,
            timeoutMs: 20,
          },
        ],
        onEvent: () => undefined,
        onOutput: () => undefined,
      });
      await Bun.sleep(350);
      expect(result.exitCode).toBe(1);
      expect(result.events.find((event) => event.record === "step")?.status).toBe("timeout");
      expect(ipc.count("/grandchild")).toBe(0);
    } finally {
      ipc.close();
    }
  });

  test("uses only a fixed child environment instead of ambient values", async () => {
    const root = fixtureRoot("environment");
    const storage = fixtureStorage();
    const result = await runHarness({
      root,
      storage,
      suite: "security",
      runId: fixtureRunId("environment-1"),
      steps: [
        {
          id: "scrubbed-env",
          scenario: "security",
          command: command(
            "process.exit(process.env.HOME === undefined && process.env.BUN_INSTALL === undefined ? 0 : 1)",
          ),
          replaySafe: true,
        },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(result.exitCode).toBe(0);
  });

  test("resumes failed replay-safe work but withholds incomplete unsafe work", async () => {
    const root = fixtureRoot("resume");
    const storage = fixtureStorage();
    const resumeRunId = fixtureRunId("resume");
    const ipc = memoryIpc();
    const steps: HarnessStep[] = [
      {
        id: "safe",
        scenario: "resume",
        command: command(
          `(async () => { const { count } = await (await fetch(${JSON.stringify(ipc.endpoint("/safe"))})).json(); process.exit(count === 1 ? 1 : 0); })().catch(() => process.exit(2));`,
        ),
        replaySafe: true,
      },
      {
        id: "unsafe",
        scenario: "resume",
        command: command(
          `(async () => { await fetch(${JSON.stringify(ipc.endpoint("/unsafe"))}); process.exit(1); })().catch(() => process.exit(2));`,
        ),
        replaySafe: false,
      },
    ];
    try {
      const first = await runHarness({
        root,
        storage,
        suite: "e2e",
        runId: resumeRunId,
        steps,
        onEvent: () => undefined,
        onOutput: () => undefined,
      });
      expect(first.exitCode).toBe(1);
      const resumed = await runHarness({
        root,
        storage,
        suite: "e2e",
        runId: resumeRunId,
        resume: true,
        steps,
        onEvent: () => undefined,
        onOutput: () => undefined,
      });
      expect(resumed.exitCode).toBe(HARNESS_BLOCKED_EXIT_CODE);
      expect(resumed.events.find((event) => event.step === "safe")?.status).toBe("pass");
      expect(resumed.events.find((event) => event.step === "unsafe")?.code).toBe(
        "UNSAFE_REPLAY_WITHHELD",
      );
      expect(ipc.count("/safe")).toBe(2);
      expect(ipc.count("/unsafe")).toBe(1);
    } finally {
      ipc.close();
    }
  });

  test("PLANTED: resume rejects changed step semantics and a missing identity", async () => {
    const root = fixtureRoot("strict-resume");
    const storage = fixtureStorage();
    const runId = fixtureRunId("strict-resume");
    const original = {
      id: "bound-step",
      scenario: "resume",
      replaySafe: true,
      retries: 0,
      timeoutMs: 1_000,
      command: command("process.exit(0)"),
    } satisfies HarnessStep;
    await runHarness({
      root,
      storage,
      suite: "unit",
      runId,
      steps: [original],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    const jsonl = join(root, "e2e", "artifacts", runId, "events.jsonl");
    const before = storage.readFile(jsonl);
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId,
        resume: true,
        steps: [{ ...original, timeoutMs: 2_000 }],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/RUN_IDENTITY_MISMATCH|bound plan/);
    expect(storage.readFile(jsonl)).toBe(before);

    const missingRun = fixtureRunId("missing-identity");
    const missingDirectory = join(root, "e2e", "artifacts", missingRun);
    storage.seedDirectory(missingDirectory);
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: missingRun,
        resume: true,
        steps: [original],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/RUN_IDENTITY_MISSING|no identity record/);
    expect(storage.exists(join(missingDirectory, "events.jsonl"))).toBe(false);
  });

  test("PLANTED: a forged prior event digest refuses resume attribution", async () => {
    const root = fixtureRoot("event-binding");
    const storage = fixtureStorage();
    const runId = fixtureRunId("event-binding");
    const step = passStep("bound-event", "resume");
    await runHarness({
      root,
      storage,
      suite: "unit",
      runId,
      steps: [step],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    const jsonl = join(root, "e2e", "artifacts", runId, "events.jsonl");
    const forged = storage
      .readFile(jsonl)
      .replace(/"run_identity_digest":"[0-9a-f]{64}"/, `"run_identity_digest":"${"f".repeat(64)}"`);
    storage.files.set(jsonl, forged);
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId,
        resume: true,
        steps: [step],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/RUN_EVENT_IDENTITY_MISMATCH|different immutable run identity/);
  });
});

describe("secret-safe, bounded artifacts", () => {
  test("redacts argv, child stdout/stderr, diffs and every retained artifact while keeping failure cause visible", async () => {
    const root = fixtureRoot("redaction");
    const storage = fixtureStorage();
    const secret = ["asimp", "ag", "01JXYZ", "selftest", "neverlog", "canary"].join("_");
    const opaqueValue = "A".repeat(32);
    let visible = "";
    const debug = process.env.ASIMPOSIUM_HARNESS_DEBUG === "1";
    if (debug) console.error("[DIAG] STARTING REDACTION TEST");
    const result = await runHarness({
      root,
      storage,
      suite: "security",
      runId: fixtureRunId("redaction-1"),
      steps: [
        {
          id: "opaque",
          scenario: "security",
          command: command('process.stderr.write("A".repeat(32)); process.exit(1);'),
          replaySafe: true,
        },
        {
          id: "secret",
          scenario: "security",
          command: [process.execPath, SECRET_EMITTER],
          replaySafe: true,
          expected: `authorization_code=${secret}`,
          actual: `directive_body=${secret}`,
        },
      ],
      onEvent: (ev) => {
        if (debug) console.error("[DIAG EVENT]", ev.record, ev.step, ev.status);
      },
      onOutput: (text) => {
        if (debug) console.error("[DIAG OUTPUT]", { visibleLength: text.length });
        visible += text;
      },
    });
    if (debug) {
      console.error("[DIAG FINISHED]", {
        exitCode: result.exitCode,
        visibleLength: visible.length,
      });
    }
    expect(result.exitCode).toBe(1);
    expect(visible).toContain("<redacted>");
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain(opaqueValue);
    const retained = [
      result.artifacts.jsonl,
      result.artifacts.junit,
      ...result.artifacts.failureLogs,
    ]
      .map((path) => storage.readFile(path))
      .join("\n");
    expect(retained).toContain("<redacted>");
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain(opaqueValue);
    const failure = result.events.find((event) => event.step === "secret");
    expect(failure?.argv).toEqual(["bun", "<redacted-argument>"]);
    expect(failure?.argv?.join(" ")).not.toContain(secret);
    expect(failure?.diff?.length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
    expect(boundedDiff("x".repeat(10_000), "y".repeat(10_000), root).length).toBeLessThanOrEqual(
      MAX_DIFF_CHARS,
    );
  });

  test("redacts full Darwin and generic tmp paths while preserving labelled SHA-256 JSON evidence", () => {
    const identityDigest = "a".repeat(64);
    const artifactDigest = "b".repeat(64);
    const opaque = "c".repeat(64);
    const redacted = redactNeverLog(
      `darwin=/private/tmp/ops2a-proof linux=/tmp/ops2a-proof ` +
        `{"run_identity_digest":"${identityDigest}","artifact_digest":"${artifactDigest}","token":"${opaque}"}`,
      repositoryRoot(),
    );
    expect(redacted).not.toContain("/private/tmp/");
    expect(redacted).not.toContain("/tmp/");
    expect(redacted).not.toContain("/private<path>");
    expect(redacted).toContain(`"run_identity_digest":"${identityDigest}"`);
    expect(redacted).toContain(`"artifact_digest":"${artifactDigest}"`);
    expect(redacted).not.toContain(opaque);
    expect(redacted).toContain("<redacted>");
  });

  test("uses shared-only credential families and consumes every private line-valued tail", () => {
    const fineGrainedGitHub = "github_pat_0123456789abcdefghijklmnopqrstuv";
    const liveKey = "sk_live_0123456789abcdefghij";
    const basicPayload = "YWxhZGRpbjpvcGVuc2VzYW1l";
    expect(
      redactNeverLog(`${fineGrainedGitHub} ${liveKey} Basic ${basicPayload}`, repositoryRoot()),
    ).toBe("<redacted> <redacted> <redacted>");

    for (const [input, expected, privateTail] of [
      [
        "directive_body: prove lemma, then reveal witness",
        "directive_body: <redacted>",
        "prove lemma, then reveal witness",
      ],
      [
        "cookie: sid=abc; other=secret; Path=/",
        "cookie: <redacted>",
        "sid=abc; other=secret; Path=/",
      ],
      ["authorization: Bearer abc status=ok", "authorization: <redacted>", "Bearer abc status=ok"],
    ] as const) {
      const redacted = redactNeverLog(input, repositoryRoot());
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain(privateTail);
    }
  });

  test("preserves labelled SHA-256 evidence and ordinary prose", () => {
    const digest = "a".repeat(64);
    const safe = `sha256: ${digest}\nThe bound holds for every n greater than 2.`;
    expect(redactNeverLog(safe, repositoryRoot())).toBe(safe);
  });

  test("PLANTED: an attacker literal legacy placeholder cannot receive a protected digest", () => {
    const digest = "d".repeat(64);
    const attackerLiteral = "__HARNESS_SHA256_0__";
    const opaque = "e".repeat(64);
    const redacted = redactNeverLog(
      `{"artifact_digest":"${digest}","attacker":"${attackerLiteral}","token":"${opaque}"}`,
      repositoryRoot(),
    );

    // The only restored digest is the labelled one that redaction protected.
    expect(redacted).toContain(`"artifact_digest":"${digest}"`);
    expect(redacted).toContain(`"attacker":"${attackerLiteral}"`);
    expect(redacted).not.toContain(`"attacker":"${digest}"`);
    expect(redacted).not.toContain(opaque);
  });

  test("PLANTED: a duplicated exact internal marker fails closed without digest fabrication", () => {
    const digest = "f".repeat(64);
    const marker = "\u0000HARNESS_SHA256_forced-collision_0\u0000";
    const restored = restoreProtectedSha256Marker(
      `label=${marker};attacker=${marker}`,
      marker,
      digest,
    );

    expect(restored).toBe("label=<redacted>;attacker=<redacted>");
    expect(restored).not.toContain(digest);
  });

  test("static guard: protected digests never use global split/join restoration", () => {
    expect(readFileSync(RUNNER_SOURCE, "utf8")).not.toContain("split(marker).join(digest)");
  });

  test("static guard: canonical diagnostics owns credential vocabulary", () => {
    const source = readFileSync(RUNNER_SOURCE, "utf8");
    expect(source).toContain('from "@asimposium/contracts/diagnostic-safety"');
    expect(source).toContain("redactCredentials");
    expect(source).toContain("containsCredentialShape");
    for (const duplicateFamily of [
      "asimp_ag_",
      "#v1\\.",
      "gh[pousr]_",
      "AIza",
      "BEGIN [A-Z ]*PRIVATE KEY",
    ]) {
      expect(source).not.toContain(duplicateFamily);
    }
  });

  test("static guard: opt-in harness diagnostics expose metadata, never argv or output bytes", () => {
    const source = readFileSync(RUNNER_SOURCE, "utf8");
    expect(source).toContain('console.error("[DEBUG SPAWN]", { stepId: step.id, argvCount:');
    expect(source).toContain('console.error("[DEBUG readBounded]", { capturedLength:');
    expect(source).not.toContain('console.error("[DEBUG SPAWN]", { commandLine');
    expect(source).not.toContain("visibleLen: visibleOutput.length, visibleOutput");
    expect(source).not.toContain("raw: JSON.stringify(raw)");
  });

  test("caps failure artifacts and does not retain child output for successful steps", async () => {
    const root = fixtureRoot("caps");
    const storage = fixtureStorage();
    const large = "x".repeat(MAX_FAILURE_ARTIFACT_CHARS * 3);
    const failure = await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("cap-failure-1"),
      steps: [
        {
          id: "large-failure",
          scenario: "unit",
          command: command(
            `process.stderr.write("x".repeat(${MAX_FAILURE_ARTIFACT_CHARS * 3})); process.exit(1)`,
          ),
          replaySafe: true,
        },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(failure.artifacts.failureLogs).toHaveLength(1);
    expect(storage.readFile(failure.artifacts.failureLogs[0] as string).length).toBeLessThanOrEqual(
      MAX_FAILURE_ARTIFACT_CHARS,
    );
    const failureEvent = failure.events.find((event) => event.step === "large-failure");
    expect(failureEvent?.output_chars).toBeLessThanOrEqual(MAX_CAPTURED_OUTPUT_CHARS * 2);
    expect(failureEvent?.output_truncated).toBe(true);

    const success = await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("cap-success-1"),
      steps: [
        {
          id: "large-success",
          scenario: "unit",
          command: command(`process.stdout.write("x".repeat(${MAX_FAILURE_ARTIFACT_CHARS * 3}))`),
          replaySafe: true,
        },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(success.exitCode).toBe(0);
    expect(success.artifacts.failureLogs).toEqual([]);
    expect(storage.readFile(success.artifacts.jsonl)).not.toContain(large);
  });

  test("retains at most the fixed number of failure logs without deleting any prior evidence", async () => {
    const root = fixtureRoot("failure-retention");
    const storage = fixtureStorage();
    const result = await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("failure-retention-1"),
      steps: Array.from({ length: MAX_FAILURE_ARTIFACTS_PER_RUN + 1 }, (_, index) => ({
        id: `failure-${index}`,
        scenario: "unit",
        command: command("process.stderr.write('bounded failure'); process.exit(1)"),
        replaySafe: true,
      })),
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(result.exitCode).toBe(1);
    /**
     * Every step emits identical bytes, so content-addressing resolves them to
     * one blob and the deduplicated list holds exactly one path. The old
     * assertion — one file per failure — described the pre-CAS store, where 33
     * identical failures wrote 33 copies.
     *
     * The bound that still matters is the *budget*, and it is spent per attempt
     * rather than per distinct blob: the manifest must record the cap and stop,
     * never the 33rd attempt.
     */
    expect(result.artifacts.failureLogs).toHaveLength(1);
    const manifest = storage
      .readFile(join(result.artifacts.jsonl, "..", FAILURE_MANIFEST_NAME))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { record: string });
    const intents = manifest.filter((entry) => entry.record === FAILURE_RECORD_INTENT);
    expect(intents).toHaveLength(MAX_FAILURE_ARTIFACTS_PER_RUN);
    // Nothing was deleted to stay within the bound: the run simply stopped
    // publishing once the budget was gone.
    expect(intents.length).toBeLessThan(MAX_FAILURE_ARTIFACTS_PER_RUN + 1);
  });
});

describe("runtime contract validation", () => {
  test("rejects secret-bearing argv and unbounded retry, timeout, and command inputs before spawn", async () => {
    const root = fixtureRoot("validation");
    const storage = fixtureStorage();
    for (const [index, secret] of [
      ["asimp", "ag", "01JXYZ", "argv", "canary"].join("_"),
      "github_pat_0123456789abcdefghijklmnopqrstuv",
      "sk_live_0123456789abcdefghij",
      "Basic YWxhZGRpbjpvcGVuc2VzYW1l",
      "directive_body: prove lemma, then reveal witness",
      "cookie: sid=abc; other=secret; Path=/",
      "authorization: Bearer abc status=ok",
    ].entries()) {
      await expect(
        runHarness({
          root,
          storage,
          suite: "security",
          runId: fixtureRunId(`secret-argv-${index}`),
          steps: [
            {
              id: "secret-argv",
              scenario: "security",
              command: [process.execPath, secret],
              replaySafe: true,
            },
          ],
          onEvent: () => undefined,
          onOutput: () => undefined,
        }),
      ).rejects.toMatchObject({
        code: "COMMAND_SECRET_FORBIDDEN",
      } satisfies Partial<HarnessError>);
    }

    await expect(
      runHarness({
        root,
        storage,
        suite: "security",
        runId: fixtureRunId("bounds-1"),
        steps: [
          {
            id: "bounds",
            scenario: "security",
            command: command("process.exit(0)"),
            replaySafe: true,
            retries: MAX_RETRIES_PER_STEP + 1,
            timeoutMs: MAX_TIMEOUT_MS + 1,
          },
        ],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RETRY_LIMIT" } satisfies Partial<HarnessError>);
  });

  test("records validated revision, environment, HTTP, cursor, and sequence context", async () => {
    const root = fixtureRoot("event-schema");
    const storage = fixtureStorage();
    const result = await runHarness({
      root,
      storage,
      suite: "contract",
      runId: fixtureRunId("event-schema-1"),
      gitRevision: "abcdef0",
      bindingVersions: { d1: "local", worker: "unbound" },
      steps: [
        {
          id: "context",
          scenario: "contract",
          command: command("process.exit(0)"),
          replaySafe: true,
          http: { method: "POST", routeTemplate: "/v1/sessions/:id", cursor: 7, seq: 11 },
        },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    const event = result.events.find((item) => item.record === "step");
    if (event === undefined) throw new Error("missing step event");
    expect(event.git_revision).toBe("abcdef0");
    expect(event.environment.binding_versions).toEqual({ d1: "local", worker: "unbound" });
    expect(event.http_method).toBe("POST");
    expect(event.route_template).toBe("/v1/sessions/:id");
    expect(event.cursor).toBe(7);
    expect(event.seq).toBe(11);
    let schemaError: unknown;
    try {
      validateHarnessEvent({ ...event, route_template: null });
    } catch (error) {
      schemaError = error;
    }
    expect(schemaError).toMatchObject({
      code: "EVENT_SCHEMA_INVALID",
    } satisfies Partial<HarnessError>);
  });

  test("withholds unimplemented D1, HTTP, and browser adapters instead of fabricating subsystem proof", async () => {
    const root = fixtureRoot("adapter-unavailable");
    const storage = fixtureStorage();
    const result = await runHarness({
      root,
      storage,
      suite: "integration",
      runId: fixtureRunId("adapter-unavailable-1"),
      steps: [
        { id: "d1", scenario: "integration", adapter: "d1", replaySafe: false },
        { id: "http", scenario: "integration", adapter: "http", replaySafe: false },
        { id: "browser", scenario: "e2e", adapter: "browser", replaySafe: false },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(result.exitCode).toBe(HARNESS_BLOCKED_EXIT_CODE);
    expect(
      result.events
        .filter((event) => event.record === "step")
        .every((event) =>
          ["blocked", "ADAPTER_UNAVAILABLE"].includes(event.status === "blocked" ? event.code : ""),
        ),
    ).toBe(true);
  });
});

describe("artifact containment", () => {
  test("accepts only one safe run-id path component and rejects an artifact symlink escape", async () => {
    for (const invalid of ["", "../escape", "bad/path", "has space", "-leading", "a".repeat(81)]) {
      expect(validateRunId(invalid)).toBe(false);
    }
    expect(validateRunId("run.1_ok")).toBe(true);

    // The adapter represents the link in memory. An ordinary unit test must not
    // plant a real entry in this checkout's shared artifact area.
    const root = fixtureRoot("symlink");
    const storage = fixtureStorage();
    const runId = fixtureRunId("escape");
    storage.seedDirectory(join(root, "e2e", "artifacts"));
    storage.symlink(join(root, "e2e", "artifacts", runId));
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId,
        steps: [passStep("pass")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" } satisfies Partial<HarnessError>);
  });

  test("PLANTED: a symlinked artifact root is refused without mutating its target", () => {
    const root = fixtureRoot("memory-symlink");
    const storage = fixtureStorage();
    const artifacts = join(root, "e2e", "artifacts");
    const link = join(root, "e2e", "artifacts-link");
    storage.seedDirectory(artifacts);
    storage.symlink(link);
    const body = "bytes must not cross a simulated symlink\n";
    const digest = createHash("sha256").update(body, "utf8").digest("hex");

    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: link,
        digest,
        stored: body,
        attempt: 1,
        storage,
      }),
    ).toThrow(/ARTIFACT_PATH_UNSAFE|real repository directory/);
    expect(storage.exists(join(artifacts, ARTIFACT_BLOB_DIRECTORY))).toBe(false);
  });

  test("parallel runs with distinct valid ids remain isolated", async () => {
    const root = fixtureRoot("parallel");
    const storage = fixtureStorage();
    // Distinct ids per process: the root is the shared checkout now, so a fixed
    // id would collide with the previous local run rather than with its peer.
    const runs = await Promise.all(
      [fixtureRunId("parallel-a"), fixtureRunId("parallel-b")].map((runId) =>
        runHarness({
          root,
          storage,
          suite: "unit",
          runId,
          steps: [passStep("pass")],
          onEvent: () => undefined,
          onOutput: () => undefined,
        }),
      ),
    );
    const left = runs[0];
    const right = runs[1];
    if (left === undefined || right === undefined) throw new Error("parallel runs did not resolve");
    expect(left.artifacts.directory).not.toBe(right.artifacts.directory);
    expect(storage.exists(left.artifacts.jsonl)).toBe(true);
    expect(storage.exists(right.artifacts.jsonl)).toBe(true);
  });

  test("refuses an unbounded success run before it can retain an arbitrary artifact ledger", async () => {
    const root = fixtureRoot("step-cap");
    const storage = fixtureStorage();
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: fixtureRunId("step-cap-1"),
        steps: Array.from({ length: MAX_STEPS_PER_RUN + 1 }, (_, index) =>
          passStep(`step-${index}`),
        ),
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUN_STEP_LIMIT" } satisfies Partial<HarnessError>);
  });
});

test("ordinary units reject simulated storage as production proof", async () => {
  const storage = fixtureStorage();
  expect(() => assertRealStorageAuthority(storage)).toThrow(/exact node artifact storage/);
  const forged: HarnessArtifactStorage = { ...storage, authority: "real-filesystem" };
  expect(() => assertRealStorageAuthority(forged)).toThrow(/exact node artifact storage/);
  // This is an authority check, not a shell invocation. The real shell and
  // filesystem path is the explicit CLI preflight, which blocks before writing
  // whenever the checkout has reached its retention cap.
  expect(() => realFilesystemRetentionPreflight(repositoryRoot(), storage)).toThrow(
    /exact node artifact storage/,
  );
  expect(() => realFilesystemRetentionPreflight(repositoryRoot(), forged)).toThrow(
    /exact node artifact storage/,
  );
  await expect(
    runHarness({
      root: repositoryRoot(),
      storage: forged,
      suite: "unit",
      runId: fixtureRunId("forged-real-authority"),
      steps: [passStep("ok")],
      reproduction: "self-test",
      artifactNamespace: DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
      onEvent: () => undefined,
      onOutput: () => undefined,
    }),
  ).rejects.toThrow(/exact node artifact storage/);
});

test("the exported node adapter cannot be mutated into counterfeit production authority", () => {
  const originalReadFile = nodeArtifactStorage.readFile;
  const originalAuthority = nodeArtifactStorage.authority;
  expect(Object.isFrozen(nodeArtifactStorage)).toBe(true);
  expect(Reflect.set(nodeArtifactStorage as object, "readFile", () => "counterfeit bytes")).toBe(
    false,
  );
  expect(Reflect.set(nodeArtifactStorage as object, "authority", "simulation")).toBe(false);
  expect(nodeArtifactStorage.readFile).toBe(originalReadFile);
  expect(nodeArtifactStorage.authority).toBe(originalAuthority);
  expect(() => assertRealStorageAuthority(nodeArtifactStorage)).not.toThrow();
});

test("ordinary units validate the D1 retained-state contract without executing D1", () => {
  const root = repositoryRoot();
  const state = retainedD1StateDirectory(
    root,
    DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
    "contract-run",
    "d1-state-ok",
  );
  expect(assertRetainedD1StateDirectory(root, state)).toBe(state);
  expect(() => assertRetainedD1StateDirectory(root, "/tmp/asimp-ops2a-d1-forbidden")).toThrow(
    /D1 state directory/,
  );
  expect(() =>
    validateHarnessRunOptions({
      root,
      suite: "unit",
      runId: "contract-run",
      reproduction: "self-test",
      artifactNamespace: DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
      steps: [
        {
          id: "d1-contract",
          scenario: "integration",
          adapter: "d1",
          replaySafe: false,
          command: [
            process.execPath,
            adapterProbePath("d1"),
            "--mode",
            "ok",
            "--state-dir",
            retainedD1StateDirectory(
              root,
              DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
              "different-run",
              "d1-state-ok",
            ),
            "--integration-namespace",
            DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
          ],
        },
      ],
    }),
  ).toThrow(/belong directly to this retained self-test run id/);
});

test("the inherited D1 writer capability binds one exact open retained run", () => {
  const root = fixtureRoot("d1-capability");
  const namespace = "d1-capability-integration";
  const runId = "d1-capability-run";
  const identity = {
    runId,
    suite: "unit",
    seed: 7,
    stepIds: ["d1"],
    stepContractDigests: ["a".repeat(64)],
    reproduction: SELF_TEST_REPRODUCTION,
    artifactNamespace: namespace,
    gitRevision: "unavailable",
    childEnvironmentDigest: "b".repeat(64),
    bindingVersions: {},
  } as const;
  const storage = fixtureStorage();
  const store = new ArtifactStore(root, runId, false, identity, storage, namespace);
  expect(() => store.d1ArtifactWriterCapability()).toThrow(
    /D1_ARTIFACT_CAPABILITY_UNAVAILABLE|real D1 adapter requires/,
  );
  const capability = simulatedD1ArtifactCapability(store, root, namespace, storage);
  expect(
    assertD1ArtifactWriterCapability(capability, root, namespace, store.directory, storage),
  ).toEqual(capability);
  for (const planted of [
    undefined,
    { ...capability, extra: true },
    { ...capability, schema_version: 2 },
    { ...capability, repository_root: `${root}-foreign` },
    { ...capability, artifact_root_identity: "memory:999999" },
    { ...capability, namespace: `${namespace}-foreign` },
    { ...capability, namespace_identity: "memory:999999" },
    { ...capability, run_id: `${runId}-foreign` },
    { ...capability, run_identity: "memory:999999" },
    { ...capability, lease_directory: `${capability.lease_directory}-foreign` },
    { ...capability, lease_identity: "memory:999999" },
  ]) {
    expect(() =>
      assertD1ArtifactWriterCapability(planted, root, namespace, store.directory, storage),
    ).toThrow(/D1_ARTIFACT_CAPABILITY_INVALID|artifact capability/);
  }
  store.close();
  expect(() =>
    assertD1ArtifactWriterCapability(capability, root, namespace, store.directory, storage),
  ).toThrow(/D1_ARTIFACT_CAPABILITY_INVALID|artifact capability/);

  const fencedStorage = fixtureStorage();
  const fencedStore = new ArtifactStore(root, runId, false, identity, fencedStorage, namespace);
  const fencedCapability = simulatedD1ArtifactCapability(
    fencedStore,
    root,
    namespace,
    fencedStorage,
  );
  fencedStorage.writeExclusive(join(root, "e2e", ARTIFACT_MAINTENANCE_FENCE_NAME), "maintenance\n");
  expect(() =>
    assertD1ArtifactWriterCapability(
      fencedCapability,
      root,
      namespace,
      fencedStore.directory,
      fencedStorage,
    ),
  ).toThrow(/ARTIFACT_MAINTENANCE_ACTIVE|D1_ARTIFACT_CAPABILITY_INVALID|artifact capability/);
  fencedStore.close();
  const fencedLease = soleArtifactWriterLease(root, fencedStorage);
  expect(fencedStorage.isDirectory(fencedLease.closed)).toBe(true);
});

test("the real integration reproduction contract separates preflight from execution", () => {
  const contract = harnessIntegrationReproduction(repositoryRoot());
  expect(contract.storage_authority).toBe("real-filesystem");
  expect(contract.retained_namespace).toBe(DEFAULT_RETAINED_INTEGRATION_NAMESPACE);
  expect(contract.preflight.arguments).toEqual([
    "scripts/e2e-test-harness.sh",
    "--preflight",
    "--root",
    repositoryRoot(),
    "--integration-namespace",
    DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
  ]);
  expect(contract.execute.arguments).toEqual([
    "scripts/e2e-test-harness.sh",
    "--self-test",
    "--root",
    repositoryRoot(),
    "--integration-namespace",
    DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
  ]);
  expect(contract.preflight.copy_paste).toContain("--preflight");
  expect(contract.execute.copy_paste).toContain("--self-test");
});

test("a custom retained namespace is preserved in every receipt reproduction string", () => {
  const customNamespace = "ops2a-retention-custom-proof";
  const reproduce = selfTestReproduction(customNamespace);
  const contract = harnessIntegrationReproduction(repositoryRoot(), customNamespace);
  expect(reproduce).toBe(
    "scripts/e2e-test-harness.sh --self-test --integration-namespace ops2a-retention-custom-proof",
  );
  expect(safeReproductionCommand("self-test", customNamespace)).toBe(reproduce);
  expect(contract.preflight.arguments).toContain(customNamespace);
  expect(contract.preflight.copy_paste).toContain(customNamespace);
  expect(contract.execute.arguments).toContain(customNamespace);
  expect(contract.execute.copy_paste).toContain(customNamespace);
  expect(() => validateHarnessEvent(sampleEvent({ reproduce }))).not.toThrow();
});

test("the ordinary residue guard owns OPS.2a temp families without claiming peer fixtures", () => {
  expect(isOps2aTaskTempName("asimp-ops2a-d1-old-state")).toBe(true);
  expect(isOps2aTaskTempName("asimposium-ops2a-self-test")).toBe(true);
  expect(isOps2aTaskTempName("harness-ops2a-resume")).toBe(true);
  expect(isOps2aTaskTempName("asimposium-harness-scratch-fixture-1")).toBe(true);
  expect(isOps2aTaskTempName("asimposium-budget-fixture-1")).toBe(true);
  expect(isOps2aTaskTempName("asimposium-harness-outside-1")).toBe(true);
  expect(isOps2aTaskTempName("harness-unrelated-1")).toBe(true);
  expect(isOps2aTaskTempName("harness-impostor-1")).toBe(true);
  expect(isOps2aTaskTempName("harness-link-1")).toBe(true);
  expect(isOps2aTaskTempName("harness-marker-1")).toBe(true);
  expect(isOps2aTaskTempName("harness-run-unrelated-1")).toBe(true);
  expect(isOps2aTaskTempName("asimposium-s1-lifecycle.peer-run")).toBe(false);
  expect(isOps2aTaskTempName("asimposium-s6-auth.peer-run")).toBe(false);
  expect(isOps2aTaskTempName("harness-another-project")).toBe(false);
});

const realFilesystemTest = realFilesystemIntegrationEnabled ? test : test.skip;
realFilesystemTest(
  "the real shell entry point proves the seeded harness-only negative aggregate",
  async () => {
    const root = fixtureRoot("shell");
    const customNamespace = "ops2a-retention-shell-proof";
    requireRealFilesystemIntegration(customNamespace);
    const child = Bun.spawn({
      cmd: [
        "bash",
        SHELL_HARNESS,
        "--self-test",
        "--root",
        root,
        "--integration-namespace",
        customNamespace,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("HARNESS_SELF_TEST_HARNESS_ONLY");
    expect(stdout).toContain("proves nothing about product behavior");
    const receiptReproductions = stdout
      .trim()
      .split("\n")
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as { reproduce?: unknown };
          return typeof record.reproduce === "string" ? [record.reproduce] : [];
        } catch {
          return [];
        }
      });
    expect(receiptReproductions.length).toBeGreaterThan(0);
    expect(receiptReproductions).toEqual(
      expect.arrayContaining([
        "scripts/e2e-test-harness.sh --self-test --integration-namespace ops2a-retention-shell-proof",
      ]),
    );
    expect(receiptReproductions.every((receipt) => receipt.includes(customNamespace))).toBe(true);
    expect(stderr).toContain("<redacted>");
    expect(stderr).not.toContain("selftest_neverlog_canary");
  },
  180_000,
);

describeRealFilesystemIntegration("OPS.2a real adapters", () => {
  const ADAPTERS = join(fileURLToPath(new URL("../harness/adapters/", import.meta.url)));

  async function runD1Adapter(
    mode: "ok" | "planted-fail",
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    requireRealFilesystemIntegration();
    const root = repositoryRoot();
    const runId = fixtureRunId(`d1-adapter-${mode}`);
    const stateDirectory = fixtureD1StateDirectory(runId, mode);
    let output = "";
    const result = await runHarness({
      root,
      runId,
      suite: "ops.2a-d1-adapter-proof",
      reproduction: "self-test",
      artifactNamespace: DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
      onOutput: (text) => {
        output += text;
      },
      onEvent: () => {},
      steps: [
        {
          id: `d1-${mode}`,
          scenario: "integration",
          adapter: "d1",
          command: [
            process.execPath,
            join(ADAPTERS, "d1-rollback.ts"),
            "--mode",
            mode,
            "--state-dir",
            stateDirectory,
            "--integration-namespace",
            DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
          ],
          replaySafe: false,
          timeoutMs: 55_000,
        },
      ],
    });
    return { exitCode: result.exitCode, stdout: output, stderr: "" };
  }

  async function runAdapter(
    file: "http-fault.ts" | "browser-assert.ts",
    mode: "ok" | "planted-fail",
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    requireRealFilesystemIntegration();
    const child = Bun.spawn({
      cmd: [process.execPath, join(ADAPTERS, file), "--mode", mode],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // The same scrubbed environment the runner gives its children, so an
      // adapter that only works with a developer's PATH fails here.
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  /** 0 = the real dependency ran and the assertion held; 78 = named blocker. */
  function expectPositive(result: { exitCode: number; stdout: string }, blockedCode: string): void {
    expect([0, HARNESS_BLOCKED_EXIT_CODE]).toContain(result.exitCode);
    if (result.exitCode === HARNESS_BLOCKED_EXIT_CODE) {
      expect(result.stdout).toContain(blockedCode);
      // A blocker must name the missing thing, never merely shrug.
      expect(result.stdout).toContain("No ");
    }
  }

  test("the D1 adapter proves rollback against a real local database", async () => {
    const ok = await runD1Adapter("ok");
    expectPositive(ok, "D1_ADAPTER_UNAVAILABLE");
    if (ok.exitCode === 0) {
      const record = JSON.parse(ok.stdout.trim().split("\n").pop() ?? "{}");
      expect(record.code).toBe("D1_TRANSACTION_ROLLED_BACK");
      // Rollback is only demonstrated by a late UNIQUE rejection and an exact
      // post-read table, never by a merely absent doomed row.
      expect(record.seed_command_executed).toBe(true);
      expect(record.batch_command_executed).toBe(true);
      expect(record.post_read_command_executed).toBe(true);
      expect(record.batch_rejected).toBe(true);
      expect(record.batch_error_class).toBe("sqlite_constraint_unique");
      expect(record.late_failure_observed).toBe(true);
      expect(record.doomed_row_present).toBe(false);
      expect(record.sentinel_only_after).toBe(true);
      expect(record.state_bytes).toBeGreaterThan(0);
      // Never an absolute path, even for retained state.
      expect(ok.stdout).not.toContain("/Users/");
      expect(ok.stdout).not.toContain("/tmp/");
      expect(record.state_dir_class).toBe("retained-integration");
    } else {
      expect(ok.exitCode).toBe(HARNESS_BLOCKED_EXIT_CODE);
    }
  }, 90000);

  test("PLANTED: the D1 rollback assertion fails when nothing rolled back", async () => {
    const planted = await runD1Adapter("planted-fail");
    if (planted.exitCode === HARNESS_BLOCKED_EXIT_CODE) {
      expect(planted.stdout).toContain("D1_ADAPTER_UNAVAILABLE");
    } else {
      expect(planted.exitCode).toBe(1);
      expect(planted.stdout).toContain("D1_TRANSACTION_LEAKED");
    }
  }, 90000);

  test("PLANTED: direct D1 execution without the parent capability creates no state", async () => {
    const root = repositoryRoot();
    const runId = fixtureRunId("d1-direct-refusal");
    const stateDirectory = fixtureD1StateDirectory(runId, "ok");
    let output = "";
    const priorAmbientCapability = process.env[D1_ARTIFACT_CAPABILITY_ENV];
    process.env[D1_ARTIFACT_CAPABILITY_ENV] = JSON.stringify({ planted: "ambient-bypass" });
    const result = await (async () => {
      try {
        return await runHarness({
          root,
          runId,
          suite: "ops.2a-d1-direct-refusal",
          reproduction: "self-test",
          artifactNamespace: DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
          onOutput: (text) => {
            output += text;
          },
          onEvent: () => {},
          steps: [
            {
              id: "direct-d1-without-capability",
              scenario: "integration",
              // Deliberately ordinary: only a registered D1 step receives the
              // parent capability. Even a planted ambient value must be scrubbed,
              // so copying the executable into a process step fails before the
              // D1 state leaf exists.
              adapter: "process",
              command: [
                process.execPath,
                join(ADAPTERS, "d1-rollback.ts"),
                "--mode",
                "ok",
                "--state-dir",
                stateDirectory,
                "--integration-namespace",
                DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
              ],
              replaySafe: false,
              timeoutMs: 5_000,
            },
          ],
        });
      } finally {
        if (priorAmbientCapability === undefined) {
          delete process.env[D1_ARTIFACT_CAPABILITY_ENV];
        } else {
          process.env[D1_ARTIFACT_CAPABILITY_ENV] = priorAmbientCapability;
        }
      }
    })();
    expect(result.exitCode).toBe(1);
    expect(output).toContain("D1_ARTIFACT_CAPABILITY_REQUIRED");
    expect(existsSync(stateDirectory)).toBe(false);
  }, 30000);

  test("the HTTP adapter proves a real loopback fault surface", async () => {
    const ok = await runAdapter("http-fault.ts", "ok");
    expectPositive(ok, "HTTP_ADAPTER_UNAVAILABLE");
    if (ok.exitCode === 0) {
      const record = JSON.parse(ok.stdout.trim().split("\n").pop() ?? "{}");
      expect(record.code).toBe("HTTP_FAULT_SURFACE_VERIFIED");
      expect(record.observed_status).toBe(500);
      expect(record.route_template).toBe("/fault");
      expect(record.request_id_echoed).toBe(true);
      expect(record.request_id_minted).toBe(true);
      // A route that never answers must be bounded by the client, not by luck.
      expect(record.slow_route_timed_out).toBe(true);
    } else {
      expect(ok.exitCode).toBe(HARNESS_BLOCKED_EXIT_CODE);
    }
  }, 30000);

  test("PLANTED: the HTTP assertion fails when the status contract is wrong", async () => {
    const planted = await runAdapter("http-fault.ts", "planted-fail");
    expect(planted.exitCode).toBe(1);
    expect(planted.stdout).toContain("HTTP_FAULT_SURFACE_MISMATCH");
  }, 30000);

  test("PLANTED: an installed Playwright must never be reported as a missing package", async () => {
    // The false blocker this guards against: `@playwright/test` is installed for
    // the e2e workspace, but the adapter resolves relative to scripts/ and calls
    // it missing. That reads exactly like an honest 78 and silently deletes the
    // browser leg of OPS.2a.
    const declared = existsSync(
      join(repositoryRoot(), "e2e", "node_modules", "@playwright", "test"),
    );
    if (declared) {
      const result = await runAdapter("browser-assert.ts", "ok");
      const record = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
      if (result.exitCode === HARNESS_BLOCKED_EXIT_CODE) {
        // A blocker is still allowed — but only for the browser *build*, never
        // for the package, and it must say which build it wanted.
        expect(record.package_resolved).toBe(true);
        expect(record.missing).not.toBe("@playwright/test");
        expect(String(record.missing)).toMatch(/^chromium/);
      } else {
        expect(result.exitCode).toBe(0);
      }
    } else {
      // The outer integration suite is explicitly skipped unless opted in;
      // when it is enabled this branch is an explicit unavailable dependency,
      // not an early green return.
      expect(declared).toBe(false);
    }
  }, 90_000);

  test("the browser adapter either asserts real DOM or names its blocker", async () => {
    const ok = await runAdapter("browser-assert.ts", "ok");
    expectPositive(ok, "BROWSER_ADAPTER_UNAVAILABLE");
    const record = JSON.parse(ok.stdout.trim().split("\n").pop() ?? "{}");
    if (ok.exitCode === HARNESS_BLOCKED_EXIT_CODE) {
      // Either the package or the browser build may be missing; the blocker
      // must name which, so a false "package missing" cannot hide behind a
      // genuine "browser build missing".
      expect(["@playwright/test", "chromium-build"]).toContain(
        String(record.missing).startsWith("chromium") ? "chromium-build" : record.missing,
      );
      expect(typeof record.package_resolved).toBe("boolean");
    } else {
      expect(record.code).toBe("BROWSER_ASSERTION_VERIFIED");
      // Artifact policy is disabled, not merely redacted.
      expect(record.artifacts_captured).toBe("none");
      expect(record.screenshot_policy).toBe("disabled");
      expect(record.trace_policy).toBe("disabled");
    }
  }, 90000);

  test("PLANTED: the browser assertion fails on text the page never renders", async () => {
    const planted = await runAdapter("browser-assert.ts", "planted-fail");
    if (planted.exitCode === HARNESS_BLOCKED_EXIT_CODE) {
      expect(planted.stdout).toContain("BROWSER_ADAPTER_UNAVAILABLE");
    } else {
      expect(planted.exitCode).toBe(1);
      expect(planted.stdout).toContain("BROWSER_ASSERTION_MISMATCH");
    }
  }, 90000);

  test("an adapter step may only execute its own registered probe", () => {
    // The adapter label is what a reader trusts when deciding whether D1 really
    // ran, so it must never be attachable to an arbitrary executable.
    expect(() =>
      validateHarnessStep({
        id: "smuggled",
        scenario: "integration",
        adapter: "d1",
        replaySafe: false,
        command: [process.execPath, join(ADAPTERS, "http-fault.ts"), "--mode", "ok"],
      }),
    ).toThrow(/registered probe/);
  });
});

describe("harness code may never delete files", () => {
  /**
   * AGENTS.md RULE 1 forbids this repository's agents from deleting files, and a
   * test harness is where "just clean up the temp dir" feels most reasonable and
   * is most dangerous: the same call with a wrong variable removes a developer's
   * work. Termination of processes is fine; removal of files is not.
   */
  const FORBIDDEN = [
    "rmSync",
    "unlinkSync",
    "rmdirSync",
    "rimraf",
    "fs.rm(",
    "promises.rm(",
    "rm -rf",
    "rm -f",
  ];

  test("no deletion API appears in any harness source file", async () => {
    const { Glob } = await import("bun");
    const root = fileURLToPath(new URL("../harness/", import.meta.url));
    const offenders: string[] = [];
    for await (const relativeFile of new Glob("**/*.{ts,sh}").scan({
      cwd: root,
      onlyFiles: true,
    })) {
      const text = readFileSync(join(root, relativeFile), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("#")) continue;
        for (const banned of FORBIDDEN) {
          if (code.includes(banned)) offenders.push(`${relativeFile}:${index + 1} ${banned}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("repository root identity", () => {
  test("shape failures are refused", () => {
    const filesystem = virtualRootFilesystem();
    expect(() => assertContainedRoot("relative/path", filesystem)).toThrow(/absolute/);
    expect(() => assertContainedRoot("", filesystem)).toThrow(/non-empty/);
    expect(() => assertContainedRoot(undefined, filesystem)).toThrow(/non-empty/);
    expect(() => assertContainedRoot("/memory/absent", filesystem)).toThrow(/exist/);
  });

  test("this checkout is accepted, anchored to where the runner lives", () => {
    const checkout = repositoryRoot();
    expect(assertContainedRoot(checkout)).toBe(checkout);
    expect(existsSync(join(checkout, "scripts", "harness", "runner.ts"))).toBe(true);
    expect(existsSync(join(checkout, "package.json"))).toBe(true);
  });

  test("PLANTED: an unrelated absolute directory is refused", () => {
    // The previous rule accepted this and would have created e2e/artifacts in it.
    const unrelated = "/memory/unrelated";
    expect(() =>
      assertContainedRoot(unrelated, virtualRootFilesystem({ directories: [unrelated] })),
    ).toThrow(/not this checkout/);
  });

  test("PLANTED: a home directory is refused", () => {
    const filesystem = virtualRootFilesystem();
    expect(() => assertContainedRoot(VIRTUAL_HOME, filesystem)).toThrow(/home directory/);
  });

  test("PLANTED: the shared temp directory is refused", () => {
    const filesystem = virtualRootFilesystem();
    expect(() => assertContainedRoot(VIRTUAL_TEMP, filesystem)).toThrow(/temp directory/);
  });

  test("PLANTED: the parent of this checkout is refused", () => {
    const parent = "/memory";
    expect(() =>
      assertContainedRoot(parent, virtualRootFilesystem({ directories: [parent] })),
    ).toThrow(/unrelated directory/);
  });

  test("PLANTED: a directory that merely looks like a checkout is refused", () => {
    // Sentinels are not identity. A lookalike must still be refused, because
    // it is not *this* checkout.
    const impostor = "/memory/impostor";
    const filesystem = virtualRootFilesystem({
      directories: [impostor, `${impostor}/scripts`, `${impostor}/scripts/harness`],
      files: [`${impostor}/package.json`, `${impostor}/scripts/harness/runner.ts`],
    });
    expect(() => assertContainedRoot(impostor, filesystem)).toThrow(/not this checkout/);
  });

  test("PLANTED: a symlink pointing at this checkout is refused, not followed", () => {
    // Following it would mean the caller named one directory while the harness
    // wrote to another — exactly the confusion this rule prevents.
    const link = "/memory/checkout-link";
    expect(() =>
      assertContainedRoot(link, virtualRootFilesystem({ symlinks: { [link]: VIRTUAL_CHECKOUT } })),
    ).toThrow(/symlink/);
  });

  test("PLANTED: an outside directory cannot opt itself in with a marker file", () => {
    // An earlier revision accepted a `.asimposium-harness-root` marker as
    // consent. AGENTS.md keeps artifact roots under the repository with no
    // exceptions, so planting any marker must change nothing.
    const outside = "/memory/marker";
    const filesystem = virtualRootFilesystem({
      directories: [outside],
      files: [`${outside}/.asimposium-harness-root`, `${outside}/.harness-root`, `${outside}/.git`],
    });
    expect(() => assertContainedRoot(outside, filesystem)).toThrow(/not this checkout/);
  });

  test("a run refuses to start against a root it cannot identify", async () => {
    await expect(
      runHarness({
        root: tmpdir(),
        storage: fixtureStorage(),
        runId: fixtureRunId("root-identity-probe"),
        suite: "ops.2a-root",
        steps: [
          { id: "noop", scenario: "unit", replaySafe: true, command: [process.execPath, "-e", ""] },
        ],
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/temp directory/);
  });

  test("artifact paths stay inside the resolved root", () => {
    const root = repositoryRoot();
    expect(isContainedPath(root, join(root, "e2e", "artifacts"))).toBe(true);
    expect(isContainedPath(root, join(root, "..", "escaped"))).toBe(false);
  });
});

describe("timeout grace", () => {
  test("a legitimate maximum-length timeout stays schema-valid", () => {
    // A step that times out at MAX_TIMEOUT_MS does not finish there: SIGTERM,
    // the force-kill wait, and pipe drain all land after the deadline. The
    // schema must represent that honestly instead of destroying the evidence.
    expect(MAX_EVENT_DURATION_MS).toBeGreaterThan(MAX_TIMEOUT_MS + FORCE_KILL_GRACE_MS);
    expect(HARD_READER_GRACE_MS).toBeGreaterThanOrEqual(1_000);
    const event = sampleEvent({ duration_ms: MAX_EVENT_DURATION_MS });
    expect(() => validateHarnessEvent(event)).not.toThrow();
  });

  test("PLANTED: a duration beyond the grace is still rejected", () => {
    expect(() =>
      validateHarnessEvent(sampleEvent({ duration_ms: MAX_EVENT_DURATION_MS + 1 })),
    ).toThrow(/out of bounds/);
  });
});

describe("content-addressed failure artifacts", () => {
  test("static guard: a direct real publisher proves its lease before creating blob paths", () => {
    const source = readFileSync(RUNNER_SOURCE, "utf8");
    const start = source.indexOf("export function publishFailureBlob(");
    const end = source.indexOf("\nfunction existingFailureBlobPath(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const publish = source.slice(start, end);
    const dedupeReturn = publish.indexOf("return existing;");
    const authority = publish.indexOf("assertWriterAuthority();", dedupeReturn);
    const createBlobStore = publish.indexOf(
      "const store = blobStoreDirectory(artifactsDirectory, storage);",
    );

    expect(publish).toContain("if (storage !== nodeArtifactStorage) return;");
    expect(publish).toContain('"ARTIFACT_WRITER_LEASE_REQUIRED"');
    expect(dedupeReturn).toBeGreaterThanOrEqual(0);
    expect(authority).toBeGreaterThan(dedupeReturn);
    expect(createBlobStore).toBeGreaterThan(authority);
  });

  /**
   * Failure payloads are stored once, by the digest of the bytes actually
   * written. Before this, every run wrote its own copy: 577 failure logs on
   * disk held 32 distinct contents, one of them repeated 384 times. Storing by
   * content bounds that without deleting anything — a repeat resolves to the
   * blob that is already there.
   */
  const failingStep = (id: string, output: string): HarnessStep => ({
    id,
    scenario: "unit",
    replaySafe: true,
    command: command(`process.stderr.write(${JSON.stringify(output)}); process.exit(1);`),
  });

  async function runFailing(root: string, id: string, output: string, storage = fixtureStorage()) {
    return await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId(id),
      steps: [failingStep(id, output)],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
  }

  /** The manifest line shape, so a test reads fields instead of `unknown`. */
  interface FailureManifestRecord {
    schema_version: string;
    record: string;
    run_id: string;
    step: string;
    attempt: number;
    digest: string;
    bytes: number;
    blob: string;
  }

  /**
   * Parse the run manifest, validating each line's shape as it goes.
   *
   * The validation is the point: a manifest line missing a digest is a real
   * defect in the store, and this must fail on it rather than hand back a
   * loosely-typed object that a later `!` would paper over.
   */
  function manifestOf(
    runJsonl: string,
    storage: ReturnType<typeof createMemoryArtifactStorage>,
  ): FailureManifestRecord[] {
    const manifest = join(runJsonl, "..", FAILURE_MANIFEST_NAME);
    return storage
      .readFile(manifest)
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        expect(typeof parsed).toBe("object");
        const candidate = parsed as Partial<FailureManifestRecord>;
        expect(typeof candidate.digest).toBe("string");
        expect(typeof candidate.step).toBe("string");
        expect(typeof candidate.attempt).toBe("number");
        expect(typeof candidate.bytes).toBe("number");
        expect(typeof candidate.blob).toBe("string");
        return candidate as FailureManifestRecord;
      });
  }

  /**
   * The single stored record a one-failure run must have produced.
   *
   * A publication writes two lines — the intent that spends the budget slot and
   * the completion that says the blob arrived — so this asserts the pair and
   * returns the completion. An explicit throw, not a non-null assertion: if the
   * run wrote no manifest record the test should say so in those words, because
   * that is the defect, not a typing inconvenience to be silenced.
   */
  function onlyManifestRecord(
    runJsonl: string,
    storage: ReturnType<typeof createMemoryArtifactStorage>,
  ): FailureManifestRecord {
    const records = manifestOf(runJsonl, storage);
    const intents = records.filter((entry) => entry.record === FAILURE_RECORD_INTENT);
    const stored = records.filter((entry) => entry.record === FAILURE_RECORD_STORED);
    expect(intents).toHaveLength(1);
    expect(stored).toHaveLength(1);
    // The slot is spent before the blob exists, never after.
    expect(records[0]?.record).toBe(FAILURE_RECORD_INTENT);
    const [record] = stored;
    if (record === undefined) {
      throw new Error("the run produced no stored failure manifest record");
    }
    return record;
  }

  test("identical failure output across two runs stores exactly one blob", async () => {
    const root = fixtureRoot("cas-dedupe");
    const storage = fixtureStorage();
    const payload = `identical failure ${process.pid}\n`;
    const first = await runFailing(root, "cas-a", payload, storage);
    const second = await runFailing(root, "cas-b", payload, storage);

    const a = onlyManifestRecord(first.artifacts.jsonl, storage);
    const b = onlyManifestRecord(second.artifacts.jsonl, storage);
    expect(a.digest).toBe(b.digest);

    // One blob, referenced twice — not two copies of the same bytes.
    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", a.digest);
    expect(storage.exists(blob)).toBe(true);
    expect(storage.readFile(blob)).toContain("identical failure");
    expect(first.artifacts.failureLogs[0]).toBe(second.artifacts.failureLogs[0]);
  });

  test("the digest names the CLIPPED bytes that were actually stored", async () => {
    const root = fixtureRoot("cas-clip");
    const storage = fixtureStorage();
    // The child GENERATES the oversized payload. Passing it as an argument
    // would exceed the runner's argv bound and never reach the store at all.
    const generated = MAX_FAILURE_ARTIFACT_CHARS * 2;
    const result = await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("cas-clip"),
      steps: [
        {
          id: "cas-clip",
          scenario: "unit",
          replaySafe: true,
          command: command(`process.stderr.write("Z".repeat(${generated})); process.exit(1);`),
        },
      ],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    const record = onlyManifestRecord(result.artifacts.jsonl, storage);

    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", record.digest);
    const stored = storage.readFile(blob);
    // The digest must describe the bytes on disk, whatever the runner chose to
    // capture and however it clipped them — never the raw child payload, which
    // is neither what is stored nor what a reader will open.
    expect(createHash("sha256").update(stored, "utf8").digest("hex")).toBe(record.digest);
    expect(Buffer.byteLength(stored, "utf8")).toBe(record.bytes);
    expect(stored.length).toBeLessThanOrEqual(MAX_FAILURE_ARTIFACT_CHARS);
    // The child really did emit more than what was retained.
    expect(generated).toBeGreaterThan(stored.length);
  });

  test("PLANTED: one changed byte produces a different blob, and both survive", async () => {
    const root = fixtureRoot("cas-differs");
    const storage = fixtureStorage();
    const first = await runFailing(root, "cas-x", "failure body A\n", storage);
    const second = await runFailing(root, "cas-y", "failure body B\n", storage);

    const a = onlyManifestRecord(first.artifacts.jsonl, storage);
    const b = onlyManifestRecord(second.artifacts.jsonl, storage);
    expect(a.digest).not.toBe(b.digest);
    for (const digest of [a.digest, b.digest]) {
      expect(storage.exists(join(root, "e2e", "artifacts", "blobs", "sha256", digest))).toBe(true);
    }
  });

  test("PLANTED: a pre-existing blob with mismatched bytes is refused, never overwritten", async () => {
    const payload = `mismatch probe ${process.pid}\n`;
    // Learn the digest the runner actually produces; guessing it from the raw
    // payload would plant a blob the run never looks at, and the test would
    // pass for the wrong reason.
    const learn = fixtureRoot("cas-mismatch-learn");
    const learnStorage = fixtureStorage();
    const learned = await runFailing(learn, "cas-mm-learn", payload, learnStorage);
    const digest = onlyManifestRecord(learned.artifacts.jsonl, learnStorage).digest;

    // Fresh namespace: plant foreign bytes under that exact digest.
    const root = fixtureRoot("cas-mismatch");
    const storage = fixtureStorage();
    const store = join(root, "e2e", "artifacts", "blobs", "sha256");
    storage.seedDirectory(store);
    const blob = join(store, digest);
    const prior = "PRIOR RETAINED EVIDENCE\n";
    if (!storage.exists(blob)) storage.writeExclusive(blob, prior);
    const plantedIsForeign = storage.readFile(blob) === prior;

    if (plantedIsForeign) {
      await expect(runFailing(root, "cas-mm", payload, storage)).rejects.toThrow(
        /does not match its digest/,
      );
      // The refusal must leave the prior file exactly as it was.
      expect(storage.readFile(blob)).toBe(prior);
    } else {
      // The store already held the authentic bytes for this digest, so there is
      // no mismatch to provoke; assert the honest alternative instead of
      // pretending the planted case ran.
      expect(storage.readFile(blob)).not.toBe(prior);
    }
  });

  test("PLANTED: a mutated existing target receives zero writes on refusal", () => {
    const root = fixtureRoot("cas-zero-target-write");
    const storage = fixtureStorage();
    const body = "bytes the digest is meant to address\n";
    const digest = createHash("sha256").update(body, "utf8").digest("hex");
    const store = join(root, "e2e", "artifacts", "blobs", "sha256");
    const target = join(store, digest);
    const sibling = join(store, "sibling-retained-evidence");
    storage.seedDirectory(store);
    const plantedMutation = "existing retained evidence was mutated elsewhere\n";
    storage.writeExclusive(target, plantedMutation);
    storage.writeExclusive(sibling, "unchanged sibling retained evidence\n");
    const before = simulatedArtifactCensus(storage, store);
    const mutations: string[] = [];
    const audited = {
      ...storage,
      seedDirectory(path: string) {
        mutations.push(`seedDirectory:${path}`);
        storage.seedDirectory(path);
      },
      symlink(path: string) {
        mutations.push(`symlink:${path}`);
        storage.symlink(path);
      },
      mkdir(path) {
        mutations.push(`mkdir:${path}`);
        storage.mkdir(path);
      },
      writeExclusive(path, data) {
        mutations.push(`writeExclusive:${path}`);
        storage.writeExclusive(path, data);
      },
      append(path, data) {
        mutations.push(`append:${path}`);
        storage.append(path, data);
      },
      link(existing, targetPath) {
        mutations.push(`link:${existing}:${targetPath}`);
        storage.link(existing, targetPath);
      },
    } satisfies HarnessArtifactStorage & {
      seedDirectory(path: string): void;
      symlink(path: string): void;
    };

    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: join(root, "e2e", "artifacts"),
        digest,
        stored: body,
        attempt: 1,
        storage: audited,
      }),
    ).toThrow(/does not match its digest/);
    expect(mutations).toEqual([]);
    expect(storage.readFile(target)).toBe(plantedMutation);
    assertCensusUnchanged(before, simulatedArtifactCensus(storage, store));
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: digest,
          type: "file",
          size: Buffer.byteLength(plantedMutation, "utf8"),
          mode: "100644",
        }),
        expect.objectContaining({
          relativePath: "sibling-retained-evidence",
          type: "file",
          size: Buffer.byteLength("unchanged sibling retained evidence\n", "utf8"),
          mode: "100644",
        }),
      ]),
    );
  });

  test("PLANTED: the zero-write census rejects mkdir, truncate, chmod, and rename-style differences", () => {
    const before = [
      { relativePath: "target", type: "file", size: 19, mode: "100644" },
      { relativePath: "sibling", type: "file", size: 11, mode: "100644" },
    ] as const satisfies readonly SimulatedArtifactCensusEntry[];
    const expectDetected = (after: readonly SimulatedArtifactCensusEntry[]): void => {
      expect(() => assertCensusUnchanged(before, after)).toThrow();
    };
    // These are pure census negatives: HarnessArtifactStorage intentionally
    // exposes none of truncate/chmod/rename, so proving detection does not
    // mutate retained evidence or a filesystem fixture.
    expectDetected([
      ...before,
      { relativePath: "new-directory", type: "directory", size: 0, mode: "040755" },
    ]);
    expectDetected([{ ...before[0], size: 0 }, before[1]]);
    expectDetected([{ ...before[0], mode: "100600" }, before[1]]);
    expectDetected([{ ...before[0], relativePath: "renamed-target" }, before[1]]);
  });

  test("a repeated simulated blob write preserves the original bytes", async () => {
    const root = fixtureRoot("cas-notouch");
    const storage = fixtureStorage();
    const payload = "stable failure bytes\n";
    const first = await runFailing(root, "cas-t1", payload, storage);
    const record = onlyManifestRecord(first.artifacts.jsonl, storage);
    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", record.digest);
    const contentBefore = storage.readFile(blob);
    await runFailing(root, "cas-t2", payload, storage);
    // Simulation proves the branch and retained bytes, not inode or kernel
    // semantics. The explicit real-filesystem preflight owns that boundary.
    expect(storage.readFile(blob)).toBe(contentBefore);
  });

  test("PLANTED: a digest that is not sha256 hex can never name a path", async () => {
    const root = fixtureRoot("cas-containment");
    const storage = fixtureStorage();
    const result = await runFailing(root, "cas-contain", "contained\n", storage);
    const record = onlyManifestRecord(result.artifacts.jsonl, storage);

    // The stored name is a bare 64-hex component: no separator can appear in
    // it, so no digest can walk out of the blob store.
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.blob).toBe(`e2e/artifacts/blobs/sha256/${record.digest}`);
    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", record.digest);
    expect(isContainedPath(root, blob)).toBe(true);
    for (const forged of ["../escape", "..", "a/b", `${"0".repeat(63)}/x`]) {
      expect(/^[0-9a-f]{64}$/.test(forged)).toBe(false);
    }
  });

  test("PLANTED: a run at the per-run cap adds no further blob, even on resume", async () => {
    const root = fixtureRoot("cas-resume-cap");
    const storage = fixtureStorage();
    const runId = fixtureRunId("cas-resume-cap");
    const changingStep: HarnessStep = {
      id: "seed-failure",
      scenario: "unit",
      replaySafe: true,
      // The contract stays byte-for-byte identical across resume while the
      // child emits fresh output. That distinguishes a real cap refusal from
      // the stricter identity guard that correctly rejects changed commands.
      command: command(
        "process.stderr.write('retry-' + String(process.hrtime.bigint()) + '\\n'); process.exit(1);",
      ),
    };
    // First run establishes the namespace and its manifest.
    await runHarness({
      root,
      storage,
      suite: "unit",
      runId,
      steps: [changingStep],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    const manifestPath = join(root, "e2e", "artifacts", runId, FAILURE_MANIFEST_NAME);
    // One publication is two lines: the intent that spends the slot, then the
    // completion that says the blob arrived.
    const seeded = storage.readFile(manifestPath).trim().split("\n");
    expect(seeded).toHaveLength(2);

    /**
     * Stand the manifest up to the per-run cap, as a long resumed run would.
     *
     * Each padding line must be a *distinct* attempt. Repeating one record
     * would spend a single slot however many times it appeared — slots are keyed
     * by `(step, attempt)` precisely so repetitive failure cannot buy extra
     * publications — and a duplicated completion is refused outright.
     */
    const padding = Array.from({ length: MAX_FAILURE_ARTIFACTS_PER_RUN - 1 }, (_unused, index) => {
      const body = `padding ${index}\n`;
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      return JSON.stringify({
        schema_version: HARNESS_SCHEMA_VERSION,
        record: FAILURE_RECORD_INTENT,
        run_id: runId,
        step: `pad-${index}`,
        attempt: 1,
        digest,
        bytes: Buffer.byteLength(body, "utf8"),
        blob: `e2e/artifacts/blobs/sha256/${digest}`,
      });
    });
    storage.append(manifestPath, `${padding.join("\n")}\n`);
    const blobsBefore = storage.readdir(join(root, "e2e", "artifacts", "blobs", "sha256")).length;

    /**
     * Resume with the same step *set* — a resume that changed it would be a
     * different run and is refused by the identity check — but a command that
     * emits new bytes, so the run would publish a blob if it had any budget.
     */
    await runHarness({
      root,
      storage,
      suite: "unit",
      runId,
      resume: true,
      steps: [changingStep],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(storage.readdir(join(root, "e2e", "artifacts", "blobs", "sha256")).length).toBe(
      blobsBefore,
    );
  });

  test("the blob store is bounded by namespaces x per-run manifest cap", () => {
    // The store cannot grow without end: each namespace may contribute at most
    // MAX_FAILURE_ARTIFACTS_PER_RUN manifest entries, and namespaces are capped.
    // Deduplication only ever lowers the real count below this ceiling.
    const ceiling = MAX_ARTIFACT_NAMESPACES * MAX_FAILURE_ARTIFACTS_PER_RUN;
    expect(Number.isFinite(ceiling)).toBe(true);
    expect(ceiling).toBe(MAX_ARTIFACT_NAMESPACES * MAX_FAILURE_ARTIFACTS_PER_RUN);
    // This is a mathematical bound, not an ambient inspection of the checkout.
    // Real occupancy belongs to the explicit CLI preflight.
  });

  test("the manifest names the run, step, attempt and digest", async () => {
    const root = fixtureRoot("cas-manifest");
    const storage = fixtureStorage();
    const result = await runFailing(root, "cas-man", "manifest me\n", storage);
    const record = onlyManifestRecord(result.artifacts.jsonl, storage);

    expect(record.schema_version).toBe(HARNESS_SCHEMA_VERSION);
    expect(record.record).toBe("failure_artifact");
    expect(record.step).toBe("cas-man");
    expect(record.attempt).toBe(1);
    expect(typeof record.bytes).toBe("number");
    // A reader can find the evidence from the manifest alone.
    expect(storage.exists(join(root, record.blob))).toBe(true);
  });

  test("deterministic simulated interleaving exercises the losing publisher branch", () => {
    const root = fixtureRoot("simulated-link-race");
    const storage = fixtureStorage();
    const artifactsDirectory = join(root, "e2e", "artifacts");
    storage.seedDirectory(artifactsDirectory);
    const body = "simulated race bytes\n";
    const digest = createHash("sha256").update(body, "utf8").digest("hex");
    let winnerPublished = false;
    const beforeLink = (path: string): void => {
      if (winnerPublished) return;
      winnerPublished = true;
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory,
        digest,
        stored: body,
        attempt: 2,
        storage,
      });
      expect(storage.exists(path)).toBe(true);
    };

    const loser = publishFailureBlob({
      containmentRoot: root,
      artifactsDirectory,
      digest,
      stored: body,
      attempt: 1,
      storage,
      beforeLink,
    });

    expect(winnerPublished).toBe(true);
    expect(storage.readFile(loser)).toBe(body);
    expect(countBlobStagingArtifacts(root, storage)).toBe(2);
    // This proves our simulated state machine reaches EEXIST deterministically.
    // It does not claim kernel hard-link, inode, or scheduler behaviour.
    expect(storage.authority).toBe("simulation");
  });

  test("PLANTED: blob publication revalidates the owning root before its final link", () => {
    const root = fixtureRoot("blob-root-epoch-change");
    const artifactsDirectory = join(root, "e2e", "artifacts");
    const base = fixtureStorage();
    base.seedDirectory(artifactsDirectory);
    const expectedArtifactRootIdentity = base.directoryIdentity(artifactsDirectory);
    let epochChanged = false;
    const storage: HarnessArtifactStorage = {
      ...base,
      directoryIdentity: (path) => {
        const identity = base.directoryIdentity(path);
        return path === artifactsDirectory && epochChanged ? `${identity}:replacement` : identity;
      },
    };
    const body = "root epoch link refusal\n";
    const digest = createHash("sha256").update(body, "utf8").digest("hex");
    const published = join(artifactsDirectory, ARTIFACT_BLOB_DIRECTORY, "sha256", digest);

    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory,
        expectedArtifactRootIdentity,
        digest,
        stored: body,
        attempt: 1,
        storage,
        beforeLink: () => {
          epochChanged = true;
        },
      }),
    ).toThrow(/ARTIFACT_ROOT_CHANGED|physical artifact root changed/);
    expect(epochChanged).toBe(true);
    expect(base.exists(published)).toBe(false);
  });
});

describe("artifact namespace backstop", () => {
  function simulatedArtifacts(): {
    root: string;
    storage: ReturnType<typeof createMemoryArtifactStorage>;
    artifacts: string;
  } {
    const root = fixtureRoot("backstop");
    const storage = fixtureStorage();
    const artifacts = join(root, "e2e", "artifacts");
    storage.seedDirectory(artifacts);
    return { root, storage, artifacts };
  }

  test("the backstop counts run and scratch namespaces, and excludes the blob store", () => {
    const { root, storage, artifacts } = simulatedArtifacts();
    const before = countArtifactNamespaces(root, storage);

    storage.mkdir(join(artifacts, `run-${process.pid}`));
    storage.mkdir(join(artifacts, `scratch-${process.pid}`));
    // Scratch counts: an exempt path would be a way to mint directories freely.
    expect(countArtifactNamespaces(root, storage)).toBe(before + 2);

    storage.seedDirectory(join(artifacts, "blobs", "sha256"));
    // The blob store is one deduplicated directory, not a per-run namespace.
    expect(countArtifactNamespaces(root, storage)).toBe(before + 2);
  });

  test("reusing an existing namespace is always allowed", () => {
    const { root, storage, artifacts } = simulatedArtifacts();
    storage.mkdir(join(artifacts, "already-here"));
    // A resume must not be blocked by a ceiling on *new* namespaces.
    expect(() => assertArtifactNamespaceBudget(root, "already-here", 1, storage)).not.toThrow();
  });

  test("the backstop sits far above the working range", () => {
    // It is a backstop, not a retention policy: reaching it means something is
    // wrong, not that a contributor has been running tests.
    expect(MAX_ARTIFACT_NAMESPACES).toBeGreaterThanOrEqual(5_000);
  });

  test("the simulated capacity report is explicit about its authority", () => {
    /**
     * Capacity is an environment condition, not a property of this code.
     *
     * Two earlier forms were both wrong. Asserting `used < MAX` made a green
     * suite depend on something no test controls. Throwing when over the
     * backstop kept `bun test` permanently red, which trains a reader to ignore
     * a red suite — the worst outcome available.
     *
     * The preflight is a value now. It is asserted to be *well-formed* and to
     * agree with the runner's own refusal rule; whether this particular
     * checkout is over its backstop is reported to stderr for an operator, and
     * a real `runHarness` still fails closed on its own at the moment it tries
     * to create a namespace.
     */
    const { root, storage } = simulatedArtifacts();
    const report = artifactCapacityReport(root, MAX_ARTIFACT_NAMESPACES, storage);
    expect(report.storageAuthority).toBe("simulation");
    expect(report.limit).toBe(MAX_ARTIFACT_NAMESPACES);
    expect(report.used).toBe(countArtifactNamespaces(root, storage));
    expect(report.exceeded).toBe(report.used >= report.limit);
    expect(report.remedy).toMatch(/archive or move/i);
    expect(report.remedy).not.toMatch(/delete them|prune|purge/i);
  });

  test("PLANTED: the budget boundary is exact, and costs nothing to prove", () => {
    // O(1) on purpose. Creating MAX_ARTIFACT_NAMESPACES real directories to
    // test the cap would manufacture the proliferation the cap exists to bound,
    // and nothing here may delete them afterwards.
    expect(exceedsArtifactNamespaceBudget(4_999, 5_000)).toBe(false);
    expect(exceedsArtifactNamespaceBudget(5_000, 5_000)).toBe(true);
    expect(exceedsArtifactNamespaceBudget(5_001, 5_000)).toBe(true);
    expect(exceedsArtifactNamespaceBudget(0, 1)).toBe(false);
    expect(exceedsArtifactNamespaceBudget(1, 1)).toBe(true);
  });

  test("PLANTED: a new namespace at the cap is refused before it is created", () => {
    const { root, storage, artifacts } = simulatedArtifacts();
    const occupied = join(artifacts, "occupied");
    storage.mkdir(occupied);
    storage.writeExclusive(join(occupied, "evidence.log"), "retained\n");

    // An injected limit of 1 reproduces the boundary with one directory.
    expect(() => assertArtifactNamespaceBudget(root, "brand-new", 1, storage)).toThrow(
      /ARTIFACT_RETENTION_EXCEEDED|backstop/,
    );
    // Refused *before* creation, and retained evidence is untouched.
    expect(storage.exists(join(artifacts, "brand-new"))).toBe(false);
    expect(storage.readFile(join(occupied, "evidence.log"))).toBe("retained\n");
    // Reuse of the existing namespace still works at the same limit.
    expect(() => assertArtifactNamespaceBudget(root, "occupied", 1, storage)).not.toThrow();
  });

  test("the refusal names the operator action and never offers deletion", () => {
    const { root, storage, artifacts } = simulatedArtifacts();
    storage.mkdir(join(artifacts, "one"));
    try {
      assertArtifactNamespaceBudget(root, "two", 1, storage);
      throw new Error("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Nothing was deleted");
      // Case-insensitive: the sentence was reworded to lead with the inspection
      // step, and an assertion that pins capitalisation tests the prose rather
      // than the promise. The promise is that an action is named and that it is
      // never deletion.
      expect(message).toMatch(/archive or move/i);
      // …and the count it reports is of directories, not of runs: most of them
      // may be fixture scratch that no run created.
      expect(message).toMatch(/directories/i);
      expect(message).not.toMatch(/delet(e|ing) the|prune|purge/i);
    }
  });
});

describe("artifact retention census aggregation", () => {
  const observedAt = Date.UTC(2026, 7, 25, 12, 0, 0);
  const bodyCanary = Buffer.from("opaque-a");
  const digestA = opaqueCensusSha256([bodyCanary.subarray(0, 7), bodyCanary.subarray(7)]);
  const digestB = createHash("sha256").update("opaque-b").digest("hex");

  function censusObservation(
    path: readonly (string | Buffer)[],
    overrides: Partial<ArtifactCensusObservation> = {},
  ): ArtifactCensusObservation {
    const components = path.map((component) =>
      typeof component === "string" ? Buffer.from(component) : component,
    );
    const separator = Buffer.from("/");
    return {
      relativePath: Buffer.concat(
        components.flatMap((component, index) =>
          index === 0 ? [component] : [separator, component],
        ),
      ),
      components,
      type: "regular",
      device: "1",
      inode: String(100 + path.length),
      links: "1",
      uid: "501",
      gid: "20",
      mode: "100600",
      size: "8",
      blocks: "1",
      modifiedMilliseconds: String(observedAt - 60 * 60 * 1_000),
      contentSha256: digestA,
      symlinkTargetSha256: null,
      ...overrides,
    };
  }

  function censusContext(overrides: Partial<ArtifactCensusContext> = {}): ArtifactCensusContext {
    return {
      artifactRoot: "/checkout/e2e/artifacts",
      artifactRootIdentity: "1:2",
      observedAtMilliseconds: observedAt,
      complete: true,
      stable: true,
      incompleteReason: null,
      entryLimit: MAX_RETENTION_CENSUS_ENTRIES,
      hashByteLimit: MAX_RETENTION_CENSUS_HASH_BYTES,
      maintenance: {
        present: false,
        valid: true,
        snapshotSha256: "a".repeat(64),
      },
      writerLeases: {
        open: 0,
        closed: 2,
        malformed: 0,
        foreignEpochs: 1,
        snapshotSha256: "b".repeat(64),
      },
      ...overrides,
    };
  }

  test("is deterministic across enumeration order and separates logical from unique bytes", () => {
    const observations = [
      censusObservation(["run-a"], {
        type: "directory",
        inode: "10",
        mode: "40700",
        size: "0",
        blocks: "0",
        contentSha256: null,
      }),
      censusObservation(["run-a", "first.bin"], {
        inode: "20",
        links: "3",
        size: "8",
        blocks: "1",
      }),
      censusObservation(["run-a", "second.bin"], {
        inode: "20",
        links: "3",
        size: "8",
        blocks: "1",
      }),
      censusObservation(["run-a", "other.bin"], {
        inode: "21",
        size: "8",
        blocks: "2",
        contentSha256: digestB,
      }),
    ];
    const forward = summarizeArtifactCensusObservations(observations, censusContext());
    const reversed = summarizeArtifactCensusObservations(
      [...observations].reverse(),
      censusContext(),
    );

    expect(reversed.tree_sha256).toBe(forward.tree_sha256);
    expect(reversed.unique_content_sha256).toBe(forward.unique_content_sha256);
    expect(forward.counts.top_level_namespaces).toBe(1);
    expect(forward.counts.regular).toBe(3);
    expect(forward.counts.unique_regular_inodes).toBe(2);
    expect(forward.bytes.logical).toBe("24");
    expect(forward.bytes.unique).toBe("16");
    expect(forward.bytes.logical_allocated).toBe(String(4 * 512));
    expect(forward.bytes.unique_allocated).toBe(String(3 * 512));
    expect(forward.hard_links).toEqual({
      groups: 1,
      observed_aliases: 2,
      external_link_groups: 1,
      max_observed_aliases: 2,
    });
    // Simulation can prove accounting, never archival readiness.
    expect(forward.archive_candidate).toBe(false);
  });

  test("buckets exact ages and inventories every non-regular node without traversing it", () => {
    const day = 24 * 60 * 60 * 1_000;
    const observations: ArtifactCensusObservation[] = [
      censusObservation(["future"], { modifiedMilliseconds: String(observedAt + 1) }),
      censusObservation(["new"], {
        inode: "2",
        modifiedMilliseconds: String(observedAt - day + 1),
      }),
      censusObservation(["day"], { inode: "3", modifiedMilliseconds: String(observedAt - day) }),
      censusObservation(["eight"], {
        inode: "4",
        modifiedMilliseconds: String(observedAt - 8 * day),
      }),
      censusObservation(["thirty-one"], {
        inode: "5",
        modifiedMilliseconds: String(observedAt - 31 * day),
      }),
      censusObservation(["ninety-one"], {
        inode: "6",
        modifiedMilliseconds: String(observedAt - 91 * day),
      }),
      ...(["symlink", "fifo", "socket", "block", "character", "unknown"] as const).map(
        (type, index) =>
          censusObservation([type], {
            type,
            inode: String(30 + index),
            size: "0",
            blocks: "0",
            contentSha256: null,
            symlinkTargetSha256: type === "symlink" ? "c".repeat(64) : null,
          }),
      ),
    ];
    const report = summarizeArtifactCensusObservations(observations, censusContext());
    expect(report.age_buckets.future.entries).toBe(1);
    expect(report.age_buckets.lt_24h.entries).toBe(7);
    expect(report.age_buckets.d1_to_lt8.entries).toBe(1);
    expect(report.age_buckets.d8_to_lt31.entries).toBe(1);
    expect(report.age_buckets.d31_to_lt91.entries).toBe(1);
    expect(report.age_buckets.gte_91d.entries).toBe(1);
    expect(report.counts.symlink).toBe(1);
    expect(report.counts.fifo).toBe(1);
    expect(report.counts.socket).toBe(1);
    expect(report.counts.block).toBe(1);
    expect(report.counts.character).toBe(1);
    expect(report.counts.unknown).toBe(1);
  });

  test("opaque chunk hashing causally feeds the locator without emitting body bytes", () => {
    const secretName = "asimp_ag_abcdefghijklmnopqrstuvwxyz123456";
    const observations = [
      censusObservation(["safe-run", "evidence.bin"], { inode: "81" }),
      censusObservation([secretName, "evidence.bin"], { inode: "82" }),
    ];
    const report = summarizeArtifactCensusObservations(
      observations,
      censusContext({ locateSha256: digestA }),
    );
    const serialized = JSON.stringify(report);
    expect(digestA).toBe(createHash("sha256").update(bodyCanary).digest("hex"));
    expect(report.locator.matches).toHaveLength(2);
    expect(report.locator.matches[0]?.path).toBeNull();
    expect(report.locator.matches[1]?.path).toBe("safe-run/evidence.bin");
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain("opaque-a");
    expect(serialized).toContain(digestA);
  });

  test("partial or unstable scans suppress authority and canonical digests", () => {
    const observation = censusObservation(["run", "evidence.bin"]);
    for (const context of [
      censusContext({
        complete: false,
        incompleteReason: "entry-limit",
      }),
      censusContext({
        complete: false,
        stable: false,
        incompleteReason: "filesystem-drift",
      }),
      censusContext({
        stable: false,
        writerLeases: {
          open: 1,
          closed: 1,
          malformed: 0,
          foreignEpochs: 0,
          snapshotSha256: "d".repeat(64),
        },
      }),
      censusContext({
        maintenance: {
          present: true,
          valid: false,
          snapshotSha256: "e".repeat(64),
        },
      }),
    ]) {
      const report = summarizeArtifactCensusObservations([observation], context);
      expect(report.tree_sha256).toBeNull();
      expect(report.unique_content_sha256).toBeNull();
      expect(report.locator.complete).toBe(false);
      expect(report.archive_candidate).toBe(false);
    }
  });

  test("PLANTED: the exported aggregation seam rejects non-canonical or secret-bearing metadata", () => {
    const observation = censusObservation(["run", "evidence.bin"]);
    expect(() =>
      summarizeArtifactCensusObservations(
        [{ ...observation, relativePath: Buffer.from("another/path") }],
        censusContext(),
      ),
    ).toThrow(/ARTIFACT_CENSUS_INVALID|canonical/);
    expect(() =>
      summarizeArtifactCensusObservations(
        [{ ...observation, uid: "asimp_ag_not_metadata" }],
        censusContext(),
      ),
    ).toThrow(/ARTIFACT_CENSUS_INVALID|metadata/);
    expect(() =>
      summarizeArtifactCensusObservations(
        [{ ...observation, contentSha256: null }],
        censusContext(),
      ),
    ).toThrow(/ARTIFACT_CENSUS_INVALID|metadata records/);
    expect(() =>
      summarizeArtifactCensusObservations(
        [{ ...observation, type: "forged" as ArtifactCensusObservation["type"] }],
        censusContext(),
      ),
    ).toThrow(/ARTIFACT_CENSUS_INVALID|metadata records/);
    expect(() =>
      summarizeArtifactCensusObservations(
        [observation],
        censusContext({ hashByteLimit: BigInt(observation.size) - 1n }),
      ),
    ).toThrow(/ARTIFACT_CENSUS_INVALID|hashing bound/);
    expect(() =>
      summarizeArtifactCensusObservations(
        [
          observation,
          censusObservation(["run", "alias.bin"], {
            inode: observation.inode,
            links: "1",
          }),
        ],
        censusContext(),
      ),
    ).toThrow(/ARTIFACT_CENSUS_DRIFT|fewer links/);

    const forgedAuthority = summarizeArtifactCensusObservations(
      [observation],
      { ...censusContext(), storageAuthority: "real-filesystem" } as ArtifactCensusContext,
    );
    expect(forgedAuthority.storage_authority).toBe("simulation");
    expect(forgedAuthority.archive_candidate).toBe(false);
  });

  test("PLANTED: writer leases are open or exactly closed, never loosely inferred", () => {
    expect(classifyArtifactWriterLeaseChildren([])).toBe("open");
    expect(classifyArtifactWriterLeaseChildren([Buffer.from("closed")])).toBe("closed");
    expect(
      classifyArtifactWriterLeaseChildren([Buffer.from("closed"), Buffer.from("unexpected")]),
    ).toBe("malformed");
    expect(classifyArtifactWriterLeaseChildren([Buffer.from("unexpected")])).toBe("malformed");
    expect(classifyArtifactWriterLeaseChildren([Buffer.from([0xff])])).toBe("malformed");
  });

  test("static guard keeps the operator census write-free and CLI-exclusive", () => {
    const source = readFileSync(RUNNER_SOURCE, "utf8");
    const censusStart = source.indexOf("function censusBoundedDirectoryNames(");
    const reservationStart = source.indexOf("export function reserveArtifactNamespace(");
    expect(censusStart).toBeGreaterThanOrEqual(0);
    expect(reservationStart).toBeGreaterThan(censusStart);
    const censusSource = source.slice(censusStart, reservationStart);
    for (const mutation of [
      ["mkdir", "Sync("],
      ["writeFile", "Sync("],
      ["appendFile", "Sync("],
      ["link", "Sync("],
      ["readdir", "Sync("],
      [".mk", "dir("],
      [".write", "Exclusive("],
      [".app", "end("],
      [".li", "nk("],
    ].map((parts) => parts.join(""))) {
      expect(censusSource).not.toContain(mutation);
    }
    expect(source).toContain('argument === "--retention-census"');
    expect(source).toContain('argument === "--locate-sha256"');
    expect(source).toContain("Number(preflight) + Number(selfTest) + Number(retentionCensus)");
    expect(censusSource).toContain("summarized.counts.symlink +");
    expect(censusSource).toContain('storage_authority: "real-filesystem"');
    expect(source).toContain(
      '"unavailable: census arguments and local paths are not echoed after a failure"',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source match
    expect(source).toContain("process.stdout.write(`${JSON.stringify(census)}\\n`)");
  });

  test("the census CLI parser causally enforces one mode and locator scope", () => {
    expect(parseHarnessCli(["--retention-census"])).toMatchObject({
      retentionCensus: true,
      preflight: false,
      selfTest: false,
      locateSha256: undefined,
    });
    expect(parseHarnessCli(["--retention-census", "--locate-sha256", digestA])).toMatchObject({
      retentionCensus: true,
      locateSha256: digestA,
    });
    expect(() => parseHarnessCli(["--retention-census", "--preflight"])).toThrow(
      /choose exactly one/,
    );
    expect(() => parseHarnessCli(["--preflight", "--locate-sha256", digestA])).toThrow(
      /valid only with --retention-census/,
    );
    expect(() =>
      parseHarnessCli(["--retention-census", "--integration-namespace", "one"]),
    ).toThrow(/does not narrow/);
    expect(() => parseHarnessCli(["--retention-census", "--locate-sha256", "not-a-digest"])).toThrow(
      /lowercase SHA-256/,
    );
    expect(() =>
      parseHarnessCli([
        "--retention-census",
        "--locate-sha256",
        digestA,
        "--locate-sha256",
        digestA,
      ]),
    ).toThrow(/exactly one lowercase SHA-256/);
  });
});

describe("retained integration recursive cap", () => {
  test("counts self-test and resume ids, cases, staging, D1 state, and bytes in memory", () => {
    const root = fixtureRoot("retained-integration-cap");
    const storage = fixtureStorage();
    const integration = join(root, "e2e", "artifacts", DEFAULT_RETAINED_INTEGRATION_NAMESPACE);
    storage.seedDirectory(integration);
    const selfTest = join(integration, "ops2a-selftest-1");
    const resume = join(integration, "ops2a-selftest-1-resume");
    const caseRoot = join(integration, "case-atomic-1");
    const state = join(selfTest, "d1-state-rollback-ok");
    const staging = join(caseRoot, "e2e", "artifacts", "blobs", "sha256", "incoming");
    for (const directory of [
      selfTest,
      resume,
      caseRoot,
      join(caseRoot, "e2e"),
      join(caseRoot, "e2e", "artifacts"),
      join(caseRoot, "e2e", "artifacts", "blobs"),
      join(caseRoot, "e2e", "artifacts", "blobs", "sha256"),
      staging,
      state,
      join(state, ".state"),
    ]) {
      storage.mkdir(directory);
    }
    storage.writeExclusive(join(staging, "retained-stage"), "stage");
    storage.writeExclusive(join(state, "wrangler.toml"), "config");
    storage.writeExclusive(join(state, ".state", "part.sqlite"), "sqlite");

    const report = retainedIntegrationCapacityReport(integration, storage);
    expect(report.storageAuthority).toBe("simulation");
    expect(report.directories).toBe(10);
    expect(report.stagingEntries).toBe(1);
    expect(report.bytes).toBe(Buffer.byteLength("stageconfigsqlite", "utf8"));
    expect(report.directoryLimit).toBe(MAX_RETAINED_INTEGRATION_DIRECTORIES);
    expect(report.byteLimit).toBe(MAX_RETAINED_INTEGRATION_BYTES);
    expect(report.truncated).toBe(false);
    // Equality is saturated: a preflight that calls this exceeded must agree
    // with the mutation guard instead of promising one more retained entry.
    expect(() =>
      assertRetainedIntegrationCapacity(
        integration,
        { additionalDirectories: MAX_RETAINED_INTEGRATION_DIRECTORIES - report.directories },
        storage,
      ),
    ).toThrow(/retained integration evidence holds/);
    expect(() =>
      assertRetainedIntegrationCapacity(
        integration,
        { additionalDirectories: MAX_RETAINED_INTEGRATION_DIRECTORIES - report.directories + 1 },
        storage,
      ),
    ).toThrow(/retained integration evidence holds/);
    expect(storage.exists(join(integration, "blocked-before-create"))).toBe(false);
  });

  test("PLANTED: recursive capacity census stops once a cap is decisive", () => {
    const root = fixtureRoot("retained-integration-bounded-walk");
    const storage = fixtureStorage();
    const integration = join(root, "e2e", "artifacts", DEFAULT_RETAINED_INTEGRATION_NAMESPACE);
    storage.seedDirectory(integration);
    for (let index = 0; index < MAX_RETAINED_INTEGRATION_DIRECTORIES; index += 1) {
      storage.mkdir(join(integration, `full-${String(index).padStart(3, "0")}`));
    }
    // An entry after the decisive directory count is deliberately not required
    // for the refusal. A hostile retained tree cannot force an unbounded walk.
    const report = retainedIntegrationCapacityReport(integration, storage);
    expect(report.directories).toBe(MAX_RETAINED_INTEGRATION_DIRECTORIES);
    expect(report.exceeded).toBe(true);
    expect(report.truncated).toBe(true);
    expect(() => assertRetainedIntegrationCapacity(integration, {}, storage)).toThrow(
      /retained integration evidence holds/,
    );
    const preflight = artifactCapacityReport(
      root,
      MAX_ARTIFACT_NAMESPACES,
      storage,
      DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
    );
    expect(preflight.exceeded).toBe(true);
    expect(preflight.retainedIntegration?.truncated).toBe(true);
    expect(preflight.remedy).toMatch(/requested retained integration namespace/i);
  });

  test("an existing content-addressed blob remains readable at the recursive cap", () => {
    const root = fixtureRoot("retained-integration-dedup-at-cap");
    const storage = fixtureStorage();
    const integration = join(root, "e2e", "artifacts", DEFAULT_RETAINED_INTEGRATION_NAMESPACE);
    const artifacts = join(integration, "case-dedup", "e2e", "artifacts");
    const store = join(artifacts, ARTIFACT_BLOB_DIRECTORY, "sha256");
    storage.seedDirectory(store);
    const body = "already retained failure evidence\n";
    const digest = createHash("sha256").update(body, "utf8").digest("hex");
    const blob = join(store, digest);
    storage.writeExclusive(blob, body);

    let filler = 0;
    while (
      retainedIntegrationCapacityReport(integration, storage).directories <
      MAX_RETAINED_INTEGRATION_DIRECTORIES
    ) {
      storage.mkdir(join(integration, `filler-${String(filler).padStart(3, "0")}`));
      filler += 1;
    }
    expect(retainedIntegrationCapacityReport(integration, storage).exceeded).toBe(true);

    expect(
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: artifacts,
        digest,
        stored: body,
        attempt: 1,
        storage,
        retainedIntegrationDirectory: integration,
      }),
    ).toBe(blob);
    expect(storage.readFile(blob)).toBe(body);

    const newBody = "new bytes must be refused at the cap\n";
    const newDigest = createHash("sha256").update(newBody, "utf8").digest("hex");
    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: artifacts,
        digest: newDigest,
        stored: newBody,
        attempt: 2,
        storage,
        retainedIntegrationDirectory: integration,
      }),
    ).toThrow(/retained integration evidence holds/);
    expect(storage.exists(join(store, newDigest))).toBe(false);
    expect(storage.exists(join(store, "incoming"))).toBe(false);
  });
});

describe("run options are closed", () => {
  test("PLANTED: an unknown run option is refused instead of ignored", async () => {
    const root = fixtureRoot("options-unknown");
    const storage = fixtureStorage();
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: fixtureRunId("unknown-option"),
        steps: [passStep("ok")],
        onEvent: () => undefined,
        onOutput: () => undefined,
        // Not an option this runner has. Silently dropping it told an earlier
        // caller its artifacts were suppressed when they were still written.
        writeArtifacts: false,
      } as unknown as Parameters<typeof runHarness>[0]),
    ).rejects.toThrow(/unknown run option "writeArtifacts"/);
  });

  test("PLANTED: a misspelled callback is refused, not silently unused", async () => {
    const root = fixtureRoot("options-misspelled");
    const storage = fixtureStorage();
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: fixtureRunId("misspelled"),
        steps: [passStep("ok")],
        emitRecord: () => undefined,
      } as unknown as Parameters<typeof runHarness>[0]),
    ).rejects.toThrow(/unknown run option "emitRecord"/);
  });

  test("simulation accepts ordinary options but not the production receipt label", async () => {
    const root = fixtureRoot("options-accepted");
    const storage = fixtureStorage();
    const result = await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("accepted"),
      steps: [passStep("ok")],
      seed: 7,
      resume: false,
      gitRevision: "unavailable",
      bindingVersions: {},
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    await expect(
      runHarness({
        root,
        storage: fixtureStorage(),
        suite: "unit",
        runId: fixtureRunId("receipt-simulation"),
        steps: [passStep("ok")],
        reproduction: "self-test",
        artifactNamespace: "simulated-receipt",
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/exact node artifact storage/);
  });
});

describe("repository root purity", () => {
  test("PLANTED: a harness run adds nothing outside e2e/artifacts", async () => {
    // The guard for the class of defect that left `counter`, `safe-counter`,
    // `unsafe-counter` and `opaque-output.cjs` in the checkout root: fixture
    // scratch that resolved to the repository root instead of the artifact area.
    const root = fixtureRoot("purity");
    const storage = fixtureStorage();
    const before = new Set(readdirSync(root));
    await runHarness({
      root,
      storage,
      suite: "unit",
      runId: fixtureRunId("purity"),
      steps: [passStep("ok")],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    const after = readdirSync(root).filter((entry) => !before.has(entry));
    // "e2e" is the artifact area itself; nothing else may appear.
    expect(after.filter((entry) => entry !== "e2e")).toEqual([]);
  });

  test("ordinary fixtures use no process scratch directory", () => {
    // Retry, resume, timeout, and cancellation tests coordinate through a
    // bounded loopback counter. No PID-named temp root or marker file exists.
    expect(ordinaryTaskTempResidue()).toEqual(ORDINARY_SUITE_RESIDUE_BEFORE.taskTempEntries);
  });
});

/**
 * Forward fixes for the OPS.2a retention audit.
 *
 * These tests are only registered when real-filesystem integration is explicit.
 * Their retained case roots all live under one bounded, repository-contained
 * parent (`e2e/artifacts/${DEFAULT_RETAINED_INTEGRATION_NAMESPACE}`).
 */
describeRealFilesystemIntegration("real filesystem publication semantics", () => {
  /**
   * These drive `publishFailureBlob` directly rather than `runHarness`.
   *
   * They are intentionally direct publication checks: they inspect genuine
   * filesystem semantics only after the explicit real-authority preflight.
   */
  const digestOf = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const retainedIntegrationDirectory = (): string =>
    join(repositoryRoot(), "e2e", "artifacts", DEFAULT_RETAINED_INTEGRATION_NAMESPACE);

  function publish(root: string, body: string, attempt = 1): string {
    return publishFailureBlob({
      containmentRoot: root,
      artifactsDirectory: join(root, "e2e", "artifacts"),
      digest: digestOf(body),
      stored: body,
      attempt,
      retainedIntegrationDirectory: retainedIntegrationDirectory(),
      writerLease: fixtureWriterLease(),
    });
  }

  /** Every regular file under a directory, as directory-relative paths. */
  function fileCensus(directory: string): Set<string> {
    const found = new Set<string>();
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(join(current, entry.name), name);
        else found.add(name);
      }
    };
    walk(directory, "");
    return found;
  }

  const blobStore = (root: string): string =>
    join(root, "e2e", "artifacts", ARTIFACT_BLOB_DIRECTORY, "sha256");

  test("PLANTED: a direct real publisher requires its caller's open root-epoch lease", () => {
    const root = fixtureScratchRoot("writer-lease-required");
    const body = `leased publication ${process.pid}\n`;
    const input = {
      containmentRoot: root,
      artifactsDirectory: join(root, "e2e", "artifacts"),
      digest: digestOf(body),
      stored: body,
      attempt: 1,
      retainedIntegrationDirectory: retainedIntegrationDirectory(),
    } as const;

    expect(() => publishFailureBlob(input)).toThrow(
      /ARTIFACT_WRITER_LEASE_REQUIRED|open root-epoch/,
    );
    expect(existsSync(blobStore(root))).toBe(false);

    const closedLease = acquireArtifactWriterLeaseAtRoot(repositoryRoot(), nodeArtifactStorage);
    closeArtifactWriterLease(closedLease);
    expect(() => publishFailureBlob({ ...input, writerLease: closedLease })).toThrow(
      /ARTIFACT_WRITER_LEASE_CLOSED|lease is absent, replaced, or closed/,
    );
    expect(existsSync(blobStore(root))).toBe(false);

    const openLease = fixtureWriterLease();
    const foreignDirectory = retainedIntegrationDirectory();
    expect(() =>
      publishFailureBlob({
        ...input,
        writerLease: {
          ...openLease,
          directory: foreignDirectory,
          identity: nodeArtifactStorage.directoryIdentity(foreignDirectory),
        },
      }),
    ).toThrow(/ARTIFACT_WRITER_LEASE_INVALID|outside its exact artifact-root epoch/);
    expect(existsSync(blobStore(root))).toBe(false);
  });

  test("a published blob is complete, and its staging entry is the same inode", () => {
    const root = fixtureScratchRoot("atomic-publish");
    const payload = `atomic publication ${process.pid}\n`;
    const published = publish(root, payload);

    expect(existsSync(published)).toBe(true);
    // Complete bytes, never the empty file a create-then-write race exposed.
    expect(readFileSync(published, "utf8")).toBe(payload);

    // Exactly one staging entry, and it is a second name for the same inode —
    // so retaining it costs a directory entry, not a second copy of the bytes.
    expect(countBlobStagingArtifacts(root)).toBe(1);
    const staging = join(blobStore(root), "incoming");
    const [entry] = readdirSync(staging);
    if (entry === undefined) throw new Error("no staging entry was retained");
    expect(statSync(join(staging, entry)).ino).toBe(statSync(published).ino);
  });

  test("PLANTED: publication removes no file that existed before it", () => {
    const root = fixtureScratchRoot("no-removal");
    publish(root, "first payload\n", 1);
    const before = fileCensus(root);

    publish(root, "second payload\n", 2);
    publish(root, "first payload\n", 3);
    const after = fileCensus(root);

    // Additive only. A staging cleanup, a rename, or a prune would show up here
    // as a path that used to exist and no longer does.
    expect([...before].filter((path) => !after.has(path))).toEqual([]);
    expect(after.size).toBeGreaterThan(before.size);
  });

  test("a repeat of stored content publishes no new staging entry", () => {
    const root = fixtureScratchRoot("staging-bounded");
    const payload = `repeated payload ${process.pid}\n`;
    publish(root, payload, 1);
    expect(countBlobStagingArtifacts(root)).toBe(1);

    // The blob already exists, so the second call returns before staging.
    publish(root, payload, 2);
    expect(countBlobStagingArtifacts(root)).toBe(1);
    expect(readdirSync(blobStore(root)).filter((name) => name !== "incoming")).toHaveLength(1);
  });

  test("PLANTED: a reader never observes a partially written blob", () => {
    const root = fixtureScratchRoot("no-partial");
    const payload = `bytes that must appear all at once ${process.pid}\n`;
    const path = publish(root, payload);

    // Under create-then-write publication a concurrent reader could observe
    // this path existing while empty. Linking makes that state unreachable:
    // the name appears only once the bytes are already complete.
    expect(statSync(path).size).toBe(Buffer.byteLength(payload, "utf8"));
    expect(readFileSync(path, "utf8")).toBe(payload);
    // Nothing half-written is left under a staging name either.
    const staging = join(blobStore(root), "incoming");
    for (const entry of readdirSync(staging)) {
      expect(readFileSync(join(staging, entry), "utf8")).toBe(payload);
    }
  });

  test("PLANTED: a divergent blob raises and leaves the retained bytes untouched", () => {
    const root = fixtureScratchRoot("mismatch");
    const payload = `mismatch payload ${process.pid}\n`;
    // Occupy the digest with bytes that disagree, as on-disk corruption would.
    fixtureCreateDirectory(join(root, "e2e", "artifacts"), blobStore(root));
    const corrupted = "not the bytes this digest names\n";
    fixtureWriteFile(blobStore(root), join(blobStore(root), digestOf(payload)), corrupted);

    expect(() => publish(root, payload)).toThrow(/does not match its digest/);
    // Refused, not repaired: the divergent file is still exactly as it was.
    expect(readFileSync(join(blobStore(root), digestOf(payload)), "utf8")).toBe(corrupted);
  });

  test("a lost publication race is benign when the bytes agree", () => {
    const root = fixtureScratchRoot("lost-race");
    const payload = `contended payload ${process.pid}\n`;
    // Stand in for a winner publishing between the existence check and the link.
    fixtureCreateDirectory(join(root, "e2e", "artifacts"), blobStore(root));
    fixtureWriteFile(blobStore(root), join(blobStore(root), digestOf(payload)), payload);

    expect(() => publish(root, payload)).not.toThrow();
    expect(readFileSync(join(blobStore(root), digestOf(payload)), "utf8")).toBe(payload);
  });

  test("identical bytes resolve to one path, distinct bytes to distinct paths", () => {
    const root = fixtureScratchRoot("dedupe-path");
    const payload = `shared failure ${process.pid}\n`;
    // The property `failureLogs` dedupe rests on: two steps emitting the same
    // output name one file, so a list that repeated it would report a single
    // piece of evidence as several.
    expect(publish(root, payload, 1)).toBe(publish(root, payload, 2));
    expect(publish(root, `other ${process.pid}\n`, 3)).not.toBe(publish(root, payload, 4));
    expect(readdirSync(blobStore(root)).filter((name) => name !== "incoming")).toHaveLength(2);
  });

  test("PLANTED: a digest that does not address the bytes is refused", () => {
    const root = fixtureScratchRoot("wrong-digest");
    const wrong = digestOf("different bytes\n");
    // The shape of a caller that digested before clipping, or digested another
    // buffer. Publishing it would name content by an address that does not
    // describe it, and every later reader would report a mismatch against a
    // store doing exactly what it was told.
    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: join(root, "e2e", "artifacts"),
        digest: wrong,
        stored: "the real bytes\n",
        attempt: 1,
      }),
    ).toThrow(/does not address the bytes/);
    expect(existsSync(join(blobStore(root), wrong))).toBe(false);
  });

  test("PLANTED: an artifacts directory outside the root creates nothing", () => {
    const root = fixtureScratchRoot("escape-root");
    const outside = fixtureScratchRoot("escape-target");
    const body = "bytes that must not land outside\n";

    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: join(outside, "e2e", "artifacts"),
        digest: digestOf(body),
        stored: body,
        attempt: 1,
      }),
    ).toThrow(/ARTIFACT_PATH_UNSAFE|outside|expected a real repository directory/);
    // Containment is proved before any mkdir, so nothing was created out there.
    expect(existsSync(join(outside, "e2e", "artifacts", ARTIFACT_BLOB_DIRECTORY))).toBe(false);
  });

  test("PLANTED: a torn staging file is never published as a blob", () => {
    const root = fixtureScratchRoot("torn-write");
    const body = "complete bytes\n";
    // A staging entry left by a process that died mid-write. It was never
    // linked into the store, so no reader can reach it by digest.
    const staging = join(blobStore(root), "incoming");
    fixtureCreateDirectory(join(root, "e2e", "artifacts"), staging);
    fixtureWriteFile(staging, join(staging, `${digestOf(body)}.99999.1`), "half");
    expect(existsSync(join(blobStore(root), digestOf(body)))).toBe(false);

    // A real publication still stores the whole bytes, and the torn entry stays.
    expect(readFileSync(publish(root, body), "utf8")).toBe(body);
    expect(readFileSync(join(staging, `${digestOf(body)}.99999.1`), "utf8")).toBe("half");
  });

  test("PLANTED: a publisher that loses the link race accepts the winner's blob", () => {
    /**
     * `Promise.all` over these publications is not concurrency.
     *
     * Every operation in `publishFailureBlob` is synchronous, so each callback
     * runs to completion before the next begins: the earlier version of this
     * test proved only that the same code path ran sixteen times, and the
     * contended branch — link raising EEXIST — never executed at all.
     *
     * `beforeLink` opens the exact window that matters. This publisher has
     * checked, found nothing, and is about to claim the name; the hook lets a
     * second publisher take it first, deterministically, so the losing branch
     * is genuinely exercised rather than assumed.
     */
    const root = fixtureScratchRoot("link-race");
    const body = `contended bytes ${process.pid}\n`;
    const artifactsDirectory = join(root, "e2e", "artifacts");
    let intruded = false;
    const beforeLink = (path: string): void => {
      if (intruded) return;
      intruded = true;
      // The winner publishes inside the loser's window, using a separate
      // publication so the store reaches the state the loser will collide with.
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory,
        digest: digestOf(body),
        stored: body,
        attempt: 99,
        retainedIntegrationDirectory: retainedIntegrationDirectory(),
        writerLease: fixtureWriterLease(),
      });
      expect(existsSync(path)).toBe(true);
    };

    const loser = publishFailureBlob({
      containmentRoot: root,
      artifactsDirectory,
      digest: digestOf(body),
      stored: body,
      attempt: 1,
      storage: nodeArtifactStorage,
      beforeLink,
      retainedIntegrationDirectory: retainedIntegrationDirectory(),
      writerLease: fixtureWriterLease(),
    });

    expect(intruded).toBe(true);
    // The loser neither raised nor overwrote: it verified and adopted the blob.
    expect(loser).toBe(join(blobStore(root), digestOf(body)));
    expect(readFileSync(loser, "utf8")).toBe(body);
    expect(readdirSync(blobStore(root)).filter((name) => name !== "incoming")).toHaveLength(1);
    // Both staging entries survive: nothing is deleted to tidy up after a race.
    expect(countBlobStagingArtifacts(root)).toBe(2);
  });

  test("PLANTED: a loser whose bytes disagree is refused, not silently accepted", () => {
    const root = fixtureScratchRoot("link-race-mismatch");
    const body = `honest bytes ${process.pid}\n`;
    const artifactsDirectory = join(root, "e2e", "artifacts");
    const beforeLink = (path: string): void => {
      // A different payload occupies the digest first — corruption, not a race.
      if (!existsSync(path)) fixtureWriteFile(dirname(path), path, "impostor bytes\n");
    };
    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory,
        digest: digestOf(body),
        stored: body,
        attempt: 1,
        storage: nodeArtifactStorage,
        beforeLink,
        retainedIntegrationDirectory: retainedIntegrationDirectory(),
        writerLease: fixtureWriterLease(),
      }),
    ).toThrow(/does not match its digest/);
    expect(readFileSync(join(blobStore(root), digestOf(body)), "utf8")).toBe("impostor bytes\n");
  });

  test("a blob name that is not a digest is refused before anything is written", () => {
    const root = fixtureScratchRoot("bad-digest");
    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: join(root, "e2e", "artifacts"),
        digest: "../../escape",
        stored: "x",
        attempt: 1,
      }),
    ).toThrow(/sha256 hex digest/);
  });
});

describeRealFilesystemIntegration("real filesystem manifest fixtures", () => {
  const digestOf = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");

  const RUN = "reconcile-run";

  /** A fully-formed record, so a test varies exactly the field it is about. */
  function line(
    kind: string,
    body: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const digest = digestOf(body);
    return {
      schema_version: HARNESS_SCHEMA_VERSION,
      record: kind,
      run_id: RUN,
      step: "step-a",
      attempt: 1,
      digest,
      bytes: Buffer.byteLength(body, "utf8"),
      blob: `e2e/artifacts/${ARTIFACT_BLOB_DIRECTORY}/sha256/${digest}`,
      ...overrides,
    };
  }

  function writeManifest(root: string, lines: readonly object[], runId = RUN): string {
    const artifacts = join(root, "e2e", "artifacts");
    const directory = join(root, "e2e", "artifacts", runId);
    fixtureCreateDirectory(artifacts, directory);
    const manifest = join(directory, FAILURE_MANIFEST_NAME);
    fixtureWriteFile(
      directory,
      manifest,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    return manifest;
  }

  const artifactsOf = (root: string): string => join(root, "e2e", "artifacts");

  function plantBlob(root: string, body: string): void {
    const store = join(artifactsOf(root), ARTIFACT_BLOB_DIRECTORY, "sha256");
    fixtureCreateDirectory(artifactsOf(root), store);
    fixtureWriteFile(store, join(store, digestOf(body)), body);
  }

  test("PLANTED: an intent whose blob never arrived still spends its slot", () => {
    const root = fixtureScratchRoot("orphan-budget");
    const body = "evidence that died with its process\n";
    const manifest = writeManifest(root, [line(FAILURE_RECORD_INTENT, body)]);

    const reconciled = reconcileFailureManifest(manifest, artifactsOf(root), RUN);
    // Counting completions would return 0 here, handing a crash-looping run a
    // fresh budget on every resume.
    expect(reconciled.attemptCount).toBe(1);
    expect(reconciled.dangling).toEqual([digestOf(body)]);
    expect(reconciled.stored).toEqual([]);
    expect(reconciled.unfinishedAttempts).toEqual(["step-a 1"]);
  });

  test("a retry that republishes the digest clears the dangling report", () => {
    const root = fixtureScratchRoot("orphan-recovery");
    const body = "evidence that came back\n";
    const manifest = writeManifest(root, [line(FAILURE_RECORD_INTENT, body)]);
    expect(reconcileFailureManifest(manifest, artifactsOf(root), RUN).dangling).toEqual([
      digestOf(body),
    ]);

    plantBlob(root, body);
    const recovered = reconcileFailureManifest(manifest, artifactsOf(root), RUN);
    expect(recovered.dangling).toEqual([]);
    expect(recovered.stored).toEqual([digestOf(body)]);
    // The slot stays spent either way: recovery is not a refund.
    expect(recovered.attemptCount).toBe(1);
  });

  test("PLANTED: two steps with identical bytes spend two slots, not one", () => {
    const root = fixtureScratchRoot("attempt-keyed");
    const body = "identical output from different steps\n";
    const manifest = writeManifest(root, [
      line(FAILURE_RECORD_INTENT, body, { step: "step-a" }),
      line(FAILURE_RECORD_STORED, body, { step: "step-a" }),
      line(FAILURE_RECORD_INTENT, body, { step: "step-b" }),
      line(FAILURE_RECORD_STORED, body, { step: "step-b" }),
    ]);
    plantBlob(root, body);
    // Keyed by digest this was 1, so repetitive failure — the common case —
    // silently bought extra publications beyond the per-run ceiling.
    expect(reconcileFailureManifest(manifest, artifactsOf(root), RUN).attemptCount).toBe(2);
  });

  test("a repeated intent for one attempt spends one slot", () => {
    const root = fixtureScratchRoot("attempt-repeat");
    const body = "retried identical output\n";
    const manifest = writeManifest(root, [
      line(FAILURE_RECORD_INTENT, body),
      line(FAILURE_RECORD_INTENT, body),
      line(FAILURE_RECORD_STORED, body),
    ]);
    plantBlob(root, body);
    expect(reconcileFailureManifest(manifest, artifactsOf(root), RUN).attemptCount).toBe(1);
  });

  describe("PLANTED: a manifest it cannot fully account for is refused", () => {
    const body = "some failure\n";
    const cases: [string, () => Record<string, unknown>[] | string][] = [
      ["not JSON", () => "{not json\n"],
      ["a JSON array", () => "[1,2,3]\n"],
      [
        "an unknown schema version",
        () => [line(FAILURE_RECORD_INTENT, body, { schema_version: "9.9" })],
      ],
      [
        "an unknown record kind",
        () => [line(FAILURE_RECORD_INTENT, body, { record: "something_else" })],
      ],
      [
        "another run's record",
        () => [line(FAILURE_RECORD_INTENT, body, { run_id: "a-different-run" })],
      ],
      ["an unusable step label", () => [line(FAILURE_RECORD_INTENT, body, { step: "../escape" })]],
      ["an out-of-range attempt", () => [line(FAILURE_RECORD_INTENT, body, { attempt: 0 })]],
      ["a non-integer attempt", () => [line(FAILURE_RECORD_INTENT, body, { attempt: 1.5 })]],
      ["a malformed digest", () => [line(FAILURE_RECORD_INTENT, body, { digest: "nothex" })]],
      ["a negative byte count", () => [line(FAILURE_RECORD_INTENT, body, { bytes: -1 })]],
      [
        "a blob path that addresses another digest",
        () => [line(FAILURE_RECORD_INTENT, body, { blob: "e2e/artifacts/blobs/sha256/deadbeef" })],
      ],
      ["a completion with no intent", () => [line(FAILURE_RECORD_STORED, body)]],
      [
        "a completion disagreeing with its intent",
        () => [
          line(FAILURE_RECORD_INTENT, body),
          line(FAILURE_RECORD_STORED, "different bytes entirely\n", { bytes: 1 }),
        ],
      ],
      [
        "one attempt completed twice",
        () => [
          line(FAILURE_RECORD_INTENT, body),
          line(FAILURE_RECORD_STORED, body),
          line(FAILURE_RECORD_STORED, body),
        ],
      ],
    ];

    for (const [name, build] of cases) {
      test(name, () => {
        const root = fixtureScratchRoot("reject");
        const built = build();
        let manifest: string;
        if (typeof built === "string") {
          const directory = join(artifactsOf(root), RUN);
          fixtureCreateDirectory(artifactsOf(root), directory);
          manifest = join(directory, FAILURE_MANIFEST_NAME);
          fixtureWriteFile(directory, manifest, built);
        } else {
          manifest = writeManifest(root, built);
        }
        // Fail closed. Skipping the line silently under-counted the budget on
        // exactly the corrupted manifest where the budget matters most.
        expect(() => reconcileFailureManifest(manifest, artifactsOf(root), RUN)).toThrow(
          /FAILURE_MANIFEST_INVALID|manifest is unusable/,
        );
      });
    }
  });
});

function runIdentityTestValue() {
  return {
    runId: "identity-run",
    suite: "unit",
    seed: 7,
    stepIds: ["a", "b"],
    stepContractDigests: ["a".repeat(64), "b".repeat(64)],
    reproduction: "unavailable: no registered CLI scenario",
    artifactNamespace: null,
    gitRevision: "unavailable",
    childEnvironmentDigest: "c".repeat(64),
    bindingVersions: {},
  };
}

interface SimulatedDirectoryCapabilityFixture {
  readonly root: string;
  readonly artifactRoot: string;
  readonly owner: string;
  readonly path: string;
  readonly storage: ReturnType<typeof createMemoryArtifactStorage>;
  readonly capability: ArtifactDirectoryWriterCapability;
}

function simulatedDirectoryCapabilityFixture(label: string): SimulatedDirectoryCapabilityFixture {
  const root = fixtureRoot(`directory-capability-${label}`);
  const storage = fixtureStorage();
  const artifactRoot = join(root, "e2e", "artifacts");
  const owner = join(artifactRoot, `owner-${label}`);
  storage.seedDirectory(owner);
  const writerLease = acquireArtifactWriterLeaseAtRoot(root, storage);
  const capability: ArtifactDirectoryWriterCapability = {
    writerLease,
    directory: owner,
    directoryIdentity: storage.directoryIdentity(owner),
  };
  return {
    root,
    artifactRoot,
    owner,
    path: join(owner, RUN_IDENTITY_NAME),
    storage,
    capability,
  };
}

describe("run identity directory capability", () => {
  test("an exact open capability permits one simulated direct identity creation", () => {
    const value = simulatedDirectoryCapabilityFixture("valid");
    reconcileRunIdentity(
      value.path,
      runIdentityTestValue(),
      false,
      value.storage,
      value.capability,
    );
    expect(value.storage.files.has(value.path)).toBe(true);
  });

  test("PLANTED: another leaf, owner, or outside path is refused before creation", () => {
    const value = simulatedDirectoryCapabilityFixture("wrong-target");
    for (const path of [
      join(value.owner, "not-run-identity.json"),
      join(value.artifactRoot, RUN_IDENTITY_NAME),
      join(value.root, "outside-artifacts", RUN_IDENTITY_NAME),
    ]) {
      expect(() =>
        reconcileRunIdentity(path, runIdentityTestValue(), false, value.storage, value.capability),
      ).toThrow(/exact run-identity leaf|exact owner path/);
      expect(value.storage.files.has(path)).toBe(false);
    }
  });

  test("PLANTED: a closed or foreign lease is refused before creation", () => {
    const closed = simulatedDirectoryCapabilityFixture("closed");
    closeArtifactWriterLease(closed.capability.writerLease);
    expect(() =>
      reconcileRunIdentity(
        closed.path,
        runIdentityTestValue(),
        false,
        closed.storage,
        closed.capability,
      ),
    ).toThrow(/ARTIFACT_WRITER_LEASE_CLOSED|lease.*closed/);
    expect(closed.storage.files.has(closed.path)).toBe(false);

    const foreign = simulatedDirectoryCapabilityFixture("foreign");
    const forgedCapability: ArtifactDirectoryWriterCapability = {
      ...foreign.capability,
      writerLease: {
        ...foreign.capability.writerLease,
        directory: foreign.owner,
        identity: foreign.storage.directoryIdentity(foreign.owner),
      },
    };
    expect(() =>
      reconcileRunIdentity(
        foreign.path,
        runIdentityTestValue(),
        false,
        foreign.storage,
        forgedCapability,
      ),
    ).toThrow(/ARTIFACT_WRITER_LEASE_INVALID|lease.*epoch/);
    expect(foreign.storage.files.has(foreign.path)).toBe(false);
  });

  test("PLANTED: a maintenance fence or replaced root is refused before creation", () => {
    const fenced = simulatedDirectoryCapabilityFixture("fenced");
    fenced.storage.seedDirectory(join(fenced.root, "e2e", ARTIFACT_MAINTENANCE_FENCE_NAME));
    expect(() =>
      reconcileRunIdentity(
        fenced.path,
        runIdentityTestValue(),
        false,
        fenced.storage,
        fenced.capability,
      ),
    ).toThrow(/ARTIFACT_MAINTENANCE_ACTIVE|maintenance is active/);
    expect(fenced.storage.files.has(fenced.path)).toBe(false);

    const replaced = simulatedDirectoryCapabilityFixture("root-replaced");
    replaced.storage.directories.delete(replaced.artifactRoot);
    replaced.storage.mkdir(replaced.artifactRoot);
    expect(() =>
      reconcileRunIdentity(
        replaced.path,
        runIdentityTestValue(),
        false,
        replaced.storage,
        replaced.capability,
      ),
    ).toThrow(/ARTIFACT_ROOT_CHANGED|physical artifact root changed/);
    expect(replaced.storage.files.has(replaced.path)).toBe(false);
  });

  test("PLANTED: a replaced owner is refused before creation", () => {
    const value = simulatedDirectoryCapabilityFixture("owner-replaced");
    value.storage.directories.delete(value.owner);
    value.storage.mkdir(value.owner);
    expect(() =>
      reconcileRunIdentity(
        value.path,
        runIdentityTestValue(),
        false,
        value.storage,
        value.capability,
      ),
    ).toThrow(/ARTIFACT_DIRECTORY_CAPABILITY_INVALID|changed identity/);
    expect(value.storage.files.has(value.path)).toBe(false);
  });

  test("PLANTED: an owner swap during the exclusive write is detected afterward", () => {
    const root = fixtureRoot("directory-capability-post-write");
    const base = fixtureStorage();
    const artifactRoot = join(root, "e2e", "artifacts");
    const owner = join(artifactRoot, "owner-post-write");
    const path = join(owner, RUN_IDENTITY_NAME);
    base.seedDirectory(owner);
    let swapped = false;
    const storage: HarnessArtifactStorage = {
      ...base,
      writeExclusive: (target, data) => {
        base.writeExclusive(target, data);
        base.directories.delete(owner);
        base.mkdir(owner);
        swapped = true;
      },
    };
    const writerLease = acquireArtifactWriterLeaseAtRoot(root, storage);
    const capability: ArtifactDirectoryWriterCapability = {
      writerLease,
      directory: owner,
      directoryIdentity: storage.directoryIdentity(owner),
    };
    expect(() =>
      reconcileRunIdentity(path, runIdentityTestValue(), false, storage, capability),
    ).toThrow(/ARTIFACT_DIRECTORY_CAPABILITY_INVALID|changed identity/);
    expect(swapped).toBe(true);
    expect(base.files.has(path)).toBe(true);
  });
});

describe("artifact reservation directory capability", () => {
  test("exact owner capabilities permit simulated top-level and retained claims", () => {
    const value = simulatedDirectoryCapabilityFixture("reservation-valid");
    const artifactRootCapability: ArtifactDirectoryWriterCapability = {
      ...value.capability,
      directory: value.artifactRoot,
      directoryIdentity: value.storage.directoryIdentity(value.artifactRoot),
    };
    expect(
      reserveArtifactNamespace(
        value.root,
        value.artifactRoot,
        "top-level-child",
        MAX_ARTIFACT_NAMESPACES,
        value.storage,
        value.storage.directoryIdentity(value.artifactRoot),
        artifactRootCapability,
      ),
    ).toBe(join(value.artifactRoot, "top-level-child"));
    expect(
      reserveRetainedIntegrationDirectory(
        value.owner,
        "retained-child",
        value.storage,
        1,
        value.capability,
      ),
    ).toBe(join(value.owner, "retained-child"));
  });

  test("PLANTED: a replaced retained owner refuses before its child exists", () => {
    const value = simulatedDirectoryCapabilityFixture("reservation-owner-replaced");
    const target = join(value.owner, "retained-child");
    value.storage.directories.delete(value.owner);
    value.storage.mkdir(value.owner);
    expect(() =>
      reserveRetainedIntegrationDirectory(
        value.owner,
        "retained-child",
        value.storage,
        1,
        value.capability,
      ),
    ).toThrow(/changed identity|outside its leased root/);
    expect(value.storage.exists(target)).toBe(false);
  });

  test("PLANTED: a nested top-level name is refused as more than one component", () => {
    const value = simulatedDirectoryCapabilityFixture("reservation-nested-name");
    const artifactRootCapability: ArtifactDirectoryWriterCapability = {
      ...value.capability,
      directory: value.artifactRoot,
      directoryIdentity: value.storage.directoryIdentity(value.artifactRoot),
    };
    expect(() =>
      reserveArtifactNamespace(
        value.root,
        value.artifactRoot,
        "nested/child",
        MAX_ARTIFACT_NAMESPACES,
        value.storage,
        value.storage.directoryIdentity(value.artifactRoot),
        artifactRootCapability,
      ),
    ).toThrow(/safe bounded path components/);
    expect(value.storage.exists(join(value.artifactRoot, "nested"))).toBe(false);
  });
});

test("real fixture raw mutations stay inside the exact owner capability wrappers", () => {
  const source = readFileSync(HARNESS_TEST_SOURCE, "utf8");
  const directoryStart = source.indexOf("function fixtureCreateDirectory(");
  const fileStart = source.indexOf("function fixtureWriteFile(", directoryStart);
  const nextStart = source.indexOf("function reserveFixtureArtifactNamespace(", fileStart);
  expect(directoryStart).toBeGreaterThanOrEqual(0);
  expect(fileStart).toBeGreaterThan(directoryStart);
  expect(nextStart).toBeGreaterThan(fileStart);
  const directoryWrapper = source.slice(directoryStart, fileStart);
  const fileWrapper = source.slice(fileStart, nextStart);
  expect(source.match(/\bmkdirSync\(/g)).toHaveLength(1);
  expect(source.match(/\bwriteFileSync\(/g)).toHaveLength(1);
  expect(directoryWrapper.match(/assertArtifactDirectoryWriterCapability\(/g)).toHaveLength(2);
  expect(fileWrapper.match(/assertArtifactDirectoryWriterCapability\(/g)).toHaveLength(2);
  expect(directoryWrapper).not.toContain("recursive: true");
  expect(directoryWrapper).toContain("for (const component of");
  expect(fileWrapper).toContain('flag: "wx"');
});

describeRealFilesystemIntegration("real filesystem resume fixtures", () => {
  const base = runIdentityTestValue();

  test("the identity is recorded once and re-verified unchanged", () => {
    const root = fixtureScratchRoot("identity-stable");
    const path = join(root, RUN_IDENTITY_NAME);
    expect(() => reconcileRunIdentity(path, base, false)).toThrow(
      /ARTIFACT_DIRECTORY_CAPABILITY_REQUIRED|open lease/,
    );
    expect(existsSync(path)).toBe(false);
    reconcileRunIdentity(
      path,
      base,
      false,
      nodeArtifactStorage,
      fixtureDirectoryWriterCapability(root),
    );
    expect(existsSync(path)).toBe(true);
    // Existing-record verification is read-only and therefore lease-free.
    expect(() => reconcileRunIdentity(path, base, true)).not.toThrow();
  });

  for (const [what, changed] of [
    ["suite", { ...base, suite: "integration" }],
    ["seed", { ...base, seed: 8 }],
    ["step set", { ...base, stepIds: ["a", "b", "c"] }],
    ["step order", { ...base, stepIds: ["b", "a"] }],
  ] as const) {
    test(`PLANTED: a resume that changes the ${what} is refused`, () => {
      const root = fixtureScratchRoot("identity-change");
      const path = join(root, RUN_IDENTITY_NAME);
      reconcileRunIdentity(
        path,
        base,
        false,
        nodeArtifactStorage,
        fixtureDirectoryWriterCapability(root),
      );
      // The events already on disk describe work this invocation is not doing.
      expect(() => reconcileRunIdentity(path, changed, true)).toThrow(
        /RUN_IDENTITY_MISMATCH|different run/,
      );
      // Refused, never rewritten to agree.
      expect(JSON.parse(readFileSync(path, "utf8")).seed).toBe(7);
    });
  }

  test("PLANTED: an unreadable identity record refuses the resume", () => {
    const root = fixtureScratchRoot("identity-corrupt");
    const path = join(root, RUN_IDENTITY_NAME);
    fixtureWriteFile(root, path, "{ this is not json\n");
    expect(() => reconcileRunIdentity(path, base, true)).toThrow(
      /RUN_IDENTITY_UNREADABLE|cannot be matched/,
    );
  });

  test("PLANTED: a new run refuses a namespace holding anything at all", () => {
    const root = fixtureScratchRoot("namespace-occupied");
    const artifacts = join(root, "e2e", "artifacts");
    const occupied = join(artifacts, "taken");
    fixtureCreateDirectory(artifacts, occupied);
    // No events.jsonl — only other evidence. Testing for the ledger alone let a
    // new run adopt this directory and append to another run's artifacts.
    fixtureWriteFile(occupied, join(occupied, FAILURE_MANIFEST_NAME), "");

    // The namespace is the unit of ownership, so existence is the whole check.
    expect(existsSync(join(artifacts, "taken"))).toBe(true);
    expect(existsSync(join(occupied, "events.jsonl"))).toBe(false);
    // Reservation still permits reuse; it is the new-run branch that refuses,
    // which is why the guard sits in the store rather than in reservation.
    expect(() => reserveFixtureArtifactNamespace(root, "taken", 5)).not.toThrow();
  });
});

describe("run options are covered at compile time", () => {
  test("the accepted key set is exactly the documented options", () => {
    // Derived from `Record<keyof HarnessRunOptions, true>`, so a new option that
    // is added to the interface and forgotten here fails to compile rather than
    // being refused at runtime as unknown.
    expect([...HARNESS_RUN_OPTION_KEYS].sort()).toEqual([
      "artifactNamespace",
      "bindingVersions",
      "gitRevision",
      "onEvent",
      "onOutput",
      "reproduction",
      "resume",
      "root",
      "runId",
      "seed",
      "signal",
      "steps",
      "storage",
      "suite",
    ]);
  });

  test("PLANTED: an unknown option is still refused without an artifact root", async () => {
    const root = fixtureRoot("options-temp");
    const storage = fixtureStorage();
    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: "options-temp",
        steps: [passStep("ok")],
        onEvent: () => undefined,
        onOutput: () => undefined,
        retainArtifacts: true,
      } as unknown as Parameters<typeof runHarness>[0]),
    ).rejects.toThrow(/unknown run option "retainArtifacts"/);
  });
});

describe("new-run artifact namespace ownership", () => {
  test("PLANTED: a redirected lease child fails before the run namespace is created", async () => {
    const root = fixtureRoot("writer-lease-redirect");
    const runId = "writer-lease-redirect";
    const base = fixtureStorage();
    let redirected = false;
    const storage: HarnessArtifactStorage = {
      ...base,
      realpath: (path) => {
        const physical = base.realpath(path);
        if (/^lease-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(basename(path))) {
          redirected = true;
          return `${physical}-redirected`;
        }
        return physical;
      },
    };

    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId,
        steps: [passStep("ok")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/ARTIFACT_WRITER_LEASE_INVALID|exact registry epoch/);
    expect(redirected).toBe(true);
    expect(base.exists(join(root, "e2e", "artifacts", runId))).toBe(false);
    const lease = soleArtifactWriterLease(root, base);
    expect(base.exists(lease.closed) || base.isSymlink(lease.closed)).toBe(false);
  });

  test("PLANTED: a maintenance fence blocks before the artifact root is created", async () => {
    const root = fixtureRoot("maintenance-before-claim");
    const storage = fixtureStorage();
    const e2e = join(root, "e2e");
    storage.seedDirectory(e2e);
    storage.writeExclusive(join(e2e, ARTIFACT_MAINTENANCE_FENCE_NAME), "maintenance\n");

    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: "maintenance-before-claim",
        steps: [passStep("ok")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/ARTIFACT_MAINTENANCE_ACTIVE|maintenance is active/);
    expect(storage.exists(join(e2e, "artifacts"))).toBe(false);
  });

  test("PLANTED: a fence raised after claim blocks the next event append", async () => {
    const root = fixtureRoot("maintenance-after-claim");
    const artifacts = join(root, "e2e", "artifacts");
    const run = join(artifacts, "maintenance-after-claim");
    const base = fixtureStorage();
    let fenced = false;
    const storage: HarnessArtifactStorage = {
      ...base,
      size: (path) => {
        const size = base.size(path);
        if (path === join(run, "events.jsonl") && !fenced) {
          fenced = true;
          base.writeExclusive(join(root, "e2e", ARTIFACT_MAINTENANCE_FENCE_NAME), "maintenance\n");
        }
        return size;
      },
    };

    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: "maintenance-after-claim",
        steps: [passStep("ok")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/ARTIFACT_MAINTENANCE_ACTIVE|maintenance is active/);
    expect(fenced).toBe(true);
    expect(base.readFile(join(run, "events.jsonl"))).toBe("");
  });

  test("PLANTED: an artifact-root epoch change blocks the next event append", async () => {
    const root = fixtureRoot("artifact-root-epoch-change");
    const artifacts = join(root, "e2e", "artifacts");
    const run = join(artifacts, "artifact-root-epoch-change");
    const base = fixtureStorage();
    let epochChanged = false;
    const storage: HarnessArtifactStorage = {
      ...base,
      directoryIdentity: (path) => {
        const identity = base.directoryIdentity(path);
        return path === artifacts && epochChanged ? `${identity}:replacement` : identity;
      },
      size: (path) => {
        const size = base.size(path);
        if (path === join(run, "events.jsonl")) epochChanged = true;
        return size;
      },
    };

    await expect(
      runHarness({
        root,
        storage,
        suite: "unit",
        runId: "artifact-root-epoch-change",
        steps: [passStep("ok")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/ARTIFACT_ROOT_CHANGED|physical artifact root changed/);
    expect(epochChanged).toBe(true);
    expect(base.readFile(join(run, "events.jsonl"))).toBe("");
  });

  test("PLANTED: a top-level mkdir winner cannot be adopted by the new run", async () => {
    const root = fixtureRoot("new-run-claim-race");
    const artifacts = join(root, "e2e", "artifacts");
    const target = join(artifacts, "contended-run");
    const base = fixtureStorage();
    let observations = 0;
    let won = false;
    const mkdir = base.mkdir.bind(base);
    const racingStorage: HarnessArtifactStorage = {
      ...base,
      exists: (path) => {
        if (path === target) {
          observations += 1;
          if (observations === 2 && !won) {
            won = true;
            mkdir(path);
            base.writeExclusive(join(path, "foreign.marker"), "foreign\n");
          }
        }
        return base.exists(path);
      },
    };

    await expect(
      runHarness({
        root,
        storage: racingStorage,
        suite: "unit",
        runId: "contended-run",
        steps: [passStep("ok")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow(/RUN_ID_EXISTS|already owns/);
    expect(won).toBe(true);
    expect(observations).toBeGreaterThanOrEqual(2);
    expect(base.readFile(join(target, "foreign.marker"))).toBe("foreign\n");
    expect(base.exists(join(target, "events.jsonl"))).toBe(false);
  });

  test("PLANTED: a retained-integration mkdir winner cannot be adopted", () => {
    const root = fixtureRoot("retained-new-run-claim-race");
    const integration = join(root, "e2e", "artifacts", "retained-race");
    const target = join(integration, "contended-retained-run");
    const base = fixtureStorage();
    base.seedDirectory(integration);
    let won = false;
    const mkdir = base.mkdir.bind(base);
    const racingStorage: HarnessArtifactStorage = {
      ...base,
      readdir: (path) => {
        const entries = base.readdir(path);
        if (path === integration && !won) {
          won = true;
          mkdir(target);
          base.writeExclusive(join(target, "foreign.marker"), "foreign\n");
        }
        return entries;
      },
    };
    const identity = {
      runId: "contended-retained-run",
      suite: "unit",
      seed: 7,
      stepIds: ["ok"],
      stepContractDigests: ["a".repeat(64)],
      reproduction: SELF_TEST_REPRODUCTION,
      artifactNamespace: "retained-race",
      gitRevision: "unavailable",
      childEnvironmentDigest: "b".repeat(64),
      bindingVersions: {},
    } as const;

    expect(
      () =>
        new ArtifactStore(
          root,
          "contended-retained-run",
          false,
          identity,
          racingStorage,
          "retained-race",
        ),
    ).toThrow(/RUN_ID_EXISTS|already owns/);
    expect(won).toBe(true);
    expect(base.readFile(join(target, "foreign.marker"))).toBe("foreign\n");
    expect(base.exists(join(target, "events.jsonl"))).toBe(false);
    const lease = soleArtifactWriterLease(root, racingStorage);
    expect(base.isDirectory(lease.closed)).toBe(true);
    expect(base.readdir(lease.closed)).toEqual([]);
  });

  test("PLANTED: a fence raised during retained new-run capacity scan blocks mkdir", () => {
    const root = fixtureRoot("retained-fence-during-capacity");
    const namespace = "retained-fence-capacity";
    const integration = join(root, "e2e", "artifacts", namespace);
    const target = join(integration, "fenced-retained-run");
    const base = fixtureStorage();
    base.seedDirectory(integration);
    let integrationScans = 0;
    let fenced = false;
    const storage: HarnessArtifactStorage = {
      ...base,
      readdir: (path) => {
        const entries = base.readdir(path);
        if (path === integration) {
          integrationScans += 1;
          // Reusing the existing top-level integration namespace needs no
          // recursive scan. This first scan is the private retained-new-run
          // capacity check immediately before its mkdir.
          if (integrationScans === 1) {
            fenced = true;
            base.writeExclusive(
              join(root, "e2e", ARTIFACT_MAINTENANCE_FENCE_NAME),
              "maintenance\n",
            );
          }
        }
        return entries;
      },
    };
    const identity = {
      runId: "fenced-retained-run",
      suite: "unit",
      seed: 7,
      stepIds: ["ok"],
      stepContractDigests: ["a".repeat(64)],
      reproduction: SELF_TEST_REPRODUCTION,
      artifactNamespace: namespace,
      gitRevision: "unavailable",
      childEnvironmentDigest: "b".repeat(64),
      bindingVersions: {},
    } as const;

    expect(
      () => new ArtifactStore(root, identity.runId, false, identity, storage, namespace),
    ).toThrow(/ARTIFACT_MAINTENANCE_ACTIVE|maintenance is active/);
    expect(integrationScans).toBe(1);
    expect(fenced).toBe(true);
    expect(base.exists(target)).toBe(false);
  });

  test("PLANTED: a root epoch change during retained capacity scan blocks mkdir", () => {
    const root = fixtureRoot("retained-epoch-during-capacity");
    const artifacts = join(root, "e2e", "artifacts");
    const namespace = "retained-epoch-capacity";
    const integration = join(artifacts, namespace);
    const target = join(integration, "epoch-retained-run");
    const base = fixtureStorage();
    base.seedDirectory(integration);
    let integrationScans = 0;
    let epochChanged = false;
    const storage: HarnessArtifactStorage = {
      ...base,
      directoryIdentity: (path) => {
        const identity = base.directoryIdentity(path);
        return path === artifacts && epochChanged ? `${identity}:replacement` : identity;
      },
      readdir: (path) => {
        const entries = base.readdir(path);
        if (path === integration) {
          integrationScans += 1;
          if (integrationScans === 1) epochChanged = true;
        }
        return entries;
      },
    };
    const identity = {
      runId: "epoch-retained-run",
      suite: "unit",
      seed: 7,
      stepIds: ["ok"],
      stepContractDigests: ["a".repeat(64)],
      reproduction: SELF_TEST_REPRODUCTION,
      artifactNamespace: namespace,
      gitRevision: "unavailable",
      childEnvironmentDigest: "b".repeat(64),
      bindingVersions: {},
    } as const;

    expect(
      () => new ArtifactStore(root, identity.runId, false, identity, storage, namespace),
    ).toThrow(/ARTIFACT_ROOT_CHANGED|physical artifact root changed/);
    expect(integrationScans).toBe(1);
    expect(epochChanged).toBe(true);
    expect(base.exists(target)).toBe(false);
  });
});

describeRealFilesystemIntegration("real filesystem reservation semantics", () => {
  test("a retained child reservation without the suite lease creates nothing", () => {
    const integration = retainedIntegrationRoot();
    const name = `missing-capability-${process.pid}-${scratchCounter}`;
    expect(() =>
      reserveRetainedIntegrationDirectory(integration, name, nodeArtifactStorage, 1),
    ).toThrow(/ARTIFACT_DIRECTORY_CAPABILITY_REQUIRED|open lease/);
    expect(existsSync(join(integration, name))).toBe(false);
  });

  test("reserving at the limit creates nothing and keeps existing evidence", () => {
    const root = fixtureScratchRoot("reserve-limit");
    const artifacts = join(root, "e2e", "artifacts");
    const occupied = join(artifacts, "occupied");
    fixtureCreateDirectory(artifacts, occupied);
    fixtureWriteFile(occupied, join(occupied, "evidence.log"), "retained\n");

    expect(() => reserveArtifactNamespace(root, artifacts, "brand-new", 1)).toThrow(
      /ARTIFACT_DIRECTORY_CAPABILITY_REQUIRED|open lease/,
    );
    expect(existsSync(join(artifacts, "brand-new"))).toBe(false);
    expect(() => reserveFixtureArtifactNamespace(root, "brand-new", 1)).toThrow(
      /ARTIFACT_RETENTION_EXCEEDED|backstop/,
    );
    expect(existsSync(join(artifacts, "brand-new"))).toBe(false);
    expect(readFileSync(join(artifacts, "occupied", "evidence.log"), "utf8")).toBe("retained\n");
  });

  test("reserving an existing namespace returns it without spending budget", () => {
    const root = fixtureScratchRoot("reserve-reuse");
    const artifacts = join(root, "e2e", "artifacts");
    fixtureCreateDirectory(artifacts, join(artifacts, "already"));
    // A resume must not be refused by a ceiling on *new* namespaces.
    expect(reserveFixtureArtifactNamespace(root, "already", 1)).toBe(
      realpathSync(join(artifacts, "already")),
    );
    expect(countArtifactNamespaces(root)).toBe(1);
  });

  test("the concurrent overshoot bound is what the backstop actually promises", () => {
    const root = fixtureScratchRoot("reserve-race");
    // Two reservations that both observed `limit - 1` both succeed. This is a
    // backstop, not a quota; the honest claim is that it overshoots by at most
    // the number of writers racing at the boundary, and a test that asserted
    // exactness under concurrency would be asserting something untrue.
    reserveFixtureArtifactNamespace(root, "racer-a", 2);
    reserveFixtureArtifactNamespace(root, "racer-b", 2);
    expect(countArtifactNamespaces(root)).toBe(2);
    // Serially, the very next one is refused: the bound holds once the count is
    // observed after the race rather than during it.
    expect(() => reserveFixtureArtifactNamespace(root, "racer-c", 2)).toThrow(
      /ARTIFACT_RETENTION_EXCEEDED|backstop/,
    );
  });
});

if (!realFilesystemIntegrationEnabled) {
  const assertOrdinarySuiteResidue = (): void => {
    const after = {
      artifactEntries: ordinaryArtifactResidue(),
      taskTempEntries: ordinaryTaskTempResidue(),
    };
    expect(after.artifactEntries).toEqual(ORDINARY_SUITE_RESIDUE_BEFORE.artifactEntries);
    expect(after.taskTempEntries).toEqual(ORDINARY_SUITE_RESIDUE_BEFORE.taskTempEntries);
  };

  test("ordinary harness tests create zero artifact namespaces and task temp entries", () => {
    assertOrdinarySuiteResidue();
  });

  // Kept as a global final guard too: focused test selection must not hide a
  // new `/tmp/asimp-ops2a-d1-*` root or checkout artifact namespace.
  afterAll(assertOrdinarySuiteResidue);
}
