import "server-only";

import {
  type ProblemLifecycleActionRequest,
  ProblemLifecycleActionRequestSchema,
  type ProblemResolutionResponse,
  ProblemResolutionResponseSchema,
  type ProblemResultReviewResponse,
  ProblemResultReviewResponseSchema,
  PublicLedgerProblemIdSchema,
  SingleSynthesisResponseSchema,
  SynthesisIdSchema,
  type SynthesisItem,
} from "@asimposium/contracts";
import { stoaProblemGovernance } from "./problem-governance";
import {
  callStoa,
  configuredStoaOrigin,
  readBoundedStoaJson,
  STOA_RESPONSE_READ_TIMEOUT_MS,
  type StoaCall,
} from "./stoa";

export type ProblemResearchCommand = Extract<
  ProblemLifecycleActionRequest,
  { action: "enter-result-review" | "resolve" }
>;
export type ProblemResearchReceipt = ProblemResultReviewResponse | ProblemResolutionResponse;
export interface ClosingSynthesisPreview {
  readonly synthesis: SynthesisItem;
  readonly command: Extract<ProblemResearchCommand, { action: "resolve" }> & {
    readonly closing_synthesis: { readonly synthesis_id: string };
  };
}
export type ProblemResearchActionResult =
  | { readonly ok: true; readonly receipt: ProblemResearchReceipt }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryable: boolean;
      readonly refreshRequired?: true;
      /** This call did not settle a previously uncertain attempt. */
      readonly retainAttempt?: true;
    };
export type ProblemSynthesisPreviewResult =
  | { readonly ok: true; readonly preview: ClosingSynthesisPreview }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryable: false;
      readonly refreshRequired?: true;
    };

export const MAX_PROBLEM_CLOSING_SYNTHESIS_BYTES = 262_144;
type ClosingSynthesisRead = StoaCall<ClosingSynthesisPreview> | {
  readonly ok: false;
  readonly reason: "invalid-closing";
  readonly issue: "body-too-long" | "missing-declaration" | "invalid-reference";
};

export function validProblemResearchTarget(problemId: unknown): problemId is string {
  return typeof problemId === "string" && problemId.trim() === problemId &&
    PublicLedgerProblemIdSchema.safeParse(problemId).success;
}

export function validProblemResearchKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9._-]{1,160}$/.exec(key)?.[0] === key;
}

/** The console supports ordinary resolution using an existing Fellow work product. */
export function parseProblemResearchCommand(input: unknown): ProblemResearchCommand | undefined {
  const parsed = ProblemLifecycleActionRequestSchema.safeParse(input);
  if (!parsed.success) return undefined;
  if (parsed.data.action === "enter-result-review") {
    return parsed.data.result_claim.claim_id.trim() === parsed.data.result_claim.claim_id &&
      Number.isSafeInteger(parsed.data.result_claim.version) ? parsed.data : undefined;
  }
  if (parsed.data.action !== "resolve" || parsed.data.closing_synthesis.synthesis_id === undefined ||
      parsed.data.closing_synthesis.synthesis_id.trim() !== parsed.data.closing_synthesis.synthesis_id ||
      parsed.data.external_expert_review_proof !== undefined) return undefined;
  return parsed.data;
}

function discard(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Best effort only. */ }
}

