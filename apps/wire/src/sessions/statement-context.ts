import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";

/** The caller's view of the formulation, separate from the newer server
 * snapshot assembled for publication screening. */
export interface ClientStatementContext {
  readonly cursor?: number;
  readonly sessionOpenedAt?: string;
}

function revisionSince(problemId: string, context: ClientStatementContext) {
  return {
    sql: `SELECT seq, object_version FROM events
      WHERE problem_id = ? AND type = 'problem.statement-revised'
        ${context.cursor !== undefined ? "AND seq > ?" : context.sessionOpenedAt !== undefined ? "AND created_at >= ?" : ""}
      ORDER BY seq DESC LIMIT 1`,
    bindings: [
      problemId,
      ...(context.cursor !== undefined
        ? [context.cursor]
        : context.sessionOpenedAt !== undefined
          ? [context.sessionOpenedAt]
          : []),
    ],
  };
}

export async function clientStatementContextConflict(
  db: D1Database,
  problemId: string,
  context: ClientStatementContext,
): Promise<Response | null> {
  if (context.cursor !== undefined && (!Number.isSafeInteger(context.cursor) || context.cursor < 0))
    return validatedProblem({
      status: 400,
      code: "SCHEMA_INVALID",
      title: "Invalid statement context cursor",
      detail: "The statement context cursor must be a non-negative safe integer.",
      fixHint: "Send the cursor from the problem or session pack you used to prepare this write.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        example: { client_context_cursor: 0 },
      },
    });
  const query = revisionSince(problemId, context);
  const revised = await db
    .prepare(query.sql)
    .bind(...query.bindings)
    .first<{ seq: number; object_version: number }>();
  if (!revised) return null;
  return validatedProblem({
    status: 409,
    code: "STATEMENT_REVISED_SINCE",
    title: "Problem statement revised since context cursor",
    detail: `The problem statement was revised at cursor ${revised.seq} (version ${revised.object_version}) after your context cursor ${context.cursor ?? 0}.`,
    fixHint: `Re-orient with GET /p/${problemId}.md or check your /v1/inbox, then retry with the current cursor.`,
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/problem.v1.json",
      example: { client_context_cursor: revised.seq },
      delta_pointer: `/p/${problemId}.md`,
      problem_id: problemId,
      client_context_cursor: context.cursor ?? 0,
      revised_at_cursor: revised.seq,
      statement_version: revised.object_version,
    },
  });
}

/** Execute in the same D1 batch as the scientific event and its receipt. A
 * moved-head attempt with no inserted event stays inert so Krater may retry;
 * an inserted event cannot adopt a statement newer than its author's context. */
export function clientStatementContextGuard(
  db: D1Database,
  problemId: string,
  context: ClientStatementContext,
  eventId: string,
): D1PreparedStatement {
  const query = revisionSince(problemId, context);
  return db
    .prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = ?)
      OR NOT EXISTS (${query.sql}) THEN 1
      ELSE json_extract('[]', '$[STATEMENT_REVISED_SINCE') END`)
    .bind(eventId, ...query.bindings);
}
