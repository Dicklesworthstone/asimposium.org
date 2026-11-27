import {
  SESSION_SYNTHESIS_DRAFT_DEFAULT_LIMIT,
  SESSION_SYNTHESIS_DRAFT_MAX_LIMIT,
  type SessionSynthesisDraftIndex,
  SessionSynthesisDraftIndexSchema,
  type SessionSynthesisDraftQuery,
  type SessionSynthesisDraftResponse,
  SessionSynthesisDraftResponseSchema,
  type SessionSynthesisPublication,
  SessionSynthesisPublicationSchema,
  SYNTHESES_SCHEMA_ID,
  sessionSynthesisDraftPath,
} from "@asimposium/contracts/syntheses";
import type { D1Database } from "@cloudflare/workers-types";
import { type DraftRow, parseDraftRow } from "../problems/synthesis-drafts.ts";

interface RecoveryScope {
  readonly sessionId: string;
  readonly problemId: string;
  readonly fellowId: string;
}

type PublicationRow = Pick<
  DraftRow,
  "synthesis_id" | "problem_id" | "state" | "published_event_id" | "published_seq" | "published_at"
>;
type DirectoryRow = PublicationRow &
  Pick<DraftRow, "covers_through" | "dropped_single_author_count" | "session_id" | "created_at"> & {
    readonly anchors_count: number;
  };

const ownScope = `d.problem_id = ?1 AND d.author_fellow_id = ?2
  AND NOT EXISTS (SELECT 1 FROM private_draft_erasures erased WHERE erased.problem_id = d.problem_id)`;

/** Metadata only: no synthesis body, assertion text, omission text or policy text. */
export const SYNTHESIS_DRAFT_DIRECTORY_SQL = `SELECT d.synthesis_id, d.problem_id, d.state,
  d.covers_through, json_array_length(d.anchors_json) AS anchors_count,
  d.dropped_single_author_count, d.session_id, d.created_at,
  d.published_event_id, d.published_seq, d.published_at
  FROM synthesis_drafts d WHERE ${ownScope}
    AND (?3 IS NULL OR d.synthesis_id COLLATE BINARY > ?3)
    AND (?4 IS NULL OR d.state = ?4)
  ORDER BY d.synthesis_id COLLATE BINARY LIMIT ?5`;

export const SYNTHESIS_DRAFT_READ_SQL = `SELECT d.* FROM synthesis_drafts d
  WHERE ${ownScope} AND d.synthesis_id = ?3`;

export class SynthesisDraftRecoveryUnavailable extends Error {
  constructor() {
    super("Private synthesis recovery unavailable");
  }
}

function publication(row: PublicationRow): SessionSynthesisPublication | null {
  if (row.state === "draft") {
    if (row.published_event_id !== null || row.published_seq !== null || row.published_at !== null)
      throw new SynthesisDraftRecoveryUnavailable();
    return null;
  }
  return SessionSynthesisPublicationSchema.parse({
    event_id: row.published_event_id,
    sequence: row.published_seq,
    published_at: row.published_at,
    read_url: `/p/${encodeURIComponent(row.problem_id)}/syntheses/${encodeURIComponent(row.synthesis_id)}.json`,
    shared_handoff: { synthesis_id: row.synthesis_id, event_id: row.published_event_id },
  });
}

/** Caller checks current Fellow/session/problem authority before and after these
 * reads. Immutable IDs keep publication or a closed authoring session from
 * moving drafts across pages. Ownership follows the Fellow after a transfer. */
export async function readSynthesisDraftDirectory(
  db: D1Database,
  scope: RecoveryScope,
  query: SessionSynthesisDraftQuery,
): Promise<SessionSynthesisDraftIndex> {
  const limit = query.limit ?? SESSION_SYNTHESIS_DRAFT_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_SYNTHESIS_DRAFT_MAX_LIMIT)
    throw new SynthesisDraftRecoveryUnavailable();
  const read = () =>
    db
      .prepare(SYNTHESIS_DRAFT_DIRECTORY_SQL)
      .bind(scope.problemId, scope.fellowId, query.after ?? null, query.state ?? null, limit + 1)
      .all<DirectoryRow>();
  const rows = await read();
  if (!rows.success || !Array.isArray(rows.results) || rows.results.length > limit + 1)
    throw new SynthesisDraftRecoveryUnavailable();
  const selected = rows.results.slice(0, limit);
  const response = SessionSynthesisDraftIndexSchema.parse({
    schema: SYNTHESES_SCHEMA_ID,
    session_id: scope.sessionId,
    fellow_id: scope.fellowId,
    problem_id: scope.problemId,
    after: query.after ?? null,
    next_after: rows.results.length > limit ? selected.at(-1)?.synthesis_id : null,
    state: query.state ?? null,
    items: selected.map((row) => ({
      synthesis_id: row.synthesis_id,
      state: row.state,
      covers_through: row.covers_through,
      anchors_count: row.anchors_count,
      dropped_single_author_count: row.dropped_single_author_count,
      authored_session_id: row.session_id,
      created_at: row.created_at,
      read_url: sessionSynthesisDraftPath(scope.sessionId, row.synthesis_id),
      publication: publication(row),
    })),
  });
  // Revalidate metadata and lookahead after awaits; erased/reowned or newly
  // published rows must not produce stale private content or continuation.
  const current = await read();
  if (!current.success || JSON.stringify(current.results) !== JSON.stringify(rows.results))
    throw new SynthesisDraftRecoveryUnavailable();
  return response;
}

export async function readSynthesisDraft(
  db: D1Database,
  scope: RecoveryScope,
  synthesisId: string,
): Promise<SessionSynthesisDraftResponse | null> {
  const read = () =>
    db
      .prepare(SYNTHESIS_DRAFT_READ_SQL)
      .bind(scope.problemId, scope.fellowId, synthesisId)
      .first<DraftRow>();
  const row = await read();
  if (row === null) return null;
  const response = SessionSynthesisDraftResponseSchema.parse({
    schema: SYNTHESES_SCHEMA_ID,
    session_id: scope.sessionId,
    fellow_id: scope.fellowId,
    problem_id: scope.problemId,
    draft: parseDraftRow(row),
    read_url: sessionSynthesisDraftPath(scope.sessionId, synthesisId),
    publication: publication(row),
  });
  if (JSON.stringify(await read()) !== JSON.stringify(row))
    throw new SynthesisDraftRecoveryUnavailable();
  return response;
}
