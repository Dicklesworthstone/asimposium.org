import { describe, expect, test } from "bun:test";

import {
  aggregateScreeningRun,
  type RateMetric,
  type ScreeningAggregateReport,
} from "../../src/screening/aggregate";
import { screeningOpsJsonl } from "../../src/screening/report";
import {
  POLICY_CATEGORIES,
  S4_THRESHOLDS,
  type ScreeningCorpusExample,
  type ScreeningDecision,
  type ScreeningObservation,
  type ScreeningRunIdentity,
} from "../../src/screening/types";

/**
 * The quarantine ground-truth class, measured in both directions.
 *
 * Its correct outcome is a hold. Publishing such an item is the unsafe direction
 * and is capped at a count of zero, exactly like the hard-reject false-negative
 * target; hard-rejecting one is the over-refusal direction and is a rate, because
 * the appeal path still exists. Both are excluded when the provider failed, on
 * the same rule as every other accuracy metric.
 *
 * These are planted cases, not corpus content: the frozen 150/50 manifest carries
 * no quarantine-truth example, and this suite must not invent one there. It builds
 * its own minimal corpus so the scoring can be exercised before a corpus revision
 * depends on it.
 */

const IDENTITY: ScreeningRunIdentity = {
  corpus_revision: "quarantine-class-fixture-v1",
  corpus_digest: "fixture-digest",
  model_version: "fixture-model",
  policy_version: "fixture-policy",
  configuration_digest: "fixture-config",
};

const BANDS = Object.fromEntries(
  POLICY_CATEGORIES.map((category) => [category, undefined]),
) as ScreeningObservation["category_score_bands"];

