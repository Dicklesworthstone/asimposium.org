import type { ReviewQueueQuery } from "@asimposium/contracts/review-queue";
import { parseReviewQueueAfter, REVIEW_QUEUE_PAGE_SIZE } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { ReviewAdmission } from "./review-queue-read";
import { REVIEW_QUEUE_DISCOVERY_SQL, REVIEW_QUEUE_SNAPSHOT_SQL } from "./review-queue-sql";

/** A captured problem cursor, supplied by a session/next reader, never a
 * public queue parameter. It must not be inferred from a returned candidate:
 * even a wholly filtered first page needs to retain this same cut. */
export interface ReviewQueueSnapshot {
  readonly problemId: string;
  readonly through: number;
}

export const REVIEW_QUEUE_SNAPSHOT_HEAD_SQL = `SELECT id, public_seq FROM problems
  WHERE id = ? AND unlisted = 0
    AND status NOT IN ('private-draft', 'resolved', 'retired', 'archived')`;

export async function readReviewAdmissions(
  db: D1Database,
  query: ReviewQueueQuery,
  snapshot?: ReviewQueueSnapshot,
): Promise<ReviewAdmission[]> {
  if (snapshot !== undefined && (
    snapshot.problemId !== query.problem || typeof snapshot.problemId !== "string" ||
    /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(snapshot.problemId)?.[0] !== snapshot.problemId ||
    !Number.isSafeInteger(snapshot.through) || snapshot.through < 0
  )) throw new Error("REVIEW_QUEUE_SNAPSHOT_INVALID");

  const after = parseReviewQueueAfter(query.after);
  const bindings = [query.problem ?? null, query.problem ?? null,
    after?.createdAt ?? "", after?.createdAt ?? "", after?.eventId ?? "",
    REVIEW_QUEUE_PAGE_SIZE + 1];
  let rows: unknown;
  if (snapshot === undefined) {
    rows = (await db.prepare(REVIEW_QUEUE_DISCOVERY_SQL).bind(...bindings)
      .all<ReviewAdmission>()).results;
  } else {
    // Capture current privacy and publication boundaries with the admissions.
    // A missing, hidden or future cut is unavailable, not an empty queue.
    const results = await db.batch([
      db.prepare(REVIEW_QUEUE_SNAPSHOT_HEAD_SQL).bind(snapshot.problemId),
      db.prepare(REVIEW_QUEUE_SNAPSHOT_SQL)
        .bind(snapshot.through, snapshot.problemId, snapshot.through, ...bindings),
    ]);
    const heads = results[0]?.results;
    const head = heads?.[0] as { id?: unknown; public_seq?: unknown } | undefined;
    if (results.length !== 2 || !Array.isArray(heads) || heads.length !== 1 ||
        head?.id !== snapshot.problemId || typeof head.public_seq !== "number" ||
        !Number.isSafeInteger(head.public_seq) || head.public_seq < snapshot.through) {
      throw new Error("REVIEW_QUEUE_SNAPSHOT_UNAVAILABLE");
    }
    rows = results[1]?.results;
  }
  if (!Array.isArray(rows) || rows.length > REVIEW_QUEUE_PAGE_SIZE + 1) {
    throw new Error("REVIEW_QUEUE_DISCOVERY_INVALID");
  }
  if (snapshot !== undefined && rows.some(row => row === null || typeof row !== "object" ||
      row.problem_id !== snapshot.problemId || row.cursor !== snapshot.through)) {
    throw new Error("REVIEW_QUEUE_SNAPSHOT_INVALID");
  }
  return rows as ReviewAdmission[];
}
