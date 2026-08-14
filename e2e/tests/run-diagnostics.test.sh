#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="run-diagnostics-unit"
started_ms="$(e2e_now_ms)"
reproduce="bash e2e/tests/run-diagnostics.test.sh"

if ! e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "HARNESS_SELF_TEST_FAILED" "$reproduce"
  exit 1
fi

for valid_run_id in "a" "OPS.1-20260813" "run_42"; do
  e2e_validate_run_id "$valid_run_id" || {
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "VALID_RUN_ID_REJECTED" "$reproduce"
    exit 1
  }
done

for invalid_run_id in "../traversal" "nested/path" "-leading-dash" "contains space"; do
  if e2e_validate_run_id "$invalid_run_id"; then
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "INVALID_RUN_ID_ACCEPTED" "$reproduce"
    exit 1
  fi
done

e2e_emit_diagnostic "$suite" "$started_ms" "pass" "RUN_ID_AND_DIAGNOSTIC_CONTRACT_OK" "$reproduce"
