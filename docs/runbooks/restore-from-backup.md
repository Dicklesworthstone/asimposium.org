# Runbook: Restore from Backup

**Scope (Fable §13.3, §10.2, Rule A6):** Disaster recovery or point-in-time restoration of D1 ledger state and R2 event/artifact archives from nightly immutable backups after accidental data loss, unrepairable projection corruption, or storage failure.

## Authoritative Detailed Backup & Restore Specification

The complete nightly snapshot format, retention policy, deletion-safe restore mechanics, and verification proofs live in [`nightly-ledger-backups.md`](nightly-ledger-backups.md). This incident runbook is the operator's fast-path recovery checklist for live incidents.

## Core Invariant (Rule A6 / Deletion-Safe Restore)

The append-only event log is the source of truth. **Never** restore deleted user PII or revoked credentials back to active state without re-applying `deletion_journal` (migration `0080_deletion_journal.sql`) and current credential revocations.

## Never-Log & Evidence Hygiene (Fable §14.3)

Never dump raw D1 SQLite exports, `enrollment_credentials` hashes, `screening_cases.candidate_json`, or private workshop rows into shared logs. Verify digests and row counts only.

## Recovery Procedure

1. **Stop the bleeding and preserve forensic state:**
   - Pause background writers / cron drains if corruption is actively spreading.
   - Snapshot the current damaged D1 database before overwriting anything so root cause can be audited later.
2. **Select and cryptographically verify the target backup (`ops:backup-restore-smoke`):**
   - Identify the latest verified nightly backup bundle from the immutable backup bucket (see [`nightly-ledger-backups.md`](nightly-ledger-backups.md)).
   - Run `ops:backup-restore-smoke` into a **scratch D1/SQLite target first** (never directly into production!).
   - Run `ops:event-verify` over the restored scratch database to prove every problem's Krater hash chain (`events.chain_digest`, `payload_sha256`, checkpoints) verifies cleanly.
3. **Re-apply deletion journal, lawful redactions, and revocations:**
   - Re-apply any `deletion_journal` entries, lawful `event_content` redactions, `content_controls`, and sponsor/Fellow revocations that landed after the backup cutoff so deleted accounts or revoked tokens never resurrect.
4. **Rebuild projections and FTS5 deterministically from the verified log:**
   - Run `GET /v1/operators/problems/:problemId/projections` (dry-run) and `POST /v1/operators/problems/:problemId/projections/repair` (see [`projection-corruption.md`](projection-corruption.md)) plus `POST /v1/operators/problems/:problemId/search-index/rebuild`.
   - Reconcile R2 CAS objects with `ops:artifact-inventory`.
5. **Cut over and verify:**
   - Promote the verified database under reviewed operator change control.
   - Verify `/internal/health`, `/capabilities`, `/cursor`, and `/stats.json` return healthy responses and `GET /v1/operators/audit-history` records the recovery action.

## Dry-Run & Ops Commands

- `ops:backup-restore-smoke` — restore backup into scratch target and verify integrity (non-destructive).
- `ops:event-verify` — verify every problem's Krater hash chain and payload digests.
- `ops:projection-rebuild` — dry-run and repair derived projection tables from the log.
- `ops:artifact-inventory` — reconcile D1 artifact references against R2 CAS objects.

## Local Workerd/D1 Rehearsal Checklist

1. Seed a local Workerd/D1 problem with claims, reviews, and a lawful content control, then export `/p/:id/export.jsonl.gz`.
2. Verify the exported archive offline via `asimp pull <problem> --verify-file <export.jsonl.gz>`.
3. Replay into a clean local D1 database, run `GET /v1/operators/problems/:problemId/projections`, and confirm `status: "consistent"` with zero drift items.
