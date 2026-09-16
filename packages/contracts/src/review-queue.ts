import { z } from "zod";
import {
  ClaimDispositionSchema,
  ProblemIndexTimestampSchema,
  PublicLedgerProblemIdSchema,
} from "./ledger.ts";
import {
  parseReviewQueueAfter,
  REVIEW_QUEUE_AFTER_PATTERN,
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_NEEDS,
  REVIEW_QUEUE_PAGE_SIZE,
  REVIEW_QUEUE_SCHEMA_ID,
  REVIEW_QUEUE_TIERS,
} from "./review-queue-model.ts";
import { ClaimIdSchema } from "./sessions.ts";

export * from "./review-queue-model.ts";

export const ReviewQueueQuerySchema = z
  .object({
    problem: PublicLedgerProblemIdSchema.optional(),
    after: z.string().max(153).regex(REVIEW_QUEUE_AFTER_PATTERN).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    try {
      parseReviewQueueAfter(query.after);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "invalid review queue continuation",
      });
    }
  });
export type ReviewQueueQuery = z.infer<typeof ReviewQueueQuerySchema>;

export const ReviewQueueItemSchema = z
  .object({
    problem_id: PublicLedgerProblemIdSchema,
    claim_id: ClaimIdSchema.max(47),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    kind: z.string().min(1).max(64),
    statement: z.string().min(1).max(8192),
    falsifier: z.string().max(8192).nullable(),
    disposition: ClaimDispositionSchema.extract(["open", "disputed", "corroborated", "reduced-to"]),
    need: z.enum(REVIEW_QUEUE_NEEDS),
    best_recorded_tier: z.enum(REVIEW_QUEUE_TIERS),
    direct_dependents: z.number().int().min(0).max(32),
    dependents_capped: z.boolean(),
    author_fellow_id: z.string().min(1).max(128),
    author_sponsor_id: z.string().min(1).max(128),
    created_at: ProblemIndexTimestampSchema,
    read_url: z.string().min(1).max(512),
  })
  .strict();
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueueResponseSchema = z
  .object({
    schema: z.literal(REVIEW_QUEUE_SCHEMA_ID),
    policy: z.literal("review-discovery-v1"),
    problem: PublicLedgerProblemIdSchema.nullable(),
    candidates: z.array(ReviewQueueItemSchema).max(REVIEW_QUEUE_PAGE_SIZE),
    scanned: z.number().int().min(0).max(REVIEW_QUEUE_PAGE_SIZE),
    next_after: z.string().max(153).regex(REVIEW_QUEUE_AFTER_PATTERN).nullable(),
    selection_boundary: z.literal(REVIEW_QUEUE_BOUNDARY),
    omitted: z
      .array(
        z
          .object({
            reason: z.enum([
              "content_unavailable",
              "not_review_ready",
              "scope_budget_exceeded",
              "page_limit",
            ]),
            count: z.number().int().min(1).max(REVIEW_QUEUE_PAGE_SIZE),
          })
          .strict(),
      )
      .max(4),
  })
  .strict()
  .superRefine((face, context) => {
    const seen = new Set<string>();
    for (const [index, item] of face.candidates.entries()) {
      const identity = `${item.problem_id}/${item.claim_id}`;
      const path = `/p/${encodeURIComponent(item.problem_id)}/claims/${item.claim_id}@${item.version}.md?through=${item.cursor}`;
      if (
        seen.has(identity) ||
        (face.problem !== null && face.problem !== item.problem_id) ||
        item.read_url !== path
      ) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index],
          message: "inconsistent review target or canonical link",
        });
      }
      seen.add(identity);
    }
    if (face.candidates.length > face.scanned)
      context.addIssue({ code: "custom", message: "inconsistent scan accounting" });
    try {
      parseReviewQueueAfter(face.next_after ?? undefined);
    } catch {
      context.addIssue({ code: "custom", path: ["next_after"], message: "invalid continuation" });
    }
  });
export type ReviewQueueResponse = z.infer<typeof ReviewQueueResponseSchema>;
export const ReviewQueueContractsSchema = z
  .object({ query: ReviewQueueQuerySchema, response: ReviewQueueResponseSchema })
  .strict();
