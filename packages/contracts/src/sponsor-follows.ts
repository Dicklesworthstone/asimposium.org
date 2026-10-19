import { z } from "zod";
import { SponsorIdSchema } from "./enrollment.ts";
import { PublicEventEnvelopeSchema } from "./event-tail.ts";
import { ProblemFollowResponseSchema } from "./inbox.ts";
import { ReviewQueueItemSchema } from "./review-queue.ts";
import { ProblemIdSchema } from "./sessions.ts";

export const SPONSOR_FOLLOWS_SCHEMA_ID = "https://a.asimposium.org/schemas/sponsor-follows.v1.json";
export const SPONSOR_FOLLOW_PAGE_SIZE = 5;
export const SPONSOR_FOLLOW_LIMIT = 100;
export const SPONSOR_FOLLOW_EVENT_WINDOW = 40;

export const SponsorFollowRequestSchema = z.object({
  problem_id: ProblemIdSchema,
  following: z.boolean(),
}).strict();
export type SponsorFollowRequest = z.infer<typeof SponsorFollowRequestSchema>;
export const SponsorFollowReceiptSchema = ProblemFollowResponseSchema;
export type SponsorFollowReceipt = z.infer<typeof SponsorFollowReceiptSchema>;

export const SponsorFollowQuerySchema = z.object({
  after: ProblemIdSchema.optional(),
}).strict();
export type SponsorFollowQuery = z.infer<typeof SponsorFollowQuerySchema>;

const CursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SponsorFollowItemSchema = z.object({
  problem_id: ProblemIdSchema,
  followed_at: z.number().int().positive(),
  cursor: CursorSchema.nullable(),
  events: z.array(PublicEventEnvelopeSchema).max(5),
  reviews: z.array(ReviewQueueItemSchema).max(2),
  omitted: z.array(z.string().min(1).max(240)).max(12),
}).strict().superRefine((item, ctx) => {
  if (item.cursor === null && (item.events.length > 0 || item.reviews.length > 0)) {
    ctx.addIssue({ code: "custom", message: "Unavailable activity cannot contain public records." });
  }
  let previous = Number.POSITIVE_INFINITY;
  for (const event of item.events) {
    if (event.problem_id !== item.problem_id || event.event === null ||
        event.body_omitted !== "separate_object_face" || item.cursor === null ||
        event.seq > item.cursor || event.seq >= previous) {
      ctx.addIssue({ code: "custom", message: "Material events must be public, newest-first, and inside this problem cut." });
    }
    previous = event.seq;
  }
  const seen = new Set<string>();
  for (const review of item.reviews) {
    if (review.problem_id !== item.problem_id || review.cursor !== item.cursor ||
        seen.has(review.claim_id) ||
        review.read_url !== `/p/${encodeURIComponent(item.problem_id)}/claims/${review.claim_id}@${review.version}.md?through=${item.cursor}`) {
      ctx.addIssue({ code: "custom", message: "Review needs must use distinct exact claims at this problem cut." });
    }
    seen.add(review.claim_id);
  }
});
export type SponsorFollowItem = z.infer<typeof SponsorFollowItemSchema>;

export const SponsorFollowListResponseSchema = z.object({
  schema: z.literal(SPONSOR_FOLLOWS_SCHEMA_ID),
  sponsor_id: SponsorIdSchema,
  follows: z.array(SponsorFollowItemSchema).max(SPONSOR_FOLLOW_PAGE_SIZE),
  next_after: ProblemIdSchema.nullable(),
}).strict().superRefine((page, ctx) => {
  let previous = "";
  for (const item of page.follows) {
    if (item.problem_id <= previous) ctx.addIssue({ code: "custom", message: "Follow pages must have distinct problem ids in ascending order." });
    previous = item.problem_id;
  }
  if (page.next_after !== null && page.next_after < previous)
    ctx.addIssue({ code: "custom", message: "Follow continuation must not move backwards." });
});
export type SponsorFollowListResponse = z.infer<typeof SponsorFollowListResponseSchema>;

export function generateSponsorFollowsSchema(): string {
  return `${JSON.stringify({
    $id: SPONSOR_FOLLOWS_SCHEMA_ID,
    title: "ASImposium private sponsor follows and public activity",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      request: z.toJSONSchema(SponsorFollowRequestSchema),
      receipt: z.toJSONSchema(SponsorFollowReceiptSchema),
      query: z.toJSONSchema(SponsorFollowQuerySchema),
      response: z.toJSONSchema(SponsorFollowListResponseSchema),
    },
    additionalProperties: false,
  }, null, 2)}\n`;
}
