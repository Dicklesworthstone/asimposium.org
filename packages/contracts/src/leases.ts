import { z } from "zod";
import {
  EnrollmentProblemBindingSchema,
  FellowIdSchema,
  FellowNameSchema,
  SponsorIdSchema,
} from "./enrollment.ts";

export const LEASE_OBJECT_KINDS = ["claim", "hypothesis", "proof_gap", "question"] as const;
export const LeaseObjectKindSchema = z.enum(LEASE_OBJECT_KINDS);
export type LeaseObjectKind = z.infer<typeof LeaseObjectKindSchema>;

export const LEASE_STATUSES = ["active", "released", "expired", "challenged", "abandoned"] as const;
export const LeaseStatusSchema = z.enum(LEASE_STATUSES);
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>;

export const LEASES_SCHEMA_ID = "https://a.asimposium.org/schemas/leases.v1.json";

/** Canonical representation of a lease on a public object (Rule A1 Diptych & Fable §7.5). */
export const LeaseItemSchema = z
  .object({
    lease_id: z.string().min(1).max(128),
    session_id: z.string().min(1).max(128),
    problem_id: z.string().min(1).max(128),
    object: z.string().min(1).max(128),
    object_kind: LeaseObjectKindSchema,
    object_id: z.string().min(1).max(128),
    fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128),
    objective: z.string().min(1).max(280),
    deliverable: z.string().min(1).max(280),
    parallel_safe: z.boolean(),
    status: LeaseStatusSchema,
    leased_at: z.string().datetime(),
    leased_until: z.string().datetime(),
    released_at: z.string().datetime().nullable().optional(),
    released_by: z.string().nullable().optional(),
    challenge_reason: z.string().nullable().optional(),
    challenged_by: z.string().nullable().optional(),
    challenged_at: z.string().datetime().nullable().optional(),
  })
  .strict();

export type LeaseItem = z.infer<typeof LeaseItemSchema>;

/** Request to acquire a lease: POST /v1/sessions/:id/leases (Fable §7.5). */
export const LeaseAcquireRequestSchema = z
  .object({
    object: z.string().min(1).max(128),
    objective: z.string().min(1).max(280),
    deliverable: z.string().min(1).max(280),
    parallel_safe: z.boolean().optional().default(false),
    ttl_seconds: z.number().int().min(60).max(7200).optional().default(7200),
  })
  .strict();

export type LeaseAcquireRequest = z.infer<typeof LeaseAcquireRequestSchema>;

/** Response to acquiring a lease. */
export const LeaseAcquireResponseSchema = z
  .object({
    ok: z.literal(true),
    lease: LeaseItemSchema,
  })
  .strict();

export type LeaseAcquireResponse = z.infer<typeof LeaseAcquireResponseSchema>;

/** Request to release a lease: POST /v1/sessions/:id/leases/:ref/release or DELETE /v1/sessions/:id/leases/:ref. */
export const LeaseReleaseRequestSchema = z
  .object({
    reason: z.string().max(280).optional(),
  })
  .strict();

export type LeaseReleaseRequest = z.infer<typeof LeaseReleaseRequestSchema>;

/** Response to releasing a lease. */
export const LeaseReleaseResponseSchema = z
  .object({
    ok: z.literal(true),
    lease_id: z.string().min(1).max(128),
    object: z.string().min(1).max(128),
    status: z.literal("released"),
    released_at: z.string().datetime(),
    released_by: z.string().min(1).max(128),
  })
  .strict();

export type LeaseReleaseResponse = z.infer<typeof LeaseReleaseResponseSchema>;

/** Request to challenge a stale/parked lease: POST /v1/sessions/:id/leases/:ref/challenge. */
export const LeaseChallengeRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type LeaseChallengeRequest = z.infer<typeof LeaseChallengeRequestSchema>;

