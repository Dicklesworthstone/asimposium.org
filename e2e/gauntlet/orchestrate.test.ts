import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { HARNESS_ADAPTERS } from "./adapters.ts";
import { assignHarnesses, runGauntlet } from "./orchestrate.ts";

const KEYWORD_SOUP = "pair session pack workshop promote close\nsession_id: S-1";

// Only shell dispatch is doubled here. Actual Workerd journeys run separately;
// these probes cannot claim model execution or server-derived completion.
function localShellProbe(args: string[], childExit = 0) {
  const directory = mkdtempSync(resolve(tmpdir(), "gauntlet-shell-dispatch-"));
  const argumentFile = resolve(directory, "arguments");
  writeFileSync(
    resolve(directory, "node"),
    '#!/bin/bash\nif [[ "$1" == "-e" ]]; then exit 0; fi\nprintf "%s\\n" "$@" > "$GAUNTLET_TEST_ARGUMENTS"\nexit "$GAUNTLET_TEST_EXIT"\n',
    { mode: 0o700 },
  );
  const result = spawnSync("/bin/bash", [resolve(import.meta.dir, "run.sh"), ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    encoding: "utf8",
    env: {
      PATH: `${directory}:/usr/bin:/bin`,
      ASIMPOSIUM_E2E_RUN_ID: "gauntlet-shell-dispatch-unit",
      GAUNTLET_TEST_ARGUMENTS: argumentFile,
      GAUNTLET_TEST_EXIT: String(childExit),
    },
    timeout: 5000,
  });
  return {
    result,
    args: existsSync(argumentFile) ? readFileSync(argumentFile, "utf8").trimEnd().split("\n") : [],
  };
}

describe("canonical local gauntlet command dispatch (unit only)", () => {
  test("the default forwards no selection and retains the reference result", () => {
    const { result, args } = localShellProbe(["--target", "local"]);
    expect(result.status).toBe(0);
    expect(args).toEqual([resolve(import.meta.dir, "local-product-flow.mjs")]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "pass",
      code: "GAUNTLET_LOCAL_REFERENCE_FLOW_PASS",
      reproduce: "bash e2e/gauntlet/run.sh --target local",
    });
  });

  test("selectors are forwarded exactly, including fresh repeated harness attempts", () => {
    for (const selection of ["complete,complete-typed", "harness:codex,harness:codex"]) {
      const { result, args } = localShellProbe(["--agents", selection, "--target", "local"]);
      expect(result.status).toBe(0);
      expect(args).toEqual([
        resolve(import.meta.dir, "local-product-flow.mjs"),
        "--agents",
        selection,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: selection.startsWith("harness:")
          ? "GAUNTLET_LOCAL_MEASUREMENT_COMPLETE"
          : "GAUNTLET_LOCAL_REFERENCE_FLOW_PASS",
        reproduce: `bash e2e/gauntlet/run.sh --target local --agents ${selection}`,
      });
    }
  });

  test("real-harness prerequisites remain blocked78 and real failures keep their exit", () => {
    for (const [childExit, status, code] of [
      [78, "blocked", "GAUNTLET_LOCAL_HARNESS_UNAVAILABLE"],
      [1, "fail", "GAUNTLET_LOCAL_MEASUREMENT_FAILED"],
      [69, "fail", "GAUNTLET_LOCAL_MEASUREMENT_FAILED"],
    ] as const) {
      const { result } = localShellProbe(
        ["--target", "local", "--agents", "harness:codex"],
        childExit,
      );
      expect(result.status).toBe(childExit);
      expect(JSON.parse(status === "fail" ? result.stderr : result.stdout)).toMatchObject({
        status,
        code,
      });
      expect(status === "fail" ? result.stdout : result.stderr).toBe("");
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "GAUNTLET_LOCAL_REFERENCE_FLOW_PASS",
      );
    }
  });

  test("invalid or staging selections never invoke a runner or echo caller secrets", () => {
    for (const args of [
      ["--target", "local", "--agents"],
      ["--target", "local", "--agents", ""],
      ["--target", "local", "--agents", "CANARY#secret"],
      ["--target", "local", "--agents", "complete", "--agents", "complete"],
      ["--agents", "harness:codex"],
      ["--agents", "harness:codex", "--target", "staging"],
    ]) {
      const probe = localShellProbe(args);
      expect(probe.result.status).toBe(64);
      expect(probe.args).toEqual([]);
      expect(probe.result.stdout).toBe("");
      expect(probe.result.stderr).not.toContain("CANARY");
      expect(JSON.parse(probe.result.stderr)).toMatchObject({
        status: "fail",
        code: args.includes("local")
          ? "AGENT_SELECTION_INVALID"
          : "AGENT_SELECTION_REQUIRES_LOCAL_TARGET",
      });
    }
    const invalid = localShellProbe(["--target", "local", "--agents", "unknown-canary"], 64);
    expect(invalid.result.status).toBe(64);
    expect(invalid.result.stdout).toBe("");
    expect(invalid.result.stderr).not.toContain("unknown-canary");
    expect(JSON.parse(invalid.result.stderr)).toMatchObject({ code: "AGENT_SELECTION_INVALID" });
  });

  test("direct Node-runner input errors cannot silently run the default or echo input", () => {
    for (const args of [
      ["--agents"],
      ["--agents", ""],
      ["--agents", "harness:toString"],
      ["--agents", "CANARY#secret"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve(import.meta.dir, "local-product-flow.mjs"), ...args],
        {
          cwd: resolve(import.meta.dir, "../.."),
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status).toBe(64);
      expect(result.stdout).toBe(
        `${JSON.stringify({ status: "fail", code: "GAUNTLET_AGENT_SELECTION_INVALID" })}\n`,
      );
      expect(result.stderr).toBe("");
    }
  });
});

describe("the gauntlet orchestrator", () => {
  test("harnesses rotate across the adapters (diversity is structural)", () => {
    expect(assignHarnesses(6)).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "claude-code",
      "codex",
      "gemini",
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
      const firstLine = lines[0] ?? "";
      expect(JSON.parse(firstLine)).toMatchObject({
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
