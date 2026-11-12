/**
 * Tests for the codex exec token accounting parser. The positive fixture is
 * the exact event layout captured from OpenAI Codex v0.153.2 on 2026-09-04
 * with synthetic ids/values; negatives pin the loud-drift contract — any
 * malformed line, drifted turn usage, or absent turn.completed returns null
 * rather than a partial guess.
 */

import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import {
  codexUsageToFirstPromotion,
  parseCodexExecUsage,
  parseCodexUsageBatch,
} from "./token-accounting-codex.ts";

const REAL_SHAPE_FIXTURE = [
  '{"type":"thread.started","thread_id":"01a06ddc-0000-4000-8000-000000000000"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"assistant_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":26289,"cached_input_tokens":11136,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
  "",
].join("\n");

describe("parseCodexExecUsage", () => {
  test("parses the real captured stream and totals input plus output only", () => {
    const usage = parseCodexExecUsage(REAL_SHAPE_FIXTURE);
    expect(usage).not.toBeNull();
    expect(usage?.threadId).toBe("01a06ddc-0000-4000-8000-000000000000");
    expect(usage?.turns).toBe(1);
    expect(usage?.inputTokens).toBe(26289);
    expect(usage?.cachedInputTokens).toBe(11136);
    expect(usage?.outputTokens).toBe(5);
    expect(usage?.reasoningOutputTokens).toBe(0);
    // OpenAI semantics: cached is a subset of input; total adds input + output.
    expect(usage?.totalTokens).toBe(26289 + 5);
  });

  test("accumulates across multiple turns in one session", () => {
    const multiTurn = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":10,"output_tokens":7,"reasoning_output_tokens":3}}',
      '{"type":"turn.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":50,"cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":4}}',
    ].join("\n");
    const usage = parseCodexExecUsage(multiTurn);
    expect(usage?.turns).toBe(2);
    expect(usage?.inputTokens).toBe(300);
    expect(usage?.outputTokens).toBe(16);
    expect(usage?.totalTokens).toBe(316);
    expect(usage?.cachedInputTokens).toBe(90);
    expect(usage?.reasoningOutputTokens).toBe(7);
  });

  test("rejects subset violations as shape drift", () => {
    const drift = REAL_SHAPE_FIXTURE.replace(
      '"cached_input_tokens":11136',
      '"cached_input_tokens":99999',
    );
    expect(parseCodexExecUsage(drift)).toBeNull();

    const reasoningDrift = REAL_SHAPE_FIXTURE.replace(
      '"reasoning_output_tokens":0',
      '"reasoning_output_tokens":99',
    );
    expect(parseCodexExecUsage(reasoningDrift)).toBeNull();
  });

  test("null on malformed line, missing turn.completed, and non-object events", () => {
    expect(parseCodexExecUsage('{"type":"turn.completed","usage":{broken}}')).toBeNull();
    expect(parseCodexExecUsage('{"type":"thread.started","thread_id":"t"}')).toBeNull();
    expect(parseCodexExecUsage("42\n")).toBeNull();
    expect(parseCodexExecUsage("")).toBeNull();
  });

  test("null on a drifted usage block in any single turn", () => {
    const drift = [
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":"few"}}',
    ].join("\n");
    expect(parseCodexExecUsage(drift)).toBeNull();
  });

  test("fractional, unsafe and accumulated-overflow counts are not authoritative", () => {
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
      const drift = REAL_SHAPE_FIXTURE.replace('"input_tokens":26289', `"input_tokens":${value}`);
      expect(parseCodexExecUsage(drift)).toBeNull();
    }
    const one = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: Number.MAX_SAFE_INTEGER,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    });
    expect(parseCodexExecUsage(`${one}\n${one}`)).toBeNull();
    expect(parseCodexExecUsage(one.replace('"output_tokens":0', '"output_tokens":1'))).toBeNull();
  });

  test("a repeated, conflicting, malformed or late root declaration is ambiguous", () => {
    const root = '{"type":"thread.started","thread_id":"root"}';
    for (const id of ["root", "another-root", "", " ", "bad\nroot"]) {
      const second = JSON.stringify({ type: "thread.started", thread_id: id });
      expect(parseCodexExecUsage(`${root}\n${second}\n${REAL_SHAPE_FIXTURE}`)).toBeNull();
    }
    for (const id of [undefined, null, 1, {}, "", " ", "bad\nroot", "x".repeat(257)]) {
      const invalid = JSON.stringify({ type: "thread.started", thread_id: id });
      const turnOnly = REAL_SHAPE_FIXTURE.split("\n").slice(1).join("\n");
      expect(parseCodexExecUsage(`${invalid}\n${turnOnly}`)).toBeNull();
    }
    expect(parseCodexExecUsage(`{"type":"turn.started"}\n${root}\n`)).toBeNull();
    const completed = REAL_SHAPE_FIXTURE.split("\n").find((line) =>
      line.includes("turn.completed"),
    );
    assert(completed);
    expect(parseCodexExecUsage(`${completed}\n${root}`)).toBeNull();
  });
});

