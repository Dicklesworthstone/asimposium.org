import type { D1Database } from "@cloudflare/workers-types";
import { readScientificDispositions } from "../ledger/scientific-disposition";

/** One bounded pass per scheduled tick; the next tick drains the rest. */
export const DISPOSITION_CHANGE_JOB_LIMIT = 16;
export const DISPOSITION_CHANGE_RECIPIENT_LIMIT = 32;
const CLAIM = /^C-[1-9][0-9]*$/;

export interface DispositionChangeResult {
  readonly examined: number;
  readonly changed: number;
  readonly notices: number;
  readonly unchanged: number;
  readonly quarantined: number;
  readonly failed: number;
}

interface Job {
  event_id: string;
  problem_id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string;
  actor_fellow_id: string | null;
  payload_json: string | null;
}

/** The claim an event can move, from server-written fields only. */
function affectedClaim(job: Job): string | null {
  if (job.type === "claim.revised" || job.type === "object.retracted") {
    return job.object_kind === "claim" && CLAIM.test(job.object_id) ? job.object_id : null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(job.payload_json ?? "null");
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  const fields = payload as Record<string, unknown>;
  const claim =
    job.type === "review.created"
      ? fields.target_claim_id
      : job.type === "evidence.created" && fields.bears_on_kind === "claim"
        ? fields.bears_on_id
        : undefined;
  return typeof claim === "string" && CLAIM.test(claim) ? claim : null;
}

async function noticeId(eventId: string, fellowId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`disposition-change\0${eventId}\0${fellowId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `N-dc-${hex.join("").slice(0, 48)}`;
}

async function settle(db: D1Database, eventId: string, state: string, now: number, code?: string) {
  await db
    .prepare(
      `UPDATE disposition_change_deliveries SET state = ?, updated_at = ?, failure_code = ?
       WHERE event_id = ? AND state = 'pending'`,
    )
    .bind(state, now, code ?? null, eventId)
    .run();
}

/** Recompute the affected claim's disposition just before and at each queued
 * event; on a real change, tell the claim's author and prior reviewers (never
 * the actor) privately. Dispositions stay computed: the notice states the two
 * folds and points back at the ledger, it does not assert anything new. */
export async function deliverDispositionChanges(
  db: D1Database,
  options: { readonly now?: number; readonly limit?: number } = {},
): Promise<DispositionChangeResult> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? DISPOSITION_CHANGE_JOB_LIMIT;
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Invalid disposition change sweep bounds.");
  }
  const jobs = await db
    .prepare(
      `SELECT q.event_id, q.problem_id, e.seq, e.type, e.object_kind, e.object_id,
         e.actor_fellow_id,
         CASE WHEN c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
           THEN c.payload_json END AS payload_json
       FROM disposition_change_deliveries q
       JOIN events e ON e.id = q.event_id
       LEFT JOIN event_content c ON c.event_id = e.id
       WHERE q.state = 'pending'
       ORDER BY q.queued_at, q.event_id LIMIT ?`,
    )
    .bind(Math.min(limit, DISPOSITION_CHANGE_JOB_LIMIT))
    .all<Job>();
  const result = { examined: 0, changed: 0, notices: 0, unchanged: 0, quarantined: 0, failed: 0 };
  for (const job of jobs.results) {
    result.examined++;
    try {
      const claimId = affectedClaim(job);
      if (claimId === null || !Number.isSafeInteger(job.seq) || job.seq < 1) {
        await settle(db, job.event_id, "quarantined", now, "SOURCE_INVALID");
        result.quarantined++;
        continue;
      }
      const target = { claimId, version: Number.MAX_SAFE_INTEGER };
      const [before, after] = await Promise.all([
        readScientificDispositions(db, job.problem_id, job.seq - 1, 1, target),
        readScientificDispositions(db, job.problem_id, job.seq, 1, target),
      ]);
      const from = before.get(claimId)?.disposition ?? null;
      const to = after.get(claimId)?.disposition ?? null;
      if (to === null || from === to) {
        await settle(db, job.event_id, "unchanged", now);
        result.unchanged++;
        continue;
      }
      // Author of the claim plus every Fellow who reviewed it before this
      // event, excluding the actor, bounded.
      const recipients = await db
        .prepare(
          `SELECT DISTINCT e.actor_fellow_id AS fellow_id FROM events e
           JOIN enrollment_fellows f ON f.fellow_id = e.actor_fellow_id
           WHERE e.problem_id = ? AND e.seq < ? AND e.actor_fellow_id IS NOT NULL
             AND e.actor_fellow_id IS NOT ?
             AND (
               (e.type = 'claim.created' AND e.object_kind = 'claim' AND e.object_id = ?)
               OR (e.type = 'review.created' AND EXISTS (
                 SELECT 1 FROM event_content c WHERE c.event_id = e.id
                   AND c.redacted_at IS NULL AND json_valid(c.payload_json)
                   AND json_extract(c.payload_json, '$.target_claim_id') = ?))
             )
           ORDER BY e.actor_fellow_id LIMIT ?`,
        )
        .bind(
          job.problem_id,
          job.seq,
          job.actor_fellow_id,
          claimId,
          claimId,
          DISPOSITION_CHANGE_RECIPIENT_LIMIT,
        )
        .all<{ fellow_id: string }>();
      const title = `${claimId} is now ${to}`;
      const detail = `${claimId} on ${job.problem_id} moved from ${from ?? "no disposition"} to ${to} at ledger sequence ${job.seq} (${job.type}). Dispositions are computed from the ledger; read the claim and the record that moved it before relying on the change.`;
      const statements = await Promise.all(
        recipients.results.map(async ({ fellow_id }) =>
          db
            .prepare(
              `INSERT INTO fellow_inbox_notices (
                 id, fellow_id, problem_id, notice_type, seq, title, detail,
                 impact_kind, caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
               )
               SELECT ?, ?, ?, 'disposition_change',
                 (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
                   THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
                  FROM fellow_inbox_notices n WHERE n.fellow_id = ?),
                 ?, ?, NULL, ?, ?, NULL, NULL, ?
               WHERE EXISTS (SELECT 1 FROM disposition_change_deliveries
                 WHERE event_id = ? AND state = 'pending')
               ON CONFLICT (id) DO NOTHING`,
            )
            .bind(
              await noticeId(job.event_id, fellow_id),
              fellow_id,
              job.problem_id,
              fellow_id,
              title,
              detail,
              job.event_id,
              claimId,
              now,
              job.event_id,
            ),
        ),
      );
      const settled = db
        .prepare(
          `UPDATE disposition_change_deliveries SET state = 'delivered', updated_at = ?
           WHERE event_id = ? AND state = 'pending'`,
        )
        .bind(now, job.event_id);
      const written = await db.batch([...statements, settled]);
      result.changed++;
      result.notices += written
        .slice(0, statements.length)
        .reduce((total, row) => total + (row.meta.changes ?? 0), 0);
    } catch {
      result.failed++;
    }
  }
  return result;
}
