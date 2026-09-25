#!/usr/bin/env bash
# Identity lifecycle E2E gate (W3.8, beads asimposiumorg-wty4 / asimposiumorg-mtx).
# Proves, on real local Workerd/D1/R2 through signed sponsor envelopes:
# 1. Bilateral transfer offer, accept, reject and cancel, with lifecycle refusals.
# 2. Credential rotation on accept and immutable public attribution.
# 3. Exactly one outcome when accepts race, when cancel races accept, and when
#    revoke races accept; a loser is taught (TRANSFER_NOT_PENDING), never a 5xx.
# 4. An expired offer cannot be accepted and moves nothing.
# 5. Account export, deletion preview and deletion with zero orphaned Fellows.
# 6. Restore after deletion does not resurrect deleted drafts or the sponsor
#    (signed deletion journal replay; deletion-journal lane).
# Not covered: legal hold (hardDeletePrivateDraft accepts it; no route sets it),
# browser UI, provider restore drills.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-identity-lifecycle"
reproduce="bash scripts/e2e-identity-lifecycle.sh"
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

# Unit coverage of the transfer store (bun:sqlite; not binding proof).
if ! bun test --timeout=120000 apps/wire/test/unit/lifecycle-transfer.test.ts apps/wire/test/unit/krater-retention.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "IDENTITY_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# Wrangler requires genuine Node. Select a genuine Node runtime when PATH's node is a Bun shim.
node_binary="${ASIMPOSIUM_NODE_BINARY:-$(e2e_select_node_runtime 2>/dev/null || true)}"
if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  node_binary="node"
fi

# Real Workerd / D1 / R2 lanes. A missing lane is a failure, never a silent skip.
for lane in identity-lifecycle-real-bindings.mjs deletion-journal-real-bindings.mjs; do
  if [[ ! -f "apps/wire/test/integration/$lane" ]]; then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "REAL_BINDINGS_TEST_MISSING" "$reproduce"
    exit 1
  fi
  if ! "$node_binary" "apps/wire/test/integration/$lane"; then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "IDENTITY_REAL_BINDINGS_FAILED" "$reproduce"
    exit 1
  fi
done

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
