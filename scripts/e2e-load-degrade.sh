#!/usr/bin/env bash
# W10.7 Load Tests, Performance Budgets & Degradation-Table Fault Injection Gate
# (bead asimposiumorg-0fs).
#
# Runs:
#   1. Local deterministic fault-injection & cost-attribution matrix
#      (`e2e/load-degradation/degradation-matrix.test.ts` on real migrated SQLite/D1).
#   2. Local synthetic load benchmark (`e2e/load-degradation/load-budget-runner.ts`):
#      100-Fellow polling, 10K viral /cursor storm, local p95 budget checks, and
#      explicit W11.5 ownership for the CLI warm-startup budget (never counted green/waived).
#   3. Fail-closed negative controls proving `--live` without `--base-url` and
#      `--live --base-url https://a.asimposium.org` both refuse with exit 78.
#
# Honest scope boundary:
#   - Local mode proves deterministic local loopback p95, cache-coalescing, cost
#     attribution math, and fault-injection degradation/recovery on local bindings.
#   - Live staging mode (`--staging --base-url <url>`) probes a non-production
#     staging origin and fails closed (exit 78) when unconfigured or aimed at prod.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="local"
BASE_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; shift ;;
    --staging) MODE="staging"; shift ;;
    --base-url)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --base-url requires a non-empty value" >&2
        exit 2
      fi
      BASE_URL="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/e2e-load-degrade.sh [--local | --staging --base-url https://a-staging.asimposium.org]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

if [[ "$MODE" == "staging" ]]; then
  if [[ -n "$BASE_URL" ]]; then
    exec bun e2e/load-degradation/load-budget-runner.ts --live --base-url "$BASE_URL"
  else
    exec bun e2e/load-degradation/load-budget-runner.ts --live
  fi
fi

echo "==> [W10.7 1/3] Running fault-injection degradation matrix & cost-attribution suite"
bun test --timeout=30000 ./e2e/load-degradation/degradation-matrix.test.ts

echo "==> [W10.7 2/3] Running local deterministic load & budget benchmark (CLI startup owned by W11.5)"
REPORT_JSON="$(bun e2e/load-degradation/load-budget-runner.ts)"
echo "$REPORT_JSON" | bun -e '
  const report = JSON.parse(await new Response(Bun.stdin.stream()).text());
  if (report.environment !== "local-loopback") {
    throw new Error("Expected local-loopback environment tag");
  }
  if (!String(report.cli_startup_budget_owner || "").includes("W11.5")) {
    throw new Error("Expected explicit W11.5 ownership for CLI warm-start budget");
  }
  if (report.all_local_p95_within_fable_ceilings !== true) {
    throw new Error("Local p95 exceeded Fable section 15 ceilings");
  }
  if (report.viral_cursor_storm?.vercel_origin_reads !== 0) {
    throw new Error("Viral /cursor storm must have 0 Vercel origin reads");
  }
'

echo "==> [W10.7 3/3] Negative controls: --live fails closed without --base-url and refuses production origin"
set +e
bun e2e/load-degradation/load-budget-runner.ts --live >/dev/null 2>&1
RC_MISSING=$?
bun e2e/load-degradation/load-budget-runner.ts --live --base-url https://a.asimposium.org >/dev/null 2>&1
RC_PROD=$?
set -e

if [[ "$RC_MISSING" -ne 78 ]]; then
  echo "FAIL: --live without --base-url exited $RC_MISSING (expected 78)" >&2
  exit 1
fi
if [[ "$RC_PROD" -ne 78 ]]; then
  echo "FAIL: --live against production origin exited $RC_PROD (expected 78)" >&2
  exit 1
fi

printf '{"facility":"OPS.2a","gate":"W107_LOAD_DEGRADE_PASS","bead":"asimposiumorg-0fs","revision":"%s","mode":"local-loopback","cli_warm_start":"not-yet-applicable (owner: W11.5 / asimposiumorg-85s)","does_not_prove":["hosted Cloudflare edge TTFB","live staging D1 billing/row-read telemetry","W11.5 release-binary CLI warm-start latency"]}\n' "$REV"
echo "W107_LOAD_DEGRADE_PASS"
