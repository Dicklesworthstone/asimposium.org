import {
  type EnrollmentGrantReduction,
  EnrollmentResourceGrantsSchema,
  type FellowCredentialProfile,
  type FellowLifecycleStatus,
  type RequestedScope,
  RequestedScopeSchema,
} from "@asimposium/contracts";
// D1 proves JSON syntax; these schemas prove that stored authority still obeys
// the public scope vocabulary and resource bounds when it is read back.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import {
  type ClaimAttempt,
  type DecisionAttempt,
  type EnrollmentApprovalCard,
  type EnrollmentCapsule,
  EnrollmentError,
  EnrollmentIdempotencyRaceError,
  type EnrollmentIdempotencyReplay,
  type EnrollmentIdempotencyWrite,
  EnrollmentPersistenceError,
  type EnrollmentRecord,
  type EnrollmentResourceGrants,
  type EnrollmentStore,
  enrollmentNameFailure,
  FELLOW_TOKEN_TTL_MS,
  type FellowCredentialBinding,
  type IdempotencyAttempt,
  isStrictEnrollmentScopeReduction,
  nextEnrollmentPollPacing,
  type PollAttempt,
  type PollDecision,
  reduceEnrollmentResources,
  type SponsorFellowRecord,
  uniqueEnrollmentScopes,
} from "./service.ts";

type ProposalStatus = "pending" | "approved" | "reduced" | "denied" | "expired";

interface RecordRow {
  enrollment_id: string;
  sponsor_id: string;
  secret_hash: string;
  secret_expires_at: number;
  requested_scopes_json: string;
  requested_resources_json: string;
  invalidated: number;
  secret_consumed_at: number | null;
}

interface ProposalRow extends RecordRow {
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
}

interface IdempotencyRow {
  request_digest: string;
  response_ciphertext: string;
  response_initialization_vector: string;
  expires_at: number;
}

