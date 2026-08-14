#!/usr/bin/env bash
# Integration contract: self-test is executable; absent live staging remains
# visibly blocked and no provider behavior is substituted with a mock.
set -euo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_DIR
REPO_ROOT="$(cd -- "${TEST_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly SCRIPT_PATH="${REPO_ROOT}/scripts/e2e-s4-screening-oauth.sh"
BUN_PATH="$(command -v bun)"
readonly BUN_PATH
readonly S4_PRIVATE_TEST_AUTHORITY='e2e/screening/e2e-s4-screening-oauth.test.sh'
readonly S4_PRIVATE_TEST_CAPABILITY='s4-screening-lifecycle-v1'

# Test-only lifecycle controls must never leak in from a caller's environment.
# Individual cases pass the full private authority/capability explicitly.
unset S4_WRAPPER_TEST_LIFECYCLE_HOOK S4_WRAPPER_TEST_SIGNAL \
  S4_WRAPPER_TEST_AUTHORITY S4_WRAPPER_TEST_CAPABILITY \
  S4_WRAPPER_TEST_CAPTURE_GROUPS S4_WRAPPER_TEST_WRAPPER_PID \
  S4_CAPTURE_CONTROL_FD

# A command substitution waits for every writer of its stdout pipe. A broken
# wrapper can leave a descendant holding that pipe even after its leader exits,
# so capture through a private pipe and bound the entire isolated test session.
# This function prints only after its direct child is reaped or its bounded
# direct-child teardown expires, which keeps the caller's command substitution
# bounded too. It never signals a descendant process group by numeric PGID.
run_bounded_capture() {
  local timeout_seconds="$1"
  shift
  local capture_status

  set +e
  S4_CAPTURE_OUTPUT="$(S4_CAPTURE_TIMEOUT_SECONDS="${timeout_seconds}" /usr/bin/perl -e '
use strict;
use warnings;
use Fcntl qw(F_SETFD);
use IO::Select;
use POSIX qw(setsid WNOHANG);
use Time::HiRes qw(time);

my $timeout = $ENV{S4_CAPTURE_TIMEOUT_SECONDS};
exit 125 unless defined($timeout) && $timeout =~ /\A(?:[1-9][0-9]*)(?:\.[0-9]+)?\z/;
pipe(my $reader, my $writer) or exit 125;
pipe(my $control_reader, my $control_writer) or exit 125;
defined(fcntl($control_writer, F_SETFD, 0)) or exit 125;
my $pid = fork();
exit 125 unless defined($pid);
if ($pid == 0) {
  close($reader);
  close($control_reader);
  setsid() or exit 125;
  open(STDOUT, q{>&}, $writer) or exit 125;
  open(STDERR, q{>&}, $writer) or exit 125;
  close($writer);
  $ENV{S4_CAPTURE_CONTROL_FD} = fileno($control_writer);
  exec @ARGV;
  exit 125;
}
close($writer);
close($control_writer);
my $selector = IO::Select->new($reader, $control_reader);
my $deadline = time() + $timeout;
my $output = q{};
my $child_status;
my $output_closed = 0;
my $control_closed = 0;
my $control_buffer = q{};
my %stream_kind = (
  fileno($reader) => q{output},
  fileno($control_reader) => q{control},
);
my %published_groups;

sub remember_private_capture_group {
  while ($control_buffer =~ s/\A([^\n]*)\n//) {
    my $line = $1;
    next unless $line =~ /\AS4_CAPTURE_GROUP ([1-9][0-9]*)\z/;
    $published_groups{$1} = 1;
  }
}

sub published_group_attestation {
  return q{} unless keys %published_groups;
  my $rows = qx{ps -A -o pid=,pgid=,stat= 2>/dev/null};
  return join q{}, map { "S4_TEST_CAPTURE_GROUP_UNKNOWN $_\n" } sort { $a <=> $b } keys %published_groups
    if $? != 0 || $rows eq q{};
  my %live;
  for my $row (split /\n/, $rows) {
    my ($member, $pgid, $stat) =
      $row =~ /^\s*([0-9]+)\s+([0-9]+)\s+([^\s]+)\s*\z/;
    return join q{}, map { "S4_TEST_CAPTURE_GROUP_UNKNOWN $_\n" } sort { $a <=> $b } keys %published_groups
      unless defined($member) && defined($pgid) && defined($stat);
    $live{$pgid} = 1 if $stat !~ /Z/;
  }
  return join q{}, map {
    $live{$_} ? "S4_TEST_CAPTURE_GROUP_LIVE $_\n" : "S4_TEST_CAPTURE_GROUP_ZERO $_\n"
  } sort { $a <=> $b } keys %published_groups;
}

sub drain_ready_streams {
  my $until = shift;
  while (time() < $until && (!$output_closed || !$control_closed)) {
    my $remaining = $until - time();
    my @ready = $selector->can_read($remaining > 0.01 ? 0.01 : $remaining);
    for my $handle (@ready) {
      my $handle_fd = fileno($handle);
      my $kind = $stream_kind{$handle_fd} // q{};
      my $bytes = sysread($handle, my $chunk, 8192);
      if (defined($bytes) && $bytes > 0) {
        if ($kind eq q{output}) {
          $output .= $chunk;
        } elsif ($kind eq q{control}) {
          $control_buffer .= $chunk;
          remember_private_capture_group();
        }
        next;
      }
      $selector->remove($handle);
      delete $stream_kind{$handle_fd};
      close($handle);
      $output_closed = 1 if $kind eq q{output};
      $control_closed = 1 if $kind eq q{control};
    }
  }
}

while (time() < $deadline) {
  my $waited = waitpid($pid, WNOHANG);
  $child_status = $? if $waited == $pid;
  drain_ready_streams(time() + 0.01);
  last if defined($child_status) && $output_closed;
}
if (!defined($child_status) || !$output_closed) {
  # The direct capture child remains safe to signal until this parent reaps
  # it. Once reaped, do not infer ownership of any numeric descendant PGID:
  # close the pipes, attest the published groups, and fail deterministically.
  if (!defined($child_status)) {
    kill q{KILL}, $pid;
  }
  my $teardown_deadline = time() + 0.20;
  while (!defined($child_status) && time() < $teardown_deadline) {
    my $waited = waitpid($pid, WNOHANG);
    $child_status = $? if $waited == $pid;
    drain_ready_streams(time() + 0.01);
  }
  # A surviving pipe holder cannot extend teardown. Preserve only bytes already
  # ready, then close the private reader and return the timeout deterministically.
  drain_ready_streams(time() + 0.02);
  close($reader) unless $output_closed;
  close($control_reader) unless $control_closed;
  print published_group_attestation();
  print $output;
  exit 124;
}
print published_group_attestation();
print $output;
exit (($child_status & 127) ? 128 + ($child_status & 127) : ($child_status >> 8));
' -- "$@")"
  capture_status=$?
  set -e
  S4_CAPTURE_STATUS="${capture_status}"
}

assert_terminal_summary() {
  local case_name="$1"
  local output="$2"
  local expected_status="$3"
  local expected_code="$4"
  local expected_exit_code="$5"
  local expected_runner_status="$6"
  local expected_oauth_dry_check_test_status="$7"
  local expected_runner_test_status="$8"
  local expected_legitimate_only_test_status="$9"
  local expected_detail_provided=0
  local expected_detail=''
  local marker='"record_type":"s4-terminal-summary"'
  local marker_count=0
  local remaining_output="${output}"
  local summary

  if [[ "$#" -eq 10 ]]; then
    expected_detail_provided=1
    expected_detail="${10}"
  fi

  while [[ "${remaining_output}" == *"${marker}"* ]]; do
    marker_count=$((marker_count + 1))
    remaining_output="${remaining_output#*"${marker}"}"
  done

  if [[ "${marker_count}" -ne 1 ]]; then
    printf '%s\n' "${case_name}: expected exactly one s4 terminal summary, found ${marker_count}" >&2
    exit 1
  fi

  summary="${output##*$'\n'}"
  if ! "${BUN_PATH}" -e '
    const [summary, expectedStatus, expectedCode, expectedExitCode,
      expectedRunnerStatus, expectedOauthStatus, expectedRunnerTestStatus,
      expectedLegitimateStatus, expectedDetailProvided, expectedDetail] = process.argv.slice(1);
    const expectedNumberOrNull = (value) => {
      if (value === "null") return null;
      if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`invalid expected numeric-or-null value: ${value}`);
      }
      return Number(value);
    };
    const payload = JSON.parse(summary);
    const expected = {
      record_type: "s4-terminal-summary",
      suite: "s4-screening-oauth",
      status: expectedStatus,
      code: expectedCode,
      exit_code: expectedNumberOrNull(expectedExitCode),
      runner_status: expectedNumberOrNull(expectedRunnerStatus),
      oauth_dry_check_test_status: expectedNumberOrNull(expectedOauthStatus),
      runner_test_status: expectedNumberOrNull(expectedRunnerTestStatus),
      legitimate_only_test_status: expectedNumberOrNull(expectedLegitimateStatus),
    };
    if (expectedDetailProvided === "1") expected.detail = expectedDetail;
    for (const [field, value] of Object.entries(expected)) {
      if (payload[field] !== value) {
        throw new Error(`${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(payload[field])}`);
      }
    }
  ' "${summary}" "${expected_status}" "${expected_code}" "${expected_exit_code}" "${expected_runner_status}" "${expected_oauth_dry_check_test_status}" "${expected_runner_test_status}" "${expected_legitimate_only_test_status}" "${expected_detail_provided}" "${expected_detail}" >/dev/null 2>&1; then
    printf '%s\n' "${case_name}: terminal summary did not exactly match its typed fields" >&2
    printf '%s\n' "${summary}" >&2
    exit 1
  fi
}

