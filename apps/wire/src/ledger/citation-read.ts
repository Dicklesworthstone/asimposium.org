import type {
  AssociatedClaimRef,
  AssociatedEvidenceRef,
  CitationItem,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  CITATION_EVENT_MAX_BYTES,
  type CitationContentRow,
  mentionsCitation,
  verifiedCitationContent,
} from "./citation-read-integrity";

export interface CommittedCitationReadOptions {
  readonly limit?: number;
  readonly unanchored?: boolean;
  readonly through?: number;
}

type DecodeCitation = (candidate: unknown) => CitationItem | undefined;

interface CitationEventRow extends CitationContentRow {
  readonly object_id: string;
  readonly object_version: number;
  readonly object_kind: string;
  readonly type: string;
  readonly created_at: string;
  readonly actor_fellow_id: string | null;
  readonly actor_sponsor_id: string | null;
  readonly actor_session_id: string | null;
  readonly model_string_self_declared: string | null;
  readonly harness: string | null;
}

const SCAN_LIMIT = 200;
const MENTION_LIMIT = 20;
const HISTORY_UNAVAILABLE = "Citation history is unavailable within the bounded public read.";

// Both queries in a detail read run in one D1 batch, at one public snapshot.
// Redaction is checked at read time even when an older cursor was requested.
const SCOPE_SQL = `WITH scope AS (
  SELECT id, MIN(public_seq, COALESCE(?, public_seq)) AS public_seq
  FROM problems
  WHERE id = ? AND status <> 'private-draft' AND public_seq IS NOT NULL
)`;

const ENVELOPE_SQL = `e.problem_id, e.seq, s.public_seq,
  e.object_id, e.object_version, e.object_kind, e.type, e.created_at,
  e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
  e.model_string_self_declared, e.harness, e.payload_sha256,
  ec.payload_sha256 AS content_sha256, ec.redacted_at,
  CASE WHEN length(CAST(ec.payload_json AS BLOB)) <= ${CITATION_EVENT_MAX_BYTES}
    THEN ec.payload_json ELSE NULL END AS payload_json`;

const CONTENT_JOIN_SQL = `LEFT JOIN event_content ec
  ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
  AND ec.redacted_at IS NULL`;

/** Select the head before testing availability: never revive an older version. */
export const PUBLIC_CITATION_HEADS_SQL = `${SCOPE_SQL}
SELECT ${ENVELOPE_SQL}
FROM scope s JOIN events e ON e.problem_id = s.id AND e.seq <= s.public_seq
${CONTENT_JOIN_SQL}
WHERE e.object_kind = 'citation' AND e.type IN ('citation.recorded', 'citation.corrected')
  AND NOT EXISTS (
    SELECT 1 FROM events newer
    WHERE newer.problem_id = e.problem_id AND newer.object_id = e.object_id
      AND newer.object_kind = 'citation'
      AND newer.type IN ('citation.recorded', 'citation.corrected')
      AND newer.seq > e.seq AND newer.seq <= s.public_seq
  )
ORDER BY CAST(SUBSTR(e.object_id, 3) AS INTEGER), e.object_id
LIMIT ?`;

export const PUBLIC_CITATION_HISTORY_SQL = `${SCOPE_SQL}
SELECT ${ENVELOPE_SQL}
FROM scope s JOIN events e ON e.problem_id = s.id AND e.seq <= s.public_seq
${CONTENT_JOIN_SQL}
WHERE e.object_kind = 'citation' AND e.type IN ('citation.recorded', 'citation.corrected')
  AND e.object_id = ?
ORDER BY e.object_version ASC, e.seq ASC
LIMIT ?`;

/**
 * The LIKE is only a bounded candidate search. Exact local ID/version matching
 * and SHA-256 verification happen after it. No projection body is returned.
 */
