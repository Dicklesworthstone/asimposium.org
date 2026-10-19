"use server";

import { SponsorDirectiveRequestSchema, type SponsorDirectiveReceipt } from "@asimposium/contracts/directives";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaIssueDirective } from "@/lib/stoa";
import { parseReviewHandoff, reviewDirectiveText, type ReviewHandoff } from "@/lib/review-handoff";
import { readReviewHandoff } from "@/lib/review-handoff-read";

export type ReviewRequestResult =
  | { readonly ok: true; readonly receipt: SponsorDirectiveReceipt }
  | { readonly ok: false; readonly message: string };

export async function requestClaimReview(
  source: ReviewHandoff,
  fellowId: string,
  expectedSponsorId: string,
  idempotencyKey: string,
): Promise<ReviewRequestResult> {
  const session = await auth();
  if (
    !session?.user ||
    !isCanonicalSponsorId(session.user.id) ||
    session.user.id !== expectedSponsorId
  ) {
    return { ok: false, message: "The signed-in sponsor changed or expired. Reload the console before sending this review request." };
  }
  const context = parseReviewHandoff(source);
  if (
    context === undefined ||
    typeof idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey)
  ) {
    return { ok: false, message: "The review target or retry key is invalid. Return to the exact claim and start again." };
  }
  const request = SponsorDirectiveRequestSchema.safeParse({
    fellow_id: fellowId,
    problem_id: context.problemId,
    verb: "focus",
    text: reviewDirectiveText(context),
  });
  if (!request.success) return { ok: false, message: "Choose a valid Fellow for this review request." };

  const verified = await readReviewHandoff(context);
  if (!verified.ok) return verified;
  // Stoa is the sole writer: the signed request rechecks sponsor ownership and
  // problem access. It delivers steering, never a review submission or grant.
  const result = await stoaIssueDirective(session.user.id, request.data, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      message: result.reason === "unconfigured"
        ? "Review-request delivery is not configured on this deployment."
        : result.reason === "refused"
          ? "Stoa refused the review request. Refresh Your Fellows and check this Fellow's access to the problem."
          : "Review-request delivery could not be confirmed. Retry unchanged to reuse this request's Idempotency-Key.",
    };
  }
  const receipt = result.data;
  if (
    receipt.fellow_id !== request.data.fellow_id ||
    receipt.problem_id !== context.problemId ||
    receipt.verb !== "focus" ||
    receipt.text !== request.data.text ||
    receipt.delivered !== true
  ) {
    return { ok: false, message: "The directive receipt did not match this review request. Keep the request and retry unchanged." };
  }
  return { ok: true, receipt };
}
