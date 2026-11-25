/**
 * Graduated screening posture (Fable §9.1 L1): three content-policy refusals
 * of distinct bytes in a rolling window flip a Fellow to quarantine-first on
 * every public write until its sponsor intervenes. Quarantine-first never
 * refuses: it holds otherwise-passing writes as private review cases, so the
 * work waits for a human instead of publishing on a model's word.
 *
 * Provider outages never count (the content was not judged), retries of the
 * same bytes count once, and a sponsor's or operator's clearance resets the
 * count; every clearance is attributed and append-only.
 */

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { inboxNoticeStatement } from "../inbox/notice-write.ts";
import { screeningCaseReleasedSql } from "./screening-release.ts";
import { mintModerationId } from "./store";

export const POSTURE_REFUSAL_THRESHOLD = 3;
export const POSTURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const POSTURE_CHANGED_MARKER = "SCREENING_POSTURE_CHANGED";

export function isScreeningPostureChangedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes(POSTURE_CHANGED_MARKER) ||
      (error.cause instanceof Error && isScreeningPostureChangedError(error.cause)))
  );
}

export class PostureClearanceRefusedError extends Error {
  constructor() {
    super("The Fellow's sponsorship or active screening posture changed before clearance.");
    this.name = "PostureClearanceRefusedError";
  }
}

export interface PostureState {
  readonly quarantineFirst: boolean;
  readonly refusalsInWindow: number;
  readonly since: string | null;
}

/** A refused envelope counts once for this Fellow, even if the provider later
 * changes its verdict. Retain historical rows for the audit trail, but derive
 * the first occurrence before applying clearance or time windows so an old
 * retry cannot become a fresh refusal. The expression is code-owned SQL. */
function unclearedDistinctRefusalsSql(fellowId: string): string {
  return `SELECT r.input_digest, MIN(r.created_at) AS created_at
    FROM screening_refusals r WHERE r.fellow_id = ${fellowId}
    GROUP BY r.input_digest
    HAVING MIN(r.created_at) > COALESCE(
      (SELECT MAX(c.created_at) FROM screening_posture_clearances c
        WHERE c.fellow_id = r.fellow_id), '')`;
}

/** The rolling window decides when posture engages, not when it expires.
 * Find a threshold-sized cluster after the last clearance, even when all of
 * its refusals have since aged out. LAG examines consecutive refusals once;
 * a lifetime total would incorrectly quarantine sparse historical refusals.
 * ISO millisecond strings preserve the strict seven-day boundary without
 * floating-point timestamp subtraction. The expression is code-owned SQL. */
function engagedPostureSinceSql(fellowId: string): string {
  return `SELECT MIN(cluster_start) FROM (
    SELECT r.created_at AS cluster_end,
      LAG(r.created_at, ${POSTURE_REFUSAL_THRESHOLD - 1}) OVER (
        ORDER BY r.created_at, r.input_digest) AS cluster_start
    FROM (${unclearedDistinctRefusalsSql(fellowId)}) r
  ) WHERE cluster_start > strftime('%Y-%m-%dT%H:%M:%fZ', cluster_end,
    '-${POSTURE_WINDOW_MS / 1000} seconds')`;
}

/** Keep recent refusal counts separate from the latched publication posture. */
const COUNTING_SQL = `
  SELECT COUNT(*) AS n, MIN(r.created_at) AS since,
    (${engagedPostureSinceSql("?1")}) AS engaged_since
    FROM (${unclearedDistinctRefusalsSql("?1")}) r
   WHERE r.created_at > ?2`;

function windowStart(now = Date.now()): string {
  return new Date(now - POSTURE_WINDOW_MS).toISOString();
}

export async function postureOf(db: D1Database, fellowId: string): Promise<PostureState> {
  const row = await db
    .prepare(COUNTING_SQL)
    .bind(fellowId, windowStart())
    .first<{ n: number; since: string | null; engaged_since: string | null }>();
  // An aggregate always returns one row, even for an author with no refusals.
  // Missing or malformed state cannot be interpreted as permission to publish.
  if (
    row === null ||
    !Number.isSafeInteger(row.n) ||
    row.n < 0 ||
    (row.n > 0 && typeof row.since !== "string") ||
    (row.engaged_since !== null && typeof row.engaged_since !== "string")
  ) {
    throw new Error("SCREENING_POSTURE_UNAVAILABLE");
  }
  const count = row.n;
  return {
    quarantineFirst: row.engaged_since !== null,
    refusalsInWindow: count,
    since: row.engaged_since ?? row.since,
  };
}

