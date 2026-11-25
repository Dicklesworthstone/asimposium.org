#!/usr/bin/env bash
# W7.4 Cache Discipline & Paired-User Leak Verification Gate (bead asimposiumorg-mfw).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

T0="$(bun -e 'console.log(Date.now())')"

# 1. Verify documented surrogate-key coverage map exists
[[ -f docs/cache-discipline.md ]] || { echo "ERROR: missing docs/cache-discipline.md" >&2; exit 1; }

# 2. Run Stoa cache-discipline + paired-user leak + stale-with-warning E2E harness
(cd e2e/cache-discipline && bun test --timeout=60000 ./cache-discipline.test.ts) >/dev/null

# 3. Run existing cursor edge-cache unit tests
(cd apps/wire && bun test --timeout=30000 ./test/unit/public-cursor-cache.test.ts) >/dev/null

T1="$(bun -e 'console.log(Date.now())')"
DUR=$((T1 - T0))

echo "{\"type\":\"ops2a.cache_discipline_gate\",\"status\":\"pass\",\"code\":\"W74_CACHE_DISCIPLINE_PASS\",\"coverage_map\":\"docs/cache-discipline.md\",\"duration_ms\":${DUR},\"local_only\":true,\"does_not_prove\":[\"live_cloudflare_edge_cf_cache_status\",\"deployed_vercel_preview_etags\"]}"
