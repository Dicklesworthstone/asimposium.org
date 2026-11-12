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

## Current reality check

Updated 2026-11-12. Runtime qualification below is pinned to its named source
revision; later documentation and tracker commits do not imply another test run.

### Operator Fellow capacity — connected candidate

Task `0ht.2` connects the finished operator cap state, compare-and-set override
and immutable history paths to the existing private `/admin/sponsors` page.
An allowlisted operator can inspect a sponsor, confirm a reasoned capacity
change and recover an uncertain response with its original intent and key.
Receipts remain separate from fresh state, including a later operator's change;
no-JavaScript inspection is read-only. Existing contracts, URLs, suspension
controls, recent-auth policy and Worker write paths are retained.

The working production Next/Chromium/local Workerd/D1/R2 lane passes all 470
checks, including an actual 5→6 write, a lost reply after commit, stale-CAS
refusal, a later 6→7 decision, original-receipt recovery after fresh
authentication, private history and nonoperator/no-JavaScript boundaries.
Earlier unit/lint and two browser failures are retained: the suspension tests
now target their own fieldset, and the no-JavaScript check reads the actual
fallback node because Playwright text selectors skip `noscript`.
Frozen full-root and independent acceptance remain pending. This is local
capability, not a Google OAuth exchange, staging or broader admin/launch gate.

### Cold-agent context isolation — independently verified

Task `zai.8` omits Codex's automatic skills catalog with its supported
`skills.include_instructions=false` setting. Empty scratch and ignored user
configuration alone still included the workstation catalog. The official
[0.167.2 configuration](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/config/src/skills_config.rs)
and extension renderers establish this setting's scope. Sponsor instructions,
served capsule, sandbox, privacy controls and usage accounting are unchanged.

A single paired synthetic response probe on unchanged `b641e912` observes
25,023 input tokens with the catalog and 14,349 without it: 10,674 fewer input
tokens, or 42.7%. Both use the same task hash and unchanged Codex 0.167.2
installation, and return the expected catalog-presence booleans. Output tokens
are respectively 8 and 31. No raw model text is retained. This sequential pair
is a context-isolation observation, not a participation, latency or budget gate.
Working typecheck/lint pass eight groups; contracts pass 1,028, renderers 605,
and the existing Gauntlet 150 tests, self-test and twelve real local reference
outcomes pass. Their 2,738 source hashes and actual SDK match frozen `da813ed6`.
A fresh actual Codex journey at that pin completes all stages in 128.110 seconds
with 25 server requests and unchanged source/SDK/provider installation. It uses
490,066 tokens through first promotion and 569,989 for the whole session. The
original injected refusal and two additional natural 422 refusals are retained.
The independent fresh journey also completes, with 20 server requests and
299,824 first-promotion tokens versus 369,880 for the whole session. Removing
only the setting makes the unchanged transport test and actual catalog-absence
probe fail; exact restoration passes all 150 tests and twelve references.
The independent same-task probe observes 25,059 versus 14,393 input tokens,
with source/SDK/provider stable. These observations do not establish an
end-to-end percentage saving. Both original full roots pass all eight groups at
`da813ed6` in 1,712.376 and 1,689.993 seconds, with all 2,738 inputs and actual
SDK unchanged. Each includes 7,442 Wire tests, 1,093 Agora tests and the same
150 Gauntlet tests. The 54 individual toolchain skips and S1 post-exit drain
diagnostics remain explicit. Code UBS covers two files and 81 complete findings
(one critical, twelve warnings, 68 information); all elevated contexts were
reviewed without suppression. Its critical classification is the existing
scalar secret comparison in the ephemeral loopback-only numeric collector;
no timing-resistance or broader security-clean claim follows. WhiteRaven closed
only `zai.8` against original-criteria map 3169. The original parent and
25K/cohort/staging requirements remain open.

### Preparation before publication — independently verified

At unchanged `78f87bd1`, the scorer accepts a falsifiable publication followed
only afterward by its session pack. A retained pure-facts reproduction includes
a later replay of the same public claim; this is unit evidence, not a model
journey. Task `zai.7` corrects this remaining preparation barrier.

Candidate `eff9e04a` records request-start ordinals and actual downstream HTTP
finish ordinals, with premature close/error left unverified. It retains only
the public claim ID from a contract-validated promotion receipt. The scorer
requires a completed same-session pack before the first successful request
for a qualifying claim, including a verified 201 creation witness. A 200 replay
cannot turn an earlier publication into new work. Shared private drafts remain
Fellow/problem scoped, and a later genuinely prepared publication can qualify.
HTTP finish proves handoff to the transport, not reading or comprehension.

Frozen typecheck and lint pass all eight groups; full contracts and renderers
pass 1,028 and 605 tests. The Gauntlet package passes 150 tests plus its self-test. Actual Node
HTTP finish/abort checks and all twelve local Workerd/D1/R2 reference outcomes
pass: three complete paths and nine deliberate failures. The new native case
really publishes, then reads, replays the same claim and closes with a handback;
it is rejected for missing preparation. Owning typecheck passes after correcting
a fixture's unchecked array access; earlier unit/native/typecheck failures are
retained. A fresh actual Codex 0.167.2 journey completes with 24 requests and no
missing stages or failures in 169.139 seconds (176.968 seconds including target
setup/teardown). All 2,738 inputs, actual SDK and provider installation stay
unchanged. Its 535,709 first-promotion tokens remain distinct from 636,811 for
the whole session; neither meets the original budget/cohort gate.

Independent scoped gates pass. Disabling only the preparation predicate makes
29 unchanged unit checks fail and the actual late-pack control falsely complete;
exact restoration passes the full 150 tests, twelve-case matrix and identical
selected native control. Counting premature close as finish fails the actual
Node HTTP unit; exact restoration passes the same check and full package.
The independent fresh Codex journey also completes at this exact revision:
22 requests, no missing stages or failures, 95.309 seconds (106.995 seconds
including setup/teardown), with source/SDK/provider unchanged. Its 492,103
first-promotion tokens and 595,011 whole-session tokens are separate observations.
Both original full roots pass all eight groups, including 7,442 Wire tests,
1,093 Agora tests and 150 Gauntlet tests. Primary and independent execution take
1,701.287 and 1,643.842 seconds respectively, with all 2,738 inputs and actual
SDK unchanged. Both retain the 54 individual toolchain skips and S1 drain
diagnostics; no workspace group is skipped. WhiteRaven independently closed
only `zai.7`, with original-criteria map 3167. Code UBS scans cover six supported
files and 206 complete findings: two critical classifications, ten warnings and
194 information findings. Both critical contexts are fixed-key header type
checks rather than object merges; all elevated contexts were reviewed. Finding
exit 1 remains explicit, without suppression or a broader security-clean claim.
The original parent still needs
offered-move/error-body comprehension, broader ordering, cohort/25K and staging
acceptance. No earlier model journey is relabelled under this changed scorer.

### Coherent Gauntlet sessions — independently verified

The unchanged `8b493969` scorer reports a completed loop when one owned session
supplies the pack read and handback while a different, still-open session
publishes the falsifiable claim. A retained synthetic-facts reproduction shows
that false positive; it is unit evidence, not an agent journey.

Candidate `3ff1f2ef` retains the canonical public claim's session attribution and
evaluates pack, refusal recovery, publication and authored closure within one
owned session on the attempted problem. A later genuinely complete session can
still succeed. Workshop presence is scoped to Fellow and problem, preserving
the product's shared private drafts across that Fellow's sessions. Partial
diagnostics also come from one candidate rather than a union of unrelated work.

Frozen primary typecheck and lint pass all eight groups, and the complete
Gauntlet package passes 117 tests plus its self-test. Full contracts (1,028)
and renderers (605) also pass. The first working typecheck caught the
missing session field in the existing declaration; that failure is retained
and the declaration is corrected. The complete real local reference matrix
passes all eleven expected outcomes: three complete paths and eight deliberate
failures. The new split-session control actually publishes an attributed,
falsifiable claim through B, leaves B open without a pack or handback, and
closes A. It is rejected for the missing pack and closure. Original controls
retain their meanings; these are scripted local Workerd/D1/R2 results with
fixture identity and screening.

Independent source review finds no concrete blocker. Literal diff and staged
UBS analyses cover five supported files with zero critical, eight warning and
149 information findings. All eight elevated contexts are reviewed, without
suppression or a broader security-clean claim. A fresh actual Codex 0.167.2
journey passes the frozen coherent-loop scorer with 22 requests, no missing
stages or failures, in 115.238 seconds. Its provider installation, source and
SDK remain unchanged. First-successful-promotion usage is 472,567 tokens,
distinct from 570,510 for the whole session; this is no budget or cohort
acceptance. Independent frozen typecheck/lint, contracts/renderers and the
complete Gauntlet package pass too. Restoring only the old all-session set
causes three unchanged unit checks to fail (114 pass, three fail). The real
selected split-session journey then falsely reports completion, and the
unchanged native gate fails with `GAUNTLET_LOCAL_REFERENCE_FLOW_FAILED`.
Exact restoration passes all 117 tests, the full eleven-case native matrix,
and the identical selected split-session command. The independent fresh
Codex journey completes in 106.119 seconds with 19 requests and unchanged
provider/source/SDK; its 430,653 first-successful-promotion tokens remain
distinct from 518,132 whole-session tokens. All twelve independent scoped
outcomes are retained; only the intended scorer file differs under the faults.
The independent original full root passes all eight groups. The primary root
exits 1: seven groups pass, and Wire has 7,440 passes and one
`watchdog-self-retire` failure. All source and SDK inputs remain unchanged.
The failed shell run records watchdog self-retirement, but omits the failing
survivor subcheck. The concurrent independent run's same-label watchdog was
still active during the primary failure. Source inspection finds a generic
marker where the exact run marker is already available. Task `epj9` owns that
defect and a real-process collision regression; the original root failure
remains unclassified rather than being erased by a retry.
The exact-marker repair is committed as `9a7e294f`. Its live-process control
fails on the original generic marker and passes with the exact marker while
the unrelated process remains alive. Existing owned-marker and PGID refusals
still pass. Frozen typecheck/lint, contracts, renderers, Gauntlet and the full
eleven-case local reference matrix pass. Both original full roots now pass all
eight groups, including 7,442 Wire tests and all 32 named S2 lifecycle scenarios
(32 start records and 32 pass records). The independent one-line old-marker
fault fails the unchanged live-process control with `check: process-match`;
exact restoration passes that control and the existing owned-survivor checks.
All 2,738 source inputs and the actual Next SDK stay unchanged through both
roots. The 54 individual toolchain skips and retained S1 drain diagnostics
remain visible; no workspace group is skipped. WhiteRaven independently closed
`epj9` and then `zai.6`, with original-criteria maps 3163 and 3164. No new model
journey is attributed to this revision: the unchanged Gauntlet's genuine Codex
observations above remain pinned to `3ff1f2ef`.
Stage presence
does not establish ordering, offered-move following or error-body comprehension;
those original parent requirements, the cohort and staging gates remain open.

One new read-only capacity observation predicts room for the original Rust
test, but actual admission again refuses the independent full Cargo request
before execution: exit 120 in 41.324 seconds, `started: false`, no assertions
or new source receipt. The actual live-budget total is not reported, so the
prediction's discrepancy remains unexplained. No further read or retry follows;
`l3b.12` stays unfinished. A bounded check of installed Gemini 0.49.0 and its
official recorder source confirms automatic content/thought recording. Session
retention controls cleanup, not recording. No Gemini model is launched, and
the third-harness privacy prerequisite remains unmet.

Fresh unauthenticated capability reads at 01:25 UTC return HTTP 200 and
`0.1.0-draft` on both production and staging, with the earlier exact hashes
`1844555d…bbc0` and `8e79852b…aa70`. Requests identify the project. These are
current public-document observations, not provider deployment history or
revision reconciliation. Operator deployment task `rs5n` remains open.

### First-promotion token accounting — independently verified

`zai.5` connects the local Codex runner to provider counters through the first
server-observed successful promotion. It collects only reduced counters,
timestamps and a temporary root identifier in memory; prompts, responses, tool
output and account fields are not retained. The runner explicitly disables
their export. Authenticated loopback ingestion is bounded and must close before
the measurement can be consumed.

The parser requires safe integer counters, one root prompt and complete,
successful, nonoverlapping WebSocket request/completion intervals. It reconciles
every component against the CLI's whole-session totals before selecting the
promotion boundary. Missing telemetry, conflicting fields, duplicate roots,
timestamp ties or a request straddling promotion withhold the metric. Cached
input and reasoning output remain subsets, never additional tokens. Official
Codex `rust-v0.167.1` send/stream telemetry source supports that ordering; other
transports remain unsupported for this metric.

The strict-interval working source passes all eight typecheck and lint groups
and all 111 Gauntlet tests, plus the existing harness self-test. One fresh actual
Codex 0.167.1 run completes the real local Workerd/D1/R2 participation loop,
including injected 422 recovery and handback, in 92.745 seconds. Its first
successful promotion uses **415,986 tokens** across 12 provider requests:
413,202 input plus 2,784 output. The 375,168 cached input and 44 reasoning output
tokens are included in those totals. Whole-session usage is 518,780 tokens;
84,181 served bytes through promotion are a separate measurement. This single
local observation is substantially above the original 25K target. It is neither
a cohort median nor a staging/G-C pass or improvement statistic.

Another session commits these exact six source files as `7c43d6dd`; all 2,738
proof inputs and the actual Next SDK match the working-source receipts. The
commit description omits the new collection and boundary calculation. Its
timestamp is not verification evidence. Frozen primary and independent
typecheck/lint, complete contracts (1,028), renderers (605) and Gauntlet package
(111 plus self-test) pass. A fresh primary Codex 0.167.2 run at this frozen source
completes the local journey in 108.560 seconds, reporting **568,420 tokens**
through first promotion across 15 requests (565,196 input plus 3,224 output),
versus 674,395 for the whole session and 75,676 served bytes through promotion.
The actual CLI version, wrapper, launcher, native binary, source and Next SDK
remain stable during the run. Independently omitting only the cutoff-straddle
guard causes the unchanged accounting test to fail (110 pass, one fail);
exact restoration passes all 111 tests and the self-test. This is unit causal
proof. The independent fresh Codex run also completes the local journey in
97.548 seconds: 439,983 first-promotion tokens across 13 requests, 542,424
whole-session tokens and 70,415 served bytes through promotion. Its actual
0.167.2 installation, all source inputs and Next SDK stay unchanged. These
different local attempts are not a cohort or a performance comparison. The
five-component reconciliation is enforced by the running constructor; raw
provider events are deliberately not retained for a separate replay.
Both original complete root gates pass at `7c43d6dd`: the primary finishes
at 00:40:01 UTC in 1,546.265 seconds; the independent run finishes at 00:39:42
UTC in 1,499.698 seconds. Each executes all eight groups with zero failures,
blocked groups, missing groups or whole-group skips: 7,441 Worker tests with
39,508 assertions, 1,093 Agora tests and all 111 Gauntlet tests. The original
54 individual toolchain skips and retained S-1 post-exit-drain diagnostic remain;
these results do not establish G0. All 2,738 proof inputs and the actual Next SDK
match before, after and current source. The later `dce2e063` commit contains
only the pending assessment and tracker metadata, with identical runtime bytes.
WhiteRaven independently accepts and closes only `zai.5` at 00:43:46 UTC, with
the original criterion/source/evidence map in comment 3156. The tracker has
623 issues: 479 closed and 144 unfinished. The parent and external requirements
below remain open.
The scoped code UBS diff and post-peer-commit staged analysis complete with
219 findings: one critical, 19 warnings and 199 information items across six
files. Both reviewers inspect every elevated context and establish no new
changed-code defect. The critical finding is the run-local loopback nonce's
string comparison; this is not a claim of constant-time comparison or a
security-clean result. The staged analysis cannot establish what ran before
the other session's commit. Broader scanner task `g4b4` remains open.

The installed CLI changes to 0.167.2 before frozen native validation. Its
official WebSocket/session-telemetry source files are byte-identical to 0.167.1,
and the relevant exporter/privacy schema definitions are unchanged. Fresh
native execution records the actual CLI version and binary before and after;
the earlier 0.167.1 observation has no retroactive binary-hash attribution.

The provisioned staging runner still refuses its unimplemented journey. The
original ten-session, three-harness, eight-completion, median-token, sponsor and
move-following requirements remain open, as do deployment reconciliation and
the watch leaf's independent Rust gate. Gemini and Grok are not launched without
verified no-recording controls. No further remote Cargo attempt follows the
latest insufficient-capacity observation.

### Merged HEAD repair — independently verified

Another session committed the watch work as `55f54f65` and merged substantial
protocol-conflict, retention and problem-policy work into `35cd51b0`. Both
commits are preserved. The original complete root suite at that merged revision
finishes normally at 21:14:36 UTC with **six passing and two failing groups**:
one toolchain failure and three Worker failures (7,438 Worker tests pass).
All 2,738 source inputs and the pinned Next SDK remain stable. The earlier
2,712-input green result does not qualify this merge.

Repair source `e61556e3` preserves the original
800-token cap and declared provenance by shortening only three compact-fallback
labels; the measured response is 3,197 bytes with every effective permission
retained. Replay and search tests now account for migration 0145's append-only
content-control cursor changes, checking exact post-hide state, restored public
content and fresh ETags rather than accepting stale pre-control validators.
The restore fault is reanchored to the current verified journal/head seam while
still discarding replay records. All 333 tests across the three owning files
and all six explicit registry checks pass in primary and independent executions.
The registered native fault is caught; its direct replay fails the original
source identity/version control assertion, before the later resurrection
assertion. Exact restoration passes. The independent old-label fault breaks the
unchanged provenance assertion; disabling only migration 0145's cursor increment
breaks both updated unit expectations. All source and SDK maps remain stable.
The primary original complete root finishes normally at 22:19:03 UTC in
1,576.736 seconds: all eight groups pass, including 7,441 Worker and 1,093 Agora
tests. The original 54 individual toolchain skips remain; no whole group is
skipped. All 2,738 source inputs and the pinned Next SDK stay unchanged.
The independent original complete root also passes at 22:40:09 UTC in
1,522.785 seconds, with the same group/test counts and unchanged source/SDK.
WhiteRaven independently closes only `aj4j` at 22:42:04 UTC, with the original
criterion/source/evidence map in comment 3151. The tracker has 622 issues:
478 closed and 144 unfinished. The watch leaf's original independent Rust
requirement remains unmet.

Final-source typecheck and lint pass all eight groups. Primary and independent
complete contract (1,028) and renderer (605) suites pass at `e61556e3`.
The real local protocol-conflict and problem-proposal/creation-quota journeys
also pass. These are local fixture-identity/screening results, not hosted OAuth,
provider accuracy, browser or deployment acceptance.

The scoped code UBS scans complete with 97 critical and 138 warning findings.
Both reviewers inspect all 235 elevated contexts and establish no additional
changed-code defect. These are finding exits, not security-clean results;
broader scanner task `g4b4` remains open.

### Public CLI watch continuation — runtime checks now execute

`l3b.12` connects `asimp watch` to existing public tails. It checks generated
event/footer JSON Schemas offline, preserves complete NDJSON pages and resume
cursors, and uses global `/cursor` only as an invalidation hint. Errors stop
with a resume hint; human mode prints full pretty JSON. The earlier commit
description's automatic-retry and human-summary wording is inaccurate.

The primary original locked Rust 1.93.1 suite passes remotely at 21:19 UTC:
71 library, one canonical-vector and 20 compiled-CLI tests, **92 passes with
zero failures**. Three HTTP tests are explicitly ignored there and execute in
their real local Workerd/D1/R2 journeys. The 2,755-file RCH receipt matches all
974 CLI/contracts inputs. Its library executable is the warm compiler artifact
from build `30103802359054357`; remote-before, downloaded and remote-after
SHA-256 values match `d5054f77…f7d18a5`. All 974 compiled inputs still match the
frozen candidate. This is not an independent compilation or independent full
test reexecution.

The original native oracle first failed before invoking Rust because it applied
JSON-link validation directly to NDJSON footers. The repaired adapter validates
the strict footer, converts only the face for full sequence/link checks, then
requires exact original NDJSON bytes through the canonical renderer. Primary
and independent watch journeys pass all four snapshot cases and actual live
publication/catch-up. A private Worker footer fault is caught by the strict JS
oracle before Rust, and exact restoration passes; it is not a Rust-reader
negative result. The original 25 workshop, four next-move and nine search cases
also pass with the attributed current binary. All these native journeys pass
again in both agents' final-source executions at `e61556e3`.

Earlier disk-admission refusals (120 before Cargo), source-change refusals
(103), and a relocated direct-library invocation with one missing embedded
fixture remain retained. That direct run is not a green library result. A later
real Cargo invocation provides the passing full suite above. The project RCH
filter now excludes only ephemeral `e2e/.artifact-writer-leases/`, whose live
directory changes caused an actual source-barrier refusal; code and schema
source guards remain enforced. No worker policy, default, cache or admission
guard was changed. Evidence remains under
`e2e/artifacts/asimp-watch-20261111-coppertiger/`.

Final-source pinned formatting, strict remote check and denied-warning Clippy
pass for both agents. Their worker source receipts match every frozen input.
The independent original full Cargo attempt is refused for reserved disk
capacity before Cargo starts (exit 120); it executes no tests. One later
read-only observation predicts a fit, but actual admission refuses the next
original attempt after available space falls. Both refusals remain retained;
no further attempt, policy change or admission override follows. Independent
full Rust reexecution still governs watch closure; both complete root gates
now pass. Parent W11, advisory, deployed/TLS/Google, G0/G-C and launch
requirements remain open.

### Current Rust qualification — 2026-11-11

Recovered remote capacity allowed the original CLI qualification to execute at
`73f4936d`, including the newer enrollment and credential-storage code. Both
primary and independent runs pass the original Rust 1.93.1 formatting, locked
check, complete locked test and denied-warning Clippy gates. The complete suite
executes 82 passing tests: 62 library tests, one canonical-JSON vector test and
19 compiled-binary tests, with zero failures. Its two real-HTTP tests remain
explicitly ignored there and execute separately through their original native
journeys: 25 workshop reads, four next-move reads and nine search cases all pass
in both agents' executions against real local Workerd, D1 and R2.

Each successful RCH command has a worker-verified 2,728-file source receipt;
all 968 CLI/contracts inputs at that revision match. The test receipts also match all
2,711 frozen native inputs. Before/after source maps and the pinned Next SDK
remain stable. The compiler-reported library executable has matching
remote-before, downloaded and remote-after SHA-256 values, `47ec450c…d91ea`.
Independent Cargo execution reuses that warm compiler artifact (`fresh: true`);
this is independent test/gate reexecution, not two independently compiled
binaries. The native drivers retain their explicit loopback transport mapping
and identity/screening fixtures, so these results do not establish production
TLS, live OS-keychain behavior, Google approval or deployed participation.

Fresh worker observations retain Rust 1.93.1, rustfmt/Clippy, the old toolchains
and the original default, `nightly-2026-08-31`. No worker policy, cache, guard,
toolchain pin or application code changed during that qualification. An impossible
`+99.99.99` request returns 103/`RCH-I006` before Cargo, with local fallback
refused. The primary private-checkout attempt's separate topology refusal is
retained; accepted commands run from the canonical project root without an
override. Raw primary and independent receipts use `73f-*` and
`independent-73f-*` in
`e2e/artifacts/current-rust-20261110-coppertiger/`.

The incoming calibration-fixture repair also passes its complete 51-test file
with 726 assertions at this revision. The earlier eight-group TypeScript root
result remains pinned to `0a831219`; it is not a fresh whole-root run of the
later test fixture. Browser PKCE, complete validate/scrub parity, durable write
spooling, sync/watch/pull/doctor, negotiation and release remain original W11
work. This qualification does not close those parents, dependency-advisory
acceptance, G0, G-C, hosted safety/cost/recovery or launch.

Fresh unauthenticated public capability reads at 17:05 UTC still return
200/`0.1.0-draft`, with the earlier exact body hashes: production
`1844555d…bbc0`, staging `8e79852b…aa70`. Requests use the project User-Agent.
These are public-document observations, not provider revision or deployment
history. Operator deployment reconciliation (`rs5n`) remains the largest
delivery gap.

WhiteRaven independently closes only `l1yg.1` at 17:12:39 UTC, with the
original criterion/source/evidence map in comment 3135. The tracker has 620
issues: 477 closed and 143 unfinished. No parent or external gate is closed.

### Scientific request recovery — 2026-11-11

Source `0a831219` connects the existing canonical field-hint helper to the
strict review and evidence refusals, including session writes and the existing
direct routes. For example, a rejected review containing `bassis` now names
`basis` in `suggested_fields`. The client must correct and resubmit; acceptance
is never coerced. Direct review/reviews and evidence refusals also link their
existing standalone request schemas instead of the full sessions document.
No contract, policy transparency rule or scientific validator was relaxed.

The original native discovery journey now uses these hints and served schemas
to publish the intended reviews/evidence through real local Workerd/D1/R2.
Each correction refusal checks unchanged session/workshop/event/review/evidence
counts and screening calls; credential-shaped unknown keys stay out of errors.
The six original public events and the original privacy, replay, cursor and
handback assertions remain. The new native check fails on the old producer.
Frozen positive and policy-rejection journeys pass, as do all 321 tests in the
three owning files, typecheck/lint (eight groups each), Worker contract/security,
1,021 contract-package tests, 605 renderer tests and the complete S3 regression
file. The required full root suite completes normally at 10:24:22 UTC in
1,570.698 seconds: all eight groups pass, including 7,375 Worker tests and
1,081 Agora tests. Its original 54 individual toolchain skips remain disclosed;
no whole group is skipped. All 2,711 source inputs and the pinned Next SDK are
unchanged before/after and matched main at that qualification boundary.

Independent exact-source native/contract/HTTP/security checks pass. Omitting
review hints, returning a wrong evidence field, and removing only the direct
schema middleware each fail the intended unchanged native assertion. Exact
restoration passes the complete native journey. A different agent closes only
`but.7` at this revision, citing the original criteria and raw evidence in
comment 3129. Parent `but` retains its original full catalog criteria. The live
tracker has 620 issues, 476 closed and 144 unfinished, with no dependency cycles.

Both literal changed-file UBS scans complete all four supported files with
104 critical, 152 warning and 1,859 information findings. Root and the reviewer
read every elevated context; no new defect was established. The two reported
locations on added source lines are fixed route regexes; the other reported
lines already exist in the baseline. These finding-exits
are not clean-security results, and they do not resolve the broader incomplete
coverage in `g4b4`. Raw receipts are under
`e2e/artifacts/review-evidence-recovery-20261111-coppertiger/`; independent faults
and restoration use the existing reviewer artifact directory cited in `but.7`.
This bounded leaf leaves parent `but`, hosted Gauntlet/token measurement,
deployment, screening/cost/recovery and optional Rust requirements open.

Public capability reads at 10:07 UTC still return 200/`0.1.0-draft` and exactly
the 05:43 body hashes: production `1844555d…bbc0`, staging `8e79852b…aa70`.
Requests use the project User-Agent and no credentials. The raw two bodies and
headers are retained in this block's artifact directory. This confirms unchanged
public documents, not provider revision, deployment history or authorization.

### Area rename follow-through — 2026-11-11

The implementation at `e39b2a5c` postdates the assessment below. The existing
operator area command now persists an append-only rename event and its audit
entry atomically, retains the immutable slug, and returns an exact replayable
receipt. The admin form uses the signed Worker path with current operator and
recent-auth checks. Area Markdown/JSON and the human area/Explore pages consume
the same label projection; a confirmed receipt invalidates both human caches.
The public notice is taxonomy `label_change` event/time provenance, not a
scientific `moderation_log` action. Private audit reasons are excluded.

The real local native lane covers hidden/private targets, principal and auth
refusals, replay after a later rename, concurrent writers, immutable history,
audit-trigger rollback and retry, and unchanged scientific events/membership.
Production Next/Chromium with Workerd/D1/R2 passes all 459 checks in both primary
and independent runs; the final independent `e39b2a5c` run exits normally in
139.917 seconds with unchanged source/SDK. Removing only the two cache
invalidations completes that same browser journey with exactly four human-cache parity failures; Worker
faces remain correct. Exact restoration passes all 459. These local runs use
explicit identity/signing/screening fixtures; they do not establish Google,
staging, provider authority or G-C acceptance.

The final frozen source has fresh typecheck/lint passes (eight groups each),
1,021 contract-package tests, 605 renderer tests, 190 Worker contract tests,
the complete 68-case repaired unit set, native area and Stoa lanes, and the
schema/trigger and registered-source-plant checks. **The full root suite passes
all eight groups**, normal exit 0 at 09:32:53 UTC in 1,550.182 seconds, including
7,375 Worker tests and 1,081 Agora tests. Its existing 54 individual toolchain
skips remain disclosed in the raw output; no whole group is skipped. All 2,711
source hashes and the pinned SDK are unchanged before/after and matched main
at that qualification boundary. Its preceding `6821a028` run completed with
seven groups passing and 16 Worker unit failures. The repairs supply three missing
immutable-review fixture fields and replace the operator test's obsolete
unavailable expectation with a typed receipt plus persisted event/audit checks;
production scientific rules and the original race/rollback assertions remain.
Earlier browser, receiver-capacity and trigger-catalog failures are retained.
Raw source/SDK-bound receipts are under
`e2e/artifacts/area-renames-20261111-coppertiger/` and the independent paths cited
in Beads. Different-agent acceptance closes only `0ht.1` and supporting fixture/
gate repairs `df71.3.7`–`df71.3.10`. The broader admin and hosted requirements
remain separate. The current tracker has 619 issues: 475 closed and 144
unfinished; the dependency graph remains acyclic.

The literal final changed-file UBS scans complete with no critical findings
and seven reviewed warnings in existing test JSON parses. Broader incoming
coverage still belongs to `g4b4`; the failed scheduler/timeout scans are not
security passes. `0ht` retains its wider admin/hosted criteria. Cost remains
blocked at 78 `S2_COST_MEASUREMENT_UNAVAILABLE`, and deployed reconciliation,
protected screening material, whole-system recovery, fresh-harness G-C and
optional Rust qualification retain their original owners and acceptance.

### Fresh end-to-end assessment — 2026-11-11

ASImposium has a substantial, tested local implementation of its scientific
instrument. Its public deployment does not yet deliver the promised
participation and reading surface. Deployment reconciliation is the largest
immediate delivery gap, but completing it will leave concrete implementation
and empirical acceptance work. The [26-goal checklist](#vision-checklist-implementation-and-remaining-acceptance)
below maps the full vision to existing owners; this assessment refreshes its
source and proof boundaries without replacing the Fable plan.

The inspection starts at `34652ebb`, whose 2,702 checked source files and
pinned Next runtime exactly match qualified `f0957beb`. The root AGENTS and
README were reread in full, together with the governing Fable plan. A separate
reader audited both retained alternative plans against Fable's adoption ledger
and searched all 614 Beads records. Rejected stacks and tier-two features are
not additional launch requirements. This audit changes documentation and
tracker records only.

**Fresh public observations, 05:43 UTC.** Requests used the project User-Agent,
without credentials. Conditional capability requests return 304, but this
does not prove cursor cache cost, provider revision or deployment history.

| Public observation | Production Worker | Staging Worker |
| --- | --- | --- |
| `/capabilities` | 200, `0.1.0-draft`, SHA-256 `1844555d…bbc0` | 200, `0.1.0-draft`, SHA-256 `8e79852b…aa70` |
| `/protocol.json`, `/search.json?q=P-4DSP`, `/openapi.json` | All 404 `ROUTE_NOT_FOUND` | All 404 `ROUTE_NOT_FOUND` |
| `/problems.json` | 200, zero entries | 200, two entries |

Production Agora `/` and `/p/P-4DSP` return HTTP 200 but contain unavailable
upstream-data messaging. A responsive page is insufficient evidence of a
working scientific record. The current source mounts the missing Worker routes
in `apps/wire/src/app.ts:1337–1414` and `:1675`; rebuilding those subsystems
would duplicate existing work.

**Fresh local execution.** `bun run typecheck` and `bun run lint` each pass
all eight groups. `bash e2e/gauntlet/run.sh --target local` passes its ten
scripted oracle cases: three completing controls and seven deliberately
incomplete controls. It exercises real Workerd/D1/R2 with fixture identity and
screening. These are not ten fresh model trials. `bun run verify:cost` returns
78 `S2_COST_MEASUREMENT_UNAVAILABLE`; the required retained external measurement
is still missing. Gallery's staging public preflight returns 78
`GALLERY_GOOGLE_TEST_ACCOUNTS_MISSING`, before authenticated writes. The
current environment has no nonempty designated Google accounts/problem,
Fellow smoke token or sanctioned Workers Builds/Cloudflare inputs; this is a
presence check, not a credential-store inventory.

The complete root suite at 03:30 UTC, contracts (1,019), renderer (604) and
primary/independent production browser (439 checks) are retained exact-source
evidence, not newly executed gates in this refresh. Their source and SDK
equality were recomputed before documentation edits. The original individual
toolchain skips remain disclosed. Raw fresh receipts are retained under
`e2e/artifacts/reality-20261111-coppertiger/`; original full-run and adverse
receipts remain at the paths recorded in the qualification below.

**Concrete remaining code and proof.** The following distinguishes unfinished
implementation from work that exists but still needs original acceptance.

| Gap | Inspected behavior | Existing owner and completion evidence |
| --- | --- | --- |
| Provisioned G-C runner and measurement | `e2e/gauntlet/run.sh:139` still returns 70 for a supplied join-file input. Local verdicts prove pack retrieval and persistence past an injected refusal, not move following or error-body comprehension. Harness usage is explicitly `whole_session`; served bytes to first promotion are a separate measure. | `zai`, `pcsn`, `mn7`: implement the actual staging journey and authoritative first-promotion usage boundary, then meet ten fresh sessions, three harnesses, eight completions and the 25K-token median. Missing usage or a planted incomplete journey must withhold acceptance. |
| Safety accuracy and the protected corpus | `e2e/screening/s4-corpus.ts:921,1107` reserves 50 absent protected bodies. The 150 legitimate examples and local fixture screen cannot establish hard-reject recall or hosted accuracy. | `xeg`, `axq`, `drv`, `ip3`: material, digest-bound protected corpus; hosted FP/FN and aggregation tests; bare/inoculated probe trials; actual independent operator decisions and Google verification. |
| Whole-system recovery | `krater/backup-scheduler.ts:7` explicitly archives published problem ledgers. `restore.ts` restores one verified problem and projections, with provider execution remaining separate. Signed public exports do not restore all account/global/private state. | `p4b`, `zr9`, `79n`, `24q`: complete original backup scope and scratch drills, proving revoked rights and redactions survive; corrupt input must refuse before writes. |
| Area rename | Implemented after this audit in `moderation/area-renames.ts`, migration 0143 and the existing admin action/form; shared faces carry the new label and public change provenance. | `0ht.1`: local native/browser, adverse controls, full-root and independent acceptance are recorded above. Parent `0ht` retains wider admin/hosted criteria. |
| Remaining optional CLI | `cli/src/lib.rs:44,46`, `enrollment.rs` and `credentials.rs` now implement connect, device enrollment, approval resume and keychain storage. Browser PKCE, validate/scrub parity, spool/sync/watch/pull/doctor, negotiation and release remain incomplete. | `il7`, `l3b`, `psl`, `jsj`, `85s`, `l1yg.1`: original current-source Rust, parity, native and release criteria; old binaries and compile-only checks cannot substitute. |
| Deployed configuration and evidence | Source implements receipt-bound readiness, Herald/outbox, rate budgets, artifact publication and scientific consumers. Public deployment and provider behavior remain unqualified. | `rs5n`, `tgu`, `doa`, `irg`, `rhg`, `z2j`, W7: reconcile existing bindings/migrations, preserve Worker-before-Agora order, exercise actual Google/sponsor/anonymous paths and retain load, cost, cache and storage receipts. |

Readiness is **implemented**, not hardcoded false: `apps/wire/src/readiness.ts:26`
loads private canonical evidence and validates its digest, environment, revision
and expiry; `app.ts:1340` consumes it and Agora's `plane-status.ts:508`
projects its result. Missing evidence correctly withholds readiness. No operator
flag should manufacture a ready result. Likewise, the mounted moves, inbox,
Herald and signed archive code must not be rebuilt from obsolete README absence
notes. Complete every-kind/face/error, warning, coordination and scientific
acceptance still belongs to the original W1–W10 owners in the checklist.

**Would the existing Beads finish the vision?** Their original acceptance
criteria appear to cover the documented launch scope; no concrete `NO_BEAD`
launch promise emerged from the full-record coverage check. Merely implementing
their code or closing their statuses would not suffice. Actual multi-sponsor
science, independent review, hosted safety/cost/recovery evidence, operator
decisions and the G3 thirty-day observation must occur. Unknown future defects
remain possible. `rs5n` alone explicitly does not certify G-C, cost or launch.

At the audit snapshot there are 614 issues: 469 closed and 145 unfinished
(111 open, 22 in progress, 12 explicitly blocked). Dependency-blocked counts
overlap statuses. `br ready` reports nine tasks; BV's 28 actionable entries
include active work and use a different denominator. `br dep cycles` and BV
insights find no cycles. Counts are workload information, not a vision-delivery
percentage. The bridge below prioritizes observable outcomes and preserves
every original criterion.

Broader incoming scanner coverage (`g4b4`), remaining dependency/advisory
acceptance (`l1yg`, `ii92`) and the retained unclassified runtime failures
remain open. Passing source gates do not diagnose those historical failures.
The 05:52 storage observation has about 41 GiB of usable primary headroom;
`0oi3` retains its original missing-snapshot preservation requirement. No
cleanup or claimed recovery of that historical snapshot occurs in this audit.

### Retained exact-source qualification

At `f0957beb`, Gallery smoke executes the existing sponsor mint and approval
forms, Fellow enrollment, session, working pack and private workshop push.
The same journey checks owner visibility and excludes the second sponsor,
anonymous visitors and public faces before closing with a handback. The hosted
entrypoint requires two designated Google test accounts and a dedicated staging
problem. Credentials enter over stdin, and its terminal result follows browser
cleanup. The deployment stage order is unchanged.

Both agents pass all 439 checks in the real local Chromium/production
Next/Workerd lane. Sponsor cookies are explicitly local fixtures, with no
Google OAuth exchange. Independent substitution of the owner's principal in
the private workshop producer fails the unchanged cross-sponsor leak assertion;
exact restoration passes all 439 checks. All 2,702 source hashes and the pinned
SDK match. Complete pipeline tests (23), smoke-entrypoint checks and lifecycle
units (3) also pass independently and on primary reexecution. Pinned typecheck
and lint pass all eight groups. The original full root passes all eight groups
at 03:30 UTC, including 7,321 Worker and 1,081 Agora tests. Its before/after
source and SDK maps match current main and the independent browser inputs.
The separate full contracts and renderer gates pass 1,019 and 604 tests.
WhiteRaven independently closed `7ft.3` at 03:35 UTC, with the criterion and
evidence map in Beads comment 3098. Parent `7ft` remains open.

The exact-source read-only staging smoke stops at exit 78
`GALLERY_GOOGLE_TEST_ACCOUNTS_MISSING`, after public preflight and before any
authenticated write. This replaces the permanent implementation stop observed
on November 10. It does not establish hosted Google, staging deployment or G0
acceptance. Those requirements remain with `7ft` and `rs5n`.

Merge `c72f78ca` introduced two local qualification failures. The S2 source
walk named an unlisted import, `packages/render/src/artifact-publications.ts`.
The original S3 sentinel test exhausted its 3,760,000-byte evidence receiver.
The same build script produced complete canonical arrays of 3,747,282 and
3,781,957 bytes for production and the counterfactual.

At `a66714e2`, the source inventory includes the renderer and the S3
receiver holds 3,785,000 bytes. The tests accept the measured arrays, check
the sentinel split, and reject a byte above the new receiver limit. Independent
review calculated a worst-case wrapped result of 7,570,237 bytes within the
original 8,000,000-byte envelope. Typecheck, lint, focused S2/S3, and the real
local artifact journey pass. Serial UBS completed on both changed-file
selections after the parallel scheduler failed. Exact-source contracts pass
1,019 tests, the renderer passes 604, and the real enrollment journey still
passes. Independent verification passes all 151 S2 and 65 S3 tests. Omitting
the renderer pin reproduces the missing-source failure, and restoring only
the old receiver reproduces the actual counterfactual overrun. Both restored
focused suites pass. The original full root passes all eight groups with
7,321 Worker tests and 1,081 Agora tests at 00:11 UTC. All 2,700 source hashes
and the pinned SDK agree before and after, and current main matches.
WhiteRaven independently closed `x77k.2` at 00:12 UTC, with the evidence
map in Beads comment 3095. The parent and the deployed S2 and S3 gates remain
open.

At `97800ee9`, strict fragment registration can
suggest `tools_note` for `toolsNote` after verifying the invitation. Device
start can suggest `harness` for `harnes`. Missing or wrong invitation
credentials and a malformed required registration declaration still return the
same opaque refusal. The real local Workerd/D1 test follows both suggestions
with explicit same-key retries and verifies one proposal per corrected request.

Pinned typecheck and lint pass all eight groups. The initial native case for
required runtime metadata reached credential preflight as designed. The
corrected optional-field case failed the hint assertion on the old producer
and passed with the new producer. The existing S3 guard and 328 focused Worker
tests pass. Both agents pass the full contracts package, the two owning
enrollment files, HTTP contracts, security, and the native journey at the
frozen revision. Removing either hint from its producer fails the corresponding
native assertion. Restoring the producer passes with all 2,690 source hashes
and the pinned SDK verified. The full root at `97800ee9` passes all eight groups
at 23:38 UTC, including 7,278 Worker tests and 1,073 Agora tests. WhiteRaven
closed `but.6` at 23:40 UTC with the criterion map in Beads comment 3094.
Merge `c72f78ca` preserves all three enrollment files byte for byte. Its
additional runtime source has separate qualification.

On November 10 the staging Agora's anonymous checks reached exit 70
`GALLERY_PRODUCT_FLOW_NOT_IMPLEMENTED`. The hosted pipeline requires Gallery
smoke before Worker deploy, so completing the authenticated Gallery flow in
`7ft` is required alongside the operator authority and staging lineage in
`rs5n`. Staging Worker capabilities still return `0.1.0-draft` with the
retained SHA-256 `8e79852b…aa70`. The public checks leave the provider
revision unknown.

The historical problem-lifecycle failure in `2tnr` remains unclassified.
No candidate matched its retained digest in a bounded search of historical
assertion formats. The current real local journey passed once, and existing
commit `8dd3a7c5` records a source location if the failure recurs.

**Core request recovery at `ea5c11c3`:** session open, workshop push, and
promotion now return bounded canonical `suggested_fields` for a mistyped
top-level key, for example `problemId` → `problem_id`. The refused request
makes no corresponding write. The client uses the hint to construct a new
request; neither the rejected name nor its private value is echoed. Opaque
policy refusals forbid the field. The existing session middleware continues
to supply the standalone request schema links.

Pinned typecheck and lint pass all eight groups. Both agents pass 1,016 contract
tests, 86 owning Worker tests, 190 HTTP contracts, 33 security tests, and the
real local Workerd/D1/R2 journey through promotion and handback. Independent
full renderer verification passes 601 tests. The native
client follows all three request schema links. Omitting or misdirecting the
session hint, or serving the workshop schema at session open, fails the
unchanged native assertions. Exact restoration passes. Each fault changes
one private producer or route-map file; all other source hashes and the SDK
match. The original full root suite passes all eight groups, including 7,278
Worker and 1,073 Agora tests. It ends at 22:57:51 UTC after 1,494 seconds,
with all 2,690 source hashes and the pinned SDK unchanged.

The first bundle overrun is retained; the unchanged S-3 cap passes after
sharing the existing schema URL. The old module URL control passes because
the middleware already narrows that URL. Two superseded full runs were stopped
and retain exit 143; one cleanup revision also failed lint on import order.
The final revision passed lint before its full run started. Scoped UBS ran and
its elevated findings were reviewed; full incoming scanner coverage remains
open. The local classifier and sponsor setup remain fixtures; deployment,
Google, G0, live-harness G-C, token-budget, and Rust acceptance are separate.
Independent verification closed `asimposiumorg-but.5` at 23:00 UTC, with
the criterion and evidence map in Beads comment 3088. The original error
catalog parent `asimposiumorg-but` remains open.

**Route recovery qualified at 21:17 UTC:** `bc4750cd` supplies canonical typed
`next_actions` for common static route typos and API/version-prefix mistakes,
including the six disclosed enrollment, device and flow operations. The existing
disclosure manifest supplies the destinations. Misses remain 404s; handlers
retain their authorization and validation, and policy refusals forbid the new
field. No alias executes and no new endpoint, table or error code is introduced.

The original full root suite passes all eight groups at this revision: 7,278
Worker tests (37,885 assertions), 1,073 Agora tests, and zero failed groups. Its
terminal is 21:17:17 UTC after 1,526 seconds. Pinned typecheck and lint preflights
also pass all eight groups. Both agents execute full contracts (1,011), complete
gateway/discovery owning files (83), HTTP contracts (190), security (33), and the
real local Workerd/D1/R2 recovery journey. The full renderer package passes 601
tests. All 2,685 source hashes and the pinned SDK match before and after final runs.

The native journey proves zero proposals and no secret or private enrollment-ID
reflection on a registration miss, preserves the missing-secret canonical 400,
then follows the returned URL to exactly one proposal, sponsor approval and
token delivery. It also follows directives and session hints through private
workshop, falsifiable public promotion and close with handback. Four independent
producer faults omit or misdirect registration/session hints; all fail the
unchanged native assertions. Exact restoration passes, and the primary
reexecutes every named positive after reviewing the raw evidence. Only private
`app.ts` differs in each fault; tests and all other 2,684 source files stay fixed.

The earlier `a47675ce` full pass remains a separate receipt. Its omitted
pre-enrollment hints were caught and repaired before closure; the old filter
fails the added unit and native cases. The strict problem-schema index changes
only its measured byte count, and the existing file-backed schema census now
requires all 23 schemas, including workshop-directory. Original limits remain.
Scoped UBS completes with reviewed findings (24 critical, 39 warning); its two
new critical sites are an explicitly synthetic test secret and that test's
declaration. This is not a scanner-clean or complete `g4b4` result.
Independent verifier WhiteRaven closed only `asimposiumorg-but.4` at 21:20 UTC,
with the criterion/evidence map in Beads comment 3086. Native screening and
sponsor setup use existing fixtures: no deployed,
Google, G0, live-harness G-C, token-budget, broad security or Rust acceptance is
earned by these local results. The original parent `asimposiumorg-but` stays open.

**ASImposium has a substantial working local research workflow, but it has not
delivered the public instrument promised by Fable.**

The preceding qualified baseline is `62cb6a8f`: both agents independently pass the
original full root suite's eight groups, including 7,274 Worker tests and 1,073
Agora tests. Their four before/after maps match all 2,681 source hashes and the
pinned SDK. Primary execution completes at 18:13 UTC; independent execution at
18:39 UTC. Both agents' typecheck and lint also pass all eight groups.
Contracts, real-binding journeys and the 438-check
production browser journey pass at their named source revisions below. The last
source change repairs only the token harness fixture, preserving those
production implementations.

The preceding `5a42c6bd` root failure is retained: its D1 measurement fixture had
130 mismatched payload hashes and 130 missing claim identifiers, which the
authenticated reader correctly omitted. `asimposiumorg-x77k.1` repairs the seed
with canonical publication bytes and real hashes. Both agents pass the complete
original 33-case token file. A sole hash-corruption fault triggers the intended
original refusal, followed by exact restoration. The original workload selects
79 claims across five deterministic samples, with a 125 ms median against its
unchanged 600 ms local regression limit.

Deployment reconciliation, live multi-harness collaboration, hosted screening,
OAuth and operational evidence remain separate work. Rebuilding the existing
source subsystems would miss those obstacles. Broad incoming JavaScript scanner
coverage remains incomplete and prevents complete integration acceptance.

Public reads at 18:15 UTC still return the September capability bytes:
production `1844555d…bbc0`, staging `8e79852b…aa70`, both `0.1.0-draft`.
These observations do not identify provider revision or deployment history.
The `62cb6a8f` cost gate returned exit 78,
`S2_COST_MEASUREMENT_UNAVAILABLE`; its required retained measurement is absent.
Deployment reconciliation stays with `asimposiumorg-rs5n`, and local pack
latency does not supply that cost or deployed-performance evidence.

During the 19:09–19:19 UTC checks, the unchanged `64a96bc2` source passed
typecheck and the real local reference flow with primary-backed temporary
storage and more than 40 GiB available. The recovery's actor and cause are
unverified. `asimposiumorg-0oi3` stays open: its original retention requirement
includes the absent `/tmp/asimposium-beads-full-disk-20261101-1050` snapshot,
for which no byte-verified equivalent is established. Newer backups and the
checked source/receipt files do not replace that historical evidence.

The latest incoming source includes rolling Fellow read admission, public
immutable-history pages, current visibility controls on review digests,
authenticated claim headlines and share images pinned to their recorded cut.
The qualification repairs preserve those implementations: type the SQL probe,
match the combined budget heading, supply the required projection argument in
the history fixture, require the real full-history type and discovery route,
and preserve the advertised image query in the browser consumer. No production
fallback or schema was added to make a test pass. The S-3 evidence receiver
explicitly grows from 3.75 MB to 3.76 MB after measuring the complete original
bundle arrays; the 8 MB envelope, 1 MB diagnostics, build graph, source checks
and deadlines remain unchanged. Original refusals and failed runs are retained.

Current real Workerd/D1/R2 checks exercise shared read quotas, 205 immutable
claim records, full-page continuations and statement/result-review hide/restore
controls. The full contracts suite passes 1,010 tests; the Worker contract
suite passes 190. The browser uses production Next and real Chromium, with a
locally minted sponsor session; it proves no Google exchange or deployed cache
behavior. A separate scripted reference flow passes its ten expected scenarios
(three completed positive cases and seven deliberate negative cases), not the
live three-harness gauntlet. A different verifier reexecutes the positive gates,
causal faults and exact restorations, then closes only the seven earned repair
leaves: `asimposiumorg-df71.3.1` through `.6` and `asimposiumorg-x77k.1`.
Their broader parents keep every unmet criterion. The independent full Rust
test prerequisite remains unfinished under `asimposiumorg-l1yg.1`.

The optional Rust CLI's earlier receipt executes its original locked suite remotely: 45
library tests, 16 CLI surface tests and one canonical-JSON test pass. Its two
ignored HTTP tests are then exercised through their real local Worker drivers:
25 workshop reads plus four next reads, and nine search cases. The compiler
source receipt matches all 2,681 source files at `5a42c6bd`; remote-before, downloaded
and remote-after library-test hashes agree. The build ran from working source
before the final commit, whose bytes match `5a42c6bd`; its original
execution label is retained. This is CLI and local-HTTP proof, not complete W11,
TLS, deployment or launch acceptance. Independent formatting, check, Clippy and
both local HTTP consumers passed at their named inputs. The independent full
Rust suite has not executed: the last recorded worker-admission check found
insufficient eligible space before Cargo. This does not assert current capacity.
At `bc4750cd`, CLI files are unchanged but eight contract files differ from that
older source map. The earlier receipt is not fresh CLI/contracts qualification.

Current raw results, exact source/SDK maps and original failures are retained in
`e2e/artifacts/current-rust-20261110-coppertiger/`; independent executions use
`e2e/artifacts/independent-20261110-honors-citations-recovery-09f36cfc/`.
The broader original parents retain every unmet condition.

A fresh canonical local Codex rehearsal at `b3ad21dc` (runtime source unchanged
from `526398d7`) completes every scored stage, including the injected 422,
corrected public promotion and handback: 20 requests, 106.62 seconds, no missing
stages or failures. The 2,671 source hashes and installed SDK stay unchanged.
The CLI reports 544,729 whole-session tokens, including 507,520 cached input
tokens; those are not tokens to first promotion. Site responses before that
promotion total 63,348 bytes across 19 requests. This is one actual local model
run with fixture screening and scripted sponsor approval, not three-harness,
25K-token, hosted-screening, OAuth or staging G-C acceptance. Raw structured
receipts: `e2e/artifacts/cold-codex-20261110-coppertiger/`. Original `pcsn` stays
blocked with its existing owner and requirements.

The last stock UBS working and index attempts over the complete 463-path
selection at `b3ad21dc` both remain partial at the original JavaScript
300-second limit. Later completed scans cover only their named repairs. An isolated
whole-analyzer concurrency prototype also times out on that complete selection.
Its smaller exact-finding controls do not supply the missing coverage, and
independent review identifies additional error-handling differences. The
prototype is rejected and retained, not installed. Original `g4b4` stays open;
further scanner iteration is stopped. Raw results and exact source/tool hashes:
`e2e/artifacts/g4b4-full-scope-20261110-coppertiger/`.

### Exact Honors reads, encoded citations and readable recovery

Honors claim items now retain their assessed version and problem-local cursor;
the shared Markdown/HTML renderer and Agora link to that same immutable read.
The implementation is `214d8b4d`. A bare claim URL remains a valid latest read;
the observed defect was a saved Honors link drifting after a later review.
Current content hiding still withholds bytes at earlier cuts. Scientific
withdrawal affects the latest state without rewriting a historical assessment.
`86dc18d7` then fixes the actual Agora consumer of encoded exact citation
selectors: decode once before strict validation, with malformed and double
encoding still refused before source access.

The complete production-browser journey reaches a separate Next.js 16.4.5
defect: source-unavailable 404s can contain an empty JavaScript recovery shell.
The pinned Bun patch in `patches/next@16.4.5.patch` changes only the compiled
production Turbopack error payload for ordinary root-layout/not-found pages.
It reuses the normal server payload and existing site recovery component;
other error shells remain byte-identical. This is a local dependency patch,
not an upstream release fix or a claim about development, webpack, experimental
rendering or global-not-found. Retire it only after a clean upstream install
passes the original JavaScript-disabled recovery and privacy journey.

A first frozen patched install in a private checkout passes all 438 browser
checks, including stronger 404/status/noindex/root-layout assertions. Three
stale fixture defects encountered later in that journey are corrected: supply
the saved brief version, follow the report queue's real detail link, and give
the moderation scenario its own board without raising the eight-writer cap.
The six original main dependency directories are retained intact with their
original inodes; retention receipts identify their location. Main now has a
fresh frozen patched install matching the qualified SDK bytes.

The first combined root at `09f36cfc` finishes red: seven groups pass, while
four seed-review tests reject the changed manifest's stale recorded digest.
Successor `7dd91148` updates only that reviewed digest and adds an explicit
dependency-wiring note. The checker, negative tests, scientific material,
source-preparation date and `external_review_pending` state are unchanged.
Its direct-main root passes all eight groups in 1,473.68 seconds, normal owner
exit zero at 04:52:35.919 UTC: Worker 7,240 tests and Agora 1,054. Typecheck and
lint each pass eight groups; full contracts pass 1,007 tests, render 599,
Worker HTTP contracts 190 and security 33. The root contract dispatcher passes
five required groups with two original inapplicable skips. All current primary
receipts share 2,664 unchanged source hashes and the installed SDK hash.

Independent exact-`7dd91148` typecheck, lint and ten component gates pass,
including a genuine 438-check production-browser build. The reviewer first
removes only the 295-byte SDK guard at `09f36cfc`: the original JavaScript-disabled
404/main assertion fails after 30 seconds. Exact restoration returns all 438
checks to passing. Earlier version/cut faults belong to `214d8b4d`; the decode
fault belongs to `86dc18d7`, with the tested source bytes unchanged in the
successor. Those revisions are not relabeled as later executions.

The independent 24-path stock UBS scan completes 1,200 location records across
19 supported module/context inputs: two critical, 115 warning and 1,083
information records. Critical/warning sites and information classes are
reviewed; no new defect is established. It retains every earlier component
location, with 64 additional information records and 12 existing guard records
classified as warnings. The generated dependency patch is separately byte-scoped,
parsed and exercised, not falsely claimed as scanned JavaScript. Report-only
scans return exit three with nothing analyzed. Neither observation completes
the older incoming integration scan or establishes a security-clean project.

The independent unfiltered root at `7dd91148` also passes all eight groups in
1,457.24 seconds, normal owner exit zero at 05:17:29.960 UTC. Its 2,664 source
and installed SDK hashes match the primary receipts. The different reviewer
then closes only `asimposiumorg-mbp.1`, `asimposiumorg-k9o.2` and
`asimposiumorg-dn6.3`, with original-criterion and source-line maps in comments
3036–3038. Their parents and broader integration requirements remain open.
Receipts are in `e2e/artifacts/honors-links-20261110-coppertiger/` and
`e2e/artifacts/independent-20261110-honors-citations-recovery-09f36cfc/`.

### Incoming workshop admission and Fellow calibration — `526398d7`

While that independent root was running, main advanced externally to
`a0605833`: migration 0141 adds atomic rolling workshop admission, and Fellow
calibration is derived from immutable scientific records. That merge was not
performed by this repair session. Preserve its 28 application/data paths and
the original scientific, privacy and quota requirements; the earlier repairs
do not establish that the expanded source is green.

The first checks against the actual merge find four TypeScript errors and two
failing replay tests. The latter expire a 24-hour receipt while leaving its
60-second admission fresh; changed-target reuse is correctly refused. The
narrow repair in `babf6766` ages only the matching admission in those two
fixtures and retains every original race, replacement, response and storage
assertion. It also repairs the test types and adds the two new reachable
modules to the strict S-2 source inventory. No runtime quota, authorization,
TTL, scientific fold or assertion is weakened. The migration boundary is now
documented through `0141_workshop_write_rate_limit.sql`.

Focused repaired checks pass, including 389 affected Worker tests, actual
local Workerd/D1/R2 quota and scientific journeys, and all 438 production-browser
checks. The frozen successor's unfiltered root finishes with seven groups
passing and one failing: Worker 7,251 pass and four fail, all in the token
lifecycle harness. Each retained failure stops before its intended assertion
with `workshop_push-session-barrier-did-not-observe-both-real-d1-batches`.
The new earlier quota election lets only one request reach the old replay
barrier. This is a concrete harness boundary mismatch, not evidence that the
panic or log-leak plants caught their intended defect. The independent full
root is held while that mismatch is repaired. Original assertions and limits
remain in force.

Successor `dd0f63db` moves only the local barrier to the earlier real workshop
admission transaction and identifies that stage in the existing receipt.
The original concurrent requests, exact 200/201 responses, byte equality,
side-effect counts, token-safety plants and cleanup limits are unchanged.
An experimental pending-response retry was removed before freezing because
the actual native races all completed without it. The final standalone token
lifecycle script passes. Typecheck and lint each pass all eight groups; the
new unfiltered root is also red: seven groups pass, while one Worker panic
plant stops at the workshop response-status assertion before reaching its
intended panic assertion. Worker passes 7,254 tests and fails one. An independent
native baseline fails that same status assertion. Neither run retained its
initial response pair; one safe diagnostic passes and leaves those earlier
pairs unclassified.
The application and other native/browser inputs remain unchanged from the
earlier `babf6766` component executions; those receipts retain that attribution.

The existing API permits an identical admitted request to return a private
pending 409. `526398d7` deliberately adapts the harness to that contract: after
both initial requests finish, require a completed 201 owner and a strict pending
problem, then repeat the identical request once and require a byte-identical
200 replay. Original final status, row-count, token-safety, panic and cleanup
assertions still run. Initial statuses, canonical codes and the recovery count
are recorded, so a recovered response cannot masquerade as an initial 200.

A controlled schedule at the existing real-D1 proxy actually produces 201/409
and completes the whole proof with recovery. Disabling only recovery fails
the original status assertion; exact restoration passes again. The primary
execution separately reproduces that controlled positive. The 200 ms scheduling
delay exists only in retained experiment variants and is absent from the frozen
source. These results prove the allowed schedule, not the missing status pairs
from the earlier failures.

Primary and independent `526398d7` typecheck and lint each pass all eight groups.
Clean native controls pass; the one-line old barrier mapping fault reaches
the original missing-arrivals assertion and exact restoration passes. Its
primary unfiltered root passes all eight groups in 1,498.04 seconds, normal
owner exit zero at 07:53:34.611 UTC: Worker 7,255 tests and Agora 1,057. All
2,671 source and installed SDK hashes remain unchanged and match its typecheck
and lint receipts. The independent full root runs only after that terminal
and also passes all eight groups in 1,454.79 seconds, normal exit zero at
08:18:36.368 UTC, with the same 7,255 Worker and 1,057 Agora tests. Its source
and SDK maps match the primary run and main before the final documentation-only
edits. Qualification remains pinned to `526398d7`. Literal Worker
expectation counts are retained separately (primary 37,447; independent 37,446);
no cause is inferred from that difference. All verifier jobs end and its lease
is released. These source results do not close broader integration acceptance.

The stock diff scan again crashes in its scheduler. The stock staged scan and
the documented serial diff scan each complete the same 4,985 findings across
five supported inputs. The reviewer inspects all 185 critical/warning sites;
the one critical match is a test comparing Response object identity. Information
classes are reviewed without claiming an individual review of all 4,800
information sites. No scanner rule is suppressed or changed. This completes
the six-repair scan scope, not the older full incoming JavaScript audit or a
scanner-engine fix. A separate scan of the 31 new incoming paths also completes:
26 supported inputs, 7,886 complete findings, all 515 critical/warning contexts
reviewed against actual source, with no additional defect established.
Information classes are reviewed separately. This still does not complete
the older full incoming scope. `asimposiumorg-df71.3` and
`asimposiumorg-g4b4` remain open.
Receipts are in `e2e/artifacts/incoming-a0605833-20261110-coppertiger/`.

The final public refresh at 08:23 UTC still finds production and staging
`/capabilities` at `0.1.0-draft`, with the same retained body hashes. The seven
required Cloudflare/Vercel pipeline variables remain absent in this session;
this does not audit cached credentials or provider state. Deployment authority,
existing D1 lineage through source migration 0141, and the sanctioned
Worker-before-Agora staging run remain operator work. The cost verifier reports
blocked 78, `S2_COST_MEASUREMENT_UNAVAILABLE`; the required measurement is absent.
Real Google approval, hosted screening, staging G-C, external cost/load and
recovery evidence remain separate. The optional Rust CLI is not qualified by
these TypeScript checks. Current disk headroom is an observation, not a diagnosis
or closure of the earlier storage incident.

### Canonical local gauntlet command — `e4b21525`

The existing real-harness runner is now reachable through
`bash e2e/gauntlet/run.sh --target local --agents harness:codex`. Explicit
reference selections work through the same command; omitting `--agents` keeps
all ten original scripted oracle cases. Valid repeated selectors remain fresh
attempts. Malformed or unknown selections fail with usage exit 64 before target
startup and never echo arbitrary caller text. Staging still refuses this local
selection option.

The shell preserves the runner's exit 78 for unavailable privacy, auth or quota
prerequisites, and preserves actual runner failures. Real-harness execution is
labeled `MEASUREMENT_COMPLETE`: that means a measurement finished, not that the
agent completed the research loop. The scorer, scientific admission, original
thresholds, provider accounting and staging runner are unchanged.

Primary and independent executions at the exact source pass all eight
typecheck and lint groups and all eight unfiltered root-unit groups. The two
root runs take 1,465.20 and 1,448.27 seconds, with normal owner exit zero and
2,661 unchanged input hashes. Worker passes 7,240 tests; Agora 1,053; the affected
gauntlet package passes 99 tests and 319 expectations plus its original shell
self-test. Actual local Workerd/D1/R2 runs preserve all ten oracle outcomes
(three scripted positives and seven negatives), and an explicit two-reference
selection completes both. The existing Gemini privacy prerequisite returns
blocked 78 with zero agent requests. No model trial was performed in this block.

The original unit assertions catch two independent source faults: dropping the
forwarded selection and collapsing blocked 78 to failure 1. Companion native
observations show the resulting wrong route and wrong exit; they are not extra
caught native faults or model successes. Exact restored controls pass. Both
required stock UBS scans completely cover the three changed code files:
109 findings, zero critical, 13 reviewed warnings and 96 information records,
with identical records and no missing locations, truncation or suppression.
Independent scoped repetition agrees. This does not complete the older broad
incoming scan. Evidence is under `e2e/artifacts/canonical-gauntlet-20261109-coppertiger/`
and `e2e/artifacts/independent-20261109-zai4-e4b21525/`; the requested granular
TODO remains in the existing `hello-actions-20261109-coppertiger/TODO.md`.
WhiteRaven independently closes only `zai.4`; comment 3017 maps its original
criteria to source and observed evidence. Parent `zai` remains open for
the provisioned staging orchestrator, ten fresh sessions across three harnesses,
the eight-completion bar, move-following and first-promotion token measurement.

### Executable first writes, lossless claims and integration repairs — `151469e3`

The combined candidate is `151469e3`, through migration 0140. At `467f99eb`,
typecheck and lint both pass all eight groups with unchanged hashes for 2,661
source files. Independent checks at that exact revision pass the seven native
duplicate, governance, lifecycle, hide, claims-TOON, Stoa and scripted-reference
gates under their original bounds. My subsequent Stoa/TOON rerun also passes.
The incoming Fellow-authored revision and upload-recovery journeys pass on real
local Workerd/D1/R2, as do the full scientific and moderation journeys. Identity,
screening and compiler reports in those lanes remain explicit fixtures.

The 64 earlier unit failures have repairs covering fixtures, strict route and
schema checks, source closure and all three migration inventories. A seven-file
exploratory run passes 552 tests; its source map records concurrent edits to the
two separate capability-census files, so it is not frozen aggregate acceptance.
The retained complete root at `467f99eb` is red: seven groups pass, while Worker
has 7,225 passes and 14 failures across three additional incoming-affected
files. Its original 64 failing cases now pass. The remaining failures are
strict public-write classifications and formulation fixtures with unknown
scientific authorship. The runtime correctly withholds independent review for
unknown authors. Successor `151469e3` supplies canonical attributed fixtures,
accepts a real private Fellow proposal before the warning fixture publishes,
uses its returned statement version, and retains all claim-version, warning and
withdrawal checks. It also adds an explicit legacy-author refusal. All three
files pass. The successor's unfiltered `bun run test` passes all eight groups
in 1,482.61 seconds, normal owner exit zero at 22:44:24.370 UTC. Worker has
7,240 passes, zero failures and 37,287 expectations across 317 files; Agora has
1,053 passes. All 2,661 source hashes remain unchanged. Typecheck and lint each
pass eight groups; full contracts pass 1,005 tests, render 598, and HTTP contracts
pass five with two original, inapplicable skips. Scoped UBS covers all three
changed test files completely, with reviewed findings and no suppressions.

Independent review at `151469e3` also re-executes 108 affected and authority tests,
then ten source faults: seven native authority/privacy regressions, two emitted
first-write regressions and a new forbidden scientific-sponsor inference. Each
reaches its intended assertion; exact restored controls pass. The primary reads
all ten minimal diffs and raw assertion results and reruns those 108 tests.
These are local fault experiments, not observed production exploits. The
verifier's separate typecheck, lint and package/HTTP gates pass. Its unfiltered
root rerun also passes all eight groups in 1,461.55 seconds, normal owner exit
zero at 23:25:25.129 UTC, with the same Worker and Agora test counts. All 2,661
before/after hashes match the `151469e3` source in both full-root runs.

Scanning remains incomplete. The normal staged command reproduced a
`FREE_SLOTS` scheduler crash; documented serial mode completely covers the six
supported files in the latest repair, with 468 reviewed findings and exit 1.
Two isolated tool variants retain every rule and integrity check: one memoizes
regex compilation; the next also tests necessary literal membership before the
unchanged whole-word match. Their exact patches, all 387 tool hashes, inverse-AST
checks and executable semantic comparisons are retained. Both still time out
JavaScript at the unchanged 300-second bound. The latest selects all 431 changed
paths through `151469e3`: 357 JS/TS sources, two Bash, ten SQL and 62 unsupported
types. Independent live inspection verifies all 357 sources plus three
lockfile/package contexts and the isolated helper resolution. That proves input
identity, not analysis completion. SQL and Bash complete; the 31 Bash findings
are reviewed.
No index or independent repeat follows the failed full working scan. Tool work
is stopped, `g4b4` remains open, and the global scanner remains unchanged.
No default repair, full-scan acceptance, security-clean result or issue closure
follows from these experiments.

The two product leaves have a separate applicable source scope. At `151469e3`,
stock UBS executes all 35 paths changed by their four feature/recovery commits,
including dependency and lockfile context: 23 actual module inputs, complete
2,147-location output, finding exit 1 in 14.10 seconds. All critical/warning
sites and information classes are reviewed; no additional product defect is
established. The initial 21-source-only selection omitted dependency context
and is retained with that correction. All 35 working/index/HEAD bytes match,
and all 2,661 source hashes stay unchanged. Independent stock repetition also
completes in 14.16 seconds with identical finding records and original tool
bytes. WhiteRaven independently closes only `df71.1` and `k9o.1`; Beads comments
3008 and 3009 map their original criteria to exact source and evidence. The
ordinary Node claims gate is also rerun by both agents at `151469e3`. These
closures do not complete the 431-path integration scan or close `df71`, its
integration repair children, `k9o`, or `g4b4`.

Two local product gaps are implemented. Authenticated hello now advertises
machine-readable POST descriptors for protocol acknowledgment and the first
session: the actual served schema, method, and a body prefilled from the current
protocol digest or the Fellow's granted problem binding. Unbound Fellows get
schema discovery without a guessed problem. Active sponsor directives precede
every advertised write. The native consumer follows these emitted values,
including strict invalid-body refusal and idempotent session replay. JSON and
Markdown preserve the complete action and permission data; the previous fixed
Markdown permission list omitted evidence and dead-end permissions.

The immutable claims collection now genuinely serves opt-in TOON through
`claims?format=toon` and `Accept: text/toon`. Previously, the old reader ignored
that query and returned Markdown; this repairs an older Fable §7.8 omission.
The canonical Zod query and shared maintained codec preserve the whole response,
including cursors, omissions and screening notices, over actual UTF-8 bytes.
The same immutable reader supplies all faces, current content controls and
continuations. Native checks traverse 205 claims over 26 pages, compare decoded
TOON with canonical JSON, and retain conditional GET/HEAD and privacy checks.
No token savings are inferred from a format change.

Independent testing also exposed two defects in the rare formatter-failure
path. Recovery links now bind the captured cursor and page position. The new
canonical teaching code `FORMAT_UNAVAILABLE` supplies a safe JSON alternative;
`INTERNAL_ERROR` remains opaque. A formatter-only source fault produces the
typed response and recovers cursor 1 after a later real D1 write advances the
head to 2. The same fault with only the old link construction fails the original
cursor assertion. Restored normal formatting is checked separately. This
dependency-failure experiment is not a normal TOON or scientific admission run.

The incoming `22c03e14` integration is retained. Its two unit conflicts preserve
old and incoming assertions, including the canonical publication writer
establishing an empty head. Additional repairs wire returned brief versions,
pin migrations 0136/0137 in all three gate inventories, and reconcile exact
discovery, race and versioned-reader expectations without broadening accepted
statuses. Supported hypotheses now have a real report/uphold/hide test; a
separately labeled historical unsupported-kind D1 fixture retains the original
no-false-hide assertion. These fixtures are not fresh route or external
identity proof.

At `2f874579`, all thirteen checks preceding the aggregate pass, including five
targeted native families, full contracts (1,003 tests), render (598 tests),
typecheck, lint and HTTP contracts. The complete root unit run is **red**:
seven groups pass, but Worker has 7,135 passes and 64 failures. These failures
are repaired by the successor above; the original red result remains retained.
An additional 377-path scan also remains **partial**: JS times out at
1,200 seconds; SQL covers seven files and Bash two, with reviewed findings.
Neither longer time nor selected successful languages supplies missing JS
coverage. Those focused passes did not close the feature or integration tasks.
The initial formatter experiment stopped before cursor checks on the opaque-error contract;
it was not a passed recovery test. Default full-merge scanner timeouts remain
partial results, and a longer supplementary scan does not repair those defaults.

The concurrent `43482f0d` merge adds 93 paths through migration 0140, including
Fellow-authored statement proposals and artifact recovery. `df71.3` tracks
preservation of both session-test worksets and qualification of this expanded
source; older receipts do not qualify it. The first aggregate's 64 failures are
accounted across eleven files. Repairs retain scientific and privacy guards,
and correct fixture inputs, source inventories and nonvacuous race hooks.

One local test-resource policy was explicitly revised before implementation:
S3's raw canonical graph-evidence ceiling rises from 3.5 to 3.75 MB. Independent
measurement found complete production/counterfactual evidence of 3,607,263 and
3,641,931 bytes. The original overrun and old criterion are retained; the new
tests accept 3,500,001 and 3,750,000 bytes and refuse 3,750,001. Ordinary 1 MB
captures, the 8 MB fresh-result cap, full raw arrays, parent-derived facts,
source pins and deadlines remain. This is a changed evidence capacity, not
fulfillment of the earlier no-ceiling-change wording. Compression was considered
but not implemented; public schema compaction already exists.

One actual Codex journey at the earlier `94f9a3e9` source completes the local
flow and handback, including injected 422 recovery: 29 requests, 123,813 ms and
726,143 whole-session tokens. That is not a new model trial at `2f874579`, a
measurement to first promotion, or the three-harness staging G-C result.
Evidence and the requested granular TODO are under
`e2e/artifacts/hello-actions-20261109-coppertiger/`; independent evidence is under
the corresponding `independent-20261109-df71-k9o1-*` directories. Deployment
authority/lineage, the unfinished staging gauntlet orchestrator, real external
screening and browser/Rust acceptance remain separate. No deployment, push,
provisioning, deletion or history rewrite was performed.

Project-identified public reads at 00:14 UTC on November 10 return the older
production and staging `0.1.0-draft` capability bytes, identical to the retained
earlier responses. This identifies the observed interface, not provider revision
or deployment history. A 00:20 UTC presence-only check finds the four required
Cloudflare and staging variables absent from this command environment; that is
not a stored OAuth authority audit. Operator bead `rs5n` still requires the sanctioned Workers
Builds configuration, an explicit decision about existing staging D1 lineage,
and retained staging receipts before production reconciliation.

### Actual cold-agent participation — 2026-11-08, `db94e495`

WhiteRaven independently closes only `zai.2` and `zai.3`; Beads comments 2983
and 2984 map their original acceptance to exact source lines and owned evidence.
These are local participation-tooling repairs, with no new public feature.

The actual local runner now supplies the sponsor paste through stdin, uses
Claude's nonpersistent safe mode and Codex's ephemeral mode, and ignores
Codex user configuration while retaining its normal execution policy. Gemini
and Grok report a privacy prerequisite before spawning because a recording
disable control has not been verified. This concerns the harness launch and
runner retention; it does not attest every argument of arbitrary tools an
agent subsequently executes. Real-trial output contains counts, digests,
coarse statuses and fixed route templates, with no raw stderr or scientific
face samples. Oversized stdout is fully drained and hashed, with usage unknown
rather than inferred from a partial capture.

The runner also consumes the existing authoritative usage parsers. Previously,
its duplicate Codex parser kept only the final turn, and missing Claude usage
became an invented zero. The regression cases distinguish 460 from 340 tokens,
preserve additive Anthropic cache accounting and require null on missing or
malformed usage. Provider totals are explicitly for the **whole session**;
tokens to first promotion remain unmeasured.

At this frozen source, an actual Codex agent completes the local Workerd/D1/R2
journey: enrollment and sponsor approval, session and pack, workshop, recovery
from an injected `PROMOTE_BODY_INVALID` 422, public falsifiable claim, and close
with a handback. It makes 22 requests in 101,214 ms and reports 611,598
whole-session tokens. Claude is usage-limited before any site request; Gemini
never starts. The requested-three command therefore exits 78 **blocked**.
These are one completed model journey and two prerequisite outcomes, not a
three-harness result. Identity and screening are local fixtures, not Google
or hosted screening. The default ten-case run is a separate scripted oracle
check: three positives and seven negatives, with zero model trials.

An independent actual Codex run at the same source also completes all stages,
including the injected refusal: 25 requests in 97,470 ms, with 662,796
whole-session tokens (659,695 input plus 3,101 output). Cached input and reasoning
are subsets and are not added again. Its normal owner exits zero, with all
2,473 source inputs unchanged. Neither actual run measures tokens at promotion.

Both agents pass the whole gauntlet package: 94 tests / 252 expectations plus
its original shell self-test, the ten scripted oracle cases, and root typecheck
and lint (all eight groups). The primary unfiltered root unit run passes all
eight groups in 1,399.71 seconds, normal owner exit zero at 00:15:52.395 UTC on
November 9. Worker has 6,924 passes / 32,658 expectations, Agora 918 / 6,242,
gauntlet 94 / 252 and render 398 / 4,445. The original 54 individual toolchain
skips remain; no whole group fails, blocks, skips or goes missing. All six
primary and six independent positive before/after maps match the current
2,473 source inputs. This is a primary full-root result, not an independent
full-root, fresh full-contract, browser or optional Rust result.
Four independent source mutations already reach their intended original
assertions: expose the paste in argv, return raw stderr, retain only the last
Codex turn, or replace missing Claude usage with zero. Each owner exits one
normally with stable mutant inputs; exact restoration precedes positive gates.
UBS completes five inputs with zero critical findings, nine reviewed warnings
and 120 information items, without suppression. The warnings concern fail-loud
fixture parsing, synthetic synchronous fixture writes, awaited promise chains
and existing bounded loopback fetches.

The first exploratory Codex run inherited user configuration and is not frozen
qualification. The initial synthetic unit failure printed only a synthetic
paste, and an initial typecheck failure exposed an incorrect spawn overload
type; both were corrected before this source freeze. A bounded diagnostic
identified Claude's structured provider status 429. One diagnostic discarded
stderr and is not complete gate evidence. Failed and partial records remain
under `e2e/artifacts/cold-journey-20261108-coppertiger/`; independent evidence is
under `e2e/artifacts/independent-20261108-zai-2-3-db94e495/`.

This repairs participation tooling, not the unfinished staging orchestrator.
`run-gauntlet.ts` still reports `GAUNTLET_PRODUCT_FLOW_NOT_IMPLEMENTED`;
credentials alone cannot supply that implementation. Parent `zai`, the
10-session/three-harness/eight-completion/25K-token criteria, semantic following
of an offered move, deployment, G0 and launch remain unearned.
Fresh project-identified public reads at 00:01 UTC on November 9 still return
the old production/staging `0.1.0-draft` capability bodies. That identifies the
observed interface, not provider revision or deployment history. The four
required Cloudflare/staging variables remain absent in this command environment.
The physical primary also has about 13 GiB available, and normal
`TMPDIR=/data/tmp` Beads doctor/export/staging work. Doctor exits one with a
healthy database and existing housekeeping warnings. Independent review keeps
`0oi3` open: its named historical full snapshot is still absent without a
byte-verified equivalent. Current headroom and a successful export cannot
satisfy that preservation condition; no cleanup or recovery cause is claimed.

### Replay observer publication — 2026-11-08, `10bbe002`

The S1 gate contained a ready-file race: its producer opened the final observer
path before writing its PID, while the reader rejected an empty visible file.
An unchanged positive passes; adding only a 250 ms scheduling pause between
open and write reproduces `REPLAY_DERIVATION_OBSERVER_UNTRUSTED`. The correction
prepares an exclusive, no-follow private file, writes and closes it, then
publishes with a no-overwrite hard link. The same pause passes; restoring early
publication fails again. The original live argv/key/secret checks remain strict.
Normal key derivation has no observer and incurs no pause. Diagnostics now
expose only coarse codes, phases and the owned coprocess PID/birth identity.

This is a local gate repair, not a new research feature or proof of the cause
of the primary-only `5bf3404b` failure. A bounded search of retained captures
did not recover that failing record; `pjuf.2` remains unclassified and open.
Independent review also caught a misleading comment about cached FD numbers;
that change was removed before final qualification. The first attempt's shell
comment quoting error and superseded `2df8b8cf` partial checks remain retained.

At `10bbe002`, primary literal observer and local D1 enrollment, root typecheck
and lint pass. The primary unfiltered project unit run passes all eight groups
in 1,408.24 seconds: 6,924 Worker tests / 32,658 assertions, 918 Agora tests and
398 render unit tests. Its owner exits normally at 23:01:24.702 UTC, with all
2,473 source hashes unchanged. The original 54 individual toolchain skips remain;
no whole group skips, blocks, fails or goes missing.
Independent literal observer/local D1, all eight typecheck/lint groups and the
complete unfiltered S1 file pass: 125 tests, 1,169 assertions, 380.64 seconds,
normal owners and 2,473 unchanged source inputs. This is not an independent
eight-group unit result. A planned duplicate aggregate was deliberately retired
at its exact owned dispatcher after the scope changed to S1; its owner exits 130,
and its recorded group is empty. That partial run is not acceptance.

The independent early-publication mutation reaches the exact coarse refusal
and fails the original exit-zero assertion, with no entropy or key bytes in its
logs. Both adverse owners also report `descendant-leaked` with subject exit one;
`cleanupProven` is absent. Those results are not normal exited-one owners or a
diagnosis of the historical failure. Exact restoration passes, and primary
literal observer/local-D1 reruns after raw-evidence review pass with stable
source. No cleanup assertion was relaxed.

UBS completes both changed inputs but exits one: four reviewed
preexisting critical flags, 365 warnings and 438 information items. The critical
contexts are a constant shell-version eval, numeric-guarded descriptor closure
and duplicate dynamic-descriptor ShellCheck flags. All 356 Bash warnings classify
the fixed-set Bash bootstrap as POSIX; nine JS warnings concern existing test
paths. No finding is suppressed, and this is not a clean-scanner claim.

Evidence and the requested granular TODO are under
`e2e/artifacts/s1-observer-20261108-coppertiger/`. The original S1, hosted
gauntlet, deployment, screening, cost and launch acceptance remain separate.
Fresh 22:50 UTC project-identified public capability reads return the same old
production/staging `0.1.0-draft` bodies. These bytes identify the observed
interface, not provider revision or deployment history. The four required
Cloudflare/staging variables remain absent from this command environment.

### Hypothesis and formulation test repairs — 2026-11-08, `2c84aaf5`

**Both agents pass all eight scoped qualification commands at this exact
source. WhiteRaven independently closes `x4t.1`, then dependent `axq.1`;
Beads comments 2975 and 2976 map their original acceptance to source and evidence.**
These repairs address actual failures found while checking
the incoming merge, and change no production eligibility, public contract or table.

`5bf3404b` corrects a hypothesis journey that demanded a creation event in an
`orient` pack. Fable §7.3/§9.6 selects material events there, including hypothesis
kills. The test now requires explicit creation omission and its disclosure,
then checks the exact creation and its warning outside the untrusted body in
the full export. Existing graveyard, refusal, visibility, withdrawal, inbox and
rebuild checks remain. Ordinary enrollment of an auxiliary Fellow under the
same sponsor isolates the new policy probes and a replay-only claim-evidence
fixture. The substantive hypothesis evidence retains its original authors.
Actual D1 counts are 20 attempts for the scientific author and five for the
auxiliary Fellow; the 20-per-hour ceiling and existing sponsor fixture are unchanged.

That native journey passed, but both complete `5bf3404b` unit runs failed:
seven groups passed and Worker failed. Primary Worker has 6,897 passes and
27 failures; independently, 6,898 and 26. Most failures follow one newly reached
formulation module missing from S-2's source list; four more expose unit
fixtures missing the new reader's admission mode or committed formulation.
Deliberate malformed-screening-receipt error stacks are unrelated expected
test paths. The primary-only S1 argv-observer failure remains unexplained in
`pjuf.2`; independent unfiltered and unchanged literal controls pass. Those
controls supply no diagnosis, and that bead remains open.

`2c84aaf5` adds the missing source pin and repairs the two existing move fixture
files. Only two production-default unit cases seed a typed governance publication
through the existing ledger writer with their actual Fellow and sponsor.
The writer establishes integrity from an empty head; an earlier incorrect
genesis setup correctly failed and is retained. The sharpening expectation uses
the current read URL with its captured cursor and exact fixture-event digest.
This is unit fixture proof, separate from HTTP governance admission.

Both agents execute focused pack units (73 tests / 726 expectations), move units
(35 / 319), actual local scientific/moves/hypothesis journeys, and root typecheck,
lint and unfiltered unit. Each root gate passes all eight groups. Full unit takes
1,442.22 seconds primary and 1,434.47 independently: each has 6,924 Worker tests /
32,656 expectations, 918 Agora tests / 6,242 and 398 render unit tests / 4,445.
The original 54 individual toolchain skips remain; no whole unit group skips,
blocks, fails or goes missing. The final root includes the complete S-2 harness
family; its pre-freeze standalone run is 151 / 0 / 1,415. All 2,473 tracked inputs
outside Beads and this assessment remain equal across the completed commands.
These are the eight commands actually executed, not a fresh full-contract,
browser, hosted-provider, cold-model or optional Rust acceptance.

Four isolated faults at `2c84aaf5` reach their intended assertions: remove a full
pack warning, wrongly treat hypothesis creation as material, omit the new S-2
source pin, or counterfeit the sharpening publication digest with valid-shaped
hex. Each owner exits one; the counterfeit gives 34 unit passes and one intended
failure. Exact restoration and fresh primary literal move/source/hypothesis
commands pass. The source fault runs one named test with 150 filtered; it is not
151 fault executions or a native S-2 cost result. The verifier initially invoked
an exported scientific helper that executes no subject. That zero exit is kept
as nonproof; the correct registered scientific entrypoint subsequently completes
with real stages and a normal owner exit at the original bound. All 227
registered anchors match; this does not mean all 227 faults were executed.
UBS diff/staged completes all three correction inputs (two JS/TS, one Bash),
with zero critical findings, seven reviewed warnings, 261 information items
and no failed modules or suppressions. The earlier hypothesis-test scan covers
one input with zero critical, 25 reviewed warnings and 191 information items.

Evidence and the granular TODO are under
`e2e/artifacts/gauntlet-completion-20261108-coppertiger/` and
`e2e/artifacts/independent-20261108-axq-x4t-2c84aaf5/`. Earlier failed and partial
attempts remain intact. No deployment, provisioning or push was performed;
the original `zai`/screening/operations parents and G0/launch gates remain open.

### Local completion verdict — 2026-11-08, `e684feb6`

`e684feb6` repairs three false-completion paths in the existing local gauntlet
(`zai.1`): completion now requires an observed successful pack GET for an owned
session, an own public claim with a nonblank falsifier, and an owned closed
session with a handback. Private handback text is reduced to a presence boolean.
A valid lemma with a falsifier qualifies. This is a local verification enabler;
an observed response does not establish comprehension or semantic move-following.
WhiteRaven independently closes only this leaf; Beads comment 2971 maps the
corrected acceptance to source lines and actual execution evidence.

Both agents pass all five scoped commands at this exact source: whole gauntlet
unit 76 tests / 199 expectations plus its original shell self-test, default
native local run, and root typecheck, lint and unfiltered unit. Each root gate
passes eight groups; full unit takes 1,432.09 seconds primary and 1,505.35
independently, with 6,827 Worker and 914 Agora tests each. The original 54
individual toolchain skips remain. The native run has ten **scripted oracle
cases**: three positives and seven negatives, zero cold-model trials. Four
isolated scorer faults each produce exactly one intended wrong verdict with
the other nine correct; exact restoration and a fresh primary literal native
run pass. All five feature hashes remain equal across both qualifications.

The first implementation incorrectly required a conjecture-class claim as
well as a falsifier; both agents initially missed that extra restriction.
Rereading Fable caught it before closure. A real valid-lemma positive fails
the exact old scorer and passes the correction. Comment 2970 preserves the
original child wording and restores the original kind-independent Fable
criterion. Superseded `3574b27a` full unit attempts were intentionally retired
and remain partial evidence; early fixture-precondition failures remain
nonqualifying. No parent criterion, application admission or test limit changed.

Correction UBS diff/staged completes four changed code inputs: zero critical,
eight reviewed warnings, 136 information items and no failed modules. The
unchanged declaration hash matches its earlier five-input scan; this is not a
current five-input or universal security-clean claim. Raw evidence and the
granular TODO are under `e2e/artifacts/gauntlet-completion-20261108-coppertiger/`
and `e2e/artifacts/independent-20261108-zai-1-e684feb6/`.

Parent `zai` remains open. The provisioned staging runner still reports
`GAUNTLET_PRODUCT_FLOW_NOT_IMPLEMENTED`; credentials alone cannot supply it.
Actual fresh sessions across three harnesses, success/token criteria and
remaining original work are unearned. Fresh 22:04 UTC honest-UA capability
reads return the old production/staging `0.1.0-draft` bodies; they do not
identify provider revision or deployment history. Google, hosted screening,
G0, launch and optional Rust acceptance are separate. A later external merge
to `9cf40cbb` at 20:17:17 UTC arrived after the primary root finished; these
`e684feb6` results do not qualify its 39 incoming application/package files.
Its integration is qualified separately above at `2c84aaf5`.

### Local target cleanup — 2026-11-08, `f061d6a0`

`f061d6a0` connects gauntlet targets to the native journey's existing Wrangler
builder ownership mechanism (`pjuf.1`). A native probe observed a live esbuild
child after `target.close()` returned; the new native assertion fails on the
old code. The shared helper now waits for the actual child's close event,
preserves overlapping owners and makes repeated target closes idempotent.
Failed setup also retires the harness and builder; proxy-listen errors reject
into that cleanup path. This is a local verification enabler, not a new product
surface or a diagnosis of historical failures.
WhiteRaven independently closes only `pjuf.1`; Beads comment 2968 maps every
original acceptance item to source lines and actual execution evidence.

Both agents pass all six prescribed commands at this exact source: typecheck
and lint eight groups, root contract five required groups with its original two
policy skips, full contracts 959 tests and render 592. Complete unfiltered unit
runs pass eight groups in 1,436.40 seconds primary and 1,456.69 independently;
each has 6,827 Worker tests, 914 Agora tests and the original 54 individual
toolchain skips. The existing native cleanup lane passes all six modes,
including an actual failed runtime startup and mixed target/journey ownership.
Both production Next/Chromium lanes pass all 290 checks with normal owners at
the original 300-second bound. Three isolated builder faults reach their
intended assertions and are restored exactly; all 227 registered fault anchors
match. Five source hashes stay unchanged and equal across agents.

Three earlier unchanged complete browser controls also pass, but those null
observations do not identify the historical residual. Broader `pjuf` remains
unfinished, including its navigation and unit-timeout observations. UBS completes
all five changed inputs; three critical flags (an existing adverse logging
string and two header-presence booleans), three warnings and 128 information
items are reviewed without suppressions or failed modules. Evidence and the
granular TODO are under `e2e/artifacts/pjuf-20261108-coppertiger/` and
`e2e/artifacts/independent-20261108-pjuf-1-f061d6a0/`. Fresh 07:07 UTC public
capabilities still have the old production/staging `0.1.0-draft` bodies. No
deployment occurred here; Google, hosted screening, G0 and launch remain unearned.

### Unverified claim gaps — 2026-11-08, `04d0c39a`

`04d0c39a` repairs the existing What-remains-unverified panel (`n9n.3`).
Displayed T3 reviews now count alongside T2 for displayed cross-family coverage,
without granting scientific weight. Missing displayed records, zero qualifying
refutation counts and a false artifact-support flag no longer imply globally
absent review, adversarial work or compiled proof. Legacy and stale explanations
avoid invented cryptographic validation or a cache diagnosis. APIs, contracts,
scientific eligibility and canonical state are unchanged. WhiteRaven independently
closes only this leaf; comment 2965 maps the original acceptance to source/tests.

Both agents pass all six prescribed commands at this exact source: typecheck
and lint eight groups, root contract five required groups plus its original two
policy skips, full contracts 959 tests / 7,208 expectations, render 592 / 6,050,
and complete root unit eight groups in 1,435.20 seconds primary and 1,437.90
independently. Worker has 6,827 tests each; Agora has 914 / 6,170. The toolchain's
54 original individual skips remain. Actual production Next/Chromium with local
Workerd/D1/R2 passes all 290 JS/no-JS checks, preserving all 288 earlier checks
and original limits. Four isolated production faults are caught (each 22 pass /
1 fail), then restored to 23 / 0 / 155; primary inspects the diffs/raw failures
and reexecutes the exact package-local command. All three source hashes remain
equal and unchanged across the completed qualification.

The first independent browser has 290 product successes but an owner outcome
of `descendant-leaked`; that attempt failed ownership. Its residual identity
was not captured and remains unknown. One authorized unchanged serial control
subsequently passes with a normal owner exit and existing-checkpoint safe SID
snapshots. This is current positive product evidence, not a diagnosis or
reliability repair; both attempts remain retained and `pjuf` stays open. No
assertion, owner policy, flag, deadline or quota was weakened. UBS completes all
three changed code inputs (two reviewed existing browser path/status critical
flags, 57 warnings, 281 information items, no failed modules or suppressions).
The original VM baseline is 20 pass / 3 fail. Evidence and the detailed TODO are
under `e2e/artifacts/gaps-20261108-coppertiger/` and
`e2e/artifacts/independent-20261108-n9n-3-04d0c39a/`.
Parent `n9n`, deployment, real-agent/Google, G0 and launch acceptance remain open;
local synthetic screening/bootstrap and minted Auth.js sessions do not replace them.

### Claim disposition causes — 2026-11-08, `e78cf6c3`

`e78cf6c3` wires the existing scientific fold into canonical `status_basis`
metadata and Agora's Why-this-status panel. Readers can distinguish an author
concession from a review or counterevidence, inspect the exact existing public
event-history window, and see disclosure limits or an unavailable cause when
the source is withheld, stale or missing. Displayed reviews remain related
records, rather than an invented causal explanation. The scientific eligibility
rules, write paths, tables and public URLs are unchanged. WhiteRaven independently
closes only `n9n.2` at this exact revision; Beads comment 2963 maps every original
acceptance item to source lines and retained execution evidence. Parent `n9n`
remains open for its original breadth.

Both agents execute all six prescribed commands: typecheck and lint pass all
eight groups; root contract passes five required groups with its original two
policy skips; full contracts pass 959 tests / 7,208 expectations and render
passes 592 / 6,050. Complete root unit runs pass all eight groups in 1,470.91
seconds primary and 1,472.42 seconds independently. Worker has 6,827 tests /
32,485 expectations across 290 files; Agora has 911 / 6,154 across 66 files.
No whole unit group fails, blocks, goes missing or skips; the toolchain retains
its original 54 individual skips. The actual Workerd/D1/R2 dispositions journey
and genuine production Next/Chromium browser lane pass for both agents; each
browser passes all 288 checks, including JS and no-JS concession/history
readback. Original owners exit zero with all 22 source/test/schema/golden hashes
unchanged and equal across agents, using only their own CPUs 0–1 and 2–3.

Five independent faults are caught and restored at `e78cf6c3`: wrong event
sequence, missing verified-source guard, bypassed causal-metadata validation,
accepted extra renderer fields and impossible transition tuples. Restored
feature tests pass 107 / 0 / 957 expectations, and the original discovery file
passes 17 / 0 / 1,427; the primary reexecutes the exact package-local commands.
Earlier boundary defects, formatter failure, unavailable browser, erroneous
concession request, navigation/pagination assumptions and publication-quota
failure remain in the evidence. The verifier also caught the stale discovery
byte-count golden: `e78cf6c3` changes only the ledger entry from 91,588 to 95,142
bytes, after checking that every other generated index field is identical.
Superseded `a665b877` unit runs were intentionally retired after that original
16-pass/1-fail discovery result; they do not count as complete qualification.
No assertion, deadline or quota policy was weakened. The existing contract-editing
instructions now remind editors to check this discovery dependency early.

UBS completes all 18 changed code inputs, with six reviewed critical flags,
156 warnings and 1,596 information items, and no failed scanner modules or
suppressions. The critical flags concern existing fixed projection/header/table
composition, browser pathname/status comparisons and public checkpoint-key
ordering; this is not a clean security-scan claim. JSON-only golden and final
documentation/Beads scans have no supported inputs, rather than a scanner pass.
Detailed TODO and raw evidence are under
`e2e/artifacts/status-basis-20261108-coppertiger/` and
`e2e/artifacts/independent-20261108-n9n-2-74289a46/` (the final receipts use
the `e78cf6c3-` prefix).

Fresh honest-UA public capability reads at 05:28:47 UTC on November 8 return
HTTP 200 and the same `0.1.0-draft` bodies: production `1844555d…bbc0`, staging
`8e79852b…aa70`. They do not identify provider revision or deployment history.
No deployment or provisioning was performed in this work. Local screening and
sponsor bootstrap are synthetic; the browser uses a locally minted Auth.js
session, not a Google OAuth exchange. Operator deployment and D1-lineage decision
`rs5n`, staging gauntlet `zai`, parent `n9n` and G0/launch acceptance remain open.

### Claim independence readback — 2026-11-08, `eac14502`

`eac14502` repairs Agora's independence explainer (`n9n.1`). Same-sponsor T0
reviews no longer count as T1. T1 means another sponsor; T2 adds a different
self-declared model family; T3 adds a supported disjoint method, rather than
implying a formal machine proof. The page explains review-time pinning and
separates independence from scientific correctness and formal-artifact status.
Single-team caution uses known publication sponsors even when Fellows differ;
missing sponsor metadata remains unknown. The Worker scientific fold, contracts,
public URLs, validators and test limits are unchanged. The earlier citation-safety
merge `f115c99e` is preserved in the qualified candidate.
WhiteRaven independently closes only `n9n.1` with the original-acceptance and
file:line map in Beads comment 2960; the parent stays open.

Both agents execute all six prescribed commands at exact `eac14502`: typecheck
and lint pass all eight groups; contract passes all five required groups with
its original two policy skips; full contracts pass 958 tests / 7,174 expectations
and render passes 592 / 6,047. Complete root unit runs pass all eight groups in
1,438.59 seconds primary and 1,483.45 seconds independently, both owner exit zero
with stable source hashes. Worker has 6,821 tests / 32,468 expectations across
290 files; Agora has 908 / 6,127 across 66 files. No whole unit group fails,
blocks, goes missing or skips; the toolchain retains its original 54 individual
skips. Both genuine production builds and real Chromium/local Workerd/D1/R2
browser runs pass all 280 checks, including JavaScript and no-JavaScript tier
readback. Their original 300-second owners exit zero in about 63 and 83 seconds.
Only the agents' own processes use two CPUs each (0–1 primary, 2–3 verifier).

Three independently planted faults are caught and byte-exactly restored: T0
collapsed into T1, the old formal-proof heading, and missing sponsorship treated
as single-team. The heading fault uses an actual rendered-component unit check;
the complete browser is separate evidence. The initial exact unit baseline is
15 pass / 2 fail, then 17 / 0 with 112 expectations. An initial browser has
278 / 280 because a new assertion also assumes an unchallenged facet; the real
canonical record is open with `unchallenged=false`. The corrected assertion
compares canonical disposition, retaining the tier and caution checks. These
failures remain in the requested TODO/evidence, rather than being relabelled green.
UBS completes all five changed code inputs, with two reviewed critical flags for
existing browser pathname/status comparisons, 48 warnings and 271 information
items. No analyzer rule is suppressed; this is not a clean security-scan claim.
Evidence and the detailed TODO are under `e2e/artifacts/tiers-20261108-coppertiger/`
and `e2e/artifacts/independent-20261108-n9n-1-eac14502/`.

Fresh honest-UA public reads at 03:40 UTC on November 8 return HTTP 200 and the
same old `0.1.0-draft` capability bodies: production `1844555d…bbc0`, staging
`8e79852b…aa70`. They do not identify provider revision or deployment history.
No deployment or provisioning was performed. Parent `n9n`, operator deployment
and D1-lineage decision `rs5n`, staging gauntlet `zai`, and G0/launch acceptance
remain open; these local results do not replace Google, provider or fresh-agent
evidence.

### Implementation follow-through at `ad6d3c7c`

Commit `6e1b72aa` fixes the two observed candidate-check failures without
changing the private inbox's authority or the fault plant's replacement bytes.
It also fixes `9o8v`: product smoke failures now recommend product mode, while
self-tests recommend self-test mode. The existing receipt consumer replays
both modes and rejects deliberately wrong-mode receipts. The full original
entrypoint suite passes; authenticated gallery implementation remains open.

Commit `ad6d3c7c` connects existing Explore/area need chips to the canonical
public review queue (`80s3`). Reads sample one bounded page, fence membership
against current visibility/cursors, and disclose partial or unavailable
selection. No new schema, table, public route, ranking or permission is added.
The native Workerd/D1/R2 lane passes actual claim publication, all faces/ETags,
private workshop stability, operator hide/restore, withdrawal, pagination,
projection replay, search and credential-log checks. Shared contracts pass
953 tests and render passes 586. Root typecheck and lint each pass all eight
groups; contract passes all five required groups. The full original unit
dispatcher passes all eight groups in 2,264.61 seconds: Worker 6,756 tests and
31,750 expectations, Agora 900 tests. No group is failed, blocked, missing or
skipped; the toolchain still contains its original 54 individual skips.
The independent original full-unit rerun passes all eight groups in 1,511.37
seconds, with the same Worker/Agora totals. Independent typecheck/lint/contract
and full contracts/render reruns also pass. The standalone Worker security
suite passes 33 tests and 288 expectations. These runs use unchanged
application, test, gate, configuration and lockfile bytes at `ad6d3c7c`.
Revisions through `a565a572` change documentation and tracker records only.

The production browser build passes. The primary attempt initially stalls
during detector self-tests, resumes without intervention, then times out on
the first no-JavaScript root navigation after 77 passing checks. Independently,
the complete browser subject passes all 239 checks and exits zero, including
both JavaScript and no-JavaScript area assertions, but its existing process
owner reports `descendant-leaked`. Its aggregate lifecycle result is red.
One further unchanged complete control passes all 239 checks and its owner
returns `exited`, exit zero. Its completion callback sees only the pinned
supervisor; sampling adds about 34 ms at completion. This bounded null
reproduction supplies current positive proof, not a diagnosis of the first
owner result or the primary navigation timeout.
The independent discovery run records 39 passes and one existing Now-case
timeout at its unchanged five-second limit, including all new area checks
passing. The earlier focused run's 40 passes do not erase that failure.
Independent review closes `sewo`, `bwal`, `9o8v` and `80s3` against their
original acceptance. The P0 `bwal` decision includes the complete registered
S-2 source/journal unit file in the unfiltered run and fresh focused
statement-context and sponsor-inbox native journeys. It does not claim the
separate opt-in provider/lifecycle integration or transfer the earlier
34-mode discovery receipt to newer code. Generic trigger exclusions and the
reviewer's initial wrong test path remain recorded.
The distinct unresolved runtime observations remain in `pjuf`;
no common cause or diagnosis is inferred from later passing controls.
UBS completes all nine changed code files; its four critical flags are existing
test/fault strings or browser URL/status comparisons, reviewed without
suppressing analyzer rules. Evidence is retained under
`e2e/artifacts/implementation-20261107-coppertiger/`. The original assessment
and failures below remain dated evidence for the earlier source.

### Fellow negative knowledge at `316bf7b1`

`81c4da18` connects existing public dead-end publications to Fellow cards
(`dn6.2`). JSON, Markdown, HTML and Agora expose the attempted approach,
failure, retry condition and event-time attribution, with an independent
eight-entry reading window and continuation. It reuses the immutable-content
reader, excludes private/unlisted/hidden work, and discloses unverifiable or
incompletely attributed records. Dead ends remain neutral history without a
calibration total or rank. `97297527` applies the existing formatter to the
extended native journey; its assertions and application bytes are unchanged.
`316bf7b1` finishes the generated discovery references for all eight Fellow
faces and fixes independently observed narrow-screen overflow. The generated
data comparison changes only the eight parameter arrays and discovery schema
size (39,398 → 46,328 bytes). The original generation gate has 15 passes and
two failures before correction, then 17 passes with 1,419 expectations.

Primary typecheck and lint pass all eight groups; contract passes all five
required groups with its original two policy skips. Full contracts pass 954
tests and render passes 587. The complete original ordinary unit dispatcher
passes all eight groups in 1,540.63 seconds, terminal zero: Worker 6,759 tests /
31,826 expectations and Agora 900 tests / 5,988 expectations. Its toolchain
retains the original 54 individual skips; no whole group is skipped or blocked.
The corrected production browser passes 254 checks and exits zero, independently
repeated with its unchanged 300-second owner, including JavaScript and
no-JavaScript Fellow history.
At 390px, the document remains 390px wide and every history preformatted block
has matching 332px client/scroll widths. The earlier 252-check run missed this
overflow: independent observation at `97297527` measured a 2,042px document
before the fix and the two new width assertions. Native HTTP publication/readback
covers two pages, six conditional faces, private workshop stability, historical
attribution after bilateral transfer, operator hide/restore, private/unlisted
exclusion and redaction invalidating each exact cached representation.
These are local Workerd/D1/R2 and production Next.js results. Initial fixture
guard failures, missing receiving sponsor and the formatter failure remain
in the retained logs. The known-stale first full unit run was interrupted with
SIGINT, exit 130; it is partial evidence. Later unit and typecheck controllers
unexpectedly end with SIGTERM, exit 143, before completion (`sbuk`). Tracing every
descendant then prevents the unchanged PID-namespace prerequisite: paired
probes pass untraced and with main-controller-only observation, but fail under
all-descendant tracing. That diagnostic unit attempt records 376 passes,
89 skips and one prerequisite failure before deliberate interruption; it is
not source qualification. The final ordinary unit run observes only its two
existing main controllers, with no descendant tracing, source change or
deadline relaxation. It completes with no unexpected controller signal;
the tracer and observer exit zero. This is a null reproduction, not a diagnosis
or repair of `sbuk`, which stays open. The first independent focused run has
99 passes and one unchanged Now-case five-second timeout, including all new
Fellow history tests passing. This repeats an unresolved `pjuf` observation;
no cause is inferred. Another first filtered default-five-second run has two
passes and one timeout; unchanged complete and package-prescribed-120-second
controls pass all 100 focused cases. Matched empty-history fault tests fail
all three cases against an unmutated three-case pass. No source deadline is
changed. An initial independent outside-root dependency setup fails before
browser assertions; a contained pinned-dependency setup fixes that prerequisite.
Its first full browser controller also ends 143 before completion. A first
corrected-source browser owner times out at its unchanged 300-second limit;
an auxiliary observer produces no measurement. All remain recorded; the
complete subsequent 254-check control does not explain them. The independent
real-HTTP supersession journey also preserves original body and publication
attribution across all three faces, with one replay-consistent problem and no
seed exclusion; primary reexecution passes. UBS scans finish with four reviewed
critical flags: the shared escaped HTML sink, two existing browser URL/status
comparisons and the existing unit test secret. No analyzer rule is suppressed
and no clean security-scan claim is made. Evidence is under
`e2e/artifacts/dn6-2-20261107-coppertiger/` and
`e2e/artifacts/independent-20261107-dn6-2-81c4da18/`.
Independent review closes `dn6.2` at `316bf7b1` after checking the complete
ordinary root-unit terminal and the original unchanged acceptance. Later
changes are documentation and tracker records only.

The broad `dn6` calibration/honors task, `rs5n` deployment reconciliation and
G0/launch gates remain open. This source addition supplies no deployed,
Google OAuth or fresh-harness acceptance.
Fresh read-only production/staging `/capabilities` requests at 08:55 UTC both
return `0.1.0-draft`, byte-identical to the earlier retained bodies. This does
not establish provider revision or deployment history. No deployment or
resource provisioning was performed.

### Exact public records at `cb994ce3`

`0909bde1` fixes known published review and claim-evidence records becoming
unavailable after the ordinary claim face's first 20 candidates (`92x.3`). The
existing canonical snapshot selects the requested item before its bounded SQL
window, while retaining the same captured cursor, scientific fold, immutable
body verification, visibility and size limits. Ordinary faces keep their stable
prefixes and explicit omissions. Shared Fellow Markdown/HTML and Agora now link
to the existing exact review reader, with its target version, publication-time
attribution and eligible work product. No route, table, query parameter or
authority is added.

Incoming citation-screening and readiness changes exposed qualification drift.
`bcc837ec` reconciles the strict optional citation-notice schema, narrows unit
notice assertions to ledger items, and checks the actual expiry-aware
capabilities cache and readiness response. `356b149d` installs the existing
screening-publication migration in two minimal unit fixtures, adds three actual
readiness dependencies to S-2's strict source attestation, and updates discovery
goldens from their canonical producers. Structural review finds five existing
schema byte counters plus the existing readiness schema and OpenAPI path; no
old discovery field or assertion is removed.

The first complete `311f38e9` ordinary unit run is red: six groups pass and two
fail, including 55 Worker failures and one contracts registry failure. Its
typecheck, contract and full-contract failures also remain retained. The
subsequent `bcc837ec` unit run finds a separate live child left by a custom test
supervisor. The journal excludes the intended final-census error branch, but
does not identify the exact earlier inspection failure. A deterministic
early-inspector-error regression reproduces the orphan. `6cda7a7c` adds a private
EOF guard only to the relevant stubborn supervisor fixtures; the deliberately
unguarded failed-leader-reap case retains its original behavior. Independent
review then catches a partial PID file becoming zero in fixture cleanup;
`f566a267` rejects unsafe process group IDs before signalling. A subsequent
`0f08cafd` callback-based test cleanup attempt fails before spawning: the local
serialized helper explicitly rejects lifecycle callbacks. Both primary and
independent controls record four passes and one failure; its attempted guard
plant never reaches the subject and earns no fault-detection credit.
`cb994ce3` instead validates a complete canonical PID line before fixture
cleanup. Eight real-file malformed-record cases plus all five affected cleanup
controls pass 13 tests and 53 expectations. Production process control,
deadlines, census budgets and cleanup assertions remain unchanged.

Fresh qualification runs serially from a clean preserved checkout at the exact
`cb994ce341158b2460a91e0db1235f3cca7c93db` revision, without competing typecheck
and lint jobs from the implementer. Root typecheck and lint each pass all eight
groups; root contract passes five required groups with its original two policy
skips. Full contracts pass 958 tests and render passes 592. The complete ordinary
unit dispatcher passes all eight groups in 1,514.25 seconds, with its owner
normally exiting zero: Worker 6,786 tests / 32,165 expectations and Agora 906
tests / 6,111 expectations. The toolchain retains its original 54 individual
skips; no whole group fails, blocks, goes missing or skips. Earlier superseded
unit controllers were
intentionally stopped only after exact ownership checks; their partial output
does not qualify this source. Independent review closes `92x.3` and the scoped
fixture bug `nx8s` against their original criteria at this exact revision.

Independent final feature controls pass 164 tests. Removing item focus gives
the original three false-404 failures; disabling the EOF guard fails the actual
empty-group assertion, with successful fixture cleanup. Both byte-exact restores
pass, including all 13 cleanup/parser cases. The final actual Workerd/D1/R2
journey passes publication/readback of 21 reviews and 21 evidence records,
ordinary stable prefixes and omissions, exact items, current visibility and
cache controls. Its post-redaction unreplayable count of one is not replay-parity
credit. The final production browser passes all 274 JavaScript and no-JavaScript
checks, with a normally exited zero-status owner in 195.889 seconds under its
unchanged 300-second limit. It uses the default pinned browser without an
executable or cache-path override. The original
default-browser prerequisite failure, `bcc837ec` browser timeout and all earlier
assertions remain separate records.
Pinned Playwright revision 1254 was downloaded with the project User-Agent,
CRC-validated and installed only in an absent cache directory. Its actual
Chrome 158 launch/close probe passes; that is a prerequisite result, not a
diagnosis of the older timeout. The independent verifier reads the complete
final primary gate terminals before accepting either scoped fix.

An independent `f566a267` broad fixture run records 252 passes and two S-2
startup failures. Source-closure/manifest repair assertions pass, but the
Wrangler refusal test has no expected typed code and an owner-loss child exits
125 without its expected record. Sequence-correlated retained logs show a
10-second bounded-capture deadline; they are not a named-subcommand receipt or
proof of why it timed out. Ambient mount warnings do not establish a cause.
`7afy` retains both observations and requires causal diagnosis before a fix
claim. Neither feature acceptance nor a later passing control closes that
investigation. All evidence is retained under
`e2e/artifacts/92x-3-20261107-coppertiger/` and
`e2e/artifacts/independent-20261107-92x-3-311f38e9/`.

Changed-code UBS scans complete with findings retained and reviewed, including
test-secret fixtures, public URL/status comparisons and the existing escaped
HTML/header producers. No analyzer rule, coverage requirement or limit is
relaxed. An initial staged ShellCheck timeout remains a partial result; the
subsequent unchanged scan completes. Final documentation/tracker-only diff and
staged invocations report no supported code inputs, exit 3; that is no scan,
not a security pass. The broader `g4b4` investigation remains open.

Final read-only production and staging `/capabilities` requests at 17:56 UTC
both return HTTP 200 and `0.1.0-draft`, byte-identical to the retained 08:55
bodies. This confirms the public response, not provider revision, migration
lineage or deployment history. No deployment or resource provisioning was
performed; `rs5n`, broader parents and external G0–G3 acceptance remain open.

### S-2 startup diagnostics at `84a112ae`

`84a112ae` repairs two diagnostic gaps exposed by the retained `f566a267`
failures: a failed source-walker command now emits its existing stage refusal,
and the owner-loss launch retains its wrapper's fixed, private stage metadata.
Unmeasured group/watchdog survival is `null`, rather than an unsupported
`false`. New diagnostic writers preserve the original failure exits even when
their output readers disappear. Ownership, source attestation, census limits,
deadlines and cleanup assertions are unchanged. This is diagnostic/enabler
work; it adds no scientific workflow capability and does not identify the
historical ten-second delay or raw-child125 trigger. `7afy` remains unfinished.

Primary focused controls pass 16 tests and 92 expectations. Independently,
five one-dimension mutations fail their intended assertions; the actual old
closure path with closed stdout passes its original exit1 control. Exact
restoration returns all 16 controls to green. The primary's 18:42 Beads note
incorrectly called the full-harness closed-stdout failure 141: its actual
record is 125; 141 belongs to a separate literal pipe control. The 18:50 correction
and all original raw failures remain retained. That difference does not
establish a historical cause.

All six prescribed commands pass at this exact revision, executed sequentially
from a clean preserved checkout: root typecheck/lint 8/8; contract 5 required
groups with its original two policy skips; full contracts 958/0/7174 expectations;
full render592/0/6047. The ordinary unit dispatcher passes all eight groups in
1,502.12 seconds, with a normally exited zero-status owner: Worker 6798/0/32232
and Agora 906/0/6111. No whole group fails, blocks, goes missing or skips; the
original 54 individual toolchain skips remain. The two changed inputs have
identical hashes before and after every command.

The full native Krater harness completes its local D1/DO checks, including
restart, mounted outbox, legacy upgrades, current journals, alarm and source
provenance, in 120.54 seconds. Its owner exits normally with 78: deployed DO and
edge-load evidence are absent. That is a blocked aggregate, not an S-2 pass.
The registered native lifecycle gate fails in224.414seconds:
`S2_PARALLEL_SECOND_NOT_READY`. Its retained second-child log identifies the
source-walker command's actual10-second deadline, capture124 and proven cleanup,
followed by the new named closure refusal. The first child finishes its local
checks with blocked78. This directly reproduces the source-walker deadline
class in real parallel startup; it still does not establish why the walker
took too long. SIGTERM was unexecuted and the queue stopped before cost ran.
Evidence is retained in `e2e/artifacts/7afy-20261107-coppertiger/` and
`e2e/artifacts/independent-20261107-7afy/`.
Fresh public reads at 22:57 UTC still return the byte-identical `0.1.0-draft`
production and staging capabilities bodies. No provider resources changed.

A bounded scheduler observation finds the current native owner's source walker
spending 1.55 seconds on CPU and 7.88 seconds waiting for CPU0. Allocating CPUs0–1
only to a verification process lets the original parallel assertions pass,
then exposes an actual SIGTERM cleanup failure. This does not establish the
historical `f566a267` delay or raw125 trigger; `7afy` remains open. The first
cleanup candidate `bfe43e9b` is independently rejected by the native gate.

Follow-through `b0d994f3` protects watchdog inspection from group TERM, records
startup ownership before gates, restores the EXIT parser's field separator,
and preserves the first signal across fork/enrollment. A normal supervisor
ignores TERM only after starting its payload, then waits once for the actual
child status. The rejected repeat-wait design produced 127 in a complete
preparation run; its earlier narrow passes did not establish correctness.
The new actual pre-arm regression also detects the old manifest sealing45-byte
startup evidence before its untracked writer grows it to68bytes. Pre-setsid
uncertainty remains a refusal, without a PID-only signal or unbounded wait.
All original identity, group census, ALRM and deadline checks remain intact.

Independent baseline and exact-restored controls each pass 13 tests / 237 assertions;
all seven isolated faults fail their intended checks. The missing-enrollment
flag fault proves structural wiring only; helper and subprocess controls do
not certify Workerd. Both default UBS scans complete the two changed inputs
with 0 critical / 14 reviewed warnings / 313 info and no failed module. The native gate
still fails at this revision in 163.77 seconds: parallel passes, then SIGTERM's
child 125 refuses cleanup/publication. Both agents stop acceptance. The missing
release-descriptor cleanup is now reproduced while the controller remains
alive: its exact FIFO is still open and PID-scoped lsof observes a state holder.
Closing only the descriptor with that exact FIFO identity passes, while an
unrelated caller descriptor stays open. No holder is exempted from inspection.
The descriptor repair is committed at `a6f4547a`. Independent baseline and exact
restoration each pass 15 tests / 243 assertions, and all nine isolated faults fail.
The original native gate now passes both modes, 1 test / 8 assertions in 164.31 seconds,
with a normally exited zero-status owner and stable source hashes. Only that
verification process receives CPUs0–1; original limits are unchanged.
Primary native reexecution also passes 1 test / 8 assertions in 158.51 seconds with a
normally exited zero-status owner and stable source. All six prescribed primary
commands pass: typecheck/lint 8/8, contract 5 required groups with its original two
policy skips, full contracts 958/0/7174 and full render 592/0/6047. The ordinary
unit dispatcher passes all eight groups in 1,404.38 seconds, owner 0 / stable source:
Worker 6806/0/32281, Agora 906/0/6111, toolchain 422 passes and its original 54 individual
skips. The original unfiltered Worker invocation includes the entire S-2 unit
file; dot-reporter fragments are not used as a per-file test count. Independent
reexecution of all six originals also passes, each with a normally exited
zero-status owner and stable source. Its ordinary unit dispatcher passes all
eight groups in 1,401.90 seconds with the same Worker/Agora totals and original
individual skips. Independent review closes only `nliv` against its original
criteria, with the complete source/test/gate acceptance map recorded in Beads.
`7afy` and the broader S-2/deployment/launch owners remain open.
The default cost command separately blocks 78, `S2_COST_MEASUREMENT_UNAVAILABLE`.
Supplying the actual native parallel child's four-file receipt chain yields
S-2 `accepted-local` for 232 selected settled-write receipts, while the aggregate
still blocks 78, `COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE`. Incomplete row
totals, provider traffic/CPU/cache/R2/pricing and deployed performance remain
unknown; local subtotals are not an affordability or G0 verdict.
The descriptor increment's diff UBS completes both inputs with
0 critical / 14 reviewed warnings / 327 info. Its original
single-CPU staged scan hits the installed scheduler's `FREE_SLOTS` crash before
producing a report; unchanged staged arguments with only the scanner process
on CPUs0–1 complete both original modules with the same totals. No analyzer
rule, input, limit or suppression changes. `g4b4` retains the broader scanner
gap. This is enabler work, with no new scientific capability or deployed/G0/launch claim.

### Initial assessment and evidence boundaries

This assessment is `asimposiumorg-sewo`, at `main`
`184662b432ac5301f50b870414ab612538297e98`. Its application source is the
`719cf5cb` publication/inbox candidate; the intervening commit changes
documentation and tracker records. There are 130 SQL migrations, ending at
`0130_session_opened_public_cursor.sql`. The complete root AGENTS.md, README.md
and governing Fable Revision 3.1 plan were read. Package documentation, selected
runbooks, implementation and tests were examined. The competing plans remain
historical designs, interpreted through Fable's adoption/rejection ledger;
this is not a new full audit of those sketches or every source line.

While the long gates run, concurrent commit `15e642d4` records this assessment
and its tracker/pointer edits. Its diff from the starting revision contains
only the three documentation files and three Beads publication files; all
application, test, contract, migration, infrastructure and gate-script bytes
remain identical. The run spans those documentation revisions and is not an
isolated all-blobs qualification of a newly committed candidate.

The root unit run overlaps the initial static/contract checks and later native
and browser lanes on this host. Results below are functional/source evidence,
not an isolated load experiment or an attribution of any historical timing
failure to host contention.

Fresh records are under `e2e/artifacts/reality-check-20261107-coppertiger/`.
That is retained local evidence, not a hosted acceptance receipt. Source and
dependency versions, command logs, public response bodies/headers, a tracker
snapshot and a bounded AST scan support the conclusions. Application source,
gate assertions and thresholds are unchanged. Public requests use the project's
honest User-Agent. No authenticated remote writes or deployments are performed.

### What the evidence establishes

The production-browser command passes **219 checks** against a production Next
build and real local Workerd/D1/R2. It exercises real pages, no-JavaScript reads,
GFM/math and injection controls, private workshop versus public faces, signed
sponsor actions, directive delivery/acknowledgment, the private sponsor inbox,
and share images. The sponsor cookie is locally minted using Auth.js and the
screening provider is a fixture. This proves neither Google OAuth nor hosted
screening or staging behavior.

The local reference-agent runner passes two scripted completion paths and
correctly rejects four incomplete controls. These are **zero fresh model
trials**, not six participants in G-C. The dedicated contextual-screening,
moderation and independent-appeal lanes also pass against real local bindings.
They show that policy decisions affect persisted/public state as intended;
they do not measure a real classifier's accuracy.
Likewise, controlled scientific journeys test publication, review and standing
mechanics; they do not certify the truth of new research.

Some remaining gaps require implementation, not just credentials or another
verification run:

- The provisioned staging gauntlet deliberately stops before executing its
  product journey; the gallery smoke also ends at its unimplemented flow.
- `web/lib/plane-status.ts` still returns hardcoded research-write/product
  readiness values rather than consuming the planned revision-bound evidence.
  The Worker statistics face explicitly reports `not_produced`.
- The nightly scheduler archives public problem ledgers privately; it does not
  implement full SQL/global/account/private-state backup and recovery.
- Warning publication covers an explicit producer allowlist; the remaining
  kinds retain their review hold until their reading faces support notices.
- Optional `asimp` still lacks login/connect/keychain, offline validate/scrub,
  durable spool/watch/pull/doctor and signed release packaging.

Several October absence claims are now obsolete. The shared renderer really
parses GFM/math and invokes bounded KaTeX with `trust: false`; real problem and
claim pages consume it. The Worker entrypoint mounts a provider-backed cursor
cache. Supported claim/proposal/revision/review warnings can publish with notice
provenance; other kinds remain held. Novelty history, immutable opening cursors,
statement-context transaction checks and a private sponsor inbox are present.
Earlier whole-subsystem “not implemented” statements below are dated history.

The browser command first exits 78 before building because its default Chromium
cache is absent. Selecting a retained older 1193 cache also blocks: Playwright
1.65.0 expects Chromium 1254. The unchanged command then passes using the
matching retained cache through `PLAYWRIGHT_BROWSERS_PATH`. Both prerequisite
failures remain recorded. No browser action, assertion or deadline was changed.

### Fresh verification and its limits

All commands below run on the application source identified above. Independent
historical receipts in the following sections retain their exact scope; they
are not substituted for these executions.

| Command / observation | Fresh result | Meaning and boundary |
| --- | --- | --- |
| `bun run typecheck` | PASS: all eight groups, 311.50 s. | Installed Bun 1.4.4 / TypeScript 5.9.3; no missing group. |
| `bun run lint` | FAIL: seven groups pass, one fails, 144.49 s. | Toolchain Biome reports one formatting error in `scripts/planted-defects.mjs`, plus warnings. |
| `bun run test:contract` | FAIL: four executed groups pass, Worker fails, 59.00 s; two policy skips. | `test/contract/capabilities-census.test.ts:478` finds exactly `POST /v1/sponsors/inbox` unclassified. |
| `bun run test` | PASS: all eight groups, 1,985.08 s; Wire 6,751 tests / 31,724 expectations, Agora 900 tests. | No failed, blocked, missing or skipped group; the toolchain retains 54 individual skips. |
| `bun run --filter @asimposium/contracts test` | PASS: 953 tests, 7,070 expectations. | Complete contracts package; the separate Worker disclosure-census failure remains. |
| `bun run --filter @asimposium/contracts check:drift` | PASS. | Generated canonical schema bytes agree; does not cure the separate served-capabilities census. |
| `bun run --filter @asimposium/render test` | PASS: 586 tests, 5,955 expectations. | Shared rendering/face tests; not complete hosted face coverage. |
| `bun run --filter @asimposium/wire test:integration:discovery` | PASS: original unfiltered 34-mode file, normal exit 0. | Real local Workerd/D1/R2; identity and model decisions are fixtures. Per-lane trigger exclusions remain. |
| `node e2e/playwright/agora-local-lane.mjs --build` with matching retained browser cache | PASS: 219 checks; production server mode. | Locally minted Auth.js sponsor session, real browser and bindings; no Google/staging/provider claim. |
| `bash e2e/gauntlet/run.sh --target local` | PASS: two scripted completions, four correctly rejected controls. | State-derived reference rehearsal; not G-C or S-1. |
| `moderation-real-bindings.mjs`, `publication-context-real-bindings.mjs`, `screening-appeals-real-bindings.mjs` under `apps/wire/test/integration/` | PASS, each original whole command. | Durable moderation, context fences and independent decision/replay/privacy checks; classifier fixtures. |
| `node apps/wire/test/integration/sponsor-inbox-real-bindings.mjs` | PASS. | Signed private reads, authorization/pagination, acknowledgment/filtering and sponsorship transfer on local bindings. |
| `bun run --filter @asimposium/wire test:security` | PASS: 33 tests, 288 expectations. | Selected security suite; not the broad scanner, hosted red team or a clean-security claim. |
| `bun infra/validate-environments.mjs` | PASS. | Current local topology/configuration, not actual provisioned binding identities. |
| `bun run smoke:self-test` | PASS, both self-tests. | Harness behavior only. |
| `bun run verify:cost` | BLOCKED: exit 78, `S2_COST_MEASUREMENT_UNAVAILABLE`. | No accepted external S-2 measurement. Existing arithmetic also discloses unresolved scenario/duty-cycle assumptions. |
| Staging gallery smoke with the explicit configured Agora origin | FAIL: exit 70, `GALLERY_PRODUCT_FLOW_NOT_IMPLEMENTED`, after public preflight. | No authenticated Google/workshop/public browser journey executes. |
| Staging gauntlet with the explicit configured Stoa origin | BLOCKED: exit 78, `GAUNTLET_JOIN_URLS_UNPROVISIONED`. | Separate from the provisioned-input implementation stop; neither is a model trial. |
| Required remote-only Rust `cargo test` invocation documented in `cli/README.md` | UNAVAILABLE: exit 103, nine disk-headroom denials, no admissible worker. | Transfer/compilation/tests do not execute. No local fallback or worker reconfiguration. |

The root unit result retains its existing inner warnings and external-prerequisite
refusal output. In particular, lsof reports incomplete namespace visibility and
the S-3 paired-staging probe reports unavailable identity/browser inputs. Those
are not a completed hosted journey or proof that every descendant was observed;
the outer unit result does not turn them into acceptance.

The two fresh failures belong to the current candidate qualification (`bwal`).
Production discovery already classifies the private signed sponsor inbox read;
the separate served-capabilities census lacks that classification. Preserve the
fail-on-new-route guard and the private sponsor disclosure policy. A failed
inventory check alone establishes neither an auth bypass nor a reason to
advertise sponsor internals. Formatting repair must preserve the actual fault
plants and their detectors. No code repair is made by this assessment.

A separate, newly reproduced diagnostic defect is `9o8v`. The real gallery
failure recommends `scripts/smoke-gallery.sh --self-test`, which passes without
exercising the failed journey. A no-network agent run with its staging origin
absent exits 78 but also recommends a passing self-test. Both scripts initialize
the reproduction field to self-test for every mode (`smoke-agent.sh:48`,
`smoke-gallery.sh:13`). Preserve the honest failure while fixing the wrong-mode
instruction and testing its consumer. `9lqv` depends on this bounded repair;
neither the bug nor its fix establishes a product auth/privacy failure or
completes the absent gallery journey.

The complete integration aggregate, hosted Google browser journey, provider
logs, live screening corpus, performance/load and full restore drills are not
qualified by the selected passing lanes above. The original candidate's
independent closure remains pending. This audit closes no product gate.

### What is actually shipped

Fresh public GETs around 05:16 UTC on November 7 establish:

| Surface | Observed result |
| --- | --- |
| Production Worker `/capabilities` | 200, `0.1.0-draft`, SHA-256 `1844555d6ed921c22d6463c2b8347189b3bf0e4ca94fd83b2cf6a1e42e84bbc0`. |
| Staging Worker `/capabilities` | 200, `0.1.0-draft`, SHA-256 `8e79852b080e15908ffa1fd88edecd4378bbf189ea6c9b96df7cccbbeadfaa70`. |
| Both Workers: `/protocol.json`, `/openapi.json`, `/search?q=parity`, `/p/P-4DSP.md` | 404 `ROUTE_NOT_FOUND`, despite those source implementations. |
| Production index / global cursor | Empty public index / `0`. Staging retains its old index / cursor `3`. |
| Apex home, problem, Now and results | 200 HTML with unavailable-ledger states. HTTP success is not a working scientific page. |
| Named `719cf5cb` Vercel Preview | Home and anonymous inbox entry respond; its ledger is still backed by the older Worker. All three public static protocol copies match source bytes exactly. |

The capability hashes equal the retained September receipts. Equality does
not identify the provider revision or prove that no intervening deployment
occurred. Source advertises `0.2.0-draft`; that capability version and the
versioned protocol text are separate identities. The Preview observations do
not establish authenticated inbox behavior, new provider-log coverage or a
production promotion.

All four required Cloudflare/staging authority/configuration variables are
absent in a Node environment presence check. This is not a credential-store
audit. `rs5n` still owns the operator action: reconcile existing resources,
migration lineage, binding roles and a green source revision in the sanctioned
Worker-before-Agora pipeline. Do not silently provision a second environment.

### Vision checklist, implementation and remaining acceptance

Suffixes below use the `asimposiumorg-` prefix. `PARTIAL` includes useful local
passes with broader missing scope; `UNPROVEN` means the promised external
outcome is not established. Each row names its decision-relevant remainder,
not a claim that its whole subsystem is absent.

| # | Testable Fable promise | Current code and bounded evidence | Remaining outcome / existing owner |
| --- | --- | --- | --- |
| 1 | One Worker writer; canonical strict contracts (§3/§14.1) | Signed sponsor envelope and bearer ingress use Worker validators; Zod generation exists. Typecheck and repaired disclosure census pass. | PARTIAL: complete every-kind/error and CLI agreement remain W1, `uir`, `psl`. |
| 2 | Fresh fragment enrollment followed by explicit approval (§5, S-1) | Real local join/proposal/approval/token/session flow and rejection controls pass. | UNPROVEN for three unaided named harnesses on the actual environment; `mn7`, `pcsn`, `nvo`, `krn`. |
| 3 | Google human identity and principal separation (§5, S-6) | Auth.js and signed envelope paths exist; current browser uses a real locally minted cookie. S-6 retains its historical bounded closure. | PARTIAL: real Google exchange, verification, step-up and current hosted/browser acceptance; `4y3`, `ggv`, `qnh`, `3zn`. |
| 4 | Work survives close, interruption and resume (§5.5/§7) | Persisted session metadata, immutable opening cursor, private draft revisions/full reads, heartbeat and idle recovery exist. | PARTIAL: original full lifecycle/race/recovery and deployed proof; W3/W4, `9p4`, `mtx`, `ana`. |
| 5 | Workshop remains private until explicit attributed promotion (A2/A3, S-3) | The shared Gallery journey is implemented. Primary and independent production browsers pass 439 checks at `f0957beb`; a sole wrong-sponsor producer fault triggers the unchanged leak assertion and exact restoration passes. The fresh scripted local session/workshop/promotion/handback flow also passes. | PARTIAL: actual Google/staging paired-principal journey and original deployed split criteria remain `ict`, `e7j`, `3zn`, `7ft`. Preserve independently closed local `7ft.3`. |
| 6 | Typed, version-pinned scientific collaboration (§6, P1–P13) | Claims, evidence, hypotheses, gaps, relations, conflicts, citations, novelty review, concessions and withdrawals have real production paths. | PARTIAL: complete original W5 acceptance and epistemic corpus, including negative science, not just route availability; `3b9`, `wnd`, `phs`. |
| 7 | Scientific standing is earned; independence is pinned (§6.4–6.6) | Scientific history fold, adverse immutable metadata and sponsor/family/method provenance are implemented. Honors now links the assessed exact claim version and ledger cut; the native journey preserves later-event stability and current content hiding. | PARTIAL: every transition, replay and adversarial condition plus real multi-sponsor use; `3b9`, `wnd`, `8ku`. Preserve independently closed repairs. |
| 8 | Premises and weakest-link assessments remain honest (§6.5, P9/P10) | Immutable dependency pins, transitive closure, current/frozen cuts and conservative unavailable states exist. | PARTIAL: full scientific/epistemic acceptance, withdrawal propagation and live reconstruction; W5, `wnd`, `8ku`. |
| 9 | Exact formulations, governance and honest resolution (§6.2/6.8) | Publication, statement review/context, admission, lifecycle and ordinary anchored resolution exist. Unsupported expert authority is refused. | PARTIAL: full guardrail, accepted external-expert authority and seeded staged outcomes; W5, `a5j`, `4kz`, W12. |
| 10 | Negative knowledge and proof friction save later work (§6.1/6.7) | Dead-end retry triggers, bounded neutral Fellow history with publication attribution, hypothesis lifecycle, friction witnesses and private impact-echo producers exist. | PARTIAL: actual cross-sponsor reuse and resulting scientific response on the dogfood board; `8ku`, `1e7`, `z8y`. Broad calibration/honors `dn6` remains open. |
| 11 | Synthesis follows a frozen ledger cut (P13) | `ledger/synthesis-read.ts` reads anchored event content with captured cursor and current visibility controls. | PARTIAL: full selection/minority disclosure, approval, closing-boundary and dogfood outcomes; W5, `wnd`, `8ku`. |
| 12 | All twelve packs provide bounded, useful context (§7.3) | Profile composers, exact-version review/dependency reads, budget omissions, full pagination and move adapters exist. | PARTIAL: complete populated-profile/isolation/determinism acceptance and real harness usefulness within token budget; W4/W6, `zai`. |
| 13 | Every public resource has truthful canonical faces (A1/§7.9) | Shared rendering, generic/specialized human routes, feeds, TOON, exports and revalidation exist. Exact encoded citation selectors reach their original Agora source; Honors uses the same version/cut links in Markdown, HTML and Agora. | PARTIAL: complete registry/corpus and deployed parity; `92x`, `0et`, `uir`, `9lqv`. |
| 14 | Moves direct effort at scientific needs (§9.4/9.6) | Canonical live selection, materiality, retries, gaps, formalization, working-pack consumers and dynamic global public moves exist. Area need chips now consume a bounded canonical review sample. | PARTIAL: original replay/consumer/fault controls and complete discovery acceptance; `z8y`, `codz`, `mip`, `fr9`. |
| 15 | Slots, leases, review requests and private inbox coordinate work (§7/§9.3) | Mounted stores/routers, sponsor inbox and browser delivery/acknowledgment/foreign-principal checks exist. | PARTIAL: full notice taxonomy, outbox/DO replay, fairness/races and operational delivery; `1ar`, `mip`, `1e7`, W7. |
| 16 | Contextual screening and independent human decisions precede release (§9.1) | Fresh real-binding moderation/context/appeal lanes pass; source binds decisions to candidate/context. | PARTIAL: all ingress fields/sinks, production provider and complete independent operator acceptance; `b9y9`, `axq`, `drv`, `cm5`, `bum`. |
| 17 | Warnings and off-scope decisions preserve legitimate science (§9.1) | Supported publication kinds carry warnings; unsupported kinds remain held by `supportsPublishedWarning`. | PARTIAL: full kind/face/export parity and original policy lattice; `axq`, `drv`. Do not turn unsupported warning holds into silent allows. |
| 18 | Safety accuracy and injection resistance are measured (S-4/§16.4) | Structural defenses, inoculation and 150 legitimate source cases exist. Fifty protected hard-reject reservations explicitly contain no test bodies. | UNPROVEN: hosted FP <5%, hard-reject FN=0, aggregation and bare/inoculated probe trials; `xeg`, `drv`, `ip3`, `qnh`. |
| 19 | Artifacts remain private until verified public admission (§10.4) | Upload/inspection/publication/retry/retention source is mounted. Local bindings do not certify provider semantics. | PARTIAL: real presigned R2 PUT/range/lifecycle, immutable public-domain canary and all original conditions; `rhg`, `kl8`, `y2t7`, `z2j`. |
| 20 | Recovery preserves the log, privacy and revoked rights (§10.2/10.5) | Projection replay, signed checkpoints/exports, segmented public-ledger backups, deletion journal and scratch restore fences exist. `krater/backup-scheduler.ts:7` explicitly limits its scope; `restore.ts:2` reconstructs one problem. | PARTIAL IMPLEMENTATION: full SQL/global/private/account backup/recovery remains required, along with original provider scratch, corruption and revoked-rights drills; `p4b`, `zr9`, `79n`, `24q`. Public-ledger archives are not whole-system backups. |
| 21 | Liveness is real and viral polling stays cheap (§11/§15) | Herald rooms/outbox and bounded cursor cache are mounted; topology validates. Matching cached ETags deliberately revalidate D1. | UNPROVEN at provider scale: actual poll mix, multi-isolate purge/freshness, row reads and p95; `c52`, `mfw`, `kzq`, `doa`, `0fs`. |
| 22 | Sponsor/Fellow limits bound overload and screening spend (§7.10/§15) | Durable promotion, workshop-write and Fellow-read admission, visible budgets, artifact limits and slow-mode code exist. `sessions/router.ts:95` and `router-core.ts:5055` consume read/workshop admission. Missing sponsor-window configuration remains unconstrained. | PARTIAL: accepted sponsor policy, complete limiter classes, fail-closed deployed settings and retained cost measurements; `irg`, `doa`, `0fs`. |
| 23 | Human pages render science safely, accessibly and without JS (§8) | Primary and independent production-browser lanes pass all 439 checks at `f0957beb`, retaining original no-JS, accessibility, private/public and share-image assertions. Real local bindings coexist with fixture sponsor identity and screening. | PARTIAL: complete W8 accessibility/design/route scope, runtime reliability and hosted Google/cache behavior; `mbp`, `fjp`, `n9n`, `3zn`, `vv5`, `pjuf`. Retained timeouts are not diagnosed by a later pass. |
| 24 | One qualified revision reaches both deployed planes (§13) | Source has migration/deploy tooling and a real readiness evidence consumer: `readiness.ts:26` validates canonical digest/environment/revision/expiry-bound receipts, `app.ts:1340` serves the result and Agora `plane-status.ts:508` consumes it. Fresh public reads still lack several implemented routes. | UNPROVEN externally: complete original pipeline, binding/migration lineage, Worker-before-web rollout and actual revision-bound receipts; `rs5n`, `8n5`, `p1g`, `sox`, `tgu`. Implementing the consumer did not supply its missing hosted evidence. |
| 25 | Optional CLI remains curl-complete and safe (§12) | Public/authenticated reads and scientific writes exist, alongside fragment connect, device login, approval resume and origin-bound OS keychain code (`cli/src/lib.rs:44,46`). At `73f4936d`, original format/check/locked-test/Clippy and separate real native workshop/next/search gates pass in primary and independent executions; scope and warm-artifact attribution are recorded above. | PARTIAL: browser PKCE, complete validate/scrub corpus parity, spool/sync/watch/pull/doctor, negotiation and signed release; `il7`, `l3b`, `psl`, `jsj`, `85s`. The `l1yg.1` qualification does not establish these wider criteria or deployed behavior. |
| 26 | G0–G3 follow real collaboration and sustained operation (§16/§17) | Local journeys, seed dossiers and regression controls exist. Fresh local Gauntlet passes three completing and seven incomplete scripted controls; it measures site bytes separately from whole-session harness usage. | PARTIAL IMPLEMENTATION and UNPROVEN externally: provisioned G-C runner still refuses at `e2e/gauntlet/run.sh:139`; authoritative first-promotion tokens and move-following/error-recovery evidence remain `zai`/`pcsn`. Multi-sponsor dogfood, seeds, legal/IP/naming/OAuth, red team, load/restore and +30-day receipts remain W10/W12/OPS. |

No wholly untracked product subsystem was found. The new bounded diagnostic
defect is now tracked by `9o8v`. Completing the **original
acceptance** of the unfinished roadmap would cover the documented launch
scope in principle. Merely completing current implementations or closing issue
statuses would not: empirical external trials, operator decisions, deployed
proof and still-unknown defects cannot be inferred from source or issue counts.
Tier 2 and expressly refused features are not extra launch requirements.

### The bridge, in order of usable outcomes

1. **Preserve the tested source candidate.** The current runtime is `f0957beb`:
   original root eight groups, full contracts/render and 439 primary/independent
   browser checks pass at their recorded revisions. Fresh typecheck/lint and
   the scripted reference flow pass at identical runtime bytes. Preserve
   the actual wrong-sponsor fault and exact restored browser controls.
   Earlier `bwal`, `9o8v` and the area-need
   wiring `80s3` are independently accepted at `ad6d3c7c`. Keep its exact
   receipts, fault controls and original failures; rerun the relevant original
   gates after further changes. The neutral Fellow history `dn6.2` is now
   independently accepted at `316bf7b1`, including its corrected narrow-screen
   rendering and complete primary unit gate.
   Exact review/evidence readers and Fellow links are independently accepted
   at `cb994ce3`; S-2 cleanup is accepted at `a6f4547a` after both agents execute
   all six original commands and the original local parallel/SIGTERM gate.
   The unresolved runtime investigations `pjuf` and `sbuk` stay open; these local passes do not qualify
   deployment or launch.
2. **Prepare two parallel critical-path outcomes.** Implement the existing
   `zai` provisioned product journey and first-promotion usage boundary using
   the real harness adapters and server observations. Preserve its explicit
   block until the original acceptance can be measured; transcript stage
   scans, whole-session totals, served-byte estimates and blind unchanged
   retries cannot establish the missing criteria. Avoid a new mandatory
   read-back write or hidden-reasoning collection. In parallel, the operator clears `rs5n`;
   OPS confirms D1 lineage, actual R2/DO/AI/key roles and Worker-before-Agora
   ordering. Bind receipts to the same application candidate. Do not infer
   readiness from the named Preview or healthy canaries (`tgu`). The receipt
   consumer already exists. Supply real evidence instead of rewriting it or
   flipping a ready flag. The sanctioned order remains root → agent smoke →
   Gallery smoke → Worker deployment/readiness → Agora.
3. **Retire G0's real unknowns.** Run the actual fragment capsule with the three
   fresh harnesses, real Google sponsor/anonymous browsers, protected/live S-4
   corpus, complete gallery/agent smokes and external S-2/cache/FTS/alarm/cost
   measurement. Preserve historical S-5/S-6 closures; do not polish their
   apparatus instead of delivering these outcomes.
4. **Demonstrate science compounding across sponsors.** Work `8ku` through
   author → private draft → public version/dead end → close → another sponsor's
   fresh review/refutation/reuse → revision → anchored synthesis. A fresh human
   and agent must reconstruct exact versions, evidence, independence and what
   remains unknown without seeing the author's workshop. Include deliberately
   false science and a private-content canary that must fail.
5. **Finish the remaining original breadth and operation.** W1–W9 keep their
   every-kind/error/face, notice/outbox, warning, materiality, roster, recovery
   and human experience criteria. Finish wider admin/hosted acceptance (`0ht`)
   around the implemented local area rename, full SQL/global/private recovery
   (`p4b`/`zr9`) and original optional CLI breadth
   without misclassifying its existing connect/device/keychain implementation.
   `9lqv` maps outdated acceptance command names to existing real runners;
   a missing script name alone does not establish an absent subsystem.
   Reuse real runners and retain their negative controls; add no empty wrappers.
6. **Earn hardening and launch.** Execute the completed provisioned staging
   Gauntlet with actual candidate-bound evidence. Meet the unchanged ten fresh
   sessions / ≥3 harnesses / ≥8 completions / median ≤25K-token gate. Complete
   epistemic/red-team/injection A/B, load/degradation, restoration, seeds,
   legal/IP/naming/OAuth and independent G1/G2. Observe actual G3 outcomes
   after launch; neither a script nor an assessment can advance thirty days.

Performance remains a measured gate: Fable's proposed p95 ceilings are 50 ms
for edge cursor, 300 ms cached face, 800 ms uncached digest, 600 ms pack, 500 ms
delta and 900 ms write acceptance. The cache's warm unconditional-hit unit
success does not establish those numbers for conditional lurker polling.
The current cost verifier correctly withholds a cost claim without retained
external S-2 input and accepted workload assumptions. No present-day provider
pricing validation or real bill measurement is claimed here.

### Backlog, ambition and refinement

The November 11 refresh keeps the existing 614-issue roadmap. Its coverage
search finds no concrete wholly untracked launch promise. Existing owners
receive source-specific handoffs rather than duplicate implementation/test
epics. Original criteria, priorities, dependencies and product-gate statuses
are preserved. The two ambition passes and five refinement passes change this
bridge as follows:

| Pass | Current decision and effect |
| --- | --- |
| Ambition 1 | Make compounding scientific work the demonstration: a second sponsor must reuse/refute an exact publication after an interruption, and a fresh reader must reconstruct the result and no-claim boundary. Keep false-science and workshop-canary controls in `8ku`. |
| Ambition 2 | Separate deployment from product completion. Prepare the unfinished provisioned G-C path and measurement boundary while the operator reconciles existing staging resources. Reuse implemented readiness and enrollment consumers. |
| Refinement 1 | Cross-check all 26 vision outcomes against the whole Beads record, including closed bodies/comments. Retain original every-kind, scientific, legal, safety, recovery and thirty-day requirements; exclude rejected stacks and expressly deferred tier two. |
| Refinement 2 | Correct concrete stale absences: readiness consumes receipts; CLI connect/device/keychain and Fellow-read/workshop quotas exist. Preserve exact-source evidence instead of rebuilding them. |
| Refinement 3 | Pair each handoff with its original observable positive and meaningful negative. G-C must measure the actual product and first-promotion token boundary; a pack GET, whole-session total or transcript classification cannot stand in for it. |
| Refinement 4 | Keep dependency roles and proof classes explicit: original root gate → agent smoke → Gallery smoke → Worker → Agora. Hosted identity/safety/cost/storage, full SQL/private recovery and remote Rust remain their own requirements. `br` and BV find no cycles. |
| Refinement 5 | Reconcile every result with source/revision and denominator: fresh 3-positive/7-incomplete scripted oracle controls, retained 439-browser/full-root results, absent protected hard-reject bodies, cost78 and Gallery78. No product gate or implementation issue is closed by this assessment. |
| Final recheck | Independent coverage review finds the same implementation/proof split. The report and README are original status writing; no private-skill prompts, alternative architecture, application changes, new acceptance bypass or provider operation is introduced. |

This audit's keyword, structural and behavioral inspection found the explicit
area-rename and provisioned-G-C refusal paths described above. The later area
implementation is qualified separately in the follow-through above;
provisioned G-C remains unfinished. Rust AST searches
for `todo!` and `unimplemented!` return empty arrays (ordinary no-match exit 1).
This does not implement absent CLI commands or prove the rest of the code
correct. The earlier broad TypeScript census and all older counts below are
retained historical observations, not fresh scans.

**Earlier November 7 audit history follows.** Its source, counts, failures and
pending outcomes apply to the named revisions, with current corrections above.

The session starts with 573 issues: 434 closed and 139 unfinished. Creating
the assessment task yields 574: 434 closed, 105 open, 23 in progress and
12 explicitly blocked. Dependency-blocked counts overlap status. `br ready`
returns six open tasks; `bv` counts 26 actionable by also including active
work. Neither is a completion percentage. The graph has 574 nodes, 573 edges
and no cycles.

The later diagnostic finding adds `9o8v` and one dependency from its acceptance
consumer `9lqv`: 575 issues, 434 closed, 106 open, 23 in progress and 12 explicitly
blocked; seven open-ready tasks. The 575-node, 574-edge graph has no cycles.

Existing owners receive appended, source-specific evidence rather than new
duplicate feature epics. The current qualification, deployment, executable
acceptance, cursor, gauntlet, math, dogfood, readiness, warning, backup and
storage tasks retain their original scope and acceptance. No implementation
bead or old spike is self-closed.

The skill's two ambition rounds, five refinement passes and final recheck make these concrete
changes to the existing bridge:

| Pass | Decision / effect |
| --- | --- |
| Ambition 1 | Make interrupted, multi-sponsor scientific reuse and fresh-reader reconstruction the outcome in `8ku`, including false-science/privacy negatives; endpoint counts are insufficient. |
| Ambition 2 | Tie that outcome to one qualified deployed candidate, real safety/cost evidence and the existing readiness consumer; avoid a new dashboard or an alternate stack. |
| Refinement 1 | Keep current syntax/contract failures separate from historical unit passes; preserve the exact private-route census and fault-plant detectors in `bwal`. |
| Refinement 2 | Replace obsolete math/cache/warning absence claims with current bounded implementation evidence; preserve the remaining original acceptance. |
| Refinement 3 | Record exact browser-cache and remote Rust prerequisites, map the 57 missing command references, and distinguish blocked execution from a failed assertion. |
| Refinement 4 | Keep conditional-cache D1 costs, unsupported warning holds, absent protected corpus bodies, full recovery and real harness token counts explicit; no fixture-derived launch claims. |
| Refinement 5 | Recheck goal-to-owner coverage and actual reproduction behavior. The late smoke probe finds the bounded wrong-mode diagnostic defect; create `9o8v` with a behavioral negative control and make the existing proof consumer depend on it. |
| Final recheck | Preserve original features/tests, verify dependency direction and source equivalence, retain every failing/blocked result, and reconcile final gate outcomes before handoff. |

The AST census examines 587 production TypeScript/TSX files and 4,300 function
bodies. It finds no single-throw “not implemented” stub; the 27 empty-body hits
are fallback handlers/default hooks or constructors, not evidence of 27 absent
features. Keyword and behavioral inspection still find explicit unfinished
surfaces such as staging G-C, gallery smoke, readiness and statistics. A narrow
AST result is not proof that every implementation is complete or correct.

Application source is unchanged; only this assessment, its entry pointers and
tracker records are revised. The final postcheck matches all 2,485 tracked files
outside the six expected documentation/Beads paths and all seventeen selected
installed dependency manifests. All 573 original issues preserve their scope,
acceptance, priority and status. The final graph is acyclic; the sanctioned
Beads flush and its self-test pass, and the staged public projection contains
575 issues with zero top-level `source_repo_path` fields. Only that projection
and the two certificate files are staged by the helper.

`git diff --check` passes. `ubs --diff` exits 3 because only Markdown/tracker
changes are in scope: no supported language scanner runs, which is explicitly
not a clean code-security scan. Primary storage later shows 11 GiB available;
the cause and durability of that increase are unverified. Existing untracked
Beads index directories and retained failed receipts are preserved. No
application code, test threshold, deployment or provider configuration changes
are made. The assessment remains available for independent review (`sewo`);
no implementation issue or product gate is self-closed.

## Prior qualification record — 2026-11-06

### Current publication and inbox candidate — 2026-11-06

The qualification target is `719cf5cb5d81bde4de7a1776cf3fc559b25b3be3`.
Concurrent upstream commits add novelty history, atomic statement-context
checks, immutable session opening cursors and a private sponsor inbox after
the earlier `b31d54e8` verification. The earlier results remain bound to that
revision; a primary-HEAD check correctly rejects their transfer to newer code.

Current integration repair `bwal` pins the two new Worker imports and migration
0130 in S2's existing source inventory, appends the migration to its ordered
journal, and adds its reviewed trigger SQL hash to the definition census.
The original closure, journal and trigger-census checks fail before repair.
Fourteen focused closure/journal/provenance/omission controls then pass in
31.657 seconds. The four-test trigger census and specific legacy cursor-rewrite
test pass in 3.261 seconds. The hash is definition accounting, not a new generic
native trigger probe; no old pin, classifier, assertion or deadline changes.

The existing production-browser lane now follows its actual UI-issued directive
into the sponsor inbox. Ten new checks cover owner HTML, private cache headers,
no implicit acknowledgment, actual Fellow acknowledgment, the unacknowledged
filter, and anonymous/foreign-sponsor isolation. All original 209 checks remain;
the primary whole lane passes 219/219 in 134.074 seconds. Workerd, D1, R2 and
Chromium are real, while the sponsor cookie is locally minted with Auth.js;
this is not Google OAuth or hosted proof. Parent `1e7` retains its full unmet
taxonomy, outbox/DO and operational acceptance.

Independent read review also suggested a trailing-newline link defect. Actual
before-edit Bun and Node controls disprove it: the existing no-multiline regexes
reject all four line terminators. The production parser remains unchanged;
the temporary passing controls and correction are retained in comment 2865.
This is not a source fix or vulnerability finding.

Stock UBS diff/staged finish in 63.351/59.284 seconds, both with finding exit 1:
three supported code files, 530 matching locations, two critical matches on
browser test pathname/status comparisons, 26 reviewed warnings and 502 info.
All modules finish, with no suppressions. The JSON census is reviewed separately.
This scoped review supplies no missing broad `g4b4` coverage or clean-security claim.

A fresh standalone main checkout verifies all 2,491 tracked blobs/modes and
nineteen selected dependency identities with no shared primary source inodes.
The first original unfiltered root run at `26e49526` starts at 22:55:57 UTC and exposes four toolchain
failures: two stale mutation snippets in one registry test, plus three orchestration
controls stopped by the token harness's missing migration pin. The primary
15-case control reproduces all four failures, then passes after the targeted
token-list and mutation-producer corrections. Registry applicability is not
runtime fault detection: both changed native mutants still require passing
controls, intended failures and restored positives. The original full root owner
finishes normally with six passing groups and two failing groups in 1,340.736
seconds. Wire reports 6,726 passes and 25 failures: 23 token-harness source-pin
refusals, the migration README head and the schema-index golden. Its raw failure
and exact source/dependency/process audits remain retained; downstream gates
are not run on that revision.

Corrected commits `b7faefff` and `719cf5cb` retain the original native fault
detectors and update their actual producers. Novelty's same-sponsor plant must
defeat both the source selection and the independent T0 exclusion; the stale
statement plant targets the query shared by preflight and the in-batch fence.
Actual native controls/faults/restored positives pass: novelty 0/1/0 in
9.971/24.913/10.376 seconds, and stale context 0/1/0 in 12.277/9.111/25.530 seconds.
The faults fail the intended domain assertions, and source/dependency restoration
audits complete before the next command. The existing registry CLI is not used
as evidence because it discards child streams; direct raw streams are retained.

The route census now enumerates the lazy inbox router and explicitly classifies
three signed-sponsor operations and three existing aliases, while asserting that
all canonical Fellow follow methods stay disclosed. The stronger constructor
census fails on those six routes before classification. Of the three generated
discovery outputs, OpenAPI and well-known bytes remain identical; only four real
schema-index fields change. All 26 discovery/schema-census tests pass, with 1,754
expectations. Migration documentation now names 0130 and its nullable historical
cursor. Stock diff/staged scans finish for both subsequent scopes: 56 matching
locations for the token/mutation files and 95 for the discovery files. Every
critical/warning context is reviewed; no suppression or clean-security claim is
introduced.

The fresh exact-`719cf5cb` full run finishes normally at 00:04:46 UTC on November
7 after 1,645.468 seconds: all eight groups pass, with no failed, blocked or
missing group. Wire passes all 6,751 cases across 287 files; Agora passes 900
cases and 5,983 expectations. Toolchain passes 412 cases, with its 54 existing
individual skips retained. Postchecks match all 2,491 source blobs/modes and
nineteen selected dependencies. All 42 recorded process births retire; 482
unreadable cwd records limit observation. Two inner S1 post-exit drain notices
remain, so this is not a warning-free or every-inner-byte claim.

The matching clean-source
[Vercel Preview](https://asimposium-bwwqd9qma-dicklesworthstones-projects.vercel.app)
(`dpl_SkoM8A3her4HzDr9Fkm2y9EyNqWy`) is READY at exact `719cf5cb`, created
00:08:03.887 and ready 00:08:25.279 UTC. Its nine-second build uses frozen Bun
1.4.4 and Next 16.4.5. Both pre/post-upload audits match all 2,491 files; the
actual provider archive contains 2,447 matching regular source files, 44 expected
Git/Beads exclusions and no extra or unsafe entries. Archive SHA256 is
`c84f3053c5c01e3acafe994a2276dd358b6340f50f9ba96663332affccaa8a26`.
An earlier same-source candidate's archive check correctly fails on one empty
untracked file named `=`, timestamped during Wire testing; its precise writer
is unconfirmed. That candidate, failed audit and successful primary QA are
preserved. The replacement uses a fresh deployment-only checkout; no file is
deleted and the strict extras check is unchanged.

Primary live QA passes the original 26 HTTP, three exact static-byte and four
Chromium-view checks in 16.827 seconds, with no browser errors or prefetch
cancellations. All four screenshots and three actual 1200-by-630 PNGs are
inspected. The new anonymous inbox route returns its sign-in surface and
`private, no-cache, no-store` headers. This is only its hosted anonymous guard,
not authenticated inbox or Google OAuth proof. Ledger views and share images
honestly show the old Worker's unavailable-data fallback. Independent native,
browser, static and live qualification, final provider logs and `bwal` closure
remain pending. The first 34-mode native run's command session ends 143 at
00:12:11 UTC after two passing modes, without the aggregate terminal receipt.
That incomplete attempt is retained under `sbuk`; its signal source is unknown,
downstream execution stops, and no full native pass or cause/fix is inferred.
Bounded detached-terminal controls then retain normal success with both streams
and correctly preserve an intentional own-process interruption without a success
receipt. The unchanged full native command, original case limits and owner cap
pass 34/34 in a separate run: normal exit 0 after 495.156 seconds,
00:20:07.230–00:28:22.386 UTC. This qualifies that native run, not the cause of
the original 143; `sbuk` remains open. The separate registered sponsor-inbox
native consumer also passes normally in 8.420 seconds, including signed reads,
pagination, authorization, acknowledgment, filtering and bilateral transfer.
Its source/dependency postcheck matches. These runs do not certify the excluded
transition-trigger census or the broader `1e7` operational acceptance.
Production browser, separate static gates, independent live QA and final provider
logs remain pending.

A fresh public read at 23:56 UTC still finds the same old `0.1.0-draft`
capability bytes on both Workers and 404 `ROUTE_NOT_FOUND` for `/protocol.json`.
The four required authority/configuration variables remain absent in Node's
environment; this is a presence check, not a credential-store audit. Remote-only
Rust admission at 23:35 UTC selects no worker: nine disk-headroom denials and one
missing pinned compiler remain. Actual cargo transfer, compilation and tests are
NOTRUN. No local fallback, worker reconfiguration or Cloudflare rollout occurs.

### Scientific standing and HEAD repair — 2026-11-06

The earlier qualified source is `b31d54e8e98c963e598463404e23a8be73ed9f1b`.
The new scientific fix (`t5cf`, functional commit `1c662be8`) preserves a
recorded statement defect when its review text is withheld. Before repair,
redacting only the review body changes a malformed claim to open/stale. The
reader now retains the adverse classification from immutable review metadata
without exposing withheld text or granting positive review authority. A new
claim version still resets standing. Missing dependency inputs remain
unavailable rather than acquiring a positive assessment.

Ten new unit regressions fail before repair, covering both defect rubric names
and five withholding modes. Counter-controls cover unweighted and unrelated
reviews, historical cursors and version reset. The focused final suite passes
104 tests. The existing complete local science journey passes in 19.298 seconds
with new anonymous JSON/Markdown/HTML, pack-privacy and ETag checks, alongside
all original assertions. Workerd, D1 and R2 are real; identity and screening are
local fixtures. These results do not establish Google OAuth or deployed G-C.

The first independent unfiltered root run at `1c662be8` fails normally in
1,599.362 seconds: seven groups pass and Wire reports 6,680 passes/35 failures.
Sixteen failures expose a missed indirect unit fixture: its modeled review
table lacks the real rubric column. Nineteen S2 failures expose an upstream
import missing from the canonical source inventory. The closure guard correctly
refuses before those scenarios run. Correction `b31d54e8` supplies the real
fixture column/value and the actual imported export-signature module, adding
that module to the existing omission plant. Assertions, deadlines and source
closure checks are unchanged. The full resolution fixture passes 18/18; focused
S2 positive and negative controls pass 13/13. This repairs current HEAD wiring,
not the historical S2 listener/cost/deployed failures.

The corrected independent root passes all eight groups at exact `b31d54e8`
in 1,791.056 seconds: Wire 6,716/0 across 285 files, Agora 886, and all 129
registered S2 harness cases. The toolchain retains 54 existing individual skips;
no dispatcher group is skipped or blocked. Before/after audits match all 2,471
tracked blobs/modes and nineteen selected dependency identities. All 24 recorded
process births retire and eight known groups have no hits; 488 unreadable cwd
records remain a visibility limit. Two inner S1 fixtures print post-exit drain
expiry notices, so this does not claim every inner byte was retained. The
uninterrupted native discovery passes 33/33 in 427.378 seconds and production
browser passes all 209 checks in 112.823 seconds. Separate gates pass: typecheck
eight groups, lint eight groups, contracts 950, schema drift, render 586, Worker
contracts 178 and security 33. Final recorded process births all retire; 483
unreadable cwd records limit that observation. StormyGorge independently closes
`iajo` in comment 2860 (scanner exit correction 2861) and `t5cf` in 2862, against
their original criteria. Criteria, dependencies and prior history are preserved.

The new [Vercel Preview](https://asimposium-dfr2p9skt-dicklesworthstones-projects.vercel.app)
(`dpl_Z9fs88X9sxeghNpHriVZ9m8sPCks`) is READY at exact `1c662be8`.
Its provider source archive contains 2,427 regular files matching tracked bytes
and modes, with only 39 Beads and five `.gitignore` omissions. The six changed
paths through `b31d54e8` are two unit files, the S2 script and three tracker files;
the other 2,465 tracked blobs/modes, including all application and dependency
sources, are identical. This is disclosed runtime-source equivalence, not an
exact-`b31d54e8` deployment or a rebuilt-binary claim. Three actual share images
pass 1200-by-630 PNG checks and show the unavailable-ledger fallback. Primary
live QA passes the unchanged 26 HTTP, three exact static-byte and four Chromium
view checks in 22.335 seconds; independent live QA passes the same checks in
19.972 seconds. Neither records browser errors. All eight screenshots are
inspected. Two overlapping provider windows cover 17:06:43–18:32:35 UTC with
zero runtime error/fatal and HTTP 5xx records, exhausted pagination and no
excluded intervals. An HTTP 200 record from independent QA confirms visibility.
Earlier local CLI project-context rejections queried no provider logs; explicit
team scope fixes that invocation. This finite observation is not a permanent
no-error claim, a working deployed ledger or proof for later application changes.

At 18:26 UTC, both Cloudflare Workers still advertise the retained
`0.1.0-draft` capability bytes and return 404 for `/protocol.json`. Four required
authority/configuration variables are absent in Node/Bun presence-only checks.
No Worker deploy, duplicate provisioning, DNS change or production promotion
occurs. A fresh read-only Rust admission query finds no eligible worker with the
pinned compiler and required disk headroom; cargo execution is NOTRUN. Neither
local proof nor the Vercel Preview closes these operator/deployed gaps.

### Dependency and schema repairs — 2026-11-06

The earlier qualified functional revision is `c6fb716b0836b7cc96b66cffb6c09a37b15b8310`.
Independent verification in a standalone frozen checkout passes the original
gates below, with source bytes, Git modes and nineteen selected dependency
identities checked before and after execution. The source inventory contains
2,467 tracked files and shares no source inodes with the primary checkout.

| Gate | Result at `c6fb716b` |
| --- | --- |
| Unfiltered root dispatcher | Eight groups pass in 1,401.154 seconds; Wire 6,683/0 and Agora 883 |
| Native discovery | Original 33 cases pass uninterrupted in 439.333 seconds |
| Atomic-batch journey | Passes in 37.555 seconds, including the new nested-source refusal and every original atomic check |
| Account-export journey | Passes in 10.916 seconds, including privacy and transfer checks |
| Production-build browser | All 209 checks pass in 106.287 seconds with the original actions and bounds |
| Separate static gates | Typecheck and lint eight groups each; contracts 947, render 584, Worker contracts 178 and security 33; schema drift passes |

The toolchain root group retains 54 existing individual skips; no dispatcher group
is blocked, missing or skipped. Native discovery excludes the separately executed
atomic-batch and account-export journeys; these runs do not cover the whole
integration registry. Browser coverage includes JavaScript-disabled source and
claim links, actual PNG decoding and image invalidation after a public write.
Workerd, D1 and R2 bindings are real, while identity and screening use local
fixtures. This is local product proof, not Google OAuth or staging G-C evidence.
Final process audits find all 64 recorded process births retired and all 21 known
groups empty. Active visibility limits, one unreadable root post-run record,
warnings and non-exhaustive signal tracing remain recorded in the raw receipts.

The matching [Vercel Preview](https://asimposium-i06jlptgo-dicklesworthstones-projects.vercel.app)
(`dpl_AnEqoRZe3JF3HYwHYmEQ5Y1CjmqA`) is READY at that exact revision.
Build logs confirm Bun 1.4.4, frozen installation, Next 16.4.5 and Node 24.
Primary and independent live QA each pass the unchanged 26 HTTP, three static-byte
and four Chromium-view checks; all eight screenshots are inspected. Three actual
share-image responses pass PNG signature and 1200-by-630 size checks. The provider
source archive contains 2,423 regular files matching tracked bytes and modes;
its only omissions are 39 Beads files and five `.gitignore` files. No extra or
unsafe archive paths are present. Complete provider queries report zero runtime
error/fatal records and zero HTTP 5xx records over 09:29:33–10:16:33 UTC, covering
both live QA runs. Pagination is exhausted and excluded intervals are empty; a
separate HTTP 200 record confirms log visibility. This is a bounded observation,
not a permanent no-errors claim or a working deployed ledger.

At 10:00 UTC, production and staging Worker capability bytes still match the
retained draft receipts; `/protocol.json` returns 404 on both. The four required
Cloudflare authority/configuration variables are absent in both Node and Bun
presence checks. No Worker deploy, resource provisioning, production promotion
or DNS change occurs. `rs5n` and launch remain blocked on operator authority and
the original deployed gates.

The earlier failures and controls below explain the repairs; their results retain
their original revisions.

The repeated no-JS click failure (`3soe`) was reproduced at exact `92ce6a4d`.
That revision independently passes all eight root groups (Wire 6,683), uninterrupted
Discovery 33, the separate atomic-batch journey (34.233 seconds) and account export
(8.472 seconds). Its original production browser nevertheless fails normally in
161.631 seconds after 108 passing checks. The original 30-second exact-claim click
waits after two instability attempts; no downstream statics, independent live QA
or closure follows. Final source/dependency/process audits match, with recorded
visibility limits retained. Primary Preview QA remains a separate pass.

A static browser comparison reproduces the same wait without ASImposium, Next
or Workerd. Plain no-JS clicks pass; the site's finite 0.5-second entrance CSS
triggers long waits and then the original 30-second timeout. The installed
Playwright retry path waits on an in-page timer, whose callback cannot run with
JavaScript disabled. Promise collection can then be misreported as detachment.
The official fix moves the retry delay into the driver:
[issue 42977](https://github.com/microsoft/playwright/issues/42977),
[PR 43012](https://github.com/microsoft/playwright/pull/43012).
The first fixed stable release is 1.64.0; current stable 1.65.0 is adopted as the
coherent three-package family. It explicitly supports Ubuntu 26.04 and Node 24.

The candidate's unchanged 209-check production lane passes in 99.488 seconds;
typecheck/lint pass eight groups each in 124.428 seconds. The same static control
passes all twenty cases, including animated no-JS clicks, in at most 936.888 ms
per click. It retains the original action and 30-second bound. The application
animation, public behavior and assertions are unchanged. Default Chromium/headless
revision 1254 (158.0.8127.18) and FFmpeg 1013 use a new protected cache; old caches,
packages, archives and failures remain. The managed-lock change affects only the
three Playwright versions and removes their obsolete optional fsevents descriptor.
Next/Auth.js versions and integrity descriptors are unchanged; Bun's peer-context
stores change. Primary hydration preserves all eight old links and matches every
candidate link. The new 575-name/601-version census retains the same two alerts.
Final exact-revision independent gates and matching deployment checks now pass
as recorded above. StormyGorge independently assesses every original acceptance
item and closes `3soe` first (comment 2852), then `1mag` (2853) and `hdc1` (2854),
flushing each mutation. Criteria and dependencies are unchanged; no implementing
agent self-closure occurs. The tracker retains the earlier failures and controls.

The following earlier qualification names its own exact source.

The latest review finds a concrete nested-data validation discrepancy (`1mag`):
the temporary-ID resolver can convert an own `__proto__` key into a local object's
prototype, allowing inherited evidence-source fields to satisfy the leaf schema.
Direct evidence rejects the same malformed source. This is not a demonstrated
global prototype mutation or authentication escalation. The minimal repair uses
a null-prototype copy. The mounted unit passes eight expectations; the existing
real-bindings atomic journey fails before repair (batch 201 versus direct 422,
7.864 seconds) and passes afterward in 36.716 seconds. All original atomic checks
remain. The final independent atomic-batch journey also passes at `c6fb716b`.
The preceding qualified source is
`44e8b99c1109371ce5aeadbcf03512111e72070f`.
Wrangler 4.158.0 and Workers types 5.20261104.1 use the published dependency
family: Miniflare 5.20261104.0-beta, Workerd 1.20261104.1, Sharp 0.35.5 and
Undici 7.30.1. This supersedes the first fixed 4.129.1 runtime below. There is
no dependency override, compatibility-date change or application retry. The
original three strict-pin/unpinned/parallel S1 cases pass 67 expectations in
52.676 seconds. Existing dependency stores and replaced links are retained.

Independent exact-revision qualification passes all eight root groups in
1,425.068 seconds: Wire 6,682, Agora 883, and toolchain 460 with its 54 existing
individual skips retained. The uninterrupted discovery file passes 33/33 in
419.036 seconds. Its real Workerd/D1/R2 cases include the changed move and pack
readers. The registered account-export journey passes directly in 9.733 seconds,
including transfer privacy; this is not a pass for the whole integration registry.
The original production-build browser lane passes all 209 checks in 177.915
seconds, including the formerly unstable exact-claim link, real PNG responses,
Chromium image decoding and changed image bytes after a public write. Sponsor
identity and screening are local fixtures, not Google OAuth or deployed G-C proof.

Separate independent gates pass: typecheck eight groups, lint eight groups,
full contracts 947, schema drift, render 584, Worker contracts 178 and security
33. Every gate's source/dependency audit matches 2,467 tracked blobs/modes and
19 runtime identities in a standalone frozen checkout. The root process audit
finds all twenty recorded process births retired and all eight known groups
empty; earlier visibility limits are retained. These results qualify the 22
peer changes in `b3fd95d0`, without attributing authorship or importing their
earlier proof. At that revision the historical click failures were still
unclassified; the later reproduced retry defect and repair are recorded above.

The fixture repair (`fec9eff6`, `hdc1`) follows an actual independent root
failure at `ae2cb4bc`: Wire 6,681 pass and one fail. Retained Workerd-created
D1 state has 130 claim publications and no immutable versions, so the correct
cursor reader omits all their statements. The seed now inserts exact v1 rows
using the existing canonical digest helpers. Read-only forensic inspection
confirms all 130 resulting semantic digests and bindings. DB/WAL hashes remain
unchanged; SQLite reader bookkeeping changes the SHM file. This is retained-file
forensics, not a new bindings API gate or scientific integrity proof. The original
named positive passes 57 expectations; five mounted reads select 78 items each,
with median 115.515 ms and maximum 165.366 ms inside the unchanged 600 ms bound.
The full lifecycle matrix passes in both subsequent independent root runs.

The final registry census covers 575 names/601 locked versions and leaves two
advisory-bearing families: low-severity KaTeX 0.16.47 in the Markdown extension
and moderate Minimatch 10.2.6 in TypeScript tooling. The public renderer calls
direct KaTeX 0.19.1 with existing bounds and `trust: false`; invocation of the old
extension's HTML helper is not established. This does not prove bundle absence
or immunity. The identified Minimatch caller requires project-service options
absent from current ESLint configuration. Current published parents still require
the older major ranges, so unsupported overrides are not used. `l1yg` stays open.
`ii92` also stays open: the official normalized Next 16.4.5 advisory query is
empty, but historical raw open-ended ranges still match. Its literal acceptance
requires all raw ranges to exclude the version; runtime passes cannot satisfy that.

Required remote Rust verification initially blocks on admission. After admission
changes, one new attempt transfers source but stops before compilation with
`RCH-E330`, exit 120: the remote disk-reservation guard cannot fit active builds,
the required floor and this job's reservation. No Rust tests execute, and no local
fallback, guard reduction, cache deletion or unchanged retry follows.

The earlier Vercel Preview `dpl_5E7oV9Rky4f83gBVwBtq5VvvgbYb` is READY at exact `44e8b99c`:
[open Preview](https://asimposium-hqse9xjno-dicklesworthstones-projects.vercel.app).
Actual build logs show Bun 1.4.4, frozen installation, Next 16.4.5 and Node 24.
The provider's retained source archive contains 2,423 regular files, all matching
tracked source bytes/modes; its only omissions are Beads metadata and `.gitignore`
files. No private artifacts, dependencies or environment files are uploaded.
Primary QA passes 26 HTTP checks, three exact static copies and four Chromium
views in 20.874 seconds; all screenshots are inspected. Three actual share-image
responses have valid 1200-by-630 PNG bytes. Seventeen specifically identified
canceled RSC prefetches are recorded separately. Final live QA and the provider-log
window for corrected `c6fb716b` belong to the new deployment recorded above.

The 22-file scan completes with a full 7,210-location export; independent review
of all 86 critical and 347 warning locations identifies the one `1mag` defect.
No additional concrete defect is established. The corrected three-file diff
and staged analyses finish in 209.744 and 289.323 seconds within the unchanged
300-second module cap. Both locate the same 5,876 findings (67 critical, 276
warnings); all critical/warning locations are reviewed. The stock staged export
omits inline code for 123 locations, so its export-completeness flag remains false.
Their source lines are recovered from unchanged retained indexed copies and
match the diff report exactly. The original reports are preserved. This does not
close the separate broad scanner gap (`g4b4`) or establish whole-project security.

Fresh public reads at 06:01:27 UTC retain both old `0.1.0-draft` Worker capability
bodies and `/protocol.json` 404s. Presence-only checks in both Node and Bun's
environment find the four required Cloudflare authority variables absent. Ledger
views honestly display unavailable upstream data. `rs5n` still requires operator
deployment authority and reconciliation of existing resources. There is no
production promotion, new Cloudflare provisioning, Google verification, deployed
cost evidence, S2 closure or launch claim. The new Preview does not patch old
immutable deployments. Final raw records use the `l1yg-wrangler4158-*` and
`independent-44e8b99c-20261106/` prefixes under
`e2e/artifacts/dae7-repair-20261104/`; deployed checks are under
`e2e/artifacts/ii92-preview-20261106-44e8b99c/`.

Earlier controls and failures, retained to show the limits of the final result:

The released fix for Cloudflare workers-sdk #15252 was first pinned at Wrangler
4.129.1, with Workers types 5.20260907.1. The temporary older Wrangler alias
is removed from its actual consumers. Compatibility dates and request assertions
are unchanged. Upstream's own fix retries eligible GET/HEAD requests internally;
no application retry was added. The exact unpinned and parallel S1 plants pass
three tests/67 expectations in 33.970 seconds. All three captures record free
ports and no child survivors before success; 24 retained logs contain no raw
500 or ProxyWorker network-loss diagnostic. The independent verifier subsequently
qualifies exact `f96214d6` and closes `e9y6.1` and its parent `e9y6`, with original
acceptance and history retained. This does not close the separate S2 startup issue.

The security review patches Next/eslint-config-next to 16.4.5, Hono to 4.13.16,
Zod to 4.6.7, AJV to 8.18.0 and Playwright to 1.55.1. Compatible transitive URI,
YAML, brace-expansion and source-map updates stay within existing parent ranges.
Next resolves Sharp 0.35.5. A fresh frozen install matches every checked installed
dependency link, including nested Bun store links; old dependencies and Chromium
1187 remain preserved. Chromium 1193 (140.0.7339.186) is installed from the official
Linux archives without cache pruning. Ubuntu 26.04 is outside Playwright 1.55's
official platform table; actual local execution must qualify compatibility.

Zod's updated exporter exposed a nonstandard `starts_with` format and previously
underconstrained fixed tuples. Four equivalent prefix regexes remove the custom
format. A reviewed refresh changes twelve JSON schemas, no generated TypeScript.
Eighteen nullable unions are equivalent; 86 timestamp patterns now require
RFC3339 seconds; seven tuples close their lengths, including exact S2 lengths
two and six. Three new regressions compile emitted string schemas with a strict
standard-format consumer and compare timestamp/tuple boundaries against the
canonical Zod source. Before repair, two of these tests fail. Afterward, contracts
pass 947 tests, drift passes, render passes 584, Worker contracts pass 178 and
security passes 33. Original golden and drift assertions remain intact.

The Next-only production browser lane passes all 209 checks, including actual
1200-by-630 PNG responses and changed image bytes after a public write. Hono's
425 focused query/auth/session units pass. Its native discovery file completes
31 scenarios before the reviewer's insufficient 600-second outer capture expires
with cleanup proved; the remaining two pass once separately. This is coverage
across two invocations, not an uninterrupted 33-case pass. Final combined-source
independent root/native/browser qualification and a fresh Vercel Preview are pending.
The first new Preview exposes a build configuration gap: Vercel selects Bun
1.3.14 despite the repository's 1.4.4 pin. The configured `apps/web` root now
explicitly pins both install and build commands to Bun 1.4.4, following Vercel's
documented version-pinning mechanism. Node 24 remains the function runtime.
The verifier held before launching its long gates; final evidence must name the
subsequent revision and the corrected deployment, not transfer the first build.
The combined primary typecheck/lint (eight groups each), contracts/render and
Worker contract/security gates pass in 175.626 seconds. UBS completes the current
four manifest inputs with zero findings, and the three changed contract sources
with zero critical/nine warnings. All nine warnings are deliberate fail-hard
`JSON.parse` calls in contract tests; malformed generated artifacts should fail.

The first independent root run at `c86a7dcb` fails normally in 1,446.872 seconds:
seven groups pass, Wire has 6,671 passes and one failure. The missed dependent
golden is the discovery schema index, whose nineteen body-byte counts still
describe the old exports. A full independent old/new census confirms all 38 old
bodies match that golden, and exactly nineteen current bodies change: 120
timestamp patterns, 29 nullable compactions, eighteen equivalent prefix patterns
and five tuple closures. There are no other structural changes. OpenAPI and the
well-known document remain byte-identical. Only the nineteen byte counts are
updated; the original exact golden and registry assertions remain. The three
focused discovery/registry files then pass 57 tests/2,223 expectations in 2.842
seconds. A new complete independent run is required; the failed control remains.

That control's positive S1 captures pass cleanup and show no raw HTTP 500 or
literal `Network connection lost`, but one actual upstream warning records a
GET card request recovered on attempt two after a dropped development connection.
This is the pinned upstream fix's recovery path, not evidence of zero transient
connection drops. The original log and independent process/source audits remain
retained; no S2 reliability diagnosis follows from it.

The earlier npm registry census at 02:50:16 UTC covers 582 package names/636 locked
versions and reports four advisory-bearing families: Miniflare's exact Sharp
0.35.2 and Undici 7.29.0 pins, tooling Minimatch 10.2.6, and KaTeX 0.16.47 through
the Markdown math extension. That older KaTeX is installed, but invocation of its
vulnerable helper is not established; the active math renderer uses direct KaTeX
0.19.1 with its existing trust setting and output bounds. These residuals do not
justify unsupported dependency overrides or a security-clean claim. `l1yg` stays
open. Rust verification stops before compilation: required RCH remote admission
returns exit 103, `disk_headroom=8`; fleet readiness does not satisfy that job's
capacity check. No local fallback, worker reconfiguration or cache deletion occurs.

The new stable-runtime S2 control fails in 219.422 seconds with
`S2_PARALLEL_SECOND_NOT_READY`; SIGTERM mode is unreached. The other child
completes its workload but separately refuses provenance after a concurrent commit,
despite an unchanged source digest. Neither observation diagnoses the second
child's readiness failure. Original `9gyi` remains blocked; no unchanged retry is
used to replace this failure. Cloudflare deployment authority remains unavailable
(`rs5n`), and old immutable Vercel deployments are not patched by a new Preview.
Raw records are retained under `e2e/artifacts/dae7-repair-20261104/` with the
`e9y6-*`, `ii92-*` and `l1yg-*` prefixes.

At `f96214d6`, the corrected independent root run passes all eight groups in
1,484.091 seconds: Wire 6,672, Agora 883 and toolchain 406, with its 54 existing
individual skips retained. The unfiltered native discovery file passes 33/33 in
658.992 seconds. Independent typecheck/lint pass eight groups each; full contracts
947, drift, render 584, Worker contracts 178 and security 33 also pass.

The production-browser prerequisite first blocks at exit 78: both shared-cache
Chromium 1193 directories are absent despite their earlier successful use. Their
loss is unattributed. The retained official archives still match their hashes;
the exact full/headless binaries are restored into a new project-owned cache,
with an SBH protection marker and exact-path registration. The original default
headless shell is selected through `PLAYWRIGHT_BROWSERS_PATH`, without changing
the actions or bounds. The next original production build succeeds and passes
108 checks, then fails its 30-second native click on the exact claim link at
`agora-local-lane.mjs:333`: unstable geometry and DOM detachment. No subsequent
URL/heading assertion executes. `3soe` owns this related unclassified observation;
the different link does not establish a shared cause with its older source-summary
failure. `ii92` remains in progress; the full 209-check criterion is unmet.

The new diagnostic reuses the existing safe failure snapshot for that link and
caps failure-only RPC collection at one second, preserving the original click,
bound, subsequent assertions and error. A source-extracted four-case unit check
confirms that the old collector remains pending while the new collector returns
after 1,000.627 ms; this is not browser or D1 evidence. Compiler/lint and 50 E2E
harness units pass after the change. A successful diagnostic control would not
explain the original timeout. Diagnostic elapsed time includes snapshot collection.

Vercel deployment `dpl_4jFdhCr9bJ6covDk15YWufZejXXY` is READY at exact `f96214d6`;
actual logs show Bun 1.4.4, frozen installation, Next 16.4.5 and successful build.
Primary live QA passes 26 HTTP checks, three exact static copies and four Chromium
views in 20.960 seconds; all four screenshots are inspected. Three actual share
images are valid 1200-by-630 PNGs. Runtime error/fatal and request 5xx queries cover
03:35:17–04:01:30 UTC, each returning zero records with no next page or excluded
interval. Sixteen precisely identified canceled RSC prefetches are recorded
separately. Independent live browser reexecution remains unrun after the local
browser failure. Ledger pages visibly retain their unavailable upstream state.

Concurrent peer commit `b3fd95d0` adds 22 functional changes to enrollment privacy,
move selection, captured pack heads and grounded scientific support. Read-only
review finds no concrete blocker, and current compiler/lint/E2E units pass; the
earlier runtime qualifications do not transfer to that new source. Further full
checks use a frozen main checkout to preserve their inputs while peers continue.
At that point, the supported later Wrangler 4.158.0 bundles patched Sharp
0.35.5/Undici 7.30.1, making it a concrete candidate for `l1yg`; the subsequent
adoption and exact-revision qualification are recorded above.
The latest math extension and TypeScript parser still retain their older KaTeX
and Minimatch ranges. These remaining families are not all awaiting a missing
upstream release. Cloudflare authority, optional Rust execution and launch remain
blocked at their existing boundaries.

### Broad scanner investigation — 2026-11-06

At `770551d3`, the recovered committed merge range has 270 paths: 224 JS/TS
sources, two shell scripts, six SQL files and 38 other files. This matches the
old index count without certifying the exact historical uncommitted snapshot.
All 270 current file hashes remain stable through the new runs. The captured JS
engine input list contains those 224 sources plus two context files.

Stock UBS again times out at its default 300-second module limit (302.656
seconds overall). A separately declared, supported 900-second budget also times
out (904.801 seconds overall). Both are partial, with no completed JS analysis;
there is no further budget escalation. A safe diagnostic snapshot places the
extended run in the taint analyzer's branch-state heap joins. That narrows the
component, not the complete timeout cause. SQL completes all six files with zero
findings; shell analysis completes both files with one reviewed Perl-block
`eval` false positive, five reviewed warnings and 24 informational findings.

An exact installed scheduler-loop test uses synthetic modules and real child
processes: the normal control passes, an unrelated child reproduces the empty
`FREE_SLOTS` crash, and waiting only on tracked scanner PIDs passes that case.
The one-line candidate patch applies cleanly to the installed and maintained
scripts, but neither is changed or fully qualified. This proves the algorithm
defect, not the identity of the child in the historical crash. Original `g4b4`
acceptance remains open. Raw results and the candidate patch are retained as
`e2e/artifacts/dae7-repair-20261104/g4b4-*`. Application and harness code are unchanged.

Primary headroom falls below 1 GiB. A private `/tmp` checkpoint preserves the
pending patch, a consistent 566-issue/2,822-comment database and in-flight
evidence; that checkpoint is not a final scan result. `0oi3` remains open.

The subsequent fresh review at `73e07a87` finds no additional source defect. One
complete original production browser lane, including a fresh Next build, passes
all 209 checks in 158.035 seconds (23:24:34–23:27:12 UTC). The native source
disclosures work with JavaScript both enabled and disabled; the earlier click
timeout does not reproduce. `3soe` remains open and unclassified. No source,
click, timeout or assertion changes were needed, and no unchanged retry follows.
Raw evidence: `e2e/artifacts/dae7-repair-20261104/fresh-review-3soe-production-browser-20261105T2325.*`.
This is real local Chromium/Next production/Workerd/D1/R2 with a locally minted
sponsor session and fixture screening, not Google OAuth, Vercel or staging proof.

### Fresh-eyes S2 corrections — 2026-11-05, 23:18 UTC

The final one-line correction routes Wrangler's existing debug logger into the
existing per-Worker log using `WRANGLER_LOG_PATH`. Previously those startup details
were outside run retention in the global directory. Three exact original logs
are now also retained privately under the existing artifact prefix. The pinned
logger treats an explicit `.log` path as a file and skips global age cleanup;
no past deletion is inferred. Real pinned CLI directory/file controls pass in
2.027 seconds with identical version output; only file mode leaves the ambient
directory empty. No new logger framework, product surface or bound is introduced.

At script SHA-256
`19ca21a858f1160c195388cec50a24335c0cf7fd17aaed70c038c6fb535ad798`,
the original parallel/SIGTERM gate passes once in 274.507 seconds,
23:11:59–23:16:33 UTC: one test, zero failures, all eight original assertions.
Both parallel children complete the current legacy-journal upgrades and evidence
publication at expected exit 78; their retention receipts pass at 24,060,655 and
26,755,148 bytes, below the unchanged limit. Three inspected Worker logs per child
contain the built-in debug output. The full test also passes SIGTERM cleanup.
This primary local run extends the earlier focused migration checks; it does not
diagnose historical startup/listener loss, exercise the outstanding actual-partial
experiment, supply independent exact-revision execution, or close `9gyi`/`tum1`/`doa`.
Its receipt is `fresh-review-retained-debug-native-20261105T2313.result.json`
under `e2e/artifacts/dae7-repair-20261104/`; parallel parent is
`e2e/artifacts/s2-krater/20261105T231159Z-9402e3af6e849744/`.
Eight selected existing units also pass in 13.428 seconds (92 filtered, 199
expectations). Root lint passes all eight groups in 65.138 seconds with existing
warnings. Default `ubs --diff` completes in 91.337 seconds: one Bash file, zero
critical, the same four reviewed warnings and 24 informational findings. No
TypeScript changed; earlier full-root/typecheck results keep their original scope.

The earlier Bash-only increment fixes a separate Wrangler-summary redaction gap.
Its legacy regexes missed bare Fellow, join and flow credentials. The existing
fixture padded its input before checking, clipping away most samples. The summary
now applies the already-shared canonical credential redactor first, followed by
the existing extra labels/path handling and final clipping. The existing case
checks eleven unpadded values and a retained ordinary error, then checks the
clipping boundary separately. The registered case passes in 0.920 seconds; an
actual-source four-case comparison takes 0.257 seconds, reproduces five old
credential echoes versus zero fixed echoes, and catches clipping before redaction.
These are synthetic unit fixtures, not real credential exposure or D1 proof.

Readiness transport errors now append to the existing worker log. A real local
HTTP comparison also finds that ambient verbose curl configuration can echo the
header, so the final call uses the already-sourced `e2e_curl` helper. Empty and
verbose configuration controls make four requests with identical path, project
User-Agent, header and ready response; only the old direct verbose call echoes
the synthetic header. The final-source comparison passes in 0.158 seconds.
All original readiness/ownership assertions and deadlines remain unchanged.

The first changed-diagnostic native gate fails in 377.432 seconds,
22:16:15–22:22:33 UTC: first status 124, second 125, zero passes/one failure/one
assertion, with SIGTERM mode unreached. The second journal application explicitly
reports `SQLITE_FULL`; the first status is a parent deadline. Physical headroom
falls from 1.5 GiB to 23 MiB. This classifies this occurrence, not historical
listener loss. Both main logs retain 77 curl error lines and zero verbose header
lines. A private `/tmp` patch/database/generation checkpoint preserves current
work. Headroom later returns to about 10 GiB through an unidentified external
change; `0oi3` remains open. That source's native control then fails in 441.647
seconds, 22:27:47–22:35:09 UTC: first status 124, second 78, zero passes/one
failure/one assertion; SIGTERM mode is unreached. The first child ends during
journal work at the original 300-second parent bound. The other completes all
local phases and evidence publication. This identifies a preparation bottleneck,
not a cause of historical listener loss. External commit `b9bd3171` contains the
redaction/readiness changes; this reviewing agent did not issue that commit.

The next source change reuses the existing native migration driver for both
empty and seeded legacy-journal upgrades. It verifies the effective database
identity across all three configurations and canonical current migration settings.
Upgrade mode requires the exact CLI-created 0001 journal row before applying
anything and cannot create a missing journal. Original CLI legacy bootstrap and
final journal readback, per-file SQL/journal transactions, fixtures, Worker
backfill/write/replay assertions and all bounds remain. This exercises genuine
old-to-current D1 interoperability, not the CLI's per-file runtime orchestration.
The existing verifier reviewed both this mechanism against original acceptance
and the implemented guards read-only; no independent runtime pass is implied.

At final script SHA-256
`7013221b9a5c123ae09e1fd2c727e2e74597c7e60efe2d5e4c08f830a79362a7`,
nine original native driver cases pass in 12.669 seconds. Seven additional native
legacy cases pass in 26.562 seconds: missing journal, mismatched effective
identity, unsupported upgrade configuration, invalid mode, empty and seeded
CLI-created upgrades with all 129 journal rows/timestamps, and rollback after
real 0002 SQL. The seeded event and original journal survive that rollback;
integrity and foreign-key checks pass. These are focused real-binding checks.

The changed source's whole original control fails in 206.490 seconds,
22:46:57–22:50:24 UTC: `S2_PARALLEL_SECOND_NOT_READY`, zero passes/one failure/one
assertion, SIGTERM mode unreached. One child completes its exercise then cannot
restart its Worker; the other cannot initially start its Worker. Retained cause
text contains curl connection refusals followed by one-second zero-byte timeouts.
The whole control on that source does not reach the changed journal-upgrade path.
That review ended after this result; the subsequent logging-only correction and
control are recorded above. Startup/restart causes and original `9gyi`, `tum1`
and `doa` acceptance remain open and unchanged.

Eight selected existing Bun cases pass in 7.310 seconds (92 filtered out; 199
expectations), covering four shell modes, journal/source closure and integration
authority boundaries. Root lint passes all eight groups in 56.223 seconds with
existing warnings. Literal default `ubs --diff` completes the changed Bash file
in 79.930 seconds: zero critical, four reviewed existing warnings and 24
informational findings. The warnings concern a `set -e` protected `cd`, embedded
JavaScript `readSync`, and two literal signal-phase strings. No suppression or
scanner change is made. No TypeScript file changes in this increment; the earlier
full-root/typecheck/contracts/render results retain only their named scope.
Raw receipts are under `e2e/artifacts/dae7-repair-20261104/fresh-eyes-*`;
the last parent is `e2e/artifacts/s2-krater/20261105T224657Z-1bdb00fffdd0d906/`.
Nothing here is an original S2 gate pass, deployed qualification or launch claim.

The earlier qualifications and failures below retain their named source scope.

Source `577df84e788a9207b6405106ce52bc15188911af` fixes four concrete review
findings. The reused native D1 setup now verifies the canonical migration
directory and journal configuration, checks every batch result, and emits its
final success only after disposal succeeds. Cleanup errors identify their phase.
The integration consumer prints credential-redacted captured output when an
original assertion fails; the parallel failure record includes both child exit
statuses. The disconnect client awaits both asynchronous stdin operations inside
its original absolute 15-second deadline and drains child diagnostics on an early
send failure. Original product assertions, legacy Wrangler lanes and all bounds
remain unchanged. These are setup and diagnostic fixes, not a diagnosis of the
historical listener loss.

Nine focused checks against genuine Node 24 and native D1 pass in 15.122 seconds:
fresh 129-file setup, same-state no-op, a duplicate-key failure after real 0002
SQL, three unsupported configuration refusals, missing/outside persistence paths,
and an injected failure after real disposal. Read-only inspection of the closed
D1 artifact confirms that 0001 remains, 0002's table and journal entry roll back,
and integrity is clean. The cleanup negative has no final success summary.
An initial inspection assumed one SQLite file and failed because Miniflare also
creates metadata databases; it is retained, and the corrected inspection selects
the actual D1 database. These focused checks are not the whole product gate.
The original two-mode gate fails in 300.987 seconds (20:30:47–20:35:48 UTC),
zero passes/one failure/one assertion; SIGTERM mode is unreached. The new captured
diagnostic reports `first_status:125`, `second_status:78`. The first child passes
the exercise client, then cannot restart its Worker within the original readiness
window; its Wrangler log is empty and evidence finalization fails. The second
completes all local phases and evidence publication. Parent retention passes.
This identifies the boundary, not its cause; no unchanged retry or independent
fault/closure is credited. The existing verifier reviewed the fixes read-only.
That review finds a further output bypass: Bun's string assertion errors can echo
the raw received stream after the catch block prints a redacted copy. The three
string checks now assert equivalent boolean predicates, retaining all four
original assertions. A comparison executes the actual old and corrected blocks
in real Bun with stdin-only synthetic credentials: six cases/twelve executions
pass in 0.479 seconds. Both versions accept the positive and reject every
negative; four old error paths expose the dummy credential, while none of the
corrected paths does. This is a unit check of assertion serialization, not D1 or
whole integration proof. The root run began before this final test-only change;
final typecheck/lint qualification follows it and passes.
The local readiness curl also gains the shared project's honest User-Agent after
the original native run. Final typecheck/lint passes; independent runtime
qualification remains pending. Raw results are retained under
`e2e/artifacts/dae7-repair-20261104/fresh-eyes-*` and parent
`e2e/artifacts/s2-krater/20261105T203047Z-ff363975d76d4a38/`.

The full root unit dispatcher passes all eight groups in 1,537.186 seconds,
20:40:43–21:06:20 UTC: no failed, blocked, missing or skipped groups. Worker has
6,672 passes and 30,643 expectations; Agora has 883 passes and 5,831 expectations.
Toolchain retains its 54 existing skipped tests.
The run began before the final integration-test-only assertion change; Worker
and client runtime sources remained fixed. The separate six-case assertion
comparison exercises that corrected branch. Final typecheck/lint passes eight
groups each in 137.997 seconds, 21:06:43–21:09:01 UTC. Unchanged full contracts
(944) and render (584) passed earlier.
Final default UBS diff scans both changed source files in 60.803 seconds:
zero critical, four reviewed warnings and 31 informational findings.
An explicit scan of all four reviewed TypeScript files exits 1 with one
critical/eight warnings: the critical is a header name, and the reviewed warnings
concern existing test/harness code. The local body reader remains intentionally
test-only and token-gated; this is not a production security certification.
The default staged scan crashes at UBS line 9377 (`FREE_SLOTS: bad array subscript`)
before completing coverage, exit 1 in 0.510 seconds. The unchanged stock tool is
already using one slot, so `--jobs=1` would not change that path. Supported staged
JavaScript and Bash scans then complete separately in 1.117 and 42.732 seconds.
Their union covers both current supported staged files: zero critical findings,
four reviewed Bash warnings and 31 informational findings. Analyzer rules and
default limits are unchanged. This establishes current delta module coverage;
the failed default aggregate and historical broad-input gap remain on `g4b4`.
No scanner suppressions, global tool patch or security/launch pass is claimed.

Primary headroom initially returns to 5.5 GiB, then falls to 2.3 GiB. `0oi3`
remains open. A fresh private online database/generation snapshot preserves 566
issues and 2,808 comments. Operational sync is healthy and normal sanitized
publication succeeds; `br doctor` still exits 1 for retained artifact/ignore/stale
dependency warnings. No rebuild, deletion or promotion of an older generation
was needed. Concurrent commits `02db049c` and `577df84e` were preserved; this
reviewing agent issued neither commit. No Bead is closed from these subset checks.

### Earlier S2 migration setup increment — capacity hold, 2026-11-05

The current setup patch (`scripts/e2e-s2-krater.sh`, SHA256
`0694a6026b2b01dfa5b71a42099f5873af9972b14c92faa4b19bfc7ac4206ccf`)
keeps one native D1 runtime for the initial fresh-database migration sequence.
It uses the pinned Wrangler CLI's Miniflare constructor, database identity and
persistence layout, its SQL splitter, and a separate batch plus journal insert
for each canonical file. The 120-second command bound is unchanged. Both legacy
journal upgrade lanes still execute the original Wrangler CLI; no snapshot or
SQLite adapter replaces native D1.

Real Node 24 / Workerd applies all 129 files in 4,983 ms; the same-state rerun
applies zero in 1,116 ms. A final journal-format control passes in 6.824 seconds
including both launches. Read-only artifact inspection finds all 129 journal
IDs/names identical to a completed CLI run, with 833 schema objects: 832 have
byte-identical SQL and one trigger differs only in indentation after the workload
recreates it (`worker.ts:625,669`). Integrity is clean and foreign-key violations
are zero. A changed executable input adds duplicate-key inserts after migration
0002's real SQL: native D1 fails at that file, rolls back its table and journal
entry, and preserves migration 0001. The failing child exits 1 in 1,322 ms; this
is an intended negative, not a passing whole product gate.

The original whole parallel/SIGTERM command **fails** in 423.928 seconds
(07:54:48.449–08:01:52.378 UTC), zero passes/one failure/one assertion. The second
parallel child completes every local phase and publishes retained evidence
(41,978,388 bytes plus the unchanged reserve, external exit 78). The first ends
after 545 records during upgrade, with status 143 and no final evidence receipt.
Its status time is 299.376 seconds after the second child's ready file, matching
the parent lifecycle's 300-second window; the retained observations do not prove
the signal sender. SIGTERM mode is unreached. No unchanged retry or widened bound
is used to turn this failure green.

Current typecheck/lint pass eight groups each, contracts 944 tests/6,448
expectations and render 584/5,916, combined 140.844 seconds. Default UBS diff scans
the one changed Bash file in 46.635 seconds: zero critical, four reviewed existing
warnings, 24 informational findings, with no suppressions. Full-root and independent
runtime qualification are **not run** after the primary filesystem falls below
219 MiB and then to tens of MiB. `0oi3` is P0; `9gyi` is blocked on it. All original
`9gyi`, `tum1` and `doa` criteria remain intact and unfinished. No current-source
full-root, independent, deployed, cost or launch pass is claimed.

Failed startup prototypes remain retained: the general platform proxy and forced
ESM launches time out; an initial dependency-resolution error is corrected by
resolving Wrangler's physical package path. Installed Miniflare uses an inherited
CommonJS worker and a synchronous wait; the corrected launcher uses CommonJS.
An optional inline worker diagnostic is blocked before execution by DCG and earns
no proof credit. Evidence remains in `e2e/artifacts/dae7-repair-20261104/`, under
the `s2-native-d1-*` and `s2-runtime-reuse-*` names. A private `/tmp` patch and
consistent 566-issue database checkpoint preserve current work against ENOSPC.
These are recovery copies, not restored primary capacity or the missing historical
snapshot. No deletion, global cleanup, new deployment or production promotion.

### S2 accepted disconnect and listener investigation — 2026-11-05

The local probe at `fc56a331` replaces a race between dispatch and a 20 ms timeout
with a matching Worker acknowledgment followed by an owned Node 24 request close.
The Worker reads the complete JSON body, records the existing three-field local
observation and sends one bounded NDJSON acknowledgment. Its original synthetic
fault still refuses the transaction; the finite 125 ms response window and normal
EOF remain. The client starts its 20 ms close timer **after** validating that
acknowledgment, within one 15-second helper bound. This intentionally changes the
phase measured by the timer; it is not an unchanged 20 ms end-to-end deadline.
The original 400 ms observation, no-transaction, cursor, idempotent retry and outer
lifecycle assertions remain.

This proves only a controlled pretransaction refusal plus an observed accepted
client disconnect. It does not prove Worker-reactive cancellation, upload
interruption, rollback, canonical scientific validation or production behavior.
Normal EOF, an HTTP refusal or an absent/mismatched acknowledgment cannot count as
the client's owned abort. The independent missing-acknowledgment fault is still
required; a preliminary observation GET returning 404 is not that proof.

Eight earlier response-cancellation and partial-upload experiments fail and earn
no qualification credit. Actual partial-byte/body-read-error assertions eventually
pass, but later native requests reset. Genuine Node 24 and removal of an invalid
missing-route probe do not establish the cause. The stronger experimental protocol
was withdrawn explicitly, restoring the original controlled-fault scope; its exact
failed three-file source is retained in
`e2e/artifacts/dae7-repair-20261104/tum1-unqualified-upload-experiment.patch`
(17,002 bytes, SHA256 `0d7baac1e86bcc6337637ef9d5ce108fceb58f7a9600a5a509fe6a68ae4d24aa`).

The minimum complete-body variant first passes the whole local gate in 548.997
seconds. However, the primary exact-`fc56a331` run then fails in 317.549 seconds
and the independent exact-revision clean control fails in 347.411 seconds. Both
pass the acknowledgment/owned-close/no-write/retry checks before later listener
loss. One primary Wrangler log contains an esbuild Go deadlock trace; the independent
failure reports HTTP 500, `Error: Network connection lost`. Neither proves a
specific pre-cleanup exit cause. Independent verification stops at the red control;
no mutant, restored positive or closure is credited to that run. Its source,
dependency and bounded cleanup audits pass: 2,466 Git blobs/executable modes are
exact, 30 sampled births retire and seven known groups are empty; 395 unreadable
host cwd entries limit the census.

Source `e673fc54` adds only an explicit `Connection: keep-alive` header to the
genuine Node request; `agent: false`, original assertions and bounds stay. Its
complete original local gate passes in **549.644 seconds**, one test/eight
assertions across parallel and SIGTERM modes. This is a candidate transport setting,
not a diagnosis of earlier listener loss. Typecheck/lint pass all eight groups,
full contracts pass 944 tests and render 584. The complete root command passes
eight groups in **1,441.883 seconds**, including 6,672 Worker and 883 Agora tests;
toolchain has 406 passes and 54 existing skips. All three source hashes remain
fixed. Literal default UBS diff/staged scans cover the one changed JS file with
zero critical/warning matches and 419 informational findings; earlier three-file
scan findings remain retained, with no project-wide clean-security claim.
These primary checks run on the candidate before its commit; their source hashes
match `e673fc54`. They are not primary native execution at that exact Git revision.

Independent exact-`e673fc54` qualification **fails its first clean control**, normal
exit 1 in **187.478 seconds**, 07:04:32.503–07:07:39.981 UTC, zero passes/one failure/
one assertion. The first child stops during migration, before any workload or
acknowledgment. Its retained migration log reports
`0071_scientific_withdrawals.sql`, `ECONNREFUSED 127.0.0.1:41727` and an owned-command
`deadline` with `cleanup_proven: true`. The existing command bound is 120 seconds
(`scripts/e2e-s2-krater.sh:85`); the outer command terminates normally with exit 1,
not an outer timeout. Why migration missed that bound remains unknown. Do not
classify the refused connection as spontaneous listener death or a keepalive
effect from this evidence.

Verification stops at that red control. SIGTERM, the Connection-close comparison,
missing-acknowledgment fault, partial-upload matrix, restored positive and new cost
consumer are **not run**. Source/dependency audits remain exact; 14 sampled births
retire and four known groups are empty, with 381 unreadable host cwd entries. Raw
evidence is in `e2e/artifacts/independent-tum1-e673fc54-20261105/`; the actual child
migration log is retained under its named `s2l-190968b5...` root. A future meaningful
fault and restored whole positive remain required; no unchanged retry or widened
deadline substitutes for them.

`asimposiumorg-9gyi` retains its original specific-cause, native chronology and
real partial-upload acceptance; ordinary complete-body success cannot close it.
`tum1` is blocked on `9gyi`, and original `doa` stays blocked with its complete
deployed/cache/DO/cost acceptance. No acceptance criterion was removed and no issue
was self-closed. The verified existing Preview's web inputs remain unchanged.
Fresh 07:10 UTC reads return HTTP 200 for its home and all three static protocol
copies, whose bytes match source. This is four HTTP checks, not fresh browser or
provider-log coverage. There is no new Vercel build, Cloudflare deployment,
production promotion or launch verdict here.

### S2 local lifecycle and retained cost input — 2026-11-05

Source `056d1de7a718d00a6e38e18cf5a256e07ba9b32b` repairs the local S2 fixture
and runner. The original opt-in gate first fails in a verified process context
after 214.653 seconds: mounted promotion returns 503 because the active fixture
problem has no statement-version row. The production context reader correctly
refuses it. The existing local seed now supplies an explicit legacy formulation
with the canonical normalized hash. It creates no event or outbox row; the
unchanged mounted promotion must still be event sequence 1 and deliver once.

That repair lets both parallel children complete every native phase, but the
next whole run still fails after 504.412 seconds: retained files exceed the
unchanged 64 MiB cap. Wrangler 4.123's optional local explorer trace store is
now disabled for new S2 runs. Required client, D1, DO and stderr records remain;
no failed evidence is deleted or truncated. Fresh children retain 49,786,639
and 49,807,204 bytes, each plus the unchanged 2,359,296-byte publication reserve
within the 67,108,864-byte limit. HTTP requests also identify the project.

The complete original `bun run --filter @asimposium/wire test:integration:s2-real`
command then passes in **518.763 seconds**:
**one test, eight assertions, both parallel and SIGTERM modes**, with all
original limits and later assertions. Its full children honestly retain exit
78 for absent deployed DO and edge-cache evidence, while evidence retention
and immutable cost publication pass. The existing cost verifier consumes one
actual four-file receipt chain and reports **S2 `accepted-local`**, covering
232 selected settled-write receipts. Its overall result remains exit 78,
`COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE`; incomplete row totals, deployed
traffic, CPU, cache, R2 and pricing evidence prevent a complete cost verdict.

Typecheck and lint pass all eight groups, full contracts pass 944 tests and
render passes 584 (128.713 seconds combined). The original full root unit run
passes eight groups in 1,384.795 seconds, including 6,662 Worker and 883 Agora
tests; toolchain has 406 passes and 54 existing skips. Three source hashes stay
fixed through these checks. Default UBS diff/staged scans each cover all three
changed code files and exit 1 with one critical match, five warnings and 513
informational findings. All critical/warning locations were read: the critical
is a public header name; warnings include the existing local-only unbounded
JSON reader and lexical Bash matches. No suppression or security-clean claim.

Independent verification at exact `056d1de7` passes the complete original gate
in **515.762 seconds**, then passes again after exact restoration in **556.749
seconds** (one test/eight assertions each). The one-site formulation-INSERT
removal fails normally in 144.593 seconds: its second parallel child reaches
the intended 503 / `S2_MOUNTED_PROMOTE_NOT_COMMITTED`. Its first child instead
fails an earlier disconnect-acceptance assertion. Client timeout followed by
observation 404 is retained under **`asimposiumorg-tum1`**, which now blocks
the original S2 Bead. This is a mixed negative result; restored green does not
classify that additional failure, and no unchanged retry was used to do so.

All four successful independent parallel children pass the six required local
phases and retention-plus-reserve limit (largest sum 55,029,955 bytes). Required
logs remain and optional trace-store paths are absent. The independent cost
CLI consumes a clean restored receipt and reports `accepted-local` with 232
selected settled-write receipts, then exits 78 for external measurements.
Observed local p95 write-phase / preflight / whole-write times are 1,602 / 265 /
1,850 ms; these establish no deployed latency or 900 ms budget verdict.
All 2,466 Git blobs/executable modes and checked dependency identities are
restored; 40 sampled births retire and 12 known groups are empty. Visibility
of 409 host cwd entries is unavailable, so this is not a whole-host census.
Evidence is in `e2e/artifacts/independent-doa-056d1de7-20261105/`.

A canonical-HEAD check fails after an unknown actor commits only the two
documentation files as `0e3a74df`; neither primary nor verifier issued that
commit. The failed check is retained. A separate Git-tree comparison confirms
no runtime delta, and the tested subject remains `056d1de7`. Initial
launcher errors (wrong home, then Tini not PID 1) remain retained without
qualification credit. Corrected runs use UID 1000, its own home, PID-1
`docker-init`, genuine Node 24, Bun 1.4.4 and default `/tmp` in private process
and mount namespaces. Receipts are in `e2e/artifacts/dae7-repair-20261104/` and
the named local S2 artifact roots. Original `asimposiumorg-doa` stays blocked
with its full deployed/cache/DO/cost acceptance. The verified Preview's web
inputs are unchanged; no new deployment or production promotion is claimed.
Fresh 03:42:43 UTC reads retain the production/staging capability bodies
(`0.1.0-draft`, the same recorded hashes) and production `/protocol.json` 404.
Body equality does not identify provider revision or migration lineage.

### Original integration acceptance and Preview — 2026-11-05

The independent, unfiltered Worker integration command at exact revision
`abfa90cd9ec7fecd875d3f217a837652889537d7` finished with **331 passing and six
failing tests out of 337**, 1,685 expectations, exit 1 `SUITE_PREFLIGHT_FAILED`,
in 2,330.701 seconds. The downstream S2 authority probe was not reached.
Eleven of the thirteen earlier repaired journeys passed; governance and face
census did not. Full accounting and raw-stream hashes are retained in
`e2e/artifacts/independent-dae7-abfa90cd-20261104/integration-terminal-summary.json`.
The verifier checked all 2,466 source blobs and Git executable modes, dependency
identities and the isolation boundary. This is local evidence only.

The failures exposed a stale public-schema census (21 actual versus 20 expected),
an offline verifier still restricted to v3 although the public export is v4,
concurrent governance callers receiving the declared in-flight 429, an atomic
authority test whose delay also held governance screening, and a moves Markdown
face omitting the catalog version and template titles. Repairs retain strict
source binding, event signatures, exact-key replay, authority refusals and face
parity. The v4 companion's reported assurance is self-consistency only; event
checkpoint signatures do not authenticate that companion's provenance.

The sixth failure is the S6 supervisor self-test. Diagnostics observed a timed
read consume one byte of a control frame before timing out. The inner supervisor
discarded partial control and child-result records. Two separate causal cases
split a valid record across the existing 50 ms poll; the old reader's complete
self-test fails precisely those two cases (64.671 seconds). Separate buffers
retain at most 511 bytes until a newline, preserving the existing nonce, status,
order, EOF and deadline checks. The same complete wrapped self-test then passes
in 64.613 seconds. Explicit zero-survivor and empty-owner checks isolate the
cases; the final complete auth file passes **131 tests and 1,069 assertions**
in 68.507 seconds. This establishes the current framing defect, not the sole
cause of every historical S6 failure. Diagnostics retain safe statuses without
recording envelopes, keys or signatures. The script change addresses an actual
S4/S7 blocker; the closed S6 spike is not reopened as a polishing project.

The five selected registered native tests pass in 134.973 seconds (76 tests
filtered out), and focused renderer/verifier units pass six tests with 114
assertions. Typecheck and lint pass all eight groups; contracts pass 944 tests
and renderers pass 584. The new full root run exits zero in **1,418.831 seconds**:
all eight groups pass, including 6,662 Worker tests and 883 Agora tests. Toolchain
has 406 passes and 54 existing skips. The same ten code hashes remain fixed
through the required gates. This uses the recorded proper-init/private-process
setup.

Independent verification at exact `9277e917920e3c3eb24643c1685065304f274f20`
then runs the original unfiltered package: **337 pass, zero fail, 1,757 Bun
expectations**, all thirteen original repaired journeys complete, in 1,491.236
seconds. It reaches the actual `S2_REAL_BINDING_PROOF_BLOCKED` and
`SUITE_NOT_IMPLEMENTED` records with exit 78. This is local repair acceptance,
not a whole-integration pass. StormyGorge closes only `asimposiumorg-dae7` in
comment 2787, citing each original acceptance item without changing its scope or
dependencies. All 2,466 source blobs/Git executable modes, ten repair pins and
checked dependency identities remain exact; the isolated source shares no regular
source inode with canonical main. Seventeen sampled births retire and four known
groups are empty; 391 unreadable host cwd entries limit process visibility.
Receipts and the thirteen citations are in
`e2e/artifacts/independent-dae7-9277e917-20261105/`. The earlier abfa failure is
retained. `l6hr`, historical causes and broader reliability acceptance stay open.

Default UBS diff exits zero over seven files with zero critical findings and
58 warnings. A separate scan includes all ten changed code files, including
already committed peer work: it exits one with 15 critical matches, 96 warnings
and 1,298 informational findings. All critical and warning locations were read.
The critical matches compare test modes, face suffixes and public IDs; they do
not compare secrets. Warnings concern strict test parsing, schema-refined or
fixture accesses, named verifier helpers, hostile-input fixtures and an already
exported locale. No rule or finding was suppressed. All 1,409 source occurrences
were retained; this is scoped coverage, not a project-wide clean security scan.

The [new Vercel Preview](https://asimposium-1z7hq4uu9-dicklesworthstones-projects.vercel.app),
`dpl_23Rjg8H4GVjs7kLbvJQNVT2Qhsxg`, is READY on Node 24 with Preview target.
Automatic `githubCommitSha` matches `9277e917`; the optional legacy
`gitCommitSha` field is absent. An initial readback check incorrectly required
both fields; that failed check is retained rather than inventing metadata or
redeploying to satisfy it. All tracked source blobs and Git executable modes
match before and after upload. The qualified dry selection reports one
8,759,237-byte virtual archive and excludes private environment, Beads, dependency
and artifact paths. This does not physically inspect the remote archive. The
three-file static capsule is explicitly only three immutable public files.
The existing project retains Next.js under `apps/web`, frozen Bun installation
and disconnected Git deployment. The provider's production target is a different
deployment; this operation does not promote production.

Primary live QA passes **26 HTTP / three byte comparisons / four Chromium views**
in 21.406 seconds. A fifth mobile `/moves` view follows the real retry form and
receives 200 on both navigations, preserving the honest unavailable state, in
6.387 seconds. All five screenshots are viewed; browser errors are zero.
Seventeen narrowly identified Next prefetch cancellations are counted separately.
Independent QA repeats the original 26/3/four-view gate in 17.869 seconds with
zero errors and 15 such cancellations. Its four screenshots are viewed by
01:02:46.365 UTC. Provider error/fatal and HTTP 5xx queries each return zero
records over the common complete **00:26:51–01:04:45 UTC** interval, with no more
pages or excluded intervals. The request source quantizes the end to a whole
second; the report uses the actual common interval. These are finite Preview
checks, not deployed Worker or launch proof.

Fresh November 5 reads at **01:08:52 UTC** retain the production and staging
capability bodies (`0.1.0-draft`) and production `/protocol.json` 404. Equality
does not establish provider revision or migration lineage. The separate local
S2 lane opts into two 660-second lifecycle runs and was not executed during
that earlier Preview verification; the subsequent local proof is recorded above.
Its resource flag is distinct from Cloudflare deployment permission. It cannot
replace deployed cron, cache, cost or staging evidence. The sanctioned Workers
Builds pipeline still lacks operator credentials, staging D1 identity/signing
inputs and smoke authority in this session. Reconcile existing resources and
retain a revision/migration/binding receipt; do not provision duplicates or
promote production ahead of staging and S7. Google, hosted screening, provider
storage, cost, the real-harness gauntlet and launch gates remain open.

The filesystem has about 37 GiB free (96% used) at 01:08 UTC, after earlier
29–31 GiB readings. Cause and durability are unknown; no agent cleanup or deletion
is claimed, and the missing historical snapshot is not recovered. Operator
headroom work remains open. Current source/deployment receipts are in
`e2e/artifacts/dae7-repair-20261104/`; independent integration, closure and live QA
receipts share `independent-dae7-9277e917-20261105/`.

### Idle-session recovery — 2026-11-04

The idle sweep already preserved private drafts, but its notice offered no
machine-readable recovery action. Inbox JSON and Markdown now resolve a protocol
notice to the existing session-status read only when the stored session belongs
to its recipient, matches its problem and is closed. One bounded lookup covers
the returned page. The action establishes current closed-session relevance, not
the cause of every generic protocol notice, and grants no write permission.

The old runtime fails the new missing-action assertion in 17.744 seconds. The
final real local Workerd/D1/R2 journey passes in 17.420 seconds: an actual idle
closure produces the notice; the Fellow follows status and hello, opens another
session, discovers the retained draft through its working pack and revises that
same object. Both inbox faces and the successful draft read are private/no-store;
foreign reads return 404. Both cursor reads require HTTP 200 and the existing
integer contract before the original byte comparison. The public face omits
draft bytes and IDs. Five explicitly planted notice-context probes check foreign,
wrong-problem, open, missing and malformed session targets. Existing replay,
follow, critique, search/projection and 74 immutable-trigger checks remain intact,
with 63 transition exclusions reported. Screening and approval are fixtures.

The complete original root run exits 0 in 1,695.588 seconds at 22:34:57 UTC:
eight groups pass, Worker 6,662 tests / 30,632 expectations and Agora 883 / 5,831.
Toolchain has 405 passes and 54 existing skips. The run retains the proper-init,
private PID/proc namespace and default `/tmp` setup. Typecheck and lint pass eight
groups in 100.105 and 43.264 seconds, with existing lint warnings. Full contracts
pass 944 / 6,448; render passes 584 / 5,873. Focused inbox units pass 90 / 414 and
are SQLite-adapter unit coverage. After the root terminal, review tightened only
the native cursor and successful-draft assertions; the affected native gate and
three-file Biome check pass. Runtime and unit hashes are unchanged. The earlier
aggregate did not execute those later native assertions.

Shared `main` acquired commits `a4dba51a` and `811f3b92` during validation, with
all three source hashes unchanged. Neither primary nor verifier issued those
commits; the actor is unidentified. Commit descriptions are not gate evidence.
Default UBS diff/staged commands therefore see an empty change set: actual exit
0, zero files scanned, no code coverage. A supported file-list scan covers all
three committed code changes with default rules and limits, completing in 2.898
seconds: zero critical, seven warnings and 550 informational findings. The seven
reviewed warnings are fail-fast JSON parsing in three test sites and four switch
cases with explicit returns. No suppression is added. This is post-commit feature
coverage, not a retroactive precommit or whole-project security claim.

Independent verification at `811f3b92` passes complete native controls before and
after restoration in 19.690 and 16.186 seconds; the three inbox unit files pass
90 / 414 in 1.036 seconds. Two separate one-site runtime faults reach the intended
foreign-recipient and wrong-problem assertions at native line 1326, exiting 1 in
14.725 and 14.504 seconds. Each restoration audit finishes before the next
mutation/control. The isolated copy restores all 2,466 Git blobs and executable
modes, six dependency directories, eight workspace aliases and 15 physical
identities, with no shared canonical source inodes. Fifteen sampled process births
have retired; 415 unreadable process directories limit host visibility. The
restored-run process observation happened after its terminal, so it supplies no
live PID sample for that run. The primary agent reads the actual terminals,
fault diffs/diagnostics, complete native stage records and restoration evidence.
Independent evidence is under
`e2e/artifacts/independent-idle-recovery-811f3b92-20261104/`.

Original `1e7` remains in progress:
this increment does not establish its full notice taxonomy, DO/outbox or OPS
acceptance. Primary evidence is under
`e2e/artifacts/idle-notice-recovery-20261104/`. Fresh 22:02 UTC public HTTP reads
find the existing Preview home and exact static `AGENTS.md` healthy; both Workers
still serve the September capability bodies, and production `/protocol.json`
returns 404. Required pipeline credentials remain absent. No new deployment,
browser/provider-log check, staging product result or launch acceptance is claimed.

### Claim critique source links — 2026-11-04

A delivered claim critique previously offered only the claim read. Its exact
review or evidence already had a public face, but an agent had to reconstruct
that address from notice prose. Inbox JSON and Markdown now include the exact
source read beside the pinned claim. The lookup binds the causal event, problem,
object kind/version and payload target. Disagreeing fields or a malformed/redacted
stored payload supply no extra link. Digest-label concordance is checked here;
the existing public reader supplies content verification and visibility checks.
Paths are server-authored from complete canonical ID segments. Existing
hypothesis links and inbox paging remain covered. The indexed lookups stay in
the existing bounded query, without a request per notice.

The old runtime fails the new native missing-review-link assertion in 12.218
seconds. The strengthened local Workerd/D1/R2 journey passes in 20.376 seconds:
two actual HTTP review/evidence writes produce notices, both links open anonymous
public faces with the exact source and claim version, and Markdown keeps
`private, no-store`. Five explicitly planted stored-notice probes exercise
mismatched problems/pins and a wrong cause kind; these are synthetic data on real
bindings, not five more production causes. Other recipients cannot read those
private notices. Existing replay, racing delivery, follow/unfollow, revision,
projection/search and immutable-trigger guards are retained. Screening and
sponsor approval are fixtures; this is local product proof.

All eight original root test groups pass in 1,517.951 seconds, ending at
06:48:56 UTC: Worker 6,661 tests / 30,614 expectations across 284 files, Agora
883 / 5,831, and the other six groups pass. The run uses the retained proper-init,
private PID/proc namespace and default `/tmp` setup, not a shared-host repair.
Typecheck and lint pass eight groups in 105.702 and 52.378 seconds, with existing
lint warnings. Separate contracts pass 944 / 6,448 expectations; render passes
584 / 5,873. Focused inbox units pass 89 / 395; their SQLite adapter is unit
coverage. Default UBS completes four changed code files with zero critical
findings, five reviewed existing warnings (strict test-log parsing and switch
cases that return), and 518 informational findings. No suppression is added;
this is not a whole-project security certification.

Independent verification at `72ab0748` passes full native controls before and
after restoration in 20.069 and 30.517 seconds; focused units pass 89 / 395 in
1.162 seconds. Four separate one-site faults all reach their intended native
assertions: remove the review link (14.349s), remove the evidence link (13.330s),
bypass review/problem binding (19.554s), or bypass the claim pin (14.870s). The
tests, data and deadlines are unchanged for these faults.

One intermediate restoration audit **fails and is excluded**: the verifier
started the next mutation before waiting for audit session `34425` to finish.
It then saw a nonempty Git diff and exited 1. The tool observation is retained
as a labeled transcription, not a separately captured stderr file or a passing
audit. A completed two-copy restoration audit after the evidence fault and the
final audits pass; this does not erase the failed attempt. Final copies match
all 2,466 source hashes and Git executable modes, six dependency directories,
eight local aliases and 15 physical identities each. Fifteen observed process
births have retired; 421 unreadable working directories limit host visibility.

The primary agent reads the actual results, fault diffs and restoration evidence,
then reexecutes the full native journey from committed main: exit 0 in 16.256
seconds, including both real causes, five planted probes and all later checks.
Raw primary evidence is under `e2e/artifacts/critique-notice-20261104/`;
independent evidence is under
`e2e/artifacts/independent-critique-notice-72ab0748-20261104/`.
Original `1e7` remains in progress:
full notice taxonomy, DO/outbox and OPS acceptance are not established by this
bounded read affordance. Fresh 06:39 HTTP reads keep the existing Preview home
and exact served `AGENTS.md` at 200; production/staging capabilities remain the
retained September bodies, both `0.1.0-draft`. Required Cloudflare pipeline
inputs remain absent. No new deployment or launch acceptance is claimed.

### Bounded group retirement and the root gate — 2026-11-03

The original `bun run test` at `7601f542` completes: **eight groups pass**
in 1,364.307 seconds, ending at 22:22:31 UTC. Worker passes 6,656 tests and 30,547
expectations across 284 files; Agora passes 883 tests and 5,831 expectations.
Toolchain passes 405 tests with 54 existing skips, 3,995 expectations and 459
cases across 13 files. All other root groups pass. The unchanged Worker dispatcher
includes both `test/unit` and `test/split`, including the S-2, token-lifecycle and
S-3 files. This is local source/unit qualification, with the existing native
process and binding cases; it does not certify hosted or launch gates.

The previous root's two cleanup failures are reproduced with the original
assertions. A temporary observation runs only after the real final census
refuses: in both failing cases, the returned member has already disappeared by
the immediate `/proc` read. The launcher had reaped its direct child, then treated
one stale snapshot as the final decision. That temporary diagnostic is removed
before the repair. The launcher now uses the unused portion of its original six
inspections to establish an empty group, within the unchanged absolute cleanup
deadline. Each cleanup gets its own counter; no signal is sent after leader
reaping. Persistent members and failed inspections still produce typed refusals.

Three new unit cases use real process groups and `pgrep`, then deliberately replay
an earlier member only after the group is actually empty. One stale response must
recover; persistent stale responses and a subsequent observer error must refuse.
The tests also require no more than six total inspections. These planted observer
responses test control handling; the separate original-failure snapshots establish
the natural race. The old runtime fails the intended positive/error assertions;
the repair passes all three cases and both original failures. No old assertion,
timeout, output ceiling or public contract changes.

The full root run precedes a test-only counter correction. Review found that the
observer could omit a count when a real census contained a descendant but no
leader. It now persists the count before every branch, preserving the prior
member and observation state. The runtime is byte-identical to the full-root
snapshot. The corrected three cases pass, and the complete affected toolchain
passes in 116.404 seconds: seed 46 pass, suite 405 pass / 54 existing skips /
3,995 expectations, and the environment-interface self-test passes. No second
Worker aggregate is claimed for this test-only correction.

Before that correction, typecheck and lint pass all eight groups in 67.646 and
34.801 seconds; existing lint warnings and its diagnostic limit remain. The
default source scan
completes both changed code files with four critical matches, 13 warnings and 485
informational findings. All four critical matches are unchanged synthetic token
fixtures or a test label; warnings are existing strict test-output parsing and
awaited helper races. Their source contexts are reviewed without suppression;
the scanner's exit 1 is retained and is not called a clean security result.
Independent execution at `0534ecac` passes the full affected toolchain in 118.247
seconds and, after restoration, 125.338 seconds. Both retain seed 46 pass, suite
405 pass / 54 existing skips / 3,995 expectations and the environment-interface
pass. Focused controls before and after faults each pass five cases and 28
expectations. Four separate one-site runtime faults are retained: stopping after
one nonempty census, accepting nonempty as empty, and omitting the budget
decrement fail their result/observation assertions. The last of those reaches a
typed-result failure before the count assertion, so it earns no counter-oracle
credit. A separate half-decrement fault reaches the actual count assertion:
12 inspections exceed six. No assertion or deadline is changed for these faults.

Both isolated copies finish with all 2,466 tracked hashes and Git modes restored,
six dependency directories, eight local aliases and 15 physical identities each
unchanged. Ten observed process births have retired; 419 unreadable process
working directories limit that census. The primary agent reads the actual
terminals, fault diffs and source/dependency/mode/process audits, then reruns the
five cases from committed main: normal exit 0, 1.890 seconds, 28 expectations.
Raw primary evidence is under `e2e/artifacts/group-reap-x77k-20261103/`;
independent evidence is under
`e2e/artifacts/independent-group-reap-0534ecac-20261103/`.

After the counter correction, typecheck and lint again pass eight groups in
70.289 and 34.995 seconds, retaining existing warnings. Its default diff scan
completes the one changed test file with the same four critical fixture matches
and 13 warnings, plus 234 informational findings; exit 1 is retained.
A read-only refresh at 22:34 UTC gets HTTP 200 for the existing Preview home and
its exact source copy of `AGENTS.md`; the home has its expected title/main and no application-error
marker. This is two HTTP reads, not new browser or provider-log coverage.
Production and staging capabilities also return 200 and the same retained
September body hashes, both `0.1.0-draft`. The five required Cloudflare/staging/
smoke inputs remain absent; no new deployment is performed.

The full run uses the same private Linux process/proc namespace, installed
`docker-init`, UID/GID 1000 and `/tmp` as the failed control. This establishes the
current source gate there. Original `x77k` stays in progress with its historical
diagnosis acceptance intact; older shared-host S-2 scanner/startup and token/S-3
failures remain unclassified where no cause is demonstrated. The existing Vercel
Preview and deployed Worker inputs are unchanged; sanctioned Cloudflare authority,
hosted proof and launch acceptance remain outstanding.

### Artifact review notice status links — 2026-11-03

An actual artifact review decision reached its owner with a QC case target but no
machine-followable next action. The existing private publication-status route
already exposed delivery, review and recovery state. Inbox reads now resolve the
exact immutable case-to-publication binding, constrained by the notice's problem
and authenticated Fellow, and return an `orient` read in JSON and Markdown. One
bounded query enriches only the returned page. Existing contracts validate IDs
and paths; no table, endpoint or write authority is added. The link reads current
state; an old notice is not evidence of a current approval.

The unchanged runtime fails the new native missing-link assertion in 15.700
seconds. The final complete real Workerd/D1/R2 artifact journey passes in 20.374
seconds. It follows the actual decision-produced owner notice, checks both faces
and private/no-store headers, and preserves every earlier consent, recovery,
public-CAS and 93 immutable-guard assertion. A snapshot captured before the first
inbox read proves that these reads do not enqueue, screen, authorize or publish.
Six explicitly synthetic stored-notice probes test five mismatched/malformed
sources and exact selection between two existing cases on the same problem.
These probes are not proof of producer misdelivery or audit-event causality.
The classifier and sponsor identities remain fixtures; storage bindings are real.

Five existing inbox unit files pass 111 tests and 692 expectations. Root typecheck
and lint pass all eight groups in 72.914 and 35.463 seconds; existing lint warnings
remain. The prescribed contracts package command passes 944 tests and 6,448
expectations; render passes 584 tests and 5,873 expectations. At committed
`cba01193`, independent full native controls pass in 21.218 and 44.567 seconds.
Three separate link-omission, Fellow-predicate and problem-predicate faults fail
at the intended native assertions, with exact restoration between each. All
2,466 source hashes and executable modes, dependency identities and aliases are
preserved in both verifier copies. Nineteen recorded process identities retire;
369 unreadable cwd observations limit host scope. The independent 111 inbox
units also pass. The primary committed-HEAD native reexecution passes in 20.847
seconds, with complete old/new assertions and all 93 guards. Original
`1e7` remains in progress; `rhg` remains open after its normal claim is refused
by the open `kl8` prerequisite. No acceptance or dependency is waived.

After external capacity recovery, a complete unchanged shared-host root run takes
2,264.177 seconds: seven groups pass and Worker fails one of 6,656 cases, the S-2
concurrent-capture retained-state `lsof` scan (status 124). Both subsequent selected
comparisons pass, with and without a private PID namespace: this is a null causal
result. A complete pre-change root baseline then passes all eight groups in
1,427.696 seconds, including all 6,656 Worker cases, under a private Linux PID/mount
namespace and private `/proc`. The platform ignores `sudo -E`, so this run also
uses default `/tmp` instead of `/data/tmp`; it is not a one-variable comparison or
a shared-host repair. The next same-environment root run finishes in 1,393.004
seconds: six groups pass and two fail. Toolchain's throwing pipe-cancel observer
and S-3's inner output-overrun case receive `ownership-unproven` instead of
`output-overrun`; Worker passes 6,655 of 6,656 cases. A direct same-options diagnostic
reproduces failure at `final-census`. A second, instrumented observation retains
real `pgrep` results and `/proc` state: the killed Perl target remains a zombie,
reparented to the namespace's non-reaping PID 1. This is a defect in this isolated
test setup, not evidence that the application caused the failures. With installed
`docker-init` (Tini 0.19.0) as PID 1, the original direct control passes unchanged,
including its no-survivor assertion. Full-suite execution with that proper init
finishes at 21:31:07 UTC in 1,567.839 seconds: **seven groups pass and one fails**.
Worker passes all 6,656 cases and 30,546 expectations across 284 files in 1,369.15
seconds. Toolchain has 400 passes, 54 existing skips and two failures: the throwing
ready-hook cleanup and ordinary unit/integration output-overrun diagnostics. The
latter still reports `final-census` ownership unproven. Agora passes 883 tests;
all other root groups pass. `/proc/1/comm` confirms `docker-init`, UID/GID 1000 and
temporary storage `/tmp`. Proper init resolves the observed direct control, but
does not restore the full root gate or diagnose these remaining failures. No test
bound, census requirement or application source changes for this diagnosis.
`x77k` retains all historical failures and
its original full acceptance. Raw evidence is under
`e2e/artifacts/lifecycle-recovery-20261103/` and
`e2e/artifacts/artifact-notice-20261103/`.

Independent capacity checks verify current normal backup/export and the retained
named archives, but cannot locate the historical November 1 full snapshot;
`0oi3` stays open. This work performs no manual file deletion and does not claim
to have caused the recovered headroom. The earlier verified Vercel Preview's
application inputs are unchanged. A fresh November 3 21:25 UTC read returns 200
for its rendered home page and `/AGENTS.md`; the latter exactly matches the
checked-in 3,772-byte static file. The home page has its expected title/main and
no application-error banner marker. This is two HTTP reads and one byte comparison,
not new browser or provider-log coverage. At 21:29 UTC, production and staging
`/capabilities` both return 200 with `0.1.0-draft`, exactly matching their September
SHA-256 bodies (`1844555d…bbc0`, `8e79852b…aa70`). This does not identify provider
revision or prove that no intervening redeploy happened. The new Worker fix has
not been deployed by this work; the five required authority/staging/smoke inputs
remain absent. Sanctioned Cloudflare authority, hosted proof and launch acceptance
remain outstanding.

### S-3 holder lifetime and retained failure diagnostics — 2026-11-03

The S-3 holder fixture could exit after ten seconds while its parent was still
checking it. An unchanged full-file failure retained a persistent holder's ready
and release records 21 seconds apart, with no release acknowledgment. A parent-only
pipe lease now keeps it alive until explicit release or parent loss, within the
existing 60-second case deadline. Release closes the held file before acknowledgment;
lease loss closes it without a success acknowledgment. Saved PID/FD fields reset
per start, and cleanup closes only the matching live coprocess writer.

The fresh helper intentionally retains a named result only after proven cleanup.
Its reader now preserves authentic negative results from the validated unlinked
inode instead of replacing them with an absent-file error. Gate consumers still
refuse unproven cleanup; diagnostics include the validated ownership-failure phase.
No product API, contract, migration or deployed behavior changes in this increment.

The full original root command remains **RED: seven groups pass, one fails** in
2,777.456 seconds. Worker executes 6,656 cases across 284 files: **6,653 pass and
three fail**, with 30,528 expectations. The failures are S-2's concurrent capture
retained-state scan (status 124), startup-watchdog diagnostics, and legacy leader
loss. The latter two retain `spawnSync perl ETIMEDOUT` and captured status 143;
legacy leader loss also reports `S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN`.
Token-lifecycle and S-3 have no failures in this aggregate. Their earlier failures
remain retained; this changed census does not establish all their causes or that
all seven disappeared because of the repair. `asimposiumorg-x77k` stays in progress
with its original full acceptance intact.

The final selected holder case passes all six assertions in 2.224 seconds, while
an unchanged isolated S-2 startup case passes in 8.850 seconds. Typecheck and lint
pass eight groups each. The source scanner completes both code files with zero
critical findings and 14 existing warnings, reviewed without suppression; this is
not broad security qualification. Full raw evidence is retained under
`e2e/artifacts/lifecycle-x77k-20261103/`.

A later independent run at `f8cc3559` fails its first unchanged selected holder
control in 53.523 seconds: `ownership-unproven`, phase `final-census`, cleanup
unproven. The validated negative result survives without an absent-file error,
but the repair remains **unqualified**. The verifier stops there: the planned
delayed-holder, lease-loss, restoration and controlled-inspector checks are not
run. Its source/dependency audit stays exact; all nine observed process births
retire, with 360 unreadable cwd observations limiting host visibility. The inner
negative stream is not retained beyond authenticated outcome and byte counts;
the complete outer streams and audits are under
`e2e/artifacts/independent-x77k-f8cc3559-20261103/`. No acceptance or Bead is closed.

Read-only process observations catch native
`lsof` kernel waits, but do not establish the exact blocking path or explain every
historical failure. An experimental mount exemption crashes installed lsof 4.99.4;
a private official 4.99.7 comparison avoids that particular crash. Both versions
later complete an ordinary scan, so no scanner upgrade or host repair is claimed.
The system binary, test PATH, mount configuration and test deadlines are unchanged.

Primary headroom falls from about 20 GiB to 2.5 GiB during this block. A private
recovery copy in `/tmp/asimposium-x77k-recovery-20261103/` preserves the pending patch,
a consistent 564-issue Beads backup and current evidence; its first aggregate copy
is explicitly a partial checkpoint. `0oi3` remains open and no files are deleted.
Fresh November 3 public probes retain `0.1.0-draft` on production/staging and 404
on production `/protocol.json`. The sanctioned Workers Builds authority and `rs5n`
remain outstanding; local qualification does not establish deployed or launch readiness.

### Inbox expiry and current root-gate failure — 2026-11-03

Inbox reads, unread counts and both acknowledgment modes now honor stored expiry
using one captured request time. Expiry filters before pagination and preserves
rows, retry receipts and cursor allocation. New terminal review outcomes have no
expiry; existing notices retain their recorded deadlines. No contract, endpoint
or migration is added. The unchanged native journey first returns an expired
notice instead of its live successor; the corrected Stoa and matchmaking journeys
pass, as do 168 targeted unit tests, typecheck 8/8 and lint 8/8.

The earlier inbox increment's complete root unit run is **RED: seven groups pass, one fails**. Worker runs
6,656 cases: 6,646 pass and ten fail in unchanged S2, token-lifecycle and S3
process-supervision tests. Failures include watchdog timeout, unproven leader
reaping, a holder inspection mismatch and missing retained child receipts. A
bounded rerun of the S3 holder case also fails. Their causes remain unclassified;
neither an inbox regression nor a host-only explanation has been established.
`asimposiumorg-x77k` owns restoration of the root gate, and `1e7` retains its full
unfinished acceptance. Complete raw evidence is under
`e2e/artifacts/inbox-expiry-20261103/`. The Cloudflare rollout still needs `rs5n`;
these local results do not establish deployed or launch readiness.

### Mounted experiment proof and history decision — 2026-11-02

Source `c7cfa3d795bba709c81ee4c83775b5f070a3a180` adds real native coverage for the
already-mounted `POST /v1/p/:id/discrimination` adapter. Previously its census
entry delegated to the batch writer and explicitly lacked a native route proof.
The existing direct-append journey now calls it, and the census names its canonical
request schema, all authored fields, evidence sink and actual proof. Production
routing, contracts and scientific algorithms are unchanged; this is a local proof
improvement, not a new scientific capability or deployment.

The journey publishes one authored experiment concerning two hypotheses. It checks
contrasting predictions and evidence directions, the exact shared report, public
evidence reads, and model-memory evidence remaining `assertion`/`exploratory`.
Reject, quarantine and provider-unavailable outcomes leave the checked public
ledger, evidence, provenance, outbox count and public R2 keys unchanged. An actual
credential revocation during the fixture screening call rolls back both members;
the revoked retry returns 401 without another screening call. A pass creates
exactly two events, evidence records and immutable screening-provenance rows,
bound through returned sequences and canonical event object IDs. Every work field
is present in the current screening candidate, separately from prior context.
Exact replay returns the original receipt without new events or screen calls;
changed input with the same key conflicts. The final log scan covers the new prose.
Synthetic sponsor setup and classifier decisions remain explicitly local fixtures.

The final primary native journey passes at committed source in **11.620s**.
All **2,427 source blobs/modes** stay fixed through typecheck **8/8**, lint **8/8**,
five required contract groups and original root **8/8 in 1,519.310s**, including
**6,646 Worker and 883 Agora tests**. Default diff/staged UBS complete all three
changed code files in 2.632s/2.582s, each exit 1 with identical one-critical,
three-warning and 147-information findings. The critical match is the existing
deliberate bearer-logging mutation string; warnings flag intentional fail-fast
parsing of test evidence, provenance and screening input. All critical/warning
contexts are read, with no suppression. This is not broader `g4b4` qualification.
All 226 mutation anchors match; that does not mean 226 mutants were executed.
StormyGorge independently records the bounded result in original `b9y9` comment
2729 at `c7cfa3d7`. Complete native control exits 0 in 11.576s; exact current census
passes ten cases/53 expectations, and the registered runner passes one case with
32 explicitly filtered. The canonical-producer direction-loss plant reaches the
intended second-row assertion (`supports` versus `refutes`), exiting 1 normally in
9.208s. Exact restoration is followed by a complete native pass in 11.225s.
Both isolated copies restore 2,466 tracked hashes/modes, six dependency directories,
eight local aliases and fifteen physical identities exactly, sharing no regular
source inodes with main. All nine observed process births retire; 363 unreadable cwd
observations and retained mount warnings limit host visibility. Root read the actual
six terminal receipts, fault assertion and restoration audits. These local results
do not certify the full integration aggregate or provider behavior. Original `b9y9`
remains in progress, including its full field/race criteria and same-revision
staging Workers AI evidence.

Errors remain on record. An ad hoc Bun filter discovered archived verification
copies and intentional mutants: 682 passes, 13 failures and five errors across
695 cases. Its raw tool output was not fully retained; it is not a current-source
gate. The corrected exact-file command retains both streams and passes ten current
census cases. A new assertion wrongly expected an evidence ID inside event content;
that failed native run is retained. The corrected check uses the schema's exact
`events.object_id`/`object_kind` binding and canonical provenance. Review also
strengthened candidate-only field checks, accepted-record deltas and the final
prose-log scan. Early ad hoc metadata-label errors are superseded by the final
genuine Node 24.1/Bun 1.4.4 source/runtime freeze; no production defect is inferred.

The highest ready local reliability item, `123b`, received two bounded controls:
complete science alone exits 0 in 22.559s; science alongside the canonical contract
suite completes with both statuses 0 in 45.524s. This is a current-version concurrency
analogue, not a reconstruction of the historical load or a cause for its lost
route/status assertion. The original failure remains unclassified and the task
stays open. No extra observer framework or repeated probes were added.

`n21x` is independently closed in comment 2726 under its original recommended
leave-history option, selected using delegated operator judgment. Immutable Git
inspection confirms the old commit has 522 checkout-path fields, the corrective
commit has none, and current/staged exports have none. No history rewrite,
force-push, deletion or claim that old objects were scrubbed follows from this
decision. It resolves an operational question, with no product-capability credit.

Fresh public reads at **17:02:37–17:02:39 UTC** still find production/staging
capabilities `0.1.0-draft` with the earlier body hashes, and production
`/protocol.json` returns 404 `ROUTE_NOT_FOUND`. Equal bodies do not identify provider
revision, migration lineage or deployment history. All five local authority inputs
remain absent; `rs5n` stays open for sanctioned Workers Builds authority and staging
reconciliation. The existing qualified Preview has unchanged application inputs;
no fresh backend or launch claim is made. `0oi3` retains its historical-snapshot
uncertainty; `3soe`, `g4b4`, `sbuk`, `2tnr` and the original hosted/provider/launch
criteria remain open. Current raw evidence is under
`e2e/artifacts/123b-science-20261102/` and
`e2e/artifacts/b9y9-discrimination-20261102/`; independent raw results are under
`e2e/artifacts/independent-b9y9-c7cfa3d7-20261102/`. The current ready queue has seven
items and no active dependency cycles. The sanctioned rollout remains the highest
priority; the history decision does not resolve any hosted or scientific gate.

### Native journey cleanup and retention scope — 2026-11-02

Source `059de57e7f6d966f3fb2754913e8e504c086beda` repairs a demonstrated
resource-lifetime defect in the shared local Worker journey. Wrangler's esbuild
service could remain alive after Node exited, even after Workerd closed. The
journey now uses Wrangler's exact builder dependency, observes its actual child
process, and waits for its close event after the last active journey releases it.
It preserves callback errors and leaves the strict outer supervisor and deadlines
unchanged. The new real-bindings regression checks successful work, an exact
deliberate assertion failure and overlapping journeys: an active sibling keeps
its builder, and the last owner retires it. This improves local proof reliability;
it adds no scientific or deployed capability.

The same revision resolves `z226` through its permitted no-feature option. Fable
section 10.5 records that launch account/private-draft erasure has no legal-hold
mechanism. The unused helper input and unreachable route mapping are removed;
receipts already report false. The obsolete unit case is deliberately replaced
with a missing-problem/no-journal case. Existing private erasure, foreign-sponsor
refusal, immutable public-ledger and audit/storage protections remain. Native
journeys add account and draft receipt checks and a published-problem DELETE 422
with unchanged public cursor. No schema, table, URL or legal-hold feature is added.

Primary qualification holds all 2,427 source blobs/modes fixed: typecheck **8/8**,
lint **8/8**, five required contract groups and original root **8/8 in 1,448.577s**,
including **6,646 Worker and 883 Agora tests**. Complete native problem and account
journeys pass in 12.981s and 9.964s; the final three-mode cleanup regression passes
in 27.054s. The registered inventory/cleanup selection passes two cases with 46
explicitly filtered, not a full integration aggregate. All 225 mutation anchors
are valid; that is not execution of 225 mutants. Default diff/staged UBS each
complete nine JavaScript/TypeScript files, exit 1 with three critical matches,
ten warnings and 686 informational findings. Reviewed critical contexts are two
sponsor/Fellow ID comparisons and the existing deliberate bearer-logging mutation
string. Existing stored-JSON/test parsing and initialized Uint8Array warnings are
also reviewed; nothing is suppressed. This is scoped review, not broad security
qualification or closure of `g4b4`.

Retained failures matter: before repair the new regression sees an unclosed real
builder and the owner reports a descendant leak. The first repair omits the child
reference needed to keep Node alive for its close event and exits 13 with an
unsettled await; the corrected implementation passes. A process-only trace of the
original T0 fault shows its builder outliving Node by 62.7 ms, while the instrumented
owner exits normally 1. This does not identify the two historical unrecorded
residuals, reproduce their outer classification, or diagnose `sbuk`/`2tnr`.
StormyGorge independently accepts the original criteria at `059de57e`, covering
the reproduced builder-lifetime gap and repaired retirement of the named domain
faults, and closes only `9tb8` and `z226` in comments 2720 and 2721.
Cleanup, complete problem/account and full dispositions controls exit 0
normally in 27.420s, 13.321s, 10.122s and 16.242s. The 21 retention unit cases pass
165 expectations; registered inventory/cleanup passes two with 46 filtered.
All four one-site faults reach the intended assertions and exit 1 normally:
T0 and weightless review facets (12.828s/12.973s), omitted builder release (8.852s)
and premature sibling shutdown (27.007s). Restored complete controls exit 0 in
15.991s, 15.836s, 27.050s and 27.654s. Assertions and owner bounds remain unchanged.
Both isolated own-Git subjects restore all 2,466 tracked hashes/modes, six dependency
directories, eight workspace aliases and fifteen physical identities exactly;
neither shares source inodes with main. All 29 recorded process births retire and
the final readable-own-cwd census is empty. The 366 unreadable cwd observations
and retained mount warnings limit host-wide visibility. These are actual local
runtime results, not independent reruns of the primary aggregate gates or hosted
proof. The two old unrecorded residual identities remain unknown.

The Vercel Preview below retains identical application inputs and its existing
qualified revision. No new backend deployment follows from these local tests.
`rs5n` remains the highest-priority external gap. Primary capacity remains about
45 GiB through retained work and normal Beads publication now succeeds without
a TMPDIR override. Independent assessment nevertheless finds the older full Beads
snapshot `/tmp/asimposium-beads-full-disk-20261101-1050` absent at its recorded path;
the `1025` snapshot path is also absent, and no byte-verified equivalent is known.
`0oi3` remains open on that retention uncertainty. This is not proof of lost current
Beads records or of a deletion cause. Recovery cause is unknown and no manual
cleanup/deletion ran. Current raw evidence remains under
`e2e/artifacts/9tb8-native-cleanup-20261102/` and
`e2e/artifacts/z226-retention-20261102/`; independent acceptance and raw results are
under `e2e/artifacts/independent-z226-9tb8-059de57e-20261102/`.

The current ready queue has eight items and no active dependency cycles. The next
priority is `rs5n`: configure sanctioned Workers Builds authority, reconcile the
existing staging revision/D1 lineage/binding roles, then retain a staging deploy
receipt before production. `0oi3` retains the snapshot uncertainty above. Local
`123b`, `3soe` and `g4b4` retain their distinct original scientific-control,
production-browser and complete-scanner-coverage criteria; later passes do not
explain their original failures. `sbuk` and `2tnr` retain separate unknown capture
and lifecycle failures. `n21x` requires an operator decision about already-public
history; no history rewrite is authorized here. Google approval, hosted screening,
provider storage, retained cost evidence and G0–G3 launch gates remain open.

### Unlisted visibility, review objections and Preview — 2026-11-02

Accepted source is `43243cf857ada400af94be5a57732f3ee02ad446`. It retains the
previous lifecycle-screening implementation below and clarifies two existing
behaviors under the operator's delegated product judgment. Published unlisted
problems remain public: known-URL reads work and duplicate refusals may name their
ID, while ordinary discovery excludes them. Never-published foreign draft wording
remains private. Completed `refute` and `fails-to-reproduce` reviews contest their
exact claim version even at T0 or without verification weight. Weightless objections
do not change scientific disposition or unlock positive standing; weighted T1+
confirmation remains necessary for `independently-checked`. These are explicit
policy decisions, not newly implemented duplicate or review algorithms.

Fable sections 6.2 and 6.6 and the original served protocol record the choices.
Protocol `0.1.2-draft` keeps all thirteen rule IDs, measures 525/1,000 rules words,
and hashes to `8d21cc0abf30f2ade7a37e618cdf850ac115af11041ba101900399deae209d49`.
The apex static copy matches exactly. The discovery golden changes only that
intentional word count and digest; actual version consumers change explicitly.
Real Stoa HTTP checks verify canonical Markdown, structured semantics, ETags and
the exact protocol version/digest pinned on a newly opened session.

StormyGorge independently closed only `u2fe` and `czbr` at that exact source,
with acceptance-item citations in Beads comments 2711 and 2712. Complete native
privacy, dispositions and Stoa controls pass in 10.751s, 16.034s and 12.000s.
The privacy lane retains private-history/own-draft checks and adds known-URL,
noindex, listing, exact-ID search and public-unlisted duplicate assertions.
Four separate objection cases retain positive tier controls and check actual stored
tier/weight, initial standing and both resulting facets. The unlisted-exclusion fault
wrongly returns 201 instead of 409. The same-sponsor and weightless-objection faults
each fail the intended assertion: `independently-checked` instead of `contested`.
Restored complete controls pass in 9.413s, 16.133s and 16.222s; all 223 registry
anchors pass. Both own Git subjects restore 2,465 tracked files and their dependency
identities exactly. Genuine Node 24.1 is bound by executable, inode and digest.

The review-fault children both exit 1, but their outer supervisor reports
`descendant-leaked`, not normal exited negatives. The original assertions and both
classifications are retained. Subsequent bounded retirement/readable-proc checks
find no remaining owned processes and all 17 observed birth identities are absent;
369 unreadable cwd observations and mount warnings limit host visibility. New open
P2 `9tb8` owns this assertion-failure disposal observation; no residual identity or
cause is established. Restored passes do not explain it. The author's first new
assertion also incorrectly required every contest to make disposition disputed.
That failed run remains: reading the existing scientific fold justified correcting
only the new expectation and strengthening the prior-support/weightless cases.
No original assertion, deadline or acceptance criterion was relaxed. A separate
nonexistent-runner invocation was a retained setup failure that executed zero tests.

Primary canonical verification passes **8/8 root groups in 1,448.329s**, including
**6,646 Worker and 883 Agora tests**; typecheck 8/8, lint 8/8 and five required
contract groups also pass. All 2,426 source blobs/modes remain fixed through these
runs. Default UBS diff/staged scans complete seven JavaScript/TypeScript files,
each exiting 1 with one critical match, 13 warnings and 798 informational findings.
The critical match is the existing deliberate bearer-logging mutation; warnings
are test parsing and a hostile alert fixture. All critical/warning locations were
read, with no suppression. This scoped result does not close broader `g4b4`.
Synthetic screening and sponsor setup are explicitly local, not hosted AI or Google.

The [new Vercel Preview](https://asimposium-ale2dgqhb-dicklesworthstones-projects.vercel.app)
is `dpl_J6gZqUn424cPAYARrYjNRXg6mpAt`, READY with Preview target, Node 24.x and
both provider revision fields equal to `43243cf8`. Project settings retain frozen
Bun installation, disconnected Git deployment and disabled Preview feedback.
Frozen prebuild passes in 55.709s and upload in 15.761s, preserving all 2,426
source blobs/modes. Native dry inspection reports one 22,255,674-byte virtual archive
part and excludes private environment/project files; it is not physical inspection
of a remote archive. The private environment file was tightened to mode 600 and its
directory to 700 without displaying its contents.
Primary and independent live QA each pass 26 HTTP cases, three exact static-byte
comparisons and four Chromium views in 19.487s and 17.115s, with no browser errors.
Both reviewers viewed all four screenshots. Explicit Next prefetch cancellations
remain narrowly classified and separately counted: 17 primary, 15 independent.
Independent QA ends at 05:15:01.025 UTC; screenshot inspection finishes by 05:15:18.
Provider error/fatal and HTTP 5xx queries each return zero records over the complete
**05:12:01–05:16:21 UTC** window, with no excluded intervals or further pages.
This is finite Preview evidence, not a backend or launch guarantee.

Fresh public reads at **05:14:24 UTC** retain production/staging capabilities
`0.1.0-draft` and the previously recorded hashes; production `/protocol.json`
returns 404. Body equality does not identify provider revision or migration lineage.
The Preview honestly shows unavailable ledger data. `rs5n` remains the top blocker:
sanctioned Workers Builds authority, existing D1 lineage/binding reconciliation and
staging evidence are still required. Google, hosted screening, provider storage,
cost and G0–G3 launch evidence remain open. The ready queue has ten items and no
active dependency cycles; `9tb8`, `123b`, `3soe`, `g4b4` and `sbuk` preserve their
distinct unresolved observations. Primary capacity went from 4 KiB free to about
47 GiB without agent cleanup; cause and durability are unknown, so `0oi3` remains
open. No manual deletion, history rewrite, remote push or production promotion ran.

Current evidence: `e2e/artifacts/u2fe-czbr-policy-20261102/`,
`independent-u2fe-czbr-43243cf8-20261102/` and
`independent-preview-43243cf8-20261102/`. Earlier accepted work below remains
historical evidence at its named revision and proof scope.

### Lifecycle screening and Preview — 2026-11-02

Source `b626630f6b99dcd9704b164e3d895fe7c1d23d31` closes a demonstrated P7 bypass:
an eligible retirement under a reject decision previously returned 200, bought no
screening call and changed public scientific state. Public sponsor resolution,
retirement and merge now screen the complete parsed action, including every nested
no-claim boundary and mapping key/value. Existing scientific admission precedes paid
screening; sponsor authorship, atomic provenance and exact replay remain intact.
Stored governance targets are checked on removal as well as addition. Sponsor refusals
leave Fellow moderation posture unchanged; existing quota accounting may still charge
the source Fellow, so this does not establish budget isolation.

StormyGorge independently closes only `78dv` then `ux6q` at that exact revision,
citing original acceptance and `file:line` in Beads comments 2702 and 2703. The complete
native screening journey includes an earned scientific resolution as well as retirement
and merge, all policy holds and successful one-event/provenance/replay paths. It passes
in 27.875s; complete governance passes in 12.267s; the census passes 10 tests/53
expectations. The actual registered publish-only fault fails at its original reject
assertion, not setup. These are genuine local Workerd/D1/R2 bindings with explicitly
synthetic screening and sponsor identity, not hosted AI or Google.

The G0 repair initializes Bun's lazy stderr descriptor before the ownership baseline;
the original strict socket count remains and complete socket identities are also
compared. All original deadlines and cleanup assertions remain. Independent cold-stderr
and real post-baseline TCP-listener faults fail the intended count assertion; the latter
adds a new socket inode. Full G0/registry passes 71 tests with one existing skip;
canonical toolchain passes its 46 seed cases plus 402 cases with 54 existing skips.
Both isolated subjects restore all 2,465 source blobs and dependency identities.
Readable final process/FD checks are empty, with explicit host-visibility limits.
The original unrecorded third descriptor and interrupted-capture causes remain unknown.

Primary full root verification passes **8/8 groups in 1,510.94s**, including
**6,646 Worker tests and 883 Agora tests**. Fresh typecheck and lint each pass 8/8;
five required contract groups pass with two existing policy skips. All 2,426 source
hashes remain fixed through those runs. The first full root remains retained as 7/8 red:
the expanded screening predicate broke an old mutation anchor, and the old socket
census failed without recording descriptor identities. The anchor is repaired and
the new diagnostic case specifically requires its own output marker. Default UBS diff
and staged scans each complete all 10 selected JavaScript files, exiting 1 with
5 critical findings, 136 warnings and 1,187 informational findings. Every critical and
warning location was reviewed; critical matches are an intentional bearer-logging
mutation, public-ID comparisons and browser pathname/status assertions. No rule was
suppressed. This does not replace the missing broader `g4b4` coverage.

The new [Vercel Preview](https://asimposium-3lnak184p-dicklesworthstones-projects.vercel.app)
is `dpl_SXgomHdpd96xgP9pTvEJ68swuzZf`, READY with Preview target, Node 24.x and
both provider revision fields bound to `b626630f`. Its frozen prebuild passes in
107.140s; all 2,426 Git blobs/modes remain exact. Native dry inspection reports one
22,262,308-byte virtual archive part and excludes private environment/project files;
this is not physical inspection of a remote archive. Upload passes in 23.196s.
Primary and independent live QA each pass the original 26 HTTP, three exact static-byte
and four Chromium checks in 23.128s and 16.709s, with no browser errors. Both reviewers
viewed all four screenshots; 16 primary and 18 independent explicit Next prefetch
cancellations retain their narrow original classification. Independent QA ended at
03:34:32.889 UTC; screenshot inspection finished by 03:34:54. Provider error/fatal and
HTTP 5xx queries return zero records over the complete common window
**03:26:37–03:36:58 UTC**, with no excluded intervals or further pages. Request logs
round the end to whole seconds; the retained review uses that common window. This is
finite delivery evidence, not an all-time or backend-readiness guarantee.
An earlier build capture ended 143 before a receipt and lost its legacy adapter's
buffered streams; no upload occurred and its unchanged export is retained. A fresh
export with direct raw files and signal tracing supplies the successful result.
Neither later success nor empty accepted signal traces diagnose the earlier captures.
`sbuk` retains all four unclassified capture interruptions, including a build interrupted
despite a short session-poll interval; no polling-gap cause or universal workaround is
claimed. Complete accepted raw streams and terminal receipts remain distinct from the
interrupted attempts.

Fresh public reads at **03:33:29 UTC** still show production/staging capabilities
`0.1.0-draft` with the previously recorded body hashes, and production `/protocol.json`
returns 404. Body equality does not identify deployment revision or migration lineage.
The Preview correctly shows unavailable ledger data; it does not deploy the Worker.
`rs5n` still requires the existing sanctioned Workers Builds staging rollout and
operator reconciliation of D1/binding roles before production. Parent `b9y9` retains
its original full field/race and same-revision hosted-screening acceptance. The
disclosure-click cause (`3soe`), broader scanner gap (`g4b4`), provider/Google/corpus,
third-harness, retained cost measurement and launch gates remain open. Two complete
209-check browser controls in this continuation do not diagnose the disclosure flake.
At 03:42 UTC primary headroom is down to 4.7 GiB, below the existing 5 GiB target;
`0oi3` remains open. Retained evidence and both original peer WAL directories are
preserved; no manual cleanup was performed. The refreshed ready queue has 11 items
and no active dependency cycles, led by operator deployment and capacity work.

Evidence is retained under `e2e/artifacts/ux6q-lifecycle-screening-20261102/`,
`independent-ux6q-78dv-b626630f-20261102/` and
`vercel-ux6q-b626630f-20261102-traced/`, with independent live QA in
`independent-preview-b626630f-20261102/`. The earlier accepted integration and Preview
below remain historical evidence with their own exact revisions and scope.

### Combined source and Preview — 2026-11-02

The accepted Preview source is `28ffa1a5316d4469e794cf0d63b1e2bfbd2ebe63`.
StormyGorge independently closes only `ghr3` at 00:28 UTC, citing all original
acceptance items in Beads comment 2694. The candidate is committed on local main;
no remote Git push or production promotion was performed.
An ordinary merge preserves both main histories and integrates 22 remote product
commits through migration 0129. This connects scientific Markdown/KaTeX, current
sponsor directives and discovery, public scientific needs, warning/off-scope notices,
premise health, cursor caching, artifact retention/review and evidence-pinned
concessions with the previously qualified local safety repairs. No alternate stack,
new provider or changed ADR was introduced.

The integration fixes expiry-clock propagation, immediate cleanup ownership after
timeouts, JSON-schema bindings, active-directive API discovery, and an actual D1
expression-depth failure. A separate cursor repair rejects ineligible request shapes
before reading bindings. Existing native session-close proof now includes mixed
creation and saved public revision, exact replay, retained prior versions/premises,
private R2 archives, stale-member atomic refusal and private handback recovery.
The retention lane now probes its required immutable delete guard. Six other new
review/release and concession guards are explicitly unprobed; their original
`rhg` and `3b9` feature acceptance remains open.

Independent exact-revision results, retaining original assertions and bounds:

- Complete root dispatcher: **8/8 groups PASS, 1,545.21s**. Worker: **6,646 pass,
  0 fail, 30,411 expectations across 284 files**; Agora: **883 pass, 0 fail**.
  The toolchain retains its 54 existing test skips.
- Typecheck **8/8**, lint **8/8**, required contract groups **5/5**, plus two
  existing policy skips.
- Five genuine local Node 24.1.0/Workerd/D1/R2 journeys pass: Stoa, content-hide,
  extended session-close publications, moderation, and artifact staging retention.
- Original production Agora browser: **209/209 checks**, 233.718s; all four axe
  reports have zero violations. Synthetic sponsor sessions and fixture screening
  are explicitly local substitutes, not Google or hosted screening evidence.
- Both original privacy mutations and disabled retention guard fail their intended
  assertions. A reconstructed direct real-D1 comparison completes all four original
  table renames under grouped SQL; original flat SQL fails the first rename at depth
  100 in `artifact_publication_review_authorized`. This is direct SQL proof, not a
  second complete browser pass. All 1,551 ordered non-parenthesis SQL tokens match.

The new [Vercel Preview](https://asimposium-c1qnpcfv9-dicklesworthstones-projects.vercel.app)
is `dpl_8VJMFoLwoL9Vm9ftPJ3sJWGJ3SKj`, READY on Node 24.x. Official provider
readback binds both revision fields to the accepted source. The frozen prebuild
passes in 60.995s; all 2,426 exported Git blobs remain exact. Native dry inspection
records the virtual archive plan and ignored private environment/project files;
it does not claim physical inspection of a remote archive. Primary and independent
live QA each pass the original 26 HTTP/three static-byte/four Chromium checks,
including protocol P1–P13, version `0.1.1-draft` and digest `6822c855362e774f…`.
Both reviewers inspect all four screenshots. Browser errors are empty; 17 primary
and 18 independent explicit Next prefetch cancellations are separately retained.
Provider error/fatal and HTTP 5xx queries return zero records over the complete
finite window **2026-11-02 00:15:04–00:20:23 UTC**, after independent QA,
with no excluded intervals or further pages. This is not an all-time guarantee.

Retained failures limit these results. Two earlier combined-source root runs were
red; their observed failures and incomplete censuses remain recorded. A borrowed
dependency browser setup failed before any checks because Turbopack fenced its
external realpaths. A fresh own-root frozen install preserves all source/lock bytes
and matches 502 package manifests; its full browser control passes. The whole-browser
flat-SQL counter then stops at 90 checks on the recurring no-JavaScript source-click
timeout, before reaching SQL. Ready/loaded/visible/no-animation diagnostics do not
establish its cause. **`3soe` remains open and unexplained**. **`g4b4` remains open**:
complete narrow diff/staged scans do not supply missing broad JavaScript/ShellCheck
coverage, and their reviewed test findings do not constitute clean security proof.

All three verification subjects restore 2,465 source blobs and their dependency
identities exactly. All 53 recorded process births and 11 known groups retire;
382 unreadable host process entries prevent a whole-host claim. Raw source checks
and the bounded verdict are retained in
`e2e/artifacts/independent-ghr3-28ffa1a5-20261101/`; deployment/build/live/provider
receipts are in `e2e/artifacts/vercel-ghr3-28ffa1a5-20261101/`, with independent
live QA in `e2e/artifacts/independent-ghr3-preview-28ffa1a5-20261102/`.

The largest remaining gap is deployment of the current Worker. Honest public reads
at **2026-11-02 00:25 UTC** still return production/staging capabilities
`0.1.0-draft` with the previously recorded body hashes; production `/protocol.json`
is still 404. Identical bodies do not prove migration lineage or the absence of
intervening deployments. The Preview correctly discloses unavailable ledger data.
`rs5n` requires authority for the existing sanctioned Workers Builds pipeline and
operator reconciliation of existing D1 lineage/binding roles, followed by staging
before production. Do not substitute a manual Worker rollout or duplicate resources.
Live Google approval, hosted screening/census, the protected hard-reject corpus,
provider R2/lifecycle proof, the third fresh harness, retained S-2 cost measurement
and G0–G3 remain incomplete. The optional Rust CLI and complete historical 335-case
suite are not certified by these selected current-source checks. Earlier shell and
missing-output investigations (`dae7`, `l6hr`, `jqqg`) retain their original limits.
Primary storage headroom has returned but is declining and its cause/durability
remains unverified (`0oi3`). No agent cleanup was performed to recover this capacity;
the earlier storage-daemon deletion incident remains recorded below.

### Implementation follow-up — checks through 2026-11-01 UTC

The corrected protocol revision `aa3da072d1e2a358db927c6a4acd7d08e17cd610`
is independently accepted. All eight root groups pass in 1,388.90s, including
6,414 Worker tests / 27,787 expectations and 874 Agora tests. Independent
typecheck/lint each pass all eight groups; all five required contract groups
pass with two existing policy skips. The complete registered native Stoa journey
passes on genuine Node 24.1.0 and real Workerd/D1/R2 in 12.250s. A P1/P3
title-and-body swap preserves all thirteen IDs, version and digest consistency
but fails the intended native P1 assertion; exact restoration passes the source
and dependency audit. The verifier closes only `h4e5` (comment 2686).
Receipts and per-acceptance file references are in
`e2e/artifacts/independent-h4e5-aa3da072-20261101/acceptance.json` and its
`h4e5-acceptance-comment.md`. All twelve recorded births and three known groups
retire; host/FD visibility remains partial. The earlier failed run stays retained.

The next task, `ghr3`, reconciles local main with 22 additional remote product
commits at `260d23f9`. These include scientific Markdown, sponsor instructions,
public needs, warning notices, artifact recovery and six migrations through
0129. Read-only merge review finds 21 conflicts and no file deletions. Both
histories and their safety checks must survive; the combined runtime needs fresh
acceptance and a new Preview. No prior root or 335-case proof transfers wholesale.
Fresh 19:48 UTC public reads still show unchanged old production/staging
capabilities and production `/protocol.json` returning 404; the Cloudflare rollout
remains operator-blocked. The existing Vercel Preview remains reachable.

Combined-source primary validation now executes the product paths: 726 affected
units pass, as do the five selected real Workerd/D1/R2 journeys, the six-attempt
scripted local gauntlet with its expected failures, and a 209-check production
Agora browser run. The latter precedes two small accessibility repairs. All 944
contracts-package tests and all 17 discovery-generation tests pass; five required
root contract groups pass. Independent final-revision acceptance remains pending.
The merge repairs lost expiry-clock propagation, late cleanup work, JSON binding
drift, D1's expression-depth limit, and missing active-directive API discovery.
It preserves both histories, native fault checks and original limits. Failed
captures remain in `e2e/artifacts/merge-ghr3-origin260d-20261101/`.
One production browser click timed out before a later complete pass; its cause
is unclassified (`3soe`), and neither the diagnostic catch nor the later pass
is claimed as a fix. No selected local result establishes the full integration,
provider, Google, staging, cost or launch gates.

At exact `7e6d1ed279805dd372998203e7b5c7b07b5cfb9a`, the independent verifier
completes the canonical root suite: **8/8 groups pass in 1,384.37s**, including
**6,414 Worker tests / 27,786 expectations** and **874 Agora tests / 5,779
expectations**. All five required contract groups pass in 27.88s, with two
pre-existing policy skips. A separate normal S-6 run passes its local stages and
correctly exits 78 on external requirements. The intended journal-classification
counterexample fails its original assertion; exact restoration passes. The
verifier closes only `oev4`. Receipts are in
`e2e/artifacts/independent-final-7e6d1ed2-20261101/`.

The original protected-shell positive control fails before any FD mutation;
`dae7` and `l6hr` therefore remain open. One diagnostic-only copy records an
invalid child record and settled terminal EOFs, but has a different failure set.
Those observations do not establish the original cause. No additional changes
were made to the closed S-6 spike. The older `jqqg` missing-output cause also
remains unknown despite the later passing root run.

Product correction `h4e5` fixes the canonical protocol's twelve stale rules,
whose IDs disagreed with Fable and the actual validator. Fresh original text now
covers P1–P13, including independent review and synthesis anchoring, at draft
version `0.1.1-draft`. Human and machine faces derive from that same text. The
existing real Workerd/D1/R2 journey verifies Markdown bytes, JSON rule identity,
conditional GETs and the exact version/digest pinned by a new session. Primary
protocol/contracts/render/Web/Worker-contract, root typecheck/lint and native
journey checks all pass with 2,364 non-Beads regular source hashes stable.
Independent full-root acceptance remains pending; this does not upgrade the
old hosted Worker or satisfy staging/launch gates.

That first protocol root run at `dc2af896` is red: the discovery byte oracle
finds only the well-known document's old rule count (534 instead of 493) and
old protocol SHA. It is stopped through the owned root's pidfd after 1,334.73s,
with only toolchain and Agora completed; no Worker terminal census is available.
Both 2,403-blob copies and all dependency identities remain exact, and all nine
recorded births and three known groups retire. Host FD visibility is partial.
The two intended metadata fields are manually updated, without regenerating
other goldens. A source search also corrects two legacy in-process helpers'
remaining twelve-rule/version assertions. Those helpers are source/unit proof.
The failed receipt remains in
`e2e/artifacts/independent-h4e5-dc2af896-20261101/root-acceptance-failed.json`;
the corrected revision still requires full independent acceptance.

The corrected discovery file passes all 17 cases and 1,336 expectations. The
legacy served-text helper additionally needed exact CC BY Link expectations
and an assertion preserving the human `/protocol` page beside its agent
redirects. Its standalone command passes all 55 checks (source/in-process,
not E2E). An optional capture adapter first hit its own 64 KiB stream ceiling;
that retained overrun is distinct from the original standalone command, whose
67,929-byte stdout and empty stderr are retained. No product, dispatcher or
native-gate ceiling changed. Corrected canonical typecheck/lint pass all eight
groups in 66.576s and 34.093s, with all 2,364 regular source hashes stable.

The new independently checked Vercel Preview at
`https://asimposium-g3i8q6mje-dicklesworthstones-projects.vercel.app` is READY at
`7e6d1ed2`: 26 HTTP checks, three static byte comparisons and four actual Chromium
views pass with zero browser errors. All four screenshots were inspected.
Explicit Next prefetch cancellations remain separately recorded. Finite provider
error/fatal and request-5xx queries through 17:55:31 UTC contain zero records,
with no excluded intervals or further pages. The project's install command is
now `bun install --frozen-lockfile`; a fresh build preserves every exported source
blob. An earlier unfrozen build's lockfile mutation and rejected dry-run flags
are retained, and neither attempt uploaded a deployment. This is Preview only;
the old Worker still makes ledger views explicitly unavailable.

The following paragraphs retain earlier failed runs and their narrower evidence.

The subsequent independent run at exact `a5f9c6bf` exposes a concrete defect
introduced by the diagnostic change: the journal regression deliberately
accepts a malformed-journal validator's exit 1, but the new low-level record
labels that expected outcome `status:"fail"`. The unchanged combined-stream
failure assertion correctly rejects it. The subject itself exits 0 and emits
all three required pass records. Wire finishes **6,413 pass / one fail /
27,786 expectations / 6,414 tests / 274 files** in 1,195.25s. The outer root
is stopped through its pinned process identity at 1,330.81s, exit -SIGINT,
after only two completed groups; the other five groups never execute. Sources
and dependencies remain exact, all seven recorded identities retire, and
owned groups/cwd are empty. The FD census remains partial because of ambient
mount warnings. No contract/fault gates or closures follow this failed run.
Receipts are in `e2e/artifacts/independent-final-a5f9c6bf-20261101/`.

The correction marks only those low-level observations as
`record_type:"diagnostic"`. Numeric exit/signal/deadline/cleanup facts,
stderr retention, return values and the original blanket failure assertion
remain intact; there is no journal-specific exception. Thirteen focused cases,
including that original journal assertion, pass **73 expectations in 25.105s**.
Current typecheck and lint each pass all eight groups in 64.444s and 34.500s,
with all 2,364 checked non-Beads regular source hashes stable. Independent
full-root and causal reversion checks remain required. This concrete new
classification defect does not explain the older `9c6bb6e6` failure below.

The newest independent canonical root run at exact `9c6bb6e6` completes all
eight groups in 2,491.17s: **seven pass, one fails**, exit 1. Agora passes
**874 tests / 5,779 expectations** independently. Wire reports **6,412 pass /
one fail / 27,761 expectations / 6,413 tests**. Its sole failure is the S-2
file-URL refusal: exit 1 is correct, but the required
`import-escapes-repository` record is absent; both raw streams are empty.
The inner cause is **unknown** (`jqqg`); elapsed time alone proves no timeout.
Source and dependency identities remain exact, recorded process identities
retire, and no owned FD holders are observed. Ambient `lsof` stderr makes
the FD census partial. No remaining contract/fault gates or closures follow
that failed root run. Receipts are retained under
`e2e/artifacts/independent-final-9c6bb6e6-20261101/`.

The unchanged focused file-URL and eight-case syntax probes pass. A traced
whole-file probe stops at a different lifecycle-cleanup assertion before the
file-URL case, so it does not reproduce or explain the original failure.
Source review independently confirms a diagnostic-loss path: the bounded
capture masks every child failure as 1, and its closure caller returns
silently. The narrow repair emits fixed stderr metadata for actual child
exit/signal/deadline and capture status, excluding arguments and captured
bytes. Return values, partial-output discard, deadlines, cleanup and the
original refusal assertion remain unchanged. Twelve focused cases pass
**64 expectations in 24.475s**, including real timeout and withheld-reap
controls, both permitted syntax cases, and a native child-exit/signal control
that verifies decimal timeout reporting and private-output discard. Current
typecheck and lint each pass all eight groups in 68.447s and 34.211s, with
all 2,364 checked non-Beads regular source files unchanged during execution.
This proves diagnostics, not the original cause or a product-flow completion;
full qualification remains open.

The protected independent run at exact `6eb59b07` qualifies the original local
preflight: **335 pass / 0 fail / 1,755 expectations / four files**, 3,841.62s.
The actual downstream `S2_REAL_BINDING_PROOF_BLOCKED` and
`SUITE_NOT_IMPLEMENTED` exit 78 remain blocked, not a whole-integration or
launch pass. Both 2,402-file copies, six dependency directories, eight aliases
and fifteen physical identities remain exact. All twelve recorded process
birth identities retire, the four known groups are empty, and the owned
temporary directory has no FD holders or diagnostic stderr. Host visibility
is partial (363 unreadable cwd entries, five stat entries). Raw logs,
`integration-acceptance.json` and the source/process/FD audits are retained
under the protected verification ancestor described below and byte-exact in
`e2e/artifacts/dae7-native-20261101-0528/oev4-and-independent-6eb/`.

The following unfiltered root run passes the toolchain group in 228.99s, then
Agora reports **872 pass / two timeout failures / one unhandled error / 5,772
expectations / 874 tests**, 82.65s. Both gate-status unit probes exceed their
30-second limits while invoking the real compiler; a dangling-child cleanup
then returns 143. This establishes no compiler diagnostic or leaked path.
The run is deliberately interrupted before completing Wire; the other five
groups do not execute. `root-cancellation.json` explicitly supersedes the raw
capture's last `running` status. Source/dependencies stay exact, recorded roots
retire and the owned FD audit is empty; host visibility remains partial.

New blocker `oev4` owns that narrow repair. On the unused frozen copy, the
unmodified cold compiler passes in 36.579s, exceeding the unit's 30-second
bound; the existing shipped-tree contract gate passes in 3.680s (50 tests,
410 expectations). The generic success and record-scrubbing probes now use
that real gate, retaining the original bounds and assertions and adding
suite/tool/nonempty-test checks. Full compilation remains a separate required
gate. The complete primary Agora suite passes **874 tests / 5,779 expectations**
in 32.29s; all 2,403 tracked source hashes remain unchanged during execution.
An isolated cookie-domain mutation makes the actual contract gate return 1
and a `fail` record at the intended host-only checks. Exact source and all
fifteen dependency identities are restored, and the restored gate passes.
These are structural contract/unit controls, not Google or browser proof.
Current root typecheck passes **8/8 in 240.207s** and lint **8/8 in 108.770s**;
inherited diagnostics remain retained. The capture wrapper's repeated-hash
loop adds evidence-processing overhead after each command, not gate duration;
subsequent captures must compute that comparison once. Final independent
full-root and remaining causal-fault qualification are still required.

The latest primary S4/S7 repair passes the complete affected auth file:
**125 pass / 0 fail / 591 expectations** in 179.834s; its automatic native gate
passes in 178.382s. The lifecycle matrix starts
after all migrations and the migrated parent's listener are ready; its existing
join now follows the local self-checks and still precedes the final FD census.
Fresh ports, keys, state, all six mandatory outcomes and the same inherited absolute work
deadline remain; no deadline, quota, assertion, query or parser was relaxed.
All 2,402 working source hashes remain unchanged during the run. This is primary
proof; final independent full integration/root/fault qualification is pending.

At exact `6eb59b07`, independent strict parent interruption cleanup passes in
65.542s: actual HUP exits 129, all 740 recorded PID/birth identities retire,
both API ports rebind, and three state directories have no FD holders. Source
and dependency identities are intact at that gate. Its retained standard-library
driver and raw receipts remain valid; the new protected run reuses that proof.

The subsequent unfiltered integration terminates **262 pass / 73 fail / 335
cases / 1,672 expectations** in 598.787s, but is environment-contaminated.
The first native case cannot import Wrangler; both verification subjects'
Worker dependency directories have disappeared. The pre-existing root
`sbh.service` activity log records successful deletion of those exact two paths
at 11:26:47.483Z and 11:26:47.499Z, matching the observed parent ctimes. This
does not establish 73 product defects or a qualified integration result; no
downstream S-2 probe ran. Source hashes remain exact, and recorded processes
and owned FDs retire. This diagnosis applies to this run only, not older lost
diagnostics or separately observed deadline failures.

The daemon's native `.sbh-protect` control now excludes the project, retained
evidence/backups and `/tmp/asimposium-protected-verification-20261101`.
Read-only root scanner receipts show zero scanned directories, entries or
candidates beneath the canonical project and new verification ancestor.
Writing canonical marker contents and optional sacred-path registration hit
ENOSPC; the markers and actual scanner exclusion are nevertheless verified.
No daemon shutdown, global configuration rewrite or manual deletion occurred.
Fresh exact-source subjects under the protected ancestor start the original
unfiltered suite at 11:55:17 UTC, with unchanged bounds and assertions; its
qualified result is recorded above. The old
contaminated subjects remain untouched. Receipts are retained privately under
`/tmp/asimposium-storage-actor-20261101-1135/` and the protected verification
ancestor; source/dependency/process audits accompany the original gates.

The latest change retires a redundant fixture-setup runtime from each of three
DB-backed lifecycle leaves. The pinned Wrangler SQL splitter still reads the
checked-in 0003 migration; each leaf's existing local-only Worker applies those
statements through its real D1 binding before the signed warmup. The full parent
supplies no setup flag and retains all 123 migrations and its pre-migration 503.
Setup promises, rather than nonces, are memoized; a restarted Worker keeps its
persisted table and nonce rows. This is local fixture provisioning, including
DDL before authentication when the operator supplies that flag. It is not a
production route, an authenticated business write or a deployed-binding claim.

The ordinary ownership leaf passes with accepted signed warmup and physical
cleanup: original setup 16.146s, revised setup 13.841s. This small pair does not
establish a speedup or reliability rate. The initial direct-exec prototype fails
500 in 11.422s and is retained; its exception was not captured. The revised
version uses the existing splitter/native-batch pattern. After the complete
125-case positive, replacing only the nonce fixture with `SELECT 1` produces
the intended real warmup HTTP 503 in 13.823s, rather than a fixture-read error.
Cleanup passes; the exact original migration and all 2,402 before-control hashes
are restored. Source review finds no concrete proof dilution; original exact
independent qualification remains required.

At `68a93372`, the strict parent-HUP gate passes on Bun 1.4.4 in 74.713s:
HUP reaches the actual nested stopped-checker/live-Workerd checkpoint, the parent
exits 129, all 818 recorded PID/birth identities retire, both API ports rebind,
and three state-directory FD checks are empty. The retained driver uses only
the standard library. The subsequent full integration is red at the matrix
deadline in 191.041s: parent local checks pass, but only five of six required
helper outcomes complete. The run is intentionally stopped (tool 1 with Ctrl-C),
with no complete 335-test census or downstream S-2 result. Both 2,402-file copies
and dependency identities remain exact; all eight recorded integration process
identities retire and the owned FD census is empty. Host visibility remains
partial (363 unreadable cwd and five stat entries). The HUP result qualifies
that source only. Receipts:
`e2e/artifacts/independent-l6hr-68a93372-20261101/`.

Primary storage is now a separate operator task, `0oi3`: ext4 is full and Beads
publication can fail for lack of temporary space. The full Beads directory and
both JSONL generations are preserved in private `/tmp` snapshots. A doctor
inspection-copy failure was initially labeled corruption; with `TMPDIR=/tmp`,
the database audit is healthy with zero anomalies, while existing warnings
remain. Database/JSONL counts and comments were reconciled before another flush;
no rebuild or deletion occurred during that recovery. Subsequent publication
again exhausts primary space. New large runtime state uses the separate `/tmp`
filesystem; that workaround does not restore durable primary headroom.
At 12:05 UTC, 103 MiB has returned without manual cleanup by this session.
That permits another small metadata publication attempt, not normal operating
headroom. The latest database has 554 issues; publication must reconcile that
generation rather than reuse an older 553-row certificate. A byte-verified
archive preserves the proposed generated-cache cleanup target, but deletion
remains unapproved and has not been performed.
The subsequent sanctioned flush succeeds with `TMPDIR=/tmp`: 554 issues,
812 dependencies, 23 labels and 2,669 comments are exported, the five updated
issues' dirty flags clear, and the sanitized public JSONL plus its two
certificates are staged. This resolves publication for that generation, not
the primary-storage task or the pending product gates.
The post-publication doctor reports a healthy workspace/database and zero
reliability anomalies. Its exit remains 1 for retained temporary generations,
ignore-pattern warnings and the externally blocked third-harness task; it is
not a clean-doctor pass. The staged export contains all 554 rows and 2,669
comments with zero local `source_repo_path` fields.
The next generation adds `oev4` and its two dependency edges: 555 issues,
814 dependencies and 2,669 comments. A later reservation and backup write
again hit ENOSPC; the new unit fix, index and complete tracker are preserved
privately, with exact before/after database, WAL and JSONL hashes. At 13:49
UTC the filesystem reports 109 GiB free without manual cleanup by this
session. The cause of that external recovery is not established. The failed
empty verifier backup is repaired byte-for-byte from its preserved original;
the reservation is checked and reacquired after headroom returns. No cache
deletion occurred. Storage closure still requires independent verification.

The join change follows another independent red at `1e84de9e`: automatic auth
fails in 186.609s. All real auth/restart checks and all six nested outcomes
complete, but the parent then reaches its work deadline before the pre-exec
fault checks. Retained phase files show parent restart completion at 09:51:53
and helper completion at 09:52:18 UTC; these are observed waiting intervals,
not CPU attribution. Moving only the join lets the same local checks run
during that wait. A different agent's source review finds no concrete FD or
ownership regression; actual final-runtime overlap cleanup still needs HUP
verification. No deadline, process count, outcome or assertion was removed.
The stopped integration is partial (tool 1 with Ctrl-C), with no 335-test
census or S-2 probe. Both 2,402-file copies and dependency identities remain
exact; all 24 recorded process identities retired and the owned FD census is
empty. Host visibility remains partial (363 unreadable cwd and five stat
entries). The private failure capture works: 0700 directory, 0600 files,
34,808 stdout bytes and empty stderr. Receipts:
`e2e/artifacts/independent-l6hr-1e84de9e-20261101/`.

At `1dddd0f7`, the next independent integration progressed beyond auth and
stopped at a scientific fixture's actual search-window 409. This was another
deliberately cancelled partial run (tool 130), not a complete 335-test census
or downstream S-2 result. Both copies retained all 2,402 exact source hashes;
all ten recorded PID/birth identities retired, the owned group was empty and
no owned temporary-root FDs remained. Host visibility was partial (367
unreadable cwd and five stat entries). Receipts:
`e2e/artifacts/independent-l6hr-1dddd0f7-20261101/`.

Two existing scientific fixtures now recover only exact production refusals.
The asynchronous index poll retains its original 80-attempt budget and still
requires both revised claim statements in a real 200 search page. The
concurrent revision/review wave retains both first attempts; only the precise
P9 changed-reference 422 permits a fresh version-pinned pack and one retry of
the unchanged review body/key. The refusal must write no review event or
replay; eventual publication must write exactly one of each and remain pinned
to version 1, leaving the new head open. All subsequent historical, withdrawal
and privacy assertions remain. No production guard, quota or deadline changes.

The full selected registered science case passes in 89.802s, including a
natural search 409 and the native changed-window decoder probe. A separate
controlled interleaving exercises the actual review 422 and recovery, then all
later scientific assertions, passing in 83.851s. Its temporary scheduling
control was removed. That control first caught a new fixture mistake: using
session-status `public_cursor` instead of canonical pack `cursor`; the failed
65.122s receipt is retained. All 2,402 source hashes remain unchanged within
each run. These primary controls are not an independent aggregate pass or a
diagnosis of the older opaque `123b` failure. Receipts remain under
`e2e/artifacts/dae7-native-20261101-0528/`.

The different verifier closed only `y029` after checking the actual Preview
HTML and exact application-input parity. `dae7` and `l6hr` remain in progress;
provider lifecycle, Worker deployment, Google approval and G0 remain open.

That repair follows a fresh independent failure at `a3ea2958`: automatic auth
exits 1 after 159.872s. The original wrapper discarded its captured streams,
so the first parent cause and a secondary nested KILL-versus-reap subcondition
remain unknown. The known-red integration was deliberately stopped through its
owned exec-session cancellation to prioritize diagnosis. Tool exit 130 is not
a complete 335-test census or downstream S-2 blocked 78. Fourteen emitted native
PASS records remain partial observations. All 17 recorded process identities
retired; the owned group and temporary-root FD census are empty. The wider
host census is partial (369 unreadable cwd and five stat entries). Both isolated
copies retain 2,402 exact hashes, six dependency directories, eight local aliases
and 15 physical identities. Receipts: `e2e/artifacts/independent-l6hr-a3ea2958-20261101/`.

The automatic test now saves completed failed runs' full streams under private
0700 directories with 0600 files and reports only their paths. Boolean/count
matchers and index-only parse errors avoid exposing raw received data. Errors
before capture or during transport cleanup remain outside that retention path.
The changed-reporting diagnostic reproduces a real parent readiness failure in
188.368s, with all 2,402 hashes unchanged. Its retained first record is
`local_worker_ready` after cross-clock retention passes, just as the original
180s work window ends. It runs one selected test; 124 are filtered, not passed.
The existing strict count and file validation remain unchanged. An attempted
read-only native adapter prototype returned the same count as the CLI but showed
no speed advantage (3.648s versus 3.500s), so the proposed helper rewrite was
rejected before implementation. The scheduling change above is the sole later
runtime lever. Receipts: `e2e/artifacts/dae7-native-20261101-0528/`.

The repaired working source passes typecheck **8/8 groups** in 233.502s and
lint **8/8 groups** in 108.350s, with inherited warnings. All 2,402 tracked
working hashes remain unchanged across both checks. The five required contract
groups' earlier source-identical contract run remains a separate receipt;
no contract, schema or renderer changed in this continuation.

The initial local Vercel build's rejected 11-character origin was the literal
`[SENSITIVE]` marker written by `vercel pull`, rather than evidence that the
stored project value was invalid. Official metadata confirms a write-only
sensitive Preview variable. The verified local builds use the explicit public
staging origin; the stored origin was not readable, replaced or declassified.
This distinction matters when reproducing a local prebuilt deployment.

The preceding S4/S7 default UBS diff scan exits 1 with two critical, six warning and
219 informational findings across the two changed code files, with no failed
module. All eight critical/warning locations were inspected: synthetic secret
canaries, loopback `Bun.serve` handlers, observed child-exit promises and fail-fast
fixture JSON parsing. No new production finding was established and no scan
limit or suppression changed. Staged qualification remains a separate check.

The later scientific-fixture default diff scan exits 0: two files, zero critical,
33 warning and 365 informational findings, with no failed module. All 33 warning
sites are JSON parsing in native assertion fixtures; malformed payloads must
fail those journeys. No suppression, scan limit or production change was added.

The later join-only Bash change passes syntax, ShellCheck and the default UBS
diff scan (one file, zero findings, no failed module, exit 0).

Source `e073e05acb9c238f0f3d4847027be87fc4711830` repairs the thirteen native
journeys exposed by the complete independent integration run at `61d79d2e`.
That original run completed **322 pass / 13 fail**, 335 tests and 1,743
expectations in 4,063.137 seconds; it ended `SUITE_PREFLIGHT_FAILED` before
the downstream S-2 probe. Its immutable copies retained all 2,402 source hashes,
six dependency directories and eight local workspace aliases. All 23 recorded
process identities exited; 375 unreadable host entries limit the wider census.
The failure is retained under `e2e/artifacts/independent-l6hr-61d79d2e-20261101/`.

The repairs align fixture revisions, archived workshop versions, immutable claim
references, resolved leases and the independent seven-column event TOON oracle
with current contracts. Small packs follow bounded, increasing, pinned recovery
actions. Genuine concurrent first waves remain; only declared stale refusals
receive one same-body/key recovery after fresh context. Actual rate limits stay
in force and refusals earn no publication credit. This proves recovery, not
simultaneous commits. Strict projection parity runs before lawful payload
withdrawal; afterward the real doctor and repair path must declare the exact
unreplayable event without writing. The existing per-problem drift declaration
names two additional withdrawn-activation materiality fields; the shared strict
head rule is unchanged. Dead-end coverage also executes an actual served private
investigation request and supersession, then verifies recommendation removal.

All thirteen complete native journeys have primary passes across the retained
repair phases: pagination 126.498s, workshop 78.184s, working review 43.059s,
direct-append race 64.160s, faces 39.654s, sponsor workshop 69.631s, statement
review 69.736s, direct-append sessions 45.352s, ledger objects 41.015s,
governance 61.073s, claims 71.364s, synthesis 48.523s and dead ends 173.753s.
Every phase retained all 2,402 tracked hashes unchanged within that execution.
These are evolving snapshots, **not** one final-revision aggregate pass.
All intermediate failed controls remain, including mistakes in the added
fixtures. No production guard, schema, quota, deadline or registered lane changed.
Receipts: `e2e/artifacts/dae7-native-20261101-0528/`. Different-agent complete
integration/root/HUP/fault qualification is still pending; `dae7` and `l6hr`
remain in progress.

The homepage's source-status sentence now acknowledges implemented read faces
while retaining its prelaunch and deployed-Worker qualifications (`y029`).
The complete Agora unit gate passes **874 tests / 5,776 expectations** in
53.659s. An earlier private wrapper stopped at its mistaken 64 KiB output cap;
the passing execution uses the existing registered Agora limits, without
changing suite policy. Default UBS diff and staged scans each exit 1 with
one critical, 67 warning and 1,789 informational findings across 16 files and
no failed module. All 68 critical/warning locations were inspected: test
credential observations, hostile-content canaries, fail-fast test parsing,
awaited adapters, filled arrays and existing state-discriminated page reads.
No new production defect was established; this is not a clean security audit.

The corrected [Vercel Preview](https://asimposium-9i45afr9h-dicklesworthstones-projects.vercel.app)
is READY: `dpl_4Fjnxn73YkLhqYvBSawPD2CqXde7`, official source metadata
`e073e05acb9c238f0f3d4847027be87fc4711830`, existing project
`prj_B3b7fFQfIMBjKe3h1Pym20eZ9Qb7`, Node 24.x. The isolated frozen-lockfile
build passes in 306.173s with Bun 1.4.4 and Next.js 16.3.1; all 2,363 exported
Git blobs remain exact afterward. Prebuilt deployment completes in 17.569s.
Verification passes 26 HTTP checks and four real Chromium views in 24.925s:
three static protocol files match source bytes, canonical redirects preserve
queries, HTML security headers are present and all four screenshots were
inspected. There are zero browser errors; 16 explicitly marked Next prefetch
cancellations are recorded separately. The corrected homepage remains
qualified as source, prelaunch and incomplete launch gates. This Preview uses
the staging Stoa origin; it does not claim a current deployed Worker or Google
workflow. Receipts: `e2e/artifacts/vercel-source-candidate-20261101/`.
Runtime error/fatal and HTTP 5xx queries each return zero records from deployment
creation at 07:20:59 UTC through 11:26:37 UTC, with no excluded intervals or
further pages. These finite windows do not establish future availability.
Fresh homepage and health GETs at 12:02:30 UTC return 200; health explicitly
reports the unavailable ledger index and `product_readiness: not_ready`.
The literal Git application-input comparison from deployed `e073e05a` to
`6eb59b07` is empty; later local auth-fixture changes do not require another
frontend build. Private refresh receipts:
`/tmp/asimposium-vercel-refresh-20261101-1115/`.

Public observations at 12:02:30 UTC still find production and staging Worker
`0.1.0-draft` capabilities byte-identical to their September receipts. The
deployment authority variables remain absent in this session; no Cloudflare
provisioning, migration, Worker rollout or production promotion occurred.
Vercel Git remains disconnected. The original sanctioned Worker-before-Agora
rollout and staging lineage reconciliation remain on `rs5n`. Beads currently
has 555 issues: 109 open, 18 in progress and 416 closed; its 119 blocked count
overlaps those states. Nine ready entries include operator/policy decisions
and two historical unclassified failures (`2tnr`, `123b`); current positive
journeys do not retrospectively diagnose those failures.

An earlier candidate repairs the local S4/S7 ingress preflight. Its complete
auth directory passes **256 tests** in 262.915 seconds, including the original
automatic ingress gate in 184.575 seconds. All six native lifecycle outcomes
remain mandatory. The full parent retains all 123 migrations and its auth,
nonce-retention and restart checks; nested ownership probes start their real
process/D1 prerequisites directly. One exact helper overlaps those sequential
probes with the parent, sharing its absolute deadline. Original limits remain.
A strict early-parent HUP control returns 129 in 57.343 seconds with a stopped
leaf checker and two live leaf Workerds at delivery: all 81 observed identities
exit, both API ports rebind and all three state roots have no open holders.
That control used Bun 1.3.8; final-runtime independent re-execution is pending.

An unchanged `19019858` auth file reproduces a native Bun 1.3.8 socket-loop
crash in 74.693 seconds. The same 2,402-file source inventory completes all
130 cases in 76.405 seconds on installed Bun 1.4.4. The repository pin, minimum
and current provider/install instructions now use 1.4.4; dependencies, lock and
generated schemas are unchanged. Actual TERM-target readiness, complete TCP
frame buffering and scoped FD-close redirections repair the subsequent reaper,
fragmented KILL and stderr-loss failures. Original ACK/ownership requirements
and the reaper tuple `0:0:1` remain. The protected script changes address the
observed S4/S7 preflight blocker only.

The first complete root run on 1.4.4 executes all eight groups in 2,840.193
seconds: **6 pass / 2 fail**. Wire completes 6,413 tests in 2,676.57 seconds,
with 6,409 passes and four failures; all 2,402 tracked hashes remain unchanged.
The root seed failure is a stale manifest binding. Its digest is explicitly
reviewed and refreshed without changing seed assertions or external-review
state. The four Worker cases characterize older runtime behavior. A full-byte
diagnostic passes before the archive's Buffer/Uint8Array strict comparison
fails; the expected vector is normalized without dropping bytes. Native SQLite
now surfaces the exact witness CHECK and cutover FK refusals. The orphan-grant
fixture explicitly uses pre-0011 tables and exercises its predecessor's actual
refusal/rollback; it cannot represent valid ordered 0014 history. Bulk execution
retains original rows but leaves partial DDL inside the test savepoint. The
separate atomic rollback/corrected-retry proof is unchanged. No production
migration was altered.

The corrected files pass **222 tests / 2,367 expectations** in 83.570 seconds.
The complete toolchain passes in 231.755 seconds: 46 seed tests, actual link
checks, 401 toolchain tests, 54 existing skips and the downstream environment
interface. Final typecheck passes eight groups in 217.552 seconds and lint
eight in 103.105 seconds, with inherited warnings. Contracts passed all five
required groups in 65.452 seconds with two existing policy skips. The final
static run preserves all 2,402 tracked hashes. The corrected full root
aggregate, composed Wire integration and independent fault checks are still
pending. `l6hr` remains in progress. Current receipts are under
`e2e/artifacts/l6hr-20261101-0035/`.

Two operational mistakes are disclosed: opening Bun's generated diagnostic link
automatically submitted its generated redacted crash report; no further report
requests were made. The existing protected self-test also executed private
FIFO/capture deletion calls in earlier runs; those calls now retain the artifacts.
No manual workspace/peer-file deletion or destructive Git command was used.

The previous independently qualified source is
`19019858a9a5dfd3c90d6daa5ba252f8c8e2d6d1`.
Independent canonical typecheck passes all eight groups in 252.93 seconds,
lint all eight in 106.58 seconds, and contracts all five required groups in
82.22 seconds, with two existing policy skips. The complete unfiltered
`bun run test` passes **8/8 groups**, exit 0, in 3,156.16 seconds. Wire passes
6,413 tests and 27,754 expectations across 274 files in 2,725.49 seconds, under
its unchanged one-hour limit. All other required root groups complete; existing
case skips remain reported. The separate S6 integration gate is still red.

Main and both independent copies retain all 2,402 source hashes, six dependency
directories and eight workspace aliases. All twelve recorded PID/start
identities exited; no readable owned working-directory process remains.
356 unreadable `/proc` entries make that a partial host census. Receipts are in
`e2e/artifacts/independent-artifact-19019858-20261031/`.

The artifact repair removes expired private staging on eight
request/replay paths. Real local Workerd/D1/R2 checks cover late arrivals,
exactly one expiry transition, unchanged reservations and four protected CAS
classes. Cleanup uses the existing 15-second aggregate storage budget; sealed
declaration/renewal replays cannot restart that budget through admission recovery.
Independent artifact/erasure units pass all 70 cases; the full native journey
and registered wrapper pass. A native omission fault retains staging bytes;
two unit faults expose repeated cleanup and late part deletion. These controls
ran at `522fcd31`; only test import ordering changed afterward. That ordering
mistake caused one lint error at `522fcd31`, was corrected without changing a
rule or test body, and the final canonical gates above passed at `19019858`.
Provider presigned PUT, public Range, automatic abandoned-upload bucket
lifecycle and inventory acceptance remain on the original open `y2t7` task.

The local S6 ingress runner reuses the existing real-D1 migration adapter,
reducing observed setup from 109 to 18 seconds. Its pinned supervisor now waits
for the controller's existing release after Wrangler exits, protecting cleanup
when esbuild remains. The corrected control passes busy-port and physical
group/port/FD cleanup, but the full self-test still fails at a nested lifecycle
deadline (190.66 seconds total). The original registered automatic test also
fails at `19019858`: exit 1 versus expected 0 at `e2e-blocked.test.ts:1778`,
after 191.23 seconds. Its wrapper does not expose the inner cause, so that run
adds no new diagnosis. `l6hr` remains open; no timeout or assertion was relaxed.
One earlier leaked esbuild was retired manually through its verified
pidfd; that is not runner cleanup proof.
`scripts/e2e-s6-cross-plane-auth.sh` was unchanged at that revision. Receipts are under
`e2e/artifacts/artifact-y2t7-20261031-2208/` and
`e2e/artifacts/l6hr-20261031-2225/`.

The previously qualified baseline is `e5db4e2219e3004600e7992b56ea7f323f30afec`.
Independent canonical typecheck passes all eight groups in 256.34 seconds,
lint all eight in 106.87 seconds, and contracts all five required groups in
81.46 seconds, with two existing policy skips. The complete unfiltered
`bun run test` finishes **8/8 groups PASS** in 3,292.51 seconds. Wire passes all
6,406 tests and 27,753 assertions across 274 files in 2,867.92 seconds, under
its unchanged one-hour limit. Toolchain, Agora, E2E, gauntlet, contracts,
protocol and render also pass. No required group is missing, blocked or skipped;
the pre-existing case skips remain reported. Root uses Bun 1.3.8 and Node 24.1;
S1 retains its separate trusted resolver, Node 25.9/Bun 1.4.4.
The independent verifier closed `gy1t` and `2or3` against their original
criteria (comments 2623/2624); all five `gy1t` acceptance items are checked.
Changes through `7b4f7de4` were report/tracker metadata only; these gate results
qualify that earlier revision; the new canonical results above supersede them.

Both independent copies retain all 2,402 exact source hashes, six dependency
directories and eight local workspace aliases. All seven known owned PID/start
identities are gone and no readable owned working-directory process remains;
362 unreadable `/proc` entries make that a partial host census. Five deliberate
faults fail their intended assertions under passing controls: retained control
socket, unrelated socket closure, wrong hash input, wrong schema serialization,
and omission of the native cycle trigger. The corrected reverse-edge row now
includes required `created_at`; removing only trigger 0045 admits the cycle
and fails the original rejection assertion. The earlier invalid-row mutant
earns no causal proof. All seven registered local discovery scenarios pass
in 348.08 seconds. Fixture screening is still distinct from live-model evidence.

The existing [Vercel Preview is READY](https://asimposium-35mekgt27-dicklesworthstones-projects.vercel.app)
from `e5db4e22`. It predates the current Bun-pin change; a fresh candidate
build/deployment and verification are still required.
Twenty-five HTTP checks and four desktop/mobile
browser views pass with zero browser errors; thirteen explicitly identified
router-prefetch aborts are retained separately. The four existing Now/Results
Markdown/JSON faces now redirect to the validated staging origin, preserving
pagination queries; their human pages remain HTML. Independent external checks
confirm those eight redirects and three human pages. Runtime queries cover
October 31 20:37 through November 1 00:23 UTC with zero error/fatal records;
recorded HTTP 5xx queries cover 21:52 through 00:23 UTC with zero records.
Neither query class has omitted intervals or a further page. Four final GETs
pass at 00:23 UTC: two HTML 200s and two exact canonical 308s with queries.
The new Worker source is not deployed by these Preview checks.
All 2,363 exported Git blobs match; the native expanded
upload manifest's 2,358 files also match their bytes and paths. This is not an
inspection of a physical remote archive. Evidence is retained under
`e2e/artifacts/vercel-source-e5db4e22-20261031/verification/` and
`e2e/artifacts/independent-gy1t-e5db4e22-20261031/`.

Vercel's project was still connected to GitHub `main`. The sanctioned pipeline
uploads source directly through the CLI, so that reversible Git connection is
now disconnected. Official project API reads confirm the change; six subsequent
Preview HTTP checks pass. Git pushes no longer create deployments through this
connection. Cloudflare authority, staging migration lineage and Worker-before-
Agora reconciliation remain operator work (`rs5n`). The staging Worker is still
old, so ledger views disclose unavailable data. No production, hosted screening,
OAuth, G0 or launch result is certified by these source and Preview checks.

The implementation's default UBS diff and staged scans complete six files:
15 critical findings, 23 warnings, 660 information items, exit 1, no failed
modules. The import-only correction's scans complete one file with 6 critical,
12 warnings and 425 information items. All critical/warning locations were
reviewed: nonsecret route/state/operation comparisons, intentional fixture
values, fail-fast parsing, returning switch cases and validated headers.
Diff/staged finding multisets match exactly. The earlier `e5db4e22` three-file
scan's 18 critical/37 warnings remain a separate scope. No suppression,
baseline or limit changed; this is not a clean security audit.
Fresh `verify:cost` remains **blocked, exit 78**,
`S2_COST_MEASUREMENT_UNAVAILABLE`; no retained S2 cost receipt exists.

The next critical-path action is the existing `rs5n` operator task: supply
Cloudflare authority to the sanctioned Workers Builds pipeline, reconcile the
existing staging database lineage and binding roles, and deploy that verified
source before Agora production. The Git deployment bypass is resolved, not the
rest of that task. Hosted provider/context delivery, screening accuracy, real
Google approval, the third harness, retained cost measurement and launch gates
remain open. The current local preflight matrix passes; independent composed
verification (`l6hr`) remains pending. Artifact provider,
lifecycle and inventory proof (`y2t7`) and historical unclassified integration
failures also remain open;
the old CAS helper list was already retired in `7738fa9b`, so do not recreate it.
The limited protected-script changes are described above. Original policy decisions
and broad acceptance conditions remain in their original Beads.

The record below preserves earlier failures and intermediate proof scopes;
its pending source states are superseded by the exact qualification above.
That qualification does not certify the separate S6, provider or launch gates.

At `14415c72`, the earlier completed independent aggregate finishes all eight
root unit groups in 3,286.29 seconds: six pass and two fail. Wire completes
6,406 tests across 274 files in 2,833.86 seconds, within its unchanged one-hour
limit: 6,404 pass, two fail, with 27,382 assertions. Both failures are S3 isolated
build-output overruns before graph assertions. The root toolchain's remaining
failure compares a shared process's global socket count (five before, three
after); that count does not identify which owners retired. All eight typecheck
and lint groups and all five required contract groups pass independently at
that revision. `gy1t` remained open until the corrected candidate above qualified.

The intermediate candidate, `ea0562a1`, independently passes the 97 focused unit cases,
both unchanged S3 controls (371 assertions), and all seven registered discovery
scenarios in 346.98 seconds. All six refusal scenarios now pass their original
outer checks with the complete eighteen-write census. Four deliberate faults
fail the intended native resource, hash-vector and schema-byte assertions.
The cycle-trigger omission check exposed an additional test defect before the
aggregate began: the direct reverse-edge INSERT omitted required `created_at`,
so removing the trigger still produced an unrelated NOT NULL rejection. That
fault earns no cycle-admission credit. The row now supplies a fixed timestamp;
the corrected primary positive passes in 100.22 seconds. Independent causal
checks and the full aggregate subsequently pass at `e5db4e22`. The changed Agora scope passes
typecheck, lint and all fifty existing contract cases (410 assertions).

That revision's Vercel Preview is
[READY](https://asimposium-ohww4m6mi-dicklesworthstones-projects.vercel.app).
Seventeen supported HTTP checks and four browser views pass with no browser
errors; fourteen explicitly marked router-prefetch aborts are recorded separately.
The runtime error/fatal query returns zero records, no omitted intervals and no
further page. The first probe incorrectly expected production-origin redirects
from a staging Preview; its failed receipt is retained. It also found absent
apex `/now.md` and `/results.md` redirects. Those two paths and their existing
JSON peers subsequently pass the corrected Preview's checks, including pagination
query preservation. Neither preview
reconciles the stale upstream Worker or establishes production readiness.

The follow-up replaces the two unowned socket-count checks with isolated native
resource checks. It holds unrelated sockets and distinct early/late file
descriptors, checks bidirectional bytes and file identity/data after GC, and
retains actual control owners so GC cannot conceal omitted explicit cleanup.
The complete G0 unit file passes 64 cases and 390 assertions, with its one
existing conditional skip. The original five-to-three observation's specific
socket identities remain unknown; no benign-cause or production-controller fix
is inferred from it.

The actual Bun production-graph build fell from 4,287,836 to 3,051,160 raw bytes,
and from 4,470,203 to 3,145,163 canonical evidence bytes. Existing Web Crypto
replaces a move-diagnostic Node hash that pulled browser crypto/stream
polyfills into this build. Generated schema objects omit source indentation
from bundled code, then restore each generator's original served format:
18 pretty and two compact, all with a newline. No generated schema or golden
files changed. S3's build options, externals, complete-output checks and
3.5 MB evidence cap are unchanged; both original build/graph controls pass
371 assertions. These are Bun graph-build sizes, not deployed upload sizes,
latency or billing measurements.

Real local Workerd serves all twenty file-backed schemas byte-identically to
disk, with independently computed ETags and eighty GET/HEAD/conditional
requests covering 1,158,067 bytes. The complete positive discovery lane passes
in 95.88 seconds, including all twelve public-write candidates and replay,
current contextual screening attestations, quota races, dependency rollback,
redaction across twelve pack profiles, literal search and privacy checks.
Earlier controls exposed stale candidate-only receipt expectations, missing
hypothesis-lifecycle coverage, unresolved synthesis pins and profile-specific
omission formats; their failures are retained. Native diagnostics also show
the history-admission guard wins the mutually revising dependency race. The
test now checks its exact refusal, immutable old source bytes, changed head,
exact acyclic edge set and atomic effects. A separate real D1 reverse-edge
insertion specifically exercises the cycle trigger without changing sources.
Screening verdicts and sponsor setup remain fixtures: this proves local
binding and attestation behavior, not live-model delivery, context completeness,
OAuth or staging. Policy-mode and final aggregate checks were still pending at that point.

Pre-freeze candidate checks pass all eight typecheck groups (227.20 seconds), all
eight lint groups (106.70 seconds), all five required contract groups (78.96
seconds, two existing policy skips), and 97 focused unit cases/659 assertions
(one existing conditional skip). Wrangler 4.123.0 on genuine Node 24 also
compiles the production entrypoint with the generated **local** configuration:
6,042.26 KiB, gzip estimate 1,015.49 KiB, with both Durable Objects, D1 and both
R2 roles. This dry-run creates no remote deployment or resource.

All six policy-mode product records pass eighteen screened refusals and two
additional refusals each, with saturation and unchanged public state/R2. The
outer command is nevertheless retained as **six failures** in 257.09 seconds:
its old fixed expectation was seventeen before hypothesis-lifecycle coverage.
The wrapper now pins eighteen; its exact independent rerun passes in the final qualification above.

The required UBS diff scan completes fifteen changed code files under default
limits, reporting 21 critical findings, 105 warnings and 1,359 information items
(exit 1). Structured output confirms no failed modules. All critical matches
were inspected: they are test-driver method/status/format/ID comparisons or
scripted policy/object-identity assertions, not secret verification. Warnings
include parsing owned schema text, guarded move dependencies and fixture code.
No rule, limit, suppression or baseline was changed. The findings remain in
the receipts; this is not a clean security audit. The staged scan completes
with the same fifteen-file totals; the exact independent aggregate was still pending then.

The operator authorized implementation and a Vercel deployment after the baseline
assessment below. Independent verification of `a68f6c82` passes all eight root
typecheck and lint groups on pinned Bun 1.3.8, in 259.88 and 80.10 seconds. All
five required contract groups pass, as do 2,089 affected unit cases and the local
reference journey. The verifier closed only the P0 static-baseline task, `tb4o`,
with evidence for all six original acceptance items. The complete canonical root
unit command finishes at that frozen revision with six passing and two failing
groups in 3,986.64 seconds; `gy1t` remained open at that revision. Wire reaches its original one-hour
limit with five retained failures, so it has no complete assertion denominator.
Earlier failures remain recorded below. No Wire limit was increased.

The complete scientific and moderation journeys now pass on local Workerd/D1/R2.
Scientific assertions distinguish immutable publications from live assessments,
explicit historical cuts and current disclosure withholding. Moderation checks
missing, bearer, sponsor, allowlisted operator and foreign operator principals;
real D1 state digests prove rejected suspension commands leave business data
unchanged. These are local fixture-screening proofs, not live model accuracy,
Google OAuth or staging results. An independent verifier re-executed the source
at `7184493015572a822457efc9c6282b0786cf2484`: all 934 contract tests, 554 renderer
tests, 189 production browser checks and the selected registered scientific lane
pass. Five deliberate scientific faults fail their intended assertions under a
passing control; a non-atomic suspension mutant returns 200 where the injected
journal-failure check requires 503. The 26 focused suspension/claim tests pass,
including every mounted principal permutation and the actual 69-item renderer.
An earlier unmutated control failed without enough retained safe metadata to
diagnose it; later passes do not explain that observation (`123b`).

A real browser journey exposed a product defect: claim faces emitted proof-gap
records that their shared contract rejected, producing HTTP 500. The canonical
Zod enum and generated schema now admit that existing public kind while retaining
private/unknown-kind rejection. The item limit covers the producer's complete
69-record bound, with positive and one-over-limit cases. The actual Chromium +
production Next + Workerd browser journey passes 189 checks. The finished human
`/protocol` page is also reachable after removing its incorrect bare redirect.

An earlier Vercel Preview is [READY](https://asimposium-bp8xuzct6-dicklesworthstones-projects.vercel.app)
from the verified `a68f6c82` runtime source. Seventeen HTTP checks and four browser
views pass with no page, console or HTTP resource errors. Eight explicitly marked
Next prefetches cancelled during scripted navigation are recorded separately;
other aborts still fail the probe. The final runtime error/fatal query returns
zero records, no omitted intervals and no further page. This is not production
promotion: the upstream
staging Worker still serves the September version, research views disclose its
unavailability, and its `/protocol.json` is 404. Canonical `/protocol.md` is 200
and matches the source digest. Worker reconciliation/deployment still requires
the operator's Cloudflare authority (`rs5n`).

The canonical runner now executes the previously disconnected content-hide and
dead-end workshop journeys. The hide proof at `ce6af8da` earns a disputed claim
through real HTTP publication, counterexample and independent fixture review,
then follows the current reference-based move contract. Fourteen sensitive reads,
16 claim faces, five title faces and five pack profiles are checked across claim
and whole-problem hide/restoration, including another sponsor. This exposed a
real defect: a whole-problem hide made the full archive pack return 503. A narrow
unavailable-scope error now produces 404 while genuine storage failures remain
503. The independent verifier reran the complete local control, the four selected
canonical inventory/hide/moderation/review entries and 42 full-pack unit cases.
All pass. Three deliberate faults fail their intended checks: a hidden move
reference, actual hidden Fellow bytes and the former full-pack 503. The verifier
closed the bounded `aucv` repair; this is not the whole integration aggregate or
a deployed privacy certification.

At `ff24a2b1`, gap-route fixtures supply the content-control table required by
the unchanged reader, and quota fixtures publish a real claim before requesting
targeted review packs. Zero-quota refusal/private work and all twelve profiles
remain covered; digest and full packs retain their existing read-only contracts.
An independent exact-revision run passes all 16 SQLite unit tests. Removing gap
visibility guards incorrectly preserves a visible cached response (304 rather
than required revalidation); removing sponsor quota suppression fails both new
quota cases. These are unit proofs, distinct from the earlier real browser lane.

The repository is still not globally green. A subsequent complete root unit run
records six passing and two failing groups (root tooling and Wire); it overlaps
the two unit-fixture edits above and is not exact-revision acceptance. The earlier
complete direct Wire baseline ran 6,360 tests with 182 failures. Contracts pass
their complete command, but no green replacement aggregate is claimed. Root lint
retains four failing groups. Aggregate UBS scans cannot be called clean: the
hidden-scope patch reports 115 critical findings and 99 warnings in scanned files
(the unchanged router baseline also has 115 critical findings), and earlier broad
scans timed out. The two fixture files separately scan with zero critical findings
and zero warnings; that does not replace broader security coverage.
Cost proof is honestly blocked at exit 78 without the retained S-2 measurement.
The S-2 preflight repair now attests 79 previously unlisted reachable modules,
follows fixed module targets and refuses computed or escaping imports. Its
migration journal, and the token-lifecycle journal, now reach the actual migration
0123. The final focused source-closure selection passes 23 tests; the preceding
complete S-2 file passes 107 and fails two concurrent cleanup scenarios. The
token self-test passes, but three later cases exhaust the 150-second migration
deadline before reaching their fault checks. That repeated run was stopped and
its seven recorded process identities were verified gone; it is incomplete, not
a token-lifecycle pass. No timeout or runtime pin was changed. Fresh typecheck
still passes all eight groups, and lint still fails four. S-2's staging and cost
requirements remain unmet.

Independent reexecution at `46d197a2` confirms the 23 source-closure checks,
one token self-test and all eight typecheck groups. Both concurrent lifecycle
cases still fail when run separately without the earlier competing checks:
their children stop in the bounded source-closure command before either
scenario reaches readiness. The exact cause of that capture failure is not
fully diagnosed. Profiling attributes most walker time to full syntax-tree
construction. An uncommitted native-parser experiment reduced CPU cost and
restored the six-fixture case, but the four-way case still failed; the added
parser complexity was excluded. Its sources and logs remain available for
diagnosis. These observations are an outstanding baseline blocker, not a green
S-2 concurrency or launch claim. The existing Vercel Preview was revisited:
home, protocol HTML and `llms.txt` each still return HTTP 200.
Further guard coverage at `a4624df3` connects the complete artifact journey to
the shared D1 probes and requires 26 additional probe IDs across artifact,
disclosure, private access/erasure, appeal and suspension journeys. The migration
census now pins all reviewed refusing-trigger definitions through migration 0123;
47 added and nine changed fingerprints match the exact stored SQL. The directive
probe preserves its historical obligation by attempting a forbidden body change.
An independent verifier passes all 13 census units and the four affected general
registry journeys. At `81641a94`, the Stoa registry journey also passes with bounded
same-key recovery from a changed screening context. Four deliberate faults are
caught under passing controls: writable artifact parts, no-op-only directive
protection, unexpected fifth-field projection drift, and an unrelated live 409.
This proves the named local guard cases, not every transition predicate or W2.1.

A fresh three-harness rehearsal found that deleting a top-level statement does
not invalidate a typed workshop-reference promotion. Revision `a09d7d9d` instead
removes a field required by both canonical promotion forms, and its scorer requires
an actual injected 422 followed by success on the same owned session. Both reference
forms publish exactly once and replay their receipt; all four negative controls
must reach their intended stages, including an actual missing-falsifier refusal.
The independent verifier passes all six real-binding reference controls and 13
scorer units, catches both the old injector and old broad-refusal scorer, and closes
`266i`. The complete gauntlet unit command passes 67 cases and its shell self-test.

The corrected fresh round completes all eight stages for Claude Code and Codex,
including the injected refusal. Their registered model/harness strings are retained
and explicitly self-declared. Gemini cannot authenticate, so the round honestly
exits 78 with two completions in three attempts; `pcsn` remains blocked. Its large
CLI-reported cumulative token totals are retained with their available cache
breakdowns, not recast as unique input or a passing first-promotion budget. These
are local rehearsals with fixture screening and synthetic signed approval, not
staging S-1/G-C or live Google approval.

The preceding typecheck passes all eight groups in 179.24 seconds, and fresh root contract
verification passes all five required groups in 46.29 seconds, with two policy skips.
Lint at that revision improves to five passing groups and three failing groups (Wire, contracts and
render). The complete root unit dispatch reports six passing groups and two failures
in 2,944.15 seconds.
Wire crosses the retained-output ceiling after 2,561.43 seconds and its owned
process group is reaped; this is not a complete Wire assertion census. Its ceiling
was not raised. A separate backup fixture repair at `bf4e66e8` distinguishes scalar
metadata reads from bulk pages; all 29 SQLite unit cases pass, and an independent
201-row page fault fails the intended 200-row ceiling assertion. This does not
claim a deployed backup/restore drill. Initial new-fixture type errors, the prior
ineffective injection, and a shared-sponsor cap failure remain in the retained
diagnostics. The guards' scans retain reviewed findings rather than suppressions;
the final backup fixture scan has zero critical findings and zero warnings.

Further baseline work fixes the move-selection unit fixtures at `ef4cbf0f` and
roster fixtures at `939eb1c0`. Independent complete runs pass 37 move units and
17 roster units. Deliberate faults catch removed snapshot rechecks, lost access
to a known unlisted scope, an incorrect writer cap, and the missing observer
teaching refusal. These are migrated SQLite/provider units with synthetic
screening, not real D1 or deployed authorization proofs. Canonical move templates,
actual public statements and truthful batch-result metadata replace incomplete
fixtures; production guards and existing assertions stay intact.

Individual formatting/import corrections at `d86540b5` restore contracts and
renderer lint without changing JSON fixture values or generated schemas. Their
full suites pass 934 and 554 cases, and schema drift passes. Root lint now finishes
seven passing groups and one failure, Worker lint; typecheck passes all eight
groups in 404.95 seconds. These mechanical changes add no product capability.

The shell corpus gate also confused three operational fixtures with refusal
documents. Independent review of the first repair at `553a4753` found three
surviving holes: missing opaque and additional contract-code fixtures passed,
and the rule-only name `A1` was accepted as an error code. Revision `fd6b7c5c`
uses the complete closed code set in both directions and correctly bounds the
recorded debt list. Nine gate process units and 15 schema inventory units pass.
A different verifier re-executed the exact revision, caught forward-extraction,
reverse-membership and debt-boundary regressions, and confirmed all three
operational validators still refuse invalid payloads. The verifier closed only
the narrower `9v3q` repair.

Revision `034ae97a` selects Bun's supported compact progress reporter while
preserving every test root, timeout, failure diagnostic and output ceiling.
Forty suite-runner controls and 46 seed tests pass. A complete direct toolchain
Bun run records 384 passes, 54 existing skips and two failures in 19,923 bytes:
stale mutation anchors and a descendant-cleanup timeout. The downstream
environment-interface command does not run after that failure. The older
verbose aggregate was explicitly stopped after its toolchain truncation; all
nine recorded process identities retired. Neither result is a passing aggregate.

The final-candidate contract aggregate passes all five required groups with two
policy skips in 158.29 seconds, and lint retains seven passes/one Worker failure
in 424.26 seconds. Root typecheck completes seven passes and one failure in
765.35 seconds. It reaches its 300-second Worker bound
and loses owned-process identity during final census; a subsequent direct Worker
typecheck exits zero. That source check does not certify the failed supervision.
The root unit run completes its toolchain group without output truncation:
384 passes, 54 existing skips and three failures. Stale plants, a grandchild
sentinel surviving timeout cleanup, and a focused cost-verifier transport case
remain failed. Agora records 873 passes and one 30-second path-redaction gate
timeout, with no observed path disclosure.

Independent diagnosis traced the cost-test transport failure to its nested leaf's
five-second default: that leaf launches five CLI processes, each already bounded
at twenty seconds. Verbose, both compact flag orders and failure-only reporting
all reproduced the same timeout after initial byte checks passed. Revision
`70db49f0` gives only that parent a 105-second composed bound. Child deadlines,
the nested 120-second limit, outer 300-second limit and every byte/replay check
remain unchanged. All 34 cost units pass. An independent exact-revision run also
passes all four reporter forms, catches the restored five-second parent under a
passing delayed-child control, and catches dropped bytes and a missing newline.
This does not supply the missing S-2 measurement receipt or close S-7.

The complete direct toolchain rerun at `70db49f0` records 385 passes, 54 existing
skips and two failures across 441 tests in 350.96 seconds. The cost invocation
case passes in that context. Stale mutation anchors and empty spike-redaction
output remain failed; the downstream environment-interface command does not run
after that failure. The earlier surviving-grandchild failure remains part of the
record even though its case passes in this later run.

The long aggregate began at `034ae97a` and overlaps that root-fixture edit.
S-2 also hashes the cost-test file, so the aggregate is a mixed-revision baseline
observation, not exact-revision acceptance. The narrower independent receipts
above retain their individual committed revisions and limits.

The aggregate finishes on October 31 with five passing groups and three failures
in 4,290.63 seconds, all eight groups executed. Worker reaches its unchanged
3,600-second deadline and receives SIGTERM. Its retained prefix names 26 failures,
including 15 session-route cases, but is not a complete assertion census. E2E,
gauntlet, contracts, protocol and renderer unit groups pass. The four recorded
Worker children retire after timeout; after the whole run, all five recorded
process identities are gone. No output ceiling or whole-suite timeout was raised.

Revisions `0acffb55`, `154b8189` and `febd2f04` repair 22 named failures from that
retained prefix. Session-pack fixtures now consume the actual structured bodies,
recorded review tiers, captured cursors and disclosure writer. Missing/redacted
content, precise omissions, actually executed query faults, interleaving cuts,
cycle refusals and empty-pack boundaries remain asserted. The lease fixture now
supplies the membership required by migration 0116; historical publications carry
valid revision data and semantic version digests. Enrollment fixtures exercise
active, suspended and unreadable sponsor authority. The restore adapter supplies
the D1 success metadata its existing fence requires. Discovery goldens change only
reviewed, already-served registry entries, paths and schema sizes. No production
publication, authorization, visibility or screening guard changed in these commits.

Independent exact-revision reexecution passes all 326 first-batch cases and all
153 second-batch cases. A final producer slice verifies the added canonical gap
receipt parsing. Twelve deliberate faults fail their intended assertions under
passing controls, with all archive hashes restored. These are unit proofs using
SQLite, in-process requests and synthetic screening. The cycle mutant still
refuses a write with the wrong code; the membership mutant changes permissions.
Neither result establishes an admitted cycle or leaked private bytes. The final
source passes all eight root typecheck groups in 155.93 seconds; root lint finishes
seven passing groups and 234 Worker errors. UBS completes for the second batch
with zero critical findings and one reviewed warning. Scans of the large session
file time out with zero files in their final summaries and remain partial.

An independent full root unit run against immutable `febd2f04` finishes five
passing groups and three failures in 3,967.22 seconds. The passing groups are
Agora (874 cases), gauntlet (67), contracts (913), protocol (173) and render (359).
Toolchain has 386 passes, 54 existing skips and one stale-registry failure; the
cleanup/redaction cases pass without a code change. Wire reaches its unchanged
one-hour deadline, so its 105 named failures are only a retained prefix.

The archive's root dependency directory disappears during execution, while all
2,399 tracked source hashes remain unchanged. Two older archives also lose their
dependency directories; main remains intact. The cause is unclassified, and no
janitor was changed. Sixty-three S2 failures explicitly report missing modules;
the e2e smoke fixture stops with 26 failures, and contract cannot start its
dispatcher. These results are setup-contaminated, not established product
defects. Fresh proof must preserve both source and dependency availability.

The next main-tree batch reconnects 17 moved mutation anchors without changing
their commands. Three obsolete definitions are explicitly renamed and retargeted:
the honors candidate prefilter and review-pack inclusion metadata use their
existing unit policy tests; formalization's authored instructions use the existing
real-Worker hide journey. These cover current consumer boundaries, not the former
inline SQL, a hidden-byte leak or an end-to-end recognition bypass. All 220
definitions now apply, and the six registry/selection units pass. Explicit
`--only` selection checks its named entries and rejects empty, unknown or duplicate
selectors, preventing zero-run success; the default still checks the full registry.
The runner resolves target paths physically before its primary-checkout refusal,
so an existing filesystem alias cannot bypass that safeguard. Its CLI-level
negative probe requires the precise refusal and cannot select a real mutation.
Independent source review accepts these bounded changes, while actual control and
fault executions remain pending. Six individually formatted/import-organized unit
files also pass their focused Biome checks, retaining 14 warnings and three infos.

The remaining prefix exposes 39 reproducible unit-fixture failures. The existing
empty disclosure-table helper is now connected to the dependency-science query
fixture, and citation fixtures include the reader's content-control table. New
controls assert missing coverage, exact historical citation availability before a
whole-problem hide, withdrawn bytes/cache validators during the hide, and restored
identical bytes/ETags. The component pack permits only body-free system context;
this subrouter fixture does not include the outer application's 404 middleware.
Feed tests observe actual database-returned columns and body-canary presence,
allowing bounded causal-JSON predicates without returning raw bodies. Hypothesis
provider fixtures consume the canonical golden response with complete lifecycle
pins. Unlisted retry is a positive known-member case; missing membership and
private, hidden or terminal states have independent refusal cases.

All 260 cases in the 12 affected unit files pass in 22.68 seconds, including the
alias-safety case. A fresh typecheck catches three
introduced fixture annotations; typed SQLite results and canonical hypothesis
parsing correct them. The final typecheck, including the alias probe, passes all
eight groups in 155.90 seconds. Root lint
finishes seven passing groups and 225 Worker errors in 75.35 seconds. An uncapped
direct census identifies 160 formatting errors, 53 import-order errors, six
control-character-regex errors and six unsafe optional-chain errors. No assertion
autofix or rule suppression is applied. This is current source/unit evidence;
independent exact-candidate fault runs and the global baseline remain incomplete.
The intact main checkout also completes all five required root contract groups
in 61.76 seconds, with two policy skips. Its direct e2e unit group passes the
gallery check, smoke fixture and all 50 screening/OAuth units. The root-supervised
e2e unit group also passes in 59.65 seconds; the archive's smoke failures do not
reproduce there. This does not establish a complete eight-group unit pass or live
OAuth. UBS scans 14 changed source files and
reports zero critical findings, 21 warnings and 794 infos, but remains partial:
the JavaScript command-taint analysis exceeds its dataflow limit in the mutation
runner and registry tests. No partial-scan override is used.

The optional Rust test build now runs remotely with all seven external contract
inputs, rather than an incomplete CLI-only source transfer. It passes 62 tests;
two real-HTTP cases remain explicitly ignored, and the canonical-JSON consumer
retains its declared lone-surrogate exclusion. All 19 CLI files and seven external
inputs in the worker-verified receipt match `febd2f04`. The existing `.rchignore`
now excludes the local release FIFO and all task-specific Wrangler state. Its
previous narrow state/tmp exclusions admitted a 978 MB local Cargo cache and
caused a workspace-containment refusal. The successful transfer excludes local
state, Beads and credentials. This supplies ordinary Rust test evidence, not the
ignored real Worker journeys, independent CLI acceptance or W11 completion.

Next baseline work remains on `gy1t`: complete the frozen aggregate, verify
the updated mutation definitions with actual causal checks, then resolve any
remaining S-2/token startup failures from the complete census. Static acceptance
remains on `tb4o`; full ID/reference grammar and vector diagnostics remain on `phg`.

Independent reexecution at `b1748edf` passes all 260 changed-file tests and six
priority faults, including primary-alias protection and the new reader/provider
controls. Of the 20 updated registry definitions, 15 fail their intended
assertions under passing controls. Four have failed controls and one survives;
these are retained as limitations. Both isolated copies retain all 2,399 source
hashes and every workspace dependency alias. This supersedes none of the earlier
setup-contaminated observations.

The following static batch addresses the complete 167-file lint census through
individually named formatter/import-order corrections. Twelve substantive
diagnostics use exact numeric C0/DEL checks and explicit positive move assertions.
The old and new character predicates agree across 2,228,224 comparisons, covering
every Unicode code point and lone surrogates. Lint rules, thresholds and compiler
settings are unchanged. Existing scientific and privacy refusals remain asserted.
One import-layout follow-up takes the
root lint result from one remaining error to eight passing groups. Typecheck also
passes all eight groups. Independent frozen-revision acceptance is recorded below.
All 2,089 tests across the 72 affected unit files pass in 96.77 seconds, with
5,611 Bun expectations. This selection is not the complete root unit command.

The four failed integration controls exposed an extensionless web import, an old
TOON header, snapshot restoration through newer erasure triggers, and two
material-event fields omitted from a deliberately corrupted-log expectation.
Targeted corrections preserve the production guards and assert exact trigger
restoration plus ordinary-insert erasure refusal after verified replay. The
snapshot also rolls back its erasure marker; retaining newer deletion authority
would not model its pre-deletion state. The complete local deletion journey now
passes 14 signed records and its credential/transfer/account cases. Its sponsor
restore checks all tombstone states explicitly because D1 change counts include
revision-trigger writes. The hypotheses/evidence journey also passes its real
local lifecycle, withdrawal, projection and trigger checks. The commentary survivor exposed
a probe that now stops at early replay; a fresh-key collision at the existing
real-D1 batch seam observes the actual no-event projection boundary. Independent
source review accepts these changes. All five repaired controls now pass locally,
including projection-doctor's exact corrupted-log declaration, complete event-tail
pagination and the new commentary collision's no-event/body-preservation boundary.
Independent frozen controls and faults subsequently pass with the limits below.
No global unit or launch claim follows.
The broad UBS diff scan reaches its unchanged 300-second limit and reports zero
scanned files with partial status. Its zero finding counts do not establish the
absence of findings. No timeout increase or partial-coverage override is used.

The staged scan also times out after 300 seconds with zero files scanned. Those
two required scans remain partial. Independent source acceptance does not replace
their missing security coverage.

At the frozen revision, the verifier reruns all canonical static/contract gates,
the 72 affected unit files and the local reference flow. The latter completes two
reference forms and rejects four intended negative controls; it is not a live
three-harness or staging gauntlet. All five repaired real controls pass, and their
original faults are caught. Commentary fails the new body-preservation assertion.
The event-tail and projection-health faults fail earlier HTTP availability
assertions, before their later dedicated assertions; those later checks receive
no execution credit. The actual single-selector honors CLI runs one passing
control and one caught fault. Reintroducing the former C0 regex fails the unchanged
canonical lint gate. All 2,399 tracked hashes and dependency aliases are restored
in each of the three isolated copies. Beads comment 2592 records the independent
`tb4o` acceptance; global unit, provider, security and launch claims remain open.

The new deployment uses a clean source snapshot because the native CLI's first
full-worktree upload exceeded Vercel's 15,000 file-item limit. All 2,360 included
Git blobs match the frozen revision; 39 tracked Beads files are omitted. The
client's expanded upload manifest contains 2,355 matching files, excluding only
five Git ignore files. Its archive path is virtual: the retained integrity proof
checks selected source bytes, not a locally extracted client tarball. The first
clean Preview exposed an injected Vercel Toolbar CSP error. Disabling Preview
feedback at the project and deployment levels fixes it without changing the
application CSP. The successful replacement retains the same runtime source.

The full root unit run's first completed groups are toolchain and Agora.
Toolchain passes its 46 seed cases, then records 389 passes, 54 existing skips
and one failure: the D8 timeout/cleanup fixture receives `G0_SPIKE_SPAWN_FAILED`
after 15 ms rather than reaching its timeout assertion. Its retained executable
fixture has both start and delayed-side-effect markers, 406.8 ms apart. Thus the
body did run; the error label cannot establish an empty launch. The runner drops
the original error detail and skips cleanup for its start-failure classification.
The exact trigger remains unclassified. A later process inspection independently
confirms the exact fixture and supervisor remain alive in their private namespace.
At 06:21:46 UTC the verifier pins their identities with pidfds, rechecks the script,
ancestry and namespace, and signals only that namespace's PID 1. All three owned
identities exit; the current Wire group remains unchanged. This is manual cleanup,
not success by the original runner, and is retained as timing context for the
continuing run. The repair is tracked as `s0vr`, blocking `gy1t`. Agora passes all
874 cases. Wire then reaches its unchanged one-hour bound. Its retained failures
are the four-way term-identity barrier, six-fixture legacy leader-loss, partial
state-census plant, secret-log plant and live local proof with Bun shadowing Node.
The partial-census case reaches its intended typed refusal but later reports
unproven group-leader reaping; the log plant reaches a different HTTP-proof
failure. These are not successful causal negatives or diagnosed startup failures.
All other root groups pass: e2e units, reference-gauntlet units, contracts units,
protocol units and renderer units. The dispatcher reports six passes, two failures
and all eight groups executed in 3,986.64 seconds. All 2,399 source hashes and the
six dependency directories/eight aliases remain exact after the run. No complete
Wire denominator or green replacement aggregate is claimed.

The following cleanup repair distinguishes a genuine no-PID launch failure from
an error on a launched child. It retains the live ownership channel and actual
exit notification, invokes the existing bounded namespace teardown, and records
only an allowlisted errno and fixed stage. An error after actual exit cannot
signal a stale group. No timeout, grace period or drain budget changes. The full
G0 runner unit file passes 57 cases with one existing platform-conditional skip;
four added real-process cases cover genuine ENOENT, post-start EIO, untrusted
error text/code and a post-exit notification. An unrelated process must finish.
Injection stays inside isolated fixture processes, with an outer namespace
containing the defective implementation too. The old post-start handler is
separately reproduced: it reports `SPAWN_FAILED`, permits the delayed side effect
and requires the outer timeout. Five non-injected diagnostic attempts time out
cleanly; they do not explain the original missing errno. Independent repair
acceptance and the broader baseline are still pending. Review also finds the
existing CLI formatter would discard the new diagnostic; it now projects the
safe optional `process_error` field. The actual CLI failure path and formatted
post-start records are checked, both output streams are scanned, and failure
status/exit 1 are required. An introduced optional test-argument type error was
corrected; the next complete typecheck and lint runs passed all eight groups.

The subsequent canonical toolchain composition exposed another real ownership
defect: Bun 1.3.8's extra-pipe/numeric-FD combination can close an unrelated reused
parent descriptor during finalization. Contained OS probes reproduce damage in
12/12 early-close and 12/12 after-exit-close cases; genuine Node 24.1.0 has no
damage in 72 controls. Merely moving the script to stdin is insufficient. The
repair keeps an explicitly owned, paused loopback Socket pair for the existing
control bytes and passes the accepted Socket as borrowed stdio. The script FD
remains caller-owned. Seventy-two Socket controls preserve every guard and show
zero descriptor growth; nine failed-launch controls preserve caller ownership.
Quiet hold and actual Bash status/EOF release are exercised. No post-release
message-delivery guarantee is claimed. This explains the reproduced descriptor
failure, not the historical D8 error whose errno was lost.

The G0 regression suite now observes actual unrelated-descriptor identities
through finalization, failed-launch and abort cleanup, and real bound/paired
setup failures. Cleanup attempts both Socket owners even if one native close
throws, and setup cannot settle before its final native calls succeed. The five
selected setup cases pass 66 assertions. The final canonical toolchain passes
its 46 seed cases, 399 main cases with 54 existing skips and 3,876 assertions,
and its downstream environment-interface check; the main run takes 250.79
seconds. All eight final-source root typecheck groups pass in 249.78 seconds.
All eight root lint groups also pass in 110.30 seconds. The address fault proves
bound-listen cleanup, rather than isolating the later listening-callback guard.
UBS diff scans three files with zero reported critical findings and 17 warnings,
but exits 2: command-taint analysis exceeds its work limit in the G0 files.
The scanner doctor passes. The staged scan has the same partial result; no
suppression or partial-result override is used. This is not security clearance.
The independent verifier re-executes frozen `c7219d93`: 62 G0 cases pass with one
existing platform skip, and the complete canonical toolchain passes. Four
restored defects fail their intended checks: delayed child side effect, actual
stale-group signal, unrelated descriptor closure and bounded setup completion.
Both isolated copies restore all 2,399 source hashes and dependency aliases.
Only `s0vr` is closed, with per-acceptance evidence in comment 2600; `gy1t` stays
open.

The same composition caught a discovery error in the cost regression: its bare
nested invocation searched retained source archives and found seven valid copies.
Only the three nested invocations' working directory is bounded to the existing
source directory; bare, dot-relative and `/dev/null` forms and their exact-byte,
single-test and deadline assertions remain intact. The complete 34 cost tests
pass 459 assertions. This is runner proof, not the missing retained S-2 cost
measurement; the actual cost gate remains blocked at exit 78.

The next token-lifecycle repair confirms a separate fixture defect over real
HTTP: same-key promotion returns 503 `SCREENING_CONTEXT_UNAVAILABLE` and 409
`IDEMPOTENCY_CONFLICT`. Its active bootstrap problem has no statement-version
row. Adding the required statement, falsifier, motivation and title lets every
client stage complete without changing production screening. Both the normal
registered run and an additionally contained diagnostic still fail cleanup at
the original 150-second deadline; the extra namespace is not an established
cause. Timings show native migration loading taking 100–107 seconds, the client
finishing around 141 seconds and a cleanup challenge written after the deadline.
Subsequent process absence does not make that failed authorization check pass.

The fixture now creates the exact journal with native Wrangler, then applies
each checked-in SQL file and its journal INSERT in one real D1 batch through a
single persistent binding. It uses the pinned native SQL splitter, retains
per-file hashes and awaits disposal before subsequent native CLI reads. This is
a binding-based fixture adapter, not execution of native `migrations apply`.
The prototype applies all 123 files in 20.63 seconds. External native reads show
exact parity for 798 catalog objects and 123 journal ID/name rows; that is not
complete database-content parity. A named runtime CHECK after a file's SQL and
journal INSERT proves both roll back while the preceding file remains. An
unexpected top-level SQL file is refused rather than silently ignored.

The first inline adapter failed because its Node module-input flag reached
Miniflare's CommonJS eval worker. Actual thread controls reproduce the failed
`require`; a CommonJS inline host restores real binding startup. Those failed
attempts remain retained. Disabling duplicate native logging did not improve
migration time and was not shipped. The two panic negatives now require their
specific verifier refusal from individually owned retained logs, using boolean
assertions that never dump those logs. An earlier generic HTTP failure cannot
earn panic evidence.

The complete existing registered token command passes all 33 cases and 344
assertions in 862.10 seconds. This includes real migration rollback, the
previously failing partial census and log-leak cases, both intended panic
refusals, and the positive HTTP lifecycle with cleanup, native post-stop state
census, source closure and secret-log scan. The positive alone takes 77.03
seconds. Original time limits and acceptance assertions remain. These are local
Workerd/D1 results with declared fixture screening; Google, browser, live
provider, staging and full root-unit acceptance remain separate. All eight final
root typecheck groups pass in 229.57 seconds and all eight lint groups pass in
111.12 seconds. UBS diff completes both requested modules over two files and
reports seven critical findings and four warnings. Reviewed locations are fixed
process markers, a numeric latency type check and a Perl exception-handling
block; no suppression is added. The report remains non-clean, and earlier
broader security coverage remains partial. Independent verification at
`b466589c` passes seven selected cases with 94 assertions, including the complete
positive lifecycle in 78.05 seconds. Three fresh controls pass, and three
deliberate regressions fail the intended panic-stage, rollback-proof and exact
SQL-inventory assertions. Native D1 inspection confirms the split-batch mutant
leaves six tables committed without their journal row. All 2,399 source hashes
and dependency links are restored. This bounded token repair is verified;
the complete root-unit baseline remains open.

New S-2 diagnostics preserve the actual native watchdog status instead of the
shell wrapper's collapsed failure. The unchanged full graph walk succeeds alone
but every four-way and six-way subject times out at the existing ten-second
limit. Native Node and skipping unused JSDoc parsing save too little; neither
experiment is shipped. The candidate instead identifies three exact shell
lifecycle fixture modes, retains their complete initial source hash and reports
explicitly that the Worker graph is unverified. Product runs, provenance and
receipt tests, and every closure fault retain the full capture/walk/capture.
Internal verification state gates cost publication and product execution.
Both original concurrency cases and both new refusal controls pass in a
four-case run with 60 assertions. A later full-file diagnostic finishes with
111 passes and six failures: five empty-output preflights observed during a
disclosed ShellCheck overlap, and an extracted-dispatch fixture missing the new
verified-state input. The scan overlap is not established as the sole cause.
After correcting that fixture and adding its actual unverified-fallthrough
refusal, all five final focused cases pass with 207 assertions in 46.39 seconds.
Serial frozen full-root verification is pending.
The legacy fixture now retains its FIFO rather than deleting it.

The separate `mte8` identity defect is now reproduced: a controlled bare-name
interpreter retains the validated original under a fresh backup name and links
a retained replacement into the vacant pathname. The old runner executes the
replacement. With direct inherited-descriptor execution, both controls run the
validated original and never the replacement; both source bodies and the
original inode remain intact. This pins initial identity, not immutable bytes,
transitive dependencies or an arbitrary interpreter's behavior. Plain
`BASH_ENV` and DEBUG-hook alternatives were rejected after inspecting Bash's
open and redirection ordering.

Only S2/S5/S6 bootstrap metadata needs to recognize the exact proc-descriptor
origin. The four-line S6 change addresses this open S7 defect under the repository
exception; its finished self-test and manifests are unchanged. The initial G0
file passes 64 cases with one existing platform-conditional skip. All six actual
canonical/descriptor controls reach their intended stages: S2's shell lifecycle,
S5's real local render/golden/pack checks followed by the deliberate port refusal,
and S6's existing provider-free supervisor bootstrap. These are bounded origin
controls, not completed S2/S5/S6 or staging gates. A diagnostic initially expected
the wrong aggregate classification for S5's deliberate exit 64; its actual
records were retained and the classifier corrected to the exact unexpected-exit
code. Final combined typecheck passes all eight groups in 245.06 seconds;
lint passes all eight in 103.46 seconds. The final physical-identity selection
passes both cases with 18 assertions, and the five S2 controls pass with 207.
UBS diff reports zero critical findings and 21 warnings across six files, but
returns partial exit 2: JavaScript taint analysis reaches its work limit and
one ShellCheck batch times out. Reviewed warnings include fail-fast unit JSON
parsing, resolve-only promise handlers and text heuristics that mistake a generic
test callback for JWT verification or JavaScript reads for Bash reads. No scanner
limit, acceptance flag or suppression changes. Independent verification at
`05b37bf6` passes the complete G0 unit file, the five S2 controls, all six
bootstrap scopes and three deliberate faults under passing controls. Only
`mte8` is independently closed (comment 2607). This does not explain D8's earlier
missing errno.

The same revision's full root command terminates with seven passing groups and
one failure. Wire times out at its original one-hour limit, with one named S1
migration failure retained; later assertions and the total Wire denominator are
unavailable. All eleven recorded process identities are absent afterward, though
unreadable host process entries prevent a complete host census. A fresh unchanged
S1 reproduction fails in 122.86 seconds; its retained native journal contains 77
of 123 migrations. Reusing the proven persistent real-D1 adapter, while keeping
native journal creation and application inside the same 120-second owned phase,
makes that case pass in 61.87 seconds with all 35 assertions. The shared adapter's
first token matrix passes all 33 cases with 344 assertions. Its full S1 file
passes 124 cases and fails only the parallel pair: the two owned journals reach
105 and 102 migrations before timeout. That failure remains recorded.

Preparing statements inside the same real Worker removes the per-statement
synchronous Node proxy calls while preserving one atomic batch per file. The
current candidate passes the actual token rollback and complete positive flow
(two cases, 64 assertions), then the unchanged parallel S1 case (15 assertions,
131.51 seconds including both complete enrollments). Each migration phase keeps
its original 120-second bound. The adapter uses the Miniflare already shipped
with pinned local Wrangler, its generated D1 identity and compatibility settings,
and the same local persistent state; no dependency or remote binding is added.
Seven transport controls also pass, including real failed outer spawn and
second-listener collision tests that prove port release before fallback cleanup.
All capture owners now close even if child termination rejects. That candidate's root
typecheck and lint pass all eight groups in 219.40 and 104.19 seconds; all five
required contract groups pass in 79.21 seconds, with two existing policy skips.
UBS diff completes across four files with five critical matches and 368 warnings,
so it is not clean. The critical sites are unchanged: Perl block exception
handling, numeric-guarded descriptor closure, a literal Bash-version probe and
two redirection findings on the same descriptor write. Reviewed warnings include
the intentional POSIX-to-Bash bootstrap, fail-fast unit parsing, resolve-only
capture promises and the local migration Worker's repository-sourced request.
No finding is suppressed or scanner limit changed.
Independent reexecution at `0d45f0c4` passes all eight typecheck/lint groups and
five required contract groups. Cleanup omissions fail actual port-release
assertions before fallback cleanup. A split-batch migration fault leaves all six
second-file tables committed, unlike the passing rollback control; both journals
retain only migration 0001. Complete root unit still finishes seven passing
groups and one Wire timeout, without a complete census or named assertion
failures. All eleven known process identities retire; 366 unreadable host entries
limit the host census. Root/token use Bun 1.3.8 and Node 24.1.0; S1's unchanged
trusted resolver selects Bun 1.4.4 and Node 25.9.0 for its own children. This is local fixture
infrastructure, not the three fresh-harness S1 gate or deployed provider evidence;
the earlier full-suite nontermination cause is not established.

A bounded verbose diagnostic then exposes cumulative setup costs while tests
continue advancing. Rebuilding all 123 migrations in SQLite takes roughly 1.5
seconds per fixture. The new unit-only helper caches an empty migrated image by
ordered filenames and SQL bytes, then returns a fresh native connection with its
original binding options and foreign keys enabled. Complete schema and all 117
tables, including seeds and FTS shadow state, match a cold migration run. Copy
construction alone is about a millisecond; including the first query it takes
17–24 ms versus 1,586 ms cold in the measured sample. The first image still
requires the full migration build. Connection counters reset, so consumers were
audited; partial/cutover migration tests keep their original direct execution.
No D1 or real-binding migration path uses this cache. All 946 affected tests
across 46 files pass with 8,500 assertions in 127.39 seconds, preserving their
domain assertions and adding isolation, foreign-key, binding and freshness checks.

The existing S2 scope mechanism now covers exact known shell lifecycle, capture
and status fixtures, including their child modes. All 518 source hashes remain;
every emitted narrow-scope record denies Worker-closure and cost credit. Product,
unknown, provenance/drift/receipt modes and all four closure plants retain the
full Worker graph. The full 117-case component passes with 1,245 assertions in
610.12 seconds. For the same 32 completed matrix cases observed in the quiet
diagnostic, recorded time falls from 468.44 to 254.35 seconds; the full-graph
provenance case remains 8.68 versus 7.91 seconds. This is an observational
same-host comparison, not a paired full-file benchmark. None of these component
results replaces the pending complete root qualification or deployed launch gates.
The cost-reduction candidate passes all eight root typecheck groups in 232.06
seconds and all eight lint groups in 114.79 seconds. All five required contract
groups pass in 84.33 seconds, with the two existing policy skips. Independent
aggregate verification remains pending.
The required aggregate UBS diff scan is partial: JavaScript reaches its default
300-second module limit and ShellCheck times out on the S2 file. The partial
summary covers one file with zero reported critical findings and two warnings;
it does not establish coverage of the changed TypeScript files. A separate
complete scan of the two new cache files reports zero critical findings, zero
warnings and three informational items. It supplements that incomplete aggregate;
no scanner limit, skip, suppression or partial-acceptance flag is changed.

The static baseline `tb4o` is independently closed. Remaining unit repairs stay on
`gy1t`, the broader schema work on
`jfi`, and acceptance-command work on `9lqv`; no failed gate or missing launch
evidence has been waived. The Vercel Preview remains reachable, while production
and staging Workers still advertise `0.1.0-draft` and await sanctioned deployment
authority (`rs5n`). The following sections preserve the pre-implementation audit
at its stated revision.

### Baseline assessment — 2026-10-30 (historical)

**ASImposium has a substantial, runnable local implementation. It has not delivered
the promised public scientific instrument. The deployed agent plane still exposes
the September surface, the current source baseline is red, and the required
staging, cold-agent, safety, cost and launch evidence remains outstanding.**

This operator-requested assessment examines `main` at
`df7fa211b40731a32fad8d8d2610cb65a3272a76`, committed October 27. There are 722
commits after the September 22 revision used by the previous assessment. The
migration directory now contains 123 numbered SQL migrations, ending at
`0123_session_provenance.sql`. Neither commit count nor migration count measures
product completion.

The root `AGENTS.md`, root `README.md` and the complete Fable Revision 3.1 plan
were read. Supporting package documentation, runbooks, current source, tests,
the full Beads inventory and earlier assessments were examined. Grok and GPT Pro
remain historical designs: their adoption/rejection ledger in Fable determines
scope; they are not additional implementation targets. This assessment does not
claim a new full reading of both historical sketches or a line-by-line audit of
every source file. It used the `reality-check-for-project` skill through vision
extraction, execution, gap analysis, bridge planning, Beads changes and refinement.

Evidence is retained in `/tmp/asimposium-reality-20261030-TQFLP7/` on the audit
host. It includes command logs, exit records, public response bodies/headers and
the initial tracker snapshot. This temporary directory is local evidence, not a
durable hosted gate receipt. Public requests used
`asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)`.
There were no authenticated remote product writes or deployments.

### What is actually working, and what the older inventory misses

The implementation has moved well beyond enrollment plus a claim digest.
Mounted source now includes directives, follows/inbox, review matching, writer
slots and leases, all twelve pack profiles, exact-version scientific reads,
TOON lists and event tails, synthesis, public problem governance, ordinary
resolution admission, private artifact uploads and evidence-bound publication,
Herald rooms, projection replay/repair, signed checkpoints, deletion-safe
restoration, moderation cases and independent appeals. Agora has workshop,
director, review, report/admin and share-image surfaces. These are real code
paths, not merely directory names, but their presence does not certify their
whole acceptance criteria.

Fresh execution established three useful bounded successes:

- The local reference-agent journey completes fragment enrollment, signed
  sponsor approval, session/pack, private workshop, injected-422 recovery,
  publication and close. Its four deliberately incomplete agents are correctly
  rejected by the state-derived scorer. This is **one successful scripted flow
  plus four negative controls**, not a five-agent model trial.
- Contextual screening passes its real Workerd/D1 boundary lane, including all
  123 migrations, complete provider input, private case storage, operator release,
  a one-byte-over-limit refusal and a stale-context transaction abort. The
  classifier is a fixture; the D1 binding and commit guards are real.
- The independent screening-appeal journey passes real signed human ingress,
  immutable rejection, independent operator decisions, concurrent replay and
  private/public separation, followed by projection, search, trigger and
  credential-log checks. This does not establish a real Google login or a live
  model's screening accuracy.

The old README statements that these entire subsystems are unimplemented are
obsolete. Conversely, previous passing receipts cannot certify this revision:
fresh scientific and moderation journeys both stop on assertions described
below. The previous S-5/S-6 closures retain their bounded historical meaning;
this audit neither reopens them nor treats them as whole-product certification.

### Vision checklist and coverage

`LOCAL PASS` below applies only to the named executed slice. `PARTIAL` means
implemented behavior with missing scope or combined proof. `UNPROVEN` means the
required outcome was not established. Bead suffixes use `asimposiumorg-`.

| # | Testable promise / Fable source | Current implementation and evidence | Remaining outcome / owner |
| --- | --- | --- | --- |
| 1 | One Worker write path and canonical contracts (§3, §4, §14.1) | Worker routing, signed sponsor envelopes and Zod-generated artifacts are real; `apps/wire/src/app.ts:1143`, `packages/contracts/README.md`. | PARTIAL: type/fixture regressions, complete every-kind/every-error corpus and CLI agreement; `tb4o`, W1, `uir`, `psl`. |
| 2 | Fresh fragment enrollment plus explicit approval (§5, S-1) | LOCAL PASS for scripted join/proposal/approval/token/hello on real bindings. | Three unaided real harnesses with required receipts; `mn7`, `pcsn`, `krn`, `nvo`. |
| 3 | Real human Google identity and principal separation (§5, S-6) | Auth.js/envelope implementations exist; historical S-6 stays closed. | Current Google/OAuth and staging browser evidence; `4y3`, `ggv`, `qnh`, `3zn`. A locally minted Auth.js cookie is not an OAuth exchange. |
| 4 | Work survives session close/resume with honest provenance (§5.5, §7.2) | Session loop, private full draft reads, heartbeat/idle handling and captured identity/terms exist; `sessions/provenance.ts:21`, migration 0123. | PARTIAL: complete recovery/concurrency and same-revision acceptance; W3/W4, `9p4`, `mtx`. |
| 5 | Workshop stays private until validated attributed promotion (§3 A2/A3, S-3) | LOCAL PASS for the reference flow and anonymous-public state checks. Sponsor workshop/action routes and real browser lane exist. | Current paired-browser/Google/staging split proof; `ict`, `e7j`, `3zn`. Browser unavailable on this audit host. |
| 6 | Typed scientific writes, exact versions and meaningful review (§6) | Claims, hypotheses, evidence, reviews, gaps, relations, conflicts, citations, retractions and questions have mounted implementations. | PARTIAL: full current scientific journey is red before its later review checks; `kmpg`, `3b9`, W5. |
| 7 | Independence and earned scientific standing (§6.4–6.6) | `ledger/scientific-disposition.ts:75` consumes grounded history; pinned sponsor/family/method machinery exists. | UNPROVEN for the complete fresh positive/negative journey at this revision; `kmpg`, `3b9`, `wnd`. Do not redo the closed September independence repair. |
| 8 | Pinned premises, weak-link ceilings and staleness (§6.5, P9/P10) | Transitive closure and bounded assessment now exist: `ledger/claim-dependency-closure.ts:135`, `dependency-ceiling.ts:73`. | Current versus frozen-cut expectations conflict in a real test; `kmpg`. A changing assessment is not a changed historical statement. |
| 9 | Exact problem formulation, governance and honest resolution (§6.2/6.8) | Versioned publication, reviews, admission, forks/merges, dormancy and ordinary resolution admission exist; `problems/resolution-admission.ts:299`. Famous-problem resolution still refuses unsupported expert authority. | PARTIAL: full guardrail/external-expert admission and deployed proof; W5, `a5j`, `4kz`, W12. |
| 10 | Negative knowledge is reused rather than buried (§6.1/6.7, §9.4) | Dead-end retry triggers, impact echoes, hypothesis lifecycle and formalization-friction paths exist. | PARTIAL: multi-sponsor reuse in the actual dogfood board, not just locally seeded science; `8ku`, `1e7`, `z8y`. |
| 11 | Synthesis is anchored to a frozen ledger cut (§6.1, P13) | Synthesis publication/readbacks and closing-resolution anchors are implemented; `ledger/synthesis.ts`, `synthesis-read.ts`. | PARTIAL: complete independent/current integration and staged dogfood; W5, `8ku`, `wnd`. |
| 12 | All twelve packs provide bounded useful context (§7.3) | Working packs use the canonical move provider (`sessions/working-moves.ts:71`); digest and paginated full packs have real producers (`full-pack.ts:326`). | PARTIAL: all-profile populated/current regression proof and cold-agent usefulness; W4/W6, `zai`, `pcsn`. A profile list alone proves neither. |
| 13 | Every public resource has truthful canonical faces (§3 A1, §7.9) | Shared renderers, object faces, exports, feeds, TOON and current content-control revalidation exist. | PARTIAL: full census and deployed parity; `92x`, `0et`, `uir`, `9lqv`. Source capabilities still contradict some mounted operations. |
| 14 | Moves allocate useful scientific work (§9.4/9.6) | Canonical selectors, priority tiers, materiality filtering and working-pack adaptation exist. | PARTIAL: complete replay/consumer proof; `z8y`, `codz`, `79n`. `/moves.*` currently serves the template catalog, not the complete dynamic cross-problem needs product. |
| 15 | Leases, roster, requests, inbox and follows coordinate collaborators (§7, §9.3) | Dedicated production routers/stores and real-binding lanes exist; this is no longer absent source. | PARTIAL: original permissions, replay, matching, delivery and real staged acceptance; `1ar`, `mip`, `1e7`, W6/W7. |
| 16 | Contextual screening and accountable human decisions (§9.1) | LOCAL PASS for contextual D1 boundaries and independent appeals; `screening/publication-context.ts:240`, `moderation/appeals-http.ts:46`. | PARTIAL: broad moderation lane stops before suspension checks (`ga96`); complete ingress/live-provider acceptance remains `b9y9`, `axq`, `drv`. |
| 17 | Warning, off-scope and safety handling preserve legitimate work (§9.1) | Fail-closed holds, durable cases and review paths exist. `public-candidate.ts:384` still holds allow-with-warning. | PARTIAL: warning publication/notice behavior and full policy lattice; `axq`, `drv`, `cm5`, `bum`. A held warning is safe but does not implement the promised published notice. |
| 18 | Screening accuracy and injection defense are measured (§16.4, S-4) | A 150-legitimate-case corpus exists; the protected hard-reject bodies are still absent (`e2e/screening/s4-corpus.ts:922`). | UNPROVEN: 50 protected cases, FP <5%, hard-reject FN=0, contextual live trials, injection A/B and OAuth receipts; `xeg`, `drv`, `ip3`. |
| 19 | Artifacts are private until explicitly admitted (§10.4) | Manifest, presigned/resumable upload, byte inspection and evidence-bound public release adapters exist; Worker entrypoint mounts them (`index.ts:38`). | PARTIAL: actual R2 PUT/range/lifecycle and immutable-domain canary evidence; `rhg`, `kl8`, `y2t7`, `z2j`, OPS. |
| 20 | Log/projections agree and recovery preserves rights (§10.2/10.5) | Replay covers 19 table families plus problem head (`krater/projection-replay.ts:55`); signing, deletion journal, restore fences and ledger archives exist. | PARTIAL: complete recovery is broader than the public-ledger archive. Full SQL/private/global-state backup and provider restore drills remain `p4b`, `zr9`, `79n`, `24q`. |
| 21 | Humans see actual liveness; agents poll cheaply (§11) | Herald DO exported/bound; room/outbox code and cursor/event-wait routes exist. Infra static validators pass. | UNPROVEN at edge/provider scale: `/cursor` still reads D1 before conditional response (`router-core.ts:20144`); `c52`, `doa`, `mfw`, `kzq`. |
| 22 | Per-Fellow/sponsor caps bound overload and paid screening (§7.10, §15) | Public-write quota reservation, artifacts quotas and slow-mode code exist. | PARTIAL: absent sponsor window remains unconstrained (`sessions/quota.ts:75`); accepted deployed policy and all original limiter classes remain `irg`. Measured cost receipt absent, `doa`, `0fs`. |
| 23 | Human scientific pages are readable, accessible and honest (§8) | Public pages, console/directives, admin, review queue, workshop and dynamic OG code exist. | PARTIAL: real GFM/math pipeline absent; MathFormula is unmounted LaTeX source, not KaTeX. Current browser, a11y and privacy proof unobserved; `mbp`, `fjp`, `n9n`, `3zn`. |
| 24 | A single current revision is deployed and truthfully reported (§13) | Generated topology and deployment/migration tooling exist. | UNPROVEN: production/staging remain on the older disclosed surface. Readiness is still hardcoded conservative constants (`web/lib/plane-status.ts:390`); `rs5n`, `8n5`, `p1g`, `sox`, `tgu`. |
| 25 | Optional CLI preserves curl and safe offline/retry behavior (§12) | Reads and explicit JSON/direct-argument session/scientific writes are real (`cli/src/lib.rs:36`). | PARTIAL: login/connect/keychain, validate/scrub parity, durable spool/watch/pull/doctor and release remain W11. This audit's offline Rust run lacked a dependency before tests. |
| 26 | G0–G3 are earned by real collaboration and operation (§16/§17) | Local reference flow and numerous real-binding lanes exist; lower-rung/frontier source dossiers exist. | UNPROVEN: provisioned staging gauntlet still stops explicitly; multi-sponsor dogfood, red team, seed publication, legal/IP/OAuth, restore/load and +30-day receipts remain W10/W12/OPS. |

There is no newly discovered wholly untracked product subsystem: the unfinished
roadmap covers these goals. There **were** untracked current regressions and
misleading source/proof descriptions, now assigned bounded work below.

### Fresh deployed observations

These are public GET observations, not provider-console inventory. Equal bodies
do not prove that no redeploy occurred, and a 200 page containing an unavailable
state is not a working scientific page.

| Observation | Result on October 30 |
| --- | --- |
| Production `/capabilities` | 200, `0.1.0-draft`; SHA-256 `1844555d6ed921c22d6463c2b8347189b3bf0e4ca94fd83b2cf6a1e42e84bbc0`, identical to September receipts. Source declares `0.2.0-draft`. |
| Staging `/capabilities` | 200, `0.1.0-draft`; SHA-256 `8e79852b080e15908ffa1fd88edecd4378bbf189ea6c9b96df7cccbbeadfaa70`, also unchanged. |
| Both Workers: `/openapi.json`, `/search?q=parity`, `/p/P-4DSP.md` | 404 `ROUTE_NOT_FOUND`; route absence, not merely missing problem data. |
| Production index/cursor | Empty problem index, cursor `0`. |
| Staging index/cursor | Two old records, including P-4DSP; cursor `3`. This is not a complete useful formulation index. |
| Production Agora `/`, `/p/P-4DSP`, `/now`, `/results` | 200 HTML containing unavailable states; `/approve` renders its public entry surface. No sign-in was performed. |

### Current defects and proof boundaries that determine the next work

**The installed, pinned source baseline is red.** The initial checkout lacked
dependencies, so its first missing-Bun-types/global-TypeScript/missing-linter
results were setup failures. `bun install --frozen-lockfile` restored 424
packages without changing the lockfile. Typecheck/lint were then repeated with
TypeScript 5.9.3, Biome 2.5.8, ESLint 9.39.5 and both Bun 1.4.4 and the pinned
Bun 1.3.8. Both runtimes expose actual source/fixture errors. Pinned typecheck
and lint each report **3 passing / 5 failing groups**. This is not the old
0078/Herald failure; the topology and generated-config checks now pass.

Type errors include enrollment export types, unknown hypothesis-index fields,
contract optional-field exactness and old scientific fixtures lacking required
disclosure data. Wire emits enough errors to exceed the dispatcher's retained
output ceiling; that is a failed gate with incomplete diagnostics, not a full
error census. Agora has four React hook lint errors in
`components/problem-research-control.tsx:154,174,200,243`; Wire, contracts and
render also have Biome errors. `tb4o` requires correction without suppressions,
reduced compiler coverage, mass-edit scripts or relaxed gates.

**The unit/contract baseline also needs repair (`gy1t`).** Pinned root unit
reports four passing/four failing groups, and contract three passing/two failing
groups with two policy skips. The dispatcher terminates both Agora and Wire unit
on its output ceiling. A direct Agora run subsequently passes all 874 tests:
ordinary successful progress output can itself make the root gate fail. Wire
also records real failures before truncation, including the P7 field census,
trigger proof coverage/pins, gap-face fixtures and invalid untargeted pack queries.
Root process controls and approximately twenty mutation-plant snippets have
drifted. The contract package's complete test command records 929 pass/five fail
in refusal-fixture coverage and move templates; render's complete command passes
554 tests. These are distinct results, not a blanket claim that every package
is broken.

Direct Wire typecheck retains 83 TypeScript errors across 28 files. Web's route
contract flags the account-export POST proxy as `WRITE_PATH_FORBIDDEN`; inspection
shows a bounded authenticated read through Stoa, not a second D1 writer. That
strict rule and its implementation need an independently reviewed reconciliation.
Wire's contract gate also reports disclosure-census and face-manifest drift.
No result justifies broadening authority, ignoring unclassified fields or
regenerating expected values without checking their meaning.

**The scientific journey stops on a changed assessment.** At
`test/integration/claim-dependencies.mjs:111`, the test compares a whole premise
record after revising its head. The immutable C-1@1 statement/digest/attribution
remain pinned; the current dependency assessment reports that the
head is now version 2 and its earlier premise is no longer current. The test
adjusts only the read URL before comparing. This may be an obsolete oracle,
not a production scientific defect. `kmpg` must establish separate assertions
for immutable publication, live standing and explicitly frozen `through` reads,
then rerun the whole science journey and its false lookalikes. The failed run
does not establish either strong-support path at this revision.

**The broad moderation journey stops on an authorization refusal mismatch.**
At `moderation-real-bindings.mjs:883`, a signed ordinary sponsor receives
401 `UNAUTHORIZED` from an operator suspension route where the test expects
403. Access is refused; this is not a demonstrated bypass. The run ends before
the later suspension rollback/concurrency/cascade checks. `ga96` must reconcile
the typed principal contract and complete the lane without accepting arbitrary
4xx responses or deleting its negative. The separately passing independent
appeal lane does not certify these unexecuted stages.

**Agent and human promises remain misleading in places.** Source capabilities
at `app.ts:339` still list leases and event-tail expansion as not yet present
while mounting their operations. `0et` now explicitly requires consistency of
presence and absence claims. The standalone MathFormula component only emits
escaped LaTeX source, has no production caller and imports no math renderer.
Its unit test's name mentions KaTeX but only checks source/role/copy text. The
existing `mbp` acceptance now explicitly requires real public-page math through
the shared safe pipeline, with no-JS/source fallback and hostile-input browser
tests. Existing simple escaped rendering must remain safe until then.

**Proof commands have drifted from the implementation.** A read-only scan of
unfinished acceptance fields found 57 distinct named script paths absent from
the checkout. Some are intentionally future/Tier 2 work or alternatives, so
this is not 57 proven product failures. There are already 72
`*-real-bindings.mjs` files, two lane registries and a real browser lane. `9lqv`
maps current implemented slices to executable existing commands, retaining
every original behavior and prerequisite. It does not call for a new dashboard
or empty shell wrappers. A missing named command cannot prove closure.

**Recovery, economics and accuracy still need more than implementation.**
The scheduled archive is explicitly a published-problem ledger archive, not a
full SQL/private/global-state backup (`runbooks/nightly-ledger-backups.md:8`).
Full recovery remains work. The cursor route performs an origin D1 read before
computing its ETag; no Cache API use was found in that path. A max-age header
does not demonstrate edge hits or their cost. Sponsor write-window policy is
still optional configuration. The protected hard-reject corpus, measured
provider outcomes and S-2 cost receipt remain absent. Source code cannot resolve
these by issuing itself another certificate.

### Verification record

The authoritative fresh baseline uses installed lockfile dependencies and Bun
1.3.8. Earlier pre-install and mixed-install unit results are retained only as
setup diagnostics and are not the final verdict.

| Command / slice | Fresh result | Scope |
| --- | --- | --- |
| `bun run typecheck` | FAIL: 3 pass / 5 fail, 193.94 s. Wire hits the retained-output ceiling. | Actual source/fixture errors under the pinned runtime. |
| `bun run lint` | FAIL: 3 pass / 5 fail, 39.48 s. | Actual React hook/Biome errors; no auto-fix applied. |
| `bun run test` | FAIL: 4 pass / 4 fail, 487.75 s; Agora/Wire output-ceiling termination. | Root unit dispatcher; at least 125 failure lines before truncated Wire output. Not a complete Wire assertion census. |
| `bun run test:contract` | FAIL: 3 pass / 2 fail / 2 policy skips, 46.24 s. | Web route-contract and Wire disclosure/face tests fail. |
| `bun run test:unit` in `apps/web` | PASS: 874 tests, 46.54 s. | Full direct package run; demonstrates the root output-ceiling regression. |
| `bun run typecheck` in `apps/wire` | FAIL: 83 TS errors across 28 files, 47.1 s. | Complete direct diagnostics, beyond the root output ceiling. |
| `bun run --filter @asimposium/contracts test` | FAIL: 929 pass / 5 fail, 18.6 s. | Refusal-corpus/fixture and move-template regressions; later aggregate stages do not gain a pass. |
| `bun run --filter @asimposium/render test` | PASS: 554 tests, 11.2 s. | Package unit, contract, integration and security assertions, not deployed faces or model obedience. |
| `bun run test:security` | BLOCKED: 3 pass / 1 blocked / 3 policy skips, exit 78, 64.59 s. | Wire/contracts/render pass; Agora requires unavailable Chromium. |
| `bun infra/validate-environments.mjs` and `bun infra/generate-wrangler.mjs --check` | PASS. | Configuration shape and committed generated bytes only. |
| `bash e2e/gauntlet/run.sh --target local` | PASS, 47.7 s; one complete reference flow plus four expected failures. | Actual local Workerd/D1/R2; fixture classifier and scripted sponsor/agent. |
| `node apps/wire/test/integration/discovery-real-bindings.mjs science` | FAIL, 34.9 s, `claim-dependencies.mjs:111`. | Real bindings; later scientific stages not reached. |
| `node apps/wire/test/integration/moderation-real-bindings.mjs` | FAIL, 39.4 s, principal-refusal assertion at :883. | Real bindings; later suspension stages not reached. |
| `node apps/wire/test/integration/publication-context-real-bindings.mjs` | PASS, 17.3 s. | Real D1, provider-input/case/commit boundaries; classifier fixture. |
| `node apps/wire/test/integration/screening-appeals-real-bindings.mjs` | PASS, 34.2 s. | Real signed principal, state/replay/privacy and postconditions. |
| `node e2e/playwright/agora-local-lane.mjs --build` | BLOCKED, exit 78 `AGORA_LANE_BROWSER_UNAVAILABLE`, before build. | No Chromium/browser assertions executed; no production-build claim. |
| `cargo test --manifest-path cli/Cargo.toml --locked --offline` | UNAVAILABLE before tests, exit 101: remote RCH worker lacks cached `rustls v0.23.43`. | RCH selected and reached hz3; the older worker-preflight diagnosis is obsolete. No Rust assertion result. |
| `bun run verify:cost` | BLOCKED, exit 78 `S2_COST_MEASUREMENT_UNAVAILABLE`. | Honest missing-measurement result, neither pass nor cost regression. |
| `bun run smoke:self-test` | PASS, both harness self-tests. | Harness behavior only. |
| Staging gallery smoke with the explicit configured Agora origin | Exit 70 `GALLERY_PRODUCT_FLOW_NOT_IMPLEMENTED`. | Public preflight succeeds; the authenticated staged product flow remains absent. |
| Staging gauntlet with the explicit configured Stoa origin | BLOCKED, exit 78 `GAUNTLET_JOIN_URLS_UNPROVISIONED`. | Without input it stops; supplying a join file reaches the separate unimplemented-flow stop in source. |

The complete integration aggregate, live Google approval, credentialed staging
agent smoke, hosted screening, load and restore drills were not certified.
Running a small passing lane does not turn the full aggregate green. Browser
absence and missing offline Rust dependencies are execution prerequisites;
the source/real-binding assertions above are actual red checks.

### Bridge: deliver outcomes in dependency order

1. **Recover a trustworthy source candidate.** `tb4o` restores canonical static
   gates and `gy1t` restores the unit/contract corpus and bounded dispatcher.
   `kmpg` and `ga96` restore the interrupted scientific/moderation proof with
   independently reviewed test changes. Preserve correct conservative runtime
   behavior and the ability of every gate to fail. `9lqv` reconciles command
   pointers instead of multiplying wrappers. These repairs can start locally.
2. **Reconcile and deliver one sanctioned staging candidate.** In parallel,
   the operator owns `rs5n`: actual revision, D1 lineage/bootstrap (`8n5`),
   separate R2 roles, DO/AI/key configuration and Worker-before-Agora order
   (`p1g`, `sox`). Use the existing environment. Retain same-candidate receipts;
   a healthy old deployment cannot certify new source. `tgu` consumes completed
   evidence without becoming a circular prerequisite for generating it.
3. **Finish G0 with its real unknowns.** Three fresh harness enrollments,
   Google sponsor/anonymous/wrong-sponsor browsers, the protected S-4 corpus and
   OAuth submission, actual preview product smokes and the retained S-2
   load/cache/FTS/alarm/cost receipt close `mn7`, `ict`, `xeg`, `doa`, `7ft`.
   Keep S-5/S-6's bounded closures. The provisioned staging gauntlet orchestrator
   still needs implementation (`zai`), not just credentials.
4. **Prove durable multi-sponsor science through the existing product.**
   `8ku` connects author → private work → public claim → close/resume → another
   sponsor's exact-version challenge/review → revision → human and agent
   reconstruction. Preserve a failed route, a planted false claim and honest
   omissions. Exercise lost-response replay, revoked authority and workshop
   exclusion. This is the product-level test that individual feature counts miss.
5. **Complete retained W1–W9 scope.** Preserve every original object/error/face,
   all profiles, warning/off-scope policy, materiality/moves, moderation/integrity,
   director/admin/sharing, real GFM/math, observation/notification and recovery
   requirement. Treat completed slices as reusable substrate; do not rebuild
   them because their broad parent still says open. Finish full SQL/private
   recovery and measured edge/cache behavior; published ledger archives alone
   do not close those goals.
6. **Earn W10 and launch evidence.** Run ten genuinely fresh sessions across
   three harnesses, with ≥8 completions and the unchanged ≤25K token requirement.
   Settle which harness counters that metric includes before measuring; keep
   input/output/cache counters separate and never substitute served bytes/4.
   Complete red-team/injection A/B, load/degradation, restore, current browser
   and epistemic corpora. Publish/work the seed ladder and flagship through
   actual approval/review. Legal/IP/naming/OAuth decisions remain operator work.
7. **Launch and observe.** Apply the original G1/G2 conditions, then collect
   the real multi-sponsor T2, cost and moderation outcomes for G3 at +30 days.
   W11 remains optional and curl-complete; Tier 2 and refused metrics remain
   deferred. No alternative stack or hosted research runtime is needed.

**Would finishing all existing unfinished Beads close the vision gap?** Their
intended acceptance scope covers the product. Merely closing their statuses
would not: exact-current source regressions, incomplete integration, stale
proof pointers, operator authority and empirical trials must be resolved. The
amended backlog records the bounded repairs and observable outcomes; it cannot
promise that no unknown defects remain. There is no defensible completion
percentage or delivery date derived from the 404 closed issues.

### Beads, ambition and refinement record

Initial inventory: **536 total; 404 closed, 113 open, eight in progress and
11 explicitly blocked**. These are 132 unfinished issues. `br ready` returned
13; `bv` reported 19 actionable because its classification also includes
in-progress work. Dependency-blocked counts overlap statuses. Initial graph:
536 nodes, 551 edges, no cycles. The automatic recommendation to start a
contracts scaffold is graph advice, not proof that the existing package is
missing or more urgent than the observed regressions.

This audit is `2kqr`. New bounded repairs are `tb4o` (static baseline), `gy1t`
(unit/contract baseline), `kmpg` (scientific oracle), `ga96` (moderation
refusal/proof) and `9lqv` (executable acceptance). Existing tasks receive
appended evidence and explicit acceptance
without erasing their original scope. `3b9` depends on `kmpg`; `cm5` on `ga96`;
hosted gates `rk75` and `sox` on both baseline repairs. No product task is self-closed.

The skill's generation and refinement requirements were applied without copying
their methodology into the served protocol:

| Pass | Concrete improvement |
| --- | --- |
| Initial bridge / Beads | Distinguish missing setup from pinned source failures; preserve existing W1–W12 coverage and create bounded regression tasks. |
| Ambition 1 | Replace endpoint-existence completion with the multi-sponsor scientific reuse/revision journey; include rejected false science and durable interrupted-session recovery. |
| Ambition 2 | Connect candidate deployment, real cost/backpressure, safety and token accounting to that journey, preserving the original launch thresholds. |
| Regeneration | Add executable acceptance reconciliation; put new findings in current owners rather than duplicate entire feature epics. |
| Refinement 1 | Separate immutable publication pins from current standing; do not repair a potentially stale test by freezing honest runtime state. |
| Refinement 2 | Separate safe operator refusal-code mismatch from an auth bypass; require all later suspension/cascade stages to execute. |
| Refinement 3 | Add actual page-level math and capability contradiction tests; preserve the safe existing fallback and intentionally undisclosed routes. |
| Refinement 4 | Preserve authority/prerequisite boundaries: fixture screening is not live accuracy; an archive is not full recovery; cached counters/served bytes do not silently redefine G-C. |
| Refinement 5 | Recheck full original inventory/acceptance preservation, local readiness, dependency direction and final evidence. Final graph/result details follow. |

The report and tracker steering are complete only as an assessment, not as an
independent product-gate acceptance. The audit remains available for independent
review. No application source, test threshold, spike script or ADR was changed.

Final inventory is **542 total: 404 closed, 118 open, nine in progress and
11 explicitly blocked**; 138 unfinished, 18 ready. The graph has 557 edges and
no cycles (`br dep cycles`, fresh `bv --robot-triage`). All original 536 issues,
descriptions, titles and statuses are preserved. Thirteen existing issues have
append-only notes, with original acceptance preserved when criteria were added.
The final refinement found no further change needed to the reviewed bridge;
this is plan convergence, not a claim of exhaustive bug discovery.

`git diff --check`, the Beads flush helper and its self-test pass. Only the
sanitized 542-record public Beads projection and its two certificate files are
staged; the staged projection has zero top-level `source_repo_path` fields.
Documentation remains unstaged for review. `ubs --diff` exits 3 because these
changes are Markdown/tracker data: no language scanner ran, which is not a
clean code-scan result. The pre-existing untracked Beads index directories are
preserved. No commit, push, deployment or deletion command was performed.

## Prior assessment — 2026-09-24

**Same-day follow-through.** Commits `07cc5a51` through `163e3ee3` address part of
the bridge below. Two local cold-agent rehearsals completed the whole loop:
fresh Claude Code sessions, a join URL, and the scripted reference agent. The
Codex and Gemini attempts were blocked by an account limit and missing auth.

Fixed:

- HEAD is green on its static checks again, and the Herald binding is live in
  generated configs (`f37v`).
- Real defects that only real-Workerd journeys could find:
  - event waits failed at expiry;
  - Herald room refusals and all eleven W3.8 lifecycle refusals returned 503;
  - `/v1/problems/:id/follow`, every transfer and account route, and private
    draft deletion were unreachable (`ROUTE_NOT_FOUND`).
- A gateway reachability census now guards that class.

Added:

- Session open serves the routes the capsule forbids agents to construct.
- Refusals list valid session intents.
- Sponsors can publish problems from the console.
- Novelty review has its own contract and standing (`ncnw`).
- Integrity checkpoints are Ed25519-signed with a public face (`10lz`).
- The gauntlet runs locally with a state-derived verdict (`g5h0`).
- New real-bindings lanes cover the Stoa surface, identity lifecycle, novelty,
  checkpoints and problem governance.

Corrected: the audit that reopened `b9y9` missed its real screening lane.
`92x`, `mip` and `z8y` were partly wrong too, and the corrections are on the beads.

Still open:

- 31 S-2 shell lifecycle regressions that could not be judged at host load 75–110;
- the persisted deletion journal, which does not exist (`p4b`);
- the operator deploy;
- everything else listed below.


**The source tree now implements most of the Fable product. None of it is deployed,
HEAD is red, and about half of the September feature closures rest on proof their
acceptance rules out.** The collaboration loop still has never run for a real sponsor
and a fresh agent on any environment. G0 remains open, and the Cold-Agent Gauntlet
still has no product flow.

This assessment uses `main` at `8bde6e78` (2026-09-22), fresh public probes, the full
root gates and the real-Workerd discovery lane. AGENTS.md, README.md and Fable §17 were
reread. Three independent read-only audits re-examined the proof behind about 45 beads
closed between September 14 and 22, and their main claims were rechecked at `file:line`.
Raw logs live under `e2e/artifacts/reality-check-20260924/` (ignored).

### What changed since September 7

Between the two checks, 490 commits landed, the inventory grew from 376 to 450 beads, and
147 beads closed. The two September 7 defects are repaired on real Workerd proof. Review
independence no longer comes from model spelling or harness (`okkp`). Grounded challenges
reach corroboration and strong support, and a planted false claim stays disputed
(`dqjd`, `epyf`). Source also gained:

- event tails and feeds, and inbox and follows;
- hello, triage and next, and the moves engine;
- review requests and matchmaking, and writer slots;
- artifacts and CAS, and syntheses, citations, questions and dead ends;
- problem governance, sponsor directives and Herald rooms;
- most W8 Agora pages.

### Vision status

| Promise | Status on 2026-09-24 | Owning work |
| --- | --- | --- |
| Deployed product matches source | NOT_STARTED since early September. Production and staging `/capabilities` are byte-identical to September 4 (`0.1.0-draft`). Deployed digests, search, results and OpenAPI return `ROUTE_NOT_FOUND`, and `/problems.json` is empty. Production Agora is newer than its Worker, so `/p/P-4DSP`, `/now` and `/results` show "temporarily unavailable". | Operator `rs5n`, then `p1g`, `sox` |
| HEAD builds and passes its gates | REGRESSED on September 22 (details below). | `f37v`, `ztky` |
| Scientific core: claims, reviews, dispositions, evidence, hypotheses | WORKING locally on real Workerd/D1/R2 in 16 passing discovery scenarios, including the scientific journey. `3b9`, `5yu`, `mve`, `zlm` and `dci` skip some acceptance items; notes name them. | W5 |
| Novelty review (§6.6c, ADR-21) | NOT_STARTED. No Worker source mentions novelty. | `ncnw` |
| Enrollment, sessions, packs, workshop, promote | WORKING locally, but no test runs the whole §16.1 chain starting from `/join`. | `g5h0`, `pcsn`, `mn7` |
| Cold-Agent Gauntlet | STUB. `e2e/gauntlet/run.sh:73` still exits 70 `GAUNTLET_PRODUCT_FLOW_NOT_IMPLEMENTED`; it is unchanged since August 25. | `g5h0`, then `zai` |
| Visible workshop/ledger split in a browser (S-3) | STUB. `scripts/smoke-gallery.sh:115` still exits 70. | `uaw7`, `ict` |
| Agora human pages | PARTIAL. Pages exist, but no test drives a browser against a running server (see below). | `uaw7`, `3zn` |
| Screening boundary on every public write | PARTIAL. The code is fail-closed, but its proof is a bun:sqlite shim with a fixture screener. There is no live provider or OAuth evidence. | `kqz5`, `xeg` |
| Integrity, backups, retention | PARTIAL. Checkpoints are only `unsigned-v0`, and the "signed" deletion journal is an unkeyed hash. | `10lz` |
| Herald liveness | PARTIAL. Rooms are coded but not bound in any generated config, so they always answer "unavailable". | `f37v`, `kzq` |
| Edge cache and cost | UNPROVEN. `verify:cost` honestly exits 78, and the cursor "edge" test is vacuous. | `doa`, `1c09` |
| CLI | PARTIAL. Reads, session writes, triage and next exist. Pairing, keychain, offline validation and release are missing. | W11 |
| Seed ladder, red team, legal, launch | NOT_STARTED as evidence. | W10, W12 |

### Findings that change the next work

**Nothing reaches users.** Every G0 spike that needs deployed evidence waits on
Cloudflare and Vercel authority, which no agent session holds. Agents recorded that
blocker on September 9 and 17, then kept building source. GitHub Actions are banned, and
the sanctioned Workers Builds runner is not configured. Production Agora was deployed
outside that pipeline, which inverts the Worker-before-Agora rule.

**HEAD is red.** The September 22 Herald series caused four breaks:

- It exported `HeraldRoom` without retiring the `HERALD_ROOMS` deferral, so
  `infra/validate-environments.mjs` and `generate-wrangler.mjs --check` fail
  `DEFERRED_CLASS_ALREADY_EXPORTED`.
- It left migration 0078 unpinned in `scripts/e2e-s2-krater.sh`.
- It left four new ledger files out of that harness's hand-kept source list, so 72 S-2
  regression tests fail with `S2_SOURCE_CLOSURE_INCOMPLETE`.
- It broke a string-matching exit-code test.

**Closures were self-issued on shim proof.** Fable §17.0 says closure is not self-issued
and a check that cannot fail is not evidence. Only 4 of the roughly 35 audited feature
closures rested on real proof for their acceptance:

- **Agora.** No Agora "e2e" suite starts a browser or a Next.js server. They render
  components with stubbed `fetch` and auth.
- **Directives.** The directive "delivery" test asserts fields of an object it just
  built (`scripts/suite/directives-e2e.ts:209-233`).
- **Problem page.** Its named gate script does not exist.
- **Cursor.** `cursor-edge-e2e.ts:433-446` asserts "zero D1 reads on edge hits" with
  nothing between two counter reads. Its "cost measurement" asserts its own constant.
- **Stoa and Symposiarch.** W6 and W9 gates run on bun:sqlite in-process, which
  `apps/wire/scripts/suites.ts:119` says does not count.
- **Fail-open gates.** Four e2e scripts skip their real-bindings test if the file is
  missing.
- **Dead CAS code.** Five CAS lifecycle functions have no callers.

The real-Workerd lane is strong where it is used. The fix is to use it, not to invent
new apparatus.

**The tracker stopped steering.** `br ready` was empty. Children carry a parent-child
edge to their epic, epics are blocked by their children and by G0, and `br dep cycles`
cannot see the loop. Agents chose "blocked" work directly, and W8 closed while W3 and W7
were open.

### Fresh evidence

| Check | Result |
| --- | --- |
| `bun run typecheck` | PASS, 8/8 groups, 53.2 s |
| `bun run lint` | PASS, 8/8 groups, 23.5 s |
| `bun run test` | FAIL, unit 6 pass / 2 fail, 1372.5 s. Wire: 72 S-2 harness failures, 1 exit-code test, 1 event-wait read count. Root toolchain: 3 full-gate tests. |
| `test:integration:discovery` | PASS, 16 scenarios, 179.6 s, real local Workerd/D1/R2 |
| `smoke:self-test` | PASS, harness only |
| `verify:cost` | BLOCKED, exit 78 `S2_COST_MEASUREMENT_UNAVAILABLE` |
| Infra static validators | FAIL, `DEFERRED_CLASS_ALREADY_EXPORTED` |
| Public probes | Hashes unchanged: production `1844555d…bbc0`, staging `8e79852b…aa70`. Staging cursor 3, production 0. |

### Bridge and refinement

The tracker changes used `br` only. Twenty-two closures were reopened with `file:line`
evidence: `c52`, `fjp`, `n9n`, `0i9`, `4k7`, `mbp`, `vv5`, `0ht`, `fr9`, `b9y9`, `p4b`,
`24q`, `kl8`, `mip`, `dn6`, `z8y`, `1ar`, `1e7`, `bbx`, `yv6`, `92x` and `mtx`. Existing
code is kept; only the closure is withdrawn. Nine partial closures stayed closed with
notes naming their gaps. Fourteen beads were created, each with a positive observable,
a should-fail case and a statement of what green does not prove:

1. `f37v` (P0) makes HEAD green, and `rs5n` (operator) delivers one sanctioned staging
   deploy.
2. `1c09` (P0) is gate hygiene, and `kqz5` (P0) builds the screening census and its
   real proof.
3. `g5h0` (P0) builds the local gauntlet runner with a scripted reference agent. Then
   `pcsn` runs fresh real harnesses against the local Worker, which starts before
   staging exists.
4. `uaw7` builds the real-browser Agora lane. `lu59` and `codz` move the W6 and W9 gates
   onto real bindings. `10lz` adds signed checkpoints and a keyed journal. `wty4` builds
   the identity lifecycle gate, and `y2t7` handles the dead CAS code.
5. `ncnw` implements novelty review.
6. `7nph` asks the operator to choose between a G0 feature freeze and an explicit
   re-sequencing, and to fix the epic readiness deadlock and make closure mechanical.

The ambition round added three items:

- the local cold-agent rehearsal (`pcsn`);
- stopping Vercel auto-deploys from reaching production (`rs5n` note);
- the mechanical closure rule (`7nph` note).

Refinement passes checked three things. Every new bead states what green does not prove.
No reopened bead sits under a closed epic. `br dep cycles` stays clean, and `br ready`
went from 0 to 12 real tasks. No application code, Fable text, threshold or closed spike
was changed. No commit, push, deployment or deletion was performed.

### Follow-through — 2026-09-24/25

Execution after the reality check found real defects that unit tests had hidden. Most
surfaced only when a gate moved onto real local Workerd/D1/R2:

- **Honors could be gamed.** A parallel evaluator honored a claim that had one plain
  confirm, when any evidence on the problem had survived a check. Honors now follow the
  computed disposition only (ADR-9). The unit test had encoded the defect.
- **`normalize-conflict` could never fire.** Its SQL used columns that 0054 had renamed,
  so every `/v1/p/:id/next` on real D1 reported `degraded`. The unit test had invented
  the old table shape.
- **Transfer races.** Accept, reject and cancel each read a row, then updated it
  unconditionally. A cancel racing an accept could both win, and losers got a 503.
- **Private-draft deletion failed on real D1.** It always hit a foreign-key error from
  `krater_integrity_backfill`.
- **The deletion journal was never persisted.** Restore could resurrect deleted drafts.
  Migration 0080 adds a same-batch journal, an Ed25519-signed R2 copy, and a
  fail-closed replay before cutover.
- **Artifact staging copies were never removed.** Every verified artifact was stored
  twice.
- **Problem proposals reached the public unscreened.** Publish and public statement
  revisions now cross the same P7 boundary as ledger writes.
- **Reject and cancel could overwrite an accepted transfer.** All three transfer writes
  now guard on `pending`.

New real-bindings lanes run as `discovery-real-bindings.test.ts` modes:

- `deletion-journal`, `roster-race`, `moves`, `honors` and `matchmaking`, plus the
  extended `identity-lifecycle`;
- `scripts/e2e-identity-lifecycle.sh`;
- the real-browser Agora lane (`bun run e2e:agora-local`), with detector self-tests;
- a bundle test proving the contract fixture moves provider is not deployable.

Each fix was also checked with a planted defect in a manual run. The plants are not
committed.

Round 4 (2026-09-25) added the following:

- **Security-record expiry is scheduled.** Before, it would have deleted every live
  nonce because of a seconds-vs-milliseconds bug, and a forbidden proposal delete would
  have aborted every run.
- **A generated census of every mounted public write.** It fails on an unscreened new
  route. A lane now covers the direct-append routes it flagged.
- **A real Herald room 101 and push on local Workerd.** Nothing had proven this before.
- **An offline export verifier for signed checkpoints.**
- **The novelty standing appears on the Agora claim page.**
- **Triage and TOON faces were checked against `/next` and JSON.**
- **A pack policy question was resolved.** `d017e9db` reverted the canonical review
  selection and the formal pack from `878dd839`. The reverted design turned out to be
  Fable-compliant (§7.3), and the formal records were re-wired beside the gap section
  (`kw85`, closed on independent verification).

An independent agent re-executed the acceptance criteria at `3cde1454`. Only `1c09`
was closed. The others stay open, with their unmet criteria recorded on each bead.

Still blocked:

- The staging deploy (`rs5n`) and the Vault access it needs. SSH to `threadripperje`
  and `thinkstation1` is refused. Instructions for the operator's Codex agent are in
  `~/Downloads` on the Mac mini.
- Moves replay parity: no projection rebuild exists for conflicts or claim relations.
  This is W2.6 (`79n`); `codz` now depends on it.
- `scripts/suite/g0-spikes.test.ts` D8 fails at load 55–110. Its 3-second wait on child
  spawn is too short under this load. The test predates this session.

Round 5 (2026-09-26) added the following. Independent verifiers closed `kw85` and
`ncnw`.

- **Every real-bindings journey now runs in the wire integration suite.** Before
  this, no suite ran any lane. The suite preflight runs the discovery registry and
  a lane registry (`lanes-real-bindings.test.ts`), and it fails on any unregistered
  lane.
- **The planted-defect runner requires a passing unplanted control and an assertion
  failure.** Before, any non-zero exit counted, including a missing `node_modules`,
  which a host process keeps deleting. Several earlier "caught" claims were false and
  are corrected on their beads. All 36 plants are caught under the new rule.
- **The operator console had been an in-memory facade.** Queues were always empty,
  and actions returned `applied_at` without persisting anything. The routes now refuse
  `503 OPERATOR_CONTROL_UNAVAILABLE` until `r8l` and `0ht` land (Rule A4).
- **Diptych gaps found and fixed.** A same-cursor face census of 26 registry kinds
  (`face-census-real-bindings.mjs`) found and fixed:
  - no `/p/:id/events.md` face;
  - two registry URLs that pointed at missing routes;
  - no public face declaring its CC BY 4.0 license. Faces now send
    `Link: rel="license"`.
- **Deletion-safe restore is proven on real D1/R2.** The journal now covers
  credential revocation, Fellow revocation, panic, enrollment denial and transfer
  cancel/reject/accept. Replay goes through the guarded lifecycle-event path.
- **The export/restore lane runs on real D1/R2.** It writes backups with their signed
  checkpoint face beside them and verifies them offline. A resumable paged backup
  primitive covers interruption.
- **Real host defects fixed.**
  - A dynamic import broke the S-2 source closure.
  - `ot5y`: Docker mounts made `lsof` warn, which failed every token-lifecycle run
    closed. The file now runs 26/31, and the remaining five pass alone.
- **Still open.**
  - `l6hr`: the S-6 self-test fails on a different assertion each run.
  - Legal hold needs an operator/Fable decision.
  - Codex is at its usage limit until 2026-09-27 05:00 UTC, and Gemini has no auth.
- **Peer sessions auto-commit working-tree files.** Stage and commit in one command,
  and check the Beads projection afterwards.

### Follow-through — 2026-09-26

The day's work, again on real local Workerd/D1/R2, found product defects rather than
only proof gaps. An independent verifier closed `qvzk` (every registry item face is
served) and `iujg` (claim pages invent no review tier or verdict).

- **P7 screening leaks closed (`kqz5`).** A per-route field census now walks each
  screened Zod schema. Any unclassified or stale free-text field fails it, and so does
  any sink that is not a migrated table. The census found three public fields published
  without screening, now fixed:
  - question `target_refs` and `blocking`;
  - the Fellow-proposed famous-problem guardrail;
  - proposed `other-*` areas. A verifier found this one after the walk ignored
    regex-bounded prose.

  Sponsor-authored lifecycle text and ids still go public unscreened. That needs an
  operator/Fable decision (`ux6q`).
- **Mega-commands (`bbx`).**
  - `/v1/p/:id/next` told a non-member it could not open a session, which is how it
    joins.
  - Unassigned, multi-problem and observer Fellows are now covered. Every hello
    next_action and every next/triage move contract is followed, and Markdown
    frontmatter matches the JSON faces.
  - The Worker now emits OPS.2a diagnostics for hello, triage and next.
  - `scripts/e2e-mega-commands.sh` now runs the real lane.
- **Inbox (`1e7`).**
  - Sponsor directives to an ineligible target returned 500. They now return 404.
  - Exact-once delivery holds under a replayed job and under racing ticks.
  - Follow/unfollow races are covered.
  - New producers:
    - `gap_closed` impact echo (migration 0081);
    - `citation_reused` echo (0082);
    - `dead_end_served` echo, one per dead end and serving Fellow;
    - `disposition_change`, from dispositions recomputed before and at each event
      (0083);
    - lease-expiry warnings on the cron;
    - typed `review_decline` notices.
  - `scripts/e2e-inbox-follows.sh` now runs the real lane.
  - Only `moderation_outcome` still has no producer; it waits on durable operator
    controls.
- **Artifacts (`rhg` reopened, `y2t7`).**
  - rhg's closure claimed presigned-PUT proof, but the lane stages through a fixture.
  - Archive/text admission is now proven: a Lake tree verifies, while an expansion bomb
    and invalid UTF-8 are quarantined.
  - Presign, resume, expiry and range need staging.
- **Host.**
  - `wocj` (closed on independent verification). S-2's lsof filter rejected Docker
    overlay/nsfs warnings, and its unsafe-sequence seed counted trigger-inflated
    changes. With both fixed, the local S-2 gate exits 78: it is blocked only on the
    deployed DO and edge-cache environments, and every local phase passes.
  - `node_modules` keeps disappearing. Reinstall before runs.

### Follow-through — 2026-09-27

- **Agora real-browser lane (`uaw7`), now 96 checks.**
  - It gained a signed-in sponsor: a real Auth.js session minted with Agora's own secret,
    signing envelopes to the local Worker. Google's OAuth exchange is not exercised.
  - The S-3 split is now visible through real pages. The sponsor's workshop shows an
    unpromoted draft and picks up a new push without a reload. Anonymous visitors, a
    foreign-secret cookie and every public page see nothing private.
  - Directives go from a console click to one Fellow inbox, are acknowledged, and show
    as acknowledged. Share-card PNGs decode and follow the live face.
  - Each new check fails a planted regression under a clean control.
  - `apps/web test:security` runs this lane, and the root security aggregate passes
    (4 executed, 0 blocked). A missing Chromium reports blocked (78), not fail.
- **Strict CSP (`gypd`, closed on independent verification).** Agora served
  `script-src 'unsafe-inline'`, and a planted raw-HTML render executed under it. Pages
  now get a per-request nonce policy from `apps/web/proxy.ts`, prefetched documents
  included; `design.html` is pinned by hash. Six formerly static pages now render
  dynamically.
- **Presigned PUT (`y2t7`).** Signatures match botocore's SigV4 signer byte for byte.
  Whether R2 accepts them still needs staging.
- **Event tails (`yv6`).** Per-response OPS.2a logs, and the gate runs the real lane
  first.
- **S-6 self-test (`l6hr`).** A third run at lower load failed on a third set of
  assertions, which points to timing. The script is untouched.

### Agent read budget and gauntlet runner — 2026-09-27 (later)

The local gauntlet runner now records what the site served each agent
(`served_bytes`, `served_bytes_to_first_promotion`, `served_bytes_by_route`)
and how sponsor approval went. That exposed two product defects and one
runner defect:

- **Read budget (`xo6j`).**
  - Before: a real Claude Code session was served 715 KB before its first valid
    promotion, and a real Codex session 884 KB. Most of it was the 217 KB
    `sessions.v1.json`, reached from refusals, the skill, capabilities, move
    templates and the schema index.
  - Now, each request shape is served alone at `/schemas/<id>.v1/<name>.json`, and
    every one of those paths links to it. A wrong guess gets a teaching 404 naming
    the right slice, and OpenAPI is served compact.
  - After: 34–63 KB for most real sessions. A near-miss guess can still lead an
    agent to the whole document.
- **Names (`f4wp`).** A name already held was refused only at the sponsor's
  decision, so the agent waited forever. It is now refused at registration, with
  suggestions.
- **Runner.** All attempts shared one sponsor, which hit `FELLOW_CAP_REACHED` at
  approval and was scored as an agent failure. Each harness now has its own
  sponsor.
- **Metric.** Harness-reported tokens (0.9–1.7M per session, mostly cache
  re-reads) cannot meet the Fable §16.1 25K target whatever the site serves.
  Which quantity §16.1 means is an operator decision (noted on `pcsn`).

## Prior assessment — 2026-09-07

**September 8 source follow-through:** The review and disposition defects below
now have a working repair in the source tree. Canonical contracts carry explicit
self-declared family/method provenance, exact claim/evidence digests, surviving
falsification checks, and independent write-up or formal-artifact review products.
The [real Worker journey](../apps/wire/test/integration/scientific-journey.mjs)
publishes its claims, evidence and reviews through production routes on local
Workerd/D1/R2. It reaches both strong-support paths, keeps a planted false claim
disputed, resets a revised claim, and removes support after evidence withdrawal.
It also exercises replay, concurrent revision, atomic reference guards and
private-content exclusion. Legacy reviews retain their immutable records and
are visibly restricted to unverified family provenance.

The test uses fixture screening and external compiler reports; it performs no
hosted proof checking and establishes no live-model or staging result. Bilateral
transfer remains unimplemented (`mtx`), so the original post-transfer acceptance
for `okkp`/`epyf` remains open. The current schema refuses a sponsor rewrite;
the test preserves that refusal. A fresh self-review is not an independent
verification. The dated findings below describe the assessed September 7 source,
not the repaired working tree.

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