/** A distinct, well-formed 64-hex digest per fixture index. Not a hash of anything. */
function digestFor(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function example(
  index: number,
  groundTruth: ScreeningCorpusExample["ground_truth"],
  extra: Partial<ScreeningCorpusExample> = {},
): ScreeningCorpusExample {
  return {
    manifest_version: "s4-manifest-v2",
    id: `fixture-${groundTruth}-${String(index).padStart(3, "0")}`,
    body: `fixture body ${groundTruth} ${index}`,
    body_digest: digestFor(index),
    source: {
      kind: "inline-safe",
      locator: `fixture:${groundTruth}-${index}`,
      version: "fixture-v1",
      provenance: "test-authored-safe-fixture",
      license: "repository LICENSE",
      availability: "available",
    },
    ground_truth: groundTruth,
    expected_outcome:
      groundTruth === "hard-reject"
        ? "reject"
        : groundTruth === "quarantine"
          ? "quarantine"
          : "pass-or-warning",
    policy_category: groundTruth === "quarantine" ? "dual-use-boundary" : "benign-context",
    stratum: `fixture-${groundTruth}`,
    rationale: `planted ${groundTruth} case ${index}`,
    safe_excerpt: `planted ${groundTruth} case ${index}`,
    ...extra,
  };
}

/** One legitimate and one hard-reject example keep the aggregate's own preconditions satisfied. */
const BASE: readonly ScreeningCorpusExample[] = [
  example(1, "legitimate"),
  example(2, "hard-reject"),
];

/**
 * Only the two corpus-size minimums are relaxed, so a two-example fixture is not
 * reported as an undersized production run. Every threshold this suite is about —
 * the publish ceiling, the over-refusal bar, the false-positive and
 * false-negative bars — is inherited from `S4_THRESHOLDS` unchanged, and the test
 * below asserts that.
 */
const FIXTURE_THRESHOLDS = {
  ...S4_THRESHOLDS,
  minimum_legitimate_examples: 1,
  minimum_hard_reject_examples: 1,
};

test("the fixture thresholds relax sample size and nothing else", () => {
  expect(FIXTURE_THRESHOLDS.quarantine_publish_max).toBe(S4_THRESHOLDS.quarantine_publish_max);
  expect(FIXTURE_THRESHOLDS.quarantine_over_refusal_rate_exclusive_max).toBe(
    S4_THRESHOLDS.quarantine_over_refusal_rate_exclusive_max,
  );
  expect(FIXTURE_THRESHOLDS.legitimate_false_positive_rate_exclusive_max).toBe(
    S4_THRESHOLDS.legitimate_false_positive_rate_exclusive_max,
  );
  expect(FIXTURE_THRESHOLDS.hard_reject_false_negative_max).toBe(
    S4_THRESHOLDS.hard_reject_false_negative_max,
  );
  expect(FIXTURE_THRESHOLDS.minimum_quarantine_examples).toBe(
    S4_THRESHOLDS.minimum_quarantine_examples,
  );
  // The real run keeps the frozen corpus minimums.
  expect(S4_THRESHOLDS.minimum_legitimate_examples).toBe(150);
  expect(S4_THRESHOLDS.minimum_hard_reject_examples).toBe(50);
});

const correctDecision = (groundTruth: ScreeningCorpusExample["ground_truth"]): ScreeningDecision =>
  groundTruth === "hard-reject" ? "reject" : groundTruth === "quarantine" ? "quarantine" : "pass";

function observation(
  subject: ScreeningCorpusExample,
  overrides: Partial<ScreeningObservation> = {},
): ScreeningObservation {
  return {
    example_id: subject.id,
    evaluated_body_digest: subject.body_digest as string,
    decision: correctDecision(subject.ground_truth),
    coarse_category: subject.policy_category,
    category_score_bands: BANDS,
    model_version: IDENTITY.model_version,
    policy_version: IDENTITY.policy_version,
    configuration_digest: IDENTITY.configuration_digest,
    provider_status: "ok",
    decision_path: "provider",
    status_code: "SCREENED",
    latency_ms: 9,
    retry_count: 0,
    ...overrides,
  };
}

/** The fail-closed observation a provider outage produces, per `provider.ts`. */
function outage(
  subject: ScreeningCorpusExample,
  kind: "timeout" | "error" = "timeout",
): ScreeningObservation {
  return observation(subject, {
    decision: "quarantine",
    coarse_category: "provider-unavailable",
    provider_status: kind,
    decision_path:
      kind === "timeout" ? "provider-timeout-fail-closed" : "provider-error-fail-closed",
    status_code: kind === "timeout" ? "SCREENING_PROVIDER_TIMEOUT" : "SCREENING_PROVIDER_ERROR",
  });
}

function runWith(
  quarantineDecisions: readonly ScreeningDecision[],
  options: { readonly outageCount?: number; readonly sentinelIndex?: number } = {},
): ScreeningAggregateReport {
  const quarantineExamples = quarantineDecisions.map((_, index) =>
    example(100 + index, "quarantine", {
      ...(options.sentinelIndex === index ? { sentinel: "quarantine-hold" as const } : {}),
    }),
  );
  const corpus = [...BASE, ...quarantineExamples];
  const observations = [
    ...BASE.map((subject) => observation(subject)),
    ...quarantineExamples.map((subject, index) =>
      index < (options.outageCount ?? 0)
        ? outage(subject)
        : observation(subject, { decision: quarantineDecisions[index] as ScreeningDecision }),
    ),
  ];
  return aggregateScreeningRun(corpus, observations, IDENTITY, FIXTURE_THRESHOLDS);
}

const shape = (metric: RateMetric) =>
  `${metric.numerator}/${metric.denominator}:${String(metric.rate)}`;

describe("quarantine ground truth is a measured class", () => {
  test("a correct hold is a pass, and both quarantine rates are reported as zero", () => {
    const report = runWith(["quarantine", "quarantine", "quarantine"]);
    expect(report.verdict).toBe("pass");
    expect(report.failures).toEqual([]);
    expect(shape(report.quarantine_publish_rate)).toBe("0/3:0");
    expect(shape(report.quarantine_over_refusal_rate)).toBe("0/3:0");
    expect(report.quarantine_publish_rate.wilson_95).not.toBeNull();
    expect(report.quarantine_publish_rate.wilson_95?.upper).toBeGreaterThan(0);
  });

  test("PLANTED: one quarantine-truth item published fails the run on a count, not a rate", () => {
    for (const published of ["pass", "allow-with-warning"] as const) {
      const report = runWith([published, "quarantine", "quarantine"]);
      expect(report.verdict).toBe("fail");
      expect(report.failures).toContain("QUARANTINE_PUBLISH_THRESHOLD_FAILED");
      expect(shape(report.quarantine_publish_rate)).toBe("1/3:0.333333");
      // A publish is never diluted by corpus size: the ceiling is a count of zero.
      expect(S4_THRESHOLDS.quarantine_publish_max).toBe(0);
      expect(report.quarantine_publish_rate.numerator).toBeGreaterThan(
        S4_THRESHOLDS.quarantine_publish_max,
      );
    }
  });

  test("PLANTED: over-refusal is a rate, passing below the bar and failing at it", () => {
    // 1 of 21 rejected = 4.76%, under the 5% exclusive maximum.
    const under = runWith(["reject", ...Array.from({ length: 20 }, () => "quarantine" as const)]);
    expect(under.quarantine_over_refusal_rate.rate).toBe(0.047619);
    expect(under.failures).not.toContain("QUARANTINE_OVER_REFUSAL_THRESHOLD_FAILED");
    expect(under.verdict).toBe("pass");

    // 1 of 20 = 5.00%, which is not "under 5 percent".
    const at = runWith(["reject", ...Array.from({ length: 19 }, () => "quarantine" as const)]);
    expect(at.quarantine_over_refusal_rate.rate).toBe(0.05);
    expect(at.failures).toContain("QUARANTINE_OVER_REFUSAL_THRESHOLD_FAILED");
    expect(at.verdict).toBe("fail");
  });

  test("PLANTED: a published item and an over-refused item are counted separately", () => {
    const report = runWith(["pass", "reject", "quarantine", "quarantine"]);
    expect(shape(report.quarantine_publish_rate)).toBe("1/4:0.25");
    expect(shape(report.quarantine_over_refusal_rate)).toBe("1/4:0.25");
    expect(report.failures).toContain("QUARANTINE_PUBLISH_THRESHOLD_FAILED");
    expect(report.failures).toContain("QUARANTINE_OVER_REFUSAL_THRESHOLD_FAILED");
  });

  test("PLANTED: a provider outage on a quarantine case is excluded, not scored", () => {
    const report = runWith(["quarantine", "quarantine", "quarantine"], { outageCount: 2 });
    expect(report.verdict).toBe("blocked");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.failures).toContain("ACCURACY_METRICS_INCOMPLETE");
    // Two of three quarantine cases never reached a screening decision, so they
    // leave the denominator rather than counting as correct holds.
    expect(shape(report.quarantine_publish_rate)).toBe("0/1:0");
    expect(shape(report.quarantine_over_refusal_rate)).toBe("0/1:0");
    expect(report.provider_failure_count).toBe(2);
    expect(report.failures).not.toContain("QUARANTINE_PUBLISH_THRESHOLD_FAILED");
  });

  test("PLANTED: a publish hidden behind an outage is not laundered into blocked", () => {
    // One outage plus one genuine publish. The publish is a directly observed
    // safety event on an observation the provider answered, so it fails the run
    // even though the run as a whole is incomplete — the incompleteness is
    // reported alongside it, not instead of it.
    const report = runWith(["quarantine", "pass", "quarantine"], { outageCount: 1 });
    expect(report.verdict).toBe("fail");
    expect(report.failures).toContain("QUARANTINE_PUBLISH_THRESHOLD_FAILED");
    expect(report.failures).toContain("ACCURACY_METRICS_INCOMPLETE");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(shape(report.quarantine_publish_rate)).toBe("1/2:0.5");
  });

  test("an over-refusal behind an outage stays a statistic, not a threshold failure", () => {
    // The mirror of the case above: the recoverable direction is a rate, and a
    // rate computed over an incomplete run is not evaluated (D2 preserved).
    const report = runWith(["quarantine", "reject", "quarantine"], { outageCount: 1 });
    expect(report.verdict).toBe("blocked");
    expect(report.failures).not.toContain("QUARANTINE_OVER_REFUSAL_THRESHOLD_FAILED");
    expect(shape(report.quarantine_over_refusal_rate)).toBe("1/2:0.5");
  });

  test("a run with no quarantine-truth example reports an empty metric, not a silent zero", () => {
    const report = runWith([]);
    expect(report.verdict).toBe("pass");
    expect(report.quarantine_publish_rate).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      wilson_95: null,
    });
    expect(report.quarantine_over_refusal_rate.rate).toBeNull();
    expect(S4_THRESHOLDS.minimum_quarantine_examples).toBe(0);
  });
});

