"use server";

import {
  ProblemGovernanceKeySchema,
  type ProblemStewardshipActionReceipt,
  PublicLedgerProblemIdSchema,
  type SponsorProblemGovernanceQuery,
  SponsorProblemGovernanceQuerySchema,
  type SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";
import { auth } from "@/auth";
import { stoaChangeProblemStewardship, stoaProblemGovernance } from "@/lib/problem-governance";
import {
  type ProblemStewardshipCommand,
  parseProblemStewardshipCommand,
} from "@/lib/problem-stewardship";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export type ProblemStewardshipActionResult =
  | {
      readonly ok: true;
      readonly receipt: ProblemStewardshipActionReceipt;
      readonly current: SponsorProblemGovernanceResponse | null;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly recovery: "retry" | "reload" | "edit";
    };

export async function changeProblemStewardship(
  expectedSponsorId: string,
  problemId: string,
  input: ProblemStewardshipCommand,
  idempotencyKey: string,
  confirmed: boolean,
  query: SponsorProblemGovernanceQuery = {},
): Promise<ProblemStewardshipActionResult> {
  const uncertain: ProblemStewardshipActionResult = {
    ok: false,
    recovery: "retry",
    message:
      "The stewardship change has no confirmed receipt. Keep the exact command and retry key; retrying can recover a completed transfer even after your authority ended.",
  };
  try {
    const session = await auth();
    const principalId = session?.user?.id;
    if (!isCanonicalSponsorId(principalId) || principalId !== expectedSponsorId) {
      return {
        ok: false,
        recovery: "retry",
        message:
          "The signed-in account changed or could not be verified. Sign in as the original sponsor and reload to recover this exact command before making another change.",
      };
    }
    const command = parseProblemStewardshipCommand(input);
    const readQuery = SponsorProblemGovernanceQuerySchema.safeParse(query);
    if (
      !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
      !command ||
      !ProblemGovernanceKeySchema.safeParse(idempotencyKey).success ||
      !readQuery.success
    ) {
      return {
        ok: false,
        recovery: "edit",
        message:
          "Choose an exact sponsor identifier and a stewardship action based on the current roster version.",
      };
    }
    if (
      confirmed !== true ||
      (command.operation === "transfer" && command.target_sponsor_id === principalId)
    ) {
      return {
        ok: false,
        recovery: "edit",
        message:
          "Confirm the exact stewardship change and its consequences. A transfer must name another sponsor.",
      };
    }
    const result = await stoaChangeProblemStewardship(
      principalId,
      problemId,
      command,
      idempotencyKey,
    );
    if (!result.ok) {
      if (result.reason === "unconfigured")
        return {
          ok: false,
          recovery: "edit",
          message: "Stewardship changes are not configured on this deployment.",
        };
      // A malformed refusal is as uncertain as a lost reply. Only canonical
      // teaching errors can release a retained command for a new decision.
      if (result.reason === "refused" && result.problemCode !== undefined) {
        if (result.status === 409)
          return {
            ok: false,
            recovery: "reload",
            message:
              "The reviewed stewardship changed or this retry key belongs to another command. Reload and inspect the current roster before making a new decision.",
          };
        if ([401, 403, 404].includes(result.status ?? 0))
          return {
            ok: false,
            recovery: "reload",
            message:
              "Stoa refused this change under your current authority. Inspect the current problem under the intended account; no new stewardship action was accepted.",
          };
        if ([400, 422].includes(result.status ?? 0))
          return {
            ok: false,
            recovery: "reload",
            message:
              "Stoa refused this stewardship change. A new steward must be an active known sponsor, transfers must name another sponsor, and the final steward cannot be removed. Reload the roster before reviewing a new decision.",
          };
      }
      return uncertain;
    }
    let current: SponsorProblemGovernanceResponse | null = null;
    try {
      const read = await stoaProblemGovernance(principalId, problemId, readQuery.data);
      if (read.ok) current = read.data;
    } catch {
      /* A failed current read does not erase the durable command receipt. */
    }
    return { ok: true, receipt: result.data, current };
  } catch {
    return uncertain;
  }
}
