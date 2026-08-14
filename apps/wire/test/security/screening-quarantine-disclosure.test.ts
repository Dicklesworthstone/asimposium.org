import { expect, test } from "bun:test";

import {
  aggregateScreeningRun,
  isSafeScreeningDiagnosticLabel,
} from "../../src/screening/aggregate";
import { screeningOpsJsonl } from "../../src/screening/report";
import {
  POLICY_CATEGORIES,
  S4_THRESHOLDS,
  type ScreeningCorpusExample,
  type ScreeningObservation,
} from "../../src/screening/types";

/**
 * The quarantine class added two report fields, so it gets the same canary
 * treatment as every other screening record: a new metric must not become a new
 * disclosure path. Numbers and nulls only — no body, excerpt, prompt, band, or
 * credential, including on the boundary case that was held.
 */

const CANARY_BODY = "quarantine-body-canary-do-not-log";
const CANARY_EXCERPT = "quarantine-excerpt-canary-do-not-log";
const CANARY_TOKEN = "asimp_ag_quarantinecanary00000000";

const BANDS = Object.fromEntries(
  POLICY_CATEGORIES.map((category) => [category, "high"]),
) as ScreeningObservation["category_score_bands"];

const IDENTITY = {
  corpus_revision: "quarantine-disclosure-fixture",
  corpus_digest: `sha256:${"e".repeat(64)}`,
  model_version: "fixture-model",
  policy_version: "fixture-policy",
  configuration_digest: `sha256:${"f".repeat(64)}`,
};

