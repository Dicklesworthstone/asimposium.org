import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  checkedScientificPayload,
  type ScientificContentIdentity,
  ScientificInputError,
  scientificContentGuards,
} from "./scientific-checks.ts";

const SOURCE_BYTES = 512 * 1024;
const REFERENCE =
  /^(C-[0-9]+|E-[A-Za-z0-9][A-Za-z0-9._:-]*|(?:R|REV)-[A-Za-z0-9][A-Za-z0-9._:-]*)(?:@([1-9][0-9]*))?$/;

// Match canonical dependency admission: an author's whole-claim or exact-version
// retraction remains authoritative even if its explanation is later withheld.
// Both callers bind the source event as e and its current public problem as p.
const CLAIM_RETRACTED_SQL = `EXISTS (
  SELECT 1 FROM retractions r
  JOIN events author ON author.problem_id = e.problem_id AND author.object_id = e.object_id
    AND author.object_kind = 'claim' AND author.type = 'claim.created'
    AND author.object_version = 1 AND author.actor_fellow_id = r.author_fellow_id
  WHERE r.problem_id = e.problem_id AND r.seq <= p.public_seq
    AND r.target_object IN (e.object_id, e.object_id || '@' || e.object_version)
)`;

export interface SettlementReference extends ScientificContentIdentity {
  readonly kind: "claim" | "evidence" | "review";
  /** A bare claim is pinned once; future revisions cannot reinterpret a settlement. */
  readonly reference: string;
}

/** Resolve a discharge/answer to an available immutable publication. This is
 * an identity and availability check, never a judgment that its argument is
 * correct. A supplied claim version is exact; a bare claim resolves its head
 * once, without falling back when that head is withheld. The witness must be
 * rechecked by settlementReferenceGuards in the settlement transaction. */
export async function findSettlementReference(
  db: D1Database,
  problemId: string,
  reference: string,
  allowReview = false,
): Promise<SettlementReference | null> {
  if (reference.length > 128) return null;
  const match = REFERENCE.exec(reference);
  if (match === null || match[0] !== reference) return null;
  const id = match[1];
  if (id === undefined) return null;
  const version = match[2] === undefined ? null : Number(match[2]);
  if (version !== null && (!Number.isSafeInteger(version) || version < 1)) return null;
  const kind = id.startsWith("C-") ? "claim" : id.startsWith("E-") ? "evidence" : "review";
  if (
    (kind === "review" && !allowReview) ||
    (kind !== "claim" && version !== null && version !== 1)
  )
    return null;

  // Only code-owned table/column names enter the query. Every locator remains
  // bound, and the projection must point at this exact same-problem event.
  const source =
    kind === "claim"
      ? `SELECT e.*, v.statement AS claim_statement
      FROM claim_versions v JOIN events e ON e.problem_id = v.problem_id
        AND e.object_id = v.claim_id AND e.object_version = v.version
        AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
      WHERE v.problem_id = ?1 AND v.claim_id = ?2
        AND v.version = COALESCE(?3, (SELECT MAX(head.version) FROM claim_versions head
          WHERE head.problem_id = v.problem_id AND head.claim_id = v.claim_id))`
      : `SELECT e.*, NULL AS claim_statement
      FROM ${kind === "evidence" ? "evidence" : "reviews"} x
      JOIN events e ON e.id = x.source_event_id AND e.seq = x.source_seq
        AND e.problem_id = x.problem_id AND e.object_id = x.${kind === "evidence" ? "evidence_id" : "review_id"}
        AND e.object_kind = '${kind}' AND e.type = '${kind}.created'
        AND e.object_version = COALESCE(?3, 1)
      WHERE x.problem_id = ?1 AND x.${kind === "evidence" ? "evidence_id" : "review_id"} = ?2`;
  const rows = await db
    .prepare(`WITH source AS (${source})
    SELECT e.id AS event_id, e.object_version, e.payload_sha256, c.payload_json,
      e.claim_statement
    FROM source e JOIN problems p ON p.id = e.problem_id
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL
    WHERE p.status <> 'private-draft' AND e.seq <= p.public_seq
      AND NOT ${eventContentHiddenSql("e")}
      AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals retired WHERE retired.source_event_id = e.id)
      AND (e.object_kind <> 'claim' OR NOT ${CLAIM_RETRACTED_SQL})
      AND length(CAST(c.payload_json AS BLOB)) <= ${SOURCE_BYTES}
    ORDER BY e.seq LIMIT 2`)
    .bind(problemId, id, version)
    .all<{
      event_id: string;
      object_version: number;
      payload_sha256: string;
      payload_json: string;
      claim_statement: string | null;
    }>();
  if (rows.results.length !== 1) return null;
  const row = rows.results[0];
  if (row === undefined) return null;
  try {
    const payload = await checkedScientificPayload(row);
    if (
      kind === "claim" &&
      (payload.claim_id !== id ||
        payload.statement !== row.claim_statement ||
        (row.object_version > 1 && payload.base_version !== row.object_version - 1))
    )
      return null;
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }
  return {
    eventId: row.event_id,
    payloadDigest: row.payload_sha256,
    payloadJson: row.payload_json,
    problemId,
    kind,
    reference: kind === "claim" ? `${id}@${row.object_version}` : reference,
  };
}

/** Preserve exact source availability and claim-retraction authority inside the
 * same batch as the settlement event, projection, cursor and replay receipt. */
export function settlementReferenceGuards(
  db: D1Database,
  source: SettlementReference,
): D1PreparedStatement[] {
  const guards = scientificContentGuards(db, [source]);
  if (source.kind === "claim") {
    guards.push(
      db
        .prepare(`SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
        WHERE e.id = ? AND ${CLAIM_RETRACTED_SQL}
      ) THEN 1 ELSE json_extract('[]', '$[SCIENTIFIC_REFERENCE_CHANGED') END`)
        .bind(source.eventId),
    );
  }
  return guards;
}
