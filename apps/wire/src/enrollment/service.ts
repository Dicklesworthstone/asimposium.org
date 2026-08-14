import {
  ENROLLMENT_SECRET_BYTES,
  ENROLLMENT_SECRET_TTL_MS,
  EnrollmentApprovedResponseSchema,
  EnrollmentDeniedResponseSchema,
  EnrollmentExpiredResponseSchema,
  EnrollmentFlowPollRequestSchema,
  EnrollmentPendingResponseSchema,
  EnrollmentSecretSchema,
  FellowNameSchema,
  FellowRegistrationRequestSchema,
  MintEnrollmentRequestSchema,
  PENDING_PROPOSAL_TTL_MS,
  SponsorEnrollmentDecisionSchema,
  type EnrollmentFlowPollRequest,
  type FellowRegistrationRequest,
  type MintEnrollmentRequest,
  type RequestedScope,
  type SponsorEnrollmentDecision,
} from "../../../../packages/contracts/src/enrollment.ts";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ID_ATTEMPTS = 4;

export type EnrollmentErrorCode =
  | "FLOW_INVALID"
  | "NAME_INVALID"
  | "NAME_RESERVED"
  | "NAME_TAKEN"
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

  constructor(code: EnrollmentErrorCode) {
    super(code);
    this.name = "EnrollmentError";
    this.code = code;
  }
}

export type EnrollmentPrincipal =
  | { readonly type: "sponsor"; readonly sponsorId: string }
  | { readonly type: "fellow"; readonly fellowId: string }
  | { readonly type: "service"; readonly serviceId: string };

export interface EnrollmentClock {
  now(): number;
}

export interface EnrollmentRandom {
  bytes(length: number): Uint8Array;
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
  readonly proposalExpiresAt: number;
}

export interface EnrollmentClaimResult {
  /** A high-entropy body-only credential; no proposal ID is a poll credential. */
  readonly flowHandle: string;
}

export type EnrollmentFlowResult =
  | { readonly status: "authorization_pending"; readonly retry_after_seconds: number }
  | { readonly status: "access_denied" }
  | { readonly status: "expired_token" }
  | {
      readonly status: "approved";
      readonly token: string;
      readonly hello_url: "https://a.asimposium.org/v1/hello";
      readonly suggested_next: "GET /v1/hello with the bearer token";
    };

interface EnrollmentRecord {
  readonly enrollmentId: string;
  readonly sponsorId: string;
  readonly secretHash: string;
  readonly secretExpiresAt: number;
  readonly requestedScopes: readonly RequestedScope[];
  secretConsumedAt?: number;
  proposal?: ProposalRecord;
}

interface ProposalRecord {
  readonly proposalId: string;
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
  tokenHash?: string;
  tokenIssuedAt?: number;
}

export interface EnrollmentStorageSnapshot {
  readonly enrollmentId: string;
  readonly secretHash: string;
  readonly secretConsumedAt?: number;
  readonly flowHandleHash?: string;
  readonly tokenHash?: string;
}

interface ClaimAttempt {
  readonly enrollmentId: string;
  readonly secretHash: string;
  readonly proposal: ProposalRecord;
  readonly now: number;
}

interface DecisionAttempt {
  readonly enrollmentId: string;
  readonly sponsorId: string;
  readonly decision: SponsorEnrollmentDecision;
  readonly now: number;
}

interface TokenFactoryResult {
  readonly token: string;
  readonly tokenHash: string;
}

interface PollAttempt {
  readonly flowHandleHash: string;
  readonly now: number;
  readonly createToken: () => Promise<TokenFactoryResult>;
}

interface PollDecision {
  readonly kind: "pending" | "denied" | "expired" | "issued" | "already-issued";
  readonly token?: string;
}

/**
 * The persistence seam intentionally exposes only atomic state transitions.
 * A D1 adapter can implement it without teaching a route about secret hashes,
 * pending-expiry races, or one-token-winner semantics.
 */
