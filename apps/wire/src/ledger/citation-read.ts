import {
  type AssociatedClaimRef,
  type AssociatedEvidenceRef,
  CITATIONS_LIST_DEFAULT_LIMIT,
  CITATIONS_LIST_MAX_LIMIT,
  type CitationItem,
  type CitationReadQuery,
  CitationReadQuerySchema,
  type CitationsListQuery,
  CitationsListQuerySchema,
  PublicCitationTargetSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";
import {
  CITATION_EVENT_MAX_BYTES,
  type CitationContentRow,
  mentionsCitation,
  verifiedCitationContent,
} from "./citation-read-integrity";

export type CommittedCitationReadOptions = CitationsListQuery;

export class CitationReadError extends Error {
  constructor(readonly code: "CURSOR_INVALID" | "CONTENT_UNAVAILABLE") {
    super(code);
    this.name = "CitationReadError";
  }
}

type DecodeCitation = (candidate: unknown) => CitationItem | undefined;

interface PublicCitationProblem {
  readonly id: string;
  readonly unlisted: number;
}

interface CitationScope extends PublicCitationProblem {
  readonly public_seq: number;
}

export interface CommittedCitationsRead {
  readonly problem: PublicCitationProblem | null;
  readonly cursor: number;
  readonly after: number;
  readonly scanned_through: number;
  readonly next_after: number | null;
  readonly unanchored: boolean | null;
  readonly citations: CitationItem[];
  readonly omitted: string[];
}

export interface CommittedCitationRead {
  readonly problem: PublicCitationProblem;
  readonly cursor: number;
  readonly citation: CitationItem;
  readonly versions: CitationItem[];
  readonly associated_claims: AssociatedClaimRef[];
  readonly associated_evidence: AssociatedEvidenceRef[];
  readonly omitted: string[];
}

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
  readonly screening_provenance_json?: string | null;
  readonly withheld: number;
  readonly version_events: number;
  readonly content_limited: number;
  readonly mention_position?: number;
}

const SCAN_LIMIT = CITATIONS_LIST_MAX_LIMIT;
const MENTION_LIMIT = 20;
const READ_BYTES = 4_194_304;
// The independently selected exact record is always admitted before optional
// history and backlinks. Together these three reads stay within four MiB.
const HISTORY_BYTES = READ_BYTES / 2;
const MENTION_BYTES = READ_BYTES - HISTORY_BYTES - CITATION_EVENT_MAX_BYTES;
const CITATIONS_UNAVAILABLE =
  "Some citation content is unavailable; retained projections are not used as a fallback.";
const HISTORY_UNAVAILABLE = "Some citation versions are unavailable in this public history.";
const MENTIONS_UNAVAILABLE = "Some associated citation mentions are unavailable.";

const PUBLIC_PROBLEM_SQL = `status <> 'private-draft' AND public_seq IS NOT NULL
  AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`;
const PUBLIC_SCOPE_SQL = `SELECT id, unlisted, public_seq FROM problems
  WHERE id = ? AND ${PUBLIC_PROBLEM_SQL}`;

// Scope and source queries run in one D1 batch, at one public snapshot.
// Redaction and moderation are checked at read time, even for an older cursor.
const SCOPE_SQL = `WITH scope AS (
  SELECT id, public_seq, COALESCE(?, public_seq) AS cursor
  FROM problems
  WHERE id = ? AND ${PUBLIC_PROBLEM_SQL}
)`;

const ENVELOPE_SQL = `e.problem_id, e.seq, s.cursor AS public_seq,
  e.object_id, e.object_version, e.object_kind, e.type, e.created_at,
  e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
  e.model_string_self_declared, e.harness, e.payload_sha256,
  screening.provenance_json AS screening_provenance_json,
  ec.payload_sha256 AS content_sha256, ec.redacted_at,
  (ec.redacted_at IS NOT NULL OR ${eventContentHiddenSql("e")}) AS withheld,
  (SELECT COUNT(*) FROM events same_version
    WHERE same_version.problem_id = e.problem_id AND same_version.object_kind = e.object_kind
      AND same_version.object_id = e.object_id AND same_version.object_version = e.object_version
      AND same_version.type = e.type AND same_version.seq <= s.public_seq
      AND same_version.seq <= s.cursor) AS version_events,
  CASE WHEN ec.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}
    AND length(CAST(ec.payload_json AS BLOB)) <= ${CITATION_EVENT_MAX_BYTES}
    THEN ec.payload_json ELSE NULL END AS payload_json`;

