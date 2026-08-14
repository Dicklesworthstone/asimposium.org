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
 * channel. Child stdout and stderr are captured, bounded, and redacted before
 * replay on *this* process's stderr, labelled by spike; they are never replayed
 * verbatim. Evidence is still preserved and visible without sitting inside the
 * machine-readable line.
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

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
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
  /** The script finished but processes it started were still running. */
  | "G0_SPIKE_DESCENDANT_LEAKED"
  /** Descendants survived a bounded TERM and KILL of the owned group. */
  | "G0_SPIKE_DESCENDANT_UNKILLABLE"
  /**
   * Something still held the spike's output stream after the script finished
   * and the owned group was reaped — a process that left the group (a
   * daemonising `setsid`) and so cannot be seen by a group scan, but is
   * provably still alive because it is still holding the descriptor.
   */
  | "G0_SPIKE_OUTPUT_HOLDER_LEAKED"
  /**
   * The script succeeded, but this platform cannot enforce descendant
   * containment, so "it left nothing running" was never actually verified.
   * Blocked, not passed: an unverifiable safety property is not a satisfied one.
   */
  | "G0_SPIKE_CONTAINMENT_UNAVAILABLE"
  /** The process table could not be read, so no claim about leaks is possible. */
  | "G0_SPIKE_DESCENDANT_SCAN_FAILED";

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
  /**
   * Command used to read the process table. A bare name resolved through `PATH`,
   * for the same reason `interpreter` is: present so the scan-failure path can
   * be exercised honestly rather than assumed unreachable.
   */
  readonly psCommand?: string;
  /**
   * Downgrade containment to unavailable. **Downgrade only** — the type admits
   * no other value, and the runtime rejects one anyway.
   *
   * Capability is something this module proves by running the primitive, never
   * something a caller announces. If an argument could assert `pid-namespace`,
   * any caller could mint a production-green receipt on a platform that contains
   * nothing, which defeats the entire boundary. Forcing `none` is always safe
   * because it can only make a run *less* green.
   */
  readonly containment?: { readonly kind: "none"; readonly reason: string };
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

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * A pinned descriptor is acceptable only when it still names the exact file
 * preflight approved. Staying somewhere below the checkout is insufficient: a
 * concurrent rename could otherwise replace one allowed spike with another.
 */
export function pinnedScriptPathIsExpected(
  canonicalRoot: string,
  expectedCanonicalPath: string,
  pinnedCanonicalPath: string,
): boolean {
  return (
    isPathWithin(canonicalRoot, expectedCanonicalPath) &&
    isPathWithin(canonicalRoot, pinnedCanonicalPath) &&
    pinnedCanonicalPath === expectedCanonicalPath
  );
}

function immediateResult(id: string, code: G0SpikeCode): G0SpikeResult {
  return { id, status: "fail", code, durationMs: 0 };
}

/** A capability blocker is recorded per requested spike, without starting one. */
function containmentUnavailableResult(id: string): G0SpikeResult {
  return { id, status: "blocked", code: "G0_SPIKE_CONTAINMENT_UNAVAILABLE", durationMs: 0 };
}

/**
 * The supervisor: PID 1 inside the private namespace, held open until this
 * runner says otherwise.
 *
 * Running the spike script directly as the group leader was the mistake. When
 * the script exited, the leader exited with it, and every question worth asking
 * afterwards — are there descendants left? may I still signal this group id? —
 * became unanswerable, because the group either had no leader or had been
 * recycled out from under us. The observable consequence was a spike that exited
 * 0 while leaving a live background process behind, reported as `pass`.
 *
 * So the script runs one level down. The supervisor waits for it, publishes its
 * real exit status on fd 3, and then *blocks*. `unshare --fork` is the host
 * process-group leader; it waits for this supervisor, so the group id remains
 * pinned until the runner closes fd 3 or tears the namespace down.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 *   - There is deliberately **no `trap`**. `trap '' TERM` looks like the obvious
 *     way to protect the supervisor, but an ignored disposition is inherited
 *     across fork and exec, so it would silently make every descendant immune to
 *     the SIGTERM this module relies on. The cleanup signal intentionally reaches
 *     the supervisor as well as its descendants, so it must keep the default
 *     disposition.
 *   - The hold uses the `read` builtin rather than `cat`. `cat` would fork a
 *     process into the very group being audited, and the supervisor would be
 *     reported as its own leak.
 *
 * The control line also carries the two facts this runner can no longer observe
 * directly, now that the script is a grandchild rather than a child:
 *
 *   - **Start failure.** `command -v` decides it before anything is launched, so
 *     "the interpreter does not exist" stays distinguishable from "the script
 *     ran and chose to exit 127". Inferring it from the status would conflate
 *     the two.
 *   - **Signal.** `wait` reports a signalled child as 128+N, and this reports
 *     the decoded name alongside the raw status. The shell cannot distinguish
 *     that from a script that literally called `exit 143`, and neither can this
 *     module: that ambiguity is inherent to POSIX `wait` and is the price of the
 *     group ownership the supervisor buys.
 */
