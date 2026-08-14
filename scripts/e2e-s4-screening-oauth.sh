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
captured_runner_status=null
captured_oauth_dry_check_test_status=null
captured_runner_test_status=null
captured_legitimate_only_test_status=null
parent_signal_deferral_active=0
pending_parent_signal=''
pending_parent_signal_exit_code=''

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
      '"') escaped+='\\"' ;;
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

owned_active_command_is_alive() {
  if [[ -n "${active_child_pgid}" ]]; then
    kill -0 -- "-${active_child_pgid}" 2>/dev/null
  elif [[ -n "${active_child_pid}" ]]; then
    kill -0 "${active_child_pid}" 2>/dev/null
  else
    return 1
  fi
}

terminate_and_reap_active_child() {
  local signal="$1"
  local child_pid="${active_child_pid}"
  local child_pgid="${active_child_pgid}"
  local attempts

  if [[ -z "${child_pid}" ]]; then
    return
  fi

  # Each controlled command has its own process group. Forward the signal to
  # the whole group so a runner cannot leave an owned descendant behind, then
  # reap the direct child before the wrapper emits its terminal record.
  if [[ -n "${child_pgid}" ]]; then
    kill -s "${signal}" -- "-${child_pgid}" 2>/dev/null || true
  else
    kill -s "${signal}" "${child_pid}" 2>/dev/null || true
  fi

  # A misbehaving runner may ignore the original terminal signal. Do not leave
  # the wrapper waiting indefinitely: give the owned group a 100 ms grace, then
  # force-stop it before reaping its direct child.
  for ((attempts = 0; attempts < 10; attempts += 1)); do
    if ! owned_active_command_is_alive; then
      break
    fi
    sleep 0.01
  done
  if owned_active_command_is_alive; then
    if [[ -n "${child_pgid}" ]]; then
      kill -KILL -- "-${child_pgid}" 2>/dev/null || true
    else
      kill -KILL "${child_pid}" 2>/dev/null || true
    fi
  fi
  wait "${child_pid}" 2>/dev/null || true

  # The direct child can exit before a signal-ignoring descendant. Keep group
  # ownership published until the bounded group reap has completed, preventing
  # a terminal record from claiming cleanup while that descendant survives.
  for ((attempts = 0; attempts < 10; attempts += 1)); do
    if ! owned_active_command_is_alive; then
      break
    fi
    sleep 0.01
  done
  active_child_pid=''
  active_child_pgid=''
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
        kill -TERM -- "-${spawned_child_pid}" 2>/dev/null || true
        wait "${spawned_child_pid}" 2>/dev/null || true
        printf '%s\n' 'S4 lifecycle test runner never created its descendant' >&2
        return 125
      fi
      ;;
    after-wait-before-ownership-clear)
      [[ "${boundary}" == after-wait-before-ownership-clear ]] || return
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
  # In a command substitution, $$ remains the invoking shell's PID. The
  # lifecycle helper must target this wrapper process, not that caller.
  export S4_WRAPPER_TEST_WRAPPER_PID="${BASHPID}"
fi

run_controlled_command() {
  local status
  local spawned_child_pid

  # Non-interactive Bash otherwise keeps a background command in the wrapper's
  # process group. Monitor mode gives each started check an isolated group that
  # the parent-signal trap can terminate and reap as one unit.
  begin_parent_signal_deferral
  set -m
  "$@" &
  spawned_child_pid=$!
  run_lifecycle_test_hook after-spawn-before-ownership "${spawned_child_pid}"
  active_child_pid="${spawned_child_pid}"
  active_child_pgid="${spawned_child_pid}"
  replay_deferred_parent_signal

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
  active_child_pid=''
  active_child_pgid=''
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
