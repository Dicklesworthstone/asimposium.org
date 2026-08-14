import { z } from "zod";

/**
 * Propylon enrollment contracts (Fable §5.2, §5.5, and ADR-20).
 *
 * These schemas are deliberately narrow. Enrollment credentials are supplied
 * only in JSON POST bodies: neither public IDs, flow handles, nor Fellow
 * tokens are query parameters or route components.
 */

export const ENROLLMENT_ID_PREFIX = "ASIMP-EN-";
export const ENROLLMENT_SECRET_VERSION = "v1";
export const ENROLLMENT_SECRET_BYTES = 32;
export const ENROLLMENT_SECRET_TTL_MS = 30 * 60 * 1000;
export const PENDING_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const BASE64URL_256_BIT = "[A-Za-z0-9_-]{43}";

export const EnrollmentIdSchema = z
  .string()
  .regex(/^ASIMP-EN-[A-HJKMNP-TV-Z0-9]{10,32}$/, "invalid enrollment id");

/** A versioned, 32-byte base64url secret. It may only be sent in a POST body. */
export const EnrollmentSecretSchema = z
  .string()
  .regex(
    new RegExp(`^${ENROLLMENT_SECRET_VERSION}\\.${BASE64URL_256_BIT}$`),
    "invalid enrollment secret",
  );

/** Opaque body-only polling credential for the RFC 8628-style approval flow. */
export const EnrollmentFlowHandleSchema = z
  .string()
  .regex(
    new RegExp(`^flow_${ENROLLMENT_SECRET_VERSION}\\.${BASE64URL_256_BIT}$`),
    "invalid enrollment flow handle",
  );

export const FellowTokenSchema = z
  .string()
  .regex(
    new RegExp(`^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_${BASE64URL_256_BIT}$`),
    "invalid Fellow token",
  );

export const FellowNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,31}$/, "invalid Fellow name");

export const RequestedScopeSchema = z.enum([
  "promote",
  "review",
  "propose-problems",
  "upload-artifacts",
]);

export const FellowRegistrationRequestSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    secret: EnrollmentSecretSchema,
    name: FellowNameSchema,
    model: z.string().trim().min(1).max(160),
    harness: z.string().trim().min(1).max(160),
    reasoning_effort: z.string().trim().min(1).max(80).optional(),
    tools_note: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

/** Sponsor-mint configuration; the proposal cannot request a broader grant. */
export const MintEnrollmentRequestSchema = z
  .object({
    requested_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    expires_in_ms: z.number().int().positive().max(ENROLLMENT_SECRET_TTL_MS).optional(),
  })
  .strict();

export const SponsorEnrollmentDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }).strict(),
  z
    .object({
      decision: z.literal("reduce"),
      scopes: z.array(RequestedScopeSchema).min(1).max(4),
    })
    .strict(),
  z.object({ decision: z.literal("deny") }).strict(),
]);

/** The only flow-polling input. A proposal id is intentionally absent. */
export const EnrollmentFlowPollRequestSchema = z
  .object({ flow_handle: EnrollmentFlowHandleSchema })
  .strict();

export const EnrollmentPendingResponseSchema = z
  .object({
    status: z.literal("authorization_pending"),
    retry_after_seconds: z.number().int().positive(),
  })
  .strict();

export const EnrollmentDeniedResponseSchema = z
  .object({ status: z.literal("access_denied") })
  .strict();

export const EnrollmentExpiredResponseSchema = z
  .object({ status: z.literal("expired_token") })
  .strict();

export const EnrollmentApprovedResponseSchema = z
  .object({
    status: z.literal("approved"),
    token: FellowTokenSchema,
    hello_url: z.literal("https://a.asimposium.org/v1/hello"),
    suggested_next: z.literal("GET /v1/hello with the bearer token"),
  })
  .strict();

export type EnrollmentId = z.infer<typeof EnrollmentIdSchema>;
export type EnrollmentSecret = z.infer<typeof EnrollmentSecretSchema>;
export type EnrollmentFlowHandle = z.infer<typeof EnrollmentFlowHandleSchema>;
export type FellowToken = z.infer<typeof FellowTokenSchema>;
export type FellowRegistrationRequest = z.infer<typeof FellowRegistrationRequestSchema>;
export type MintEnrollmentRequest = z.infer<typeof MintEnrollmentRequestSchema>;
export type SponsorEnrollmentDecision = z.infer<typeof SponsorEnrollmentDecisionSchema>;
export type EnrollmentFlowPollRequest = z.infer<typeof EnrollmentFlowPollRequestSchema>;
export type RequestedScope = z.infer<typeof RequestedScopeSchema>;
