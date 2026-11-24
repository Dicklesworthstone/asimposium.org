import {
  INTEGRITY_CASES_SCHEMA_ID,
  INTEGRITY_CASE_PAGE_LIMIT,
  IntegrityCaseActionSchema,
  IntegrityCaseDetailResponseSchema,
  IntegrityCaseListResponseSchema,
  IntegrityCaseSchema,
  IntegrityCaseSummarySchema,
  OperatorIntegrityCaseDetailResponseSchema,
  PublicIntegrityNoticesResponseSchema,
  IntegrityPublicationPinSchema,
  type IntegrityPublicationPin,
  type PublicIntegrityNotice,
  integrityCaseDetailMatchesRequest,
  integrityCaseListMatchesQuery,
  type IntegrityCaseQuery,
  type IntegrityCaseReadRequest,
} from "@asimposium/contracts/integrity-cases";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import {
  IntegrityCaseError,
  INTEGRITY_ACTIVE_SPONSOR_SQL,
  type IntegrityCaseRow,
  readIntegrityCaseRow,
  integrityDigest,
} from "./integrity-store.ts";

function caseView(row: IntegrityCaseRow) {
  return IntegrityCaseSchema.parse({
    case_id: row.case_id,
    source: {
      problem_id: row.problem_id, target_ref: row.target_ref,
      event_id: row.source_event_id, payload_sha256: row.source_digest, seq: row.source_seq,
    },
    subject_sponsor_id: row.subject_sponsor_id,
    subject_fellow_id: row.subject_fellow_id,
    concern: row.concern, summary: row.summary, public_notice: row.public_notice === 1,
    state: row.state, revision: row.revision, appeals_used: row.appeals_used,
    opened_at: row.opened_at, resolved_at: row.resolved_at,
    outcome: row.outcome, rationale: row.rationale,
    corrections: JSON.parse(row.correction_refs_json),
  });
}

export async function queryIntegrityCases(
  db: D1Database,
  query: IntegrityCaseQuery,
  sponsorId?: string,
) {
  const result = await db.prepare(`SELECT c.* FROM integrity_cases c
    WHERE (? IS NULL OR c.opened_at < ? OR (c.opened_at = ? AND c.case_id < ?))
      ${sponsorId === undefined ? "" : `AND c.subject_sponsor_id = ? AND ${INTEGRITY_ACTIVE_SPONSOR_SQL}`}
    ORDER BY c.opened_at DESC, c.case_id DESC LIMIT ?`)
    .bind(
      query.before?.opened_at ?? null, query.before?.opened_at ?? null,
      query.before?.opened_at ?? null, query.before?.case_id ?? null,
      ...(sponsorId === undefined ? [] : [sponsorId, sponsorId]), query.limit + 1,
    ).all<IntegrityCaseRow>();
  const hasMore = result.results.length > query.limit;
  const cases = result.results.slice(0, query.limit).map((row) => {
    const { summary: _summary, rationale: _rationale, corrections: _corrections, outcome: _outcome, ...item } =
      caseView(row);
    return IntegrityCaseSummarySchema.parse(item);
  });
  const last = cases.at(-1);
  const face = IntegrityCaseListResponseSchema.parse({
    schema: INTEGRITY_CASES_SCHEMA_ID, cases, has_more: hasMore,
    next_cursor: hasMore && last ? { opened_at: last.opened_at, case_id: last.case_id } : null,
  });
  if (!integrityCaseListMatchesQuery(query, face)) throw new Error("INTEGRITY_CASE_LIST_INVALID");
  if (sponsorId !== undefined) {
    const current = await db.prepare(`SELECT 1 AS active WHERE ${INTEGRITY_ACTIVE_SPONSOR_SQL}`)
      .bind(sponsorId).first<{ active: number }>();
    if (current?.active !== 1) throw new IntegrityCaseError("NOT_FOUND");
  }
  return face;
}

