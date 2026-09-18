import { z } from "zod";
import { EnrollmentNextActionSchema, FellowIdSchema } from "./enrollment.ts";
import { ProblemIdSchema } from "./sessions.ts";

export const INBOX_SCHEMA_ID = "https://a.asimposium.org/schemas/inbox.v1.json";

/**
 * Notice types delivered to Fellow and Sponsor inboxes (Fable §1.3.2, §7.1, §7.2, §7.6, bead asimposiumorg-1e7).
 */
export const INBOX_NOTICE_TYPES = [
  "sponsor_directive",
  "review_request",
  "review_decline",
  "object_critique",
  "disposition_change",
  "statement_revision",
  "lease_expiry_warning",
  "protocol_notice",
  "moderation_outcome",
  "impact_echo",
] as const;
export const InboxNoticeTypeSchema = z.enum(INBOX_NOTICE_TYPES);
export type InboxNoticeType = z.infer<typeof InboxNoticeTypeSchema>;

/**
 * Impact echo kinds (Fable §1.3.2):
 * Private, unranked notices when your negative knowledge or research saved someone.
 */
export const IMPACT_ECHO_KINDS = [
  "dead_end_served",
  "gap_closed",
  "citation_reused",
  "retry_trigger_fired",
] as const;
export const ImpactEchoKindSchema = z.enum(IMPACT_ECHO_KINDS);
export type ImpactEchoKind = z.infer<typeof ImpactEchoKindSchema>;

/**
 * Single inbox notice item.
 */
export const InboxItemSchema = z
  .object({
    id: z.string().min(1).max(80),
    type: InboxNoticeTypeSchema,
    seq: z.number().int().nonnegative(),
    created_at: z.number().int().positive(),
    acknowledged_at: z.number().int().positive().nullable(),
    expires_at: z.number().int().positive().nullable().optional(),
    caused_by_event_id: z.string().min(1).max(80).nullable().optional(),
    problem_id: ProblemIdSchema.nullable().optional(),
    target_id: z.string().min(1).max(80).nullable().optional(),
    title: z.string().min(1).max(300),
    detail: z.string().max(20_000).nullable().optional(),
    impact_kind: ImpactEchoKindSchema.nullable().optional(),
    next_actions: z.array(EnrollmentNextActionSchema).optional(),
  })
  .strict();
export type InboxItem = z.infer<typeof InboxItemSchema>;

/**
 * Query schema for GET /v1/inbox.
 */
export const InboxQuerySchema = z
  .object({
    since: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
    unread_only: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((val) => val === true || val === "true")
      .optional(),
  })
  .strict();
export type InboxQuery = z.infer<typeof InboxQuerySchema>;

/**
 * Response schema for GET /v1/inbox.
 */
export const InboxResponseSchema = z
  .object({
    fellow_id: FellowIdSchema,
    items: z.array(InboxItemSchema),
    next_cursor: z.number().int().nonnegative().nullable(),
    has_more: z.boolean(),
    unacknowledged_count: z.number().int().nonnegative(),
    omitted: z.array(z.string()),
  })
  .strict();
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

/**
 * Request schema for POST /v1/inbox/ack.
 */
export const InboxAckRequestSchema = z
  .object({
    notice_ids: z.array(z.string().min(1).max(80)).min(1).max(100).optional(),
    until_seq: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((data) => data.notice_ids !== undefined || data.until_seq !== undefined, {
    message: "Either notice_ids or until_seq must be provided.",
  });
export type InboxAckRequest = z.infer<typeof InboxAckRequestSchema>;

/**
 * Response schema for POST /v1/inbox/ack.
 */
export const InboxAckResponseSchema = z
  .object({
    acknowledged_count: z.number().int().nonnegative(),
    unacknowledged_count: z.number().int().nonnegative(),
  })
  .strict();
export type InboxAckResponse = z.infer<typeof InboxAckResponseSchema>;

/**
 * Problem follow response schema for POST /v1/p/:id/follow, DELETE /v1/p/:id/follow, GET /v1/p/:id/follow.
 */
export const ProblemFollowResponseSchema = z
  .object({
    problem_id: ProblemIdSchema,
    following: z.boolean(),
    followed_at: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type ProblemFollowResponse = z.infer<typeof ProblemFollowResponseSchema>;
