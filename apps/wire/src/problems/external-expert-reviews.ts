/**
 * Operator-audited ExternalExpertReviewRecord storage & lookup (Fable §6.2 &
 * 2026-11-02 decision; bead nkz2).
 *
 * Famous problems (`famous_guardrail IS NOT NULL`) cannot resolve on bare
 * caller-supplied prose. An operator records a verifiable, attributed external
 * expert review record anchored to the exact `(claim_id, claim_version,
 * content_digest)` and `no_claim_boundary`, and `prepareProblemResolution`
 * binds that exact unrevoked row into its atomic terminal SQL guard.
 */

import {
  type ExternalExpertReviewCreateRequest,
  ExternalExpertReviewCreateRequestSchema,
  ExternalExpertReviewIdPattern,
  type ExternalExpertReviewRecord,
  ExternalExpertReviewRecordSchema,
  type ProblemNoClaimBoundary,
  ProblemNoClaimBoundarySchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson, sha256Hex } from "../krater/krater.ts";
import { scanFieldsForCredentials } from "../screening/credential-scan.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function mintExternalReviewId(): string {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return `EER-${out}`;
}

interface ExternalReviewRow {
  review_record_id: string;
  problem_id: string;
  claim_id: string;
  claim_version: number;
  claim_content_digest: string;
  reviewer_name: string;
  reviewer_affiliation: string;
  reviewer_identifier: string;
  attestation_locator: string;
  attestation_sha256: string;
  verdict: "supports-resolution" | "withheld" | "rejects-resolution";
  reviewed_at: string;
  no_claim_boundary_json: string;
  verified_by_operator_id: string;
  created_at: string;
  revoked_at: string | null;
}

function rowToRecord(row: ExternalReviewRow): ExternalExpertReviewRecord {
  return ExternalExpertReviewRecordSchema.parse({
    review_record_id: row.review_record_id,
    problem_id: row.problem_id,
    claim_id: row.claim_id,
    claim_version: row.claim_version,
    claim_content_digest: row.claim_content_digest,
    reviewer: {
      name: row.reviewer_name,
      affiliation: row.reviewer_affiliation,
      identifier: row.reviewer_identifier,
    },
    attestation_locator: row.attestation_locator,
    attestation_sha256: row.attestation_sha256,
    verdict: row.verdict,
    reviewed_at: row.reviewed_at,
    no_claim_boundary: ProblemNoClaimBoundarySchema.parse(JSON.parse(row.no_claim_boundary_json)),
    verified_by_operator_id: row.verified_by_operator_id,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  });
}

export type RecordExternalReviewResult =
  | { readonly ok: true; readonly record: ExternalExpertReviewRecord }
  | {
      readonly ok: false;
      readonly status: 404 | 422;
      readonly code:
        | "PROBLEM_NOT_FOUND"
        | "CLAIM_NOT_FOUND"
        | "SCHEMA_INVALID"
        | "SECRET_SHAPED_CONTENT";
      readonly detail: string;
    };

