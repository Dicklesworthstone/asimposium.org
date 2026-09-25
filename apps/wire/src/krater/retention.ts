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

import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import {
  type CheckpointSigningKey,
  type CheckpointVerifyKey,
  checkpointSigningKey,
} from "./checkpoint-signing.ts";
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

/** The exact bytes an Ed25519 journal signature covers. */
export function deletionJournalSignatureMessage(
  recordCount: number,
  finalDigest: string,
  generatedAt: string,
): string {
  return [DELETION_JOURNAL_FORMAT, String(recordCount), finalDigest, generatedAt].join("\n");
}

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Serializes retention control records to NDJSON with header and trailer
 * control records. With a signing key the trailer carries an Ed25519
 * signature over the record count, final chain digest and generation time;
 * only a signed journal verifies.
 */
export async function serializeDeletionJournal(
  records: readonly RetentionControlRecord[],
  generatedAt?: string,
  signingKey?: CheckpointSigningKey,
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

  const trailer: Record<string, unknown> = {
    control: DELETION_JOURNAL_TRAILER_CONTROL,
    record_count: records.length,
    final_digest: chainDigest,
  };
  if (signingKey !== undefined) {
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      signingKey.privateKey,
      new TextEncoder().encode(deletionJournalSignatureMessage(records.length, chainDigest, ts)),
    );
    trailer.key_id = signingKey.kid;
    trailer.signature = bytesToHex(new Uint8Array(signature));
  }
  lines.push(JSON.stringify(trailer));

  return `${lines.join("\n")}\n`;
}

/**
 * Parses and strictly verifies a deletion journal NDJSON stream. Fails closed
 * on any error, including a missing or invalid signature: the chain alone is
 * unkeyed and anyone could recompute it over a shortened journal.
 */
export async function parseAndVerifyDeletionJournal(
  ndjson: string,
  verifyKeys: readonly CheckpointVerifyKey[],
): Promise<
  | { valid: true; records: RetentionControlRecord[]; generatedAt: string; keyId: string }
  | { valid: false; reason: string }
> {
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
    headerObj.format !== DELETION_JOURNAL_FORMAT ||
    typeof headerObj.generated_at !== "string"
  ) {
    return { valid: false, reason: "invalid deletion journal header" };
  }
  if (trailerObj.control !== DELETION_JOURNAL_TRAILER_CONTROL) {
    return { valid: false, reason: "invalid deletion journal trailer" };
  }

  const recordLines = rawLines.slice(1, -1);
  if (
    trailerObj.record_count !== recordLines.length ||
    headerObj.record_count !== recordLines.length
  ) {
    return {
      valid: false,
      reason: `header/trailer record count disagrees with line count (${recordLines.length})`,
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

  const keyId = trailerObj.key_id;
  const signature = trailerObj.signature;
  if (typeof keyId !== "string" || typeof signature !== "string") {
    return { valid: false, reason: "journal is unsigned" };
  }
  if (!/^[0-9a-f]{128}$/.test(signature)) {
    return { valid: false, reason: "journal signature is malformed" };
  }
  const verifyKey = verifyKeys.find((candidate) => candidate.kid === keyId);
  if (verifyKey === undefined) {
    return { valid: false, reason: `journal key '${keyId}' is not a configured verify key` };
  }
  let signatureValid = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(verifyKey.publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    signatureValid = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      hexToBytes(signature),
      new TextEncoder().encode(
        deletionJournalSignatureMessage(recordLines.length, chainDigest, headerObj.generated_at),
      ),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { valid: false, reason: "journal signature does not verify" };
  }

  return { valid: true, records, generatedAt: headerObj.generated_at, keyId };
}

/** One append to the persisted deletion journal (migration 0080). Callers put
 * it in the same D1 batch as the deletion it records. */
export function deletionJournalStatement(
  db: D1Database,
  record: RetentionControlRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO deletion_journal
         (control_id, action, target_type, target_id, control_digest, record_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.controlId,
      record.action,
      record.targetType,
      record.targetId,
      record.controlDigest,
      JSON.stringify(record),
      record.issuedAt,
    );
}

/** The deletion statements for one never-published private draft, in
 * foreign-key dependency order. Shared by the sponsor route, account deletion
 * and journal replay so the three cannot drift. */
export function privateDraftDeletionStatements(
  db: D1Database,
  problemId: string,
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM workshop_objects WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM workshop_revisions WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM sessions WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problem_statement_versions WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problem_memberships WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problem_stewards WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM claims WHERE problem_id = ?").bind(problemId),
    // Every problem gets an integrity-backfill marker at creation; a
    // never-published draft's marker references no events. Without this the
    // problems delete fails its foreign key on real D1.
    db.prepare("DELETE FROM krater_integrity_backfill WHERE problem_id = ?").bind(problemId),
    db.prepare("DELETE FROM problems WHERE id = ?").bind(problemId),
  ];
}

