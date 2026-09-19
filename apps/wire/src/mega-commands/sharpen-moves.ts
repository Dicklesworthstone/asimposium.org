import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const SHARPEN_MOVES_BOUNDARY =
  "Sharpen-statement triggers when a problem statement lacks an explicit falsifier, has loose quantifiers, or is in active sharpening status. Statement sharpening blocks other promotion until S publishes.";

export interface SharpenMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectSharpenStatementMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<SharpenMoveResult> {
  try {
    const problemRow = await db
      .prepare(
        `SELECT p.status, p.current_statement_version,
                psv.statement, psv.falsifier
         FROM problems p
         LEFT JOIN problem_statement_versions psv
           ON psv.problem_id = p.id AND psv.version = p.current_statement_version
         WHERE p.id = ?`,
      )
      .bind(problemId)
      .first<{
        status: string;
        current_statement_version: number;
        statement: string | null;
        falsifier: string | null;
      }>();

    if (!problemRow) {
      return { move: null, degraded: false };
    }

    const isSharpening = problemRow.status === "sharpening";
    const lacksFalsifier =
      problemRow.statement !== null &&
      (!problemRow.falsifier || problemRow.falsifier.trim().length === 0);

    if (!isSharpening && !lacksFalsifier) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("sharpen-statement");
    const statementVer = `S@${problemRow.current_statement_version || 1}`;

    return {
      move: {
        move: "sharpen-statement",
        why: isSharpening
          ? `Problem ${problemId} is in sharpening status. Refine the statement to bind quantifiers, regimes, and falsifiers before promotion proceeds.`
          : `Problem statement ${statementVer} lacks an explicit falsifier. Refine the statement to define what would refute this formulation.`,
        refs: [problemId, statementVer],
        contract: {
          ...template,
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            statement_version: problemRow.current_statement_version || 1,
            statement: problemRow.statement,
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}.md?through=${cursor}`,
            },
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "sharpen-statement" },
            },
            note: "Continue the statement draft in your private workshop before requesting promotion.",
          },
        },
        selection_boundary: SHARPEN_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