const SUPERVISOR_PROGRAM = `set -u
if ! command -v "$1" >/dev/null 2>&1; then
  printf 'G0SUP spawn_failed=1 status=127 signal=\\n' >&3
  read -r _ <&3 2>/dev/null || true
  exit 127
fi
"$1" "$2" 3>&- &
target=$!
wait "$target"
status=$?
signal=
if [ "$status" -gt 128 ] && [ "$status" -lt 193 ]; then
  signal=$(kill -l $((status - 128)) 2>/dev/null || printf '')
fi
namespace_scan=not-applicable
namespace_survivors=none
if [ "$3" = "pid-namespace" ]; then
  # The probe proved this topology before any spike is allowed to start; retain
  # the same invariant in the live supervisor so an unexpected launch shape is
  # a fail-closed record rather than an unobserved run.
  [ "$$" -eq 1 ] || exit 125
  namespace_scan=unknown
  namespace_survivors=$(
    count=0
    saw_init=0
    for process_dir in /proc/[0-9]*; do
      [ -d "$process_dir" ] || continue
      process_pid=\${process_dir##*/}
      process_state=
      while IFS=$'\\t' read -r key value; do
        [ "$key" = "State:" ] && process_state=\${value%% *}
      done < "$process_dir/status" || exit 1
      [ -n "$process_state" ] || exit 1
      if [ "$process_pid" = 1 ]; then
        saw_init=1
        continue
      fi
      case "$process_state" in Z*) continue ;; esac
      count=$((count + 1))
    done
    [ "$saw_init" = 1 ] || exit 1
    printf '%s' "$count"
  ) || namespace_survivors=
  if [ -n "$namespace_survivors" ]; then namespace_scan=ok; fi
fi
printf 'G0SUP status=%s signal=%s namespace_scan=%s namespace_survivors=%s\\n' \\
  "$status" "$signal" "$namespace_scan" "$namespace_survivors" >&3
read -r _ <&3 2>/dev/null || true
exit "$status"`;

/**
 * How many processes other than the leader are still in the group.
 *
 * `unknown` is a first-class answer. An earlier revision swallowed a `ps`
 * failure and returned an empty list, which is the most dangerous possible
 * response: "I could not look" rendered as "there is nothing there", turning a
 * broken scan into a clean bill of health. A caller that cannot see the process
 * table has no evidence, and no evidence must never read as no leak.
 *
 * Zombies are excluded. A reap-pending entry is an accounting artefact of the
 * supervisor being blocked, not a process still doing anything.
 */
type SurvivorScan =
  | { readonly kind: "ok"; readonly survivors: number }
  | { readonly kind: "unknown" };

type GroupScanMode = "owned" | "after-signal";

