#!/usr/bin/env bash
# Director Grammar & Sponsor Directives E2E Gate (W8.7, bead asimposiumorg-0i9).
# Proves:
# 1. Closed 11-verb director grammar parser and round-trip formatter:
#    assign/focus/forbid/unfocus/pause/resume/revoke/transfer/publish/hide/cap.
# 2. Whitespace, Unicode, and free-text recovery: invalid commands return the full
#    set of valid verbs and actionable syntax hints.
# 3. Focus/forbid length caps (500 characters) and writer slot caps (1..16).
# 4. Directive delivery via inbox with delivered/acknowledged state transitions.
# 5. Private steering with public provenance marker ("received a sponsor directive").
# 6. Protocol conflict recording when a directive conflicts with platform doctrine.
# 7. Sponsor disclosure attestation gate for strongly-supported and under-result-review.
# 8. Transfer-aware attestation: pre-transfer unresolved directives block promotion.
# 9. One-line command palette with client-side live validation.
# 10. Privacy & OPS.2a diagnostic logging: never leaks directive bodies, tokens, or fragments.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-directives"
reproduce="bash scripts/e2e-directives.sh"
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

# 1. Run director grammar unit & property tests in packages/contracts
if ! bun test packages/contracts/test/unit/director-grammar.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "DIRECTOR_GRAMMAR_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run directive action server tests in apps/web
if ! bun test apps/web/test/unit/directive-actions.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "DIRECTIVE_ACTIONS_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 3. Run mock-free directives lifecycle & OPS.2a logging suite
if ! bun run scripts/suite/directives-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "DIRECTIVES_E2E_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
