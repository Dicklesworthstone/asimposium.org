#!/usr/bin/env bash
# W9.3a Reports, Appeals, Sponsor Strikes, & Slow Mode E2E Gate
# (bead asimposiumorg-cm5, Fable §9.1 L1/L2, §7.7, §10.2, §14.4).
#
# Modes:
#   --target local            (default) Runs W9.3a unit tests plus ALL THREE
#                             mock-free local Workerd/D1 lanes:
#                             - apps/wire/test/integration/moderation-real-bindings.mjs
#                             - apps/wire/test/integration/screening-appeals-real-bindings.mjs
#                             - apps/wire/test/integration/slow-mode-real-bindings.mjs
#                             Add --with-browser to also drive the real Chromium
#                             Agora operator-moderation/report/appeals journey.
#   --target staging          Validates staging Stoa origin (refusing production
#                             fail-closed with exit 78) and exits 78 while OPS.3
#                             staging deploy/credentials remain unprovisioned.
#   --self-test               Runs the standard diagnostic harness self-test.

set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

SUITE="e2e-reports-appeals"
REPRODUCE="bash scripts/e2e-reports-appeals.sh"
STARTED_MS="$(e2e_now_ms)"
TARGET="local"
WITH_BROWSER=0
SELF_TEST=0
WRITE_ARTIFACTS=0
EXPLICIT_RUN_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { echo "ERROR: --target requires local|staging" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    --with-browser)
      WITH_BROWSER=1
      shift
      ;;
    --self-test)
      SELF_TEST=1
      shift
      ;;
    --write-artifacts)
      WRITE_ARTIFACTS=1
      shift
      ;;
    --run-id)
      [[ $# -ge 2 ]] || { echo "ERROR: --run-id requires a value" >&2; exit 2; }
      EXPLICIT_RUN_ID="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/e2e-reports-appeals.sh [--target local|staging] [--with-browser] [--self-test] [--write-artifacts] [--run-id ID]
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$EXPLICIT_RUN_ID" ]]; then
  e2e_validate_run_id "$EXPLICIT_RUN_ID" || { echo "ERROR: invalid --run-id" >&2; exit 2; }
fi

if [[ "$SELF_TEST" -eq 1 ]]; then
  e2e_run_harness_self_test "$SUITE" "$STARTED_MS" "$REPRODUCE"
  exit 0
fi

RUN_ID="$(e2e_resolve_run_id "$SUITE" "$EXPLICIT_RUN_ID")" || { echo "ERROR: invalid run id" >&2; exit 2; }
if [[ "$WRITE_ARTIFACTS" -eq 1 ]] && ! e2e_claim_artifact_run_at_root "$REPO_ROOT" "$RUN_ID"; then
  e2e_emit_diagnostic "$SUITE" "$STARTED_MS" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$REPRODUCE"
  exit 78
fi

if [[ "$TARGET" == "staging" ]]; then
  if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
    origin_rc=$?
    if [[ "$origin_rc" -eq 2 ]]; then
      e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGENT_BASE_URL_MISSING" "$REPRODUCE --target staging"
    else
      e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "STAGING_AGENT_BASE_URL_INVALID" "$REPRODUCE --target staging"
    fi
    exit 78
  fi
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_REPORTS_APPEALS_REQUIRES_OPS3_DEPLOY" "$REPRODUCE --target staging"
  exit 78
fi

if [[ "$TARGET" != "local" ]]; then
  echo "ERROR: unsupported --target '$TARGET' (expected local or staging)" >&2
  exit 2
fi

if ! node_binary="$(e2e_select_node_runtime)"; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "GENUINE_NODE_UNAVAILABLE" "$REPRODUCE"
  exit 78
fi

cd "$REPO_ROOT" || exit 1

# 1. Unit/contract suites for report taxonomy, notice atomicity, and human appeals.
if ! bun test /dev/null --timeout=120000 \
  apps/wire/test/unit/moderation-notice-atomicity.test.ts \
  apps/wire/test/unit/moderation-targets.test.ts \
  apps/wire/test/unit/report-detail.test.ts \
  apps/wire/test/unit/report-resolution.test.ts \
  apps/wire/test/unit/screening-appeals.test.ts \
  apps/wire/test/unit/screening-appeals-http.test.ts; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "REPORTS_APPEALS_UNIT_TESTS_FAILED" "$REPRODUCE"
  exit 1
fi

# 2. Mock-free real local Workerd/D1 moderation lane (reports, sponsor dedupe, 3-sponsor auto-hide, suspension cascade).
if ! "$node_binary" apps/wire/test/integration/moderation-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "MODERATION_REAL_BINDINGS_FAILED" "$REPRODUCE"
  exit 1
fi

# 3. Mock-free real local Workerd/D1 human-only appeals lane (separate appellate authority & exact-case release).
if ! "$node_binary" apps/wire/test/integration/screening-appeals-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "SCREENING_APPEALS_REAL_BINDINGS_FAILED" "$REPRODUCE"
  exit 1
fi

# 4. Mock-free real local Workerd/D1 slow-mode lane (steward/operator caps, visible budgets, automatic expiry).
if ! "$node_binary" apps/wire/test/integration/slow-mode-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "SLOW_MODE_REAL_BINDINGS_FAILED" "$REPRODUCE"
  exit 1
fi

# 5. Optional real Chromium browser proof for /report, /console/appeals, and /admin/appeals.
if [[ "$WITH_BROWSER" -eq 1 ]]; then
  browser_status=0
  "$node_binary" e2e/playwright/agora-local-lane.mjs --build || browser_status=$?
  case "$browser_status" in
    0) ;;
    78)
      e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "REPORTS_APPEALS_BROWSER_UNAVAILABLE" "$REPRODUCE --with-browser"
      exit 78
      ;;
    *)
      e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "REPORTS_APPEALS_BROWSER_FAILED" "$REPRODUCE --with-browser"
      exit 1
      ;;
  esac
fi

e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "REPORTS_APPEALS_LOCAL_REAL_BINDINGS_PASS" "$REPRODUCE"
exit 0
