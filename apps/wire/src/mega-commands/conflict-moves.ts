import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const CONFLICT_MOVES_BOUNDARY =
  "Normalize-conflict identifies apparent incompatibilities between ledger objects before opening a formal dispute. Walks through definition, scope, and quantifier alignment, because most apparent conflicts die in normalization.";

export interface ConflictMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectNormalizeConflictMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<ConflictMoveResult> {
  try {
    // Check if there is a 'contradicts' relation between claims without a resolved/open conflict row
    const row = await db
      .prepare(
        `SELECT cr.source_claim_id, cr.source_version, cr.target_ref
         FROM claim_relations cr
         WHERE cr.problem_id = ? AND cr.kind = 'contradicts'
           AND cr.target_ref GLOB 'C-*@*'
           AND NOT EXISTS (
             -- conflicts carries (claim_a_id, claim_a_version, claim_b_id,
             -- claim_b_version) since 0054; target_ref is "<claim id>@<version>".
             SELECT 1 FROM conflicts c
             WHERE c.problem_id = cr.problem_id
               AND ((c.claim_a_id = cr.source_claim_id AND c.claim_a_version = cr.source_version
                     AND c.claim_b_id || '@' || c.claim_b_version = cr.target_ref)
                 OR (c.claim_b_id = cr.source_claim_id AND c.claim_b_version = cr.source_version
                     AND c.claim_a_id || '@' || c.claim_a_version = cr.target_ref))
           )
         ORDER BY cr.source_claim_id ASC
         LIMIT 1`,
      )
      .bind(problemId)
      .first<{
        source_claim_id: string;
        source_version: number;
        target_ref: string;
      }>();

    if (!row) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("normalize-conflict");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    const claimA = `${row.source_claim_id}@${row.source_version}`;
    const claimB = row.target_ref;

    return {
      move: {
        move: "normalize-conflict",
        why: `Two claims (${claimA} and ${claimB}) appear incompatible but no formal conflict object exists. Walk through definition, scope, and quantifier alignment before opening a dispute.`,
        refs: [problemId, claimA, claimB],
        contract: {
          ...template,
          prefilled_hints: {
            claims: [claimA, claimB],
            aligned_definitions: "Aligned terminology and defined symbols.",
            aligned_scope: "Checked parameter ranges and boundary assumptions.",
            aligned_quantifiers:
              "Verified quantifier ordering and universal vs existential domains.",
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            claim_a: claimA,
            claim_b: claimB,
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "Normalize apparent conflict by checking whether differences stem from notation, scope, or quantifiers before formally asserting a disagreement.",
          },
        },
        selection_boundary: CONFLICT_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
