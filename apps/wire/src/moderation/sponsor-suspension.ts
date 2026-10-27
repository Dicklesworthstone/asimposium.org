import {
  type AdminSponsorSuspensionReceipt,
  AdminSponsorSuspensionReceiptSchema,
  type AdminSponsorSuspensionRequest,
  type AdminSponsorSuspensionState,
  AdminSponsorSuspensionStateSchema,
  SPONSOR_SUSPENSION_STEP_UP_SECONDS,
  type SponsorSuspensionStatus,
  SponsorSuspensionStatusSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { createRetentionControlRecord, deletionJournalStatement } from "../krater/retention.ts";
import { sha256Hex } from "../split/policy";
import { mintModerationId } from "./store";

interface SuspensionRow {
  event_id: string;
  sponsor_id: string;
  operator_id: string;
  reviewed_case_id: string;
  basis: "egregious-reviewed-case";
  reason: string;
  created_at: number;
  request_digest: string;
  paused_fellows: number;
  revoked_credentials: number;
  cancelled_enrollments: number;
  cancelled_transfers: number;
}

export class SponsorSuspensionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "TARGET" | "STEP_UP" | "CASE" | "CONFLICT" | "REPLAY_CONFLICT",
  ) {
    super(code);
    this.name = "SponsorSuspensionError";
  }
}

function receipt(row: SuspensionRow): AdminSponsorSuspensionReceipt {
  return AdminSponsorSuspensionReceiptSchema.parse({
    sponsor_id: row.sponsor_id,
    event_id: row.event_id,
    audit_event_id: `OA-${row.event_id.slice(3)}`,
    revision: 1,
    status: "suspended",
    reviewed_case_id: row.reviewed_case_id,
    basis: row.basis,
    applied_at: new Date(row.created_at).toISOString(),
    affected: {
      paused_fellows: row.paused_fellows,
      revoked_credentials: row.revoked_credentials,
      cancelled_enrollments: row.cancelled_enrollments,
      cancelled_transfers: row.cancelled_transfers,
    },
  });
}

export async function readSponsorSuspension(
  db: D1Database,
  sponsorId: string,
  now = Date.now(),
): Promise<AdminSponsorSuspensionState> {
  const row = await db
    .prepare(`SELECT s.sponsor_id, e.*,
      (SELECT COUNT(*) FROM enrollment_fellows WHERE sponsor_id = s.sponsor_id
        AND status IN ('active', 'suspicious_review')) AS active_fellows,
      (SELECT COUNT(*) FROM fellow_tokens WHERE sponsor_id = s.sponsor_id AND revoked_at IS NULL) AS unrevoked_credentials,
      (SELECT COUNT(*) FROM enrollment_records r WHERE r.sponsor_id = s.sponsor_id AND r.invalidated = 0
        AND r.secret_expires_at > ? AND NOT EXISTS (SELECT 1 FROM enrollment_proposals p
          WHERE p.enrollment_id = r.enrollment_id AND p.status <> 'pending')) AS pending_enrollments,
      (SELECT COUNT(*) FROM sponsor_fellow_transfers WHERE status = 'pending'
        AND (source_sponsor_id = s.sponsor_id OR target_sponsor_id = s.sponsor_id)) AS pending_transfers
      FROM sponsors s LEFT JOIN sponsor_suspension_events e ON e.sponsor_id = s.sponsor_id
      WHERE s.sponsor_id = ? AND s.tombstoned_at IS NULL`)
    .bind(now, sponsorId)
    .first<
      SuspensionRow & {
        active_fellows: number;
        unrevoked_credentials: number;
        pending_enrollments: number;
        pending_transfers: number;
      }
    >();
  if (row === null) throw new SponsorSuspensionError("NOT_FOUND");
  return AdminSponsorSuspensionStateSchema.parse({
    sponsor_id: sponsorId,
    revision: row.event_id == null ? 0 : 1,
    status: row.event_id == null ? "active" : "suspended",
    suspension:
      row.event_id == null
        ? null
        : {
            event_id: row.event_id,
            audit_event_id: `OA-${row.event_id.slice(3)}`,
            reviewed_case_id: row.reviewed_case_id,
            basis: row.basis,
            reason: row.reason,
            applied_at: new Date(row.created_at).toISOString(),
          },
    impact: {
      active_fellows: row.active_fellows,
      unrevoked_credentials: row.unrevoked_credentials,
      pending_enrollments: row.pending_enrollments,
      pending_transfers: row.pending_transfers,
    },
  });
}

export async function readSponsorSuspensionStatus(
  db: D1Database,
  sponsorId: string,
): Promise<SponsorSuspensionStatus> {
  const row = await db
    .prepare(`SELECT e.event_id, e.created_at FROM sponsors s
      LEFT JOIN sponsor_suspension_events e ON e.sponsor_id = s.sponsor_id
      WHERE s.sponsor_id = ? AND s.tombstoned_at IS NULL`)
    .bind(sponsorId)
    .first<{ event_id: string | null; created_at: number | null }>();
  if (row === null) throw new SponsorSuspensionError("NOT_FOUND");
  return SponsorSuspensionStatusSchema.parse({
    sponsor_id: sponsorId,
    status: row.event_id === null ? "active" : "suspended",
    suspension:
      row.event_id === null
        ? null
        : {
            event_id: row.event_id,
            audit_event_id: `OA-${row.event_id.slice(3)}`,
            applied_at: new Date(row.created_at as number).toISOString(),
            appeal: "SPONSOR_APPEAL_AVAILABLE",
          },
  });
}

