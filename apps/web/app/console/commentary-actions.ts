"use server";

import {
  type CommentaryItem,
  SponsorCommentaryPostRequestSchema,
  SponsorCommentaryTombstoneRequestSchema,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { commentaryPageHref } from "@/lib/commentary-page";
import { stoaFetchProblemFace } from "@/lib/public-ledger";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  type StoaCall,
  stoaBootstrapSponsor,
  stoaPostCommentary,
  stoaTombstoneCommentary,
} from "@/lib/stoa";

export type CommentaryActionState =
  | { readonly status: "idle" }
  | {
      readonly status: "refused";
      readonly message: string;
      readonly code?: string;
      readonly fixHint?: string;
      readonly attemptId?: string;
      readonly uncertain?: boolean;
      readonly action?: "post" | "tombstone";
    }
  | {
      readonly status: "committed";
      readonly action: "post" | "tombstone";
      readonly attemptId: string;
      readonly receipt: CommentaryItem;
    };

export interface CommentaryActionTarget {
  readonly problemId: string;
  /** The exact immutable entry to correct or remove; never infer a newer head. */
  readonly commentaryId?: string;
}

function singleString(form: FormData, key: string): string | undefined {
  const values = form.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}

function references(form: FormData): unknown {
  const kinds = form.getAll("reference_kind");
  const ids = form.getAll("reference_id");
  const labels = form.getAll("reference_label");
  if (kinds.length !== ids.length || labels.length !== ids.length || ids.length > 10) return null;
  const result: { kind: string; id: string; label?: string }[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const kind = kinds[i];
    const id = ids[i];
    const label = labels[i];
    if (typeof kind !== "string" || typeof id !== "string" || typeof label !== "string")
      return null;
    if (id.trim() === "" && label.trim() === "") continue;
    result.push({ kind, id, ...(label.trim() === "" ? {} : { label }) });
  }
  return result;
}

function refused(
  result: Extract<StoaCall<unknown>, { ok: false }>,
  attemptId: string,
  action: "post" | "tombstone",
): CommentaryActionState {
  if (result.screening) {
    return {
      status: "refused",
      attemptId,
      action,
      code: result.screening.code,
      message:
        result.screening.code === "POLICY_DENIED"
          ? `Screening declined this commentary (category: ${result.screening.coarse_category}). It has not been published.`
          : "This commentary has not been published and is awaiting review.",
      fixHint:
        "Ask a trained operator to review the screening decision before submitting the same text again.",
    };
  }
  const uncertain =
    result.reason === "unreachable" || (result.status !== undefined && result.status >= 500);
  return {
    status: "refused",
    attemptId,
    action,
    uncertain,
    message:
      result.reason === "unconfigured"
        ? "Commentary is not configured on this deployment."
        : uncertain
          ? "The commentary action could not be confirmed. Keep this request unchanged and retry to recover its receipt."
          : (result.detail ??
            "The Worker refused this commentary action. Refresh the discussion before trying again."),
    ...(result.problemCode === undefined ? {} : { code: result.problemCode }),
    ...(result.repair?.fixHint === undefined ? {} : { fixHint: result.repair.fixHint }),
  };
}