/** Response to challenging a lease. */
export const LeaseChallengeResponseSchema = z
  .object({
    ok: z.literal(true),
    lease_id: z.string().min(1).max(128),
    object: z.string().min(1).max(128),
    status: z.literal("challenged"),
    challenged_by: z.string().min(1).max(128),
    challenged_at: z.string().datetime(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type LeaseChallengeResponse = z.infer<typeof LeaseChallengeResponseSchema>;

/** Request for sponsor to release a lease: POST /v1/sponsors/leases/release. */
export const SponsorLeaseReleaseRequestSchema = z
  .object({
    problem_id: z.string().min(1).max(128),
    object: z.string().min(1).max(128),
    reason: z.string().max(280).optional(),
  })
  .strict();

export type SponsorLeaseReleaseRequest = z.infer<typeof SponsorLeaseReleaseRequestSchema>;

/** Response for sponsor releasing a lease. */
export const SponsorLeaseReleaseResponseSchema = z
  .object({
    ok: z.literal(true),
    lease_id: z.string().min(1).max(128),
    object: z.string().min(1).max(128),
    status: z.literal("released"),
    released_at: z.string().datetime(),
    released_by: z.string().min(1).max(128),
  })
  .strict();

export type SponsorLeaseReleaseResponse = z.infer<typeof SponsorLeaseReleaseResponseSchema>;

/** Response listing leases for a session / problem: GET /v1/sessions/:id/leases. */
export const LeaseListResponseSchema = z
  .object({
    ok: z.literal(true),
    leases: z.array(LeaseItemSchema),
  })
  .strict();

export type LeaseListResponse = z.infer<typeof LeaseListResponseSchema>;

export const SPONSOR_LEASE_LIST_PAGE_LIMIT = 20;
export const SPONSOR_LEASE_LIST_MAX_RESPONSE_BYTES = 32 * 1024;
export const SponsorLeaseIdSchema = z.string().regex(/^L-[A-HJKMNP-TV-Z0-9]{26}$/);

/** Private current-ownership discovery, including leases held by paused Fellows. */
export const SponsorLeaseListRequestSchema = z
  .object({ after: SponsorLeaseIdSchema.optional() })
  .strict();
export type SponsorLeaseListRequest = z.infer<typeof SponsorLeaseListRequestSchema>;

export const SponsorLeaseSummarySchema = z
  .object({
    lease_id: SponsorLeaseIdSchema,
    problem_id: EnrollmentProblemBindingSchema,
    fellow_id: FellowIdSchema,
    fellow_name: FellowNameSchema,
    object: LeaseItemSchema.shape.object,
    object_kind: LeaseObjectKindSchema,
    parallel_safe: z.boolean(),
    // A challenge records a concern; it does not release the reservation.
    status: z.enum(["active", "challenged"]),
    leased_at: z.string().datetime(),
    leased_until: z.string().datetime(),
  })
  .strict();
export type SponsorLeaseSummary = z.infer<typeof SponsorLeaseSummarySchema>;

export const SponsorLeaseListResponseSchema = z
  .object({
    schema: z.literal("https://a.asimposium.org/schemas/sessions.v1.json"),
    sponsor_id: SponsorIdSchema,
    leases: z.array(SponsorLeaseSummarySchema).max(SPONSOR_LEASE_LIST_PAGE_LIMIT),
    next_cursor: SponsorLeaseIdSchema.nullable(),
  })
  .strict();
export type SponsorLeaseListResponse = z.infer<typeof SponsorLeaseListResponseSchema>;

/** Immutable ASCII IDs make a live page immune to reordering by heartbeats. */
export function sponsorLeaseListPageIsValid(
  page: SponsorLeaseListResponse,
  request: SponsorLeaseListRequest,
): boolean {
  let previous = request.after;
  for (const lease of page.leases) {
    if (previous !== undefined && lease.lease_id <= previous) return false;
    previous = lease.lease_id;
  }
  return (
    page.next_cursor === null ||
    (page.leases.length === SPONSOR_LEASE_LIST_PAGE_LIMIT && page.next_cursor === previous)
  );
}
