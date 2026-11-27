import { z } from "zod";
import { FellowIdSchema } from "./enrollment.ts";
import { ClosingSynthesisDeclarationSchema } from "./problem-resolution.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";
import {
  ProblemIdSchema,
  SessionIdSchema,
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

/** Private synthesis draft record visible ONLY to its authoring Fellow,
 * problem stewards and the author's current sponsor (Fable §6.1). Never exposed publicly until
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

export const SESSION_SYNTHESIS_DRAFT_DEFAULT_LIMIT = 20;
export const SESSION_SYNTHESIS_DRAFT_MAX_LIMIT = 100;
export const SESSION_SYNTHESIS_DRAFT_INDEX_MAX_BYTES = 256 * 1024;
const recoveryId = SynthesisIdSchema.regex(/^[A-Z0-9-]+$(?![\s\S])/);

/** Current private recovery selection; identity and problem come from the session. */
export const SessionSynthesisDraftQuerySchema = z
  .object({
    after: recoveryId.optional(),
    // Bound the HTTP string before transforming so the exported input JSON
    // Schema enforces the same range as the runtime parser.
    limit: z
      .string()
      .regex(/^(?:[1-9][0-9]?|100)(?![\s\S])/)
      .transform(Number)
      .optional(),
    state: z.enum(["draft", "published"]).optional(),
  })
  .strict();
export type SessionSynthesisDraftQuery = z.infer<typeof SessionSynthesisDraftQuerySchema>;

export function sessionSynthesisDraftsPath(
  session: string,
  query: SessionSynthesisDraftQuery = {},
): string {
  const values = new URLSearchParams();
  for (const key of ["after", "limit", "state"] as const) {
    if (query[key] !== undefined) values.set(key, String(query[key]));
  }
  return `/v1/sessions/${encodeURIComponent(session)}/syntheses${values.size === 0 ? "" : `?${values}`}`;
}

export function sessionSynthesisDraftPath(session: string, synthesis: string): string {
  return `${sessionSynthesisDraftsPath(session)}/${encodeURIComponent(synthesis)}`;
}

/** These pins recover a completed publication; shared_handoff still requires
 * an explicit close request and fresh validation of the public source. */
export const SessionSynthesisPublicationSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    sequence: cursor.min(1),
    published_at: z.string().datetime(),
    read_url: z.string().min(1).max(512),
    shared_handoff: z
      .object({
        synthesis_id: SynthesisIdSchema,
        event_id: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();
export type SessionSynthesisPublication = z.infer<typeof SessionSynthesisPublicationSchema>;

/** No work-product body or anchors are loaded for the directory. */
export const SessionSynthesisDraftItemSchema = z
  .object({
    synthesis_id: SynthesisIdSchema,
    state: z.enum(["draft", "published"]),
    covers_through: cursor,
    anchors_count: cursor.min(1).max(1000),
    dropped_single_author_count: cursor,
    authored_session_id: z.string().min(1).max(128),
    created_at: z.string().datetime(),
    read_url: z.string().min(1).max(512),
    publication: SessionSynthesisPublicationSchema.nullable(),
  })
  .strict();
export type SessionSynthesisDraftItem = z.infer<typeof SessionSynthesisDraftItemSchema>;

function publicationMatches(
  publication: SessionSynthesisPublication | null,
  state: "draft" | "published",
  problem: string,
  synthesis: string,
): boolean {
  return state === "draft"
    ? publication === null
    : publication !== null &&
        publication.shared_handoff.synthesis_id === synthesis &&
        publication.shared_handoff.event_id === publication.event_id &&
        publication.read_url ===
          `/p/${encodeURIComponent(problem)}/syntheses/${encodeURIComponent(synthesis)}.json`;
}

export const SessionSynthesisDraftIndexSchema = z
  .object({
    schema: z.literal(SYNTHESES_SCHEMA_ID),
    session_id: SessionIdSchema,
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    after: SynthesisIdSchema.nullable(),
    next_after: SynthesisIdSchema.nullable(),
    state: z.enum(["draft", "published"]).nullable(),
    items: z.array(SessionSynthesisDraftItemSchema).max(SESSION_SYNTHESIS_DRAFT_MAX_LIMIT),
  })
  .strict()
  .superRefine((page, context) => {
    let previous = page.after;
    for (const item of page.items) {
      if (
        (previous !== null && item.synthesis_id <= previous) ||
        (page.state !== null && item.state !== page.state) ||
        item.read_url !== sessionSynthesisDraftPath(page.session_id, item.synthesis_id) ||
        !publicationMatches(item.publication, item.state, page.problem_id, item.synthesis_id)
      )
        context.addIssue({
          code: "custom",
          path: ["items"],
          message:
            "Draft metadata must match the ordered owned-session selection and publication pins.",
        });
      previous = item.synthesis_id;
    }
    if (page.next_after !== null && (page.items.length === 0 || page.next_after !== previous))
      context.addIssue({
        code: "custom",
        path: ["next_after"],
        message: "Continuation must advance to the last returned draft.",
      });
  });
export type SessionSynthesisDraftIndex = z.infer<typeof SessionSynthesisDraftIndexSchema>;

export const SessionSynthesisDraftResponseSchema = z
  .object({
    schema: z.literal(SYNTHESES_SCHEMA_ID),
    session_id: SessionIdSchema,
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    draft: SynthesisDraftRecordSchema,
    read_url: z.string().min(1).max(512),
    publication: SessionSynthesisPublicationSchema.nullable(),
  })
  .strict()
  .superRefine((face, context) => {
    if (
      face.draft.author_fellow_id !== face.fellow_id ||
      face.draft.problem_id !== face.problem_id ||
      face.read_url !== sessionSynthesisDraftPath(face.session_id, face.draft.synthesis_id) ||
      !publicationMatches(
        face.publication,
        face.draft.state,
        face.problem_id,
        face.draft.synthesis_id,
      ) ||
      (face.publication !== null &&
        (face.publication.event_id !== face.draft.published_event_id ||
          face.publication.sequence !== face.draft.published_seq ||
          face.publication.published_at !== face.draft.published_at))
    )
      context.addIssue({
        code: "custom",
        path: ["draft"],
        message:
          "Recovered draft must belong to the session Fellow and problem with matching publication pins.",
      });
  });
export type SessionSynthesisDraftResponse = z.infer<typeof SessionSynthesisDraftResponseSchema>;

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
