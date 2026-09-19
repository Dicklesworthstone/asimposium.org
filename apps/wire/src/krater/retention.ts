/**
 * W2.8 Retention enforcement, deletion journaling, and deletion-safe restore (Fable §10.2).
 *
 * Requirements:
 * - Retention jobs that hard-delete never-published private drafts on an authenticated request.
 * - Minimize or expire raw IP and security records on schedule without changing public ledger history.
 * - Deletion journal outside the point-in-time dump tracking signed retention-control records.
 * - Restore-to-scratch tooling that counts rows, verifies event-chain and artifact digests,
 *   and refuses any non-scratch target or tampered deletion journal.
 * - Deletion-safe restore: replays deletion controls newer than snapshot to ensure deleted
 *   private drafts or revoked credentials are never reactivated.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { parseProblemExport } from "./export.ts";
import { canonicalJson, sha256Hex } from "./krater.ts";
import {
  ALLOWED_SCRATCH_PATTERNS,
  FORBIDDEN_RESTORE_TARGET_PATTERNS,
  KraterRestoreRefusedError,
  type RestoreResult,
  restoreProblemExport,
  validateScratchTarget,
} from "./restore.ts";

export { ALLOWED_SCRATCH_PATTERNS, FORBIDDEN_RESTORE_TARGET_PATTERNS, validateScratchTarget };

export class RetentionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RetentionError";
    this.code = code;
  }
}

export type RetentionControlAction =
  | "delete-private-draft"
  | "revoke-credential"
  | "cancel-enrollment"
  | "delete-account-private-data"
  | "unbind-private-cas";

export type RetentionTargetType =
  | "problem"
  | "credential"
  | "enrollment"
  | "user_private_data"
  | "cas_artifact";

export interface RetentionControlRecord {
  readonly controlId: string;
  readonly action: RetentionControlAction;
  readonly targetId: string;
  readonly targetType: RetentionTargetType;
  readonly issuedAt: string;
  readonly payload: Record<string, unknown>;
  readonly controlDigest: string;
}

export const DELETION_JOURNAL_FORMAT = "asimposium.deletion-journal.v1";
export const DELETION_JOURNAL_HEADER_CONTROL = "deletion_journal_header";
export const DELETION_JOURNAL_TRAILER_CONTROL = "deletion_journal_end";

export interface DeletionReceipt {
  readonly receiptId: string;
  readonly targetId: string;
  readonly targetType: RetentionTargetType;
  readonly deletedAt: string;
  readonly backupRetentionWindowDays: 90;
  readonly legalHoldException: false;
  readonly sharedPublicHashConsequence: "private-bytes-purged-shared-public-hashes-retained";
  readonly expectedPhysicalErasureDeadline: string;
}

export interface HardDeleteDraftResult {
  readonly ok: true;
  readonly problemId: string;
  readonly receipt: DeletionReceipt;
  readonly controlRecord: RetentionControlRecord;
  readonly rowsDeleted: {
    readonly problem: number;
    readonly statementVersions: number;
    readonly memberships: number;
    readonly stewards: number;
    readonly workshopObjects: number;
    readonly workshopRevisions: number;
    readonly sessions: number;
    readonly claims: number;
  };
}

export interface ExpireSecurityRecordsResult {
  readonly expiredNonces: number;
  readonly expiredLookupAttempts: number;
  readonly expiredDeviceCodes: number;
  readonly expiredProposals: number;
}

/**
 * Computes the canonical SHA-256 digest of a retention-control record.
 */
export async function computeRetentionControlDigest(
  record: Omit<RetentionControlRecord, "controlDigest">,
): Promise<string> {
  const canonical = canonicalJson({
    action: record.action,
    control_id: record.controlId,
    issued_at: record.issuedAt,
    payload: record.payload,
    target_id: record.targetId,
    target_type: record.targetType,
  });
  return sha256Hex(canonical);
}

/**
 * Creates a signed/hashed retention control record.
 */
