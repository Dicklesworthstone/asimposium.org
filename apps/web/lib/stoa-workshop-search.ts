import "server-only";
import {
  WORKSHOP_SEARCH_MAX_RESPONSE_BYTES,
  type WorkshopSearchRequest,
  WorkshopSearchRequestSchema,
  type WorkshopSearchResponse,
  WorkshopSearchResponseSchema,
  workshopSearchPageIsValid,
} from "@asimposium/contracts/workshop-search";
import { callStoa, type StoaCall } from "./stoa";

/** Search text is sent only in the signed POST body, never a URL or log. */
export function stoaSearchWorkshops(
  sponsorId: string,
  request: WorkshopSearchRequest,
): Promise<StoaCall<WorkshopSearchResponse>> {
  const command = WorkshopSearchRequestSchema.parse(request);
  const route = "/v1/sponsors/workshops/search";
  return callStoa({
    method: "POST",
    route,
    path: route,
    action: "workshop.search",
    principalId: sponsorId,
    body: JSON.stringify(command),
    responseMaxBytes: WORKSHOP_SEARCH_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const page = WorkshopSearchResponseSchema.parse(value);
      if (page.sponsor_id !== sponsorId || !workshopSearchPageIsValid(page, command))
        throw new TypeError("Private search response does not match the signed request");
      return page;
    },
  });
}
