import { z } from "zod";
import { FellowIdSchema, SponsorIdSchema } from "./enrollment.ts";
import { ProblemIdSchema, WorkshopObjectIdSchema, WorkshopPushTypeSchema } from "./sessions.ts";

export const WORKSHOP_SEARCH_PAGE_LIMIT = 20;
export const WORKSHOP_SEARCH_MAX_RESPONSE_BYTES = 64 * 1024;
export const WORKSHOP_SEARCH_SCHEMA = "https://a.asimposium.org/schemas/workshop-search.v1.json";
export const WORKSHOP_SEARCH_SCHEMA_ID = WORKSHOP_SEARCH_SCHEMA;

/** Search words are literal terms, never an FTS query language. Neither field
 * names, Boolean operators nor punctuation can select an index or widen scope. */
export function workshopSearchTerms(query: string): readonly string[] | undefined {
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
  return terms.length > 0 && terms.length <= 8 && terms.every((term) => term.length <= 64)
    ? terms
    : undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in private search input rather than passing them into FTS or rendered results.
const SEARCH_TEXT_CONTROL_FREE = /^[^\u0000-\u001f\u007f]*$/;
const SearchTextSchema = z
  .string()
  .regex(SEARCH_TEXT_CONTROL_FREE, "Search text cannot contain control characters");
export const WorkshopSearchQuerySchema = SearchTextSchema.trim()
  .min(1)
  .max(160)
  .refine(
    (query) => workshopSearchTerms(query) !== undefined,
    "Use one to eight search words of at most 64 characters each",
  );
export const WorkshopSearchStateSchema = z.enum(["open", "archived", "discarded"]);
export const WorkshopSearchRequestSchema = z
  .object({
    query: WorkshopSearchQuerySchema,
    fellow_id: FellowIdSchema.optional(),
    problem_id: ProblemIdSchema.optional(),
    state: WorkshopSearchStateSchema.optional(),
    after: WorkshopObjectIdSchema.optional(),
  })
  .strict();
export type WorkshopSearchRequest = z.infer<typeof WorkshopSearchRequestSchema>;

export const WorkshopSearchItemSchema = z
  .object({
    workshop_id: WorkshopObjectIdSchema,
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    type: WorkshopPushTypeSchema,
    title: z.string().min(1).max(200),
    excerpt: z.string().min(1).max(280),
    body_coverage: z.enum(["inline-body", "stored-extract"]),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workshop_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: WorkshopSearchStateSchema,
  })
  .strict();
export type WorkshopSearchItem = z.infer<typeof WorkshopSearchItemSchema>;
export const WorkshopSearchResponseSchema = z
  .object({
    schema: z.literal(WORKSHOP_SEARCH_SCHEMA),
    sponsor_id: SponsorIdSchema,
    query: WorkshopSearchQuerySchema,
    coverage: z.literal("titles-and-stored-draft-text"),
    items: z.array(WorkshopSearchItemSchema).max(WORKSHOP_SEARCH_PAGE_LIMIT),
    next_cursor: WorkshopObjectIdSchema.nullable(),
  })
  .strict();
export type WorkshopSearchResponse = z.infer<typeof WorkshopSearchResponseSchema>;

/** IDs are ASCII and immutable. Edits cannot move an unseen draft across the
 * keyset boundary. The cursor is navigation data, never access authority. */
export function workshopSearchPageIsValid(
  page: WorkshopSearchResponse,
  request: WorkshopSearchRequest,
): boolean {
  if (page.query !== request.query) return false;
  let previous = request.after;
  for (const item of page.items) {
    if (
      (previous !== undefined && item.workshop_id <= previous) ||
      (request.fellow_id !== undefined && item.fellow_id !== request.fellow_id) ||
      (request.problem_id !== undefined && item.problem_id !== request.problem_id) ||
      (request.state !== undefined && item.state !== request.state)
    )
      return false;
    previous = item.workshop_id;
  }
  return (
    page.next_cursor === null ||
    (page.items.length === WORKSHOP_SEARCH_PAGE_LIMIT && page.next_cursor === previous)
  );
}

export const WorkshopSearchContractsSchema = z
  .object({
    request: WorkshopSearchRequestSchema,
    response: WorkshopSearchResponseSchema,
  })
  .strict();

export function generateWorkshopSearchSchema(): string {
  return JSON.stringify(
    {
      ...z.toJSONSchema(WorkshopSearchContractsSchema),
      $id: WORKSHOP_SEARCH_SCHEMA_ID,
    },
    null,
    2,
  );
}