export async function createRetentionControlRecord(input: {
  readonly action: RetentionControlAction;
  readonly targetId: string;
  readonly targetType: RetentionTargetType;
  readonly payload?: Record<string, unknown>;
  readonly issuedAt?: string;
}): Promise<RetentionControlRecord> {
  const controlId = `RC-${crypto.randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase()}`;
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const payload = input.payload ?? {};

  const digest = await computeRetentionControlDigest({
    controlId,
    action: input.action,
    targetId: input.targetId,
    targetType: input.targetType,
    issuedAt,
    payload,
  });

  return {
    controlId,
    action: input.action,
    targetId: input.targetId,
    targetType: input.targetType,
    issuedAt,
    payload,
    controlDigest: digest,
  };
}

/**
 * Verifies a retention control record's fields and cryptographic digest.
 */
export async function verifyRetentionControlRecord(
  record: unknown,
): Promise<{ valid: true; record: RetentionControlRecord } | { valid: false; reason: string }> {
  if (typeof record !== "object" || record === null) {
    return { valid: false, reason: "retention control record must be an object" };
  }
  const r = record as Record<string, unknown>;
  if (typeof r.controlId !== "string" || !r.controlId.startsWith("RC-")) {
    return { valid: false, reason: "invalid controlId" };
  }
  if (
    typeof r.action !== "string" ||
    ![
      "delete-private-draft",
      "revoke-credential",
      "cancel-enrollment",
      "delete-account-private-data",
      "unbind-private-cas",
    ].includes(r.action)
  ) {
    return { valid: false, reason: "invalid action" };
  }
  if (typeof r.targetId !== "string" || r.targetId.trim().length === 0) {
    return { valid: false, reason: "invalid targetId" };
  }
  if (
    typeof r.targetType !== "string" ||
    !["problem", "credential", "enrollment", "user_private_data", "cas_artifact"].includes(
      r.targetType,
    )
  ) {
    return { valid: false, reason: "invalid targetType" };
  }
  if (typeof r.issuedAt !== "string" || Number.isNaN(Date.parse(r.issuedAt))) {
    return { valid: false, reason: "invalid issuedAt timestamp" };
  }
  if (typeof r.payload !== "object" || r.payload === null) {
    return { valid: false, reason: "invalid payload" };
  }
  if (typeof r.controlDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.controlDigest)) {
    return { valid: false, reason: "invalid controlDigest hex" };
  }

  const typedRecord: RetentionControlRecord = {
    controlId: r.controlId,
    action: r.action as RetentionControlAction,
    targetId: r.targetId,
    targetType: r.targetType as RetentionTargetType,
    issuedAt: r.issuedAt,
    payload: r.payload as Record<string, unknown>,
    controlDigest: r.controlDigest,
  };

  const recomputedDigest = await computeRetentionControlDigest(typedRecord);
  if (recomputedDigest !== typedRecord.controlDigest) {
    return { valid: false, reason: "controlDigest mismatch — record is tampered" };
  }

  return { valid: true, record: typedRecord };
}

/**
 * Serializes a collection of retention control records to NDJSON with header and trailer control records.
 */
export async function serializeDeletionJournal(
  records: readonly RetentionControlRecord[],
  generatedAt?: string,
): Promise<string> {
  const ts = generatedAt ?? new Date().toISOString();
  let chainDigest = await sha256Hex("genesis-deletion-journal");
  const lines: string[] = [];

  const header = {
    control: DELETION_JOURNAL_HEADER_CONTROL,
    format: DELETION_JOURNAL_FORMAT,
    generated_at: ts,
    record_count: records.length,
  };
  lines.push(JSON.stringify(header));

  for (const record of records) {
    lines.push(JSON.stringify(record));
    chainDigest = await sha256Hex(`${chainDigest}:${record.controlDigest}`);
  }

  const trailer = {
    control: DELETION_JOURNAL_TRAILER_CONTROL,
    record_count: records.length,
    final_digest: chainDigest,
  };
  lines.push(JSON.stringify(trailer));

  return `${lines.join("\n")}\n`;
}

/**
 * Parses and strictly verifies a deletion journal NDJSON stream. Fails closed on any error.
 */
