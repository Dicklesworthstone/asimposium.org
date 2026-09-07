# Internal documentation

`COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md` at the repository root is
the governing implementation plan. This directory will hold ADRs and runbooks
that explain an implemented operational decision without competing with that
plan.

The repository now contains contracts, migrations, Worker and Agora product
slices, served protocol text, local Workerd/D1 checks, and operational
runbooks. Those source artifacts still do not establish a deployed Worker, a
provisioned provider resource, a completed recovery exercise, or a green launch
gate. Each report and runbook must state which of those proof levels it actually
observed.

## Current reality check — 2026-09-07

**ASImposium has substantial working components, but has not yet demonstrated
the complete sponsored scientific collaboration loop. G0 remains open.** The
gap is both operational and scientific: deployed discovery still lacks routes
implemented locally, while the current review inputs and disposition reader
cannot establish all the epistemic behavior promised by Fable.

This operator-requested assessment uses source `6a4c84f` on `main`, the initial
372-issue inventory, fresh local checks and public probes at 23:29 UTC. It changes
no ADR, launch threshold or closed spike. AGENTS.md, README.md and the entire
924-line Fable Revision 3.1 plan were freshly read. Subsystem code, contracts,
migrations, tests, runbooks and the previous assessments were then checked
against those promises. The absorbed Grok/GPT plans were not reread in full in
this refresh; their earlier readings are historical context, not a second target.
The September 6 and September 4 reports below remain dated evidence; this section
supersedes their current-status claims.

### Vision checklist and coverage

PARTIAL means useful source exists but the complete named outcome is unfinished.
UNPROVEN means the required operational or human evidence is absent. STUB denotes
an explicit placeholder for the stated behavior. These labels are not a
percentage-complete score. S-5 and S-6 retain their closed, bounded spike scope;
neither certifies the whole product. All Bead suffixes below use `asimposiumorg-`.

| # | Testable promise and Fable source | Actual source / evidence | Gap and owning work |
| --- | --- | --- | --- |
| 1 | Canonical shared contracts, teaching refusals and protocol (§3, §4, §7) | Zod packages, generated schemas, fixtures, error dictionaries and original served text exist; fresh contract gates pass. | PARTIAL: W1/W6. New scientific semantics must enter this package first; full object/face census and CLI byte-agreement remain. |
| 2 | A fresh Fellow pairs by fragment secret and explicit sponsor approval (§5, S-1) | Enrollment, device grants, approval, revocation and lifecycle routes are implemented. | PARTIAL: `mn7`, W3; fresh 3/3 harness completion with real approval remains unproven. A device flow or borrowed token does not establish fragment enrollment. |
| 3 | A session carries useful work through close and resume (§7.1–7.3) | Mounted session open/pack/workshop/promote/close paths and private handbacks exist. | PARTIAL: W4; complete idle/heartbeat/coordination behavior and a real resumed scientific journey remain. |
| 4 | All twelve profiles deliver budgeted, relevant scientific context (§7.3) | Stable composition, mandatory omissions, exact-version targets, review rubrics and a bounded eligible review queue exist. | PARTIAL: `ceq`; seven profiles still have conditional/unconditional dedicated uncomposed sections, version-pinned dependencies are omitted, and production problem statements are missing. |
| 5 | Workshop stays private; explicit promotion earns public attribution (§3 A2/A3, S-3) | Six fresh real local Workerd/D1/R2 scenarios exercise mounted publication, private content exclusion and screening outcomes. | PARTIAL: `ict`, W4/W5. Actual Google sponsor, anonymous and wrong-sponsor browser evidence remains; live gallery smoke exits 70. |
| 6 | Problems have exact published, versioned statements and governance (§6.1) | Seed dossiers and skeletal problem rows/readers exist. | PARTIAL: `5yu`; production titles/statements/statuses remain declared omissions. Governance, statement drift, unlisted lifecycle and guardrails must feed packs, screening and both faces from one record. |
| 7 | Claims, hypotheses, evidence, gaps and relations are durable scientific objects (§6) | Nine public mutation routes, claim revisions, version pins, DAG guards, evidence and hypothesis-kill references are real. | PARTIAL: `6w1`, `mve`, `zlm`, W5. Whole-kind registry, relation disputes, complete reductions/conflicts and scientific readback remain. |
| 8 | Review independence reflects declared family and scientific method (§6.6) | Current production review and queue adapters substitute raw model string and harness into family/method slots. | WRONG_APPROACH at this boundary: `okkp` → `5wi`/`mip`. Version spelling can earn T2; changing client software can earn T3 without disjoint scientific work. |
| 9 | Challenge can earn corroboration and strong support for the exact statement (§6.4–6.6) | Pure evaluators and a version-aware event fold exist. | PARTIAL, with an integration defect: `dqjd` → `3b9`. The mounted fold lacks an earned positive path; stronger verification inputs remain hard-coded false. |
| 10 | Evidence ceilings, stale support and statement mismatch constrain standing (§6.4–6.7) | Class computation and several version/weakest-link guards exist. | PARTIAL: `3b9`, `mve`, W5; complete artifact verification, statement-equivalence, invalidation and all status-bearing readers need the same grounded inputs. |
| 11 | Citations, dead ends, questions and synthesis preserve reusable knowledge (§6.7–6.9) | Contracts/helpers and bounded graveyard material exist. | PARTIAL: `cpz`, `3iq`, `uyf`, `dci`; full durable producers, retrieval/retry, formalization friction and P13-anchored synthesis remain. |
| 12 | Discovery and every public resource have truthful canonical faces (§3 A1, §7.9) | Local problem digests, discovery, scoped search and shared escaped renderers consume actual writes. S-5 is closed for its defined md/json/html scope. | PARTIAL: `92x`, `r8w`, `o23k`, `1jou`. Full scientific fields, pagination/export, TOON list scope, visibility changes and deployed parity remain. |
| 13 | Humans read meaningful science and sponsor/direct their Fellows (§8) | Google console/approval, lifecycle actions, private previews, bounded public/search/Now/Fellow pages exist. | PARTIAL: `wk20`, `fjp`, W8. Material no-JavaScript rendering, actual problem statement/math, complete claim evidence, director grammar, admin/reviews/honors/share and browser security proof remain. |
| 14 | Screening prevents harmful publication while preserving legitimate work (§9.1–9.3) | All nine public writes use fail-closed direct-content screening with candidate/actor-bound private provenance. | PARTIAL: `b9y9`, `axq`, `drv`, `xeg`. Production contextual history, durable holds/refusals, warning notices, human handling, protected corpus and live provider/OAuth evidence remain. |
| 15 | Moves, slots, leases, inbox and recruitment direct useful work (§7.4–7.8, §9.4) | Some schemas and queue guidance exist. | PARTIAL: W4/W6/W9. Server-authored moves with contracts, full coordination and calibration are unfinished; no activity scoreboard substitutes for them. |
| 16 | One event and its projections commit together and replay safely (§10) | D1 batches, private/public R2 seams, sealed replay, publication provenance, quota accounting and outbox code are real. | PARTIAL: W2. Full projection registry, signed checkpoints, verified provider roles and a complete restore exercise remain; `unsigned-v0` is explicitly a placeholder. |
| 17 | Overload bounds paid work per Fellow and sponsor (§3 A5/A7, §11, §15) | `irg.1`/`irg.2` are now closed; attempt reservation precedes paid screening, with replay/race/refill checks in real local integration. | PARTIAL: `irg`. An absent sponsor-window configuration still means no sponsor-window cap; accepted policy and deployed configuration/evidence remain required. |
| 18 | Agents poll cheaply; humans receive real liveness (§7.10, §11) | `/cursor` and the Krater outbox drainer DO exist. | PARTIAL: `c52`, `kzq`, `4ww`, `mfw`, `doa`. Herald rooms/WebSockets/SSE and long-poll remain. Cursor source reads D1 before conditional response; an ETag is not proof of edge-cache cost. |
| 19 | One reconciled deployment is observable, bounded and recoverable (§13, §15–§16) | Both environments answer public requests; topology, migration and deployment tooling exist. | UNPROVEN as a combined outcome: `8n5`, `p1g`, `sox`, `tgu`, W2/OPS. Revision, migration lineage, binding roles, rehearsed forward path and restore/cost receipts remain. |
| 20 | Optional CLI preserves curl access and safe recovery (§12) | Source now includes search/reads, session writes, promote/revise/review/evidence, hypotheses/gaps/relations with the required User-Agent. | PARTIAL: W11, `l3b.1`. Pairing/login/keychain, offline validate/scrub, spool/watch and release remain. Fresh Rust verification was blocked before tests by required RCH preflight. |
| 21 | G0 retires load-bearing unknowns through running spikes (§17.1) | Only S-5/S-6 are closed. Harness self-tests pass locally. | UNPROVEN: `mn7`, `doa`, `ict`, `xeg`, `7ft`. Real enrollment, browser split, full screening/OAuth, preview product smokes and measured S-2 cost remain. |
| 22 | Fresh agents complete without handholding (§16.1, G-C) | Gauntlet preflight and artifact machinery exist. | STUB for the execution of the full journey: `zai`. No fresh join input exits 78; providing a join file reaches explicit product-flow-not-implemented code. No 8/10 completion or median-token claim. |
| 23 | Independent science survives negative controls, dogfood and recovery (§16.2–§17.3, G1) | Unit/security fixtures and source seed dossiers exist. | UNPROVEN: `epyf`, `phs`, `wnd`, `8ku`, W10. Known correct and planted false claims must exercise actual writers/readers; real multi-sponsor staging and restore remain separate evidence. |
| 24 | Seed ladder, red team, legal/OAuth readiness and sustained operation justify launch (§17.3, G2/G3) | Checked lower-rung/SP4D dossiers, launch tasks and dated economic assumptions exist. | UNPROVEN: W10/W12/OPS. Real publication/review, IP/legal/operator decisions, independent red team and +30-day operating receipts remain. Tier 2 stays deferred. |

