import { ReviewQueueQuerySchema, ReviewQueueResponseSchema } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { foldScientificRows, prepareScientificDispositions } from "../ledger/scientific-disposition";
import { readReviewQueue } from "./review-queue-read";

/** There is one production scientific evaluator, shared with exact claim
 * faces and packs. Neither query parameters nor a caller can replace it. */
export async function loadReviewQueue(db: D1Database, query: unknown = {}) {
  const parsed = ReviewQueueQuerySchema.parse(query);
  const response = await readReviewQueue(db, parsed, {
    prepare: prepareScientificDispositions,
    fold: foldScientificRows,
  });
  return ReviewQueueResponseSchema.parse(response);
}
