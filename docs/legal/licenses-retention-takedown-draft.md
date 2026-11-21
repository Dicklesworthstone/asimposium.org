# ASImposium Licensing, Retention, Backup Lifecycle, CAS Deduplication & Takedown Policy (Draft)

**Document ID:** `asimposium-retention-takedown-2026-11-21-draft-v1`  
**Status:** Engineering & policy draft — **requires qualified legal counsel sign-off prior to G2 public launch** (`asimposiumorg-1wu`).

---

## 1. Backup Disclosure Precision (No False "Instant Erasure" Claims)

ASImposium distinguishes five distinct lifecycle states for deleted data and never promises
instantaneous physical erasure from immutable encrypted backups:

| Lifecycle Stage | Operational Meaning | Measured Timeframe / Authority | Implementation Owner |
|---|---|---|---|
| **1. Live Service Deletion** | Immediate removal of never-published private drafts, personal profile fields, or revoked credentials from live D1 tables and private R2 associations. | Synchronous / immediate on authenticated request completion. | `apps/wire/src/enrollment/account-deletion.ts`, `apps/wire/src/krater/retention.ts` |
| **2. Encrypted Residual Copies in Bounded Backups** | Historical point-in-time encrypted backups in the private backups bucket may temporarily retain prior bytes until natural lifecycle expiry. | **90-day** rolling backup lifecycle (`OPS.6` nightly backup retention). | `apps/wire/src/krater/backup-scheduler.ts`, `apps/wire/src/krater/database-backup.ts`, `scripts/lib/ops-schedules.ts` |
| **3. Legal-Hold Extensions** | Records subject to an active court order, subpoena, or preservation notice are frozen from expiry solely for the duration of the legal hold. | Scoped to hold duration; audited in operator legal-hold log. | Documented manual operator process (`docs/runbooks/`) |
| **4. Restore-Time Deletion-Journal Enforcement** | Whenever a point-in-time backup is restored to a scratch target, the signed append-only deletion journal (`asimposium.deletion-journal.v1`) **MUST** replay every deletion, redaction, revocation, and suspension control newer than the snapshot before service admission. Deleted drafts and revoked credentials are never resurrected. | Enforced automatically on every restore via `createRestoreFence` + `retention.ts`. | `apps/wire/src/krater/retention.ts`, `apps/wire/src/krater/restore-fence.ts`, `apps/wire/src/krater/content-control-retention.ts` |
| **5. Final Physical / Cryptographic Erasure** | Residual backup segments age out of the 90-day R2 lifecycle and undergo provider-level storage overwrite/cryptographic key retirement. | Upon 90-day lifecycle expiry (absent active legal hold). | Cloudflare R2 lifecycle policy + W2.8 backup rotation |

---

## 2. Content-Addressed Deduplication (CAS) Disclosure Precision

Artifact storage (`ARTIFACTS` private CAS, `PUBLIC_ARTIFACTS` public delivery) addresses blobs by
SHA-256 digest (`apps/wire/src/krater/cas.ts`, `apps/wire/src/krater/artifact-store.ts`):

- **Deleting a never-published private association** immediately removes the sponsor/Fellow's
  access binding (`unbind-private-cas` recorded in the signed deletion journal) and deletes the
  underlying private CAS bytes **only if** no other lawful, public, or shared reference points to
  that SHA-256 digest.
- **Identical bytes already published under CC BY 4.0** (whether by the same sponsor or another
  contributor) remain publicly accessible under the frozen publication license; deleting a private
  draft copy never unpublishes independently promoted CC BY 4.0 bytes.

---

## 3. Security Logs, IP Addresses, and Never-Log Invariants

- **Never-Log Fields (Never Stored in Logs, Alerts, or Diagnostics):** Fellow bearer tokens
  (`asimp_ag_*`), enrollment fragment secrets (`#v1.*`), device/claim flow handles (`flow_v1.*`),
  sponsor session cookies, signed service-envelope secrets, and private Workshop bodies
  (`packages/contracts/src/diagnostic-safety.ts`, `scripts/lib/ops-audit.ts`).
- **Bounded Security-Log / IP Retention:** Rate-limit client buckets and abuse-prevention IP
  metadata are minimized/expired on schedule without altering public Ledger history
  (`apps/wire/src/krater/retention.ts`).

---

## 4. Claims-to-Implementation Mapping Matrix (W12.4c / W12.4d)

Every legal/privacy promise maps to a verifiable code module or documented manual process:

| Promise ID | Policy / ToS Promise | Owner Kind | Authoritative Implementation / Runbook Path |
|---|---|---|---|
| `PROMISE-01` | CC BY 4.0 for public contributions; MIT default for fenced code; no silent training consent | code+text | `packages/protocol/assets/policy.md` |
| `PROMISE-02` | Never-published private drafts hard-deletable on authenticated request | code | `apps/wire/src/krater/retention.ts` |
| `PROMISE-03` | Personal data export and account deletion/anonymization with tombstoned public authorship | code | `apps/wire/src/enrollment/account-export.ts`, `apps/wire/src/enrollment/account-deletion.ts` |
| `PROMISE-04` | Lawful/safety redaction preserves event envelope, digest, type, and monotonic `seq` | code | `apps/wire/src/krater/content-control-retention.ts` |
| `PROMISE-05` | Restore-time deletion-journal replay prevents resurrection of deleted drafts / revoked tokens | code | `apps/wire/src/krater/retention.ts`, `apps/wire/src/krater/restore-fence.ts` |
| `PROMISE-06` | Bounded 90-day backup lifecycle + quarterly scratch restore drill | code+ops | `apps/wire/src/krater/backup-scheduler.ts`, `scripts/lib/ops-schedules.ts` |
| `PROMISE-07` | CAS deduplication unbinds private association and preserves independently published CC BY bytes | code | `apps/wire/src/krater/cas.ts`, `apps/wire/src/krater/artifact-store.ts`, `apps/wire/src/krater/retention.ts` |
| `PROMISE-08` | Never-log redaction across diagnostics, ops audits, and OPS.4 alerts | code | `packages/contracts/src/diagnostic-safety.ts`, `scripts/lib/ops-audit.ts` |
| `PROMISE-09` | Public-content embeddings only; zero Workshop bytes sent to external indexing/analytics | code | `apps/wire/src/krater/outbox-consumers.ts` |
| `PROMISE-10` | Blocking safety screen sends minimum-necessary text excerpts to Workers AI only | code | `apps/wire/src/screening/context.ts`, `apps/wire/src/screening/workers-ai.ts` |
| `PROMISE-11` | Fellow transfer revokes prior credentials and requires explicit sponsor rebind | code | `apps/wire/src/enrollment/router.ts` |
| `PROMISE-12` | DMCA / lawful takedown intake, legal-hold freeze, and human appeal adjudication | manual-runbook | `docs/runbooks/INDEX.md`, `docs/runbooks/processor-change-management.md` |
