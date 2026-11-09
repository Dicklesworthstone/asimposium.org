import "server-only";

import {
  ProblemStatementProposalListQuerySchema,
  type ProblemStatementProposalListResponse,
  ProblemStatementProposalListResponseSchema,
  type ProblemStatementRevisionPreview,
  ProblemStatementRevisionPreviewSchema,
  type ProblemStatementRevisionResponse,
  ProblemStatementRevisionResponseSchema,
} from "@asimposium/contracts";
import {
  parseStatementRevisionCommand,
  type StatementRevisionCommand,
  validStatementProposalId,
  validStatementRevisionKey,
  validStatementRevisionProblem,
} from "./problem-statement-revision";
import { callStoa, type StoaCall } from "./stoa";

export const MAX_STATEMENT_REVISION_PREVIEW_BYTES = 524_288;

/** Initial acceptance and replay both carry metadata, never private formulation bytes. */
export type StatementRevisionReceipt = ProblemStatementRevisionResponse;

export type StatementRevisionActionResult =
  | { readonly ok: true; readonly receipt: StatementRevisionReceipt }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryable: boolean;
      readonly retainAttempt?: true;
      readonly refreshRequired?: true;
    };

export function stoaStatementProposals(
  sponsorId: string,
  problemId: string,
  query: { readonly after?: string } = {},
): Promise<StoaCall<ProblemStatementProposalListResponse>> {
  const parsed = ProblemStatementProposalListQuerySchema.safeParse(query);
  if (!validStatementRevisionProblem(problemId) || !parsed.success)
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  const route = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/statement-proposals${
    parsed.data.after === undefined ? "" : `/after/${encodeURIComponent(parsed.data.after)}`
  }`;
  return callStoa({
    method: "GET",
    route,
    path: route,
    action: "problem-statement-proposals",
    principalId: sponsorId,
    body: "",
    responseMaxBytes: 131_072,
    parse: (value) => {
      const page = ProblemStatementProposalListResponseSchema.parse(value);
      let previous = parsed.data.after ?? "";
      for (const item of page.proposals) {
        if (item.proposal_id <= previous)
          throw new Error("Proposal page does not advance its cursor");
        previous = item.proposal_id;
      }
      if (
        page.problem_id !== problemId ||
        page.acting_sponsor_id !== sponsorId ||
        (page.next_after !== null &&
          (page.proposals.length === 0 || page.next_after !== previous)) ||
        (page.next_after !== null) !== page.omitted.includes("page_limit")
      )
        throw new Error("Proposal page does not match its signed target and continuation");
      return page;
    },
  });
}

export function stoaStatementRevisionPreview(
  sponsorId: string,
  problemId: string,
  proposalId: string,
): Promise<StoaCall<ProblemStatementRevisionPreview>> {
  if (!validStatementRevisionProblem(problemId) || !validStatementProposalId(proposalId))
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  const path = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/statement-proposals/${encodeURIComponent(proposalId)}`;
  return callStoa({
    method: "GET",
    route: path,
    path,
    action: "problem-statement-proposal-preview",
    principalId: sponsorId,
    body: "",
    responseMaxBytes: MAX_STATEMENT_REVISION_PREVIEW_BYTES,
    parse: (value) => {
      const preview = ProblemStatementRevisionPreviewSchema.parse(value);
      const proposal = preview.proposal;
      if (
        preview.problem.id !== problemId ||
        proposal.problem_id !== problemId ||
        preview.acting_sponsor_id !== sponsorId ||
        proposal.proposal_id !== proposalId ||
        (proposal.status === "pending"
          ? proposal.accepted_statement_version !== null
          : proposal.accepted_statement_version !== proposal.base_statement_version + 1) ||
        (preview.can_accept &&
          (proposal.status !== "pending" ||
            proposal.base_statement_version !== preview.problem.current_statement_version))
      )
        throw new Error("Revision preview does not match the exact authorized candidate");
      return preview;
    },
  });
}

/** Replay goes directly to the writer; a changed preview cannot erase the original receipt. */
export function stoaAcceptStatementRevision(
  sponsorId: string,
  problemId: string,
  input: StatementRevisionCommand,
  idempotencyKey: string,
): Promise<StoaCall<StatementRevisionReceipt>> {
  const command = parseStatementRevisionCommand(input);
  if (
    !validStatementRevisionProblem(problemId) ||
    !command ||
    !validStatementRevisionKey(idempotencyKey)
  )
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  const path = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/lifecycle`;
  return callStoa({
    method: "POST",
    route: path,
    path,
    action: "problem-lifecycle",
    principalId: sponsorId,
    body: JSON.stringify(command),
    idempotencyKey,
    screenedPublication: true,
    responseMaxBytes: MAX_STATEMENT_REVISION_PREVIEW_BYTES,
    parse: (value) => {
      const receipt = ProblemStatementRevisionResponseSchema.parse(value);
      const accepted = receipt.statement_revision;
      if (
        receipt.problem.id !== problemId ||
        !accepted ||
        accepted.proposal_id !== command.proposal_id ||
        accepted.reviewed_digest !== command.reviewed_digest ||
        accepted.base_statement_version !== command.reviewed_statement_version ||
        accepted.accepted_statement_version !== command.reviewed_statement_version + 1 ||
        receipt.problem.current_statement_version !== accepted.accepted_statement_version
      )
        throw new Error("Revision receipt does not match the exact reviewed candidate");
      return {
        problem: {
          id: receipt.problem.id,
          status: receipt.problem.status,
          current_statement_version: receipt.problem.current_statement_version,
          updated_at: receipt.problem.updated_at,
        },
        statement_revision: accepted,
      };
    },
  });
}
