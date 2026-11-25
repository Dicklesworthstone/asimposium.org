"use server";

import { redirect } from "next/navigation";
import { parseUnsubscribeQuery } from "@/lib/email-preferences";
import { stoaPublicEmailUnsubscribe } from "@/lib/email-unsubscribe-client";

function finishUnsubscribe(status: "done" | "invalid" | "unavailable"): never {
  // Always drop signed query parameters (`ref`, `sig`) on redirect.
  redirect(`/console/email-preferences/unsubscribe?status=${status}`);
}

/**
 * Explicit POST handler for signed digest unsubscribe links.
 * Verified on Stoa (`POST /v1/email/unsubscribe`) in constant time against
 * `EMAIL_ACTION_LINK_SECRET`. Never mutates on GET, preventing email link
 * scanners or prefetchers from silently changing sponsor preferences.
 */
export async function confirmDigestUnsubscribeAction(formData: FormData): Promise<void> {
  const refEntry = formData.get("ref");
  const sigEntry = formData.get("sig");
  if (typeof refEntry !== "string" || typeof sigEntry !== "string") {
    return finishUnsubscribe("invalid");
  }
  const parsed = parseUnsubscribeQuery({
    ref: refEntry,
    sig: sigEntry,
  });
  if (!parsed) {
    return finishUnsubscribe("invalid");
  }

  const outcome = await stoaPublicEmailUnsubscribe({
    sponsor_id: parsed.sponsorId,
    ref: parsed.ref,
    sig: parsed.sig,
  });
  if (outcome.ok) {
    return finishUnsubscribe("done");
  }
  switch (outcome.reason) {
    case "refused":
      return finishUnsubscribe("invalid");
    default:
      return finishUnsubscribe("unavailable");
  }
}
