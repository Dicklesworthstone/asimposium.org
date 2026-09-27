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
// A browser directory that does not exist: the security lane must stop
// blocked, before it builds anything, rather than fail or pass.
const NO_BROWSERS = { PLAYWRIGHT_BROWSERS_PATH: join(PACKAGE_DIR, "test", "no-browsers-here") };

interface GateRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  record: GateRecord | undefined;
}

function parseGateRecord(stdout: string): GateRecord | undefined {
  const lines = stdout.split("\n").filter((entry) => entry.startsWith(`${GATE_PREFIX} `));
  if (lines.length > 1) {
    throw new Error(`gate emitted ${lines.length} ${GATE_PREFIX} records; expected at most one`);
  }
  const line = lines[0];
  return line === undefined
    ? undefined
    : (JSON.parse(line.slice(GATE_PREFIX.length + 1)) as GateRecord);
}

async function runGate(suite: string, env: Record<string, string> = {}): Promise<GateRun> {
  const child = Bun.spawn({
    cmd: ["bun", join(PACKAGE_DIR, "scripts", "gate.ts"), suite],
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode: await child.exited,
    stdout,
    stderr,
    record: parseGateRecord(stdout),
  };
}

describe("blocked gates are distinguishable from failures", () => {
  test("the security lane without a browser exits 78 as blocked, before building", async () => {
    const started = performance.now();
    const run = await runGate("security", NO_BROWSERS);

    expect(run.exitCode).toBe(78);
    expect(run.record?.status).toBe("blocked");
    expect(run.record?.exitCode).toBe(78);
    expect(run.record?.suite).toBe("security");
    // The lane names what is missing; a blocked run is never a finding.
    expect(run.stdout).toContain("AGORA_LANE_BROWSER_UNAVAILABLE");
    // 78 is EX_CONFIG. 1 and 2 belong to tools reporting real findings.
    expect([0, 1, 2]).not.toContain(run.exitCode);
    // It stopped before the Next build (which takes minutes).
    expect(performance.now() - started).toBeLessThan(60_000);
  }, 90_000);

  test("the parser refuses duplicate or conflicting gate records", () => {
    const duplicate = `${GATE_PREFIX} {}\n${GATE_PREFIX} {"status":"pass"}\n`;
    expect(() => parseGateRecord(duplicate)).toThrow("expected at most one");
  });

  test("a passing suite still exits 0", async () => {
    const run = await runGate("typecheck");
    expect(run.exitCode).toBe(0);
    expect(run.record?.status).toBe("pass");
  }, // clean-run latency on a contended CI or swarm host and made the test kill // This launches the real compiler. Five seconds is below its observed
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
      const run = await runGate(suite, suite === "security" ? NO_BROWSERS : {});
      const serialized = JSON.stringify(run.record ?? {});
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain("/home/");
      expect(run.record?.packagePath).toBe("apps/web");
    }
  }, 30_000);
});