/** Preview is a fresh read, not an eligibility promise or a retry prerequisite. */
export async function stoaProblemClosingSynthesis(
  principalId: string,
  problemId: string,
  synthesisId: string,
): Promise<ClosingSynthesisRead> {
  if (!validProblemResearchTarget(problemId) || typeof synthesisId !== "string" ||
      synthesisId.trim() !== synthesisId || !SynthesisIdSchema.safeParse(synthesisId).success) {
    return { ok: false, reason: "refused", status: 400 };
  }
  const governance = await stoaProblemGovernance(principalId, problemId);
  if (!governance.ok) return governance;
  if ((!governance.data.authority.owner && !governance.data.authority.steward) ||
      governance.data.problem.status !== "under-result-review") {
    return { ok: false, reason: "refused", status: 422 };
  }
  const origin = configuredStoaOrigin();
  if (origin === undefined) return { ok: false, reason: "unconfigured" };
  const path = `/p/${encodeURIComponent(problemId)}/syntheses/${encodeURIComponent(synthesisId)}.json`;
  try {
    const deadline = performance.now() + STOA_RESPONSE_READ_TIMEOUT_MS;
    const response = await fetch(`${origin}${path}`, {
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
      headers: { accept: "application/json",
        "user-agent": "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)" },
      signal: AbortSignal.timeout(STOA_RESPONSE_READ_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      discard(response);
      return response.status === 404
        ? { ok: false, reason: "refused", status: 404 }
        : { ok: false, reason: "unreachable" };
    }
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining < 1) {
      discard(response);
      return { ok: false, reason: "unreachable" };
    }
    const parsed = SingleSynthesisResponseSchema.safeParse(await readBoundedStoaJson(
      response, MAX_PROBLEM_CLOSING_SYNTHESIS_BYTES,
      Math.min(STOA_RESPONSE_READ_TIMEOUT_MS, remaining),
    ));
    if (!parsed.success) return { ok: false, reason: "unreachable" };
    const synthesis = parsed.data.synthesis;
    if (synthesis.problem_id !== problemId || synthesis.synthesis_id !== synthesisId)
      return { ok: false, reason: "unreachable" };
    const declaration = synthesis.closing_resolution;
    if (!declaration)
      return { ok: false, reason: "invalid-closing", issue: "missing-declaration" };
    if (synthesis.body_md.length > 8192)
      return { ok: false, reason: "invalid-closing", issue: "body-too-long" };
    if (!Number.isSafeInteger(synthesis.seq) || !Number.isSafeInteger(synthesis.covers_through) ||
        synthesis.covers_through >= synthesis.seq || !synthesis.anchors.some((anchor) =>
          anchor.target_kind === "claim" && anchor.target_id === declaration.result_claim.claim_id &&
          anchor.target_version === declaration.result_claim.version &&
          anchor.target_seq !== undefined && Number.isSafeInteger(anchor.target_seq) &&
          anchor.target_seq <= synthesis.covers_through)) {
      return { ok: false, reason: "invalid-closing", issue: "invalid-reference" };
    }
    const command = parseProblemResearchCommand({
      action: "resolve", direction: declaration.direction,
      closing_synthesis: {
        synthesis_id: synthesis.synthesis_id,
        summary: synthesis.body_md,
        no_claim_boundary: declaration.no_claim_boundary,
      },
    });
    if (!command || command.action !== "resolve" || command.closing_synthesis.synthesis_id === undefined)
      return { ok: false, reason: "invalid-closing", issue: "invalid-reference" };
    return { ok: true, data: { synthesis, command: {
      ...command, closing_synthesis: { ...command.closing_synthesis, synthesis_id: synthesis.synthesis_id },
    } } };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/** Send the retained command directly so mutable state cannot block sealed replay. */
export function stoaChangeProblemResearch(
  principalId: string,
  problemId: string,
  input: ProblemResearchCommand,
  idempotencyKey: string,
): Promise<StoaCall<ProblemResearchReceipt>> {
  const command = parseProblemResearchCommand(input);
  if (!validProblemResearchTarget(problemId) || !validProblemResearchKey(idempotencyKey) || !command)
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  const path = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/lifecycle`;
  return callStoa<ProblemResearchReceipt>({
    method: "POST", route: path, path, action: "problem-lifecycle", principalId,
    body: JSON.stringify(command), idempotencyKey, responseMaxBytes: 262_144,
    parse: (value) => {
      if (command.action === "enter-result-review") {
        const receipt = ProblemResultReviewResponseSchema.parse(value);
        if (receipt.problem.id !== problemId ||
            receipt.problem.result_claim.claim_id !== command.result_claim.claim_id ||
            receipt.problem.result_claim.version !== command.result_claim.version)
          throw new Error("Result-review receipt does not match the confirmed result.");
        return receipt;
      }
      const receipt = ProblemResolutionResponseSchema.parse(value);
      const result = receipt.problem;
      if (result.id !== problemId || result.resolution_direction !== command.direction ||
          result.resolution_summary !== command.closing_synthesis.summary ||
          result.closing_synthesis.synthesis_id !== command.closing_synthesis.synthesis_id ||
          JSON.stringify(result.resolution_no_claim_boundary) !==
            JSON.stringify(command.closing_synthesis.no_claim_boundary))
        throw new Error("Resolution receipt does not match the exact confirmed closing synthesis.");
      return receipt;
    },
  });
}
