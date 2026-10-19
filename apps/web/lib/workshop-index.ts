import {
  EnrollmentProblemBindingSchema,
  type SponsorWorkshopIndexCursor,
  SponsorWorkshopIndexCursorSchema,
  type SponsorWorkshopIndexRequest,
} from "@asimposium/contracts";
import { parseReviewHandoff, type ReviewHandoff } from "./review-handoff";

/** The cursor is navigation data, never authority. Its full tuple is signed
 * into the Worker request and ownership is resolved again there. */
export function workshopIndexRequestFromCursor(
  value: string | readonly string[] | undefined,
): SponsorWorkshopIndexRequest | undefined {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length > 1024) return undefined;
  try {
    const parsed = SponsorWorkshopIndexCursorSchema.safeParse(JSON.parse(value));
    return parsed.success ? { after: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}

/** Independent page positions keep an older Fellow inventory from hiding
 * work by a Fellow whose card happens to be on another inventory page. */
export function consolePageHref({
  onboardingProblem,
  reviewContext,
  fellowCursor,
  workshopAfter,
  workshopsAnchor = false,
}: {
  readonly onboardingProblem?: string;
  readonly reviewContext?: ReviewHandoff;
  readonly fellowCursor?: string;
  readonly workshopAfter?: SponsorWorkshopIndexCursor;
  readonly workshopsAnchor?: boolean;
} = {}): string {
  const query = new URLSearchParams();
  const problem = EnrollmentProblemBindingSchema.safeParse(onboardingProblem);
  if (
    typeof onboardingProblem === "string" &&
    onboardingProblem === onboardingProblem.trim() &&
    problem.success
  ) {
    query.set("problem", problem.data);
  }
  const review = parseReviewHandoff(reviewContext);
  if (review !== undefined && query.get("problem") === review.problemId) {
    query.set("review", review.target);
    query.set("review_through", review.through);
  }
  if (fellowCursor !== undefined) query.set("fellow_cursor", fellowCursor);
  if (workshopAfter !== undefined) query.set("workshop_cursor", JSON.stringify(workshopAfter));
  return `/console${query.size === 0 ? "" : `?${query.toString()}`}${workshopsAnchor ? "#workshops-title" : ""}`;
}
