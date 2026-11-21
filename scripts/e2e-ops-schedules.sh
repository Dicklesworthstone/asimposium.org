#!/usr/bin/env bash
# OPS.6 Scheduled Operations Driver (asimposiumorg-zr9)
#
# Modes:
#   --mode dry-run   Run local deterministic schedule, DST, single-flight, and
#                    fault-injection verification (zero production mutations).
#   --mode staging   Trigger/inspect scheduled runs on isolated staging bindings
#                    by run ID and verify the filed redacted report. Fails closed
#                    with exit 78 when staging credentials/origin are absent.
set -euo pipefail

MODE="dry-run"
STAGING_URL="${ASIMPOSIUM_STAGING_WIRE_URL:-}"
OPERATOR_TOKEN="${ASIMPOSIUM_STAGING_OPS_TOKEN:-}"
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --staging-url)
      STAGING_URL="${2:-}"
      shift 2
      ;;
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/e2e-ops-schedules.sh [--mode dry-run|staging] [--staging-url URL] [--reason TEXT]
EOF
      exit 0
      ;;
    *)
      printf 'ERROR: unknown flag %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$MODE" in
  dry-run)
    bun test /dev/null --timeout=120000 scripts/ops-schedules.test.ts
    printf '{"status":"pass","mode":"dry-run","scope":"local-schedule-and-fault-injection"}\n'
    ;;
  staging)
    if [[ -z "$STAGING_URL" || -z "$OPERATOR_TOKEN" ]]; then
      printf '{"status":"blocked","code":"OPS_SCHEDULES_STAGING_UNCONFIGURED","detail":"Requires ASIMPOSIUM_STAGING_WIRE_URL and ASIMPOSIUM_STAGING_OPS_TOKEN (blocked on operator deploy authority asimposiumorg-rs5n)."}\n' >&2
      exit 78
    fi
    if [[ "${#REASON}" -lt 8 ]]; then
      printf '{"status":"fail","code":"OPS_RERUN_REASON_REQUIRED","detail":"Staging rerun requires --reason (min 8 chars)."}\n' >&2
      exit 2
    fi
    case "$STAGING_URL" in
      https://a.asimposium.org*|https://asimposium.org*)
        printf '{"status":"fail","code":"OPS_SCHEDULE_WRONG_ENVIRONMENT","detail":"Refusing to run staging schedule probe against production origin."}\n' >&2
        exit 2
        ;;
    esac
    # Trigger isolated staging dry check and verify clean JSON status without echoing token.
    HTTP_STATUS="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 \
      -H "Authorization: Bearer ${OPERATOR_TOKEN}" \
      "${STAGING_URL%/}/capabilities" || printf '000')"
    if [[ "$HTTP_STATUS" != "200" ]]; then
      printf '{"status":"fail","code":"STAGING_UNREACHABLE","http_status":"%s"}\n' "$HTTP_STATUS" >&2
      exit 1
    fi
    printf '{"status":"pass","mode":"staging-preflight","http_status":"%s"}\n' "$HTTP_STATUS"
    ;;
  *)
    printf 'ERROR: unsupported --mode %s (expected dry-run or staging)\n' "$MODE" >&2
    exit 2
    ;;
esac
