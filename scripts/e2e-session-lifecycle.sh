#!/usr/bin/env bash
# Session Lifecycle Real-Bindings E2E Gate (W4.1, bead asimposiumorg-zdz).
# Proves:
# 1. Unauthenticated & invalid auth rejection (401 FELLOW_TOKEN_INVALID).
# 2. Fellow enrollment & Hello handshake.
# 3. Problem creation, sponsor publishing, and statement review clearance.
# 4. Session open (POST /v1/sessions): 422 invalid, 404 missing problem, 201 valid.
#    Idempotent open replay (200) and per-(fellow, problem) uniqueness (409 SESSION_EXISTS).
# 5. Session status (GET /v1/sessions/:id): returns active state, workshop_cursor, private no-store.
#    Cross-principal isolation: other Fellow gets 404 SESSION_NOT_FOUND.
# 6. Pack read (GET /v1/sessions/:id/pack?profile=working): valid working pack,
#    400 UNKNOWN_PROFILE on invalid profile, cross-principal 404 isolation.
# 7. Workshop push (POST /v1/sessions/:id/workshop): returns 201, advances workshop_cursor.
#    Public cursor does NOT advance (workshop pushes are private). Cross-principal 404.
# 8. Session close (POST /v1/sessions/:id/close): 201 with handback. Idempotent replay (200).
#    Status read on closed session confirms closed_at. Writes to closed session return 409 SESSION_CLOSED.
# 9. Re-opening on same problem unblocked after closure.
# 10. Global two-open-session cap: 3rd concurrent session refused with 409 SESSION_CAP_REACHED.
#     Closing one session restores capacity and unblocks opening.
# 11. Idle expiry: verify idle_close_at is initialized.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-session-lifecycle"
reproduce="bash scripts/e2e-session-lifecycle.sh"
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

# Run the session lifecycle real-bindings preflight against real Workerd / D1
if ! node apps/wire/test/integration/session-lifecycle-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "SESSION_LIFECYCLE_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
