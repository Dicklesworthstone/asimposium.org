"use server";

import type { SaveProblemBriefRequest, SponsorProblemBrief } from "@asimposium/contracts";
import { SaveProblemBriefRequestSchema } from "@asimposium/contracts";
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

/**
 * Publish an adopted private draft. The sponsor must acknowledge that the
 * formulation becomes public, permanent and CC BY 4.0; the Worker's lifecycle
 * gate decides whether publication is allowed.
 */
export async function publishProblem(
  problemId: string,
  acknowledged: boolean,
  idempotencyKey: string,
): Promise<ProblemActionResult<{ readonly id: string; readonly status: string }>> {
  const principal = await sponsorId();
  if (principal === null) return { ok: false, message: "Sign in again before publishing." };
  if (!acknowledged) {
    return {
      ok: false,
      message: "Confirm that the formulation becomes public, permanent and CC BY 4.0.",
    };
  }
  if (!/^P-[A-Z0-9][A-Z0-9-]{1,40}$/.test(problemId) || !KEY.test(idempotencyKey)) {
    return { ok: false, message: "That problem cannot be published from here." };
  }
  const result = await stoaPublishProblem(principal, problemId, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "Problem publication is not configured on this deployment."
          : result.reason === "refused"
            ? "Stoa refused publication. Only your own adopted private drafts can be published."
            : "Publication could not be confirmed. Retry; a repeated request is idempotent.",
    };
  }
  return {
    ok: true,
    value: { id: result.data.problem.id, status: result.data.problem.status },
  };
}
