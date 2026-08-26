# E2E and staging entry points

This directory owns executable entry points for real staging checks. They do
not use mocked D1, R2, OAuth, approval, or browser flows.

Current scope:

- `bash tests/run-diagnostics.test.sh` proves the harness validates artifact
  run IDs, rejects traversal-shaped values, and emits secret-safe diagnostics.
- `bash tests/smoke-entrypoints.test.sh` proves each entry point can self-test,
  rejects a traversal run ID, and fails nonzero when an agent staging surface is
  unavailable.
- `scripts/smoke-agent.sh` is a public-surface and typed-loop gate. With an
  explicit staging Fellow credential it exercises open → pack → workshop →
  validator refusals → promote → cursor → near-duplicate refusal → close. With
  no credential it exits blocked rather than skipping the loop. It captures
  and unsets the credential before starting a child process, validates the
  canonical token grammar, and passes the Authorization header to curl over
  stdin rather than argv or inherited environment. The gallery smoke still
  stops after anonymous boundary probes because its authenticated
  sponsor/private-versus-public comparison is not implemented. The anonymous
  agent smoke requires `/problems.json` to return exact status 200, canonical
  `application/json; charset=utf-8`, and the generated closed contract; it also
  validates the sponsor route's exact 401 `UNAUTHORIZED` problem face, but it does not claim byte-level workshop
  privacy without a seeded private canary and its paired public observation.
- `run-playwright.sh` runs the non-mock public-surface checks when Playwright
  and explicit HTTPS staging origins are available.
- `../scripts/e2e-device-enrollment.sh` is the W3.5 mock-free product runner:
  an unaffiliated curl client starts and polls the proposal-carrying device
  flow, while Chromium uses a real, recently authenticated Auth.js storage
  state to inspect the complete approval card and Approve, Reduce, or Deny.
  Its scenarios also cover immediate `slow_down`, a wrong code, post-binding
  refusal to a second sponsor session, the real 30-minute expiry boundary, and
  a 24-hour no-reactivation soak. The runner refuses canonical production
  origins and never captures screenshots, traces, cookies, codes, flow handles,
  tokens, proposal bodies, or sponsor identity.
- `../scripts/e2e-s6-cross-plane-auth.sh` is the mock-free cross-plane S-6 runner. Its paired
  targets are supplied explicitly as `ASIMP_S6_PREVIEW_URL` and `ASIMP_S6_WORKER_URL`, alongside
  the real Google sign-in, Fellow bearer, signing authority, revision/deployment identity, and
  repository-local evidence destination. Missing inputs exit 78 as
  `REQUIRED_HARNESS_INPUTS_MISSING`, an external execution prerequisite; that result does not say
  whether provider resources are provisioned. Supplying configuration also is not proof: only the
  completed live run and its validated schema-v4 evidence establish the cross-plane claims. The
  current revision remains red: its output is diagnostic only until the focused and aggregate
  low-load RCH acceptance lanes pass.
- `gauntlet/run.sh` and the direct `gauntlet/run-gauntlet.ts` entry both fail
  closed as `GAUNTLET_PRODUCT_FLOW_NOT_IMPLEMENTED` when a join-URL file is
  supplied. The adapters, transcript stage scanner, orchestrator, and strict
  ten-attempt scorecard are harness-development components only: transcript
  text, estimated token counts, and ten distinct ordinal rows cannot establish
  fresh sessions, pairing, pack use, workshop persistence, a falsifiable
  promotion, injected-422 recovery, close/handback, or the 25K token criterion.
  No current path can emit an acceptance pass until those results come from
  authoritative product and harness evidence.

