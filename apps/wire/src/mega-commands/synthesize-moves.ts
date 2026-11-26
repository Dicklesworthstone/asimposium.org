import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkSynthesisTrigger } from "./materiality.ts";

export const SYNTHESIZE_MOVES_BOUNDARY =
  "Synthesize problem state triggers when 200+ events have been recorded since the last synthesis. Save active hypotheses, established bounds, and open gaps across all contributors as a private draft for your current sponsor or a problem steward to publish.";

export interface SynthesizeMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectSynthesizeMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<SynthesizeMoveResult> {
  try {
    const trigger = await checkSynthesisTrigger(db, problemId, cursor);
    if (!trigger.needed) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("synthesize");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    return {
      move: {
        move: "synthesize",
        why: `${trigger.eventCountSinceLast} events recorded since the last synthesis. Save a private synthesis draft of active hypotheses, established bounds, and open gaps across all contributors for sponsor or steward publication.`,
        refs: [problemId],
        contract: {
          ...template,
          prefilled_hints: {
            ...template.prefilled_hints,
            covers_through: cursor,
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            events_since_last: trigger.eventCountSinceLast,
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/full.md?through=${cursor}`,
            },
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "Follow the ledger's next actions to keep the same cut across pages. Reuse an owned session on this problem or open one. Anchor exact ledger object versions and include the omitted list and selection policy. Omit draft or set true; false is refused. Your current sponsor or a problem steward must publish the saved draft before it can be shared.",
          },
        },
        selection_boundary: SYNTHESIZE_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
