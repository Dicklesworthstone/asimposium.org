import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const KILL_MOVES_BOUNDARY =
  "Kill-or-stand identifies active hypotheses whose declared falsifier appears fired in evidence. The recommendation prompts either withdrawing the hypothesis with its killing evidence or retaining an explicit defense in workshop.";

export interface KillMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectKillOrStandMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<KillMoveResult> {
  try {
    // Find active hypotheses on this problem that have refuting evidence targeting them
    const row = await db
      .prepare(
        `SELECT h.hypothesis_id, h.route, h.falsifier, e.evidence_id, e.direction
         FROM hypotheses h
         JOIN evidence e ON e.problem_id = h.problem_id
           AND e.bears_on_kind = 'hypothesis' AND e.bears_on_id = h.hypothesis_id
           AND e.direction = 'refutes'
         WHERE h.problem_id = ? AND h.status = 'open'
         ORDER BY e.evidence_id ASC
         LIMIT 1`,
      )
      .bind(problemId)
      .first<{
        hypothesis_id: string;
        route: string;
        falsifier: string;
        evidence_id: string;
        direction: string;
      }>();

    if (!row) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("kill-or-stand");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    const path = template.request.path.replace("{hid}", encodeURIComponent(row.hypothesis_id));

    return {
      move: {
        move: "kill-or-stand",
        why: `Hypothesis ${row.hypothesis_id}'s declared falsifier appears fired in evidence ${row.evidence_id}. Withdraw the hypothesis with its recorded falsifying evidence or retain a defense in workshop.`,
        refs: [problemId, row.hypothesis_id, row.evidence_id],
        contract: {
          ...template,
          request: {
            ...template.request,
            path,
          },
          prefilled_hints: {
            hypothesis_id: row.hypothesis_id,
            killed_by_evidence_id: row.evidence_id,
            reason: `Falsifying evidence observed in ${row.evidence_id}: declared falsifier fired.`,
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            hypothesis_id: row.hypothesis_id,
            route: row.route,
            falsifier: row.falsifier,
            evidence_id: row.evidence_id,
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "A fired falsifier requires an honest withdrawal or a deliberate workshop work product defending the route against the observation.",
          },
        },
        selection_boundary: KILL_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
