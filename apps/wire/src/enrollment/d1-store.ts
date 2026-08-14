import type { EnrollmentGrantReduction, RequestedScope } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import {
  type ClaimAttempt,
  type DecisionAttempt,
  type EnrollmentApprovalCard,
  type EnrollmentCapsule,
  EnrollmentError,
  type EnrollmentIdempotencyReplay,
  type EnrollmentRecord,
  type EnrollmentResourceGrants,
  type EnrollmentStore,
  enrollmentNameFailure,
  type FellowCredentialBinding,
  type IdempotencyAttempt,
  type IdempotencyResult,
  isStrictEnrollmentScopeReduction,
  nextEnrollmentPollPacing,
  type PollAttempt,
  type PollDecision,
  reduceEnrollmentResources,
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
}

interface IdempotencyRow {
  request_digest: string;
  response_ciphertext: string;
  response_initialization_vector: string;
  expires_at: number;
}

const sql = (db: D1Database, query: string, ...values: unknown[]): D1PreparedStatement =>
  db.prepare(query).bind(...values);

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
    if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
      throw new TypeError("invalid scope payload");
    }
    return uniqueEnrollmentScopes(value as RequestedScope[]);
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
    const output: EnrollmentResourceGrants = {
      ...(typeof input.problemBinding === "string" ? { problemBinding: input.problemBinding } : {}),
      ...(typeof input.firstDirective === "string" ? { firstDirective: input.firstDirective } : {}),
      ...(typeof input.eventBudget === "number" ? { eventBudget: input.eventBudget } : {}),
      ...(typeof input.artifactBudgetBytes === "number"
        ? { artifactBudgetBytes: input.artifactBudgetBytes }
        : {}),
      ...(typeof input.fellowGrantExpiresAt === "number"
        ? { fellowGrantExpiresAt: input.fellowGrantExpiresAt }
        : {}),
    };
    return output;
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
 * D1 implementation of the S-1 transition seam. All state-changing paths use
 * conditional statements or a D1 batch; no route receives a raw SQL error or
 * a plaintext credential. This is real binding code, not a D1 mock.
 */
