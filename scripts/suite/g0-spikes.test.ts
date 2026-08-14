import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatG0Summary, G0_SPIKES, type G0Spike, runG0Spikes } from "./g0-spikes.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "asimposium-g0-spikes-"));
}

function executable(root: string, name: string, body: string): G0Spike {
  const script = `fixtures/${name}.sh`;
  const path = join(root, script);
  mkdirSync(join(root, "fixtures"), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\nset -u -o pipefail\n${body}\n`);
  chmodSync(path, 0o755);
  return { id: name as G0Spike["id"], script };
}

function statusById(summary: Awaited<ReturnType<typeof runG0Spikes>>): Map<string, string> {
  return new Map(summary.results.map((result) => [result.id, result.status]));
}

async function waitFor(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

describe("G0 integration spike aggregation", () => {
  test("the default manifest runs every named spike except the separately owned S-4 invocation", () => {
    expect(G0_SPIKES.map((spike) => spike.id)).toEqual(["s1", "s2", "s3", "s5", "s6"]);
    expect(G0_SPIKES.map((spike) => spike.id)).not.toContain("s4");
  });

  test("a pass plus a blocked spike is non-green and exits 78", async () => {
    const root = fixtureRoot();
    const summary = await runG0Spikes({
      root,
      spikes: [
        executable(root, "s1", 'printf "pass stdout\\n"; printf "pass stderr\\n" >&2; exit 0'),
        executable(root, "s2", 'printf "blocked stderr\\n" >&2; exit 78'),
      ],
      timeoutMs: 2_000,
    });

    expect(summary.status).toBe("blocked");
    expect(summary.exitCode).toBe(78);
    expect(statusById(summary)).toEqual(
      new Map([
        ["s1", "pass"],
        ["s2", "blocked"],
      ]),
    );
  });

  test("a failure outranks a blocked spike and both outcomes remain in the summary", async () => {
    const root = fixtureRoot();
    const summary = await runG0Spikes({
      root,
      spikes: [
        executable(root, "s1", 'printf "planted failure\\n" >&2; exit 1'),
        executable(root, "s2", 'printf "named blocker\\n" >&2; exit 78'),
      ],
      timeoutMs: 2_000,
    });

    expect(summary.status).toBe("fail");
    expect(summary.exitCode).toBe(1);
    expect(summary.results.map((result) => result.status)).toEqual(["fail", "blocked"]);
    expect(summary.results[0]?.code).toBe("G0_SPIKE_FAILED");
  });

  test("a signal is a failure and timeout kills a TERM-ignoring grandchild before it can leak a sentinel", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "grandchild-survived-timeout");
    const started = join(root, "grandchild-started");
    const signal = executable(root, "s1", "kill -TERM $$");
    const timeout = executable(
      root,
      "s2",
      `(trap '' TERM; sleep 0.3; printf leaked > ${JSON.stringify(sentinel)}) &\nprintf started > ${JSON.stringify(started)}\nwhile :; do sleep 0.01; done`,
    );
    const signalled = await runG0Spikes({
      root,
      spikes: [signal],
      timeoutMs: 2_000,
    });
    const timedOut = await runG0Spikes({
      root,
      spikes: [timeout],
      timeoutMs: 100,
      terminationGraceMs: 100,
    });

    expect(signalled.exitCode).toBe(1);
    expect(signalled.results[0]?.code).toBe("G0_SPIKE_SIGNALLED");
    expect(signalled.results[0]?.signal).toBe("SIGTERM");
    expect(timedOut.exitCode).toBe(1);
    expect(timedOut.results[0]?.code).toBe("G0_SPIKE_TIMEOUT");
    await waitFor(started);
    await Bun.sleep(400);
    // The direct-shell-only runner would return after killing its Bash parent,
    // then this TERM-ignoring grandchild would write the sentinel.
    expect(existsSync(sentinel)).toBe(false);
  }, 10_000);

  test("abort kills the current process group and prevents later spikes from starting", async () => {
    const root = fixtureRoot();
    const started = join(root, "grandchild-started-abort");
    const sentinel = join(root, "grandchild-survived-abort");
    const later = join(root, "later-spike-ran");
    const controller = new AbortController();
    const summaryPromise = runG0Spikes({
      root,
      spikes: [
        executable(
          root,
          "s1",
          `(trap '' TERM; sleep 0.3; printf leaked > ${JSON.stringify(sentinel)}) &\nprintf started > ${JSON.stringify(started)}\nwhile :; do sleep 0.01; done`,
        ),
        executable(root, "s2", `printf ran > ${JSON.stringify(later)}`),
      ],
      signal: controller.signal,
      timeoutMs: 2_000,
      terminationGraceMs: 100,
    });

    await waitFor(started);
    controller.abort();
    const summary = await summaryPromise;
    await Bun.sleep(400);

    expect(summary.exitCode).toBe(1);
    expect(summary.results.map((result) => result.code)).toEqual(["G0_SPIKE_ABORTED"]);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(later)).toBe(false);
  }, 10_000);

  test("missing and non-runnable scripts fail before execution", async () => {
    const root = fixtureRoot();
    const nonExecutablePath = join(root, "fixtures", "not-executable.sh");
    mkdirSync(join(root, "fixtures"), { recursive: true });
    writeFileSync(nonExecutablePath, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(nonExecutablePath, 0o000);
    const summary = await runG0Spikes({
      root,
      spikes: [
        { id: "s1", script: "fixtures/missing.sh" },
        { id: "s2", script: "fixtures/not-executable.sh" },
      ],
    });

    expect(summary.exitCode).toBe(1);
    expect(summary.results.map((result) => result.code)).toEqual([
      "G0_SPIKE_SCRIPT_MISSING",
      "G0_SPIKE_SCRIPT_NOT_EXECUTABLE",
    ]);
  });

  test("the consolidated diagnostic redacts an absolute root and credential-shaped spike label", () => {
    const root = fixtureRoot();
    const serialized = formatG0Summary(
      {
        status: "fail",
        exitCode: 1,
        durationMs: 0,
        totals: { pass: 0, fail: 1, blocked: 0 },
        results: [
          {
            id: `${root}/asimp_ag_abcdefghijklmnop`,
            status: "fail",
            code: "G0_SPIKE_FAILED",
            durationMs: 0,
            exitCode: 1,
          },
        ],
      },
      root,
    );

    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("asimp_ag_");
    expect(serialized).toContain("<redacted>");
  });
});
