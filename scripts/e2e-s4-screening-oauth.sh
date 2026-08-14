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
      $'\b') escaped+='\\b' ;;
      $'\f') escaped+='\\f' ;;
      $'\n') escaped+='\\n' ;;
      $'\r') escaped+='\\r' ;;
      $'\t') escaped+='\\t' ;;
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
    NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[[:alpha:]?][^[:space:]]*$/ { exit 1 }
  ' <<<"${table}"; then
    return 2
  fi
  if awk -v wanted="${pgid}" '$2 == wanted && $3 !~ /Z/ { found = 1 } END { exit(found ? 0 : 1) }' <<<"${table}"; then
    return 0
  fi
  return 1
}

wait_for_group_absence() {
  local pgid="$1"
  local attempts state

  for ((attempts = 0; attempts < 10; attempts += 1)); do
    state=0
    group_liveness_state "${pgid}" || state=$?
    if [[ "${state}" -eq 1 ]]; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

terminate_live_group_after_normal_return() {
  local pgid="${active_child_pgid}"
  local attempts state

  # The leader has already been reaped, so its PID can no longer authorize a
  # signal. A positive live-member observation is nevertheless continuous
  # ownership of this process group: its numeric id cannot be reused until the
  # group is empty. Unknown inspection remains a refusal, never an empty group.
  state=0
  group_liveness_state "${pgid}" || state=$?
  [[ "${state}" -eq 0 ]] || return 1
  kill -TERM -- "-${pgid}" 2>/dev/null || return 1

  for ((attempts = 0; attempts < 10; attempts += 1)); do
    state=0
    group_liveness_state "${pgid}" || state=$?
    [[ "${state}" -eq 1 ]] && break
    sleep 0.01
  done
  if [[ "${state}" -ne 1 ]]; then
    # The group is still positively live after TERM, so the same ownership
    # argument authorizes bounded escalation even though its leader is gone.
    group_liveness_state "${pgid}" || return 1
    kill -KILL -- "-${pgid}" 2>/dev/null || return 1
  fi
  wait_for_group_absence "${pgid}"
}

terminate_and_reap_active_child() {
  local signal="$1"
  local child_pid="${active_child_pid}"
  local attempts state

  [[ -n "${child_pid}" ]] || return 0

  # A leader that ignores terminal signals keeps the identity pin live through
  # the grace period. If it is already gone, do not guess that a numeric PGID
  # still belongs to us; retain ownership and fail the cleanup claim instead.
  if ! active_group_identity_is_exact; then
    return 1
  fi
  kill -s "${signal}" -- "-${active_child_pgid}" 2>/dev/null || return 1

  for ((attempts = 0; attempts < 10; attempts += 1)); do
    state=0
    group_liveness_state "${active_child_pgid}" || state=$?
    [[ "${state}" -eq 1 ]] && break
    sleep 0.01
  done
  if [[ "${state}" -ne 1 ]]; then
    # Escalation is another group signal, so it repeats the exact-identity gate.
    active_group_identity_is_exact || return 1
    kill -KILL -- "-${active_child_pgid}" 2>/dev/null || return 1
  fi
  wait "${child_pid}" 2>/dev/null || true
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
  local spawned_child_pid="${2:-}"
  local attempts

  [[ "${private_lifecycle_test_authorized}" -eq 1 ]] || return

  case "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}" in
    '') return ;;
    after-spawn-before-ownership)
      [[ "${boundary}" == after-spawn-before-ownership ]] || return
      for ((attempts = 0; attempts < 10; attempts += 1)); do
        if pgrep -P "${spawned_child_pid}" >/dev/null 2>&1; then
          break
        fi
        sleep 0.01
      done
      if ! pgrep -P "${spawned_child_pid}" >/dev/null 2>&1; then
        # Before ownership is published this is still our unreaped direct
        # child. Do not manufacture a bare PGID signal in a test-only error
        # path; the normal group path is available only after identity pinning.
        kill -TERM "${spawned_child_pid}" 2>/dev/null || true
        wait "${spawned_child_pid}" 2>/dev/null || true
        printf '%s\n' 'S4 lifecycle test runner never created its descendant' >&2
        return 125
      fi
      ;;
    after-wait-before-ownership-clear)
      [[ "${boundary}" == after-wait-before-ownership-clear ]] || return
      ;;
    after-ownership-before-wait)
      [[ "${boundary}" == after-ownership-before-wait ]] || return
      # Test only: model a stale recorded leader identity. The signal handler
      # must then refuse the numeric process group instead of treating its
      # number as authority over a possibly recycled group.
      active_child_identity="${active_child_identity}:stale"
      ;;
    *) return ;;
  esac

  case "${S4_WRAPPER_TEST_SIGNAL:-}" in
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
  terminate_and_reap_active_child "${signal}"
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

  if [[ -n "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}${S4_WRAPPER_TEST_SIGNAL:-}${S4_WRAPPER_TEST_AUTHORITY:-}${S4_WRAPPER_TEST_CAPABILITY:-}" ]]; then
    requested=1
  fi
  [[ "${requested}" -eq 1 ]] || return 1

  [[ "${S4_WRAPPER_TEST_AUTHORITY:-}" == "${S4_PRIVATE_SELF_TEST_AUTHORITY}" &&
    "${S4_WRAPPER_TEST_CAPABILITY:-}" == "${S4_PRIVATE_SELF_TEST_CAPABILITY}" ]] || return 2
  case "${S4_WRAPPER_TEST_LIFECYCLE_HOOK:-}" in
    after-spawn-before-ownership|after-ownership-before-wait|during-wait|after-wait-before-ownership-clear) ;;
    *) return 2 ;;
  esac
  case "${S4_WRAPPER_TEST_SIGNAL:-}" in
    HUP|INT|TERM) ;;
    *) return 2 ;;
  esac
  return 0
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

