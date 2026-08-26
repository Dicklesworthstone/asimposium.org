#!/usr/bin/env bash
# S-4 production-configuration dry check. This script neither changes OAuth
# configuration nor calls a cloud console. A missing Workers AI staging route
# is BLOCKED, never a simulated pass.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT

active_child_pid=''
active_child_pgid=''
active_child_identity=''
controlled_command_lifecycle_failed=0
captured_runner_status=null
captured_oauth_dry_check_test_status=null
captured_runner_test_status=null
captured_legitimate_only_test_status=null
parent_signal_deferral_active=0
pending_parent_signal=''
pending_parent_signal_exit_code=''
private_lifecycle_test_authorized=0

readonly S4_PRIVATE_SELF_TEST_AUTHORITY='e2e/screening/e2e-s4-screening-oauth.test.sh'
readonly S4_PRIVATE_SELF_TEST_CAPABILITY='s4-screening-lifecycle-v1'

# These are set only after the private self-test contract is accepted. Clear
# caller-provided lookalikes before any production invocation can launch Perl.
unset S4_PRIVATE_LIFECYCLE_TEST_ACTIVE S4_PRIVATE_PRE_EXEC_RACE_DELAY

# A non-interactive launcher can inherit SIGINT as ignored. Restore the default
# disposition before installing the wrapper's explicit HUP/INT/TERM handlers.
trap - INT

json_quote() {
  local value="$1"
  local escaped=""
  local char
  local code
  local index

  # Bash string slicing preserves non-control UTF-8 bytes while explicitly
  # encoding every JSON-significant ASCII/control character.
  for ((index = 0; index < ${#value}; index += 1)); do
    char="${value:index:1}"
    case "${char}" in
      '"') escaped+='\"' ;;
      $'\\') escaped+=$'\\\\' ;;
      $'\b') escaped+='\b' ;;
      $'\f') escaped+='\f' ;;
      $'\n') escaped+='\n' ;;
      $'\r') escaped+='\r' ;;
      $'\t') escaped+='\t' ;;
      *)
        if [[ "${char}" == [[:cntrl:]] ]]; then
          printf -v code '%d' "'${char}"
          printf -v char '\\u%04x' "${code}"
        fi
        escaped+="${char}"
        ;;
    esac
  done
  printf '"%s"' "${escaped}"
}

emit_terminal_summary() {
  local status="$1"
  local code="$2"
  local exit_code="$3"
  local detail="$4"
  local runner_status="$5"
  local oauth_dry_check_test_status="$6"
  local runner_test_status="$7"
  local legitimate_only_test_status="$8"

  printf '%s' '{"record_type":"s4-terminal-summary","suite":"s4-screening-oauth","status":'
  json_quote "${status}"
  printf '%s' ',"code":'
  json_quote "${code}"
  printf '%s' ',"exit_code":'
  printf '%d' "${exit_code}"
  printf '%s' ',"runner_status":'
  printf '%s' "${runner_status}"
  printf '%s' ',"oauth_dry_check_test_status":'
  printf '%s' "${oauth_dry_check_test_status}"
  printf '%s' ',"runner_test_status":'
  printf '%s' "${runner_test_status}"
  printf '%s' ',"legitimate_only_test_status":'
  printf '%s' "${legitimate_only_test_status}"
  printf '%s' ',"detail":'
  json_quote "${detail}"
  printf '%s\n' '}'
}

signal_name_for_status() {
  case "$1" in
    129) printf '%s' HUP ;;
    130) printf '%s' INT ;;
    143) printf '%s' TERM ;;
    *) return 1 ;;
  esac
}

terminate_for_signal() {
  local signal="$1"
  local exit_code="$2"
  local runner_status="$3"
  local oauth_dry_check_test_status="$4"
  local runner_test_status="$5"
  local legitimate_only_test_status="$6"

  emit_terminal_summary \
    fail \
    "S4_WRAPPER_INTERRUPTED_${signal}" \
    "${exit_code}" \
    "received ${signal}; no later S4 checks were started" \
    "${runner_status}" \
    "${oauth_dry_check_test_status}" \
    "${runner_test_status}" \
    "${legitimate_only_test_status}"
  exit "${exit_code}"
}

terminate_for_reap_failure() {
  local signal="$1"
  local runner_status="$2"
  local oauth_dry_check_test_status="$3"
  local runner_test_status="$4"
  local legitimate_only_test_status="$5"

  emit_terminal_summary \
    fail \
    S4_ACTIVE_COMMAND_REAP_FAILED \
    1 \
    "received ${signal}, but the active command could not be terminated and reaped safely" \
    "${runner_status}" \
    "${oauth_dry_check_test_status}" \
    "${runner_test_status}" \
    "${legitimate_only_test_status}"
  exit 1
}

clear_active_child_ownership() {
  active_child_pid=''
  active_child_pgid=''
  active_child_identity=''
}

