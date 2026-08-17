import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = resolve(ROOT, "scripts/e2e-token-lifecycle.sh");
const PACKAGE = resolve(ROOT, "apps/wire/package.json");
const LOCAL_CONFIG = resolve(ROOT, "apps/wire/test/integration/wrangler.token-lifecycle.toml");
const LOCAL_WORKER = resolve(ROOT, "apps/wire/test/integration/token-lifecycle-local-worker.ts");
const PRODUCTION_CONFIG = resolve(ROOT, "infra/wrangler.toml");
const PRODUCTION_INDEX = resolve(ROOT, "apps/wire/src/index.ts");
const EXTERNAL_TMPDIR = "/Volumes/USB_NVME";
const OUTER_LIVE_BUDGET_MS = 180_000;
const OUTER_TERM_GRACE_MS = 15_000;
const OUTER_KILL_GRACE_MS = 5_000;

const FAULT_PLANTS = {
  TOKEN_LIFECYCLE_TEST_BUSY_PORT: "0",
  TOKEN_LIFECYCLE_TEST_DETACHED: "0",
  TOKEN_LIFECYCLE_TEST_LOG_LEAK: "0",
  TOKEN_LIFECYCLE_TEST_PARTIAL_PS: "0",
  TOKEN_LIFECYCLE_TEST_PID_REUSE: "0",
} as const;