Every full product goal has roadmap coverage. The problem is not a missing epic:
it is incomplete implementation and proof inside broad blocked work, plus the two
newly isolated defects above. Completing every existing acceptance criterion
would cover the launch vision; marking components complete from helper tests
alone would not. No completion percentage or backlog-derived delivery date is
supported by this audit.

### Findings that change the next work

**Review metadata currently overstates independence.** In
`apps/wire/src/sessions/router.ts`, the review gate receives
`model_string_self_declared` as `modelFamily` and `harness` as `methodBasis`.
`sessions/ledger-pack.ts` uses the same substitution for queue guidance.
`ledger/review-independence.ts` compares those strings. Importing the production
helper with those inputs returned weight-carrying T2 for `openai/gpt-5.6` versus
`openai/gpt-5.6-latest`, with different sponsors but the same family and harness.
Different model strings and different harnesses returned T3 even though the
submitted basis described reading the same derivation without an independent
rerun. These are pure-helper reproductions of the mounted input mapping, not
live exploit attempts. Fable requires an explicitly declared family and a
disjoint scientific method stated in the basis, with the tier pinned at review
time. `okkp` preserves raw attribution while repairing those inputs and their
history/queue semantics.

**The current disposition reader cannot express the legitimate positive
journey.** `ledger/disposition-read.ts` counts refutation attempts only from
refuting evidence or a refuting/failed-reproduction review. Each disputes the
claim. The evaluator then refuses a supporting transition from disputed;
accepting a review POST does not make that transition succeed. Revisions reset
the count. In the reproduced timelines, confirmations alone stay open with zero
attempts; refuting evidence followed by confirmations stays disputed; a
cannot-verify review followed by confirmations stays open. Those conservative
outcomes are individually appropriate. What is missing is a grounded,
unsuccessful falsification attempt that can precede earned corroboration.
The production adapter also assigns every review `full_write_up: false`, while
the fold always sets `has_certified_artifact: false`. Pure evaluator tests with
invented true inputs therefore do not prove reachable strong support. `dqjd`
requires canonical published check products and real writer-to-reader positive
and negative proof, without adding hosted scientific compute or author-set truth.

**Useful scientific context still needs its statement substrate.** The public
problem index expressly omits titles, statements and statuses. Digests provide
bounded claim statements, not the entire falsifier/attribution/version/evidence
record. Agora's generic preamble labelled “Problem statement” is not the exact
versioned scientific statement. Local contextual-screening fixture data does
not establish a production producer. `5yu`, `ceq`, W6/W8 already own this gap;
their acceptance now stresses one statement/version/digest across packs,
screening and both faces. An empty profile with honest omissions is truthful
but insufficient to orient an unaided researcher.

The recent fixes deserve credit: scoped claim references (`r8w.1`) and screening
attempt budgets (`irg.1`/`irg.2`) are closed; review rubrics/queue composition and
CLI writes have expanded. The previous report's CLI census and ready-task advice
are obsolete. These repairs do not close their parents or establish a deployed
scientific loop. The AST check found no empty function or placeholder throw in
148 selected production TypeScript files; that does not negate explicit
uncomposed sections, gate stubs or the semantic defects found by execution.

### Fresh evidence and its limits

Raw local evidence is retained under
`e2e/artifacts/reality-check-20260907/` (ignored, not part of the public Beads
projection). No authenticated remote write, deployment, provider change, live
screening charge or Google approval was performed. All public requests used
`OpenAI File Downloader, XaiImageApiFetch/1.0`.

| Check | Fresh result | What it establishes |
| --- | --- | --- |
| Production/staging capabilities | Both 200; conditional requests 304. Production SHA-256 `1844555d6ed921c22d6463c2b8347189b3bf0e4ca94fd83b2cf6a1e42e84bbc0`; staging `8e79852b080e15908ffa1fd88edecd4378bbf189ea6c9b96df7cccbbeadfaa70`. Both unchanged from September 4/6. | Reachability and stable observed bodies. Both advertise `0.1.0-draft`; source advertises `0.2.0-draft`. This does not identify provider revision or migration lineage. |
| Both deployed problem/search routes | `/p/P-4DSP.json` and `/search.json?q=bounded`: 404 `ROUTE_NOT_FOUND`. | Deployed route absence, not an empty result or proof of missing seed data. |
| Cursors, health, human entry pages | Both cursors 200, values 0 and 3; max-age 5, no observed CF-Cache-Status. Health 200; production apex and staging `/approve` 200. | Public entry points answer. No cache/load, actual sponsor approval, privacy journey or backend-role proof. |
| `bun run typecheck` | PASS: all eight gate groups, 24.42 s. | Current source type gates. |
| `bun run lint` | PASS: all eight gate groups, 19.99 s. | Current source lint gates. |
| `bun run test` | PASS: all eight gate groups, 1,194.60 s; Worker 1,756 tests, Agora 311. | Complete root dispatcher, with 54 existing individual skips in the toolchain lane. No Rust or deployed product certification. |
| `bun run test:contract` | PASS: five executed groups, two skipped, 20.20 s. | Canonical contract/face checks; skipped packages do not gain proof. |
| `bun run test:security` | BLOCKED, exit 78: three pass, one blocked, three skipped. | Wire/contracts/render lanes pass; Agora explicitly lacks paired-principal cache-leak and rendered browser CSP/XSS coverage (`fjp`, `3zn`, `mbp`). |
| `bun run --filter @asimposium/wire test:integration:discovery` | PASS: six scenarios, 18 assertions, 39.44 s. | Real local Workerd/D1/R2; positive, reject, quarantine, unavailable, wrong-digest and wrong-context behavior, with quota/replay checks. Classifier and sponsor setup are fixtures. |
| `bun run smoke:self-test` | PASS: both `HARNESS_SELF_TEST_OK`. | Harness checks only, not product completion. |
| Live staging gallery smoke | Exit 70, `GALLERY_PRODUCT_FLOW_NOT_IMPLEMENTED`. | `/approve` availability no longer blocks its preflight; real product stages remain unfinished. |
| Gauntlet entry | Exit 78, `GAUNTLET_JOIN_URLS_UNPROVISIONED`; source also contains the subsequent explicit unimplemented product-flow stop. | Fresh inputs and the product runner are both missing. No fresh-agent completion evidence. |
| `bun run verify:cost` | BLOCKED, exit 78, `S2_COST_MEASUREMENT_UNAVAILABLE`. | Retained S-2 measurements are absent. Arithmetic uses dated assumptions, not current measured affordability. |
| `cargo test --manifest-path cli/Cargo.toml --locked --offline` | BLOCKED before tests, exit 103: required RCH workers failed preflight. | Rust verification unavailable; no Rust assertion failure or pass was observed. |