export const PUBLIC_CITATION_MENTIONS_SQL = `${SCOPE_SQL}, candidates AS (
  SELECT ${ENVELOPE_SQL},
    ROW_NUMBER() OVER (PARTITION BY e.object_kind ORDER BY e.seq ASC) AS mention_position
  FROM scope s JOIN events e ON e.problem_id = s.id AND e.seq <= s.public_seq
  ${CONTENT_JOIN_SQL}
  WHERE ((e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised'))
      OR (e.object_kind = 'evidence' AND e.type = 'evidence.created'))
    AND ec.payload_json LIKE ?
    AND NOT EXISTS (
      SELECT 1 FROM events newer
      WHERE newer.problem_id = e.problem_id AND newer.object_id = e.object_id
        AND newer.object_kind = e.object_kind AND newer.seq > e.seq
        AND newer.seq <= s.public_seq
        AND newer.type IN ('claim.created', 'claim.revised', 'evidence.created')
    )
)
SELECT * FROM candidates WHERE mention_position <= ? ORDER BY seq ASC`;

function readBounds(options: CommittedCitationReadOptions): { limit: number; through: number | null } {
  const limit = options.limit ?? 50;
  const through = options.through ?? null;
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > SCAN_LIMIT ||
    (through !== null && (!Number.isSafeInteger(through) || through < 0)) ||
    (options.unanchored !== undefined && typeof options.unanchored !== "boolean")
  ) {
    throw new Error("Invalid citation read bounds.");
  }
  return { limit, through };
}

async function citationFromEvent(
  problemId: string,
  row: CitationEventRow,
  decode: DecodeCitation,
): Promise<CitationItem | undefined> {
  if (
    row.object_kind !== "citation" ||
    !Number.isSafeInteger(row.object_version) || row.object_version < 1 ||
    (row.object_version === 1 ? row.type !== "citation.recorded" : row.type !== "citation.corrected")
  ) {
    return undefined;
  }
  const payload = await verifiedCitationContent(problemId, row);
  if (payload === undefined || payload.citation_id !== row.object_id) return undefined;
  // Named fields only: attribution comes from the event, never from body text
  // or a mutable head projection. Unknown payload properties cannot escape.
  return decode({
    citation_id: row.object_id,
    problem_id: row.problem_id,
    version: row.object_version,
    seq: row.seq,
    title: payload.title,
    authors: payload.authors,
    year: payload.year,
    locator_kind: payload.locator_kind,
    locator: payload.locator,
    canonical_locator: payload.canonical_locator,
    excerpt: payload.excerpt,
    retrieved_at: payload.retrieved_at,
    source_provenance: payload.source_provenance,
    unanchored: payload.unanchored,
    norm_hash: payload.norm_hash,
    author_fellow_id: row.actor_fellow_id,
    sponsor_id: row.actor_sponsor_id ?? undefined,
    session_id: row.actor_session_id ?? undefined,
    declared_model: row.model_string_self_declared ?? undefined,
    harness: row.harness ?? undefined,
    created_at: row.created_at,
  });
}

export async function loadCommittedCitations(
  db: D1Database,
  problemId: string,
  options: CommittedCitationReadOptions,
  decode: DecodeCitation,
): Promise<{ citations: CitationItem[]; omitted: string[] }> {
  const { limit, through } = readBounds(options);
  const result = await db.prepare(PUBLIC_CITATION_HEADS_SQL)
    .bind(through, problemId, SCAN_LIMIT + 1).all<CitationEventRow>();
  const rows = result.results ?? [];
  const citations: CitationItem[] = [];
  const omitted: string[] = [];
  let unavailable = false;
  let filtered = false;
  let overflow = rows.length > SCAN_LIMIT;
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    const item = await citationFromEvent(problemId, row, decode);
    if (item === undefined) {
      unavailable = true;
      continue;
    }
    if (options.unanchored !== undefined && item.unanchored !== options.unanchored) {
      filtered = true;
      continue;
    }
    if (citations.length < limit) citations.push(item);
    else overflow = true;
  }
  if (unavailable) omitted.push("Some citation content is unavailable; retained projections are not used as a fallback.");
  if (filtered) omitted.push("Citations outside the requested unanchored filter are omitted.");
  if (overflow) omitted.push(`The public citation read is bounded to ${limit} returned items and ${SCAN_LIMIT} candidate heads; additional records are omitted.`);
  return { citations, omitted };
}

