/**
 * Root-owned G0 spike aggregation for the integration gate.
 *
 * Consumer: `bun run test:integration`, via the root suite dispatcher. It runs
 * the five spike scripts not already owned by the E2E package's S-4 screening
 * check. The observed defect class is an unowned G0 spike that can fail or block
 * without contributing to the integration result. S-4 stays out of this
 * manifest: `e2e` invokes it exactly once in its own integration script.
 * Deletion condition: remove this bridge when each G0 spike has a mounted,
 * package-owned integration suite.
 *
 * ## The stdout contract
 *
 * This module's stdout carries exactly one line: the aggregate JSON diagnostic.
 * Child output does not share it. An earlier revision used inherited
 * descriptors, so any spike that printed a byte to stdout corrupted the record a
 * CI reader parses — the evidence and the verdict were fighting over one
 * channel. Child stdout and stderr are captured, bounded, redacted, and replayed
 * on *this* process's stderr, labelled by spike. Evidence is still preserved and
 * still visible; it just no longer sits inside the machine-readable line.
 *
 * ## Process groups
 *
 * Spikes run `detached`, so each child shell leads its own process group and a
 * negative-PID signal reaches every descendant rather than only the shell. That
 * matters because a spike that leaves a background grandchild running is exactly
 * the leak this aggregation exists to catch.
 *
 * Group signalling is also where the sharp edge is, and it is handled explicitly
 * rather than hopefully — see `signalGroup` and `terminateGroup` below.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

import { BLOCKED_EXIT_CODE } from "./policy.ts";
import { redact } from "./report.ts";

export type G0SpikeStatus = "pass" | "fail" | "blocked";

/** The G0 spike identifiers this repository defines, S-1 through S-6. */
export const ALL_G0_SPIKE_IDS = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;
export type G0SpikeId = (typeof ALL_G0_SPIKE_IDS)[number];

/**
 * S-4 is owned by `e2e`'s own integration script and must not appear here.
 * Running it twice would double a costly staging probe and, worse, let this
 * aggregate report a second, independent verdict on a gate it does not own.
 */
export const S4_OWNED_BY_E2E: G0SpikeId = "s4";

/** Exactly the identifiers this aggregate is responsible for. */
export const REQUIRED_G0_SPIKE_IDS = ALL_G0_SPIKE_IDS.filter(
  (id) => id !== S4_OWNED_BY_E2E,
) as readonly G0SpikeId[];

export interface G0Spike {
  readonly id: G0SpikeId;
  /** Repository-relative Bash source path. Absolute and escaping paths are refused. */
  readonly script: string;
}

export type G0SpikeCode =
  | "G0_SPIKE_PASSED"
  | "G0_SPIKE_BLOCKED"
  | "G0_SPIKE_FAILED"
  | "G0_SPIKE_UNEXPECTED_EXIT"
  | "G0_SPIKE_SIGNALLED"
  | "G0_SPIKE_TIMEOUT"
  | "G0_SPIKE_AGGREGATE_TIMEOUT"
  | "G0_SPIKE_ABORTED"
  | "G0_SPIKE_NOT_RUN"
  | "G0_SPIKE_SCRIPT_MISSING"
  | "G0_SPIKE_SCRIPT_NOT_EXECUTABLE"
  | "G0_SPIKE_SCRIPT_NOT_REGULAR_FILE"
  | "G0_SPIKE_PATH_INVALID"
  | "G0_SPIKE_SPAWN_FAILED"
  | "G0_SPIKE_PROCESS_GROUP_UNSUPPORTED"
  | "G0_SPIKE_PROCESS_GROUP_SIGNAL_FAILED"
  | "G0_SPIKE_PROCESS_GROUP_RECYCLED";

export interface G0SpikeResult {
  readonly id: string;
  readonly status: G0SpikeStatus;
  readonly code: G0SpikeCode;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  /** Set when captured child output exceeded the per-stream byte ceiling. */
  readonly outputTruncated?: boolean;
}

export type G0SummaryCode =
  | "G0_SPIKES_PASSED"
  | "G0_SPIKES_BLOCKED"
  | "G0_SPIKES_FAILED"
  | "G0_SPIKES_NO_RESULTS";

