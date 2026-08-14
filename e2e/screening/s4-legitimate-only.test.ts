import { describe, expect, test } from "bun:test";
import {
  S4_THRESHOLDS,
  type ScreeningObservation,
  type ScreeningRunIdentity,
  screenWithProvider,
} from "../../apps/wire/src/screening/index";
import { createS4Corpus } from "./s4-corpus";
import {
  createFixtureScreeningProvider,
  FIXTURE_CONFIGURATION_DIGEST,
  FIXTURE_MODEL_VERSION,
  FIXTURE_POLICY_VERSION,
} from "./s4-fixture-provider";
import {
  aggregatePartialScreeningRun,
  assertPartialRunNotGreen,
  isPartialRunEligible,
  PARTIAL_BLOCKED_EXIT_CODE,
  PARTIAL_FAILED_EXIT_CODE,
  PartialRunGreenError,
  partialRunOpsJsonl,
  partitionEvaluableCorpus,
  runLegitimateOnlyScreening,
} from "./s4-legitimate-only";

const FIXTURE_IDENTITY: ScreeningRunIdentity = {
  corpus_revision: "s4-manifest-2026-08-13-v2",
  corpus_digest: `sha256:${"0".repeat(64)}`,
  model_version: FIXTURE_MODEL_VERSION,
  policy_version: FIXTURE_POLICY_VERSION,
  configuration_digest: FIXTURE_CONFIGURATION_DIGEST,
};

/**
 * Every run below uses the declared fixture provider, so no number here is a
 * claim about Workers AI. What is under test is the arithmetic, the sample-size
 * guards, and the property that a half-measured corpus can never report success.
 */
async function partialRun(decide?: (exampleId: string) => "pass" | "reject") {
  const corpus = await createS4Corpus();
  return runLegitimateOnlyScreening({
    corpus,
    provider: createFixtureScreeningProvider(decide === undefined ? {} : { decide }),
    identity: FIXTURE_IDENTITY,
    evidence_class: "fixture-not-model-evidence",
  });
}