/** Account-deletion authority changes, first statement = the sponsor
 * tombstone. Idempotent: replay against a restored database re-revokes. */
export function sponsorAccountDeletionStatements(
  db: D1Database,
  sponsorId: string,
  nowMs: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "UPDATE sponsors SET tombstoned_at = ? WHERE sponsor_id = ? AND tombstoned_at IS NULL",
      )
      .bind(nowMs, sponsorId),
    db
      .prepare(
        `UPDATE enrollment_proposals SET status = 'denied'
          WHERE status = 'pending'
            AND enrollment_id IN (SELECT enrollment_id FROM enrollment_records WHERE sponsor_id = ?)`,
      )
      .bind(sponsorId),
    db
      .prepare(
        `UPDATE sponsor_fellow_transfers SET status = 'cancelled', resolved_at = ?
          WHERE (source_sponsor_id = ? OR target_sponsor_id = ?) AND status = 'pending'`,
      )
      .bind(nowMs, sponsorId, sponsorId),
    db
      .prepare(
        `UPDATE enrollment_fellows SET status = 'revoked', status_changed_at = ?
          WHERE sponsor_id = ? AND status != 'revoked'`,
      )
      .bind(nowMs, sponsorId),
    db
      .prepare(
        "UPDATE fellow_tokens SET revoked_at = ? WHERE sponsor_id = ? AND revoked_at IS NULL",
      )
      .bind(nowMs, sponsorId),
  ];
}

/** Every journal record, oldest first, each re-verified against its digest. */
export async function readDeletionJournalRecords(
  db: D1Database,
): Promise<RetentionControlRecord[]> {
  const rows = await db
    .prepare("SELECT seq, record_json, control_digest FROM deletion_journal ORDER BY seq")
    .all<{ seq: number; record_json: string; control_digest: string }>();
  const records: RetentionControlRecord[] = [];
  for (const row of rows.results ?? []) {
    const verified = await verifyRetentionControlRecord(JSON.parse(row.record_json));
    if (!verified.valid || verified.record.controlDigest !== row.control_digest) {
      throw new RetentionError(
        "DELETION_JOURNAL_CORRUPT",
        `deletion journal row ${row.seq} does not verify`,
      );
    }
    records.push(verified.record);
  }
  return records;
}

export const DELETION_JOURNAL_R2_PREFIX = "journal/deletion/v1/";

export function deletionJournalObjectKey(recordCount: number): string {
  return `${DELETION_JOURNAL_R2_PREFIX}${String(recordCount).padStart(10, "0")}.ndjson`;
}

export interface DeletionJournalPublication {
  readonly enabled: boolean;
  readonly recordCount: number;
  readonly published: boolean;
}

/**
 * Cron step: publish the whole journal, signed, to the private bucket under a
 * write-once key per record count. A point-in-time D1 restore rolls the
 * deletion_journal table back; this copy does not. A missing signing key
 * disables publication rather than writing an unsigned journal.
 */
