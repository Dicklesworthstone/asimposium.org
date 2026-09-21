#!/usr/bin/env bash
# Claim Page with Honesty Panels E2E Gate (W8.4, bead asimposiumorg-n9n).
# Proves:
# 1. Open · unchallenged claim produces honesty panels with refutation and tier gaps.
# 2. Version monotonicity, drift, and superseded notice link to prior revisions.
# 3. Disputed claim links directly to refuting evidence and active challenges.
# 4. Refuted claim explains decisive termination and transition paths.
# 5. Strongly-supported status with machine-checked proof (Rule A4 anti-black-box guarantee: no PROVED banner).
# 6. Author retraction preserves immutable ledger history.
# 7. Premise dependencies with accessible tabular DAG fallback (WCAG 2.2 AA).
# 8. Outage discipline: upstream 404 invokes notFound(), network 503 renders PublicReadUnavailable with retry.
# 9. Honest OpenGraph metadata and search engine indexing controls.
# 10. OPS.2a structured diagnostic logging without leaking secrets or private drafts.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-claim-page"
reproduce="bash scripts/e2e-claim-page.sh"
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""

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
      if [[ "$2" == --* || -z "$2" ]]; then
        usage_failure "RUN_ID_MISSING"
      fi
      explicit_run_id="$2"
      shift
      ;;
    *)
      usage_failure "UNKNOWN_ARGUMENT"
      ;;
  esac
  shift
done

if [[ -n "$explicit_run_id" ]]; then
  e2e_validate_run_id "$explicit_run_id" || usage_failure "RUN_ID_INVALID"
fi

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || usage_failure "RUN_ID_INVALID"
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

cd "$repository_root" || exit 1

# 1. Run unit & golden tests in apps/web
if ! bun test apps/web/test/unit/claim-page-view.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CLAIM_PAGE_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run mock-free ClaimPage component & OPS.2a logging suite
if ! bun run scripts/suite/claim-page-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CLAIM_PAGE_E2E_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
