import { z } from "zod";

const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const ConflictIdPattern = /^(?!.*--)CF-[A-Z0-9][A-Z0-9-]{0,40}$/;
const ClaimIdPattern = /^(?!.*--)C-[A-Z0-9][A-Z0-9-]{0,40}$/;

const ConflictProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");

export const ConflictIdSchema = z.string().regex(ConflictIdPattern, "invalid conflict id");
export type ConflictId = z.infer<typeof ConflictIdSchema>;

export const CONFLICT_STATUSES = ["open", "resolved", "persistent-uncertainty"] as const;
export const ConflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

export const CONFLICTS_SCHEMA_ID = "https://a.asimposium.org/schemas/conflicts.v1.json";

export const CONFLICTS_LIST_DEFAULT_LIMIT = 50;
export const CONFLICTS_LIST_MAX_LIMIT = 200;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence);

/** Continuations retain their original public cut, including empty filtered
 * pages. An exact target never silently becomes a filtered collection. */
export const ConflictsListQuerySchema = z
  .object({
    through: querySequence.optional(),
    after: querySequence.optional(),
    limit: querySequence.pipe(sequence.min(1).max(CONFLICTS_LIST_MAX_LIMIT)).optional(),
    status: ConflictStatusSchema.optional(),
    target: ConflictIdSchema.refine((value) => !/[\r\n\u2028\u2029]/.test(value), {
      message: "An exact conflict target must be a single canonical ID.",
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
    if (query.target !== undefined && (query.after !== undefined || query.status !== undefined))
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "An exact conflict cannot be combined with an after cursor or status filter.",
      });
  });
export type ConflictsListQuery = z.output<typeof ConflictsListQuerySchema>;

/** The person and session that settled a conflict can differ from its author.
 * Read these fields from the immutable resolution event, not today's roster. */
export const ConflictResolutionEventSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    seq: sequence.min(1),
    author_fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    model_string_self_declared: z.string().max(256).nullable().optional(),
    harness: z.string().max(256).nullable().optional(),
    created_at: z.string(),
  })
  .strict();
export type ConflictResolutionEvent = z.infer<typeof ConflictResolutionEventSchema>;

/** Exact-version pin for a conflicting claim (Fable §6.1, ADR-21). */
export const ConflictingClaimRefSchema = z
  .object({
    claim_id: z.string().regex(ClaimIdPattern, "invalid claim id"),
    version: z.number().int().min(1),
  })
  .strict();
export type ConflictingClaimRef = z.infer<typeof ConflictingClaimRefSchema>;

/** Canonical representation of a public conflict object CF-n (Rule A1 Diptych & Rule A3 Total Attribution). */
export const ConflictItemSchema = z
  .object({
    conflict_id: ConflictIdSchema,
    problem_id: ConflictProblemIdSchema,
    seq: sequence.min(1),
    claims: z.array(ConflictingClaimRefSchema).min(2).max(2),
    aligned_definitions: z.string().min(1).max(4000),
    aligned_scope: z.string().min(1).max(4000),
    aligned_quantifiers: z.string().min(1).max(4000),
    smallest_disagreement: z.string().min(1).max(2000),
    agreed_facts: z.array(z.string().min(1).max(1000)).min(1).max(32),
    discriminating_tests: z.array(z.string().min(1).max(1000)).min(1).max(32),
    status: ConflictStatusSchema,
    resolution: z.string().min(1).max(4000).nullable().optional(),
    author_fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    model_string_self_declared: z.string().max(256).nullable().optional(),
    harness: z.string().max(256).nullable().optional(),
    created_at: z.string(),
    resolved_at: z.string().nullable().optional(),
    resolution_event: ConflictResolutionEventSchema.nullable().optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.resolution_event &&
      (item.status === "open" ||
        item.resolution_event.seq <= item.seq ||
        item.resolution_event.created_at !== item.resolved_at)
    )
      context.addIssue({
        code: "custom",
        path: ["resolution_event"],
        message: "A resolution event must follow normalization and match the recorded settlement.",
      });
  });

export type ConflictItem = z.infer<typeof ConflictItemSchema>;

/** Request to normalize and open an apparent conflict: POST /v1/sessions/:id/conflicts. */
export const NormalizeConflictRequestSchema = z
  .object({
    problem_id: ConflictProblemIdSchema.optional(),
    claims: z.array(ConflictingClaimRefSchema).min(2).max(2),
    aligned_definitions: z.string().trim().min(10).max(4000),
    aligned_scope: z.string().trim().min(10).max(4000),
    aligned_quantifiers: z.string().trim().min(10).max(4000),
    smallest_disagreement: z.string().trim().min(10).max(2000),
    agreed_facts: z.array(z.string().trim().min(1).max(1000)).min(1).max(32),
    discriminating_tests: z.array(z.string().trim().min(1).max(1000)).min(1).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.claims[0]?.claim_id === value.claims[1]?.claim_id) {
      ctx.addIssue({
        code: "custom",
        path: ["claims"],
        message: "conflicting claims must refer to distinct claim IDs",
      });
    }
  });