export async function publishDeletionJournal(
  db: D1Database,
  bucket: R2Bucket,
  rawSigningKey: string | undefined,
  now: () => string = () => new Date().toISOString(),
): Promise<DeletionJournalPublication> {
  const key = await checkpointSigningKey(rawSigningKey);
  if (key === null) return { enabled: false, recordCount: 0, published: false };
  const records = await readDeletionJournalRecords(db);
  if (records.length === 0) return { enabled: true, recordCount: 0, published: false };
  const objectKey = deletionJournalObjectKey(records.length);
  if ((await bucket.head(objectKey)) !== null) {
    return { enabled: true, recordCount: records.length, published: false };
  }
  const ndjson = await serializeDeletionJournal(records, now(), key);
  const written = await bucket.put(objectKey, ndjson, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  return { enabled: true, recordCount: records.length, published: written !== null };
}

/** The newest published journal (highest record count), or null if none. */
export async function fetchLatestDeletionJournal(bucket: R2Bucket): Promise<string | null> {
  let newest: string | undefined;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: DELETION_JOURNAL_R2_PREFIX, cursor });
    for (const object of page.objects) {
      if (newest === undefined || object.key > newest) newest = object.key;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  if (newest === undefined) return null;
  const object = await bucket.get(newest);
  return object === null ? null : await object.text();
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

  const receiptId = `DEL-${crypto.randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
  const controlRecord = await createRetentionControlRecord({
    action: "delete-private-draft",
    targetId: problemId,
    targetType: "problem",
    payload: {
      sponsor_id: sponsorId,
      receipt_id: receiptId,
      deleted_at: now,
    },
    issuedAt: now,
  });

  // The deletion and its journal row commit atomically: a committed deletion
  // always has the record a later restore needs to replay it.
  const results = await db.batch([
    ...privateDraftDeletionStatements(db, problemId),
    deletionJournalStatement(db, controlRecord),
  ]);

  const receipt: DeletionReceipt = {
    receiptId,
    targetId: problemId,
    targetType: "problem",
    deletedAt: now,
    backupRetentionWindowDays: 90,
    legalHoldException: false,
    sharedPublicHashConsequence: "private-bytes-purged-shared-public-hashes-retained",
    expectedPhysicalErasureDeadline,
  };

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
      problem: (results[8]?.meta?.changes as number) ?? 0,
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

  // auth_envelope_nonces stores epoch SECONDS (auth/nonce.ts validEpochSecond);
  // comparing it with milliseconds would delete every live nonce and reopen
  // the signed-envelope replay window.
  const nowSeconds = Math.floor(nowMs / 1000);
  const statements = [
    db.prepare("DELETE FROM auth_envelope_nonces WHERE expires_at <= ?").bind(nowSeconds),
    db.prepare("DELETE FROM device_lookup_attempts WHERE attempted_at <= ?").bind(lookupThreshold),
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").bind(nowMs),
    // enrollment_proposals is append-only (0011 enrollment_proposals_no_delete):
    // a DELETE here aborts the whole batch on real D1, so no nonce is ever
    // swept. Dead proposals stay as the sponsor's decision history.
  ];

  const results = await db.batch(statements);

  return {
    expiredNonces: (results[0]?.meta?.changes as number) ?? 0,
    expiredLookupAttempts: (results[1]?.meta?.changes as number) ?? 0,
    expiredDeviceCodes: (results[2]?.meta?.changes as number) ?? 0,
  };
}

export interface DeletionSafeRestoreResult extends RestoreResult {
  readonly appliedControlsCount: number;
  readonly targetIdentifier: string;
}

export interface DeletionJournalReplay {
  readonly records: number;
  readonly appliedControlsCount: number;
}

/** Targets a verified journal says are deleted but the database still serves. */
export async function findResurrectedTargets(
  db: D1Database,
  records: readonly RetentionControlRecord[],
): Promise<string[]> {
  const resurrected: string[] = [];
  for (const control of records) {
    if (control.action === "delete-private-draft") {
      const row = await db
        .prepare("SELECT id FROM problems WHERE id = ?")
        .bind(control.targetId)
        .first<{ id: string }>();
      if (row) resurrected.push(`problem:${control.targetId}`);
    } else if (control.action === "delete-account-private-data") {
      const sponsor = await db
        .prepare("SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?")
        .bind(control.targetId)
        .first<{ tombstoned_at: number | null }>();
      if (sponsor && sponsor.tombstoned_at === null) {
        resurrected.push(`sponsor:${control.targetId}`);
      }
      const live = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM fellow_tokens WHERE sponsor_id = ? AND revoked_at IS NULL",
        )
        .bind(control.targetId)
        .first<{ n: number }>();
      if ((live?.n ?? 0) > 0) resurrected.push(`credentials-of:${control.targetId}`);
    }
  }
  return resurrected;
}

/**
 * Verify a signed deletion journal, reapply every control to a restored
 * scratch database, and refuse cutover if any deleted target is still
 * serviceable. A missing, unsigned, tampered or unverifiable journal refuses
 * before any write.
 */
export async function applyDeletionJournal(options: {
  readonly db: D1Database;
  readonly targetIdentifier: string;
  readonly deletionJournalNdjson: string | null | undefined;
  readonly verifyKeys: readonly CheckpointVerifyKey[];
}): Promise<DeletionJournalReplay> {
  validateScratchTarget(options.targetIdentifier);
  const records = await verifiedJournalRecords(options.deletionJournalNdjson, options.verifyKeys);
  const applied = await replayControls(options.db, records);
  const resurrected = await findResurrectedTargets(options.db, records);
  if (resurrected.length > 0) {
    throw new KraterRestoreRefusedError(
      `DELETION_RESURRECTION_DETECTED: ${resurrected.length} deleted target(s) remain serviceable`,
    );
  }
  return { records: records.length, appliedControlsCount: applied };
}

async function verifiedJournalRecords(
  ndjson: string | null | undefined,
  verifyKeys: readonly CheckpointVerifyKey[],
): Promise<RetentionControlRecord[]> {
  if (ndjson === undefined || ndjson === null || ndjson.trim().length === 0) {
    throw new KraterRestoreRefusedError(
      "DELETION_JOURNAL_MISSING: restore requires the newest signed deletion journal",
    );
  }
  const verified = await parseAndVerifyDeletionJournal(ndjson, verifyKeys);
  if (!verified.valid) {
    throw new KraterRestoreRefusedError(`DELETION_JOURNAL_VERIFICATION_FAILED: ${verified.reason}`);
  }
  return verified.records;
}

async function replayControls(
  db: D1Database,
  records: readonly RetentionControlRecord[],
): Promise<number> {
  let applied = 0;
  for (const control of records) {
    if (control.action === "delete-private-draft") {
      const exists = await db
        .prepare("SELECT status, public_seq FROM problems WHERE id = ?")
        .bind(control.targetId)
        .first<{ status: string; public_seq: number }>();
      if (exists && exists.status === "private-draft" && exists.public_seq === 0) {
        await db.batch(privateDraftDeletionStatements(db, control.targetId));
        applied += 1;
      }
    } else if (control.action === "delete-account-private-data") {
      await db.batch(
        sponsorAccountDeletionStatements(db, control.targetId, Date.parse(control.issuedAt)),
      );
      applied += 1;
    } else if (control.action === "revoke-credential") {
      await db
        .prepare(
          "UPDATE enrollment_proposals SET status = 'expired' WHERE flow_handle_hash = ? OR proposal_id = ?",
        )
        .bind(control.targetId, control.targetId)
        .run();
      applied += 1;
    }
  }
  return applied;
}

/**
 * Deletion-safe restore of one problem export into a validated scratch target.
 *
 * 1. Refuses a non-scratch target.
 * 2. Verifies the signed deletion journal BEFORE any write; a missing or
 *    unverifiable journal refuses (fail closed).
 * 3. Refuses to restore a problem the journal records as a deleted draft.
 * 4. Restores the verified export, reapplies every journal control, and
 *    refuses cutover if any deleted target is still serviceable.
 */
export async function deletionSafeRestore(options: {
  readonly db: D1Database;
  readonly targetIdentifier: string;
  readonly snapshotNdjson: string;
  readonly deletionJournalNdjson: string | null | undefined;
  readonly verifyKeys: readonly CheckpointVerifyKey[];
}): Promise<DeletionSafeRestoreResult> {
  validateScratchTarget(options.targetIdentifier);
  const records = await verifiedJournalRecords(options.deletionJournalNdjson, options.verifyKeys);

  const parsedSnapshot = parseProblemExport(options.snapshotNdjson);
  const snapshotProblem = parsedSnapshot.ok ? parsedSnapshot.header.problem : "";
  if (
    snapshotProblem.length > 0 &&
    records.some((c) => c.action === "delete-private-draft" && c.targetId === snapshotProblem)
  ) {
    throw new KraterRestoreRefusedError(
      `DELETION_CONTROL_CONFLICT: cannot restore deleted private draft '${snapshotProblem}'`,
    );
  }

  const restoreResult = await restoreProblemExport(options.db, options.snapshotNdjson, {
    targetIdentifier: options.targetIdentifier,
  });
  const appliedControlsCount = await replayControls(options.db, records);
  const resurrected = await findResurrectedTargets(options.db, records);
  if (resurrected.length > 0) {
    throw new KraterRestoreRefusedError(
      `DELETION_RESURRECTION_DETECTED: ${resurrected.length} deleted target(s) remain serviceable`,
    );
  }

  return {
    ...restoreResult,
    appliedControlsCount,
    targetIdentifier: options.targetIdentifier,
  };
}