export interface G0RunSummary {
  readonly status: G0SpikeStatus;
  readonly code: G0SummaryCode;
  readonly exitCode: 0 | 1 | 78;
  readonly durationMs: number;
  readonly results: readonly G0SpikeResult[];
  readonly totals: Readonly<Record<G0SpikeStatus, number>>;
}

export interface G0RunOptions {
  readonly root: string;
  /**
   * Explicit spike list. Omit to run the complete manifest, which is checked for
   * exact S1–S6 coverage. An explicit list is still validated structurally.
   */
  readonly spikes?: readonly G0Spike[];
  /** Per-spike ceiling, so one hung script cannot hold the gate forever. */
  readonly timeoutMs?: number;
  /**
   * Ceiling for the whole aggregate. A per-spike timeout alone is not a bound on
   * the run: N spikes each finishing just under their own limit is still N times
   * the limit, and the gate has no finite worst case. This is that bound.
   */
  readonly aggregateTimeoutMs?: number;
  /** Grace period before a terminated child's group is force-killed. */
  readonly terminationGraceMs?: number;
  /** Cancels the currently running spike and prevents later spikes from starting. */
  readonly signal?: AbortSignal;
  /** Sink for replayed child output. Defaults to this process's stderr. */
  readonly diagnosticSink?: (text: string) => void;
  /** Per-stream ceiling on captured child output. */
  readonly maxCapturedBytes?: number;
  /**
   * Interpreter that runs each spike. A bare command name resolved through
   * `PATH`, never a path: allowing a path here would re-open the very hole the
   * execute-bit check closes, by letting a caller nominate any file as the thing
   * that runs. Present so the start-failure path can be exercised honestly.
   */
  readonly interpreter?: string;
  /**
   * How long to keep draining a child's pipes after it exits. Descendants
   * inherit those pipes, so this is a ceiling on how long a background process
   * can hold the runner open, not a wait every spike pays.
   */
  readonly postExitDrainMs?: number;
}

const BARE_COMMAND = /^[A-Za-z0-9_-]+$/;

function validInterpreter(value: string): string {
  if (!BARE_COMMAND.test(value)) {
    throw new TypeError("interpreter must be a bare command name resolved through PATH");
  }
  return value;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_AGGREGATE_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const DEFAULT_MAX_CAPTURED_BYTES = 64 * 1024;
const DEFAULT_POST_EXIT_DRAIN_MS = 250;
const GROUP_POLL_INTERVAL_MS = 25;

/** S-4 is intentionally absent: E2E owns its one existing integration invocation. */
export const G0_SPIKES: readonly G0Spike[] = [
  { id: "s1", script: "scripts/e2e-s1-cold-enrollment.sh" },
  { id: "s2", script: "scripts/e2e-s2-krater.sh" },
  { id: "s3", script: "scripts/e2e-s3-split.sh" },
  { id: "s5", script: "scripts/e2e-s5-diptych.sh" },
  { id: "s6", script: "scripts/e2e-s6-cross-plane-auth.sh" },
];

export type G0ManifestCode =
  | "G0_MANIFEST_EMPTY"
  | "G0_MANIFEST_DUPLICATE_ID"
  | "G0_MANIFEST_UNKNOWN_ID"
  | "G0_MANIFEST_MISSING_ID"
  | "G0_MANIFEST_S4_NOT_OWNED_HERE"
  | "G0_MANIFEST_PATH_INVALID";

export class G0ManifestError extends Error {
  constructor(
    readonly code: G0ManifestCode,
    /** Safe detail: identifiers and relative paths only, never absolute paths. */
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "G0ManifestError";
  }
}

/**
 * Structural checks every manifest must satisfy, however it was supplied.
 *
 * A duplicate identifier is the dangerous one: two entries claiming `s3` produce
 * two results under one id, and `totals` then disagrees with what a reader
 * believes ran. An unknown identifier is refused rather than passed through,
 * because a typo that silently runs nothing is indistinguishable from a green
 * gate.
 */
export function validateSpikeManifest(spikes: readonly G0Spike[]): void {
  if (spikes.length === 0) {
    throw new G0ManifestError("G0_MANIFEST_EMPTY", "a spike manifest must name at least one spike");
  }
  const seen = new Set<string>();
  for (const spike of spikes) {
    if (!(ALL_G0_SPIKE_IDS as readonly string[]).includes(spike.id)) {
      throw new G0ManifestError(
        "G0_MANIFEST_UNKNOWN_ID",
        `${JSON.stringify(spike.id)} is not one of ${ALL_G0_SPIKE_IDS.join(", ")}`,
      );
    }
    if (seen.has(spike.id)) {
      throw new G0ManifestError("G0_MANIFEST_DUPLICATE_ID", `${spike.id} appears more than once`);
    }
    seen.add(spike.id);
    if (typeof spike.script !== "string" || spike.script.length === 0) {
      throw new G0ManifestError("G0_MANIFEST_PATH_INVALID", `${spike.id} declares no script path`);
    }
  }
}

/**
 * The complete-manifest requirement: exactly S1, S2, S3, S5, S6.
 *
 * Checked in both directions on purpose. Missing an identifier means the gate
 * quietly covers less than it claims; including S-4 means this aggregate has
 * started reporting on a gate `e2e` owns, and two owners for one verdict is how
 * a real failure gets reported as somebody else's problem.
 */
export function assertCompleteG0Manifest(spikes: readonly G0Spike[]): void {
  validateSpikeManifest(spikes);
  const ids = new Set(spikes.map((spike) => spike.id));
  if (ids.has(S4_OWNED_BY_E2E)) {
    throw new G0ManifestError(
      "G0_MANIFEST_S4_NOT_OWNED_HERE",
      "s4 is invoked by e2e's own integration script and must not be duplicated here",
    );
  }
  const missing = REQUIRED_G0_SPIKE_IDS.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw new G0ManifestError(
      "G0_MANIFEST_MISSING_ID",
      `absent from the manifest: ${missing.join(", ")}`,
    );
  }
}

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