export async function readIntegrityCase(
  db: D1Database,
  request: IntegrityCaseReadRequest,
  sponsorId?: string,
) {
  const row = await readIntegrityCaseRow(db, request.case_id, sponsorId);
  if (!row) throw new IntegrityCaseError("NOT_FOUND");
  if (request.after_revision > row.revision) throw new IntegrityCaseError("CONFLICT");
  const result = await db.prepare(`SELECT action_id, revision, kind, actor_class,
      actor_id, body_json, created_at FROM integrity_case_actions
    WHERE case_id = ? AND revision > ? AND revision <= ?
    ORDER BY revision LIMIT ?`)
    .bind(row.case_id, request.after_revision, row.revision, request.limit + 1)
    .all<{
      action_id: string; revision: number; kind: string; actor_class: string;
      actor_id: string; body_json: string; created_at: string;
    }>();
  const actions = result.results.slice(0, request.limit).map(({ body_json, ...action }) =>
    IntegrityCaseActionSchema.parse({ ...action, body: JSON.parse(body_json) }));
  const hasMore = result.results.length > request.limit;
  const face = IntegrityCaseDetailResponseSchema.parse({
    schema: INTEGRITY_CASES_SCHEMA_ID, case: caseView(row), actions, has_more: hasMore,
    next_after_revision: hasMore ? actions.at(-1)?.revision : null,
  });
  if (!integrityCaseDetailMatchesRequest(request, face))
    throw new Error("INTEGRITY_CASE_HISTORY_INCOMPLETE");
  // All returned action pages belong to one complete header revision. Account
  // deletion or a concurrent response cannot turn a partial history into current state.
  const current = await readIntegrityCaseRow(db, request.case_id, sponsorId);
  if (!current) throw new IntegrityCaseError("NOT_FOUND");
  if (JSON.stringify(current) !== JSON.stringify(row)) throw new IntegrityCaseError("CONFLICT");
  return sponsorId === undefined
    ? OperatorIntegrityCaseDetailResponseSchema.parse({ ...face, report_id: row.report_id })
    : face;
}

const PUBLIC_NOTICE_SQL = `
WITH scope AS MATERIALIZED (
  SELECT p.id, p.unlisted, p.public_seq FROM problems p
  WHERE p.id = ? AND p.status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
),
selected AS MATERIALIZED (
  SELECT i.case_id, i.problem_id, i.target_ref, i.source_event_id, i.source_digest,
    i.source_seq, i.state, i.revision, i.opened_at, i.resolved_at, i.correction_refs_json,
    COALESCE((SELECT a.created_at FROM integrity_case_actions a
      WHERE a.case_id = i.case_id AND a.revision = i.revision), i.opened_at) AS updated_at
  FROM integrity_cases i JOIN scope p ON p.id = i.problem_id
  JOIN events e ON e.id = i.source_event_id AND e.problem_id = i.problem_id
    AND e.payload_sha256 = i.source_digest AND e.seq = i.source_seq AND e.seq <= p.public_seq
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    AND c.redacted_at IS NULL
  WHERE i.public_notice = 1 AND i.case_id > ?
    AND NOT (i.state = 'resolved' AND i.outcome = 'unsubstantiated')
    AND NOT ${eventContentHiddenSql("e")}
    AND ((e.object_kind = 'claim' AND i.target_ref = e.object_id || '@' || e.object_version)
      OR (e.object_kind <> 'claim' AND i.target_ref = e.object_id)
      OR (e.object_id = p.id AND i.target_ref = 'problem'))
  ORDER BY i.case_id COLLATE BINARY LIMIT ${INTEGRITY_CASE_PAGE_LIMIT + 1}
)
SELECT p.id AS problem_id, p.unlisted, i.case_id, i.target_ref,
  i.source_event_id, i.source_digest, i.source_seq, i.state, i.revision,
  i.opened_at, i.updated_at,
  (SELECT json_group_array(json(visible.pin)) FROM (
    SELECT pin.value AS pin FROM json_each(i.correction_refs_json) pin
    JOIN events correction ON correction.id = json_extract(pin.value, '$.event_id')
      AND correction.problem_id = json_extract(pin.value, '$.problem_id')
      AND correction.payload_sha256 = json_extract(pin.value, '$.payload_sha256')
      AND correction.seq = json_extract(pin.value, '$.seq')
    JOIN problems cp ON cp.id = correction.problem_id AND cp.status <> 'private-draft'
      AND correction.seq <= cp.public_seq AND (cp.unlisted = 0 OR cp.id = p.id)
    JOIN event_content cc ON cc.event_id = correction.id
      AND cc.payload_sha256 = correction.payload_sha256 AND cc.redacted_at IS NULL
    WHERE NOT ${eventContentHiddenSql("correction")}
      AND ((correction.object_kind = 'claim' AND json_extract(pin.value,'$.target_ref') =
        correction.object_id || '@' || correction.object_version)
        OR (correction.object_kind <> 'claim' AND json_extract(pin.value,'$.target_ref') =
          correction.object_id))
    ORDER BY pin.key LIMIT 8
  ) visible) AS corrections_json
FROM scope p LEFT JOIN selected i ON i.problem_id = p.id
ORDER BY i.case_id COLLATE BINARY`;

