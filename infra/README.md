# Infrastructure boundary

`wrangler.toml` is a deliberately local-only configuration skeleton for the
Stoa Worker. Its D1 identifier is the all-zero sentinel, its bindings use local
names, and it contains no account, route, environment, namespace, or secret
value. It must not be used for a remote deployment. The Worker workspace must
pin Wrangler as an exact development dependency; a range is not a reproducible
toolchain contract.

The configuration pins the Worker entrypoint, Workers compatibility date, D1
migration directory, R2 binding names, and served-text module rule for
Markdown, `llms.txt`, and generated `*.schema.json` documents so later work
has one fixed place to land.
`validate-scaffold.mjs` uses the repository's
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
bun infra/validate-environments.test.mjs   # 84-case negative corpus
bun infra/generate-wrangler.test.mjs       # 28-case generated-config contract
bun infra/migrate.mjs --env local          # forward migration plan
bun infra/migrate.test.mjs                 # 38-case planner corpus
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

Both tools redact at the throw site, so every structured diagnostic they print
is scanned before it reaches stdout or stderr — including the caller-controlled
`--env` and `--config` text, which a mistyped token would otherwise have echoed
back by the tool that refused it. Credential families come from
`@asimposium/contracts/diagnostic-safety` rather than being restated here; what
stays local is what that scanner deliberately declines — absolute paths, and the
short credential *prefixes* that have no benign reading in a file whose every
legitimate value is a name, an id, or a `${VAR}` reference.

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

`--state-file` describes a *rehearsal* and cannot be combined with `--apply`: a
caller-supplied file claiming a migration is already applied would otherwise
skip one that never ran. An application reads the target's own ledger or it does
not apply. State files and the migrations directory are both contained to the
repository, lexically and after symlink resolution.

## Generated per-environment Wrangler configuration

`infra/environments/<env>.wrangler.toml` is generated from the topology and is
not hand-edited:

```bash
bun infra/generate-wrangler.mjs --check    # reconcile (CI gate)
bun infra/generate-wrangler.mjs --write    # regenerate, then review the diff
bun infra/generate-wrangler.test.mjs       # generated-config contract
```

Generation is a pure function of the validated topology — same input, same
bytes, no timestamps — so drift is detectable rather than silent. The contract
suite parses the generated TOML back and reconciles it field by field: D1
binding/name/id, both R2 roles and bindings, the Durable Object binding and
class, the Markdown, text, and generated-schema Text rule, and the exact required binding set. It also holds
the safety properties in the generated artifact: no Worker `route` (a bucket is
published by an R2 custom domain, never by putting the Worker on the blob path),
no `custom_domain` on any bucket entry, no `account_id`, no literal
resource id, no credential shape, and the apex artifact hostname mentioned in
production's file alone.

A generated config carries exactly one `[vars]` entry — `STOA_ORIGIN`, the
non-secret origin projected from that environment's `worker_origin`, so the
Worker never has to ask a request which origin it is serving. The contract
suite enumerates the key set exhaustively, so a second variable appearing there
is a new disclosure that fails rather than passing unnoticed. The checked-in
`production.deploy.wrangler.toml` overlay carries that same `STOA_ORIGIN` plus
`SERVICE_ENVELOPE_KEYS`, which holds public Ed25519 verification keys only; its
key set is pinned by the same suite. Reconciliation also enumerates the
directory, so a stale config left behind by a renamed environment is reported
as surplus rather than sitting unnoticed beside the generated set.

**These files are not directly deployable as written.** Resource ids remain
`${VAR}` references and Wrangler does not interpolate environment variables in
its configuration, so CI must substitute them at deploy time. That is recorded
rather than hidden.

## What OPS.3 does NOT yet do

Stated plainly so this tooling is not mistaken for a working environment. **OPS.3
cannot close on the strength of what is here.**

- **The Worker implements the emitted binding subset, not the whole topology.**
  The topology's `required_bindings` roster is five — `DB`, `ARTIFACTS`,
  `PUBLIC_ARTIFACTS`, `HERALD_ROOMS`, `KRATER_OUTBOX`. `apps/wire` requires the
  four emitted bindings: D1, the private `ARTIFACTS` CAS bucket, the separate
  `PUBLIC_ARTIFACTS` delivery bucket, and the outbox. `/internal/health` checks
  their handle shapes only and discloses names plus bound/missing state, never
  bucket values. It does not read, write, or serve either bucket: Fable §10.4's
  `/sha256/<hex>` path remains direct R2 delivery. `HERALD_ROOMS` is still
  deferred (below). One Durable Object class **is** exported —
  `KraterOutboxDrainer`, which is why its binding is emitted rather than
  deferred.
- **A Durable Object binding without an exported class fails `wrangler deploy`.**
  `HERALD_ROOMS` is therefore declared in `environments.toml` but listed in
  `policy.deferred_bindings`, so it is withheld from every generated config
  until `apps/wire/src/index.ts` exports `HeraldRoom` with W7. The validator
  reconciles both directions against that entrypoint: an emitted class must
  already be exported, and a deferred class must not be. Deferral applies to
  every environment identically, so parity holds by uniform absence. Retire the
  entry on the same change that adds the export.
- **Remote apply does not exist.** `--apply` works only against local D1.
  Staging and production refuse, by design, until provisioned.
- **Vercel wiring is declared, not applied.** `[vercel]` records which
  environment each deployment target must call, and the validator enforces that
  previews never reach production — but no Vercel project setting has been read
  or written.
- **No remote resource has ever been created, read, or written.** No D1 database,
  R2 bucket, Durable Object namespace, custom domain, deployment, or console
  change. The private-canary requirement — that a private-only object is
  unreachable through every public hostname while its authenticated owner
  retrieves it — is **unproven** and needs real buckets.

Validating the topology proves the *contract* is coherent, and generation proves
the deployable artifact matches it. Neither proves that any named resource
exists.
