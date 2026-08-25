#!/usr/bin/env bash
# Mock-free W3.5 device enrollment: curl is the unaffiliated agent and a real
# Playwright browser is the sponsor. Secret-bearing values stay in shell memory
# or stdin pipes; diagnostics contain only short SHA-256 correlation digests.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP
cd "$repository_root"

suite="device-enrollment-e2e"
reproduce="bash scripts/e2e-device-enrollment.sh"
readonly runner="$repository_root/e2e/playwright/device-enrollment-runner.ts"
readonly max_response_bytes=131072
readonly browser_deadline_seconds=90
proposal_ttl_seconds=0
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""
scenario="approve"
run_id=""
run_digest=""
browser_capture_test_ps_mode="none"
browser_capture_test_release_reader_exit=0
browser_capture_test_setup_interrupt=0

HTTP_BODY=""
HTTP_STATUS=""
HTTP_DURATION_MS=0
START_DEVICE_CODE=""
START_USER_CODE=""
START_INTERVAL_SECONDS=0
START_EXPIRES_SECONDS=0
POLL_STATUS=""
POLL_RETRY_SECONDS=""
POLL_TOKEN=""
POLL_IDEMPOTENCY_KEY=""

usage_failure() {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 64
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=1
      ;;
    --write-artifacts)
      write_artifacts=1
      ;;
    --run-id)
      [[ "$#" -ge 2 ]] || usage_failure "RUN_ID_MISSING"
      explicit_run_id="$2"
      shift
      ;;
    --scenario)
      [[ "$#" -ge 2 ]] || usage_failure "SCENARIO_MISSING"
      scenario="$2"
      shift
      ;;
    *)
      usage_failure "UNKNOWN_ARGUMENT"
      ;;
  esac
  shift
done

case "$scenario" in
  all | approve | code-expired | deny | fast-poll | proposal-expired | reduce | wrong-code | wrong-sponsor) ;;
  *) usage_failure "SCENARIO_INVALID" ;;
esac
if [[ "$self_test" -eq 1 ]]; then
  reproduce="bash scripts/e2e-device-enrollment.sh --self-test"
else
  reproduce="bash scripts/e2e-device-enrollment.sh --scenario $scenario"
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || usage_failure "RUN_ID_INVALID"
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

final_record() {
  local status="$1"
  local code="$2"
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "$status" "$code" "$reproduce"
}

fail() {
  final_record "fail" "$1"
  exit 1
}

blocked() {
  final_record "blocked" "$1"
  exit 78
}

persist_safe_step() {
  local record="$1"
  if [[ "$write_artifacts" -eq 1 ]]; then
    e2e_append_artifact_jsonl_at_root "$repository_root" "$run_id" "steps.jsonl" "$record" >/dev/null \
      || fail "ARTIFACT_STEP_WRITE_FAILED"
  fi
}

validate_browser_record() {
  local record="$1"
  local expected_scenario="$2"
  local expected_code="$3"
  local process_status="$4"
  printf '%s\n%s\n%s\n%s' "$expected_scenario" "$expected_code" "$process_status" "$record" \
    | bun -e '
      try {
        const lines = (await Bun.stdin.text()).split("\n");
        if (lines.length !== 4) process.exit(1);
        const [scenario, expectedCode, processStatus, json] = lines;
        const value = JSON.parse(json);
        const keys = Object.keys(value).sort().join(",");
        const expectedKeys = ["code", "console_error_count", "device_digest", "duration_ms", "event_id", "flow_digest", "package", "page_error_count", "proposal_digest", "request_id", "scenario", "screenshot_policy", "status", "suite", "tool", "trace_policy", "ts"].sort().join(",");
        const expectedStatus = processStatus === "0" ? "pass" : processStatus === "78" ? "blocked" : "fail";
        const digestValid = (digest) => digest === null || (typeof digest === "string" && /^[0-9a-f]{12}$/.test(digest));
        if (keys !== expectedKeys || typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts)) || value.tool !== "playwright" || value.package !== "e2e" || value.suite !== "device-enrollment-browser" || value.scenario !== scenario || value.status !== expectedStatus || typeof value.code !== "string" || !/^[A-Z0-9_]+$/.test(value.code) || !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0 || value.request_id !== null || value.event_id !== null || value.device_digest !== null || !digestValid(value.proposal_digest) || value.flow_digest !== null || !Number.isSafeInteger(value.console_error_count) || value.console_error_count < 0 || !Number.isSafeInteger(value.page_error_count) || value.page_error_count < 0 || value.screenshot_policy !== "disabled" || value.trace_policy !== "disabled") process.exit(1);
        if (processStatus === "0" && value.code !== expectedCode) process.exit(1);
      } catch { process.exit(1); }
    '
}

sha256_prefix() {
  bun -e 'const value = await Bun.stdin.text(); const hash = new Bun.CryptoHasher("sha256").update(value).digest("hex"); process.stdout.write(hash.slice(0, 12));'
}

storage_state_safe() {
  printf '%s' "$1" | bun -e '
    import { lstatSync, readFileSync } from "node:fs";
    try {
      const path = await Bun.stdin.text();
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1_048_576 || (stat.mode & 0o077) !== 0) process.exit(1);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) process.exit(1);
    } catch { process.exit(1); }
  '
}

