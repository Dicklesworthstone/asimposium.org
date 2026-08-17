import { describe, expect, test } from "bun:test";
import {
  ScreeningCoarseCategorySchema,
  ScreeningDecisionPathSchema,
  ScreeningOutcomeSchema,
  ScreeningProviderStatusSchema,
} from "@asimposium/contracts";
import {
  aggregateScreeningRun,
  type PolicyCategory,
  S4_THRESHOLDS,
  type ScreeningCorpusExample,
  type ScreeningObservation,
  type ScreeningRunIdentity,
  screenWithProvider,
} from "../../src/screening";
// Imported from the module rather than the barrel: this suite is asserting what
// `types.ts` itself publishes, so it must not read those values through a
// re-export that could be satisfied from somewhere else.
import {
  POLICY_CATEGORIES,
  PROVIDER_STATUSES,
  SCREENING_DECISIONS,
} from "../../src/screening/types.ts";

const identity: ScreeningRunIdentity = {
  corpus_revision: "s4-test-corpus-v1",
  corpus_digest: `sha256:${"c".repeat(64)}`,
  model_version: "llama-guard-test-v1",
  policy_version: "policy-test-v1",
  configuration_digest: `sha256:${"d".repeat(64)}`,
};

const scoreBands = (): Readonly<Record<PolicyCategory, "low" | undefined>> => ({
  "benign-context": "low",
  "spam-commercial": undefined,
  injection: undefined,
  "dual-use-boundary": undefined,
  "operational-harm": undefined,
  harassment: undefined,
  "sexual-content": undefined,
  "provider-unavailable": undefined,
});

function corpus(): ScreeningCorpusExample[] {
  const legitimate = Array.from({ length: 150 }, (_, index) => ({
    manifest_version: "s4-manifest-v2" as const,
    id: `legit-${String(index + 1).padStart(3, "0")}`,
    body_digest: `sha256:${String(index + 1).padStart(64, "0")}`,
    body: "Safe unit-fixture body; this is not staging evidence.",
    source: {
      kind: "inline-safe" as const,
      locator: "unit:screening-aggregation",
      version: "unit-v1",
      provenance: "unit-fixture",
      license: "test-only",
      availability: "available" as const,
    },
    ground_truth: "legitimate" as const,
    expected_outcome: "pass-or-warning" as const,
    policy_category: "benign-context" as const,
    stratum: index % 2 === 0 ? "weird-math" : "security-theory",
    rationale: "Structural unit fixture for deterministic aggregation.",
    safe_excerpt: "Safe fixture metadata only.",
    ...(index === 0 ? { sentinel: "legitimate-pass" as const } : {}),
  }));
  const hardReject = Array.from({ length: 50 }, (_, index) => ({
    manifest_version: "s4-manifest-v2" as const,
    id: `hard-${String(index + 1).padStart(3, "0")}`,
    body_digest: `sha256:${String(index + 151).padStart(64, "0")}`,
    body: "Protected-body stand-in for aggregation unit behavior only; not a live screening result.",
    source: {
      kind: "inline-safe" as const,
      locator: "unit:screening-aggregation",
      version: "unit-v1",
      provenance: "unit-fixture",
      license: "test-only",
      availability: "available" as const,
    },
    ground_truth: "hard-reject" as const,
    expected_outcome: "reject" as const,
    policy_category: (index % 2 === 0 ? "operational-harm" : "injection") as PolicyCategory,
    stratum: index % 2 === 0 ? "operational-harm" : "injection",
    rationale: "Structural unit fixture for false-negative aggregation.",
    safe_excerpt: "Protected-fixture metadata only.",
    ...(index < 10
      ? {
          aggregation_pair_id: `pair-${Math.floor(index / 2) + 1}`,
          aggregation_member: index % 2 === 0 ? ("a" as const) : ("b" as const),
        }
      : {}),
    ...(index === 0 ? { sentinel: "hard-reject" as const } : {}),
  }));
  return [...legitimate, ...hardReject];
}

function observations(
  entries: readonly ScreeningCorpusExample[],
  overrides: Readonly<Record<string, Partial<ScreeningObservation>>> = {},
): ScreeningObservation[] {
  return entries.map((entry) => ({
    example_id: entry.id,
    evaluated_body_digest: entry.body_digest as string,
    decision: entry.ground_truth === "hard-reject" ? "reject" : "pass",
    coarse_category: entry.policy_category,
    category_score_bands: scoreBands(),
    model_version: identity.model_version,
    policy_version: identity.policy_version,
    configuration_digest: identity.configuration_digest,
    provider_status: "ok",
    decision_path: "provider",
    status_code: "SCREENED",
    latency_ms: 12,
    retry_count: 0,
    ...overrides[entry.id],
  }));
}