/** Milliseconds still available to the one aggregate deadline, never negative. */
function remainingBefore(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

function scanGroup(
  pgid: number,
  hasForkedNamespaceSupervisor: boolean,
  psCommand: string,
  absoluteDeadline: number,
  mode: GroupScanMode = "owned",
): SurvivorScan {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return { kind: "unknown" };
  const remaining = remainingBefore(absoluteDeadline);
  if (remaining < 1) return { kind: "unknown" };
  let listing: string;
  try {
    listing = execFileSync(psCommand, ["-A", "-o", "pid=,ppid=,pgid=,state="], {
      encoding: "utf8",
      timeout: Math.min(5_000, remaining),
      // A stalled ps must not outlive the aggregate deadline. TERM is not a
      // reliable timeout signal for a helper that inherits a hostile handler.
      killSignal: "SIGKILL",
    });
  } catch {
    return { kind: "unknown" };
  }

  /**
   * A scan is only evidence if the listing is recognisably a process table.
   *
   * `psCommand: "true"` exits 0 and prints nothing; a truncated or reformatted
   * listing parses to nothing useful. Both previously produced "zero survivors",
   * which is the same failure as swallowing the exception: an absent answer
   * rendered as a clean one. Two conditions now have to hold before any count is
   * believed — every row parses, the live group leader is present, and, on the
   * Linux `unshare --fork` path, the real namespace supervisor is present as
   * that leader's direct child. The runner's own row is not evidence about a
   * detached child group, so it is deliberately not a sentinel here. A partial
   * table that omits the owned group must never read as proof that it is empty.
   *
   * After a group signal, the earlier owned scan is the proof that made the
   * negative PGID safe. At that point the leader may correctly be gone, so a
   * follow-up only measures remaining members; it cannot create a clean result
   * because it is reached only after a leak was already observed.
   */
  let sawLeader = false;
  let sawForkedSupervisor = !hasForkedNamespaceSupervisor;
  let liveNonLeaders = 0;
  for (const raw of listing.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/.exec(line);
    // Every non-empty row must parse. Skipping the ones that do not would let a
    // listing that is half garbage still produce a confident count, and the
    // garbage half is exactly where a missed survivor would hide.
    if (match === null) return { kind: "unknown" };
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const rowGroup = Number(match[3]);
    const zombie = match[4]?.startsWith("Z") === true;
    if (rowGroup !== pgid) continue;
    if (pid === pgid) {
      if (!zombie) sawLeader = true;
      continue;
    }
    if (zombie) continue;
    liveNonLeaders += 1;
    if (hasForkedNamespaceSupervisor && parentPid === pgid) sawForkedSupervisor = true;
  }
  if (mode === "owned" && (!sawLeader || !sawForkedSupervisor)) {
    return { kind: "unknown" };
  }
  return {
    kind: "ok",
    survivors:
      mode === "owned" ? liveNonLeaders - (hasForkedNamespaceSupervisor ? 1 : 0) : liveNonLeaders,
  };
}

/**
 * Whether this platform can actually guarantee that a spike's descendants stay
 * observable.
 *
 * Process groups are a cooperative boundary, not a containment one. A child that
 * calls `setsid()` leaves the group, and one that also closes its inherited
 * descriptors leaves no trace in the pipe either — it is invisible to both
 * checks this module can make, and would be reported as a clean pass while
 * still running. No amount of polling fixes that: the process is gone from
 * every namespace the runner can see.
 *
 * Real containment needs a kernel boundary the escapee cannot cross. A PID
 * namespace is that boundary: the supervisor becomes PID 1 inside it, `setsid`
 * stays within it, and nothing survives its teardown. Where that exists, the
 * guarantee is real. Where it does not, the guarantee is *absent*, and the only
 * honest report is a structured blocker — never a pass.
 */
export type ContainmentCapability =
  | { readonly kind: "pid-namespace" }
  | { readonly kind: "none"; readonly reason: string };

/**
 * The exact shell-launch prefix the containment boundary is built from.
 *
 * Probe and launch share this constant rather than each spelling it out. They
 * drifted once — the probe verified `--mount-proc` while the launch omitted it —
 * which meant the capability that was proved and the command that actually ran
 * were different commands. The shared prefix reaches the same `bash -c` process
 * topology that hosts the supervisor; a `true` probe would prove only that
 * `unshare` accepted flags, not that the supervised launch is contained.
 */
const PID_NAMESPACE_LAUNCH_ARGV = [
  "unshare",
  "--pid",
  "--fork",
  "--mount-proc",
  "--kill-child=SIGKILL",
  "bash",
  "-c",
] as const;

/** Build the one exact namespace-shell topology used by both probe and run. */
function pidNamespaceShellArgv(program: string, name: string, ...args: string[]): string[] {
  return [...PID_NAMESPACE_LAUNCH_ARGV, program, name, ...args];
}

/**
 * A minimal real supervisor topology, not a feature probe.
 *
 * `$$ == 1` proves `--fork` placed this Bash process in the new PID namespace.
 * The command-line check proves `--mount-proc` mounted that namespace's procfs:
 * an inherited host `/proc/1` would name the host init instead of this probe.
 * The background child and its `/proc/<pid>/status` parent check are the same
 * PID-1-forks-a-target relationship the real supervisor relies on.
 */
const CONTAINMENT_PROBE_PROGRAM = `set -eu
[ "$$" -eq 1 ]
[ -r /proc/1/status ]
probe_state=
while IFS=$'\\t' read -r key value; do
  [ "$key" = "State:" ] && probe_state=\${value%% *}
done < /proc/1/status
[ -n "$probe_state" ]
probe_cmdline=
IFS= read -r -d '' probe_cmdline < /proc/1/cmdline || true
case "$probe_cmdline" in *g0-containment-probe*) ;; *) exit 1 ;; esac
sleep 5 &
probe_target=$!
probe_parent=
while IFS=$'\\t' read -r key value; do
  [ "$key" = "PPid:" ] && probe_parent=\${value%% *}
done < "/proc/$probe_target/status"
[ "$probe_parent" = 1 ]
kill -TERM "$probe_target"
wait "$probe_target" || true`;

let containmentCache: ContainmentCapability | undefined;

/**
 * Detect containment by running the real primitive, never by being told.
 *
 * This is deliberately not parameterised. A caller-supplied capability is a
 * caller-supplied verdict: anything that let an argument assert
 * `pid-namespace` would let a test — or a careless integration — mint a green
 * receipt on a platform that cannot contain anything, which is precisely the
 * failure this boundary exists to prevent. The only thing a caller may do is
 * *downgrade* to `none`, which can never manufacture a pass.
 */
export function probeContainment(force = false): ContainmentCapability {
  if (containmentCache !== undefined && !force) return containmentCache;
  if (process.platform !== "linux") {
    containmentCache = {
      kind: "none",
      reason: `${process.platform} exposes no unprivileged PID-namespace primitive; descendant containment cannot be enforced`,
    };
    return containmentCache;
  }
  try {
    const probeArgv = pidNamespaceShellArgv(CONTAINMENT_PROBE_PROGRAM, "g0-containment-probe");
    execFileSync(probeArgv[0] as string, probeArgv.slice(1), {
      stdio: "ignore",
      timeout: 5_000,
      // `unshare --fork` intentionally ignores TERM while waiting. KILL plus
      // --kill-child makes a wedged probe fail closed instead of pinning startup.
      killSignal: "SIGKILL",
    });
    containmentCache = { kind: "pid-namespace" };
  } catch {
    containmentCache = {
      kind: "none",
      reason: `${PID_NAMESPACE_LAUNCH_ARGV.join(" ")} cannot launch a mounted PID-1 supervisor for this user`,
    };
  }
  return containmentCache;
}

/**
 * Signal the whole owned group, never an individual pid.
 *
 * Enumerating descendant pids and signalling them one by one looks safer than a
 * group signal and is in fact strictly more dangerous: between the `ps` snapshot
 * and the `kill`, any of those pids can exit and be reissued by the kernel to an
 * unrelated process, and the signal lands on a stranger. There is no way to
 * close that window from user space.
 *
 * A group signal has no such window *provided the group id is owned*, and that
 * is exactly the invariant the live supervisor exists to supply: while it is
 * running, the pgid cannot be reissued, so `kill(-pgid)` can only reach
 * processes this runner started. The supervisor receives the signal too and
 * dies with its descendants, which is deliberate and harmless — its exit status
 * has already been read off fd 3 by the time cleanup begins, so nothing is lost.
 */
function signalOwnedGroup(pgid: number, signal: NodeJS.Signals): "signalled" | "gone" | "failed" {
  // `-pgid` has a meaning far broader than an individual PID. Refuse an absent,
  // zero, negative, or non-integer value rather than letting numeric coercion
  // turn a bookkeeping fault into a signal for an unrelated group.
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return "failed";
  try {
    process.kill(-pgid, signal);
    return "signalled";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "failed";
  }
}

export interface DescendantReaping {
  /** True when the spike left processes running after its script finished. */
  readonly leaked: boolean;
  /** True when the process table could not be read; the result is not trustworthy. */
  readonly unknown: boolean;
  /** True when the group still had members after a bounded TERM then KILL. */
  readonly unkillable: boolean;
  readonly signalFailed: boolean;
}

/**
 * Bounded TERM-then-KILL over whatever the spike left behind.
 *
 * Both signals are addressed to the group while the supervisor still owns it.
 * The escalation stops the moment the group reports empty, so a spike that
 * cleans up promptly pays a poll interval rather than the whole grace period.
 */
async function reapDescendants(
  pgid: number,
  hasForkedNamespaceSupervisor: boolean,
  graceMs: number,
  psCommand: string,
  absoluteDeadline: number,
): Promise<DescendantReaping> {
  const initial = scanGroup(pgid, hasForkedNamespaceSupervisor, psCommand, absoluteDeadline);
  if (initial.kind === "unknown") {
    return { leaked: false, unknown: true, unkillable: false, signalFailed: false };
  }
  if (initial.survivors === 0) {
    return { leaked: false, unknown: false, unkillable: false, signalFailed: false };
  }

  let signalFailed = false;
  const escalate = async (signal: NodeJS.Signals): Promise<SurvivorScan> => {
    if (signalOwnedGroup(pgid, signal) === "failed") signalFailed = true;
    const deadline = Math.min(absoluteDeadline, performance.now() + graceMs);
    let scan = scanGroup(pgid, false, psCommand, absoluteDeadline, "after-signal");
    while (scan.kind === "ok" && scan.survivors > 0 && performance.now() < deadline) {
      const remaining = remainingBefore(deadline);
      if (remaining < 1) break;
      await Bun.sleep(Math.min(GROUP_POLL_INTERVAL_MS, remaining));
      scan = scanGroup(pgid, false, psCommand, absoluteDeadline, "after-signal");
    }
    return scan;
  };

  let scan = await escalate("SIGTERM");
  if (scan.kind === "ok" && scan.survivors > 0) scan = await escalate("SIGKILL");
  return {
    leaked: true,
    unknown: scan.kind === "unknown",
    unkillable: scan.kind === "ok" && scan.survivors > 0,
    signalFailed,
  };
}

/**
 * Bounded capture of one child stream.
 *
 * The stream is always fully consumed even after the ceiling is reached: a
 * paused pipe would block the child on write, turning an output-bounding measure
 * into a hang. Only the retained bytes are capped.
 */
export interface CapturedStream {
  readonly done: Promise<void>;
  text(): string;
  truncated(): boolean;
}

export function captureStream(stream: Readable | null, limit: number): CapturedStream {
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
 * Wait only until the caller's already-established deadline for every captured
 * pipe to close. This is deliberately separate so the planted test holds a
 * real pipe open rather than merely asserting a result code.
 */
export async function drainCapturedStreams(
  captures: readonly CapturedStream[],
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs < 1) return false;
  return Promise.race([
    Promise.all(captures.map((capture) => capture.done)).then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

export function outputDrainFailureCode(drained: boolean): G0SpikeCode | undefined {
  return drained ? undefined : "G0_SPIKE_OUTPUT_HOLDER_LEAKED";
}

export function outputTruncationReasons(
  capture: Pick<CapturedStream, "truncated">,
  drainExpired: boolean,
): readonly string[] {
  const reasons: string[] = [];
  if (capture.truncated()) reasons.push("capture ceiling");
  if (drainExpired) reasons.push("post-exit drain expired; later output was discarded");
  return reasons;
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
  capture: CapturedStream,
  root: string,
  drainExpired: boolean,
): void {
  const text = capture.text();
  // The header is emitted even for an empty capture when the drain expired: the
  // fact that output may have been lost is itself the diagnostic, and staying
  // silent about it would let a partial log pass for a complete one.
  if (text.length === 0 && !drainExpired) return;
  const reasons = outputTruncationReasons(capture, drainExpired);
  const suffix = reasons.length > 0 ? ` (truncated: ${reasons.join("; ")})` : "";
  sink(`--- g0 spike ${id} ${channel}${suffix} ---\n`);
  if (text.length > 0) sink(redact(text.endsWith("\n") ? text : `${text}\n`, root));
}

interface SpikeRunContext {
  readonly root: string;
  /** One absolute budget for script execution, cleanup scans, grace, and drain. */
  readonly absoluteDeadline: number;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly maxCapturedBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly diagnosticSink: (text: string) => void;
  readonly interpreter: string;
  readonly postExitDrainMs: number;
  readonly psCommand: string;
  readonly containment: ContainmentCapability;
  /** True when the per-spike timeout was clamped by the aggregate deadline. */
  readonly boundedByAggregate: boolean;
}

type SpikePreflight =
  | {
      readonly kind: "ready";
      readonly path: string;
      readonly canonicalRoot: string;
      readonly canonicalPath: string;
    }
  | { readonly kind: "refused"; readonly result: G0SpikeResult };

/**
 * Check every condition that can be decided without starting a process.
 *
 * Keeping this separate from `runSpike` is what lets an unavailable
 * containment platform preserve useful path and execute-bit diagnostics without
 * ever handing a fixture to an interpreter. The containment blocker is last:
 * a malformed, missing, non-regular, or non-executable entry is an operator
 * error regardless of host capability and must not be hidden by it.
 */
function preflightSpike(
  spike: G0Spike,
  context: Pick<SpikeRunContext, "root" | "signal" | "containment">,
): SpikePreflight {
  const path = scriptPath(context.root, spike.script);
  if (path === undefined) {
    return { kind: "refused", result: immediateResult(spike.id, "G0_SPIKE_PATH_INVALID") };
  }
  if (context.signal?.aborted) {
    return { kind: "refused", result: immediateResult(spike.id, "G0_SPIKE_ABORTED") };
  }
  if (process.platform === "win32") {
    return {
      kind: "refused",
      result: immediateResult(spike.id, "G0_SPIKE_PROCESS_GROUP_UNSUPPORTED"),
    };
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
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: "refused", result: immediateResult(spike.id, "G0_SPIKE_SCRIPT_MISSING") };
  }
  if (stat.isSymbolicLink()) {
    return { kind: "refused", result: immediateResult(spike.id, "G0_SPIKE_PATH_INVALID") };
  }
  if (!stat.isFile()) {
    return {
      kind: "refused",
      result: immediateResult(spike.id, "G0_SPIKE_SCRIPT_NOT_REGULAR_FILE"),
    };
  }
  try {
    accessSync(path, fsConstants.X_OK);
  } catch {
    return {
      kind: "refused",
      result: immediateResult(spike.id, "G0_SPIKE_SCRIPT_NOT_EXECUTABLE"),
    };
  }
  try {
    const canonicalRoot = realpathSync(context.root);
    const canonicalPath = realpathSync(path);
    if (!isPathWithin(canonicalRoot, canonicalPath)) {
      return { kind: "refused", result: immediateResult(spike.id, "G0_SPIKE_PATH_INVALID") };
    }
    // This is validation only: an unavailable containment capability must still
    // retain static path diagnostics, but it never reaches open or spawn.
    if (context.containment.kind === "none") {
      return { kind: "refused", result: containmentUnavailableResult(spike.id) };
    }
    return { kind: "ready", path, canonicalRoot, canonicalPath };
  } catch {
    return { kind: "refused", result: immediateResult(spike.id, "G0_SPIKE_PATH_INVALID") };
  }
}

/**
 * Open the executable once, without following a final symlink, then execute
 * that pinned descriptor. The post-open realpath check catches a renamed parent
 * directory or another race between preflight and open; the child receives the
 * descriptor rather than a mutable pathname.
 */
function openPinnedScript(
  path: string,
  canonicalRoot: string,
  expectedCanonicalPath: string,
): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return undefined;
    }
    const pinnedPath = realpathSync(`/proc/self/fd/${fd}`);
    if (!pinnedScriptPathIsExpected(canonicalRoot, expectedCanonicalPath, pinnedPath)) {
      closeSync(fd);
      return undefined;
    }
    return fd;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the failed open left no usable descriptor */
      }
    }
    return undefined;
  }
}

