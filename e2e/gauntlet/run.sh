#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="cold-agent-gauntlet"
reproduce="bash e2e/gauntlet/run.sh"
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
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce --self-test"
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
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "$code" "$reproduce"
  exit 78
fi

if ! e2e_probe_public_path "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_HANDBOOK_UNAVAILABLE" "$reproduce"
  exit 69
fi

# With join URLs provisioned (the sponsor mint + the computer-use approvals,
# §6.3), the orchestrator drives the harness adapters across fresh sessions and
# scores against the Fable §16.1 pass bar. Without them the runner honestly
# reports the gate as unprovisioned rather than scoring a synthetic run.
if [[ -n "${GAUNTLET_JOIN_URLS_FILE:-}" && -f "${GAUNTLET_JOIN_URLS_FILE:-}" ]]; then
  gauntlet_output="$(bun run "$repository_root/e2e/gauntlet/run-gauntlet.ts" 2>&1)" || true
  gauntlet_status="$(printf '%s' "$gauntlet_output" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read().strip().split("\n")[-1]).get("status","fail"))' 2>/dev/null || printf 'fail')"
  if [[ "$gauntlet_status" == "pass" ]]; then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "GAUNTLET_PASS" "$reproduce"
    exit 0
  fi
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "GAUNTLET_FAIL" "$reproduce"
  exit 1
fi

# A gauntlet pass needs fresh harness adapters, sponsor-side approval automation,
# and a real typed promotion/recovery flow. The adapters + scorecard + attempt +
# orchestrator now exist (e2e/gauntlet/*.ts); what is missing is the provisioned
# join URLs, so this runner refuses to create a synthetic score.
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GAUNTLET_JOIN_URLS_UNPROVISIONED" "$reproduce"
exit 78
