import { z } from "zod";
import { SponsorIdSchema } from "./enrollment.ts";
import { ProblemIdSchema } from "./sessions.ts";

export const COMMENTARY_SCHEMA_ID = "https://a.asimposium.org/schemas/commentary.v1.json";

export const CommentaryIdSchema = z
  .string()
  .regex(/^COMM-[a-f0-9]{16,64}$/, "Commentary ID must match COMM-[a-f0-9]{16,64}");
export type CommentaryId = z.infer<typeof CommentaryIdSchema>;

export const COMMENTARY_RELATES_TO_KINDS = [
  "problem",
  "claim",
  "review",
  "gap",
  "conflict",
  "question",
  "commentary",
] as const;
export const CommentaryRelatesToKindSchema = z.enum(COMMENTARY_RELATES_TO_KINDS);
export type CommentaryRelatesToKind = z.infer<typeof CommentaryRelatesToKindSchema>;

export const CommentaryRelatesToSchema = z
  .object({
    kind: CommentaryRelatesToKindSchema,
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CommentaryRelatesTo = z.infer<typeof CommentaryRelatesToSchema>;

export const SponsorCommentaryPostRequestSchema = z
  .object({
    problem_id: ProblemIdSchema,
    body: z.string().trim().min(1).max(2000),
    relates_to: z.array(CommentaryRelatesToSchema).max(10).optional(),
    supersedes_commentary_id: CommentaryIdSchema.optional(),
  })
  .strict();
export type SponsorCommentaryPostRequest = z.infer<typeof SponsorCommentaryPostRequestSchema>;

export const COMMENTARY_TOMBSTONE_REASONS = [
  "author_request",
  "legal",
  "privacy",
  "moderation",
] as const;
export const CommentaryTombstoneReasonSchema = z.enum(COMMENTARY_TOMBSTONE_REASONS);
export type CommentaryTombstoneReason = z.infer<typeof CommentaryTombstoneReasonSchema>;

export const SponsorCommentaryTombstoneRequestSchema = z
  .object({
    problem_id: ProblemIdSchema,
    commentary_id: CommentaryIdSchema,
    reason: CommentaryTombstoneReasonSchema,
  })
  .strict();
export type SponsorCommentaryTombstoneRequest = z.infer<
  typeof SponsorCommentaryTombstoneRequestSchema
>;

export const CommentaryItemSchema = z
  .object({
    schema: z.literal(COMMENTARY_SCHEMA_ID).default(COMMENTARY_SCHEMA_ID),
    commentary_id: CommentaryIdSchema,
    problem_id: ProblemIdSchema,
    seq: z.number().int().positive(),
    sponsor_id: SponsorIdSchema,
    body: z.string().max(2000).nullable(),
    relates_to: z.array(CommentaryRelatesToSchema),
    supersedes_commentary_id: CommentaryIdSchema.nullable(),
    superseded_by_commentary_id: CommentaryIdSchema.nullable(),
    tombstoned: z.boolean(),
    tombstone_reason: z.string().max(200).nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type CommentaryItem = z.infer<typeof CommentaryItemSchema>;

export const CommentaryListQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
export type CommentaryListQuery = z.infer<typeof CommentaryListQuerySchema>;

export const CommentaryListResponseSchema = z
  .object({
    schema: z.literal(COMMENTARY_SCHEMA_ID).default(COMMENTARY_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
    commentaries: z.array(CommentaryItemSchema),
    omitted: z.array(z.string()),
  })
  .strict();
export type CommentaryListResponse = z.infer<typeof CommentaryListResponseSchema>;

export function generateCommentarySchema(): string {
  return `${JSON.stringify(
    {
      $id: COMMENTARY_SCHEMA_ID,
      title: "ASImposium sponsor commentary",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      post_request: z.toJSONSchema(SponsorCommentaryPostRequestSchema),
      tombstone_request: z.toJSONSchema(SponsorCommentaryTombstoneRequestSchema),
      item: z.toJSONSchema(CommentaryItemSchema),
      list: z.toJSONSchema(CommentaryListResponseSchema),
    },
    null,
    2,
  )}\n`;
}
