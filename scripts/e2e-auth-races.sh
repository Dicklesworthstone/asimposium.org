#!/usr/bin/env bash
# W10.4 Auth Race Matrix Gate on Real Local Workerd/D1 Stack (bead asimposiumorg-ana).
#
# Runs `apps/wire/test/integration/auth-race-matrix-real-bindings.mjs` against the
# compiled Worker inside local Workerd with real migrated Cloudflare D1 bindings:
#   1. Simultaneous double-exchange of one join URL (exactly one 202 wins; SHA-256 at rest)
#   2. Independent 30m join-secret TTL vs 24h proposal TTL & expiry-vs-approval race
#   3. Sponsor credential revocation racing in-flight Fellow write (zero grace window)
#   4. Approval-page double-POST & cross-sponsor refusal (exactly one credential row)
#   5. Device flow RFC 8628 slow_down, bare proposal-ID rejection, query-string refusal
#   6. One-time response-loss / concurrent POST /v1/fellows/flow issuance (hash-only D1)
#   7. Bidirectional WRONG_PRINCIPAL (Fellow bearer on sponsor route; browser cookie on Stoa)
#   8. Zero secret leakage across captured Workerd logs and persistent D1 rows
#
# Honest scope boundary:
#   - Local mode proves all 8 auth races against real compiled Workerd + migrated D1.
#   - Staging mode (`--staging`) fails closed (exit 78) when live staging URL/creds are absent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="local"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; shift ;;
    --staging) MODE="staging"; shift ;;
    -h|--help)
      echo "Usage: scripts/e2e-auth-races.sh [--local | --staging]"
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
  echo '{"facility":"OPS.2a","gate":"W104_AUTH_RACES_BLOCKED","code":"AUTH_RACES_STAGING_UNCONFIGURED","detail":"Mock-free staging auth race execution requires deployed staging bindings and operator deploy authority (asimposiumorg-rs5n)."}' >&2
  exit 78
fi

echo "==> [W10.4] Running real-bindings Workerd + D1 auth race matrix"
node apps/wire/test/integration/auth-race-matrix-real-bindings.mjs

printf '{"facility":"OPS.2a","gate":"W104_AUTH_RACES_PASS","bead":"asimposiumorg-ana","revision":"%s","mode":"local-workerd-d1","does_not_prove":["live hosted staging deployment","live Google OAuth step-up latency"]}\n' "$REV"
echo "W104_AUTH_RACES_PASS"
