import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GATES_SCRIPT = resolve(REPO_ROOT, "scripts/gates.sh");

describe("scripts/gates.sh --cli RCH root & --locked contract (asimposiumorg-rc-cli-pop-encrypted-store-gates-sn5p)", () => {
  test("POSITIVE: invokes cargo fmt, clippy --locked, and test --locked with --manifest-path cli/Cargo.toml from repo root", () => {
    const scratch = mkdtempSync(join(tmpdir(), "asimp-gates-cli-"));
    const logFile = join(scratch, "invocations.log");
    const fakeCargo = join(scratch, "cargo");
    writeFileSync(
      fakeCargo,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'CWD=%s ARGS=%s\\n' "$(pwd)" "$*" >> "${logFile}"
exit 0
`,
    );
    chmodSync(fakeCargo, 0o700);

    const run = spawnSync("bash", [GATES_SCRIPT, "--cli"], {
      cwd: resolve(REPO_ROOT, "cli"), // start inside cli/ to prove gates.sh cd's back to repo root
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH ?? ""}`,
      },
    });
    expect(run.status, `stderr=${run.stderr}\nstdout=${run.stdout}`).toBe(0);

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toEqual([
      `CWD=${REPO_ROOT} ARGS=fmt --manifest-path cli/Cargo.toml --check`,
      `CWD=${REPO_ROOT} ARGS=clippy --locked --manifest-path cli/Cargo.toml --all-targets -- -D warnings`,
      `CWD=${REPO_ROOT} ARGS=test --locked --manifest-path cli/Cargo.toml`,
    ]);
  });

  test("preserves exit 78 (CARGO_GATE_UNAVAILABLE) when RCH refuses local fallback", () => {
    const scratch = mkdtempSync(join(tmpdir(), "asimp-gates-rch-block-"));
    const fakeCargo = join(scratch, "cargo");
    writeFileSync(
      fakeCargo,
      `#!/usr/bin/env bash
echo "[RCH] workers unhealthy; refusing local fallback" >&2
exit 1
`,
    );
    chmodSync(fakeCargo, 0o700);

    const run = spawnSync("bash", [GATES_SCRIPT, "--cli"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH ?? ""}`,
      },
    });
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("CARGO_GATE_UNAVAILABLE");
  });

  test("preserves exit 78 (CARGO_GATE_UNAVAILABLE) when cargo binary is absent", () => {
    const scratch = mkdtempSync(join(tmpdir(), "asimp-gates-nocargo-"));
    // Provide only git/bash/coreutils via minimal symlinked dir without cargo.
    const run = spawnSync("/bin/bash", [GATES_SCRIPT, "--cli"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: scratch,
        PATH: "/usr/bin:/bin",
      },
    });
    // Only assert 78 if /usr/bin:/bin genuinely has no cargo.
    const hasSystemCargo =
      spawnSync("/bin/bash", ["-c", "PATH=/usr/bin:/bin command -v cargo"]).status === 0;
    if (!hasSystemCargo) {
      expect(run.status).toBe(78);
      expect(run.stderr).toContain("CARGO_GATE_UNAVAILABLE");
    }
  });
});
