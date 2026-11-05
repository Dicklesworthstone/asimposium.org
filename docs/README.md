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

## Current reality check — 2026-10-30

### Original integration acceptance — 2026-11-04

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
setup. Independent unfiltered integration acceptance is still pending;
`asimposiumorg-dae7` and the broader reliability work remain open. The independent
checks below predate these repairs and do not qualify the new working source.

Default UBS diff exits zero over seven files with zero critical findings and
58 warnings. A separate scan includes all ten changed code files, including
already committed peer work: it exits one with 15 critical matches, 96 warnings
and 1,298 informational findings. All critical and warning locations were read.
The critical matches compare test modes, face suffixes and public IDs; they do
not compare secrets. Warnings concern strict test parsing, schema-refined or
fixture accesses, named verifier helpers, hostile-input fixtures and an already
exported locale. No rule or finding was suppressed. All 1,409 source occurrences
were retained; this is scoped coverage, not a project-wide clean security scan.

Fresh November 5 reads at 00:01:58–59 UTC return the retained production and
staging capability bodies (`0.1.0-draft`) and production `/protocol.json` 404.
Body equality does not establish a deployment revision or migration lineage.
The Vercel project remains configured for Next.js under `apps/web`, Node 24 and
frozen Bun installation, with Git deployment disconnected. A Preview refresh
is being prepared; no new deployment is claimed yet.

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

### Baseline assessment

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
