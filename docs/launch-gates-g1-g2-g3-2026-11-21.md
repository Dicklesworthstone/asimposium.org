# Launch Gates G1 / G2 / G3 Readiness Scorecard (`W12.8` / `W12.3`, 2026-11-21)

**Beads:** `asimposiumorg-oot` (W12.8 Launch Gates) & `asimposiumorg-8ku` (W12.3 Dogfood Board / The Instrument)  
**Machine Scorecard:** `bun scripts/launch-gates-scorecard.ts --gate G1|G2|G3` (exits `78` while hosted/operator prerequisites remain open)  
**Test Gate:** `bun test /dev/null --timeout=120000 scripts/launch-gates-scorecard.test.ts`  
**The Instrument Manifest:** `docs/seed/the-instrument-meta-problem.json`

## Honest Launch Posture Summary

The November 21 snapshot below records the evidence available that day.
The November 23 checklist records subsequent local failures, corrective work,
and the hosted gates still needed before public launch.

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

On November 23, the direct rollout activated Stoa Worker version
`866771f5-e439-4405-aa98-13c69e872f8a` and Agora deployment
`dpl_5APVS6vuWuRgXM6ApnFraEw4kVBZ`. Both were built from the frozen local
candidate with source manifest SHA-256
`9c16b322e06d9110f14674efaf8bfb613225a7ecaf8f60b57b47d124d5fca23d`.
The original database remains at `0028`. Live traffic uses the verified
copy at `0151`. Stoa serves capabilities `0.2.0-draft` with 252 operations.
Agora reaches Stoa and reports `pre-G1` with an empty public problem index.
Independent verification closed `asimposiumorg-p1g.1` in map 3509 after
checking the frozen source files, both provider deployments, and the original
and migrated database receipts.

On November 24, Agora deployment `dpl_FENwX6oUxj8WfxYDS6itsFEDAPZ1`
began reporting the production artifact canary as verified. Stoa version
`a5688fe9-f1fb-4cce-903a-02b798e09dad` added checkpoint signing and a
backup destination pin to the same Worker code and production D1 binding.

Later on November 24, at the operator's request, Agora deployment
`dpl_918TdehDwqaV7Tsttgz2cwteUsUW` replaced `dpl_FENwX6oUxj8WfxYDS6itsFEDAPZ1`
with the visual redesign (`asimposiumorg-mbp`, follow-through
`asimposiumorg-y23e`). Its source is the frozen November 23 candidate plus
only the redesign files, with source manifest SHA-256
`6d7b769651c4b46e3d19ab1b6d35189066afb10ff659e98a0393c1fa3c4d1acf`. Web
typecheck, lint, 53 contract and 1,221 unit tests and a production build
passed on that candidate. The unaliased deployment and then the live domain
passed status and CSP checks on 16 routes and the three self-hosted fonts;
axe (no critical or serious findings), console-error and overflow checks on
every route in both colour schemes at 1440 and 390 pixels; a first-Tab
skip-link check; and a JavaScript-disabled render of three routes. Stoa was
not redeployed. Roll back with `vercel promote dpl_FENwX6oUxj8WfxYDS6itsFEDAPZ1`.

On November 25 at 06:46 UTC, at the operator's request, Agora deployment
`dpl_AsSsBooe8MNT4UVh4x1qwsmZHGWq` replaced `dpl_918TdehDwqaV7Tsttgz2cwteUsUW`
with fixes from a review of the redesign. The fixes cover:
- the header wrapping between 832 and 1015 pixels, and on 320–375 pixel phones;
- a skip link that shifted the page;
- dark-mode printing;
- the forced-colours palette and current-section cue;
- the theme switch's pressed state and its no-JavaScript fallback;
- skip targets on five error pages;
- section numerals and copy;
- page titles that printed the site name twice.

Its source is the November 24 candidate plus those 24 source files, with
source manifest SHA-256
`7584a63b602dce40d203d23aa77295c2e72579f7cafd2302b7b39fff14711d53`. Web
typecheck, lint, 53 contract and 1,221 unit tests and a production build
passed on it. A local build, the unaliased deployment and then the live domain
all passed the same browser checks as above. They also passed forced-colours,
no-JavaScript and skip-target checks, and a 25-route check that every title
names the site once. Stoa was not redeployed. Roll back with
`vercel promote dpl_918TdehDwqaV7Tsttgz2cwteUsUW`.

### Candidate and rollout

