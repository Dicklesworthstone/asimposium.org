#!/usr/bin/env bash
# S-6 cross-plane auth, live preview spike (bead asimposiumorg-vw3).
#
# This script proves the seam against REAL infrastructure: a Vercel preview
# running Auth.js with Google, and a deployed Worker with real bindings. It
# asserts, in one run:
#
#   1. a Google sign-in issues a HOST-ONLY session cookie on the apex
#      (no Domain= attribute; the agent host must never see human sessions);
#   2. a sponsor write leaves as a signed service envelope and the Worker
#      attributes the resulting event to the human;
#   3. WRONG_PRINCIPAL in both directions: a bearer on a sponsor route, and a
#      cookie on the agent host;
#   4. replay, altered payload and expired envelope are each refused.
#
# It is BLOCKED until that infrastructure exists, and it says so rather than
# pretending. There is deliberately no offline mode, no fixture mode and no
# "simulated" pass: a mock presented as runtime proof is the specific dishonesty
# this spike exists to avoid. Exit 78 (EX_CONFIG) means "blocked, nothing ran";
# exit 1 means the spike ran and something failed.
#
# Required environment (all absent today):
#   ASIMP_S6_PREVIEW_URL      https://<preview>.vercel.app   (Agora, apex plane)
#   ASIMP_S6_WORKER_URL       https://<preview-worker>       (Stoa, agent plane)
#   ASIMP_S6_TEST_GOOGLE_USER Google test-account email for the Auth.js login
#   ASIMP_S6_TEST_GOOGLE_PASS its password, from the operator secret store
#   ASIMP_S6_FELLOW_TOKEN     a Fellow bearer, for the bearer-on-sponsor case
#   ASIMP_S6_SIGNING_KEY_JWK  Ed25519 private key JWK for envelope minting
#   ASIMP_S6_SIGNING_KID      the matching non-secret key id
#
# Evidence: a redacted JSON bundle at the path in ASIMP_S6_EVIDENCE_DIR. It
# records revision, deployment id, non-secret kid, action, payload digest
# prefix, pseudonymous principal, route template, status, code and latency.
# It never records cookies, OAuth artifacts, bearer tokens, signatures, join
# fragments, payload bodies, screenshots or raw browser traces.

set -euo pipefail

readonly EX_CONFIG=78
readonly EX_FAIL=1

readonly REQUIRED_VARS=(
  ASIMP_S6_PREVIEW_URL
  ASIMP_S6_WORKER_URL
  ASIMP_S6_TEST_GOOGLE_USER
  ASIMP_S6_TEST_GOOGLE_PASS
  ASIMP_S6_FELLOW_TOKEN
  ASIMP_S6_SIGNING_KEY_JWK
  ASIMP_S6_SIGNING_KID
)

log() { printf '%s\n' "$*" >&2; }

# Never print a value: only whether it was set. The names are safe, the
# contents are on the never-log list (Fable §14.3).
missing_vars() {
  local name
  for name in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!name:-}" ]]; then printf '%s\n' "$name"; fi
  done
}

emit_blocked_record() {
  local missing_csv="$1"
  # One machine-readable line, same shape as the other suite runners.
  printf '{"suite":"s6-cross-plane-auth","status":"blocked","code":"PREVIEW_NOT_PROVISIONED",'
  printf '"bead":"asimposiumorg-vw3","missing_env":[%s],' "$missing_csv"
  printf '"blocked_on":"a Vercel preview deployment with Auth.js Google credentials and a deployed Worker with real bindings (OPS.3 environments, W3 Propylon)",'
  printf '"forbidden_substitutes":"a mocked Worker or stubbed Auth.js presented as runtime proof; the in-process unit vectors relabelled as a live run; a hand-written transcript; a recorded fixture replayed as a deployment",'
  printf '"unit_coverage":"apps/wire/test/unit/service-envelope.test.ts, apps/wire/test/unit/principal-routing.test.ts, apps/wire/test/security/cross-plane-refusals.test.ts, apps/web/test/unit/service-envelope.test.ts"}\n'
}

main() {
  local missing
  mapfile -t missing < <(missing_vars)

  if (( ${#missing[@]} > 0 )); then
    local csv=""
    local name
    for name in "${missing[@]}"; do
      csv+="${csv:+,}\"${name}\""
    done
    emit_blocked_record "$csv"

    log "BLOCKED s6-cross-plane-auth: the live spike has no infrastructure to run against."
    log "  missing environment: ${missing[*]}"
    log "  blocked on: a Vercel preview with Auth.js Google credentials, and a deployed"
    log "              Worker with real D1/R2 bindings (OPS.3 environments, W3 Propylon)."
    log "  this script has no offline or fixture mode on purpose: the whole point of S-6"
    log "  is a claim about running infrastructure, and a mock cannot make that claim."
    log "  what IS proven today, in process and without a deployment:"
    log "    envelope canonicalization, signature, expiry, replay, tamper, key rotation,"
    log "    principal routing and disclosure discipline — see the unit suites named in"
    log "    the JSON record above. None of them prove cookie scoping or Google sign-in."
    exit "$EX_CONFIG"
  fi

  log "s6-cross-plane-auth: environment present; running the live spike."
  log "FATAL: the live spike body is not implemented yet."
  log "  Provisioning the preview is the blocker that gates writing it; implementing"
  log "  assertions against infrastructure nobody has seen would be guesswork wearing"
  log "  the costume of a test. This branch exists so the script fails loudly rather"
  log "  than reporting success the moment the variables appear."
  exit "$EX_FAIL"
}

main "$@"
