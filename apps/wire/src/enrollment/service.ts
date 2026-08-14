import {
  ENROLLMENT_SECRET_BYTES,
  ENROLLMENT_SECRET_TTL_MS,
  EnrollmentApprovedResponseSchema,
  EnrollmentDeniedResponseSchema,
  EnrollmentExpiredResponseSchema,
  EnrollmentFlowPollRequestSchema,
  type EnrollmentGrantReduction,
  EnrollmentPendingResponseSchema,
  EnrollmentSlowDownResponseSchema,
  FellowNameSchema,
  FellowRegistrationCredentialFieldsSchema,
  FellowRegistrationRequestSchema,
  type MintEnrollmentRequest,
  MintEnrollmentRequestSchema,
  PENDING_PROPOSAL_TTL_MS,
  type RequestedScope,
  type SponsorEnrollmentDecision,
  SponsorEnrollmentDecisionSchema,
} from "@asimposium/contracts";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ID_ATTEMPTS = 4;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const INITIAL_POLL_INTERVAL_SECONDS = 5;
export const MAX_POLL_INTERVAL_SECONDS = 30;
const POLL_SLOW_DOWN_INCREMENT_SECONDS = 5;

export type EnrollmentErrorCode =
  | "FLOW_INVALID"
  | "HARNESS_AS_NAME"
  | "IDEMPOTENCY_CONFLICT"
  | "NAME_INVALID"
  | "NAME_RESERVED"
  | "NAME_TAKEN"
  | "MODEL_AS_NAME"
  | "DECISION_TARGET_MISMATCH"
  | "PAIRING_EXPIRED"
  | "PAIRING_INVALID"
  | "PROPOSAL_EXPIRED"
  | "PROPOSAL_NOT_PENDING"
  | "SCOPE_ESCALATION"
  | "SCOPE_NOT_REDUCED"
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

/** A D1 failure is operational, never an enrollment or credential verdict. */
export class EnrollmentPersistenceError extends Error {
  constructor() {
    super("enrollment persistence is unavailable");
    this.name = "EnrollmentPersistenceError";
  }
}

export type EnrollmentPrincipal =
  | { readonly type: "sponsor"; readonly sponsorId: string }
  | { readonly type: "fellow"; readonly fellowId: string }
  | { readonly type: "service"; readonly serviceId: string };

/**
 * A Fellow as the sponsor console lists it: the approval-time grant facts.
 * No token, hash, credential id, or proposal handle ever appears here.
 */
export interface SponsorFellowRecord {
  readonly name: string;
  readonly model: string;
  readonly harness: string;
  readonly grantedScopes: readonly RequestedScope[];
  readonly grantedResources: EnrollmentResourceGrants;
  readonly grantedAt: number;
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

export interface EnrollmentReplayProtector {
  seal(plaintext: string): Promise<EncryptedEnrollmentReplay>;
  open(encrypted: EncryptedEnrollmentReplay): Promise<string>;
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
  readonly requestedScopes: readonly RequestedScope[];
  readonly requestedResources: EnrollmentResourceGrants;
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
      readonly hello_url: "https://a.asimposium.org/v1/hello";
      readonly suggested_next: "GET /v1/hello with the bearer token";
    };

export interface EnrollmentRecord {
  readonly enrollmentId: string;
  readonly sponsorId: string;
  readonly secretHash: string;
  readonly createdAt: number;
  readonly secretExpiresAt: number;
  readonly requestedScopes: readonly RequestedScope[];
  readonly requestedResources: EnrollmentResourceGrants;
  invalidated: boolean;
  secretConsumedAt?: number;
  proposal?: ProposalRecord;
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

/** Immutable Fellow + credential binding committed at the one token winner. */
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
   * The store invokes this after it knows the protocol result and immediately
   * before its D1 batch commits that result.  The callback seals the exact
   * response; only its ciphertext reaches D1.
   */
  readonly replayFor?: (decision: PollDecision) => Promise<EnrollmentIdempotencyWrite | undefined>;
}

export interface PollDecision {
  readonly kind: "pending" | "slow-down" | "denied" | "expired" | "issued" | "already-issued";
  readonly retryAfterSeconds?: number;
  readonly token?: string;
}

export interface IdempotencyAttempt {
  readonly scope: "mint" | "claim" | "decision" | "poll";
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
  /** Approval-time grant facts for the console's Fellows list. */
  fellowsBySponsor(sponsorId: string): Promise<SponsorFellowRecord[]>;
  capsule(enrollmentId: string, now: number): Promise<EnrollmentCapsule>;
  poll(attempt: PollAttempt): Promise<PollDecision>;
  availabilitySuggestions(name: string): Promise<readonly string[]>;
  credentialByTokenHash(tokenHash: string): Promise<FellowCredentialBinding | undefined>;
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
 * AES-GCM envelope for idempotent response replay. The caller supplies a
 * stable 256-bit key from deployment configuration; only ciphertext and a
 * random IV enter D1.  There is deliberately no random default: an isolate
 * restart must be able to decrypt a committed response.
 */
export class AesGcmEnrollmentReplayProtector implements EnrollmentReplayProtector {
  readonly #key: Uint8Array;
  readonly #random: EnrollmentRandom;

