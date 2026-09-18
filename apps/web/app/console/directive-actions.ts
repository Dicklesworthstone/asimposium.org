"use server";

import {
  SponsorDirectiveRequestSchema,
  type SponsorDirectiveReceipt,
  type SponsorDirectiveRequest,
} from "@asimposium/contracts/directives";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaIssueDirective } from "@/lib/stoa";

export type DirectiveActionResult =
  | { readonly ok: true; readonly receipt: SponsorDirectiveReceipt }
  | { readonly ok: false; readonly message: string };

export async function issueSponsorDirective(
  request: SponsorDirectiveRequest,
  idempotencyKey: string,
): Promise<DirectiveActionResult> {
  const session = await auth();
  if (!session?.user || !isCanonicalSponsorId(session.user.id)) {
    return { ok: false, message: "Sign in again before issuing a directive." };
  }
  const parsed = SponsorDirectiveRequestSchema.safeParse(request);
  if (!parsed.success || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey)) {
    return { ok: false, message: "The directive draft is invalid." };
  }
  const result = await stoaIssueDirective(session.user.id, parsed.data, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "Directive delivery is not configured on this deployment."
          : result.reason === "refused"
            ? "Stoa refused the directive. Refresh the console and check the Fellow assignment."
            : "Directive delivery could not be confirmed. Retry with the same draft.",
    };
  }
  return { ok: true, receipt: result.data };
}
