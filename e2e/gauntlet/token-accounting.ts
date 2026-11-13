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
  if (typeof document.is_error !== "boolean") return null;
  const usageValue = document.usage;
  if (typeof usageValue !== "object" || usageValue === null) return null;
  const usage = usageValue as Record<string, unknown>;

  const inputTokens = asFiniteNumber(usage.input_tokens);
  const cacheCreation = asFiniteNumber(usage.cache_creation_input_tokens);
  const cacheRead = asFiniteNumber(usage.cache_read_input_tokens);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  if (
    inputTokens === null ||
    cacheCreation === null ||
    cacheRead === null ||
    outputTokens === null
  ) {
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

/** Run-local request evidence. Session/span identities never enter the receipt. */
export interface ClaudeRequestUsage {
  readonly sessionId: string;
  readonly spanId: string;
  readonly startedAtNs: bigint;
  readonly endedAtNs: bigint;
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

export interface ClaudePromotionTokenUsage {
  readonly scope: "first_promotion";
  readonly source: "claude_request_spans";
  readonly requests: number;
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

const CLAUDE_TOKEN_FIELDS = [
  "inputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "outputTokens",
] as const;
const CLAUDE_SPAN_FIELDS = new Set([
  "session.id",
  "agent_id",
  "input_tokens",
  "output_tokens",
  "cache_creation_tokens",
  "cache_read_tokens",
]);

function claudeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeCount(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function opaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function nanoTimestamp(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,21}$/.test(value)) return null;
  const timestamp = BigInt(value);
  return timestamp <= BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n ? timestamp : null;
}

/** Discard content and account attributes before retaining any event. */
function claudeAttributes(value: unknown): Map<string, unknown> | null {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > 256) return null;
  const seen = new Set<string>();
  const fields = new Map<string, unknown>();
  for (const attribute of value) {
    const item = claudeRecord(attribute);
    if (typeof item?.key !== "string" || seen.has(item.key)) return null;
    seen.add(item.key);
    if (!CLAUDE_SPAN_FIELDS.has(item.key)) continue;
    const encoded = claudeRecord(item.value);
    if (encoded === null || Object.keys(encoded).length !== 1) return null;
    fields.set(item.key, encoded.stringValue ?? encoded.intValue ?? encoded.doubleValue);
  }
  return fields;
}

/** Claude Code 2.1.325 OTLP/HTTP JSON, observed with every content gate off. */
export function parseClaudeUsageBatch(value: unknown): readonly ClaudeRequestUsage[] | null {
  const resources = claudeRecord(value)?.resourceSpans;
  if (!Array.isArray(resources) || resources.length > 256) return null;
  const events: ClaudeRequestUsage[] = [];
  for (const resource of resources) {
    const row = claudeRecord(resource);
    const metadata = row?.resource === undefined ? undefined : claudeRecord(row.resource);
    if (metadata === null) return null;
    const resourceFields = claudeAttributes(metadata?.attributes);
    const scopes = row?.scopeSpans;
    if (resourceFields === null || !Array.isArray(scopes) || scopes.length > 256) return null;
    for (const scope of scopes) {
      const spans = claudeRecord(scope)?.spans;
      if (!Array.isArray(spans) || spans.length > 1024) return null;
      for (const value of spans) {
        const span = claudeRecord(value);
        if (span === null || typeof span.name !== "string") return null;
        if (span.name !== "claude_code.llm_request") continue;
        const fields = claudeAttributes(span.attributes);
        if (fields === null || fields.has("agent_id") || resourceFields.has("agent_id"))
          return null;
        const localSession = fields.get("session.id");
        const resourceSession = resourceFields.get("session.id");
        if (
          localSession !== undefined &&
          resourceSession !== undefined &&
          localSession !== resourceSession
        )
          return null;
        const sessionId = localSession ?? resourceSession;
        const result = span.status === undefined ? undefined : claudeRecord(span.status);
        if (result === null) return null;
        const status = result?.code;
        const startedAtNs = nanoTimestamp(span.startTimeUnixNano);
        const endedAtNs = nanoTimestamp(span.endTimeUnixNano);
        const inputTokens = safeCount(fields.get("input_tokens"));
        const outputTokens = safeCount(fields.get("output_tokens"));
        const cacheCreationInputTokens = safeCount(fields.get("cache_creation_tokens"));
        const cacheReadInputTokens = safeCount(fields.get("cache_read_tokens"));
        if (
          !opaqueId(sessionId) ||
          !opaqueId(span.spanId) ||
          (status !== undefined && status !== 0 && status !== 1) ||
          startedAtNs === null ||
          endedAtNs === null ||
          startedAtNs >= endedAtNs ||
          inputTokens === null ||
          outputTokens === null ||
          cacheCreationInputTokens === null ||
          cacheReadInputTokens === null
        )
          return null;
        events.push({
          sessionId,
          spanId: span.spanId,
          startedAtNs,
          endedAtNs,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
        });
        if (events.length > 10_000) return null;
      }
    }
  }
  return events;
}

/** Full-run reconciliation precedes cutting at the Worker's successful write. */
export function claudeUsageToFirstPromotion(
  events: readonly ClaudeRequestUsage[],
  whole: ClaudeCodeTokenUsage | null,
  firstPromotionAt: number | undefined,
): ClaudePromotionTokenUsage | null {
  if (
    whole === null ||
    !opaqueId(whole.sessionId) ||
    whole.isError !== false ||
    safeCount(firstPromotionAt) === null ||
    typeof firstPromotionAt !== "number" ||
    CLAUDE_TOKEN_FIELDS.some((field) => safeCount(whole[field]) === null) ||
    !Number.isSafeInteger(whole.totalTokens) ||
    whole.totalTokens !== CLAUDE_TOKEN_FIELDS.reduce((sum, field) => sum + whole[field], 0) ||
    events.length === 0 ||
    events.length > 10_000
  )
    return null;
  const boundary = BigInt(firstPromotionAt) * 1_000_000n;
  const seen = new Set<string>();
  const ordered = [...events].sort((left, right) =>
    left.startedAtNs < right.startedAtNs ? -1 : left.startedAtNs > right.startedAtNs ? 1 : 0,
  );
  const all = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const prior = { ...all };
  let requests = 0;
  for (const [index, event] of ordered.entries()) {
    const previous = ordered[index - 1];
    if (
      event.sessionId !== whole.sessionId ||
      !opaqueId(event.spanId) ||
      seen.has(event.spanId) ||
      typeof event.startedAtNs !== "bigint" ||
      typeof event.endedAtNs !== "bigint" ||
      event.startedAtNs <= 0n ||
      event.startedAtNs >= event.endedAtNs ||
      (previous !== undefined && previous.endedAtNs >= event.startedAtNs) ||
      (event.startedAtNs <= boundary && event.endedAtNs >= boundary)
    )
      return null;
    seen.add(event.spanId);
    const before = event.endedAtNs < boundary;
    if (before) requests += 1;
    for (const field of CLAUDE_TOKEN_FIELDS) {
      if (safeCount(event[field]) === null) return null;
      all[field] += event[field];
      if (before) prior[field] += event[field];
      if (!Number.isSafeInteger(all[field]) || !Number.isSafeInteger(prior[field])) return null;
    }
  }
  if (requests === 0 || CLAUDE_TOKEN_FIELDS.some((field) => all[field] !== whole[field]))
    return null;
  const totalTokens = CLAUDE_TOKEN_FIELDS.reduce((sum, field) => sum + prior[field], 0);
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return null;
  return {
    scope: "first_promotion",
    source: "claude_request_spans",
    requests,
    ...prior,
    totalTokens,
  };
}