assert_published_groups_are_empty() {
  local case_name="$1"
  local output="$2"
  local marker='S4_TEST_CAPTURE_GROUP_ZERO '
  local marker_count=0
  local remaining_output="${output}"

  case "${output}" in
    *S4_TEST_CAPTURE_GROUP_LIVE\ *|*S4_TEST_CAPTURE_GROUP_UNKNOWN\ *)
      printf '%s\n' "${case_name}: capture could not prove every wrapper-published PGID was empty" >&2
      exit 1
      ;;
    *) ;;
  esac
  while [[ "${remaining_output}" == *"${marker}"* ]]; do
    marker_count=$((marker_count + 1))
    remaining_output="${remaining_output#*"${marker}"}"
  done
  if [[ "${marker_count}" -eq 0 ]]; then
    printf '%s\n' "${case_name}: no wrapper-published PGID was attested empty" >&2
    exit 1
  fi
}

assert_no_s4_fixture_survivors() {
  local fixture_rows

  fixture_rows="$(ps -A -o pid=,command= 2>/dev/null)" || {
    printf '%s\n' 'post-suite survivor scan: ps inspection failed' >&2
    exit 1
  }
  case "${fixture_rows}" in
    *S4_TEST_SELF_EXPIRING_DESCENDANT*|*s4-control-supervisor*)
      printf '%s\n' 'post-suite survivor scan: an S4 fixture or supervisor remained live' >&2
      exit 1
      ;;
    *) ;;
  esac
}

