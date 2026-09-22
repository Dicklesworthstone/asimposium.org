import {
  EVENT_TAIL_MAX_EVENTS,
  EVENT_TAIL_PROBLEM_PATTERN,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import {
  type EventTailDatabase,
  EventTailReadError,
  readPublicEventTail,
} from "./event-tail-read.ts";

/** Feeds follow the newest bounded window, not the first page of history.
 * Pin the head before choosing the window, then use the canonical tail reader
 * to recheck visibility and account for every sequence at that cut. Appends
 * between the reads belong to the next refresh; privacy changes still win.
 */
export async function readPublicEventFeed(db: EventTailDatabase, problemId: string) {
  if (!EVENT_TAIL_PROBLEM_PATTERN.test(problemId))
    throw new EventTailReadError("CURSOR_INVALID");
  const result = await db
    .prepare(
      `SELECT CASE WHEN typeof(public_seq) = 'integer'
        AND public_seq BETWEEN 0 AND 9007199254740991 THEN public_seq END AS public_seq
       FROM problems WHERE id = ? AND status != 'private-draft'`,
    )
    .bind(problemId)
    .all<{ public_seq: number | null }>();
  const head = result.results[0];
  if (head === undefined) return null;
  if (
    result.results.length !== 1 ||
    head.public_seq === null ||
    !Number.isSafeInteger(head.public_seq) ||
    head.public_seq < 0
  )
    throw new EventTailReadError("EVENT_TAIL_UNAVAILABLE");

  return readPublicEventTail(db, problemId, {
    since: Math.max(0, head.public_seq - EVENT_TAIL_MAX_EVENTS),
    through: head.public_seq,
    limit: EVENT_TAIL_MAX_EVENTS,
  });
}
