"use server";

import {
  type ProblemAccessActionReceipt,
  PublicLedgerProblemIdSchema,
  type SponsorProblemGovernanceQuery,
  SponsorProblemGovernanceQuerySchema,
  type SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";
import { auth } from "@/auth";
import {
  parseProblemAccessCommand,
  type ProblemAccessCommand,
  stoaChangeProblemAccess,
  stoaProblemGovernance,
} from "@/lib/problem-governance";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export type ProblemAccessActionResult =
  | { readonly ok: true; readonly receipt: ProblemAccessActionReceipt; readonly current: SponsorProblemGovernanceResponse | null }
  | { readonly ok: false; readonly message: string; readonly retryable: boolean; readonly refreshRequired?: true };

/** Every write gets its principal afresh; no client-side role or ownership claim is authority. */
export async function changeProblemAccess(
  expectedSponsorId: string,
  problemId: string,
  input: ProblemAccessCommand,
  idempotencyKey: string,
  confirmed: boolean,
  query: SponsorProblemGovernanceQuery = {},
): Promise<ProblemAccessActionResult> {
  const uncertain: ProblemAccessActionResult = { ok: false, retryable: true,
    message: "The access change could not be confirmed. Retry the exact retained command and key, or reload the current settings before starting another change." };
  try {
    const session = await auth();
    const principalId = session?.user?.id;
    if (!isCanonicalSponsorId(principalId) || principalId !== expectedSponsorId) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "Your signed-in sponsor account changed or could not be verified. Reload under the intended account before managing access." };
    }
    const command = parseProblemAccessCommand(input);
    const readQuery = SponsorProblemGovernanceQuerySchema.safeParse(query);
    if (!PublicLedgerProblemIdSchema.safeParse(problemId).success ||
        typeof problemId !== "string" || problemId.trim() !== problemId || command === undefined ||
        typeof idempotencyKey !== "string" || /^[A-Za-z0-9._-]{1,160}$/.exec(idempotencyKey)?.[0] !== idempotencyKey ||
        !readQuery.success) {
      return { ok: false, retryable: false,
        message: "Choose a valid admission mode or one exact Fellow identifier and an explicit observer/contributor role. Removal must not include a replacement role." };
    }
    if (confirmed !== true) {
      return { ok: false, retryable: false,
        message: "Explicitly confirm the admission or membership change and its consequences before submitting." };
    }
    const result = await stoaChangeProblemAccess(principalId, problemId, command, idempotencyKey);
    if (!result.ok) {
      if (result.reason === "unconfigured") return { ok: false, retryable: false,
        message: "Problem access controls are not configured on this deployment." };
      if (result.reason === "refused" && result.status === 409) {
        return { ok: false, retryable: false, refreshRequired: true,
          message: "The problem state changed or this key belongs to another command. Reload the current settings and review them before making another change." };
      }
      if (result.reason === "refused" && [401, 403, 404].includes(result.status ?? 0)) {
        return { ok: false, retryable: false, refreshRequired: true,
          message: "Stoa could not confirm your current owner or steward authority for this problem. Sign in to the intended account and reload." };
      }
      if (result.reason === "refused" && [400, 422].includes(result.status ?? 0)) {
        return { ok: false, retryable: false, refreshRequired: true,
          message: "Stoa refused the access change. Verify the problem is editable and the exact Fellow identifier exists, then reload the current settings." };
      }
      return uncertain;
    }
    let current: SponsorProblemGovernanceResponse | null = null;
    try {
      const read = await stoaProblemGovernance(principalId, problemId, readQuery.data);
      if (read.ok) current = read.data;
    } catch { /* The accepted command receipt remains authoritative if its separate read fails. */ }
    return { ok: true, receipt: result.data, current };
  } catch {
    return uncertain;
  }
}
