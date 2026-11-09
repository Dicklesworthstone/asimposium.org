"use server";

import type {
  ProblemLifecycleActionRequest,
  ProblemPublicationResponse,
  SaveProblemBriefRequest,
  SponsorProblemBrief,
  WithdrawProblemBriefResponse,
} from "@asimposium/contracts";
import {
  ProblemLifecycleActionRequestSchema,
  PublicLedgerProblemIdSchema,
  SaveProblemBriefRequestSchema,
  WithdrawProblemBriefRequestSchema,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {
  PROBLEM_BRIEF_FORM_ERROR,
  type ProblemBriefEditSource,
  type ProblemBriefFields,
  problemBriefRequest,
} from "@/lib/problem-briefs";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  type StoaCall,
  stoaPublishProblem,
  stoaSaveProblemBrief,
  stoaWithdrawProblemBrief,
} from "@/lib/stoa";

export type ProblemActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly recovery: "edit" | "reload" | "retry";
    };

const KEY = /^[A-Za-z0-9._-]{1,160}$/;

/**
 * Split the console's comma-separated area field into canonical slugs. The
 * Worker's contract is the authority; this only shapes the form input.
 */
export async function briefRequestFromForm(
  input: ProblemBriefFields,
  source?: ProblemBriefEditSource,
): Promise<SaveProblemBriefRequest | null> {
  return problemBriefRequest(input, source);
}

async function sponsorId(): Promise<string | null> {
  const session = await auth();
  return session?.user && isCanonicalSponsorId(session.user.id) ? session.user.id : null;
}

/** Save a private brief. It is governance intent, never a public scientific object. */
export async function saveProblemBrief(
  expectedSponsorId: string,
  request: SaveProblemBriefRequest,
  idempotencyKey: string,
): Promise<ProblemActionResult<SponsorProblemBrief>> {
  try {
    const principal = await sponsorId();
    if (
      principal === null ||
      !isCanonicalSponsorId(expectedSponsorId) ||
      principal !== expectedSponsorId
    ) {
      return briefIdentityRefusal();
    }
    const parsed = SaveProblemBriefRequestSchema.safeParse(request);
    if (!parsed.success || !KEY.test(idempotencyKey)) {
      return { ok: false, recovery: "edit", message: PROBLEM_BRIEF_FORM_ERROR };
    }
    const result = await stoaSaveProblemBrief(principal, parsed.data, idempotencyKey);
    if (!result.ok) return briefMutationRefusal(result);
    try {
      revalidatePath("/console");
    } catch {
      /* The durable receipt still stands. */
    }
    return { ok: true, value: result.data };
  } catch {
    return briefMutationUncertain();
  }
}

/** Withdrawal is a version-pinned private change, never a problem retraction. */
export async function withdrawProblemBrief(
  expectedSponsorId: string,
  briefId: string,
  expectedVersion: number,
  idempotencyKey: string,
  confirmed: boolean,
): Promise<ProblemActionResult<WithdrawProblemBriefResponse>> {
  try {
    const principal = await sponsorId();
    if (
      principal === null ||
      !isCanonicalSponsorId(expectedSponsorId) ||
      principal !== expectedSponsorId
    ) {
      return briefIdentityRefusal();
    }
    const parsed = WithdrawProblemBriefRequestSchema.safeParse({
      expected_version: expectedVersion,
    });
    if (
      confirmed !== true ||
      typeof briefId !== "string" ||
      briefId.length < 1 ||
      briefId.length > 128 ||
      !parsed.success ||
      !KEY.test(idempotencyKey)
    ) {
      return {
        ok: false,
        recovery: "edit",
        message:
          "Confirm withdrawing this exact private brief before continuing. Reload the brief if its review is no longer current.",
      };
    }
    const result = await stoaWithdrawProblemBrief(principal, briefId, parsed.data, idempotencyKey);
    if (!result.ok) return briefMutationRefusal(result);
    try {
      revalidatePath("/console");
    } catch {
      /* The durable receipt still stands. */
    }
    return { ok: true, value: result.data };
  } catch {
    return briefMutationUncertain();
  }
}

function briefMutationUncertain(): ProblemActionResult<never> {
  return {
    ok: false,
    recovery: "retry",
    message:
      "The brief change could not be confirmed. Retry the same change to recover its result; do not assume that it was not saved.",
  };
}

function briefIdentityRefusal(): ProblemActionResult<never> {
  return {
    ok: false,
    recovery: "retry",
    message:
      "Your signed-in sponsor account changed or could not be verified. Sign in to the intended account before retrying this unchanged brief command.",
  };
}

