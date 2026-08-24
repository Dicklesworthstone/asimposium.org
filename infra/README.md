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

### Staging deploy resolution

`resolve-wrangler-deploy.mjs` is the narrow, source-local bridge from the
validated generated staging template to one ignored deploy artifact:

```bash
bun infra/resolve-wrangler-deploy.mjs --env staging --check
# Later, in an authorized staging deploy environment only:
bun infra/resolve-wrangler-deploy.mjs --env staging --write
```

It accepts only `ASIMP_D1_DATABASE_ID_STAGING` (a canonical nonzero UUID) and
`ASIMP_STAGING_SERVICE_ENVELOPE_KEYS` (the two declared staging public
verification-key records). It revalidates the generated staging bytes, derives
the Worker custom-domain route solely from staging `worker_origin`, and writes
only `infra/deploy-resolved/staging.wrangler.toml`. It never reads a route,
origin, R2 hostname, account id, or secret from ambient input. The public R2
hostname remains an R2 custom domain rather than a Worker route; `ARTIFACTS`
and `PUBLIC_ARTIFACTS` remain distinct bindings; and deferred `HERALD_ROOMS`
remains absent. Local, production, and unknown environments are refused.

The artifact directory is gitignored. Publication uses exclusive creation: an
equal existing artifact is an idempotent success, while a symlink or different
existing artifact is refused rather than replaced. This resolver creates no
provider resource and does not establish that the D1 database, custom domain,
R2 buckets, or key deployment exists. An operator must later supply the exact
artifact to an authorized deploy command and separately prove the remote plane.

### Hosted review pipeline (OPS.2b)

The selected hosted-runner design is **Cloudflare Workers Builds with its native
GitHub integration**. GitHub Actions remains unavailable and forbidden for this
repository. Source configuration does not prove that this trigger has been
installed or is available. When installed, the required `main` trigger uses the
repository root and these commands:

```text
build command:  bash scripts/gates.sh --all
deploy command: ASIMP_CI_RUNNER=cloudflare-workers-builds bash scripts/e2e-ci-pipeline.sh
root directory: /
branches:       include main; exclude none
```

Set `BUN_VERSION=1.3.8`; the repository requires that version while the provider
image's default can be older. The build command makes the canonical root gate
the first provider result. The
deploy command deliberately runs that gate again before any mutation; a stale
or independently invoked deploy phase therefore cannot borrow another build's
green result. It then performs, in order: `smoke-agent.sh` against the canonical
staging Worker; `smoke-gallery.sh` against the canonical staging Agora; staging
Worker deploy; the existing environment rehearsal, including two remote D1
migration applications whose second receipt must report an empty applied set
and an idempotent second plan, plus an R2 canary
write/read/public-absence/delete cycle; live health; capability-derived schema
reads; and a same-checkout Vercel preview tagged with the Git revision. A
failure, blocked exit, timeout, or cancellation stops the sequence and records
every later stage as `not-run`. Preview smoke therefore gates all deployment,
and web deployment cannot start before the Worker receipt and readiness checks
pass. Those two pre-deployment smokes observe the revisions already serving on
the canonical staging origins; their stage records therefore carry a null
`subject_revision`. They are regression gates, not evidence that the current
checkout was deployed. Worker deployment, readiness, and web deployment bind
`subject_revision` to the current checkout only after their provider receipts
establish that relationship.

Every real stage command executes from an explicit operational environment allowlist.
The Fellow smoke token is passed only to the agent smoke; Cloudflare authority
is passed only to Worker deployment/readiness and the final active-deployment
re-attestation; Vercel authority is passed only to web deployment. Root gates
and gallery smoke receive none of those credentials.
Within those stages, credentials are narrowed again: static environment checks,
HTTP probes, and receipt parsers do not inherit provider tokens; Wrangler and
Vercel CLI processes receive only their own provider authority.

Configure these Workers Builds variables. Provider credentials and the Fellow
token are secrets; resource/project identifiers, the runner label, and public
verification-key records are not credentials but should still be scoped to
this trigger:

```text
BUN_VERSION=1.3.8
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN                         (secret)
ASIMP_D1_DATABASE_ID_STAGING
ASIMP_STAGING_SERVICE_ENVELOPE_KEYS
VERCEL_ORG_ID
VERCEL_PROJECT_ID
VERCEL_TOKEN                                 (secret)
ASIMPOSIUM_SMOKE_FELLOW_TOKEN                (secret; required for full agent smoke)
```

