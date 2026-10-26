import { MAX_BATCH_MEMBERS, type RateLimitBudget } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { readPromotionPolicy } from "../moderation/slow-mode";
import { sha256Hex } from "../split/policy";

/**
 * Fable §7.10 / A5 promotion rate limit constants.
 * Default ceiling is 20 promotions per hour per Fellow per problem.
 * An expiring, audited problem control may temporarily tighten that ceiling.
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

export type QuotaBatchCheckResult =
  | Extract<QuotaCheckResult, { readonly allowed: false }>
  | {
      readonly allowed: true;
      readonly reservations: readonly QuotaReservation[];
      readonly budget: RateLimitBudget;
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

interface BudgetQuery {
  readonly fellowId: string;
  readonly problemId?: string | null;
  readonly sponsorId?: string | null;
  readonly now: number;
  readonly sponsorLimit?: number | null;
}

/** Earliest recovery for the whole requested group. Tightening a cap below
 * existing usage requires more than the oldest attempt to leave the window.
 * A temporary cap can also recover on expiry, subject to the default ceiling. */
async function quotaRetryDelay(
  db: D1Database,
  params: BudgetQuery,
  count: number,
  dimension: "fellow_problem" | "sponsor",
  limit: number,
  slowModeExpiresAt?: string,
): Promise<number> {
  const condition =
    dimension === "sponsor"
      ? "sponsor_id = ? AND reserved_at > ?"
      : "fellow_id = ? AND problem_id = ? AND reserved_at > ?";
  const values =
    dimension === "sponsor"
      ? [params.sponsorId ?? "", params.now - PROMOTION_RATE_LIMIT_WINDOW_MS]
      : [params.fellowId, params.problemId ?? "", params.now - PROMOTION_RATE_LIMIT_WINDOW_MS];
  const recoveryAt = async (capacity: number): Promise<number> => {
    if (count > capacity) return Number.POSITIVE_INFINITY;
    // Count and the required expiry share one database snapshot. Only the
    // indexed timestamp is returned; no attempt history leaves storage.
    const row = await db
      .prepare(`SELECT CASE WHEN COUNT(*) + ? <= ? THEN ? ELSE (
      SELECT reserved_at + ? FROM public_write_attempt_reservations
      WHERE ${condition} ORDER BY reserved_at, reservation_id LIMIT 1
      OFFSET (SELECT MAX(0, COUNT(*) + ? - ? - 1)
        FROM public_write_attempt_reservations WHERE ${condition})
    ) END AS available_at FROM public_write_attempt_reservations WHERE ${condition}`)
      .bind(
        count,
        capacity,
        params.now,
        PROMOTION_RATE_LIMIT_WINDOW_MS,
        ...values,
        count,
        capacity,
        ...values,
        ...values,
      )
      .first<{ available_at: number | null }>();
    return row?.available_at ?? params.now + PROMOTION_RATE_LIMIT_WINDOW_MS;
  };
  let availableAt = await recoveryAt(limit);
  if (dimension === "fellow_problem" && slowModeExpiresAt !== undefined) {
    availableAt = Math.min(
      availableAt,
      Math.max(Date.parse(slowModeExpiresAt), await recoveryAt(PROMOTION_RATE_LIMIT_PER_HOUR)),
    );
  }
  return Number.isFinite(availableAt)
    ? Math.max(1, Math.ceil((availableAt - params.now) / 1000))
    : PROMOTION_RATE_LIMIT_WINDOW_MS / 1000;
}

async function quotaRefusal(
  db: D1Database,
  params: BudgetQuery,
  count: number,
  budget: RateLimitBudget,
  dimension: "fellow_problem" | "sponsor",
): Promise<Extract<QuotaCheckResult, { reason: "RATE_LIMITED" }>> {
  const delays: number[] = [];
  if (budget.remaining < count || dimension === "fellow_problem") {
    delays.push(
      await quotaRetryDelay(
        db,
        params,
        count,
        "fellow_problem",
        budget.limit,
        budget.slow_mode?.expires_at,
      ),
    );
  }
  if (
    budget.sponsor_remaining !== null &&
    budget.sponsor_remaining !== undefined &&
    (budget.sponsor_remaining < count || dimension === "sponsor")
  ) {
    delays.push(await quotaRetryDelay(db, params, count, "sponsor", budget.sponsor_limit ?? 0));
  }
  const retryAfterSeconds = Math.max(1, ...delays);
  return {
    allowed: false,
    reason: "RATE_LIMITED",
    dimension,
    retryAfterSeconds,
    budget: { ...budget, retry_after_seconds: retryAfterSeconds },
  };
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
  const sponsorLimit = parseSponsorLimit(params.sponsorLimit);
  const budgetParams = { ...params, now, sponsorLimit };
  const refuse = async (dimension: "fellow_problem" | "sponsor", budget: RateLimitBudget) => {
    await logQuotaDecision({
      route: params.route,
      fellowId: params.fellowId,
      problemId: params.problemId,
      sponsorId: params.sponsorId,
      decision: "rate_limited",
      durationMs: Date.now() - startTime,
    });
    return quotaRefusal(db, budgetParams, 1, budget, dimension);
  };

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

  // 2. Every attempted reservation consumes capacity, including uncertain,
  // lost or recovered attempts. Read the same policy exposed by hello/pack.
  const initialBudget = await getRemainingBudget(db, budgetParams);
  if (initialBudget.sponsor_remaining === 0) return refuse("sponsor", initialBudget);

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

  if (initialBudget.remaining === 0) return refuse("fellow_problem", initialBudget);

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
      return refuse("sponsor", await getRemainingBudget(db, budgetParams));
    }
    if (msg.includes("PROMOTION_RATE_LIMIT_EXCEEDED")) {
      return refuse("fellow_problem", await getRemainingBudget(db, budgetParams));
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

  const budget = await getRemainingBudget(db, budgetParams);

  return { allowed: true, reservation, budget };
}

