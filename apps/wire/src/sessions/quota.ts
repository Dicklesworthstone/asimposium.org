import type { RateLimitBudget } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { sha256Hex } from "../split/policy";

/**
 * Fable §7.10 / A5 promotion rate limit constants.
 * Rate limit is 20 promotions per hour per Fellow per problem.
 */
export const PROMOTION_RATE_LIMIT_PER_HOUR = 20;
export const PROMOTION_RATE_LIMIT_WINDOW_MS = 3_600_000;
export const RESERVATION_EXPIRY_MS = 60_000;

export type QuotaReservationStatus =
  | "reserved"
  | "settled_published"
  | "settled_held"
  | "settled_rejected"
  | "settled_failed"
  | "recovered";

export interface QuotaReservation {
  readonly reservationId: string;
  readonly fellowId: string;
  readonly problemId: string;
  readonly sponsorId: string;
  readonly sessionId: string;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly reservedAt: number;
  readonly expiresAt: number;
  readonly status: QuotaReservationStatus;
}

export type QuotaCheckResult =
  | {
      readonly allowed: true;
      readonly reservation: QuotaReservation;
      readonly budget: RateLimitBudget;
    }
  | {
      readonly allowed: false;
      readonly reason: "RATE_LIMITED";
      readonly dimension: "fellow_problem" | "sponsor";
      readonly retryAfterSeconds: number;
      readonly budget: RateLimitBudget;
    }
  | {
      readonly allowed: false;
      readonly reason: "IN_FLIGHT_CONFLICT";
      readonly retryAfterSeconds: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "IDEMPOTENCY_CONFLICT";
    };

/**
 * Parse and validate configured sponsor promotion rate limit.
 * - undefined, null, or empty string: returns null (unconstrained sponsor dimension; no invented default).
 * - non-negative number: returns floored integer limit (0 means immediately rate-limited).
 * - NaN, negative, non-finite, or invalid: throws an error (fails closed).
 */
export function parseSponsorLimit(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) {
    throw new Error(
      `INVALID_SPONSOR_PROMOTION_RATE_LIMIT: expected non-negative integer, got ${String(raw)}`,
    );
  }
  return Math.floor(n);
}

async function logQuotaDecision(info: {
  readonly route: string;
  readonly fellowId: string;
  readonly problemId: string;
  readonly sponsorId: string;
  readonly decision: "allowed" | "rate_limited" | "conflict";
  readonly durationMs: number;
}): Promise<void> {
  try {
    const fellowHash = (await sha256Hex(info.fellowId)).slice(0, 16);
    const sponsorHash = (await sha256Hex(info.sponsorId)).slice(0, 16);
    console.info("[quota] decision", {
      route: info.route,
      fellow_hash: fellowHash,
      problem_id: info.problemId,
      sponsor_hash: sponsorHash,
      window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
      decision: info.decision,
      duration_ms: info.durationMs,
    });
  } catch {
    // Non-critical logging probe must never fail the request
  }
}

/**
 * Check rate limit and create an atomic reservation before calling paid screening.
 * If quota is exhausted or an in-flight conflict occurs, returns a refusal without
 * creating paid effects.
 */
