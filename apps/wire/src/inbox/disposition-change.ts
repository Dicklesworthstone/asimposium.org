import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { directiveDisclosureCompleteSql } from "../directives/disclosure-store.ts";
import { sha256Hex } from "../krater/krater.ts";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import { DEPENDENCY_SOURCE_BYTES } from "../ledger/claim-dependency-closure.ts";
import { displayClaimDisposition, reviewStateFromRecordedReviews } from "../ledger/dispositions";
import {
  readScientificDispositions,
  type ScientificDisposition,
} from "../ledger/scientific-disposition";

/** One bounded pass per scheduled tick; the next tick drains the rest. */
export const DISPOSITION_CHANGE_JOB_LIMIT = 16;
export const DISPOSITION_CHANGE_RECIPIENT_LIMIT = 32;
/** Shared across all cause jobs in a sweep, in addition to their direct targets. */
export const DISPOSITION_CHANGE_DEPENDENT_LIMIT = 8;
const CLAIM = /^C-[1-9][0-9]*$/;
const CLAIM_PIN = /^(C-[1-9][0-9]*)(?:@([1-9][0-9]*))?$/;
const MAX_SOURCE_BYTES = 524_288;

export interface DispositionChangeResult {
  readonly examined: number;
  readonly changed: number;
  readonly notices: number;
  readonly unchanged: number;
  readonly quarantined: number;
  readonly failed: number;
  /** Examined cause jobs with a durable continuation still pending. */
  readonly pending: number;
}

interface Job {
  event_id: string;
  problem_id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string;
  object_version: number;
  actor_fellow_id: string | null;
  payload_sha256: string;
  payload_json: string | null;
  disclosure_claim_id: string | null;
  disclosure_claim_version: number | null;
  disclosure_decision: string | null;
  direct_complete: number;
  dependent_after_seq: number;
  target_claim_id: string | null;
  target_version: number | null;
  target_payload_sha256: string | null;
}

/** The claim an event can move, from digest-bound content and the writer's
 * immutable withdrawal index. A retraction's object id identifies the
 * correction, not the claim whose standing must be recomputed. */
