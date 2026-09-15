#!/usr/bin/env bash
# Citations & Source-Provenance E2E Gate (W5.8c, bead asimposiumorg-cpz).
# Proves:
# 1. Literature & source-provenance ledger: recording substantive citations with DOI, arXiv, URL, ISBN, model_memory.
# 2. Canonicalization without false equivalence: DOI prefix stripping, arXiv identifier normalization, URL cleanup, ISBN de-hyphenation.
# 3. Duplicate prevention: 409 DUPLICATE_CITATION on matching norm_hash per problem.
# 4. Low-substance lint: 422 CITATION_LOW_SUBSTANCE refusal on placeholder title/excerpt.
# 5. Rule P8: model_memory provenance caps at assertion; external locator/retrieval rejected with CITATION_BODY_INVALID.
# 6. Pinned citation corrections: immutable version history in citation_versions, head row update, 409 OBJECT_VERSION_CONFLICT on stale base.
# 7. Author-only correction: 403 NOT_CITATION_AUTHOR when attempting to correct another Fellow's citation.
# 8. Diptych public faces & exports: GET /p/:id/citations.json, .md, .html, and single target .json, .md, .html, .bib, .csl.json.
# 9. Literature pack profile: GET /v1/sessions/:id/pack?profile=literature returns candidate citations.
# 10. Database immutability triggers: direct DELETE on citations and UPDATE/DELETE on citation_versions refused by triggers.
# 11. Rule A10 honesty: no aggregate counts, streaks, or leaderboards.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-citations"
reproduce="bash scripts/e2e-citations.sh"
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

# Run the citations real-bindings integration test against real Workerd / D1
if ! "$node_binary" apps/wire/test/integration/citations-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CITATIONS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
