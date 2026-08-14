# Seed-ladder rungs 1–5 source set

This directory prepares five bounded candidates for ADR-25. It is source preparation for W12.1, not a claim that any candidate has passed the real sharpening gate, run on staging, or received independent scientific validation.

| Rung | Dossier | Launch subsystem exercised |
|---|---|---|
| 1 | [Calibration](./01-calibration.md) | claims, independent review, and a planted false statement |
| 2 | [Reproduction](./02-reproduction.md) | versioned artifact, environment, target digest, and rerun semantics |
| 3 | [Counterexample](./03-counterexample.md) | bounded search, detection floors, falsification, and dead ends |
| 4 | [Formalization](./04-formalization.md) | statement binding, friction evidence, and the certified-review path |
| 5 | [Literature](./05-literature.md) | anchored citations, novelty review, and synthesis anchoring |

`oracles.json` is operator-only ground truth. It must not be included in a Fellow pack or passed to a participant before the relevant review exercise; the operational consumer is the W12.1 seed-run setup. The dossiers name the oracle IDs and the expected review behavior without exposing the answer payload in participant-facing material.

`check.mjs` is the W12.P1 acceptance gate. Its consumer is the eventual seed-import/review setup for W12.1; it catches metadata drift (missing anchors, absent rights status, bad target hashes, malformed freshness dates, visible statement/falsifier drift, broken local render fixtures, or a dossier silently losing its no-claim boundary). It is retained only until the real seed-import contract in `@asimposium/contracts` replaces these source-preparation checks.

Run the local checks with Bun; no dependency install or secret is required:

```bash
bun docs/seed/rungs-1-5/check.mjs
bun docs/seed/rungs-1-5/check.mjs --self-test
bun docs/seed/rungs-1-5/check.mjs --check-links
bun docs/seed/rungs-1-5/check.mjs --check-artifacts
```

The checker emits tool, suite, version, duration, status, and a safe reproduction command. Link probing is a freshness check only: an HTTP success proves reachability, not the mathematical correctness, licensing sufficiency, or future staging behavior of a candidate. A version-like documentation URL must record observed rendered-content version evidence; `--check-links` compares that declared version with the fetched HTML title without logging the page body, because its path alone cannot establish a tool version. `--check-artifacts` re-acquires each deliberately pinned public artifact and fails if its bytes no longer match the declared hash or hidden-oracle binding; its output contains only source identifiers and digests.

All source quotations are avoided. Sources are identified by URL and a short locator; their license or rights status is recorded in the manifest. Any future upload of a source body or code artifact requires its own licensing review and a content hash captured at acquisition time.
