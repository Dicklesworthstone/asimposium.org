#!/usr/bin/env bash
# Human Protocol Pages & Thin Audited Admin E2E Gate (W8.8c, bead asimposiumorg-0ht).
# Proves:
# 1. Public Human Protocol & Essay Projections (Diptych Parity):
#    - /protocol, /policy, /about, and /moderation rendered from versioned served texts without drift.
#    - Diptych links (/protocol.md, /protocol.json, /policy.md, /about.md, /moderation.md) present.
#    - Hard rules P1–P13, preamble, word cap badge (<= 1,000 words), screening notices, and 3 rooms / 2 planes.
#    - Zero extra claims; apex static copies agree byte-for-byte with canonical protocol registry.
# 2. Thin Audited Admin Protection & Security Boundaries:
#    - Admin metadata declares private noindex/nofollow; no public sitemap or agent face.
#    - Anonymous visitor blocked with sign-in requirement; no private queues exposed.
#    - Authenticated non-operator sponsor blocked with 403 Forbidden.
#    - Operator with stale auth (> 15m) blocked with Step-Up Required prompt.
#    - Authorized operator with fresh auth sees queues, controls, and read-only default notice.
#    - Case details, screening patterns, and detector scores protected from oracle disclosure.
# 3. Audited Admin Actions & Structural Impossibility of Scientific Disposition Overrides:
#    - Quarantine resolution, report resolution, content controls, and area maintenance.
#    - Structural impossibility: attempts to pass disposition, scientific_disposition, claim_disposition,
#      or status_override are unconditionally rejected with SCIENTIFIC_DISPOSITION_OVERRIDE_PROHIBITED.
# 4. OPS.2a structured diagnostic logging without secret or private body leakage.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-protocol-admin"
reproduce="bash scripts/e2e-protocol-admin.sh"
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

# 1. Run contracts unit tests
if ! bun test packages/contracts/test/unit/admin.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "ADMIN_CONTRACT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run web unit tests for protocol pages & admin view
if ! bun test apps/web/test/unit/protocol-admin.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "PROTOCOL_ADMIN_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 3. Run comprehensive protocol & admin E2E suite
if ! bun run scripts/suite/protocol-admin-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "PROTOCOL_ADMIN_E2E_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
