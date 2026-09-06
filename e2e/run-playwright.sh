#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="playwright-target-surfaces"
reproduce="bash e2e/run-playwright.sh"
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=1
      ;;
    --write-artifacts)
      write_artifacts=1
      ;;
    --run-id)
      [[ "$#" -ge 2 ]] || {
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_MISSING" "$reproduce"
        exit 64
      }
      if [[ "$2" == --* || -z "$2" ]]; then
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_MISSING" "$reproduce"
        exit 64
      fi
      explicit_run_id="$2"
      shift
      ;;
    *)
      e2e_emit_diagnostic "$suite" "$started_ms" "fail" "UNKNOWN_ARGUMENT" "$reproduce"
      exit 64
      ;;
  esac
  shift
done

if [[ -n "$explicit_run_id" ]]; then
  e2e_validate_run_id "$explicit_run_id" || {
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
    exit 64
  }
fi

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce --self-test"
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
  exit 64
}
for origin_variable in ASIMPOSIUM_STAGING_AGENT_BASE_URL ASIMPOSIUM_STAGING_AGORA_BASE_URL; do
  if e2e_validate_staging_origin "$origin_variable"; then
    :
  else
    origin_status=$?
    case "$origin_status" in
      2) code="STAGING_SURFACE_BASE_URL_MISSING" ;;
      *) code="STAGING_SURFACE_BASE_URL_INVALID" ;;
    esac
    e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "$code" "$reproduce"
    exit 78
  fi
done

if ! command -v node >/dev/null 2>&1; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "PLAYWRIGHT_NODE_UNAVAILABLE" "$reproduce"
  exit 78
fi
# Playwright writes failure output even when the caller does not request the
# shell diagnostic JSONL. Claim its fresh namespace after write-free preflight
# and before launch so Playwright may clean only its new run-scoped child.
if ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi
if ! e2e_select_artifact_claim_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_CLAIM_INVALID" "$reproduce"
  exit 78
fi

playwright_cli="$repository_root/e2e/node_modules/@playwright/test/cli.js"
if [[ ! -f "$playwright_cli" ]]; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "PLAYWRIGHT_DEPENDENCY_UNAVAILABLE" "$reproduce"
  exit 78
fi
# Do not execute even a runtime probe until the fresh artifact claim is proven.
playwright_node="$(e2e_select_node_runtime)" || {
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "PLAYWRIGHT_NODE_UNAVAILABLE" "$reproduce"
  exit 78
}

cd "$repository_root/e2e"
set +e
ASIMPOSIUM_PLAYWRIGHT_ENTRY=1 \
  ASIMPOSIUM_PLAYWRIGHT_REPOSITORY_ROOT="$repository_root" \
  ASIMPOSIUM_PLAYWRIGHT_RUN_ID="$run_id" \
  ASIMPOSIUM_PLAYWRIGHT_ARTIFACT_ROOT_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY" \
  ASIMPOSIUM_PLAYWRIGHT_RUN_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY" \
  ASIMPOSIUM_PLAYWRIGHT_LEASE_DIRECTORY="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY" \
  ASIMPOSIUM_PLAYWRIGHT_LEASE_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY" \
  "$playwright_node" "$playwright_cli" test --config playwright.config.ts
playwright_status=$?
set -e

if [[ "$playwright_status" -ne 0 ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "PLAYWRIGHT_TARGET_SURFACE_CHECK_FAILED" "$reproduce"
  exit "$playwright_status"
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "PLAYWRIGHT_ENTRY_SURFACES_GREEN_PRODUCT_FLOWS_NOT_CLAIMED" "$reproduce"