# Capture one browser command inside a freshly proved process group. Playwright
# action timeouts do not cover a wedged browser launch/transport/close, so this
# supervisor owns one outer deadline and reaps the exact group TERM -> KILL.
# stdout is bounded; stderr is discarded because only the runner's one safe
# diagnostic record is part of this harness contract.
bounded_browser_capture() {
  local timeout_seconds="$1"
  shift
  DEVICE_BROWSER_CAPTURE_TIMEOUT_SECONDS="$timeout_seconds" \
    DEVICE_BROWSER_CAPTURE_TEST_PS_MODE="$browser_capture_test_ps_mode" \
    DEVICE_BROWSER_CAPTURE_TEST_RELEASE_READER_EXIT="$browser_capture_test_release_reader_exit" \
    DEVICE_BROWSER_CAPTURE_TEST_SETUP_INTERRUPT="$browser_capture_test_setup_interrupt" \
    /usr/bin/perl -e '
use strict;
use warnings;
use IO::Select;
use POSIX qw(setsid WNOHANG);
use Time::HiRes qw(time);

my $timeout = $ENV{DEVICE_BROWSER_CAPTURE_TIMEOUT_SECONDS};
exit 125 unless defined($timeout) && $timeout =~ /\A[1-9][0-9]*\z/;
my $test_ps_mode = $ENV{DEVICE_BROWSER_CAPTURE_TEST_PS_MODE};
my $test_release_reader_exit = $ENV{DEVICE_BROWSER_CAPTURE_TEST_RELEASE_READER_EXIT};
my $test_setup_interrupt = $ENV{DEVICE_BROWSER_CAPTURE_TEST_SETUP_INTERRUPT};
exit 125 unless defined($test_ps_mode) && $test_ps_mode =~ /\A(?:none|once|persistent|hang)\z/;
exit 125 unless defined($test_release_reader_exit) && $test_release_reader_exit =~ /\A[01]\z/;
exit 125 unless defined($test_setup_interrupt) && $test_setup_interrupt =~ /\A[01]\z/;
pipe(my $output_reader, my $output_writer) or exit 125;
pipe(my $ready_reader, my $ready_writer) or exit 125;
pipe(my $release_reader, my $release_writer) or exit 125;
my $pid = fork();
exit 125 unless defined($pid);
if ($pid == 0) {
  close($output_reader);
  close($ready_reader);
  close($release_writer);
  setsid() or exit 125;
  open(STDOUT, q{>&}, $output_writer) or exit 125;
  open(STDERR, q{>}, q{/dev/null}) or exit 125;
  close($output_writer);
  syswrite($ready_writer, qq{READY\n}) == 6 or exit 125;
  if ($test_release_reader_exit == 1) {
    # Close the release reader before readiness EOF. Once the parent observes
    # the complete readiness record, its next gate write is deterministically
    # EPIPE rather than a scheduler-dependent successful write to a dying child.
    close($release_reader);
    close($ready_writer);
    exit 125;
  }
  close($ready_writer);
  my $gate = q{};
  sysread($release_reader, $gate, 1) == 1 && $gate eq q{G} or exit 125;
  close($release_reader);
  exec @ARGV;
  exit 125;
}
close($output_writer);
close($ready_writer);
close($release_reader);

my $selector = IO::Select->new($output_reader, $ready_reader);
my %kind = (fileno($output_reader) => q{output}, fileno($ready_reader) => q{ready});
my $output = q{};
my $ready = q{};
my $output_closed = 0;
my $ready_closed = 0;
my $overflow = 0;
my $child_changed = 0;
my $child_status;
$SIG{CHLD} = sub { $child_changed = 1; };
my $interrupted = 0;
$SIG{HUP} = $SIG{INT} = $SIG{TERM} = sub { $interrupted = 1; };
# Installed only in the already-forked parent: an EPIPE at the release gate
# must reach checked cleanup instead of terminating Perl with SIGPIPE. The
# child retains the default disposition across its later exec.
$SIG{PIPE} = q{IGNORE};

sub drain_once {
  my ($wait) = @_;
  for my $handle ($selector->can_read($wait)) {
    my $fd = fileno($handle);
    my $stream = $kind{$fd} // q{};
    my $bytes = sysread($handle, my $chunk, 8192);
    if (defined($bytes) && $bytes > 0) {
      if ($stream eq q{output}) {
        $output .= $chunk unless $overflow;
        $overflow = 1 if length($output) > 262_144;
      } elsif ($stream eq q{ready}) {
        $ready .= $chunk;
      }
      next;
    }
    $selector->remove($handle);
    delete $kind{$fd};
    close($handle);
    $output_closed = 1 if $stream eq q{output};
    $ready_closed = 1 if $stream eq q{ready};
  }
}

sub scan_process_rows {
  pipe(my $scan_reader, my $scan_writer) or return (0, q{});
  my $scan_pid = fork();
  if (!defined($scan_pid)) {
    close($scan_reader);
    close($scan_writer);
    return (0, q{});
  }
  if ($scan_pid == 0) {
    close($scan_reader);
    open(STDOUT, q{>&}, $scan_writer) or exit 125;
    open(STDERR, q{>}, q{/dev/null}) or exit 125;
    close($scan_writer);
    exit 125 if $test_ps_mode eq q{persistent};
    if ($test_ps_mode eq q{hang}) {
      select(undef, undef, undef, 30.0);
      exit 125;
    }
    exec q{/bin/ps}, q{-A}, q{-o}, q{pid=,pgid=,stat=};
    exit 125;
  }
  close($scan_writer);
  my $scan_selector = IO::Select->new($scan_reader);
  my $scan_deadline = time() + 0.5;
  my $rows = q{};
  my $closed = 0;
  while (time() < $scan_deadline && !$closed && length($rows) <= 2_097_152) {
    my $remaining = $scan_deadline - time();
    my $wait = $remaining < 0.02 ? $remaining : 0.02;
    for my $handle ($scan_selector->can_read($wait)) {
      my $bytes = sysread($handle, my $chunk, 8192);
      if (defined($bytes) && $bytes > 0) {
        $rows .= $chunk;
      } else {
        $scan_selector->remove($handle);
        close($handle);
        $closed = 1;
      }
    }
  }
  if (!$closed) {
    $scan_selector->remove($scan_reader);
    close($scan_reader);
  }
  my $scan_status;
  my $reap_deadline = time() + 0.5;
  while (time() < $reap_deadline) {
    my $reaped = waitpid($scan_pid, WNOHANG);
    if ($reaped == $scan_pid) {
      $scan_status = $?;
      last;
    }
    last if $reaped == -1;
    select(undef, undef, undef, 0.01);
  }
  if (!defined($scan_status)) {
    my $kill_reap_deadline = time() + 0.5;
    while (time() < $kill_reap_deadline) {
      my $reaped = waitpid($scan_pid, WNOHANG);
      if ($reaped == $scan_pid) {
        $scan_status = $?;
        last;
      }
      last if $reaped == -1;
      # The unreaped direct child still owns this exact PID. Retry SIGKILL
      # until it is reaped or the fixed deadline makes the scan uncertain.
      kill q{KILL}, $scan_pid;
      select(undef, undef, undef, 0.01);
    }
  }
  return (0, q{}) unless $closed && defined($scan_status) && $scan_status == 0;
  return (0, q{}) if $rows eq q{} || length($rows) > 2_097_152;
  return (1, $rows);
}

sub group_state {
  my ($pgid) = @_;
  if ($test_ps_mode eq q{once}) {
    $test_ps_mode = q{none};
    return 2;
  }
  my ($scan_ok, $rows) = scan_process_rows();
  return 2 unless $scan_ok;
  for my $row (split /\n/, $rows) {
    next if $row =~ /\A\s*\z/;
    my ($member, $group, $stat) = $row =~ /\A\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s*\z/;
    return 2 unless defined($member) && defined($group) && defined($stat);
    return 1 if $group == $pgid && $stat !~ /\AZ/;
  }
  return 0;
}

sub settle_group {
  my ($pgid) = @_;
  kill q{TERM}, -$pgid;
  my $term_deadline = time() + 0.75;
  while (time() < $term_deadline) {
    drain_once(0.02);
    my $state = group_state($pgid);
    return 1 if $state == 0;
  }
  my $kill_sent = kill q{KILL}, -$pgid;
  if (!$kill_sent) {
    return group_state($pgid) == 0 ? 1 : 0;
  }
  my $kill_deadline = time() + 1.0;
  while (time() < $kill_deadline) {
    drain_once(0.02);
    my $state = group_state($pgid);
    return 1 if $state == 0;
  }
  return 0;
}

sub reap_until {
  my ($deadline) = @_;
  while (time() < $deadline) {
    my $reaped = waitpid($pid, WNOHANG);
    if ($reaped == $pid) {
      $child_status = $?;
      return 1;
    }
    return 0 if $reaped == -1;
    drain_once(0.02);
  }
  return 0;
}

sub terminate_exact_child {
  my ($deadline) = @_;
  while (time() < $deadline) {
    my $reaped = waitpid($pid, WNOHANG);
    if ($reaped == $pid) {
      $child_status = $?;
      return 1;
    }
    return 0 if $reaped == -1;
    # The unreaped direct child still owns its PID, so retrying this exact
    # signal cannot hit a reused process. Success is declared only after reap.
    kill q{KILL}, $pid;
    drain_once(0.02);
  }
  return 0;
}

# The child cannot exec or create descendants until readiness is observed.
my $setup_deadline = time() + 2.0;
$interrupted = 1 if $test_setup_interrupt == 1;
while (!$ready_closed && time() < $setup_deadline && !$interrupted) {
  drain_once(0.02);
}
if ($ready ne qq{READY\n} || !$ready_closed || $interrupted) {
  my $cleaned = terminate_exact_child(time() + 1.0);
  exit 125 unless $cleaned;
  exit($interrupted ? 130 : 125);
}
my $release_bytes = syswrite($release_writer, q{G});
if (!defined($release_bytes) || $release_bytes != 1) {
  my $settled = settle_group($pid);
  my $reaped = reap_until(time() + 1.0);
  exit 125 unless $settled && $reaped;
  exit 125;
}
close($release_writer);

my $deadline = time() + $timeout;
my $timed_out = 0;
while (time() < $deadline && !$interrupted && !$overflow) {
  drain_once(0.02);
  if ($child_changed && $output_closed) {
    my $state = group_state($pid);
    if ($state == 0) {
      reap_until(time() + 1.0) or exit 125;
      my $status = $child_status;
      exit 125 unless defined($status);
      print $output;
      exit (($status & 127) ? 128 + ($status & 127) : ($status >> 8));
    }
    last if $state == 2 || $state == 1;
  }
}
$timed_out = 1 if time() >= $deadline;
my $settled = settle_group($pid);
my $reaped = reap_until(time() + 1.0);
exit 125 unless $settled && $reaped;
exit 124 if $timed_out;
exit 130 if $interrupted;
exit 126 if $overflow;
exit 125;
' -- "$@"
}

