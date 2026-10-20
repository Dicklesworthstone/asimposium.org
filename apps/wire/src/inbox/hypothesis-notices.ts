import { eventContentHiddenSql } from "../krater/public-content.ts";

/** The source event, target creation and current controls are the authority.
 * This expression is also used before inbox pagination/counting/acknowledgment,
 * so a later withdrawal or hide cannot leave an actionable stale notification.
 * eventId and recipient are code-owned SQL expressions, never request text. */
export function visibleHypothesisNoticeSql(
  eventId: string,
  recipient?: string,
  target?: string,
): string {
  return `EXISTS (
    SELECT 1 FROM events notice_source
    JOIN problems notice_problem ON notice_problem.id = notice_source.problem_id
      AND notice_problem.status <> 'private-draft' AND notice_source.seq <= notice_problem.public_seq
    JOIN event_content notice_content ON notice_content.event_id = notice_source.id
      AND notice_content.payload_sha256 = notice_source.payload_sha256
      AND notice_content.redacted_at IS NULL AND json_valid(notice_content.payload_json)
    JOIN events notice_author ON notice_author.problem_id = notice_source.problem_id
      AND notice_author.type = 'hypothesis.created' AND notice_author.object_kind = 'hypothesis'
      AND notice_author.object_version = 1 AND notice_author.seq < notice_source.seq
      AND notice_author.object_id = json_extract(CASE WHEN json_valid(notice_content.payload_json)
        THEN notice_content.payload_json ELSE '{}' END, '$.bears_on_id')
    JOIN event_content notice_target ON notice_target.event_id = notice_author.id
      AND notice_target.payload_sha256 = notice_author.payload_sha256
      AND notice_target.redacted_at IS NULL
    WHERE notice_source.id = ${eventId}
      AND notice_source.type = 'evidence.created' AND notice_source.object_kind = 'evidence'
      AND notice_source.object_version = 1
      AND json_extract(CASE WHEN json_valid(notice_content.payload_json)
        THEN notice_content.payload_json ELSE '{}' END, '$.bears_on_kind') = 'hypothesis'
      AND json_extract(CASE WHEN json_valid(notice_content.payload_json)
        THEN notice_content.payload_json ELSE '{}' END, '$.bears_on_version') IS NULL
      ${
        recipient === undefined
          ? ""
          : `AND notice_author.actor_fellow_id = ${recipient}
        AND notice_author.actor_fellow_id <> notice_source.actor_fellow_id`
      }
      ${target === undefined ? "" : `AND notice_author.object_id = ${target}`}
      AND NOT ${eventContentHiddenSql("notice_source")}
      AND NOT ${eventContentHiddenSql("notice_author")}
      AND NOT EXISTS (
        SELECT 1 FROM scientific_withdrawals notice_withdrawal JOIN events notice_retraction
          ON notice_retraction.id = notice_withdrawal.event_id
          AND notice_retraction.problem_id = notice_withdrawal.problem_id
          AND notice_retraction.seq = notice_withdrawal.seq
          AND notice_retraction.payload_sha256 = notice_withdrawal.event_sha256
          AND notice_retraction.type = 'object.retracted'
          AND notice_retraction.object_kind = 'retraction'
          AND notice_retraction.object_id = notice_withdrawal.retraction_id
        WHERE notice_withdrawal.problem_id = notice_source.problem_id
          AND notice_withdrawal.target_kind = 'evidence'
          AND notice_withdrawal.target_object = notice_source.object_id
          AND notice_withdrawal.source_event_id = notice_source.id
          AND notice_withdrawal.source_sha256 = notice_source.payload_sha256
          AND notice_retraction.seq <= notice_problem.public_seq
      )
  )`;
}

export const VISIBLE_HYPOTHESIS_NOTICE_SQL = `(
  fellow_inbox_notices.notice_type <> 'object_critique'
  OR fellow_inbox_notices.target_id IS NULL
  OR fellow_inbox_notices.target_id NOT LIKE 'H-%'
  OR ${visibleHypothesisNoticeSql(
    "fellow_inbox_notices.caused_by_event_id",
    "fellow_inbox_notices.fellow_id",
    "fellow_inbox_notices.target_id",
  )}
)`;
