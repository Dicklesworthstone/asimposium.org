import { WorkshopObjectIdSchema } from "@asimposium/contracts";
import {
  WORKSHOP_DIRECTORY_DEFAULT_LIMIT,
  WORKSHOP_DIRECTORY_MAX_LIMIT,
  WORKSHOP_DIRECTORY_SCHEMA_ID,
  WorkshopDirectoryItemSchema,
  type WorkshopDirectoryQuery,
  type WorkshopDirectoryResponse,
  WorkshopDirectoryResponseSchema,
  workshopDirectoryMatchesQuery,
  workshopRevisionPath,
} from "@asimposium/contracts/workshop-directory";
import type { D1Database } from "@cloudflare/workers-types";
import { workshopRevisionSessionMatchesSql } from "./session-close-workshop.ts";

interface DirectoryPosition {
  readonly workshop_id: string;
  readonly version: number;
  readonly workshop_seq: number;
  readonly state: string;
  readonly source_verified: number;
  readonly type: string | null;
  readonly title: string | null;
  readonly revision_created_at: string | null;
}

interface DirectoryScope {
  readonly sessionId: string;
  readonly problemId: string;
  readonly fellowId: string;
}

const sourceMatches = `r.workshop_id = w.workshop_id AND r.version = w.current_version
  AND r.problem_id = w.problem_id AND r.fellow_id = w.fellow_id
  AND r.type IS w.type AND r.title IS w.title
  AND ${workshopRevisionSessionMatchesSql("w", "r")}`;
const visibleScope = `w.problem_id = ?1 AND w.fellow_id = ?2
  AND NOT EXISTS (SELECT 1 FROM private_draft_erasures erased WHERE erased.problem_id = w.problem_id)`;

/** The returned columns contain no draft text or storage keys. The immutable
 * revision supplies title/type only after its identity and authoring context
 * match. Current archive state is separate: automatic archival is operational
 * metadata and need not mint another scientific work-product revision. */
export const WORKSHOP_DIRECTORY_SQL = `SELECT w.workshop_id, w.current_version AS version,
  w.workshop_seq, w.state,
  CASE WHEN ${sourceMatches} THEN 1 ELSE 0 END AS source_verified,
  CASE WHEN ${sourceMatches} THEN r.type ELSE NULL END AS type,
  CASE WHEN ${sourceMatches} THEN r.title ELSE NULL END AS title,
  CASE WHEN ${sourceMatches} THEN r.created_at ELSE NULL END AS revision_created_at
FROM workshop_objects w
LEFT JOIN workshop_revisions r ON r.workshop_id = w.workshop_id AND r.version = w.current_version
WHERE ${visibleScope}
  AND (?3 IS NULL OR w.workshop_id COLLATE BINARY > ?3)
  AND (?4 IS NULL OR w.state = ?4)
ORDER BY w.workshop_id COLLATE BINARY LIMIT ?5`;

export class WorkshopDirectoryUnavailable extends Error {
  constructor() {
    super("Private workshop directory unavailable");
  }
}

/** Caller proves current Fellow/session/problem authority before this read
 * and rechecks it before releasing the private response. No R2 read occurs. */
export async function readWorkshopDirectory(
  db: D1Database,
  scope: DirectoryScope,
  query: WorkshopDirectoryQuery,
): Promise<WorkshopDirectoryResponse> {
  const limit = query.limit ?? WORKSHOP_DIRECTORY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSHOP_DIRECTORY_MAX_LIMIT)
    throw new WorkshopDirectoryUnavailable();
  const result = await db
    .prepare(WORKSHOP_DIRECTORY_SQL)
    .bind(scope.problemId, scope.fellowId, query.after ?? null, query.state ?? null, limit + 1)
    .all<DirectoryPosition>();
  if (!result.success) throw new WorkshopDirectoryUnavailable();
  const found = result.results;
  if (!Array.isArray(found) || found.length > limit + 1) throw new WorkshopDirectoryUnavailable();
  let previous = query.after ?? null;
  for (const position of found) {
    if (
      typeof position.workshop_id !== "string" ||
      position.workshop_id.trim() !== position.workshop_id ||
      !WorkshopObjectIdSchema.safeParse(position.workshop_id).success ||
      (previous !== null && position.workshop_id <= previous)
    )
      throw new WorkshopDirectoryUnavailable();
    previous = position.workshop_id;
  }
  const inspected = found.slice(0, limit);
  const items: WorkshopDirectoryResponse["items"] = [];
  let unavailable = false;
  for (const row of inspected) {
    const parsed =
      row.source_verified === 1
        ? WorkshopDirectoryItemSchema.safeParse({
            workshop_id: row.workshop_id,
            version: row.version,
            workshop_seq: row.workshop_seq,
            state: row.state,
            type: row.type,
            title: row.title,
            revision_created_at: row.revision_created_at,
            read_url: workshopRevisionPath(scope.sessionId, row.workshop_id, row.version),
          })
        : undefined;
    if (parsed?.success) items.push(parsed.data);
    else unavailable = true;
  }
  const scanned = inspected.at(-1)?.workshop_id ?? query.after ?? null;
  const response = WorkshopDirectoryResponseSchema.parse({
    schema: WORKSHOP_DIRECTORY_SCHEMA_ID,
    session_id: scope.sessionId,
    problem_id: scope.problemId,
    fellow_id: scope.fellowId,
    after: query.after ?? null,
    scanned_through: scanned,
    next_after: found.length > limit ? scanned : null,
    state: query.state ?? null,
    items,
    omitted: [
      ...(unavailable ? ["source_unavailable"] : []),
      ...(found.length > limit ? ["page_limit"] : []),
    ],
  });
  if (
    !workshopDirectoryMatchesQuery(
      scope.sessionId,
      scope.problemId,
      scope.fellowId,
      query,
      response,
    )
  )
    throw new WorkshopDirectoryUnavailable();

  // Recheck page and lookahead identities after awaiting storage. A source,
  // ownership, erasure or revision race cannot release formerly valid titles
  // or pagination metadata. A JSON binding keeps this below D1's variable cap.
  if (found.length > 0) {
    const current = await db
      .prepare(`SELECT COUNT(*) AS matched FROM json_each(?3) pin
      JOIN workshop_objects w ON w.workshop_id = json_extract(pin.value, '$.workshop_id')
      LEFT JOIN workshop_revisions r ON r.workshop_id = w.workshop_id AND r.version = w.current_version
      WHERE ${visibleScope}
        AND w.current_version IS json_extract(pin.value, '$.version')
        AND w.workshop_seq IS json_extract(pin.value, '$.workshop_seq')
        AND w.state IS json_extract(pin.value, '$.state')
        AND (CASE WHEN ${sourceMatches} THEN 1 ELSE 0 END) = json_extract(pin.value, '$.source_verified')
        AND (CASE WHEN ${sourceMatches} THEN r.title ELSE NULL END) IS json_extract(pin.value, '$.title')
        AND (CASE WHEN ${sourceMatches} THEN r.type ELSE NULL END) IS json_extract(pin.value, '$.type')
        AND (CASE WHEN ${sourceMatches} THEN r.created_at ELSE NULL END) IS json_extract(pin.value, '$.revision_created_at')`)
      .bind(scope.problemId, scope.fellowId, JSON.stringify(found))
      .first<{ matched: number }>();
    if (current?.matched !== found.length) throw new WorkshopDirectoryUnavailable();
  }
  return response;
}
