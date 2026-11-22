import { MODERATION_LEDGER_TARGETS } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  checkedScientificPayload,
  type ScientificContentIdentity,
  ScientificInputError,
} from "../ledger/scientific-checks.ts";

const TARGET_CREATION_SQL =
  "CASE request_author.object_kind " +
  MODERATION_LEDGER_TARGETS.map(({ kind, created }) => `WHEN '${kind}' THEN '${created}'`).join(
    " ",
  ) +
  " END";

/** Only code-owned SQL expressions enter this helper. Each reference resolves
 * inside the question's problem and before its publication. A bare reference
 * selects the version current when asked; an exact pin never widens to a newer
 * version. The immutable creation event identifies the author, not today's
 * sponsor or the latest modifier. Duplicate references cannot multiply notices.
 *
 * Current controls and withdrawals still apply to that historical publication.
 * An answered/withdrawn question no longer asks anyone to perform work. */
function questionRequestSourcesSql(
  eventId: string,
  recipient?: string,
  target?: string,
  problem?: string,
  sourceEventId?: string,
): string {
  const payload =
    "CASE WHEN json_valid(request_content.payload_json) THEN request_content.payload_json ELSE '{}' END";
  const referenceId =
    "CASE WHEN instr(request_ref.value, '@') > 0 THEN substr(request_ref.value, 1, instr(request_ref.value, '@') - 1) ELSE request_ref.value END";
  return `FROM events request_question
    JOIN problems request_problem ON request_problem.id = request_question.problem_id
      AND request_problem.status <> 'private-draft' AND request_question.seq <= request_problem.public_seq
    JOIN event_content request_content ON request_content.event_id = request_question.id
      AND request_content.payload_sha256 = request_question.payload_sha256
      AND request_content.redacted_at IS NULL AND json_valid(request_content.payload_json)
    JOIN json_each(CASE WHEN json_type(${payload}, '$.target_refs') = 'array'
      AND json_array_length(${payload}, '$.target_refs') <= 32
      THEN json_insert(json_extract(${payload}, '$.target_refs'), '$[#]', json_extract(${payload}, '$.blocking'))
      ELSE '[]' END) request_ref ON request_ref.type = 'text'
    JOIN events request_source ON request_source.problem_id = request_question.problem_id
      AND request_source.object_id = ${referenceId} AND request_source.seq < request_question.seq
      AND (request_ref.value = request_source.object_id || '@' || request_source.object_version
        OR (request_ref.value = request_source.object_id AND request_source.object_version = (
          SELECT MAX(previous.object_version) FROM events previous
          WHERE previous.problem_id = request_source.problem_id AND previous.object_id = request_source.object_id
            AND previous.object_kind = request_source.object_kind AND previous.seq < request_question.seq
            AND previous.type IN (
              request_source.type,
              CASE request_source.object_kind WHEN 'claim' THEN 'claim.created'
                WHEN 'citation' THEN 'citation.recorded' ELSE request_source.type END,
              CASE request_source.object_kind WHEN 'claim' THEN 'claim.revised'
                WHEN 'citation' THEN 'citation.revised' ELSE request_source.type END)
        )))
    JOIN events request_author ON request_author.problem_id = request_source.problem_id
      AND request_author.object_id = request_source.object_id AND request_author.object_kind = request_source.object_kind
      AND request_author.object_version = 1 AND request_author.seq <= request_source.seq
      AND request_author.type = ${TARGET_CREATION_SQL}
    JOIN event_content request_source_content ON request_source_content.event_id = request_source.id
      AND request_source_content.payload_sha256 = request_source.payload_sha256
      AND request_source_content.redacted_at IS NULL
    WHERE request_question.id = ${eventId}
      AND request_question.type = 'question.asked' AND request_question.object_kind = 'question'
      AND request_question.object_version = 1
      AND request_question.actor_fellow_id IS NOT NULL
      AND request_author.actor_fellow_id IS NOT NULL
      AND request_author.actor_fellow_id <> request_question.actor_fellow_id
      AND json_extract(${payload}, '$.question_id') = request_question.object_id
      AND json_extract(${payload}, '$.problem_id') = request_question.problem_id
      AND (request_source.type = request_author.type
        OR (request_source.object_kind = 'claim' AND request_source.type = 'claim.revised')
        OR (request_source.object_kind = 'citation' AND request_source.type = 'citation.revised'))
      AND 1 = (SELECT COUNT(*) FROM events same_author
        WHERE same_author.problem_id = request_author.problem_id AND same_author.object_id = request_author.object_id
          AND same_author.object_kind = request_author.object_kind AND same_author.type = request_author.type
          AND same_author.object_version = 1 AND same_author.seq < request_question.seq)
      AND 1 = (SELECT COUNT(*) FROM events same_source
        WHERE same_source.problem_id = request_source.problem_id AND same_source.object_id = request_source.object_id
          AND same_source.object_kind = request_source.object_kind AND same_source.object_version = request_source.object_version
          AND same_source.type IN (request_author.type, CASE request_source.object_kind
            WHEN 'claim' THEN 'claim.revised' WHEN 'citation' THEN 'citation.revised' ELSE request_author.type END)
          AND same_source.seq < request_question.seq)
      AND NOT EXISTS (SELECT 1 FROM events later
        WHERE later.problem_id = request_question.problem_id AND later.object_id = request_question.object_id
          AND later.object_kind = 'question' AND later.seq > request_question.seq
          AND later.seq <= request_problem.public_seq AND later.type IN ('question.answered', 'question.withdrawn'))
      ${recipient === undefined ? "" : `AND request_author.actor_fellow_id = ${recipient}`}
      ${target === undefined ? "" : `AND request_question.object_id = ${target}`}
      ${problem === undefined ? "" : `AND request_question.problem_id = ${problem}`}
      ${sourceEventId === undefined ? "" : `AND request_source.id = ${sourceEventId}`}
      AND NOT ${eventContentHiddenSql("request_question")}
      AND NOT ${eventContentHiddenSql("request_source")}
      AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals retired JOIN events retirement
        ON retirement.id = retired.event_id AND retirement.problem_id = retired.problem_id
          AND retirement.seq = retired.seq AND retirement.payload_sha256 = retired.event_sha256
          AND retirement.type = 'object.retracted' AND retirement.object_kind = 'retraction'
          AND retirement.object_id = retired.retraction_id
          AND retirement.actor_fellow_id = request_source.actor_fellow_id
        WHERE retired.problem_id = request_source.problem_id AND retired.source_event_id = request_source.id
          AND retired.source_sha256 = request_source.payload_sha256
          AND retired.target_kind = request_source.object_kind AND retired.target_object = request_source.object_id
          AND retired.seq > request_source.seq AND retired.seq <= request_problem.public_seq)
      AND NOT EXISTS (SELECT 1 FROM retractions retired JOIN events retirement
        ON retirement.problem_id = retired.problem_id AND retirement.seq = retired.seq
          AND retirement.type = 'object.retracted' AND retirement.object_kind = 'retraction'
          AND retirement.actor_fellow_id = request_author.actor_fellow_id
        WHERE retired.problem_id = request_source.problem_id AND retired.seq <= request_problem.public_seq
          AND retired.seq > request_source.seq
          AND retired.author_fellow_id = request_author.actor_fellow_id
          AND retired.target_object IN (request_source.object_id,
            request_source.object_id || '@' || request_source.object_version))`;
}

