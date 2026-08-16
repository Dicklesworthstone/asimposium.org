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
import { runOwnedCommand } from "./cli.ts";
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

function childEnvironment(): Record<string, string> {
  return process.env.PATH === undefined ? {} : { PATH: process.env.PATH };
}

function outputOverrunCommand(): string {
  return `bun -e ${JSON.stringify(
    "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(65537)); setTimeout(() => process.exit(0), 800)",
  )}`;
}

const PRODUCTION_STREAM_RETAINED_BYTES = 64 * 1024;
const PRODUCTION_AGGREGATE_RETAINED_BYTES = 96 * 1024;

const DELAYED_READY_SUPERVISOR = String.raw`
use strict;
use warnings;
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { exec @ARGV; exit 127; }
select undef, undef, undef, 0.05;
print STDERR "\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\n";
waitpid($target, 0);
my $raw = $?;
my $signal = $raw & 127;
my $exit = $signal ? 128 + $signal : $raw >> 8;
$SIG{USR1} = sub { exit $exit; };
print STDERR "\036ASIMPOSIUM_SUITE_CONTROL $nonce exited $exit $signal $$ 1\n";
while (1) { sleep 1; }
`;

const PID_MISMATCH_SUPERVISOR = String.raw`
use strict;
use warnings;
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { exec @ARGV; exit 127; }
select undef, undef, undef, 0.05;
print STDERR "\036ASIMPOSIUM_SUITE_CONTROL $nonce ready " . ($$ + 1) . "\n";
waitpid($target, 0);
while (1) { sleep 1; }
`;

const NEGATIVE_MEMBER_COUNT_SUPERVISOR = String.raw`
use strict;
use warnings;
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
print STDERR "\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\n";
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { exec @ARGV; exit 127; }
waitpid($target, 0);
my $raw = $?;
my $signal = $raw & 127;
my $exit = $signal ? 128 + $signal : $raw >> 8;
$SIG{USR1} = sub { exit $exit; };
print STDERR "\036ASIMPOSIUM_SUITE_CONTROL $nonce exited $exit $signal $$ -1\n";
while (1) { sleep 1; }
`;

