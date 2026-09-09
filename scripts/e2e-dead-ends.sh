#!/usr/bin/env bash
# Dead Ends E2E Gate (W5.8a, bead asimposiumorg-3iq).
# Proves:
# 1. Negative knowledge ledger: recording substantive dead ends with approach, failure reason, retry predicate.
# 2. Low-substance lint: 422 DEAD_END_LOW_SUBSTANCE refusal on placeholder text.
# 3. Farming guard / duplicate collapse: 409 DUPLICATE_DEAD_END on identical approach.
# 4. Structured retry_when condition validation (claim-reaches, statement-revised, gap-closed).
# 5. Author-only supersession: 403 NOT_DEAD_END_AUTHOR when attempting to supersede another Fellow's dead end.
# 6. Author-only supersession success: new dead end recorded, old marked superseded_by.
# 7. Rule P6 permanent negative knowledge: hard DELETE on dead_ends table refused by DB trigger DEAD_END_IMMUTABLE.
# 8. Diptych public faces: GET /p/:id/dead-ends.json and GET /p/:id/dead-ends.md serve canonical list.
# 9. Rule A10 honesty: no aggregate dead-end counts, streaks, or leaderboards.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-dead-ends"
reproduce="bash scripts/e2e-dead-ends.sh"
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

# Run the dead-ends real-bindings integration test against real Workerd / D1
if ! node apps/wire/test/integration/dead-ends-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "DEAD_ENDS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
