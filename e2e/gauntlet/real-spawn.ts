/**
 * The real subprocess layer for the Cold-Agent Gauntlet harness (W10.1,
 * Fable §16.1). The pure components (adapters.ts, attempt.ts, orchestrate.ts,
 * scorecard.ts) define the adapters, the injected spawn seam, and the
 * scorecard; this module is the one place that actually executes a harness
 * CLI and it exists to keep that execution boring, bounded, and A11-clean.
 *
 * Boundary discipline (bead asimposiumorg-zai, Rule A11):
 * - The transcript exists only in memory, only up to the cap, only for the
 *   caller's transient stage scan. Nothing here writes it anywhere. Output
 *   past the cap is drained and counted, never retained; the drain keeps the
 *   child's stdout pipe from filling, so a chatty agent cannot deadlock.
 * - redactForRetention() derives the ONLY record callers may persist:
 *   structured fields, timings, and a transcript digest + byte counts. If a
 *   retained record contains transcript text, that is a defect in the caller,
 *   and the A11 test in real-spawn.test.ts is the tripwire.
 * - The child environment is an allowlist. Sponsor-private environment bytes
 *   (tokens, keys, credentials) must not leak into a fresh agent process.
 *
 * Execution is asynchronous with a hard deadline (SIGTERM, then SIGKILL
 * escalation); attempts already run sequentially (orchestrate.ts) because
 * parallel cold agents would race the sponsor approval card.
 */

import { createHash } from "node:crypto";

import { type HarnessAdapter, registrationPrompt } from "./adapters.ts";

/** Defaults chosen to match the repo's other bounded-read disciplines. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL escalation at the deadline. */
export const KILL_ESCALATION_GRACE_MS = 5_000;

/**
 * The only environment bytes a fresh agent receives unless the caller
 * explicitly extends the allowlist. Everything else on the operator machine
 * (tokens, keys, provider credentials) stays out of the child.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SHELL",
];

export interface RealSpawnOptions {
  /** Hard deadline for the harness CLI. Default: 10 minutes. */
  readonly timeoutMs?: number;
  /** Transcript retention cap; output past the cap is drained and counted, never kept. Default: 8 MiB. */
  readonly maxTranscriptBytes?: number;
  /** Fresh per-attempt working directory; composed by the caller, not created here. */
  readonly cwd?: string;
  /** Explicit, auditable additions to the environment allowlist. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface RealAttemptDiagnostic {
  /** null when the binary could not be executed or was killed at the deadline. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** true when stdout exceeded the cap; excess was drained and counted, never retained. */
  readonly truncated: boolean;
  readonly binaryFound: boolean;
  readonly durationMs: number;
  /** Bounded stderr tail for diagnostics; never persisted by this module. */
  readonly stderrTail: string;
}

export interface RealAttemptOutcome {
  /**
   * Bounded stdout of the harness run, in memory only. Callers must not
   * persist this; use redactForRetention() for anything that leaves memory.
   */
  readonly transcript: string;
  /** sha256 over exactly the capped, retained transcript bytes. */
  readonly transcriptSha256: string;
  /** Retained transcript bytes (<= the cap). */
  readonly transcriptBytes: number;
  /** Bytes produced past the cap, drained and counted, never retained. */
  readonly discardedBytes: number;
  readonly diagnostic: RealAttemptDiagnostic;
}

const STDERR_TAIL_BYTES = 2000;

function buildChildEnv(extraEnv?: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extraEnv !== undefined) {
    for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  }
  return env;
}

interface StreamDrain {
  readonly captured: Buffer;
  readonly discardedBytes: number;
}

/** Read a stream to EOF, keeping at most `cap` bytes and counting the rest. */
async function drainWithCap(
  stream: ReadableStream<Uint8Array> | undefined,
  cap: number,
): Promise<StreamDrain> {
  if (stream === undefined) return { captured: Buffer.alloc(0), discardedBytes: 0 };
  const chunks: Buffer[] = [];
  let kept = 0;
  let discardedBytes = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    const buffer = Buffer.from(value);
    if (kept < cap) {
      const room = cap - kept;
      const take = buffer.length <= room ? buffer : buffer.subarray(0, room);
      chunks.push(take);
      kept += take.length;
      discardedBytes += buffer.length - take.length;
    } else {
      discardedBytes += buffer.length;
    }
  }
  return { captured: Buffer.concat(chunks, kept), discardedBytes };
}

