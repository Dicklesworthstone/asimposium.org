/**
 * Real harness agents for the local cold-agent rehearsal (bead asimposiumorg-pcsn).
 *
 * Node counterpart of real-spawn.ts (which needs Bun; the local target needs
 * genuine Node for Wrangler's harness). Same discipline:
 * - the child gets an allowlisted environment, never sponsor secrets;
 * - a hard deadline with SIGTERM then SIGKILL;
 * - the transcript is never retained or written (Rule A11). Only counts,
 *   digests, numeric provider usage and coarse statuses leave this module.
 *   Supported adapters disable CLI session recording; other adapters report
 *   the missing privacy prerequisite before starting. Stall points come from the local
 *   target's server-side observations, not from agent text.
 *
 * Each harness runs in its own empty scratch directory with tool permissions
 * narrowed as far as each CLI allows for autonomous HTTP work.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeUsageToFirstPromotion,
  parseClaudeCodeUsage,
  parseClaudeUsageBatch,
} from "./token-accounting.ts";
import {
  codexUsageToFirstPromotion,
  parseCodexExecUsage,
  parseCodexUsageBatch,
} from "./token-accounting-codex.ts";

const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER"];

/** The sponsor's paste block from README.md, plus the one task a sponsor would add. */
export function sponsorPasteBlock(joinUrl) {
  return [
    "You are pairing with ASImposium as my agent.",
    `Your join URL is  ${joinUrl}`,
    "",
    '1. GET the path only, up to but not including the "#". The fragment',
    "   after it is a secret: submit it solely in the registration POST",
    "   body, never in a URL, a log, or an echoed message.",
    "2. Follow the capsule you get back. Do not invent a token.",
    "3. After I approve you, GET /v1/hello on the same origin as the join URL",
    "   and follow next_actions. Prefer session → pack → workshop → promote.",
    "",
    "Do not send me a password. I will approve you from a card.",
    "Use User-Agent: asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org) on HTTP requests.",
    "",
    "Task: make one small, correct, falsifiable contribution to the problem you are bound to,",
    "then close your session with a short handback. Work autonomously; I am not watching.",
  ].join("\n");
}

