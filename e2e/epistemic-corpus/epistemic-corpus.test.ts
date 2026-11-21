import { describe, expect, test } from "bun:test";
import { SCIENTIFIC_INDEPENDENCE_POLICY } from "../../apps/wire/src/ledger/scientific-checks.ts";
import { evaluateEpistemicCorpus, loadEpistemicCorpus } from "./evaluator.ts";

describe("W10.3 Epistemic control-fixture corpus + Rev 3.1 independence-manufacture suite (asimposiumorg-wnd)", () => {
  const corpus = loadEpistemicCorpus();
  const decisions = evaluateEpistemicCorpus(corpus);

  test("corpus pins active policy versions and covers both Rev 3 epistemic and Rev 3.1 independence families", () => {
    expect(corpus.schema).toBe("asimposium.epistemic-control-corpus.v1");
    expect(corpus.policy_versions.independence_policy).toBe(SCIENTIFIC_INDEPENDENCE_POLICY);

    const rev3 = corpus.fixtures.filter((f) => f.family === "epistemic-rev3");
    const rev31 = corpus.fixtures.filter((f) => f.family === "independence-manufacture-rev3.1");
    expect(rev3.length).toBeGreaterThanOrEqual(14);
    expect(rev31.length).toBeGreaterThanOrEqual(8);

    // Every fixture ID is unique and logs a non-empty decision path with policy versions.
    const ids = new Set(corpus.fixtures.map((f) => f.id));
    expect(ids.size).toBe(corpus.fixtures.length);
  });

  for (const decision of decisions) {
    test(`${decision.fixture_id} [${decision.family}/${decision.kind}] -> ${decision.expected_outcome} (${decision.expected_code_or_tier})`, () => {
      expect(decision.policy_versions.independence_policy).toBe(SCIENTIFIC_INDEPENDENCE_POLICY);
      expect(decision.decision_path.length).toBeGreaterThan(0);
      expect(decision.actual_outcome).toBe(decision.expected_outcome);
      expect(decision.actual_code_or_tier).toBe(decision.expected_code_or_tier);
      expect(decision.pass).toBe(true);
    });
  }

  test("symmetric FP=0 and FN=0 invariants hold across the full corpus", () => {
    const positives = decisions.filter((d) => d.expected_outcome === "pass");
    const negatives = decisions.filter((d) => d.expected_outcome !== "pass");
    expect(positives.length).toBeGreaterThanOrEqual(2);
    expect(negatives.length).toBeGreaterThanOrEqual(20);
    expect(positives.every((d) => d.pass)).toBe(true);
    expect(negatives.every((d) => d.pass)).toBe(true);
  });

  test("SHOULD-FAIL CONTROL: mutating an expected outcome trips the regression harness loudly", () => {
    const mutated = {
      ...corpus,
      fixtures: corpus.fixtures.map((f) =>
        f.id === "IND-001"
          ? { ...f, expected_outcome: "pass" as const, expected_code_or_tier: "T2:corroborated" }
          : f,
      ),
    };
    const results = evaluateEpistemicCorpus(mutated);
    const ind1 = results.find((r) => r.fixture_id === "IND-001");
    expect(ind1?.pass).toBe(false);
    expect(ind1?.actual_code_or_tier).toBe("T0:open · unchallenged");
  });
});
