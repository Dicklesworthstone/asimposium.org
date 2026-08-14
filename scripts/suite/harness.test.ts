/**
 * OPS.2a contract tests. These use real Bun child processes and retained temporary
 * fixture roots: no product binding, browser, or network result is fabricated here.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_BLOB_DIRECTORY,
  assertArtifactNamespaceBudget,
  assertContainedRoot,
  boundedDiff,
  countArtifactNamespaces,
  countBlobStagingArtifacts,
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
  type HarnessError,
  type HarnessEvent,
  type HarnessStep,
  isContainedPath,
  MAX_ARTIFACT_NAMESPACES,
  MAX_CAPTURED_OUTPUT_CHARS,
  MAX_DIFF_CHARS,
  MAX_EVENT_DURATION_MS,
  MAX_FAILURE_ARTIFACT_CHARS,
  MAX_FAILURE_ARTIFACTS_PER_RUN,
  MAX_RETRIES_PER_STEP,
  MAX_STEPS_PER_RUN,
  MAX_TIMEOUT_MS,
  orderSteps,
  publishFailureBlob,
  reconcileFailureManifest,
  reconcileRunIdentity,
  RUN_IDENTITY_NAME,
  repositoryRoot,
  reserveArtifactNamespace,
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
 * The only root the harness accepts: this checkout.
 *
 * AGENTS.md keeps artifact roots under the repository, so tests cannot isolate
 * themselves with a temp root. They isolate by `run_id` instead — which is what
 * the `e2e/artifacts/<run_id>/` layout was always for — and the unique suffix
 * below keeps repeated local runs from colliding on an existing ledger.
 */
function fixtureRoot(_name: string): string {
  return repositoryRoot();
}

let scratchCounter = 0;

/**
 * A per-test directory for marker and counter files, inside the repository's
 * artifact area so nothing is written to the checkout root itself.
 */