// Observed OTLP layout; only synthetic identifiers and numbers. Raw provider
// payloads, account/email metadata, prompts and tool strings are never fixtures.
const BASE = Date.parse("2026-11-11T00:00:00.000Z");
function event(kind: "prompt" | "request" | "response", ms: number, input = 0, output = 0) {
  const fields: Record<string, string> = {
    "event.name":
      kind === "prompt"
        ? "codex.user_prompt"
        : kind === "request"
          ? "codex.websocket_request"
          : "codex.sse_event",
    "conversation.id": "root-thread",
    "event.timestamp": new Date(BASE + ms).toISOString(),
    ...(kind === "request" ? { success: "true" } : {}),
    ...(kind === "response"
      ? {
          "event.kind": "response.completed",
          input_token_count: String(input),
          cached_token_count: "0",
          cache_write_token_count: "0",
          output_token_count: String(output),
          reasoning_token_count: "0",
        }
      : {}),
  };
  return {
    timeUnixNano: "0",
    attributes: Object.entries(fields).map(([key, stringValue]) => ({
      key,
      value: { stringValue },
    })),
  };
}
function batch(logRecords: unknown[]) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords }] }] };
}
function whole() {
  return parseCodexExecUsage(
    [
      '{"type":"thread.started","thread_id":"root-thread"}',
      '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":0}}',
    ].join("\n"),
  );
}
function validEvents() {
  return parseCodexUsageBatch(
    batch([
      event("response", 1, 2), // real startup traffic is outside CLI turn totals
      event("prompt", 10),
      event("request", 12),
      event("response", 20, 100, 10),
      event("request", 32),
      event("response", 40, 200, 20),
    ]),
  );
}

