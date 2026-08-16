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

## What is actually here

A partial prelaunch Agora and its gates. The live code has moved beyond the
original OPS.1 scaffold, but it is not the W8 human surface and must not be
described as one.

| Present | Not present, by design |
|---|---|
| App Router landing, Google-only sign-in UI, host-only session cookie | Public problem pages, workshop view, director grammar (W8) |
| Session-gated sponsor console and device-code approval page | A deployed/verified Google OAuth client in every environment |
| Signed Worker calls for sponsor bootstrap, mint, pending decisions, and Fellow inventory | Direct D1 access (never in this package); lifecycle mutation controls and the full W3.7 E2E |
| `GET /api/health` and Tailwind v4 presentation | Complete design system, dark-mode pass, KaTeX, OG routes (W8) |
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
bun run test:security    # owed, unimplemented, exits 2 with its blocker
bun run build            # next build
```

Root policy (`scripts/suite/policy.ts`) assigns this package the baseline
(`typecheck`, `lint`, `test:unit`) plus `contract` and `security`. Those are the
scripts that exist. `test:integration`, `test:e2e` and `test:performance` are
**deliberately not declared**: the dispatcher executes any script it finds
(resolution rule 1), so declaring a deliberate blocker for a suite this package
does not owe turned three root suites permanently red while adding no coverage.
Nothing is lost by their absence — human E2E against staging is Playwright plus
the Cold-Agent Gauntlet in `e2e/`, which owns that gate; Agora's integration and
budget work arrives with W8/W10 and will be declared here when there is
something real to run.

Every gate prints one `ASIMP-GATE {...}` line: package, suite, tool, tool
version, runner version, duration, status, exit code, and a reproduction
command. Child stdout **and stderr** are inherited untouched — a gate that hides
stderr is not evidence. Record fields pass through the redaction layer in
`scripts/gate-record.ts` (bearer tokens, join-URL fragment secrets, secret-shaped
env assignments, absolute paths), which is unit-tested against planted
secret-shaped inputs rather than trusted.

`test:security` exists and **exits 2** with `status:"not_implemented"`, naming
the bead that unblocks it. It is excluded from the `test` aggregate on purpose:
a red gate nothing can turn green is noise, and a green gate that ran nothing is
a lie. Asked directly, it tells the truth.

## Environment

Read by Auth.js at runtime; never at module scope, never in a build artifact:

- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`

Sensitive sponsor actions use Google's signed OIDC `auth_time`, not the time an
OAuth callback happened. The Google Auth Platform application must therefore
be published and verified with **Session age claims** enabled. If Google omits
the claim, ordinary sign-in still works but decision step-up fails closed.
Google does not let a relying party force Google Account reauthentication; the
UI reports stale evidence honestly rather than minting freshness locally.

Read by the sponsor console's server-only Stoa client at call time:

- `SERVICE_ENVELOPE_PRIVATE_KEY_HEX`, `SERVICE_ENVELOPE_KID`
- `ENROLLMENT_RECOVERY_HMAC_KEY_HEX` — an independent 32-byte lowercase-hex
  secret used only to derive opaque browser recovery identities. Keep it stable
  for at least 24 hours after the last write prepared under it; rotating it
  sooner can prevent recovery of an ambiguously completed one-time mint.

None are needed for `typecheck`, `lint`, `test`, or `build`.

## Fixtures

`test/fixtures/` holds one valid App Router tree and eight malformed ones, one
per routing rule, plus `auth/` — a valid Propylon configuration, a valid aliased
Google import, and ten mutations of it. They are excluded from `tsconfig.json`
and `eslint.config.mjs` because most of them are invalid on purpose. A fixture
that stops failing is a regression in the validator, not a fixture to repair.

The `auth/` corpus exists because the first version of these checks was three
regexes over source text and an adversarial probe defeated all three in one
pass. Five review rounds followed, each finding a way the property could be true
in the file and false in the running application:

| Round | Bypass |
|---|---|
| 1 | `domain` inline on an existing line · hyphenated provider package · destructured secret |
| 2 | locally-built provider · imported-but-unused Google · spread provider array · `process["env"]` · aliased `process` |
| 3 | duplicate Google entry · two factory calls, second one exported · locally-defined `NextAuth` · IIFE · static class initialiser · `globalThis["pro"+"cess"]` · aliased `Bun` |
| 4 | safe unused call plus a fake exported factory · `await import()` · `require` · `eval` |
| 5 | Node's `global` root · `Function`/`eval` aliased before being called · `handlers` real while `auth`/`signIn`/`signOut` are fake |

`scripts/auth-contract.ts` is therefore an **allowlist over one small file**, not
a scanner: enumerating bad shapes is what kept losing. It resolves the single
imported Auth.js call, requires all four public bindings to be destructured from
*that* call, requires exactly one provider entry resolving to the imported
Google module, requires literal cookie options without `domain`, permits exactly
one environment expression in the whole file (`process.env.NODE_ENV`, written
that way), allowlists imports to `next-auth` and the Google provider, and
refuses every reference to `require`, `eval`, `Function` and dynamic `import`.
Anything it cannot resolve is a refusal — "I did not see it" must never be
recorded as "it is not there".

It analyses one file's syntax. It does not follow imports, does not evaluate
code, and proves nothing about the `Set-Cookie` header a running server emits.