async function settleWithin<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<Value | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runHarness(
  args: readonly string[] = [],
  plants: Partial<Record<keyof typeof FAULT_PLANTS, "1">> = {},
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn({
    cmd: ["bash", SCRIPT, ...args],
    cwd: ROOT,
    env: {
      ...process.env,
      ...FAULT_PLANTS,
      ...plants,
      TMPDIR: existsSync(EXTERNAL_TMPDIR) ? EXTERNAL_TMPDIR : process.env.TMPDIR,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let childExited = false;
  const exited = child.exited.then((exitCode) => {
    childExited = true;
    return exitCode;
  });
  const exitCode = await settleWithin(exited, OUTER_LIVE_BUDGET_MS);
  if (exitCode === undefined) {
    if (!childExited) {
      child.kill("SIGTERM");
      if ((await settleWithin(exited, OUTER_TERM_GRACE_MS)) === undefined) {
        child.kill("SIGKILL");
        if ((await settleWithin(exited, OUTER_KILL_GRACE_MS)) === undefined) {
          throw new Error("token lifecycle harness direct bash child survived SIGKILL");
        }
      }
    }
    throw new Error("token lifecycle harness exceeded its bounded local budget");
  }
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

test("token lifecycle harness self-test is ordinary-unit registered and never launches Wrangler", async () => {
  const result = await runHarness(["--self-test"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    '"assertion":"self_test_transitive_source_config_migration_closure"',
  );
  expect(result.stdout).toContain('"wrangler_started":false');

  const packageJson = JSON.parse(readFileSync(PACKAGE, "utf8")) as {
    scripts?: Record<string, string>;
  };
  expect(packageJson.scripts?.["test:token-lifecycle:self"]).toBe(
    "bash ../../scripts/e2e-token-lifecycle.sh --self-test",
  );
  expect(packageJson.scripts?.["test:token-lifecycle:local"]).toBe(
    "bun test --timeout 180000 test/unit/token-lifecycle-harness.test.ts",
  );

  const script = readFileSync(SCRIPT, "utf8");
  expect(script).toContain('[[ "$1" == "--self-test" ]]');
  expect(script).toContain("source_closure_manifest()");
  expect(script).toContain('"scripts/e2e-token-lifecycle.sh"');
  expect(script).toContain("migration closure is not exactly 0001 through 0016");
  expect(script).toContain('"wrangler_started\\":false');
  expect(script).toContain("assert_migration_journal || exit 1");
  expect(script).toContain("assert_source_closure_unchanged || exit 1");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_BUSY_PORT");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_DETACHED");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_PARTIAL_PS");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_PID_REUSE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_LOG_LEAK");
  expect(script).toContain("TOKEN_LIFECYCLE_BARRIER_CAPABILITY");
  expect(script).toContain('"deterministic_barrier":true');
  expect(script).toContain("panic-leaves-no-active-minted-credential");
  expect(script).toContain("W4_FELLOW_MUTATION_NOT_IMPLEMENTED");
  expect(script.indexOf("if (( SELF_TEST == 1 ))")).toBeLessThan(
    script.indexOf(`[[ -x "\${WRANGLER}" ]]`),
  );
  const config = readFileSync(LOCAL_CONFIG, "utf8");
  expect(config).toContain('main = "token-lifecycle-local-worker.ts"');
  expect(config).toContain('TOKEN_LIFECYCLE_LOCAL_HARNESS = "enabled"');
  expect(config).toContain("workers_dev = false");
  const localWorker = readFileSync(LOCAL_WORKER, "utf8");
  expect(localWorker).toContain("await barrier.awaitRevoke()");
  expect(localWorker).toContain('const CONTROL_PREFIX = "/__token-lifecycle/"');
  expect(localWorker).toContain("createApp({ createEnrollmentStore: barrierStore })");
  expect(readFileSync(PRODUCTION_CONFIG, "utf8")).not.toContain("TOKEN_LIFECYCLE_LOCAL_HARNESS");
  expect(readFileSync(PRODUCTION_INDEX, "utf8")).not.toContain("token-lifecycle");
});

test("token lifecycle fault matrix is ordinary, provider-free, and causally proves every local cleanup plant", async () => {
  const cases: readonly {
    readonly plant: keyof typeof FAULT_PLANTS;
    readonly code: string;
    readonly requiresWorkerCleanup: boolean;
  }[] = [
    {
      plant: "TOKEN_LIFECYCLE_TEST_BUSY_PORT",
      code: "TOKEN_LIFECYCLE_PORT_ALREADY_BOUND",
      requiresWorkerCleanup: false,
    },
    {
      plant: "TOKEN_LIFECYCLE_TEST_PARTIAL_PS",
      code: "TOKEN_LIFECYCLE_RESPONDER_IDENTITY_UNPROVEN",
      requiresWorkerCleanup: true,
    },
    {
      plant: "TOKEN_LIFECYCLE_TEST_PID_REUSE",
      code: "TOKEN_LIFECYCLE_RESPONDER_IDENTITY_DRIFT",
      requiresWorkerCleanup: true,
    },
    {
      plant: "TOKEN_LIFECYCLE_TEST_DETACHED",
      code: "TOKEN_LIFECYCLE_DETACHED_STATE_PROCESS_DETECTED",
      requiresWorkerCleanup: true,
    },
    {
      plant: "TOKEN_LIFECYCLE_TEST_LOG_LEAK",
      code: "TOKEN_LIFECYCLE_SECRET_LOG_LEAK",
      requiresWorkerCleanup: true,
    },
  ];

  for (const current of cases) {
    const result = await runHarness([], { [current.plant]: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`"code":"${current.code}"`);
    expect(result.stdout).not.toContain('"code":"TOKEN_LIFECYCLE_LOCAL_PASSED"');
    if (current.requiresWorkerCleanup) {
      expect(result.stdout).toContain(
        '"assertion":"workerd_group_descendants_listener_and_state_fds_reaped","status":"pass"',
      );
    } else {
      expect(result.stdout).not.toContain("ready_workerd_responder_pid_pgid_start_and_argv_pinned");
    }
  }
});

test("token lifecycle bounded live local Workerd+D1 proof is ordinary-unit registered", async () => {
  const result = await runHarness();
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    '"assertion":"concurrent_http_same_key_revoke_exact_replay","deterministic_barrier":true',
  );
  expect(result.stdout).toContain(
    '"assertion":"concurrent_http_same_key_different_body_one_commit_one_conflict","deterministic_barrier":true',
  );
  expect(result.stdout).toContain("panic_zero_active_credentials");
  expect(result.stdout).toContain('"code":"W4_FELLOW_MUTATION_NOT_IMPLEMENTED"');
  expect(result.stdout).toContain('"code":"TOKEN_LIFECYCLE_LOCAL_PASSED"');
});
