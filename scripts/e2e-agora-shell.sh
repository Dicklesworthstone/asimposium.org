#!/usr/bin/env bash
# Agora Shell, Design System Tokens, Sitemaps, CSP & Diptych Fallback E2E Gate (W8.1, bead asimposiumorg-mbp).
# Proves:
# 1. Design tokens & scientific instrument palette:
#    - Light theme paper (#f7f2e8) & ink (#1f1b16) ratio >= 7.0 (AAA)
#    - Dark theme paper (#14110e) & ink (#e9e1d2) ratio >= 7.0 (AAA)
#    - prefers-reduced-motion: reduce and forced-colors: active CSS rules
# 2. Status presentation doctrine (Rule A4 & WCAG 2.2 AA):
#    - Status is never conveyed by color alone: distinct shape/symbol + text label
#    - Strongest scientific status is strongly-supported
# 3. KaTeX trust mode off & copyable LaTeX math presentation:
#    - MathFormula with role="group" and role="math"
#    - Copyable LaTeX affordance (aria-label="Copy LaTeX formula")
#    - KaTeX trust strictly false
# 4. Accessible tabular fallbacks for graphs:
#    - AccessibleGraphTable provides <caption>, <th scope="col">, <th scope="row">
#    - Screen reader and non-JS accessible
# 5. Semantic landmarks & keyboard navigation:
#    - Skip-to-content accessible link
#    - Semantic landmarks (main, header, nav, footer)
# 6. Partitioned sitemaps & robots exclusions:
#    - Sitemaps generate core discovery routes
#    - Strictly exclude private/auth/admin/moderation routes
#    - Robots disallows private/auth routes and links to sitemap
# 7. Scholarly structured metadata & Rule A4 honesty:
#    - buildScholarlyMetadata and buildScholarlyJsonLd
#    - Strict refusal of forbidden resolution language ("proved", "solved")
#    - Strict refusal of invented journal credentials
# 8. Generic Diptych HTML fallback route:
#    - Consumes shared renderHtmlFragmentFace
#    - Preserves canonical status, attribution, version, and Diptych links
# 9. Strict Content Security Policy (Fable §14.3):
#    - default-src 'self', frame-ancestors 'none', object-src 'none'
#    - nosniff, DENY, strict-origin-when-cross-origin
# 10. Privacy & OPS.2a diagnostic logging: never leaks credentials or private bodies.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-agora-shell"
reproduce="bash scripts/e2e-agora-shell.sh"
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""

usage_failure() {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 64
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=1
      ;;
    --write-artifacts)
      write_artifacts=1
      ;;
    --run-id)
      [[ "$#" -ge 2 ]] || usage_failure "RUN_ID_MISSING"
      if [[ "$2" == --* || -z "$2" ]]; then
        usage_failure "RUN_ID_MISSING"
      fi
      explicit_run_id="$2"
      shift
      ;;
    *)
      usage_failure "UNKNOWN_ARGUMENT"
      ;;
  esac
  shift
done

if [[ -n "$explicit_run_id" ]]; then
  e2e_validate_run_id "$explicit_run_id" || usage_failure "RUN_ID_INVALID"
fi

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || usage_failure "RUN_ID_INVALID"
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

cd "$repository_root" || exit 1

# 1. Run Agora shell & design system unit tests in apps/web
if ! bun test apps/web/test/unit/agora-shell.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGORA_SHELL_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run Agora shell E2E suite with OPS.2a diagnostic logging
if ! bun run scripts/suite/agora-shell-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGORA_SHELL_E2E_SUITE_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
