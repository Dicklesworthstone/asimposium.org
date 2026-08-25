import { describe, expect, test } from "bun:test";

import { HARNESS_ADAPTERS } from "./adapters.ts";
import {
  deepestStageReached,
  estimateTokens,
  runGauntletAttempt,
  transcriptMentionsAllStages,
} from "./attempt.ts";

const adapter = HARNESS_ADAPTERS[0]!;

describe("the gauntlet attempt runner", () => {
  test("keyword soup cannot mint completion", async () => {
    const transcript = "pair session pack workshop promote close\nsession_id: S-1";
    const result = await runGauntletAttempt(
      0,
      adapter,
      "https://a.asimposium.org/join/X#v1.s",
      async () => ({
        transcript,
        tokensUsed: 12000,
      }),
    );
    expect(transcriptMentionsAllStages(transcript)).toBe(true);
    expect(result.completed).toBe(false);
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

  test("a hello/session mention alone cannot establish completion", async () => {
    // The transcript mentions hello and a session but contains no state-derived evidence.
    const result = await runGauntletAttempt(0, adapter, "u", async () => ({
      transcript: "hello, session_id S-1, but no loop work",
    }));
    expect(result.stageReached).not.toBe("close");
    expect(result.completed).toBe(false);
  });

  test("an absent token report gets a diagnostic bytes/4 estimate", async () => {
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

  test("a shallow hello-only transcript fails completion despite hello keyword", async () => {
    const transcript = "hello from agent, registration successful, fellow token received";
    const result = await runGauntletAttempt(0, adapter, "u", async () => ({ transcript }));
    expect(result.completed).toBe(false);
    expect(result.stageReached).toBe("none");
  });

  test("a transcript missing intermediate stages fails completion even if close appears", async () => {
    const transcript = "pair session close\nsession_id: S-1";
    const result = await runGauntletAttempt(0, adapter, "u", async () => ({ transcript }));
    expect(result.completed).toBe(false);
    expect(result.stageReached).toBe("close");
  });
});
