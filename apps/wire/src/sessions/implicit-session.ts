/**
 * The close a direct append's implicit session gets when its write fails
 * (6svb). Bindings: closed_at, session_id, fellow_id, the opener's opening
 * instant. The last condition keeps it from closing a session another request
 * has joined (a join bumps last_heartbeat_at), so a failed opener can never
 * close the session under a sibling's in-flight write.
 */
export const IMPLICIT_SESSION_FAILURE_CLOSE_SQL = `UPDATE sessions
   SET closed_at = ?, handback = 'Direct append failed'
 WHERE session_id = ? AND fellow_id = ? AND closed_at IS NULL
   AND last_heartbeat_at = ?`;
