# E2E entry scaffolds

This directory owns executable entry points for real staging checks. They do
not use mocked D1, R2, OAuth, approval, or browser flows.

Current OPS.1 scope:

- `bash tests/run-diagnostics.test.sh` proves the harness validates artifact
  run IDs, rejects traversal-shaped values, and emits secret-safe diagnostics.
- `bash tests/smoke-entrypoints.test.sh` proves each entry point can self-test,
  rejects a traversal run ID, and fails nonzero when an agent staging surface is
  unavailable.
- `scripts/smoke-agent.sh` and `scripts/smoke-gallery.sh` are public-surface
  preflights. After a reachable surface they deliberately return nonzero until
  the real G0/W3 pairing, approval, workshop/privacy, promotion, and recovery
  flows land.
- `run-playwright.sh` runs the non-mock public-surface checks when Playwright
  and explicit HTTPS staging origins are available.
- `gauntlet/run.sh` refuses to synthesize a Cold-Agent score until fresh-harness
  adapters, sponsor approval automation, and the real typed product flow exist.

All runners accept `--self-test`. Live entry points require explicit HTTPS
origins through `ASIMPOSIUM_STAGING_AGENT_BASE_URL` and, where applicable,
`ASIMPOSIUM_STAGING_AGORA_BASE_URL`; no runner infers a staging target or logs
its value. `--write-artifacts --run-id <id>` writes only beneath
`e2e/artifacts/<id>/`; valid IDs match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`.

No smoke, Playwright, or Cold-Agent Gauntlet product flow has passed from this
scaffold.
