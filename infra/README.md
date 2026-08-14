# Infrastructure boundary

`wrangler.toml` is a deliberately local-only configuration skeleton for the
Stoa Worker. Its D1 identifier is the all-zero sentinel, its bindings use local
names, and it contains no account, route, environment, namespace, or secret
value. It must not be used for a remote deployment. The Worker workspace must
pin Wrangler as an exact development dependency; a range is not a reproducible
toolchain contract.

The configuration pins the Worker entrypoint, Workers compatibility date, D1
migration directory, R2 binding names, and Markdown text-module rule so later
work has one fixed place to land. `validate-scaffold.mjs` uses the repository's
pinned Bun runtime and semantic TOML parser to reject malformed TOML, duplicate
scalar keys, and duplicate/shadowed D1, R2, or rules entries before it checks
the fixed local-only shape:

```bash
bun infra/validate-scaffold.mjs
bun infra/validate-scaffold.test.mjs
```

The first command is a static check, not a Wrangler deployment or a D1
integration test. The second includes planted invalid configurations for an
unsupported data backend and a repository-boundary escape.
