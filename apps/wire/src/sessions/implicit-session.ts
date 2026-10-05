import type { D1Database } from "@cloudflare/workers-types";

/**
 * A direct append gives back its count on the implicit session it used
 * (6svb, migration 0085). Bindings: closed_at, session_id, fellow_id. The
 * request that takes the count from 1 to 0 closes the session: 'Direct
 * append' when it authored an event, 'Direct append failed' when nothing was
 * written. closed_at is never before the session's own instants (the clock
 * that opened or last joined it may run ahead of this one). An explicit
 * session (count NULL) and an already-closed one are left alone.
 */
export const IMPLICIT_SESSION_RELEASE_SQL = `UPDATE sessions
   SET implicit_inflight = implicit_inflight - 1,
       closed_at = CASE WHEN implicit_inflight = 1
         THEN max(?, opened_at, last_heartbeat_at) ELSE closed_at END,
       handback = CASE WHEN implicit_inflight = 1 THEN
         CASE WHEN EXISTS (SELECT 1 FROM events e
                           WHERE e.problem_id = sessions.problem_id
                             AND e.actor_session_id = sessions.session_id)
           THEN 'Direct append' ELSE 'Direct append failed' END
         ELSE handback END
 WHERE session_id = ? AND fellow_id = ? AND closed_at IS NULL
   AND implicit_inflight >= 1`;

const inUse = new WeakMap<Request, { readonly sessionId: string; readonly fellowId: string }[]>();

/** Records the session a direct append joined or opened (and counted). */
export function trackDirectAppendSession(
  request: Request,
  sessionId: string,
  fellowId: string,
): void {
  const sessions = inUse.get(request) ?? [];
  sessions.push({ sessionId, fellowId });
  inUse.set(request, sessions);
}

/**
 * Gives back every count this request took, once its response is ready, on
 * every path (success, refusal or throw). A failed release leaves the session
 * to the idle sweep, as before 0085; it never fails the response.
 */
export async function releaseDirectAppendSessions(db: D1Database, request: Request): Promise<void> {
  const sessions = inUse.get(request);
  if (sessions === undefined) return;
  inUse.delete(request);
  for (const { sessionId, fellowId } of sessions) {
    await db
      .prepare(IMPLICIT_SESSION_RELEASE_SQL)
      .bind(new Date().toISOString(), sessionId, fellowId)
      .run()
      .catch(() => {});
  }
}
