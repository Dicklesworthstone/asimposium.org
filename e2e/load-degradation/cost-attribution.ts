/**
 * W10.7 Cost Attribution, Backpressure Priority Policy, and Anomaly Detection
 * (asimposiumorg-0fs, Fable Rule A7 & §15).
 *
 * Enforces:
 * 1. Explicit 4-tier backpressure order:
 *    - Tier 0 (`critical-safety`): auth, revocation, safety/moderation (never shed while D1 healthy)
 *    - Tier 1 (`bounded-ledger-writes`): authenticated writes within rate caps (explicit 429 + Retry-After, zero silent event drops)
 *    - Tier 2 (`deferred-outbox`): embeddings, OG invalidation, notifications, webhooks (deferred before rejecting writes)
 *    - Tier 3 (`public-feed-freshness`): public feed/digest cache TTL relaxation (shed earliest)
 * 2. Per-route, per-Fellow, and per-problem resource attribution (Worker reqs, D1 row reads/writes, R2 ops, AI calls).
 * 3. Deterministic anomaly alerting against unit-cost and budget-share thresholds.
 */

export type BackpressureTier =
  | "critical-safety"
  | "bounded-ledger-writes"
  | "deferred-outbox"
  | "public-feed-freshness";

export type LoadPressureLevel = "nominal" | "elevated" | "high" | "critical";

export interface BackpressureDecision {
  readonly tier: BackpressureTier;
  readonly pressure: LoadPressureLevel;
  readonly action: "admit" | "relax-freshness" | "defer-outbox" | "throttle-429";
  readonly http_status: 200 | 202 | 429;
  readonly retry_after_seconds?: number;
  readonly stale_while_revalidate_seconds?: number;
  readonly silently_dropped: false;
}

/**
 * Canonical backpressure priority ranking (lower number = higher preservation priority).
 * Matches Fable §15 & W10.7:
 *   0: auth / revocation / safety
 *   1: bounded authenticated ledger writes (while D1 healthy)
 *   2: outbox consumers (embeddings, OG, notifications, webhooks)
 *   3: public feed freshness (degrade first before rejecting authenticated writes)
 */
export const BACKPRESSURE_TIER_PRIORITY: Readonly<Record<BackpressureTier, number>> = {
  "critical-safety": 0,
  "bounded-ledger-writes": 1,
  "deferred-outbox": 2,
  "public-feed-freshness": 3,
};

/**
 * Evaluate backpressure action for an incoming work class under measured system pressure.
 * Never returns `silently_dropped: true`; every rejected write gets an explicit 429 + Retry-After.
 */
export function evaluateBackpressure(
  tier: BackpressureTier,
  pressure: LoadPressureLevel,
  d1Healthy = true,
): BackpressureDecision {
  // Tier 0: Auth, revocation, safety/moderation paths are ALWAYS preserved while D1 is reachable.
  if (tier === "critical-safety") {
    return {
      tier,
      pressure,
      action: "admit",
      http_status: 200,
      silently_dropped: false,
    };
  }

  // Tier 3: Public feed freshness degrades earliest (elevated/high/critical).
  if (tier === "public-feed-freshness") {
    if (pressure === "nominal") {
      return { tier, pressure, action: "admit", http_status: 200, silently_dropped: false };
    }
    const swrSeconds = pressure === "elevated" ? 30 : pressure === "high" ? 120 : 300;
    return {
      tier,
      pressure,
      action: "relax-freshness",
      http_status: 200,
      stale_while_revalidate_seconds: swrSeconds,
      silently_dropped: false,
    };
  }

  // Tier 2: Outbox work (embeddings, OG, notifications, webhooks) defers at high/critical
  // BEFORE authenticated writes are rejected. Durable outbox retains every item.
  if (tier === "deferred-outbox") {
    if (pressure === "nominal" || pressure === "elevated") {
      return { tier, pressure, action: "admit", http_status: 200, silently_dropped: false };
    }
    return {
      tier,
      pressure,
      action: "defer-outbox",
      http_status: 202,
      retry_after_seconds: pressure === "high" ? 30 : 120,
      silently_dropped: false,
    };
  }

  // Tier 1: Bounded ledger writes remain open through elevated & high load while D1 is healthy;
  // only shed at critical saturation or D1 distress, ALWAYS with explicit 429 + Retry-After.
  if (!d1Healthy || pressure === "critical") {
    return {
      tier,
      pressure,
      action: "throttle-429",
      http_status: 429,
      retry_after_seconds: d1Healthy ? 15 : 60,
      silently_dropped: false,
    };
  }
  return {
    tier,
    pressure,
    action: "admit",
    http_status: 200,
    silently_dropped: false,
  };
}

/**
 * Unit pricing assumptions pinned to Cloudflare Workers Paid / D1 / R2 pricing
 * (aligned with scripts/verify-cost-model.ts and Fable §15).
 */
