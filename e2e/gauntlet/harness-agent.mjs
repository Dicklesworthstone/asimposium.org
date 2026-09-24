/**
 * Real harness agents for the local cold-agent rehearsal (bead asimposiumorg-pcsn).
 *
 * Node counterpart of real-spawn.ts (which needs Bun; the local target needs
 * genuine Node for Wrangler's harness). Same discipline:
 * - the child gets an allowlisted environment, never sponsor secrets;
 * - a hard deadline with SIGTERM then SIGKILL;
 * - the transcript is never retained or written (Rule A11). Only its SHA-256,
 *   byte count, and a harness-reported token total (when the CLI's structured
 *   output carries one) leave this module. Stall points come from the local
 *   target's server-side observations, not from agent text.
 *
 * Each harness runs in its own empty scratch directory with tool permissions
 * narrowed as far as each CLI allows for autonomous HTTP work.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    "",
    "Task: make one small, correct, falsifiable contribution to the problem you are bound to,",
    "then close your session with a short handback. Work autonomously; I am not watching.",
  ].join("\n");
}

export const HARNESSES = {
  "claude-code": {
    binary: "claude",
    argv: (prompt) => [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--allowedTools",
      "Bash(curl:*)",
      "Bash(jq:*)",
      "Bash(printf:*)",
      "Bash(echo:*)",
      "Bash(cat:*)",
      "Bash(sleep:*)",
    ],
    tokens: (stdout) => {
      try {
        const usage = JSON.parse(stdout).usage ?? {};
        return (
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
        );
      } catch {
        return null;
      }
    },
  },
  codex: {
    binary: "codex",
    argv: (prompt) => [
      "exec",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--json",
      prompt,
    ],
    tokens: (stdout) => {
      let total = null;
      for (const line of stdout.split("\n")) {
        try {
          const event = JSON.parse(line);
          const usage = event.usage ?? event.msg?.info?.total_token_usage ?? null;
          if (usage && typeof usage.total_tokens === "number") total = usage.total_tokens;
          else if (usage && typeof usage.input_tokens === "number")
            total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        } catch {
          /* not an event line */
        }
      }
      return total;
    },
  },
  gemini: {
    binary: "gemini",
    argv: (prompt) => ["-p", prompt, "--approval-mode", "yolo", "-o", "json"],
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
  },
};

export async function runHarnessAgent(harness, joinUrl, { timeoutMs = 900_000 } = {}) {
  const spec = HARNESSES[harness];
  if (!spec) throw new Error(`unknown harness ${harness}`);
  const cwd = mkdtempSync(join(tmpdir(), `asimp-gauntlet-${harness}-`));
  const env = {};
  for (const name of ENV_ALLOWLIST)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const started = Date.now();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderrTail = "";
    let timedOut = false;
    const child = spawn(spec.binary, spec.argv(sponsorPasteBlock(joinUrl)), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 16 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-400);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    const finish = (exitCode) => {
      clearTimeout(timer);
      const digest = createHash("sha256").update(stdout).digest("hex");
      const bytes = Buffer.byteLength(stdout);
      const tokens = spec.tokens(stdout);
      stdout = ""; // Rule A11: never retained beyond digest and token total.
      resolve({
        harness,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        transcriptSha256: digest,
        transcriptBytes: bytes,
        tokens,
        // A short stderr tail helps diagnose a CLI that failed to start; it is
        // scrubbed of the join fragment before leaving this module.
        stderrTail: stderrTail.replaceAll(joinUrl.slice(joinUrl.indexOf("#")), "#<fragment>"),
      });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}