export async function checkAndReserveQuota(
  db: D1Database,
  params: {
    readonly fellowId: string;
    readonly problemId: string;
    readonly sponsorId: string;
    readonly sessionId: string;
    readonly route: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly now?: number;
    readonly sponsorLimit?: number | null;
  },
): Promise<QuotaCheckResult> {
  const now = params.now ?? Date.now();
  const startTime = Date.now();
  const windowStart = now - PROMOTION_RATE_LIMIT_WINDOW_MS;
  const sponsorLimit = params.sponsorLimit ?? null;

  // 1. Mark expired in-flight reservations as 'recovered', bounded to the requesting fellow.
  // Missing or failed quota storage fails closed (stops paid screening)
  await db
    .prepare(
      `UPDATE public_write_attempt_reservations
          SET status = 'recovered'
        WHERE fellow_id = ?
          AND status = 'reserved'
          AND expires_at <= ?`,
    )
    .bind(params.fellowId, now)
    .run();

  // 2. Count attempts for (fellow_id, problem_id) in rolling 1-hour window.
  // Every attempted reservation in the window consumes capacity; uncertain/lost/expired attempts are never free.
  const fellowAttempts = await db
    .prepare(
      `SELECT COUNT(*) AS attempt_count, MIN(reserved_at) AS oldest_reserved_at
         FROM public_write_attempt_reservations
        WHERE fellow_id = ?
          AND problem_id = ?
          AND reserved_at > ?`,
    )
    .bind(params.fellowId, params.problemId, windowStart)
    .first<{ attempt_count: number; oldest_reserved_at: number | null }>();

  const fellowCount = fellowAttempts?.attempt_count ?? 0;
  const oldestFellowAt = fellowAttempts?.oldest_reserved_at ?? now;

  // 3. Optional sponsor-level rate limit (do not invent a default if not configured)
  let sponsorCount = 0;
  let oldestSponsorAt = now;
  if (sponsorLimit !== null) {
    if (sponsorLimit === 0) {
      await logQuotaDecision({
        route: params.route,
        fellowId: params.fellowId,
        problemId: params.problemId,
        sponsorId: params.sponsorId,
        decision: "rate_limited",
        durationMs: Date.now() - startTime,
      });
      return {
        allowed: false,
        reason: "RATE_LIMITED",
        dimension: "sponsor",
        retryAfterSeconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
        budget: {
          limit: PROMOTION_RATE_LIMIT_PER_HOUR,
          remaining: Math.max(0, PROMOTION_RATE_LIMIT_PER_HOUR - fellowCount),
          window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
          retry_after_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
          sponsor_limit: 0,
          sponsor_remaining: 0,
        },
      };
    }

    const sponsorAttempts = await db
      .prepare(
        `SELECT COUNT(*) AS attempt_count, MIN(reserved_at) AS oldest_reserved_at
           FROM public_write_attempt_reservations
          WHERE sponsor_id = ?
            AND reserved_at > ?`,
      )
      .bind(params.sponsorId, windowStart)
      .first<{ attempt_count: number; oldest_reserved_at: number | null }>();
    sponsorCount = sponsorAttempts?.attempt_count ?? 0;
    oldestSponsorAt = sponsorAttempts?.oldest_reserved_at ?? now;

    if (sponsorCount >= sponsorLimit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldestSponsorAt + PROMOTION_RATE_LIMIT_WINDOW_MS - now) / 1000),
      );
      await logQuotaDecision({
        route: params.route,
        fellowId: params.fellowId,
        problemId: params.problemId,
        sponsorId: params.sponsorId,
        decision: "rate_limited",
        durationMs: Date.now() - startTime,
      });
      return {
        allowed: false,
        reason: "RATE_LIMITED",
        dimension: "sponsor",
        retryAfterSeconds,
        budget: {
          limit: PROMOTION_RATE_LIMIT_PER_HOUR,
          remaining: Math.max(0, PROMOTION_RATE_LIMIT_PER_HOUR - fellowCount),
          window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
          retry_after_seconds: retryAfterSeconds,
          sponsor_limit: sponsorLimit,
          sponsor_remaining: 0,
        },
      };
    }
  }

  // 4. Check for in-flight reservation for this exact (fellow_id, route, idempotency_key)
  const inflight = await db
    .prepare(
      `SELECT reservation_id, request_digest, expires_at
         FROM public_write_attempt_reservations
        WHERE fellow_id = ?
          AND route = ?
          AND idempotency_key = ?
          AND status = 'reserved'
          AND expires_at > ?
        LIMIT 1`,
    )
    .bind(params.fellowId, params.route, params.idempotencyKey, now)
    .first<{ reservation_id: string; request_digest: string; expires_at: number }>();

  if (inflight !== null && inflight !== undefined) {
    // Only the request that inserted this reservation may enter paid screening.
    // Completed results replay before quota admission; an unfinished retry must
    // never turn one charged reservation into arbitrarily many provider calls.
    return { allowed: false, reason: "IN_FLIGHT_CONFLICT", retryAfterSeconds: 1 };
  }

  if (fellowCount >= PROMOTION_RATE_LIMIT_PER_HOUR) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldestFellowAt + PROMOTION_RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    await logQuotaDecision({
      route: params.route,
      fellowId: params.fellowId,
      problemId: params.problemId,
      sponsorId: params.sponsorId,
      decision: "rate_limited",
      durationMs: Date.now() - startTime,
    });
    return {
      allowed: false,
      reason: "RATE_LIMITED",
      dimension: "fellow_problem",
      retryAfterSeconds,
      budget: {
        limit: PROMOTION_RATE_LIMIT_PER_HOUR,
        remaining: 0,
        window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
        retry_after_seconds: retryAfterSeconds,
        sponsor_limit: sponsorLimit,
        sponsor_remaining: sponsorLimit === null ? null : Math.max(0, sponsorLimit - sponsorCount),
      },
    };
  }

  // 5. Atomic reservation insert
  const reservationId = `Q-${crypto.randomUUID()}`;
  const expiresAt = now + RESERVATION_EXPIRY_MS;

  try {
    await db
      .prepare(
        `INSERT INTO public_write_attempt_reservations (
           reservation_id, fellow_id, problem_id, sponsor_id, session_id,
           route, idempotency_key, request_digest, reserved_at, expires_at, sponsor_limit, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
      )
      .bind(
        reservationId,
        params.fellowId,
        params.problemId,
        params.sponsorId,
        params.sessionId,
        params.route,
        params.idempotencyKey,
        params.requestDigest,
        now,
        expiresAt,
        sponsorLimit,
      )
      .run();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("SPONSOR_PROMOTION_RATE_LIMIT_EXCEEDED")) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldestSponsorAt + PROMOTION_RATE_LIMIT_WINDOW_MS - now) / 1000),
      );
      await logQuotaDecision({
        route: params.route,
        fellowId: params.fellowId,
        problemId: params.problemId,
        sponsorId: params.sponsorId,
        decision: "rate_limited",
        durationMs: Date.now() - startTime,
      });
      return {
        allowed: false,
        reason: "RATE_LIMITED",
        dimension: "sponsor",
        retryAfterSeconds,
        budget: {
          limit: PROMOTION_RATE_LIMIT_PER_HOUR,
          remaining: Math.max(0, PROMOTION_RATE_LIMIT_PER_HOUR - (fellowCount + 1)),
          window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
          retry_after_seconds: retryAfterSeconds,
          sponsor_limit: sponsorLimit,
          sponsor_remaining: 0,
        },
      };
    }
    if (msg.includes("PROMOTION_RATE_LIMIT_EXCEEDED")) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldestFellowAt + PROMOTION_RATE_LIMIT_WINDOW_MS - now) / 1000),
      );
      await logQuotaDecision({
        route: params.route,
        fellowId: params.fellowId,
        problemId: params.problemId,
        sponsorId: params.sponsorId,
        decision: "rate_limited",
        durationMs: Date.now() - startTime,
      });
      return {
        allowed: false,
        reason: "RATE_LIMITED",
        dimension: "fellow_problem",
        retryAfterSeconds,
        budget: {
          limit: PROMOTION_RATE_LIMIT_PER_HOUR,
          remaining: 0,
          window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
          retry_after_seconds: retryAfterSeconds,
          sponsor_limit: sponsorLimit,
          sponsor_remaining:
            sponsorLimit === null ? null : Math.max(0, sponsorLimit - sponsorCount),
        },
      };
    }
    if (
      msg.includes("UNIQUE constraint failed") ||
      msg.includes("public_write_reservations_inflight_key_idx")
    ) {
      await logQuotaDecision({
        route: params.route,
        fellowId: params.fellowId,
        problemId: params.problemId,
        sponsorId: params.sponsorId,
        decision: "conflict",
        durationMs: Date.now() - startTime,
      });
      return { allowed: false, reason: "IN_FLIGHT_CONFLICT", retryAfterSeconds: 1 };
    }
    throw error;
  }

  await logQuotaDecision({
    route: params.route,
    fellowId: params.fellowId,
    problemId: params.problemId,
    sponsorId: params.sponsorId,
    decision: "allowed",
    durationMs: Date.now() - startTime,
  });

  const reservation: QuotaReservation = {
    reservationId,
    fellowId: params.fellowId,
    problemId: params.problemId,
    sponsorId: params.sponsorId,
    sessionId: params.sessionId,
    route: params.route,
    idempotencyKey: params.idempotencyKey,
    requestDigest: params.requestDigest,
    reservedAt: now,
    expiresAt,
    status: "reserved",
  };

  const remaining = Math.max(0, PROMOTION_RATE_LIMIT_PER_HOUR - (fellowCount + 1));
  const budget: RateLimitBudget = {
    limit: PROMOTION_RATE_LIMIT_PER_HOUR,
    remaining,
    window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
    sponsor_limit: sponsorLimit,
    sponsor_remaining:
      sponsorLimit === null ? null : Math.max(0, sponsorLimit - (sponsorCount + 1)),
  };

  return { allowed: true, reservation, budget };
}

/**
 * Format a 429 PROMOTION_RATE_LIMITED problem response with rate-limit headers.
 */
export function promotionRateLimitedProblem(decision: {
  readonly retryAfterSeconds: number;
  readonly budget: RateLimitBudget;
  readonly dimension?: "fellow_problem" | "sponsor";
}): Response {
  const isSponsor =
    decision.dimension === "sponsor" &&
    decision.budget.sponsor_limit !== null &&
    decision.budget.sponsor_limit !== undefined;
  const limit = isSponsor
    ? (decision.budget.sponsor_limit ?? decision.budget.limit)
    : decision.budget.limit;
  const remaining = isSponsor
    ? (decision.budget.sponsor_remaining ?? 0)
    : decision.budget.remaining;
  const sponsorPaused = isSponsor && limit === 0;
  const detail = sponsorPaused
    ? "Sponsor promotion limit is configured to zero. Keep using the workshop."
    : isSponsor
      ? `Sponsor promotion rate limit of ${limit} promotions per hour reached across Fellows. Keep using the workshop.`
      : `Promotion rate limit of ${limit} promotions per hour per Fellow per problem reached. Keep using the workshop.`;
  const fixHint = sponsorPaused
    ? "Keep using the workshop (POST /v1/sessions/:id/workshop); ask your sponsor to check the operator-configured promotion limit."
    : isSponsor
      ? "Keep using the workshop (POST /v1/sessions/:id/workshop) until the sponsor promotion window rolls over."
      : "Keep using the workshop (POST /v1/sessions/:id/workshop) until the promotion window rolls over.";

  const response = validatedProblem({
    status: 429,
    code: "PROMOTION_RATE_LIMITED",
    title: "Promotion rate limit reached",
    detail,
    fixHint,
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      retry_after_seconds: decision.retryAfterSeconds,
      limit,
      remaining,
      window_seconds: decision.budget.window_seconds,
      example: {
        type: "claim-draft",
        title: "Continuing investigation in workshop",
        body_md: "Continuing investigation in workshop while awaiting quota window reset.",
        relates_to: [],
      },
    },
  });
  response.headers.set("retry-after", String(decision.retryAfterSeconds));
  response.headers.set("ratelimit-limit", String(limit));
  response.headers.set("ratelimit-remaining", String(remaining));
  response.headers.set("ratelimit-reset", String(decision.retryAfterSeconds));
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export type SettledReservationStatus =
  | "settled_published"
  | "settled_held"
  | "settled_rejected"
  | "settled_failed"
  | "recovered";

/**
 * Settle a reservation.
 */
export async function settleQuotaReservation(
  db: D1Database,
  reservationId: string,
  status: SettledReservationStatus,
  now: number = Date.now(),
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE public_write_attempt_reservations
            SET status = ?, settled_at = ?
          WHERE reservation_id = ? AND status = 'reserved'`,
      )
      .bind(status, now, reservationId)
      .run();
  } catch (error) {
    console.error("[quota] failed to settle reservation", { reservationId, status, error });
  }
}