export const CLOUDFLARE_UNIT_RATES_USD = {
  /** $0.30 per million Worker requests above 10M included. */
  worker_request_per_million: 0.3,
  /** $0.001 per million D1 row reads above 25B included. */
  d1_row_read_per_million: 0.001,
  /** $1.00 per million D1 row writes above 50M included. */
  d1_row_write_per_million: 1.0,
  /** $4.50 per million R2 Class A ops (put/list). */
  r2_class_a_per_million: 4.5,
  /** $0.36 per million R2 Class B ops (get/head). */
  r2_class_b_per_million: 0.36,
  /** Conservative Workers AI screening call estimate ($0.00015 / screening call). */
  ai_screening_per_call: 0.00015,
} as const;

export interface UsageRecord {
  readonly route: string;
  readonly fellow_id: string | null;
  readonly problem_id: string | null;
  readonly worker_requests: number;
  readonly d1_rows_read: number;
  readonly d1_rows_written: number;
  readonly r2_class_a_ops: number;
  readonly r2_class_b_ops: number;
  readonly ai_screening_calls: number;
}

export interface CostBucketSummary {
  readonly key: string;
  readonly worker_requests: number;
  readonly d1_rows_read: number;
  readonly d1_rows_written: number;
  readonly r2_class_a_ops: number;
  readonly r2_class_b_ops: number;
  readonly ai_screening_calls: number;
  readonly gross_cost_usd: number;
  readonly projected_monthly_usd: number;
  readonly share_of_total: number;
}

export interface CostAnomalyAlert {
  readonly code:
    | "ANOMALOUS_COST_PER_ROUTE"
    | "ANOMALOUS_COST_PER_FELLOW"
    | "ANOMALOUS_COST_PER_PROBLEM"
    | "PROJECTED_MONTHLY_BUDGET_EXCEEDED";
  readonly dimension: "route" | "fellow" | "problem" | "global";
  readonly key: string;
  readonly projected_monthly_usd: number;
  readonly share_of_total: number;
  readonly threshold_description: string;
}

export interface CostAttributionReport {
  readonly window_minutes: number;
  readonly total_gross_cost_usd: number;
  readonly projected_monthly_cost_usd: number;
  readonly monthly_ceiling_usd: number;
  readonly by_route: readonly CostBucketSummary[];
  readonly by_fellow: readonly CostBucketSummary[];
  readonly by_problem: readonly CostBucketSummary[];
  readonly alerts: readonly CostAnomalyAlert[];
}

export interface CostAnomalyThresholds {
  readonly monthly_ceiling_usd: number;
  /** Alert if any single Fellow's projected monthly spend exceeds this USD cap. */
  readonly single_fellow_monthly_usd_alert: number;
  /** Alert if any single problem's projected monthly spend exceeds this USD cap. */
  readonly single_problem_monthly_usd_alert: number;
  /** Alert if any single route exceeds both this share of total cost and minimum monthly USD. */
  readonly single_route_share_alert: number;
  readonly single_route_min_monthly_usd_alert: number;
}

export const DEFAULT_COST_ANOMALY_THRESHOLDS: CostAnomalyThresholds = {
  monthly_ceiling_usd: 1_000,
  single_fellow_monthly_usd_alert: 50,
  single_problem_monthly_usd_alert: 150,
  single_route_share_alert: 0.65,
  single_route_min_monthly_usd_alert: 200,
};

export function computeRecordGrossCostUsd(record: UsageRecord): number {
  return (
    (record.worker_requests / 1_000_000) * CLOUDFLARE_UNIT_RATES_USD.worker_request_per_million +
    (record.d1_rows_read / 1_000_000) * CLOUDFLARE_UNIT_RATES_USD.d1_row_read_per_million +
    (record.d1_rows_written / 1_000_000) * CLOUDFLARE_UNIT_RATES_USD.d1_row_write_per_million +
    (record.r2_class_a_ops / 1_000_000) * CLOUDFLARE_UNIT_RATES_USD.r2_class_a_per_million +
    (record.r2_class_b_ops / 1_000_000) * CLOUDFLARE_UNIT_RATES_USD.r2_class_b_per_million +
    record.ai_screening_calls * CLOUDFLARE_UNIT_RATES_USD.ai_screening_per_call
  );
}

interface MutableBucket {
  worker_requests: number;
  d1_rows_read: number;
  d1_rows_written: number;
  r2_class_a_ops: number;
  r2_class_b_ops: number;
  ai_screening_calls: number;
  gross_cost_usd: number;
}

function accumulate(map: Map<string, MutableBucket>, key: string, rec: UsageRecord, cost: number) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      worker_requests: 0,
      d1_rows_read: 0,
      d1_rows_written: 0,
      r2_class_a_ops: 0,
      r2_class_b_ops: 0,
      ai_screening_calls: 0,
      gross_cost_usd: 0,
    };
    map.set(key, bucket);
  }
  bucket.worker_requests += rec.worker_requests;
  bucket.d1_rows_read += rec.d1_rows_read;
  bucket.d1_rows_written += rec.d1_rows_written;
  bucket.r2_class_a_ops += rec.r2_class_a_ops;
  bucket.r2_class_b_ops += rec.r2_class_b_ops;
  bucket.ai_screening_calls += rec.ai_screening_calls;
  bucket.gross_cost_usd += cost;
}

