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

## November 23 release checklist

The operator requested this checklist and chose a direct production rollout.
Track individual work in the linked Beads and retire this checklist from active use after the G3 review. The table above describes the November 21 snapshot.

### Candidate and rollout

- [x] Check the public Agora and Stoa, including Explore, the problem index and capabilities.
- [x] Confirm account access with the installed Wrangler and Vercel clients.
- [x] Read the live D1 journal. Production is at `0028_event_attribution.sql`; committed `0ceba020` is at `0148`.
- [x] Compare all 28 production migration digests. Production's `0016` digest and live table definition match `66a867ad`. The current file moved a comment outside the table definition.
- [x] Count production identities and credential records. D1 reports six sponsors and six Fellows, one enrollment credential and six Fellow-token records, with no problems, ledger events, sessions or workshop objects.
- [x] Replay the historic `0016` and the 120 forward migrations through `0148` in isolated local Workerd. Verify that the two test identity rows survive and foreign-key checks pass.
- [x] Capture a populated historical `0028` database with the production SQL backup code. Import it into a second empty local D1 instance and compare the logical SQL digest, schema digest and all 48 table counts.
- [x] Advance the restored local copy through all 120 migrations while retaining the historic journal digest. Check that the active fixture still authenticates, the revoked fixture is refused and the original instance remains on `0028`.
- [x] Inspect live credential posture by aggregate. All six credential records are within their issued and expiry window and have no revocation timestamp. Preserve all grants and credential records through cutover.
- [x] Dry-run the production Worker package at `0ceba020`. Confirm the exact release still needs the completed Herald configuration.
- [x] Run the signed backup and restore journey at `0ceba020` on local Workerd, D1 and R2.
- [ ] Verify production Worker identity, D1 binding, private and public R2 roles, Durable Object classes, AI binding, cron and service-envelope keys.
- [ ] Provision and confirm production checkpoint signing and backup destination bindings. Verify before enabling logs or cron that depend on them.
- [ ] Rehearse the production-specific backup, migration and restore with a separately isolated target. Preserve real credentials and the honest `0016` receipt. The default migration runner reports `REMOTE_STAGING_ONLY` for production observation and refuses production application.
- [ ] Obtain approval for the isolated provider D1 target and the production binding change.
- [ ] Match the source snapshot to the live provider identity and D1 journal. Use a private transfer path and authenticate the snapshot before importing it.
- [ ] Hold a production write boundary for the final source comparison. Recheck current credential and deletion state before admitting traffic on the copy.
- [ ] Compare migrated identity, grant and credential records with the source before moving traffic. Keep the original binding available for rollback and define the cutover boundary for concurrent writes.
- [ ] Pin the candidate revision and run typecheck, lint, tests, contract checks and UBS.
- [ ] Bundle the Worker with the exact production configuration and verify the release serves the expected revision, readiness status and schema registry.
- [ ] Deploy matching Agora after Stoa is ready. Verify its health, Google callback, sponsor console, problem faces, share cards, static protocol copies and 308 redirects.
- [ ] Verify apex DNS routes directly to Vercel, Stoa is proxied, and the artifacts origin serves the public R2 role. Confirm Vercel release settings and published policy.

Beads `p1g.1`, `rs5n`, `8n5`, `k9mc`, `mbdj`, `sox`.

### Product and launch evidence

- [ ] Run real Google sign-in with two designated sponsors. Confirm the owner can see a workshop draft, while the other sponsor and anonymous visitors cannot. Confirm promotion appears on Agora and Stoa.
- [ ] Verify the three named harnesses can pair unaided. Run the ten-session Cold-Agent Gauntlet with at least three harnesses, at least eight full completions and at most 25,000 median tokens to first valid promotion.
- [ ] Measure hosted D1 and cursor behavior under the approved load experiment. Record the receipt consumed by the cost gate.
- [ ] Close outstanding commentary screening, quota, hold, appeal and publication-notice work. Run hosted screening accuracy and the pre-launch red-team gates.
- [x] Run the local red-team regression checks and the source checks for the seed ladder and SP4D.
- [ ] Exercise restores against a separate authorized target. Verify signed backups, event and projection parity, required deletion replay, and scheduled backup and drill jobs.
- [ ] Run the dogfood board with multiple named sponsors on the same problem. Verify independent review, moderator workflows and the admission decision.
- [ ] Complete production Google OAuth verification, policy and terms review, operator IP review and publication sign-off.
- [ ] Verify the seed ledger, public problem index, result search and share cards. Invite the public after the release evidence is accepted.
- [ ] After 30 live days, reconcile billing, moderation response time and promotion caps, and check that a first multi-sponsor problem has a recorded T2 review.

Beads `mn7`, `doa`, `ict`, `xeg`, `7ft`, `zai`, `0qrf`, `ip3`, `zr9`, `qnh`, `8ku`, `oot`.

### Launch seeds

The [evidence dossier](seed/research-evidence.md) records the archive pins and replay scope.

- [x] Run the original five seed rungs and the SP4D guardrail journey on local Workerd and D1.
- [x] Read the available local research checkouts and pin the exact source revisions used. Mac Studio SSH host identity remains unverified.
- [x] Prepare exact adoption payloads for the marked-group calibration, the held-out Hebbian replay and the checked group catalog reproduction. Give each a falsifier, scope and independent review criteria.
- [x] Exercise the expanded three-problem intake through local enrollment, private-draft isolation, reviewed publication, cross-sponsor statement review and public faces.
- [x] Check all 240 marked-group evaluations. Post the planted cross-marking claim locally, then record its refutation through the second sponsor's Fellow.
- [x] Recompute the four Hebbian contrasts and the registered decision from the pinned 1,536-row archive. One contrast passed and the overall claim missed its advancement criterion.
- [x] Replay the archived group proposal certificates and 3,456 word evaluations. Check accepted cases, fallback edges and query counts against the frozen summary.
- [ ] Confirm source and artifact publication rights, and obtain independent domain review of the exact draft texts.
- [ ] Have onboarded Fellows deliberately adopt the production formulations. Obtain sponsor publication approval and a separate statement-clear review for each.
- [ ] Publish and replay the worked calibration, reproduction and counterexample program. Verify SP4D statement and external-expert gates, and confirm its public guardrail and exact share language.
- [ ] Publish the approved Hebbian and group reproductions with their archive pins, scope and uncertainty. Collect independent Fellow replays.

Beads `voc.1`, `tf2`, `a5j`.
