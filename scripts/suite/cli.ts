#!/usr/bin/env bun

/**
 * The ASImposium root suite dispatcher (bead asimposiumorg-8xn, OPS.1).
 *
 * Every root entry point named in the OPS.1 acceptance criteria — typecheck, lint,
 * test:unit, test:contract, test:integration, test:e2e, test:security, test:performance —
 * routes here, and this file routes each one to the real script inside each workspace
 * package. It never invents a passing result:
 *
 *   - a package that carries source code and owes a suite but has no script FAILS
 *     (status "missing"), so a stub cannot stay silently green once it grows code;
 *   - a stub with no source files is reported "skip" with the reason, never "pass";
 *   - a suite in which no unit ever executed FAILS ("NO_UNITS_EXECUTED"), so an entry point
 *     cannot report a required gate green without having spawned a single unit;
 *   - a package that exits with the root-owned BLOCKED_EXIT_CODE is reported "blocked":
 *     still non-zero, still printed with its reproduction command, but counted apart from
 *     "fail" so a deliberate refusal and a broken test are never the same row;
 *   - child stdout/stderr is captured through the owned session and faithfully replayed
 *     after bounded cleanup; it is never suppressed;
 *   - dispatcher-authored records carry no absolute paths, no environment values and no
 *     credential-shaped strings.
 *
 * Run `bun run suite --help` for the full contract.
 */

import { closeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCKED_EXIT_CODE,
  isSuite,
  orderSuites,
  ROOT_UNITS,
  requiredSuitesFor,
  SUITE_DESCRIPTION,
  SUITE_SCRIPT,
  SUITES,
  type Suite,
} from "./policy.ts";
import {
  type Diagnostic,
  displayPath,
  formatSummaryLine,
  formatUnitLine,
  type PlanDiagnostic,
  redact,
  reproduceCommand,
  type SummaryDiagnostic,
  serialize,
  type UnitDiagnostic,
  type UnitStatus,
} from "./report.ts";
import {
  DiscoveryError,
  discoverWorkspaces,
  readRootPackage,
  type Workspace,
} from "./workspaces.ts";

const TOOL = "bun";
const DEPTH_ENV = "ASIMPOSIUM_SUITE_DEPTH";
const MAX_DEPTH = 2;

/**
 * Root-owned integration bridge. The D1 migration planner and the real local-D1
 * rollback gate must run before G0 aggregation: a G0 result cannot make an
 * unexercised migration path acceptable. Each command has its own ceiling and
 * the bridge has one aggregate ceiling, so an otherwise stuck child cannot
 * silently outlive the integration unit that reports on it.
 */
const TOOLCHAIN_INTEGRATION_STEPS = [
  {
    id: "d1-migration-contract",
    command: ["bun", "infra/migrate.test.mjs"],
    reproduce: "bun infra/migrate.test.mjs",
    // Pure planner corpus; this is an outer refusal bound, not a test timeout.
    timeoutMs: 120_000,
  },
  {
    id: "d1-migration-local",
    command: ["bun", "infra/migrate-local.test.mjs"],
    reproduce: "bun infra/migrate-local.test.mjs",
    // The child owns a 180-second D1 deadline and TERM->KILL reap protocol.
    timeoutMs: 190_000,
  },
  {
    id: "g0-spikes",
    command: ["bun", "scripts/suite/g0-spikes.ts"],
    reproduce: "bun scripts/suite/g0-spikes.ts",
    // The aggregate owns a 20-minute deadline; preserve a short outer reaping reserve.
    timeoutMs: 1_230_000,
  },
] as const;
const TOOLCHAIN_INTEGRATION_TERM_GRACE_MS = 2_000;
const TOOLCHAIN_INTEGRATION_KILL_REAP_MS = 2_000;
const OWNED_PROCESS_TERM_GRACE_MS = 500;
const OWNED_PROCESS_KILL_REAP_MS = 500;
const OWNED_PROCESS_PIPE_DRAIN_MS = 500;
const OWNED_PROCESS_STREAM_RETAINED_BYTES = 64 * 1024;
const OWNED_PROCESS_AGGREGATE_RETAINED_BYTES = 96 * 1024;
const OWNED_PROCESS_CONTROL_BUFFER_CHARS = 512;
const OWNED_PROCESS_INSPECTION_TIMEOUT_MS = 500;
const OWNED_PROCESS_INSPECTION_STREAM_RETAINED_BYTES = 64 * 1024;
const OWNED_PROCESS_INSPECTION_AGGREGATE_RETAINED_BYTES = 96 * 1024;
const OWNED_PROCESS_MAX_INSPECTIONS_PER_CLEANUP = 4;
const ACTIVE_OWNED_CONTROL_FILES = new Set<ReturnType<typeof Bun.file>>();
const TOOLCHAIN_INTEGRATION_TOTAL_TIMEOUT_MS =
  TOOLCHAIN_INTEGRATION_STEPS.reduce((total, step) => total + step.timeoutMs, 0) +
  TOOLCHAIN_INTEGRATION_STEPS.length *
    (TOOLCHAIN_INTEGRATION_TERM_GRACE_MS +
      TOOLCHAIN_INTEGRATION_KILL_REAP_MS +
      OWNED_PROCESS_INSPECTION_TIMEOUT_MS * OWNED_PROCESS_MAX_INSPECTIONS_PER_CLEANUP +
      OWNED_PROCESS_PIPE_DRAIN_MS);
const SUITE_TIMEOUT_MS: Readonly<Record<Suite, number>> = {
  typecheck: 5 * 60_000,
  lint: 5 * 60_000,
  unit: 5 * 60_000,
  contract: 5 * 60_000,
  // The root bridge itself owns a bounded 25-minute D1-before-G0 budget.
  integration: 30 * 60_000,
  security: 5 * 60_000,
  performance: 10 * 60_000,
  e2e: 30 * 60_000,
};
const WIRE_UNIT_SUITE_TIMEOUT_MS = 15 * 60_000;
const WIRE_UNIT_STREAM_RETAINED_BYTES = 512 * 1024;
const WIRE_UNIT_OUTPUT_RETAINED_BYTES = 768 * 1024;

export interface SuiteExecutionLimits {
  readonly timeoutMs: number;
  readonly retainedStreamBytes: number;
  readonly retainedOutputBytes: number;
}

/**
 * Wire's ordinary unit lane includes the bounded S1-S3 shell lifecycle
 * regressions. Their sequential composition and bounded diagnostic output are
 * intentionally larger than an ordinary package unit suite, so the dispatcher
 * must sit outside both without terminating a still-healthy run at generic
 * package limits.
 */
export function suiteExecutionLimits(
  suite: Suite,
  unit: { readonly dir: string },
): SuiteExecutionLimits {
  if (suite === "unit" && unit.dir === "apps/wire") {
    return {
      timeoutMs: WIRE_UNIT_SUITE_TIMEOUT_MS,
      retainedStreamBytes: WIRE_UNIT_STREAM_RETAINED_BYTES,
      retainedOutputBytes: WIRE_UNIT_OUTPUT_RETAINED_BYTES,
    };
  }
  return {
    timeoutMs: SUITE_TIMEOUT_MS[suite],
    retainedStreamBytes: OWNED_PROCESS_STREAM_RETAINED_BYTES,
    retainedOutputBytes: OWNED_PROCESS_AGGREGATE_RETAINED_BYTES,
  };
}

/**
 * A suite receives platform plumbing, never ambient authority. In particular,
 * unit and ordinary integration dispatch cannot inherit an S2 real-binding
 * opt-in, Cloudflare API token, Wrangler credential, or arbitrary parent
 * capability by accident. The only dispatcher-private value is injected below.
 */
const FORWARDED_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
  "CI",
  "NODE_ENV",
] as const;

interface Options {
  suites: Suite[];
  root: string;
  json: boolean;
  list: boolean;
  bail: boolean;
  requireExecuted: boolean;
}

class UsageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "UsageError";
  }
}

interface ToolchainIntegrationOptions {
  root: string;
  list: boolean;
}

type ToolchainIntegrationStatus = "pass" | "fail" | "blocked";

type OwnedCommandOutcome =
  | "exited"
  | "timeout"
  | "output-overrun"
  | "descendant-leaked"
  | "pipe-drain-unproven"
  | "inspection-unproven"
  | "ownership-unproven"
  | "spawn-failed";

export type OwnedSessionFailurePhase =
  | "ready-record"
  | "supervisor-pid"
  | "terminal-record"
  | "control-stream"
  | "initial-census"
  | "term-signal"
  | "cleanup-deadline"
  | "post-term-census"
  | "kill-signal"
  | "kill-reap"
  | "final-census"
  | "leader-release"
  | "leader-reap";

export interface OwnedCommandOptions {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  termGraceMs?: number;
  killReapMs?: number;
  pipeDrainMs?: number;
  retainedStreamBytes?: number;
  retainedOutputBytes?: number;
  /** Test seam only: production always inspects with the absolute /usr/bin/pgrep command below. */
  inspectionCommand?: readonly string[];
  inspectionTimeoutMs?: number;
  inspectionStreamBytes?: number;
  inspectionOutputBytes?: number;
  /** Test seam only: production always launches the nonce-bound supervisor below. */
  supervisorScript?: string;
  /** Test seam only: observes the first bounded cancel-and-release request per captured pipe. */
  onPipeCancelRequested?: (pipe: "stdout" | "stderr") => void;
  /** Test seam only: establishes deterministic parent-loss checkpoints. */
  onLifecycleCheckpoint?: (
    phase: "ready" | "completed",
    supervisorPid: number,
  ) => void | Promise<void>;
}

export interface OwnedCommandResult {
  outcome: OwnedCommandOutcome;
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  retainedStdoutBytes: number;
  retainedStderrBytes: number;
  retainedOutputBytes: number;
  cleanupProven?: boolean;
  /** Nonsecret phase attribution for a fail-closed owned-session identity loss. */
  ownershipFailurePhase?: OwnedSessionFailurePhase;
}

interface ToolchainIntegrationStepRecord {
  record: "toolchain-integration-step";
  tool: typeof TOOL;
  package: "asimposium";
  suite: "toolchain-integration";
  version: string;
  step: (typeof TOOLCHAIN_INTEGRATION_STEPS)[number]["id"];
  status: ToolchainIntegrationStatus;
  code:
    | "TOOLCHAIN_INTEGRATION_STEP_PASSED"
    | "TOOLCHAIN_INTEGRATION_STEP_BLOCKED"
    | "TOOLCHAIN_INTEGRATION_STEP_FAILED"
    | "TOOLCHAIN_INTEGRATION_STEP_SIGNALLED"
    | "TOOLCHAIN_INTEGRATION_STEP_TIMEOUT"
    | "TOOLCHAIN_INTEGRATION_OUTPUT_OVERRUN"
    | "TOOLCHAIN_INTEGRATION_DESCENDANT_LEAKED"
    | "TOOLCHAIN_INTEGRATION_PIPE_DRAIN_UNPROVEN"
    | "TOOLCHAIN_INTEGRATION_INSPECTION_UNPROVEN"
    | "TOOLCHAIN_INTEGRATION_OWNERSHIP_UNPROVEN"
    | "TOOLCHAIN_INTEGRATION_SPAWN_FAILED"
    | "TOOLCHAIN_INTEGRATION_GLOBAL_DEADLINE_EXHAUSTED";
  duration_ms: number;
  timeout_ms: number;
  reproduce: string;
  exit_code?: number;
  signal?: string;
}

