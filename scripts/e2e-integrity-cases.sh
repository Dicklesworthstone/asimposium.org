#!/usr/bin/env bash
# W9.3c Scientific-Integrity Cases, Neutral Notices, & Correction Linkage E2E Gate
# (bead asimposiumorg-bum, Fable §9.1 & §14.4).
#
# Modes:
#   --target local            (default) Runs W9.3c classification matrix, conflict-of-
#                             interest, human-only sponsor response/appeal, neutral-notice,
#                             minimization, and OPS.2a redaction unit suites PLUS mock-free
#                             local Workerd/D1 moderation & retraction/correction lanes:
#                             - apps/wire/test/integration/questions-retractions-real-bindings.mjs
#                             - apps/wire/test/integration/moderation-real-bindings.mjs
#   --target staging          Validates staging Stoa origin (refusing production fail-closed
#                             with exit 78) and exits 78 while OPS.3 staging deploy remains open.
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

SUITE="e2e-integrity-cases"
REPRODUCE="bash scripts/e2e-integrity-cases.sh"
STARTED_MS="$(e2e_now_ms)"
TARGET="local"
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
Usage: bash scripts/e2e-integrity-cases.sh [--target local|staging] [--self-test] [--write-artifacts] [--run-id ID]
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
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_INTEGRITY_CASES_REQUIRES_OPS3_DEPLOY" "$REPRODUCE --target staging"
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

# 1. W9.3c scientific-integrity classification, conflict, notice, minimization & OPS.2a suite.
if ! bun test /dev/null --timeout=120000 \
  apps/wire/test/unit/integrity-cases.test.ts \
  apps/wire/test/unit/report-detail.test.ts \
  apps/wire/test/unit/report-resolution.test.ts; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "INTEGRITY_CASES_UNIT_TESTS_FAILED" "$REPRODUCE"
  exit 1
fi

# 2. Mock-free real local Workerd/D1 immutable retraction & correction linkage lane.
if ! "$node_binary" apps/wire/test/integration/questions-retractions-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "RETRACTIONS_REAL_BINDINGS_FAILED" "$REPRODUCE"
  exit 1
fi

# 3. Mock-free real local Workerd/D1 content-control hide/restore & strike-cascade lane.
if ! "$node_binary" apps/wire/test/integration/moderation-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "fail" "MODERATION_REAL_BINDINGS_FAILED" "$REPRODUCE"
  exit 1
fi

e2e_emit_and_optionally_record "$WRITE_ARTIFACTS" "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "INTEGRITY_CASES_LOCAL_REAL_BINDINGS_PASS" "$REPRODUCE"
exit 0
