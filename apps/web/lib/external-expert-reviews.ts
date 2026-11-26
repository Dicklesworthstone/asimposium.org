import "server-only";

import {
  ExternalExpertReviewCreateRequestSchema,
  ExternalExpertReviewRecordSchema,
  PublicLedgerProblemIdSchema,
  type ExternalExpertReviewCreateRequest,
  type ExternalExpertReviewRecord,
} from "@asimposium/contracts";
import { callStoa, type StoaCall } from "./stoa";

function validProblem(problemId: string): boolean {
  return typeof problemId === "string" && problemId.trim() === problemId &&
    PublicLedgerProblemIdSchema.safeParse(problemId).success;
}

/** Private operator inspection never substitutes for scientific admission. */
export function stoaExternalExpertReviews(
  operatorId: string,
  problemId: string,
): Promise<StoaCall<readonly ExternalExpertReviewRecord[]>> {
  if (!validProblem(problemId)) return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  const path = "/v1/operators/problems/" + encodeURIComponent(problemId) + "/external-expert-reviews";
  return callStoa({
    method: "GET", route: path, path, action: "operator.external-expert-reviews.list",
    principalId: operatorId, principalType: "operator", body: "", responseMaxBytes: 1_048_576,
    parse: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "problem_id,reviews")
        throw new Error("Invalid external review list");
      const data = value as { problem_id: unknown; reviews: unknown };
      if (data.problem_id !== problemId || !Array.isArray(data.reviews) || data.reviews.length > 50)
        throw new Error("External review scope mismatch");
      const records = data.reviews.map((record) => ExternalExpertReviewRecordSchema.parse(record));
      if (records.some((record) => record.problem_id !== problemId) ||
          new Set(records.map((record) => record.review_record_id)).size !== records.length)
        throw new Error("External review record mismatch");
      return records;
    },
  });
}

/** Send the exact reviewed payload and retry key, then match the entire receipt. */
export function stoaRecordExternalExpertReview(
  operatorId: string,
  problemId: string,
  input: ExternalExpertReviewCreateRequest,
  idempotencyKey: string,
): Promise<StoaCall<ExternalExpertReviewRecord>> {
  const parsed = ExternalExpertReviewCreateRequestSchema.safeParse(input);
  if (!validProblem(problemId) || !parsed.success || typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey) || idempotencyKey.trim() !== idempotencyKey)
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  const path = "/v1/operators/problems/" + encodeURIComponent(problemId) + "/external-expert-reviews";
  return callStoa({
    method: "POST", route: path, path, action: "operator.external-expert-reviews.create",
    principalId: operatorId, principalType: "operator", body: JSON.stringify(parsed.data),
    idempotencyKey, responseMaxBytes: 262_144,
    parse: (value) => {
      const record = ExternalExpertReviewRecordSchema.parse(value);
      const requested = ExternalExpertReviewCreateRequestSchema.parse({
        claim_id: record.claim_id, claim_version: record.claim_version, reviewer: record.reviewer,
        attestation_locator: record.attestation_locator, attestation_sha256: record.attestation_sha256,
        verdict: record.verdict, reviewed_at: record.reviewed_at, no_claim_boundary: record.no_claim_boundary,
      });
      if (record.problem_id !== problemId || record.verified_by_operator_id !== operatorId ||
          JSON.stringify(requested) !== JSON.stringify(parsed.data))
        throw new Error("External review receipt does not match the confirmed attestation");
      return record;
    },
  });
}
