import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";

/** The caller's view of the formulation, separate from the newer server
 * snapshot assembled for publication screening. */
export interface ClientStatementContext {
  readonly cursor?: number;
  /** Immutable ledger cut captured by the actual session's INSERT. Legacy
   * NULL sessions cannot establish context from their wall-clock timestamp. */
  readonly sessionOpenedPublicCursor?: number | null;
}

function revisionSince(problemId: string, context: ClientStatementContext) {
  const cursor = context.cursor ?? context.sessionOpenedPublicCursor ?? undefined;
  return {
    sql: `SELECT seq, object_version FROM events
      WHERE problem_id = ? AND type = 'problem.statement-revised'
        ${cursor === undefined ? "" : "AND seq > ?"}
      ORDER BY seq DESC LIMIT 1`,
    bindings: [problemId, ...(cursor === undefined ? [] : [cursor])],
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
  if (context.cursor !== undefined) {
    const problem = await db
      .prepare("SELECT public_seq FROM problems WHERE id = ? AND status <> 'private-draft'")
      .bind(problemId)
      .first<{ public_seq: number }>();
    // A context cursor names an already observed ledger cut, never a promise
    // to accept future formulations. The head cannot move backward after admission.
    // This diagnostic can precede problem authorization on direct append.
    // Leave private and missing problems to the caller's existing authority path.
    if (problem && context.cursor > problem.public_seq)
      return validatedProblem({
        status: 400,
        code: "SCHEMA_INVALID",
        title: "Statement context cursor is ahead of the problem",
        detail: `The statement context cursor ${context.cursor} is ahead of the problem's current cursor ${problem.public_seq}.`,
        fixHint: `Read GET /p/${problemId}.md or a fresh session pack and send the cursor you actually observed.`,
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { client_context_cursor: problem.public_seq },
        },
      });
  }
  const query = revisionSince(problemId, context);
  const revised = await db
    .prepare(query.sql)
    .bind(...query.bindings)
    .first<{ seq: number; object_version: number }>();
  if (!revised) return null;
  const cursor = context.cursor ?? context.sessionOpenedPublicCursor ?? 0;
  return validatedProblem({
    status: 409,
    code: "STATEMENT_REVISED_SINCE",
    title: "Problem statement revised since context cursor",
    detail: `The problem statement was revised at cursor ${revised.seq} (version ${revised.object_version}) after your context cursor ${cursor}.`,
    fixHint: `Re-orient with GET /p/${problemId}.md or check your /v1/inbox, then retry with the current cursor.`,
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/problem.v1.json",
      example: { client_context_cursor: revised.seq },
      delta_pointer: `/p/${problemId}.md`,
      problem_id: problemId,
      client_context_cursor: cursor,
      revised_at_cursor: revised.seq,
      statement_version: revised.object_version,
    },
  });
}

/** Execute in the same D1 batch as the scientific event and its receipt. A
 * moved-head attempt with no inserted event stays inert so Krater may retry;
 * an inserted event cannot adopt a statement newer than its author's context.
 * An explicit cursor must also precede this event: the privacy-safe preflight
 * may have seen a private draft that became public before this transaction. */
export function clientStatementContextGuard(
  db: D1Database,
  problemId: string,
  context: ClientStatementContext,
  eventId: string,
): D1PreparedStatement {
  const query = revisionSince(problemId, context);
  return db
    .prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = ?)
      OR (NOT EXISTS (${query.sql})
        ${context.cursor === undefined ? "" : "AND ? < (SELECT seq FROM events WHERE id = ? AND problem_id = ?)"}) THEN 1
      ELSE json_extract('[]', '$[STATEMENT_REVISED_SINCE') END`)
    .bind(
      eventId,
      ...query.bindings,
      ...(context.cursor === undefined ? [] : [context.cursor, eventId, problemId]),
    );
}
