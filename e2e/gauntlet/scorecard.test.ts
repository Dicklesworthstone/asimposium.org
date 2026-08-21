import { describe, expect, test } from "bun:test";

import {
  GAUNTLET_MAX_MEDIAN_TOKENS,
  medianTokens,
  scoreGauntlet,
  type GauntletResult,
} from "./scorecard.ts";

function result(attemptIndex: number, harness: string, completed: boolean, tokensUsed = 10000): GauntletResult {
  return { attemptIndex, harness, completed, tokensUsed, stageReached: completed ? "close" : "pack" };
}

describe("the gauntlet scorecard (Fable §16.1)", () => {
  test("the median of an odd and even set", () => {
    expect(medianTokens([1, 2, 3])).toBe(2);
    expect(medianTokens([1, 2, 3, 4])).toBe(2);
    expect(medianTokens([])).toBe(0);
  });

  test("a run passes at exactly 8/10 across 3 harnesses under the token budget", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      result(i, ["claude-code", "codex", "gemini"][i % 3]!, i < 8, 20000),
    );
    const scorecard = scoreGauntlet(results);
    expect(scorecard.passed).toBe(true);
    expect(scorecard.completed).toBe(8);
    expect(scorecard.harnesses).toHaveLength(3);
  });

  test("a run fails under 8/10 completions", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      result(i, ["claude-code", "codex", "gemini"][i % 3]!, i < 7),
    );
    expect(scoreGauntlet(results).passed).toBe(false);
  });

  test("a run fails under 3 distinct harnesses even at 10/10", () => {
    const results = Array.from({ length: 10 }, (_, i) => result(i, "codex", true));
    const scorecard = scoreGauntlet(results);
    expect(scorecard.completed).toBe(10);
    expect(scorecard.passed).toBe(false);
  });

  test("a run fails when the median token budget is exceeded", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      result(i, ["claude-code", "codex", "gemini"][i % 3]!, true, GAUNTLET_MAX_MEDIAN_TOKENS + 1),
    );
    expect(scoreGauntlet(results).passed).toBe(false);
  });
});