run_planted_status_case() (
  local case_name="$1"
  local runner_mode="$2"
  local runner_status="$3"
  local oauth_dry_check_test_status="$4"
  local runner_test_status="$5"
  local legitimate_only_test_status="$6"
  local expected_status="$7"
  local expected_code="$8"
  local expected_exit_code="$9"
  local output
  local status

  # This override exists only in this subshell, which is invoked after the real
  # corpus and live-blocker probes below. It cannot replace fixture evidence.
  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  planted_bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts)
        printf '%s\n' "planted S4 runner ${2:-missing-mode}"
        return "${S4_PLANTED_RUNNER_STATUS}"
        ;;
      test)
        case "${2:-}" in
          e2e/screening/oauth-dry-check.test.ts)
            printf '%s\n' 'planted OAuth dry-check focused test'
            return "${S4_PLANTED_OAUTH_DRY_CHECK_TEST_STATUS}"
            ;;
          e2e/screening/s4-runner.test.ts)
            printf '%s\n' 'planted S4 runner focused test'
            return "${S4_PLANTED_RUNNER_TEST_STATUS}"
            ;;
          e2e/screening/s4-legitimate-only.test.ts)
            printf '%s\n' 'planted legitimate-only focused test'
            return "${S4_PLANTED_LEGITIMATE_ONLY_TEST_STATUS}"
            ;;
          *)
            printf '%s\n' "unexpected planted bun test target: ${2:-missing}" >&2
            return 125
            ;;
        esac
        ;;
      *)
        printf '%s\n' "unexpected planted bun command: ${1:-missing}" >&2
        return 125
        ;;
    esac
  }

  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    planted_bun "$@"
  }
  export -f planted_bun bun

  set +e
  if [[ "${runner_mode}" == "live" ]]; then
    output="$(S4_PLANTED_RUNNER_STATUS="${runner_status}" S4_PLANTED_OAUTH_DRY_CHECK_TEST_STATUS="${oauth_dry_check_test_status}" S4_PLANTED_RUNNER_TEST_STATUS="${runner_test_status}" S4_PLANTED_LEGITIMATE_ONLY_TEST_STATUS="${legitimate_only_test_status}" bash "${SCRIPT_PATH}" 2>&1)"
  else
    output="$(S4_PLANTED_RUNNER_STATUS="${runner_status}" S4_PLANTED_OAUTH_DRY_CHECK_TEST_STATUS="${oauth_dry_check_test_status}" S4_PLANTED_RUNNER_TEST_STATUS="${runner_test_status}" S4_PLANTED_LEGITIMATE_ONLY_TEST_STATUS="${legitimate_only_test_status}" bash "${SCRIPT_PATH}" --self-test 2>&1)"
  fi
  status=$?
  set -e

  if [[ "${status}" -ne "${expected_exit_code}" ]]; then
    printf '%s\n' "${case_name}: expected exit ${expected_exit_code}, got ${status}" >&2
    exit 1
  fi

  assert_terminal_summary \
    "${case_name}" \
    "${output}" \
    "${expected_status}" \
    "${expected_code}" \
    "${expected_exit_code}" \
    "${runner_status}" \
    "${oauth_dry_check_test_status}" \
    "${runner_test_status}" \
    "${legitimate_only_test_status}"
)

run_planted_runner_signal_case() (
  local signal_name="$1"
  local signal_status="$2"
  local output
  local status

  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts)
        printf '%s\n' "planted interrupted runner ${S4_PLANTED_SIGNAL_NAME}"
        return "${S4_PLANTED_SIGNAL_STATUS}"
        ;;
      test)
        printf '%s\n' "unexpected focused test after ${S4_PLANTED_SIGNAL_NAME}" >&2
        return 125
        ;;
      *)
        printf '%s\n' 'unexpected planted signal command' >&2
        return 125
        ;;
    esac
  }
  export -f bun

  set +e
  output="$(S4_PLANTED_SIGNAL_NAME="${signal_name}" S4_PLANTED_SIGNAL_STATUS="${signal_status}" bash "${SCRIPT_PATH}" --self-test 2>&1)"
  status=$?
  set -e

  if [[ "${status}" -ne "${signal_status}" ]]; then
    printf '%s\n' "${signal_name}: expected signal status ${signal_status}, got ${status}" >&2
    exit 1
  fi

  assert_terminal_summary \
    "${signal_name} preserves child signal" \
    "${output}" \
    fail \
    "S4_WRAPPER_INTERRUPTED_${signal_name}" \
    "${signal_status}" \
    "${signal_status}" \
    null \
    null \
    null

  case "${output}" in
    *'unexpected focused test after'* )
      printf '%s\n' "${signal_name}: wrapper started a focused test after interruption" >&2
      exit 1
      ;;
    *) ;;
  esac
)

