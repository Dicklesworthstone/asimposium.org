import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = "scripts/e2e-s2-krater.sh";
const REAL_BINDING_INTEGRATION = resolve(
  REPOSITORY_ROOT,
  "apps/wire/test/integration/s2-krater-real-bindings.test.ts",
);

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function exitBefore(
  exited: Promise<number>,
  milliseconds: number,
): Promise<number | undefined> {
  return Promise.race([exited, Bun.sleep(milliseconds).then(() => undefined)]);
}

async function runHarness(env: Record<string, string>, deadlineMs: number): Promise<Run> {
  const child = Bun.spawn({
    cmd: ["bash", SCRIPT],
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let exitCode = await exitBefore(child.exited, deadlineMs);
  if (exitCode === undefined) {
    child.kill("SIGTERM");
    exitCode = await exitBefore(child.exited, 10_000);
  }
  if (exitCode === undefined) {
    child.kill("SIGKILL");
    exitCode = await child.exited;
  }
  const result = { exitCode, stdout: await stdout, stderr: await stderr };
  if (result.exitCode === 137 && deadlineMs > 0) {
    throw new Error(`S2 harness exceeded its bounded test deadline; stderr:\n${result.stderr}`);
  }
  return result;
}

async function discoverRealBindingLane(): Promise<Run> {
  const { S2_RUN_REAL_BINDING_INTEGRATION: _authority, ...environment } = process.env;
  const child = Bun.spawn({
    cmd: ["bun", "test", "apps/wire/test/integration/s2-krater-real-bindings.test.ts"],
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("registered S2 shell and lifecycle regressions", () => {
  test("the fast planted shell regressions are bounded and leave no owned group behind", async () => {
    const modes = [
      "release-race",
      "release-interleaving",
      "term-resistant-release",
      "watchdog-uncertainty",
      "watchdog-self-retire",
      "parent-loss",
      "owner-loss-uncertain",
      "unowned-refusal",
      "pinned-supervisor",
      "journal-timestamps",
      "lsof-scan-failure",
      "legacy-cleanup-failure",
      "legacy-leader-loss",
      "redaction",
      "provenance",
      "indexed-phase-status",
    ] as const;

    for (const mode of modes) {
      const run = await runHarness({ S2_SHELL_REGRESSION_TEST: mode }, 30_000);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('"suite":"s2-krater-shell","status":"pass"');
      expect(run.stdout).toContain('"suite":"s2-krater-evidence","status":"pass"');
      if (mode === "legacy-leader-loss") {
        expect(run.stdout).toContain('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"');
        expect(run.stdout).toContain('"action":"kill-exact-residual-group"');
      } else {
        expect(`${run.stdout}\n${run.stderr}`).not.toContain('"status":"fail"');
      }
    }
  }, 360_000);

  test("an explicit evidence run id is constrained to one safe path component", async () => {
    const run = await runHarness({ S2_RUN_ID: "../not-a-run" }, 30_000);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('"code":"S2_EVIDENCE_RUN_ID_INVALID"');
  });

  test("real-Wrangler lifecycle proof is integration-only and cannot go vacuously green", () => {
    expect(existsSync(REAL_BINDING_INTEGRATION)).toBe(true);
    const source = readFileSync(REAL_BINDING_INTEGRATION, "utf8");
    expect(source).toContain("S2_REAL_BINDING_PROOF_BLOCKED");
    expect(source).toContain("S2_WRANGLER_REQUIRED_FOR_LIFECYCLE_PROOF");
    expect(source).toContain("S2_LIFECYCLE_TEST");
    expect(source).not.toContain('throw new Error("S2_REAL_BINDING');
  });

  test("the registered real-binding discovery emits a typed blocker before Wrangler lifecycle work", async () => {
    const run = await discoverRealBindingLane();
    expect(run.exitCode).toBe(78);
    const recordLine = run.stdout.split("\n").findLast((line) => line.startsWith("{"));
    expect(recordLine).toBeDefined();
    const record = JSON.parse(recordLine ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      tool: "bun",
      package: "apps/wire",
      suite: "s2-krater-real-bindings",
      status: "blocked",
      exit_code: 78,
      code: "S2_REAL_BINDING_PROOF_BLOCKED",
    });
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(
      "runs only with explicit integration authority",
    );
  });
});
