#!/usr/bin/env bash
set -euo pipefail
set +x
unset DEBUG PWDEBUG

gallery_user="${ASIMPOSIUM_GALLERY_GOOGLE_USER:-}"
gallery_password="${ASIMPOSIUM_GALLERY_GOOGLE_PASSWORD:-}"
gallery_second_user="${ASIMPOSIUM_GALLERY_SECOND_GOOGLE_USER:-}"
gallery_second_password="${ASIMPOSIUM_GALLERY_SECOND_GOOGLE_PASSWORD:-}"
export -n gallery_user gallery_password gallery_second_user gallery_second_password
unset ASIMPOSIUM_GALLERY_GOOGLE_USER ASIMPOSIUM_GALLERY_GOOGLE_PASSWORD
unset ASIMPOSIUM_GALLERY_SECOND_GOOGLE_USER ASIMPOSIUM_GALLERY_SECOND_GOOGLE_PASSWORD

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="smoke-gallery"
# Supply ASIMPOSIUM_STAGING_AGORA_BASE_URL separately; never copy its value
# or any sponsor credential into the diagnostic reproduction command.
reproduce="scripts/smoke-gallery.sh"
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

if [[ "$self_test" -eq 1 ]]; then
  reproduce="$reproduce --self-test"
fi

if [[ -n "$explicit_run_id" ]]; then
  e2e_validate_run_id "$explicit_run_id" || {
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
    exit 64
  }
fi

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
  exit 64
}
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

if e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGORA_BASE_URL"; then
  :
else
  origin_status=$?
  case "$origin_status" in
    2) code="STAGING_AGORA_BASE_URL_MISSING" ;;
    *) code="STAGING_AGORA_BASE_URL_INVALID" ;;
  esac
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$code" "$reproduce"
  exit 78
fi

if ! e2e_probe_public_path "$ASIMPOSIUM_STAGING_AGORA_BASE_URL" "/"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGORA_PUBLIC_SURFACE_UNAVAILABLE" "$reproduce"
  exit 69
fi

# The sponsor flow's entry point: /approve must render for an anonymous
# visitor (it shows the Google sign-in prompt; authentication happens through
# the form action). A 404/5xx here means the approval surface regressed
# before any sponsor could ever reach it.
if ! e2e_probe_public_path "$ASIMPOSIUM_STAGING_AGORA_BASE_URL" "/approve"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "GALLERY_APPROVE_SURFACE_UNAVAILABLE" "$reproduce"
  exit 69
fi

# S-3/S-6 sponsor boundary (anonymous side): the console must present a sign-in
# prompt to an anonymous visitor and carry no sponsor data (no Fellow names,
# workshop objects, or proposals). The product copy may describe the workshop;
# it must never render one.
if ! console_anonymous="$(e2e_curl --silent --max-time 15 "$ASIMPOSIUM_STAGING_AGORA_BASE_URL/console" 2>/dev/null)"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "GALLERY_CONSOLE_SURFACE_UNAVAILABLE" "$reproduce"
  exit 69
fi
# The leak assertion lives in scripts/gallery-console-leak-check.py so it can be
# driven against seeded fixtures without a staging origin. Exit 0 = safe,
# 1 = no sign-in prompt, 2 = a sponsor-scoped identifier leaked anonymously.
if ! printf '%s' "$console_anonymous" \
  | python3 "$repository_root/scripts/gallery-console-leak-check.py" 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "GALLERY_CONSOLE_LEAKS_ANONYMOUSLY" "$reproduce"
  exit 89
fi

if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GALLERY_AGENT_ORIGIN_UNAVAILABLE" "$reproduce"
  exit 78
fi
if [[ -z "$gallery_user" || -z "$gallery_password" || -z "$gallery_second_user" || -z "$gallery_second_password" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GALLERY_GOOGLE_TEST_ACCOUNTS_MISSING" "$reproduce"
  exit 78
fi
if [[ -z "${ASIMPOSIUM_GALLERY_PROBLEM_ID:-}" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GALLERY_PROBLEM_ID_MISSING" "$reproduce"
  exit 78
fi
if ! command -v bun >/dev/null 2>&1; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "GALLERY_BUN_UNAVAILABLE" "$reproduce"
  exit 78
fi

set +e
printf '%s\0' "$ASIMPOSIUM_STAGING_AGORA_BASE_URL" "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" \
  "$ASIMPOSIUM_GALLERY_PROBLEM_ID" "$run_id" \
  "$gallery_user" "$gallery_password" "$gallery_second_user" "$gallery_second_password" \
  | python3 -c '
import json, sys
parts = sys.stdin.buffer.read().split(b"\0")
if len(parts) != 9 or parts[-1] != b"":
    sys.exit(64)
keys = ["agoraOrigin", "workerOrigin", "problemId", "runId",
        "user", "password", "secondUser", "secondPassword"]
try:
    payload = dict(zip(keys, (value.decode("utf-8") for value in parts[:-1])))
except UnicodeError:
    sys.exit(64)
sys.stdout.write(json.dumps(payload))
' | bun "$repository_root/e2e/playwright/gallery-runner.ts"
gallery_status=$?
set -e
case "$gallery_status" in
  0) gallery_state="pass"; gallery_code="GALLERY_PRODUCT_FLOW_GREEN" ;;
  78) gallery_state="blocked"; gallery_code="GALLERY_PREREQUISITE_UNAVAILABLE" ;;
  *) gallery_state="fail"; gallery_code="GALLERY_PRODUCT_FLOW_FAILED" ;;
esac
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "$gallery_state" "$gallery_code" "$reproduce"
exit "$gallery_status"
