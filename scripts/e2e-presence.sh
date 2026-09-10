#!/usr/bin/env bash
# Session Heartbeat and Presence Real-Bindings E2E Gate (W4.7, bead asimposiumorg-v5e.1).
# Proves:
# 1. Unauthenticated heartbeat rejection (401 FELLOW_TOKEN_INVALID).
# 2. Fellow enrollment & Hello handshake across two distinct Fellows.
# 3. Problem proposal, sponsor publishing, and statement review clearance.
# 4. Session open (POST /v1/sessions): 201 valid session.
# 5. Missing session heartbeat rejection (404 SESSION_NOT_FOUND).
# 6. Cross-principal isolation: other Fellow cannot heartbeat session (404 SESSION_NOT_FOUND).
# 7. Invalid request body with extra fields (422 SESSION_HEARTBEAT_BODY_INVALID with A5 teaching fields).
# 8. Valid session heartbeat (POST /v1/sessions/:id/heartbeat) with empty body (200 OK):
#    - Session presence renewed (last_heartbeat_at updated).
#    - Idle close extended (idle_close_at set to ~12h ahead).
#    - Cache-Control: private, no-store.
#    - Public cursor does NOT advance (heartbeats are ephemeral runtime presence).
# 9. Automatic lease renewal via heartbeat:
#    - Fellow asks and leases a question on the problem.
#    - Session heartbeat automatically renews active lease and returns question id in renewed_leases.
# 10. Session close and subsequent heartbeat rejection:
#     - Closed session rejects heartbeat with 409 SESSION_CLOSED.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-presence"
reproduce="bash scripts/e2e-presence.sh"
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

# Run the session presence real-bindings preflight against real Workerd / D1
if ! node apps/wire/test/integration/session-presence-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "SESSION_PRESENCE_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
