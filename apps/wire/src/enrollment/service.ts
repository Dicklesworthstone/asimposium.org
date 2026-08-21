import {
  DeviceCodeStartRequestSchema,
  type DeviceCodeStartResponse,
  DeviceLookupRequestSchema,
  ENROLLMENT_SECRET_BYTES,
  ENROLLMENT_SECRET_TTL_MS,
  EnrollmentApprovedResponseSchema,
  EnrollmentDeniedResponseSchema,
  EnrollmentExpiredResponseSchema,
  EnrollmentFlowPollRequestSchema,
  type EnrollmentGrantReduction,
  EnrollmentPendingResponseSchema,
  EnrollmentSlowDownResponseSchema,
  type FellowCredentialProfile,
  type FellowLifecycleStatus,
  FellowNameSchema,
  FellowRegistrationCredentialFieldsSchema,
  FellowRegistrationRequestSchema,
  isTrustedAgoraOrigin,
  isTrustedStoaOrigin,
  type MintEnrollmentRequest,
  MintEnrollmentRequestSchema,
  OPERATOR_FELLOW_CAP_AUDIT_PAGE_SIZE,
  type OperatorFellowCapAuditCursorKey,
  type OperatorFellowCapOverrideRequest,
  OperatorFellowCapOverrideRequestSchema,
  type OperatorFellowCapOverrideResponse,
  OperatorFellowCapOverrideResponseSchema,
  PENDING_PROPOSAL_TTL_MS,
  type ProblemDocument,
  ProblemDocumentSchema,
  type RequestedScope,
  SPONSOR_FELLOW_PAGE_SIZE,
  type SponsorCredentialRevokeRequest,
  SponsorCredentialRevokeRequestSchema,
  type SponsorCredentialRevokeResponse,
  SponsorCredentialRevokeResponseSchema,
  type SponsorEnrollmentDecision,
  type SponsorEnrollmentDecisionCommand,
  SponsorEnrollmentDecisionCommandSchema,
  SponsorEnrollmentDecisionSchema,
  type SponsorFellowCursorKey,
  type SponsorFellowLifecycleRequest,
  SponsorFellowLifecycleRequestSchema,
  type SponsorFellowLifecycleResponse,
  SponsorFellowLifecycleResponseSchema,
  type SponsorPanicRequest,
  SponsorPanicRequestSchema,
  type SponsorPanicResponse,
  SponsorPanicResponseSchema,
  stoaHelloUrl,
} from "@asimposium/contracts";
import { redactCredentials } from "@asimposium/contracts/diagnostic-safety";
import { SERVICE_ENVELOPE_CLOCK_SKEW_SECONDS } from "../auth/envelope.ts";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ID_ATTEMPTS = 4;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const INITIAL_POLL_INTERVAL_SECONDS = 5;
export const MAX_POLL_INTERVAL_SECONDS = 30;
export const FELLOW_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const POLL_SLOW_DOWN_INCREMENT_SECONDS = 5;

/** W3.5: human-typed codes; the alphabet excludes 0/1/I/O confusion. */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const USER_CODE_RANDOM_CEILING =
  Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;
const MAX_USER_CODE_RANDOM_BATCHES = 8;
export const DEVICE_CODE_TTL_MS = 30 * 60 * 1_000;
export const DEVICE_LOOKUP_LOCKOUT_FAILURES = 5;
export const DEVICE_LOOKUP_LOCKOUT_WINDOW_MS = 15 * 60 * 1_000;
export const DEVICE_START_RATE_LIMIT_ATTEMPTS = 10;
export const DEVICE_START_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;
export const DEFAULT_SPONSOR_ACTIVE_FELLOW_LIMIT = 5;
/** W3.7 launch policy: successful distinct sponsor enrollment starts per rolling day. */
export const SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS = 10;
export const SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEVICE_RECLAIM_BATCH_SIZE = 100;
const ENROLLMENT_KEY_DERIVATION_SALT = new TextEncoder().encode(
  "asimposium-enrollment-key-derivation-v1",
);
const ENROLLMENT_REPLAY_KEY_INFO = new TextEncoder().encode("encrypted-replay-aes-gcm-v1");
const DEVICE_SOURCE_BUCKET_KEY_INFO = new TextEncoder().encode("device-source-bucket-hmac-v1");
const POLL_TERMINAL_REPLAY_PRINCIPAL_VERSION = "flow-terminal-v1";
export const SPONSOR_STEP_UP_WINDOW_SECONDS = 15 * 60;
export const SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS = SERVICE_ENVELOPE_CLOCK_SKEW_SECONDS;

