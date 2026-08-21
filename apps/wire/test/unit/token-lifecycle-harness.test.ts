import { expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = resolve(ROOT, "scripts/e2e-token-lifecycle.sh");
const PACKAGE = resolve(ROOT, "apps/wire/package.json");
const LOCAL_CONFIG = resolve(ROOT, "apps/wire/test/integration/wrangler.token-lifecycle.toml");
const LOCAL_WORKER = resolve(ROOT, "apps/wire/test/integration/token-lifecycle-local-worker.ts");
const PRODUCTION_CONFIG = resolve(ROOT, "infra/wrangler.toml");
const PRODUCTION_INDEX = resolve(ROOT, "apps/wire/src/index.ts");
const EXTERNAL_TMPDIR = "/Volumes/USB_NVME";
const OUTER_LIVE_BUDGET_MS = 180_000;
const OUTER_TERM_GRACE_MS = 15_000;
const OUTER_KILL_GRACE_MS = 5_000;

const FAULT_PLANTS = {
  TOKEN_LIFECYCLE_TEST_AUX_PID_REUSE: "0",
  TOKEN_LIFECYCLE_TEST_BUSY_PORT: "0",
  TOKEN_LIFECYCLE_TEST_CLEANUP_CENSUS_PARTIAL: "0",
  TOKEN_LIFECYCLE_TEST_DETACHED: "0",
  TOKEN_LIFECYCLE_TEST_LISTENER_DIAGNOSTIC: "0",
  TOKEN_LIFECYCLE_TEST_LISTENER_EXIT_ZERO_EMPTY: "0",
  TOKEN_LIFECYCLE_TEST_LISTENER_STDERR_NEWLINE: "0",
  TOKEN_LIFECYCLE_TEST_LISTENER_STDOUT_NEWLINE: "0",
  TOKEN_LIFECYCLE_TEST_LOG_LEAK: "0",
  TOKEN_LIFECYCLE_TEST_PANIC_OMIT_AFTER_ROW: "0",
  TOKEN_LIFECYCLE_TEST_PANIC_REJECTION_NOOP: "0",
  TOKEN_LIFECYCLE_TEST_PARTIAL_PS: "0",
  TOKEN_LIFECYCLE_TEST_PID_REUSE: "0",
  TOKEN_LIFECYCLE_TEST_PRE_GO_FAILURE: "0",
  TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL: "0",
  TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE: "0",
  TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE: "0",
  TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE: "0",
  TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE: "0",
} as const;

async function settleWithin<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<Value | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface OwnedProcessIdentity {
  readonly pid: number;
  readonly pgid: number;
  readonly nonce: string;
  readonly commandToken: string;
  readonly challengePath: string;
  readonly responsePath: string;
}

interface OwnedProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly termSent: boolean;
  readonly killSent: boolean;
  readonly reaped: boolean;
  readonly groupEmpty: boolean;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function processGroupIsEmpty(
  pgid: number,
  signalZero: (target: number) => unknown = (target) => process.kill(target, 0),
): boolean {
  try {
    signalZero(-pgid);
    return false;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

async function assertOwnedLeaderCurrent(identity: OwnedProcessIdentity): Promise<void> {
  const challenge = crypto.randomUUID();
  writeFileSync(identity.challengePath, `${challenge}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  const answered = await waitUntil(() => {
    if (!existsSync(identity.responsePath)) return false;
    const [seenChallenge, seenPid, seenPgid, seenNonce, seenCommandToken] = readFileSync(
      identity.responsePath,
      "utf8",
    )
      .trim()
      .split("\t");
    return (
      seenChallenge === challenge &&
      Number(seenPid) === identity.pid &&
      Number(seenPgid) === identity.pgid &&
      seenNonce === identity.nonce &&
      seenCommandToken === identity.commandToken
    );
  }, 2_000);
  if (!answered) {
    throw new Error("token lifecycle supervisor refused an unanchored process-group signal");
  }
  try {
    process.kill(identity.pid, 0);
  } catch {
    throw new Error("token lifecycle supervisor identity disappeared before group signal");
  }
}

async function settleSpawnFailure(
  child: ReturnType<typeof Bun.spawn>,
  exited: Promise<number>,
  identity: OwnedProcessIdentity | undefined,
  termGraceMs: number,
  killGraceMs: number,
): Promise<void> {
  let settled = await settleWithin(exited, 10);

  if (identity === undefined) {
    // Before the supervisor identity is pinned, the Bun child handle is the
    // only authority we own. Signal that direct child only; a numeric process
    // group that merely resembles its PID is never enough.
    if (settled === undefined) {
      child.kill("SIGTERM");
      settled = await settleWithin(exited, termGraceMs);
    }
    if (settled === undefined) {
      child.kill("SIGKILL");
      settled = await settleWithin(exited, killGraceMs);
    }
    if (settled === undefined) {
      throw new Error("token lifecycle provisional supervisor could not be reaped");
    }
    const singletonGroupEmpty = await waitUntil(() => processGroupIsEmpty(child.pid), killGraceMs);
    if (!singletonGroupEmpty) {
      throw new Error("token lifecycle unpinned supervisor left a process-group survivor");
    }
    return;
  }

  let groupEmpty = processGroupIsEmpty(identity.pgid);
  if (settled !== undefined && groupEmpty) return;
  if (!groupEmpty) {
    await assertOwnedLeaderCurrent(identity);
    process.kill(-identity.pgid, "SIGTERM");
  }
  if (settled === undefined) settled = await settleWithin(exited, termGraceMs);
  groupEmpty = await waitUntil(() => processGroupIsEmpty(identity.pgid), termGraceMs);
  if (settled !== undefined && groupEmpty) return;

  if (!groupEmpty) {
    // Re-authorize KILL independently. The original challenge response is not
    // authority after a grace interval in which the leader could disappear.
    await assertOwnedLeaderCurrent(identity);
    process.kill(-identity.pgid, "SIGKILL");
  }
  if (settled === undefined) settled = await settleWithin(exited, killGraceMs);
  groupEmpty = await waitUntil(() => processGroupIsEmpty(identity.pgid), killGraceMs);
  if (settled === undefined || !groupEmpty) {
    throw new Error("token lifecycle spawned supervisor did not settle after failure");
  }
}

async function runOwnedProcess(options: {
  readonly cmd: readonly string[];
  readonly expectedCommandToken: string;
  readonly readyOutput?: string;
  readonly env: Record<string, string | undefined>;
  readonly liveBudgetMs: number;
  readonly termGraceMs: number;
  readonly killGraceMs: number;
  /** Test-only causal hook: it runs after identity pinning and before go. */
  readonly beforeGo?: (pgid: number) => void;
}): Promise<OwnedProcessResult> {
  const captureRoot = existsSync(EXTERNAL_TMPDIR)
    ? EXTERNAL_TMPDIR
    : (process.env.TMPDIR ?? "/tmp");
  const captureDirectory = mkdtempSync(join(captureRoot, "asimposium-token-lifecycle-harness."));
  chmodSync(captureDirectory, 0o700);
  const stdoutPath = join(captureDirectory, "stdout.jsonl");
  const stderrPath = join(captureDirectory, "stderr.log");
  const supervisorReadyPath = join(captureDirectory, "supervisor.ready");
  const supervisorGoPath = join(captureDirectory, "supervisor.go");
  const supervisorChallengePath = join(captureDirectory, "supervisor.challenge");
  const supervisorResponsePath = join(captureDirectory, "supervisor.response");
  const supervisorStatusPath = join(captureDirectory, "supervisor.status");
  const supervisorNonce = crypto.randomUUID();
  const stdoutFd = openSync(stdoutPath, "wx", 0o600);
  const stderrFd = openSync(stderrPath, "wx", 0o600);
  closeSync(stdoutFd);
  closeSync(stderrFd);
  let identity: OwnedProcessIdentity | undefined;
  let termSent = false;
  let killSent = false;
  let reaped = false;
  let groupEmpty = false;
  let timedOut = false;
  let exitCode = -1;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let exited: Promise<number> | undefined;

  try {
    // The Perl launcher remains the group leader while its command runs. Its
    // private ready/go files prevent a short command from exiting before the
    // parent has pinned the exact leader identity. No existing or previously
    // orphaned group is inspected as a cleanup target.
    child = Bun.spawn({
      cmd: [
        "perl",
        "-MPOSIX=setsid,WNOHANG",
        "-e",
        'setsid() or die "setsid"; my $leader = $$; my $group = getpgrp(0); open(my $ready, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_READY"}) or die "ready"; print $ready join("\\t", $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_COMMAND_TOKEN"}) . "\\n"; close($ready); my $last_challenge = ""; sub answer_challenge { if (-e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"}) { open(my $challenge_file, "<", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"}) or die "challenge"; my $challenge = <$challenge_file> // ""; close($challenge_file); $challenge =~ s/\\s+$//; if ($challenge ne "" && $challenge ne $last_challenge) { open(my $response, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_RESPONSE"}) or die "response"; print $response join("\\t", $challenge, $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_COMMAND_TOKEN"}) . "\\n"; close($response); $last_challenge = $challenge; } } } until (-e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_GO"}) { answer_challenge(); select(undef, undef, undef, 0.01); } $SIG{"TERM"} = sub {}; my $worker = fork(); die "fork" unless defined($worker); if ($worker == 0) { $SIG{"TERM"} = "DEFAULT"; exec @ARGV or die "exec"; } my $status; while (1) { answer_challenge(); my $done = waitpid($worker, WNOHANG); if ($done == $worker) { $status = $?; last; } die "waitpid" if $done < 0; select(undef, undef, undef, 0.01); } my $code = ($status & 127) ? 128 + ($status & 127) : $status >> 8; open(my $status_file, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_STATUS"}) or die "status"; print $status_file join("\\t", $worker, $status, $code) . "\\n"; close($status_file); exit($code);',
        ...options.cmd,
      ],
      cwd: ROOT,
      env: {
        ...options.env,
        TOKEN_LIFECYCLE_SUPERVISOR_READY: supervisorReadyPath,
        TOKEN_LIFECYCLE_SUPERVISOR_GO: supervisorGoPath,
        TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE: supervisorChallengePath,
        TOKEN_LIFECYCLE_SUPERVISOR_RESPONSE: supervisorResponsePath,
        TOKEN_LIFECYCLE_SUPERVISOR_STATUS: supervisorStatusPath,
        TOKEN_LIFECYCLE_SUPERVISOR_NONCE: supervisorNonce,
        TOKEN_LIFECYCLE_SUPERVISOR_COMMAND_TOKEN: options.expectedCommandToken,
      },
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const spawnedChild = child;
    exited = spawnedChild.exited;
    const identityReady = await waitUntil(() => {
      if (!existsSync(supervisorReadyPath)) return false;
      const [pid, pgid, nonce, commandToken] = readFileSync(supervisorReadyPath, "utf8")
        .trim()
        .split("\t");
      if (
        Number(pid) !== spawnedChild.pid ||
        Number(pgid) !== spawnedChild.pid ||
        nonce !== supervisorNonce ||
        commandToken !== options.expectedCommandToken
      ) {
        return false;
      }
      identity = {
        pid: spawnedChild.pid,
        pgid: spawnedChild.pid,
        nonce: supervisorNonce,
        commandToken: options.expectedCommandToken,
        challengePath: supervisorChallengePath,
        responsePath: supervisorResponsePath,
      };
      return true;
    }, 5_000);
    if (!identityReady || identity === undefined) {
      throw new Error("token lifecycle supervisor could not pin its new group leader");
    }
    options.beforeGo?.(identity.pgid);
    writeFileSync(supervisorGoPath, "go\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (
      options.readyOutput !== undefined &&
      !(await waitUntil(
        () => readFileSync(stdoutPath, "utf8").includes(options.readyOutput ?? ""),
        5_000,
      ))
    ) {
      throw new Error("token lifecycle supervisor plant did not reach its causal readiness mark");
    }

    const naturalExit = await settleWithin(exited, options.liveBudgetMs);
    if (naturalExit === undefined) {
      timedOut = true;
      await assertOwnedLeaderCurrent(identity);
      process.kill(-identity.pgid, "SIGTERM");
      termSent = true;

      const termExit = await settleWithin(exited, options.termGraceMs);
      groupEmpty = await waitUntil(
        () => processGroupIsEmpty(identity?.pgid ?? -1),
        options.termGraceMs,
      );
      if (termExit === undefined || !groupEmpty) {
        // KILL is authorized only while the exact original leader identity is
        // still alive. A bare numeric PGID is never sufficient.
        await assertOwnedLeaderCurrent(identity);
        process.kill(-identity.pgid, "SIGKILL");
        killSent = true;
        const killedExit = await settleWithin(exited, options.killGraceMs);
        if (killedExit === undefined) {
          throw new Error("token lifecycle owned group leader survived SIGKILL");
        }
        exitCode = killedExit;
        reaped = true;
        groupEmpty = await waitUntil(
          () => processGroupIsEmpty(identity?.pgid ?? -1),
          options.killGraceMs,
        );
        if (!groupEmpty) throw new Error("token lifecycle owned process group survived SIGKILL");
      } else {
        exitCode = termExit;
        reaped = true;
      }
    } else {
      exitCode = naturalExit;
      reaped = true;
      groupEmpty = await waitUntil(
        () => processGroupIsEmpty(identity?.pgid ?? -1),
        options.killGraceMs,
      );
      if (!groupEmpty) {
        throw new Error("token lifecycle harness exited with an unreaped owned group");
      }
    }
  } catch (error) {
    if (child === undefined || exited === undefined) throw error;
    try {
      await settleSpawnFailure(child, exited, identity, options.termGraceMs, options.killGraceMs);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "token lifecycle supervisor failed and could not prove bounded cleanup",
      );
    }
    throw error;
  }

  return {
    exitCode,
    stdout: readFileSync(stdoutPath, "utf8"),
    stderr: readFileSync(stderrPath, "utf8"),
    timedOut,
    termSent,
    killSent,
    reaped,
    groupEmpty,
  };
}

async function runHarness(
  args: readonly string[] = [],
  plants: Partial<Record<keyof typeof FAULT_PLANTS, "1">> = {},
): Promise<OwnedProcessResult> {
  const result = await runOwnedProcess({
    cmd: ["bash", SCRIPT, ...args],
    expectedCommandToken: "e2e-token-lifecycle.sh",
    env: {
      ...process.env,
      ...FAULT_PLANTS,
      ...plants,
      TMPDIR: existsSync(EXTERNAL_TMPDIR) ? EXTERNAL_TMPDIR : process.env.TMPDIR,
    },
    liveBudgetMs: OUTER_LIVE_BUDGET_MS,
    termGraceMs: OUTER_TERM_GRACE_MS,
    killGraceMs: OUTER_KILL_GRACE_MS,
  });
  if (result.timedOut) throw new Error("token lifecycle harness exceeded its bounded local budget");
  return result;
}

test("token lifecycle harness self-test is ordinary-unit registered and never launches Wrangler", async () => {
  const result = await runHarness(["--self-test"]);
  expect(result.exitCode).toBe(0);
  expect(result.reaped).toBe(true);
  expect(result.groupEmpty).toBe(true);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    '"assertion":"self_test_transitive_source_config_migration_closure"',
  );
  expect(result.stdout).toContain('"wrangler_started":false');
  expect(result.stdout).toContain(
    '"record":"panic-credential-coverage","assertion":"panic_complete_known_minted_fellow_credential_coverage_and_pre_panic_active_token_rejection","known_fellows":5,"known_credentials":5,"pre_panic_active_tokens":2,"post_panic_rejected_tokens":2,"status":"pass"',
  );

  const packageJson = JSON.parse(readFileSync(PACKAGE, "utf8")) as {
    scripts?: Record<string, string>;
  };
  expect(packageJson.scripts?.["test:token-lifecycle:self"]).toBe(
    "bash ../../scripts/e2e-token-lifecycle.sh --self-test",
  );
  expect(packageJson.scripts?.["test:token-lifecycle:local"]).toBe(
    "bun test --timeout 180000 test/unit/token-lifecycle-harness.test.ts",
  );

  const script = readFileSync(SCRIPT, "utf8");
  expect(script).toContain('[[ "$1" == "--self-test" ]]');
  expect(script).toContain("source_closure_manifest()");
  expect(script).toContain('"scripts/e2e-token-lifecycle.sh"');
  expect(script).toContain(`TOKEN_LIFECYCLE_EXPECTED_MIGRATIONS="\${EXPECTED_MIGRATIONS[*]}"`);
  expect(script).toContain("migration closure does not match the expected journal");
  expect(script).toContain('"0028_event_attribution.sql"');
  expect(script).toContain('"wrangler_started\\":false');
  expect(script).toContain("assert_migration_journal || exit 1");
  expect(script).toContain("assert_post_stop_d1_counts || exit 1");
  const stopWorker = script.lastIndexOf("stop_worker || exit 1");
  const postStopCensus = script.lastIndexOf("assert_post_stop_d1_counts || exit 1");
  const retainedLogScan = script.lastIndexOf("scan_retained_logs || exit 1");
  const terminalPass = script.lastIndexOf("TOKEN_LIFECYCLE_LOCAL_PASSED");
  expect(stopWorker).toBeGreaterThanOrEqual(0);
  expect(stopWorker).toBeLessThan(postStopCensus);
  expect(postStopCensus).toBeLessThan(retainedLogScan);
  expect(retainedLogScan).toBeLessThan(terminalPass);
  expect(script).toContain("assert_source_closure_unchanged || exit 1");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_BUSY_PORT");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_AUX_PID_REUSE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_CLEANUP_CENSUS_PARTIAL");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_DETACHED");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_LISTENER_DIAGNOSTIC");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_LISTENER_EXIT_ZERO_EMPTY");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_LISTENER_STDERR_NEWLINE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_LISTENER_STDOUT_NEWLINE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_PARTIAL_PS");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_PID_REUSE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_LOG_LEAK");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_PRE_GO_FAILURE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Bash parameter expansion asserted against the fixture.
  expect(script).toContain('signal_probe_state "-${pgid}"');
  expect(script).toContain("cleanup_census_exit_zero_empty_cannot_false_reap");
  expect(script).toContain(
    "state_census_exit_zero_partial_after_anchor_missing_completion_refused",
  );
  expect(script).toContain("TOKEN_LIFECYCLE_STATE_CENSUS_V1_BEGIN");
  expect(script).toContain("TOKEN_LIFECYCLE_STATE_CENSUS_V1_END");
  expect(script).toContain('sha256_hex(join("", @framed))');
  expect(script).toContain("TOKEN_LIFECYCLE_STATE_FD_INSPECTION_UNAVAILABLE");
  expect(script).toContain("auxiliary_pid_reuse_identity_drift_refused_without_signal");
  expect(script).toContain("supervisor_postfork_control_failure_retired_exact_group");
  expect(script).toContain(
    "supervisor_term_reaped_direct_then_killed_same_group_term_ignoring_descendant",
  );
  expect(script).toContain('close($started) or die "started-plant-preclose"');
  expect(script).toContain(
    'print $started join("\\t", "started", $worker) . "\\n" or die "started-write"',
  );
  expect(script.indexOf('close($started) or die "started-plant-preclose"')).toBeLessThan(
    script.indexOf('print $started join("\\t", "started", $worker)'),
  );
  expect(script).not.toContain('die "planted-started-close"');
  expect(script).toContain("port_is_free final");
  expect(script).toContain("listener_exit_zero_empty_refused_as_absence");
  expect(script).toContain("listener_diagnostic_refused_as_absence");
  expect(script).toContain("listener_status_one_stdout_newline_refused_as_absence");
  expect(script).toContain("listener_status_one_stderr_newline_refused_as_absence");
  expect(script).toContain("listener-probe.stdout");
  expect(script).toContain("listener-probe.stderr");
  expect(script).toContain("state-fd.stdout");
  expect(script).toContain("state-fd.stderr");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Bash parameter expansion asserted against the fixture.
  expect(script).toContain('file_byte_size "${stdout_path}"');
  expect(script).toContain('"waitpid-negative"');
  expect(script.indexOf('open(my $started, ">"')).toBeLessThan(script.indexOf("$worker = fork()"));
  expect(script).toContain("SERVER_TARGET_GATE_OPENED=1");
  expect(script).toContain("startup_gate_supervisor_reaped_before_target_launch");
  expect(script).toContain("TOKEN_LIFECYCLE_BARRIER_CAPABILITY");
  expect(script).toContain('"deterministic_barrier":true');
  expect(script).toContain("real_workerd_d1_session_open_workshop_promote_close_same_key_races");
  expect(script).toContain("revoked_credential_refused_before_effectful_session_write");
  expect(script).toContain('"assertion":"revoke_vs_effectful_domain_write","status":"pass"');
  expect(script.indexOf("if (( SELF_TEST == 1 ))")).toBeLessThan(
    script.indexOf(`[[ -x "\${WRANGLER}" ]]`),
  );
  const config = readFileSync(LOCAL_CONFIG, "utf8");
  expect(config).toContain('main = "token-lifecycle-local-worker.ts"');
  expect(config).toContain('TOKEN_LIFECYCLE_LOCAL_HARNESS = "enabled"');
  expect(config).toContain("workers_dev = false");
  const localWorker = readFileSync(LOCAL_WORKER, "utf8");
  expect(localWorker).toContain("await barrier.awaitRevoke()");
  expect(localWorker).toContain("await sessionReplayBarrier.awaitBatch(scope)");
  expect(localWorker).toContain("`${CONTROL_" + "PREFIX}session-replay/`");
  expect(localWorker).toContain("rawStatementByWrapper");
  expect(localWorker).toContain('const CONTROL_PREFIX = "/__token-lifecycle/"');
  expect(localWorker).toContain("createApp({ createEnrollmentStore: barrierStore })");
  expect(readFileSync(PRODUCTION_CONFIG, "utf8")).not.toContain("TOKEN_LIFECYCLE_LOCAL_HARNESS");
  expect(readFileSync(PRODUCTION_INDEX, "utf8")).not.toContain("token-lifecycle");
});

test("PLANTED: the outer supervisor owns, TERM/KILLs, reaps, and empties only its new group", async () => {
  const result = await runOwnedProcess({
    cmd: [
      "bash",
      "-c",
      'trap "" TERM; printf "%s\\n" supervisor-plant-ready; while :; do sleep 1; done',
      "token-lifecycle-owned-supervisor-plant",
    ],
    expectedCommandToken: "token-lifecycle-owned-supervisor-plant",
    readyOutput: "supervisor-plant-ready",
    env: { ...process.env },
    liveBudgetMs: 100,
    termGraceMs: 100,
    killGraceMs: 5_000,
  });
  expect(result.timedOut).toBe(true);
  expect(result.termSent).toBe(true);
  expect(result.killSent).toBe(true);
  expect(result.reaped).toBe(true);
  expect(result.groupEmpty).toBe(true);
  expect(result.stdout).toBe("supervisor-plant-ready\n");
});

test("PLANTED: a pre-go assertion failure reaps and empties its pinned supervisor group", async () => {
  let pinnedPgid: number | undefined;
  let failure: unknown;
  try {
    await runOwnedProcess({
      cmd: ["bash", "-c", "printf '%s\\n' should-not-run"],
      expectedCommandToken: "token-lifecycle-pre-go-failure-plant",
      env: { ...process.env },
      liveBudgetMs: 1_000,
      termGraceMs: 1_000,
      killGraceMs: 5_000,
      beforeGo(pgid) {
        pinnedPgid = pgid;
        throw new Error("causal-pre-go-failure-plant");
      },
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("causal-pre-go-failure-plant");
  expect(pinnedPgid).toBeNumber();
  if (pinnedPgid === undefined) throw new Error("pre-go plant never pinned its group");
  expect(processGroupIsEmpty(pinnedPgid)).toBe(true);
});

test("PLANTED: group absence accepts only kernel ESRCH, never EPERM or an unknown probe fault", () => {
  const fault = (code: string) => Object.assign(new Error(code), { code });
  expect(
    processGroupIsEmpty(12345, () => {
      throw fault("ESRCH");
    }),
  ).toBe(true);
  expect(
    processGroupIsEmpty(12345, () => {
      throw fault("EPERM");
    }),
  ).toBe(false);
  expect(() =>
    processGroupIsEmpty(12345, () => {
      throw fault("EIO");
    }),
  ).toThrow("EIO");
});

const FAULT_CASES: readonly {
  readonly plant: keyof typeof FAULT_PLANTS;
  readonly code: string;
  readonly requiresWorkerCleanup: boolean;
  readonly reachesWorkerReady?: boolean;
  readonly cleanupAssertions?: readonly string[];
}[] = [
  {
    plant: "TOKEN_LIFECYCLE_TEST_PRE_GO_FAILURE",
    code: "TOKEN_LIFECYCLE_PRE_GO_FAILURE_PLANT",
    requiresWorkerCleanup: true,
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_BUSY_PORT",
    code: "TOKEN_LIFECYCLE_PORT_ALREADY_BOUND",
    requiresWorkerCleanup: false,
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_AUX_PID_REUSE",
    code: "TOKEN_LIFECYCLE_AUX_PID_REUSE_PLANT",
    requiresWorkerCleanup: false,
    cleanupAssertions: ["auxiliary_pid_reuse_identity_drift_refused_without_signal"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_PARTIAL_PS",
    code: "TOKEN_LIFECYCLE_RESPONDER_IDENTITY_UNPROVEN",
    requiresWorkerCleanup: true,
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_CLEANUP_CENSUS_PARTIAL",
    code: "TOKEN_LIFECYCLE_CLEANUP_CENSUS_PARTIAL_PLANT",
    requiresWorkerCleanup: true,
    cleanupAssertions: ["cleanup_census_exit_zero_empty_cannot_false_reap"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL",
    code: "TOKEN_LIFECYCLE_STATE_CENSUS_PARTIAL_PLANT",
    requiresWorkerCleanup: false,
    reachesWorkerReady: true,
    cleanupAssertions: ["state_census_exit_zero_partial_after_anchor_missing_completion_refused"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_LISTENER_EXIT_ZERO_EMPTY",
    code: "TOKEN_LIFECYCLE_LISTENER_EXIT_ZERO_EMPTY_PLANT",
    requiresWorkerCleanup: false,
    reachesWorkerReady: true,
    cleanupAssertions: ["listener_exit_zero_empty_refused_as_absence"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_LISTENER_DIAGNOSTIC",
    code: "TOKEN_LIFECYCLE_LISTENER_DIAGNOSTIC_PLANT",
    requiresWorkerCleanup: false,
    reachesWorkerReady: true,
    cleanupAssertions: ["listener_diagnostic_refused_as_absence"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_LISTENER_STDOUT_NEWLINE",
    code: "TOKEN_LIFECYCLE_LISTENER_STDOUT_NEWLINE_PLANT",
    requiresWorkerCleanup: false,
    reachesWorkerReady: true,
    cleanupAssertions: ["listener_status_one_stdout_newline_refused_as_absence"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_LISTENER_STDERR_NEWLINE",
    code: "TOKEN_LIFECYCLE_LISTENER_STDERR_NEWLINE_PLANT",
    requiresWorkerCleanup: false,
    reachesWorkerReady: true,
    cleanupAssertions: ["listener_status_one_stderr_newline_refused_as_absence"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE",
    code: "TOKEN_LIFECYCLE_SUPERVISOR_STARTED_FAILURE_PLANT",
    requiresWorkerCleanup: true,
    cleanupAssertions: ["supervisor_postfork_control_failure_retired_exact_group"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE",
    code: "TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE_FAILURE_PLANT",
    requiresWorkerCleanup: true,
    cleanupAssertions: ["supervisor_postfork_control_failure_retired_exact_group"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE",
    code: "TOKEN_LIFECYCLE_SUPERVISOR_WAITPID_FAILURE_PLANT",
    requiresWorkerCleanup: true,
    cleanupAssertions: ["supervisor_postfork_control_failure_retired_exact_group"],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE",
    code: "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_FAILURE_PLANT",
    requiresWorkerCleanup: true,
    cleanupAssertions: [
      "supervisor_term_reaped_direct_then_killed_same_group_term_ignoring_descendant",
      "supervisor_postfork_control_failure_retired_exact_group",
    ],
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_PID_REUSE",
    code: "TOKEN_LIFECYCLE_RESPONDER_IDENTITY_DRIFT",
    requiresWorkerCleanup: true,
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_DETACHED",
    code: "TOKEN_LIFECYCLE_DETACHED_STATE_PROCESS_DETECTED",
    requiresWorkerCleanup: true,
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_LOG_LEAK",
    code: "TOKEN_LIFECYCLE_SECRET_LOG_LEAK",
    requiresWorkerCleanup: true,
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_PANIC_OMIT_AFTER_ROW",
    code: "TOKEN_LIFECYCLE_HTTP_PROOF_FAILED",
    requiresWorkerCleanup: true,
  },
  {
    plant: "TOKEN_LIFECYCLE_TEST_PANIC_REJECTION_NOOP",
    code: "TOKEN_LIFECYCLE_HTTP_PROOF_FAILED",
    requiresWorkerCleanup: true,
  },
];

for (const current of FAULT_CASES) {
  test(`token lifecycle fault plant ${current.plant} is provider-free and causally cleaned`, async () => {
    const result = await runHarness([], { [current.plant]: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`"code":"${current.code}"`);
    expect(result.stdout).not.toContain('"code":"TOKEN_LIFECYCLE_LOCAL_PASSED"');
    if (current.requiresWorkerCleanup) {
      expect(result.stdout).toContain(
        '"assertion":"workerd_group_descendants_listener_and_state_fds_reaped","status":"pass"',
      );
    } else if (current.reachesWorkerReady !== true) {
      expect(result.stdout).not.toContain("ready_workerd_responder_pid_pgid_start_and_argv_pinned");
    }
    for (const assertion of current.cleanupAssertions ?? []) {
      expect(result.stdout).toContain(`"assertion":"${assertion}","status":"pass"`);
    }
    if (current.plant === "TOKEN_LIFECYCLE_TEST_PRE_GO_FAILURE") {
      expect(result.stdout).toContain(
        '"assertion":"startup_gate_supervisor_reaped_before_target_launch","status":"pass","wrangler_started":false',
      );
      expect(result.stdout).not.toContain("ready_workerd_responder_pid_pgid_start_and_argv_pinned");
    }
  });
}

test("PLANTED: combined lifecycle evidence omits the unevidenced active cap", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const assertions = [
    ...script.matchAll(/"assertion":"(mint_use_scope_refusal_[^"]+)","status":"pass"/g),
  ].map((match) => match[1]);

  expect(assertions).toEqual([
    "mint_use_scope_refusal_expiry_individual_revoke_panic_zero_active_credentials_cross_principal_exact_replay",
  ]);
  // PLANTED: field reordering or an additional evidence record must not let an
  // unsupported active-cap claim evade the exact combined-record selector.
  expect(script).not.toContain("active_cap");
});

test("PLANTED: shared panic verifier rejects omitted rows and a no-op rejection callback", async () => {
  for (const control of [
    "TOKEN_LIFECYCLE_TEST_PANIC_OMIT_AFTER_ROW",
    "TOKEN_LIFECYCLE_TEST_PANIC_REJECTION_NOOP",
  ] as const) {
    const result = await runHarness(["--self-test"], { [control]: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"code":"TOKEN_LIFECYCLE_PANIC_VERIFIER_SELF_TEST_FAILED"');
    expect(result.stdout).not.toContain('"record":"panic-credential-coverage"');
    expect(result.stdout).not.toContain('"code":"TOKEN_LIFECYCLE_LOCAL_PASSED"');
  }
});

test("token lifecycle bounded live local Workerd+D1 proof is ordinary-unit registered", async () => {
  const result = await runHarness();
  expect(result.exitCode).toBe(0);
  expect(result.reaped).toBe(true);
  expect(result.groupEmpty).toBe(true);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    '"assertion":"concurrent_http_same_key_revoke_exact_replay","deterministic_barrier":true',
  );
  expect(result.stdout).toContain(
    '"assertion":"concurrent_http_same_key_different_body_one_commit_one_conflict","deterministic_barrier":true',
  );
  expect(result.stdout).toContain("panic_zero_active_credentials");
  const records = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const durableIdentity = records.filter(
    (record) => record.record === "session-replay-durable-identity",
  );
  expect(durableIdentity).toHaveLength(1);
  expect(durableIdentity[0]).toEqual({
    suite: "token-lifecycle-local",
    record: "session-replay-durable-identity",
    session_id: expect.stringMatching(/^S-[A-Za-z0-9]{26}$/),
    workshop_id: expect.stringMatching(/^W-[A-Za-z0-9]{26}$/),
    claim_id: "C-1",
    seq: 1,
    status: "pass",
  });
  const authorizationRecord = records.find((record) => record.record === "authorization-decision");
  expect(authorizationRecord).toBeDefined();
  expect(authorizationRecord?.assertion).toBe(
    "central_policy_post_revoke_refusal_matches_mounted_effectful_route",
  );
  expect(authorizationRecord?.credential_id).toMatch(/^cred-[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(authorizationRecord?.fellow_id).toMatch(/^F-[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(authorizationRecord?.event_id).toMatch(/^LEV-[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(authorizationRecord?.request_id).toMatch(/^token-lifecycle-revoke-alpha-\d+$/);
  expect(authorizationRecord?.authorization_decision).toBe("refuse");
  expect(authorizationRecord?.auth_state).toBe("revoked");
  expect(authorizationRecord?.code).toBe("UNAUTHORIZED");
  const authorizationLatencyMs = authorizationRecord?.latency_ms;
  expect(authorizationLatencyMs).toBeNumber();
  if (typeof authorizationLatencyMs !== "number") {
    throw new Error("authorization latency is not numeric");
  }
  expect(Number.isFinite(authorizationLatencyMs)).toBe(true);
  expect(authorizationLatencyMs).toBeGreaterThanOrEqual(0);
  expect(authorizationLatencyMs).toBeLessThanOrEqual(60_000);
  expect(authorizationRecord?.assertion_diff).toContain("operator=credential_revoked");
  expect(authorizationRecord?.assertion_diff).toContain("canary=<redacted>");
  const panicCoverage = records.filter((record) => record.record === "panic-credential-coverage");
  expect(panicCoverage).toEqual([
    {
      suite: "token-lifecycle-local",
      record: "panic-credential-coverage",
      assertion:
        "panic_complete_known_minted_fellow_credential_coverage_and_pre_panic_active_token_rejection",
      known_fellows: 5,
      known_credentials: 5,
      pre_panic_active_tokens: 2,
      post_panic_rejected_tokens: 2,
      status: "pass",
    },
  ]);
  for (const scope of ["session_open", "workshop_push", "promote", "session_close"]) {
    expect(result.stdout).toContain(
      `"assertion":"concurrent_http_same_key_${scope}_exact_replay","deterministic_barrier":true`,
    );
  }
  expect(result.stdout).toContain(
    '"assertion":"revoked_credential_refused_before_effectful_session_write","status":"pass"',
  );
  expect(result.stdout).toContain(
    '"assertion":"post_stop_d1_exact_revoke_and_session_replay_side_effect_counts","status":"pass"',
  );
  expect(result.stdout).toContain('"assertion":"revoke_vs_effectful_domain_write","status":"pass"');
  expect(result.stdout).toContain('"code":"TOKEN_LIFECYCLE_LOCAL_PASSED"');
});

test("OPS.2a authorization evidence bounds and redacts every emitted string field", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const helper = script.slice(
    script.indexOf("function boundedEvidenceField("),
    script.indexOf("async function bootstrap("),
  );
  expect(helper.length).toBeGreaterThan(0);

  for (const field of [
    "assertion",
    "credential_id",
    "sponsor_id",
    "fellow_id",
    "scope_or_grant",
    "auth_state",
    "authorization_decision",
    "code",
    "request_id",
    "event_id",
    "assertion_diff",
    "status",
  ]) {
    expect(helper).toContain(`${field}: boundedEvidenceField(`);
  }
  expect(helper).toContain('suite: boundedEvidenceField("token-lifecycle-local")');
  expect(helper).toContain('record: boundedEvidenceField("authorization-decision")');
  expect(helper).toContain("redactCredentials(value).slice(0, limit)");
  expect(helper).toContain("AUTHORIZATION_EVIDENCE_DIFF_LIMIT");
  expect(helper).toContain("AUTHORIZATION_EVIDENCE_RECORD_LIMIT");
  expect(helper).toContain("latency_ms: boundedEvidenceLatency(input.latencyMs)");
  expect(helper).toContain("AUTHORIZATION_EVIDENCE_LATENCY_LIMIT_MS");
  expect(helper).toContain("Number.isFinite(value) && value >= 0");
  expect(helper).toContain('Buffer.byteLength(encoded, "utf8")');
});

test("PLANTED: actual authorization evidence invokes the central seam and binds real ids", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const record = script.slice(
    script.indexOf("const postRevokeNow = revokedReceipt.effective_at;"),
    script.indexOf("function activeCredentialFor("),
  );
  expect(record.length).toBeGreaterThan(0);
  expect(record).toContain("inspectFellowWriteAuthorization({");
  expect(record).toContain('operatorReason === "credential_revoked"');
  expect(record).toContain("credentialId: alphaCredential.credential_id");
  expect(record).toContain("sponsorId: sponsorA");
  expect(record).toContain("fellowId: alpha.fellowId");
  expect(record).toContain("requestId: revokeKey");
  expect(record).toContain("eventId: revokedReceipt.event_id");
  expect(record).toContain("performance.now() - authorizationStartedAt");
  expect(record).toContain("fellowAuthorizationResponse(postRevokeAuthorization.decision)");
  expect(record).toContain('postRevokeCallerProblem?.code === "UNAUTHORIZED"');
  expect(record).toContain("!JSON.stringify(postRevokeCallerProblem).includes(");
  expect(record).toContain('postRevokeAuthState === "revoked"');
  expect(record).toContain("authState: postRevokeAuthState");
  expect(record).toContain("code: postRevokeCallerProblem.code");
  expect(record).toContain("latencyMs: authorizationLatencyMs");
  expect(record).not.toContain("requestId: key(");
  expect(record).not.toContain("eventId: null");
});

test("PLANTED: the evidence canary enters that record and must be changed by redaction", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const record = script.slice(
    script.indexOf("const authorizationLine = authorizationEvidence({"),
    script.indexOf("function activeCredentialFor("),
  );
  expect(record).toContain("canary=$" + "{authorizationEvidenceCanary}");
  expect(record).toContain("!authorizationLine.includes(authorizationEvidenceCanary)");
  expect(record).toContain("authorizationLine.includes(REDACTED_TOKEN)");
  expect(record).toContain("process.stdout.write(`$" + "{authorizationLine}\\n`)");
});

test("the local proof boundary is declared without deployed or browser overclaim", () => {
  const script = readFileSync(SCRIPT, "utf8");
  expect(script).toContain("revoked_credential_refused_before_effectful_session_write");
  expect(script).toContain("central_policy_post_revoke_refusal_matches_mounted_effectful_route");
  expect(script).not.toContain("W4_FELLOW_MUTATION_NOT_IMPLEMENTED");
  // No browser UI, no deployed D1, no alert delivery is claimed by this lane.
  for (const fabricated of ["oauth", "chromium", "playwright", "pagerduty", "alertmanager"]) {
    expect(script.toLowerCase()).not.toContain(fabricated);
  }
});
