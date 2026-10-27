"use server";
import {
  APPEAL_STEP_UP_SECONDS,
  ScreeningAppealDecisionSchema,
} from "@asimposium/contracts/appeals";
import type { AppealActionState } from "@/app/console/appeals/actions";
import { requireOperatorSession } from "@/lib/admin";
import { stoaDecideScreeningAppeal } from "@/lib/moderation-appeals";

export async function decideAppealAction(
  expectedOperatorId: string,
  _previous: AppealActionState,
  form: FormData,
): Promise<AppealActionState> {
  const session = await requireOperatorSession(),
    now = Math.floor(Date.now() / 1000);
  if (
    session.state !== "authorized" ||
    session.operatorId !== expectedOperatorId ||
    session.authIssuedAt > now ||
    now - session.authIssuedAt > APPEAL_STEP_UP_SECONDS
  )
    return {
      message: "Re-authenticate as the same operator and reload the appeal before deciding it.",
      retryable: false,
    };
  if (form.get("confirmed_review") === "yes") {
    const parsed = ScreeningAppealDecisionSchema.safeParse({
      appeal_id: form.get("appeal_id"),
      decision: form.get("decision"),
      reason: form.get("reason"),
      step_up_authenticated_at: session.authIssuedAt,
    });
    const key = form.get("idempotency_key");
    if (parsed.success && typeof key === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(key)) {
      try {
        const result = await stoaDecideScreeningAppeal(session.operatorId, parsed.data, key);
        if (result.ok)
          return {
            message:
              result.data.state === "released"
                ? "Appeal released. The author must explicitly resubmit the exact candidate; current context and publication authority are checked again."
                : "Rejection upheld. The original decision and this separate appellate record are retained.",
            receipt: result.data,
          };
        if (result.reason === "refused" && result.status !== undefined && result.status < 500)
          return {
            message:
              "The appeal, sponsorship or reviewer authority changed. The original reviewer and affected sponsor cannot decide this appeal. Reload before making another decision.",
            retryable: false,
          };
      } catch {
        /* Keep the exact decision for retry. */
      }
      return {
        message:
          "The decision could not be confirmed. Retry this exact decision with its retained key, or reload the queue to check its outcome.",
        retryable: true,
      };
    }
  }
  return {
    message:
      "Review the candidate and sponsor's statement, confirm the review, and give a reason of 20 to 1,000 characters.",
    retryable: false,
  };
}
