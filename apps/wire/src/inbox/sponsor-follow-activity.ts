import {
  SPONSOR_FOLLOW_EVENT_WINDOW,
  SponsorFollowItemSchema,
  type SponsorFollowItem,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { loadReviewQueue } from "../discovery/review-queue-service.ts";
import { readPublicEventTail } from "../ledger/event-tail-read.ts";
import type { SponsorFollowRow } from "./sponsor-follows.ts";

export interface SponsorFollowActivityReaders {
  tail: typeof readPublicEventTail;
  reviews: typeof loadReviewQueue;
}
const readers: SponsorFollowActivityReaders = {
  tail: readPublicEventTail,
  reviews: loadReviewQueue,
};

export function unavailableSponsorFollow(row: SponsorFollowRow): SponsorFollowItem {
  return SponsorFollowItemSchema.parse({
    problem_id: row.problem_id, followed_at: row.followed_at, cursor: null,
    events: [], reviews: [], omitted: ["public_activity_unavailable"],
  });
}

/** A bounded view of existing public sources, never a stored notification
 * stream. Known unlisted URLs remain readable; private/hidden problems never
 * gain access from following. No workshop, directive or inbox reader is used. */
export async function readSponsorFollowActivity(
  db: D1Database,
  row: SponsorFollowRow,
  source: SponsorFollowActivityReaders = readers,
): Promise<SponsorFollowItem> {
  if (row.cursor === null) return unavailableSponsorFollow(row);
  const cursor = row.cursor;
  const since = Math.max(0, cursor - SPONSOR_FOLLOW_EVENT_WINDOW);
  const item: SponsorFollowItem = {
    problem_id: row.problem_id, followed_at: row.followed_at, cursor,
    events: [], reviews: [], omitted: [],
  };
  const [tail, queue] = await Promise.allSettled([
    source.tail(db, row.problem_id, { since, through: cursor, limit: SPONSOR_FOLLOW_EVENT_WINDOW }),
    source.reviews(db, { problem: row.problem_id }, {
      problemId: row.problem_id, through: cursor, includeUnlisted: true,
    }),
  ]);
  if (tail.status === "fulfilled" && tail.value !== null) {
    const page = tail.value.page;
    if (page.page_end.problem_id !== row.problem_id || page.page_end.through !== cursor ||
        page.page_end.since !== since) throw new Error("SPONSOR_FOLLOW_ACTIVITY_SCOPE");
    const material = page.events.filter(entry =>
      entry.event !== null && entry.body_omitted === "separate_object_face" &&
      entry.event.type !== "question.leased");
    item.events = material.slice(-5).reverse();
    if (since > 0) item.omitted.push("older_events_outside_recent_window");
    if (material.length > 5) item.omitted.push("material_event_limit");
    if (page.page_end.has_more) item.omitted.push("recent_event_page_incomplete");
    if (page.events.some(entry => entry.body_omitted === "content_unavailable"))
      item.omitted.push("event_content_unavailable");
  } else item.omitted.push("material_activity_unavailable");

  if (queue.status === "fulfilled") {
    if (queue.value.problem !== row.problem_id ||
        queue.value.candidates.some(claim => claim.cursor !== cursor))
      throw new Error("SPONSOR_FOLLOW_REVIEW_SCOPE");
    item.reviews = queue.value.candidates.slice(0, 2);
    if (queue.value.candidates.length > 2) item.omitted.push("review_preview_limit");
    for (const omission of queue.value.omitted) {
      // Excluding non-ready claims is the queue's selection, not data loss.
      if (omission.reason !== "not_review_ready")
        item.omitted.push("reviews_" + omission.reason);
    }
  } else item.omitted.push("review_activity_unavailable");
  return SponsorFollowItemSchema.parse(item);
}
