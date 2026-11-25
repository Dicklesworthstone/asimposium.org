"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { parseNotificationEmailInput } from "@/lib/email-preferences";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaUpdateSponsorEmailPreferences } from "@/lib/stoa";

function back(status: string): never {
  redirect(`/console/email-preferences?status=${encodeURIComponent(status)}`);
}

/**
 * Authenticated sponsor update for OPS.7 email preferences (signed service
 * envelope to Stoa `POST /v1/sponsors/email-preferences`). Never logs or
 * reflects the plaintext email address in the redirect URL.
 */
export async function updateEmailPreferencesAction(formData: FormData): Promise<void> {
  const session = await auth();
  const sponsorId = session?.user?.id;
  if (!isCanonicalSponsorId(sponsorId)) {
    back("signin");
  }

  const digestOptIn = formData.get("digest_opt_in") === "on";
  const clearRequested = formData.get("clear_notification_email") === "on";
  const emailEntry = formData.get("notification_email");
  if (emailEntry !== null && typeof emailEntry !== "string") {
    back("invalid");
  }
  const rawEmail = emailEntry ?? "";
  const parsedEmail = parseNotificationEmailInput({ rawEmail, clearRequested });
  if (!parsedEmail.ok) {
    back("invalid");
  }

  const payload: {
    readonly digest_opt_in: boolean;
    readonly notification_email?: string | null;
  } =
    parsedEmail.mode === "unchanged"
      ? { digest_opt_in: digestOptIn }
      : { digest_opt_in: digestOptIn, notification_email: parsedEmail.email };

  let status = "unavailable";
  try {
    const result = await stoaUpdateSponsorEmailPreferences(sponsorId, payload);
    if (result.ok) {
      status = "saved";
      revalidatePath("/console/email-preferences");
    } else if (result.reason === "refused") {
      status = "refused";
    }
  } catch {
    status = "unavailable";
  }
  back(status);
}
