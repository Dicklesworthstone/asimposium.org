import { z } from "zod";

/**
 * W2.2 / W1.2 Batch write schemas (Fable §7: `POST /v1/p/:id/events:batch`).
 *
 * A batch is a bounded set of causally related writes committed atomically in one
 * transaction. Client-local temporary IDs (`tmp:...`) are resolved server-side.
 */

/** The batch is bounded so one request cannot hold the write transaction open. */
export const MAX_BATCH_MEMBERS = 16;

/** Maximum distinct caused_by parents a single member can have within the batch. */
export const MAX_CAUSED_BY_PER_MEMBER = MAX_BATCH_MEMBERS - 1; // 15

/**
 * Temporary identifier grammar: `tmp:` followed by a valid identifier body.
 * Charset: alphanumeric start, then alphanumeric, dot, underscore, colon, hyphen.
 * Length: 5 to 128 characters total. Excludes control characters, whitespace, backticks, quotes.
 */
export const BATCH_TEMP_ID_PATTERN = /^tmp:[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/;

export const BatchTempIdSchema = z
  .string()
  .min(5, "temporary id must be at least 5 characters (tmp:<id>)")
  .max(128, "temporary id cannot exceed 128 characters")
  .regex(BATCH_TEMP_ID_PATTERN, "temporary id must match tmp:<identifier> format");

export type BatchTempId = z.infer<typeof BatchTempIdSchema>;

export const BatchMemberSchema = z
  .object({
    /** The member's client-local temporary id. */
    tempId: BatchTempIdSchema,
    /** Temp ids this member causally follows (its caused_by parents). */
    causedBy: z
      .array(BatchTempIdSchema)
      .max(
        MAX_CAUSED_BY_PER_MEMBER,
        `caused_by array cannot exceed ${MAX_CAUSED_BY_PER_MEMBER} references`,
      )
      .default([]),
  })
  .strict();

export type BatchMember = z.infer<typeof BatchMemberSchema>;

export const BatchCommitPlanRequestSchema = z
  .object({
    members: z
      .array(BatchMemberSchema)
      .min(1, "a batch must carry at least one member")
      .max(MAX_BATCH_MEMBERS, `a batch cannot exceed ${MAX_BATCH_MEMBERS} members`),
  })
  .strict();

export type BatchCommitPlanRequest = z.infer<typeof BatchCommitPlanRequestSchema>;

export const BATCH_PLAN_REFUSAL_CODES = [
  "BATCH_EMPTY",
  "BATCH_TOO_LARGE",
  "BATCH_INVALID_TEMP_ID",
  "BATCH_DUPLICATE_TEMP_ID",
  "BATCH_SELF_CAUSAL_REF",
  "BATCH_DUPLICATE_CAUSAL_REF",
  "BATCH_DANGLING_CAUSAL_REF",
  "BATCH_CAUSAL_CYCLE",
] as const;

export type BatchPlanRefusalCode = (typeof BATCH_PLAN_REFUSAL_CODES)[number];

export const BatchPlanSuccessSchema = z
  .object({
    ok: z.literal(true),
    commitOrder: z.array(BatchTempIdSchema).min(1).max(MAX_BATCH_MEMBERS),
  })
  .strict();

export type BatchPlanSuccess = z.infer<typeof BatchPlanSuccessSchema>;

export const BatchPlanFailureSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(BATCH_PLAN_REFUSAL_CODES),
    detail: z.string().min(1).max(512),
  })
  .strict();

export type BatchPlanFailure = z.infer<typeof BatchPlanFailureSchema>;

export const BatchPlanSchema = z.discriminatedUnion("ok", [
  BatchPlanSuccessSchema,
  BatchPlanFailureSchema,
]);

export type BatchPlan = z.infer<typeof BatchPlanSchema>;

export const BatchContractsSchema = z
  .object({
    member: BatchMemberSchema,
    plan_request: BatchCommitPlanRequestSchema,
    plan_result: BatchPlanSchema,
  })
  .strict();

export type BatchContracts = z.infer<typeof BatchContractsSchema>;
