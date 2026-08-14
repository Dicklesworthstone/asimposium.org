/**
 * Root-owned G0 spike aggregation for the integration gate.
 *
 * Consumer: `bun run test:integration`, via the root suite dispatcher. It
 * runs the five spike scripts not already owned by the E2E package's S-4
 * screening check. The observed defect class is an unowned G0 spike that can
 * fail or block without contributing to the integration result. S-4 stays out
 * of this manifest: `e2e` invokes it exactly once in its own integration
 * script. Deletion condition: remove this bridge when each G0 spike has a
 * mounted, package-owned integration suite.
 *
 * Child stdout and stderr use inherited descriptors. This preserves the
 * evidence a spike produced; the consolidated diagnostic below contains only
 * fixed labels, outcomes, and a safe reproduction command.
 */

import { existsSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { BLOCKED_EXIT_CODE } from "./policy.ts";
import { redact } from "./report.ts";

export type G0SpikeStatus = "pass" | "fail" | "blocked";

export interface G0Spike {
  readonly id: "s1" | "s2" | "s3" | "s5" | "s6";
  /** Repository-relative Bash source path. Absolute and escaping paths are refused. */
  readonly script: string;
}

export interface G0SpikeResult {
  readonly id: string;
  readonly status: G0SpikeStatus;
  readonly code:
    | "G0_SPIKE_PASSED"
    | "G0_SPIKE_BLOCKED"
    | "G0_SPIKE_FAILED"
    | "G0_SPIKE_UNEXPECTED_EXIT"
    | "G0_SPIKE_SIGNALLED"
    | "G0_SPIKE_TIMEOUT"
    | "G0_SPIKE_SCRIPT_MISSING"
    | "G0_SPIKE_SCRIPT_NOT_EXECUTABLE"
    | "G0_SPIKE_PATH_INVALID";
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface G0RunSummary {
  readonly status: G0SpikeStatus;
  readonly exitCode: 0 | 1 | 78;
  readonly durationMs: number;
  readonly results: readonly G0SpikeResult[];
  readonly totals: Readonly<Record<G0SpikeStatus, number>>;
}

export interface G0RunOptions {
  readonly root: string;
  readonly spikes?: readonly G0Spike[];
  /** Kept bounded so a hung local runner cannot hold the integration gate forever. */
  readonly timeoutMs?: number;
  /** Grace period before a timed-out child is force-killed. */
  readonly terminationGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 500;

/** S-4 is intentionally absent: E2E owns its one existing integration invocation. */
export const G0_SPIKES: readonly G0Spike[] = [
  { id: "s1", script: "scripts/e2e-s1-cold-enrollment.sh" },
  { id: "s2", script: "scripts/e2e-s2-krater.sh" },
  { id: "s3", script: "scripts/e2e-s3-split.sh" },
  { id: "s5", script: "scripts/e2e-s5-diptych.sh" },
  { id: "s6", script: "scripts/e2e-s6-cross-plane-auth.sh" },
];

function validDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new TypeError(`${name} must be a whole number between 1 and 3600000`);
  }
  return value;
}

function scriptPath(root: string, script: string): string | undefined {
  if (script.length === 0) return undefined;
  const absolute = resolve(root, script);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return absolute;
}

function immediateResult(
  id: string,
  code: Extract<
    G0SpikeResult["code"],
    "G0_SPIKE_SCRIPT_MISSING" | "G0_SPIKE_SCRIPT_NOT_EXECUTABLE" | "G0_SPIKE_PATH_INVALID"
  >,
): G0SpikeResult {
  return { id, status: "fail", code, durationMs: 0 };
}

async function runSpike(
  root: string,
  spike: G0Spike,
  timeoutMs: number,
  terminationGraceMs: number,
): Promise<G0SpikeResult> {
  const path = scriptPath(root, spike.script);
  if (path === undefined) return immediateResult(spike.id, "G0_SPIKE_PATH_INVALID");
  if (!existsSync(path)) return immediateResult(spike.id, "G0_SPIKE_SCRIPT_MISSING");

  let runnable = false;
  try {
    runnable = statSync(path).isFile() && (statSync(path).mode & 0o444) !== 0;
  } catch {
    return immediateResult(spike.id, "G0_SPIKE_SCRIPT_MISSING");
  }
  // Product spike scripts are deliberately invoked as `bash scripts/...`; their
  // Git executable bit is not part of the public reproduction contract.
  if (!runnable) return immediateResult(spike.id, "G0_SPIKE_SCRIPT_NOT_EXECUTABLE");

  const startedAt = performance.now();
  const child = Bun.spawn({
    cmd: ["bash", path],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), terminationGraceMs);
  }, timeoutMs);

  const exitCode = await child.exited;
  clearTimeout(timeout);
  if (forceKill !== undefined) clearTimeout(forceKill);
  const durationMs = Math.round(performance.now() - startedAt);
  const signal = child.signalCode ?? undefined;

  if (timedOut) {
    return { id: spike.id, status: "fail", code: "G0_SPIKE_TIMEOUT", durationMs, exitCode, signal };
  }
  if (signal !== undefined) {
    return {
      id: spike.id,
      status: "fail",
      code: "G0_SPIKE_SIGNALLED",
      durationMs,
      exitCode,
      signal,
    };
  }
  if (exitCode === 0) {
    return { id: spike.id, status: "pass", code: "G0_SPIKE_PASSED", durationMs, exitCode };
  }
  if (exitCode === BLOCKED_EXIT_CODE) {
    return { id: spike.id, status: "blocked", code: "G0_SPIKE_BLOCKED", durationMs, exitCode };
  }
  return {
    id: spike.id,
    status: "fail",
    code: exitCode === 1 ? "G0_SPIKE_FAILED" : "G0_SPIKE_UNEXPECTED_EXIT",
    durationMs,
    exitCode,
  };
}

