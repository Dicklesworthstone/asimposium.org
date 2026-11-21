# OPS.5 Pre-Launch Local Rehearsal Log — 2026-11-21

**Bead:** `asimposiumorg-vpx` (OPS.5 Runbook index, audit-logged ops commands, never-log redaction layer)  
**Evidence Scope:** Local SQLite / loopback HTTP / fixture rehearsal ONLY. Hosted staging and production rehearsals remain pending deployment authority (`asimposiumorg-rs5n`) and are NOT claimed here.

## Dry-Run & Fault-Injection `ops:*` Command Verification

All commands executed read-only (`--dry-run`) by default, wrote SHA-256-chained `0600` NDJSON audit logs verified by `verifyOpsAuditLog`, enforced `--reason` + `--step-up-confirm` on mutating `--apply`, and passed zero-leak redaction checks against the 8 Fable §14.3 never-log categories (`scripts/ops-vpx.test.ts`):

| Command | Script | Dry-Run Verified | Planted-Fault Control Verified | Audit-Logged & Never-Log Checked |
|---|---|---|---|---|
| `ops:event-verify` | `scripts/ops-event-verify.ts` | PASS (canonical v2 chain + checkpoint recomputation) | PASS (tampered `chain_digest` fails closed) | PASS |
| `ops:projection-rebuild` | `scripts/ops-projection-rebuild.ts` | PASS (`doctorProjections` drift & `rebuildSet`) | PASS (corrupted `build_digest` detected; `--apply` refuses missing reason, secret-in-reason, and bad step-up; authorized `--apply` heals to `sound: true`) | PASS |
| `ops:outbox-reconcile` | `scripts/ops-outbox-reconcile.ts` | PASS (read-only snapshot & alert threshold) | — (covered in outbox-do unit/integration suites) | PASS |
| `ops:artifact-inventory` | `scripts/ops-artifact-inventory.ts` | PASS (clean D1 vs local R2 mirror) | PASS (missing R2 object + orphaned R2 object flagged) | PASS |
| `ops:cache-privacy-test` | `scripts/ops-cache-privacy-test.ts` | PASS (anon-before 404, owner 200 `private, no-store`, other-sponsor 404, anon-after 404) | PASS (public cache-leak canary caught) | PASS |
| `ops:backup-restore-smoke` | `scripts/ops-backup-restore-smoke.ts` | PASS (scratch target, intact v3 export chain, SHA-256 verified retention-control journal, negative probes pass) | PASS (`production-d1` refused; missing retention journal holds `quarantined-stop`; resurrected revoked credential fails negative probe) | PASS |

## 12 Named Fable §13.3 Incident Runbooks — Local Rehearsal Status

| # | Incident | Runbook | Local Rehearsal Date | P7 Secret Scan | Hosted Staging / Prod Rehearsal |
|---|---|---|---|---|---|
| 1 | Credential compromise | `credential-compromise.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 2 | Sponsor account takeover | `sponsor-account-takeover.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 3 | Leaked join URL | `leaked-join-url.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 4 | Doxxing / credible threat | `doxxing-credible-threat.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 5 | Malicious artifact | `malicious-artifact.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 6 | False famous-problem solution goes viral (R-21) | `viral-false-famous-problem-solution.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 7 | Outbox backlog | `outbox-backlog.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 8 | Projection corruption | `projection-corruption.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 9 | Private-content cache leak | `private-content-cache-leak.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 10 | Restore from backup (quarantine + retention journal) | `restore-from-backup.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 11 | Signing-key compromise | `signing-key-compromise.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |
| 12 | Screening-provider outage | `screening-provider-outage.md` | 2026-11-21 (local dry-run) | 0 findings | Pending `rs5n` |

## Restore-From-Backup Quarantine Ordering Note

`scripts/ops-backup-restore-smoke.ts` enforces the OPS.5 restore ordering gate:
- Any non-scratch target (`prod`, `production`, `staging`, `live`, `primary`, `main`) is refused by `validateScratchTarget`.
- Export integrity is verified via `verifyProblemExportChain` prior to any restore decision.
- A verifiable retention-control journal (`asimposium.retention-control-journal.v1` with matching `entries_sha256`) covering account deletions, private-draft removals, token revocations, cancelled transfers, content controls, and CAS unbinds is mandatory; missing or unverifiable controls hold the target in `quarantined-stop`.
- Legal-hold and shared-CAS entries are tallied explicitly, and the report separates encrypted pre-deletion backup bytes awaiting 90-day lifecycle expiry from live authority reachable in the restored service.
