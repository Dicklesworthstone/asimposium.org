import { ProblemIdSchema, SponsorFollowQuerySchema } from "@asimposium/contracts";

export function followPageQuery(query: {
  readonly problem?: unknown;
  readonly after?: unknown;
}) {
  const problem = query.problem === undefined ? undefined : ProblemIdSchema.safeParse(query.problem);
  const cursor = SponsorFollowQuerySchema.safeParse(
    query.after === undefined ? {} : { after: query.after },
  );
  if ((problem !== undefined && !problem.success) || !cursor.success) return undefined;
  return { problem: problem?.success ? problem.data : undefined, ...cursor.data };
}

/** A problem link selects a draft preference only; following requires a signed action. */
export function followPageHref(query: { readonly problem?: string; readonly after?: string } = {}) {
  const parsed = followPageQuery(query);
  if (parsed === undefined) return "/console/follows";
  const params = new URLSearchParams();
  if (parsed.problem !== undefined) params.set("problem", parsed.problem);
  if (parsed.after !== undefined) params.set("after", parsed.after);
  return "/console/follows" + (params.size === 0 ? "" : "?" + params.toString());
}