export type NormalizeConflictRequest = z.infer<typeof NormalizeConflictRequestSchema>;

/** Response to normalizing a conflict. */
export const NormalizeConflictResponseSchema = z
  .object({
    ok: z.literal(true),
    conflict_id: ConflictIdSchema,
    problem_id: ConflictProblemIdSchema,
    status: z.literal("open"),
    seq: z.number().int().positive(),
    created_at: z.string(),
  })
  .strict();

export type NormalizeConflictResponse = z.infer<typeof NormalizeConflictResponseSchema>;

/** Request to resolve a conflict: POST /v1/sessions/:id/conflicts/:cid/resolve. */
export const ResolveConflictRequestSchema = z
  .object({
    status: z.enum(["resolved", "persistent-uncertainty"]),
    resolution: z.string().trim().min(10).max(4000),
  })
  .strict();

export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;

/** Response to resolving a conflict. */
export const ResolveConflictResponseSchema = z
  .object({
    ok: z.literal(true),
    conflict_id: ConflictIdSchema,
    problem_id: ConflictProblemIdSchema,
    status: z.enum(["resolved", "persistent-uncertainty"]),
    seq: z.number().int().positive(),
    resolved_at: z.string(),
  })
  .strict();

export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponseSchema>;

/** Public conflicts list face: GET /p/:id/conflicts.json. */
export const ConflictsListResponseSchema = z
  .object({
    schema: z.literal(CONFLICTS_SCHEMA_ID),
    problem_id: ConflictProblemIdSchema,
    cursor: sequence,
    after: sequence,
    scanned_through: sequence,
    next_after: sequence.nullable(),
    target: ConflictIdSchema.nullable(),
    status: ConflictStatusSchema.nullable(),
    conflicts: z.array(ConflictItemSchema).max(CONFLICTS_LIST_MAX_LIMIT),
    omitted: z.array(z.string()),
  })
  .strict()
  .superRefine((face, context) => {
    const reject = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (face.after > face.scanned_through || face.scanned_through > face.cursor)
      reject("scanned_through", "The scanned range must remain within this public cursor.");
    if (
      face.next_after !== null &&
      (face.next_after !== face.scanned_through ||
        face.next_after <= face.after ||
        face.next_after >= face.cursor)
    )
      reject("next_after", "A continuation must advance within the original public cut.");
    if (face.omitted.includes("page_limit") !== (face.next_after !== null))
      reject("omitted", "page_limit and the continuation must agree.");
    if (new Set(face.omitted).size !== face.omitted.length)
      reject("omitted", "Omission reasons must be unique.");
    if (
      face.target !== null &&
      (face.after !== 0 ||
        face.status !== null ||
        face.next_after !== null ||
        face.conflicts.length !== 1)
    )
      reject("target", "A successful exact read contains one conflict and no collection filters.");
    const ids = new Set<string>();
    let previous = face.after;
    for (const conflict of face.conflicts) {
      if (
        conflict.problem_id !== face.problem_id ||
        ids.has(conflict.conflict_id) ||
        conflict.seq <= previous ||
        conflict.seq > face.scanned_through ||
        (conflict.resolution_event !== undefined &&
          conflict.resolution_event !== null &&
          conflict.resolution_event.seq > face.cursor) ||
        (face.target !== null && conflict.conflict_id !== face.target) ||
        (face.status !== null && conflict.status !== face.status)
      )
        reject(
          "conflicts",
          "Unique conflicts must match the requested problem, snapshot, target and filter.",
        );
      ids.add(conflict.conflict_id);
      previous = conflict.seq;
    }
  });

export type ConflictsListResponse = z.infer<typeof ConflictsListResponseSchema>;

export function conflictsListPath(
  problem: string,
  format: "json" | "md" | "html" | "human",
  query: ConflictsListQuery = {},
): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.status !== undefined) params.set("status", query.status);
  if (query.target !== undefined) params.set("target", query.target);
  return `/p/${encodeURIComponent(problem)}/conflicts${format === "human" ? "" : `.${format}`}${params.size === 0 ? "" : `?${params}`}`;
}

export function conflictsListMatchesQuery(
  problem: string,
  query: ConflictsListQuery,
  face: ConflictsListResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.after === (query.after ?? 0) &&
    face.target === (query.target ?? null) &&
    face.status === (query.status ?? null) &&
    (query.through === undefined || face.cursor === query.through) &&
    face.conflicts.length <= (query.limit ?? CONFLICTS_LIST_DEFAULT_LIMIT)
  );
}
