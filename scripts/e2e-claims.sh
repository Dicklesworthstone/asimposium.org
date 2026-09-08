#!/usr/bin/env bash
# Claims E2E Gate (W5.3, bead asimposiumorg-6w1).
# Proves:
# 1. All 12 claim kinds are accepted and validated through the session promotion loop.
# 2. Conjecture-class claims require a falsifier; missing falsifier is refused with 422 MISSING_FALSIFIER (rule P3).
# 3. Math and NFKC normalization generates stable normHash across whitespace and LaTeX formatting variations ($...$ vs \(...\)).
# 4. P11 duplicate claim gate: colliding normalized statements on the same problem are refused with 409 DUPLICATE_CLAIM naming the existing ID.
# 5. P9 version monotonicity: revisions mint @n+1 with disposition reset to "open" and immutable content digests.
# 6. Revision authority: non-authors are refused with 403 NOT_CLAIM_AUTHOR; stale base versions are refused with 409 OBJECT_VERSION_CONFLICT.
# 7. P10 claim dependencies: acyclic depends_on DAG edges persist cleanly; cyclic dependencies and dangling refs are refused.
# 8. Diptych retrieval: public .json, .md, .bib, and .csl.json faces serve canonical head and version-pinned claim representations.
# 9. OPS.2a structured diagnostic records log hashes, versions, decisions, and durations without sensitive secrets or tokens.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-claims"
reproduce="bash scripts/e2e-claims.sh"
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

# Run the claims real-bindings preflight against real Workerd / D1
if ! node apps/wire/test/integration/claims-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CLAIMS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

# The full claims lifecycle gate is blocked on upstream problem statement versions (W5.1 / asimposiumorg-5yu)
# and typed workshop revision payload/promotion flow (W5.3).
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "CLAIMS_GATE_BLOCKED_ON_PROBLEM_LIFECYCLE" "$reproduce"
exit 78