export interface EnrollmentStore {
  create(record: EnrollmentRecord): Promise<boolean>;
  claim(attempt: ClaimAttempt): Promise<void>;
  decision(attempt: DecisionAttempt): Promise<void>;
  approvalCard(enrollmentId: string, sponsorId: string, now: number): Promise<EnrollmentApprovalCard>;
  poll(attempt: PollAttempt): Promise<PollDecision>;
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
  if (bytes.length !== length) throw new TypeError("secure random source returned incorrect length");
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
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
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

function validateName(name: string): void {
  if (!FellowNameSchema.safeParse(name).success) throw new EnrollmentError("NAME_INVALID");
  if (MODEL_NAMES.has(name)) throw new EnrollmentError("NAME_RESERVED");
  if (HARNESS_NAMES.has(name)) throw new EnrollmentError("NAME_RESERVED");
  if (RESERVED_FELLOW_NAMES.has(name) || /(^|-)official($|-)|(^|-)real($|-)|-mod$/.test(name)) {
    throw new EnrollmentError("NAME_RESERVED");
  }
}

function assertSponsor(principal: EnrollmentPrincipal): asserts principal is Extract<EnrollmentPrincipal, { type: "sponsor" }> {
  if (principal.type !== "sponsor" || principal.sponsorId.length === 0) {
    throw new EnrollmentError("WRONG_PRINCIPAL");
  }
}

function uniqueScopes(scopes: readonly RequestedScope[]): readonly RequestedScope[] {
  return [...new Set(scopes)].sort();
}

function sameScopes(left: readonly RequestedScope[], right: readonly RequestedScope[]): boolean {
  const normalizedLeft = uniqueScopes(left);
  const normalizedRight = uniqueScopes(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((scope, index) => scope === normalizedRight[index])
  );
}

function isStrictScopeReduction(
  requested: readonly RequestedScope[],
  reduced: readonly RequestedScope[],
): boolean {
  const requestedSet = new Set(requested);
  return reduced.every((scope) => requestedSet.has(scope)) && !sameScopes(requested, reduced);
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
  #tail: Promise<void> = Promise.resolve();

  async create(record: EnrollmentRecord): Promise<boolean> {
    return this.serialized(() => {
      if (this.#records.has(record.enrollmentId)) return false;
      this.#records.set(record.enrollmentId, record);
      return true;
    });
  }

  async claim(attempt: ClaimAttempt): Promise<void> {
    await this.serialized(() => {
      const record = this.#records.get(attempt.enrollmentId);
      if (record === undefined || !constantTimeEqual(record.secretHash, attempt.secretHash)) {
        throw new EnrollmentError("PAIRING_INVALID");
      }
      if (attempt.now >= record.secretExpiresAt) throw new EnrollmentError("PAIRING_EXPIRED");
      if (record.secretConsumedAt !== undefined) throw new EnrollmentError("PAIRING_INVALID");
      record.secretConsumedAt = attempt.now;
      record.proposal = attempt.proposal;
    });
  }

  async decision(attempt: DecisionAttempt): Promise<void> {
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
        proposal.status = "expired";
        throw new EnrollmentError("PROPOSAL_EXPIRED");
      }

      if (attempt.decision.decision === "deny") {
        proposal.status = "denied";
        return;
      }

      const proposedScopes =
        attempt.decision.decision === "approve"
          ? record.requestedScopes
          : uniqueScopes(attempt.decision.scopes);
      if (attempt.decision.decision === "reduce") {
        if (!proposedScopes.every((scope) => record.requestedScopes.includes(scope))) {
          throw new EnrollmentError("SCOPE_ESCALATION");
        }
        if (!isStrictScopeReduction(record.requestedScopes, proposedScopes)) {
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
      if (proposal.status === "expired") throw new EnrollmentError("PROPOSAL_EXPIRED");
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
        proposalExpiresAt: proposal.expiresAt,
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
      if (proposal.status === "pending" && attempt.now >= proposal.expiresAt) proposal.status = "expired";
      if (proposal.status === "pending") return { kind: "pending" };
      if (proposal.status === "denied") return { kind: "denied" };
      if (proposal.status === "expired") return { kind: "expired" };
      if (proposal.tokenHash !== undefined) return { kind: "already-issued" };

      const issued = await attempt.createToken();
      proposal.tokenHash = issued.tokenHash;
      proposal.tokenIssuedAt = attempt.now;
      return { kind: "issued", token: issued.token };
    });
  }

  /** Test-only storage inspection; it intentionally exposes hashes but never plaintext credentials. */
  async storageSnapshot(enrollmentId: string): Promise<EnrollmentStorageSnapshot | undefined> {
    return this.serialized(() => {
      const record = this.#records.get(enrollmentId);
      if (record === undefined) return undefined;
      return {
        enrollmentId: record.enrollmentId,
        secretHash: record.secretHash,
        ...(record.secretConsumedAt === undefined ? {} : { secretConsumedAt: record.secretConsumedAt }),
        ...(record.proposal === undefined ? {} : { flowHandleHash: record.proposal.flowHandleHash }),
        ...(record.proposal?.tokenHash === undefined ? {} : { tokenHash: record.proposal.tokenHash }),
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
}

export class EnrollmentService {
  readonly #store: EnrollmentStore;
  readonly #clock: EnrollmentClock;
  readonly #random: EnrollmentRandom;

  constructor(options: EnrollmentServiceOptions = {}) {
    this.#store = options.store ?? new InMemoryEnrollmentStore();
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? systemRandom;
  }

  async mint(
    sponsor: EnrollmentPrincipal,
    rawRequest: MintEnrollmentRequest,
  ): Promise<MintedEnrollment> {
    assertSponsor(sponsor);
    const parsed = MintEnrollmentRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("PAIRING_INVALID");
    const now = this.#clock.now();
    const secret = generateVersionedSecret("v1", this.#random);
    const secretHash = await sha256Hex(secret);
    const expiresAt = now + (parsed.data.expires_in_ms ?? ENROLLMENT_SECRET_TTL_MS);

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const enrollmentId = generateEnrollmentId(this.#random);
      const created = await this.#store.create({
        enrollmentId,
        sponsorId: sponsor.sponsorId,
        secretHash,
        secretExpiresAt: expiresAt,
        requestedScopes: uniqueScopes(parsed.data.requested_scopes),
      });
      if (created) return { enrollmentId, secret, expiresAt };
    }
    throw new EnrollmentError("PAIRING_INVALID");
  }

  async claim(rawRequest: FellowRegistrationRequest): Promise<EnrollmentClaimResult> {
    const parsed = FellowRegistrationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("PAIRING_INVALID");
    validateName(parsed.data.name);
    const now = this.#clock.now();
    const flowHandle = generateVersionedSecret("flow_v1", this.#random);
    const [secretHash, flowHandleHash] = await Promise.all([
      sha256Hex(parsed.data.secret),
      sha256Hex(flowHandle),
    ]);
    await this.#store.claim({
      enrollmentId: parsed.data.enrollment_id,
      secretHash,
      now,
      proposal: {
        proposalId: generateUlid(now, this.#random),
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
      },
    });
    return { flowHandle };
  }

  async approvalCard(
    sponsor: EnrollmentPrincipal,
    enrollmentId: string,
  ): Promise<EnrollmentApprovalCard> {
    assertSponsor(sponsor);
    return this.#store.approvalCard(enrollmentId, sponsor.sponsorId, this.#clock.now());
  }

  async decide(
    sponsor: EnrollmentPrincipal,
    enrollmentId: string,
    rawDecision: SponsorEnrollmentDecision,
  ): Promise<void> {
    assertSponsor(sponsor);
    const parsed = SponsorEnrollmentDecisionSchema.safeParse(rawDecision);
    if (!parsed.success) throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    await this.#store.decision({
      enrollmentId,
      sponsorId: sponsor.sponsorId,
      decision: parsed.data,
      now: this.#clock.now(),
    });
  }

  async poll(rawRequest: EnrollmentFlowPollRequest): Promise<EnrollmentFlowResult> {
    const parsed = EnrollmentFlowPollRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new EnrollmentError("FLOW_INVALID");
    const now = this.#clock.now();
    const flowHandleHash = await sha256Hex(parsed.data.flow_handle);
    const outcome = await this.#store.poll({
      flowHandleHash,
      now,
      createToken: async () => {
        const token = generateFellowToken(now, this.#random);
        return { token, tokenHash: await sha256Hex(token) };
      },
    });
    switch (outcome.kind) {
      case "pending":
        return EnrollmentPendingResponseSchema.parse({
          status: "authorization_pending",
          retry_after_seconds: 5,
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
