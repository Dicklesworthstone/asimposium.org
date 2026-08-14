import { expect, test } from "bun:test";
import {
  aggregateScreeningRun,
  S4_THRESHOLDS,
  type ScreeningCorpusExample,
  type ScreeningObservation,
  type ScreeningRunIdentity,
  screeningOpsJsonl,
} from "../../src/screening";

const identity: ScreeningRunIdentity = {
  corpus_revision: "s4-security-v1",
  corpus_digest: "sha256:security-corpus",
  model_version: "model-security-v1",
  policy_version: "policy-security-v1",
  configuration_digest: "sha256:security-config",
};

test("screening OPS JSONL excludes payloads, prompts, raw score bands, and credentials", () => {
  const forbiddenPayload = "raw-body-canary-do-not-log";
  const forbiddenPrompt = "detector-prompt-canary";
  const forbiddenToken = "asimp_ag_canary000000000000000000";
  const corpus: ScreeningCorpusExample[] = [
    {
      manifest_version: "s4-manifest-v2",
      id: "legit-001",
      body_digest: `sha256:${"a".repeat(64)}`,
      body: "Safe security fixture body.",
      source: {
        kind: "inline-safe",
        locator: "unit:screening-report-disclosure",
        version: "unit-v1",
        provenance: "unit-fixture",
        license: "test-only",
        availability: "available",
      },
      ground_truth: "legitimate",
      expected_outcome: "pass-or-warning",
      policy_category: "benign-context",
      stratum: "weird-math",
      rationale: "Checks redaction behavior only.",
      safe_excerpt: `${forbiddenPayload} ${forbiddenPrompt} ${forbiddenToken}`,
      sentinel: "legitimate-pass",
    },
    {
      manifest_version: "s4-manifest-v2",
      id: "hard-001",
      body_digest: `sha256:${"b".repeat(64)}`,
      body: "Safe security fixture body.",
      source: {
        kind: "inline-safe",
        locator: "unit:screening-report-disclosure",
        version: "unit-v1",
        provenance: "unit-fixture",
        license: "test-only",
        availability: "available",
      },
      ground_truth: "hard-reject",
      expected_outcome: "reject",
      policy_category: "operational-harm",
      stratum: "operational-harm",
      rationale: "Checks redaction behavior only.",
      safe_excerpt: "Protected fixture metadata.",
      sentinel: "hard-reject",
    },
  ];
  const observations: ScreeningObservation[] = corpus.map((example) => ({
    example_id: example.id,
    evaluated_body_digest: example.body_digest as string,
    decision: example.ground_truth === "hard-reject" ? "reject" : "pass",
    coarse_category: example.policy_category,
    category_score_bands: {
      "benign-context": "low",
      "spam-commercial": undefined,
      injection: undefined,
      "dual-use-boundary": undefined,
      "operational-harm": "high",
      harassment: undefined,
      "sexual-content": undefined,
      "provider-unavailable": undefined,
    },
    model_version: identity.model_version,
    policy_version: identity.policy_version,
    configuration_digest: identity.configuration_digest,
    provider_status: "ok",
    decision_path: "provider",
    status_code: "SCREENED",
    latency_ms: 3,
    retry_count: 0,
  }));
  const report = aggregateScreeningRun(corpus, observations, identity, {
    // Inherit every real bar and relax only the two corpus-size minimums, so this
    // fixture cannot drift from the shipped thresholds as they grow.
    ...S4_THRESHOLDS,
    minimum_legitimate_examples: 1,
    minimum_hard_reject_examples: 1,
  });
  const jsonl = screeningOpsJsonl(corpus, observations, report);

  expect(jsonl).not.toContain(forbiddenPayload);
  expect(jsonl).not.toContain(forbiddenPrompt);
  expect(jsonl).not.toContain(forbiddenToken);
  expect(jsonl).not.toContain("category_score_bands");
  expect(jsonl).not.toContain("safe_excerpt");
  expect(jsonl).not.toContain("prompt");
});
