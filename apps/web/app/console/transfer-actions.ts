"use server";

import {
  FellowIdSchema,
  type SponsorFellowTransferManifest,
  SponsorIdSchema,
  TransferIdSchema,
} from "@asimposium/contracts";
import { auth } from "@/auth";
import { recentAuthOk } from "@/lib/recent-auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaInitiateTransfer, stoaResolveTransfer } from "@/lib/stoa";

export type TransferActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const KEY = /^[A-Za-z0-9._-]{1,160}$/;

const STALE_AUTH =
  "Fellow transfers need a Google authentication time from the last 15 minutes. Sign in to your Google Account again, then retry.";

/** The signed-in sponsor and its recent-authentication time, or why not. */
async function steppedUpSponsor(): Promise<
  | { readonly ok: true; readonly sponsorId: string; readonly stepUpAt: number }
  | { readonly ok: false; readonly message: string }
> {
  const session = await auth();
  if (session?.user === undefined || !isCanonicalSponsorId(session.user.id)) {
    return { ok: false, message: "Sign in again before changing a Fellow's sponsor." };
  }
  const stepUpAt = session.authIssuedAt;
  if (typeof stepUpAt !== "number" || !recentAuthOk(stepUpAt)) {
    return { ok: false, message: STALE_AUTH };
  }
  return { ok: true, sponsorId: session.user.id, stepUpAt };
}

/**
 * Offer one of your own Fellows to another sponsor (Fable §3.1: the sponsor
 * reassigns, both humans confirming). Nothing moves until the receiving
 * sponsor accepts; the offer expires on its own.
 */
export async function initiateFellowTransfer(
  fellowId: string,
  targetSponsorId: string,
  confirmed: boolean,
  idempotencyKey: string,
): Promise<
  TransferActionResult<{
    readonly transferId: string;
    readonly expiresAt: number;
    readonly manifest: SponsorFellowTransferManifest;
  }>
> {
  if (!confirmed) {
    return {
      ok: false,
      message:
        "Confirm that the receiving sponsor gets this Fellow's private workshop access and that its credentials will be revoked.",
    };
  }
  const fellow = FellowIdSchema.safeParse(fellowId.trim());
  const target = SponsorIdSchema.safeParse(targetSponsorId.trim());
  if (!fellow.success || !target.success || !KEY.test(idempotencyKey)) {
    return { ok: false, message: "Choose one of your Fellows and enter the receiving sponsor id." };
  }
  const sponsor = await steppedUpSponsor();
  if (!sponsor.ok) return sponsor;
  if (target.data === sponsor.sponsorId) {
    return { ok: false, message: "A Fellow cannot be transferred to its current sponsor." };
  }
  const result = await stoaInitiateTransfer(
    sponsor.sponsorId,
    {
      fellow_id: fellow.data,
      target_sponsor_id: target.data,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: sponsor.stepUpAt,
    },
    idempotencyKey,
  );
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "Fellow transfers are not configured on this deployment."
          : result.reason === "refused"
            ? "Stoa refused the offer. Only your own active or paused Fellow can be offered, to a sponsor who has signed in, and only one offer per Fellow can be pending."
            : "The offer could not be confirmed. Reload to see whether it is pending before retrying.",
    };
  }
  return {
    ok: true,
    value: {
      transferId: result.data.transfer_id,
      expiresAt: result.data.expires_at,
      manifest: result.data.manifest,
    },
  };
}

/** Accept or reject an incoming offer, or cancel your own outgoing one. */
export async function resolveFellowTransfer(
  transferId: string,
  decision: "accept" | "reject" | "cancel",
  idempotencyKey: string,
): Promise<TransferActionResult<{ readonly transferId: string; readonly outcome: string }>> {
  const transfer = TransferIdSchema.safeParse(transferId);
  if (!transfer.success || !KEY.test(idempotencyKey)) {
    return { ok: false, message: "That transfer cannot be resolved from here." };
  }
  const sponsor = await steppedUpSponsor();
  if (!sponsor.ok) return sponsor;
  const base = { transfer_id: transfer.data, step_up_authenticated_at: sponsor.stepUpAt };
  const result = await stoaResolveTransfer(
    sponsor.sponsorId,
    decision === "accept"
      ? { decision, ...base, confirm: "accept-fellow-transfer" }
      : decision === "reject"
        ? { decision, ...base, confirm: "reject-fellow-transfer" }
        : { decision, ...base, confirm: "cancel-fellow-transfer" },
    idempotencyKey,
  );
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "Fellow transfers are not configured on this deployment."
          : result.reason === "refused"
            ? "Stoa refused: the offer is no longer pending, has expired, or is not yours to resolve this way."
            : "The outcome could not be confirmed. Reload to see the transfer's current state before retrying.",
    };
  }
  return {
    ok: true,
    value: {
      transferId: transfer.data,
      outcome:
        decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "cancelled",
    },
  };
}
