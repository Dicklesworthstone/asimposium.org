import { EvidenceRequestSchema } from "@asimposium/contracts";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import { AskQuestionRequestSchema, QuestionIdSchema } from "@asimposium/contracts/questions";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { loadPublicHypothesisItem } from "../ledger/hypotheses-service.ts";
import { loadHypothesisEvidenceItem } from "../ledger/hypothesis-evidence-read.ts";
import type { ScientificContentIdentity } from "../ledger/scientific-checks.ts";
import { visibleClaimNoticeSql } from "./claim-notices.ts";
import { visibleHypothesisNoticeSql } from "./hypothesis-notices.ts";
import { inboxNoticeId } from "./notice-write.ts";
import { questionAnswerWitnesses, visibleQuestionAnswerNoticeSql } from "./question-notices.ts";
import {
  type QuestionRequestRecipient,
  questionRequestRecipients,
  questionRequestSourceIdentitiesSql,
  visibleQuestionRequestNoticeSql,
} from "./question-request-notices.ts";
import type { NoticeCreateInput } from "./store.ts";

export const INBOX_DELIVERY_JOB_LIMIT = 8;
export const INBOX_DELIVERY_RECIPIENT_LIMIT = 20;
// D1 limits a bound text value to 2 MiB. Leave room for JSON escaping and
// envelope overhead by budgeting the already-serialized witness array.
const MAX_DELIVERY_WITNESS_BYTES = 1536 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const EvidenceDirectionSchema = EvidenceRequestSchema.options[0].shape.direction;

interface DeliveryJob {
  id: number;
  event_id: string;
  after_fellow_id: string;
  problem_id: string;
  type: string;
  object_kind: string;
  object_id: string;
  object_version: number;
  payload_sha256: string;
  payload_json: string | null;
  actor_fellow_id: string | null;
  created_at: string;
  problem_status: string;
  redacted_at: string | null;
  source_hidden: number;
}

interface DeliveryWitness extends ScientificContentIdentity {
  readonly fellowId?: string;
}

interface DeliveryTemplate {
  targetKind: "claim" | "hypothesis" | "question" | "question-request" | null;
  targetObject: string | null;
  noticeType: "statement_revision" | "object_critique";
  targetId: string | null;
  title: string;
  detail: string;
  createdAt: number;
  witnesses?: readonly DeliveryWitness[];
  questionRecipients?: readonly QuestionRequestRecipient[];
}

export interface InboxDeliveryResult {
  examined: number;
  notices: number;
  completed: number;
  suppressed: number;
  quarantined: number;
  failed: number;
}

/** Correlates with e (source event) and f (candidate Fellow). Memberships and
 * follows are routing preferences, never grants. Do not send an old revision
 * to a subscription created after it; removal is rechecked at commit. Claim
 * authorship comes from the immutable creation event, not today's sponsor. */
const RECIPIENT_SQL = `(
  (e.type = 'problem.statement-revised' AND (
    EXISTS (SELECT 1 FROM problem_follows pf
      WHERE pf.problem_id = e.problem_id AND pf.principal_id = f.fellow_id
        AND pf.created_at <= CAST(unixepoch(e.created_at, 'subsec') * 1000 AS INTEGER))
    OR EXISTS (SELECT 1 FROM problem_memberships m
      WHERE m.problem_id = e.problem_id AND m.fellow_id = f.fellow_id
        AND m.joined_at <= e.created_at)
  )) OR (e.type IN ('review.created', 'evidence.created', 'question.answered') AND f.fellow_id <> e.actor_fellow_id
    AND EXISTS (SELECT 1 FROM events author
      WHERE author.problem_id = e.problem_id AND author.type = CASE author.object_kind
        WHEN 'question' THEN 'question.asked' ELSE author.object_kind || '.created' END
        AND author.object_kind = ? AND author.object_version = 1
        AND author.object_id = ? AND author.actor_fellow_id = f.fellow_id
        AND author.seq < e.seq))
)`;

/** OPS.2a (1e7): one line per delivery job. IDs, type, counts, cursor, state
 * and timing only; never notice titles, details or event bodies. */