# Prove a planted browser marker has no surviving argv holder without trusting
# an unbounded shell-level `ps`. The scanner itself runs inside the same bounded
# supervisor, so a hung or failing process table is a typed non-green result.
assert_no_browser_marker() {
  local marker="$1"
  local survived_code="$2"
  local scan_output
  local scan_status

  set +e
  # shellcheck disable=SC2016 # The embedded Perl process owns its $ENV expansion.
  scan_output="$(
    DEVICE_E2E_PLANTED_MARKER="$marker" \
      bounded_browser_capture 2 /usr/bin/perl -e '
        use strict;
        use warnings;
        my $marker = $ENV{DEVICE_E2E_PLANTED_MARKER};
        exit 125 unless defined($marker) && $marker =~ /\A[A-Za-z0-9._-]{1,160}\z/;
        open(my $rows, q{-|}, q{/bin/ps}, q{-A}, q{-o}, q{command=}) or exit 125;
        my $found = 0;
        while (my $row = <$rows>) {
          $found = 1 if index($row, $marker) >= 0;
        }
        close($rows) or exit 125;
        exit($found ? 1 : 0);
      '
  )"
  scan_status=$?
  set -e
  [[ -z "$scan_output" ]] || fail "BROWSER_SURVIVOR_SCAN_FAILED"
  case "$scan_status" in
    0) return 0 ;;
    1) fail "$survived_code" ;;
    *) fail "BROWSER_SURVIVOR_SCAN_FAILED" ;;
  esac
}