# The process-group number is a routing address, not an identity. Retain the
# group leader's PID, process group, start time, and executable so a recycled
# PID/PGID is never signalled merely because its number matches a completed
# command.
process_identity() {
  local pid="$1"
  local pgid started command

  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null)" || return 1
  started="$(ps -o lstart= -p "${pid}" 2>/dev/null)" || return 1
  command="$(ps -ww -o command= -p "${pid}" 2>/dev/null)" || return 1
  pgid="${pgid//[[:space:]]/}"
  [[ "${pgid}" =~ ^[1-9][0-9]*$ && -n "${started}" && -n "${command}" ]] || return 1
  printf '%s\n' "${pid}|${pgid}|${started}|${command}"
}

active_group_identity_is_exact() {
  local observed

  [[ -n "${active_child_pid}" && -n "${active_child_pgid}" &&
    -n "${active_child_identity}" ]] || return 1
  [[ "${active_child_pid}" == "${active_child_pgid}" ]] || return 1
  observed="$(process_identity "${active_child_pid}")" || return 1
  [[ "${observed}" == "${active_child_identity}" && "${observed}" == "${active_child_pid}"'|'"${active_child_pgid}"'|'* ]]
}

# Return 0 for a live non-zombie member, 1 only for a positively empty group,
# and 2 when process inspection cannot support either conclusion.
group_liveness_state() {
  local pgid="$1"
  local table

  [[ "${pgid}" =~ ^[1-9][0-9]*$ ]] || return 2
  table="$(ps -A -o pid=,pgid=,stat= 2>/dev/null)" || return 2
  [[ -n "${table}" ]] || return 2
  if ! awk '
    NF == 0 { next }
    NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[[:alpha:]?][^[:space:]]*$/ { exit 1 }
  ' <<<"${table}"; then
    return 2
  fi
  if awk -v wanted="${pgid}" 'NF == 0 { next } $2 == wanted && $3 !~ /Z/ { found = 1 } END { exit(found ? 0 : 1) }' <<<"${table}"; then
    return 0
  fi
  return 1
}

wait_for_group_absence() {
  local pgid="$1"
  local attempts state

  for ((attempts = 0; attempts < 30; attempts += 1)); do
    state=0
    group_liveness_state "${pgid}" || state=$?
    if [[ "${state}" -eq 1 ]]; then
      return 0
    fi
    sleep 0.02
  done
  return 1
}

wait_for_child_termination() {
  local child_pid="$1"
  local status

  # The supervisor lives in a dedicated setsid-created session, so this is an
  # ordinary termination wait. A parent signal can interrupt it; returning at
  # once lets run_controlled_command replay the still-deferred signal.
  wait "${child_pid}"
  status=$?
  return "${status}"
}

