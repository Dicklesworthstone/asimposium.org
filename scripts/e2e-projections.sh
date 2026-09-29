#!/usr/bin/env bash
# Projection rebuild gate (W2.6, bead asimposiumorg-79n). On real local
# Workerd/D1 (no staging, no deployed claim):
# 1. The repair's refusal choice (inserted vs nothing) is unit-proven.
# 2. projection-doctor-real-bindings.mjs: an operator dry run reports a
#    consistent problem; injected drift in this throwaway database (a lost
#    review, a tampered hypothesis) is reported with keys and columns only;
#    a lost row is repaired equal to the original; a changed row is refused
#    and nothing is rewritten; while drift stands the public problem faces
#    carry a degraded notice; after repair the JSON, Markdown and full-pack
#    faces are byte-identical (same ETags) to before the corruption.
# 3. export-restore-real-bindings.mjs: a restore into a separately migrated
#    SCRATCH_DB rebuilds claims, claim versions, reviews, hypotheses and
#    evidence equal to the source from the log alone.
# 4. projection-legacy-backfill-real-bindings.mjs: a local D1 upgraded from the
#    legacy 0001 schema, after the real integrity backfill, is consistent.
# Not covered: the Agora operator console, chunked replay of very large
# problems, and a writer racing the doctor (consistency rests on one D1 batch).
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-projections"
reproduce="bash scripts/e2e-projections.sh"
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

fail() {
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 1
}

# 1. The repair's refusal choice.
bun test --timeout=120000 apps/wire/test/unit/projection-repair-outcome.test.ts \
  || fail "PROJECTION_REPAIR_OUTCOME_UNIT_FAILED"

# 2. Doctor dry run, repair, staleness notice and face digest equality.
node apps/wire/test/integration/projection-doctor-real-bindings.mjs \
  || fail "PROJECTION_DOCTOR_LANE_FAILED"

# 3. Restore rebuilds projections from the log alone.
node apps/wire/test/integration/export-restore-real-bindings.mjs \
  || fail "PROJECTION_RESTORE_LANE_FAILED"

# 4. A database upgraded from the legacy 0001 schema, after the real integrity
#    backfill, is still consistent.
node apps/wire/test/integration/projection-legacy-backfill-real-bindings.mjs \
  || fail "PROJECTION_LEGACY_BACKFILL_LANE_FAILED"

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
