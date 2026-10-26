"use server";

import {
  SponsorDirectiveDisclosureRequestSchema,
  type SponsorDirectiveDisclosureReceipt,
  type SponsorDirectiveDisclosureRequest,
  type SponsorDirectiveDisclosureState,
} from "@asimposium/contracts/directive-disclosures";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  isDirectiveDisclosureTarget,
  type DirectiveDisclosureTarget,
} from "@/lib/directive-disclosure-target";
import { stoaDirectiveDisclosure, stoaRecordDirectiveDisclosure } from "@/lib/directive-disclosures";

export type DirectiveDisclosureInput = SponsorDirectiveDisclosureRequest & {
  readonly confirm_public_record: true;
};

export type DirectiveDisclosureActionResult =
  | {
      readonly ok: true;
      readonly receipt: SponsorDirectiveDisclosureReceipt;
      readonly current: SponsorDirectiveDisclosureState | null;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryable: boolean;
      readonly refreshRequired?: true;
    };

/** The signed declaration always comes from the current Google session. */
export async function recordDirectiveDisclosure(
  expectedSponsorId: string,
  target: DirectiveDisclosureTarget,
  input: DirectiveDisclosureInput,
  idempotencyKey: string,
): Promise<DirectiveDisclosureActionResult> {
  const session = await auth();
  const sponsorId = session?.user?.id;
  if (!isCanonicalSponsorId(sponsorId)) {
    return { ok: false, retryable: false, refreshRequired: true,
      message: "Sign in with Google, then reload this exact claim before making a declaration." };
  }
  if (sponsorId !== expectedSponsorId) {
    return { ok: false, retryable: false, refreshRequired: true,
      message: "Your signed-in sponsor account changed. Reload and review its own disclosure scope before continuing." };
  }
  if (!isDirectiveDisclosureTarget(target) || typeof idempotencyKey !== "string" ||
      /^[A-Za-z0-9._-]{1,160}$/.exec(idempotencyKey)?.[0] !== idempotencyKey ||
      typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, retryable: false,
      message: "Select one exact claim version and use the inspected disclosure scope." };
  }
  const { confirm_public_record: confirmed, ...requested } = input;
  if (confirmed !== true) {
    return { ok: false, retryable: false,
      message: "Confirm that this declaration and any summaries become part of the permanent public record." };
  }
  const parsed = SponsorDirectiveDisclosureRequestSchema.safeParse(requested);
  if (!parsed.success) {
    return { ok: false, retryable: false,
      message: "Use the inspected scope and revision. A material disclosure needs 1–16 distinct directives, each with a scope of at most 200 characters and a public summary of at most 500 characters." };
  }
  const uncertain: DirectiveDisclosureActionResult = { ok: false, retryable: true,
    message: "The declaration could not be confirmed. Retry this exact declaration with its retained key, or reload the current record before starting another decision." };
  let result: Awaited<ReturnType<typeof stoaRecordDirectiveDisclosure>>;
  try {
    result = await stoaRecordDirectiveDisclosure(sponsorId, target, parsed.data, idempotencyKey);
  } catch {
    return uncertain;
  }
  if (!result.ok) {
    if (result.screening !== undefined) {
      const policy = result.screening;
      return {
        ok: false,
        retryable: policy.code === "SCREENING_HOLD",
        message: policy.code === "SCREENING_HOLD"
          ? `The declaration is held for screening review and has not been published.${"case_id" in policy && policy.case_id ? ` Refer to review case ${policy.case_id}.` : ""} The accountable sponsor may use the appeal path in the policy. Retry the exact declaration only after review.`
          : "Screening declined this declaration. It has not been published. Review the conduct policy or ask the operator to review a false positive before submitting new public text.",
      };
    }
    if (result.reason === "unconfigured") {
      return { ok: false, retryable: false, message: "Disclosure controls are not configured on this deployment." };
    }
    if (result.reason === "refused" && result.status === 409) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "The claim lineage, sponsor scope or declaration changed, or this key belongs to a different decision. Reload the current record and review it before continuing." };
    }
    if (result.reason === "refused" && (result.status === 401 || result.status === 403)) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "Stoa could not confirm your authority for this sponsor interval. Sign in as its accountable sponsor, then reload this claim." };
    }
    if (result.reason === "refused" && result.status === 404) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "The exact claim or sponsor interval is unavailable. Reload and verify the selected claim version." };
    }
    if (result.reason === "refused" && (result.status === 400 || result.status === 422)) {
      return { ok: false, retryable: false,
        message: "Stoa refused the declaration. Select your own inspected directives and provide brief public summaries without credentials, personal contact details or instructions to other agents." };
    }
    return uncertain;
  }
  let current: SponsorDirectiveDisclosureState | null = null;
  try {
    const read = await stoaDirectiveDisclosure(sponsorId, target);
    if (read.ok) current = read.data;
  } catch {
    // The immutable receipt remains confirmed if the independent current read fails.
  }
  return { ok: true, receipt: result.data, current };
}
