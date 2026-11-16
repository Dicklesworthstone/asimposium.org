import { AskQuestionRequestSchema, QuestionIdSchema } from "@asimposium/contracts/questions";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  checkedScientificPayload,
  type ScientificContentIdentity,
  ScientificInputError,
} from "../ledger/scientific-checks.ts";
import { findSettlementReference } from "../ledger/settlement-references.ts";

/** Question answers are pointers to published work. Keep both the question and
 * that exact publication live before delivery, pagination, counts and ack.
 * All interpolated expressions are code-owned SQL, never request text. */
export function visibleQuestionAnswerNoticeSql(
  eventId: string,
  recipient?: string,
  target?: string,
): string {
  return `EXISTS (
    SELECT 1 FROM events notice_answer
    JOIN problems notice_problem ON notice_problem.id = notice_answer.problem_id
      AND notice_problem.status <> 'private-draft' AND notice_answer.seq <= notice_problem.public_seq
    JOIN event_content notice_answer_content ON notice_answer_content.event_id = notice_answer.id
      AND notice_answer_content.payload_sha256 = notice_answer.payload_sha256
      AND notice_answer_content.redacted_at IS NULL AND json_valid(notice_answer_content.payload_json)
    JOIN events notice_question ON notice_question.problem_id = notice_answer.problem_id
      AND notice_question.object_kind = 'question' AND notice_question.type = 'question.asked'
      AND notice_question.object_id = notice_answer.object_id AND notice_question.object_version = 1
      AND notice_question.seq < notice_answer.seq
    JOIN event_content notice_question_content ON notice_question_content.event_id = notice_question.id
      AND notice_question_content.payload_sha256 = notice_question.payload_sha256
      AND notice_question_content.redacted_at IS NULL AND json_valid(notice_question_content.payload_json)
    JOIN events notice_reference ON notice_reference.problem_id = notice_answer.problem_id
      AND notice_reference.seq < notice_answer.seq
      AND notice_reference.object_id = CASE
        WHEN instr(json_extract(CASE WHEN json_valid(notice_answer_content.payload_json)
          THEN notice_answer_content.payload_json ELSE '{}' END, '$.resolved_by_object'), '@') > 0
        THEN substr(json_extract(CASE WHEN json_valid(notice_answer_content.payload_json)
          THEN notice_answer_content.payload_json ELSE '{}' END, '$.resolved_by_object'), 1,
          instr(json_extract(CASE WHEN json_valid(notice_answer_content.payload_json)
            THEN notice_answer_content.payload_json ELSE '{}' END, '$.resolved_by_object'), '@') - 1)
        ELSE json_extract(CASE WHEN json_valid(notice_answer_content.payload_json)
          THEN notice_answer_content.payload_json ELSE '{}' END, '$.resolved_by_object') END
      AND ((notice_reference.object_kind = 'claim'
        AND notice_reference.type IN ('claim.created', 'claim.revised')
        AND notice_reference.object_id || '@' || notice_reference.object_version =
          json_extract(CASE WHEN json_valid(notice_answer_content.payload_json)
            THEN notice_answer_content.payload_json ELSE '{}' END, '$.resolved_by_object'))
        OR (notice_reference.object_kind IN ('evidence', 'review')
          AND notice_reference.type = notice_reference.object_kind || '.created'
          AND notice_reference.object_version = 1
          AND json_extract(CASE WHEN json_valid(notice_answer_content.payload_json)
            THEN notice_answer_content.payload_json ELSE '{}' END, '$.resolved_by_object')
            IN (notice_reference.object_id, notice_reference.object_id || '@1')))
    JOIN event_content notice_reference_content ON notice_reference_content.event_id = notice_reference.id
      AND notice_reference_content.payload_sha256 = notice_reference.payload_sha256
      AND notice_reference_content.redacted_at IS NULL
    WHERE notice_answer.id = ${eventId}
      AND notice_answer.type = 'question.answered' AND notice_answer.object_kind = 'question'
      AND notice_answer.object_version = 1
      AND json_extract(CASE WHEN json_valid(notice_answer_content.payload_json)
        THEN notice_answer_content.payload_json ELSE '{}' END, '$.question_id') = notice_question.object_id
      AND json_extract(CASE WHEN json_valid(notice_question_content.payload_json)
        THEN notice_question_content.payload_json ELSE '{}' END, '$.question_id') = notice_question.object_id
      AND json_extract(CASE WHEN json_valid(notice_question_content.payload_json)
        THEN notice_question_content.payload_json ELSE '{}' END, '$.problem_id') = notice_question.problem_id
      AND 1 = (SELECT COUNT(*) FROM events original
        WHERE original.problem_id = notice_question.problem_id AND original.object_kind = 'question'
          AND original.object_id = notice_question.object_id AND original.type = 'question.asked'
          AND original.seq <= notice_problem.public_seq)
      AND NOT EXISTS (SELECT 1 FROM events later
        WHERE later.problem_id = notice_answer.problem_id AND later.object_kind = 'question'
          AND later.object_id = notice_answer.object_id AND later.seq > notice_answer.seq
          AND later.seq <= notice_problem.public_seq
          AND later.type NOT IN ('lease.acquired', 'lease.released', 'lease.challenged'))
      ${
        recipient === undefined
          ? ""
          : `AND notice_question.actor_fellow_id = ${recipient}
        AND notice_question.actor_fellow_id <> notice_answer.actor_fellow_id`
      }
      ${target === undefined ? "" : `AND notice_question.object_id = ${target}`}
      AND NOT ${eventContentHiddenSql("notice_answer")}
      AND NOT ${eventContentHiddenSql("notice_question")}
      AND NOT ${eventContentHiddenSql("notice_reference")}
      AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals withdrawn
        WHERE withdrawn.source_event_id = notice_reference.id)
      AND (notice_reference.object_kind <> 'claim' OR NOT EXISTS (
        SELECT 1 FROM retractions withdrawn JOIN events original_claim
          ON original_claim.problem_id = notice_reference.problem_id
          AND original_claim.object_id = notice_reference.object_id
          AND original_claim.object_kind = 'claim' AND original_claim.type = 'claim.created'
          AND original_claim.object_version = 1
          AND original_claim.actor_fellow_id = withdrawn.author_fellow_id
        WHERE withdrawn.problem_id = notice_reference.problem_id
          AND withdrawn.seq <= notice_problem.public_seq
          AND withdrawn.target_object IN (notice_reference.object_id,
            notice_reference.object_id || '@' || notice_reference.object_version)
      ))
  )`;
}

