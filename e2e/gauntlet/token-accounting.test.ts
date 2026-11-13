/**
 * Tests for the claude-code token accounting parser. The positive fixture is
 * the exact key layout captured from Claude Code 2.1.260 on 2026-09-04 with
 * synthetic values; the negatives pin shape-drift behavior — every drift path
 * must return null (loud fallback to the diagnostic estimate), never a guess.
 */

import { describe, expect, test } from "bun:test";

import {
  claudeUsageToFirstPromotion,
  parseClaudeCodeUsage,
  parseClaudeUsageBatch,
} from "./token-accounting.ts";

const REAL_SHAPE_FIXTURE = JSON.stringify({
  result: "ok",
  is_error: false,
  api_error_status: null,
  session_id: "3f9c1a2b-0000-4000-8000-000000000000",
  num_turns: 1,
  duration_ms: 5790,
  duration_api_ms: 4211,
  stop_reason: null,
  modelUsage: {},
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 17455,
    cache_read_input_tokens: 10123,
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 17455, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
  },
});

describe("parseClaudeCodeUsage", () => {
  test("parses the real captured shape and totals the four token components", () => {
    const usage = parseClaudeCodeUsage(REAL_SHAPE_FIXTURE);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(2);
    expect(usage?.cacheCreationInputTokens).toBe(17455);
    expect(usage?.cacheReadInputTokens).toBe(10123);
    expect(usage?.outputTokens).toBe(4);
    expect(usage?.totalTokens).toBe(2 + 17455 + 10123 + 4);
    expect(usage?.thinkingTokens).toBe(0);
    expect(usage?.isError).toBe(false);
    expect(usage?.numTurns).toBe(1);
    expect(usage?.sessionId).toBe("3f9c1a2b-0000-4000-8000-000000000000");
  });

  test("reports thinking tokens as a surfaced subset without double counting", () => {
    const document = JSON.parse(REAL_SHAPE_FIXTURE) as Record<string, unknown>;
    const usageObject = document.usage as Record<string, unknown>;
    usageObject.output_tokens = 900;
    (usageObject.output_tokens_details as Record<string, unknown>).thinking_tokens = 300;
    const usage = parseClaudeCodeUsage(JSON.stringify(document));
    expect(usage?.outputTokens).toBe(900);
    expect(usage?.thinkingTokens).toBe(300);
    expect(usage?.totalTokens).toBe(2 + 17455 + 10123 + 900);
  });

  test("carries the error flag for failed sessions whose tokens still count", () => {
    const document = JSON.parse(REAL_SHAPE_FIXTURE) as Record<string, unknown>;
    document.is_error = true;
    const usage = parseClaudeCodeUsage(JSON.stringify(document));
    expect(usage?.isError).toBe(true);
    expect(usage?.totalTokens).toBeGreaterThan(0);
  });

  test("null on missing usage block", () => {
    const document = JSON.parse(REAL_SHAPE_FIXTURE) as Record<string, unknown>;
    delete document.usage;
    expect(parseClaudeCodeUsage(JSON.stringify(document))).toBeNull();
  });

  test("null on any drifted or negative token component", () => {
    const document = JSON.parse(REAL_SHAPE_FIXTURE) as Record<string, unknown>;
    const usageObject = document.usage as Record<string, unknown>;
    usageObject.input_tokens = "many";
    expect(parseClaudeCodeUsage(JSON.stringify(document))).toBeNull();

    const negative = JSON.parse(REAL_SHAPE_FIXTURE) as Record<string, unknown>;
    (negative.usage as Record<string, unknown> as Record<string, unknown>).output_tokens = -4;
    expect(parseClaudeCodeUsage(JSON.stringify(negative))).toBeNull();
  });

  test("null on thinking tokens exceeding output tokens (impossible shape)", () => {
    const document = JSON.parse(REAL_SHAPE_FIXTURE) as Record<string, unknown>;
    const usageObject = document.usage as Record<string, unknown>;
    usageObject.output_tokens = 5;
    (usageObject.output_tokens_details as Record<string, unknown>).thinking_tokens = 6;
    expect(parseClaudeCodeUsage(JSON.stringify(document))).toBeNull();
  });

  test("null on malformed JSON, non-object documents, and missing session id", () => {
    expect(parseClaudeCodeUsage("not json at all")).toBeNull();
    expect(parseClaudeCodeUsage("42")).toBeNull();
    expect(parseClaudeCodeUsage('"a string"')).toBeNull();

    const document = JSON.parse(REAL_SHAPE_FIXTURE) as Record<string, unknown>;
    delete document.session_id;
    const usage = parseClaudeCodeUsage(JSON.stringify(document));
    expect(usage?.sessionId).toBeNull();
    expect(usage?.totalTokens).toBeGreaterThan(0);
  });
});

