import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const FORMALIZE_MOVES_BOUNDARY =
  "Formalization targets the most load-bearing candidate by DAG consequence score (dependents count), never merely the easiest. Proposes attaching a Lean work product to an exact corroborated or foundational claim.";

export interface FormalizeMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectFormalizeMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<FormalizeMoveResult> {
  try {
    // Find open claims with the highest DAG dependents count
    // A claim is load-bearing when other claims depend on it (depends_on_claim_id = c.id)
    const row = await db
      .prepare(
        `SELECT c.id AS claim_id, c.object_version AS version, c.statement,
                COALESCE(d.dep_count, 0) AS dependent_count
         FROM (
           SELECT e.object_id AS id, e.object_version,
                  (SELECT json_extract(cc.payload_json, '$.statement')
                   FROM event_content cc WHERE cc.event_id = e.id) AS statement
           FROM events e
           WHERE e.problem_id = ? AND e.seq <= ?
             AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
             AND e.seq = (
               SELECT MAX(h.seq) FROM events h
               WHERE h.problem_id = e.problem_id AND h.object_kind = 'claim'
                 AND h.object_id = e.object_id AND h.seq <= ?
             )
         ) c
         LEFT JOIN (
           SELECT depends_on_claim_id, COUNT(*) AS dep_count
           FROM claim_deps
           WHERE problem_id = ?
           GROUP BY depends_on_claim_id
         ) d ON d.depends_on_claim_id = c.id
         WHERE d.dep_count > 0
         ORDER BY d.dep_count DESC, c.id ASC
         LIMIT 1`,
      )
      .bind(problemId, cursor, cursor, problemId)
      .first<{
        claim_id: string;
        version: number;
        statement: string | null;
        dependent_count: number;
      }>();

    if (!row) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("formalize");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    const target = `${row.claim_id}@${row.version}`;

    return {
      move: {
        move: "formalize",
        why: `Most load-bearing claim by DAG consequence score (${row.dependent_count} dependents). Attach a Lean formalization work product to provide machine-checked certainty on this foundation.`,
        refs: [problemId, target],
        contract: {
          ...template,
          prefilled_hints: {
            ...template.prefilled_hints,
            bears_on_kind: "claim",
            bears_on_id: row.claim_id,
            bears_on_version: row.version,
            direction: "supports",
            kind: "certificate",
            mode: "confirmatory",
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            target_claim: target,
            dependent_count: row.dependent_count,
            statement: row.statement,
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/claims/${target}.md?through=${cursor}`,
            },
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "prove" },
            },
            note: "Attach a Lean work product using formal_artifact. Run proof tools in your sponsor's harness; independent review determines what the artifact supports.",
          },
        },
        selection_boundary: FORMALIZE_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
