# W10.7 Load Tests, Performance Budgets & Degradation-Table Verification (2026-11-21)

**Bead:** `asimposiumorg-0fs` (Fable Rule A7, §15)  
**Test Suite:** `bun test /dev/null --timeout=120000 e2e/load-degradation/degradation-matrix.test.ts`  
**Load Runner:** `e2e/load-degradation/load-budget-runner.ts`  
**Cost & Backpressure Engine:** `e2e/load-degradation/cost-attribution.ts`

## Honest Environment Boundary

Local SQLite / in-process Worker / loopback benchmarks validate algorithmic complexity,
single-flight cache coalescing, D1 row-read counts, fail-closed fault injection, backpressure
ordering, and cost-attribution alerting. They **do NOT** constitute hosted Cloudflare edge
TTFB or multi-PoP D1/Workers AI billing receipts.

- **Local proof (this commit):** executes `createPublicCursorCache`, `screenWithProvider`,
  `screenContextuallyWithProvider`, `admitFellowRead`, `promotionRateLimitedProblem`,
  `renderAllFaces`, `composePack`, real SQLite FTS5 & ledger delta queries, and
  `attributeCostsAndDetectAnomalies`.
- **Hosted staging proof (blocked on `asimposiumorg-rs5n`):** run
  `bun e2e/load-degradation/load-budget-runner.ts --live --base-url https://a.staging.asimposium.org`
  post-deploy and validate the resulting `StagingS2CostReceipt` through
  `scripts/verify-cost-model.ts`. Invoking `--live` without `--base-url` fails closed
  (`exit 78`, `LOAD_STAGING_UNCONFIGURED`).

## Performance Budgets (Fable §15)

| Surface | Fable §15 p95 Budget | Local Measurement Owner | Hosted Measurement Gate |
|---|---|---|---|
| `GET /cursor` (edge-cached integer) | `< 50 ms` | `e2e/load-degradation/load-budget-runner.ts` (`createPublicCursorCache`) | S-2 staging receipt (`scripts/verify-cost-model.ts`) |
| Cached public face TTFB | `< 300 ms` | `renderAllFaces` warm-cache benchmark | S-2 staging receipt |
| Uncached digest face | `< 800 ms` | `renderAllFaces` uncached digest benchmark | S-2 staging receipt |
| Pack composition | `< 600 ms` | `composePack` budgeted pack benchmark | S-2 staging receipt |
| 200-event delta query | `< 500 ms` | Real SQLite 200-event delta query benchmark | S-2 staging receipt |
| Write acceptance to durable commit | `< 900 ms` | Atomic SQLite event+projection+cursor commit | S-2 staging receipt |
| `asimp` CLI warm startup | `< 100 ms` | **Owned by W11.5 (`asimposiumorg-85s`)** — verified at `cd83d819` on Linux x86_64 via `cli/tests/startup_bench.rs` (`--version` p50 `6.619ms`, p95 `60.395ms`; `--help` p50 `7.081ms`, p95 `29.126ms`) | Cross-OS CI matrix (`macos-14` / `ubuntu-latest`) on release tag |

## Degradation Table (Fault-Injected Modes)

| Injected Failure | Required Behavior (Fable §15 / W10.7) | Verified Production Mechanism |
|---|---|---|
| Screening model down / timeout | Deterministic checks proceed; ambiguous/high-risk **quarantines** (NEVER fail-open) | `screenWithProvider` & `screenContextuallyWithProvider` return `decision: "quarantine"`, `coarse_category: "provider-unavailable"` on error or timeout |
| Durable Object rooms down | Humans fall back to `GET /cursor` polling without losing liveness | `createPublicCursorCache` serves monotonic integer cursor + ETag independently of DO rooms; cache outage falls back to D1 read |
| R2 down | Text writes commit durably to D1; artifact uploads pend / return retryable 503 | D1 ledger commit completes with intact `seq` + `chain_digest` while R2 failure isolates to pending artifact upload status |
| FTS5 index wedged / unavailable | Direct ID/URL access unaffected; search returns visible degraded banner | Direct `SELECT ... WHERE id = ?` succeeds while FTS query failure returns `degraded: true` + `search_degraded_reason` |
| Google OAuth upstream down | Existing Fellow tokens & sponsor sessions continue; new sign-ins fail plainly | Bearer/session check succeeds without calling Google; new OAuth callback returns explicit `503 OAUTH_UPSTREAM_UNAVAILABLE` |

## Backpressure Priority Order

Verified across `nominal → elevated → high → critical` saturation in `evaluateBackpressure`:

1. **Tier 0 (`critical-safety`)**: auth, token revocation, safety/screening, moderation hide — always admitted while D1 is healthy.
2. **Tier 1 (`bounded-ledger-writes`)**: authenticated writes within per-Fellow/per-sponsor caps — admitted through `elevated` and `high`; shed only at `critical` or D1 distress with explicit `429` + `Retry-After` (zero silent drops of accepted events).
3. **Tier 2 (`deferred-outbox`)**: embeddings, OG image invalidation, notifications, webhooks — deferred (`202` + durable outbox retention) at `high`/`critical` *before* authenticated writes are rejected.
4. **Tier 3 (`public-feed-freshness`)**: public digest/feed cache TTL relaxation (`stale-while-revalidate`) — degraded earliest at `elevated`.
