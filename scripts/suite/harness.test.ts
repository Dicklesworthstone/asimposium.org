/**
 * OPS.2a contract tests. These use real Bun child processes and retained temporary
 * fixture roots: no product binding, browser, or network result is fabricated here.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContainedRoot,
  boundedDiff,
  deterministicSeed,
  FORCE_KILL_GRACE_MS,
  HARD_READER_GRACE_MS,
  HARNESS_BLOCKED_EXIT_CODE,
  HARNESS_ROOT_MARKER,
  HARNESS_SCHEMA_VERSION,
  type HarnessError,
  type HarnessEvent,
  type HarnessStep,
  isContainedPath,
  MAX_CAPTURED_OUTPUT_CHARS,
  MAX_DIFF_CHARS,
  MAX_EVENT_DURATION_MS,
  MAX_FAILURE_ARTIFACT_CHARS,
  MAX_FAILURE_ARTIFACTS_PER_RUN,
  MAX_RETRIES_PER_STEP,
  MAX_STEPS_PER_RUN,
  MAX_TIMEOUT_MS,
  orderSteps,
  repositoryRoot,
  runHarness,
  validateHarnessEvent,
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
    adapter: "process",
    status: "pass",
    code: "STEP_PASSED",
    reproduce: "scripts/e2e-test-harness.sh --self-test",
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
const SECRET_EMITTER = fileURLToPath(
  new URL("../harness/self-test-secret-emitter.ts", import.meta.url),
);

/**
 * A disposable root that has explicitly consented to being written to.
 *
 * The marker is the whole point: the runner refuses any directory that is
 * neither this checkout nor carrying it, so a test root has to opt in on the
 * filesystem. Writing it here — rather than passing a flag — is what keeps a
 * stray `--root /Users/someone` refused in a real run.
 */
function fixtureRoot(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `asimposium-harness-${name}-`)));
  mkdirSync(join(root, "e2e"));
  writeFileSync(join(root, HARNESS_ROOT_MARKER), "disposable harness root\n");
  return root;
}

