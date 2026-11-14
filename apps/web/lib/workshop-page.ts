import {
  type SponsorWorkshopCursorRequest,
  SponsorWorkshopCursorRequestSchema,
  type SponsorWorkshopCursorResponse,
  SponsorWorkshopCursorResponseSchema,
  type SponsorWorkshopObject,
  type SponsorWorkshopPromotionReceipt,
  type SponsorWorkshopRequest,
  SponsorWorkshopRequestSchema,
  type SponsorWorkshopView,
  SponsorWorkshopViewSchema,
} from "@asimposium/contracts";

import { isCanonicalSponsorId } from "./sponsor-id";
import type { StoaCall } from "./stoa";
import { newestWorkshopPreviewIfValid } from "./stoa-sponsor";

export function workshopPageHref(fellowId: string, problemId: string, before?: number): string {
  const path = `/console/workshop/${encodeURIComponent(fellowId)}/${encodeURIComponent(problemId)}`;
  return before === undefined ? path : `${path}?before_workshop_seq=${before}`;
}

export function workshopRevisionHref(
  fellowId: string,
  problemId: string,
  workshopId: string,
  version: number,
): string {
  return `${workshopPageHref(fellowId, problemId)}/${encodeURIComponent(workshopId)}?version=${version}`;
}

export type WorkshopRevisionRequest = SponsorWorkshopRequest & {
  object: NonNullable<SponsorWorkshopRequest["object"]>;
};

type WorkshopRevisionPage =
  | { readonly status: "sign-in" | "invalid" | "unavailable" }
  | {
      readonly status: "ready";
      readonly object: SponsorWorkshopObject;
      readonly workshopHref: string;
      readonly previousHref: string | null;
      readonly nextHref: string | null;
      readonly currentHref: string;
    };

/** No fallback to the current draft: a pinned history link must retain the
 * chosen revision across reloads, concurrent edits and closed sessions. */
