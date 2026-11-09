#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="cold-agent-gauntlet"
reproduce="bash e2e/gauntlet/run.sh"
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""
target="staging"
agent_selection=""
agents_explicit=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=1
      ;;
    --write-artifacts)
      write_artifacts=1
      ;;
    --target)
      [[ "$#" -ge 2 && ( "$2" == "local" || "$2" == "staging" ) ]] || {
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "TARGET_INVALID" "$reproduce"
        exit 64
      }
      target="$2"
      shift
      ;;
    --agents)
      if [[ "$#" -lt 2 || "$agents_explicit" -eq 1 || -z "$2" \
        || ! "$2" =~ ^[a-z0-9:,-]+$ ]]; then
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "AGENT_SELECTION_INVALID" "$reproduce"
        exit 64
      fi
      agent_selection="$2"
      agents_explicit=1
      shift
      ;;
    --run-id)
      [[ "$#" -ge 2 ]] || {
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_MISSING" "$reproduce"
        exit 64
      }
      if [[ "$2" == --* || -z "$2" ]]; then
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_MISSING" "$reproduce"
        exit 64
      fi
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

if [[ "$agents_explicit" -eq 1 && "$target" != "local" ]]; then
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "AGENT_SELECTION_REQUIRES_LOCAL_TARGET" "$reproduce"
  exit 64
fi

if [[ -n "$explicit_run_id" ]]; then
  e2e_validate_run_id "$explicit_run_id" || {
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
    exit 64
  }
fi

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce --self-test"
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
  exit 64
}
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

# Local target (bead asimposiumorg-g5h0): the state-derived product flow runs
# against real local Workerd/D1/R2. The default runs the scripted oracles;
# explicit selectors can also measure the existing real harness adapters.
# Neither mode supplies hosted screening, OAuth or the staging G-C bar.
if [[ "$target" == "local" ]]; then
  node_binary="$(e2e_select_node_runtime 2>/dev/null || true)"
  [[ -n "$node_binary" && -x "$node_binary" ]] || node_binary="node"
  local_args=()
  if [[ "$agents_explicit" -eq 1 ]]; then local_args=(--agents "$agent_selection"); fi
  local_status=0
  "$node_binary" "$repository_root/e2e/gauntlet/local-product-flow.mjs" "${local_args[@]}" \
    || local_status=$?
  local_reproduce="$reproduce --target local"
  # Only a validated selection can reach a completed or prerequisite result.
  # Invalid caller text never enters a retained reproduction command.
  if [[ "$agents_explicit" -eq 1 && ( "$local_status" -eq 0 || "$local_status" -eq 78 ) ]]; then
    local_reproduce+=" --agents $agent_selection"
  fi
  case "$local_status" in
    0)
      code="GAUNTLET_LOCAL_REFERENCE_FLOW_PASS"
      if [[ "$agent_selection" == *harness:* ]]; then code="GAUNTLET_LOCAL_MEASUREMENT_COMPLETE"; fi
      e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "$code" "$local_reproduce"
      ;;
    78)
      e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GAUNTLET_LOCAL_HARNESS_UNAVAILABLE" "$local_reproduce"
      ;;
    64)
      e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SELECTION_INVALID" "$local_reproduce"
      ;;
    *)
      code="GAUNTLET_LOCAL_REFERENCE_FLOW_FAILED"
      if [[ "$agent_selection" == *harness:* ]]; then code="GAUNTLET_LOCAL_MEASUREMENT_FAILED"; fi
      e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$code" "$local_reproduce"
      ;;
  esac
  exit "$local_status"
fi

# The staging product flow still needs provisioned join URLs and a staging
# deployment; the local runner above is not a staging result. Refuse a provisioned
# run before any staging probe so this entry cannot launch work or turn a
# transcript/transport observation into an acceptance pass.
if [[ -n "${GAUNTLET_JOIN_URLS_FILE:-}" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GAUNTLET_PRODUCT_FLOW_NOT_IMPLEMENTED" "$reproduce"
  exit 70
fi

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

# No join URLs were provisioned. The runner reports that prerequisite separately
# from the product-flow blocker above and never creates a synthetic score.
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GAUNTLET_JOIN_URLS_UNPROVISIONED" "$reproduce"
exit 78
