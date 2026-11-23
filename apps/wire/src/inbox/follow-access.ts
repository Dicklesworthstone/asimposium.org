import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { VISIBLE_CITATION_REUSE_NOTICE_SQL } from "./citation-reuse-notices.ts";
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

/** Impact notices name public work, not a separate copy of that work. The
 * immutable author and exact causal event must still be readable at the
 * current public cut. Keep this bind-free predicate in every inbox read,
 * count and acknowledgment, including the final hydration recheck.
 *
 * Notices without a structured problem and target keep their existing behavior.
 * Citation reuse has its own exact cross-problem source-pair guard below. */
const VISIBLE_RESEARCH_IMPACT_SQL = `(
  fellow_inbox_notices.notice_type <> 'impact_echo'
  OR fellow_inbox_notices.impact_kind IS NULL
  OR fellow_inbox_notices.impact_kind NOT IN
    ('dead_end_served', 'retry_trigger_fired', 'gap_closed')
  OR fellow_inbox_notices.problem_id IS NULL
  OR fellow_inbox_notices.target_id IS NULL
  OR EXISTS (
    SELECT 1 FROM events impact_source
    JOIN problems impact_problem ON impact_problem.id = impact_source.problem_id
      AND impact_problem.status <> 'private-draft'
      AND impact_source.seq <= impact_problem.public_seq
    JOIN event_content impact_content ON impact_content.event_id = impact_source.id
      AND impact_content.payload_sha256 = impact_source.payload_sha256
      AND impact_content.redacted_at IS NULL AND json_valid(impact_content.payload_json)
    LEFT JOIN events impact_cause ON impact_cause.id = fellow_inbox_notices.caused_by_event_id
      AND impact_cause.problem_id = impact_source.problem_id
      AND impact_cause.seq > impact_source.seq AND impact_cause.seq <= impact_problem.public_seq
    LEFT JOIN event_content impact_cause_content ON impact_cause_content.event_id = impact_cause.id
      AND impact_cause_content.payload_sha256 = impact_cause.payload_sha256
      AND impact_cause_content.redacted_at IS NULL
      AND json_valid(impact_cause_content.payload_json)
    WHERE impact_source.problem_id = fellow_inbox_notices.problem_id
      AND impact_source.object_id = fellow_inbox_notices.target_id
      AND impact_source.object_version = 1
      AND impact_source.actor_fellow_id = fellow_inbox_notices.fellow_id
      AND NOT ${eventContentHiddenSql("impact_source")}
      AND (
        (fellow_inbox_notices.impact_kind = 'dead_end_served'
          AND impact_source.type = 'dead_end.recorded' AND impact_source.object_kind = 'dead_end'
          AND fellow_inbox_notices.caused_by_event_id IS NULL)
        OR (impact_cause_content.event_id IS NOT NULL
          AND NOT ${eventContentHiddenSql("impact_cause")}
          AND (
            (fellow_inbox_notices.impact_kind = 'gap_closed'
              AND impact_source.type = 'gap.filed' AND impact_source.object_kind = 'gap'
              AND impact_cause.type = 'gap.closed-by' AND impact_cause.object_kind = 'gap'
              AND impact_cause.object_id = impact_source.object_id
              AND impact_cause.actor_fellow_id IS NOT NULL
              AND impact_cause.actor_fellow_id <> impact_source.actor_fellow_id)
            OR (fellow_inbox_notices.impact_kind = 'retry_trigger_fired'
              AND impact_source.type = 'dead_end.recorded'
              AND impact_source.object_kind = 'dead_end'
              AND (
                (json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.kind') = 'statement-revised'
                  AND impact_cause.type = 'problem.statement-revised'
                  AND impact_cause.object_kind = 'problem'
                  AND impact_cause.object_id = impact_source.problem_id)
                OR (json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.kind') = 'gap-closed'
                  AND impact_cause.type = 'gap.closed-by' AND impact_cause.object_kind = 'gap'
                  AND impact_cause.object_id =
                    json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.gap_id'))
                OR (json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.kind') = 'claim-reaches'
                  AND (
                    (impact_cause.type = 'claim.revised' AND impact_cause.object_kind = 'claim'
                      AND impact_cause.object_id =
                        json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.claim_id'))
                    OR (impact_cause.type = 'review.created' AND impact_cause.object_kind = 'review'
                      AND json_extract(CASE WHEN json_valid(impact_cause_content.payload_json)
                        THEN impact_cause_content.payload_json ELSE '{}' END, '$.target_claim_id') =
                        json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.claim_id'))
                    OR (impact_cause.type = 'evidence.created' AND impact_cause.object_kind = 'evidence'
                      AND json_extract(CASE WHEN json_valid(impact_cause_content.payload_json)
                        THEN impact_cause_content.payload_json ELSE '{}' END, '$.bears_on_kind') = 'claim'
                      AND json_extract(CASE WHEN json_valid(impact_cause_content.payload_json)
                        THEN impact_cause_content.payload_json ELSE '{}' END, '$.bears_on_id') =
                        json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.claim_id'))
                    OR (impact_cause.type = 'object.retracted' AND impact_cause.object_kind = 'retraction'
                      AND (json_extract(CASE WHEN json_valid(impact_cause_content.payload_json)
                        THEN impact_cause_content.payload_json ELSE '{}' END, '$.target_object') =
                        json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.claim_id')
                        OR json_extract(CASE WHEN json_valid(impact_cause_content.payload_json)
                        THEN impact_cause_content.payload_json ELSE '{}' END, '$.target_object') LIKE
                          json_extract(CASE WHEN json_valid(impact_content.payload_json)
                    THEN impact_content.payload_json ELSE '{}' END, '$.retry_when.claim_id') || '@%'))
                  ))
              ))
          ))
      )
  )
)`;

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
) AND ${VISIBLE_CLAIM_NOTICE_SQL} AND ${VISIBLE_HYPOTHESIS_NOTICE_SQL} AND ${VISIBLE_QUESTION_ANSWER_NOTICE_SQL} AND ${VISIBLE_RESEARCH_IMPACT_SQL} AND ${VISIBLE_CITATION_REUSE_NOTICE_SQL}`;

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
