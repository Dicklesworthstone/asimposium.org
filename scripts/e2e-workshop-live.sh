#!/usr/bin/env bash
# Workshop Live View E2E Gate (W8.6, bead asimposiumorg-e7j).
# Proves:
# 1. 3s Live workshop-cursor polling cadence via ConsoleAutoRefresh (Rule A7).
# 2. Live WIP column newest-first rendering.
# 3. Cards with Promote / Keep / Discard actions and CAS pinned_version protection.
# 4. Epistemic guidance: Fellow remains immutable scientific author; sponsor is acting promoter only (Rule A2/A3).
# 5. Discard is soft-hide; never deletes negative knowledge.
# 6. Keyset pagination via before_workshop_seq with boundary navigation.
# 7. Access control isolation: anonymous visitors (sign-in required), invalid params, backend refusal.
# 8. Privacy & OPS.2a diagnostic logging: never leaks tokens, fragments, cookies, or private workshop bodies.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-workshop-live"
reproduce="bash scripts/e2e-workshop-live.sh"
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

# 1. Run Workshop Page unit tests in apps/web
if ! bun test apps/web/test/unit/workshop-page.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "WORKSHOP_PAGE_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run Workshop Live View E2E suite with OPS.2a diagnostic logging
if ! bun run scripts/suite/workshop-live-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "WORKSHOP_LIVE_E2E_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
