import {
  type ProblemDetail,
  ProblemDetailSchema,
  ProblemGovernanceEventSchema,
  SynthesisItemSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  type CitationContentRow,
  PUBLIC_EVENT_CONTENT_MAX_BYTES,
  verifiedCitationContent,
} from "./citation-read-integrity.ts";
import { readSynthesisPage, SynthesisReadError } from "./synthesis-read.ts";

interface ResolutionRow extends CitationContentRow {
  id: string | null;
  object_kind: string | null;
  object_id: string | null;
  object_version: number;
  created_at: string | null;
  actor_sponsor_id: string | null;
  sponsor_authored: number;
}

// Choose the latest resolution before checking its identity or availability.
// A hidden, redacted or malformed latest record cannot resurrect older prose.
const RESOLUTION_SQL = `SELECT
  CASE WHEN length(CAST(e.id AS BLOB)) <= 128 THEN e.id END AS id,
  e.problem_id, e.seq, p.public_seq, e.object_version,
  CASE WHEN length(CAST(e.object_kind AS BLOB)) <= 32 THEN e.object_kind END AS object_kind,
  CASE WHEN length(CAST(e.object_id AS BLOB)) <= 128 THEN e.object_id END AS object_id,
  CASE WHEN length(e.created_at) = 24 THEN e.created_at END AS created_at,
  CASE WHEN length(CAST(e.actor_sponsor_id AS BLOB)) <= 128 THEN e.actor_sponsor_id END AS actor_sponsor_id,
  CASE WHEN e.actor_fellow_id IS NULL AND e.actor_session_id IS NULL THEN 1 ELSE 0 END AS sponsor_authored,
  e.payload_sha256, c.payload_sha256 AS content_sha256, c.redacted_at,
  CASE WHEN length(CAST(c.payload_json AS BLOB)) <= ${PUBLIC_EVENT_CONTENT_MAX_BYTES}
    THEN c.payload_json END AS payload_json
FROM problems p JOIN events e ON e.id = (
  SELECT source.id FROM events source
  WHERE source.problem_id = p.id AND source.type = 'problem.resolved' AND source.seq <= ?
  ORDER BY source.seq DESC LIMIT 1
)
LEFT JOIN event_content c ON c.event_id = e.id
WHERE p.id = ? AND p.status <> 'private-draft' AND ? <= p.public_seq
  AND NOT ${eventContentHiddenSql("e")}`;

/** Public resolution is the admitted ledger record and the exact attributed
 * closing synthesis it names. Mutable problem columns never supply the prose.
 * Current controls apply to both publications even at a historical cursor. */
