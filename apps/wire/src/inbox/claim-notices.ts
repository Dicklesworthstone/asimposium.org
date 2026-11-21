import { eventContentHiddenSql } from "../krater/public-content.ts";

/** A critique is actionable only while its exact public source and pinned
 * claim publication are available. Use the same guard when delivering and
 * when reading/counting/acknowledging retained notices. A later revision is
 * not a withdrawal of an earlier published version. All arguments are
 * code-owned SQL expressions, never request text. */
export function visibleClaimNoticeSql(
  eventId: string,
  recipient?: string,
  target?: string,
  problem?: string,
): string {
  const payload =
    "CASE WHEN json_valid(claim_notice_content.payload_json) THEN claim_notice_content.payload_json ELSE '{}' END";
  const claimId = `CASE WHEN claim_notice_source.object_kind = 'review'
    THEN json_extract(${payload}, '$.target_claim_id')
    ELSE json_extract(${payload}, '$.bears_on_id') END`;
  const version = `CASE WHEN claim_notice_source.object_kind = 'review'
    THEN json_extract(${payload}, '$.target_version')
    ELSE json_extract(${payload}, '$.bears_on_version') END`;
  return `EXISTS (
    SELECT 1 FROM events claim_notice_source
    JOIN problems claim_notice_problem ON claim_notice_problem.id = claim_notice_source.problem_id
      AND claim_notice_problem.status <> 'private-draft'
      AND claim_notice_source.seq <= claim_notice_problem.public_seq
    JOIN event_content claim_notice_content ON claim_notice_content.event_id = claim_notice_source.id
      AND claim_notice_content.payload_sha256 = claim_notice_source.payload_sha256
      AND claim_notice_content.redacted_at IS NULL AND json_valid(claim_notice_content.payload_json)
    JOIN events claim_notice_target ON claim_notice_target.problem_id = claim_notice_source.problem_id
      AND claim_notice_target.object_kind = 'claim'
      AND claim_notice_target.type IN ('claim.created', 'claim.revised')
      AND claim_notice_target.object_id = ${claimId}
      AND claim_notice_target.object_version = ${version}
      AND claim_notice_target.seq < claim_notice_source.seq
    JOIN event_content claim_notice_target_content ON claim_notice_target_content.event_id = claim_notice_target.id
      AND claim_notice_target_content.payload_sha256 = claim_notice_target.payload_sha256
      AND claim_notice_target_content.redacted_at IS NULL
    JOIN events claim_notice_author ON claim_notice_author.problem_id = claim_notice_target.problem_id
      AND claim_notice_author.object_kind = 'claim' AND claim_notice_author.type = 'claim.created'
      AND claim_notice_author.object_id = claim_notice_target.object_id
      AND claim_notice_author.object_version = 1
      AND claim_notice_author.seq <= claim_notice_target.seq
    WHERE claim_notice_source.id = ${eventId}
      AND claim_notice_source.object_version = 1
      AND ((claim_notice_source.type = 'review.created' AND claim_notice_source.object_kind = 'review'
        AND json_type(${payload}, '$.target_version') = 'integer')
        OR (claim_notice_source.type = 'evidence.created' AND claim_notice_source.object_kind = 'evidence'
          AND json_extract(${payload}, '$.bears_on_kind') = 'claim'
          AND json_type(${payload}, '$.bears_on_version') = 'integer'))
      AND claim_notice_target.object_version BETWEEN 1 AND 9007199254740991
      AND claim_notice_author.actor_fellow_id <> claim_notice_source.actor_fellow_id
      ${recipient === undefined ? "" : `AND claim_notice_author.actor_fellow_id = ${recipient}`}
      ${
        target === undefined
          ? ""
          : `AND ${target} IN (
        claim_notice_target.object_id || '@' || claim_notice_target.object_version,
        claim_notice_source.object_id)`
      }
      ${problem === undefined ? "" : `AND claim_notice_source.problem_id = ${problem}`}
      AND NOT ${eventContentHiddenSql("claim_notice_source")}
      AND NOT ${eventContentHiddenSql("claim_notice_target")}
      AND NOT EXISTS (
        SELECT 1 FROM scientific_withdrawals claim_notice_withdrawal JOIN events claim_notice_retraction
          ON claim_notice_retraction.id = claim_notice_withdrawal.event_id
          AND claim_notice_retraction.problem_id = claim_notice_withdrawal.problem_id
          AND claim_notice_retraction.seq = claim_notice_withdrawal.seq
          AND claim_notice_retraction.payload_sha256 = claim_notice_withdrawal.event_sha256
          AND claim_notice_retraction.type = 'object.retracted'
          AND claim_notice_retraction.object_kind = 'retraction'
          AND claim_notice_retraction.object_id = claim_notice_withdrawal.retraction_id
          AND claim_notice_retraction.actor_fellow_id = claim_notice_source.actor_fellow_id
        WHERE claim_notice_withdrawal.problem_id = claim_notice_source.problem_id
          AND claim_notice_withdrawal.target_kind = claim_notice_source.object_kind
          AND claim_notice_withdrawal.target_object = claim_notice_source.object_id
          AND claim_notice_withdrawal.source_event_id = claim_notice_source.id
          AND claim_notice_withdrawal.source_sha256 = claim_notice_source.payload_sha256
          AND claim_notice_retraction.seq > claim_notice_source.seq
          AND claim_notice_retraction.seq <= claim_notice_problem.public_seq
      )
      AND NOT EXISTS (
        SELECT 1 FROM retractions claim_notice_retired JOIN events claim_notice_retirement
          ON claim_notice_retirement.problem_id = claim_notice_retired.problem_id
          AND claim_notice_retirement.seq = claim_notice_retired.seq
          AND claim_notice_retirement.type = 'object.retracted'
          AND claim_notice_retirement.object_kind = 'retraction'
          AND claim_notice_retirement.actor_fellow_id = claim_notice_author.actor_fellow_id
        WHERE claim_notice_retired.problem_id = claim_notice_target.problem_id
          AND claim_notice_retired.author_fellow_id = claim_notice_author.actor_fellow_id
          AND claim_notice_retired.target_object IN (claim_notice_target.object_id,
            claim_notice_target.object_id || '@' || claim_notice_target.object_version)
          AND claim_notice_retired.seq > claim_notice_target.seq
          AND claim_notice_retired.seq <= claim_notice_problem.public_seq
      )
  )`;
}

/** Retain the original source-target format as well as current C-n@version
 * notices. Historical rows keep their IDs, cursor and acknowledgment state;
 * their public-derived text receives the same current visibility checks. */
export const VISIBLE_CLAIM_NOTICE_SQL = `(
  fellow_inbox_notices.notice_type <> 'object_critique'
  OR fellow_inbox_notices.target_id IS NULL
  OR (fellow_inbox_notices.target_id NOT LIKE 'C-%'
    AND fellow_inbox_notices.target_id NOT LIKE 'R-%'
    AND fellow_inbox_notices.target_id NOT LIKE 'E-%')
  OR ${visibleClaimNoticeSql(
    "fellow_inbox_notices.caused_by_event_id",
    "fellow_inbox_notices.fellow_id",
    "fellow_inbox_notices.target_id",
    "fellow_inbox_notices.problem_id",
  )}
)`;