describe("S-4 partial run over the available corpus half", () => {
  test("partitions the frozen manifest into 150 evaluable bodies and 50 reserved entries", async () => {
    const { evaluable, reserved } = partitionEvaluableCorpus(await createS4Corpus());
    expect(evaluable).toHaveLength(150);
    expect(reserved).toHaveLength(50);
    expect(evaluable.every((example) => example.ground_truth === "legitimate")).toBe(true);
    expect(reserved.every((example) => example.source.kind === "protected-staging")).toBe(true);
    // A reserved body is absent, not merely unread.
    expect(reserved.every((example) => example.body === undefined)).toBe(true);
  });

  test("treats absent protected bodies as partial-eligible and any other blocker as not", () => {
    expect(
      isPartialRunEligible([
        "EVALUATED_BODY_DIGEST_MISSING",
        "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE",
      ]),
    ).toBe(true);
    // A missing inline body is a corpus defect, not an availability gap.
    expect(
      isPartialRunEligible(["CORPUS_BODY_UNAVAILABLE", "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"]),
    ).toBe(false);
    expect(
      isPartialRunEligible([
        "EVALUATED_BODY_DIGEST_MISSING",
        "LEGITIMATE_BODY_UNAVAILABLE",
        "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE",
      ]),
    ).toBe(true);
    expect(isPartialRunEligible(["EVALUATED_BODY_DIGEST_MISSING"])).toBe(false);
  });

  test("measures the false-positive rate over 150 bodies and names the false-negative half unmeasured", async () => {
    const report = await partialRun();
    expect(report.evaluated_count).toBe(150);
    expect(report.reserved_count).toBe(50);
    expect(report.provider_failure_count).toBe(0);
    // Measured: a real denominator and a real interval.
    expect(report.legitimate_false_positive_rate.denominator).toBe(150);
    expect(report.legitimate_false_positive_rate.rate).toBe(0);
    expect(report.legitimate_false_positive_rate.wilson_95).toEqual({
      confidence_level: 0.95,
      lower: 0,
      upper: 0.02497,
    });
    // Unmeasured: named, with no denominator invented for it.
    expect(report.unmeasured).toContain("hard_reject_false_negative_rate");
    expect(report.quarantine_over_refusal_rate.denominator).toBe(0);
    expect(report.quarantine_over_refusal_rate.rate).toBeNull();
    expect(report.evidence_class).toBe("fixture-not-model-evidence");
  });

  test("PLANTED: a clean partial run still refuses to be green and exits 78", async () => {
    const report = await partialRun();
    // The strongest statement available: the verdict union has no `pass` member,
    // so this is a type-level guarantee as well as a runtime one.
    expect(report.verdict).toBe("blocked");
    expect(report.exit_code).toBe(PARTIAL_BLOCKED_EXIT_CODE);
    expect(report.exit_code).not.toBe(0);
    expect(report.failures).toContain("HARD_REJECT_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("HARD_REJECT_EVIDENCE_UNAVAILABLE");
    expect(report.blockers).toContain("PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE");
    expect(() => assertPartialRunNotGreen(report)).not.toThrow();
  });

  test("a false positive rate at or above 5% breaches the legitimate threshold and fails", async () => {
    // 8/150 = 5.3%, just over the exclusive maximum.
    let rejected = 0;
    const report = await partialRun(() => (rejected++ < 8 ? "reject" : "pass"));
    expect(report.legitimate_false_positive_rate.numerator).toBe(8);
    expect(report.legitimate_false_positive_rate.denominator).toBe(150);
    expect(report.legitimate_false_positive_rate.rate).toBeGreaterThanOrEqual(
      S4_THRESHOLDS.legitimate_false_positive_rate_exclusive_max,
    );
    expect(report.failures).toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    expect(report.verdict).toBe("fail");
    expect(report.exit_code).toBe(PARTIAL_FAILED_EXIT_CODE);
    // A measured breach is stricter than a blocker, and the unmeasured half is
    // still reported rather than being obscured by the failure.
    expect(report.failures).toContain("HARD_REJECT_SAMPLE_TOO_SMALL");
    expect(() => assertPartialRunNotGreen(report)).not.toThrow();
  });

  test("a false positive rate just under 5% does not breach the legitimate threshold", async () => {
    // 7/150 = 4.7%. Proves the previous test detects the threshold rather than
    // any rejection at all.
    let rejected = 0;
    const report = await partialRun(() => (rejected++ < 7 ? "reject" : "pass"));
    expect(report.legitimate_false_positive_rate.rate).toBeLessThan(
      S4_THRESHOLDS.legitimate_false_positive_rate_exclusive_max,
    );
    expect(report.failures).not.toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    // Still blocked: a clean FP half does not supply the FN half.
    expect(report.verdict).toBe("blocked");
    expect(report.exit_code).toBe(PARTIAL_BLOCKED_EXIT_CODE);
  });

  test("PLANTED: blocked hard-reject evidence cannot turn green by removing its own failure", async () => {
    const report = await partialRun();
    const forged = {
      ...report,
      // The exact edit someone would make to "clean up" a partial report.
      failures: report.failures.filter(
        (failure) =>
          failure !== "HARD_REJECT_SAMPLE_TOO_SMALL" &&
          failure !== "HARD_REJECT_EVIDENCE_UNAVAILABLE",
      ),
    };
    expect(() => assertPartialRunNotGreen(forged)).toThrow(PartialRunGreenError);
    expect(() => assertPartialRunNotGreen(forged)).toThrow(/HARD_REJECT_SAMPLE_TOO_SMALL/);
  });

  test("PLANTED: a partial report cannot claim the false-negative half was measured", async () => {
    const report = await partialRun();
    const forged = { ...report, unmeasured: [] as never[] };
    expect(() => assertPartialRunNotGreen(forged)).toThrow(PartialRunGreenError);

    const withoutBlocker = { ...report, blockers: [] as string[] };
    expect(() => assertPartialRunNotGreen(withoutBlocker)).toThrow(/protected-bodies blocker/);

    const zeroExit = { ...report, exit_code: 0 as unknown as typeof report.exit_code };
    expect(() => assertPartialRunNotGreen(zeroExit)).toThrow(/success exit code/);
  });

  test("a provider failure keeps the run blocked and leaves the FP metric unmeasured", async () => {
    const corpus = await createS4Corpus();
    const report = await runLegitimateOnlyScreening({
      corpus,
      provider: createFixtureScreeningProvider({
        onScreen: (exampleId) => {
          if (exampleId.endsWith("001")) throw new Error("provider exploded");
        },
      }),
      identity: FIXTURE_IDENTITY,
      evidence_class: "fixture-not-model-evidence",
    });
    expect(report.provider_failure_count).toBeGreaterThan(0);
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.failures).toContain("ACCURACY_METRICS_INCOMPLETE");
    // A fail-closed quarantine is the correct operational outcome, not a
    // classifier false positive. Only the 149 successful calls count as
    // observed coverage; the complete FP metric is explicitly unmeasured.
    expect(report.legitimate_false_positive_rate).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      wilson_95: null,
    });
    expect(report.legitimate_observed_count).toBe(149);
    expect(report.failures).toContain("LEGITIMATE_SAMPLE_TOO_SMALL");
    expect(report.unmeasured).toContain("legitimate_false_positive_rate");
    expect(report.verdict).toBe("blocked");
    expect(() => assertPartialRunNotGreen(report)).not.toThrow();
  });

  test("PLANTED NEGATIVE: a provider-wide outage blocks without fabricating a false-positive breach", async () => {
    const report = await runLegitimateOnlyScreening({
      corpus: await createS4Corpus(),
      provider: createFixtureScreeningProvider({
        onScreen: () => {
          throw new Error("provider unavailable");
        },
      }),
      identity: FIXTURE_IDENTITY,
      evidence_class: "fixture-not-model-evidence",
    });

    expect(report.provider_failure_count).toBe(150);
    expect(report.legitimate_observed_count).toBe(0);
    expect(report.legitimate_false_positive_rate).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      wilson_95: null,
    });
    expect(report.unmeasured).toContain("legitimate_false_positive_rate");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.failures).toContain("ACCURACY_METRICS_INCOMPLETE");
    expect(report.failures).not.toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    expect(report.failures).not.toContain("MODEL_VERSION_MISMATCH");
    expect(report.failures).not.toContain("POLICY_VERSION_MISMATCH");
    expect(report.failures).not.toContain("CONFIGURATION_DIGEST_MISMATCH");
    expect(report.verdict).toBe("blocked");
    expect(report.exit_code).toBe(PARTIAL_BLOCKED_EXIT_CODE);
  });

  test("PLANTED NEGATIVE: an unavailable legitimate reservation leaves FP unmeasured and is not called protected hard-reject evidence", async () => {
    const corpus = await createS4Corpus();
    const original = corpus.find((example) => example.ground_truth === "legitimate");
    if (original === undefined) throw new Error("expected a legitimate corpus example");
    const unavailableLegitimate = {
      ...original,
      body: undefined,
      body_digest: undefined,
      source: {
        ...original.source,
        kind: "protected-staging" as const,
        locator: "protected-staging:s4-legitimate/reserved-001",
        availability: "blocked" as const,
      },
    };
    const report = await runLegitimateOnlyScreening({
      corpus: corpus.map((example) =>
        example.id === original.id ? unavailableLegitimate : example,
      ),
      provider: createFixtureScreeningProvider(),
      identity: FIXTURE_IDENTITY,
      evidence_class: "fixture-not-model-evidence",
    });

    expect(report.reserved_by_ground_truth).toEqual({
      legitimate: 1,
      "hard-reject": 50,
      quarantine: 0,
    });
    expect(report.legitimate_false_positive_rate).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      wilson_95: null,
    });
    expect(report.legitimate_observed_count).toBe(149);
    expect(report.failures).toContain("LEGITIMATE_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("LEGITIMATE_EVIDENCE_UNAVAILABLE");
    expect(report.blockers).toContain("LEGITIMATE_BODY_UNAVAILABLE");
    // The actual protected hard-reject reservations are still named; the
    // dedicated legitimate reservation is not relabelled as one of them.
    expect(
      report.blockers.filter((blocker) => blocker === "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"),
    ).toHaveLength(1);
    expect(() => assertPartialRunNotGreen(report)).not.toThrow();
  });

  test("the ops record carries counts and versions but no body, excerpt or score band", async () => {
    const corpus = await createS4Corpus();
    const report = await partialRun();
    const record = JSON.parse(partialRunOpsJsonl(report)) as Record<string, unknown>;
    expect(record.record_type).toBe("screening-partial-aggregate");
    expect(record.evidence_class).toBe("fixture-not-model-evidence");
    expect(record.verdict).toBe("blocked");
    expect(record.unmeasured).toContain("hard_reject_false_negative_rate");
    expect(record.legitimate_observed_count).toBe(150);

    const serialized = partialRunOpsJsonl(report);
    // No corpus body or safe excerpt may appear in an operational record.
    for (const example of corpus.slice(0, 40)) {
      if (example.body) expect(serialized).not.toContain(example.body);
      expect(serialized).not.toContain(example.safe_excerpt);
    }
    expect(serialized).not.toContain("category_score_bands");
    expect(serialized).not.toContain("coarse_category");
  });

  test("PLANTED NEGATIVE: partial aggregation and its ops record reject unsafe identity metadata before publication", async () => {
    const { evaluable, reserved } = partitionEvaluableCorpus(await createS4Corpus());
    const provider = createFixtureScreeningProvider();
    const observations: ScreeningObservation[] = await Promise.all(
      evaluable.map((example) =>
        screenWithProvider(
          provider,
          {
            example_id: example.id,
            body_digest: example.body_digest as string,
            context_digest: example.body_digest as string,
            identity: FIXTURE_IDENTITY,
          },
          { timeout_ms: 10 },
        ),
      ),
    );
    const input = {
      corpus: evaluable,
      reserved,
      observations,
      identity: FIXTURE_IDENTITY,
      evidence_class: "fixture-not-model-evidence" as const,
    };
    const report = aggregatePartialScreeningRun(input);

    for (const model_version of ["asimp_ag_0123456789abcdef", "model version/unsafe"]) {
      expect(() =>
        aggregatePartialScreeningRun({
          ...input,
          identity: { ...FIXTURE_IDENTITY, model_version },
        }),
      ).toThrow("Run identity contains unsafe or malformed metadata");
      expect(() =>
        partialRunOpsJsonl({ ...report, identity: { ...report.identity, model_version } }),
      ).toThrow("Run identity contains unsafe or malformed metadata");
    }
  });
});
