#!/usr/bin/env bash
# W10.6 Red-Team Gate (`asimposiumorg-ip3`).
#
# Runs the 6-pass permanent red-team regression & mounted Stoa security suite:
#   Pass 1: ACIP injection neutralization + /inoculation.md + A/B scorer fail-closed control
#   Pass 2: Moderation evasion thresholds (S-4 FN=0 / FP<5%) & legitimate weird-math zero-FP check
#   Pass 3: Oracle probing (ADR-18 strict opaque refusal schema; zero detector internals)
#   Pass 4: Economics (multi-Fellow per-sponsor hourly cap enforcement on real quota SQL)
#   Pass 5: Auth (prefix-identifiable secret scanning + EnrollmentService single-use replay)
#   Pass 6: Mounted createApp() + migrated D1 probes (POST /v1/reports injection, hard-reject &
#           model-outage fail-closed with 0-byte transient exposure canary across public faces &
#           search, S-6 WRONG_PRINCIPAL in all 3 directions, and zero-outbound-fetch SSRF proof)
#
# Modes:
#   --local (default): runs all local deterministic + mounted-app probes and verifies that
#                      e2e/red-team/run-inoculation-ab.ts fails closed (exit 78) without live logs.
#   --staging --bare-log <file> --inoculated-log <file>: also scores real live-probe inoculation A/B
#                      logs (exits 78 fail-closed if logs are absent; never fabricates numbers).
#
# OPS.2a safety: never logs bodies, detector patterns, raw scores, tokens, cookies, or fragments.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

MODE="local"
BARE_LOG=""
INOC_LOG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; shift ;;
    --staging) MODE="staging"; shift ;;
    --bare-log) BARE_LOG="${2:-}"; shift 2 ;;
    --inoculated-log) INOC_LOG="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: scripts/e2e-red-team.sh [--local | --staging --bare-log <json> --inoculated-log <json>]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

START_MS=$(date +%s%3N)

# 1. Execute the 6-pass permanent red-team & mounted-Stoa security suite.
(cd "${REPO_ROOT}/e2e" && bun test --timeout=60000 ./red-team/red-team.test.ts)

# 2. Verify live inoculation A/B runner fails closed (exit 78) when live probe logs are absent.
set +e
bun "${REPO_ROOT}/e2e/red-team/run-inoculation-ab.ts" >/dev/null 2>&1
FAIL_CLOSED_EXIT=$?
set -e
if [[ "${FAIL_CLOSED_EXIT}" -ne 78 ]]; then
  echo '{"type":"ops2a.red_team_gate","status":"fail","code":"W106_INOCULATION_AB_DID_NOT_FAIL_CLOSED","observed_exit":'"${FAIL_CLOSED_EXIT}"'}' >&2
  exit 1
fi

if [[ "${MODE}" == "staging" ]]; then
  if [[ -z "${BARE_LOG}" || -z "${INOC_LOG}" || ! -f "${BARE_LOG}" || ! -f "${INOC_LOG}" ]]; then
    echo '{"type":"ops2a.red_team_gate","status":"blocked","code":"RED_TEAM_LIVE_PROBE_UNCONFIGURED","detail":"--staging requires real --bare-log and --inoculated-log JSON files"}' >&2
    exit 78
  fi
  bun "${REPO_ROOT}/e2e/red-team/run-inoculation-ab.ts" --bare-log "${BARE_LOG}" --inoculated-log "${INOC_LOG}"
fi

END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))

printf '{"type":"ops2a.red_team_gate","status":"pass","code":"W106_RED_TEAM_PASS","mode":"%s","passes":6,"inoculation_ab_fail_closed_exit":%d,"duration_ms":%d,"local_only":%s,"does_not_prove":["live_workers_ai_holdout_accuracy","live_staging_inoculation_ab_probes"]}\n' \
  "${MODE}" "${FAIL_CLOSED_EXIT}" "${DURATION_MS}" "$([[ "${MODE}" == "local" ]] && echo true || echo false)"
