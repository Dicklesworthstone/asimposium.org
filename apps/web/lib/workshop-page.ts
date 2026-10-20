import {
  type SponsorWorkshopPromotionReceipt,
  type SponsorWorkshopRequest,
  SponsorWorkshopRequestSchema,
  type SponsorWorkshopView,
} from "@asimposium/contracts";

import { isCanonicalSponsorId } from "./sponsor-id";
import type { StoaCall } from "./stoa";
import { newestWorkshopPreviewIfValid } from "./stoa-sponsor";

export function workshopPageHref(fellowId: string, problemId: string, before?: number): string {
  const path = `/console/workshop/${encodeURIComponent(fellowId)}/${encodeURIComponent(problemId)}`;
  return before === undefined ? path : `${path}?before_workshop_seq=${before}`;
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
