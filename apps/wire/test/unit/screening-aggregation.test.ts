import { describe, expect, test } from "bun:test";
import {
  aggregateScreeningRun,
  type PolicyCategory,
  S4_THRESHOLDS,
  type ScreeningCorpusExample,
  type ScreeningObservation,
  type ScreeningRunIdentity,
  screenWithProvider,
} from "../../src/screening";

const identity: ScreeningRunIdentity = {
  corpus_revision: "s4-test-corpus-v1",
  corpus_digest: "sha256:test-corpus-v1",
  model_version: "llama-guard-test-v1",
  policy_version: "policy-test-v1",
  configuration_digest: "sha256:config-test-v1",
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
    const falsePositiveInterval = first.legitimate_false_positive_rate.wilson_95;
    expect(falsePositiveInterval).not.toBeNull();
    expect(falsePositiveInterval?.upper).toBeGreaterThan(0);
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

  test("PLANTED NEGATIVE: a legitimate false-positive rate of 8/150 fails the strict under-5-percent gate", () => {
    const entries = corpus();
    const overrides = Object.fromEntries(
      entries.slice(1, 9).map((entry) => [entry.id, { decision: "quarantine" as const }]),
    );
    const report = aggregateScreeningRun(entries, observations(entries, overrides), identity);

    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 8, denominator: 150 });
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

  test("provider outage quarantines and blocks rather than turning a metric run green", () => {
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
    expect(report.legitimate_false_positive_rate).toMatchObject({ numerator: 0, denominator: 149 });
    expect(report.verdict).toBe("blocked");
    expect(report.failures).toContain("PROVIDER_UNAVAILABLE_FAIL_CLOSED");
    expect(report.failures).toContain("ACCURACY_METRICS_INCOMPLETE");
    expect(report.failures).not.toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
    expect(report.operational_by_observed_category).toContainEqual({
      category: "provider-unavailable",
      observation_count: 1,
      provider_ok_count: 0,
      provider_failure_count: 1,
      decision_counts: { pass: 0, "allow-with-warning": 0, quarantine: 1, reject: 0 },
    });
  });

  test("provider timeout returns quarantine with no public decision path", async () => {
    const request = {
      example_id: "hard-001",
      body_digest: `sha256:${"a".repeat(64)}`,
      context_digest: "sha256:context-001",
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
      context_digest: "sha256:context-001",
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
      context_digest: "sha256:context-001",
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

  test("keeps the S-4 threshold contract explicit", () => {
    expect(S4_THRESHOLDS).toEqual({
      legitimate_false_positive_rate_exclusive_max: 0.05,
      hard_reject_false_negative_max: 0,
      minimum_legitimate_examples: 150,
      minimum_hard_reject_examples: 50,
    });
  });
});
