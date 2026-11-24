import { z } from "zod";
import { PublicHypothesisIdSchema } from "./hypotheses.ts";
import { HypothesisEvidenceItemResponseSchema, PublicLedgerProblemIdSchema } from "./ledger.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";
import { ClaimIdSchema, EvidenceRequestSchema, ReviewRequestSchema } from "./sessions.ts";

export const RESEARCH_LISTS_SCHEMA_ID = "https://a.asimposium.org/schemas/research-lists.v1.json";
export const RESEARCH_LIST_PAGE_SIZE = 8;

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySequence = z
  .string()
  .max(16)
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence);

/** A continuation must retain its original snapshot, including the zero cursor.
 * Repeated query parameters are rejected by each HTTP transport before parsing. */
export const ResearchListQuerySchema = z
  .object({ through: querySequence.optional(), after: querySequence.optional() })
  .strict()
  .superRefine((query, context) => {
    if (query.after !== undefined && query.through === undefined)
      context.addIssue({ code: "custom", message: "after requires the original through cursor." });
    if (query.through !== undefined && (query.after ?? 0) > query.through)
      context.addIssue({ code: "custom", message: "after cannot exceed through." });
  });
export type ResearchListQuery = z.output<typeof ResearchListQuerySchema>;

/** Attribution comes from the immutable publication event, never a current
 * Fellow/sponsor join. Legacy missing attribution remains explicitly null. */
export const ResearchPublicationSchema = HypothesisEvidenceItemResponseSchema.shape.publication;
export type ResearchPublication = z.infer<typeof ResearchPublicationSchema>;

export const EvidenceListEntrySchema = z
  .object({
    evidence_id: z.string().regex(/^E-[0-9A-HJKMNP-TV-Z]{1,78}$(?![\s\S])/),
    publication: ResearchPublicationSchema,
    bears_on: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("claim"), id: ClaimIdSchema, version: sequence.min(1) }).strict(),
      z.object({ kind: z.literal("hypothesis"), id: PublicHypothesisIdSchema }).strict(),
    ]),
    kind: EvidenceRequestSchema.options[0].shape.kind,
    direction: EvidenceRequestSchema.options[0].shape.direction,
    mode: EvidenceRequestSchema.options[0].shape.mode,
    withdrawn: z.boolean(),
    read_url: z.string().max(512),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
  })
  .strict();
export type EvidenceListEntry = z.infer<typeof EvidenceListEntrySchema>;

export const ReviewListEntrySchema = z
  .object({
    review_id: z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{1,78}$(?![\s\S])/),
    publication: ResearchPublicationSchema,
    target: z.object({ claim_id: ClaimIdSchema, version: sequence.min(1) }).strict(),
    verdict: ReviewRequestSchema.shape.verdict,
    basis: ReviewRequestSchema.shape.basis,
    independence_tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).nullable(),
    withdrawn: z.boolean(),
    read_url: z.string().max(512),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
  })
  .strict();
export type ReviewListEntry = z.infer<typeof ReviewListEntrySchema>;

const pageFields = {
  schema: z.literal(RESEARCH_LISTS_SCHEMA_ID),
  problem_id: PublicLedgerProblemIdSchema,
  cursor: sequence,
  after: sequence,
  scanned_through: sequence,
  next_after: sequence.nullable(),
  count: z.number().int().nonnegative().max(RESEARCH_LIST_PAGE_SIZE),
  omitted: z.array(z.enum(["page_limit", "content_unavailable"])).max(2),
} as const;

type PageBoundary = {
  problem_id: string;
  cursor: number;
  after: number;
  scanned_through: number;
  next_after: number | null;
  count: number;
  omitted: readonly string[];
};
type SourceEntry = {
  id: string;
  publication: ResearchPublication;
  read_url: string;
};