run_private_lifecycle_environment_cases() (
  local output
  local status

  # A poisoned production environment must not gain test-hook authority. The
  # ordinary live gate stays an ordinary blocked live gate and never emits the
  # private fixture's readiness marker.
  # Keep the normal/live assertion focused on control inertness rather than
  # the full runner's variable fixture runtime.
  # shellcheck disable=SC2329 # Imported only by this normal/live invocation.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts) return 78 ;;
      test) return 0 ;;
      *) return 125 ;;
    esac
  }
  export -f bun
  run_bounded_capture 4 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=after-spawn-before-ownership \
    S4_WRAPPER_TEST_SIGNAL=TERM \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    S4_CAPTURE_CONTROL_FD=poisoned \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}"
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 78 ]]; then
    printf '%s\n' "production environment poisoning: expected ordinary live blocker 78, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    'production environment poisoning is inert' \
    "${output}" \
    blocked \
    S4_LIVE_GATE_BLOCKED \
    78 \
    78 \
    0 \
    0 \
    0
  case "${output}" in
    *S4_TEST_RUNNER_READY*)
      printf '%s\n' 'production environment poisoning activated a private lifecycle fixture' >&2
      exit 1
      ;;
    *) ;;
  esac

  # Capture-group publication is itself a private capability. An authority and
  # capability pair with a malformed relay descriptor is rejected before Bun.
  set +e
  output="$(S4_WRAPPER_TEST_CAPTURE_GROUPS=1 S4_CAPTURE_CONTROL_FD=poisoned S4_WRAPPER_TEST_AUTHORITY="${S4_PRIVATE_TEST_AUTHORITY}" S4_WRAPPER_TEST_CAPABILITY="${S4_PRIVATE_TEST_CAPABILITY}" bash "${SCRIPT_PATH}" --self-test 2>&1)"
  status=$?
  set -e
  if [[ "${status}" -ne 64 ]]; then
    printf '%s\n' "malformed private capture capability: expected 64, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    'malformed private capture capability is rejected' \
    "${output}" \
    fail \
    S4_PRIVATE_SELF_TEST_CONFIGURATION_INVALID \
    64 \
    null \
    null \
    null \
    null

  # The self-test accepts test controls only as the exact, complete pair set by
  # this driver. Partial authority and an invalid hook both fail before Bun or
  # a fixture can run.
  run_bounded_capture 2 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=after-spawn-before-ownership \
    S4_WRAPPER_TEST_SIGNAL=TERM \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 64 ]]; then
    printf '%s\n' "partial private authority: expected 64, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    'partial private lifecycle authority is rejected' \
    "${output}" \
    fail \
    S4_PRIVATE_SELF_TEST_CONFIGURATION_INVALID \
    64 \
    null \
    null \
    null \
    null

  run_bounded_capture 2 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=not-a-real-boundary \
    S4_WRAPPER_TEST_SIGNAL=TERM \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 64 ]]; then
    printf '%s\n' "malformed private lifecycle controls: expected 64, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    'malformed private lifecycle controls are rejected' \
    "${output}" \
    fail \
    S4_PRIVATE_SELF_TEST_CONFIGURATION_INVALID \
    64 \
    null \
    null \
    null \
    null

  # This private probe is the terminal serializer's only caller-controlled
  # detail. It proves quotes, a backslash, whitespace controls, and U+0001 are
  # emitted as valid JSON, while the exact authority remains required.
  run_bounded_capture 2 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=json-quote-terminal-probe \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 64 ]]; then
    printf '%s\n' "private JSON quote probe: expected 64, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    'private JSON quote probe is valid and exact' \
    "${output}" \
    fail \
    S4_JSON_QUOTE_PROBE \
    64 \
    null \
    null \
    null \
    null \
    $'private JSON quote probe: " \\ \t \n \001'
)

run_post_spawn_reap_case() (
  local lifecycle_hook="$1"
  local output
  local status

  # Each hook fails after the setsid child is stopped and the parent owns its
  # exact direct PID. No payload is CONTed, so a timely return proves that the
  # source KILLed and reaped that direct child on the failure branch.
  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      test) return 0 ;;
      *) return 125 ;;
    esac
  }
  export -f bun

  run_bounded_capture 5 \
    env \
    "S4_WRAPPER_TEST_LIFECYCLE_HOOK=${lifecycle_hook}" \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 1 ]]; then
    printf '%s\n' "${lifecycle_hook}: expected post-spawn reaped failure 1, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    "${lifecycle_hook} reaps its stopped direct child" \
    "${output}" \
    fail \
    S4_RUNNER_FAILED \
    1 \
    125 \
    125 \
    125 \
    125
  if [[ "${lifecycle_hook}" != before-private-capture-publish-force-failure ]]; then
    assert_published_groups_are_empty "${lifecycle_hook}" "${output}"
  fi
)

run_prepublication_reaper_failure_case() (
  local signal_name="$1"
  local output
  local status
  local expected_runner_status=125

  # The private seam fails before ownership publication, then makes the
  # direct-child reaper report failure after it has already reaped that child.
  # The suite must latch the failure with active_child_pid empty. With a
  # deferred signal, that signal must become the same cleanup failure instead
  # of disappearing.
  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    printf '%s\n' 'unexpected Bun invocation after pre-publication reaper failure' >&2
    return 125
  }
  export -f bun

  if [[ -n "${signal_name}" ]]; then
    expected_runner_status=null
  fi
  run_bounded_capture 2 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=prepublication-reaper-force-failure \
    "S4_WRAPPER_TEST_SIGNAL=${signal_name}" \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 1 ]]; then
    printf '%s\n' "pre-publication reaper failure/${signal_name:-none}: expected typed failure 1, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    "pre-publication reaper failure/${signal_name:-none}" \
    "${output}" \
    fail \
    S4_ACTIVE_COMMAND_REAP_FAILED \
    1 \
    "${expected_runner_status}" \
    null \
    null \
    null
  case "${output}" in
    *S4_TEST_CAPTURE_GROUP_*)
      printf '%s\n' "pre-publication reaper failure/${signal_name:-none}: ownership was published unexpectedly" >&2
      exit 1
      ;;
    *) ;;
  esac
  case "${output}" in
    *'unexpected Bun invocation after pre-publication reaper failure'*)
      printf '%s\n' "pre-publication reaper failure/${signal_name:-none}: later S4 command started" >&2
      exit 1
      ;;
    *) ;;
  esac
)

run_post_leader_group_observation_failure_case() (
  local output
  local status

  # The private seam runs only after the exact supervisor was reaped. It
  # simulates a live/unknown group result at that point. A typed lifecycle
  # failure is required; the wrapper must not send a leaderless numeric-PGID
  # TERM or KILL, and it must not start any later focused command.
  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts) return 0 ;;
      *)
        printf '%s\n' 'unexpected Bun invocation after post-leader group observation failure' >&2
        return 125
        ;;
    esac
  }
  export -f bun

  run_bounded_capture 2 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=post-leader-group-nonempty-force-failure \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 1 ]]; then
    printf '%s\n' "post-leader group observation failure: expected typed failure 1, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    'post-leader group observation failure has no leaderless group signal fallback' \
    "${output}" \
    fail \
    S4_ACTIVE_COMMAND_REAP_FAILED \
    1 \
    125 \
    null \
    null \
    null
  assert_published_groups_are_empty 'post-leader group observation failure' "${output}"
  case "${output}" in
    *'unexpected Bun invocation after post-leader group observation failure'*)
      printf '%s\n' 'post-leader group observation failure: later S4 command started' >&2
      exit 1
      ;;
    *) ;;
  esac
)

