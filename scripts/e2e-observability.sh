#!/usr/bin/env bash
# OPS.4 Observability, Pre-Egress Scrubbing, Launch Alerts, & /stats Parity E2E Gate
# (`asimposiumorg-286`).
#
# Modes:
#   --target local    (default) Runs OPS.4 correlation, canary-scrubbing property tests,
#                     all 6 launch-alert trip/dedupe/recovery checks, metric-boundary
#                     tests, and /stats.json vs /stats.md semantic parity checks.
#   --target staging  Refuses production origins fail-closed (exit 78) and exits 78
#                     when hosted OPS.3 staging telemetry endpoints are unprovisioned.

set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"

TARGET="local"
STARTED_MS="$(e2e_now_ms)"
RUN_ID="$(e2e_generated_run_id "observability")"
SUITE="e2e-observability"
REPRODUCE="bash scripts/e2e-observability.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { echo "ERROR: --target requires local|staging" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/e2e-observability.sh [--target local|staging]
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
      e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGENT_BASE_URL_MISSING" "$REPRODUCE --target staging"
    else
      e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "STAGING_AGENT_BASE_URL_INVALID" "$REPRODUCE --target staging"
    fi
    exit 78
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_OBSERVABILITY_REQUIRES_OPS3_DEPLOY" "$REPRODUCE --target staging"
  exit 78
fi

if [[ "$TARGET" != "local" ]]; then
  echo "ERROR: unsupported --target '$TARGET' (expected local or staging)" >&2
  exit 2
fi

NODE_BIN="$(e2e_select_node_runtime)" || {
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "GENUINE_NODE_UNAVAILABLE" "$REPRODUCE --target local"
  exit 78
}

(
  cd "$REPO_ROOT" || exit 1
  bun test /dev/null --timeout=120000 \
    apps/wire/test/unit/observability-telemetry.test.ts \
    apps/wire/test/unit/face-log.test.ts \
    scripts/verify-cost-model.test.ts

  # Run mock-free local Workerd + migrated D1 HTTP /stats & observability lane.
  "$NODE_BIN" apps/wire/test/integration/observability-real-bindings.mjs
)

e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "OBSERVABILITY_LOCAL_REAL_BINDINGS_PASS" "$REPRODUCE --target local"
