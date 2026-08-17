import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { S2_COST_RECEIPT_BINDINGS_KEYS, S2_COST_RECEIPT_ROOT_KEYS } from "@asimposium/contracts";

import {
  buildS2CostMeasurementReceipt,
  parseS2EventPageResult,
  parseS2StateResult,
  parseS2WriteResult,
  S2_COST_RECEIPT_RELATIVE_PATH,
  type S2CostReceiptProvenance,
  type S2SettledWriteResult,
  writeS2CostMeasurementReceipt,
} from "../../src/krater/s2-client.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = "scripts/e2e-s2-krater.sh";

/**
 * The declared source list, read out of the harness itself.
 *
 * Tests that assert on closure must read the same array the script hashes, not
 * a copy: a second list here would drift from the first and quietly stop
 * proving anything.
 */
function declaredSourcePaths(): string[] {
  const script = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
  const block = /^readonly -a S2_SOURCE_PATHS=\(\n([\s\S]*?)^\)$/m.exec(script);
  const body = block?.[1];
  if (body === undefined) throw new Error("S2_SOURCE_PATHS array not found in the harness");
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The expected migration journal, likewise read from the harness. */
function declaredMigrationJournal(): string[] {
  const script = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
  const block = /^readonly -a S2_EXPECTED_MIGRATION_JOURNAL=\(\n([\s\S]*?)^\)$/m.exec(script);
  const body = block?.[1];
  if (body === undefined) throw new Error("S2_EXPECTED_MIGRATION_JOURNAL array not found");
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}
const REAL_BINDING_INTEGRATION = resolve(
  REPOSITORY_ROOT,
  "apps/wire/test/integration/s2-krater-real-bindings.test.ts",
);
const S2_SHELL_REGRESSION_WATCHDOG_MS = 90_000;
const S2_SHELL_REGRESSION_TEST_TIMEOUT_MS = 120_000;
const CONCURRENT_CONTROLLER_SETUP_MS = 5_000;
const CONCURRENT_PROCESS_GROUP_GRACE_MS = 2_000;
const CONCURRENT_CAPTURE_TEST_TIMEOUT_MS = 25_000;
const EXIT_RACE_LOAD_BARRIER_WAIT_MS = 10_000;
const LEGACY_POSTCONDITION_LOAD_BARRIER_WAIT_MS = 20_000;
const CONCURRENT_LEGACY_TEST_TIMEOUT_MS =
  CONCURRENT_CONTROLLER_SETUP_MS +
  S2_SHELL_REGRESSION_WATCHDOG_MS +
  CONCURRENT_PROCESS_GROUP_GRACE_MS +
  1_000 + // controller's bounded post-KILL group-settle check
  5_000 + // one shared retained process-table capture
  10_000; // assertion and scheduler margin
const CONCURRENT_PROCESS_GROUP_RUNNER = String.raw`
  use strict;
  use warnings;
  use Fcntl qw(F_GETFL F_SETFL O_CREAT O_EXCL O_NONBLOCK O_WRONLY);
  use POSIX qw(setsid WNOHANG);
  my $grace_ms = shift @ARGV;
  my $pre_setsid_delay_ms = shift @ARGV;
  my $controller_ready_path = shift @ARGV;
  my $stdout_path = shift @ARGV;
  my $stderr_path = shift @ARGV;
  open STDOUT, ">>", $stdout_path or exit 125;
  open STDERR, ">>", $stderr_path or exit 125;
  select STDERR; $| = 1;
  select STDOUT; $| = 1;
  pipe(my $ready_reader, my $ready_writer) or exit 125;
  pipe(my $go_reader, my $go_writer) or exit 125;
  my $ready_flags = fcntl($ready_reader, F_GETFL, 0);
  defined $ready_flags or exit 125;
  fcntl($ready_reader, F_SETFL, $ready_flags | O_NONBLOCK) or exit 125;
  my $deadline = 0;
  $SIG{TERM} = sub { $deadline = 1; };
  sysopen(my $controller_ready, $controller_ready_path, O_WRONLY | O_CREAT | O_EXCL, 0600)
    or exit 125;
  syswrite($controller_ready, "R", 1) == 1 or exit 125;
  close $controller_ready or exit 125;
  my $child = fork();
  defined $child or exit 125;
  if ($child == 0) {
    close $ready_reader;
    close $go_writer;
    $SIG{TERM} = "DEFAULT";
    $SIG{HUP} = "DEFAULT";
    $SIG{INT} = "DEFAULT";
    select undef, undef, undef, $pre_setsid_delay_ms / 1000 if $pre_setsid_delay_ms > 0;
    setsid() or exit 125;
    getpgrp(0) == $$ or exit 125;
    syswrite($ready_writer, "R", 1) == 1 or exit 125;
    close $ready_writer or exit 125;
    my $go = "";
    sysread($go_reader, $go, 1) == 1 && $go eq "G" or exit 125;
    close $go_reader or exit 125;
    exec @ARGV;
    exit 125;
  }
  close $ready_writer;
  close $go_reader;
  my $group_ready = 0;
  my $go_sent = 0;
  while (1) {
    if (!$group_ready) {
      my $ready = "";
      my $ready_bytes = sysread($ready_reader, $ready, 1);
      if (defined $ready_bytes && $ready_bytes == 1) {
        $ready eq "R" or exit 125;
        $group_ready = 1;
        close $ready_reader or exit 125;
      }
    }
    if ($group_ready && !$go_sent && !$deadline) {
      syswrite($go_writer, "G", 1) == 1 or exit 125;
      close $go_writer or exit 125;
      $go_sent = 1;
    }
    if ($deadline) {
      close $go_writer unless $go_sent;
      my $action;
      if ($group_ready) {
        kill "TERM", -$child;
        $action = "term-then-kill-exact-child-group";
      } else {
        kill "TERM", $child;
        $action = "term-then-kill-exact-child-before-group";
      }
      my $step = ($grace_ms / 1000) / 20;
      for (1 .. 20) { select undef, undef, undef, $step; }
      if ($group_ready) {
        kill "KILL", -$child if kill 0, -$child;
      } else {
        kill "KILL", $child if kill 0, $child;
      }
      waitpid($child, 0);
      if ($group_ready) {
        for (1 .. 20) {
          last unless kill 0, -$child;
          select undef, undef, undef, 0.05;
        }
        if (kill 0, -$child) {
          print STDERR qq({"suite":"s2-concurrent-supervisor","status":"fail","code":"S2_CAPTURE_CLEANUP_INCOMPLETE"}\n);
          exit 125;
        }
      }
      print STDERR qq({"suite":"s2-concurrent-supervisor","status":"fail","code":"S2_CAPTURE_DEADLINE_EXCEEDED","action":"$action"}\n);
      exit 124;
    }
    my $reaped = waitpid($child, WNOHANG);
    if ($reaped == $child) {
      my $status = $?;
      exit(128 + ($status & 127)) if ($status & 127);
      exit($status >> 8);
    }
    select undef, undef, undef, 0.01;
  }
`;

const COST_PROVENANCE: S2CostReceiptProvenance = {
  run_id: "s2-cost-producer",
  revision: "a".repeat(40),
  dirty_state: "clean",
  source_digest: "b".repeat(64),
};

const COST_WRITES: readonly S2SettledWriteResult[] = [
  {
    event_id: "E-s2-001",
    seq: 1,
    idempotent: false,
    pre_cursor: 0,
    post_cursor: 1,
    payload_sha256: "1".repeat(64),
    row_digest: "2".repeat(64),
    build_digest: "3".repeat(64),
    chain_digest: "4".repeat(64),
    checkpoint_digest: "5".repeat(64),
    write_phase_ms: 1,
    successful_batch_rows_read: 3,
    successful_batch_rows_written: 2,
    successful_batch_sql_ms: 1,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    preflight_rows_read: 4,
    preflight_rows_written: 0,
    preflight_sql_ms: 1,
    preflight_wall_ms: 10,
    preflight_statements: 3,
    preflight_fast_path: true,
    write_claim_wall_ms: 100,
    write_claim_wall_scope: "writeClaim-entry-to-return",
    lock_wait_ms: null,
    retry_count: 0,
    outbox_handoff: "armed",
  },
  {
    event_id: "E-s2-002",
    seq: 2,
    idempotent: false,
    pre_cursor: 1,
    post_cursor: 2,
    payload_sha256: "6".repeat(64),
    row_digest: "7".repeat(64),
    build_digest: "8".repeat(64),
    chain_digest: "9".repeat(64),
    checkpoint_digest: "a".repeat(64),
    write_phase_ms: 20,
    successful_batch_rows_read: 5,
    successful_batch_rows_written: 4,
    successful_batch_sql_ms: 2,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    preflight_rows_read: 6,
    preflight_rows_written: 1,
    preflight_sql_ms: 2,
    preflight_wall_ms: 5,
    preflight_statements: 4,
    preflight_fast_path: true,
    write_claim_wall_ms: 110,
    write_claim_wall_scope: "writeClaim-entry-to-return",
    lock_wait_ms: null,
    retry_count: 1,
    outbox_handoff: "armed",
  },
  {
    event_id: "E-s2-003",
    seq: 3,
    idempotent: false,
    pre_cursor: 2,
    post_cursor: 3,
    payload_sha256: "b".repeat(64),
    row_digest: "c".repeat(64),
    build_digest: "d".repeat(64),
    chain_digest: "e".repeat(64),
    checkpoint_digest: "f".repeat(64),
    write_phase_ms: 9,
    successful_batch_rows_read: 7,
    successful_batch_rows_written: 6,
    successful_batch_sql_ms: 3,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    preflight_rows_read: 8,
    preflight_rows_written: 0,
    preflight_sql_ms: 3,
    preflight_wall_ms: 7,
    preflight_statements: 5,
    preflight_fast_path: true,
    write_claim_wall_ms: 90,
    write_claim_wall_scope: "writeClaim-entry-to-return",
    lock_wait_ms: null,
    retry_count: 2,
    outbox_handoff: "armed",
  },
];

const FIRST_COST_WRITE = COST_WRITES[0];
if (FIRST_COST_WRITE === undefined) {
  throw new Error("S2 cost fixture must contain at least one settled write");
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  retainedLogs: string;
}

function ndjsonRecords(run: Run): Array<Record<string, unknown>> {
  return run.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function typedDiagnosticCodes(run: Run): string[] {
  return Array.from(
    `${run.stdout}\n${run.stderr}`.matchAll(/"code":"([A-Z][A-Z0-9_]{2,95})"/g),
    (match) => match[1] ?? "",
  )
    .filter((code, index, values) => code !== "" && values.indexOf(code) === index)
    .slice(0, 4);
}

function runCaptured(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deadlineMs: number,
): Run {
  const logRoot = mkdtempSync(join(tmpdir(), "asimposium-s2-shell-"));
  const stdoutPath = join(logRoot, "stdout.log");
  const stderrPath = join(logRoot, "stderr.log");
  closeSync(openSync(stdoutPath, "wx", 0o600));
  closeSync(openSync(stderrPath, "wx", 0o600));
  const child = spawnSync(
    "perl",
    [
      "-MPOSIX=setsid",
      "-e",
      "setsid() or exit 125; exec @ARGV",
      "--",
      "bash",
      "-c",
      'stdout_path="$1"; stderr_path="$2"; shift 2; exec "$@" >>"$stdout_path" 2>>"$stderr_path"',
      "s2-retained-log-runner",
      stdoutPath,
      stderrPath,
      command,
      ...args,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ...env },
      timeout: deadlineMs,
      // The planted lifecycle modes deliberately signal owned process groups.
      // The Perl wrapper performs the observable setsid(2) before Bash runs,
      // so a regression cannot signal Bun's test runner (or the invoking
      // shell) before it can report the exact terminal record.
    },
  );
  const errorCode =
    child.error === undefined || !("code" in child.error) ? undefined : child.error.code;
  const errorDetail = child.error === undefined ? "" : ` spawn_error=${child.error.message}`;
  const signalDetail = child.signal === null ? "" : ` terminated_by=${child.signal}`;
  return {
    exitCode: child.status ?? (errorCode === "ETIMEDOUT" ? 124 : 125),
    stdout: readFileSync(stdoutPath, "utf8"),
    stderr: `${readFileSync(stderrPath, "utf8")}${signalDetail}${errorDetail} retained_logs=${logRoot}`,
    retainedLogs: logRoot,
  };
}

function runCapturedConcurrently(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deadlineMs: number,
  preSetsidDelayMs = 0,
): Promise<Run> {
  if (!Number.isInteger(preSetsidDelayMs) || preSetsidDelayMs < 0) {
    throw new Error("concurrent capture pre-setsid delay must be a non-negative integer");
  }
  const logRoot = mkdtempSync(join(tmpdir(), "asimposium-s2-shell-concurrent-"));
  const stdoutPath = join(logRoot, "stdout.log");
  const stderrPath = join(logRoot, "stderr.log");
  const controllerReadyPath = join(logRoot, "controller.ready");
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    stdoutFd = openSync(stdoutPath, "wx", 0o600);
    stderrFd = openSync(stderrPath, "wx", 0o600);
    closeSync(stdoutFd);
    stdoutFd = undefined;
    closeSync(stderrFd);
    stderrFd = undefined;
    child = spawn(
      "perl",
      [
        "-e",
        CONCURRENT_PROCESS_GROUP_RUNNER,
        "--",
        String(CONCURRENT_PROCESS_GROUP_GRACE_MS),
        String(preSetsidDelayMs),
        controllerReadyPath,
        stdoutPath,
        stderrPath,
        command,
        ...args,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, ...env },
        stdio: "ignore",
      },
    );
  } catch (error) {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    const detail = error instanceof Error ? error.message : String(error);
    return Promise.resolve({
      exitCode: 125,
      stdout: existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
      stderr: `${existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : ""} spawn_error=${detail} retained_logs=${logRoot}`,
      retainedLogs: logRoot,
    });
  }
  return new Promise((resolveRun) => {
    let childError: Error | undefined;
    let deadlineTriggered = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let readinessPoll: ReturnType<typeof setInterval> | undefined;
    let setupDeadline: ReturnType<typeof setTimeout> | undefined;
    const controllerIsReady = () => {
      try {
        return readFileSync(controllerReadyPath, "utf8") === "R";
      } catch {
        return false;
      }
    };
    const armDeadline = () => {
      if (deadline !== undefined) return;
      if (readinessPoll !== undefined) clearInterval(readinessPoll);
      if (setupDeadline !== undefined) clearTimeout(setupDeadline);
      deadline = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        deadlineTriggered = true;
        child.kill("SIGTERM");
      }, deadlineMs);
    };
    readinessPoll = setInterval(() => {
      if (controllerIsReady()) armDeadline();
    }, 10);
    setupDeadline = setTimeout(() => {
      if (controllerIsReady()) {
        armDeadline();
        return;
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CONCURRENT_CONTROLLER_SETUP_MS);
    child.once("error", (error) => {
      childError = error;
    });
    child.once("close", (status, signal) => {
      if (deadline !== undefined) clearTimeout(deadline);
      if (readinessPoll !== undefined) clearInterval(readinessPoll);
      if (setupDeadline !== undefined) clearTimeout(setupDeadline);
      const errorCode =
        childError === undefined || !("code" in childError) ? undefined : childError.code;
      const errorDetail = childError === undefined ? "" : ` spawn_error=${childError.message}`;
      const signalDetail = signal === null ? "" : ` terminated_by=${signal}`;
      resolveRun({
        exitCode:
          deadlineTriggered && status === 124
            ? 124
            : (status ?? (errorCode === "ETIMEDOUT" ? 124 : 125)),
        stdout: readFileSync(stdoutPath, "utf8"),
        stderr: `${readFileSync(stderrPath, "utf8")}${signalDetail}${errorDetail} retained_logs=${logRoot}`,
        retainedLogs: logRoot,
      });
    });
  });
}

async function runHarness(env: Record<string, string>, deadlineMs: number): Promise<Run> {
  return runCaptured("bash", [SCRIPT], env, deadlineMs);
}

function runHarnessConcurrently(env: Record<string, string>, deadlineMs: number): Promise<Run> {
  return runCapturedConcurrently("bash", [SCRIPT], env, deadlineMs);
}

interface ExitRaceLoadReadyRecord {
  readonly controllerPid: number;
  readonly parentPid: number;
  readonly token: string;
  readonly size: number;
}

function readExitRaceLoadReadyRecord(
  barrierRoot: string,
  token: string,
  size: number,
): ExitRaceLoadReadyRecord | undefined {
  const readyPath = join(barrierRoot, `${token}.ready`);
  if (!existsSync(readyPath)) return undefined;
  const readyStat = lstatSync(readyPath);
  if (!readyStat.isFile() || readyStat.isSymbolicLink()) {
    throw new Error(`exit-race load ready path is not a regular file: ${token}`);
  }
  const match =
    /^exit-race-load-request-observed ([1-9][0-9]*) ([1-9][0-9]*) ([A-Za-z0-9][A-Za-z0-9._-]{0,79}) ([1-9][0-9]?)\n$/u.exec(
      readFileSync(readyPath, "utf8"),
    );
  const controllerPid = Number(match?.[1]);
  const parentPid = Number(match?.[2]);
  const observedToken = match?.[3];
  const observedSize = Number(match?.[4]);
  if (
    match === null ||
    !Number.isSafeInteger(controllerPid) ||
    controllerPid <= 0 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    observedToken !== token ||
    observedSize !== size
  ) {
    throw new Error(`exit-race load ready record is malformed: ${token}`);
  }
  return { controllerPid, parentPid, token: observedToken, size: observedSize };
}

