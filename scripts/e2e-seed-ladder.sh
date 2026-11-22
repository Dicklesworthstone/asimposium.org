#!/usr/bin/env bash
# W12.1 Seed-Problem Ladder Rungs 1-5 E2E Gate (asimposiumorg-tf2, ADR-25).
#
# Modes:
#   --target local            (default) Runs source checks + real local Workerd/D1/R2
#                             5-rung ladder journey (`seed-ladder-real-bindings.mjs`).
#   --target staging          Validates staging Stoa origin (refusing production),
#                             requires provisioned staging Fellow/sponsor credentials,
#                             and fails closed (exit 78) when unprovisioned.
#   --mode production-seed    Explicit, idempotent, revision-bound & manifest-digest-bound
#                             production seeding guard; refuses unexpected env or digest drift.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"

TARGET="local"
MODE="verify"
EXPECTED_REV=""
EXPECTED_MANIFEST_SHA=""
STARTED_MS="$(e2e_now_ms)"
RUN_ID="$(e2e_generated_run_id "seed-ladder")"
SUITE="e2e-seed-ladder"
REPRODUCE="bash scripts/e2e-seed-ladder.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { echo "ERROR: --target requires local|staging" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    --mode)
      [[ $# -ge 2 ]] || { echo "ERROR: --mode requires verify|production-seed" >&2; exit 2; }
      MODE="$2"
      shift 2
      ;;
    --expected-rev)
      [[ $# -ge 2 ]] || { echo "ERROR: --expected-rev requires a git SHA" >&2; exit 2; }
      EXPECTED_REV="$2"
      shift 2
      ;;
    --expected-manifest-sha256)
      [[ $# -ge 2 ]] || { echo "ERROR: --expected-manifest-sha256 requires a 64-hex digest" >&2; exit 2; }
      EXPECTED_MANIFEST_SHA="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/e2e-seed-ladder.sh [--target local|staging] [--mode verify|production-seed --expected-rev SHA --expected-manifest-sha256 HEX]
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

MANIFEST_PATH="${REPO_ROOT}/docs/seed/rungs-1-5/manifest.json"
if [[ ! -f "$MANIFEST_PATH" ]]; then
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "SEED_MANIFEST_MISSING" "$REPRODUCE"
  exit 1
fi

ACTUAL_MANIFEST_SHA="$(sha256sum "$MANIFEST_PATH" | awk '{print $1}')"

if [[ "$MODE" != "verify" && "$MODE" != "production-seed" ]]; then
  echo "ERROR: unsupported --mode '$MODE' (expected verify or production-seed)" >&2
  exit 2
fi

if [[ "$MODE" == "production-seed" ]]; then
  CURRENT_REV="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")"
  if [[ -z "$EXPECTED_REV" || -z "$EXPECTED_MANIFEST_SHA" ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "PRODUCTION_SEED_PINS_REQUIRED" "$REPRODUCE"
    exit 2
  fi
  if [[ ! "$EXPECTED_REV" =~ ^[0-9a-fA-F]{7,40}$ || ! "$EXPECTED_MANIFEST_SHA" =~ ^[0-9a-fA-F]{64}$ ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "PRODUCTION_SEED_PIN_FORMAT_INVALID" "$REPRODUCE"
    exit 2
  fi
  EXPECTED_REV_LOWER="${EXPECTED_REV,,}"
  EXPECTED_MANIFEST_SHA_LOWER="${EXPECTED_MANIFEST_SHA,,}"
  if [[ "${CURRENT_REV,,}" != "${EXPECTED_REV_LOWER}"* ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "PRODUCTION_SEED_REVISION_MISMATCH" "$REPRODUCE"
    exit 2
  fi
  if [[ "${ACTUAL_MANIFEST_SHA,,}" != "$EXPECTED_MANIFEST_SHA_LOWER" ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "PRODUCTION_SEED_MANIFEST_DIGEST_DRIFT" "$REPRODUCE"
    exit 2
  fi
  if [[ "${ASIMPOSIUM_PRODUCTION_SEED_CONFIRMED:-}" != "YES_PRODUCTION_SEED" || -z "${ASIMPOSIUM_SEED_FELLOW_TOKEN:-}" ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "PRODUCTION_SEED_CREDENTIALS_UNPROVISIONED" "$REPRODUCE"
    exit 78
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "PRODUCTION_DEPLOYMENT_RECONCILIATION_OPEN" "$REPRODUCE"
  exit 78
fi

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
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_SEED_CREDENTIALS_UNPROVISIONED" "$REPRODUCE"
    exit 78
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_SEED_REQUIRES_OPS3_DEPLOY" "$REPRODUCE"
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
  "$NODE_BIN" docs/seed/rungs-1-5/check.mjs
  "$NODE_BIN" --test docs/seed/rungs-1-5/check.test.mjs
  "$NODE_BIN" apps/wire/test/integration/seed-ladder-real-bindings.mjs
)

e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "SEED_LADDER_LOCAL_REAL_BINDINGS_PASS" "$REPRODUCE"
