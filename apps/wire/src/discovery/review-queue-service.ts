import {
  ReviewQueueQuerySchema,
  ReviewQueueResponseSchema,
} from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import {
  foldScientificRows,
  prepareScientificDispositions,
} from "../ledger/scientific-disposition";
import type { ReviewQueueSnapshot } from "./review-queue-admissions";
import { readReviewQueue } from "./review-queue-read";

const science = { prepare: prepareScientificDispositions, fold: foldScientificRows };

/** There is one production scientific evaluator, shared with exact claim
 * faces and packs. Neither query parameters nor a caller can replace it. */
export async function loadReviewQueue(
  db: D1Database,
  query: unknown = {},
  snapshot?: ReviewQueueSnapshot,
) {
  const parsed = ReviewQueueQuerySchema.parse(query);
  const response = await readReviewQueue(db, parsed, science, snapshot);
  return ReviewQueueResponseSchema.parse(response);
}

/** Internal snapshot adapter for session packs and next/triage selection.
 * Pagination keeps the enclosing problem cut even across empty pages. Public
 * discovery retains its existing contract; through is not accepted there. */
export async function loadReviewQueueAtCursor(
  db: D1Database,
  problemId: string,
  through: number,
  after?: string,
) {
  const query = ReviewQueueQuerySchema.parse({
    problem: problemId,
    ...(after === undefined ? {} : { after }),
  });
  return ReviewQueueResponseSchema.parse(
    await readReviewQueue(db, query, science, { problemId, through }),
  );
}
