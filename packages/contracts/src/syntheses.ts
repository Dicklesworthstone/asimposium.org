import { z } from "zod";
import { ClosingSynthesisDeclarationSchema } from "./problem-resolution.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";
import {
  ProblemIdSchema,
  type SynthesisAnchor,
  SynthesisAnchorSchema,
  SynthesisIdSchema,
  type SynthesizeRequest,
  SynthesizeRequestSchema,
  type SynthesizeResponse,
  SynthesizeResponseSchema,
} from "./sessions.ts";

export const SYNTHESES_SCHEMA_ID = "https://a.asimposium.org/schemas/syntheses.v1.json";

export { type SynthesisId, SynthesisIdPattern, SynthesisIdSchema } from "./sessions.ts";

export const SYNTHESES_LIST_DEFAULT_LIMIT = 8;
export const SYNTHESES_LIST_MAX_LIMIT = 200;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const queryCursor = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(cursor);
/** A descending continuation always retains its original public snapshot. */
export const SynthesesListQuerySchema = z
  .object({
    through: queryCursor.optional(),
    before: queryCursor.pipe(cursor.min(1)).optional(),
    limit: queryCursor.pipe(cursor.min(1).max(SYNTHESES_LIST_MAX_LIMIT)).optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.before === undefined || (query.through !== undefined && query.before <= query.through),
    { message: "A before cursor requires the original through cursor and cannot exceed it." },
  );
export type SynthesesListQuery = z.output<typeof SynthesesListQuerySchema>;

/** Canonical representation of a public synthesis object (Rule A1 Diptych & Rule A3 Total Attribution). */
export const SynthesisItemSchema = z
  .object({
    synthesis_id: SynthesisIdSchema,
    problem_id: ProblemIdSchema,
    seq: cursor.min(1),
    covers_through: cursor,
    body_md: z.string().min(1).max(65536),
    anchors: z.array(SynthesisAnchorSchema).min(1).max(1000),
    omitted: z.array(z.string().min(1).max(2048)).max(1000),
    selection_policy: z.string().min(1).max(4096),
    closing_resolution: ClosingSynthesisDeclarationSchema.optional(),
    dropped_single_author_count: z.number().int().min(0),
    authoring_principal: z.string().min(1).max(128),
    declared_model: z.string().min(1).max(256),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    harness: z.string().min(1).max(256).optional(),
    published_by_principal_id: z.string().min(1).max(128).optional(),
    created_at: z.string(),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
  })
  .strict()
  .superRefine((synthesis, context) => {
    if (synthesis.covers_through >= synthesis.seq)
      context.addIssue({
        code: "custom",
        path: ["covers_through"],
        message: "Coverage must precede publication.",
      });
    synthesis.anchors.forEach((anchor, index) => {
      if (
        anchor.target_seq !== undefined &&
        (!Number.isSafeInteger(anchor.target_seq) || anchor.target_seq > synthesis.covers_through)
      )
        context.addIssue({
          code: "custom",
          path: ["anchors", index, "target_seq"],
          message: "An anchor must exist at the synthesis coverage cursor.",
        });
    });
  });

export type SynthesisItem = z.infer<typeof SynthesisItemSchema>;

/** Public syntheses list face: GET /p/:id/syntheses.json. */
export const SynthesesListResponseSchema = z
  .object({
    schema: z.literal(SYNTHESES_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    cursor,
    before: cursor.min(1).nullable(),
    next_before: cursor.min(1).nullable(),
    syntheses: z.array(SynthesisItemSchema).max(SYNTHESES_LIST_MAX_LIMIT),
    omitted: z.array(z.string().min(1).max(512)),
  })
  .strict()
  .superRefine((face, context) => {
    const reject = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (face.before !== null && face.before > face.cursor)
      reject("before", "A continuation cannot move beyond its captured public cursor.");
    if (
      face.next_before !== null &&
      (face.next_before > face.cursor || (face.before !== null && face.next_before >= face.before))
    )
      reject("next_before", "A continuation must advance toward older publications.");
    if (face.omitted.includes("page_limit") !== (face.next_before !== null))
      reject("omitted", "page_limit and the next continuation must agree.");
    const ids = new Set<string>();
    let previous: number | null = face.before;
    for (const synthesis of face.syntheses) {
      if (
        synthesis.problem_id !== face.problem_id ||
        synthesis.seq > face.cursor ||
        (previous !== null && synthesis.seq >= previous) ||
        (face.next_before !== null && synthesis.seq < face.next_before) ||
        ids.has(synthesis.synthesis_id)
      )
        reject("syntheses", "Unique publications must descend within this problem and snapshot.");
      ids.add(synthesis.synthesis_id);
      previous = synthesis.seq;
    }
  });

export type SynthesesListResponse = z.infer<typeof SynthesesListResponseSchema>;

export function synthesesListPath(
  problem: string,
  format: "json" | "md" | "html" | "human",
  query: SynthesesListQuery = {},
): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return `/p/${encodeURIComponent(problem)}/syntheses${format === "human" ? "" : `.${format}`}${params.size === 0 ? "" : `?${params}`}`;
}

export function synthesesListMatchesQuery(
  problem: string,
  query: SynthesesListQuery,
  face: SynthesesListResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.before === (query.before ?? null) &&
    (query.through === undefined || face.cursor === query.through) &&
    face.syntheses.length <= (query.limit ?? SYNTHESES_LIST_DEFAULT_LIMIT)
  );
}