async function waitForExitRaceLoadReadyRecords(
  barrierRoot: string,
  tokens: readonly string[],
  deadlineMs: number,
): Promise<ExitRaceLoadReadyRecord[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const records = tokens.map((token) =>
      readExitRaceLoadReadyRecord(barrierRoot, token, tokens.length),
    );
    if (records.every((record): record is ExitRaceLoadReadyRecord => record !== undefined)) {
      return records;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  const visibleTokens = tokens.filter(
    (token) => readExitRaceLoadReadyRecord(barrierRoot, token, tokens.length) !== undefined,
  );
  throw new Error(
    `exit-race load barrier timed out: ready=${visibleTokens.length}/${tokens.length}; ` +
      `tokens=${visibleTokens.join(",") || "none"}`,
  );
}

interface LegacyPostconditionLoadReadyRecord {
  readonly controllerPid: number;
  readonly parentPid: number;
  readonly residualPgid: number;
  readonly token: string;
  readonly size: number;
}

function readLegacyPostconditionLoadReadyRecord(
  barrierRoot: string,
  token: string,
  size: number,
): LegacyPostconditionLoadReadyRecord | undefined {
  const readyPath = join(barrierRoot, `${token}.ready`);
  if (!existsSync(readyPath)) return undefined;
  const readyStat = lstatSync(readyPath);
  if (!readyStat.isFile() || readyStat.isSymbolicLink()) {
    throw new Error(`legacy postcondition ready path is not a regular file: ${token}`);
  }
  const match =
    /^legacy-postcondition-ready ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([A-Za-z0-9][A-Za-z0-9._-]{0,79}) ([1-9][0-9]?)\n$/u.exec(
      readFileSync(readyPath, "utf8"),
    );
  const controllerPid = Number(match?.[1]);
  const parentPid = Number(match?.[2]);
  const residualPgid = Number(match?.[3]);
  const observedToken = match?.[4];
  const observedSize = Number(match?.[5]);
  if (
    match === null ||
    !Number.isSafeInteger(controllerPid) ||
    controllerPid <= 0 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    !Number.isSafeInteger(residualPgid) ||
    residualPgid <= 0 ||
    observedToken !== token ||
    observedSize !== size
  ) {
    throw new Error(`legacy postcondition ready record is malformed: ${token}`);
  }
  return {
    controllerPid,
    parentPid,
    residualPgid,
    token: observedToken,
    size: observedSize,
  };
}

async function waitForLegacyPostconditionLoadReadyRecords(
  barrierRoot: string,
  tokens: readonly string[],
  deadlineMs: number,
): Promise<LegacyPostconditionLoadReadyRecord[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const records = tokens.map((token) =>
      readLegacyPostconditionLoadReadyRecord(barrierRoot, token, tokens.length),
    );
    if (
      records.every((record): record is LegacyPostconditionLoadReadyRecord => record !== undefined)
    ) {
      return records;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  const visibleTokens = tokens.filter(
    (token) =>
      readLegacyPostconditionLoadReadyRecord(barrierRoot, token, tokens.length) !== undefined,
  );
  throw new Error(
    `legacy postcondition load barrier timed out: ready=${visibleTokens.length}/${tokens.length}; ` +
      `tokens=${visibleTokens.join(",") || "none"}`,
  );
}

/**
 * The fast shell matrix needs byte-complete terminal records from each short
 * child. Bun's asynchronous pipe wrapper has intermittently returned two empty
 * strings for a zero-exit child under `bun test`; the synchronous subprocess
 * API waits for the process as one bounded operation while the shell writes to
 * private retained logs. This keeps a byte-complete detailed failure record
 * even when the test runner discards the child's in-memory pipes.
 */
function runHarnessSync(env: Record<string, string>, deadlineMs: number): Run {
  return runCaptured("bash", [SCRIPT], env, deadlineMs);
}

interface ProcessTableCapture {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly stdout: string;
}

interface S2LifecycleProcessRow {
  readonly pid: number;
  readonly pgid: number;
  readonly parentPid: number;
  readonly status: string;
  readonly command: string;
  readonly identity: string;
}

function parseS2LifecycleProcessRows(snapshot: ProcessTableCapture): S2LifecycleProcessRow[] {
  const errorCode =
    snapshot.error !== undefined &&
    "code" in snapshot.error &&
    typeof snapshot.error.code === "string"
      ? snapshot.error.code
      : "none";
  if (snapshot.error !== undefined || snapshot.signal !== null || snapshot.status !== 0) {
    throw new Error(
      `S2 lifecycle process scan failed: status=${snapshot.status ?? "null"} signal=${snapshot.signal ?? "none"} code=${errorCode}`,
    );
  }
  const lines = snapshot.stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("S2 lifecycle process scan failed: process-table output empty");
  }
  return lines.map((line) => {
    const [pidText, pgidText, parentPidText, status, ...commandParts] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const pgid = Number(pgidText);
    const parentPid = Number(parentPidText);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(pgid) ||
      pgid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      status === undefined ||
      status === "" ||
      commandParts.length === 0
    ) {
      throw new Error("S2 lifecycle process scan failed: malformed process-table row");
    }
    return {
      pid,
      pgid,
      parentPid,
      status,
      command: commandParts.join(" "),
      identity: `${pid} ${pgid} ${parentPid} ${status}`,
    };
  });
}

function parseS2LifecycleProcessTable(runId: string, snapshot: ProcessTableCapture): string[] {
  // Command text proves ownership but can also contain caller-supplied arguments.
  // Return only the non-sensitive process identity fields used in diagnostics.
  return parseS2LifecycleProcessRows(snapshot)
    .filter((row) => row.command.includes(`e2e/artifacts/s2-krater/${runId}/`))
    .map((row) => row.identity);
}

function captureS2LifecycleProcessTable(): ProcessTableCapture {
  // Bun can report a zero-exit synchronous child with empty in-memory pipes.
  // The same retained-log wrapper used for the lifecycle run makes the scan's
  // output byte-complete before it is interpreted as zero survivors.
  const scan = runCaptured("/bin/ps", ["-axo", "pid=,pgid=,ppid=,stat=,command="], {}, 5_000);
  return {
    status: scan.exitCode,
    signal: null,
    stdout: scan.stdout,
  };
}

function liveS2LifecycleProcesses(runId: string): string[] {
  return parseS2LifecycleProcessTable(runId, captureS2LifecycleProcessTable());
}

interface RetainedPostReleaseControllerOwner {
  readonly controllerPid: number;
  readonly parentPid: number;
  readonly childRunId: string;
  readonly marker: string;
}

interface RetainedPostReleaseControllerOwners {
  readonly owners: RetainedPostReleaseControllerOwner[];
  readonly failures: Error[];
}

function collectRetainedPostReleaseControllerOwners(
  runId: string,
): RetainedPostReleaseControllerOwners {
  const main = resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "main");
  const owners: RetainedPostReleaseControllerOwner[] = [];
  const failures: Error[] = [];
  let ownerNames: string[] = [];
  try {
    const mainStat = lstatSync(main);
    if (!mainStat.isDirectory() || mainStat.isSymbolicLink()) {
      throw new Error(`retained controller state is not a regular directory: ${runId}`);
    }
    ownerNames = readdirSync(main)
      .filter((name) => name.endsWith(".status.controller-owner"))
      .sort();
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }
  for (const name of ownerNames) {
    try {
      const ownerPath = resolve(main, name);
      const ownerStat = lstatSync(ownerPath);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
        throw new Error(`retained controller owner is not a regular file: ${runId}/${name}`);
      }
      const match =
        /^controller-owner ([1-9][0-9]*) ([1-9][0-9]*) (s2-post-release-controller-(s2u-[a-f0-9]{48}))\n$/u.exec(
          readFileSync(ownerPath, "utf8"),
        );
      const controllerPid = Number(match?.[1]);
      const parentPid = Number(match?.[2]);
      const marker = match?.[3];
      const childRunId = match?.[4];
      if (
        match === null ||
        !Number.isSafeInteger(controllerPid) ||
        controllerPid <= 0 ||
        !Number.isSafeInteger(parentPid) ||
        parentPid <= 0 ||
        marker === undefined ||
        childRunId === undefined
      ) {
        throw new Error(`malformed retained controller owner record: ${runId}/${name}`);
      }
      owners.push({ controllerPid, parentPid, childRunId, marker });
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return { owners, failures };
}

function retainedPostReleaseControllerRunIds(runId: string): string[] {
  const retained = collectRetainedPostReleaseControllerOwners(runId);
  if (retained.failures.length !== 0) {
    throw new AggregateError(
      retained.failures,
      `retained controller owner parsing failed: ${runId}`,
    );
  }
  return retained.owners.map((owner) => owner.childRunId);
}

interface S2LifecycleProcessSelector {
  readonly label: string;
  readonly matches: (row: S2LifecycleProcessRow) => boolean;
}

function s2FixtureSurvivorSelectors(
  runId: string,
  owners: readonly RetainedPostReleaseControllerOwner[],
  ready: ExitRaceLoadReadyRecord | undefined,
): S2LifecycleProcessSelector[] {
  const selectors: S2LifecycleProcessSelector[] = [
    {
      label: `parent-run:${runId}`,
      matches: (row) => row.command.includes(`e2e/artifacts/s2-krater/${runId}/`),
    },
  ];
  for (const owner of owners) {
    selectors.push(
      {
        label: `child-run:${owner.childRunId}`,
        matches: (row) => row.command.includes(`e2e/artifacts/s2-krater/${owner.childRunId}/`),
      },
      {
        label: `controller-marker:${owner.marker}`,
        matches: (row) => row.command.includes(owner.marker),
      },
      {
        label: `controller-pid:${owner.controllerPid}`,
        matches: (row) => row.pid === owner.controllerPid,
      },
    );
  }
  if (ready !== undefined) {
    selectors.push(
      {
        label: `ready-controller-pid:${ready.controllerPid}`,
        matches: (row) => row.pid === ready.controllerPid,
      },
      {
        label: `ready-parent-pid:${ready.parentPid}`,
        matches: (row) => row.pid === ready.parentPid,
      },
    );
  }
  return selectors;
}

function matchS2FixtureSurvivors(
  rows: readonly S2LifecycleProcessRow[],
  selectors: readonly S2LifecycleProcessSelector[],
): string[] {
  return Array.from(
    new Set(
      selectors.flatMap((selector) =>
        rows
          .filter((row) => selector.matches(row))
          .map((row) => `${selector.label}=${row.identity}`),
      ),
    ),
  );
}

function scanS2FixtureAndRetainedControllersForSurvivors(
  runId: string,
  sharedRows: readonly S2LifecycleProcessRow[],
  ready: ExitRaceLoadReadyRecord | undefined,
  sharedSnapshotFailure?: Error,
): string[] {
  const retained = collectRetainedPostReleaseControllerOwners(runId);
  const failures = [...retained.failures];
  if (retained.owners.length !== 1) {
    failures.push(
      new Error(
        `expected one retained controller owner record: run_id=${runId} observed=${retained.owners.length}`,
      ),
    );
  }

  const survivors =
    sharedSnapshotFailure === undefined
      ? matchS2FixtureSurvivors(
          sharedRows,
          s2FixtureSurvivorSelectors(runId, retained.owners, ready),
        )
      : [];
  if (sharedSnapshotFailure !== undefined) failures.push(sharedSnapshotFailure);
  if (failures.length !== 0) {
    if (survivors.length !== 0) {
      failures.push(new Error(`S2 shell regression left survivors: ${survivors.join(" | ")}`));
    }
    throw new AggregateError(
      failures,
      `retained controller survivor proof failed: run_id=${runId}; ` +
        `survivors=${survivors.join(" | ") || "none"}`,
    );
  }
  return survivors;
}

function assertRetainedControllerOwnerMatchesReadyRecord(
  runId: string,
  ready: ExitRaceLoadReadyRecord | undefined,
): void {
  const retained = collectRetainedPostReleaseControllerOwners(runId);
  const failures = [...retained.failures];
  if (ready === undefined) {
    failures.push(new Error(`exit-race ready record missing: run_id=${runId}`));
  }
  if (retained.owners.length !== 1) {
    failures.push(
      new Error(
        `expected one retained controller owner record: run_id=${runId} observed=${retained.owners.length}`,
      ),
    );
  }
  const owner = retained.owners[0];
  if (owner !== undefined && ready !== undefined) {
    if (owner.controllerPid !== ready.controllerPid) {
      failures.push(
        new Error(
          `retained controller PID differs from ready record: run_id=${runId} ` +
            `owner=${owner.controllerPid} ready=${ready.controllerPid}`,
        ),
      );
    }
    if (owner.parentPid !== ready.parentPid) {
      failures.push(
        new Error(
          `retained parent PID differs from ready record: run_id=${runId} ` +
            `owner=${owner.parentPid} ready=${ready.parentPid}`,
        ),
      );
    }
  }
  if (failures.length !== 0) {
    throw new AggregateError(failures, `retained controller owner binding failed: ${runId}`);
  }
}

function liveProcessesContainingMarker(marker: string): string[] {
  const scan = runCaptured("/bin/ps", ["-axo", "pid=,pgid=,ppid=,stat=,command="], {}, 5_000);
  const rows = parseS2LifecycleProcessTable("marker-scan-never-matches-a-path", {
    status: scan.exitCode,
    signal: null,
    stdout: scan.stdout,
  });
  if (rows.length !== 0) throw new Error("generic marker scan sentinel unexpectedly matched");
  return scan.stdout
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => line.trim().split(/\s+/u).slice(0, 4).join(" "));
}

async function probeRealBindingCapability(): Promise<Run> {
  const { S2_RUN_REAL_BINDING_INTEGRATION: _authority, ...environment } = process.env;
  return runCaptured(
    "bun",
    ["apps/wire/test/integration/s2-krater-real-bindings.test.ts", "--capability-probe"],
    environment,
    30_000,
  );
}

