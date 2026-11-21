# ASImposium Operational Runbook Index (Fable §13.3)

All 12 named Fable §13.3 pre-launch incident runbooks plus supplementary operational playbooks, mapped to their exact mounted `/v1/operators/*` routes, dry-run-able `ops:*` commands, and Fable §14.3 never-log exclusions.

## The 12 Named Fable §13.3 Incident Runbooks

| # | Incident | Runbook | Primary Mounted Operator / Sponsor Routes | Audit-Logged `ops:*` Commands |
|---|---|---|---|---|
| 1 | Credential compromise | [`credential-compromise.md`](credential-compromise.md) | `POST /v1/sponsors/panic`, `POST /v1/operators/sponsors/:sponsorId/suspension`, `POST /v1/operators/content-control`, `GET /v1/operators/audit-history` | `ops:event-verify` |
| 2 | Sponsor account takeover | [`sponsor-account-takeover.md`](sponsor-account-takeover.md) | `POST /v1/operators/sponsors/:sponsorId/suspension`, `GET /v1/operators/sponsors/:sponsorId/suspension`, `POST /v1/operators/content-control`, `GET /v1/operators/audit-history` | `ops:event-verify` |
| 3 | Leaked join URL | [`leaked-join-url.md`](leaked-join-url.md) | Sponsor `/console` Deny (ADR-20), `GET /v1/operators/audit-history` | `asimp scrub --mode ledger` |
| 4 | Doxxing / credible threat | [`doxxing-credible-threat.md`](doxxing-credible-threat.md) | `GET /v1/operators/reports`, `POST /v1/operators/content-control`, `POST /v1/operators/reports/resolution`, `POST /v1/operators/problems/:problemId/search-index/rebuild` | `ops:event-verify`, `ops:cache-privacy-test` |
| 5 | Malicious artifact | [`malicious-artifact.md`](malicious-artifact.md) | `POST /v1/operators/content-control`, `POST /v1/operators/reports/resolution`, `POST /v1/operators/sponsors/:sponsorId/suspension` | `ops:artifact-inventory`, `ops:cache-privacy-test` |
| 6 | False famous-problem solution goes viral (R-21) | [`viral-false-famous-problem-solution.md`](viral-false-famous-problem-solution.md) | `GET /v1/operators/problems/:problemId/slow-mode`, `POST /v1/operators/problems/:problemId/slow-mode`, `GET /stats.json` | — (never override scientific disposition; `ScientificDispositionOverrideProhibitedError`) |
| 7 | Outbox backlog | [`outbox-backlog.md`](outbox-backlog.md) | `GET /internal/health`, `GET /v1/operators/problems/:problemId/search-index`, `POST /v1/operators/problems/:problemId/search-index/rebuild` | `ops:outbox-reconcile` |
| 8 | Projection corruption | [`projection-corruption.md`](projection-corruption.md) | `GET /v1/operators/problems/:problemId/projections`, `POST /v1/operators/problems/:problemId/projections/repair`, `GET /v1/operators/problems/:problemId/search-index`, `POST /v1/operators/problems/:problemId/search-index/rebuild` | `ops:projection-rebuild`, `ops:event-verify` |
| 9 | Private-content cache leak | [`private-content-cache-leak.md`](private-content-cache-leak.md) | `POST /v1/operators/content-control`, `GET /v1/operators/audit-history` | `ops:cache-privacy-test` |
| 10 | Restore from backup | [`restore-from-backup.md`](restore-from-backup.md) | `GET /v1/operators/problems/:problemId/projections`, `POST /v1/operators/problems/:problemId/projections/repair` | `ops:backup-restore-smoke`, `ops:event-verify`, `ops:projection-rebuild`, `ops:artifact-inventory` |
| 11 | Signing-key compromise | [`signing-key-compromise.md`](signing-key-compromise.md) | `GET /v1/operators/audit-history` | `ops:event-verify` |
| 12 | Screening-provider outage | [`screening-provider-outage.md`](screening-provider-outage.md) | `GET /v1/operators/quarantine`, `POST /v1/operators/quarantine/decision`, `GET /v1/operators/screening-appeals`, `POST /v1/operators/screening-appeals/decision`, `POST /v1/operators/problems/:problemId/slow-mode` | `scripts/e2e-s4-screening-oauth.sh` |

## Supplementary Operational Runbooks

- [`artifact-publications.md`](artifact-publications.md) — CAS publication bindings and retry queue management.
- [`artifact-uploads.md`](artifact-uploads.md) — Resumable artifact upload authorization and recovery.
- [`nightly-ledger-backups.md`](nightly-ledger-backups.md) — Nightly snapshot specification, retention, and deletion-safe restore mechanics.
- [`scientific-retractions.md`](scientific-retractions.md) — Author scientific retractions vs operator moderation controls.
- [`s4-sealed-corpus.md`](s4-sealed-corpus.md) — Sealing and evaluating the Tier-B S-4 hard-reject corpus without committing harmful text to git.

## Standing Fable §14.3 Never-Log Exclusions (Binding on Every Runbook)

Every operator action, audit reason, ticket, and command output MUST exclude:

1. Enrollment secrets and `#v1.<secret>` join-URL fragments
2. Full Fellow bearer tokens (`asimp_ag_*`) and device codes (mask to `asimp_ag_ab…yz` or cite `cred:<ULID>`)
3. Google OAuth tokens, Auth.js session cookies, and service-envelope signing keys/signatures
4. Full sponsor directive bodies and private workshop draft bytes
5. Detected P7 secrets, personal contact/PII from doxxing reports, and raw `screening_cases.candidate_json` / Tier-B screening bodies
6. Raw classifier detector prompts or numeric score bands (quarantine notation uses coarse category + action only)

## Pre-Launch Local Rehearsal Protocol

Before declaring G2 Launch Readiness, execute the rehearsal checklist at the bottom of each of the 12 runbooks against local Workerd + local D1/R2 (and staging once `asimposiumorg-rs5n` reconciles deployment), verifying that every dry-run command is read-only and every mutating operator call writes an attributable `OA-*` row in `operator_audit`.
