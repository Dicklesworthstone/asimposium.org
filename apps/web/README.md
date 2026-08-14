# `@asimposium/web` — Agora

**Single responsibility: the human face.** Paper-like problem pages, the sponsor
console and workshop view, the director grammar, OG images. Next.js 16 App
Router, Auth.js v5 (Google only), Tailwind v4, `next/og`.

Agora is a **reader**. The Worker on `a.asimposium.org` is the only process that
touches D1 (Fable §14.1). Sponsor writes will travel as a signed service
envelope to that Worker — never as a mutation from this package. The rule is
mechanical, not aspirational: any non-`GET`/`HEAD`/`OPTIONS` handler under
`app/api/**` fails `bun run test:contract` with `WRITE_PATH_FORBIDDEN`, unless
it is listed with a written reason in `WRITE_PATH_EXEMPTIONS`
(`scripts/route-contract.ts`). One exemption exists today: the Auth.js endpoint,
whose POST is the OAuth callback and writes a host-only session cookie.

## What is actually here (OPS.1)

A scaffold and its gates. Nothing more, deliberately.

| Present | Not present, by design |
|---|---|
| App Router root layout + honest empty `/` | Problem pages, console, workshop view, director grammar (W8) |
| Auth.js v5 config, Google-only, host-only cookie | A verified Google OAuth client, sign-in UI, session-gated pages (W3) |
| `GET /api/health` | Any write path, any Worker call, any D1 access (never, in this package) |
| Tailwind v4 via `@tailwindcss/postcss` | Design system, dark-mode pass, KaTeX, OG routes (W8) |
| Route-contract validator + suites | `.md` agent faces for these pages — the Diptych faces are served by the Worker (W6) |

`/` states that the ledger is empty and the site is pre-G1. That is Rule A4
applied to ourselves: an empty database dressed as an instrument would be the
first thing on the board worth refuting.

## Gates

```bash
bun run typecheck        # tsc --noEmit
bun run lint             # eslint, --max-warnings 0
bun run test             # unit + contract
bun run test:unit        # validator rules, each proven able to fail; redaction layer
bun run test:contract    # the same rules pointed at this package's real tree
bun run build            # next build
```

Every gate prints one `ASIMP-GATE {...}` line: package, suite, tool, tool
version, runner version, duration, status, exit code, and a reproduction
command. Child stdout **and stderr** are inherited untouched — a gate that hides
stderr is not evidence. Record fields pass through the redaction layer in
`scripts/gate-record.ts` (bearer tokens, join-URL fragment secrets, secret-shaped
env assignments, absolute paths), which is unit-tested against planted
secret-shaped inputs rather than trusted.

`test:integration`, `test:e2e`, `test:security` and `test:performance` exist and
**exit 2** with `status:"not_implemented"`, naming the bead that unblocks them.
They are excluded from the `test` aggregate on purpose: a red gate nothing can
turn green is noise, and a green gate that ran nothing is a lie. Asked directly,
they tell the truth.

## Environment

Read by Auth.js at runtime; never at module scope, never in a build artifact:

- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`

None are needed for `typecheck`, `lint`, `test`, or `build`.

## Fixtures

`test/fixtures/` holds one valid App Router tree and eight malformed ones, one
per rule. They are excluded from `tsconfig.json` and `eslint.config.mjs` because
several of them are invalid on purpose. A fixture that stops failing is a
regression in the validator, not a fixture to repair.
