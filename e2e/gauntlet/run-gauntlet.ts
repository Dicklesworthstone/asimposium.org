/**
 * The gauntlet runner entry (invoked by run.sh). Reads the join URLs (one per
 * line) from the file named by GAUNTLET_JOIN_URLS_FILE, runs the orchestrator
 * with the real subprocess spawner, and prints the scorecard as one JSON line.
 *
 * The join URLs come from the sponsor's mint + the computer-use session's
 * approvals (INSTRUCTIONS_FOR_COMPUTER_USE.md §6.3) — this runner never mints
 * or approves; it only drives the harnesses.
 */

import { spawn } from "node:child_process";

import type { HarnessAdapter } from "./adapters.ts";
import type { HarnessSpawner } from "./attempt.ts";
import { runGauntlet } from "./orchestrate.ts";

/** The real subprocess spawner: run the harness CLI, capture the transcript. */
const realSpawner: HarnessSpawner = (adapter: HarnessAdapter, prompt: string) => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    readonly transcript: string;
    readonly tokensUsed?: number;
  }>();
  const child = spawn(adapter.binary, [...adapter.argv(prompt)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let transcript = "";
  child.stdout.on("data", (chunk) => {
    transcript += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    transcript += String(chunk);
  });
  child.on("error", reject);
  child.on("close", () => {
    resolve({ transcript });
  });
  return promise;
};

async function main(): Promise<void> {
  const urlsFile = process.env.GAUNTLET_JOIN_URLS_FILE;
  if (urlsFile === undefined || urlsFile === "") {
    process.stdout.write(
      `${JSON.stringify({ status: "blocked", code: "GAUNTLET_JOIN_URLS_FILE_MISSING" })}\n`,
    );
    process.exit(78);
  }
  const { readFileSync } = await import("node:fs");
  const joinUrls = readFileSync(urlsFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const run = await runGauntlet(joinUrls, realSpawner);
  process.stdout.write(
    `${JSON.stringify({
      status: run.scorecard.passed ? "pass" : "fail",
      code: run.scorecard.passed ? "GAUNTLET_PASS" : "GAUNTLET_FAIL",
      total: run.scorecard.total,
      completed: run.scorecard.completed,
      harnesses: run.scorecard.harnesses,
      median_tokens: run.scorecard.medianTokens,
    })}\n`,
  );
  process.exit(run.scorecard.passed ? 0 : 1);
}

await main();
