import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The two non-zero meanings of this package's suite runner must stay distinguishable.
 *
 * `scripts/suites.ts` refuses to fake `integration` and `performance`, and says so with the
 * root-owned blocked code (78, `EX_CONFIG`; defined at `scripts/suite/policy.ts` as
 * `BLOCKED_EXIT_CODE` and repeated as a literal here rather than imported across the package
 * boundary). The danger this test exists to catch is the collapse of that distinction in
 * either direction: a blocked gate reported as a regression, or — the worse one — a real
 * regression laundered into the blocked class, where an already-red suite hides it.
 *
 * Nothing here asserts that integration or performance *works*. It asserts that they honestly
 * refuse, and that the refusal still names its blocker and its forbidden substitutes.
 */

const BLOCKED_EXIT_CODE = 78;
const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const RUNNER = "scripts/suites.ts";

interface Diagnostic {
  tool: string;
  tool_version: string;
  package: string;
  package_version: string;
  suite: string;
  duration_ms: number;
  status: string;
  exit_code: number;
  code?: string;
  blocked_on?: string;
  forbidden_substitutes?: string;
  reproduce: string;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  record: Diagnostic;
}

async function runRunner(suite: string, cwd = PACKAGE_ROOT): Promise<Run> {
  const child = Bun.spawn({
    cmd: ["bun", RUNNER, suite],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let record: Diagnostic;
  try {
    record = JSON.parse(line) as Diagnostic;
  } catch (error) {
    // Never swallowed, and never defaulted to an empty record: a runner that stops emitting a
    // parseable NDJSON diagnostic has broken the contract this suite exists to check, so the
    // failure has to name the suite and show what did arrive.
    const detail = error instanceof Error ? error.message : "unparseable";
    throw new Error(
      `${RUNNER} ${suite} emitted no parseable diagnostic (${detail}). stdout was: ${stdout.slice(0, 400)}`,
    );
  }
  return { exitCode, stdout, stderr, record };
}

/**
 * A throwaway copy of the real runner beside a single deliberately failing test. Copying the
 * runner verbatim from disk means the planted regression travels through the same code path a
 * real one would, without leaving a failing fixture inside this package's own suites.
 */
function plantRegression(): string {
  const dir = mkdtempSync(join(tmpdir(), "wire-suite-regression-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "test", "unit"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "@asimposium/wire", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "scripts", "suites.ts"), readFileSync(join(PACKAGE_ROOT, RUNNER)));
  writeFileSync(
    join(dir, "test", "unit", "planted-regression.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      "",
      'test("a planted regression: the Worker returns the wrong status", () => {',
      "  expect(500).toBe(200);",
      "});",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("a deliberately blocked suite exits 78, never 0 and never 1", () => {
  for (const suite of ["integration", "performance"] as const) {
    test(`${suite} refuses with the root-owned blocked code`, async () => {
      const run = await runRunner(suite);
      expect(run.exitCode).toBe(BLOCKED_EXIT_CODE);
      expect(run.exitCode).not.toBe(0);
      expect(run.exitCode).not.toBe(1);
      expect(run.record.suite).toBe(suite);
      expect(run.record.status).toBe("not_implemented");
      expect(run.record.code).toBe("SUITE_NOT_IMPLEMENTED");
      expect(run.record.exit_code).toBe(BLOCKED_EXIT_CODE);
    }, 20_000);

    test(`${suite} logs its blocker in detail on stderr`, async () => {
      const run = await runRunner(suite);
      expect(run.stderr).toContain("BLOCKED");
      expect(run.stderr).toContain(`exit ${BLOCKED_EXIT_CODE}`);
      expect(run.stderr).toContain("blocked on:");
      expect(run.stderr).toContain("must not be faked with:");
      expect(run.stderr).toContain(`cd apps/wire && bun run test:${suite}`);
      expect((run.record.blocked_on ?? "").length).toBeGreaterThan(40);
    }, 20_000);
  }

  test("the integration blocker still names the no-mock and no-live-binding claims", async () => {
    const run = await runRunner("integration");
    const blockedOn = run.record.blocked_on ?? "";
    const forbidden = run.record.forbidden_substitutes ?? "";
    // The claims this refusal rests on, kept intact: no real namespace exists yet, and the
    // substitutes that would make it look satisfied are named so nobody reaches for them.
    expect(blockedOn).toContain("asimposiumorg-p1g");
    expect(blockedOn).toContain("all-zero sentinel");
    expect(blockedOn).toContain("workerd");
    expect(forbidden).toContain("mocked or stubbed D1/R2");
    expect(forbidden).toContain("bun:sqlite");
    expect(forbidden).toContain("test/support/bindings.ts");
    expect(forbidden).toContain("wrangler dev");
  }, 20_000);

  test("the performance blocker still names the missing §15 budget", async () => {
    const run = await runRunner("performance");
    expect(run.record.blocked_on ?? "").toContain("asimposiumorg-233");
    expect(run.record.forbidden_substitutes ?? "").toContain("micro-benchmark");
  }, 20_000);

  test("the blocked record leaks no absolute path, home directory or credential shape", async () => {
    for (const suite of ["integration", "performance"] as const) {
      const run = await runRunner(suite);
      const serialized = JSON.stringify(run.record);
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain("/home/");
      expect(serialized).not.toContain(PACKAGE_ROOT);
      expect(serialized).not.toMatch(/asimp_ag_[A-Za-z0-9_-]{4,}/);
      expect(serialized).not.toMatch(/#v1\.[A-Za-z0-9._~-]{8,}/);
      expect(run.record.reproduce).toBe(`cd apps/wire && bun run test:${suite}`);
    }
  }, 40_000);
});

describe("a suite that actually ran keeps the ordinary exit codes", () => {
  test("an implemented suite that passes exits 0", async () => {
    // `security`, not `unit`: spawning the unit suite from inside the unit suite would recurse.
    const run = await runRunner("security");
    expect(run.exitCode).toBe(0);
    expect(run.record.status).toBe("pass");
    expect(run.record.exit_code).toBe(0);
    expect(run.record.tool).toBe("bun test");
  }, 30_000);

  test("a planted real regression exits 1, not 78", async () => {
    const run = await runRunner("unit", plantRegression());
    expect(run.exitCode).toBe(1);
    expect(run.exitCode).not.toBe(BLOCKED_EXIT_CODE);
    expect(run.record.status).toBe("fail");
    expect(run.record.exit_code).toBe(1);
    expect(run.record.code).toBeUndefined();
    // The child's own failure is in the log, not summarised away.
    expect(run.stderr + run.stdout).toContain("planted regression");
  }, 30_000);

  test("an unknown suite is a usage error, distinct from both", async () => {
    const child = Bun.spawn({
      cmd: ["bun", RUNNER, "not-a-suite"],
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("usage:");
  }, 20_000);
});
