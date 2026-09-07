import {
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
