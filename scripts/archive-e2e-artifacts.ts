#!/usr/bin/env bun
/**
 * Operator-only race-safe archival entrypoint for `e2e/artifacts/`
 * (bead `asimposiumorg-rc-artifact-archival-e2e-shims-luqx`).
 *
 * Delegates filesystem traversal to `scripts/lib/archive-e2e-artifacts-safe.py`
 * which uses POSIX `dir_fd` + `O_NOFOLLOW` + `fstat` (avoiding Node's lack of
 * race-free `openat` snapshots), atomically acquires `e2e/.artifact-maintenance`,
 * refuses open current-epoch writer leases and symlinks, verifies archive
 * extraction SHA-256 byte-for-byte, and NEVER deletes any source file (Rule 1).
 *
 * Usage:
 *   bun scripts/archive-e2e-artifacts.ts --dry-run [--older-than-days 7]
 *   bun scripts/archive-e2e-artifacts.ts --dest /path/outside/repo/archive.tar.gz --older-than-days 7
 *   bun scripts/archive-e2e-artifacts.ts --self-test
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HELPER_PY = resolve(REPO_ROOT, "scripts/lib/archive-e2e-artifacts-safe.py");

export interface ArchiveCliOptions {
  readonly root: string;
  readonly dest?: string;
  readonly olderThanDays: number;
  readonly dryRun: boolean;
  readonly includeProtected: boolean;
  readonly selfTest: boolean;
}

export function parseArchiveArgs(argv: readonly string[]): ArchiveCliOptions {
  let root = REPO_ROOT;
  let dest: string | undefined;
  let olderThanDays = 7;
  let dryRun = false;
  let includeProtected = false;
  let selfTest = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--include-protected") {
      includeProtected = true;
    } else if (arg === "--self-test") {
      selfTest = true;
    } else if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a directory path");
      root = resolve(value);
    } else if (arg === "--dest") {
      const value = argv[++i];
      if (!value) throw new Error("--dest requires a .tar.gz path outside e2e/artifacts");
      dest = value;
    } else if (arg === "--older-than-days") {
      const value = argv[++i];
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--older-than-days must be a non-negative number");
      }
      olderThanDays = parsed;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { root, dest, olderThanDays, dryRun, includeProtected, selfTest };
}

export function runArtifactArchival(options: ArchiveCliOptions): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  if (options.selfTest) {
    const check = spawnSync("python3", ["-m", "py_compile", HELPER_PY], { encoding: "utf8" });
    if (check.status !== 0) {
      return {
        status: 1,
        stdout: `${JSON.stringify({ facility: "OPS.artifact-archival", status: "fail", code: "ARCHIVAL_HELPER_SYNTAX_INVALID" })}\n`,
        stderr: check.stderr ?? "",
      };
    }
    return {
      status: 0,
      stdout: `${JSON.stringify({ facility: "OPS.artifact-archival", status: "pass", code: "ARCHIVAL_SELF_TEST_OK", deleted_files: 0 })}\n`,
      stderr: "",
    };
  }

  const pyArgs = [
    HELPER_PY,
    "--root",
    options.root,
    "--older-than-days",
    String(options.olderThanDays),
  ];
  if (options.dryRun) pyArgs.push("--dry-run");
  if (options.includeProtected) pyArgs.push("--include-protected");
  if (options.dest) pyArgs.push("--dest", options.dest);

  const proc = spawnSync("python3", pyArgs, { encoding: "utf8" });
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

if (import.meta.main) {
  try {
    const opts = parseArchiveArgs(process.argv.slice(2));
    const result = runArtifactArchival(opts);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${JSON.stringify({ facility: "OPS.artifact-archival", status: "fail", code: "INVALID_ARGUMENTS", detail: message })}\n`,
    );
    process.exit(64);
  }
}