export function visibleQuestionRequestNoticeSql(
  eventId: string,
  recipient?: string,
  target?: string,
  problem?: string,
  sourceEventId?: string,
): string {
  return `EXISTS (SELECT 1 ${questionRequestSourcesSql(eventId, recipient, target, problem, sourceEventId)})`;
}

/** The same current publication/author checks as the read predicate, projected
 * to small immutable identities. Delivery materializes this relation once per
 * statement so its source, recipient and byte-witness guards do not nest the
 * full eligibility expression beyond D1's expression-depth limit. */
export function questionRequestSourceIdentitiesSql(eventId: string): string {
  return `SELECT DISTINCT request_question.id AS question_event_id,
    request_author.actor_fellow_id AS fellow_id, request_source.id AS source_event_id
    ${questionRequestSourcesSql(eventId)}`;
}

export interface QuestionRequestRecipient {
  readonly fellowId: string;
  readonly source: ScientificContentIdentity;
}

/** At most 32 target_refs and one blocking reference. Verify the exact public
 * bytes before composing a notice; carry their witnesses into the common
 * delivery transaction so hashing cannot race content replacement. */
export async function questionRequestRecipients(
  db: D1Database,
  eventId: string,
): Promise<readonly QuestionRequestRecipient[]> {
  const sources = await db
    .prepare(`SELECT DISTINCT request_author.actor_fellow_id AS fellow_id,
      request_source.id AS event_id, request_source.payload_sha256, request_source_content.payload_json
      ${questionRequestSourcesSql("?")}
      AND length(CAST(request_source_content.payload_json AS BLOB)) <= 524288
      ORDER BY request_author.actor_fellow_id, request_source.seq LIMIT 34`)
    .bind(eventId)
    .all<{
      fellow_id: string;
      event_id: string;
      payload_sha256: string;
      payload_json: string;
    }>();
  if (!sources.success || sources.results.length > 33)
    throw new Error("QUESTION_REQUEST_TARGETS_UNAVAILABLE");
  const recipients: QuestionRequestRecipient[] = [];
  for (const source of sources.results) {
    try {
      await checkedScientificPayload(source);
      recipients.push({
        fellowId: source.fellow_id,
        source: {
          eventId: source.event_id,
          payloadDigest: source.payload_sha256,
          payloadJson: source.payload_json,
        },
      });
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      // An unreadable target cannot establish a delivery recipient. Other
      // independently verified references in the question remain useful.
    }
  }
  return recipients;
}
