import type { D1Database } from "@cloudflare/workers-types";

export const IDLE_SESSION_SWEEP_LIMIT = 32;

interface IdleSession {
  session_id: string;
  idle_close_at: string;
}

export interface IdleSessionSweepResult {
  readonly closed: number;
  readonly hasMore: boolean;
}

// Every effect rechecks the same observed deadline while the session is open.
// A heartbeat or explicit close between selection and batch therefore wins
// without losing work, expiring its leases, or creating a false notification.
const STILL_IDLE = `session_id = ? AND closed_at IS NULL
  AND idle_close_at = ? AND idle_close_at <= ?`;

export const IDLE_SESSION_NOTICE_SQL = `
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail,
    impact_kind, caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  )
  SELECT ?, s.fellow_id, s.problem_id, 'protocol_notice',
    (SELECT COALESCE(MAX(n.seq), 0) + 1 FROM fellow_inbox_notices n WHERE n.fellow_id = s.fellow_id),
    'Idle session closed',
    'The session closed after its idle deadline. Workshop drafts are preserved; nothing was promoted. Open a new session to continue.',
    NULL, NULL, s.session_id, NULL, NULL, ?
  FROM sessions s WHERE ${STILL_IDLE}
  ON CONFLICT (id) DO NOTHING`;

export const IDLE_SESSION_LEASES_SQL = `
  UPDATE leases SET status = 'expired', updated_at = ?
  WHERE session_id IN (SELECT session_id FROM sessions WHERE ${STILL_IDLE})
    AND status IN ('active', 'challenged')`;

export const IDLE_SESSION_CLOSE_SQL = `
  UPDATE sessions SET closed_at = ? WHERE ${STILL_IDLE}
  RETURNING session_id`;

async function noticeId(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`session-idle-closed\0${sessionId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Retire abandoned work slots without manufacturing an author handback or
 * publishing workshop content. One bounded pass; the next scheduled tick
 * drains any remaining backlog. D1 batch commits notice, leases and closure
 * together or rolls all three back. No public event/cursor is touched. */
export async function expireIdleSessions(
  db: D1Database,
  options: { readonly now?: number; readonly limit?: number; readonly fellowId?: string } = {},
): Promise<IdleSessionSweepResult> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? IDLE_SESSION_SWEEP_LIMIT;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > IDLE_SESSION_SWEEP_LIMIT ||
    (options.fellowId !== undefined && options.fellowId.length === 0)
  ) {
    throw new TypeError("Invalid idle session sweep bounds.");
  }
  const timestamp = new Date(now).toISOString();
  const selection = db.prepare(`SELECT session_id, idle_close_at FROM sessions
    WHERE closed_at IS NULL AND idle_close_at <= ?
    ${options.fellowId === undefined ? "" : "AND fellow_id = ?"}
    ORDER BY idle_close_at, session_id LIMIT ?`);
  const selected = await (options.fellowId === undefined
    ? selection.bind(timestamp, limit + 1)
    : selection.bind(timestamp, options.fellowId, limit + 1)
  ).all<IdleSession>();
  let closed = 0;
  for (const session of selected.results.slice(0, limit)) {
    const id = await noticeId(session.session_id);
    const guard = [session.session_id, session.idle_close_at, timestamp] as const;
    const results = await db.batch<{ session_id: string }>([
      db.prepare(IDLE_SESSION_NOTICE_SQL).bind(id, now, ...guard),
      db.prepare(IDLE_SESSION_LEASES_SQL).bind(timestamp, ...guard),
      db.prepare(IDLE_SESSION_CLOSE_SQL).bind(timestamp, ...guard),
    ]);
    const receipt = results[2]?.results;
    if (
      !receipt ||
      receipt.length > 1 ||
      (receipt.length === 1 && receipt[0]?.session_id !== session.session_id)
    ) {
      throw new Error("Idle session sweep produced an invalid closure receipt.");
    }
    closed += receipt.length;
  }
  return { closed, hasMore: selected.results.length > limit };
}