function immediateResult(id: string, code: G0SpikeCode): G0SpikeResult {
  return { id, status: "fail", code, durationMs: 0 };
}

type GroupSignalOutcome = "signalled" | "gone" | "failed";

/**
 * Signal an entire process group, reporting the three outcomes separately.
 *
 * The negative PID form targets the group, never the runner. `ESRCH` is reported
 * as `gone` rather than as success: a caller that cannot tell "I killed it" from
 * "there was nothing there" cannot make the recycling check below.
 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): GroupSignalOutcome {
  try {
    process.kill(-pid, signal);
    return "signalled";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "failed";
  }
}

function groupIsAlive(pid: number): boolean {
  return signalGroup(pid, 0) === "signalled";
}

async function pollUntilGroupExits(pid: number, graceMs: number): Promise<boolean> {
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline) {
    if (!groupIsAlive(pid)) return true;
    await Bun.sleep(GROUP_POLL_INTERVAL_MS);
  }
  return !groupIsAlive(pid);
}

/**
 * Bounded capture of one child stream.
 *
 * The stream is always fully consumed even after the ceiling is reached: a
 * paused pipe would block the child on write, turning an output-bounding measure
 * into a hang. Only the retained bytes are capped.
 */
function captureStream(
  stream: Readable | null,
  limit: number,
): { readonly done: Promise<void>; text(): string; truncated(): boolean } {
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  if (stream === null) {
    return { done: Promise.resolve(), text: () => "", truncated: () => false };
  }
  const done = new Promise<void>((resolveDone) => {
    stream.on("data", (chunk: Buffer) => {
      const room = limit - retained;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        retained = limit;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      retained += chunk.length;
    });
    // `close` matters as much as `end`: when the child never starts, the pipes
    // are destroyed rather than ended, and a capture that only waits for `end`
    // would wait forever on a process that does not exist.
    stream.once("end", () => resolveDone());
    stream.once("close", () => resolveDone());
    stream.once("error", () => resolveDone());
  });
  return {
    done,
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

/**
 * Replay captured child output on this process's stderr, labelled and redacted.
 *
 * Redaction runs once over the whole retained buffer rather than per chunk: a
 * credential split across a chunk boundary would slip past a streaming redactor,
 * and a redactor with a known bypass is worse than an honest ceiling on volume.
 */
function replayCapture(
  sink: (text: string) => void,
  id: string,
  channel: "stdout" | "stderr",
  capture: { text(): string; truncated(): boolean },
  root: string,
): void {
  const text = capture.text();
  if (text.length === 0) return;
  const suffix = capture.truncated() ? " (truncated at the capture ceiling)" : "";
  sink(`--- g0 spike ${id} ${channel}${suffix} ---\n`);
  sink(redact(text.endsWith("\n") ? text : `${text}\n`, root));
}

interface SpikeRunContext {
  readonly root: string;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly maxCapturedBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly diagnosticSink: (text: string) => void;
  readonly interpreter: string;
  readonly postExitDrainMs: number;
  /** True when the per-spike timeout was clamped by the aggregate deadline. */
  readonly boundedByAggregate: boolean;
}

async function runSpike(spike: G0Spike, context: SpikeRunContext): Promise<G0SpikeResult> {
  const path = scriptPath(context.root, spike.script);
  if (path === undefined) return immediateResult(spike.id, "G0_SPIKE_PATH_INVALID");
  if (context.signal?.aborted) return immediateResult(spike.id, "G0_SPIKE_ABORTED");
  if (process.platform === "win32") {
    return immediateResult(spike.id, "G0_SPIKE_PROCESS_GROUP_UNSUPPORTED");
  }

  /**
   * An execute bit, not a read bit.
   *
   * The previous check tested `mode & 0o444` — whether the file was *readable* —
   * and then handed the path to `bash`. Every readable file in the repository
   * therefore qualified as a spike, which turns a manifest typo into arbitrary
   * script execution and makes the "is this meant to be run?" question
   * unanswerable. The execute bit is the operator's explicit statement that a
   * file is a program; `accessSync(X_OK)` asks the kernel that question for this
   * user, so ownership and ACLs are honoured rather than guessed from mode bits.
   */
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return immediateResult(spike.id, "G0_SPIKE_SCRIPT_MISSING");
  }
  if (!stat.isFile()) return immediateResult(spike.id, "G0_SPIKE_SCRIPT_NOT_REGULAR_FILE");
  try {
    accessSync(path, fsConstants.X_OK);
  } catch {
    return immediateResult(spike.id, "G0_SPIKE_SCRIPT_NOT_EXECUTABLE");
  }

  const startedAt = performance.now();
  let child: ChildProcess;
  try {
    child = spawn(context.interpreter, [path], {
      cwd: context.root,
      detached: true,
      // Never `inherit`: this process's stdout carries the aggregate JSON, and a
      // spike must not be able to write into that record.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return immediateResult(spike.id, "G0_SPIKE_SPAWN_FAILED");
  }

  const stdout = captureStream(child.stdout, context.maxCapturedBytes);
  const stderr = captureStream(child.stderr, context.maxCapturedBytes);

  let reason: "timeout" | "abort" | undefined;
  let terminationRequested = false;
  let signalFailed = false;
  let groupRecycled = false;
  let childExited = false;
  /** Latched once the group is observed empty; a later "alive" means reuse. */
  let sawGroupGone = false;

  /**
   * Terminate the group, then escalate only if it is still there.
   *
   * Two defects lived here. The first was waiting the full grace period even
   * when the group had already gone, which is dead time on every timeout. The
   * second was worse: an unconditional post-exit `SIGKILL` to the group. Once
   * the leader has exited and been reaped, its PID is a candidate for reuse, and
   * a group id that has gone quiet and then reappears is not necessarily the
   * group we started. So the escalation polls for the group to disappear, and
   * refuses to signal if it ever observes the group dead and then alive again —
   * that transition is the recycling signature, and the right response to it is
   * to signal nothing at all and say so.
   */
  let escalation: Promise<void> | undefined;
  const terminateGroup = (why: "timeout" | "abort"): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    reason = why;
    const pid = child.pid;
    if (pid === undefined) return;
    const term = signalGroup(pid, "SIGTERM");
    if (term === "failed") {
      signalFailed = true;
      return;
    }
    if (term === "gone") {
      sawGroupGone = true;
      return; // nothing to escalate against
    }
    escalation = (async () => {
      if (await pollUntilGroupExits(pid, context.terminationGraceMs)) {
        sawGroupGone = true;
        return;
      }
      // Still alive after the grace period. Re-probe immediately before the kill
      // so the window between decision and signal is as small as it can be, and
      // so a group that has *just* gone is never signalled at all.
      if (!groupIsAlive(pid)) {
        sawGroupGone = true;
        return;
      }
      if (sawGroupGone) {
        // Observed empty earlier and answering now. A process group does not
        // come back from the dead, so this id belongs to whatever the kernel
        // handed the number to next. Signalling it would kill an unrelated
        // process tree, so nothing is sent and the result says why.
        groupRecycled = true;
        return;
      }
      const kill = signalGroup(pid, "SIGKILL");
      if (kill === "failed") signalFailed = true;
      else if (kill === "gone") sawGroupGone = true;
    })();
  };

  const timeout = setTimeout(() => {
    void terminateGroup("timeout");
  }, context.timeoutMs);
  const onAbort = () => {
    void terminateGroup("abort");
  };
  context.signal?.addEventListener("abort", onAbort, { once: true });
  if (context.signal?.aborted) onAbort();

  let spawnFailed = false;
  const exited = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      // A failure to start is its own condition. Reporting it as a
      // process-group signalling failure named the wrong subsystem entirely and
      // sent a reader looking for a kill that never happened.
      child.once("error", () => {
        spawnFailed = true;
        // Nothing will ever write to these, and nothing will end them either.
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolveExit({ exitCode: null, signal: null });
      });
      child.once("exit", (exitCode, exitSignal) => {
        childExited = true;
        resolveExit({ exitCode, signal: exitSignal });
      });
    },
  );

  clearTimeout(timeout);
  context.signal?.removeEventListener("abort", onAbort);

  /**
   * Drain the pipes, but on a deadline.
   *
   * A child's descendants inherit its stdout and stderr, so the pipe does not
   * reach `end` when the shell exits — it reaches `end` when the *last* holder
   * closes it. Waiting unconditionally therefore hands a spike that exits 0
   * while leaving a background process behind the power to hang this runner
   * indefinitely: the per-spike timer has already been cleared by then, so
   * nothing would ever stop it.
   *
   * A well-behaved child's pipes close the instant it exits, so this costs
   * nothing in the normal case. A pipe-holding descendant costs exactly this
   * deadline, after which the streams are destroyed and whatever was captured is
   * reported. That is the honest trade: bounded evidence beats an unbounded wait.
   */
  const drained = await Promise.race([
    Promise.all([stdout.done, stderr.done]).then(() => true),
    Bun.sleep(context.postExitDrainMs).then(() => false),
  ]);
  if (!drained) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  replayCapture(context.diagnosticSink, spike.id, "stdout", stdout, context.root);
  replayCapture(context.diagnosticSink, spike.id, "stderr", stderr, context.root);
  const outputTruncated = stdout.truncated() || stderr.truncated();

  if (spawnFailed && !childExited) {
    return {
      id: spike.id,
      status: "fail",
      code: "G0_SPIKE_SPAWN_FAILED",
      durationMs: Math.round(performance.now() - startedAt),
      ...(outputTruncated ? { outputTruncated } : {}),
    };
  }

  /**
   * One escalation, awaited here rather than raced.
   *
   * The shell can exit on TERM long before its descendants do — a spike that
   * traps TERM and leaves a background grandchild is the leak this module runs
   * detached in order to catch — so the escalation deliberately outlives the
   * exit event. It is a single promise owned by `terminateGroup`, not a second
   * copy of the same logic running here, because two code paths both deciding to
   * send SIGKILL to one group is how a signal ends up delivered after the group
   * is gone.
   *
   * A spike that exited cleanly started no escalation at all, so it is signalled
   * nothing: there is nothing to clean up that the script did not choose, and
   * signalling a group whose leader has already been reaped is the recycling
   * hazard taken on for no benefit.
   */
  if (escalation !== undefined) await escalation;

  const durationMs = Math.round(performance.now() - startedAt);
  const exitCode = exited.exitCode ?? undefined;
  const exitSignal = exited.signal ?? undefined;
  const base = {
    id: spike.id,
    durationMs,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(exitSignal === undefined ? {} : { signal: exitSignal }),
    ...(outputTruncated ? { outputTruncated } : {}),
  } as const;

  if (groupRecycled) {
    return { ...base, status: "fail", code: "G0_SPIKE_PROCESS_GROUP_RECYCLED" };
  }
  if (signalFailed) {
    return { ...base, status: "fail", code: "G0_SPIKE_PROCESS_GROUP_SIGNAL_FAILED" };
  }
  if (reason === "timeout") {
    return {
      ...base,
      status: "fail",
      code: context.boundedByAggregate ? "G0_SPIKE_AGGREGATE_TIMEOUT" : "G0_SPIKE_TIMEOUT",
    };
  }
  if (reason === "abort") return { ...base, status: "fail", code: "G0_SPIKE_ABORTED" };
  if (exitSignal !== undefined) return { ...base, status: "fail", code: "G0_SPIKE_SIGNALLED" };
  if (exitCode === 0) return { ...base, status: "pass", code: "G0_SPIKE_PASSED" };
  if (exitCode === BLOCKED_EXIT_CODE)
    return { ...base, status: "blocked", code: "G0_SPIKE_BLOCKED" };
  return {
    ...base,
    status: "fail",
    code: exitCode === 1 ? "G0_SPIKE_FAILED" : "G0_SPIKE_UNEXPECTED_EXIT",
  };
}

