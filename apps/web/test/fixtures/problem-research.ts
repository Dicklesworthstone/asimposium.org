import { ClaimFaceResponseSchema } from "@asimposium/contracts";
import baseClaimFace from "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json";
import type { ResultClaimPreview } from "../../lib/result-claim-view";
import type {
  ProblemResolutionResponse,
  ProblemResultReviewResponse,
  SingleSynthesisResponse,
  SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";
import type { ClosingSynthesisPreview } from "../../lib/problem-research";
import { accessWorkspace } from "./problem-governance";

export const researchSponsor = "usr_1234567890abcdef";
export const researchProblem = "P-RESEARCH";
export const researchBoundary = {
  verified: ["Only the exact finite parity result."],
  mechanisms: ["A recorded refutation attempt and two independent write-up checks."],
  independence_tiers: ["T2"],
  remaining_external_validation: ["No formal-kernel or outside expert review is claimed."],
};
export const researchReviewCommand = {
  action: "enter-result-review", result_claim: { claim_id: "C-3", version: 1 },
} as const;
export const researchWorkspace: SponsorProblemGovernanceResponse = {
  ...accessWorkspace,
  problem: { ...accessWorkspace.problem, id: researchProblem, status: "under-result-review" },
  acting_sponsor_id: researchSponsor,
};
export const researchSynthesis: SingleSynthesisResponse["synthesis"] = {
  synthesis_id: "SYNTH-CLOSING", problem_id: researchProblem, seq: 12, covers_through: 11,
  body_md: "The exact parity result is supported within the stated finite domain. <script>untrusted()</script>",
  anchors: [{ target_kind: "claim", target_id: "C-3", target_version: 1, target_seq: 3 }],
  omitted: ["Unrelated exploratory findings."], selection_policy: "The exact result and its limits.",
  closing_resolution: {
    result_claim: researchReviewCommand.result_claim,
    direction: "affirmed", no_claim_boundary: researchBoundary,
  },
  dropped_single_author_count: 0, authoring_principal: "F-RESEARCH-AUTHOR",
  declared_model: "self-declared-model", sponsor_id: researchSponsor,
  session_id: "S-RESEARCH", harness: "self-declared-harness", created_at: "2026-10-27T00:00:00.000Z",
};
export const researchSynthesisResponse: SingleSynthesisResponse = {
  schema: "https://a.asimposium.org/schemas/syntheses.v1.json",
  synthesis: researchSynthesis,
  staleness: { material_events_since: 0, stale: false },
};
export const researchResolveCommand: ClosingSynthesisPreview["command"] = {
  action: "resolve", direction: "affirmed",
  closing_synthesis: { synthesis_id: researchSynthesis.synthesis_id,
    summary: researchSynthesis.body_md, no_claim_boundary: researchBoundary },
};
export const researchPreview: ClosingSynthesisPreview = {
  synthesis: researchSynthesis, command: researchResolveCommand,
};
const formulation = {
  id: researchProblem, title: "A finite parity problem", current_statement_version: 3,
  statement: "Does the finite parity identity hold?", falsifier: "A mismatched parity class.",
  motivation: "Check the two exhaustive residue classes.", updated_at: "2026-10-27T00:00:00.000Z",
};
const resultClaim = {
  claim_id: "C-3", version: 1, content_digest: `sha256:${"a".repeat(64)}`,
  event_id: "E-RESULT", payload_digest: "b".repeat(64),
};
export const researchReviewReceipt: ProblemResultReviewResponse = {
  problem: { ...formulation, status: "under-result-review", result_claim: resultClaim },
};
export const researchResolutionReceipt: ProblemResolutionResponse = {
  problem: {
    ...formulation, status: "resolved", result_claim: resultClaim,
    resolution_direction: "affirmed", resolution_summary: researchSynthesis.body_md,
    resolution_no_claim_boundary: researchBoundary,
    closing_synthesis: { synthesis_id: researchSynthesis.synthesis_id, event_id: "E-CLOSING",
      seq: 12, payload_digest: "c".repeat(64), covers_through: 11 },
  },
};

export const researchClaimFace = ClaimFaceResponseSchema.parse({
  ...baseClaimFace,
  problem: researchProblem,
  cursor: 12,
  title: "P-RESEARCH — C-3@1",
  claim_state: {
    ...baseClaimFace.claim_state,
    claim_id: "C-3",
    version: 1,
    latest_version: 1,
    directive_disclosure: "satisfied",
  },
  items: [{
    ...baseClaimFace.items[0],
    kind: "claim-detail",
    id: "C-3@1",
    body: JSON.stringify({
      problem: researchProblem,
      claim_id: "C-3",
      version: 1,
      statement: "For every integer $n$, the two parity classes are exhaustive. <script>untrusted()</script>",
      falsifier: "An integer outside the two parity classes.",
      fellow: "F-RESEARCH-AUTHOR",
      sponsor: researchSponsor,
      session: "S-RESEARCH",
      model_self_declared: "self-declared-model",
      harness_self_declared: "self-declared-harness",
    }),
  }],
  next_actions: [],
});
export const researchClaimPreview: ResultClaimPreview = {
  problemId: researchProblem,
  cursor: researchClaimFace.cursor,
  origin: "https://a.asimposium.org",
  state: researchClaimFace.claim_state,
  publication: researchClaimFace.items[0]!,
  command: researchReviewCommand,
};
