import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import {
  type ClaimRelationKindName,
  isClaimRelationKind,
  parseRelationTarget,
  relationObjectId,
  relationPinState,
} from "./relations.ts";

export const CLAIM_RELATION_READ_LIMIT = 20;
export const CLAIM_RELATION_BODY_BYTES = 65_536;
export const CLAIM_RELATION_TOTAL_BYTES = 262_144;

export interface RelationProvenance {
  readonly fellow: string | null;
  readonly sponsor: string | null;
  readonly session: string | null;
  readonly model_self_declared: string | null;
  readonly harness_self_declared: string | null;
}
export interface ReadClaimRelation {
  readonly event: string;
  readonly seq: number;
  readonly kind: ClaimRelationKindName;
  readonly source: string;
  readonly target: string;
  /** Version availability, not an assessment of either claim's truth. */
  readonly pins: "current" | "superseded" | "unavailable";
  readonly status: "asserted" | "disputed" | "unavailable";
  readonly provenance: RelationProvenance;
  readonly dispute?: {
    readonly event: string;
    readonly seq: number;
    readonly reason: string;
    readonly refuting_evidence_id: string | null;
    readonly provenance: RelationProvenance;
  };
}
export interface ClaimRelationsRead {
  readonly relations: ReadClaimRelation[];
  readonly omitted: { reason: string; detail: string }[];
  readonly scopeAvailable: boolean;
}

/** The event log supplies both edges and their lifecycle. The mutable
 * claim_relations table is deliberately absent: missing projections must not
 * erase an edge, and a future dispute must not rewrite an older snapshot.
 * Admission precedes JSON extraction and returned bodies have item/total
 * bounds. A lookahead has no body. Current content controls apply at every cut.
 */
