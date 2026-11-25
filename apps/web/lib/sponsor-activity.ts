import {
  type SponsorActivityRequest,
  SponsorActivityRequestSchema,
  type SponsorActivityResponse,
  SponsorActivityResponseSchema,
  sponsorActivityMatchesRequest,
} from "@asimposium/contracts";
import { isCanonicalSponsorId } from "./sponsor-id";
import type { StoaCall } from "./stoa";

export type SponsorActivityPageQuery = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export function sponsorActivityPageRequest(
  fellowId: string,
  query: SponsorActivityPageQuery,
): SponsorActivityRequest | null {
  if (Object.entries(query).some(([key, value]) => value !== undefined && key !== "after"))
    return null;
  const after = query.after;
  if (after !== undefined && (typeof after !== "string" || after.trim() !== after)) return null;
  const parsed = SponsorActivityRequestSchema.safeParse({
    fellow_id: fellowId,
    ...(after === undefined ? {} : { after_problem_id: after }),
  });
  return parsed.success ? parsed.data : null;
}

export function sponsorActivityPageHref(fellowId: string, after?: string): string {
  const path = "/console/fellows/" + encodeURIComponent(fellowId);
  const query = new URLSearchParams();
  if (after !== undefined) query.set("after", after);
  return path + (query.size === 0 ? "" : "?" + query.toString());
}

export type SponsorActivityPage =
  | { readonly status: "sign-in" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly request: SponsorActivityRequest;
      readonly view: SponsorActivityResponse;
      readonly firstHref: string;
      readonly nextHref: string | null;
    };

/** One signed read per page. No partial private data survives a scope mismatch,
 * malformed response, transfer refusal or failed read. */
export async function loadSponsorActivityPage(
  sponsorId: unknown,
  fellowId: string,
  query: SponsorActivityPageQuery,
  read: (
    sponsorId: string,
    request: SponsorActivityRequest,
  ) => Promise<StoaCall<SponsorActivityResponse>>,
): Promise<SponsorActivityPage> {
  if (!isCanonicalSponsorId(sponsorId)) return { status: "sign-in" };
  const request = sponsorActivityPageRequest(fellowId, query);
  if (request === null) return { status: "invalid" };
  try {
    const result = await read(sponsorId, request);
    if (!result.ok) return { status: "unavailable" };
    const parsed = SponsorActivityResponseSchema.safeParse(result.data);
    if (!parsed.success || !sponsorActivityMatchesRequest(sponsorId, request, parsed.data))
      return { status: "unavailable" };
    return {
      status: "ready",
      request,
      view: parsed.data,
      firstHref: sponsorActivityPageHref(fellowId),
      nextHref:
        parsed.data.next_cursor === null
          ? null
          : sponsorActivityPageHref(fellowId, parsed.data.next_cursor),
    };
  } catch {
    return { status: "unavailable" };
  }
}

type Increment = NonNullable<
  SponsorActivityResponse["assignments"][number]["last_public_increment"]
>;

export const ACTIVITY_INCREMENT_LABELS: Readonly<Record<Increment["type"], string>> = {
  "claim.created": "Claim published",
  "claim.revised": "Claim revised",
  "evidence.created": "Evidence published",
  "review.created": "Review published",
  "hypothesis.killed": "Hypothesis killed",
  "dead_end.recorded": "Dead end recorded",
  "problem.admitted": "Problem admitted",
  "problem.statement-reviewed": "Problem statement reviewed",
  "problem.statement-revised": "Problem statement revised",
  "problem.statement-updated": "Problem statement updated",
};

export const ACTIVITY_OMISSION_TEXT: Readonly<
  Record<SponsorActivityResponse["omitted"][number], string>
> = {
  assignment_limit: "More current assignments are available on the next page.",
  session_limit: "Only the four most recently opened sessions are shown.",
  public_activity_unavailable:
    "Public titles and activity are unavailable for one or more assignments.",
  increment_history_limited:
    "Bounded history or unavailable entries prevent establishing the latest material event for one or more assignments.",
  handback_unavailable: "A recorded handback could not be included within its reading limit.",
};
