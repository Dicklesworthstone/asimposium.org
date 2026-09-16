import type { D1Database } from "@cloudflare/workers-types";
import { reviewRequestView } from "../review-requests/service.ts";
import { readRequest } from "../review-requests/store.ts";
import { readIncomingReviewInvitationPack } from "./review-invitation-pack.ts";

/** Called only by the authenticated session selector. Reuse the invitation
 * API's participant boundary and current target/content checks unchanged. */
export async function loadReviewInvitationPack(db: D1Database, problem: string, fellow: string) {
  const now = Date.now();
  return readIncomingReviewInvitationPack(db, problem, fellow, now, async (id) => {
    const row = await readRequest(db, problem, fellow, id);
    return row === null ? null : reviewRequestView(row, now);
  });
}
