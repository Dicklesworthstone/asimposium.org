import { expect, test } from "bun:test";
import { aggregateScreeningRun, screeningOpsJsonl, type ScreeningCorpusExample, type ScreeningObservation, type ScreeningRunIdentity } from "../../src/screening";

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
      id: "legit-001",
      input_digest: "sha256:legit-security",
      ground_truth: "legitimate",
      policy_category: "benign-context",
      stratum: "weird-math",
      safe_excerpt: `${forbiddenPayload} ${forbiddenPrompt} ${forbiddenToken}`,
      sentinel: "legitimate-pass",
    },
    {
      id: "hard-001",
      input_digest: "sha256:hard-security",
      ground_truth: "hard-reject",
      policy_category: "operational-harm",
      stratum: "operational-harm",
      safe_excerpt: "Protected fixture metadata.",
      sentinel: "hard-reject",
    },
  ];
  const observations: ScreeningObservation[] = corpus.map((example) => ({
    example_id: example.id,
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
    legitimate_false_positive_rate_exclusive_max: 0.05,
    hard_reject_false_negative_max: 0,
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
