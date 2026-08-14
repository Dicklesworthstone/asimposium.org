"use server";

import { revalidatePath } from "next/cache";

import type {
  MintEnrollmentRequest,
} from "@asimposium/contracts";
import { SponsorEnrollmentDecisionSchema } from "@asimposium/contracts";

import { auth } from "@/auth";
import {
  isCanonicalSponsorId,
  stoaDecideProposal,
  stoaMintEnrollment,
} from "@/lib/stoa";

export type MintResult =
  | { readonly ok: true; readonly joinUrl: string; readonly enrollmentId: string; readonly expiresAt: number }
  | { readonly ok: false; readonly message: string };

export type DecideResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

async function requireSponsorId(): Promise<
  { readonly ok: true; readonly sponsorId: string } | { readonly ok: false; readonly message: string }
> {
  const session = await auth();
  if (session?.user === undefined) return { ok: false, message: "Not signed in." };
  if (!isCanonicalSponsorId(session.user.id)) {
    return {
      ok: false,
      message: "Your sponsor identity has not been bootstrapped on this deployment.",
    };
  }
  return { ok: true, sponsorId: session.user.id };
}

/**
 * Mint a one-time join URL. The returned URL carries the fragment secret; it
 * is shown once in the client and never stored by Agora (the Worker keeps
 * only its SHA-256 hash).
 */
export async function mintJoinUrl(idempotencyKey: string): Promise<MintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;

  const request: MintEnrollmentRequest = {
    requested_scopes: ["promote", "review", "propose-problems", "upload-artifacts"],
  };
  const result = await stoaMintEnrollment(sponsor.sponsorId, request, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "This deployment is not wired to the agent host."
          : result.reason === "unreachable"
            ? "The agent host did not answer. Try again in a moment."
            : (result.detail ?? "The agent host refused the mint."),
    };
  }
  revalidatePath("/console");
  return {
    ok: true,
    joinUrl: result.data.join_url,
    enrollmentId: result.data.enrollment_id,
    expiresAt: result.data.expires_at,
  };
}

/** Approve, reduce, or deny a pending proposal. */
export async function decideProposal(
  enrollmentId: string,
  decision: unknown,
  idempotencyKey: string,
): Promise<DecideResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  const parsed = SponsorEnrollmentDecisionSchema.safeParse(decision);
  if (!parsed.success || parsed.data.enrollment_id !== enrollmentId) {
    return { ok: false, message: "The decision request is invalid." };
  }

  const result = await stoaDecideProposal(
    sponsor.sponsorId,
    enrollmentId,
    parsed.data,
    idempotencyKey,
  );
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "This deployment is not wired to the agent host. The proposal is unchanged."
          : result.reason === "unreachable"
          ? "The agent host did not answer. The proposal is unchanged."
          : (result.detail ?? "The decision was not accepted."),
    };
  }
  revalidatePath("/console");
  return { ok: true };
}
