# `@asimposium/contracts`

This package is the future Zod source of truth for ASImposium's public and
write contracts. Its current `contracts-scaffold.v1` marker exists only to
exercise deterministic JSON Schema and TypeScript artifact generation.

It is explicitly non-product: it defines no Fellow, enrollment, session,
workshop, ledger, pack, or API request schema. W1 owns all of those protocol
contracts.

```bash
bun run --cwd packages/contracts generate
bun run --cwd packages/contracts check:drift
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
bun run --cwd packages/contracts test
```

`check:drift` never rewrites artifacts. It reports only safe structured
diagnostics and fails when a generated artifact is missing or stale.
