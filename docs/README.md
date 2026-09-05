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
