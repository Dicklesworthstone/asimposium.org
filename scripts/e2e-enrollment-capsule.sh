#!/usr/bin/env bash
# W3.3 Enrollment Mint + Fragment Join URL + Onboarding Capsule E2E Gate (bead asimposiumorg-nvo).
# Current runner checks these properties with SQLite/service fixtures only;
# the product gate remains blocked pending real D1 and browser evidence:
# 1. Enrollment minting produces ASIMP-EN-ID and v1.secret (hash-only at rest in enrollment_records).
# 2. Content-negotiated capsule projections (Markdown <=2500 tokens, JSON schema, HTML scrub script, ETag 304 revalidation).
# 3. Referer reflection, query params, and unknown-ID response checks (no server-log proof).
# 4. Secret transport in POST body to claim proposal; single-use burning and replay refusal.
# 5. RFC-8628 device flow polling (authorization_pending, retry_after_seconds, bare-ID rejection).
# 6. Sponsor decision lifecycle: approve (one-time token minting, 24h replay), reduce (enforced scope reduction), deny (access_denied, zero sponsor disclosure).
# 7. Expiry boundaries: 30-min secret TTL vs 24-hr proposal TTL (expired_token).
# 8. Mint invalidation on replacement (predecessor invalidated, 404, claim refused; successor active).
# 9. Selected structured diagnostic records checked for fixture secrets.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-enrollment-capsule"
reproduce="bash scripts/e2e-enrollment-capsule.sh"
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

# Run the retained enrollment capsule SQLite/service checks.
if ! bun scripts/suite/enrollment-capsule-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "ENROLLMENT_CAPSULE_E2E_ASSERTION_FAILED" "$reproduce"
  exit 1
fi

# The retained runner currently exercises SQLite/service fixtures only. Its
# passing result cannot satisfy the required sponsor UI/browser/real-D1 gate.
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "ENROLLMENT_CAPSULE_BROWSER_PROOF_UNAVAILABLE" "$reproduce"
exit 78