interface ToolchainIntegrationPlanRecord {
  record: "toolchain-integration-plan";
  tool: typeof TOOL;
  package: "asimposium";
  suite: "toolchain-integration";
  step: (typeof TOOLCHAIN_INTEGRATION_STEPS)[number]["id"];
  action: "run";
  command: string;
  timeout_ms: number;
  reproduce: string;
}

interface ToolchainIntegrationSummaryRecord {
  record: "toolchain-integration-summary";
  tool: typeof TOOL;
  package: "asimposium";
  suite: "toolchain-integration";
  version: string;
  duration_ms: number;
  status: ToolchainIntegrationStatus;
  code:
    | "TOOLCHAIN_INTEGRATION_COMPLETE"
    | "TOOLCHAIN_INTEGRATION_BLOCKED"
    | "TOOLCHAIN_INTEGRATION_FAILED"
    | "TOOLCHAIN_INTEGRATION_RECURSION";
  totals: Readonly<Record<ToolchainIntegrationStatus, number>>;
  reproduce: "bun run toolchain:integration";
  detail?: string;
}

type ToolchainIntegrationRecord =
  | ToolchainIntegrationStepRecord
  | ToolchainIntegrationPlanRecord
  | ToolchainIntegrationSummaryRecord;

const HELP = `asimposium suite — root workspace suite dispatcher (OPS.1)

USAGE
  bun run suite <suite...> [options]
  bun run <entry-point>            # typecheck | lint | test:unit | test:contract |
                                   # test:integration | test:security |
                                   # test:performance | test:e2e | check

SUITES (run in this CI doctrine order when several are selected)
${SUITES.map((suite) => `  ${suite.padEnd(12)} ${SUITE_DESCRIPTION[suite]}`).join("\n")}

OPTIONS
  --all                    Run every suite in doctrine order.
  --filter <pattern>       Limit to workspaces whose name or directory matches (repeatable,
                           "*" wildcards allowed). Applies to the root toolchain unit too.
  --list                   Print the resolved plan and exit without running anything.
  --json                   NDJSON diagnostics on stdout. Child stdout is forwarded to
                           stderr so stdout stays parseable; nothing is suppressed.
  --require-executed       Accepted for compatibility; now redundant. A suite that executes
                           zero units always fails, flag or not.
  --bail                   Stop after the first failing unit.
  --root <dir>             Repository root to operate on (default: this repository).
  -h, --help               This text.

HOW A SUITE RESOLVES FOR ONE PACKAGE
  1. package.json defines the suite's script -> run "bun run <script>" in that directory.
  2. no script, package carries source files, and root policy requires the suite ->
     status "missing" and the run fails. Gates are not optional once code exists.
  3. no script and no source files -> status "skip" with reason "no source files yet".
  4. the script runs and exits ${BLOCKED_EXIT_CODE} -> status "blocked": the package deliberately refuses
     a gate it cannot yet satisfy honestly (no D1 namespace, no staging origin, no measured
     budget). Blocked is never green — it prints its reproduction command and detail, and
     the run exits ${BLOCKED_EXIT_CODE} — but it is counted apart from "fail" so a real regression inside
     an already-red suite is still visible. Any other non-zero exit is "fail".
  Required suites and the blocked exit code are declared at the repository root
  (scripts/suite/policy.ts) and never inside a package, so a feature diff cannot relax its
  own gate nor redefine what its own exit codes mean (Fable §17.0).

SCRIPT NAMES EXPECTED IN EACH WORKSPACE PACKAGE
${SUITES.map((suite) => `  ${suite.padEnd(12)} -> "${SUITE_SCRIPT[suite]}"`).join("\n")}

EXIT CODES
  0  at least one unit executed, and every unit passed or was legitimately skipped
  1  at least one unit failed, or a required suite script is missing
  2  usage, policy or preflight error (bad suite name, unreadable root, bun too old)
  ${BLOCKED_EXIT_CODE} no failures, but at least one unit is deliberately blocked on named future work

DIAGNOSTICS
  One record per unit plus a summary per suite: tool, package, suite, version, duration_ms,
  status and a copy-pasteable "reproduce" command. Paths are repository-relative; no
  environment values, secrets or absolute paths are ever written to a record.
`;

const TOOLCHAIN_INTEGRATION_HELP = `asimposium toolchain:integration — root integration bridge

USAGE
  bun run toolchain:integration
  bun run toolchain:integration -- --list

The bridge executes, in order: the pure D1 migration contract, the bounded
real-local Wrangler/D1 migration gate, then the bounded G0 spike aggregate.
It emits one typed record per step and a typed aggregate summary. The ordinary
integration target never grants the separate S2 real-binding authority; use
\`bun run test:integration:s2-real\` only when that authority is intended.
`;

function parseToolchainIntegrationArguments(
  argv: readonly string[],
  defaultRoot: string,
): ToolchainIntegrationOptions | "help" {
  let root = defaultRoot;
  let list = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    switch (argument) {
      case "--toolchain-integration":
        break;
      case "--list":
        list = true;
        break;
      case "-h":
      case "--help":
        return "help";
      case "--root": {
        const value = argv[++index];
        if (value === undefined) {
          throw new UsageError("MISSING_VALUE", "--root needs a directory");
        }
        root = isAbsolute(value) ? value : resolve(process.cwd(), value);
        break;
      }
      default:
        throw new UsageError(
          "TOOLCHAIN_INTEGRATION_UNKNOWN_OPTION",
          `Unknown toolchain:integration option "${argument}". Try --help.`,
        );
    }
  }

  return { root: resolve(root), list };
}

function emitToolchainIntegration(record: ToolchainIntegrationRecord, root: string): void {
  // Every field is bridge-owned and bounded. Redact remains the final guard so a
  // future path-bearing detail cannot turn this NDJSON contract into a leak.
  process.stdout.write(`${redact(JSON.stringify(record), root)}\n`);
}

function environmentForSuite(depth?: number): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of FORWARDED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) environment[key] = value;
  }
  if (depth !== undefined) environment[DEPTH_ENV] = String(depth + 1);
  return environment;
}

/**
 * The dispatch depth every entry point shares. `environmentForSuite(depth)` is the only
 * writer of `DEPTH_ENV`, and it builds a fresh environment rather than inheriting one, so
 * any dispatch path that omits its depth silently resets this counter to zero and disables
 * every recursion refusal below it.
 */
function dispatcherDepth(): number {
  return Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
}

async function valueBefore<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const OWNED_SESSION_SUPERVISOR = String.raw`
use strict;
use warnings;
use Fcntl qw(F_SETFD FD_CLOEXEC);
use POSIX qw(setsid WNOHANG _exit);
if (!defined setsid()) {
  exit 125;
}

open(my $control, ">&=3") or exit 125;
defined fcntl($control, F_SETFD, FD_CLOEXEC) or exit 125;

sub parent_lease_is_open {
  my $readable = "";
  vec($readable, fileno(STDIN), 1) = 1;
  my $selected = select($readable, undef, undef, 0);
  return 0 if !defined $selected;
  return 1 if $selected == 0;
  my $bytes = sysread(STDIN, my $unexpected, 1);
  # The dispatcher never writes this pipe. EOF means its writer disappeared;
  # any byte or read error is likewise a fail-closed lease violation.
  return 0 if !defined $bytes || $bytes == 0;
  return 0;
}

sub retire_orphaned_group {
  kill "KILL", -$$;
  _exit(125);
}

sub publish_control {
  my ($record) = @_;
  my $written = syswrite($control, $record);
  retire_orphaned_group() if !defined $written || $written != length($record);
}

$SIG{TERM} = sub {};
$SIG{HUP} = sub {};
$SIG{PIPE} = sub { retire_orphaned_group(); };

# The nonce arrives over the private parent lease, not argv or product stdio.
# Receiving it establishes the pre-fork liveness gate, and a live dispatcher
# keeps the same writer open until bounded cleanup or normal release completes.
my $nonce = <STDIN>;
retire_orphaned_group() if !defined $nonce;
chomp $nonce;
retire_orphaned_group() if $nonce !~ /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
# If the writer died after its nonce entered the kernel buffer, catch that EOF
# before forking. A death in the remaining check/fork interval is still retired
# by the first wait-loop lease poll, together with the exact owned group.
retire_orphaned_group() if !parent_lease_is_open();

my $target = fork();
if (!defined $target) {
  publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce start-failed 125 0 $$ -1\n");
  exit 125;
}
if ($target == 0) {
  close($control) or _exit(127);
  # Package commands historically receive /dev/null on stdin. Reopen it here so
  # the target cannot consume the supervisor's private parent-liveness lease.
  open STDIN, "<", "/dev/null" or _exit(127);
  exec @ARGV or _exit(127);
}
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce ready $$\n");
my $raw;
while (1) {
  my $waited = waitpid($target, WNOHANG);
  if ($waited == $target) {
    $raw = $?;
    last;
  }
  retire_orphaned_group() if $waited == -1 || !parent_lease_is_open();
  select undef, undef, undef, 0.05;
}
my $signal = $raw & 127;
my $exit = $signal ? 128 + $signal : $raw >> 8;
$SIG{USR1} = sub { exit $exit; };
publish_control("\036ASIMPOSIUM_SUITE_CONTROL $nonce exited $exit $signal $$ -1\n");
# Seal the exact two-record transcript while the parent lease still keeps this
# supervisor alive. The dispatcher proves fd3 EOF before it sends SIGUSR1, so a
# Bun stream-close anomaly cannot race an otherwise successful leader reap.
close($control) or retire_orphaned_group();
# The target has been reaped, so the supervisor is now the only legitimate
# owner of the outer output writers. Seal both while the parent lease still
# pins this exact group. A detached inheritor keeps a writer open and therefore
# remains a typed pipe-drain refusal; a normal run no longer races EOF against
# supervisor reap in Bun's ReadableStream wrapper.
close(STDOUT) or retire_orphaned_group();
close(STDERR) or retire_orphaned_group();
while (parent_lease_is_open()) { select undef, undef, undef, 0.05; }
retire_orphaned_group();
`;

interface OwnedSessionMember {
  pid: number;
  pgid: number;
  state: string;
}

interface OwnedSessionInspectorOptions {
  command?: readonly string[];
  timeoutMs: number;
  streamLimitBytes: number;
  outputLimitBytes: number;
}

type OwnedGroupCensus =
  | { state: "census"; members: OwnedSessionMember[] }
  | { state: "inspection-unproven" };

type OwnedSessionInspection =
  | { state: "owned"; members: OwnedSessionMember[] }
  | { state: "inspection-unproven" }
  | { state: "unproven" };

function millisecondsBefore(deadlineAt: number): number {
  return Math.max(0, Math.floor(deadlineAt - performance.now()));
}

function inspectionOptions(options: OwnedCommandOptions): OwnedSessionInspectorOptions {
  return {
    // `pgrep -g` is group-scoped, unlike a full host `ps` scan. Exit 1 is its
    // documented empty-group result; a bounded capture still protects both paths.
    command: options.inspectionCommand,
    timeoutMs: retainedByteLimit(options.inspectionTimeoutMs, OWNED_PROCESS_INSPECTION_TIMEOUT_MS),
    streamLimitBytes: retainedByteLimit(
      options.inspectionStreamBytes,
      OWNED_PROCESS_INSPECTION_STREAM_RETAINED_BYTES,
    ),
    outputLimitBytes: retainedByteLimit(
      options.inspectionOutputBytes,
      OWNED_PROCESS_INSPECTION_AGGREGATE_RETAINED_BYTES,
    ),
  };
}

