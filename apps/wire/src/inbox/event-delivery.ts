import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { inboxNoticeId } from "./notice-write.ts";
import type { NoticeCreateInput } from "./store.ts";

export const INBOX_DELIVERY_JOB_LIMIT = 8;
export const INBOX_DELIVERY_RECIPIENT_LIMIT = 20;
const MAX_SOURCE_BYTES = 512 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

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
}

interface DeliveryTemplate {
  targetClaim: string | null;
  noticeType: "statement_revision" | "object_critique";
  targetId: string | null;
  title: string;
  detail: string;
  createdAt: number;
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
 * to a subscription created after it; removal is rechecked at commit. Review
 * authorship comes from the immutable creation event, not today's sponsor. */
const RECIPIENT_SQL = `(
  (e.type = 'problem.statement-revised' AND (
    EXISTS (SELECT 1 FROM problem_follows pf
      WHERE pf.problem_id = e.problem_id AND pf.principal_id = f.fellow_id
        AND pf.created_at <= CAST(unixepoch(e.created_at, 'subsec') * 1000 AS INTEGER))
    OR EXISTS (SELECT 1 FROM problem_memberships m
      WHERE m.problem_id = e.problem_id AND m.fellow_id = f.fellow_id
        AND m.joined_at <= e.created_at)
  )) OR (e.type = 'review.created' AND f.fellow_id <> e.actor_fellow_id
    AND EXISTS (SELECT 1 FROM events author
      WHERE author.problem_id = e.problem_id AND author.type = 'claim.created'
        AND author.object_kind = 'claim' AND author.object_version = 1
        AND author.object_id = ? AND author.actor_fellow_id = f.fellow_id
        AND author.seq < e.seq))
)`;

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function templateFor(job: DeliveryJob): Promise<DeliveryTemplate | null> {
  if (
    !ID.test(job.event_id) || !ID.test(job.problem_id) || !ID.test(job.object_id) ||
    !Number.isSafeInteger(job.object_version) || job.object_version < 1 ||
    job.payload_json === null || !/^[a-f0-9]{64}$/.test(job.payload_sha256) ||
    new TextEncoder().encode(job.payload_json).byteLength > MAX_SOURCE_BYTES ||
    await sha256(job.payload_json) !== job.payload_sha256
  ) return null;
  const createdAt = Date.parse(job.created_at);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0 ||
    new Date(createdAt).toISOString() !== job.created_at) return null;
  let payload: unknown;
  try { payload = JSON.parse(job.payload_json); } catch { return null; }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  if (job.type === "problem.statement-revised" && job.object_kind === "problem" &&
    job.object_id === job.problem_id) {
    return {
      targetClaim: null, noticeType: "statement_revision", targetId: null, createdAt,
      title: `Problem ${job.problem_id} statement revised (version ${job.object_version})`,
      detail: `The statement for problem ${job.problem_id} was revised to version ${job.object_version}. Re-orient before submitting further writes.`,
    };
  }
  if (job.type === "review.created" && job.object_kind === "review" &&
    job.actor_fellow_id !== null && ID.test(job.actor_fellow_id) &&
    "target_claim_id" in payload && typeof payload.target_claim_id === "string" &&
    /^C-[1-9][0-9]*$/.test(payload.target_claim_id) && payload.target_claim_id.length <= 60 &&
    "target_version" in payload && typeof payload.target_version === "number" &&
    Number.isSafeInteger(payload.target_version) && payload.target_version > 0) {
    const target = `${payload.target_claim_id}@${payload.target_version}`;
    return {
      targetClaim: payload.target_claim_id, noticeType: "object_critique",
      targetId: target, createdAt,
      title: `Review recorded for ${target}`,
      detail: `Review ${job.object_id} addresses ${target} on ${job.problem_id}. Read the public review and current claim state. This notice does not certify the claim or assert a disposition change.`,
    };
  }
  return null;
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
  const statements = [db.prepare(`UPDATE inbox_event_deliveries SET claim_token = ?
    WHERE id = ? AND state = 'pending' AND after_fellow_id = ?
      AND EXISTS (SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
        JOIN problems p ON p.id = e.problem_id
        WHERE e.id = inbox_event_deliveries.event_id AND e.id = ?
          AND c.redacted_at IS NULL AND c.payload_sha256 = e.payload_sha256
          AND c.payload_sha256 = ? AND c.payload_json = ? AND p.status <> 'private-draft')`)
    .bind(token, job.id, job.after_fellow_id, job.event_id, job.payload_sha256, job.payload_json)];
  for (const fellowId of recipients) {
    const input: NoticeCreateInput = {
      fellowId, problemId: job.problem_id, noticeType: template.noticeType,
      targetId: template.targetId, causedByEventId: job.event_id,
      title: template.title, detail: template.detail,
    };
    const id = await inboxNoticeId(input);
    // Recognize existing causal notices, including legacy random IDs and the
    // synchronous statement-revision producer. Never reset an acknowledgment.
    statements.push(db.prepare(`INSERT INTO fellow_inbox_notices
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
        AND p.status <> 'private-draft' AND ${RECIPIENT_SQL}
        AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices n
          WHERE n.fellow_id = f.fellow_id AND n.problem_id = e.problem_id
            AND n.notice_type = ? AND n.caused_by_event_id = e.id
            AND (n.target_id IS ? OR
              (n.notice_type = 'object_critique' AND n.target_id = e.object_id))
            AND n.impact_kind IS NULL)
      ON CONFLICT (id) DO NOTHING`)
      .bind(id, template.noticeType, template.title, template.detail, template.targetId,
        template.createdAt, fellowId, job.id, token, template.targetClaim,
        template.noticeType, template.targetId));
  }
  statements.push(db.prepare(`UPDATE inbox_event_deliveries
    SET after_fellow_id = ?, state = ?, claim_token = NULL, updated_at = ?, failure_code = NULL
    WHERE id = ? AND state = 'pending' AND claim_token = ?`)
    .bind(recipients.at(-1) ?? job.after_fellow_id, hasMore ? "pending" : "delivered", now,
      job.id, token));
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
  const jobs = await db.prepare(`SELECT q.id, q.event_id, q.after_fellow_id,
      e.problem_id, e.type, e.object_kind, e.object_id, e.object_version, e.payload_sha256,
      e.actor_fellow_id, e.created_at, p.status AS problem_status, c.redacted_at,
      CASE WHEN c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
        AND length(CAST(c.payload_json AS BLOB)) <= ? THEN c.payload_json END AS payload_json
    FROM inbox_event_deliveries q JOIN events e ON e.id = q.event_id
    JOIN problems p ON p.id = e.problem_id LEFT JOIN event_content c ON c.event_id = e.id
    WHERE q.state = 'pending' ORDER BY q.updated_at, q.id LIMIT ?`)
    .bind(MAX_SOURCE_BYTES, INBOX_DELIVERY_JOB_LIMIT).all<DeliveryJob>();
  const result: InboxDeliveryResult = {
    examined: jobs.results.length, notices: 0, completed: 0, suppressed: 0, quarantined: 0, failed: 0,
  };
  for (const job of jobs.results) {
    try {
      if (job.problem_status === "private-draft" || job.redacted_at !== null) {
        const suppressed = await db.prepare(`UPDATE inbox_event_deliveries
          SET state = 'suppressed', updated_at = ?, failure_code = 'SOURCE_WITHDRAWN'
          WHERE id = ? AND state = 'pending' AND after_fellow_id = ?
            AND EXISTS (SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
              LEFT JOIN event_content c ON c.event_id = e.id
              WHERE e.id = inbox_event_deliveries.event_id
                AND (p.status = 'private-draft' OR c.redacted_at IS NOT NULL))`)
          .bind(now, job.id, job.after_fellow_id).run();
        result.suppressed += suppressed.meta.changes;
        continue;
      }
      const template = await templateFor(job);
      if (template === null) {
        const invalid = await db.prepare(`UPDATE inbox_event_deliveries
          SET state = 'quarantined', updated_at = ?, failure_code = 'SOURCE_INVALID'
          WHERE id = ? AND state = 'pending' AND after_fellow_id = ?`)
          .bind(now, job.id, job.after_fellow_id).run();
        result.quarantined += invalid.meta.changes;
        continue;
      }
      const candidates = await db.prepare(`WITH source AS (
          SELECT id, problem_id, type, seq, created_at, actor_fellow_id FROM events WHERE id = ?
        ), candidates AS (
          SELECT author.actor_fellow_id AS fellow_id FROM source e JOIN events author
            ON author.problem_id = e.problem_id AND author.type = 'claim.created'
              AND author.object_kind = 'claim' AND author.object_version = 1
              AND author.object_id = ? AND author.seq < e.seq
          WHERE e.type = 'review.created' AND author.actor_fellow_id <> e.actor_fellow_id
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
        .bind(job.event_id, template.targetClaim, job.after_fellow_id,
          INBOX_DELIVERY_RECIPIENT_LIMIT + 1).all<{ fellow_id: string }>();
      const recipients = candidates.results.slice(0, INBOX_DELIVERY_RECIPIENT_LIMIT)
        .map((row) => row.fellow_id);
      const hasMore = candidates.results.length > INBOX_DELIVERY_RECIPIENT_LIMIT;
      const committed = await db.batch(await deliveryStatements(db, job, template, recipients, hasMore, now));
      if (committed.at(-1)?.meta.changes === 1) {
        result.notices += committed.slice(1, -1).reduce((sum, row) => sum + row.meta.changes, 0);
        if (!hasMore) result.completed++;
      }
    } catch {
      // Leave the job pending after a storage failure. Observe the other jobs
      // before the scheduled entrypoint reports the incomplete pass.
      result.failed++;
      // Rotate a poison storage failure behind other pending jobs. A global
      // outage may also prevent this update; the original durable job remains.
      try {
        await db.prepare(`UPDATE inbox_event_deliveries SET updated_at = ?
          WHERE id = ? AND state = 'pending' AND after_fellow_id = ?`)
          .bind(now, job.id, job.after_fellow_id).run();
      } catch { /* Retry from durable state on the next scheduled pass. */ }
    }
  }
  return result;
}
