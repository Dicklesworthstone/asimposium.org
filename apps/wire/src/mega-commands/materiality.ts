import type { NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { loadProofGapMove } from "./gap-moves-service.ts";
import type { loadLedgerMoves, MovePermissions, MoveViewer } from "./ledger-moves.ts";

/**
 * Materiality and Ceremony Guard (Fable §9.6, bead asimposiumorg-z8y).
 *
 * Events are classed:
 * - object-level: claims (claim.created, claim.revised), evidence (evidence.created),
 *   reviews (review.created), hypothesis kills (hypothesis.killed),
 *   substantive dead ends (dead_end.recorded without low-substance flag),
 *   problem admission (problem.admitted), and statement work ONLY during sharpening.
 * - process-level: post-publish statement revisions, syntheses (synthesis.created),
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

    case "synthesis.created":
    case "object.retracted":
    case "directive.sent":
    case "directive.disclosure-recorded":
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
  readonly degraded: boolean;
  /** The existing scientific request, with its exact pins and permission checks.
   * A focus recommendation must not manufacture another write contract. */
  readonly selectedMove: NextMoveCandidate | null;
  readonly oldestNeed: {
    readonly ref: string;
    readonly description: string;
    readonly kind: "unreviewed-claim" | "unchallenged-support" | "review-need" | "unowned-gap";
  } | null;
}

export interface CeremonyMoveContext {
  readonly viewer: MoveViewer;
  readonly permissions: MovePermissions;
  readonly now: number;
}

export interface CeremonyNeedReaders {
  readonly claims: (
    db: D1Database,
    problemId: string,
    viewer: MoveViewer,
    permissions: MovePermissions,
    cursor: number,
  ) => ReturnType<typeof loadLedgerMoves>;
  readonly gap: typeof loadProofGapMove;
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
  context?: CeremonyMoveContext,
  readers?: CeremonyNeedReaders,
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
      degraded: false,
      selectedMove: null,
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
      degraded: false,
      selectedMove: null,
      oldestNeed: null,
    };
  }

  const result: CeremonyBreakerResult = {
    active: true,
    objectEventCountInWindow: 0,
    totalEventsInWindow: events.length,
    degraded: false,
    selectedMove: null,
    oldestNeed: null,
  };
  // A process-only window is not evidence that any particular scientific
  // object is still available, current, unfinished or reviewable by this Fellow.
  // Reuse the bounded scientific readers and their exact-version history,
  // content controls, withdrawal rules and authenticated reviewer exclusions.
  if (!context || !readers) return { ...result, degraded: true };
  const queue = await readers.claims(db, problemId, context.viewer, context.permissions, cursor);
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const oldest = [...queue.items]
    .sort(
      (left, right) =>
        compare(left.created_at, right.created_at) || compare(left.claim_id, right.claim_id),
    )
    .find((item) =>
      queue.moves.some(
        (move) =>
          move.refs[0] === problemId &&
          move.refs[1] === `${item.claim_id}@${item.version}` &&
          move.move === (item.need === "falsification-attempt" ? "add-refuter" : "review"),
      ),
    );
  if (oldest) {
    const target = `${oldest.claim_id}@${oldest.version}`;
    const move = queue.moves.find(
      (candidate) => candidate.refs[0] === problemId && candidate.refs[1] === target,
    );
    if (!move) throw new Error("CEREMONY_NEED_UNAVAILABLE");
    return {
      ...result,
      degraded: queue.degraded,
      selectedMove: move,
      oldestNeed: {
        ref: target,
        description: move.why,
        kind:
          oldest.need === "independent-review"
            ? "unreviewed-claim"
            : oldest.need === "falsification-attempt"
              ? "unchallenged-support"
              : "review-need",
      },
    };
  }
  if (
    !context.permissions.session_open ||
    !context.permissions.promote ||
    !["active", "dormant", "under-result-review"].includes(problemStatus)
  )
    return { ...result, degraded: queue.degraded };

  const gap = await readers.gap(db, problemId, cursor, context.now);
  const target = gap.move?.refs[1];
  return {
    ...result,
    degraded: queue.degraded || gap.degraded,
    selectedMove: gap.move,
    oldestNeed:
      gap.move && target ? { ref: target, description: gap.move.why, kind: "unowned-gap" } : null,
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
       WHERE problem_id = ? AND type = 'synthesis.created' AND seq <= ?
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