reap_direct_child_after_kill() {
  local child_pid="$1"
  local attempts state

  [[ "${child_pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  for ((attempts = 0; attempts < 10; attempts += 1)); do
    # Do not wait on a merely live child: even after KILL, an uninterruptible
    # process could otherwise make this cleanup path unbounded. A zombie is
    # already dead, and wait is then only the immediate reaping step.
    state="$(ps -o stat= -p "${child_pid}" 2>/dev/null)" || state=''
    state="${state//[[:space:]]/}"
    if [[ -z "${state}" ]]; then
      wait_for_child_termination "${child_pid}" 2>/dev/null || true
      return 0
    fi
    if [[ "${state}" == Z* ]]; then
      wait_for_child_termination "${child_pid}" 2>/dev/null || true
      return 0
    fi
    sleep 0.01
  done
  return 1
}

# Every post-spawn early return routes through here. Before CONT the stopped
# direct child cannot have launched payload code; after publication the exact
# live leader authorizes one group KILL. Once that leader is reaped, no numeric
# group signal is safe: only a bounded positive-empty observation may finish.
reap_failed_spawn() {
  local child_pid="$1"
  local pgid="${active_child_pgid:-}"

  [[ "${child_pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  if active_group_identity_is_exact; then
    if ! kill -KILL -- "-${active_child_pgid}" 2>/dev/null &&
      kill -0 "${child_pid}" 2>/dev/null; then
      return 1
    fi
  else
    if ! kill -KILL "${child_pid}" 2>/dev/null && kill -0 "${child_pid}" 2>/dev/null; then
      return 1
    fi
  fi
  reap_direct_child_after_kill "${child_pid}" || return 1
  if [[ "${pgid}" =~ ^[1-9][0-9]*$ ]]; then
    wait_for_group_absence "${pgid}" || return 1
  fi
  # Private test seam: model the one remaining failure mode after the direct
  # child was safely reaped but before ownership can be cleared. The caller
  # must latch lifecycle failure even though no active PID remains available.
  run_lifecycle_test_hook after-prepublication-reap || return 1
  clear_active_child_ownership
}

# Every early post-spawn failure must be observable by the suite even when the
# direct child was reaped before ownership was published. Otherwise a later
# command could start after a cleanup result that was neither successful nor
# safely attributable. Replay a deferred terminal signal only after latching
# the state so the signal path also emits the explicit cleanup failure.
return_after_failed_spawn() {
  local child_pid="$1"

  if ! reap_failed_spawn "${child_pid}"; then
    controlled_command_lifecycle_failed=1
  fi
  replay_deferred_parent_signal
  return 125
}

supervisor_identity_is_stopped() {
  local identity="$1"
  local pid state command observed

  pid="${identity%%|*}"
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  observed="$(process_identity "${pid}")" || return 1
  [[ "${observed}" == "${identity}" ]] || return 1
  state="$(ps -o stat= -p "${pid}" 2>/dev/null)" || return 1
  command="$(ps -ww -o command= -p "${pid}" 2>/dev/null)" || return 1
  state="${state//[[:space:]]/}"
  [[ "${state}" == T* ]] || return 1
  [[ "${command}" == *'bash -c s4_controlled_command_supervisor "$@"'* ]]
}

# shellcheck disable=SC2329 # Exported into the dedicated supervisor Bash.
group_has_live_member_other_than() {
  local pgid="$1"
  local excluded_pid="$2"

  [[ "${pgid}" =~ ^[1-9][0-9]*$ && "${excluded_pid}" =~ ^[1-9][0-9]*$ ]] || return 2
  # This helper must not inspect from the supervised process group: its own
  # shell/ps descendants would otherwise look like payload survivors, while a
  # broad ancestry exclusion can hide the real payload descendant. The helper
  # first creates a fresh session, then runs portable ps from that session.
  /usr/bin/perl -MPOSIX=setsid -e '
    my ($wanted, $excluded) = @ARGV;
    exit 2 unless defined($wanted) && defined($excluded) &&
      $wanted =~ /\A[1-9][0-9]*\z/ && $excluded =~ /\A[1-9][0-9]*\z/;
    POSIX::setsid();
    open(my $ps, q{-|}, q{ps}, q{-A}, q{-o}, q{pid=,pgid=,stat=}) or exit 2;
    while (my $row = <$ps>) {
      chomp($row);
      next if $row =~ /^\s*$/;
      my ($pid, $member_pgid, $state) =
        $row =~ /^\s*([0-9]+)\s+([0-9]+)\s+([^\s]+)\s*\z/;
      exit 2 unless defined($pid) && defined($member_pgid) && defined($state);
      next if $member_pgid != $wanted || $pid == $excluded || $state =~ /Z/;
      close($ps);
      exit 0;
    }
    close($ps);
    exit 1;
  ' "${pgid}" "${excluded_pid}"
}

# shellcheck disable=SC2329 # Invoked by the dedicated supervisor Bash.
s4_controlled_command_supervisor() {
  local terminal_signal_seen=0
  local cleanup_group_signal_in_progress=0
  local child
  local status
  local pgid
  local attempts state

  trap '[[ "${cleanup_group_signal_in_progress}" -eq 1 ]] || terminal_signal_seen=1' HUP INT TERM
  # The outer wrapper created this supervisor with setsid. Its payload must
  # remain in that private group, so monitor mode stays disabled before spawn.
  # A stopped leader gives the outer wrapper a deterministic identity-pinning
  # boundary; there is no timing grace period.
  set +m
  kill -STOP "${BASHPID}"
  pgid="$(ps -o pgid= -p "${BASHPID}" 2>/dev/null)" || return 125
  pgid="${pgid//[[:space:]]/}"
  [[ "${pgid}" == "${BASHPID}" ]] || return 125

  "$@" &
  child=$!
  wait "${child}"
  status=$?
  if [[ "${terminal_signal_seen}" -eq 1 ]]; then
    # The outer wrapper normally owns prompt signal cleanup. If it disappears
    # after forwarding the signal, however, this still-live session leader is
    # the only continuously exact authority over its group. Give ordinary
    # cleanup a short bounded grace, then terminate the entire group itself;
    # KILL includes this supervisor, so an abandoned TERM-resistant payload
    # cannot retain the test pipe or become an orphaned busy loop.
    cleanup_group_signal_in_progress=1
    for ((attempts = 0; attempts < 10; attempts += 1)); do
      state=0
      group_has_live_member_other_than "${pgid}" "${BASHPID}" || state=$?
      [[ "${state}" -eq 1 ]] && return 125
      sleep 0.01
    done
    kill -KILL -- "-${pgid}" 2>/dev/null || return 125
    return 125
  fi

  # A leader's normal return does not prove that its background descendants
  # returned. While this supervisor remains the exact group leader, a positive
  # member observation keeps the PGID safe to signal. Do not preserve payload
  # status until no live member other than this supervisor remains.
  state=0
  group_has_live_member_other_than "${pgid}" "${BASHPID}" || state=$?
  [[ "${state}" -eq 1 ]] && return "${status}"
  if [[ "${state}" -ne 0 ]]; then
    # Inspection is inconclusive, so never claim a normal payload return. The
    # outer pin still authorizes one bounded whole-group KILL.
    kill -KILL -- "-${pgid}" 2>/dev/null || return 125
    return 125
  fi

  cleanup_group_signal_in_progress=1
  kill -TERM -- "-${pgid}" 2>/dev/null || return 125

  for ((attempts = 0; attempts < 10; attempts += 1)); do
    state=0
    group_has_live_member_other_than "${pgid}" "${BASHPID}" || state=$?
    [[ "${state}" -eq 1 ]] && break
    sleep 0.01
  done
  if [[ "${state}" -ne 1 ]]; then
    # The still-live leader pins the entire process group, so escalation cannot
    # target a recycled numeric PGID. KILL also terminates this supervisor; the
    # outer wrapper then positively verifies zero group members before it emits
    # the typed runner failure.
    group_has_live_member_other_than "${pgid}" "${BASHPID}" || {
      kill -KILL -- "-${pgid}" 2>/dev/null || return 125
      return 125
    }
    kill -KILL -- "-${pgid}" 2>/dev/null || exit 137
    exit 137
  fi
  # TERM removed every payload member. This still makes the command fail: its
  # payload leader returned while a descendant remained. Use the generic
  # controlled-command failure result because an ordinary payload may itself
  # exit 76, so that numeric status cannot safely encode lifecycle provenance.
  return 125
}

terminate_and_reap_active_child() {
  local signal="$1"
  local child_pid="${active_child_pid}"
  local attempts state

  [[ -n "${child_pid}" ]] || return 0

  # A leader that ignores terminal signals keeps the identity pin live through
  # the grace period. If its identity is stale, do not guess that a numeric
  # PGID still belongs to us. Its still-unreaped direct PID is safe to KILL and
  # reap, but no descendant group signal remains authorized afterward.
  if ! active_group_identity_is_exact; then
    kill -KILL "${child_pid}" 2>/dev/null || true
    reap_direct_child_after_kill "${child_pid}" || return 1
    if [[ "${active_child_pgid}" =~ ^[1-9][0-9]*$ ]]; then
      # The leader is gone. This is observation-only: a nonempty or unknown
      # result is a cleanup failure, never authority for a later group signal.
      wait_for_group_absence "${active_child_pgid}" || return 1
    fi
    clear_active_child_ownership
    return 1
  fi
  if ! kill -s "${signal}" -- "-${active_child_pgid}" 2>/dev/null; then
    # A concurrently self-cleaning supervisor may have removed the exact
    # leader between the identity check and this signal. Reap only the direct
    # child and observe the old group; no leaderless numeric group signal is
    # permitted on this path.
    reap_direct_child_after_kill "${child_pid}" || return 1
    wait_for_group_absence "${active_child_pgid}" || return 1
    clear_active_child_ownership
    return 0
  fi
  run_lifecycle_test_hook after-parent-signal-forwarded

  for ((attempts = 0; attempts < 20; attempts += 1)); do
    state=0
    group_liveness_state "${active_child_pgid}" || state=$?
    [[ "${state}" -eq 1 ]] && break
    sleep 0.01
  done
  if [[ "${state}" -ne 1 ]]; then
    # Escalation is another group signal, so it repeats the exact-identity gate.
    if active_group_identity_is_exact; then
      kill -KILL -- "-${active_child_pgid}" 2>/dev/null || return 1
    else
      # The supervisor may have performed its bounded self-cleanup. Its leader
      # is gone, so only a bounded positive-empty observation remains safe.
      reap_direct_child_after_kill "${child_pid}" || return 1
      wait_for_group_absence "${active_child_pgid}" || return 1
      clear_active_child_ownership
      return 0
    fi
  fi
  reap_direct_child_after_kill "${child_pid}" || return 1
  # The leader was just reaped. Do not turn a later live/unknown observation
  # into another group signal: the numeric PGID could already be recycled.
  wait_for_group_absence "${active_child_pgid}" || return 1
  clear_active_child_ownership
}

begin_parent_signal_deferral() {
  parent_signal_deferral_active=1
}

replay_deferred_parent_signal() {
  local signal="${pending_parent_signal}"
  local exit_code="${pending_parent_signal_exit_code}"

  parent_signal_deferral_active=0
  pending_parent_signal=''
  pending_parent_signal_exit_code=''
  if [[ -n "${signal}" ]]; then
    handle_parent_signal "${signal}" "${exit_code}"
  fi
}

run_lifecycle_test_hook() {
  local boundary="$1"

  [[ "${private_lifecycle_test_authorized}" -eq 1 ]] || return 0

  case "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}" in
    '') return ;;
    pre-exec-before-supervisor-stop)
      # The private Perl launch delay is the probe. No signal is injected here:
      # the ownership loop must refuse the setsid-complete Perl pre-exec state.
      return
      ;;
    after-spawn-before-ownership)
      [[ "${boundary}" == after-spawn-before-ownership ]] || return 0
      # The supervisor is deliberately stopped here, before it launches the
      # payload. This exercises deferred pre-ownership signal delivery without
      # relying on a race to observe a descendant.
      ;;
    after-wait-before-ownership-clear)
      [[ "${boundary}" == after-wait-before-ownership-clear ]] || return 0
      ;;
    after-ownership-before-wait)
      [[ "${boundary}" == after-ownership-before-wait ]] || return 0
      # Test only: model a stale recorded leader identity. The signal handler
      # must then refuse the numeric process group instead of treating its
      # number as authority over a possibly recycled group.
      active_child_identity="${active_child_identity}:stale"
      ;;
    before-private-capture-publish-force-failure)
      [[ "${boundary}" == before-private-capture-publish ]] || return 0
      # Exercise the post-spawn control-relay failure without allowing a test
      # caller to alter production behavior.
      return 125
      ;;
    before-cont-identity-mismatch)
      [[ "${boundary}" == before-cont ]] || return 0
      active_child_identity="${active_child_identity}:stale"
      return 0
      ;;
    before-cont-force-failure)
      [[ "${boundary}" == before-cont ]] || return 0
      return 125
      ;;
    prepublication-reaper-force-failure)
      case "${boundary}" in
        after-spawn-before-ownership) ;;
        before-ownership-loop|after-prepublication-reap) return 125 ;;
        *) return 0 ;;
      esac
      ;;
    post-leader-group-nonempty-force-failure)
      # The exact supervisor was already reaped at this boundary. This models
      # a live/unknown post-leader group observation: it must become a typed
      # lifecycle failure, never a leaderless numeric-PGID signal.
      [[ "${boundary}" == after-leader-reap-before-group-absence ]] || return 0
      return 125
      ;;
    after-parent-signal-forwarded-kill-wrapper)
      case "${boundary}" in
        during-wait) ;;
        after-parent-signal-forwarded) kill -KILL "${BASHPID}" ;;
        *) return 0 ;;
      esac
      ;;
    *) return 0 ;;
  esac

  case "${S4_WRAPPER_TEST_SIGNAL:-}" in
    '') return 0 ;;
    HUP) kill -HUP "${BASHPID}" ;;
    INT) kill -INT "${BASHPID}" ;;
    TERM) kill -TERM "${BASHPID}" ;;
    *)
      printf '%s\n' 'S4 lifecycle test requested an invalid signal' >&2
      return 125
      ;;
  esac
}

