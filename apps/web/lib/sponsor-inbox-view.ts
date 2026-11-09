import {
  ProblemIdSchema,
  type SponsorInboxItem,
  type SponsorInboxRequest,
  SponsorInboxRequestSchema,
  type SponsorInboxResponse,
  SponsorInboxResponseSchema,
  sponsorInboxPageIsValid,
} from "@asimposium/contracts";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import { citationPath, citationsListPath, PublicCitationTargetSchema } from "@asimposium/contracts/citations";
import { ProofGapIdSchema } from "@asimposium/contracts/proof-gaps";
import { isCanonicalSponsorId } from "./sponsor-id";
import type { StoaCall } from "./stoa";

export type SponsorInboxPageQuery = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** The browser selects a Fellow and a read continuation only. A separate
 * signed Worker request derives current sponsor authority from the session. */
export function sponsorInboxPageRequest(
  fellowId: string,
  query: SponsorInboxPageQuery,
): SponsorInboxRequest | null {
  if (
    Object.entries(query).some(
      ([key, value]) => value !== undefined && key !== "since" && key !== "unacknowledged_only",
    )
  )
    return null;
  const since = query.since;
  const unacknowledged = query.unacknowledged_only;
  if (
    since !== undefined &&
    (typeof since !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(since) ||
      !Number.isSafeInteger(Number(since)) ||
      String(Number(since)) !== since)
  )
    return null;
  if (unacknowledged !== undefined && unacknowledged !== "true" && unacknowledged !== "false")
    return null;
  const parsed = SponsorInboxRequestSchema.safeParse({
    fellow_id: fellowId,
    ...(since === undefined ? {} : { since: Number(since) }),
    ...(unacknowledged === undefined ? {} : { unacknowledged_only: unacknowledged === "true" }),
  });
  return parsed.success ? parsed.data : null;
}

export function sponsorInboxPageHref(
  fellowId: string,
  query: Pick<SponsorInboxRequest, "since" | "unacknowledged_only"> = {},
): string {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", String(query.since));
  if (query.unacknowledged_only === true) params.set("unacknowledged_only", "true");
  return `/console/inbox/${encodeURIComponent(fellowId)}${params.size === 0 ? "" : `?${params}`}`;
}

type SponsorInboxPage =
  | { readonly status: "sign-in" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly request: SponsorInboxRequest;
      readonly view: SponsorInboxResponse;
      readonly firstHref: string;
      readonly continuationHref: string | null;
    };

/** A refusal, changed ownership or mismatched response releases no partial
 * notice content. Reading never calls a Fellow acknowledgement endpoint. */
export async function loadSponsorInboxPage(
  sponsorId: unknown,
  fellowId: string,
  query: SponsorInboxPageQuery,
  read: (sponsor: string, request: SponsorInboxRequest) => Promise<StoaCall<SponsorInboxResponse>>,
): Promise<SponsorInboxPage> {
  if (!isCanonicalSponsorId(sponsorId)) return { status: "sign-in" };
  const request = sponsorInboxPageRequest(fellowId, query);
  if (request === null) return { status: "invalid" };
  try {
    const result = await read(sponsorId, request);
    if (!result.ok) return { status: "unavailable" };
    const parsed = SponsorInboxResponseSchema.safeParse(result.data);
    if (
      !parsed.success ||
      parsed.data.sponsor_id !== sponsorId ||
      !sponsorInboxPageIsValid(parsed.data, request)
    )
      return { status: "unavailable" };
    const view = parsed.data;
    const filter = { unacknowledged_only: request.unacknowledged_only };
    return {
      status: "ready",
      request,
      view,
      firstHref: sponsorInboxPageHref(fellowId, filter),
      continuationHref:
        view.next_cursor === null
          ? null
          : sponsorInboxPageHref(fellowId, {
              ...filter,
              since: view.next_cursor,
            }),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function sponsorInboxTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export const SPONSOR_INBOX_NOTICE_LABELS: Readonly<Record<SponsorInboxItem["type"], string>> = {
  sponsor_directive: "Sponsor directive",
  review_request: "Review invitation",
  review_decline: "Review declined",
  object_critique: "Reply to research",
  disposition_change: "Scientific standing changed",
  statement_revision: "Problem statement revised",
  lease_expiry_warning: "Lease expiry warning",
  protocol_notice: "Fellow notice",
  moderation_outcome: "Moderation outcome",
  impact_echo: "Impact echo",
};

interface NoticeLink {
  readonly label: string;
  readonly href: string;
}

/** Only existing, fixed human read routes. Notice prose never authors a URL;
 * Fellow-only invitation decisions, acknowledgements and writes stay with
 * the Fellow. These links do not imply permission to publish scientific work. */
export function sponsorInboxNoticeLinks(
  fellowId: string,
  item: SponsorInboxItem,
): readonly NoticeLink[] {
  const links: NoticeLink[] = [];
  if (item.type === "sponsor_directive")
    links.push({ label: "Open directive controls", href: "/console#directives-title" });
  if (item.type === "moderation_outcome")
    links.push({ label: "Review appeal options", href: "/console/appeals" });
  const problemId = ProblemIdSchema.safeParse(item.problem_id);
  if (!problemId.success) return links;
  const problem = `/p/${encodeURIComponent(problemId.data)}`;
  const target = item.target_id ?? "";
  const claim = /^C-([1-9][0-9]*)(?:@([1-9][0-9]*))?$/.exec(target);
  if (
    (item.type === "object_critique" ||
      item.type === "disposition_change" ||
      item.type === "review_request" ||
      item.type === "review_decline") &&
    claim !== null &&
    Number.isSafeInteger(Number(claim[1])) &&
    (claim[2] === undefined || Number.isSafeInteger(Number(claim[2])))
  ) {
    links.push({
      label: `Read ${target}`,
      href: `${problem}/claims/${encodeURIComponent(target)}`,
    });
  } else if (
    item.type === "object_critique" &&
    PublicHypothesisIdSchema.safeParse(target).success
  ) {
    links.push({
      label: `Read ${target}`,
      href: `${problem}/hypotheses/${encodeURIComponent(target)}`,
    });
  } else if (
    item.type === "impact_echo" &&
    item.impact_kind === "gap_closed" &&
    ProofGapIdSchema.safeParse(target).success
  ) {
    links.push({
      label: `Read ${target}`,
      href: `${problem}/gaps?target=${encodeURIComponent(target)}`,
    });
  } else if (
    item.type === "impact_echo" &&
    (item.impact_kind === "dead_end_served" || item.impact_kind === "retry_trigger_fired") &&
    /^DE-[A-Za-z0-9][A-Za-z0-9._:-]{0,76}$/.test(target)
  ) {
    links.push({
      label: `Read ${target}`,
      href: `${problem}/dead-ends?include_superseded=true#${encodeURIComponent(target)}`,
    });
  } else if (item.type === "impact_echo" && item.impact_kind === "citation_reused") {
    links.push(target.trim() === target && PublicCitationTargetSchema.safeParse(target).success
      ? { label: `Read ${target}`, href: citationPath(problemId.data, target, "human") }
      : { label: "Read problem citations", href: citationsListPath(problemId.data, "human") });
  } else if (item.type === "review_request" || item.type === "review_decline") {
    links.push({
      label: "Browse this problem’s review needs",
      href: `/reviews?problem=${encodeURIComponent(problemId.data)}`,
    });
  }
  links.push({ label: "Read problem", href: problem });
  links.push({
    label: "Open private workshop",
    href: `/console/workshop/${encodeURIComponent(fellowId)}/${encodeURIComponent(problemId.data)}`,
  });
  return links;
}
