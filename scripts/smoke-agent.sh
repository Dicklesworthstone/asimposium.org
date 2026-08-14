#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="smoke-agent"
reproduce="scripts/smoke-agent.sh --self-test"
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=1
      ;;
    --write-artifacts)
      write_artifacts=1
      ;;
    --run-id)
      [[ "$#" -ge 2 ]] || {
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_MISSING" "$reproduce"
        exit 64
      }
      explicit_run_id="$2"
      shift
      ;;
    *)
      e2e_emit_diagnostic "$suite" "$started_ms" "fail" "UNKNOWN_ARGUMENT" "$reproduce"
      exit 64
      ;;
  esac
  shift
done

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
  exit 64
}

if e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
  :
else
  origin_status=$?
  case "$origin_status" in
    2) code="STAGING_AGENT_BASE_URL_MISSING" ;;
    *) code="STAGING_AGENT_BASE_URL_INVALID" ;;
  esac
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$code" "$reproduce"
  exit 78
fi

if ! e2e_probe_public_path "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_HANDBOOK_UNAVAILABLE" "$reproduce"
  exit 69
fi

if ! e2e_probe_public_path "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/capabilities"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CAPABILITIES_UNAVAILABLE" "$reproduce"
  exit 69
fi

# OPS.1 establishes an executable preflight only. It must not turn a pair of
# public GETs into a fabricated G0 pairing/session/promotion result.
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PRODUCT_FLOW_NOT_IMPLEMENTED" "$reproduce"
exit 70
