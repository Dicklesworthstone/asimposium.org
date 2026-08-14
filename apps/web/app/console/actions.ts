"use server";

import { revalidatePath } from "next/cache";

import type {
  MintEnrollmentRequest,
  SponsorEnrollmentDecision,
} from "@asimposium/contracts";

import { auth } from "@/auth";
import { stoaDecideProposal, stoaMintEnrollment } from "@/lib/stoa";

export type MintResult =
  | { readonly ok: true; readonly joinUrl: string; readonly enrollmentId: string; readonly expiresAt: number }
  | { readonly ok: false; readonly message: string };

export type DecideResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

async function requireSponsorId(): Promise<string | undefined> {
  const session = await auth();
  return session?.user?.id;
}

/**
 * Mint a one-time join URL. The returned URL carries the fragment secret; it
 * is shown once in the client and never stored by Agora (the Worker keeps
 * only its SHA-256 hash).
 */
export async function mintJoinUrl(): Promise<MintResult> {
  const sponsorId = await requireSponsorId();
  if (sponsorId === undefined) return { ok: false, message: "Not signed in." };

  const request: MintEnrollmentRequest = {
    requested_scopes: ["promote", "review", "propose-problems", "upload-artifacts"],
  };
  const result = await stoaMintEnrollment(sponsorId, request);
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
  decision: SponsorEnrollmentDecision,
): Promise<DecideResult> {
  const sponsorId = await requireSponsorId();
  if (sponsorId === undefined) return { ok: false, message: "Not signed in." };

  const result = await stoaDecideProposal(sponsorId, enrollmentId, decision);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unreachable"
          ? "The agent host did not answer. The proposal is unchanged."
          : (result.detail ?? "The decision was not accepted."),
    };
  }
  revalidatePath("/console");
  return { ok: true };
}
