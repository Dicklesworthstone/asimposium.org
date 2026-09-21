#!/usr/bin/env bash
# Review Discovery, Quiet-Work Prioritization & Honors E2E Gate (W8.8b / W9.6, beads asimposiumorg-fr9 & asimposiumorg-mip).
# Proves:
# 1. Consequence & Readiness over Volume:
#    - Quiet high-consequence work (with dependents) outranks loud low-value work (high event/review volume, 0 dependents).
#    - Priority ordering: consequence (dependents) -> need priority -> age.
#    - Activity volume or actor popularity has zero effect on ranking (Rule A10 / W9.6).
# 2. Review Need & Eligibility Calculation:
#    - Author cannot review own work (P1 / REVIEWER_IS_AUTHOR).
#    - Same-sponsor review yields T0, still requires independent review (T1+).
#    - Cross-sponsor same-family yields T1, still requires cross-family review (T2).
#    - Cross-sponsor distinct-family yields T2, requires falsification attempt or full write-up.
#    - Disputed status requires resolve-dispute.
# 3. Sponsor Diversity Interleaving & Deterministic Ties:
#    - Equal-priority candidates from different sponsors are interleaved without giving a sponsor a score.
#    - Problem/claim ASCII deterministic tie-breaking.
# 4. Honors Inclusion & Chronological Order (/results):
#    - Machine-checked, strongly-supported, and resolved problems admitted; open/disputed excluded.
#    - Strictly chronological order; no actor aggregation, no leaderboards, no streaks (Rule A10 / ADR-19).
# 5. UI & Diptych Parity:
#    - /reviews renders candidates, standing, missing check, DAG dependents, link to exact version, Diptych links.
#    - /explore renders "Quiet but review-ready work" module and Diptych links.
#    - /results renders settled results, contributing fellows with self-declared tags, carrying reviewers, DAG context.
#    - Strict rejection of leaderboards, actor aggregates, or activity streaks.
# 6. OPS.2a structured diagnostic logging without secret leakage.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-review-discovery"
reproduce="bash scripts/e2e-review-discovery.sh"
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

# 1. Run contracts unit tests
if ! bun test packages/contracts/test/unit/review-queue.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_QUEUE_CONTRACT_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test packages/contracts/test/unit/discovery.test.ts -t "Honors"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "HONORS_CONTRACT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run wire review queue selection and read tests
if ! bun test apps/wire/test/unit/review-queue-selection.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_QUEUE_SELECTION_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/review-queue-routes.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_QUEUE_ROUTES_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 3. Run web view model and ExplorePage tests
if ! bun test apps/web/test/unit/review-queue-view.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_QUEUE_VIEW_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/web/test/unit/public-ledger.test.ts -t "ExplorePage"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "EXPLORE_PAGE_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 4. Run the comprehensive review discovery & honors E2E suite
if ! bun run scripts/suite/review-discovery-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_DISCOVERY_E2E_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
