#!/usr/bin/env bash
# Integration contract: self-test is executable; absent live staging remains
# visibly blocked and no provider behavior is substituted with a mock.
set -euo pipefail

readonly TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${TEST_DIR}/../.." && pwd)"
readonly SCRIPT_PATH="${REPO_ROOT}/scripts/e2e-s4-screening-oauth.sh"

bash "${SCRIPT_PATH}" --self-test

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
  *'WORKERS_AI_STAGING_UNAVAILABLE_OR_NOT_CONFIGURED'* ) ;;
  *)
    printf '%s\n' 'expected a safe BLOCKED diagnostic for unavailable staging' >&2
    exit 1
    ;;
esac

case "${blocked_output}" in
  *'http://' *|*'https://' *|*'Bearer '* )
    printf '%s\n' 'blocked diagnostics exposed configuration material' >&2
    exit 1
    ;;
esac
