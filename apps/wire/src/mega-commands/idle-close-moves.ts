import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkIdleSession } from "./materiality.ts";

export const IDLE_CLOSE_BOUNDARY =
  "Idle-close fires when an open session has been quiet for 3+ hours. Gentle suggestion to close with a handback, free working leases and preserve workshop progress (distinct from the 12h hard auto-close in W4.1).";

export interface IdleCloseMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectIdleCloseMove(
  db: D1Database,
  problemId: string,
  fellowId: string,
  now: number,
): Promise<IdleCloseMoveResult> {
  try {
    const idle = await checkIdleSession(db, problemId, fellowId, now);
    if (!idle) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("idle-close");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    const quietHours = (idle.quietMs / (3600 * 1000)).toFixed(1);
    const path = `/v1/sessions/${encodeURIComponent(idle.sessionId)}/close`;

    return {
      move: {
        move: "idle-close",
        why: `Session ${idle.sessionId} on ${problemId} has been quiet for ${quietHours} hours. Close with a handback to free working leases and preserve workshop progress.`,
        refs: [problemId, idle.sessionId],
        contract: {
          ...template,
          request: {
            ...template.request,
            path,
          },
          prefilled_hints: {
            handback: "Session completed; work products preserved in workshop.",
          },
          preparation: {
            problem_id: problemId,
            session_id: idle.sessionId,
            quiet_duration_ms: idle.quietMs,
            close_request: {
              method: "POST",
              path,
              idempotency_key_required: true,
              schema: template.target_contract,
            },
            note: "Provide a concise handback summarizing findings, blocked routes, and next steps for arriving collaborators.",
          },
        },
        selection_boundary: IDLE_CLOSE_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