export const HARNESSES = {
  "claude-code": {
    binary: "claude",
    reportsStartFailureOnSuccess: true,
    argv: () => [
      "-p",
      "--no-session-persistence",
      "--safe-mode",
      "--output-format",
      "json",
      // Permission rules alone leave the other builtins in the model context.
      // This HTTP-only rehearsal needs only the shell tool below.
      "--tools",
      "Bash",
      "--allowedTools",
      "Bash(curl:*)",
      "Bash(jq:*)",
      "Bash(printf:*)",
      "Bash(echo:*)",
      "Bash(cat:*)",
      "Bash(sleep:*)",
    ],
    tokens: (stdout) => {
      const usage = parseClaudeCodeUsage(stdout);
      return usage
        ? {
            total: usage.totalTokens,
            input: usage.inputTokens,
            output: usage.outputTokens,
            cache_write: usage.cacheCreationInputTokens,
            cache_read: usage.cacheReadInputTokens,
            turns: usage.numTurns,
          }
        : null;
    },
    unavailable: (stdout, stderr) => {
      let result = "";
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error === false) return null;
        if (parsed.is_error) {
          // Current CLI errors can have a neutral result string and carry the
          // provider refusal only in structured metadata, before any model work.
          if (parsed.api_error_status === 429) return "usage-limit";
          if (parsed.api_error_status === 401 || parsed.api_error_status === 403) return "auth";
          result = String(parsed.result ?? "");
        }
      } catch {
        /* no result object: fall through to stderr */
      }
      return classifyUnavailable(`${result}\n${stderr}`);
    },
  },
  codex: {
    binary: "codex",
    argv: () => [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      // A cold agent has no operator MCP servers; the user's config may list some.
      "-c",
      "mcp_servers={}",
      // Empty cwd and ignored config do not omit the host's skill catalog.
      // The cold-agent task starts with the sponsor paste and served capsule.
      "-c",
      "skills.include_instructions=false",
      "--json",
      "-",
    ],
    tokens: (stdout) => parseCodexExecUsage(stdout)?.totalTokens ?? null,
    unavailable: (stdout, stderr) => {
      // Only the CLI's own error events are read, never agent content (A11).
      const errors = [];
      for (const line of stdout.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "error") errors.push(String(event.message ?? ""));
          if (event.type === "turn.failed") errors.push(String(event.error?.message ?? ""));
        } catch {
          /* not an event line */
        }
      }
      return classifyUnavailable(`${errors.join("\n")}\n${stderr}`);
    },
  },
  gemini: {
    binary: "gemini",
    // The installed recorder unconditionally persists messages and thoughts.
    // No documented recording-disable control is available on this version.
    privacyUnavailable: true,
    argv: () => [
      "-p",
      "Follow the sponsor paste on stdin.",
      "--approval-mode",
      "yolo",
      "-o",
      "json",
    ],
    tokens: (stdout) => {
      try {
        const models = JSON.parse(stdout).stats?.models ?? {};
        let total = 0;
        for (const model of Object.values(models)) total += model.tokens?.total ?? 0;
        return total || null;
      } catch {
        return null;
      }
    },
    unavailable: (_stdout, stderr) => classifyUnavailable(stderr),
  },
  // Grok Build 1.0.x headless mode. It reports a start failure (e.g. not signed
  // in) as a JSON error object on stdout and still exits 0.
  grok: {
    binary: "grok",
    // No ephemeral session control has been verified for this adapter.
    privacyUnavailable: true,
    argv: () => [
      "--prompt-file",
      "/dev/stdin",
      "--output-format",
      "json",
      "--always-approve",
      "--no-subagents",
      "--disable-web-search",
    ],
    reportsStartFailureOnSuccess: true,
    // The success shape of its JSON output is not yet observed on this host;
    // no token total is claimed until it is.
    tokens: () => null,
    unavailable: (stdout, stderr) => {
      // Only a top-level CLI error object is read, never agent content (A11).
      let message = "";
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.type === "error") message = String(parsed.message ?? "");
      } catch {
        /* not a single JSON object */
      }
      return classifyUnavailable(`${message}\n${stderr}`);
    },
  },
};

/** Only fixed route templates leave the real-harness measurement. Arbitrary
 * paths can contain a misplaced credential or scientific text. */
export function retainedRouteTemplate(path) {
  if (
    [
      "/",
      "/v1/hello",
      "/v1/fellows",
      "/protocol.md",
      "/skill.md",
      "/policy.md",
      "/AGENTS.md",
      "/inoculation.md",
      "/capabilities",
      "/schemas/index.json",
    ].includes(path)
  )
    return path;
  if (/^\/join\/[^/]+$/.test(path)) return "/join/:enrollment";
  if (path === "/v1/sessions") return "/v1/sessions";
  const session = /^\/v1\/sessions\/[^/]+(?:\/(pack|workshop|promote|close|heartbeat))?$/.exec(
    path,
  );
  if (session) return `/v1/sessions/:session${session[1] ? `/${session[1]}` : ""}`;
  if (/^\/v1\/enrollments\/[^/]+\/flow-token$/.test(path))
    return "/v1/enrollments/:enrollment/flow-token";
  if (/^\/schemas\/[^/]+(?:\/[^/]+)?$/.test(path)) return "/schemas/:schema";
  if (/^\/p\/[^/]+$/.test(path)) return "/p/:problem";
  return "unrecognized";
}

/** Numeric provider-reported usage only. The boundary is the whole harness
 * run; this is not a measurement at the first promotion. */
export function harnessUsageDetails(harness, stdout) {
  if (harness === "codex") {
    const usage = parseCodexExecUsage(stdout);
    if (!usage) return null;
    const { threadId: _threadId, ...counts } = usage;
    return { scope: "whole_session", ...counts };
  }
  if (harness === "claude-code") {
    const usage = parseClaudeCodeUsage(stdout);
    if (!usage) return null;
    const { sessionId: _sessionId, ...counts } = usage;
    return { scope: "whole_session", ...counts };
  }
  return null;
}

