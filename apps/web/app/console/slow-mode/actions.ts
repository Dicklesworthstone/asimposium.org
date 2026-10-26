"use server";

import {
  ProblemIdSchema,
  type ProblemSlowModeReceipt,
  type ProblemSlowModeRequest,
  ProblemSlowModeRequestSchema,
  type ProblemSlowModeState,
} from "@asimposium/contracts";
import {
  problemSlowModeSession,
  type SlowModeAudience,
  slowModeAuthIsRecent,
} from "@/lib/problem-slow-mode";
import { stoaChangeProblemSlowMode, stoaProblemSlowMode } from "@/lib/stoa";

export type SlowModeInput =
  | Omit<Extract<ProblemSlowModeRequest, { action: "set" }>, "step_up_authenticated_at" | "problem_id">
  | Omit<Extract<ProblemSlowModeRequest, { action: "clear" }>, "step_up_authenticated_at" | "problem_id">;

export type SlowModeActionResult =
  | { readonly ok: true; readonly receipt: ProblemSlowModeReceipt; readonly current: ProblemSlowModeState | null }
  | { readonly ok: false; readonly message: string; readonly retryable: boolean; readonly refreshRequired?: true };

/** A service envelope carries only this session's principal and authentication time. */
export async function changeProblemSlowMode(
  audience: SlowModeAudience,
  problemId: string,
  input: SlowModeInput,
  idempotencyKey: string,
): Promise<SlowModeActionResult> {
  const session = await problemSlowModeSession(audience);
  if (session.state !== "authorized") {
    return { ok: false, retryable: false, refreshRequired: true,
      message: session.state === "unauthenticated"
        ? "Sign in again before changing the publication limit."
        : "This account is not authorized for operator controls." };
  }
  if (!slowModeAuthIsRecent(session.authIssuedAt)) {
    return { ok: false, retryable: false, refreshRequired: true,
      message: "Re-authenticate with Google, then reload the current mode. Changes require authentication within the last 15 minutes." };
  }
  if (
    !ProblemIdSchema.safeParse(problemId).success ||
    !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey) ||
    typeof input !== "object" || input === null || Array.isArray(input) ||
    "step_up_authenticated_at" in input || "problem_id" in input
  ) return { ok: false, retryable: false, message: "The problem or command is invalid. Reload the current mode before trying again." };
  const command = ProblemSlowModeRequestSchema.safeParse({
    ...input,
    problem_id: problemId,
    step_up_authenticated_at: session.authIssuedAt,
  });
  if (!command.success) {
    return { ok: false, retryable: false,
      message: "Use a limit from 1 to 19, an explicit expiry, the displayed revision, and a reason of 10 to 1000 characters." };
  }
  const result = await stoaChangeProblemSlowMode(
    session.principalId, audience, problemId, command.data, idempotencyKey,
  );
  if (!result.ok) {
    if (result.reason === "unconfigured") {
      return { ok: false, retryable: false, message: "Publication limit controls are not configured on this deployment." };
    }
    if (result.reason === "refused" && result.status === 409) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "The mode changed or this retry key belongs to different settings. Reload the current mode and review it before making another change." };
    }
    if (result.reason === "refused" && result.status === 403) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "Stoa requires current authority and recent authentication. Re-authenticate, then reload the current mode." };
    }
    if (result.reason === "refused" && result.status === 404) {
      return { ok: false, retryable: false, refreshRequired: true,
        message: "The published problem is unavailable to this account. Sponsors must be its current explicit steward." };
    }
    if (result.reason === "refused" && result.status === 422) {
      return { ok: false, retryable: false,
        message: "Stoa refused these settings. Choose a future expiry no more than 24 hours away, a limit from 1 to 19, and an audit reason of 10 to 1000 characters." };
    }
    return { ok: false, retryable: true,
      message: "The change could not be confirmed. Retry these exact settings, or reload the current mode before starting another change." };
  }
  // A replayed receipt records the original command; it does not prove that
  // its temporary control is still active. Read the current state separately.
  const current = await stoaProblemSlowMode(session.principalId, audience, problemId);
  return {
    ok: true,
    receipt: result.data,
    current: current.ok && current.data.revision >= result.data.revision ? current.data : null,
  };
}
