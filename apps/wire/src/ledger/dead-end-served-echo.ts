import type { D1Database } from "@cloudflare/workers-types";

/** At most this many echoes are attempted per served pack. */
export const DEAD_END_SERVED_ECHO_LIMIT = 20;

// One private, unranked notice per (dead end, serving Fellow): the author
// learns their negative result reached someone else's working context
// (Fable §1.3.2), and repeated packs stay quiet. The author comes from the
// dead_ends row, never from pack bodies; self-service, superseded entries and
// private drafts produce nothing. No count is kept or shown anywhere.
export const DEAD_END_SERVED_NOTICE_SQL = `
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail,
    impact_kind, caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  )
  SELECT ?, d.author_fellow_id, d.problem_id, 'impact_echo',
    (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
      THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
     FROM fellow_inbox_notices n WHERE n.fellow_id = d.author_fellow_id),
    'Your dead end ' || d.dead_end_id || ' was served to another Fellow',
    'A later working pack on this problem included this negative result, so the route it closes was visible before new work began. Nothing about that session''s work is implied.',
    'dead_end_served', NULL, d.dead_end_id, NULL, NULL, ?
  FROM dead_ends d
  JOIN problems p ON p.id = d.problem_id AND p.status <> 'private-draft'
  JOIN enrollment_fellows f ON f.fellow_id = d.author_fellow_id
  WHERE d.problem_id = ? AND d.dead_end_id = ?
    AND d.author_fellow_id <> ? AND d.superseded_by IS NULL
  ON CONFLICT (id) DO NOTHING`;

async function echoId(deadEndId: string, servedFellowId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`dead-end-served\0${deadEndId}\0${servedFellowId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `N-des-${hex.slice(0, 48)}`;
}

/** Record echoes for the dead ends a composed pack actually served. Never
 * throws: a pack is never refused because an echo could not be written. */
export async function echoServedDeadEnds(
  db: D1Database,
  input: {
    readonly problemId: string;
    readonly servedFellowId: string;
    readonly deadEndIds: readonly string[];
    readonly now?: number;
  },
): Promise<{ readonly attempted: number; readonly written: number; readonly failed: boolean }> {
  const ids = [...new Set(input.deadEndIds)].slice(0, DEAD_END_SERVED_ECHO_LIMIT);
  if (ids.length === 0) return { attempted: 0, written: 0, failed: false };
  const now = input.now ?? Date.now();
  try {
    const statements = await Promise.all(
      ids.map(async (deadEndId) =>
        db
          .prepare(DEAD_END_SERVED_NOTICE_SQL)
          .bind(
            await echoId(deadEndId, input.servedFellowId),
            now,
            input.problemId,
            deadEndId,
            input.servedFellowId,
          ),
      ),
    );
    const results = await db.batch(statements);
    return {
      attempted: ids.length,
      written: results.reduce((total, result) => total + (result.meta.changes ?? 0), 0),
      failed: false,
    };
  } catch {
    return { attempted: ids.length, written: 0, failed: true };
  }
}