/** Reserve every member before any paid screening. Admission is one D1
 * transaction: a quota race or an in-flight key on a later member rolls back
 * the entire group, including expired-reservation recovery. */
export async function checkAndReserveQuotaBatch(
  db: D1Database,
  params: {
    readonly fellowId: string;
    readonly problemId: string;
    readonly sponsorId: string;
    readonly sessionId: string;
    readonly members: readonly {
      readonly route: "promote" | "revise" | "hypotheses" | "evidence" | "review" | "dead-ends";
      readonly idempotencyKey: string;
      readonly requestDigest: string;
    }[];
    readonly now?: number;
    readonly sponsorLimit?: number | null;
  },
): Promise<QuotaBatchCheckResult> {
  const count = params.members.length;
  if (count < 1 || count > MAX_BATCH_MEMBERS) {
    throw new Error("INVALID_QUOTA_BATCH: member count is outside the supported bound");
  }
  const keys = new Set(
    params.members.map((member) => JSON.stringify([member.route, member.idempotencyKey])),
  );
  if (keys.size !== count) {
    throw new Error("INVALID_QUOTA_BATCH: duplicate in-flight member key");
  }
  const now = params.now ?? Date.now();
  const startTime = Date.now();
  const sponsorLimit = parseSponsorLimit(params.sponsorLimit);
  const budgetParams = { ...params, now, sponsorLimit };
  const log = (decision: "allowed" | "rate_limited" | "conflict") =>
    logQuotaDecision({
      route: "events:batch",
      fellowId: params.fellowId,
      problemId: params.problemId,
      sponsorId: params.sponsorId,
      decision,
      durationMs: Date.now() - startTime,
    });
  const rateLimited = async (
    budget: RateLimitBudget,
    dimension: "fellow_problem" | "sponsor",
  ): Promise<QuotaBatchCheckResult> => {
    await log("rate_limited");
    return quotaRefusal(db, budgetParams, count, budget, dimension);
  };
  const initialBudget = await getRemainingBudget(db, budgetParams);
  if (
    initialBudget.sponsor_remaining !== null &&
    initialBudget.sponsor_remaining !== undefined &&
    initialBudget.sponsor_remaining < count
  )
    return rateLimited(initialBudget, "sponsor");
  if (initialBudget.remaining < count) return rateLimited(initialBudget, "fellow_problem");

  const reservations: QuotaReservation[] = params.members.map((member) => ({
    reservationId: `Q-${crypto.randomUUID()}`,
    fellowId: params.fellowId,
    problemId: params.problemId,
    sponsorId: params.sponsorId,
    sessionId: params.sessionId,
    ...member,
    reservedAt: now,
    expiresAt: now + RESERVATION_EXPIRY_MS,
    status: "reserved",
  }));
  try {
    await db.batch([
      db
        .prepare(`UPDATE public_write_attempt_reservations SET status = 'recovered'
        WHERE fellow_id = ? AND status = 'reserved' AND expires_at <= ?`)
        .bind(params.fellowId, now),
      ...reservations.map((reservation) =>
        db
          .prepare(
            `INSERT INTO public_write_attempt_reservations (
          reservation_id, fellow_id, problem_id, sponsor_id, session_id,
          route, idempotency_key, request_digest, reserved_at, expires_at, sponsor_limit, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
          )
          .bind(
            reservation.reservationId,
            reservation.fellowId,
            reservation.problemId,
            reservation.sponsorId,
            reservation.sessionId,
            reservation.route,
            reservation.idempotencyKey,
            reservation.requestDigest,
            now,
            reservation.expiresAt,
            sponsorLimit,
          ),
      ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("SPONSOR_PROMOTION_RATE_LIMIT_EXCEEDED")) {
      return rateLimited(await getRemainingBudget(db, budgetParams), "sponsor");
    }
    if (message.includes("PROMOTION_RATE_LIMIT_EXCEEDED")) {
      return rateLimited(await getRemainingBudget(db, budgetParams), "fellow_problem");
    }
    if (
      message.includes("UNIQUE constraint failed") ||
      message.includes("public_write_reservations_inflight_key_idx")
    ) {
      await log("conflict");
      return { allowed: false, reason: "IN_FLIGHT_CONFLICT", retryAfterSeconds: 1 };
    }
    throw error;
  }
  const budget = await getRemainingBudget(db, budgetParams);
  await log("allowed");
  return { allowed: true, reservations, budget };
}

/**
 * Format a 429 PROMOTION_RATE_LIMITED problem response with rate-limit headers.
 */
export function promotionRateLimitedProblem(decision: {
  readonly retryAfterSeconds: number;
  readonly budget: RateLimitBudget;
  readonly dimension?: "fellow_problem" | "sponsor";
  readonly batchSize?: number;
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
  const batchExceedsCapacity =
    isSponsor && limit > 0 && decision.batchSize !== undefined && decision.batchSize > limit;
  const slowMode = !isSponsor ? decision.budget.slow_mode : undefined;
  const detail = sponsorPaused
    ? "Sponsor promotion limit is configured to zero. Keep using the workshop."
    : batchExceedsCapacity
      ? `This complete batch requires ${decision.batchSize} publication attempts, but the sponsor limit allows at most ${limit} per hour. Waiting alone cannot make this batch fit.`
      : decision.batchSize !== undefined && remaining > 0
        ? `This complete batch requires ${decision.batchSize} publication attempts; only ${remaining} remain in the ${isSponsor ? "sponsor" : "Fellow/problem"} allowance. No batch member was admitted.`
        : isSponsor
          ? `Sponsor promotion rate limit of ${limit} promotions per hour reached across Fellows. Keep using the workshop.`
          : slowMode
            ? `This problem temporarily allows ${limit} publication attempts per Fellow per hour until ${slowMode.expires_at}. The current allowance is exhausted. Keep using the workshop.`
            : `Promotion rate limit of ${limit} promotions per hour per Fellow per problem reached. Keep using the workshop.`;
  const fixHint = sponsorPaused
    ? "Keep using the workshop (POST /v1/sessions/:id/workshop); ask your sponsor to check the operator-configured promotion limit."
    : batchExceedsCapacity
      ? "Submit a smaller complete batch with its causal dependencies included, or ask your sponsor to check the operator-configured limit. Continue privately in the workshop."
      : isSponsor
        ? "Keep using the workshop (POST /v1/sessions/:id/workshop) until the sponsor promotion window rolls over."
        : slowMode
          ? "Continue privately in the workshop. Retry after the indicated delay, when enough attempts leave the window or the temporary limit expires."
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
 * Settle a reservation as published, in the ledger write's batch. Only when
 * that write's event exists: a ledger batch can commit without its event
 * (uwr8), and then nothing was published.
 */
export function settleQuotaReservationStatement(
  db: D1Database,
  reservationId: string,
  eventId: string,
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE public_write_attempt_reservations
          SET status = 'settled_published', settled_at = ?
        WHERE reservation_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
    )
    .bind(now, reservationId, eventId);
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
  const sponsorLimit = parseSponsorLimit(params.sponsorLimit);
  const policy = await readPromotionPolicy(db, params.problemId, now);

  let fellowCount = 0;

  if (params.problemId) {
    const fellowAttempts = await db
      .prepare(
        `SELECT COUNT(*) AS attempt_count
           FROM public_write_attempt_reservations
          WHERE fellow_id = ?
            AND problem_id = ?
            AND reserved_at > ?`,
      )
      .bind(params.fellowId, params.problemId, windowStart)
      .first<{ attempt_count: number }>();

    fellowCount = fellowAttempts?.attempt_count ?? 0;
  }

  let sponsorCount = 0;
  if (sponsorLimit !== null && params.sponsorId) {
    if (sponsorLimit > 0) {
      const sponsorAttempts = await db
        .prepare(
          `SELECT COUNT(*) AS attempt_count
             FROM public_write_attempt_reservations
            WHERE sponsor_id = ?
              AND reserved_at > ?`,
        )
        .bind(params.sponsorId, windowStart)
        .first<{ attempt_count: number }>();
      sponsorCount = sponsorAttempts?.attempt_count ?? 0;
    }
  }

  const remaining = Math.max(0, policy.limit - fellowCount);
  const sponsorRemaining = sponsorLimit === null ? null : Math.max(0, sponsorLimit - sponsorCount);
  // Both dimensions must admit the write. A configured zero sponsor limit has
  // no time-based recovery; do not invent an expiry for that operator setting.
  const retryAfterSeconds =
    sponsorLimit === 0
      ? undefined
      : Math.max(
          remaining === 0
            ? await quotaRetryDelay(
                db,
                { ...params, now },
                1,
                "fellow_problem",
                policy.limit,
                policy.slow_mode?.expires_at,
              )
            : 0,
          sponsorRemaining === 0 && sponsorLimit !== null
            ? await quotaRetryDelay(db, { ...params, now }, 1, "sponsor", sponsorLimit)
            : 0,
        ) || undefined;

  return {
    limit: policy.limit,
    remaining,
    window_seconds: Math.floor(PROMOTION_RATE_LIMIT_WINDOW_MS / 1000),
    ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
    sponsor_limit: sponsorLimit,
    sponsor_remaining: sponsorRemaining,
    ...(policy.slow_mode ? { slow_mode: policy.slow_mode } : {}),
  };
}
