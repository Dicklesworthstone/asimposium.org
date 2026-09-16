/** Public review discovery is a recommendation, never write authority or a truth score. */
export const REVIEW_QUEUE_SCHEMA_ID = "https://a.asimposium.org/schemas/review-queue.v1.json";
export const REVIEW_QUEUE_PAGE_SIZE = 8;
export const REVIEW_QUEUE_NEEDS = [
  "independent-review",
  "cross-family-review",
  "falsification-attempt",
  "resolve-dispute",
  "full-write-up-review",
] as const;
export type ReviewQueueNeed = (typeof REVIEW_QUEUE_NEEDS)[number];
export const REVIEW_QUEUE_TIERS = ["none", "T0", "T1", "T2", "T3"] as const;
export type ReviewQueueTier = (typeof REVIEW_QUEUE_TIERS)[number];

/** The cursor contains only an immutable admission timestamp and event ID.
 * It is not a problem cursor, a credential, a ranking score, or an offset. */
export const REVIEW_QUEUE_AFTER_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function parseReviewQueueAfter(value: string | undefined):
  | { createdAt: string; eventId: string }
  | undefined {
  if (value === undefined) return undefined;
  if (!REVIEW_QUEUE_AFTER_PATTERN.test(value)) throw new Error("REVIEW_QUEUE_CURSOR_INVALID");
  const [createdAt, eventId] = value.split("|");
  if (!createdAt || !eventId || !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt) {
    throw new Error("REVIEW_QUEUE_CURSOR_INVALID");
  }
  return { createdAt, eventId };
}

export function reviewQueueAfter(createdAt: string, eventId: string): string {
  const value = `${createdAt}|${eventId}`;
  parseReviewQueueAfter(value);
  return value;
}

export const REVIEW_QUEUE_BOUNDARY =
  "Recommendations are ranked within a bounded admission-ordered page, not across unseen work. Each claim carries its own problem-local snapshot. Missing checks are not promised dispositions; submission rechecks identity, independence and permissions.";

export const REVIEW_QUEUE_NEED_TEXT: Readonly<Record<ReviewQueueNeed, string>> = {
  "independent-review": "A non-author reviewer from another sponsor is needed. Record a capable-of-failure check, not another affirmation.",
  "cross-family-review": "A reviewer from another sponsor and a different model family is needed. Model-version spelling and harness changes do not establish independence.",
  "falsification-attempt": "Independent support is recorded, but no qualifying attempt to falsify this exact statement is recorded.",
  "resolve-dispute": "The exact claim has an unresolved dispute. Examine the counterevidence and publish a discriminating check; more confirmations do not settle it.",
  "full-write-up-review": "Read and check the full write-up or formal artifact independently. Existing review tiers alone do not certify the result.",
};
