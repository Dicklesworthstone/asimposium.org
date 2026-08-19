import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { GATE_PREFIX, type GateRecord } from "../../scripts/gate-record.ts";

/**
 * Exit codes are the dispatcher's only structured signal, so they are a
 * contract and not an implementation detail.
 *
 * A blocked gate and a real regression must never share a code: a root
 * dispatcher has to tell "this suite is waiting on something named" from "this
 * suite ran and found a bug", and collapsing the two is how a blocker gets
 * triaged as a defect and a defect gets waved through as a blocker.
 *
 * These spawn the real gate runner. Nothing is mocked.
 */
const PACKAGE_DIR = dirname(dirname(import.meta.dir));

interface GateRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  record: GateRecord | undefined;
}

async function runGate(...args: string[]): Promise<GateRun> {
  const child = Bun.spawn({
    cmd: ["bun", join(PACKAGE_DIR, "scripts", "gate.ts"), ...args],
    cwd: PACKAGE_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${GATE_PREFIX} `));
  return {
    exitCode: await child.exited,
    stdout,
    stderr,
    record:
      line === undefined
        ? undefined
        : (JSON.parse(line.slice(GATE_PREFIX.length + 1)) as GateRecord),
  };
}

describe("blocked gates are distinguishable from failures", () => {
  test("an owed but unimplemented suite exits 78 with its blocker named", async () => {
    const run = await runGate("security");

    expect(run.exitCode).toBe(78);
    expect(run.record?.status).toBe("not_implemented");
    expect(run.record?.exitCode).toBe(78);
    expect(run.record?.blockedOn).toBe("asimposiumorg-233");
    // 78 is EX_CONFIG. 1 and 2 belong to tools reporting real findings.
    expect([0, 1, 2]).not.toContain(run.exitCode);
  });

  test("the blocker also reaches stderr, not only the machine record", async () => {
    const run = await runGate("security");
    expect(run.stderr).toContain("asimposiumorg-233");
    expect(run.stderr).toContain("no implementation");
  });

  test("a passing suite still exits 0", async () => {
    const run = await runGate("typecheck");
    expect(run.exitCode).toBe(0);
    expect(run.record?.status).toBe("pass");
  }, // This launches the real compiler. Five seconds is below its observed
  // clean-run latency on a contended CI or swarm host and made the test kill
  // a healthy child before it could emit the gate record.
  30_000);

  test("an unknown gate is a usage error, distinct from both", async () => {
    const run = await runGate("nonsuch");
    expect(run.exitCode).toBe(64);
    expect(run.stderr).toContain("unknown gate");
    // A usage error emits no gate record: nothing ran, so nothing is reported.
    expect(run.record).toBeUndefined();
  });

  test("suites this package does not owe are not runnable here", async () => {
    for (const suite of ["integration", "e2e", "performance"]) {
      const run = await runGate(suite);
      expect(run.exitCode).toBe(64);
      expect(run.stderr).toContain("unknown gate");
    }
  });

  test("no gate run leaks an absolute path into its record", async () => {
    for (const suite of ["security", "typecheck"]) {
      const run = await runGate(suite);
      const serialized = JSON.stringify(run.record ?? {});
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain("/home/");
      expect(run.record?.packagePath).toBe("apps/web");
    }
  }, 30_000);
});
