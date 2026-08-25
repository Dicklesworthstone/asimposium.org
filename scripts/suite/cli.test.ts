/**
 * Integration tests for the root suite dispatcher (bead asimposiumorg-8xn, OPS.1).
 *
 * CLI acceptance cases spawn the real command against real fixture repositories on disk.
 * The owned-session section also exercises the exported launcher directly with explicit
 * planted supervisor/inspector seams so lifecycle failures remain causally attributable.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type OwnedCommandOptions, type OwnedCommandResult, suiteExecutionLimits } from "./cli.ts";
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
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const FILE_CAPTURE_EXEC = `
use strict;
use warnings;
my $stdout_path = shift @ARGV;
my $stderr_path = shift @ARGV;
open STDOUT, ">", $stdout_path or exit 126;
open STDERR, ">", $stderr_path or exit 126;
exec @ARGV or exit 127;
`;

async function runCli(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CliResult> {
  const runCaptureDir = mkdtempSync(join(tmpdir(), "asimposium-suite-capture-"));
  const stdoutPath = join(runCaptureDir, "cli.stdout");
  const stderrPath = join(runCaptureDir, "cli.stderr");
  closeSync(openSync(stdoutPath, "w", 0o600));
  closeSync(openSync(stderrPath, "w", 0o600));
  const child = Bun.spawn({
    cmd: [
      "perl",
      "-e",
      FILE_CAPTURE_EXEC,
      stdoutPath,
      stderrPath,
      "bun",
      CLI,
      "--root",
      root,
      ...args,
    ],
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, ASIMPOSIUM_SUITE_DEPTH: "0", ...env },
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: readFileSync(stdoutPath, "utf8"),
    stderr: readFileSync(stderrPath, "utf8"),
  };
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

/**
 * Split a package script into the commands it actually runs.
 *
 * Only `&&` is treated as a separator. A `;` or `|` chain collapses into one
 * segment and therefore fails the exact comparison below — deliberately, since
 * failing closed on a shape this predicate does not model is safer than
 * guessing at it.
 */
function commandSegments(script: string): readonly string[] {
  return script
    .split("&&")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/**
 * True when `script` INVOKES `target`, rather than merely mentioning it.
 *
 * A substring test is not a wiring proof: `echo bun run <target>` contains the
 * name and runs nothing. A package script is a chain of commands, so the honest
 * question is whether one whole segment IS the invocation — exact equality
 * against `bun run <target>`, which no argument, comment, or lookalike leaf
 * name can satisfy.
 */
function invokesPackageScript(script: string, target: string): boolean {
  return commandSegments(script).includes(`bun run ${target}`);
}

interface CapturedRun {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly output: string;
}

/**
 * Captured runs share this file's ONE existing 0700 capture root.
 *
 * A `mkdtemp` per call grew the temp tree on every focused run. Nothing here
 * deletes (Rule 1), so the fix is to stop creating rather than to start
 * removing: `capturePath` already owns a single private root for this process,
 * and distinct result names inside it are truncated by the `w` open flag when
 * they recur. Each shell self-test receives one new empty child because the
 * script deliberately refuses to overwrite prior retained evidence.
 */
let captureSequence = 0;
let shellScratchSequence = 0;

/** A lent, private 0700 scratch directory for the shell self-test. */
function shellScratchDirectory(): string {
  shellScratchSequence += 1;
  const scratch = capturePath(`shell-scratch-${shellScratchSequence}`);
  mkdirSync(scratch, { mode: 0o700 });
  chmodSync(scratch, 0o700);
  return scratch;
}

/**
 * Run one bounded child and recover its outcome through a private file.
 *
 * Reading a child's pipes with `spawnSync` directly has proven unreliable for
 * these cases under `bun:test` — the same invocation succeeds from a shell and
 * from `bun -e`, so the defect is in the in-test pipe capture, not in the child.
 * A `bun -e` helper owns the spawn and writes a small JSON document to a 0600
 * file in a private directory, so the outer process reads a file instead of
 * racing a pipe. That is the seam `runOwnedCommand` below already depends on.
 *
 * Both children are bounded, and the outer bound is strictly the larger, so a
 * wedged inner child surfaces as its own recorded timeout rather than as an
 * unattributable helper failure.
 */
function capturedRun(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  extraEnvironment: Record<string, string> = {},
): CapturedRun {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("capturedRun requires a command");
  // Distinct name per call, truncated by the `w` flag if it somehow recurs.
  captureSequence += 1;
  const resultPath = capturePath(`captured-run-${captureSequence}.json`);
  closeSync(openSync(resultPath, "w", 0o600));
  const helperSource = `
    import { spawnSync } from "node:child_process";
    const child = spawnSync(${JSON.stringify(command)}, ${JSON.stringify(args)}, {
      cwd: ${JSON.stringify(cwd)},
      env: ${JSON.stringify({ ...childEnvironment(), ...extraEnvironment })},
      encoding: "utf8",
      timeout: ${timeoutMs},
      maxBuffer: 4 * 1024 * 1024,
    });
    await Bun.write(
      ${JSON.stringify(resultPath)},
      JSON.stringify({
        status: child.status,
        signal: child.signal,
        error: child.error === undefined ? null : child.error.message,
        output: (child.stdout ?? "") + (child.stderr ?? ""),
      }) + "\\n",
    );
  `;
  const helper = spawnSync(process.execPath, ["-e", helperSource], {
    env: childEnvironment(),
    encoding: "utf8",
    timeout: timeoutMs + 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (helper.error !== undefined || helper.status !== 0 || helper.signal !== null) {
    throw new Error(
      `captured-run helper failed: status=${helper.status}; signal=${helper.signal}; error=${helper.error?.message ?? "none"}; stderr=${helper.stderr.slice(0, 4_096)}`,
    );
  }
  const raw = readFileSync(resultPath, "utf8");
  if (raw.trim() === "") throw new Error("captured-run helper wrote no result");
  return JSON.parse(raw) as CapturedRun;
}

describe("provider-free environment interface gate registration", () => {
  test("the live R2 canary explicitly selects remote storage for every object operation", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "e2e-environments.sh"), "utf8");
    const liveCanary = source.slice(source.indexOf("# Phase 10 (staging)"));
    const objectCommands = [
      ...liveCanary.matchAll(/wrangler r2 object (put|get|delete)[^\n]*/g),
    ].map((match) => match[0]);

    expect(objectCommands.map((command) => command.match(/object (put|get|delete)/)?.[1])).toEqual([
      "delete",
      "put",
      "get",
    ]);
    expect(objectCommands.every((command) => command.includes("--remote"))).toBe(true);
  });

  test("PLANTED: the self-test re-enters through an absolute script path", () => {
    const bash = Bun.which("bash");
    if (bash === null) throw new Error("bash is required for the environment self-test");

    // Invoke through a path relative to the repository's parent, from a cwd that
    // is NOT the repository root. The script changes to REPO_ROOT before its
    // nested self-test; a retained relative BASH_SOURCE path would therefore
    // point at a nonexistent child path, and only an absolute SCRIPT_PATH
    // survives the directory change.
    const run = capturedRun(
      [
        bash,
        join(basename(REPO_ROOT), "scripts", "e2e-environments.sh"),
        "--self-test-remote-interface",
      ],
      dirname(REPO_ROOT),
      30_000,
      { ASIMPOSIUM_ENVIRONMENT_E2E_SCRATCH_DIR: shellScratchDirectory() },
    );

    expect(run.error).toBeNull();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.output).toContain('"code":"REMOTE_INTERFACE_GATE_PLANT_PASSED"');
    // The lent directory was used, so this run made none of its own.
    expect(run.output).toContain('"retained_evidence_dir":""');
  });

  test("PLANTED: a lent non-empty scratch directory is refused without overwriting it", () => {
    const bash = Bun.which("bash");
    if (bash === null) throw new Error("bash is required for the environment self-test");
    const scratch = shellScratchDirectory();
    const sentinel = join(scratch, "caller-evidence.txt");
    writeFileSync(sentinel, "preserve-these-bytes\n", { mode: 0o600 });

    const run = capturedRun(
      [bash, join(REPO_ROOT, "scripts", "e2e-environments.sh"), "--self-test-remote-interface"],
      REPO_ROOT,
      30_000,
      { ASIMPOSIUM_ENVIRONMENT_E2E_SCRATCH_DIR: scratch },
    );

    expect(run.error).toBeNull();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    expect(run.output).toContain('"code":"SELF_TEST_SCRATCH_REFUSED"');
    expect(readFileSync(sentinel, "utf8")).toBe("preserve-these-bytes\n");
    expect(existsSync(join(scratch, "bun"))).toBe(false);
    expect(existsSync(join(scratch, "bunx"))).toBe(false);
    expect(existsSync(join(scratch, "curl"))).toBe(false);
    expect(existsSync(join(scratch, "commands.log"))).toBe(false);
  });

  test("PLANTED: mentioning the interface script is not invoking it", () => {
    const target = "test:environment-e2e-interface";
    const real = `bun run test:seed && bun test /dev/null scripts/suite && bun run ${target}`;

    // Planted ECHO: the name appears, the gate never runs.
    expect(invokesPackageScript(`bun test x && echo bun run ${target}`, target)).toBe(false);
    expect(invokesPackageScript(`bun test x && echo ${target}`, target)).toBe(false);
    expect(invokesPackageScript(`bun test x && : ${target}`, target)).toBe(false);
    // Planted REPLACED: a lookalike leaf that is not this gate.
    expect(invokesPackageScript(`bun test x && bun run ${target}:skip`, target)).toBe(false);
    expect(invokesPackageScript(`bun test x && bun run other-${target}`, target)).toBe(false);
    expect(invokesPackageScript(`bun test x && bunx ${target}`, target)).toBe(false);
    // Planted DELETED: gone entirely.
    expect(invokesPackageScript("bun run test:seed && bun test x", target)).toBe(false);
    // Only the real shape passes.
    expect(invokesPackageScript(real, target)).toBe(true);
  });

  test("PLANTED: the root toolchain gate still invokes the registered interface script", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};

    // Link half, by exact command segment rather than by substring: a mention
    // is not an invocation, and `toContain` accepted `echo bun run <target>`.
    // Deleting the invocation, replacing it with a lookalike leaf, or reducing
    // it to an echo all fail here — without running the suite this guards, and
    // therefore without re-entering this test.
    const toolchain = scripts["toolchain:test"] ?? "";
    expect(invokesPackageScript(toolchain, "test:environment-e2e-interface")).toBe(true);
    // The gate is the last thing the ordinary root command does, so its exact
    // final segment is pinned rather than merely present somewhere in the chain.
    expect(commandSegments(toolchain).at(-1)).toBe("bun run test:environment-e2e-interface");
    const registered = scripts["test:environment-e2e-interface"] ?? "";
    expect(registered).toContain("scripts/e2e-environments.sh");

    // Causal half. A name in a manifest is not a gate: run that ONE registered
    // script and require the shell's own credential-present witness. If the
    // entry is wired to a stale target, a renamed flag, or a script that no
    // longer reaches the plant, the link above still holds and this fails.
    const run = capturedRun(
      [process.execPath, "run", "test:environment-e2e-interface"],
      REPO_ROOT,
      60_000,
      { ASIMPOSIUM_ENVIRONMENT_E2E_SCRATCH_DIR: shellScratchDirectory() },
    );

    expect(run.error).toBeNull();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.output).toContain('"code":"REMOTE_INTERFACE_GATE_PLANT_PASSED"');
    expect(run.output).not.toContain('"code":"REMOTE_INTERFACE_GATE_PLANT_FAILED"');
    expect(run.output).not.toContain("asimp_ag_remote_e2e_canary_1234567890abcdefghijklmnop");
  }, 90_000);
});

