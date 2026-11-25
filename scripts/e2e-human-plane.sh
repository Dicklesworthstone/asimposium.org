#!/usr/bin/env bash
# W10.8 Human-Plane Playwright E2E + Cache-Leak Paired Tests (asimposiumorg-3zn).
#
# Modes:
#   --target local            Runs the W10.8 guard, redaction, planted-negative,
#                             gallery-runner, target-surfaces, and console-leak
#                             verification suites locally (add --with-browser to
#                             also drive `e2e/playwright/agora-local-lane.mjs`).
#   --target staging          (default) Enforces fail-closed staging origin &
#                             production refusal (exit 78), verifies designated
#                             Google test sponsor credentials are provisioned, and
#                             chains `scripts/smoke-gallery.sh` + `e2e/run-playwright.sh`.

set -euo pipefail
set +x
unset DEBUG PWDEBUG

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"

TARGET="staging"
WITH_BROWSER=0
STARTED_MS="$(e2e_now_ms)"
RUN_ID="$(e2e_generated_run_id "human-plane")"
SUITE="e2e-human-plane"
REPRODUCE="bash scripts/e2e-human-plane.sh"

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
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/e2e-human-plane.sh [--target local|staging] [--with-browser]
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$TARGET" == "local" ]]; then
  (
    cd "${REPO_ROOT}/e2e"
    bash tests/gallery-console-leak-check.test.sh
    bun test /dev/null --timeout=120000 \
      playwright/human-plane-guards.test.ts \
      tests/gallery-runner.test.ts
  )
  if [[ "$WITH_BROWSER" -eq 1 ]]; then
    NODE_BIN="$(e2e_select_node_runtime)" || {
      e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "GENUINE_NODE_UNAVAILABLE" "$REPRODUCE --target local --with-browser"
      exit 78
    }
    CHROMIUM_EXE="${ASIMPOSIUM_CHROMIUM_EXECUTABLE:-${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}}"
    if ! (cd "$REPO_ROOT" && CHROMIUM_EXE="$CHROMIUM_EXE" "$NODE_BIN" -e 'const fs = require("node:fs"); const { chromium } = require("./e2e/node_modules/@playwright/test"); const exe = process.env.CHROMIUM_EXE || chromium.executablePath(); process.exit(exe && fs.existsSync(exe) ? 0 : 1);') 2>/dev/null; then
      e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "PLAYWRIGHT_CHROMIUM_UNAVAILABLE" "$REPRODUCE --target local --with-browser"
      exit 78
    fi
    if [[ -n "$CHROMIUM_EXE" ]]; then
      (cd "${REPO_ROOT}/e2e" && ASIMPOSIUM_CHROMIUM_EXECUTABLE="$CHROMIUM_EXE" bun test /dev/null --timeout=360000 playwright/target-surfaces.test.ts)
      (cd "$REPO_ROOT" && ASIMPOSIUM_CHROMIUM_EXECUTABLE="$CHROMIUM_EXE" "$NODE_BIN" e2e/playwright/agora-local-lane.mjs)
    else
      (cd "${REPO_ROOT}/e2e" && bun test /dev/null --timeout=360000 playwright/target-surfaces.test.ts)
      (cd "$REPO_ROOT" && "$NODE_BIN" e2e/playwright/agora-local-lane.mjs)
    fi
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "HUMAN_PLANE_LOCAL_GUARDS_PASS" "$REPRODUCE --target local"
  exit 0
fi

if [[ "$TARGET" != "staging" ]]; then
  echo "ERROR: unsupported --target '$TARGET' (expected local or staging)" >&2
  exit 2
fi

# Staging target: refuse production origins fail-closed with exit 78.
if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGORA_BASE_URL"; then
  origin_rc=$?
  if [[ "$origin_rc" -eq 2 ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGORA_BASE_URL_MISSING" "$REPRODUCE"
  else
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "STAGING_AGORA_BASE_URL_INVALID" "$REPRODUCE"
  fi
  exit 78
fi

if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
  origin_rc=$?
  if [[ "$origin_rc" -eq 2 ]]; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGENT_BASE_URL_MISSING" "$REPRODUCE"
  else
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "STAGING_AGENT_BASE_URL_INVALID" "$REPRODUCE"
  fi
  exit 78
fi

if [[ -z "${ASIMPOSIUM_GALLERY_GOOGLE_USER:-}" || -z "${ASIMPOSIUM_GALLERY_SECOND_GOOGLE_USER:-}" ]]; then
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_GOOGLE_TEST_USERS_UNPROVISIONED" "$REPRODUCE"
  exit 78
fi

# Run both paired two-sponsor gallery checks and real Chromium staging surface suite.
bash "${REPO_ROOT}/scripts/smoke-gallery.sh"
bash "${REPO_ROOT}/e2e/run-playwright.sh"

e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "HUMAN_PLANE_STAGING_PASS" "$REPRODUCE"
