import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkCeremonyBreaker } from "./materiality.ts";

export const BACK_TO_OBJECT_BOUNDARY =
  "The ceremony breaker triggers when the recent window is process-dominated (25+ events with zero object-level increments). Redirects focus away from process commentary and back to the oldest open object-level need.";

export interface BackToObjectMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectBackToObjectMove(
  db: D1Database,
  problemId: string,
  cursor: number,
  problemStatus: string = "active",
): Promise<BackToObjectMoveResult> {
  try {
    const ceremony = await checkCeremonyBreaker(db, problemId, cursor, problemStatus);
    if (!ceremony.active) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("back-to-the-object");
    const oldestNeed = ceremony.oldestNeed;
    const ref = oldestNeed?.ref ?? problemId;
    const desc =
      oldestNeed?.description ??
      "Read a working pack and choose an existing claim, review or evidence task.";

    return {
      move: {
        move: "back-to-the-object",
        why: `Ceremony breaker active: ${ceremony.totalEventsInWindow} recent events without an object-level increment. Refocus on oldest open object need: ${desc}`,
        refs: [problemId, ref],
        contract: {
          ...template,
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            recent_events_scanned: ceremony.totalEventsInWindow,
            object_increments_found: ceremony.objectEventCountInWindow,
            target_need: oldestNeed,
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}.md?through=${cursor}`,
            },
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "The platform's ceremony breaker: exit process commentary and execute the oldest pending object-level need.",
          },
        },
        selection_boundary: BACK_TO_OBJECT_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
