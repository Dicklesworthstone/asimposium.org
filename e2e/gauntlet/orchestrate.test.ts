import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { HARNESS_ADAPTERS } from "./adapters.ts";
import { assignHarnesses, runGauntlet } from "./orchestrate.ts";

const KEYWORD_SOUP = "pair session pack workshop promote close\nsession_id: S-1";

describe("the gauntlet orchestrator", () => {
  test("harnesses rotate across the adapters (diversity is structural)", () => {
    expect(assignHarnesses(6)).toEqual([
      "claude-code", "codex", "gemini", "claude-code", "codex", "gemini",
    ]);
    expect(assignHarnesses(3)).toEqual(["claude-code", "codex", "gemini"]);
  });

  test("ten keyword-soup transcripts cannot mint a gauntlet pass", async () => {
    const joinUrls = Array.from(
      { length: 10 },
      (_, i) => `https://a.asimposium.org/join/E${i}#v1.s`,
    );
    const run = await runGauntlet(joinUrls, async () => ({
      transcript: KEYWORD_SOUP,
      tokensUsed: 15000,
    }));
    expect(run.results).toHaveLength(10);
    expect(run.scorecard.completed).toBe(0);
    expect(run.scorecard.harnesses).toHaveLength(3);
    expect(run.scorecard.passed).toBe(false);
  });

  test("a run with stalling attempts fails honestly", async () => {
    const joinUrls = Array.from({ length: 9 }, (_, i) => `u${i}`);
    const run = await runGauntlet(joinUrls, async () => ({
      transcript: "pair session pack then stalled",
    }));
    expect(run.scorecard.completed).toBe(0);
    expect(run.scorecard.passed).toBe(false);
  });

  test("the harness coverage is ≥ 3 by construction at 9 attempts", async () => {
    const joinUrls = Array.from({ length: 9 }, (_, i) => `u${i}`);
    const seen = new Set<string>();
    await runGauntlet(joinUrls, async (adapter) => {
      seen.add(adapter.harness);
      return { transcript: KEYWORD_SOUP, tokensUsed: 10000 };
    });
    expect(seen.size).toBe(HARNESS_ADAPTERS.length);
  });

  test("both executable entries emit one product-flow blocker for a supplied join-file setting", () => {
    const repositoryRoot = resolve(import.meta.dir, "../..");
    const joinFile = resolve(import.meta.dir, "does-not-exist.join-urls");
    const trapDirectory = mkdtempSync(resolve(tmpdir(), "gauntlet-fail-closed-"));
    const invocationMarker = resolve(trapDirectory, "forbidden-invocation");
    for (const binary of ["bun", "claude", "codex", "gemini", "curl"]) {
      writeFileSync(
        resolve(trapDirectory, binary),
        '#!/bin/bash\nprintf "%s\\n" "$0" >> "$GAUNTLET_INVOCATION_MARKER"\nexit 66\n',
        { mode: 0o700 },
      );
    }
    expect(existsSync(joinFile)).toBe(false);
    const environment = {
      ASIMPOSIUM_E2E_RUN_ID: "gauntlet-fail-closed-test",
      GAUNTLET_JOIN_URLS_FILE: joinFile,
      ASIMPOSIUM_STAGING_AGENT_BASE_URL: "https://gauntlet-staging.invalid",
      GAUNTLET_INVOCATION_MARKER: invocationMarker,
      PATH: `${trapDirectory}:/usr/bin:/bin`,
    };
    const direct = spawnSync(process.execPath, [resolve(import.meta.dir, "run-gauntlet.ts")], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      timeout: 5000,
    });
    const shell = spawnSync("/bin/bash", [resolve(import.meta.dir, "run.sh")], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      timeout: 5000,
    });

    for (const entry of [direct, shell]) {
      expect(entry.status).toBe(70);
      const lines = entry.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        status: "blocked",
        code: "GAUNTLET_PRODUCT_FLOW_NOT_IMPLEMENTED",
      });
      expect(entry.stdout).not.toContain("GAUNTLET_PASS");
      expect(entry.stderr).toBe("");
    }
    expect(existsSync(invocationMarker)).toBe(false);

    const directWithoutJoinFile = spawnSync(
      process.execPath,
      [resolve(import.meta.dir, "run-gauntlet.ts")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 5000,
      },
    );
    expect(directWithoutJoinFile.status).toBe(78);
    expect(directWithoutJoinFile.stdout).toBe(
      `${JSON.stringify({ status: "blocked", code: "GAUNTLET_JOIN_URLS_FILE_MISSING" })}\n`,
    );
    expect(directWithoutJoinFile.stderr).toBe("");
  });

  test("fail-closed entries contain no harness or scorecard execution path", () => {
    const directSource = readFileSync(resolve(import.meta.dir, "run-gauntlet.ts"), "utf8");
    const shellSource = readFileSync(resolve(import.meta.dir, "run.sh"), "utf8");

    expect(directSource).not.toMatch(/child_process|Bun\.spawn|\bspawn\s*\(|orchestrate\.ts/);
    expect(shellSource).not.toContain("run-gauntlet.ts");
    expect(shellSource).not.toContain("GAUNTLET_PASS");
  });
});
