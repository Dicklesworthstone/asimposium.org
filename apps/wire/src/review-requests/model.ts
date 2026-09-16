/** Private coordination only. A request or acceptance is never a review,
 * scientific finding, independence tier, or exclusive reservation. */
export const REVIEW_OFFER_MS = 2 * 24 * 60 * 60 * 1000;
export const REVIEW_ACCEPTED_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_REQUEST_PAGE_SIZE = 20;
export const REVIEW_REQUEST_CAPACITY = 4;
export const REVIEW_REQUEST_DAILY_LIMIT = 20;
export type ReviewRequestAction = "offer" | "accept" | "decline" | "cancel" | "complete";
export type ReviewRequestStatus = "offered" | "accepted" | "declined" | "cancelled" | "completed";
export interface ReviewRequestState {
  readonly version: number;
  readonly status: ReviewRequestStatus;
  readonly occurred_at: number;
  readonly expires_at: number;
}
export class ReviewRequestError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" | "INELIGIBLE" | "LIMIT" | "IDEMPOTENCY_CONFLICT") {
    super(code);
    this.name = "ReviewRequestError";
  }
}
export function effectiveReviewRequestStatus(state: ReviewRequestState, now: number): ReviewRequestStatus | "expired" {
  return (state.status === "offered" || state.status === "accepted") && now >= state.expires_at
    ? "expired" : state.status;
}
/** Decline/cancel remain possible after expiry. Completion requires a real
 * exact-version review; the persistence adapter verifies that reference. */
export function transitionReviewRequest(
  state: ReviewRequestState,
  action: Exclude<ReviewRequestAction, "offer">,
  expectedVersion: number,
  participant: "author" | "reviewer",
  now: number,
): ReviewRequestState {
  if (!Number.isSafeInteger(now) || now < state.occurred_at ||
      state.version !== expectedVersion || state.version >= Number.MAX_SAFE_INTEGER) {
    throw new ReviewRequestError("CONFLICT");
  }
  const active = state.status === "offered" || state.status === "accepted";
  const allowed = action === "cancel" ? participant === "author" && active
    : participant === "reviewer" && (action === "decline" ? active
      : now < state.expires_at && (action === "accept" ? state.status === "offered"
        : state.status === "accepted"));
  if (!allowed) throw new ReviewRequestError("CONFLICT");
  const status = { accept: "accepted", decline: "declined", cancel: "cancelled", complete: "completed" } as const;
  const expires = action === "accept" ? now + REVIEW_ACCEPTED_MS : state.expires_at;
  if (!Number.isSafeInteger(expires)) throw new ReviewRequestError("CONFLICT");
  return { version: state.version + 1, status: status[action], occurred_at: now, expires_at: expires };
}