run_pre_exec_identity_race_case() (
  local output
  local status

  # The private Perl launcher deliberately pauses after setsid and before exec.
  # A PID==PGID-only loop would pin that Perl process, CONT it pointlessly, and
  # leave the later supervisor STOPped forever. The source must wait for two
  # stable stopped Bash-supervisor identities before publishing/CONTing it.
  # Keep the payload itself trivial: this is exclusively a lifecycle probe. A
  # four-second capture is a hard bound on a stopped-supervisor regression
  # while leaving room for the four controlled-command handshakes.
  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts) return 78 ;;
      test) return 0 ;;
      *) return 125 ;;
    esac
  }
  export -f bun
  run_bounded_capture 4 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=pre-exec-before-supervisor-stop \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 78 ]]; then
    printf '%s\n' "pre-exec supervisor identity race: expected self-test blocker 78, got ${status}" >&2
    exit 1
  fi
  assert_terminal_summary \
    'pre-exec race waits for the stopped Bash supervisor' \
    "${output}" \
    blocked \
    PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE \
    78 \
    78 \
    0 \
    0 \
    0
  assert_published_groups_are_empty 'pre-exec race' "${output}"
)

run_normal_leader_exit_descendant_case() (
  local output
  local status
  local descendant_pid

  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts)
        # The payload leader returns without waiting. Its descendant ignores
        # TERM. The payload leader returns immediately; the supervisor must
        # retain and clean its owned group before any normal payload status can
        # reach the wrapper.
        /usr/bin/perl -e '
          $| = 1;
          my $child = fork();
          exit 125 unless defined($child);
          if ($child) {
            print "S4_TEST_NORMAL_READY descendant=$child\n";
            exit 0;
          }
          $0 = q{S4_TEST_SELF_EXPIRING_DESCENDANT};
          $SIG{TERM} = q{IGNORE};
          $SIG{ALRM} = sub { exit 0 };
          alarm 3;
          while (1) { }
        '
        return 0
        ;;
      test) return 0 ;;
      *) return 125 ;;
    esac
  }
  export -f bun

  run_bounded_capture 6 \
    env \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 1 ]]; then
    printf '%s\n' "normal leader-exit group: expected typed failure 1, got ${status}" >&2
    exit 1
  fi
  if [[ ! "${output}" =~ S4_TEST_NORMAL_READY[[:space:]]descendant=([0-9]+) ]]; then
    printf '%s\n' 'normal leader-exit group: fixture never reported its descendant' >&2
    exit 1
  fi
  descendant_pid="${BASH_REMATCH[1]}"
  if kill -0 "${descendant_pid}" 2>/dev/null; then
    printf '%s\n' 'normal leader-exit group: TERM-resistant descendant survived cleanup' >&2
    exit 1
  fi
  # The supervisor must KILL its own group in this TERM-resistant case. Its 137
  # is intentionally a generic runner failure: a payload may also exit 137
  # independently, so the terminal schema must not misattribute it.
  assert_terminal_summary \
    'normal leader exit with TERM-resistant descendant is typed and reaped' \
    "${output}" \
    fail \
    S4_RUNNER_FAILED \
    1 \
    137 \
    0 \
    0 \
    0
  assert_published_groups_are_empty 'normal leader exit with TERM-resistant descendant' "${output}"
)

run_normal_term_accepts_descendant_case() (
  local output
  local status
  local descendant_pid

  # A descendant that accepts TERM lets the supervisor remove the whole group
  # without self-KILL. That remains a generic controlled-command failure (125),
  # not a magic lifecycle status that could collide with a payload's exit 76.
  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts)
        /usr/bin/perl -e '
          my $child = fork();
          exit 125 unless defined($child);
          if ($child) {
            print "S4_TEST_TERM_ACCEPTS_READY descendant=$child\n";
            exit 0;
          }
          $0 = q{S4_TEST_SELF_EXPIRING_DESCENDANT};
          $SIG{ALRM} = sub { exit 0 };
          alarm 3;
          while (1) { sleep 1; }
        '
        return 0
        ;;
      test) return 0 ;;
      *) return 125 ;;
    esac
  }
  export -f bun

  run_bounded_capture 6 \
    env \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 1 ]]; then
    printf '%s\n' "normal TERM-accepting descendant: expected typed failure 1, got ${status}" >&2
    exit 1
  fi
  if [[ ! "${output}" =~ S4_TEST_TERM_ACCEPTS_READY[[:space:]]descendant=([0-9]+) ]]; then
    printf '%s\n' 'normal TERM-accepting descendant: fixture never reported its descendant' >&2
    exit 1
  fi
  descendant_pid="${BASH_REMATCH[1]}"
  if kill -0 "${descendant_pid}" 2>/dev/null; then
    printf '%s\n' 'normal TERM-accepting descendant survived cleanup' >&2
    exit 1
  fi
  assert_terminal_summary \
    'normal leader exit with TERM-accepting descendant is a generic controlled failure' \
    "${output}" \
    fail \
    S4_RUNNER_FAILED \
    1 \
    125 \
    0 \
    0 \
    0
  assert_published_groups_are_empty 'normal leader exit with TERM-accepting descendant' "${output}"
)