export const CLAIM_RELATIONS_READ_SQL = `
WITH input(j) AS (VALUES (?)),
scope AS MATERIALIZED (
  SELECT p.id, MIN(p.public_seq, json_extract(j, '$.cursor')) AS cut
  FROM problems p, input WHERE p.id = json_extract(j, '$.problem')
    AND p.status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
),
admitted AS MATERIALIZED (
  SELECT e.*, ROW_NUMBER() OVER (ORDER BY e.seq, e.id) AS ordinal
  FROM events e JOIN scope s ON s.id = e.problem_id, input
  WHERE e.object_kind = 'relation' AND e.type = 'relation.asserted' AND e.seq <= s.cut
    AND (json_extract(j, '$.relationSeq') IS NULL OR e.seq = json_extract(j, '$.relationSeq'))
  ORDER BY e.seq, e.id LIMIT ${CLAIM_RELATION_READ_LIMIT + 1}
),
parsed AS MATERIALIZED (
  SELECT a.*, CASE WHEN a.ordinal <= ${CLAIM_RELATION_READ_LIMIT}
    AND c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= ${CLAIM_RELATION_BODY_BYTES}
    THEN CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END
    ELSE '{}' END AS candidate_json
  FROM admitted a LEFT JOIN event_content c ON c.event_id = a.id AND c.payload_sha256 = a.payload_sha256
),
refs AS MATERIALIZED (
  SELECT *, json_extract(candidate_json, '$.source') AS source_ref,
    json_extract(candidate_json, '$.target') AS target_ref
  FROM parsed
),
identities AS MATERIALIZED (
  SELECT *, substr(source_ref, 1, instr(source_ref, '@') - 1) AS source_id,
    CASE WHEN instr(target_ref, '@') > 0 THEN substr(target_ref, 1, instr(target_ref, '@') - 1)
      ELSE target_ref END AS target_id
  FROM refs
),
metadata AS MATERIALIZED (
  SELECT a.*,
    (NOT ${hiddenByContentControlSql("a.problem_id", "a.object_id")}
     AND NOT ${hiddenByContentControlSql("a.problem_id", "'#' || a.seq")}
     AND NOT ${hiddenByContentControlSql("a.problem_id", "a.source_id")}
     AND NOT ${hiddenByContentControlSql("a.problem_id", "a.source_ref")}
     AND NOT ${hiddenByContentControlSql("a.problem_id", "a.target_id")}
     AND NOT ${hiddenByContentControlSql("a.problem_id", "a.target_ref")}) AS visible,
    (SELECT d.id FROM events d WHERE d.problem_id = a.problem_id AND d.object_id = a.object_id
      AND d.object_kind = 'relation' AND d.type = 'relation.disputed'
      AND d.seq > a.seq AND d.seq <= s.cut ORDER BY d.seq, d.id LIMIT 1) AS dispute_id,
    (SELECT COUNT(*) FROM (SELECT e.id FROM events e WHERE e.problem_id = a.problem_id
      AND e.object_id = a.object_id AND e.object_kind = 'relation' AND e.type = 'relation.asserted'
      AND e.seq <= s.cut LIMIT 2)) AS assertion_count,
    (SELECT MAX(e.object_version) FROM events e WHERE e.problem_id = a.problem_id AND e.object_id = a.source_id
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised') AND e.seq <= s.cut) AS source_head,
    (SELECT MAX(e.object_version) FROM events e WHERE e.problem_id = a.problem_id AND e.object_id = a.target_id
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised') AND e.seq <= s.cut) AS target_head,
    EXISTS (SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL WHERE e.problem_id = a.problem_id AND e.object_kind = 'claim'
      AND e.object_id || '@' || e.object_version = a.source_ref AND e.type IN ('claim.created', 'claim.revised')
      AND e.seq < a.seq) AS source_available,
    EXISTS (SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL WHERE e.problem_id = a.problem_id AND e.seq < a.seq
      AND ((e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
        AND e.object_id || '@' || e.object_version = a.target_ref)
        OR (e.object_kind = 'gap' AND e.type = 'gap.filed' AND e.object_id = a.target_ref))) AS target_available
  FROM identities a JOIN scope s ON s.id = a.problem_id
),
sized AS MATERIALIZED (
  SELECT a.*, d.seq AS dispute_seq, d.object_version AS dispute_version, d.payload_sha256 AS dispute_sha256,
    d.actor_fellow_id AS dispute_fellow, d.actor_sponsor_id AS dispute_sponsor,
    d.actor_session_id AS dispute_session, d.model_string_self_declared AS dispute_model,
    d.harness AS dispute_harness,
    EXISTS (SELECT 1 FROM events extra JOIN scope s ON s.id = extra.problem_id
      WHERE extra.problem_id = a.problem_id AND extra.object_id = a.object_id
        AND extra.object_kind = 'relation' AND extra.type = 'relation.disputed'
        AND extra.seq > a.seq AND extra.seq <= s.cut AND extra.id <> a.dispute_id) AS extra_dispute,
    CASE WHEN a.ordinal <= ${CLAIM_RELATION_READ_LIMIT} AND a.visible = 1 AND c.redacted_at IS NULL
      AND length(CAST(c.payload_json AS BLOB)) <= ${CLAIM_RELATION_BODY_BYTES}
      THEN length(CAST(c.payload_json AS BLOB)) END AS assertion_bytes,
    CASE WHEN a.ordinal <= ${CLAIM_RELATION_READ_LIMIT} AND a.visible = 1 AND dc.redacted_at IS NULL
      AND NOT ${hiddenByContentControlSql("a.problem_id", "'#' || d.seq")}
      AND length(CAST(dc.payload_json AS BLOB)) <= ${CLAIM_RELATION_BODY_BYTES}
      THEN length(CAST(dc.payload_json AS BLOB)) END AS dispute_bytes
  FROM metadata a LEFT JOIN events d ON d.id = a.dispute_id
  LEFT JOIN event_content c ON c.event_id = a.id AND c.payload_sha256 = a.payload_sha256
  LEFT JOIN event_content dc ON dc.event_id = d.id AND dc.payload_sha256 = d.payload_sha256
),
budgeted AS MATERIALIZED (
  SELECT *, SUM(COALESCE(assertion_bytes, 0) + COALESCE(dispute_bytes, 0)) OVER (ORDER BY ordinal) AS cumulative_bytes
  FROM sized
)
SELECT s.id AS scope_id, s.cut AS through, b.id AS event_id, b.seq, b.object_id, b.object_version,
  b.ordinal, b.payload_sha256, b.visible, b.assertion_count, b.source_head, b.target_head,
  b.source_available, b.target_available, b.actor_fellow_id AS fellow, b.actor_sponsor_id AS sponsor,
  b.actor_session_id AS session, b.model_string_self_declared AS model, b.harness,
  b.dispute_id, b.dispute_seq, b.dispute_version, b.dispute_sha256, b.dispute_fellow, b.dispute_sponsor,
  b.dispute_session, b.dispute_model, b.dispute_harness, b.extra_dispute,
  CASE WHEN b.assertion_bytes IS NOT NULL
    AND b.cumulative_bytes - COALESCE(b.dispute_bytes, 0) <= ${CLAIM_RELATION_TOTAL_BYTES}
    THEN c.payload_json END AS payload_json,
  CASE WHEN b.dispute_bytes IS NOT NULL AND b.cumulative_bytes <= ${CLAIM_RELATION_TOTAL_BYTES}
    THEN dc.payload_json END AS dispute_json
FROM scope s LEFT JOIN budgeted b ON b.problem_id = s.id
LEFT JOIN event_content c ON c.event_id = b.id AND c.payload_sha256 = b.payload_sha256
  AND b.assertion_bytes IS NOT NULL
  AND b.cumulative_bytes - COALESCE(b.dispute_bytes, 0) <= ${CLAIM_RELATION_TOTAL_BYTES}
LEFT JOIN event_content dc ON dc.event_id = b.dispute_id AND dc.payload_sha256 = b.dispute_sha256
  AND b.dispute_bytes IS NOT NULL AND b.cumulative_bytes <= ${CLAIM_RELATION_TOTAL_BYTES}
ORDER BY b.ordinal`;

