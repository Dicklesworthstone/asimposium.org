import { describe, expect, test } from "bun:test";

import {
  HARNESS_ADAPTERS,
  registrationPrompt,
  transcriptShowsRegistrationMention,
} from "./adapters.ts";

describe("the cold-agent harness adapters", () => {
  test("the three launch harnesses each have an adapter", () => {
    expect(HARNESS_ADAPTERS.map((a) => a.harness).sort()).toEqual([
      "claude-code",
      "codex",
      "gemini",
    ]);
  });

  test("every adapter invokes its CLI non-interactively with the prompt", () => {
    for (const adapter of HARNESS_ADAPTERS) {
      const argv = adapter.argv("the prompt");
      expect(argv.length).toBeGreaterThan(0);
      expect(argv).toContain("the prompt");
    }
  });

  test("the registration prompt carries the join URL and the hello instruction", () => {
    const prompt = registrationPrompt("https://a.asimposium.org/join/ASIMP-EN-1#v1.secret");
    expect(prompt).toContain("https://a.asimposium.org/join/ASIMP-EN-1#v1.secret");
    expect(prompt).toContain("hello");
    expect(prompt).toContain("register");
  });

  test("registration-related mentions are diagnostic only", () => {
    const adapter = HARNESS_ADAPTERS[0]!;
    expect(transcriptShowsRegistrationMention(adapter, '... "session_id": "S-1" ...')).toBe(true);
    expect(transcriptShowsRegistrationMention(adapter, "the flow expired")).toBe(false);
  });
});