interface PublicNoticeRow {
  problem_id: string;
  unlisted: number;
  case_id: string | null;
  target_ref: string;
  source_event_id: string;
  source_digest: string;
  source_seq: number;
  state: string;
  revision: number;
  opened_at: string;
  updated_at: string;
  corrections_json: string;
}

const PUBLIC_CONTENT_BYTES = 6 * 1024 * 1024;
const PUBLIC_CONTENT_ITEM_BYTES = 512 * 1024;
const PUBLIC_NOTICE_CONTENT_SQL = `
WITH pins AS MATERIALIZED (
  SELECT CAST(pin.key AS INTEGER) AS ordinal,
    json_extract(pin.value,'$.event_id') AS event_id,
    json_extract(pin.value,'$.payload_sha256') AS digest,
    json_extract(pin.value,'$.problem_id') AS problem_id,
    json_extract(pin.value,'$.seq') AS seq
  FROM json_each(?) pin
),
sized AS MATERIALIZED (
  SELECT pin.*, CASE WHEN length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND ${PUBLIC_CONTENT_ITEM_BYTES}
    THEN length(CAST(c.payload_json AS BLOB)) END AS bytes
  FROM pins pin JOIN events e ON e.id = pin.event_id AND e.problem_id = pin.problem_id
    AND e.payload_sha256 = pin.digest AND e.seq = pin.seq
  JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft'
    AND e.seq <= p.public_seq
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    AND c.redacted_at IS NULL
  WHERE NOT ${eventContentHiddenSql("e")}
),
budgeted AS MATERIALIZED (
  SELECT *, SUM(COALESCE(bytes,0)) OVER (ORDER BY ordinal) AS cumulative_bytes FROM sized
)
SELECT b.event_id, b.digest AS payload_sha256,
  CASE WHEN b.bytes IS NOT NULL AND b.cumulative_bytes <= ${PUBLIC_CONTENT_BYTES}
    THEN c.payload_json END AS payload_json,
  CASE WHEN b.bytes IS NOT NULL AND b.cumulative_bytes > ${PUBLIC_CONTENT_BYTES}
    THEN 1 ELSE 0 END AS budget_deferred
FROM budgeted b LEFT JOIN event_content c ON c.event_id = b.event_id
  AND c.payload_sha256 = b.digest AND c.redacted_at IS NULL
  AND b.bytes IS NOT NULL AND b.cumulative_bytes <= ${PUBLIC_CONTENT_BYTES}
ORDER BY b.ordinal`;
interface NoticeContentRow {
  event_id: string;
  payload_sha256: string;
  payload_json: string | null;
  budget_deferred: number;
}

