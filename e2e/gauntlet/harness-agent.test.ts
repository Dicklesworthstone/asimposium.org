import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyUnavailable,
  HARNESSES,
  harnessUsageDetails,
  retainedRouteTemplate,
  runHarnessAgent,
  sponsorPasteBlock,
  startCodexUsageCollector,
} from "./harness-agent.mjs";
import { parseCodexExecUsage } from "./token-accounting-codex.ts";

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
  test("Claude's observed structured 429 is unavailable even with neutral error text", () => {
    expect(
      HARNESSES["claude-code"].unavailable(
        JSON.stringify({ is_error: true, api_error_status: 429, result: "request failed" }),
        "",
      ),
    ).toBe("usage-limit");
    expect(
      HARNESSES["claude-code"].unavailable(
        JSON.stringify({ is_error: false, api_error_status: 429, result: "ordinary agent text" }),
        "a transient rate limit was retried successfully",
      ),
    ).toBeNull();
  });
  test("grok not signed in (stdout error object, exit 0)", () => {
    // grok 1.0.46 printed this on 2026-10-02 with no credentials.
    const stdout = JSON.stringify({
      type: "error",
      message:
        "Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.",
    });
    expect(HARNESSES.grok.reportsStartFailureOnSuccess).toBe(true);
    expect(HARNESSES.grok.unavailable(stdout, "")).toBe("auth");
    expect(HARNESSES.grok.unavailable('{"type":"result","text":"not signed in"}', "")).toBeNull();
  });
  test("an ordinary failure stays a measurement", () => {
    expect(classifyUnavailable("TypeError: fetch failed")).toBeNull();
  });
});

describe("real participation transport and retained evidence", () => {
  const joinUrl = `http://127.0.0.1:12345/join/ASIMP-EN-UNIT#v1.${"A".repeat(43)}`;

  test.each(["claude-code", "codex"] as const)(
    "%s sends the paste on stdin and requests ephemeral execution",
    async (harness) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "asimp-harness-transport-"));
      const fixture = join(fixtureRoot, "transport.cjs");
      const observation = join(fixtureRoot, "observed.json");
      const privateStderr = "synthetic-private-stderr-that-must-not-be-retained";
      // UNIT fixture, not a model or product-flow result. The actual child
      // records booleans only; neither stdin nor argv is retained.
      writeFileSync(
        fixture,
        `const fs=require("node:fs");
let input="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{input+=chunk;});
process.stdin.on("end",()=>{
 const args=process.argv.slice(2);
 fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({
  secretInArgv:args.some(arg=>arg.includes("ASIMP-EN-")||arg.includes("v1.")),
  stdinHasPaste:input.startsWith("You are pairing with ASImposium as my agent.")&&input.includes("#v1."),
  ephemeral:args.includes("--ephemeral")||args.includes("--no-session-persistence")
 }));
 process.stderr.write(${JSON.stringify(privateStderr)});
 process.stdout.write(JSON.stringify({usage:{input_tokens:1,output_tokens:2,cache_creation_input_tokens:0,cache_read_input_tokens:0}}));
});`,
        { mode: 0o600 },
      );
      const run = await runHarnessAgent(harness, joinUrl, {
        timeoutMs: 5_000,
        spawnProcess: (_binary, args, options) =>
          spawn(process.execPath, [fixture, ...args], options),
      });
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({
        secretInArgv: false,
        stdinHasPaste: true,
        ephemeral: true,
      });
      expect(JSON.stringify(run)).not.toContain(privateStderr);
      expect(run).not.toHaveProperty("stderrTail");
      expect(run).toHaveProperty("stderrBytes", Buffer.byteLength(privateStderr));
      expect(run).toHaveProperty(
        "stderrSha256",
        createHash("sha256").update(privateStderr).digest("hex"),
      );
      expect(JSON.stringify(run)).not.toContain(joinUrl);
    },
  );

  test("the full paste is absent from both supported invocation argument lists", () => {
    const paste = sponsorPasteBlock(joinUrl);
    for (const harness of ["claude-code", "codex"] as const) {
      expect(HARNESSES[harness].argv(paste).some((arg) => arg.includes(joinUrl))).toBe(false);
    }
    expect(HARNESSES.codex.argv(paste)).toContain("--ignore-user-config");
  });

  test.each(["gemini", "grok"] as const)(
    "%s refuses an unverified persistence boundary before spawning",
    async (harness) => {
      let spawned = false;
      const run = await runHarnessAgent(harness, joinUrl, {
        spawnProcess: () => {
          spawned = true;
          throw new Error("a privacy-unavailable harness must not spawn");
        },
      });
      expect(spawned).toBe(false);
      expect(run.unavailable).toBe("privacy-prerequisite");
      expect(run.exitCode).toBeNull();
      expect(run.tokens).toBeNull();
      expect(run.transcriptBytes).toBe(0);
    },
  );

  test("a missing CLI is an unavailable prerequisite, with no claimed model work", async () => {
    const run = await runHarnessAgent("codex", joinUrl, {
      timeoutMs: 5_000,
      spawnProcess: (_binary, _args, options) =>
        spawn("/asimposium-unit-no-such-harness-binary", [], options),
    });
    expect(run.unavailable).toBe("binary-unavailable");
    expect(run.exitCode).toBeNull();
    expect(run.transcriptBytes).toBe(0);
    expect(run.tokens).toBeNull();
  });

  test("oversized stdout is fully drained and hashed without a partial token total", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "asimp-harness-overflow-"));
    const fixture = join(fixtureRoot, "overflow.cjs");
    const usage = {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    };
    const prefix = `${JSON.stringify(usage)}\n`;
    const spaceCount = 17 * 1024 * 1024;
    writeFileSync(
      fixture,
      `process.stdin.resume();process.stdout.write(${JSON.stringify(prefix)});process.stdout.write(" ".repeat(${spaceCount}));`,
      { mode: 0o600 },
    );
    const run = await runHarnessAgent("codex", joinUrl, {
      timeoutMs: 5_000,
      spawnProcess: (_binary, args, options) =>
        spawn(process.execPath, [fixture, ...args], options),
    });
    expect(run.exitCode).toBe(0);
    expect(run.transcriptBytes).toBe(Buffer.byteLength(prefix) + spaceCount);
    expect(run.transcriptTruncated).toBe(true);
    expect(run.transcriptSha256).toBe(
      createHash("sha256").update(prefix).update(" ".repeat(spaceCount)).digest("hex"),
    );
    expect(run.tokens).toBeNull();
    expect(run.tokenUsage).toBeNull();
  });

  test.each([
    ["/", "/"],
    ["/v1/hello", "/v1/hello"],
    ["/join/ASIMP-EN-private-value", "/join/:enrollment"],
    ["/v1/sessions/S-private-value/pack", "/v1/sessions/:session/pack"],
    ["/v1/sessions/S-private-value/promote", "/v1/sessions/:session/promote"],
    ["/schemas/sessions.v1/workshop_push_request.json", "/schemas/:schema"],
    ["/unknown/asimp_ag_private-value", "unrecognized"],
    ["/unknown/v1.private-value/more", "unrecognized"],
  ])("retained route %s contains only a fixed template", (path, expected) => {
    expect(retainedRouteTemplate(path)).toBe(expected);
  });
});