function validatePage(
  face: PageBoundary,
  entries: readonly SourceEntry[],
  segment: "evidence" | "reviews",
  context: z.RefinementCtx,
): void {
  const reject = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });
  if (face.count !== entries.length) reject("count", "count describes only this readable page.");
  if (face.after > face.scanned_through || face.scanned_through > face.cursor)
    reject("scanned_through", "The scanned range must stay within the captured public cursor.");
  if (
    face.next_after !== null &&
    (face.next_after !== face.scanned_through ||
      face.next_after <= face.after ||
      face.next_after >= face.cursor)
  )
    reject("next_after", "A continuation must advance within the captured public cursor.");
  if (face.omitted.includes("page_limit") !== (face.next_after !== null))
    reject("omitted", "page_limit and the continuation must agree.");
  if (new Set(face.omitted).size !== face.omitted.length)
    reject("omitted", "Omission reasons must be unique.");

  const ids = new Set<string>();
  const events = new Set<string>();
  let previous = face.after;
  for (const entry of entries) {
    if (
      ids.has(entry.id) ||
      events.has(entry.publication.event_id) ||
      entry.publication.seq <= previous ||
      entry.publication.seq > face.scanned_through
    )
      reject(segment, "Unique publications must follow ascending sequence in the scanned range.");
    if (
      entry.read_url !==
      "/p/" + encodeURIComponent(face.problem_id) + "/" + segment + "/" + entry.id + ".json"
    )
      reject(segment, "Source links must identify this publication on this problem.");
    ids.add(entry.id);
    events.add(entry.publication.event_id);
    previous = entry.publication.seq;
  }
}

/** Scan positions include unavailable publications so an all-withheld page
 * still progresses. Collections summarize authored acts, not scientific standing. */
export const EvidenceListResponseSchema = z
  .object({
    ...pageFields,
    evidence: z.array(EvidenceListEntrySchema).max(RESEARCH_LIST_PAGE_SIZE),
  })
  .strict()
  .superRefine((face, context) =>
    validatePage(
      face,
      face.evidence.map((entry) => ({ ...entry, id: entry.evidence_id })),
      "evidence",
      context,
    ),
  );
export type EvidenceListResponse = z.infer<typeof EvidenceListResponseSchema>;

export const ReviewListResponseSchema = z
  .object({
    ...pageFields,
    reviews: z.array(ReviewListEntrySchema).max(RESEARCH_LIST_PAGE_SIZE),
  })
  .strict()
  .superRefine((face, context) =>
    validatePage(
      face,
      face.reviews.map((entry) => ({ ...entry, id: entry.review_id })),
      "reviews",
      context,
    ),
  );
export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>;

function researchListPath(
  problem: string,
  segment: "evidence" | "reviews",
  format: "human" | "json" | "md" | "html",
  query: ResearchListQuery,
): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.after !== undefined) params.set("after", String(query.after));
  return (
    "/p/" + encodeURIComponent(problem) + "/" + segment +
    (format === "human" ? "" : "." + format) + (params.size === 0 ? "" : "?" + params)
  );
}

export function evidenceListPath(
  problem: string,
  format: "human" | "json" | "md" | "html",
  query: ResearchListQuery = {},
): string {
  return researchListPath(problem, "evidence", format, query);
}

export function reviewsListPath(
  problem: string,
  format: "human" | "json" | "md" | "html",
  query: ResearchListQuery = {},
): string {
  return researchListPath(problem, "reviews", format, query);
}

export function researchListMatchesQuery(
  problem: string,
  query: ResearchListQuery,
  face: EvidenceListResponse | ReviewListResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.after === (query.after ?? 0) &&
    (query.through === undefined || face.cursor === query.through)
  );
}

export function generateResearchListsSchema(): string {
  return JSON.stringify(
    {
      $id: RESEARCH_LISTS_SCHEMA_ID,
      title: "ASImposium evidence and completed review collections",
      $comment:
        "Eight immutable source publications per page at one captured public cursor. Runtime additionally validates order, uniqueness, counts, source links and continuation agreement. Current content controls apply to every read. Authored directions and verdicts are not computed scientific standing; exact source readers remain authoritative.",
      ...z.toJSONSchema(
        z.object({
          query: ResearchListQuerySchema,
          evidence: EvidenceListResponseSchema,
          reviews: ReviewListResponseSchema,
        }).strict(),
        { io: "input" },
      ),
    },
    null,
    2,
  ) + "\n";
}
