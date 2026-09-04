/**
 * Process-level wiring proof for the provider-neutral gate entrypoint (OPS.2).
 *
 * The test executes the real shell script. Only heavyweight children are PATH
 * shims, so the repository's migration/corpus preflights still run for real.
 * A source-text assertion would accept `echo bun run check`; the command log
 * below proves that the canonical dispatcher was actually invoked.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATES = join(REPO_ROOT, "scripts", "gates.sh");
const SCRATCH = mkdtempSync(join(tmpdir(), "asimposium-gates-test-"));
const BIN = join(SCRATCH, "bin");
const LOG = join(SCRATCH, "commands.tsv");

mkdirSync(BIN, { mode: 0o700 });

function installShim(name: "bun" | "cargo"): void {
  const path = join(BIN, name);
  const body = `#!/usr/bin/env bash
set -e
if [ -n "\${ASIMPOSIUM_GATES_TEST_LOG:-}" ]; then
  printf '${name}' >> "$ASIMPOSIUM_GATES_TEST_LOG"
  for arg in "$@"; do
    printf '\\t%s' "$arg" >> "$ASIMPOSIUM_GATES_TEST_LOG"
  done
  printf '\\n' >> "$ASIMPOSIUM_GATES_TEST_LOG"
fi
if [ '${name}' = 'bun' ] && [ "\${1:-}" = 'run' ] && [ "\${2:-}" = 'check' ]; then
  exit "\${ASIMPOSIUM_GATES_TEST_CHECK_STATUS:-0}"
fi
if [ '${name}' = 'cargo' ]; then
  case "\${ASIMPOSIUM_GATES_TEST_CARGO_MODE:-pass}" in
    rch-refusal)
      printf '[RCH] remote required; refusing local fallback (all workers failed preflight checks) — retryable\\n' >&2
      exit 103
      ;;
    stdout-echo-fail)
      printf '[RCH] remote required; refusing local fallback (all workers failed preflight checks) — retryable\\n'
      printf 'test result: FAILED. 1 failed; 0 passed\\n' >&2
      exit 1
      ;;
    fail)
      printf 'error: test failure in cli crate\\n' >&2
      exit 1
      ;;
    pass|*)
      exit "\${ASIMPOSIUM_GATES_TEST_CARGO_STATUS:-0}"
      ;;
  esac
fi
exit 0
`;
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

installShim("bun");
installShim("cargo");

interface GateRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly commands: readonly string[];
}

const PATH_WITHOUT_CARGO = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((segment) => !segment.includes(".cargo") && !segment.includes(".rch") && segment !== BIN)
  .join(delimiter);

function runGate(
  args: readonly string[],
  options: {
    checkStatus?: number;
    cargoMode?: string;
    cargoStatus?: number;
    customPath?: string;
  } = {},
): GateRun {
  closeSync(openSync(LOG, "w", 0o600));
  const runId = Math.random().toString(36).slice(2);
  const resultPath = join(SCRATCH, `run-${runId}.json`);
  closeSync(openSync(resultPath, "w", 0o600));
  const envVars: Record<string, string> = {
    ...process.env,
    PATH: options.customPath ?? `${BIN}${delimiter}${process.env.PATH ?? ""}`,
    ASIMPOSIUM_GATES_TEST_LOG: LOG,
    ASIMPOSIUM_GATES_TEST_CHECK_STATUS: String(options.checkStatus ?? 0),
    ASIMPOSIUM_GATES_TEST_CARGO_MODE: options.cargoMode ?? "pass",
    ASIMPOSIUM_GATES_TEST_CARGO_STATUS: String(options.cargoStatus ?? 0),
  };
  const helperSource = `
    import { spawnSync } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawnSync("bash", [${JSON.stringify(GATES)}, ...${JSON.stringify(args)}], {
      cwd: ${JSON.stringify(REPO_ROOT)},
      env: ${JSON.stringify(envVars)},
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(
      ${JSON.stringify(resultPath)},
      JSON.stringify({
        status: child.status,
        signal: child.signal,
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
      }) + "\\n",
    );
  `;
  const helper = spawnSync(process.execPath, ["-e", helperSource], {
    encoding: "utf8",
    timeout: 45000,
  });
  if (helper.status !== 0) {
    throw new Error(`helper failed: ${helper.stderr}`);
  }
  const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
  return {
    status: parsed.status,
    signal: parsed.signal,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    commands: readFileSync(LOG, "utf8").trimEnd().split("\n").filter(Boolean),
  };
}

function runAll(checkStatus: number): GateRun {
  return runGate(["--all"], { checkStatus });
}

describe("provider-neutral full gate", () => {
  test("--all invokes the canonical complete dispatcher before the Rust gate", () => {
    const run = runAll(0);

    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.commands).toEqual([
      "bun\tinstall\t--frozen-lockfile",
      "bun\trun\tcheck",
      "cargo\ttest",
    ]);
    expect(run.stdout).toContain("=== gate: migration-pin parity ===");
    expect(run.stdout).toContain("=== gate: problem-corpus parity ===");
    expect(run.stdout).toContain("=== gate: canonical full suite ===");
    expect(run.stdout).toContain("=== all selected gates passed ===");
  }, 60_000);

  test.each([
    ["ordinary failure", 23],
    ["blocked proof", 78],
  ] as const)(
    "PLANTED: canonical %s stays non-green and stops later work",
    (_label, status) => {
      const run = runAll(status);

      expect(run.signal).toBeNull();
      expect(run.status).toBe(status);
      expect(run.commands).toEqual(["bun\tinstall\t--frozen-lockfile", "bun\trun\tcheck"]);
      expect(run.stdout).not.toContain("=== all selected gates passed ===");
    },
    60_000,
  );
});

describe("cargo gate classification", () => {
  test("shim exit 0: cargo gate passes", () => {
    const run = runGate(["--cli"], { cargoMode: "pass", cargoStatus: 0 });

    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.commands).toEqual(["cargo\ttest"]);
    expect(run.stdout).toContain("=== gate: asimp cargo tests ===");
    expect(run.stdout).toContain("=== all selected gates passed ===");
  });

  test("shim exit 1 with failing output: gate fails nonzero (not 78)", () => {
    const run = runGate(["--cli"], { cargoMode: "fail" });

    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("error: test failure in cli crate");
    expect(run.stderr).not.toContain("CARGO_GATE_UNAVAILABLE");
    expect(run.stdout).not.toContain("=== all selected gates passed ===");
  });

  test("shim printing RCH banner + nonzero: gate exits 78 with CARGO_GATE_UNAVAILABLE", () => {
    const run = runGate(["--cli"], { cargoMode: "rch-refusal" });

    expect(run.signal).toBeNull();
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("[RCH] remote required; refusing local fallback");
    expect(run.stderr).toContain("blocked: cargo is unavailable (CARGO_GATE_UNAVAILABLE)");
    expect(run.stdout).not.toContain("=== all selected gates passed ===");
  });

  test("PATH without cargo: gate exits 78 with CARGO_GATE_UNAVAILABLE", () => {
    const run = runGate(["--cli"], { customPath: PATH_WITHOUT_CARGO });

    expect(run.signal).toBeNull();
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("blocked: cargo is unavailable (CARGO_GATE_UNAVAILABLE)");
    expect(run.commands).not.toContain("cargo\ttest");
    expect(run.stdout).not.toContain("=== all selected gates passed ===");
  });

  test("negative: a cargo failure that merely echoes the banner in stdout still classifies as failure (nonzero, not 78)", () => {
    const run = runGate(["--cli"], { cargoMode: "stdout-echo-fail" });

    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("[RCH] remote required; refusing local fallback");
    expect(run.stderr).toContain("test result: FAILED");
    expect(run.stderr).not.toContain("CARGO_GATE_UNAVAILABLE");
    expect(run.stdout).not.toContain("=== all selected gates passed ===");
  });
});
