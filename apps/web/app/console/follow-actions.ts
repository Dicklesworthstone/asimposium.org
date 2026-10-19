"use server";

import {
  SponsorFollowRequestSchema,
  type SponsorFollowReceipt,
  type SponsorFollowRequest,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaBootstrapSponsor, stoaSetSponsorFollow } from "@/lib/stoa";

export type FollowActionResult =
  | { readonly ok: true; readonly receipt: SponsorFollowReceipt }
  | { readonly ok: false; readonly message: string };

/** Reauthenticate every call, including a stale page open across account changes. */
export async function setFollow(
  request: SponsorFollowRequest,
  idempotencyKey: string,
  expectedSponsorId: string,
): Promise<FollowActionResult> {
  const session = await auth();
  const sponsorId = session?.user?.id;
  if (!isCanonicalSponsorId(sponsorId) || sponsorId !== expectedSponsorId) {
    return { ok: false, message: "Your signed-in account changed. Reload this page before changing follows." };
  }
  const parsed = SponsorFollowRequestSchema.safeParse(request);
  if (!parsed.success || typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey))
    return { ok: false, message: "Choose a canonical problem id and a follow decision." };
  try {
    // A public problem can lead a first-time sponsor directly here, before
    // the main console has established the idempotent sponsor record.
    const bootstrap = await stoaBootstrapSponsor(sponsorId);
    if (!bootstrap.ok)
      return { ok: false, message: "Your sponsor account could not be prepared. Retry this decision." };
    const result = await stoaSetSponsorFollow(sponsorId, parsed.data, idempotencyKey);
    if (!result.ok) {
      return {
        ok: false,
        message: result.reason === "unconfigured"
          ? "Following is not configured on this deployment."
          : result.reason === "refused" && result.status === 404
            ? "That problem is not publicly available. Following cannot open private work."
            : result.reason === "refused" && (result.status === 409 || result.status === 429)
              ? "The follow decision was refused. Refresh the list; at most 100 problems can be followed."
              : "The decision could not be confirmed. Retry unchanged to recover its receipt.",
      };
    }
    if (result.data.problem_id !== parsed.data.problem_id ||
        result.data.following !== parsed.data.following)
      return { ok: false, message: "The receipt did not match this decision. Retry unchanged." };
    revalidatePath("/console/follows");
    return { ok: true, receipt: result.data };
  } catch {
    return { ok: false, message: "The decision could not be confirmed. Retry unchanged to recover its receipt." };
  }
}
