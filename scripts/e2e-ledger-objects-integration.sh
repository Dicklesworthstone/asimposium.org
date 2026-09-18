#!/usr/bin/env bash
# Ledger Objects Integration E2E Gate (W5.8, bead asimposiumorg-0vu).
# Proves against real Workerd / D1 / R2:
# 1. Integration of all W5.8 remaining ledger objects in one problem:
#    - Dead ends, nulls, retry triggers, and farming guards (W5.8a)
#    - Syntheses and Rule P13 ledger anchoring (W5.8b)
#    - Citations and source-provenance objects (W5.8c)
#    - Questions, leases, answers, and retractions (W5.8d)
# 2. Rule P6 permanent negative knowledge: database immutability triggers refuse direct DELETE
#    on dead_ends, citations, citation_versions, questions, syntheses, and retractions.
# 3. Rule P9/P11 version monotonicity, duplicate prevention, and conflict detection:
#    - Duplicate citation and dead-end prevention (409 DUPLICATE_*)
#    - Stale revision conflict rejection (409 OBJECT_VERSION_CONFLICT) on citations and dead-end supersession
#    - Non-author modification refusal (403 NOT_*_AUTHOR)
# 4. Leased questions and answers:
#    - Leasable question posting, exclusive lease holding, conflict on concurrent lease (409)
#    - Resolution via citation reference, duplicate answer conflict (409)
# 5. Rule P13 synthesis anchoring:
#    - Unanchored synthesis targeting nonexistent objects rejected (422 SYNTHESIS_UNANCHORED)
#    - Synthesis anchoring exact historical versions of claims and citations
# 6. History-preserving retractions:
#    - Author self-correction retraction recorded without deleting historical events or objects
# 7. Rule A6 event log rebuild and strict sequence monotonicity:
#    - All substantive ledger mutations append events with continuous monotonically increasing seq
# 8. Rule A1 Diptych faces and exact-version retrieval:
#    - Public .json, .md, .bib, and version-pinned faces (@version) serve canonical data
# 9. OPS.2a secret-safe structured diagnostic logging.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-ledger-objects-integration"
reproduce="bash scripts/e2e-ledger-objects-integration.sh"
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

# Run the ledger objects unified real-bindings integration test against real Workerd / D1
if ! "$node_binary" apps/wire/test/integration/ledger-objects-integration-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "LEDGER_OBJECTS_INTEGRATION_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
