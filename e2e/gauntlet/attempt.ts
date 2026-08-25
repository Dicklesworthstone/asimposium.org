/**
 * One gauntlet attempt: spawn the adapter's CLI with the registration prompt,
 * capture the transcript, and produce diagnostic harness-development output.
 * The spawner is injected so the scanner is testable with fixtures.
 *
 * Transcript markers cannot prove any server-side state transition. Until an
 * authoritative evidence result is wired, this module always reports the
 * attempt incomplete. Its stage and fallback token values are diagnostics,
 * never Cold-Agent Gauntlet acceptance evidence.
 */

import { type HarnessAdapter, registrationPrompt } from "./adapters.ts";
import type { GauntletResult } from "./scorecard.ts";

/** The spawn seam: given the adapter + prompt, run the CLI and return its transcript. */
export type HarnessSpawner = (
  adapter: HarnessAdapter,
  prompt: string,
) => Promise<{ readonly transcript: string; readonly tokensUsed?: number }>;

/** The stage markers a transcript carries, in loop order. */
export const STAGE_MARKERS = ["pair", "session", "pack", "workshop", "promote", "close"] as const;

/** The deepest loop stage the transcript reached. */
export function deepestStageReached(transcript: string): string {
  let reached = "none";
  for (const stage of STAGE_MARKERS) {
    if (transcript.toLowerCase().includes(stage)) reached = stage;
  }
  return reached;
}

/** Check whether the transcript merely mentions all loop-stage words. */
export function transcriptMentionsAllStages(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return STAGE_MARKERS.every((stage) => lower.includes(stage));
}

/**
 * Run one diagnostic attempt. Completion remains false until state-derived
 * evidence and authoritative token accounting are part of the result contract.
 */
export async function runGauntletAttempt(
  attemptIndex: number,
  adapter: HarnessAdapter,
  joinUrl: string,
  spawn: HarnessSpawner,
): Promise<GauntletResult> {
  const { transcript, tokensUsed } = await spawn(adapter, registrationPrompt(joinUrl));
  const stageReached = deepestStageReached(transcript);
  return {
    attemptIndex,
    harness: adapter.harness,
    completed: false,
    tokensUsed: tokensUsed ?? estimateTokens(transcript),
    stageReached,
  };
}

/**
 * A rough transcript-size diagnostic when the harness does not report tokens.
 * It is not total token usage and must never be used as acceptance authority.
 */
export function estimateTokens(transcript: string): number {
  return Math.max(Math.ceil(transcript.length / 4), 1);
}
