import { describe, expect, test } from "bun:test";

import { HARNESS_ADAPTERS } from "./adapters.ts";
import { assignHarnesses, runGauntlet } from "./orchestrate.ts";

const COMPLETING = "pair session pack workshop promote close\nsession_id: S-1";

describe("the gauntlet orchestrator", () => {
  test("harnesses rotate across the adapters (diversity is structural)", () => {
    expect(assignHarnesses(6)).toEqual([
      "claude-code", "codex", "gemini", "claude-code", "codex", "gemini",
    ]);
    expect(assignHarnesses(3)).toEqual(["claude-code", "codex", "gemini"]);
  });

  test("a full run of completing attempts across all harnesses passes", async () => {
    const joinUrls = Array.from({ length: 9 }, (_, i) => `https://a.asimposium.org/join/E${i}#v1.s`);
    const run = await runGauntlet(joinUrls, async () => ({ transcript: COMPLETING, tokensUsed: 15000 }));
    expect(run.results).toHaveLength(9);
    expect(run.scorecard.completed).toBe(9);
    expect(run.scorecard.harnesses).toHaveLength(3);
    expect(run.scorecard.passed).toBe(true);
  });

  test("a run with stalling attempts fails honestly", async () => {
    const joinUrls = Array.from({ length: 9 }, (_, i) => `u${i}`);
    const run = await runGauntlet(joinUrls, async () => ({ transcript: "pair session pack then stalled" }));
    expect(run.scorecard.completed).toBe(0);
    expect(run.scorecard.passed).toBe(false);
  });

  test("the harness coverage is ≥ 3 by construction at 9 attempts", async () => {
    const joinUrls = Array.from({ length: 9 }, (_, i) => `u${i}`);
    const seen = new Set<string>();
    await runGauntlet(joinUrls, async (adapter) => {
      seen.add(adapter.harness);
      return { transcript: COMPLETING, tokensUsed: 10000 };
    });
    expect(seen.size).toBe(HARNESS_ADAPTERS.length);
  });
});
