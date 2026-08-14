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
  local marker='"record_type":"s4-terminal-summary"'
  local marker_count=0
  local remaining_output="${output}"
  local summary

  while [[ "${remaining_output}" == *"${marker}"* ]]; do
    marker_count=$((marker_count + 1))
    remaining_output="${remaining_output#*"${marker}"}"
  done

  if [[ "${marker_count}" -ne 1 ]]; then
    printf '%s\n' "${case_name}: expected exactly one s4 terminal summary, found ${marker_count}" >&2
    exit 1
  fi

  summary="${output##*$'\n'}"
  if ! "${BUN_PATH}" -e 'JSON.parse(process.argv[1]);' "${summary}" >/dev/null; then
    printf '%s\n' "${case_name}: terminal summary is not valid JSON" >&2
    exit 1
  fi
  if [[ "${summary}" != *'"record_type":"s4-terminal-summary"'* ||
    "${summary}" != *"\"status\":\"${expected_status}\""* ||
    "${summary}" != *"\"code\":\"${expected_code}\""* ||
    "${summary}" != *"\"exit_code\":${expected_exit_code}"* ||
    "${summary}" != *"\"runner_status\":${expected_runner_status}"* ||
    "${summary}" != *"\"oauth_dry_check_test_status\":${expected_oauth_dry_check_test_status}"* ||
    "${summary}" != *"\"runner_test_status\":${expected_runner_test_status}"* ||
    "${summary}" != *"\"legitimate_only_test_status\":${expected_legitimate_only_test_status}"* ]]; then
    printf '%s\n' "${case_name}: terminal summary did not preserve the captured statuses" >&2
    printf '%s\n' "${summary}" >&2
    exit 1
  fi
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
          bash -c "while :; do :; done" &
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

  set +e
  # Command substitutions inherit SIGINT ignored from non-interactive Bash on
  # some launchers. Reset it in the execing process so this remains a real
  # process-level INT delivery test rather than a disposition-dependent fake.
  output="$(S4_WRAPPER_TEST_LIFECYCLE_HOOK="${lifecycle_hook}" S4_WRAPPER_TEST_SIGNAL="${signal_name}" /usr/bin/perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV' bash "${SCRIPT_PATH}" --self-test 2>&1)"
  wrapper_status=$?
  set -e

  if [[ "${wrapper_status}" -ne "${signal_status}" ]]; then
    printf '%s\n' "${lifecycle_hook}/${signal_name}: expected exit ${signal_status}, got ${wrapper_status}" >&2
    exit 1
  fi
  if ((SECONDS - started_at > 1)); then
    printf '%s\n' "${lifecycle_hook}/${signal_name}: wrapper did not terminate promptly" >&2
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
    "S4_WRAPPER_INTERRUPTED_${signal_name}" \
    "${signal_status}" \
    null \
    null \
    null \
    null

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
