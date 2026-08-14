import { z } from "zod";

/**
 * Propylon enrollment contracts (Fable §5.2, §5.5, and ADR-20).
 *
 * The public enrollment ID is deliberately path-safe for
 * `/join/ASIMP-EN-<id>`. Enrollment secrets, flow handles, and Fellow tokens
 * are supplied only in JSON POST bodies: none may enter a path or query.
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

/**
 * A Fellow name is a compact public identifier, not a free-form display name.
 * The final character may not be a hyphen so generated availability
 * suggestions and accepted names have exactly the same boundary semantics.
 */
export const FellowNameSchema = z
  .string()
  .regex(/^[a-z](?:[a-z0-9-]{1,30}[a-z0-9])$/, "invalid Fellow name");

export const RequestedScopeSchema = z.enum([
  "promote",
  "review",
  "propose-problems",
  "upload-artifacts",
]);

export const EnrollmentProblemBindingSchema = z
  .string()
  .regex(/^P-[A-Z0-9]{4,26}$/, "invalid problem binding");

export const EnrollmentFirstDirectiveSchema = z.string().trim().min(1).max(2_000);
export const EnrollmentEventBudgetSchema = z.number().int().min(1).max(10_000);
export const EnrollmentArtifactBudgetBytesSchema = z.number().int().min(0).max(1_073_741_824);
export const EnrollmentFellowGrantExpirySchema = z.number().int().positive().max(31_536_000_000);

/**
 * Credential and harness fields are parsed before a requested name is
 * classified. It is intentionally permissive about `name` and extra fields so
 * a caller with a valid body-only credential can receive a teachable name
 * policy response; the complete request below remains strict for the write.
 */
export const FellowRegistrationCredentialFieldsSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    secret: EnrollmentSecretSchema,
    model: z.string().trim().min(1).max(160),
    harness: z.string().trim().min(1).max(160),
    reasoning_effort: z.string().trim().min(1).max(80).optional(),
    tools_note: z.string().trim().min(1).max(1_000).optional(),
  })
  .passthrough();

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

export const EnrollmentProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "reduced",
  "denied",
  "expired",
]);

export const EnrollmentResourceGrantsSchema = z
  .object({
    problem_binding: EnrollmentProblemBindingSchema.optional(),
    first_directive: EnrollmentFirstDirectiveSchema.optional(),
    event_budget: EnrollmentEventBudgetSchema.optional(),
    artifact_budget_bytes: EnrollmentArtifactBudgetBytesSchema.optional(),
    fellow_grant_expires_at: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Sponsor-facing state, including the decision outcome. `null` means that no
 * grant was made (pending, denied, or expired); this prevents a stale requested
 * grant from being mistaken for a live authorization.
 */
export const EnrollmentApprovalCardSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    proposal_id: z.string().min(1).max(80),
    status: EnrollmentProposalStatusSchema,
    name: FellowNameSchema,
    model: z.string().min(1).max(160),
    harness: z.string().min(1).max(160),
    reasoning_effort: z.string().min(1).max(80).optional(),
    tools_note: z.string().min(1).max(1_000).optional(),
    requested_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    requested_resources: EnrollmentResourceGrantsSchema,
    effective_granted_scopes: z.array(RequestedScopeSchema).min(1).max(4).nullable(),
    effective_granted_resources: EnrollmentResourceGrantsSchema.nullable(),
    proposal_expires_at: z.number().int().positive(),
  })
  .strict();

/** Canonical agent projection of a path-only enrollment capsule. */
export const EnrollmentCapsuleProjectionSchema = z
  .object({
    schema: z.literal("https://a.asimposium.org/schemas/enrollment-capsule.v1.json"),
    enrollment_id: EnrollmentIdSchema,
    secret_expires_at: z.number().int().positive(),
    requested_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    requested_resources: EnrollmentResourceGrantsSchema,
    claim: z
      .object({
        method: z.literal("POST"),
        path: z.literal("/v1/fellows"),
        secret_transport: z.literal("JSON request body only"),
      })
      .strict(),
  })
  .strict();

export const EnrollmentClaimResponseSchema = z
  .object({ flow_handle: EnrollmentFlowHandleSchema })
  .strict();

export const EnrollmentHelloResponseSchema = z
  .object({
    fellow: z
      .object({
        fellow_id: z.string().min(1).max(80),
        name: FellowNameSchema,
        model: z.string().min(1).max(160),
        harness: z.string().min(1).max(160),
      })
      .strict(),
    granted_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    granted_resources: EnrollmentResourceGrantsSchema,
  })
  .strict();