function generateUserCode(random: EnrollmentRandom): string {
  const chars: string[] = [];
  for (let batch = 0; batch < MAX_USER_CODE_RANDOM_BATCHES && chars.length < 8; batch += 1) {
    for (const byte of randomBytes(random, 8)) {
      // 256 is not divisible by the 30-character alphabet. Reject the high
      // tail instead of mapping it with `%`, which would make sixteen characters
      // more likely and reduce the brute-force cost below the advertised one.
      if (byte >= USER_CODE_RANDOM_CEILING) continue;
      const character = USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (character === undefined) throw new TypeError("device user-code alphabet is unavailable");
      chars.push(character);
      if (chars.length === 8) break;
    }
  }
  if (chars.length !== 8) {
    throw new TypeError("secure random source could not produce a device user code");
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function fellowStatusCanAuthenticate(status: FellowLifecycleStatus): boolean {
  // Suspicious-review Fellows retain read access for sponsor diagnosis. Write
  // authorization must additionally quarantine that status in centralized policy.
  return status === "active" || status === "suspicious_review";
}

/** SQLite BINARY ordering for the opaque Fellow identity, reproduced in memory. */
function compareFellowIdBinary(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function compareFellowPageOrder(
  left: Pick<SponsorFellowRecord, "grantedAt" | "fellowId">,
  right: Pick<SponsorFellowRecord, "grantedAt" | "fellowId">,
): number {
  if (left.grantedAt !== right.grantedAt) return right.grantedAt - left.grantedAt;
  return compareFellowIdBinary(left.fellowId, right.fellowId);
}

function followsFellowCursor(record: SponsorFellowRecord, after: SponsorFellowCursorKey): boolean {
  return (
    record.grantedAt < after.granted_at ||
    (record.grantedAt === after.granted_at &&
      compareFellowIdBinary(record.fellowId, after.fellow_id) > 0)
  );
}

function fellowLifecycleTransitionAllowed(
  from: FellowLifecycleStatus,
  to: Exclude<FellowLifecycleStatus, "pending">,
): boolean {
  return (
    (from === "pending" && to === "active") ||
    (from === "active" && ["paused", "revoked", "compromised", "suspicious_review"].includes(to)) ||
    (from === "paused" && ["active", "revoked", "compromised", "suspicious_review"].includes(to)) ||
    (from === "suspicious_review" && ["active", "paused", "revoked", "compromised"].includes(to)) ||
    ((from === "revoked" || from === "compromised") && to === "archived")
  );
}

function sponsorStepUpIsFresh(authenticatedAt: number, now: number): boolean {
  const nowSeconds = Math.floor(now / 1_000);
  if (!Number.isSafeInteger(authenticatedAt) || !Number.isSafeInteger(nowSeconds)) return false;
  const age = nowSeconds - authenticatedAt;
  return (
    age >= -SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS &&
    age <= SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS
  );
}

function sponsorEnrollmentDecisionIntent(
  command: SponsorEnrollmentDecisionCommand,
): SponsorEnrollmentDecision {
  const { step_up_authenticated_at: _stepUpAuthenticatedAt, ...intent } = command;
  return SponsorEnrollmentDecisionSchema.parse(intent);
}

export type EnrollmentErrorCode =
  | "DECISION_BODY_INVALID"
  | "FLOW_INVALID"
  | "HARNESS_AS_NAME"
  | "IDEMPOTENCY_CONFLICT"
  | "NAME_INVALID"
  | "NAME_RESERVED"
  | "NAME_TAKEN"
  | "MODEL_AS_NAME"
  | "DECISION_TARGET_MISMATCH"
  | "DEVICE_CODE_BODY_INVALID"
  | "DEVICE_CODE_UNKNOWN"
  | "DEVICE_LOOKUP_BODY_INVALID"
  | "DEVICE_LOOKUP_LOCKED"
  | "DEVICE_START_RATE_LIMITED"
  | "FELLOW_CAP_REACHED"
  | "FELLOW_CREDENTIAL_CAP_REACHED"
  | "CREDENTIAL_REVOKE_BODY_INVALID"
  | "FELLOW_LIFECYCLE_BODY_INVALID"
  | "FELLOW_LIFECYCLE_NOT_CURRENT"
  | "OPERATOR_FELLOW_CAP_BODY_INVALID"
  | "OPERATOR_FELLOW_CAP_HISTORY_CURSOR_INVALID"
  | "OPERATOR_FELLOW_CAP_NOT_CURRENT"
  | "LIFECYCLE_BUSY"
  | "PAIRING_EXPIRED"
  | "PAIRING_INVALID"
  | "PROPOSAL_EXPIRED"
  | "PROPOSAL_NOT_PENDING"
  | "REGISTRATION_BODY_INVALID"
  | "SCOPE_ESCALATION"
  | "SCOPE_NOT_REDUCED"
  | "SPONSOR_ENROLLMENT_RATE_LIMITED"
  | "SPONSOR_BOOTSTRAP_BODY_INVALID"
  | "SPONSOR_PANIC_BODY_INVALID"
  | "STEP_UP_REQUIRED"
  | "TOKEN_ALREADY_ISSUED"
  | "WRONG_PRINCIPAL";

/** An intentionally opaque failure: no credential or request value is retained in the message. */
export class EnrollmentError extends Error {
  readonly code: EnrollmentErrorCode;
  readonly suggestions: readonly string[];

  constructor(code: EnrollmentErrorCode, suggestions: readonly string[] = []) {
    super(code);
    this.name = "EnrollmentError";
    this.code = code;
    this.suggestions = suggestions;
  }
}

/** A sponsor-owned rolling-budget refusal with a truthful coarse retry delay. */
export class SponsorEnrollmentRateLimitError extends EnrollmentError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("SPONSOR_ENROLLMENT_RATE_LIMITED");
    this.name = "SponsorEnrollmentRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Replay encryption is a deployment binding, not a request concern.  This
 * error intentionally carries no envelope, key, or credential material.
 */
export class EnrollmentReplayConfigurationError extends Error {
  constructor() {
    super("enrollment replay protection is unavailable");
    this.name = "EnrollmentReplayConfigurationError";
  }
}

/**
 * The configured Stoa origin is absent or untrusted. Distinct from the replay
 * error so an operator can tell which binding is wrong, while both surface to
 * a caller as the same opaque 503: which binding a deployment is missing is
 * operator information.
 */
export class EnrollmentStoaOriginError extends Error {
  constructor() {
    super("enrollment stoa origin is unavailable");
    this.name = "EnrollmentStoaOriginError";
  }
}

/**
 * The configured Agora origin is absent or untrusted, the apex twin of the
 * Stoa binding error. Same operator-facing 503 face; different named cause.
 */
export class EnrollmentAgoraOriginError extends Error {
  constructor() {
    super("enrollment agora origin is unavailable");
    this.name = "EnrollmentAgoraOriginError";
  }
}

/** A D1 failure is operational, never an enrollment or credential verdict. */
export class EnrollmentPersistenceError extends Error {
  constructor() {
    super("enrollment persistence is unavailable");
    this.name = "EnrollmentPersistenceError";
  }
}

/** A proven opaque-identifier collision whose transaction did not commit. */
export class EnrollmentIdentifierCollisionError extends Error {
  constructor() {
    super("enrollment identifier collision");
    this.name = "EnrollmentIdentifierCollisionError";
  }
}

export type EnrollmentPrincipal =
  | { readonly type: "sponsor"; readonly sponsorId: string }
  | {
      readonly type: "operator";
      readonly operatorId: string;
      /** Non-secret key id from the Worker-verified service envelope. */
      readonly serviceEnvelopeKid: string;
    }
  | { readonly type: "fellow"; readonly fellowId: string }
  | { readonly type: "service"; readonly serviceId: string };

/**
 * Non-secret hygiene for one credential in the owning sponsor's console.
 */
export interface SponsorCredentialRecord {
  readonly credentialId: string;
  readonly profile: FellowCredentialProfile;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt?: number;
  readonly active: boolean;
}

/** A Fellow as the sponsor console lists it: grants plus credential hygiene. */
export interface SponsorFellowRecord {
  readonly fellowId: string;
  readonly name: string;
  readonly model: string;
  readonly harness: string;
  readonly status: FellowLifecycleStatus;
  readonly grantedScopes: readonly RequestedScope[];
  readonly grantedResources: EnrollmentResourceGrants;
  readonly grantedAt: number;
  readonly credentials: readonly SponsorCredentialRecord[];
}

/** One bounded, deterministic sponsor inventory page. */
export interface SponsorFellowPage {
  readonly fellows: readonly SponsorFellowRecord[];
  /** Present only when another page is reachable after this one. */
  readonly nextCursor?: SponsorFellowCursorKey;
}

export interface EnrollmentClock {
  now(): number;
}

export interface EnrollmentRandom {
  bytes(length: number): Uint8Array;
}

export interface EnrollmentWriteOptions {
  /** Request header value; never placed in a URL, diagnostic, or event body. */
  readonly idempotencyKey?: string;
}

export interface DeviceStartOptions extends EnrollmentWriteOptions {
  /**
   * Cloudflare's canonical client address. The service HMAC-buckets it before it
   * reaches storage; callers must never pass X-Forwarded-For or a raw
   * user-controlled bucket name here.
   */
  readonly trustedClientAddress: string;
}

export interface EnrollmentReplayProtector {
  seal(plaintext: string): Promise<EncryptedEnrollmentReplay>;
  open(encrypted: EncryptedEnrollmentReplay): Promise<string>;
  /** Stable keyed bucket; a D1 read alone must not reveal an enumerable IPv4 source. */
  sourceBucket(trustedClientAddress: string): Promise<string>;
}

/** Stored in D1; neither field is a plaintext credential or protocol response. */
export interface EncryptedEnrollmentReplay {
  readonly ciphertext: string;
  readonly initializationVector: string;
}

export interface MintedEnrollment {
  readonly enrollmentId: string;
  /** Returned once to the sponsor’s minting flow; never kept by the store. */
  readonly secret: string;
  readonly expiresAt: number;
}

export interface EnrollmentApprovalCard {
  readonly enrollmentId: string;
  readonly proposalId: string;
  readonly name: string;
  readonly model: string;
  readonly harness: string;
  readonly reasoningEffort?: string;
  readonly toolsNote?: string;
  readonly requestedScopes: readonly RequestedScope[];
  readonly requestedResources: EnrollmentResourceGrants;
  /** The actual proposal state, never inferred from requested grant fields. */
  readonly status: "pending" | "approved" | "reduced" | "denied" | "expired";
  /** `null` means the proposal has not granted any live authority. */
  readonly effectiveGrantedScopes: readonly RequestedScope[] | null;
  /** `null` means the proposal has not granted any live resource authority. */
  readonly effectiveGrantedResources: EnrollmentResourceGrants | null;
  readonly proposalExpiresAt: number;
}

/** Public-only join capsule material. It contains no credential, handle, or token. */
export interface EnrollmentCapsule {
  readonly enrollmentId: string;
  readonly secretExpiresAt: number;
}

export interface EnrollmentClaimResult {
  /** A high-entropy body-only credential; no proposal ID is a poll credential. */
  readonly flowHandle: string;
}

export type EnrollmentFlowResult =
  | { readonly status: "authorization_pending"; readonly retry_after_seconds: number }
  | { readonly status: "access_denied" }
  | { readonly status: "expired_token" }
  | { readonly status: "slow_down"; readonly retry_after_seconds: number }
  | {
      readonly status: "approved";
      readonly token: string;
      readonly hello_url: string;
      readonly suggested_next: "GET /v1/hello with the bearer token";
    };

export interface EnrollmentRecord {
  readonly enrollmentId: string;
  /** Mutable: an unbound device enrollment ("") binds to its first decider. */
  sponsorId: string;
  readonly secretHash: string;
  readonly createdAt: number;
  readonly secretExpiresAt: number;
  readonly requestedScopes: readonly RequestedScope[];
  readonly requestedResources: EnrollmentResourceGrants;
  /** W3.5: join-URL enrollments are minted by a sponsor; device enrollments bind at decision. */
  readonly kind?: "join-url" | "device";
  /** Durable poll expiry; retained after the short human-code mapping is reclaimed. */
  readonly deviceExpiresAt?: number;
  /** Present only after bounded authorized cleanup removes the expired mapping. */
  readonly deviceMappingReclaimedAt?: number;
  invalidated: boolean;
  secretConsumedAt?: number;
  proposal?: ProposalRecord;
}

/** W3.5: the atomic device-flow write — record, pending proposal, and the user-code mapping. */
export interface DeviceCreateInput {
  readonly record: EnrollmentRecord;
  readonly proposal: ProposalRecord;
  readonly userCodeHash: string;
  readonly deviceExpiresAt: number;
  /** Keyed HMAC-SHA-256 source bucket; never a raw client address. */
  readonly clientBucket: string;
  readonly startWindowBeginning: number;
  readonly startLimit: number;
  readonly reclaimBatchSize: number;
}

export interface DeviceLookupAttempt {
  readonly sponsorId: string;
  readonly userCodeHash: string;
  readonly now: number;
  readonly windowBeginning: number;
  readonly failureLimit: number;
  readonly reclaimBatchSize: number;
}

export interface ProposalRecord {
  readonly proposalId: string;
  readonly fellowId: string;
  readonly flowHandleHash: string;
  readonly name: string;
  readonly model: string;
  readonly harness: string;
  readonly reasoningEffort?: string;
  readonly toolsNote?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: "pending" | "approved" | "reduced" | "denied" | "expired";
  grantedScopes?: readonly RequestedScope[];
  grantedResources?: EnrollmentResourceGrants;
  grantedAt?: number;
  tokenHash?: string;
  tokenIssuedAt?: number;
  pollIntervalSeconds: number;
  lastPollAt?: number;
}

export interface EnrollmentResourceGrants {
  readonly problemBinding?: string;
  readonly firstDirective?: string;
  readonly eventBudget?: number;
  readonly artifactBudgetBytes?: number;
  readonly fellowGrantExpiresAt?: number;
}

/** Fellow + credential binding after an atomic lifecycle-aware authentication. */
export interface FellowCredentialBinding {
  readonly fellowId: string;
  readonly credentialId: string;
  readonly sponsorId: string;
  readonly name: string;
  readonly model: string;
  readonly harness: string;
  readonly grantedScopes: readonly RequestedScope[];
  readonly grantedResources: EnrollmentResourceGrants;
  readonly tokenHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt?: number;
  readonly revokedAt?: number;
  readonly credentialProfile: FellowCredentialProfile;
  readonly fellowStatus: FellowLifecycleStatus;
}

/**
 * The one place Fellow effectful-write authorization is decided (Fable §5,
 * "authorization is computed by centralized policy functions over (account
 * state, scopes, grants, membership, target visibility), never by role checks
 * scattered through route files").
 *
 * Deliberately PURE: no clock, no store, no request. `now` and every input are
 * supplied by the caller, so W4 and W5 route owners can call it without this
 * module having to know their routes exist, and so the whole allow/refuse
 * matrix is testable without mounting anything.
 *
 * The effect vocabulary is the granted-scope vocabulary plus internal
 * unscoped writes. Session admission and closure are lifecycle operations, not
 * sponsor-approved public scopes; keeping them here still makes their policy
 * decision central without inventing a grant the sponsor never approved.
 */
export type FellowUnscopedEffect = "workshop.push" | "session.open" | "session.close";

export type FellowWriteEffect = RequestedScope | FellowUnscopedEffect;

function isUnscopedEffect(effect: FellowWriteEffect): effect is FellowUnscopedEffect {
  return effect === "workshop.push" || effect === "session.open" || effect === "session.close";
}

/** Fable §6.8 membership roles. Only the observer promotion restriction is hard. */
export type FellowProblemMembershipRole = "observer" | "contributor" | "steward";

/**
 * Publication and discovery are deliberately separate. Fable §6.2 says an
 * unlisted problem is still published and guessable; it is not a third privacy
 * state beside `published` and `private-draft`.
 */
export interface FellowExistingProblemTarget {
  readonly kind: "existing-problem";
  readonly problemId: string;
  readonly publication: "published" | "private-draft";
  readonly unlisted: boolean;
  /** Undefined means the Fellow has not joined this problem. */
  readonly membershipRole?: FellowProblemMembershipRole;
}

/** `propose-problems` creates a draft; publication remains sponsor/steward-gated. */
export interface FellowNewProblemTarget {
  readonly kind: "new-problem";
  readonly initialPublication: "private-draft" | "published";
  readonly unlisted: boolean;
}

/**
 * A session opener has not joined yet. This target intentionally carries no
 * membership or visibility fields, so admission can precede every
 * existence-sensitive problem/session lookup.
 */
export interface FellowSessionAdmissionTarget {
  readonly kind: "session-admission";
  readonly problemId: string;
}

/** A close is authorized against the existing owned session and actual membership. */
export interface FellowSessionCloseTarget {
  readonly kind: "session-close";
  readonly problemId: string;
  readonly membershipRole?: FellowProblemMembershipRole;
}

export type FellowWriteTarget =
  | FellowExistingProblemTarget
  | FellowNewProblemTarget
  | FellowSessionAdmissionTarget
  | FellowSessionCloseTarget;

/** Consumption is credential-grant-wide, not merely per target problem. */
export interface FellowWriteGrantUsage {
  readonly eventsRecorded: number;
  readonly artifactBytesRecorded: number;
}

/**
 * Operator-channel only. ADR-18 / Fable §7.7: policy refusals teach minimally,
 * because a refusal that names its trigger is an iteration oracle for the
 * caller it just refused. This value goes to the OPS.2a diagnostic; it must
 * never be projected into a caller-facing response.
 */
export type FellowAuthorizationRefusalReason =
  | "credential_revoked"
  | "credential_not_yet_valid"
  | "credential_expired"
  | "fellow_status_not_writable"
  | "scope_not_granted"
  | "grant_expired"
  | "problem_binding_mismatch"
  | "not_a_member"
  | "role_not_permitted"
  | "target_not_writable"
  | "event_budget_exhausted"
  | "artifact_budget_unverifiable"
  | "artifact_budget_exhausted"
  | "suspicious_review_write_blocked";

export interface FellowAuthorizationAllow {
  readonly decision: "allow";
  readonly effect: FellowWriteEffect;
}

export interface FellowAuthorizationQuarantine {
  readonly decision: "quarantine";
  readonly effect: FellowWriteEffect;
  /**
   * A fresh write is blocked until an operator changes lifecycle state. This
   * policy result does not create a held object, replay, or review-queue row.
   */
  readonly handling: "blocked-pending-operator-review";
}

export interface FellowAuthorizationRefusal {
  readonly decision: "refuse";
  /** Canonical strict RFC 7807 face; it carries no internal refusal reason. */
  readonly callerProblem: ProblemDocument;
}

export type FellowAuthorizationDecision =
  | FellowAuthorizationAllow
  | FellowAuthorizationQuarantine
  | FellowAuthorizationRefusal;

export type FellowAuthorizationOperatorEvaluation =
  | { readonly decision: FellowAuthorizationAllow; readonly operatorReason: null }
  | {
      readonly decision: FellowAuthorizationQuarantine;
      readonly operatorReason: "suspicious_review_quarantine";
    }
  | {
      readonly decision: FellowAuthorizationRefusal;
      readonly operatorReason: FellowAuthorizationRefusalReason;
    };

const FELLOW_UNAUTHORIZED_PROBLEM = ProblemDocumentSchema.parse({
  type: "https://asimposium.org/errors/UNAUTHORIZED",
  title: "Authorization was not accepted",
  status: 401,
  code: "UNAUTHORIZED",
  detail: "The request did not include an authorization accepted by this route.",
  fix_hint: "Obtain a fresh sponsor authorization and retry the request.",
});

/**
 * The caller-facing projection. Every refusal produces byte-identical output,
 * whatever the reason was, which is what makes the coarse class real rather
 * than merely intended.
 */
export function fellowAuthorizationResponse(
  decision: FellowAuthorizationDecision,
): ProblemDocument | undefined {
  return decision.decision === "refuse" ? decision.callerProblem : undefined;
}

function refusalEvaluation(
  reason: FellowAuthorizationRefusalReason,
): FellowAuthorizationOperatorEvaluation {
  return {
    decision: {
      decision: "refuse",
      // A fresh object stops a caller mutating a module-global problem face.
      callerProblem: { ...FELLOW_UNAUTHORIZED_PROBLEM },
    },
    operatorReason: reason,
  };
}

/**
 * Decide one Fellow effectful write.
 *
 * The order below is fixed so the matrix is deterministic: a credential that
 * fails several conditions always reports the same first reason to the
 * operator, and a test can therefore pin exactly one row per input. Callers
 * see none of that ordering.
 *
 * Reads are not routed through this function because Fable §5 keeps them for a
 * suspicious-review Fellow. Internal session lifecycle writes and workshop
 * pushes skip only the granted-scope check: account state, resource grants,
 * target constraints, budgets, and suspicious-review handling still apply
 * centrally.
 */
function evaluateFellowWriteAuthorization(input: {
  readonly effect: FellowWriteEffect;
  readonly credential: FellowCredentialBinding;
  readonly target: FellowWriteTarget;
  readonly usage: FellowWriteGrantUsage;
  /** Required, and checked, only for `upload-artifacts`. */
  readonly artifactBytesRequested?: number;
  readonly now: number;
}): FellowAuthorizationOperatorEvaluation {
  const { credential, target, effect, usage, now } = input;

  if (credential.revokedAt !== undefined && credential.revokedAt <= now) {
    return refusalEvaluation("credential_revoked");
  }
  if (now < credential.issuedAt) return refusalEvaluation("credential_not_yet_valid");
  if (now >= credential.expiresAt) return refusalEvaluation("credential_expired");

  const quarantined = credential.fellowStatus === "suspicious_review";
  if (credential.fellowStatus !== "active" && !quarantined) {
    return refusalEvaluation("fellow_status_not_writable");
  }

  if (!isUnscopedEffect(effect) && !credential.grantedScopes.includes(effect)) {
    return refusalEvaluation("scope_not_granted");
  }

  const grantExpiresAt = credential.grantedResources.fellowGrantExpiresAt;
  if (grantExpiresAt !== undefined && now >= grantExpiresAt) {
    return refusalEvaluation("grant_expired");
  }

  const binding = credential.grantedResources.problemBinding;
  if (effect === "propose-problems") {
    // A scoped-to-one-existing-problem credential cannot create an unrelated
    // problem, but an unbound credential needs no fictitious membership row.
    if (binding !== undefined) return refusalEvaluation("problem_binding_mismatch");
    if (target.kind !== "new-problem" || target.initialPublication !== "private-draft") {
      return refusalEvaluation("target_not_writable");
    }
  } else if (effect === "session.open") {
    if (target.kind !== "session-admission") return refusalEvaluation("target_not_writable");
    if (binding !== undefined && binding !== target.problemId) {
      return refusalEvaluation("problem_binding_mismatch");
    }
  } else if (effect === "session.close") {
    if (target.kind !== "session-close") return refusalEvaluation("target_not_writable");
    if (binding !== undefined && binding !== target.problemId) {
      return refusalEvaluation("problem_binding_mismatch");
    }
    if (target.membershipRole === undefined) return refusalEvaluation("not_a_member");
  } else {
    if (target.kind !== "existing-problem") return refusalEvaluation("target_not_writable");
    if (binding !== undefined && binding !== target.problemId) {
      return refusalEvaluation("problem_binding_mismatch");
    }
    if (target.membershipRole === undefined) return refusalEvaluation("not_a_member");

    // Role labels are advisory except for this one Fable §9.3 hard boundary.
    if (effect === "promote" && target.membershipRole === "observer") {
      return refusalEvaluation("role_not_permitted");
    }

    // Promotion and ledger review cannot make a private draft public by side
    // effect. Artifact uploads remain allowed for a granted member because the
    // private index, not the global CAS hash, controls visibility.
    if (target.publication === "private-draft" && (effect === "promote" || effect === "review")) {
      return refusalEvaluation("target_not_writable");
    }
  }

  const eventBudget = credential.grantedResources.eventBudget;
  if (eventBudget !== undefined && usage.eventsRecorded >= eventBudget) {
    return refusalEvaluation("event_budget_exhausted");
  }

  if (effect === "upload-artifacts") {
    const requested = input.artifactBytesRequested;
    if (requested === undefined || !Number.isSafeInteger(requested) || requested < 0) {
      return refusalEvaluation("artifact_budget_unverifiable");
    }
    const artifactBudget = credential.grantedResources.artifactBudgetBytes;
    if (
      artifactBudget !== undefined &&
      (usage.artifactBytesRecorded > artifactBudget - requested || requested > artifactBudget)
    ) {
      return refusalEvaluation("artifact_budget_exhausted");
    }
  }

  if (quarantined) {
    if (effect === "session.open" || effect === "session.close") {
      return refusalEvaluation("suspicious_review_write_blocked");
    }
    return {
      decision: {
        decision: "quarantine",
        effect,
        handling: "blocked-pending-operator-review",
      },
      operatorReason: "suspicious_review_quarantine",
    };
  }

  return { decision: { decision: "allow", effect }, operatorReason: null };
}

type FellowWriteAuthorizationInput = Parameters<typeof evaluateFellowWriteAuthorization>[0];

/** Caller-safe central authorization seam. No internal reason is serializable. */
export function authorizeFellowWrite(
  input: FellowWriteAuthorizationInput,
): FellowAuthorizationDecision {
  return evaluateFellowWriteAuthorization(input).decision;
}

/**
 * Operator-only view over the same pure evaluator. Diagnostic sinks use this;
 * HTTP callers use `authorizeFellowWrite` and therefore cannot receive the
 * internal reason by accidentally serializing a decision.
 */
export function inspectFellowWriteAuthorization(
  input: FellowWriteAuthorizationInput,
): FellowAuthorizationOperatorEvaluation {
  return evaluateFellowWriteAuthorization(input);
}

export interface EnrollmentStorageSnapshot {
  readonly enrollmentId: string;
  readonly secretHash: string;
  readonly secretConsumedAt?: number;
  readonly flowHandleHash?: string;
  readonly tokenHash?: string;
  readonly fellowId?: string;
}

export interface ClaimAttempt {
  readonly enrollmentId: string;
  readonly secretHash: string;
  readonly proposal: ProposalRecord;
  readonly now: number;
}

export interface DecisionAttempt {
  readonly enrollmentId: string;
  readonly sponsorId: string;
  readonly decision: SponsorEnrollmentDecision;
  readonly now: number;
}

export interface TokenFactoryResult {
  readonly token: string;
  readonly tokenHash: string;
}

export interface PollAttempt {
  readonly flowHandleHash: string;
  readonly now: number;
  readonly createToken: () => Promise<TokenFactoryResult>;
  /**
   * The store invokes this only after it knows a terminal protocol result and
   * immediately before its D1 batch commits that result. Pending and slow-down
   * observations deliberately leave the stable key free. The callback seals
   * the exact terminal response; only its ciphertext reaches D1.
   */
  readonly replayFor?: (decision: PollDecision) => Promise<EnrollmentIdempotencyWrite | undefined>;
}

export interface PollDecision {
  readonly kind: "pending" | "slow-down" | "denied" | "expired" | "issued" | "already-issued";
  readonly retryAfterSeconds?: number;
  readonly token?: string;
}

export interface IdempotencyAttempt {
  readonly scope:
    | "mint"
    | "claim"
    | "decision"
    | "poll"
    | "device-start"
    | "credential-revoke"
    | "fellow-lifecycle"
    | "sponsor-panic"
    | "operator-fellow-cap";
  readonly principalScope: string;
  readonly key: string;
  readonly digest: string;
  readonly now: number;
}

export interface EnrollmentIdempotencyWrite extends IdempotencyAttempt {
  readonly encryptedResponse: EncryptedEnrollmentReplay;
}

export interface EnrollmentIdempotencyReplay {
  readonly digest: string;
  readonly encryptedResponse: EncryptedEnrollmentReplay;
}

export class EnrollmentIdempotencyRaceError extends Error {
  constructor() {
    super("idempotency record was committed by a concurrent request");
    this.name = "EnrollmentIdempotencyRaceError";
  }
}

export interface CredentialRevokeAttempt {
  readonly sponsorId: string;
  readonly fellowId: string;
  readonly credentialId: string;
  readonly eventId: string;
  readonly requestId: string;
  readonly effectiveAt: number;
  readonly replayFor?: (
    result: LifecycleCommandResult,
  ) => Promise<EnrollmentIdempotencyWrite | undefined>;
}

export interface FellowLifecycleAttempt {
  readonly sponsorId: string;
  readonly fellowId: string;
  readonly toStatus: Exclude<FellowLifecycleStatus, "pending">;
  readonly eventId: string;
  readonly requestId: string;
  readonly effectiveAt: number;
  readonly replayFor?: (
    result: LifecycleCommandResult,
  ) => Promise<EnrollmentIdempotencyWrite | undefined>;
}

export interface SponsorPanicAttempt {
  readonly sponsorId: string;
  readonly eventId: string;
  readonly requestId: string;
  readonly effectiveAt: number;
  readonly replayFor?: (
    result: LifecycleCommandResult,
  ) => Promise<EnrollmentIdempotencyWrite | undefined>;
}

/** One operator-authenticated, append-only sponsor-cap command. */
export interface OperatorFellowCapOverrideAttempt {
  readonly sponsorId: string;
  readonly operatorId: string;
  readonly auditEventId: string;
  readonly expectedActiveFellowLimit: number;
  readonly expectedSponsorSeq: number;
  readonly activeFellowLimit: number;
  readonly reason: string;
  readonly stepUpAuthenticatedAt: number;
  readonly signerKid: string;
  readonly requestId: string;
  readonly effectiveAt: number;
  readonly replayFor?: (
    result: OperatorFellowCapOverrideResult,
  ) => Promise<EnrollmentIdempotencyWrite | undefined>;
}

export interface OperatorFellowCapOverrideResult {
  readonly sponsorSeq: number;
  readonly previousActiveFellowLimit: number;
  readonly activeFellowLimit: number;
  readonly effectiveAt: number;
}

export interface OperatorFellowCapState {
  readonly activeFellowLimit: number;
  readonly sponsorSeq: number;
}

/** One immutable operator authorization receipt, newest sequence first. */
export interface OperatorFellowCapAuditRecord {
  readonly auditEventId: string;
  readonly sponsorId: string;
  readonly operatorId: string;
  readonly sponsorSeq: number;
  readonly previousActiveFellowLimit: number;
  readonly activeFellowLimit: number;
  readonly reason: string;
  readonly stepUpAuthenticatedAt: number;
  readonly signerKid: string;
  readonly effectiveAt: number;
}

/** Bounded keyset page over immutable cap receipts. */
export interface OperatorFellowCapAuditPage {
  readonly auditEvents: readonly OperatorFellowCapAuditRecord[];
  readonly nextCursor?: OperatorFellowCapAuditCursorKey;
}

export interface LifecycleCommandResult {
  readonly sponsorSeq: number;
  readonly effectiveAt: number;
}

/**
 * The persistence seam intentionally exposes only atomic state transitions.
 * A D1 adapter can implement it without teaching a route about secret hashes,
 * pending-expiry races, or one-token-winner semantics.
 */
export interface EnrollmentStore {
  create(
    record: EnrollmentRecord,
    replacesEnrollmentId?: string,
    idempotency?: EnrollmentIdempotencyWrite,
  ): Promise<boolean>;
  claim(attempt: ClaimAttempt, idempotency?: EnrollmentIdempotencyWrite): Promise<void>;
  /**
   * Credential-only preflight for teachable name feedback. The final claim
   * transition repeats this check and burns the secret atomically.
   */
  verifyClaimCredentials(enrollmentId: string, secretHash: string, now: number): Promise<void>;
  decision(attempt: DecisionAttempt, idempotency?: EnrollmentIdempotencyWrite): Promise<void>;
  approvalCard(
    enrollmentId: string,
    sponsorId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard>;
  /**
   * Every pending card the sponsor must see, oldest first. Due rows are swept
   * to `expired` first, matching approvalCard's lazy-expiry rule.
   */
  pendingApprovalCardsBySponsor(sponsorId: string, now: number): Promise<EnrollmentApprovalCard[]>;
  /** Approval grants and non-secret credential hygiene for one sponsor-console page. */
  fellowsBySponsor(
    sponsorId: string,
    now: number,
    after?: SponsorFellowCursorKey,
  ): Promise<SponsorFellowPage>;
  /**
   * W3.1: upsert the sponsor row. Returns true when this call created it;
   * false means it only moved last_seen_at.
   */
  bootstrapSponsor(sponsorId: string, now: number): Promise<boolean>;
  revokeCredential(attempt: CredentialRevokeAttempt): Promise<LifecycleCommandResult>;
  transitionFellow(attempt: FellowLifecycleAttempt): Promise<LifecycleCommandResult>;
  panicSponsor(attempt: SponsorPanicAttempt): Promise<LifecycleCommandResult>;
  overrideSponsorFellowCap(
    attempt: OperatorFellowCapOverrideAttempt,
  ): Promise<OperatorFellowCapOverrideResult>;
  sponsorFellowCap(sponsorId: string): Promise<OperatorFellowCapState>;
  sponsorFellowCapAudit(
    sponsorId: string,
    after?: OperatorFellowCapAuditCursorKey,
  ): Promise<OperatorFellowCapAuditPage>;
  /** W3.5: create a device enrollment, its pending proposal, and the user-code mapping, atomically. */
  deviceCreate(input: DeviceCreateInput, idempotency?: EnrollmentIdempotencyWrite): Promise<void>;
  /**
   * W3.5: atomically enforce the sponsor lockout, resolve the pending card,
   * and persist exactly one failed lookup. Successful lookups do not grow the
   * failure ledger. Unknown codes and lockout remain opaque EnrollmentErrors.
   */
  deviceLookup(attempt: DeviceLookupAttempt): Promise<EnrollmentApprovalCard>;
  /** W3.5: the decision-path card for an unbound device enrollment (kind=device, no sponsor yet). */
  deviceApprovalCardForDecision(enrollmentId: string, now: number): Promise<EnrollmentApprovalCard>;
  capsule(enrollmentId: string, now: number): Promise<EnrollmentCapsule>;
  poll(attempt: PollAttempt): Promise<PollDecision>;
  availabilitySuggestions(name: string): Promise<readonly string[]>;
  /** Atomically validates lifecycle state and records a successful use. */
  authenticateCredential(
    tokenHash: string,
    now: number,
    expectedProfile: FellowCredentialProfile,
  ): Promise<FellowCredentialBinding | undefined>;
  idempotencyReplay(attempt: IdempotencyAttempt): Promise<EnrollmentIdempotencyReplay | undefined>;
}

const systemClock: EnrollmentClock = { now: () => Date.now() };
const systemRandom: EnrollmentRandom = {
  bytes: (length) => {
    const output = new Uint8Array(length);
    crypto.getRandomValues(output);
    return output;
  },
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += BASE64URL[(buffer >> bits) & 0x3f];
    }
  }
  if (bits > 0) output += BASE64URL[(buffer << (6 - bits)) & 0x3f];
  return output;
}

function base64UrlToBytes(value: string): Uint8Array {
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of value) {
    const index = BASE64URL.indexOf(character);
    if (index < 0) throw new TypeError("invalid base64url replay encoding");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(output);
}

/**
 * AES-GCM envelope for idempotent response replay. The caller supplies one
 * stable 256-bit deployment root. HKDF derives separate AES replay and HMAC
 * source-bucket keys; only ciphertext, a random IV, and keyed source buckets
 * enter D1. There is deliberately no random default: an isolate restart must
 * reproduce both derived keys.
 */
export class AesGcmEnrollmentReplayProtector implements EnrollmentReplayProtector {
  readonly #replayKey: Promise<CryptoKey>;
  /**
   * Decrypt-only compatibility for rows sealed before replay/source key
   * separation. Those D1 rows expire after the fixed idempotency-retention
   * window; new rows are never sealed with this key.
   */
  readonly #legacyReplayKey: Promise<CryptoKey>;
  readonly #sourceBucketKey: Promise<CryptoKey>;
  readonly #random: EnrollmentRandom;

  constructor(key: Uint8Array, random: EnrollmentRandom = systemRandom) {
    if (key.length !== ENROLLMENT_SECRET_BYTES) {
      throw new TypeError("replay protector requires a 256-bit key");
    }
    // `Buffer.prototype.slice()` aliases its source and exposes the whole
    // pooled backing allocation through `.buffer`. Own an exact plain typed
    // array so caller mutation cannot rotate the replay key after construction
    // and WebCrypto receives exactly 32 bytes.
    const rootBytes = new Uint8Array(key.length);
    rootBytes.set(key);
    this.#legacyReplayKey = crypto.subtle.importKey(
      "raw",
      rootBytes.slice().buffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const rootKey = crypto.subtle.importKey("raw", rootBytes.slice().buffer, "HKDF", false, [
      "deriveKey",
    ]);
    this.#replayKey = rootKey.then((material) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: ENROLLMENT_KEY_DERIVATION_SALT,
          info: ENROLLMENT_REPLAY_KEY_INFO,
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
    this.#sourceBucketKey = rootKey.then((material) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: ENROLLMENT_KEY_DERIVATION_SALT,
          info: DEVICE_SOURCE_BUCKET_KEY_INFO,
        },
        material,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      ),
    );
    this.#random = random;
  }

  async seal(plaintext: string): Promise<EncryptedEnrollmentReplay> {
    const initializationVector = randomBytes(this.#random, 12);
    const key = await this.#replayKey;
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: initializationVector.slice().buffer },
      key,
      encoded.buffer,
    );
    return {
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
      initializationVector: bytesToBase64Url(initializationVector),
    };
  }

  async open(encrypted: EncryptedEnrollmentReplay): Promise<string> {
    let initializationVector: Uint8Array;
    let ciphertext: Uint8Array;
    try {
      initializationVector = base64UrlToBytes(encrypted.initializationVector);
      ciphertext = base64UrlToBytes(encrypted.ciphertext);
      if (initializationVector.length !== 12 || ciphertext.length < 16) {
        throw new TypeError("invalid encrypted replay envelope");
      }
    } catch {
      throw new EnrollmentReplayConfigurationError();
    }

    for (const keyPromise of [this.#replayKey, this.#legacyReplayKey]) {
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: initializationVector.slice().buffer },
          await keyPromise,
          ciphertext.slice().buffer,
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        // AES-GCM authentication selects the current or predecessor key. The
        // caller receives one coarse configuration failure only after both
        // authenticated decryptions fail.
      }
    }
    throw new EnrollmentReplayConfigurationError();
  }

  async sourceBucket(trustedClientAddress: string): Promise<string> {
    const key = await this.#sourceBucketKey;
    const material = new TextEncoder().encode(`device-start-source-v1\0${trustedClientAddress}`);
    const signature = await crypto.subtle.sign("HMAC", key, material.slice().buffer);
    return [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
}

/**
 * Builds the mandatory stable replay protector from an injected base64url
 * binding.  Callers must supply the same 256-bit value to every isolate that
 * shares a D1 database; this function intentionally has no fallback.
 */
export function enrollmentReplayProtectorFromBase64Url(
  encodedKey: string | undefined,
): EnrollmentReplayProtector {
  try {
    if (encodedKey === undefined || !/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
      throw new TypeError("missing replay key");
    }
    return new AesGcmEnrollmentReplayProtector(base64UrlToBytes(encodedKey));
  } catch {
    throw new EnrollmentReplayConfigurationError();
  }
}

function bytesToCrockford(bytes: Uint8Array, length: number): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      bits -= 5;
      output += CROCKFORD32[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0 && output.length < length) output += CROCKFORD32[(buffer << (5 - bits)) & 0x1f];
  return output.padEnd(length, "0");
}

