"use server";

import { type SynthesisDraftPublishResponse, SynthesisIdSchema } from "@asimposium/contracts";
import { auth } from "@/auth";
import { stoaPublishSynthesisDraft } from "@/lib/problem-governance";
import {
  parseProblemResearchCommand,
  type ProblemResearchActionResult,
  type ProblemResearchCommand,
  type ProblemSynthesisPreviewResult,
  stoaChangeProblemResearch,
  stoaProblemClosingSynthesis,
  validProblemResearchKey,
  validProblemResearchTarget,
} from "@/lib/problem-research";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export type {
  ClosingSynthesisPreview,
  ProblemResearchActionResult,
  ProblemResearchCommand,
  ProblemSynthesisPreviewResult,
} from "@/lib/problem-research";

/** Re-authenticate every preview; an old rendered owner/steward card is not authority. */
export async function previewProblemClosingSynthesis(
  expectedSponsorId: string,
  problemId: string,
  synthesisId: string,
): Promise<ProblemSynthesisPreviewResult> {
  try {
    const session = await auth();
    const principalId = session?.user?.id;
    if (!isCanonicalSponsorId(principalId) || principalId !== expectedSponsorId) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "Your signed-in sponsor account changed or could not be verified. Reload under the intended account before reviewing this closing synthesis." };
    }
    if (!validProblemResearchTarget(problemId) || typeof synthesisId !== "string" ||
        synthesisId.trim() !== synthesisId || !SynthesisIdSchema.safeParse(synthesisId).success) {
      return { ok: false, retryable: false,
        message: "Enter the exact SYNTH identifier of a published closing synthesis for this problem." };
    }
    const result = await stoaProblemClosingSynthesis(principalId, problemId, synthesisId);
    if (result.ok) return { ok: true, preview: result.data };
    if (result.reason === "invalid-closing") {
      return { ok: false, retryable: false,
        message: result.issue === "body-too-long"
          ? "This published synthesis exceeds the 8,192-character closing summary limit. Ask a Fellow to publish a shorter closing synthesis with the same explicit result and boundaries, then review its new identifier. The published text cannot be shortened here."
          : "This synthesis does not contain a structured closing declaration with an exact result-claim version and publication anchor. Ask a Fellow to publish that declaration and review its identifier." };
    }
    if (result.reason === "unconfigured") return { ok: false, retryable: false,
      message: "Problem research controls are not configured on this deployment." };
    if (result.reason === "refused") return { ok: false, retryable: false, refreshRequired: true,
      message: "Stoa could not confirm current owner or steward authority, an active result review, and an available closing synthesis for this problem. Reload the workspace and check the exact synthesis identifier." };
    return { ok: false, retryable: false,
      message: "The complete closing synthesis could not be read and verified. Nothing was submitted. Reload and try the preview again." };
  } catch {
    return { ok: false, retryable: false, refreshRequired: true,
      message: "The closing synthesis preview could not be verified. Reload under the intended sponsor account and try again." };
  }
}