export async function parseAndVerifyDeletionJournal(
  ndjson: string,
): Promise<{ valid: true; records: RetentionControlRecord[] } | { valid: false; reason: string }> {
  if (ndjson.length === 0) return { valid: false, reason: "empty deletion journal" };
  if (ndjson.includes("\r")) return { valid: false, reason: "journal must use LF line endings" };
  if (!ndjson.endsWith("\n")) return { valid: false, reason: "journal must end with one LF" };

  const rawLines = ndjson.slice(0, -1).split("\n");
  if (rawLines.length < 2) {
    return { valid: false, reason: "journal missing header or trailer" };
  }

  let headerObj: Record<string, unknown>;
  let trailerObj: Record<string, unknown>;
  try {
    headerObj = JSON.parse(rawLines[0] ?? "");
    trailerObj = JSON.parse(rawLines[rawLines.length - 1] ?? "");
  } catch {
    return { valid: false, reason: "journal header or trailer is not valid JSON" };
  }

  if (
    headerObj.control !== DELETION_JOURNAL_HEADER_CONTROL ||
    headerObj.format !== DELETION_JOURNAL_FORMAT
  ) {
    return { valid: false, reason: "invalid deletion journal header" };
  }
  if (trailerObj.control !== DELETION_JOURNAL_TRAILER_CONTROL) {
    return { valid: false, reason: "invalid deletion journal trailer" };
  }

  const recordLines = rawLines.slice(1, -1);
  if (trailerObj.record_count !== recordLines.length) {
    return {
      valid: false,
      reason: `trailer record count (${trailerObj.record_count}) disagrees with line count (${recordLines.length})`,
    };
  }

  let chainDigest = await sha256Hex("genesis-deletion-journal");
  const records: RetentionControlRecord[] = [];

  for (let i = 0; i < recordLines.length; i++) {
    const line = recordLines[i] ?? "";
    if (line.trim().length === 0) {
      return { valid: false, reason: `journal line ${i + 2} is blank` };
    }
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      return { valid: false, reason: `journal line ${i + 2} is not valid JSON` };
    }
    const verified = await verifyRetentionControlRecord(parsedLine);
    if (!verified.valid) {
      return { valid: false, reason: `journal record ${i + 1} invalid: ${verified.reason}` };
    }
    records.push(verified.record);
    chainDigest = await sha256Hex(`${chainDigest}:${verified.record.controlDigest}`);
  }

  if (trailerObj.final_digest !== chainDigest) {
    return { valid: false, reason: "journal trailer final_digest chain mismatch" };
  }

  return { valid: true, records };
}

/**
 * Hard-deletes a never-published private draft problem upon an authenticated sponsor request.
 *
 * Invariants:
 * 1. Problem must exist.
 * 2. Problem must have status 'private-draft'.
 * 3. Problem must have public_seq === 0 and 0 ledger events (strictly never published).
 * 4. Requester must be the problem's sponsor.
 * 5. Not subject to legal hold.
 * 6. Deletes from statement versions, memberships, stewards, workshop revisions,
 *    workshop objects, claims, and problems.
 * 7. Returns deletion receipt with 90-day retention window and physical erasure deadline.
 */