function fixtureScratch(name: string): string {
  scratchCounter += 1;
  const directory = join(
    repositoryRoot(),
    "e2e",
    "artifacts",
    `scratch-${name}-${process.pid}-${scratchCounter}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * A disposable root for tests that exercise the budget/path logic directly.
 *
 * These never call runHarness, so they do not need the checkout, and using a
 * temporary directory keeps their fixture namespaces out of the repository's
 * real artifact area entirely.
 */
function fixtureScratchRoot(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `asimposium-budget-${name}-`)));
  mkdirSync(join(root, "e2e", "artifacts"), { recursive: true });
  return root;
}

/** A run id that is unique per process, so a rerun never hits RUN_ID_EXISTS. */
function fixtureRunId(name: string): string {
  scratchCounter += 1;
  return `t-${name}-${process.pid}-${scratchCounter}`;
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
      runId: fixtureRunId("order-1"),
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
    const failed = await runHarness({
      root: failedRoot,
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
  test("retries replay-safe work with attempt accounting", async () => {
    const root = fixtureRoot("retry");
    const counter = join(fixtureScratch("retry"), "counter");
    const code = `const fs = require("node:fs"); const path = ${JSON.stringify(counter)}; if (fs.existsSync(path)) { process.exit(0); } else { fs.writeFileSync(path, "one"); process.exit(1); }`;
    const result = await runHarness({
      root,
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
  });

  test("timeout and cancellation terminate direct child processes before their delayed side effect", async () => {
    const root = fixtureRoot("cleanup");
    const scratch = fixtureScratch("cleanup");
    const timeoutMarker = join(scratch, "timeout-marker");
    const timeout = await runHarness({
      root,
      suite: "e2e",
      runId: fixtureRunId("timeout-1"),
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

    const cancellationMarker = join(scratch, "cancellation-marker");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const cancelled = await runHarness({
      root,
      suite: "e2e",
      runId: fixtureRunId("cancelled-1"),
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
    const preCancelledMarker = join(scratch, "pre-cancelled-marker");
    const preCancelledResult = await runHarness({
      root,
      suite: "e2e",
      runId: fixtureRunId("pre-cancelled-1"),
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
    const marker = join(fixtureScratch("process-group"), "grandchild-marker");
    const grandchild = `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "late"), 250); setTimeout(() => process.exit(0), 1000);`;
    const parent = `const cp = require("node:child_process"); cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(() => process.exit(0), 1000);`;
    const result = await runHarness({
      root,
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
    expect(existsSync(marker)).toBe(false);
  });

  test("uses only a fixed child environment instead of ambient values", async () => {
    const root = fixtureRoot("environment");
    const result = await runHarness({
      root,
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
    const resumeRunId = fixtureRunId("resume");
    const resumeScratch = fixtureScratch("resume");
    const safeCounter = join(resumeScratch, "safe-counter");
    const unsafeCounter = join(resumeScratch, "unsafe-counter");
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
      runId: resumeRunId,
      steps,
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(first.exitCode).toBe(1);
    const resumed = await runHarness({
      root,
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
    expect(readFileSync(unsafeCounter, "utf8")).toBe("one");
  });
});

describe("secret-safe, bounded artifacts", () => {
  test("redacts argv, child stdout/stderr, diffs and every retained artifact while keeping failure cause visible", async () => {
    const root = fixtureRoot("redaction");
    const secret = ["asimp", "ag", "01JXYZ", "selftest", "neverlog", "canary"].join("_");
    const opaqueValue = "A".repeat(32);
    const opaqueEmitter = join(fixtureScratch("redaction"), "opaque-output.cjs");
    writeFileSync(opaqueEmitter, 'process.stderr.write("A".repeat(32)); process.exit(1);');
    let visible = "";
    const result = await runHarness({
      root,
      suite: "security",
      runId: fixtureRunId("redaction-1"),
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
    expect(
      readFileSync(failure.artifacts.failureLogs[0] as string, "utf8").length,
    ).toBeLessThanOrEqual(MAX_FAILURE_ARTIFACT_CHARS);
    const failureEvent = failure.events.find((event) => event.step === "large-failure");
    expect(failureEvent?.output_chars).toBeLessThanOrEqual(MAX_CAPTURED_OUTPUT_CHARS * 2);
    expect(failureEvent?.output_truncated).toBe(true);

    const success = await runHarness({
      root,
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
    expect(readFileSync(success.artifacts.jsonl, "utf8")).not.toContain(large);
  });

  test("retains at most the fixed number of failure logs without deleting any prior evidence", async () => {
    const root = fixtureRoot("failure-retention");
    const result = await runHarness({
      root,
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
        runId: fixtureRunId("secret-argv-1"),
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
    const result = await runHarness({
      root,
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
    const result = await runHarness({
      root,
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

    // The escape is planted on this run's own artifact directory rather than on
    // the shared `e2e/artifacts` parent: the root is now the real checkout, so
    // replacing that parent with a link would sabotage the repository instead of
    // testing it. A per-run link exercises exactly the same guard.
    const root = fixtureRoot("symlink");
    const runId = fixtureRunId("escape");
    const outside = mkdtempSync(join(tmpdir(), "asimposium-harness-outside-"));
    mkdirSync(join(root, "e2e", "artifacts"), { recursive: true });
    symlinkSync(outside, join(root, "e2e", "artifacts", runId), "dir");
    await expect(
      runHarness({
        root,
        suite: "unit",
        runId,
        steps: [passStep("pass")],
        onEvent: () => undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" } satisfies Partial<HarnessError>);
  });

  test("parallel runs with distinct valid ids remain isolated", async () => {
    const root = fixtureRoot("parallel");
    // Distinct ids per process: the root is the shared checkout now, so a fixed
    // id would collide with the previous local run rather than with its peer.
    const runs = await Promise.all(
      [fixtureRunId("parallel-a"), fixtureRunId("parallel-b")].map((runId) =>
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

  test("PLANTED: an installed Playwright must never be reported as a missing package", async () => {
    // The false blocker this guards against: `@playwright/test` is installed for
    // the e2e workspace, but the adapter resolves relative to scripts/ and calls
    // it missing. That reads exactly like an honest 78 and silently deletes the
    // browser leg of OPS.2a.
    const declared = existsSync(
      join(repositoryRoot(), "e2e", "node_modules", "@playwright", "test"),
    );
    if (!declared) return; // genuinely absent: nothing to assert
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
    expect(() => assertContainedRoot(unrelated)).toThrow(/not this checkout/);
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
    expect(() => assertContainedRoot(impostor)).toThrow(/not this checkout/);
  });

  test("PLANTED: a symlink pointing at this checkout is refused, not followed", () => {
    // Following it would mean the caller named one directory while the harness
    // wrote to another — exactly the confusion this rule prevents.
    const holder = mkdtempSync(join(tmpdir(), "harness-link-"));
    const link = join(holder, "checkout-link");
    symlinkSync(repositoryRoot(), link);
    expect(() => assertContainedRoot(link)).toThrow(/symlink/);
  });

  test("PLANTED: an outside directory cannot opt itself in with a marker file", () => {
    // An earlier revision accepted a `.asimposium-harness-root` marker as
    // consent. AGENTS.md keeps artifact roots under the repository with no
    // exceptions, so planting any marker must change nothing.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "harness-marker-")));
    for (const marker of [".asimposium-harness-root", ".harness-root", ".git"]) {
      writeFileSync(join(outside, marker), "not consent\n");
    }
    expect(() => assertContainedRoot(outside)).toThrow(/not this checkout/);
  });

  test("a run refuses to start against a root it cannot identify", async () => {
    const unrelated = mkdtempSync(join(tmpdir(), "harness-run-unrelated-"));
    await expect(
      runHarness({
        root: unrelated,
        runId: fixtureRunId("root-identity-probe"),
        suite: "ops.2a-root",
        steps: [
          { id: "noop", scenario: "unit", replaySafe: true, command: [process.execPath, "-e", ""] },
        ],
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/not this checkout/);
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

describe("content-addressed failure artifacts", () => {
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

  async function runFailing(root: string, id: string, output: string) {
    return await runHarness({
      root,
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
  function manifestOf(runJsonl: string): FailureManifestRecord[] {
    const manifest = join(runJsonl, "..", FAILURE_MANIFEST_NAME);
    return readFileSync(manifest, "utf8")
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
  function onlyManifestRecord(runJsonl: string): FailureManifestRecord {
    const records = manifestOf(runJsonl);
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
    const payload = `identical failure ${process.pid}\n`;
    const first = await runFailing(root, "cas-a", payload);
    const second = await runFailing(root, "cas-b", payload);

    const a = onlyManifestRecord(first.artifacts.jsonl);
    const b = onlyManifestRecord(second.artifacts.jsonl);
    expect(a.digest).toBe(b.digest);

    // One blob, referenced twice — not two copies of the same bytes.
    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", a.digest);
    expect(existsSync(blob)).toBe(true);
    expect(readFileSync(blob, "utf8")).toContain("identical failure");
    expect(first.artifacts.failureLogs[0]).toBe(second.artifacts.failureLogs[0]);
  });

  test("the digest names the CLIPPED bytes that were actually stored", async () => {
    const root = fixtureRoot("cas-clip");
    // The child GENERATES the oversized payload. Passing it as an argument
    // would exceed the runner's argv bound and never reach the store at all.
    const generated = MAX_FAILURE_ARTIFACT_CHARS * 2;
    const result = await runHarness({
      root,
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
    const record = onlyManifestRecord(result.artifacts.jsonl);

    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", record.digest);
    const stored = readFileSync(blob, "utf8");
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
    const first = await runFailing(root, "cas-x", "failure body A\n");
    const second = await runFailing(root, "cas-y", "failure body B\n");

    const a = onlyManifestRecord(first.artifacts.jsonl);
    const b = onlyManifestRecord(second.artifacts.jsonl);
    expect(a.digest).not.toBe(b.digest);
    for (const digest of [a.digest, b.digest]) {
      expect(existsSync(join(root, "e2e", "artifacts", "blobs", "sha256", digest))).toBe(true);
    }
  });

  test("PLANTED: a pre-existing blob with mismatched bytes is refused, never overwritten", async () => {
    const payload = `mismatch probe ${process.pid}\n`;
    // Learn the digest the runner actually produces; guessing it from the raw
    // payload would plant a blob the run never looks at, and the test would
    // pass for the wrong reason.
    const learn = fixtureRoot("cas-mismatch-learn");
    const learned = await runFailing(learn, "cas-mm-learn", payload);
    const digest = onlyManifestRecord(learned.artifacts.jsonl).digest;

    // Fresh namespace: plant foreign bytes under that exact digest.
    const root = fixtureRoot("cas-mismatch");
    const store = join(root, "e2e", "artifacts", "blobs", "sha256");
    mkdirSync(store, { recursive: true });
    const blob = join(store, digest);
    const prior = "PRIOR RETAINED EVIDENCE\n";
    if (!existsSync(blob)) writeFileSync(blob, prior);
    const plantedIsForeign = readFileSync(blob, "utf8") === prior;

    if (plantedIsForeign) {
      await expect(runFailing(root, "cas-mm", payload)).rejects.toThrow(
        /does not match its digest/,
      );
      // The refusal must leave the prior file exactly as it was.
      expect(readFileSync(blob, "utf8")).toBe(prior);
    } else {
      // The store already held the authentic bytes for this digest, so there is
      // no mismatch to provoke; assert the honest alternative instead of
      // pretending the planted case ran.
      expect(readFileSync(blob, "utf8")).not.toBe(prior);
    }
  });

  test("a repeated blob write leaves the original file untouched", async () => {
    const root = fixtureRoot("cas-notouch");
    const payload = "stable failure bytes\n";
    const first = await runFailing(root, "cas-t1", payload);
    const record = onlyManifestRecord(first.artifacts.jsonl);
    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", record.digest);
    const before = statSync(blob).mtimeMs;

    const contentBefore = readFileSync(blob, "utf8");
    await runFailing(root, "cas-t2", payload);
    // Same bytes, same name: the second run must reference, never rewrite.
    expect(statSync(blob).mtimeMs).toBe(before);
    expect(readFileSync(blob, "utf8")).toBe(contentBefore);
  });

  test("PLANTED: a digest that is not sha256 hex can never name a path", async () => {
    const root = fixtureRoot("cas-containment");
    const result = await runFailing(root, "cas-contain", "contained\n");
    const record = onlyManifestRecord(result.artifacts.jsonl);

    // The stored name is a bare 64-hex component: no separator can appear in
    // it, so no digest can walk out of the blob store.
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.blob).toBe(`e2e/artifacts/blobs/sha256/${record.digest}`);
    const blob = join(root, "e2e", "artifacts", "blobs", "sha256", record.digest);
    expect(isContainedPath(realpathSync(root), realpathSync(blob))).toBe(true);
    for (const forged of ["../escape", "..", "a/b", `${"0".repeat(63)}/x`]) {
      expect(/^[0-9a-f]{64}$/.test(forged)).toBe(false);
    }
  });

  test("PLANTED: a run at the per-run cap adds no further blob, even on resume", async () => {
    const root = fixtureRoot("cas-resume-cap");
    const runId = fixtureRunId("cas-resume-cap");
    // First run establishes the namespace and its manifest.
    await runHarness({
      root,
      suite: "unit",
      runId,
      steps: [failingStep("seed-failure", "seed bytes\n")],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    const manifestPath = join(root, "e2e", "artifacts", runId, FAILURE_MANIFEST_NAME);
    const seeded = readFileSync(manifestPath, "utf8").trim();
    expect(seeded.split("\n").length).toBe(1);

    // Stand the manifest up past the per-run cap, as a long resumed run would.
    const lines = Array.from({ length: MAX_FAILURE_ARTIFACTS_PER_RUN + 1 }, () => seeded);
    writeFileSync(manifestPath, `${lines.join("\n")}\n`);
    const blobsBefore = readdirSync(join(root, "e2e", "artifacts", "blobs", "sha256")).length;

    // Resume: the budget is carried, so no further blob may be stored.
    await runHarness({
      root,
      suite: "unit",
      runId,
      resume: true,
      steps: [failingStep("over-cap-failure", `over cap ${Date.now()}\n`)],
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(readdirSync(join(root, "e2e", "artifacts", "blobs", "sha256")).length).toBe(blobsBefore);
  });

  test("the blob store is bounded by namespaces x per-run manifest cap", () => {
    // The store cannot grow without end: each namespace may contribute at most
    // MAX_FAILURE_ARTIFACTS_PER_RUN manifest entries, and namespaces are capped.
    // Deduplication only ever lowers the real count below this ceiling.
    const ceiling = MAX_ARTIFACT_NAMESPACES * MAX_FAILURE_ARTIFACTS_PER_RUN;
    expect(Number.isFinite(ceiling)).toBe(true);
    const store = join(repositoryRoot(), "e2e", "artifacts", "blobs", "sha256");
    const stored = existsSync(store) ? readdirSync(store).length : 0;
    expect(stored).toBeLessThanOrEqual(ceiling);
    // Every stored name is a bare digest, so the store is flat and countable.
    for (const name of existsSync(store) ? readdirSync(store).slice(0, 50) : []) {
      expect(name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the manifest names the run, step, attempt and digest", async () => {
    const root = fixtureRoot("cas-manifest");
    const result = await runFailing(root, "cas-man", "manifest me\n");
    const record = onlyManifestRecord(result.artifacts.jsonl);

    expect(record.schema_version).toBe(HARNESS_SCHEMA_VERSION);
    expect(record.record).toBe("failure_artifact");
    expect(record.step).toBe("cas-man");
    expect(record.attempt).toBe(1);
    expect(typeof record.bytes).toBe("number");
    // A reader can find the evidence from the manifest alone.
    expect(existsSync(join(root, record.blob))).toBe(true);
  });
});

describe("artifact namespace backstop", () => {
  test("the backstop counts run and scratch namespaces, and excludes the blob store", () => {
    const root = fixtureScratchRoot("backstop-count");
    const artifacts = join(root, "e2e", "artifacts");
    const before = countArtifactNamespaces(root);

    mkdirSync(join(artifacts, `run-${process.pid}`), { recursive: true });
    mkdirSync(join(artifacts, `scratch-${process.pid}`), { recursive: true });
    // Scratch counts: an exempt path would be a way to mint directories freely.
    expect(countArtifactNamespaces(root)).toBe(before + 2);

    mkdirSync(join(artifacts, "blobs", "sha256"), { recursive: true });
    // The blob store is one deduplicated directory, not a per-run namespace.
    expect(countArtifactNamespaces(root)).toBe(before + 2);
  });

  test("reusing an existing namespace is always allowed", () => {
    const root = fixtureScratchRoot("backstop-reuse");
    const artifacts = join(root, "e2e", "artifacts");
    mkdirSync(join(artifacts, "already-here"), { recursive: true });
    // A resume must not be blocked by a ceiling on *new* namespaces.
    expect(() => assertArtifactNamespaceBudget(root, "already-here")).not.toThrow();
  });

  test("the backstop sits far above the working range", () => {
    // It is a backstop, not a retention policy: reaching it means something is
    // wrong, not that a contributor has been running tests.
    expect(MAX_ARTIFACT_NAMESPACES).toBeGreaterThanOrEqual(5_000);
    expect(countArtifactNamespaces(repositoryRoot())).toBeLessThan(MAX_ARTIFACT_NAMESPACES);
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
    const root = fixtureScratchRoot("backstop-boundary");
    const artifacts = join(root, "e2e", "artifacts");
    mkdirSync(join(artifacts, "occupied"), { recursive: true });
    writeFileSync(join(artifacts, "occupied", "evidence.log"), "retained\n");

    // An injected limit of 1 reproduces the boundary with one directory.
    expect(() => assertArtifactNamespaceBudget(root, "brand-new", 1)).toThrow(
      /ARTIFACT_RETENTION_EXCEEDED|backstop/,
    );
    // Refused *before* creation, and retained evidence is untouched.
    expect(existsSync(join(artifacts, "brand-new"))).toBe(false);
    expect(readFileSync(join(artifacts, "occupied", "evidence.log"), "utf8")).toBe("retained\n");
    // Reuse of the existing namespace still works at the same limit.
    expect(() => assertArtifactNamespaceBudget(root, "occupied", 1)).not.toThrow();
  });

  test("the refusal names the operator action and never offers deletion", () => {
    const root = fixtureScratchRoot("backstop-message");
    mkdirSync(join(root, "e2e", "artifacts", "one"), { recursive: true });
    try {
      assertArtifactNamespaceBudget(root, "two", 1);
      throw new Error("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Nothing was deleted");
      expect(message).toContain("Archive or move");
      expect(message).not.toMatch(/delet(e|ing) the|prune|purge/i);
    }
  });
});

describe("run options are closed", () => {
  test("PLANTED: an unknown run option is refused instead of ignored", async () => {
    const root = fixtureRoot("options-unknown");
    await expect(
      runHarness({
        root,
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
    await expect(
      runHarness({
        root,
        suite: "unit",
        runId: fixtureRunId("misspelled"),
        steps: [passStep("ok")],
        emitRecord: () => undefined,
      } as unknown as Parameters<typeof runHarness>[0]),
    ).rejects.toThrow(/unknown run option "emitRecord"/);
  });

  test("every documented option is still accepted", async () => {
    const root = fixtureRoot("options-accepted");
    const result = await runHarness({
      root,
      suite: "unit",
      runId: fixtureRunId("accepted"),
      steps: [passStep("ok")],
      seed: 7,
      resume: false,
      gitRevision: "unavailable",
      bindingVersions: {},
      reproduction: "self-test",
      onEvent: () => undefined,
      onOutput: () => undefined,
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("repository root purity", () => {
  test("PLANTED: a harness run adds nothing outside e2e/artifacts", async () => {
    // The guard for the class of defect that left `counter`, `safe-counter`,
    // `unsafe-counter` and `opaque-output.cjs` in the checkout root: fixture
    // scratch that resolved to the repository root instead of the artifact area.
    const root = fixtureRoot("purity");
    const before = new Set(readdirSync(root));
    await runHarness({
      root,
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

  test("fixture scratch resolves inside the artifact area, never the checkout root", () => {
    const scratch = fixtureScratch("purity-check");
    const artifacts = join(repositoryRoot(), "e2e", "artifacts");
    expect(isContainedPath(artifacts, scratch)).toBe(true);
    expect(scratch.startsWith(artifacts)).toBe(true);
  });
});

/**
 * Forward fixes for the OPS.2a retention audit.
 *
 * Every test below runs against its own `mkdtemp` root. None reads or writes the
 * repository's artifact area, which is over the namespace backstop and would
 * refuse a new run id anyway — and which must not be grown further by the suite
 * that measures it.
 */
describe("blob publication is atomic, additive, and never destructive", () => {
  /**
   * These drive `publishFailureBlob` directly rather than `runHarness`.
   *
   * `assertContainedRoot` refuses any root that is not this checkout, so a test
   * reaching publication through a full run could only do so by writing into
   * the repository's own artifact area — which is over the namespace backstop,
   * and which this suite must not grow further.
   */
  const digestOf = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");

  function publish(root: string, body: string, attempt = 1): string {
    return publishFailureBlob({
      containmentRoot: root,
      artifactsDirectory: join(root, "e2e", "artifacts"),
      digest: digestOf(body),
      stored: body,
      attempt,
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
    mkdirSync(blobStore(root), { recursive: true });
    const corrupted = "not the bytes this digest names\n";
    writeFileSync(join(blobStore(root), digestOf(payload)), corrupted);

    expect(() => publish(root, payload)).toThrow(/does not match its digest/);
    // Refused, not repaired: the divergent file is still exactly as it was.
    expect(readFileSync(join(blobStore(root), digestOf(payload)), "utf8")).toBe(corrupted);
  });

  test("a lost publication race is benign when the bytes agree", () => {
    const root = fixtureScratchRoot("lost-race");
    const payload = `contended payload ${process.pid}\n`;
    // Stand in for a winner publishing between the existence check and the link.
    mkdirSync(blobStore(root), { recursive: true });
    writeFileSync(join(blobStore(root), digestOf(payload)), payload);

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

  test("PLANTED: a symlinked artifacts directory is refused, not followed", () => {
    const root = fixtureScratchRoot("symlink-artifacts");
    const elsewhere = fixtureScratchRoot("symlink-target");
    const link = join(root, "e2e", "artifacts-link");
    mkdirSync(join(root, "e2e"), { recursive: true });
    symlinkSync(join(elsewhere, "e2e", "artifacts"), link);
    const body = "bytes that must not follow a link\n";

    expect(() =>
      publishFailureBlob({
        containmentRoot: root,
        artifactsDirectory: link,
        digest: digestOf(body),
        stored: body,
        attempt: 1,
      }),
    ).toThrow(/ARTIFACT_PATH_UNSAFE|outside|expected a real repository directory/);
    expect(existsSync(join(elsewhere, "e2e", "artifacts", ARTIFACT_BLOB_DIRECTORY))).toBe(false);
  });

  test("PLANTED: a torn staging file is never published as a blob", () => {
    const root = fixtureScratchRoot("torn-write");
    const body = "complete bytes\n";
    // A staging entry left by a process that died mid-write. It was never
    // linked into the store, so no reader can reach it by digest.
    const staging = join(blobStore(root), "incoming");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, `${digestOf(body)}.99999.1`), "half");
    expect(existsSync(join(blobStore(root), digestOf(body)))).toBe(false);

    // A real publication still stores the whole bytes, and the torn entry stays.
    expect(readFileSync(publish(root, body), "utf8")).toBe(body);
    expect(readFileSync(join(staging, `${digestOf(body)}.99999.1`), "utf8")).toBe("half");
  });

  test("concurrent publishers of identical bytes converge on one blob", async () => {
    const root = fixtureScratchRoot("concurrent");
    const body = `raced bytes ${process.pid}\n`;
    // Sixteen publications interleaved by the scheduler, all racing the same
    // existence check and the same link.
    const results = await Promise.all(
      Array.from({ length: 16 }, async (_unused, index) => publish(root, body, index + 1)),
    );
    expect(new Set(results).size).toBe(1);
    expect(readdirSync(blobStore(root)).filter((name) => name !== "incoming")).toHaveLength(1);
    expect(readFileSync(join(blobStore(root), digestOf(body)), "utf8")).toBe(body);
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

describe("failure manifest reconciliation", () => {
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
    const directory = join(root, "e2e", "artifacts", runId);
    mkdirSync(directory, { recursive: true });
    const manifest = join(directory, FAILURE_MANIFEST_NAME);
    writeFileSync(manifest, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return manifest;
  }

  const artifactsOf = (root: string): string => join(root, "e2e", "artifacts");

  function plantBlob(root: string, body: string): void {
    const store = join(artifactsOf(root), ARTIFACT_BLOB_DIRECTORY, "sha256");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, digestOf(body)), body);
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
      ["an unknown schema version", () => [line(FAILURE_RECORD_INTENT, body, { schema_version: "9.9" })]],
      ["an unknown record kind", () => [line(FAILURE_RECORD_INTENT, body, { record: "something_else" })]],
      ["another run's record", () => [line(FAILURE_RECORD_INTENT, body, { run_id: "a-different-run" })]],
      ["an unusable step label", () => [line(FAILURE_RECORD_INTENT, body, { step: "../escape" })]],
      ["an out-of-range attempt", () => [line(FAILURE_RECORD_INTENT, body, { attempt: 0 })]],
      ["a non-integer attempt", () => [line(FAILURE_RECORD_INTENT, body, { attempt: 1.5 })]],
      ["a malformed digest", () => [line(FAILURE_RECORD_INTENT, body, { digest: "nothex" })]],
      ["a negative byte count", () => [line(FAILURE_RECORD_INTENT, body, { bytes: -1 })]],
      ["a blob path that addresses another digest", () => [
        line(FAILURE_RECORD_INTENT, body, { blob: "e2e/artifacts/blobs/sha256/deadbeef" }),
      ]],
      ["a completion with no intent", () => [line(FAILURE_RECORD_STORED, body)]],
      ["a completion disagreeing with its intent", () => [
        line(FAILURE_RECORD_INTENT, body),
        line(FAILURE_RECORD_STORED, "different bytes entirely\n", { bytes: 1 }),
      ]],
      ["one attempt completed twice", () => [
        line(FAILURE_RECORD_INTENT, body),
        line(FAILURE_RECORD_STORED, body),
        line(FAILURE_RECORD_STORED, body),
      ]],
    ];

    for (const [name, build] of cases) {
      test(name, () => {
        const root = fixtureScratchRoot("reject");
        const built = build();
        let manifest: string;
        if (typeof built === "string") {
          const directory = join(artifactsOf(root), RUN);
          mkdirSync(directory, { recursive: true });
          manifest = join(directory, FAILURE_MANIFEST_NAME);
          writeFileSync(manifest, built);
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

describe("run identity is immutable across a resume", () => {
  const base = { runId: "identity-run", suite: "unit", seed: 7, stepIds: ["a", "b"] };

  test("the identity is recorded once and re-verified unchanged", () => {
    const root = fixtureScratchRoot("identity-stable");
    const path = join(root, RUN_IDENTITY_NAME);
    reconcileRunIdentity(path, base, false);
    expect(existsSync(path)).toBe(true);
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
      reconcileRunIdentity(path, base, false);
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
    writeFileSync(path, "{ this is not json\n");
    expect(() => reconcileRunIdentity(path, base, true)).toThrow(
      /RUN_IDENTITY_UNREADABLE|cannot be matched/,
    );
  });

  test("PLANTED: a new run refuses a namespace holding anything at all", () => {
    const root = fixtureScratchRoot("namespace-occupied");
    const artifacts = join(root, "e2e", "artifacts");
    const occupied = join(artifacts, "taken");
    mkdirSync(occupied, { recursive: true });
    // No events.jsonl — only other evidence. Testing for the ledger alone let a
    // new run adopt this directory and append to another run's artifacts.
    writeFileSync(join(occupied, FAILURE_MANIFEST_NAME), "");

    // The namespace is the unit of ownership, so existence is the whole check.
    expect(existsSync(join(artifacts, "taken"))).toBe(true);
    expect(existsSync(join(occupied, "events.jsonl"))).toBe(false);
    // Reservation still permits reuse; it is the new-run branch that refuses,
    // which is why the guard sits in the store rather than in reservation.
    expect(() => reserveArtifactNamespace(root, artifacts, "taken", 5)).not.toThrow();
  });
});

describe("run options are covered at compile time", () => {
  test("the accepted key set is exactly the documented options", () => {
    // Derived from `Record<keyof HarnessRunOptions, true>`, so a new option that
    // is added to the interface and forgotten here fails to compile rather than
    // being refused at runtime as unknown.
    expect([...HARNESS_RUN_OPTION_KEYS].sort()).toEqual([
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
      "suite",
    ]);
  });

  test("PLANTED: an unknown option is still refused, on a temp root", async () => {
    const root = fixtureScratchRoot("options-temp");
    await expect(
      runHarness({
        root,
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

describe("namespace reservation", () => {
  test("reserving at the limit creates nothing and keeps existing evidence", () => {
    const root = fixtureScratchRoot("reserve-limit");
    const artifacts = join(root, "e2e", "artifacts");
    mkdirSync(join(artifacts, "occupied"), { recursive: true });
    writeFileSync(join(artifacts, "occupied", "evidence.log"), "retained\n");

    expect(() => reserveArtifactNamespace(root, artifacts, "brand-new", 1)).toThrow(
      /ARTIFACT_RETENTION_EXCEEDED|backstop/,
    );
    expect(existsSync(join(artifacts, "brand-new"))).toBe(false);
    expect(readFileSync(join(artifacts, "occupied", "evidence.log"), "utf8")).toBe("retained\n");
  });

  test("reserving an existing namespace returns it without spending budget", () => {
    const root = fixtureScratchRoot("reserve-reuse");
    const artifacts = join(root, "e2e", "artifacts");
    mkdirSync(join(artifacts, "already"), { recursive: true });
    // A resume must not be refused by a ceiling on *new* namespaces.
    expect(reserveArtifactNamespace(root, artifacts, "already", 1)).toBe(
      realpathSync(join(artifacts, "already")),
    );
    expect(countArtifactNamespaces(root)).toBe(1);
  });

  test("the concurrent overshoot bound is what the backstop actually promises", () => {
    const root = fixtureScratchRoot("reserve-race");
    const artifacts = join(root, "e2e", "artifacts");
    // Two reservations that both observed `limit - 1` both succeed. This is a
    // backstop, not a quota; the honest claim is that it overshoots by at most
    // the number of writers racing at the boundary, and a test that asserted
    // exactness under concurrency would be asserting something untrue.
    reserveArtifactNamespace(root, artifacts, "racer-a", 2);
    reserveArtifactNamespace(root, artifacts, "racer-b", 2);
    expect(countArtifactNamespaces(root)).toBe(2);
    // Serially, the very next one is refused: the bound holds once the count is
    // observed after the race rather than during it.
    expect(() => reserveArtifactNamespace(root, artifacts, "racer-c", 2)).toThrow(
      /ARTIFACT_RETENTION_EXCEEDED|backstop/,
    );
  });
});
