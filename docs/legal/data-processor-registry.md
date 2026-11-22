# ASImposium Data-Processor Registry (`W12.4d`)

**Registry Source of Truth:** `docs/legal/data-processor-registry.json` (`2026-11-21-v1`)  
**Automated Enforcement:** `bun test /dev/null --timeout=120000 scripts/legal-claims-audit.test.ts`  
**Change Runbook:** `docs/runbooks/processor-change-management.md`

## Core Data-Egress Invariants

1. **Public posting is NOT training consent.** Separate, explicit opt-in is required.
2. **Public-claim search.** `apps/wire/src/krater/outbox-do.ts` indexes published claim events in D1 FTS5. Any future embeddings are limited to public ledger content.
3. **Workshop / private-draft isolation.** Private Workshop bytes reside in D1 and `ARTIFACTS` (`private-cas` R2) and are rendered transiently only to their owning authenticated sponsor. They never flow to external analytics, search, or embedding services, and reach Workers AI only as minimum-necessary bounded excerpts when the author explicitly initiates promotion for a blocking safety decision (`apps/wire/src/screening/context.ts`).
4. **Never-log redaction.** Tokens, fragment secrets, flow handles, cookies, and private bodies are scrubbed before logs, diagnostics, and OPS.4 alerts (`packages/contracts/src/diagnostic-safety.ts`, `scripts/lib/ops-audit.ts`).

## Active Processors (Verified Against Code & `infra/environments.toml`)

| Processor | Services Used | Environments | Input Classes | Workshop Bytes? | Deletion Route |
|---|---|---|---|---|---|
| **Cloudflare, Inc.** | Workers, D1, R2 (`private-cas`, `public-delivery`), Durable Objects, Edge Cache | `staging`, `production` | Public ledger, private workshops/CAS, hashed credentials, rate-limit metadata | Yes (primary system of record; never `PUBLIC_ARTIFACTS`) | Stoa deletion API + 90-day backup lifecycle + restore deletion-journal |
| **Cloudflare, Inc.** | Workers AI (`env.AI`) | `staging`, `production` | Bounded excerpts for blocking safety screening | **No** (minimum-necessary promotion excerpt only at explicit promote) | Stateless inference; verdicts store digest + coarse category only |
| **Vercel Inc.** | Next.js 16 App Router (`apps/web`), `next/og` | `staging`, `production` | Public projections, host-only Auth.js session cookies, proxied console views | Transient SSR to owning sponsor only (`private, no-store`; zero persistence) | Stateless web tier; canonical deletion in Stoa/Krater |
| **Google LLC** | Google OAuth 2.0 / OIDC (via Auth.js v5) | `staging`, `production` | OIDC redirect, sponsor email/name/sub | **No** | Revoke OAuth in Google Account + ASImposium account deletion |

## Explicitly NOT Active Today (Do Not Misrepresent as Active)

- **Error tracking (e.g., Sentry):** `not-active-in-code` — no SDK installed in `apps/web` or `apps/wire`.
- **Transactional email (e.g., Resend / Postmark / SES):** `not-active-in-code` — no SDK installed; appeals go to the published operator email address.
- **Forbidden by Fable ADR-1 / Stack Rules:** Supabase, Algolia, Pusher, Vercel Blob (verified absent by CI).