/**
 * A passing screen does not grant lasting publication authority. Recheck the
 * author's posture in the same D1 transaction as its public event, projection
 * and replay receipt. A losing write with no event is a no-op. A reviewed
 * release is an exception only for the exact durable case and context; a
 * caller's claimed release cannot bypass the posture.
 */
export function screeningPostureGuardStatement(
  db: D1Database,
  input: {
    readonly eventId: string;
    readonly problemId: string;
    readonly fellowId: string;
    readonly inputDigest: string;
    readonly contextDigest: string;
    readonly reviewCaseId?: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = ?1)
        OR (CASE WHEN ?3 IS NULL THEN
          (${engagedPostureSinceSql("?2")}) IS NULL
        ELSE EXISTS (SELECT 1 FROM screening_cases c
          WHERE c.case_id = ?3 AND ${screeningCaseReleasedSql("c")}
            AND c.fellow_id = ?2 AND c.problem_id = ?4
            AND c.input_digest = ?5 AND c.context_digest = ?6) END)
        THEN 1 ELSE json_extract('[]', '$[${POSTURE_CHANGED_MARKER}]') END`,
    )
    .bind(
      input.eventId,
      input.fellowId,
      input.reviewCaseId ?? null,
      input.problemId,
      input.inputDigest,
      input.contextDigest,
    );
}

export interface RefusalInput {
  readonly fellowId: string;
  readonly sponsorId: string;
  readonly problemId: string;
  readonly outcome: "reject" | "quarantine";
  readonly coarseCategory: string;
  readonly inputDigest: string;
}

/**
 * Build the atomic D1 statements for recording one content refusal (and its
 * threshold-crossing Fellow notice). Returned as statements so callers like
 * `recordRejectedScreeningCase` can commit the refusal in the exact same D1
 * batch as the durable `screening_cases` row. Idempotent per (Fellow, bytes),
 * across outcomes. When this refusal is the one that crosses the threshold,
 * the Fellow is told privately (coarse, no detector detail) that its writes
 * now wait for review.
 */
export async function recordRefusalStatements(
  db: D1Database,
  input: RefusalInput,
  now = Date.now(),
): Promise<D1PreparedStatement[]> {
  if (input.coarseCategory === "provider-unavailable") return [];
  // An engaged posture already holds every write; recording more refusals
  // would only let the count or its expiry reveal which writes the screen
  // refused (asimposiumorg-ij2e).
  if ((await postureOf(db, input.fellowId)).quarantineFirst) return [];
  const refusalId = mintModerationId("SR");
  return [
    db
      .prepare(
        `INSERT INTO screening_refusals
         (refusal_id, fellow_id, sponsor_id, problem_id, outcome, coarse_category, input_digest, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE (${engagedPostureSinceSql("?2")}) IS NULL
         AND NOT EXISTS (SELECT 1 FROM screening_refusals prior
           WHERE prior.fellow_id = ?2 AND prior.input_digest = ?7)
       ON CONFLICT (fellow_id, input_digest, outcome) DO NOTHING
       RETURNING refusal_id`,
      )
      .bind(
        refusalId,
        input.fellowId,
        input.sponsorId,
        input.problemId,
        input.outcome,
        input.coarseCategory,
        input.inputDigest,
        new Date(now).toISOString(),
      ),
    // Test the threshold while holding the same transaction as the refusal.
    // Concurrent producers cannot all observe a later count and miss the
    // transition, or keep adding refused verdicts after the posture engages.
    // A delivery failure rolls back the triggering refusal for a safe retry.
    await inboxNoticeStatement(
      db,
      {
        fellowId: input.fellowId,
        problemId: input.problemId,
        noticeType: "moderation_outcome",
        title: "Your public writes now wait for review",
        detail:
          "After repeated screening refusals, every public write you make is held for trained review before it publishes. Nothing is lost: held writes keep their review cases. Your sponsor can review and clear this posture from the console.",
        causedByEventId: refusalId,
        targetId: input.fellowId,
        createdAt: now,
      },
      {
        sql: `EXISTS (SELECT 1 FROM screening_refusals WHERE refusal_id = ? AND fellow_id = ?)
          AND (${engagedPostureSinceSql("?")}) IS NOT NULL`,
        bindings: [refusalId, input.fellowId, input.fellowId],
      },
    ),
  ];
}

/**
 * Record one content refusal. Idempotent per (Fellow, bytes, outcome). When
 * this refusal is the one that crosses the threshold, the Fellow is told
 * privately (coarse, no detector detail) that its writes now wait for review.
 */
export async function recordRefusal(db: D1Database, input: RefusalInput): Promise<void> {
  const statements = await recordRefusalStatements(db, input);
  if (statements.length === 0) return;
  await db.batch(statements);
}

export async function clearPosture(
  db: D1Database,
  input: {
    readonly fellowId: string;
    readonly clearedByClass: "sponsor" | "operator";
    readonly clearedBy: string;
    readonly reason: string;
  },
): Promise<{ readonly clearanceId: string; readonly clearedAt: string }> {
  const clearanceId = mintModerationId("PC");
  // A clearance must sort after every refusal it clears; ISO timestamps at
  // millisecond resolution can tie with a refusal written the same instant.
  const clearedAt = new Date(Date.now() + 1).toISOString();
  const cleared = await db
    .prepare(
      `INSERT INTO screening_posture_clearances
         (clearance_id, fellow_id, cleared_by_class, cleared_by, reason, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE (?3 = 'operator' OR EXISTS (
         SELECT 1 FROM enrollment_fellows f WHERE f.fellow_id = ?2 AND f.sponsor_id = ?4))
         AND (${engagedPostureSinceSql("?2")}) IS NOT NULL
       RETURNING clearance_id, created_at`,
    )
    .bind(
      clearanceId,
      input.fellowId,
      input.clearedByClass,
      input.clearedBy,
      input.reason,
      clearedAt,
    )
    .first<{ clearance_id: string; created_at: string }>();
  if (cleared === null) throw new PostureClearanceRefusedError();
  return { clearanceId: cleared.clearance_id, clearedAt: cleared.created_at };
}

export interface SponsorPostureRow {
  readonly fellow_id: string;
  readonly name: string;
  readonly quarantine_first: boolean;
  readonly since: string | null;
}

/** Recent refusals and every latched posture remain visible to the current sponsor. */
export async function sponsorPostures(
  db: D1Database,
  sponsorId: string,
): Promise<SponsorPostureRow[]> {
  const fellows = await db
    .prepare(
      `WITH postures AS MATERIALIZED (
        SELECT f.fellow_id, f.name,
          (${engagedPostureSinceSql("f.fellow_id")}) AS engaged_since,
          (SELECT MIN(r.created_at) FROM (${unclearedDistinctRefusalsSql("f.fellow_id")}) r
            WHERE r.created_at > ?2) AS recent_since
        FROM enrollment_fellows f WHERE f.sponsor_id = ?1
      ) SELECT fellow_id, name, engaged_since, recent_since FROM postures
        WHERE engaged_since IS NOT NULL OR recent_since IS NOT NULL
        ORDER BY fellow_id
        LIMIT 100`,
    )
    .bind(sponsorId, windowStart())
    .all<{
      fellow_id: string;
      name: string;
      engaged_since: string | null;
      recent_since: string | null;
    }>();
  return (fellows.results ?? []).map((fellow) => {
    if (
      (fellow.engaged_since !== null && typeof fellow.engaged_since !== "string") ||
      (fellow.recent_since !== null && typeof fellow.recent_since !== "string")
    )
      throw new Error("SCREENING_POSTURE_UNAVAILABLE");
    return {
      fellow_id: fellow.fellow_id,
      name: fellow.name,
      quarantine_first: fellow.engaged_since !== null,
      since: fellow.engaged_since ?? fellow.recent_since,
    };
  });
}

/** Whether `sponsorId` currently sponsors `fellowId`. */
export async function sponsorOwnsFellow(
  db: D1Database,
  sponsorId: string,
  fellowId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS owned FROM enrollment_fellows WHERE fellow_id = ? AND sponsor_id = ?")
    .bind(fellowId, sponsorId)
    .first<{ owned: number }>();
  return row !== null;
}