/**
 * Reduce spike results to one verdict.
 *
 * An empty result set fails closed. Zero results used to reduce to zero
 * failures, which reduced to `pass` and exit 0 — the gate reporting success for
 * having done nothing. That is the single worst value this function can return,
 * because it is indistinguishable from the real thing and arises from the most
 * ordinary cause imaginable: a manifest that produced no work.
 */
export function summarize(results: readonly G0SpikeResult[], durationMs: number): G0RunSummary {
  const totals: Record<G0SpikeStatus, number> = { pass: 0, fail: 0, blocked: 0 };
  for (const result of results) totals[result.status] += 1;

  if (results.length === 0) {
    return {
      status: "fail",
      code: "G0_SPIKES_NO_RESULTS",
      exitCode: 1,
      durationMs,
      results,
      totals,
    };
  }
  // A real defect must remain visible even if another spike is honestly blocked.
  const status: G0SpikeStatus = totals.fail > 0 ? "fail" : totals.blocked > 0 ? "blocked" : "pass";
  return {
    status,
    code:
      status === "pass"
        ? "G0_SPIKES_PASSED"
        : status === "blocked"
          ? "G0_SPIKES_BLOCKED"
          : "G0_SPIKES_FAILED",
    exitCode: status === "pass" ? 0 : status === "blocked" ? BLOCKED_EXIT_CODE : 1,
    durationMs,
    results,
    totals,
  };
}

