/**
 * One gauntlet attempt: spawn the adapter's CLI with the registration prompt,
 * capture the transcript, and produce a GauntletResult. The spawner is injected
 * so the runner is testable with fixtures; run.sh wires the real subprocess.
 *
 * The attempt drives the harness through the full loop (pair → session →
 * workshop → promote → recover from an injected 422 → close). The stage reached
 * is read from the transcript's markers; the token count comes from the
 * harness's own report when it provides one, else a conservative estimate.
 */

import { registrationPrompt, transcriptShowsCompletion, type HarnessAdapter } from "./adapters.ts";
import type { GauntletResult } from "./scorecard.ts";

/** The spawn seam: given the adapter + prompt, run the CLI and return its transcript. */
export type HarnessSpawner = (
  adapter: HarnessAdapter,
  prompt: string,
) => Promise<{ readonly transcript: string; readonly tokensUsed?: number }>;

/** The stage markers a transcript carries, in loop order. */
const STAGE_MARKERS = ["pair", "session", "pack", "workshop", "promote", "close"] as const;

/** The deepest loop stage the transcript reached. */
export function deepestStageReached(transcript: string): string {
  let reached = "none";
  for (const stage of STAGE_MARKERS) {
    if (transcript.toLowerCase().includes(stage)) reached = stage;
  }
  return reached;
}

/**
 * Run one gauntlet attempt. Completion requires the adapter's completion
 * signal AND the transcript reaching the close stage. Token count is the
 * harness's report, or a conservative per-stage estimate when absent.
 */
export async function runGauntletAttempt(
  attemptIndex: number,
  adapter: HarnessAdapter,
  joinUrl: string,
  spawn: HarnessSpawner,
): Promise<GauntletResult> {
  const { transcript, tokensUsed } = await spawn(adapter, registrationPrompt(joinUrl));
  const stageReached = deepestStageReached(transcript);
  const completed = transcriptShowsCompletion(adapter, transcript) && stageReached === "close";
  return {
    attemptIndex,
    harness: adapter.harness,
    completed,
    tokensUsed: tokensUsed ?? estimateTokens(transcript),
    stageReached,
  };
}

/**
 * A conservative token estimate when the harness doesn't report one: bytes/4
 * over the transcript, floored per stage reached. Overestimating is honest;
 * underestimating would fake the budget.
 */
export function estimateTokens(transcript: string): number {
  return Math.max(Math.ceil(transcript.length / 4), 1);
}
