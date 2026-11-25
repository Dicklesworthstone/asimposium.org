#!/usr/bin/env bash
# W7.3 Agent Long-Poll E2E Gate (bead asimposiumorg-4ww).
#
# Runs unit/route tests for event-tail long-poll AND executes a real curl
# session against the live Hono Worker + migrated local D1 verifying:
#   - immediate return on available events
#   - early return on concurrent event arrival
#   - timeout page_end with unchanged cursor + Retry-After + private, no-store
#   - client disconnect cleanup + duplicate/skip-free resume
#   - wait > 25 refusal (400 CURSOR_INVALID)
#   - OPS.2a log hygiene (0 auth tokens, event bodies, or workshop bytes logged)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

(cd apps/wire && bun test --timeout=30000 ./test/unit/event-tail-wait.test.ts ./test/unit/event-tail-http.test.ts ./test/unit/event-tail-routes.test.ts) >/dev/null
bun run e2e/agent-long-poll/long-poll-e2e.ts
