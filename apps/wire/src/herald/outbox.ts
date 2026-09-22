import {
  roomCursor,
  roomName,
  roomProblem,
} from "../../../../packages/contracts/src/herald-room-model.ts";

export interface HeraldDatabase {
  prepare(sql: string): {
    bind(...values: (string | number | null)[]): { all<T>(): Promise<{ results: T[] }> };
  };
}
export interface HeraldNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export const HERALD_DELIVERY_LIMITS = { batch: 4, timeoutMs: 5_000, maxBackoffMs: 60_000 } as const;
export const HERALD_HEAD_SQL =
  "SELECT public_seq AS seq FROM problems WHERE id = ? AND status <> 'private-draft'";
export async function publicRoomHead(
  db: HeraldDatabase,
  id: string,
): Promise<{ seq: number } | null> {
  if (!roomProblem(id)) throw new Error("HERALD_ROOM_ID_INVALID");
  const { results } = await db.prepare(HERALD_HEAD_SQL).bind(id).all<{ seq: number }>();
  if (results.length === 0) return null;
  if (results.length !== 1 || !roomCursor(results[0]?.seq))
    throw new Error("HERALD_HEAD_UNAVAILABLE");
  return { seq: results[0].seq };
}
export const HERALD_PENDING_SQL = `SELECT problem_id, generation, attempts FROM herald_room_outbox
  WHERE generation > delivered_generation AND retry_at <= ?
  ORDER BY retry_at, requested_at, problem_id LIMIT ?`;
export const HERALD_ACK_SQL = `UPDATE herald_room_outbox
  SET delivered_generation = ?, retry_at = 0, attempts = 0
  WHERE problem_id = ? AND generation = ? AND delivered_generation < generation
  RETURNING problem_id`;
export const HERALD_RETRY_SQL = `UPDATE herald_room_outbox SET retry_at = ?, attempts = MIN(attempts + 1, 16)
  WHERE problem_id = ? AND generation = ? AND delivered_generation < generation RETURNING problem_id`;
interface Pending {
  problem_id: string;
  generation: number;
  attempts: number;
}

/** A nudge contains only a delivery generation. The room reads D1 for visibility
 * and cursor authority; a queue row can never manufacture an event or its body. */
async function nudge(namespace: HeraldNamespace, row: Pending): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("HERALD_DELIVERY_TIMEOUT"));
      }, HERALD_DELIVERY_LIMITS.timeoutMs);
    });
    const attempt = Promise.resolve().then(async () => {
      const stub = namespace.get(namespace.idFromName(roomName(row.problem_id)));
      const response = await stub.fetch(
        new Request(`https://herald.internal/_herald/${encodeURIComponent(row.problem_id)}/nudge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: row.generation }),
          signal: controller.signal,
        }),
      );
      void response.body?.cancel().catch(() => {});
      if (response.status !== 204) throw new Error("HERALD_DELIVERY_UNAVAILABLE");
    });
    await Promise.race([attempt, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** At-least-once delivery, bounded and reconstructible after process death.
 * Compare-and-swap ACKs cannot erase a newer concurrent commit. Failures get a
 * future retry slot so an unavailable room cannot monopolize the first page. */
export async function deliverHeraldRooms(
  db: HeraldDatabase,
  namespace: HeraldNamespace | undefined,
  clock: () => number = Date.now,
) {
  const report = {
    enabled: namespace !== undefined,
    scanned: 0,
    delivered: 0,
    superseded: 0,
    retry: 0,
  };
  if (namespace === undefined) return report;
  const now = clock();
  if (!roomCursor(now) || !roomCursor(now + HERALD_DELIVERY_LIMITS.maxBackoffMs))
    throw new Error("HERALD_CLOCK_INVALID");
  const { results } = await db
    .prepare(HERALD_PENDING_SQL)
    .bind(now, HERALD_DELIVERY_LIMITS.batch)
    .all<Pending>();
  if (results.length > HERALD_DELIVERY_LIMITS.batch) throw new Error("HERALD_QUEUE_INVALID");
  for (const row of results) {
    if (
      !roomProblem(row.problem_id) ||
      !roomCursor(row.generation) ||
      row.generation < 1 ||
      !roomCursor(row.attempts) ||
      row.attempts > 16
    )
      throw new Error("HERALD_QUEUE_INVALID");
    report.scanned++;
    try {
      await nudge(namespace, row);
      const ack = await db
        .prepare(HERALD_ACK_SQL)
        .bind(row.generation, row.problem_id, row.generation)
        .all();
      if (ack.results.length > 0) report.delivered++;
      else report.superseded++;
    } catch {
      // Backoff begins after the failed attempt, not before a potentially slow
      // network timeout. A backward wall clock cannot rewind the due time.
      const failedAt = Math.max(now, clock());
      if (!roomCursor(failedAt) || !roomCursor(failedAt + HERALD_DELIVERY_LIMITS.maxBackoffMs))
        throw new Error("HERALD_CLOCK_INVALID");
      const retryAt =
        failedAt +
        Math.min(HERALD_DELIVERY_LIMITS.maxBackoffMs, 1000 * 2 ** Math.min(row.attempts, 6));
      await db.prepare(HERALD_RETRY_SQL).bind(retryAt, row.problem_id, row.generation).all();
      report.retry++;
    }
  }
  return report;
}
