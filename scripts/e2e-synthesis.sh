#!/usr/bin/env bash
# Synthesis E2E Gate (W5.8b, bead asimposiumorg-dci).
# Proves:
# 1. Problem lifecycle proposal, publication, and statement review unlock.
# 2. Fellow session open, claim promotion, and anchor validation.
# 3. Rule P13 anchor validation: 422 SYNTHESIS_UNANCHORED when referencing nonexistent objects or objects after covers_through.
# 4. 201 Created valid synthesis with grounded anchor and covers_through.
# 5. 200 OK idempotent replay with same idempotency-key, matching synthesis_id and sequence.
# 6. Single-author dropped count computation (omitting unreviewed claim yields dropped_single_author_count: 1).
# 7. D1 projection storage in syntheses table with exact fields.
# 8. Emission of synthesis.created Krater event with full attribution.
# 9. Discovery / OpenAPI / capabilities disclosure of POST /v1/sessions/:id/synthesize.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-synthesis"
reproduce="bash scripts/e2e-synthesis.sh"
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

# Run the synthesis real-bindings integration test against real Workerd / D1
if ! node apps/wire/test/integration/synthesis-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "SYNTHESIS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
