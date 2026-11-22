import { hiddenByContentControlSql } from "../krater/public-content.ts";
import { VISIBLE_CLAIM_NOTICE_SQL } from "./claim-notices.ts";
import { VISIBLE_HYPOTHESIS_NOTICE_SQL } from "./hypothesis-notices.ts";
import { VISIBLE_QUESTION_ANSWER_NOTICE_SQL } from "./question-notices.ts";

// Match public problem and sponsor-follow readers. An object-ID control and
// the whole-problem control are independent; restoring one cannot override
// the other. Only code-owned SQL aliases reach this helper.
function problemContentAvailableSql(alias: string): string {
  return `NOT ${hiddenByContentControlSql(`${alias}.id`, "'problem'")}
    AND NOT ${hiddenByContentControlSql(`${alias}.id`, `${alias}.id`)}`;
}

/** Known-ID reads may reach unlisted public problems. Private drafts require
 * current durable membership; a follow is never an access grant. Keep these
 * guards inside the reads and mutations, not in a raceable preflight check. */
export const FOLLOW_STATUS_SQL = `
  SELECT p.id AS problem_id, f.created_at
  FROM problems p LEFT JOIN problem_follows f
    ON f.problem_id = p.id AND f.principal_id = ?
  WHERE p.id = ? AND ${problemContentAvailableSql("p")} AND (
    p.status <> 'private-draft' OR EXISTS (
      SELECT 1 FROM problem_memberships m WHERE m.problem_id = p.id AND m.fellow_id = ?
    )
  )`;

export const FOLLOW_INSERT_SQL = `
  INSERT INTO problem_follows (principal_id, problem_id, created_at)
  SELECT ?, p.id, ? FROM problems p WHERE p.id = ? AND ${problemContentAvailableSql("p")} AND (
    p.status <> 'private-draft' OR EXISTS (
      SELECT 1 FROM problem_memberships m WHERE m.problem_id = p.id AND m.fellow_id = ?
    )
  )
  ON CONFLICT (principal_id, problem_id) DO NOTHING`;

// Removing one's own preference needs no continuing problem access. A hide
// or lost private membership must not trap a subscription that reactivates
// on restore. The response never discloses whether the target exists.
export const FOLLOW_DELETE_SQL = `
  DELETE FROM problem_follows WHERE principal_id = ? AND problem_id = ?`;

/** Correlated against the outer notice, including on UPDATE. Recheck access
 * for queued notices as well as new fan-out. Apply before pagination and to
 * counts/acknowledgments so hidden notices cannot become an existence oracle.
 * Account-level notices without a problem remain available to their recipient.
 * Private instructions and recovery notices carry the recipient's own state,
 * not public research; hiding a problem must not strand appeals or lease release.
 * Every other kind (including future types) obeys current problem controls. */
export const VISIBLE_INBOX_NOTICE_SQL = `(
  fellow_inbox_notices.problem_id IS NULL OR EXISTS (
    SELECT 1 FROM problems p WHERE p.id = fellow_inbox_notices.problem_id
      AND (fellow_inbox_notices.notice_type IN (
        'sponsor_directive', 'protocol_notice', 'moderation_outcome', 'lease_expiry_warning'
      ) OR (${problemContentAvailableSql("p")}))
      AND (
        p.status <> 'private-draft' OR EXISTS (
          SELECT 1 FROM problem_memberships m
          WHERE m.problem_id = p.id AND m.fellow_id = fellow_inbox_notices.fellow_id
        )
      )
  )
) AND ${VISIBLE_CLAIM_NOTICE_SQL} AND ${VISIBLE_HYPOTHESIS_NOTICE_SQL} AND ${VISIBLE_QUESTION_ANSWER_NOTICE_SQL}`;

/** Expiry ends inbox actionability, not durable history or cursor allocation.
 * Bind one captured request time after any visibility bindings. */
export const UNEXPIRED_INBOX_NOTICE_SQL = `(fellow_inbox_notices.expires_at IS NULL
  OR fellow_inbox_notices.expires_at > ?)`;

export const INBOX_UNACKNOWLEDGED_SQL = `
  SELECT COUNT(*) AS unack FROM fellow_inbox_notices
  WHERE fellow_id = ? AND acknowledged_at IS NULL AND ${VISIBLE_INBOX_NOTICE_SQL}
    AND ${UNEXPIRED_INBOX_NOTICE_SQL}`;

export const FOLLOW_RECIPIENTS_SQL = `
  WITH target AS (
    SELECT p.id, p.status FROM problems p
    WHERE p.id = ? AND ${problemContentAvailableSql("p")}
  ),
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
