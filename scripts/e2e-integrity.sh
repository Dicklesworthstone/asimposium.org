#!/usr/bin/env bash
# Integrity Chain and Signed Checkpoints E2E Gate (W2.4, bead asimposiumorg-24q).
# Proves:
# 1. Per-event chain_digest computation: binds problem_id, seq, payload_sha256, row_digest, prev_chain_digest.
# 2. Per-event row_digest computation: binds immutable envelope fields (actor, sponsor, session, model, harness, credentials, type, object, created_at).
# 3. Genesis chain digest binding for each problem scope.
# 4. Checkpoint digest generation and verification over root chain digest and sequence.
# 5. Full offline export verification: header checkpoints, event chain continuity, and terminal control records.
# 6. Tamper detection on scratch copies:
#    - Payload swapping (same digests, changed payload_json bytes -> payload sha256 mismatch).
#    - Payload digest forgery (changed payload_sha256 -> row/chain digest mismatch).
#    - Sequence gaps (missing sequence -> sequence gap mismatch).
#    - Sequence reordering (out of order -> sequence gap mismatch).
#    - Envelope authority tampering (fellow, sponsor, session, model, harness, credential, type, object_id, version, created_at) even when row_digest is recomputed.
#    - Scope substitution & cross-scope isolation (event from wrong problem spliced in -> chain digest mismatch).
#    - Checkpoint tampering (forged root, forged checkpoint_digest, reordered checkpoints, extra/missing checkpoints).
#    - Terminal record tampering (event count mismatch, final cursor mismatch, extra records after terminal).
#    - External checkpoint pin verification (rejection of divergent suffix or invalid pin).
# 7. Privacy invariant: workshop scratch, private drafts, or credentials are never exposed in public exports.
# 8. OPS.2a structured diagnostic records log hashes, versions, decisions, and durations without sensitive secrets or tokens.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-integrity"
reproduce="bash scripts/e2e-integrity.sh"
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

# 1. Run unit test suites for integrity chain and checkpoints
if ! bun test apps/wire/test/unit/krater-export.test.ts \
              apps/wire/src/krater/krater.test.ts \
              apps/wire/test/unit/citation-read-integrity.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "INTEGRITY_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run the comprehensive integrity E2E runner
if ! bun scripts/suite/integrity-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "INTEGRITY_E2E_RUNNER_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
