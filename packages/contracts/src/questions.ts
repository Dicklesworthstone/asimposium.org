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

export const QUESTIONS_LIST_DEFAULT_LIMIT = 50;
export const QUESTIONS_LIST_MAX_LIMIT = 200;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const queryCursor = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(cursor);

/** A continuation retains the same scientific snapshot. Exact questions use
 * their identity, never a filtered search of the collection's first page. */
export const QuestionsListQuerySchema = z
  .object({
    through: queryCursor.optional(),
    after: queryCursor.optional(),
    limit: queryCursor.pipe(cursor.min(1).max(QUESTIONS_LIST_MAX_LIMIT)).optional(),
    status: QuestionStatusSchema.optional(),
    target: QuestionIdSchema.refine((value) => !/[\r\n\u2028\u2029]/u.test(value), {
      message: "An exact question target cannot contain a line break.",
    }).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.after !== undefined && (query.through === undefined || query.after > query.through))
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "An after cursor requires the original through cursor and cannot exceed it.",
      });
    if (query.target !== undefined && (query.after !== undefined || query.status !== undefined))
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "An exact target cannot be combined with after or status filters.",
      });
  });
export type QuestionsListQuery = z.output<typeof QuestionsListQuerySchema>;

/** Canonical representation of a public question object (Rule A1 Diptych & Rule A3 Total Attribution). */
export const QuestionItemSchema = z
  .object({
    question_id: QuestionIdSchema,
    problem_id: QuestionProblemIdSchema,
    seq: cursor.min(1),
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
    cursor,
    after: cursor,
    scanned_through: cursor,
    next_after: cursor.min(1).nullable(),
    target: QuestionIdSchema.nullable(),
    status: QuestionStatusSchema.nullable(),
    questions: z.array(QuestionItemSchema).max(QUESTIONS_LIST_MAX_LIMIT),
    omitted: z.array(z.string()),
  })
  .strict()
  .superRefine((face, context) => {
    const reject = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (face.after > face.scanned_through || face.scanned_through > face.cursor)
      reject("scanned_through", "The examined range must remain inside the captured snapshot.");
    if (
      face.next_after !== null &&
      (face.next_after !== face.scanned_through ||
        face.next_after <= face.after ||
        face.next_after >= face.cursor)
    )
      reject("next_after", "A continuation must advance within the captured snapshot.");
    if (face.next_after === null && face.scanned_through !== face.cursor)
      reject("scanned_through", "A completed page must cover the remainder of its snapshot.");
    if (
      face.target !== null &&
      (face.after !== 0 ||
        face.status !== null ||
        face.next_after !== null ||
        face.questions.length !== 1)
    )
      reject("target", "An exact target contains one question without collection filters.");
    const identities = new Set<string>();
    let previous = face.after;
    for (const question of face.questions) {
      if (
        question.problem_id !== face.problem_id ||
        question.seq <= previous ||
        question.seq > face.scanned_through ||
        identities.has(question.question_id) ||
        (face.target !== null && question.question_id !== face.target) ||
        (face.status !== null && question.status !== face.status)
      )
        reject(
          "questions",
          "Unique questions must ascend within the requested problem and filters.",
        );
      identities.add(question.question_id);
      previous = question.seq;
    }
  });

export type QuestionsListResponse = z.infer<typeof QuestionsListResponseSchema>;

export function questionsListPath(
  problem: string,
  format: "json" | "md" | "html" | "human",
  query: QuestionsListQuery = {},
): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.status !== undefined) params.set("status", query.status);
  if (query.target !== undefined) params.set("target", query.target);
  return `/p/${encodeURIComponent(problem)}/questions${format === "human" ? "" : `.${format}`}${params.size === 0 ? "" : `?${params}`}`;
}

export function questionsListMatchesQuery(
  problem: string,
  query: QuestionsListQuery,
  face: QuestionsListResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.after === (query.after ?? 0) &&
    face.target === (query.target ?? null) &&
    face.status === (query.status ?? null) &&
    (query.through === undefined || face.cursor === query.through) &&
    face.questions.length <= (query.limit ?? QUESTIONS_LIST_DEFAULT_LIMIT)
  );
}