/**
 * Returns a D1PreparedStatement to settle a reservation as settled_published inside an atomic Krater commit batch.
 */
export function settleQuotaReservationStatement(
  db: D1Database,
  reservationId: string,
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE public_write_attempt_reservations
          SET status = 'settled_published', settled_at = ?
        WHERE reservation_id = ? AND status = 'reserved'`,
    )
    .bind(now, reservationId);
}

/**
 * Query remaining promotion budget for hello/pack.
 */
export async function getRemainingBudget(
  db: D1Database,
  params: {
    readonly fellowId: string;
    readonly problemId?: string | null;
    readonly sponsorId?: string | null;
    readonly now?: number;
    readonly sponsorLimit?: number | null;
  },
): Promise<RateLimitBudget> {
  const now = params.now ?? Date.now();
  const windowStart = now - PROMOTION_RATE_LIMIT_WINDOW_MS;
  const sponsorLimit = params.sponsorLimit ?? null;

  let fellowCount = 0;
  let oldestFellowAt = now;

  if (params.problemId) {
    const fellowAttempts = await db
      .prepare(
        `SELECT COUNT(*) AS attempt_count, MIN(reserved_at) AS oldest_reserved_at
           FROM public_write_attempt_reservations
          WHERE fellow_id = ?
            AND problem_id = ?
            AND reserved_at > ?`,
      )
      .bind(params.fellowId, params.problemId, windowStart)
      .first<{ attempt_count: number; oldest_reserved_at: number | null }>();

    fellowCount = fellowAttempts?.attempt_count ?? 0;
    oldestFellowAt = fellowAttempts?.oldest_reserved_at ?? now;
  }

  let sponsorCount = 0;
  let oldestSponsorAt = now;
  if (sponsorLimit !== null && params.sponsorId) {
    if (sponsorLimit > 0) {
      const sponsorAttempts = await db
        .prepare(
          `SELECT COUNT(*) AS attempt_count, MIN(reserved_at) AS oldest_reserved_at
             FROM public_write_attempt_reservations
            WHERE sponsor_id = ?
              AND reserved_at > ?`,
        )
        .bind(params.sponsorId, windowStart)
        .first<{ attempt_count: number; oldest_reserved_at: number | null }>();
      sponsorCount = sponsorAttempts?.attempt_count ?? 0;
      oldestSponsorAt = sponsorAttempts?.oldest_reserved_at ?? now;
    }
  }

  const remaining = Math.max(0, PROMOTION_RATE_LIMIT_PER_HOUR - fellowCount);
  const sponsorRemaining = sponsorLimit === null ? null : Math.max(0, sponsorLimit - sponsorCount);
  const retryDelay = (oldestAt: number) =>
    Math.max(1, Math.ceil((oldestAt + PROMOTION_RATE_LIMIT_WINDOW_MS - now) / 1000));
  // Both dimensions must admit the write. A configured zero sponsor limit has
  // no time-based recovery; do not invent an expiry for that operator setting.
  const retryAfterSeconds =
    sponsorLimit === 0
      ? undefined
      : Math.max(
          remaining === 0 ? retryDelay(oldestFellowAt) : 0,
          sponsorRemaining === 0 ? retryDelay(oldestSponsorAt) : 0,
        ) || undefined;

  return {
    limit: PROMOTION_RATE_LIMIT_PER_HOUR,
    remaining,
    window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
    ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
    sponsor_limit: sponsorLimit,
    sponsor_remaining: sponsorRemaining,
  };
}