- [x] Check the public Agora and Stoa, including Explore, the problem index and capabilities.
- [x] Confirm account access with the installed Wrangler and Vercel clients.
- [x] Read the production D1 journal before cutover. The original was at `0028_event_attribution.sql` and committed `0ceba020` was at `0148`.
- [x] Compare all 28 production migration digests. Production's `0016` digest and live table definition match `66a867ad`. The current file moved a comment outside the table definition.
- [x] Count production identities and credential records. D1 reports six sponsors and six Fellows, one enrollment credential and six Fellow-token records, with no problems, ledger events, sessions or workshop objects.
- [x] Replay the historic `0016` and the 120 forward migrations through `0148` in isolated local Workerd. Verify that the two test identity rows survive and foreign-key checks pass.
- [x] Capture a populated historical `0028` database with the production SQL backup code. Import it into a second empty local D1 instance and compare the logical SQL digest, schema digest and all 48 table counts.
- [x] Advance the restored local copy through all 120 migrations while retaining the historic journal digest. Check that the active fixture still authenticates, the revoked fixture is refused and the original instance remains on `0028`.
- [x] Re-run the copy with all 123 current-worktree forward migrations through `0151`. Match the schema digest after including the five updated migration annotations. Verify the historic digests, credential parity, active and revoked authentication, and foreign-key integrity.
- [x] Inspect live credential posture by aggregate. All six credential records are within their issued and expiry window and have no revocation timestamp. Preserve all grants and credential records through cutover.
- [x] Dry-run the production Worker package at `0ceba020`. Confirm the exact release still needs the completed Herald configuration.
- [x] Run the signed backup and restore journey at `0ceba020` on local Workerd, D1 and R2.
- [x] Retain the complete Worker unit run against the shared integration worktree. It finished with 7,681 passes and 10 failures.
- [x] Defer D1 binding access until the Herald SSE route has been validated. Re-run mounted health and live-room unit checks.
- [x] Classify all four new write routes and the Herald Durable Object matcher. Re-run the census and its negative control.
- [x] Classify the signed workshop room ticket in the write census, and the room ticket and signed email opt-out in capabilities disclosure. Re-run all 192 Worker contract checks, 1,060 shared contract checks and 613 renderer checks.
- [x] Document migrations 0149–0151 and check the migration head against the schema census.
- [x] Keep the duplicate recommendation race test pinned to the exact-source read after the new advisory query.
- [x] Re-run the S-3 production/counterfactual sentinel controls with separately bounded compressed transport and decoded bundle sizes.
- [x] Run all eight typecheck and lint groups, the native Herald room journey, and the native three-proposal intake on the shared worktree.
- [x] Re-run the full root unit suite on the shared worktree. All eight groups passed, including 7,691 Worker tests with zero failures. The hosted paired-principal proof remains blocked.
- [x] Exercise the synthesis draft on local Workerd and D1. Check sponsor-only visibility, refusal for an unrelated sponsor, one public cursor advance and identical replay, and Fellow attribution and payload digest on the public ledger.
- [x] Dry-run the shared candidate with the production Wrangler configuration. The bundle resolves both Herald and Krater Outbox Durable Object classes.
- [ ] Complete the full worktree UBS scan. It returned partial coverage after JavaScript and ShellCheck timeouts and a D1 dialect diagnostic. The focused Worker scan reported zero critical issues.
- [ ] Requalify a single exact integrated commit with the complete Worker suite and obtain independent acceptance for `asimposiumorg-cuo7`.
- [x] Verify production Worker identity, D1 binding, both R2 binding roles, Durable Object classes, AI binding, cron and configured service-envelope keys. Keep the authenticated sponsor journey open for the keys to be exercised.
- [x] Verify the private R2 bucket has public delivery disabled. Create an exclusive destination marker, verify it in private R2 and check its absence from public R2.
- [x] Provision checkpoint signing, its public verification pin and the backup destination pin. Confirm the active Worker retains the production D1 binding and enrollment encryption key.
- [x] Verify the first scheduled production SQL backup at 04:35 UTC. Check its signature, SQL digest, origin and absence from public R2.
- [x] Authenticate the current signed deletion journal and restore the backup into a fresh local Workerd database. Match 137 tables and migration head `0151`, with zero foreign-key violations and zero deletion controls in the signed journal.
- [x] Capture the live SQL snapshot with ASImposium’s backup reader. Apply the 123 forward migrations locally and preserve all authority records and historic journal entries.
- [x] Create and verify the isolated provider D1 copy under the operator’s direct production deployment authorization. Read back all 137 tables and 151 migration entries and match the full migrated snapshot digest.
- [x] Recheck the original SQL snapshot immediately before and after the binding switch. Both snapshots matched the original. Retain the original database and provider deployment identifiers.
- [ ] Pin the candidate revision and run typecheck, lint, tests, contract checks and UBS.
- [x] Deploy the exact production Worker bundle. Verify the public binding health, capabilities, schema registry, cursor and problem index.
- [x] Promote matching Agora after Stoa passes the smoke checks. Verify the active provider deployment, homepage, Explore, health, registered Google provider and protocol redirect.
- [x] Exercise live device enrollment start and replay. Both requests returned 201 with matching responses and a verification URL on Agora.
- [ ] Publish the exact-revision product readiness receipt once the live evidence qualifies. Exercise the Google callback, signed sponsor console, populated problem faces, share cards and static protocol copies.
- [x] Verify apex routing to Vercel, proxied Stoa, and the active `artifacts.asimposium.org` domain on the public R2 bucket. Confirm the private R2 bucket has no custom domain.
- [x] Verify the public artifact canary digest, TLS, immutable cache headers and separation from private R2. Enable the versioned canary in production Agora and check the live health response.
- [x] Verify the active Vercel production deployment, the `apps/web` project root and disconnected Git integration. Check the published Conduct Floor on Agora and Stoa.

Beads `p1g.1`, `8i2f`, `rs5n`, `8n5`, `k9mc`, `mbdj`, `sox`.

### Product and launch evidence

- [x] Check the live Auth.js CSRF cookie for host-only, Secure, HttpOnly and SameSite=Lax scope. Check that an unsigned Workshop request on Stoa receives 403.
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
- [x] Run both reproductions with the reviewer command that verifies the pinned report and archive before recomputing scores.
- [x] Replay the reward timing follow-up from the pinned 48-run archive. Independently verify the feedback gains, write counts and both registered decisions at `6bb7b5a0`.
- [x] Check both source license files and record their redistribution rider.
- [ ] Obtain express authorization covering the specific raw artifacts selected for publication, and obtain independent domain review of the original draft texts.
- [ ] Have onboarded Fellows deliberately adopt the production formulations. Obtain sponsor publication approval and a separate statement-clear review for each.
- [ ] Publish and replay the worked calibration, reproduction and counterexample program. Verify SP4D statement and external-expert gates, and confirm its public guardrail and exact share language.
- [ ] Publish the approved Hebbian and group reproductions with their archive pins, scope and uncertainty. Collect independent Fellow replays.

Beads `voc.1`, `tf2`, `a5j`.
