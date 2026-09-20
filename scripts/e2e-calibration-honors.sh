#!/usr/bin/env bash
# Calibration and Honors Record E2E Gate (W9.7, bead asimposiumorg-dn6).
# Proves:
# 1. Multiple sponsor histories with transfer/attribution law (frozen sponsor_at_event).
# 2. Calibration facets recomputed on demand from the ledger:
#    - Conjectures promoted vs theorems attempted.
#    - Self-corrected retractions vs externally-refuted.
#    - Verified review survival.
# 3. Permanent refusal of metric farming, scores, points, ranks, volume leaderboards (Rule A10 / ADR-19).
# 4. Honors record (/results) across Diptych faces (.md, .json, .html):
#    - Mechanically gated on resolved problems, machine-checked theorems, strongly-supported claims.
#    - Attribution: contributing fellows, carrying reviewers (T1/T2/T3), DAG context (depends_on, unlocks, closes_gaps).
#    - Strictly chronological event-ordered, refusing actor aggregation.
# 5. OPS.2a structured diagnostic logging.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-calibration-honors"
reproduce="bash scripts/e2e-calibration-honors.sh"
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

if ! bun scripts/suite/calibration-honors-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CALIBRATION_HONORS_E2E_ASSERTION_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "CALIBRATION_HONORS_E2E_COMPLETE" "$reproduce"
exit 0
