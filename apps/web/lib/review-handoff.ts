import {
  ClaimFaceQuerySchema,
  EnrollmentProblemBindingSchema,
  PublicClaimTargetSchema,
  type SponsorFellowSummary,
} from "@asimposium/contracts";

/** Public navigation context, never review authority or sponsor-authored science. */
export interface ReviewHandoff {
  readonly problemId: string;
  readonly target: string;
  readonly through: string;
}

export function parseReviewHandoff(value: unknown): ReviewHandoff | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.problemId !== "string" ||
    record.problemId !== record.problemId.trim() ||
    typeof record.target !== "string" ||
    record.target !== record.target.trim() ||
    !record.target.includes("@") ||
    typeof record.through !== "string" ||
    record.through !== record.through.trim() ||
    !EnrollmentProblemBindingSchema.safeParse(record.problemId).success ||
    !PublicClaimTargetSchema.safeParse(record.target).success ||
    !ClaimFaceQuerySchema.safeParse({ through: record.through }).success
  ) return undefined;
  return { problemId: record.problemId, target: record.target, through: record.through };
}

export function reviewHandoffFromQuery(query: {
  readonly problem?: unknown;
  readonly review?: unknown;
  readonly review_through?: unknown;
}): ReviewHandoff | undefined {
  return parseReviewHandoff({
    problemId: query.problem,
    target: query.review,
    through: query.review_through,
  });
}

/** Construct links from canonical response identifiers, including its ledger cut. */
export function reviewHandoffForClaim(
  problemId: string,
  claimId: string,
  version: number,
  cursor: number,
): ReviewHandoff | undefined {
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(cursor)) return undefined;
  return parseReviewHandoff({ problemId, target: claimId + "@" + version, through: String(cursor) });
}

export function reviewHandoffHref(source: ReviewHandoff | undefined): string {
  const context = parseReviewHandoff(source);
  if (context === undefined) return "/reviews";
  const query = new URLSearchParams({
    problem: context.problemId,
    review: context.target,
    review_through: context.through,
  });
  return "/console?" + query.toString() + "#review-request-title";
}

export function reviewSourceHref(source: ReviewHandoff): string {
  return "/p/" + encodeURIComponent(source.problemId) + "/claims/" +
    encodeURIComponent(source.target) + "?through=" + source.through;
}

/** Fixed routing instructions; no public body text is converted into an instruction. */
export function reviewDirectiveText(source: ReviewHandoff): string {
  return "Review problem " + source.problemId + ", exact claim " + source.target +
    " (discovered at ledger cursor " + source.through + "). " +
    "Open an authorized session and obtain an isolated review pack for that exact target before assessing it. " +
    "Record a capable-of-failure check. Stoa rechecks the current version, permissions and independence. " +
    "This sponsor request is not a scientific review or a permission grant.";
}

/** Inventory is a UI hint only; the signed Worker action rechecks current ownership and access. */
export function reviewFellows(
  fellows: readonly SponsorFellowSummary[],
  source: ReviewHandoff,
): readonly SponsorFellowSummary[] {
  return fellows.filter((fellow) =>
    fellow.status === "active" &&
    fellow.granted_scopes.includes("review") &&
    (fellow.granted_resources.problem_binding === undefined ||
      fellow.granted_resources.problem_binding === source.problemId));
}
