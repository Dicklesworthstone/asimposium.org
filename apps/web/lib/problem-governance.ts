import "server-only";

import {
  type ProblemAccessActionReceipt,
  ProblemAccessActionReceiptSchema,
  type ProblemLifecycleActionRequest,
  ProblemLifecycleActionRequestSchema,
  PublicLedgerProblemIdSchema,
  type SponsorProblemGovernanceQuery,
  SponsorProblemGovernanceQuerySchema,
  type SponsorProblemGovernanceResponse,
  SponsorProblemGovernanceResponseSchema,
} from "@asimposium/contracts";
import { callStoa, type StoaCall } from "./stoa";

export type ProblemAccessCommand = Extract<ProblemLifecycleActionRequest,
  { action: "set-admission-mode" | "manage-member" }>;

export function parseProblemAccessCommand(input: unknown): ProblemAccessCommand | undefined {
  const parsed = ProblemLifecycleActionRequestSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const command = parsed.data;
  if (command.action === "set-admission-mode") return command;
  if (command.action !== "manage-member" ||
      (command.operation === "set-role" ? command.role === undefined : command.role !== undefined)) return undefined;
  return command;
}

function validProblem(problemId: string): boolean {
  return PublicLedgerProblemIdSchema.safeParse(problemId).success &&
    typeof problemId === "string" && problemId.trim() === problemId;
}

/** One bounded member page under current problem-owner or steward authority. */
export function stoaProblemGovernance(
  principalId: string,
  problemId: string,
  query: SponsorProblemGovernanceQuery = {},
): Promise<StoaCall<SponsorProblemGovernanceResponse>> {
  const parsed = SponsorProblemGovernanceQuerySchema.safeParse(query);
  if (!validProblem(problemId) || !parsed.success) {
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  }
  const after = parsed.data.after;
  const route = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/governance${after === undefined ? "" : `/after/${encodeURIComponent(after)}`}`;
  return callStoa({
    method: "GET", route, path: route,
    action: "problem-governance-read", principalId, body: "", responseMaxBytes: 262_144,
    parse: (value) => {
      const page = SponsorProblemGovernanceResponseSchema.parse(value);
      if (page.problem.id !== problemId || page.acting_sponsor_id !== principalId ||
          (after !== undefined && page.members.some((member) => member.fellow_id <= after))) {
        throw new Error("Problem governance page does not match the signed target and cursor.");
      }
      return page;
    },
  });
}

/** A success must contain the exact committed command, including its target member. */
export function stoaChangeProblemAccess(
  principalId: string,
  problemId: string,
  input: ProblemAccessCommand,
  idempotencyKey: string,
): Promise<StoaCall<ProblemAccessActionReceipt>> {
  const command = parseProblemAccessCommand(input);
  if (!validProblem(problemId) || command === undefined ||
      typeof idempotencyKey !== "string" || /^[A-Za-z0-9._-]{1,160}$/.exec(idempotencyKey)?.[0] !== idempotencyKey) {
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  }
  const path = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/lifecycle`;
  return callStoa({
    method: "POST", route: path, path, action: "problem-lifecycle", principalId,
    body: JSON.stringify(command), idempotencyKey, responseMaxBytes: 262_144,
    parse: (value) => {
      const receipt = ProblemAccessActionReceiptSchema.parse(
        (value as { governance_action?: unknown } | null)?.governance_action,
      );
      if (receipt.problem_id !== problemId || receipt.acting_sponsor_id !== principalId ||
          (command.action === "set-admission-mode"
            ? receipt.action !== command.action || receipt.mode !== command.mode
            : receipt.action !== command.action || receipt.operation !== command.operation ||
              receipt.target_fellow_id !== command.target_fellow_id ||
              receipt.role !== (command.operation === "remove" ? null : command.role))) {
        throw new Error("Problem access receipt does not match the exact confirmed command.");
      }
      return receipt;
    },
  });
}