function finalizeBuckets(
  map: Map<string, MutableBucket>,
  totalCost: number,
  monthMultiplier: number,
): CostBucketSummary[] {
  return [...map.entries()]
    .map(([key, b]) => ({
      key,
      worker_requests: b.worker_requests,
      d1_rows_read: b.d1_rows_read,
      d1_rows_written: b.d1_rows_written,
      r2_class_a_ops: b.r2_class_a_ops,
      r2_class_b_ops: b.r2_class_b_ops,
      ai_screening_calls: b.ai_screening_calls,
      gross_cost_usd: Number(b.gross_cost_usd.toFixed(6)),
      projected_monthly_usd: Number((b.gross_cost_usd * monthMultiplier).toFixed(2)),
      share_of_total: totalCost > 0 ? Number((b.gross_cost_usd / totalCost).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.gross_cost_usd - a.gross_cost_usd || a.key.localeCompare(b.key));
}

/**
 * Aggregate usage across route, Fellow, and problem dimensions and emit anomaly alerts.
 */
export function attributeCostsAndDetectAnomalies(
  records: readonly UsageRecord[],
  windowMinutes: number,
  thresholds: CostAnomalyThresholds = DEFAULT_COST_ANOMALY_THRESHOLDS,
): CostAttributionReport {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new RangeError("windowMinutes must be a positive finite number");
  }
  const monthMultiplier = (30 * 24 * 60) / windowMinutes;
  const routes = new Map<string, MutableBucket>();
  const fellows = new Map<string, MutableBucket>();
  const problems = new Map<string, MutableBucket>();

  let totalCost = 0;
  for (const rec of records) {
    const cost = computeRecordGrossCostUsd(rec);
    totalCost += cost;
    accumulate(routes, rec.route, rec, cost);
    if (rec.fellow_id !== null) accumulate(fellows, rec.fellow_id, rec, cost);
    if (rec.problem_id !== null) accumulate(problems, rec.problem_id, rec, cost);
  }

  const byRoute = finalizeBuckets(routes, totalCost, monthMultiplier);
  const byFellow = finalizeBuckets(fellows, totalCost, monthMultiplier);
  const byProblem = finalizeBuckets(problems, totalCost, monthMultiplier);
  const projectedMonthly = Number((totalCost * monthMultiplier).toFixed(2));
  const alerts: CostAnomalyAlert[] = [];

  if (projectedMonthly > thresholds.monthly_ceiling_usd) {
    alerts.push({
      code: "PROJECTED_MONTHLY_BUDGET_EXCEEDED",
      dimension: "global",
      key: "platform",
      projected_monthly_usd: projectedMonthly,
      share_of_total: 1,
      threshold_description: `Projected monthly spend $${projectedMonthly} exceeds $${thresholds.monthly_ceiling_usd} ceiling`,
    });
  }

  for (const bucket of byRoute) {
    if (
      bucket.share_of_total >= thresholds.single_route_share_alert &&
      bucket.projected_monthly_usd >= thresholds.single_route_min_monthly_usd_alert
    ) {
      alerts.push({
        code: "ANOMALOUS_COST_PER_ROUTE",
        dimension: "route",
        key: bucket.key,
        projected_monthly_usd: bucket.projected_monthly_usd,
        share_of_total: bucket.share_of_total,
        threshold_description: `Route ${bucket.key} accounts for ${(bucket.share_of_total * 100).toFixed(1)}% ($${bucket.projected_monthly_usd}/mo)`,
      });
    }
  }

  for (const bucket of byFellow) {
    if (bucket.projected_monthly_usd > thresholds.single_fellow_monthly_usd_alert) {
      alerts.push({
        code: "ANOMALOUS_COST_PER_FELLOW",
        dimension: "fellow",
        key: bucket.key,
        projected_monthly_usd: bucket.projected_monthly_usd,
        share_of_total: bucket.share_of_total,
        threshold_description: `Fellow ${bucket.key} projected $${bucket.projected_monthly_usd}/mo > $${thresholds.single_fellow_monthly_usd_alert}/mo cap`,
      });
    }
  }

  for (const bucket of byProblem) {
    if (bucket.projected_monthly_usd > thresholds.single_problem_monthly_usd_alert) {
      alerts.push({
        code: "ANOMALOUS_COST_PER_PROBLEM",
        dimension: "problem",
        key: bucket.key,
        projected_monthly_usd: bucket.projected_monthly_usd,
        share_of_total: bucket.share_of_total,
        threshold_description: `Problem ${bucket.key} projected $${bucket.projected_monthly_usd}/mo > $${thresholds.single_problem_monthly_usd_alert}/mo cap`,
      });
    }
  }

  return {
    window_minutes: windowMinutes,
    total_gross_cost_usd: Number(totalCost.toFixed(6)),
    projected_monthly_cost_usd: projectedMonthly,
    monthly_ceiling_usd: thresholds.monthly_ceiling_usd,
    by_route: byRoute,
    by_fellow: byFellow,
    by_problem: byProblem,
    alerts,
  };
}
