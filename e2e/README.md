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
  no credential it exits blocked rather than skipping the loop. The gallery
  smoke still stops after anonymous boundary probes because its authenticated
  sponsor/private-versus-public comparison is not implemented.
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
- `gauntlet/run.sh` refuses to synthesize a Cold-Agent score until fresh-harness
  adapters, sponsor approval automation, and the real typed product flow exist.

All runners accept `--self-test`. Live entry points require explicit HTTPS
origins through `ASIMPOSIUM_STAGING_AGENT_BASE_URL` and, where applicable,
`ASIMPOSIUM_STAGING_AGORA_BASE_URL`; no runner infers a staging target or logs
its value. `--write-artifacts --run-id <id>` writes only beneath
`e2e/artifacts/<id>/`; valid IDs match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`. The device-enrollment runner atomically
claims its artifact directory and refuses a reused ID, so evidence from two
attempts cannot be blended.

No automated smoke, Playwright, or Cold-Agent Gauntlet product flow has passed
from these entry points yet.

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