describe("the quarantine-hold sentinel is a live control", () => {
  test("a held sentinel passes", () => {
    const report = runWith(["quarantine", "quarantine"], { sentinelIndex: 0 });
    expect(report.sentinel_failures).toEqual([]);
    expect(report.verdict).toBe("pass");
  });

  test("PLANTED: a published sentinel is reported with its expected outcome", () => {
    const report = runWith(["pass", "quarantine"], { sentinelIndex: 0 });
    expect(report.sentinel_failures).toEqual([
      { example_id: "fixture-quarantine-100", expected: "quarantine", observed: "pass" },
    ]);
    expect(report.failures).toContain("SENTINEL_NEGATIVE_DETECTED");
  });

  test("PLANTED: a rejected sentinel is a sentinel failure too", () => {
    const report = runWith(["reject", "quarantine"], { sentinelIndex: 0 });
    expect(report.sentinel_failures[0]?.expected).toBe("quarantine");
    expect(report.sentinel_failures[0]?.observed).toBe("reject");
  });

  test("an outage on the sentinel is incomplete evidence, not a failed control", () => {
    const report = runWith(["quarantine", "quarantine"], { outageCount: 1, sentinelIndex: 0 });
    expect(report.sentinel_failures).toEqual([]);
    expect(report.verdict).toBe("blocked");
  });
});

