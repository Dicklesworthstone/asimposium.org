import {
  EnrollmentDeclaredRuntimeSchema,
  type EnrollmentGrantReduction,
  EnrollmentIdSchema,
  EnrollmentResourceGrantsSchema,
  type FellowCredentialProfile,
  type FellowLifecycleStatus,
  FellowNameSchema,
  type RequestedScope,
  RequestedScopeSchema,
  SPONSOR_FELLOW_PAGE_SIZE,
  type SponsorFellowCursorKey,
} from "@asimposium/contracts";
// D1 proves JSON syntax; these schemas prove that stored authority still obeys
// the public scope vocabulary and resource bounds when it is read back.
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

import {
  type ClaimAttempt,
  type CredentialRevokeAttempt,
  type DecisionAttempt,
  type DeviceCreateInput,
  type DeviceLookupAttempt,
  type EnrollmentApprovalCard,
  type EnrollmentCapsule,
  EnrollmentError,
  EnrollmentIdempotencyRaceError,
  type EnrollmentIdempotencyReplay,
  type EnrollmentIdempotencyWrite,
  EnrollmentIdentifierCollisionError,
  EnrollmentPersistenceError,
  type EnrollmentRecord,
  type EnrollmentResourceGrants,
  type EnrollmentStore,
  enrollmentGrantIsWithinRequest,
  enrollmentNameFailure,
  FELLOW_TOKEN_TTL_MS,
  type FellowCredentialBinding,
  type FellowLifecycleAttempt,
  type IdempotencyAttempt,
  isStrictEnrollmentScopeReduction,
  type LifecycleCommandResult,
  nextEnrollmentPollPacing,
  type PollAttempt,
  type PollDecision,
  reduceEnrollmentResources,
  SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS,
  SponsorEnrollmentRateLimitError,
  type SponsorFellowPage,
  type SponsorFellowRecord,
  type SponsorPanicAttempt,
  uniqueEnrollmentScopes,
} from "./service.ts";

type ProposalStatus = "pending" | "approved" | "reduced" | "denied" | "expired";

interface RecordRow {
  enrollment_id: string;
  sponsor_id: string;
  kind: "join-url" | "device";
  secret_hash: string;
  secret_expires_at: number;
  requested_scopes_json: string;
  requested_resources_json: string;
  invalidated: number;
  secret_consumed_at: number | null;
}

interface RecordAuthorityEvidenceRow extends RecordRow {
  record_created_at: number;
  requested_resource_key_count: number;
  requested_resource_distinct_key_count: number;
}

interface ProposalRow extends RecordAuthorityEvidenceRow {
  proposal_id: string;
  fellow_id: string;
  flow_handle_hash: string;
  name: string;
  model: string;
  harness: string;
  reasoning_effort: string | null;
  tools_note: string | null;
  created_at: number;
  expires_at: number;
  status: ProposalStatus;
  granted_scopes_json: string | null;
  granted_resources_json: string | null;
  token_hash: string | null;
  token_issued_at: number | null;
  poll_interval_seconds: number;
  last_poll_at: number | null;
  durable_granted_scopes_json: string | null;
  durable_granted_resources_json: string | null;
  durable_granted_at: number | null;
  sponsor_panic_at: number | null;
}

interface PollingProposalRow extends ProposalRow {
  enrollment_kind: "join-url" | "device";
  device_record_expires_at: number | null;
  device_mapping_expires_at: number | null;
  device_mapping_reclaimed_at: number | null;
}

interface LifecycleSponsorRow {
  lifecycle_seq: number;
  panic_at: number | null;
}

interface LifecycleCredentialRow extends LifecycleSponsorRow {
  issued_at: number;
  last_used_at: number | null;
}

interface LifecycleFellowRow extends LifecycleSponsorRow {
  status: FellowLifecycleStatus;
  created_at: number;
  status_changed_at: number | null;
  review_from: number;
}

interface UnboundDeviceProposalRow extends ProposalRow {
  device_mapping_expires_at: number | null;
}

interface CredentialRow {
  fellow_id: string;
  credential_id: string;
  sponsor_id: string;
  name: string;
  model: string;
  harness: string;
  granted_scopes_json: string;
  granted_resources_json: string;
  token_hash: string;
  issued_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  credential_profile: FellowCredentialProfile;
  status: FellowLifecycleStatus;
  proposal_status: "approved" | "reduced";
  requested_scopes_json: string;
  requested_resources_json: string;
  requested_record_created_at: number;
  requested_resource_key_count: number;
  requested_resource_distinct_key_count: number;
}

function credentialBindingIdentityIsValid(row: CredentialRow): boolean {
  return (
    typeof row.fellow_id === "string" &&
    row.fellow_id.length >= 1 &&
    row.fellow_id.length <= 80 &&
    !row.fellow_id.includes("\0") &&
    typeof row.credential_id === "string" &&
    row.credential_id.length >= 1 &&
    row.credential_id.length <= 160 &&
    !row.credential_id.includes("\0") &&
    typeof row.sponsor_id === "string" &&
    row.sponsor_id.length >= 1 &&
    row.sponsor_id.length <= 160 &&
    !row.sponsor_id.includes("\0") &&
    FellowNameSchema.safeParse(row.name).success &&
    EnrollmentDeclaredRuntimeSchema.safeParse(row.model).success &&
    EnrollmentDeclaredRuntimeSchema.safeParse(row.harness).success
  );
}

function credentialBindingEvidenceIsValid(row: CredentialRow): boolean {
  return (
    Number.isSafeInteger(row.issued_at) &&
    row.issued_at >= 0 &&
    Number.isSafeInteger(row.expires_at) &&
    row.expires_at > row.issued_at &&
    row.expires_at - row.issued_at <= FELLOW_TOKEN_TTL_MS &&
    (row.last_used_at === null ||
      (Number.isSafeInteger(row.last_used_at) && row.last_used_at >= 0)) &&
    (row.revoked_at === null || (Number.isSafeInteger(row.revoked_at) && row.revoked_at >= 0))
  );
}

interface IdempotencyRow {
  request_digest: string;
  response_ciphertext: string;
  response_initialization_vector: string;
  expires_at: number;
}

/** Columns selected by `pendingApprovalCardsBySponsor`: record join pending proposal. */
interface PendingProposalRow extends RecordAuthorityEvidenceRow {
  proposal_id: string;
  name: string;
  model: string;
  harness: string;
  reasoning_effort: string | null;
  tools_note: string | null;
  created_at: number;
  expires_at: number;
  status: ProposalStatus;
}

/** Columns selected by `fellowsBySponsor`: fellow join its approval-time grant. */
interface FellowGrantRow {
  fellow_id: string;
  name: string;
  model: string;
  harness: string;
  status: FellowLifecycleStatus;
  granted_scopes_json: string;
  granted_resources_json: string;
  granted_at: number;
  credential_id: string | null;
  credential_profile: FellowCredentialProfile | null;
  issued_at: number | null;
  expires_at: number | null;
  last_used_at: number | null;
  page_position: number;
  authority_valid: number;
}

const sql = (db: D1Database, query: string, ...values: unknown[]): D1PreparedStatement =>
  db.prepare(query).bind(...values);

/**
 * How long a replay row stays claimable. Must match `IDEMPOTENCY_TTL_MS` in
 * `service.ts`, which is what the service tells the caller: two copies of the
 * same number in two files is how a retry window starts disagreeing with the
 * window a client was promised. Named here rather than inlined twice below.
 */
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

function secretSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const width = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < width; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function parseScopes(encoded: string): readonly RequestedScope[] {
  try {
    const value: unknown = JSON.parse(encoded);
    if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
      throw new TypeError("invalid scope payload");
    }
    const parsed = value.map((scope) => RequestedScopeSchema.parse(scope));
    const unique = uniqueEnrollmentScopes(parsed);
    if (unique.length !== parsed.length) throw new TypeError("duplicate scope payload");
    return unique;
  } catch {
    throw new EnrollmentPersistenceError();
  }
}

function parseResources(encoded: string): EnrollmentResourceGrants {
  try {
    const value: unknown = JSON.parse(encoded);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("invalid resource payload");
    }
    const input = value as Record<string, unknown>;
    const allowed = new Set([
      "problemBinding",
      "firstDirective",
      "eventBudget",
      "artifactBudgetBytes",
      "fellowGrantExpiresAt",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new TypeError("unknown resource grant");
    }
    const parsed = EnrollmentResourceGrantsSchema.parse({
      ...(input.problemBinding === undefined ? {} : { problem_binding: input.problemBinding }),
      ...(input.firstDirective === undefined ? {} : { first_directive: input.firstDirective }),
      ...(input.eventBudget === undefined ? {} : { event_budget: input.eventBudget }),
      ...(input.artifactBudgetBytes === undefined
        ? {}
        : { artifact_budget_bytes: input.artifactBudgetBytes }),
      ...(input.fellowGrantExpiresAt === undefined
        ? {}
        : { fellow_grant_expires_at: input.fellowGrantExpiresAt }),
    });
    return {
      ...(parsed.problem_binding === undefined ? {} : { problemBinding: parsed.problem_binding }),
      ...(parsed.first_directive === undefined ? {} : { firstDirective: parsed.first_directive }),
      ...(parsed.event_budget === undefined ? {} : { eventBudget: parsed.event_budget }),
      ...(parsed.artifact_budget_bytes === undefined
        ? {}
        : { artifactBudgetBytes: parsed.artifact_budget_bytes }),
      ...(parsed.fellow_grant_expires_at === undefined
        ? {}
        : { fellowGrantExpiresAt: parsed.fellow_grant_expires_at }),
    };
  } catch {
    throw new EnrollmentPersistenceError();
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function requestedRecord(
  row: RecordRow,
): Pick<EnrollmentRecord, "requestedScopes" | "requestedResources"> {
  return {
    requestedScopes: parseScopes(row.requested_scopes_json),
    requestedResources: parseResources(row.requested_resources_json),
  };
}

function requestedRecordWithEvidence(
  row: RecordAuthorityEvidenceRow,
): Pick<EnrollmentRecord, "requestedScopes" | "requestedResources"> {
  if (
    !recordEvidenceIsValid(row) ||
    !Number.isSafeInteger(row.record_created_at) ||
    row.record_created_at < 1 ||
    (row.kind === "join-url" &&
      (row.secret_expires_at <= row.record_created_at ||
        row.secret_expires_at - row.record_created_at > 30 * 60 * 1_000)) ||
    (row.kind === "device" && row.secret_expires_at !== row.record_created_at) ||
    (row.secret_consumed_at !== null &&
      (row.secret_consumed_at < row.record_created_at ||
        row.secret_consumed_at >= row.secret_expires_at)) ||
    !Number.isSafeInteger(row.requested_resource_key_count) ||
    !Number.isSafeInteger(row.requested_resource_distinct_key_count) ||
    row.requested_resource_key_count !== row.requested_resource_distinct_key_count
  ) {
    throw new EnrollmentPersistenceError();
  }
  const requested = requestedRecord(row);
  const grantExpiresAt = requested.requestedResources.fellowGrantExpiresAt;
  if (
    grantExpiresAt !== undefined &&
    (grantExpiresAt <= row.record_created_at ||
      grantExpiresAt - row.record_created_at > 365 * 24 * 60 * 60 * 1_000)
  ) {
    throw new EnrollmentPersistenceError();
  }
  return requested;
}

function proposalEvidenceIsValid(row: {
  readonly created_at: number;
  readonly expires_at: number;
}) {
  return (
    Number.isSafeInteger(row.created_at) &&
    row.created_at >= 1 &&
    Number.isSafeInteger(row.expires_at) &&
    row.expires_at - row.created_at === 24 * 60 * 60 * 1_000
  );
}

function recordEvidenceIsValid(row: RecordRow): boolean {
  return (
    typeof row.enrollment_id === "string" &&
    EnrollmentIdSchema.safeParse(row.enrollment_id).success &&
    typeof row.sponsor_id === "string" &&
    (row.sponsor_id === ""
      ? row.kind === "device"
      : /^usr_[A-Za-z0-9_-]{1,60}$/.test(row.sponsor_id)) &&
    typeof row.secret_hash === "string" &&
    /^[0-9a-f]{64}$/.test(row.secret_hash) &&
    typeof row.requested_scopes_json === "string" &&
    typeof row.requested_resources_json === "string" &&
    Number.isSafeInteger(row.secret_expires_at) &&
    row.secret_expires_at > 0 &&
    (row.invalidated === 0 || row.invalidated === 1) &&
    (row.secret_consumed_at === null ||
      (Number.isSafeInteger(row.secret_consumed_at) && row.secret_consumed_at >= 0))
  );
}

function proposalStatus(value: string): ProposalStatus {
  if (["pending", "approved", "reduced", "denied", "expired"].includes(value)) {
    return value as ProposalStatus;
  }
  throw new EnrollmentPersistenceError();
}

function isUniqueNameFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/UNIQUE constraint failed: enrollment_fellows\.name/i.test(error.message) ||
      /Fellow name already exists/i.test(error.message))
  );
}

function isActiveFellowCapFailure(error: unknown): boolean {
  return error instanceof Error && /active Fellow cap reached/i.test(error.message);
}

function isSponsorEnrollmentRateFailure(error: unknown): boolean {
  return error instanceof Error && /sponsor enrollment rate reached/i.test(error.message);
}

function isSponsorBootstrapRequiredFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /sponsor bootstrap required before enrollment decision/i.test(error.message)
  );
}

/**
 * The suggestion suffix law. Candidates are `<stem>-<n>` for n in
 * [2, 9_999], and a saturated range yields fewer than three suggestions rather
 * than an error. Both bounds are public behaviour, not tuning knobs.
 */