describe("the real runner uses the existing complete usage accounting", () => {
  test("Codex adds every completed turn instead of keeping the last one", () => {
    const turn = (input: number, output: number) =>
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
        },
      });
    const complete = `${turn(100, 20)}\n${turn(300, 40)}\n`;
    expect(HARNESSES.codex.tokens(complete)).toBe(460);
    expect(harnessUsageDetails("codex", complete)).toMatchObject({
      scope: "whole_session",
      turns: 2,
      inputTokens: 400,
      outputTokens: 60,
      totalTokens: 460,
    });
    expect(harnessUsageDetails("codex", complete)).not.toHaveProperty("threadId");
    expect(HARNESSES.codex.tokens(`${turn(100, 20)}\n{"type":"turn.completed"}\n`)).toBeNull();
  });

  test("Claude missing usage is unknown and cache accounting remains additive", () => {
    expect(HARNESSES["claude-code"].tokens("{}")).toBeNull();
    expect(
      HARNESSES["claude-code"].tokens(
        JSON.stringify({
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
      ),
    ).toMatchObject({ total: 10, input: 1, output: 2, cache_write: 3, cache_read: 4 });
  });
});

describe("run-local numeric usage receiver", () => {
  const base = Date.parse("2026-11-11T00:00:00.000Z");
  const terminal = [
    '{"type":"thread.started","thread_id":"unit-root"}',
    '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":0}}',
  ].join("\n");
  function payload() {
    const logs = [
      { name: "codex.user_prompt", at: 10, input: 0, output: 0 },
      { name: "codex.websocket_request", at: 15, input: 0, output: 0 },
      { name: "codex.sse_event", at: 20, input: 100, output: 10 },
      { name: "codex.websocket_request", at: 35, input: 0, output: 0 },
      { name: "codex.sse_event", at: 40, input: 200, output: 20 },
    ].map((row) => ({
      attributes: Object.entries({
        "event.name": row.name,
        "conversation.id": "unit-root",
        "event.timestamp": new Date(base + row.at).toISOString(),
        "event.kind": "response.completed",
        success: "true",
        input_token_count: String(row.input),
        cached_token_count: "0",
        cache_write_token_count: "0",
        output_token_count: String(row.output),
        reasoning_token_count: "0",
        prompt: "synthetic-prompt-canary",
        tool_arguments: "synthetic-tool-canary",
        "user.email": "synthetic-account-canary",
      }).map(([key, stringValue]) => ({ key, value: { stringValue } })),
    }));
    return { resourceLogs: [{ scopeLogs: [{ logRecords: logs }] }] };
  }
  function connection(argv: readonly string[]) {
    const exporter = argv.find((arg) => arg.startsWith("otel.exporter="));
    assert(exporter);
    const url = /endpoint="([^"]+)"/.exec(exporter)?.[1];
    const token = /"x-asimp-usage-token"="([^"]+)"/.exec(exporter)?.[1];
    assert(url && token);
    return { url, token };
  }

  test("authenticates, waits for closure, drops content, and closes idempotently", async () => {
    const receiver = await startCodexUsageCollector();
    const { url, token } = connection(receiver.argv);
    try {
      expect(new URL(url).hostname).toBe("127.0.0.1");
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
      const response = await fetch(url, {
        method: "POST",
        headers: { "x-asimp-usage-token": token },
        body: JSON.stringify(payload()),
      });
      expect(response.status).toBe(200);
      expect(receiver.usage(parseCodexExecUsage(terminal), base + 30)).toBeNull();
      await receiver.close();
      const usage = receiver.usage(parseCodexExecUsage(terminal), base + 30);
      expect(usage?.totalTokens).toBe(110);
      expect(JSON.stringify(usage)).not.toContain("canary");
      expect(JSON.stringify(usage)).not.toContain("unit-root");
      await receiver.close();
      let refused = false;
      try {
        await fetch(url);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    } finally {
      await receiver.close();
    }
  });

  test("an authenticated malformed or oversized batch poisons the measurement", async () => {
    for (const bad of ["{broken", " ".repeat(1024 * 1024 + 1)]) {
      const receiver = await startCodexUsageCollector();
      const { url, token } = connection(receiver.argv);
      try {
        let rejected = false;
        try {
          const result = await fetch(url, {
            method: "POST",
            headers: { "x-asimp-usage-token": token },
            body: bad,
          });
          rejected = result.status === 400;
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
        const accepted = await fetch(url, {
          method: "POST",
          headers: { "x-asimp-usage-token": token },
          body: JSON.stringify(payload()),
        });
        expect(accepted.status).toBe(200);
        await receiver.close();
        expect(receiver.usage(parseCodexExecUsage(terminal), base + 30)).toBeNull();
      } finally {
        await receiver.close();
      }
    }
  });

  test("the actual child transport wires privacy controls and reconciled counters", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "asimp-harness-usage-"));
    const fixture = join(fixtureRoot, "numeric.cjs");
    const observation = join(fixtureRoot, "flags.json");
    writeFileSync(
      fixture,
      `const fs=require("node:fs");
const args=process.argv.slice(2);
const exporter=args.find(arg=>arg.startsWith("otel.exporter="));
const url=/endpoint="([^"]+)"/.exec(exporter)?.[1];
const token=/"x-asimp-usage-token"="([^"]+)"/.exec(exporter)?.[1];
process.stdin.resume();
process.stdin.on("end",async()=>{
 fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({
  promptsOff:args.includes("otel.log_user_prompt=false"),
  responsesOff:args.includes("otel.log_agent_responses=false"),
  rationalesOff:args.includes("otel.log_guardian_assessments=false"),
  outputOff:args.includes("otel.tool_result.max_bytes=0"),
  metricsOff:args.includes('otel.metrics_exporter="none"'),
  tracesOff:args.includes('otel.trace_exporter="none"')
 }));
 const r=await fetch(url,{method:"POST",headers:{"x-asimp-usage-token":token},body:${JSON.stringify(JSON.stringify(payload()))}});
 if(r.status!==200)process.exitCode=1;
 process.stdout.write(${JSON.stringify(terminal)});
});`,
      { mode: 0o600 },
    );
    const run = await runHarnessAgent("codex", "https://unit.example/join/synthetic#v1.synthetic", {
      timeoutMs: 5000,
      firstPromotionAt: () => base + 30,
      spawnProcess: (_binary, args, options) =>
        spawn(process.execPath, [fixture, ...args], options),
    });
    expect(run.exitCode).toBe(0);
    expect(run.firstPromotionTokenUsage?.totalTokens).toBe(110);
    expect(run.tokenUsage?.totalTokens).toBe(330);
    expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({
      promptsOff: true,
      responsesOff: true,
      rationalesOff: true,
      outputOff: true,
      metricsOff: true,
      tracesOff: true,
    });
    expect(JSON.stringify(run)).not.toContain("canary");
    expect(JSON.stringify(run)).not.toContain("x-asimp-usage-token");
  });
});
