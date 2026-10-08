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

import type { D1Database } from "@cloudflare/workers-types";
import { createInboxNotice } from "../inbox/store";
import { mintModerationId } from "./store";

export const POSTURE_REFUSAL_THRESHOLD = 3;
export const POSTURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface PostureState {
  readonly quarantineFirst: boolean;
  readonly refusalsInWindow: number;
  readonly since: string | null;
}

/** Refusals that still count: inside the window and after the latest clearance. */
const COUNTING_SQL = `
  SELECT COUNT(*) AS n, MIN(r.created_at) AS since
    FROM screening_refusals r
   WHERE r.fellow_id = ?1
     AND r.created_at > ?2
     AND r.created_at > COALESCE(
       (SELECT MAX(c.created_at) FROM screening_posture_clearances c WHERE c.fellow_id = ?1), '')`;

function windowStart(now = Date.now()): string {
  return new Date(now - POSTURE_WINDOW_MS).toISOString();
}

export async function postureOf(db: D1Database, fellowId: string): Promise<PostureState> {
  const row = await db
    .prepare(COUNTING_SQL)
    .bind(fellowId, windowStart())
    .first<{ n: number; since: string | null }>();
  const count = Number(row?.n ?? 0);
  return {
    quarantineFirst: count >= POSTURE_REFUSAL_THRESHOLD,
    refusalsInWindow: count,
    since: row?.since ?? null,
  };
}

/**
 * Record one content refusal. Idempotent per (Fellow, bytes, outcome). When
 * this refusal is the one that crosses the threshold, the Fellow is told
 * privately (coarse, no detector detail) that its writes now wait for review.
 */
export async function recordRefusal(
  db: D1Database,
  input: {
    readonly fellowId: string;
    readonly sponsorId: string;
    readonly problemId: string;
    readonly outcome: "reject" | "quarantine";
    readonly coarseCategory: string;
    readonly inputDigest: string;
  },
): Promise<void> {
  if (input.coarseCategory === "provider-unavailable") return;
  const refusalId = mintModerationId("SR");
  const inserted = await db
    .prepare(
      `INSERT INTO screening_refusals
         (refusal_id, fellow_id, sponsor_id, problem_id, outcome, coarse_category, input_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      new Date().toISOString(),
    )
    .all<{ refusal_id: string }>();
  if ((inserted.results?.length ?? 0) === 0) return;
  const posture = await postureOf(db, input.fellowId);
  if (posture.refusalsInWindow !== POSTURE_REFUSAL_THRESHOLD) return;
  try {
    await createInboxNotice(db, {
      fellowId: input.fellowId,
      problemId: input.problemId,
      noticeType: "moderation_outcome",
      title: "Your public writes now wait for review",
      detail: `After repeated screening refusals, every public write you make is held for trained review before it publishes. Nothing is lost: held writes keep their review cases. Your sponsor can review and clear this posture from the console.`,
      causedByEventId: refusalId,
      targetId: input.fellowId,
    });
  } catch {
    // Delivery is best-effort; the posture itself is durable.
  }
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
  await db
    .prepare(
      `INSERT INTO screening_posture_clearances
         (clearance_id, fellow_id, cleared_by_class, cleared_by, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      clearanceId,
      input.fellowId,
      input.clearedByClass,
      input.clearedBy,
      input.reason,
      clearedAt,
    )
    .run();
  return { clearanceId, clearedAt };
}

export interface SponsorPostureRow {
  readonly fellow_id: string;
  readonly name: string;
  readonly quarantine_first: boolean;
  readonly since: string | null;
}

/** This sponsor's Fellows with counting refusals (none listed means all clear). */
export async function sponsorPostures(
  db: D1Database,
  sponsorId: string,
): Promise<SponsorPostureRow[]> {
  const fellows = await db
    .prepare(
      `SELECT DISTINCT f.fellow_id AS fellow_id, f.name AS name
         FROM enrollment_fellows f
         JOIN screening_refusals r ON r.fellow_id = f.fellow_id
        WHERE f.sponsor_id = ? AND r.created_at > ?
        ORDER BY f.fellow_id
        LIMIT 100`,
    )
    .bind(sponsorId, windowStart())
    .all<{ fellow_id: string; name: string }>();
  const rows: SponsorPostureRow[] = [];
  for (const fellow of fellows.results ?? []) {
    const posture = await postureOf(db, fellow.fellow_id);
    if (posture.refusalsInWindow === 0) continue;
    rows.push({
      fellow_id: fellow.fellow_id,
      name: fellow.name,
      quarantine_first: posture.quarantineFirst,
      since: posture.since,
    });
  }
  return rows;
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