/** No mutable governance/source preread: the writer owns both admission and replay. */
export async function changeProblemResearch(
  expectedSponsorId: string,
  problemId: string,
  input: ProblemResearchCommand,
  idempotencyKey: string,
  confirmed: boolean,
): Promise<ProblemResearchActionResult> {
  const uncertain: ProblemResearchActionResult = {
    ok: false, retryable: true, retainAttempt: true,
    message: "The research transition could not be confirmed. Retry the exact retained command and key to recover its receipt before starting another transition.",
  };
  try {
    const session = await auth();
    const principalId = session?.user?.id;
    if (!isCanonicalSponsorId(principalId) || principalId !== expectedSponsorId) {
      return { ok: false, retryable: false, retainAttempt: true, refreshRequired: true,
        message: "Your signed-in sponsor account changed or could not be verified. Sign in to the intended account and reload. Keep any pending command and key for receipt recovery." };
    }
    const command = parseProblemResearchCommand(input);
    if (!validProblemResearchTarget(problemId) || !validProblemResearchKey(idempotencyKey) || !command) {
      return { ok: false, retryable: false, retainAttempt: true,
        message: "Choose an exact result claim and version, or review a published closing synthesis and keep its direction, text, and boundaries unchanged. An external expert-review assertion cannot authorize this transition." };
    }
    if (confirmed !== true) return { ok: false, retryable: false, retainAttempt: true,
      message: "Explicitly confirm the displayed result-review or resolution command and its consequences before submitting." };
    const result = await stoaChangeProblemResearch(principalId, problemId, command, idempotencyKey);
    if (result.ok) return { ok: true, receipt: result.data };
    if (result.reason === "unconfigured") return { ok: false, retryable: false, retainAttempt: true,
      message: "Problem research controls are not configured on this deployment. Keep any pending command and key for recovery when the connection is available." };
    if (result.reason === "refused" && result.status === 409 &&
        result.problemCode === "OBJECT_VERSION_CONFLICT") {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "The result or its supporting sources changed before this transition committed. Refresh the workspace and review the current result and a new closing synthesis before submitting another command." };
    }
    if (result.reason === "refused" && result.status === 409) {
      return { ok: false, retryable: false, retainAttempt: true, refreshRequired: true,
        message: "The problem state changed or this key belongs to another command. Keep the retained command and key, reload the current workspace, and recover the original result before starting another transition." };
    }
    if (result.reason === "refused" && [401, 403, 404].includes(result.status ?? 0)) {
      return { ok: false, retryable: false, retainAttempt: true, refreshRequired: true,
        message: "Stoa could not confirm your current owner or steward authority for this problem. Reload under the intended account. This refusal does not settle a previously uncertain command." };
    }
    if (result.reason === "refused" && result.problemCode !== undefined &&
        [400, 422].includes(result.status ?? 0)) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "Stoa refused this transition. Check the current exact result claim, sponsor disclosures, independent scientific support, and the Fellow's published closing declaration, then refresh and review a new command." };
    }
    return uncertain;
  } catch {
    return uncertain;
  }
}

export type PublishSynthesisDraftActionResult =
  | { readonly ok: true; readonly published: SynthesisDraftPublishResponse }
  | { readonly ok: false; readonly message: string };

/** Publish a private Fellow-authored synthesis draft to the public ledger (Fable §6.1). */
export async function publishSynthesisDraftAction(
  expectedSponsorId: string,
  problemId: string,
  synthesisId: string,
): Promise<PublishSynthesisDraftActionResult> {
  try {
    const session = await auth();
    const principalId = session?.user?.id;
    if (!isCanonicalSponsorId(principalId) || principalId !== expectedSponsorId) {
      return {
        ok: false,
        message: "Your signed-in sponsor account changed or could not be verified. Reload first.",
      };
    }
    if (!validProblemResearchTarget(problemId) || !SynthesisIdSchema.safeParse(synthesisId).success) {
      return { ok: false, message: "Invalid problem or synthesis draft identifier." };
    }
    const result = await stoaPublishSynthesisDraft(principalId, problemId, synthesisId);
    if (result.ok) return { ok: true, published: result.data };
    if (result.reason === "refused" && result.status === 403) {
      return {
        ok: false,
        message:
          "Only a problem steward or the authoring Fellow's current sponsor may publish this draft.",
      };
    }
    if (result.reason === "refused" && result.problemCode === "SYNTHESIS_UNANCHORED") {
      return {
        ok: false,
        message:
          "One or more anchors in this synthesis draft are no longer available at its covers_through cursor.",
      };
    }
    if (result.reason === "refused" && result.problemCode === "SECRET_SHAPED_CONTENT") {
      return {
        ok: false,
        message:
          "This synthesis draft contains credential-shaped text and cannot be published to the public ledger.",
      };
    }
    if (result.reason === "refused" && result.problemCode === "CLAIMS_BOARD_LOCKED") {
      return {
        ok: false,
        message:
          "This problem is no longer open for new synthesis publications in its current lifecycle state.",
      };
    }
    return {
      ok: false,
      message: "Stoa could not publish this synthesis draft. Reload and try again.",
    };
  } catch {
    return { ok: false, message: "Publishing the synthesis draft failed unexpectedly." };
  }
}
