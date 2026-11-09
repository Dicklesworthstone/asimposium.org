import { z } from "zod";
import { FellowIdSchema } from "./enrollment.ts";
import {
  ProblemIdSchema,
  SessionIdSchema,
  WorkshopObjectIdSchema,
  WorkshopObjectStateSchema,
  WorkshopPushTypeSchema,
} from "./sessions.ts";

export const WORKSHOP_DIRECTORY_SCHEMA_ID =
  "https://a.asimposium.org/schemas/workshop-directory.v1.json";
export const WORKSHOP_DIRECTORY_DEFAULT_LIMIT = 20;
export const WORKSHOP_DIRECTORY_MAX_LIMIT = 100;
export const WORKSHOP_DIRECTORY_MAX_RESPONSE_BYTES = 256 * 1024;

const objectId = WorkshopObjectIdSchema.regex(/^W-[A-Za-z0-9]{26}(?![\s\S])/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limit = z
  .string()
  .regex(/^(?:[1-9][0-9]?|100)(?![\s\S])/)
  .transform(Number);

/** HTTP query values are strings. Identity comes from the owned session,
 * never from caller-supplied Fellow or problem selectors. */
export const WorkshopDirectoryQuerySchema = z
  .object({
    after: objectId.optional(),
    limit: limit.optional(),
    state: WorkshopObjectStateSchema.optional(),
  })
  .strict();
export type WorkshopDirectoryQuery = z.infer<typeof WorkshopDirectoryQuerySchema>;

export function workshopDirectoryPath(session: string, query: WorkshopDirectoryQuery = {}): string {
  const values = new URLSearchParams();
  for (const key of ["after", "limit", "state"] as const) {
    if (query[key] !== undefined) values.set(key, String(query[key]));
  }
  return `/v1/sessions/${encodeURIComponent(session)}/workshop${values.size === 0 ? "" : `?${values}`}`;
}

export function workshopRevisionPath(session: string, object: string, version: number): string {
  return `/v1/sessions/${encodeURIComponent(session)}/workshop/${encodeURIComponent(object)}?version=${version}`;
}

/** Current private metadata plus an immutable revision link. No work-product
 * body, excerpt, relations, publication payload or storage key belongs here. */
export const WorkshopDirectoryItemSchema = z
  .object({
    workshop_id: objectId,
    type: WorkshopPushTypeSchema,
    title: z.string().min(1).max(200),
    version: positive,
    state: WorkshopObjectStateSchema,
    workshop_seq: positive,
    revision_created_at: z.string().datetime(),
    read_url: z.string().min(1).max(256),
  })
  .strict();
export type WorkshopDirectoryItem = z.infer<typeof WorkshopDirectoryItemSchema>;

export const WorkshopDirectoryResponseSchema = z
  .object({
    schema: z.literal(WORKSHOP_DIRECTORY_SCHEMA_ID),
    session_id: SessionIdSchema,
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    after: objectId.nullable(),
    scanned_through: objectId.nullable(),
    next_after: objectId.nullable(),
    state: WorkshopObjectStateSchema.nullable(),
    items: z.array(WorkshopDirectoryItemSchema).max(WORKSHOP_DIRECTORY_MAX_LIMIT),
    omitted: z.array(z.enum(["source_unavailable", "page_limit"])).max(2),
  })
  .strict()
  .superRefine((page, context) => {
    const invalid = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (page.after !== null && (page.scanned_through === null || page.scanned_through < page.after))
      invalid(
        "scanned_through",
        "The inspected position cannot precede the requested continuation.",
      );
    if (new Set(page.omitted).size !== page.omitted.length)
      invalid("omitted", "Omission reasons must be unique.");
    if (
      page.next_after !== null &&
      (page.next_after !== page.scanned_through ||
        (page.after !== null && page.next_after <= page.after) ||
        !page.omitted.includes("page_limit"))
    )
      invalid(
        "next_after",
        "A continuation must advance to the last inspected position and disclose the page limit.",
      );
    if (page.next_after === null && page.omitted.includes("page_limit"))
      invalid("omitted", "A page-limit omission requires a usable continuation.");
    let previous = page.after;
    for (const item of page.items) {
      if (
        (previous !== null && item.workshop_id <= previous) ||
        page.scanned_through === null ||
        item.workshop_id > page.scanned_through ||
        (page.state !== null && item.state !== page.state) ||
        item.read_url !== workshopRevisionPath(page.session_id, item.workshop_id, item.version)
      )
        invalid(
          "items",
          "Entries must match the selection, immutable ID order and exact owned-session revision links.",
        );
      previous = item.workshop_id;
    }
    if (page.scanned_through !== previous && !page.omitted.includes("source_unavailable"))
      invalid(
        "omitted",
        "Inspected but unreturned metadata needs a source-unavailable explanation.",
      );
  });
export type WorkshopDirectoryResponse = z.infer<typeof WorkshopDirectoryResponseSchema>;

export function workshopDirectoryMatchesQuery(
  session: string,
  problem: string,
  fellow: string,
  query: WorkshopDirectoryQuery,
  page: WorkshopDirectoryResponse,
): boolean {
  return (
    page.session_id === session &&
    page.problem_id === problem &&
    page.fellow_id === fellow &&
    page.after === (query.after ?? null) &&
    page.state === (query.state ?? null) &&
    page.items.length <= (query.limit ?? WORKSHOP_DIRECTORY_DEFAULT_LIMIT)
  );
}

export function generateWorkshopDirectorySchema(): string {
  return `${JSON.stringify(
    {
      ...z.toJSONSchema(
        z
          .object({
            query: WorkshopDirectoryQuerySchema,
            response: WorkshopDirectoryResponseSchema,
          })
          .strict(),
        { io: "input" },
      ),
      $id: WORKSHOP_DIRECTORY_SCHEMA_ID,
      description:
        "Private current metadata for one owning Fellow and session problem. Immutable ID pagination is stable against edits; refresh from the first page to discover new objects or changed state selections. Follow exact revision read_url values for full work products. Missing immutable metadata sources are omitted without blocking continuation.",
    },
    null,
    2,
  )}\n`;
}
