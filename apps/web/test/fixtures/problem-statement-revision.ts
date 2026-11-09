import type {
  ProblemStatementProposalListResponse,
  ProblemStatementRevisionPreview,
  ProblemStatementRevisionResponse,
} from "@asimposium/contracts";
import type { StatementRevisionReceipt } from "../../lib/problem-statement-proposals";
import type { StatementRevisionCommand } from "../../lib/problem-statement-revision";

export const revisionSponsor = "usr_revision_sponsor";
export const revisionProblem = "P-STATEMENT-REVISION";
export const revisionId = "SPR-12345678-1234-1234-1234-123456789abc";
export const revisionPreview: ProblemStatementRevisionPreview = {
  problem: {
    id: revisionProblem,
    title: "Finite paths under exact assumptions",
    status: "active",
    current_statement_version: 3,
  },
  proposal: {
    proposal_id: revisionId,
    problem_id: revisionProblem,
    base_statement_version: 3,
    statement:
      "PRIVATE_REVISION_STATEMENT Every nonempty finite forest has an endpoint.\n<script>untrusted()</script>",
    falsifier: "PRIVATE_REVISION_FALSIFIER A nonempty finite forest with no endpoint.",
    motivation: "PRIVATE_REVISION_MOTIVATION State the finite boundary precisely.",
    scope: "PRIVATE_REVISION_SCOPE Finite forests.\n<img src=x onerror=unsafe()>",
    out_of_scope: "PRIVATE_REVISION_EXCLUSIONS Infinite trees and cyclic graphs.",
    success_criteria: "PRIVATE_REVISION_SUCCESS A complete argument or a finite counterexample.",
    author: {
      fellow_id: `F-${"a".repeat(26)}`,
      sponsor_id: "usr_original_sponsor",
      session_id: `S-${"b".repeat(26)}`,
      model_self_declared: "fixture/research-model",
      harness: "fixture-harness",
    },
    created_at: "2026-11-09T12:00:00.000Z",
    status: "pending",
    accepted_statement_version: null,
  },
  acting_sponsor_id: revisionSponsor,
  can_accept: true,
  review_digest: "b".repeat(64),
};
export const revisionCommand: StatementRevisionCommand = {
  action: "revise-statement",
  proposal_id: revisionId,
  reviewed_statement_version: 3,
  reviewed_digest: revisionPreview.review_digest,
};
export const revisionPage: ProblemStatementProposalListResponse = {
  problem_id: revisionProblem,
  acting_sponsor_id: revisionSponsor,
  proposals: [
    {
      proposal_id: revisionId,
      base_statement_version: 3,
      author: revisionPreview.proposal.author,
      created_at: revisionPreview.proposal.created_at,
      status: "pending",
      accepted_statement_version: null,
    },
  ],
  next_after: null,
  omitted: [],
};
export const revisionWireReceipt: ProblemStatementRevisionResponse = {
  problem: {
    id: revisionProblem,
    status: "active",
    current_statement_version: 4,
    updated_at: "2026-11-09T12:01:00.000Z",
  },
  statement_revision: {
    proposal_id: revisionId,
    reviewed_digest: revisionPreview.review_digest,
    base_statement_version: 3,
    accepted_statement_version: 4,
    source_fellow_id: revisionPreview.proposal.author.fellow_id,
    event_id: "event-statement-accepted",
  },
};
export const revisionReceipt: StatementRevisionReceipt = {
  problem: {
    id: revisionProblem,
    status: "active",
    current_statement_version: 4,
    updated_at: revisionWireReceipt.problem.updated_at,
  },
  statement_revision: revisionWireReceipt.statement_revision,
};