  constructor(key: Uint8Array, random: EnrollmentRandom = systemRandom) {
    if (key.length !== ENROLLMENT_SECRET_BYTES) {
      throw new TypeError("replay protector requires a 256-bit key");
    }
    this.#key = key.slice();
    this.#random = random;
  }

  async seal(plaintext: string): Promise<EncryptedEnrollmentReplay> {
    const initializationVector = randomBytes(this.#random, 12);
    const key = await crypto.subtle.importKey("raw", this.#key.slice().buffer, "AES-GCM", false, [
      "encrypt",
    ]);
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
    try {
      const initializationVector = base64UrlToBytes(encrypted.initializationVector);
      const ciphertext = base64UrlToBytes(encrypted.ciphertext);
      if (initializationVector.length !== 12 || ciphertext.length < 16) {
        throw new TypeError("invalid encrypted replay envelope");
      }
      const key = await crypto.subtle.importKey("raw", this.#key.slice().buffer, "AES-GCM", false, [
        "decrypt",
      ]);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: initializationVector.slice().buffer },
        key,
        ciphertext.slice().buffer,
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new EnrollmentReplayConfigurationError();
    }
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

export function isStrictEnrollmentScopeReduction(
  requested: readonly RequestedScope[],
  reduced: readonly RequestedScope[],
): boolean {
  const requestedSet = new Set(requested);
  return reduced.every((scope) => requestedSet.has(scope)) && !sameScopes(requested, reduced);
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
    if (next.eventBudget === undefined || reduction.event_budget >= next.eventBudget) {
      throw new EnrollmentError("SCOPE_NOT_REDUCED");
    }
    (next as { eventBudget?: number }).eventBudget = reduction.event_budget;
    changed = true;
  }
  if (reduction.artifact_budget_bytes !== undefined) {
    if (
      next.artifactBudgetBytes === undefined ||
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
    if (next.fellowGrantExpiresAt === undefined || reducedExpiry >= next.fellowGrantExpiresAt) {
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
export class InMemoryEnrollmentStore implements EnrollmentStore {
  readonly #records = new Map<string, EnrollmentRecord>();
  readonly #activeNames = new Map<string, string>();
  readonly #credentials = new Map<string, FellowCredentialBinding>();
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
        predecessor.invalidated = true;
      }
      this.#records.set(record.enrollmentId, record);
      this.commitIdempotency(idempotency);
      return true;
    });
  }