command -v bun >/dev/null 2>&1 || blocked "E2E_DEPENDENCY_UNAVAILABLE"
[[ -x /usr/bin/perl ]] || blocked "E2E_DEPENDENCY_UNAVAILABLE"
proposal_ttl_seconds="$(
  bun -e 'import { PENDING_PROPOSAL_TTL_MS } from "@asimposium/contracts"; process.stdout.write(String(PENDING_PROPOSAL_TTL_MS / 1_000));'
)" || blocked "E2E_CONTRACT_UNAVAILABLE"
[[ "$proposal_ttl_seconds" =~ ^[1-9][0-9]*$ ]] || blocked "E2E_CONTRACT_INVALID"
readonly proposal_ttl_seconds
run_digest="$(printf '%s' "$run_id" | sha256_prefix)" || usage_failure "RUN_ID_DIGEST_FAILED"

emit_step() {
  local step_scenario="$1"
  local step="$2"
  local status="$3"
  local code="$4"
  local http_status="$5"
  local duration_ms="$6"
  local request_id="$7"
  local device_digest="$8"
  local flow_digest="$9"
  local event_id="null"
  local record

  [[ "$step_scenario" =~ ^[a-z-]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$step" =~ ^[a-z-]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$status" =~ ^(pass|fail|blocked|start)$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$code" =~ ^[A-Z0-9_]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$http_status" =~ ^([0-9]{3}|null)$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$duration_ms" =~ ^[0-9]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$request_id" =~ ^[A-Za-z0-9._-]{1,160}$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$device_digest" == "null" ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$flow_digest" =~ ^([0-9a-f]{12}|null)$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"

  printf -v record '{"ts":"%s","tool":"curl","package":"e2e","suite":"%s","scenario":"%s","step":"%s","status":"%s","code":"%s","http_status":%s,"duration_ms":%s,"request_id":"%s","event_id":%s,"device_digest":%s,"flow_digest":%s}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$suite" "$step_scenario" "$step" "$status" "$code" \
    "$http_status" "$duration_ms" "$request_id" "$event_id" \
    "$([[ "$device_digest" == "null" ]] && printf 'null' || printf '"%s"' "$device_digest")" \
    "$([[ "$flow_digest" == "null" ]] && printf 'null' || printf '"%s"' "$flow_digest")"
  printf '%s\n' "$record"
  persist_safe_step "$record"
}

safe_request_id() {
  local step_scenario="$1"
  local step="$2"
  printf 'req-e2e-%s-%s-%s\n' "$run_digest" "$step_scenario" "$step"
}

http_post_json() {
  local origin="$1"
  local path="$2"
  local body="$3"
  local request_id="$4"
  local idempotency_key="${5:-}"
  local request_started
  local combined
  local curl_status
  local -a headers

  headers=(--header "content-type: application/json" --header "x-request-id: $request_id")
  if [[ -n "$idempotency_key" ]]; then
    headers+=(--header "idempotency-key: $idempotency_key")
  fi
  request_started="$(e2e_now_ms)"
  set +e
  combined="$(
    printf '%s' "$body" | curl --disable --silent --show-error \
      --connect-timeout 5 --max-time 20 --max-filesize "$max_response_bytes" --request POST \
      "${headers[@]}" --data-binary @- --write-out $'\n%{http_code}' \
      "$origin$path" 2>/dev/null
  )"
  curl_status=$?
  set -e
  HTTP_DURATION_MS="$(e2e_elapsed_ms "$request_started")"
  [[ "$curl_status" -eq 0 ]] || return 1
  [[ "$combined" == *$'\n'* ]] || return 1
  HTTP_STATUS="${combined##*$'\n'}"
  HTTP_BODY="${combined%$'\n'*}"
  [[ "$HTTP_STATUS" =~ ^[0-9]{3}$ ]] || return 1
  [[ "${#HTTP_BODY}" -le "$max_response_bytes" ]] || return 1
}

http_hello() {
  local origin="$1"
  local token="$2"
  local request_id="$3"
  local request_started
  local combined
  local curl_status

  request_started="$(e2e_now_ms)"
  set +e
  combined="$(
    printf 'header = "Authorization: Bearer %s"\nheader = "x-request-id: %s"\n' "$token" "$request_id" \
      | curl --disable --silent --show-error --config - \
        --connect-timeout 5 --max-time 20 --max-filesize "$max_response_bytes" \
        --write-out $'\n%{http_code}' \
        "$origin/v1/hello" 2>/dev/null
  )"
  curl_status=$?
  set -e
  HTTP_DURATION_MS="$(e2e_elapsed_ms "$request_started")"
  [[ "$curl_status" -eq 0 ]] || return 1
  [[ "$combined" == *$'\n'* ]] || return 1
  HTTP_STATUS="${combined##*$'\n'}"
  HTTP_BODY="${combined%$'\n'*}"
  [[ "$HTTP_STATUS" =~ ^[0-9]{3}$ ]] || return 1
  [[ "${#HTTP_BODY}" -le "$max_response_bytes" ]] || return 1
}

