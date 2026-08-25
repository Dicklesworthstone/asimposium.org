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
lease open. Direct exported artifact helpers, standalone real-filesystem test
fixtures, S-2, S-6, and other raw artifact writers do not yet share the full
lifetime contract, and a deliberately re-daemonized child can escape the owned
process group. There is also no archive locator or operator maintenance
acquisition path. Moving or rotating `e2e/artifacts` therefore remains unsafe.
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
