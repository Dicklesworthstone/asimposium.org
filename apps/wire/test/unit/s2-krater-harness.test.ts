import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { S2_COST_RECEIPT_BINDINGS_KEYS, S2_COST_RECEIPT_ROOT_KEYS } from "@asimposium/contracts";

import {
  buildS2CostMeasurementReceipt,
  S2_COST_RECEIPT_RELATIVE_PATH,
  type S2CostReceiptProvenance,
  type S2SettledWriteResult,
  writeS2CostMeasurementReceipt,
} from "../../src/krater/s2-client.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = "scripts/e2e-s2-krater.sh";
const REAL_BINDING_INTEGRATION = resolve(
  REPOSITORY_ROOT,
  "apps/wire/test/integration/s2-krater-real-bindings.test.ts",
);
const S2_SHELL_REGRESSION_WATCHDOG_MS = 90_000;
const S2_SHELL_REGRESSION_TEST_TIMEOUT_MS = 120_000;
const CONCURRENT_CONTROLLER_SETUP_MS = 5_000;
const CONCURRENT_PROCESS_GROUP_GRACE_MS = 2_000;
const CONCURRENT_CAPTURE_TEST_TIMEOUT_MS = 25_000;
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

function parseS2LifecycleProcessTable(runId: string, snapshot: ProcessTableCapture): string[] {
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
  // Command text proves ownership but can also contain caller-supplied arguments.
  // Return only the non-sensitive process identity fields used in diagnostics.
  return lines
    .filter((line) => line.includes(`e2e/artifacts/s2-krater/${runId}/`))
    .map((line) => line.trim().split(/\s+/u).slice(0, 4).join(" "));
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
    expect(start).toContain("IFS= read -r -t 0.2 value <&8");
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
    expect(shell).toContain("S2_TERM_RESISTANT_START_FAILED");
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
  "parent-loss",
  "owner-loss-uncertain",
  "unowned-refusal",
  "pinned-supervisor",
  "journal-timestamps",
  "lsof-scan-failure",
  "legacy-cleanup-failure",
  "legacy-leader-loss",
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
        { S2_RUN_ID: runId, S2_SHELL_REGRESSION_TEST: mode },
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
    "legacy leader-loss deterministically reaches exact residual cleanup under concurrent load",
    async () => {
      const fixtures = Array.from({ length: 6 }, (_, index) => ({
        index,
        runId: `s2u-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
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
      const runs = await Promise.all(
        fixtures.map((fixture) =>
          runCapturedConcurrently(
            "bash",
            [SCRIPT],
            {
              S2_RUN_ID: fixture.runId,
              S2_SHELL_REGRESSION_TEST: "legacy-leader-loss",
            },
            S2_SHELL_REGRESSION_WATCHDOG_MS,
          ),
        ),
      );
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
              !run.stdout.includes('"code":"S2_LEGACY_LEADER_LOSS_BRANCH_NOT_REACHED"')
                ? undefined
                : "ordinary-clean-stop-refusal",
              run.stdout.includes(
                "legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group",
              )
                ? undefined
                : "terminal-scenario",
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
      if (failures.length !== 0) {
        throw new AggregateError(
          failures,
          `concurrent S2 legacy leader-loss verification failed: fixtures=${fixtureFailures.map(({ index }) => fixtures[index]?.index ?? index).join(",")}`,
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
