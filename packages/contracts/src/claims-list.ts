import { z } from "zod";
import { ProblemIndexTimestampSchema, PublicLedgerProblemIdSchema } from "./ledger.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";
import { ClaimIdSchema, ClaimKindSchema } from "./sessions.ts";

export const CLAIMS_LIST_SCHEMA_ID = "https://a.asimposium.org/schemas/claims-list.v1.json";
export const CLAIMS_LIST_PAGE_SIZE = 8;
export const ClaimsListFormatSchema = z.enum(["json", "md", "html", "toon"]);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence);

/** Continuations retain one immutable public cut. Unknown and repeated query
 * parameters are refused, rather than silently changing the requested page. */
export const ClaimsListQuerySchema = z
  .object({
    through: querySequence.optional(),
    after: querySequence.optional(),
    format: ClaimsListFormatSchema.optional(),
  })
  .strict()
  .refine((query) => query.through === undefined || (query.after ?? 0) <= query.through, {
    message: "The after cursor cannot exceed through.",
  });
export type ClaimsListQuery = z.output<typeof ClaimsListQuerySchema>;

export const ClaimListEntrySchema = z
  .object({
    id: ClaimIdSchema,
    version: sequence.min(1),
    kind: ClaimKindSchema,
    statement: z
      .string()
      .min(1)
      .max(8 * 1024),
    source_seq: sequence.min(1),
    created_at: ProblemIndexTimestampSchema,
    stale: z.boolean(),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
  })
  .strict();
export type ClaimListEntry = z.infer<typeof ClaimListEntrySchema>;

/** `scanned_through` includes unavailable admissions. Advancing over their
 * public envelopes prevents an all-withheld page from trapping a reader; it
 * never returns their text, identities or screening details. */
export const ClaimsListResponseSchema = z
  .object({
    schema: z.literal(CLAIMS_LIST_SCHEMA_ID),
    problem_id: PublicLedgerProblemIdSchema,
    cursor: sequence,
    after: sequence,
    scanned_through: sequence,
    next_after: sequence.nullable(),
    count: z.number().int().nonnegative().max(CLAIMS_LIST_PAGE_SIZE),
    claims: z.array(ClaimListEntrySchema).max(CLAIMS_LIST_PAGE_SIZE),
    omitted: z.array(z.enum(["page_limit", "content_unavailable", "standing_unavailable"])).max(3),
  })
  .strict()
  .superRefine((face, context) => {
    const reject = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (face.count !== face.claims.length)
      reject("count", "count describes only the claims on this page.");
    if (face.after > face.scanned_through || face.scanned_through > face.cursor)
      reject("scanned_through", "The scanned range must remain within this public cursor.");
    if (
      face.next_after !== null &&
      (face.next_after !== face.scanned_through ||
        face.next_after <= face.after ||
        face.next_after >= face.cursor)
    )
      reject(
        "next_after",
        "A continuation must advance to the last admitted source before the public cut.",
      );
    if (face.omitted.includes("page_limit") !== (face.next_after !== null))
      reject("omitted", "page_limit and the continuation must agree.");
    if (new Set(face.omitted).size !== face.omitted.length)
      reject("omitted", "Omission reasons must be unique.");
    const ids = new Set<string>();
    let previous = face.after;
    for (const claim of face.claims) {
      if (
        ids.has(claim.id) ||
        claim.source_seq <= previous ||
        claim.source_seq > face.scanned_through
      )
        reject(
          "claims",
          "Unique claims must follow ascending publication sequence within the scanned range.",
        );
      ids.add(claim.id);
      previous = claim.source_seq;
    }
  });
export type ClaimsListResponse = z.infer<typeof ClaimsListResponseSchema>;

/** Used by both HTTP transports and page links, after ingress validation. */
export function claimsListQueryString(query: ClaimsListQuery): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.format !== undefined) params.set("format", query.format);
  return params.size === 0 ? "" : `?${params}`;
}

export function claimsListPath(
  problem: string,
  format: "json" | "md" | "html" | "human" | "toon",
  query: ClaimsListQuery = {},
): string {
  const selected = { ...query, format: format === "toon" ? ("toon" as const) : undefined };
  return `/p/${encodeURIComponent(problem)}/claims${format === "human" || format === "toon" ? "" : `.${format}`}${claimsListQueryString(selected)}`;
}

export function claimsListMatchesQuery(
  problem: string,
  query: ClaimsListQuery,
  face: ClaimsListResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.after === (query.after ?? 0) &&
    (query.through === undefined || face.cursor === query.through)
  );
}

export function generateClaimsListSchema(): string {
  return `${JSON.stringify(
    {
      $id: CLAIMS_LIST_SCHEMA_ID,
      title: "ASImposium public claims collection",
      $comment:
        "Eight latest claim publications per page at one public cursor. Current content controls still apply to historical reads. Runtime additionally validates range, order, uniqueness, count and continuation agreement. A summary's stale flag is not a scientific disposition; inspect its exact-version claim face.",
      ...z.toJSONSchema(
        z.object({ query: ClaimsListQuerySchema, response: ClaimsListResponseSchema }).strict(),
        { io: "input" },
      ),
    },
    null,
    2,
  )}\n`;
}
