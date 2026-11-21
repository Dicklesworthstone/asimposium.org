import { describe, expect, test } from "bun:test";
import {
  assertNoStatsAntiMetrics,
  type PlatformStatsFace,
  PlatformStatsFaceSchema,
  StatsAntiMetricViolationError,
  UNAVAILABLE_UNTIL_DEPLOYED,
} from "../../src/stats.ts";

function validStatsFace(): PlatformStatsFace {
  return {
    kind: "stats",
    state: "measured",
    contract_version: 2,
    measured_at: "2026-11-21T05:00:00.000Z",
    storage_authority: "d1",
    anti_metrics_policy: "rule-a10-no-actor-rankings-no-model-comparisons",
    license: "CC-BY-4.0",
    collaboration: {
      public_problems: 4,
      active_problems: 3,
      active_problems_with_multiple_sponsors: 2,
      multi_sponsor_active_problem_share: { numerator: 2, denominator: 3, rate: 0.666667 },
      median_hours_to_first_external_sponsor: 1.5,
      first_external_sponsor_sample_size: 2,
      handback_completion_rate: { numerator: 5, denominator: 6, rate: 0.833333 },
    },
    quality: {
      claims_total: 10,
      claims_by_disposition: { open: 5, corroborated: 3, "strongly-supported": 2 },
      consequential_claims_independent_review_coverage: {
        numerator: 5,
        denominator: 10,
        rate: 0.5,
      },
      review_supply_depth: {
        problems_measured: 3,
        median_eligible_independent_fellows: 4,
        min_eligible_independent_fellows: 2,
      },
      corroborated_awaiting_independence_count: 1,
      reproduction_pass_rate: { numerator: 3, denominator: 4, rate: 0.75 },
      dead_ends_recorded: 2,
      dead_ends_with_retry_predicate: 2,
    },
    ergonomics: {
      sessions_opened: 8,
      sessions_closed: 6,
      idempotent_writes_recorded: 14,
      onboarding_completion_by_harness: UNAVAILABLE_UNTIL_DEPLOYED,
      median_paste_to_orient_seconds: UNAVAILABLE_UNTIL_DEPLOYED,
      tokens_per_useful_action: UNAVAILABLE_UNTIL_DEPLOYED,
      protocol_errors_by_client_version: UNAVAILABLE_UNTIL_DEPLOYED,
    },
    comprehension: {
      false_solved_reports_recorded: 0,
      usability_status_identification_rate: UNAVAILABLE_UNTIL_DEPLOYED,
    },
    safety: {
      quarantine_cases_open: 1,
      quarantine_cases_resolved: 3,
      screening_appeals_total: 1,
      screening_appeal_reversals: 1,
      screening_appeal_reversal_rate: { numerator: 1, denominator: 1, rate: 1 },
      hosted_screening_fp_fn_status: UNAVAILABLE_UNTIL_DEPLOYED,
      edge_cache_hit_ratio: UNAVAILABLE_UNTIL_DEPLOYED,
    },
    omitted: [
      "actor names, leaderboards, streaks, and model-family comparisons are omitted by Rule A10 / ADR-19",
    ],
    next_actions: [
      { method: "GET", path: "/capabilities", why: "The live surface of this deployment." },
    ],
  };
}

describe("PlatformStatsFace contract (Fable §13.3 / Rule A4 / Rule A10)", () => {
  test("POSITIVE: valid balanced 5-family stats face passes schema and Rule A10 anti-metric guard", () => {
    const face = validStatsFace();
    expect(PlatformStatsFaceSchema.parse(face)).toEqual(face);
    expect(() => assertNoStatsAntiMetrics(face)).not.toThrow();
  });

  test("SHOULD-FAIL CONTROL 1: injecting a model-family ranking or leaderboard key fails Rule A10 immediately", () => {
    const withLeaderboard = {
      ...validStatsFace(),
      model_rankings: [{ model: "fable-5", score: 99 }],
    };
    expect(() => PlatformStatsFaceSchema.parse(withLeaderboard)).toThrow();
    expect(() => assertNoStatsAntiMetrics(withLeaderboard)).toThrow(StatsAntiMetricViolationError);

    const withNestedActor = {
      ...validStatsFace(),
      collaboration: {
        ...validStatsFace().collaboration,
        top_fellows: ["euler-bot"],
      },
    };
    expect(() => assertNoStatsAntiMetrics(withNestedActor)).toThrow(StatsAntiMetricViolationError);
  });

  test("SHOULD-FAIL CONTROL 2: injecting a Fellow ID or Sponsor ID string value fails Rule A10 immediately", () => {
    const withFellowId = {
      ...validStatsFace(),
      omitted: ["Top contributor F-01J9Z1234567890ABCDE omitted"],
    };
    expect(() => assertNoStatsAntiMetrics(withFellowId)).toThrow(StatsAntiMetricViolationError);

    const withSponsorId = {
      ...validStatsFace(),
      omitted: ["Sponsor usr_sponsor_0123456789 omitted"],
    };
    expect(() => assertNoStatsAntiMetrics(withSponsorId)).toThrow(StatsAntiMetricViolationError);
  });

  test("SHOULD-FAIL CONTROL 3: zero-denominator rate cannot fabricate 0 instead of null", () => {
    const fabricated = {
      ...validStatsFace(),
      safety: {
        ...validStatsFace().safety,
        screening_appeal_reversal_rate: { numerator: 0, denominator: 0, rate: 0 },
      },
    };
    expect(() => PlatformStatsFaceSchema.parse(fabricated)).toThrow();
  });
});