export async function loadCommittedCitation(
  db: D1Database,
  problemId: string,
  target: string,
  options: { through?: number },
  decode: DecodeCitation,
): Promise<{
  citation: CitationItem;
  versions: CitationItem[];
  associated_claims: AssociatedClaimRef[];
  associated_evidence: AssociatedEvidenceRef[];
} | null> {
  const match = /^(L-[0-9]+)(?:@([1-9][0-9]{0,15}))?$/.exec(target);
  const citationId = match?.[1];
  const requestedVersion = match?.[2] === undefined ? undefined : Number(match[2]);
  if (citationId === undefined || (requestedVersion !== undefined && !Number.isSafeInteger(requestedVersion))) return null;
  const { through } = readBounds(options);
  const results = await db.batch<CitationEventRow>([
    db.prepare(PUBLIC_CITATION_HISTORY_SQL).bind(through, problemId, citationId, SCAN_LIMIT + 1),
    db.prepare(PUBLIC_CITATION_MENTIONS_SQL).bind(through, problemId, `%${citationId}%`, SCAN_LIMIT),
  ]);
  const history = results[0]?.results;
  const mentions = results[1]?.results;
  if (history === undefined || mentions === undefined || history.length > SCAN_LIMIT) {
    throw new Error(HISTORY_UNAVAILABLE);
  }
  if (history.length === 0) return null;
  // Select by the immutable envelope before excluding unavailable content.
  // An unavailable head or requested version must never float to a different one.
  const selected = requestedVersion === undefined
    ? history.at(-1)
    : history.find((row) => row.object_version === requestedVersion);
  if (selected === undefined) return null;
  const versions: CitationItem[] = [];
  let citation: CitationItem | undefined;
  let previousVersion = 0;
  let previousSequence = 0;
  for (const row of history) {
    if (row.object_id !== citationId || row.object_version <= previousVersion || row.seq <= previousSequence) {
      throw new Error(HISTORY_UNAVAILABLE);
    }
    previousVersion = row.object_version;
    previousSequence = row.seq;
    const item = await citationFromEvent(problemId, row, decode);
    if (item !== undefined) {
      versions.push(item);
      if (row === selected) citation = item;
    }
  }
  if (citation === undefined) return null;
  const citationVersion = citation.version;

  const associated_claims: AssociatedClaimRef[] = [];
  const associated_evidence: AssociatedEvidenceRef[] = [];
  for (const row of mentions) {
    const payload = await verifiedCitationContent(problemId, row);
    if (payload === undefined || !Number.isSafeInteger(row.object_version) || row.object_version < 1) continue;
    const includes = (value: unknown) => typeof value === "string" &&
      mentionsCitation(value, citationId, citationVersion, requestedVersion === undefined);
    // The writer commits source provenance as a nested object. Top-level
    // locator lookalikes are not the published evidence source contract.
    const source = payload.source;
    const provenance = typeof source === "object" && source !== null && !Array.isArray(source)
      ? source as Readonly<Record<string, unknown>> : undefined;
    if (row.object_kind === "claim" && associated_claims.length < MENTION_LIMIT && includes(payload.statement)) {
      associated_claims.push({ claim_id: row.object_id, version: row.object_version, statement: payload.statement as string });
    } else if (
      row.object_kind === "evidence" && associated_evidence.length < MENTION_LIMIT &&
      provenance !== undefined && (includes(provenance.locator) || includes(provenance.excerpt)) &&
      typeof payload.direction === "string" && typeof payload.bears_on_id === "string" &&
      typeof payload.computed_class === "string"
    ) {
      associated_evidence.push({ evidence_id: row.object_id, direction: payload.direction,
        bears_on_id: payload.bears_on_id, computed_class: payload.computed_class });
    }
  }
  return { citation, versions, associated_claims, associated_evidence };
}