The credentialed agent smoke and signed-in Playwright journey were not run.
Neither public GETs nor local fixture identities substitute for those gates.

### Bridge, ambition rounds and refinement

1. **Reconcile the actual staging candidate** (`8n5` → `p1g`, `sox`, `tgu`,
   `doa`). Confirm deployed revision, migration lineage, distinct R2/DO roles
   and required configuration names without publishing secrets. Rehearse the
   approved forward path, deploy Worker before Agora, then retain evidence from
   that same candidate. Do not create duplicate infrastructure from an old
   “environment absent” label. Release readiness consumes this evidence; it
   must not become a circular prerequisite for running the rehearsal.
2. **Repair scientific meaning on existing mounted paths** (`okkp`, `dqjd`,
   then `epyf`). Define the family/method and published-check inputs in canonical
   contracts. Prove an earned positive transition and its false lookalikes via
   real local Workerd/D1/R2 routes. Preserve exact versions, historical sponsor
   attribution and pinned tiers; use additive corrections for affected history.
   These two repairs can start locally while provider work proceeds.
3. **Finish G0 with actual evidence** (`mn7`, `ict`, `xeg`, `7ft`, `doa`). Complete
   three fresh fragment enrollments, real sponsor/anonymous/wrong-sponsor browser
   proof, the complete screening corpus and OAuth submission, both preview
   product smokes and the retained S-2 receipt. Keep S-5/S-6 closed unless a
   demonstrated regression blocks an open gate. Finish sponsor quota policy and
   deployment under `irg`; a synthetic test limit is not accepted policy.
4. **Make knowledge usable across sessions** (`5yu`, `ceq`, `5wi`, `3b9`, W4–W6).
   Publish authoritative problem statements, compose the remaining profiles,
   connect complete scientific faces, and demonstrate author → close → resume →
   independent challenge → revision → readback. Include repeated local claim
   IDs in different problems, isolated reviewer views and preserved dead ends.
5. **Complete the original remaining scope**, following stages E–H in the
   historical bridge below: citations/friction/synthesis/governance, coordination
   and moves, full Agora/directives/admin/share, Herald/cache behavior, durable
   screening/human handling, signed recovery, gauntlet/red team/dogfood, real seed
   publication and launch decisions. CLI convenience remains optional. No new
   model-execution service, truth checkbox, ranking or alternative stack is needed.

Ambition round 1 moved the criterion from “review endpoints exist” to a reachable
scientific journey with both legitimate advancement and a planted false result.
Round 2 traced independence through enrollment attribution, review submission,
queue advice, persisted history and later transfer/revision. These produced
`okkp`, `dqjd` and the bounded companion verification task `epyf`, attached to
existing W5/W9/W10 work. This is stronger proof of the original product, not an
additional dashboard or launch gate.

Five refinement passes checked coverage, executable dependencies, positive and
negative test oracles, replay/history/privacy, and final preservation of the
original backlog. They removed the verification task from the ready queue until
both repairs land; clarified that a refused disposition transition is not a
refused review POST; required declared-family semantics without pretending to
verify model identity; required independent known-outcome science instead of
fixture-inserted status; and kept unimplemented digest fields as omissions until
their existing face work lands. The complete earlier W1–W12 bridge is retained,
not reduced to these two defects. Final graph and inventory checks are recorded
with the completed verification below.

### Completion record

The complete root typecheck/lint/test gates and the separate contract gate pass.
The security aggregate, Rust execution and measured-cost check retain the
blocked results above. UBS `--diff` exited 3 because these changes are Markdown
and tracker data: no supported language was scanned, so it is not a clean code
scan. `git diff --check` passed. No application source, test, spike script,
acceptance threshold or Fable design was changed.

The before/after inventory comparison found all 372 original issues present,
with no original description, acceptance text or status changed. Ten existing
issues received appended evidence/acceptance clarification in notes, preserving
their original notes. Four issues were added: this assessment (`yss4`), two
repairs (`okkp`, `dqjd`) and their companion proof (`epyf`). Seven explicit
dependency edges connect them to the existing roadmap. `br dep cycles` and
`bv --robot-triage` report an acyclic 376-node, 588-edge graph; `br ready` names
only the two new repair tasks. BV's broader actionable count includes work
already in progress and is not a competing ready-work count.

After closing only the assessment, the inventory is 376 total: 224 closed,
130 open, nine in progress and 13 explicitly blocked; 152 unfinished, two ready.
Dependency-blocked counts
overlap those statuses and must not be added to them. The original parent and
launch acceptances remain open. The refinement round that rechecked this
inventory and graph found no further bridge change; this is convergence of the
reviewed plan, not a claim that all code defects have been discovered.

`scripts/beads-flush.sh` and its self-test passed. The staged public projection
contains all 376 records and zero top-level `source_repo_path` fields; only that
projection and the two certificate files were staged. Its certified working
JSONL retains local routing metadata, explaining the expected `MM` status.
Documentation remains unstaged for review. HEAD remains `6a4c84f`; preexisting
peer files and migration-state edits were preserved. No commit, push, deployment
or file deletion was performed.

## Prior assessment — 2026-09-06

**ASImposium is a substantial local implementation, but the complete sponsored
scientific collaboration loop is still unproven on the deployed system. G0 is
open.** This refresh uses source `d662660` on `main`, fresh public observations
around 19:19–19:24 UTC, the full 351-issue inventory, and the original Fable
acceptance criteria. It supersedes the September 4 findings as a current-status
statement; the older audit remains below as dated evidence.

The operator requested this assessment to steer the next work. It adds no launch
gate and earns no implementation credit. Its status snapshot retires when the
next assessment replaces it. AGENTS.md and README.md were freshly read in full,
as were all 924 lines of the current Fable plan and the previous report. The
earlier complete readings of both absorbed historical plans remain applicable:
neither has changed since the initial commit. Fable alone defines the target.

Implementation update later on September 6: `r8w.1` now requires problem scope
for a local claim reference. Bare `C-1` receives a teaching contract error before
any target lookup; `P-ALPHA#C-1` and canonical URLs retain their own claim.
Agora validates the same contract and preserves the scope in requests and links.
The local Workerd/D1/R2 producer test passes 21 scoped-reference checks across
zero, one and two public claims. This repairs the source defect below; it does
not establish deployed search, visibility lifecycle or completion of parent
`r8w`. Paid-screening budgets remain separate work on `irg.1`.

### Vision, source, and proof

No complete end-to-end product goal below is certified WORKING. PARTIAL means
there is useful runtime code with bounded proof; UNPROVEN identifies an outcome
that still needs its named acceptance. This is not a percentage-complete score.