interface RelationRow {
  scope_id: string; through: number; event_id: string | null; seq: number; ordinal: number;
  object_id: string; object_version: number; payload_sha256: string; payload_json: string | null;
  visible: number; assertion_count: number; source_head: number | null; target_head: number | null;
  source_available: number; target_available: number;
  fellow: string | null; sponsor: string | null; session: string | null; model: string | null; harness: string | null;
  dispute_id: string | null; dispute_seq: number; dispute_version: number; dispute_sha256: string;
  dispute_json: string | null; extra_dispute: number;
  dispute_fellow: string | null; dispute_sponsor: string | null; dispute_session: string | null;
  dispute_model: string | null; dispute_harness: string | null;
}

async function checkedBody(body: string | null, digest: string): Promise<Record<string, unknown> | null> {
  if (body === null || body.length > CLAIM_RELATION_BODY_BYTES) return null;
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > CLAIM_RELATION_BODY_BYTES) return null;
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== digest) return null;
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function edgePayload(value: Record<string, unknown> | null, objectId: string) {
  if (!value || typeof value.kind !== "string" || !isClaimRelationKind(value.kind) ||
      typeof value.source !== "string" || typeof value.target !== "string" ||
      value.source.length > 128 || value.target.length > 128 || /[\s\x00-\x1f]/u.test(value.source + value.target)) return null;
  const source = parseRelationTarget(value.source), target = parseRelationTarget(value.target);
  if (source?.kind !== "claim" || !source.claimId || !source.version || !target ||
      value.source !== `${source.claimId}@${source.version}` ||
      (target.kind === "claim" && value.target !== `${target.claimId}@${target.version}`) ||
      (value.kind === "addresses-gap" ? target.kind !== "gap" : target.kind !== "claim") ||
      (target.kind === "claim" && source.claimId === target.claimId) ||
      relationObjectId({ sourceClaimId: source.claimId, sourceVersion: source.version,
        kind: value.kind, targetRef: value.target }) !== objectId) return null;
  return { kind: value.kind, source: value.source, target: value.target,
    sourceVersion: source.version, targetVersion: target.version };
}