describe("first-promotion Codex request accounting", () => {
  test("binds the root turn, excludes startup, reconciles all totals, cuts before handback", () => {
    const events = validEvents();
    expect(events).not.toBeNull();
    expect(codexUsageToFirstPromotion(events ?? [], whole(), BASE + 30)).toEqual({
      scope: "first_promotion",
      source: "codex_websocket_intervals",
      requests: 1,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 110,
    });
    expect(
      codexUsageToFirstPromotion([...(events ?? [])].reverse(), whole(), BASE + 30)?.totalTokens,
    ).toBe(110);
  });

  test("missing, duplicate, wrong-root and mismatched terminal evidence withholds measurement", () => {
    const events = validEvents() ?? [];
    const first = events.find((item) => item.kind === "response" && item.atMs > BASE + 10);
    expect(first).toBeDefined();
    expect(
      codexUsageToFirstPromotion(
        events.filter((e) => e !== first),
        whole(),
        BASE + 30,
      ),
    ).toBeNull();
    expect(
      codexUsageToFirstPromotion([...events, ...(first ? [first] : [])], whole(), BASE + 30),
    ).toBeNull();
    expect(
      codexUsageToFirstPromotion(
        events.map((e) => (e === first ? { ...e, threadId: "other" } : e)),
        whole(),
        BASE + 30,
      ),
    ).toBeNull();
    expect(codexUsageToFirstPromotion(events, null, BASE + 30)).toBeNull();
    expect(codexUsageToFirstPromotion(events, whole(), undefined)).toBeNull();
    expect(codexUsageToFirstPromotion(events, whole(), BASE + 20)).toBeNull();
    expect(codexUsageToFirstPromotion(events, whole(), BASE + 9)).toBeNull();
    expect(
      codexUsageToFirstPromotion(
        events.filter((e) => e.kind !== "prompt"),
        whole(),
        BASE + 30,
      ),
    ).toBeNull();
    const terminal = whole();
    assert(terminal);
    expect(
      codexUsageToFirstPromotion(
        events,
        { ...terminal, inputTokens: 301, totalTokens: 331 },
        BASE + 30,
      ),
    ).toBeNull();
    const ambiguous = parseCodexExecUsage(
      [
        '{"type":"thread.started","thread_id":"another-root"}',
        '{"type":"thread.started","thread_id":"root-thread"}',
        '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":0}}',
      ].join("\n"),
    );
    expect(codexUsageToFirstPromotion(events, ambiguous, BASE + 30)).toBeNull();
  });

  test("cache and reasoning counts reconcile independently and remain subsets", () => {
    const source = validEvents();
    const terminal = whole();
    assert(source && terminal);
    const events = source.map((item) => {
      if (item.kind !== "response" || item.atMs <= BASE + 10) return item;
      assert(item.usage);
      return {
        ...item,
        usage: {
          ...item.usage,
          cachedInputTokens: item.atMs === BASE + 20 ? 50 : 100,
          cacheWriteInputTokens: item.atMs === BASE + 20 ? 3 : 0,
          reasoningOutputTokens: item.atMs === BASE + 20 ? 4 : 8,
        },
      };
    });
    const expected = {
      ...terminal,
      cachedInputTokens: 150,
      cacheWriteInputTokens: 3,
      reasoningOutputTokens: 12,
    };
    expect(codexUsageToFirstPromotion(events, expected, BASE + 30)).toMatchObject({
      totalTokens: 110,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 3,
      reasoningOutputTokens: 4,
    });
    for (const field of [
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "reasoningOutputTokens",
    ] as const) {
      expect(
        codexUsageToFirstPromotion(
          events,
          { ...expected, [field]: expected[field] + 1 },
          BASE + 30,
        ),
      ).toBeNull();
    }
  });

  test("a straddling, failed, missing or ambiguous request cannot undercount the boundary", () => {
    const events = validEvents() ?? [];
    expect(
      codexUsageToFirstPromotion(
        events.map((item) =>
          item.kind === "request" && item.atMs === BASE + 32 ? { ...item, atMs: BASE + 25 } : item,
        ),
        whole(),
        BASE + 30,
      ),
    ).toBeNull();
    expect(
      codexUsageToFirstPromotion(
        events.filter((item) => item.kind !== "request"),
        whole(),
        BASE + 30,
      ),
    ).toBeNull();
    expect(
      codexUsageToFirstPromotion(
        events.map((item) => (item.kind === "request" ? { ...item, success: false } : item)),
        whole(),
        BASE + 30,
      ),
    ).toBeNull();
    expect(
      codexUsageToFirstPromotion(
        events.map((item) =>
          item.kind === "request" && item.atMs === BASE + 32 ? { ...item, atMs: BASE + 20 } : item,
        ),
        whole(),
        BASE + 30,
      ),
    ).toBeNull();
  });

  test("conflicting OTLP scalar alternatives cannot select a convenient counter or identity", () => {
    for (const field of ["event.name", "conversation.id", "event.timestamp", "input_token_count"]) {
      const log = event("response", 20, 100, 10);
      const ambiguous = {
        ...log,
        attributes: log.attributes.map((attribute) =>
          attribute.key === field
            ? { ...attribute, value: { ...attribute.value, intValue: "999" } }
            : attribute,
        ),
      };
      expect(parseCodexUsageBatch(batch([ambiguous]))).toBeNull();
    }
  });

  test("validates every numeric component, millisecond clock and attribute uniqueness", () => {
    for (const value of ["1.5", "-1", "NaN", "9007199254740992", "01"]) {
      const log = event("response", 20, 100, 10);
      const counter = log.attributes.find((a) => a.key === "input_token_count");
      assert(counter);
      counter.value.stringValue = value;
      expect(parseCodexUsageBatch(batch([log]))).toBeNull();
    }
    const malformedTime = event("prompt", 10);
    const timestamp = malformedTime.attributes.find((a) => a.key === "event.timestamp");
    assert(timestamp);
    timestamp.value.stringValue = "2026-02-30T00:00:00.000Z";
    expect(parseCodexUsageBatch(batch([malformedTime]))).toBeNull();
    const duplicate = event("response", 20, 100, 10);
    const firstAttribute = duplicate.attributes[0];
    assert(firstAttribute);
    duplicate.attributes.push(firstAttribute);
    expect(parseCodexUsageBatch(batch([duplicate]))).toBeNull();
    expect(parseCodexUsageBatch({})).toBeNull();
    expect(parseCodexUsageBatch(batch([{}]))).toBeNull();
  });

  test("prompt, tool, account and unknown field canaries never reach numeric evidence", () => {
    const canary = "synthetic-sensitive-content-never-retained";
    const log = event("response", 20, 100, 10);
    for (const key of ["prompt", "tool_arguments", "output", "user.email", "unrecognized"]) {
      log.attributes.push({ key, value: { stringValue: canary } });
    }
    const parsed = parseCodexUsageBatch(batch([log]));
    expect(parsed).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain(canary);
    expect(Object.keys(parsed?.[0] ?? {}).sort()).toEqual(["atMs", "kind", "threadId", "usage"]);
  });
});