# shellcheck disable=SC2329 # Invoked by the signal traps below.
handle_parent_signal() {
  local signal="$1"
  local exit_code="$2"

  if [[ "${parent_signal_deferral_active}" -eq 1 ]]; then
    # Preserve the first terminal signal exactly. It is replayed only after the
    # active command's ownership is either fully published or fully cleared.
    if [[ -z "${pending_parent_signal}" ]]; then
      pending_parent_signal="${signal}"
      pending_parent_signal_exit_code="${exit_code}"
    fi
    return
  fi

  # A second terminal signal during cleanup must not create a competing
  # summary. The active command receives the original signal as a process
  # group, and the wrapper records the statuses captured before interruption.
  trap '' HUP INT TERM
  set +e
  if [[ "${controlled_command_lifecycle_failed}" -eq 1 ]]; then
    terminate_for_reap_failure \
      "${signal}" \
      "${captured_runner_status}" \
      "${captured_oauth_dry_check_test_status}" \
      "${captured_runner_test_status}" \
      "${captured_legitimate_only_test_status}"
  fi
  if ! terminate_and_reap_active_child "${signal}"; then
    terminate_for_reap_failure \
      "${signal}" \
      "${captured_runner_status}" \
      "${captured_oauth_dry_check_test_status}" \
      "${captured_runner_test_status}" \
      "${captured_legitimate_only_test_status}"
  fi
  terminate_for_signal \
    "${signal}" \
    "${exit_code}" \
    "${captured_runner_status}" \
    "${captured_oauth_dry_check_test_status}" \
    "${captured_runner_test_status}" \
    "${captured_legitimate_only_test_status}"
}

