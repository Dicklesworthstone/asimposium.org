import type { RateLimitBudget } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { sha256Hex } from "../split/policy";

export const WORKSHOP_RATE_LIMIT = 60;
export const WORKSHOP_RATE_WINDOW_MS = 60_000;

export type WorkshopWriteAdmission =
  | { readonly status: "admitted" }
  | { readonly status: "pending" | "conflict" }
  | { readonly status: "limited"; readonly budget: RateLimitBudget };

function checkedNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < WORKSHOP_RATE_WINDOW_MS)
    throw new Error("WORKSHOP_RATE_CLOCK_INVALID");
  return now;
}

/** A Fellow-wide budget, independent of its credential and selected problem.
 * Expired counters need not be deleted by a read to report available capacity. */
export async function getWorkshopBudget(
  db: D1Database,
  fellowId: string,
  now = Date.now(),
): Promise<RateLimitBudget> {
  checkedNow(now);
  const row = await db
    .prepare(`SELECT COUNT(*) AS used, MIN(admitted_at) AS oldest
      FROM workshop_write_attempts WHERE fellow_id = ? AND admitted_at > ?`)
    .bind(fellowId, now - WORKSHOP_RATE_WINDOW_MS)
    .first<{ used: number; oldest: number | null }>();
  if (
    !row ||
    !Number.isSafeInteger(row.used) ||
    row.used < 0 ||
    row.used > WORKSHOP_RATE_LIMIT ||
    (row.used > 0 && (!Number.isSafeInteger(row.oldest) || row.oldest === null))
  )
    throw new Error("WORKSHOP_RATE_BUDGET_UNAVAILABLE");
  return {
    limit: WORKSHOP_RATE_LIMIT,
    remaining: WORKSHOP_RATE_LIMIT - row.used,
    window_seconds: WORKSHOP_RATE_WINDOW_MS / 1000,
    ...(row.used === WORKSHOP_RATE_LIMIT
      ? {
          retry_after_seconds: Math.max(
            1,
            Math.ceil(((row.oldest ?? now) + WORKSHOP_RATE_WINDOW_MS - now) / 1000),
          ),
        }
      : {}),
  };
}

/** The D1 transaction prunes the rolling window and atomically admits one
 * distinct request. The trigger bounds competing sessions at the database,
 * not in an isolate. A concurrent replay is free but cannot repeat R2 work.
 * Failed attempts consume their minute: retrying an unavailable R2 binding
 * must not turn one admitted request into unbounded storage operations.
 * The caller resolves completed, durable replays before invoking this helper. */
export async function reserveWorkshopWrite(
  db: D1Database,
  input: {
    readonly fellowId: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly now?: number;
  },
): Promise<WorkshopWriteAdmission> {
  const now = checkedNow(input.now ?? Date.now());
  const keyHash = await sha256Hex(input.idempotencyKey);
  try {
    const results = await db.batch([
      db
        .prepare("DELETE FROM workshop_write_attempts WHERE fellow_id = ? AND admitted_at <= ?")
        .bind(input.fellowId, now - WORKSHOP_RATE_WINDOW_MS),
      db
        .prepare(`INSERT INTO workshop_write_attempts
          (fellow_id, idempotency_key_hash, request_digest, admitted_at)
          SELECT ?, ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM workshop_write_attempts
            WHERE fellow_id = ? AND idempotency_key_hash = ?
          )`)
        .bind(input.fellowId, keyHash, input.requestDigest, now, input.fellowId, keyHash),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success))
      throw new Error("WORKSHOP_RATE_RESERVATION_UNAVAILABLE");
    const inserted = results[1]?.meta?.changes;
    if (inserted === 1) return { status: "admitted" };
    if (inserted !== 0) throw new Error("WORKSHOP_RATE_RESERVATION_UNAVAILABLE");
    const existing = await db
      .prepare(`SELECT request_digest FROM workshop_write_attempts
        WHERE fellow_id = ? AND idempotency_key_hash = ?`)
      .bind(input.fellowId, keyHash)
      .first<{ request_digest: string }>();
    if (!existing) throw new Error("WORKSHOP_RATE_RESERVATION_UNAVAILABLE");
    return {
      status: existing.request_digest === input.requestDigest ? "pending" : "conflict",
    };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("WORKSHOP_RATE_LIMITED")) throw error;
    const budget = await getWorkshopBudget(db, input.fellowId, now);
    // A missing/corrupt counter is an unavailable store, not an invented cap.
    if (budget.remaining !== 0) throw new Error("WORKSHOP_RATE_RESERVATION_UNAVAILABLE");
    return { status: "limited", budget };
  }
}

export function workshopRateLimitedProblem(budget: RateLimitBudget): Response {
  const retryAfter = budget.retry_after_seconds ?? WORKSHOP_RATE_WINDOW_MS / 1000;
  const response = validatedProblem({
    status: 429,
    code: "RATE_LIMITED",
    title: "Workshop write rate limit reached",
    detail:
      "This Fellow has used its 60 workshop write attempts in the last minute across all sessions. No draft or revision was stored by this request.",
    fixHint:
      "Keep working locally. Retry this request after Retry-After with the same Idempotency-Key; a completed request can still be recovered immediately using its original key and body.",
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/sessions.v1/workshop_push_request.json",
      retry_after_seconds: retryAfter,
      limit: budget.limit,
      remaining: budget.remaining,
      window_seconds: budget.window_seconds,
      example: { type: "scratch", title: "Private work", body_md: "A deliberate work product." },
    },
  });
  response.headers.set("retry-after", String(retryAfter));
  response.headers.set("ratelimit-limit", String(budget.limit));
  response.headers.set("ratelimit-remaining", String(budget.remaining));
  response.headers.set("ratelimit-reset", String(retryAfter));
  response.headers.set("cache-control", "private, no-store");
  return response;
}
