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
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
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
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
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
  let workStarted = false;
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
      if (
        threadId !== null ||
        workStarted ||
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > 256 ||
        id.trim() !== id ||
        Array.from(id).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        return null;
      threadId = id;
      continue;
    }
    if (event.type === "turn.started") workStarted = true;
    if (event.type !== "turn.completed") continue;
    workStarted = true;
    const turn = parseTurnUsage(event);
    if (turn === null) return null;
    sawCompletedTurn = true;
    turns += 1;
    inputTokens += turn.inputTokens;
    cachedInputTokens += turn.cachedInputTokens;
    cacheWriteInputTokens += turn.cacheWriteInputTokens;
    outputTokens += turn.outputTokens;
    reasoningOutputTokens += turn.reasoningOutputTokens;
    if (
      ![
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens,
        reasoningOutputTokens,
        inputTokens + outputTokens,
      ].every(Number.isSafeInteger)
    )
      return null;
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

/** Ephemeral numeric evidence only; the root identity never enters retained usage. */
export interface CodexUsageEvent {
  readonly kind: "prompt" | "request" | "response";
  readonly threadId: string;
  readonly atMs: number;
  readonly usage: TurnUsage | null;
  readonly success?: boolean;
}

export interface CodexPromotionTokenUsage extends TurnUsage {
  readonly scope: "first_promotion";
  readonly source: "codex_websocket_intervals";
  readonly requests: number;
  readonly totalTokens: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function attributeValue(value: unknown): string | number | null {
  const item = record(value);
  if (!item || Object.keys(item).length !== 1) return null;
  if (typeof item.stringValue === "string") return item.stringValue;
  if (typeof item.intValue === "string") return item.intValue;
  if (typeof item.intValue === "number") return item.intValue;
  if (typeof item.doubleValue === "number") return item.doubleValue;
  return null;
}

function tokenCount(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
    return asFiniteNumber(Number(value));
  return asFiniteNumber(value);
}

/**
 * Codex 0.167.1 OTLP/HTTP JSON layout, observed with all content logging off.
 * timeUnixNano is zero in that exporter; event.timestamp is its local UTC clock.
 * Unknown content/identity fields are discarded, never copied into an event.
 */
export function parseCodexUsageBatch(value: unknown): readonly CodexUsageEvent[] | null {
  const resourceLogs = record(value)?.resourceLogs;
  if (!Array.isArray(resourceLogs) || resourceLogs.length > 256) return null;
  const events: CodexUsageEvent[] = [];
  for (const resource of resourceLogs) {
    const scopes = record(resource)?.scopeLogs;
    if (!Array.isArray(scopes) || scopes.length > 256) return null;
    for (const scope of scopes) {
      const logs = record(scope)?.logRecords;
      if (!Array.isArray(logs) || logs.length > 1024) return null;
      for (const value of logs) {
        const attributes = record(value)?.attributes;
        if (!Array.isArray(attributes) || attributes.length > 256) return null;
        const fields = new Map<string, string | number | null>();
        for (const attribute of attributes) {
          const item = record(attribute);
          if (typeof item?.key !== "string" || fields.has(item.key)) return null;
          fields.set(item.key, attributeValue(item.value));
        }
        const name = fields.get("event.name");
        if (fields.has("event.name") && typeof name !== "string") return null;
        if (
          name !== "codex.user_prompt" &&
          name !== "codex.websocket_request" &&
          name !== "codex.sse_event"
        )
          continue;
        if (name === "codex.sse_event") {
          if (typeof fields.get("event.kind") !== "string") return null;
          if (fields.get("event.kind") !== "response.completed") continue;
        }
        const threadId = fields.get("conversation.id");
        const timestamp = fields.get("event.timestamp");
        if (
          typeof threadId !== "string" ||
          threadId.length === 0 ||
          threadId.length > 256 ||
          typeof timestamp !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
        )
          return null;
        const atMs = Date.parse(timestamp);
        if (!Number.isSafeInteger(atMs) || new Date(atMs).toISOString() !== timestamp) return null;
        if (name === "codex.user_prompt") {
          events.push({ kind: "prompt", threadId, atMs, usage: null });
          continue;
        }
        if (name === "codex.websocket_request") {
          const success = fields.get("success");
          if (success !== "true" && success !== "false") return null;
          events.push({
            kind: "request",
            threadId,
            atMs,
            usage: null,
            success: success === "true",
          });
          continue;
        }
        const usage = parseTurnUsage({
          usage: {
            input_tokens: tokenCount(fields.get("input_token_count")),
            cached_input_tokens: tokenCount(fields.get("cached_token_count")),
            cache_write_input_tokens: tokenCount(fields.get("cache_write_token_count")),
            output_tokens: tokenCount(fields.get("output_token_count")),
            reasoning_output_tokens: tokenCount(fields.get("reasoning_token_count")),
          },
        });
        if (usage === null) return null;
        events.push({ kind: "response", threadId, atMs, usage });
      }
    }
  }
  return events;
}

const USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

function sumUsage(events: readonly CodexUsageEvent[]): TurnUsage | null {
  const sum = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  for (const event of events) {
    if (event.usage === null) return null;
    for (const field of USAGE_FIELDS) {
      sum[field] += event.usage[field];
      if (asFiniteNumber(sum[field]) === null) return null;
    }
  }
  return asFiniteNumber(sum.inputTokens + sum.outputTokens) === null ? null : sum;
}

/**
 * Reconcile every root response after the single input prompt against the CLI
 * whole-turn totals. Codex 0.167.1 logs each WebSocket send before consuming
 * that response stream (codex-api/endpoint/responses_websocket.rs:1035-1060).
 * Pair those sends with completions. A request active at the server-observed
 * promote, unsupported transport, clock tie or missing evidence withholds the
 * measurement; a tool need not wait for response.completed before executing.
 */
export function codexUsageToFirstPromotion(
  events: readonly CodexUsageEvent[],
  whole: CodexExecTokenUsage | null,
  firstPromotionAt: number | undefined,
): CodexPromotionTokenUsage | null {
  if (
    whole === null ||
    whole.threadId === null ||
    whole.turns !== 1 ||
    firstPromotionAt === undefined ||
    asFiniteNumber(firstPromotionAt) === null ||
    USAGE_FIELDS.some((field) => asFiniteNumber(whole[field]) === null) ||
    whole.cachedInputTokens > whole.inputTokens ||
    whole.cacheWriteInputTokens > whole.inputTokens ||
    whole.reasoningOutputTokens > whole.outputTokens ||
    whole.totalTokens !== whole.inputTokens + whole.outputTokens
  )
    return null;
  const root = events.filter((event) => event.threadId === whole.threadId);
  const prompts = root.filter((event) => event.kind === "prompt");
  if (prompts.length !== 1) return null;
  const prompt = prompts[0];
  if (prompt === undefined || firstPromotionAt <= prompt.atMs) return null;
  if (
    events.some((event) => event.threadId !== whole.threadId && event.atMs >= prompt.atMs) ||
    root.some((event) => event.kind === "response" && event.atMs === prompt.atMs)
  )
    return null;
  const responses = root.filter((event) => event.kind === "response" && event.atMs > prompt.atMs);
  const requests = root
    .filter((event) => event.kind === "request" && event.atMs >= prompt.atMs)
    .sort((left, right) => left.atMs - right.atMs);
  responses.sort((left, right) => left.atMs - right.atMs);
  if (requests.length !== responses.length) return null;
  for (const [index, request] of requests.entries()) {
    const response = responses[index];
    const previous = responses[index - 1];
    if (
      response === undefined ||
      request.success !== true ||
      request.atMs === prompt.atMs ||
      request.atMs >= response.atMs ||
      (previous !== undefined && request.atMs <= previous.atMs) ||
      request.atMs === firstPromotionAt ||
      (request.atMs < firstPromotionAt && response.atMs >= firstPromotionAt)
    )
      return null;
  }
  const seen = new Set<number>();
  for (const response of responses) {
    if (seen.has(response.atMs) || response.atMs === firstPromotionAt) return null;
    seen.add(response.atMs);
  }
  const all = sumUsage(responses);
  if (all === null || USAGE_FIELDS.some((field) => all[field] !== whole[field])) return null;
  const prior = responses.filter((event) => event.atMs < firstPromotionAt);
  const sum = sumUsage(prior);
  if (prior.length === 0 || sum === null) return null;
  return {
    scope: "first_promotion",
    source: "codex_websocket_intervals",
    requests: prior.length,
    ...sum,
    totalTokens: sum.inputTokens + sum.outputTokens,
  };
}
