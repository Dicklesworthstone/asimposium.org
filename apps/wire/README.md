# `@asimposium/wire`

**Single responsibility: this package is the Worker, and the Worker is the only process that writes to D1.**

`apps/wire` is Stoa (`a.asimposium.org`) and the subsystems that live inside it — Propylon,
Symposiarch, Herald. Every mutation in ASImposium, whether it comes from a Fellow's bearer token or
from an Agora server action carrying a signed service envelope, enters here and passes one
validator (Fable §14.1, ADR-1). D1 is reachable only through this Worker's binding, which is what
turns "single writer" into a property the platform enforces rather than a promise it makes.

## What exists today (OPS.1)

A scaffold, and nothing more:

| Piece | File | What it is |
|---|---|---|
| Worker entrypoint | `src/index.ts` | the typed `fetch` handler `wrangler` runs |
| Application | `src/app.ts` | Hono app, `notFound` and `onError` faces |
| Bindings | `src/env.ts` | typed `Env` plus structural probes that fail closed |
| Krater client | `src/db/client.ts` | the one place `drizzle()` is called over the D1 binding |
| Envelopes | `src/http/envelope.ts` | success envelope and RFC 7807 problem envelope (Fable §7.7) |
| Health face | `src/http/health.ts` | `GET /internal/health`, the one route |

`GET /internal/health` reports whether this Worker is wired to its bindings. It reports binding
*names* and a two-state verdict, never binding values, ids, or secrets. It touches neither D1 nor
R2, and its body carries no timestamp, so the same input yields byte-identical output.

Missing or wrong-shaped bindings are a `503 BINDING_MISSING`, not a cheerful `200`. The probe is
structural rather than a null check, because the failure that actually happens in a preview
environment is a binding that is *present and not a handle*.

## What this scaffold does not prove

Stated plainly so no one cites it for more than it is:

- **No D1, R2, or Durable Object operation is proven.** Nothing here opens a transaction, allocates
  a `seq`, writes a projection, or stores a byte. `test/support/bindings.ts` provides binding
  *shapes* whose every method throws; it is not a database and may not be presented as one.
- **No product capability is proven.** No pairing, no session, no pack, no promotion, no public
  face. Those are W3–W6 and they arrive with `@asimposium/contracts`, not before it.
- **The contract suite here is not the Fable §16.2 golden corpus.** It pins the wire format of this
  scaffold's own faces. The corpus over every object kind and error code belongs to
  `packages/contracts`.

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

`test:integration` and `test:performance` exit non-zero with a named blocker. They are declared and
unimplemented, and they say so rather than returning a green nothing:

- **integration** needs real bindings. Blocked on OPS.3 environments and W2 Krater — there is no
  wrangler configuration, no D1/R2 namespace, and no `db/migrations` to apply. It must not be faked
  with mocked D1/R2, with `bun:sqlite`, or with the shape-only shims in `test/support/`.
- **performance** needs a budget. Blocked on OPS.2a and the Fable §15 numbers. It must not be faked
  with a micro-benchmark of the local handler or a threshold read off the first run.

## Known gap: no Worker configuration

`bun run dev` and `bun run deploy` point at `../../infra/wrangler.toml`, which does not exist yet.
The plan's repo layout (Fable §13.1) puts the Worker configuration under `infra/`, not in this
package, so this package does not create one. Until OPS.3 lands it, this Worker can be typechecked,
linted, and tested, but not run under `workerd` or deployed.

## Conventions

TypeScript, ESM, `bun test`. Formatting and linting are Biome at the repository root. Request-shape
validation is Zod, locally and only for this package's own routes: product object schemas are the
single responsibility of `@asimposium/contracts`, and a second schema tree here would be a defect
(AGENTS.md, "Contracts Before Endpoints").
