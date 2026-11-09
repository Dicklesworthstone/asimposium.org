/** Private readback of the exact publication retained by report intake.
 * A visibility hold does not prevent operator review, but private drafts,
 * redaction and broken content commitments always withhold the bytes. */
import {
  ADMIN_REPORT_DETAIL_SCHEMA_ID,
  ADMIN_REPORT_SOURCE_MAX_BYTES,
  type AdminReportDetail,
  AdminReportDetailSchema,
  AdminReportIdSchema,
  type AdminReportSource,
  AdminReportSourceSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope.ts";
import {
  type CitationContentRow,
  verifiedCitationContent,
} from "../ledger/citation-read-integrity.ts";
import { conflictingModerationIdentitySql } from "./target.ts";

/** Deliberate public producers; workshop and other private events never qualify. */
const SOURCE_TYPES: Readonly<Record<string, readonly string[]>> = {
  problem: ["problem.admitted", "problem.statement-revised"],
  claim: ["claim.created", "claim.revised"],
  hypothesis: [
    "hypothesis.created",
    "hypothesis.killed",
    "hypothesis.deferred",
    "hypothesis.resumed",
    "hypothesis.narrowed",
    "hypothesis.superseded",
  ],
  evidence: ["evidence.created"],
  review: ["review.created"],
  citation: ["citation.recorded", "citation.corrected"],
  dead_end: ["dead_end.recorded"],
  question: ["question.asked", "question.leased", "question.answered", "question.withdrawn"],
  conflict: ["conflict.normalized", "conflict.resolved"],
  gap: ["gap.filed", "gap.closed-by", "gap.withdrawn"],
  relation: ["relation.asserted", "relation.disputed"],
  synthesis: ["synthesis.created"],
  retraction: ["object.retracted"],
  commentary: ["commentary.posted", "commentary.superseded"],
  artifact: ["artifact.publication-requested"],
};

export interface ReportSourcePin {
  readonly eventId: string;
  readonly digest: string;
  readonly requestedRef: string;
  /** A same-transaction availability witness, never copied into reports. */
  readonly payloadJson: string;
}

interface SourceRow extends CitationContentRow {
  readonly id: string;
  readonly type: string;
  readonly object_kind: string;
  readonly object_id: string;
  readonly object_version: number;
  readonly created_at: string;
  readonly payload_bytes: number | null;
  readonly actor_fellow_id?: string | null;
  readonly actor_sponsor_id?: string | null;
  readonly actor_session_id?: string | null;
  readonly model_string_self_declared?: string | null;
  readonly harness?: string | null;
}

export class ReportSourceUnavailableError extends Error {
  constructor() {
    super("REPORT_SOURCE_UNAVAILABLE");
  }
}

/** Capture before whole-claim canonicalization. Latest selection happens
 * before availability checks, so a redacted head cannot resurrect old text. */
export async function captureReportSource(
  db: D1Database,
  problemId: string,
  requestedRef: string,
  targetKind: string,
): Promise<ReportSourcePin | undefined> {
  const types = SOURCE_TYPES[targetKind];
  if (types === undefined) return undefined;
  const pin = targetKind === "claim" ? /^(C-[0-9]+)@([1-9][0-9]{0,8})$/.exec(requestedRef) : null;
  const objectId = requestedRef === "problem" ? problemId : (pin?.[1] ?? requestedRef);
  const row = await db
    .prepare(`SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind,
      e.object_id, e.object_version, e.created_at, e.payload_sha256, p.public_seq,
      c.payload_sha256 AS content_sha256, c.redacted_at,
      length(CAST(c.payload_json AS BLOB)) AS payload_bytes,
      CASE WHEN c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= ? THEN c.payload_json END AS payload_json
    FROM problems p JOIN events e ON e.id = (
      SELECT candidate.id FROM events candidate
      WHERE candidate.problem_id = p.id AND candidate.object_id = ? AND candidate.object_kind = ?
        AND candidate.type IN (${types.map(() => "?").join(",")})
        AND candidate.seq <= p.public_seq ${pin === null ? "" : "AND candidate.object_version = ?"}
      ORDER BY candidate.seq DESC LIMIT 1
    ) LEFT JOIN event_content c ON c.event_id = e.id
    WHERE p.id = ? AND p.status <> 'private-draft' AND p.public_seq > 0`)
    .bind(
      ADMIN_REPORT_SOURCE_MAX_BYTES,
      objectId,
      targetKind,
      ...types,
      ...(pin === null ? [] : [Number(pin[2])]),
      problemId,
    )
    .first<SourceRow>();
  if (
    row === null ||
    (await verifiedCitationContent(problemId, row, ADMIN_REPORT_SOURCE_MAX_BYTES)) === undefined
  )
    return undefined;
  return {
    eventId: row.id,
    digest: row.payload_sha256,
    requestedRef,
    payloadJson: row.payload_json as string,
  };
}

/** Used inside report INSERT, including a byte witness across async hashing. */
export const REPORT_SOURCE_PIN_AVAILABLE_SQL = `EXISTS (
  SELECT 1 FROM events source JOIN problems scope ON scope.id = source.problem_id
  JOIN event_content content ON content.event_id = source.id
  WHERE source.id = ? AND source.payload_sha256 = ? AND source.problem_id = ?
    AND source.object_kind = ? AND source.object_id = ?
    AND source.seq BETWEEN 1 AND scope.public_seq AND scope.status <> 'private-draft'
    AND content.payload_sha256 = source.payload_sha256 AND content.redacted_at IS NULL
    AND content.payload_json = ?
    AND NOT ${conflictingModerationIdentitySql("source", "scope.public_seq")}
)`;

export function reportSourcePinBindings(input: {
  readonly problemId: string;
  readonly targetKind: string;
  readonly targetRef: string;
  readonly source: ReportSourcePin;
}): (string | number)[] {
  return [
    input.source.eventId,
    input.source.digest,
    input.problemId,
    input.targetKind,
    input.targetRef === "problem" ? input.problemId : input.targetRef,
    input.source.payloadJson,
  ];
}

interface ReportDetailRow {
  report_id: string;
  problem_id: string;
  target_kind: string;
  target_ref: string;
  reason: string;
  note: string | null;
  reporter_class: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution_reason: string | null;
  source_event_id: string | null;
  source_digest: string | null;
  source_ref: string | null;
}

async function readSource(db: D1Database, report: ReportDetailRow): Promise<AdminReportSource> {
  const unavailable = (
    reason: Extract<AdminReportSource, { state: "unavailable" }>["reason"],
  ): AdminReportSource => ({ state: "unavailable", reason });
  if (
    report.source_event_id === null &&
    report.source_digest === null &&
    report.source_ref === null
  )
    return unavailable("not-pinned");
  if (
    report.source_event_id === null ||
    report.source_digest === null ||
    report.source_ref === null
  )
    return unavailable("integrity-failed");
  const row = await db
    .prepare(`SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind, e.object_id, e.object_version,
      e.created_at, e.payload_sha256, e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
      e.model_string_self_declared, e.harness, p.public_seq, p.status AS problem_status,
      c.payload_sha256 AS content_sha256, c.redacted_at,
      length(CAST(c.payload_json AS BLOB)) AS payload_bytes,
      CASE WHEN p.status <> 'private-draft' AND e.seq <= p.public_seq AND c.redacted_at IS NULL
        AND length(CAST(c.payload_json AS BLOB)) <= ? THEN c.payload_json END AS payload_json
    FROM events e JOIN problems p ON p.id = e.problem_id
    LEFT JOIN event_content c ON c.event_id = e.id WHERE e.id = ?`)
    .bind(ADMIN_REPORT_SOURCE_MAX_BYTES, report.source_event_id)
    .first<SourceRow & { problem_status: string }>();
  if (row === null) return unavailable("missing");
  if (row.problem_status === "private-draft" || row.seq > row.public_seq)
    return unavailable("not-public");
  if (row.redacted_at !== null) return unavailable("redacted");
  if (row.payload_bytes !== null && row.payload_bytes > ADMIN_REPORT_SOURCE_MAX_BYTES)
    return unavailable("too-large");
  if (row.payload_json === null) return unavailable("missing");
  const expectedObjectId = report.target_ref === "problem" ? report.problem_id : report.target_ref;
  const validRef =
    report.source_ref === report.target_ref ||
    (report.target_kind === "claim" &&
      report.source_ref === `${expectedObjectId}@${row.object_version}`);
  if (
    row.problem_id !== report.problem_id ||
    row.object_kind !== report.target_kind ||
    row.object_id !== expectedObjectId ||
    row.payload_sha256 !== report.source_digest ||
    !validRef ||
    !SOURCE_TYPES[report.target_kind]?.includes(row.type) ||
    (await verifiedCitationContent(report.problem_id, row, ADMIN_REPORT_SOURCE_MAX_BYTES)) ===
      undefined
  )
    return unavailable("integrity-failed");
  const source = AdminReportSourceSchema.safeParse({
    state: "available",
    binding: report.source_ref.includes("@") ? "requested-version" : "captured-at-filing",
    requested_target: report.source_ref,
    event_id: row.id,
    seq: row.seq,
    event_type: row.type,
    object_id: row.object_id,
    object_version: row.object_version,
    created_at: row.created_at,
    payload_sha256: row.payload_sha256,
    fellow_id: row.actor_fellow_id ?? null,
    sponsor_id: row.actor_sponsor_id ?? null,
    session_id: row.actor_session_id ?? null,
    model_self_declared: row.model_string_self_declared ?? null,
    harness_self_declared: row.harness ?? null,
    payload_json: row.payload_json,
  });
  if (!source.success) return unavailable("integrity-failed");
  // Recheck after hashing: redaction or private-scope changes during the read
  // must not disclose the retained bytes. Moderation holds alone are reviewable.
  const stillAvailable = await db
    .prepare(`SELECT 1 AS available WHERE ${REPORT_SOURCE_PIN_AVAILABLE_SQL}`)
    .bind(
      ...reportSourcePinBindings({
        problemId: report.problem_id,
        targetKind: report.target_kind,
        targetRef: report.target_ref,
        source: {
          eventId: row.id,
          digest: row.payload_sha256,
          requestedRef: report.source_ref,
          payloadJson: row.payload_json,
        },
      }),
    )
    .first<{ available: number }>();
  return stillAvailable?.available === 1 ? source.data : unavailable("missing");
}

export async function readOperatorReportDetail(
  db: D1Database,
  reportId: string,
): Promise<AdminReportDetail | undefined> {
  if (!AdminReportIdSchema.safeParse(reportId).success) return undefined;
  const report = await db
    .prepare(`SELECT report_id, problem_id, target_kind, target_ref, reason, note,
    reporter_class, status, created_at, resolved_at, resolution_reason, source_event_id, source_digest, source_ref
    FROM reports WHERE report_id = ?`)
    .bind(reportId)
    .first<ReportDetailRow>();
  if (report === null) return undefined;
  return AdminReportDetailSchema.parse({
    report: {
      report_id: report.report_id,
      target_id: `${report.problem_id}/${report.target_ref}`.slice(0, 128),
      target_kind: report.target_kind,
      created_at: report.created_at,
      reporter_class: report.reporter_class,
      category: report.reason,
      status: report.status,
    },
    problem_id: report.problem_id,
    target_ref: report.target_ref,
    note: report.note,
    source: await readSource(db, report),
    resolved_at: report.resolved_at,
    resolution_reason: report.resolution_reason,
  });
}

export async function operatorReportDetail(db: D1Database, reportId: string): Promise<Response> {
  const detail = await readOperatorReportDetail(db, reportId);
  const response =
    detail === undefined
      ? validatedProblem({
          status: 404,
          code: "MODERATION_TARGET_NOT_FOUND",
          title: "No such report",
          detail: "No report matches this identifier.",
          rule: "A5",
          fixHint: "Open a complete RP report identifier from the private operator queue.",
          extensions: {
            schema: ADMIN_REPORT_DETAIL_SCHEMA_ID,
            example: { report_id: `RP-${"0".repeat(26)}` },
          },
        })
      : Response.json(detail);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
