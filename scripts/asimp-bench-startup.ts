#!/usr/bin/env bun
/**
 * W11.5 CLI warm-startup performance benchmark gate (`asimposiumorg-85s` / W10.7 contract).
 *
 * Benchmarks a compiled `--release` `asimp` binary from process spawn through clap
 * parse and machine-readable `--version` and `--help` completion, with filesystem
 * cache warmed and network/keychain isolated (`env -i`).
 *
 * Fails closed on:
 * - missing or non-executable binary
 * - debug/unoptimized binary (unless explicitly verified release)
 * - non-zero child exit code
 * - p95 >= budget_ms (default 100ms)
 *
 * Usage:
 *   bun scripts/asimp-bench-startup.ts --binary cli/target/release/asimp \
 *     [--samples 50] [--warmup 5] [--budget-ms 100] [--out receipt.json]
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface StartupBenchStats {
  readonly command: readonly string[];
  readonly warmup: number;
  readonly samples: number;
  readonly min_ms: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly max_ms: number;
  readonly mean_ms: number;
  readonly budget_ms: number;
  readonly pass: boolean;
}

export interface StartupBenchReceipt {
  readonly schema: "asimposium.cli-startup-benchmark.v1";
  readonly measured_at: string;
  readonly binary_path: string;
  readonly binary_sha256: string;
  readonly binary_bytes: number;
  readonly binary_version_output: string;
  readonly release_build_checked: boolean;
  readonly budget_ms: number;
  readonly host: {
    readonly os: string;
    readonly kernel_release: string;
    readonly arch: string;
    readonly cpu_model: string;
    readonly cpu_count: number;
    readonly rust_toolchain: string;
  };
  readonly benchmarks: {
    readonly version: StartupBenchStats;
    readonly help: StartupBenchStats;
  };
  readonly overall_pass: boolean;
  readonly scope_disclaimer: string;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[idx] ?? 0).toFixed(3));
}

export function verifyReleaseBinaryCandidate(binaryPath: string): {
  readonly absPath: string;
  readonly bytes: number;
  readonly sha256: string;
} {
  const absPath = resolve(binaryPath);
  const st = statSync(absPath);
  if (!st.isFile()) {
    throw new Error(`BENCH_BINARY_NOT_REGULAR_FILE: ${absPath}`);
  }
  accessSync(absPath, constants.X_OK);

  const normalized = absPath.replaceAll("\\", "/");
  if (normalized.includes("/target/debug/") || normalized.endsWith("/debug/asimp")) {
    throw new Error(
      `BENCH_NON_RELEASE_BINARY_REFUSED: ${absPath} appears to be a debug build; compile with 'cargo build --release --locked --manifest-path cli/Cargo.toml'`,
    );
  }

  const raw = readFileSync(absPath);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  return { absPath, bytes: st.size, sha256 };
}

function runSingleInvocation(
  binaryPath: string,
  args: readonly string[],
  isolatedHome: string,
): { readonly elapsedMs: number; readonly stdout: string } {
  const t0 = Bun.nanoseconds();
  const proc = Bun.spawnSync([binaryPath, ...args], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: isolatedHome,
      LC_ALL: "C",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const elapsedMs = (Bun.nanoseconds() - t0) / 1e6;
  if (proc.exitCode !== 0) {
    const errText = new TextDecoder().decode(proc.stderr).slice(0, 200);
    throw new Error(
      `BENCH_CHILD_NONZERO_EXIT: ${binaryPath} ${args.join(" ")} exited ${proc.exitCode}: ${errText}`,
    );
  }
  return {
    elapsedMs,
    stdout: new TextDecoder().decode(proc.stdout),
  };
}

function measureCommand(
  binaryPath: string,
  args: readonly string[],
  warmup: number,
  samples: number,
  budgetMs: number,
  isolatedHome: string,
): { readonly stats: StartupBenchStats; readonly sampleOutput: string } {
  let sampleOutput = "";
  for (let i = 0; i < warmup; i++) {
    const res = runSingleInvocation(binaryPath, args, isolatedHome);
    if (i === 0) sampleOutput = res.stdout.trim();
  }
  const timings: number[] = [];
  for (let i = 0; i < samples; i++) {
    const res = runSingleInvocation(binaryPath, args, isolatedHome);
    timings.push(res.elapsedMs);
  }
  timings.sort((a, b) => a - b);
  const sum = timings.reduce((acc, v) => acc + v, 0);
  const p95 = percentile(timings, 95);
  return {
    sampleOutput,
    stats: {
      command: ["asimp", ...args],
      warmup,
      samples,
      min_ms: Number((timings[0] ?? 0).toFixed(3)),
      p50_ms: percentile(timings, 50),
      p95_ms: p95,
      p99_ms: percentile(timings, 99),
      max_ms: Number((timings[timings.length - 1] ?? 0).toFixed(3)),
      mean_ms: Number((sum / Math.max(1, timings.length)).toFixed(3)),
      budget_ms: budgetMs,
      pass: p95 < budgetMs,
    },
  };
}

function readToolchainVersion(): string {
  try {
    const proc = Bun.spawnSync(["rustc", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode === 0) {
      return new TextDecoder().decode(proc.stdout).trim();
    }
  } catch {
    // Fall back to cli/rust-toolchain.toml if rustc is not in PATH.
  }
  try {
    return readFileSync(resolve(import.meta.dir, "../cli/rust-toolchain.toml"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("channel"))
      .join(" ");
  } catch {
    return "unknown";
  }
}

export function runStartupBenchmark(opts: {
  readonly binary: string;
  readonly samples?: number;
  readonly warmup?: number;
  readonly budgetMs?: number;
}): StartupBenchReceipt {
  const samples = opts.samples ?? 50;
  const warmup = opts.warmup ?? 5;
  const budgetMs = opts.budgetMs ?? 100;
  if (!Number.isInteger(samples) || samples < 5) {
    throw new Error("BENCH_INVALID_SAMPLES: --samples must be an integer >= 5");
  }
  if (!Number.isInteger(warmup) || warmup < 1) {
    throw new Error("BENCH_INVALID_WARMUP: --warmup must be an integer >= 1");
  }

  const bin = verifyReleaseBinaryCandidate(opts.binary);
  const isolatedHome = mkdtempSync(join(tmpdir(), "asimp-bench-home-"));
  try {
    const versionRun = measureCommand(
      bin.absPath,
      ["--version"],
      warmup,
      samples,
      budgetMs,
      isolatedHome,
    );
    const helpRun = measureCommand(
      bin.absPath,
      ["--help"],
      warmup,
      samples,
      budgetMs,
      isolatedHome,
    );
    const cpuList = cpus();
    const overallPass = versionRun.stats.pass && helpRun.stats.pass;

    return {
      schema: "asimposium.cli-startup-benchmark.v1",
      measured_at: new Date().toISOString(),
      binary_path: bin.absPath,
      binary_sha256: bin.sha256,
      binary_bytes: bin.bytes,
      binary_version_output: versionRun.sampleOutput,
      release_build_checked: true,
      budget_ms: budgetMs,
      host: {
        os: platform(),
        kernel_release: release(),
        arch: arch(),
        cpu_model: cpuList[0]?.model ?? "unknown",
        cpu_count: cpuList.length,
        rust_toolchain: readToolchainVersion(),
      },
      benchmarks: {
        version: versionRun.stats,
        help: helpRun.stats,
      },
      overall_pass: overallPass,
      scope_disclaimer:
        "Measured warm filesystem-cache startup on this specific host only (network and keychain excluded). Does not generalize to unmeasured macOS or ARM hardware; CI release runners record per-platform receipts separately.",
    };
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let binary = "";
  let samples = 50;
  let warmup = 5;
  let budgetMs = 100;
  let outPath = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--binary") binary = argv[++i] ?? "";
    else if (arg === "--samples") samples = Number(argv[++i] ?? "50");
    else if (arg === "--warmup") warmup = Number(argv[++i] ?? "5");
    else if (arg === "--budget-ms") budgetMs = Number(argv[++i] ?? "100");
    else if (arg === "--out") outPath = argv[++i] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/asimp-bench-startup.ts --binary PATH [--samples 50] [--warmup 5] [--budget-ms 100] [--out receipt.json]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (!binary) {
    console.error("ERROR: --binary is required.");
    process.exit(2);
  }

  try {
    const receipt = runStartupBenchmark({ binary, samples, warmup, budgetMs });
    const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
    if (outPath) {
      writeFileSync(outPath, rendered, "utf8");
    }
    process.stdout.write(rendered);
    process.exit(receipt.overall_pass ? 0 : 1);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(2);
  }
}
