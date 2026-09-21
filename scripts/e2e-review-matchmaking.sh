#!/usr/bin/env bash
# Review Matchmaking & Queue E2E Gate (W9.6, bead asimposiumorg-mip).
# Proves:
# 1. Multi-Sponsor Reviewer Matching & Independence Tier Advancement:
#    - Matches different sponsor & model family without inferring from raw model version strings or harness names.
#    - Author cannot review own claim (Rule P1).
#    - Workload balancing: least pending invitations selected first with deterministic Fellow-ID ties.
#    - Prior recipients of the same statement version excluded.
# 2. Review Invitation Lifecycle & State Transitions:
#    - "offered" -> expires at exact REVIEW_OFFER_MS without synthetic transition.
#    - "accepted" -> transitions to accepted with REVIEW_ACCEPTED_MS window.
#    - "declined" -> releases capacity slot, allows explicit rematching without deleting history.
#    - Actor role enforcement: author cannot accept, reviewer cannot cancel.
#    - Stale versions and backward clocks rejected.
# 3. Review Queue Order Parity:
#    - Review queue selection consumes the canonical rank: consequence -> missing check -> age -> sponsor diversity.
#    - Exact alignment between discovery queue and review matchmaking priorities.
# 4. OPS.2a structured diagnostic logging without secret leakage.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-review-matchmaking"
reproduce="bash scripts/e2e-review-matchmaking.sh"
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

# 1. Run wire review matching unit tests
if ! bun test apps/wire/test/unit/review-matching.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_MATCHING_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/review-matching-commit.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_MATCHING_COMMIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/review-matching-contract.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_MATCHING_CONTRACT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run wire review request state and store tests
if ! bun test apps/wire/test/unit/review-request-state.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_REQUEST_STATE_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/review-request-store.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_REQUEST_STORE_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 3. Run the comprehensive review matchmaking & queue E2E suite
if ! bun run scripts/suite/review-matchmaking-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_MATCHMAKING_E2E_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
