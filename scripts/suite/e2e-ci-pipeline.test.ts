/**
 * Process-level negative controls for OPS.2b.
 *
 * The real pipeline shell owns sequencing, status evidence, timeout, signal,
 * and descendant cleanup. Test mode replaces every external stage with an
 * explicit planted process; it is labelled `process-test` and can never be
 * mistaken for hosted or live evidence.
 */

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIPELINE = join(REPO_ROOT, "scripts", "e2e-ci-pipeline.sh");
const SCRATCH = mkdtempSync(join(tmpdir(), "asimposium-ci-pipeline-test-"));
const STAGES = [
  "root-gate",
  "worker-deploy",
  "worker-readiness",
  "web-deploy",
  "smoke-agent",
  "smoke-gallery",
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
    ...process.env,
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
  };
  for (const name of [
    "ASIMP_CI_GAUNTLET_OBSERVED_AT",
    "ASIMP_CI_PLAYWRIGHT_OBSERVED_AT",
    "ASIMP_CI_LOAD_OBSERVED_AT",
    "ASIMP_CI_RESTORE_OBSERVED_AT",
    "ASIMP_CI_LAUNCH_OBSERVED_AT",
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

function runPipeline(stage: Stage, outcome: string, timeout = false): PipelineRun {
  const paths = fixture(`${stage}-${outcome}`);
  const environment = plantedEnvironment(stage, outcome, paths);
  if (timeout) environment[timeoutVariable(stage)] = "1";
  const result = spawnSync("bash", [PIPELINE, "--run-id", paths.runId], {
    cwd: REPO_ROOT,
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    tracePath: paths.tracePath,
  };
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
  expect(begunStages(run)).toEqual(STAGES.slice(0, index + 1));

  const evidence = records(run);
  const executable = evidence.filter((record) => record.stage !== undefined);
  expect(executable.map((record) => record.stage)).toEqual(STAGES);
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
  expect(delegated).toHaveLength(5);
  expect(delegated.every((record) => record.status === "not-run")).toBe(true);
  expect(evidence.some((record) => record.code === "PIPELINE_COMPLETE")).toBe(false);
  expect(evidence.some((record) => record.code === "PROCESS_TEST_COMPLETE")).toBe(false);
  expect(evidence.every((record) => record.runner === "process-test")).toBe(true);
}

async function waitForTrace(path: string, stage: Stage): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(`begin:${stage}\n`)) return;
    await Bun.sleep(20);
  }
  throw new Error(`pipeline never began ${stage}`);
}

async function cancelPipeline(stage: Stage): Promise<PipelineRun> {
  const paths = fixture(`${stage}-cancel`);
  const child = spawn("bash", [PIPELINE, "--run-id", paths.runId], {
    cwd: REPO_ROOT,
    env: plantedEnvironment(stage, "hang", paths),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await waitForTrace(paths.tracePath, stage);
  expect(child.kill("SIGTERM")).toBe(true);
  const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    status: completion.code,
    signal: completion.signal,
    stdout,
    stderr,
    tracePath: paths.tracePath,
  };
}

describe("OPS.2b review pipeline orchestration", () => {
  test("the all-pass process control runs each stage in doctrine order", () => {
    const run = runPipeline("smoke-gallery", "pass");
    if (run.status !== 0) {
      console.log("RUN FAILED STDOUT:", run.stdout);
      console.log("RUN FAILED STDERR:", run.stderr);
      console.log("RUN FAILED STATUS:", run.status);
    }

    expect(run.status).toBe(0);
    expect(run.signal).toBeNull();
    expect(begunStages(run)).toEqual(STAGES);
    const evidence = records(run);
    expect(
      evidence.filter((record) => record.stage !== undefined).map((record) => record.status),
    ).toEqual(STAGES.map(() => "pass"));
    expect(evidence.filter((record) => record.record === "delegated-suite")).toHaveLength(5);
    expect(evidence.at(-1)).toMatchObject({
      record: "summary",
      status: "pass",
      code: "PROCESS_TEST_COMPLETE",
      runner: "process-test",
    });
  });

  for (const planted of [17, 23, 78] as const) {
    test(`PLANTED: exit ${planted} propagates unchanged and suppresses every downstream stage`, () => {
      for (const stage of STAGES) {
        const run = runPipeline(stage, String(planted));
        expectStoppedAt(run, stage, planted === 78 ? "blocked" : "fail", planted);
      }
    });
  }

  test(
    "PLANTED: timeout at every stage returns 124, kills descendants, and suppresses success",
    async () => {
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
    },
    30_000,
  );

  test(
    "PLANTED: TERM cancellation at every stage returns 143, cleans descendants, and stops",
    async () => {
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
    },
    30_000,
  );
});
