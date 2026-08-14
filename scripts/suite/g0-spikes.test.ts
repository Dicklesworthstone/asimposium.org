import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

  test("a signal is a failure and a timed-out child receives termination before the runner returns", async () => {
    const root = fixtureRoot();
    const marker = join(root, "terminated-marker");
    const signal = executable(root, "s1", "kill -TERM $$");
    const timeout = executable(
      root,
      "s2",
      `trap 'printf terminated > ${JSON.stringify(marker)}; exit 0' TERM\nwhile :; do sleep 0.01; done`,
    );
    const signalled = await runG0Spikes({
      root,
      spikes: [signal],
      timeoutMs: 2_000,
    });
    const timedOut = await runG0Spikes({
      root,
      spikes: [timeout],
      timeoutMs: 500,
      terminationGraceMs: 100,
    });

    expect(signalled.exitCode).toBe(1);
    expect(signalled.results[0]?.code).toBe("G0_SPIKE_SIGNALLED");
    expect(signalled.results[0]?.signal).toBe("SIGTERM");
    expect(timedOut.exitCode).toBe(1);
    expect(timedOut.results[0]?.code).toBe("G0_SPIKE_TIMEOUT");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("terminated");
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