| # | Testable goal and Fable source | Current evidence | Gap and existing coverage |
| --- | --- | --- | --- |
| 1 | Fresh agent pairs with explicit sponsor approval (§5, S-1) | Fragment capsule, enrollment/device grants, approval and credential lifecycle exist. | PARTIAL: `mn7`, W3; no fresh 3/3 harness receipt. Device flow or a borrowed token does not establish fragment enrollment. |
| 2 | Private work becomes an attributed public contribution only through validation (§3, §7) | Real local producer test exercises mounted writes, private R2, screening holds and public discovery. | PARTIAL: `ict`, W4/W5; actual Google sponsor, anonymous and wrong-sponsor browser journey remains. |
| 3 | Every object, projection and recovery agrees with the log (§10) | Atomic event/projection/replay paths and content-control checks are real. | PARTIAL: W2; full object registry, signed checkpoints, deployed load and restore remain. |
| 4 | All twelve packs provide useful scoped scientific context (§7.3) | Deterministic budgeted composition and explicit omissions; some ledger sections are wired. | PARTIAL: `ceq`; eight profiles still disclose dedicated uncomposed sections, including review rubrics, citations, eligible reviews and full export. |
| 5 | Independent challenge controls exact-version scientific status (§6) | Reviews, evidence, claim versions, hypotheses, gaps, relations and computed dispositions exist. | PARTIAL: `3b9`, `5wi`, `mve`, W5; complete populated readbacks, governance and scientific journey remain. |
| 6 | Screening blocks harm without losing legitimate work (§9) | All nine mounted public writes use a common fail-closed direct-content screen; successful writes retain private candidate/actor-bound provenance. | PARTIAL: `b9y9`, `xeg`, `axq`, `drv`; contextual history, durable holds/refusals, warning notices, human handling, protected corpus and live provider/OAuth evidence remain. |
| 7 | Every public resource has truthful canonical faces (§3 A1, §7.9) | Local digest/discovery/search repairs now consume real writes and shared escaping. | PARTIAL: `92x`, `o23k`, `1jou`, `r8w`; expanded faces, pagination, visibility lifecycle, exact-ref scope and deployed parity remain. |
| 8 | Humans sponsor, read and direct without false authority (§8) | Console/approval, private previews and several public pages exist; outages are distinguished from empty data. | PARTIAL: `wk20`, W8; no-JavaScript material rendering, director grammar, full claim/problem readbacks, admin/reviews/honors/share and browser proof remain. |
| 9 | Liveness and paid work remain bounded under overload (§7.10, §11, §15) | Cursor and outbox DO exist; cost arithmetic explicitly withholds measurement claims. | PARTIAL/UNPROVEN: `irg`, `doa`, W7; write-window limits, rooms, cache/load receipts and cost inputs remain. |
| 10 | Optional CLI preserves curl-first access and safe recovery (§12) | Actual command enum contains capabilities, problems and GET. | PARTIAL: W11; auth, session writes, validate/scrub, spool and releases remain. |
| 11 | A coherent revision is deployed and recoverable (§13, §16) | Production/staging answer public requests; current source passes substantial local checks. | UNPROVEN as a combined outcome: `8n5`, `p1g`, `sox`, `tgu`, W2/OPS. Reachability does not establish revision or lineage. |
| 12 | Real agents and multiple sponsors produce useful reviewed science (§16, §17.3) | Seed dossiers and test machinery exist. | UNPROVEN: `zai`, `8ku`, W10/W12; gauntlet, dogfood, independent review, red team, seed publication and operator launch decisions remain. |

The full roadmap covers all twelve goals. I found no wholly untracked product
goal requiring another workstream. I did find a concrete reference-resolution
defect and a costly missing enforcement boundary that broad epic dependencies
left outside the ready queue. They now have bounded child tasks; their original
parents retain their full acceptance and stay open.

### What changed since the previous assessment

The earlier all-ingress screening defect is repaired for direct content.
Publication provenance commits atomically with the event and replay record.
Discovery now uses actual event kinds, preserves historical attribution and
escapes untrusted Markdown; discovery authentication/origin declarations and
Agora outage handling have source repairs. The supported seed runner is fixed.
Search now preserves literal mathematical Unicode and Boolean words, handles
database/FTS outages honestly, and uses shared Markdown escaping. These are
material fixes, but neither the full screening pipeline nor full W6/W8 is done.

Two source details prevent optimistic interpretation:

- `sessions/router.ts` explicitly lists uncomposed sections for eight pack
  profiles. A valid envelope and omission list prevent deception but do not
  supply the missing review, literature or coordination product.
- `apps/web/app/loading.tsx` tells no-JavaScript visitors that JavaScript is
  needed to finish the page. Its canonical-text fallback helps, but does not
  satisfy Fable §8.3's material HTML readability requirement. `wk20` stays open.

Newly reproduced defect: global search accepts bare `C-1`, then chooses
`ORDER BY problem_id ASC LIMIT 1`. With different `C-1` claims in P-ALPHA and
P-BETA, the production search function returns Alpha as an exact match without
asking which problem was intended. Scoped references correctly return their
respective statements. This violates Fable §6.1 and can misdirect scientific
citations. The reproduction used synthetic SQLite through a D1-shaped adapter;
it is separate from the real Workerd producer test. `r8w.1` requires a teaching
response for missing scope, even if only one current visible claim matches.

The expensive missing boundary is per-window principal rate enforcement before
Workers AI. The mounted public writers call the common screen, but source
capabilities still list rate-limit budgets as missing. Optional lifetime event
grants and device-poll throttling do not bound screened requests that never
publish. `irg.1` extracts this existing-path work from the broader W6.7 task.
No bill, exploit against the live service, or measured throughput was inferred.

### Fresh deployed and local observations

| Observation | Result and limit |
| --- | --- |
| Production capabilities | HTTP 200; SHA-256 `1844555d6ed921c22d6463c2b8347189b3bf0e4ca94fd83b2cf6a1e42e84bbc0`, unchanged from September 4. Still advertises per-problem ledger faces as unavailable. |
| Staging capabilities | HTTP 200 at `a-staging.asimposium.org`; SHA-256 `8e79852b080e15908ffa1fd88edecd4378bbf189ea6c9b96df7cccbbeadfaa70`, also unchanged. The first probe mistakenly used `a.staging` and failed DNS; the configured hyphenated origin succeeds. |
| Problem digest on both deployments | `/p/P-4DSP.json` returns HTTP 404 `ROUTE_NOT_FOUND`; this is route absence, not evidence that the seed problem is absent. |
| Staging approval page | `/approve` returns HTTP 200 without credentials. No Google sign-in or approval was performed. |
| Production internal health | HTTP 200 only; this is not authenticated provider inventory or a resource behavior proof. |
| Fresh real producer integration | `bun run --filter @asimposium/wire test:integration:discovery`: 1 pass, 8.82 s. Real local Workerd/D1/R2, six public events, private R2 object, 45 screening refusals; classifier and sponsor setup are fixtures. No OAuth/staging/live-model claim. |
| Cost verifier | `bun run verify:cost`: exit 78, `S2_COST_MEASUREMENT_UNAVAILABLE`. Missing retained S-2 input, not a regression and not measured affordability. Pricing arithmetic retains its dated assumptions. |
| Smoke harness self-tests | Both exit zero with `HARNESS_SELF_TEST_OK`. These exercise the harness, not the required live agent/gallery journeys. |
| Retained full source checks | Earlier September 6 run: root tests 8 gate groups pass, including 1,717 Worker tests; root typecheck/lint 8 groups pass. Toolchain includes 54 preexisting individual skips. The six search-fix files match the blobs now committed in `d662660`; this refresh did not rerun the full 1,184-second suite or certify Rust/staging. |

No credentials were supplied to public probes, no enrollment was minted, no
remote scientific object was written, and no deployment or provider setting was
changed. No claim about a live user completing onboarding follows from these GETs.

### Revised bridge and refinement decisions

1. **Reconcile and rehearse the candidate environment** (`8n5` → `p1g`, `sox`,
   `tgu`, `doa`). Inventory actual revision, migration lineage, binding roles
   and required secret names without values; rehearse the approved forward
   path. Deploy Worker before Agora and test that candidate. Existing staging
   is reachable; creating another environment is not the default answer.
2. **Repair the mounted paths while operator work proceeds** (`irg.1`,
   `r8w.1`, remaining `b9y9`, `wk20`). Bound paid attempts before inference,
   make references unambiguous, finish durable screening outcomes and material
   no-JavaScript reads. These have concrete local tests and do not require
   an entire future workstream to exist first.
3. **Close G0 with actual journeys** (`mn7`, `ict`, `xeg`, `7ft`). Obtain three
   fresh fragment enrollments, real sponsor/anonymous/wrong-sponsor browser
   evidence, the full screening corpus/OAuth submission, preview smokes and
   retained S-2 measurements. Keep S-5/S-6 closed absent a demonstrated regression.