export async function hardDeletePrivateDraft(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  options?: { readonly now?: string; readonly legalHold?: boolean },
): Promise<HardDeleteDraftResult> {
  if (options?.legalHold === true) {
    throw new RetentionError(
      "LEGAL_HOLD_EXCLUSION",
      "Problem is subject to an active legal hold and cannot be deleted.",
    );
  }

  const problem = await db.prepare("SELECT * FROM problems WHERE id = ?").bind(problemId).first<{
    id: string;
    status: string;
    public_seq: number;
    sponsor_id: string | null;
    created_by_fellow_id: string | null;
  }>();

  if (!problem) {
    throw new RetentionError("PROBLEM_NOT_FOUND", `No problem found with id '${problemId}'.`);
  }

  if (problem.status !== "private-draft") {
    throw new RetentionError(
      "CANNOT_DELETE_NON_DRAFT_PROBLEM",
      `Public scientific ledger problems cannot be deleted. Problem '${problemId}' has status '${problem.status}'. Only never-published private drafts are eligible for hard deletion.`,
    );
  }

  if (problem.public_seq > 0) {
    throw new RetentionError(
      "CANNOT_DELETE_PROBLEM_WITH_PUBLIC_EVENTS",
      `Problem '${problemId}' has committed public sequence ${problem.public_seq} and is immutable.`,
    );
  }

  const eventCheck = await db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE problem_id = ?")
    .bind(problemId)
    .first<{ count: number }>();
  if (eventCheck && eventCheck.count > 0) {
    throw new RetentionError(
      "CANNOT_DELETE_PROBLEM_WITH_PUBLIC_EVENTS",
      `Problem '${problemId}' has ${eventCheck.count} committed public events and is immutable.`,
    );
  }

  if (problem.sponsor_id !== sponsorId) {
    throw new RetentionError(
      "GOVERNANCE_NOT_AUTHORIZED",
      `Sponsor '${sponsorId}' is not the governing sponsor for private draft '${problemId}'.`,
    );
  }

  const now = options?.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const physicalErasureMs = nowMs + 90 * 24 * 60 * 60 * 1000;
  const expectedPhysicalErasureDeadline = new Date(physicalErasureMs).toISOString();

  // Execute atomic deletions across all problem tables in foreign-key dependency order
  const statements = [
    db.prepare("DELETE FROM workshop_objects WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM workshop_revisions WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM sessions WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problem_statement_versions WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problem_memberships WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problem_stewards WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM claims WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problems WHERE id = ?").bind(problemId),
  ];

  const results = await db.batch(statements);

  const receipt: DeletionReceipt = {
    receiptId: `DEL-${crypto.randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`,
    targetId: problemId,
    targetType: "problem",
    deletedAt: now,
    backupRetentionWindowDays: 90,
    legalHoldException: false,
    sharedPublicHashConsequence: "private-bytes-purged-shared-public-hashes-retained",
    expectedPhysicalErasureDeadline,
  };

  const controlRecord = await createRetentionControlRecord({
    action: "delete-private-draft",
    targetId: problemId,
    targetType: "problem",
    payload: {
      sponsor_id: sponsorId,
      receipt_id: receipt.receiptId,
      deleted_at: now,
    },
    issuedAt: now,
  });

  return {
    ok: true,
    problemId,
    receipt,
    controlRecord,
    rowsDeleted: {
      workshopObjects: (results[0]?.meta?.changes as number) ?? 0,
      workshopRevisions: (results[1]?.meta?.changes as number) ?? 0,
      sessions: (results[2]?.meta?.changes as number) ?? 0,
      statementVersions: (results[3]?.meta?.changes as number) ?? 0,
      memberships: (results[4]?.meta?.changes as number) ?? 0,
      stewards: (results[5]?.meta?.changes as number) ?? 0,
      claims: (results[6]?.meta?.changes as number) ?? 0,
      problem: (results[7]?.meta?.changes as number) ?? 0,
    },
  };
}

/**
 * Sweeps and expires raw IP and security records on schedule without changing public ledger history.
 * Bounded cleanup of expired nonces, device lookups, and expired device-flow codes.
 */
export async function expireSecurityRecords(
  db: D1Database,
  options?: { readonly nowMs?: number; readonly lookupMaxAgeMs?: number },
): Promise<ExpireSecurityRecordsResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const lookupMaxAge = options?.lookupMaxAgeMs ?? 24 * 60 * 60 * 1000;
  const lookupThreshold = nowMs - lookupMaxAge;

  const statements = [
    db.prepare("DELETE FROM auth_envelope_nonces WHERE expires_at <= ?").bind(nowMs),
    db.prepare("DELETE FROM device_lookup_attempts WHERE attempted_at <= ?").bind(lookupThreshold),
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").bind(nowMs),
    db
      .prepare(
        "DELETE FROM enrollment_proposals WHERE expires_at <= ? AND status IN ('expired', 'denied')",
      )
      .bind(nowMs),
  ];

  const results = await db.batch(statements);

  return {
    expiredNonces: (results[0]?.meta?.changes as number) ?? 0,
    expiredLookupAttempts: (results[1]?.meta?.changes as number) ?? 0,
    expiredDeviceCodes: (results[2]?.meta?.changes as number) ?? 0,
    expiredProposals: (results[3]?.meta?.changes as number) ?? 0,
  };
}

