/** Known-ID reads may reach unlisted public problems. Private drafts require
 * current durable membership; a follow is never an access grant. Keep these
 * guards inside the reads and mutations, not in a raceable preflight check. */
export const FOLLOW_STATUS_SQL = `
  SELECT p.id AS problem_id, f.created_at
  FROM problems p LEFT JOIN problem_follows f
    ON f.problem_id = p.id AND f.principal_id = ?
  WHERE p.id = ? AND (
    p.status <> 'private-draft' OR EXISTS (
      SELECT 1 FROM problem_memberships m WHERE m.problem_id = p.id AND m.fellow_id = ?
    )
  )`;

export const FOLLOW_INSERT_SQL = `
  INSERT INTO problem_follows (principal_id, problem_id, created_at)
  SELECT ?, p.id, ? FROM problems p WHERE p.id = ? AND (
    p.status <> 'private-draft' OR EXISTS (
      SELECT 1 FROM problem_memberships m WHERE m.problem_id = p.id AND m.fellow_id = ?
    )
  )
  ON CONFLICT (principal_id, problem_id) DO NOTHING`;

export const FOLLOW_DELETE_SQL = `
  DELETE FROM problem_follows WHERE principal_id = ? AND problem_id = ? AND EXISTS (
    SELECT 1 FROM problems p WHERE p.id = problem_follows.problem_id AND (
      p.status <> 'private-draft' OR EXISTS (
        SELECT 1 FROM problem_memberships m WHERE m.problem_id = p.id AND m.fellow_id = ?
      )
    )
  )`;

/** Correlated against the outer notice, including on UPDATE. Recheck access
 * for queued notices as well as new fan-out. Apply before pagination and to
 * counts/acknowledgments so hidden notices cannot become an existence oracle.
 * Account-level notices without a problem remain available to their recipient. */
export const VISIBLE_INBOX_NOTICE_SQL = `(
  fellow_inbox_notices.problem_id IS NULL OR EXISTS (
    SELECT 1 FROM problems p WHERE p.id = fellow_inbox_notices.problem_id AND (
      p.status <> 'private-draft' OR EXISTS (
        SELECT 1 FROM problem_memberships m
        WHERE m.problem_id = p.id AND m.fellow_id = fellow_inbox_notices.fellow_id
      )
    )
  )
)`;

export const INBOX_UNACKNOWLEDGED_SQL = `
  SELECT COUNT(*) AS unack FROM fellow_inbox_notices
  WHERE fellow_id = ? AND acknowledged_at IS NULL AND ${VISIBLE_INBOX_NOTICE_SQL}`;

export const FOLLOW_RECIPIENTS_SQL = `
  WITH target AS (SELECT id, status FROM problems WHERE id = ?),
  candidates AS (
    SELECT f.principal_id FROM problem_follows f JOIN target p ON p.id = f.problem_id
    UNION
    SELECT m.fellow_id AS principal_id FROM problem_memberships m JOIN target p ON p.id = m.problem_id
  )
  SELECT c.principal_id FROM candidates c
  JOIN enrollment_fellows f ON f.fellow_id = c.principal_id
  CROSS JOIN target p
  WHERE p.status <> 'private-draft' OR EXISTS (
    SELECT 1 FROM problem_memberships m WHERE m.problem_id = p.id AND m.fellow_id = c.principal_id
  )
  ORDER BY c.principal_id`;
