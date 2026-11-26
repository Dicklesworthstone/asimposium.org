import { z } from "zod";
import {
  ScientificDigestSchema,
  ScientificEvidenceReferenceSchema,
} from "./scientific-provenance.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";

const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const RetractionIdPattern = /^(?!.*--)R-[A-Z0-9][A-Z0-9-]{0,40}$/;
const RetractionProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");

export const RetractionIdSchema = z.string().regex(RetractionIdPattern, "invalid retraction id");
export type RetractionId = z.infer<typeof RetractionIdSchema>;

export const RETRACTION_KINDS = ["self-corrected", "externally-refuted"] as const;
export const RetractionKindSchema = z.enum(RETRACTION_KINDS);
export type RetractionKind = z.infer<typeof RetractionKindSchema>;

export const RETRACTIONS_SCHEMA_ID = "https://a.asimposium.org/schemas/retractions.v1.json";

export const RETRACTIONS_LIST_DEFAULT_LIMIT = 50;
export const RETRACTIONS_LIST_MAX_LIMIT = 200;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence);

/** A correction permalink selects its immutable publication directly. A
 * collection continuation retains its original public cut and never silently
 * advances past corrections published while the reader traverses it. */
export const RetractionsListQuerySchema = z
  .object({
    through: querySequence.optional(),
    after: querySequence.optional(),
    limit: querySequence.pipe(sequence.min(1).max(RETRACTIONS_LIST_MAX_LIMIT)).optional(),
    target: RetractionIdSchema.refine((value) => !/[\r\n\u2028\u2029]/u.test(value), {
      message: "An exact retraction target must be a single canonical ID.",
    }).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.after !== undefined && (query.through === undefined || query.after > query.through))
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "A continuation requires its original through cursor and cannot exceed it.",
      });
    if (query.target !== undefined && query.after !== undefined)
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "An exact retraction cannot be combined with a collection continuation.",
      });
  });
export type RetractionsListQuery = z.output<typeof RetractionsListQuerySchema>;

/** A concession acknowledges exact counterevidence; it never sets a disposition. */
export const AuthorConcessionSchema = z
  .object({
    target_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    target_digest: ScientificDigestSchema,
    evidence: ScientificEvidenceReferenceSchema,
  })
  .strict();
export type AuthorConcession = z.infer<typeof AuthorConcessionSchema>;
const ConcessionSourceSchema = z
  .object({
    event_id: z.string().min(1).max(160),
    digest: ScientificDigestSchema,
    fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128),
  })
  .strict();
/** Server-resolved immutable authorship and source identities, never client assertions. */
export const AuthorConcessionPublicationSchema = AuthorConcessionSchema.extend({
  claim_source: ConcessionSourceSchema,
  evidence_source: ConcessionSourceSchema,
}).strict();
export type AuthorConcessionPublication = z.infer<typeof AuthorConcessionPublicationSchema>;

/** Canonical representation of a public retraction object (Rule A1 Diptych & Rule A3 Total Attribution, Rule P6). */
export const RetractionItemSchema = z
  .object({
    retraction_id: RetractionIdSchema,
    problem_id: RetractionProblemIdSchema,
    seq: sequence.min(1),
    target_object: z.string().min(1).max(128),
    retraction_kind: RetractionKindSchema,
    reason: z.string().min(10).max(2000),
    concession: AuthorConcessionPublicationSchema.optional(),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
    author_fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    model_string_self_declared: z.string().max(256).nullable().optional(),
    harness: z.string().max(256).nullable().optional(),
    created_at: z.string(),
  })
  .strict();

export type RetractionItem = z.infer<typeof RetractionItemSchema>;

/** Request to retract an object: POST /v1/sessions/:id/retract. */
export const RetractRequestSchema = z
  .object({
    problem_id: RetractionProblemIdSchema.optional(),
    target_object: z.string().min(1).max(128),
    reason: z.string().min(10).max(2000),
    concession: AuthorConcessionSchema.optional(),
  })
  .strict();

export type RetractRequest = z.infer<typeof RetractRequestSchema>;

/** Response to retracting an object. */
export const RetractResponseSchema = z
  .object({
    ok: z.literal(true),
    retraction_id: RetractionIdSchema,
    problem_id: RetractionProblemIdSchema,
    target_object: z.string().min(1).max(128),
    retraction_kind: RetractionKindSchema,
    concession: AuthorConcessionPublicationSchema.optional(),
    seq: z.number().int().positive(),
    created_at: z.string(),
  })
  .strict();

export type RetractResponse = z.infer<typeof RetractResponseSchema>;

/** Public retractions list face: GET /p/:id/retractions.json. */
export const RetractionsListResponseSchema = z
  .object({
    schema: z.literal(RETRACTIONS_SCHEMA_ID),
    problem_id: RetractionProblemIdSchema,
    cursor: sequence,
    after: sequence,
    scanned_through: sequence,
    next_after: sequence.min(1).nullable(),
    target: RetractionIdSchema.nullable(),
    retractions: z.array(RetractionItemSchema).max(RETRACTIONS_LIST_MAX_LIMIT),
    omitted: z.array(z.string()),
  })
  .strict()
  .superRefine((face, context) => {
    const reject = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (face.after > face.scanned_through || face.scanned_through > face.cursor)
      reject("scanned_through", "The examined range must stay inside the captured snapshot.");
    if (
      face.next_after !== null &&
      (face.next_after !== face.scanned_through ||
        face.next_after <= face.after ||
        face.next_after >= face.cursor)
    )
      reject("next_after", "A continuation must advance within the original public cut.");
    if (face.next_after === null && face.scanned_through !== face.cursor)
      reject("scanned_through", "A completed page must cover the remainder of its snapshot.");
    if (face.omitted.includes("page_limit") !== (face.next_after !== null))
      reject("omitted", "page_limit and the continuation must agree.");
    if (new Set(face.omitted).size !== face.omitted.length)
      reject("omitted", "Omission reasons must be unique.");
    if (
      face.target !== null &&
      (face.after !== 0 || face.next_after !== null || face.retractions.length !== 1)
    )
      reject("target", "A successful exact read contains one retraction without a continuation.");
    const ids = new Set<string>();
    let previous = face.after;
    for (const retraction of face.retractions) {
      if (
        retraction.problem_id !== face.problem_id ||
        retraction.seq <= previous ||
        retraction.seq > face.scanned_through ||
        ids.has(retraction.retraction_id) ||
        (face.target !== null && retraction.retraction_id !== face.target)
      )
        reject(
          "retractions",
          "Unique corrections must ascend within the requested problem and cut.",
        );
      ids.add(retraction.retraction_id);
      previous = retraction.seq;
    }
  });

export type RetractionsListResponse = z.infer<typeof RetractionsListResponseSchema>;

export function retractionsListPath(
  problem: string,
  format: "json" | "md" | "html" | "human",
  query: RetractionsListQuery = {},
): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.target !== undefined) params.set("target", query.target);
  return `/p/${encodeURIComponent(problem)}/retractions${format === "human" ? "" : `.${format}`}${params.size === 0 ? "" : `?${params}`}`;
}

export function retractionsListMatchesQuery(
  problem: string,
  query: RetractionsListQuery,
  face: RetractionsListResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.after === (query.after ?? 0) &&
    face.target === (query.target ?? null) &&
    (query.through === undefined || face.cursor === query.through) &&
    face.retractions.length <= (query.limit ?? RETRACTIONS_LIST_DEFAULT_LIMIT)
  );
}