function briefMutationRefusal(
  result: Extract<StoaCall<unknown>, { ok: false }>,
): ProblemActionResult<never> {
  if (result.reason === "unconfigured") {
    return {
      ok: false,
      recovery: "reload",
      message: "Problem briefs are not configured on this deployment.",
    };
  }
  if (
    result.reason !== "refused" ||
    result.problemCode === undefined ||
    (result.status ?? 0) >= 500 ||
    result.status === 429
  ) {
    return briefMutationUncertain();
  }
  if (result.status === 409 || result.status === 404) {
    return {
      ok: false,
      recovery: "reload",
      message:
        result.problemCode === "IDEMPOTENCY_CONFLICT"
          ? "This retry does not match its original change. Reload and inspect the current brief before starting a new change."
          : "This brief changed, was adopted, or is no longer editable. Your edits remain here; reload the current brief before changing or withdrawing it.",
    };
  }
  if (
    (result.status === 401 || result.status === 403) &&
    result.problemCode !== "BRIEF_NOT_ASSIGNED"
  ) {
    return briefIdentityRefusal();
  }
  return {
    ok: false,
    recovery: "edit",
    message:
      "Stoa refused the brief. Check its required fields and that the assigned Fellow is one of your active Fellows.",
  };
}

export type ReviewedProblemPublication = Extract<
  ProblemLifecycleActionRequest,
  { action: "publish" }
>;
export type ProblemPublicationActionState =
  | { readonly status: "idle" }
  | { readonly status: "committed"; readonly receipt: ProblemPublicationResponse }
  | { readonly status: "refused"; readonly message: string; readonly reviewRequired: boolean };

/** Current identity, explicit consent, and the exact review pin are checked on every retry. */
export async function publishProblem(
  expectedSponsorId: string,
  problemId: string,
  reviewed: ReviewedProblemPublication,
  _previous: ProblemPublicationActionState,
  formData: FormData,
): Promise<ProblemPublicationActionState> {
  const uncertain: ProblemPublicationActionState = {
    status: "refused",
    reviewRequired: false,
    message:
      "Publication could not be confirmed. Retry this same reviewed formulation to recover its receipt, or reload the console to inspect its current state. Do not assume it remained private.",
  };
  try {
    const principal = await sponsorId();
    if (principal === null || principal !== expectedSponsorId) {
      return {
        status: "refused",
        reviewRequired: true,
        message:
          "Your signed-in sponsor account changed or could not be verified. Sign in to the intended account and reload the formulation before publishing.",
      };
    }
    if (
      formData.getAll("confirm_publication").length !== 1 ||
      formData.get("confirm_publication") !== "yes"
    ) {
      return {
        status: "refused",
        reviewRequired: false,
        message:
          "Confirm that you reviewed this exact formulation and accept its permanent public disclosure, CC BY 4.0 terms, and patent-disclosure consequences.",
      };
    }
    const parsed = ProblemLifecycleActionRequestSchema.safeParse(reviewed);
    if (
      !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
      typeof problemId !== "string" ||
      problemId.trim() !== problemId ||
      !parsed.success ||
      parsed.data.action !== "publish"
    ) {
      return {
        status: "refused",
        reviewRequired: true,
        message:
          "The reviewed publication is invalid. Reload the complete private formulation before confirming.",
      };
    }
    const result = await stoaPublishProblem(
      principal,
      problemId,
      parsed.data,
      `console-publish-${parsed.data.reviewed_digest}`,
    );
    if (result.ok) {
      try {
        revalidatePath("/console");
      } catch {
        /* A refresh failure cannot erase the durable receipt. */
      }
      return { status: "committed", receipt: result.data };
    }
    if (result.screening !== undefined) {
      return {
        status: "refused",
        reviewRequired: result.screening.code !== "SCREENING_HOLD",
        message:
          result.screening.code === "SCREENING_HOLD"
            ? `Publication is held for screening review and has not been confirmed.${"case_id" in result.screening && result.screening.case_id ? ` Refer to case ${result.screening.case_id}.` : ""} The accountable sponsor may use the appeal path in the policy. Retry this exact formulation after review.`
            : "Screening declined publication. Ask the operator to review a false positive or direct the Fellow to revise the private formulation, then inspect it again.",
      };
    }
    if (result.reason === "unconfigured") {
      return {
        status: "refused",
        reviewRequired: true,
        message: "Problem publication is not configured on this deployment.",
      };
    }
    if (result.reason === "refused" && result.status === 409) {
      return {
        status: "refused",
        reviewRequired: true,
        message:
          "The formulation, its authorship, governance, or publication state changed after your review. Reload and inspect the current formulation before confirming again.",
      };
    }
    if (result.reason === "refused" && [400, 401, 403, 404, 422].includes(result.status ?? 0)) {
      return {
        status: "refused",
        reviewRequired: true,
        message:
          "Stoa refused this publication. Verify your sponsor or steward authority, the proposing Fellow's active status, and the current private formulation before trying again.",
      };
    }
    return uncertain;
  } catch {
    return uncertain;
  }
}
