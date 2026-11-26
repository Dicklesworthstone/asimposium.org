"use server";

import {
  ExternalExpertReviewCreateRequestSchema,
  PublicLedgerProblemIdSchema,
  type ExternalExpertReviewCreateRequest,
  type ExternalExpertReviewRecord,
} from "@asimposium/contracts";
import { requireOperatorSession } from "@/lib/admin";
import { stoaRecordExternalExpertReview } from "@/lib/external-expert-reviews";
import { serializeExternalReviewRequest } from "@/lib/external-expert-review-recovery";

export type RecordExternalReviewActionResult =
  | { readonly ok: true; readonly record: ExternalExpertReviewRecord }
  | { readonly ok: false; readonly message: string; readonly retainAttempt: boolean; readonly reauthenticate?: true };

/** The operator records a checked attestation; scientific admission stays separate. */
export async function recordExternalReviewAction(
  expectedOperatorId: string,
  problemId: string,
  input: ExternalExpertReviewCreateRequest,
  idempotencyKey: string,
  confirmed: boolean,
): Promise<RecordExternalReviewActionResult> {
  const uncertain: RecordExternalReviewActionResult = { ok: false, retainAttempt: true,
    message: "The external review record could not be confirmed. Recover the unchanged attestation and retry key before recording another review." };
  try {
    const session = await requireOperatorSession();
    if (session.state !== "authorized" || session.operatorId !== expectedOperatorId)
      return { ok: false, retainAttempt: true, reauthenticate: true,
        message: "Sign in again as the same allowlisted operator. Current operator authority and recent Google authentication are required; keep the pending attestation for recovery." };
    const parsed = ExternalExpertReviewCreateRequestSchema.safeParse(input);
    if (typeof problemId !== "string" || problemId.trim() !== problemId ||
        !PublicLedgerProblemIdSchema.safeParse(problemId).success || !parsed.success ||
        typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey) ||
        idempotencyKey.trim() !== idempotencyKey || confirmed !== true)
      return { ok: false, retainAttempt: true,
        message: "Review an exact claim version, reviewer attribution, permanent attestation reference and digest, verdict, date, and complete no-claim boundary. Confirm that you checked the attestation before recording it." };
    if (serializeExternalReviewRequest(parsed.data) === null)
      return { ok: false, retainAttempt: true,
        message: "This retained attestation exceeds the 64 KiB signed-request limit and was not resent. Its original command and key remain intact. Inspect recorded reviews before changing the target or scientific boundary." };
    const result = await stoaRecordExternalExpertReview(session.operatorId, problemId, parsed.data, idempotencyKey);
    if (result.ok) return { ok: true, record: result.data };
    if (result.reason === "refused" && result.problemCode !== undefined && [400, 422].includes(result.status ?? 0))
      return { ok: false, retainAttempt: false,
        message: result.problemCode === "SECRET_SHAPED_CONTENT"
          ? "Credential-shaped material was refused. Remove it from the attestation metadata before reviewing a new command."
          : "Stoa refused this attestation. Check the exact current claim version, the permanent source and digest, and every required boundary field before reviewing a new command." };
    if (result.reason === "refused" && result.status === 404 &&
        (result.problemCode === "CLAIM_NOT_FOUND" || result.problemCode === "PROBLEM_NOT_FOUND"))
      return { ok: false, retainAttempt: false,
        message: "Stoa confirmed that no record was created because the published problem or active claim version was unavailable. Inspect the exact current target, then review a new attestation." };
    if (result.reason === "refused" && [401, 403].includes(result.status ?? 0))
      return { ok: false, retainAttempt: true, reauthenticate: true,
        message: "Stoa could not confirm current operator authority. Re-authenticate as the same operator, then recover the retained command." };
    if (result.reason === "refused" && result.status === 409)
      return { ok: false, retainAttempt: true,
        message: "The target changed or this retry key belongs to a different attestation. Inspect the records below and recover the original command before recording another review." };
    return uncertain;
  } catch {
    return uncertain;
  }
}
