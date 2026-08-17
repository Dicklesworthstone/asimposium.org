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
  TOKEN_LIFECYCLE_TEST_BUSY_PORT: "0",
  TOKEN_LIFECYCLE_TEST_DETACHED: "0",
  TOKEN_LIFECYCLE_TEST_LOG_LEAK: "0",
  TOKEN_LIFECYCLE_TEST_PARTIAL_PS: "0",
  TOKEN_LIFECYCLE_TEST_PID_REUSE: "0",
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

function processGroupIsEmpty(pgid: number): boolean {
  const probe = Bun.spawnSync({
    cmd: ["/bin/kill", "-0", `-${pgid}`],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (probe.exitCode === 0) return false;
  if (probe.exitCode === 1) return true;
  throw new Error(`token lifecycle process-group probe failed with ${probe.exitCode}`);
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

async function runOwnedProcess(options: {
  readonly cmd: readonly string[];
  readonly expectedCommandToken: string;
  readonly readyOutput?: string;
  readonly env: Record<string, string | undefined>;
  readonly liveBudgetMs: number;
  readonly termGraceMs: number;
  readonly killGraceMs: number;
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

  try {
    // The Perl launcher remains the group leader while its command runs. Its
    // private ready/go files prevent a short command from exiting before the
    // parent has pinned the exact leader identity. No existing or previously
    // orphaned group is inspected as a cleanup target.
    const child = Bun.spawn({
      cmd: [
        "perl",
        "-MPOSIX=setsid,WNOHANG",
        "-e",
        'setsid() or die "setsid"; my $leader = $$; my $group = getpgrp(0); open(my $ready, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_READY"}) or die "ready"; print $ready join("\\t", $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_COMMAND_TOKEN"}) . "\\n"; close($ready); until (-e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_GO"}) { select(undef, undef, undef, 0.01); } $SIG{"TERM"} = sub {}; my $worker = fork(); die "fork" unless defined($worker); if ($worker == 0) { $SIG{"TERM"} = "DEFAULT"; exec @ARGV or die "exec"; } my $last_challenge = ""; my $status; while (1) { if (-e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"}) { open(my $challenge_file, "<", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"}) or die "challenge"; my $challenge = <$challenge_file> // ""; close($challenge_file); $challenge =~ s/\\s+$//; if ($challenge ne "" && $challenge ne $last_challenge) { open(my $response, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_RESPONSE"}) or die "response"; print $response join("\\t", $challenge, $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_COMMAND_TOKEN"}) . "\\n"; close($response); $last_challenge = $challenge; } } my $done = waitpid($worker, WNOHANG); if ($done == $worker) { $status = $?; last; } die "waitpid" if $done < 0; select(undef, undef, undef, 0.01); } my $code = ($status & 127) ? 128 + ($status & 127) : $status >> 8; open(my $status_file, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_STATUS"}) or die "status"; print $status_file join("\\t", $worker, $status, $code) . "\\n"; close($status_file); exit($code);',
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
    const exited = child.exited;
    const identityReady = await waitUntil(() => {
      if (!existsSync(supervisorReadyPath)) return false;
      const [pid, pgid, nonce, commandToken] = readFileSync(supervisorReadyPath, "utf8")
        .trim()
        .split("\t");
      if (
        Number(pid) !== child.pid ||
        Number(pgid) !== child.pid ||
        nonce !== supervisorNonce ||
        commandToken !== options.expectedCommandToken
      ) {
        return false;
      }
      identity = {
        pid: child.pid,
        pgid: child.pid,
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
  } finally {
    // Bun owns the BunFile-backed child handles. The paths themselves remain
    // as private retained evidence; this test never deletes caller data.
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
  expect(script).toContain("migration closure is not exactly 0001 through 0016");
  expect(script).toContain('"wrangler_started\\":false');
  expect(script).toContain("assert_migration_journal || exit 1");
  expect(script).toContain("assert_source_closure_unchanged || exit 1");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_BUSY_PORT");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_DETACHED");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_PARTIAL_PS");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_PID_REUSE");
  expect(script).toContain("TOKEN_LIFECYCLE_TEST_LOG_LEAK");
  expect(script).toContain("TOKEN_LIFECYCLE_BARRIER_CAPABILITY");
  expect(script).toContain('"deterministic_barrier":true');
  expect(script).toContain("panic-leaves-no-active-minted-credential");
  expect(script).toContain("W4_FELLOW_MUTATION_NOT_IMPLEMENTED");
  expect(script.indexOf("if (( SELF_TEST == 1 ))")).toBeLessThan(
    script.indexOf(`[[ -x "\${WRANGLER}" ]]`),
  );
  const config = readFileSync(LOCAL_CONFIG, "utf8");
  expect(config).toContain('main = "token-lifecycle-local-worker.ts"');
  expect(config).toContain('TOKEN_LIFECYCLE_LOCAL_HARNESS = "enabled"');
  expect(config).toContain("workers_dev = false");
  const localWorker = readFileSync(LOCAL_WORKER, "utf8");
  expect(localWorker).toContain("await barrier.awaitRevoke()");
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

test("token lifecycle fault matrix is ordinary, provider-free, and causally proves every local cleanup plant", async () => {
  const cases: readonly {
    readonly plant: keyof typeof FAULT_PLANTS;
    readonly code: string;
    readonly requiresWorkerCleanup: boolean;
  }[] = [
    {
      plant: "TOKEN_LIFECYCLE_TEST_BUSY_PORT",
      code: "TOKEN_LIFECYCLE_PORT_ALREADY_BOUND",
      requiresWorkerCleanup: false,
    },
    {
      plant: "TOKEN_LIFECYCLE_TEST_PARTIAL_PS",
      code: "TOKEN_LIFECYCLE_RESPONDER_IDENTITY_UNPROVEN",
      requiresWorkerCleanup: true,
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
  ];

  for (const current of cases) {
    const result = await runHarness([], { [current.plant]: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`"code":"${current.code}"`);
    expect(result.stdout).not.toContain('"code":"TOKEN_LIFECYCLE_LOCAL_PASSED"');
    if (current.requiresWorkerCleanup) {
      expect(result.stdout).toContain(
        '"assertion":"workerd_group_descendants_listener_and_state_fds_reaped","status":"pass"',
      );
    } else {
      expect(result.stdout).not.toContain("ready_workerd_responder_pid_pgid_start_and_argv_pinned");
    }
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
  const authorizationRecord = records.find(
    (record) => record.record === "authorization-decision",
  );
  expect(authorizationRecord).toBeDefined();
  expect(authorizationRecord?.assertion).toBe(
    "central_policy_post_revoke_refusal_no_mounted_effectful_route",
  );
  expect(authorizationRecord?.credential_id).toMatch(/^cred-[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(authorizationRecord?.fellow_id).toMatch(/^F-[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(authorizationRecord?.event_id).toMatch(/^LEV-[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(authorizationRecord?.request_id).toMatch(/^token-lifecycle-revoke-alpha-\d+$/);
  expect(authorizationRecord?.authorization_decision).toBe("refuse");
  expect(authorizationRecord?.assertion_diff).toContain("operator=credential_revoked");
  expect(authorizationRecord?.assertion_diff).toContain("canary=<redacted>");
  expect(result.stdout).toContain('"code":"W4_FELLOW_MUTATION_NOT_IMPLEMENTED"');
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
    "authorization_decision",
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
  expect(helper).toContain('Buffer.byteLength(encoded, "utf8")');
});

test("PLANTED: actual authorization evidence invokes the central seam and binds real ids", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const record = script.slice(
    script.indexOf("const postRevokeAuthorization = inspectFellowWriteAuthorization({"),
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
  expect(record).not.toContain("requestId: key(");
  expect(record).not.toContain("eventId: null");
});

test("PLANTED: the evidence canary enters that record and must be changed by redaction", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const record = script.slice(
    script.indexOf("const authorizationLine = authorizationEvidence({"),
    script.indexOf("function activeCredentialFor("),
  );
  expect(record).toContain("canary=${authorizationEvidenceCanary}");
  expect(record).toContain("!authorizationLine.includes(authorizationEvidenceCanary)");
  expect(record).toContain("authorizationLine.includes(REDACTED_TOKEN)");
  expect(record).toContain("process.stdout.write(`${authorizationLine}\\n`)");
});

test("the still-blocked boundaries are declared, not quietly asserted", () => {
  const script = readFileSync(SCRIPT, "utf8");
  // W4 effectful writes are not implemented, so revoke-versus-write cannot be
  // proven by HTTP here. The central policy diagnostic is labeled accordingly.
  expect(script).toContain("W4_FELLOW_MUTATION_NOT_IMPLEMENTED");
  expect(script).toContain("central_policy_post_revoke_refusal_no_mounted_effectful_route");
  // No browser UI, no deployed D1, no alert delivery is claimed by this lane.
  for (const fabricated of ["oauth", "chromium", "playwright", "pagerduty", "alertmanager"]) {
    expect(script.toLowerCase()).not.toContain(fabricated);
  }
});
