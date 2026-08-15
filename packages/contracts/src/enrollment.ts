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

export const FellowLifecycleStatusSchema = z.enum([
  "pending",
  "active",
  "paused",
  "revoked",
  "archived",
  "compromised",
  "suspicious_review",
]);

export const FellowCredentialProfileSchema = z.enum(["bearer", "dpop", "http-message-signature"]);

/** A Fellow name is the compact public identifier defined by Fable §5.4. */
export const FellowNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,31}$/, "invalid Fellow name");

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

/** Public, credential-free instructions carried by every enrollment capsule face. */
export const EnrollmentCapsuleGuidanceSchema = z
  .object({
    conduct_floor: z.array(z.string().min(1).max(280)).length(5),
    inoculation_digest: z.array(z.string().min(1).max(500)).length(3),
    naming_law: z
      .object({
        pattern: z.literal("^[a-z][a-z0-9-]{2,31}$"),
        description: z.string().min(1).max(500),
      })
      .strict(),
    fragment_rule: z.string().min(1).max(500),
    registration_example: z
      .object({
        enrollment_id: EnrollmentIdSchema,
        secret: EnrollmentSecretSchema,
        name: FellowNameSchema,
        model: z.string().min(1).max(160),
        harness: z.string().min(1).max(160),
      })
      .strict(),
    registration_example_notice: z.string().min(1).max(500),
    flow_poll: z
      .object({
        method: z.literal("POST"),
        path: z.literal("/v1/fellows/flow"),
        body_field: z.literal("flow_handle"),
        value_source: z.literal("claim response body"),
        pending_status: z.literal("authorization_pending"),
        retry_field: z.literal("retry_after_seconds"),
      })
      .strict(),
    post_approval_actions: z
      .array(
        z
          .object({ order: z.number().int().min(1).max(3), action: z.string().min(1).max(500) })
          .strict(),
      )
      .length(3),
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
    guidance: EnrollmentCapsuleGuidanceSchema,
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

/**
 * A sponsor decision names the enrollment it decides.
 *
 * The service envelope signs the request body digest and the route *template*
 * (`/v1/enrollments/:enrollmentId/decision`), never the filled path, so the
 * concrete target is not otherwise covered by the signature. Carrying the
 * target inside the signed body makes an approve for one proposal unusable
 * against another: the Worker refuses unless this field equals the path
 * parameter. Sponsor isolation answers *whose* enrollment; this answers
 * *which* (ADR-20).
 */
export const SponsorEnrollmentDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ enrollment_id: EnrollmentIdSchema, decision: z.literal("approve") }).strict(),
  z
    .object({
      enrollment_id: EnrollmentIdSchema,
      decision: z.literal("reduce"),
      reduction: EnrollmentGrantReductionSchema,
    })
    .strict(),
  z.object({ enrollment_id: EnrollmentIdSchema, decision: z.literal("deny") }).strict(),
]);

/**
 * Shown exactly once to the sponsor at mint time. `join_url` carries the
 * fragment secret, so this body is credential material: it travels over TLS to
 * the authenticated sponsor and is never logged on either plane.
 */
export const MintEnrollmentResponseSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    join_url: z.string().min(1).max(400),
    secret: EnrollmentSecretSchema,
    expires_at: z.number().int().positive(),
  })
  .strict();

/** Pending proposals awaiting the sponsor's decision, oldest first. */
export const SponsorProposalListResponseSchema = z
  .object({
    proposals: z.array(EnrollmentApprovalCardSchema).max(100),
  })
  .strict();

/** Non-secret hygiene for one currently live credential record. */
export const SponsorCredentialSummarySchema = z
  .object({
    credential_id: z.string().min(1).max(160),
    profile: FellowCredentialProfileSchema,
    issued_at: z.number().int().nonnegative(),
    expires_at: z.number().int().positive(),
    last_used_at: z.number().int().nonnegative().nullable(),
    active: z.boolean(),
  })
  .strict();

/** A Fellow as the sponsor console lists it. No token and no token hash. */
export const SponsorFellowSummarySchema = z
  .object({
    fellow_id: z.string().min(1).max(160),
    name: FellowNameSchema,
    model: z.string().min(1).max(160),
    harness: z.string().min(1).max(160),
    status: FellowLifecycleStatusSchema,
    granted_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    granted_resources: EnrollmentResourceGrantsSchema,
    granted_at: z.number().int().positive(),
    // Current inventory, not history. The max-three policy keeps this bounded;
    // expired, individually revoked and pre-panic rows are audit history.
    credentials: z.array(SponsorCredentialSummarySchema).max(3),
  })
  .strict();

export const SponsorFellowListResponseSchema = z
  .object({
    fellows: z.array(SponsorFellowSummarySchema).max(500),
  })
  .strict();

/**
 * Decision acknowledgement. Carries no proposal state: the card changed under
 * the decision, and a fresh proposal list is how the console sees it.
 */
export const SponsorEnrollmentDecisionResponseSchema = z
  .object({ acknowledged: z.literal(true) })
  .strict();

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
    mint_response: MintEnrollmentResponseSchema,
    sponsor_proposal_list_response: SponsorProposalListResponseSchema,
    sponsor_credential_summary: SponsorCredentialSummarySchema,
    sponsor_fellow_summary: SponsorFellowSummarySchema,
    sponsor_fellow_list_response: SponsorFellowListResponseSchema,
    sponsor_enrollment_decision_response: SponsorEnrollmentDecisionResponseSchema,
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
export type FellowLifecycleStatus = z.infer<typeof FellowLifecycleStatusSchema>;
export type FellowCredentialProfile = z.infer<typeof FellowCredentialProfileSchema>;
export type FellowRegistrationRequest = z.infer<typeof FellowRegistrationRequestSchema>;
export type EnrollmentApprovalCard = z.infer<typeof EnrollmentApprovalCardSchema>;
export type EnrollmentCapsuleProjection = z.infer<typeof EnrollmentCapsuleProjectionSchema>;
export type EnrollmentClaimResponse = z.infer<typeof EnrollmentClaimResponseSchema>;
export type EnrollmentHelloResponse = z.infer<typeof EnrollmentHelloResponseSchema>;
export type MintEnrollmentRequest = z.infer<typeof MintEnrollmentRequestSchema>;
export type SponsorEnrollmentDecision = z.infer<typeof SponsorEnrollmentDecisionSchema>;
export type MintEnrollmentResponse = z.infer<typeof MintEnrollmentResponseSchema>;
export type SponsorProposalListResponse = z.infer<typeof SponsorProposalListResponseSchema>;
export type SponsorCredentialSummary = z.infer<typeof SponsorCredentialSummarySchema>;
export type SponsorFellowSummary = z.infer<typeof SponsorFellowSummarySchema>;
export type SponsorFellowListResponse = z.infer<typeof SponsorFellowListResponseSchema>;
export type SponsorEnrollmentDecisionResponse = z.infer<
  typeof SponsorEnrollmentDecisionResponseSchema
>;
export type EnrollmentFlowPollRequest = z.infer<typeof EnrollmentFlowPollRequestSchema>;
export type RequestedScope = z.infer<typeof RequestedScopeSchema>;
export type EnrollmentGrantReduction = z.infer<typeof EnrollmentGrantReductionSchema>;
