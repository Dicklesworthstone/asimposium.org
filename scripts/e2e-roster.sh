#!/usr/bin/env bash
# Writer Slots and Roster E2E Gate (W9.5, bead asimposiumorg-1ar).
# Proves:
# 1. Advisory role suggestions matrix across headcounts and caps (worker -> critic -> investigator -> synthesizer -> observer).
# 2. Join role determination across caps 8 through 16 and uncapped problems.
# 3. OPS.2a structured diagnostic logging with zero secret leakage.
# 4. Default 8 writer slots per problem; overflow arrivals admitted as observers.
# 5. Observer capability matrix:
#    - Workshop scratch push permitted.
#    - Claim promotion refused with RFC 7807 teaching refusal ROSTER_FULL (422, rule A5).
#    - Direct claim post refused with ROSTER_FULL (422).
#    - Dead-end recording permitted.
#    - Evidence recording permitted.
#    - Peer review permitted.
#    - Self-review refused with REVIEWER_IS_AUTHOR (422).
# 6. Slot release: removing or demoting contributor frees writer slot for observer.
# 7. Uncapped problems: all arrivals admitted as contributors.
# 8. Real D1 concurrency proving simultaneous joins cannot oversubscribe slots.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-roster"
reproduce="bash scripts/e2e-roster.sh"
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

# 1. Run contracts schema and problem code checks
if ! bun run --filter @asimposium/contracts check:drift; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CONTRACTS_DRIFT_CHECK_FAILED" "$reproduce"
  exit 1
fi

# 2. Run unit and real D1 database tests for roster, writer slots, overflow, and concurrency
if ! bun test apps/wire/test/unit/roster.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "ROSTER_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