s4_controlled_command_supervisor() {
  local terminal_signal_seen=0
  local child
  local status

  trap 'terminal_signal_seen=1' HUP INT TERM
  "$@" &
  child=$!
  wait "${child}"
  status=$?
  if [[ "${terminal_signal_seen}" -eq 1 ]]; then
    # The wrapper owns this process-group leader. Keep it alive after the
    # payload leader has taken the signal, so any resistant descendant can be
    # KILLed only through the identity pin that was proved at spawn.
    while :; do sleep 1; done
  fi
  return "${status}"
}

run_controlled_command() {
  local status
  local spawned_child_pid
  local spawned_child_identity
  local attempts

  # Non-interactive Bash otherwise keeps a background command in the wrapper's
  # process group. Monitor mode gives each started check an isolated group that
  # the parent-signal trap can terminate and reap as one unit.
  begin_parent_signal_deferral
  set -m
  # This small supervisor is the process-group leader. When a terminal signal
  # reaches the group, it stays alive even if that signal lets its payload
  # leader exit; the wrapper can then escalate a TERM-resistant descendant
  # through the still-pinned group rather than a leaderless numeric PGID.
  s4_controlled_command_supervisor "$@" &
  spawned_child_pid=$!
  run_lifecycle_test_hook after-spawn-before-ownership "${spawned_child_pid}"
  for ((attempts = 0; attempts < 10; attempts += 1)); do
    spawned_child_identity="$(process_identity "${spawned_child_pid}")" || spawned_child_identity=''
    if [[ "${spawned_child_identity}" == "${spawned_child_pid}"'|'"${spawned_child_pid}"'|'* ]]; then
      active_child_pid="${spawned_child_pid}"
      active_child_pgid="${spawned_child_pid}"
      active_child_identity="${spawned_child_identity}"
      break
    fi
    sleep 0.01
  done
  if [[ -z "${active_child_identity}" ]]; then
    # The direct child has not been reaped, so this narrow direct signal cannot
    # be redirected to a recycled PID. There is no safe group-level fallback.
    kill -TERM "${spawned_child_pid}" 2>/dev/null || true
    wait "${spawned_child_pid}" 2>/dev/null || true
    replay_deferred_parent_signal
    return 125
  fi
  replay_deferred_parent_signal
  run_lifecycle_test_hook after-ownership-before-wait

  # A terminal signal interrupts wait promptly; its trap records the signal,
  # then it is forwarded and reaped while ownership is still published.
  begin_parent_signal_deferral
  wait "${active_child_pid}"
  status=$?
  if [[ -n "${pending_parent_signal}" ]]; then
    replay_deferred_parent_signal
  fi
  run_lifecycle_test_hook after-wait-before-ownership-clear
  if [[ -n "${pending_parent_signal}" ]]; then
    replay_deferred_parent_signal
  fi
  # A normal return from the leader is insufficient: a background descendant
  # can retain stdout and keep the group live. Clearing ownership is allowed
  # only after a bounded positive observation of zero non-zombie members.
  if ! wait_for_group_absence "${active_child_pgid}"; then
    terminate_live_group_after_normal_return || return 125
  fi
  clear_active_child_ownership
  replay_deferred_parent_signal
  return "${status}"
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

  # Capture every status before deciding the terminal state. This preserves
  # failure diagnostics from all focused checks while guaranteeing one summary.
  set +e
  run_controlled_command bun e2e/screening/s4-runner.ts "${runner_mode}"
  runner_status=$?
  captured_runner_status="${runner_status}"
  if [[ -n "${active_child_pid}" ]]; then
    set -e
    emit_terminal_summary \
      fail \
      S4_ACTIVE_COMMAND_REAP_FAILED \
      1 \
      "the runner leader returned while its identity-pinned process group remained live; no later S4 checks were started" \
      "${runner_status}" \
      null \
      null \
      null
    exit 1
  fi
  if signal="$(signal_name_for_status "${runner_status}")"; then
    set -e
    terminate_for_signal "${signal}" "${runner_status}" "${runner_status}" null null null
  fi
  run_controlled_command bun test e2e/screening/oauth-dry-check.test.ts
  oauth_dry_check_test_status=$?
  captured_oauth_dry_check_test_status="${oauth_dry_check_test_status}"
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
  run_controlled_command bun test e2e/screening/s4-runner.test.ts
  runner_test_status=$?
  captured_runner_test_status="${runner_test_status}"
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
  run_controlled_command bun test e2e/screening/s4-legitimate-only.test.ts
  legitimate_only_test_status=$?
  captured_legitimate_only_test_status="${legitimate_only_test_status}"
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
