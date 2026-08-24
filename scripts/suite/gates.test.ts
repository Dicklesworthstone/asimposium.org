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
set -eu
printf '${name}' >> "$ASIMPOSIUM_GATES_TEST_LOG"
printf '\\t%s' "$@" >> "$ASIMPOSIUM_GATES_TEST_LOG"
printf '\\n' >> "$ASIMPOSIUM_GATES_TEST_LOG"
if [[ '${name}' == 'bun' && "\${1:-}" == 'run' && "\${2:-}" == 'typecheck' ]]; then
  exit "\${ASIMPOSIUM_GATES_TEST_CHECK_STATUS:-0}"
fi
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

function runAll(checkStatus: number): GateRun {
  closeSync(openSync(LOG, "w", 0o600));
  const child = spawnSync("bash", [GATES, "--all"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${BIN}${delimiter}${process.env.PATH ?? ""}`,
      ASIMPOSIUM_GATES_TEST_LOG: LOG,
      ASIMPOSIUM_GATES_TEST_CHECK_STATUS: String(checkStatus),
    },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (child.error) {
    console.log("child.error:", child.error);
  }
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    commands: readFileSync(LOG, "utf8").trimEnd().split("\n").filter(Boolean),
  };
}

describe("provider-neutral full gate", () => {
  test("--all invokes the canonical complete dispatcher before the Rust gate", () => {
    const run = runAll(0);

    console.log("commands:", run.commands);
    console.log("stdout:", run.stdout);
    console.log("stderr:", run.stderr);
    console.log("status:", run.status);
    expect(run.stderr).toBe("");
    expect(run.commands).toEqual([
      "bun\tinstall\t--frozen-lockfile",
      "bun\trun\ttypecheck",
      "bun\trun\tlint",
      "bun\trun\t--filter\t@asimposium/contracts\ttest",
      "bun\trun\t--filter\t@asimposium/protocol\ttest",
      "bun\trun\t--filter\t@asimposium/render\ttest",
      "bun\trun\t--filter\t@asimposium/web\ttest",
      "bun\trun\t--filter\t@asimposium/wire\ttest:unit",
      "cargo\ttest",
    ]);
    expect(run.stdout).toContain("=== gate: migration-pin parity ===");
    expect(run.stdout).toContain("=== gate: problem-corpus parity ===");
    expect(run.stdout).toContain("=== all selected gates passed ===");
  });

  test.each([
    ["ordinary failure", 23],
    ["blocked proof", 78],
  ] as const)("PLANTED: canonical %s stays non-green and stops later work", (_label, status) => {
    const run = runAll(status);

    expect(run.signal).toBeNull();
    expect(run.status).toBe(status);
    expect(run.commands).toEqual([
      "bun\tinstall\t--frozen-lockfile",
      "bun\trun\ttypecheck",
    ]);
    expect(run.stdout).not.toContain("=== all selected gates passed ===");
  });
});