All runners accept `--self-test`. The smoke, Gauntlet, Playwright, and device-enrollment entry
points require explicit HTTPS origins through `ASIMPOSIUM_STAGING_AGENT_BASE_URL` and, where
applicable, `ASIMPOSIUM_STAGING_AGORA_BASE_URL`; S-6 uses the two `ASIMP_S6_*_URL` inputs named
above. No shell runner infers or prints a target. Playwright failure artifacts
can retain requests to the public staging origins, including their URLs, and
must be handled accordingly. Every real Playwright launch claims a fresh run
namespace and confines Playwright's own cleanup/output to its `playwright/`
child; `--write-artifacts` additionally retains the shell diagnostic JSONL.
Curl calls routed through the shared E2E helper
send the exact `OpenAI File Downloader, XaiImageApiFetch/1.0` User-Agent, disable automatic
redirects, and refuse response bodies larger than 1 MiB before they can accumulate in a shell
variable. The wrapper disables implicit curl config, and callers cannot override or reset those
transport controls. The shared public preflight accepts a
direct 2xx or explicitly checks one path-preserving same-origin canonicalization hop; it never
borrows a green result from another origin or an unrelated login/landing path.
For entry points that expose `--write-artifacts --run-id <id>`, evidence writes only beneath
`e2e/artifacts/<id>/`; valid IDs match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`. The shared writer refuses to create or
adopt a missing run directory: Smoke Agent, Smoke Gallery, Playwright,
Gauntlet, device enrollment, and the CI pipeline atomically claim that
directory before product work and refuse a reused ID, so two ordinary attempts
cannot blend evidence under one name. The TypeScript OPS harness likewise uses
an exclusive `mkdir` for both a top-level new run and a new run inside its
retained integration namespace; only an explicit resume may reopen an existing
directory, after its immutable run-identity record is checked. Common shell
writers now bind their claim to the artifact root's device/inode as well as the
run directory's, revalidate both before each append, and refuse any node at the
reserved sibling fence `e2e/.artifact-maintenance` before claim and
publication. They also acquire an append-only lifetime lease under
`e2e/.artifact-writer-leases/dev-<device>-ino-<inode>/` before the exclusive run
claim. Their entry points mark that lease `closed/` only on an ordinary
top-level exit after synchronous child work has returned. A fatal signal that
does not prove descendants were reaped, or a crash, leaves it open; neither PID
nor age automatically reclaims it. The read-only lease census fails closed on
open matching-epoch leases, symlinks, or malformed registry nodes. The
TypeScript `ArtifactStore` now holds the same append-only lifetime lease from
before its run claim through its final event/JUnit publication. A normal
`runHarness` close happens only after its detached POSIX process group is
signalled and observed absent. Constructor failures close immediately because
no child exists yet; callback/storage failures close only after that same
settlement boundary. An unprovable child settlement,
Windows process-tree execution, signal exit, or crash deliberately leaves the
lease open. The S-2 shell harness now claims
`e2e/artifacts/s2-krater/<run-id>` beneath the same artifact-root epoch and
keeps one parent-owned lease open across its recursive controller and lifecycle
children. Each child receives an exclusively preclaimed run plus the exact
root, namespace, run, and lease identities; it validates but never closes the
parent's lease. The parent closes only after its child-aware cleanup and final
publication boundary are proven. Early signals, crashes, and cleanup ambiguity
leave the top-level lease open. This is source-level wiring only: the S-2 lane
has not executed at the current revision under the required low-load RCH gate.
S-6 now claims its fixed
`e2e/artifacts/s6-cross-plane-auth/<run-id>` directory under the same root
epoch before any product child or evidence writer can start. It revalidates
the exact root, namespace, run, and lease identities before, during, and after
the one schema-v4 evidence write. The lease closes only after the owned child
set is proven empty and final evidence publication is complete; its exact
lifecycle terminal records that the lease is closed or was never acquired.
Signal cleanup follows the same settlement boundary, while a survivor or
identity mismatch leaves the lease open and refuses a tidy terminal. This is
also source-level wiring only: the focused S-6 and aggregate lanes have not
executed at this revision under the required low-load RCH gate.
The D1 rollback adapter is now inherited-capability-only: `runHarness` owns its
retained run and lifetime lease, injects the exact root/namespace/run/lease
identities only into registered D1 steps, and re-proves them after the detached
process group is absent. The adapter deletes the inherited value before
Wrangler starts, validates around each state mutation, and never closes the
parent's lease. Its direct-process negative also plants an ambient bypass value
and requires refusal before the D1 state leaf exists. This is source-level
wiring only; the real-D1 positive and negative lane has not executed at this
revision under the required low-load RCH gate. The CI review pipeline now hands
each recursive Worker deploy, Worker readiness, and web deploy child the exact
root, run, and parent-lease identities for its retained top-level run. The child
copies that handoff into unexported shell state, removes it from the environment
before starting provider tools, and re-proves the capability before provider
operations and retained receipt writes. Only the top-level pipeline closes the
lease. Its bounded stage wrapper polls the owned process group after SIGKILL and
acknowledges proven absence over a private descriptor that stage descendants do
not inherit. On Linux it also becomes a child subreaper before spawn, then uses
`/proc` direct-child census plus pidfds to TERM/KILL and reap descendants that
escaped into another session; only an empty original group and empty adopted
child census can acknowledge full settlement. A missing or malformed
acknowledgement becomes exit 125. A host without that exact descendant authority
may preserve the stage result, but emits an explicit unproven acknowledgement
that leaves the parent lease open for the entire pipeline. The focused tests
include one live-capability positive control, reject root/run/lease identity
mismatches, a foreign lease, a closed lease, and an artifact-maintenance fence,
and exercise an actual claimed lease on the settled-close,
re-daemonized-session, deliberately-unprovable-open, and abnormal-wrapper-open
paths. This CI wiring is also source-level only; neither its process controls
nor a hosted deployment has executed at this revision under the required
low-load RCH gate. The direct
failure-blob helper now requires the caller's matching open root-epoch lease
before its first real-filesystem mutation, while preserving lease-free
read-only deduplication and pre-mutation validation refusals. Exported run
identity reconciliation likewise keeps existing-record verification read-only,
but first creation now requires the exact `run-identity.json` leaf, an open
root-epoch lease, and the owning directory's physical identity; it re-proves
that authority and the exact written bytes after exclusive creation. Both the
reusable top-level namespace reservation and retained child reservation now
require the same exact owner-directory capability on real storage, and the
exclusive new-run variants inside `ArtifactStore` re-prove it before and after
their claims. The opt-in
real-filesystem fixture suite owns one such lease from before its retained
namespace/case claims until its synchronous `afterAll` boundary; a crash leaves
the append-only lease open. Its remaining raw directory and file plants now
route through one exact owner-directory capability immediately before and after
the mutation; fixture files use exclusive creation and never overwrite retained
bytes. This fixture wiring is source-level only and has
not executed at this revision under the required low-load RCH gate. This
exhausts the currently known synchronous raw fixture primitives, but does not
grant full descendant-settlement semantics to arbitrary future standalone
entry points.

The existing harness entry point now also exposes a bounded, write-free
operator census:

```bash
bash scripts/e2e-test-harness.sh --retention-census
bash scripts/e2e-test-harness.sh --retention-census --locate-sha256 <lowercase-sha256>
```

It streams bounded raw pathname-byte directory entries, refuses observed
symlinks as traversal nodes, opens regular-file leaves with `O_NOFOLLOW`, hashes
them in fixed-size chunks, and emits one JSON document to stdout. The successful
document contains aggregate metadata, opaque digests, safe relative path
displays, the absolute artifact-root path, root/lease/fence epochs, direct and
recursive counts, logical and unique-inode bytes, allocation totals,
age/UID/GID/mode/provenance buckets, hard-link warnings, and bounded locator
matches. Unsafe or credential-shaped descendant components are represented by
their path digest rather than printed; file bodies, symlink targets, and
arbitrary JSON fields are never emitted. Census failure stderr carries only a
fixed unavailable-reproduction message and does not echo census arguments or
local paths. A caller that retains the successful record must redirect stdout to
an explicitly chosen location outside `e2e/artifacts`; the tool itself creates
no census file. Depth, entry, lease-entry, or byte limits, filesystem drift,
unreadable nodes, an invalid maintenance fence, an open current-epoch lease, or
a malformed lease suppress the canonical tree/content digests and return the
blocked exit code. Symlinks, special nodes, and externally linked regular files
also disqualify `archive_candidate`. Even `archive_candidate: true` is only an
observed precondition summary, never permission to move or delete evidence.
This census and locator are source-wired only and have not executed at this
revision under the required low-load RCH gate. There is still no operator
maintenance-acquisition or move path, and Node's path APIs do not provide a
race-free `openat` snapshot: an ancestor or in-place pathname ABA can evade a
path-based before/after comparison. Moving or rotating `e2e/artifacts` therefore
remains unsafe.
S-6 has a separate fixed contract:
it requires `ASIMP_S6_EVIDENCE_DIR=e2e/artifacts/s6-cross-plane-auth` and
accepts neither of those command-line flags.

No current-revision automated smoke, Playwright, S-6 cross-plane, or Cold-Agent Gauntlet product
flow has passed from these entry points yet.

## Device-enrollment staging runner

Provide explicit non-production HTTPS origins and a Playwright storage-state
file created after a real Google sign-in. The file is read in memory and its
path and contents are never logged. Keep its bearer cookies private with
`chmod 600`; the runner refuses storage state readable by another local user:

```bash
ASIMPOSIUM_STAGING_AGENT_BASE_URL=https://agent-preview.example \
ASIMPOSIUM_STAGING_AGORA_BASE_URL=https://agora-preview.example \
ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE=/secure/path/sponsor-state.json \
bash scripts/e2e-device-enrollment.sh --scenario approve --write-artifacts
```

`--scenario` accepts `approve`, `reduce`, `deny`, `fast-poll`, `wrong-code`,
`wrong-sponsor`, `code-expired`, `proposal-expired`, or `all`. `wrong-sponsor`
and `all` additionally require `ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE`
from a different sponsor.
`code-expired` waits through the response's real 30-minute code TTL and proves
both the approval lookup and high-entropy polling handle close with RFC-style
`expired_token`. `proposal-expired` is a separate 24-hour soak that proves those
public surfaces never reactivate at the proposal-retention boundary. The local
Workerd/D1 enrollment lane separately drives the mounted device-code ingress and
deterministically crosses both the 30-minute device boundary and the 24-hour
proposal boundary. Its local-only, flow-handle-gated D1 observation verifies
the pending-to-expired proposal transition and one terminal poll replay row; it
is local binding evidence, not browser, staging, edge, or Cloudflare
header-provenance evidence.
The soak is excluded from `all` so the normal matrix can finish in one run.
Neither live expiry lane uses a clock shim or fixture.
Detailed stdout is NDJSON
with only request IDs, HTTP status, state/code, timings, and 12-hex digests of
high-entropy flow/proposal identifiers. It never retains even a digest of the
short user code. `--write-artifacts` records those validated safe steps plus the
final diagnostic beneath the validated run-id directory; raw browser output,
response bodies, screenshots, traces, and terminal transcripts are never
artifacts.

## Runtime hazard: directory-glob `bun test` breaks child spawning

On Bun 1.4.0 (darwin/arm64), running a test DIRECTORY (`bun test e2e/gauntlet/`)
deterministically breaks every child-process spawn from the test workers with
`EBADF: bad file descriptor, posix_spawn` — even spawning `/bin/bash`. The
wired package scripts avoid it by listing files explicitly after a `/dev/null`
filter, e.g. `bun test /dev/null --timeout=120000 *.test.ts`. If you see that
EBADF from a suite, suspect the invocation form first; reproduce with any
one-line `spawnSync(process.execPath)` probe before blaming the surface under
test.