parse_start_response() {
  local parsed
  parsed="$(
    printf '%s' "$HTTP_BODY" | bun -e '
      import { DeviceCodeStartResponseSchema } from "@asimposium/contracts";
      try {
        const value = DeviceCodeStartResponseSchema.parse(JSON.parse(await Bun.stdin.text()));
        process.stdout.write([value.device_code, value.user_code, value.interval_seconds, value.expires_in_seconds].join("|"));
      } catch { process.exit(1); }
    '
  )" || return 1
  IFS='|' read -r START_DEVICE_CODE START_USER_CODE START_INTERVAL_SECONDS START_EXPIRES_SECONDS <<< "$parsed"
  [[ "$START_DEVICE_CODE" =~ ^flow_v1\.[A-Za-z0-9_-]{43}$ ]]
  [[ "$START_USER_CODE" =~ ^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$ ]]
  [[ "$START_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]
  [[ "$START_EXPIRES_SECONDS" =~ ^[1-9][0-9]*$ ]]
}

parse_poll_response() {
  local parsed
  parsed="$(
    printf '%s' "$HTTP_BODY" | bun -e '
      import {
        EnrollmentApprovedResponseSchema,
        EnrollmentDeniedResponseSchema,
        EnrollmentExpiredResponseSchema,
        EnrollmentPendingResponseSchema,
        EnrollmentSlowDownResponseSchema,
      } from "@asimposium/contracts";
      try {
        const raw = JSON.parse(await Bun.stdin.text());
        const schemas = [EnrollmentApprovedResponseSchema, EnrollmentDeniedResponseSchema, EnrollmentExpiredResponseSchema, EnrollmentPendingResponseSchema, EnrollmentSlowDownResponseSchema];
        const parsed = schemas.map((schema) => schema.safeParse(raw)).find((result) => result.success);
        if (parsed === undefined || !parsed.success) process.exit(1);
        const value = parsed.data;
        const retry = "retry_after_seconds" in value ? String(value.retry_after_seconds) : "";
        const token = "token" in value ? value.token : "";
        process.stdout.write([value.status, retry, token].join("|"));
      } catch { process.exit(1); }
    '
  )" || return 1
  IFS='|' read -r POLL_STATUS POLL_RETRY_SECONDS POLL_TOKEN <<< "$parsed"
}

validate_hello_response() {
  local expected_name="$1"
  local expected_model="$2"
  local expected_harness="$3"
  local expected_scopes="$4"
  printf '%s\n%s\n%s\n%s\n%s' "$expected_name" "$expected_model" "$expected_harness" "$expected_scopes" "$HTTP_BODY" \
    | bun -e '
      import { EnrollmentHelloResponseSchema } from "@asimposium/contracts";
      try {
        const lines = (await Bun.stdin.text()).split("\n");
        if (lines.length < 5) process.exit(1);
        const [name, model, harness, scopes, ...jsonLines] = lines;
        const value = EnrollmentHelloResponseSchema.parse(JSON.parse(jsonLines.join("\n")));
        if (value.fellow.name !== name || value.fellow.model !== model || value.fellow.harness !== harness) process.exit(1);
        if (value.granted_scopes.join(",") !== scopes) process.exit(1);
      } catch { process.exit(1); }
    '
}

next_name() {
  local step_scenario="$1"
  local suffix
  suffix="$(bun -e 'process.stdout.write(crypto.randomUUID().replaceAll("-", "").slice(0, 8))')" || fail "RANDOM_ID_UNAVAILABLE"
  printf 'device-%s-%s\n' "${step_scenario:0:8}" "$suffix"
}

start_device() {
  local step_scenario="$1"
  local name="$2"
  local scopes="$3"
  local request_id
  local request_body
  local flow_digest
  local observed_code

  request_id="$(safe_request_id "$step_scenario" "start")"
  request_body="$(printf '{"name":"%s","model":"e2e/device-contract","harness":"curl-playwright","requested_scopes":[%s]}' "$name" "$scopes")"
  http_post_json "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/v1/device-code" "$request_body" "$request_id" \
    || fail "DEVICE_START_UNREACHABLE"
  if [[ "$HTTP_STATUS" != "201" ]] || ! parse_start_response; then
    emit_step "$step_scenario" "device-start" "fail" "DEVICE_START_CONTRACT_FAILED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "null"
    fail "DEVICE_START_CONTRACT_FAILED"
  fi
  flow_digest="$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)" || fail "DIGEST_FAILED"
  POLL_IDEMPOTENCY_KEY="idem-poll-${run_digest}-${step_scenario}"
  emit_step "$step_scenario" "device-start" "pass" "DEVICE_CODE_ISSUED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
}

