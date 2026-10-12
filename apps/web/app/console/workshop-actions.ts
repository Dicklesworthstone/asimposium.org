"use server";

import {
  type SponsorWorkshopMutationRequest,
  SponsorWorkshopMutationRequestSchema,
  type SponsorWorkshopMutationResponse,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaSponsorWorkshopMutation } from "@/lib/stoa";
import { workshopPageHref } from "@/lib/workshop-page";

export type WorkshopActionState =
  | { readonly status: "idle" }
  | {
      readonly status: "refused";
      readonly message: string;
      readonly code?: string;
      readonly rule?: string;
      readonly fixHint?: string;
      readonly currentVersion?: number;
    }
  | { readonly status: "committed"; readonly receipt: SponsorWorkshopMutationResponse };

/** The browser supplies a pinned reference and an action, never scientific text. */
export async function applyWorkshopAction(
  expectedSponsorId: string,
  target: Omit<SponsorWorkshopMutationRequest, "action">,
  _previous: WorkshopActionState,
  form: FormData,
): Promise<WorkshopActionState> {
  const session = await auth();
  if (!session?.user || !isCanonicalSponsorId(session.user.id)) {
    return { status: "refused", message: "Sign in again before changing a workshop draft." };
  }
  if (session.user.id !== expectedSponsorId) {
    return {
      status: "refused",
      message: "Your signed-in account changed. Reload this workshop before continuing.",
    };
  }
  const command = SponsorWorkshopMutationRequestSchema.safeParse({
    ...target,
    action: form.getAll("action").length === 1 ? form.get("action") : undefined,
  });
  if (!command.success) {
    return {
      status: "refused",
      message: "This workshop action is invalid. Refresh the draft and try again.",
    };
  }
  if (command.data.action === "promote" && form.get("confirm_promotion") !== "yes") {
    return {
      status: "refused",
      message: "Confirm publication of this stored Fellow-authored revision before promoting.",
    };
  }
  // The same action on the same pinned revision is one logical command, even
  // across a browser reload or an ambiguous response. No private draft needs
  // to be copied into browser storage to make a retry safe.
  const key = `workshop-${command.data.action}-${command.data.workshop_id}-v${command.data.expected_workshop_version}`;
  let result: Awaited<ReturnType<typeof stoaSponsorWorkshopMutation>>;
  try {
    result = await stoaSponsorWorkshopMutation(session.user.id, command.data, key);
  } catch {
    return {
      status: "refused",
      message:
        "The action could not be confirmed. Retry the same action; the pinned revision prevents a duplicate change.",
    };
  }
  if (!result.ok) {
    if (result.screening) {
      const screening = result.screening;
      if (screening.code === "POLICY_DENIED") {
        return {
          status: "refused",
          message: `Screening declined publication (category: ${screening.coarse_category}). The scientific record has not been published.`,
          code: screening.code,
          fixHint:
            "A sponsor appeal is available. Ask a trained operator to review the decision before submitting this revision again.",
        };
      }
      const postureHold = "posture" in screening;
      return {
        status: "refused",
        message: postureHold
          ? "This Fellow's public writes are held for review. The scientific record has not been published."
          : `Publication is held for review (category: ${screening.coarse_category}). The scientific record has not been published.`,
        code: screening.code,
        fixHint: [
          postureHold ? "Review the Fellow's screening posture in the sponsor console." : "",
          "A sponsor appeal is available.",
          screening.case_id
            ? `Refer to review case ${screening.case_id} and wait for its decision before trying to publish this revision again.`
            : "No review case was confirmed. Ask a trained operator to review the hold before submitting this revision again.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    return {
      status: "refused",
      message:
        result.reason === "unconfigured"
          ? "Workshop actions are not configured on this deployment."
          : result.reason === "refused" && result.detail
            ? result.detail
            : "The action could not be confirmed. Retry the same action; the pinned revision prevents a duplicate change.",
      ...(result.problemCode === undefined ? {} : { code: result.problemCode }),
      ...(result.repair === undefined ? {} : result.repair),
    };
  }
  try {
    revalidatePath(workshopPageHref(command.data.fellow_id, command.data.problem_id));
    revalidatePath("/console");
  } catch {
    // A failed UI refresh cannot turn a durable Worker receipt into a failure.
  }
  return { status: "committed", receipt: result.data };
}
