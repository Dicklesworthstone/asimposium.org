import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = "scripts/e2e-s2-krater.sh";
const WRANGLER = resolve(REPOSITORY_ROOT, "apps/wire/node_modules/.bin/wrangler");
const BLOCKED_EXIT_CODE = 78;

interface BlockedDiagnostic {
  tool: "bun";
  package: "apps/wire";
  suite: "s2-krater-real-bindings";
  status: "blocked";
  exit_code: 78;
  code: "S2_REAL_BINDING_PROOF_BLOCKED" | "S2_WRANGLER_REQUIRED_FOR_LIFECYCLE_PROOF";
  blocked_on: string;
  forbidden_substitutes: string;
  reproduce: string;
}

function blockRealBindingLane(
  code: BlockedDiagnostic["code"],
  blockedOn: string,
  forbiddenSubstitutes: string,
): never {
  const record: BlockedDiagnostic = {
    tool: "bun",
    package: "apps/wire",
    suite: "s2-krater-real-bindings",
    status: "blocked",
    exit_code: BLOCKED_EXIT_CODE,
    code,
    blocked_on: blockedOn,
    forbidden_substitutes: forbiddenSubstitutes,
    reproduce:
      "cd apps/wire && S2_RUN_REAL_BINDING_INTEGRATION=1 bun test /dev/null --timeout=120000 test/integration/s2-krater-real-bindings.test.ts",
  };
  console.log(JSON.stringify(record));
  process.exit(BLOCKED_EXIT_CODE);
}

// This file has two deliberately separate entry modes:
//
// 1. `bun test /dev/null --timeout=120000 <this-file>` with explicit authority runs the real lifecycle proof.
// 2. `bun <this-file> --capability-probe` is the registered suite's fast capability probe and
//    may exit 78.
//
// A discovered test module must never terminate the shared Bun test process. Doing so lets a
// final blocker overwrite an earlier exit 1, which launders real regressions into "blocked".
const HAS_REAL_BINDING_AUTHORITY = process.env.S2_RUN_REAL_BINDING_INTEGRATION === "1";
const HAS_WRANGLER = existsSync(WRANGLER);
const IS_CAPABILITY_PROBE =
  import.meta.main && process.argv.length === 3 && process.argv[2] === "--capability-probe";

if (IS_CAPABILITY_PROBE) {
  if (!HAS_REAL_BINDING_AUTHORITY) {
    blockRealBindingLane(
      "S2_REAL_BINDING_PROOF_BLOCKED",
      "explicit authority for the two real local Wrangler lifecycle runs",
      "a shell-only regression or skipped discovery run presented as real D1/Workerd lifecycle proof",
    );
  }
  if (!HAS_WRANGLER) {
    blockRealBindingLane(
      "S2_WRANGLER_REQUIRED_FOR_LIFECYCLE_PROOF",
      "apps/wire/node_modules/.bin/wrangler",
      "a mocked binding or missing binary presented as lifecycle proof",
    );
  }
  process.stderr.write(
    "usage: run the authorized lifecycle lane with the reproduce command in the blocker record\n",
  );
  process.exit(2);
}

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
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

const describeRealBindingLane =
  HAS_REAL_BINDING_AUTHORITY && HAS_WRANGLER ? describe : describe.skip;

describeRealBindingLane("S2 real local Wrangler lifecycle proof", () => {
  test("runs only with explicit integration authority and a real Wrangler binary", async () => {
    for (const mode of ["parallel", "sigterm"] as const) {
      const run = await runHarness({ S2_LIFECYCLE_TEST: mode }, 660_000);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('"suite":"s2-krater-lifecycle","status":"pass"');
      expect(run.stdout).toContain('"suite":"s2-krater-evidence","status":"pass"');
      expect(`${run.stdout}\n${run.stderr}`).not.toContain('"status":"fail"');
    }
  }, 1_340_000);
});