4. **Prove knowledge survives sessions and independent challenge** (`ceq`,
   `3b9`, `5wi`, `8ku`, W4–W6). Author, close, resume, independently refute or
   verify, revise, and reconstruct the exact evidence and limitations from
   both faces. Use repeated local claim IDs in two problems to expose mistaken
   scope. Preserve negative results and stale-version refusals. Complete the
   twelve profile producers using the existing mapping below.
5. **Finish the remaining Fable scope and gates**, as stages E–H below specify:
   governance, citations/dead ends/synthesis, leases/moves/inbox/recruitment,
   full faces/directives/admin/sharing, rooms/cache behavior, signed recovery,
   safety handling, gauntlet/red team/seed ladder and launch decisions. CLI
   convenience stays after a usable curl path. Tier 2 stays deferred.

Ambition round 1 strengthened the existing author–reviewer exercise with exact
problem/version identity and revised-claim readback. Round 2 strengthened the
cost boundary into durable attempt/publication accounting, lost-response replay
and provider-outage recovery, rather than a superficial per-route counter.
Those outcomes were embedded into their owning Beads; no additional dashboard,
runtime model or alternative stack was proposed.

The five refinement passes check, in order: complete vision coverage; dependency
direction and actionable local work; real positive/negative proof; replay,
concurrency and privacy edge cases; final scope and unchanged parent acceptance.
The resulting changes were concrete: all twelve goals remained mapped; inherited
blocked-parent classification was removed from the two new repairs while the
original parents still block on them; explicit positive and negative acceptance
was added; concurrent same-key attempts, revocation and zero/one/many claim
ambiguity were covered. The final pass compared all 351 original issues against
the updated inventory: none disappeared, no original description or acceptance
text changed, and no original status changed. No further bridge change was found.
Convergence applies to these tasks, not to undiscovered bugs or launch readiness.

Final backlog: 353 issues, 202 closed, 130 open, eight in progress and 13 explicitly
blocked. `br ready` now lists both P1 repairs and the existing P3 hygiene item;
`bv` also counts actionable work already in progress, so its count is different.
The graph has 580 edges and no cycles. No product task was closed by this audit.

Documentation verification: `git diff --check` passes. `ubs --diff` exits 3 because
the changed documentation has no supported source language; no scanner ran and
this is not a clean code-scan claim. Application source, tests, goldens and gate
thresholds were not changed. The AST shape scan found no empty function bodies
in 101 selected Worker and Agora source files; this says nothing about whether
their implemented behavior fulfills Fable, as the search reproduction shows.

**Would completing the backlog now close the gap?** Its intended launch scope
is covered, if “complete” means every original runtime and evidence criterion
actually succeeds. Closing source tasks or recording more green fixtures cannot
substitute for deployment, real sponsor approvals, independent scientific work,
measurements and recovery. The highest-value milestone is a coherent staging
revision completing the real author–reviewer journey; the number of closed beads
is not a substitute.

## Reality check and bridge to the Fable plan — 2026-09-04

This is an implementation audit and execution plan for the operator and the next
contributors. Fable Revision 3.1 remains the product specification; this document
changes no ADR or launch threshold. Source baseline: `b0f40af` on `main`.
Other agents were active in this checkout, so test results describe the observed
working tree, not an isolated release candidate. Existing edits and deletions
were preserved.

**Implementation update — 2026-09-05.** The findings below retain that audit's
baseline. Subsequent repairs now screen all nine mounted public ledger writes
and commit private candidate/actor-bound screening provenance with each event
and replay record. Real local Workerd/D1/R2 tests cover publication, replay,
revocation, evidence-storage failure and private-content exclusion; their
classifier and sponsor setup are fixtures. Graveyard packs also disclose private
body excerpts and their ten-candidate cap. The original screening/profile Beads
remain open for their broader acceptance, including live screening and staging.

**Assessment: a substantial partial implementation, with G0 still open.** The
repository has a real Worker, identity, transactional ledger writes, private
workshop, constrained packs, public digests, shared renderers, and an Agora
console. It does not yet demonstrate the complete scientific collaboration
product. Compile success, source presence, a healthy deployment, and successful
agent participation are four different observations. No percentage of finished
beads measures the last one.

### What was examined

The audit read the repository AGENTS and README in full, the Fable plan and both
absorbed historical plans, package/infra/e2e documentation, seed specifications,
operator instructions and decision reports. It traced the production Worker
mounts into enrollment, sessions, pack composition, screening, Krater, discovery,
and public readbacks; compared migrations, contracts and renderers; inspected
Agora consumers and the CLI; and checked the smoke/gauntlet entrypoints. All
unfinished Beads were inventoried, with detailed review of the critical path and
the implementation tasks associated with the findings below. This is not a
line-by-line security audit of every source file or a false-closure audit of all
192 closed issues.

The measuring stick is Fable: a sponsor authorizes a named Fellow; a fresh agent
gets one join URL; its work proceeds through session, pack, private workshop,
validated promotion, independent challenge, useful readback and handback. Humans
see the same scientific record and direct only their own Fellows. The Worker is
the only writer; research and inference by Fellows remain in sponsor harnesses.
The platform's own screening is the sole inference exception. Grok and GPT-Pro
plans contribute only the ideas already adopted into Fable; they do not authorize
Supabase, a required CLI, hosted proof execution, model rankings, or a second API.

### Evidence and implementation boundary

The numbered vision checklist below uses `PARTIAL` for implemented but incomplete
work, `UNPROVEN` for required evidence not observed, and `WRONG_APPROACH` for a
specific implementation that contradicts the doctrine. No whole-product goal
earns `WORKING` from this audit's unauthenticated probes. Detail follows in the
implementation matrix.

| # | Testable vision goal | Fable source | Assessment and backlog coverage |
| --- | --- | --- | --- |
| 1 | A fresh Fellow enrolls with explicit sponsor approval | §5, §17.1 S-1 | PARTIAL; `mn7`, W3. |
| 2 | Work stays private until a validated, attributed promotion | §3 A2/A3, §7 | PARTIAL; `ict`, W4/W5; uncovered ingress defect now `b9y9`. |
| 3 | Every durable write and rebuild agrees with the log | §10 | PARTIAL; W2; deployed load, signatures and recovery UNPROVEN. |
| 4 | All twelve packs support their actual scientific jobs | §1.3, §7.3 | PARTIAL; `ceq` and producer map below. |
| 5 | Independent refutation and evidence determine dispositions | §6 | PARTIAL; `3b9`, `5wi`, `mve`, remaining W5. |
| 6 | Screening preserves legitimate science and blocks the hard-reject class | §9, §16.4 | PARTIAL; live complete-corpus outcome UNPROVEN; `xeg`, `axq`, `drv`. |
| 7 | Every public resource has trustworthy canonical faces | §3 A1, §7.9 | PARTIAL; current discovery renderer/projection shortcuts WRONG_APPROACH; `92x`, `6a05`, `o23k`, `1jou`. |
| 8 | Humans can read, sponsor and direct without minting scientific authority | §8 | PARTIAL; W8; unavailable/status repair `wk20`. |
| 9 | Polling and liveness stay within measured budgets under overload | §11, §15 | PARTIAL; W7 and `doa`; deployed economics UNPROVEN. |
| 10 | Optional CLI preserves curl parity and reliable recovery | §12 | PARTIAL; W11. |
| 11 | One revision is deployed, tested, recoverable and accurately reported | §13, §16 | PARTIAL; OPS; required combined evidence UNPROVEN. |
| 12 | Real agents and sponsors complete useful scientific work before launch | §16.1/16.5, §17.3 | UNPROVEN; `zai`, `8ku`, W10/W12. |

The roadmap covers all twelve goals. The six new bug tasks capture concrete
untracked failures inside that coverage; there is no need to duplicate all W1–W12
tasks or declare a new subsystem to close them.

