import { describe, expect, test } from "bun:test";

import {
  GAUNTLET_MAX_MEDIAN_TOKENS,
  type GauntletResult,
  medianTokens,
  scoreGauntlet,
} from "./scorecard.ts";

const DEFAULT_HARNESSES: readonly string[] = ["claude-code", "codex", "gemini"];

function rotatingHarness(index: number, harnesses: readonly string[] = DEFAULT_HARNESSES): string {
  return harnesses[index % harnesses.length] ?? "claude-code";
}

function result(
  attemptIndex: number,
  harness: string,
  completed: boolean,
  tokensUsed = 10000,
): GauntletResult {
  return {
    attemptIndex,
    harness,
    completed,
    tokensUsed,
    stageReached: completed ? "close" : "pack",
  };
}

describe("the gauntlet scorecard (Fable §16.1)", () => {
  test("the median of an odd and even set", () => {
    expect(medianTokens([1, 2, 3])).toBe(2);
    expect(medianTokens([1, 2, 3, 4])).toBe(2.5);
    expect(medianTokens([])).toBe(0);
  });

  test("a run passes at exactly 8/10 across 3 harnesses under the token budget", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      result(i, rotatingHarness(i), i < 8, 20000),
    );
    const scorecard = scoreGauntlet(results);
    expect(scorecard.passed).toBe(true);
    expect(scorecard.completed).toBe(8);
    expect(scorecard.harnesses).toHaveLength(3);
  });

  test("a run fails under 8/10 completions", () => {
    const results = Array.from({ length: 10 }, (_, i) => result(i, rotatingHarness(i), i < 7));
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
      result(i, rotatingHarness(i), true, GAUNTLET_MAX_MEDIAN_TOKENS + 1),
    );
    expect(scoreGauntlet(results).passed).toBe(false);
  });

  test("an even median just above the budget cannot pass by rounding down", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      result(
        i,
        rotatingHarness(i),
        i < 8,
        i < 4 ? GAUNTLET_MAX_MEDIAN_TOKENS : GAUNTLET_MAX_MEDIAN_TOKENS + 1,
      ),
    );
    expect(scoreGauntlet(results).medianTokens).toBe(GAUNTLET_MAX_MEDIAN_TOKENS + 0.5);
    expect(scoreGauntlet(results).passed).toBe(false);
  });

  test("a run fails when fewer than 10 attempts are recorded (e.g. 9)", () => {
    const results = Array.from({ length: 9 }, (_, i) => result(i, rotatingHarness(i), true, 20000));
    expect(scoreGauntlet(results).passed).toBe(false);
  });

  test("a run fails when more than 10 attempts are recorded (e.g. 11)", () => {
    const results = Array.from({ length: 11 }, (_, i) =>
      result(i, rotatingHarness(i), true, 20000),
    );
    expect(scoreGauntlet(results).passed).toBe(false);
  });

  test("duplicate ordinal slots cannot stand in for ten attempt rows", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      result(i === 9 ? 8 : i, rotatingHarness(i), true),
    );
    expect(scoreGauntlet(results).passed).toBe(false);
  });

  test("unknown harnesses and invalid token evidence fail closed", () => {
    const unknownHarness = Array.from({ length: 10 }, (_, i) =>
      result(i, rotatingHarness(i, ["claude-code", "codex", "invented-harness"]), true),
    );
    const negativeTokens = Array.from({ length: 10 }, (_, i) =>
      result(i, rotatingHarness(i), true, i === 0 ? -1 : 10000),
    );
    expect(scoreGauntlet(unknownHarness).passed).toBe(false);
    expect(scoreGauntlet(negativeTokens).passed).toBe(false);
  });

  test("truthy non-boolean completion values cannot become completions", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      ...result(i, rotatingHarness(i), true),
      completed: "false",
    })) as unknown as GauntletResult[];
    expect(scoreGauntlet(results).passed).toBe(false);
  });
});
