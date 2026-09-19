#!/usr/bin/env bash
# Krater CAS Storage & Artifact Pipeline E2E Gate (W2.7, bead asimposiumorg-kl8).
# Proves:
# 1. CAS core decision layer: SHA-256 keying, site-wide deduplication, immutable URLs.
# 2. 1 KB spill threshold, 280-character scalar-safe extract, surrogate pair safety.
# 3. Closed MIME allowlist (text/source/Lean/logs, .tar.gz lake archives with attachment disposition).
# 4. Forbidden execution wall (HTML/SVG/JS outright refused under site origin; Object.prototype safe).
# 5. Size caps (5 MB general, 20 MB lake cap), cheap doomed-upload gates, single body reads.
# 6. Rule P7 secret-shaped refusal (Fellow tokens, PEM private keys, email PII) with deterministic location redaction.
# 7. Archive safety bounds: 100:1 expansion bomb refusal, directory traversal prevention.
# 8. Upload manifest state machine: BFS transition closure, unverified cannot bind, quarantine terminal, expiry terminal.
# 9. Reference-aware GC eligibility: private preserves bytes, public never collected, duplicate private keeps public.
# 10. Artifact inventory reconciliation: missing-object signals, state mismatches, order & duplicate independence.
# 11. Real Workerd / D1 / R2 integration: manifest declaration, presigned PUT grant, real R2 CAS storage,
#     bytes-only verification, authenticated private download & security headers, quarantine transitions,
#     publication to public CAS, public manifest face (/p/:problem/artifacts/:id.json), and clean session close.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-cas"
reproduce="bash scripts/e2e-cas.sh"
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

# 1. Run pure CAS decision and reconciliation unit tests
if ! bun test apps/wire/test/unit/krater-cas.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CAS_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run contract schemas tests
if ! bun test packages/contracts/test/unit/artifact-uploads.test.ts packages/contracts/test/unit/artifact-publications.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CAS_CONTRACTS_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 3. Run wire artifact unit tests
if ! bun test apps/wire/test/unit/artifact-store.test.ts apps/wire/test/unit/artifact-presign.test.ts apps/wire/test/unit/artifact-inspection.test.ts apps/wire/test/unit/artifact-publication-bytes.test.ts apps/wire/test/unit/artifact-publication-http.test.ts apps/wire/test/unit/artifact-publication-outbox.test.ts apps/wire/test/unit/artifact-publication-screen.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CAS_ARTIFACT_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 4. Run real-bindings integration test against real Workerd / D1 / R2 (private & public buckets)
node_binary="${ASIMPOSIUM_NODE_BINARY:-$(e2e_select_node_runtime 2>/dev/null || true)}"
if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  node_binary="node"
fi

if ! "$node_binary" apps/wire/test/integration/artifact-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "CAS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
