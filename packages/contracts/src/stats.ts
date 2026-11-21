import { z } from "zod";
import { CANONICAL_CONTENT_LICENSE } from "./public-resources.ts";

/**
 * Measured platform statistics contract (`/stats.json`, `/stats.md`, Fable §13.3).
 *
 * Implements the 5 balanced health-metric families (Collaboration, Quality incl.
 * review-supply depth, Ergonomics, Comprehension, Safety) under strict Rule A4
 * ("the site never pretends") and Rule A10 / ADR-19 / ADR-26 ("no leaderboards,
 * no actor rankings, no model-family comparison tables, no pumpable vanity counts").
 *
 * External/deployed-only metrics that D1 cannot measure on its own are declared
 * explicitly as `"unavailable_until_deployed"`, never fabricated as zero.
 */

export const UNAVAILABLE_UNTIL_DEPLOYED = "unavailable_until_deployed" as const;
export const UnavailableUntilDeployedSchema = z.literal(UNAVAILABLE_UNTIL_DEPLOYED);

export const StatsRateSchema = z
  .object({
    numerator: z.number().int().min(0),
    denominator: z.number().int().min(0),
    rate: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.numerator > value.denominator) {
      ctx.addIssue({
        code: "custom",
        path: ["numerator"],
        message: "rate numerator cannot exceed denominator",
      });
    }
    if (value.denominator === 0 && value.rate !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["rate"],
        message: "zero denominator must report null rate rather than fabricated 0",
      });
    }
  });
export type StatsRate = z.infer<typeof StatsRateSchema>;

export const StatsNextActionSchema = z
  .object({
    method: z.literal("GET"),
    path: z.string().regex(/^\/[A-Za-z0-9._/-]+$/),
    why: z.string().min(1).max(200),
  })
  .strict();

export const PlatformStatsFaceSchema = z
  .object({
    kind: z.literal("stats"),
    state: z.literal("measured"),
    contract_version: z.literal(2),
    measured_at: z.string().datetime(),
    storage_authority: z.literal("d1"),
    anti_metrics_policy: z.literal("rule-a10-no-actor-rankings-no-model-comparisons"),
    license: z.literal(CANONICAL_CONTENT_LICENSE),
    collaboration: z
      .object({
        public_problems: z.number().int().min(0),
        active_problems: z.number().int().min(0),
        active_problems_with_multiple_sponsors: z.number().int().min(0),
        multi_sponsor_active_problem_share: StatsRateSchema,
        median_hours_to_first_external_sponsor: z.number().min(0).nullable(),
        first_external_sponsor_sample_size: z.number().int().min(0),
        handback_completion_rate: StatsRateSchema,
      })
      .strict(),
    quality: z
      .object({
        claims_total: z.number().int().min(0),
        claims_by_disposition: z.record(z.string().min(1).max(40), z.number().int().min(0)),
        consequential_claims_independent_review_coverage: StatsRateSchema,
        review_supply_depth: z
          .object({
            problems_measured: z.number().int().min(0),
            median_eligible_independent_fellows: z.number().min(0).nullable(),
            min_eligible_independent_fellows: z.number().int().min(0).nullable(),
          })
          .strict(),
        corroborated_awaiting_independence_count: z.number().int().min(0),
        reproduction_pass_rate: StatsRateSchema,
        dead_ends_recorded: z.number().int().min(0),
        dead_ends_with_retry_predicate: z.number().int().min(0),
      })
      .strict(),
    ergonomics: z
      .object({
        sessions_opened: z.number().int().min(0),
        sessions_closed: z.number().int().min(0),
        idempotent_writes_recorded: z.number().int().min(0),
        onboarding_completion_by_harness: UnavailableUntilDeployedSchema,
        median_paste_to_orient_seconds: UnavailableUntilDeployedSchema,
        tokens_per_useful_action: UnavailableUntilDeployedSchema,
        protocol_errors_by_client_version: UnavailableUntilDeployedSchema,
      })
      .strict(),
    comprehension: z
      .object({
        false_solved_reports_recorded: z.number().int().min(0),
        usability_status_identification_rate: UnavailableUntilDeployedSchema,
      })
      .strict(),
    safety: z
      .object({
        quarantine_cases_open: z.number().int().min(0),
        quarantine_cases_resolved: z.number().int().min(0),
        screening_appeals_total: z.number().int().min(0),
        screening_appeal_reversals: z.number().int().min(0),
        screening_appeal_reversal_rate: StatsRateSchema,
        hosted_screening_fp_fn_status: UnavailableUntilDeployedSchema,
        edge_cache_hit_ratio: UnavailableUntilDeployedSchema,
      })
      .strict(),
    omitted: z.array(z.string().min(1).max(200)).min(1),
    next_actions: z.array(StatsNextActionSchema).min(1),
  })
  .strict();

export type PlatformStatsFace = z.infer<typeof PlatformStatsFaceSchema>;

const FORBIDDEN_ANTI_METRIC_KEYS = new Set([
  "leaderboard",
  "leaderboards",
  "ranking",
  "rankings",
  "rank",
  "top_fellows",
  "top_sponsors",
  "top_models",
  "fellow_name",
  "fellow_names",
  "fellow_id",
  "fellow_ids",
  "sponsor_name",
  "sponsor_names",
  "sponsor_id",
  "sponsor_ids",
  "actor_name",
  "actor_names",
  "actor_id",
  "model_family",
  "model_families",
  "model_comparison",
  "model_rankings",
  "model_scores",
  "streak",
  "streaks",
  "karma",
  "score_table",
  "activity_meter",
]);

const FORBIDDEN_ACTOR_ID_PATTERNS: readonly RegExp[] = [
  /\bF-[0-9A-HJKMNP-TV-Z]{10,}\b/i,
  /\busr_[A-Za-z0-9_-]{8,}\b/,
  /\basimp_ag_[A-Za-z0-9_-]{8,}\b/i,
];

export class StatsAntiMetricViolationError extends Error {
  readonly code = "STATS_RULE_A10_VIOLATION";
  constructor(
    readonly offending_path: string,
    readonly reason: string,
  ) {
    super(`STATS_RULE_A10_VIOLATION at ${offending_path}: ${reason}`);
    this.name = "StatsAntiMetricViolationError";
  }
}

/**
 * Enforces Rule A10 / ADR-19 / ADR-26 on any `/stats` payload: recursively
 * rejects actor names/IDs, leaderboards, streaks, or model-family ranking keys.
 */
export function assertNoStatsAntiMetrics(payload: unknown, path = "$"): void {
  if (typeof payload === "string") {
    for (const pattern of FORBIDDEN_ACTOR_ID_PATTERNS) {
      if (pattern.test(payload)) {
        throw new StatsAntiMetricViolationError(
          path,
          "string value contains an actor or credential identifier forbidden on /stats",
        );
      }
    }
    return;
  }
  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i += 1) {
      assertNoStatsAntiMetrics(payload[i], `${path}[${i}]`);
    }
    return;
  }
  if (payload !== null && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/-/g, "_");
      if (FORBIDDEN_ANTI_METRIC_KEYS.has(normalized)) {
        throw new StatsAntiMetricViolationError(
          `${path}.${key}`,
          `forbidden Rule A10 anti-metric key "${key}"`,
        );
      }
      assertNoStatsAntiMetrics(value, `${path}.${key}`);
    }
  }
}
