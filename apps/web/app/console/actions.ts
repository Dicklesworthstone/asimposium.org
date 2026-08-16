"use server";

import type {
  EnrollmentApprovalCard,
  MintEnrollmentRequest,
  SponsorEnrollmentDecision,
} from "@asimposium/contracts";
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
  enrollmentRecoveryOwner,
  openEnrollmentRecoveryPayload,
  sealEnrollmentRecoveryPayload,
} from "@/lib/enrollment-recovery";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  stoaDecideProposal,
  stoaDeviceLookup,
  stoaMintEnrollment,
} from "@/lib/stoa";

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
export async function lookupDeviceCode(
  userCode: string,
): Promise<DeviceLookupResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  const result = await stoaDeviceLookup(
    sponsor.sponsorId,
    userCode.trim().toUpperCase(),
  );
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
  | {
      readonly ok: true;
      readonly decision: SponsorEnrollmentDecision["decision"];
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** Retain only when transport loss leaves the Worker's commit unknown. */
      readonly recovery: "retain" | "clear";
    };

export type EnrollmentAttemptFingerprintResult =
  | {
      readonly ok: true;
      readonly fingerprint: string;
      readonly recoveryPayload: string;
      readonly serverNow: number;
    }
  | { readonly ok: false; readonly message: string };

const ENROLLMENT_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

async function recoveryOwnerForSponsor(
  sponsorId: string,
): Promise<string | undefined> {
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(
      rootHex,
      process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
    )
  ) {
    return undefined;
  }
  try {
    return await enrollmentRecoveryOwner(rootHex, sponsorId);
  } catch {
    return undefined;
  }
}

async function recoveryOwnerMatchesSponsor(
  sponsorId: string,
  expectedRecoveryOwner: unknown,
): Promise<boolean> {
  if (
    typeof expectedRecoveryOwner !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedRecoveryOwner)
  ) {
    return false;
  }
  const currentRecoveryOwner = await recoveryOwnerForSponsor(sponsorId);
  return (
    currentRecoveryOwner !== undefined &&
    currentRecoveryOwner === expectedRecoveryOwner
  );
}

async function requireSponsorId(): Promise<
  | {
      readonly ok: true;
      readonly sponsorId: string;
      readonly authIssuedAt?: number;
    }
  | { readonly ok: false; readonly message: string }
> {
  const session = await auth();
  if (session?.user === undefined)
    return { ok: false, message: "Not signed in." };
  if (!isCanonicalSponsorId(session.user.id)) {
    return {
      ok: false,
      message:
        "Your sponsor identity has not been bootstrapped on this deployment.",
    };
  }
  return {
    ok: true,
    sponsorId: session.user.id,
    authIssuedAt: session.authIssuedAt,
  };
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
  expectedRecoveryOwner: string,
  idempotencyKey: unknown,
): Promise<EnrollmentAttemptFingerprintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  if (scope !== "mint" && scope !== "decision") {
    return { ok: false, message: "The enrollment attempt type is invalid." };
  }
  if (
    typeof idempotencyKey !== "string" ||
    !/^console-[A-Za-z0-9._-]{1,152}$/.test(idempotencyKey)
  ) {
    return { ok: false, message: "The enrollment recovery key is invalid." };
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
    return {
      ok: false,
      message: "This deployment cannot prepare recoverable writes.",
    };
  }
  try {
    if (
      !(await recoveryOwnerMatchesSponsor(
        sponsor.sponsorId,
        expectedRecoveryOwner,
      ))
    ) {
      return {
        ok: false,
        message:
          "Your sponsor session changed. Reload this page before preparing an enrollment write.",
      };
    }
    const serverNow = Date.now();
    const fingerprint = await enrollmentRecoveryFingerprint(
      rootHex,
      sponsor.sponsorId,
      scope,
      parsed.data,
    );
    return {
      ok: true,
      fingerprint,
      recoveryPayload: await sealEnrollmentRecoveryPayload(rootHex, {
        sponsorId: sponsor.sponsorId,
        scope,
        fingerprint,
        idempotencyKey,
        expiresAt: serverNow + ENROLLMENT_RECOVERY_WINDOW_MS,
        request: parsed.data,
      }),
      serverNow,
    };
  } catch {
    return {
      ok: false,
      message: "The browser could not prepare a recoverable write.",
    };
  }
}

/**
 * Mint a one-time join URL. The returned URL carries the fragment secret; it
 * is shown once in the client and never persisted by Agora. Stoa stores its
 * SHA-256 hash plus an authenticated encrypted replay for 24 hours; plaintext
 * is never persisted.
 */