describe("S-4 deterministic outcome aggregation", () => {
  test("reports the 150/50 corpus, confidence bounds, strata, pairs, and versions deterministically", () => {
    const entries = corpus();
    const first = aggregateScreeningRun(entries, observations(entries), identity);
    const second = aggregateScreeningRun(
      [...entries].reverse(),
      [...observations(entries)].reverse(),
      identity,
    );

    expect(first).toEqual(second);
    expect(first.verdict).toBe("pass");
    expect(first.legitimate_false_positive_rate).toMatchObject({
      numerator: 0,
      denominator: 150,
      rate: 0,
    });
    expect(first.hard_reject_false_negative_rate).toMatchObject({
      numerator: 0,
      denominator: 50,
      rate: 0,
    });
    expect(first.sentinel_controls).toEqual({
      declared: { "legitimate-pass": 1, "hard-reject": 1, "quarantine-hold": 0 },
      evaluated: { "legitimate-pass": 1, "hard-reject": 1, "quarantine-hold": 0 },
    });
    expect(first.legitimate_false_positive_rate.wilson_95).toEqual({
      confidence_level: 0.95,
      lower: 0,
      upper: 0.02497,
    });
    expect(first.hard_reject_false_negative_rate.wilson_95).toEqual({
      confidence_level: 0.95,
      lower: 0,
      upper: 0.071348,
    });
    expect(first.by_stratum.map((metric) => metric.label)).toEqual([
      "injection",
      "operational-harm",
      "security-theory",
      "weird-math",
    ]);
    expect(first.aggregation_pairs).toHaveLength(5);
    expect(
      first.aggregation_pairs.every(
        (pair) => pair.all_members_rejected && !pair.contains_public_escape,
      ),
    ).toBe(true);
    expect(first.model_versions).toEqual([identity.model_version]);
    expect(first.policy_versions).toEqual([identity.policy_version]);
  });

  test("PLANTED NEGATIVE: an adequate provider-ok legitimate sample of 8/150 fails the strict under-5-percent gate", () => {
    const entries = corpus();
    const overrides = Object.fromEntries(
      entries.slice(1, 9).map((entry) => [entry.id, { decision: "quarantine" as const }]),
    );
    const report = aggregateScreeningRun(entries, observations(entries, overrides), identity);

    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 8, denominator: 150 });
    expect(report.legitimate_false_positive_rate.denominator).toBe(
      S4_THRESHOLDS.minimum_legitimate_examples,
    );
    expect(report.verdict).toBe("fail");
    expect(report.failures).toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    expect(report.sentinel_failures).toEqual([]);
  });

  test("PLANTED NEGATIVE: a hard-reject result that is not reject fails FN=0 and exposes an aggregation escape", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { "hard-002": { decision: "allow-with-warning" } }),
      identity,
    );

    expect(report.hard_reject_false_negative_rate).toMatchObject({ numerator: 1, denominator: 50 });
    expect(report.verdict).toBe("fail");
    expect(report.failures).toContain("HARD_REJECT_FALSE_NEGATIVE_THRESHOLD_FAILED");
    expect(
      report.aggregation_pairs.find((pair) => pair.aggregation_pair_id === "pair-1")
        ?.contains_public_escape,
    ).toBe(true);
  });

  test("PLANTED NEGATIVE: a measured hard-reject escape remains a failure despite an unrelated timeout", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, {
        "hard-002": { decision: "allow-with-warning" },
        "legit-002": {
          decision: "quarantine",
          coarse_category: "provider-unavailable",
          provider_status: "timeout",
          decision_path: "provider-timeout-fail-closed",
          status_code: "SCREENING_PROVIDER_TIMEOUT",
        },
      }),
      identity,
    );

    expect(report.provider_failure_count).toBe(1);
    expect(report.hard_reject_false_negative_rate).toMatchObject({ numerator: 1, denominator: 50 });
    expect(report.failures).toContain("HARD_REJECT_FALSE_NEGATIVE_THRESHOLD_FAILED");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.verdict).toBe("fail");
  });

  test("PLANTED NEGATIVE: an available sentinel with a wrong result makes the run fail", () => {
    const entries = corpus();
    const hardRejectSentinel = entries.find((entry) => entry.sentinel === "hard-reject");
    expect(hardRejectSentinel?.source.availability).toBe("available");
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { "hard-001": { decision: "pass" } }),
      identity,
    );

    expect(report.sentinel_failures).toEqual([
      { example_id: "hard-001", expected: "reject", observed: "pass" },
    ]);
    expect(report.failures).toContain("SENTINEL_NEGATIVE_DETECTED");
    expect(report.verdict).toBe("fail");
  });

  test("PLANTED NEGATIVE: an observation with the wrong evaluated body digest is refused before metrics", () => {
    const entries = corpus();
    const badDigest = `sha256:${"f".repeat(64)}`;
    expect(() =>
      aggregateScreeningRun(
        entries,
        observations(entries, { "hard-002": { evaluated_body_digest: badDigest } }),
        identity,
      ),
    ).toThrow("not bound to the body digest");
  });

  test("PLANTED NEGATIVE: full aggregation refuses a manifest source that is not available", () => {
    const entries = corpus();
    const first = entries[0];
    if (!first) throw new Error("expected legitimate fixture");
    entries[0] = { ...first, source: { ...first.source, availability: "blocked" } };

    expect(() => aggregateScreeningRun(entries, observations(entries), identity)).toThrow(
      "source material must be available",
    );
  });

  test("PLANTED NEGATIVE: a sentinel kind must agree with both ground truth and expected outcome", () => {
    const entries = corpus();
    const firstHardReject = entries[150];
    if (!firstHardReject) throw new Error("expected hard-reject fixture");
    entries[150] = { ...firstHardReject, sentinel: "legitimate-pass" };

    expect(() => aggregateScreeningRun(entries, observations(entries), identity)).toThrow(
      "sentinel conflicts with its declared ground truth or expected outcome",
    );
  });

  test("PLANTED NEGATIVE: a non-hard-reject aggregation member is refused", () => {
    const entries = corpus();
    const legitimateExample = entries[1];
    if (!legitimateExample) throw new Error("expected legitimate fixture at index 1");
    entries[1] = {
      ...legitimateExample,
      aggregation_pair_id: "pair-illegal",
      aggregation_member: "a",
    };
    expect(() => aggregateScreeningRun(entries, observations(entries), identity)).toThrow(
      "reserved for hard-reject recall controls",
    );
  });

  test("keeps a ground-truth quarantine example outside both FP and FN denominators", () => {
    const entries = corpus();
    entries.push({
      manifest_version: "s4-manifest-v2",
      id: "quarantine-001",
      body_digest: `sha256:${"c".repeat(64)}`,
      body: "Ambiguous unit-fixture body; this is not staging evidence.",
      source: {
        kind: "inline-safe",
        locator: "unit:screening-aggregation",
        version: "unit-v1",
        provenance: "unit-fixture",
        license: "test-only",
        availability: "available",
      },
      ground_truth: "quarantine",
      expected_outcome: "quarantine",
      policy_category: "injection",
      stratum: "ambiguous-boundary",
      rationale: "Ambiguous fixtures assess routing, not model accuracy thresholds.",
      safe_excerpt: "Ambiguous fixture metadata only.",
    });
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { "quarantine-001": { decision: "quarantine" } }),
      identity,
    );

    expect(report.observation_count).toBe(201);
    expect(report.legitimate_false_positive_rate.denominator).toBe(150);
    expect(report.hard_reject_false_negative_rate.denominator).toBe(50);
    expect(report.verdict).toBe("pass");
  });

  test("a provider outage leaves that row unmeasured and blocks, never green", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, {
        "legit-002": {
          decision: "quarantine",
          coarse_category: "provider-unavailable",
          provider_status: "timeout",
          decision_path: "provider-timeout-fail-closed",
          status_code: "SCREENING_PROVIDER_TIMEOUT",
        },
      }),
      identity,
    );

    expect(report.provider_failure_count).toBe(1);
    expect(report.provider_ok_observation_count).toBe(199);
    // The timed-out legitimate sample was fail-closed to quarantine, which is
    // the correct write-path outcome but not a classifier result: the model
    // never answered. It leaves the accuracy denominator rather than being
    // reported as a measured false positive.
    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 0, denominator: 149 });
    expect(report.failures).not.toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    // The manifest still carries the required 150 examples. The outage blocks
    // evidence collection rather than misclassifying its size as terminally
    // inadequate.
    expect(report.failures).not.toContain("LEGITIMATE_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.failures).toContain("ACCURACY_METRICS_INCOMPLETE");
    expect(report.verdict).toBe("blocked");
    expect(report.operational_by_observed_category).toContainEqual({
      category: "provider-unavailable",
      observation_count: 1,
      provider_ok_count: 0,
      provider_failure_count: 1,
      decision_counts: { pass: 0, "allow-with-warning": 0, quarantine: 1, reject: 0 },
    });
  });

  test("PLANTED NEGATIVE: eight provider errors are unmeasured evidence, and still cannot pass", () => {
    const entries = corpus();
    const providerErrors = Object.fromEntries(
      entries.slice(0, 8).map((entry) => [
        entry.id,
        {
          decision: "quarantine" as const,
          coarse_category: "provider-unavailable" as const,
          provider_status: "error" as const,
          decision_path: "provider-error-fail-closed" as const,
          status_code: "SCREENING_PROVIDER_ERROR" as const,
        },
      ]),
    );
    const report = aggregateScreeningRun(entries, observations(entries, providerErrors), identity);

    // Eight bodies the provider never classified are eight bodies of unmeasured
    // evidence, not eight over-refusals by the screen. Charging them to the FP
    // rate would make the published accuracy number a function of provider
    // health in the wrong direction, inventing a classifier defect from an
    // outage.
    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 0, denominator: 142 });
    expect(report.failures).not.toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    // The manifest still meets its floor; unmeasured provider responses are a
    // blocked run, not a false terminal corpus-size defect.
    expect(report.failures).not.toContain("LEGITIMATE_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.failures).toContain("ACCURACY_METRICS_INCOMPLETE");
    expect(report.verdict).toBe("blocked");
  });

  test("provider timeout returns quarantine with no public decision path", async () => {
    const request = {
      example_id: "hard-001",
      body_digest: `sha256:${"a".repeat(64)}`,
      context_digest: `sha256:${"b".repeat(64)}`,
      identity,
    };
    const observation = await screenWithProvider(
      {
        screen: async (_request, signal) =>
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      },
      request,
      { timeout_ms: 1 },
    );

    expect(observation).toMatchObject({
      decision: "quarantine",
      provider_status: "timeout",
      decision_path: "provider-timeout-fail-closed",
      status_code: "SCREENING_PROVIDER_TIMEOUT",
    });
    expect(observation.retry_count).toBe(0);
  });

  test("provider that ignores AbortSignal still returns a fail-closed timeout by the deadline", async () => {
    const request = {
      example_id: "hard-001",
      body_digest: `sha256:${"a".repeat(64)}`,
      context_digest: `sha256:${"b".repeat(64)}`,
      identity,
    };
    const result = await Promise.race([
      screenWithProvider({ screen: async () => await new Promise<never>(() => {}) }, request, {
        timeout_ms: 1,
      }),
      new Promise<"test-deadline-exceeded">((resolve) =>
        setTimeout(() => resolve("test-deadline-exceeded"), 100),
      ),
    ]);

    expect(result).not.toBe("test-deadline-exceeded");
    expect(result).toMatchObject({
      decision: "quarantine",
      provider_status: "timeout",
      status_code: "SCREENING_PROVIDER_TIMEOUT",
    });
  });

  test("invalid provider response and invalid timeout values fail closed rather than trusting caller metadata", async () => {
    const request = {
      example_id: "hard-001",
      body_digest: `sha256:${"a".repeat(64)}`,
      context_digest: `sha256:${"b".repeat(64)}`,
      identity,
    };
    const observation = await screenWithProvider(
      {
        screen: async () =>
          ({
            decision: "pass",
            coarse_category: "benign-context",
            category_score_bands: {},
          }) as never,
      },
      request,
      { timeout_ms: 10 },
    );

    expect(observation).toMatchObject({
      decision: "quarantine",
      provider_status: "error",
      status_code: "SCREENING_PROVIDER_ERROR",
      retry_count: 0,
    });
    await expect(
      screenWithProvider({ screen: async () => ({}) as never }, request, { timeout_ms: 0 }),
    ).rejects.toThrow("timeout_ms");
  });

  test("PLANTED NEGATIVE: retry and path/status inconsistencies are refused from staging output", () => {
    const entries = corpus();
    expect(() =>
      aggregateScreeningRun(
        entries,
        observations(entries, { "legit-002": { retry_count: 1 } }),
        identity,
      ),
    ).toThrow("retries are unsupported");
    expect(() =>
      aggregateScreeningRun(
        entries,
        observations(entries, {
          "legit-002": {
            provider_status: "timeout",
            decision_path: "provider",
            status_code: "SCREENED",
          },
        }),
        identity,
      ),
    ).toThrow("decision path or status is inconsistent");
  });

  test("refuses a run whose reported policy version differs from the run identity", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { "legit-002": { policy_version: "other-policy" } }),
      identity,
    );

    expect(report.verdict).toBe("fail");
    expect(report.failures).toContain("POLICY_VERSION_MISMATCH");
  });

  test("PLANTED NEGATIVE: corpus and configuration identities require SHA-256 digests", () => {
    const entries = corpus();
    expect(() =>
      aggregateScreeningRun(entries, observations(entries), {
        ...identity,
        corpus_digest: "sha256:not-a-digest",
      }),
    ).toThrow("Run identity contains unsafe or malformed metadata");
    expect(() =>
      aggregateScreeningRun(entries, observations(entries), {
        ...identity,
        configuration_digest: "sha256:not-a-digest",
      }),
    ).toThrow("Run identity contains unsafe or malformed metadata");
  });

  test("PLANTED NEGATIVE: direct provider requests reject secret-shaped metadata before emitting an observation", async () => {
    const request = {
      example_id: "hard-001",
      body_digest: `sha256:${"a".repeat(64)}`,
      context_digest: `sha256:${"b".repeat(64)}`,
      identity: { ...identity, model_version: "sk_live_51h8xyzabcdefghijklmnop" },
    };
    await expect(
      screenWithProvider(
        {
          screen: async () => ({
            decision: "reject",
            coarse_category: "operational-harm",
            category_score_bands: scoreBands(),
          }),
        },
        request,
        { timeout_ms: 10 },
      ),
    ).rejects.toThrow("Screening request metadata is unsafe or malformed");
  });

  test("PLANTED NEGATIVE: provider ingress rejects secret-shaped and bare high-entropy example ids before calling the provider", async () => {
    let providerCalls = 0;
    const provider = {
      screen: async () => {
        providerCalls += 1;
        return {
          decision: "reject" as const,
          coarse_category: "operational-harm" as const,
          category_score_bands: scoreBands(),
        };
      },
    };
    for (const example_id of ["asimp_ag_0123456789abcdef", "A9k3Q7m2V8x4N6p1R5t0Y3w7"]) {
      await expect(
        screenWithProvider(
          provider,
          {
            example_id,
            body_digest: `sha256:${"a".repeat(64)}`,
            context_digest: `sha256:${"b".repeat(64)}`,
            identity,
          },
          { timeout_ms: 10 },
        ),
      ).rejects.toThrow("Screening request metadata is unsafe or malformed");
    }
    expect(providerCalls).toBe(0);
  });

  const providerFailure = {
    decision: "quarantine" as const,
    coarse_category: "provider-unavailable" as const,
    provider_status: "timeout" as const,
    decision_path: "provider-timeout-fail-closed" as const,
    status_code: "SCREENING_PROVIDER_TIMEOUT" as const,
  };

  test("PLANTED NEGATIVE: an undersized corpus stays a failure when a provider also times out", () => {
    const entries = corpus();
    // One legitimate and two hard-reject rows against required minimums of 150
    // and 50. Both sentinels are retained and `pair-1` is kept whole, so the
    // only thing this run is short of is corpus size.
    const undersized = [
      entries[0] as ScreeningCorpusExample,
      entries[150] as ScreeningCorpusExample,
      entries[151] as ScreeningCorpusExample,
    ];
    const report = aggregateScreeningRun(
      undersized,
      observations(undersized, { "legit-001": providerFailure }),
      identity,
    );

    // Gating adequacy on a clean run let a single timeout convert "this corpus
    // is two rows" into "provider unavailable, retry later". Corpus adequacy is
    // a property of the manifest; an outage cannot excuse a structural defect.
    expect(report.failures).toContain("LEGITIMATE_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("HARD_REJECT_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.verdict).toBe("fail");
  });

  test("provider-ok legitimate rows below the floor because of outages block rather than fail", () => {
    const entries = corpus();
    const timeouts = Object.fromEntries(
      entries.slice(1, 150).map((entry) => [entry.id, providerFailure]),
    );
    const report = aggregateScreeningRun(entries, observations(entries, timeouts), identity);

    // Only one legitimate row reached the provider, so the exact FP denominator
    // remains one. The 150-row manifest is nevertheless adequate; outages are
    // retryable evidence loss, not a terminal corpus defect.
    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 0, denominator: 1 });
    expect(report.failures).not.toContain("LEGITIMATE_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.verdict).toBe("blocked");
  });

  test("a subminimum provider-ok legitimate sample blocks even when its measured FP ratio exceeds the bar", () => {
    const entries = corpus();
    const falsePositives = Object.fromEntries(
      entries.slice(1, 9).map((entry) => [entry.id, { decision: "reject" as const }]),
    );
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { ...falsePositives, "legit-150": providerFailure }),
      identity,
    );

    // 8/149 exceeds five percent, but 149 is below the 150-row provider-ok
    // floor. The timeout makes this evidence incomplete and blocked; it cannot
    // become a terminal FP failure from a subminimum denominator.
    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 8, denominator: 149 });
    expect(report.failures).not.toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.verdict).toBe("blocked");
  });

  test("provider-ok hard-reject rows below the floor because of outages block rather than fail", () => {
    const entries = corpus();
    const timeouts = Object.fromEntries(
      entries.slice(151).map((entry) => [entry.id, providerFailure]),
    );
    const report = aggregateScreeningRun(entries, observations(entries, timeouts), identity);

    expect(report.hard_reject_false_negative_rate).toMatchObject({ numerator: 0, denominator: 1 });
    expect(report.failures).not.toContain("HARD_REJECT_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.verdict).toBe("blocked");
  });

  test("PLANTED NEGATIVE: a declared quarantine floor fails even when provider evidence is incomplete", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { "legit-002": providerFailure }),
      identity,
      { ...S4_THRESHOLDS, minimum_quarantine_examples: 1 },
    );

    expect(report.failures).toContain("QUARANTINE_SAMPLE_TOO_SMALL");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.verdict).toBe("fail");
  });

  test("a measured false positive is counted while an unrelated timeout is not", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, {
        "legit-002": { decision: "reject" },
        "legit-003": providerFailure,
      }),
      identity,
    );

    // The screen answered on legit-002 and over-refused: that is a real FP. It
    // never answered on legit-003: that is not. Both directions in one run.
    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 1, denominator: 149 });
  });

  test("a grouped stratum rate cannot disagree with the headline rate about an outage", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { "legit-002": providerFailure }),
      identity,
    );
    const stratum = report.by_stratum.find((entry) => entry.label === "security-theory");

    // legit-002 is one of the 75 security-theory rows. If `metricFor` kept the
    // old all-legitimates rule, this denominator would read 75 and the stratum
    // face would contradict the run-level metric about the same observation.
    expect(stratum?.false_positive_rate).toMatchObject({ numerator: 0, denominator: 74 });
  });

  test("PLANTED NEGATIVE: a corpus with its sentinel controls removed cannot report pass", () => {
    const stripped = corpus().map(({ sentinel: _sentinel, ...entry }) => entry);
    const report = aggregateScreeningRun(stripped, observations(stripped), identity);

    // Without a presence floor this run is byte-identical to a clean one: same
    // verdict, same empty `sentinel_failures`. Deleting the controls would
    // delete the alarm.
    expect(report.sentinel_failures).toEqual([]);
    expect(report.sentinel_controls.declared).toEqual({
      "legitimate-pass": 0,
      "hard-reject": 0,
      "quarantine-hold": 0,
    });
    expect(report.failures).toContain("SENTINEL_CONTROLS_MISSING");
    expect(report.verdict).toBe("fail");
  });

  test("a sentinel whose provider failed is present but not exercised", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, { "hard-001": providerFailure }),
      identity,
    );

    // Present, so it is not a missing control; unevaluated, so it proves
    // nothing about the screen. Reporting only one of those two numbers would
    // make an unanswered control look like an exercised one.
    expect(report.sentinel_controls.declared["hard-reject"]).toBe(1);
    expect(report.sentinel_controls.evaluated["hard-reject"]).toBe(0);
    expect(report.sentinel_controls.evaluated["legitimate-pass"]).toBe(1);
    expect(report.failures).not.toContain("SENTINEL_CONTROLS_MISSING");
    // Correctness is judged only over provider-ok rows, so an outage is never a
    // failed sentinel.
    expect(report.sentinel_failures).toEqual([]);
  });

  test("a directly observed hard-reject escape survives an unrelated outage", () => {
    const entries = corpus();
    const report = aggregateScreeningRun(
      entries,
      observations(entries, {
        "hard-002": { decision: "pass" },
        "legit-004": providerFailure,
      }),
      identity,
    );

    // The provider answered on hard-002 and published a hard-reject body. No
    // amount of unrelated unavailability may downgrade that to merely blocked.
    expect(report.failures).toContain("HARD_REJECT_FALSE_NEGATIVE_THRESHOLD_FAILED");
    expect(report.verdict).toBe("fail");
  });

  test("threshold decisions use the exact ratio, not the published rounded rate", () => {
    const entries = corpus();
    // Seven over-refusals, skipping legit-001 so the legitimate-pass sentinel
    // still passes and only the FP threshold is under test.
    const falsePositives = Object.fromEntries(
      entries.slice(1, 8).map((entry) => [entry.id, { decision: "reject" as const }]),
    );
    // 7/150 is 0.0466666..., strictly below this bar, but rounds up onto it for
    // display. Comparing the published number would fail a run that passed.
    const report = aggregateScreeningRun(entries, observations(entries, falsePositives), identity, {
      ...S4_THRESHOLDS,
      legitimate_false_positive_rate_exclusive_max: 0.046667,
    });

    expect(report.legitimate_false_positive_rate.rate).toBe(0.046667);
    expect(report.failures).not.toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    expect(report.verdict).toBe("pass");
  });

  test("PLANTED NEGATIVE: high-entropy labels are refused even when a separator hides them", () => {
    const entries = corpus();
    const bare = "aB3xK9mQ2pL7vT4nR8wZ5yE1";
    for (const planted of [
      bare,
      `${bare}.h`,
      `${bare}_h`,
      "abcdefghijklmnopqrstuvwxyzabcdefghijklmn",
    ]) {
      expect(() =>
        aggregateScreeningRun(entries, observations(entries), {
          ...identity,
          model_version: planted,
        }),
      ).toThrow(/unsafe or malformed/);
    }
  });

  test("natural stratum names are accepted while credential assignments and token-shaped values are refused", () => {
    const entries = corpus();
    const first = entries[0];
    if (!first) throw new Error("expected legitimate fixture");
    for (const stratum of [
      "Operator Theory (Spectral)",
      "token smuggling",
      "authorization laundering",
      "credential tokenization",
    ]) {
      entries[0] = { ...first, stratum };
      const report = aggregateScreeningRun(entries, observations(entries), identity);
      expect(report.by_stratum.map((metric) => metric.label)).toContain(stratum);
    }

    for (const stratum of [
      "token=short-assignment",
      "authorization: bearer-value",
      "credential abcdefghijklmnop",
      "sk-live-abcdefghijklmnop",
    ]) {
      entries[0] = { ...first, stratum };
      expect(() => aggregateScreeningRun(entries, observations(entries), identity)).toThrow(
        "unsafe diagnostic label",
      );
    }
  });

  test("realistic separator-joined labels still validate after the entropy tightening", () => {
    const entries = corpus();
    // Positive control: the tightened predicate must not refuse the structured
    // version strings the frozen manifest actually uses.
    for (const safe of [
      "fixture-deterministic-v1-not-a-model",
      "s4-manifest-2026-08-13-v2",
      "llama-guard-test-v1",
    ]) {
      const safeIdentity = { ...identity, model_version: safe };
      const report = aggregateScreeningRun(
        entries,
        observations(entries).map((observation) => ({ ...observation, model_version: safe })),
        safeIdentity,
      );
      expect(report.verdict).toBe("pass");
    }
  });

  test("keeps the S-4 threshold contract explicit", () => {
    expect(S4_THRESHOLDS).toEqual({
      legitimate_false_positive_rate_exclusive_max: 0.05,
      hard_reject_false_negative_max: 0,
      minimum_legitimate_examples: 150,
      minimum_hard_reject_examples: 50,
      // The quarantine class: a publish is capped at a count of zero because it
      // is a safety event, an over-refusal shares the 5% bar with the legitimate
      // false-positive rate, and the sample minimum stays zero until a corpus
      // revision actually adds the examples.
      quarantine_publish_max: 0,
      quarantine_over_refusal_rate_exclusive_max: 0.05,
      minimum_quarantine_examples: 0,
      // Should-fail controls the corpus must carry. `quarantine-hold` stays at
      // zero in step with `minimum_quarantine_examples`; raise them together.
      minimum_sentinel_controls: {
        "legitimate-pass": 1,
        "hard-reject": 1,
        "quarantine-hold": 0,
      },
    });
  });
});