/** Execute every configured spike sequentially, continuing after failures to retain all evidence. */
export async function runG0Spikes(options: G0RunOptions): Promise<G0RunSummary> {
  const timeoutMs = validDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const aggregateTimeoutMs = validDuration(
    options.aggregateTimeoutMs ?? DEFAULT_AGGREGATE_TIMEOUT_MS,
    "aggregateTimeoutMs",
  );
  const terminationGraceMs = validDuration(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    "terminationGraceMs",
  );
  const maxCapturedBytes = validDuration(
    options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES,
    "maxCapturedBytes",
  );
  const postExitDrainMs = validDuration(
    options.postExitDrainMs ?? DEFAULT_POST_EXIT_DRAIN_MS,
    "postExitDrainMs",
  );
  const interpreter = validInterpreter(options.interpreter ?? "bash");
  const spikes = options.spikes ?? G0_SPIKES;
  // An explicit list still has to be coherent; the default list additionally has
  // to be complete.
  if (options.spikes === undefined) assertCompleteG0Manifest(spikes);
  else validateSpikeManifest(spikes);

  const root = resolve(options.root);
  const diagnosticSink =
    options.diagnosticSink ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const startedAt = performance.now();
  const aggregateDeadline = startedAt + aggregateTimeoutMs;
  const results: G0SpikeResult[] = [];

  for (const spike of spikes) {
    const remaining = Math.floor(aggregateDeadline - performance.now());
    if (remaining < 1) {
      // The aggregate budget is spent. Remaining spikes are recorded as not run
      // rather than omitted: a shorter results array would understate coverage.
      results.push(immediateResult(spike.id, "G0_SPIKE_NOT_RUN"));
      continue;
    }
    if (options.signal?.aborted) {
      results.push(immediateResult(spike.id, "G0_SPIKE_NOT_RUN"));
      continue;
    }
    const boundedByAggregate = remaining < timeoutMs;
    results.push(
      await runSpike(spike, {
        root,
        timeoutMs: boundedByAggregate ? remaining : timeoutMs,
        terminationGraceMs,
        maxCapturedBytes,
        signal: options.signal,
        diagnosticSink,
        interpreter,
        postExitDrainMs,
        boundedByAggregate,
      }),
    );
  }
  return summarize(results, Math.round(performance.now() - startedAt));
}