trap 'handle_parent_signal HUP 129' HUP
trap 'handle_parent_signal INT 130' INT
trap 'handle_parent_signal TERM 143' TERM
if [[ -n "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}" ]]; then
  : # Test variables are activated only by the private self-test validation.
fi

private_lifecycle_test_configuration() {
  local requested=0

  if [[ -n "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}${S4_WRAPPER_TEST_SIGNAL:-}${S4_WRAPPER_TEST_AUTHORITY:-}${S4_WRAPPER_TEST_CAPABILITY:-}${S4_WRAPPER_TEST_CAPTURE_GROUPS:-}" ]]; then
    requested=1
  fi
  [[ "${requested}" -eq 1 ]] || return 1

  [[ "${S4_WRAPPER_TEST_AUTHORITY:-}" == "${S4_PRIVATE_SELF_TEST_AUTHORITY}" &&
    "${S4_WRAPPER_TEST_CAPABILITY:-}" == "${S4_PRIVATE_SELF_TEST_CAPABILITY}" ]] || return 2
  case "${S4_WRAPPER_TEST_CAPTURE_GROUPS:-}" in
    ''|1) ;;
    *) return 2 ;;
  esac
  if [[ "${S4_WRAPPER_TEST_CAPTURE_GROUPS:-}" == 1 ]]; then
    [[ "${S4_CAPTURE_CONTROL_FD:-}" =~ ^[3-9][0-9]*$ ]] || return 2
  fi
  if [[ "${S4_WRAPPER_TEST_CAPTURE_GROUPS:-}" == 1 &&
    -z "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}${S4_WRAPPER_TEST_SIGNAL:-}" ]]; then
    return 0
  fi
  case "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}" in
    pre-exec-before-supervisor-stop|before-private-capture-publish-force-failure|before-cont-identity-mismatch|before-cont-force-failure|post-leader-group-nonempty-force-failure|json-quote-terminal-probe)
      [[ -z "${S4_WRAPPER_TEST_SIGNAL:-}" ]] || return 2
      return 0
      ;;
    prepublication-reaper-force-failure)
      case "${S4_WRAPPER_TEST_SIGNAL:-}" in
        ''|HUP|INT|TERM) return 0 ;;
        *) return 2 ;;
      esac
      ;;
    after-spawn-before-ownership|after-ownership-before-wait|during-wait|after-wait-before-ownership-clear|after-parent-signal-forwarded-kill-wrapper) ;;
    *) return 2 ;;
  esac
  case "${S4_WRAPPER_TEST_SIGNAL:-}" in
    HUP|INT|TERM) ;;
    *) return 2 ;;
  esac
  return 0
}