let ownedCommandHelperRoot: string | undefined;

function ownedCommandResultPath(): string {
  ownedCommandHelperRoot ??= mkdtempSync(join(tmpdir(), "asimposium-suite-owned-command-"));
  return join(ownedCommandHelperRoot, "result.json");
}

async function runOwnedCommand(options: OwnedCommandOptions): Promise<OwnedCommandResult> {
  if (options.onLifecycleCheckpoint !== undefined) {
    throw new Error("lifecycle checkpoint cases require the dedicated asynchronous helper");
  }
  const onPipeCancelRequested = options.onPipeCancelRequested;
  const nonce = crypto.randomUUID();
  const resultPath = ownedCommandResultPath();
  closeSync(openSync(resultPath, "w", 0o600));
  const serializable = {
    ...options,
    onPipeCancelRequested: undefined,
    onLifecycleCheckpoint: undefined,
  };
  const helperSource = `
    import { runOwnedCommand } from ${JSON.stringify(pathToFileURL(CLI).href)};
    const options = ${JSON.stringify(serializable)};
    const cancellations = [];
    ${onPipeCancelRequested === undefined ? "" : "options.onPipeCancelRequested = (pipe) => cancellations.push(pipe);"}
    try {
      const result = await runOwnedCommand(options);
      await Bun.write(
        ${JSON.stringify(resultPath)},
        JSON.stringify({ nonce: ${JSON.stringify(nonce)}, kind: "result", result, cancellations }) + "\\n",
      );
    } catch (error) {
      await Bun.write(
        ${JSON.stringify(resultPath)},
        JSON.stringify({
          nonce: ${JSON.stringify(nonce)},
          kind: "rejection",
          message: error instanceof Error ? error.message : String(error),
        }) + "\\n",
      );
    }
  `;
  const helper = spawnSync(process.execPath, ["-e", helperSource], {
    env: childEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (helper.error !== undefined || helper.status !== 0 || helper.signal !== null) {
    throw new Error(
      `owned-command helper failed: status=${helper.status}; signal=${helper.signal}; error=${helper.error?.message ?? "none"}; stderr=${helper.stderr.slice(0, 4_096)}`,
    );
  }
  let payload = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    payload = readFileSync(resultPath, "utf8");
    if (payload.length > 0) break;
    await Bun.sleep(10);
  }
  const parsed = JSON.parse(payload) as {
    nonce?: unknown;
    kind?: unknown;
    message?: unknown;
    result?: OwnedCommandResult;
    cancellations?: unknown;
  };
  if (parsed.nonce !== nonce) {
    throw new Error("owned-command helper result nonce mismatch");
  }
  if (parsed.kind === "rejection") {
    throw new Error(typeof parsed.message === "string" ? parsed.message : "owned-command rejected");
  }
  if (
    parsed.kind !== "result" ||
    parsed.result === undefined ||
    !Array.isArray(parsed.cancellations) ||
    parsed.cancellations.some((pipe) => pipe !== "stdout" && pipe !== "stderr")
  ) {
    throw new Error(`owned-command helper emitted malformed output: ${payload.slice(0, 4_096)}`);
  }
  for (const pipe of parsed.cancellations as ("stdout" | "stderr")[]) {
    onPipeCancelRequested?.(pipe);
  }
  return parsed.result;
}

function runOwnedCommandWithThrowingCancel(
  options: Omit<OwnedCommandOptions, "onPipeCancelRequested" | "onLifecycleCheckpoint">,
): OwnedCommandResult {
  const nonce = crypto.randomUUID();
  const resultPath = ownedCommandResultPath();
  closeSync(openSync(resultPath, "w", 0o600));
  const helperSource = `
    import { runOwnedCommand } from ${JSON.stringify(pathToFileURL(CLI).href)};
    try {
      const result = await runOwnedCommand({
        ...${JSON.stringify(options)},
        onPipeCancelRequested: () => { throw new Error("planted pipe-cancel callback failure"); },
      });
      await Bun.write(
        ${JSON.stringify(resultPath)},
        JSON.stringify({ nonce: ${JSON.stringify(nonce)}, kind: "result", result }) + "\\n",
      );
    } catch (error) {
      await Bun.write(
        ${JSON.stringify(resultPath)},
        JSON.stringify({
          nonce: ${JSON.stringify(nonce)},
          kind: "rejection",
          message: error instanceof Error ? error.message : String(error),
        }) + "\\n",
      );
    }
  `;
  const helper = spawnSync(process.execPath, ["-e", helperSource], {
    env: childEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (helper.error !== undefined || helper.status !== 0 || helper.signal !== null) {
    throw new Error(
      `throwing-cancel helper failed: status=${helper.status}; signal=${helper.signal}; error=${helper.error?.message ?? "none"}`,
    );
  }
  const payload = readFileSync(resultPath, "utf8");
  const parsed = JSON.parse(payload) as {
    nonce?: unknown;
    kind?: unknown;
    message?: unknown;
    result?: OwnedCommandResult;
  };
  if (parsed.nonce !== nonce || parsed.kind !== "result" || parsed.result === undefined) {
    throw new Error(
      typeof parsed.message === "string"
        ? parsed.message
        : `throwing-cancel helper emitted malformed output: ${payload.slice(0, 4_096)}`,
    );
  }
  return parsed.result;
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
use Fcntl qw(F_SETFD FD_CLOEXEC);
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
open(my $control, ">&=3") or exit 125;
defined fcntl($control, F_SETFD, FD_CLOEXEC) or exit 125;
sub publish_control { my ($record) = @_; my $written = syswrite($control, $record); exit 125 if !defined $written || $written != length($record); }
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { close($control) or exit 127; exec @ARGV or exit 127; }
select undef, undef, undef, 0.05;
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\n");
waitpid($target, 0);
my $raw = $?;
my $signal = $raw & 127;
my $exit = $signal ? 128 + $signal : $raw >> 8;
$SIG{USR1} = sub { exit $exit; };
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce exited $exit $signal $$ 1\n");
while (1) { sleep 1; }
`;

const PID_MISMATCH_SUPERVISOR = String.raw`
use strict;
use warnings;
use Fcntl qw(F_SETFD FD_CLOEXEC);
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
open(my $control, ">&=3") or exit 125;
defined fcntl($control, F_SETFD, FD_CLOEXEC) or exit 125;
sub publish_control { my ($record) = @_; my $written = syswrite($control, $record); exit 125 if !defined $written || $written != length($record); }
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { close($control) or exit 127; exec @ARGV or exit 127; }
select undef, undef, undef, 0.05;
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce ready " . ($$ + 1) . "\n");
waitpid($target, 0);
while (1) { sleep 1; }
`;

const NEGATIVE_MEMBER_COUNT_SUPERVISOR = String.raw`
use strict;
use warnings;
use Fcntl qw(F_SETFD FD_CLOEXEC);
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
open(my $control, ">&=3") or exit 125;
defined fcntl($control, F_SETFD, FD_CLOEXEC) or exit 125;
sub publish_control { my ($record) = @_; my $written = syswrite($control, $record); exit 125 if !defined $written || $written != length($record); }
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\n");
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { close($control) or exit 127; exec @ARGV or exit 127; }
waitpid($target, 0);
my $raw = $?;
my $signal = $raw & 127;
my $exit = $signal ? 128 + $signal : $raw >> 8;
$SIG{USR1} = sub { exit $exit; };
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce exited $exit $signal $$ -1\n");
while (1) { sleep 1; }
`;

function stubbornReleaseSupervisor(supervisorPidPath: string): string {
  return String.raw`
use strict;
use warnings;
use Fcntl qw(F_SETFD FD_CLOEXEC);
use POSIX qw(setsid);
my $nonce = shift @ARGV;
my $supervisor_pid_path = ${JSON.stringify(supervisorPidPath)};
exit 125 if !defined setsid();
open(my $control, ">&=3") or exit 125;
defined fcntl($control, F_SETFD, FD_CLOEXEC) or exit 125;
open(my $supervisor_pid, ">", $supervisor_pid_path) or exit 125;
print {$supervisor_pid} "$$\n" or exit 125;
close($supervisor_pid) or exit 125;
sub publish_control { my ($record) = @_; my $written = syswrite($control, $record); exit 125 if !defined $written || $written != length($record); }
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\n");
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
$SIG{USR1} = sub {};
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { close($control) or exit 127; exec @ARGV or exit 127; }
waitpid($target, 0);
my $raw = $?;
my $signal = $raw & 127;
my $exit = $signal ? 128 + $signal : $raw >> 8;
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce exited $exit $signal $$ -1\n");
while (1) { sleep 1; }
`;
}

const FRAGMENTED_CONTROL_SUPERVISOR = String.raw`
use strict;
use warnings;
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
open(my $control, ">&=3") or exit 125;
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
sub publish_fragmented {
  my ($record) = @_;
  my $midpoint = int(length($record) / 2);
  my $first = syswrite($control, substr($record, 0, $midpoint));
  exit 125 if !defined $first || $first != $midpoint;
  select undef, undef, undef, 0.02;
  my $second = syswrite($control, substr($record, $midpoint));
  exit 125 if !defined $second || $second != length($record) - $midpoint;
}
my $target = fork();
exit 125 if !defined $target;
if ($target == 0) { close($control) or exit 127; exec @ARGV or exit 127; }
publish_fragmented("\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\n");
waitpid($target, 0);
my $raw = $?;
my $signal = $raw & 127;
my $exit = $signal ? 128 + $signal : $raw >> 8;
$SIG{USR1} = sub { exit $exit; };
publish_fragmented("\036ASIMPOSIUM_SUITE_CONTROL $nonce exited $exit $signal $$ -1\n");
while (1) { sleep 1; }
`;

function invalidControlSupervisor(
  publication:
    | "malformed"
    | "invalid-utf8"
    | "noncanonical-whitespace"
    | "noncanonical-number"
    | "duplicate-ready"
    | "out-of-order"
    | "oversized",
): string {
  const publish = {
    malformed: 'syswrite($control, "not-a-control-record\\n");',
    "invalid-utf8": 'syswrite($control, pack("C", 255));',
    "noncanonical-whitespace":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce ready  $$\\n");',
    "noncanonical-number":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce ready +$$\\n");',
    "duplicate-ready":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\\n\\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\\n");',
    "out-of-order":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce exited 0 0 $$ -1\\n");',
    oversized: 'syswrite($control, "x" x 513);',
  }[publication];
  return `
use strict;
use warnings;
use POSIX qw(setsid);
my $nonce = shift @ARGV;
exit 125 if !defined setsid();
open(my $control, ">&=3") or exit 125;
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
${publish}
while (1) { sleep 1; }
`;
}

function terminalControlSupervisor(
  publication:
    | "start-failed"
    | "start-failed-with-child"
    | "start-failed-extra"
    | "missing-terminal"
    | "partial-line"
    | "duplicate-terminal",
  marker: string,
): string {
  const publish = {
    "start-failed":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce start-failed 125 0 $$ -1\\n"); exit 125;',
    "start-failed-with-child":
      'my $child = fork(); exit 125 if !defined $child; if ($child == 0) { close($control); $SIG{TERM} = sub {}; $SIG{HUP} = sub {}; sleep 5; exit 0; } syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce start-failed 125 0 $$ -1\\n"); exit 125;',
    "start-failed-extra":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce start-failed 125 0 $$ -1\\nextra\\n"); exit 125;',
    "missing-terminal":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\\n"); exit 0;',
    "partial-line": 'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$"); exit 0;',
    "duplicate-terminal":
      'syswrite($control, "\\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\\n\\036ASIMPOSIUM_SUITE_CONTROL $nonce exited 0 0 $$ -1\\n\\036ASIMPOSIUM_SUITE_CONTROL $nonce exited 0 0 $$ -1\\n"); $SIG{USR1} = sub { exit 0; }; while (1) { sleep 1; }',
  }[publication];
  return `
use strict;
use warnings;
use POSIX qw(setsid);
my $nonce = shift @ARGV;
my $marker = ${JSON.stringify(marker)};
exit 125 if !defined setsid();
open(my $control, ">&=3") or exit 125;
$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
${publish}
`;
}

function processTable(): string {
  const stdoutPath = capturePath("ps-command.stdout");
  const stderrPath = capturePath("ps-command.stderr");
  closeSync(openSync(stdoutPath, "w", 0o600));
  closeSync(openSync(stderrPath, "w", 0o600));
  const snapshot = Bun.spawnSync({
    cmd: ["perl", "-e", FILE_CAPTURE_EXEC, stdoutPath, stderrPath, "/bin/ps", "-axo", "command="],
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(snapshot.exitCode).toBe(0);
  expect(readFileSync(stderrPath, "utf8")).toBe("");
  return readFileSync(stdoutPath, "utf8");
}

function processIdsForMarker(marker: string): number[] {
  const stdoutPath = capturePath("ps-pid-command.stdout");
  const stderrPath = capturePath("ps-pid-command.stderr");
  closeSync(openSync(stdoutPath, "w", 0o600));
  closeSync(openSync(stderrPath, "w", 0o600));
  const snapshot = Bun.spawnSync({
    cmd: [
      "perl",
      "-e",
      FILE_CAPTURE_EXEC,
      stdoutPath,
      stderrPath,
      "/bin/ps",
      "-axo",
      "pid=,command=",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(snapshot.exitCode).toBe(0);
  expect(readFileSync(stderrPath, "utf8")).toBe("");
  const pids: number[] = [];
  for (const line of readFileSync(stdoutPath, "utf8").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    const command = match?.[2];
    if (match !== null && command?.includes(marker)) pids.push(Number(match[1]));
  }
  return pids;
}

function stopDetachedFixture(marker: string): void {
  for (const pid of processIdsForMarker(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Test-only cleanup races a fixture's bounded self-retirement.
    }
  }
}

let parentLeaseCheckpointRoot: string | undefined;

function parentLeaseFixtureRoot(): string {
  parentLeaseCheckpointRoot ??= mkdtempSync(join(tmpdir(), "asimposium-suite-parent-lease-"));
  return parentLeaseCheckpointRoot;
}

function newParentLeaseCheckpointPath(): string {
  return join(parentLeaseFixtureRoot(), `${crypto.randomUUID()}.checkpoint`);
}

function spawnCrashableOwnedCommand(checkpoint: "ready" | "completed", targetSource: string) {
  const checkpointPath = newParentLeaseCheckpointPath();
  const helperSource = `
    import { runOwnedCommand } from ${JSON.stringify(pathToFileURL(CLI).href)};
    await runOwnedCommand({
      command: ["perl", "-e", ${JSON.stringify(targetSource)}],
      cwd: ${JSON.stringify(process.cwd())},
      env: ${JSON.stringify(childEnvironment())},
      timeoutMs: 5 * 60_000,
      onLifecycleCheckpoint: async (phase, supervisorPid) => {
        if (phase !== ${JSON.stringify(checkpoint)}) return;
        await Bun.write(
          ${JSON.stringify(checkpointPath)},
          "checkpoint " + phase + " " + supervisorPid + "\\n",
        );
        // The outer test kills this dispatcher at the checkpoint. A much longer
        // fallback than its 30s observation window prevents the hold from
        // self-releasing under scheduler delay while remaining bounded.
        await Bun.sleep(5 * 60_000);
      },
    });
  `;
  const helper = Bun.spawn({
    cmd: ["bun", "-e", helperSource],
    env: childEnvironment(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return { helper, checkpointPath };
}

function spawnThrowingLifecycleCommand(checkpoint: "ready" | "completed", targetSource: string) {
  const resultPath = newParentLeaseCheckpointPath();
  const planted = `planted ${checkpoint} lifecycle hook failure`;
  const helperSource = `
    import { runOwnedCommand } from ${JSON.stringify(pathToFileURL(CLI).href)};
    let supervisorPid;
    try {
      await runOwnedCommand({
        command: ["perl", "-e", ${JSON.stringify(targetSource)}],
        cwd: ${JSON.stringify(process.cwd())},
        env: ${JSON.stringify(childEnvironment())},
        timeoutMs: 2_000,
        termGraceMs: 40,
        killReapMs: 300,
        pipeDrainMs: 200,
        supervisorScript: ${JSON.stringify(DELAYED_READY_SUPERVISOR)},
        onLifecycleCheckpoint: (phase, pid) => {
          if (phase !== ${JSON.stringify(checkpoint)}) return;
          supervisorPid = pid;
          throw new Error(${JSON.stringify(planted)});
        },
      });
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ kind: "resolved" }) + "\\n");
    } catch (error) {
      await Bun.write(
        ${JSON.stringify(resultPath)},
        JSON.stringify({
          kind: "rejected",
          supervisorPid,
          message: error instanceof Error ? error.message : String(error),
        }) + "\\n",
      );
    }
  `;
  const helper = Bun.spawn({
    cmd: ["bun", "-e", helperSource],
    env: childEnvironment(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return { helper, planted, resultPath };
}

async function waitForLifecycleCheckpoint(
  helper: ReturnType<typeof Bun.spawn>,
  checkpointPath: string,
  expected: "ready" | "completed",
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (existsSync(checkpointPath)) {
      const line = readFileSync(checkpointPath, "utf8");
      const match = /^checkpoint (ready|completed) ([1-9][0-9]*)\n$/u.exec(line);
      const supervisorPid = Number(match?.[2]);
      if (match?.[1] !== expected || !Number.isSafeInteger(supervisorPid) || supervisorPid <= 1) {
        throw new Error(`malformed checkpoint helper output for ${expected}`);
      }
      return supervisorPid;
    }
    const exitCode = await Promise.race([helper.exited, Bun.sleep(20).then(() => undefined)]);
    if (exitCode !== undefined) {
      throw new Error(`checkpoint helper exited ${exitCode} before ${expected}`);
    }
  }
  throw new Error(`checkpoint helper timed out before ${expected}`);
}

async function waitForLifecycleRejection(
  helper: ReturnType<typeof Bun.spawn>,
  resultPath: string,
  timeoutMs = 30_000,
): Promise<{ message: string; supervisorPid: number }> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (existsSync(resultPath)) {
      const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as {
        kind?: unknown;
        message?: unknown;
        supervisorPid?: unknown;
      };
      if (
        parsed.kind !== "rejected" ||
        typeof parsed.message !== "string" ||
        !Number.isSafeInteger(parsed.supervisorPid) ||
        Number(parsed.supervisorPid) <= 1
      ) {
        throw new Error(`malformed lifecycle rejection: ${JSON.stringify(parsed)}`);
      }
      return { message: parsed.message, supervisorPid: Number(parsed.supervisorPid) };
    }
    const exitCode = await Promise.race([helper.exited, Bun.sleep(20).then(() => undefined)]);
    if (exitCode !== undefined) {
      // Bun may resolve `exited` just ahead of the child's final small-file
      // publication becoming visible to this isolate.
      await Bun.sleep(50);
      if (existsSync(resultPath)) continue;
      throw new Error(`lifecycle helper exited ${exitCode} before publishing its rejection`);
    }
  }
  throw new Error("lifecycle helper timed out before publishing its rejection");
}

function ownedGroupPids(pgid: number, timeoutMs = 1_000): number[] {
  const root = parentLeaseFixtureRoot();
  const stdoutPath = join(root, "pgrep.stdout");
  const stderrPath = join(root, "pgrep.stderr");
  const stdoutFd = openSync(stdoutPath, "w", 0o600);
  const stderrFd = openSync(stderrPath, "w", 0o600);
  const child = (() => {
    try {
      return spawnSync(
        "bash",
        [
          "-c",
          'stdout_path="$1"; stderr_path="$2"; shift 2; exec "$@" >"$stdout_path" 2>"$stderr_path"',
          "suite-owned-group-inspector",
          stdoutPath,
          stderrPath,
          "/usr/bin/pgrep",
          "-g",
          String(pgid),
          ".*",
        ],
        {
          env: childEnvironment(),
          timeout: timeoutMs,
          stdio: "ignore",
        },
      );
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  })();
  const stdoutText = readFileSync(stdoutPath, "utf8");
  const stderrText = readFileSync(stderrPath, "utf8");
  const errorCode =
    child.error === undefined || !("code" in child.error) ? undefined : child.error.code;
  if (child.status === null || child.signal !== null || errorCode !== undefined) {
    throw new Error(`owned group ${pgid} inspection timed out`);
  }
  if (stderrText !== "" || (child.status !== 0 && child.status !== 1)) {
    throw new Error(`owned group ${pgid} inspection was unproven`);
  }
  if (child.status === 1) {
    if (stdoutText !== "") throw new Error(`owned group ${pgid} empty census had output`);
    return [];
  }
  const lines = stdoutText.endsWith("\n")
    ? stdoutText.slice(0, -1).split("\n")
    : stdoutText.split("\n");
  const pids = lines.map(Number);
  if (
    lines.length === 0 ||
    lines.some((line) => !/^[1-9][0-9]*$/u.test(line)) ||
    pids.some((pid) => !Number.isSafeInteger(pid)) ||
    new Set(pids).size !== pids.length
  ) {
    throw new Error(
      `owned group ${pgid} census was malformed: ${JSON.stringify(stdoutText.slice(0, 4_096))}`,
    );
  }
  return pids;
}

async function waitForOwnedGroupEmpty(pgid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastPids: number[] = [];
  while (performance.now() < deadline) {
    lastPids = ownedGroupPids(pgid);
    if (lastPids.length === 0) return;
    await Bun.sleep(20);
  }
  throw new Error(`owned group ${pgid} remained live: ${lastPids.join(",")}`);
}

async function stopOwnedFixtureGroup(pgid: number | undefined): Promise<void> {
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // The lease normally retires the exact group before test cleanup.
  }
  await waitForOwnedGroupEmpty(pgid);
}

function aggregateOutputCommand(totalCapturedBytes: number): string {
  return `my $payload = ${totalCapturedBytes}; my $stdout = 48 * 1024; die if $payload <= $stdout; syswrite(STDOUT, "x" x $stdout); syswrite(STDERR, ("y" x ($payload - $stdout - 1)) . "\\n");`;
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

  test("valid UTF-8 replacement-character bytes remain exact product output", async () => {
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        'binmode(STDOUT); syswrite(STDOUT, pack("C*", 0xEF, 0xBF, 0xBD)); exit 0;',
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("exited");
    expect(result.stdout).toBe("\uFFFD");
    expect(result.retainedStdoutBytes).toBe(3);
    expect(result.retainedOutputBytes).toBe(3);
  });

  test("malformed UTF-8 product bytes fail closed without a forged retained string", async () => {
    const result = await runOwnedCommand({
      command: ["perl", "-e", 'binmode(STDOUT); syswrite(STDOUT, pack("C", 0xFF)); exit 0;'],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("pipe-drain-unproven");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.retainedStdoutBytes).toBe(0);
    expect(result.retainedOutputBytes).toBe(0);
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

  test("a throwing pipe-cancel observer cannot interrupt exact-group cleanup", () => {
    const marker = `suite-throwing-pipe-cancel-${crypto.randomUUID()}`;
    const result = runOwnedCommandWithThrowingCancel({
      command: [
        "perl",
        "-e",
        `my $marker = "${marker}"; $SIG{TERM} = sub {}; $SIG{HUP} = sub {}; syswrite(STDOUT, "x" x ${PRODUCTION_STREAM_RETAINED_BYTES + 1}); while (1) { sleep 1; }`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      termGraceMs: 40,
      killReapMs: 200,
      pipeDrainMs: 200,
    });

    expect(result.outcome).toBe("output-overrun");
    expect(result.cleanupProven).toBe(true);
    expect(result.retainedStdoutBytes).toBe(PRODUCTION_STREAM_RETAINED_BYTES);
    expect(processTable()).not.toContain(marker);
  });

  test("the production 98304-byte aggregate limit completes exactly", async () => {
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `${aggregateOutputCommand(PRODUCTION_AGGREGATE_RETAINED_BYTES)} exit 0;`,
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
        `use POSIX qw(_exit); my $marker = "${marker}"; pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { $SIG{TERM} = sub {}; close $read; syswrite($write, "r"); close $write; select undef, undef, undef, 0.8; _exit(0); } close $write; read($read, my $ready, 1); close $read; $SIG{TERM} = sub {}; ${aggregateOutputCommand(PRODUCTION_AGGREGATE_RETAINED_BYTES + 1)} select undef, undef, undef, 0.8; _exit(0);`,
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

  test("a PID-mismatch refusal cancels inherited pipes after cleaning only the owned group", async () => {
    const marker = `suite-supervisor-pid-mismatch-${crypto.randomUUID()}`;
    const cancelled: ("stdout" | "stderr")[] = [];
    try {
      const startedAt = performance.now();
      const result = await runOwnedCommand({
        command: [
          "perl",
          "-MPOSIX=setsid",
          "-e",
          `use POSIX qw(_exit); my $marker = "${marker}"; pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { close $read; setsid(); $SIG{HUP} = sub {}; $SIG{TERM} = sub {}; syswrite($write, 'r'); close $write; while (1) { sleep 1; } } close $write; read($read, my $ready, 1); close $read; $SIG{TERM} = sub {}; while (1) { sleep 1; }`,
        ],
        cwd: process.cwd(),
        env: childEnvironment(),
        timeoutMs: 2_000,
        termGraceMs: 40,
        killReapMs: 200,
        pipeDrainMs: 5_000,
        supervisorScript: PID_MISMATCH_SUPERVISOR,
        onPipeCancelRequested: (pipe) => cancelled.push(pipe),
      });

      expect(result.outcome).toBe("ownership-unproven");
      expect(result.cleanupProven).toBe(true);
      expect(cancelled.sort()).toEqual(["stderr", "stdout"]);
      // The detached holder is deliberately outside the owned group. Finishing
      // well before pipeDrainMs proves the typed refusal cancels its local readers;
      // the still-live marker proves the dispatcher did not claim or kill that PID.
      expect(performance.now() - startedAt).toBeLessThan(3_000);
      expect(processTable()).toContain(marker);
    } finally {
      stopDetachedFixture(marker);
    }
    await Bun.sleep(30);
    expect(processTable()).not.toContain(marker);
  });

  test("a failed supervisor reap cancels detached inherited pipes before its typed refusal", async () => {
    const marker = `suite-reap-failure-pipe-boundary-${crypto.randomUUID()}`;
    const supervisorPidPath = capturePath("stubborn-release-supervisor.pid");
    const holderPidPath = capturePath("stubborn-release-holder.pid");
    const cancelled: ("stdout" | "stderr")[] = [];
    try {
      const startedAt = performance.now();
      const result = await runOwnedCommand({
        command: [
          "perl",
          "-MPOSIX=setsid",
          "-e",
          `use POSIX qw(_exit); my $marker = "${marker}"; my $holder_pid_path = ${JSON.stringify(holderPidPath)}; pipe(my $read, my $write) or die; my $child = fork(); die unless defined $child; if ($child == 0) { close $read; setsid(); $SIG{HUP} = sub {}; $SIG{TERM} = sub {}; open(my $holder_pid, ">", $holder_pid_path) or _exit(127); print {$holder_pid} "$$\\n" or _exit(127); close($holder_pid) or _exit(127); syswrite($write, 'r'); close $write; while (1) { sleep 1; } } close $write; read($read, my $ready, 1); close $read; _exit(0);`,
        ],
        cwd: process.cwd(),
        env: childEnvironment(),
        timeoutMs: 2_000,
        termGraceMs: 40,
        killReapMs: 40,
        pipeDrainMs: 5_000,
        supervisorScript: stubbornReleaseSupervisor(supervisorPidPath),
        onPipeCancelRequested: (pipe) => cancelled.push(pipe),
      });

      expect(result.outcome).toBe("ownership-unproven");
      expect(result.ownershipFailurePhase).toBe("leader-reap");
      // This custom supervisor is not authority for a clean owned-session exit.
      // A false green here would conceal the failed direct-child reap.
      expect(result.cleanupProven).not.toBe(true);
      expect(cancelled.sort()).toEqual(["stderr", "stdout"]);
      // The release signal was ignored, so the dispatcher must return from its
      // bounded direct-child reap instead of waiting for the escaped pipe FD.
      expect(performance.now() - startedAt).toBeLessThan(3_000);
      const supervisorPid = Number(readFileSync(supervisorPidPath, "utf8").trim());
      const holderPid = Number(readFileSync(holderPidPath, "utf8").trim());
      expect(Number.isSafeInteger(supervisorPid)).toBe(true);
      expect(Number.isSafeInteger(holderPid)).toBe(true);
      expect(supervisorPid).toBeGreaterThan(1);
      expect(holderPid).toBeGreaterThan(1);
      // The exact supervisor group (whose leader is the direct child) is gone.
      // This deliberately fails if the owned supervisor leaks, independently of
      // whether the detached holder still carries the same marker in its argv.
      expect(ownedGroupPids(supervisorPid)).toEqual([]);
      // The only remaining process with this marker is the recorded holder PID.
      // It proves the dispatcher neither claimed nor killed the detached process.
      expect(processIdsForMarker(marker)).toEqual([holderPid]);
    } finally {
      // Test-only cleanup of the uniquely identified escaped fixture. It never
      // self-retires and is intentionally outside the dispatcher-owned group.
      stopDetachedFixture(marker);
    }
    await Bun.sleep(30);
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
    expect(result.ownershipFailurePhase).toBeUndefined();
  });

  test("the production fd3 owner survives parent GC until the transcript is sealed", async () => {
    const resultPath = newParentLeaseCheckpointPath();
    const helperSource = `
      import { runOwnedCommand } from ${JSON.stringify(pathToFileURL(CLI).href)};
      let gcCheckpointReached = false;
      const result = await runOwnedCommand({
        command: ["perl", "-e", "select undef, undef, undef, 0.15; exit 0;"],
        cwd: ${JSON.stringify(process.cwd())},
        env: ${JSON.stringify(childEnvironment())},
        timeoutMs: 2_000,
        onLifecycleCheckpoint: async (phase) => {
          if (phase !== "ready") return;
          for (let index = 0; index < 64; index += 1) {
            void new Uint8Array(256 * 1024);
          }
          Bun.gc(true);
          gcCheckpointReached = true;
          await Bun.sleep(25);
        },
      });
      await Bun.write(
        ${JSON.stringify(resultPath)},
        JSON.stringify({ gcCheckpointReached, result }) + "\\n",
      );
    `;
    const helper = Bun.spawn({
      cmd: ["bun", "-e", helperSource],
      env: childEnvironment(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const helperExit = await Promise.race([helper.exited, Bun.sleep(5_000).then(() => undefined)]);
    if (helperExit === undefined) {
      helper.kill("SIGKILL");
      await helper.exited;
      throw new Error("fd3 GC helper exceeded its bounded lifetime");
    }
    expect(helperExit).toBe(0);
    let parsed: {
      gcCheckpointReached: boolean;
      result: OwnedCommandResult;
    };
    try {
      parsed = JSON.parse(readFileSync(resultPath, "utf8")) as typeof parsed;
    } catch {
      throw new Error("fd3 GC helper did not publish its exact JSON receipt");
    }

    expect(parsed.gcCheckpointReached).toBe(true);
    expect(parsed.result.outcome).toBe("exited");
    expect(parsed.result.exitCode).toBe(0);
    expect(parsed.result.ownershipFailurePhase).toBeUndefined();
  });

  test("PLANTED: a missing initial leader census names the exact ownership phase", async () => {
    const result = await runOwnedCommand({
      command: ["perl", "-e", "exit 0;"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      inspectionCommand: ["perl", "-e", "exit 1;"],
    });

    expect(result.outcome).toBe("ownership-unproven");
    expect(result.ownershipFailurePhase).toBe("initial-census");
    expect(result.cleanupProven).not.toBe(true);
  });

  test("unterminated product stderr cannot hide the supervisor completion", async () => {
    const result = await runOwnedCommand({
      command: ["perl", "-e", 'syswrite(STDERR, "unterminated-product-stderr"); exit 0;'],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("unterminated-product-stderr");
  });

  test("the target cannot inherit fd3 or forge lifecycle authority through stderr", async () => {
    const fake = `\u001eASIMPOSIUM_SUITE_CONTROL ${"a".repeat(36)} exited 0 0 999 -1\n`;
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `exit 91 if open(my $probe, ">&=3"); syswrite(STDERR, "\\036ASIMPOSIUM_SUITE_CONTROL ${"a".repeat(36)} exited 0 0 999 -1\\n"); exit 7;`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe(fake);
  });

  test("fragmented delayed fd3 records preserve exact lifecycle authority", async () => {
    const result = await runOwnedCommand({
      command: ["perl", "-e", "exit 0;"],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 2_000,
      supervisorScript: FRAGMENTED_CONTROL_SUPERVISOR,
    });

    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
  });

  test.each([
    "malformed",
    "invalid-utf8",
    "noncanonical-whitespace",
    "noncanonical-number",
    "duplicate-ready",
    "out-of-order",
    "oversized",
  ] as const)(
    "PLANTED: %s fd3 control fails closed after reaping the exact group",
    async (publication) => {
      const marker = `suite-invalid-control-${publication}-${crypto.randomUUID()}`;
      const result = await runOwnedCommand({
        command: ["perl", "-e", `my $marker = "${marker}"; exit 0;`],
        cwd: process.cwd(),
        env: childEnvironment(),
        timeoutMs: 500,
        termGraceMs: 40,
        killReapMs: 200,
        supervisorScript: invalidControlSupervisor(publication),
      });

      expect(result.outcome).toBe("ownership-unproven");
      expect(result.cleanupProven).toBe(true);
      expect(processTable()).not.toContain(marker);
    },
  );

  test("PLANTED: a lying custom start-failed record never upgrades a live child to proved cleanup", async () => {
    const marker = `suite-terminal-control-live-child-${crypto.randomUUID()}`;
    try {
      const result = await runOwnedCommand({
        command: ["perl", "-e", "exit 0;"],
        cwd: process.cwd(),
        env: childEnvironment(),
        timeoutMs: 500,
        termGraceMs: 40,
        killReapMs: 200,
        supervisorScript: terminalControlSupervisor("start-failed-with-child", marker),
      });

      expect(result.outcome).toBe("ownership-unproven");
      expect(result.cleanupProven).toBe(false);
      expect(processTable()).toContain(marker);
    } finally {
      stopDetachedFixture(marker);
    }
  });

  test.each([
    "start-failed",
    "start-failed-extra",
    "missing-terminal",
    "partial-line",
    "duplicate-terminal",
  ] as const)(
    "PLANTED: custom-supervisor %s cannot claim proved production cleanup",
    async (publication) => {
      const marker = `suite-terminal-control-${publication}-${crypto.randomUUID()}`;
      const result = await runOwnedCommand({
        command: ["perl", "-e", "exit 0;"],
        cwd: process.cwd(),
        env: childEnvironment(),
        timeoutMs: 500,
        termGraceMs: 40,
        killReapMs: 200,
        supervisorScript: terminalControlSupervisor(publication, marker),
      });

      expect(result.outcome).toBe("ownership-unproven");
      expect(result.cleanupProven).not.toBe(true);
      expect(processTable()).not.toContain(marker);
    },
  );

  test("dispatcher death retires a still-running target through the parent lease", async () => {
    let supervisorPid: number | undefined;
    const { helper, checkpointPath } = spawnCrashableOwnedCommand(
      "ready",
      "$SIG{TERM} = sub {}; $SIG{HUP} = sub {}; while (1) { sleep 1; }",
    );
    try {
      supervisorPid = await waitForLifecycleCheckpoint(helper, checkpointPath, "ready");
      const groupPids = ownedGroupPids(supervisorPid);
      expect(groupPids).toEqual(expect.arrayContaining([supervisorPid]));
      expect(groupPids.length).toBeGreaterThanOrEqual(2);

      helper.kill("SIGKILL");
      await helper.exited;
      await waitForOwnedGroupEmpty(supervisorPid);
    } finally {
      try {
        helper.kill("SIGKILL");
      } catch {
        // The planted dispatcher is expected to be gone.
      }
      await stopOwnedFixtureGroup(supervisorPid);
    }
  }, 60_000);

  test("dispatcher death retires a supervisor parked after target exit", async () => {
    let supervisorPid: number | undefined;
    const { helper, checkpointPath } = spawnCrashableOwnedCommand("completed", "exit 0;");
    try {
      supervisorPid = await waitForLifecycleCheckpoint(helper, checkpointPath, "completed");
      expect(ownedGroupPids(supervisorPid)).toEqual([supervisorPid]);

      helper.kill("SIGKILL");
      await helper.exited;
      await waitForOwnedGroupEmpty(supervisorPid);
    } finally {
      try {
        helper.kill("SIGKILL");
      } catch {
        // The planted dispatcher is expected to be gone.
      }
      await stopOwnedFixtureGroup(supervisorPid);
    }
  }, 60_000);

  test.each(["ready", "completed"] as const)(
    "a throwing %s lifecycle hook rejects only after its exact group is reaped",
    async (checkpoint) => {
      let supervisorPid: number | undefined;
      const fixture = spawnThrowingLifecycleCommand(
        checkpoint,
        checkpoint === "ready"
          ? "$SIG{TERM} = sub {}; $SIG{HUP} = sub {}; while (1) { sleep 1; }"
          : "exit 0;",
      );
      try {
        const rejection = await waitForLifecycleRejection(fixture.helper, fixture.resultPath);
        supervisorPid = rejection.supervisorPid;
        expect(rejection.message).toBe(fixture.planted);
        expect(await fixture.helper.exited).toBe(0);
        expect(ownedGroupPids(supervisorPid)).toEqual([]);
      } finally {
        try {
          fixture.helper.kill("SIGKILL");
        } catch {
          // The lifecycle helper is expected to have exited after publishing.
        }
        await stopOwnedFixtureGroup(supervisorPid);
      }
    },
    60_000,
  );

  test("the target sees EOF instead of the supervisor parent lease on stdin", async () => {
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        "my $bytes = sysread(STDIN, my $body, 1); exit((defined($bytes) && $bytes == 0) ? 0 : 1);",
      ],
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

  test("a stalled inspector retires a live target through the parent lease", async () => {
    const marker = `suite-stalled-inspector-${crypto.randomUUID()}`;
    const startedAt = performance.now();
    const result = await runOwnedCommand({
      command: [
        "perl",
        "-e",
        `my $marker = "${marker}"; $SIG{TERM} = sub {}; $SIG{HUP} = sub {}; while (1) { sleep 1; }`,
      ],
      cwd: process.cwd(),
      env: childEnvironment(),
      timeoutMs: 100,
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

  test("a detached inherited pipe holder receives one bounded reader cancellation, not dispatcher cleanup", async () => {
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
  test("the shell-heavy Wire unit composition has its own bounded parent deadline", () => {
    const wire = { name: "@asimposium/wire", dir: "apps/wire" };

    expect(suiteExecutionLimits("unit", wire)).toEqual({
      timeoutMs: 15 * 60_000,
      retainedStreamBytes: 512 * 1024,
      retainedOutputBytes: 768 * 1024,
    });
    expect(suiteExecutionLimits("contract", wire)).toEqual({
      timeoutMs: 5 * 60_000,
      retainedStreamBytes: 64 * 1024,
      retainedOutputBytes: 96 * 1024,
    });
    expect(suiteExecutionLimits("unit", { dir: "apps/web" })).toEqual({
      timeoutMs: 5 * 60_000,
      retainedStreamBytes: 64 * 1024,
      retainedOutputBytes: 96 * 1024,
    });
  });

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
      expect(unit.timeout_ms).toBe(unit.dir === "apps/wire" ? 15 * 60_000 : 5 * 60_000);
      expect(unit.retained_stream_limit_bytes).toBe(
        unit.dir === "apps/wire" ? 512 * 1024 : 64 * 1024,
      );
      expect(unit.retained_output_limit_bytes).toBe(
        unit.dir === "apps/wire" ? 768 * 1024 : 96 * 1024,
      );
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

  const ROOT_UNIT_MARKER = "root-unit-must-not-run";
  const PACKAGE_UNIT_MARKER = "package-unit-must-not-run";

  /**
   * A repository whose root toolchain unit *and* workspace package unit both record that
   * they ran. Either marker appearing proves the dispatcher spawned a real side effect.
   */
  function makeSpawnWitnessRepo(): string {
    return makeFixtureRepo({
      rootScripts: { "toolchain:test": markerCommand(ROOT_UNIT_MARKER) },
      packages: [
        {
          dir: "apps/web",
          source: true,
          scripts: { "test:unit": markerCommand(PACKAGE_UNIT_MARKER) },
        },
      ],
    });
  }

  function spawnWitnessed(root: string): { rootUnit: boolean; packageUnit: boolean } {
    return {
      rootUnit: existsSync(join(root, ROOT_UNIT_MARKER)),
      packageUnit: existsSync(join(root, "apps/web", PACKAGE_UNIT_MARKER)),
    };
  }

  test("PLANTED: at exactly MAX_DEPTH the refusal precedes every spawn site", async () => {
    const root = makeSpawnWitnessRepo();
    const result = await runCli(root, ["unit", "--json"], { ASIMPOSIUM_SUITE_DEPTH: "2" });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("SUITE_RECURSION");
    // The whole point of the exact-limit refusal. While preflight used `depth > MAX_DEPTH`,
    // depth 2 passed, runUnit spawned both of these at depth 3, and only each grandchild
    // dispatcher refused -- one full round of package side effects past the limit.
    expect(spawnWitnessed(root)).toEqual({ rootUnit: false, packageUnit: false });
  });

  test("--list at MAX_DEPTH stays a pure projection: plan only, nothing spawned", async () => {
    const root = makeSpawnWitnessRepo();
    const result = await runCli(root, ["unit", "--list", "--json"], {
      ASIMPOSIUM_SUITE_DEPTH: "2",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("SUITE_RECURSION");
    const emitted = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { record: string });
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((record) => record.record === "plan")).toBe(true);
    expect(spawnWitnessed(root)).toEqual({ rootUnit: false, packageUnit: false });
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
      .map(
        (line) =>
          JSON.parse(line) as {
            record: string;
            action: string;
            dir: string;
            timeout_ms?: number;
            retained_stream_limit_bytes?: number;
            retained_output_limit_bytes?: number;
          },
      );
    expect(plans.every((plan) => plan.record === "plan")).toBe(true);
    expect(plans.find((plan) => plan.dir === ".")).toEqual(
      expect.objectContaining({
        action: "run",
        timeout_ms: 5 * 60_000,
        retained_stream_limit_bytes: 64 * 1024,
        retained_output_limit_bytes: 96 * 1024,
      }),
    );
    expect(plans.find((plan) => plan.dir === "apps/wire")).toEqual(
      expect.objectContaining({
        action: "run",
        timeout_ms: 15 * 60_000,
        retained_stream_limit_bytes: 512 * 1024,
        retained_output_limit_bytes: 768 * 1024,
      }),
    );
    expect(plans.find((plan) => plan.dir === "packages/protocol")?.action).toBe("skip");
    expect(plans.find((plan) => plan.dir === "packages/protocol")?.timeout_ms).toBeUndefined();
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

describe("the executing toolchain bridge carries its dispatch depth", () => {
  const DEPTH_MARKER = "bridge-step-depth";

  /**
   * A fixture repository whose three real bridge step commands exist on disk. The first
   * step records the depth it actually observed, so the recursion counter is proved across
   * the real spawn boundary rather than injected into the process under test.
   */
  function makeBridgeFixture(): string {
    const root = makeFixtureRepo();
    mkdirSync(join(root, "infra"), { recursive: true });
    mkdirSync(join(root, "scripts", "suite"), { recursive: true });
    writeFileSync(
      join(root, "infra", "migrate.test.mjs"),
      'import { writeFileSync } from "node:fs";\n' +
        'const depth = process.env.ASIMPOSIUM_SUITE_DEPTH ?? "unset";\n' +
        `writeFileSync(${JSON.stringify(DEPTH_MARKER)}, depth + "\\n");\n` +
        'process.stdout.write("BRIDGE_STEP_DEPTH=" + depth + "\\n");\n',
    );
    writeFileSync(join(root, "infra", "migrate-local.test.mjs"), "process.exit(0);\n");
    writeFileSync(join(root, "scripts", "suite", "g0-spikes.ts"), "process.exit(0);\n");
    return root;
  }

  function bridgeRecords(result: CliResult): { record: string; step?: string; code: string }[] {
    return result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { record: string; step?: string; code: string });
  }

  test("PLANTED: a bridge at depth 1 spawns its first step at depth 2, never unset", async () => {
    const root = makeBridgeFixture();
    const result = await runCli(root, ["--toolchain-integration"], {
      ASIMPOSIUM_SUITE_DEPTH: "1",
    });

    // The step observed depth+1 across a real spawn. Before the fix this read "unset",
    // which reset the counter and left the recursion refusal permanently unreachable.
    expect(readFileSync(join(root, DEPTH_MARKER), "utf8")).toBe("2\n");
    expect(result.stderr).toContain("BRIDGE_STEP_DEPTH=2");
    expect(result.exitCode).toBe(0);
    expect(bridgeRecords(result).at(-1)).toEqual(
      expect.objectContaining({
        record: "toolchain-integration-summary",
        code: "TOOLCHAIN_INTEGRATION_COMPLETE",
      }),
    );
  });

  test("PLANTED: at MAX_DEPTH the bridge refuses before any step side effect", async () => {
    const root = makeBridgeFixture();
    const result = await runCli(root, ["--toolchain-integration"], {
      ASIMPOSIUM_SUITE_DEPTH: "2",
    });

    // Refusal precedes the spawn: the first step's marker file must never appear.
    expect(existsSync(join(root, DEPTH_MARKER))).toBe(false);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(2);
    expect(bridgeRecords(result)).toEqual([
      expect.objectContaining({
        record: "toolchain-integration-summary",
        status: "fail",
        code: "TOOLCHAIN_INTEGRATION_RECURSION",
        totals: { pass: 0, fail: 0, blocked: 0 },
      }),
    ]);
  });

  test("the recursion refusal never reaches --list: the plan stays an exact projection", async () => {
    const root = makeBridgeFixture();
    const result = await runCli(root, ["--toolchain-integration", "--list"], {
      ASIMPOSIUM_SUITE_DEPTH: "9",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, DEPTH_MARKER))).toBe(false);
    expect(bridgeRecords(result).map((record) => record.step)).toEqual([
      "d1-migration-contract",
      "d1-migration-local",
      "g0-spikes",
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