poll_device() {
  local step_scenario="$1"
  local step="$2"
  local expected_status="$3"
  local request_id
  local request_body
  local flow_digest

  request_id="$(safe_request_id "$step_scenario" "$step")"
  request_body="$(printf '{"flow_handle":"%s"}' "$START_DEVICE_CODE")"
  [[ -n "$POLL_IDEMPOTENCY_KEY" ]] || fail "DEVICE_POLL_KEY_MISSING"
  http_post_json "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/v1/device-token" "$request_body" "$request_id" "$POLL_IDEMPOTENCY_KEY" \
    || fail "DEVICE_POLL_UNREACHABLE"
  flow_digest="$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)" || fail "DIGEST_FAILED"
  if [[ "$HTTP_STATUS" != "200" ]] || ! parse_poll_response || [[ "$POLL_STATUS" != "$expected_status" ]]; then
    emit_step "$step_scenario" "$step" "fail" "DEVICE_POLL_CONTRACT_FAILED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
    fail "DEVICE_POLL_CONTRACT_FAILED"
  fi
  if [[ "$POLL_STATUS" == "authorization_pending" || "$POLL_STATUS" == "slow_down" ]]; then
    [[ "$POLL_RETRY_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "DEVICE_POLL_CONTRACT_FAILED"
  elif [[ -n "$POLL_RETRY_SECONDS" ]]; then
    fail "DEVICE_POLL_CONTRACT_FAILED"
  fi
  observed_code="DEVICE_POLL_${POLL_STATUS^^}"
  emit_step "$step_scenario" "$step" "pass" "$observed_code" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
}

run_browser() {
  local step_scenario="$1"
  local mode="$2"
  local storage_path="$3"
  local name="$4"
  local scopes_csv="$5"
  local browser_output
  local browser_status

  set +e
  browser_output="$(
    printf '%s\n%s\n%s\n%s\n%s\n' "$START_USER_CODE" "$name" "e2e/device-contract" "curl-playwright" "$scopes_csv" \
      | ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$storage_path" \
        bounded_browser_capture "$browser_deadline_seconds" bun "$runner" "$mode"
  )"
  browser_status=$?
  set -e
  case "$browser_status" in
    124) fail "BROWSER_DEVICE_FLOW_TIMEOUT" ;;
    125) fail "BROWSER_CAPTURE_SETUP_FAILED" ;;
    126) fail "BROWSER_DIAGNOSTIC_OVERSIZE" ;;
    130) fail "BROWSER_CAPTURE_INTERRUPTED" ;;
  esac
  if [[ "$browser_output" == *"$START_USER_CODE"* \
    || "$browser_output" == *"$START_DEVICE_CODE"* \
    || "$browser_output" == *"$name"* \
    || "$browser_output" == *"e2e/device-contract"* \
    || "$browser_output" == *"curl-playwright"* \
    || "$browser_output" == *"asimp_ag_"* \
    || "$browser_output" == *"https://"* ]]; then
    fail "BROWSER_DIAGNOSTIC_LEAK"
  fi
  [[ -n "$browser_output" && "$browser_output" != *$'\n'* ]] || fail "BROWSER_DIAGNOSTIC_MISSING"
  validate_browser_record \
    "$browser_output" \
    "$mode" \
    "$([[ "$mode" == "lookup-rejected" ]] && printf 'DEVICE_LOOKUP_REJECTED' || printf 'DEVICE_DECISION_UI_CONFIRMED')" \
    "$browser_status" \
    || fail "BROWSER_DIAGNOSTIC_INVALID"
  printf '%s\n' "$browser_output"
  persist_safe_step "$browser_output"
  case "$browser_status" in
    0) return 0 ;;
    78) blocked "BROWSER_DEVICE_FLOW_BLOCKED" ;;
    *) fail "BROWSER_DEVICE_FLOW_FAILED" ;;
  esac
}

assert_distinct_sponsors() {
  local browser_output
  local browser_status

  set +e
  browser_output="$(
    ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" \
      ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE="$ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE" \
      bounded_browser_capture "$browser_deadline_seconds" bun "$runner" assert-distinct-sponsors
  )"
  browser_status=$?
  set -e
  case "$browser_status" in
    124) fail "SPONSOR_PREFLIGHT_TIMEOUT" ;;
    125) fail "BROWSER_CAPTURE_SETUP_FAILED" ;;
    126) fail "BROWSER_DIAGNOSTIC_OVERSIZE" ;;
    130) fail "BROWSER_CAPTURE_INTERRUPTED" ;;
  esac
  if [[ "$browser_output" == *"asimp_ag_"* \
    || "$browser_output" == *"https://"* \
    || "$browser_output" == *"@"* \
    || "$browser_output" == *"/Users/"* ]]; then
    fail "SPONSOR_PREFLIGHT_DIAGNOSTIC_LEAK"
  fi
  [[ -n "$browser_output" && "$browser_output" != *$'\n'* ]] || fail "SPONSOR_PREFLIGHT_DIAGNOSTIC_MISSING"
  validate_browser_record \
    "$browser_output" \
    "sponsor-preflight" \
    "DISTINCT_SPONSOR_SESSIONS_VERIFIED" \
    "$browser_status" \
    || fail "SPONSOR_PREFLIGHT_DIAGNOSTIC_INVALID"
  printf '%s\n' "$browser_output"
  persist_safe_step "$browser_output"
  case "$browser_status" in
    0) return 0 ;;
    78) blocked "SPONSOR_PREFLIGHT_BLOCKED" ;;
    *) fail "SPONSOR_PREFLIGHT_FAILED" ;;
  esac
}

hello_with_token() {
  local step_scenario="$1"
  local name="$2"
  local expected_scopes="$3"
  local request_id
  local flow_digest

  [[ "$POLL_TOKEN" =~ ^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$ ]] \
    || fail "APPROVED_TOKEN_CONTRACT_FAILED"
  request_id="$(safe_request_id "$step_scenario" "hello")"
  http_hello "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "$POLL_TOKEN" "$request_id" \
    || fail "FELLOW_HELLO_UNREACHABLE"
  flow_digest="$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)" || fail "DIGEST_FAILED"
  if [[ "$HTTP_STATUS" != "200" ]] \
    || ! validate_hello_response "$name" "e2e/device-contract" "curl-playwright" "$expected_scopes"; then
    emit_step "$step_scenario" "hello" "fail" "FELLOW_HELLO_CONTRACT_FAILED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
    fail "FELLOW_HELLO_CONTRACT_FAILED"
  fi
  emit_step "$step_scenario" "hello" "pass" "FELLOW_HELLO_VERIFIED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
  POLL_TOKEN=""
}

run_decision_scenario() {
  local step_scenario="$1"
  local decision_mode="$2"
  local scopes_json='"review"'
  local scopes_csv="review"
  local expected_scopes="review"
  local name

  if [[ "$decision_mode" == "reduce" ]]; then
    scopes_json='"review","promote"'
    scopes_csv="review,promote"
  fi
  name="$(next_name "$step_scenario")"
  start_device "$step_scenario" "$name" "$scopes_json"
  poll_device "$step_scenario" "pending-poll" "authorization_pending"
  run_browser "$step_scenario" "$decision_mode" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "$scopes_csv"
  if [[ "$decision_mode" == "deny" ]]; then
    poll_device "$step_scenario" "terminal-poll" "access_denied"
  else
    poll_device "$step_scenario" "terminal-poll" "approved"
    hello_with_token "$step_scenario" "$name" "$expected_scopes"
  fi
}

