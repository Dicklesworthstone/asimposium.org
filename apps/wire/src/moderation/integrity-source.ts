import type { IntegrityPublicationPin } from "@asimposium/contracts/integrity-cases";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  captureReportSource,
  readOperatorReportDetail,
  REPORT_SOURCE_PIN_AVAILABLE_SQL,
  reportSourcePinBindings,
} from "./report-detail.ts";
import { resolveReportTarget } from "./target.ts";

export class IntegrityCaseError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "SOURCE_UNAVAILABLE"
      | "CONFLICT"
      | "REVIEWER"
      | "STEP_UP"
      | "IDEMPOTENCY",
  ) {
    super(`INTEGRITY_CASE_${code}`);
  }
}

// Payloads are short-lived witnesses for an atomic admission. Cases retain
// only the immutable pin, never a second copy of the reported scientific text.
export interface IntegritySourceWitness {
  readonly pin: IntegrityPublicationPin;
  readonly objectId: string;
  readonly objectKind: string;
  readonly fellowId: string | null;
  readonly sponsorId: string | null;
  readonly payloadJson: string;
}
export interface IntegrityReportSource {
  readonly witness: IntegritySourceWitness;
  readonly reporterSponsorId: string;
  readonly reporterFellowId: string | null;
}

export function integrityWitnessGuard(witness: IntegritySourceWitness, publicOnly = false) {
  const source = {
    eventId: witness.pin.event_id,
    digest: witness.pin.payload_sha256,
    requestedRef: witness.pin.target_ref,
    payloadJson: witness.payloadJson,
  };
  return {
    sql: `${REPORT_SOURCE_PIN_AVAILABLE_SQL} AND EXISTS (
      SELECT 1 FROM events pinned WHERE pinned.id = ?
        AND pinned.seq = ? AND pinned.actor_sponsor_id IS ?
        AND pinned.actor_fellow_id IS ?
        ${publicOnly ? `AND NOT ${eventContentHiddenSql("pinned")}` : ""}
    )`,
    bindings: [
      ...reportSourcePinBindings({
        problemId: witness.pin.problem_id,
        targetKind: witness.objectKind,
        targetRef: witness.objectId,
        source,
      }),
      witness.pin.event_id,
      witness.pin.seq,
      witness.sponsorId,
      witness.fellowId,
    ],
  };
}

export async function readIntegrityReportSource(
  db: D1Database,
  reportId: string,
): Promise<IntegrityReportSource> {
  const detail = await readOperatorReportDetail(db, reportId);
  if (!detail || detail.report.category !== "integrity")
    throw new IntegrityCaseError("NOT_FOUND");
  if (detail.report.status !== "pending") throw new IntegrityCaseError("CONFLICT");
  if (detail.source.state !== "available" || !detail.source.sponsor_id)
    throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
  const source = detail.source;
  const report = await db
    .prepare(`SELECT reporter_sponsor_id, reporter_fellow_id FROM reports
      WHERE report_id = ? AND reason = 'integrity' AND status = 'pending'
        AND problem_id = ? AND source_event_id = ? AND source_digest = ?`)
    .bind(reportId, detail.problem_id, source.event_id, source.payload_sha256)
    .first<{ reporter_sponsor_id: string; reporter_fellow_id: string | null }>();
  if (!report) throw new IntegrityCaseError("CONFLICT");
  return {
    reporterSponsorId: report.reporter_sponsor_id,
    reporterFellowId: report.reporter_fellow_id,
    witness: {
      pin: {
        problem_id: detail.problem_id,
        target_ref:
          detail.report.target_kind === "claim"
            ? `${source.object_id}@${source.object_version}`
            : detail.report.target_kind === "problem"
              ? "problem"
              : source.object_id,
        event_id: source.event_id,
        payload_sha256: source.payload_sha256,
        seq: source.seq,
      },
      objectId: source.object_id,
      objectKind: detail.report.target_kind,
      fellowId: source.fellow_id,
      sponsorId: source.sponsor_id,
      payloadJson: source.payload_json,
    },
  };
}

// Claims must name their exact version. Other supported objects are pinned to
// the exact available publication selected here, not re-resolved at display time.
export async function readIntegrityCorrection(
  db: D1Database,
  reference: { problem_id: string; target_ref: string },
): Promise<IntegritySourceWitness> {
  if (/^C-[0-9]+$/.test(reference.target_ref))
    throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
  const target = await resolveReportTarget(db, reference.problem_id, reference.target_ref);
  if (!target || target.targetKind === "problem")
    throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
  const source = await captureReportSource(
    db,
    reference.problem_id,
    reference.target_ref,
    target.targetKind,
  );
  if (!source) throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
  const row = await db
    .prepare(`SELECT e.object_id, e.object_version, e.seq,
      e.actor_sponsor_id, e.actor_fellow_id FROM events e
      WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?
        AND e.object_kind = ? AND NOT ${eventContentHiddenSql("e")}`)
    .bind(source.eventId, reference.problem_id, source.digest, target.targetKind)
    .first<{
      object_id: string;
      object_version: number;
      seq: number;
      actor_sponsor_id: string | null;
      actor_fellow_id: string | null;
    }>();
  if (!row || !Number.isSafeInteger(row.seq) || row.seq < 1)
    throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
  const witness: IntegritySourceWitness = {
    pin: {
      problem_id: reference.problem_id,
      target_ref:
        target.targetKind === "claim"
          ? `${row.object_id}@${row.object_version}`
          : row.object_id,
      event_id: source.eventId,
      payload_sha256: source.digest,
      seq: row.seq,
    },
    objectId: row.object_id,
    objectKind: target.targetKind,
    fellowId: row.actor_fellow_id,
    sponsorId: row.actor_sponsor_id,
    payloadJson: source.payloadJson,
  };
  const guard = integrityWitnessGuard(witness, true);
  const available = await db
    .prepare(`SELECT 1 AS ok WHERE ${guard.sql}`)
    .bind(...guard.bindings)
    .first<{ ok: number }>();
  if (available?.ok !== 1) throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
  return witness;
}

// Recorded sponsorship and current sponsorship both create known conflicts.
// A self-declaration cannot override either relationship.
export function integrityConflictGuard(
  operatorId: string,
  sponsors: readonly (string | null)[],
  fellows: readonly (string | null)[],
) {
  const sponsorIds = [...new Set(sponsors.filter((id): id is string => id !== null))];
  const fellowIds = [...new Set(fellows.filter((id): id is string => id !== null))];
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE s.value = ?)
      AND NOT EXISTS (SELECT 1 FROM enrollment_fellows f JOIN json_each(?) ids
        ON ids.value = f.fellow_id WHERE f.sponsor_id = ?)`,
    bindings: [JSON.stringify(sponsorIds), operatorId, JSON.stringify(fellowIds), operatorId],
  };
}

export async function requireUnconflictedIntegrityOperator(
  db: D1Database,
  operatorId: string,
  sponsors: readonly (string | null)[],
  fellows: readonly (string | null)[],
) {
  const guard = integrityConflictGuard(operatorId, sponsors, fellows);
  const row = await db.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`)
    .bind(...guard.bindings).first<{ ok: number }>();
  if (row?.ok !== 1) throw new IntegrityCaseError("REVIEWER");
  return guard;
}