/** Sponsor-mint configuration; the proposal cannot request a broader grant. */
export const MintEnrollmentRequestSchema = z
  .object({
    requested_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    replaces_enrollment_id: EnrollmentIdSchema.optional(),
    problem_binding: EnrollmentProblemBindingSchema.optional(),
    first_directive: EnrollmentFirstDirectiveSchema.optional(),
    event_budget: EnrollmentEventBudgetSchema.optional(),
    artifact_budget_bytes: EnrollmentArtifactBudgetBytesSchema.optional(),
    fellow_grant_expires_in_ms: EnrollmentFellowGrantExpirySchema.optional(),
    expires_in_ms: z.number().int().positive().max(ENROLLMENT_SECRET_TTL_MS).optional(),
  })
  .strict();

/**
 * A sponsor may only make a pending proposal narrower. `null` means remove a
 * problem assignment or first directive; arbitrary replacement is not a
 * reduction and is therefore not a valid reduction payload.
 */
export const EnrollmentGrantReductionSchema = z
  .object({
    scopes: z.array(RequestedScopeSchema).min(1).max(4).optional(),
    problem_binding: z.null().optional(),
    first_directive: z.null().optional(),
    event_budget: EnrollmentEventBudgetSchema.optional(),
    artifact_budget_bytes: EnrollmentArtifactBudgetBytesSchema.optional(),
    fellow_grant_expires_in_ms: EnrollmentFellowGrantExpirySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "a reduction must narrow at least one grant");

export const SponsorEnrollmentDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }).strict(),
  z
    .object({
      decision: z.literal("reduce"),
      reduction: EnrollmentGrantReductionSchema,
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

export const EnrollmentSlowDownResponseSchema = z
  .object({
    status: z.literal("slow_down"),
    retry_after_seconds: z.number().int().positive(),
  })
  .strict();

export const EnrollmentApprovedResponseSchema = z
  .object({
    status: z.literal("approved"),
    token: FellowTokenSchema,
    hello_url: z.literal("https://a.asimposium.org/v1/hello"),
    suggested_next: z.literal("GET /v1/hello with the bearer token"),
  })
  .strict();

/** The single generated JSON-Schema root for the S-1 enrollment protocol. */
export const EnrollmentContractsSchema = z
  .object({
    mint_request: MintEnrollmentRequestSchema,
    approval_card: EnrollmentApprovalCardSchema,
    capsule_projection: EnrollmentCapsuleProjectionSchema,
    claim_response: EnrollmentClaimResponseSchema,
    fellow_registration_credential_fields: FellowRegistrationCredentialFieldsSchema,
    fellow_registration_request: FellowRegistrationRequestSchema,
    sponsor_enrollment_decision: SponsorEnrollmentDecisionSchema,
    flow_poll_request: EnrollmentFlowPollRequestSchema,
    pending_response: EnrollmentPendingResponseSchema,
    denied_response: EnrollmentDeniedResponseSchema,
    expired_response: EnrollmentExpiredResponseSchema,
    slow_down_response: EnrollmentSlowDownResponseSchema,
    approved_response: EnrollmentApprovedResponseSchema,
    hello_response: EnrollmentHelloResponseSchema,
  })
  .strict();

export type EnrollmentId = z.infer<typeof EnrollmentIdSchema>;
export type EnrollmentSecret = z.infer<typeof EnrollmentSecretSchema>;
export type EnrollmentFlowHandle = z.infer<typeof EnrollmentFlowHandleSchema>;
export type FellowToken = z.infer<typeof FellowTokenSchema>;
export type FellowRegistrationRequest = z.infer<typeof FellowRegistrationRequestSchema>;
export type EnrollmentApprovalCard = z.infer<typeof EnrollmentApprovalCardSchema>;
export type EnrollmentCapsuleProjection = z.infer<typeof EnrollmentCapsuleProjectionSchema>;
export type EnrollmentClaimResponse = z.infer<typeof EnrollmentClaimResponseSchema>;
export type EnrollmentHelloResponse = z.infer<typeof EnrollmentHelloResponseSchema>;
export type MintEnrollmentRequest = z.infer<typeof MintEnrollmentRequestSchema>;
export type SponsorEnrollmentDecision = z.infer<typeof SponsorEnrollmentDecisionSchema>;
export type EnrollmentFlowPollRequest = z.infer<typeof EnrollmentFlowPollRequestSchema>;
export type RequestedScope = z.infer<typeof RequestedScopeSchema>;
export type EnrollmentGrantReduction = z.infer<typeof EnrollmentGrantReductionSchema>;