const CONTENT_JOIN_SQL = `LEFT JOIN screening_publications screening ON screening.event_id = e.id
  LEFT JOIN event_content ec ON ec.event_id = e.id`;

const SOURCE_COLUMNS = `problem_id, seq, public_seq, object_id, object_version,
  object_kind, type, created_at, actor_fellow_id, actor_sponsor_id, actor_session_id,
  model_string_self_declared, harness, payload_sha256, screening_provenance_json,
  content_sha256, redacted_at, withheld, version_events`;

function budgetedSourcesSql(bytes: number, extraColumns = ""): string {
  return `, budgeted AS (
    SELECT *, SUM(COALESCE(length(CAST(payload_json AS BLOB)), 0))
      OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS content_bytes FROM sources
  )
  SELECT ${SOURCE_COLUMNS}${extraColumns},
    CASE WHEN content_bytes <= ${bytes} THEN payload_json END AS payload_json,
    content_bytes > ${bytes} AS content_limited
  FROM budgeted ORDER BY seq ASC`;
}

/** Select the head before testing availability: never revive an older version. */
export const PUBLIC_CITATION_HEADS_SQL = `${SCOPE_SQL}, sources AS (
SELECT ${ENVELOPE_SQL}
FROM scope s JOIN events e ON e.problem_id = s.id AND e.seq <= s.public_seq AND e.seq <= s.cursor
${CONTENT_JOIN_SQL}
WHERE e.object_kind = 'citation' AND e.type IN ('citation.recorded', 'citation.corrected')
  AND e.seq > ?
  AND NOT EXISTS (
    SELECT 1 FROM events newer
    WHERE newer.problem_id = e.problem_id AND newer.object_id = e.object_id
      AND newer.object_kind = 'citation'
      AND newer.type IN ('citation.recorded', 'citation.corrected')
      AND newer.seq > e.seq AND newer.seq <= s.public_seq AND newer.seq <= s.cursor
  )
ORDER BY e.seq ASC LIMIT ?
)${budgetedSourcesSql(READ_BYTES)}`;

export const PUBLIC_CITATION_HISTORY_SQL = `${SCOPE_SQL}, sources AS (
SELECT ${ENVELOPE_SQL}
FROM scope s JOIN events e ON e.problem_id = s.id AND e.seq <= s.public_seq AND e.seq <= s.cursor
${CONTENT_JOIN_SQL}
WHERE e.object_kind = 'citation' AND e.type IN ('citation.recorded', 'citation.corrected')
  AND e.object_id = ?
ORDER BY e.seq ASC LIMIT ?
)${budgetedSourcesSql(HISTORY_BYTES)}`;

/** Exact selection is independent of the bounded history window. */
const PUBLIC_CITATION_SELECTED_SQL = `${SCOPE_SQL}
SELECT ${ENVELOPE_SQL}, 0 AS content_limited
FROM scope s JOIN events e ON e.problem_id = s.id AND e.seq <= s.public_seq AND e.seq <= s.cursor
${CONTENT_JOIN_SQL}
WHERE e.object_kind = 'citation' AND e.type IN ('citation.recorded', 'citation.corrected')
  AND e.object_id = ? AND (? IS NULL OR e.object_version = ?)
ORDER BY e.seq DESC LIMIT 1`;

/**
 * The LIKE is only a bounded candidate search. Exact local ID/version matching
 * and SHA-256 verification happen after it. No projection body is returned.
 */
export const PUBLIC_CITATION_MENTIONS_SQL = `${SCOPE_SQL}, candidates AS (
  SELECT ${ENVELOPE_SQL},
    ROW_NUMBER() OVER (PARTITION BY e.object_kind ORDER BY e.seq ASC) AS mention_position
  FROM scope s JOIN events e ON e.problem_id = s.id AND e.seq <= s.public_seq AND e.seq <= s.cursor
  ${CONTENT_JOIN_SQL}
  WHERE ((e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised'))
      OR (e.object_kind = 'evidence' AND e.type = 'evidence.created'))
    AND ec.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}
    AND ec.payload_json LIKE ?
    AND NOT EXISTS (
      SELECT 1 FROM events newer
      WHERE newer.problem_id = e.problem_id AND newer.object_id = e.object_id
        AND newer.object_kind = e.object_kind AND newer.seq > e.seq
        AND newer.seq <= s.public_seq AND newer.seq <= s.cursor
        AND newer.type IN ('claim.created', 'claim.revised', 'evidence.created')
    )
), sources AS (
  SELECT * FROM candidates WHERE mention_position <= ?
)${budgetedSourcesSql(MENTION_BYTES, ", mention_position")}`;

