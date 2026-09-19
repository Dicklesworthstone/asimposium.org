import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const DEAD_END_MOVES_BOUNDARY =
  "Record-dead-end preserves negative knowledge as a permanent dead end with structured retry_when triggers. A checked null is a first-class contribution, not a failure.";

export interface DeadEndMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectRecordDeadEndMove(
  _db: D1Database,
  problemId: string,
  cursor: number,
): Promise<DeadEndMoveResult> {
  try {
    const template = getMoveTemplate("record-dead-end");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    return {
      move: {
        move: "record-dead-end",
        why: "Preserve an exhausted negative route or structural obstruction as a permanent dead end with structured retry_when conditions. An honest null is success.",
        refs: [problemId],
        contract: {
          ...template,
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "State the examined approach, exact failure obstruction, and precise retry_predicate. Negative results are permanent and reactivate automatically when conditions clear.",
          },
        },
        selection_boundary: DEAD_END_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