export async function readPublishedProblemResolution(
  db: D1Database,
  problemId: string,
  through: number,
): Promise<ProblemDetail["resolution"] | undefined> {
  if (
    typeof problemId !== "string" ||
    problemId.length < 1 ||
    problemId.length > 128 ||
    problemId.includes("\0") ||
    !Number.isSafeInteger(through) ||
    through < 0
  )
    return undefined;
  const result = await db
    .prepare(RESOLUTION_SQL)
    .bind(through, problemId, through)
    .all<ResolutionRow>();
  const row = result.results[0];
  if (
    result.results.length !== 1 ||
    row === undefined ||
    row.id === null ||
    row.seq > through ||
    row.object_kind !== "problem" ||
    row.object_id !== problemId ||
    row.sponsor_authored !== 1
  )
    return undefined;
  const payload = await verifiedCitationContent(problemId, row, PUBLIC_EVENT_CONTENT_MAX_BYTES);
  const parsed = ProblemGovernanceEventSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.action !== "resolve" ||
    parsed.data.problem.id !== problemId ||
    parsed.data.problem.current_statement_version !== row.object_version ||
    parsed.data.problem.updated_at !== row.created_at ||
    parsed.data.acting_principal.id !== row.actor_sponsor_id
  )
    return undefined;
  const resolved = parsed.data.problem;
  const closing = resolved.closing_synthesis;
  if (closing.seq >= row.seq) return undefined;
  const page = await readSynthesisPage(
    db,
    problemId,
    { through, synthesisId: closing.synthesis_id },
    (value) => SynthesisItemSchema.safeParse(value).data ?? null,
  ).catch((error: unknown) => {
    if (error instanceof SynthesisReadError) return undefined;
    throw error;
  });
  if (page === undefined) return undefined;
  const item = page.items[0];
  if (
    !page.found ||
    page.omitted.length !== 0 ||
    page.items.length !== 1 ||
    item === undefined ||
    item.source.eventId !== closing.event_id ||
    item.source.payloadDigest !== closing.payload_digest ||
    item.source.seq !== closing.seq ||
    item.synthesis.covers_through !== closing.covers_through ||
    item.synthesis.authoring_principal !== parsed.data.source_fellow_id
  )
    return undefined;
  const declaration = item.synthesis.closing_resolution;
  if (
    declaration === undefined ||
    declaration.result_claim.claim_id !== resolved.result_claim.claim_id ||
    declaration.result_claim.version !== resolved.result_claim.version ||
    declaration.direction !== resolved.resolution_direction ||
    item.synthesis.body_md !== resolved.resolution_summary ||
    JSON.stringify(declaration.no_claim_boundary) !==
      JSON.stringify(resolved.resolution_no_claim_boundary) ||
    !item.synthesis.anchors.some(
      (anchor) =>
        anchor.target_kind === "claim" &&
        anchor.target_id === resolved.result_claim.claim_id &&
        anchor.target_version === resolved.result_claim.version &&
        anchor.target_seq !== undefined &&
        anchor.target_seq <= closing.covers_through,
    )
  )
    return undefined;
  // The two source reads above are separate D1 snapshots. Recheck both exact
  // witnesses together so a hide, redaction or changed retained body between
  // reads cannot publish a copied conclusion from an unavailable source.
  const current = await db
    .prepare(`SELECT 1 AS available FROM problems p
    JOIN events resolution ON resolution.problem_id=p.id AND resolution.id=?
      AND resolution.seq=? AND resolution.payload_sha256=?
      AND resolution.type='problem.resolved' AND resolution.object_kind='problem'
      AND resolution.object_id=p.id AND resolution.object_version=?
      AND resolution.actor_sponsor_id=? AND resolution.actor_fellow_id IS NULL
      AND resolution.actor_session_id IS NULL AND resolution.created_at=?
    JOIN event_content rc ON rc.event_id=resolution.id
      AND rc.payload_sha256=resolution.payload_sha256 AND rc.payload_json=? AND rc.redacted_at IS NULL
    JOIN events synthesis ON synthesis.problem_id=p.id AND synthesis.id=?
      AND synthesis.seq=? AND synthesis.payload_sha256=? AND synthesis.object_id=?
      AND synthesis.type='synthesis.created' AND synthesis.object_kind='synthesis'
      AND synthesis.object_version=1 AND synthesis.actor_fellow_id=?
    JOIN event_content sc ON sc.event_id=synthesis.id
      AND sc.payload_sha256=synthesis.payload_sha256 AND sc.payload_json=? AND sc.redacted_at IS NULL
    WHERE p.id=? AND p.status<>'private-draft' AND p.public_seq>=?
      AND NOT ${eventContentHiddenSql("resolution")}
      AND NOT ${eventContentHiddenSql("synthesis")}
      AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.problem_id=p.id
        AND newer.type='problem.resolved' AND newer.seq>resolution.seq AND newer.seq<=?)
    LIMIT 1`)
    .bind(
      row.id,
      row.seq,
      row.payload_sha256,
      row.object_version,
      row.actor_sponsor_id,
      row.created_at,
      row.payload_json,
      item.source.eventId,
      item.source.seq,
      item.source.payloadDigest,
      closing.synthesis_id,
      item.synthesis.authoring_principal,
      item.source.payloadJson,
      problemId,
      through,
      through,
    )
    .all<{ available: number }>();
  if (current.results.length !== 1 || current.results[0]?.available !== 1) return undefined;
  return ProblemDetailSchema.shape.resolution.safeParse({
    direction: resolved.resolution_direction,
    summary: resolved.resolution_summary,
    no_claim_boundary: resolved.resolution_no_claim_boundary,
    result_claim: resolved.result_claim,
    closing_synthesis: closing,
  }).data;
}
