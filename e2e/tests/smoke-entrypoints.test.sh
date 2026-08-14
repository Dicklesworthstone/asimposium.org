#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
suite="smoke-entrypoints-integration"
started_ms="$(e2e_now_ms)"
reproduce="bash e2e/tests/smoke-entrypoints.test.sh"

emit() {
  local status="$1"
  local code="$2"
  e2e_emit_diagnostic "$suite" "$started_ms" "$status" "$code" "$reproduce"
}

for self_test in \
  "$repository_root/scripts/smoke-agent.sh" \
  "$repository_root/scripts/smoke-gallery.sh" \
  "$repository_root/e2e/run-playwright.sh" \
  "$repository_root/e2e/gauntlet/run.sh"; do
  if ! "$self_test" --self-test >/dev/null; then
    emit "fail" "ENTRYPOINT_SELF_TEST_FAILED"
    exit 1
  fi
done

if invalid_run_id_output="$(ASIMPOSIUM_E2E_RUN_ID="../traversal" "$repository_root/scripts/smoke-agent.sh" 2>&1)"; then
  emit "fail" "TRAVERSAL_RUN_ID_ACCEPTED"
  exit 1
fi

if [[ "$invalid_run_id_output" != *'"code":"RUN_ID_INVALID"'* ]]; then
  emit "fail" "TRAVERSAL_REJECTION_DIAGNOSTIC_MISSING"
  exit 1
fi

if credential_origin_output="$(ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://test-user:test-pass@127.0.0.1:1" "$repository_root/scripts/smoke-agent.sh" 2>&1)"; then
  emit "fail" "CREDENTIAL_ORIGIN_ACCEPTED"
  exit 1
fi

if [[ "$credential_origin_output" != *'"code":"STAGING_AGENT_BASE_URL_INVALID"'* ]]; then
  emit "fail" "CREDENTIAL_ORIGIN_REJECTION_DIAGNOSTIC_MISSING"
  exit 1
fi

if [[ "$credential_origin_output" == *"test-user"* ]] || [[ "$credential_origin_output" == *"test-pass"* ]] || [[ "$credential_origin_output" == *"127.0.0.1:1"* ]]; then
  emit "fail" "CREDENTIAL_ORIGIN_LEAKED"
  exit 1
fi

if missing_surface_output="$(ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://127.0.0.1:1" "$repository_root/scripts/smoke-agent.sh" 2>&1)"; then
  emit "fail" "MISSING_STAGING_SURFACE_ACCEPTED"
  exit 1
fi

if [[ "$missing_surface_output" != *'"code":"AGENT_HANDBOOK_UNAVAILABLE"'* ]]; then
  emit "fail" "MISSING_STAGING_SURFACE_DIAGNOSTIC_MISSING"
  exit 1
fi

if [[ "$missing_surface_output" == *"127.0.0.1:1"* ]] || [[ "$missing_surface_output" == *"https://"* ]]; then
  emit "fail" "MISSING_STAGING_SURFACE_ORIGIN_LEAKED"
  exit 1
fi

emit "pass" "ENTRYPOINT_NEGATIVE_CONTRACT_OK"