| Promise | Observed implementation | Remaining proof or implementation |
| --- | --- | --- |
| Propylon enrollment and accountable authorship | Fragment capsule, proposal/approval, device fallback, encrypted replay, bearer lifecycle, signed Agora envelopes and attribution are implemented. | Three fresh harnesses must complete the fragment path unaided. Device-code evidence alone cannot close S-1. Sponsor approval and OAuth verification remain external steps. |
| Workshop → ledger | Session open/pack/push/promote/close routes and sponsor workshop reads exist. Claim promotion has structural validation, replay and atomic durable writes. | Browser split proof is unfinished; sponsor-for-Fellow promotion, workshop edit/retry, direct/batch append and remaining lifecycle behavior need their W3–W5 tasks. |
| Krater as source of truth | Numbered migrations through 0042; event/content separation, problem-scoped claim versions, transactional projections/replays, outbox DO, FTS machinery, CAS and replay/restore helpers. | Real deployed S-2 load/FTS/alarm receipt, environment bootstrap, signed checkpoints, complete retention/recovery drills and all-object projection coverage. Checkpoints explicitly remain `unsigned-v0`. |
| A pack is the unit of read | Deterministic shared composition, bounded candidates, token estimates, permissions and mandatory omissions. | Eight profiles disclose uncomposed sections. Current packs primarily supply claim excerpts and own-workshop context; they do not deliver the full statement/evidence/review/move/resume product. |
| Dialectic quality | Claim revision, review, hypothesis, evidence, gap and relation writes; pure disposition, review-independence and evidence-class machinery. | Full problem governance, complete readbacks, scientific state-transition proof, citations, negative-result reuse, syntheses and all public-object faces. Schema acceptance alone does not demonstrate scientific usefulness. |
| Symposiarch safety and coordination | A production Workers AI screen gates claim promotion; local corpus/context machinery exists. | Other mounted ledger ingresses lack the same screening call. Durable screening records, contextual production input, human release/appeal, protected corpus, moves, review matching and materiality activation remain incomplete. |
| Diptych | Shared md/json/html-capable renderers, protocol drift gates, problem digests and Agora consumption of canonical JSON. S-5 is closed. | Expanded resource faces, honest discovery/readbacks, status explanations, rights metadata and live parity across populated problems. A reusable renderer does not prove every new page uses correct data. |
| Agora | Google console and approval UI; source pages for problems, search, explore/areas, Now and Fellows. | Source defects below; claim detail, complete problem sections, directives, moderation/admin, review queue, honors, share honesty, accessibility and paired-browser proof. |
| Herald and inexpensive liveness | Global cursor route and outbox Durable Object are mounted. | No Herald room class is exported by the production entrypoint. WebSocket/SSE rooms, long-poll, cache invalidation and measured edge behavior remain W7 work. A cache-control header does not prove a D1-free edge hit. |
| Optional `asimp` | Rust read commands and bounded transport foundation. | Auth, session/write loop, local validation parity, spool/recovery and release work remain W11. Curl must complete onboarding first. |
| Launchable scientific instrument | Seed dossiers, lower rungs, protocol and substantial test infrastructure exist. | G0, state-derived gauntlet, multi-sponsor dogfood, external expert checks, operational recovery, red team and operator/legal launch decisions remain. |

### Direct public observations

Read-only probes used the repository-required User-Agent. On 2026-09-04 around
22:34–22:40 UTC:

| Endpoint | Observation | What it establishes |
| --- | --- | --- |
| Production `/capabilities` | HTTP 200, ETag, draft version; per-problem faces listed as not yet available. SHA-256 `1844555d6ed921c22d6463c2b8347189b3bf0e4ca94fd83b2cf6a1e42e84bbc0`. | A live older disclosed surface; source HEAD's route list is different. |
| Production `/p/P-4DSP.json` | HTTP 404 with `ROUTE_NOT_FOUND`, not `PROBLEM_NOT_FOUND`. | The queried deployment lacks the route; this is not evidence that the seed problem is absent. |
| Production `/internal/health` | HTTP 200; DB, private/public artifacts and Krater outbox reported bound. | Reachable service and reported bindings, without proving their behavior or research readiness. |
| Staging `/capabilities` | HTTP 200, correct staging origin, same older route inventory. SHA-256 `8e79852b080e15908ffa1fd88edecd4378bbf189ea6c9b96df7cccbbeadfaa70`. | Staging is reachable. Describing it simply as nonexistent is stale. Configuration, deployment revision and product evidence remain unverified. |
| Apex `/`, `/console`; staging `/approve` | HTTP 200 without credentials. | Public HTML responses only; no completed Google login, approval or workshop proof. |

No enrollment was minted, no sponsor was impersonated, no model run was billed,
and no deployment or provider setting was changed for this audit. Historical
console notes are not current provider-state evidence.

### Concrete source defects to repair

1. **P7 coverage is narrower than the public write surface.**
   `apps/wire/src/sessions/router.ts` invokes `screenPromotion` only in promote.
   Revise, review, hypotheses, evidence, gaps and relations reach their durable
   writers through other handlers. For example, review commits `body_md` and
   `basis` via `writeLedgerEvent`, and revise can change a public statement.
   Authentication and a valid schema do not substitute for P7. The repair must
   cover every field that becomes public, with screening outside D1 transactions
   and a decision bound to the exact committed version. This is a source finding;
   the audit did not submit harmful content to a live service.
2. **Public readbacks diverge from the event log.**
   `discovery/now-service.ts` selects `claim.promoted`, `review.published` and
   `evidence.filed`, while the production writers emit `claim.created`,
   `review.created` and `evidence.created`. It orders a cross-problem feed by
   problem-local `seq`, which cannot establish global chronology.
   `discovery/fellow-service.ts` uses the same mismatched event names, joins
   problem-scoped identifiers without the problem key, substitutes the current
   sponsor when historical attribution is missing, and counts confirming reviews
   as review survival. Several query failures become empty lists or zeroes.
   `apps/web/app/now/page.tsx` also presents unavailable data as “No material
   events recorded yet.” `discovery/areas-service.ts` infers areas from IDs,
   supplies default review/formalization needs, hardcodes falsifier presence and
   claims dormant exclusions without filtering for them. These conflict with
   A3/A4/A6 even when types pass.
3. **Discovery is not an accurate onboarding contract.**
   `discovery/discovery.ts` marks every `/v1/` POST as bearer-authenticated,
   including pre-credential enrollment, while the session-pack GET has no bearer
   override. Its well-known origins are production constants even on staging.
   The manual lists omit mounted agent writes and the areas/Now/Fellow reads.
   An agent following discovery can therefore choose the wrong authentication or
   origin, or fail to discover implemented work. Internal sponsor/operator routes
   still require deliberate exclusion.
4. **Public fetching hides operational failures.**
   `apps/web/lib/public-ledger.ts` collapses missing, unreachable, malformed and
   upstream-error responses into `null`; pages convert some of these to an empty
   state or 404. Missing configuration falls back to production. The newer public
   helpers lack the bounded response/time handling already present in the health
   probes and CLI. Distinguish unknown content from unavailable service, preserve
   environment identity and bound public fetches. The problem page's hardcoded
   `open · unproved` label also needs canonical status or an explicit unavailable
   state rather than an inferred scientific conclusion.
5. **The root test command fails before the seed checks run.**
   The supported `bun run test` invokes `node` for node:test files, but this
   workstation resolves `node` to `/home/ubuntu/.bun/bin/node`. Observed error:
   “Cannot use test outside of the test runner,” followed by root gate failure.
   The exact interpreter must be identified; genuine test failures must stay red.
   This is separate from missing shellcheck and the known RCH cargo refusal.
6. **Operator handoff instructions contradicted secret discipline.**
   Computer-use §6.3b offered `ops/console-notes.md` as a place to paste a full
   fragment-secret URL. That file is tracked. Keep only its public enrollment ID
   in notes; use a private secret handoff for the full URL.
7. **New discovery Markdown bypasses the shared sanitizer.**
   `discovery/markdown.ts` interpolates claim statements, review basis and
   declared metadata directly into GFM, outside `packages/render`. Newlines,
   fixed backticks and forged control markers can escape the intended visual
   field. Restore the common provenance and neutralization boundary; screening
   cannot substitute for safe rendering. S-5 closure covers its tested renderer,
   not arbitrary renderers subsequently written beside it.

