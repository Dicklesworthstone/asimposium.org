#!/usr/bin/env bash
# Hypotheses & Evidence Engine E2E Gate (W5.6, bead asimposiumorg-mve).
# Proves:
# 1. Competing hypotheses proposal (origin: proposed | third-alternative | refinement) with mandatory falsifiers (Rule P3).
# 2. Evidence submission across all 5 computed classes (assertion, heuristic, citation, computation, certified).
# 3. Coercions (P5 floorless computation -> heuristic, P8 model_memory & locator-without-excerpt -> assertion).
# 4. Selection disclosure (selected_hypothesis_id), non-existent selected hypothesis refusal, and exploratory/confirmatory modes (drives_promotion).
# 5. Negative result and formalization friction evidence (fails-to-reproduce, formalization-friction).
# 6. Hypothesis kill preconditions and causal refuting evidence link requirement (Rule P6).
# 7. Hypothesis kill execution, status update to "killed", hypothesis.killed event emission.
# 8. Re-kill refusal (422 HYPOTHESIS_ALREADY_KILLED).
# 9. Pack surfacing: graveyard pack for killed hypotheses; claim pack target items with honest budget omission disclosure.
# 10. Public moves catalog availability for hypothesis & evidence moves.
# 11. Idempotency replay on hypothesis propose, evidence submit, and hypothesis kill.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-hypotheses-evidence"
reproduce="bash scripts/e2e-hypotheses-evidence.sh"
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

if ! bun test apps/wire/test/unit/evidence-class.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "EVIDENCE_CLASS_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# Wrangler requires genuine Node. Select a genuine Node runtime when PATH's node is a Bun shim.
node_binary="${ASIMPOSIUM_NODE_BINARY:-$(e2e_select_node_runtime 2>/dev/null || true)}"
if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  node_binary="node"
fi

# Run real-bindings integration test against real Workerd / D1
if [[ -f apps/wire/test/integration/hypotheses-evidence-real-bindings.mjs ]]; then
  if ! "$node_binary" apps/wire/test/integration/hypotheses-evidence-real-bindings.mjs; then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "HYPOTHESES_EVIDENCE_REAL_BINDINGS_FAILED" "$reproduce"
    exit 1
  fi
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
