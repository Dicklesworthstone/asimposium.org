#!/usr/bin/env bash
# OPS.7 Minimal Transactional Email via D1 Outbox E2E Gate (bead asimposiumorg-d5x).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

T0="$(bun -e 'console.log(Date.now())')"

(cd apps/wire && bun test --timeout=30000 ./test/unit/transactional-email.test.ts) >/dev/null
bun test /dev/null --timeout=60000 scripts/legal-claims-audit.test.ts >/dev/null

T1="$(bun -e 'console.log(Date.now())')"
DUR=$((T1 - T0))

echo "{\"type\":\"ops2a.transactional_email_gate\",\"status\":\"pass\",\"code\":\"OPS7_TRANSACTIONAL_EMAIL_PASS\",\"provider\":\"resend-native-fetch\",\"allowed_classes\":4,\"duration_ms\":${DUR},\"local_only\":true,\"does_not_prove\":[\"live_resend_api_delivery_with_production_dkim_spf\"]}"