async function runSpike(spike: G0Spike, context: SpikeRunContext): Promise<G0SpikeResult> {
  const preflight = preflightSpike(spike, context);
  if (preflight.kind === "refused") return preflight.result;
  const scriptFd = openPinnedScript(
    preflight.path,
    preflight.canonicalRoot,
    preflight.canonicalPath,
  );
  if (scriptFd === undefined) return immediateResult(spike.id, "G0_SPIKE_PATH_INVALID");

  const startedAt = performance.now();
  let child: ChildProcess;
  // Under a PID namespace the supervisor is PID 1 of its own namespace, so a
  // `setsid` descendant cannot escape observation and cannot outlive teardown.
  const launch =
    context.containment.kind === "pid-namespace"
      ? pidNamespaceShellArgv(
          SUPERVISOR_PROGRAM,
          "g0-supervisor",
          context.interpreter,
          "/proc/self/fd/4",
          context.containment.kind,
        )
      : [
          "bash",
          "-c",
          SUPERVISOR_PROGRAM,
          "g0-supervisor",
          context.interpreter,
          "/proc/self/fd/4",
          context.containment.kind,
        ];
  try {
    child = spawn(launch[0] as string, launch.slice(1), {
      cwd: context.root,
      // `detached` makes the supervisor a session and process-group leader, so
      // its pid is the pgid every descendant inherits.
      detached: true,
      // Never `inherit`: this process's stdout carries the aggregate JSON, and a
      // spike must not be able to write into that record. fd 3 is the
      // supervisor's private control channel and never carries spike output;
      // fd 4 is the already-open script, never a pathname a peer can swap.
      stdio: ["ignore", "pipe", "pipe", "pipe", scriptFd],
    });
  } catch {
    return immediateResult(spike.id, "G0_SPIKE_SPAWN_FAILED");
  } finally {
    // The child inherited its own reference. Closing ours is ordinary resource
    // hygiene and cannot alter the pinned executable it is about to run.
    try {
      closeSync(scriptFd);
    } catch {
      /* spawn owns no mutable path; an already-closed parent fd is harmless */
    }
  }

  const pgid = child.pid;
  const stdout = captureStream(child.stdout, context.maxCapturedBytes);
  const stderr = captureStream(child.stderr, context.maxCapturedBytes);
  const control = child.stdio[3] as Readable & { end?: () => void };
  let controlText = "";
  control?.on("data", (chunk: Buffer) => {
    controlText += chunk.toString("utf8");
  });
  /** Releases the supervisor's hold on the process group. Safe to call twice. */
  const releaseSupervisor = () => {
    try {
      (control as unknown as { end?: () => void })?.end?.();
    } catch {
      /* the supervisor is already gone */
    }
  };

  let spawnFailed = false;
  const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      // A failure to start is its own condition. Reporting it as a
      // process-group signalling failure named the wrong subsystem entirely and
      // sent a reader looking for a kill that never happened.
      child.once("error", () => {
        spawnFailed = true;
        // Nothing will ever write to these, and nothing will end them either.
        child.stdout?.destroy();
        child.stderr?.destroy();
        control?.destroy();
        resolveExit({ exitCode: null, signal: null });
      });
      child.once("exit", (exitCode, exitSignal) => {
        resolveExit({ exitCode, signal: exitSignal });
      });
    },
  );

  /**
   * Wait for the script to finish, which is *not* the same event as the
   * supervisor finishing: the supervisor deliberately outlives it. Either the
   * control line arrives, or the supervisor died outright (a hard kill, or a
   * failure to start), and both have to release this wait.
   */
  const scriptSettled = new Promise<void>((resolveSettled) => {
    const check = () => {
      if (controlText.includes("\n")) resolveSettled();
    };
    control?.on("data", check);
    control?.once("end", () => resolveSettled());
    control?.once("close", () => resolveSettled());
    control?.once("error", () => resolveSettled());
    void exitPromise.then(() => resolveSettled());
    check();
  });
  let scriptHasSettled = false;
  void scriptSettled.then(() => {
    scriptHasSettled = true;
  });

  let reason: "timeout" | "abort" | undefined;
  let terminationRequested = false;
  let signalFailed = false;
  let termination: Promise<void> | undefined;

  /**
   * Stop a running script without trusting a process-table snapshot. The outer
   * `unshare --fork` process is the detached group leader, and `--kill-child`
   * makes killing it tear down PID 1 and every namespace member. That topology
   * remains safe even if ps is slow, malformed, or omits the group entirely.
   */
  const terminate = (why: "timeout" | "abort"): void => {
    if (terminationRequested || pgid === undefined) return;
    terminationRequested = true;
    reason = why;
    termination = (async () => {
      if (signalOwnedGroup(pgid, "SIGTERM") === "failed") signalFailed = true;
      const grace = Math.min(context.terminationGraceMs, remainingBefore(context.absoluteDeadline));
      if (!scriptHasSettled && grace > 0) {
        await Promise.race([scriptSettled, Bun.sleep(grace)]);
      }
      // Do not use ps to decide whether to escalate: a partial table can say
      // "empty" while both the outer launcher and PID 1 still ignore TERM.
      if (!scriptHasSettled && signalOwnedGroup(pgid, "SIGKILL") === "failed") {
        signalFailed = true;
      }
    })();
  };

  const timeout = setTimeout(
    () => {
      terminate("timeout");
    },
    Math.min(context.timeoutMs, remainingBefore(context.absoluteDeadline)),
  );
  const onAbort = () => {
    terminate("abort");
  };
  context.signal?.addEventListener("abort", onAbort, { once: true });
  if (context.signal?.aborted) onAbort();
  await scriptSettled;
  clearTimeout(timeout);
  context.signal?.removeEventListener("abort", onAbort);
  if (termination !== undefined) await termination;

  /**
   * The convergence requirement.
   *
   * A spike owns everything it starts. If the script has finished and processes
   * it spawned are still running, the gate has not observed a clean run — it has
   * observed a leak, whatever exit code the script chose to report. Previously
   * this went unmeasured and such a spike was recorded as `pass`, which is the
   * exact false green this check exists to remove.
   *
   * This runs while the supervisor still holds the group open, so the scan sees
   * the real membership and the cleanup signals live pids.
   */
  /**
   * The supervisor's verdict on whether the interpreter existed at all. This is
   * decided before anything is launched, so it never has to be inferred from an
   * exit status that a script could equally well have chosen for itself.
   */
  const startFailed = spawnFailed || /G0SUP spawn_failed=1/.test(controlText);

  let descendantsLeaked = false;
  let descendantsUnkillable = false;
  let scanUnknown = false;
  if (pgid !== undefined && !startFailed) {
    const outcome = await reapDescendants(
      pgid,
      context.containment.kind === "pid-namespace",
      context.terminationGraceMs,
      context.psCommand,
      context.absoluteDeadline,
    );
    descendantsLeaked = outcome.leaked;
    descendantsUnkillable = outcome.unkillable;
    scanUnknown = outcome.unknown;
    if (outcome.signalFailed) signalFailed = true;
  }

  if (context.containment.kind === "pid-namespace" && !startFailed) {
    const namespaceReport =
      /G0SUP status=\d+ signal=\S* namespace_scan=(\S+) namespace_survivors=(\S*)/.exec(
        controlText,
      );
    if (namespaceReport?.[1] !== "ok" || !/^\d+$/.test(namespaceReport[2] ?? "")) {
      scanUnknown = true;
    } else if (Number(namespaceReport[2]) > 0) {
      // This is the catch the host process-group scan cannot make: `setsid` can
      // leave that group and close every inherited descriptor, but it remains
      // visible to PID 1 through its mounted namespace-local /proc.
      descendantsLeaked = true;
    }
  }

  // Release the supervisor's hold. If cleanup already signalled the group, the
  // supervisor is gone and this is a no-op; on the clean path it is what lets it
  // exit at all.
  releaseSupervisor();
  const exited = await exitPromise;

  /**
   * Drain the pipes, but on a deadline.
   *
   * A child's descendants inherit its stdout and stderr, so the pipe does not
   * reach `end` when the shell exits — it reaches `end` when the *last* holder
   * closes it. Waiting unconditionally would hand any pipe-holding process the
   * power to stall this runner after its timer has already been cleared.
   *
   * A well-behaved child's pipes close the instant it exits, so this costs
   * nothing in the normal case. When the deadline does expire, the streams are
   * destroyed and whatever arrives afterwards is lost — and that loss is
   * recorded. Reporting a bounded log as if it were the whole log is the same
   * class of dishonesty as reporting a leaked spike as a pass: the record would
   * claim completeness it does not have.
   */
  const drainBudget = Math.min(context.postExitDrainMs, remainingBefore(context.absoluteDeadline));
  const drained = await drainCapturedStreams([stdout, stderr], drainBudget);
  if (!drained) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const outputTruncated = stdout.truncated() || stderr.truncated() || !drained;
  replayCapture(context.diagnosticSink, spike.id, "stdout", stdout, context.root, !drained);
  replayCapture(context.diagnosticSink, spike.id, "stderr", stderr, context.root, !drained);

  if (startFailed) {
    return {
      id: spike.id,
      status: "fail",
      code: "G0_SPIKE_SPAWN_FAILED",
      durationMs: Math.round(performance.now() - startedAt),
      ...(outputTruncated ? { outputTruncated } : {}),
    };
  }

  const durationMs = Math.round(performance.now() - startedAt);
  /**
   * The script's status, not the supervisor's.
   *
   * They agree in the ordinary case, but only the control line is authoritative:
   * if the supervisor were itself killed, its exit code would describe that
   * killing rather than anything the spike did.
   */
  const reported = /G0SUP status=(\d+) signal=(\S*)/.exec(controlText);
  const supervisorExit = exited.exitCode ?? undefined;
  const exitCode = reported !== null ? Number(reported[1]) : supervisorExit;
  /**
   * The script's signal, decoded by the supervisor from its 128+N wait status.
   * `exited.signal` describes the *supervisor*, which is a different process and
   * would report a hard kill of the supervisor as though the spike had been
   * signalled.
   */
  const reportedSignal = reported?.[2] ?? "";
  const exitSignal =
    reportedSignal.length > 0
      ? ((reportedSignal.startsWith("SIG")
          ? reportedSignal
          : `SIG${reportedSignal}`) as NodeJS.Signals)
      : (exited.signal ?? undefined);
  const base = {
    id: spike.id,
    durationMs,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(exitSignal === undefined ? {} : { signal: exitSignal }),
    ...(outputTruncated ? { outputTruncated } : {}),
  } as const;

  /**
   * Ownership outranks the exit code.
   *
   * These checks come before ordinary exit-status interpretation, including
   * `exitCode === 0`, because they describe whether the run can be believed at
   * all. Explicit timeout and abort requests take precedence: both are already
   * non-green, even if their terminating signal made a subsequent scan
   * impossible. A spike that returned 0 while leaving processes running did not
   * finish — it abandoned work, and the previous revision recorded that as
   * `pass`. A scan that could not read the process table proves nothing in
   * either direction and fails closed rather than defaulting to clean.
   */
  if (reason === "timeout") {
    return {
      ...base,
      status: "fail",
      code: context.boundedByAggregate ? "G0_SPIKE_AGGREGATE_TIMEOUT" : "G0_SPIKE_TIMEOUT",
    };
  }
  if (reason === "abort") return { ...base, status: "fail", code: "G0_SPIKE_ABORTED" };
  if (scanUnknown) {
    return { ...base, status: "fail", code: "G0_SPIKE_DESCENDANT_SCAN_FAILED" };
  }
  if (descendantsUnkillable) {
    return { ...base, status: "fail", code: "G0_SPIKE_DESCENDANT_UNKILLABLE" };
  }
  if (descendantsLeaked) {
    return { ...base, status: "fail", code: "G0_SPIKE_DESCENDANT_LEAKED" };
  }
  /**
   * An expired drain is evidence, not just a logging inconvenience.
   *
   * By this point the script has finished and the owned group has been reaped,
   * so nothing this runner can see should still be writing. If the pipe is
   * *still* open, some process is holding it — necessarily one that left the
   * process group, which is exactly how a daemonising spike hides from the scan
   * above. Treating that as a pass would hand any spike a one-line recipe for
   * leaking a process past this gate: call `setsid`.
   *
   * It is deliberately its own code rather than `DESCENDANT_LEAKED`: the two are
   * found by different means and a reader chasing one should not be told the
   * other.
   */
  const outputDrainFailure = outputDrainFailureCode(drained);
  if (outputDrainFailure !== undefined) {
    return { ...base, status: "fail", code: outputDrainFailure };
  }
  if (signalFailed) {
    return { ...base, status: "fail", code: "G0_SPIKE_PROCESS_GROUP_SIGNAL_FAILED" };
  }
  if (exitSignal !== undefined) return { ...base, status: "fail", code: "G0_SPIKE_SIGNALLED" };
  if (exitCode === 0) {
    /**
     * The last gate before green.
     *
     * Every check above answers "did something visibly go wrong?". This one
     * answers "could I have seen it if it had?" — and on a platform without a
     * containment primitive the answer is no, because a descendant that calls
     * `setsid` and closes its descriptors is outside every channel this runner
     * observes. Reporting that as a pass would be claiming a property that was
     * never tested. Blocked is the accurate word for it: the environment cannot
     * satisfy the check, which is exactly what 78 means here, and it is never
     * green.
     */
    // `runG0Spikes` rejects this capability before it reaches `runSpike`; retain
    // the defensive branch so a future internal caller cannot manufacture green.
    if (context.containment.kind === "none") {
      return { ...base, status: "blocked", code: "G0_SPIKE_CONTAINMENT_UNAVAILABLE" };
    }
    return { ...base, status: "pass", code: "G0_SPIKE_PASSED" };
  }
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
  const psCommand = validInterpreter(options.psCommand ?? "ps");
  // Runtime guard as well as the type: a cast, a JSON round-trip, or plain JS
  // could all present something the compiler never saw.
  if (options.containment !== undefined && options.containment.kind !== "none") {
    throw new TypeError(
      "containment may only be downgraded to none; capability is probed, never declared",
    );
  }
  const containment: ContainmentCapability = options.containment ?? probeContainment();
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
  if (containment.kind === "none") {
    // This is intentionally before `runSpike`: no interpreter, child process,
    // or fixture body runs when the kernel boundary is absent. Preflight still
    // runs for every entry because path and execute-bit mistakes are meaningful
    // static diagnostics, even on a host that cannot contain an otherwise valid
    // spike.
    const results = spikes.map((spike) => {
      const preflight = preflightSpike(spike, { root, signal: options.signal, containment });
      return preflight.kind === "refused"
        ? preflight.result
        : containmentUnavailableResult(spike.id);
    });
    return summarize(results, Math.round(performance.now() - startedAt));
  }
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
        absoluteDeadline: aggregateDeadline,
        timeoutMs: boundedByAggregate ? remaining : timeoutMs,
        terminationGraceMs,
        maxCapturedBytes,
        signal: options.signal,
        diagnosticSink,
        interpreter,
        psCommand,
        containment,
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
 * A second signal is recorded immediately but its hard exit is deferred until
 * the first signal's cleanup path has finished. Exiting before that point would
 * sever the runner while its detached group was still alive.
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
  let forcedExit: BridgedSignal | undefined;
  const bridge = (signal: BridgedSignal) => {
    if (interrupted !== undefined) {
      forcedExit = signal;
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
    if (forcedExit !== undefined) hardExit(signalExitCode(forcedExit));
    return interrupted === undefined ? summary.exitCode : signalExitCode(interrupted);
  } catch (error) {
    if (!(error instanceof G0ManifestError)) throw error;
    log(formatManifestFailure(error, root));
    if (forcedExit !== undefined) hardExit(signalExitCode(forcedExit));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await runG0Cli({ root: resolve(import.meta.dir, "../..") }));
}