run_stale_identity_case() (
  local output
  local status
  local descendant_pid
  local started_at=${SECONDS}

  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts)
        /usr/bin/perl -e '
          $0 = q{S4_TEST_SELF_EXPIRING_DESCENDANT};
          $SIG{TERM} = q{IGNORE};
          $SIG{ALRM} = sub { exit 0 };
          alarm 3;
          while (1) { }
        ' &
        descendant=$!
        printf 'S4_TEST_STALE_IDENTITY_READY descendant=%s\n' "${descendant}"
        wait "${descendant}"
        ;;
      test) return 125 ;;
      *) return 125 ;;
    esac
  }
  export -f bun

  # A corrupted recorded identity deliberately prevents a group signal. The
  # TERM-resistant fixture self-expires after three seconds, comfortably after
  # wrapper cleanup should have succeeded but before this six-second capture
  # deadline. Capture never signals its numeric descendant group.
  run_bounded_capture 6 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=after-ownership-before-wait \
    S4_WRAPPER_TEST_SIGNAL=TERM \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  if [[ "${status}" -ne 1 ]]; then
    printf '%s\n' "stale identity: expected typed cleanup failure 1 after refusing the cached PGID, got ${status}" >&2
    exit 1
  fi
  if ((SECONDS - started_at > 7)); then
    printf '%s\n' 'stale identity: bounded capture exceeded its deadline' >&2
    exit 1
  fi
  if [[ ! "${output}" =~ S4_TEST_STALE_IDENTITY_READY[[:space:]]descendant=([0-9]+) ]]; then
    printf '%s\n' 'stale identity: fixture never reported its TERM-resistant descendant' >&2
    exit 1
  fi
  descendant_pid="${BASH_REMATCH[1]}"
  if kill -0 "${descendant_pid}" 2>/dev/null; then
    printf '%s\n' 'stale identity: self-expiring fixture still survived the bounded capture' >&2
    exit 1
  fi
  assert_terminal_summary \
    'stale identity emits explicit reap failure without a numeric group fallback' \
    "${output}" \
    fail \
    S4_ACTIVE_COMMAND_REAP_FAILED \
    1 \
    null \
    null \
    null \
    null
  assert_published_groups_are_empty 'stale identity bounded capture' "${output}"
)

run_outer_wrapper_loss_case() (
  local output
  local status
  local descendant_pid
  local started_at
  local elapsed

  # The outer wrapper is deliberately SIGKILLed only after it has forwarded
  # TERM into the exact supervisor group. The supervisor must then complete
  # its own bounded KILL while it remains that group's leader. The resistant
  # child self-expires at three seconds as a test-only backstop, but successful
  # supervisor teardown must close the capture well before that deadline.
  # shellcheck disable=SC2329 # Imported and invoked by the child bash process.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts)
        /usr/bin/perl -e '
          $| = 1;
          my $child = fork();
          exit 125 unless defined($child);
          if ($child) {
            my $watcher = fork();
            exit 125 unless defined($watcher);
            if (!$watcher) {
              select undef, undef, undef, 0.05;
              my $wrapper = $ENV{S4_WRAPPER_TEST_WRAPPER_PID} // q{};
              kill q{TERM}, $wrapper if $wrapper =~ /\A[1-9][0-9]*\z/;
              exit 0;
            }
            print "S4_TEST_OUTER_LOSS_READY descendant=$child\n";
            waitpid($child, 0);
            exit 0;
          }
          $0 = q{S4_TEST_SELF_EXPIRING_DESCENDANT};
          $SIG{TERM} = q{IGNORE};
          $SIG{ALRM} = sub { exit 0 };
          alarm 3;
          while (1) { }
        '
        ;;
      test)
        printf '%s\n' 'unexpected focused test after outer wrapper loss' >&2
        return 125
        ;;
      *) return 125 ;;
    esac
  }
  export -f bun

  started_at="$(/usr/bin/perl -MTime::HiRes=time -e 'printf "%.6f", time')"
  run_bounded_capture 6 \
    env \
    S4_WRAPPER_TEST_LIFECYCLE_HOOK=after-parent-signal-forwarded-kill-wrapper \
    S4_WRAPPER_TEST_SIGNAL=TERM \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  status="${S4_CAPTURE_STATUS}"
  elapsed="$(/usr/bin/perl -MTime::HiRes=time -e 'printf "%.6f", time - $ARGV[0]' "${started_at}")"
  if [[ "${status}" -ne 137 ]]; then
    printf '%s\n' "outer wrapper loss: expected killed wrapper status 137, got ${status}" >&2
    exit 1
  fi
  if ! /usr/bin/perl -e 'exit($ARGV[0] < 2.5 ? 0 : 1)' "${elapsed}"; then
    printf '%s\n' "outer wrapper loss: supervisor teardown exceeded its pre-expiry bound (${elapsed}s)" >&2
    exit 1
  fi
  if [[ ! "${output}" =~ S4_TEST_OUTER_LOSS_READY[[:space:]]descendant=([0-9]+) ]]; then
    printf '%s\n' 'outer wrapper loss: fixture never reported its descendant' >&2
    exit 1
  fi
  descendant_pid="${BASH_REMATCH[1]}"
  if kill -0 "${descendant_pid}" 2>/dev/null; then
    printf '%s\n' 'outer wrapper loss: supervisor left a TERM-resistant descendant alive' >&2
    exit 1
  fi
  assert_published_groups_are_empty 'outer wrapper loss supervisor-owned teardown' "${output}"
  case "${output}" in
    *'unexpected focused test after outer wrapper loss'*)
      printf '%s\n' 'outer wrapper loss: later S4 command started' >&2
      exit 1
      ;;
    *) ;;
  esac
)

run_private_lifecycle_environment_cases
run_post_spawn_reap_case before-private-capture-publish-force-failure
run_post_spawn_reap_case before-cont-identity-mismatch
run_post_spawn_reap_case before-cont-force-failure
run_prepublication_reaper_failure_case ''
run_prepublication_reaper_failure_case TERM
run_post_leader_group_observation_failure_case
run_pre_exec_identity_race_case
run_normal_leader_exit_descendant_case
run_normal_term_accepts_descendant_case
run_stale_identity_case
run_outer_wrapper_loss_case

set +e
self_test_output="$(bash "${SCRIPT_PATH}" --self-test 2>&1)"
readonly self_test_status=$?
set -e

if [[ "${self_test_status}" -ne 78 ]]; then
  printf '%s\n' 'expected the missing protected hard-reject corpus to block self-test accuracy evidence' >&2
  exit 1
fi

