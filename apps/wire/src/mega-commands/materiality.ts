import type { D1Database } from "@cloudflare/workers-types";

/**
 * Materiality and Ceremony Guard (Fable §9.6, bead asimposiumorg-z8y).
 *
 * Events are classed:
 * - object-level: claims (claim.created, claim.revised), evidence (evidence.created),
 *   reviews (review.created), hypothesis kills (hypothesis.killed),
 *   substantive dead ends (dead_end.recorded without low-substance flag),
 *   problem admission (problem.admitted), and statement work ONLY during sharpening.
 * - process-level: post-publish statement revisions, syntheses (synthesis.published),
 *   roster and directive events (roster.*, problem_membership.*, directive.sent),
 *   retractions (object.retracted), and session lifecycle.
 *
 * Only object-level events feed explore ranking, the Now strip, roster
 * "last increment", and dormancy reset.
 */

export const CEREMONY_BREAKER_EVENT_THRESHOLD = 25;
export const SYNTHESIS_EVENT_THRESHOLD = 200;
export const IDLE_CLOSE_MOVE_QUIET_MS = 3 * 3600 * 1000; // 3 hours quiet
export const HARD_AUTO_CLOSE_MS = 12 * 3600 * 1000; // 12 hours hard close (W4.1)

export interface EventClassificationInput {
  readonly type: string;
  readonly object_kind?: string | null;
  readonly problem_status?: string | null;
  readonly extract?: string | null;
  readonly payload_json?: string | null;
}

/**
 * Classifies an event as object-level (true) or process-level (false).
 * During sharpening, statement work IS object-level; after active, it is process-level.
 */
export function isObjectLevelEvent(input: EventClassificationInput): boolean {
  const { type, problem_status, extract } = input;

  switch (type) {
    case "claim.created":
    case "claim.revised":
    case "evidence.created":
    case "review.created":
    case "hypothesis.killed":
    case "problem.admitted":
      return true;

    case "dead_end.recorded":
      // A dead end must state what was actually examined and why it fails.
      // Thin ones tagged low-substance-dead-end are excluded from materiality.
      if (extract && extract.includes("low-substance-dead-end")) {
        return false;
      }
      return true;

    case "problem.statement-reviewed":
    case "problem.statement-revised":
    case "problem.statement-updated":
      // During sharpening, statement work IS object-level; after active, it isn't.
      return problem_status === "sharpening";

    case "synthesis.published":
    case "object.retracted":
    case "directive.sent":
    case "problem_membership.assigned":
    case "problem_membership.updated":
    case "session.opened":
    case "session.closed":
    case "session.heartbeat":
    default:
      return false;
  }
}

export interface CeremonyBreakerResult {
  readonly active: boolean;
  readonly objectEventCountInWindow: number;
  readonly totalEventsInWindow: number;
  readonly oldestNeed: {
    readonly ref: string;
    readonly description: string;
    readonly kind:
      | "unreviewed-claim"
      | "unchallenged-support"
      | "unowned-gap"
      | "live-route"
      | "problem";
  } | null;
}

export interface SynthesisTriggerResult {
  readonly needed: boolean;
  readonly eventCountSinceLast: number;
}

export interface IdleSessionResult {
  readonly sessionId: string;
  readonly quietMs: number;
}

/**
 * Checks if the recent event window is process-dominated (25+ events with zero
 * object-level increments). If so, the ceremony breaker triggers and names
 * the oldest open object-level need (Fable §9.6).
 */
