#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="smoke-gallery"
reproduce="scripts/smoke-gallery.sh --self-test"
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
console_anonymous="$(e2e_curl --silent --max-time 15 "$ASIMPOSIUM_STAGING_AGORA_BASE_URL/console" 2>/dev/null)"
if ! printf '%s' "$console_anonymous" | python3 -c '
import sys, re
html = sys.stdin.read()
if not re.search(r"sign in|google|authenticate", html, re.I):
    sys.exit(1)  # no sign-in prompt for an anonymous visitor
# A Fellow/workshop object id or a proposal id in the anonymous console is a leak.
if re.search(r"\bF-[0-9A-Z]|\bW-[a-z]|ASIMP-EN-|usr_", html):
    sys.exit(2)
sys.exit(0)
' 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "GALLERY_CONSOLE_LEAKS_ANONYMOUSLY" "$reproduce"
  exit 89
fi

# The authenticated sponsor + anonymous-public comparison belongs to W3. This
# entry point deliberately refuses to claim that a workshop/private-cache test
# has passed until the staging flow and test principals exist.
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "GALLERY_PRODUCT_FLOW_NOT_IMPLEMENTED" "$reproduce"
exit 70
