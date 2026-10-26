"use server";

import {
  type AdminSponsorSuspensionReceipt,
  type AdminSponsorSuspensionRequest,
  AdminSponsorSuspensionRequestSchema,
  type AdminSponsorSuspensionState,
} from "@asimposium/contracts";
import { requireOperatorSession, sponsorSuspensionAuthIsRecent } from "@/lib/admin";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaAdminSponsorSuspension, stoaSuspendSponsor } from "@/lib/stoa";

export type SponsorSuspensionInput = Omit<
  AdminSponsorSuspensionRequest,
  "sponsor_id" | "step_up_authenticated_at"
> & { readonly confirm_reviewed_egregious_case: true };

export type SponsorSuspensionActionResult =
  | {
      readonly ok: true;
      readonly receipt: AdminSponsorSuspensionReceipt;
      readonly current: AdminSponsorSuspensionState | null;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryable: boolean;
      readonly refreshRequired?: true;
    };

/** Every invocation derives its authority and authentication time afresh. */
export async function suspendSponsor(
  expectedOperatorId: string,
  sponsorId: string,
  input: SponsorSuspensionInput,
  idempotencyKey: string,
): Promise<SponsorSuspensionActionResult> {
  const session = await requireOperatorSession();
  if (session.state !== "authorized" || !sponsorSuspensionAuthIsRecent(session.authIssuedAt)) {
    return {
      ok: false, retryable: false, refreshRequired: true,
      message: session.state === "forbidden"
        ? "This account is not authorized to suspend sponsors."
        : "Re-authenticate with Google, then reload the sponsor and reviewed case. Suspension requires authentication within the last 15 minutes.",
    };
  }
  if (expectedOperatorId !== session.operatorId) {
    return {
      ok: false, retryable: false, refreshRequired: true,
      message: "Your signed-in operator account changed. Reload and review this sponsor again.",
    };
  }
  if (
    !isCanonicalSponsorId(sponsorId) || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey) ||
    typeof input !== "object" || input === null || Array.isArray(input) ||
    "sponsor_id" in input || "step_up_authenticated_at" in input
  ) {
    return { ok: false, retryable: false, message: "The sponsor or command is invalid. Reload the sponsor before trying again." };
  }
  const { confirm_reviewed_egregious_case: confirmed, ...requested } = input;
  if (confirmed !== true) {
    return {
      ok: false, retryable: false,
      message: "Explicitly confirm that you reviewed the rejected case and judged it egregious enough to suspend this sponsor.",
    };
  }
  const command = AdminSponsorSuspensionRequestSchema.safeParse({
    ...requested,
    sponsor_id: sponsorId,
    step_up_authenticated_at: session.authIssuedAt,
  });
  if (!command.success) {
    return {
      ok: false, retryable: false,
      message: "Use the inspected sponsor revision, a rejected screening case, and a reason of 10 to 1000 characters.",
    };
  }

  const uncertain: SponsorSuspensionActionResult = {
    ok: false, retryable: true,
    message: "The suspension could not be confirmed. Retry this exact decision with its original retry key, or reload the sponsor before starting another decision.",
  };
  let result: Awaited<ReturnType<typeof stoaSuspendSponsor>>;
  try {
    result = await stoaSuspendSponsor(session.operatorId, sponsorId, command.data, idempotencyKey);
  } catch {
    return uncertain;
  }
  if (!result.ok) {
    if (result.reason === "unconfigured") {
      return { ok: false, retryable: false, message: "Sponsor suspension controls are not configured on this deployment." };
    }
    if (result.reason === "refused" && result.status === 409) {
      return {
        ok: false, retryable: false, refreshRequired: true,
        message: "The sponsor state changed, the reviewed case is no longer eligible, or the retry key belongs to another decision. Reload and review the current state before continuing.",
      };
    }
    if (result.reason === "refused" && (result.status === 401 || result.status === 403)) {
      return {
        ok: false, retryable: false, refreshRequired: true,
        message: "Stoa requires current operator authority and recent authentication. Re-authenticate with Google, then reload this sponsor.",
      };
    }
    if (result.reason === "refused" && result.status === 404) {
      return {
        ok: false, retryable: false, refreshRequired: true,
        message: "The sponsor or reviewed screening case is unavailable. Reload and verify both identifiers.",
      };
    }
    if (result.reason === "refused" && (result.status === 400 || result.status === 422)) {
      return {
        ok: false, retryable: false,
        message: "Stoa refused the decision. Use a rejected case belonging to this sponsor and a documented egregious-case reason of 10 to 1000 characters; do not include credentials or personal data.",
      };
    }
    return uncertain;
  }

  // A receipt establishes the committed cascade. Current account standing is
  // a separate read so a recovered response never impersonates a fresh read.
  let current: AdminSponsorSuspensionState | null = null;
  try {
    const read = await stoaAdminSponsorSuspension(session.operatorId, sponsorId);
    if (
      read.ok && read.data.revision >= result.data.revision &&
      read.data.suspension?.event_id === result.data.event_id
    ) current = read.data;
  } catch {
    // Keep the confirmed receipt even when the follow-up read is unavailable.
  }
  return { ok: true, receipt: result.data, current };
}
