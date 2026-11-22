import {
  AnswerQuestionRequestSchema,
  AskQuestionRequestSchema,
  LeaseQuestionRequestSchema,
  type QuestionStatus,
  WithdrawQuestionRequestSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import {
  checkedScientificPayload,
  type ScientificContentIdentity,
  ScientificInputError,
} from "../ledger/scientific-checks.ts";

export interface QuestionLeaseSource {
  readonly questionId: string;
  readonly canonicalRef: string;
  readonly status: QuestionStatus;
  readonly latestEventId: string;
  readonly sources: readonly ScientificContentIdentity[];
}

/** A retained question projection cannot authorize a reservation. Resolve the
 * exact creation and latest lifecycle publication, under current controls,
 * before either lease endpoint screens or writes. Generic lease.* events are
 * live coordination and do not replace the question's scientific lifecycle. */
export async function findQuestionLeaseSource(
  db: D1Database,
  problemId: string,
  questionId: string,
): Promise<QuestionLeaseSource | null> {
  const row = await db
    .prepare(`SELECT q.seq, q.status, e.id AS event_id, e.payload_sha256,
      c.payload_json, h.id AS latest_event_id, h.type AS latest_type,
      h.actor_fellow_id AS latest_fellow_id, h.payload_sha256 AS latest_digest,
      hc.payload_json AS latest_payload
    FROM questions q JOIN problems p ON p.id = q.problem_id
    JOIN events e ON e.problem_id = q.problem_id AND e.seq = q.seq
      AND e.object_id = q.question_id AND e.object_kind = 'question' AND e.type = 'question.asked'
    JOIN events h ON h.problem_id = q.problem_id AND h.seq = (
      SELECT MAX(latest.seq) FROM events latest
      WHERE latest.problem_id = q.problem_id AND latest.object_id = q.question_id
        AND latest.object_kind = 'question' AND latest.seq <= p.public_seq
        AND latest.type NOT IN ('lease.acquired', 'lease.released', 'lease.challenged'))
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL
    JOIN event_content hc ON hc.event_id = h.id AND hc.payload_sha256 = h.payload_sha256
      AND hc.redacted_at IS NULL
    WHERE q.problem_id = ? AND q.question_id = ? AND p.status <> 'private-draft'
      AND e.seq <= p.public_seq
      AND NOT ${hiddenByContentControlSql("p.id", "p.id")}
      AND NOT ${eventContentHiddenSql("e")} AND NOT ${eventContentHiddenSql("h")}
      AND length(CAST(c.payload_json AS BLOB)) <= 65536
      AND length(CAST(hc.payload_json AS BLOB)) <= 65536
      AND (SELECT COUNT(*) FROM events creation WHERE creation.problem_id = q.problem_id
        AND creation.object_id = q.question_id AND creation.object_kind = 'question'
        AND creation.type = 'question.asked' AND creation.seq <= p.public_seq) = 1`)
    .bind(problemId, questionId)
    .first<{
      seq: number;
      status: string;
      event_id: string;
      payload_sha256: string;
      payload_json: string;
      latest_event_id: string;
      latest_type: string;
      latest_fellow_id: string | null;
      latest_digest: string;
      latest_payload: string;
    }>();
  if (row === null || !Number.isSafeInteger(row.seq) || row.seq < 1) return null;
  try {
    const original = await checkedScientificPayload(row);
    const latest = await checkedScientificPayload({
      payload_sha256: row.latest_digest,
      payload_json: row.latest_payload,
    });
    if (
      original.question_id !== questionId ||
      original.problem_id !== problemId ||
      latest.question_id !== questionId ||
      !AskQuestionRequestSchema.safeParse({
        body_md: original.body_md,
        target_refs: original.target_refs,
        blocking: original.blocking,
      }).success
    )
      return null;
    let status: QuestionStatus;
    if (row.latest_type === "question.asked" && row.latest_event_id === row.event_id)
      status = "open";
    else if (
      row.latest_type === "question.leased" &&
      latest.leased_by === row.latest_fellow_id &&
      typeof latest.leased_until === "string" &&
      Number.isFinite(Date.parse(latest.leased_until)) &&
      LeaseQuestionRequestSchema.safeParse({
        objective: latest.objective,
        deliverable: latest.deliverable,
      }).success
    )
      status = "leased";
    else if (
      row.latest_type === "question.answered" &&
      AnswerQuestionRequestSchema.safeParse({ resolved_by_object: latest.resolved_by_object })
        .success
    )
      status = "resolved";
    else if (
      row.latest_type === "question.withdrawn" &&
      WithdrawQuestionRequestSchema.safeParse({ reason: latest.reason }).success
    )
      status = "withdrawn";
    else return null;
    if (row.status !== status) return null;
    return {
      questionId,
      canonicalRef: `Q-${row.seq}`,
      status,
      latestEventId: row.latest_event_id,
      sources: [
        {
          eventId: row.event_id,
          payloadDigest: row.payload_sha256,
          payloadJson: row.payload_json,
          problemId,
        },
        {
          eventId: row.latest_event_id,
          payloadDigest: row.latest_digest,
          payloadJson: row.latest_payload,
          problemId,
        },
      ],
    };
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }
}

/** Rechecked before the new event, inside its transaction. The source-byte
 * guards separately recheck visibility, digests and payloads in that batch. */
export const QUESTION_LEASE_STATE_SQL = ` AND EXISTS (
  SELECT 1 FROM questions q JOIN problems p ON p.id = q.problem_id
  JOIN events head ON head.id = ?
    AND head.problem_id = q.problem_id AND head.object_id = q.question_id
    AND head.object_kind = 'question'
  WHERE q.problem_id = ? AND q.question_id = ? AND q.status IN ('open', 'leased')
    AND p.status <> 'private-draft' AND head.seq <= p.public_seq
    AND NOT ${hiddenByContentControlSql("p.id", "p.id")}
    AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.problem_id = q.problem_id
      AND newer.object_id = q.question_id AND newer.object_kind = 'question'
      AND newer.seq > head.seq
      AND newer.type NOT IN ('lease.acquired', 'lease.released', 'lease.challenged')))`;