assert_terminal_summary \
  'real self-test' \
  "${self_test_output}" \
  'blocked' \
  'PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE' \
  78 \
  78 \
  0 \
  0 \
  0

self_test_terminal="${self_test_output##*$'\n'}"
case "${self_test_terminal}" in
  *'"code":"PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"'* ) ;;
  *)
    printf '%s\n' 'expected the terminal wrapper record to name the protected-corpus blocker' >&2
    exit 1
    ;;
esac

# The measurable half must actually be measured: refusing the whole corpus
# because half of it is unavailable discards evidence that costs nothing to get.
case "${self_test_output}" in
  *'"evaluated_count":150'* ) ;;
  *)
    printf '%s\n' 'expected the 150 available bodies to be screened and reported' >&2
    exit 1
    ;;
esac

case "${self_test_output}" in
  *'"legitimate_false_positive_rate"'* ) ;;
  *)
    printf '%s\n' 'expected a measured false-positive rate for the available half' >&2
    exit 1
    ;;
esac

# ...and must never be mistaken for the half that was not measured, nor for a
# model-derived number when a fixture answered.
case "${self_test_output}" in
  *'"hard_reject_false_negative_rate"'* ) ;;
  *)
    printf '%s\n' 'expected the false-negative metric to be named unmeasured' >&2
    exit 1
    ;;
esac

case "${self_test_output}" in
  *'fixture-not-model-evidence'* ) ;;
  *)
    printf '%s\n' 'expected the fixture-derived run to declare its evidence class' >&2
    exit 1
    ;;
esac

case "${self_test_output}" in
  *'"verdict":"pass"'* )
    printf '%s\n' 'a partial run reported a passing verdict' >&2
    exit 1
    ;;
  *) ;;
esac

set +e
unset S4_STAGING_SCREENING_URL S4_STAGING_OAUTH_DRY_CHECK_URL S4_STAGING_BEARER_TOKEN
blocked_output="$(bash "${SCRIPT_PATH}" 2>&1)"
readonly blocked_status=$?
set -e

if [[ "${blocked_status}" -ne 78 ]]; then
  printf '%s\n' 'expected unavailable staging to exit 78' >&2
  exit 1
fi

assert_terminal_summary \
  'real unavailable live gate' \
  "${blocked_output}" \
  'blocked' \
  'S4_LIVE_GATE_BLOCKED' \
  78 \
  78 \
  0 \
  0 \
  0

blocked_terminal="${blocked_output##*$'\n'}"
case "${blocked_terminal}" in
  *'"code":"S4_LIVE_GATE_BLOCKED"'* ) ;;
  *)
    printf '%s\n' 'expected the terminal wrapper record to block unavailable staging' >&2
    exit 1
    ;;
esac

case "${blocked_terminal}" in
  *http://*|*https://*|*Bearer\ * )
    printf '%s\n' 'structured blocked terminal record exposed configuration material' >&2
    exit 1
    ;;
  *) ;;
esac

# Cover the complete terminal-state cross-product in both runner modes. The
# runner is first; status 78 is a blocker only when every focused test is zero.
for runner_mode in live self-test; do
  if [[ "${runner_mode}" == "self-test" ]]; then
    pass_code='S4_SELF_TEST_GREEN'
    blocked_code='PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE'
  else
    pass_code='S4_STAGING_DRY_CHECK_GREEN'
    blocked_code='S4_LIVE_GATE_BLOCKED'
  fi

  run_planted_status_case "${runner_mode} all-zero" "${runner_mode}" 0 0 0 0 pass "${pass_code}" 0
  run_planted_status_case "${runner_mode} runner-78-tests-zero" "${runner_mode}" 78 0 0 0 blocked "${blocked_code}" 78
  run_planted_status_case "${runner_mode} runner-error" "${runner_mode}" 41 0 0 0 fail S4_RUNNER_FAILED 1
  run_planted_status_case "${runner_mode} runner-exit-64-is-normalized" "${runner_mode}" 64 0 0 0 fail S4_RUNNER_FAILED 1
  run_planted_status_case "${runner_mode} oauth-test-error" "${runner_mode}" 0 42 0 0 fail S4_OAUTH_DRY_CHECK_TEST_FAILED 1
  run_planted_status_case "${runner_mode} runner-test-error" "${runner_mode}" 0 0 43 0 fail S4_RUNNER_TEST_FAILED 1
  run_planted_status_case "${runner_mode} legitimate-test-error" "${runner_mode}" 0 0 0 44 fail S4_LEGITIMATE_ONLY_TEST_FAILED 1
  run_planted_status_case "${runner_mode} blocker-plus-test-error" "${runner_mode}" 78 45 0 0 fail S4_OAUTH_DRY_CHECK_TEST_FAILED 1
  run_planted_status_case "${runner_mode} first-runner-error" "${runner_mode}" 46 47 0 0 fail S4_RUNNER_FAILED 1
done

run_planted_runner_signal_case HUP 129
run_planted_runner_signal_case INT 130
run_planted_runner_signal_case TERM 143

