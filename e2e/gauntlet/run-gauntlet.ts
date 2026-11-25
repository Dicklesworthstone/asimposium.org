/**
 * Direct staging Cold-Agent Gauntlet CLI entry (Fable §16.1, bead fd5e).
 *
 * Refuses production origins fail-closed before any request or subprocess,
 * requires a provisioned `GAUNTLET_JOIN_URLS_FILE`, routes every attempt
 * through a local recording proxy with injected-422 recovery verification,
 * and scores strictly from server-derived state + anonymous public faces.
 */

import { readFileSync } from "node:fs";
import {
  parseJoinUrlsFile,
  runStagingCohort,
  type StagingJoinEntry,
  validateStagingAgentOrigin,
} from "./staging-product-flow.mjs";

const allowLoopback = process.env.GAUNTLET_ALLOW_LOOPBACK === "1";
const originCheck = validateStagingAgentOrigin(process.env.ASIMPOSIUM_STAGING_AGENT_BASE_URL, {
  allowLoopback,
});
if (!originCheck.ok) {
  process.stdout.write(
    `${JSON.stringify({
      status: originCheck.exitCode === 78 ? "blocked" : "fail",
      code: originCheck.code,
    })}\n`,
  );
  process.exitCode = originCheck.exitCode;
} else {
  const urlsFile = process.env.GAUNTLET_JOIN_URLS_FILE;
  if (urlsFile === undefined || urlsFile.trim() === "") {
    process.stdout.write(
      `${JSON.stringify({ status: "blocked", code: "GAUNTLET_JOIN_URLS_FILE_MISSING" })}\n`,
    );
    process.exitCode = 78;
  } else {
    let rawContent: string | undefined;
    try {
      rawContent = readFileSync(urlsFile, "utf8");
    } catch {
      process.stdout.write(
        `${JSON.stringify({ status: "blocked", code: "GAUNTLET_JOIN_URLS_UNREADABLE" })}\n`,
      );
      process.exitCode = 78;
    }
    if (rawContent !== undefined) {
      let entries: StagingJoinEntry[] | undefined;
      try {
        entries = parseJoinUrlsFile(rawContent, {
          problemId: process.env.GAUNTLET_PROBLEM_ID,
          sponsorId: process.env.GAUNTLET_SPONSOR_ID,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "GAUNTLET_JOIN_URL_INVALID";
        const code = message.startsWith("STAGING_ORIGIN_PRODUCTION_FORBIDDEN")
          ? "STAGING_ORIGIN_PRODUCTION_FORBIDDEN"
          : message.startsWith("GAUNTLET_JOIN_URLS_EMPTY")
            ? "GAUNTLET_JOIN_URLS_EMPTY"
            : "GAUNTLET_JOIN_URL_INVALID";
        process.stdout.write(`${JSON.stringify({ status: "fail", code })}\n`);
        process.exitCode = 64;
      }
      if (entries !== undefined) {
        const outcome = await runStagingCohort({
          targetOrigin: originCheck.origin,
          entries,
          allowLoopback,
          emit: (record) => {
            process.stdout.write(`${JSON.stringify(record)}\n`);
          },
        });
        process.exitCode = outcome.exitCode;
      }
    }
  }
}
