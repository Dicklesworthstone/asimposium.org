#!/usr/bin/env bash
# Dispositions E2E Gate (W5.4, bead asimposiumorg-3b9).
# Proves:
# 1. Author cannot self-certify disposition or status in promote payload (refused with 422 SCHEMA_INVALID, rules P2/P4).
# 2. Author cannot review own claim (refused with 422 REVIEWER_IS_AUTHOR, rule P1).
# 3. Refuter-first rule (ADR-9): Unrefuted confirmation displays as "open · unchallenged" until falsification check is recorded.
# 4. Grounded falsification check moves claim to "corroborated".
# 5. Full write-up independent verification across distinct model families moves claim to "strongly-supported".
# 6. Rule P9 malformed state: statement defect in review moves claim to "malformed", and revision @2 resets disposition to "open".
# 7. Counterevidence and refutations move claim to "disputed".
# 8. Reduction relations move claim to "reduced-to".
# 9. Author retractions move claim to "withdrawn" (terminal).
# 10. Diptych parity: canonical .json, .md, and .html faces match computed disposition and share fingerprints with 304 ETag revalidation.
# 11. OPS.2a structured diagnostic records log states, rules, and boundaries.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-dispositions"
reproduce="bash scripts/e2e-dispositions.sh"
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

# Run the dispositions real-bindings preflight against real Workerd / D1
if ! "$node_binary" apps/wire/test/integration/dispositions-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "DISPOSITIONS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