function fixture(
  index: number,
  groundTruth: ScreeningCorpusExample["ground_truth"],
  overrides: Partial<ScreeningCorpusExample> = {},
): ScreeningCorpusExample {
  return {
    manifest_version: "s4-manifest-v2",
    id: `disclosure-${groundTruth}-${index}`,
    body: `safe fixture body ${index}`,
    body_digest: `sha256:${index.toString(16).padStart(64, "0")}`,
    source: {
      kind: "inline-safe",
      locator: `fixture:${index}`,
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
    rationale: `fixture ${index}`,
    safe_excerpt: `fixture ${index}`,
    ...overrides,
  };
}

test("the quarantine metrics add no disclosure path", () => {
  const corpus: readonly ScreeningCorpusExample[] = [
    fixture(1, "legitimate", { sentinel: "legitimate-pass" }),
    fixture(2, "hard-reject", { sentinel: "hard-reject" }),
    // Every free-text field on the held case carries a canary, including the
    // body and the excerpt a careless emitter would reach for first.
    fixture(3, "quarantine", {
      body: CANARY_BODY,
      safe_excerpt: CANARY_EXCERPT,
      rationale: `${CANARY_EXCERPT} ${CANARY_TOKEN}`,
      sentinel: "quarantine-hold",
    }),
  ];
  const observations: readonly ScreeningObservation[] = corpus.map((example) => ({
    example_id: example.id,
    evaluated_body_digest: example.body_digest as string,
    decision:
      example.ground_truth === "hard-reject"
        ? "reject"
        : example.ground_truth === "quarantine"
          ? "quarantine"
          : "pass",
    coarse_category: example.policy_category,
    // Bands are populated here on purpose: the emitter must drop them even when
    // the provider supplied a value for every category.
    category_score_bands: BANDS,
    model_version: IDENTITY.model_version,
    policy_version: IDENTITY.policy_version,
    configuration_digest: IDENTITY.configuration_digest,
    provider_status: "ok",
    decision_path: "provider",
    status_code: "SCREENED",
    latency_ms: 11,
    retry_count: 0,
  }));

  const report = aggregateScreeningRun(corpus, observations, IDENTITY, {
    ...S4_THRESHOLDS,
    minimum_legitimate_examples: 1,
    minimum_hard_reject_examples: 1,
  });
  const jsonl = screeningOpsJsonl(corpus, observations, report);

  for (const canary of [CANARY_BODY, CANARY_EXCERPT, CANARY_TOKEN]) {
    expect(jsonl).not.toContain(canary);
  }
  expect(jsonl).not.toContain("category_score_bands");
  expect(jsonl).not.toContain("safe_excerpt");
  expect(jsonl).not.toContain("rationale");
  expect(jsonl).not.toContain("prompt");
  expect(jsonl).not.toContain("high");

  // The new fields are present, and carry only numbers, nulls, and a fixed level.
  const aggregate = JSON.parse(jsonl.trim().split("\n").at(-1) as string) as Record<
    string,
    unknown
  >;
  for (const field of ["quarantine_publish_rate", "quarantine_over_refusal_rate"] as const) {
    const metric = aggregate[field] as Record<string, unknown>;
    expect(Object.keys(metric).sort()).toEqual(["denominator", "numerator", "rate", "wilson_95"]);
    for (const value of [metric.numerator, metric.denominator]) expect(typeof value).toBe("number");
    expect(metric.rate === null || typeof metric.rate === "number").toBe(true);
  }
  // The held sentinel produced no failure, so no sentinel record can carry text.
  expect(aggregate.sentinel_failures).toEqual([]);
  expect(report.verdict).toBe("pass");
});

/**
 * The direct key probe on the screening side.
 *
 * `stratum` is free-form manifest text that becomes a `by_stratum` label in the
 * report and in the emitted stream — a diagnostic field carrying a value from
 * outside this module. It therefore has to clear the same bar as an id, or a
 * corpus entry could route a credential into records that are otherwise
 * digest-only.
 */
test("PLANTED NEGATIVE: a credential-shaped stratum label is refused, not labelled", () => {
  /** `[label, the fragment that must never appear in any diagnostic]`. */
  const hostileStrata: readonly [string, string][] = [
    ["asimp_ag_01jqzx9y2k4m7p8rsecret", "01jqzx9y2k4m7p8rsecret"],
    ["sk_live_51h8xyzabcdefghijklmnop", "51h8xyzabcdefghijklmnop"],
    ["v1.s3cr3tfragmentvalue0123", "s3cr3tfragmentvalue0123"],
    ["a1b2c3d4e5f6a7b8c9d0e1f2", "a1b2c3d4e5f6a7b8c9d0e1f2"],
    ["bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["label\nwith-newline", "with-newline"],
    [`over-long-${"z".repeat(200)}`, "zzzzzzzzzzzz"],
    ["🔑", "🔑"],
  ];
  for (const [stratum, forbidden] of hostileStrata) {
    const corpus: readonly ScreeningCorpusExample[] = [
      fixture(1, "legitimate"),
      fixture(2, "hard-reject", { stratum }),
    ];
    const observations: readonly ScreeningObservation[] = corpus.map((example) => ({
      example_id: example.id,
      evaluated_body_digest: example.body_digest as string,
      decision: example.ground_truth === "hard-reject" ? "reject" : "pass",
      coarse_category: example.policy_category,
      category_score_bands: BANDS,
      model_version: IDENTITY.model_version,
      policy_version: IDENTITY.policy_version,
      configuration_digest: IDENTITY.configuration_digest,
      provider_status: "ok",
      decision_path: "provider",
      status_code: "SCREENED",
      latency_ms: 4,
      retry_count: 0,
    }));

    let refused = false;
    let message = "";
    try {
      aggregateScreeningRun(corpus, observations, IDENTITY, {
        ...S4_THRESHOLDS,
        minimum_legitimate_examples: 1,
        minimum_hard_reject_examples: 1,
      });
    } catch (error) {
      refused = true;
      message = (error as Error).message;
    }
    expect(refused).toBe(true);
    // The refusal is fixed text: neither the offending label nor unrelated
    // caller metadata is reflected into diagnostics.
    expect(message).not.toContain("disclosure-hard-reject-2");
    expect(message).not.toContain(stratum);
    expect(message).not.toContain(forbidden);
  }
});

test("PLANTED NEGATIVE: secret-shaped run metadata is refused without echo", () => {
  const canary = "sk_live_51h8xyzabcdefghijklmnop";
  const corpus: readonly ScreeningCorpusExample[] = [
    fixture(1, "legitimate"),
    fixture(2, "hard-reject"),
  ];
  const observations: readonly ScreeningObservation[] = corpus.map((example) => ({
    example_id: example.id,
    evaluated_body_digest: example.body_digest as string,
    decision: example.ground_truth === "hard-reject" ? "reject" : "pass",
    coarse_category: example.policy_category,
    category_score_bands: BANDS,
    model_version: IDENTITY.model_version,
    policy_version: IDENTITY.policy_version,
    configuration_digest: IDENTITY.configuration_digest,
    provider_status: "ok",
    decision_path: "provider",
    status_code: "SCREENED",
    latency_ms: 4,
    retry_count: 0,
  }));

  let message = "";
  try {
    aggregateScreeningRun(
      corpus,
      observations,
      { ...IDENTITY, model_version: canary },
      {
        ...S4_THRESHOLDS,
        minimum_legitimate_examples: 1,
        minimum_hard_reject_examples: 1,
      },
    );
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toBe("Run identity contains unsafe or malformed metadata.");
  expect(message).not.toContain(canary);
});

test("PLANTED NEGATIVE: modern token families are refused as metadata without logging their values", () => {
  const tokenFamilies = [
    "ya29.a0argrxeabcdefghijklmnop",
    "sk-proj-51h8xyzabcdefghijklmnop",
    "sk-svcacct-51h8xyzabcdefghijklmnop",
    "gho_abcdefghijklmnopqrstuvwxyz012345",
    "xoxp-1234567890-abcdefghijklmnop",
    "AKIAIOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signaturefragment",
  ];
  const corpus: readonly ScreeningCorpusExample[] = [
    fixture(1, "legitimate"),
    fixture(2, "hard-reject"),
  ];
  for (const token of tokenFamilies) {
    expect(isSafeScreeningDiagnosticLabel(token)).toBe(false);
    const observations: readonly ScreeningObservation[] = corpus.map((example) => ({
      example_id: example.id,
      evaluated_body_digest: example.body_digest as string,
      decision: example.ground_truth === "hard-reject" ? "reject" : "pass",
      coarse_category: example.policy_category,
      category_score_bands: BANDS,
      model_version: token,
      policy_version: IDENTITY.policy_version,
      configuration_digest: IDENTITY.configuration_digest,
      provider_status: "ok",
      decision_path: "provider",
      status_code: "SCREENED",
      latency_ms: 4,
      retry_count: 0,
    }));
    let message = "";
    try {
      aggregateScreeningRun(corpus, observations, IDENTITY, {
        ...S4_THRESHOLDS,
        minimum_legitimate_examples: 1,
        minimum_hard_reject_examples: 1,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Observation version metadata is unsafe or malformed.");
    expect(message).not.toContain(token);
  }
});

test("a well-formed stratum still reaches the by_stratum breakdown", () => {
  const corpus: readonly ScreeningCorpusExample[] = [
    fixture(1, "legitimate", { stratum: "graph-theory" }),
    fixture(2, "hard-reject", { stratum: "hard-reject-operational-harm" }),
  ];
  const observations: readonly ScreeningObservation[] = corpus.map((example) => ({
    example_id: example.id,
    evaluated_body_digest: example.body_digest as string,
    decision: example.ground_truth === "hard-reject" ? "reject" : "pass",
    coarse_category: example.policy_category,
    category_score_bands: BANDS,
    model_version: IDENTITY.model_version,
    policy_version: IDENTITY.policy_version,
    configuration_digest: IDENTITY.configuration_digest,
    provider_status: "ok",
    decision_path: "provider",
    status_code: "SCREENED",
    latency_ms: 4,
    retry_count: 0,
  }));
  const report = aggregateScreeningRun(corpus, observations, IDENTITY, {
    ...S4_THRESHOLDS,
    minimum_legitimate_examples: 1,
    minimum_hard_reject_examples: 1,
  });
  expect(report.by_stratum.map((metric) => metric.label).sort()).toEqual([
    "graph-theory",
    "hard-reject-operational-harm",
  ]);
});
