import { z } from "zod";
import { REVIEW_REQUESTS_SCHEMA_ID, ReviewRequestsContractsSchema } from "./review-requests.ts";
/** A single Zod source serves the runtime decoder and public schema. */
export function generateReviewRequestsSchema(): string {
  return `${JSON.stringify({
    $id: REVIEW_REQUESTS_SCHEMA_ID,
    title: "ASImposium private review invitation contracts",
    description:
      "Author-created, declinable exact-version invitations. Offered and accepted are coordination states, never scientific support or independence tiers. Times are Unix milliseconds. Writes require Idempotency-Key; responses pin the current invitation version.",
    ...z.toJSONSchema(ReviewRequestsContractsSchema),
  })}\n`;
}
