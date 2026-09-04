/**
 * Tests for the codex exec token accounting parser. The positive fixture is
 * the exact event layout captured from OpenAI Codex v0.153.2 on 2026-09-04
 * with synthetic ids/values; negatives pin the loud-drift contract — any
 * malformed line, drifted turn usage, or absent turn.completed returns null
 * rather than a partial guess.
 */

import { describe, expect, test } from "bun:test";

import { parseCodexExecUsage } from "./token-accounting-codex.ts";

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
});