// Only neutral metadata crosses into this face. Hash witnesses are bounded
// before D1 returns bytes. Each case's source and correction witnesses are
// admitted together; any individually valid case fits the six-MiB page budget.
export async function readPublicIntegrityNotices(
  db: D1Database,
  problemReference: string,
  after?: string,
) {
  const read = async () => (await db.prepare(PUBLIC_NOTICE_SQL)
    .bind(problemReference, after ?? "").all<PublicNoticeRow>()).results;
  const rows = await read();
  if (rows.length === 0) throw new IntegrityCaseError("NOT_FOUND");
  if (rows.length > INTEGRITY_CASE_PAGE_LIMIT + 1 ||
    rows.some((row) => row.problem_id !== problemReference || ![0, 1].includes(row.unlisted)))
    throw new Error("INTEGRITY_NOTICES_INVALID");
  const candidates = rows.filter((row) => row.case_id !== null);
  const selected = candidates.slice(0, INTEGRITY_CASE_PAGE_LIMIT);
  const correctionPins = new Map<string, IntegrityPublicationPin[]>();
  const pins = new Map<string, IntegrityPublicationPin>();
  const addPin = (pin: IntegrityPublicationPin) => {
    const previous = pins.get(pin.event_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(pin))
      throw new Error("INTEGRITY_PIN_CONFLICT");
    if (!previous) pins.set(pin.event_id, pin);
  };
  for (const row of selected) {
    addPin(IntegrityPublicationPinSchema.parse({
      problem_id: row.problem_id, target_ref: row.target_ref, event_id: row.source_event_id,
      payload_sha256: row.source_digest, seq: row.source_seq,
    }));
    const corrections = IntegrityPublicationPinSchema.array().max(8)
      .parse(JSON.parse(row.corrections_json));
    correctionPins.set(row.case_id!, corrections);
    for (const pin of corrections) addPin(pin);
  }
  const pinsJson = JSON.stringify([...pins.values()]);
  const readContent = async () => (await db.prepare(PUBLIC_NOTICE_CONTENT_SQL)
    .bind(pinsJson).all<NoticeContentRow>()).results;
  const content = await readContent();
  const byEvent = new Map(content.map((row) => [row.event_id, row]));
  if (content.length > pins.size || byEvent.size !== content.length)
    throw new Error("INTEGRITY_CONTENT_INVALID");
  let bytes = 0;
  const verified = new Set<string>();
  for (const row of content) {
    const pin = pins.get(row.event_id);
    if (!pin || pin.payload_sha256 !== row.payload_sha256 ||
      ![0, 1].includes(row.budget_deferred))
      throw new Error("INTEGRITY_CONTENT_INVALID");
    if (row.payload_json === null) continue;
    const size = new TextEncoder().encode(row.payload_json).length;
    bytes += size;
    if (size > PUBLIC_CONTENT_ITEM_BYTES || bytes > PUBLIC_CONTENT_BYTES || row.budget_deferred !== 0)
      throw new Error("INTEGRITY_CONTENT_BUDGET_INVALID");
    if (await integrityDigest(row.payload_json) === row.payload_sha256) verified.add(row.event_id);
  }
  const notices: PublicIntegrityNotice[] = [];
  let scanned = after ?? null;
  let deferred = false;
  for (const row of selected) {
    const required = [row.source_event_id,
      ...(correctionPins.get(row.case_id!) ?? []).map((pin) => pin.event_id)];
    if (required.some((id) => byEvent.get(id)?.budget_deferred === 1)) {
      deferred = true;
      break;
    }
    scanned = row.case_id;
    if (!verified.has(row.source_event_id)) continue;
    notices.push({
      case_id: row.case_id!,
      source: pins.get(row.source_event_id)!,
      state: row.state as "open" | "resolved",
      opened_at: row.opened_at, updated_at: row.updated_at,
      corrections: (correctionPins.get(row.case_id!) ?? []).filter((pin) => verified.has(pin.event_id)),
    });
  }
  const hasMore = deferred || candidates.length > INTEGRITY_CASE_PAGE_LIMIT;
  if (hasMore && (scanned === null || (after !== undefined && scanned <= after)))
    throw new Error("INTEGRITY_NOTICE_CURSOR_STALLED");
  const face = PublicIntegrityNoticesResponseSchema.parse({
    schema: INTEGRITY_CASES_SCHEMA_ID, problem_id: problemReference, notices,
    has_more: hasMore, next_after: hasMore ? scanned : null,
  });
  if (face.notices.some((notice) => after !== undefined && notice.case_id <= after))
    throw new Error("INTEGRITY_NOTICE_CURSOR_INVALID");
  const snapshot = JSON.stringify(rows), bodySnapshot = JSON.stringify(content);
  return {
    face,
    unlisted: rows[0]!.unlisted === 1,
    async assertCurrent() {
      if (JSON.stringify(await read()) !== snapshot ||
        JSON.stringify(await readContent()) !== bodySnapshot)
        throw new Error("INTEGRITY_NOTICE_CHANGED");
    },
  };
}
