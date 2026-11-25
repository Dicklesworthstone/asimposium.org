#!/usr/bin/env bash
# W12.4d Data-Processor Registry & Claims-vs-Behavior Audit Gate (asimposiumorg-izl).
#
# Modes:
#   --local    (default) Runs the claims-vs-behavior & static egress-host allowlist
#              audit (`scripts/legal-claims-audit.test.ts`), synthetic private-canary
#              egress scrubbing & provider-outage proof (OPS.7 Resend native-fetch
#              transport), and never-log redaction verification (`scripts/e2e-secret-scan.sh`).
#   --staging  Fails closed (exit 78) unless non-production staging URLs and
#              synthetic canary credentials are explicitly provisioned.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"

MODE="local"
STARTED_MS="$(e2e_now_ms)"
RUN_ID="$(e2e_generated_run_id "processor-audit")"
SUITE="e2e-processor-audit"
REPRODUCE="bash scripts/e2e-processor-audit.sh"

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
      echo "Usage: bash scripts/e2e-processor-audit.sh [--local | --staging]"
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
  if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGORA_BASE_URL"; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGORA_BASE_URL_UNAVAILABLE_OR_INVALID" "$REPRODUCE --staging"
    exit 78
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_PROCESSOR_CANARY_NOT_PROVISIONED" "$REPRODUCE --staging"
  exit 78
fi

echo "==> [W12.4d 1/3] Running claims-vs-behavior, dependency & static runtime egress-host audit"
bun test --timeout=30000 scripts/legal-claims-audit.test.ts

echo "==> [W12.4d 2/3] Running synthetic egress-scrubber & provider-outage canary checks (OPS.7 email transport)"
(cd apps/wire && bun test --timeout=30000 ./test/unit/transactional-email.test.ts)

echo "==> [W12.4d 3/3] Running never-log secret-scan parity check"
bash scripts/e2e-secret-scan.sh

REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
REG_SHA="$(sha256sum docs/legal/data-processor-registry.json | awk '{print $1}')"
printf '{"facility":"OPS.2a","gate":"W124D_PROCESSOR_AUDIT_LOCAL_PASS","bead":"asimposiumorg-izl","revision":"%s","registry_sha256":"%s","mode":"local","does_not_prove":["live hosted staging Sentry/Google/Workers AI/Resend canary calls","qualified legal counsel sign-off (asimposiumorg-1wu)"]}\n' "$REV" "$REG_SHA"
e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "W124D_PROCESSOR_AUDIT_LOCAL_PASS" "$REPRODUCE"