function command(code: string): readonly string[] {
  return [process.execPath, "-e", code];
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
    const records = collectedEvents();
    const result = await runHarness({
      root,
      suite: "unit",
      runId: "order-1",
      steps: unordered,
      onEvent: records.sink,
      onOutput: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(
      records.events.filter((event) => event.record === "step").map((event) => event.step),
    ).toEqual(["a", "c", "b"]);
    const jsonl = readFileSync(result.artifacts.jsonl, "utf8");
    expect(
      jsonl
        .split("\n")
        .filter(Boolean)
        .every((line) => JSON.parse(line).schema_version === HARNESS_SCHEMA_VERSION),
    ).toBe(true);
    expect(readFileSync(result.artifacts.junit, "utf8")).toContain("<testsuite");
  });

  test("distinguishes a deliberate blocked exit from a broken child exit", async () => {
    const blockedRoot = fixtureRoot("blocked");
    const blocked = await runHarness({
      root: blockedRoot,
      suite: "integration",
      runId: "blocked-1",
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
    const failed = await runHarness({
      root: failedRoot,
      suite: "integration",
      runId: "failed-1",
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
  test("retries replay-safe work with attempt accounting", async () => {
    const root = fixtureRoot("retry");
    const counter = join(root, "counter");
    const code = `const fs = require("node:fs"); const path = ${JSON.stringify(counter)}; if (fs.existsSync(path)) { process.exit(0); } else { fs.writeFileSync(path, "one"); process.exit(1); }`;
    const result = await runHarness({
      root,
      suite: "unit",
      runId: "retry-1",
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
  });

  test("timeout and cancellation terminate direct child processes before their delayed side effect", async () => {
    const root = fixtureRoot("cleanup");
    const timeoutMarker = join(root, "timeout-marker");
    const timeout = await runHarness({
      root,
      suite: "e2e",
      runId: "timeout-1",
      steps: [
        {
          id: "timeout",
          scenario: "e2e",
          command: command(
            `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(timeoutMarker)}, "late"), 250);`,
          ),
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
    expect(existsSync(timeoutMarker)).toBe(false);

    const cancellationMarker = join(root, "cancellation-marker");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const cancelled = await runHarness({
      root,
      suite: "e2e",
      runId: "cancelled-1",
      signal: controller.signal,
      steps: [
        {
          id: "cancelled",
          scenario: "e2e",
          command: command(
            `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(cancellationMarker)}, "late"), 250);`,
          ),
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
    expect(existsSync(cancellationMarker)).toBe(false);

    const preCancelled = new AbortController();
    preCancelled.abort();
    const preCancelledMarker = join(root, "pre-cancelled-marker");
    const preCancelledResult = await runHarness({
      root,
      suite: "e2e",
      runId: "pre-cancelled-1",
      signal: preCancelled.signal,
      steps: [
        {
          id: "pre-cancelled",
          scenario: "e2e",
          command: command(
            `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(preCancelledMarker)}, "late"), 250);`,
          ),
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
    expect(existsSync(preCancelledMarker)).toBe(false);
  });

  test("timeout terminates the detached process group, including a planted grandchild", async () => {
    const root = fixtureRoot("process-group");
    const marker = join(root, "grandchild-marker");
    const grandchild = `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "late"), 250); setTimeout(() => process.exit(0), 1000);`;
    const parent = `const cp = require("node:child_process"); cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(() => process.exit(0), 1000);`;
    const result = await runHarness({
      root,
      suite: "e2e",
      runId: "process-group-1",
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
    expect(existsSync(marker)).toBe(false);
  });

  test("uses only a fixed child environment instead of ambient values", async () => {
    const root = fixtureRoot("environment");
    const result = await runHarness({
      root,
      suite: "security",
      runId: "environment-1",
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
    const safeCounter = join(root, "safe-counter");
    const unsafeCounter = join(root, "unsafe-counter");
    const steps: HarnessStep[] = [
      {
        id: "safe",
        scenario: "resume",
        command: command(
          `const fs = require("node:fs"); const path = ${JSON.stringify(safeCounter)}; if (fs.existsSync(path)) process.exit(0); fs.writeFileSync(path, "one"); process.exit(1);`,
        ),
        replaySafe: true,
      },
      {
        id: "unsafe",
        scenario: "resume",
        command: command(
          `require("node:fs").writeFileSync(${JSON.stringify(unsafeCounter)}, "one"); process.exit(1);`,
        ),
        replaySafe: false,
      },
    ];
    const first = await runHarness({
      root,
      suite: "e2e",
      runId: "resume-1",
      steps,
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(first.exitCode).toBe(1);
    const resumed = await runHarness({
      root,
      suite: "e2e",
      runId: "resume-1",
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
    expect(readFileSync(unsafeCounter, "utf8")).toBe("one");
  });
});

describe("secret-safe, bounded artifacts", () => {
  test("redacts argv, child stdout/stderr, diffs and every retained artifact while keeping failure cause visible", async () => {
    const root = fixtureRoot("redaction");
    const secret = ["asimp", "ag", "01JXYZ", "selftest", "neverlog", "canary"].join("_");
    const opaqueValue = "A".repeat(32);
    const opaqueEmitter = join(root, "opaque-output.cjs");
    writeFileSync(opaqueEmitter, 'process.stderr.write("A".repeat(32)); process.exit(1);');
    let visible = "";
    const result = await runHarness({
      root,
      suite: "security",
      runId: "redaction-1",
      steps: [
        {
          id: "opaque",
          scenario: "security",
          command: [process.execPath, opaqueEmitter],
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
      onEvent: () => undefined,
      onOutput: (text) => {
        visible += text;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(visible).toContain("<redacted>");
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain(opaqueValue);
    const retained = [
      result.artifacts.jsonl,
      result.artifacts.junit,
      ...result.artifacts.failureLogs,
    ]
      .map((path) => readFileSync(path, "utf8"))
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

  test("caps failure artifacts and does not retain child output for successful steps", async () => {
    const root = fixtureRoot("caps");
    const large = "x".repeat(MAX_FAILURE_ARTIFACT_CHARS * 3);
    const failure = await runHarness({
      root,
      suite: "unit",
      runId: "cap-failure-1",
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
    expect(
      readFileSync(failure.artifacts.failureLogs[0] as string, "utf8").length,
    ).toBeLessThanOrEqual(MAX_FAILURE_ARTIFACT_CHARS);
    const failureEvent = failure.events.find((event) => event.step === "large-failure");
    expect(failureEvent?.output_chars).toBeLessThanOrEqual(MAX_CAPTURED_OUTPUT_CHARS * 2);
    expect(failureEvent?.output_truncated).toBe(true);

    const success = await runHarness({
      root,
      suite: "unit",
      runId: "cap-success-1",
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
    expect(readFileSync(success.artifacts.jsonl, "utf8")).not.toContain(large);
  });

  test("retains at most the fixed number of failure logs without deleting any prior evidence", async () => {
    const root = fixtureRoot("failure-retention");
    const result = await runHarness({
      root,
      suite: "unit",
      runId: "failure-retention-1",
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
    expect(result.artifacts.failureLogs).toHaveLength(MAX_FAILURE_ARTIFACTS_PER_RUN);
  });
});

describe("runtime contract validation", () => {
  test("rejects secret-bearing argv and unbounded retry, timeout, and command inputs before spawn", async () => {
    const root = fixtureRoot("validation");
    const secret = ["asimp", "ag", "01JXYZ", "argv", "canary"].join("_");
    await expect(
      runHarness({
        root,
        suite: "security",
        runId: "secret-argv-1",
        steps: [
          {
            id: "secret-argv",
            scenario: "security",
            command: [process.execPath, `token=${secret}`],
            replaySafe: true,
          },
        ],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_SECRET_FORBIDDEN" } satisfies Partial<HarnessError>);

    await expect(
      runHarness({
        root,
        suite: "security",
        runId: "bounds-1",
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
    const result = await runHarness({
      root,
      suite: "contract",
      runId: "event-schema-1",
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
    const result = await runHarness({
      root,
      suite: "integration",
      runId: "adapter-unavailable-1",
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

    const root = fixtureRoot("symlink");
    const outside = mkdtempSync(join(tmpdir(), "asimposium-harness-outside-"));
    symlinkSync(outside, join(root, "e2e", "artifacts"), "dir");
    await expect(
      runHarness({
        root,
        suite: "unit",
        runId: "escape-1",
        steps: [passStep("pass")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" } satisfies Partial<HarnessError>);
  });

  test("parallel runs with distinct valid ids remain isolated", async () => {
    const root = fixtureRoot("parallel");
    const runs = await Promise.all(
      ["parallel-a", "parallel-b"].map((runId) =>
        runHarness({
          root,
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
    expect(existsSync(left.artifacts.jsonl)).toBe(true);
    expect(existsSync(right.artifacts.jsonl)).toBe(true);
  });

  test("refuses an unbounded success run before it can retain an arbitrary artifact ledger", async () => {
    const root = fixtureRoot("step-cap");
    await expect(
      runHarness({
        root,
        suite: "unit",
        runId: "step-cap-1",
        steps: Array.from({ length: MAX_STEPS_PER_RUN + 1 }, (_, index) =>
          passStep(`step-${index}`),
        ),
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUN_STEP_LIMIT" } satisfies Partial<HarnessError>);
  });
});

test("the real shell entry point proves the seeded harness-only negative aggregate without a product claim", async () => {
  const root = fixtureRoot("shell");
  const child = Bun.spawn({
    cmd: ["bash", SHELL_HARNESS, "--self-test", "--root", root],
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
  // The verdict must keep disclaiming product correctness even now that real
  // adapters run: a green harness proves the harness, nothing else.
  expect(stdout).toContain("proves nothing about product behavior");
  expect(stderr).toContain("<redacted>");
  expect(stderr).not.toContain("selftest_neverlog_canary");
  // The self-test now drives real adapters end to end — a local D1 database is
  // opened and read several times — so it needs a budget measured in tens of
  // seconds, not the default five.
}, 180_000);

describe("OPS.2a real adapters", () => {
  const ADAPTERS = join(fileURLToPath(new URL("../harness/adapters/", import.meta.url)));

  async function runAdapter(
    file: string,
    mode: "ok" | "planted-fail",
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
    const ok = await runAdapter("d1-rollback.ts", "ok");
    expectPositive(ok, "D1_ADAPTER_UNAVAILABLE");
    if (ok.exitCode !== 0) return;
    const record = JSON.parse(ok.stdout.trim().split("\n").pop() ?? "{}");
    expect(record.code).toBe("D1_TRANSACTION_ROLLED_BACK");
    // Rollback is only demonstrated by re-reading state, never by the error.
    expect(record.batch_rejected).toBe(true);
    expect(record.doomed_row_present).toBe(false);
    expect(record.sentinel_present).toBe(true);
    // Never an absolute path, even for a disposable directory.
    expect(ok.stdout).not.toContain("/Users/");
    expect(ok.stdout).not.toContain("/tmp/");
    expect(record.state_dir_class).toBe("os-temp");
  }, 90000);

  test("PLANTED: the D1 rollback assertion fails when nothing rolled back", async () => {
    const planted = await runAdapter("d1-rollback.ts", "planted-fail");
    if (planted.exitCode === HARNESS_BLOCKED_EXIT_CODE) return;
    expect(planted.exitCode).toBe(1);
    expect(planted.stdout).toContain("D1_TRANSACTION_LEAKED");
  }, 90000);

  test("the HTTP adapter proves a real loopback fault surface", async () => {
    const ok = await runAdapter("http-fault.ts", "ok");
    expectPositive(ok, "HTTP_ADAPTER_UNAVAILABLE");
    if (ok.exitCode !== 0) return;
    const record = JSON.parse(ok.stdout.trim().split("\n").pop() ?? "{}");
    expect(record.code).toBe("HTTP_FAULT_SURFACE_VERIFIED");
    expect(record.observed_status).toBe(500);
    expect(record.route_template).toBe("/fault");
    expect(record.request_id_echoed).toBe(true);
    expect(record.request_id_minted).toBe(true);
    // A route that never answers must be bounded by the client, not by luck.
    expect(record.slow_route_timed_out).toBe(true);
  }, 30000);

  test("PLANTED: the HTTP assertion fails when the status contract is wrong", async () => {
    const planted = await runAdapter("http-fault.ts", "planted-fail");
    expect(planted.exitCode).toBe(1);
    expect(planted.stdout).toContain("HTTP_FAULT_SURFACE_MISMATCH");
  }, 30000);

  test("the browser adapter either asserts real DOM or names its blocker", async () => {
    const ok = await runAdapter("browser-assert.ts", "ok");
    expectPositive(ok, "BROWSER_ADAPTER_UNAVAILABLE");
    const record = JSON.parse(ok.stdout.trim().split("\n").pop() ?? "{}");
    if (ok.exitCode === HARNESS_BLOCKED_EXIT_CODE) {
      expect(record.missing).toBe("@playwright/test");
      return;
    }
    expect(record.code).toBe("BROWSER_ASSERTION_VERIFIED");
    // Artifact policy is disabled, not merely redacted.
    expect(record.artifacts_captured).toBe("none");
    expect(record.screenshot_policy).toBe("disabled");
    expect(record.trace_policy).toBe("disabled");
  }, 90000);

  test("PLANTED: the browser assertion fails on text the page never renders", async () => {
    const planted = await runAdapter("browser-assert.ts", "planted-fail");
    if (planted.exitCode === HARNESS_BLOCKED_EXIT_CODE) return;
    expect(planted.exitCode).toBe(1);
    expect(planted.stdout).toContain("BROWSER_ASSERTION_MISMATCH");
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
    expect(() => assertContainedRoot("relative/path")).toThrow(/absolute/);
    expect(() => assertContainedRoot("")).toThrow(/non-empty/);
    expect(() => assertContainedRoot(undefined)).toThrow(/non-empty/);
    expect(() => assertContainedRoot(join(tmpdir(), `absent-${Date.now()}`))).toThrow(/exist/);
  });

  test("this checkout is accepted, anchored to where the runner lives", () => {
    const checkout = repositoryRoot();
    expect(assertContainedRoot(checkout)).toBe(checkout);
    expect(existsSync(join(checkout, "scripts", "harness", "runner.ts"))).toBe(true);
    expect(existsSync(join(checkout, "package.json"))).toBe(true);
  });

  test("PLANTED: an unrelated absolute directory is refused", () => {
    // The previous rule accepted this and would have created e2e/artifacts in it.
    const unrelated = mkdtempSync(join(tmpdir(), "harness-unrelated-"));
    expect(() => assertContainedRoot(unrelated)).toThrow(/unrelated directory/);
  });

  test("PLANTED: a home directory is refused", () => {
    expect(() => assertContainedRoot(homedir())).toThrow(/home directory/);
  });

  test("PLANTED: the shared temp directory is refused", () => {
    expect(() => assertContainedRoot(tmpdir())).toThrow(/temp directory/);
  });

  test("PLANTED: the parent of this checkout is refused", () => {
    expect(() => assertContainedRoot(resolve(repositoryRoot(), ".."))).toThrow(
      /unrelated directory/,
    );
  });

  test("PLANTED: a directory that merely looks like a checkout is refused", () => {
    // Sentinels are not identity. A lookalike must still be refused, because
    // it is not *this* checkout.
    const impostor = mkdtempSync(join(tmpdir(), "harness-impostor-"));
    mkdirSync(join(impostor, "scripts", "harness"), { recursive: true });
    writeFileSync(join(impostor, "package.json"), "{}\n");
    writeFileSync(join(impostor, "scripts", "harness", "runner.ts"), "// impostor\n");
    expect(() => assertContainedRoot(impostor)).toThrow(/unrelated directory/);
  });

  test("PLANTED: a symlink pointing at this checkout is refused, not followed", () => {
    // Following it would mean the caller named one directory while the harness
    // wrote to another — exactly the confusion this rule prevents.
    const holder = mkdtempSync(join(tmpdir(), "harness-link-"));
    const link = join(holder, "checkout-link");
    symlinkSync(repositoryRoot(), link);
    expect(() => assertContainedRoot(link)).toThrow(/symlink/);
  });

  test("a disposable root is accepted only once it carries the marker", () => {
    const disposable = realpathSync(mkdtempSync(join(tmpdir(), "harness-consent-")));
    expect(() => assertContainedRoot(disposable)).toThrow(/unrelated directory/);
    writeFileSync(join(disposable, HARNESS_ROOT_MARKER), "disposable harness root\n");
    expect(assertContainedRoot(disposable)).toBe(disposable);
  });

  test("a run refuses to start against a root it cannot identify", async () => {
    const unrelated = mkdtempSync(join(tmpdir(), "harness-run-unrelated-"));
    await expect(
      runHarness({
        root: unrelated,
        runId: "root-identity-probe",
        suite: "ops.2a-root",
        steps: [
          { id: "noop", scenario: "unit", replaySafe: true, command: [process.execPath, "-e", ""] },
        ],
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/unrelated directory/);
    // It wrote nothing into the directory it refused.
    expect(existsSync(join(unrelated, "e2e"))).toBe(false);
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
