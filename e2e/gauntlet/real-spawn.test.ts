/**
 * Behavioral tests for the real spawn layer: every bounded-execution and
 * Rule A11 discipline above is proven with fake harness CLIs installed on
 * PATH (the repo's established shim pattern), including the planted
 * negative that a retained record can never carry transcript prose.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARNESS_ADAPTERS, type HarnessAdapter } from "./adapters.ts";
import { runGauntletAttempt } from "./attempt.ts";
import { type RealAttemptOutcome, redactForRetention, runRealAttempt } from "./real-spawn.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "asimposium-real-spawn-"));
const BIN = join(SCRATCH, "bin");
const WORK = join(SCRATCH, "work");
mkdirSync(BIN, { recursive: true });
mkdirSync(WORK, { recursive: true });

function installFakeCli(name: string, body: string): void {
  const path = join(BIN, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function shimmedPath(): string {
  return `${BIN}${process.env.PATH ? ":" : ""}${process.env.PATH ?? ""}`;
}
const ADAPTER: HarnessAdapter = HARNESS_ADAPTERS[0] as HarnessAdapter;
const JOIN_URL = "https://a.asimposium.org/join/ASIMP-EN-x#v1.s";

function attempt(adapter: HarnessAdapter = ADAPTER, options = {}): Promise<RealAttemptOutcome> {
  return runRealAttempt(adapter, JOIN_URL, {
    cwd: WORK,
    extraEnv: { PATH: shimmedPath() },
    ...options,
  });
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("runRealAttempt", () => {
  test("captures a successful run's bounded transcript with a stable digest", async () => {
    installFakeCli(
      "claude",
      `printf 'paired and said hello; workshop note drafted; promote next; close handback\\n'`,
    );
    const outcome = await attempt();
    expect(outcome.diagnostic.exitCode).toBe(0);
    expect(outcome.diagnostic.binaryFound).toBe(true);
    expect(outcome.diagnostic.timedOut).toBe(false);
    expect(outcome.diagnostic.truncated).toBe(false);
    expect(outcome.discardedBytes).toBe(0);
    expect(outcome.transcript).toContain("hello");
    expect(outcome.transcriptBytes).toBeGreaterThan(0);
    expect(outcome.transcriptSha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await attempt();
    expect(again.transcriptSha256).toBe(outcome.transcriptSha256);
  });

  test("the child environment is allowlisted: sponsor-private bytes never reach the agent", async () => {
    installFakeCli(
      "codex",
      `printf 'secret=%s home=%s\\n' "\${ASIMPOSIUM_TEST_SECRET:-absent}" "\${HOME:-absent}"`,
    );
    const outcome = await attempt(HARNESS_ADAPTERS[1] as HarnessAdapter);
    expect(outcome.transcript).toContain("secret=absent");
    expect(outcome.transcript).toContain(`home=${process.env.HOME ?? "absent"}`);
  });
  test("a hung harness is killed at the deadline and reported as timed out", async () => {
    installFakeCli("gemini", `exec sleep 5`);
    const started = Date.now();
    const outcome = await attempt(HARNESS_ADAPTERS[2] as HarnessAdapter, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(outcome.diagnostic.timedOut).toBe(true);
    expect([null, 143]).toContain(outcome.diagnostic.exitCode);
  });

  test("a missing binary is a scored diagnostic, not a harness crash", async () => {
    const phantom: HarnessAdapter = { ...ADAPTER, binary: "asimp phantom cli xyz" };
    const outcome = await runRealAttempt(phantom, JOIN_URL, { cwd: WORK });
    expect(outcome.diagnostic.binaryFound).toBe(false);
    expect(outcome.diagnostic.exitCode).toBeNull();
    expect(outcome.transcript).toBe("");
  });

  test("oversize stdout is capped in memory, drained and counted, never retained", async () => {
    installFakeCli("claude", `head -c 100000 /dev/zero | tr '\\0' 'x'`);
    const outcome = await attempt(ADAPTER, { maxTranscriptBytes: 1024 });
    expect(outcome.diagnostic.truncated).toBe(true);
    expect(outcome.transcriptBytes).toBe(1024);
    expect(outcome.discardedBytes).toBe(100000 - 1024);
    expect(Buffer.byteLength(outcome.transcript, "utf8")).toBeLessThanOrEqual(1024);
    expect(outcome.transcriptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a nonzero exit carries its code and a bounded stderr tail", async () => {
    installFakeCli(
      "claude",
      `printf 'partial output\\n'; printf 'boom: quota exhausted\\n' >&2; exit 3`,
    );
    const outcome = await attempt();
    expect(outcome.diagnostic.exitCode).toBe(3);
    expect(outcome.diagnostic.stderrTail).toContain("quota exhausted");
    expect(outcome.diagnostic.stderrTail.length).toBeLessThanOrEqual(2000);
  });
});

describe("the Rule A11 retention boundary", () => {
  test("redactForRetention emits structured fields and digests, never transcript prose", async () => {
    installFakeCli(
      "claude",
      `printf 'RETENTION_CANARY_PHRASE agent paired, hello ok, promote done\\n'`,
    );
    const outcome = await attempt();
    const record = redactForRetention(ADAPTER.harness, outcome, "promote", 1200);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("RETENTION_CANARY_PHRASE");
    expect(serialized).not.toContain("agent paired");
    expect(record.transcriptSha256).toBe(outcome.transcriptSha256);
    expect(record.transcriptBytes).toBe(outcome.transcriptBytes);
    expect(record.stageReached).toBe("promote");
    expect(record.tokensEstimate).toBe(1200);
  });
});

describe("conformance with the pure attempt layer", () => {
  test("a real attempt feeds runGauntletAttempt and stays honestly incomplete", async () => {
    installFakeCli("claude", `printf 'pair session pack workshop promote close\\n'`);
    const spawner = async (adapter: HarnessAdapter) => {
      const outcome = await attempt(adapter);
      return { transcript: outcome.transcript };
    };
    const result = await runGauntletAttempt(0, ADAPTER, JOIN_URL, spawner);
    expect(result.completed).toBe(false);
    expect(result.stageReached).toBe("close");
    expect(result.harness).toBe(ADAPTER.harness);
  });
});