publish_private_capture_group() {
  local control_fd="${S4_CAPTURE_CONTROL_FD:-}"

  [[ "${private_lifecycle_test_authorized}" -eq 1 ]] || return 0
  [[ "${S4_WRAPPER_TEST_CAPTURE_GROUPS:-}" == 1 ]] || return 0
  [[ -n "${control_fd}" ]] || return 0
  [[ "${control_fd}" =~ ^[3-9][0-9]*$ ]] || return 1
  [[ "${active_child_pgid}" =~ ^[1-9][0-9]*$ ]] || return 1
  printf 'S4_CAPTURE_GROUP %s\n' "${active_child_pgid}" >&"${control_fd}"
}

activate_private_lifecycle_test_if_authorized() {
  local configuration_status=0

  private_lifecycle_test_configuration || configuration_status=$?
  case "${configuration_status}" in
    0)
      private_lifecycle_test_authorized=1
      # In a command substitution, $$ remains the invoking shell's PID. The
      # lifecycle helper must target this wrapper process, not that caller.
      export S4_WRAPPER_TEST_WRAPPER_PID="${BASHPID}"
      export S4_PRIVATE_LIFECYCLE_TEST_ACTIVE=1
      if [[ "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}" == json-quote-terminal-probe ]]; then
        emit_terminal_summary \
          fail \
          S4_JSON_QUOTE_PROBE \
          64 \
          $'private JSON quote probe: " \\ \t \n \001' \
          null \
          null \
          null \
          null
        return 64
      fi
      if [[ "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}" == pre-exec-before-supervisor-stop ]]; then
        export S4_PRIVATE_PRE_EXEC_RACE_DELAY=1
      fi
      return 0
      ;;
    1) return 0 ;;
    *)
      emit_terminal_summary \
        fail \
        S4_PRIVATE_SELF_TEST_CONFIGURATION_INVALID \
        64 \
        "private lifecycle fixtures require the test driver's exact authority, capability, hook, and signal" \
        null \
        null \
        null \
        null
      return 64
      ;;
  esac
}