function stringOptions(options: CitationReadQuery | CommittedCitationReadOptions) {
  return Object.fromEntries(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

async function readBatch(db: D1Database, statements: D1PreparedStatement[]) {
  try {
    const results = await db.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => !result.success || !Array.isArray(result.results))
    )
      throw new CitationReadError("CONTENT_UNAVAILABLE");
    return results;
  } catch {
    throw new CitationReadError("CONTENT_UNAVAILABLE");
  }
}

function readScope(result: D1Result<unknown> | undefined, problemId: string, through?: number) {
  if (result === undefined || result.results.length > 1)
    throw new CitationReadError("CONTENT_UNAVAILABLE");
  const head = (result.results[0] ?? null) as CitationScope | null;
  if (
    head !== null &&
    (head.id !== problemId ||
      (head.unlisted !== 0 && head.unlisted !== 1) ||
      !Number.isSafeInteger(head.public_seq) ||
      head.public_seq < 0)
  )
    throw new CitationReadError("CONTENT_UNAVAILABLE");
  if (head !== null && through !== undefined && through > head.public_seq)
    throw new CitationReadError("CURSOR_INVALID");
  return {
    problem: head === null ? null : { id: head.id, unlisted: head.unlisted },
    cursor: through ?? head?.public_seq ?? 0,
  };
}

function isOrderedSource(row: CitationEventRow, problemId: string, cursor: number, after = 0) {
  return (
    row.problem_id === problemId &&
    row.public_seq === cursor &&
    Number.isSafeInteger(row.seq) &&
    row.seq > after &&
    row.seq <= cursor &&
    Number.isSafeInteger(row.object_version) &&
    row.object_version > 0 &&
    (row.withheld === 0 || row.withheld === 1) &&
    (row.content_limited === 0 || row.content_limited === 1)
  );
}

function omit(omitted: string[], message: string) {
  if (!omitted.includes(message)) omitted.push(message);
}

async function citationFromEvent(
  problemId: string,
  row: CitationEventRow,
  decode: DecodeCitation,
): Promise<CitationItem | undefined> {
  if (
    row.object_kind !== "citation" ||
    !/^L-[0-9]+$(?![\s\S])/.test(row.object_id) ||
    row.version_events !== 1 ||
    row.withheld === 1 ||
    !Number.isSafeInteger(row.object_version) ||
    row.object_version < 1 ||
    (row.object_version === 1
      ? row.type !== "citation.recorded"
      : row.type !== "citation.corrected")
  ) {
    return undefined;
  }
  const payload = await verifiedCitationContent(problemId, row);
  if (payload === undefined || payload.citation_id !== row.object_id) return undefined;
  // Named fields only: attribution comes from the event, never from body text
  // or a mutable head projection. Unknown payload properties cannot escape.
  const item = decode({
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
  if (item === undefined) return undefined;
  const screeningNotice = publicationScreeningNotice(row.screening_provenance_json);
  return screeningNotice === undefined ? item : { ...item, screening_notice: screeningNotice };
}

export async function loadCommittedCitations(
  db: D1Database,
  problemId: string,
  options: CommittedCitationReadOptions,
  decode: DecodeCitation,
): Promise<CommittedCitationsRead> {
  const parsed = CitationsListQuerySchema.safeParse(stringOptions(options));
  if (!parsed.success) throw new CitationReadError("CURSOR_INVALID");
  const { through, after = 0, unanchored, limit = CITATIONS_LIST_DEFAULT_LIMIT } = parsed.data;
  const [scope, result] = await readBatch(db, [
    db.prepare(PUBLIC_SCOPE_SQL).bind(problemId),
    db.prepare(PUBLIC_CITATION_HEADS_SQL).bind(through ?? null, problemId, after, limit + 1),
  ]);
  const { problem, cursor } = readScope(scope, problemId, through);
  const citations: CitationItem[] = [];
  const omitted: string[] = [];
  const page = {
    problem,
    cursor,
    after,
    scanned_through: cursor,
    next_after: null as number | null,
    unanchored: unanchored ?? null,
    citations,
    omitted,
  };
  if (problem === null) return page;
  const rows = result?.results as CitationEventRow[] | undefined;
  if (rows === undefined || rows.length > limit + 1)
    throw new CitationReadError("CONTENT_UNAVAILABLE");
  let previous = after;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isOrderedSource(row, problemId, cursor, previous) || seen.has(row.object_id))
      throw new CitationReadError("CONTENT_UNAVAILABLE");
    previous = row.seq;
    seen.add(row.object_id);
  }
  const selected = rows.slice(0, limit);
  if (rows.length > limit) {
    const last = selected.at(-1);
    if (last === undefined) throw new CitationReadError("CONTENT_UNAVAILABLE");
    page.scanned_through = last.seq;
    page.next_after = last.seq;
    omitted.push(
      `The public citation page is bounded to ${limit} candidate heads; continue at the same snapshot.`,
    );
  }
  let consumedThrough = after;
  for (const row of selected) {
    if (row.content_limited === 1) {
      if (consumedThrough === after) throw new CitationReadError("CONTENT_UNAVAILABLE");
      page.scanned_through = consumedThrough;
      page.next_after = consumedThrough;
      omitted.push("Citation source-byte budget reached; continue at the same snapshot.");
      break;
    }
    consumedThrough = row.seq;
    const item = await citationFromEvent(problemId, row, decode);
    if (item === undefined) {
      omit(omitted, CITATIONS_UNAVAILABLE);
      continue;
    }
    if (unanchored !== undefined && item.unanchored !== unanchored) {
      omit(omitted, "Citations outside the requested unanchored filter are omitted.");
      continue;
    }
    citations.push(item);
  }
  return page;
}

