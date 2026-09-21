#!/usr/bin/env bash
# Agora Support Surfaces Integration E2E Gate (W8.8, bead asimposiumorg-4k7).
# Proves:
# 1. Integration of W8.8a Honest Share Cards & Suggested Share Text (asimposiumorg-vv5)
# 2. Integration of W8.8b Review Queue, Quiet-Work Discovery & Chronological Honors UI (asimposiumorg-fr9)
# 3. Integration of W8.8c Human Protocol Pages & Thin Audited Admin (asimposiumorg-0ht)
# 4. The complete journey of a quiet review-ready claim:
#    - Consequence over volume prioritization in queue and on /explore
#    - Matched independent review advancing standing to strongly-supported
#    - Chronological honors eligibility on /results
#    - Exact-status dynamic share card rendering with Rule A4 honesty enforcement
#    - Audited moderation repair with Google auth step-up and structural disposition tamper-proofing
# 5. Semantic Diptych parity across all human support surfaces and canonical agent texts
# 6. Strict exclusion of private drafts, workshop bytes, and competitive leaderboards
# 7. OPS.2a structured diagnostic logging without secrets or private bodies
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-agora-support-surfaces"
reproduce="bash scripts/e2e-agora-support-surfaces.sh"
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

# 1. Run W8.8a Honest Share Cards Gate
echo "=== Step 1/4: Running W8.8a Share Cards Gate ==="
if ! bash scripts/e2e-share-cards.sh; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "SHARE_CARDS_GATE_FAILED" "$reproduce"
  exit 1
fi

# 2. Run W8.8b Review Discovery & Honors Gate
echo "=== Step 2/4: Running W8.8b Review Discovery & Honors Gate ==="
if ! bash scripts/e2e-review-discovery.sh; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_DISCOVERY_GATE_FAILED" "$reproduce"
  exit 1
fi

# 3. Run W8.8c Protocol Pages & Audited Admin Gate
echo "=== Step 3/4: Running W8.8c Protocol Pages & Audited Admin Gate ==="
if ! bash scripts/e2e-protocol-admin.sh; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "PROTOCOL_ADMIN_GATE_FAILED" "$reproduce"
  exit 1
fi

# 4. Run Unified Agora Support Surfaces Journey Integration Suite
echo "=== Step 4/4: Running Unified Agora Support Surfaces Integration Suite ==="
if ! bun scripts/suite/agora-support-surfaces-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGORA_SUPPORT_SURFACES_INTEGRATION_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
