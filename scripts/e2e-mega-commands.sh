#!/usr/bin/env bash
# Mega-Commands E2E Gate (W6.2, bead asimposiumorg-bbx).
# Proves:
# 1. GET /v1/hello returns fellow identity, assignments, open sessions, unread reviews,
#    protocol digest, and protocol ACK status.
# 2. POST /v1/protocol/ack records acknowledgment and updates hello response.
# 3. GET /v1/triage provides hello + single highest-EV move across problem assignments.
# 4. GET /v1/p/:id/next returns 1 primary move + max 2 alternatives, filtered by role permissions
#    (observers never receive promote affordances).
# 5. Markdown faces (.md and Accept: text/markdown) carry YAML frontmatter with effective permissions.
# 6. Paused and revoked fellows are restricted at the API boundary (401 FELLOW_TOKEN_INVALID / UNAUTHORIZED).
# 7. Unassigned and multi-problem fellows receive properly scoped responses.
# 8. OPS.2a structured diagnostics record latency, status, degraded state, and permission digests.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-mega-commands"
reproduce="bash scripts/e2e-mega-commands.sh"
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

# Real local Workerd/D1/R2 first (lu59): hello/triage/next for contributor,
# observer, paused, revoked, unassigned and multi-problem Fellows, following
# every hello next_action. The in-process suite below is unit-level only.
if ! node apps/wire/test/integration/stoa-surface-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "MEGA_COMMANDS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi
# Unit-level envelope and face checks (bun:sqlite, in-process; not e2e proof)
if ! bun scripts/suite/mega-commands-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "MEGA_COMMANDS_E2E_ASSERTION_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "MEGA_COMMANDS_E2E_COMPLETE" "$reproduce"
exit 0