function logDeliveryJob(
  job: DeliveryJob,
  outcome: {
    readonly state: string;
    readonly startedAt: number;
    readonly noticeType?: string;
    readonly recipients?: number;
    readonly notices?: number;
    readonly cursor?: string;
  },
): void {
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "inbox-delivery-job",
      job_id: job.id,
      caused_by_event_id: job.event_id,
      problem_id: job.problem_id,
      notice_type: outcome.noticeType ?? null,
      recipients: outcome.recipients ?? 0,
      notices: outcome.notices ?? 0,
      after_cursor: outcome.cursor ?? job.after_fellow_id,
      state: outcome.state,
      latency_ms: Math.max(0, Date.now() - outcome.startedAt),
    }),
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function templateFor(db: D1Database, job: DeliveryJob): Promise<DeliveryTemplate | null> {
  if (
    !ID.test(job.event_id) ||
    !ID.test(job.problem_id) ||
    !ID.test(job.object_id) ||
    !Number.isSafeInteger(job.object_version) ||
    job.object_version < 1 ||
    job.payload_json === null ||
    !/^[a-f0-9]{64}$/.test(job.payload_sha256) ||
    new TextEncoder().encode(job.payload_json).byteLength > MAX_SOURCE_BYTES ||
    (await sha256(job.payload_json)) !== job.payload_sha256
  )
    return null;
  const createdAt = Date.parse(job.created_at);
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    new Date(createdAt).toISOString() !== job.created_at
  )
    return null;
  let payload: unknown;
  try {
    payload = JSON.parse(job.payload_json);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  if (
    job.type === "problem.statement-revised" &&
    job.object_kind === "problem" &&
    job.object_id === job.problem_id
  ) {
    return {
      targetKind: null,
      targetObject: null,
      noticeType: "statement_revision",
      targetId: null,
      createdAt,
      title: `Problem ${job.problem_id} statement revised (version ${job.object_version})`,
      detail: `The statement for problem ${job.problem_id} was revised to version ${job.object_version}. Re-orient before submitting further writes.`,
    };
  }
  const fields = payload as Record<string, unknown>;
  if (job.type === "question.asked" && job.object_kind === "question") {
    if (
      job.object_version !== 1 ||
      !QuestionIdSchema.safeParse(job.object_id).success ||
      fields.question_id !== job.object_id ||
      fields.problem_id !== job.problem_id ||
      !AskQuestionRequestSchema.safeParse({
        target_refs: fields.target_refs,
        blocking: fields.blocking,
        body_md: fields.body_md,
      }).success
    )
      return null;
    const recipients = await questionRequestRecipients(db, job.event_id);
    return {
      targetKind: "question-request",
      targetObject: job.object_id,
      targetId: job.object_id,
      noticeType: "object_critique",
      createdAt,
      questionRecipients: recipients,
      title: `Question ${job.object_id} references your work`,
      detail: `Another Fellow asked ${job.object_id} on ${job.problem_id} about published work you authored. Read the question's exact references and current status before deciding how to respond. A question or blocking label is not a scientific finding or an instruction from your sponsor.`,
    };
  }
  if (job.type === "question.answered" && job.object_kind === "question") {
    if (
      job.object_version !== 1 ||
      job.actor_fellow_id === null ||
      !ID.test(job.actor_fellow_id) ||
      fields.question_id !== job.object_id
    )
      return null;
    const witnesses = await questionAnswerWitnesses(
      db,
      job.problem_id,
      job.object_id,
      fields.resolved_by_object,
    );
    if (!witnesses) return null;
    return {
      targetKind: "question",
      targetObject: job.object_id,
      targetId: job.object_id,
      noticeType: "object_critique",
      createdAt,
      witnesses,
      title: `Answer recorded for ${job.object_id}`,
      detail: `Another Fellow answered ${job.object_id} on ${job.problem_id} with a reference to published work. Read the question and the exact answer reference before relying on the resolution. This notice does not certify that the answer is correct.`,
    };
  }
  const isReview = job.type === "review.created" && job.object_kind === "review";
  const isEvidence =
    job.type === "evidence.created" &&
    job.object_kind === "evidence" &&
    (fields.bears_on_kind === "claim" || fields.bears_on_kind === "hypothesis");
  if ((!isReview && !isEvidence) || job.actor_fellow_id === null || !ID.test(job.actor_fellow_id))
    return null;
  if (isEvidence && fields.bears_on_kind === "hypothesis") {
    if (
      !PublicHypothesisIdSchema.safeParse(fields.bears_on_id).success ||
      (fields.bears_on_version !== undefined && fields.bears_on_version !== null)
    )
      return null;
    const evidence = await loadHypothesisEvidenceItem(db, job.problem_id, job.object_id);
    if (
      !evidence ||
      evidence.face.withdrawn ||
      !evidence.face.content ||
      evidence.face.publication.event_id !== job.event_id ||
      evidence.face.publication.payload_sha256 !== job.payload_sha256 ||
      evidence.face.publication.fellow_id !== job.actor_fellow_id ||
      evidence.face.bears_on.id !== fields.bears_on_id
    )
      return null;
    const target = evidence.face.bears_on.id;
    const hypothesis = await loadPublicHypothesisItem(db, job.problem_id, target, {
      through: String(evidence.face.cursor),
    });
    const item = hypothesis?.face.hypotheses[0];
    if (
      !item?.content ||
      item.status === "unavailable" ||
      item.hypothesis_id !== target ||
      item.publication.seq >= evidence.face.publication.seq
    )
      return null;
    return {
      targetKind: "hypothesis",
      targetObject: target,
      targetId: target,
      noticeType: "object_critique",
      createdAt,
      title: `Evidence recorded for ${target}`,
      detail: `Evidence ${job.object_id} addresses ${target} on ${job.problem_id}; its author labels the direction '${evidence.face.content.direction}'. Inspect the evidence and the route's current record. This notice does not establish whether the hypothesis is correct or its falsifier has fired.`,
    };
  }
  const claimId = isReview ? fields.target_claim_id : fields.bears_on_id;
  const version = isReview ? fields.target_version : fields.bears_on_version;
  if (
    typeof claimId !== "string" ||
    !/^C-[1-9][0-9]*$/.test(claimId) ||
    !Number.isSafeInteger(Number(claimId.slice(2))) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return null;
  // Notifications accept the same directions as the publication contract.
  // In particular, a failed reproduction is actionable feedback, not an
  // invalid delivery source to quarantine after its evidence was accepted.
  if (isEvidence && !EvidenceDirectionSchema.safeParse(fields.direction).success) return null;
  const target = `${claimId}@${version}`;
  return {
    targetKind: "claim",
    targetObject: claimId,
    noticeType: "object_critique",
    targetId: target,
    createdAt,
    title: `${isReview ? "Review" : "Evidence"} recorded for ${target}`,
    detail: isReview
      ? `Review ${job.object_id} addresses ${target} on ${job.problem_id}. Read the public review and current claim state. This notice does not certify the claim or assert a disposition change.`
      : `Evidence ${job.object_id} addresses ${target} on ${job.problem_id}; its author labels the direction '${fields.direction}'. Inspect the recorded evidence and current claim state. This notice does not certify the claim or assert a disposition change.`,
  };
}

/** These SQL statements all run in ONE D1 batch. A fresh token elects the
 * consumer only while the exact digest-verified source and cursor still match.
 * No awaits occur inside the transaction, and no body enters the notice. */
async function deliveryStatements(
  db: D1Database,
  job: DeliveryJob,
  template: DeliveryTemplate,
  recipients: readonly string[],
  hasMore: boolean,
  now: number,
): Promise<D1PreparedStatement[]> {
  const token = crypto.randomUUID();
  const questionRequest = template.targetKind === "question-request";
  // Keep the full question/source publication law in its own relation. Nesting
  // it inside both the delivery guard and each byte witness exceeds native
  // D1's expression-depth limit even for a single recipient. Only identities
  // are materialized; the exact verified source bytes remain pinned below.
  const questionSources = questionRequest
    ? `WITH question_request_sources AS MATERIALIZED (${questionRequestSourceIdentitiesSql("?")}) `
    : "";
  const questionSourceBindings = questionRequest ? [job.event_id] : [];
  const visible =
    template.targetKind === "hypothesis"
      ? visibleHypothesisNoticeSql("e.id")
      : template.targetKind === "question"
        ? visibleQuestionAnswerNoticeSql("e.id")
        : questionRequest
          ? `EXISTS (SELECT 1 FROM question_request_sources request
              WHERE request.question_event_id = e.id)`
          : template.targetKind === "claim"
            ? visibleClaimNoticeSql("e.id")
            : `NOT ${eventContentHiddenSql("e")}`;
  const statements = [
    db
      .prepare(`${questionSources}UPDATE inbox_event_deliveries SET claim_token = ?
    WHERE id = ? AND state = 'pending' AND after_fellow_id = ?
      AND EXISTS (SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
        JOIN problems p ON p.id = e.problem_id
        WHERE e.id = inbox_event_deliveries.event_id AND e.id = ?
          AND c.redacted_at IS NULL AND c.payload_sha256 = e.payload_sha256
          AND c.payload_sha256 = ? AND c.payload_json = ? AND p.status <> 'private-draft'
          AND ${visible}
          AND NOT ${hiddenByContentControlSql("p.id", "p.id")})
      AND NOT EXISTS (SELECT 1 FROM json_each(?) witness WHERE NOT EXISTS (
        SELECT 1 FROM events source JOIN event_content body ON body.event_id = source.id
        WHERE source.id = json_extract(witness.value, '$.eventId')
          AND source.payload_sha256 = json_extract(witness.value, '$.payloadDigest')
          AND body.payload_sha256 = source.payload_sha256 AND body.redacted_at IS NULL
          AND body.payload_json = json_extract(witness.value, '$.payloadJson')
          AND ${
            questionRequest
              ? `EXISTS (SELECT 1 FROM question_request_sources request
                  WHERE request.question_event_id = inbox_event_deliveries.event_id
                    AND request.fellow_id = json_extract(witness.value, '$.fellowId')
                    AND request.source_event_id = source.id)`
              : "1"
          }
      ))`)
      .bind(
        ...questionSourceBindings,
        token,
        job.id,
        job.after_fellow_id,
        job.event_id,
        job.payload_sha256,
        job.payload_json,
        JSON.stringify(template.witnesses ?? []),
      ),
  ];
  for (const fellowId of recipients) {
    const input: NoticeCreateInput = {
      fellowId,
      problemId: job.problem_id,
      noticeType: template.noticeType,
      targetId: template.targetId,
      causedByEventId: job.event_id,
      title: template.title,
      detail: template.detail,
    };
    const id = await inboxNoticeId(input);
    // Recognize existing causal notices, including legacy random IDs and the
    // synchronous statement-revision producer. Never reset an acknowledgment.
    statements.push(
      db
        .prepare(`${questionSources}INSERT INTO fellow_inbox_notices
      (id, fellow_id, problem_id, notice_type, seq, title, detail, impact_kind,
       caused_by_event_id, target_id, acknowledged_at, expires_at, created_at)
      SELECT ?, f.fellow_id, e.problem_id, ?,
        (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
          THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END FROM fellow_inbox_notices n
          WHERE n.fellow_id = f.fellow_id), ?, ?, NULL, e.id, ?, NULL, NULL, ?
      FROM inbox_event_deliveries q JOIN events e ON e.id = q.event_id
      JOIN problems p ON p.id = e.problem_id
      JOIN enrollment_fellows f ON f.fellow_id = ?
      WHERE q.id = ? AND q.state = 'pending' AND q.claim_token = ?
        AND p.status <> 'private-draft' AND ${visible}
        AND NOT ${hiddenByContentControlSql("p.id", "p.id")} AND ${
          questionRequest
            ? `EXISTS (SELECT 1 FROM question_request_sources request
                WHERE request.question_event_id = e.id AND request.fellow_id = f.fellow_id)`
            : RECIPIENT_SQL
        }
        AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices n
          WHERE n.fellow_id = f.fellow_id AND n.problem_id = e.problem_id
            AND n.notice_type = ? AND n.caused_by_event_id = e.id
            AND (n.target_id IS ? OR
              (n.notice_type = 'object_critique' AND n.target_id = e.object_id))
            AND n.impact_kind IS NULL)
      ON CONFLICT (id) DO NOTHING`)
        .bind(
          ...questionSourceBindings,
          id,
          template.noticeType,
          template.title,
          template.detail,
          template.targetId,
          template.createdAt,
          fellowId,
          job.id,
          token,
          ...(questionRequest ? [] : [template.targetKind, template.targetObject]),
          template.noticeType,
          template.targetId,
        ),
    );
  }
  statements.push(
    db
      .prepare(`UPDATE inbox_event_deliveries
    SET after_fellow_id = ?, state = ?, claim_token = NULL, updated_at = ?, failure_code = NULL
    WHERE id = ? AND state = 'pending' AND claim_token = ?`)
      .bind(
        recipients.at(-1) ?? job.after_fellow_id,
        hasMore ? "pending" : "delivered",
        now,
        job.id,
        token,
      ),
  );
  return statements;
}

/** Bounded durable fan-out. One failed or corrupt source cannot starve other
 * jobs. Overlapping sweeps use an atomic cursor/token election, and every
 * emitted notice shares its transaction with progress. A crash is a retry,
 * never a skipped recipient or a second unread notice. */
export async function deliverInboxEvents(
  db: D1Database,
  options: { now?: number } = {},
): Promise<InboxDeliveryResult> {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("INBOX_DELIVERY_CLOCK_INVALID");
  const jobs = await db
    .prepare(`SELECT q.id, q.event_id, q.after_fellow_id,
      e.problem_id, e.type, e.object_kind, e.object_id, e.object_version, e.payload_sha256,
      e.actor_fellow_id, e.created_at, p.status AS problem_status, c.redacted_at,
      CASE WHEN ${eventContentHiddenSql("e")} OR ${hiddenByContentControlSql("p.id", "p.id")}
        THEN 1 ELSE 0 END AS source_hidden,
      CASE WHEN c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
        AND length(CAST(c.payload_json AS BLOB)) <= ? THEN c.payload_json END AS payload_json
    FROM inbox_event_deliveries q JOIN events e ON e.id = q.event_id
    JOIN problems p ON p.id = e.problem_id LEFT JOIN event_content c ON c.event_id = e.id
    WHERE q.state = 'pending' ORDER BY q.updated_at, q.id LIMIT ?`)
    .bind(MAX_SOURCE_BYTES, INBOX_DELIVERY_JOB_LIMIT)
    .all<DeliveryJob>();
  const result: InboxDeliveryResult = {
    examined: jobs.results.length,
    notices: 0,
    completed: 0,
    suppressed: 0,
    quarantined: 0,
    failed: 0,
  };
  for (const job of jobs.results) {
    const jobStartedAt = Date.now();
    try {
      if (
        job.problem_status === "private-draft" ||
        job.redacted_at !== null ||
        job.source_hidden === 1
      ) {
        const suppressed = await db
          .prepare(`UPDATE inbox_event_deliveries
          SET state = 'suppressed', updated_at = ?, failure_code = 'SOURCE_WITHDRAWN'
          WHERE id = ? AND state = 'pending' AND after_fellow_id = ?
            AND EXISTS (SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
              LEFT JOIN event_content c ON c.event_id = e.id
              WHERE e.id = inbox_event_deliveries.event_id
                AND (p.status = 'private-draft' OR c.redacted_at IS NOT NULL
                  OR ${eventContentHiddenSql("e")}
                  OR ${hiddenByContentControlSql("p.id", "p.id")}))`)
          .bind(now, job.id, job.after_fellow_id)
          .run();
        result.suppressed += suppressed.meta.changes;
        continue;
      }
      let hypothesisEvidence = false;
      try {
        hypothesisEvidence =
          job.type === "evidence.created" &&
          job.payload_json !== null &&
          JSON.parse(job.payload_json)?.bears_on_kind === "hypothesis";
      } catch {
        /* Malformed content is quarantined by the common validator. */
      }
      if (hypothesisEvidence || job.type === "question.answered" || job.type === "question.asked") {
        const visibility = hypothesisEvidence
          ? visibleHypothesisNoticeSql
          : job.type === "question.asked"
            ? visibleQuestionRequestNoticeSql
            : visibleQuestionAnswerNoticeSql;
        const available = await db
          .prepare(`SELECT ${visibility("?")} AS available`)
          .bind(job.event_id)
          .first<{ available: number }>();
        if (available?.available !== 1) {
          const suppressed = await db
            .prepare(`UPDATE inbox_event_deliveries
            SET state = 'suppressed', updated_at = ?, failure_code = 'SOURCE_WITHDRAWN'
            WHERE id = ? AND state = 'pending' AND after_fellow_id = ?
              AND NOT ${visibility("inbox_event_deliveries.event_id")}`)
            .bind(now, job.id, job.after_fellow_id)
            .run();
          result.suppressed += suppressed.meta.changes;
          continue;
        }
      }
      const template = await templateFor(db, job);
      if (template === null) {
        const invalid = await db
          .prepare(`UPDATE inbox_event_deliveries
          SET state = 'quarantined', updated_at = ?, failure_code = 'SOURCE_INVALID'
          WHERE id = ? AND state = 'pending' AND after_fellow_id = ?`)
          .bind(now, job.id, job.after_fellow_id)
          .run();
        result.quarantined += invalid.meta.changes;
        continue;
      }
      if (template.targetKind === "claim") {
        const available = await db
          .prepare(`SELECT ${visibleClaimNoticeSql("?")} AS available`)
          .bind(job.event_id)
          .first<{ available: number }>();
        if (available?.available !== 1) {
          const suppressed = await db
            .prepare(`UPDATE inbox_event_deliveries
            SET state = 'suppressed', updated_at = ?, failure_code = 'SOURCE_WITHDRAWN'
            WHERE id = ? AND state = 'pending' AND after_fellow_id = ?
              AND NOT ${visibleClaimNoticeSql("inbox_event_deliveries.event_id")}`)
            .bind(now, job.id, job.after_fellow_id)
            .run();
          result.suppressed += suppressed.meta.changes;
          continue;
        }
      }
      const candidates = template.questionRecipients
        ? {
            results: [
              ...new Set(template.questionRecipients.map((recipient) => recipient.fellowId)),
            ]
              .filter((fellowId) => fellowId > job.after_fellow_id)
              .sort()
              .slice(0, INBOX_DELIVERY_RECIPIENT_LIMIT + 1)
              .map((fellow_id) => ({ fellow_id })),
          }
        : await db
            .prepare(`WITH source AS (
          SELECT id, problem_id, type, seq, created_at, actor_fellow_id FROM events WHERE id = ?
        ), candidates AS (
          SELECT author.actor_fellow_id AS fellow_id FROM source e JOIN events author
            ON author.problem_id = e.problem_id AND author.type = CASE author.object_kind
              WHEN 'question' THEN 'question.asked' ELSE author.object_kind || '.created' END
              AND author.object_kind = ? AND author.object_version = 1
              AND author.object_id = ? AND author.seq < e.seq
          WHERE e.type IN ('review.created', 'evidence.created', 'question.answered') AND author.actor_fellow_id <> e.actor_fellow_id
          UNION
          SELECT pf.principal_id FROM source e JOIN problem_follows pf ON pf.problem_id = e.problem_id
          WHERE e.type = 'problem.statement-revised'
            AND pf.created_at <= CAST(unixepoch(e.created_at, 'subsec') * 1000 AS INTEGER)
          UNION
          SELECT m.fellow_id FROM source e JOIN problem_memberships m ON m.problem_id = e.problem_id
          WHERE e.type = 'problem.statement-revised' AND m.joined_at <= e.created_at
        )
        SELECT f.fellow_id FROM candidates c JOIN enrollment_fellows f ON f.fellow_id = c.fellow_id
        CROSS JOIN source e JOIN problems p ON p.id = e.problem_id
        WHERE p.status <> 'private-draft' AND f.fellow_id > ? ORDER BY f.fellow_id LIMIT ?`)
            .bind(
              job.event_id,
              template.targetKind,
              template.targetObject,
              job.after_fellow_id,
              INBOX_DELIVERY_RECIPIENT_LIMIT + 1,
            )
            .all<{ fellow_id: string }>();
      let recipients = candidates.results
        .slice(0, INBOX_DELIVERY_RECIPIENT_LIMIT)
        .map((row) => row.fellow_id);
      let hasMore = candidates.results.length > INBOX_DELIVERY_RECIPIENT_LIMIT;
      let deliveryTemplate = template;
      if (template.questionRecipients) {
        const witnesses: DeliveryWitness[] = [];
        let witnessBytes = 2; // JSON array brackets.
        const boundedRecipients: string[] = [];
        for (const fellowId of recipients) {
          // One independently verified target establishes authorship. Carrying
          // every referenced publication for every author would multiply the
          // bound payload without making this recipient more trustworthy.
          const source = template.questionRecipients.find(
            (recipient) => recipient.fellowId === fellowId,
          )?.source;
          if (!source) throw new Error("QUESTION_REQUEST_RECIPIENT_UNVERIFIED");
          // Bind the selected exact publication and its author together. An
          // unchecked alternate reference must not replace this proof if the
          // selected publication is hidden between hashing and the batch.
          const witness: DeliveryWitness = { ...source, fellowId };
          const sourceBytes = new TextEncoder().encode(JSON.stringify(witness)).byteLength;
          const nextBytes = witnessBytes + sourceBytes + (witnesses.length > 0 ? 1 : 0);
          if (nextBytes > MAX_DELIVERY_WITNESS_BYTES) {
            // Each source was capped at 512 KiB before hashing. Even maximal
            // JSON escaping fits a first witness, so a large page always
            // advances and resumes from the last committed Fellow.
            if (witnesses.length === 0) throw new Error("QUESTION_REQUEST_WITNESS_TOO_LARGE");
            hasMore = true;
            break;
          }
          witnessBytes = nextBytes;
          witnesses.push(witness);
          boundedRecipients.push(fellowId);
        }
        recipients = boundedRecipients;
        deliveryTemplate = { ...template, witnesses };
      }
      const committed = await db.batch(
        await deliveryStatements(db, job, deliveryTemplate, recipients, hasMore, now),
      );
      const settled = committed.at(-1)?.meta.changes === 1;
      const written = committed.slice(1, -1).reduce((sum, row) => sum + row.meta.changes, 0);
      if (settled) {
        result.notices += written;
        if (!hasMore) result.completed++;
      }
      logDeliveryJob(job, {
        noticeType: template.noticeType,
        recipients: recipients.length,
        notices: settled ? written : 0,
        cursor: recipients.at(-1) ?? job.after_fellow_id,
        state: !settled ? "lost-race" : hasMore ? "pending" : "delivered",
        startedAt: jobStartedAt,
      });
    } catch {
      logDeliveryJob(job, { state: "retry", startedAt: jobStartedAt });
      // Leave the job pending after a storage failure. Observe the other jobs
      // before the scheduled entrypoint reports the incomplete pass.
      result.failed++;
      // Rotate a poison storage failure behind other pending jobs. A global
      // outage may also prevent this update; the original durable job remains.
      try {
        await db
          .prepare(`UPDATE inbox_event_deliveries SET updated_at = ?
          WHERE id = ? AND state = 'pending' AND after_fellow_id = ?`)
          .bind(now, job.id, job.after_fellow_id)
          .run();
      } catch {
        /* Retry from durable state on the next scheduled pass. */
      }
    }
  }
  return result;
}
