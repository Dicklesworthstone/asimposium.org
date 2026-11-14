"use server";

import { type SponsorLeaseReleaseResponse, SponsorLeaseSummarySchema } from "@asimposium/contracts";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaSponsorReleaseLease } from "@/lib/stoa-leases";

export type LeaseReleaseTarget = {
  readonly lease_id: string;
  readonly problem_id: string;
  readonly object: string;
};

export type LeaseReleaseState =
  | { readonly status: "idle" }
  | { readonly status: "refused"; readonly message: string; readonly code?: string }
  | { readonly status: "released"; readonly receipt: SponsorLeaseReleaseResponse };

const TargetSchema = SponsorLeaseSummarySchema.pick({
  lease_id: true,
  problem_id: true,
  object: true,
});

export async function releaseLease(
  expectedSponsorId: string,
  target: LeaseReleaseTarget,
  _previous: LeaseReleaseState,
  form: FormData,
): Promise<LeaseReleaseState> {
  const session = await auth();
  const sponsorId = session?.user?.id;
  if (!isCanonicalSponsorId(sponsorId))
    return { status: "refused", message: "Sign in again before releasing a lease." };
  if (sponsorId !== expectedSponsorId)
    return {
      status: "refused",
      message: "Your signed-in account changed. Reload the active leases before continuing.",
    };
  const pin = TargetSchema.safeParse(target);
  if (!pin.success)
    return {
      status: "refused",
      message: "This lease reference is invalid. Refresh active leases.",
    };
  if (form.getAll("confirm_release").length !== 1 || form.get("confirm_release") !== "yes")
    return { status: "refused", message: "Confirm release of this exact lease before continuing." };

  const uncertain =
    "The release could not be confirmed. Retry this same lease to recover its receipt safely.";
  try {
    const result = await stoaSponsorReleaseLease(sponsorId, pin.data);
    if (!result.ok)
      return {
        status: "refused",
        message:
          result.reason === "unconfigured"
            ? "Lease recovery is not configured on this deployment."
            : result.reason === "refused"
              ? "This lease could not be released. Refresh active leases to check current ownership and status."
              : uncertain,
        ...(result.problemCode === undefined ? {} : { code: result.problemCode }),
      };
    // Keep the confirmed receipt in place. Revalidating this page would remove
    // the released card before the sponsor could read it; refresh is explicit.
    return { status: "released", receipt: result.data };
  } catch {
    return { status: "refused", message: uncertain };
  }
}