run_parent_signal_case() (
  local lifecycle_hook="$1"
  local signal_name="$2"
  local signal_status="$3"
  local output
  local wrapper_status
  local expected_status="${signal_status}"
  local expected_code="S4_WRAPPER_INTERRUPTED_${signal_name}"
  local expected_exit_code="${signal_status}"
  local descendant_pid
  local started_at=${SECONDS}

  # The wrapper itself delivers the real HUP/INT/TERM at each exact lifecycle
  # boundary. This Bash parent preserves SIGINT's default disposition, unlike a
  # JS subprocess that may inherit it as ignored.
  # shellcheck disable=SC2329 # Imported and invoked by the child wrapper.
  bun() {
    case "${1:-}" in
      e2e/screening/s4-runner.ts)
        if [[ "${S4_WRAPPER_TEST_LIFECYCLE_HOOK}" == "after-wait-before-ownership-clear" ]]; then
          bash -c "sleep 0.05" &
        else
          /usr/bin/perl -e '
            $0 = q{S4_TEST_SELF_EXPIRING_DESCENDANT};
            $SIG{TERM} = q{IGNORE};
            $SIG{ALRM} = sub { exit 0 };
            alarm 3;
            while (1) { }
          ' &
        fi
        descendant=$!
        printf 'S4_TEST_RUNNER_READY descendant=%s\n' "${descendant}"
        if [[ "${S4_WRAPPER_TEST_LIFECYCLE_HOOK}" == "during-wait" ]]; then
          (sleep 0.01; kill -"${S4_WRAPPER_TEST_SIGNAL}" "${S4_WRAPPER_TEST_WRAPPER_PID}") &
        fi
        wait "${descendant}"
        ;;
      test)
        printf '%s\n' 'unexpected focused test after parent signal' >&2
        return 125
        ;;
      *)
        printf '%s\n' 'unexpected planted signal command' >&2
        return 125
        ;;
    esac
  }
  export -f bun

  # Command substitutions inherit SIGINT ignored from non-interactive Bash on
  # some launchers. Reset it in the execing process so this remains a real
  # process-level INT delivery test rather than a disposition-dependent fake.
  run_bounded_capture 6 \
    env \
    "S4_WRAPPER_TEST_LIFECYCLE_HOOK=${lifecycle_hook}" \
    "S4_WRAPPER_TEST_SIGNAL=${signal_name}" \
    S4_WRAPPER_TEST_CAPTURE_GROUPS=1 \
    "S4_WRAPPER_TEST_AUTHORITY=${S4_PRIVATE_TEST_AUTHORITY}" \
    "S4_WRAPPER_TEST_CAPABILITY=${S4_PRIVATE_TEST_CAPABILITY}" \
    /usr/bin/perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV' \
    bash "${SCRIPT_PATH}" --self-test
  output="${S4_CAPTURE_OUTPUT}"
  wrapper_status="${S4_CAPTURE_STATUS}"

  if [[ "${lifecycle_hook}" == after-wait-before-ownership-clear ]]; then
    # The command leader was already reaped at this boundary. The wrapper has
    # no exact group identity left, so it must report the cleanup refusal rather
    # than fabricate a clean interrupted result.
    expected_status=1
    expected_code=S4_ACTIVE_COMMAND_REAP_FAILED
    expected_exit_code=1
  fi

  if [[ "${wrapper_status}" -eq 124 ]]; then
    printf '%s\n' "${lifecycle_hook}/${signal_name}: bounded capture exhausted its deadline" >&2
    exit 1
  fi

  if [[ "${wrapper_status}" -ne "${expected_status}" ]]; then
    printf '%s\n' "${lifecycle_hook}/${signal_name}: expected exit ${expected_status}, got ${wrapper_status}" >&2
    exit 1
  fi
  if ((SECONDS - started_at > 7)); then
    printf '%s\n' "${lifecycle_hook}/${signal_name}: wrapper exceeded the bounded signal-cleanup window" >&2
    exit 1
  fi
  if [[ ! "${output}" =~ S4_TEST_RUNNER_READY[[:space:]]descendant=([0-9]+) ]]; then
    printf '%s\n' "${lifecycle_hook}/${signal_name}: planted runner never created its descendant" >&2
    exit 1
  fi
  descendant_pid="${BASH_REMATCH[1]}"
  if kill -0 "${descendant_pid}" 2>/dev/null; then
    printf '%s\n' "${lifecycle_hook}/${signal_name}: planted descendant survived wrapper termination" >&2
    exit 1
  fi

  assert_terminal_summary \
    "${lifecycle_hook}/${signal_name} parent signal" \
    "${output}" \
    fail \
    "${expected_code}" \
    "${expected_exit_code}" \
    null \
    null \
    null \
    null
  assert_published_groups_are_empty "${lifecycle_hook}/${signal_name} parent signal" "${output}"

  case "${output}" in
    *'unexpected focused test after parent signal'*)
      printf '%s\n' "${lifecycle_hook}/${signal_name}: wrapper started a focused test after interruption" >&2
      exit 1
      ;;
    *) ;;
  esac
)

for lifecycle_hook in after-spawn-before-ownership after-wait-before-ownership-clear; do
  run_parent_signal_case "${lifecycle_hook}" HUP 129
  run_parent_signal_case "${lifecycle_hook}" INT 130
  run_parent_signal_case "${lifecycle_hook}" TERM 143
done
for signal_name in HUP INT TERM; do
  case "${signal_name}" in
    HUP) signal_status=129 ;;
    INT) signal_status=130 ;;
    TERM) signal_status=143 ;;
  esac
  run_parent_signal_case during-wait "${signal_name}" "${signal_status}"
done

# The wrapper's own usage exit remains 64; a child returning 64 was normalized
# to 1 above, so callers cannot confuse a runner failure with bad wrapper args.

set +e
missing_bun_output="$(PATH='/usr/bin:/bin' /bin/bash "${SCRIPT_PATH}" --self-test 2>&1)"
readonly missing_bun_status=$?
set -e

if [[ "${missing_bun_status}" -ne 78 ]]; then
  printf '%s\n' 'expected a missing bun executable to block with exit 78' >&2
  exit 1
fi

assert_terminal_summary \
  'missing bun' \
  "${missing_bun_output}" \
  'blocked' \
  'S4_BUN_UNAVAILABLE' \
  78 \
  null \
  null \
  null \
  null

set +e
usage_output="$(bash "${SCRIPT_PATH}" --unexpected 2>&1)"
readonly usage_status=$?
set -e

if [[ "${usage_status}" -ne 64 ]]; then
  printf '%s\n' 'expected an unexpected argument to exit 64' >&2
  exit 1
fi

assert_terminal_summary \
  'usage error' \
  "${usage_output}" \
  'fail' \
  'S4_USAGE_ERROR' \
  64 \
  null \
  null \
  null \
  null

assert_no_s4_fixture_survivors
