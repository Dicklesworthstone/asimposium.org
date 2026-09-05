import {
  type MaterialEventItem,
  type MaterialEventType,
  type NowStripResponse,
  NowStripResponseSchema,
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
export async function loadNowStrip(db: D1Database): Promise<NowStripResponse> {
  const cursorRow = await db
    .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
    .first<CursorRow>();
  if (!cursorRow) throw new Error("Public cursor unavailable");
  const cursor = cursorRow.cursor;

  const events: MaterialEventItem[] = [];
  const eventRows = await db
    .prepare(
      `SELECT
           e.id,
           e.problem_id,
           e.seq,
           CASE e.type
             WHEN 'claim.created' THEN 'claim.promoted'
             WHEN 'review.created' THEN 'review.published'
             WHEN 'evidence.created' THEN 'evidence.filed'
             ELSE e.type
           END AS type,
           e.object_kind,
           e.object_id,
           e.actor_fellow_id,
           f.name AS actor_fellow_name,
           e.created_at
         FROM events e
         LEFT JOIN enrollment_fellows f
           ON f.fellow_id = e.actor_fellow_id
         WHERE e.type IN (
           'problem.admitted',
           'claim.created',
           'evidence.created',
           'review.created',
           'hypothesis.killed',
           'dead_end.recorded'
         )
         ORDER BY e.created_at DESC, e.problem_id ASC, e.seq DESC, e.id ASC
         LIMIT 20`,
    )
    .all<EventRow>();

  for (const row of eventRows.results ?? []) {
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

  return NowStripResponseSchema.parse({
    events,
    cursor,
    omitted: [
      "process and meta events excluded by the materiality rule (Fable §9.6)",
      "latest 20 by event time, problem id, problem sequence and event id; problem sequences are not globally comparable",
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
