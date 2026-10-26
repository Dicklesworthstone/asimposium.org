"use server";

import {
  type SponsorAccountDeletePreviewResponse,
  SponsorAccountDeleteRequestSchema,
  type SponsorAccountDeleteResponse,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { stoaAccountDeletionPreview, stoaDeleteAccount } from "@/lib/account-deletion";
import { isAccountDeletionRetryKey } from "@/lib/account-deletion-recovery";
import { recentAuthOk } from "@/lib/recent-auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export type AccountDeletionIntent = Omit<
  import("@asimposium/contracts").SponsorAccountDeleteRequest, "step_up_authenticated_at"
>;
export type AccountDeletionFailure = {
  readonly ok: false;
  readonly message: string;
  readonly recovery: "retain" | "review";
  readonly reauthenticate?: true;
};
export type AccountDeletionPreviewResult =
  | { readonly ok: true; readonly preview: SponsorAccountDeletePreviewResponse }
  | AccountDeletionFailure;
export type AccountDeletionResult =
  | { readonly ok: true; readonly receipt: SponsorAccountDeleteResponse }
  | AccountDeletionFailure;

/** Preparing a preview never deletes, revokes, or authorizes a later changed account. */
export async function prepareAccountDeletion(expectedSponsorId: string): Promise<AccountDeletionPreviewResult> {
  try {
    const session = await auth();
    const principalId = session?.user?.id;
    if (!isCanonicalSponsorId(principalId) || principalId !== expectedSponsorId) {
      return { ok: false, recovery: "retain", reauthenticate: true,
        message: "Your signed-in account changed or could not be verified. Sign in to the intended account and reload before reviewing deletion." };
    }
    const result = await stoaAccountDeletionPreview(principalId);
    if (result.ok) return { ok: true, preview: result.data };
    return { ok: false, recovery: "retain",
      message: result.reason === "refused" && result.status === 403
        ? "This account is not available for a new deletion preview. If a prior confirmation was sent, retry that exact confirmation to recover its receipt."
        : "The account's exact deletion impact could not be read. No deletion was requested. Try the preview again when the account service is available." };
  } catch {
    return { ok: false, recovery: "retain", message: "The account preview could not be verified. No deletion was requested." };
  }
}

/** Authority and Google authentication evidence are re-derived on every invocation. */
export async function confirmAccountDeletion(
  expectedSponsorId: string,
  intent: AccountDeletionIntent,
  idempotencyKey: string,
): Promise<AccountDeletionResult> {
  const uncertain: AccountDeletionFailure = {
    ok: false, recovery: "retain",
    message: "The deletion response could not be confirmed. Keep this exact confirmation and retry key; retrying recovers the original receipt or completes the same reviewed deletion.",
  };
  try {
    const session = await auth();
    const principalId = session?.user?.id;
    if (!isCanonicalSponsorId(principalId) || principalId !== expectedSponsorId) {
      return { ok: false, recovery: "retain", reauthenticate: true,
        message: "Your signed-in account changed or could not be verified. Return to the intended account before retrying this confirmation." };
    }
    const authenticatedAt = session?.authIssuedAt;
    if (typeof authenticatedAt !== "number" || !recentAuthOk(authenticatedAt)) {
      return { ok: false, recovery: "retain", reauthenticate: true,
        message: "Account deletion requires Google authentication within the last 15 minutes. Re-authenticate, return to this account page, and review or retry the retained confirmation." };
    }
    const parsed = SponsorAccountDeleteRequestSchema.omit({ step_up_authenticated_at: true }).safeParse(intent);
    if (!parsed.success || !isAccountDeletionRetryKey(idempotencyKey)) {
      return { ok: false, recovery: "review", message: "The confirmation is invalid. Load a new impact preview and confirm the reviewed account explicitly." };
    }
    const result = await stoaDeleteAccount(principalId, {
      ...parsed.data, step_up_authenticated_at: authenticatedAt,
    }, idempotencyKey);
    if (result.ok) {
      // Cache refresh must not hide a durable deletion receipt if rendering fails.
      try { revalidatePath("/console"); revalidatePath("/console/account"); } catch { /* Receipt remains authoritative. */ }
      return { ok: true, receipt: result.data };
    }
    if (result.reason === "refused" && result.status === 409 && result.problemCode === "OBJECT_VERSION_CONFLICT") {
      return { ok: false, recovery: "review",
        message: "Your account or its affected resources changed after the preview. This deletion did not commit. Load and review a new preview before confirming again." };
    }
    if (result.reason === "refused" && (result.status === 401 || result.status === 403)) {
      return { ok: false, recovery: "retain", reauthenticate: true,
        message: "The account service could not authorize this confirmation. Re-authenticate as the same sponsor and retry the retained confirmation. An already deleted account cannot be reopened." };
    }
    if (result.reason === "refused" && (result.status === 400 || result.status === 422)) {
      return { ok: false, recovery: "review", message: "The account service refused the confirmation. Load a fresh impact preview and review it before trying again." };
    }
    return uncertain;
  } catch {
    return uncertain;
  }
}
