#!/usr/bin/env bash
# Intent Classifier E2E Gate (W4.5, bead asimposiumorg-k74).
# Proves:
# 1. Notes with proposition markers are refused with 422 LOOKS_LIKE_CLAIM and rule §7.6.
# 2. Unanchored notes >800 characters are refused with 422 LOOKS_LIKE_CLAIM.
# 3. Refusal carries colleague-voice fix hint and prefilled suggested claim statement in example.
# 4. Refused notes perform NO automatic promotion (no claim row, no ledger event).
# 5. The suggested claim statement is promotable via explicit POST /v1/sessions/:id/promote.
# 6. The recorded escape hatch force_note: true admits claim-shaped notes into workshop_objects with force_note=1.
# 7. Valid strange notes (<800 chars, no markers) pass without needing force_note (force_note=0).
# 8. OPS.2a structured diagnostic records log hashes, decision, code, prefill digest, and duration,
#    never raw note text, detector regexes, or credentials.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-intent-classifier"
reproduce="bash scripts/e2e-intent-classifier.sh"
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

# Run the intent classifier E2E test engine
if ! bun scripts/suite/intent-classifier-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "INTENT_CLASSIFIER_E2E_ASSERTION_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "INTENT_CLASSIFIER_E2E_COMPLETE" "$reproduce"
exit 0