/** No missing-table fallback: unreadable moderation authority must fail closed. */
export async function sponsorMutationRefusal(
  db: D1Database,
  sponsorId: string,
  method: string,
  action: string,
): Promise<Response | undefined> {
  if (
    method === "GET" ||
    method === "HEAD" ||
    [
      "sponsor.bootstrap",
      "sponsor.account.export",
      "sponsor.account.export-page",
      "sponsor.account.delete-preview",
      "sponsor.account.delete",
      "workshop.read",
      "workshop.list",
      "workshop.search",
      "sponsor.screening-appeals.submit",
    ].includes(action)
  )
    return undefined;
  const suspended = await db
    .prepare("SELECT event_id FROM sponsor_suspension_events WHERE sponsor_id = ?")
    .bind(sponsorId)
    .first<{ event_id: string }>();
  if (suspended === null) return undefined;
  return validatedProblem({
    status: 403,
    code: "WRITE_REFUSED",
    title: "Account authority is not available for this action",
    detail: "This account cannot authorize new work or credentials.",
    fixHint:
      "Read your account status in the sponsor console. The accountable human may appeal; account export remains available.",
    headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

export async function suspendSponsor(
  db: D1Database,
  sponsorId: string,
  operatorId: string,
  command: AdminSponsorSuspensionRequest,
  idempotencyKey: string,
  now = Date.now(),
): Promise<AdminSponsorSuspensionReceipt> {
  if (command.sponsor_id !== sponsorId) throw new SponsorSuspensionError("TARGET");
  const keyHash = await sha256Hex(idempotencyKey);
  const { step_up_authenticated_at: _authTime, ...intent } = command;
  const digest = await sha256Hex(JSON.stringify(intent));
  const replay = async () => {
    const row = await db
      .prepare(`SELECT * FROM sponsor_suspension_events
        WHERE sponsor_id = ? AND operator_id = ? AND idempotency_key_hash = ?`)
      .bind(sponsorId, operatorId, keyHash)
      .first<SuspensionRow>();
    if (row === null) return null;
    if (row.request_digest !== digest) throw new SponsorSuspensionError("REPLAY_CONFLICT");
    return receipt(row);
  };
  // An already accepted command returns its historical receipt even after the
  // authentication window or account changes. It performs no mutation.
  const prior = await replay();
  if (prior !== null) return prior;
  const age = Math.floor(now / 1000) - command.step_up_authenticated_at;
  if (age < 0 || age > SPONSOR_SUSPENSION_STEP_UP_SECONDS)
    throw new SponsorSuspensionError("STEP_UP");
  const state = await readSponsorSuspension(db, sponsorId, now);
  if (state.revision !== command.expected_revision) throw new SponsorSuspensionError("CONFLICT");
  const reviewed = await db
    .prepare(`SELECT case_id FROM screening_cases WHERE case_id = ? AND sponsor_id = ?
      AND state = 'rejected' AND decided_by IS NOT NULL`)
    .bind(command.reviewed_case_id, sponsorId)
    .first<{ case_id: string }>();
  if (reviewed === null) throw new SponsorSuspensionError("CASE");
  const eventId = mintModerationId("SS");
  const control = await createRetentionControlRecord({
    action: "suspend-sponsor",
    targetType: "sponsor",
    targetId: sponsorId,
    issuedAt: new Date(now).toISOString(),
    payload: { event_id: eventId, reviewed_case_id: command.reviewed_case_id },
  });
  try {
    // Consequence counts are captured by the INSERT's own snapshot, not the
    // UI preview. The trigger validates them and applies the whole cascade.
    const result = await db.batch([
      db
        .prepare(`INSERT INTO sponsor_suspension_events (
        event_id, sponsor_id, operator_id, reviewed_case_id, basis, reason, created_at,
        step_up_authenticated_at, idempotency_key_hash, request_digest,
        paused_fellows, revoked_credentials, cancelled_enrollments, cancelled_transfers
      ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        (SELECT COUNT(*) FROM enrollment_fellows WHERE sponsor_id = ?2 AND status IN ('active', 'suspicious_review')),
        (SELECT COUNT(*) FROM fellow_tokens WHERE sponsor_id = ?2 AND revoked_at IS NULL),
        (SELECT COUNT(*) FROM enrollment_records e WHERE e.sponsor_id = ?2 AND e.invalidated = 0
          AND e.secret_expires_at > ?7 AND NOT EXISTS (SELECT 1 FROM enrollment_proposals p
            WHERE p.enrollment_id = e.enrollment_id AND p.status <> 'pending')),
        (SELECT COUNT(*) FROM sponsor_fellow_transfers WHERE status = 'pending'
          AND (source_sponsor_id = ?2 OR target_sponsor_id = ?2))`)
        .bind(
          eventId,
          sponsorId,
          operatorId,
          command.reviewed_case_id,
          command.basis,
          command.reason,
          now,
          command.step_up_authenticated_at,
          keyHash,
          digest,
        ),
      deletionJournalStatement(db, control, {
        sql: "EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE event_id = ?)",
        bindings: [eventId],
      }),
    ]);
    if (result.some((item) => !item.success)) throw new Error("SPONSOR_SUSPENSION_STORAGE_FAILED");
  } catch (error) {
    const concurrent = await replay();
    if (concurrent !== null) return concurrent;
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("SPONSOR_SUSPENSION_NOT_CURRENT") ||
      message.includes("UNIQUE constraint failed")
    )
      throw new SponsorSuspensionError("CONFLICT");
    throw error;
  }
  const committed = await replay();
  if (committed === null) throw new Error("SPONSOR_SUSPENSION_RECEIPT_MISSING");
  return committed;
}
