#!/usr/bin/env bash
# Integration contract: self-test is executable; absent live staging remains
# visibly blocked and no provider behavior is substituted with a mock.
set -euo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_DIR
REPO_ROOT="$(cd -- "${TEST_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly SCRIPT_PATH="${REPO_ROOT}/scripts/e2e-s4-screening-oauth.sh"

set +e
self_test_output="$(bash "${SCRIPT_PATH}" --self-test 2>&1)"
readonly self_test_status=$?
set -e

if [[ "${self_test_status}" -ne 78 ]]; then
  printf '%s\n' 'expected the missing protected hard-reject corpus to block self-test accuracy evidence' >&2
  exit 1
fi

case "${self_test_output}" in
  *'PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE'* ) ;;
  *)
    printf '%s\n' 'expected the explicit protected-corpus blocker' >&2
    exit 1
    ;;
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

case "${blocked_output}" in
  *'PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE'*|*'S4_LIVE_GATE_BLOCKED'* ) ;;
  *)
    printf '%s\n' 'expected a safe BLOCKED diagnostic for unavailable staging' >&2
    exit 1
    ;;
esac

case "${blocked_output}" in
  *http://*|*https://*|*Bearer\ * )
    printf '%s\n' 'blocked diagnostics exposed configuration material' >&2
    exit 1
    ;;
  *) ;;
esac