/** Serialize only the aggregate; child output is replayed on stderr, never here. */
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
          code: summary.code,
          totals: summary.totals,
          spikes: summary.results.map((result) => ({
            id: result.id,
            status: result.status,
            code: result.code,
            duration_ms: result.durationMs,
            ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
            ...(result.signal === undefined ? {} : { signal: result.signal }),
            ...(result.outputTruncated === undefined
              ? {}
              : { output_truncated: result.outputTruncated }),
          })),
          s4: "owned by e2e/test:integration and intentionally not duplicated here",
          reproduce: "bun run test:integration",
        }),
        root,
      ),
    ),
  );
}

/** The conventional shell encoding for "terminated by signal N". */
export function signalExitCode(signal: "SIGINT" | "SIGTERM"): number {
  return signal === "SIGINT" ? 130 : 143;
}

/** Fail-closed diagnostic for a manifest that never got as far as running. */
export function formatManifestFailure(error: G0ManifestError, root: string): string {
  return JSON.stringify(
    JSON.parse(
      redact(
        JSON.stringify({
          tool: "bun",
          package: "asimposium",
          suite: "g0-spikes-integration",
          version: Bun.version,
          duration_ms: 0,
          status: "fail",
          exit_code: 1,
          code: error.code,
          detail: error.detail,
          reproduce: "bun run test:integration",
        }),
        root,
      ),
    ),
  );
}