const FIRST_SUGGESTION_SUFFIX = 2;
const MAX_SUGGESTION_SUFFIX = 9_999;
const SUGGESTION_COUNT = 3;
/**
 * Rows fetched beyond the three that are returned, so the JS policy filter has
 * slack without a second statement.
 *
 * Sizing is a proof, not a guess. A candidate is `<stem>-<n>` where the stem
 * has already passed `enrollmentNameFailure`, so of the policy's rules only
 * exact-literal membership can still fire:
 *
 *  - the prefix rules (harness, model, product identity) test `name === X` or
 *    `name.startsWith(X + "-")`, and a clean stem satisfies neither, so
 *    appending `-<n>` cannot make them true;
 *  - the profanity rule leet-normalises each hyphen-separated part, and digits
 *    map only into {a,e,i,o,s,t}, while every denylist word needs a letter
 *    outside that set, so a numeric part can never become one;
 *  - `-mod$`, `official` and `real` cannot match a name ending in digits;
 *  - `FellowNameSchema` always holds: a stem is 1..24 bytes and `n` at most 4
 *    digits, giving 3..29 of 3..32 permitted.
 *
 * That leaves the reserved literals, of which exactly one — `gpt-5-6` — ends in
 * a digit-only segment. So at most one candidate per stem is ever filtered, and
 * eight is an eightfold margin. The margin is not load-bearing on its own: the
 * caller fails closed if the filter ever removes more than this covers.
 */
const SUGGESTION_POLICY_OVERFETCH = 8;
const LIFECYCLE_LEASE_TTL_MS = 5_000;
const MAX_LIFECYCLE_LEASE_ATTEMPTS = 16;

function lifecycleLeaseRetryDelay(eventId: string, attempt: number): number {
  const jitter = eventId.charCodeAt((attempt + 4) % eventId.length) % 11;
  return Math.min(50, 10 + attempt * 3 + jitter);
}

