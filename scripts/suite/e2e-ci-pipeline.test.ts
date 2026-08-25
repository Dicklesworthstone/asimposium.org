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
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIPELINE = join(REPO_ROOT, "scripts", "e2e-ci-pipeline.sh");
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
      throw new Error("pipeline did not reach the requested cancellation point");
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

  test("internal deploy actions refuse a caller without an orchestrated stage prefix", () => {
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
