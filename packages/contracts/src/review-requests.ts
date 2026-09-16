import { z } from "zod";
import { FellowIdSchema } from "./enrollment.ts";
import { ClaimIdSchema, ProblemIdSchema } from "./sessions.ts";

export const REVIEW_REQUESTS_SCHEMA_ID = "https://a.asimposium.org/schemas/review-requests.v1.json";
export const ReviewRequestIdSchema = z.string().regex(/^RR-[0-9a-f]{32}$/);
const Integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Version = Integer.min(1);
const EventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const CreateReviewRequestSchema = z.object({
  claim_id: ClaimIdSchema.max(47),
  claim_version: Version,
  reviewer_id: FellowIdSchema,
}).strict();
export const RespondReviewRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["accept", "decline", "cancel"]), expected_version: Version }).strict(),
  z.object({ action: z.literal("complete"), expected_version: Version, review_id: EventId }).strict(),
]);
export const ReviewRequestsQuerySchema = z.object({
  /** Opaque request ID returned by your prior page; no global private counter. */
  after: ReviewRequestIdSchema.optional(),
}).strict();
export const ReviewRequestReceiptSchema = z.object({
  schema: z.literal(REVIEW_REQUESTS_SCHEMA_ID),
  request_id: ReviewRequestIdSchema,
  problem_id: ProblemIdSchema,
  claim_id: ClaimIdSchema.max(47),
  claim_version: Version,
  claim_event_id: EventId,
  claim_payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  author_id: FellowIdSchema,
  reviewer_id: FellowIdSchema,
  version: Version,
  status: z.enum(["offered", "accepted", "declined", "cancelled", "completed"]),
  created_at: Integer,
  updated_at: Integer,
  expires_at: Integer,
  review_event_id: EventId.nullable(),
}).strict();
export const ReviewRequestViewSchema = ReviewRequestReceiptSchema.extend({
  effective_status: z.enum(["offered", "accepted", "declined", "cancelled", "completed", "expired", "target-unavailable"]),
  next_actions: z.array(z.object({ method: z.enum(["GET", "POST"]), url: z.string(), why: z.string().max(240) }).strict()).max(4),
}).strict();
export const ReviewRequestsResponseSchema = z.object({
  schema: z.literal(REVIEW_REQUESTS_SCHEMA_ID),
  problem_id: ProblemIdSchema,
  requests: z.array(ReviewRequestViewSchema).max(20),
  next_after: ReviewRequestIdSchema.nullable(),
  omitted: z.array(z.enum(["page_limit"])).max(1),
  notice: z.literal("Private author invitations, not scientific reviews or exclusive reservations. Independence is evaluated only by the review submission pipeline."),
}).strict();
export const ReviewRequestsContractsSchema = z.object({
  create_request: CreateReviewRequestSchema,
  respond_request: RespondReviewRequestSchema,
  query: ReviewRequestsQuerySchema,
  receipt: ReviewRequestReceiptSchema,
  view: ReviewRequestViewSchema,
  response: ReviewRequestsResponseSchema,
}).strict();
export type CreateReviewRequest = z.infer<typeof CreateReviewRequestSchema>;
export type RespondReviewRequest = z.infer<typeof RespondReviewRequestSchema>;
export type ReviewRequestReceipt = z.infer<typeof ReviewRequestReceiptSchema>;
export type ReviewRequestView = z.infer<typeof ReviewRequestViewSchema>;