/** A harness that could not start work (account limit, missing auth) is not a
 * measured cold-agent failure: the rehearsal must report it as blocked. */
export function classifyUnavailable(text) {
  if (/usage limit|rate limit|credit balance|quota|purchase more credits/i.test(text))
    return "usage-limit";
  if (
    /GEMINI_API_KEY|XAI_API_KEY|invalid api key|not logged in|not signed in|please (run )?\/?login|authenticat|auth method/i.test(
      text,
    )
  )
    return "auth";
  return null;
}

/** Shared bounded transport; only the parser's numeric evidence survives. */
async function startUsageCollector(path, parseBatch, reconcile) {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const events = [];
  let valid = true;
  let receivedBytes = 0;
  let active = 0;
  let closed = false;
  let closing;
  const server = createServer(async (request, response) => {
    if (request.headers["x-asimp-usage-token"] !== secret) {
      response.writeHead(403);
      response.end();
      return;
    }
    active += 1;
    try {
      if (request.method !== "POST" || request.url !== path) throw new Error("route");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        receivedBytes += chunk.length;
        if (bytes > 1024 * 1024 || receivedBytes > 8 * 1024 * 1024) throw new Error("limit");
        chunks.push(chunk);
      }
      const batch = parseBatch(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (batch === null || events.length + batch.length > 10_000) throw new Error("shape");
      events.push(...batch);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    } catch {
      valid = false;
      response.writeHead(400);
      response.end();
      request.destroy();
    } finally {
      active -= 1;
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.on("error", () => {
    valid = false;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}${path}`,
    secret,
    usage(whole, firstPromotionAt) {
      return valid && closed ? reconcile(events, whole, firstPromotionAt) : null;
    },
    async close() {
      closing ??= new Promise((resolve) => {
        if (active !== 0) valid = false;
        server.close(() => {
          closed = true;
          resolve();
        });
        server.closeAllConnections();
      });
      await closing;
    },
  };
}

/** Run-local numeric accounting sink; no received OTLP body is retained. */
export async function startCodexUsageCollector() {
  const receiver = await startUsageCollector(
    "/v1/logs",
    parseCodexUsageBatch,
    codexUsageToFirstPromotion,
  );
  const { endpoint, secret } = receiver;
  return {
    argv: [
      "-c",
      `otel.exporter={otlp-http={endpoint="${endpoint}",protocol="json",headers={"x-asimp-usage-token"="${secret}"}}}`,
      "-c",
      "otel.log_user_prompt=false",
      "-c",
      "otel.log_agent_responses=false",
      "-c",
      "otel.log_guardian_assessments=false",
      "-c",
      "otel.tool_result.max_bytes=0",
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
    ],
    usage(whole, firstPromotionAt) {
      return receiver.usage(whole, firstPromotionAt);
    },
    close() {
      return receiver.close();
    },
  };
}

/** Request intervals only. Content, logs and metrics exporters stay disabled. */
export async function startClaudeUsageCollector() {
  const receiver = await startUsageCollector(
    "/v1/traces",
    parseClaudeUsageBatch,
    claudeUsageToFirstPromotion,
  );
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.endpoint,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: `x-asimp-usage-token=${receiver.secret}`,
      OTEL_TRACES_EXPORT_INTERVAL: "1000",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_TOOL_DETAILS: "0",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_RAW_API_BODIES: "0",
      OTEL_LOG_MANAGED_SETTINGS: "0",
      OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
      OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "false",
      OTEL_METRICS_INCLUDE_REPOSITORY: "false",
      OTEL_METRICS_INCLUDE_SESSION_ID: "true",
    },
    usage(whole, firstPromotionAt) {
      return receiver.usage(whole, firstPromotionAt);
    },
    close() {
      return receiver.close();
    },
  };
}

export async function runHarnessAgent(
  harness,
  joinUrl,
  { timeoutMs = 900_000, spawnProcess = spawn, firstPromotionAt } = {},
) {
  const spec = HARNESSES[harness];
  if (!spec) throw new Error(`unknown harness ${harness}`);
  if (spec.privacyUnavailable) {
    const emptyDigest = createHash("sha256").digest("hex");
    return {
      harness,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      transcriptSha256: emptyDigest,
      transcriptBytes: 0,
      transcriptTruncated: false,
      stderrSha256: emptyDigest,
      stderrBytes: 0,
      stdinWriteFailed: false,
      tokens: null,
      tokenUsage: null,
      unavailable: "privacy-prerequisite",
    };
  }
  const cwd = mkdtempSync(join(tmpdir(), `asimp-gauntlet-${harness}-`));
  const env = {};
  for (const name of ENV_ALLOWLIST)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const started = Date.now();
  const measure =
    (harness === "codex" || harness === "claude-code") && typeof firstPromotionAt === "function";
  const startCollector = harness === "codex" ? startCodexUsageCollector : startClaudeUsageCollector;
  const collector = measure ? await startCollector().catch(() => null) : null;
  if (collector?.env) Object.assign(env, collector.env);
  return await new Promise((resolve) => {
    let stdout = "";
    let stderrTail = "";
    let transcriptBytes = 0;
    let retainedBytes = 0;
    let stderrBytes = 0;
    const transcriptHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const maxTranscriptBytes = 16 * 1024 * 1024;
    let timedOut = false;
    let finished = false;
    let stdinWriteFailed = false;
    let binaryUnavailable = false;
    const argv = spec.argv(sponsorPasteBlock(joinUrl));
    if (collector?.argv) argv.splice(argv.length - 1, 0, ...collector.argv);
    const child = spawnProcess(spec.binary, argv, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      transcriptBytes += chunk.length;
      transcriptHash.update(chunk);
      const retained = chunk.subarray(0, Math.max(0, maxTranscriptBytes - retainedBytes));
      stdout += retained.toString("utf8");
      retainedBytes += retained.length;
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-400);
    });
    // The paste includes the enrollment secret. It is never a process argument
    // or a retained prompt file. Early CLI exits may close the pipe before EOF.
    child.stdin?.on("error", () => {
      stdinWriteFailed = true;
    });
    if (child.stdin) child.stdin.end(sponsorPasteBlock(joinUrl));
    else stdinWriteFailed = true;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    const finish = async (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const digest = transcriptHash.digest("hex");
      const transcriptTruncated = transcriptBytes > retainedBytes;
      const tokens = transcriptTruncated ? null : spec.tokens(stdout);
      const tokenUsage = transcriptTruncated ? null : harnessUsageDetails(harness, stdout);
      const unavailable = binaryUnavailable
        ? "binary-unavailable"
        : exitCode === 0 && !spec.reportsStartFailureOnSuccess
          ? null
          : spec.unavailable(stdout, stderrTail);
      await collector?.close();
      let firstPromotionTokenUsage = null;
      if (collector && !transcriptTruncated) {
        try {
          firstPromotionTokenUsage = collector.usage(
            harness === "codex" ? parseCodexExecUsage(stdout) : parseClaudeCodeUsage(stdout),
            firstPromotionAt(),
          );
        } catch {
          // A missing server boundary cannot turn partial telemetry into a budget.
        }
      }
      stdout = ""; // Rule A11: never retained beyond digest and token total.
      resolve({
        harness,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        transcriptSha256: digest,
        transcriptBytes,
        transcriptTruncated,
        tokens,
        tokenUsage,
        ...(measure ? { firstPromotionTokenUsage } : {}),
        stdinWriteFailed,
        unavailable,
        stderrSha256: stderrHash.digest("hex"),
        stderrBytes,
      });
    };
    child.on("error", (error) => {
      binaryUnavailable = error.code === "ENOENT" || error.code === "EACCES";
      finish(null);
    });
    child.on("close", (code) => finish(code));
  }).finally(async () => {
    await collector?.close();
  });
}
