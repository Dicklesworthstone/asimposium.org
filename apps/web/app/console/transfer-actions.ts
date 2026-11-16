"use server";

import {
  parseStoaRebindUrl,
  SponsorFellowRebindCreateResponseSchema,
  SponsorFellowRebindDecisionResponseSchema,
  SponsorFellowTransferAcceptResponseSchema,
  SponsorFellowTransferCancelResponseSchema,
  SponsorFellowTransferInitiateResponseSchema,
  SponsorFellowTransferRejectResponseSchema,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {
  bestEffortEnrollmentCacheInvalidation,
  enrollmentRecoveryConfigurationIsValid,
  enrollmentRecoveryDisposition,
  enrollmentRecoveryFingerprint,
  enrollmentRecoveryOwner,
  openEnrollmentRecoveryPayload,
  sealEnrollmentRecoveryPayload,
} from "@/lib/enrollment-recovery";
import { recentAuthOk } from "@/lib/recent-auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  configuredStoaOrigin,
  stoaCreateRebind,
  stoaDecideRebind,
  stoaInitiateTransfer,
  stoaResolveTransfer,
} from "@/lib/stoa";
import {
  parseTransferIntent,
  TRANSFER_RECOVERY_SCOPE,
  type TransferIntent,
  transferIntentBelongsToSponsor,
} from "@/lib/transfer-recovery";

export type TransferReceipt =
  | { readonly kind: "offer"; readonly transferId: string; readonly expiresAt: number }
  | { readonly kind: "accept" | "reject" | "cancel"; readonly transferId: string }
  | {
      readonly kind: "rebind-create";
      readonly rebindId: string;
      readonly fellowId: string;
      readonly rebindUrl: string;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "rebind-decision";
      readonly rebindId: string;
      readonly status: "approved" | "denied";
    };

export type TransferActionResult =
  | { readonly ok: true; readonly receipt: TransferReceipt }
  | { readonly ok: false; readonly message: string; readonly recovery: "retain" | "clear" };

export type PreparedTransferAttempt =
  | {
      readonly ok: true;
      readonly fingerprint: string;
      readonly recoveryPayload: string;
      readonly serverNow: number;
    }
  | { readonly ok: false; readonly message: string };

const KEY = /^console-[A-Za-z0-9._-]{1,152}$/;
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

const STALE_AUTH =
  "Fellow transfers need a Google authentication time from the last 15 minutes. Sign in to your Google Account again, then recover the unchanged command.";

async function steppedUpSponsor(
  expectedSponsorId: string,
  expectedRecoveryOwner: string,
): Promise<
  | {
      readonly ok: true;
      readonly sponsorId: string;
      readonly stepUpAt: number;
      readonly recoveryKey: string;
    }
  | { readonly ok: false; readonly message: string }
> {
  const session = await auth();
  if (
    session?.user === undefined ||
    !isCanonicalSponsorId(session.user.id) ||
    session.user.id !== expectedSponsorId
  ) {
    return {
      ok: false,
      message:
        "Your sponsor session changed. Sign in as the intended sponsor before recovering this command.",
    };
  }
  const recoveryKey = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(
      recoveryKey,
      process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
    )
  ) {
    return {
      ok: false,
      message: "This deployment cannot recover Fellow transfer commands. Keep the pending command.",
    };
  }
  if (
    typeof expectedRecoveryOwner !== "string" ||
    (await enrollmentRecoveryOwner(recoveryKey, session.user.id)) !== expectedRecoveryOwner
  ) {
    return {
      ok: false,
      message:
        "This transfer belongs to another sponsor session. Reload under the intended account.",
    };
  }
  if (!isCanonicalSponsorId(expectedSponsorId)) {
    return { ok: false, message: "Sign in again before changing a Fellow's sponsor." };
  }
  const stepUpAt = session.authIssuedAt;
  if (typeof stepUpAt !== "number" || !recentAuthOk(stepUpAt)) {
    return { ok: false, message: STALE_AUTH };
  }
  return { ok: true, sponsorId: session.user.id, stepUpAt, recoveryKey };
}

/**
 * Seal the reviewed command before sending it. Browser storage contains only
 * authenticated ciphertext, never a transfer manifest or a rebind secret.
 */
