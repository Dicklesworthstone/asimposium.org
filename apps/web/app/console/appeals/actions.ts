"use server";
import {
  type ScreeningAppealReceipt,
  ScreeningAppealRequestSchema,
} from "@asimposium/contracts/appeals";
import { auth } from "@/auth";
import { stoaSubmitScreeningAppeal } from "@/lib/moderation-appeals";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export interface AppealActionState {
  message: string;
  receipt?: ScreeningAppealReceipt;
  retryable?: boolean;
}
export async function submitAppealAction(
  expectedSponsorId: string,
  _previous: AppealActionState,
  form: FormData,
): Promise<AppealActionState> {
  const session = await auth(),
    sponsorId = session?.user?.id;
  if (!isCanonicalSponsorId(sponsorId) || sponsorId !== expectedSponsorId)
    return {
      message: "Your signed-in sponsor account changed. Sign in and reload this case.",
      retryable: false,
    };
  const parsed = ScreeningAppealRequestSchema.safeParse({
    case_id: form.get("case_id"),
    statement: form.get("statement"),
  });
  const key = form.get("idempotency_key");
  if (!parsed.success || typeof key !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(key))
    return {
      message: "Use the selected case and a private explanation of 20 to 2,000 characters.",
      retryable: false,
    };
  try {
    const result = await stoaSubmitScreeningAppeal(sponsorId, parsed.data, key);
    if (result.ok)
      return {
        message:
          "Your appeal is recorded. A different operator will review it; the submission remains unpublished.",
        receipt: result.data,
      };
    if (result.reason === "refused" && result.status !== undefined && result.status < 500)
      return {
        message:
          "The case or sponsorship changed, or this appeal was already recorded. Reload the case list to recover its current receipt.",
        retryable: false,
      };
  } catch {
    /* The retained form/key can recover an ambiguous commit. */
  }
  return {
    message:
      "The response could not be confirmed. Retry this unchanged appeal with the retained key, or reload the case list to check its receipt.",
    retryable: true,
  };
}
