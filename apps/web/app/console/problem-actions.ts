"use server";

import type {
  ProblemLifecycleActionRequest,
  ProblemPublicationResponse,
  SaveProblemBriefRequest,
  SponsorProblemBrief,
} from "@asimposium/contracts";
import { ProblemLifecycleActionRequestSchema, PublicLedgerProblemIdSchema, SaveProblemBriefRequestSchema } from "@asimposium/contracts";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaPublishProblem, stoaSaveProblemBrief } from "@/lib/stoa";

export type ProblemActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const KEY = /^[A-Za-z0-9._-]{1,160}$/;

/**
 * Split the console's comma-separated area field into canonical slugs. The
 * Worker's contract is the authority; this only shapes the form input.
 */
export async function briefRequestFromForm(input: {
  readonly title: string;
  readonly statement: string;
  readonly falsifier: string;
  readonly motivation: string;
  readonly areas: string;
  readonly assignedFellowId: string;
}): Promise<SaveProblemBriefRequest | null> {
  const areas = input.areas
    .split(",")
    .map((area) => area.trim().toLowerCase())
    .filter((area) => area.length > 0);
  const parsed = SaveProblemBriefRequestSchema.safeParse({
    title: input.title.trim(),
    statement: input.statement.trim(),
    falsifier: input.falsifier.trim(),
    motivation: input.motivation.trim(),
    areas,
    ...(input.assignedFellowId === "" ? {} : { assigned_fellow_id: input.assignedFellowId }),
  });
  return parsed.success ? parsed.data : null;
}

async function sponsorId(): Promise<string | null> {
  const session = await auth();
  return session?.user && isCanonicalSponsorId(session.user.id) ? session.user.id : null;
}

/** Save a private brief. It is governance intent, never a public scientific object. */
export async function saveProblemBrief(
  request: SaveProblemBriefRequest,
  idempotencyKey: string,
): Promise<ProblemActionResult<SponsorProblemBrief>> {
  const principal = await sponsorId();
  if (principal === null) return { ok: false, message: "Sign in again before saving a brief." };
  const parsed = SaveProblemBriefRequestSchema.safeParse(request);
  if (!parsed.success || !KEY.test(idempotencyKey)) {
    return {
      ok: false,
      message:
        "The brief is incomplete. Give a title, statement, falsifier, motivation and at least one area.",
    };
  }
  const result = await stoaSaveProblemBrief(principal, parsed.data, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "Problem briefs are not configured on this deployment."
          : result.reason === "refused"
            ? "Stoa refused the brief. Check that the assigned Fellow is one of your active Fellows."
            : "The brief could not be confirmed. Retry with the same draft.",
    };
  }
  return { ok: true, value: result.data };
}

export type ReviewedProblemPublication = Extract<ProblemLifecycleActionRequest, { action: "publish" }>;
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
    status: "refused", reviewRequired: false,
    message: "Publication could not be confirmed. Retry this same reviewed formulation to recover its receipt, or reload the console to inspect its current state. Do not assume it remained private.",
  };
  try {
    const principal = await sponsorId();
    if (principal === null || principal !== expectedSponsorId) {
      return { status: "refused", reviewRequired: true,
        message: "Your signed-in sponsor account changed or could not be verified. Sign in to the intended account and reload the formulation before publishing." };
    }
    if (formData.getAll("confirm_publication").length !== 1 ||
        formData.get("confirm_publication") !== "yes") {
      return { status: "refused", reviewRequired: false,
        message: "Confirm that you reviewed this exact formulation and accept its permanent public disclosure, CC BY 4.0 terms, and patent-disclosure consequences." };
    }
    const parsed = ProblemLifecycleActionRequestSchema.safeParse(reviewed);
    if (!PublicLedgerProblemIdSchema.safeParse(problemId).success ||
        typeof problemId !== "string" || problemId.trim() !== problemId ||
        !parsed.success || parsed.data.action !== "publish") {
      return { status: "refused", reviewRequired: true,
        message: "The reviewed publication is invalid. Reload the complete private formulation before confirming." };
    }
    const result = await stoaPublishProblem(principal, problemId, parsed.data,
      `console-publish-${parsed.data.reviewed_digest}`);
    if (result.ok) {
      try { revalidatePath("/console"); } catch { /* A refresh failure cannot erase the durable receipt. */ }
      return { status: "committed", receipt: result.data };
    }
    if (result.screening !== undefined) {
      return { status: "refused", reviewRequired: result.screening.code !== "SCREENING_HOLD",
        message: result.screening.code === "SCREENING_HOLD"
          ? `Publication is held for screening review and has not been confirmed.${"case_id" in result.screening && result.screening.case_id ? ` Refer to case ${result.screening.case_id}.` : ""} The accountable sponsor may use the appeal path in the policy. Retry this exact formulation after review.`
          : "Screening declined publication. Ask the operator to review a false positive or direct the Fellow to revise the private formulation, then inspect it again." };
    }
    if (result.reason === "unconfigured") {
      return { status: "refused", reviewRequired: true,
        message: "Problem publication is not configured on this deployment." };
    }
    if (result.reason === "refused" && result.status === 409) {
      return { status: "refused", reviewRequired: true,
        message: "The formulation, its authorship, governance, or publication state changed after your review. Reload and inspect the current formulation before confirming again." };
    }
    if (result.reason === "refused" && [400, 401, 403, 404, 422].includes(result.status ?? 0)) {
      return { status: "refused", reviewRequired: true,
        message: "Stoa refused this publication. Verify your sponsor or steward authority, the proposing Fellow's active status, and the current private formulation before trying again." };
    }
    return uncertain;
  } catch {
    return uncertain;
  }
}
