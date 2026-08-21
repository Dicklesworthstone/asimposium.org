import { describe, expect, test } from "bun:test";

import { HARNESS_ADAPTERS } from "./adapters.ts";
import { deepestStageReached, estimateTokens, runGauntletAttempt } from "./attempt.ts";

const adapter = HARNESS_ADAPTERS[0]!;

describe("the gauntlet attempt runner", () => {
  test("a transcript reaching close with the completion signal completes", async () => {
    const transcript = "pair session pack workshop promote close\nsession_id: S-1";
    const result = await runGauntletAttempt(0, adapter, "https://a.asimposium.org/join/X#v1.s", async () => ({
      transcript,
      tokensUsed: 12000,
    }));
    expect(result.completed).toBe(true);
    expect(result.stageReached).toBe("close");
    expect(result.tokensUsed).toBe(12000);
  });

  test("a transcript that stalls before close does not complete", async () => {
    const result = await runGauntletAttempt(0, adapter, "u", async () => ({
      transcript: "pair session pack, then it stalled",
    }));
    expect(result.completed).toBe(false);
    expect(result.stageReached).toBe("pack");
  });

  test("the completion signal alone is not enough — the loop must close", async () => {
    // The harness said hello (completion signal) but never opened a session.
    const result = await runGauntletAttempt(0, adapter, "u", async () => ({
      transcript: "hello, session_id S-1, but no loop work",
    }));
    expect(result.stageReached).not.toBe("close");
    expect(result.completed).toBe(false);
  });

  test("an absent token report falls back to the bytes/4 estimate", async () => {
    const transcript = "x".repeat(400);
    expect(estimateTokens(transcript)).toBe(100);
    const result = await runGauntletAttempt(0, adapter, "u", async () => ({ transcript }));
    expect(result.tokensUsed).toBe(100);
  });

  test("deepestStageReached reads the deepest marker in loop order", () => {
    // "close" is the deepest loop marker; if it appears anywhere, that is the depth.
    expect(deepestStageReached("close appears before promote in this text")).toBe("close");
    expect(deepestStageReached("pair and session but no further")).toBe("session");
    expect(deepestStageReached("nothing here")).toBe("none");
  });
});