function randomBytes(random: EnrollmentRandom, length: number): Uint8Array {
  const bytes = random.bytes(length);
  if (bytes.length !== length)
    throw new TypeError("secure random source returned incorrect length");
  return bytes;
}

function generateEnrollmentId(random: EnrollmentRandom): string {
  return `ASIMP-EN-${bytesToCrockford(randomBytes(random, 10), 16)}`;
}

function generateVersionedSecret(prefix: "v1" | "flow_v1", random: EnrollmentRandom): string {
  return `${prefix}.${bytesToBase64Url(randomBytes(random, ENROLLMENT_SECRET_BYTES))}`;
}

function generateUlid(now: number, random: EnrollmentRandom): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("clock returned invalid time");
  let timestamp = now;
  let time = "";
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD32[timestamp % 32] + time;
    timestamp = Math.floor(timestamp / 32);
  }
  return `${time}${bytesToCrockford(randomBytes(random, 10), 16)}`;
}

function generateFellowToken(now: number, random: EnrollmentRandom): string {
  return `asimp_ag_${generateUlid(now, random)}_${bytesToBase64Url(
    randomBytes(random, ENROLLMENT_SECRET_BYTES),
  )}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const width = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < width; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

const RESERVED_FELLOW_NAMES = new Set([
  "admin",
  "charter",
  "claude",
  "claude-code",
  "codex",
  "gemini",
  "gpt-5-6",
  "grok",
  "system",
  "symposiarch",
]);
const MODEL_NAMES = new Set(["claude", "codex", "gemini", "gpt-5-6", "grok"]);
const HARNESS_NAMES = new Set(["claude-code", "codex", "gemini-cli", "grok-build"]);
const UNAMBIGUOUS_HARNESS_NAMES = ["claude-code", "gemini-cli", "grok-build"] as const;
const PROFANITY_DENYLIST = new Set(["asshole", "bitch", "cunt", "fuck", "shit"]);
const PRODUCT_IDENTITIES = [
  "anthropic",
  "claude",
  "codex",
  "gemini",
  "gpt-5-6",
  "grok",
  "openai",
] as const;

function leetNormalized(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("@", "a")
    .replaceAll("4", "a")
    .replaceAll("3", "e")
    .replaceAll("1", "i")
    .replaceAll("!", "i")
    .replaceAll("0", "o")
    .replaceAll("5", "s")
    .replaceAll("7", "t")
    .replaceAll("$", "s");
}

export function enrollmentNameFailure(name: string): EnrollmentErrorCode | undefined {
  if (!FellowNameSchema.safeParse(name).success) return "NAME_INVALID";
  if (
    UNAMBIGUOUS_HARNESS_NAMES.some((harness) => name === harness || name.startsWith(`${harness}-`))
  ) {
    return "HARNESS_AS_NAME";
  }
  if (
    MODEL_NAMES.has(name) ||
    (MODEL_NAMES.size > 0 && [...MODEL_NAMES].some((model) => name.startsWith(`${model}-`)))
  ) {
    return "MODEL_AS_NAME";
  }
  if (
    HARNESS_NAMES.has(name) ||
    [...HARNESS_NAMES].some((harness) => name.startsWith(`${harness}-`))
  ) {
    return "HARNESS_AS_NAME";
  }
  if (PRODUCT_IDENTITIES.some((identity) => name === identity || name.startsWith(`${identity}-`))) {
    return "NAME_RESERVED";
  }
  if (name.split("-").some((part) => PROFANITY_DENYLIST.has(leetNormalized(part)))) {
    return "NAME_RESERVED";
  }
  if (RESERVED_FELLOW_NAMES.has(name) || /(^|-)official($|-)|(^|-)real($|-)|-mod$/.test(name)) {
    return "NAME_RESERVED";
  }
  return undefined;
}

function assertSponsor(
  principal: EnrollmentPrincipal,
): asserts principal is Extract<EnrollmentPrincipal, { type: "sponsor" }> {
  if (principal.type !== "sponsor" || principal.sponsorId.length === 0) {
    throw new EnrollmentError("WRONG_PRINCIPAL");
  }
}

function assertOperator(
  principal: EnrollmentPrincipal,
): asserts principal is Extract<EnrollmentPrincipal, { type: "operator" }> {
  if (
    principal.type !== "operator" ||
    principal.operatorId.length === 0 ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(principal.serviceEnvelopeKid)
  ) {
    throw new EnrollmentError("WRONG_PRINCIPAL");
  }
}

export function uniqueEnrollmentScopes(
  scopes: readonly RequestedScope[],
): readonly RequestedScope[] {
  return [...new Set(scopes)].sort();
}

function sameScopes(left: readonly RequestedScope[], right: readonly RequestedScope[]): boolean {
  const normalizedLeft = uniqueEnrollmentScopes(left);
  const normalizedRight = uniqueEnrollmentScopes(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((scope, index) => scope === normalizedRight[index])
  );
}

/**
 * Mechanical ceiling for persisted approval authority. An absent numeric cap
 * means unbounded, so a reduction may introduce or lower one but may never
 * remove a cap that the sponsor requested. Text bindings may only remain
 * byte-identical or be removed. Approved authority is semantically exact;
 * reduced authority must contain at least one genuine narrowing.
 */
export function enrollmentGrantIsWithinRequest(input: {
  readonly status: "approved" | "reduced";
  readonly requestedScopes: readonly RequestedScope[];
  readonly requestedResources: EnrollmentResourceGrants;
  readonly grantedScopes: readonly RequestedScope[];
  readonly grantedResources: EnrollmentResourceGrants;
}): boolean {
  const requestedScopeSet = new Set(input.requestedScopes);
  if (
    input.grantedScopes.length === 0 ||
    input.grantedScopes.some((scope) => !requestedScopeSet.has(scope))
  ) {
    return false;
  }

  for (const key of ["problemBinding", "firstDirective"] as const) {
    const requested = input.requestedResources[key];
    const granted = input.grantedResources[key];
    if (granted !== undefined && granted !== requested) return false;
  }
  for (const key of ["eventBudget", "artifactBudgetBytes", "fellowGrantExpiresAt"] as const) {
    const requested = input.requestedResources[key];
    const granted = input.grantedResources[key];
    if (requested !== undefined && (granted === undefined || granted > requested)) return false;
  }

  const scopesMatch = sameScopes(input.requestedScopes, input.grantedScopes);
  const resourceKeys = [
    "problemBinding",
    "firstDirective",
    "eventBudget",
    "artifactBudgetBytes",
    "fellowGrantExpiresAt",
  ] as const;
  const resourcesMatch = resourceKeys.every(
    (key) => input.requestedResources[key] === input.grantedResources[key],
  );
  return input.status === "approved"
    ? scopesMatch && resourcesMatch
    : !scopesMatch || !resourcesMatch;
}

export function isStrictEnrollmentScopeReduction(
  requested: readonly RequestedScope[],
  reduced: readonly RequestedScope[],
): boolean {
  const requestedSet = new Set(requested);
  return (
    reduced.length > 0 &&
    reduced.every((scope) => requestedSet.has(scope)) &&
    !sameScopes(requested, reduced)
  );
}

/**
 * RFC 8628 pacing with a finite ceiling and a recovery path after a quiet
 * period. Every too-fast poll raises the interval by at most five seconds;
 * after two compliant intervals of silence, it decays by five seconds. This
 * is deliberately deterministic so a D1 adapter can enforce identical rules.
 */
export function nextEnrollmentPollPacing(input: {
  readonly lastPollAt?: number;
  readonly pollIntervalSeconds: number;
  readonly now: number;
}): { readonly kind: "pending" | "slow-down"; readonly retryAfterSeconds: number } {
  const interval = Math.min(
    MAX_POLL_INTERVAL_SECONDS,
    Math.max(INITIAL_POLL_INTERVAL_SECONDS, input.pollIntervalSeconds),
  );
  if (input.lastPollAt === undefined) {
    return { kind: "pending", retryAfterSeconds: interval };
  }
  const elapsed = Math.max(0, input.now - input.lastPollAt);
  const decayed =
    elapsed >= interval * 2_000
      ? Math.max(INITIAL_POLL_INTERVAL_SECONDS, interval - POLL_SLOW_DOWN_INCREMENT_SECONDS)
      : interval;
  if (elapsed < decayed * 1_000) {
    return {
      kind: "slow-down",
      retryAfterSeconds: Math.min(
        MAX_POLL_INTERVAL_SECONDS,
        decayed + POLL_SLOW_DOWN_INCREMENT_SECONDS,
      ),
    };
  }
  return { kind: "pending", retryAfterSeconds: decayed };
}

function requestedResources(request: MintEnrollmentRequest, now: number): EnrollmentResourceGrants {
  return {
    ...(request.problem_binding === undefined ? {} : { problemBinding: request.problem_binding }),
    ...(request.first_directive === undefined ? {} : { firstDirective: request.first_directive }),
    ...(request.event_budget === undefined ? {} : { eventBudget: request.event_budget }),
    ...(request.artifact_budget_bytes === undefined
      ? {}
      : { artifactBudgetBytes: request.artifact_budget_bytes }),
    ...(request.fellow_grant_expires_in_ms === undefined
      ? {}
      : { fellowGrantExpiresAt: now + request.fellow_grant_expires_in_ms }),
  };
}

export function reduceEnrollmentResources(
  requested: EnrollmentResourceGrants,
  reduction: EnrollmentGrantReduction,
  now: number,
): EnrollmentResourceGrants {
  const next: EnrollmentResourceGrants = { ...requested };
  let changed = false;
  if (reduction.problem_binding === null) {
    if (next.problemBinding === undefined) throw new EnrollmentError("SCOPE_NOT_REDUCED");
    delete (next as { problemBinding?: string }).problemBinding;
    changed = true;
  }
  if (reduction.first_directive === null) {
    if (next.firstDirective === undefined) throw new EnrollmentError("SCOPE_NOT_REDUCED");
    delete (next as { firstDirective?: string }).firstDirective;
    changed = true;
  }
  if (reduction.event_budget !== undefined) {
    if (next.eventBudget !== undefined && reduction.event_budget >= next.eventBudget) {
      throw new EnrollmentError("SCOPE_NOT_REDUCED");
    }
    (next as { eventBudget?: number }).eventBudget = reduction.event_budget;
    changed = true;
  }
  if (reduction.artifact_budget_bytes !== undefined) {
    if (
      next.artifactBudgetBytes !== undefined &&
      reduction.artifact_budget_bytes >= next.artifactBudgetBytes
    ) {
      throw new EnrollmentError("SCOPE_NOT_REDUCED");
    }
    (next as { artifactBudgetBytes?: number }).artifactBudgetBytes =
      reduction.artifact_budget_bytes;
    changed = true;
  }
  if (reduction.fellow_grant_expires_in_ms !== undefined) {
    const reducedExpiry = now + reduction.fellow_grant_expires_in_ms;
    if (next.fellowGrantExpiresAt !== undefined && reducedExpiry >= next.fellowGrantExpiresAt) {
      throw new EnrollmentError("SCOPE_NOT_REDUCED");
    }
    (next as { fellowGrantExpiresAt?: number }).fellowGrantExpiresAt = reducedExpiry;
    changed = true;
  }
  if (!changed) throw new EnrollmentError("SCOPE_NOT_REDUCED");
  return next;
}

/**
 * An atomic, in-memory reference store for unit and contract execution.
 *
 * It is not a D1 adapter and must never be cited as D1 proof. Its lock makes
 * the exact race semantics executable: one secret claim and one token issue
 * may win, even when callers race through Promise.all.
 */
/** The sponsor-facing card for a record with a proposal, whatever its lifecycle state. */
function cardFromRecord(record: EnrollmentRecord): EnrollmentApprovalCard {
  const proposal = record.proposal;
  if (proposal === undefined) throw new EnrollmentError("PROPOSAL_NOT_PENDING");
  return {
    enrollmentId: record.enrollmentId,
    proposalId: proposal.proposalId,
    name: proposal.name,
    model: proposal.model,
    harness: proposal.harness,
    ...(proposal.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: proposal.reasoningEffort }),
    ...(proposal.toolsNote === undefined ? {} : { toolsNote: proposal.toolsNote }),
    requestedScopes: record.requestedScopes,
    requestedResources: record.requestedResources,
    status: proposal.status,
    effectiveGrantedScopes: proposal.grantedScopes ?? null,
    effectiveGrantedResources: proposal.grantedResources ?? null,
    proposalExpiresAt: proposal.expiresAt,
  };
}

export class InMemoryEnrollmentStore implements EnrollmentStore {
  readonly #records = new Map<string, EnrollmentRecord>();
  readonly #activeNames = new Map<string, string>();
  readonly #credentials = new Map<string, FellowCredentialBinding>();
  readonly #fellowStatuses = new Map<string, FellowLifecycleStatus>();
  readonly #fellowStatusChangedAt = new Map<string, number>();
  readonly #sponsorPanicAt = new Map<string, number>();
  readonly #familyRevokedThrough = new Map<string, number>();
  readonly #lifecycleSeq = new Map<string, number>();
  readonly #lifecycleEventIds = new Set<string>();
  readonly #lifecycleRequestIds = new Set<string>();
  readonly #operatorCapAuditEventIds = new Set<string>();
  readonly #operatorCapAuditRequestIds = new Set<string>();
  readonly #operatorCapSeq = new Map<string, number>();
  readonly #operatorCapAudit = new Map<string, OperatorFellowCapAuditRecord[]>();
  readonly #reviewWindows = new Map<string, { reviewFrom: number; flaggedAt: number }>();
  readonly #sponsors = new Map<
    string,
    { createdAt: number; lastSeenAt: number; activeFellowLimit: number }
  >();
  readonly #deviceCodes = new Map<string, { enrollmentId: string; expiresAt: number }>();
  readonly #deviceCodeExpiresAtByEnrollment = new Map<string, number>();
  readonly #activeDeviceMappingEnrollments = new Set<string>();
  readonly #reclaimedDeviceMappingEnrollments = new Set<string>();
  readonly #deviceStarts: { clientBucket: string; at: number }[] = [];
  readonly #deviceLookupFailures: { sponsorId: string; at: number }[] = [];
  readonly #idempotency = new Map<
    string,
    {
      readonly digest: string;
      readonly encryptedResponse: EncryptedEnrollmentReplay;
      readonly expiresAt: number;
    }
  >();
  #tail: Promise<void> = Promise.resolve();

  async create(
    record: EnrollmentRecord,
    replacesEnrollmentId?: string,
    idempotency?: EnrollmentIdempotencyWrite,
  ): Promise<boolean> {
    return this.serialized(() => {
      this.assertIdempotencyVacant(idempotency);
      if (this.#records.has(record.enrollmentId)) return false;
      if (replacesEnrollmentId !== undefined) {
        const predecessor = this.#records.get(replacesEnrollmentId);
        if (
          predecessor === undefined ||
          predecessor.sponsorId !== record.sponsorId ||
          predecessor.secretConsumedAt !== undefined ||
          predecessor.invalidated
        ) {
          throw new EnrollmentError("PAIRING_INVALID");
        }
      }
      const enrollmentBudget = this.sponsorEnrollmentBudget(record.sponsorId, record.createdAt);
      if (enrollmentBudget.count >= SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS) {
        throw this.sponsorEnrollmentRateLimitError(enrollmentBudget.latestAt, record.createdAt);
      }
      if (replacesEnrollmentId !== undefined) {
        const predecessor = this.#records.get(replacesEnrollmentId);
        if (predecessor === undefined) throw new EnrollmentError("PAIRING_INVALID");
        predecessor.invalidated = true;
      }
      this.#records.set(record.enrollmentId, record);
      this.commitIdempotency(idempotency);
      return true;
    });
  }

  async claim(attempt: ClaimAttempt, idempotency?: EnrollmentIdempotencyWrite): Promise<void> {
    await this.serialized(() => {
      this.assertIdempotencyVacant(idempotency);
      const record = this.#records.get(attempt.enrollmentId);
      this.assertClaimCredentials(record, attempt.secretHash, attempt.now);
      const confirmed = record as EnrollmentRecord;
      confirmed.secretConsumedAt = attempt.now;
      confirmed.proposal = attempt.proposal;
      this.commitIdempotency(idempotency);
    });
  }

  async verifyClaimCredentials(
    enrollmentId: string,
    secretHash: string,
    now: number,
  ): Promise<void> {
    await this.serialized(() => {
      this.assertClaimCredentials(this.#records.get(enrollmentId), secretHash, now);
    });
  }

  async decision(
    attempt: DecisionAttempt,
    idempotency?: EnrollmentIdempotencyWrite,
  ): Promise<void> {
    await this.serialized(() => {
      this.assertIdempotencyVacant(idempotency);
      const record = this.#records.get(attempt.enrollmentId);
      const isUnboundDevice =
        record !== undefined && record.kind === "device" && record.sponsorId === "";
      if (record === undefined || (record.sponsorId !== attempt.sponsorId && !isUnboundDevice)) {
        throw new EnrollmentError("WRONG_PRINCIPAL");
      }
      const proposal = record.proposal;
      if (proposal === undefined) {
        throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      }
      if (proposal.status === "expired") throw new EnrollmentError("PROPOSAL_EXPIRED");
      if (proposal.status !== "pending") throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      if (attempt.now >= proposal.expiresAt) {
        proposal.status = "expired";
        throw new EnrollmentError("PROPOSAL_EXPIRED");
      }
      if (isUnboundDevice) {
        const deviceCodeExpiresAt = this.#deviceCodeExpiresAtByEnrollment.get(record.enrollmentId);
        if (
          deviceCodeExpiresAt === undefined ||
          !this.#activeDeviceMappingEnrollments.has(record.enrollmentId) ||
          attempt.now >= deviceCodeExpiresAt
        ) {
          throw new EnrollmentError("PAIRING_INVALID");
        }
      }

      if (attempt.decision.decision === "deny") {
        this.ensureSponsorForDecision(attempt.sponsorId, attempt.now);
        // The first decider binds an unbound device enrollment, even to deny it.
        if (isUnboundDevice) record.sponsorId = attempt.sponsorId;
        proposal.status = "denied";
        this.commitIdempotency(idempotency);
        return;
      }

      let proposedScopes = record.requestedScopes;
      let proposedResources = record.requestedResources;
      if (attempt.decision.decision === "reduce") {
        if (attempt.decision.reduction.scopes !== undefined) {
          proposedScopes = uniqueEnrollmentScopes(attempt.decision.reduction.scopes);
          if (!proposedScopes.every((scope) => record.requestedScopes.includes(scope))) {
            throw new EnrollmentError("SCOPE_ESCALATION");
          }
          if (!isStrictEnrollmentScopeReduction(record.requestedScopes, proposedScopes)) {
            throw new EnrollmentError("SCOPE_NOT_REDUCED");
          }
        }
        const resourceReduction = { ...attempt.decision.reduction } as Record<string, unknown>;
        delete resourceReduction.scopes;
        proposedResources =
          Object.keys(resourceReduction).length === 0
            ? record.requestedResources
            : reduceEnrollmentResources(
                record.requestedResources,
                attempt.decision.reduction,
                attempt.now,
              );
        if (
          attempt.decision.reduction.scopes === undefined &&
          proposedResources === record.requestedResources
        ) {
          throw new EnrollmentError("SCOPE_NOT_REDUCED");
        }
      }

      if (
        proposedResources.fellowGrantExpiresAt !== undefined &&
        attempt.now >= proposedResources.fellowGrantExpiresAt
      ) {
        proposal.status = "expired";
        throw new EnrollmentError("PROPOSAL_EXPIRED");
      }
      const panicAt = this.#sponsorPanicAt.get(attempt.sponsorId);
      if (panicAt !== undefined && attempt.now <= panicAt) {
        // A panic that linearized first cannot leave behind an approved but
        // permanently unissuable grant. The unchanged keyed retry may succeed
        // once its grant timestamp is strictly beyond the panic boundary.
        throw new EnrollmentPersistenceError();
      }
      if (
        this.activeFellowCount(attempt.sponsorId) >=
        (this.#sponsors.get(attempt.sponsorId)?.activeFellowLimit ??
          DEFAULT_SPONSOR_ACTIVE_FELLOW_LIMIT)
      ) {
        throw new EnrollmentError("FELLOW_CAP_REACHED");
      }

      const nameOwner = this.#activeNames.get(proposal.name);
      if (nameOwner !== undefined && nameOwner !== proposal.proposalId) {
        throw new EnrollmentError("NAME_TAKEN");
      }
      if (isUnboundDevice) {
        const enrollmentBudget = this.sponsorEnrollmentBudget(attempt.sponsorId, attempt.now);
        if (enrollmentBudget.count >= SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS) {
          throw this.sponsorEnrollmentRateLimitError(enrollmentBudget.latestAt, attempt.now);
        }
      }
      this.ensureSponsorForDecision(attempt.sponsorId, attempt.now);
      this.#activeNames.set(proposal.name, proposal.proposalId);
      if (isUnboundDevice) record.sponsorId = attempt.sponsorId;
      proposal.status = attempt.decision.decision === "approve" ? "approved" : "reduced";
      proposal.grantedScopes = proposedScopes;
      proposal.grantedResources = proposedResources;
      proposal.grantedAt = attempt.now;
      this.#fellowStatuses.set(proposal.fellowId, "active");
      this.#fellowStatusChangedAt.set(proposal.fellowId, attempt.now);
      this.commitIdempotency(idempotency);
    });
  }

  async approvalCard(
    enrollmentId: string,
    sponsorId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard> {
    return this.serialized(() => {
      const record = this.#records.get(enrollmentId);
      if (record === undefined || record.sponsorId !== sponsorId) {
        throw new EnrollmentError("WRONG_PRINCIPAL");
      }
      if (record.proposal === undefined) throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      const proposal = record.proposal;
      const grantExpiresAt = record.requestedResources.fellowGrantExpiresAt;
      if (
        proposal.status === "pending" &&
        (now >= proposal.expiresAt || (grantExpiresAt !== undefined && now >= grantExpiresAt))
      ) {
        proposal.status = "expired";
      }
      return cardFromRecord(record);
    });
  }

  async pendingApprovalCardsBySponsor(
    sponsorId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard[]> {
    return this.serialized(() => {
      const cards: EnrollmentApprovalCard[] = [];
      for (const record of this.#records.values()) {
        if (record.sponsorId !== sponsorId || record.proposal === undefined) continue;
        const proposal = record.proposal;
        const grantExpiresAt = record.requestedResources.fellowGrantExpiresAt;
        if (
          proposal.status === "pending" &&
          (now >= proposal.expiresAt || (grantExpiresAt !== undefined && now >= grantExpiresAt))
        ) {
          proposal.status = "expired";
        }
        if (proposal.status !== "pending") continue;
        cards.push({
          enrollmentId: record.enrollmentId,
          proposalId: proposal.proposalId,
          name: proposal.name,
          model: proposal.model,
          harness: proposal.harness,
          ...(proposal.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: proposal.reasoningEffort }),
          ...(proposal.toolsNote === undefined ? {} : { toolsNote: proposal.toolsNote }),
          requestedScopes: record.requestedScopes,
          requestedResources: record.requestedResources,
          status: proposal.status,
          effectiveGrantedScopes: proposal.grantedScopes ?? null,
          effectiveGrantedResources: proposal.grantedResources ?? null,
          proposalExpiresAt: proposal.expiresAt,
        });
      }
      cards.sort((left, right) => left.proposalExpiresAt - right.proposalExpiresAt);
      return cards;
    });
  }

  async fellowsBySponsor(
    sponsorId: string,
    now: number,
    after?: SponsorFellowCursorKey,
  ): Promise<SponsorFellowPage> {
    return this.serialized(() => {
      const fellows: SponsorFellowRecord[] = [];
      for (const record of this.#records.values()) {
        if (record.sponsorId !== sponsorId || record.proposal === undefined) continue;
        const proposal = record.proposal;
        if (
          proposal.grantedScopes === undefined ||
          proposal.grantedResources === undefined ||
          proposal.grantedAt === undefined
        ) {
          continue;
        }
        const status = this.#fellowStatuses.get(proposal.fellowId) ?? "active";
        const grantedAt = proposal.grantedAt;
        const panicAt = this.#sponsorPanicAt.get(sponsorId);
        const familyRevokedThrough = this.#familyRevokedThrough.get(proposal.fellowId);
        const credentials = [...this.#credentials.values()]
          .filter(
            (credential) =>
              credential.fellowId === proposal.fellowId &&
              credential.revokedAt === undefined &&
              credential.issuedAt <= now &&
              now < credential.expiresAt &&
              (panicAt === undefined || (grantedAt > panicAt && credential.issuedAt > panicAt)) &&
              (familyRevokedThrough === undefined || credential.issuedAt > familyRevokedThrough) &&
              (credential.grantedResources.fellowGrantExpiresAt === undefined ||
                now < credential.grantedResources.fellowGrantExpiresAt),
          )
          .map((credential) => ({
            credentialId: credential.credentialId,
            profile: credential.credentialProfile,
            issuedAt: credential.issuedAt,
            expiresAt: credential.expiresAt,
            ...(credential.lastUsedAt === undefined ? {} : { lastUsedAt: credential.lastUsedAt }),
            active:
              fellowStatusCanAuthenticate(status) &&
              credential.issuedAt <= now &&
              now < credential.expiresAt,
          }))
          .sort(
            (left, right) =>
              right.issuedAt - left.issuedAt ||
              compareFellowIdBinary(left.credentialId, right.credentialId),
          );
        fellows.push({
          fellowId: proposal.fellowId,
          name: proposal.name,
          model: proposal.model,
          harness: proposal.harness,
          status,
          grantedScopes: proposal.grantedScopes,
          grantedResources: proposal.grantedResources,
          grantedAt: proposal.grantedAt,
          credentials,
        });
      }
      const ordered = fellows
        .filter((record) => after === undefined || followsFellowCursor(record, after))
        .sort(compareFellowPageOrder)
        .slice(0, SPONSOR_FELLOW_PAGE_SIZE + 1);
      const page = ordered.slice(0, SPONSOR_FELLOW_PAGE_SIZE);
      const sentinel = ordered[SPONSOR_FELLOW_PAGE_SIZE];
      const tail = page.at(-1);
      return {
        fellows: page,
        ...(sentinel === undefined || tail === undefined
          ? {}
          : { nextCursor: { granted_at: tail.grantedAt, fellow_id: tail.fellowId } }),
      };
    });
  }

  async bootstrapSponsor(sponsorId: string, now: number): Promise<boolean> {
    return this.serialized(() => {
      const existing = this.#sponsors.get(sponsorId);
      if (existing !== undefined) {
        existing.lastSeenAt = now;
        return false;
      }
      this.#sponsors.set(sponsorId, {
        createdAt: now,
        lastSeenAt: now,
        activeFellowLimit: DEFAULT_SPONSOR_ACTIVE_FELLOW_LIMIT,
      });
      this.#operatorCapSeq.set(sponsorId, 0);
      return true;
    });
  }

  async revokeCredential(attempt: CredentialRevokeAttempt): Promise<LifecycleCommandResult> {
    return this.serialized(async () => {
      const credential = [...this.#credentials.entries()].find(
        ([, candidate]) =>
          candidate.sponsorId === attempt.sponsorId &&
          candidate.fellowId === attempt.fellowId &&
          candidate.credentialId === attempt.credentialId &&
          candidate.revokedAt === undefined,
      );
      if (credential === undefined || !this.#sponsors.has(attempt.sponsorId)) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      const [tokenHash, current] = credential;
      const result = this.nextLifecycleResult(
        attempt.sponsorId,
        attempt.eventId,
        attempt.requestId,
        attempt.effectiveAt,
      );
      const idempotency = await attempt.replayFor?.(result);
      this.commitIdempotency(idempotency);
      this.#credentials.set(tokenHash, {
        ...current,
        revokedAt: Math.max(attempt.effectiveAt, current.issuedAt, current.lastUsedAt ?? 0),
      });
      this.commitLifecycleEvent(attempt.sponsorId, attempt.eventId, attempt.requestId, result);
      return result;
    });
  }

  async transitionFellow(attempt: FellowLifecycleAttempt): Promise<LifecycleCommandResult> {
    return this.serialized(async () => {
      const current = this.#fellowStatuses.get(attempt.fellowId);
      const owned = [...this.#records.values()].some(
        (record) =>
          record.sponsorId === attempt.sponsorId && record.proposal?.fellowId === attempt.fellowId,
      );
      if (
        current === undefined ||
        !owned ||
        !this.#sponsors.has(attempt.sponsorId) ||
        !fellowLifecycleTransitionAllowed(current, attempt.toStatus)
      ) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      if (
        !fellowStatusCanAuthenticate(current) &&
        fellowStatusCanAuthenticate(attempt.toStatus) &&
        this.activeFellowCount(attempt.sponsorId) >=
          (this.#sponsors.get(attempt.sponsorId)?.activeFellowLimit ??
            DEFAULT_SPONSOR_ACTIVE_FELLOW_LIMIT)
      ) {
        throw new EnrollmentError("FELLOW_CAP_REACHED");
      }
      const effectiveAt = Math.max(
        attempt.effectiveAt,
        this.#fellowStatusChangedAt.get(attempt.fellowId) ?? attempt.effectiveAt,
      );
      const result = this.nextLifecycleResult(
        attempt.sponsorId,
        attempt.eventId,
        attempt.requestId,
        effectiveAt,
      );
      const idempotency = await attempt.replayFor?.(result);
      this.commitIdempotency(idempotency);
      if (attempt.toStatus === "revoked" || attempt.toStatus === "compromised") {
        this.#familyRevokedThrough.set(attempt.fellowId, effectiveAt);
      }
      if (attempt.toStatus === "compromised") {
        const issued = [...this.#credentials.values()]
          .filter((credential) => credential.fellowId === attempt.fellowId)
          .map((credential) => credential.issuedAt);
        const fellowGrantedAt = [...this.#records.values()].find(
          (record) => record.proposal?.fellowId === attempt.fellowId,
        )?.proposal?.grantedAt;
        const earliestIssuedAt = issued.length === 0 ? undefined : Math.min(...issued);
        this.#reviewWindows.set(attempt.fellowId, {
          reviewFrom: Math.max(
            fellowGrantedAt ?? effectiveAt,
            earliestIssuedAt ?? fellowGrantedAt ?? effectiveAt,
          ),
          flaggedAt: effectiveAt,
        });
      }
      this.#fellowStatuses.set(attempt.fellowId, attempt.toStatus);
      this.#fellowStatusChangedAt.set(attempt.fellowId, effectiveAt);
      this.commitLifecycleEvent(attempt.sponsorId, attempt.eventId, attempt.requestId, result);
      return result;
    });
  }

  async panicSponsor(attempt: SponsorPanicAttempt): Promise<LifecycleCommandResult> {
    return this.serialized(async () => {
      if (!this.#sponsors.has(attempt.sponsorId)) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      const current = this.#sponsorPanicAt.get(attempt.sponsorId);
      const effectiveAt = Math.max(attempt.effectiveAt, (current ?? -1) + 1);
      const result = this.nextLifecycleResult(
        attempt.sponsorId,
        attempt.eventId,
        attempt.requestId,
        effectiveAt,
      );
      const idempotency = await attempt.replayFor?.(result);
      this.commitIdempotency(idempotency);
      this.#sponsorPanicAt.set(attempt.sponsorId, effectiveAt);
      this.commitLifecycleEvent(attempt.sponsorId, attempt.eventId, attempt.requestId, result);
      return result;
    });
  }

  async overrideSponsorFellowCap(
    attempt: OperatorFellowCapOverrideAttempt,
  ): Promise<OperatorFellowCapOverrideResult> {
    return this.serialized(async () => {
      const sponsor = this.#sponsors.get(attempt.sponsorId);
      const currentSequence = this.#operatorCapSeq.get(attempt.sponsorId);
      if (
        sponsor === undefined ||
        currentSequence === undefined ||
        sponsor.activeFellowLimit !== attempt.expectedActiveFellowLimit ||
        currentSequence !== attempt.expectedSponsorSeq ||
        sponsor.activeFellowLimit === attempt.activeFellowLimit ||
        this.activeFellowCount(attempt.sponsorId) > attempt.activeFellowLimit ||
        this.#operatorCapAuditEventIds.has(attempt.auditEventId) ||
        this.#operatorCapAuditRequestIds.has(attempt.requestId)
      ) {
        throw new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT");
      }
      const result = {
        sponsorSeq: currentSequence + 1,
        previousActiveFellowLimit: sponsor.activeFellowLimit,
        activeFellowLimit: attempt.activeFellowLimit,
        effectiveAt: attempt.effectiveAt,
      } satisfies OperatorFellowCapOverrideResult;
      const idempotency = await attempt.replayFor?.(result);
      this.commitIdempotency(idempotency);
      sponsor.activeFellowLimit = attempt.activeFellowLimit;
      this.#operatorCapSeq.set(attempt.sponsorId, currentSequence + 1);
      this.#operatorCapAuditEventIds.add(attempt.auditEventId);
      this.#operatorCapAuditRequestIds.add(attempt.requestId);
      const events = this.#operatorCapAudit.get(attempt.sponsorId) ?? [];
      events.push({
        auditEventId: attempt.auditEventId,
        sponsorId: attempt.sponsorId,
        operatorId: attempt.operatorId,
        sponsorSeq: result.sponsorSeq,
        previousActiveFellowLimit: result.previousActiveFellowLimit,
        activeFellowLimit: result.activeFellowLimit,
        reason: attempt.reason,
        stepUpAuthenticatedAt: attempt.stepUpAuthenticatedAt,
        signerKid: attempt.signerKid,
        effectiveAt: result.effectiveAt,
      });
      this.#operatorCapAudit.set(attempt.sponsorId, events);
      return result;
    });
  }

  async sponsorFellowCap(sponsorId: string): Promise<OperatorFellowCapState> {
    return this.serialized(async () => {
      const sponsor = this.#sponsors.get(sponsorId);
      const sponsorSeq = this.#operatorCapSeq.get(sponsorId);
      if (sponsor === undefined || sponsorSeq === undefined) {
        throw new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT");
      }
      return { activeFellowLimit: sponsor.activeFellowLimit, sponsorSeq };
    });
  }

  async sponsorFellowCapAudit(
    sponsorId: string,
    after?: OperatorFellowCapAuditCursorKey,
  ): Promise<OperatorFellowCapAuditPage> {
    return this.serialized(() => {
      if (!this.#sponsors.has(sponsorId)) {
        throw new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT");
      }
      const ordered = [...(this.#operatorCapAudit.get(sponsorId) ?? [])]
        .sort((left, right) => right.sponsorSeq - left.sponsorSeq)
        .filter((event) => after === undefined || event.sponsorSeq < after.sponsor_seq);
      const window = ordered.slice(0, OPERATOR_FELLOW_CAP_AUDIT_PAGE_SIZE + 1);
      const hasNext = window.length > OPERATOR_FELLOW_CAP_AUDIT_PAGE_SIZE;
      const auditEvents = hasNext ? window.slice(0, -1) : window;
      const final = auditEvents.at(-1);
      return {
        auditEvents,
        ...(hasNext && final !== undefined
          ? { nextCursor: { sponsor_seq: final.sponsorSeq } }
          : {}),
      };
    });
  }

  private activeFellowCount(sponsorId: string): number {
    const fellowIds = new Set<string>();
    for (const record of this.#records.values()) {
      const fellowId = record.proposal?.fellowId;
      if (record.sponsorId !== sponsorId || fellowId === undefined) continue;
      const status = this.#fellowStatuses.get(fellowId);
      if (status !== undefined && fellowStatusCanAuthenticate(status)) fellowIds.add(fellowId);
    }
    return fellowIds.size;
  }

  private sponsorEnrollmentBudget(
    sponsorId: string,
    now: number,
  ): { readonly count: number; readonly latestAt: number | undefined } {
    const windowBeginning = now - SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS;
    let count = 0;
    let latestAt: number | undefined;
    for (const record of this.#records.values()) {
      if (record.sponsorId !== sponsorId) continue;
      const attemptedAt = record.kind === "device" ? record.proposal?.grantedAt : record.createdAt;
      if (attemptedAt !== undefined && attemptedAt > windowBeginning) {
        count += 1;
        latestAt = latestAt === undefined ? attemptedAt : Math.max(latestAt, attemptedAt);
      }
    }
    return { count, latestAt };
  }

  private sponsorEnrollmentRateLimitError(
    latestAt: number | undefined,
    now: number,
  ): SponsorEnrollmentRateLimitError {
    if (latestAt === undefined) throw new EnrollmentPersistenceError();
    const retryAfterSeconds =
      Math.max(0, Math.ceil((latestAt + SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS - now) / 1_000)) +
      1;
    return new SponsorEnrollmentRateLimitError(retryAfterSeconds);
  }

  async deviceCreate(
    input: DeviceCreateInput,
    idempotency?: EnrollmentIdempotencyWrite,
  ): Promise<void> {
    return this.serialized(() => {
      this.assertIdempotencyVacant(idempotency);
      let reclaimed = 0;
      for (
        let index = 0;
        index < this.#deviceStarts.length && reclaimed < input.reclaimBatchSize;
      ) {
        const entry = this.#deviceStarts[index];
        if (entry !== undefined && entry.at < input.startWindowBeginning) {
          this.#deviceStarts.splice(index, 1);
          reclaimed += 1;
        } else {
          index += 1;
        }
      }
      reclaimed = 0;
      for (const [hash, mapping] of this.#deviceCodes) {
        if (reclaimed >= input.reclaimBatchSize) break;
        if (mapping.expiresAt <= input.record.createdAt) {
          this.#deviceCodes.delete(hash);
          this.#activeDeviceMappingEnrollments.delete(mapping.enrollmentId);
          this.#reclaimedDeviceMappingEnrollments.add(mapping.enrollmentId);
          reclaimed += 1;
        }
      }
      const startsInWindow = this.#deviceStarts.filter(
        (entry) =>
          entry.clientBucket === input.clientBucket &&
          entry.at >= input.startWindowBeginning &&
          entry.at <= input.record.createdAt,
      ).length;
      if (startsInWindow >= input.startLimit) {
        throw new EnrollmentError("DEVICE_START_RATE_LIMITED");
      }
      if (
        this.#records.has(input.record.enrollmentId) ||
        this.#deviceCodes.has(input.userCodeHash) ||
        [...this.#records.values()].some(
          (record) =>
            record.proposal?.proposalId === input.proposal.proposalId ||
            record.proposal?.fellowId === input.proposal.fellowId ||
            record.proposal?.flowHandleHash === input.proposal.flowHandleHash,
        )
      ) {
        throw new EnrollmentIdentifierCollisionError();
      }
      this.#records.set(input.record.enrollmentId, {
        ...input.record,
        deviceExpiresAt: input.deviceExpiresAt,
        proposal: input.proposal,
      });
      this.#deviceCodes.set(input.userCodeHash, {
        enrollmentId: input.record.enrollmentId,
        expiresAt: input.deviceExpiresAt,
      });
      this.#deviceCodeExpiresAtByEnrollment.set(input.record.enrollmentId, input.deviceExpiresAt);
      this.#activeDeviceMappingEnrollments.add(input.record.enrollmentId);
      this.#deviceStarts.push({ clientBucket: input.clientBucket, at: input.record.createdAt });
      this.commitIdempotency(idempotency);
    });
  }

  async deviceLookup(attempt: DeviceLookupAttempt): Promise<EnrollmentApprovalCard> {
    return this.serialized(() => {
      let reclaimed = 0;
      for (
        let index = 0;
        index < this.#deviceLookupFailures.length && reclaimed < attempt.reclaimBatchSize;
      ) {
        const entry = this.#deviceLookupFailures[index];
        if (entry !== undefined && entry.at < attempt.windowBeginning) {
          this.#deviceLookupFailures.splice(index, 1);
          reclaimed += 1;
        } else {
          index += 1;
        }
      }
      reclaimed = 0;
      for (const [hash, mapping] of this.#deviceCodes) {
        if (reclaimed >= attempt.reclaimBatchSize) break;
        if (mapping.expiresAt <= attempt.now) {
          this.#deviceCodes.delete(hash);
          this.#activeDeviceMappingEnrollments.delete(mapping.enrollmentId);
          this.#reclaimedDeviceMappingEnrollments.add(mapping.enrollmentId);
          reclaimed += 1;
        }
      }
      const failures = this.#deviceLookupFailures.filter(
        (entry) =>
          entry.sponsorId === attempt.sponsorId &&
          entry.at >= attempt.windowBeginning &&
          entry.at <= attempt.now,
      ).length;
      if (failures >= attempt.failureLimit) {
        throw new EnrollmentError("DEVICE_LOOKUP_LOCKED");
      }
      const code = this.#deviceCodes.get(attempt.userCodeHash);
      if (code === undefined || attempt.now >= code.expiresAt) {
        this.#deviceLookupFailures.push({ sponsorId: attempt.sponsorId, at: attempt.now });
        throw new EnrollmentError("DEVICE_CODE_UNKNOWN");
      }
      const record = this.#records.get(code.enrollmentId);
      if (record === undefined || record.proposal === undefined) {
        this.#deviceLookupFailures.push({ sponsorId: attempt.sponsorId, at: attempt.now });
        throw new EnrollmentError("DEVICE_CODE_UNKNOWN");
      }
      const proposal = record.proposal;
      const grantExpiresAt = record.requestedResources.fellowGrantExpiresAt;
      if (
        proposal.status === "pending" &&
        (attempt.now >= proposal.expiresAt ||
          (grantExpiresAt !== undefined && attempt.now >= grantExpiresAt))
      ) {
        proposal.status = "expired";
      }
      if (proposal.status !== "pending") {
        this.#deviceLookupFailures.push({ sponsorId: attempt.sponsorId, at: attempt.now });
        throw new EnrollmentError("DEVICE_CODE_UNKNOWN");
      }
      return cardFromRecord(record);
    });
  }

  async deviceApprovalCardForDecision(
    enrollmentId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard> {
    return this.serialized(() => {
      const record = this.#records.get(enrollmentId);
      if (
        record === undefined ||
        record.kind !== "device" ||
        record.sponsorId !== "" ||
        record.proposal === undefined
      ) {
        throw new EnrollmentError("PAIRING_INVALID");
      }
      const deviceCodeExpiresAt = this.#deviceCodeExpiresAtByEnrollment.get(enrollmentId);
      if (
        deviceCodeExpiresAt === undefined ||
        !this.#activeDeviceMappingEnrollments.has(enrollmentId) ||
        now >= deviceCodeExpiresAt
      ) {
        throw new EnrollmentError("PAIRING_INVALID");
      }
      const proposal = record.proposal;
      const grantExpiresAt = record.requestedResources.fellowGrantExpiresAt;
      if (
        proposal.status === "pending" &&
        (now >= proposal.expiresAt || (grantExpiresAt !== undefined && now >= grantExpiresAt))
      ) {
        proposal.status = "expired";
      }
      return cardFromRecord(record);
    });
  }

  async capsule(enrollmentId: string, now: number): Promise<EnrollmentCapsule> {
    return this.serialized(() => {
      const record = this.#records.get(enrollmentId);
      if (
        record === undefined ||
        record.invalidated ||
        record.secretConsumedAt !== undefined ||
        now >= record.secretExpiresAt
      ) {
        throw new EnrollmentError("PAIRING_INVALID");
      }
      return {
        enrollmentId: record.enrollmentId,
        secretExpiresAt: record.secretExpiresAt,
      };
    });
  }

  async poll(attempt: PollAttempt): Promise<PollDecision> {
    return this.serialized(async () => {
      const record = [...this.#records.values()].find(
        (candidate) =>
          candidate.proposal !== undefined &&
          constantTimeEqual(candidate.proposal.flowHandleHash, attempt.flowHandleHash),
      );
      const proposal = record?.proposal;
      if (record === undefined || proposal === undefined) throw new EnrollmentError("FLOW_INVALID");
      if (proposal.tokenHash !== undefined) return { kind: "already-issued" };
      if (
        proposal.status === "pending" &&
        (attempt.now >= proposal.expiresAt ||
          (record.requestedResources.fellowGrantExpiresAt !== undefined &&
            attempt.now >= record.requestedResources.fellowGrantExpiresAt))
      ) {
        const decision: PollDecision = { kind: "expired" };
        const idempotency = await attempt.replayFor?.(decision);
        this.assertIdempotencyVacant(idempotency);
        proposal.status = "expired";
        this.commitIdempotency(idempotency);
        return decision;
      }
      if (record.kind === "device") {
        const deviceCodeExpiresAt = this.#deviceCodeExpiresAtByEnrollment.get(record.enrollmentId);
        if (deviceCodeExpiresAt === undefined) throw new EnrollmentError("FLOW_INVALID");
        const mappingIsActive = this.#activeDeviceMappingEnrollments.has(record.enrollmentId);
        const mappingWasReclaimed = this.#reclaimedDeviceMappingEnrollments.has(
          record.enrollmentId,
        );
        if (!mappingIsActive && !mappingWasReclaimed) {
          throw new EnrollmentError("FLOW_INVALID");
        }
        if (!mappingIsActive && attempt.now < deviceCodeExpiresAt) {
          throw new EnrollmentError("FLOW_INVALID");
        }
        if (attempt.now >= deviceCodeExpiresAt) {
          // The short device-code mapping expired, but the durable proposal
          // remains pending until its own 24-hour boundary. Do not consume the
          // stable terminal replay key here: doing so would mask the later
          // proposal-expiry transition for another full replay-retention day.
          return { kind: "expired" };
        }
      }
      if (proposal.status === "pending") {
        const pacing = nextEnrollmentPollPacing({
          lastPollAt: proposal.lastPollAt,
          pollIntervalSeconds: proposal.pollIntervalSeconds,
          now: attempt.now,
        });
        const decision: PollDecision =
          pacing.kind === "slow-down"
            ? { kind: "slow-down", retryAfterSeconds: pacing.retryAfterSeconds }
            : { kind: "pending", retryAfterSeconds: pacing.retryAfterSeconds };
        proposal.pollIntervalSeconds = pacing.retryAfterSeconds;
        proposal.lastPollAt = attempt.now;
        return decision;
      }
      if (proposal.status === "denied") {
        const idempotency = await attempt.replayFor?.({ kind: "denied" });
        this.commitIdempotency(idempotency);
        return { kind: "denied" };
      }
      if (proposal.status === "expired") {
        const idempotency = await attempt.replayFor?.({ kind: "expired" });
        this.commitIdempotency(idempotency);
        return { kind: "expired" };
      }
      if (proposal.grantedScopes === undefined || proposal.grantedResources === undefined) {
        throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      }
      if (
        proposal.grantedResources.fellowGrantExpiresAt !== undefined &&
        attempt.now >= proposal.grantedResources.fellowGrantExpiresAt
      ) {
        const decision: PollDecision = { kind: "expired" };
        const idempotency = await attempt.replayFor?.(decision);
        this.assertIdempotencyVacant(idempotency);
        proposal.status = "expired";
        this.commitIdempotency(idempotency);
        return decision;
      }
      if (
        !enrollmentGrantIsWithinRequest({
          status: proposal.status,
          requestedScopes: record.requestedScopes,
          requestedResources: record.requestedResources,
          grantedScopes: proposal.grantedScopes,
          grantedResources: proposal.grantedResources,
        })
      ) {
        throw new EnrollmentPersistenceError();
      }
      const panicAt = this.#sponsorPanicAt.get(record.sponsorId);
      if (
        panicAt !== undefined &&
        (proposal.grantedAt === undefined || proposal.grantedAt <= panicAt)
      ) {
        throw new EnrollmentError("FLOW_INVALID");
      }
      const fellowStatus = this.#fellowStatuses.get(proposal.fellowId);
      if (fellowStatus === undefined || !fellowStatusCanAuthenticate(fellowStatus)) {
        throw new EnrollmentError("FLOW_INVALID");
      }
      const issued = await attempt.createToken();
      const decision: PollDecision = { kind: "issued", token: issued.token };
      const idempotency = await attempt.replayFor?.(decision);
      this.assertIdempotencyVacant(idempotency);
      proposal.tokenHash = issued.tokenHash;
      proposal.tokenIssuedAt = attempt.now;
      this.#credentials.set(issued.tokenHash, {
        fellowId: proposal.fellowId,
        credentialId: `cred-${proposal.proposalId}`,
        sponsorId: record.sponsorId,
        name: proposal.name,
        model: proposal.model,
        harness: proposal.harness,
        grantedScopes: proposal.grantedScopes,
        grantedResources: proposal.grantedResources,
        tokenHash: issued.tokenHash,
        issuedAt: attempt.now,
        expiresAt: attempt.now + FELLOW_TOKEN_TTL_MS,
        credentialProfile: "bearer",
        fellowStatus,
      });
      this.commitIdempotency(idempotency);
      return decision;
    });
  }

  async availabilitySuggestions(name: string): Promise<readonly string[]> {
    return this.serialized(() => {
      const stem = name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-");
      const safeStem =
        stem.length >= 1 && /^[a-z]/.test(stem) && enrollmentNameFailure(stem) === undefined
          ? stem.slice(0, 24).replace(/-+$/g, "")
          : "fellow";
      const suggestions: string[] = [];
      for (let index = 2; suggestions.length < 3 && index < 10_000; index += 1) {
        const candidate = `${safeStem}-${index}`.slice(0, 32).replace(/-+$/g, "");
        const failure = enrollmentNameFailure(candidate);
        if (
          FellowNameSchema.safeParse(candidate).success &&
          failure === undefined &&
          !this.#activeNames.has(candidate)
        ) {
          suggestions.push(candidate);
        }
      }
      return suggestions;
    });
  }

  async authenticateCredential(
    tokenHash: string,
    now: number,
    expectedProfile: FellowCredentialProfile,
  ): Promise<FellowCredentialBinding | undefined> {
    return this.serialized(() => {
      const existing = this.#credentials.get(tokenHash);
      const fellowStatus =
        existing === undefined
          ? undefined
          : (this.#fellowStatuses.get(existing.fellowId) ?? existing.fellowStatus);
      const panicAt =
        existing === undefined ? undefined : this.#sponsorPanicAt.get(existing.sponsorId);
      const familyRevokedThrough =
        existing === undefined ? undefined : this.#familyRevokedThrough.get(existing.fellowId);
      const grantedAt =
        existing === undefined
          ? undefined
          : [...this.#records.values()].find(
              (record) => record.proposal?.fellowId === existing.fellowId,
            )?.proposal?.grantedAt;
      if (
        existing === undefined ||
        existing.credentialProfile !== expectedProfile ||
        fellowStatus === undefined ||
        !fellowStatusCanAuthenticate(fellowStatus) ||
        existing.revokedAt !== undefined ||
        now < existing.issuedAt ||
        now >= existing.expiresAt ||
        (panicAt !== undefined &&
          (grantedAt === undefined || grantedAt <= panicAt || existing.issuedAt <= panicAt)) ||
        (familyRevokedThrough !== undefined && existing.issuedAt <= familyRevokedThrough) ||
        (existing.grantedResources.fellowGrantExpiresAt !== undefined &&
          now >= existing.grantedResources.fellowGrantExpiresAt)
      ) {
        return undefined;
      }
      const authenticated = {
        ...existing,
        fellowStatus,
        lastUsedAt: Math.max(existing.lastUsedAt ?? existing.issuedAt, now),
      };
      this.#credentials.set(tokenHash, authenticated);
      return authenticated;
    });
  }

  async idempotencyReplay(
    attempt: IdempotencyAttempt,
  ): Promise<EnrollmentIdempotencyReplay | undefined> {
    return this.serialized(() => {
      const recordKey = `${attempt.scope}:${attempt.principalScope}:${attempt.key}`;
      const existing = this.#idempotency.get(recordKey);
      if (existing !== undefined && attempt.now < existing.expiresAt) {
        if (!constantTimeEqual(existing.digest, attempt.digest)) {
          throw new EnrollmentError("IDEMPOTENCY_CONFLICT");
        }
        return {
          digest: existing.digest,
          encryptedResponse: existing.encryptedResponse,
        };
      }
      return undefined;
    });
  }

  private commitIdempotency(idempotency: EnrollmentIdempotencyWrite | undefined): void {
    if (idempotency === undefined) return;
    this.assertIdempotencyVacant(idempotency);
    const recordKey = `${idempotency.scope}:${idempotency.principalScope}:${idempotency.key}`;
    this.#idempotency.set(recordKey, {
      digest: idempotency.digest,
      encryptedResponse: idempotency.encryptedResponse,
      expiresAt: idempotency.now + IDEMPOTENCY_TTL_MS,
    });
  }

  /** Refuse a race before any in-memory product mutation that cannot roll back. */
  private assertIdempotencyVacant(idempotency: EnrollmentIdempotencyWrite | undefined): void {
    if (idempotency === undefined) return;
    const recordKey = `${idempotency.scope}:${idempotency.principalScope}:${idempotency.key}`;
    const existing = this.#idempotency.get(recordKey);
    if (existing !== undefined && idempotency.now < existing.expiresAt) {
      throw new EnrollmentIdempotencyRaceError();
    }
  }

  private nextLifecycleResult(
    sponsorId: string,
    eventId: string,
    requestId: string,
    effectiveAt: number,
  ): LifecycleCommandResult {
    if (this.#lifecycleEventIds.has(eventId) || this.#lifecycleRequestIds.has(requestId)) {
      throw new EnrollmentIdempotencyRaceError();
    }
    return {
      sponsorSeq: (this.#lifecycleSeq.get(sponsorId) ?? 0) + 1,
      effectiveAt,
    };
  }

  private commitLifecycleEvent(
    sponsorId: string,
    eventId: string,
    requestId: string,
    result: LifecycleCommandResult,
  ): void {
    this.#lifecycleEventIds.add(eventId);
    this.#lifecycleRequestIds.add(requestId);
    this.#lifecycleSeq.set(sponsorId, result.sponsorSeq);
  }

  private assertClaimCredentials(
    record: EnrollmentRecord | undefined,
    secretHash: string,
    now: number,
  ): void {
    if (
      record === undefined ||
      !constantTimeEqual(record.secretHash, secretHash) ||
      record.invalidated ||
      now >= record.secretExpiresAt ||
      record.secretConsumedAt !== undefined
    ) {
      // Every unusable credential has one opaque result. In particular, name
      // policy must not become an oracle for an unknown or stolen join URL.
      throw new EnrollmentError("PAIRING_INVALID");
    }
  }

  /**
   * A signed sponsor decision may be the human's first Worker contact (the
   * `/approve` device flow does not pass through `/console`).  Create the
   * accountability row in the same serialized transition that binds/settles
   * the proposal; callers that fail before this point create neither a row nor
   * any Fellow authority.
   */
  private ensureSponsorForDecision(sponsorId: string, now: number): void {
    const existing = this.#sponsors.get(sponsorId);
    if (existing !== undefined) {
      existing.lastSeenAt = now;
      return;
    }
    this.#sponsors.set(sponsorId, {
      createdAt: now,
      lastSeenAt: now,
      activeFellowLimit: DEFAULT_SPONSOR_ACTIVE_FELLOW_LIMIT,
    });
    this.#operatorCapSeq.set(sponsorId, 0);
  }

  /** Test-only storage inspection; it intentionally exposes hashes but never plaintext credentials. */
  async storageSnapshot(enrollmentId: string): Promise<EnrollmentStorageSnapshot | undefined> {
    return this.serialized(() => {
      const record = this.#records.get(enrollmentId);
      if (record === undefined) return undefined;
      return {
        enrollmentId: record.enrollmentId,
        secretHash: record.secretHash,
        ...(record.secretConsumedAt === undefined
          ? {}
          : { secretConsumedAt: record.secretConsumedAt }),
        ...(record.proposal === undefined
          ? {}
          : { flowHandleHash: record.proposal.flowHandleHash }),
        ...(record.proposal?.tokenHash === undefined
          ? {}
          : { tokenHash: record.proposal.tokenHash }),
        ...(record.proposal === undefined ? {} : { fellowId: record.proposal.fellowId }),
      };
    });
  }

  /** Test-only sponsor inspection; it contains accountability metadata, never credentials. */
  async sponsorSnapshot(sponsorId: string): Promise<
    | {
        readonly createdAt: number;
        readonly lastSeenAt: number;
        readonly activeFellowLimit: number;
      }
    | undefined
  > {
    return this.serialized(() => {
      const sponsor = this.#sponsors.get(sponsorId);
      return sponsor === undefined ? undefined : { ...sponsor };
    });
  }

  async serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(
      () => next,
      () => next,
    );
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export interface EnrollmentServiceOptions {
  /**
   * The trusted Stoa origin every emitted enrollment URL names. Immutable for
   * the life of the service: it comes from a validated binding, never a
   * request, so no handler can be tricked into re-pointing a credential.
   *
   * Required, deliberately. A default would mean an omitted caller silently
   * emits production URLs from a staging or loopback Worker — the exact
   * mis-pointing this binding exists to prevent, and the one failure mode that
   * would look correct in every local test.
   */
  readonly stoaOrigin: string;
  /**
   * The trusted Agora origin the device flow's verification URL names (Fable
   * §5.3 writes `/approve` as a path; which plane it hangs off is deployment
   * configuration). Required for the same reason as `stoaOrigin`: an omitted
   * origin silently emits production URLs from a staging or loopback Worker.
   */
  readonly agoraOrigin: string;
  readonly store?: EnrollmentStore;
  readonly clock?: EnrollmentClock;
  readonly random?: EnrollmentRandom;
  readonly replayProtector?: EnrollmentReplayProtector;
}

export class EnrollmentService {
  readonly #store: EnrollmentStore;
  readonly #clock: EnrollmentClock;
  readonly #random: EnrollmentRandom;
  readonly #replayProtector: EnrollmentReplayProtector;
  readonly #stoaOrigin: string;
  readonly #agoraOrigin: string;

  constructor(options: EnrollmentServiceOptions) {
    this.#store = options.store ?? new InMemoryEnrollmentStore();
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? systemRandom;
    if (options.replayProtector === undefined) throw new EnrollmentReplayConfigurationError();
    this.#replayProtector = options.replayProtector;
    // Fail closed at construction. A service that reached a request with an
    // untrusted origin would have to refuse mid-flow, after a token may
    // already have been minted; and there is no default, so an omitted origin
    // is a construction error rather than a silent production URL.
    if (!isTrustedStoaOrigin(options.stoaOrigin)) throw new EnrollmentStoaOriginError();
    if (!isTrustedAgoraOrigin(options.agoraOrigin)) throw new EnrollmentAgoraOriginError();
    this.#stoaOrigin = options.stoaOrigin;
    this.#agoraOrigin = options.agoraOrigin;
  }

  /** The immutable origin every enrollment URL from this service names. */
  get stoaOrigin(): string {
    return this.#stoaOrigin;
  }

  /** The immutable Agora origin the device flow's verification URL names. */
  get agoraOrigin(): string {
    return this.#agoraOrigin;
  }

  async #prepareWrite<T>(
    scope: IdempotencyAttempt["scope"],
    principalScope: string,
    key: string | undefined,
    material: unknown,
    now: number,
  ): Promise<{ readonly attempt?: IdempotencyAttempt; readonly replay?: T }> {
    if (key === undefined) return {};
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(key)) throw new EnrollmentError("IDEMPOTENCY_CONFLICT");
    const attempt: IdempotencyAttempt = {
      scope,
      principalScope,
      key,
      digest: await sha256Hex(JSON.stringify(material)),
      now,
    };
    const replay = await this.#store.idempotencyReplay(attempt);
    if (replay === undefined) return { attempt };
    return { replay: await this.#decodeReplay<T>(replay) };
  }

  async #writeReplay<T>(
    attempt: IdempotencyAttempt | undefined,
    response: T,
  ): Promise<EnrollmentIdempotencyWrite | undefined> {
    if (attempt === undefined) return undefined;
    return {
      ...attempt,
      encryptedResponse: await this.#replayProtector.seal(JSON.stringify(response)),
    };
  }

  async #decodeReplay<T>(replay: EnrollmentIdempotencyReplay): Promise<T> {
    // AES-GCM authentication or JSON framing failures are operational/config
    // failures.  They must never be presented as a 409 that implies a client
    // mistake, and no raw cipher text reaches a diagnostic.
    const plaintext = await this.#replayProtector.open(replay.encryptedResponse);
    try {
      return JSON.parse(plaintext) as T;
    } catch {
      throw new EnrollmentReplayConfigurationError();
    }
  }

  async #readRaceReplay<T>(attempt: IdempotencyAttempt): Promise<T> {
    const replay = await this.#store.idempotencyReplay(attempt);
    if (replay === undefined) throw new EnrollmentPersistenceError();
    return await this.#decodeReplay<T>(replay);
  }

  async mint(
    sponsor: EnrollmentPrincipal,
    rawRequest: MintEnrollmentRequest,
    options: EnrollmentWriteOptions = {},
  ): Promise<MintedEnrollment> {
    assertSponsor(sponsor);
    const parsed = MintEnrollmentRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("PAIRING_INVALID");
    const now = this.#clock.now();
    const replay = await this.#prepareWrite<MintedEnrollment>(
      "mint",
      `sponsor:${sponsor.sponsorId}`,
      options.idempotencyKey,
      {
        sponsor: sponsor.sponsorId,
        request: parsed.data,
      },
      now,
    );
    if (replay.replay !== undefined) return await replay.replay;
    const secret = generateVersionedSecret("v1", this.#random);
    const secretHash = await sha256Hex(secret);
    const expiresAt = now + (parsed.data.expires_in_ms ?? ENROLLMENT_SECRET_TTL_MS);

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const enrollmentId = generateEnrollmentId(this.#random);
      const result: MintedEnrollment = { enrollmentId, secret, expiresAt };
      const idempotency = await this.#writeReplay(replay.attempt, result);
      try {
        const created = await this.#store.create(
          {
            enrollmentId,
            sponsorId: sponsor.sponsorId,
            secretHash,
            createdAt: now,
            secretExpiresAt: expiresAt,
            requestedScopes: uniqueEnrollmentScopes(parsed.data.requested_scopes),
            requestedResources: requestedResources(parsed.data, now),
            invalidated: false,
          },
          parsed.data.replaces_enrollment_id,
          idempotency,
        );
        if (created) return result;
      } catch (error) {
        if (error instanceof EnrollmentIdempotencyRaceError && replay.attempt !== undefined) {
          return this.#readRaceReplay<MintedEnrollment>(replay.attempt);
        }
        throw error;
      }
    }
    throw new EnrollmentError("PAIRING_INVALID");
  }

  async claim(
    rawRequest: unknown,
    options: EnrollmentWriteOptions = {},
  ): Promise<EnrollmentClaimResult> {
    // Validate credential-bearing fields first. A malformed or wrong secret is
    // always opaque; only a request whose non-name fields are well-formed may
    // receive a teachable name-policy response.
    const credentialFields = FellowRegistrationCredentialFieldsSchema.safeParse(rawRequest);
    if (!credentialFields.success) throw new EnrollmentError("PAIRING_INVALID");
    const now = this.#clock.now();
    const secretHash = await sha256Hex(credentialFields.data.secret);
    const initialReplay = await this.#prepareWrite<EnrollmentClaimResult>(
      "claim",
      `enrollment:${credentialFields.data.enrollment_id}`,
      options.idempotencyKey,
      credentialFields.data,
      now,
    );
    if (initialReplay.replay !== undefined) return await initialReplay.replay;
    try {
      await this.#store.verifyClaimCredentials(
        credentialFields.data.enrollment_id,
        secretHash,
        now,
      );
    } catch (error) {
      // A concurrent same-key claimant may have consumed the one-time secret
      // between the read-only replay lookup and credential preflight.  Only an
      // exact completed idempotency record recovers it; every other bad
      // credential remains the same opaque PAIRING_INVALID response.
      if (
        error instanceof EnrollmentError &&
        error.code === "PAIRING_INVALID" &&
        initialReplay.attempt !== undefined
      ) {
        const completed = await this.#store.idempotencyReplay(initialReplay.attempt);
        if (completed !== undefined) return this.#decodeReplay<EnrollmentClaimResult>(completed);
      }
      throw error;
    }
    const rawName = (rawRequest as Record<string, unknown>).name;
    const name = typeof rawName === "string" ? rawName : undefined;
    if (name === undefined) {
      throw new EnrollmentError(
        "NAME_INVALID",
        await this.#store.availabilitySuggestions("fellow"),
      );
    }
    const rejectedName = enrollmentNameFailure(name);
    if (rejectedName !== undefined) {
      throw new EnrollmentError(rejectedName, await this.#store.availabilitySuggestions(name));
    }
    const parsed = FellowRegistrationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("REGISTRATION_BODY_INVALID");
    const flowHandle = generateVersionedSecret("flow_v1", this.#random);
    const flowHandleHash = await sha256Hex(flowHandle);
    const result = { flowHandle };
    const idempotency = await this.#writeReplay(initialReplay.attempt, result);
    try {
      await this.#store.claim(
        {
          enrollmentId: parsed.data.enrollment_id,
          secretHash,
          now,
          proposal: {
            proposalId: generateUlid(now, this.#random),
            fellowId: `F-${generateUlid(now, this.#random)}`,
            flowHandleHash,
            name: parsed.data.name,
            model: parsed.data.model,
            harness: parsed.data.harness,
            ...(parsed.data.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: parsed.data.reasoning_effort }),
            ...(parsed.data.tools_note === undefined ? {} : { toolsNote: parsed.data.tools_note }),
            createdAt: now,
            expiresAt: now + PENDING_PROPOSAL_TTL_MS,
            status: "pending",
            pollIntervalSeconds: INITIAL_POLL_INTERVAL_SECONDS,
          },
        },
        idempotency,
      );
      return result;
    } catch (error) {
      if (error instanceof EnrollmentIdempotencyRaceError && initialReplay.attempt !== undefined) {
        return this.#readRaceReplay<EnrollmentClaimResult>(initialReplay.attempt);
      }
      if (
        error instanceof EnrollmentError &&
        error.code === "PAIRING_INVALID" &&
        initialReplay.attempt !== undefined
      ) {
        const completed = await this.#store.idempotencyReplay(initialReplay.attempt);
        if (completed !== undefined) return this.#decodeReplay<EnrollmentClaimResult>(completed);
      }
      throw error;
    }
  }

  async approvalCard(
    sponsor: EnrollmentPrincipal,
    enrollmentId: string,
  ): Promise<EnrollmentApprovalCard> {
    assertSponsor(sponsor);
    return this.#store.approvalCard(enrollmentId, sponsor.sponsorId, this.#clock.now());
  }

  /**
   * Resolve the path-only public capsule. The route owner chooses the face;
   * this seam returns no secret, flow handle, proposal id, token, or sponsor.
   */
  async capsule(enrollmentId: string): Promise<EnrollmentCapsule> {
    return this.#store.capsule(enrollmentId, this.#clock.now());
  }

  /** The sponsor's pending proposals, oldest-expiring first. */
  async pendingApprovals(sponsor: EnrollmentPrincipal): Promise<EnrollmentApprovalCard[]> {
    assertSponsor(sponsor);
    return this.#store.pendingApprovalCardsBySponsor(sponsor.sponsorId, this.#clock.now());
  }

  /** The sponsor's first Fellow page, retained for existing in-process callers. */
  async fellows(sponsor: EnrollmentPrincipal): Promise<SponsorFellowRecord[]> {
    return [...(await this.fellowPage(sponsor)).fellows];
  }

  /** The sponsor's bounded Fellow page: grant facts and non-secret credential hygiene. */
  async fellowPage(
    sponsor: EnrollmentPrincipal,
    after?: SponsorFellowCursorKey,
  ): Promise<SponsorFellowPage> {
    assertSponsor(sponsor);
    return this.#store.fellowsBySponsor(sponsor.sponsorId, this.#clock.now(), after);
  }

  async revokeCredential(
    sponsor: EnrollmentPrincipal,
    rawRequest: SponsorCredentialRevokeRequest,
    options: EnrollmentWriteOptions = {},
  ): Promise<SponsorCredentialRevokeResponse> {
    assertSponsor(sponsor);
    const parsed = SponsorCredentialRevokeRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("CREDENTIAL_REVOKE_BODY_INVALID");
    const now = this.#clock.now();
    const prepared = await this.#prepareWrite<SponsorCredentialRevokeResponse>(
      "credential-revoke",
      `sponsor:${sponsor.sponsorId}`,
      options.idempotencyKey,
      {
        sponsor: sponsor.sponsorId,
        fellow_id: parsed.data.fellow_id,
        credential_id: parsed.data.credential_id,
        confirm: parsed.data.confirm,
      },
      now,
    );
    if (prepared.replay !== undefined) {
      return SponsorCredentialRevokeResponseSchema.parse(await prepared.replay);
    }
    if (prepared.attempt === undefined) throw new EnrollmentError("IDEMPOTENCY_CONFLICT");
    if (!sponsorStepUpIsFresh(parsed.data.step_up_authenticated_at, now)) {
      throw new EnrollmentError("STEP_UP_REQUIRED");
    }
    const eventId = `LEV-${generateUlid(now, this.#random)}`;
    const requestId = await sha256Hex(
      `credential-revoke\0${sponsor.sponsorId}\0${prepared.attempt.key}\0${eventId}`,
    );
    const responseFor = (result: LifecycleCommandResult) =>
      SponsorCredentialRevokeResponseSchema.parse({
        acknowledged: true,
        event_id: eventId,
        fellow_id: parsed.data.fellow_id,
        credential_id: parsed.data.credential_id,
        sponsor_seq: result.sponsorSeq,
        effective_at: result.effectiveAt,
      });
    try {
      const result = await this.#store.revokeCredential({
        sponsorId: sponsor.sponsorId,
        fellowId: parsed.data.fellow_id,
        credentialId: parsed.data.credential_id,
        eventId,
        requestId,
        effectiveAt: now,
        replayFor: async (committed) => this.#writeReplay(prepared.attempt, responseFor(committed)),
      });
      return responseFor(result);
    } catch (error) {
      if (
        error instanceof EnrollmentIdempotencyRaceError ||
        (error instanceof EnrollmentError &&
          (error.code === "FELLOW_LIFECYCLE_NOT_CURRENT" || error.code === "LIFECYCLE_BUSY"))
      ) {
        const replay = await this.#store.idempotencyReplay(prepared.attempt);
        if (replay !== undefined) {
          return SponsorCredentialRevokeResponseSchema.parse(
            await this.#decodeReplay<unknown>(replay),
          );
        }
      }
      throw error;
    }
  }

  async transitionFellow(
    sponsor: EnrollmentPrincipal,
    rawRequest: SponsorFellowLifecycleRequest,
    options: EnrollmentWriteOptions = {},
  ): Promise<SponsorFellowLifecycleResponse> {
    assertSponsor(sponsor);
    const parsed = SponsorFellowLifecycleRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("FELLOW_LIFECYCLE_BODY_INVALID");
    const now = this.#clock.now();
    const prepared = await this.#prepareWrite<SponsorFellowLifecycleResponse>(
      "fellow-lifecycle",
      `sponsor:${sponsor.sponsorId}`,
      options.idempotencyKey,
      {
        sponsor: sponsor.sponsorId,
        fellow_id: parsed.data.fellow_id,
        status: parsed.data.status,
        confirm: parsed.data.confirm,
      },
      now,
    );
    if (prepared.replay !== undefined) {
      return SponsorFellowLifecycleResponseSchema.parse(await prepared.replay);
    }
    if (prepared.attempt === undefined) throw new EnrollmentError("IDEMPOTENCY_CONFLICT");
    if (!sponsorStepUpIsFresh(parsed.data.step_up_authenticated_at, now)) {
      throw new EnrollmentError("STEP_UP_REQUIRED");
    }
    const eventId = `LEV-${generateUlid(now, this.#random)}`;
    const requestId = await sha256Hex(
      `fellow-lifecycle\0${sponsor.sponsorId}\0${prepared.attempt.key}\0${eventId}`,
    );
    const responseFor = (result: LifecycleCommandResult) =>
      SponsorFellowLifecycleResponseSchema.parse({
        acknowledged: true,
        event_id: eventId,
        fellow_id: parsed.data.fellow_id,
        status: parsed.data.status,
        sponsor_seq: result.sponsorSeq,
        effective_at: result.effectiveAt,
      });
    try {
      const result = await this.#store.transitionFellow({
        sponsorId: sponsor.sponsorId,
        fellowId: parsed.data.fellow_id,
        toStatus: parsed.data.status,
        eventId,
        requestId,
        effectiveAt: now,
        replayFor: async (committed) => this.#writeReplay(prepared.attempt, responseFor(committed)),
      });
      return responseFor(result);
    } catch (error) {
      if (
        error instanceof EnrollmentIdempotencyRaceError ||
        (error instanceof EnrollmentError &&
          (error.code === "FELLOW_LIFECYCLE_NOT_CURRENT" || error.code === "LIFECYCLE_BUSY"))
      ) {
        const replay = await this.#store.idempotencyReplay(prepared.attempt);
        if (replay !== undefined) {
          return SponsorFellowLifecycleResponseSchema.parse(
            await this.#decodeReplay<unknown>(replay),
          );
        }
      }
      throw error;
    }
  }

  async panicSponsor(
    sponsor: EnrollmentPrincipal,
    rawRequest: SponsorPanicRequest,
    options: EnrollmentWriteOptions = {},
  ): Promise<SponsorPanicResponse> {
    assertSponsor(sponsor);
    const parsed = SponsorPanicRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("SPONSOR_PANIC_BODY_INVALID");
    const now = this.#clock.now();
    const prepared = await this.#prepareWrite<SponsorPanicResponse>(
      "sponsor-panic",
      `sponsor:${sponsor.sponsorId}`,
      options.idempotencyKey,
      { sponsor: sponsor.sponsorId, confirm: parsed.data.confirm },
      now,
    );
    if (prepared.replay !== undefined) {
      return SponsorPanicResponseSchema.parse(await prepared.replay);
    }
    if (prepared.attempt === undefined) throw new EnrollmentError("IDEMPOTENCY_CONFLICT");
    if (!sponsorStepUpIsFresh(parsed.data.step_up_authenticated_at, now)) {
      throw new EnrollmentError("STEP_UP_REQUIRED");
    }
    const eventId = `LEV-${generateUlid(now, this.#random)}`;
    const requestId = await sha256Hex(
      `sponsor-panic\0${sponsor.sponsorId}\0${prepared.attempt.key}\0${eventId}`,
    );
    const responseFor = (result: LifecycleCommandResult) =>
      SponsorPanicResponseSchema.parse({
        acknowledged: true,
        event_id: eventId,
        sponsor_seq: result.sponsorSeq,
        effective_at: result.effectiveAt,
      });
    try {
      const result = await this.#store.panicSponsor({
        sponsorId: sponsor.sponsorId,
        eventId,
        requestId,
        effectiveAt: now,
        replayFor: async (committed) => this.#writeReplay(prepared.attempt, responseFor(committed)),
      });
      return responseFor(result);
    } catch (error) {
      if (
        error instanceof EnrollmentIdempotencyRaceError ||
        (error instanceof EnrollmentError &&
          (error.code === "FELLOW_LIFECYCLE_NOT_CURRENT" || error.code === "LIFECYCLE_BUSY"))
      ) {
        const replay = await this.#store.idempotencyReplay(prepared.attempt);
        if (replay !== undefined) {
          return SponsorPanicResponseSchema.parse(await this.#decodeReplay<unknown>(replay));
        }
      }
      throw error;
    }
  }

  /**
   * Operator-only capacity change. A signed operator command must carry the
   * exact cap it observed; stale callers cannot overwrite a newer audit event.
   * The stable request intent excludes fresh step-up evidence so a committed
   * receipt remains recoverable after the fifteen-minute window closes.
   */
  async overrideSponsorFellowCap(
    operator: EnrollmentPrincipal,
    rawRequest: OperatorFellowCapOverrideRequest,
    options: EnrollmentWriteOptions = {},
  ): Promise<OperatorFellowCapOverrideResponse> {
    assertOperator(operator);
    const parsed = OperatorFellowCapOverrideRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("OPERATOR_FELLOW_CAP_BODY_INVALID");
    const now = this.#clock.now();
    const prepared = await this.#prepareWrite<OperatorFellowCapOverrideResponse>(
      "operator-fellow-cap",
      `operator:${operator.operatorId}`,
      options.idempotencyKey,
      {
        operator: operator.operatorId,
        sponsor_id: parsed.data.sponsor_id,
        expected_active_fellow_limit: parsed.data.expected_active_fellow_limit,
        expected_sponsor_seq: parsed.data.expected_sponsor_seq,
        active_fellow_limit: parsed.data.active_fellow_limit,
        reason: parsed.data.reason,
        confirm: parsed.data.confirm,
      },
      now,
    );
    if (prepared.replay !== undefined) {
      return OperatorFellowCapOverrideResponseSchema.parse(await prepared.replay);
    }
    if (prepared.attempt === undefined) throw new EnrollmentError("IDEMPOTENCY_CONFLICT");
    if (!sponsorStepUpIsFresh(parsed.data.step_up_authenticated_at, now)) {
      throw new EnrollmentError("STEP_UP_REQUIRED");
    }
    const auditEventId = `OFC-${generateUlid(now, this.#random)}`;
    const requestId = await sha256Hex(
      `operator-fellow-cap\0${operator.operatorId}\0${parsed.data.sponsor_id}\0${prepared.attempt.key}\0${auditEventId}`,
    );
    const responseFor = (result: OperatorFellowCapOverrideResult) =>
      OperatorFellowCapOverrideResponseSchema.parse({
        acknowledged: true,
        audit_event_id: auditEventId,
        sponsor_id: parsed.data.sponsor_id,
        sponsor_seq: result.sponsorSeq,
        previous_active_fellow_limit: result.previousActiveFellowLimit,
        active_fellow_limit: result.activeFellowLimit,
        step_up_authenticated_at: parsed.data.step_up_authenticated_at,
        signer_kid: operator.serviceEnvelopeKid,
        effective_at: result.effectiveAt,
      });
    try {
      const result = await this.#store.overrideSponsorFellowCap({
        sponsorId: parsed.data.sponsor_id,
        operatorId: operator.operatorId,
        auditEventId,
        expectedActiveFellowLimit: parsed.data.expected_active_fellow_limit,
        expectedSponsorSeq: parsed.data.expected_sponsor_seq,
        activeFellowLimit: parsed.data.active_fellow_limit,
        reason: parsed.data.reason,
        stepUpAuthenticatedAt: parsed.data.step_up_authenticated_at,
        signerKid: operator.serviceEnvelopeKid,
        requestId,
        effectiveAt: now,
        replayFor: async (committed) => this.#writeReplay(prepared.attempt, responseFor(committed)),
      });
      return responseFor(result);
    } catch (error) {
      if (
        error instanceof EnrollmentIdempotencyRaceError ||
        (error instanceof EnrollmentError && error.code === "OPERATOR_FELLOW_CAP_NOT_CURRENT")
      ) {
        const replay = await this.#store.idempotencyReplay(prepared.attempt);
        if (replay !== undefined) {
          return OperatorFellowCapOverrideResponseSchema.parse(
            await this.#decodeReplay<unknown>(replay),
          );
        }
      }
      throw error;
    }
  }

  async operatorFellowCapState(
    operator: EnrollmentPrincipal,
    sponsorId: string,
  ): Promise<{ sponsorId: string; activeFellowLimit: number; sponsorSeq: number }> {
    assertOperator(operator);
    if (!/^usr_[A-Za-z0-9_-]{1,60}$/.test(sponsorId)) {
      throw new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT");
    }
    const state = await this.#store.sponsorFellowCap(sponsorId);
    return { sponsorId, ...state };
  }

  /** Operator-only append-only audit history, ordered by the causal cap sequence. */
  async operatorFellowCapAuditPage(
    operator: EnrollmentPrincipal,
    sponsorId: string,
    after?: OperatorFellowCapAuditCursorKey,
  ): Promise<OperatorFellowCapAuditPage> {
    assertOperator(operator);
    if (!/^usr_[A-Za-z0-9_-]{1,60}$/.test(sponsorId)) {
      throw new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT");
    }
    // Keep D1 and in-memory behavior identical: an operator may distinguish
    // an empty immutable history from an unknown sponsor only after the same
    // explicit sponsor-state lookup used by the compare-and-set preflight.
    await this.#store.sponsorFellowCap(sponsorId);
    return this.#store.sponsorFellowCapAudit(sponsorId, after);
  }

  /** W3.1: bootstrap the sponsor row; reports whether this call created it. */
  async bootstrapSponsor(sponsor: EnrollmentPrincipal): Promise<{ created: boolean; at: number }> {
    assertSponsor(sponsor);
    const now = this.#clock.now();
    const created = await this.#store.bootstrapSponsor(sponsor.sponsorId, now);
    return { created, at: now };
  }

  /**
   * W3.5: the proposal-carrying device flow. No principal: the agent is
   * unaffiliated until a sponsor's decision binds the enrollment. The naming
   * law is screened here; a name already taken survives to the decision,
   * which answers NAME_TAKEN with available suggestions.
   */
  async deviceStart(
    rawRequest: unknown,
    options: DeviceStartOptions,
  ): Promise<DeviceCodeStartResponse> {
    const parsed = DeviceCodeStartRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("DEVICE_CODE_BODY_INVALID");
    const nameFailure = enrollmentNameFailure(parsed.data.name);
    if (nameFailure !== undefined) {
      throw new EnrollmentError(
        nameFailure,
        await this.#store.availabilitySuggestions(parsed.data.name),
      );
    }
    const now = this.#clock.now();
    const trustedClientAddress = options.trustedClientAddress.toLowerCase();
    if (
      trustedClientAddress.length < 2 ||
      trustedClientAddress.length > 45 ||
      !/^[0-9a-f:.]+$/.test(trustedClientAddress) ||
      (!trustedClientAddress.includes(".") && !trustedClientAddress.includes(":"))
    ) {
      throw new EnrollmentPersistenceError();
    }
    const clientBucket = await this.#replayProtector.sourceBucket(trustedClientAddress);
    const replay = await this.#prepareWrite<DeviceCodeStartResponse>(
      "device-start",
      `source:${clientBucket}`,
      options.idempotencyKey,
      parsed.data,
      now,
    );
    if (replay.replay !== undefined) return await replay.replay;
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const enrollmentId = generateEnrollmentId(this.#random);
      const flowHandle = generateVersionedSecret("flow_v1", this.#random);
      const userCode = generateUserCode(this.#random);
      // The record's secret hash guards a plaintext that is never issued: the
      // join-capsule and claim paths stay unreachable for device enrollments.
      const neverIssuedSecret = generateVersionedSecret("v1", this.#random);
      const record: EnrollmentRecord = {
        enrollmentId,
        sponsorId: "",
        secretHash: await sha256Hex(neverIssuedSecret),
        createdAt: now,
        secretExpiresAt: now,
        requestedScopes: uniqueEnrollmentScopes(parsed.data.requested_scopes),
        requestedResources: {},
        kind: "device",
        invalidated: false,
      };
      const proposal: ProposalRecord = {
        proposalId: generateUlid(now, this.#random),
        fellowId: `F-${generateUlid(now, this.#random)}`,
        flowHandleHash: await sha256Hex(flowHandle),
        name: parsed.data.name,
        model: parsed.data.model,
        harness: parsed.data.harness,
        ...(parsed.data.reasoning_effort === undefined
          ? {}
          : { reasoningEffort: parsed.data.reasoning_effort }),
        ...(parsed.data.tools_note === undefined ? {} : { toolsNote: parsed.data.tools_note }),
        createdAt: now,
        expiresAt: now + PENDING_PROPOSAL_TTL_MS,
        status: "pending",
        pollIntervalSeconds: INITIAL_POLL_INTERVAL_SECONDS,
      };
      const result: DeviceCodeStartResponse = {
        device_code: flowHandle,
        user_code: userCode,
        verification_url: `${this.#agoraOrigin}/approve`,
        interval_seconds: INITIAL_POLL_INTERVAL_SECONDS,
        expires_in_seconds: DEVICE_CODE_TTL_MS / 1_000,
      };
      const idempotency = await this.#writeReplay(replay.attempt, result);
      try {
        await this.#store.deviceCreate(
          {
            record,
            proposal,
            userCodeHash: await sha256Hex(userCode),
            deviceExpiresAt: now + DEVICE_CODE_TTL_MS,
            clientBucket,
            startWindowBeginning: now - DEVICE_START_RATE_LIMIT_WINDOW_MS,
            startLimit: DEVICE_START_RATE_LIMIT_ATTEMPTS,
            reclaimBatchSize: DEVICE_RECLAIM_BATCH_SIZE,
          },
          idempotency,
        );
        return result;
      } catch (error) {
        if (error instanceof EnrollmentIdempotencyRaceError && replay.attempt !== undefined) {
          return this.#readRaceReplay<DeviceCodeStartResponse>(replay.attempt);
        }
        if (error instanceof EnrollmentIdentifierCollisionError) {
          if (attempt + 1 < MAX_ID_ATTEMPTS) continue;
          throw new EnrollmentPersistenceError();
        }
        // A persistence failure may mean the transaction committed but its
        // response was lost. Never retry it with fresh IDs: keyed calls recover
        // through raceIfPresent above; unkeyed calls receive the operational
        // refusal and can retry deliberately after observing it.
        throw error;
      }
    }
    throw new EnrollmentPersistenceError();
  }

  /**
   * W3.5: sponsor looks up a pending device proposal by its human code. Five
   * failures inside fifteen minutes lock the sponsor out of the window.
   */
  async deviceLookup(
    sponsor: EnrollmentPrincipal,
    rawRequest: unknown,
  ): Promise<EnrollmentApprovalCard> {
    assertSponsor(sponsor);
    const parsed = DeviceLookupRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("DEVICE_LOOKUP_BODY_INVALID");
    const now = this.#clock.now();
    return this.#store.deviceLookup({
      sponsorId: sponsor.sponsorId,
      userCodeHash: await sha256Hex(parsed.data.user_code),
      now,
      windowBeginning: now - DEVICE_LOOKUP_LOCKOUT_WINDOW_MS,
      failureLimit: DEVICE_LOOKUP_LOCKOUT_FAILURES,
      reclaimBatchSize: DEVICE_RECLAIM_BATCH_SIZE,
    });
  }

  async decide(
    sponsor: EnrollmentPrincipal,
    enrollmentId: string,
    rawDecision: SponsorEnrollmentDecisionCommand,
    options: EnrollmentWriteOptions = {},
  ): Promise<void> {
    assertSponsor(sponsor);
    const parsed = SponsorEnrollmentDecisionCommandSchema.safeParse(rawDecision);
    if (!parsed.success) throw new EnrollmentError("DECISION_BODY_INVALID");
    const decision = sponsorEnrollmentDecisionIntent(parsed.data);
    // The Worker is the single validator, so the target binding lives here too
    // and not only on the HTTP edge: a decision authored for one enrollment can
    // never settle another, whatever the caller. Refused before the product
    // idempotency key is prepared, so a retargeted decision creates no product
    // replay record.
    if (decision.enrollment_id !== enrollmentId) {
      throw new EnrollmentError("DECISION_TARGET_MISMATCH");
    }
    const now = this.#clock.now();
    const replay = await this.#prepareWrite<{ readonly acknowledged: true }>(
      "decision",
      `sponsor:${sponsor.sponsorId}`,
      options.idempotencyKey,
      {
        sponsor: sponsor.sponsorId,
        enrollmentId,
        decision,
      },
      now,
    );
    if (replay.replay !== undefined) return;
    if (!sponsorStepUpIsFresh(parsed.data.step_up_authenticated_at, now)) {
      throw new EnrollmentError("STEP_UP_REQUIRED");
    }
    const recoverCommittedDecision = async (): Promise<boolean> => {
      if (replay.attempt === undefined) return false;
      const completed = await this.#store.idempotencyReplay(replay.attempt);
      if (completed === undefined) return false;
      await this.#decodeReplay<{ readonly acknowledged: true }>(completed);
      return true;
    };
    let card: EnrollmentApprovalCard;
    try {
      card = await this.#store.approvalCard(enrollmentId, sponsor.sponsorId, now);
    } catch (error) {
      if (!(error instanceof EnrollmentError && error.code === "WRONG_PRINCIPAL")) throw error;
      try {
        // Unbound device enrollment: the decision binds it, so the card fetch
        // runs off the sponsor gate (kind=device with no sponsor yet).
        card = await this.#store.deviceApprovalCardForDecision(enrollmentId, now);
      } catch (deviceError) {
        // Not an unbound device enrollment either: the original ownership
        // refusal is the honest answer, not the device path's. Operational
        // storage/decoding failures remain operational and must propagate.
        if (!(deviceError instanceof EnrollmentError)) throw deviceError;
        // A same-key winner can bind and commit between the ownership read and
        // this unbound-device read. Its encrypted replay is the only evidence
        // that turns the apparent state refusal into a successful retry.
        if (await recoverCommittedDecision()) return;
        throw error;
      }
    }
    const idempotency = await this.#writeReplay(replay.attempt, { acknowledged: true });
    try {
      await this.#store.decision(
        {
          enrollmentId,
          sponsorId: sponsor.sponsorId,
          decision,
          now,
        },
        idempotency,
      );
    } catch (error) {
      if (error instanceof EnrollmentError && error.code === "NAME_TAKEN") {
        throw new EnrollmentError(
          "NAME_TAKEN",
          await this.#store.availabilitySuggestions(card.name),
        );
      }
      if (error instanceof EnrollmentIdempotencyRaceError && replay.attempt !== undefined) {
        await this.#readRaceReplay<{ readonly acknowledged: true }>(replay.attempt);
        return;
      }
      if (
        error instanceof EnrollmentError &&
        (error.code === "PROPOSAL_NOT_PENDING" ||
          error.code === "PROPOSAL_EXPIRED" ||
          error.code === "WRONG_PRINCIPAL")
      ) {
        if (await recoverCommittedDecision()) return;
      }
      throw error;
    }
  }

  async poll(
    rawRequest: unknown,
    options: EnrollmentWriteOptions = {},
  ): Promise<EnrollmentFlowResult> {
    const parsed = EnrollmentFlowPollRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("FLOW_INVALID");
    const now = this.#clock.now();
    const flowHandleHash = await sha256Hex(parsed.data.flow_handle);
    const replay = await this.#prepareWrite<EnrollmentFlowResult>(
      "poll",
      // Pre-fix Workers persisted pending/slow_down under `flow:<hash>`. A
      // versioned terminal namespace makes those indistinguishable legacy rows
      // unable to mask approval, denial, or expiry after the current Worker is
      // cut over. This namespace change is forward-only: deployment must not
      // mix or roll back to a Worker that knows only the legacy namespace.
      `${POLL_TERMINAL_REPLAY_PRINCIPAL_VERSION}:${flowHandleHash}`,
      options.idempotencyKey,
      parsed.data,
      now,
    );
    if (replay.replay !== undefined) return await replay.replay;
    try {
      const outcome = await this.#store.poll({
        flowHandleHash,
        now,
        createToken: async () => {
          const token = generateFellowToken(now, this.#random);
          return { token, tokenHash: await sha256Hex(token) };
        },
        // Pending and slow_down are observations, not durable outcomes. The
        // documented stable poll key must remain free until approval, denial,
        // or expiry, otherwise its first pending response would mask the
        // terminal state for the full 24-hour replay window.
        replayFor: async (decision) =>
          decision.kind === "pending" || decision.kind === "slow-down"
            ? undefined
            : this.#writeReplay(replay.attempt, this.#flowResultFromDecision(decision)),
      });
      return this.#flowResultFromDecision(outcome);
    } catch (error) {
      if (error instanceof EnrollmentIdempotencyRaceError && replay.attempt !== undefined) {
        return this.#readRaceReplay<EnrollmentFlowResult>(replay.attempt);
      }
      if (
        error instanceof EnrollmentError &&
        error.code === "TOKEN_ALREADY_ISSUED" &&
        replay.attempt !== undefined
      ) {
        // A same-key poll can pass replay preflight immediately before another
        // isolate commits the one-time token and its encrypted response.
        const completed = await this.#store.idempotencyReplay(replay.attempt);
        if (completed !== undefined) {
          return this.#decodeReplay<EnrollmentFlowResult>(completed);
        }
        // Preserve a genuine pre-fix lost-response token when possible. Legacy
        // transient rows are deliberately not replayed: only a schema-valid
        // approved body can explain an already-issued token.
        const legacy = await this.#store.idempotencyReplay({
          ...replay.attempt,
          principalScope: `flow:${flowHandleHash}`,
        });
        if (legacy !== undefined) {
          const approved = EnrollmentApprovedResponseSchema.safeParse(
            await this.#decodeReplay<unknown>(legacy),
          );
          if (approved.success) return approved.data;
        }
      }
      throw error;
    }
  }

  #flowResultFromDecision(outcome: PollDecision): EnrollmentFlowResult {
    switch (outcome.kind) {
      case "pending":
        return EnrollmentPendingResponseSchema.parse({
          status: "authorization_pending",
          retry_after_seconds: outcome.retryAfterSeconds ?? 5,
        });
      case "slow-down":
        return EnrollmentSlowDownResponseSchema.parse({
          status: "slow_down",
          retry_after_seconds: outcome.retryAfterSeconds ?? 5,
        });
      case "denied":
        return EnrollmentDeniedResponseSchema.parse({ status: "access_denied" });
      case "expired":
        return EnrollmentExpiredResponseSchema.parse({ status: "expired_token" });
      case "already-issued":
        throw new EnrollmentError("TOKEN_ALREADY_ISSUED");
      case "issued":
        return EnrollmentApprovedResponseSchema.parse({
          status: "approved",
          token: outcome.token,
          hello_url: stoaHelloUrl(this.#stoaOrigin),
          suggested_next: "GET /v1/hello with the bearer token",
        });
    }
  }

  /**
   * Authenticate a header-only bearer and record its successful use. Expired,
   * revoked, paused, archived and compromised authority returns one opaque miss.
   *
   * ON CONSTANT TIME, precisely.
   *
   * There is no secret comparison on this path, so there is nothing for a
   * constant-time compare to protect. The raw token is hashed once and the
   * digest is used as a LOOKUP KEY; the stored row holds only that digest
   * (SHA-256 at rest). The classic timing target — walking a stored secret
   * against a supplied one until they differ — does not exist here, and adding
   * `timingSafeEqual` would compare two values that are already equal by
   * construction whenever the lookup hit. That would be theatre: it would read
   * as a hardening measure while protecting nothing.
   *
   * What IS observable, and why each is acceptable:
   *
   *  - The shape gate below returns before hashing, so a malformed token is
   *    distinguishable in time from a well-formed one. The shape is published
   *    in the contract and the prefix is deliberately scannable (Fable §5,
   *    "prefix-identifiable for secret scanning"), so this leaks nothing an
   *    attacker did not already have.
   *  - A well-formed unknown token and a well-formed revoked/expired token are
   *    NOT distinguished: both return `undefined` from one predicate in
   *    `authenticateCredential`, which is the property that actually matters
   *    for an attacker probing which credentials exist.
   *  - `Map.get` over a digest key is not constant-time in principle, but the
   *    key is SHA-256 of the secret, so steering bucket collisions requires a
   *    preimage. The deployed D1 path is an indexed lookup on the same digest
   *    and inherits the same argument.
   *
   * The causal tests for this live in `enrollment.test.ts` and assert the
   * structure — digest-keyed lookup, no raw token retained, uniform miss —
   * rather than measuring wall-clock, which on a shared runner would be a
   * flaky assertion about the host and not about this code.
   */
  async credentialBinding(rawToken: string): Promise<FellowCredentialBinding | undefined> {
    if (!/^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/.test(rawToken)) return undefined;
    const tokenHash = await sha256Hex(rawToken);
    return this.#store.authenticateCredential(tokenHash, this.#clock.now(), "bearer");
  }
}

/** A safe, fixed-shape diagnostic for callers that need operational breadcrumbs. */
export function safeEnrollmentDiagnostic(input: {
  readonly suite: string;
  readonly startedAt: number;
  readonly status: "pass" | "fail" | "blocked";
  readonly code: EnrollmentErrorCode | "PROPOSAL_CREATED" | "TOKEN_ISSUED";
}): string {
  return JSON.stringify({
    tool: "bun",
    package: "@asimposium/wire",
    suite: redactCredentials(input.suite),
    version: "0.0.0",
    duration_ms: Math.max(0, Math.round(performance.now() - input.startedAt)),
    status: input.status,
    code: input.code,
    reproduce: "cd apps/wire && bun run test:unit",
  });
}

export const enrollmentCryptoForTests = {
  bytesToBase64Url,
  generateFellowToken,
  generateVersionedSecret,
  sha256Hex,
};