/** One database snapshot, no projection fallback and no per-edge reads. */
export async function readClaimRelations(
  db: D1Database, problemId: string, cursor: number, options: { readonly relationSeq?: number } = {},
): Promise<ClaimRelationsRead> {
  if (!Number.isSafeInteger(cursor) || cursor < 0 ||
      (options.relationSeq !== undefined && (!Number.isSafeInteger(options.relationSeq) || options.relationSeq < 1)))
    throw new Error("An exact public cursor and positive relation sequence are required.");
  const result = await db.prepare(CLAIM_RELATIONS_READ_SQL)
    .bind(JSON.stringify({ problem: problemId, cursor, relationSeq: options.relationSeq ?? null })).all<RelationRow>();
  const rows = result.results;
  if (!Array.isArray(rows) || rows.length > CLAIM_RELATION_READ_LIMIT + 1 ||
      rows.some((row) => row.scope_id !== problemId || !Number.isSafeInteger(row.through) || row.through < 0 || row.through > cursor))
    throw new Error("The relation snapshot is inconsistent.");
  const output: ClaimRelationsRead = { relations: [], omitted: [], scopeAvailable: rows.length > 0 };
  if (rows.length === 0) {
    output.omitted.push({ reason: "content_unavailable", detail: "typed-relations" });
    return output;
  }
  if (rows.length === 1 && rows[0]!.event_id === null) return output;
  if (rows.length > CLAIM_RELATION_READ_LIMIT)
    output.omitted.push({ reason: "candidate_limit", detail: "typed-relations" });
  let previous = 0, bytes = 0;
  for (const row of rows.slice(0, CLAIM_RELATION_READ_LIMIT)) {
    if (!row.event_id || !Number.isSafeInteger(row.seq) || row.seq <= previous || row.seq > row.through ||
        row.through !== rows[0]!.through || (options.relationSeq !== undefined && row.seq !== options.relationSeq))
      throw new Error("The relation snapshot is inconsistent.");
    previous = row.seq;
    bytes += new TextEncoder().encode(row.payload_json ?? "").length +
      new TextEncoder().encode(row.dispute_json ?? "").length;
    if (bytes > CLAIM_RELATION_TOTAL_BYTES) throw new Error("The relation snapshot exceeds its byte budget.");
    const body = row.visible === 1 && row.object_version === 1 && row.assertion_count === 1
      ? await checkedBody(row.payload_json, row.payload_sha256) : null;
    const edge = edgePayload(body, row.object_id);
    if (!edge) {
      output.omitted.push({ reason: "content_unavailable", detail: `typed-relations:${row.event_id}` });
      continue;
    }
    const pins = row.source_available !== 1 || row.target_available !== 1 ||
      row.source_head === null || !Number.isSafeInteger(row.source_head) || row.source_head < edge.sourceVersion ||
      (edge.targetVersion !== undefined && (row.target_head === null || !Number.isSafeInteger(row.target_head) || row.target_head < edge.targetVersion))
      ? "unavailable" : relationPinState({ sourceVersion: edge.sourceVersion,
        targetRef: edge.target, sourceHead: row.source_head, targetHead: row.target_head ?? undefined });
    let dispute: ReadClaimRelation["dispute"];
    let status: ReadClaimRelation["status"] = "asserted";
    if (row.dispute_id !== null) {
      status = "unavailable";
      const payload = row.extra_dispute === 0 && row.dispute_version === 1 &&
        Number.isSafeInteger(row.dispute_seq) && row.dispute_seq > row.seq && row.dispute_seq <= row.through
        ? await checkedBody(row.dispute_json, row.dispute_sha256) : null;
      if (payload && edgePayload(payload, row.object_id) && typeof payload.disputed_by === "string" &&
          payload.disputed_by.length > 0 && payload.disputed_by === row.dispute_fellow &&
          typeof payload.reason === "string" && payload.reason.trim().length > 0 && payload.reason.length <= 2000 &&
          (payload.refuting_evidence_id === undefined || (typeof payload.refuting_evidence_id === "string" &&
            /^E-[A-Za-z0-9][A-Za-z0-9._:-]*$/.exec(payload.refuting_evidence_id)?.[0] === payload.refuting_evidence_id))) {
        status = "disputed";
        dispute = { event: row.dispute_id, seq: row.dispute_seq, reason: payload.reason,
          refuting_evidence_id: typeof payload.refuting_evidence_id === "string" ? payload.refuting_evidence_id : null,
          provenance: { fellow: row.dispute_fellow, sponsor: row.dispute_sponsor, session: row.dispute_session,
            model_self_declared: row.dispute_model, harness_self_declared: row.dispute_harness } };
      } else output.omitted.push({ reason: "content_unavailable", detail: `typed-relations:${row.event_id}:dispute-state` });
    }
    output.relations.push({ event: row.event_id, seq: row.seq, kind: edge.kind, source: edge.source, target: edge.target,
      pins, status, provenance: { fellow: row.fellow, sponsor: row.sponsor, session: row.session,
        model_self_declared: row.model, harness_self_declared: row.harness }, ...(dispute ? { dispute } : {}) });
  }
  return output;
}