export async function loadWorkshopRevisionPage(
  sponsorId: unknown,
  fellowId: string,
  problemId: string,
  workshopId: string,
  version: string | readonly string[] | undefined,
  read: (
    sponsorId: string,
    request: WorkshopRevisionRequest,
  ) => Promise<StoaCall<SponsorWorkshopView>>,
): Promise<WorkshopRevisionPage> {
  if (!isCanonicalSponsorId(sponsorId)) return { status: "sign-in" };
  if (
    typeof version !== "string" ||
    !/^[1-9][0-9]*$/.test(version) ||
    !Number.isSafeInteger(Number(version))
  )
    return { status: "invalid" };
  const request = SponsorWorkshopRequestSchema.safeParse({
    fellow_id: fellowId,
    problem_id: problemId,
    object: { workshop_id: workshopId, version: Number(version) },
  });
  if (!request.success || request.data.object === undefined) return { status: "invalid" };
  try {
    const result = await read(sponsorId, { ...request.data, object: request.data.object });
    if (!result.ok) return { status: "unavailable" };
    const parsed = SponsorWorkshopViewSchema.safeParse(result.data);
    if (!parsed.success) return { status: "unavailable" };
    const view = parsed.data;
    const object = view.objects[0];
    if (
      view.fellow_id !== fellowId ||
      view.problem_id !== problemId ||
      view.objects.length !== 1 ||
      view.has_more ||
      view.next_cursor !== null ||
      object?.workshop_id !== workshopId ||
      object.version !== Number(version) ||
      !Number.isSafeInteger(object.current_version) ||
      object.current_version < object.version
    )
      return { status: "unavailable" };
    const href = (selected: number) =>
      workshopRevisionHref(fellowId, problemId, workshopId, selected);
    return {
      status: "ready",
      object,
      workshopHref: `${workshopPageHref(
        fellowId,
        problemId,
        object.workshop_seq < Number.MAX_SAFE_INTEGER ? object.workshop_seq + 1 : undefined,
      )}#${encodeURIComponent(workshopId)}`,
      previousHref: object.version > 1 ? href(object.version - 1) : null,
      nextHref: object.version < object.current_version ? href(object.version + 1) : null,
      currentHref: href(object.current_version),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function privateWorkshopCursorResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      vary: "Cookie",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** The Agora cookie authenticates only this same-origin facade. Stoa receives
 * a signed sponsor request and independently checks current ownership. */
export async function loadWorkshopCursorResponse(
  sponsorId: unknown,
  fellowId: string,
  problemId: string,
  read: (
    sponsorId: string,
    request: SponsorWorkshopCursorRequest,
  ) => Promise<StoaCall<SponsorWorkshopCursorResponse>>,
): Promise<Response> {
  if (!isCanonicalSponsorId(sponsorId))
    return privateWorkshopCursorResponse(401, { error: "Sign in to check this workshop." });
  const request = SponsorWorkshopCursorRequestSchema.safeParse({
    fellow_id: fellowId,
    problem_id: problemId,
  });
  if (!request.success)
    return privateWorkshopCursorResponse(400, { error: "Invalid workshop link." });
  try {
    const result = await read(sponsorId, request.data);
    if (!result.ok) {
      const status =
        result.reason === "refused" &&
        (result.status === 401 || result.status === 403 || result.status === 404)
          ? 404
          : 503;
      return privateWorkshopCursorResponse(status, { error: "Workshop checks are unavailable." });
    }
    const parsed = SponsorWorkshopCursorResponseSchema.safeParse(result.data);
    if (
      !parsed.success ||
      parsed.data.sponsor_id !== sponsorId ||
      parsed.data.fellow_id !== fellowId ||
      parsed.data.problem_id !== problemId
    )
      return privateWorkshopCursorResponse(503, { error: "Workshop checks are unavailable." });
    return privateWorkshopCursorResponse(200, parsed.data);
  } catch {
    return privateWorkshopCursorResponse(503, { error: "Workshop checks are unavailable." });
  }
}

/** Link the complete public object, including evidence targeting a hypothesis. */
export function workshopPromotionDestination(
  receipt: SponsorWorkshopPromotionReceipt,
  stoaOrigin: string,
): { readonly label: string; readonly href: string; readonly assessment?: string } {
  const problem = encodeURIComponent(receipt.problem_id);
  if (!("object_kind" in receipt)) {
    const claim = receipt.version > 1 ? `${receipt.claim_id}@${receipt.version}` : receipt.claim_id;
    return {
      label: claim,
      href: `/p/${problem}/claims/${encodeURIComponent(claim)}`,
    };
  }
  if (receipt.object_kind === "hypothesis") {
    return {
      label: receipt.result.hypothesis_id,
      href: `${stoaOrigin}/p/${problem}/hypotheses/${encodeURIComponent(receipt.result.hypothesis_id)}.html`,
    };
  }
  if (receipt.object_kind === "dead-end") {
    return {
      label: receipt.result.dead_end_id,
      href: `/p/${problem}/dead-ends?include_superseded=true#${encodeURIComponent(receipt.result.dead_end_id)}`,
    };
  }
  return {
    label: receipt.result.evidence_id,
    href: `/r/p/${problem}/evidence/${encodeURIComponent(receipt.result.evidence_id)}`,
    assessment: `Computed evidence class: ${receipt.result.computed_class}. ${receipt.result.drives_promotion ? "Eligible to contribute to a claim's evidence assessment." : "This evidence cannot drive claim promotion."}${receipt.result.coercion_flags.length === 0 ? "" : ` Validator adjustments: ${receipt.result.coercion_flags.join(", ")}.`}`,
  };
}

type WorkshopPage =
  | { readonly status: "sign-in" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly request: SponsorWorkshopRequest;
      readonly view: SponsorWorkshopView;
      readonly newestHref: string;
      readonly olderHref: string | null;
    };

/** One private page per render. The Worker remains the ownership authority. */
export async function loadWorkshopPage(
  sponsorId: unknown,
  fellowId: string,
  problemId: string,
  cursor: string | readonly string[] | undefined,
  read: (
    sponsorId: string,
    request: SponsorWorkshopRequest,
  ) => Promise<StoaCall<SponsorWorkshopView>>,
): Promise<WorkshopPage> {
  if (!isCanonicalSponsorId(sponsorId)) return { status: "sign-in" };
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" ||
      !/^[1-9][0-9]*$/.test(cursor) ||
      !Number.isSafeInteger(Number(cursor)))
  ) {
    return { status: "invalid" };
  }
  const parsed = SponsorWorkshopRequestSchema.safeParse({
    fellow_id: fellowId,
    problem_id: problemId,
    ...(cursor === undefined ? {} : { before_workshop_seq: Number(cursor) }),
  });
  if (!parsed.success) return { status: "invalid" };
  try {
    const result = await read(sponsorId, parsed.data);
    if (!result.ok) return { status: "unavailable" };
    const view = result.data;
    const before = parsed.data.before_workshop_seq;
    if (
      view.fellow_id !== fellowId ||
      view.problem_id !== problemId ||
      newestWorkshopPreviewIfValid(view.objects) === undefined ||
      (before !== undefined && view.objects.some((object) => object.workshop_seq >= before))
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "ready",
      request: parsed.data,
      view,
      newestHref: workshopPageHref(fellowId, problemId),
      olderHref:
        view.next_cursor === null ? null : workshopPageHref(fellowId, problemId, view.next_cursor),
    };
  } catch {
    // Never reflect private upstream errors, titles or body excerpts.
    return { status: "unavailable" };
  }
}
