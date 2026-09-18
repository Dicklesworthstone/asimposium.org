import type { ReviewQueueItem, ReviewQueueQuery, ReviewQueueResponse } from "@asimposium/contracts/review-queue";

/** A blank GET form clears the problem filter; arrays/unknown keys remain for
 * the canonical schema to refuse rather than being silently discarded. */
export function normalizeReviewQueueForm(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
    value !== undefined && !(key === "problem" && value === ""))) as Record<string, string | string[]>;
}

/** No local re-ranking: the canonical producer decides selection and order. */
export function reviewQueueMatchesQuery(query: ReviewQueueQuery, face: ReviewQueueResponse): boolean {
  if (face.problem !== (query.problem ?? null)) return false;
  if (face.next_after !== null && (face.scanned === 0 ||
      (query.after !== undefined && face.next_after <= query.after))) return false;
  return true;
}

export function humanReviewQueuePath(query: ReviewQueueQuery): string {
  const params = new URLSearchParams();
  if (query.problem !== undefined) params.set("problem", query.problem);
  if (query.after !== undefined) params.set("after", query.after);
  return `/reviews${params.size === 0 ? "" : `?${params}`}`;
}

/** Construct from the schema-validated identity, never an external URL. */
export function reviewQueueClaimPath(item: ReviewQueueItem): string {
  return `/p/${encodeURIComponent(item.problem_id)}/claims/${item.claim_id}@${item.version}?through=${item.cursor}`;
}