async function affectedTarget(
  db: D1Database,
  job: Job,
): Promise<{ claimId: string; version: number } | null> {
  // Persist the first digest-validated routing decision before any fanout.
  // Lawful cause-body redaction between pages must not discard remaining
  // repairs, but changing the immutable cause envelope cannot reuse its pin.
  if (
    job.target_claim_id !== null ||
    job.target_version !== null ||
    job.target_payload_sha256 !== null
  ) {
    return job.target_claim_id !== null &&
      CLAIM.test(job.target_claim_id) &&
      job.target_version !== null &&
      Number.isSafeInteger(job.target_version) &&
      job.target_version > 0 &&
      job.target_payload_sha256 === job.payload_sha256
      ? { claimId: job.target_claim_id, version: job.target_version }
      : null;
  }
  if (job.type === "directive.disclosure-recorded") {
    return job.disclosure_claim_id !== null &&
      CLAIM.test(job.disclosure_claim_id) &&
      job.disclosure_claim_version !== null &&
      Number.isSafeInteger(job.disclosure_claim_version) &&
      job.disclosure_claim_version > 0
      ? { claimId: job.disclosure_claim_id, version: job.disclosure_claim_version }
      : null;
  }
  if (job.type === "claim.revised") {
    return job.object_kind === "claim" && CLAIM.test(job.object_id)
      ? { claimId: job.object_id, version: Number.MAX_SAFE_INTEGER }
      : null;
  }
  let payload: unknown = null;
  try {
    if (job.payload_json !== null) {
      if (
        new TextEncoder().encode(job.payload_json).byteLength > MAX_SOURCE_BYTES ||
        (await sha256Hex(job.payload_json)) !== job.payload_sha256
      )
        return null;
      payload = JSON.parse(job.payload_json);
    }
  } catch {
    return null;
  }
  if (payload !== null && (typeof payload !== "object" || Array.isArray(payload))) return null;
  const fields = payload as Record<string, unknown> | null;
  if (job.type === "object.retracted" && job.object_kind === "retraction") {
    const target = await db
      .prepare(`SELECT r.target_object, w.claim_id, w.claim_version,
          w.source_event_id, w.source_sha256, w.target_kind
        FROM retractions r JOIN events e ON e.problem_id = r.problem_id
          AND e.seq = r.seq AND e.object_id = r.retraction_id
          AND e.actor_fellow_id = r.author_fellow_id
        LEFT JOIN scientific_withdrawals w ON w.event_id = e.id
          AND w.event_sha256 = e.payload_sha256 AND w.problem_id = e.problem_id
          AND w.retraction_id = r.retraction_id AND w.seq = e.seq
          AND w.fellow_id = e.actor_fellow_id AND w.sponsor_id = e.actor_sponsor_id
          AND w.target_object = r.target_object
          AND EXISTS (SELECT 1 FROM events source WHERE source.id = w.source_event_id
            AND source.problem_id = e.problem_id AND source.seq < e.seq
            AND source.object_id = w.target_object AND source.object_kind = w.target_kind
            AND source.type = w.target_kind || '.created' AND source.object_version = 1
            AND source.actor_fellow_id = e.actor_fellow_id
            AND source.payload_sha256 = w.source_sha256)
        WHERE e.id = ? AND e.type = 'object.retracted' AND e.object_kind = 'retraction'
          AND e.object_version = 1 AND e.payload_sha256 = ?`)
      .bind(job.event_id, job.payload_sha256)
      .first<{
        target_object: string;
        claim_id: string | null;
        claim_version: number | null;
        source_event_id: string | null;
        source_sha256: string | null;
        target_kind: string | null;
      }>();
    if (!target || (fields && fields.target_object !== target.target_object)) return null;
    if (target.source_event_id !== null) {
      if (
        target.claim_id === null ||
        !CLAIM.test(target.claim_id) ||
        target.claim_version === null ||
        !Number.isSafeInteger(target.claim_version) ||
        target.claim_version < 1 ||
        (fields &&
          (fields.target_event_id !== target.source_event_id ||
            fields.target_digest !== `sha256:${target.source_sha256}` ||
            fields.target_kind !== target.target_kind ||
            fields.claim_id !== target.claim_id ||
            fields.claim_version !== target.claim_version))
      )
        return null;
      // Compare the current claim at each event cut. Withdrawing a review of
      // an older version must never announce that today's version was lost.
      return { claimId: target.claim_id, version: Number.MAX_SAFE_INTEGER };
    }
    const pin = CLAIM_PIN.exec(target.target_object);
    return pin?.[1] && (pin[2] === undefined || Number.isSafeInteger(Number(pin[2])))
      ? { claimId: pin[1], version: Number.MAX_SAFE_INTEGER }
      : null;
  }
  if (fields === null) return null;
  const claim =
    job.type === "review.created"
      ? fields.target_claim_id
      : job.type === "evidence.created" && fields.bears_on_kind === "claim"
        ? fields.bears_on_id
        : undefined;
  return typeof claim === "string" && CLAIM.test(claim)
    ? { claimId: claim, version: Number.MAX_SAFE_INTEGER }
    : null;
}

async function noticeId(eventId: string, claimId: string, fellowId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`disposition-change\0${eventId}\0${claimId}\0${fellowId}`),
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
/** Digest of the public standing a reader sees (face and pack): the displayed
 * disposition, the stale flag, review-state and directive-disclosure facets.
 * Internal fold detail (the review list itself) is deliberately excluded, so
 * two digests differ exactly when the public standing moved. */
function standingFacets(state: ScientificDisposition) {
  return {
    disposition: displayClaimDisposition(state.disposition, state.context),
    stale: state.stale,
    directive_disclosure: state.directiveDisclosure,
    review_state: reviewStateFromRecordedReviews(
      state.reviewFacets.filter((review) => review.targetVersion === state.currentVersion),
    ),
  };
}

