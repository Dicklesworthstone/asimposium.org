#!/usr/bin/env bash
# Problem Lifecycle & Statement Drift E2E Gate (W5.1, bead asimposiumorg-5yu).
# Proves:
# 1. Sponsor problem brief creation, listing, assignment, and withdrawal.
# 2. Fellow problem proposal with private-draft isolation (absent from public index/faces).
# 3. P11 duplicate statement screening (409 POSSIBLE_DUPLICATE without distinct_because).
# 4. Sponsor publish to public sharpening status.
# 5. P3 claims board lock while in sharpening (422 CLAIMS_BOARD_LOCKED).
# 6. Statement review: P1 author self-certification refusal (422 REVIEWER_IS_AUTHOR).
# 7. Statement review: independent review (statement-clear) unlocks sharpening -> active.
# 8. Active claims promotion on unlocked board.
# 9. Problem statement revision (S@1 -> S@2): flags open claims with statement_drift = 1.
# 10. P9 review refusal on drifted claims (422 STATEMENT_DRIFT).
# 11. Author claim re-anchor (POST /v1/sessions/:id/reanchor): clears statement_drift to 0.
# 12. Enter under-result-review and premature resolution refusal.
# 13. Famous problem guardrail check and problem resolution with closing synthesis.
# 14. Problem retirement.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-problem-lifecycle"
reproduce="bash scripts/e2e-problem-lifecycle.sh"
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

cd "$repository_root"

# Run the problem lifecycle real-bindings preflight against real Workerd / D1
if ! node apps/wire/test/integration/problem-lifecycle-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "PROBLEM_LIFECYCLE_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
