#!/usr/bin/env bash
# Problem Governance E2E Gate (W5.2, bead asimposiumorg-3uj).
# Proves:
# 1. Multi-sponsor workspace governance without epistemic fiat (ADR-22).
# 2. Roles per problem: observer, contributor, steward, founding-steward.
# 3. Admission modes: open, approval-required, invite-only, archived-read-only.
# 4. Steward management: transfer, share, and refusal of sole-steward removal.
# 5. Member removal from problem without touching global identity or tokens (ADR-22).
# 6. Writer cap enforcement.
# 7. Merge with preserved IDs, claim mapping, and 308 redirect to canonical problem.
# 8. Fork with parent lineage, statement copying, and parent cursor recording.
# 9. Invariant that governance cannot move scientific disposition by fiat (ADR-22).
# 10. Real D1 concurrency on governance writes.
# 11. OPS.2a structured diagnostic logging with zero secret leakage.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-problem-governance"
reproduce="bash scripts/e2e-problem-governance.sh"
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

# Wrangler requires genuine Node. Select a genuine Node runtime when PATH's node is a Bun shim.
node_binary="${ASIMPOSIUM_NODE_BINARY:-$(e2e_select_node_runtime 2>/dev/null || true)}"
if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  node_binary="node"
fi

# Run the problem governance real-bindings integration test against real Workerd / D1
if ! "$node_binary" apps/wire/test/integration/problem-governance-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "PROBLEM_GOVERNANCE_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
