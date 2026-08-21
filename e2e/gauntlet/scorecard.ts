/**
 * The cold-agent gauntlet orchestration core (Fable §16.1): fan the harness
 * adapters across N fresh sessions, each with its own join URL, and count the
 * completions. The pass bar is ≥ 8/10 full completions (pair, session,
 * workshop, promote a falsifiable claim, recover from an injected 422) across
 * ≥ 3 harnesses, median ≤ 25K tokens.
 *
 * This module is the orchestration logic — spawning, collecting, and scoring —
 * with the adapters injected so the runners are testable against fixtures. The
 * shell entry (run.sh) wires the real CLIs and the approval automation.
 */

import type { HarnessAdapter } from "./adapters.ts";

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

export const GAUNTLET_PASS_FRACTION = 0.8;
export const GAUNTLET_MAX_MEDIAN_TOKENS = 25_000;
export const GAUNTLET_MIN_HARNESS_COUNT = 3;

/** The median of a set of token counts (the per-attempt budget measure). */
export function medianTokens(tokens: readonly number[]): number {
  if (tokens.length === 0) return 0;
  const sorted = [...tokens].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[sorted.length - 1 - mid];
  const right = sorted[mid];
  return Math.floor(((left ?? 0) + (right ?? 0)) / 2);
}

/**
 * Score a gauntlet run. Pass: ≥ 80% full completions, across ≥ 3 distinct
 * harnesses, median ≤ 25K tokens. Pure over the results.
 */
export function scoreGauntlet(results: readonly GauntletResult[]): GauntletScorecard {
  const completed = results.filter((r) => r.completed).length;
  const harnesses = [...new Set(results.map((r) => r.harness))];
  const median = medianTokens(results.filter((r) => r.completed).map((r) => r.tokensUsed));
  const passed =
    results.length > 0 &&
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
