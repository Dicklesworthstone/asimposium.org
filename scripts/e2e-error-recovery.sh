#!/usr/bin/env bash
# W10.9 Error-Copy Audit, Cold-Agent Recovery & Ceremony Regression Gate
# (bead asimposiumorg-m5s).
#
# Modes:
#   --local    (default) Runs:
#              1. Contract/opaque partition, ADR-18 oracle starvation, colleague-voice
#                 snapshot audit, and served-text slop scrub (`scripts/error-copy-audit.test.ts`).
#              2. Live mounted-Stoa HTTP 400/401/403/404/409/422/429/503 cold-agent
#                 recovery & oracle-starvation probe (`e2e/error-copy-audit/error-recovery.test.ts`).
#              3. R-22 ceremony trend CLI positive & fail-closed controls
#                 (`scripts/ceremony-trend-check.ts`).
#   --staging  Fails closed (exit 78) until a non-production staging target is
#              configured and provisioned.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"

MODE="local"
STARTED_MS="$(e2e_now_ms)"
RUN_ID="$(e2e_generated_run_id "error-recovery")"
SUITE="e2e-error-recovery"
REPRODUCE="bash scripts/e2e-error-recovery.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)
      MODE="local"
      shift
      ;;
    --staging)
      MODE="staging"
      shift
      ;;
    -h|--help)
      echo "Usage: bash scripts/e2e-error-recovery.sh [--local | --staging]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

cd "$REPO_ROOT"

if [[ "$MODE" == "staging" ]]; then
  if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGENT_BASE_URL_UNAVAILABLE_OR_INVALID" "$REPRODUCE --staging"
    exit 78
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_ERROR_RECOVERY_NOT_PROVISIONED" "$REPRODUCE --staging"
  exit 78
fi

echo "==> [W10.9 1/3] Running error dictionary, ADR-18 oracle starvation & slop-scrub audit"
bun test --timeout=30000 scripts/error-copy-audit.test.ts

echo "==> [W10.9 2/3] Running live mounted-Stoa 400/401/403/404/409/422/429/503 recovery probe"
bun test --timeout=30000 e2e/error-copy-audit/error-recovery.test.ts

echo "==> [W10.9 3/3] Verifying R-22 ceremony-trend CLI fail-closed & budget controls"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-ceremony-check.XXXXXX")"
# Empty receipt set must exit 78 (no-receipts), never fabricate green.
empty_rc=0
bun scripts/ceremony-trend-check.ts >/dev/null 2>&1 || empty_rc=$?
if [[ "$empty_rc" -ne 78 ]]; then
  echo "ERROR: ceremony-trend-check.ts with no receipts exited ${empty_rc}, expected 78" >&2
  exit 1
fi
cat >"${SCRATCH}/r1.json" <<'JSON'
{"run_id":"ctrl-1","recorded_at":"2026-11-20T00:00:00Z","tokens_to_first_valid_post":22000}
JSON
cat >"${SCRATCH}/r2.json" <<'JSON'
{"run_id":"ctrl-2","recorded_at":"2026-11-21T00:00:00Z","tokens_to_first_valid_post":18500}
JSON
cat >"${SCRATCH}/over.json" <<'JSON'
{"run_id":"ctrl-over","recorded_at":"2026-11-22T00:00:00Z","tokens_to_first_valid_post":45000}
JSON
bun scripts/ceremony-trend-check.ts --receipts "${SCRATCH}/r1.json" "${SCRATCH}/r2.json" >/dev/null
over_rc=0
bun scripts/ceremony-trend-check.ts --receipts "${SCRATCH}/over.json" >/dev/null 2>&1 || over_rc=$?
if [[ "$over_rc" -ne 1 ]]; then
  echo "ERROR: ceremony-trend-check.ts over-budget control exited ${over_rc}, expected 1" >&2
  exit 1
fi

REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '{"facility":"OPS.2a","gate":"W109_ERROR_RECOVERY_LOCAL_PASS","bead":"asimposiumorg-m5s","revision":"%s","mode":"local","status_classes_verified":[400,401,403,404,409,422,429,503],"does_not_prove":["live multi-harness staging cold-agent gauntlet (zai)","hosted Workers AI screening oracle behavior (xeg)"]}\n' "$REV"
e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "W109_ERROR_RECOVERY_LOCAL_PASS" "$REPRODUCE"
