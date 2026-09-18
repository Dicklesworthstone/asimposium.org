import {
  encodeNowPageCursor,
  type MaterialEventItem,
  type MaterialEventType,
  type NowStripQuery,
  type NowStripResponse,
  NowStripResponseSchema,
  parseNowPageCursor,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

interface EventRow {
  id: string;
  problem_id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string;
  actor_fellow_id: string | null;
  actor_fellow_name: string | null;
  created_at: string;
}

interface CursorRow {
  cursor: number;
}

/**
 * Load the Now strip of material events (Fable §8.1 / §9.6 Materiality Rule).
 * Only object-level events are served; process/meta events are omitted.
 */
export async function loadNowStrip(
  db: D1Database,
  query: NowStripQuery = {},
): Promise<NowStripResponse> {
  const boundary = query.before === undefined ? undefined : parseNowPageCursor(query.before);
  if (query.before !== undefined && boundary === undefined) throw new Error("Invalid Now cursor");
  const cursorRow = await db
    .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
    .first<CursorRow>();
  if (!cursorRow) throw new Error("Public cursor unavailable");
  const cursor = cursorRow.cursor;

  const events: MaterialEventItem[] = [];
  let statement = db.prepare(
    `SELECT
           e.id,
           e.problem_id,
           e.seq,
           CASE e.type
             WHEN 'claim.created' THEN 'claim.promoted'
             WHEN 'review.created' THEN 'review.published'
             WHEN 'problem.statement-reviewed' THEN 'review.published'
             WHEN 'evidence.created' THEN 'evidence.filed'
             ELSE e.type
           END AS type,
           e.object_kind,
           e.object_id,
           e.actor_fellow_id,
           f.name AS actor_fellow_name,
           e.created_at
         FROM events e
         JOIN problems p ON p.id = e.problem_id
         LEFT JOIN enrollment_fellows f
           ON f.fellow_id = e.actor_fellow_id
         WHERE p.status != 'private-draft' AND p.unlisted = 0 AND e.seq <= p.public_seq
         ${
           boundary === undefined
             ? ""
             : `AND (
           e.created_at < ?1 OR (e.created_at = ?1 AND (
             e.problem_id > ?2 OR (e.problem_id = ?2 AND (
               e.seq < ?3 OR (e.seq = ?3 AND e.id > ?4)
             ))
           ))
         )`
}
         AND (e.type IN (
           'problem.admitted',
           'claim.created',
           'evidence.created',
           'review.created',
           'hypothesis.killed',
           'dead_end.recorded'
         ) OR (e.type = 'problem.statement-reviewed' AND EXISTS (
           SELECT 1 FROM event_content c WHERE c.event_id = e.id
             AND json_extract(c.payload_json, '$.previous_status') = 'sharpening'
         )))
         ORDER BY e.created_at DESC, e.problem_id ASC, e.seq DESC, e.id ASC
         LIMIT 21`,
  );
  if (boundary !== undefined) statement = statement.bind(...boundary.slice(1));
  const eventRows = await statement.all<EventRow>();
  const rows = eventRows.results ?? [];

  for (const row of rows.slice(0, 20)) {
    const summary = formatMaterialEventSummary(row);
    events.push({
      event_id: row.id,
      problem_id: row.problem_id,
      seq: row.seq,
      type: row.type as MaterialEventType,
      object_kind: row.object_kind,
      object_id: row.object_id,
      summary,
      actor_fellow_id: row.actor_fellow_id,
      actor_fellow_name: row.actor_fellow_name,
      created_at: row.created_at,
    });
  }

  const lastEvent = events.at(-1);
  return NowStripResponseSchema.parse({
    events,
    cursor,
    ...(rows.length > 20 && lastEvent !== undefined
      ? { next_before: encodeNowPageCursor(lastEvent) }
      : {}),
    omitted: [
      "process and meta events excluded by the materiality rule (Fable §9.6)",
      "at most 20 per page by event time descending, problem id ascending, problem sequence descending and event id ascending; problem sequences are not globally comparable",
      "live traversal, not a frozen snapshot; use next_before for older events and restart to discover newly inserted earlier entries; visibility is checked on every page",
      "material types classify ledger claim.created, review.created and evidence.created as promoted, published and filed",
    ],
  });
}

function formatMaterialEventSummary(row: EventRow): string {
  const actor = row.actor_fellow_name || row.actor_fellow_id || "A Fellow";
  switch (row.type) {
    case "claim.promoted":
      return `${actor} promoted claim ${row.object_id} on ${row.problem_id}`;
    case "review.published":
      if (row.object_kind === "problem")
        return `${actor} reviewed the statement of ${row.problem_id}`;
      return `${actor} published review ${row.object_id} on ${row.problem_id}`;
    case "evidence.filed":
      return `${actor} filed evidence for ${row.object_id} on ${row.problem_id}`;
    case "hypothesis.killed":
      return `${actor} killed hypothesis ${row.object_id} on ${row.problem_id}`;
    case "dead_end.recorded":
      return `${actor} recorded checked dead end on ${row.problem_id}`;
    case "problem.admitted":
      return `Problem ${row.problem_id} admitted to public ledger`;
    default:
      return `${actor} recorded material increment on ${row.problem_id}`;
  }
}
