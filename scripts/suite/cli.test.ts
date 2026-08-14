/**
 * Integration tests for the root suite dispatcher (bead asimposiumorg-8xn, OPS.1).
 *
 * Every test spawns the real CLI as a child process against a real fixture repository on
 * disk. Nothing is mocked: the "passing" packages really exit 0, the planted failing
 * package really exits nonzero, and the assertions read the dispatcher's real stdout,
 * stderr and exit code.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockedCommand,
  failCommand,
  makeFixtureRepo,
  markerCommand,
  PASS_COMMAND,
} from "./fixtures.ts";
import { BLOCKED_EXIT_CODE } from "./policy.ts";
import type { SummaryDiagnostic, UnitDiagnostic } from "./report.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: ["bun", CLI, "--root", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ASIMPOSIUM_SUITE_DEPTH: "0", ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

function records(result: CliResult): (UnitDiagnostic | SummaryDiagnostic)[] {
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as UnitDiagnostic | SummaryDiagnostic);
}

function units(result: CliResult): UnitDiagnostic[] {
  return records(result).filter(
    (record): record is UnitDiagnostic => record.record === "unit" && record.suite !== "preflight",
  );
}

function summary(result: CliResult, suite: string): SummaryDiagnostic | undefined {
  return records(result).find(
    (record): record is SummaryDiagnostic => record.record === "summary" && record.suite === suite,
  );
}

describe("routing to real package commands", () => {
  test("a package script is executed and reported as a pass", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", scripts: { "test:unit": PASS_COMMAND }, source: true }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(0);

    const wire = units(result).find((unit) => unit.dir === "apps/wire");
    expect(wire?.status).toBe("pass");
    expect(wire?.command).toBe("bun run test:unit");
    expect(wire?.exit_code).toBe(0);
    expect(wire?.reproduce).toBe("cd ./apps/wire && bun run test:unit");
    expect(summary(result, "unit")?.status).toBe("pass");
  });

  test("the root toolchain unit runs for typecheck, lint and unit", async () => {
    const marker = "root-ran";
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": markerCommand(marker) },
      packages: [{ dir: "apps/web", scripts: { "test:unit": PASS_COMMAND }, source: true }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, marker))).toBe(true);

    const rootUnit = units(result).find((unit) => unit.dir === ".");
    expect(rootUnit?.status).toBe("pass");
    expect(rootUnit?.script).toBe("toolchain:test");
    expect(rootUnit?.reproduce).toBe("bun run toolchain:test");
  });

  test("selecting several suites runs them in CI doctrine order", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:typecheck": PASS_COMMAND, "toolchain:test": PASS_COMMAND },
      packages: [
        {
          dir: "apps/wire",
          scripts: { typecheck: PASS_COMMAND, "test:unit": PASS_COMMAND, "test:e2e": PASS_COMMAND },
          source: true,
        },
      ],
    });
    const result = await runCli(root, ["e2e", "unit", "typecheck", "--json"]);
    expect(result.exitCode).toBe(0);
    const order = records(result)
      .filter((record) => record.record === "summary")
      .map((record) => record.suite);
    expect(order).toEqual(["typecheck", "unit", "e2e"]);
  });

  test("--filter narrows the run to matching packages", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [
        {
          dir: "apps/web",
          name: "@fixture/web",
          scripts: { "test:unit": PASS_COMMAND },
          source: true,
        },
        {
          dir: "apps/wire",
          name: "@fixture/wire",
          scripts: { "test:unit": PASS_COMMAND },
          source: true,
        },
      ],
    });
    const result = await runCli(root, ["unit", "--json", "--filter", "apps/wire"]);
    expect(result.exitCode).toBe(0);
    expect(units(result).map((unit) => unit.dir)).toEqual(["apps/wire"]);
  });
});

describe("the planted negative: a failing package must fail the run", () => {
  test("a deliberately failing package exits nonzero and is reported as a failure", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [
        { dir: "apps/web", scripts: { "test:unit": PASS_COMMAND }, source: true },
        { dir: "apps/wire", scripts: { "test:unit": failCommand(3) }, source: true },
      ],
    });
    const result = await runCli(root, ["unit", "--json"]);

    expect(result.exitCode).toBe(1);

    const failed = units(result).find((unit) => unit.dir === "apps/wire");
    expect(failed?.status).toBe("fail");
    expect(failed?.code).toBe("SUITE_FAILED");
    expect(failed?.exit_code).toBe(3);
    expect(failed?.detail).toContain("exited 3");
    expect(failed?.reproduce).toBe("cd ./apps/wire && bun run test:unit");
    expect(failed?.duration_ms).toBeGreaterThanOrEqual(0);

    // The passing sibling is still reported honestly rather than swallowed by the failure.
    expect(units(result).find((unit) => unit.dir === "apps/web")?.status).toBe("pass");

    const totals = summary(result, "unit")?.totals;
    expect(totals?.fail).toBe(1);
    expect(totals?.pass).toBe(2);
    expect(summary(result, "unit")?.status).toBe("fail");
  });

  test("the failing child's stderr reaches the operator: it is forwarded, never silenced", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", scripts: { "test:unit": failCommand(1) }, source: true }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("planted failure");
  });

  test("--bail stops at the first failure instead of burning the rest of the run", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [
        { dir: "apps/web", scripts: { "test:unit": failCommand(1) }, source: true },
        { dir: "apps/wire", scripts: { "test:unit": failCommand(1) }, source: true },
      ],
    });
    const result = await runCli(root, ["unit", "--json", "--bail"]);
    expect(result.exitCode).toBe(1);
    expect(units(result).filter((unit) => unit.status === "fail")).toHaveLength(1);
    expect(units(result).map((unit) => unit.dir)).not.toContain("apps/wire");
  });

  test("one failing suite fails the whole invocation even when later suites pass", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:typecheck": failCommand(1), "toolchain:test": PASS_COMMAND },
      packages: [
        {
          dir: "apps/wire",
          scripts: { typecheck: PASS_COMMAND, "test:unit": PASS_COMMAND },
          source: true,
        },
      ],
    });
    const result = await runCli(root, ["typecheck", "unit", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(summary(result, "typecheck")?.status).toBe("fail");
    expect(summary(result, "unit")?.status).toBe("pass");
  });
});

describe("a package that grows code owes its gates", () => {
  test("source files plus a missing required script is a failure, not a skip", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", source: true, scripts: {} }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(1);

    const missing = units(result).find((unit) => unit.dir === "apps/wire");
    expect(missing?.status).toBe("missing");
    expect(missing?.code).toBe("MISSING_SUITE_SCRIPT");
    expect(missing?.detail).toContain('add a "test:unit" script');
    expect(missing?.reproduce).toBe("cd ./apps/wire && bun run test:unit");
  });

  test("a stub with no source files is skipped with its reason, never reported as passing", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "packages/protocol", scripts: {} }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(0);

    const skipped = units(result).find((unit) => unit.dir === "packages/protocol");
    expect(skipped?.status).toBe("skip");
    expect(skipped?.code).toBe("NO_SOURCE_FILES");
    expect(summary(result, "unit")?.totals.pass).toBe(1); // the root toolchain unit only
  });

  test("a suite a package does not owe is skipped as not-required", async () => {
    const root = makeFixtureRepo({
      packages: [{ dir: "packages/render", source: true, scripts: {} }],
    });
    const result = await runCli(root, ["performance", "--json"]);
    expect(result.exitCode).toBe(0);
    const skipped = units(result).find((unit) => unit.dir === "packages/render");
    expect(skipped?.status).toBe("skip");
    expect(skipped?.code).toBe("SUITE_NOT_REQUIRED");
  });

  test("a missing root toolchain script fails rather than quietly disappearing", async () => {
    const root = makeFixtureRepo({
      rootScripts: {},
      packages: [{ dir: "apps/wire", scripts: { "test:unit": PASS_COMMAND }, source: true }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(1);
    const rootUnit = units(result).find((unit) => unit.dir === ".");
    expect(rootUnit?.status).toBe("missing");
    expect(rootUnit?.code).toBe("MISSING_ROOT_SCRIPT");
  });

  test("--require-executed turns an all-skipped suite into a failure", async () => {
    const root = makeFixtureRepo({ packages: [{ dir: "packages/protocol", scripts: {} }] });
    const passive = await runCli(root, ["contract", "--json"]);
    expect(passive.exitCode).toBe(0);
    expect(summary(passive, "contract")?.detail).toContain("executed no units");

    const strict = await runCli(root, ["contract", "--json", "--require-executed"]);
    expect(strict.exitCode).toBe(1);
    expect(summary(strict, "contract")?.code).toBe("NO_UNITS_EXECUTED");
  });
});

describe("secret-safe diagnostics", () => {
  test("no absolute path, home directory or environment value appears on stdout", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", scripts: { "test:unit": failCommand(1) }, source: true }],
    });
    const result = await runCli(root, ["unit", "--json"], {
      ASIMP_FAKE_TOKEN: "asimp_ag_01JXYZ_supersecretvalue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain(homedir());
    expect(result.stdout).not.toContain("supersecretvalue");
    expect(result.stdout).not.toContain("ASIMP_FAKE_TOKEN");
  });

  test("every executed record carries the full diagnostic contract", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", scripts: { "test:unit": PASS_COMMAND }, source: true }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    for (const unit of units(result)) {
      expect(unit.tool).toBe("bun");
      expect(unit.package.length).toBeGreaterThan(0);
      expect(unit.suite).toBe("unit");
      expect(unit.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(typeof unit.duration_ms).toBe("number");
      expect(["pass", "fail", "blocked", "missing", "skip"]).toContain(unit.status);
      expect(unit.reproduce.length).toBeGreaterThan(0);
    }
  });

  test("human output is redacted too, not only the JSON records", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", scripts: { "test:unit": failCommand(1) }, source: true }],
    });
    const result = await runCli(root, ["unit"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("reproduce: cd ./apps/wire && bun run test:unit");
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain(homedir());
  });

  test("--json keeps stdout parseable by forwarding child stdout to stderr", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": "bun -e \"console.log('child chatter')\"" },
      packages: [],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("child chatter");
    expect(() => records(result)).not.toThrow();
    expect(result.stdout).not.toContain("child chatter");
  });
});

describe("preflight and usage", () => {
  test("an unpinned toolchain refuses to run gates", async () => {
    const root = makeFixtureRepo({ packageManager: null });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("TOOLCHAIN_NOT_PINNED");
  });

  test("the pinned toolchain is reported as a preflight record", async () => {
    const root = makeFixtureRepo({ rootScripts: { "toolchain:test": PASS_COMMAND } });
    const result = await runCli(root, ["unit", "--json"]);
    const preflight = records(result).find((record) => record.suite === "preflight");
    expect(preflight?.status).toBe("pass");
    expect(["TOOLCHAIN_PINNED", "BUN_VERSION_NEWER_THAN_PIN"]).toContain(preflight?.code ?? "");
  });

  test("a bun older than the pin is refused with a clear code", async () => {
    const root = makeFixtureRepo({
      packageManager: "bun@99.0.0",
      rootScripts: { "toolchain:test": PASS_COMMAND },
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("BUN_VERSION_TOO_OLD");
  });

  test("a package script calling the dispatcher back is caught instead of forking forever", async () => {
    const root = makeFixtureRepo({ rootScripts: { "toolchain:test": PASS_COMMAND } });
    const result = await runCli(root, ["unit", "--json"], { ASIMPOSIUM_SUITE_DEPTH: "5" });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("SUITE_RECURSION");
  });

  test("an unknown suite lists the known ones instead of failing silently", async () => {
    const result = await runCli(makeFixtureRepo(), ["units"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("UNKNOWN_SUITE");
    expect(result.stderr).toContain("typecheck");
  });

  test("naming no suite at all is a usage error, not an empty green run", async () => {
    const result = await runCli(makeFixtureRepo(), []);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("NO_SUITE_SELECTED");
  });

  test("an unreadable root is a usage error with a typed code", async () => {
    const result = await runCli(join(makeFixtureRepo(), "missing"), ["unit"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ROOT_PACKAGE_UNREADABLE");
  });
});

describe("--list plans without running", () => {
  test("nothing is executed and the plan shows what would run", async () => {
    const marker = "must-not-run";
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": markerCommand(marker) },
      packages: [
        { dir: "apps/wire", scripts: { "test:unit": markerCommand(marker) }, source: true },
        { dir: "packages/protocol", scripts: {} },
      ],
    });
    const result = await runCli(root, ["unit", "--list", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, marker))).toBe(false);

    const plans = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { record: string; action: string; dir: string });
    expect(plans.every((plan) => plan.record === "plan")).toBe(true);
    expect(plans.find((plan) => plan.dir === "apps/wire")?.action).toBe("run");
    expect(plans.find((plan) => plan.dir === "packages/protocol")?.action).toBe("skip");
  });
});

describe("a deliberate blocker is not a broken gate", () => {
  test("a package exiting the blocked code is reported blocked, and the run exits nonzero", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [
        { dir: "apps/web", scripts: { "test:unit": PASS_COMMAND }, source: true },
        { dir: "apps/wire", scripts: { "test:unit": blockedCommand() }, source: true },
      ],
    });
    const result = await runCli(root, ["unit", "--json"]);

    // Never green, and never confusable with a failure.
    expect(result.exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(1);

    const unit = units(result).find((record) => record.dir === "apps/wire");
    expect(unit?.status).toBe("blocked");
    expect(unit?.code).toBe("SUITE_BLOCKED");
    expect(unit?.exit_code).toBe(BLOCKED_EXIT_CODE);
    expect(unit?.detail).toContain("deliberately");
    expect(unit?.reproduce).toBe("cd ./apps/wire && bun run test:unit");

    const blockedSummary = summary(result, "unit");
    expect(blockedSummary?.status).toBe("blocked");
    expect(blockedSummary?.code).toBe("SUITE_BLOCKED");
    expect(blockedSummary?.totals.blocked).toBe(1);
    expect(blockedSummary?.totals.fail).toBe(0);
    expect(blockedSummary?.totals.pass).toBe(2);
  });

  test("the blocked child's own stderr reaches the operator, naming its blocker", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", scripts: { "test:unit": blockedCommand() }, source: true }],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(result.stderr).toContain("blocked on asimposiumorg-fixture");
  });

  test("a real failure outranks a blocker: exit 1, and each row keeps its own status", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [
        { dir: "apps/web", scripts: { "test:unit": PASS_COMMAND }, source: true },
        { dir: "apps/wire", scripts: { "test:unit": blockedCommand() }, source: true },
        { dir: "packages/render", scripts: { "test:unit": failCommand(1) }, source: true },
        { dir: "packages/contracts", source: true, scripts: {} },
      ],
    });
    const result = await runCli(root, ["unit", "--json"]);

    expect(result.exitCode).toBe(1);

    const byDir = new Map(units(result).map((record) => [record.dir, record]));
    expect(byDir.get("apps/web")?.status).toBe("pass");
    expect(byDir.get("apps/wire")?.status).toBe("blocked");
    expect(byDir.get("packages/render")?.status).toBe("fail");
    expect(byDir.get("packages/contracts")?.status).toBe("missing");

    const mixed = summary(result, "unit");
    expect(mixed?.status).toBe("fail");
    expect(mixed?.code).toBe("SUITE_INCOMPLETE");
    expect(mixed?.totals).toEqual({
      total: 5,
      executed: 4,
      pass: 2,
      fail: 1,
      blocked: 1,
      missing: 1,
      skip: 0,
    });
  });

  test("any other nonzero exit stays a failure: only the root-owned code means blocked", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [
        { dir: "apps/wire", scripts: { "test:unit": failCommand(2) }, source: true },
        { dir: "packages/render", scripts: { "test:unit": failCommand(3) }, source: true },
      ],
    });
    const result = await runCli(root, ["unit", "--json"]);
    expect(result.exitCode).toBe(1);
    for (const record of units(result).filter((entry) => entry.dir !== ".")) {
      expect(record.status).toBe("fail");
      expect(record.code).toBe("SUITE_FAILED");
    }
    expect(summary(result, "unit")?.totals.blocked).toBe(0);
  });

  test("human output labels the blocker and prints its reproduction and detail", async () => {
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [{ dir: "apps/wire", scripts: { "test:unit": blockedCommand() }, source: true }],
    });
    const result = await runCli(root, ["unit"]);

    expect(result.exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).toContain("reproduce: cd ./apps/wire && bun run test:unit");
    expect(result.stdout).toContain("detail:");
    expect(result.stdout).toContain("1 blocked");
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).not.toContain("FAIL");
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain(homedir());
  });
});
