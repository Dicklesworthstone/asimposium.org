import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const REANCHOR_MOVES_BOUNDARY =
  "Re-anchor detects statement drift when a problem statement revises to S@n+1, drifting from earlier claim versions. Only the claim's author may submit a reanchor request against the current claim head.";

export interface ReanchorMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectReanchorMove(
  db: D1Database,
  problemId: string,
  fellowId: string,
  cursor: number,
): Promise<ReanchorMoveResult> {
  try {
    // Check if problem has revised statement (version > 1) and fellow has drifting claims
    const row = await db
      .prepare(
        `SELECT c.object_id AS claim_id, c.object_version AS version,
                p.current_statement_version
         FROM problems p
         JOIN events c ON c.problem_id = p.id AND c.object_kind = 'claim'
           AND c.actor_fellow_id = ? AND c.seq <= ?
           AND c.seq = (
             SELECT MAX(h.seq) FROM events h
             WHERE h.problem_id = p.id AND h.object_kind = 'claim'
               AND h.object_id = c.object_id AND h.seq <= ?
           )
         LEFT JOIN claims cm ON cm.problem_id = p.id AND cm.id = c.object_id
         WHERE p.id = ? AND p.current_statement_version > 1
           AND (cm.statement_drift = 1 OR cm.statement_drift IS NULL)
         ORDER BY c.object_id ASC
         LIMIT 1`,
      )
      .bind(fellowId, cursor, cursor, problemId)
      .first<{
        claim_id: string;
        version: number;
        current_statement_version: number;
      }>();

    if (!row) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("re-anchor");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    const currentStatement = `S@${row.current_statement_version}`;
    const claimTarget = `${row.claim_id}@${row.version}`;

    return {
      move: {
        move: "re-anchor",
        why: `Statement revision minted ${currentStatement}, drifting from your earlier claim ${claimTarget}. Bind your claim to the current problem statement after checking the revision.`,
        refs: [problemId, claimTarget, currentStatement],
        contract: {
          ...template,
          prefilled_hints: {
            claim_id: row.claim_id,
            base_version: row.version,
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            claim_id: row.claim_id,
            base_version: row.version,
            current_statement_version: row.current_statement_version,
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
            note: "Only the claim author may make a re-anchor request. Supply claim_id and base_version matching your current claim head.",
          },
        },
        selection_boundary: REANCHOR_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