export async function prepareTransferAttempt(
  rawIntent: unknown,
  expectedSponsorId: string,
  expectedRecoveryOwner: string,
  idempotencyKey: string,
  confirmed: boolean,
): Promise<PreparedTransferAttempt> {
  if (confirmed !== true) {
    return {
      ok: false,
      message: "Review and confirm this exact transfer or rebind action before continuing.",
    };
  }
  const intent = parseTransferIntent(rawIntent);
  if (
    !intent ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim() !== idempotencyKey ||
    !KEY.test(idempotencyKey)
  ) {
    return {
      ok: false,
      message:
        "The transfer command is invalid. Choose the exact Fellow or pending transfer again.",
    };
  }
  const sponsor = await steppedUpSponsor(expectedSponsorId, expectedRecoveryOwner);
  if (!sponsor.ok) return sponsor;
  if (!transferIntentBelongsToSponsor(intent, sponsor.sponsorId)) {
    return { ok: false, message: "This transfer action does not belong to the signed-in sponsor." };
  }
  const serverNow = Date.now();
  const fingerprint = await enrollmentRecoveryFingerprint(
    sponsor.recoveryKey,
    sponsor.sponsorId,
    TRANSFER_RECOVERY_SCOPE,
    intent,
  );
  return {
    ok: true,
    fingerprint,
    recoveryPayload: await sealEnrollmentRecoveryPayload(sponsor.recoveryKey, {
      sponsorId: sponsor.sponsorId,
      scope: TRANSFER_RECOVERY_SCOPE,
      fingerprint,
      idempotencyKey,
      expiresAt: serverNow + RECOVERY_WINDOW_MS,
      request: intent,
    }),
    serverNow,
  };
}

/** Recover the same logical write, even after a new Google authentication. */
export async function recoverTransferAttempt(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedSponsorId: string,
  expectedRecoveryOwner: string,
): Promise<TransferActionResult> {
  const sponsor = await steppedUpSponsor(expectedSponsorId, expectedRecoveryOwner);
  if (!sponsor.ok) return { ...sponsor, recovery: "retain" };
  let intent: TransferIntent;
  try {
    const opened = await openEnrollmentRecoveryPayload(
      sponsor.recoveryKey,
      recoveryPayload,
      sponsor.sponsorId,
      TRANSFER_RECOVERY_SCOPE,
      Date.now(),
    );
    const parsed = parseTransferIntent(opened.request);
    if (
      !parsed ||
      opened.idempotencyKey !== idempotencyKey ||
      !transferIntentBelongsToSponsor(parsed, sponsor.sponsorId) ||
      (await enrollmentRecoveryFingerprint(
        sponsor.recoveryKey,
        sponsor.sponsorId,
        TRANSFER_RECOVERY_SCOPE,
        parsed,
      )) !== opened.fingerprint
    )
      throw new Error("Invalid transfer recovery");
    intent = parsed;
  } catch {
    return {
      ok: false,
      recovery: "retain",
      message:
        "The retained transfer command could not be authenticated or its 24-hour recovery window ended. Reload the console and check the Fellow, transfers and rebinds for the earlier outcome. Only after verifying that outcome, close this tab if you intentionally want to discard its recovery safeguard and start over in a fresh console tab.",
    };
  }
  try {
    const result = await dispatchTransfer(
      sponsor.sponsorId,
      intent,
      idempotencyKey,
      sponsor.stepUpAt,
    );
    if (result.ok) bestEffortEnrollmentCacheInvalidation(() => revalidatePath("/console"));
    return result;
  } catch {
    return {
      ok: false,
      recovery: "retain",
      message:
        "The outcome could not be confirmed. Recover this unchanged command before starting another transfer or rebind.",
    };
  }
}

function transferFailure(result: {
  readonly reason: "unconfigured" | "unreachable" | "refused";
  readonly status?: number;
  readonly detail?: string;
  readonly problemCode?: string;
}): TransferActionResult {
  const retained =
    result.reason === "unconfigured" ||
    result.status === 401 ||
    result.status === 403 ||
    result.problemCode === "STEP_UP_REQUIRED" ||
    result.problemCode === "IDEMPOTENCY_CONFLICT";
  return {
    ok: false,
    recovery: retained
      ? "retain"
      : enrollmentRecoveryDisposition(result.reason, result.status, result.problemCode),
    message:
      result.problemCode === "STEP_UP_REQUIRED"
        ? STALE_AUTH
        : result.problemCode === "IDEMPOTENCY_CONFLICT"
          ? "Stoa found conflicting details for this retry key. Keep the original command and inspect the recorded transfer; do not replace its key."
          : result.reason === "refused" && result.detail
            ? `Stoa refused: ${result.detail}`
            : "The transfer or rebind could not be confirmed. Recover the unchanged command to reuse its original retry key.",
  };
}

function mismatchedReceipt(): TransferActionResult {
  return {
    ok: false,
    recovery: "retain",
    message:
      "The Worker receipt did not match this exact command. Keep the original command and retry unchanged.",
  };
}