function summarize(results: readonly G0SpikeResult[], durationMs: number): G0RunSummary {
  const totals: Record<G0SpikeStatus, number> = { pass: 0, fail: 0, blocked: 0 };
  for (const result of results) totals[result.status] += 1;

  // A real defect must remain visible even if another spike is honestly blocked.
  const status: G0SpikeStatus = totals.fail > 0 ? "fail" : totals.blocked > 0 ? "blocked" : "pass";
  return {
    status,
    exitCode: status === "pass" ? 0 : status === "blocked" ? BLOCKED_EXIT_CODE : 1,
    durationMs,
    results,
    totals,
  };
}

/** Execute every configured spike sequentially, continuing after failures to retain all evidence. */
export async function runG0Spikes(options: G0RunOptions): Promise<G0RunSummary> {
  const timeoutMs = validDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const terminationGraceMs = validDuration(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    "terminationGraceMs",
  );
  const startedAt = performance.now();
  const results: G0SpikeResult[] = [];
  for (const spike of options.spikes ?? G0_SPIKES) {
    results.push(await runSpike(resolve(options.root), spike, timeoutMs, terminationGraceMs));
  }
  return summarize(results, Math.round(performance.now() - startedAt));
}

/** Serialize only the aggregate; child stdout/stderr remains streamed as the primary evidence. */
export function formatG0Summary(summary: G0RunSummary, root: string): string {
  return JSON.stringify(
    JSON.parse(
      redact(
        JSON.stringify({
          tool: "bun",
          package: "asimposium",
          suite: "g0-spikes-integration",
          version: Bun.version,
          duration_ms: summary.durationMs,
          status: summary.status,
          exit_code: summary.exitCode,
          code:
            summary.status === "pass"
              ? "G0_SPIKES_PASSED"
              : summary.status === "blocked"
                ? "G0_SPIKES_BLOCKED"
                : "G0_SPIKES_FAILED",
          totals: summary.totals,
          spikes: summary.results.map((result) => ({
            id: result.id,
            status: result.status,
            code: result.code,
            duration_ms: result.durationMs,
            ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
            ...(result.signal === undefined ? {} : { signal: result.signal }),
          })),
          s4: "owned by e2e/test:integration and intentionally not duplicated here",
          reproduce: "bun run test:integration",
        }),
        root,
      ),
    ),
  );
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const summary = await runG0Spikes({ root });
  console.log(formatG0Summary(summary, root));
  process.exit(summary.exitCode);
}