export type BridgedSignal = "SIGINT" | "SIGTERM";

export interface G0CliOptions extends Omit<G0RunOptions, "signal"> {
  /** Writes the single aggregate JSON line. Defaults to stdout. */
  readonly log?: (line: string) => void;
  /** Writes human diagnostics. Defaults to stderr. */
  readonly errorLog?: (line: string) => void;
  /**
   * Registers a signal handler. Injected so the bridge can be exercised without
   * a real process signal, and so a test never has to spawn the real manifest to
   * find out whether Ctrl-C leaves spike groups running.
   */
  readonly onSignal?: (signal: BridgedSignal, handler: () => void) => void;
  /** Called instead of `process.exit` on a repeat signal. */
  readonly hardExit?: (code: number) => void;
}

/**
 * The entry point's whole body, returning an exit code rather than taking one.
 *
 * Signals are bridged into the abort path here. Without that bridge, Ctrl-C
 * killed the aggregate and left every detached spike group running — precisely
 * the orphaning this module spawns detached in order to prevent. Aborting
 * instead unwinds through the normal termination path, so the group is
 * signalled, the summary is still printed, and the exit code carries the
 * conventional 128+N encoding.
 *
 * A second signal is honoured immediately: someone pressing Ctrl-C twice is
 * asking to leave now, and refusing them would be its own kind of hang.
 */
export async function runG0Cli(options: G0CliOptions): Promise<number> {
  const root = resolve(options.root);
  const log = options.log ?? ((line: string) => console.log(line));
  const errorLog =
    options.errorLog ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const onSignal =
    options.onSignal ??
    ((signal: BridgedSignal, handler: () => void) => {
      process.on(signal, handler);
    });
  const hardExit =
    options.hardExit ??
    ((code: number) => {
      process.exit(code);
    });

  const controller = new AbortController();
  let interrupted: BridgedSignal | undefined;
  const bridge = (signal: BridgedSignal) => {
    if (interrupted !== undefined) {
      hardExit(signalExitCode(signal));
      return;
    }
    interrupted = signal;
    errorLog(
      JSON.stringify({
        suite: "g0-spikes-integration",
        status: "blocked",
        code: "G0_SPIKES_INTERRUPTED",
        signal,
        detail: "terminating the running spike's process group before exiting",
      }),
    );
    controller.abort();
  };
  onSignal("SIGINT", () => bridge("SIGINT"));
  onSignal("SIGTERM", () => bridge("SIGTERM"));

  try {
    const summary = await runG0Spikes({ ...options, root, signal: controller.signal });
    log(formatG0Summary(summary, root));
    return interrupted === undefined ? summary.exitCode : signalExitCode(interrupted);
  } catch (error) {
    if (!(error instanceof G0ManifestError)) throw error;
    log(formatManifestFailure(error, root));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await runG0Cli({ root: resolve(import.meta.dir, "../..") }));
}
