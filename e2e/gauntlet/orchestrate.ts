/**
 * The gauntlet orchestrator (Fable §16.1): fan the attempts across fresh
 * sessions and harnesses, then score the run. Each attempt gets its own join
 * URL (a fresh Fellow) and a harness assignment that rotates across the
 * adapters so the harness-diversity requirement is structural, not luck.
 *
 * The join URLs are supplied by the caller (the sponsor mints them; the
 * computer-use session approves them, §6.3). The spawner is injected. This
 * module is the pure orchestration — no subprocess, no network.
 */

import { HARNESS_ADAPTERS } from "./adapters.ts";
import { type HarnessSpawner, runGauntletAttempt } from "./attempt.ts";
import { type GauntletResult, type GauntletScorecard, scoreGauntlet } from "./scorecard.ts";

export interface GauntletRun {
  readonly results: readonly GauntletResult[];
  readonly scorecard: GauntletScorecard;
}

/**
 * Assign harnesses to attempts round-robin across the adapters, so a run of N
 * attempts over M adapters covers every adapter ⌈N/M⌉ times. The §16.1 harness
 * diversity (≥ 3 harnesses) is then satisfied by construction whenever the
 * attempt count meets the adapter count.
 */
export function assignHarnesses(attemptCount: number): readonly string[] {
  return Array.from(
    { length: attemptCount },
    (_, i) => HARNESS_ADAPTERS[i % HARNESS_ADAPTERS.length]?.harness ?? "",
  );
}

/**
 * Run the gauntlet: one attempt per join URL, harnesses rotating across the
 * adapters, then the scorecard. Attempts run sequentially — a fresh harness
 * session is the unit, and parallel cold agents would race the sponsor's
 * approval card.
 */
export async function runGauntlet(
  joinUrls: readonly string[],
  spawn: HarnessSpawner,
): Promise<GauntletRun> {
  const assignments = assignHarnesses(joinUrls.length);
  const results: GauntletResult[] = [];
  for (const [index, joinUrl] of joinUrls.entries()) {
    const adapter = HARNESS_ADAPTERS.find((a) => a.harness === assignments[index]);
    if (adapter === undefined) continue;
    results.push(await runGauntletAttempt(index, adapter, joinUrl, spawn));
  }
  return { results, scorecard: scoreGauntlet(results) };
}