describe("S2 to S7 normalized cost receipt", () => {
  test("S2 response parsers retain only exact sequence and cursor values", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const validWrite = {
      ...FIRST_COST_WRITE,
      seq: maximum,
      pre_cursor: maximum - 1,
      post_cursor: maximum,
    };
    expect(parseS2WriteResult(validWrite)).toMatchObject({
      seq: maximum,
      pre_cursor: maximum - 1,
      post_cursor: maximum,
    });
    expect(
      parseS2StateResult({
        cursor: maximum,
        counts: {},
        chain_digest: "a".repeat(64),
        checkpoint_digest: null,
        checkpoint_mode: "unsigned-v0",
      }),
    ).toMatchObject({ cursor: maximum });
    expect(
      parseS2EventPageResult({
        events: [{ seq: maximum }],
        next_cursor: maximum,
        has_more: false,
      }),
    ).toEqual({ sequences: [maximum], nextCursor: maximum, hasMore: false });

    for (const invalid of [maximum + 1, 1.5]) {
      expect(() => parseS2WriteResult({ ...validWrite, seq: invalid })).toThrow(
        "S2_RESPONSE_INVALID",
      );
      expect(() =>
        parseS2StateResult({
          cursor: invalid,
          counts: {},
          chain_digest: "a".repeat(64),
          checkpoint_digest: null,
          checkpoint_mode: "unsigned-v0",
        }),
      ).toThrow("S2_RESPONSE_INVALID");
      expect(() =>
        parseS2EventPageResult({
          events: [{ seq: invalid }],
          next_cursor: invalid,
          has_more: false,
        }),
      ).toThrow("S2_RESPONSE_INVALID");
    }
  });

  test("builds the verifier's exact receipt schema from successful settled write metrics", () => {
    const privateBodySentinel = "s2-private-body-must-not-appear";
    const metricsWithPrivateBody: readonly (
      | S2SettledWriteResult
      | (S2SettledWriteResult & { readonly privateBody: string })
    )[] = [{ ...FIRST_COST_WRITE, privateBody: privateBodySentinel }, ...COST_WRITES.slice(1)];
    const receipt = buildS2CostMeasurementReceipt(metricsWithPrivateBody, COST_PROVENANCE);

    expect(Object.keys(receipt)).toEqual([...S2_COST_RECEIPT_ROOT_KEYS]);
    expect(Object.keys(receipt.bindings)).toEqual([...S2_COST_RECEIPT_BINDINGS_KEYS]);
    expect(receipt).toMatchObject({
      run_id: COST_PROVENANCE.run_id,
      revision: COST_PROVENANCE.revision,
      dirty_state: "clean",
      source_digest: COST_PROVENANCE.source_digest,
      phase: "exercise",
      status: "pass",
      metric_scope: "selected-settled-write-receipts",
      write_receipt_count: 3,
      p95_write_phase_ms: 20,
      p95_preflight_wall_ms: 10,
      p95_write_claim_wall_ms: 110,
      sum_successful_batch_rows_read: 15,
      sum_successful_batch_rows_written: 12,
      sum_preflight_rows_read: 18,
      sum_preflight_rows_written: 1,
      sum_preflight_statements: 12,
      sum_retry_count: 3,
      known_row_total_exclusions: [
        "head-and-post-write-verification-reads-no-meta",
        "failed-retry-batches-no-meta",
      ],
    });
    // Integrity backfills have their own measured response fields. They are not
    // selected successful claim WriteResults and therefore cannot be smuggled
    // into this per-selected-write denominator or represented as a total D1 cost.
    expect(JSON.stringify(receipt)).not.toContain("backfill");
    expect(JSON.stringify(receipt)).not.toContain(privateBodySentinel);
  });

  test("refuses empty or malformed selected metrics before creating an artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "asimposium-s2-cost-refusal-"));
    const receiptPath = join(root, S2_COST_RECEIPT_RELATIVE_PATH);

    expect(() => writeS2CostMeasurementReceipt([], COST_PROVENANCE, { root, receiptPath })).toThrow(
      "S2_COST_RECEIPT_EMPTY",
    );
    expect(existsSync(receiptPath)).toBe(false);

    const malformed = structuredClone(COST_WRITES) as S2SettledWriteResult[];
    const firstMalformed = malformed[0];
    if (firstMalformed === undefined)
      throw new Error("cloned S2 cost fixture lost its first write");
    malformed[0] = { ...firstMalformed, write_phase_ms: Number.NaN };
    expect(() =>
      writeS2CostMeasurementReceipt(malformed, COST_PROVENANCE, { root, receiptPath }),
    ).toThrow("S2_COST_RECEIPT_METRICS_INVALID");
    expect(existsSync(receiptPath)).toBe(false);

    // This is deliberately outside the production type: the refusal test proves
    // runtime validation rejects an idempotent result before writing evidence.
    const idempotent = {
      ...FIRST_COST_WRITE,
      idempotent: true,
    } as unknown as S2SettledWriteResult;
    expect(() =>
      writeS2CostMeasurementReceipt([idempotent], COST_PROVENANCE, { root, receiptPath }),
    ).toThrow("S2_COST_RECEIPT_METRICS_INVALID");
    expect(existsSync(receiptPath)).toBe(false);
  });

  test("writes one mode-0600 regular receipt, refusing overwrite, symlink, and escaped paths", () => {
    const root = mkdtempSync(join(tmpdir(), "asimposium-s2-cost-receipt-"));
    const receiptPath = join(root, S2_COST_RECEIPT_RELATIVE_PATH);
    const written = writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, {
      root,
      receiptPath,
    });
    const artifact = written.artifact;

    const stat = lstatSync(receiptPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(artifact).toMatchObject({
      relativePath: S2_COST_RECEIPT_RELATIVE_PATH,
      bytes: readFileSync(receiptPath).byteLength,
    });
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(written.receipt);

    const original = readFileSync(receiptPath, "utf8");
    expect(() =>
      writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, { root, receiptPath }),
    ).toThrow("S2_COST_RECEIPT_EXISTS");
    expect(readFileSync(receiptPath, "utf8")).toBe(original);

    const symlinkRoot = mkdtempSync(join(tmpdir(), "asimposium-s2-cost-symlink-"));
    const symlinkPath = join(symlinkRoot, S2_COST_RECEIPT_RELATIVE_PATH);
    symlinkSync("untrusted-target", symlinkPath);
    expect(() =>
      writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, {
        root: symlinkRoot,
        receiptPath: symlinkPath,
      }),
    ).toThrow("S2_COST_RECEIPT_SYMLINK_REFUSED");
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

    const escapedPath = join(root, "nested", S2_COST_RECEIPT_RELATIVE_PATH);
    expect(() =>
      writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, {
        root,
        receiptPath: escapedPath,
      }),
    ).toThrow("S2_COST_RECEIPT_PATH_INVALID");
    expect(existsSync(escapedPath)).toBe(false);
  });

  test("keeps receipt creation exercise-only but only publishes it after every local phase", () => {
    const client = readFileSync(
      resolve(REPOSITORY_ROOT, "apps/wire/src/krater/s2-client.ts"),
      "utf8",
    );
    const exercise = client.slice(
      client.indexOf("async function exercise():"),
      client.indexOf("async function restartVerify"),
    );
    const restartAndUpgrade = client.slice(client.indexOf("async function restartVerify"));
    expect(exercise).toContain("writeS2CostMeasurementReceipt");
    expect(exercise.indexOf("writeS2CostMeasurementReceipt")).toBeLessThan(
      exercise.lastIndexOf('status: "pass"'),
    );
    expect(exercise).toContain("selectedSettledWrite");
    expect(client).toContain("if (write.idempotent)");
    expect(restartAndUpgrade).not.toContain("writeS2CostMeasurementReceipt(");
    expect(client).toContain("if (import.meta.main)");

    const shell = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
    expect(shell).toContain("scripts/verify-cost-model.ts");
    expect(shell).toContain("bun.lock");
    expect(shell).toContain("apps/wire/package.json");
    expect(shell).toContain("packages/contracts/package.json");
    expect(shell).toContain("packages/contracts/src/index.ts");
    expect(shell).toContain('S2_COST_RECEIPT_RELATIVE_PATH="s2-cost-input.json"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    const runIdValidation = shell.indexOf('if [[ ! "${S2_RUN_ID}" =~');
    const runIdUnexport = shell.indexOf("export -n S2_RUN_ID");
    const runIdReadonly = shell.indexOf("readonly S2_RUN_ID");
    expect(runIdValidation).toBeGreaterThan(-1);
    expect(runIdValidation).toBeLessThan(runIdUnexport);
    expect(runIdUnexport).toBeLessThan(runIdReadonly);
    expect(shell).toContain("s2_cost_receipt: costReceiptSummary");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('if [[ "${phase}" == "exercise" ]]');
    expect(shell).toContain("S2_COST_LOCAL_PHASES_COMPLETE=1");
    expect(shell).toContain("write_s2_cost_publication");
    expect(shell).toContain("write_s2_cost_publication_commit");
    const onExit = shell.slice(shell.indexOf("on_exit() {"), shell.indexOf("trap on_exit EXIT"));
    expect(onExit).toContain("write_evidence_receipt");
    expect(onExit).toContain("write_s2_cost_publication");
    expect(onExit).toContain("write_s2_cost_publication_commit");
    expect(onExit).toContain("! s2_source_provenance_matches_start");
    expect(onExit).toContain("cleanup_workers");
    expect(onExit).toContain("S2_EVIDENCE_PUBLICATION_SKIPPED_UNPROVEN_CLEANUP");
    expect(shell.indexOf("write_s2_cost_publication()")).toBeLessThan(
      shell.indexOf("write_s2_cost_publication_commit()"),
    );
  });

  test("publishes exact supervisor cleanup scope before every normal release write", () => {
    const shell = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
    const start = shell.slice(
      shell.indexOf("start_pinned_supervisor() {"),
      shell.indexOf("read_child_status()"),
    );
    expect(start).toContain('persist="$3" port="$4" proof_scope="$5"');
    expect(start.indexOf("S2_MOST_RECENT_SUPERVISOR=")).toBeLessThan(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      start.indexOf("printf '%s\\n' \"${release_token}\" >&7"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(start).toContain("${persist} ${port} ${proof_scope}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('"${persist}" "${port}" "${proof_scope}"; then');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('clear_most_recent_supervisor_if_marker "${S2_SERVER_MARKER}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('most_recent_supervisor_is_tracked "${marker}"');
    expect(shell).toContain("reap_parent_terminated_supervisor_residual");
    expect(shell).toContain("S2_PARENT_TERM_OLD_HOOK_RESIDUAL_REAPED");
    expect(shell).toContain("S2_PARENT_TERM_RESIDUAL_UNPROVEN");
    expect(start).toContain("pre_release_group_is_stably_pinned");
    expect(start).not.toContain("blocked_snapshot");
    expect(start).toContain("Publish its exact");
    expect(start).toContain("observer");
    expect(start).toContain("IFS= read -r -t 0.2 fragment <&8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(start).toContain('value="${value}${fragment}"');
    expect(start).toContain("S2_PLANT_FRAGMENTED_ARM_TOKEN");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(start).toContain('kill -0 "${owner_pid}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(start).toContain('kill -KILL -- "-${supervisor_pid}"');
    expect(shell).toContain("pre_release_snapshot_line_kind");
    expect(shell).toContain("detached_process_table_read()");
    expect(shell).toContain("capture_detached_process_table()");
    expect(shell).toContain("setsid() or exit 125; exec @ARGV");
    expect(shell).toContain("read_detached_process_snapshot");
    expect(shell).toContain("S2_SHELL_REGRESSION_FAILED");
    const groupMembers = shell.slice(
      shell.indexOf("group_members() {"),
      shell.indexOf("group_contains_pid()"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(groupMembers).toContain('-g "${pgid}"');
    expect(groupMembers).not.toContain("ps -axo");
    const preRelease = shell.slice(
      shell.indexOf("pre_release_snapshot_line_kind()"),
      shell.indexOf("signal_owned_group()"),
    );
    expect(preRelease).not.toContain("$(LC_ALL=C ps");
    expect(preRelease).toContain("capture_detached_process_table");
    expect(preRelease).toContain("-o pid=,pgid=,ppid=,stat=,command= -g");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(preRelease).toContain('"${helper}" == "${expected_helper}"');
    expect(preRelease).toContain("S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain("${S2_GROUP_MEMBER_COUNT} -ge 1 && ${S2_GROUP_MEMBER_COUNT} -le 2");
    expect(shell).toContain("S2_PLANT_PERSISTENT_PRE_RELEASE_HELPER");
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_ACCEPTED");
    expect(shell).toContain("emit_release_race_failure()");
    expect(shell).toContain('\\"terminal\\":true,\\"scenario\\":\\"release-race\\"');
    expect(shell).toContain("S2_RELEASE_RACE_UNEXPECTEDLY_RELEASED");
    expect(shell).toContain("S2_RELEASE_RACE_PLANTED_IDENTITY_INVALID");
    expect(shell).toContain("S2_RELEASE_RACE_EXACT_GROUP_SURVIVOR");
    expect(shell).toContain("emit_persistent_pre_release_helper_failure()");
    expect(shell).toContain(
      '\\"terminal\\":true,\\"scenario\\":\\"persistent-pre-release-helper\\"',
    );
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_PAYLOAD_PATH_UNSAFE");
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_RESAMPLE_OR_RELEASE_PROOF_FAILED");
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_PGID_INVALID");
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_SURVIVOR");
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_PLANTED_IDENTITY_INVALID");
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_PLANTED_HELPER_SURVIVOR");
    // biome-ignore lint/style/useTemplate: preserves literal shell ${mode} without interpolation.
    const modeBranch = (mode: string): string => 'if [[ "$' + '{mode}" == "' + mode + '" ]]';
    const releaseRace = shell.slice(
      shell.indexOf(modeBranch("release-race")),
      shell.indexOf(modeBranch("persistent-pre-release-helper")),
    );
    for (const code of [
      "S2_RELEASE_RACE_UNEXPECTEDLY_RELEASED",
      "S2_RELEASE_RACE_PLANTED_IDENTITY_INVALID",
      "S2_RELEASE_RACE_EXACT_GROUP_SURVIVOR",
    ]) {
      expect(releaseRace).toContain(`emit_release_race_failure "${code}"`);
    }
    const persistentHelper = shell.slice(
      shell.indexOf(modeBranch("persistent-pre-release-helper")),
      shell.indexOf(modeBranch("release-interleaving")),
    );
    for (const code of [
      "S2_PERSISTENT_PRE_RELEASE_HELPER_PAYLOAD_PATH_UNSAFE",
      "S2_PERSISTENT_PRE_RELEASE_HELPER_ACCEPTED",
      "S2_PERSISTENT_PRE_RELEASE_HELPER_PLANTED_IDENTITY_INVALID",
      "S2_PERSISTENT_PRE_RELEASE_HELPER_RESAMPLE_OR_RELEASE_PROOF_FAILED",
      "S2_PERSISTENT_PRE_RELEASE_HELPER_PGID_INVALID",
      "S2_PERSISTENT_PRE_RELEASE_HELPER_SURVIVOR",
      "S2_PERSISTENT_PRE_RELEASE_HELPER_PLANTED_HELPER_SURVIVOR",
    ]) {
      expect(persistentHelper).toContain(`emit_persistent_pre_release_helper_failure "${code}"`);
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('[[ -n "${marker}" ]] || return 1');
    expect(shell).toContain("trap '' INT TERM HUP");
    expect(shell).toContain("S2_LIFECYCLE_DEADLINE_TYPED_EXIT_FAILED");
    expect(shell).toContain("return 124");
    const publicationWriters = shell.slice(
      shell.indexOf("write_evidence_receipt() {"),
      shell.indexOf("create_evidence_subdir() {"),
    );
    expect(publicationWriters).toContain("linkSync(privateSibling, destination)");
    expect(publicationWriters).toContain("fsyncSync(directoryDescriptor)");
    expect(publicationWriters).not.toContain("renameSync(");
    expect(publicationWriters).not.toContain("unlinkSync(");
    expect(publicationWriters).not.toContain("rmSync(");
    expect(publicationWriters).toContain("parseS2CostMeasurementReceiptBytes");
    expect(publicationWriters).toContain("receipt.source_digest !== manifest.source_digest");
    expect(publicationWriters).toContain("observedSourceDigest !== manifest.source_digest");
    expect(shell).toContain("s2_run_owned_deadline()");
    expect(shell).toContain("S2_MAIN_DEADLINE_AT");
    expect(shell).not.toContain("S2_PLANT_SOURCE_PROVENANCE_DRIFT");
    expect(shell).toContain("S2_TERM_RESISTANT_START_FAILED");
    const postReleaseController = shell.slice(
      shell.indexOf("post_release_controller_identity_matches() {"),
      shell.indexOf("most_recent_supervisor_is_tracked()"),
    );
    expect(postReleaseController).toContain("S2_POST_RELEASE_CONTROLLER_PID=$!");
    expect(postReleaseController).toContain("post_release_controller_identity_matches()");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(postReleaseController).toContain('kill -TERM "${pid}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(postReleaseController).toContain('kill -KILL "${pid}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(postReleaseController).toContain('wait "${pid}"');
    expect(postReleaseController).toContain("assert_no_run_survivors");
    expect(postReleaseController).toContain("S2_POST_RELEASE_CONTROLLER_CHILD_STATE_DIR");
    expect(postReleaseController).toContain("child-state-proof");
    expect(postReleaseController).toContain("S2_POST_RELEASE_CONTROLLER_CLEANUP_UNPROVEN");
    expect(postReleaseController).toContain("post-kill-live");
    expect(postReleaseController.indexOf("post-kill-live")).toBeLessThan(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts refusal precedes bare wait.
      postReleaseController.indexOf('wait "${pid}"'),
    );
    const postReleaseCleanup = shell.slice(
      shell.indexOf("cleanup_post_release_controller() {"),
      shell.indexOf("post_release_controller_refuse() {"),
    );
    expect(postReleaseCleanup).toContain(
      "S2_POST_RELEASE_PARTIAL_OBSERVATION_PROPAGATED_DURING_EXIT_CLEANUP",
    );
    const exitRaceInitialLive = postReleaseCleanup.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      'if post_release_controller_is_live_non_zombie "${pid}"; then',
    );
    const exitRaceRequest = postReleaseCleanup.indexOf("printf 'exit-before-term-identity %s\\n'");
    const exitRaceTermIdentity = postReleaseCleanup.indexOf(
      "S2_POST_RELEASE_CONTROLLER_CLEANUP_STAGE=term-identity\n",
    );
    expect(exitRaceInitialLive).toBeGreaterThanOrEqual(0);
    expect(exitRaceRequest).toBeGreaterThan(exitRaceInitialLive);
    expect(exitRaceTermIdentity).toBeGreaterThan(exitRaceRequest);
    expect(
      postReleaseCleanup.indexOf("S2_EVIDENCE_SEALING_REFUSED_FOR_PARTIAL_OBSERVATION=1"),
    ).toBeLessThan(postReleaseCleanup.lastIndexOf("clear_post_release_controller"));
    expect(shell).toContain("cleanup_post_release_controller || result=1");
    expect(shell).toContain("S2_EVIDENCE_PUBLICATION_SKIPPED_PARTIAL_OBSERVATION");
    const postReleasePredicate = shell.slice(
      shell.indexOf("post_release_ready_predicate_samples() {"),
      shell.indexOf("single_decimal_file()"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(postReleasePredicate).toContain('file="${prefix}.${expected_sequence}"');
    const postReleaseStart = shell.slice(
      shell.indexOf("start_pinned_supervisor() {"),
      shell.indexOf("read_child_status()"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(postReleaseStart).toContain('>"${post_release_ready_predicate_pending}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts atomic final-name publication.
    expect(postReleaseStart).toContain('ln "${post_release_ready_predicate_pending}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts atomic final-name publication.
    expect(postReleaseStart).toContain('"${post_release_ready_predicate_final}"');
    expect(
      postReleaseStart.indexOf("S2_EVIDENCE_SEALING_REFUSED_FOR_PARTIAL_OBSERVATION=1"),
    ).toBeLessThan(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts refusal is armed pre-write.
      postReleaseStart.indexOf('>"${post_release_ready_predicate_pending}"'),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: rejects append-visible predicate ledgers.
    expect(postReleaseStart).not.toContain('>>"${post_release_ready_predicate}');
    expect(postReleaseStart).toContain("S2_PLANT_POST_RELEASE_READY_PREDICATE");
    const postReleaseCheckpoint = shell.slice(
      shell.indexOf(modeBranch("post-release-safe-checkpoint")),
      shell.indexOf(modeBranch("watchdog-startup-diagnostics")),
    );
    expect(postReleaseCheckpoint).toContain("S2_PLANT_POST_RELEASE_PARTIAL_REFUSAL");
    expect(postReleaseCheckpoint).toContain("S2_POST_RELEASE_PARTIAL_OBSERVATION_REFUSED");
    // A bare OR-list call recreates the original false green: the outer dispatcher invokes this
    // function in an `if`, so Bash suppresses errexit throughout the function body.
    expect(postReleaseCheckpoint).not.toMatch(/\|\|\s*post_release_controller_refuse(?:\s|$)/u);
    const exitRaceChildStart = shell.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      'if [[ "${S2_PLANT_POST_RELEASE_READY_PREDICATE:-none}" == exit-race ]]',
    );
    const exitRaceChild = shell.slice(
      exitRaceChildStart,
      shell.indexOf("S2_PLANT_POST_RELEASE_SAFE_BARRIER=1", exitRaceChildStart),
    );
    const exitRaceChildRequest = exitRaceChild.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      'if [[ "${exit_race_line}" == "exit-before-term-identity $$" ]]',
    );
    const exitRaceSharedReady = exitRaceChild.indexOf("exit-race-load-request-observed");
    expect(exitRaceChildRequest).toBeGreaterThanOrEqual(0);
    expect(exitRaceSharedReady).toBeGreaterThan(exitRaceChildRequest);
    const termInterrupt = shell.slice(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      shell.indexOf('if [[ "${mode}" == "term-interrupt-cleanup" ]]'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      shell.indexOf('if [[ "${mode}" == "term-resistant-release" ]]'),
    );
    expect(termInterrupt).toContain("reap_parent_terminated_supervisor_residual");
    expect(termInterrupt).toContain("S2_PARENT_TERM_OLD_HOOK_RESIDUAL_REAPED");
    expect(termInterrupt).toContain("assert_no_run_survivors");
  });
});

const S2_SHELL_REGRESSION_MODES = [
  "pre-release-helper-classification",
  "detached-ps-failure",
  "pre-arm-owner-loss",
  "release-race",
  "persistent-pre-release-helper",
  "release-interleaving",
  "term-interrupt-cleanup",
  "term-resistant-release",
  "watchdog-uncertainty",
  "watchdog-self-retire",
  "watchdog-publication-delay",
  "post-release-controller-term-identity-exit-race",
  "post-release-controller-kill-refusal",
  "post-release-safe-checkpoint",
  "watchdog-startup-diagnostics",
  "watchdog-post-arm-abort",
  "watchdog-pre-publication-exit",
  "watchdog-checkpoint-corruption",
  "parent-loss",
  "owner-loss-uncertain",
  "unowned-refusal",
  "pinned-supervisor",
  "journal-timestamps",
  "lsof-scan-failure",
  "legacy-cleanup-failure",
  "legacy-leader-loss",
  "legacy-leader-loss-transient-ps",
  "legacy-leader-loss-transient-post-arm-ps",
  "redaction",
  "provenance",
  "indexed-phase-status",
] as const;

function selectedS2ShellRegressionModes(): readonly (typeof S2_SHELL_REGRESSION_MODES)[number][] {
  const requested = process.env.S2_SHELL_REGRESSION_UNIT_MODE?.split(",");
  if (requested === undefined) return S2_SHELL_REGRESSION_MODES;
  const selected = S2_SHELL_REGRESSION_MODES.filter((mode) => requested.includes(mode));
  if (selected.length === 0 || selected.length !== new Set(requested).size) {
    throw new Error(`Unknown S2_SHELL_REGRESSION_UNIT_MODE: ${requested.join(",")}`);
  }
  return selected;
}

function assertS2RunThenScanForSurvivors(
  label: string,
  assertRun: () => void,
  scanForSurvivors: () => string[],
): void {
  let assertionFailure: Error | undefined;
  try {
    assertRun();
  } catch (error) {
    assertionFailure = error instanceof Error ? error : new Error(String(error));
  }

  let survivorScanFailure: Error | undefined;
  let survivors: string[] = [];
  try {
    survivors = scanForSurvivors();
  } catch (error) {
    survivorScanFailure = error instanceof Error ? error : new Error(String(error));
  }
  if (survivorScanFailure !== undefined || survivors.length !== 0) {
    const survivorFailure =
      survivors.length === 0
        ? undefined
        : new Error(`S2 shell regression left survivors: ${survivors.join(" | ")}`);
    throw new AggregateError(
      [assertionFailure, survivorScanFailure, survivorFailure].filter(
        (error): error is Error => error !== undefined,
      ),
      `S2 shell regression cleanup verification failed after ${label}; ` +
        `run_failure=${assertionFailure?.message ?? "none"}; ` +
        `scan_failure=${survivorScanFailure?.message ?? "none"}; ` +
        `survivors=${survivors.join(" | ") || "none"}`,
    );
  }
  if (assertionFailure !== undefined) throw assertionFailure;
}

function collectAllFixtureVerificationFailures<T>(
  fixtures: readonly T[],
  verify: (fixture: T, index: number) => void,
): Array<{ readonly index: number; readonly error: Error }> {
  const failures: Array<{ readonly index: number; readonly error: Error }> = [];
  fixtures.forEach((fixture, index) => {
    try {
      verify(fixture, index);
    } catch (error) {
      failures.push({ index, error: error instanceof Error ? error : new Error(String(error)) });
    }
  });
  return failures;
}

describe("registered S2 shell and lifecycle regressions", () => {
  test("PLANTED: a run assertion failure cannot bypass the survivor scan", () => {
    let scans = 0;
    expect(() =>
      assertS2RunThenScanForSurvivors(
        "planted-run-failure",
        () => {
          throw new Error("PLANTED_RUN_FAILURE");
        },
        () => {
          scans += 1;
          return [];
        },
      ),
    ).toThrow("PLANTED_RUN_FAILURE");
    expect(scans).toBe(1);
  });

  test("PLANTED: simultaneous run and cleanup failures retain both diagnostics", () => {
    const combinedFailure = () =>
      assertS2RunThenScanForSurvivors(
        "planted-combined-failure",
        () => {
          throw new Error("PLANTED_RUN_FAILURE");
        },
        () => ["123 123 planted-run-survivor"],
      );
    let failure: unknown;
    try {
      combinedFailure();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain("run_failure=PLANTED_RUN_FAILURE");
    expect((failure as AggregateError).message).toContain("survivors=123 123 planted-run-survivor");
    expect(
      (failure as AggregateError).errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([
      "PLANTED_RUN_FAILURE",
      "S2 shell regression left survivors: 123 123 planted-run-survivor",
    ]);
  });

  test("PLANTED: one concurrent fixture failure cannot skip later survivor scans", () => {
    const visited: number[] = [];
    const failures = collectAllFixtureVerificationFailures([0, 1, 2, 3], (_fixture, index) => {
      visited.push(index);
      if (index === 0 || index === 2) throw new Error(`PLANTED_FIXTURE_${index}`);
    });
    expect(visited).toEqual([0, 1, 2, 3]);
    expect(failures.map((failure) => failure.index)).toEqual([0, 2]);
    expect(failures.map((failure) => failure.error.message)).toEqual([
      "PLANTED_FIXTURE_0",
      "PLANTED_FIXTURE_2",
    ]);
  });

  test("binds recursive lsof candidates to PID rechecks and splits KILL from postcondition", () => {
    const shell = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
    const lsofRetry = shell.slice(
      shell.indexOf("lsof_scan_reaches_no_matches() {"),
      shell.indexOf("s2_pgid_is_owned() {"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(lsofRetry).toContain('candidate_output="$(lsof -a -p "${line}" "$@" 2>&1)"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(lsofRetry).toContain('[[ ${candidate_status} -eq 1 && -z "${candidate_output}" ]]');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(lsofRetry).toContain("[[ ( ${candidate_status} -eq 0 || ${candidate_status} -eq 1 ) &&");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts exact-PID output matching.
    expect(lsofRetry).toContain('[[ "${candidate_output}" == "${line}" ]] || return 1');

    const legacyReap = shell.slice(
      shell.indexOf("legacy_reap_leader_lost_group() {"),
      shell.indexOf("reap_parent_terminated_supervisor_residual() {"),
    );
    const killSent = legacyReap.indexOf("S2_LEGACY_STOP_EXACT_RESIDUAL_KILL_SENT=1");
    const groupDisappeared = legacyReap.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      'if ! kill -0 -- "-${pgid}" 2>/dev/null; then',
      killSent,
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    const barrier = legacyReap.indexOf('legacy_postcondition_load_barrier "${pgid}"');
    const postcondition = legacyReap.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      'assert_no_run_survivors "${persist}" "${port}" "${marker}"',
      barrier,
    );
    const postconditionProved = legacyReap.indexOf(
      "S2_LEGACY_STOP_EXACT_RESIDUAL_POSTCONDITION_PROVED=1",
    );
    expect(killSent).toBeGreaterThanOrEqual(0);
    expect(groupDisappeared).toBeGreaterThan(killSent);
    expect(barrier).toBeGreaterThan(groupDisappeared);
    expect(postcondition).toBeGreaterThan(barrier);
    expect(postconditionProved).toBeGreaterThan(postcondition);

    const legacyMode = shell.slice(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      shell.indexOf('if [[ "${mode}" == "legacy-leader-loss" ||'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      shell.indexOf('if [[ "${mode}" == "watchdog-uncertainty" ]]'),
    );
    expect(legacyMode).toContain("S2_LEGACY_STOP_EXACT_RESIDUAL_KILL_SENT");
    expect(legacyMode).toContain("S2_LEGACY_STOP_EXACT_RESIDUAL_POSTCONDITION_PROVED");
  });

  test("PLANTED: external controller scans cover retained and partial-ready identities", () => {
    const runId = "s2u-parent-survivor-fixture";
    const childRunId = `s2u-${"a".repeat(48)}`;
    const marker = `s2-post-release-controller-${childRunId}`;
    const owner: RetainedPostReleaseControllerOwner = {
      controllerPid: 4201,
      parentPid: 4101,
      childRunId,
      marker,
    };
    const ready: ExitRaceLoadReadyRecord = {
      controllerPid: owner.controllerPid,
      parentPid: owner.parentPid,
      token: ["fixture", "ready", "fallback"].join("-"),
      size: 4,
    };
    const rows: S2LifecycleProcessRow[] = [
      {
        pid: owner.parentPid,
        pgid: owner.parentPid,
        parentPid: 1,
        status: "S",
        command: `bash e2e/artifacts/s2-krater/${runId}/main/outer`,
        identity: `${owner.parentPid} ${owner.parentPid} 1 S`,
      },
      {
        pid: owner.controllerPid,
        pgid: owner.controllerPid,
        parentPid: owner.parentPid,
        status: "S",
        command: "bash scripts/e2e-s2-krater.sh",
        identity: `${owner.controllerPid} ${owner.controllerPid} ${owner.parentPid} S`,
      },
      {
        pid: 4301,
        pgid: 4301,
        parentPid: owner.controllerPid,
        status: "S",
        command: `bash e2e/artifacts/s2-krater/${childRunId}/main/child`,
        identity: `4301 4301 ${owner.controllerPid} S`,
      },
      {
        pid: 4302,
        pgid: 4302,
        parentPid: owner.controllerPid,
        status: "S",
        command: `bash ${marker}`,
        identity: `4302 4302 ${owner.controllerPid} S`,
      },
    ];

    expect(
      matchS2FixtureSurvivors(rows, s2FixtureSurvivorSelectors(runId, [owner], ready)),
    ).toEqual([
      `parent-run:${runId}=${owner.parentPid} ${owner.parentPid} 1 S`,
      `child-run:${childRunId}=4301 4301 ${owner.controllerPid} S`,
      `controller-marker:${marker}=4302 4302 ${owner.controllerPid} S`,
      `controller-pid:${owner.controllerPid}=${owner.controllerPid} ${owner.controllerPid} ${owner.parentPid} S`,
      `ready-controller-pid:${owner.controllerPid}=${owner.controllerPid} ${owner.controllerPid} ${owner.parentPid} S`,
      `ready-parent-pid:${owner.parentPid}=${owner.parentPid} ${owner.parentPid} 1 S`,
    ]);
    expect(matchS2FixtureSurvivors(rows, s2FixtureSurvivorSelectors(runId, [], ready))).toEqual([
      `parent-run:${runId}=${owner.parentPid} ${owner.parentPid} 1 S`,
      `ready-controller-pid:${owner.controllerPid}=${owner.controllerPid} ${owner.controllerPid} ${owner.parentPid} S`,
      `ready-parent-pid:${owner.parentPid}=${owner.parentPid} ${owner.parentPid} 1 S`,
    ]);
  });

  test("PLANTED: process scans are bounded, non-empty, and never expose scanner error text", () => {
    const runId = "s2u-process-scan-fixture";
    const scanner = " 4242 4242 1 R /bin/ps -axo pid=,pgid=,ppid=,stat=,command=";
    const survivor = ` 4343 4343 1 S bash e2e/artifacts/s2-krater/${runId}/main/supervisor.status`;
    expect(
      parseS2LifecycleProcessTable(runId, {
        status: 0,
        signal: null,
        stdout: `${scanner}\n${survivor}\n`,
      }),
    ).toEqual(["4343 4343 1 S"]);

    const scannerError = Object.assign(new Error("mutable scanner diagnostic"), {
      code: "ETIMEDOUT",
    });
    const failedScan = () =>
      parseS2LifecycleProcessTable(runId, {
        status: null,
        signal: "SIGTERM",
        error: scannerError,
        stdout: "",
      });
    expect(failedScan).toThrow("status=null signal=SIGTERM code=ETIMEDOUT");
    expect(failedScan).not.toThrow("mutable scanner diagnostic");
    expect(() =>
      parseS2LifecycleProcessTable(runId, {
        status: 0,
        signal: null,
        stdout: "",
      }),
    ).toThrow("process-table output empty");
    expect(
      parseS2LifecycleProcessTable(runId, {
        status: 0,
        signal: null,
        stdout: " 9999 9999 1 S unrelated\n",
      }),
    ).toEqual([]);
  });

  test("PLANTED: a pure shell regression never spends or depends on a Wrangler version process", () => {
    const pureRunId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const pure = runHarnessSync(
      {
        S2_RUN_ID: pureRunId,
        S2_SHELL_REGRESSION_TEST: "pre-release-helper-classification",
        S2_PLANT_WRANGLER_VERSION_UNAVAILABLE: "1",
      },
      S2_SHELL_REGRESSION_WATCHDOG_MS,
    );
    expect(pure.exitCode).toBe(0);
    expect(pure.stdout).toContain(
      '"scenario":"pre-release-helper-classifier-accepts-only-the-supervisors-exact-live-ps-child"',
    );
    expect(typedDiagnosticCodes(pure)).not.toContain("WRANGLER_VERSION_UNAVAILABLE");

    const product = runHarnessSync(
      {
        S2_RUN_ID: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        S2_PLANT_WRANGLER_VERSION_UNAVAILABLE: "1",
      },
      30_000,
    );
    expect(product.exitCode).toBe(1);
    expect(typedDiagnosticCodes(product)).toContain("WRANGLER_VERSION_UNAVAILABLE");

    const explicitProduct = runHarnessSync(
      {
        S2_RUN_ID: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        S2_SHELL_REGRESSION_TEST: "none",
        S2_PLANT_WRANGLER_VERSION_UNAVAILABLE: "1",
      },
      30_000,
    );
    expect(explicitProduct.exitCode).toBe(1);
    expect(typedDiagnosticCodes(explicitProduct)).toContain("WRANGLER_VERSION_UNAVAILABLE");
  });

  test(
    "PLANTED: a deadline before setsid kills only the exact gated fork child",
    async () => {
      const marker = `s2-pre-setsid-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      console.log(
        JSON.stringify({
          suite: "s2-concurrent-supervisor",
          fixture: "pre-setsid-timeout",
          phase: "start",
        }),
      );
      const run = await runCapturedConcurrently(
        "bash",
        ["-c", "exit 0", `${marker}-payload`],
        {},
        200,
        3_000,
      );
      assertS2RunThenScanForSurvivors(
        "concurrent-pre-setsid-timeout",
        () => {
          const missing = [
            run.exitCode === 124 ? undefined : "exit-124",
            run.stderr.includes('"code":"S2_CAPTURE_DEADLINE_EXCEEDED"')
              ? undefined
              : "typed-deadline",
            run.stderr.includes('"action":"term-then-kill-exact-child-before-group"')
              ? undefined
              : "exact-pre-group-action",
            run.stdout === "" ? undefined : "payload-executed-before-gate",
          ].filter((entry): entry is string => entry !== undefined);
          if (missing.length !== 0) {
            throw new Error(
              `pre-setsid timeout proof incomplete: missing=${missing.join(",")}; ` +
                `codes=${typedDiagnosticCodes(run).join(",") || "NO_TYPED_CODE"}; ` +
                `stdout_bytes=${Buffer.byteLength(run.stdout)}; ` +
                `stderr_bytes=${Buffer.byteLength(run.stderr)}; ` +
                `retained_logs=${run.retainedLogs}`,
            );
          }
        },
        () => liveProcessesContainingMarker(marker),
      );
      console.log(
        JSON.stringify({
          suite: "s2-concurrent-supervisor",
          fixture: "pre-setsid-timeout",
          phase: "pass",
        }),
      );
    },
    CONCURRENT_CAPTURE_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: the concurrent capture deadline kills one exact TERM-resistant process group",
    async () => {
      const marker = `s2-timeout-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const stateRoot = mkdtempSync(join(tmpdir(), "asimposium-s2-timeout-state-"));
      const heldFile = join(stateRoot, "held-open");
      console.log(
        JSON.stringify({ suite: "s2-concurrent-supervisor", fixture: "timeout", phase: "start" }),
      );
      const run = await runCapturedConcurrently(
        "bash",
        [
          "-c",
          String.raw`
            trap "" TERM HUP INT
            held_file="$1"
            marker="$2"
            exec 9>"$held_file" || exit 125
            printf '%s\n' '{"suite":"s2-concurrent-supervisor","status":"pass","assertion":"timeout-payload-ready-with-held-fd"}'
            bash -c 'trap "" TERM HUP INT; while :; do read -r -t 1 ignored || :; done' "$marker-descendant" &
            while :; do read -r -t 1 ignored || :; done
          `,
          `${marker}-parent`,
          heldFile,
          marker,
        ],
        {},
        2_000,
      );

      assertS2RunThenScanForSurvivors(
        "concurrent-timeout-exact-group",
        () => {
          const stateFileRegular =
            existsSync(heldFile) &&
            lstatSync(heldFile).isFile() &&
            !lstatSync(heldFile).isSymbolicLink();
          const missing = [
            run.exitCode === 124 ? undefined : "exit-124",
            run.stdout.includes('"assertion":"timeout-payload-ready-with-held-fd"')
              ? undefined
              : "payload-ready",
            run.stderr.includes('"code":"S2_CAPTURE_DEADLINE_EXCEEDED"')
              ? undefined
              : "typed-deadline",
            run.stderr.includes('"action":"term-then-kill-exact-child-group"')
              ? undefined
              : "exact-group-action",
            stateFileRegular ? undefined : "retained-state-file",
          ].filter((entry): entry is string => entry !== undefined);
          if (missing.length !== 0) {
            throw new Error(
              `concurrent timeout proof incomplete: missing=${missing.join(",")}; ` +
                `codes=${typedDiagnosticCodes(run).join(",") || "NO_TYPED_CODE"}; ` +
                `stdout_bytes=${Buffer.byteLength(run.stdout)}; stderr_bytes=${Buffer.byteLength(run.stderr)}; ` +
                `retained_logs=${run.retainedLogs}`,
            );
          }
        },
        () => {
          const survivors = liveProcessesContainingMarker(marker);
          const holders = runCaptured("lsof", ["-nP", "-t", "+w", "--", heldFile], {}, 5_000);
          const rawScannerStderr = holders.stderr.split(" retained_logs=", 1)[0] ?? "";
          if (holders.exitCode !== 1 || holders.stdout !== "" || rawScannerStderr !== "") {
            throw new Error(
              `concurrent timeout retained-state scan failed: status=${holders.exitCode}; ` +
                `stdout_bytes=${Buffer.byteLength(holders.stdout)}; ` +
                `stderr_bytes=${Buffer.byteLength(rawScannerStderr)}`,
            );
          }
          return survivors;
        },
      );
      console.log(
        JSON.stringify({ suite: "s2-concurrent-supervisor", fixture: "timeout", phase: "pass" }),
      );
    },
    CONCURRENT_CAPTURE_TEST_TIMEOUT_MS,
  );

  test.each([...selectedS2ShellRegressionModes()])(
    "shell regression %s is bounded and leaves no owned group behind",
    (mode) => {
      console.log(JSON.stringify({ suite: "s2-shell-regression-matrix", mode, phase: "start" }));
      // The run ID appears in artifact paths and therefore in process command
      // lines. Keep it opaque: a mode name embedded here could impersonate the
      // exact lifecycle markers that the shell is trying to classify.
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      expect(runId).not.toContain(mode);
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: mode,
          ...(mode === "post-release-controller-kill-refusal"
            ? {
                S2_PLANT_POST_RELEASE_CONTROLLER_IGNORE_FIRST_TERM: "1",
                S2_PLANT_POST_RELEASE_CONTROLLER_KILL_ACK_LIVE: "1",
              }
            : mode === "post-release-controller-term-identity-exit-race"
              ? { S2_PLANT_POST_RELEASE_CONTROLLER_EXIT_BEFORE_TERM_IDENTITY: "1" }
              : {}),
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        mode,
        () => {
          if (run.exitCode !== 0) {
            const codes = Array.from(
              `${run.stdout}\n${run.stderr}`.matchAll(/"code":"([A-Z][A-Z0-9_]{2,95})"/g),
              (match) => match[1],
            )
              .filter((code, index, values) => values.indexOf(code) === index)
              .slice(0, 4);
            throw new Error(
              `S2 shell regression failed: ${mode}; codes=${codes.join(",") || "NO_TYPED_CODE"}; stdout=${run.stdout || "<empty>"}; stderr=${run.stderr || "<empty>"}`,
            );
          }
          expect(run.exitCode).toBe(0);
          expect(run.stdout).toContain(`"run_id":"${runId}"`);
          if (!run.stdout.includes('"suite":"s2-krater-shell","status":"pass"')) {
            throw new Error(
              `S2 shell regression emitted no terminal pass: ${mode}; stdout=${run.stdout || "<empty>"}; stderr=${run.stderr || "<empty>"}`,
            );
          }
          expect(run.stdout).toContain('"suite":"s2-krater-shell","status":"pass"');
          const evidenceRecord = ndjsonRecords(run).find(
            (entry) => entry.suite === "s2-krater-evidence",
          );
          expect(evidenceRecord).toMatchObject({
            status: "pass",
            evidence_retention_status: "pass",
            captured_exit_code: 0,
            captured_run_status: "pass",
          });
          if (mode === "legacy-leader-loss") {
            expect(run.stdout).toContain('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"');
            expect(run.stdout).toContain('"action":"kill-exact-residual-group"');
            expect(run.stdout).not.toContain('"code":"S2_LEGACY_REAPED_HANDOFF_STALE"');
            expect(run.stdout).not.toContain('"code":"S2_CLEANUP_OWNERSHIP_UNPROVEN"');
          } else if (mode === "lsof-scan-failure") {
            expect(ndjsonRecords(run)).toContainEqual(
              expect.objectContaining({
                suite: "s2-krater-shell",
                status: "pass",
                scenario:
                  "lsof-empty-warning-pid-rechecked-observers-paired-real-holder-captured-scan-and-health-failure-remain-distinct",
                observer_only_broad_scans: 2,
                observer_only_pid_rechecks: 4,
                paired_broad_scans: 1,
                paired_observer_pid_rechecks: 1,
                paired_real_holder_pid_rechecks: 20,
              }),
            );
          } else if (mode === "post-release-controller-term-identity-exit-race") {
            expect(ndjsonRecords(run)).toContainEqual({
              tool: "bash+ps+lsof",
              package: "apps/wire",
              suite: "s2-krater-shell",
              status: "pass",
              terminal: true,
              scenario: "controller-exit-between-liveness-and-term-identity-is-boundedly-reaped",
              initial_live_non_zombie: true,
              term_identity_failed_after_exit: true,
              signal_sent_to_unproved_identity: false,
              controller_reaped: true,
              no_controller_survivor: true,
              reproduce:
                "S2_SHELL_REGRESSION_TEST=post-release-controller-term-identity-exit-race S2_PLANT_POST_RELEASE_CONTROLLER_EXIT_BEFORE_TERM_IDENTITY=1 scripts/e2e-s2-krater.sh",
            });
            expect(run.stdout).not.toContain(
              '"code":"S2_POST_RELEASE_CONTROLLER_CLEANUP_UNPROVEN"',
            );
          } else if (mode === "post-release-controller-kill-refusal") {
            expect(ndjsonRecords(run)).toContainEqual(
              expect.objectContaining({
                suite: "s2-krater-shell",
                status: "refused",
                code: "S2_POST_RELEASE_CONTROLLER_CLEANUP_UNPROVEN",
                reason: "post-kill-live",
                detail: "exact-live-non-zombie",
              }),
            );
            expect(ndjsonRecords(run)).toContainEqual({
              tool: "bash+ps+lsof",
              package: "apps/wire",
              suite: "s2-krater-shell",
              status: "pass",
              terminal: true,
              scenario:
                "live-controller-after-acknowledged-kill-refuses-before-wait-and-next-cleanup-reaps",
              first_cleanup_status: 1,
              post_kill_live_non_zombie: true,
              cleanup_refused_before_wait: true,
              second_cleanup_reaped: true,
              no_controller_survivor: true,
              reproduce:
                "S2_SHELL_REGRESSION_TEST=post-release-controller-kill-refusal S2_PLANT_POST_RELEASE_CONTROLLER_IGNORE_FIRST_TERM=1 S2_PLANT_POST_RELEASE_CONTROLLER_KILL_ACK_LIVE=1 scripts/e2e-s2-krater.sh",
            });
            expect(run.stdout).not.toContain('"code":"S2_CLEANUP_OWNERSHIP_UNPROVEN"');
            expect(run.stdout).not.toContain(
              '"code":"S2_EVIDENCE_PUBLICATION_SKIPPED_UNPROVEN_CLEANUP"',
            );
          } else if (mode === "post-release-safe-checkpoint") {
            expect(run.stdout).toContain('"code":"S2_POST_RELEASE_SAFE_CHECKPOINT_TERMINATED"');
            const terminalProofs = ndjsonRecords(run).filter(
              (record) =>
                record.suite === "s2-krater-shell" &&
                record.status === "pass" &&
                record.terminal === true,
            );
            expect(terminalProofs).toEqual([
              {
                tool: "bash+ps+lsof",
                package: "apps/wire",
                suite: "s2-krater-shell",
                status: "pass",
                terminal: true,
                scenario:
                  "release-consumption-is-not-ready-until-final-traps-and-canonical-post-release-checkpoint",
                post_release_safe_barrier_observed: true,
                controller_identity_attested: true,
                controller_visible_ready_predicate_samples: 2,
                start_returned_before_controller_release: false,
                parser_early_return_controller_reaped: true,
                partial_predicate_final_visible: false,
                partial_predicate_observer_samples: 0,
                partial_observation_controller_reaped: true,
                partial_controller_evidence_sealed: false,
                no_exact_group_survivor: true,
                reproduce:
                  "S2_SHELL_REGRESSION_TEST=post-release-safe-checkpoint scripts/e2e-s2-krater.sh",
              },
            ]);
            expect(run.stdout).not.toContain('"code":"S2_CLEANUP_OWNERSHIP_UNPROVEN"');
            expect(run.stdout).not.toContain(
              '"code":"S2_POST_RELEASE_CONTROLLER_CLEANUP_UNPROVEN"',
            );
            expect(run.stdout).not.toContain(
              '"code":"S2_EVIDENCE_PUBLICATION_SKIPPED_UNPROVEN_CLEANUP"',
            );
          } else if (mode === "legacy-leader-loss-transient-ps") {
            const transientProof = ndjsonRecords(run).find(
              (entry) => entry.assertion === "payload-ready-in-exact-group-with-retained-state-fd",
            );
            expect(transientProof).toMatchObject({
              detached_ps_one_shot_consumed: true,
              detached_ps_one_shot_stage: "pre-arm",
              payload_in_exact_group: true,
              state_fd_held: true,
            });
            expect(transientProof?.pre_release_capture_uncertain_samples).toBeGreaterThanOrEqual(1);
            const terminalProof = ndjsonRecords(run).find(
              (entry) =>
                entry.scenario ===
                "legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group",
            );
            expect(terminalProof).toMatchObject({
              detached_ps_one_shot_consumed: true,
              detached_ps_one_shot_stage: "pre-arm",
              cleanup_action: "kill-exact-residual-group",
              reproduce:
                "S2_SHELL_REGRESSION_TEST=legacy-leader-loss-transient-ps scripts/e2e-s2-krater.sh",
            });
            expect(run.stdout).toContain('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"');
            expect(run.stdout).toContain('"action":"kill-exact-residual-group"');
          } else if (mode === "legacy-leader-loss-transient-post-arm-ps") {
            const transientProof = ndjsonRecords(run).find(
              (entry) => entry.assertion === "payload-ready-in-exact-group-with-retained-state-fd",
            );
            expect(transientProof).toMatchObject({
              detached_ps_one_shot_consumed: true,
              detached_ps_one_shot_stage: "post-arm",
              payload_in_exact_group: true,
              state_fd_held: true,
            });
            expect(transientProof?.post_arm_inspection_uncertain_samples).toBeGreaterThanOrEqual(1);
            const terminalProof = ndjsonRecords(run).find(
              (entry) =>
                entry.scenario ===
                "legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group",
            );
            expect(terminalProof).toMatchObject({
              detached_ps_one_shot_consumed: true,
              detached_ps_one_shot_stage: "post-arm",
              cleanup_action: "kill-exact-residual-group",
              reproduce:
                "S2_SHELL_REGRESSION_TEST=legacy-leader-loss-transient-post-arm-ps scripts/e2e-s2-krater.sh",
            });
            expect(run.stdout).toContain('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"');
            expect(run.stdout).toContain('"action":"kill-exact-residual-group"');
          } else if (mode === "persistent-pre-release-helper") {
            expect(run.stdout).toContain('"pre_release_resample_attempts":40');
            expect(run.stdout).toContain('"pre_release_accepted_samples":0');
            expect(run.stdout).toContain('"pre_release_rejected_samples":40');
            expect(run.stdout).toContain('"pre_release_max_group_members":2');
            expect(run.stdout).toContain('"planted_persistent_helper_pid":');
            expect(run.stdout).toContain('"planted_persistent_helper_rejected_samples":40');
            expect(run.stdout).toContain('"payload_release_refused":true');
            expect(run.stdout).toContain('"exact_pinned_group_reaped":true');
            expect(run.stdout).toContain('"no_exact_group_survivor":true');
            expect(run.stdout).toContain('"no_planted_persistent_helper_survivor":true');
          } else if (mode === "term-interrupt-cleanup") {
            expect(run.stdout).toContain(
              "term-interrupted-parent-after-term-resistant-payload-control-status-cleans-most-recent-untracked-exact-supervisor",
            );
            expect(`${run.stdout}\n${run.stderr}`).not.toContain('"status":"fail"');
            expect(`${run.stdout}\n${run.stderr}`).not.toContain(
              "s2-parent-term-secret-must-not-appear",
            );
          } else {
            expect(`${run.stdout}\n${run.stderr}`).not.toContain('"status":"fail"');
          }
        },
        () => liveS2LifecycleProcesses(runId),
      );
      console.log(JSON.stringify({ suite: "s2-shell-regression-matrix", mode, phase: "pass" }));
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a partial post-release predicate refuses the run after reaping its controller",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "post-release-safe-checkpoint",
          S2_PLANT_POST_RELEASE_PARTIAL_REFUSAL: "1",
          S2_PLANT_POST_RELEASE_PARTIAL_PENDING_BARRIER: "1",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "post-release-partial-observation-refusal",
        () => {
          const records = ndjsonRecords(run);
          expect(run.exitCode).toBe(1);
          expect(records).toContainEqual({
            tool: "bash+ps+lsof",
            package: "apps/wire",
            suite: "s2-krater-shell",
            status: "refused",
            terminal: true,
            scenario: "partial-post-release-predicate-is-never-a-ready-observation",
            code: "S2_POST_RELEASE_PARTIAL_OBSERVATION_REFUSED",
            partial_predicate_final_visible: false,
            partial_predicate_observer_samples: 0,
            partial_pending_term_barrier_observed: true,
            partial_observation_controller_reaped: true,
            partial_controller_evidence_sealed: false,
            evidence_sealing_refused: true,
            reproduce:
              "S2_SHELL_REGRESSION_TEST=post-release-safe-checkpoint S2_PLANT_POST_RELEASE_PARTIAL_REFUSAL=1 S2_PLANT_POST_RELEASE_PARTIAL_PENDING_BARRIER=1 scripts/e2e-s2-krater.sh",
          });
          expect(records).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-shell",
              status: "fail",
              code: "S2_SHELL_REGRESSION_FAILED",
              scenario: "post-release-safe-checkpoint",
              exit_code: 1,
            }),
          );
          expect(records).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-evidence",
              status: "refused",
              code: "S2_EVIDENCE_PUBLICATION_SKIPPED_PARTIAL_OBSERVATION",
            }),
          );
          expect(
            records.some(
              (record) =>
                record.suite === "s2-krater-shell" &&
                record.status === "pass" &&
                record.terminal === true,
            ),
          ).toBe(false);
          expect(
            records.some(
              (record) =>
                record.suite === "s2-krater-evidence" &&
                record.evidence_retention_status === "pass",
            ),
          ).toBe(false);
          expect(
            existsSync(resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "manifest.json")),
          ).toBe(false);
          expect(run.stdout).not.toContain('"code":"S2_CLEANUP_OWNERSHIP_UNPROVEN"');
          expect(run.stdout).not.toContain('"code":"S2_POST_RELEASE_CONTROLLER_CLEANUP_UNPROVEN"');
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: outer TERM before pending visibility carries the later child observation across cleanup",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "post-release-safe-checkpoint",
          S2_PLANT_POST_RELEASE_OUTER_TERM_BEFORE_PENDING: "1",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "outer-term-before-partial-pending",
        () => {
          const records = ndjsonRecords(run);
          expect(run.exitCode).toBe(143);
          expect(records).toContainEqual({
            tool: "bash+ps+lsof",
            package: "apps/wire",
            suite: "s2-krater-shell",
            status: "refused",
            code: "S2_POST_RELEASE_PARTIAL_OBSERVATION_PROPAGATED_DURING_EXIT_CLEANUP",
            pending_visible: true,
            final_visible: false,
            child_manifest_sealed: false,
            reproduce:
              "S2_SHELL_REGRESSION_TEST=post-release-safe-checkpoint S2_PLANT_POST_RELEASE_OUTER_TERM_BEFORE_PENDING=1 scripts/e2e-s2-krater.sh",
          });
          expect(records).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-evidence",
              status: "refused",
              code: "S2_EVIDENCE_PUBLICATION_SKIPPED_PARTIAL_OBSERVATION",
            }),
          );
          expect(
            records.some(
              (record) =>
                record.suite === "s2-krater-shell" &&
                record.status === "pass" &&
                record.terminal === true,
            ),
          ).toBe(false);
          expect(
            existsSync(resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "manifest.json")),
          ).toBe(false);
          const childRunIds = retainedPostReleaseControllerRunIds(runId);
          expect(childRunIds).toHaveLength(1);
          for (const childRunId of childRunIds) {
            expect(
              existsSync(
                resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", childRunId, "manifest.json"),
              ),
            ).toBe(false);
          }
          expect(run.stdout).not.toContain('"code":"S2_CLEANUP_OWNERSHIP_UNPROVEN"');
          expect(run.stdout).not.toContain('"code":"S2_POST_RELEASE_CONTROLLER_CLEANUP_UNPROVEN"');
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: four term-identity exit races overlap at a shared controller barrier",
    async () => {
      const barrierRoot = mkdtempSync(join(tmpdir(), "asimposium-s2-exit-race-load-"));
      const releasePendingPath = join(barrierRoot, "release.pending");
      const releasePath = join(barrierRoot, "release");
      const fixtures = Array.from({ length: 4 }, (_, index) => ({
        index,
        runId: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        barrierToken: `fixture-${index}-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      }));
      let settledBeforeRelease = 0;
      const runPromises = fixtures.map((fixture) =>
        runHarnessConcurrently(
          {
            S2_RUN_ID: fixture.runId,
            S2_SHELL_REGRESSION_TEST: "post-release-controller-term-identity-exit-race",
            S2_PLANT_POST_RELEASE_CONTROLLER_EXIT_BEFORE_TERM_IDENTITY: "1",
            S2_PLANT_POST_RELEASE_CONTROLLER_LOAD_BARRIER: "1",
            S2_PLANT_POST_RELEASE_CONTROLLER_LOAD_BARRIER_ROOT: barrierRoot,
            S2_PLANT_POST_RELEASE_CONTROLLER_LOAD_BARRIER_TOKEN: fixture.barrierToken,
            S2_PLANT_POST_RELEASE_CONTROLLER_LOAD_BARRIER_SIZE: String(fixtures.length),
          },
          S2_SHELL_REGRESSION_WATCHDOG_MS,
        ).finally(() => {
          settledBeforeRelease += 1;
        }),
      );
      let barrierFailure: Error | undefined;
      const readyRecordsByToken = new Map<string, ExitRaceLoadReadyRecord>();
      let releasePublished = false;
      try {
        const readyRecords = await waitForExitRaceLoadReadyRecords(
          barrierRoot,
          fixtures.map((fixture) => fixture.barrierToken),
          EXIT_RACE_LOAD_BARRIER_WAIT_MS,
        );
        for (const readyRecord of readyRecords) {
          readyRecordsByToken.set(readyRecord.token, readyRecord);
        }
        expect(readyRecords).toHaveLength(fixtures.length);
        expect(new Set(readyRecords.map((record) => record.controllerPid)).size).toBe(
          fixtures.length,
        );
        expect(new Set(readyRecords.map((record) => record.parentPid)).size).toBe(fixtures.length);
        expect(readyRecords.map((record) => record.token).sort()).toEqual(
          fixtures.map((fixture) => fixture.barrierToken).sort(),
        );
        expect(new Set(readyRecords.map((record) => record.size))).toEqual(
          new Set([fixtures.length]),
        );
        expect(settledBeforeRelease).toBe(0);
        expect(existsSync(releasePath)).toBe(false);
        expect(existsSync(releasePendingPath)).toBe(false);

        const barrierProcessSnapshot = captureS2LifecycleProcessTable();
        expect(barrierProcessSnapshot.status).toBe(0);
        expect(barrierProcessSnapshot.signal).toBeNull();
        const liveNonZombieRows = new Map(
          barrierProcessSnapshot.stdout
            .split("\n")
            .map((line) => line.trim().split(/\s+/u))
            .filter((fields) => fields.length >= 4 && fields[3]?.startsWith("Z") === false)
            .map((fields) => [Number(fields[0]), Number(fields[2])] as const)
            .filter(
              ([pid, parentPid]) =>
                Number.isSafeInteger(pid) &&
                pid > 0 &&
                Number.isSafeInteger(parentPid) &&
                parentPid > 0,
            ),
        );
        expect(
          readyRecords.every(
            (record) =>
              liveNonZombieRows.get(record.controllerPid) === record.parentPid &&
              liveNonZombieRows.has(record.parentPid),
          ),
        ).toBe(true);
        expect(
          readyRecords.every(
            (record) =>
              !readyRecords.some((otherRecord) => record.controllerPid === otherRecord.parentPid),
          ),
        ).toBe(true);
      } catch (error) {
        barrierFailure = error instanceof Error ? error : new Error(String(error));
      }

      try {
        writeFileSync(releasePendingPath, `exit-race-load-release ${fixtures.length}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        linkSync(releasePendingPath, releasePath);
        releasePublished = true;
      } catch (error) {
        const publicationFailure =
          error instanceof Error
            ? error
            : new Error(`release publication failed: ${String(error)}`);
        barrierFailure =
          barrierFailure === undefined
            ? publicationFailure
            : new AggregateError(
                [barrierFailure, publicationFailure],
                "exit-race load barrier observation and release publication both failed",
              );
      }

      const runs = await Promise.all(runPromises);
      const partialReadyFailures = collectAllFixtureVerificationFailures(fixtures, (fixture) => {
        const readyRecord = readExitRaceLoadReadyRecord(
          barrierRoot,
          fixture.barrierToken,
          fixtures.length,
        );
        if (readyRecord !== undefined) {
          readyRecordsByToken.set(fixture.barrierToken, readyRecord);
        }
      });
      if (partialReadyFailures.length !== 0) {
        const partialReadyFailure = new AggregateError(
          partialReadyFailures.map((failure) => failure.error),
          `partial exit-race ready-record parsing failed: fixtures=${partialReadyFailures
            .map((failure) => failure.index)
            .join(",")}`,
        );
        barrierFailure =
          barrierFailure === undefined
            ? partialReadyFailure
            : new AggregateError(
                [barrierFailure, partialReadyFailure],
                "exit-race barrier and partial ready-record parsing both failed",
              );
      }
      const survivorSnapshot = captureS2LifecycleProcessTable();
      let survivorRows: S2LifecycleProcessRow[] = [];
      let survivorSnapshotFailure: Error | undefined;
      try {
        survivorRows = parseS2LifecycleProcessRows(survivorSnapshot);
      } catch (error) {
        survivorSnapshotFailure = error instanceof Error ? error : new Error(String(error));
      }
      const failures = collectAllFixtureVerificationFailures(fixtures, (fixture, index) => {
        const run = runs[index];
        assertS2RunThenScanForSurvivors(
          `term-identity-exit-race-${fixture.index}`,
          () => {
            if (run === undefined) throw new Error(`missing concurrent exit-race run ${index}`);
            assertRetainedControllerOwnerMatchesReadyRecord(
              fixture.runId,
              readyRecordsByToken.get(fixture.barrierToken),
            );
            expect(releasePublished).toBe(true);
            expect(run.exitCode).toBe(0);
            expect(ndjsonRecords(run)).toContainEqual(
              expect.objectContaining({
                suite: "s2-krater-shell",
                status: "pass",
                terminal: true,
                scenario: "controller-exit-between-liveness-and-term-identity-is-boundedly-reaped",
                initial_live_non_zombie: true,
                term_identity_failed_after_exit: true,
                signal_sent_to_unproved_identity: false,
                controller_reaped: true,
                no_controller_survivor: true,
              }),
            );
            expect(run.stdout).not.toContain(
              '"code":"S2_POST_RELEASE_CONTROLLER_CLEANUP_UNPROVEN"',
            );
          },
          () =>
            scanS2FixtureAndRetainedControllersForSurvivors(
              fixture.runId,
              survivorRows,
              readyRecordsByToken.get(fixture.barrierToken),
              survivorSnapshotFailure,
            ),
        );
      });
      const allFailures = [
        ...(barrierFailure === undefined ? [] : [{ index: -1, error: barrierFailure }]),
        ...failures,
      ];
      if (allFailures.length !== 0) {
        throw new AggregateError(
          allFailures.map((failure) => failure.error),
          `deterministic concurrent term-identity exit-race failures: ${allFailures
            .map((failure) => (failure.index === -1 ? "barrier" : failure.index))
            .join(",")}`,
        );
      }
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: retaining the exact-reap handoff record is refused before EXIT can re-inspect it",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
          S2_PLANT_LEGACY_RETAIN_STALE_HANDOFF: "1",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "legacy-leader-loss-stale-exact-reap-handoff",
        () => {
          // The exact residual kill still occurred. The sole plant leaves the
          // packed newest-supervisor record behind, and the handoff invariant
          // catches that stale state before ordinary EXIT cleanup can mistake it
          // for a new live ownership obligation.
          expect(run.exitCode).toBe(125);
          expect(run.stdout).toContain('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"');
          expect(run.stdout).toContain('"action":"kill-exact-residual-group"');
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-local-d1-upgrade",
              status: "fail",
              code: "S2_LEGACY_REAPED_HANDOFF_STALE",
            }),
          );
          // This one defect leaves the dead server record unhanded-off. It must remain a typed
          // cleanup refusal, not become a sealed evidence manifest that a still-live owner could
          // mutate after publication.
          expect(run.stdout).toContain('"code":"S2_CLEANUP_OWNERSHIP_UNPROVEN"');
          expect(run.stdout).toContain('"code":"S2_EVIDENCE_PUBLICATION_SKIPPED_UNPROVEN_CLEANUP"');
          expect(
            existsSync(resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "manifest.json")),
          ).toBe(false);
          expect(run.stdout).not.toContain(
            "legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group",
          );
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: the ordinary clean-stop bypass cannot satisfy legacy leader-loss coverage",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
          S2_PLANT_LEGACY_CLEAN_STOP_BYPASS: "1",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "legacy-leader-loss-clean-stop-bypass",
        () => {
          expect(run.exitCode).toBe(1);
          expect(run.stdout).toContain(
            '"assertion":"payload-ready-in-exact-group-with-retained-state-fd"',
          );
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-shell",
              status: "fail",
              code: "S2_LEGACY_LEADER_LOSS_BRANCH_NOT_REACHED",
              observed: "ordinary-clean-stop",
              expected: "inspection-uncertain-exact-residual-group",
            }),
          );
          expect(run.stdout).toContain('"code":"S2_SHELL_REGRESSION_FAILED"');
          expect(run.stdout).not.toContain('"code":"S2_CLEANUP_OWNERSHIP_UNPROVEN"');
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-evidence",
              status: "fail",
              evidence_retention_status: "pass",
              captured_exit_code: 1,
              captured_run_status: "fail",
            }),
          );
          expect(run.stdout).not.toContain('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"');
          expect(run.stdout).not.toContain('"action":"kill-exact-residual-group"');
          expect(run.stdout).not.toContain(
            "legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group",
          );
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a post-KILL proof refusal never masquerades as an unreached KILL branch",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
          // Enabling the test-only barrier without its required identity tuple fails only after
          // the exact residual KILL has been sent and the group has disappeared.
          S2_PLANT_LEGACY_POSTCONDITION_LOAD_BARRIER: "1",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "legacy-leader-loss-post-kill-proof-refusal",
        () => {
          expect(run.exitCode).toBe(1);
          expect(run.stdout).toContain('"action":"kill-exact-residual-group"');
          expect(run.stdout).toContain('"code":"S2_LEGACY_POSTCONDITION_BARRIER_FAILED"');
          expect(run.stdout).not.toContain('"code":"S2_LEGACY_LEADER_LOSS_BRANCH_NOT_REACHED"');
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-evidence",
              status: "fail",
              evidence_retention_status: "pass",
              captured_exit_code: 1,
              captured_run_status: "fail",
            }),
          );
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a legacy supervisor exit after arm reports its exact publication checkpoint",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
          S2_PLANT_SUPERVISOR_EXIT_BEFORE_WATCHDOG_PUBLICATION: "1",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "legacy-start-pre-publication-exit",
        () => {
          expect(run.exitCode).toBe(1);
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-shell",
              status: "fail",
              code: "S2_LEGACY_LEADER_LOSS_START_FAILED",
              start_failure_stage: "watchdog-publication",
              arm_consumed: true,
              spawn_attempted: true,
              watchdog_pid_published: false,
              supervisor_exit_status: 125,
            }),
          );
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a pre-publication TERM is distinct from gate and checkpoint failure",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
          S2_PLANT_SUPERVISOR_SIGNAL_AFTER_ARM: "TERM",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "legacy-start-pre-publication-term",
        () => {
          expect(run.exitCode).toBe(1);
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-shell",
              status: "fail",
              code: "S2_LEGACY_LEADER_LOSS_START_FAILED",
              start_failure_stage: "watchdog-arm-ack",
              startup_phase: "signal-term",
              arm_consumed: false,
              spawn_attempted: false,
              watchdog_pid_published: false,
              supervisor_exit_status: 143,
            }),
          );
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a wrong-PID launch sidecar is never reported as a completed checkpoint",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
          S2_PLANT_WATCHDOG_CHECKPOINT_CORRUPTION: "wrong-pid",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "legacy-start-wrong-pid-checkpoint",
        () => {
          expect(run.exitCode).toBe(1);
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-shell",
              status: "fail",
              code: "S2_LEGACY_LEADER_LOSS_START_FAILED",
              start_failure_stage: "watchdog-publication",
              arm_consumed: true,
              spawn_attempted: false,
              watchdog_pid_published: false,
              supervisor_exit_status: 125,
            }),
          );
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "legacy leader-loss deterministically reaches exact residual cleanup under concurrent load",
    async () => {
      const barrierRoot = mkdtempSync(join(tmpdir(), "asimposium-s2-legacy-postcondition-load-"));
      const releasePendingPath = join(barrierRoot, "release.pending");
      const releasePath = join(barrierRoot, "release");
      const fixtures = Array.from({ length: 6 }, (_, index) => ({
        index,
        runId: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        barrierToken: `fixture-${index}-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      }));
      for (const fixture of fixtures) {
        console.log(
          JSON.stringify({
            suite: "s2-legacy-leader-loss-concurrent",
            fixture: fixture.index,
            phase: "start",
          }),
        );
      }
      let settledBeforeRelease = 0;
      const runPromises = fixtures.map((fixture) =>
        runCapturedConcurrently(
          "bash",
          [SCRIPT],
          {
            S2_RUN_ID: fixture.runId,
            S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
            S2_PLANT_LEGACY_POSTCONDITION_LOAD_BARRIER: "1",
            S2_PLANT_LEGACY_POSTCONDITION_LOAD_BARRIER_ROOT: barrierRoot,
            S2_PLANT_LEGACY_POSTCONDITION_LOAD_BARRIER_TOKEN: fixture.barrierToken,
            S2_PLANT_LEGACY_POSTCONDITION_LOAD_BARRIER_SIZE: String(fixtures.length),
          },
          S2_SHELL_REGRESSION_WATCHDOG_MS,
        ).finally(() => {
          settledBeforeRelease += 1;
        }),
      );
      let barrierFailure: Error | undefined;
      let releasePublished = false;
      try {
        const readyRecords = await waitForLegacyPostconditionLoadReadyRecords(
          barrierRoot,
          fixtures.map((fixture) => fixture.barrierToken),
          LEGACY_POSTCONDITION_LOAD_BARRIER_WAIT_MS,
        );
        expect(readyRecords).toHaveLength(fixtures.length);
        expect(new Set(readyRecords.map((record) => record.controllerPid)).size).toBe(
          fixtures.length,
        );
        expect(new Set(readyRecords.map((record) => record.parentPid)).size).toBe(fixtures.length);
        expect(
          new Set(readyRecords.flatMap((record) => [record.controllerPid, record.parentPid])).size,
        ).toBe(fixtures.length * 2);
        expect(new Set(readyRecords.map((record) => record.residualPgid)).size).toBe(
          fixtures.length,
        );
        expect(readyRecords.map((record) => record.token).sort()).toEqual(
          fixtures.map((fixture) => fixture.barrierToken).sort(),
        );
        expect(new Set(readyRecords.map((record) => record.size))).toEqual(
          new Set([fixtures.length]),
        );
        expect(settledBeforeRelease).toBe(0);
        expect(existsSync(releasePath)).toBe(false);
        expect(existsSync(releasePendingPath)).toBe(false);

        const barrierRows = parseS2LifecycleProcessRows(captureS2LifecycleProcessTable());
        const liveRows = barrierRows.filter((row) => !row.status.startsWith("Z"));
        const liveRowsByPid = new Map(liveRows.map((row) => [row.pid, row] as const));
        expect(
          readyRecords.every((record) => {
            const controller = liveRowsByPid.get(record.controllerPid);
            return (
              controller?.parentPid === record.parentPid &&
              liveRowsByPid.has(record.parentPid) &&
              record.controllerPid !== record.parentPid &&
              record.residualPgid !== record.controllerPid &&
              record.residualPgid !== record.parentPid
            );
          }),
        ).toBe(true);
        expect(
          readyRecords.every((record) => liveRows.every((row) => row.pgid !== record.residualPgid)),
        ).toBe(true);
      } catch (error) {
        barrierFailure = error instanceof Error ? error : new Error(String(error));
      }

      try {
        writeFileSync(releasePendingPath, `legacy-postcondition-release ${fixtures.length}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        linkSync(releasePendingPath, releasePath);
        releasePublished = true;
      } catch (error) {
        const publicationFailure =
          error instanceof Error
            ? error
            : new Error(`legacy postcondition release publication failed: ${String(error)}`);
        barrierFailure =
          barrierFailure === undefined
            ? publicationFailure
            : new AggregateError(
                [barrierFailure, publicationFailure],
                "legacy postcondition barrier observation and release publication both failed",
              );
      }

      const runs = await Promise.all(runPromises);
      const survivorSnapshot = captureS2LifecycleProcessTable();

      const fixtureFailures = collectAllFixtureVerificationFailures(fixtures, (fixture, index) => {
        const run = runs[index];
        assertS2RunThenScanForSurvivors(
          `legacy-leader-loss-concurrent-${fixture.index}`,
          () => {
            if (run === undefined) {
              throw new Error(`concurrent fixture result missing: fixture=${fixture.index}`);
            }
            const evidencePass = run.stdout
              .split("\n")
              .some(
                (line) =>
                  line.includes('"suite":"s2-krater-evidence"') &&
                  line.includes('"status":"pass"') &&
                  line.includes('"evidence_retention_status":"pass"') &&
                  line.includes('"captured_exit_code":0') &&
                  line.includes('"captured_run_status":"pass"'),
              );
            const missing = [
              run.exitCode === 0 ? undefined : "exit-zero",
              run.stdout.includes(
                '"assertion":"payload-ready-in-exact-group-with-retained-state-fd"',
              )
                ? undefined
                : "causal-ready",
              run.stdout.includes('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"')
                ? undefined
                : "uncertainty-code",
              run.stdout.includes('"action":"kill-exact-residual-group"')
                ? undefined
                : "exact-kill-action",
              !run.stdout.includes('"code":"S2_LEGACY_EXACT_RESIDUAL_POSTCONDITION_UNPROVEN"')
                ? undefined
                : "postcondition-refusal",
              !run.stdout.includes('"code":"S2_LEGACY_POSTCONDITION_BARRIER_FAILED"')
                ? undefined
                : "barrier-refusal",
              !run.stdout.includes('"code":"S2_LEGACY_LEADER_LOSS_BRANCH_NOT_REACHED"')
                ? undefined
                : "ordinary-clean-stop-refusal",
              run.stdout.includes(
                "legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group",
              )
                ? undefined
                : "terminal-scenario",
              releasePublished ? undefined : "shared-release",
              evidencePass ? undefined : "evidence-pass",
            ].filter((entry): entry is string => entry !== undefined);
            if (missing.length !== 0) {
              throw new Error(
                `concurrent fixture proof incomplete: fixture=${fixture.index}; ` +
                  `missing=${missing.join(",")}; ` +
                  `codes=${typedDiagnosticCodes(run).join(",") || "NO_TYPED_CODE"}; ` +
                  `stdout_bytes=${Buffer.byteLength(run.stdout)}; ` +
                  `stderr_bytes=${Buffer.byteLength(run.stderr)}; ` +
                  `retained_logs=${run.retainedLogs}`,
              );
            }
          },
          () => parseS2LifecycleProcessTable(fixture.runId, survivorSnapshot),
        );
        console.log(
          JSON.stringify({
            suite: "s2-legacy-leader-loss-concurrent",
            fixture: fixture.index,
            phase: "pass",
          }),
        );
      });
      const failures = fixtureFailures.map(({ index, error }) => {
        const fixture = fixtures[index];
        const run = runs[index];
        console.log(
          JSON.stringify({
            suite: "s2-legacy-leader-loss-concurrent",
            fixture: fixture?.index ?? index,
            phase: "fail",
            code: "S2_CONCURRENT_FIXTURE_FAILED",
            exit_code: run?.exitCode ?? 125,
            typed_codes: run === undefined ? [] : typedDiagnosticCodes(run),
            stdout_bytes: run === undefined ? 0 : Buffer.byteLength(run.stdout),
            stderr_bytes: run === undefined ? 0 : Buffer.byteLength(run.stderr),
            retained_logs: run?.retainedLogs ?? "unavailable",
          }),
        );
        return new Error(
          `concurrent fixture failed: fixture=${fixture?.index ?? index}; ` +
            `retained_logs=${run?.retainedLogs ?? "unavailable"}`,
          { cause: error },
        );
      });
      const allFailures = [...(barrierFailure === undefined ? [] : [barrierFailure]), ...failures];
      if (allFailures.length !== 0) {
        throw new AggregateError(
          allFailures,
          `concurrent S2 legacy leader-loss verification failed: ` +
            `barrier=${barrierFailure === undefined ? "pass" : "fail"}; ` +
            `fixtures=${fixtureFailures.map(({ index }) => fixtures[index]?.index ?? index).join(",") || "none"}`,
        );
      }
    },
    CONCURRENT_LEGACY_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a retained evidence receipt labels the failed run it captured",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        { S2_RUN_ID: runId, S2_SHELL_REGRESSION_TEST: "not-a-registered-mode" },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      expect(run.exitCode).toBe(2);
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-shell",
          status: "fail",
          code: "S2_SHELL_REGRESSION_FAILED",
          exit_code: 2,
        }),
      );
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-evidence",
          status: "fail",
          evidence_retention_status: "pass",
          captured_exit_code: 2,
          captured_run_status: "fail",
        }),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  /**
   * The owned-command wrappers.
   *
   * `s2_run_owned_deadline` and `s2_bounded_capture` are the only bound on every
   * external command the harness runs, so a wrapper that can hang is a harness
   * that can hang. Both plants below run against the real helpers rather than a
   * copy, and both target a specific way the previous implementation failed to
   * return at all — not merely returned late.
   */
  test(
    "PLANTED: a deadline expiring before setsid still terminates and reaps",
    () => {
      const run = runHarnessSync(
        {
          S2_RUN_ID: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          S2_SHELL_REGRESSION_TEST: "owned-wrapper-pre-setsid",
        },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      expect(run.exitCode).toBe(0);
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-shell",
          status: "pass",
          scenario: "owned-wrapper-deadline-before-setsid-terminates-without-hanging",
          // 124 is the honest timeout. 123 would mean the group outlived the
          // kill, which is a different fact and must not read as a clean one.
          wrapper_status: 124,
          survivors: 0,
        }),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a TERM-resistant descendant is escalated to KILL and proven gone",
    () => {
      const run = runHarnessSync(
        {
          S2_RUN_ID: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          S2_SHELL_REGRESSION_TEST: "owned-wrapper-term-resistant",
        },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      expect(run.exitCode).toBe(0);
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-shell",
          status: "pass",
          scenario: "owned-wrapper-term-resistant-descendant-is-killed-and-proven-gone",
          survivors: 0,
        }),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  /**
   * Listener attribution.
   *
   * Six S-2 fixtures run concurrently and can collide on a port, so a
   * machine-global listener scan reported a healthy sibling as this run's
   * survivor. Ownership is now decided by exact pgid, marker, or persist path.
   * The plant runs all three cases against a real concurrent listener, because
   * assigning distinct ports would hide the defect rather than prove it fixed.
   */
  test(
    "PLANTED: a concurrent foreign listener is not this run's survivor, but owned ones are",
    () => {
      const run = runHarnessSync(
        {
          S2_RUN_ID: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          S2_SHELL_REGRESSION_TEST: "foreign-listener-attribution",
        },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      expect(run.exitCode).toBe(0);
      const records = ndjsonRecords(run);
      // The foreign listener gets its own typed diagnostic and does not fail
      // this run: an honest observation about someone else.
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-foreign-listener",
          status: "info",
          code: "S2_FOREIGN_LISTENER_OBSERVED",
          owned_listener_pids: "",
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-shell",
          status: "pass",
          scenario:
            "concurrent-foreign-listener-is-not-this-runs-survivor-while-marker-and-pgid-owned-listeners-still-are",
          // Not blanket permissiveness: a marker-named listener is still caught
          // by the process sweep, and a pgid-owned one by the listener scan.
          marker_check: "process-match",
          pgid_check: "listener-scan",
        }),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  /**
   * The frozen source snapshot.
   *
   * The commit used to be linked to a live working tree that was checked and
   * then left unlocked. It is now linked to bytes already written to retained
   * evidence, which later drift cannot move.
   */
  test(
    "the source snapshot is frozen, exact, and cannot be rewritten",
    () => {
      const run = runHarnessSync(
        {
          S2_RUN_ID: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          S2_SHELL_REGRESSION_TEST: "source-snapshot-freeze",
        },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      expect(run.exitCode).toBe(0);
      const records = ndjsonRecords(run);
      const snapshot = records.find((record) => record.suite === "s2-source-snapshot");
      expect(snapshot).toEqual(
        expect.objectContaining({ status: "pass", aggregate_digest: expect.any(String) }),
      );
      // Every provenance path is covered, not a convenient subset.
      expect(snapshot?.entries).toBe(declaredSourcePaths().length);
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-shell",
          status: "pass",
          scenario: "source-snapshot-is-frozen-exact-and-not-rewritable",
        }),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  /**
   * Execution-source closure.
   *
   * The retained receipt is S-2 Krater evidence, not a cost-model artifact: its
   * manifest version is `s2-krater-evidence-v2`, its scope is
   * `local-workerd-d1-do`, its bindings name DB and KRATER_OUTBOX, and its p95
   * fields measure the Worker write path. So `source_digest` has to close over
   * the executed Worker bytes, not only over the cost verifier.
   *
   * A hand-maintained list cannot support that: it was silently missing
   * `scripts/harness/runner.ts` and `packages/contracts/src/diagnostic-safety.ts`.
   * The harness now derives closure from the import graph over all five entry
   * points, and this walk is independent of the harness so a deleted or
   * bypassed checker still fails here.
   */
  const CLOSURE_ENTRY_POINTS = [
    "scripts/verify-cost-model.ts",
    "apps/wire/src/krater/worker.ts",
    "apps/wire/src/krater/krater.ts",
    "apps/wire/src/krater/outbox-do.ts",
    "apps/wire/src/krater/s2-client.ts",
  ];

  test("the declared source list is closed over every executed import graph", () => {
    const listed = new Set(declaredSourcePaths());
    const walk = spawnSync(
      "bun",
      [
        "--eval",
        `
        import {
          closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
        } from "node:fs";
        import { dirname, isAbsolute, relative, resolve } from "node:path";
        const repoRoot = realpathSync(process.cwd());
        const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
        const withinRepo = (candidate) => {
          const rel = relative(repoRoot, candidate);
          return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
        };
        const sourceError = (reason) => { throw new Error(reason); };
        const inspectSafeSource = (candidate) => {
          if (!withinRepo(candidate)) sourceError("source-escapes-repository");
          let info;
          try {
            info = lstatSync(candidate);
          } catch (error) {
            if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
            sourceError("source-lstat-failed");
          }
          if (info.isSymbolicLink()) sourceError("symlinked-source");
          if (!info.isFile()) return undefined;
          if (info.size > MAX_SOURCE_BYTES) sourceError("source-too-large");
          let real;
          try { real = realpathSync(candidate); } catch { sourceError("source-realpath-failed"); }
          if (real !== candidate || !withinRepo(real)) sourceError("symlinked-source");
          return info;
        };
        const isSafeSourceFile = (candidate) => inspectSafeSource(candidate) !== undefined;
        const readTrustedSource = (candidate) => {
          const checked = inspectSafeSource(candidate);
          if (checked === undefined) sourceError("unreadable-source");
          let descriptor;
          try {
            descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
          } catch {
            sourceError("source-open-failed");
          }
          try {
            let info;
            try { info = fstatSync(descriptor); } catch { sourceError("source-fstat-failed"); }
            if (!info.isFile()) sourceError("non-regular-source");
            if (info.size > MAX_SOURCE_BYTES) sourceError("source-too-large");
            if (info.dev !== checked.dev || info.ino !== checked.ino) {
              sourceError("source-raced-before-read");
            }
            const buffer = Buffer.alloc(info.size);
            let offset = 0;
            while (offset < info.size) {
              let bytesRead;
              try {
                bytesRead = readSync(descriptor, buffer, offset, info.size - offset, offset);
              } catch {
                sourceError("source-read-failed");
              }
              if (bytesRead <= 0) break;
              offset += bytesRead;
            }
            if (offset !== info.size) sourceError("short-source-read");
            return buffer.toString("utf8");
          } finally {
            try { closeSync(descriptor); } catch { /* no trusted bytes after close failure */ }
          }
        };
        const listed = new Set(
          ${JSON.stringify(declaredSourcePaths())}.map((path) => resolve(repoRoot, path)),
        );
        const packageRoot = resolve(repoRoot, "packages/contracts");
        const packageManifestPath = resolve(packageRoot, "package.json");
        const exportsMapFor = () => {
          if (!listed.has(packageManifestPath)) sourceError("package-manifest-unlisted");
          if (!isSafeSourceFile(packageManifestPath)) sourceError("package-manifest-unreadable");
          let manifest;
          try { manifest = JSON.parse(readTrustedSource(packageManifestPath)); } catch (error) {
            if (error instanceof Error && error.message.startsWith("source-")) throw error;
            sourceError("package-manifest-json-invalid");
          }
          if (manifest === null || typeof manifest !== "object") {
            sourceError("package-manifest-json-invalid");
          }
          const exportsMap = manifest.exports ?? {};
          if (exportsMap === null || typeof exportsMap !== "object") {
            sourceError("package-manifest-json-invalid");
          }
          return exportsMap;
        };
        // The Worker sources import extensionless, so a resolver without this
        // cannot walk them at all — it throws ENOENT on "./krater".
        const resolveLocalFile = (base) => {
          if (!withinRepo(base)) sourceError("import-escapes-repository");
          for (const candidate of [base, base + ".ts", base + "/index.ts"]) {
            if (isSafeSourceFile(candidate)) return candidate;
          }
          sourceError("unresolved-relative-import");
        };
        const resolveSpecifier = (specifier, importer) => {
          if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return undefined;
          if (specifier.startsWith(".")) {
            return resolveLocalFile(resolve(dirname(importer), specifier));
          }
          if (specifier === "@asimposium/contracts" || specifier.startsWith("@asimposium/contracts/")) {
            const subpath = specifier === "@asimposium/contracts"
              ? "."
              : "./" + specifier.slice("@asimposium/contracts/".length);
            const target = exportsMapFor()[subpath];
            if (typeof target !== "string") sourceError("unmapped-export");
            return resolve(packageRoot, target);
          }
          return undefined;
        };
        const STATIC = /(?:^|[\\s;}])(?:import|export)[^;]*?from\\s*["\\x27]([^"\\x27]+)["\\x27]/g;
        const BARE = /(?:^|[\\s;}])import\\s*["\\x27]([^"\\x27]+)["\\x27]/g;
        // Mirrored from the harness gate. A dynamic import cannot be closed over
        // by a digest at all, and if only one of the two walkers rejected it
        // they would disagree about what closure means.
        const DYNAMIC = /\\bimport\\s*\\(/;
        const seen = new Set();
        const walk = (pathname) => {
          const absolute = resolve(repoRoot, pathname);
          if (seen.has(absolute)) return;
          seen.add(absolute);
          if (!withinRepo(absolute)) sourceError("entry-escapes-repository");
          if (!listed.has(absolute)) sourceError("unlisted-source");
          if (!isSafeSourceFile(absolute)) sourceError("unreadable-source");
          const source = readTrustedSource(absolute);
          DYNAMIC.lastIndex = 0;
          if (DYNAMIC.test(source)) sourceError("dynamic-import");
          for (const pattern of [STATIC, BARE]) {
            pattern.lastIndex = 0;
            let match = pattern.exec(source);
            while (match !== null) {
              const next = resolveSpecifier(match[1], absolute);
              if (next !== undefined) walk(next);
              match = pattern.exec(source);
            }
          }
        };
        const KNOWN_REASONS = new Set([
          "dynamic-import", "entry-escapes-repository", "import-escapes-repository",
          "non-regular-source", "package-manifest-json-invalid", "package-manifest-unlisted",
          "package-manifest-unreadable", "short-source-read", "source-escapes-repository",
          "source-fstat-failed", "source-lstat-failed", "source-open-failed", "source-raced-before-read",
          "source-read-failed", "source-realpath-failed", "source-too-large", "symlinked-source",
          "unlisted-source", "unmapped-export", "unreadable-source", "unresolved-relative-import",
        ]);
        try {
          for (const entry of ${JSON.stringify(CLOSURE_ENTRY_POINTS)}) walk(entry);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          process.stdout.write("walk-error\\t" + (KNOWN_REASONS.has(reason) ? reason : "walker-native-failure"));
          process.exit(0);
        }
        process.stdout.write([...seen].map((p) => relative(repoRoot, p)).sort().join("\\n"));
        `,
      ],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    expect(walk.status).toBe(0);
    const reached = walk.stdout.split("\n").filter(Boolean);
    // A vacuous walk would make the closure assertion trivially true, so the
    // cost-model and Worker halves are both required to be present.
    expect(reached).toContain("scripts/harness/runner.ts");
    expect(reached).toContain("packages/contracts/src/diagnostic-safety.ts");
    expect(reached).toContain("apps/wire/src/krater/worker.ts");
    expect(reached).toContain("apps/wire/src/krater/krater.ts");
    expect(reached).toContain("apps/wire/src/krater/outbox-do.ts");
    expect(reached).toContain("apps/wire/src/krater/s2-client.ts");
    expect(reached.length).toBeGreaterThan(10);
    expect(reached.filter((path) => !listed.has(path))).toEqual([]);
  });

  /**
   * Containment.
   *
   * The walker resolves relative specifiers, which makes every import string an
   * input it must not trust. Without a repository-root rule, an import shaped
   * like `../../../../tmp/x` would be read and its absolute path serialized into
   * the published closure record. The plant appends an escaping entry point so
   * the real gate is exercised, rather than putting an escaping import into the
   * repository to be scanned.
   */
  test("PLANTED: a relative traversal closure entry point is refused", () => {
    const escapingEntry = "../../../../outside-repository/closure-plant.ts";
    const run = runHarnessSync(
      {
        S2_RUN_ID: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        S2_PLANT_SOURCE_CLOSURE_ESCAPE_ENTRY: escapingEntry,
      },
      S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
    );
    const records = ndjsonRecords(run);
    expect(records).toContainEqual(
      expect.objectContaining({
        suite: "s2-krater-source-closure",
        status: "fail",
        // A containment breach is a walk error, not an "unlisted" finding: the
        // latter would publish the out-of-tree path it just refused to trust.
        code: "S2_SOURCE_CLOSURE_WALK_FAILED",
        reason: "entry-escapes-repository",
      }),
    );
    expect(run.stdout).not.toContain("S2_SOURCE_CLOSURE_INCOMPLETE");
    expect(run.stdout).not.toContain("outside-repository");
    expect(run.stdout).not.toContain(REPOSITORY_ROOT);
    expect(
      records.some(
        (record) => record.suite === "s2-krater-source-closure" && record.status === "pass",
      ),
    ).toBe(false);
  });

  test("the harness publishes exactly the entry points it verified", () => {
    // An advertised scope narrower than the walked scope is the same class of
    // overstatement the closure gate exists to prevent.
    const script = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
    const block = /^readonly -a S2_CLOSURE_ENTRY_POINT_LIST=\(\n([\s\S]*?)^\)$/m.exec(script);
    const body = block?.[1];
    if (body === undefined) throw new Error("S2_CLOSURE_ENTRY_POINT_LIST not found");
    const declared = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(declared).toEqual(CLOSURE_ENTRY_POINTS);
    const listed = new Set(declaredSourcePaths());
    for (const entry of declared) expect(listed.has(entry)).toBe(true);
  });

  test(
    "every run publishes a source-closure verdict, so a removed checker is visible",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        { S2_RUN_ID: runId, S2_SHELL_REGRESSION_TEST: "source-provenance-drift" },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-source-closure",
          status: "pass",
          entry_point_count: 5,
          // Exact, not a substring match: a partial assertion would still pass if
          // the harness silently narrowed the published scope back to the cost
          // verifier, which is precisely the overstatement this record guards.
          entry_points: CLOSURE_ENTRY_POINTS.join(","),
        }),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: omitting the contracts manifest fails before it can direct bare-import resolution",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "provenance",
          S2_PLANT_SOURCE_CLOSURE_OMIT: "packages/contracts/package.json",
        },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      const records = ndjsonRecords(run);
      expect(run.exitCode).toBe(1);
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-source-closure",
          status: "fail",
          code: "S2_SOURCE_CLOSURE_WALK_FAILED",
          reason: "package-manifest-unlisted",
        }),
      );
      expect(run.stdout).not.toContain("packages/contracts/package.json");
      expect(run.stdout).not.toContain(REPOSITORY_ROOT);
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication"');
      expect(
        records.some(
          (record) => record.suite === "s2-krater-source-closure" && record.status === "pass",
        ),
      ).toBe(false);
      expect(
        existsSync(resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "manifest.json")),
      ).toBe(false);
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a run-owned dynamic import is rejected by both closure walkers before publication",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "provenance",
          S2_PLANT_SOURCE_CLOSURE_DYNAMIC_IMPORT: "1",
        },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      const records = ndjsonRecords(run);
      expect(run.exitCode).toBe(1);
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-source-closure",
          status: "fail",
          code: "S2_SOURCE_CLOSURE_WALK_FAILED",
          reason: "dynamic-import",
        }),
      );
      expect(run.stdout).not.toContain("closure-dynamic-import.ts");
      expect(run.stdout).not.toContain(REPOSITORY_ROOT);
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication"');
      expect(
        records.some(
          (record) => record.suite === "s2-krater-source-closure" && record.status === "pass",
        ),
      ).toBe(false);

      const independent = spawnSync(
        "bun",
        [
          "--eval",
          `
          import {
            closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
          } from "node:fs";
          import { isAbsolute, relative, resolve } from "node:path";
          const root = realpathSync(process.cwd());
          const candidate = resolve(root, Bun.argv[1]);
          const within = (path) => {
            const rel = relative(root, path);
            return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
          };
          const fail = (reason) => { throw new Error(reason); };
          if (!within(candidate)) fail("source-escapes-repository");
          let checked;
          try { checked = lstatSync(candidate); } catch { fail("source-lstat-failed"); }
          if (checked.isSymbolicLink()) fail("symlinked-source");
          if (!checked.isFile()) fail("non-regular-source");
          if (checked.size > 4 * 1024 * 1024) fail("source-too-large");
          let real;
          try {
            real = realpathSync(candidate);
          } catch {
            fail("source-realpath-failed");
          }
          if (real !== candidate) fail("symlinked-source");
          let descriptor;
          try { descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW); } catch {
            fail("source-open-failed");
          }
          let source;
          try {
            let opened;
            try { opened = fstatSync(descriptor); } catch { fail("source-fstat-failed"); }
            if (!opened.isFile()) fail("non-regular-source");
            if (opened.size > 4 * 1024 * 1024) fail("source-too-large");
            if (opened.dev !== checked.dev || opened.ino !== checked.ino) fail("source-raced-before-read");
            const bytes = Buffer.alloc(opened.size);
            let read;
            try { read = readSync(descriptor, bytes, 0, opened.size, 0); } catch {
              fail("source-read-failed");
            }
            if (read !== opened.size) fail("short-source-read");
            source = bytes.toString("utf8");
          } finally {
            try { closeSync(descriptor); } catch { /* fixed failure is enough for this plant */ }
          }
          if (/\\bimport\\s*\\(/.test(source)) {
            process.stdout.write("dynamic-import");
            process.exit(0);
          }
          process.stdout.write("dynamic-import-missed");
          `,
          "--",
          `e2e/artifacts/s2-krater/${runId}/main/closure-dynamic-import.ts`,
        ],
        { cwd: REPOSITORY_ROOT, encoding: "utf8" },
      );
      expect(independent.status).toBe(0);
      expect(independent.stderr).toBe("");
      expect(independent.stdout).toBe("dynamic-import");
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test.each([
    // Cost-model side.
    ["scripts/harness/runner.ts"],
    ["packages/contracts/src/diagnostic-safety.ts"],
    // Worker side. These two are the reason the gate had to learn extensionless
    // resolution: the Worker sources import `./krater` and `./outbox-do`, so
    // before that the walk threw ENOENT and produced a walk-error instead of a
    // closure verdict. An omission here could not have been detected at all.
    ["apps/wire/src/krater/krater.ts"],
    ["apps/wire/src/krater/outbox-do.ts"],
  ])(
    "PLANTED: omitting the live dependency %s from the list is refused before any run",
    (omitted) => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        { S2_RUN_ID: runId, S2_PLANT_SOURCE_CLOSURE_OMIT: omitted },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      const records = ndjsonRecords(run);
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-source-closure",
          status: "fail",
          code: "S2_SOURCE_CLOSURE_INCOMPLETE",
          // The exact omitted dependency, not a generic count.
          unlisted: omitted,
        }),
      );
      // Refused before the run does anything: no phase, no receipt, no
      // publication, and no source-provenance digest over the wrong list.
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication"');
      expect(run.stdout).not.toContain('"suite":"s2-krater-source-provenance"');
      expect(
        records.some(
          (record) => record.suite === "s2-krater-source-closure" && record.status === "pass",
        ),
      ).toBe(false);
      expect(
        existsSync(resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "manifest.json")),
      ).toBe(false);
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test("the expected migration journal tracks db/migrations exactly and in order", () => {
    // Registration only: pane2 owns 0015's content and its own tests. What this
    // asserts is that the S2 harness cannot silently fall behind a new migration
    // and keep passing its upgrade lanes against a stale journal.
    const onDisk = readdirSync(resolve(REPOSITORY_ROOT, "db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(declaredMigrationJournal()).toEqual(onDisk);
    expect(onDisk).toContain("0015_sponsor_enrollment_bootstrap_invariant.sql");
    const listed = new Set(declaredSourcePaths());
    for (const name of onDisk) expect(listed.has(`db/migrations/${name}`)).toBe(true);
  });

  test(
    "PLANTED: an in-list byte change is caught by the end-of-run digest re-read",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        { S2_RUN_ID: runId, S2_SHELL_REGRESSION_TEST: "source-provenance-drift" },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      expect(run.exitCode).toBe(125);
      // SCOPE OF THIS PROOF, stated exactly: the drifted file is a retained copy
      // of a real dependency, and the copy is what the digest lists — it is not
      // the module Bun executes. So this proves the end-of-run digest re-reads
      // its inputs and refuses publication when listed bytes change mid-run. It
      // does NOT prove the list covers the execution graph; that is the separate
      // closure gate above, whose plant omits a genuinely live dependency.
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-shell",
          scenario: "planted-source-provenance-drift-requires-receipt-publication-refusal",
          mutated_hashed_source: "main/drifted-runner.ts",
          drift_origin: "scripts/harness/runner.ts",
        }),
      );

      // Real bytes rather than filler: the copy must carry the original
      // module's bytes verbatim as its prefix.
      const driftOrigin = resolve(REPOSITORY_ROOT, "scripts/harness/runner.ts");
      const originalBytes = readFileSync(driftOrigin, "utf8");
      const driftedBytes = readFileSync(
        resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "main/drifted-runner.ts"),
        "utf8",
      );
      expect(driftedBytes.startsWith(originalBytes)).toBe(true);
      expect(driftedBytes).toContain('s2PlantedRunnerDrift = "after"');
      expect(driftedBytes).not.toBe(originalBytes);

      // The working tree is never written. A regression that edited shared
      // source would corrupt every concurrent run on this checkout.
      expect(originalBytes).not.toContain("s2PlantedRunnerDrift");

      // And the dependency it drifted is genuinely a declared source path, so
      // the plant cannot degrade into the synthetic-bytes version it replaced.
      expect(declaredSourcePaths()).toContain("scripts/harness/runner.ts");
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-source-provenance",
          status: "fail",
          code: "S2_SOURCE_PROVENANCE_DRIFT",
          action: "retain-failed-evidence-without-cost-publication",
        }),
      );
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-evidence",
          status: "fail",
          evidence_retention_status: "pass",
          captured_exit_code: 125,
          captured_run_status: "fail",
        }),
      );
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication","status":"pass"');
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication-commit","status":"pass"');
      expect(run.stdout).not.toContain(REPOSITORY_ROOT);
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: a retained run-owned edit after the closure walk aborts the provenance sandwich",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "source-provenance-drift",
          S2_PLANT_CLOSURE_CAPTURE_RACE: "1",
        },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      const records = ndjsonRecords(run);
      expect(run.exitCode).toBe(1);
      // The matching no-race control above reaches the regular end-of-run drift
      // guard. This single-cause edit lands before that mode executes, exactly
      // between the first bounded capture and the second one.
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-source-closure",
          status: "pass",
          entry_point_count: 5,
          entry_points: CLOSURE_ENTRY_POINTS.join(","),
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-source-provenance",
          status: "fail",
          code: "S2_SOURCE_CLOSURE_CAPTURE_RACE",
        }),
      );
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication"');
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication-commit"');
      expect(run.stdout).not.toContain(REPOSITORY_ROOT);
      expect(
        existsSync(resolve(REPOSITORY_ROOT, "e2e/artifacts/s2-krater", runId, "manifest.json")),
      ).toBe(false);
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: schema-valid receipt bytes with mismatched provenance cannot enter a manifest",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        { S2_RUN_ID: runId, S2_SHELL_REGRESSION_TEST: "receipt-provenance-mismatch" },
        S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
      );
      expect(run.exitCode).toBe(125);
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-shell",
          status: "pass",
          scenario: "planted-schema-valid-receipt-provenance-mismatch-requires-manifest-refusal",
        }),
      );
      expect(ndjsonRecords(run)).toContainEqual(
        expect.objectContaining({
          suite: "s2-krater-evidence",
          status: "fail",
          code: "S2_EVIDENCE_RECEIPT_FAILED",
        }),
      );
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication","status":"pass"');
      expect(run.stdout).not.toContain('"suite":"s2-cost-publication-commit","status":"pass"');
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test(
    "PLANTED: owner-loss post-proof failure retains a typed checkpoint and zero survivors",
    () => {
      const runId = `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const run = runHarnessSync(
        {
          S2_RUN_ID: runId,
          S2_SHELL_REGRESSION_TEST: "owner-loss-uncertain",
          S2_PLANT_OWNER_LOSS_POST_PROOF_FAILURE: "1",
        },
        S2_SHELL_REGRESSION_WATCHDOG_MS,
      );
      assertS2RunThenScanForSurvivors(
        "owner-loss-uncertain-planted-checkpoint",
        () => {
          expect(run.exitCode).toBe(91);
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-shell",
              status: "fail",
              terminal: true,
              scenario: "owner-loss-uncertain",
              code: "S2_OWNER_LOSS_UNCERTAIN_PLANTED_CHECKPOINT",
              child_exit_code: 137,
              record_available: true,
              health_file_available: true,
              exact_group_survives: false,
              watchdog_survives: false,
            }),
          );
          expect(ndjsonRecords(run)).toContainEqual(
            expect.objectContaining({
              suite: "s2-krater-evidence",
              status: "fail",
              evidence_retention_status: "pass",
              captured_exit_code: 91,
              captured_run_status: "fail",
            }),
          );
          expect(run.stdout).not.toContain(
            '"scenario":"controller-loss-plus-leader-loss-plus-term-resistant-member-bounds-owner-loss-inspection-and-watchdog-self-retires"',
          );
        },
        () => liveS2LifecycleProcesses(runId),
      );
    },
    S2_SHELL_REGRESSION_TEST_TIMEOUT_MS,
  );

  test("an explicit evidence run id is constrained to one safe path component", async () => {
    const run = await runHarness({ S2_RUN_ID: "../not-a-run" }, 30_000);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('"code":"S2_EVIDENCE_RUN_ID_INVALID"');
  });

  test("real-Wrangler lifecycle proof is integration-only and cannot go vacuously green", () => {
    expect(existsSync(REAL_BINDING_INTEGRATION)).toBe(true);
    const source = readFileSync(REAL_BINDING_INTEGRATION, "utf8");
    expect(source).toContain("S2_REAL_BINDING_PROOF_BLOCKED");
    expect(source).toContain("S2_WRANGLER_REQUIRED_FOR_LIFECYCLE_PROOF");
    expect(source).toContain("S2_LIFECYCLE_TEST");
    expect(source).not.toContain('throw new Error("S2_REAL_BINDING');
  });

  test("the direct real-binding capability probe emits a typed blocker before Wrangler lifecycle work", async () => {
    const run = await probeRealBindingCapability();
    expect(run.exitCode).toBe(78);
    const recordLine = run.stdout.split("\n").findLast((line) => line.startsWith("{"));
    expect(recordLine).toBeDefined();
    const record = JSON.parse(recordLine ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      tool: "bun",
      package: "apps/wire",
      suite: "s2-krater-real-bindings",
      status: "blocked",
      exit_code: 78,
      code: "S2_REAL_BINDING_PROOF_BLOCKED",
    });
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(
      "runs only with explicit integration authority",
    );
  });
});