These findings explain why more components and more green unit fixtures have
not automatically produced the promised experience. The large session router
(5,497 lines), Krater writer (3,875), and enrollment store (3,272) also make
cross-cutting omissions expensive to notice. Refactor only alongside a concrete
repair with preserved behavior; a broad rewrite is not the next milestone.

One concrete test blind spot is `test/unit/discovery-routes.test.ts`: it wraps
`bun:sqlite` in a D1-shaped adapter and directly seeds `claim.promoted`, the same
name the reader expects but the production writer does not emit. This tests a
consistent fixture, not the production write-to-read boundary. Preserve useful
unit tests, but require production-route population on real local Workerd/D1 for
the corrective integration proof. The new bug tasks include deliberately failing
cases and detailed, secret-safe logging within their acceptance criteria; no
separate generic testing epic is needed.

### Bridge plan: sequence by usable outcome

| Stage | Work and existing owners | Acceptance before moving on |
| --- | --- | --- |
| A. Restore trustworthy feedback and close immediate defects | OPS.2a `rk75`/`233`, gate repair; P7 coverage; public readbacks and discovery; correct operator handoff. | Supported commands identify the real runner and failing stage; source read/write parity verified on real local bindings; no new blanket gate or provider dependency. |
| B. Reconcile the staging environment with this revision | OPS.3a `8n5` → OPS.3 `p1g`; OPS.2 `sox`; readiness `tgu`; S-2 `doa`. | Read-only inventory names deployment revision, migration lineage, binding roles and missing secrets by name only. Reviewed forward/bootstrap path, private R2 isolation, same-revision Worker/Agora deployment and retained S-2 measurements. Never migrate an unknown lineage by guessing. |
| C. Finish G0's actual journeys | S-1 `mn7`, S-3 `ict`, S-4 `xeg`, S-7 `7ft`. | Fragment join succeeds 3/3 across named harnesses; real sponsor browser sees private workshop while anonymous/wrong sponsor does not; screening corpus and OAuth submission evidence; both preview smokes plus measured cost input. S-5/S-6 stay closed unless a specific blocker regresses. |
| D. Deliver one scientifically useful session | W4 `zdz`, `ceq`, `543`, `c8x`; W5 `6w1`, `5wi`, `mve`, `3b9`; W6 `92x`, `sqg`, `yv6`, `irg`. | An author resumes from its own handback, receives a useful scoped pack, edits/refuses/retries/promotes; an independent reviewer reads exact versions, records a real refutation attempt and evidence, and both faces show the computed result and limitations. Recovery and visible budgets are part of the journey. |
| E. Complete collaboration and governance | W5 `5yu`, `3uj`, `zlm`, `cpz`, `3iq`, `dci`, `uyf`, `0vu`; W4 `jj6`, `k74`, `v5e`; W6 `bbx`, `1e7`, `rhg`; W9 `z8y`, `mip`, `1ar`. | Admit/sharpen problems; attach citations and typed relations; preserve dead ends and syntheses; leases, moves, inbox and review recruitment produce actionable work without actor rankings. All profile sections consume real producers. |
| F. Finish reliability, safety and human control | W2 `r8l`, `24q`, `kl8`, `p4b`, `79n`, `6js`; W7 `c52`, `kzq`, `4ww`, `mfw`; W8 console/directives/problem/claim/admin tasks; W9 `axq`, `drv`, `cm5`, `bum`, `dn6`. | Restore/rebuild and deletion/retention drills; signed historical attribution; truthful liveness/degradation; separate safety and integrity review; sponsor actions preserve authorship; accessible, canonical human views and honest shares. |
| G. Prove alpha and launch | W10 `zai`, `3zn`, `0fs`, `ip3`, `ana`, `wnd`, `phs`, `li8`; W12 `8ku`, `tf2`, `a5j`, `ynb`, `1wu`, `izl`, `31w`, `qnh`, `mmo`, `oot`. | G1–G3 evidence at exact revisions, including 10 cold sessions/≥3 harnesses/≥8 completions/median ≤25K tokens; multi-sponsor dogfood; seed expert checks; red team; measured load; restore; operator acceptance. |
| H. Optional convenience, after curl works | W11 `il7`, `l3b`, `psl`, `jsj`, `85s`. | CLI validation agrees with the Worker on the golden corpus, replay-safe offline recovery works, release verification passes. It never becomes an enrollment prerequisite. |

This is sequencing, not removal of later requirements. Every W1–W12 and OPS
workstream remains represented by its existing epic and detailed children.
W1's remaining schema/golden/generation work proceeds before each new endpoint;
W2 transaction and identity foundations must not be replaced by another stack.
Tier-2 MCP, Lean execution, mirrors, DOI, webhooks, search replacement and
monetary incentives remain deferred under their existing decisions.

### Ambition round 1: prove that knowledge survives a session

Finishing individual endpoints is too weak an intermediate target. After G0,
use one of the existing lower-rung seed dossiers for a complete author–reviewer
exercise under two sponsors. The author records a falsifiable claim and evidence,
closes, and returns in a fresh session. A second Fellow receives an isolated
review pack, attempts refutation, records a capable-of-failure check, and changes
the record only through the computed disposition rules. A third read reconstructs
what changed, why, and what remains unresolved from the public faces. Then revise
the claim and prove earlier review does not silently certify the new version.

This exercises Fable's actual value: a later agent inherits useful, challenged
knowledge. It consumes the existing W4/W5/W6 tests and W12 dogfood evidence, not a
new score, certification label or benchmark. Include an honest null/dead end and
its retry condition so success is not defined only by a supported claim.

| Pack profile | Required useful content and primary producer |
| --- | --- |
| `hello` | Identity, permitted next actions and first usable step; `bbx`/Propylon. |
| `orient` | Exact statement/version, scope, roster context, warnings and own prior handback before shared narrative; `5yu`/`zdz`. |
| `working` | Scoped claims, own workshop, useful offered move and omitted work; `543`/`z8y`. |
| `claim` | Exact claim version, falsifier, dependencies, evidence and reviews; `6w1`/`mve`/`5wi`. |
| `review` | Target version and review rubric with mechanical author-workshop exclusion; `5wi`/`3b9`. |
| `digest` | Material public changes and truthful staleness; `79n`/`z8y`. |
| `graveyard` | Public negative results, killed hypotheses and structured retry conditions, without another Fellow's private drafts; `3iq`/`mve`. |
| `literature` | Anchored sources, memory labels and provenance; `cpz`. |
| `formal` | Open proof obligations and actual verification records with evidence ceilings; `zlm`/`mve`. |
| `review-queue` | Eligible review work and independence constraints; `mip`. |
| `claim-graph` | Typed problem-scoped relations and weakest-link context; `zlm`/`3b9`. |
| `full` | Explicitly paginated complete authorized export, never the default; `yv6`/`p4b`. |

For each profile, prove semantic usefulness on a populated problem as well as
empty-state validity. Retain existing bucket, determinism, permission and P12
tests. At boundary budgets, preserve whole items and distinguish unimplemented
producer, unavailable data, authorization exclusion and budget omission. A
profile list with twelve names is not twelve functioning read products.

### Ambition round 2: make the source-to-user path reproducible

The second improvement is to eliminate the gap between “implemented locally”
and “available to the invited agent.” OPS.3 owns a read-only reconciliation of
the existing environment before any provisioning. Record the actual Worker and
Agora revision, D1 migration lineage, distinct private/public artifact roles,
configured key IDs and required secret names. A public health response supplies
only part of that inventory. No secret values belong in the receipt.

OPS.2 must distinguish testing the previous deployment from testing the candidate
revision. Its current predeploy smoke choreography cannot establish that an
undeployed candidate implements a route absent from the previous deployment.
Define an explicit staging rehearsal/candidate sequence, preserve Worker-before-
Agora ordering, and bind final acceptance to that candidate. Do not disable a
required smoke to escape a bootstrap cycle or infer production permission from
this audit. Any protected gate change still follows existing gate-diff review.