Workers Builds itself injects `CI=true`, `WORKERS_CI=1`,
`WORKERS_CI_BUILD_UUID`, and `WORKERS_CI_COMMIT_SHA`. The pipeline refuses the
hosted runner label unless those values are present and the provider commit SHA
equals the checkout revision; the build UUID is retained in the run evidence.
The Vercel CLI is invoked through Bun at the source-pinned `59.5.0` version, so
the provider image does not need an ambient global `vercel` binary.

Vercel's Preview environment must already hold its Auth.js and service-envelope
secrets. The pipeline pins `STOA_ORIGIN` to the staging Worker at both build and
runtime, waits for the deployment, and checks Vercel's API for the exact project,
Preview target, ready state, and requested revision metadata; it never promotes
that preview to production. It also re-observes Cloudflare's active deployment,
including the expected Worker version and revision message, after Worker
readiness and again after the Vercel preview reaches ready.

Before activating this trigger, disconnect the Vercel project's Git integration.
Otherwise Vercel can start a web build directly from the push and race the
Worker readiness gate. The pipeline queries the Vercel project before deploying
and returns blocked exit 78 while a Git link remains; a configuration label or
operator assertion cannot bypass that provider-state check. This ordered CLI
preview path supersedes the earlier native-Git preview plan. Launch promotion
remains a separately owned gate.

The web stage also requires a read-only API observation of at least one existing
Preview deployment for the exact project before it mutates anything. This
fails closed for a newly initialized project because a post-deploy target check
cannot undo a first deployment that a provider classified as Production despite
Preview intent. The CLI also uses `--skip-domain` as a second containment layer,
so an incorrect provider classification cannot assign a production domain while
the final check is pending. The new deployment is still checked independently
through the v13 API for exact project, exact Preview target, ready state, and
revision metadata.

Each run retains ignored evidence under `e2e/artifacts/<run-id>/`: the exact Git
revision, runner label, ordered stage statuses, safe Cloudflare/Vercel deployment
IDs and UTC observations, and explicit delegated-suite status. Wrangler's own
NDJSON receipt is captured with its supported output-file interface. The live
suite owners may supply only `pass`, `blocked`, `not-run`, or `stale`. Every
non-`not-run` value requires a real UTC observation and the exact Git revision
it describes; `pass` and `blocked` must name the current pipeline revision.
Supply these triples:

```text
ASIMP_CI_GAUNTLET_STATUS / ASIMP_CI_GAUNTLET_OBSERVED_AT / ASIMP_CI_GAUNTLET_REVISION
ASIMP_CI_PLAYWRIGHT_STATUS / ASIMP_CI_PLAYWRIGHT_OBSERVED_AT / ASIMP_CI_PLAYWRIGHT_REVISION
ASIMP_CI_LOAD_STATUS / ASIMP_CI_LOAD_OBSERVED_AT / ASIMP_CI_LOAD_REVISION
ASIMP_CI_RESTORE_STATUS / ASIMP_CI_RESTORE_OBSERVED_AT / ASIMP_CI_RESTORE_REVISION
ASIMP_CI_LAUNCH_STATUS / ASIMP_CI_LAUNCH_OBSERVED_AT / ASIMP_CI_LAUNCH_REVISION
ASIMP_CI_RELEASE_STATUS / ASIMP_CI_RELEASE_OBSERVED_AT / ASIMP_CI_RELEASE_REVISION
```

Their default is `not-run`; the pipeline never converts absence into green.
Those records are a handoff, not substitute execution: the gauntlet, Playwright,
load, restore, launch, and release Beads remain authoritative. Source presence
also does not prove the Workers Builds trigger is installed or passing. Closing
OPS.2b requires a provider build record bound to the same revision and the
deployment receipts emitted by that run.

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
- **Remote apply is staging-only and provisioning-dependent.** The runner has a
  bounded, exact-target staging apply path and refuses production. It cannot run
  until the ignored staging config has been resolved against an authorized,
  provisioned D1 target; source inspection is not evidence that this happened.
- **Vercel wiring is declared, not applied.** `[vercel]` records which
  environment each deployment target must call, and the validator enforces that
  previews never reach production — but no Vercel project setting has been read
  or written.
- **Current remote resource state is not proven by this repository.** Source
  does not establish that any D1 database, R2 bucket, Durable Object namespace,
  custom domain, deployment, or console wiring currently exists or matches the
  checkout. The private-canary requirement is proven only by a successful live
  staging receipt that reads the object through the owner binding while the
  public probe is absent, then removes it; no such receipt is present here.

Validating the topology proves the *contract* is coherent, and generation proves
the deployable artifact matches it. Neither proves that any named resource
exists.