run_fast_poll() {
  local name
  name="$(next_name "fast-poll")"
  start_device "fast-poll" "$name" '"review"'
  poll_device "fast-poll" "pending-poll" "authorization_pending"
  poll_device "fast-poll" "immediate-repoll" "slow_down"
  run_browser "fast-poll" "deny" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "fast-poll" "terminal-poll" "access_denied"
}

run_wrong_code() {
  local name
  local real_code
  local first
  local replacement
  name="$(next_name "wrong-code")"
  start_device "wrong-code" "$name" '"review"'
  real_code="$START_USER_CODE"
  first="${real_code:0:1}"
  replacement="A"
  [[ "$first" != "A" ]] || replacement="B"
  START_USER_CODE="$replacement${real_code:1}"
  run_browser "wrong-code" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  START_USER_CODE="$real_code"
  run_browser "wrong-code" "deny" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "wrong-code" "terminal-poll" "access_denied"
}

run_wrong_sponsor() {
  local name
  name="$(next_name "wrong-sponsor")"
  start_device "wrong-sponsor" "$name" '"review"'
  run_browser "wrong-sponsor" "approve" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  # Exercise the ownership boundary after the first decision binds the sponsor,
  # while no credential has yet been issued to the agent.
  run_browser "wrong-sponsor" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE" "$name" "review"
  poll_device "wrong-sponsor" "terminal-poll" "approved"
  hello_with_token "wrong-sponsor" "$name" "review"
}

run_code_expired() {
  local name
  local request_id
  name="$(next_name "code-expired")"
  start_device "code-expired" "$name" '"review"'
  poll_device "code-expired" "pending-poll" "authorization_pending"
  request_id="$(safe_request_id "code-expired" "expiry-wait")"
  emit_step "code-expired" "expiry-wait" "start" "REAL_CODE_TTL_WAIT_STARTED" "null" "0" "$request_id" \
    "null" "$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)"
  sleep "$((START_EXPIRES_SECONDS + 1))"
  run_browser "code-expired" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "code-expired" "terminal-poll" "expired_token"
}

run_proposal_expired() {
  local name
  local request_id
  name="$(next_name "proposal-expired")"
  start_device "proposal-expired" "$name" '"review"'
  poll_device "proposal-expired" "pending-poll" "authorization_pending"
  request_id="$(safe_request_id "proposal-expired" "expiry-wait")"
  emit_step "proposal-expired" "expiry-wait" "start" "REAL_PROPOSAL_RETENTION_SOAK_STARTED" "null" "0" "$request_id" \
    "null" "$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)"
  sleep "$((proposal_ttl_seconds + 1))"
  run_browser "proposal-expired" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "proposal-expired" "terminal-poll" "expired_token"
}

