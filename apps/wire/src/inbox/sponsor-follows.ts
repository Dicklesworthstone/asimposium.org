import {
  SPONSOR_FOLLOW_LIMIT,
  SPONSOR_FOLLOW_PAGE_SIZE,
  SponsorFollowReceiptSchema,
  type SponsorFollowRequest,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content.ts";

export const SPONSOR_FOLLOW_PUBLIC_SQL = `p.status <> 'private-draft'
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
  AND NOT ${hiddenByContentControlSql("p.id", "p.id")}`;

export const SPONSOR_FOLLOW_LIST_SQL = `
  SELECT f.problem_id, f.created_at AS followed_at,
    CASE WHEN ${SPONSOR_FOLLOW_PUBLIC_SQL} THEN p.public_seq END AS cursor
  FROM problem_follows f LEFT JOIN problems p ON p.id = f.problem_id
  WHERE f.principal_id = ? AND f.problem_id > ?
  ORDER BY f.problem_id ASC LIMIT ?`;

export interface SponsorFollowRow {
  problem_id: string;
  followed_at: number;
  cursor: number | null;
}
interface ReceiptRow {
  request_digest: string;
  problem_id: string;
  following: number;
  followed_at: number | null;
}
export class SponsorFollowError extends Error {
  constructor(readonly reason: "conflict" | "missing" | "limit") {
    super("SPONSOR_FOLLOW_" + reason.toUpperCase());
  }
}

export function sponsorFollowReceipt(row: ReceiptRow) {
  if (row.following !== 0 && row.following !== 1)
    throw new Error("SPONSOR_FOLLOW_RECEIPT_INVALID");
  return SponsorFollowReceiptSchema.parse({
    problem_id: row.problem_id,
    following: row.following === 1,
    followed_at: row.followed_at,
  });
}

async function receipt(db: D1Database, sponsor: string, key: string, now: number) {
  return db.prepare(`SELECT request_digest, problem_id, following, followed_at
    FROM sponsor_follow_replays
    WHERE sponsor_id = ? AND idempotency_key = ? AND expires_at > ?`)
    .bind(sponsor, key, now).first<ReceiptRow>();
}

const OWN_RECEIPT_SQL = `EXISTS (SELECT 1 FROM sponsor_follow_replays receipt
  WHERE receipt.sponsor_id = ? AND receipt.idempotency_key = ?
    AND receipt.request_digest = ? AND receipt.claim_token = ?)`;

export const SPONSOR_FOLLOW_CLAIM_SQL = `
  INSERT INTO sponsor_follow_replays
    (sponsor_id, idempotency_key, request_digest, problem_id, following,
     followed_at, created_at, expires_at, claim_token)
  SELECT ?, ?, ?, ?, ?,
    CASE WHEN ? = 1 THEN COALESCE(
      (SELECT created_at FROM problem_follows WHERE principal_id = ? AND problem_id = ?), ?
    ) END, ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ?)
    AND (? = 0 OR EXISTS (
      SELECT 1 FROM problems p WHERE p.id = ? AND ${SPONSOR_FOLLOW_PUBLIC_SQL}
        AND (EXISTS (SELECT 1 FROM problem_follows WHERE principal_id = ? AND problem_id = p.id)
          OR (SELECT COUNT(*) FROM problem_follows WHERE principal_id = ?) < ${SPONSOR_FOLLOW_LIMIT})
    ))
  ON CONFLICT (sponsor_id, idempotency_key) DO NOTHING`;
export const SPONSOR_FOLLOW_INSERT_SQL = `
  INSERT INTO problem_follows (principal_id, problem_id, created_at)
  SELECT sponsor_id, problem_id, followed_at FROM sponsor_follow_replays
  WHERE sponsor_id = ? AND idempotency_key = ? AND request_digest = ?
    AND claim_token = ? AND following = 1
  ON CONFLICT (principal_id, problem_id) DO NOTHING`;
export const SPONSOR_FOLLOW_REMOVE_SQL = `
  DELETE FROM problem_follows WHERE principal_id = ? AND problem_id = ?
    AND ${OWN_RECEIPT_SQL}
    AND EXISTS (SELECT 1 FROM sponsor_follow_replays
      WHERE sponsor_id = ? AND idempotency_key = ? AND following = 0)`;
export const SPONSOR_FOLLOW_ASSERT_SQL = `
  SELECT CASE WHEN NOT ${OWN_RECEIPT_SQL} OR EXISTS (
    SELECT 1 FROM sponsor_follow_replays receipt
    LEFT JOIN problem_follows f
      ON f.principal_id = receipt.sponsor_id AND f.problem_id = receipt.problem_id
    WHERE receipt.sponsor_id = ? AND receipt.idempotency_key = ?
      AND ((receipt.following = 0 AND f.problem_id IS NULL)
        OR (receipt.following = 1 AND f.created_at = receipt.followed_at))
  ) THEN 1 ELSE json_extract('[]', '$[SPONSOR_FOLLOW_NOT_COMMITTED') END`;

/** Receipt ownership, preference mutation and validation share one D1 batch.
 * A different request with the same key never owns mutation statements. A
 * completed replay returns its receipt before consulting today's preference. */
export async function setSponsorFollow(
  db: D1Database,
  sponsor: string,
  command: SponsorFollowRequest,
  key: string,
  now = Date.now(),
) {
  const bytes = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(command)));
  const digest = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  const previous = await receipt(db, sponsor, key, now);
  if (previous) {
    if (previous.request_digest !== digest) throw new SponsorFollowError("conflict");
    return sponsorFollowReceipt(previous);
  }
  const token = crypto.randomUUID();
  const owns = [sponsor, key, digest, token] as const;
  const following = command.following ? 1 : 0;
  await db.batch([
    db.prepare("DELETE FROM sponsor_follow_replays WHERE sponsor_id = ? AND expires_at <= ?")
      .bind(sponsor, now),
    db.prepare(SPONSOR_FOLLOW_CLAIM_SQL).bind(
      sponsor, key, digest, command.problem_id, following,
      following, sponsor, command.problem_id, now, now, now + 86_400_000, token,
      sponsor, following, command.problem_id, sponsor, sponsor,
    ),
    db.prepare(SPONSOR_FOLLOW_INSERT_SQL).bind(...owns),
    db.prepare(SPONSOR_FOLLOW_REMOVE_SQL).bind(
      sponsor, command.problem_id, ...owns, sponsor, key,
    ),
    db.prepare(SPONSOR_FOLLOW_ASSERT_SQL).bind(...owns, sponsor, key),
  ]);
  const saved = await receipt(db, sponsor, key, now);
  if (saved) {
    if (saved.request_digest !== digest) throw new SponsorFollowError("conflict");
    return sponsorFollowReceipt(saved);
  }
  // Unfollow is always permitted for one's own preference, even after a
  // problem becomes hidden/private. An absent target never becomes an oracle.
  if (command.following) {
    const visible = await db.prepare(`SELECT 1 FROM problems p
      WHERE p.id = ? AND ${SPONSOR_FOLLOW_PUBLIC_SQL}`).bind(command.problem_id).first();
    if (!visible) throw new SponsorFollowError("missing");
    const count = await db.prepare("SELECT COUNT(*) AS total FROM problem_follows WHERE principal_id = ?")
      .bind(sponsor).first<{ total: number }>();
    if ((count?.total ?? 0) >= SPONSOR_FOLLOW_LIMIT) throw new SponsorFollowError("limit");
  }
  throw new Error("SPONSOR_FOLLOW_NOT_COMMITTED");
}

export async function listSponsorFollowRows(db: D1Database, sponsor: string, after = "") {
  const rows = await db.prepare(SPONSOR_FOLLOW_LIST_SQL)
    .bind(sponsor, after, SPONSOR_FOLLOW_PAGE_SIZE + 1).all<SponsorFollowRow>();
  return rows.results;
}

/** Recheck current preference and public visibility after activity reads, so
 * concurrent unfollows and whole-problem hides discard the queued preview. */
export async function currentSponsorFollowRows(
  db: D1Database, sponsor: string, problems: readonly string[],
) {
  if (problems.length === 0) return [];
  const rows = await db.prepare(`
    SELECT f.problem_id, f.created_at AS followed_at,
      CASE WHEN ${SPONSOR_FOLLOW_PUBLIC_SQL} THEN p.public_seq END AS cursor
    FROM problem_follows f LEFT JOIN problems p ON p.id = f.problem_id
    WHERE f.principal_id = ? AND f.problem_id IN (SELECT value FROM json_each(?))
    ORDER BY f.problem_id ASC`)
    .bind(sponsor, JSON.stringify(problems)).all<SponsorFollowRow>();
  return rows.results;
}
