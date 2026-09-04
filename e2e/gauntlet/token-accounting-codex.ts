/**
 * Authoritative token accounting for codex `exec --json` (W10.1 companion to
 * token-accounting.ts's claude-code parser). Shape captured live from
 * OpenAI Codex v0.153.2 on 2026-09-04: stdout is JSONL where each
 * `turn.completed` event carries
 * `{input_tokens, cached_input_tokens, cache_write_input_tokens,
 *   output_tokens, reasoning_output_tokens}`.
 *
 * Semantics deliberately differ from the claude-code parser and this is
 * documented, not hidden: OpenAI usage convention treats input_tokens as the
 * TOTAL prompt traffic with cached_input_tokens as a discount SUBSET of it
 * (cache_write the same), whereas Anthropic reports cache tokens additively
 * outside input_tokens. The totals are therefore computed per harness:
 * codex totalTokens = input_tokens + output_tokens, with cached/reasoning
 * surfaced as subsets and never re-added. Comparing harnesses compares the
 * totals; comparing components requires reading the components.
 *
 * A gauntlet session is multi-turn: the parser ACCUMulates every
 * turn.completed event in the stream. Any turn.completed with drifted shape
 * makes the whole parse null — loud fallback to the diagnostic estimate,
 * never a partial guess.
 */

/** The accumulated usage of one codex exec session. */
export interface CodexExecTokenUsage {
  readonly threadId: string | null;
  readonly turns: number;
  readonly inputTokens: number;
  /** Subset of inputTokens (OpenAI discount bucket); never re-added. */
  readonly cachedInputTokens: number;
  /** Subset of inputTokens; never re-added. */
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  /** Subset of outputTokens (model reasoning); surfaced, never re-added. */
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

interface TurnUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return null;
}

/** Parse one turn.completed event's usage; null on any drift. */
function parseTurnUsage(event: Record<string, unknown>): TurnUsage | null {
  const usageValue = event.usage;
  if (typeof usageValue !== "object" || usageValue === null) return null;
  const usage = usageValue as Record<string, unknown>;
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const cachedInputTokens = asFiniteNumber(usage.cached_input_tokens);
  const cacheWriteInputTokens = asFiniteNumber(usage.cache_write_input_tokens);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  const reasoningOutputTokens = asFiniteNumber(usage.reasoning_output_tokens);
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) {
    return null;
  }
  if (cachedInputTokens > inputTokens || cacheWriteInputTokens > inputTokens) return null;
  if (reasoningOutputTokens > outputTokens) return null;
  return { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens };
}

/**
 * Parse one codex `exec --json` stdout stream (JSONL). Returns the
 * accumulation over every turn.completed event; null when the stream has no
 * parseable turn.completed, contains a drifted one, or is not valid JSONL —
 * callers must fall back to the diagnostic estimate loudly.
 */
export function parseCodexExecUsage(jsonl: string): CodexExecTokenUsage | null {
  let threadId: string | null = null;
  let sawCompletedTurn = false;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let turns = 0;

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const event = parsed as Record<string, unknown>;
    if (event.type === "thread.started") {
      const id = event.thread_id;
      threadId = typeof id === "string" ? id : threadId;
      continue;
    }
    if (event.type !== "turn.completed") continue;
    const turn = parseTurnUsage(event);
    if (turn === null) return null;
    sawCompletedTurn = true;
    turns += 1;
    inputTokens += turn.inputTokens;
    cachedInputTokens += turn.cachedInputTokens;
    cacheWriteInputTokens += turn.cacheWriteInputTokens;
    outputTokens += turn.outputTokens;
    reasoningOutputTokens += turn.reasoningOutputTokens;
  }

  if (!sawCompletedTurn) return null;
  return {
    threadId,
    turns,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}