async function inspectOwnedProcessGroup(
  leaderPid: number,
  options: OwnedSessionInspectorOptions,
  deadlineAt: number,
): Promise<OwnedGroupCensus> {
  const timeoutMs = Math.min(options.timeoutMs, millisecondsBefore(deadlineAt));
  if (timeoutMs <= 0) return { state: "inspection-unproven" };

  let snapshot: ReturnType<typeof Bun.spawn>;
  try {
    snapshot = Bun.spawn({
      cmd:
        options.command === undefined
          ? ["/usr/bin/pgrep", "-g", String(leaderPid), ".*"]
          : [...options.command],
      env: environmentForSuite(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { state: "inspection-unproven" };
  }

  const budget: RetainedOutputBudget = {
    retainedBytes: 0,
    limitBytes: options.outputLimitBytes,
  };
  const stdout = captureBoundedPipe(
    snapshot.stdout as ReadableStream<Uint8Array>,
    options.streamLimitBytes,
    budget,
  );
  const stderr = captureBoundedPipe(
    snapshot.stderr as ReadableStream<Uint8Array>,
    options.streamLimitBytes,
    budget,
  );
  const observation = await valueBefore(
    Promise.race([
      snapshot.exited.then((exitCode) => ({ kind: "exited" as const, exitCode })),
      stdout.overrun.then(() => ({ kind: "output-overrun" as const })),
      stderr.overrun.then(() => ({ kind: "output-overrun" as const })),
    ]),
    timeoutMs,
  );
  if (
    observation?.kind !== "exited" ||
    (observation.exitCode !== 0 && observation.exitCode !== 1)
  ) {
    cancelCapturedPipes([stdout, stderr]);
    killDirectChild(snapshot, "SIGKILL");
    await reapDirectChild(snapshot, millisecondsBefore(deadlineAt));
    await drainWithin([stdout, stderr], millisecondsBefore(deadlineAt));
    return { state: "inspection-unproven" };
  }
  if (
    !(await drainWithin([stdout, stderr], millisecondsBefore(deadlineAt))) ||
    stdout.overflowed() ||
    stderr.overflowed()
  ) {
    cancelCapturedPipes([stdout, stderr]);
    killDirectChild(snapshot, "SIGKILL");
    await reapDirectChild(snapshot, millisecondsBefore(deadlineAt));
    return { state: "inspection-unproven" };
  }

  const stdoutText = stdout.text();
  if (stderr.text() !== "") return { state: "inspection-unproven" };
  if (observation.exitCode === 1) {
    // `pgrep` reserves exit 1 for an empty match. Output with that status is a
    // contradiction, never an empty census that may prove a post-KILL group is gone.
    return stdoutText === "" ? { state: "census", members: [] } : { state: "inspection-unproven" };
  }

  const lines = stdoutText.endsWith("\n")
    ? stdoutText.slice(0, -1).split("\n")
    : stdoutText.split("\n");
  if (lines.length === 0 || lines.some((line) => !/^[1-9][0-9]*$/.test(line))) {
    return { state: "inspection-unproven" };
  }
  const seen = new Set<number>();
  const members: OwnedSessionMember[] = [];
  for (const line of lines) {
    const pid = Number(line);
    if (!Number.isSafeInteger(pid) || seen.has(pid)) return { state: "inspection-unproven" };
    seen.add(pid);
    members.push({ pid, pgid: leaderPid, state: "" });
  }

  return {
    state: "census",
    members,
  };
}

async function inspectOwnedSession(
  leaderPid: number,
  options: OwnedSessionInspectorOptions,
  deadlineAt: number,
): Promise<OwnedSessionInspection> {
  const census = await inspectOwnedProcessGroup(leaderPid, options, deadlineAt);
  if (census.state === "inspection-unproven") return census;
  const leader = census.members.find((row) => row.pid === leaderPid);
  if (leader === undefined || leader.pgid !== leaderPid || leader.state.includes("Z")) {
    return { state: "unproven" };
  }

  return {
    state: "owned",
    members: census.members,
  };
}

async function signalOwnedSession(
  leaderPid: number,
  signal: NodeJS.Signals,
  options: OwnedSessionInspectorOptions,
  deadlineAt: number,
): Promise<"signalled" | "inspection-unproven" | "unproven"> {
  const inspection = await inspectOwnedSession(leaderPid, options, deadlineAt);
  if (inspection.state === "inspection-unproven") return "inspection-unproven";
  if (inspection.state !== "owned") return "unproven";
  try {
    process.kill(-leaderPid, signal);
    return "signalled";
  } catch {
    return "unproven";
  }
}

async function releaseOwnedLeader(
  leaderPid: number,
  options: OwnedSessionInspectorOptions,
  deadlineAt: number,
): Promise<"released" | "descendant" | "inspection-unproven" | "unproven"> {
  const inspection = await inspectOwnedSession(leaderPid, options, deadlineAt);
  if (inspection.state === "inspection-unproven") return "inspection-unproven";
  if (inspection.state !== "owned") return "unproven";
  if (inspection.members.some((member) => member.pid !== leaderPid)) return "descendant";
  try {
    // SIGUSR1 is a supervisor-only release control, never a group broadcast:
    // a residual child must be observed and fail the run, not be silently killed.
    process.kill(leaderPid, "SIGUSR1");
    return "released";
  } catch {
    return "unproven";
  }
}

interface ControlEvent {
  kind: "exited" | "start-failed";
  exitCode: number;
  signal?: string;
  supervisorPid: number;
  memberCount: number;
}

interface CapturedStream {
  done: Promise<void>;
  ready: Promise<number | undefined>;
  completion: Promise<ControlEvent | undefined>;
  overrun: Promise<void>;
  cancel(): void;
  failed(): boolean;
  overflowed(): boolean;
  retainedBytes(): number;
  readyPid(): number | undefined;
  text(): string;
}

interface DrainableCapture {
  done: Promise<void>;
  cancel(): void;
  failed(): boolean;
}

type ControlStart =
  | { kind: "ready"; supervisorPid: number }
  | { kind: "start-failed"; event: ControlEvent };

interface CapturedControl extends DrainableCapture {
  start: Promise<ControlStart | undefined>;
  completion: Promise<ControlEvent | undefined>;
}

interface RetainedOutputBudget {
  retainedBytes: number;
  limitBytes: number;
}

function retainedByteLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function captureBoundedPipe(
  stream: ReadableStream<Uint8Array>,
  streamLimitBytes: number,
  budget: RetainedOutputBudget,
  controlPrefix?: string,
  onCancelRequested?: () => void,
): CapturedStream {
  let captured = "";
  let buffered = "";
  let streamFailed = false;
  let streamOverflowed = false;
  let retainedBytes = 0;
  let resolveReady!: (pid: number | undefined) => void;
  let resolveCompletion!: (event: ControlEvent | undefined) => void;
  let resolveOverrun!: () => void;
  let knownReadyPid: number | undefined;
  let readyResolved = false;
  let completionResolved = false;
  let overrunResolved = false;
  let reader: ReturnType<(typeof stream)["getReader"]> | undefined;
  let cancellationRequested = false;
  let cancellationDelivered = false;
  const ready = new Promise<number | undefined>((resolve) => {
    resolveReady = resolve;
  });
  const completion = new Promise<ControlEvent | undefined>((resolve) => {
    resolveCompletion = resolve;
  });
  const overrun = new Promise<void>((resolve) => {
    resolveOverrun = resolve;
  });
  const resolveReadyOnce = (pid: number | undefined): void => {
    if (readyResolved) return;
    readyResolved = true;
    knownReadyPid = pid;
    resolveReady(pid);
  };
  const resolveCompletionOnce = (event: ControlEvent | undefined): void => {
    if (completionResolved) return;
    completionResolved = true;
    resolveCompletion(event);
  };
  const resolveOverrunOnce = (): void => {
    if (overrunResolved) return;
    overrunResolved = true;
    resolveOverrun();
  };
  const inspectLine = (line: string): void => {
    if (controlPrefix === undefined || !line.startsWith(controlPrefix)) return;
    const fields = line.slice(controlPrefix.length).trim().split(/\s+/);
    const [kind, exitCodeText, signalText, supervisorPidText, memberCountText] = fields;
    if (kind === "ready") {
      const supervisorPid = Number(exitCodeText);
      if (fields.length === 2 && Number.isSafeInteger(supervisorPid) && supervisorPid > 0) {
        resolveReadyOnce(supervisorPid);
      }
      return;
    }
    const exitCode = Number(exitCodeText);
    const supervisorPid = Number(supervisorPidText);
    const memberCount = Number(memberCountText);
    if (
      (kind !== "exited" && kind !== "start-failed") ||
      !Number.isSafeInteger(exitCode) ||
      !Number.isSafeInteger(supervisorPid) ||
      supervisorPid < 1 ||
      !Number.isSafeInteger(memberCount) ||
      memberCount < -1 ||
      fields.length !== 5
    ) {
      return;
    }
    resolveCompletionOnce({
      kind,
      exitCode,
      ...(signalText === "0" ? {} : { signal: `SIG${signalText}` }),
      supervisorPid,
      memberCount,
    });
  };
  const releaseReader = (): void => {
    try {
      reader?.releaseLock();
    } catch {
      // A pending read may be completing cancellation; its finally block retries release.
    }
  };
  // Do not await reader.cancel(): a detached inheritor can retain an OS pipe
  // forever. Cancellation starts synchronously, releases the local reader, and
  // is idempotent across every bounded failure path.
  const cancel = (): void => {
    const firstRequest = !cancellationRequested;
    cancellationRequested = true;
    if (firstRequest) {
      try {
        onCancelRequested?.();
      } catch {
        // Test/diagnostic hooks are never allowed to interrupt pipe release or
        // strand the owned supervisor. The failed stream remains fail-closed.
        streamFailed = true;
      }
    }
    if (reader === undefined || cancellationDelivered) return;
    cancellationDelivered = true;
    try {
      void reader.cancel().catch(() => {
        // Cancellation is best-effort; the caller still reports a typed failure.
      });
    } catch {
      // A concurrent terminal read can reject cancellation synchronously.
    }
    releaseReader();
  };
  const retain = (chunk: Uint8Array, decoder: TextDecoder): void => {
    if (streamOverflowed) return;
    const available = Math.max(
      0,
      Math.min(streamLimitBytes - retainedBytes, budget.limitBytes - budget.retainedBytes),
    );
    const retained = chunk.byteLength <= available ? chunk : chunk.subarray(0, available);
    if (retained.byteLength > 0) {
      retainedBytes += retained.byteLength;
      budget.retainedBytes += retained.byteLength;
      const text = decoder.decode(retained, { stream: true });
      captured += text;
      if (controlPrefix !== undefined) {
        buffered += text;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          inspectLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
        if (buffered.length > OWNED_PROCESS_CONTROL_BUFFER_CHARS) buffered = "";
      }
    }
    if (retained.byteLength !== chunk.byteLength) {
      streamOverflowed = true;
      resolveOverrunOnce();
    }
  };
  const done = (async (): Promise<void> => {
    try {
      const activeReader = stream.getReader();
      reader = activeReader;
      if (cancellationRequested) {
        cancel();
        return;
      }
      const decoder = new TextDecoder();
      while (true) {
        const next = await activeReader.read();
        if (next.done) break;
        retain(next.value, decoder);
        if (streamOverflowed) {
          cancel();
          break;
        }
      }
      if (!streamOverflowed) {
        const decodedTail = decoder.decode();
        captured += decodedTail;
        const tail = buffered + decodedTail;
        if (tail.length > 0) inspectLine(tail);
      }
    } catch {
      if (!cancellationRequested) streamFailed = true;
    } finally {
      releaseReader();
      resolveReadyOnce(undefined);
      resolveCompletionOnce(undefined);
    }
  })();
  return {
    done,
    ready,
    completion,
    overrun,
    cancel,
    failed: () => streamFailed,
    overflowed: () => streamOverflowed,
    retainedBytes: () => retainedBytes,
    readyPid: () => knownReadyPid,
    text: () => captured,
  };
}

function captureControlPipe(
  stream: ReadableStream<Uint8Array>,
  nonce: string,
  expectedSupervisorPid: number,
): CapturedControl {
  const prefix = `\u001eASIMPOSIUM_SUITE_CONTROL ${nonce} `;
  let state: "start" | "completion" | "terminal" | "invalid" = "start";
  let buffered = "";
  let observedBytes = 0;
  let streamFailed = false;
  let cancellationRequested = false;
  let cancellationDelivered = false;
  let reader: ReturnType<(typeof stream)["getReader"]> | undefined;
  let resolveStart!: (start: ControlStart | undefined) => void;
  let resolveCompletion!: (event: ControlEvent | undefined) => void;
  let startResolved = false;
  let completionResolved = false;
  const start = new Promise<ControlStart | undefined>((resolve) => {
    resolveStart = resolve;
  });
  const completion = new Promise<ControlEvent | undefined>((resolve) => {
    resolveCompletion = resolve;
  });
  const resolveStartOnce = (value: ControlStart | undefined): void => {
    if (startResolved) return;
    startResolved = true;
    resolveStart(value);
  };
  const resolveCompletionOnce = (value: ControlEvent | undefined): void => {
    if (completionResolved) return;
    completionResolved = true;
    resolveCompletion(value);
  };
  const currentState = (): typeof state => state;
  const releaseReader = (): void => {
    try {
      reader?.releaseLock();
    } catch {
      // A pending read may still be completing cancellation.
    }
  };
  const cancel = (): void => {
    cancellationRequested = true;
    if (reader === undefined || cancellationDelivered) return;
    cancellationDelivered = true;
    try {
      void reader.cancel().catch(() => {
        // Closing the parent fd in runOwnedCommand is the final bounded release.
      });
    } catch {
      // A concurrent terminal read can reject cancellation synchronously.
    }
    releaseReader();
  };
  const invalidate = (): void => {
    if (state === "invalid") return;
    state = "invalid";
    streamFailed = true;
    resolveStartOnce(undefined);
    resolveCompletionOnce(undefined);
    cancel();
  };
  const parseTerminal = (fields: string[], kind: "exited" | "start-failed") => {
    const canonicalUnsigned = /^(?:0|[1-9]\d*)$/;
    const canonicalPositive = /^[1-9]\d*$/;
    const canonicalMemberCount = /^(?:-1|0|[1-9]\d*)$/;
    if (
      fields.length !== 5 ||
      !canonicalUnsigned.test(fields[1] ?? "") ||
      !canonicalUnsigned.test(fields[2] ?? "") ||
      !canonicalPositive.test(fields[3] ?? "") ||
      !canonicalMemberCount.test(fields[4] ?? "")
    ) {
      return undefined;
    }
    const exitCode = Number(fields[1]);
    const signalNumber = Number(fields[2]);
    const supervisorPid = Number(fields[3]);
    const memberCount = Number(fields[4]);
    if (
      !Number.isSafeInteger(exitCode) ||
      exitCode < 0 ||
      exitCode > 255 ||
      !Number.isSafeInteger(signalNumber) ||
      signalNumber < 0 ||
      signalNumber > 127 ||
      supervisorPid !== expectedSupervisorPid ||
      !Number.isSafeInteger(memberCount) ||
      memberCount < -1
    ) {
      return undefined;
    }
    return {
      kind,
      exitCode,
      ...(signalNumber === 0 ? {} : { signal: `SIG${signalNumber}` }),
      supervisorPid,
      memberCount,
    } satisfies ControlEvent;
  };
  const inspectLine = (line: string): void => {
    if (state === "terminal" || state === "invalid" || !line.startsWith(prefix)) {
      invalidate();
      return;
    }
    // The control grammar is byte-exact: single ASCII spaces, no trimming or
    // alternate whitespace. This keeps a malformed supervisor from being
    // accidentally normalized into an authoritative lifecycle event.
    const fields = line.slice(prefix.length).split(" ");
    if (state === "start") {
      if (fields[0] === "ready") {
        if (!/^[1-9]\d*$/.test(fields[1] ?? "")) {
          invalidate();
          return;
        }
        const supervisorPid = Number(fields[1]);
        if (fields.length !== 2 || supervisorPid !== expectedSupervisorPid) {
          invalidate();
          return;
        }
        state = "completion";
        resolveStartOnce({ kind: "ready", supervisorPid });
        return;
      }
      if (fields[0] === "start-failed") {
        const event = parseTerminal(fields, "start-failed");
        if (event === undefined) {
          invalidate();
          return;
        }
        state = "terminal";
        resolveStartOnce({ kind: "start-failed", event });
        resolveCompletionOnce(event);
        return;
      }
      invalidate();
      return;
    }
    if (fields[0] !== "exited") {
      invalidate();
      return;
    }
    const event = parseTerminal(fields, "exited");
    if (event === undefined) {
      invalidate();
      return;
    }
    state = "terminal";
    resolveCompletionOnce(event);
  };
  const done = (async (): Promise<void> => {
    try {
      const activeReader = stream.getReader();
      reader = activeReader;
      if (cancellationRequested) {
        cancel();
        return;
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        const next = await activeReader.read();
        if (next.done) break;
        observedBytes += next.value.byteLength;
        if (observedBytes > OWNED_PROCESS_CONTROL_BUFFER_CHARS) {
          invalidate();
          return;
        }
        buffered += decoder.decode(next.value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          inspectLine(buffered.slice(0, newline));
          if (currentState() === "invalid") return;
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      }
      buffered += decoder.decode();
      // A clean EOF before the terminal record is not itself a malformed record:
      // bounded cleanup may deliberately retire the supervisor after `ready`.
      // The caller classifies the missing event using its fresh ownership census.
      if (buffered.length !== 0) invalidate();
    } catch {
      if (!cancellationRequested) invalidate();
    } finally {
      releaseReader();
      resolveStartOnce(undefined);
      resolveCompletionOnce(undefined);
    }
  })();
  return {
    done,
    start,
    completion,
    cancel,
    failed: () => streamFailed,
  };
}

async function drainWithin(
  streams: readonly DrainableCapture[],
  milliseconds: number,
): Promise<boolean> {
  const drained = await valueBefore(
    Promise.all(streams.map((stream) => stream.done)),
    milliseconds,
  );
  if (drained !== undefined && !streams.some((stream) => stream.failed())) return true;
  cancelCapturedPipes(streams);
  return false;
}

function cancelCapturedPipes(streams: readonly DrainableCapture[]): void {
  for (const stream of streams) stream.cancel();
}

async function reapDirectChild(
  child: ReturnType<typeof Bun.spawn>,
  milliseconds: number,
): Promise<boolean> {
  return (await valueBefore(child.exited, milliseconds)) !== undefined;
}

async function reapBefore(
  child: ReturnType<typeof Bun.spawn>,
  deadlineAt: number,
): Promise<boolean> {
  return reapDirectChild(child, millisecondsBefore(deadlineAt));
}

async function sleepBefore(milliseconds: number, deadlineAt: number): Promise<boolean> {
  if (millisecondsBefore(deadlineAt) < milliseconds) return false;
  await Bun.sleep(milliseconds);
  return true;
}

function killDirectChild(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // This is the last-resort direct-child fallback only after the authoritative
    // session anchor was absent. It cannot prove anything about descendants.
  }
}

async function releaseOrKillOwnedSession(
  child: ReturnType<typeof Bun.spawn>,
  leaderPid: number,
  termGraceMs: number,
  killReapMs: number,
  timeout: boolean,
  memberCount?: number,
  inspector?: OwnedSessionInspectorOptions,
  retireThroughParentLease?: () => void,
  recordOwnershipFailure?: (phase: OwnedSessionFailurePhase) => void,
): Promise<OwnedCommandOutcome | undefined> {
  const inspection =
    inspector ??
    inspectionOptions({
      command: [],
      cwd: "",
      env: {},
      timeoutMs: 0,
    });
  const cleanupDeadlineAt =
    performance.now() +
    termGraceMs +
    killReapMs +
    inspection.timeoutMs * OWNED_PROCESS_MAX_INSPECTIONS_PER_CLEANUP;
  const abandon = async (
    outcome: "inspection-unproven" | "ownership-unproven",
  ): Promise<OwnedCommandOutcome> => {
    if (retireThroughParentLease !== undefined) {
      // Once ready is PID-pinned, the supervisor itself is the safest authority
      // for an inspection-failure teardown: EOF makes it SIGKILL its own group.
      // Killing only that leader would disable the lease monitor and could
      // strand the still-running target we can no longer safely inspect.
      retireThroughParentLease();
    } else {
      // Custom test supervisors do not implement the production lease protocol.
      killDirectChild(child, "SIGKILL");
    }
    await reapBefore(child, cleanupDeadlineAt);
    return outcome;
  };
  const ownershipUnproven = (phase: OwnedSessionFailurePhase): Promise<OwnedCommandOutcome> => {
    recordOwnershipFailure?.(phase);
    return abandon("ownership-unproven");
  };
  const killOwnedGroupAndProveEmpty = async (): Promise<OwnedCommandOutcome | undefined> => {
    const signal = await signalOwnedSession(leaderPid, "SIGKILL", inspection, cleanupDeadlineAt);
    if (signal === "inspection-unproven") return abandon("inspection-unproven");
    if (signal !== "signalled") return ownershipUnproven("kill-signal");
    if (!(await reapBefore(child, cleanupDeadlineAt))) return ownershipUnproven("kill-reap");
    const finalCensus = await inspectOwnedProcessGroup(leaderPid, inspection, cleanupDeadlineAt);
    if (finalCensus.state === "inspection-unproven") return "inspection-unproven";
    if (finalCensus.members.length === 0) return undefined;
    recordOwnershipFailure?.("final-census");
    return "ownership-unproven";
  };

  // The supervisor intentionally emits `-1`: post-target census authority lives
  // only in this parent's fresh, bounded, group-scoped inspection.
  void memberCount;
  const initial = await inspectOwnedSession(leaderPid, inspection, cleanupDeadlineAt);
  if (initial.state === "inspection-unproven") return abandon("inspection-unproven");
  if (initial.state !== "owned") return ownershipUnproven("initial-census");

  const hadDescendant = initial.members.some((member) => member.pid !== leaderPid);
  if (timeout || hadDescendant) {
    const term = await signalOwnedSession(leaderPid, "SIGTERM", inspection, cleanupDeadlineAt);
    if (term === "inspection-unproven") return abandon("inspection-unproven");
    if (term !== "signalled") return ownershipUnproven("term-signal");
    if (!(await sleepBefore(termGraceMs, cleanupDeadlineAt))) {
      return ownershipUnproven("cleanup-deadline");
    }
    // The fresh bounded host census saw this residual while the still-live direct
    // leader pinned the group identity. Escalate without trusting product bytes.
    if (hadDescendant) {
      const killed = await killOwnedGroupAndProveEmpty();
      if (killed !== undefined) return killed;
      return timeout ? "timeout" : "descendant-leaked";
    }
    const afterTerm = await inspectOwnedSession(leaderPid, inspection, cleanupDeadlineAt);
    if (afterTerm.state === "inspection-unproven") return abandon("inspection-unproven");
    if (afterTerm.state !== "owned") {
      // The supervisor deliberately ignores TERM. Its unexpected disappearance
      // means the identity pin was lost before a bounded group reap was proved.
      return ownershipUnproven("post-term-census");
    }
    if (afterTerm.members.some((member) => member.pid !== leaderPid)) {
      const killed = await killOwnedGroupAndProveEmpty();
      if (killed !== undefined) return killed;
      return timeout ? "timeout" : "descendant-leaked";
    }
  }

  const release = await releaseOwnedLeader(leaderPid, inspection, cleanupDeadlineAt);
  if (release === "inspection-unproven") return abandon("inspection-unproven");
  if (release === "descendant") {
    const term = await signalOwnedSession(leaderPid, "SIGTERM", inspection, cleanupDeadlineAt);
    if (term === "inspection-unproven") return abandon("inspection-unproven");
    if (term !== "signalled") return ownershipUnproven("term-signal");
    if (!(await sleepBefore(termGraceMs, cleanupDeadlineAt))) {
      return ownershipUnproven("cleanup-deadline");
    }
    const afterTerm = await inspectOwnedSession(leaderPid, inspection, cleanupDeadlineAt);
    if (afterTerm.state === "inspection-unproven") return abandon("inspection-unproven");
    if (afterTerm.state !== "owned") return ownershipUnproven("post-term-census");
    if (afterTerm.members.some((member) => member.pid !== leaderPid)) {
      const killed = await killOwnedGroupAndProveEmpty();
      if (killed !== undefined) return killed;
    } else if (
      (await releaseOwnedLeader(leaderPid, inspection, cleanupDeadlineAt)) !== "released"
    ) {
      return ownershipUnproven("leader-release");
    }
    return timeout ? "timeout" : "descendant-leaked";
  }
  if (release === "unproven") return ownershipUnproven("leader-release");
  if (!(await reapBefore(child, cleanupDeadlineAt))) {
    return ownershipUnproven("leader-reap");
  }
  return timeout ? "timeout" : hadDescendant ? "descendant-leaked" : undefined;
}

async function terminateForOutputOverrun(
  child: ReturnType<typeof Bun.spawn>,
  supervisorPid: number | undefined,
  termGraceMs: number,
  killReapMs: number,
  inspector: OwnedSessionInspectorOptions,
  retireThroughParentLease?: () => void,
  recordOwnershipFailure?: (phase: OwnedSessionFailurePhase) => void,
): Promise<OwnedCommandOutcome> {
  if (supervisorPid !== undefined) {
    return (
      (await releaseOrKillOwnedSession(
        child,
        supervisorPid,
        termGraceMs,
        killReapMs,
        true,
        undefined,
        inspector,
        retireThroughParentLease,
        recordOwnershipFailure,
      )) ?? "ownership-unproven"
    );
  }
  killDirectChild(child, "SIGKILL");
  await reapDirectChild(child, killReapMs);
  return "ownership-unproven";
}

type CompletionObservation =
  | { kind: "completed"; control: ControlEvent | undefined }
  | { kind: "output-overrun" };

export async function runOwnedCommand(options: OwnedCommandOptions): Promise<OwnedCommandResult> {
  const nonce = crypto.randomUUID();
  const budget: RetainedOutputBudget = {
    retainedBytes: 0,
    limitBytes: retainedByteLimit(
      options.retainedOutputBytes,
      OWNED_PROCESS_AGGREGATE_RETAINED_BYTES,
    ),
  };
  const streamLimitBytes = retainedByteLimit(
    options.retainedStreamBytes,
    OWNED_PROCESS_STREAM_RETAINED_BYTES,
  );
  const inspector = inspectionOptions(options);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: [
        "perl",
        "-e",
        options.supervisorScript ?? OWNED_SESSION_SUPERVISOR,
        ...(options.supervisorScript === undefined ? [] : [nonce]),
        ...options.command,
      ],
      cwd: options.cwd,
      env: options.env,
      // This write end is a kernel-backed parent-liveness lease. The supervisor
      // monitors EOF while the target runs and while it awaits normal SIGUSR1
      // release, so dispatcher death cannot leave an orphaned owned group.
      // fd3 is a supervisor-only control pipe. The fork child closes it before
      // exec, so product output cannot collide with or forge lifecycle records.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
  } catch {
    return {
      outcome: "spawn-failed",
      stdout: "",
      stderr: "",
      retainedStdoutBytes: 0,
      retainedStderrBytes: 0,
      retainedOutputBytes: 0,
    };
  }

  // This spawn site fixes stdin to "pipe"; Bun therefore returns its FileSink.
  const ownershipLease = child.stdin as {
    write(bytes: string): number;
    flush(): number | Promise<number>;
    end(): void;
  };
  let ownershipLeaseClosed = false;
  const closeOwnershipLease = (): void => {
    if (ownershipLeaseClosed) return;
    ownershipLeaseClosed = true;
    try {
      ownershipLease.end();
    } catch {
      // EOF/broken-writer is the supervisor's fail-closed retirement signal.
    }
  };
  const retireThroughParentLease =
    options.supervisorScript === undefined ? closeOwnershipLease : undefined;
  const controlFd = child.stdio[3];
  if (!Number.isSafeInteger(controlFd) || Number(controlFd) < 0) {
    closeOwnershipLease();
    killDirectChild(child, "SIGKILL");
    const cleanupProven = await reapDirectChild(
      child,
      options.killReapMs ?? OWNED_PROCESS_KILL_REAP_MS,
    );
    return {
      outcome: "spawn-failed",
      stdout: "",
      stderr: "",
      retainedStdoutBytes: 0,
      retainedStderrBytes: 0,
      retainedOutputBytes: 0,
      cleanupProven,
    };
  }
  let controlFdClosed = false;
  const closeControlFd = (): void => {
    if (controlFdClosed) return;
    controlFdClosed = true;
    try {
      closeSync(Number(controlFd));
    } catch {
      // The raw extra-pipe descriptor may already have been released on error.
    }
  };
  let controlFile: ReturnType<typeof Bun.file> | undefined;
  try {
    // Retain the BunFile itself until `finally` closes the numeric fd. A stream
    // created from an otherwise-temporary BunFile can lose its fd owner during a
    // long, allocation-heavy root run even though the ReadableStream is alive.
    controlFile = Bun.file(Number(controlFd));
    ACTIVE_OWNED_CONTROL_FILES.add(controlFile);
    const stdout = captureBoundedPipe(
      child.stdout as ReadableStream<Uint8Array>,
      streamLimitBytes,
      budget,
      undefined,
      () => options.onPipeCancelRequested?.("stdout"),
    );
    const stderr = captureBoundedPipe(
      child.stderr as ReadableStream<Uint8Array>,
      streamLimitBytes,
      budget,
      undefined,
      () => options.onPipeCancelRequested?.("stderr"),
    );
    const control = captureControlPipe(controlFile.stream(), nonce, child.pid);
    const termGraceMs = options.termGraceMs ?? OWNED_PROCESS_TERM_GRACE_MS;
    const killReapMs = options.killReapMs ?? OWNED_PROCESS_KILL_REAP_MS;
    const pipeDrainMs = options.pipeDrainMs ?? OWNED_PROCESS_PIPE_DRAIN_MS;
    const startedAt = performance.now();
    let outcome: OwnedCommandOutcome = "ownership-unproven";
    let exitCode: number | undefined;
    let signal: string | undefined;
    let cleanupProven: boolean | undefined;
    let ownershipFailurePhase: OwnedSessionFailurePhase | undefined;
    const recordOwnershipFailure = (phase: OwnedSessionFailurePhase): void => {
      ownershipFailurePhase ??= phase;
    };

    if (options.supervisorScript === undefined) {
      try {
        const leaseRecord = `${nonce}\n`;
        if (ownershipLease.write(leaseRecord) !== Buffer.byteLength(leaseRecord)) {
          throw new Error("partial parent-lease write");
        }
        const remaining = Math.max(
          0,
          options.timeoutMs - Math.round(performance.now() - startedAt),
        );
        if ((await valueBefore(Promise.resolve(ownershipLease.flush()), remaining)) === undefined) {
          throw new Error("parent-lease flush exceeded command deadline");
        }
      } catch {
        closeOwnershipLease();
        // The supervisor has already called setsid before reading this record.
        // EOF therefore lets it retire its own exact group even if it consumed a
        // partial/full nonce before the parent observed the write failure.
        cleanupProven = await reapDirectChild(child, killReapMs);
        cancelCapturedPipes([stdout, stderr, control]);
        await drainWithin([stdout, stderr, control], pipeDrainMs);
        return {
          outcome: "spawn-failed",
          stdout: stdout.text(),
          stderr: stderr.text(),
          retainedStdoutBytes: stdout.retainedBytes(),
          retainedStderrBytes: stderr.retainedBytes(),
          retainedOutputBytes: budget.retainedBytes,
          cleanupProven,
        };
      }
    }

    const lifecycleCheckpoint = async (
      phase: "ready" | "completed",
      supervisorPid: number,
    ): Promise<void> => {
      const hook = options.onLifecycleCheckpoint;
      if (hook === undefined) return;
      const remaining = Math.max(0, options.timeoutMs - Math.round(performance.now() - startedAt));
      const observation = await valueBefore(
        Promise.resolve()
          .then(() => hook(phase, supervisorPid))
          .then(
            () => ({ kind: "completed" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          ),
        remaining,
      );
      if (observation?.kind === "completed") return;

      const checkpointError =
        observation?.kind === "rejected"
          ? observation.error
          : new Error(`suite lifecycle checkpoint ${phase} exceeded its command deadline`);
      const cleanup = await releaseOrKillOwnedSession(
        child,
        supervisorPid,
        termGraceMs,
        killReapMs,
        true,
        undefined,
        inspector,
        retireThroughParentLease,
        recordOwnershipFailure,
      );
      cancelCapturedPipes([stdout, stderr, control]);
      const drained = await drainWithin([stdout, stderr, control], pipeDrainMs);
      if (cleanup !== "timeout" || !drained) {
        throw new AggregateError(
          [
            checkpointError,
            new Error(
              `suite lifecycle checkpoint cleanup was unproven: ${cleanup ?? "released-without-timeout-proof"}; pipes=${drained ? "drained" : "unproven"}`,
            ),
          ],
          `suite lifecycle checkpoint ${phase} failed before cleanup was proved`,
        );
      }
      throw checkpointError;
    };

    // Product output is not authority. Even if it crosses a retained-byte ceiling
    // first, wait for the nonce-bound ready record and pin it to Bun's direct child
    // before any group signal can be considered owned.
    const readyWaitMs = Math.max(0, options.timeoutMs - Math.round(performance.now() - startedAt));
    const startObservation = await valueBefore(
      control.start.then((start) => ({ start })),
      readyWaitMs,
    );
    const controlStart = startObservation?.start;
    const supervisorPid = controlStart?.kind === "ready" ? controlStart.supervisorPid : undefined;
    if (controlStart?.kind === "ready") {
      await lifecycleCheckpoint("ready", controlStart.supervisorPid);
    }
    if (controlStart?.kind === "start-failed") {
      exitCode = controlStart.event.exitCode;
      signal = controlStart.event.signal;
      cleanupProven = await reapDirectChild(child, killReapMs);
      if (options.supervisorScript === undefined) {
        outcome = "spawn-failed";
      } else {
        // A custom supervisor is not production authority for the claim that
        // fork() failed and no same-group child exists. Reaping only its leader
        // cannot upgrade that assertion into proved cleanup.
        cleanupProven = false;
        outcome = "ownership-unproven";
        recordOwnershipFailure("terminal-record");
      }
    } else if (supervisorPid === undefined) {
      // A command deadline may elapse while its ready record is still queued. The
      // direct child PID is a separate OS fact: only a fresh bounded census may
      // promote it to a cleanup target. It never promotes pre-ready product bytes
      // into a trusted output-overrun result.
      const cleanup = await releaseOrKillOwnedSession(
        child,
        child.pid,
        termGraceMs,
        killReapMs,
        true,
        undefined,
        inspector,
        retireThroughParentLease,
        recordOwnershipFailure,
      );
      cleanupProven = cleanup === "timeout";
      outcome =
        startObservation !== undefined ||
        control.failed() ||
        stdout.overflowed() ||
        stderr.overflowed()
          ? "ownership-unproven"
          : cleanup === "timeout"
            ? "timeout"
            : (cleanup ?? "spawn-failed");
    } else if (supervisorPid !== child.pid) {
      recordOwnershipFailure("supervisor-pid");
      const cleanup = await releaseOrKillOwnedSession(
        child,
        child.pid,
        termGraceMs,
        killReapMs,
        true,
        undefined,
        inspector,
        retireThroughParentLease,
        recordOwnershipFailure,
      );
      cleanupProven = cleanup === "timeout";
      outcome = "ownership-unproven";
    } else {
      const finishOutputOverrun = async (): Promise<void> => {
        const cleanup = await terminateForOutputOverrun(
          child,
          supervisorPid,
          termGraceMs,
          killReapMs,
          inspector,
          retireThroughParentLease,
          recordOwnershipFailure,
        );
        if (cleanup === "inspection-unproven" || cleanup === "ownership-unproven") {
          cleanupProven = false;
          outcome = cleanup;
        } else {
          cleanupProven = cleanup === "timeout";
          outcome = "output-overrun";
        }
      };
      if (stdout.overflowed() || stderr.overflowed()) {
        await finishOutputOverrun();
      } else {
        const remaining = Math.max(
          0,
          options.timeoutMs - Math.round(performance.now() - startedAt),
        );
        const completion = await valueBefore(
          Promise.race<CompletionObservation>([
            control.completion.then((event) => ({ kind: "completed", control: event })),
            stdout.overrun.then(() => ({ kind: "output-overrun" })),
            stderr.overrun.then(() => ({ kind: "output-overrun" })),
          ]),
          remaining,
        );
        if (completion?.kind === "output-overrun") {
          await finishOutputOverrun();
        } else if (completion === undefined || completion.control === undefined) {
          if (completion !== undefined || control.failed()) {
            recordOwnershipFailure("control-stream");
          }
          const cleanup = await releaseOrKillOwnedSession(
            child,
            supervisorPid,
            termGraceMs,
            killReapMs,
            true,
            undefined,
            inspector,
            retireThroughParentLease,
            recordOwnershipFailure,
          );
          cleanupProven = cleanup === "timeout";
          outcome =
            completion !== undefined || control.failed()
              ? "ownership-unproven"
              : (cleanup ?? "ownership-unproven");
        } else {
          const controlEvent = completion.control;
          exitCode = controlEvent.exitCode;
          signal = controlEvent.signal;
          const controlSealRemaining = Math.max(
            0,
            options.timeoutMs - Math.round(performance.now() - startedAt),
          );
          const controlSealed =
            options.supervisorScript !== undefined ||
            ((await valueBefore(
              control.done.then(() => true),
              controlSealRemaining,
            )) === true &&
              !control.failed());
          if (!controlSealed) {
            recordOwnershipFailure("control-stream");
            const cleanup = await releaseOrKillOwnedSession(
              child,
              supervisorPid,
              termGraceMs,
              killReapMs,
              false,
              undefined,
              inspector,
              retireThroughParentLease,
              recordOwnershipFailure,
            );
            cleanupProven = cleanup === "timeout";
            outcome = "ownership-unproven";
          } else if (stdout.overflowed() || stderr.overflowed()) {
            await finishOutputOverrun();
          } else if (
            options.supervisorScript === undefined &&
            !(await drainWithin([stdout, stderr], pipeDrainMs))
          ) {
            const cleanup = await releaseOrKillOwnedSession(
              child,
              supervisorPid,
              termGraceMs,
              killReapMs,
              false,
              undefined,
              inspector,
              retireThroughParentLease,
              recordOwnershipFailure,
            );
            if (cleanup === "inspection-unproven" || cleanup === "ownership-unproven") {
              cleanupProven = false;
              outcome = cleanup;
            } else if (cleanup === "descendant-leaked") {
              cleanupProven = true;
              outcome = cleanup;
            } else {
              cleanupProven = cleanup === undefined;
              outcome = "pipe-drain-unproven";
            }
          } else if (
            controlEvent.supervisorPid !== supervisorPid ||
            controlEvent.kind === "start-failed"
          ) {
            recordOwnershipFailure("terminal-record");
            const cleanup = await releaseOrKillOwnedSession(
              child,
              supervisorPid,
              termGraceMs,
              killReapMs,
              true,
              undefined,
              inspector,
              retireThroughParentLease,
              recordOwnershipFailure,
            );
            cleanupProven = cleanup === "timeout";
            outcome = controlEvent.kind === "start-failed" ? "spawn-failed" : "ownership-unproven";
          } else {
            await lifecycleCheckpoint("completed", supervisorPid);
            outcome =
              (await releaseOrKillOwnedSession(
                child,
                supervisorPid,
                termGraceMs,
                killReapMs,
                false,
                controlEvent.memberCount,
                inspector,
                retireThroughParentLease,
                recordOwnershipFailure,
              )) ?? "exited";
          }
        }
      }
    }

    // A typed lifecycle failure never retains a local pipe reader while bounded
    // cleanup is being assessed. `cancel()` is one-shot and never awaits a
    // detached inheritor's pipe close; normal successful exits still get their
    // bounded drain before release.
    if (outcome !== "exited") {
      cancelCapturedPipes([stdout, stderr, control]);
    }
    const drained = await drainWithin([stdout, stderr, control], pipeDrainMs);
    if (control.failed()) {
      outcome = "ownership-unproven";
      recordOwnershipFailure("control-stream");
    } else if (outcome === "exited" && (stdout.overflowed() || stderr.overflowed())) {
      outcome = "output-overrun";
      cleanupProven = true;
    } else if (outcome === "exited" && !drained) {
      outcome = "pipe-drain-unproven";
    }
    if (outcome === "ownership-unproven" && ownershipFailurePhase === undefined) {
      recordOwnershipFailure("ready-record");
    }
    return {
      outcome,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
      stdout: stdout.text(),
      stderr: stderr.text(),
      retainedStdoutBytes: stdout.retainedBytes(),
      retainedStderrBytes: stderr.retainedBytes(),
      retainedOutputBytes: budget.retainedBytes,
      ...(cleanupProven === undefined ? {} : { cleanupProven }),
      ...(ownershipFailurePhase === undefined ? {} : { ownershipFailurePhase }),
    };
  } finally {
    // Normal release has already reaped the supervisor. Closing the writer here
    // also makes exceptions and fail-closed returns unable to park a
    // lease-waiting leader.
    closeOwnershipLease();
    closeControlFd();
    if (controlFile !== undefined) ACTIVE_OWNED_CONTROL_FILES.delete(controlFile);
  }
}

async function runToolchainIntegrationStep(
  step: (typeof TOOLCHAIN_INTEGRATION_STEPS)[number],
  root: string,
  timeoutMs: number,
  depth: number,
): Promise<ToolchainIntegrationStepRecord> {
  const startedAt = performance.now();
  const base = {
    record: "toolchain-integration-step" as const,
    tool: TOOL as typeof TOOL,
    package: "asimposium" as const,
    suite: "toolchain-integration" as const,
    version: Bun.version,
    step: step.id,
    duration_ms: 0,
    timeout_ms: timeoutMs,
    reproduce: step.reproduce,
  };

  const result = await runOwnedCommand({
    command: step.command,
    cwd: root,
    // A step is one dispatch hop below this bridge, so it inherits depth + 1. Dropping the
    // depth here would reset the counter and let a step command re-enter the dispatcher
    // without ever reaching MAX_DEPTH.
    env: environmentForSuite(depth),
    timeoutMs,
    termGraceMs: TOOLCHAIN_INTEGRATION_TERM_GRACE_MS,
    killReapMs: TOOLCHAIN_INTEGRATION_KILL_REAP_MS,
  });
  if (result.stdout.length > 0) process.stderr.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);

  if (result.outcome !== "exited") {
    const code =
      result.outcome === "timeout"
        ? "TOOLCHAIN_INTEGRATION_STEP_TIMEOUT"
        : result.outcome === "output-overrun"
          ? "TOOLCHAIN_INTEGRATION_OUTPUT_OVERRUN"
          : result.outcome === "descendant-leaked"
            ? "TOOLCHAIN_INTEGRATION_DESCENDANT_LEAKED"
            : result.outcome === "pipe-drain-unproven"
              ? "TOOLCHAIN_INTEGRATION_PIPE_DRAIN_UNPROVEN"
              : result.outcome === "inspection-unproven"
                ? "TOOLCHAIN_INTEGRATION_INSPECTION_UNPROVEN"
                : result.outcome === "ownership-unproven"
                  ? "TOOLCHAIN_INTEGRATION_OWNERSHIP_UNPROVEN"
                  : "TOOLCHAIN_INTEGRATION_SPAWN_FAILED";
    return {
      ...base,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "fail",
      code,
      ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
    };
  }

  const timelyExit = result.exitCode;
  const signal = result.signal;
  if (timelyExit === undefined) {
    return {
      ...base,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "fail",
      code: "TOOLCHAIN_INTEGRATION_OWNERSHIP_UNPROVEN",
    };
  }
  const baseWithExit = {
    ...base,
    duration_ms: Math.round(performance.now() - startedAt),
    exit_code: timelyExit,
    ...(signal === undefined ? {} : { signal }),
  };
  if (signal !== undefined) {
    return {
      ...baseWithExit,
      status: "fail",
      code: "TOOLCHAIN_INTEGRATION_STEP_SIGNALLED",
    };
  }
  if (timelyExit === 0) {
    return {
      ...baseWithExit,
      status: "pass",
      code: "TOOLCHAIN_INTEGRATION_STEP_PASSED",
    };
  }
  if (timelyExit === BLOCKED_EXIT_CODE) {
    return {
      ...baseWithExit,
      status: "blocked",
      code: "TOOLCHAIN_INTEGRATION_STEP_BLOCKED",
    };
  }
  return {
    ...baseWithExit,
    status: "fail",
    code: "TOOLCHAIN_INTEGRATION_STEP_FAILED",
  };
}

async function runToolchainIntegrationCli(
  argv: readonly string[],
  defaultRoot: string,
  depth: number,
): Promise<number> {
  let options: ToolchainIntegrationOptions;
  try {
    const parsed = parseToolchainIntegrationArguments(argv, defaultRoot);
    if (parsed === "help") {
      process.stdout.write(TOOLCHAIN_INTEGRATION_HELP);
      return 0;
    }
    options = parsed;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (options.list) {
    for (const step of TOOLCHAIN_INTEGRATION_STEPS) {
      emitToolchainIntegration(
        {
          record: "toolchain-integration-plan",
          tool: TOOL,
          package: "asimposium",
          suite: "toolchain-integration",
          step: step.id,
          action: "run",
          command: step.command.join(" "),
          timeout_ms: step.timeoutMs,
          reproduce: step.reproduce,
        },
        options.root,
      );
    }
    return 0;
  }

  // The same recursion refusal `preflight` applies to suite dispatch, transposed for the
  // one path that never routes through it. A bridge at depth d spawns its steps at d + 1,
  // so refusing at MAX_DEPTH stops the chain *before* a step command runs rather than
  // spawning one whose own nested dispatcher would be refused anyway. This is checked
  // after `--list` so the resolved plan stays a pure, side-effect-free projection.
  if (depth >= MAX_DEPTH) {
    emitToolchainIntegration(
      {
        record: "toolchain-integration-summary",
        tool: TOOL,
        package: "asimposium",
        suite: "toolchain-integration",
        version: Bun.version,
        duration_ms: 0,
        status: "fail",
        code: "TOOLCHAIN_INTEGRATION_RECURSION",
        totals: { pass: 0, fail: 0, blocked: 0 },
        reproduce: "bun run toolchain:integration",
        detail:
          `integration bridge nested ${depth} deep; a step command is calling the root ` +
          "dispatcher back. No step was spawned.",
      },
      options.root,
    );
    return 2;
  }

  const startedAt = performance.now();
  const deadline = startedAt + TOOLCHAIN_INTEGRATION_TOTAL_TIMEOUT_MS;
  const totals: Record<ToolchainIntegrationStatus, number> = { pass: 0, fail: 0, blocked: 0 };
  let cleanupOwnershipUnproven = false;

  for (const step of TOOLCHAIN_INTEGRATION_STEPS) {
    const remaining = Math.floor(deadline - performance.now());
    const cleanupReserve =
      TOOLCHAIN_INTEGRATION_TERM_GRACE_MS +
      TOOLCHAIN_INTEGRATION_KILL_REAP_MS +
      OWNED_PROCESS_INSPECTION_TIMEOUT_MS * OWNED_PROCESS_MAX_INSPECTIONS_PER_CLEANUP +
      OWNED_PROCESS_PIPE_DRAIN_MS;
    if (remaining <= cleanupReserve) {
      const record: ToolchainIntegrationStepRecord = {
        record: "toolchain-integration-step",
        tool: TOOL,
        package: "asimposium",
        suite: "toolchain-integration",
        version: Bun.version,
        step: step.id,
        status: "fail",
        code: "TOOLCHAIN_INTEGRATION_GLOBAL_DEADLINE_EXHAUSTED",
        duration_ms: 0,
        timeout_ms: 0,
        reproduce: step.reproduce,
      };
      totals.fail += 1;
      emitToolchainIntegration(record, options.root);
      break;
    }
    const record = await runToolchainIntegrationStep(
      step,
      options.root,
      Math.min(step.timeoutMs, remaining - cleanupReserve),
      depth,
    );
    totals[record.status] += 1;
    emitToolchainIntegration(record, options.root);
    if (
      record.code === "TOOLCHAIN_INTEGRATION_OWNERSHIP_UNPROVEN" ||
      record.code === "TOOLCHAIN_INTEGRATION_INSPECTION_UNPROVEN"
    ) {
      cleanupOwnershipUnproven = true;
      break;
    }
  }

  const status: ToolchainIntegrationStatus =
    totals.fail > 0 ? "fail" : totals.blocked > 0 ? "blocked" : "pass";
  emitToolchainIntegration(
    {
      record: "toolchain-integration-summary",
      tool: TOOL,
      package: "asimposium",
      suite: "toolchain-integration",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status,
      code:
        status === "pass"
          ? "TOOLCHAIN_INTEGRATION_COMPLETE"
          : status === "blocked"
            ? "TOOLCHAIN_INTEGRATION_BLOCKED"
            : "TOOLCHAIN_INTEGRATION_FAILED",
      totals,
      reproduce: "bun run toolchain:integration",
    },
    options.root,
  );
  if (cleanupOwnershipUnproven) return 1;
  return status === "pass" ? 0 : status === "blocked" ? BLOCKED_EXIT_CODE : 1;
}

function parseArguments(argv: string[], defaultRoot: string): Options | "help" {
  const suites: Suite[] = [];
  const filters: string[] = [];
  let root = defaultRoot;
  let json = false;
  let list = false;
  let bail = false;
  let all = false;
  let requireExecuted = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    switch (argument) {
      case "-h":
      case "--help":
        return "help";
      case "--all":
        all = true;
        break;
      case "--json":
        json = true;
        break;
      case "--list":
        list = true;
        break;
      case "--bail":
        bail = true;
        break;
      case "--require-executed":
        requireExecuted = true;
        break;
      case "--filter": {
        const value = argv[++index];
        if (value === undefined) throw new UsageError("MISSING_VALUE", "--filter needs a pattern");
        filters.push(value);
        break;
      }
      case "--root": {
        const value = argv[++index];
        if (value === undefined) throw new UsageError("MISSING_VALUE", "--root needs a directory");
        root = isAbsolute(value) ? value : resolve(process.cwd(), value);
        break;
      }
      default: {
        if (argument.startsWith("-")) {
          throw new UsageError("UNKNOWN_OPTION", `Unknown option "${argument}". Try --help.`);
        }
        if (!isSuite(argument)) {
          throw new UsageError(
            "UNKNOWN_SUITE",
            `Unknown suite "${argument}". Known suites: ${SUITES.join(", ")}.`,
          );
        }
        suites.push(argument);
      }
    }
  }

  const selected = all ? [...SUITES] : orderSuites(suites);
  if (selected.length === 0) {
    throw new UsageError(
      "NO_SUITE_SELECTED",
      `Name at least one suite, or pass --all. Known suites: ${SUITES.join(", ")}.`,
    );
  }

  return {
    suites: selected,
    root: resolve(root),
    json,
    list,
    bail,
    requireExecuted,
    ...(filters.length > 0 ? { filters } : {}),
  } as Options & { filters?: string[] };
}

function matchesFilter(workspace: { name: string; dir: string }, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((pattern) => {
    const expression = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return expression.test(workspace.name) || expression.test(workspace.dir);
  });
}

interface PlannedUnit {
  name: string;
  dir: string;
  version: string;
  script: string | undefined;
  action: "run" | "missing" | "skip";
  code: string;
  detail: string | undefined;
}

function planSuite(suite: Suite, root: string, workspaces: Workspace[]): PlannedUnit[] {
  const units: PlannedUnit[] = [];
  const rootPackage = readRootPackage(root);
  const rootScript = ROOT_UNITS[suite];

  if (rootScript !== undefined) {
    const defined = rootScript in rootPackage.scripts;
    units.push({
      name: rootPackage.name,
      dir: ".",
      version: rootPackage.version,
      script: rootScript,
      action: defined ? "run" : "missing",
      code: defined ? "ROOT_TOOLCHAIN_UNIT" : "MISSING_ROOT_SCRIPT",
      detail: defined
        ? undefined
        : `root package.json must define the "${rootScript}" script for suite "${suite}"`,
    });
  }

  for (const workspace of workspaces) {
    const script = SUITE_SCRIPT[suite];
    if (script in workspace.scripts) {
      units.push({
        name: workspace.name,
        dir: workspace.dir,
        version: workspace.version,
        script,
        action: "run",
        code: "PACKAGE_SCRIPT",
        detail: undefined,
      });
      continue;
    }
    const required = workspace.hasSource && requiredSuitesFor(workspace.dir).includes(suite);
    if (required) {
      units.push({
        name: workspace.name,
        dir: workspace.dir,
        version: workspace.version,
        script,
        action: "missing",
        code: "MISSING_SUITE_SCRIPT",
        detail: `package carries source files and owes suite "${suite}"; add a "${script}" script`,
      });
      continue;
    }
    units.push({
      name: workspace.name,
      dir: workspace.dir,
      version: workspace.version,
      script,
      action: "skip",
      code: workspace.hasSource ? "SUITE_NOT_REQUIRED" : "NO_SOURCE_FILES",
      detail: workspace.hasSource
        ? `suite "${suite}" is not required for this package and no "${script}" script exists`
        : "no source files yet",
    });
  }

  return units;
}

async function runUnit(
  unit: PlannedUnit,
  suite: Suite,
  options: Options,
  depth: number,
): Promise<UnitDiagnostic> {
  const script = unit.script as string;
  const command = `bun run ${script}`;
  const limits = suiteExecutionLimits(suite, unit);
  const timeoutMs = limits.timeoutMs;
  const startedAt = performance.now();
  const result = await runOwnedCommand({
    command: ["bun", "run", script],
    cwd: unit.dir === "." ? options.root : join(options.root, unit.dir),
    env: environmentForSuite(depth),
    timeoutMs,
    retainedStreamBytes: limits.retainedStreamBytes,
    retainedOutputBytes: limits.retainedOutputBytes,
  });
  if (result.stdout.length > 0) {
    // Child output belongs to the package; in --json mode stdout must stay a
    // dispatcher-owned NDJSON stream, so child stdout is faithfully replayed on stderr.
    if (options.json) process.stderr.write(result.stdout);
    else process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) process.stderr.write(result.stderr);

  const durationMs = Math.round(performance.now() - startedAt);
  const exitCode = result.exitCode;
  const signal = result.signal;

  if (result.outcome !== "exited" || exitCode === undefined) {
    const code =
      result.outcome === "timeout"
        ? "SUITE_TIMEOUT"
        : result.outcome === "output-overrun"
          ? "SUITE_OUTPUT_OVERRUN"
          : result.outcome === "descendant-leaked"
            ? "SUITE_DESCENDANT_LEAKED"
            : result.outcome === "pipe-drain-unproven"
              ? "SUITE_PIPE_DRAIN_UNPROVEN"
              : result.outcome === "inspection-unproven"
                ? "SUITE_CLEANUP_INSPECTION_UNPROVEN"
                : result.outcome === "ownership-unproven"
                  ? "SUITE_CLEANUP_OWNERSHIP_UNPROVEN"
                  : "SUITE_SPAWN_FAILED";
    return {
      record: "unit",
      tool: TOOL,
      package: unit.name,
      suite,
      version: Bun.version,
      duration_ms: durationMs,
      status: "fail",
      reproduce: reproduceCommand(unit.dir, script),
      dir: unit.dir,
      code,
      package_version: unit.version,
      script,
      command,
      timeout_ms: timeoutMs,
      retained_stream_limit_bytes: limits.retainedStreamBytes,
      retained_output_limit_bytes: limits.retainedOutputBytes,
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      ...(signal === undefined ? {} : { signal }),
      detail:
        result.outcome === "timeout"
          ? `"${command}" exceeded its ${timeoutMs}ms owned deadline; ` +
            "TERM/KILL/reap was attempted by the dispatcher."
          : result.outcome === "output-overrun"
            ? `"${command}" exceeded the dispatcher's retained-output ceiling; ` +
              (result.cleanupProven === true
                ? "the owned process group was terminated and reaped."
                : "the direct child was stopped, but owned-group cleanup could not be proved.")
            : result.outcome === "descendant-leaked"
              ? `"${command}" exited while a same-session descendant remained; ` +
                "the dispatcher terminated the owned process group."
              : result.outcome === "pipe-drain-unproven"
                ? `"${command}" released its owned session but inherited output pipes remained open.`
                : result.outcome === "inspection-unproven"
                  ? `"${command}" could not complete its bounded owned-group inspection; ` +
                    "the direct supervisor was stopped, but group cleanup could not be proved."
                  : result.outcome === "ownership-unproven"
                    ? `"${command}" lost its owned session identity during ${result.ownershipFailurePhase ?? "an unclassified phase"} before cleanup could be proved.`
                    : `"${command}" could not start the owned session supervisor.`,
    };
  }

  // A signalled child is never "blocked": it did not choose its exit code, so a coincident
  // 78 must not be read as a deliberate refusal.
  const status: UnitStatus =
    exitCode === 0
      ? "pass"
      : signal === undefined && exitCode === BLOCKED_EXIT_CODE
        ? "blocked"
        : "fail";
  const signalSuffix = signal !== undefined ? ` (${signal})` : "";

  return {
    record: "unit",
    tool: TOOL,
    package: unit.name,
    suite,
    version: Bun.version,
    duration_ms: durationMs,
    status,
    reproduce: reproduceCommand(unit.dir, script),
    dir: unit.dir,
    code:
      status === "pass" ? "SUITE_PASSED" : status === "blocked" ? "SUITE_BLOCKED" : "SUITE_FAILED",
    package_version: unit.version,
    script,
    command,
    timeout_ms: timeoutMs,
    retained_stream_limit_bytes: limits.retainedStreamBytes,
    retained_output_limit_bytes: limits.retainedOutputBytes,
    exit_code: exitCode,
    ...(signal !== undefined ? { signal } : {}),
    ...(status === "pass"
      ? {}
      : {
          detail:
            status === "blocked"
              ? `"${command}" exited ${exitCode}: the package reports this gate as deliberately ` +
                "blocked on future work, not as satisfied. Its own output above names the blocker."
              : `"${command}" exited ${exitCode}${signalSuffix}`,
        }),
  };
}

function nonRunDiagnostic(unit: PlannedUnit, suite: Suite): UnitDiagnostic {
  const script = unit.script as string;
  return {
    record: "unit",
    tool: TOOL,
    package: unit.name,
    suite,
    version: Bun.version,
    duration_ms: 0,
    status: unit.action === "missing" ? "missing" : "skip",
    reproduce: reproduceCommand(unit.dir, script),
    dir: unit.dir,
    code: unit.code,
    package_version: unit.version,
    script,
    ...(unit.detail !== undefined ? { detail: unit.detail } : {}),
  };
}

function emit(diagnostic: Diagnostic, options: Options): void {
  if (options.json) {
    process.stdout.write(`${serialize(diagnostic, options.root)}\n`);
    return;
  }
  if (diagnostic.record === "unit") {
    process.stdout.write(`${formatUnitLine(diagnostic, options.root)}\n`);
    if (
      diagnostic.status === "fail" ||
      diagnostic.status === "missing" ||
      diagnostic.status === "blocked"
    ) {
      process.stdout.write(
        `         reproduce: ${redact(diagnostic.reproduce, options.root)}\n` +
          (diagnostic.detail !== undefined
            ? `         detail:    ${redact(diagnostic.detail, options.root)}\n`
            : ""),
      );
    }
    return;
  }
  if (diagnostic.record === "summary") {
    process.stdout.write(`${formatSummaryLine(diagnostic, options.root)}\n`);
    return;
  }
  const plan = diagnostic;
  process.stdout.write(
    redact(
      `  ${plan.action.toUpperCase().padEnd(8)} ${plan.package.padEnd(26)} ` +
        `${(plan.dir === "." ? "./" : `./${plan.dir}`).padEnd(22)} ` +
        `${plan.command ?? plan.detail ?? plan.code}\n`,
      options.root,
    ),
  );
}

function preflight(options: Options, depth: number): UnitDiagnostic {
  const rootPackage = readRootPackage(options.root);
  const pinned = rootPackage.packageManager?.startsWith("bun@")
    ? rootPackage.packageManager.slice("bun@".length)
    : undefined;

  const base: Omit<UnitDiagnostic, "status" | "code" | "detail"> = {
    record: "unit",
    tool: TOOL,
    package: rootPackage.name,
    suite: "preflight",
    version: Bun.version,
    duration_ms: 0,
    reproduce: "bun --version",
    dir: ".",
    package_version: rootPackage.version,
  };

  // One hop, exactly as the integration bridge reasons at MAX_DEPTH: this dispatcher would
  // spawn its root and workspace package scripts at depth + 1. Refusing at *exactly*
  // MAX_DEPTH stops the chain before those side effects run, instead of paying a full round
  // of package spawns and leaving only each child dispatcher to refuse. `--list` is exempt
  // in `main`, which never reaches a spawn, so the resolved plan stays a pure projection.
  if (depth >= MAX_DEPTH) {
    return {
      ...base,
      status: "fail",
      code: "SUITE_RECURSION",
      detail:
        `dispatcher nested ${depth} deep at the ${MAX_DEPTH}-hop limit; a package script is ` +
        "calling the root suite back. No root or workspace package script was spawned.",
    };
  }
  if (pinned === undefined) {
    return {
      ...base,
      status: "fail",
      code: "TOOLCHAIN_NOT_PINNED",
      detail: 'root package.json must pin "packageManager": "bun@<version>"',
    };
  }

  const compare = (left: string, right: string): number => {
    const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const [a, b] = [parse(left), parse(right)];
    for (let index = 0; index < 3; index += 1) {
      const delta = (a[index] ?? 0) - (b[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  };

  const order = compare(Bun.version, pinned);
  if (order < 0) {
    return {
      ...base,
      status: "fail",
      code: "BUN_VERSION_TOO_OLD",
      detail: `bun ${Bun.version} is older than the pinned bun@${pinned}; upgrade before running gates`,
    };
  }
  return {
    ...base,
    status: "pass",
    code: order === 0 ? "TOOLCHAIN_PINNED" : "BUN_VERSION_NEWER_THAN_PIN",
    ...(order === 0 ? {} : { detail: `bun ${Bun.version} is newer than the pinned bun@${pinned}` }),
  };
}

async function main(argv: string[]): Promise<number> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const defaultRoot = resolve(here, "..", "..");

  let options: Options & { filters?: string[] };
  try {
    const parsed = parseArguments(argv, defaultRoot);
    if (parsed === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    options = parsed as Options & { filters?: string[] };
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const filters = options.filters ?? [];
  const depth = dispatcherDepth();

  let workspaces: Workspace[];
  let preflightDiagnostic: UnitDiagnostic;
  try {
    preflightDiagnostic = preflight(options, depth);
    workspaces = discoverWorkspaces(options.root).filter((workspace) =>
      matchesFilter(workspace, filters),
    );
  } catch (error) {
    const code = error instanceof DiscoveryError ? error.code : "DISCOVERY_FAILED";
    const message = error instanceof Error ? error.message : "unknown discovery failure";
    process.stderr.write(`${code}: ${redact(message, options.root)}\n`);
    return 2;
  }

  if (!options.list) {
    emit(preflightDiagnostic, options);
    if (preflightDiagnostic.status === "fail") return 2;
  }

  if (!options.json && !options.list) {
    process.stdout.write(
      `asimposium suite · root ${displayPath(options.root, options.root)} · ` +
        `${TOOL} ${Bun.version} · ${workspaces.length} workspace package(s)\n`,
    );
  }

  let failed = false;
  let blocked = false;

  for (const suite of options.suites) {
    const planned = planSuite(suite, options.root, workspaces).filter((unit) =>
      matchesFilter(unit, filters),
    );

    if (options.list) {
      for (const unit of planned) {
        const limits = suiteExecutionLimits(suite, unit);
        const plan: PlanDiagnostic = {
          record: "plan",
          suite,
          package: unit.name,
          dir: unit.dir,
          action: unit.action,
          code: unit.code,
          ...(unit.script !== undefined ? { script: unit.script } : {}),
          ...(unit.action === "run" && unit.script !== undefined
            ? {
                command: `bun run ${unit.script}`,
                reproduce: reproduceCommand(unit.dir, unit.script),
                timeout_ms: limits.timeoutMs,
                retained_stream_limit_bytes: limits.retainedStreamBytes,
                retained_output_limit_bytes: limits.retainedOutputBytes,
              }
            : {}),
          ...(unit.detail !== undefined ? { detail: unit.detail } : {}),
        };
        emit(plan, options);
      }
      continue;
    }

    if (!options.json) process.stdout.write(`suite ${suite}\n`);

    const totals = {
      total: planned.length,
      executed: 0,
      pass: 0,
      fail: 0,
      blocked: 0,
      missing: 0,
      skip: 0,
    };
    const suiteStartedAt = performance.now();
    let bailed = false;

    for (const unit of planned) {
      if (bailed) break;
      let diagnostic: UnitDiagnostic;
      if (unit.action === "run") {
        diagnostic = await runUnit(unit, suite, options, depth);
        totals.executed += 1;
      } else {
        diagnostic = nonRunDiagnostic(unit, suite);
      }
      totals[diagnostic.status] += 1;
      emit(diagnostic, options);
      if (diagnostic.status === "fail" || diagnostic.status === "missing") {
        failed = true;
        if (options.bail) bailed = true;
      } else if (diagnostic.status === "blocked") {
        // Not a failure, so `--bail` does not stop the run: the point of a blocked unit is
        // that the rest of the suite still has something to say.
        blocked = true;
      }
    }

    // A suite that executed nothing has proved nothing, so it is never "pass". This is the
    // one shape of green the dispatcher must never manufacture (Fable §17.0): a required
    // gate reporting success on a run in which no unit was ever spawned. It fails closed by
    // default rather than only under an opt-in flag, because the entry points that most
    // need the check -- `bun run test:security`, `test:contract`, `test:integration` -- are
    // exactly the ones that never passed --require-executed.
    const emptyRun = totals.executed === 0;
    if (emptyRun) failed = true;
    const genuinelyFailed = totals.fail + totals.missing > 0 || emptyRun;

    const summary: SummaryDiagnostic = {
      record: "summary",
      tool: TOOL,
      package: "asimposium",
      suite,
      version: Bun.version,
      duration_ms: Math.round(performance.now() - suiteStartedAt),
      status: genuinelyFailed ? "fail" : totals.blocked > 0 ? "blocked" : "pass",
      reproduce: `bun run suite ${suite}`,
      // A real fail or a missing required script keeps SUITE_INCOMPLETE: it is the more
      // specific diagnosis, and an all-missing suite also executes zero units.
      code:
        totals.fail + totals.missing > 0
          ? "SUITE_INCOMPLETE"
          : emptyRun
            ? "NO_UNITS_EXECUTED"
            : totals.blocked > 0
              ? "SUITE_BLOCKED"
              : "SUITE_COMPLETE",
      totals,
      ...(emptyRun
        ? {
            detail:
              `suite "${suite}" executed no units; a suite that ran nothing is never a pass. ` +
              "Define the suite's script in a package, or narrow the selection to suites that exist.",
          }
        : {}),
    };
    emit(summary, options);

    if (bailed) break;
  }

  // A genuine failure outranks a blocker: exit 1 still means "something is broken". A run
  // whose only non-passing units are blocked exits BLOCKED_EXIT_CODE — non-zero, never
  // green, and distinguishable by a CI consumer without parsing prose.
  return failed ? 1 : blocked ? BLOCKED_EXIT_CODE : 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const here = fileURLToPath(new URL(".", import.meta.url));
  const defaultRoot = resolve(here, "..", "..");
  const exitCode = argv.includes("--toolchain-integration")
    ? await runToolchainIntegrationCli(argv, defaultRoot, dispatcherDepth())
    : await main(argv);
  process.exit(exitCode);
}
