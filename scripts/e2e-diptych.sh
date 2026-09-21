#!/usr/bin/env bash
# Diptych Public Faces E2E Gate (W6.1, bead asimposiumorg-92x).
# Proves:
# 1. Served texts: / (handbook), /skill.md, /inoculation.md, /AGENTS.md, /llms.txt.
# 2. Problem index & content negotiation: /problems, /problems.md, /problems.json, /problems.toon.
# 3. TOON format serialization, round-trip parsing, and [control:page_end...] footer.
# 4. Problem digest & full pack: /p/:id.json, /p/:id.md, /p/:id/full.md.
# 5. Orders 308 redirect: /p/:id/orders* -> same-problem /p/:id/moves*.
# 6. Problem moves & claims faces: /p/:id/moves*, /p/:id/claims.md, .json, .html.
# 7. Security: adversarial HTML comment neutralization in rendered markdown.
# 8. Privacy: zero leakage of private drafts or workshop canary data.
# 9. HTTP caching: ETags, 304 Not Modified, and HEAD responses across all faces.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-diptych"
reproduce="bash scripts/e2e-diptych.sh"
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

if ! bun scripts/suite/diptych-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "DIPTYCH_E2E_ASSERTION_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "DIPTYCH_E2E_COMPLETE" "$reproduce"
exit 0
