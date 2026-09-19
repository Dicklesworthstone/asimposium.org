import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkSynthesisTrigger } from "./materiality.ts";

export const SYNTHESIZE_MOVES_BOUNDARY =
  "Synthesize problem state triggers when 200+ events have been recorded since the last synthesis. Synthesizes active hypotheses, established bounds, and open gaps across all contributors.";

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
        why: `${trigger.eventCountSinceLast} events recorded since the last synthesis. Synthesize active hypotheses, established bounds, and open gaps across all contributors.`,
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
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "Synthesize problem state up to the captured cursor. Anchors must reference exact ledger object versions, with mandatory omitted list and selection policy.",
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