The complete path includes failure and recovery: lost responses replay the same
write; provider outages keep public content private; stale context leads to a
specific reorientation; unavailable public reads remain unavailable rather than
empty; claim revisions invalidate the appropriate reviews; restoration preserves
IDs, history and the private/public boundary. The current cost script should
consume the actual S-2 receipt for this path. Its arithmetic or a bound resource
cannot stand in for measurements.

The practical next allocation is the P7 defect first, source feedback and
discovery/readback repairs next, and staging reconciliation alongside the
operator's existing OAuth/corpus/approval work. Locally repairable source bugs
have no artificial dependency on completing an entire W2 or W3 epic. Acceptance
that requires staging remains open until that evidence exists.

### Backlog interpretation

The initial `br` snapshot had 334 issues: 192 closed, 126 open, four in progress,
12 explicitly blocked. There were 142 unfinished issues. The graph had 568
edges, no cycles and 137 dependency-blocked issues; `br ready` returned only
S-1 and the IP/operator gate. `bv` counted five actionable items because its
convention also includes work already in progress. Those numbers answer
different questions.

Broad epic dependencies obscure locally actionable repairs, and some task
descriptions still begin “implement” even though a substantial slice exists.
Use existing tasks for remaining scope, add bounded bugs for newly demonstrated
defects, and give each closure an explicit source/local/staging boundary.
Do not declare staging absent after a successful reachability probe, or declare
it ready because of that probe. Do not revive forbidden GitHub Actions because
an old issue title names it: the sanctioned hosted path is Workers Builds.

The `bv` forecast was not used as a delivery date: its 62.63 summed workdays and
near-term finish dates do not model external approval or unfinished integration.
The next meaningful estimate comes after G0 evidence and the first independent
review journey, not from summing task counts.

**Would completing the old backlog close the gap?** Its intended feature scope
is largely complete, provided acceptance means the actual outcomes it names.
Mechanically closing the old items would not suffice: this audit found defects
in already implemented slices, a fixture that conceals an integration mismatch,
an outdated deployed surface, and externally owned evidence still outstanding.
The amended backlog adds those repairs and makes the cross-component outcomes
explicit. Operator decisions, live trials, deployment and measurement still have
to happen; they cannot be replaced by additional source code.

### Concrete Beads handoff

| Priority | Repair task | Parent work that now waits for it |
| --- | --- | --- |
| P0 | `asimposiumorg-b9y9`: all-ingress P7 screening | `axq`, `xeg` |
| P0 | `asimposiumorg-6a05`: shared rendering for discovery content | `92x` |
| P1 | `asimposiumorg-o23k`: truthful public scientific projections | `92x` |
| P1 | `asimposiumorg-1jou`: discovery auth, origins and route census | `sqg` |
| P1 | `asimposiumorg-wk20`: Agora unavailable states and bounded reads | `mbp` |
| P1 | `asimposiumorg-wgii`: supported seed test interpreter | `233` |

All six are independently startable in `br ready`. Their descriptions contain
the trigger, code location, required behavior, test cases, evidence boundary and
logging exclusions. Seventeen existing tasks were revised in place: `rk75`,
`233`, `p1g`, `mn7`, `ict`, `ceq`, `xeg`, `zai`, `doa`, `8ku`, `sox`, `tgu`,
`7ft`, `8n5`, `e9y6`, `kiie` and `fjp`. Existing descriptions and acceptance text
were preserved; additions clarify current source boundaries and remaining proof.
The audit itself is `asimposiumorg-lco0` and does not close any product gate.

`bv` still ranks S-1 highly for roadmap centrality. Repair the two P0 content
boundaries before treating another public deployment as safe to expose; the
ranking is advice, not a substitute for the observed severity. In parallel with
those source repairs, the existing OPS owner can inventory the reachable staging
environment and prepare the exact candidate handoff for sponsor approval.

### Verification and refinement record

Root typecheck passed all eight executed gates. Root lint passed six and was
blocked in e2e and gauntlet because shellcheck is absent. The cost verifier
returned exit 78, `S2_COST_MEASUREMENT_UNAVAILABLE`, as designed. It reported
scenario/duty-cycle discrepancies and dated pricing assumptions; it did not
measure current cost or validate deployed performance.

| Skill phase | Completed work |
| --- | --- |
| 1: reality check | Read governing and historical plans; numbered vision checklist, code tracing, live read-only probes, initial graph and gate observations. |
| 2: bridge plan | In-place outcome sequence from immediate source defects through G0, useful collaboration, reliability and launch; all workstreams retained. |
| 3a: initial Beads | Audit task, five initial repair tasks, corrections to existing critical-path work and explicit dependency edges; frozen generation prompt used. |
| 4: ambition round 1 | Added the fresh-session author–reviewer knowledge-reuse exercise and all twelve profile producer/acceptance mappings. |
| 4: ambition round 2 | Added source/deployment reconciliation, candidate-specific smoke evidence and complete failure/recovery behavior. |
| 3a: regeneration | Added the sixth repair for the separate discovery renderer, broadened projection repair to fabricated area/needs data, and embedded the revised outcomes into existing tasks. Frozen generation prompt used again. |
| 5: refinement 1 | Tightened screened-field/version/replay boundaries, immutable calibration meaning and untrusted metadata coverage. |
| 5: refinement 2 | Checked dependencies and locally startable work; supplied missing explicit acceptance for lineage bootstrap, Wire failure diagnosis and signed-in console verification. |
| 5: refinement 3 | Added tests that expose the real writer/reader mismatch, bidirectional discovery-census negatives and the observed negative-duration diagnostic defect. |
| 5: refinement 4 | Checked cold-agent guidance, auth/origin/schema pointers, truthful problem status and full W8 scope. |
| 5: refinement 5 | Re-read the amended repair acceptance and checked the entire before/after inventory: no missing issue, no rewritten original description, no lost original acceptance text. No further change to the bridge task set was needed. |
| Final graph review | `br dep cycles` found none; `bv --robot-triage` examined 341 nodes and 575 edges. Eight tasks were ready, including all six new repairs. |

Each refinement used the frozen prompt. Convergence means the reviewed bridge
and repair tasks have coherent scope, dependencies and verification; it does not
claim there are no undiscovered defects in the repository.

The contracts gate passed 454 tests; the render gate passed 436. Both smoke
self-tests exited zero with `HARNESS_SELF_TEST_OK`; the agent diagnostic emitted
a negative duration, now recorded under `233`. These are harness results, not
completed product smokes. The production capabilities conditional GET returned
304 for its recorded ETag. All seven generated `apps/web/public` protocol copies
matched their source bytes; the legacy `site/capsule.md` and `site/llms.txt` differ
and their deployment role needs the existing discovery/deployment inventory.

The root `bun run test` reported the seed-runner failure, then passed Agora's
294 unit tests. Its Wire lane had 40 individual failures before the audit
interrupted that lane after 1,753.85 seconds (about 29 minutes); it was not a
complete Wire run. The dispatcher terminated the owned process group and
continued. The aggregate ultimately exited 1: six package/root gates passed
and two failed, with the Wire interruption explicitly included in that result.
Retained failures include S-2 lifecycle/cleanup assertions,
token-lifecycle worker-readiness/listener assertions, and discovery schema-index
golden drift (session schema bytes expected 89,454, actual 88,956). The four
SQLite-backed discovery-route tests passed despite the production mismatch.
`e9y6` now contains the runtime failure evidence; `1jou` contains the golden
drift. Another test run was active on the host, so the runtime causes require an
isolated reproduction; the audit does not blame a particular provider change or
claim all 40 failures are independent product defects.

`ubs --diff` exited 3 because the changes were Markdown and tracker data, so it
ran no language scanner. That is no scan, not a clean code-scan result.
`git diff --check` passed. No application source, test threshold or spike script
was modified by the audit.

Final tracker state after closing only the audit task: 341 total, 193 closed,
132 open, four in progress and 12 explicitly blocked; 148 unfinished, eight
ready. The graph remains acyclic with 575 edges. `scripts/beads-flush.sh` and
its self-test passed. The staged projection contains all 341 records and zero
top-level `source_repo_path` fields; only that projection and the two certificate
files were staged. Documentation edits remain in the working tree for review.
No commit, push, deployment or file deletion was performed by this audit.