async function performCommentaryAction(
  expectedSponsorId: string,
  target: CommentaryActionTarget,
  form: FormData,
): Promise<CommentaryActionState> {
  const session = await auth();
  if (!session?.user || !isCanonicalSponsorId(session.user.id))
    return { status: "refused", message: "Sign in with Google before posting sponsor commentary." };
  if (session.user.id !== expectedSponsorId)
    return {
      status: "refused",
      message: "Your signed-in account changed. Reload the discussion before continuing.",
    };
  const sponsorId = session.user.id;
  if (target === null || typeof target !== "object")
    return {
      status: "refused",
      message: "This commentary target is invalid. Reload the discussion.",
    };
  if (!(form instanceof FormData))
    return {
      status: "refused",
      message: "This commentary form is invalid. Reload the discussion.",
    };

  const action = singleString(form, "action");
  const attemptId = singleString(form, "attempt_id");
  if (
    !attemptId ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(attemptId) ||
    (action !== "post" && action !== "tombstone")
  )
    return {
      status: "refused",
      message: "This commentary action is invalid. Reload the discussion and try again.",
    };

  const command =
    action === "post"
      ? SponsorCommentaryPostRequestSchema.safeParse({
          problem_id: target.problemId,
          body: singleString(form, "body"),
          relates_to: references(form),
          ...(target.commentaryId === undefined
            ? {}
            : { supersedes_commentary_id: target.commentaryId }),
        })
      : SponsorCommentaryTombstoneRequestSchema.safeParse({
          problem_id: target.problemId,
          commentary_id: target.commentaryId,
          reason: "author_request",
        });
  if (!command.success)
    return {
      status: "refused",
      attemptId,
      message: "Use 1–2,000 characters of commentary and at most ten valid references.",
    };
  if (action === "tombstone" && singleString(form, "confirm_removal") !== "yes")
    return {
      status: "refused",
      attemptId,
      message: "Confirm removal of this entry's public text before continuing.",
    };

  // The public face is read without a sponsor credential. A private problem
  // cannot become a commentary destination through a forged form or link.
  const problemId = command.data.problem_id;
  let face: Awaited<ReturnType<typeof stoaFetchProblemFace>>;
  let bootstrap: Awaited<ReturnType<typeof stoaBootstrapSponsor>>;
  try {
    [face, bootstrap] = await Promise.all([
      stoaFetchProblemFace(problemId),
      stoaBootstrapSponsor(sponsorId),
    ]);
  } catch {
    return refused({ ok: false, reason: "unreachable" }, attemptId, action);
  }
  if (face.state !== "ok" || face.data.problem !== problemId)
    return {
      status: "refused",
      attemptId,
      action,
      message:
        "This public problem could not be confirmed. Open a public problem before posting commentary.",
    };
  if (!bootstrap.ok) return refused(bootstrap, attemptId, action);
  if (bootstrap.data.sponsor_id !== sponsorId)
    return {
      status: "refused",
      attemptId,
      message: "Your sponsor identity could not be confirmed on this deployment.",
    };

  // Same actor + visible intent + unchanged payload survives an ambiguous
  // response. No commentary draft or raw identity is put in a key or storage.
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([sponsorId, attemptId, action, command.data])),
    ),
  );
  const key = `commentary-${action}-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let result: StoaCall<CommentaryItem>;
  try {
    result =
      action === "post"
        ? await stoaPostCommentary(
            sponsorId,
            SponsorCommentaryPostRequestSchema.parse(command.data),
            key,
          )
        : await stoaTombstoneCommentary(
            sponsorId,
            SponsorCommentaryTombstoneRequestSchema.parse(command.data),
            key,
          );
  } catch {
    result = { ok: false, reason: "unreachable" };
  }
  if (!result.ok) return refused(result, attemptId, action);
  try {
    revalidatePath(commentaryPageHref(problemId));
    revalidatePath(`/p/${encodeURIComponent(problemId)}`);
  } catch {
    // The committed Worker receipt remains true if an Agora refresh fails.
  }
  return { status: "committed", action, attemptId, receipt: result.data };
}

export async function applyCommentaryAction(
  expectedSponsorId: string,
  target: CommentaryActionTarget,
  previous: CommentaryActionState,
  form: FormData,
): Promise<CommentaryActionState> {
  const unconfirmed =
    previous?.status === "refused" && previous.uncertain && previous.attemptId && previous.action
      ? previous
      : undefined;
  if (
    unconfirmed &&
    (!(form instanceof FormData) ||
      singleString(form, "attempt_id") !== unconfirmed.attemptId ||
      singleString(form, "action") !== unconfirmed.action)
  )
    return {
      ...unconfirmed,
      message:
        "An earlier commentary action is still unconfirmed. Retry that unchanged request to recover its receipt.",
    };
  const result = await performCommentaryAction(expectedSponsorId, target, form);
  if (unconfirmed && result.status === "refused")
    return {
      ...result,
      uncertain: true,
      attemptId: unconfirmed.attemptId,
      action: unconfirmed.action,
    };
  return result;
}
