/**
 * The cold-agent gauntlet scorecard (Fable §16.1). Its pass bar is ≥ 8/10
 * state-derived full completions across ≥ 3 harnesses with median total token
 * usage ≤ 25K.
 *
 * This module is a pure scoring primitive. Its completed/token inputs must come
 * from authoritative product and harness evidence; the scorecard cannot make
 * transcript-derived booleans trustworthy. Current executable entries remain
 * fail-closed because that evidence contract is not implemented.
 */

import { HARNESS_ADAPTERS, type HarnessAdapter } from "./adapters.ts";

/** One gauntlet attempt: a fresh harness session driven through the loop. */
export interface GauntletAttempt {
  readonly attemptIndex: number;
  readonly adapter: HarnessAdapter;
  readonly joinUrl: string;
}

/** The outcome of one attempt. */
export interface GauntletResult {
  readonly attemptIndex: number;
  readonly harness: string;
  /** State-derived full-loop completion; never inferred from transcript text. */
  readonly completed: boolean;
  readonly tokensUsed: number;
  /** The stage the attempt reached, for the failure report. */
  readonly stageReached: string;
}

export interface GauntletScorecard {
  readonly total: number;
  readonly completed: number;
  readonly harnesses: readonly string[];
  readonly medianTokens: number;
  /** The Fable §16.1 pass bar. */
  readonly passed: boolean;
}

export const GAUNTLET_REQUIRED_ATTEMPTS = 10;
export const GAUNTLET_PASS_FRACTION = 0.8;
export const GAUNTLET_MAX_MEDIAN_TOKENS = 25_000;
export const GAUNTLET_MIN_HARNESS_COUNT = 3;

const KNOWN_HARNESSES = new Set(HARNESS_ADAPTERS.map((adapter) => adapter.harness));

/** The median of a set of token counts (the per-attempt budget measure). */
export function medianTokens(tokens: readonly number[]): number {
  if (tokens.length === 0) return 0;
  const sorted = [...tokens].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[sorted.length - 1 - mid];
  const right = sorted[mid];
  return ((left ?? 0) + (right ?? 0)) / 2;
}

/**
 * Score a gauntlet run. Pass: exactly 10 attempts, ≥ 80% full completions,
 * across ≥ 3 distinct harnesses, median ≤ 25K tokens. Pure over the results.
 */
export function scoreGauntlet(results: readonly GauntletResult[]): GauntletScorecard {
  const completedResults = results.filter((result) => result.completed === true);
  const completed = completedResults.length;
  const harnesses = [...new Set(results.map((r) => r.harness))];
  const median = medianTokens(completedResults.map((result) => result.tokensUsed));
  const attemptIndexes = results.map((result) => result.attemptIndex);
  const resultsAreCanonical = results.every(
    (result) =>
      Number.isSafeInteger(result.attemptIndex) &&
      result.attemptIndex >= 0 &&
      result.attemptIndex < GAUNTLET_REQUIRED_ATTEMPTS &&
      Number.isSafeInteger(result.tokensUsed) &&
      result.tokensUsed >= 0 &&
      typeof result.completed === "boolean" &&
      (!result.completed || result.tokensUsed > 0) &&
      KNOWN_HARNESSES.has(result.harness),
  );
  const attemptsAreDistinct = new Set(attemptIndexes).size === GAUNTLET_REQUIRED_ATTEMPTS;
  const passed =
    results.length === GAUNTLET_REQUIRED_ATTEMPTS &&
    resultsAreCanonical &&
    attemptsAreDistinct &&
    completed / results.length >= GAUNTLET_PASS_FRACTION &&
    harnesses.length >= GAUNTLET_MIN_HARNESS_COUNT &&
    median <= GAUNTLET_MAX_MEDIAN_TOKENS;
  return {
    total: results.length,
    completed,
    harnesses,
    medianTokens: median,
    passed,
  };
}
