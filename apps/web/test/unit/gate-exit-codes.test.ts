import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const BEADS_LEDGER = join(PACKAGE_DIR, "..", "..", ".beads", "issues.jsonl");
const WEB_SECURITY_BLOCKERS = [
  "asimposiumorg-fjp",
  "asimposiumorg-3zn",
  "asimposiumorg-mbp",
] as const;

function beadStatuses(): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const line of readFileSync(BEADS_LEDGER, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const issue = JSON.parse(line) as { id?: unknown; status?: unknown };
    if (typeof issue.id === "string" && typeof issue.status === "string") {
      statuses.set(issue.id, issue.status);
    }
  }
  return statuses;
}

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
  return {
    exitCode: await child.exited,
    stdout,
    stderr,
    record: parseGateRecord(stdout),
  };
}

describe("blocked gates are distinguishable from failures", () => {
  test("an owed but unimplemented suite exits 78 with its blocker named", async () => {
    const run = await runGate("security");

    expect(run.exitCode).toBe(78);
    expect(run.record?.status).toBe("not_implemented");
    expect(run.record?.exitCode).toBe(78);
    expect(run.record?.blockedOn).toBe(
      "asimposiumorg-fjp (W8.3), asimposiumorg-3zn (W10.8), and asimposiumorg-mbp (W8.1)",
    );
    expect((run.record?.blockedOn ?? "").length).toBeLessThanOrEqual(400);
    // 78 is EX_CONFIG. 1 and 2 belong to tools reporting real findings.
    expect([0, 1, 2]).not.toContain(run.exitCode);
  });

  test("the blocker also reaches stderr, not only the machine record", async () => {
    const run = await runGate("security");
    for (const blocker of WEB_SECURITY_BLOCKERS) expect(run.stderr).toContain(blocker);
    expect(run.stderr).toContain("no implementation");
  });

  test("every named Web security blocker exists and remains unfinished", async () => {
    const run = await runGate("security");
    const statuses = beadStatuses();
    const named =
      run.record?.blockedOn?.match(/\basimposiumorg-[a-z0-9]+(?:\.[a-z0-9]+)*\b/g) ?? [];

    expect([...named]).toEqual([...WEB_SECURITY_BLOCKERS]);
    for (const blocker of named) {
      expect(statuses.has(blocker)).toBe(true);
      const status = statuses.get(blocker);
      expect(status === "open" || status === "in_progress").toBe(true);
    }
  });

  test("the parser refuses duplicate or conflicting gate records", () => {
    const duplicate = `${GATE_PREFIX} {}\n${GATE_PREFIX} {"status":"pass"}\n`;
    expect(() => parseGateRecord(duplicate)).toThrow("expected at most one");
  });

  test("a passing suite still exits 0", async () => {
    const run = await runGate("typecheck");
    expect(run.exitCode).toBe(0);
    expect(run.record?.status).toBe("pass");
  }, 60_000);

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
  }, 60_000);
});
