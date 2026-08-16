"use server";

import type { EnrollmentApprovalCard } from "@asimposium/contracts";
import {
  MintEnrollmentRequestSchema,
  SponsorEnrollmentDecisionSchema,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { recentAuthOk } from "@/lib/recent-auth";
import {
  enrollmentRecoveryConfigurationIsValid,
  enrollmentRecoveryDisposition,
  enrollmentRecoveryFingerprint,
} from "@/lib/enrollment-recovery";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaDecideProposal, stoaDeviceLookup, stoaMintEnrollment } from "@/lib/stoa";

export type MintResult =
  | {
      readonly ok: true;
      readonly joinUrl: string;
      readonly enrollmentId: string;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** Retain only when transport loss leaves the Worker's commit unknown. */
      readonly recovery: "retain" | "clear";
    };

export type DeviceLookupResult =
  | { readonly ok: true; readonly card: EnrollmentApprovalCard }
  | { readonly ok: false; readonly message: string };

/** W3.5: find a pending device proposal by its human code. Read-only; decisions go through decideProposal with the recent-auth gate. */
export async function lookupDeviceCode(userCode: string): Promise<DeviceLookupResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  const result = await stoaDeviceLookup(sponsor.sponsorId, userCode.trim().toUpperCase());
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unreachable"
          ? "The agent host did not answer. Try again in a moment."
          : (result.detail ?? "That code was not accepted."),
    };
  }
  return { ok: true, card: result.data.card };
}

export type DecideResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      /** Retain only when transport loss leaves the Worker's commit unknown. */
      readonly recovery: "retain" | "clear";
    };

export type EnrollmentAttemptFingerprintResult =
  | { readonly ok: true; readonly fingerprint: string; readonly serverNow: number }
  | { readonly ok: false; readonly message: string };

async function requireSponsorId(): Promise<
  | { readonly ok: true; readonly sponsorId: string; readonly authIssuedAt?: number }
  | { readonly ok: false; readonly message: string }
> {
  const session = await auth();
  if (session?.user === undefined) return { ok: false, message: "Not signed in." };
  if (!isCanonicalSponsorId(session.user.id)) {
    return {
      ok: false,
      message: "Your sponsor identity has not been bootstrapped on this deployment.",
    };
  }
  return { ok: true, sponsorId: session.user.id, authIssuedAt: session.authIssuedAt };
}

/**
 * Return an opaque, server-keyed identity for one normalized console write.
 * Session storage can retain this value without exposing a dictionary oracle
 * for private directives or proposal reductions. A dedicated recovery key is
 * read at call time and never crosses into the client. It is deliberately not
 * the rotatable service-envelope signing seed: unchanged retries must retain
 * the same identity for the Worker's complete 24-hour replay window.
 */
export async function fingerprintEnrollmentAttempt(
  scope: "mint" | "decision",
  request: unknown,
): Promise<EnrollmentAttemptFingerprintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  if (scope !== "mint" && scope !== "decision") {
    return { ok: false, message: "The enrollment attempt type is invalid." };
  }
  if (scope === "decision" && !recentAuthOk(sponsor.authIssuedAt)) {
    return {
      ok: false,
      message:
        "Decisions need a Google sign-in from the last 15 minutes. Reauthenticate before preparing the decision.",
    };
  }
  const parsed =
    scope === "mint"
      ? MintEnrollmentRequestSchema.safeParse(request)
      : SponsorEnrollmentDecisionSchema.safeParse(request);
  if (!parsed.success) {
    return { ok: false, message: "The enrollment attempt is invalid." };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(
      rootHex,
      process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
    )
  ) {
    return { ok: false, message: "This deployment cannot prepare recoverable writes." };
  }
  try {
    return {
      ok: true,
      fingerprint: await enrollmentRecoveryFingerprint(
        rootHex,
        sponsor.sponsorId,
        scope,
        parsed.data,
      ),
      serverNow: Date.now(),
    };
  } catch {
    return { ok: false, message: "The browser could not prepare a recoverable write." };
  }
}

/**
 * Mint a one-time join URL. The returned URL carries the fragment secret; it
 * is shown once in the client and never persisted by Agora. Stoa stores its
 * SHA-256 hash plus an authenticated encrypted replay for 24 hours; plaintext
 * is never persisted.
 */
export async function mintJoinUrl(
  request: unknown,
  idempotencyKey: string,
  recovering = false,
): Promise<MintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return { ...sponsor, recovery: recovering ? "retain" : "clear" };
  const parsed = MintEnrollmentRequestSchema.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the enrollment settings and try again.",
      recovery: recovering ? "retain" : "clear",
    };
  }
  const result = await stoaMintEnrollment(sponsor.sponsorId, parsed.data, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      recovery:
        recovering && result.reason === "unconfigured"
          ? "retain"
          : enrollmentRecoveryDisposition(result.reason, result.status),
      message:
        result.reason === "unconfigured"
          ? "This deployment is not wired to the agent host."
          : result.reason === "unreachable"
            ? "The agent host did not confirm the mint. Retry without changing these settings to recover the same one-time URL."
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

/**
 * Approve, reduce, or deny a pending proposal. This is a permanent public
 * binding, so W3.4 requires a recent interactive Google sign-in. The stable
 * server-stamped `authIssuedAt` is used here, never refreshable JWT `iat` or a
 * client-supplied time.
 */
export async function decideProposal(
  enrollmentId: string,
  decision: unknown,
  idempotencyKey: string,
  recovering = false,
): Promise<DecideResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return { ...sponsor, recovery: recovering ? "retain" : "clear" };
  if (!recentAuthOk(sponsor.authIssuedAt)) {
    return {
      ok: false,
      recovery: recovering ? "retain" : "clear",
      message:
        "Decisions need a Google sign-in from the last 15 minutes. Use Reauthenticate for decisions on this page, then decide again. The proposal is unchanged.",
    };
  }
  const parsed = SponsorEnrollmentDecisionSchema.safeParse(decision);
  if (!parsed.success || parsed.data.enrollment_id !== enrollmentId) {
    return {
      ok: false,
      message: "The decision request is invalid.",
      recovery: recovering ? "retain" : "clear",
    };
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
      recovery:
        recovering && result.reason === "unconfigured"
          ? "retain"
          : enrollmentRecoveryDisposition(result.reason, result.status),
      message:
        result.reason === "unconfigured"
          ? "This deployment is not wired to the agent host. The proposal is unchanged."
          : result.reason === "unreachable"
            ? "The agent host did not confirm the outcome. Retry this unchanged decision to reuse its Idempotency-Key, then refresh the pending list."
            : (result.detail ?? "The decision was not accepted."),
    };
  }
  revalidatePath("/console");
  return { ok: true };
}
