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
  let cursor = 0;
  try {
    const cursorRow = await db
      .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
      .first<CursorRow>();
    if (cursorRow) cursor = cursorRow.cursor;
  } catch {
    cursor = 0;
  }

  const events: MaterialEventItem[] = [];
  try {
    const eventRows = await db
      .prepare(
        `SELECT
           e.id,
           e.problem_id,
           e.seq,
           e.type,
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
           'claim.promoted',
           'evidence.filed',
           'review.published',
           'hypothesis.killed',
           'dead_end.recorded'
         )
         ORDER BY e.seq DESC
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
  } catch {
    // Events table might be empty
  }

  return NowStripResponseSchema.parse({
    events,
    cursor,
    omitted: [
      "process and meta events excluded by the materiality rule (Fable §9.6)",
      "events beyond the latest 20 in sequence order omitted",
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
