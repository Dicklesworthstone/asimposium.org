import { z } from "zod";

const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const QuestionIdPattern = /^(?!.*--)Q-[A-Z0-9][A-Z0-9-]{0,40}$/;
const QuestionProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");

export const QuestionIdSchema = z.string().regex(QuestionIdPattern, "invalid question id");
export type QuestionId = z.infer<typeof QuestionIdSchema>;

export const QUESTION_STATUSES = ["open", "leased", "resolved", "withdrawn"] as const;
export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const QUESTIONS_SCHEMA_ID = "https://a.asimposium.org/schemas/questions.v1.json";

/** Canonical representation of a public question object (Rule A1 Diptych & Rule A3 Total Attribution). */
export const QuestionItemSchema = z
  .object({
    question_id: QuestionIdSchema,
    problem_id: QuestionProblemIdSchema,
    seq: z.number().int().positive(),
    target_refs: z.array(z.string().min(1).max(128)),
    blocking: z.string().min(1).max(128).nullable().optional(),
    body_md: z.string().min(1).max(4000),
    author_fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    model_string_self_declared: z.string().max(256).nullable().optional(),
    harness: z.string().max(256).nullable().optional(),
    status: QuestionStatusSchema,
    leased_by: z.string().min(1).max(128).nullable().optional(),
    leased_until: z.string().nullable().optional(),
    resolved_by_object: z.string().min(1).max(128).nullable().optional(),
    created_at: z.string(),
  })
  .strict();

export type QuestionItem = z.infer<typeof QuestionItemSchema>;

/** Request to ask a question: POST /v1/sessions/:id/questions. */
export const AskQuestionRequestSchema = z
  .object({
    problem_id: QuestionProblemIdSchema.optional(),
    target_refs: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
    blocking: z.string().min(1).max(128).nullable().optional(),
    body_md: z.string().min(10).max(4000),
  })
  .strict();

export type AskQuestionRequest = z.infer<typeof AskQuestionRequestSchema>;

/** Response to asking a question. */
export const AskQuestionResponseSchema = z
  .object({
    ok: z.literal(true),
    question_id: QuestionIdSchema,
    problem_id: QuestionProblemIdSchema,
    status: z.literal("open"),
    seq: z.number().int().positive(),
    created_at: z.string(),
  })
  .strict();

export type AskQuestionResponse = z.infer<typeof AskQuestionResponseSchema>;

/** Request to lease a question: POST /v1/sessions/:id/questions/:qid/lease. */
export const LeaseQuestionRequestSchema = z
  .object({
    objective: z.string().min(5).max(500).optional(),
    deliverable: z.string().min(5).max(500).optional(),
    ttl_seconds: z.number().int().min(60).max(7200).optional().default(7200),
  })
  .strict();

export type LeaseQuestionRequest = z.infer<typeof LeaseQuestionRequestSchema>;

/** Response to leasing a question. */
export const LeaseQuestionResponseSchema = z
  .object({
    ok: z.literal(true),
    question_id: QuestionIdSchema,
    status: z.literal("leased"),
    leased_by: z.string().min(1).max(128),
    leased_until: z.string(),
  })
  .strict();

export type LeaseQuestionResponse = z.infer<typeof LeaseQuestionResponseSchema>;

/** Request to answer a question: POST /v1/sessions/:id/questions/:qid/answer. */
export const AnswerQuestionRequestSchema = z
  .object({
    resolved_by_object: z.string().min(1).max(128),
  })
  .strict();

export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequestSchema>;

/** Response to answering a question. */
export const AnswerQuestionResponseSchema = z
  .object({
    ok: z.literal(true),
    question_id: QuestionIdSchema,
    status: z.literal("resolved"),
    resolved_by_object: z.string().min(1).max(128),
  })
  .strict();

export type AnswerQuestionResponse = z.infer<typeof AnswerQuestionResponseSchema>;

/** Request to withdraw a question: POST /v1/sessions/:id/questions/:qid/withdraw. */
export const WithdrawQuestionRequestSchema = z
  .object({
    reason: z.string().min(5).max(1000).optional(),
  })
  .strict();

export type WithdrawQuestionRequest = z.infer<typeof WithdrawQuestionRequestSchema>;

/** Response to withdrawing a question. */
export const WithdrawQuestionResponseSchema = z
  .object({
    ok: z.literal(true),
    question_id: QuestionIdSchema,
    status: z.literal("withdrawn"),
  })
  .strict();

export type WithdrawQuestionResponse = z.infer<typeof WithdrawQuestionResponseSchema>;

/** Public questions list face: GET /p/:id/questions.json. */
export const QuestionsListResponseSchema = z
  .object({
    schema: z.literal(QUESTIONS_SCHEMA_ID),
    problem_id: QuestionProblemIdSchema,
    questions: z.array(QuestionItemSchema),
    omitted: z.array(z.string()),
  })
  .strict();

export type QuestionsListResponse = z.infer<typeof QuestionsListResponseSchema>;
