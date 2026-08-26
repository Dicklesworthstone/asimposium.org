/**
 * Process-level negative controls for OPS.2b.
 *
 * The real pipeline shell owns sequencing, status evidence, timeout, signal,
 * and descendant cleanup. Test mode replaces every external stage with an
 * explicit planted process; it is labelled `process-test` and can never be
 * mistaken for hosted or live evidence.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIPELINE = join(REPO_ROOT, "scripts", "e2e-ci-pipeline.sh");
const DIAGNOSTIC_LIBRARY = join(REPO_ROOT, "e2e", "lib", "run-diagnostics.sh");
const SCRATCH = mkdtempSync(join(tmpdir(), "asimposium-ci-pipeline-test-"));
const HELPER_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  LANG: process.env.LANG ?? "C",
  LC_ALL: "C",
  NODE_ENV: "test",
};
const STAGES = [
  "root-gate",
  "smoke-agent",
  "smoke-gallery",
  "worker-deploy",
  "worker-readiness",
  "web-deploy",
] as const;
type Stage = (typeof STAGES)[number];

let runCounter = 0;

interface PipelineRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly tracePath: string;
}

interface EvidenceRecord {
  readonly stage?: string;
  readonly status: string;
  readonly exit_code?: number | null;
  readonly subject_revision?: string | null;
  readonly record?: string;
  readonly code?: string;
  readonly delegated_suite?: string;
  readonly runner: string;
}

function fixture(label: string): { artifactDirectory: string; tracePath: string; runId: string } {
  runCounter += 1;
  const artifactDirectory = join(SCRATCH, `${label}-${runCounter}`);
  mkdirSync(artifactDirectory, { mode: 0o700 });
  return {
    artifactDirectory,
    tracePath: join(artifactDirectory, "trace.txt"),
    runId: `pipeline-test-${label}-${runCounter}`,
  };
}

function plantedEnvironment(
  stage: Stage,
  outcome: string,
  paths: ReturnType<typeof fixture>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    // Keep this allowlist deliberately small. This object is serialized into a
    // helper's `bun -e` source, so spreading the parent environment would put
    // unrelated credentials in the process table and crash diagnostics.
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "C",
    LC_ALL: "C",
    NODE_ENV: "test",
    ASIMP_CI_PROCESS_TEST: "1",
    ASIMP_CI_PROCESS_PLANT_STAGE: stage,
    ASIMP_CI_PROCESS_PLANT_OUTCOME: outcome,
    ASIMP_CI_PROCESS_TRACE: paths.tracePath,
    ASIMP_CI_PROCESS_ARTIFACT_DIRECTORY: paths.artifactDirectory,
    ASIMP_CI_ROOT_GATE_TIMEOUT_SECONDS: "5",
    ASIMP_CI_WORKER_DEPLOY_TIMEOUT_SECONDS: "5",
    ASIMP_CI_WORKER_READINESS_TIMEOUT_SECONDS: "5",
    ASIMP_CI_WEB_DEPLOY_TIMEOUT_SECONDS: "5",
    ASIMP_CI_SMOKE_AGENT_TIMEOUT_SECONDS: "5",
    ASIMP_CI_SMOKE_GALLERY_TIMEOUT_SECONDS: "5",
    ASIMP_CI_GAUNTLET_STATUS: "not-run",
    ASIMP_CI_PLAYWRIGHT_STATUS: "not-run",
    ASIMP_CI_LOAD_STATUS: "not-run",
    ASIMP_CI_RESTORE_STATUS: "not-run",
    ASIMP_CI_LAUNCH_STATUS: "not-run",
    ASIMP_CI_RELEASE_STATUS: "not-run",
  };
  for (const name of [
    "ASIMP_CI_GAUNTLET_OBSERVED_AT",
    "ASIMP_CI_GAUNTLET_REVISION",
    "ASIMP_CI_PLAYWRIGHT_OBSERVED_AT",
    "ASIMP_CI_PLAYWRIGHT_REVISION",
    "ASIMP_CI_LOAD_OBSERVED_AT",
    "ASIMP_CI_LOAD_REVISION",
    "ASIMP_CI_RESTORE_OBSERVED_AT",
    "ASIMP_CI_RESTORE_REVISION",
    "ASIMP_CI_LAUNCH_OBSERVED_AT",
    "ASIMP_CI_LAUNCH_REVISION",
    "ASIMP_CI_RELEASE_OBSERVED_AT",
    "ASIMP_CI_RELEASE_REVISION",
  ]) {
    delete environment[name];
  }
  return environment;
}

function timeoutVariable(stage: Stage): string {
  switch (stage) {
    case "root-gate":
      return "ASIMP_CI_ROOT_GATE_TIMEOUT_SECONDS";
    case "worker-deploy":
      return "ASIMP_CI_WORKER_DEPLOY_TIMEOUT_SECONDS";
    case "worker-readiness":
      return "ASIMP_CI_WORKER_READINESS_TIMEOUT_SECONDS";
    case "web-deploy":
      return "ASIMP_CI_WEB_DEPLOY_TIMEOUT_SECONDS";
    case "smoke-agent":
      return "ASIMP_CI_SMOKE_AGENT_TIMEOUT_SECONDS";
    case "smoke-gallery":
      return "ASIMP_CI_SMOKE_GALLERY_TIMEOUT_SECONDS";
  }
}

function runPipeline(
  stage: Stage,
  outcome: string,
  timeout = false,
  overrides: NodeJS.ProcessEnv = {},
): PipelineRun {
  const paths = fixture(`${stage}-${outcome}`);
  const environment = plantedEnvironment(stage, outcome, paths);
  Object.assign(environment, overrides);
  if (timeout) environment[timeoutVariable(stage)] = "1";
  const resultPath = join(paths.artifactDirectory, "result.json");
  const helperSource = `
    import { spawnSync } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawnSync("bash", [${JSON.stringify(PIPELINE)}, "--run-id", ${JSON.stringify(paths.runId)}], {
      cwd: ${JSON.stringify(REPO_ROOT)},
      env: ${JSON.stringify(environment)},
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(
      ${JSON.stringify(resultPath)},
      JSON.stringify({
        status: child.status,
        signal: child.signal,
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
      }) + "\\n",
    );
  `;
  const helper = spawnSync(process.execPath, ["-e", helperSource], {
    encoding: "utf8",
    env: HELPER_ENV,
    timeout: 30000,
  });
  if (helper.status !== 0) {
    throw new Error(`helper failed: ${helper.stderr}`);
  }
  const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
  return {
    status: parsed.status,
    signal: parsed.signal,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    tracePath: paths.tracePath,
  };
}

function runInternalAction(action: string, runId: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [PIPELINE, action], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C",
      LC_ALL: "C",
      ASIMP_CI_INTERNAL: "1",
      ASIMP_CI_INTERNAL_RUN_ID: runId,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
}

interface ArtifactCapabilityFixture {
  readonly root: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly rootIdentity: string;
  readonly runIdentity: string;
  readonly leaseDirectory: string;
  readonly leaseIdentity: string;
}

function directoryIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("capability fixture path is not a direct directory");
  }
  return `${stat.dev}:${stat.ino}`;
}

function artifactCapabilityFixture(label: string): ArtifactCapabilityFixture {
  runCounter += 1;
  const runId = `ci-capability-${label}-${process.pid}-${runCounter}`;
  const root = join(SCRATCH, `capability-${label}-${runCounter}`);
  const artifacts = join(root, "e2e", "artifacts");
  const runDirectory = join(artifacts, runId);
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const physicalRoot = realpathSync(root);
  const physicalArtifacts = realpathSync(artifacts);
  const physicalRun = realpathSync(runDirectory);
  const rootIdentity = directoryIdentity(physicalArtifacts);
  const identityMatch = /^(\d+):(\d+)$/.exec(rootIdentity);
  if (identityMatch === null) {
    throw new Error("capability fixture identity is malformed");
  }
  const [, device, inode] = identityMatch;
  const leaseDirectory = join(
    physicalRoot,
    "e2e",
    ".artifact-writer-leases",
    `dev-${device}-ino-${inode}`,
    `lease-${process.pid}-${Math.floor(Date.now() / 1000)}-${runCounter}-1`,
  );
  mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });
  return {
    root: physicalRoot,
    runId,
    runDirectory: physicalRun,
    rootIdentity,
    runIdentity: directoryIdentity(physicalRun),
    leaseDirectory,
    leaseIdentity: directoryIdentity(leaseDirectory),
  };
}

function pipelineFunctionSource(name: string, nextName: string): string {
  const source = readFileSync(PIPELINE, "utf8");
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(`\n${nextName}() {`, start);
  if (start < 0 || end < 0) throw new Error(`pipeline function is missing: ${name}`);
  return source.slice(start, end);
}

function runArtifactCapability(
  fixture: ArtifactCapabilityFixture,
  overrides: Partial<ArtifactCapabilityFixture> = {},
): ReturnType<typeof spawnSync> {
  const value = { ...fixture, ...overrides };
  const verifier = pipelineFunctionSource(
    "ci_artifact_capability_directory_at_root",
    "ci_artifact_capability_is_current",
  );
  const script = `
set -u -o pipefail
source "$1"
${verifier}
ci_artifact_capability_directory_at_root "$2" "$3" "$4" "$5" "$6" "$7"
`;
  return spawnSync(
    "bash",
    [
      "-c",
      script,
      "ci-capability-plant",
      DIAGNOSTIC_LIBRARY,
      value.root,
      value.runId,
      value.rootIdentity,
      value.runIdentity,
      value.leaseDirectory,
      value.leaseIdentity,
    ],
    { env: HELPER_ENV, encoding: "utf8", timeout: 10_000 },
  );
}

interface LeaseSettlementPlant {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly leaseDirectory: string;
  readonly leaseIdentity: string;
  readonly escapePid: number | null;
  readonly escapeStop: string;
  readonly lateWrite: string;
  readonly escapeDone: string;
}

function runLeaseSettlementPlant(
  mode: "settled" | "settled-125" | "forced-unsettled" | "wrapper-crash" | "setsid-escape",
): LeaseSettlementPlant {
  runCounter += 1;
  const root = join(SCRATCH, `lease-settlement-${runCounter}`);
  const runId = `ci-lease-settlement-${process.pid}-${runCounter}`;
  const receipt = join(SCRATCH, `lease-settlement-${runCounter}.txt`);
  const escapeReady = join(SCRATCH, `lease-settlement-${runCounter}.ready`);
  const escapeStop = join(SCRATCH, `lease-settlement-${runCounter}.stop`);
  const lateWrite = join(root, "e2e", "artifacts", runId, "escaped-write-after-close");
  const escapeDone = join(SCRATCH, `lease-settlement-${runCounter}.done`);
  mkdirSync(join(root, "e2e"), { recursive: true, mode: 0o700 });

  const source = readFileSync(PIPELINE, "utf8");
  const closerStart = source.indexOf("ci_pipeline_artifact_writer_leases_on_exit() {");
  const closerEnd = source.indexOf(
    "\ntrap 'ci_pipeline_artifact_writer_leases_on_exit' EXIT",
    closerStart,
  );
  if (closerStart < 0 || closerEnd < 0) {
    throw new Error("pipeline lease closer is missing");
  }
  const closer = source.slice(closerStart, closerEnd);
  const bounded = pipelineFunctionSource("run_bounded", "plant_stage");
  const script = `
set -u -o pipefail
source "$1"
PIPELINE_TEST_MODE=1
PIPELINE_ARTIFACT_PROCESS_GROUP_SETTLED=1
PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN=1
CURRENT_WRAPPER_PID=""
ASIMP_CI_PROCESS_FORCE_UNSETTLED="$5"
ASIMP_CI_PROCESS_KILL_WRAPPER_AFTER_SPAWN="$6"
${closer}
${bounded}
e2e_claim_artifact_run_at_root "$2" "$3" || exit 90
printf '%s\\n%s\\n' \
  "\${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[0]}" \
  "\${ASIMPOSIUM_E2E_CLAIM_LEASE_IDENTITIES[0]}" > "$4" || exit 91
trap 'ci_pipeline_artifact_writer_leases_on_exit' EXIT
run_bounded 2 /bin/bash -c "$7"
exit $?
`;
  const result = spawnSync(
    "bash",
    [
      "-c",
      script,
      "ci-lease-settlement-plant",
      DIAGNOSTIC_LIBRARY,
      root,
      runId,
      receipt,
      mode === "forced-unsettled" ? "1" : "0",
      mode === "wrapper-crash" ? "1" : "0",
      mode === "wrapper-crash"
        ? "exec >/dev/null 2>&1 </dev/null; sleep 2"
        : mode === "setsid-escape"
          ? `python3 -c ${JSON.stringify(
              `import os,pathlib,time; os.setsid(); ready = pathlib.Path(${JSON.stringify(escapeReady)}); stop = pathlib.Path(${JSON.stringify(escapeStop)}); late = pathlib.Path(${JSON.stringify(lateWrite)}); done = pathlib.Path(${JSON.stringify(escapeDone)}); closed = pathlib.Path(pathlib.Path(${JSON.stringify(receipt)}).read_text(encoding="utf-8").splitlines()[0], "closed"); ready.write_text(str(os.getpid()) + "\\n", encoding="utf-8"); next((True for _attempt in range(1000) if closed.is_dir() or stop.is_file() or (time.sleep(0.02) is not None)), False); observed_close = closed.is_dir(); observed_close and late.write_text("escaped-after-close\\n", encoding="utf-8"); done.write_text("done\\n", encoding="utf-8")`,
            )} >/dev/null 2>&1 </dev/null & for _attempt in {1..100}; do [[ -f ${JSON.stringify(
              escapeReady,
            )} ]] && exit 0; sleep 0.02; done; exit 98`
          : mode === "settled-125"
            ? "exit 125"
            : "sleep 30 & exit 0",
    ],
    { env: HELPER_ENV, encoding: "utf8", timeout: 10_000 },
  );
  if (!existsSync(receipt)) {
    throw new Error(
      `pipeline lease settlement plant failed before its receipt: ${result.status} ${result.stderr}`,
    );
  }
  const [leaseDirectory, leaseIdentity] = readFileSync(receipt, "utf8").trim().split("\n");
  if (!leaseDirectory || !leaseIdentity) {
    throw new Error("pipeline lease settlement plant omitted its lease receipt");
  }
  const escapePid = existsSync(escapeReady)
    ? Number.parseInt(readFileSync(escapeReady, "utf8").trim(), 10)
    : null;
  if (escapePid !== null && (!Number.isSafeInteger(escapePid) || escapePid <= 0)) {
    throw new Error("pipeline lease settlement plant emitted an invalid escaped PID");
  }
  return {
    status: result.status,
    signal: result.signal,
    leaseDirectory,
    leaseIdentity,
    escapePid,
    escapeStop,
    lateWrite,
    escapeDone,
  };
}

function expectCapabilityGuardBefore(body: string, marker: string, maxLineDistance = 6): void {
  const guard = "ci_artifact_capability_is_current || return 64";
  let markerIndex = body.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  while (markerIndex >= 0) {
    const guardIndex = body.lastIndexOf(guard, markerIndex);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    const guardLine = body.slice(0, guardIndex).split("\n").length;
    const markerLine = body.slice(0, markerIndex).split("\n").length;
    expect(markerLine - guardLine).toBeLessThanOrEqual(maxLineDistance);
    markerIndex = body.indexOf(marker, markerIndex + marker.length);
  }
}

function records(run: PipelineRun): readonly EvidenceRecord[] {
  return run.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as EvidenceRecord);
}

function begunStages(run: PipelineRun): readonly string[] {
  if (!existsSync(run.tracePath)) return [];
  return readFileSync(run.tracePath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("begin:"))
    .map((line) => line.slice("begin:".length));
}

function expectStoppedAt(run: PipelineRun, stage: Stage, status: string, exitCode: number): void {
  const index = STAGES.indexOf(stage);
  expect(run.signal).toBeNull();
  expect(run.status).toBe(exitCode);
  expect(begunStages(run)).toEqual([...STAGES.slice(0, index + 1)]);

  const evidence = records(run);
  const executable = evidence.filter((record) => record.stage !== undefined);
  expect(executable.map((record) => record.stage)).toEqual([...STAGES]);
  for (let position = 0; position < STAGES.length; position += 1) {
    const record = executable[position];
    if (position < index) {
      expect(record).toMatchObject({ stage: STAGES[position], status: "pass", exit_code: 0 });
    } else if (position === index) {
      expect(record).toMatchObject({ stage, status, exit_code: exitCode });
    } else {
      expect(record).toMatchObject({
        stage: STAGES[position],
        status: "not-run",
        exit_code: null,
      });
    }
  }
  const delegated = evidence.filter((record) => record.record === "delegated-suite");
  expect(delegated).toHaveLength(6);
  expect(delegated.every((record) => record.status === "not-run")).toBe(true);
  expect(evidence.some((record) => record.code === "PIPELINE_COMPLETE")).toBe(false);
  expect(evidence.some((record) => record.code === "PROCESS_TEST_COMPLETE")).toBe(false);
  expect(evidence.every((record) => record.runner === "process-test")).toBe(true);
}

async function cancelPipeline(
  stage: Stage,
  point: "during-stage" | "after-record" = "during-stage",
): Promise<PipelineRun> {
  const paths = fixture(`${stage}-cancel-${point}`);
  const resultPath = join(paths.artifactDirectory, "cancel-result.json");
  const environment = plantedEnvironment(stage, point === "during-stage" ? "hang" : "pass", paths);
  if (point === "after-record") {
    environment.ASIMP_CI_PROCESS_PAUSE_AFTER_STAGE_RECORD = stage;
  }
  const marker = `${point === "during-stage" ? "begin" : "recorded"}:${stage}\n`;
  const helperSource = `
    import { spawn } from "node:child_process";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";

    const child = spawn("bash", [${JSON.stringify(PIPELINE)}, "--run-id", ${JSON.stringify(paths.runId)}], {
      cwd: ${JSON.stringify(REPO_ROOT)},
      env: ${JSON.stringify(environment)},
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const completionPromise = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    const deadline = Date.now() + 60000;
    let reached = false;
    while (Date.now() < deadline) {
      if (
        existsSync(${JSON.stringify(paths.tracePath)}) &&
        readFileSync(${JSON.stringify(paths.tracePath)}, "utf8").includes(${JSON.stringify(marker)})
      ) {
        reached = true;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    if (!reached) {
      child.kill("SIGKILL");
      await completionPromise;
      const trace = existsSync(${JSON.stringify(paths.tracePath)})
        ? readFileSync(${JSON.stringify(paths.tracePath)}, "utf8")
        : null;
      throw new Error(
        "pipeline did not reach the requested cancellation point: " +
          JSON.stringify({ marker: ${JSON.stringify(marker)}, stdout, stderr, trace }),
      );
    }
    child.kill("SIGTERM");
    const completion = await completionPromise;

    writeFileSync(
      ${JSON.stringify(resultPath)},
      JSON.stringify({
        status: completion.code,
        signal: completion.signal,
        stdout,
        stderr,
      }) + "\\n",
    );
  `;
  const helper = spawnSync(process.execPath, ["-e", helperSource], {
    encoding: "utf8",
    env: HELPER_ENV,
    timeout: 75000,
  });
  if (helper.status !== 0) {
    throw new Error(
      `cancel helper failed: ${JSON.stringify({ status: helper.status, signal: helper.signal, error: helper.error, stderr: helper.stderr })}`,
    );
  }
  const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
  return {
    status: parsed.status,
    signal: parsed.signal,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    tracePath: paths.tracePath,
  };
}

describe("OPS.2b review pipeline orchestration", () => {
  test("process controls never serialize ambient credentials into helper source", () => {
    const environment = plantedEnvironment("root-gate", "pass", fixture("minimal-environment"));
    const allowedNames = new Set([
      "PATH",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "NODE_ENV",
      "ASIMP_CI_PROCESS_TEST",
      "ASIMP_CI_PROCESS_PLANT_STAGE",
      "ASIMP_CI_PROCESS_PLANT_OUTCOME",
      "ASIMP_CI_PROCESS_TRACE",
      "ASIMP_CI_PROCESS_ARTIFACT_DIRECTORY",
      "ASIMP_CI_PROCESS_SCOPE_PLANT",
      "ASIMP_CI_PROCESS_PAUSE_AFTER_STAGE_RECORD",
      "ASIMP_CI_ROOT_GATE_TIMEOUT_SECONDS",
      "ASIMP_CI_WORKER_DEPLOY_TIMEOUT_SECONDS",
      "ASIMP_CI_WORKER_READINESS_TIMEOUT_SECONDS",
      "ASIMP_CI_WEB_DEPLOY_TIMEOUT_SECONDS",
      "ASIMP_CI_SMOKE_AGENT_TIMEOUT_SECONDS",
      "ASIMP_CI_SMOKE_GALLERY_TIMEOUT_SECONDS",
      "ASIMP_CI_GAUNTLET_STATUS",
      "ASIMP_CI_GAUNTLET_REVISION",
      "ASIMP_CI_PLAYWRIGHT_STATUS",
      "ASIMP_CI_PLAYWRIGHT_REVISION",
      "ASIMP_CI_LOAD_STATUS",
      "ASIMP_CI_LOAD_REVISION",
      "ASIMP_CI_RESTORE_STATUS",
      "ASIMP_CI_RESTORE_REVISION",
      "ASIMP_CI_LAUNCH_STATUS",
      "ASIMP_CI_LAUNCH_REVISION",
      "ASIMP_CI_RELEASE_STATUS",
      "ASIMP_CI_RELEASE_REVISION",
    ]);

    expect(Object.keys(environment).every((name) => allowedNames.has(name))).toBe(true);
    expect(Object.keys(HELPER_ENV).every((name) => allowedNames.has(name))).toBe(true);
    expect(environment.HOME).toBeUndefined();
    expect(HELPER_ENV.HOME).toBeUndefined();
  });

  test("exact inherited artifact capability resolves only its live retained run", () => {
    const capability = artifactCapabilityFixture("positive");
    const result = runArtifactCapability(capability);

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe(capability.runDirectory);
    expect(result.stderr).toBe("");
  });

  test("artifact capability refuses mismatched, foreign, closed, and fenced plants", () => {
    const mismatchPlants: Array<{
      readonly label: string;
      readonly mutate: (
        capability: ArtifactCapabilityFixture,
      ) => Partial<ArtifactCapabilityFixture>;
    }> = [
      { label: "root-identity", mutate: () => ({ rootIdentity: "0:0" }) },
      { label: "run-identity", mutate: () => ({ runIdentity: "0:0" }) },
      {
        label: "foreign-lease",
        mutate: (capability) => ({
          leaseDirectory: capability.runDirectory,
          leaseIdentity: capability.runIdentity,
        }),
      },
      { label: "lease-identity", mutate: () => ({ leaseIdentity: "0:0" }) },
      {
        label: "closed-lease",
        mutate: (capability) => {
          mkdirSync(join(capability.leaseDirectory, "closed"));
          return {};
        },
      },
      {
        label: "maintenance-fence",
        mutate: (capability) => {
          mkdirSync(join(capability.root, "e2e", ".artifact-maintenance"));
          return {};
        },
      },
    ];

    for (const plant of mismatchPlants) {
      const capability = artifactCapabilityFixture(plant.label);
      const result = runArtifactCapability(capability, plant.mutate(capability));
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  test("the parent closes its actual lease only after group and descendant settlement proof", async () => {
    const descendantProofAvailable = process.platform === "linux";
    const settled = runLeaseSettlementPlant("settled");
    expect(settled.signal).toBeNull();
    expect(settled.status).toBe(0);
    expect(directoryIdentity(settled.leaseDirectory)).toBe(settled.leaseIdentity);
    expect(existsSync(join(settled.leaseDirectory, "closed"))).toBe(descendantProofAvailable);

    const settled125 = runLeaseSettlementPlant("settled-125");
    expect(settled125.signal).toBeNull();
    expect(settled125.status).toBe(125);
    expect(directoryIdentity(settled125.leaseDirectory)).toBe(settled125.leaseIdentity);
    expect(existsSync(join(settled125.leaseDirectory, "closed"))).toBe(descendantProofAvailable);

    const unsettled = runLeaseSettlementPlant("forced-unsettled");
    expect(unsettled.signal).toBeNull();
    expect(unsettled.status).toBe(125);
    expect(directoryIdentity(unsettled.leaseDirectory)).toBe(unsettled.leaseIdentity);
    expect(existsSync(join(unsettled.leaseDirectory, "closed"))).toBe(false);

    const crashedWrapper = runLeaseSettlementPlant("wrapper-crash");
    expect(crashedWrapper.signal).toBeNull();
    expect(crashedWrapper.status).toBe(125);
    expect(directoryIdentity(crashedWrapper.leaseDirectory)).toBe(crashedWrapper.leaseIdentity);
    expect(existsSync(join(crashedWrapper.leaseDirectory, "closed"))).toBe(false);

    const escaped = runLeaseSettlementPlant("setsid-escape");
    expect(escaped.escapePid).not.toBeNull();
    const escapedProcessWasAliveAfterReturn =
      descendantProofAvailable && escaped.escapePid !== null
        ? existsSync(`/proc/${escaped.escapePid}`)
        : false;
    writeFileSync(escaped.escapeStop, "stop\n", { mode: 0o600 });
    expect(escaped.signal).toBeNull();
    expect(escaped.status).toBe(0);
    expect(directoryIdentity(escaped.leaseDirectory)).toBe(escaped.leaseIdentity);
    expect(existsSync(join(escaped.leaseDirectory, "closed"))).toBe(descendantProofAvailable);
    if (!descendantProofAvailable || escapedProcessWasAliveAfterReturn) {
      for (let attempt = 0; attempt < 100 && !existsSync(escaped.escapeDone); attempt += 1) {
        await Bun.sleep(25);
      }
      expect(existsSync(escaped.escapeDone)).toBe(true);
    }
    expect(escapedProcessWasAliveAfterReturn).toBe(false);
    expect(existsSync(escaped.lateWrite)).toBe(false);
  }, 30_000);

  test("recursive deployment children are wired to the parent capability boundary", () => {
    const source = readFileSync(PIPELINE, "utf8");
    const stageCommand = pipelineFunctionSource("stage_command", "run_stage");
    const internalStart = source.indexOf("internal_entrypoint() {");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source match
    const internalEnd = source.indexOf('\nif [[ "${1:-}" == __* ]]', internalStart);
    expect(internalStart).toBeGreaterThanOrEqual(0);
    expect(internalEnd).toBeGreaterThan(internalStart);
    const internal = source.slice(internalStart, internalEnd);
    const workerDeploy = pipelineFunctionSource("worker_deploy", "worker_readiness");
    const workerReadiness = pipelineFunctionSource("worker_readiness", "web_deploy");
    const webDeploy = pipelineFunctionSource("web_deploy", "safe_receipt_field");
    const observeWorker = pipelineFunctionSource(
      "observe_active_worker_deployment",
      "worker_deploy",
    );
    const bounded = pipelineFunctionSource("run_bounded", "plant_stage");

    const inheritedCapability = {
      ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY: "ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY",
      ASIMP_CI_INTERNAL_RUN_IDENTITY: "ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY",
      ASIMP_CI_INTERNAL_LEASE_DIRECTORY: "ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY",
      ASIMP_CI_INTERNAL_LEASE_IDENTITY: "ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY",
    } as const;
    for (const [name, selectedName] of Object.entries(inheritedCapability)) {
      expect(stageCommand.split(`${name}="$${name}"`)).toHaveLength(4);
      expect(source).toContain(`${name}="$${selectedName}"`);
    }
    expect(source).not.toContain("export ASIMP_CI_INTERNAL_");
    expect(source.match(/e2e_close_artifact_writer_leases;/g)).toHaveLength(1);
    expect(source).toContain('"$PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN" != "1"');
    expect(bounded).toContain("os.killpg(child.pid, signal.SIGKILL)");
    expect(bounded).toContain("return wait_for_group_absence() and not force_unsettled");
    expect(bounded).toContain("os.set_inheritable(3, False)");
    expect(bounded).toContain("except (OSError, ValueError, subprocess.SubprocessError):");
    expect(bounded).not.toContain("except BaseException:");
    expect(bounded).toContain("pr_set_child_subreaper = 36");
    expect(bounded).toContain('f"/proc/self/task/{os.getpid()}/children"');
    expect(bounded).toContain("os.pidfd_open(pid, 0)");
    expect(bounded).toContain("signal.pidfd_send_signal(pidfd, signum, None, 0)");
    expect(bounded).toContain('acknowledged_exit(status, b"settled")');
    expect(bounded).toContain('acknowledged_exit(status, b"unproven")');
    expect(bounded).toContain("PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN=0");
    expect(source.match(/PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN=1/g)).toHaveLength(1);

    const parentClaimIndex = source.lastIndexOf(
      'e2e_claim_artifact_run_at_root "$repository_root" "$RUN_ID"',
    );
    const parentSelectIndex = source.lastIndexOf(
      'e2e_select_artifact_claim_at_root "$repository_root" "$RUN_ID"',
    );
    const parentCaptureIndex = source.lastIndexOf(
      'ASIMP_CI_INTERNAL_LEASE_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"',
    );
    const parentProofIndex = source.indexOf(
      "ci_artifact_capability_is_current || exit 64",
      parentCaptureIndex,
    );
    const curlHomeIndex = source.indexOf('mkdir "$ARTIFACT_DIRECTORY/curl-home"', parentProofIndex);
    const preWriteProofIndex = source.indexOf(
      "ci_artifact_capability_is_current || exit 64",
      curlHomeIndex,
    );
    const curlConfigIndex = source.indexOf("printf 'user-agent =", preWriteProofIndex);
    expect(parentClaimIndex).toBeGreaterThanOrEqual(0);
    expect(parentSelectIndex).toBeGreaterThan(parentClaimIndex);
    expect(parentCaptureIndex).toBeGreaterThan(parentSelectIndex);
    expect(parentProofIndex).toBeGreaterThan(parentCaptureIndex);
    expect(curlHomeIndex).toBeGreaterThan(parentProofIndex);
    expect(preWriteProofIndex).toBeGreaterThan(curlHomeIndex);
    expect(curlConfigIndex).toBeGreaterThan(preWriteProofIndex);

    const unsetIndex = internal.indexOf("unset ASIMP_CI_INTERNAL");
    const restoreIndex = internal.indexOf(
      'ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY="$inherited_root_identity"',
    );
    const proofIndex = internal.indexOf("ci_artifact_capability_is_current || return 64");
    const revisionIndex = internal.indexOf('REVISION="$(git -C');
    const prefixIndex = internal.indexOf('require_stage_prefix "root-gate');
    expect(unsetIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(unsetIndex);
    expect(proofIndex).toBeGreaterThan(restoreIndex);
    expect(revisionIndex).toBeGreaterThan(proofIndex);
    expect(prefixIndex).toBeGreaterThan(revisionIndex);

    expectCapabilityGuardBefore(observeWorker, 'curl_with_bearer "$CLOUDFLARE_API_TOKEN"');
    expectCapabilityGuardBefore(workerDeploy, 'WRANGLER_OUTPUT_FILE_PATH="$raw_receipt"');
    expectCapabilityGuardBefore(workerDeploy, 'python3 - "$raw_receipt"');
    expectCapabilityGuardBefore(
      workerReadiness,
      'bash "$repository_root/scripts/e2e-environments.sh" staging',
    );
    expectCapabilityGuardBefore(workerReadiness, '--output "$capabilities"');
    expectCapabilityGuardBefore(workerReadiness, 'python3 - "$capabilities"');
    expectCapabilityGuardBefore(
      workerReadiness,
      '--output "$ARTIFACT_DIRECTORY/schema-$index.json"',
    );
    expectCapabilityGuardBefore(webDeploy, "https://api.vercel.com/v9/projects/");
    expectCapabilityGuardBefore(webDeploy, "https://api.vercel.com/v7/deployments?");
    expectCapabilityGuardBefore(webDeploy, 'vercel@$VERCEL_CLI_VERSION" deploy');
    expectCapabilityGuardBefore(webDeploy, "printf '%s' \"$deployment_output\"");
    expectCapabilityGuardBefore(webDeploy, 'vercel@$VERCEL_CLI_VERSION" inspect');
    expectCapabilityGuardBefore(webDeploy, "printf '%s' \"$inspect_output\"");
    expectCapabilityGuardBefore(webDeploy, "https://api.vercel.com/v13/deployments/");
    expectCapabilityGuardBefore(webDeploy, 'python3 - "$inspect_receipt"');
  });

  test("internal deploy actions refuse a caller without a parent capability", () => {
    for (const action of ["__worker_deploy", "__worker_readiness", "__web_deploy"]) {
      runCounter += 1;
      const runId = `pipeline-test-unclaimed-${action.slice(2)}-${process.pid}-${runCounter}`;
      const artifactDirectory = join(REPO_ROOT, "e2e", "artifacts", runId);
      expect(existsSync(artifactDirectory)).toBe(false);
      const result = runInternalAction(action, runId);
      expect(result.signal).toBeNull();
      expect(result.status).toBe(64);
      expect(existsSync(artifactDirectory)).toBe(false);
    }
  });

  test("provider parsers require explicit safe Vercel states", () => {
    const source = readFileSync(PIPELINE, "utf8");

    expect(source).toContain('if "link" in document:');
    expect(source).not.toContain('document.get("link") is not None');
    expect(source).toContain('if state != "READY" or document.get("target") != "preview":');
    expect(source).toContain(
      'if state != "READY" or "target" not in document or document["target"] is not None:',
    );
  });

  test("signal bookkeeping retains an explicit inter-stage terminal path", () => {
    const source = readFileSync(PIPELINE, "utf8");

    expect(source).toContain("NEXT_STAGE_INDEX=0");
    expect(source).toContain('record_not_run_from_index "$NEXT_STAGE_INDEX"');
    expect(source).toContain("NEXT_STAGE_INDEX=$((completed_index + 1))");
  });

  test("delegated pass evidence without the current revision is refused", () => {
    const unbound = runPipeline("smoke-gallery", "pass", false, {
      ASIMP_CI_GAUNTLET_STATUS: "pass",
      ASIMP_CI_GAUNTLET_OBSERVED_AT: "2026-08-24T00:00:00Z",
    });
    expect(unbound.status).toBe(64);
    expect(begunStages(unbound)).toEqual([]);

    const wrongRevision = runPipeline("smoke-gallery", "pass", false, {
      ASIMP_CI_GAUNTLET_STATUS: "pass",
      ASIMP_CI_GAUNTLET_OBSERVED_AT: "2026-08-24T00:00:00Z",
      ASIMP_CI_GAUNTLET_REVISION: "0".repeat(40),
    });
    expect(wrongRevision.status).toBe(64);
    expect(begunStages(wrongRevision)).toEqual([]);
  });

  test("process-test mode is refused under hosted runner markers", () => {
    const run = runPipeline("smoke-gallery", "pass", false, {
      CI: "true",
      WORKERS_CI: "1",
    });
    expect(run.status).toBe(78);
    expect(begunStages(run)).toEqual([]);
    expect(run.stderr).toContain("process-test mode is forbidden");
  });

  test("an invalid process-test selector is refused before any stage", () => {
    const run = runPipeline("smoke-gallery", "pass", false, {
      ASIMP_CI_PROCESS_TEST: "2",
    });
    expect(run.status).toBe(64);
    expect(begunStages(run)).toEqual([]);
    expect(run.stderr).toContain("ASIMP_CI_PROCESS_TEST must be 0 or 1");
  });

  test("stage subprocesses do not inherit an unrelated ambient value", () => {
    const run = runPipeline("smoke-gallery", "pass", false, {
      ASIMP_CI_PROCESS_AMBIENT_CANARY: "must-not-cross-stage-boundary",
    });
    expect(run.status).toBe(0);
    expect(begunStages(run)).toEqual([...STAGES]);
  });

  test("stage subprocesses receive exactly their declared credential scope", () => {
    // These are inert test sentinels, never copies of the caller's provider
    // credentials. The planted pipeline checks presence and absence at every
    // stage boundary before executing the ordinary pass plants.
    const run = runPipeline("smoke-gallery", "pass", false, {
      ASIMP_CI_PROCESS_SCOPE_PLANT: "1",
      CLOUDFLARE_API_TOKEN: "scope-cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "scope-cloudflare-account",
      ASIMP_D1_DATABASE_ID_STAGING: "scope-d1-id",
      ASIMP_STAGING_SERVICE_ENVELOPE_KEYS: "scope-service-keys",
      VERCEL_TOKEN: "scope-vercel-token",
      VERCEL_ORG_ID: "scope-vercel-org",
      VERCEL_PROJECT_ID: "scope-vercel-project",
      ASIMPOSIUM_SMOKE_FELLOW_TOKEN: "scope-fellow-token",
    });
    expect(run.status).toBe(0);
    expect(begunStages(run)).toEqual([...STAGES]);
  });

  test("the all-pass process control runs each stage in doctrine order", () => {
    const run = runPipeline("smoke-gallery", "pass");

    expect(run.status).toBe(0);
    expect(run.signal).toBeNull();
    expect(begunStages(run)).toEqual([...STAGES]);
    const evidence = records(run);
    expect(
      evidence.filter((record) => record.stage !== undefined).map((record) => record.status),
    ).toEqual(STAGES.map(() => "pass"));
    expect(
      evidence
        .filter((record) => record.stage !== undefined)
        .every((record) => record.subject_revision === null),
    ).toBe(true);
    expect(evidence.filter((record) => record.record === "delegated-suite")).toHaveLength(6);
    expect(evidence.at(-1)).toMatchObject({
      record: "summary",
      status: "pass",
      code: "PROCESS_TEST_COMPLETE",
      runner: "process-test",
    });
  }, 60_000);

  for (const planted of [17, 23, 78] as const) {
    test(`PLANTED: exit ${planted} propagates unchanged and suppresses every downstream stage`, () => {
      for (const stage of STAGES) {
        const run = runPipeline(stage, String(planted));
        expectStoppedAt(run, stage, planted === 78 ? "blocked" : "fail", planted);
      }
    }, 60_000);
  }

  test("PLANTED: timeout at every stage returns 124, kills descendants, and suppresses success", async () => {
    const runs: PipelineRun[] = [];
    for (const stage of STAGES) {
      const run = runPipeline(stage, "hang", true);
      expectStoppedAt(run, stage, "timeout", 124);
      runs.push(run);
    }
    await Bun.sleep(3_500);
    for (const run of runs) {
      const trace = readFileSync(run.tracePath, "utf8");
      expect(trace).not.toContain("descendant-survived:");
    }
  }, 60_000);

  test("PLANTED: timeout kills an ignoring descendant after the stage leader exits", async () => {
    const run = runPipeline("worker-deploy", "hang-orphan", true);
    expectStoppedAt(run, "worker-deploy", "timeout", 124);
    await Bun.sleep(3_500);
    expect(readFileSync(run.tracePath, "utf8")).not.toContain("descendant-survived:");
  }, 30_000);

  test("PLANTED: ordinary failure kills an ignoring descendant after the leader exits", async () => {
    const run = runPipeline("worker-deploy", "fail-orphan");
    expectStoppedAt(run, "worker-deploy", "fail", 17);
    await Bun.sleep(3_500);
    expect(readFileSync(run.tracePath, "utf8")).not.toContain("descendant-survived:");
  }, 30_000);

  test("PLANTED: TERM cancellation at every stage returns 143, cleans descendants, and stops", async () => {
    const runs: PipelineRun[] = [];
    for (const stage of STAGES) {
      const run = await cancelPipeline(stage);
      expectStoppedAt(run, stage, "cancelled", 143);
      runs.push(run);
    }
    await Bun.sleep(3_500);
    for (const run of runs) {
      const trace = readFileSync(run.tracePath, "utf8");
      expect(trace).not.toContain("descendant-survived:");
    }
  }, 120_000);

  test("PLANTED: TERM after a durable stage result never adds a contradictory cancellation", async () => {
    for (const stage of STAGES) {
      const run = await cancelPipeline(stage, "after-record");
      const index = STAGES.indexOf(stage);
      expect(run.signal).toBeNull();
      expect(run.status).toBe(143);
      expect(begunStages(run)).toEqual([...STAGES.slice(0, index + 1)]);

      const evidence = records(run);
      const executable = evidence.filter((record) => record.stage !== undefined);
      expect(executable.map((record) => record.stage)).toEqual([...STAGES]);
      for (let position = 0; position < STAGES.length; position += 1) {
        expect(executable[position]).toMatchObject(
          position <= index
            ? { stage: STAGES[position], status: "pass", exit_code: 0 }
            : { stage: STAGES[position], status: "not-run", exit_code: null },
        );
      }
      expect(
        executable.filter((record) => record.stage === stage && record.status === "cancelled"),
      ).toHaveLength(0);
      const delegated = evidence.filter((record) => record.record === "delegated-suite");
      expect(delegated).toHaveLength(6);
      expect(delegated.every((record) => record.status === "not-run")).toBe(true);
      expect(evidence.some((record) => record.code === "PROCESS_TEST_COMPLETE")).toBe(false);
    }
  }, 120_000);
});
