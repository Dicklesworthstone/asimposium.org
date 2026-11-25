# Unfinished Acceptance Command Reconciliation Map (`asimposiumorg-9lqv`)

This document indexes the authoritative executable reconciliation for every absent `scripts/*.sh|ts|mjs` path named in the `acceptance_criteria` of unfinished beads.

- **Machine-verified source of truth:** [`docs/acceptance-command-map.json`](acceptance-command-map.json)
- **CI drift & anti-ceremony validator:** [`scripts/acceptance-command-map.test.ts`](../scripts/acceptance-command-map.test.ts) (wired into `scripts/suite/ops-and-release-gates.test.ts`)

## Doctrine & Boundaries

1. **No empty shell wrappers:** Old prose paths (e.g., `scripts/e2e-problem-page.sh`, `scripts/e2e-rate-limits.sh`, `scripts/e2e-screening.sh`) are mapped directly to the repository's genuine registered Workerd/D1/R2 lanes (`apps/wire/test/integration/*-real-bindings.mjs` via `lanes-real-bindings.test.ts` and `discovery-real-bindings.test.ts`), the production Next.js + Chromium lane (`e2e/playwright/agora-local-lane.mjs --build`), the Gauntlet runner (`e2e/gauntlet/run.sh`), or Rust CLI parity tests (`cli/tests/*`).
2. **Strict proof-level separation:** Pure/unit audits remain labelled `unit-audit` or `contracts-golden` and can never masquerade as `workerd-real-bindings` or `chromium-browser` proof.
3. **Explicit browser & hosted prerequisites:** Browser commands document Playwright 1.65.0 Chromium build 1254+ (`ASIMPOSIUM_CHROMIUM_EXECUTABLE`). Hosted-only slices (`e2e-instrument-dogfood.sh`, `e2e-oauth-production.sh`) and staging/production deployment dependencies remain explicitly blocked on OPS.3 (`asimposiumorg-rs5n`).
4. **Tier 2 separated cleanly:** The six P4 Tier-2 paths (`e2e-citation-enrichment.sh`, `e2e-fmd-export.sh`, `e2e-mcp-adapter.sh`, `e2e-mirror.sh`, `e2e-webhooks.sh`, `eval-semantic-search.sh`) are explicitly marked `tier-2-deferred` rather than reported as launch failures.
5. **What this map does NOT prove:** Reconciling acceptance commands makes verification executable by an independent Fable §17.0 verifier. It supplies neither product completion nor hosted staging/production proof by itself, and does not self-close any bead.

## Summary Breakdown (39 Absent Paths Across Unfinished Beads)

| Classification | Count | Examples |
|---|---:|---|
| `reconciled-workerd-real-bindings` | 16 | `e2e-screening.sh`, `e2e-rate-limits.sh`, `e2e-write-transaction.sh`, `e2e-krater.sh`, `e2e-herald.sh` |
| `reconciled-rust-cli-parity` | 5 | `e2e-asimp-auth.sh`, `e2e-asimp-session.sh`, `e2e-asimp-validate-scrub.sh`, `e2e-asimp-spool.sh`, `e2e-cli-install.sh` |
| `reconciled-contracts-corpus` | 4 | `e2e-contract-kinds.sh`, `e2e-errors.sh`, `e2e-generated-contracts.sh`, `e2e-golden-corpus.sh` |
| `reconciled-local-audit-hosted-blocked` | 3 | `e2e-dns-cutover.sh`, `e2e-launch-gates.sh`, `e2e-legal-policy.sh` |
| `reconciled-browser-real-lane` | 2 | `e2e-problem-page.sh`, `e2e-human-auth.sh` |
| `blocked-hosted-deploy-only` | 2 | `e2e-instrument-dogfood.sh`, `e2e-oauth-production.sh` |
| `reconciled-gauntlet-runner` | 1 | `e2e-cold-agent-gauntlet.sh` |
| `tier-2-deferred` | 6 | `e2e-citation-enrichment.sh`, `e2e-fmd-export.sh`, `e2e-mcp-adapter.sh`, `e2e-mirror.sh`, `e2e-webhooks.sh`, `eval-semantic-search.sh` |
| **Total** | **39** | Zero unmapped absent paths; zero stale entries for already-present scripts |

## Running the Drift & Should-Fail Gate

```bash
bun test /dev/null --timeout=120000 scripts/acceptance-command-map.test.ts
```