export async function mintJoinUrl(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<MintResult> {
  return dispatchPreparedMint(
    recoveryPayload,
    idempotencyKey,
    expectedRecoveryOwner,
  );
}

async function dispatchPreparedMint(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<MintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return { ...sponsor, recovery: "retain" };
  if (
    !(await recoveryOwnerMatchesSponsor(
      sponsor.sponsorId,
      expectedRecoveryOwner,
    ))
  ) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Your sponsor session changed after this write was prepared. Reload under the intended sponsor, then retry the exact unchanged attempt.",
    };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(
      rootHex,
      process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
    )
  ) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "This deployment cannot open the prepared mint. Do not start a replacement.",
    };
  }
  try {
    const opened = await openEnrollmentRecoveryPayload(
      rootHex,
      recoveryPayload,
      sponsor.sponsorId,
      "mint",
      Date.now(),
    );
    const parsed = MintEnrollmentRequestSchema.safeParse(opened.request);
    if (
      !parsed.success ||
      opened.idempotencyKey !== idempotencyKey ||
      (await enrollmentRecoveryFingerprint(
        rootHex,
        sponsor.sponsorId,
        "mint",
        parsed.data,
      )) !== opened.fingerprint
    ) {
      throw new Error("invalid recovery payload");
    }
    return dispatchMint(sponsor.sponsorId, parsed.data, opened.idempotencyKey);
  } catch {
    return {
      ok: false,
      recovery: "retain",
      message:
        "The prepared mint could not be authenticated or its recovery window ended. Verify the earlier outcome; do not start a replacement automatically.",
    };
  }
}

async function dispatchMint(
  sponsorId: string,
  request: MintEnrollmentRequest,
  idempotencyKey: string,
): Promise<MintResult> {
  const result = await stoaMintEnrollment(sponsorId, request, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      recovery:
        result.reason === "unconfigured"
          ? "retain"
          : enrollmentRecoveryDisposition(
              result.reason,
              result.status,
              result.problemCode,
            ),
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

/** Recover the exact normalized mint body after a crash or full reload. */
export async function recoverMintJoinUrl(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<MintResult> {
  return dispatchPreparedMint(
    recoveryPayload,
    idempotencyKey,
    expectedRecoveryOwner,
  );
}

/**
 * Approve, reduce, or deny a pending proposal. This is a permanent public
 * binding, so W3.4 requires a recent interactive Google sign-in. The stable
 * server-stamped `authIssuedAt` is used here, never refreshable JWT `iat` or a
 * client-supplied time.
 */
export async function decideProposal(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<DecideResult> {
  return dispatchPreparedDecision(
    recoveryPayload,
    idempotencyKey,
    expectedRecoveryOwner,
  );
}

async function dispatchPreparedDecision(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<DecideResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return { ...sponsor, recovery: "retain" };
  if (
    !(await recoveryOwnerMatchesSponsor(
      sponsor.sponsorId,
      expectedRecoveryOwner,
    ))
  ) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Your sponsor session changed after this decision was prepared. Reload under the intended sponsor, then retry the exact unchanged decision.",
    };
  }
  if (!recentAuthOk(sponsor.authIssuedAt)) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Decisions need a Google sign-in from the last 15 minutes. Use Reauthenticate for decisions on this page, then decide again. The proposal is unchanged.",
    };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(
      rootHex,
      process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
    )
  ) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "This deployment cannot open the prepared decision. Do not start a replacement.",
    };
  }
  try {
    const opened = await openEnrollmentRecoveryPayload(
      rootHex,
      recoveryPayload,
      sponsor.sponsorId,
      "decision",
      Date.now(),
    );
    const parsed = SponsorEnrollmentDecisionSchema.safeParse(opened.request);
    if (
      !parsed.success ||
      opened.idempotencyKey !== idempotencyKey ||
      (await enrollmentRecoveryFingerprint(
        rootHex,
        sponsor.sponsorId,
        "decision",
        parsed.data,
      )) !== opened.fingerprint
    ) {
      throw new Error("invalid recovery payload");
    }
    return dispatchDecision(
      sponsor.sponsorId,
      parsed.data.enrollment_id,
      parsed.data,
      opened.idempotencyKey,
    );
  } catch {
    return {
      ok: false,
      recovery: "retain",
      message:
        "The prepared decision could not be authenticated or its recovery window ended. Verify the earlier outcome; do not start a replacement automatically.",
    };
  }
}

async function dispatchDecision(
  sponsorId: string,
  enrollmentId: string,
  decision: SponsorEnrollmentDecision,
  idempotencyKey: string,
): Promise<DecideResult> {
  const result = await stoaDecideProposal(
    sponsorId,
    enrollmentId,
    decision,
    idempotencyKey,
  );
  if (!result.ok) {
    return {
      ok: false,
      recovery:
        result.reason === "unconfigured"
          ? "retain"
          : enrollmentRecoveryDisposition(
              result.reason,
              result.status,
              result.problemCode,
            ),
      message:
        result.reason === "unconfigured"
          ? "This deployment is not wired to the agent host. The proposal is unchanged."
          : result.reason === "unreachable"
            ? "The agent host did not confirm the outcome. Retry this unchanged decision to reuse its Idempotency-Key, then refresh the pending list."
            : (result.detail ?? "The decision was not accepted."),
    };
  }
  revalidatePath("/console");
  return { ok: true, decision: decision.decision };
}

/** Recover an exact prepared decision even when its pending card disappeared. */
export async function recoverProposalDecision(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<DecideResult> {
  return dispatchPreparedDecision(
    recoveryPayload,
    idempotencyKey,
    expectedRecoveryOwner,
  );
}
