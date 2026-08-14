#!/usr/bin/env bash
# S-4 production-configuration dry check. This script neither changes OAuth
# configuration nor calls a cloud console. A missing Workers AI staging route
# is BLOCKED, never a simulated pass.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ "${1:-}" == "--self-test" ]]; then
  cd "${REPO_ROOT}"
  bun e2e/screening/s4-runner.ts self-test
  bun test e2e/screening/s4-runner.test.ts
  exit 0
fi

if [[ $# -ne 0 ]]; then
  printf '%s\n' 'usage: scripts/e2e-s4-screening-oauth.sh [--self-test]' >&2
  exit 64
fi

cd "${REPO_ROOT}"
set +e
bun e2e/screening/s4-runner.ts live
readonly runner_status=$?
set -e

case "${runner_status}" in
  0)
    printf '%s\n' '{"suite":"s4-screening-oauth","status":"pass","code":"S4_STAGING_DRY_CHECK_GREEN","detail":"staging screening and production configuration dry-check completed"}'
    ;;
  78)
    printf '%s\n' '{"suite":"s4-screening-oauth","status":"blocked","code":"WORKERS_AI_STAGING_UNAVAILABLE_OR_NOT_CONFIGURED","detail":"no live staging evidence; no provider behavior was simulated"}'
    ;;
  *)
    printf '%s\n' '{"suite":"s4-screening-oauth","status":"fail","code":"S4_LIVE_SCREENING_OR_OAUTH_DRY_CHECK_FAILED","detail":"inspect the preceding secret-safe runner diagnostics"}'
    ;;
esac

exit "${runner_status}"
