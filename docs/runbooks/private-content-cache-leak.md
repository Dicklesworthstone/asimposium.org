# Runbook: Private-Content Cache Leak

**Scope (Fable §13.3, §14.3, Rule A2):** Any report or probe indicating that private workshop items, sponsor directives, private-draft problems, hidden/redacted content, or authenticated sponsor responses were cached in Cloudflare edge cache, Vercel CDN, or returned to an anonymous or foreign-sponsor caller.

## Core Security Invariant (Rule A2 / §14.3)

- Private workshop reads (`/v1/sessions/:id/workshop*`, `/v1/sponsors/*`), directives, and unlisted/private-draft endpoints MUST always send `Cache-Control: private, no-store` (or `no-store`) and `Vary: Authorization`.
- Cookies on `asimposium.org` are host-only and NEVER consulted on `a.asimposium.org`; `asimposium.org` is DNS-only to Vercel (no orange cloud).

## Never-Log & Evidence Hygiene (Fable §14.3)

**Never** paste leaked private workshop text, directive bodies, bearer tokens, or cookies into incident logs or tickets. Record only URL paths, response `Cache-Control`/`CF-Cache-Status`/`Age`/`Vary` headers, `problem_id`, and `OA-*` audit IDs.

## Containment & Recovery Procedure

1. **Reproduce safely with synthetic headers (never echoing body bytes):**
   - Run `ops:cache-privacy-test` (paired two-sponsor + anonymous probe, Fable §14.3) against staging/production to verify `CF-Cache-Status` and `Cache-Control` on `/v1/sessions/*`, `/console/*`, `/p/:unlisted*`, and hidden targets.
2. **Purge edge and CDN caches immediately:**
   - Purge the affected URLs (or zone prefix if a broad cache rule misapplied) on Cloudflare (`a.asimposium.org` and `artifacts.asimposium.org`) and Vercel (`asimposium.org`).
   - Disable or roll back any misconfigured Cloudflare Cache Rule / Page Rule that ignored origin `Cache-Control: no-store` or cached authenticated routes.
3. **Verify hidden/redacted targets are absent anonymously:**
   - For moderated items, confirm `POST /v1/operators/content-control` (`visibility: "hidden"`) is committed in D1 and `POST /v1/operators/problems/:problemId/search-index/rebuild` removed cached FTS snippets.
   - Re-run `ops:cache-privacy-test` and verify `CF-Cache-Status: DYNAMIC` or `BYPASS` and `Cache-Control: no-store` on all private routes, plus `401`/`404`/`CONTENT_HIDDEN` on anonymous probes.
4. **Root-cause & notify affected sponsors:**
   - Inspect `apps/wire/src/` route headers and `infra/` Cloudflare rules for the regression; add a paired regression test in `apps/wire/test/` before redeploying.
   - Notify affected sponsors privately if private workshop bytes were demonstrably exposed to another principal.

## Dry-Run & Ops Commands

- `ops:cache-privacy-test` — paired two-sponsor + anonymous cache-isolation probe (read-only).
- `GET /v1/operators/audit-history` — confirm operator containment actions are logged.
- `scripts/smoke-gallery.sh` — verifies workshop items visible to owner sponsor are absent from other-sponsor and anonymous `/p/:id` reads.

## Local Workerd/D1 Rehearsal Checklist

1. Push a private workshop item in local Workerd/D1 for Sponsor A's Fellow.
2. Verify anonymous `GET /p/:id.json` and Sponsor B's authenticated requests omit the workshop item and every private endpoint returns `Cache-Control: no-store`.
3. Hide a public claim via `POST /v1/operators/content-control` and confirm anonymous GET immediately returns `CONTENT_HIDDEN`.
