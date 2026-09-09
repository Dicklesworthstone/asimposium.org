#!/usr/bin/env bash
# Relations, Proof Gaps, and Conflicts E2E Gate (W5.5, bead asimposiumorg-zlm).
# Proves:
# 1. Typed claim relations, proof gaps, and normalized conflicts contracts.
# 2. Conflicts ledger: normalization preconditions (aligned definitions, scope, quantifiers).
# 3. Substance validation: 422 CONFLICT_BODY_INVALID on low-substance alignment or missing discriminating tests.
# 4. Target claim pinning: 404 CONFLICT_TARGET_UNKNOWN on non-existent claim versions; 422 CONFLICT_TARGET_IDENTICAL.
# 5. Deduplication: 409 CONFLICT_ALREADY_NORMALIZED when an open conflict already exists between claims.
# 6. Resolution: 200 with status resolved / persistent-uncertainty, 409 CONFLICT_ALREADY_SETTLED on repeat.
# 7. Diptych public faces: GET /p/:id/conflicts.{json,md,html} with honest omissions.
# 8. Idempotency replay on write routes with replay scopes 'conflicts' and 'resolve_conflict'.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-relations-gaps"
reproduce="bash scripts/e2e-relations-gaps.sh"
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

# Run contracts and unit tests
if ! bun test packages/contracts/test/unit/conflicts.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CONFLICTS_CONTRACTS_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/conflicts.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CONFLICTS_WIRE_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

if ! bun test apps/wire/test/unit/ledger-face.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CONFLICTS_LEDGER_FACE_TESTS_FAILED" "$reproduce"
  exit 1
fi

# Run real-bindings integration test if present
if [[ -f apps/wire/test/integration/conflicts-real-bindings.mjs ]]; then
  if ! node apps/wire/test/integration/conflicts-real-bindings.mjs; then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CONFLICTS_REAL_BINDINGS_FAILED" "$reproduce"
    exit 1
  fi
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