export async function recordExternalExpertReview(
  db: D1Database,
  problemId: string,
  operatorId: string,
  rawInput: unknown,
): Promise<RecordExternalReviewResult> {
  const parsed = ExternalExpertReviewCreateRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      code: "SCHEMA_INVALID",
      detail: "External expert review record payload does not match the contract.",
    };
  }
  const input: ExternalExpertReviewCreateRequest = parsed.data;
  const boundaryJson = canonicalJson(input.no_claim_boundary);

  // P7 / Rule A9 hard egress wall: never store credential-shaped material in review records.
  const credentialHits = scanFieldsForCredentials({
    reviewer_name: input.reviewer.name,
    reviewer_affiliation: input.reviewer.affiliation,
    reviewer_identifier: input.reviewer.identifier,
    attestation_locator: input.attestation_locator,
    no_claim_boundary_json: boundaryJson,
  });
  if (credentialHits.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "SECRET_SHAPED_CONTENT",
      detail: "External expert review fields contain credential-shaped text and were refused.",
    };
  }

  const problem = await db
    .prepare("SELECT id, status FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ id: string; status: string }>();
  if (!problem || problem.status === "private-draft") {
    return {
      ok: false,
      status: 404,
      code: "PROBLEM_NOT_FOUND",
      detail: `No published problem with id '${problemId}' exists.`,
    };
  }

  const claimVersion = await db
    .prepare(
      `SELECT cv.content_digest
       FROM claim_versions cv
       WHERE cv.problem_id = ? AND cv.claim_id = ? AND cv.version = ?
         AND NOT EXISTS (
           SELECT 1 FROM retractions r
           WHERE r.problem_id = cv.problem_id
             AND r.target_object IN (cv.claim_id, cv.claim_id || '@' || cv.version)
         )
         AND NOT EXISTS (
           SELECT 1 FROM events e
           JOIN event_content ec ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
           WHERE e.problem_id = cv.problem_id
             AND e.object_kind = 'claim'
             AND e.object_id = cv.claim_id
             AND e.object_version = cv.version
             AND ec.redacted_at IS NOT NULL
         )`,
    )
    .bind(problemId, input.claim_id, input.claim_version)
    .first<{ content_digest: string | null }>();
  if (!claimVersion?.content_digest) {
    return {
      ok: false,
      status: 404,
      code: "CLAIM_NOT_FOUND",
      detail: `No active canonical claim version ${input.claim_id}@${input.claim_version} exists on problem '${problemId}'.`,
    };
  }

  const reviewRecordId = mintExternalReviewId();
  const createdAt = new Date().toISOString();
  const record = ExternalExpertReviewRecordSchema.parse({
    review_record_id: reviewRecordId,
    problem_id: problemId,
    claim_id: input.claim_id,
    claim_version: input.claim_version,
    claim_content_digest: claimVersion.content_digest,
    reviewer: input.reviewer,
    attestation_locator: input.attestation_locator,
    attestation_sha256: input.attestation_sha256,
    verdict: input.verdict,
    reviewed_at: input.reviewed_at,
    no_claim_boundary: input.no_claim_boundary,
    verified_by_operator_id: operatorId,
    created_at: createdAt,
    revoked_at: null,
  });
  const afterStateDigest = await sha256Hex(canonicalJson(record));
  const auditEventId = `OA-${reviewRecordId.slice(4)}`;
  const auditTarget = `${problemId}/${input.claim_id}@${input.claim_version}`.slice(0, 128);
  const auditReason =
    `Recorded external expert review ${reviewRecordId} (${input.verdict}) anchored to ${claimVersion.content_digest}.`.slice(
      0,
      1000,
    );

  // Atomically commit both the structured review record and its immutable
  // operator_audit row ONLY IF the published problem and active, non-retracted,
  // non-redacted claim version still hold at commit time.
  const batchResults = await db.batch([
    db
      .prepare(
        `INSERT INTO external_expert_reviews
           (review_record_id, problem_id, claim_id, claim_version, claim_content_digest,
            reviewer_name, reviewer_affiliation, reviewer_identifier,
            attestation_locator, attestation_sha256, verdict, reviewed_at,
            no_claim_boundary_json, verified_by_operator_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM problems p
           JOIN claim_versions cv ON cv.problem_id = p.id
           WHERE p.id = ?
             AND p.status <> 'private-draft'
             AND cv.claim_id = ?
             AND cv.version = ?
             AND cv.content_digest = ?
             AND NOT EXISTS (
               SELECT 1 FROM retractions r
               WHERE r.problem_id = cv.problem_id
                 AND r.target_object IN (cv.claim_id, cv.claim_id || '@' || cv.version)
             )
             AND NOT EXISTS (
               SELECT 1 FROM events e
               JOIN event_content ec ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
               WHERE e.problem_id = cv.problem_id
                 AND e.object_kind = 'claim'
                 AND e.object_id = cv.claim_id
                 AND e.object_version = cv.version
                 AND ec.redacted_at IS NOT NULL
             )
         )`,
      )
      .bind(
        reviewRecordId,
        problemId,
        input.claim_id,
        input.claim_version,
        claimVersion.content_digest,
        input.reviewer.name,
        input.reviewer.affiliation,
        input.reviewer.identifier,
        input.attestation_locator,
        input.attestation_sha256,
        input.verdict,
        input.reviewed_at,
        boundaryJson,
        operatorId,
        createdAt,
        problemId,
        input.claim_id,
        input.claim_version,
        claimVersion.content_digest,
      ),
    db
      .prepare(
        `INSERT INTO operator_audit
           (event_id, seq, operator_id, action, target_id, reason, before_state_digest, after_state_digest, created_at)
         SELECT ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM operator_audit), ?, ?, ?, ?, NULL, ?, ?
         WHERE EXISTS (SELECT 1 FROM external_expert_reviews WHERE review_record_id = ?)`,
      )
      .bind(
        auditEventId,
        operatorId,
        "external-expert-review-recorded",
        auditTarget,
        auditReason,
        afterStateDigest,
        createdAt,
        reviewRecordId,
      ),
  ]);

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    return {
      ok: false,
      status: 404,
      code: "CLAIM_NOT_FOUND",
      detail: `Claim version ${input.claim_id}@${input.claim_version} on problem '${problemId}' is no longer active.`,
    };
  }

  return { ok: true, record };
}