/**
 * S-4 G0 contract-drift closure.
 *
 * `types.ts` used to restate the decision, provider-status, and category
 * vocabularies as its own literals. Three copies of one vocabulary agreed by
 * hand and nothing kept them agreeing, which is what AGENTS.md forbids under
 * "do not hand-write a second schema". These assertions are the machine-checkable
 * statement that the wire module now *reads* the contract rather than echoing it.
 *
 * Each vocabulary is checked twice on purpose. The parity arm catches wire
 * diverging from the contract. The frozen arm catches the contract itself
 * gaining or losing a literal, because a vocabulary that moves on both sides at
 * once would satisfy parity while silently changing what this Worker screens.
 */
describe("screening vocabularies are read from the contract, not transcribed", () => {
  const sameVocabulary = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  test("wire vocabularies are the contract enums, member for member and in order", () => {
    expect(sameVocabulary(SCREENING_DECISIONS, ScreeningOutcomeSchema.options)).toBe(true);
    expect(sameVocabulary(PROVIDER_STATUSES, ScreeningProviderStatusSchema.options)).toBe(true);
    expect(sameVocabulary(POLICY_CATEGORIES, ScreeningCoarseCategorySchema.options)).toBe(true);
  });

  test("the frozen S-4 vocabulary is exactly what both sides carry today", () => {
    expect([...SCREENING_DECISIONS]).toEqual([
      "pass",
      "allow-with-warning",
      "quarantine",
      "reject",
    ]);
    expect([...PROVIDER_STATUSES]).toEqual(["ok", "timeout", "error"]);
    expect([...POLICY_CATEGORIES]).toEqual([
      "benign-context",
      "spam-commercial",
      "injection",
      "dual-use-boundary",
      "operational-harm",
      "harassment",
      "sexual-content",
      "provider-unavailable",
    ]);
    expect([...ScreeningDecisionPathSchema.options]).toEqual([
      "provider",
      "provider-contextual-hold",
      "direct-content-hold",
      "direct-content-reject",
      "direct-content-warning",
      "provider-timeout-fail-closed",
      "provider-error-fail-closed",
      "benign-outage-degraded",
    ]);
  });

  test("PLANTED DRIFT: one extra literal on either side is a mismatch", () => {
    expect(
      sameVocabulary(
        [...SCREENING_DECISIONS, "silently-published"],
        ScreeningOutcomeSchema.options,
      ),
    ).toBe(false);
    expect(
      sameVocabulary(SCREENING_DECISIONS, [
        ...ScreeningOutcomeSchema.options,
        "silently-published",
      ]),
    ).toBe(false);
    expect(
      sameVocabulary([...POLICY_CATEGORIES, "off-scope"], ScreeningCoarseCategorySchema.options),
    ).toBe(false);
  });

  test("PLANTED DRIFT: one missing literal on either side is a mismatch", () => {
    expect(sameVocabulary(SCREENING_DECISIONS.slice(0, -1), ScreeningOutcomeSchema.options)).toBe(
      false,
    );
    expect(sameVocabulary(POLICY_CATEGORIES, ScreeningCoarseCategorySchema.options.slice(1))).toBe(
      false,
    );
    expect(
      sameVocabulary(PROVIDER_STATUSES.slice(0, 2), ScreeningProviderStatusSchema.options),
    ).toBe(false);
  });

  test("PLANTED DRIFT: a renamed literal is a mismatch even at equal length", () => {
    const renamed = POLICY_CATEGORIES.map((value) =>
      value === "dual-use-boundary" ? "dual-use" : value,
    );
    expect(renamed.length).toBe(POLICY_CATEGORIES.length);
    expect(sameVocabulary(renamed, ScreeningCoarseCategorySchema.options)).toBe(false);
  });
});