export class D1EnrollmentStore implements EnrollmentStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async create(record: EnrollmentRecord, replacesEnrollmentId?: string): Promise<boolean> {
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
      if (replacesEnrollmentId === undefined) {
        await insert().run();
        return true;
      }
      const results = await this.#db.batch([
        sql(
          this.#db,
          `UPDATE enrollment_records
             SET invalidated = 1
           WHERE enrollment_id = ? AND sponsor_id = ?
             AND secret_consumed_at IS NULL AND invalidated = 0`,
          replacesEnrollmentId,
          record.sponsorId,
        ),
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
      ]);
      if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) return true;
      throw new EnrollmentError("PAIRING_INVALID");
    } catch (error) {
      if (error instanceof EnrollmentError) throw error;
      const raced = await sql(
        this.#db,
        "SELECT enrollment_id FROM enrollment_records WHERE enrollment_id = ?",
        record.enrollmentId,
      ).first<{ enrollment_id: string }>();
      if (raced !== null) return false;
      throw new EnrollmentError("PAIRING_INVALID");
    }
  }

  async claim(attempt: ClaimAttempt): Promise<void> {
    try {
      const results = await this.#db.batch([
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
      ]);
      if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) return;
    } catch {
      // The safe classification below deliberately drops the database detail.
    }

    throw new EnrollmentError("PAIRING_INVALID");
  }

  async verifyClaimCredentials(
    enrollmentId: string,
    secretHash: string,
    now: number,
  ): Promise<void> {
    const row = await sql(
      this.#db,
      `SELECT enrollment_id, sponsor_id, secret_hash, secret_expires_at,
              requested_scopes_json, requested_resources_json, invalidated, secret_consumed_at
         FROM enrollment_records WHERE enrollment_id = ?`,
      enrollmentId,
    ).first<RecordRow>();
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

  async decision(attempt: DecisionAttempt): Promise<void> {
    const row = await this.proposalByEnrollment(attempt.enrollmentId, attempt.sponsorId);
    if (row === null) throw new EnrollmentError("WRONG_PRINCIPAL");
    if (row.status !== "pending") throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    if (attempt.now >= row.expires_at) {
      await sql(
        this.#db,
        "UPDATE enrollment_proposals SET status = 'expired' WHERE proposal_id = ? AND status = 'pending'",
        row.proposal_id,
      ).run();
      throw new EnrollmentError("PROPOSAL_EXPIRED");
    }

    if (attempt.decision.decision === "deny") {
      const result = await sql(
        this.#db,
        `UPDATE enrollment_proposals SET status = 'denied'
           WHERE proposal_id = ? AND status = 'pending' AND expires_at > ?`,
        row.proposal_id,
        attempt.now,
      ).run();
      if (result.meta.changes === 1) return;
      throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    }

    const requested = requestedRecord(row);
    const { scopes, resources } = this.reducedGrant(requested, attempt.decision, attempt.now);
    const nextStatus = attempt.decision.decision === "approve" ? "approved" : "reduced";
    try {
      const results = await this.#db.batch([
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
      ]);
      if (
        results[0]?.meta.changes === 1 &&
        results[1]?.meta.changes === 1 &&
        results[2]?.meta.changes === 1
      ) {
        return;
      }
      throw new EnrollmentError("PROPOSAL_NOT_PENDING");
    } catch (error) {
      if (error instanceof EnrollmentError) throw error;
      if (isUniqueNameFailure(error)) throw new EnrollmentError("NAME_TAKEN");
      throw new EnrollmentError("PROPOSAL_NOT_PENDING");
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
        await sql(
          this.#db,
          "UPDATE enrollment_proposals SET status = 'expired' WHERE proposal_id = ? AND status = 'pending'",
          row.proposal_id,
        ).run();
        return { kind: "expired" };
      }
      if (row.status === "pending") {
        const pacing = nextEnrollmentPollPacing({
          lastPollAt: row.last_poll_at ?? undefined,
          pollIntervalSeconds: row.poll_interval_seconds,
          now: attempt.now,
        });
        const changed = await sql(
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
        ).run();
        if (changed.meta.changes !== 1) continue;
        return pacing.kind === "slow-down"
          ? { kind: "slow-down", retryAfterSeconds: pacing.retryAfterSeconds }
          : { kind: "pending", retryAfterSeconds: pacing.retryAfterSeconds };
      }
      if (row.status === "denied") return { kind: "denied" };
      if (row.status === "expired") return { kind: "expired" };
      if (row.token_hash !== null) return { kind: "already-issued" };

      const issued = await attempt.createToken();
      try {
        const results = await this.#db.batch([
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
            `INSERT INTO enrollment_credentials (
               credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
               granted_scopes_json, granted_resources_json, issued_at
             ) SELECT ?, p.proposal_id, g.fellow_id, g.sponsor_id, ?,
                      g.granted_scopes_json, g.granted_resources_json, ?
                 FROM enrollment_proposals p
                 JOIN enrollment_grants g ON g.proposal_id = p.proposal_id
                WHERE p.proposal_id = ? AND changes() = 1`,
            `cred-${row.proposal_id}`,
            issued.tokenHash,
            attempt.now,
            row.proposal_id,
          ),
        ]);
        if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
          return { kind: "issued", token: issued.token };
        }
      } catch {
        // A winner may have committed first; re-read below without disclosing SQL detail.
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
    const suggestions: string[] = [];
    for (let index = 2; suggestions.length < 3 && index < 10_000; index += 1) {
      const candidate = `${safeStem}-${index}`.slice(0, 32).replace(/-+$/g, "");
      if (enrollmentNameFailure(candidate) !== undefined) continue;
      const held = await sql(
        this.#db,
        "SELECT fellow_id FROM enrollment_fellows WHERE name = ? COLLATE NOCASE",
        candidate,
      ).first<{ fellow_id: string }>();
      if (held === null) suggestions.push(candidate);
    }
    return suggestions;
  }

  async credentialByTokenHash(tokenHash: string): Promise<FellowCredentialBinding | undefined> {
    const row = await sql(
      this.#db,
      `SELECT c.fellow_id, c.credential_id, c.sponsor_id, f.name, f.model, f.harness,
              c.granted_scopes_json, c.granted_resources_json, c.token_hash, c.issued_at
         FROM enrollment_credentials c
         JOIN enrollment_fellows f ON f.fellow_id = c.fellow_id
        WHERE c.token_hash = ?`,
      tokenHash,
    ).first<CredentialRow>();
    if (row === null) return undefined;
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
    };
  }

  async beginIdempotency(attempt: IdempotencyAttempt): Promise<IdempotencyResult> {
    const existing = await sql(
      this.#db,
      `SELECT request_digest, response_ciphertext, response_initialization_vector, expires_at
         FROM enrollment_idempotency
        WHERE scope = ? AND principal_scope = ? AND idempotency_key = ?`,
      attempt.scope,
      attempt.principalScope,
      attempt.key,
    ).first<IdempotencyRow>();
    if (existing !== null && attempt.now < existing.expires_at) {
      return secretSafeEqual(existing.request_digest, attempt.digest) ? "replay" : "conflict";
    }
    if (existing !== null) {
      const refreshed = await sql(
        this.#db,
        `UPDATE enrollment_idempotency
            SET request_digest = ?, response_ciphertext = ?, response_initialization_vector = ?, expires_at = ?
          WHERE scope = ? AND principal_scope = ? AND idempotency_key = ? AND expires_at <= ?`,
        attempt.digest,
        "",
        "",
        attempt.now + 24 * 60 * 60 * 1_000,
        attempt.scope,
        attempt.principalScope,
        attempt.key,
        attempt.now,
      ).run();
      if (refreshed.meta.changes === 1) return "new";
      return "conflict";
    }
    try {
      await sql(
        this.#db,
        `INSERT INTO enrollment_idempotency (
           scope, principal_scope, idempotency_key, request_digest,
           response_ciphertext, response_initialization_vector, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        attempt.scope,
        attempt.principalScope,
        attempt.key,
        attempt.digest,
        "",
        "",
        attempt.now + 24 * 60 * 60 * 1_000,
      ).run();
      return "new";
    } catch {
      return "conflict";
    }
  }

  async idempotencyReplay(
    attempt: IdempotencyAttempt,
  ): Promise<EnrollmentIdempotencyReplay | undefined> {
    const row = await sql(
      this.#db,
      `SELECT request_digest, response_ciphertext, response_initialization_vector, expires_at
         FROM enrollment_idempotency
        WHERE scope = ? AND principal_scope = ? AND idempotency_key = ? AND expires_at > ?`,
      attempt.scope,
      attempt.principalScope,
      attempt.key,
      attempt.now,
    ).first<IdempotencyRow>();
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
