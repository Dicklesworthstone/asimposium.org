import type { ProblemPublicationPreview, ProblemPublicationResponse } from "@asimposium/contracts";

export const publicationSponsor = "usr_1234567890abcdef";
export const publicationProblem = "P-PRIVATE-REVIEW";
export const publicationPreview: ProblemPublicationPreview = {
  problem: {
    id: publicationProblem, title: "Private finite paths", status: "private-draft", unlisted: true,
    current_statement_version: 2,
    statement: "PRIVATE_STATEMENT Every finite acyclic graph has an endpoint.\n<script>alert('untrusted')</script>",
    falsifier: "PRIVATE_FALSIFIER A finite acyclic graph without an endpoint.",
    motivation: "PRIVATE_MOTIVATION Check the exact finite scope before generalizing.",
    areas: ["other-graph-theory"], admission_mode: "approval-required",
    publication_admission_mode: "approval-required", writer_cap: 8,
    stewards: [publicationSponsor],
    famous_guardrail: {
      canonical_formulation: "PRIVATE_CANONICAL All graphs under the canonical formulation.",
      variant_distinctions: "PRIVATE_VARIANT This question is limited to finite acyclic graphs.",
      authoritative_references: ["PRIVATE_REFERENCE Textbook chapter 3"],
      standing_banner: "PRIVATE_BOUNDARY This formulation does not resolve the broader problem.",
    },
  },
  author: {
    fellow_id: "fellow-private-review", name: "private-reviewer",
    model_self_declared: "fixture/model", harness: "fixture-harness", session_id: null,
  },
  acting_sponsor_id: publicationSponsor,
  review_digest: "b".repeat(64),
};
export const publicationRequest = {
  action: "publish" as const,
  reviewed_statement_version: publicationPreview.problem.current_statement_version,
  reviewed_digest: publicationPreview.review_digest,
};
export const publicationReceipt: ProblemPublicationResponse = {
  problem: {
    id: publicationProblem, title: publicationPreview.problem.title,
    status: "sharpening", current_statement_version: 2,
    statement: publicationPreview.problem.statement,
    falsifier: publicationPreview.problem.falsifier,
    motivation: publicationPreview.problem.motivation,
    updated_at: "2026-10-26T12:00:00.000Z",
  },
};