export const VISIBLE_QUESTION_ANSWER_NOTICE_SQL = `(
  fellow_inbox_notices.notice_type <> 'object_critique'
  OR fellow_inbox_notices.target_id IS NULL
  OR fellow_inbox_notices.target_id NOT LIKE 'Q-%'
  OR ${visibleQuestionAnswerNoticeSql(
    "fellow_inbox_notices.caused_by_event_id",
    "fellow_inbox_notices.fellow_id",
    "fellow_inbox_notices.target_id",
  )}
)`;

/** Hash-check the original question and resolve the answer through the same
 * canonical publication lookup used when admitting answers. Exact bytes are
 * carried to the delivery batch, so a content change during hashing cannot
 * publish a notice from an obsolete preflight. */
export async function questionAnswerWitnesses(
  db: D1Database,
  problemId: string,
  questionId: string,
  answerReference: unknown,
): Promise<readonly ScientificContentIdentity[] | null> {
  if (
    !QuestionIdSchema.safeParse(questionId).success ||
    /[\r\n\u2028\u2029]/u.test(questionId) ||
    typeof answerReference !== "string"
  )
    return null;
  const rows = await db
    .prepare(`SELECT e.id AS event_id, e.payload_sha256, c.payload_json
      FROM events e JOIN event_content c ON c.event_id = e.id
        AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
      WHERE e.problem_id = ? AND e.object_id = ? AND e.object_kind = 'question'
        AND e.type = 'question.asked' AND e.object_version = 1
        AND length(CAST(c.payload_json AS BLOB)) <= 65536
      ORDER BY e.seq LIMIT 2`)
    .bind(problemId, questionId)
    .all<{ event_id: string; payload_sha256: string; payload_json: string }>();
  if (rows.results.length !== 1) return null;
  const row = rows.results[0];
  if (!row) return null;
  try {
    const payload = await checkedScientificPayload(row);
    if (
      payload.question_id !== questionId ||
      payload.problem_id !== problemId ||
      !AskQuestionRequestSchema.safeParse({
        target_refs: payload.target_refs,
        blocking: payload.blocking,
        body_md: payload.body_md,
      }).success
    )
      return null;
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }
  const answer = await findSettlementReference(db, problemId, answerReference, true);
  if (!answer || answer.reference !== answerReference) return null;
  return [
    { eventId: row.event_id, payloadDigest: row.payload_sha256, payloadJson: row.payload_json },
    answer,
  ];
}