  async claim(attempt: ClaimAttempt, idempotency?: EnrollmentIdempotencyWrite): Promise<void> {
    await this.serialized(() => {
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
      const record = this.#records.get(attempt.enrollmentId);
      if (record === undefined || record.sponsorId !== attempt.sponsorId) {
        throw new EnrollmentError("WRONG_PRINCIPAL");
      }
      const proposal = record.proposal;
      if (proposal === undefined || proposal.status !== "pending") {
        throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      }
      if (attempt.now >= proposal.expiresAt) {
        throw new EnrollmentError("PROPOSAL_EXPIRED");
      }

      if (attempt.decision.decision === "deny") {
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

      const nameOwner = this.#activeNames.get(proposal.name);
      if (nameOwner !== undefined && nameOwner !== proposal.proposalId) {
        throw new EnrollmentError("NAME_TAKEN");
      }
      this.#activeNames.set(proposal.name, proposal.proposalId);
      proposal.status = attempt.decision.decision === "approve" ? "approved" : "reduced";
      proposal.grantedScopes = proposedScopes;
      proposal.grantedResources = proposedResources;
      proposal.grantedAt = attempt.now;
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
      const proposal = record.proposal;
      if (proposal === undefined) throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      if (proposal.status === "pending" && now >= proposal.expiresAt) proposal.status = "expired";
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
        if (proposal.status === "pending" && now >= proposal.expiresAt) {
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
      cards.sort(
        (left, right) => left.proposalExpiresAt - right.proposalExpiresAt,
      );
      return cards;
    });
  }

  async fellowsBySponsor(sponsorId: string): Promise<SponsorFellowRecord[]> {
    return this.serialized(() => {
      const fellows: SponsorFellowRecord[] = [];
      for (const record of this.#records.values()) {
        if (record.sponsorId !== sponsorId || record.proposal === undefined) continue;
        const proposal = record.proposal;
        if (proposal.status !== "approved" && proposal.status !== "reduced") continue;
        if (
          proposal.grantedScopes === undefined ||
          proposal.grantedResources === undefined ||
          proposal.grantedAt === undefined
        ) {
          continue;
        }
        fellows.push({
          name: proposal.name,
          model: proposal.model,
          harness: proposal.harness,
          grantedScopes: proposal.grantedScopes,
          grantedResources: proposal.grantedResources,
          grantedAt: proposal.grantedAt,
        });
      }
      fellows.sort((left, right) => right.grantedAt - left.grantedAt);
      return fellows;
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
        requestedScopes: record.requestedScopes,
        requestedResources: record.requestedResources,
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
      if (proposal.status === "pending" && attempt.now >= proposal.expiresAt) {
        const decision: PollDecision = { kind: "expired" };
        const idempotency = await attempt.replayFor?.(decision);
        proposal.status = "expired";
        this.commitIdempotency(idempotency);
        return decision;
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
        const idempotency = await attempt.replayFor?.(decision);
        proposal.pollIntervalSeconds = pacing.retryAfterSeconds;
        proposal.lastPollAt = attempt.now;
        this.commitIdempotency(idempotency);
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
      if (proposal.tokenHash !== undefined) return { kind: "already-issued" };

      const issued = await attempt.createToken();
      if (proposal.grantedScopes === undefined || proposal.grantedResources === undefined) {
        throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      }
      const decision: PollDecision = { kind: "issued", token: issued.token };
      const idempotency = await attempt.replayFor?.(decision);
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

  async credentialByTokenHash(tokenHash: string): Promise<FellowCredentialBinding | undefined> {
    return this.serialized(() => this.#credentials.get(tokenHash));
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
    const recordKey = `${idempotency.scope}:${idempotency.principalScope}:${idempotency.key}`;
    const existing = this.#idempotency.get(recordKey);
    if (existing !== undefined && idempotency.now < existing.expiresAt) {
      throw new EnrollmentIdempotencyRaceError();
    }
    this.#idempotency.set(recordKey, {
      digest: idempotency.digest,
      encryptedResponse: idempotency.encryptedResponse,
      expiresAt: idempotency.now + IDEMPOTENCY_TTL_MS,
    });
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

  constructor(options: EnrollmentServiceOptions = {}) {
    this.#store = options.store ?? new InMemoryEnrollmentStore();
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? systemRandom;
    if (options.replayProtector === undefined) throw new EnrollmentReplayConfigurationError();
    this.#replayProtector = options.replayProtector;
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
    if (!parsed.success) throw new EnrollmentError("NAME_INVALID");
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

  /** The sponsor's Fellows as the console lists them: grant facts, never credentials. */
  async fellows(sponsor: EnrollmentPrincipal): Promise<SponsorFellowRecord[]> {
    assertSponsor(sponsor);
    return this.#store.fellowsBySponsor(sponsor.sponsorId);
  }

  async decide(
    sponsor: EnrollmentPrincipal,
    enrollmentId: string,
    rawDecision: SponsorEnrollmentDecision,
    options: EnrollmentWriteOptions = {},
  ): Promise<void> {
    assertSponsor(sponsor);
    const parsed = SponsorEnrollmentDecisionSchema.safeParse(rawDecision);
    if (!parsed.success) throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    // The Worker is the single validator, so the target binding lives here too
    // and not only on the HTTP edge: a decision authored for one enrollment can
    // never settle another, whatever the caller. Refused before the idempotency
    // key is prepared, so a retargeted decision burns no replay slot.
    if (parsed.data.enrollment_id !== enrollmentId) {
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
        decision: parsed.data,
      },
      now,
    );
    if (replay.replay !== undefined) return;
    const card = await this.#store.approvalCard(enrollmentId, sponsor.sponsorId, now);
    const idempotency = await this.#writeReplay(replay.attempt, { acknowledged: true });
    try {
      await this.#store.decision(
        {
          enrollmentId,
          sponsorId: sponsor.sponsorId,
          decision: parsed.data,
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
      `flow:${flowHandleHash}`,
      options.idempotencyKey,
      parsed.data,
      now,
    );
    if (replay.replay !== undefined) return await replay.replay;
    let outcome: PollDecision;
    try {
      outcome = await this.#store.poll({
        flowHandleHash,
        now,
        createToken: async () => {
          const token = generateFellowToken(now, this.#random);
          return { token, tokenHash: await sha256Hex(token) };
        },
        replayFor: async (decision) =>
          this.#writeReplay(replay.attempt, this.#flowResultFromDecision(decision)),
      });
    } catch (error) {
      if (error instanceof EnrollmentIdempotencyRaceError && replay.attempt !== undefined) {
        return this.#readRaceReplay<EnrollmentFlowResult>(replay.attempt);
      }
      throw error;
    }
    return this.#flowResultFromDecision(outcome);
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
          hello_url: "https://a.asimposium.org/v1/hello",
          suggested_next: "GET /v1/hello with the bearer token",
        });
    }
  }

  /**
   * Token-to-identity lookup for the future `/v1/hello` owner. It creates no
   * route and proves no deployed authentication; it prevents an approved flow
   * from returning an orphan credential in the persistence contract.
   */
  async credentialBinding(rawToken: string): Promise<FellowCredentialBinding | undefined> {
    if (!/^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/.test(rawToken)) return undefined;
    const tokenHash = await sha256Hex(rawToken);
    return this.#store.credentialByTokenHash(tokenHash);
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
    suite: input.suite,
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