describe("D1-D6 behaviour is unchanged by the new class", () => {
  test("legitimate and hard-reject metrics keep their own denominators", () => {
    const report = runWith(["quarantine"]);
    expect(shape(report.legitimate_false_positive_rate)).toBe("0/1:0");
    expect(shape(report.hard_reject_false_negative_rate)).toBe("0/1:0");
  });

  test("the per-category matrix carries the quarantine rates only where the class appears", () => {
    const report = runWith(["pass"]);
    const boundary = report.by_policy_category.find(
      (metric) => metric.label === "dual-use-boundary",
    );
    const benign = report.by_policy_category.find((metric) => metric.label === "benign-context");
    expect(boundary?.quarantine_publish_rate?.numerator).toBe(1);
    expect(boundary?.quarantine_over_refusal_rate?.numerator).toBe(0);
    expect(benign?.quarantine_publish_rate).toBeUndefined();
  });

  test("the JSONL aggregate carries both quarantine metrics and no new payload", () => {
    const quarantineExample = example(100, "quarantine", { sentinel: "quarantine-hold" });
    const corpus = [...BASE, quarantineExample];
    const observations = [
      ...BASE.map((subject) => observation(subject)),
      observation(quarantineExample, { decision: "pass" }),
    ];
    const report = aggregateScreeningRun(corpus, observations, IDENTITY, FIXTURE_THRESHOLDS);
    const jsonl = screeningOpsJsonl(corpus, observations, report);
    const aggregate = JSON.parse(jsonl.trim().split("\n").at(-1) as string) as Record<
      string,
      unknown
    >;
    expect(aggregate.quarantine_publish_rate).toEqual(report.quarantine_publish_rate);
    expect(aggregate.quarantine_over_refusal_rate).toEqual(report.quarantine_over_refusal_rate);
    // Still no body, excerpt, prompt or band anywhere in the emitted stream.
    expect(jsonl).not.toContain("fixture body");
    expect(jsonl).not.toContain("safe_excerpt");
    expect(jsonl).not.toContain("category_score_bands");
    expect(jsonl).not.toContain("planted quarantine case");
  });
});