export async function loadCommittedCitation(
  db: D1Database,
  problemId: string,
  target: string,
  options: CitationReadQuery,
  decode: DecodeCitation,
): Promise<CommittedCitationRead | null> {
  if (!PublicCitationTargetSchema.safeParse(target).success) return null;
  const [citationId, pin] = target.split("@");
  if (citationId === undefined) return null;
  const requestedVersion = pin === undefined ? undefined : Number(pin);
  const parsed = CitationReadQuerySchema.safeParse(stringOptions(options));
  if (!parsed.success) throw new CitationReadError("CURSOR_INVALID");
  const { through } = parsed.data;
  const [scope, exact, historyResult, mentionsResult] = await readBatch(db, [
    db.prepare(PUBLIC_SCOPE_SQL).bind(problemId),
    db
      .prepare(PUBLIC_CITATION_SELECTED_SQL)
      .bind(
        through ?? null,
        problemId,
        citationId,
        requestedVersion ?? null,
        requestedVersion ?? null,
      ),
    db
      .prepare(PUBLIC_CITATION_HISTORY_SQL)
      .bind(through ?? null, problemId, citationId, SCAN_LIMIT + 1),
    db
      .prepare(PUBLIC_CITATION_MENTIONS_SQL)
      .bind(through ?? null, problemId, `%${citationId}%`, SCAN_LIMIT + 1),
  ]);
  const { problem, cursor } = readScope(scope, problemId, through);
  if (problem === null) return null;
  const selectedRows = exact?.results as CitationEventRow[] | undefined;
  const history = historyResult?.results as CitationEventRow[] | undefined;
  const mentions = mentionsResult?.results as CitationEventRow[] | undefined;
  if (
    selectedRows === undefined ||
    selectedRows.length > 1 ||
    history === undefined ||
    history.length > SCAN_LIMIT + 1 ||
    mentions === undefined ||
    mentions.length > 2 * (SCAN_LIMIT + 1)
  )
    throw new CitationReadError("CONTENT_UNAVAILABLE");
  const selected = selectedRows[0];
  if (selected === undefined) return null;
  if (
    !isOrderedSource(selected, problemId, cursor) ||
    selected.object_id !== citationId ||
    (requestedVersion !== undefined && selected.object_version !== requestedVersion)
  )
    throw new CitationReadError("CONTENT_UNAVAILABLE");
  if (selected.withheld === 1) return null;
  const citation = await citationFromEvent(problemId, selected, decode);
  if (citation === undefined) throw new CitationReadError("CONTENT_UNAVAILABLE");
  const omitted: string[] = [];
  if (history.length > SCAN_LIMIT)
    omitted.push(
      `Citation history is bounded to ${SCAN_LIMIT} candidate versions; additional versions remain available by exact version link.`,
    );
  const versions: CitationItem[] = [];
  let previousVersion = 0;
  let previousSequence = 0;
  for (const row of history) {
    if (
      !isOrderedSource(row, problemId, cursor, previousSequence) ||
      row.object_id !== citationId ||
      row.version_events !== 1 ||
      row.object_version <= previousVersion ||
      row.seq <= previousSequence
    ) {
      throw new CitationReadError("CONTENT_UNAVAILABLE");
    }
    previousVersion = row.object_version;
    previousSequence = row.seq;
  }
  for (const row of history.slice(0, SCAN_LIMIT)) {
    if (row.content_limited === 1) {
      omit(
        omitted,
        "Citation history source-byte budget reached; additional versions remain available by exact version link.",
      );
      continue;
    }
    const item = await citationFromEvent(problemId, row, decode);
    if (item === undefined) omit(omitted, HISTORY_UNAVAILABLE);
    else versions.push(item);
  }
  const citationVersion = citation.version;

  const associated_claims: AssociatedClaimRef[] = [];
  const associated_evidence: AssociatedEvidenceRef[] = [];
  previousSequence = 0;
  for (const row of mentions) {
    if (
      !isOrderedSource(row, problemId, cursor, previousSequence) ||
      !Number.isSafeInteger(row.mention_position) ||
      (row.mention_position ?? 0) < 1
    )
      throw new CitationReadError("CONTENT_UNAVAILABLE");
    previousSequence = row.seq;
    if ((row.mention_position ?? 0) > SCAN_LIMIT) {
      omit(
        omitted,
        `Associated citation mentions are bounded to ${SCAN_LIMIT} candidate heads per kind; additional records are omitted.`,
      );
      continue;
    }
    if (row.content_limited === 1) {
      omit(
        omitted,
        "Associated citation mentions reached the source-byte budget; additional records are omitted.",
      );
      continue;
    }
    const payload = await verifiedCitationContent(problemId, row);
    if (
      payload === undefined ||
      row.version_events !== 1 ||
      row.withheld === 1 ||
      !Number.isSafeInteger(row.object_version) ||
      row.object_version < 1
    ) {
      omit(omitted, MENTIONS_UNAVAILABLE);
      continue;
    }
    const includes = (value: unknown) =>
      typeof value === "string" &&
      mentionsCitation(value, citationId, citationVersion, requestedVersion === undefined);
    // The writer commits source provenance as a nested object. Top-level
    // locator lookalikes are not the published evidence source contract.
    const source = payload.source;
    const provenance =
      typeof source === "object" && source !== null && !Array.isArray(source)
        ? (source as Readonly<Record<string, unknown>>)
        : undefined;
    if (row.object_kind === "claim" && includes(payload.statement)) {
      if (associated_claims.length >= MENTION_LIMIT) {
        omit(
          omitted,
          `Associated citation mentions are bounded to ${MENTION_LIMIT} claims and ${MENTION_LIMIT} evidence items; additional records are omitted.`,
        );
        continue;
      }
      const screeningNotice = publicationScreeningNotice(row.screening_provenance_json);
      associated_claims.push({
        claim_id: row.object_id,
        version: row.object_version,
        statement: payload.statement as string,
        ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
      });
    } else if (
      row.object_kind === "evidence" &&
      provenance !== undefined &&
      (includes(provenance.locator) || includes(provenance.excerpt)) &&
      typeof payload.direction === "string" &&
      typeof payload.bears_on_id === "string" &&
      typeof payload.computed_class === "string"
    ) {
      if (associated_evidence.length >= MENTION_LIMIT) {
        omit(
          omitted,
          `Associated citation mentions are bounded to ${MENTION_LIMIT} claims and ${MENTION_LIMIT} evidence items; additional records are omitted.`,
        );
        continue;
      }
      const screeningNotice = publicationScreeningNotice(row.screening_provenance_json);
      associated_evidence.push({
        evidence_id: row.object_id,
        direction: payload.direction,
        bears_on_id: payload.bears_on_id,
        computed_class: payload.computed_class,
        ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
      });
    }
  }
  return { problem, cursor, citation, versions, associated_claims, associated_evidence, omitted };
}
