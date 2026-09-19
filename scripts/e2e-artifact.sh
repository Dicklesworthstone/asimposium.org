#!/usr/bin/env bash
# Artifact API & CAS Pipeline E2E Gate (W6.9, bead asimposiumorg-rhg).
# Proves:
# 1. Manifest declaration (POST /v1/artifacts) -> 201 Created with presigned PUT grant.
# 2. Idempotency replay on declaration (same upload_id, PUT grant).
# 3. Conflict and schema validation (409 on changed hash/size under same key, 422 on invalid hash, 400 on query params).
# 4. Premature completion refusal (409 NOT_UPLOADED before staging).
# 5. Staging and verification in real R2 -> 200 OK with state "verified", bytes-only verification label, bytes written to private CAS.
# 6. Private status and download -> 200 OK with exact bytes, cache-control: private, no-store, content-disposition: attachment, CSP sandbox.
# 7. Anonymous and cross-sponsor download refusals (401) and byte range refusal (400).
# 8. Digest mismatch detection -> 422 MISMATCH, terminal quarantine state, download refused.
# 9. Secret/PII screening refusal (403 WRITE_REFUSED on private key).
# 10. Claim promotion, evidence submission, and publication request (POST /v1/artifacts/:id/publish -> 202 Accepted).
# 11. Publication idempotency replay (202 same pubId) and conflict refusal (409 under same key).
# 12. Cross-sponsor publication refusal (404) and quarantined upload publication refusal (403 WRITE_REFUSED).
# 13. Outbox delivery engine execution -> published delivery status, copy to public CAS.
# 14. Public manifest face (/p/:problem/artifacts/:id.json) and evidence artifacts listing (/p/:problem/evidence/:id/artifacts.json).
# 15. Clean session close.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-artifact"
reproduce="bash scripts/e2e-artifact.sh"
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

# Run contract schemas tests
if ! bun test packages/contracts/test/unit/artifact-uploads.test.ts packages/contracts/test/unit/artifact-publications.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "ARTIFACT_CONTRACTS_TESTS_FAILED" "$reproduce"
  exit 1
fi

# Run wire artifact unit tests
if ! bun test apps/wire/test/unit/artifact-store.test.ts apps/wire/test/unit/artifact-presign.test.ts apps/wire/test/unit/artifact-inspection.test.ts apps/wire/test/unit/artifact-publication-bytes.test.ts apps/wire/test/unit/artifact-publication-http.test.ts apps/wire/test/unit/artifact-publication-outbox.test.ts apps/wire/test/unit/artifact-publication-screen.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "ARTIFACT_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# Wrangler requires genuine Node. Select a genuine Node runtime when PATH's node is a Bun shim.
node_binary="${ASIMPOSIUM_NODE_BINARY:-$(e2e_select_node_runtime 2>/dev/null || true)}"
if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  node_binary="node"
fi

# Run real-bindings integration test against real Workerd / D1 / R2
if [[ -f apps/wire/test/integration/artifact-real-bindings.mjs ]]; then
  if ! "$node_binary" apps/wire/test/integration/artifact-real-bindings.mjs; then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "ARTIFACT_REAL_BINDINGS_FAILED" "$reproduce"
    exit 1
  fi
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
