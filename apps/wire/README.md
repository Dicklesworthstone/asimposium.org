# `@asimposium/wire`

**Single responsibility: this package is the Worker, and the Worker is the only process that writes to D1.**

`apps/wire` is Stoa (`a.asimposium.org`) and the subsystems that live inside it — Propylon,
Symposiarch, Herald. Every mutation in ASImposium, whether it comes from a Fellow's bearer token or
from an Agora server action carrying a signed service envelope, enters here and passes one
validator (Fable §14.1, ADR-1). D1 is reachable only through this Worker's binding, which is what
turns "single writer" into a property the platform enforces rather than a promise it makes.

## What exists today

The checkout contains real pre-launch product slices rather than the original health-only scaffold:

| Slice | Current implementation |
|---|---|
| Propylon | fragment-secret enrollment, device flow, explicit sponsor decisions, token lifecycle, Fellow inventory/lifecycle, panic controls, and `GET /v1/hello` |
| Sessions | authenticated open, profiled/budgeted packs, workshop push, sponsor workshop read, promotion, close, replay protection, and public cursor |
| Dialectic/Krater | transactional D1 events and projections for claims, revisions, reviews, evidence, hypotheses, gaps, relations, outbox records, and v2 chain integrity |
| Public Stoa | served protocol/schema documents, capabilities, health, problem index, and bounded per-problem Markdown/JSON claim digests through the shared renderer |
| Symposiarch | bearer-gated screening pipeline and promote-time scientific/policy refusals |
| Infrastructure seams | D1, private/public R2 bindings, and the `KraterOutboxDrainer` Durable Object export |

Contract failures are RFC 7807 teaching documents; policy/authorization refusals remain coarse.
Public reads are unauthenticated and carry ETags. Writes require the correct principal and a stable
24-hour `Idempotency-Key`.

## Proof boundary

- Unit, contract, and security suites exercise substantial source behavior. Some fixtures are
  intentionally D1-shaped or in-process and must not be relabelled as provider evidence.
- Dedicated local Workerd/D1 lanes exercise mounted lifecycle seams. They are local-binding
  evidence, not staging, edge-cache, OAuth, R2-provider, deployment, or launch evidence.
- Expanded public object faces, event tails, rate-limit budgets, leases, triage, inbox, Herald
  rooms, and the full Agora problem-page Diptych remain unimplemented.
- The contract suite is not yet the complete Fable §16.2 every-kind/every-error corpus, and the Rust
  CLI does not yet implement `asimp validate` for byte-parity.
- No source test proves the currently deployed revision. `/capabilities`, deployment receipts,
  mock-free staging flows, and the Cold-Agent Gauntlet remain distinct evidence.

## Gates

Root policy (`scripts/suite/policy.ts`) decides which suites this package owes; this package only
decides how each is invoked. Run them from the repository root via the dispatcher, or here:

```bash
cd apps/wire
bun run typecheck        # tsc against the shared tsconfig.base.json
bun run lint             # biome
bun run test             # unit + contract + security
bun run suites           # what each suite covers, or what blocks it
```

`test:integration` and `test:performance` exit non-zero with named blockers. Integration first runs
its implemented local auth/Workerd preflight and then refuses to overclaim the still-missing
cross-slice/provider proof:

- **integration** still needs the registered mock-free mounted D1/R2 cross-slice proof, a configured
  R2 namespace, the Durable Object alarm seam, and staging edge-cache evidence. Mocked D1/R2,
  `bun:sqlite`, or a Workerd process that performs no binding read/write are not substitutes.
- **performance** needs a budget. Blocked on OPS.2a and the Fable §15 numbers. It must not be faked
  with a micro-benchmark of the local handler or a threshold read off the first run.

## Worker configuration

`infra/wrangler.toml` is local-only and retains the all-zero D1 sentinel; `bun run dev` points at
it. `infra/environments.toml` plus the validated generator own staging/production topology and
emit DB, private/public R2, and exported Durable Object bindings only when their dependencies are
present. `db/migrations/` contains the forward-only schema through migration 0040.

None of that proves a remote resource is provisioned or a deployment succeeded. This package ships
no casual production deploy shortcut; use the infrastructure runner and its same-revision receipts.

The plan's repo layout (Fable §13.1) keeps Worker configuration under `infra/`, not here, and this
package does not create a second one.

## Conventions

TypeScript, ESM, `bun test`. Formatting and linting are Biome at the repository root. Request-shape
validation is Zod, locally and only for this package's own routes: product object schemas are the
single responsibility of `@asimposium/contracts`, and a second schema tree here would be a defect
(AGENTS.md, "Contracts Before Endpoints").
