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

## Environments (OPS.3)

`environments.toml` is the single declarative topology for `local`, `staging`,
and `production`. It carries **no secrets and must never carry any**: signing
key *ids* are public identifiers, resource identifiers for remote environments
are written as `${VAR}` references resolved by CI, and the validator refuses a
literal id or anything key-shaped.

```bash
bun infra/validate-environments.mjs        # topology
bun infra/validate-environments.test.mjs   # 33-case negative corpus
bun infra/migrate.mjs --env local          # forward migration plan
bun infra/migrate.test.mjs                 # 18-case planner corpus
scripts/e2e-environments.sh staging        # rehearsal; blocks where it must
```

What the topology validator enforces: each environment owns a distinct D1
database, R2 buckets, and Durable Object namespace, and no two share any of
them; every environment declares both R2 roles, and **parity is compared by
role, not by bucket name**, so binding names stay identical while resources stay
disjoint; a `private-cas` bucket may never carry a public custom domain, and
only production may claim `artifacts.asimposium.org`; only production may hold
production keys, and `previous_kid` must differ from `current_kid` so a rotation
is a real overlap window; production may not permit destructive operations.

## Migrations

`db/migrations/` belongs to W2/S-2 and is read-only here — this directory
decides how migrations are *applied*, never what they contain.

Migrations are **forward-only**. There are no down-migrations, and a file named
like one is refused at read time; a mistake is corrected by writing the next
numbered migration. The runner is ordered (a migration below the applied head is
refused), checksummed (an edited migration is drift and stops the run; a deleted
one is a rewritten history), and idempotent (a second run applies nothing).
Destructive statements must both be declared in the file with
`-- asimposium:allow-destructive` and be permitted by the target environment;
production permits neither, and `--apply --env production` additionally requires
`--i-understand-this-is-production`. There is no default environment.

`--env local` applies against Wrangler's local D1 (workerd's own SQLite, no
account required). Remote environments refuse to apply until they are
provisioned; the runner never simulates an application. Local state lives in
`.wrangler/`, which is gitignored.