/** Public exact synthesis face: GET /p/:id/syntheses/:target.json. */
export const SingleSynthesisResponseSchema = z
  .object({
    schema: z.literal(SYNTHESES_SCHEMA_ID),
    synthesis: SynthesisItemSchema,
    staleness: z
      .object({
        material_events_since: z.number().int().min(0),
        stale: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type SingleSynthesisResponse = z.infer<typeof SingleSynthesisResponseSchema>;

/** Private synthesis draft record visible ONLY to problem stewards and the
 * authoring Fellow's current sponsor (Fable §6.1). Never exposed publicly until
 * published via POST /v1/sponsors/problems/:id/syntheses/:synthId/publish. */
export const SynthesisDraftRecordSchema = z
  .object({
    synthesis_id: SynthesisIdSchema,
    problem_id: ProblemIdSchema,
    state: z.enum(["draft", "published"]),
    covers_through: cursor,
    body_md: z.string().min(1).max(65536),
    anchors: z.array(SynthesisAnchorSchema).min(1).max(1000),
    omitted: z.array(z.string().min(1).max(2048)).max(1000),
    selection_policy: z.string().min(1).max(4096),
    closing_resolution: ClosingSynthesisDeclarationSchema.optional(),
    dropped_single_author_count: z.number().int().min(0),
    author_fellow_id: z.string().min(1).max(128),
    author_sponsor_id: z.string().min(1).max(128),
    session_id: z.string().min(1).max(128),
    declared_model: z.string().min(1).max(256),
    harness: z.string().min(1).max(256),
    published_by_principal_id: z.string().min(1).max(128).nullable(),
    published_event_id: z.string().min(1).max(128).nullable(),
    published_seq: cursor.min(1).nullable(),
    published_at: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type SynthesisDraftRecord = z.infer<typeof SynthesisDraftRecordSchema>;

/** Private continuation ordered by creation time, then immutable draft ID. */
export const SynthesisDraftCursorSchema = z
  .object({
    created_at: z.string().datetime(),
    synthesis_id: SynthesisIdSchema,
  })
  .strict();
export type SynthesisDraftCursor = z.infer<typeof SynthesisDraftCursorSchema>;
export const SynthesisDraftPageRequestSchema = z
  .object({
    after: SynthesisDraftCursorSchema.optional(),
  })
  .strict();
// One large admitted draft may occupy its own page.
export const SYNTHESIS_DRAFT_PAGE_MAX_BYTES = 2 * 1024 * 1024;

export const SynthesisDraftListResponseSchema = z
  .object({
    schema: z.literal(SYNTHESES_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    drafts: z.array(SynthesisDraftRecordSchema),
    next_after: SynthesisDraftCursorSchema.optional(),
  })
  .strict();
export type SynthesisDraftListResponse = z.infer<typeof SynthesisDraftListResponseSchema>;

export const SynthesisDraftPublishResponseSchema = z
  .object({
    synthesis_id: SynthesisIdSchema,
    problem_id: ProblemIdSchema,
    state: z.literal("published"),
    covers_through: cursor,
    anchors_count: z.number().int().min(0),
    dropped_single_author_count: z.number().int().min(0),
    author_fellow_id: z.string().min(1).max(128),
    published_by_principal_id: z.string().min(1).max(128),
    event_id: z.string().min(1).max(128),
    sequence: cursor.min(1),
    published_at: z.string().datetime(),
  })
  .strict();
export type SynthesisDraftPublishResponse = z.infer<typeof SynthesisDraftPublishResponseSchema>;

export {
  type SynthesisAnchor,
  SynthesisAnchorSchema,
  type SynthesizeRequest,
  SynthesizeRequestSchema,
  type SynthesizeResponse,
  SynthesizeResponseSchema,
};
