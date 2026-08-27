# `@asimposium/contracts`

This package is ASImposium's Zod source of truth. It currently defines the
enrollment and sponsor planes, session/pack/workshop contracts, ledger writes
and public read faces, refusal documents, screening, health, and diagnostic
safety. Worker, Agora, renderer, and TypeScript tests consume these exports; a
second hand-written schema tree is a defect. The Rust CLI does not yet consume
the generated validation artifacts — that byte-parity work remains W11.

`src/*.ts` is authoritative. `generated/*.schema.json` and generated TypeScript
re-export faces are deterministic committed artifacts. Valid and invalid
fixtures exercise both acceptance and refusal, while the artifact manifest
fails if checked-in output drifts from source.

```bash
bun run --cwd packages/contracts generate
bun run --cwd packages/contracts check:drift
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
bun run --cwd packages/contracts test
```

`check:drift` never rewrites artifacts. It reports only safe structured
diagnostics and fails when a generated artifact is missing or stale.

This is substantial W1+ product contract coverage, not yet the complete Fable
§16.2 corpus over every object/error combination, and it does not establish the
promised byte-for-byte `asimp validate` parity because that CLI command is not
implemented.

## Embedded examples

Five agent-facing served schemas (enrollment, ledger, problem, screening,
sessions) embed top-level `examples` drawn from the corpus fixtures in
`test/fixtures/valid` and validated at generation time against the very Zod
contract each example claims to represent — whole-value union parse for the
screening matched arm, member-key placement for bundled documents. Generation
refuses loudly on any mismatch (a drifted contract can never publish stale or
lying examples), `generated/examples.index.json` is the machine-readable
index (kind, schema_url, example_count, fixture_sources), and the drift gate
asserts loader agreement. Non-agent artifacts carry no examples by
declaration. Rationale and acceptance: bead asimposiumorg-zjs9 (W1.4/goc).