export async function checkCeremonyBreaker(
  db: D1Database,
  problemId: string,
  cursor: number,
  problemStatus: string,
): Promise<CeremonyBreakerResult> {
  const eventsResult = await db
    .prepare(
      `SELECT e.seq, e.type, e.object_kind, e.object_id, e.object_version, ec.payload_json
       FROM events e
       LEFT JOIN event_content ec ON ec.event_id = e.id
       WHERE e.problem_id = ? AND e.seq <= ?
       ORDER BY e.seq DESC
       LIMIT ?`,
    )
    .bind(problemId, cursor, CEREMONY_BREAKER_EVENT_THRESHOLD)
    .all<{
      seq: number;
      type: string;
      object_kind: string | null;
      object_id: string;
      object_version: number;
      payload_json: string | null;
    }>();

  const events = eventsResult.results ?? [];
  if (events.length < CEREMONY_BREAKER_EVENT_THRESHOLD) {
    return {
      active: false,
      objectEventCountInWindow: events.filter((e) =>
        isObjectLevelEvent({
          type: e.type,
          object_kind: e.object_kind,
          problem_status: problemStatus,
          extract: e.payload_json,
          payload_json: e.payload_json,
        }),
      ).length,
      totalEventsInWindow: events.length,
      oldestNeed: null,
    };
  }

  let objectCount = 0;
  for (const e of events) {
    if (
      isObjectLevelEvent({
        type: e.type,
        object_kind: e.object_kind,
        problem_status: problemStatus,
        extract: e.payload_json,
        payload_json: e.payload_json,
      })
    ) {
      objectCount++;
    }
  }

  if (objectCount > 0) {
    return {
      active: false,
      objectEventCountInWindow: objectCount,
      totalEventsInWindow: events.length,
      oldestNeed: null,
    };
  }

  // Ceremony breaker fired: 25+ events with 0 object increments!
  // Find the oldest open object-level need on the problem.
  // 1. Oldest unreviewed claim
  const unreviewedClaim = await db
    .prepare(
      `SELECT c.id, c.object_id, c.object_version, c.statement
       FROM (
         SELECT e.id, e.object_id, e.object_version, e.seq,
                (SELECT json_extract(cc.payload_json, '$.statement')
                 FROM event_content cc WHERE cc.event_id = e.id) as statement
         FROM events e
         WHERE e.problem_id = ? AND e.seq <= ?
           AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
           AND NOT EXISTS (
             SELECT 1 FROM reviews r WHERE r.problem_id = e.problem_id
               AND r.target_claim_id = e.object_id AND r.target_version = e.object_version
           )
         ORDER BY e.seq ASC
         LIMIT 1
       ) c`,
    )
    .bind(problemId, cursor)
    .first<{ id: string; object_id: string; object_version: number; statement: string | null }>();

  if (unreviewedClaim) {
    return {
      active: true,
      objectEventCountInWindow: 0,
      totalEventsInWindow: events.length,
      oldestNeed: {
        ref: `${unreviewedClaim.object_id}@${unreviewedClaim.object_version}`,
        description: `Oldest unreviewed claim ${unreviewedClaim.object_id}@${unreviewedClaim.object_version} lacks an independent review.`,
        kind: "unreviewed-claim",
      },
    };
  }

  // 2. Oldest supported claim without refutation attempts
  const unrefutedClaim = await db
    .prepare(
      `SELECT e.object_id, e.object_version
       FROM events e
       WHERE e.problem_id = ? AND e.seq <= ?
         AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
         AND EXISTS (
           SELECT 1 FROM evidence ev WHERE ev.problem_id = e.problem_id
             AND ev.bears_on_kind = 'claim' AND ev.bears_on_id = e.object_id
             AND ev.bears_on_version = e.object_version AND ev.direction = 'supports'
         )
         AND NOT EXISTS (
           SELECT 1 FROM evidence ev WHERE ev.problem_id = e.problem_id
             AND ev.bears_on_kind = 'claim' AND ev.bears_on_id = e.object_id
             AND ev.bears_on_version = e.object_version AND ev.direction = 'refutes'
         )
       ORDER BY e.seq ASC
       LIMIT 1`,
    )
    .bind(problemId, cursor)
    .first<{ object_id: string; object_version: number }>();

  if (unrefutedClaim) {
    return {
      active: true,
      objectEventCountInWindow: 0,
      totalEventsInWindow: events.length,
      oldestNeed: {
        ref: `${unrefutedClaim.object_id}@${unrefutedClaim.object_version}`,
        description: `Supported claim ${unrefutedClaim.object_id}@${unrefutedClaim.object_version} has zero recorded refutation attempts.`,
        kind: "unchallenged-support",
      },
    };
  }

  // 3. Oldest open proof gap
  const openGap = await db
    .prepare(
      `SELECT gap_id, statement
       FROM proof_gaps
       WHERE problem_id = ? AND status = 'open'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .bind(problemId)
    .first<{ gap_id: string; statement: string }>();

  if (openGap) {
    return {
      active: true,
      objectEventCountInWindow: 0,
      totalEventsInWindow: events.length,
      oldestNeed: {
        ref: openGap.gap_id,
        description: `Open proof gap ${openGap.gap_id} has no closing proof or deduction.`,
        kind: "unowned-gap",
      },
    };
  }

  // Default oldest need is the problem itself
  return {
    active: true,
    objectEventCountInWindow: 0,
    totalEventsInWindow: events.length,
    oldestNeed: {
      ref: problemId,
      description:
        "No pending object-level needs found; draft a new conjecture or investigation in workshop.",
      kind: "problem",
    },
  };
}

/**
 * Checks if 200+ events have been recorded since the last synthesis digest (Fable §9.4).
 */
export async function checkSynthesisTrigger(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<SynthesisTriggerResult> {
  const lastSynthesis = await db
    .prepare(
      `SELECT seq FROM events
       WHERE problem_id = ? AND type = 'synthesis.published' AND seq <= ?
       ORDER BY seq DESC
       LIMIT 1`,
    )
    .bind(problemId, cursor)
    .first<{ seq: number }>();

  const lastSeq = lastSynthesis?.seq ?? 0;
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) as count FROM events
       WHERE problem_id = ? AND seq > ? AND seq <= ?`,
    )
    .bind(problemId, lastSeq, cursor)
    .first<{ count: number }>();

  const count = countRow?.count ?? 0;
  return {
    needed: count >= SYNTHESIS_EVENT_THRESHOLD,
    eventCountSinceLast: count,
  };
}

/**
 * Checks if the Fellow has an open session on this problem that has been quiet for >= 3 hours.
 * Distinct from the 12h hard auto-close in W4.1.
 */
export async function checkIdleSession(
  db: D1Database,
  problemId: string,
  fellowId: string,
  now: number,
): Promise<IdleSessionResult | null> {
  const sessionRow = await db
    .prepare(
      `SELECT session_id, last_heartbeat_at
       FROM sessions
       WHERE problem_id = ? AND fellow_id = ? AND closed_at IS NULL
       ORDER BY opened_at DESC
       LIMIT 1`,
    )
    .bind(problemId, fellowId)
    .first<{ session_id: string; last_heartbeat_at: string }>();

  if (!sessionRow) return null;

  const heartbeatTime = Date.parse(sessionRow.last_heartbeat_at);
  if (Number.isNaN(heartbeatTime)) return null;

  const quietMs = now - heartbeatTime;
  if (quietMs >= IDLE_CLOSE_MOVE_QUIET_MS) {
    return {
      sessionId: sessionRow.session_id,
      quietMs,
    };
  }

  return null;
}