run_controlled_command() {
  local status
  local spawned_child_pid
  local spawned_child_identity
  local previous_child_identity=''
  local attempts

  # Monitor mode is not portable in a no-controlling-terminal shell: Darwin
  # leaves a background function in the wrapper's group. Start a non-leader
  # Perl child with setsid instead; the external Bash that inherits it becomes
  # the supervisor and owns a private, identity-pinned process group.
  begin_parent_signal_deferral
  set +m
  export -f s4_controlled_command_supervisor group_has_live_member_other_than
  # This supervisor stops before launching its payload. The parent can therefore
  # publish an exact PID/PGID/start-time/command identity before the payload has
  # any opportunity to return or fork a descendant.
  /usr/bin/perl -MPOSIX=setsid -e '
    setsid() == -1 and exit 125;
    if (($ENV{S4_PRIVATE_LIFECYCLE_TEST_ACTIVE} // q{}) eq q{1} &&
        ($ENV{S4_PRIVATE_PRE_EXEC_RACE_DELAY} // q{}) eq q{1}) {
      select undef, undef, undef, 0.10;
    }
    exec @ARGV;
    exit 125;
  ' bash -c 's4_controlled_command_supervisor "$@"' s4-control-supervisor "$@" &
  spawned_child_pid=$!
  run_lifecycle_test_hook after-spawn-before-ownership
  if ! run_lifecycle_test_hook before-ownership-loop; then
    return_after_failed_spawn "${spawned_child_pid}"
    return $?
  fi
  for ((attempts = 0; attempts < 30; attempts += 1)); do
    spawned_child_identity="$(process_identity "${spawned_child_pid}")" || spawned_child_identity=''
    if [[ "${spawned_child_identity}" == "${spawned_child_pid}"'|'"${spawned_child_pid}"'|'* &&
      "${spawned_child_identity}" == "${previous_child_identity}" ]] &&
      supervisor_identity_is_stopped "${spawned_child_identity}"; then
      active_child_pid="${spawned_child_pid}"
      active_child_pgid="${spawned_child_pid}"
      active_child_identity="${spawned_child_identity}"
      if ! run_lifecycle_test_hook before-private-capture-publish || ! publish_private_capture_group; then
        return_after_failed_spawn "${spawned_child_pid}"
        return $?
      fi
      break
    fi
    previous_child_identity="${spawned_child_identity}"
    sleep 0.01
  done
  if [[ -z "${active_child_identity}" ]]; then
    # The direct child has not been reaped, so this narrow direct signal cannot
    # be redirected to a recycled PID. There is no safe group-level fallback.
    # The child is deliberately stopped before payload launch; TERM would stay
    # pending on that stopped process. Its still-unreaped direct PID is safe to
    # KILL without a process-group fallback.
    return_after_failed_spawn "${spawned_child_pid}"
    return $?
  fi
  # The stopped process is still the exact direct child pinned above. Starting
  # it only after ownership publication removes the former sleep-based race.
  if ! run_lifecycle_test_hook before-cont || ! active_group_identity_is_exact || ! kill -CONT "${active_child_pid}" 2>/dev/null; then
    return_after_failed_spawn "${spawned_child_pid}"
    return $?
  fi
  replay_deferred_parent_signal
  run_lifecycle_test_hook after-ownership-before-wait

  # A terminal signal interrupts wait promptly; its trap records the signal,
  # then it is forwarded and reaped while ownership is still published.
  begin_parent_signal_deferral
  wait_for_child_termination "${active_child_pid}"
  status=$?
  if [[ -n "${pending_parent_signal}" ]]; then
    replay_deferred_parent_signal
  fi
  run_lifecycle_test_hook after-wait-before-ownership-clear
  if [[ -n "${pending_parent_signal}" ]]; then
    replay_deferred_parent_signal
  fi
  # The supervisor does not return a payload status until it found zero live
  # payload members (or it self-KILLed its pinned group). Clear ownership only
  # after independently proving that the entire group is now empty.
  if ! run_lifecycle_test_hook after-leader-reap-before-group-absence ||
    ! wait_for_group_absence "${active_child_pgid}"; then
    # The exact leader was reaped by wait above. A later nonempty/unknown
    # observation cannot authorize a numeric group signal, because that group
    # may have emptied and had its number recycled. Leave ownership latched
    # for the typed suite guard and never signal it leaderlessly.
    controlled_command_lifecycle_failed=1
    replay_deferred_parent_signal
    return 125
  fi
  clear_active_child_ownership
  replay_deferred_parent_signal
  return "${status}"
}

fail_if_active_controlled_command_remains() {
  local command_name="$1"
  local detail

  if [[ "${controlled_command_lifecycle_failed}" -ne 1 && -z "${active_child_pid}" ]]; then
    return 0
  fi
  if [[ "${controlled_command_lifecycle_failed}" -eq 1 ]]; then
    detail="the ${command_name} cleanup could not prove zero survivors; no later S4 checks were started"
  else
    detail="the ${command_name} leader returned while its identity-pinned process group remained live; no later S4 checks were started"
  fi
  emit_terminal_summary \
    fail \
    S4_ACTIVE_COMMAND_REAP_FAILED \
    1 \
    "${detail}" \
    "${captured_runner_status}" \
    "${captured_oauth_dry_check_test_status}" \
    "${captured_runner_test_status}" \
    "${captured_legitimate_only_test_status}"
  exit 1
}

run_suite() {
  local runner_mode="$1"
  local runner_status
  local oauth_dry_check_test_status
  local runner_test_status
  local legitimate_only_test_status
  local terminal_status
  local terminal_code
  local terminal_exit_code
  local terminal_detail
  local signal

  captured_runner_status=null
  captured_oauth_dry_check_test_status=null
  captured_runner_test_status=null
  captured_legitimate_only_test_status=null
  controlled_command_lifecycle_failed=0

  # Capture every status before deciding the terminal state. This preserves
  # failure diagnostics from all focused checks while guaranteeing one summary.
  set +e
  run_controlled_command bun e2e/screening/s4-runner.ts "${runner_mode}"
  runner_status=$?
  captured_runner_status="${runner_status}"
  fail_if_active_controlled_command_remains runner
  if signal="$(signal_name_for_status "${runner_status}")"; then
    set -e
    terminate_for_signal "${signal}" "${runner_status}" "${runner_status}" null null null
  fi
  run_controlled_command bun test /dev/null --timeout=120000 e2e/screening/oauth-dry-check.test.ts
  oauth_dry_check_test_status=$?
  captured_oauth_dry_check_test_status="${oauth_dry_check_test_status}"
  fail_if_active_controlled_command_remains oauth-dry-check-test
  if signal="$(signal_name_for_status "${oauth_dry_check_test_status}")"; then
    set -e
    terminate_for_signal \
      "${signal}" \
      "${oauth_dry_check_test_status}" \
      "${runner_status}" \
      "${oauth_dry_check_test_status}" \
      null \
      null
  fi
  run_controlled_command bun test /dev/null --timeout=120000 e2e/screening/s4-runner.test.ts
  runner_test_status=$?
  captured_runner_test_status="${runner_test_status}"
  fail_if_active_controlled_command_remains runner-focused-test
  if signal="$(signal_name_for_status "${runner_test_status}")"; then
    set -e
    terminate_for_signal \
      "${signal}" \
      "${runner_test_status}" \
      "${runner_status}" \
      "${oauth_dry_check_test_status}" \
      "${runner_test_status}" \
      null
  fi
  run_controlled_command bun test /dev/null --timeout=120000 e2e/screening/s4-legitimate-only.test.ts
  legitimate_only_test_status=$?
  captured_legitimate_only_test_status="${legitimate_only_test_status}"
  fail_if_active_controlled_command_remains legitimate-only-test
  if signal="$(signal_name_for_status "${legitimate_only_test_status}")"; then
    set -e
    terminate_for_signal \
      "${signal}" \
      "${legitimate_only_test_status}" \
      "${runner_status}" \
      "${oauth_dry_check_test_status}" \
      "${runner_test_status}" \
      "${legitimate_only_test_status}"
  fi
  set -e

  if [[ "${runner_status}" -eq 0 && "${oauth_dry_check_test_status}" -eq 0 && "${runner_test_status}" -eq 0 && "${legitimate_only_test_status}" -eq 0 ]]; then
    terminal_status="pass"
    terminal_exit_code=0
    if [[ "${runner_mode}" == "self-test" ]]; then
      terminal_code="S4_SELF_TEST_GREEN"
      terminal_detail="screening fixture self-test and every focused check completed"
    else
      terminal_code="S4_STAGING_DRY_CHECK_GREEN"
      terminal_detail="staging screening and production configuration dry-check completed"
    fi
  elif [[ "${runner_status}" -eq 78 && "${oauth_dry_check_test_status}" -eq 0 && "${runner_test_status}" -eq 0 && "${legitimate_only_test_status}" -eq 0 ]]; then
    terminal_status="blocked"
    terminal_exit_code=78
    if [[ "${runner_mode}" == "self-test" ]]; then
      terminal_code="PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"
      terminal_detail="the available corpus half was measured and its false-positive rate reported under evidence_class fixture-not-model-evidence; the zero-false-negative half has no protected bodies to measure and no live provider answered, so this remains BLOCKED"
    else
      terminal_code="S4_LIVE_GATE_BLOCKED"
      terminal_detail="no live screening evidence; inspect the preceding secret-safe runner diagnostic"
    fi
  elif [[ "${runner_status}" -ne 0 && "${runner_status}" -ne 78 ]]; then
    terminal_status="fail"
    terminal_code="S4_RUNNER_FAILED"
    terminal_exit_code=1
    terminal_detail="the S4 runner failed; focused-check statuses were still captured and preserved"
  elif [[ "${oauth_dry_check_test_status}" -ne 0 ]]; then
    terminal_status="fail"
    terminal_code="S4_OAUTH_DRY_CHECK_TEST_FAILED"
    terminal_exit_code=1
    terminal_detail="the OAuth dry-check focused test failed"
  elif [[ "${runner_test_status}" -ne 0 ]]; then
    terminal_status="fail"
    terminal_code="S4_RUNNER_TEST_FAILED"
    terminal_exit_code=1
    terminal_detail="the S4 runner focused test failed"
  else
    terminal_status="fail"
    terminal_code="S4_LEGITIMATE_ONLY_TEST_FAILED"
    terminal_exit_code=1
    terminal_detail="the legitimate-only focused test failed"
  fi

  emit_terminal_summary \
    "${terminal_status}" \
    "${terminal_code}" \
    "${terminal_exit_code}" \
    "${terminal_detail}" \
    "${runner_status}" \
    "${oauth_dry_check_test_status}" \
    "${runner_test_status}" \
    "${legitimate_only_test_status}"
  exit "${terminal_exit_code}"
}

if [[ $# -eq 0 ]]; then
  cd "${REPO_ROOT}"
  if ! command -v bun >/dev/null 2>&1; then
    emit_terminal_summary \
      blocked \
      S4_BUN_UNAVAILABLE \
      78 \
      "bun is unavailable; S4 checks were not started" \
      null \
      null \
      null \
      null
    exit 78
  fi
  run_suite live
fi

if [[ $# -eq 1 && "${1}" == "--self-test" ]]; then
  cd "${REPO_ROOT}"
  set +e
  activate_private_lifecycle_test_if_authorized
  private_lifecycle_test_status=$?
  set -e
  if [[ "${private_lifecycle_test_status}" -ne 0 ]]; then
    exit "${private_lifecycle_test_status}"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    emit_terminal_summary \
      blocked \
      S4_BUN_UNAVAILABLE \
      78 \
      "bun is unavailable; S4 checks were not started" \
      null \
      null \
      null \
      null
    exit 78
  fi
  run_suite self-test
fi

printf '%s\n' 'usage: scripts/e2e-s4-screening-oauth.sh [--self-test]' >&2
emit_terminal_summary \
  "fail" \
  "S4_USAGE_ERROR" \
  64 \
  "expected no arguments or --self-test" \
  null \
  null \
  null \
  null
exit 64
