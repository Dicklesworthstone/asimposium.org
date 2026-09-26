import { describe, expect, test } from "bun:test";
import { classifyUnavailable, HARNESSES } from "./harness-agent.mjs";

// A harness that never started is "blocked", not a measured cold-agent failure
// (bead asimposiumorg-pcsn). The codex lines are the ones codex-cli 0.157.0
// printed on this host on 2026-09-26.
describe("harness start failures are classified, agent failures are not", () => {
  test("codex usage limit from its error events", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 4:59 AM."}',
      '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit."}}',
    ].join("\n");
    expect(HARNESSES.codex.unavailable(stdout, "Reading additional input from stdin...\n")).toBe(
      "usage-limit",
    );
  });
  test("codex agent output mentioning limits is not read", () => {
    const stdout =
      '{"type":"item.completed","item":{"type":"agent_message","text":"the API rate limit is 60/min"}}';
    expect(HARNESSES.codex.unavailable(stdout, "")).toBeNull();
  });
  test("gemini missing auth from stderr", () => {
    expect(
      HARNESSES.gemini.unavailable(
        "",
        "When using Gemini API, you must specify the GEMINI_API_KEY environment variable.",
      ),
    ).toBe("auth");
  });
  test("claude-code error result", () => {
    const stdout = JSON.stringify({
      is_error: true,
      result: "Invalid API key · Please run /login",
    });
    expect(HARNESSES["claude-code"].unavailable(stdout, "")).toBe("auth");
    const ok = JSON.stringify({ is_error: false, result: "the usage limit endpoint returned 429" });
    expect(HARNESSES["claude-code"].unavailable(ok, "")).toBeNull();
  });
  test("an ordinary failure stays a measurement", () => {
    expect(classifyUnavailable("TypeError: fetch failed")).toBeNull();
  });
});
