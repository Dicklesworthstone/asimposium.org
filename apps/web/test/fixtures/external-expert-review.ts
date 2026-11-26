import type { ExternalExpertReviewCreateRequest, ExternalExpertReviewRecord } from "@asimposium/contracts";

export const externalReviewOperator = "usr_1234567890abcdef";
export const externalReviewProblem = "P-EXTERNAL";
export const externalReviewInput: ExternalExpertReviewCreateRequest = {
  claim_id: "C-3",
  claim_version: 2,
  reviewer: { name: "Independent Reviewer", affiliation: "Example Institute", identifier: "https://example.org/reviewer" },
  attestation_locator: "https://example.org/review/v2",
  attestation_sha256: "a".repeat(64),
  verdict: "supports-resolution",
  reviewed_at: "2026-11-26T12:00:00.000Z",
  no_claim_boundary: {
    verified: ["Only the exact finite-domain result."],
    mechanisms: ["Independent review of the full write-up."],
    independence_tiers: ["T2"],
    remaining_external_validation: ["A formal-kernel check remains outstanding."],
  },
};
export const externalReviewRecord: ExternalExpertReviewRecord = {
  ...externalReviewInput,
  review_record_id: "EER-00000000000000000000000001",
  problem_id: externalReviewProblem,
  claim_content_digest: "sha256:" + "b".repeat(64),
  verified_by_operator_id: externalReviewOperator,
  created_at: "2026-11-26T12:30:00.000Z",
  revoked_at: null,
};
