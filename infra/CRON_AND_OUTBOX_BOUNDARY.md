# Cloudflare Cron Triggers vs. Durable Outbox Boundary (`infra/`)

**Owner:** OPS.6 (`asimposiumorg-zr9`) · **Source of Truth:** `COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md` (Rev 3.1)

## Hard Architectural Boundary: Outbox Consumers Are NEVER Polling Crons

Event-driven side effects MUST be processed by the **Krater Durable Object outbox**
(`apps/wire/src/krater/outbox-do.ts`, `apps/wire/src/krater/outbox-consumers.ts`), **NEVER**
by polling cron triggers:

- **OG share-image invalidation** (`og_invalidation`) → **outbox consumer only**, never a polling cron.
- **Synthesis staleness recomputation** (`synthesis_staleness`) → **outbox consumer only**, never a polling cron.
- **Public FTS5 indexing / embeddings** → **outbox consumer only**, never a polling cron.
- **Sponsor notifications & outbound webhooks** → **outbox consumer only**, never a polling cron.

Polling D1 on a cron for event-driven derivations wastes D1 row reads, introduces race windows,
and violates Fable Rule A6/A7 ("the log is the truth; cheap by construction").

## Canonical Scheduled Jobs (UTC Only)

Cloudflare Cron Triggers fire in **UTC** (immune to local DST shifts). Each scheduled job
orchestrates an existing W2.8 or W10.1 primitive — it **never** forks backup, restore,
inventory, or gauntlet logic:

| Job ID | Cron (UTC) | Allowed Environments | Delegated Primitive (Owner) | Catch-Up Policy | Report Retention |
|---|---|---|---|---|---|
| `nightly-backup` | `0 3 * * *` | `staging`, `production` | `runScheduledBackup` & `runDatabaseBackup` (W2.8 `apps/wire/src/krater/{backup-scheduler,database-backup}.ts`) | `coalesce-latest` | 90 days (matches R2 backups lifecycle) |
| `daily-artifact-inventory` | `30 4 * * *` | `staging`, `production` | `listArtifactUploads` & `scripts/ops-artifact-inventory.ts` (W2.8) | `coalesce-latest` | 180 days |
| `weekly-staging-gauntlet` | `0 6 * * 1` | `staging` **only** (refuses `production`) | `e2e/gauntlet/run.sh` (W10.1) + `scripts/ceremony-trend-check.ts` (R-22) | `skip-with-alert` | 180 days |
| `quarterly-restore-drill` | `0 5 1 1,4,7,10 *` | `staging` / isolated `scratch` target **only** (`validateScratchTarget` refuses prod) | `restoreProblemExport` & `restoreDatabaseBackup` (W2.8 `apps/wire/src/krater/restore.ts`) | `require-operator-rerun` | 365 days |

## Guardrails Enforced by `scripts/lib/ops-schedules.ts`

1. **Single-flight leasing:** R2 conditional-etag lease with owner UUID and bounded TTL; expired workers cannot overwrite a valid completed backup or release a newer worker's lease.
2. **Duplicate alarm suppression:** idempotency key `(job_id, scheduled_slot_utc)` deduplicates duplicate Cloudflare alarm/cron deliveries.
3. **Missed-run detection & OPS.4 alerting:** alerts carry strictly redacted metadata (verified via `containsNeverLogMaterial === false`) — zero tokens, raw SQL errors, or private workshop bodies.
4. **Audited operator reruns:** manual reruns require an explicit non-empty `--reason` and write to the SHA-256-chained `0600` ops audit log (`scripts/lib/ops-audit.ts`).