function processTable(): string {
  const snapshot = Bun.spawnSync({
    cmd: ["/bin/ps", "-axo", "command="],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(snapshot.exitCode).toBe(0);
  return new TextDecoder().decode(snapshot.stdout);
}

function processIdForMarker(marker: string): number | undefined {
  const snapshot = Bun.spawnSync({
    cmd: ["/bin/ps", "-axo", "pid=,command="],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(snapshot.exitCode).toBe(0);
  for (const line of new TextDecoder().decode(snapshot.stdout).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    const command = match?.[2];
    if (match !== null && command?.includes(marker)) return Number(match[1]);
  }
  return undefined;
}

function stopDetachedFixture(marker: string): void {
  const pid = processIdForMarker(marker);
  if (pid === undefined) return;
  process.kill(pid, "SIGKILL");
}

function aggregateOutputCommand(totalCapturedBytes: number, includeExitedControl: boolean): string {
  return `my $prefix = "\\036ASIMPOSIUM_SUITE_CONTROL " . ("n" x 36) . " "; my $parent = getppid(); my $control = length($prefix . "ready $parent\\n")${includeExitedControl ? ' + length($prefix . "exited 0 0 $parent 1\\n")' : ""}; my $payload = ${totalCapturedBytes} - $control; my $stdout = 48 * 1024; die if $payload <= $stdout; syswrite(STDOUT, "x" x $stdout); syswrite(STDERR, ("y" x ($payload - $stdout - 1)) . "\\n");`;
}

describe("owned session launcher", () => {
  test("the production 65536-byte per-stream limit completes with exact output", async () => {
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `syswrite(STDOUT, "x" x ${PRODUCTION_STREAM_RETAINED_BYTES}); exit 0;`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("exited");
    expect(result.stdout).toHaveLength(PRODUCTION_STREAM_RETAINED_BYTES);
    expect(result.retainedStdoutBytes).toBe(PRODUCTION_STREAM_RETAINED_BYTES);
    expect(result.retainedOutputBytes).toBeLessThanOrEqual(PRODUCTION_AGGREGATE_RETAINED_BYTES);
  });

  test("the production 65537-byte per-stream overrun retains no excess and leaves no owned survivor", async () => {
    const marker = `suite-output-overrun-owned-${crypto.randomUUID()}`;
    const cancelled: ("stdout" | "stderr")[] = [];
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `use POSIX qw(_exit); my $marker = "${marker}"; pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { $SIG{TERM} = sub {}; close $read; syswrite($write, "r"); close $write; select undef, undef, undef, 0.8; _exit(0); } close $write; read($read, my $ready, 1); close $read; $SIG{TERM} = sub {}; syswrite(STDOUT, "x" x ${PRODUCTION_STREAM_RETAINED_BYTES + 1}); select undef, undef, undef, 0.8; _exit(0);`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      onPipeCancelRequested: (pipe) => cancelled.push(pipe),
    });

    expect(result.outcome).toBe("output-overrun");
    expect(result.cleanupProven).toBe(true);
    expect(result.stdout).toHaveLength(PRODUCTION_STREAM_RETAINED_BYTES);
    expect(result.retainedStdoutBytes).toBe(PRODUCTION_STREAM_RETAINED_BYTES);
    expect(result.retainedOutputBytes).toBeLessThanOrEqual(PRODUCTION_AGGREGATE_RETAINED_BYTES);
    expect(cancelled.sort()).toEqual(["stderr", "stdout"]);
    expect(processTable()).not.toContain(marker);
  });

  test("the production 98304-byte aggregate limit completes exactly", async () => {
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `${aggregateOutputCommand(PRODUCTION_AGGREGATE_RETAINED_BYTES, true)} exit 0;`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("exited");
    expect(result.retainedStdoutBytes).toBe(48 * 1024);
    expect(result.retainedOutputBytes).toBe(PRODUCTION_AGGREGATE_RETAINED_BYTES);
  });

  test("the production 98305-byte aggregate overrun leaves no owned survivor", async () => {
    const marker = `suite-aggregate-overrun-owned-${crypto.randomUUID()}`;
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `use POSIX qw(_exit); my $marker = "${marker}"; pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { $SIG{TERM} = sub {}; close $read; syswrite($write, "r"); close $write; select undef, undef, undef, 0.8; _exit(0); } close $write; read($read, my $ready, 1); close $read; $SIG{TERM} = sub {}; ${aggregateOutputCommand(PRODUCTION_AGGREGATE_RETAINED_BYTES + 1, false)} select undef, undef, undef, 0.8; _exit(0);`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("output-overrun");
    expect(result.cleanupProven).toBe(true);
    expect(result.retainedStdoutBytes).toBeLessThanOrEqual(PRODUCTION_STREAM_RETAINED_BYTES);
    expect(result.retainedStderrBytes).toBeLessThanOrEqual(PRODUCTION_STREAM_RETAINED_BYTES);
    expect(result.retainedOutputBytes).toBe(PRODUCTION_AGGREGATE_RETAINED_BYTES);
    expect(processTable()).not.toContain(marker);
  });

  test("a pre-ready overrun waits for the matching ownership handshake before group cleanup", async () => {
    const marker = `suite-pre-ready-overrun-${crypto.randomUUID()}`;
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `use POSIX qw(_exit); my $marker = "${marker}"; pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { $SIG{TERM} = sub {}; close $read; syswrite($write, "r"); close $write; select undef, undef, undef, 0.8; _exit(0); } close $write; read($read, my $ready, 1); close $read; $SIG{TERM} = sub {}; syswrite(STDOUT, "x" x ${PRODUCTION_STREAM_RETAINED_BYTES + 1}); select undef, undef, undef, 0.8; _exit(0);`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      supervisorScript: DELAYED_READY_SUPERVISOR,
    });

    expect(result.outcome).toBe("output-overrun");
    expect(result.cleanupProven).toBe(true);
    expect(processTable()).not.toContain(marker);
  });

  test("a nonce-ready PID mismatch fails closed after cleaning the actual owned group", async () => {
    const marker = `suite-supervisor-pid-mismatch-${crypto.randomUUID()}`;
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `my $marker = "${marker}"; $SIG{TERM} = sub {}; select undef, undef, undef, 0.8; exit 0;`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      supervisorScript: PID_MISMATCH_SUPERVISOR,
    });

    expect(result.outcome).toBe("ownership-unproven");
    expect(result.cleanupProven).toBe(true);
    expect(processTable()).not.toContain(marker);
  });

  test("a supervisor memberCount -1 receives a fresh bounded host census", async () => {
    const result = await runOwnedCommand({
      command: ["perl", "-e", "exit 0;"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      supervisorScript: NEGATIVE_MEMBER_COUNT_SUPERVISOR,
    });

    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
  });

  test("the normal production pgrep census accepts its owned leader", async () => {
    const result = await runOwnedCommand({
      command: ["perl", "-e", "exit 0;"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ["exit 1 with stdout", 'print "999\\n"; exit 1;'],
    ["exit 0 with no PID", "exit 0;"],
    ["a malformed PID line", 'print "not-a-pid\\n"; exit 0;'],
  ])("PLANTED: contradictory pgrep census %s is inspection-unproven", async (_label, source) => {
    const result = await runOwnedCommand({
      command: ["perl", "-e", "exit 0;"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      inspectionCommand: ["perl", "-e", source],
    });

    expect(result.outcome).toBe("inspection-unproven");
  });

  test("a stalled inspector is bounded, reaped, and reported inspection-unproven", async () => {
    const marker = `suite-stalled-inspector-${crypto.randomUUID()}`;
    const startedAt = performance.now();
    const result = await runOwnedCommand({
      command: ["perl", "-e", "exit 0;"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      termGraceMs: 40,
      killReapMs: 200,
      inspectionCommand: [
        "perl",
        "-e",
        `my $marker = "${marker}"; $SIG{TERM} = sub {}; select undef, undef, undef, 5;`,
      ],
      inspectionTimeoutMs: 25,
      inspectionOutputBytes: 128,
    });

    expect(result.outcome).toBe("inspection-unproven");
    expect(performance.now() - startedAt).toBeLessThan(750);
    expect(processTable()).not.toContain(marker);
  });

  test("an oversized inspector is capped, reaped, and reported inspection-unproven", async () => {
    const marker = `suite-oversized-inspector-${crypto.randomUUID()}`;
    const startedAt = performance.now();
    const result = await runOwnedCommand({
      command: ["perl", "-e", "exit 0;"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      termGraceMs: 40,
      killReapMs: 200,
      inspectionCommand: [
        "perl",
        "-e",
        `my $marker = "${marker}"; $SIG{TERM} = sub {}; syswrite(STDOUT, "x" x 129); select undef, undef, undef, 5;`,
      ],
      inspectionTimeoutMs: 25,
      inspectionOutputBytes: 128,
    });

    expect(result.outcome).toBe("inspection-unproven");
    expect(performance.now() - startedAt).toBeLessThan(750);
    expect(processTable()).not.toContain(marker);
  });

  test("a timed-out target is terminated through its owned session and reaped", async () => {
    const result = await runOwnedCommand({
      command: ["/bin/sh", "-c", "sleep 5"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 40,
      termGraceMs: 40,
      killReapMs: 200,
      pipeDrainMs: 200,
    });

    expect(result.outcome).toBe("timeout");
  });

  test("a target that exits while leaving a same-session child is a fail-closed leak", async () => {
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        "use POSIX qw(_exit); pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { $SIG{HUP} = sub {}; $SIG{TERM} = sub {}; close $read; syswrite($write, 'r'); close $write; select undef, undef, undef, 0.5; _exit(0); } close $write; read($read, my $ready, 1); close $read; _exit(0);",
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      termGraceMs: 40,
      killReapMs: 200,
      pipeDrainMs: 200,
    });

    expect(result.outcome).toBe("descendant-leaked");
  });

  test("a detached inherited pipe holder is cancelled locally, not credited as dispatcher cleanup", async () => {
    const marker = `suite-detached-pipe-boundary-${crypto.randomUUID()}`;
    const cancelled: ("stdout" | "stderr")[] = [];
    try {
      const startedAt = performance.now();
      const result = await runOwnedCommand({
        command: [
          "perl",
          "-MPOSIX=setsid",
          "-e",
          `use POSIX qw(_exit); my $marker = "${marker}"; pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { close $read; setsid(); $SIG{HUP} = sub {}; syswrite($write, 'r'); close $write; while (1) { sleep 1; } } close $write; read($read, my $ready, 1); close $read; _exit(0);`,
        ],
        cwd: process.cwd(),
        env: childEnvironment(),
        timeoutMs: 2_000,
        termGraceMs: 40,
        killReapMs: 200,
        pipeDrainMs: 10,
        onPipeCancelRequested: (pipe) => cancelled.push(pipe),
      });

      expect(result.outcome).toBe("pipe-drain-unproven");
      expect(cancelled.sort()).toEqual(["stderr", "stdout"]);
      expect(performance.now() - startedAt).toBeLessThan(750);
      // The process is intentionally outside our group and still live here. The
      // dispatcher cancelled and released its readers; it did not clean this PID.
      expect(processTable()).toContain(marker);
    } finally {
      // Test-only cleanup of the uniquely identified escaped fixture. This is not
      // attributed to dispatcher cleanup and the fixture never self-retires.
      stopDetachedFixture(marker);
    }
    await Bun.sleep(30);
    expect(processTable()).not.toContain(marker);
  });
});

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

  test("the root-owned D1-before-G0 integration unit is dispatched only for the integration suite", async () => {
    const marker = "toolchain-integration-ran";
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:integration": markerCommand(marker) },
      packages: [{ dir: "apps/web", source: true }],
    });
    const result = await runCli(root, ["integration", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, marker))).toBe(true);
    const rootUnit = units(result).find((unit) => unit.dir === ".");
    expect(rootUnit?.status).toBe("pass");
    expect(rootUnit?.script).toBe("toolchain:integration");
    expect(rootUnit?.reproduce).toBe("bun run toolchain:integration");
  });

  test("ordinary unit and integration dispatch strip ambient authority", async () => {
    const authorityProbe = `bun -e ${JSON.stringify(
      "if (process.env.S2_RUN_REAL_BINDING_INTEGRATION || process.env.CLOUDFLARE_API_TOKEN || process.env.WRANGLER_API_TOKEN || process.env.ASIMPOSIUM_SUITE_DEPTH !== '1') process.exit(41)",
    )}`;
    const root = makeFixtureRepo({
      rootScripts: {
        "toolchain:test": authorityProbe,
        "toolchain:integration": authorityProbe,
      },
    });
    const result = await runCli(root, ["unit", "integration", "--json"], {
      S2_RUN_REAL_BINDING_INTEGRATION: "1",
      CLOUDFLARE_API_TOKEN: "fixture-authority-not-forwarded",
      WRANGLER_API_TOKEN: "fixture-authority-not-forwarded",
    });

    expect(result.exitCode).toBe(0);
    expect(units(result).find((unit) => unit.suite === "unit")?.status).toBe("pass");
    expect(units(result).find((unit) => unit.suite === "integration")?.status).toBe("pass");
  });

  test("ordinary unit and integration diagnostics name retained-output overrun", async () => {
    const root = makeFixtureRepo({
      rootScripts: {
        "toolchain:test": outputOverrunCommand(),
        "toolchain:integration": outputOverrunCommand(),
      },
    });
    const result = await runCli(root, ["unit", "integration", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(units(result).find((unit) => unit.suite === "unit")?.code).toBe("SUITE_OUTPUT_OVERRUN");
    expect(units(result).find((unit) => unit.suite === "integration")?.code).toBe(
      "SUITE_OUTPUT_OVERRUN",
    );
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

    // The unit row stays an honest "skip": not owed is not the same as broken, and the
    // zero-executed rule must not rewrite a package's own classification.
    const skipped = units(result).find((unit) => unit.dir === "packages/render");
    expect(skipped?.status).toBe("skip");
    expect(skipped?.code).toBe("SUITE_NOT_REQUIRED");

    // The suite as a whole still ran nothing, so it is not a pass. This assertion used to
    // read `toBe(0)`: a performance gate could report green having spawned no process.
    expect(result.exitCode).toBe(1);
    expect(summary(result, "performance")?.code).toBe("NO_UNITS_EXECUTED");
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

  test("PLANTED: an all-skipped suite fails with no flag, and the flag is now redundant", async () => {
    // This check used to be opt-in, so `bun run test:contract` against a tree with no
    // contract script anywhere exited 0 having spawned nothing. None of the root entry
    // points pass --require-executed except `check`, so the gates that most needed the
    // check were exactly the ones that never got it.
    const root = makeFixtureRepo({ packages: [{ dir: "packages/protocol", scripts: {} }] });

    const passive = await runCli(root, ["contract", "--json"]);
    expect(passive.exitCode).toBe(1);
    const passiveSummary = summary(passive, "contract");
    expect(passiveSummary?.status).toBe("fail");
    expect(passiveSummary?.code).toBe("NO_UNITS_EXECUTED");
    expect(passiveSummary?.totals.executed).toBe(0);
    expect(passiveSummary?.detail).toContain("executed no units");

    // The flag is kept so existing CI invocations keep parsing, and it must be exactly
    // redundant: same exit code, same summary code, same totals.
    const strict = await runCli(root, ["contract", "--json", "--require-executed"]);
    const strictSummary = summary(strict, "contract");
    expect(strict.exitCode).toBe(passive.exitCode);
    expect(strictSummary?.code).toBe(passiveSummary?.code);
    expect(strictSummary?.totals).toEqual(passiveSummary?.totals);
  });

  test("PLANTED: a zero-executed suite outranks a blocked one — exit 1, not the blocked code", async () => {
    // The two fail-closed rules have to compose. A run may legitimately contain a blocked
    // suite; that alone exits BLOCKED_EXIT_CODE. Adding a suite that executed nothing must
    // pull the whole run to a real failure, and must not launder itself as "blocked".
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:test": PASS_COMMAND },
      packages: [
        { dir: "packages/protocol", scripts: { "test:unit": blockedCommand() }, source: true },
      ],
    });
    const result = await runCli(root, ["unit", "contract", "--json"]);

    // The blocked unit keeps its own honest row and its suite stays "blocked"...
    const unitSummary = summary(result, "unit");
    expect(unitSummary?.status).toBe("blocked");
    expect(unitSummary?.code).toBe("SUITE_BLOCKED");
    expect(unitSummary?.totals.blocked).toBe(1);
    expect(unitSummary?.totals.executed).toBe(2);

    // ...while the suite that spawned nothing is a real failure, not a skip and not a block.
    const contractSummary = summary(result, "contract");
    expect(contractSummary?.status).toBe("fail");
    expect(contractSummary?.code).toBe("NO_UNITS_EXECUTED");
    expect(contractSummary?.totals.executed).toBe(0);
    expect(contractSummary?.totals.blocked).toBe(0);

    // Failure outranks blocked: without the contract suite this run would have exited 78.
    expect(result.exitCode).toBe(1);
    expect(result.exitCode).not.toBe(BLOCKED_EXIT_CODE);
  });

  test("--all with --require-executed fails every zero-unit suite", async () => {
    const root = makeFixtureRepo({ packages: [{ dir: "packages/protocol", scripts: {} }] });
    const result = await runCli(root, [
      "--all",
      "--json",
      "--require-executed",
      "--filter",
      "no-such-package",
    ]);

    expect(result.exitCode).toBe(1);
    for (const suite of [
      "typecheck",
      "lint",
      "unit",
      "contract",
      "integration",
      "security",
      "performance",
      "e2e",
    ]) {
      const suiteSummary = summary(result, suite);
      expect(suiteSummary?.status).toBe("fail");
      expect(suiteSummary?.code).toBe("NO_UNITS_EXECUTED");
      expect(suiteSummary?.totals.executed).toBe(0);
    }
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

  test("integration --list retains the root D1-before-G0 bridge without running it", async () => {
    const marker = "must-not-run-integration";
    const root = makeFixtureRepo({
      rootScripts: { "toolchain:integration": markerCommand(marker) },
      packages: [{ dir: "apps/web", source: true }],
    });
    const result = await runCli(root, ["integration", "--list", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, marker))).toBe(false);

    const plans = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { record: string; dir: string; script?: string });
    expect(plans.find((plan) => plan.dir === ".")).toEqual(
      expect.objectContaining({ record: "plan", script: "toolchain:integration" }),
    );
  });

  test("the toolchain bridge lists migration contract, local D1, then G0 without spawning", async () => {
    const root = makeFixtureRepo();
    const result = await runCli(root, ["--toolchain-integration", "--list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const plans = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            record: string;
            step: string;
            command: string;
            timeout_ms: number;
          },
      );
    expect(plans).toEqual([
      expect.objectContaining({
        record: "toolchain-integration-plan",
        step: "d1-migration-contract",
        command: "bun infra/migrate.test.mjs",
        timeout_ms: 120_000,
      }),
      expect.objectContaining({
        record: "toolchain-integration-plan",
        step: "d1-migration-local",
        command: "bun infra/migrate-local.test.mjs",
        timeout_ms: 190_000,
      }),
      expect.objectContaining({
        record: "toolchain-integration-plan",
        step: "g0-spikes",
        command: "bun scripts/suite/g0-spikes.ts",
        timeout_ms: 1_230_000,
      }),
    ]);
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