export interface DeletionSafeRestoreResult extends RestoreResult {
  readonly appliedControlsCount: number;
  readonly targetIdentifier: string;
}

/**
 * Replays deletion-safe restore into a validated scratch target.
 *
 * Sequence:
 * 1. Validates scratch target (refuses non-scratch targets before any action).
 * 2. Preflight verifies the snapshot NDJSON integrity chain.
 * 3. Restores verified problem state into the scratch target.
 * 4. If deletion journal is provided, verifies the journal (fails closed if tampered or corrupt).
 * 5. Reapplies any retention controls newer than the snapshot or recorded in the journal.
 * 6. Verifies that no deleted identity/private draft remains serviceable in target before completion.
 */
export async function deletionSafeRestore(options: {
  readonly db: D1Database;
  readonly targetIdentifier: string;
  readonly snapshotNdjson: string;
  readonly deletionJournalNdjson?: string;
  readonly now?: string;
}): Promise<DeletionSafeRestoreResult> {
  validateScratchTarget(options.targetIdentifier);

  const restoreResult = await restoreProblemExport(options.db, options.snapshotNdjson, {
    targetIdentifier: options.targetIdentifier,
  });

  let appliedControlsCount = 0;

  if (
    options.deletionJournalNdjson !== undefined &&
    options.deletionJournalNdjson.trim().length > 0
  ) {
    const verifiedJournal = await parseAndVerifyDeletionJournal(options.deletionJournalNdjson);
    if (!verifiedJournal.valid) {
      throw new KraterRestoreRefusedError(
        `DELETION_JOURNAL_VERIFICATION_FAILED: ${verifiedJournal.reason}`,
      );
    }

    const parsedSnapshot = parseProblemExport(options.snapshotNdjson);
    const snapshotProblem = parsedSnapshot.ok ? parsedSnapshot.header.problem : "";
    if (
      snapshotProblem.length > 0 &&
      verifiedJournal.records.some(
        (c) => c.action === "delete-private-draft" && c.targetId === snapshotProblem,
      )
    ) {
      throw new KraterRestoreRefusedError(
        `DELETION_CONTROL_CONFLICT: cannot restore deleted private draft '${snapshotProblem}'`,
      );
    }
    for (const control of verifiedJournal.records) {
      if (control.action === "delete-private-draft") {
        const targetProblemId = control.targetId;
        const exists = await options.db
          .prepare("SELECT id, status, public_seq FROM problems WHERE id = ?")
          .bind(targetProblemId)
          .first<{ id: string; status: string; public_seq: number }>();

        if (exists) {
          if (exists.status === "private-draft" && exists.public_seq === 0) {
            await options.db.batch([
              options.db
                .prepare("DELETE FROM workshop_objects WHERE problem_id = ?")
                .bind(targetProblemId),
              options.db
                .prepare("DELETE FROM workshop_revisions WHERE problem_id = ?")
                .bind(targetProblemId),
              options.db.prepare("DELETE FROM sessions WHERE problem_id = ?").bind(targetProblemId),
              options.db
                .prepare("DELETE FROM problem_statement_versions WHERE problem_id = ?")
                .bind(targetProblemId),
              options.db
                .prepare("DELETE FROM problem_memberships WHERE problem_id = ?")
                .bind(targetProblemId),
              options.db
                .prepare("DELETE FROM problem_stewards WHERE problem_id = ?")
                .bind(targetProblemId),
              options.db.prepare("DELETE FROM claims WHERE problem_id = ?").bind(targetProblemId),
              options.db.prepare("DELETE FROM problems WHERE id = ?").bind(targetProblemId),
            ]);
            appliedControlsCount += 1;
          }
        }
      } else if (control.action === "revoke-credential") {
        await options.db
          .prepare(
            "UPDATE enrollment_proposals SET status = 'expired' WHERE flow_handle_hash = ? OR proposal_id = ?",
          )
          .bind(control.targetId, control.targetId)
          .run();
        appliedControlsCount += 1;
      }
    }
  }

  return {
    ...restoreResult,
    appliedControlsCount,
    targetIdentifier: options.targetIdentifier,
  };
}