async function dispatchTransfer(
  sponsorId: string,
  intent: TransferIntent,
  key: string,
  authenticatedAt: number,
): Promise<TransferActionResult> {
  // Worker replay identities contain stable intent, not authentication time.
  // Fresh Google evidence therefore never changes the logical write being recovered.
  switch (intent.kind) {
    case "offer": {
      const result = await stoaInitiateTransfer(
        sponsorId,
        { ...intent.request, step_up_authenticated_at: authenticatedAt },
        key,
      );
      if (!result.ok) return transferFailure(result);
      const receipt = SponsorFellowTransferInitiateResponseSchema.safeParse(result.data);
      if (
        !receipt.success ||
        receipt.data.fellow_id !== intent.request.fellow_id ||
        receipt.data.manifest.fellow_id !== intent.request.fellow_id ||
        receipt.data.source_sponsor_id !== sponsorId ||
        receipt.data.target_sponsor_id !== intent.request.target_sponsor_id
      )
        return mismatchedReceipt();
      return {
        ok: true,
        receipt: {
          kind: intent.kind,
          transferId: receipt.data.transfer_id,
          expiresAt: receipt.data.expires_at,
        },
      };
    }
    case "accept":
    case "reject":
    case "cancel": {
      const base = {
        transfer_id: intent.transfer.transfer_id,
        step_up_authenticated_at: authenticatedAt,
      };
      const result = await stoaResolveTransfer(
        sponsorId,
        intent.kind === "accept"
          ? { ...base, decision: intent.kind, confirm: "accept-fellow-transfer" }
          : intent.kind === "reject"
            ? { ...base, decision: intent.kind, confirm: "reject-fellow-transfer" }
            : { ...base, decision: intent.kind, confirm: "cancel-fellow-transfer" },
        key,
      );
      if (!result.ok) return transferFailure(result);
      if (intent.kind === "accept") {
        const receipt = SponsorFellowTransferAcceptResponseSchema.safeParse(result.data);
        if (
          !receipt.success ||
          receipt.data.transfer_id !== intent.transfer.transfer_id ||
          receipt.data.fellow_id !== intent.transfer.fellow_id ||
          receipt.data.source_sponsor_id !== intent.transfer.source_sponsor_id ||
          receipt.data.target_sponsor_id !== sponsorId
        )
          return mismatchedReceipt();
        return { ok: true, receipt: { kind: intent.kind, transferId: receipt.data.transfer_id } };
      }
      const receipt =
        intent.kind === "reject"
          ? SponsorFellowTransferRejectResponseSchema.safeParse(result.data)
          : SponsorFellowTransferCancelResponseSchema.safeParse(result.data);
      if (!receipt.success || receipt.data.transfer_id !== intent.transfer.transfer_id)
        return mismatchedReceipt();
      return { ok: true, receipt: { kind: intent.kind, transferId: receipt.data.transfer_id } };
    }
    case "rebind-create": {
      const result = await stoaCreateRebind(
        sponsorId,
        { ...intent.request, step_up_authenticated_at: authenticatedAt },
        key,
      );
      if (!result.ok) return transferFailure(result);
      const receipt = SponsorFellowRebindCreateResponseSchema.safeParse(result.data);
      if (
        !receipt.success ||
        receipt.data.fellow_id !== intent.request.fellow_id ||
        parseStoaRebindUrl(receipt.data.rebind_url)?.origin !== configuredStoaOrigin()
      )
        return mismatchedReceipt();
      return {
        ok: true,
        receipt: {
          kind: intent.kind,
          fellowId: receipt.data.fellow_id,
          rebindId: receipt.data.rebind_id,
          rebindUrl: receipt.data.rebind_url,
          expiresAt: receipt.data.expires_at,
        },
      };
    }
    case "rebind-decision": {
      const result = await stoaDecideRebind(
        sponsorId,
        { ...intent.request, step_up_authenticated_at: authenticatedAt },
        key,
      );
      if (!result.ok) return transferFailure(result);
      const receipt = SponsorFellowRebindDecisionResponseSchema.safeParse(result.data);
      if (
        !receipt.success ||
        receipt.data.rebind_id !== intent.request.rebind_id ||
        receipt.data.fellow_id !== intent.fellow_id ||
        receipt.data.status !== (intent.request.decision === "approve" ? "approved" : "denied")
      )
        return mismatchedReceipt();
      return {
        ok: true,
        receipt: {
          kind: intent.kind,
          rebindId: receipt.data.rebind_id,
          status: receipt.data.status,
        },
      };
    }
  }
}