describe("Claude request intervals through first promotion", () => {
  const base = Date.parse("2026-11-13T00:00:00.000Z");
  const sessionId = "unit-claude-root";
  const ns = (ms: number) => (BigInt(base + ms) * 1_000_000n).toString();
  type Attribute = {
    key: string;
    value: { stringValue?: string; doubleValue?: number; intValue?: string | number };
  };
  function span(
    id: string,
    start: number,
    end: number,
    input: number,
    output: number,
    read: number,
    write: number,
  ) {
    const attributes: Attribute[] = Object.entries({
      "session.id": sessionId,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: read,
      cache_creation_tokens: write,
      prompt: "synthetic-prompt-canary",
      "user.email": "synthetic-identity-canary",
      tool_output: "synthetic-tool-canary",
    }).map(([key, value]) => ({
      key,
      value: typeof value === "number" ? { doubleValue: value } : { stringValue: value },
    }));
    return {
      name: "claude_code.llm_request",
      spanId: id,
      startTimeUnixNano: ns(start),
      endTimeUnixNano: ns(end),
      status: { code: 0 },
      attributes,
    };
  }
  function payload() {
    return {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                span("span-a", 10, 20, 2, 4, 200, 100),
                span("span-b", 40, 50, 3, 5, 400, 50),
              ],
            },
          ],
        },
      ],
    };
  }
  function firstSpan(source: ReturnType<typeof payload>) {
    const value = source.resourceSpans.at(0)?.scopeSpans.at(0)?.spans.at(0);
    if (value === undefined) throw new Error("missing synthetic request fixture");
    return value;
  }
  function whole(overrides: Record<string, unknown> = {}) {
    return parseClaudeCodeUsage(
      JSON.stringify({
        session_id: sessionId,
        is_error: false,
        num_turns: 3,
        usage: {
          input_tokens: 5,
          output_tokens: 9,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 150,
          output_tokens_details: { thinking_tokens: 2 },
        },
        ...overrides,
      }),
    );
  }
  function events() {
    const parsed = parseClaudeUsageBatch(payload());
    expect(parsed).not.toBeNull();
    return parsed ?? [];
  }

  test("reconciles every API request before cutting, counting additive cache buckets exactly once", () => {
    const usage = claudeUsageToFirstPromotion(events().toReversed(), whole(), base + 30);
    expect(usage).toEqual({
      scope: "first_promotion",
      source: "claude_request_spans",
      requests: 1,
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      totalTokens: 306,
    });
    expect(whole()?.totalTokens).toBe(764);
    expect(usage).not.toHaveProperty("thinkingTokens");
    expect(JSON.stringify(usage)).not.toContain("canary");
    expect(JSON.stringify(usage)).not.toContain(sessionId);
    expect(JSON.stringify(usage)).not.toContain("span-a");
  });

  test("reads exact nanoseconds and accepts integer OTLP string values", () => {
    const source = payload();
    const first = firstSpan(source);
    first.endTimeUnixNano = (BigInt(ns(20)) + 123n).toString();
    const input = first.attributes.find((a) => a.key === "input_tokens");
    expect(input).toBeDefined();
    if (input) input.value = { intValue: "2" };
    const parsed = parseClaudeUsageBatch(source);
    expect(parsed?.[0]?.endedAtNs).toBe(BigInt(ns(20)) + 123n);
    expect(claudeUsageToFirstPromotion(parsed ?? [], whole(), base + 30)?.totalTokens).toBe(306);
  });

  test("resource and span identities must agree; no foreign or subordinate request can borrow the root", () => {
    const source = payload();
    const resource = {
      ...source.resourceSpans[0],
      resource: {
        attributes: [{ key: "session.id", value: { stringValue: "other-session" } }],
      },
    };
    expect(parseClaudeUsageBatch({ resourceSpans: [resource] })).toBeNull();
    const child = payload();
    firstSpan(child).attributes.push({
      key: "agent_id",
      value: { stringValue: "subagent" },
    });
    expect(parseClaudeUsageBatch(child)).toBeNull();
    const foreign = events().map((event, index) =>
      index === 0 ? { ...event, sessionId: "foreign" } : event,
    );
    expect(claudeUsageToFirstPromotion(foreign, whole(), base + 30)).toBeNull();
  });

  test("rejects missing, negative, fractional, infinite, unsafe and duplicate counters", () => {
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const source = payload();
      const attributes = firstSpan(source).attributes;
      const input = attributes.find((a) => a.key === "input_tokens");
      if (input) input.value = { doubleValue: invalid };
      expect(parseClaudeUsageBatch(source)).toBeNull();
    }
    const missing = payload();
    const first = firstSpan(missing);
    first.attributes = first.attributes.filter((a) => a.key !== "cache_read_tokens");
    expect(parseClaudeUsageBatch(missing)).toBeNull();
    const duplicate = payload();
    firstSpan(duplicate).attributes.push({
      key: "input_tokens",
      value: { intValue: "2" },
    });
    expect(parseClaudeUsageBatch(duplicate)).toBeNull();
  });

  test("unknown layouts, errored requests and invalid intervals withhold evidence", () => {
    for (const source of [null, {}, [], { resourceSpans: "drift" }])
      expect(parseClaudeUsageBatch(source)).toBeNull();
    const malformed = payload();
    expect(
      parseClaudeUsageBatch({
        resourceSpans: [{ ...malformed.resourceSpans[0], resource: "drift" }],
      }),
    ).toBeNull();
    const first = firstSpan(malformed);
    expect(
      parseClaudeUsageBatch({
        resourceSpans: [{ scopeSpans: [{ spans: [{ ...first, status: "drift" }] }] }],
      }),
    ).toBeNull();
    const failed = payload();
    firstSpan(failed).status.code = 2;
    expect(parseClaudeUsageBatch(failed)).toBeNull();
    for (const end of ["nonsense", ns(9), ns(10), "0", "01"]) {
      const source = payload();
      firstSpan(source).endTimeUnixNano = end;
      expect(parseClaudeUsageBatch(source)).toBeNull();
    }
  });

  test("missing, partial, repeated or mismatched whole-session evidence never yields a partial receipt", () => {
    const all = events();
    expect(claudeUsageToFirstPromotion(all, null, base + 30)).toBeNull();
    expect(claudeUsageToFirstPromotion(all, whole(), undefined)).toBeNull();
    expect(claudeUsageToFirstPromotion([], whole(), base + 30)).toBeNull();
    expect(claudeUsageToFirstPromotion(all.slice(0, 1), whole(), base + 30)).toBeNull();
    expect(claudeUsageToFirstPromotion([...all, ...all], whole(), base + 30)).toBeNull();
    const complete = whole();
    expect(complete).not.toBeNull();
    if (complete) {
      expect(
        claudeUsageToFirstPromotion(all, { ...complete, isError: true }, base + 30),
      ).toBeNull();
      expect(
        claudeUsageToFirstPromotion(all, { ...complete, sessionId: null }, base + 30),
      ).toBeNull();
      expect(
        claudeUsageToFirstPromotion(
          all,
          { ...complete, outputTokens: 10, totalTokens: 765 },
          base + 30,
        ),
      ).toBeNull();
      expect(
        claudeUsageToFirstPromotion(
          all,
          { ...complete, inputTokens: 5.5, totalTokens: 764.5 },
          base + 30,
        ),
      ).toBeNull();
      expect(
        claudeUsageToFirstPromotion(all, { ...complete, totalTokens: 763 }, base + 30),
      ).toBeNull();
    }
  });

  test("matched spans cannot turn missing or drifted terminal error status into success", () => {
    const all = events();
    for (const is_error of [undefined, null, "true", "false", 0, 1]) {
      const terminal = whole({ is_error });
      expect(terminal).toBeNull();
      expect(claudeUsageToFirstPromotion(all, terminal, base + 30)).toBeNull();
    }
    expect(claudeUsageToFirstPromotion(all, whole(), base + 30)?.totalTokens).toBe(306);
  });

  test("overlap, touching intervals and boundary ties remain unknown", () => {
    const all = events();
    for (const boundary of [
      base + 5,
      base + 10,
      base + 15,
      base + 20,
      base + 40,
      base + 45,
      base + 50,
    ]) {
      expect(claudeUsageToFirstPromotion(all, whole(), boundary)).toBeNull();
    }
    for (const start of [BigInt(ns(19)), BigInt(ns(20))]) {
      const overlapping = all.map((event, index) =>
        index === 1 ? { ...event, startedAtNs: start } : event,
      );
      expect(claudeUsageToFirstPromotion(overlapping, whole(), base + 30)).toBeNull();
    }
    expect(claudeUsageToFirstPromotion(all, whole(), base + 60)?.totalTokens).toBe(764);
  });
});