async function facetsDigest(state: ScientificDisposition | undefined): Promise<string | null> {
  if (state === undefined) return null;
  const standing = standingFacets(state);
  const bytes = new TextEncoder().encode(JSON.stringify(standing));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface DeliveryTarget {
  claimId: string;
  version: number;
  /** null is the directly affected claim; other values are page cursors. */
  dependentSeq: number | null;
}

function advanceTarget(
  db: D1Database,
  job: Job,
  target: DeliveryTarget,
  now: number,
  changed: boolean,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE disposition_change_deliveries
    SET direct_complete = CASE WHEN ? IS NULL THEN 1 ELSE direct_complete END,
      dependent_after_seq = max(dependent_after_seq, coalesce(?, 0)),
      standing_changed = max(standing_changed, ?), updated_at = ?
    WHERE event_id = ? AND state = 'pending'`)
    .bind(target.dependentSeq, target.dependentSeq, changed ? 1 : 0, now, job.event_id);
}

/** Candidate discovery is a durable page through immutable publications at the
 * cause cut, not a second dependency evaluator. Canonical before/after folds
 * below decide whether any direct or transitive premise actually moved. This
 * also advances past unrelated/unchanged candidates, without dropping a graph
 * branch at a recursion cap or revisiting a diamond once per incoming edge. */
async function dependentPage(db: D1Database, job: Job, directClaim: string, limit: number) {
  return db
    .prepare(`SELECT e.object_id AS claimId, e.object_version AS version,
      e.seq AS dependentSeq
    FROM events e JOIN problems p ON p.id = e.problem_id
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    WHERE e.problem_id = ? AND e.object_kind = 'claim'
      AND e.type IN ('claim.created', 'claim.revised') AND e.object_id <> ?
      AND e.seq > ? AND e.seq < ? AND e.seq <= p.public_seq
      AND p.status <> 'private-draft' AND c.redacted_at IS NULL
      AND length(CAST(c.payload_json AS BLOB)) <= ${DEPENDENCY_SOURCE_BYTES}
      AND NOT ${eventContentHiddenSql("e")}
      AND CASE WHEN json_valid(c.payload_json) THEN
        json_type(c.payload_json, '$.dependency_pins') = 'array'
        AND json_array_length(c.payload_json, '$.dependency_pins') > 0 ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM events newer
        WHERE newer.problem_id = e.problem_id AND newer.object_id = e.object_id
          AND newer.object_kind = 'claim' AND newer.type IN ('claim.created', 'claim.revised')
          AND newer.seq > e.seq AND newer.seq <= ?)
    ORDER BY e.seq LIMIT ?`)
    .bind(job.problem_id, directClaim, job.dependent_after_seq, job.seq, job.seq, limit + 1)
    .all<DeliveryTarget>();
}

/** Recheck current visibility inside the notice transaction as well as in the
 * scientific read. An old cause cursor never grants access to a hidden target. */
const VISIBLE_TARGET_SQL = `EXISTS (
  SELECT 1 FROM events visible JOIN problems p ON p.id = visible.problem_id
  JOIN event_content c ON c.event_id = visible.id AND c.payload_sha256 = visible.payload_sha256
  WHERE visible.problem_id = ? AND visible.object_id = ? AND visible.object_version = ?
    AND visible.object_kind = 'claim' AND visible.type IN ('claim.created', 'claim.revised')
    AND visible.seq <= ? AND visible.seq <= p.public_seq AND p.status <> 'private-draft'
    AND c.redacted_at IS NULL AND NOT ${eventContentHiddenSql("visible")}
)`;

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
      `SELECT q.event_id, q.problem_id, q.direct_complete, q.dependent_after_seq,
         q.target_claim_id, q.target_version, q.target_payload_sha256,
         e.seq, e.type, e.object_kind, e.object_id,
         e.object_version, e.actor_fellow_id, e.payload_sha256,
         disclosure.claim_id AS disclosure_claim_id,
         disclosure.claim_version AS disclosure_claim_version,
         disclosure.decision AS disclosure_decision,
         CASE WHEN c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
           AND length(CAST(c.payload_json AS BLOB)) <= ${MAX_SOURCE_BYTES}
           THEN c.payload_json END AS payload_json
       FROM disposition_change_deliveries q
       JOIN events e ON e.id = q.event_id AND e.problem_id = q.problem_id
       LEFT JOIN event_content c ON c.event_id = e.id
       LEFT JOIN directive_disclosure_records disclosure ON disclosure.event_id = e.id
         AND disclosure.problem_id = e.problem_id AND disclosure.seq = e.seq
         AND e.type = 'directive.disclosure-recorded' AND e.object_kind = 'directive-disclosure'
         AND e.object_id = disclosure.event_id AND e.object_version = disclosure.revision
         AND e.actor_sponsor_id = disclosure.sponsor_id AND e.actor_fellow_id IS NULL
         AND e.payload_sha256 = disclosure.public_payload_sha256
         AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
         AND c.payload_json = disclosure.public_payload_json
       WHERE q.state = 'pending'
       ORDER BY q.queued_at, q.event_id LIMIT ?`,
    )
    .bind(Math.min(limit, DISPOSITION_CHANGE_JOB_LIMIT))
    .all<Job>();
  const result = {
    examined: 0,
    changed: 0,
    notices: 0,
    unchanged: 0,
    quarantined: 0,
    failed: 0,
    pending: 0,
  };
  let dependentBudget = DISPOSITION_CHANGE_DEPENDENT_LIMIT;
  for (const job of jobs.results) {
    result.examined++;
    const startedAt = Date.now();
    const log = (state: string, extra: Record<string, unknown> = {}) =>
      console.info(
        JSON.stringify({
          facility: "OPS.2a",
          stage: "disposition-change-job",
          caused_by_event_id: job.event_id,
          problem_id: job.problem_id,
          state,
          ...extra,
          latency_ms: Math.max(0, Date.now() - startedAt),
        }),
      );
    try {
      const direct = await affectedTarget(db, job);
      if (direct === null || !Number.isSafeInteger(job.seq) || job.seq < 1) {
        await settle(db, job.event_id, "quarantined", now, "SOURCE_INVALID");
        result.quarantined++;
        log("quarantined");
        continue;
      }
      // Save only the verified target and cause digest, never the cause body.
      // A concurrent completed delivery or different pin cannot be overwritten.
      const pinned = await db
        .prepare(`UPDATE disposition_change_deliveries
          SET target_claim_id = ?, target_version = ?, target_payload_sha256 = ?, updated_at = ?
          WHERE event_id = ? AND state = 'pending'
            AND ((target_claim_id IS NULL AND target_version IS NULL AND target_payload_sha256 IS NULL)
              OR (target_claim_id = ? AND target_version = ? AND target_payload_sha256 = ?))
          RETURNING target_claim_id`)
        .bind(
          direct.claimId,
          direct.version,
          job.payload_sha256,
          now,
          job.event_id,
          direct.claimId,
          direct.version,
          job.payload_sha256,
        )
        .first<{ target_claim_id: string }>();
      if (!pinned) continue;
      // Disclosure revisions change the direct disclosure facet, but do not
      // invalidate the scientific completeness of a pinned premise chain.
      const scanDependents = job.type !== "directive.disclosure-recorded";
      const page =
        scanDependents && dependentBudget > 0
          ? await dependentPage(db, job, direct.claimId, dependentBudget)
          : null;
      const candidates = page?.results.slice(0, dependentBudget) ?? [];
      let continuation = scanDependents && (page === null || page.results.length > dependentBudget);
      const targets: DeliveryTarget[] = [
        ...(job.direct_complete === 0 ? [{ ...direct, dependentSeq: null }] : []),
        ...candidates,
      ];
      for (const target of targets) {
        if (target.dependentSeq !== null) dependentBudget--;
        const { claimId } = target;
        const [before, after] = await Promise.all([
          readScientificDispositions(db, job.problem_id, job.seq - 1, 1, target),
          readScientificDispositions(db, job.problem_id, job.seq, 1, target),
        ]);
        const beforeState = before.get(claimId);
        const afterState = after.get(claimId);
        const from = beforeState?.disposition ?? null;
        const to = afterState?.disposition ?? null;
        // 3b9 OPS.2a: the computed standing before and at the event, as digests
        // (never the facets themselves), at the ledger cursor that is the time
        // basis of both computations.
        const computed = {
          cursor: job.seq,
          time_basis: "ledger_seq",
          facets_before_digest: await facetsDigest(beforeState),
          facets_after_digest: await facetsDigest(afterState),
        };
        // Current withdrawal and private-steering controls also dominate older
        // cursor reads. They can make both folds equal after a declaration was
        // withdrawn; report that accepted revision without inventing a prior
        // strong standing that these reads no longer establish.
        const declarationChanged =
          target.dependentSeq === null && job.type === "directive.disclosure-recorded";
        const standingChanged = computed.facets_before_digest !== computed.facets_after_digest;
        if (afterState === undefined || (!standingChanged && !declarationChanged)) {
          await db.batch([advanceTarget(db, job, target, now, false)]);
          result.unchanged++;
          log("unchanged", { claim_id: claimId, ...computed });
          continue;
        }
        // Author of the claim plus every Fellow who reviewed it before this
        // event, excluding the actor, bounded. Already delivered causal notices
        // are a durable continuation cursor, so the recipient limit never drops
        // the 33rd reviewer and overlapping ticks cannot create a second notice.
        const recipients = await db
          .prepare(
            `SELECT DISTINCT e.actor_fellow_id AS fellow_id FROM events e
           JOIN enrollment_fellows f ON f.fellow_id = e.actor_fellow_id AND f.status = 'active'
           WHERE e.problem_id = ? AND e.seq < ? AND e.actor_fellow_id IS NOT NULL
             AND e.actor_fellow_id IS NOT ?
             AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices n
               WHERE n.fellow_id = e.actor_fellow_id AND n.problem_id = e.problem_id
                 AND n.notice_type = 'disposition_change' AND n.caused_by_event_id = ?
                 AND n.target_id = ?)
             AND (
               (e.type = 'claim.created' AND e.object_kind = 'claim' AND e.object_id = ?)
               OR (e.type = 'review.created' AND EXISTS (
                 SELECT 1 FROM event_content c WHERE c.event_id = e.id
                   AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
                   AND NOT ${eventContentHiddenSql("e")} AND json_valid(c.payload_json)
                   AND json_extract(c.payload_json, '$.target_claim_id') = ?))
             )
           ORDER BY e.actor_fellow_id LIMIT ?`,
          )
          .bind(
            job.problem_id,
            job.seq,
            job.actor_fellow_id,
            job.event_id,
            claimId,
            claimId,
            claimId,
            DISPOSITION_CHANGE_RECIPIENT_LIMIT + 1,
          )
          .all<{ fellow_id: string }>();
        const claimLabel =
          target.dependentSeq !== null || job.type === "directive.disclosure-recorded"
            ? `${claimId}@${afterState.currentVersion ?? target.version}`
            : claimId;
        const prior = beforeState === undefined ? undefined : standingFacets(beforeState);
        const current = standingFacets(afterState);
        const displayChanged = prior?.disposition !== current.disposition;
        const title = displayChanged
          ? `${claimLabel} is now ${current.disposition}`
          : standingChanged
            ? `${claimLabel} scientific standing updated`
            : `${claimLabel} disclosure ${job.disclosure_decision === "withdraw" ? "withdrawn" : "updated"}`;
        const detail = displayChanged
          ? `${claimLabel} on ${job.problem_id} moved from ${prior?.disposition ?? "no disposition"} to ${current.disposition} at ledger sequence ${job.seq} (${job.type}). Dispositions are computed from the ledger; read the claim and the record that moved it before relying on the change.`
          : standingChanged
            ? `${claimLabel} on ${job.problem_id} changed scientific standing at ledger sequence ${job.seq} (${job.type}). Its displayed disposition is ${current.disposition}; review state ${prior?.review_state ?? "unavailable"} → ${current.review_state}; stale ${prior?.stale ?? false} → ${current.stale}; directive disclosure ${prior?.directive_disclosure ?? "unavailable"} → ${current.directive_disclosure}. Read the claim and the source record before relying on its standing.`
            : `A sponsor disclosure for ${claimLabel} on ${job.problem_id} was ${job.disclosure_decision === "withdraw" ? "withdrawn" : "updated"} at ledger sequence ${job.seq}. Its current computed disposition is ${to}. Read the claim and this disclosure revision before relying on its standing.`;
        const hasMore = recipients.results.length > DISPOSITION_CHANGE_RECIPIENT_LIMIT;
        const statements = await Promise.all(
          recipients.results
            .slice(0, DISPOSITION_CHANGE_RECIPIENT_LIMIT)
            .map(async ({ fellow_id }) =>
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
                 AND EXISTS (SELECT 1 FROM enrollment_fellows WHERE fellow_id = ? AND status = 'active')
                 AND ${VISIBLE_TARGET_SQL}
                 AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices n
                   WHERE n.fellow_id = ? AND n.problem_id = ? AND n.notice_type = 'disposition_change'
                     AND n.caused_by_event_id = ? AND n.target_id = ?)
               ON CONFLICT (id) DO NOTHING`,
                )
                .bind(
                  await noticeId(job.event_id, claimId, fellow_id),
                  fellow_id,
                  job.problem_id,
                  fellow_id,
                  title,
                  detail,
                  job.event_id,
                  claimId,
                  now,
                  job.event_id,
                  fellow_id,
                  job.problem_id,
                  claimId,
                  afterState.currentVersion,
                  job.seq,
                  fellow_id,
                  job.problem_id,
                  job.event_id,
                  claimId,
                ),
            ),
        );
        const progress = hasMore ? [] : [advanceTarget(db, job, target, now, standingChanged)];
        // A new private instruction can invalidate coverage without changing
        // the public cursor used by either fold. Never commit a strong-standing
        // notice after that race; leave its job pending for a fresh computation.
        const guards =
          to === "strongly-supported"
            ? [
                db
                  // Materialize the coverage check before the aborting CASE.
                  // D1 limits expression depth to 100; flattening this predicate
                  // into another EXISTS can exceed that limit for valid coverage.
                  // The guard and notice writes still run in one transaction.
                  .prepare(`WITH coverage AS MATERIALIZED (
          SELECT ${directiveDisclosureCompleteSql("?", "?", "?")} AS complete
        ) SELECT CASE WHEN complete THEN 1
          ELSE json_extract('[]', '$[SCIENTIFIC_REFERENCE_CHANGED') END FROM coverage`)
                  .bind(
                    job.problem_id,
                    claimId,
                    after.get(claimId)?.currentVersion ?? target.version,
                  ),
              ]
            : [];
        const written = await db.batch([...guards, ...statements, ...progress]);
        const notices = written
          .slice(guards.length, guards.length + statements.length)
          .reduce((total, row) => total + (row.meta.changes ?? 0), 0);
        if (standingChanged) result.changed++;
        else result.unchanged++;
        result.notices += notices;
        log(hasMore ? "partial" : "delivered", {
          claim_id: claimId,
          from,
          to,
          recipients: statements.length,
          notices,
          ...computed,
        });
        if (hasMore) {
          // The page cursor stays before this claim until its recipient page is
          // complete. Already written notices are the replay-safe recipient cursor.
          continuation = true;
          break;
        }
      }
      if (continuation) {
        result.pending++;
        log("pending", { dependent_budget_remaining: dependentBudget });
      } else {
        await db
          .prepare(`UPDATE disposition_change_deliveries
          SET state = CASE WHEN standing_changed = 1 THEN 'delivered' ELSE 'unchanged' END,
            updated_at = ?
          WHERE event_id = ? AND state = 'pending' AND direct_complete = 1`)
          .bind(now, job.event_id)
          .run();
      }
    } catch {
      result.failed++;
      result.pending++;
      log("retry");
    }
  }
  return result;
}
