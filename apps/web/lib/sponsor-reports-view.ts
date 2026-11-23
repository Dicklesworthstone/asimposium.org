import {
  type SponsorReportsCursor,
  type SponsorReportsRequest,
  SponsorReportsRequestSchema,
  type SponsorReportsResponse,
  SponsorReportsResponseSchema,
  sponsorReportsMatchRequest,
} from "@asimposium/contracts";
import { isCanonicalSponsorId } from "./sponsor-id";

export type SponsorReportsQuery = Readonly<Record<string, string | readonly string[] | undefined>>;

export function sponsorReportsPageRequest(
  query: SponsorReportsQuery,
): SponsorReportsRequest | null {
  if (Object.keys(query).some((key) => key !== "before_at" && key !== "before_id")) return null;
  const hasCursor = query.before_at !== undefined || query.before_id !== undefined;
  const parsed = SponsorReportsRequestSchema.safeParse(
    hasCursor
      ? {
          before: { created_at: query.before_at, report_id: query.before_id },
        }
      : {},
  );
  return parsed.success ? parsed.data : null;
}

export function sponsorReportsPageHref(before?: SponsorReportsCursor): string {
  return before === undefined
    ? "/console/reports"
    : `/console/reports?${new URLSearchParams({
        before_at: before.created_at,
        before_id: before.report_id,
      })}`;
}

export type ReportHistoryPage =
  | { readonly status: "sign-in" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly request: SponsorReportsRequest;
      readonly view: SponsorReportsResponse;
      readonly nextHref: string | null;
    };

/** Failed or mismatched private reads are unavailable, never an empty history. */
export async function loadSponsorReportsPage(
  sponsorId: unknown,
  query: SponsorReportsQuery,
  reader: (
    sponsor: string,
    request: SponsorReportsRequest,
  ) => Promise<
    { readonly ok: true; readonly data: SponsorReportsResponse } | { readonly ok: false }
  >,
): Promise<ReportHistoryPage> {
  if (!isCanonicalSponsorId(sponsorId)) return { status: "sign-in" };
  const request = sponsorReportsPageRequest(query);
  if (request === null) return { status: "invalid" };
  try {
    const result = await reader(sponsorId, request);
    if (!result.ok) return { status: "unavailable" };
    const parsed = SponsorReportsResponseSchema.safeParse(result.data);
    if (!parsed.success || !sponsorReportsMatchRequest(sponsorId, request, parsed.data))
      return { status: "unavailable" };
    return {
      status: "ready",
      request,
      view: parsed.data,
      nextHref:
        parsed.data.next_cursor === null ? null : sponsorReportsPageHref(parsed.data.next_cursor),
    };
  } catch {
    return { status: "unavailable" };
  }
}
