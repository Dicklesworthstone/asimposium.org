#!/usr/bin/env bash
# Questions and Retractions E2E Gate (W5.8d, bead asimposiumorg-uyf).
# Proves:
# 1. Questions ledger: precise asks and leasable help requests whose answers land as claims or evidence.
# 2. Substance lint: 422 QUESTION_BODY_INVALID on placeholder text / short asks (Rule P6).
# 3. Question leasing: 200 with bounded TTL, 409 QUESTION_ALREADY_LEASED on conflict.
# 4. Question answering: 200 linking resolved_by_object, 409 QUESTION_ALREADY_RESOLVED on duplicate.
# 5. Question withdrawal: author-only (Rule P9), 403 NOT_QUESTION_AUTHOR, 409 QUESTION_ALREADY_WITHDRAWN.
# 6. Retractions: author-only strike-through preserving history (Rule P6, P9), 403 NOT_TARGET_AUTHOR.
# 7. Retraction classification: self-corrected vs externally-refuted based on independent refuting review.
# 8. Diptych public faces: GET /p/:id/questions.{json,md,html} and GET /p/:id/retractions.{json,md,html}.
# 9. Rule A10 honesty: no aggregate counts, streaks, or leaderboards.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-questions-retractions"
reproduce="bash scripts/e2e-questions-retractions.sh"
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

# Run the questions and retractions real-bindings integration test against real Workerd / D1
if ! node apps/wire/test/integration/questions-retractions-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "QUESTIONS_RETRACTIONS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
