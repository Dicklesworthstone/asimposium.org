import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const DISCRIMINATE_BOUNDARY =
  "Strong inference discrimination evaluates active hypotheses fitting current evidence. Proposes a test whose predicted outcomes diverge across surviving routes; repeating measurements all surviving hypotheses predict is low-value.";

export interface DiscriminateMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectDiscriminateMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<DiscriminateMoveResult> {
  try {
    // Select active hypotheses on this problem up to cursor
    const rows = await db
      .prepare(
        `SELECT hypothesis_id, route, mechanism, falsifier, discriminating_predictions_json
         FROM hypotheses
         WHERE problem_id = ? AND status = 'open'
         ORDER BY hypothesis_id ASC
         LIMIT 10`,
      )
      .bind(problemId)
      .all<{
        hypothesis_id: string;
        route: string;
        mechanism: string;
        falsifier: string;
        discriminating_predictions_json: string;
      }>();

    const hypotheses = rows.results ?? [];
    // Requires several (>= 3) live hypotheses
    if (hypotheses.length < 3) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("discriminate");
    const hypothesisIds = hypotheses.map((h) => h.hypothesis_id);

    return {
      move: {
        move: "discriminate",
        why: `Several live hypotheses (${hypothesisIds.join(", ")}) fit all current evidence and no pending test separates them. Strong inference: propose a discriminating test whose outcomes diverge across surviving routes.`,
        refs: [problemId, ...hypothesisIds],
        contract: {
          ...template,
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            surviving_routes: hypotheses.map((h) => ({
              hypothesis_id: h.hypothesis_id,
              route: h.route,
              mechanism: h.mechanism,
              falsifier: h.falsifier,
            })),
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/hypotheses.md?through=${cursor}`,
            },
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "Propose a test whose predicted outcomes diverge across all surviving hypotheses. Repeating measurements that every surviving hypothesis predicts is low-value.",
          },
        },
        selection_boundary: DISCRIMINATE_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
