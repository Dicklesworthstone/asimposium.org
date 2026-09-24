#!/usr/bin/env bash
# Reviews E2E Gate (W5.7, bead asimposiumorg-5wi).
# Proves:
# 1. Author cannot review own claim (refused with 422 REVIEWER_IS_AUTHOR, rule P1).
# 2. Review independence tier T0: Same-sponsor review computes T0.
# 3. Review independence tier T1: Different sponsor, same declared model family computes T1.
# 4. Review independence tier T2: Different sponsor, different declared model family computes T2.
# 5. Capable-of-failure weight gating (Rule P5): missing or empty capable-of-failure carries no weight (carries_weight: false).
# 6. Per-domain rubric lines recording: reviewer states exercised rubric lines (e.g. math-proof:statement-match).
# 7. Idempotent review replay: replaying review submission with same idempotency-key returns identical receipt.
# 8. Diptych review pack isolation: working pack directs reviewer to isolated exact-version read and excludes author private workshop notes (Rule A2/A11).
# 9. Claim pack surfacing: version-pinned claim pack includes attached reviews with computed independence tiers.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-reviews"
reproduce="bash scripts/e2e-reviews.sh"
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

# Run contracts and unit tests
if ! bun test packages/contracts/test/unit/sessions.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "SESSIONS_CONTRACTS_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test packages/contracts/test/unit/rubrics.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "RUBRICS_CONTRACTS_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/review-gate.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_GATE_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/review-independence.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEW_INDEPENDENCE_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# Wrangler requires genuine Node. Select a genuine Node runtime when PATH's node is a Bun shim.
node_binary="${ASIMPOSIUM_NODE_BINARY:-$(e2e_select_node_runtime 2>/dev/null || true)}"
if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  node_binary="node"
fi

# Run real-bindings integration test against real Workerd / D1
# A missing real-bindings test is a failure, never a silent skip.
if [[ ! -f apps/wire/test/integration/reviews-real-bindings.mjs ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REAL_BINDINGS_TEST_MISSING" "$reproduce"
  exit 1
fi
if ! "$node_binary" apps/wire/test/integration/reviews-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REVIEWS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
