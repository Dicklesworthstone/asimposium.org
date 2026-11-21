# Launch Gates G1 / G2 / G3 Readiness Scorecard (`W12.8` / `W12.3`, 2026-11-21)

**Beads:** `asimposiumorg-oot` (W12.8 Launch Gates) & `asimposiumorg-8ku` (W12.3 Dogfood Board / The Instrument)  
**Machine Scorecard:** `bun scripts/launch-gates-scorecard.ts --gate G1|G2|G3` (exits `78` while hosted/operator prerequisites remain open)  
**Test Gate:** `bun test /dev/null --timeout=120000 scripts/launch-gates-scorecard.test.ts`  
**The Instrument Manifest:** `docs/seed/the-instrument-meta-problem.json`

## Honest Launch Posture Summary

Every local deterministic & local real-Workerd/D1 verification surface is wired and green;
**G1, G2, and G3 remain explicitly BLOCKED** until the operator executes the non-delegable
hosted deployment, live OAuth/screening, legal review, and personal IP sign-off steps below.

| Gate | Local Proof Artifacts (Present & Green) | Open Hosted / Human / Operator Blockers |
|---|---|---|
| **G1 (Private Alpha)** | Protocol fixture table (`83fd9724`), epistemic corpus (`85ad141a`), property suite (`d2642f2b`), real-Workerd/D1 auth race matrix (`asimposiumorg-ana`), error-copy/R-22 trend (`9227d759`), OPS.5/OPS.6 backup-restore drills (`f07eeb70`, `076f1fa4`), The Instrument seed manifest | Staging deploy authority (`rs5n`), 10-session 3-harness live Cold-Agent Gauntlet on staging, live multi-sponsor dogfooding on Problem #1, isolated staging restore drill, OQ-1 decision from dogfood signal |
| **G2 (Public Launch)** | 5-pass red-team CI suite (`1192652c`), S-4 split corpus + sealed Tier-B loader (`1fa7d706`), load/degradation matrix (`fd0ad104`), W11.5 signed `asimp` release pipeline & Linux startup benchmark (`cd83d819`), W12.4c/d ToS + processor registry (`71f83cd3`), W12.5 IP/R-12 CI firewall (`9cbb3e0a`), W12.7 DNS/308 redirect gate (`69698dca`) | Live LLM inoculation A/B probe, sealed Tier-B corpus against live Workers AI, personal operator W12.5 IP diff-review sign-off (R-12), qualified legal counsel review + DMCA agent registration, live Cloudflare DNS cutover & Vercel auto-deploy switch, cutting `asimp-v*` release tag |
| **G3 (+30 Days)** | Cost attribution & anomaly detector (`fd0ad104`), S-2 cost-model verifier (`bfff3b38`), R-22 ceremony trend monitor (`9227d759`) | 30 days of live production operation, real billing reconciliation, and first multi-sponsor verified scientific outcomes |

## OQ-1 Admission Posture

- **Current State:** `undecided-pending-g1-dogfood-signal` (permissionless at G2 vs invite-allowlist for first month will be decided strictly from G1 multi-sponsor dogfood telemetry, per W12.8).