function d1LifecycleTransitionAllowed(
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

/**
 * D1 implementation of the S-1 transition seam. All state-changing paths use
 * conditional statements or a D1 batch; no route receives a raw SQL error or
 * a plaintext credential. This is real binding code, not a D1 mock.
 */
export class D1EnrollmentStore implements EnrollmentStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async create(
    record: EnrollmentRecord,
    replacesEnrollmentId?: string,
    idempotency?: EnrollmentIdempotencyWrite,
  ): Promise<boolean> {
    const current = await sql(
      this.#db,
      "SELECT enrollment_id FROM enrollment_records WHERE enrollment_id = ?",
      record.enrollmentId,
    ).first<{ enrollment_id: string }>();
    if (current !== null) return false;

    const insert = () =>
      sql(
        this.#db,
        `INSERT INTO enrollment_records (
           enrollment_id, sponsor_id, secret_hash, secret_expires_at,
           requested_scopes_json, requested_resources_json, invalidated, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        record.enrollmentId,
        record.sponsorId,
        record.secretHash,
        record.secretExpiresAt,
        encode(record.requestedScopes),
        encode(record.requestedResources),
        record.createdAt,
      );

    try {
      if (replacesEnrollmentId === undefined && idempotency === undefined) {
        await insert().run();
        return true;
      }
      const statements: D1PreparedStatement[] = [];
      if (replacesEnrollmentId !== undefined) {
        statements.push(
          sql(
            this.#db,
            `UPDATE enrollment_records
               SET invalidated = 1
             WHERE enrollment_id = ? AND sponsor_id = ?
               AND secret_consumed_at IS NULL AND invalidated = 0`,
            replacesEnrollmentId,
            record.sponsorId,
          ),
        );
        statements.push(
          sql(
            this.#db,
            `INSERT INTO enrollment_records (
               enrollment_id, sponsor_id, secret_hash, secret_expires_at,
               requested_scopes_json, requested_resources_json, invalidated, created_at
             ) SELECT ?, ?, ?, ?, ?, ?, 0, ? WHERE changes() = 1`,
            record.enrollmentId,
            record.sponsorId,
            record.secretHash,
            record.secretExpiresAt,
            encode(record.requestedScopes),
            encode(record.requestedResources),
            record.createdAt,
          ),
        );
      } else {
        statements.push(insert());
      }
      if (idempotency !== undefined) statements.push(this.idempotencyStatement(idempotency));
      const results = await this.#db.batch(statements);
      if (results.every((result) => result.meta.changes === 1)) return true;
      await this.raceIfPresent(idempotency);
      throw new EnrollmentError("PAIRING_INVALID");
    } catch (error) {
      if (error instanceof EnrollmentError) throw error;
      if (error instanceof EnrollmentIdempotencyRaceError) throw error;
      const raced = await sql(
        this.#db,
        "SELECT enrollment_id FROM enrollment_records WHERE enrollment_id = ?",
        record.enrollmentId,
      ).first<{ enrollment_id: string }>();
      if (raced !== null) return false;
      await this.raceIfPresent(idempotency);
      if (isSponsorEnrollmentRateFailure(error)) {
        throw await this.sponsorEnrollmentRateLimitError(record.sponsorId, record.createdAt);
      }
      throw new EnrollmentPersistenceError();
    }
  }

  async claim(attempt: ClaimAttempt, idempotency?: EnrollmentIdempotencyWrite): Promise<void> {
    try {
      const statements: D1PreparedStatement[] = [
        sql(
          this.#db,
          `UPDATE enrollment_records
             SET secret_consumed_at = ?
           WHERE enrollment_id = ? AND secret_hash = ? AND invalidated = 0
             AND typeof(secret_expires_at) = 'integer'
             AND secret_expires_at BETWEEN 1 AND 9007199254740991
             AND secret_consumed_at IS NULL AND secret_expires_at > ?`,
          attempt.now,
          attempt.enrollmentId,
          attempt.secretHash,
          attempt.now,
        ),
        sql(
          this.#db,
          `INSERT INTO enrollment_proposals (
             proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
             reasoning_effort, tools_note, created_at, expires_at, status, poll_interval_seconds
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ? WHERE changes() = 1`,
          attempt.proposal.proposalId,
          attempt.enrollmentId,
          attempt.proposal.fellowId,
          attempt.proposal.flowHandleHash,
          attempt.proposal.name,
          attempt.proposal.model,
          attempt.proposal.harness,
          attempt.proposal.reasoningEffort ?? null,
          attempt.proposal.toolsNote ?? null,
          attempt.proposal.createdAt,
          attempt.proposal.expiresAt,
          attempt.proposal.pollIntervalSeconds,
        ),
      ];
      if (idempotency !== undefined) statements.push(this.idempotencyStatement(idempotency));
      const results = await this.#db.batch(statements);
      if (results.every((result) => result.meta.changes === 1)) return;
      await this.raceIfPresent(idempotency);
    } catch (error) {
      if (error instanceof EnrollmentError || error instanceof EnrollmentIdempotencyRaceError) {
        throw error;
      }
      await this.raceIfPresent(idempotency);
      throw new EnrollmentPersistenceError();
    }

    throw new EnrollmentError("PAIRING_INVALID");
  }

  async verifyClaimCredentials(
    enrollmentId: string,
    secretHash: string,
    now: number,
  ): Promise<void> {
    let row: RecordAuthorityEvidenceRow | null;
    try {
      row = await sql(
        this.#db,
        `SELECT enrollment_id, sponsor_id, kind, secret_hash, secret_expires_at,
                requested_scopes_json, requested_resources_json, invalidated, secret_consumed_at,
                created_at AS record_created_at,
                (SELECT COUNT(*) FROM json_each(requested_resources_json))
                  AS requested_resource_key_count,
                (SELECT COUNT(DISTINCT key) FROM json_each(requested_resources_json))
                  AS requested_resource_distinct_key_count
           FROM enrollment_records WHERE enrollment_id = ?`,
        enrollmentId,
      ).first<RecordAuthorityEvidenceRow>();
    } catch {
      throw new EnrollmentPersistenceError();
    }
    if (row === null) throw new EnrollmentError("PAIRING_INVALID");
    if (!recordEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
    // Parse authority before comparing credentials. A corrupt retained record
    // is operational state, never a pairing oracle or an authorization input.
    requestedRecordWithEvidence(row);
    if (
      !secretSafeEqual(row.secret_hash, secretHash) ||
      row.invalidated === 1 ||
      now >= row.secret_expires_at ||
      row.secret_consumed_at !== null
    ) {
      throw new EnrollmentError("PAIRING_INVALID");
    }
  }

  async decision(
    attempt: DecisionAttempt,
    idempotency?: EnrollmentIdempotencyWrite,
  ): Promise<void> {
    let row = await this.proposalByEnrollment(attempt.enrollmentId, attempt.sponsorId);
    let bindsDeviceSponsor = false;
    if (row === null) {
      // An unbound device enrollment belongs to nobody until a decision; the
      // first decider binds it inside the same batch.
      const deviceRow = await this.unboundDeviceProposalByEnrollment(attempt.enrollmentId);
      row = deviceRow;
      bindsDeviceSponsor = deviceRow !== null;
      if (
        deviceRow !== null &&
        (deviceRow.device_mapping_expires_at === null ||
          attempt.now >= deviceRow.device_mapping_expires_at)
      ) {
        throw new EnrollmentError("PAIRING_INVALID");
      }
    }
    if (row === null) throw new EnrollmentError("WRONG_PRINCIPAL");
    if (row.status === "expired") throw new EnrollmentError("PROPOSAL_EXPIRED");
    if (row.status !== "pending") throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    const expirePendingProposal = async (): Promise<never> => {
      let result: D1Result<unknown>;
      try {
        result = await sql(
          this.#db,
          "UPDATE enrollment_proposals SET status = 'expired' WHERE proposal_id = ? AND status = 'pending'",
          row.proposal_id,
        ).run();
      } catch {
        await this.raceIfPresent(idempotency);
        throw new EnrollmentPersistenceError();
      }
      if (result.meta.changes !== 1) {
        await this.raceIfPresent(idempotency);
        throw new EnrollmentError("PROPOSAL_NOT_PENDING");
      }
      throw new EnrollmentError("PROPOSAL_EXPIRED");
    };
    if (attempt.now >= row.expires_at) {
      return expirePendingProposal();
    }
    // A signed decision is a legitimate first Worker contact for `/approve`.
    // Keep this update-then-conditional-insert pair in the same D1 batch as
    // the binding, status change, Fellow/grant, and replay. It deliberately
    // avoids INSERT OR IGNORE so the schema's duplicate-insert guard can make
    // raw INSERT OR REPLACE unable to delete an accountable sponsor row.
    const sponsorBootstrapStatements: D1PreparedStatement[] = [
      sql(
        this.#db,
        "UPDATE sponsors SET last_seen_at = ? WHERE sponsor_id = ?",
        attempt.now,
        attempt.sponsorId,
      ),
      sql(
        this.#db,
        `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
         SELECT ?, ?, ? WHERE changes() = 0`,
        attempt.sponsorId,
        attempt.now,
        attempt.now,
      ),
    ];
    const bindingStatements: D1PreparedStatement[] = bindsDeviceSponsor
      ? [
          sql(
            this.#db,
            `UPDATE enrollment_records SET sponsor_id = ?
             WHERE enrollment_id = ? AND sponsor_id = '' AND kind = 'device'
               AND EXISTS (
                 SELECT 1 FROM enrollment_proposals p
                 JOIN device_codes d ON d.enrollment_id = p.enrollment_id
                  WHERE p.enrollment_id = enrollment_records.enrollment_id
                    AND p.proposal_id = ? AND p.status = 'pending' AND p.expires_at > ?
                    AND d.expires_at > ?
               )`,
            attempt.sponsorId,
            attempt.enrollmentId,
            row.proposal_id,
            attempt.now,
            attempt.now,
          ),
        ]
      : [];

    if (attempt.decision.decision === "deny") {
      try {
        const proposalDecision = bindsDeviceSponsor
          ? sql(
              this.#db,
              `UPDATE enrollment_proposals SET status = 'denied'
               WHERE proposal_id = ? AND status = 'pending' AND expires_at > ?
                 AND changes() = 1
                 AND EXISTS (
                   SELECT 1 FROM enrollment_records e
                    WHERE e.enrollment_id = enrollment_proposals.enrollment_id
                      AND e.kind = 'device' AND e.sponsor_id = ?
                 )`,
              row.proposal_id,
              attempt.now,
              attempt.sponsorId,
            )
          : sql(
              this.#db,
              `UPDATE enrollment_proposals SET status = 'denied'
               WHERE proposal_id = ? AND status = 'pending' AND expires_at > ?`,
              row.proposal_id,
              attempt.now,
            );
        const statements = [
          ...sponsorBootstrapStatements,
          ...bindingStatements,
          proposalDecision,
          ...(idempotency === undefined ? [] : [this.idempotencyStatement(idempotency)]),
        ];
        const results = await this.#db.batch(statements);
        // A pre-existing sponsor makes the conditional INSERT a zero-change
        // no-op; every later decision/replay effect must still change exactly
        // one row.
        if (
          results
            .slice(sponsorBootstrapStatements.length)
            .every((result) => result.meta.changes === 1)
        ) {
          return;
        }
        await this.raceIfPresent(idempotency);
      } catch (error) {
        if (error instanceof EnrollmentError || error instanceof EnrollmentIdempotencyRaceError) {
          throw error;
        }
        await this.raceIfPresent(idempotency);
        if (isSponsorBootstrapRequiredFailure(error)) {
          throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
        }
        throw new EnrollmentPersistenceError();
      }
      throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    }

    if (!proposalEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
    const requested = requestedRecordWithEvidence(row);
    const { scopes, resources } = this.reducedGrant(requested, attempt.decision, attempt.now);
    if (
      resources.fellowGrantExpiresAt !== undefined &&
      attempt.now >= resources.fellowGrantExpiresAt
    ) {
      return expirePendingProposal();
    }
    const nextStatus = attempt.decision.decision === "approve" ? "approved" : "reduced";
    try {
      const proposalDecision = bindsDeviceSponsor
        ? sql(
            this.#db,
            `UPDATE enrollment_proposals
               SET status = ?, granted_scopes_json = ?, granted_resources_json = ?
             WHERE proposal_id = ? AND status = 'pending' AND expires_at > ?
               AND changes() = 1
               AND EXISTS (
                 SELECT 1 FROM enrollment_records e
                  WHERE e.enrollment_id = enrollment_proposals.enrollment_id
                    AND e.kind = 'device' AND e.sponsor_id = ?
               )`,
            nextStatus,
            encode(scopes),
            encode(resources),
            row.proposal_id,
            attempt.now,
            attempt.sponsorId,
          )
        : sql(
            this.#db,
            `UPDATE enrollment_proposals
               SET status = ?, granted_scopes_json = ?, granted_resources_json = ?
             WHERE proposal_id = ? AND status = 'pending' AND expires_at > ?`,
            nextStatus,
            encode(scopes),
            encode(resources),
            row.proposal_id,
            attempt.now,
          );
      const statements: D1PreparedStatement[] = [
        ...sponsorBootstrapStatements,
        ...bindingStatements,
        proposalDecision,
        sql(
          this.#db,
          `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
          row.fellow_id,
          attempt.sponsorId,
          row.name,
          row.model,
          row.harness,
          attempt.now,
        ),
        sql(
          this.#db,
          `INSERT INTO enrollment_grants (
             proposal_id, fellow_id, sponsor_id, granted_scopes_json, granted_resources_json, granted_at
           ) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
          row.proposal_id,
          row.fellow_id,
          attempt.sponsorId,
          encode(scopes),
          encode(resources),
          attempt.now,
        ),
      ];
      if (idempotency !== undefined) statements.push(this.idempotencyStatement(idempotency));
      const results = await this.#db.batch(statements);
      // The device-grant statement's AFTER trigger also writes the immutable
      // rate projection, so D1/Bun may report two affected rows for that one
      // statement. Every product statement must still change at least once.
      if (
        results.slice(sponsorBootstrapStatements.length).every((result) => result.meta.changes >= 1)
      ) {
        return;
      }
      await this.raceIfPresent(idempotency);
      throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    } catch (error) {
      if (error instanceof EnrollmentError) throw error;
      if (error instanceof EnrollmentIdempotencyRaceError) throw error;
      // A concurrent winner under this key is authoritative even when this
      // batch happened to lose on a product constraint first. In particular,
      // one remaining Fellow slot can make the losing batch observe the cap;
      // a different request body under the winner's key is still an
      // idempotency conflict, not a capacity refusal.
      await this.raceIfPresent(idempotency);
      if (isSponsorBootstrapRequiredFailure(error)) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      if (isUniqueNameFailure(error)) throw new EnrollmentError("NAME_TAKEN");
      if (isSponsorEnrollmentRateFailure(error)) {
        throw await this.sponsorEnrollmentRateLimitError(attempt.sponsorId, attempt.now);
      }
      if (isActiveFellowCapFailure(error)) throw new EnrollmentError("FELLOW_CAP_REACHED");
      throw new EnrollmentPersistenceError();
    }
  }

  async approvalCard(
    enrollmentId: string,
    sponsorId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard> {
    const row = await this.proposalByEnrollment(enrollmentId, sponsorId);
    if (row === null) throw new EnrollmentError("WRONG_PRINCIPAL");
    if (!proposalEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
    const requested = requestedRecordWithEvidence(row);
    const grantExpiresAt = requested.requestedResources.fellowGrantExpiresAt;
    if (
      row.status === "pending" &&
      (now >= row.expires_at || (grantExpiresAt !== undefined && now >= grantExpiresAt))
    ) {
      await sql(
        this.#db,
        "UPDATE enrollment_proposals SET status = 'expired' WHERE proposal_id = ? AND status = 'pending'",
        row.proposal_id,
      ).run();
      row.status = "expired";
    }
    const granted =
      row.status === "approved" || row.status === "reduced"
        ? {
            scopes:
              row.durable_granted_scopes_json === null
                ? null
                : parseScopes(row.durable_granted_scopes_json),
            resources:
              row.durable_granted_resources_json === null
                ? null
                : parseResources(row.durable_granted_resources_json),
          }
        : { scopes: null, resources: null };
    if (
      (row.status === "approved" || row.status === "reduced") &&
      (granted.scopes === null || granted.resources === null)
    ) {
      throw new EnrollmentPersistenceError();
    }
    return {
      enrollmentId: row.enrollment_id,
      proposalId: row.proposal_id,
      status: proposalStatus(row.status),
      name: row.name,
      model: row.model,
      harness: row.harness,
      ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
      ...(row.tools_note === null ? {} : { toolsNote: row.tools_note }),
      requestedScopes: requested.requestedScopes,
      requestedResources: requested.requestedResources,
      effectiveGrantedScopes: granted.scopes,
      effectiveGrantedResources: granted.resources,
      proposalExpiresAt: row.expires_at,
    };
  }

  async pendingApprovalCardsBySponsor(
    sponsorId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard[]> {
    // Lazy-expiry sweep first, including a grant lifetime that elapsed before
    // approval. A sponsor must never be sent back to an impossible card.
    await sql(
      this.#db,
      `UPDATE enrollment_proposals SET status = 'expired'
        WHERE proposal_id IN (
          SELECT proposal.proposal_id
            FROM enrollment_proposals proposal
            JOIN enrollment_records enrollment
              ON enrollment.enrollment_id = proposal.enrollment_id
           WHERE enrollment.sponsor_id = ?
             AND proposal.status = 'pending'
             AND (
               proposal.expires_at <= ?
               OR (
                 json_type(
                   enrollment.requested_resources_json,
                   '$.fellowGrantExpiresAt'
                 ) = 'integer'
                 AND json_extract(
                   enrollment.requested_resources_json,
                   '$.fellowGrantExpiresAt'
                 ) <= ?
               )
             )
        )`,
      sponsorId,
      now,
      now,
    ).run();
    const rows = await sql(
      this.#db,
      `SELECT e.enrollment_id, e.sponsor_id, e.kind, e.secret_hash, e.secret_expires_at,
              e.requested_scopes_json, e.requested_resources_json, e.invalidated,
              e.secret_consumed_at, e.created_at AS record_created_at,
              (SELECT COUNT(*) FROM json_each(e.requested_resources_json))
                AS requested_resource_key_count,
              (SELECT COUNT(DISTINCT key) FROM json_each(e.requested_resources_json))
                AS requested_resource_distinct_key_count,
              p.proposal_id, p.name, p.model, p.harness, p.reasoning_effort, p.tools_note,
              p.created_at, p.expires_at, p.status
         FROM enrollment_records e
         JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
        WHERE e.sponsor_id = ? AND p.status = 'pending'
        ORDER BY p.created_at ASC
        LIMIT 100`,
      sponsorId,
    ).all<PendingProposalRow>();
    return rows.results.map((row) => {
      if (!proposalEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
      const requested = requestedRecordWithEvidence(row);
      return {
        enrollmentId: row.enrollment_id,
        proposalId: row.proposal_id,
        status: "pending" as const,
        name: row.name,
        model: row.model,
        harness: row.harness,
        ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
        ...(row.tools_note === null ? {} : { toolsNote: row.tools_note }),
        requestedScopes: requested.requestedScopes,
        requestedResources: requested.requestedResources,
        effectiveGrantedScopes: null,
        effectiveGrantedResources: null,
        proposalExpiresAt: row.expires_at,
      };
    });
  }

  async fellowsBySponsor(
    sponsorId: string,
    now: number,
    after?: SponsorFellowCursorKey,
  ): Promise<SponsorFellowPage> {
    let rows: readonly FellowGrantRow[];
    try {
      const keyDiscovery =
        after === undefined
          ? `sponsor_fellow_keys AS MATERIALIZED (
               SELECT grant_key.proposal_id, grant_key.fellow_id, grant_key.sponsor_id,
                      grant_key.granted_scopes_json, grant_key.granted_resources_json,
                      grant_key.granted_at
                 FROM enrollment_grants AS grant_key
                      INDEXED BY enrollment_grants_sponsor_page_idx
                WHERE grant_key.sponsor_id = ?
                ORDER BY grant_key.granted_at DESC, grant_key.fellow_id ASC
                LIMIT ${SPONSOR_FELLOW_PAGE_SIZE + 1}
             )`
          : `same_timestamp_keys AS MATERIALIZED (
               SELECT grant_key.proposal_id, grant_key.fellow_id, grant_key.sponsor_id,
                      grant_key.granted_scopes_json, grant_key.granted_resources_json,
                      grant_key.granted_at
                 FROM enrollment_grants AS grant_key
                      INDEXED BY enrollment_grants_sponsor_page_idx
                WHERE grant_key.sponsor_id = ?
                  AND grant_key.granted_at = ?
                  AND grant_key.fellow_id > ?
                ORDER BY grant_key.granted_at DESC, grant_key.fellow_id ASC
                LIMIT ${SPONSOR_FELLOW_PAGE_SIZE + 1}
             ), older_timestamp_keys AS MATERIALIZED (
               SELECT grant_key.proposal_id, grant_key.fellow_id, grant_key.sponsor_id,
                      grant_key.granted_scopes_json, grant_key.granted_resources_json,
                      grant_key.granted_at
                 FROM enrollment_grants AS grant_key
                      INDEXED BY enrollment_grants_sponsor_page_idx
                WHERE grant_key.sponsor_id = ?
                  AND grant_key.granted_at < ?
                ORDER BY grant_key.granted_at DESC, grant_key.fellow_id ASC
                LIMIT ${SPONSOR_FELLOW_PAGE_SIZE + 1}
             ), sponsor_fellow_keys AS MATERIALIZED (
               SELECT proposal_id, fellow_id, sponsor_id, granted_scopes_json,
                      granted_resources_json, granted_at
                 FROM same_timestamp_keys
               UNION ALL
               SELECT proposal_id, fellow_id, sponsor_id, granted_scopes_json,
                      granted_resources_json, granted_at
                 FROM older_timestamp_keys
                ORDER BY granted_at DESC, fellow_id ASC
                LIMIT ${SPONSOR_FELLOW_PAGE_SIZE + 1}
             )`;
      const bindings =
        after === undefined
          ? [sponsorId, now, now, now]
          : [
              sponsorId,
              after.granted_at,
              after.fellow_id,
              sponsorId,
              after.granted_at,
              now,
              now,
              now,
            ];
      const result = await sql(
        this.#db,
        `WITH ${keyDiscovery}, sponsor_fellow_page AS MATERIALIZED (
			       SELECT fellow.fellow_id, fellow.name, fellow.model, fellow.harness, fellow.status,
			              grant_row.sponsor_id, grant_row.proposal_id AS grant_proposal_id,
			              grant_row.granted_scopes_json, grant_row.granted_resources_json,
			              grant_row.granted_at,
			              CASE WHEN fellow.fellow_id IS NOT NULL
			                     AND grant_proposal.proposal_id IS NOT NULL
			                     AND grant_enrollment.enrollment_id IS NOT NULL
			                     AND fellow.name COLLATE BINARY = grant_proposal.name COLLATE BINARY
			                     AND fellow.model = grant_proposal.model
			                     AND fellow.harness = grant_proposal.harness
			                     AND grant_proposal.granted_scopes_json = grant_row.granted_scopes_json
			                     AND grant_proposal.granted_resources_json = grant_row.granted_resources_json
			                     AND (
			                       grant_proposal.status IN ('approved', 'reduced')
			                       OR (
			                         grant_proposal.status = 'expired'
			                         AND grant_proposal.token_hash IS NULL
			                         AND grant_proposal.token_issued_at IS NULL
			                         AND json_type(
			                           grant_row.granted_resources_json,
			                           '$.fellowGrantExpiresAt'
			                         ) = 'integer'
			                       )
			                     )
			                   THEN 1 ELSE 0 END AS authority_valid
			         FROM sponsor_fellow_keys grant_row
			         LEFT JOIN enrollment_fellows fellow
			           ON fellow.fellow_id = grant_row.fellow_id
			          AND fellow.sponsor_id = grant_row.sponsor_id
			         LEFT JOIN enrollment_proposals grant_proposal
			           ON grant_proposal.proposal_id = grant_row.proposal_id
			          AND grant_proposal.fellow_id = grant_row.fellow_id
			         LEFT JOIN enrollment_records grant_enrollment
			           ON grant_enrollment.enrollment_id = grant_proposal.enrollment_id
			          AND grant_enrollment.sponsor_id = grant_row.sponsor_id
			        ORDER BY grant_row.granted_at DESC, grant_row.fellow_id ASC
			        LIMIT ${SPONSOR_FELLOW_PAGE_SIZE + 1}
			     ), sponsor_fellows AS MATERIALIZED (
			       SELECT sponsor_fellow_page.*,
			              ROW_NUMBER() OVER (
			                ORDER BY granted_at DESC, fellow_id ASC
			              ) AS page_position
			         FROM sponsor_fellow_page
			     )
			   SELECT f.fellow_id, f.name, f.model, f.harness, f.status,
			          f.granted_scopes_json, f.granted_resources_json, f.granted_at,
			          c.credential_id, c.credential_profile, c.issued_at, c.expires_at,
			          c.last_used_at, f.page_position, f.authority_valid
			     FROM sponsor_fellows f
			     LEFT JOIN enrollment_sponsor_security security ON security.sponsor_id = f.sponsor_id
			     LEFT JOIN fellow_tokens c INDEXED BY enrollment_credentials_sponsor_fellow_lifecycle_idx
			       ON c.fellow_id = f.fellow_id
			      AND c.sponsor_id = f.sponsor_id
			      AND f.page_position <= ${SPONSOR_FELLOW_PAGE_SIZE}
			      AND c.revoked_at IS NULL
			      AND c.expires_at > ?
			      AND c.issued_at <= ?
			      AND (
			        json_type(c.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
			        OR (
			          json_type(c.granted_resources_json, '$.fellowGrantExpiresAt') = 'integer'
			          AND json_extract(c.granted_resources_json, '$.fellowGrantExpiresAt') > ?
			        )
			      )
			      AND c.issued_at > COALESCE(security.panic_at, -1)
			      AND f.granted_at > COALESCE(security.panic_at, -1)
			      AND c.granted_scopes_json = f.granted_scopes_json
			      AND c.granted_resources_json = f.granted_resources_json
			      AND EXISTS (
			        SELECT 1
			          FROM enrollment_proposals grant_proposal
			          JOIN enrollment_records grant_enrollment
			            ON grant_enrollment.enrollment_id = grant_proposal.enrollment_id
			         WHERE grant_proposal.proposal_id = f.grant_proposal_id
			           AND grant_proposal.fellow_id = f.fellow_id
			           AND grant_enrollment.sponsor_id = f.sponsor_id
			           AND f.name COLLATE BINARY = grant_proposal.name COLLATE BINARY
			           AND f.model = grant_proposal.model
			           AND f.harness = grant_proposal.harness
			           AND grant_proposal.status IN ('approved', 'reduced')
			           AND grant_proposal.granted_scopes_json = f.granted_scopes_json
			           AND grant_proposal.granted_resources_json = f.granted_resources_json
			           AND (
			             (c.proposal_id IS NULL AND c.credential_origin = 'harness-migration')
			             OR (
			               c.proposal_id = grant_proposal.proposal_id
			               AND c.credential_origin = 'enrollment'
			               AND grant_proposal.token_hash = c.token_hash
			               AND grant_proposal.token_issued_at = c.issued_at
			             )
			           )
			      )
			    ORDER BY f.granted_at DESC, f.fellow_id ASC, c.issued_at DESC, c.credential_id ASC
			    LIMIT 1501`,
        ...bindings,
      ).all<FellowGrantRow>();
      if (result.results.length > 1501) {
        throw new EnrollmentPersistenceError();
      }
      rows = result.results;
    } catch (error) {
      if (error instanceof EnrollmentPersistenceError) throw error;
      throw new EnrollmentPersistenceError();
    }

    const fellows = new Map<string, SponsorFellowRecord>();
    let hasNextPage = false;
    let pageTail: SponsorFellowRecord | undefined;
    for (const row of rows) {
      // Key discovery deliberately happens before authority joins so each D1
      // branch stays bounded on 0011's sponsor page index. A left join makes a
      // retained/corrupt key an operational failure instead of silently
      // filtering it out and falsely terminating or truncating history.
      if (row.authority_valid !== 1) throw new EnrollmentPersistenceError();
      if (
        !Number.isInteger(row.page_position) ||
        row.page_position < 1 ||
        row.page_position > SPONSOR_FELLOW_PAGE_SIZE + 1
      ) {
        throw new EnrollmentPersistenceError();
      }
      if (row.page_position > SPONSOR_FELLOW_PAGE_SIZE) {
        hasNextPage = true;
        continue;
      }
      let fellow = fellows.get(row.fellow_id);
      if (fellow === undefined) {
        let grantedScopes: readonly RequestedScope[];
        let grantedResources: EnrollmentResourceGrants;
        try {
          grantedScopes = parseScopes(row.granted_scopes_json);
          grantedResources = parseResources(row.granted_resources_json);
        } catch {
          throw new EnrollmentPersistenceError();
        }
        fellow = {
          fellowId: row.fellow_id,
          name: row.name,
          model: row.model,
          harness: row.harness,
          status: row.status,
          grantedScopes,
          grantedResources,
          grantedAt: row.granted_at,
          credentials: [],
        };
        fellows.set(row.fellow_id, fellow);
        pageTail = fellow;
      }
      if (
        row.credential_id === null ||
        row.credential_profile === null ||
        row.issued_at === null ||
        row.expires_at === null
      ) {
        continue;
      }
      (fellow.credentials as SponsorFellowRecord["credentials"][number][]).push({
        credentialId: row.credential_id,
        profile: row.credential_profile,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
        active: row.status === "active" || row.status === "suspicious_review",
      });
    }
    const page = [...fellows.values()];
    if (hasNextPage && pageTail === undefined) throw new EnrollmentPersistenceError();
    return {
      fellows: page,
      ...(hasNextPage && pageTail !== undefined
        ? { nextCursor: { granted_at: pageTail.grantedAt, fellow_id: pageTail.fellowId } }
        : {}),
    };
  }

  async deviceCreate(
    input: DeviceCreateInput,
    idempotency?: EnrollmentIdempotencyWrite,
  ): Promise<void> {
    const identifierCollisionPredicate = `
      EXISTS (SELECT 1 FROM enrollment_records WHERE enrollment_id = ?)
      OR EXISTS (
        SELECT 1 FROM enrollment_proposals
         WHERE proposal_id = ? OR enrollment_id = ? OR fellow_id = ? OR flow_handle_hash = ?
      )
      OR EXISTS (
        SELECT 1 FROM device_codes WHERE enrollment_id = ? OR user_code_hash = ?
      )`;
    const identifierBindings = [
      input.record.enrollmentId,
      input.proposal.proposalId,
      input.record.enrollmentId,
      input.proposal.fellowId,
      input.proposal.flowHandleHash,
      input.record.enrollmentId,
      input.userCodeHash,
    ] as const;
    try {
      const statements = [
        sql(
          this.#db,
          `UPDATE enrollment_records
              SET device_mapping_reclaimed_at = ?
            WHERE enrollment_id IN (
              SELECT d.enrollment_id
                FROM device_codes d
                JOIN enrollment_records e ON e.enrollment_id = d.enrollment_id
               WHERE d.expires_at <= ? AND e.device_mapping_reclaimed_at IS NULL
               ORDER BY d.expires_at, d.enrollment_id
               LIMIT ?
            )`,
          input.record.createdAt,
          input.record.createdAt,
          input.reclaimBatchSize,
        ),
        sql(
          this.#db,
          `DELETE FROM device_codes
            WHERE enrollment_id IN (
              SELECT d.enrollment_id
                FROM device_codes d
                JOIN enrollment_records e ON e.enrollment_id = d.enrollment_id
               WHERE d.expires_at <= ? AND e.device_mapping_reclaimed_at IS NOT NULL
               ORDER BY d.expires_at, d.enrollment_id
               LIMIT ?
            )`,
          input.record.createdAt,
          input.reclaimBatchSize,
        ),
        sql(
          this.#db,
          `DELETE FROM device_start_attempts
            WHERE id IN (
              SELECT id FROM device_start_attempts
               WHERE attempted_at < ?
               ORDER BY attempted_at, id
               LIMIT ?
            )`,
          input.startWindowBeginning,
          input.reclaimBatchSize,
        ),
        sql(
          this.#db,
          `SELECT CASE WHEN ${identifierCollisionPredicate} THEN 1 ELSE 0 END AS collided`,
          ...identifierBindings,
        ),
        sql(
          this.#db,
          `INSERT INTO device_start_attempts (client_bucket, attempted_at)
           SELECT ?, ?
            WHERE NOT (${identifierCollisionPredicate})
              AND (
              SELECT COUNT(*) FROM device_start_attempts
               WHERE client_bucket = ?
                 AND attempted_at >= ?
                 AND attempted_at <= ?
            ) < ?`,
          input.clientBucket,
          input.record.createdAt,
          ...identifierBindings,
          input.clientBucket,
          input.startWindowBeginning,
          input.record.createdAt,
          input.startLimit,
        ),
        sql(
          this.#db,
          `INSERT INTO enrollment_records (
             enrollment_id, sponsor_id, secret_hash, secret_expires_at,
             requested_scopes_json, requested_resources_json, invalidated, created_at,
             kind, device_expires_at
           ) SELECT ?, '', ?, ?, ?, ?, 0, ?, 'device', ? WHERE changes() = 1`,
          input.record.enrollmentId,
          input.record.secretHash,
          input.record.secretExpiresAt,
          encode(input.record.requestedScopes),
          encode(input.record.requestedResources),
          input.record.createdAt,
          input.deviceExpiresAt,
        ),
        sql(
          this.#db,
          `INSERT INTO enrollment_proposals (
             proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
             reasoning_effort, tools_note, created_at, expires_at, status, poll_interval_seconds
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ? WHERE changes() = 1`,
          input.proposal.proposalId,
          input.record.enrollmentId,
          input.proposal.fellowId,
          input.proposal.flowHandleHash,
          input.proposal.name,
          input.proposal.model,
          input.proposal.harness,
          input.proposal.reasoningEffort ?? null,
          input.proposal.toolsNote ?? null,
          input.proposal.createdAt,
          input.proposal.expiresAt,
          input.proposal.pollIntervalSeconds,
        ),
        sql(
          this.#db,
          `INSERT INTO device_codes (enrollment_id, user_code_hash, created_at, expires_at)
           SELECT ?, ?, ?, ? WHERE changes() = 1`,
          input.record.enrollmentId,
          input.userCodeHash,
          input.record.createdAt,
          input.deviceExpiresAt,
        ),
        ...(idempotency === undefined ? [] : [this.idempotencyStatement(idempotency)]),
      ];
      const results = await this.#db.batch(statements);
      const collisionRow = (results[3]?.results?.[0] ?? undefined) as
        | { readonly collided?: number }
        | undefined;
      if (collisionRow?.collided !== 0 && collisionRow?.collided !== 1) {
        throw new EnrollmentPersistenceError();
      }
      if (collisionRow.collided === 1) {
        await this.raceIfPresent(idempotency);
        throw new EnrollmentIdentifierCollisionError();
      }
      const rateReservation = results[4];
      if ((rateReservation?.meta.changes ?? 0) === 0) {
        // A same-key winner may have filled the final source slot after this
        // request's replay preflight. Exact replay/conflict takes precedence
        // over the coarse rate refusal whenever that winner committed.
        await this.raceIfPresent(idempotency);
        throw new EnrollmentError("DEVICE_START_RATE_LIMITED");
      }
      const productResults = results.slice(5);
      if (productResults.every((result) => result.meta.changes === 1)) return;
      throw new EnrollmentPersistenceError();
    } catch (error) {
      if (error instanceof EnrollmentError) throw error;
      if (error instanceof EnrollmentIdentifierCollisionError) throw error;
      if (error instanceof EnrollmentIdempotencyRaceError) throw error;
      await this.raceIfPresent(idempotency);
      if (error instanceof EnrollmentPersistenceError) throw error;
      throw new EnrollmentPersistenceError();
    }
  }

  async deviceLookup(attempt: DeviceLookupAttempt): Promise<EnrollmentApprovalCard> {
    const liveCodePredicate = `
      FROM device_codes d
      JOIN enrollment_records e ON e.enrollment_id = d.enrollment_id
      JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
     WHERE d.user_code_hash = ?
       AND d.expires_at > ?
       AND e.kind = 'device'
       AND e.sponsor_id = ''
       AND p.status = 'pending'
       AND p.expires_at > ?
       AND (
         json_type(e.requested_resources_json, '$.fellowGrantExpiresAt') IS NULL
         OR json_type(e.requested_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
         OR json_extract(e.requested_resources_json, '$.fellowGrantExpiresAt') <= 0
         OR json_extract(e.requested_resources_json, '$.fellowGrantExpiresAt') > ?
       )`;
    let results: D1Result<unknown>[];
    try {
      results = await this.#db.batch([
        sql(
          this.#db,
          `DELETE FROM device_lookup_attempts
            WHERE id IN (
              SELECT id FROM device_lookup_attempts
               WHERE attempted_at < ?
               ORDER BY attempted_at, id
               LIMIT ?
            )`,
          attempt.windowBeginning,
          attempt.reclaimBatchSize,
        ),
        sql(
          this.#db,
          `UPDATE enrollment_records
              SET device_mapping_reclaimed_at = ?
            WHERE enrollment_id IN (
              SELECT d.enrollment_id
                FROM device_codes d
                JOIN enrollment_records e ON e.enrollment_id = d.enrollment_id
               WHERE d.expires_at <= ? AND e.device_mapping_reclaimed_at IS NULL
               ORDER BY d.expires_at, d.enrollment_id
               LIMIT ?
            )`,
          attempt.now,
          attempt.now,
          attempt.reclaimBatchSize,
        ),
        sql(
          this.#db,
          `DELETE FROM device_codes
            WHERE enrollment_id IN (
              SELECT d.enrollment_id
                FROM device_codes d
                JOIN enrollment_records e ON e.enrollment_id = d.enrollment_id
               WHERE d.expires_at <= ? AND e.device_mapping_reclaimed_at IS NOT NULL
               ORDER BY d.expires_at, d.enrollment_id
               LIMIT ?
            )`,
          attempt.now,
          attempt.reclaimBatchSize,
        ),
        sql(
          this.#db,
          `UPDATE enrollment_proposals
              SET status = 'expired'
            WHERE status = 'pending'
              AND enrollment_id IN (
                SELECT d.enrollment_id
                  FROM device_codes d
                  JOIN enrollment_records e ON e.enrollment_id = d.enrollment_id
                 WHERE d.user_code_hash = ?
                   AND d.expires_at > ?
                   AND e.kind = 'device'
                   AND e.sponsor_id = ''
                   AND json_type(
                     e.requested_resources_json,
                     '$.fellowGrantExpiresAt'
                   ) = 'integer'
                   AND json_extract(
                     e.requested_resources_json,
                     '$.fellowGrantExpiresAt'
                   ) > 0
                   AND json_extract(
                     e.requested_resources_json,
                     '$.fellowGrantExpiresAt'
                   ) <= ?
              )`,
          attempt.userCodeHash,
          attempt.now,
          attempt.now,
        ),
        sql(
          this.#db,
          `SELECT COUNT(*) AS failures FROM device_lookup_attempts
            WHERE sponsor_id = ? AND success = 0
              AND attempted_at >= ? AND attempted_at <= ?`,
          attempt.sponsorId,
          attempt.windowBeginning,
          attempt.now,
        ),
        sql(
          this.#db,
          `SELECT e.enrollment_id, e.sponsor_id, e.kind, e.secret_hash, e.secret_expires_at,
                  e.requested_scopes_json, e.requested_resources_json, e.invalidated,
                  e.secret_consumed_at, e.created_at AS record_created_at,
                  (SELECT COUNT(*) FROM json_each(e.requested_resources_json))
                    AS requested_resource_key_count,
                  (SELECT COUNT(DISTINCT key) FROM json_each(e.requested_resources_json))
                    AS requested_resource_distinct_key_count,
                  p.proposal_id, p.name, p.model, p.harness, p.reasoning_effort, p.tools_note,
                  p.created_at, p.expires_at, p.status
             ${liveCodePredicate}
              AND (
                SELECT COUNT(*) FROM device_lookup_attempts
                 WHERE sponsor_id = ? AND success = 0
                   AND attempted_at >= ? AND attempted_at <= ?
              ) < ?`,
          attempt.userCodeHash,
          attempt.now,
          attempt.now,
          attempt.now,
          attempt.sponsorId,
          attempt.windowBeginning,
          attempt.now,
          attempt.failureLimit,
        ),
        sql(
          this.#db,
          `INSERT INTO device_lookup_attempts (sponsor_id, attempted_at, success)
           SELECT ?, ?, 0
            WHERE NOT EXISTS (SELECT 1 ${liveCodePredicate})
              AND (
              SELECT COUNT(*) FROM device_lookup_attempts
               WHERE sponsor_id = ? AND success = 0
                 AND attempted_at >= ? AND attempted_at <= ?
            ) < ?`,
          attempt.sponsorId,
          attempt.now,
          attempt.userCodeHash,
          attempt.now,
          attempt.now,
          attempt.now,
          attempt.sponsorId,
          attempt.windowBeginning,
          attempt.now,
          attempt.failureLimit,
        ),
      ]);
    } catch {
      throw new EnrollmentPersistenceError();
    }
    const countRow = (results[4]?.results?.[0] ?? undefined) as
      | { readonly failures?: number }
      | undefined;
    if (countRow === undefined || !Number.isSafeInteger(countRow.failures)) {
      throw new EnrollmentPersistenceError();
    }
    if ((countRow.failures ?? 0) >= attempt.failureLimit) {
      throw new EnrollmentError("DEVICE_LOOKUP_LOCKED");
    }
    const row = (results[5]?.results?.[0] ?? undefined) as PendingProposalRow | undefined;
    const outcome = results[6];
    const outcomeChanges = outcome?.meta.changes ?? -1;
    if (row === undefined) {
      if (outcomeChanges !== 1) throw new EnrollmentPersistenceError();
      throw new EnrollmentError("DEVICE_CODE_UNKNOWN");
    }
    if (outcomeChanges !== 0) throw new EnrollmentPersistenceError();
    if (!proposalEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
    const requested = requestedRecordWithEvidence(row);
    return {
      enrollmentId: row.enrollment_id,
      proposalId: row.proposal_id,
      status: "pending" as const,
      name: row.name,
      model: row.model,
      harness: row.harness,
      ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
      ...(row.tools_note === null ? {} : { toolsNote: row.tools_note }),
      requestedScopes: requested.requestedScopes,
      requestedResources: requested.requestedResources,
      effectiveGrantedScopes: null,
      effectiveGrantedResources: null,
      proposalExpiresAt: row.expires_at,
    };
  }

  async deviceApprovalCardForDecision(
    enrollmentId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard> {
    const card = await this.deviceCardByEnrollmentForDecision(enrollmentId, now);
    if (card === undefined) throw new EnrollmentError("PAIRING_INVALID");
    return card;
  }

  private async deviceCardByEnrollmentForDecision(
    enrollmentId: string,
    now: number,
  ): Promise<EnrollmentApprovalCard | undefined> {
    const row = await sql(
      this.#db,
      `SELECT e.enrollment_id, e.sponsor_id, e.kind, e.secret_hash, e.secret_expires_at,
              e.requested_scopes_json, e.requested_resources_json, e.invalidated,
              e.secret_consumed_at, e.created_at AS record_created_at,
              (SELECT COUNT(*) FROM json_each(e.requested_resources_json))
                AS requested_resource_key_count,
              (SELECT COUNT(DISTINCT key) FROM json_each(e.requested_resources_json))
                AS requested_resource_distinct_key_count,
              p.proposal_id, p.name, p.model, p.harness, p.reasoning_effort, p.tools_note,
              p.created_at, p.expires_at, p.status
         FROM enrollment_records e
         JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
         JOIN device_codes d ON d.enrollment_id = e.enrollment_id
        WHERE e.enrollment_id = ? AND e.kind = 'device' AND e.sponsor_id = ''
          AND d.expires_at > ?`,
      enrollmentId,
      now,
    ).first<PendingProposalRow>();
    if (row === null) return undefined;
    if (!proposalEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
    const requested = requestedRecordWithEvidence(row);
    const requestedResources = requested.requestedResources;
    if (
      row.status === "pending" &&
      (now >= row.expires_at ||
        (requestedResources.fellowGrantExpiresAt !== undefined &&
          now >= requestedResources.fellowGrantExpiresAt))
    ) {
      await sql(
        this.#db,
        "UPDATE enrollment_proposals SET status = 'expired' WHERE proposal_id = ? AND status = 'pending'",
        row.proposal_id,
      ).run();
      row.status = "expired";
    }
    return {
      enrollmentId: row.enrollment_id,
      proposalId: row.proposal_id,
      status: row.status,
      name: row.name,
      model: row.model,
      harness: row.harness,
      ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
      ...(row.tools_note === null ? {} : { toolsNote: row.tools_note }),
      requestedScopes: requested.requestedScopes,
      requestedResources,
      effectiveGrantedScopes: null,
      effectiveGrantedResources: null,
      proposalExpiresAt: row.expires_at,
    };
  }

  async bootstrapSponsor(sponsorId: string, now: number): Promise<boolean> {
    // UPDATE first distinguishes an existing row from an absent one; the
    // conditional INSERT then creates only the latter in the same batch. This
    // avoids INSERT OR IGNORE so the schema can reject raw INSERT OR REPLACE of
    // a sponsor that already anchors enrollment authority.
    const results = await this.#db.batch([
      sql(this.#db, "UPDATE sponsors SET last_seen_at = ? WHERE sponsor_id = ?", now, sponsorId),
      sql(
        this.#db,
        `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
         SELECT ?, ?, ? WHERE changes() = 0`,
        sponsorId,
        now,
        now,
      ),
    ]);
    const insert = results[1];
    return (insert?.meta.changes ?? 0) === 1;
  }

  async revokeCredential(attempt: CredentialRevokeAttempt): Promise<LifecycleCommandResult> {
    const reservedHead = await this.acquireLifecycleLease(
      attempt.sponsorId,
      attempt.eventId,
      attempt.effectiveAt,
    );
    let committed = false;
    try {
      let current: LifecycleCredentialRow | null;
      try {
        current = await sql(
          this.#db,
          `SELECT sponsor.lifecycle_seq, security.panic_at,
                  credential.issued_at, credential.last_used_at
             FROM sponsors sponsor
             JOIN fellow_tokens credential ON credential.sponsor_id = sponsor.sponsor_id
             LEFT JOIN enrollment_sponsor_security security
               ON security.sponsor_id = sponsor.sponsor_id
            WHERE sponsor.sponsor_id = ?
              AND credential.fellow_id = ?
              AND credential.credential_id = ?
              AND credential.revoked_at IS NULL`,
          attempt.sponsorId,
          attempt.fellowId,
          attempt.credentialId,
        ).first<LifecycleCredentialRow>();
      } catch {
        throw new EnrollmentPersistenceError();
      }
      if (current === null) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      if (
        !Number.isSafeInteger(current.lifecycle_seq) ||
        current.lifecycle_seq !== reservedHead ||
        !Number.isSafeInteger(current.issued_at) ||
        (current.last_used_at !== null && !Number.isSafeInteger(current.last_used_at))
      ) {
        throw new EnrollmentPersistenceError();
      }
      if (attempt.effectiveAt < current.issued_at) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      const result = {
        sponsorSeq: reservedHead + 1,
        effectiveAt: attempt.effectiveAt,
      } satisfies LifecycleCommandResult;
      const replay = await attempt.replayFor?.(result);
      committed = await this.commitLifecycleCommand(
        sql(
          this.#db,
          `INSERT INTO fellow_lifecycle_events (
             event_id, sponsor_id, sponsor_seq, action, fellow_id, credential_id,
             from_status, to_status, effective_at, review_from, request_id, created_at
           ) VALUES (?, ?, ?, 'credential-revoked', ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
          attempt.eventId,
          attempt.sponsorId,
          result.sponsorSeq,
          attempt.fellowId,
          attempt.credentialId,
          attempt.effectiveAt,
          attempt.requestId,
          attempt.effectiveAt,
        ),
        replay,
      );
      if (committed) return result;
      throw new EnrollmentPersistenceError();
    } finally {
      if (!committed) await this.releaseLifecycleLease(attempt.sponsorId, attempt.eventId);
    }
  }

  async transitionFellow(attempt: FellowLifecycleAttempt): Promise<LifecycleCommandResult> {
    const reservedHead = await this.acquireLifecycleLease(
      attempt.sponsorId,
      attempt.eventId,
      attempt.effectiveAt,
    );
    let committed = false;
    try {
      let current: LifecycleFellowRow | null;
      try {
        current = await sql(
          this.#db,
          `SELECT sponsor.lifecycle_seq, security.panic_at, fellow.status, fellow.created_at,
                  fellow.status_changed_at,
                  MAX(fellow.created_at, COALESCE((
                    SELECT MIN(credential.issued_at) FROM fellow_tokens credential
                     WHERE credential.fellow_id = fellow.fellow_id
                  ), fellow.created_at)) AS review_from
             FROM sponsors sponsor
             JOIN enrollment_fellows fellow ON fellow.sponsor_id = sponsor.sponsor_id
             LEFT JOIN enrollment_sponsor_security security
               ON security.sponsor_id = sponsor.sponsor_id
            WHERE sponsor.sponsor_id = ? AND fellow.fellow_id = ?`,
          attempt.sponsorId,
          attempt.fellowId,
        ).first<LifecycleFellowRow>();
      } catch {
        throw new EnrollmentPersistenceError();
      }
      if (current === null) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      if (
        !Number.isSafeInteger(current.lifecycle_seq) ||
        current.lifecycle_seq !== reservedHead ||
        !Number.isSafeInteger(current.review_from) ||
        !Number.isSafeInteger(current.created_at) ||
        (current.status_changed_at !== null && !Number.isSafeInteger(current.status_changed_at))
      ) {
        throw new EnrollmentPersistenceError();
      }
      if (
        attempt.effectiveAt < current.created_at ||
        !d1LifecycleTransitionAllowed(current.status, attempt.toStatus)
      ) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      const effectiveAt = Math.max(
        attempt.effectiveAt,
        current.status_changed_at ?? current.created_at,
      );
      const result = {
        sponsorSeq: reservedHead + 1,
        effectiveAt,
      } satisfies LifecycleCommandResult;
      const replay = await attempt.replayFor?.(result);
      committed = await this.commitLifecycleCommand(
        sql(
          this.#db,
          `INSERT INTO fellow_lifecycle_events (
             event_id, sponsor_id, sponsor_seq, action, fellow_id, credential_id,
             from_status, to_status, effective_at, review_from, request_id, created_at
           ) VALUES (?, ?, ?, 'fellow-status-changed', ?, NULL, ?, ?, ?, ?, ?, ?)`,
          attempt.eventId,
          attempt.sponsorId,
          result.sponsorSeq,
          attempt.fellowId,
          current.status,
          attempt.toStatus,
          effectiveAt,
          attempt.toStatus === "compromised" ? current.review_from : null,
          attempt.requestId,
          effectiveAt,
        ),
        replay,
      );
      if (committed) return result;
      throw new EnrollmentPersistenceError();
    } finally {
      if (!committed) await this.releaseLifecycleLease(attempt.sponsorId, attempt.eventId);
    }
  }

  async panicSponsor(attempt: SponsorPanicAttempt): Promise<LifecycleCommandResult> {
    const reservedHead = await this.acquireLifecycleLease(
      attempt.sponsorId,
      attempt.eventId,
      attempt.effectiveAt,
    );
    let committed = false;
    try {
      let current: LifecycleSponsorRow | null;
      try {
        current = await sql(
          this.#db,
          `SELECT sponsor.lifecycle_seq, security.panic_at
             FROM sponsors sponsor
             LEFT JOIN enrollment_sponsor_security security
               ON security.sponsor_id = sponsor.sponsor_id
            WHERE sponsor.sponsor_id = ?`,
          attempt.sponsorId,
        ).first<LifecycleSponsorRow>();
      } catch {
        throw new EnrollmentPersistenceError();
      }
      if (current === null) {
        throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      if (
        !Number.isSafeInteger(current.lifecycle_seq) ||
        current.lifecycle_seq !== reservedHead ||
        (current.panic_at !== null && !Number.isSafeInteger(current.panic_at))
      ) {
        throw new EnrollmentPersistenceError();
      }
      const effectiveAt = Math.max(attempt.effectiveAt, (current.panic_at ?? -1) + 1);
      const result = {
        sponsorSeq: reservedHead + 1,
        effectiveAt,
      } satisfies LifecycleCommandResult;
      const replay = await attempt.replayFor?.(result);
      committed = await this.commitLifecycleCommand(
        sql(
          this.#db,
          `INSERT INTO fellow_lifecycle_events (
             event_id, sponsor_id, sponsor_seq, action, fellow_id, credential_id,
             from_status, to_status, effective_at, review_from, request_id, created_at
           ) VALUES (?, ?, ?, 'sponsor-panic', NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
          attempt.eventId,
          attempt.sponsorId,
          result.sponsorSeq,
          effectiveAt,
          attempt.requestId,
          effectiveAt,
        ),
        replay,
      );
      if (committed) return result;
      throw new EnrollmentPersistenceError();
    } finally {
      if (!committed) await this.releaseLifecycleLease(attempt.sponsorId, attempt.eventId);
    }
  }

  async capsule(enrollmentId: string, now: number): Promise<EnrollmentCapsule> {
    const row = await sql(
      this.#db,
      `SELECT enrollment_id, sponsor_id, kind, secret_hash, secret_expires_at,
              requested_scopes_json, requested_resources_json, invalidated, secret_consumed_at,
              created_at AS record_created_at,
              (SELECT COUNT(*) FROM json_each(requested_resources_json))
                AS requested_resource_key_count,
              (SELECT COUNT(DISTINCT key) FROM json_each(requested_resources_json))
                AS requested_resource_distinct_key_count
         FROM enrollment_records
        WHERE enrollment_id = ? AND invalidated = 0 AND secret_consumed_at IS NULL
          AND typeof(secret_expires_at) = 'integer'
          AND secret_expires_at BETWEEN 1 AND 9007199254740991
          AND secret_expires_at > ?`,
      enrollmentId,
      now,
    ).first<RecordAuthorityEvidenceRow>();
    if (row === null) throw new EnrollmentError("PAIRING_INVALID");
    if (!recordEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
    requestedRecordWithEvidence(row);
    return {
      enrollmentId: row.enrollment_id,
      secretExpiresAt: row.secret_expires_at,
    };
  }

  async poll(attempt: PollAttempt): Promise<PollDecision> {
    for (let retry = 0; retry < 2; retry += 1) {
      const row = await this.proposalByFlow(attempt.flowHandleHash);
      if (row === null) throw new EnrollmentError("FLOW_INVALID");
      if (row.token_hash !== null) return { kind: "already-issued" };
      if (!proposalEvidenceIsValid(row)) throw new EnrollmentPersistenceError();
      const requested = requestedRecordWithEvidence(row);
      const requestedResources = requested.requestedResources;
      if (
        row.status === "pending" &&
        (attempt.now >= row.expires_at ||
          (requestedResources.fellowGrantExpiresAt !== undefined &&
            attempt.now >= requestedResources.fellowGrantExpiresAt))
      ) {
        const decision: PollDecision = { kind: "expired" };
        const idempotency = await attempt.replayFor?.(decision);
        try {
          const statements = [
            sql(
              this.#db,
              "UPDATE enrollment_proposals SET status = 'expired' WHERE proposal_id = ? AND status = 'pending'",
              row.proposal_id,
            ),
            ...(idempotency === undefined ? [] : [this.idempotencyStatement(idempotency)]),
          ];
          const results = await this.#db.batch(statements);
          if (results.every((result) => result.meta.changes === 1)) return decision;
          await this.raceIfPresent(idempotency);
          continue;
        } catch (error) {
          if (error instanceof EnrollmentIdempotencyRaceError) throw error;
          await this.raceIfPresent(idempotency);
          throw new EnrollmentPersistenceError();
        }
      }
      if (row.enrollment_kind === "device") {
        if (row.device_record_expires_at === null) throw new EnrollmentError("FLOW_INVALID");
        if (row.device_mapping_expires_at === null) {
          if (
            row.device_mapping_reclaimed_at === null ||
            attempt.now < row.device_record_expires_at
          ) {
            throw new EnrollmentError("FLOW_INVALID");
          }
        } else if (
          row.device_mapping_reclaimed_at !== null ||
          row.device_mapping_expires_at !== row.device_record_expires_at
        ) {
          throw new EnrollmentError("FLOW_INVALID");
        }
        if (attempt.now >= row.device_record_expires_at) {
          // This is expiry of the short device mapping, not yet a durable
          // proposal terminal state. Persisting it under the stable poll key
          // would replay past the proposal's 24-hour expiry and prevent the
          // required status transition below from ever running.
          return { kind: "expired" };
        }
      }
      if (row.status === "pending") {
        const pacing = nextEnrollmentPollPacing({
          lastPollAt: row.last_poll_at ?? undefined,
          pollIntervalSeconds: row.poll_interval_seconds,
          now: attempt.now,
        });
        const decision: PollDecision =
          pacing.kind === "slow-down"
            ? { kind: "slow-down", retryAfterSeconds: pacing.retryAfterSeconds }
            : { kind: "pending", retryAfterSeconds: pacing.retryAfterSeconds };
        try {
          const [result] = await this.#db.batch([
            sql(
              this.#db,
              `UPDATE enrollment_proposals
                 SET poll_interval_seconds = ?, last_poll_at = ?
               WHERE proposal_id = ? AND status = 'pending'
                 AND ((last_poll_at IS NULL AND ? IS NULL) OR last_poll_at = ?)`,
              pacing.retryAfterSeconds,
              attempt.now,
              row.proposal_id,
              row.last_poll_at,
              row.last_poll_at,
            ),
          ]);
          if (result?.meta.changes === 1) return decision;
          continue;
        } catch {
          throw new EnrollmentPersistenceError();
        }
      }
      if (row.status === "denied" || row.status === "expired") {
        const decision: PollDecision = {
          kind: row.status === "denied" ? "denied" : "expired",
        };
        const idempotency = await attempt.replayFor?.(decision);
        if (idempotency === undefined) return decision;
        try {
          const [result] = await this.#db.batch([this.standaloneIdempotencyStatement(idempotency)]);
          if (result?.meta.changes === 1) return decision;
          await this.raceIfPresent(idempotency);
          throw new EnrollmentPersistenceError();
        } catch (error) {
          if (error instanceof EnrollmentIdempotencyRaceError) throw error;
          await this.raceIfPresent(idempotency);
          throw new EnrollmentPersistenceError();
        }
      }
      if (row.durable_granted_resources_json === null) {
        throw new EnrollmentPersistenceError();
      }
      if (row.durable_granted_scopes_json === null) {
        throw new EnrollmentPersistenceError();
      }
      if (
        typeof row.durable_granted_at !== "number" ||
        !Number.isSafeInteger(row.durable_granted_at) ||
        row.durable_granted_at < row.created_at ||
        row.durable_granted_at >= row.expires_at ||
        attempt.now < row.durable_granted_at
      ) {
        throw new EnrollmentPersistenceError();
      }
      if (row.sponsor_panic_at !== null && row.durable_granted_at <= row.sponsor_panic_at) {
        throw new EnrollmentError("FLOW_INVALID");
      }
      if (
        row.granted_scopes_json === null ||
        row.granted_resources_json === null ||
        row.granted_scopes_json !== row.durable_granted_scopes_json ||
        row.granted_resources_json !== row.durable_granted_resources_json
      ) {
        throw new EnrollmentPersistenceError();
      }
      const durableScopes = parseScopes(row.durable_granted_scopes_json);
      const durableResources = parseResources(row.durable_granted_resources_json);
      if (
        (row.status !== "approved" && row.status !== "reduced") ||
        !enrollmentGrantIsWithinRequest({
          status: row.status,
          requestedScopes: requested.requestedScopes,
          requestedResources,
          grantedScopes: durableScopes,
          grantedResources: durableResources,
        })
      ) {
        throw new EnrollmentPersistenceError();
      }
      if (
        durableResources.fellowGrantExpiresAt !== undefined &&
        attempt.now >= durableResources.fellowGrantExpiresAt
      ) {
        const decision: PollDecision = { kind: "expired" };
        const idempotency = await attempt.replayFor?.(decision);
        try {
          const statements = [
            sql(
              this.#db,
              `UPDATE enrollment_proposals
                  SET status = 'expired'
                WHERE proposal_id = ? AND status IN ('approved', 'reduced')
                  AND token_hash IS NULL`,
              row.proposal_id,
            ),
            ...(idempotency === undefined ? [] : [this.idempotencyStatement(idempotency)]),
          ];
          const results = await this.#db.batch(statements);
          if (results.every((result) => result.meta.changes === 1)) return decision;
          await this.raceIfPresent(idempotency);
          continue;
        } catch (error) {
          if (error instanceof EnrollmentIdempotencyRaceError) throw error;
          await this.raceIfPresent(idempotency);
          throw new EnrollmentPersistenceError();
        }
      }
      const issued = await attempt.createToken();
      const decision: PollDecision = { kind: "issued", token: issued.token };
      const idempotency = await attempt.replayFor?.(decision);
      try {
        const statements: D1PreparedStatement[] = [
          sql(
            this.#db,
            `UPDATE enrollment_proposals
               SET token_hash = ?, token_issued_at = ?
             WHERE proposal_id = ? AND status = ? AND token_hash IS NULL
               AND enrollment_id = ?
               AND fellow_id = ?
               AND flow_handle_hash = ?
               AND name = ?
               AND model = ?
               AND harness = ?
               AND created_at = ?
               AND expires_at = ?
               AND granted_scopes_json = ?
               AND granted_resources_json = ?
               AND EXISTS (
                 SELECT 1
                   FROM enrollment_records current_record
                   JOIN enrollment_grants current_grant
                     ON current_grant.proposal_id = enrollment_proposals.proposal_id
                   JOIN enrollment_fellows current_fellow
                     ON current_fellow.fellow_id = current_grant.fellow_id
                    AND current_fellow.sponsor_id = current_grant.sponsor_id
                  WHERE current_record.enrollment_id = enrollment_proposals.enrollment_id
                    AND current_record.sponsor_id = ?
                    AND current_record.kind = ?
                    AND current_record.created_at = ?
                    AND current_record.requested_scopes_json = ?
                    AND current_record.requested_resources_json = ?
                    AND current_grant.fellow_id = ?
                    AND current_grant.sponsor_id = current_record.sponsor_id
                    AND current_grant.granted_scopes_json = ?
                    AND current_grant.granted_resources_json = ?
                    AND current_grant.granted_at = ?
                    AND current_grant.granted_at > COALESCE((
                      SELECT panic_at FROM enrollment_sponsor_security
                       WHERE sponsor_id = current_grant.sponsor_id
                    ), -1)
                    AND current_fellow.name COLLATE BINARY = ? COLLATE BINARY
                    AND current_fellow.model = ?
                    AND current_fellow.harness = ?
                    AND current_fellow.status IN ('active', 'suspicious_review')
               )`,
            issued.tokenHash,
            attempt.now,
            row.proposal_id,
            row.status,
            row.enrollment_id,
            row.fellow_id,
            row.flow_handle_hash,
            row.name,
            row.model,
            row.harness,
            row.created_at,
            row.expires_at,
            row.granted_scopes_json,
            row.granted_resources_json,
            row.sponsor_id,
            row.kind,
            row.record_created_at,
            row.requested_scopes_json,
            row.requested_resources_json,
            row.fellow_id,
            row.durable_granted_scopes_json,
            row.durable_granted_resources_json,
            row.durable_granted_at,
            row.name,
            row.model,
            row.harness,
          ),
          sql(
            this.#db,
            `INSERT INTO fellow_tokens (
				   credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
				   granted_scopes_json, granted_resources_json, issued_at, expires_at,
				   credential_profile
				 ) SELECT ?, p.proposal_id, g.fellow_id, g.sponsor_id, ?,
				          g.granted_scopes_json, g.granted_resources_json, ?, ?, 'bearer'
                 FROM enrollment_proposals p
                 JOIN enrollment_grants g ON g.proposal_id = p.proposal_id
                WHERE p.proposal_id = ? AND changes() = 1`,
            `cred-${row.proposal_id}`,
            issued.tokenHash,
            attempt.now,
            attempt.now + FELLOW_TOKEN_TTL_MS,
            row.proposal_id,
          ),
        ];
        if (idempotency !== undefined) statements.push(this.idempotencyStatement(idempotency));
        const results = await this.#db.batch(statements);
        if (results.every((result) => result.meta.changes === 1)) return decision;
        await this.raceIfPresent(idempotency);
      } catch (error) {
        if (error instanceof EnrollmentIdempotencyRaceError) throw error;
        await this.raceIfPresent(idempotency);
        throw new EnrollmentPersistenceError();
      }
    }
    const final = await this.proposalByFlow(attempt.flowHandleHash);
    if (final !== null && final.token_hash !== null) return { kind: "already-issued" };
    throw new EnrollmentError("FLOW_INVALID");
  }

  async availabilitySuggestions(name: string): Promise<readonly string[]> {
    const stem = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
    const safeStem =
      stem.length >= 1 && /^[a-z]/.test(stem) && enrollmentNameFailure(stem) === undefined
        ? stem.slice(0, 24).replace(/-+$/g, "")
        : "fellow";
    // One statement. The suffix series is generated inside SQLite and each
    // candidate is probed against the NOCASE unique index on
    // `enrollment_fellows.name`, so the Worker issues a single query and binds
    // five parameters however dense the namespace is. D1 allows 50 queries and
    // 100 bound parameters per invocation; a per-candidate or batched shape
    // breaches the first at saturation, which is exactly when it must not.
    //
    // What is bounded here is what crosses the Worker boundary: at most
    // `limit` rows are ever returned and held in Worker memory. The work inside
    // SQLite is not flat: the engine walks the series and performs one indexed
    // probe per candidate. Keeping this as one join is substantially faster at
    // saturation than a correlated lookup inside each recursive step. The seed
    // is explicitly cast because real D1 binds JavaScript numbers as SQL REAL;
    // without it, concatenation emits `fellow-2.0` while bun:sqlite emits
    // `fellow-2`, and the production name law correctly rejects that drift.
    //
    // Comparing generated text to stored text is also what retires a whole
    // class of parsing bugs: `<stem>-02`, `<stem>-foo` and `<stem>-2-alpha` are
    // simply names that never equal any generated candidate, so none of them
    // can suppress a free suffix, and ordering is integer ordering rather than
    // the lexicographic order that comparing stored text would have imposed.
    const limit = SUGGESTION_COUNT + SUGGESTION_POLICY_OVERFETCH;
    // The query — and reading its result shape — is the only part wrapped. A
    // transport, SQL or malformed-response failure becomes the store's typed
    // operational refusal, carrying none of the driver's text. The policy
    // invariant below raises the same type deliberately, and is deliberately
    // outside this block: re-wrapping it here would erase the distinction
    // between "D1 failed" and "SQL and the name policy disagree".
    let candidates: readonly { readonly name: string }[];
    try {
      const rows = await sql(
        this.#db,
        `WITH RECURSIVE suggestion(suffix) AS (
           SELECT CAST(? AS INTEGER)
           UNION ALL
           SELECT suggestion.suffix + 1
             FROM suggestion
            WHERE suggestion.suffix < CAST(? AS INTEGER)
         )
         SELECT ? || suggestion.suffix AS name
           FROM suggestion
           LEFT JOIN enrollment_fellows AS held
             ON held.name = ? || suggestion.suffix COLLATE NOCASE
          WHERE held.name IS NULL
          ORDER BY suggestion.suffix
          LIMIT ?`,
        FIRST_SUGGESTION_SUFFIX,
        MAX_SUGGESTION_SUFFIX,
        `${safeStem}-`,
        `${safeStem}-`,
        limit,
      ).all<{ name: string }>();
      candidates = rows.results;
    } catch {
      throw new EnrollmentPersistenceError();
    }

    // Defense in depth: SQL knows occupancy, the name policy lives here, and
    // the policy is re-applied to every candidate before it is offered.
    const suggestions: string[] = [];
    for (const row of candidates) {
      if (enrollmentNameFailure(row.name) !== undefined) continue;
      suggestions.push(row.name);
      if (suggestions.length === SUGGESTION_COUNT) return suggestions;
    }
    // Short of three. That is the honest answer only when the statement had
    // nothing further to offer. A full page means the policy filter removed
    // more than the over-fetch was proven to cover, so SQL and this policy
    // disagree about the candidate space — refuse rather than quietly return
    // two suggestions and let a caller read that as a saturated range.
    if (candidates.length >= limit) throw new EnrollmentPersistenceError();
    return suggestions;
  }

  async authenticateCredential(
    tokenHash: string,
    now: number,
    expectedProfile: FellowCredentialProfile,
  ): Promise<FellowCredentialBinding | undefined> {
    const requestedAuthorityRelation = `FROM enrollment_grants authority_grant
                          JOIN enrollment_proposals authority_proposal
                            ON authority_proposal.proposal_id = authority_grant.proposal_id
                          JOIN enrollment_records authority_enrollment
                            ON authority_enrollment.enrollment_id = authority_proposal.enrollment_id
                         WHERE authority_grant.fellow_id = fellow_tokens.fellow_id
                           AND authority_grant.sponsor_id = fellow_tokens.sponsor_id
                           AND authority_grant.granted_scopes_json = fellow_tokens.granted_scopes_json
                           AND authority_grant.granted_resources_json = fellow_tokens.granted_resources_json`;
    const bindingColumns = `fellow_id, credential_id, sponsor_id,
			        (SELECT name FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS name,
			        (SELECT model FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS model,
			        (SELECT harness FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS harness,
			        (SELECT status FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS status,
			        granted_scopes_json, granted_resources_json, token_hash, issued_at,
				        expires_at, last_used_at, revoked_at, credential_profile,
                (SELECT authority_proposal.status ${requestedAuthorityRelation}) AS proposal_status,
                (SELECT authority_enrollment.requested_scopes_json ${requestedAuthorityRelation})
                  AS requested_scopes_json,
                (SELECT authority_enrollment.requested_resources_json ${requestedAuthorityRelation})
                  AS requested_resources_json,
                (SELECT authority_enrollment.created_at ${requestedAuthorityRelation})
                  AS requested_record_created_at,
                (SELECT COUNT(*) FROM json_each(
                  (SELECT authority_enrollment.requested_resources_json ${requestedAuthorityRelation})
                )) AS requested_resource_key_count,
                (SELECT COUNT(DISTINCT key) FROM json_each(
                  (SELECT authority_enrollment.requested_resources_json ${requestedAuthorityRelation})
                )) AS requested_resource_distinct_key_count`;
    const bindingPredicate = `token_hash = ?
			        AND credential_profile = ?
			        AND revoked_at IS NULL
			        AND issued_at <= ?
			        AND expires_at > ?
			        AND (
			          json_type(granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
			          OR json_type(granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
			          OR json_extract(granted_resources_json, '$.fellowGrantExpiresAt') <= 0
			          OR json_extract(granted_resources_json, '$.fellowGrantExpiresAt') > ?
			        )
		        AND issued_at > COALESCE((
			          SELECT panic_at FROM enrollment_sponsor_security
			           WHERE sponsor_id = fellow_tokens.sponsor_id
			        ), -1)
		        AND EXISTS (
			          SELECT 1
			            FROM enrollment_fellows fellow
			            JOIN enrollment_grants grant_row
			              ON grant_row.fellow_id = fellow.fellow_id
			             AND grant_row.sponsor_id = fellow.sponsor_id
			            JOIN enrollment_proposals grant_proposal
			              ON grant_proposal.proposal_id = grant_row.proposal_id
			            JOIN enrollment_records grant_enrollment
			              ON grant_enrollment.enrollment_id = grant_proposal.enrollment_id
		           WHERE fellow.fellow_id = fellow_tokens.fellow_id
		             AND fellow.sponsor_id = fellow_tokens.sponsor_id
			             AND grant_proposal.fellow_id = fellow.fellow_id
			             AND grant_enrollment.sponsor_id = fellow.sponsor_id
			             AND fellow.name COLLATE BINARY = grant_proposal.name COLLATE BINARY
			             AND fellow.model = grant_proposal.model
			             AND fellow.harness = grant_proposal.harness
			             AND fellow.status IN ('active', 'suspicious_review')
			             AND grant_proposal.status IN ('approved', 'reduced')
			             AND grant_proposal.granted_scopes_json = grant_row.granted_scopes_json
			             AND grant_proposal.granted_resources_json = grant_row.granted_resources_json
			             AND grant_row.granted_scopes_json = fellow_tokens.granted_scopes_json
			             AND grant_row.granted_resources_json = fellow_tokens.granted_resources_json
			             AND NOT EXISTS (
			               SELECT 1
			                 FROM json_each(grant_row.granted_scopes_json) granted_scope
			                WHERE NOT EXISTS (
			                  SELECT 1
			                    FROM json_each(grant_enrollment.requested_scopes_json) requested_scope
			                   WHERE requested_scope.value = granted_scope.value
			                )
			             )
			             AND NOT EXISTS (
			               SELECT 1
			                 FROM json_each(grant_row.granted_resources_json) granted_resource
			                WHERE (
			                  granted_resource.key IN ('problemBinding', 'firstDirective')
			                  AND (
			                    json_type(
			                      grant_enrollment.requested_resources_json,
			                      '$.' || granted_resource.key
			                    ) IS NULL
			                    OR json_extract(
			                      grant_enrollment.requested_resources_json,
			                      '$.' || granted_resource.key
			                    ) IS NOT granted_resource.value
			                  )
			                )
			                   OR (
			                     granted_resource.key IN (
			                       'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
			                     )
			                     AND json_type(
			                       grant_enrollment.requested_resources_json,
			                       '$.' || granted_resource.key
			                     ) IS NOT NULL
			                     AND granted_resource.value > json_extract(
			                       grant_enrollment.requested_resources_json,
			                       '$.' || granted_resource.key
			                     )
			                   )
			             )
			             AND NOT EXISTS (
			               SELECT 1
			                 FROM json_each(grant_enrollment.requested_resources_json) requested_resource
			                WHERE requested_resource.key IN (
			                  'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
			                )
			                  AND json_type(
			                    grant_row.granted_resources_json,
			                    '$.' || requested_resource.key
			                  ) IS NULL
			             )
			             AND (
			               grant_proposal.status <> 'reduced'
			               OR json_array_length(grant_row.granted_scopes_json)
			                    < json_array_length(grant_enrollment.requested_scopes_json)
			               OR EXISTS (
			                 SELECT 1
			                   FROM json_each(grant_enrollment.requested_resources_json) requested_resource
			                  WHERE requested_resource.key IN ('problemBinding', 'firstDirective')
			                    AND json_type(
			                      grant_row.granted_resources_json,
			                      '$.' || requested_resource.key
			                    ) IS NULL
			               )
			               OR EXISTS (
			                 SELECT 1
			                   FROM json_each(grant_enrollment.requested_resources_json) requested_resource
			                  WHERE requested_resource.key IN (
			                    'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
			                  )
			                    AND json_extract(
			                      grant_row.granted_resources_json,
			                      '$.' || requested_resource.key
			                    ) < requested_resource.value
			               )
			               OR EXISTS (
			                 SELECT 1
			                   FROM json_each(grant_row.granted_resources_json) granted_resource
			                  WHERE granted_resource.key IN (
			                    'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
			                  )
			                    AND json_type(
			                      grant_enrollment.requested_resources_json,
			                      '$.' || granted_resource.key
			                    ) IS NULL
			               )
			             )
			             AND (
			               grant_proposal.status <> 'approved'
			               OR (
			                 json_array_length(grant_row.granted_scopes_json)
			                   = json_array_length(grant_enrollment.requested_scopes_json)
			                 AND (
			                   SELECT COUNT(*) FROM json_each(grant_row.granted_resources_json)
			                 ) = (
			                   SELECT COUNT(*) FROM json_each(grant_enrollment.requested_resources_json)
			                 )
			                 AND NOT EXISTS (
			                   SELECT 1
			                     FROM json_each(grant_row.granted_resources_json) granted_resource
			                    WHERE json_type(
			                      grant_enrollment.requested_resources_json,
			                      '$.' || granted_resource.key
			                    ) IS NOT granted_resource.type
			                       OR json_extract(
			                         grant_enrollment.requested_resources_json,
			                         '$.' || granted_resource.key
			                       ) IS NOT granted_resource.value
			                 )
			               )
			             )
			             AND typeof(grant_row.granted_at) = 'integer'
			             AND grant_row.granted_at BETWEEN 1 AND 9007199254740991
			             AND grant_row.granted_at >= grant_proposal.created_at
			             AND grant_row.granted_at < grant_proposal.expires_at
			             AND grant_row.granted_at > COALESCE((
			               SELECT panic_at FROM enrollment_sponsor_security
			                WHERE sponsor_id = grant_row.sponsor_id
			             ), -1)
			             AND fellow_tokens.issued_at >= grant_row.granted_at
			             AND (
			               (fellow_tokens.proposal_id IS NULL
			                 AND fellow_tokens.credential_origin = 'harness-migration')
			               OR (
			                 fellow_tokens.proposal_id = grant_proposal.proposal_id
			                 AND fellow_tokens.credential_origin = 'enrollment'
			                 AND grant_proposal.token_hash = fellow_tokens.token_hash
			                 AND grant_proposal.token_issued_at = fellow_tokens.issued_at
			               )
			             )
		        )`;
    const authorizationValues = [tokenHash, expectedProfile, now, now, now] as const;
    let candidate: CredentialRow | null;
    try {
      candidate = await sql(
        this.#db,
        `SELECT ${bindingColumns} FROM fellow_tokens WHERE ${bindingPredicate}`,
        ...authorizationValues,
      ).first<CredentialRow>();
    } catch {
      throw new EnrollmentPersistenceError();
    }
    if (candidate === null) return undefined;
    if (
      !credentialBindingIdentityIsValid(candidate) ||
      !credentialBindingEvidenceIsValid(candidate)
    ) {
      throw new EnrollmentPersistenceError();
    }
    let grantedScopes: readonly RequestedScope[];
    let grantedResources: EnrollmentResourceGrants;
    let requestedScopes: readonly RequestedScope[];
    let requestedResources: EnrollmentResourceGrants;
    try {
      grantedScopes = parseScopes(candidate.granted_scopes_json);
      grantedResources = parseResources(candidate.granted_resources_json);
      requestedScopes = parseScopes(candidate.requested_scopes_json);
      requestedResources = parseResources(candidate.requested_resources_json);
    } catch {
      throw new EnrollmentPersistenceError();
    }
    if (
      candidate.requested_resource_key_count !== candidate.requested_resource_distinct_key_count ||
      !Number.isSafeInteger(candidate.requested_record_created_at) ||
      candidate.requested_record_created_at < 1 ||
      (requestedResources.fellowGrantExpiresAt !== undefined &&
        (requestedResources.fellowGrantExpiresAt <= candidate.requested_record_created_at ||
          requestedResources.fellowGrantExpiresAt - candidate.requested_record_created_at >
            FELLOW_TOKEN_TTL_MS)) ||
      !enrollmentGrantIsWithinRequest({
        status: candidate.proposal_status,
        requestedScopes,
        requestedResources,
        grantedScopes,
        grantedResources,
      })
    ) {
      throw new EnrollmentPersistenceError();
    }
    const updateBindingPredicate = `${bindingPredicate}
      AND EXISTS (
        SELECT 1
          FROM enrollment_grants current_grant
          JOIN enrollment_proposals current_proposal
            ON current_proposal.proposal_id = current_grant.proposal_id
          JOIN enrollment_records current_enrollment
            ON current_enrollment.enrollment_id = current_proposal.enrollment_id
         WHERE current_grant.fellow_id = fellow_tokens.fellow_id
           AND current_grant.sponsor_id = fellow_tokens.sponsor_id
           AND current_grant.granted_scopes_json = fellow_tokens.granted_scopes_json
           AND current_grant.granted_resources_json = fellow_tokens.granted_resources_json
           AND current_enrollment.requested_scopes_json = ?
           AND current_enrollment.requested_resources_json = ?
           AND current_enrollment.created_at = ?
      )`;
    let row: CredentialRow | null;
    try {
      row = await sql(
        this.#db,
        `UPDATE fellow_tokens
			        SET last_used_at = MAX(COALESCE(last_used_at, issued_at), ?)
				      WHERE ${updateBindingPredicate}
				      RETURNING ${bindingColumns}`,
        now,
        ...authorizationValues,
        candidate.requested_scopes_json,
        candidate.requested_resources_json,
        candidate.requested_record_created_at,
      ).first<CredentialRow>();
    } catch {
      throw new EnrollmentPersistenceError();
    }
    if (row === null) return undefined;
    return {
      fellowId: row.fellow_id,
      credentialId: row.credential_id,
      sponsorId: row.sponsor_id,
      name: row.name,
      model: row.model,
      harness: row.harness,
      grantedScopes,
      grantedResources,
      tokenHash: row.token_hash,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
      credentialProfile: row.credential_profile,
      fellowStatus: row.status,
    };
  }

  async idempotencyReplay(
    attempt: IdempotencyAttempt,
  ): Promise<EnrollmentIdempotencyReplay | undefined> {
    let row: IdempotencyRow | null;
    try {
      row = await sql(
        this.#db,
        `SELECT request_digest, response_ciphertext, response_initialization_vector, expires_at
           FROM enrollment_idempotency
          WHERE scope = ? AND principal_scope = ? AND idempotency_key = ? AND expires_at > ?`,
        attempt.scope,
        attempt.principalScope,
        attempt.key,
        attempt.now,
      ).first<IdempotencyRow>();
    } catch {
      throw new EnrollmentPersistenceError();
    }
    if (row === null) return undefined;
    if (!secretSafeEqual(row.request_digest, attempt.digest)) {
      throw new EnrollmentError("IDEMPOTENCY_CONFLICT");
    }
    return {
      digest: row.request_digest,
      encryptedResponse: {
        ciphertext: row.response_ciphertext,
        initializationVector: row.response_initialization_vector,
      },
    };
  }

  private async acquireLifecycleLease(
    sponsorId: string,
    eventId: string,
    effectiveAt: number,
  ): Promise<number> {
    const expiresAt = effectiveAt + LIFECYCLE_LEASE_TTL_MS;
    if (!Number.isSafeInteger(expiresAt)) throw new EnrollmentPersistenceError();
    for (let attempt = 0; attempt < MAX_LIFECYCLE_LEASE_ATTEMPTS; attempt += 1) {
      let row: { lifecycle_seq: number } | null;
      try {
        row = await sql(
          this.#db,
          `UPDATE sponsors
              SET lifecycle_lease_token = ?, lifecycle_lease_expires_at = ?
            WHERE sponsor_id = ?
              AND (lifecycle_lease_token IS NULL
                OR lifecycle_lease_expires_at <= ?
                OR lifecycle_lease_token = ?)
            RETURNING lifecycle_seq`,
          eventId,
          expiresAt,
          sponsorId,
          effectiveAt,
          eventId,
        ).first<{ lifecycle_seq: number }>();
      } catch {
        await this.releaseLifecycleLease(sponsorId, eventId);
        throw new EnrollmentPersistenceError();
      }
      if (row !== null) {
        if (!Number.isSafeInteger(row.lifecycle_seq) || row.lifecycle_seq < 0) {
          await this.releaseLifecycleLease(sponsorId, eventId);
          throw new EnrollmentPersistenceError();
        }
        return row.lifecycle_seq;
      }
      if (attempt === 0) {
        let sponsor: { sponsor_id: string } | null;
        try {
          sponsor = await sql(
            this.#db,
            "SELECT sponsor_id FROM sponsors WHERE sponsor_id = ?",
            sponsorId,
          ).first<{ sponsor_id: string }>();
        } catch {
          throw new EnrollmentPersistenceError();
        }
        if (sponsor === null) throw new EnrollmentError("FELLOW_LIFECYCLE_NOT_CURRENT");
      }
      if (attempt + 1 < MAX_LIFECYCLE_LEASE_ATTEMPTS) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, lifecycleLeaseRetryDelay(eventId, attempt)),
        );
      }
    }
    throw new EnrollmentError("LIFECYCLE_BUSY");
  }

  private async releaseLifecycleLease(sponsorId: string, eventId: string): Promise<void> {
    try {
      await sql(
        this.#db,
        `UPDATE sponsors
            SET lifecycle_lease_token = NULL, lifecycle_lease_expires_at = NULL
          WHERE sponsor_id = ? AND lifecycle_lease_token = ?`,
        sponsorId,
        eventId,
      ).run();
    } catch {
      // A failed command remains unauthorized and the short lease is reclaimable.
    }
  }

  private async commitLifecycleCommand(
    event: D1PreparedStatement,
    replay: EnrollmentIdempotencyWrite | undefined,
  ): Promise<boolean> {
    try {
      const results = await this.#db.batch([
        event,
        ...(replay === undefined ? [] : [this.idempotencyStatement(replay)]),
      ]);
      // D1/SQLite may include AFTER-trigger projection writes in statement
      // metadata. The top-level event insert is a VALUES statement guarded by
      // strict triggers, so any positive count proves the command appended.
      if ((results[0]?.meta.changes ?? 0) < 1) return false;
      if (replay !== undefined && (results[1]?.meta.changes ?? 0) !== 1) return false;
      return true;
    } catch (error) {
      await this.raceIfPresent(replay);
      if (isActiveFellowCapFailure(error)) throw new EnrollmentError("FELLOW_CAP_REACHED");
      return false;
    }
  }

  /**
   * The replay row, appended after the product effect in the same D1 batch.
   *
   * Three mechanisms are doing distinct jobs here, and each one is load-bearing:
   *
   * 1. `SELECT … WHERE changes() = 1` — the row is written only if the statement
   *    immediately before it in the batch modified exactly one row. A conditional
   *    effect that matched nothing therefore writes no replay row, so a no-op
   *    cannot masquerade as a completed operation. Callers additionally
   *    refuse success unless every top-level product statement reports a
   *    positive change; D1 metadata may include an AFTER-trigger projection.
   *
   * 2. `request_digest = CASE … ELSE NULL` — **the abort.** On a conflict with a
   *    still-live key, this assigns NULL to a NOT NULL column
   *    (`db/migrations/0002_enrollment_g0.sql`), which fails the statement and
   *    rolls the whole batch back, product effect included. That is deliberate:
   *    it refuses a concurrent second writer under one key *atomically*, with no
   *    window between a read and a write for a racing isolate to slip through.
   *    A read-then-write conflict check would reintroduce exactly that window,
   *    so this must not be "simplified" into one.
   *
   * 3. An expired row is reclaimable: the CASE takes the `excluded` digest and
   *    the row is overwritten by the new completed operation.
   *
   * `DO UPDATE` is deliberately unconditional. An earlier revision carried a
   * `WHERE expires_at <= ?a OR expires_at > ?b` bound with the same timestamp
   * twice — a tautology that read like a guard while filtering nothing, and hid
   * the fact that mechanism 2 is the only gate. The guard now lives in the CASE
   * alone, where it can be read.
   */
  private idempotencyStatement(write: EnrollmentIdempotencyWrite): D1PreparedStatement {
    return sql(
      this.#db,
      `INSERT INTO enrollment_idempotency (
         scope, principal_scope, idempotency_key, request_digest,
         response_ciphertext, response_initialization_vector, expires_at
       ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
       ON CONFLICT(scope, principal_scope, idempotency_key) DO UPDATE SET
         request_digest = CASE
           WHEN enrollment_idempotency.expires_at <= ? THEN excluded.request_digest
           ELSE NULL
         END,
         response_ciphertext = excluded.response_ciphertext,
         response_initialization_vector = excluded.response_initialization_vector,
         expires_at = excluded.expires_at`,
      write.scope,
      write.principalScope,
      write.key,
      write.digest,
      write.encryptedResponse.ciphertext,
      write.encryptedResponse.initializationVector,
      write.now + IDEMPOTENCY_RETENTION_MS,
      write.now,
    );
  }

  /**
   * The same row for an observation that has no product effect to bind to — a
   * poll that finds an already-denied or already-expired proposal. There is no
   * preceding statement, so there is no `changes()` guard; the live-key abort of
   * mechanism 2 above is identical and equally load-bearing.
   */
  private standaloneIdempotencyStatement(write: EnrollmentIdempotencyWrite): D1PreparedStatement {
    return sql(
      this.#db,
      `INSERT INTO enrollment_idempotency (
         scope, principal_scope, idempotency_key, request_digest,
         response_ciphertext, response_initialization_vector, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, principal_scope, idempotency_key) DO UPDATE SET
         request_digest = CASE
           WHEN enrollment_idempotency.expires_at <= ? THEN excluded.request_digest
           ELSE NULL
         END,
         response_ciphertext = excluded.response_ciphertext,
         response_initialization_vector = excluded.response_initialization_vector,
         expires_at = excluded.expires_at`,
      write.scope,
      write.principalScope,
      write.key,
      write.digest,
      write.encryptedResponse.ciphertext,
      write.encryptedResponse.initializationVector,
      write.now + IDEMPOTENCY_RETENTION_MS,
      write.now,
    );
  }

  /** A completed concurrent write is retried by the service through ciphertext. */
  private async sponsorEnrollmentRateLimitError(
    sponsorId: string,
    now: number,
  ): Promise<SponsorEnrollmentRateLimitError> {
    let row: { latest_attempt: number | null } | null;
    try {
      row = await sql(
        this.#db,
        `SELECT max(
           coalesce((
             SELECT created_at FROM enrollment_records
              WHERE sponsor_id = ? AND kind = 'join-url'
              ORDER BY created_at DESC LIMIT 1
           ), 0),
           coalesce((
             SELECT attempted_at FROM sponsor_device_enrollment_attempts
              WHERE sponsor_id = ?
              ORDER BY attempted_at DESC LIMIT 1
           ), 0)
         ) AS latest_attempt`,
        sponsorId,
        sponsorId,
      ).first<{ latest_attempt: number | null }>();
    } catch {
      throw new EnrollmentPersistenceError();
    }
    const latestAt = row?.latest_attempt;
    if (!Number.isSafeInteger(latestAt) || (latestAt ?? 0) <= 0) {
      throw new EnrollmentPersistenceError();
    }
    const retryAfterSeconds =
      Math.max(
        0,
        Math.ceil(((latestAt as number) + SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS - now) / 1_000),
      ) + 1;
    return new SponsorEnrollmentRateLimitError(retryAfterSeconds);
  }

  private async raceIfPresent(write: EnrollmentIdempotencyWrite | undefined): Promise<void> {
    if (write === undefined) return;
    const replay = await this.idempotencyReplay(write);
    if (replay !== undefined) throw new EnrollmentIdempotencyRaceError();
  }

  private async proposalByEnrollment(
    enrollmentId: string,
    sponsorId: string,
  ): Promise<ProposalRow | null> {
    return sql(
      this.#db,
      `SELECT e.enrollment_id, e.sponsor_id, e.kind, e.secret_hash, e.secret_expires_at,
              e.requested_scopes_json, e.requested_resources_json, e.invalidated, e.secret_consumed_at,
              e.created_at AS record_created_at,
              (SELECT COUNT(*) FROM json_each(e.requested_resources_json))
                AS requested_resource_key_count,
              (SELECT COUNT(DISTINCT key) FROM json_each(e.requested_resources_json))
                AS requested_resource_distinct_key_count,
              p.proposal_id, p.fellow_id, p.flow_handle_hash, p.name, p.model, p.harness,
              p.reasoning_effort, p.tools_note, p.created_at, p.expires_at, p.status,
              p.granted_scopes_json, p.granted_resources_json, p.token_hash, p.token_issued_at,
              p.poll_interval_seconds, p.last_poll_at,
              g.granted_scopes_json AS durable_granted_scopes_json,
              g.granted_resources_json AS durable_granted_resources_json,
              g.granted_at AS durable_granted_at
              ,(SELECT panic_at FROM enrollment_sponsor_security
                  WHERE sponsor_id = e.sponsor_id) AS sponsor_panic_at
         FROM enrollment_records e
         JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
         LEFT JOIN enrollment_grants g ON g.proposal_id = p.proposal_id
        WHERE e.enrollment_id = ? AND e.sponsor_id = ?`,
      enrollmentId,
      sponsorId,
    ).first<ProposalRow>();
  }

  /** The proposal row for an unbound device enrollment, or null. */
  private async unboundDeviceProposalByEnrollment(
    enrollmentId: string,
  ): Promise<UnboundDeviceProposalRow | null> {
    return sql(
      this.#db,
      `SELECT e.enrollment_id, e.sponsor_id, e.kind, e.secret_hash, e.secret_expires_at,
              e.requested_scopes_json, e.requested_resources_json, e.invalidated, e.secret_consumed_at,
              e.created_at AS record_created_at,
              (SELECT COUNT(*) FROM json_each(e.requested_resources_json))
                AS requested_resource_key_count,
              (SELECT COUNT(DISTINCT key) FROM json_each(e.requested_resources_json))
                AS requested_resource_distinct_key_count,
              p.proposal_id, p.fellow_id, p.flow_handle_hash, p.name, p.model, p.harness,
              p.reasoning_effort, p.tools_note, p.created_at, p.expires_at, p.status,
              p.granted_scopes_json, p.granted_resources_json, p.token_hash, p.token_issued_at,
              p.poll_interval_seconds, p.last_poll_at,
              d.expires_at AS device_mapping_expires_at,
              g.granted_scopes_json AS durable_granted_scopes_json,
              g.granted_resources_json AS durable_granted_resources_json,
              g.granted_at AS durable_granted_at
              ,(SELECT panic_at FROM enrollment_sponsor_security
                  WHERE sponsor_id = e.sponsor_id) AS sponsor_panic_at
         FROM enrollment_records e
         JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
         LEFT JOIN device_codes d ON d.enrollment_id = e.enrollment_id
         LEFT JOIN enrollment_grants g ON g.proposal_id = p.proposal_id
        WHERE e.enrollment_id = ? AND e.sponsor_id = '' AND e.kind = 'device'`,
      enrollmentId,
    ).first<UnboundDeviceProposalRow>();
  }

  private async proposalByFlow(flowHandleHash: string): Promise<PollingProposalRow | null> {
    return sql(
      this.#db,
      `SELECT e.enrollment_id, e.sponsor_id, e.kind, e.secret_hash, e.secret_expires_at,
              e.requested_scopes_json, e.requested_resources_json, e.invalidated, e.secret_consumed_at,
              e.created_at AS record_created_at,
              (SELECT COUNT(*) FROM json_each(e.requested_resources_json))
                AS requested_resource_key_count,
              (SELECT COUNT(DISTINCT key) FROM json_each(e.requested_resources_json))
                AS requested_resource_distinct_key_count,
              e.kind AS enrollment_kind,
              e.device_expires_at AS device_record_expires_at,
              e.device_mapping_reclaimed_at,
              d.expires_at AS device_mapping_expires_at,
              p.proposal_id, p.fellow_id, p.flow_handle_hash, p.name, p.model, p.harness,
              p.reasoning_effort, p.tools_note, p.created_at, p.expires_at, p.status,
              p.granted_scopes_json, p.granted_resources_json, p.token_hash, p.token_issued_at,
              p.poll_interval_seconds, p.last_poll_at,
              g.granted_scopes_json AS durable_granted_scopes_json,
              g.granted_resources_json AS durable_granted_resources_json,
              g.granted_at AS durable_granted_at
              ,(SELECT panic_at FROM enrollment_sponsor_security
                  WHERE sponsor_id = e.sponsor_id) AS sponsor_panic_at
         FROM enrollment_proposals p
         JOIN enrollment_records e ON e.enrollment_id = p.enrollment_id
         LEFT JOIN device_codes d ON d.enrollment_id = e.enrollment_id
         LEFT JOIN enrollment_grants g ON g.proposal_id = p.proposal_id
        WHERE p.flow_handle_hash = ?`,
      flowHandleHash,
    ).first<PollingProposalRow>();
  }

  private reducedGrant(
    requested: Pick<EnrollmentRecord, "requestedScopes" | "requestedResources">,
    decision: DecisionAttempt["decision"],
    now: number,
  ): {
    readonly scopes: readonly RequestedScope[];
    readonly resources: EnrollmentResourceGrants;
  } {
    if (decision.decision === "approve") {
      return {
        scopes: requested.requestedScopes,
        resources: requested.requestedResources,
      };
    }
    if (decision.decision === "deny") throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    let scopes = requested.requestedScopes;
    if (decision.reduction.scopes !== undefined) {
      scopes = uniqueEnrollmentScopes(decision.reduction.scopes);
      if (!scopes.every((scope) => requested.requestedScopes.includes(scope))) {
        throw new EnrollmentError("SCOPE_ESCALATION");
      }
      if (!isStrictEnrollmentScopeReduction(requested.requestedScopes, scopes)) {
        throw new EnrollmentError("SCOPE_NOT_REDUCED");
      }
    }
    const resourceReduction = { ...decision.reduction } as Record<string, unknown>;
    delete resourceReduction.scopes;
    const resources =
      Object.keys(resourceReduction).length === 0
        ? requested.requestedResources
        : reduceEnrollmentResources(
            requested.requestedResources,
            decision.reduction as EnrollmentGrantReduction,
            now,
          );
    if (decision.reduction.scopes === undefined && resources === requested.requestedResources) {
      throw new EnrollmentError("SCOPE_NOT_REDUCED");
    }
    return { scopes, resources };
  }
}
