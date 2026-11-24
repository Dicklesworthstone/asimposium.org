import type { RateLimitBudget } from "@asimposium/contracts";
import { INTEGRITY_CASES_SCHEMA_ID } from "@asimposium/contracts/integrity-cases";
import type { D1Database } from "@cloudflare/workers-types";
import { COMMENTARY_RATE_LIMIT_PER_MINUTE } from "../commentary/service.ts";
import { validatedProblem } from "../http/envelope.ts";

// Reuse the established human-write cadence. Migration 0156 applies the same
// ceiling atomically to accepted case actions across this actor's cases.
export const INTEGRITY_WRITE_LIMIT = COMMENTARY_RATE_LIMIT_PER_MINUTE;
export const INTEGRITY_WRITE_WINDOW_MS = 60_000;

export class IntegrityWriteRateLimitedError extends Error {
  constructor(readonly budget: RateLimitBudget) {
    super("INTEGRITY_WRITE_RATE_LIMITED");
    this.name = "IntegrityWriteRateLimitedError";
  }
}

export async function integrityWriteBudget(
  db: D1Database,
  actorClass: "sponsor" | "operator",
  actorId: string,
  now = Date.now(),
): Promise<RateLimitBudget> {
  if (!Number.isSafeInteger(now) || now < INTEGRITY_WRITE_WINDOW_MS)
    throw new Error("INTEGRITY_RATE_CLOCK_INVALID");
  const row = await db
    .prepare(`SELECT COUNT(*) AS used, MIN(created_at) AS oldest FROM (
      SELECT created_at FROM integrity_case_actions
      WHERE actor_class = ? AND actor_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT ?
    )`)
    .bind(
      actorClass,
      actorId,
      new Date(now - INTEGRITY_WRITE_WINDOW_MS).toISOString(),
      INTEGRITY_WRITE_LIMIT,
    )
    .first<{ used: number; oldest: string | null }>();
  const oldest = row?.oldest === null || row?.oldest === undefined ? null : Date.parse(row.oldest);
  if (
    !row ||
    !Number.isSafeInteger(row.used) ||
    row.used < 0 ||
    row.used > INTEGRITY_WRITE_LIMIT ||
    (row.used > 0 && (oldest === null || !Number.isFinite(oldest) || oldest > now))
  )
    throw new Error("INTEGRITY_RATE_BUDGET_UNAVAILABLE");
  return {
    limit: INTEGRITY_WRITE_LIMIT,
    remaining: INTEGRITY_WRITE_LIMIT - row.used,
    window_seconds: INTEGRITY_WRITE_WINDOW_MS / 1000,
    ...(row.used === INTEGRITY_WRITE_LIMIT
      ? {
          retry_after_seconds: Math.max(
            1,
            Math.ceil(((oldest ?? now) + INTEGRITY_WRITE_WINDOW_MS - now) / 1000),
          ),
        }
      : {}),
  };
}

export function integrityWriteRateLimitedProblem(budget: RateLimitBudget): Response {
  const retryAfter = budget.retry_after_seconds ?? INTEGRITY_WRITE_WINDOW_MS / 1000;
  return validatedProblem({
    status: 429,
    code: "RATE_LIMITED",
    title: "Integrity review write rate limit reached",
    detail: `This human principal has used its ${INTEGRITY_WRITE_LIMIT} accepted integrity actions in the last minute across all cases. This request added no action or decision.`,
    fixHint:
      "Wait for Retry-After before submitting a new action. Private case reads and exact retries of accepted commands remain available; keep the original Idempotency-Key and intent for an uncertain write.",
    rule: "A5",
    headers: {
      "retry-after": String(retryAfter),
      "ratelimit-limit": String(budget.limit),
      "ratelimit-remaining": String(budget.remaining),
      "ratelimit-reset": String(retryAfter),
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    },
    extensions: {
      schema: INTEGRITY_CASES_SCHEMA_ID,
      limit: budget.limit,
      remaining: budget.remaining,
      window_seconds: budget.window_seconds,
      retry_after_seconds: retryAfter,
      example: { case_id: `IC-${"0".repeat(26)}`, after_revision: 0, limit: 20 },
    },
  });
}