export async function listExternalExpertReviews(
  db: D1Database,
  problemId: string,
): Promise<ExternalExpertReviewRecord[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM external_expert_reviews
       WHERE problem_id = ?
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(problemId)
    .all<ExternalReviewRow>();
  return rows.results.map(rowToRecord);
}

/** Verify a stored operator-audited external expert review record against the
 * exact claim version, content digest, verdict, and no-claim boundary. */
export async function findVerifiedExternalExpertReview(
  db: D1Database,
  input: {
    readonly reviewRecordId: string;
    readonly problemId: string;
    readonly claimId: string;
    readonly claimVersion: number;
    readonly claimContentDigest: string;
    readonly noClaimBoundary: ProblemNoClaimBoundary;
  },
): Promise<{ readonly record: ExternalExpertReviewRecord; readonly boundaryJson: string } | null> {
  if (!ExternalExpertReviewIdPattern.test(input.reviewRecordId)) return null;
  let row: ExternalReviewRow | null;
  try {
    row = await db
      .prepare(
        `SELECT eer.* FROM external_expert_reviews eer
         WHERE eer.review_record_id = ? AND eer.problem_id = ?
           AND eer.claim_id = ? AND eer.claim_version = ?
           AND eer.claim_content_digest = ?
           AND eer.verdict = 'supports-resolution'
           AND eer.revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM retractions r
             WHERE r.problem_id = eer.problem_id
               AND r.target_object IN (eer.claim_id, eer.claim_id || '@' || eer.claim_version)
           )
           AND NOT EXISTS (
             SELECT 1 FROM events e
             JOIN event_content ec ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
             WHERE e.problem_id = eer.problem_id
               AND e.object_kind = 'claim'
               AND e.object_id = eer.claim_id
               AND e.object_version = eer.claim_version
               AND ec.redacted_at IS NOT NULL
           )`,
      )
      .bind(
        input.reviewRecordId,
        input.problemId,
        input.claimId,
        input.claimVersion,
        input.claimContentDigest,
      )
      .first<ExternalReviewRow>();
  } catch {
    return null;
  }
  if (!row) return null;
  const record = rowToRecord(row);
  if (canonicalJson(record.no_claim_boundary) !== canonicalJson(input.noClaimBoundary)) {
    return null;
  }
  return { record, boundaryJson: row.no_claim_boundary_json };
}
