import {
  type WorkshopSearchItem,
  type WorkshopSearchRequest,
  WorkshopSearchRequestSchema,
  type WorkshopSearchResponse,
  workshopSearchPageIsValid,
} from "@asimposium/contracts/workshop-search";
import { isCanonicalSponsorId } from "./sponsor-id";
import type { StoaCall } from "./stoa";
import { workshopPageHref } from "./workshop-page";

export type WorkshopSearchResult =
  | {
      readonly ok: true;
      readonly request: WorkshopSearchRequest;
      readonly page: WorkshopSearchResponse;
    }
  | { readonly ok: false; readonly message: string };

/** Validate again at the Server Action boundary; browser-supplied state and
 * cursors are input, never a statement of sponsor or object ownership. */
export async function searchOwnedWorkshops(
  sponsorId: unknown,
  input: unknown,
  read: (
    sponsorId: string,
    request: WorkshopSearchRequest,
  ) => Promise<StoaCall<WorkshopSearchResponse>>,
): Promise<WorkshopSearchResult> {
  if (!isCanonicalSponsorId(sponsorId))
    return { ok: false, message: "Sign in again before searching private work." };
  const request = WorkshopSearchRequestSchema.safeParse(input);
  if (!request.success)
    return {
      ok: false,
      message:
        "Use one to eight search words, at most 160 characters total. Check any Fellow or problem IDs and retry.",
    };
  try {
    const result = await read(sponsorId, request.data);
    if (
      !result.ok ||
      result.data.sponsor_id !== sponsorId ||
      !workshopSearchPageIsValid(result.data, request.data)
    )
      return {
        ok: false,
        message:
          "Private search could not be confirmed. Retry; ownership or the draft may have changed.",
      };
    return { ok: true, request: request.data, page: result.data };
  } catch {
    return { ok: false, message: "Private search is temporarily unavailable. Retry shortly." };
  }
}

/** Open the page whose newest eligible object is this exact search hit. The
 * detail page independently checks current ownership and shows its revision. */
export function workshopSearchResultHref(item: WorkshopSearchItem): string {
  const before = item.workshop_seq < Number.MAX_SAFE_INTEGER ? item.workshop_seq + 1 : undefined;
  return `${workshopPageHref(item.fellow_id, item.problem_id, before)}#${encodeURIComponent(item.workshop_id)}`;
}