/** Keep only the tail `cap` bytes of a stream. */
async function tailOf(
  stream: ReadableStream<Uint8Array> | undefined,
  cap: number,
): Promise<Buffer> {
  if (stream === undefined) return Buffer.alloc(0);
  const reader = stream.getReader();
  let tail: Buffer = Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    const buffer = Buffer.from(value);
    tail =
      tail.length + buffer.length <= cap
        ? Buffer.concat([tail, buffer])
        : Buffer.concat([tail.subarray(tail.length + buffer.length - cap), buffer]);
  }
  return tail;
}

/**
 * Execute one harness attempt for real. Never throws for ordinary failure
 * modes (missing binary, nonzero exit, timeout, oversize output): those are
 * diagnostics on the outcome, because a failed cold agent is a scored result,
 * not a harness crash. Only truly unexpected internal errors reject.
 */
export async function runRealAttempt(
  adapter: HarnessAdapter,
  joinUrl: string,
  options: RealSpawnOptions = {},
): Promise<RealAttemptOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const maxTranscriptBytes = options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  const prompt = registrationPrompt(joinUrl);
  const startedAt = Date.now();

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: [adapter.binary, ...adapter.argv(prompt)],
      cwd: options.cwd,
      env: buildChildEnv(options.extraEnv),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    return {
      transcript: "",
      transcriptSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      transcriptBytes: 0,
      discardedBytes: 0,
      diagnostic: {
        exitCode: null,
        timedOut: false,
        truncated: false,
        binaryFound: false,
        durationMs: Date.now() - startedAt,
        stderrTail: "",
      },
    };
  }

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, KILL_ESCALATION_GRACE_MS).unref?.();
  }, timeoutMs);
  deadline.unref?.();

  const [drained, stderrTail, exitCode] = await Promise.all([
    drainWithCap(proc.stdout as ReadableStream<Uint8Array>, maxTranscriptBytes),
    tailOf(proc.stderr as ReadableStream<Uint8Array>, STDERR_TAIL_BYTES),
    proc.exited,
  ]);
  clearTimeout(deadline);

  const { captured, discardedBytes } = drained;
  const durationMs = Date.now() - startedAt;

  return {
    transcript: captured.toString("utf8"),
    transcriptSha256: createHash("sha256").update(captured).digest("hex"),
    transcriptBytes: captured.byteLength,
    discardedBytes,
    diagnostic: {
      exitCode,
      timedOut,
      truncated: discardedBytes > 0,
      binaryFound: true,
      durationMs,
      stderrTail: stderrTail.toString("utf8"),
    },
  };
}

/** The ONLY shape callers may persist for a real attempt (Rule A11). */
export interface RetainedAttemptRecord {
  readonly harness: string;
  readonly stageReached: string;
  readonly tokensEstimate: number;
  readonly transcriptSha256: string;
  readonly transcriptBytes: number;
  readonly discardedBytes: number;
  readonly diagnostic: RealAttemptDiagnostic;
}

/**
 * Reduce an outcome to its retained record: structured fields and digests,
 * never transcript text. The test suite greps this record for transcript
 * prose as the tripwire: if retention ever starts carrying raw output, it
 * fails.
 */
export function redactForRetention(
  harness: string,
  outcome: RealAttemptOutcome,
  stageReached: string,
  tokensEstimate: number,
): RetainedAttemptRecord {
  return {
    harness,
    stageReached,
    tokensEstimate,
    transcriptSha256: outcome.transcriptSha256,
    transcriptBytes: outcome.transcriptBytes,
    discardedBytes: outcome.discardedBytes,
    diagnostic: outcome.diagnostic,
  };
}