/** Columns selected by `pendingApprovalCardsBySponsor`: record join pending proposal. */
interface PendingProposalRow {
  enrollment_id: string;
  requested_scopes_json: string;
  requested_resources_json: string;
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
    return uniqueEnrollmentScopes(value.map((scope) => RequestedScopeSchema.parse(scope)));
  } catch {
    throw new EnrollmentError("PAIRING_INVALID");
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
    throw new EnrollmentError("PAIRING_INVALID");
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

function proposalStatus(value: string): ProposalStatus {
  if (["pending", "approved", "reduced", "denied", "expired"].includes(value)) {
    return value as ProposalStatus;
  }
  throw new EnrollmentError("PAIRING_INVALID");
}

function isUniqueNameFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: enrollment_fellows\.name/i.test(error.message)
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
    let row: RecordRow | null;
    try {
      row = await sql(
        this.#db,
        `SELECT enrollment_id, sponsor_id, secret_hash, secret_expires_at,
                requested_scopes_json, requested_resources_json, invalidated, secret_consumed_at
           FROM enrollment_records WHERE enrollment_id = ?`,
        enrollmentId,
      ).first<RecordRow>();
    } catch {
      throw new EnrollmentPersistenceError();
    }
    if (
      row === null ||
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
    const row = await this.proposalByEnrollment(attempt.enrollmentId, attempt.sponsorId);
    if (row === null) throw new EnrollmentError("WRONG_PRINCIPAL");
    if (row.status !== "pending") throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    if (attempt.now >= row.expires_at) {
      throw new EnrollmentError("PROPOSAL_EXPIRED");
    }

    if (attempt.decision.decision === "deny") {
      try {
        const statements = [
          sql(
            this.#db,
            `UPDATE enrollment_proposals SET status = 'denied'
             WHERE proposal_id = ? AND status = 'pending' AND expires_at > ?`,
            row.proposal_id,
            attempt.now,
          ),
          ...(idempotency === undefined ? [] : [this.idempotencyStatement(idempotency)]),
        ];
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
      throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    }

    const requested = requestedRecord(row);
    const { scopes, resources } = this.reducedGrant(requested, attempt.decision, attempt.now);
    const nextStatus = attempt.decision.decision === "approve" ? "approved" : "reduced";
    try {
      const statements: D1PreparedStatement[] = [
        sql(
          this.#db,
          `UPDATE enrollment_proposals
             SET status = ?, granted_scopes_json = ?, granted_resources_json = ?
           WHERE proposal_id = ? AND status = 'pending' AND expires_at > ?`,
          nextStatus,
          encode(scopes),
          encode(resources),
          row.proposal_id,
          attempt.now,
        ),
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
      if (results.every((result) => result.meta.changes === 1)) return;
      await this.raceIfPresent(idempotency);
      throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    } catch (error) {
      if (error instanceof EnrollmentError) throw error;
      if (error instanceof EnrollmentIdempotencyRaceError) throw error;
      if (isUniqueNameFailure(error)) throw new EnrollmentError("NAME_TAKEN");
      await this.raceIfPresent(idempotency);
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
    if (row.status === "pending" && now >= row.expires_at) {
      await sql(
        this.#db,
        "UPDATE enrollment_proposals SET status = 'expired' WHERE proposal_id = ? AND status = 'pending'",
        row.proposal_id,
      ).run();
      row.status = "expired";
    }
    const requested = requestedRecord(row);
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
      throw new EnrollmentError("PAIRING_INVALID");
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
    // Lazy-expiry sweep first, the same rule approvalCard applies per row.
    await sql(
      this.#db,
      `UPDATE enrollment_proposals SET status = 'expired'
        WHERE status = 'pending' AND expires_at <= ?
          AND enrollment_id IN (SELECT enrollment_id FROM enrollment_records WHERE sponsor_id = ?)`,
      now,
      sponsorId,
    ).run();
    const rows = await sql(
      this.#db,
      `SELECT e.enrollment_id, e.requested_scopes_json, e.requested_resources_json,
              p.proposal_id, p.name, p.model, p.harness, p.reasoning_effort, p.tools_note,
              p.created_at, p.expires_at, p.status
         FROM enrollment_records e
         JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
        WHERE e.sponsor_id = ? AND p.status = 'pending'
        ORDER BY p.created_at ASC
        LIMIT 100`,
      sponsorId,
    ).all<PendingProposalRow>();
    return rows.results.map((row) => ({
      enrollmentId: row.enrollment_id,
      proposalId: row.proposal_id,
      status: "pending" as const,
      name: row.name,
      model: row.model,
      harness: row.harness,
      ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
      ...(row.tools_note === null ? {} : { toolsNote: row.tools_note }),
      requestedScopes: parseScopes(row.requested_scopes_json),
      requestedResources: parseResources(row.requested_resources_json),
      effectiveGrantedScopes: null,
      effectiveGrantedResources: null,
      proposalExpiresAt: row.expires_at,
    }));
  }

  async fellowsBySponsor(sponsorId: string, now: number): Promise<SponsorFellowRecord[]> {
    let rows: readonly FellowGrantRow[];
    try {
      const result = await sql(
        this.#db,
        `SELECT f.fellow_id, f.name, f.model, f.harness, f.status,
			          g.granted_scopes_json, g.granted_resources_json, g.granted_at,
			          c.credential_id, c.credential_profile, c.issued_at, c.expires_at,
			          c.last_used_at
			     FROM enrollment_fellows f
			     JOIN enrollment_grants g ON g.fellow_id = f.fellow_id
			     LEFT JOIN enrollment_sponsor_security security ON security.sponsor_id = f.sponsor_id
			     LEFT JOIN fellow_tokens c
			       ON c.fellow_id = f.fellow_id
			      AND c.sponsor_id = f.sponsor_id
			      AND c.revoked_at IS NULL
			      AND c.expires_at > ?
			      AND c.issued_at <= ?
			      AND c.issued_at > COALESCE(security.panic_at, -1)
			    WHERE f.sponsor_id = ?
			    ORDER BY g.granted_at DESC, c.issued_at DESC
			    LIMIT 1501`,
        now,
        now,
        sponsorId,
      ).all<FellowGrantRow>();
      if (result.results.length > 1500) throw new EnrollmentPersistenceError();
      rows = result.results;
    } catch (error) {
      if (error instanceof EnrollmentPersistenceError) throw error;
      throw new EnrollmentPersistenceError();
    }

    const fellows = new Map<string, SponsorFellowRecord>();
    for (const row of rows) {
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
    return [...fellows.values()];
  }

  async bootstrapSponsor(sponsorId: string, now: number): Promise<boolean> {
    // INSERT OR IGNORE first so `created` is exact; the follow-up UPDATE moves
    // only last_seen_at. Two statements in one batch keep the pair atomic.
    const results = await this.#db.batch([
      sql(
        this.#db,
        "INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)",
        sponsorId,
        now,
        now,
      ),
      sql(this.#db, "UPDATE sponsors SET last_seen_at = ? WHERE sponsor_id = ?", now, sponsorId),
    ]);
    const insert = results[0];
    return (insert?.meta.changes ?? 0) === 1;
  }

  async capsule(enrollmentId: string, now: number): Promise<EnrollmentCapsule> {
    const row = await sql(
      this.#db,
      `SELECT enrollment_id, sponsor_id, secret_hash, secret_expires_at,
              requested_scopes_json, requested_resources_json, invalidated, secret_consumed_at
         FROM enrollment_records
        WHERE enrollment_id = ? AND invalidated = 0 AND secret_consumed_at IS NULL
          AND secret_expires_at > ?`,
      enrollmentId,
      now,
    ).first<RecordRow>();
    if (row === null) throw new EnrollmentError("PAIRING_INVALID");
    const requested = requestedRecord(row);
    return {
      enrollmentId: row.enrollment_id,
      secretExpiresAt: row.secret_expires_at,
      requestedScopes: requested.requestedScopes,
      requestedResources: requested.requestedResources,
    };
  }

  async poll(attempt: PollAttempt): Promise<PollDecision> {
    for (let retry = 0; retry < 2; retry += 1) {
      const row = await this.proposalByFlow(attempt.flowHandleHash);
      if (row === null) throw new EnrollmentError("FLOW_INVALID");
      if (row.status === "pending" && attempt.now >= row.expires_at) {
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
        const idempotency = await attempt.replayFor?.(decision);
        try {
          const statements = [
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
      if (row.status === "denied" || row.status === "expired") {
        const decision: PollDecision = { kind: row.status === "denied" ? "denied" : "expired" };
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
      if (row.token_hash !== null) return { kind: "already-issued" };

      const issued = await attempt.createToken();
      const decision: PollDecision = { kind: "issued", token: issued.token };
      const idempotency = await attempt.replayFor?.(decision);
      try {
        const statements: D1PreparedStatement[] = [
          sql(
            this.#db,
            `UPDATE enrollment_proposals
               SET token_hash = ?, token_issued_at = ?
             WHERE proposal_id = ? AND status IN ('approved', 'reduced') AND token_hash IS NULL`,
            issued.tokenHash,
            attempt.now,
            row.proposal_id,
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
  ): Promise<FellowCredentialBinding | undefined> {
    let row: CredentialRow | null;
    try {
      row = await sql(
        this.#db,
        `UPDATE fellow_tokens
				        SET last_used_at = MAX(COALESCE(last_used_at, issued_at), ?)
				      WHERE token_hash = ?
				        AND revoked_at IS NULL
				        AND issued_at <= ?
				        AND expires_at > ?
			        AND issued_at > COALESCE((
			          SELECT panic_at FROM enrollment_sponsor_security
			           WHERE sponsor_id = fellow_tokens.sponsor_id
			        ), -1)
			        AND EXISTS (
				          SELECT 1 FROM enrollment_fellows
			           WHERE fellow_id = fellow_tokens.fellow_id
			             AND sponsor_id = fellow_tokens.sponsor_id
				             AND status IN ('active', 'suspicious_review')
			        )
			      RETURNING fellow_id, credential_id, sponsor_id,
			        (SELECT name FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS name,
			        (SELECT model FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS model,
			        (SELECT harness FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS harness,
			        (SELECT status FROM enrollment_fellows
			          WHERE fellow_id = fellow_tokens.fellow_id) AS status,
			        granted_scopes_json, granted_resources_json, token_hash, issued_at,
			        expires_at, last_used_at, revoked_at, credential_profile`,
        now,
        tokenHash,
        now,
        now,
      ).first<CredentialRow>();
    } catch {
      throw new EnrollmentPersistenceError();
    }
    if (row === null) return undefined;
    try {
      return {
        fellowId: row.fellow_id,
        credentialId: row.credential_id,
        sponsorId: row.sponsor_id,
        name: row.name,
        model: row.model,
        harness: row.harness,
        grantedScopes: parseScopes(row.granted_scopes_json),
        grantedResources: parseResources(row.granted_resources_json),
        tokenHash: row.token_hash,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at ?? undefined,
        revokedAt: row.revoked_at ?? undefined,
        credentialProfile: row.credential_profile,
        fellowStatus: row.status,
      };
    } catch {
      throw new EnrollmentPersistenceError();
    }
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

  /**
   * The replay row, appended after the product effect in the same D1 batch.
   *
   * Three mechanisms are doing distinct jobs here, and each one is load-bearing:
   *
   * 1. `SELECT … WHERE changes() = 1` — the row is written only if the statement
   *    immediately before it in the batch modified exactly one row. A conditional
   *    effect that matched nothing therefore writes no replay row, so a no-op
   *    cannot masquerade as a completed operation. The caller additionally
   *    refuses to report success unless *every* statement changed one row.
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
      `SELECT e.enrollment_id, e.sponsor_id, e.secret_hash, e.secret_expires_at,
              e.requested_scopes_json, e.requested_resources_json, e.invalidated, e.secret_consumed_at,
              p.proposal_id, p.fellow_id, p.flow_handle_hash, p.name, p.model, p.harness,
              p.reasoning_effort, p.tools_note, p.created_at, p.expires_at, p.status,
              p.granted_scopes_json, p.granted_resources_json, p.token_hash, p.token_issued_at,
              p.poll_interval_seconds, p.last_poll_at,
              g.granted_scopes_json AS durable_granted_scopes_json,
              g.granted_resources_json AS durable_granted_resources_json
         FROM enrollment_records e
         JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
         LEFT JOIN enrollment_grants g ON g.proposal_id = p.proposal_id
        WHERE e.enrollment_id = ? AND e.sponsor_id = ?`,
      enrollmentId,
      sponsorId,
    ).first<ProposalRow>();
  }

  private async proposalByFlow(flowHandleHash: string): Promise<ProposalRow | null> {
    return sql(
      this.#db,
      `SELECT e.enrollment_id, e.sponsor_id, e.secret_hash, e.secret_expires_at,
              e.requested_scopes_json, e.requested_resources_json, e.invalidated, e.secret_consumed_at,
              p.proposal_id, p.fellow_id, p.flow_handle_hash, p.name, p.model, p.harness,
              p.reasoning_effort, p.tools_note, p.created_at, p.expires_at, p.status,
              p.granted_scopes_json, p.granted_resources_json, p.token_hash, p.token_issued_at,
              p.poll_interval_seconds, p.last_poll_at,
              g.granted_scopes_json AS durable_granted_scopes_json,
              g.granted_resources_json AS durable_granted_resources_json
         FROM enrollment_proposals p
         JOIN enrollment_records e ON e.enrollment_id = p.enrollment_id
         LEFT JOIN enrollment_grants g ON g.proposal_id = p.proposal_id
        WHERE p.flow_handle_hash = ?`,
      flowHandleHash,
    ).first<ProposalRow>();
  }

  private reducedGrant(
    requested: Pick<EnrollmentRecord, "requestedScopes" | "requestedResources">,
    decision: DecisionAttempt["decision"],
    now: number,
  ): { readonly scopes: readonly RequestedScope[]; readonly resources: EnrollmentResourceGrants } {
    if (decision.decision === "approve") {
      return { scopes: requested.requestedScopes, resources: requested.requestedResources };
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
