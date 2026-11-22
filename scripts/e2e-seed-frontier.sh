#!/usr/bin/env bash
# W12.2 SP4D Flagship + Rung 6/7 Frontier Slate E2E Gate (asimposiumorg-a5j).
#
# Modes:
#   --target local    (default) Runs SP4D/frontier source dossier checks plus the real
#                     local Workerd/D1/R2 famous-problem guardrail & premature-resolution
#                     refusal journey (`seed-frontier-real-bindings.mjs`).
#   --target staging  Validates staging Stoa origin (refusing production), requires
#                     provisioned staging Fellow/sponsor credentials, and fails closed
#                     (exit 78) when unprovisioned or awaiting OPS.3 deploy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"

TARGET="local"
STARTED_MS="$(e2e_now_ms)"
RUN_ID="$(e2e_generated_run_id "seed-frontier")"
SUITE="e2e-seed-frontier"
REPRODUCE="bash scripts/e2e-seed-frontier.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { echo "ERROR: --target requires local|staging" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/e2e-seed-frontier.sh [--target local|staging]
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$TARGET" == "staging" ]]; then
  if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
    origin_rc=$?
    if [[ "$origin_rc" -eq 2 ]]; then
      e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGENT_BASE_URL_MISSING" "$REPRODUCE"
    else
      e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "STAGING_AGENT_BASE_URL_INVALID" "$REPRODUCE"
    fi
    exit 78
  fi
  if [[ -z "${ASIMPOSIUM_SEED_FELLOW_TOKEN:-}" || -z "${ASIMPOSIUM_SEED_REVIEWER_TOKEN:-}" ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_FRONTIER_CREDENTIALS_UNPROVISIONED" "$REPRODUCE"
    exit 78
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_FRONTIER_REQUIRES_OPS3_DEPLOY" "$REPRODUCE"
  exit 78
fi

if [[ "$TARGET" != "local" ]]; then
  echo "ERROR: unsupported --target '$TARGET' (expected local or staging)" >&2
  exit 2
fi

NODE_BIN="$(e2e_select_node_runtime)" || {
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "GENUINE_NODE_UNAVAILABLE" "$REPRODUCE"
  exit 78
}

(
  cd "$REPO_ROOT"
  "$NODE_BIN" apps/wire/test/integration/seed-frontier-real-bindings.mjs
)

e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "SEED_FRONTIER_LOCAL_REAL_BINDINGS_PASS" "$REPRODUCE"
