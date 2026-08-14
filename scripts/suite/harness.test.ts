/**
 * OPS.2a contract tests. These use real Bun child processes and retained temporary
 * fixture roots: no product binding, browser, or network result is fabricated here.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boundedDiff,
  deterministicSeed,
  HARNESS_BLOCKED_EXIT_CODE,
  HARNESS_SCHEMA_VERSION,
  type HarnessError,
  type HarnessEvent,
  type HarnessStep,
  MAX_DIFF_CHARS,
  MAX_FAILURE_ARTIFACT_CHARS,
  MAX_STEPS_PER_RUN,
  orderSteps,
  runHarness,
  validateRunId,
} from "../harness/runner.ts";

const SHELL_HARNESS = fileURLToPath(new URL("../e2e-test-harness.sh", import.meta.url));

function fixtureRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `asimposium-harness-${name}-`));
  mkdirSync(join(root, "e2e"));
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
    expect(failure?.reproduce).toBe("scripts/e2e-test-harness.sh --run-id failed-1");
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
    const secret = "asimp_ag_01JXYZ_redaction_canary";
    let visible = "";
    const result = await runHarness({
      root,
      suite: "security",
      runId: "redaction-1",
      steps: [
        {
          id: "secret",
          scenario: "security",
          command: command(
            `console.log(${JSON.stringify(`token=${secret}`)}); console.error(${JSON.stringify(`Authorization: Bearer ${secret}`)}); process.exit(1);`,
          ),
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
    const retained = [
      result.artifacts.jsonl,
      result.artifacts.junit,
      ...result.artifacts.failureLogs,
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(retained).toContain("<redacted>");
    expect(retained).not.toContain(secret);
    const failure = result.events.find((event) => event.record === "step");
    expect(failure?.argv).toEqual(["bun", "<redacted-argument>", "<redacted-argument>"]);
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
          command: command(`console.error(${JSON.stringify(large)}); process.exit(1)`),
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

    const success = await runHarness({
      root,
      suite: "unit",
      runId: "cap-success-1",
      steps: [
        {
          id: "large-success",
          scenario: "unit",
          command: command(`console.log(${JSON.stringify(large)})`),
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
  expect(stdout).toContain("no product session");
  expect(stderr).toContain("synthetic D1 rollback");
  expect(stderr).toContain("<redacted>");
  expect(stderr).not.toContain("selftest_neverlog_canary");
});
