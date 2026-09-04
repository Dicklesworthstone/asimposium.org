/**
 * Authoritative token accounting for the Cold-Agent Gauntlet (W10.1,
 * Fable §16.1: "median ≤ 25K tokens" must be measured, never estimated).
 *
 * The scorecard consumes `tokensUsed` per attempt; attempt.ts's
 * length/4 estimate is a diagnostic that must never be acceptance
 * authority. This module turns a harness's own reported usage into that
 * authoritative number.
 *
 * Coverage is explicit and honest:
 * - claude-code: IMPLEMENTED, parsed from the `--output-format json` shape
 *   captured from Claude Code 2.1.260 on 2026-09-04 (the fixture below uses
 *   the exact key layout with synthetic values).
 * - codex: PENDING a real `exec --json` capture (probe 2026-09-04: emits a
 *   header banner and JSONL events on stdout; shape unverified).
 * - gemini: PENDING (probe 2026-09-04: requires GEMINI_API_KEY/vertex/GCA
 *   auth before any output shape exists).
 *
 * Total-token definition used here: input + cache_creation + cache_read +
 * output. thinking_tokens is a subset of output_tokens and is never added
 * again; it is surfaced because the ceremony-regression metric cares about
 * reasoning bulk specifically (§16.1 tokens-to-first-promotion).
 */

/** The parsed usage of one claude-code session run. */
export interface ClaudeCodeTokenUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  /** Subset of outputTokens; reported, never re-added into totalTokens. */
  readonly thinkingTokens: number;
  readonly totalTokens: number;
  readonly isError: boolean;
  readonly numTurns: number;
  readonly sessionId: string | null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return null;
}

/**
 * Parse one claude-code `--output-format json` document. Returns null on any
 * shape drift — callers must fall back to the diagnostic estimate and treat
 * drift as loud, because silent estimate-fallback would quietly turn the
 * acceptance measure back into a guess.
 */
export function parseClaudeCodeUsage(json: string): ClaudeCodeTokenUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const document = parsed as Record<string, unknown>;
  const usageValue = document.usage;
  if (typeof usageValue !== "object" || usageValue === null) return null;
  const usage = usageValue as Record<string, unknown>;

  const inputTokens = asFiniteNumber(usage.input_tokens);
  const cacheCreation = asFiniteNumber(usage.cache_creation_input_tokens);
  const cacheRead = asFiniteNumber(usage.cache_read_input_tokens);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  if (inputTokens === null || cacheCreation === null || cacheRead === null || outputTokens === null) {
    return null;
  }

  const outputDetails = usage.output_tokens_details;
  const thinkingRaw =
    typeof outputDetails === "object" && outputDetails !== null
      ? (outputDetails as Record<string, unknown>).thinking_tokens
      : undefined;
  const thinkingTokens = asFiniteNumber(thinkingRaw) ?? 0;
  if (thinkingTokens > outputTokens) return null;

  const sessionIdValue = document.session_id;
  const sessionId = typeof sessionIdValue === "string" ? sessionIdValue : null;
  const numTurns = asFiniteNumber(document.num_turns) ?? 0;
  const isError = document.is_error === true;

  return {
    inputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    outputTokens,
    thinkingTokens,
    totalTokens: inputTokens + cacheCreation + cacheRead + outputTokens,
    isError,
    numTurns,
    sessionId,
  };
}
