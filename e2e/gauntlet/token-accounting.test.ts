/**
 * Tests for the claude-code token accounting parser. The positive fixture is
 * the exact key layout captured from Claude Code 2.1.260 on 2026-09-04 with
 * synthetic values; the negatives pin shape-drift behavior — every drift path
 * must return null (loud fallback to the diagnostic estimate), never a guess.
 */

import { describe, expect, test } from "bun:test";

import { parseClaudeCodeUsage } from "./token-accounting.ts";

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
    ((negative.usage as Record<string, unknown>) as Record<string, unknown>).output_tokens = -4;
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
