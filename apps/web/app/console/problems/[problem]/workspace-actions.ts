"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {
  type ProblemWorkspaceCommand,
  type ProblemWorkspaceResult,
  parseProblemWorkspaceCommand,
  validWorkspaceKey,
} from "@/lib/problem-lifecycle";
import { recentAuthOk } from "@/lib/recent-auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaChangeProblemWorkspace } from "@/lib/stoa-problem-lifecycle";

/** The signed Worker is the sole authority for lifecycle, screening and replay. */
export async function changeProblemWorkspace(
  expectedSponsorId: string,
  problemId: string,
  input: ProblemWorkspaceCommand,
  key: string,
  confirmed: boolean,
): Promise<ProblemWorkspaceResult> {
  const uncertain: ProblemWorkspaceResult = {
    ok: false,
    retryable: true,
    retainAttempt: true,
    message:
      "The workspace change could not be confirmed. Recover the exact retained command before starting another change.",
  };
  try {
    const session = await auth();
    const sponsorId = session?.user?.id;
    if (!isCanonicalSponsorId(sponsorId) || sponsorId !== expectedSponsorId)
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        signInRequired: true,
        message:
          "Your sponsor account changed or expired. Sign in to the intended account and recover the saved command before continuing.",
      };
    if (!recentAuthOk(session?.authIssuedAt))
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        signInRequired: true,
        message:
          "Sign in again with Google before changing problem lineage or retiring a problem. Your exact saved command will remain available after sign-in.",
      };
    const command = parseProblemWorkspaceCommand(problemId, input);
    if (!command || !validWorkspaceKey(key) || confirmed !== true)
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        message:
          "Choose a valid workspace change and explicitly confirm its consequences. Forks copy the published formulation; sponsors cannot submit a replacement formulation here.",
      };
    const result = await stoaChangeProblemWorkspace(sponsorId, problemId, command, key);
    if (result.ok) {
      try {
        revalidatePath("/", "layout");
      } catch {
        /* The durable receipt still wins. */
      }
      return { ok: true, receipt: result.data };
    }
    if (result.screening) {
      const denied = result.screening.code === "POLICY_DENIED";
      return {
        ok: false,
        retryable: false,
        refreshRequired: true,
        message: denied
          ? "Screening declined this public governance change. Review the sponsor appeal path before proposing another change."
          : "This public governance change is held for screening review and has not been applied. Inspect the sponsor appeal path before trying again.",
      };
    }
    if (
      result.reason === "refused" &&
      result.status === 409 &&
      result.problemCode === "OBJECT_VERSION_CONFLICT"
    )
      return {
        ok: false,
        retryable: false,
        refreshRequired: true,
        message:
          "The problem, published formulation or merge target changed before this command committed. Refresh and inspect current state before confirming a new command.",
      };
    if (result.reason === "refused" && [401, 403, 404, 409].includes(result.status ?? 0))
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        refreshRequired: true,
        message:
          "Stoa could not authorize this command or its retry identity. Keep the saved command, check the current owner or steward account and recover the original outcome before starting another change.",
      };
    if (
      result.reason === "refused" &&
      result.problemCode !== undefined &&
      [400, 422].includes(result.status ?? 0)
    )
      return {
        ok: false,
        retryable: false,
        refreshRequired: true,
        message:
          "Stoa refused this workspace change. Check the current public formulation and lifecycle; a merge needs a different published, available canonical problem. Refresh before revising the command.",
      };
    if (result.reason === "refused" && result.status === 429)
      return {
        ...uncertain,
        message:
          "The workspace write budget is temporarily exhausted. Wait before recovering this unchanged command; no new retry identity is needed.",
      };
    if (result.reason === "unconfigured")
      return {
        ok: false,
        retryable: false,
        retainAttempt: true,
        message:
          "Workspace changes are not configured on this deployment. Keep the saved command for recovery when the connection is available.",
      };
    return uncertain;
  } catch {
    return uncertain;
  }
}
