#!/usr/bin/env bun
/**
 * `ops:backup-restore-smoke` — guarded restore-from-backup smoke verifier enforcing
 * the OPS.5 RESTORE-FROM-BACKUP RUNBOOK ADDITION (Fable §10.2 & §13.3):
 *
 * 1. Validates target identifier via `validateScratchTarget` (refuses prod/staging/live/main).
 * 2. Verifies export bundle chain integrity via `verifyProblemExportChain` BEFORE any action.
 * 3. Enforces quarantine-first ordering: requires a verifiable retention-control journal
 *    (`--retention-journal <json>`) covering post-snapshot deletions, private-draft removals,
 *    token revocations, cancelled enrollments/transfers, content controls, and CAS unbinds
 *    BEFORE the restored target may be marked serviceable. Missing or invalid journal is a
 *    hard STOP condition (`RETENTION_JOURNAL_REQUIRED` / `RETENTION_JOURNAL_INVALID`).
 * 4. Runs post-journal negative probes against the quarantined scratch SQLite target
 *    (when `--scratch-sqlite` supplied), distinguishing encrypted lifecycle-retained backup
 *    bytes from data/authority reachable in the restored service.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { verifyProblemExportChain } from "../apps/wire/src/krater/export.ts";
import { validateScratchTarget } from "../apps/wire/src/krater/restore.ts";
import { appendOpsAuditRecord } from "./lib/ops-audit.ts";

export interface RetentionJournalEntry {
  readonly id: string;
  readonly kind:
    | "account_deletion"
    | "private_draft_removal"
    | "token_revocation"
    | "sponsorship_transfer"
    | "content_control"
    | "cas_unbind";
  readonly target_id: string;
  readonly recorded_at: string;
  readonly legal_hold?: boolean;
  readonly shared_cas?: boolean;
}

export interface RetentionControlJournal {
  readonly schema: "asimposium.retention-control-journal.v1";
  readonly generated_at: string;
  readonly snapshot_cutoff_at: string;
  readonly entries: readonly RetentionJournalEntry[];
  readonly entries_sha256: string;
}

export interface BackupRestoreSmokeReport {
  readonly command: "ops:backup-restore-smoke";
  readonly mode: "dry-run";
  readonly checked_at: string;
  readonly target_identifier: string;
  readonly target_quarantine_state: "quarantined-stop" | "verified-ready-to-unquarantine";
  readonly export_chain_intact: boolean;
  readonly export_event_count: number;
  readonly retention_journal_verified: boolean;
  readonly retention_entries_count: number;
  readonly legal_hold_entries: number;
  readonly shared_cas_entries: number;
  readonly negative_probes_passed: boolean;
  readonly failures: readonly string[];
  readonly authority_vs_backup_distinction: string;
}

function canonicalEntriesDigest(entries: readonly RetentionJournalEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function verifyRetentionJournal(journalPath: string): {
  readonly ok: boolean;
  readonly journal: RetentionControlJournal | null;
  readonly error: string | null;
} {
  if (!existsSync(journalPath)) {
    return {
      ok: false,
      journal: null,
      error: `RETENTION_JOURNAL_REQUIRED: missing retention-control journal at ${journalPath}; target MUST stay quarantined`,
    };
  }
  let parsed: Partial<RetentionControlJournal>;
  try {
    parsed = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<RetentionControlJournal>;
  } catch {
    return {
      ok: false,
      journal: null,
      error: "RETENTION_JOURNAL_INVALID: malformed JSON; target MUST stay quarantined",
    };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.schema !== "asimposium.retention-control-journal.v1" ||
    !Array.isArray(parsed.entries) ||
    typeof parsed.entries_sha256 !== "string"
  ) {
    return {
      ok: false,
      journal: null,
      error: "RETENTION_JOURNAL_INVALID: malformed schema or missing entries_sha256",
    };
  }
  const computed = canonicalEntriesDigest(parsed.entries);
  if (computed !== parsed.entries_sha256.toLowerCase()) {
    return {
      ok: false,
      journal: null,
      error: `RETENTION_JOURNAL_TAMPERED: entries_sha256 mismatch (expected ${parsed.entries_sha256}, computed ${computed})`,
    };
  }
  return { ok: true, journal: parsed as RetentionControlJournal, error: null };
}

function runNegativeAuthorityProbes(
  sqlitePath: string,
  entries: readonly RetentionJournalEntry[],
): string[] {
  const failures: string[] = [];
  if (!existsSync(sqlitePath)) {
    return [`SCRATCH_SQLITE_NOT_FOUND: ${sqlitePath}`];
  }
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const entry of entries) {
      if (entry.kind === "token_revocation") {
        if (!tables.has("fellow_tokens")) {
          failures.push("MISSING_REQUIRED_AUTHORITY_TABLE: fellow_tokens");
          continue;
        }
        const active = db
          .prepare(
            "SELECT COUNT(*) AS n FROM fellow_tokens WHERE credential_id = ? AND revoked_at IS NULL",
          )
          .get(entry.target_id) as { n: number } | null;
        if ((active?.n ?? 0) > 0) {
          failures.push(`STALE_AUTHORITY_LEAK: revoked token ${entry.target_id} still active`);
        }
      } else if (entry.kind === "private_draft_removal") {
        if (entry.target_id.startsWith("P-")) {
          if (!tables.has("problems")) {
            failures.push("MISSING_REQUIRED_AUTHORITY_TABLE: problems");
            continue;
          }
          const liveProblemDraft = db
            .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = ? AND status = 'private-draft'")
            .get(entry.target_id) as { n: number } | null;
          if ((liveProblemDraft?.n ?? 0) > 0) {
            failures.push(
              `DELETED_PRIVATE_PROBLEM_RESURRECTED: private-draft problem ${entry.target_id} still live`,
            );
          }
          continue;
        }
        if (!tables.has("workshop_objects")) {
          failures.push("MISSING_REQUIRED_AUTHORITY_TABLE: workshop_objects");
          continue;
        }
        const live = db
          .prepare("SELECT COUNT(*) AS n FROM workshop_objects WHERE workshop_id = ?")
          .get(entry.target_id) as { n: number } | null;
        if ((live?.n ?? 0) > 0) {
          failures.push(`DELETED_DRAFT_RESURRECTED: workshop draft ${entry.target_id} still live`);
        }
      } else if (entry.kind === "account_deletion") {
        if (!tables.has("sponsors")) {
          failures.push("MISSING_REQUIRED_AUTHORITY_TABLE: sponsors");
          continue;
        }
        const live = db
          .prepare(
            "SELECT COUNT(*) AS n FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL",
          )
          .get(entry.target_id) as { n: number } | null;
        if ((live?.n ?? 0) > 0) {
          failures.push(`DELETED_ACCOUNT_RESURRECTED: sponsor ${entry.target_id} still active`);
        }
      } else if (entry.kind === "sponsorship_transfer") {
        if (!tables.has("sponsor_fellow_transfers")) {
          failures.push("MISSING_REQUIRED_AUTHORITY_TABLE: sponsor_fellow_transfers");
          continue;
        }
        const pending = db
          .prepare(
            "SELECT COUNT(*) AS n FROM sponsor_fellow_transfers WHERE transfer_id = ? AND status = 'pending'",
          )
          .get(entry.target_id) as { n: number } | null;
        if ((pending?.n ?? 0) > 0) {
          failures.push(
            `STALE_TRANSFER_PENDING_AFTER_RESTORE: transfer ${entry.target_id} still pending`,
          );
        }
      } else if (entry.kind === "content_control") {
        if (!tables.has("content_controls")) {
          failures.push("MISSING_REQUIRED_AUTHORITY_TABLE: content_controls");
          continue;
        }
        const present = db
          .prepare("SELECT COUNT(*) AS n FROM content_controls WHERE control_id = ?")
          .get(entry.target_id) as { n: number } | null;
        if ((present?.n ?? 0) === 0) {
          failures.push(
            `CONTENT_CONTROL_MISSING_AFTER_RESTORE: control ${entry.target_id} not replayed`,
          );
        }
      } else if (entry.kind === "cas_unbind" && entry.shared_cas !== true) {
        if (!tables.has("artifact_uploads")) {
          failures.push("MISSING_REQUIRED_AUTHORITY_TABLE: artifact_uploads");
          continue;
        }
        const live = db
          .prepare(
            "SELECT COUNT(*) AS n FROM artifact_uploads WHERE upload_id = ? AND state <> 'expired'",
          )
          .get(entry.target_id) as { n: number } | null;
        if ((live?.n ?? 0) > 0) {
          failures.push(`UNBOUND_PRIVATE_CAS_STILL_LIVE: upload ${entry.target_id} still active`);
        }
      }
    }
  } finally {
    db.close();
  }
  return failures;
}

export async function runBackupRestoreSmoke(opts: {
  readonly targetIdentifier: string;
  readonly exportNdjsonPath: string;
  readonly retentionJournalPath: string | null;
  readonly scratchSqlitePath?: string | null;
  readonly auditLogPath?: string | null;
}): Promise<BackupRestoreSmokeReport> {
  // Step 1: Fail closed on any production/staging/live target.
  validateScratchTarget(opts.targetIdentifier);

  const failures: string[] = [];

  // Step 2: Verify export integrity chain BEFORE trusting any bytes.
  if (!existsSync(opts.exportNdjsonPath)) {
    throw new Error(`EXPORT_FILE_NOT_FOUND: ${opts.exportNdjsonPath}`);
  }
  const ndjson = readFileSync(opts.exportNdjsonPath, "utf8");
  const chainCheck = await verifyProblemExportChain(ndjson);
  const exportIntact = chainCheck.intact;
  const exportEventCount = chainCheck.intact ? chainCheck.eventCount : 0;
  if (!exportIntact) {
    failures.push(`EXPORT_CHAIN_INVALID: ${chainCheck.detail}`);
  }

  // Step 3: Enforce mandatory verifiable retention-control journal before unquarantining.
  let journalVerified = false;
  let journal: RetentionControlJournal | null = null;
  if (!opts.retentionJournalPath) {
    failures.push(
      "RETENTION_JOURNAL_REQUIRED: no --retention-journal supplied; restored target MUST stay quarantined",
    );
  } else {
    const check = verifyRetentionJournal(opts.retentionJournalPath);
    journalVerified = check.ok;
    journal = check.journal;
    if (!check.ok && check.error) {
      failures.push(check.error);
    }
  }

  // Step 4: Run negative probes on quarantined scratch SQLite if supplied.
  let negativeProbesPassed = true;
  if (opts.scratchSqlitePath && journalVerified && journal) {
    const probeFailures = runNegativeAuthorityProbes(opts.scratchSqlitePath, journal.entries);
    if (probeFailures.length > 0) {
      negativeProbesPassed = false;
      failures.push(...probeFailures);
    }
  }

  const ready = exportIntact && journalVerified && negativeProbesPassed && failures.length === 0;
  const entries = journal?.entries ?? [];
  const report: BackupRestoreSmokeReport = {
    command: "ops:backup-restore-smoke",
    mode: "dry-run",
    checked_at: new Date().toISOString(),
    target_identifier: opts.targetIdentifier,
    target_quarantine_state: ready ? "verified-ready-to-unquarantine" : "quarantined-stop",
    export_chain_intact: exportIntact,
    export_event_count: exportEventCount,
    retention_journal_verified: journalVerified,
    retention_entries_count: entries.length,
    legal_hold_entries: entries.filter((e) => e.legal_hold === true).length,
    shared_cas_entries: entries.filter((e) => e.shared_cas === true).length,
    negative_probes_passed: negativeProbesPassed,
    failures,
    authority_vs_backup_distinction:
      "Historical encrypted snapshot archives may still retain pre-deletion bytes until 90-day lifecycle expiry; this gate verifies that NO deleted account, private draft, revoked token, or hidden record is reachable as live authority in the restored target.",
  };

  if (opts.auditLogPath) {
    appendOpsAuditRecord(opts.auditLogPath, {
      command: "ops:backup-restore-smoke",
      mode: "dry-run",
      status: ready ? "pass" : "fail",
      summary: {
        target_identifier: opts.targetIdentifier,
        target_quarantine_state: report.target_quarantine_state,
        export_chain_intact: report.export_chain_intact,
        retention_journal_verified: report.retention_journal_verified,
        negative_probes_passed: report.negative_probes_passed,
        failure_count: failures.length,
      },
    });
  }

  return report;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let targetIdentifier = "";
  let exportNdjsonPath = "";
  let retentionJournalPath: string | null = null;
  let scratchSqlitePath: string | null = null;
  let auditLogPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") targetIdentifier = argv[++i] ?? "";
    else if (arg === "--export") exportNdjsonPath = argv[++i] ?? "";
    else if (arg === "--retention-journal") retentionJournalPath = argv[++i] ?? null;
    else if (arg === "--scratch-sqlite") scratchSqlitePath = argv[++i] ?? null;
    else if (arg === "--audit-log") auditLogPath = argv[++i] ?? null;
    else if (arg === "--dry-run" || arg === "--json") continue;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        JSON.stringify({
          usage:
            "bun scripts/ops-backup-restore-smoke.ts --target scratch-drill-1 --export <ndjson> --retention-journal <json> [--scratch-sqlite <sqlite>] [--audit-log <path>]",
          mode: "read-only dry-run (quarantine-first)",
        }),
      );
      process.exit(0);
    } else {
      console.error(`ERROR: unknown argument '${arg}'`);
      process.exit(2);
    }
  }

  if (!targetIdentifier || !exportNdjsonPath) {
    console.error("ERROR: --target and --export are required.");
    process.exit(2);
  }

  runBackupRestoreSmoke({
    targetIdentifier,
    exportNdjsonPath,
    retentionJournalPath,
    scratchSqlitePath,
    auditLogPath,
  })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.target_quarantine_state === "verified-ready-to-unquarantine" ? 0 : 1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    });
}
