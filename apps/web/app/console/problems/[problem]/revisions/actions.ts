"use server";

import { auth } from "@/auth";
import {
  type StatementRevisionActionResult,
  stoaAcceptStatementRevision,
} from "@/lib/problem-statement-proposals";
import {
  parseStatementRevisionCommand,
  type StatementRevisionCommand,
  validStatementRevisionKey,
  validStatementRevisionProblem,
} from "@/lib/problem-statement-revision";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

/** The Worker checks current authority, exact candidate and original replay atomically. */
export async function acceptStatementRevision(
  expectedSponsorId: string,
  problemId: string,
  input: StatementRevisionCommand,
  idempotencyKey: string,
  confirmed: boolean,
): Promise<StatementRevisionActionResult> {
  const uncertain: StatementRevisionActionResult = {
    ok: false,
    retryable: true,
    retainAttempt: true,
    message:
      "The statement revision has no confirmed receipt. Retry the unchanged candidate, review digest and key to recover its outcome before accepting another proposal.",
  };
  try {
    const session = await auth();
    const sponsorId = session?.user?.id;
    if (!isCanonicalSponsorId(sponsorId) || sponsorId !== expectedSponsorId)
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        refreshRequired: true,
        message:
          "Your signed-in sponsor account changed or could not be verified. Sign in as the original sponsor and reload; any unresolved acceptance must retain its original retry details.",
      };
    const command = parseStatementRevisionCommand(input);
    if (
      !command ||
      !validStatementRevisionProblem(problemId) ||
      !validStatementRevisionKey(idempotencyKey) ||
      confirmed !== true
    )
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        message:
          "Review the exact Fellow-authored candidate and explicitly confirm its acceptance. An acceptance contains only the candidate identifier, base statement version and review digest.",
      };
    const result = await stoaAcceptStatementRevision(sponsorId, problemId, command, idempotencyKey);
    if (result.ok) return { ok: true, receipt: result.data };
    if (result.reason === "unconfigured")
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        message:
          "Statement revision acceptance is not configured on this deployment. Keep any pending command and key until the connection is available.",
      };
    if (
      result.reason === "refused" &&
      result.status === 409 &&
      result.problemCode === "OBJECT_VERSION_CONFLICT"
    )
      return {
        ok: false,
        retryable: false,
        refreshRequired: true,
        message:
          "The reviewed base statement or proposal changed before this acceptance committed. Reload the current formulation and ask the Fellow for a proposal based on that version.",
      };
    if (result.reason === "refused" && result.status === 409)
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        refreshRequired: true,
        message:
          "This key or problem state conflicts with the submitted acceptance. Keep its exact retry details and inspect the current record before making another decision.",
      };
    if (result.reason === "refused" && [401, 403, 404].includes(result.status ?? 0))
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        refreshRequired: true,
        message:
          "Stoa could not admit this acceptance under current authority and publication checks. Reload under the intended account. This response does not resolve an earlier uncertain attempt.",
      };
    if (
      result.reason === "refused" &&
      result.problemCode !== undefined &&
      [400, 422].includes(result.status ?? 0)
    )
      return {
        ok: false,
        retryable: false,
        refreshRequired: true,
        message:
          "Stoa refused this revision. Review the current statement, candidate and publication requirements before making a new decision. Scientific text must be revised by the Fellow.",
      };
    return uncertain;
  } catch {
    return uncertain;
  }
}