run_self_test() {
  local output
  local runner_status
  local canary_flow
  local canary_token
  local planted_device_digest
  local planted_timeout_marker
  local planted_timeout_output
  local planted_timeout_status
  local planted_uncertain_output
  local planted_uncertain_status
  local planted_persistent_output
  local planted_persistent_status
  local planted_hung_output
  local planted_hung_status
  local planted_hung_started_ms
  local planted_hung_duration_ms
  local planted_release_output
  local planted_release_status
  local planted_setup_output
  local planted_setup_status
  local planted_suffix
  local planted_wrong_code
  local planted_wrong_status
  canary_flow="flow_v1.$(printf 'A%.0s' {1..43})"
  canary_token="asimp_ag_$(printf 'A%.0s' {1..26})_$(printf 'B%.0s' {1..43})"

  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce --self-test" >/dev/null \
    || fail "HARNESS_SELF_TEST_FAILED"
  set +e
  output="$(bounded_browser_capture 15 bun "$runner" --self-test)"
  runner_status=$?
  set -e
  [[ "$runner_status" -eq 0 ]] || fail "BROWSER_RUNNER_SELF_TEST_FAILED"
  if [[ "$output" != *'"code":"BROWSER_RUNNER_SELF_TEST_OK"'* \
    || "$output" == *"$canary_flow"* \
    || "$output" == *"$canary_token"* \
    || "$output" == *"https://"* \
    || "$output" == *"/Users/"* ]]; then
    fail "BROWSER_RUNNER_SELF_TEST_UNSAFE"
  fi
  validate_browser_record "$output" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0" \
    || fail "BROWSER_RUNNER_SELF_TEST_INVALID"
  planted_wrong_code="${output/BROWSER_RUNNER_SELF_TEST_OK/FABRICATED_GREEN}"
  planted_wrong_status="${output/\"status\":\"pass\"/\"status\":\"blocked\"}"
  planted_device_digest="${output/\"device_digest\":null/\"device_digest\":\"0123456789ab\"}"
  if validate_browser_record "$planted_wrong_code" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0" \
    || validate_browser_record "$planted_wrong_status" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0" \
    || validate_browser_record "$planted_device_digest" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0"; then
    fail "BROWSER_RUNNER_PLANTED_NEGATIVE_ACCEPTED"
  fi

  planted_timeout_marker="device-e2e-timeout-${run_digest}-$$"
  set +e
  planted_timeout_output="$(
    bounded_browser_capture 1 bash -c \
      'trap "" TERM; while :; do sleep 1; done' "$planted_timeout_marker"
  )"
  planted_timeout_status=$?
  set -e
  [[ "$planted_timeout_status" -eq 124 && -z "$planted_timeout_output" ]] \
    || fail "BROWSER_TIMEOUT_PLANT_NOT_CAUGHT"
  assert_no_browser_marker "$planted_timeout_marker" "BROWSER_TIMEOUT_PLANT_SURVIVED"

  browser_capture_test_ps_mode="once"
  set +e
  planted_uncertain_output="$(
    bounded_browser_capture 1 bash -c \
      'trap "" TERM; while :; do sleep 1; done' "$planted_timeout_marker-uncertain"
  )"
  planted_uncertain_status=$?
  set -e
  browser_capture_test_ps_mode="none"
  [[ "$planted_uncertain_status" -eq 124 && -z "$planted_uncertain_output" ]] \
    || fail "BROWSER_PS_UNCERTAINTY_PLANT_NOT_CAUGHT"
  assert_no_browser_marker \
    "$planted_timeout_marker-uncertain" \
    "BROWSER_PS_UNCERTAINTY_PLANT_SURVIVED"

  browser_capture_test_ps_mode="persistent"
  set +e
  planted_persistent_output="$(
    bounded_browser_capture 1 bash -c \
      'trap "" TERM; while :; do sleep 1; done' "$planted_timeout_marker-persistent"
  )"
  planted_persistent_status=$?
  set -e
  browser_capture_test_ps_mode="none"
  [[ "$planted_persistent_status" -eq 125 && -z "$planted_persistent_output" ]] \
    || fail "BROWSER_PERSISTENT_PS_FAILURE_PLANT_NOT_CAUGHT"

  browser_capture_test_ps_mode="hang"
  planted_hung_started_ms="$(e2e_now_ms)"
  set +e
  planted_hung_output="$(
    bounded_browser_capture 1 bash -c \
      'trap "" TERM; while :; do sleep 1; done' "$planted_timeout_marker-hung"
  )"
  planted_hung_status=$?
  set -e
  planted_hung_duration_ms="$(( $(e2e_now_ms) - planted_hung_started_ms ))"
  browser_capture_test_ps_mode="none"
  [[ "$planted_hung_status" -eq 125 && -z "$planted_hung_output" \
    && "$planted_hung_duration_ms" -le 8000 ]] \
    || fail "BROWSER_HUNG_PS_PLANT_NOT_BOUNDED"

  browser_capture_test_release_reader_exit=1
  set +e
  planted_release_output="$(
    bounded_browser_capture 5 bash -c 'while :; do sleep 1; done' \
      "$planted_timeout_marker-release"
  )"
  planted_release_status=$?
  set -e
  browser_capture_test_release_reader_exit=0
  [[ "$planted_release_status" -eq 125 && -z "$planted_release_output" ]] \
    || fail "BROWSER_RELEASE_PIPE_PLANT_NOT_CAUGHT"

  browser_capture_test_setup_interrupt=1
  set +e
  planted_setup_output="$(
    bounded_browser_capture 5 bash -c 'while :; do sleep 1; done' \
      "$planted_timeout_marker-setup"
  )"
  planted_setup_status=$?
  set -e
  browser_capture_test_setup_interrupt=0
  [[ "$planted_setup_status" -eq 130 && -z "$planted_setup_output" ]] \
    || fail "BROWSER_SETUP_INTERRUPT_PLANT_NOT_CAUGHT"

  for planted_suffix in persistent hung release setup; do
    assert_no_browser_marker \
      "$planted_timeout_marker-$planted_suffix" \
      "BROWSER_SUPERVISOR_PLANT_SURVIVED"
  done
  printf '%s\n' "$output"
  final_record "pass" "DEVICE_ENROLLMENT_HARNESS_SELF_TEST_OK"
}

if [[ "$self_test" -eq 1 ]]; then
  run_self_test
  exit 0
fi

command -v curl >/dev/null 2>&1 || blocked "E2E_DEPENDENCY_UNAVAILABLE"

for origin_variable in ASIMPOSIUM_STAGING_AGENT_BASE_URL ASIMPOSIUM_STAGING_AGORA_BASE_URL; do
  if e2e_validate_staging_origin "$origin_variable"; then
    :
  else
    origin_status=$?
    [[ "$origin_status" -eq 2 ]] && blocked "STAGING_SURFACE_BASE_URL_MISSING"
    blocked "STAGING_SURFACE_BASE_URL_INVALID"
  fi
done

if [[ -z "${ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE:-}" ]]; then
  blocked "SPONSOR_STORAGE_STATE_MISSING"
fi
if ! storage_state_safe "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE"; then
  blocked "SPONSOR_STORAGE_STATE_INVALID"
fi
if [[ "$scenario" == "wrong-sponsor" || "$scenario" == "all" ]]; then
  if [[ -z "${ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE:-}" ]]; then
    blocked "SECOND_SPONSOR_STORAGE_STATE_MISSING"
  fi
  if ! storage_state_safe "$ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE"; then
    blocked "SECOND_SPONSOR_STORAGE_STATE_INVALID"
  fi
  assert_distinct_sponsors
fi

case "$scenario" in
  approve) run_decision_scenario "approve" "approve" ;;
  deny) run_decision_scenario "deny" "deny" ;;
  code-expired) run_code_expired ;;
  fast-poll) run_fast_poll ;;
  proposal-expired) run_proposal_expired ;;
  reduce) run_decision_scenario "reduce" "reduce" ;;
  wrong-code) run_wrong_code ;;
  wrong-sponsor) run_wrong_sponsor ;;
  all)
    run_wrong_code
    run_fast_poll
    run_decision_scenario "deny" "deny"
    run_decision_scenario "reduce" "reduce"
    run_decision_scenario "approve" "approve"
    run_wrong_sponsor
    run_code_expired
    ;;
esac

final_record "pass" "DEVICE_ENROLLMENT_FLOW_GREEN"
