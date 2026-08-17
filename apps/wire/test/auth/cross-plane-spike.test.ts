// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this suite asserts on the
// text of a bash script, where `${VAR}` is the shell expansion being checked, not a
// JavaScript template placeholder. Rewriting them would stop the assertions matching
// the source they exist to pin.

/**
 * S-6 DEPLOYED-spike harness invariants (bead asimposiumorg-vw3).
 *
 * `scripts/e2e-s6-cross-plane-auth.sh` and `e2e/playwright/s6-cross-plane-runner.ts`
 * are the only runners allowed to claim the cross-plane seam works against real
 * infrastructure. They cannot be executed here — by construction they need a
 * Vercel preview, a deployed Worker, and a real Google account.
 *
 * An earlier revision of this suite was rejected for asserting with broad
 * substring greps over the whole file, which pass for the wrong reasons and
 * cannot tell a real guard from the same words in a comment. This revision:
 *
 *   - slices each assertion to the FUNCTION that must contain it;
 *   - executes the shell's causal self-tests instead of describing them;
 *   - proves its own teeth with a mutation: deleting a required `exit` must
 *     make a test fail, or the test was never load-bearing.
 */

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..", "..", "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

/** Strip comments: a guard must be code, never the prose describing a guard. */
const code = (relative: string): string =>
  read(relative)
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

const SCRIPT = "scripts/e2e-s6-cross-plane-auth.sh";
const RUNNER = "e2e/playwright/s6-cross-plane-runner.ts";
const SHELL_TIMEOUT_MS = 120_000;

/**
 * The body of one shell function, from `name() {` to the first line that is
 * exactly `}`. Slicing to the function is what makes an assertion mean "this
 * guard is in the code path", rather than "these characters exist somewhere".
 */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`shell function not found: ${name}`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  if (end === -1) throw new Error(`unterminated shell function: ${name}`);
  return rest.slice(0, end);
}

/** Hard ceiling on captured bytes, so a runaway child cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 1_048_576;
/** One absolute bound per child, independent of any assertion timeout. */
const RUN_TIMEOUT_MS = 100_000;
/** Maximum wait after an outer SIGKILL attempt before cleanup is unproven. */
const POST_KILL_SETTLE_MS = 2_000;
/** Supervisor capability records are tiny; refuse a runaway/forged stream. */
const OUTER_CONTROL_MAX_BYTES = 4_096;
/** Per-operation cap; every operation also consumes its caller's one absolute deadline. */
const OUTER_CONTROL_STEP_MS = 2_000;

class OverCapture extends Error {}

/**
 * Bounded read of a capture file. Never deletes.
 *
 * An over-cap file is REJECTED rather than truncated: silently parsing a green
 * prefix of a runaway capture would let a test pass on the first megabyte of
 * output that went wrong after it.
 */
interface CaptureIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

function captureIdentity(fd: number): CaptureIdentity {
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("capture descriptor is not a mode-600 regular file");
  }
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function readBounded(fd: number, path: string, identity: CaptureIdentity): string {
  const before = fstatSync(fd);
  if (
    !before.isFile() ||
    before.dev !== identity.dev ||
    before.ino !== identity.ino ||
    before.mode !== identity.mode ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw new Error(`capture identity or mode changed at ${path}`);
  }
  const size = before.size;
  if (size > MAX_CAPTURE_BYTES) {
    throw new OverCapture(`capture exceeded ${MAX_CAPTURE_BYTES} bytes (${size})`);
  }
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, buffer, offset, size - offset, offset);
    if (read === 0) throw new Error(`capture short read at ${path}: ${offset}/${size}`);
    offset += read;
  }
  const after = fstatSync(fd);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size
  ) {
    throw new Error(`capture changed while being read at ${path}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`capture is not canonical UTF-8 at ${path}`);
  }
}

interface OuterControlListener {
  readonly port: number;
  readonly connected: Promise<Socket>;
  readonly protocolFailure: () => Error | undefined;
  seal(): void;
  close(): Promise<void>;
}

/**
 * One loopback TCP rendezvous, created before the supervisor and sealed after
 * the first candidate (plus the explicit exact-one test seam). This deliberately
 * follows the repo-proven S1 socket transport:
 * nested Bun stdio pipes have lost bytes and thrown EPIPE under `bun test`.
 * A TCP port is not authority. The accepted duplex socket becomes authority only
 * after the parent bootstraps its secret nonce, before the supervisor forks the
 * target; the target then closes that descriptor.
 */
async function outerControlListener(): Promise<OuterControlListener> {
  const server = createServer();
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("expected a loopback TCP supervisor listener");
  }

  let parentSide: Socket | undefined;
  let parentClosed = Promise.resolve();
  let connectionSettled = false;
  let disposed = false;
  let closePromise: Promise<void> | undefined;
  let failure: Error | undefined;
  let rejectConnection: ((error: Error) => void) | undefined;
  let resolveServerClosed: (() => void) | undefined;
  const serverClosed = new Promise<void>((resolve) => {
    resolveServerClosed = resolve;
  });
  let serverCloseStarted = false;
  const stopAccepting = (): void => {
    if (serverCloseStarted) return;
    serverCloseStarted = true;
    server.close(() => {
      resolveServerClosed?.();
      resolveServerClosed = undefined;
    });
  };
  const connected = new Promise<Socket>((resolveConnection, rejectConnected) => {
    rejectConnection = rejectConnected;
    server.on("connection", (socket) => {
      socket.setNoDelay(true);
      if (parentSide !== undefined || disposed) {
        failure ??= new Error("multiple supervisor capability connections");
        socket.destroy();
        parentSide?.destroy();
        if (!connectionSettled) {
          connectionSettled = true;
          rejectConnected(failure);
        }
        return;
      }
      parentSide = socket;
      parentClosed = new Promise<void>((resolveClosed) => {
        socket.once("close", () => resolveClosed());
      });
      socket.on("error", (error) => {
        failure ??= error;
        socket.destroy();
      });
      connectionSettled = true;
      resolveConnection(socket);
    });
  });
  server.on("error", (error) => {
    failure ??= error;
    if (!connectionSettled) {
      connectionSettled = true;
      rejectConnection?.(error);
    }
    parentSide?.destroy();
  });
  // `Bun.spawn` can throw before the caller starts its connection race. Keep a
  // close-triggered rejection observed even on that pre-spawn path.
  void connected.catch(() => undefined);
  return {
    port: address.port,
    connected,
    protocolFailure: () => failure,
    seal: stopAccepting,
    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        disposed = true;
        if (!connectionSettled) {
          connectionSettled = true;
          rejectConnection?.(new Error("supervisor capability listener closed before connect"));
        }
        stopAccepting();
        parentSide?.destroy();
        await Promise.all([serverClosed, parentClosed]);
      })();
      return closePromise;
    },
  };
}

type BoundedResult<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "elapsed" };

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      new Promise<{ kind: "elapsed" }>((resolveElapsed) => {
        timer = setTimeout(() => resolveElapsed({ kind: "elapsed" }), Math.max(0, milliseconds));
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function controlStepRemaining(deadlineAt: number): number {
  return Math.max(0, Math.min(OUTER_CONTROL_STEP_MS, deadlineAt - Date.now()));
}

type OuterTerminal =
  | { readonly kind: "child"; readonly status: number }
  | { readonly kind: "protocol-failure"; readonly error: Error };

type OuterProtocolState = "connected" | "ready" | "running" | "term-sent" | "closing";

/**
 * Strict nonce-framed protocol over the one accepted loopback socket.
 *
 * The supervisor is the sole socket writer. Its payload recorder reaches it
 * over an anonymous pipe, so CHILD and ACK records cannot interleave bytes.
 */
class OuterSupervisorProtocol {
  readonly terminal: Promise<OuterTerminal>;
  readonly closed: Promise<void>;
  private readonly socket: Socket;
  private readonly token: string;
  private state: OuterProtocolState = "connected";
  private totalBytes = 0;
  private buffered = Buffer.alloc(0);
  private failure: Error | undefined;
  private terminalSeen = false;
  private closureExpected = false;
  private resolveTerminal: ((terminal: OuterTerminal) => void) | undefined;
  private expected:
    | {
        readonly record: string;
        readonly onMatch?: () => void;
        readonly resolve: (matched: boolean) => void;
      }
    | undefined;

  constructor(socket: Socket, token: string) {
    this.socket = socket;
    this.token = token;
    this.closed = new Promise<void>((resolveClosed) => {
      socket.once("close", () => resolveClosed());
    });
    this.terminal = new Promise<OuterTerminal>((resolve) => {
      this.resolveTerminal = resolve;
    });
    socket.on("data", (chunk: Buffer) => this.acceptBytes(chunk));
    socket.once("end", () => this.acceptClose("ended"));
    socket.once("close", () => this.acceptClose("closed"));
    socket.once("error", () => this.acceptClose("errored"));
  }

  protocolFailure(): Error | undefined {
    return this.failure;
  }

  private fail(reason: string): void {
    if (this.failure !== undefined) return;
    this.failure = new Error("outer supervisor protocol failure: " + reason);
    this.expected?.resolve(false);
    this.expected = undefined;
    if (!this.terminalSeen) {
      this.resolveTerminal?.({ kind: "protocol-failure", error: this.failure });
      this.resolveTerminal = undefined;
    }
    this.socket.destroy();
  }

  private acceptClose(reason: string): void {
    if (this.buffered.byteLength !== 0) {
      this.fail("trailing partial frame");
      return;
    }
    if (this.expected !== undefined) {
      this.fail("socket " + reason + " before expected acknowledgement");
      return;
    }
    if (!this.closureExpected) this.fail("socket " + reason + " unexpectedly");
  }

  private acceptBytes(chunk: Buffer): void {
    if (this.failure !== undefined) return;
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > OUTER_CONTROL_MAX_BYTES) {
      this.fail("byte limit exceeded");
      return;
    }
    for (const byte of chunk) {
      if (byte > 0x7f || byte === 0 || byte === 0x0d) {
        this.fail("non-canonical byte");
        return;
      }
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (true) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline === -1) {
        if (this.buffered.byteLength > 511) this.fail("frame length exceeded");
        return;
      }
      if (newline > 511) {
        this.fail("frame length exceeded");
        return;
      }
      const line = this.buffered.subarray(0, newline).toString("ascii");
      this.buffered = this.buffered.subarray(newline + 1);
      this.acceptRecord(line);
      if (this.failure !== undefined) return;
    }
  }

  private acceptRecord(record: string): void {
    const childPrefix = "outer-child:" + this.token + ":";
    if (record.startsWith(childPrefix)) {
      if (this.state !== "running" && this.state !== "term-sent") {
        this.fail("CHILD before STARTED");
        return;
      }
      if (this.terminalSeen) {
        this.fail("duplicate CHILD");
        return;
      }
      const statusText = record.slice(childPrefix.length);
      if (!/^(0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])$/.test(statusText)) {
        this.fail("non-canonical CHILD status");
        return;
      }
      const status = Number(statusText);
      if (status > 255) {
        this.fail("CHILD status out of range");
        return;
      }
      this.terminalSeen = true;
      this.resolveTerminal?.({ kind: "child", status });
      this.resolveTerminal = undefined;
      return;
    }
    if (this.expected?.record === record) {
      this.expected.onMatch?.();
      const resolve = this.expected.resolve;
      this.expected = undefined;
      resolve(true);
      return;
    }
    this.fail("unknown, duplicate, or out-of-order record");
  }

  private expectRecord(record: string, onMatch?: () => void): Promise<boolean> {
    if (this.failure !== undefined || this.expected !== undefined) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.expected = { record, onMatch, resolve };
    });
  }

  private cancelExpected(): void {
    this.expected?.resolve(false);
    this.expected = undefined;
  }

  private async writeFrame(frame: string, deadlineAt: number): Promise<boolean> {
    if (this.failure !== undefined || this.socket.destroyed) return false;
    const writeBudget = controlStepRemaining(deadlineAt);
    if (writeBudget === 0) {
      this.fail("absolute deadline elapsed before write");
      return false;
    }
    const bytes = Buffer.from(frame + "\n", "ascii");
    const written = new Promise<void>((resolve, reject) => {
      try {
        // The callback fires only after the complete buffer is handed off.
        // A false return is backpressure, not a partial write.
        this.socket.write(bytes, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    try {
      const result = await within(written, writeBudget);
      if (result.kind === "elapsed") {
        this.fail("write callback timeout");
        return false;
      }
      return true;
    } catch {
      this.fail("write callback failure");
      return false;
    }
  }

  private async request(
    frame: string,
    expected: string,
    deadlineAt: number,
    onMatch?: () => void,
  ): Promise<boolean> {
    const acknowledgement = this.expectRecord(expected, onMatch);
    if (!(await this.writeFrame(frame, deadlineAt))) {
      this.cancelExpected();
      return false;
    }
    const acknowledgementBudget = controlStepRemaining(deadlineAt);
    if (acknowledgementBudget === 0) {
      this.cancelExpected();
      this.fail("absolute deadline elapsed before acknowledgement");
      return false;
    }
    const result = await within(acknowledgement, acknowledgementBudget);
    if (result.kind === "elapsed") {
      this.cancelExpected();
      this.fail("acknowledgement timeout");
      return false;
    }
    return result.value;
  }

  async bootstrap(deadlineAt: number): Promise<boolean> {
    if (this.state !== "connected") return false;
    return this.request(
      "BOOT\t" + this.token,
      "outer-ready:" + this.token,
      deadlineAt,
      () => {
        this.state = "ready";
      },
    );
  }

  async start(deadlineAt: number): Promise<boolean> {
    if (this.state !== "ready") return false;
    return this.request(
      "START\t" + this.token,
      "outer-started:" + this.token,
      deadlineAt,
      () => {
        this.state = "running";
      },
    );
  }

  async signal(
    signal: "TERM" | "KILL",
    cleanupDeadlineAt: number,
    failKillDispatch: boolean,
    onControlSignal?: (signal: "TERM" | "KILL") => void,
  ): Promise<boolean> {
    if (
      (this.state !== "running" && this.state !== "term-sent") ||
      (signal === "KILL" && failKillDispatch)
    ) {
      return false;
    }
    if (signal === "KILL") this.closureExpected = true;
    const ok = await this.request(
      "SIGNAL\t" + this.token + "\t" + signal,
      "outer-ack:" + this.token + ":" + signal,
      cleanupDeadlineAt,
    );
    if (!ok) return false;
    onControlSignal?.(signal);
    this.state = signal === "TERM" ? "term-sent" : "closing";
    return true;
  }

  async die(cleanupDeadlineAt: number): Promise<boolean> {
    if (this.state !== "running" && this.state !== "term-sent") return false;
    this.closureExpected = true;
    const ok = await this.request(
      "DIE\t" + this.token,
      "outer-closed:" + this.token,
      cleanupDeadlineAt,
    );
    if (ok) this.state = "closing";
    return ok;
  }

  expectClosure(): void {
    this.closureExpected = true;
  }
}

const OUTER_SETPGRP_PROGRAM =
  "use POSIX qw(dup dup2 close); pipe(my $reader,my $writer) or die $!; " +
  "my $r=fileno($reader); my $w=fileno($writer); " +
  "if ($r==9 && $w!=9) { $r=dup($r); die $! if $r<0; } " +
  "dup2($w,9) unless $w==9; dup2($r,8) unless $r==8; " +
  "close($r) if $r!=8 && $r!=9; " +
  "close($w) if $w!=8 && $w!=9; $^F=9; setpgrp(0,0) or die $!; " +
  "exec @ARGV or die $!;";

const OUTER_SUPERVISOR_PROGRAM = [
  'port="$1" unavailable="$2" stdout_file="$3" stderr_file="$4" ready_delay="$5" started_delay="$6" ack_delay="$7" extra_kill_record="$8"',
  "shift 8",
  "set +m",
  "LC_ALL=C",
  "export LC_ALL",
  "trap '' TERM HUP INT PIPE",
  'exec 7<>"/dev/tcp/127.0.0.1/$port" || exit "$unavailable"',
  "tab=$'\\t'",
  'IFS="$tab" read -r boot_kind token boot_extra <&7 || kill -KILL 0',
  '[[ "$boot_kind" == "BOOT" && -n "$token" && -z "$boot_extra" ]] || kill -KILL 0',
  '[[ "$ready_delay" =~ ^(0|[0-9]+\\.[0-9][0-9][0-9])$ ]] || kill -KILL 0',
  '[[ "$started_delay" =~ ^(0|[0-9]+\\.[0-9][0-9][0-9])$ ]] || kill -KILL 0',
  '[[ "$ack_delay" =~ ^(0|[0-9]+\\.[0-9][0-9][0-9])$ ]] || kill -KILL 0',
  '[[ "$ready_delay" == "0" ]] || { IFS= read -r -t "$ready_delay" _ <&8 || :; }',
  'printf "outer-ready:%s\\n" "$token" >&7 || kill -KILL 0',
  'IFS="$tab" read -r start_kind start_token start_extra <&7 || kill -KILL 0',
  '[[ "$start_kind" == "START" && "$start_token" == "$token" && -z "$start_extra" ]] || kill -KILL 0',
  '[[ "$started_delay" == "0" ]] || { IFS= read -r -t "$started_delay" _ <&8 || :; }',
  'printf "outer-started:%s\\n" "$token" >&7 || kill -KILL 0',
  "(",
  "  exec 8<&-",
  "  command_status=0",
  "  (",
  "    trap - TERM HUP INT PIPE",
  "    unset token boot_kind start_token",
  "    exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-",
  '    exec "$@" </dev/null >"$stdout_file" 2>"$stderr_file"',
  "  ) || command_status=$?",
  '  printf "child:%s:%s\\n" "$token" "$command_status" >&9 || kill -KILL 0',
  "  exec 9>&-",
  ") &",
  "exec 9>&-",
  "child_sent=0",
  "while :; do",
  "  if (( child_sent == 0 )); then",
  '    if IFS= read -r -t 0.05 child_record <&8; then',
  '      child_prefix="child:$token:"',
  '      [[ "$child_record" == "$child_prefix"* ]] || kill -KILL 0',
  '      child_status="${child_record#"$child_prefix"}"',
  '      [[ "$child_status" =~ ^(0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])$ ]] || kill -KILL 0',
  "      (( 10#$child_status <= 255 )) || kill -KILL 0",
  '      printf "outer-child:%s:%s\\n" "$token" "$child_status" >&7 || kill -KILL 0',
  "      child_sent=1",
  "    fi",
  "  fi",
  "  request_status=0",
  '  IFS="$tab" read -r -t 0.05 request_kind request_token request_signal request_extra <&7 || request_status=$?',
  "  if (( request_status == 0 )); then",
  '    [[ "$request_token" == "$token" && -z "$request_extra" ]] || kill -KILL 0',
  '    case "$request_kind:$request_signal" in',
  '      "SIGNAL:TERM")',
  '        [[ "$ack_delay" == "0" ]] || { IFS= read -r -t "$ack_delay" _ <&7 || :; }',
  '        printf "outer-ack:%s:TERM\\n" "$token" >&7 || kill -KILL 0',
  "        kill -TERM 0 2>/dev/null || kill -KILL 0",
  "        ;;",
  '      "SIGNAL:KILL")',
  '        [[ "$ack_delay" == "0" ]] || { IFS= read -r -t "$ack_delay" _ <&7 || :; }',
  '        printf "outer-ack:%s:KILL\\n" "$token" >&7 || kill -KILL 0',
  '        [[ "$extra_kill_record" == "1" ]] && printf "outer-ack:%s:EXTRA\\n" "$token" >&7',
  "        kill -KILL 0",
  "        ;;",
  '      "DIE:")',
  '        printf "outer-closed:%s\\n" "$token" >&7 || kill -KILL 0',
  "        kill -KILL 0",
  "        ;;",
  "      *) kill -KILL 0 ;;",
  "    esac",
  "  elif (( request_status == 1 )); then",
  "    kill -KILL 0",
  "  fi",
  "done",
].join("\n");

const OUTER_NEVER_CONNECT_PROGRAM =
  'trap "" TERM HUP INT; kill -STOP "$BASHPID"; exit 99';

interface ShellLifecycle {
  readonly cleanupUnproven: boolean;
  readonly survivors: boolean;
}

/**
 * Derive the nested-group lifecycle verdict from exact shell NDJSON and exit.
 *
 * Substring matching is not evidence: the same words can occur in `detail`, a
 * different suite, or a non-terminal record. Exit 125 is independently
 * fail-closed because it is the script's reserved cleanup-unproven status; the
 * exact typed terminal record covers a captured refusal even if a wrapper
 * translates the status. Either polarity means survivors cannot be disproved.
 */
function shellLifecycleFromRecords(stdout: string, exitCode: number): ShellLifecycle {
  let typedCleanupRefusal = false;
  let typedSurvivorFailure = false;
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || Array.isArray(record) || typeof record !== "object") continue;
    const fields = record as Record<string, unknown>;
    if (fields.suite !== "s6-cross-plane-auth") continue;
    if (fields.status === "blocked" && fields.code === "CLEANUP_UNPROVEN") {
      typedCleanupRefusal = true;
    }
    if (fields.assertion === "no-child-survivors" && fields.status === "fail") {
      typedSurvivorFailure = true;
    }
  }
  const cleanupUnproven = exitCode === 125 || typedCleanupRefusal || typedSurvivorFailure;
  return {
    cleanupUnproven,
    survivors: cleanupUnproven,
  };
}

interface ShellRun {
  readonly exitCode: number;
  readonly stdout: string;
  /** Diagnostics only. Never asserted on: the contract is the stdout NDJSON. */
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True if anything remained in the child's process group after the census. */
  readonly survivors: boolean;
  /**
   * True when the run had to be hard-killed, so its nested process groups
   * cannot be shown to have been reaped.
   *
   * This is NOT a containment claim in either direction — it records that the
   * question is unanswerable for that run, because the script's trap was cut
   * short and this controller cannot see groups it does not lead.
   */
  readonly cleanupUnproven: boolean;
  /** True only when the outer controller actually dispatched its KILL escalation. */
  readonly escalationFired: boolean;
}

interface ShellRunOptions {
  readonly runTimeoutMs?: number;
  readonly killGraceMs?: number;
  readonly postKillSettleMs?: number;
  /** Test-only causal barrier: arm the deadline only after this file exists. */
  readonly armAfterFileExists?: string;
  /** Test-only injected supervisor KILL-command refusal. */
  readonly failKillDispatch?: boolean;
  /** Test-only observer called after a signal command is written to the live capability. */
  readonly onControlSignal?: (signal: "TERM" | "KILL") => void;
  /** Test-only cumulative BOOT/READY delay in the real supervisor. */
  readonly controlReadyDelayMs?: number;
  /** Test-only cumulative START/STARTED delay in the real supervisor. */
  readonly controlStartedDelayMs?: number;
  /** Test-only delay for each TERM/KILL application acknowledgement. */
  readonly controlAckDelayMs?: number;
  /** Test-only duplicate record after KILL acknowledgement. */
  readonly extraRecordAfterKillAck?: boolean;
  /** Test-only hook after first accept and before listener sealing/token mint. */
  readonly afterControlAccept?: (port: number) => Promise<void>;
  /** Test-only post-settlement connect attempt; the sealed listener must refuse it. */
  readonly probeLateSecondConnection?: boolean;
  /** Test-only stopped helper that never opens the rendezvous. */
  readonly supervisorNeverConnect?: boolean;
}

/**
 * Run the shell with FILE-BACKED capture rather than pipes.
 *
 * The previous implementation spawned with `stderr: "pipe"` and then awaited
 * only stdout and `exited`. Nothing ever drained stderr, so once the script's
 * human log filled the stderr pipe buffer the child blocked mid-write: under
 * `bun test` that surfaced as `--self-test` exiting 1 and the blocked case
 * returning 78 with an empty stdout, while the identical spawn under `bun -e`
 * and a direct `bash` run both passed. Pre-opened private files have no such
 * back-pressure, and they remove the Bun-under-Bun pipe transport from the path
 * entirely — the same failure class already seen in S3/environment. The
 * process-group launcher opens the capture paths itself: nested Bun has also
 * been observed to acknowledge a numeric stdout fd while silently discarding
 * every byte written through it.
 *
 * Capture files are mode 600 and are deliberately RETAINED (AGENTS.md forbids
 * cleanup-by-deletion); they hold harness output only, never a credential.
 */
async function runShell(
  args: readonly string[],
  env: Record<string, string | undefined>,
  script = SCRIPT,
  options: ShellRunOptions = {},
): Promise<ShellRun> {
  const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-run-"));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  // NO OWNERSHIP LEDGER. The outer supervisor is a live capability: after one
  // loopback accept, a parent-memory nonce authenticates its duplex socket before
  // target fork. The supervisor self-signals group zero; this parent never names
  // a pid or pgid. A timed-out run remains cleanup-unproven because killing the
  // outer shell cuts short its nested-group settlement report.
  // TOTAL descriptor ownership, released exactly once.
  //
  // Holding the descriptors until the child exits fixed the lost-output race,
  // but on its own it leaked them on every abnormal path: a `Bun.spawn` throw, a
  // rejected `child.exited`, a census exception, or an `OverCapture` from the
  // reader. The `finally` below covers all of them, and the flag makes a double
  // release harmless.
  // Each descriptor is tracked separately and cleared ONLY after its close
  // actually succeeded. The previous shape set one flag before either close and
  // swallowed every error, so a real close refusal leaked silently while the
  // suite went green — and a stdout failure meant stderr was never retried.
  // EINTR is retried; anything else is aggregated and thrown so the test fails.
  let stdoutFd = -1;
  let stderrFd = -1;
  let stdoutOpen = false;
  let stderrOpen = false;
  const releaseCaptureFds = (): void => {
    const failures: string[] = [];
    const close = (fd: number, label: string, clear: () => void): void => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          closeSync(fd);
          clear();
          return;
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code === "EINTR") continue;
          if (code === "EBADF") {
            // Genuinely not open any more; that is a successful release.
            clear();
            return;
          }
          failures.push(`${label}: ${code ?? "unknown"}`);
          return;
        }
      }
      failures.push(`${label}: EINTR after 4 attempts`);
    };
    if (stdoutOpen) {
      close(stdoutFd, "stdout", () => {
        stdoutOpen = false;
      });
    }
    if (stderrOpen) {
      close(stderrFd, "stderr", () => {
        stderrOpen = false;
      });
    }
    if (failures.length > 0) {
      throw new Error(`capture descriptors could not be released: ${failures.join("; ")}`);
    }
  };

  let stdoutCaptureIdentity: CaptureIdentity | undefined;
  let stderrCaptureIdentity: CaptureIdentity | undefined;
  const captureOpenFlags =
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  try {
    stdoutFd = openSync(stdoutPath, captureOpenFlags, 0o600);
    stdoutOpen = true;
    stdoutCaptureIdentity = captureIdentity(stdoutFd);
    stderrFd = openSync(stderrPath, captureOpenFlags, 0o600);
    stderrOpen = true;
    stderrCaptureIdentity = captureIdentity(stderrFd);
  } catch (openError) {
    try {
      releaseCaptureFds();
    } catch (closeError) {
      throw new AggregateError(
        [openError, closeError],
        "capture construction failed and partial descriptor release also failed",
      );
    }
    throw openError;
  }
  if (stdoutCaptureIdentity === undefined || stderrCaptureIdentity === undefined) {
    releaseCaptureFds();
    throw new Error("capture descriptor identity was not established");
  }

  let controlListener: OuterControlListener | undefined;
  let protocol: OuterSupervisorProtocol | undefined;
  let supervisorExited: Promise<number> | undefined;
  let supervisorSettled = false;
  let capabilityEstablished = false;
  let retirePreCapabilitySupervisor: ((cleanupDeadlineAt: number) => Promise<void>) | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineAt = 0;
  let teardownDeadlineAt: number | undefined;
  const beginTeardownBudget = (milliseconds: number): number => {
    teardownDeadlineAt ??= Date.now() + milliseconds;
    return teardownDeadlineAt;
  };
  try {
    controlListener = await outerControlListener();
    // Perl creates the anonymous recorder pipe and the real process group, then
    // Bash opens the loopback capability as FD7 before it reads BOOT. No Bun
    // child stdio pipe and no numeric pid/pgid authority exists in the parent.
    // The one production work deadline begins at child launch. Connection,
    // BOOT/READY, START/STARTED, and payload lifetime all consume this same
    // budget; no protocol step receives a fresh window.
    deadlineAt = Date.now() + runTimeoutMs;
    const supervisorProcess = Bun.spawn({
      cmd: [
        "/usr/bin/perl",
        "-e",
        OUTER_SETPGRP_PROGRAM,
        "bash",
        "-c",
        options.supervisorNeverConnect === true
          ? OUTER_NEVER_CONNECT_PROGRAM
          : OUTER_SUPERVISOR_PROGRAM,
        "s6-outer-supervisor",
        String(controlListener.port),
        "126",
        stdoutPath,
        stderrPath,
        ((options.controlReadyDelayMs ?? 0) / 1_000).toFixed(3),
        ((options.controlStartedDelayMs ?? 0) / 1_000).toFixed(3),
        ((options.controlAckDelayMs ?? 0) / 1_000).toFixed(3),
        options.extraRecordAfterKillAck === true ? "1" : "0",
        "bash",
        script,
        ...args,
      ],
      cwd: root,
      env: env as Record<string, string>,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    supervisorExited = supervisorProcess.exited;
    retirePreCapabilitySupervisor = async (cleanupDeadlineAt: number): Promise<void> => {
      if (capabilityEstablished || supervisorSettled) return;
      try {
        // Before authenticated READY no payload can have been forked. The
        // unreaped Bun subprocess handle is the only retirement authority; no
        // numeric pid or process-group value is ever exposed or reused.
        supervisorProcess.kill("SIGKILL");
      } catch {
        // Settlement below is authoritative. A dispatch error cannot green.
      }
      const remaining = Math.max(0, cleanupDeadlineAt - Date.now());
      const settled = await within(supervisorExited as Promise<number>, remaining);
      if (settled.kind === "elapsed") {
        throw new Error("cleanup unproven: pre-capability supervisor did not settle");
      }
      supervisorSettled = true;
    };
    const connection = await within(
      Promise.race([
        controlListener.connected.then((socket) => ({ kind: "connected" as const, socket })),
        supervisorExited.then((exitCode) => ({ kind: "exited" as const, exitCode })),
      ]),
      Math.min(OUTER_CONTROL_STEP_MS, Math.max(0, deadlineAt - Date.now())),
    );
    if (connection.kind === "elapsed") {
      throw new Error("cleanup unproven: outer supervisor did not connect at " + stdoutPath);
    }
    if (connection.value.kind === "exited") {
      supervisorSettled = true;
      throw new Error(
        "outer supervisor exited before capability connect: exit=" + connection.value.exitCode,
      );
    }
    if (controlListener.protocolFailure() !== undefined) {
      throw controlListener.protocolFailure();
    }
    if (options.afterControlAccept !== undefined) {
      const hook = await within(
        options.afterControlAccept(controlListener.port),
        controlStepRemaining(deadlineAt),
      );
      if (hook.kind === "elapsed") {
        throw new Error("cleanup unproven: post-accept capability hook timed out");
      }
    }
    // Keep accepting only through the test-only exact-one polarity above. In
    // production the first candidate is sealed before the nonce is minted, so
    // no queued/late connection can silently replace the authenticated socket.
    controlListener.seal();
    if (controlListener.protocolFailure() !== undefined) {
      throw controlListener.protocolFailure();
    }
    // Mint only after accept. The non-secret port is rendezvous, never authority.
    const supervisorToken = randomBytes(24).toString("hex");
    protocol = new OuterSupervisorProtocol(connection.value.socket, supervisorToken);
    if (!(await protocol.bootstrap(deadlineAt))) {
      throw new Error("cleanup unproven: outer supervisor BOOT/READY failed at " + stdoutPath);
    }
    capabilityEstablished = true;
    if (!(await protocol.start(deadlineAt))) {
      throw new Error("cleanup unproven: outer supervisor START/STARTED failed at " + stdoutPath);
    }
    const liveProtocol = protocol;
    // The parent's descriptors are held until the child has EXITED.
    //
    // Closing them immediately after `Bun.spawn` returned lost the child's output
    // entirely: some runs produced `stdout=0 stderr=0` while still exiting 0 or 78,
    // so every record assertion failed against empty captures and the exit code
    // looked correct. It is load-sensitive, which is why it surfaced on a loaded
    // machine first. Holding the descriptors costs nothing — these are regular
    // files read by size after exit, so no reader needs EOF.

    let timedOut = false;
    let escalationFired = false;
    const assertCapabilityIntegrity = (): void => {
      const failure = controlListener?.protocolFailure() ?? liveProtocol.protocolFailure();
      if (failure !== undefined) throw failure;
    };
    const settleSupervisorUntil = async (cleanupDeadlineAt: number): Promise<number | undefined> => {
      const remaining = Math.max(0, cleanupDeadlineAt - Date.now());
      const settled = await within(supervisorExited as Promise<number>, remaining);
      if (settled.kind === "elapsed") return undefined;
      supervisorSettled = true;
      return settled.value;
    };
    const requireNaturalCapabilityCloseUntil = async (
      cleanupDeadlineAt: number,
    ): Promise<void> => {
      const remaining = Math.max(0, cleanupDeadlineAt - Date.now());
      const closed = await within(liveProtocol.closed, remaining);
      if (closed.kind === "elapsed") {
        throw new Error("cleanup unproven: supervisor capability did not close naturally");
      }
      // TCP delivers data before close. This recheck therefore covers every
      // late/duplicate frame emitted before supervisor departure.
      assertCapabilityIntegrity();
    };

    if (options.armAfterFileExists !== undefined) {
      const ready = (): boolean => {
        try {
          return statSync(options.armAfterFileExists as string).isFile();
        } catch {
          return false;
        }
      };
      let polling = true;
      const readiness = (async (): Promise<boolean> => {
        const readinessDeadline = Date.now() + 5_000;
        while (polling && !ready() && Date.now() < readinessDeadline) {
          await Bun.sleep(10);
        }
        return ready();
      })();
      const readinessRace = await Promise.race([
        readiness.then((isReady) => ({ kind: "ready" as const, isReady })),
        liveProtocol.terminal.then((terminal) => ({ kind: "terminal" as const, terminal })),
        supervisorExited.then((exitCode) => ({ kind: "supervisor-exit" as const, exitCode })),
      ]);
      polling = false;
      if (readinessRace.kind === "terminal") {
        if (readinessRace.terminal.kind === "protocol-failure") {
          throw readinessRace.terminal.error;
        }
        // The payload is already terminal. DIE retires only the still-live
        // supervisor through its capability and emits no TERM/KILL command.
        const cleanupDeadlineAt = beginTeardownBudget(
          options.postKillSettleMs ?? POST_KILL_SETTLE_MS,
        );
        if (!(await liveProtocol.die(cleanupDeadlineAt))) {
          throw new Error("cleanup unproven: early terminal supervisor retirement failed");
        }
        if ((await settleSupervisorUntil(cleanupDeadlineAt)) === undefined) {
          throw new Error("cleanup unproven: early terminal supervisor did not settle");
        }
        await requireNaturalCapabilityCloseUntil(cleanupDeadlineAt);
        throw new Error(
          "deadline plant exited before readiness: exit=" + readinessRace.terminal.status,
        );
      }
      if (readinessRace.kind === "supervisor-exit") {
        supervisorSettled = true;
        throw new Error(
          "outer supervisor exited before readiness: exit=" + readinessRace.exitCode,
        );
      }
      if (!readinessRace.isReady) {
        const cleanupDeadlineAt = beginTeardownBudget(
          options.postKillSettleMs ?? POST_KILL_SETTLE_MS,
        );
        if (
          !(await liveProtocol.signal(
            "KILL",
            cleanupDeadlineAt,
            options.failKillDispatch === true,
            options.onControlSignal,
          ))
        ) {
          throw new Error("cleanup unproven: readiness supervisor KILL command failed");
        }
        if ((await settleSupervisorUntil(cleanupDeadlineAt)) === undefined) {
          throw new Error("cleanup unproven: readiness KILLed supervisor did not settle");
        }
        await requireNaturalCapabilityCloseUntil(cleanupDeadlineAt);
        throw new Error("deadline plant never reached readiness barrier: " + stdoutPath);
      }
      // Test-only barrier semantics: its short deadline starts at causal target
      // readiness. Production has no barrier and retains the exact spawn-time
      // 100-second deadline.
      deadlineAt = Date.now() + runTimeoutMs;
    }

    const deadline = new Promise<{ readonly kind: "deadline" }>((resolveDeadline) => {
      deadlineTimer = setTimeout(() => {
        // The callback only latches authority. One sequential owner below sends
        // TERM/KILL over the live socket after the race resolves.
        timedOut = true;
        resolveDeadline({ kind: "deadline" });
      }, Math.max(0, deadlineAt - Date.now()));
    });
    const first = await Promise.race([
      liveProtocol.terminal.then((terminal) => ({ kind: "terminal" as const, terminal })),
      supervisorExited.then((exitCode) => ({ kind: "supervisor-exit" as const, exitCode })),
      deadline,
    ]);

    let exitCode: number;
    if (first.kind === "terminal") {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      if (first.terminal.kind === "protocol-failure") throw first.terminal.error;
      exitCode = first.terminal.status;
      const cleanupDeadlineAt = beginTeardownBudget(
        options.postKillSettleMs ?? POST_KILL_SETTLE_MS,
      );
      // The payload is terminal but may have left same-group descendants. The
      // still-live authenticated supervisor performs one group self-KILL.
      if (
        !(await liveProtocol.signal(
          "KILL",
          cleanupDeadlineAt,
          options.failKillDispatch === true,
          options.onControlSignal,
        ))
      ) {
        throw new Error("cleanup unproven: terminal supervisor KILL command failed");
      }
      if ((await settleSupervisorUntil(cleanupDeadlineAt)) === undefined) {
        throw new Error("cleanup unproven: terminal KILLed supervisor did not settle");
      }
      await requireNaturalCapabilityCloseUntil(cleanupDeadlineAt);
    } else if (first.kind === "supervisor-exit") {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      supervisorSettled = true;
      throw new Error("cleanup unproven: supervisor exited before CHILD");
    } else {
      const killGraceMs = options.killGraceMs ?? 2_000;
      const cleanupDeadlineAt = beginTeardownBudget(
        killGraceMs + (options.postKillSettleMs ?? POST_KILL_SETTLE_MS),
      );
      const termGraceDeadlineAt = Math.min(cleanupDeadlineAt, Date.now() + killGraceMs);
      if (
        !(await liveProtocol.signal(
          "TERM",
          cleanupDeadlineAt,
          false,
          options.onControlSignal,
        ))
      ) {
        throw new Error("cleanup unproven: supervisor TERM command failed");
      }
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<{ readonly kind: "grace" }>((resolveGrace) => {
        graceTimer = setTimeout(
          () => resolveGrace({ kind: "grace" }),
          Math.max(0, termGraceDeadlineAt - Date.now()),
        );
      });
      const afterTerm = await Promise.race([
        liveProtocol.terminal.then((terminal) => ({ kind: "terminal" as const, terminal })),
        supervisorExited.then((exitCode) => ({ kind: "supervisor-exit" as const, exitCode })),
        grace,
      ]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (afterTerm.kind === "terminal") {
        if (afterTerm.terminal.kind === "protocol-failure") throw afterTerm.terminal.error;
        exitCode = afterTerm.terminal.status;
      } else if (afterTerm.kind === "supervisor-exit") {
        supervisorSettled = true;
        throw new Error("cleanup unproven: supervisor exited during TERM grace");
      } else {
        escalationFired = true;
        exitCode = -1;
      }

      if (
        !(await liveProtocol.signal(
          "KILL",
          cleanupDeadlineAt,
          options.failKillDispatch === true,
          options.onControlSignal,
        ))
      ) {
        throw new Error("cleanup unproven: supervisor KILL command failed");
      }
      const killedExit = await settleSupervisorUntil(cleanupDeadlineAt);
      if (killedExit === undefined) {
        throw new Error("cleanup unproven: KILLed supervisor did not settle");
      }
      await requireNaturalCapabilityCloseUntil(cleanupDeadlineAt);
      if (exitCode === -1) exitCode = killedExit;
    }

    if (options.probeLateSecondConnection === true) {
      const lateSocket = createConnection({ host: "127.0.0.1", port: controlListener.port });
      const lateClosed = new Promise<void>((resolveClosed) => {
        lateSocket.once("close", () => resolveClosed());
      });
      const lateOutcome = new Promise<"connected" | "refused">((resolveLate) => {
        lateSocket.once("connect", () => resolveLate("connected"));
        lateSocket.once("error", () => resolveLate("refused"));
      });
      const lateBudget = Math.max(0, (teardownDeadlineAt ?? Date.now()) - Date.now());
      const late = await within(lateOutcome, lateBudget);
      lateSocket.destroy();
      const lateClose = await within(
        lateClosed,
        Math.max(0, (teardownDeadlineAt ?? Date.now()) - Date.now()),
      );
      if (lateClose.kind === "elapsed") {
        throw new Error("cleanup unproven: late capability socket did not close");
      }
      if (late.kind === "elapsed") {
        throw new Error("cleanup unproven: late capability connection did not settle");
      }
      if (late.value === "connected") {
        throw new Error("outer supervisor capability accepted a late second connection");
      }
    }

    // Only after bounded supervisor settlement and an intact exactly-one
    // capability transcript are the original held capture inodes read. Paths
    // are retained diagnostics, never post-target authority.
    assertCapabilityIntegrity();
    const stdout = readBounded(stdoutFd, stdoutPath, stdoutCaptureIdentity);
    const stderr = readBounded(stderrFd, stderrPath, stderrCaptureIdentity);
    releaseCaptureFds();

    // A run we had to hard-kill cannot claim its nested groups were reaped: the
    // script's trap was cut short, and this controller cannot see those groups.
    // An in-budget script refusal is equally unproven and is derived from exact
    // typed NDJSON plus the reserved exit 125, never a broad substring. No pgid
    // ledger is kept: bare pgids are not identity.
    const shellLifecycle = shellLifecycleFromRecords(stdout, exitCode);
    const cleanupUnproven = timedOut || shellLifecycle.cleanupUnproven;

    // Any outer timeout remains cleanup-unproven. An in-budget run takes its
    // nested survivor verdict only from the shell's exact typed terminal.
    const survivors = timedOut || shellLifecycle.survivors;

    // AN EMPTY CAPTURE CAN NEVER PASS FOR A SUCCESSFUL RUN.
    //
    // This script always emits at least one NDJSON record on any path it can exit
    // 0 or 78 from. If the capture is empty on such an exit, the transport lost the
    // output and no assertion below it means anything — so this throws rather than
    // letting record assertions fail one by one against "". A future capture
    // regression cannot be mistaken for a content failure.
    if (stdout.length === 0 && (exitCode === 0 || exitCode === 78)) {
      throw new Error(
        `capture lost: exit=${exitCode} produced an empty stdout at ${stdoutPath}. ` +
          `The script emits a record on every such path, so this is a transport fault, not a content failure.`,
      );
    }

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      survivors,
      cleanupUnproven,
      escalationFired,
    };
  } finally {
    let teardownFailure: Error | undefined;
    const cleanupDeadlineAt = beginTeardownBudget(
      options.postKillSettleMs ?? POST_KILL_SETTLE_MS,
    );
    const noteTeardownFailure = (error: unknown, fallback: string): void => {
      teardownFailure ??= error instanceof Error ? error : new Error(fallback);
    };
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    protocol?.expectClosure();
    let listenerClosing: Promise<void> | undefined;
    if (controlListener !== undefined) {
      try {
        // Calling close synchronously revokes new accepts before a
        // pre-capability helper is retired below. Awaiting it is deliberately
        // deferred so socket closure cannot consume the retirement budget.
        listenerClosing = controlListener.close();
      } catch (error) {
        noteTeardownFailure(error, "cleanup unproven: control listener/socket close failed");
      }
    }
    if (!capabilityEstablished && retirePreCapabilitySupervisor !== undefined) {
      try {
        await retirePreCapabilitySupervisor(cleanupDeadlineAt);
      } catch (error) {
        noteTeardownFailure(error, "cleanup unproven: pre-capability retirement failed");
      }
    }
    if (listenerClosing !== undefined) {
      try {
        const closeRemaining = Math.max(0, cleanupDeadlineAt - Date.now());
        const closed = await within(listenerClosing, closeRemaining);
        if (closed.kind === "elapsed") {
          noteTeardownFailure(
            new Error("cleanup unproven: control listener/socket did not close"),
            "control listener/socket did not close",
          );
        }
      } catch (error) {
        noteTeardownFailure(error, "cleanup unproven: control listener/socket close failed");
      }
    }
    const lateProtocolFailure =
      controlListener?.protocolFailure() ?? protocol?.protocolFailure();
    if (lateProtocolFailure !== undefined) {
      noteTeardownFailure(lateProtocolFailure, "outer supervisor protocol failed during close");
    }
    if (supervisorExited !== undefined && !supervisorSettled) {
      try {
        const settleRemaining = Math.max(0, cleanupDeadlineAt - Date.now());
        const settled = await within(supervisorExited, settleRemaining);
        if (settled.kind === "elapsed") {
          noteTeardownFailure(
            new Error("cleanup unproven: supervisor did not settle after revoke"),
            "supervisor did not settle after revoke",
          );
        } else {
          supervisorSettled = true;
        }
      } catch (error) {
        noteTeardownFailure(error, "cleanup unproven: supervisor settlement failed");
      }
    }
    const postSettlementProtocolFailure =
      controlListener?.protocolFailure() ?? protocol?.protocolFailure();
    if (postSettlementProtocolFailure !== undefined) {
      noteTeardownFailure(
        postSettlementProtocolFailure,
        "outer supervisor protocol failed after settlement",
      );
    }
    try {
      releaseCaptureFds();
    } catch (error) {
      noteTeardownFailure(error, "capture descriptor release failed");
    }
    if (teardownFailure !== undefined) throw teardownFailure;
  }
}

/** Failure context. stderr appears here and nowhere else. */
function diag(run: ShellRun): string {
  const tail = run.stderr.slice(-2_000);
  return `exit=${run.exitCode} timedOut=${run.timedOut} survivors=${run.survivors} stderr(tail)=${tail}`;
}

/**
 * The shell's `--self-test` is executed ONCE and shared.
 *
 * Its causal plants sleep on real timers, so re-running it per assertion pushed
 * the suite past its own timeout. One run, many assertions against the same
 * recorded output, keeps every claim causal without paying for it repeatedly.
 */
let selfTestRun: Promise<ShellRun> | undefined;
function sharedSelfTest(): Promise<ShellRun> {
  // The ambient S6 variables are REMOVED and explicit canaries planted in their
  // place. Passing `process.env` meant that on an ordinary machine — where the
  // real variables are absent — `export -n` could be deleted and the held-helper
  // plant would still see a clean environ. With canaries planted, that line is
  // the only reason the helper cannot read them.
  //
  // The real operator secrets are never passed into the test.
  selfTestRun ??= runShell(["--self-test"], {
    ...withoutS6Env(),
    ASIMP_S6_TEST_GOOGLE_PASS: "planted-selftest-pass-0123456789",
    ASIMP_S6_TEST_GOOGLE_USER: "planted-selftest-user@example.com",
    ASIMP_S6_FELLOW_TOKEN: "planted-selftest-bearer-0123456789",
    ASIMP_S6_SIGNING_KEY_HEX: "planted-selftest-key-0123456789",
  });
  return selfTestRun;
}

/** A process environment with every S-6 variable removed. */
function withoutS6Env(): Record<string, string | undefined> {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ASIMP_S6_")) delete environment[key];
  }
  return environment;
}

describe("the spike is executable and registered", () => {
  test("the script is executable", () => {
    expect(statSync(resolve(root, SCRIPT)).mode & 0o111).toBeGreaterThan(0);
  });

  test("the G0 manifest still points at this script", () => {
    expect(code("scripts/suite/g0-spikes.ts")).toContain(SCRIPT);
  });

  test("the browser leg exists and the script requires it", () => {
    expect(statSync(resolve(root, RUNNER)).isFile()).toBe(true);
    expect(shellFunction(code(SCRIPT), "run_browser_leg")).toContain("BROWSER_RUNNER_MISSING");
  });
});

describe("the cookie claim is live, not an artifact", () => {
  const runner = read(RUNNER);

  test("the runner matches the EXACT configured cookie name", () => {
    // `apps/web/auth.ts` overrides the Auth.js default. Matching the framework
    // name finds nothing and silently proves nothing — the defect that sank the
    // previous revision.
    expect(read("apps/web/auth.ts")).toContain('name: "asimp.session"');
    expect(runner).toContain('SESSION_COOKIE_NAME = "asimp.session"');
    expect(runner).not.toContain('authjs.session-token";');
  });

  test("host-only is decided from the Set-Cookie header, not from a jar", () => {
    const parser = runner.slice(runner.indexOf("function parseSetCookie"));
    expect(parser).toContain('a.startsWith("domain=")');
  });

  test("there is no storage-state fallback for the cookie claim", () => {
    // A storage-state file is the product of a login that already happened and
    // cannot testify to what the origin sent.
    expect(runner).not.toContain("storageState");
    expect(runner).toContain("CONFIG_ABSENT");
  });

  test("the Google credentials are actually used", () => {
    // The account now arrives on stdin, so the runner names the fields and the
    // shell is what supplies them.
    expect(runner).toContain('typeof parsed.user === "string"');
    expect(runner).toContain('typeof parsed.password === "string"');
    expect(runner).toContain('input[type="password"]');
    expect(shellFunction(code(SCRIPT), "run_browser_leg")).toContain("ASIMP_S6_TEST_GOOGLE_PASS");
  });

  test("a Google challenge is blocked, never passed or failed silently", () => {
    expect(runner).toContain("GOOGLE_LOGIN_CHALLENGED");
    expect(runner).toContain("BLOCKED_EXIT");
  });
});

describe("exactly two WRONG_PRINCIPAL legs, each exact", () => {
  const source = code(SCRIPT);

  test("the bearer leg requires exactly 403 WRONG_PRINCIPAL", () => {
    const leg = shellFunction(source, "assert_bearer_on_sponsor_route_refused");
    expect(leg).toContain('"$status" == "403"');
    expect(leg).toContain('"$code" == "WRONG_PRINCIPAL"');
  });

  test("the agent-host leg requires exactly 403 WRONG_PRINCIPAL", () => {
    // The browser measures it; the shell asserts the exact pair.
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain('"cookie_probe":{"status":403,"code":"WRONG_PRINCIPAL"}');
  });

  test("the evidence does not claim a cookie was presented to the agent host", () => {
    // A host-only apex cookie is never attached to an agent-host request, so
    // nothing is presented and nothing is refused. Saying otherwise would
    // describe a weaker world than the one proved — one where the cookie
    // reached `a.` and was merely rejected there.
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain("cookie-not-sent-to-agent-host");
    expect(leg).toContain("was not sent to the agent host");
    expect(leg).not.toContain("cookie on ${ROUTE_PROPOSALS} was refused");
    expect(read(RUNNER)).not.toContain("the live cookie was refused");
  });

  test("no leg accepts an arbitrary non-2xx, a curl 000, a 404 or a 5xx", () => {
    // The rejected revision passed the cookie direction on any non-2xx, so a
    // dead Worker (curl 000) read as a security proof.
    expect(source).not.toContain("=~ ^2");
    for (const leg of ["assert_bearer_on_sponsor_route_refused", "assert_cookie_changed_nothing"]) {
      const body = shellFunction(source, leg);
      expect(body).not.toMatch(/!=\s*"?2/);
      expect(body).toContain("403");
    }
  });

  test("a sessionless differential pins the agent-host answer", () => {
    const control = shellFunction(source, "assert_cookie_changed_nothing");
    // The browser's agent-host request carried no cookie; this issues the same
    // request from a client with no session and requires the identical answer,
    // so holding an apex session is shown to buy nothing on `a.`.
    expect(control).toContain('http_request GET "${worker}${ROUTE_PROPOSALS}" "" ""');
    expect(control).toContain("no-credential-differential");
    expect(control).toContain("WRONG_PRINCIPAL");
  });

  test("there are exactly two WRONG_PRINCIPAL legs", () => {
    const names = [...source.matchAll(/(?:pass|fail)_record "([a-z-]+)"/g)].map((m) => m[1]);
    const legs = names.filter(
      (n) => n === "bearer-on-sponsor-route-refused" || n === "cookie-not-sent-to-agent-host",
    );
    expect(new Set(legs).size).toBe(2);
  });
});

describe("each opaque 401 is tied to its own function", () => {
  const source = code(SCRIPT);

  // Rule A5: replay, tamper and expiry share one opaque face. Each assertion
  // must carry its own check rather than inheriting one from a sibling.
  for (const fn of [
    "assert_replay_refused",
    "assert_altered_payload_refused",
    "assert_expired_envelope_refused",
  ]) {
    test(`${fn} checks 401 UNAUTHORIZED itself`, () => {
      const body = shellFunction(source, fn);
      expect(body).toContain('"$status" == "401"');
      expect(body).toContain('"$code" == "UNAUTHORIZED"');
    });
  }

  test("no per-mode envelope code is asserted anywhere", () => {
    for (const leaky of ["NONCE_REPLAYED", "BAD_SIGNATURE", "ENVELOPE_EXPIRED", "PAYLOAD_DIGEST"]) {
      expect(source).not.toContain(leaky);
    }
  });

  test("the tamper case posts to a route that is mounted for POST", () => {
    const body = shellFunction(source, "assert_altered_payload_refused");
    expect(body).toContain("$ROUTE_MINT");
    expect(source).toContain('ROUTE_MINT="/v1/enrollments"');
    // A POST to a GET-only route is refused by routing before the verifier
    // runs, so it would prove nothing about tamper detection.
    expect(code("apps/wire/src/enrollment/router.ts")).toContain('app.post("/v1/enrollments"');
    expect(body).not.toContain("$ROUTE_PROPOSALS");
  });
});

describe("credentials never enter argv or a child environment", () => {
  const source = code(SCRIPT);

  test("curl receives credential headers on stdin, not as arguments", () => {
    const http = shellFunction(source, "http_request");
    expect(http).toContain("--config -");
    expect(http).not.toContain("--header");
  });

  test("the bearer is passed as a config document", () => {
    const leg = shellFunction(source, "assert_bearer_on_sponsor_route_refused");
    expect(leg).toContain('header = \\"authorization: Bearer');
    // It must be an argument to http_request's config parameter, never a curl flag.
    expect(leg).not.toContain("--header");
  });

  test("the child environment is scrubbed", () => {
    expect(shellFunction(source, "http_request")).toContain("minimal_env_command");
    expect(shellFunction(source, "minimal_env_command")).toContain("env -i");
  });

  test("the live cookie value never leaves the browser", () => {
    const runner = read(RUNNER);
    expect(runner).toContain("context.request.get");
    // Exporting the jar to the shell would put a live human session in an argv.
    expect(runner).not.toContain("cookie.value");
    expect(source).not.toContain("ASIMP_S6_STORAGE_STATE");
  });

  test("no shell request follows a redirect", () => {
    const http = shellFunction(source, "http_request");
    expect(http).not.toContain("--location");
    expect(http).not.toContain(" -L ");
  });

  test("the browser probe refuses redirects and pins the final origin", () => {
    // A 3xx to the apex would move the probe onto the plane that DOES consult
    // cookies; a 403 collected there would silently invalidate both the
    // host-only and the non-consultation claims. Absence of `curl -L` in the
    // shell says nothing about this — the probe is made by Playwright.
    const runner = read(RUNNER);
    const probe = runner.slice(runner.indexOf("const probeUrl ="));
    expect(probe).toContain("maxRedirects: 0");
    expect(probe).toContain("AGENT_HOST_PROBE_REDIRECTED");
    expect(probe).toContain("finalUrl.host !== expectedUrl.host");
    expect(probe).toContain("finalUrl.pathname !== expectedUrl.pathname");
    // The origin check must precede accepting the 403.
    expect(probe.indexOf("AGENT_HOST_PROBE_REDIRECTED")).toBeLessThan(
      probe.indexOf('cookieProbe.code !== "WRONG_PRINCIPAL"'),
    );
  });
});

describe("the leak canary scans every secret, including short ones", () => {
  const canary = shellFunction(code(SCRIPT), "assert_no_secret_escaped");

  test("no value is skipped for being short", () => {
    // The rejected revision did `[[ ${#value} -ge 16 ]] || continue`, which
    // silently declined to scan exactly the values easiest to leak.
    //
    // The only permitted skip is for an UNSET variable, which has nothing to
    // scan for. So: no length test may reach a `continue`, and the single
    // `continue` in the function must be the empty-value one.
    expect(canary).not.toMatch(/\$\{#value\}[\s\S]{0,80}?continue/);
    // Scoped to the declared-secrets loop: the signature loop below it has its
    // own empty-value guard, so a whole-function count would drift.
    const secretLoop = canary.slice(
      canary.indexOf('for name in "${SECRET_VARS[@]}"'),
      canary.indexOf("for signature in "),
    );
    const continues = [...secretLoop.matchAll(/\bcontinue\b/g)];
    expect(continues.length).toBe(1);
    expect(canary).toContain('[[ -n "$value" ]] || continue');
    // A short value is reported as a weak canary and still scanned.
    expect(canary).toContain("secret-canary-weak");
    const lengthBranch = canary.slice(canary.indexOf("${#value} < 16"));
    expect(lengthBranch).toContain("scan_regular_files_for");
  });

  test("it scans regular files only, with a fixed string", () => {
    expect(canary).toContain("scan_regular_files_for");
    const scanner = shellFunction(code(SCRIPT), "scan_regular_files_for");
    expect(scanner).toContain('"$SCAN_GREP" -qFf -');
    // A recursive grep would open the envelope FIFO and block forever once its
    // writers closed, hanging the run on its own secure transport.
    expect(scanner).toContain("-type f");
    // `xargs -r` still exits 0 on empty input on macOS, so an empty directory
    // was reported as a hit.
    expect(scanner).not.toContain("xargs");
  });

  test("every declared secret is named in the never-log list", () => {
    const list = code(SCRIPT).slice(
      code(SCRIPT).indexOf("SECRET_VARS=("),
      code(SCRIPT).indexOf(")", code(SCRIPT).indexOf("SECRET_VARS=(")),
    );
    for (const name of [
      "ASIMP_S6_TEST_GOOGLE_PASS",
      "ASIMP_S6_FELLOW_TOKEN",
      "ASIMP_S6_SIGNING_KEY_HEX",
    ]) {
      expect(list).toContain(name);
    }
  });
});

describe("the receipt is structured, bound, and matched as a fixed string", () => {
  const source = code(SCRIPT);

  test("it is not taken from an unrestricted environment variable", () => {
    // ASIMP_S6_WRITE_RECEIPT was an unbound, unvalidated operator input.
    expect(source).not.toContain("ASIMP_S6_WRITE_RECEIPT");
  });

  test("only a structured receipt proven absent before the action is accepted", () => {
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain('"absent_before_action":true');
    expect(leg).toContain("ASIMP-EN-[0-9A-HJKMNP-TV-Z]\\{26\\}");
  });

  test("attribution matching is fixed-string, never a regex", () => {
    const leg = shellFunction(source, "assert_receipt_attributed");
    expect(leg).toContain("grep -qF");
    expect(leg).not.toMatch(/grep -q[^F]/);
  });

  test("the runner proves the id was absent before the click", () => {
    const runner = read(RUNNER);
    expect(runner).toContain("beforeIds");
    expect(runner).toContain("!beforeIds.has(id)");
  });

  test("edge request id is request correlation, not a deployment claim", () => {
    const runner = read(RUNNER);
    expect(runner).toContain("edgeRequestId");
    expect(runner).toContain('headers()["x-vercel-id"]');
    // `x-vercel-id` identifies one request through one edge. Calling it
    // immutable deployment evidence overclaimed, and folding
    // `x-vercel-deployment-url` into the same field mixed two identities.
    // The bans target USAGE: the comment records why the header is refused.
    expect(runner).not.toContain('headers()["x-vercel-deployment-url"]');
    expect(runner).not.toMatch(/let deployment\b/);
    expect(runner).not.toMatch(/readonly deployment:/);
  });

  test("the runner emits its pass record only after cleanup", () => {
    const runner = read(RUNNER);
    // Emitting inside `try` published a success before `finally` closed the
    // browser, so a teardown failure could follow an already published pass.
    expect(runner).toContain("return {");
    expect(runner).toContain("record: await main()");
    expect(runner).toContain("RUNNER_TEARDOWN_FAILED");
    expect(runner).toContain("teardownFailed");
    const tail = runner.slice(runner.indexOf("async function runEntrypoint()"));
    const select = tail.indexOf(
      "resolveTerminalOutcome(outcome, teardownFailed, deadlineExceeded)",
    );
    const emitTerminal = tail.indexOf("emit(terminal.record)");
    // Both positions must exist before order is compared. The former test
    // searched for `teardownFailed > 0` while production used `!== 0`; -1 was
    // therefore less than the emit index and the assertion passed vacuously.
    expect(select).toBeGreaterThanOrEqual(0);
    expect(emitTerminal).toBeGreaterThanOrEqual(0);
    expect(select).toBeLessThan(emitTerminal);
  });

  test("PLANTED: teardown failure supersedes a preexisting blocked RunnerExit", () => {
    // The causal execution lives in the shell self-test, as a separate runner
    // process. Importing/spawning Bun directly inside Bun's test process
    // perturbs nested capture descriptors on the affected runtime.
    const runner = read(RUNNER);
    expect(runner).toContain("async function terminalSelectorSelfTest()");
    expect(runner).toContain("resolveTerminalOutcome(blockedOutcome, 1)");
    expect(runner).toContain("resolveTerminalOutcome(blockedOutcome, 0)");
    expect(runner).toContain("resolveTerminalOutcome(passOutcome, 0, deadlineExceeded)");
    expect(runner).toContain('assertion: "blocked-runner-teardown-failure-overrides"');
    expect(runner).toContain('assertion: "runner-deadline-race-overrides-pass"');
  });

  test("neither reader spins on EAGAIN", () => {
    // An immediate EAGAIN retry is an unbounded CPU spin, and the runner's
    // deadline is not armed until after the read loop.
    for (const source of [read(RUNNER), code(SCRIPT)]) {
      expect(source).not.toMatch(/EAGAIN"\)? continue/);
      expect(source).toContain('=== "EINTR") continue');
      expect(source).toContain("EAGAIN");
    }
  });
});

describe("the run is bounded and leaves no survivors", () => {
  const source = code(SCRIPT);

  test("secrets are de-exported at main's first built-in step", () => {
    // Until this runs, every ordinary mktemp/chmod/sleep/grep/find/stat helper
    // inherits the password, bearer and seed in its own environ.
    const main = source.slice(source.indexOf("main() {"));
    const deExport = main.indexOf("export -n ASIMP_S6_TEST_GOOGLE_PASS");
    expect(deExport).toBeGreaterThanOrEqual(0);
    // Before any mode dispatch or helper call.
    expect(deExport).toBeLessThan(main.indexOf("--self-test-signal-victim"));
    for (const name of [
      "ASIMP_S6_TEST_GOOGLE_PASS",
      "ASIMP_S6_TEST_GOOGLE_USER",
      "ASIMP_S6_FELLOW_TOKEN",
      "ASIMP_S6_SIGNING_KEY_HEX",
    ]) {
      expect(main).toContain(`export -n ${name}`);
    }
  });

  test("the leak scan never puts its needle in an argv", () => {
    const scanner = shellFunction(source, "scan_regular_files_for");
    // `grep -qF -- "$needle" file` published the secret in grep's command line
    // for the life of the process — by the canary meant to detect leaks.
    expect(scanner).not.toMatch(/grep -qF -- "\$needle"/);
    expect(scanner).toContain(`printf '%s' "$needle" | "$SCAN_GREP" -qFf -`);
  });

  test("every minted signature is retained and scanned", () => {
    const minter = shellFunction(source, "mint_envelope_config");
    expect(minter).toContain("MINTED_SIGNATURES+=");
    const canary = shellFunction(source, "assert_no_secret_escaped");
    expect(canary).toContain("MINTED_SIGNATURES");
    // MINTED_CONFIG is overwritten by the next mint, so scanning only it left
    // every earlier signature — each live until its nonce is consumed — unseen.
    expect(canary).toContain("minted envelope signature");
  });

  test("nothing is sealed while a child group survives", () => {
    // No scan, no evidence artifact, no verdict may be published with a
    // survivor outstanding.
    for (const marker of ["CLEANUP_UNPROVEN", "EX_CLEANUP_UNPROVEN"]) {
      expect(source).toContain(marker);
    }
    const finish = shellFunction(source, "finish");
    expect(finish.indexOf("reap_children")).toBeLessThan(
      finish.indexOf("assert_no_secret_escaped"),
    );
    expect(finish.indexOf("CLEANUP_UNPROVEN")).toBeLessThan(
      finish.indexOf("write_evidence_bundle"),
    );
  });

  test("anonymous supervisor authority exists before any payload fork", () => {
    const bounded = shellFunction(source, "run_bounded");
    const coprocess = bounded.indexOf("coproc S6_BOUNDED_SUPERVISOR");
    const payload = bounded.indexOf('exec {$ARGV[0]} @ARGV');
    expect(coprocess).toBeGreaterThanOrEqual(0);
    expect(payload).toBeGreaterThan(coprocess);
    expect(bounded).toContain('register_child "$pid" "$supervisor_token" "ordinary"');
    expect(bounded).toContain('prepare_group_control "$pid" "$supervisor_token"');
    expect(bounded).toContain('adopt_group_control "$pid" "$supervisor_token"');
    expect(bounded.indexOf("prepare_group_control")).toBeLessThan(
      bounded.indexOf("send_group_frame_until $'BOOT"),
    );
    expect(bounded.indexOf("send_group_frame_until $'BOOT")).toBeLessThan(
      bounded.indexOf("adopt_group_control"),
    );
    expect(bounded).not.toContain("result_fifo");
    expect(bounded).not.toContain("mkfifo");
  });

  test("one monotonic deadline is computed from a single start stamp", () => {
    expect(source).toContain("WORK_BUDGET_SECONDS=");
    expect(source).toContain("SCRIPT_CLEANUP_RESERVE_SECONDS=45");
    // Every child bound is clamped to what remains, so no phase can begin with
    // its full nominal bound when only the reserve is left.
    for (const fn of ["mint_envelope_config", "run_browser_leg", "http_request"]) {
      expect(shellFunction(source, fn)).toContain("phase_budget");
    }
  });

  test("EXIT, INT and TERM all reach cleanup", () => {
    expect(source).toContain("trap 'on_exit' EXIT");
    expect(source).toContain("trap 'on_signal INT' INT");
    expect(source).toContain("trap 'on_signal TERM' TERM");
  });

  test("children are TERMed, grace-drained, KILLed, then settled", () => {
    const reaper = shellFunction(source, "reap_children");
    const term = reaper.indexOf('request_group_signal "$pid" TERM');
    const grace = reaper.indexOf("consume_group_terminal_during_grace");
    const kill = reaper.indexOf('request_group_signal "$pid" KILL');
    const settled = reaper.indexOf('group_settled_before_wait "$pid"');
    expect(term).toBeGreaterThanOrEqual(0);
    expect(grace).toBeGreaterThan(term);
    expect(kill).toBeGreaterThan(grace);
    expect(settled).toBeGreaterThan(kill);
    expect(reaper).toContain("GROUP_ALLOW_CHILD_BEFORE_ACK=1");
    expect(reaper).toContain("verify_group_result_eof");
    // The verdict is a global, not a printed value, so callers cannot reap in
    // a subshell by capturing it.
    expect(reaper).toContain("REAP_SURVIVORS");
  });

  test("the browser and minter children are bounded", () => {
    expect(shellFunction(source, "run_browser_leg")).toContain("$BROWSER_TIMEOUT_SECONDS");
    expect(shellFunction(source, "mint_envelope_config")).toContain("$MINTER_TIMEOUT_SECONDS");
  });

  test("the bound is parent-latched and lifecycle commands use the live capability", () => {
    const bounded = shellFunction(source, "run_bounded");
    expect(bounded).toContain('read_group_outcome "$seconds"');
    expect(bounded).toContain("timed_out=1");
    expect(bounded).toContain("GROUP_ALLOW_CHILD_BEFORE_ACK=1");
    expect(bounded).toContain('request_group_signal "$pid" TERM');
    expect(bounded).toContain("consume_group_terminal_during_grace");
    expect(bounded).toContain('request_group_signal "$pid" KILL');
    expect(bounded).toContain("verify_group_result_eof");
    expect(bounded).not.toContain("date +%s");
    expect(bounded).not.toContain("limit=$((seconds * 10))");
    expect(bounded).toContain("EX_WATCHDOG_UNAVAILABLE");
    expect(bounded).toContain("EX_CLEANUP_UNPROVEN");
    const waitSupervisor = bounded.lastIndexOf('wait "$pid"');
    const cleanupRefusal = bounded.indexOf(
      '(( cleanup_unproven == 0 )) || return "$EX_CLEANUP_UNPROVEN"',
    );
    expect(cleanupRefusal).toBeGreaterThanOrEqual(0);
    expect(cleanupRefusal).toBeLessThan(waitSupervisor);
    expect(bounded.slice(waitSupervisor)).toContain('unregister_child "$pid"');
    const reaper = shellFunction(source, "reap_children");
    expect(reaper).toContain("REAP_SURVIVORS=1");
    expect(reaper).toContain("continue");
  });

  test("every controlled wait is gated by settlement and exact result EOF", () => {
    const settlement = shellFunction(source, "group_settled_before_wait");
    expect(settlement).toContain('kill -0 -- "-${pid}"');
    // A partial process-list snapshot is not authority to enter a blocking
    // wait, even when the command exits zero or reports only a zombie row.
    expect(settlement).not.toContain("/bin/ps");

    const ordered = (body: string, settlementNeedle: string, waitNeedle: string): void => {
      const settled = body.indexOf(settlementNeedle);
      const waited = body.indexOf(waitNeedle, settled + settlementNeedle.length);
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(waited).toBeGreaterThan(settled);
    };
    ordered(
      shellFunction(source, "reap_children"),
      'group_settled_before_wait "$pid"',
      'wait "$pid"',
    );
    const bounded = shellFunction(source, "run_bounded");
    ordered(bounded, 'group_settled_before_wait "$pid"', 'wait "$pid"');
    expect(bounded).toContain("settle_provisional_owner_from_result");
    const provisional = shellFunction(source, "settle_provisional_owner_from_result");
    expect(provisional).toContain('read -r -t "$remaining" record <&5');
    expect(provisional.indexOf('direct_child_settled_before_wait "$pid"')).toBeLessThan(
      provisional.indexOf('wait "$pid"'),
    );
    expect(bounded).toContain("verify_group_result_eof");
  });

  test("lifecycle signalling is capability-only", () => {
    const signal = shellFunction(source, "request_group_signal");
    expect(signal).toContain("printf 'SIGNAL\\t%s\\t%s\\n'");
    expect(signal).toContain('read_group_record "$expected"');
    expect(signal).not.toMatch(/kill\s+[^0]/);
    const bounded = shellFunction(source, "run_bounded");
    expect(bounded).not.toMatch(/kill -(TERM|KILL) "\$pid"/);
    expect(bounded).toContain("kill -TERM 0");
    expect(bounded).toContain("kill -KILL 0");
    expect(bounded).not.toContain("result_fifo");
  });

  test("cleanup reaches descendants, not only the direct child", () => {
    expect(source).toContain("set -m");
    const bounded = shellFunction(source, "run_bounded");
    expect(bounded).toContain("kill -TERM 0");
    expect(bounded).toContain("kill -KILL 0");
    expect(bounded).toContain('request_group_signal "$pid"');
  });

  test("pid ownership is registered in the parent shell, not a subshell", () => {
    // `out="$(run_bounded ...)"` runs the whole call in a subshell, so
    // `CHILD_PIDS+=` mutates a copy that dies with it and the EXIT trap holds
    // no pid and no pgid. Both real call sites must therefore write to a file.
    for (const fn of ["mint_envelope_config", "run_browser_leg", "http_request"]) {
      const body = shellFunction(source, fn);
      expect(body).not.toMatch(/\$\(\s*run_bounded/);
      expect(body).toContain("run_bounded ");
    }
    // These helpers must also not be CALLED inside a command substitution, or
    // the registration dies one level up instead.
    expect(source).not.toMatch(/=\s*"\$\(mint_envelope_config/);
    expect(source).not.toMatch(/=\s*"\$\(http_request/);
  });

  test("the reaper does not return its verdict through a subshell", () => {
    // `survivors="$(reap_children)"` would run every `wait` in a subshell, so
    // the parent would never actually reap the children it owns.
    expect(source).not.toContain('"$(reap_children)"');
    expect(source).toContain("REAP_SURVIVORS");
    expect(shellFunction(source, "on_exit")).toContain("reap_children");
    expect(shellFunction(source, "on_exit")).toContain("REAP_SURVIVORS");
  });

  test("the group is swept on ordinary and failing child exits too", () => {
    // A child can exit cleanly and still leave Chromium behind; waiting on the
    // direct pid alone would call that success.
    const bounded = shellFunction(source, "run_bounded");
    const term = bounded.lastIndexOf('request_group_signal "$pid" TERM');
    const kill = bounded.lastIndexOf('request_group_signal "$pid" KILL');
    const reap = bounded.lastIndexOf('wait "$pid"');
    expect(term).toBeGreaterThanOrEqual(0);
    expect(kill).toBeGreaterThan(term);
    expect(reap).toBeGreaterThan(kill);
    const afterReap = bounded.slice(reap);
    expect(afterReap).not.toContain('request_group_signal "$pid"');
    expect(afterReap).not.toContain('kill -0 -- "-${pid}"');
  });
});

describe("the runner record and the shell parser cannot drift apart", () => {
  const runner = read(RUNNER);
  const shell = code(SCRIPT);

  /** Field names the runner declares on its NDJSON record. */
  const declared = [
    ...runner
      .slice(runner.indexOf("interface Record_ {"), runner.indexOf("const startedAt"))
      .matchAll(/^\s+readonly ([a-z_]+)[?:]/gm),
  ].map((m) => m[1] as string);

  test("the runner declares the fields the shell reads", () => {
    // Renaming `deployment` to `edge_request_id` in the runner left the shell
    // parsing a field that no longer existed, so every otherwise-green live run
    // failed on it. Neither file was wrong alone, which is why only a contract
    // spanning both can catch it.
    expect(declared).toContain("edge_request_id");
    expect(declared).toContain("cookie_probe");
    expect(declared).toContain("receipt");
    expect(declared).not.toContain("deployment");
  });

  test("every field the shell parses out of the record is declared", () => {
    const parsed = [...shell.matchAll(/"([a-z_]+)":\\"/g)].map((m) => m[1] as string);
    const knownNonRecord = new Set(["suite", "status", "code", "detail", "assertion", "reproduce"]);
    for (const field of parsed) {
      if (knownNonRecord.has(field)) continue;
      expect(declared, `shell parses "${field}" but the runner does not declare it`).toContain(
        field,
      );
    }
  });

  test("the shell no longer claims a deployment pin", () => {
    expect(shell).not.toContain('"deployment"');
    expect(shell).not.toContain("deployment-identified");
    expect(shell).toContain("edge_request_id");
    // Wording bans: nothing may describe this as immutable or pinned.
    expect(shell).not.toMatch(/immutable deployment/i);
    expect(shell).not.toMatch(/pinned to deployment/i);
  });

  test("edge correlation is not an S6 gate", () => {
    // Fable S-6 does not require `x-vercel-id`, and the runner types the field
    // as nullable, so its absence proves nothing. No assertion may depend on it
    // and it must not inflate the assertion count in either direction.
    const leg = shellFunction(shell, "run_browser_leg");
    const region = leg.slice(leg.indexOf("edge_request_id"));
    expect(region).not.toContain('pass_record "edge-request');
    expect(region).not.toContain('fail_record "edge-request');
    expect(shell).not.toContain("edge-request-identified");
  });
});

describe("stdin records are read in a way that terminates on a FIFO", () => {
  const runner = read(RUNNER);
  const shell = code(SCRIPT);

  test("neither reader uses Bun.stdin.stream()", () => {
    // Measured on bun 1.3.8 / macOS: `Bun.stdin.stream()` never observes
    // end-of-stream when stdin is a FIFO. The record arrives in full and the
    // process then blocks forever, while the identical code terminates over a
    // plain pipe — so the defect is invisible until the real transport is used.
    // It is what made the minter hang and the shim plant report "did-not-mint".
    // The ban is on the USAGE form. Both files name the API in a comment that
    // records why it is refused, and that prose must stay readable.
    expect(runner).not.toContain("of Bun.stdin.stream(");
    expect(shell).not.toContain("of Bun.stdin.stream(");
  });

  test("both read bounded and synchronously, MAX+1, refusing over-cap", () => {
    for (const source of [runner, shell]) {
      expect(source).toContain("readSync(0, buffer, total, buffer.length - total, null)");
      // MAX+1 so a full record can be told apart from an overflowing one.
      expect(source).toMatch(/Buffer\.alloc\(MAX_\w+_RECORD_BYTES \+ 1\)/);
      expect(source).toContain("if (read === 0) break;");
    }
  });

  test("both decode UTF-8 fatally, never substituting U+FFFD", () => {
    for (const source of [runner, shell]) {
      expect(source).toContain('new TextDecoder("utf-8", { fatal: true })');
      // A non-fatal `Buffer.toString("utf8")` would smuggle U+FFFD into a
      // credential field instead of refusing the record.
      expect(source).not.toContain('.toString("utf8")');
    }
  });
});

describe("the browser runner cannot exit before cleanup", () => {
  const runner = read(RUNNER);

  test("blocked and failed throw rather than exiting at the throw site", () => {
    // `process.exit` at the throw site skips the `finally` that awaits
    // context/browser close, orphaning Chromium while still printing a tidy
    // record.
    expect(runner).toContain("class RunnerExit");
    const blocked = runner.slice(
      runner.indexOf("function blocked("),
      runner.indexOf("function failed("),
    );
    expect(blocked).toContain("throw new RunnerExit");
    expect(blocked).not.toContain("process.exit");
    const failed = runner.slice(
      runner.indexOf("function failed("),
      runner.indexOf("function originHost("),
    );
    expect(failed).toContain("throw new RunnerExit");
    expect(failed).not.toContain("process.exit");
  });

  test("the status is applied only after the finally has closed the browser", () => {
    const tail = runner.slice(runner.indexOf("async function runEntrypoint()"));
    expect(tail).toContain("error instanceof RunnerExit");
    expect(tail).toContain("resolveTerminalOutcome(outcome, teardownFailed, deadlineExceeded)");
    expect(tail).toContain("process.exit(terminal.exitStatus)");
    const cleanup = runner.slice(runner.indexOf("} finally {"));
    expect(cleanup).toContain("await teardownOnce()");
  });

  test("the hard deadline latches first and joins one bounded teardown owner", () => {
    const budgetStart = runner.indexOf("const budget = setTimeout(");
    const budgetEnd = runner.indexOf("}, TOTAL_BUDGET_MS);", budgetStart);
    expect(budgetStart).toBeGreaterThanOrEqual(0);
    expect(budgetEnd).toBeGreaterThan(budgetStart);
    const budget = runner.slice(budgetStart, budgetEnd);
    expect(budget).toContain("await latchDeadlineAndTeardown(teardownOnce)");
    expect(budget).not.toContain("context?.close()");
    expect(budget).not.toContain("browser?.close()");
    expect(runner.match(/context\?\.close\(\)/g)).toHaveLength(1);
    expect(runner.match(/browser\?\.close\(\)/g)).toHaveLength(1);
    expect(runner).toContain("const teardownOnce = oneShotAsync(");
    const latchStart = runner.indexOf("async function latchDeadlineAndTeardown(");
    const latchEnd = runner.indexOf("\n}", latchStart);
    expect(latchStart).toBeGreaterThanOrEqual(0);
    expect(latchEnd).toBeGreaterThan(latchStart);
    const latch = runner.slice(latchStart, latchEnd);
    const latchAssignment = latch.indexOf("deadlineExceeded = true;");
    const firstAwait = latch.indexOf("await teardownOnce()");
    expect(latchAssignment).toBeGreaterThanOrEqual(0);
    expect(firstAwait).toBeGreaterThanOrEqual(0);
    expect(latchAssignment).toBeLessThan(firstAwait);
    // Both racing production paths publish through one synchronous latch.
    expect(runner.match(/publishTerminal\(/g)).toHaveLength(3);
    expect(budget).toContain("publishTerminal({");
    expect(runner.slice(runner.indexOf("async function runEntrypoint()"))).toContain(
      "publishTerminal(terminal)",
    );
  });

  test("the cookie-probe comment does not claim the cookie was presented", () => {
    expect(runner).not.toContain("Present the LIVE session cookie");
    expect(runner).toContain("host-only on the apex");
  });
});

describe("every child gets a minimal environment", () => {
  const source = code(SCRIPT);

  test("the minter gets a minimal env and its key over stdin", () => {
    const minter = shellFunction(source, "mint_envelope_config");
    // The key must reach the child as a bounded stdin record, never in argv
    // (process table) and never in environ (inherited by descendants).
    expect(minter).toContain("minimal_env_command");
    expect(minter).toContain("run_bounded");
    expect(minter).toContain("$secret_record");
    expect(minter).not.toContain("ASIMP_S6_SIGNING_KEY_HEX=");
    expect(minter).not.toContain("ASIMP_S6_FELLOW_TOKEN");
  });

  test("the browser gets a minimal env and its config over stdin", () => {
    const browser = shellFunction(source, "run_browser_leg");
    expect(browser).toContain("minimal_env_command");
    expect(browser).toContain("run_bounded");
    expect(browser).toContain("$config_record");
    // Chromium inherits this process's environment, so nothing secret may be in it.
    expect(browser).not.toContain('ASIMP_S6_TEST_GOOGLE_PASS="$ASIMP');
    expect(browser).not.toContain("ASIMP_S6_SIGNING_KEY_HEX=");
  });

  test("the launcher is minimal AT SPAWN, not unset-after-startup", () => {
    const launcher = shellFunction(source, "minimal_env_command");
    expect(launcher).toContain("env -i");
    // `bash -c 'unset X; exec …'` inherits every secret before unsetting, so on
    // any platform exposing same-UID environ the leak just moves from argv to
    // environ. No secret name may appear in the launcher's own argv either.
    expect(launcher).not.toContain("unset ");
    for (const secret of [
      "ASIMP_S6_SIGNING_KEY_HEX=",
      "ASIMP_S6_TEST_GOOGLE_PASS=",
      "ASIMP_S6_FELLOW_TOKEN=",
    ]) {
      expect(launcher).not.toContain(secret);
    }
    expect(shellFunction(source, "http_request")).toContain("minimal_env_command");
  });
});

describe("the tamper case reaches the verifier", () => {
  const source = code(SCRIPT);

  test("it sends a JSON content-type", () => {
    // The router checks content-type BEFORE authenticating, so a tamper POST
    // without it is refused by the wrong gate.
    const body = shellFunction(source, "assert_altered_payload_refused");
    expect(body).toContain("content-type: application/json");
  });

  test("a content-type refusal is an explicit failure, not a silent pass", () => {
    const body = shellFunction(source, "assert_altered_payload_refused");
    expect(body).toContain("JSON_CONTENT_TYPE_REQUIRED");
    const guard = body.slice(body.indexOf("JSON_CONTENT_TYPE_REQUIRED"));
    expect(guard).toContain("fail_record");
  });

  test("the router really checks content-type before auth", () => {
    const router = code("apps/wire/src/enrollment/router.ts");
    const start = router.indexOf('app.post("/v1/enrollments"');
    expect(start).toBeGreaterThanOrEqual(0);
    const route = router.slice(start);
    const contentType = route.indexOf("hasJsonContentType");
    const auth = route.indexOf("requireSponsor");
    // Both must be PRESENT before their order means anything. `indexOf` returns
    // -1 for a missing guard, and -1 is less than any real index, so comparing
    // the two directly would keep passing after the content-type check was
    // deleted — the exact vacuity this assertion exists to prevent.
    expect(contentType).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(contentType).toBeLessThan(auth);
  });
});

describe("the shell's causal self-tests actually run", () => {
  test(
    "--self-test passes, and its cleanup assertions are executed rather than described",
    async () => {
      const run = await sharedSelfTest();
      const { stdout } = run;
      expect(run.timedOut, diag(run)).toBe(false);
      expect(run.exitCode, diag(run)).toBe(0);
      expect(stdout, diag(run)).toContain('"status":"self_test_complete"');
      // These two are causal: a real child is killed, and a runaway child is
      // bounded at 124. They cannot pass by reading the source.
      expect(stdout, diag(run)).toContain('"assertion":"reaper-actually-kills","status":"pass"');
      expect(stdout, diag(run)).toContain('"assertion":"run-bounded-times-out","status":"pass"');
      // The four repairs the moving audit demanded, each proven by running it.
      expect(stdout, diag(run)).toContain(
        '"assertion":"run-bounded-honours-wall-clock","status":"pass"',
      );
      expect(stdout, diag(run)).toContain('"assertion":"reaper-kills-descendants","status":"pass"');
      expect(stdout, diag(run)).toContain(
        '"assertion":"child-environment-scrubbed","status":"pass"',
      );
      // Active-only ownership records, and the fast-exit property that the
      // zombie-poll defect used to break.
      expect(stdout, diag(run)).toContain(
        '"assertion":"child-record-armed-then-disarmed","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"clear-child-records-refuses-live-owner","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"unregister-is-exact-not-glob","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"run-bounded-fast-exit-is-prompt","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"bash-4.1-is-minimum-supported","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"watchdog-kill-dispatch-failure-is-bounded","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"reaper-kill-dispatch-failure-retains-owner","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"reaper-successful-kill-without-settlement-is-explicit","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"successful-supervisor-kill-without-settlement-status","status":"pass"',
      );
      // Both causal KILL-refusal outputs are mandatory. Removing either the
      // typed status check or its clock-bound proof must break this file.
      expect(stdout, diag(run)).toContain(
        '"assertion":"secret-writer-kill-dispatch-failure-status","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"secret-writer-kill-dispatch-failure-is-bounded","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"all-nonstandard-fds-not-inherited","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"maximum-input-record-is-byte-exact","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"oversized-input-refuses-before-target","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"input-start-is-bounded","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"input-mid-is-bounded","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"input-depart-mid-is-bounded","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"typed-child-status-125","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"duplicate-terminal-record-fails-closed","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"duplicate-terminal-owner-reaped-after-refusal","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"reaper-child-before-ack-is-retired","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"exit-cleanup-refusal-is-exact-125","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"second-signal-during-cleanup-is-exact-125","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"result-token-theft-replay-cannot-green","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"browser-blocked-record-is-buffered","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"blocked-runner-teardown-failure-overrides","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"runner-deadline-race-overrides-pass","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"generated-shim-executes-and-mints","status":"pass"',
      );
      expect(stdout, diag(run)).toContain('"assertion":"normal-exit-sweeps-group","status":"pass"');
      expect(stdout, diag(run)).toContain('"assertion":"error-exit-sweeps-group","status":"pass"');
      expect(stdout, diag(run)).not.toMatch(/"status"\s*:\s*"fail"/);
      // A self-test must never look like a passing S-6 run.
      expect(stdout, diag(run)).not.toContain('"status":"pass","assertions"');
    },
    SHELL_TIMEOUT_MS,
  );

  test(
    "with no configuration it blocks at 78 and runs nothing",
    async () => {
      const run = await runShell([], withoutS6Env());
      expect(run.timedOut, diag(run)).toBe(false);
      expect(run.exitCode, diag(run)).toBe(78);
      // The blocked record is the whole contract here, so an empty stdout is a
      // failure in its own right rather than something the next assertion
      // happens to catch.
      expect(run.stdout.length, diag(run)).toBeGreaterThan(0);
      expect(run.stdout, diag(run)).toContain('"code":"PREVIEW_NOT_PROVISIONED"');
      expect(run.stdout, diag(run)).not.toContain('"assertion"');
    },
    SHELL_TIMEOUT_MS,
  );
});

describe("the test harness contains what it launches", () => {
  test("it owns a live self-signalling supervisor capability", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    const supervisor = self.slice(
      self.indexOf("const OUTER_SETPGRP_PROGRAM"),
      self.indexOf("interface ShellLifecycle"),
    );
    const controller = self.slice(
      self.indexOf("async function runShell("),
      self.indexOf("/** Failure context."),
    );
    expect(supervisor).toContain("setpgrp(0,0)");
    expect(supervisor).toContain('/dev/tcp/127.0.0.1/$port');
    expect(supervisor).toContain("kill -TERM 0");
    expect(supervisor).toContain("kill -KILL 0");
    expect(supervisor).toContain("exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-");
    expect(supervisor).toContain("unset token");
    expect(controller).toContain("await outerControlListener()");
    expect(controller).toContain("randomBytes(24)");
    expect(controller).toContain("liveProtocol.signal(");
    expect(controller).toContain("assertCapabilityIntegrity()");
    expect(self).toContain("controlStepRemaining(deadlineAt)");
    expect(controller).toContain("cleanup unproven:");
    for (const forbidden of [
      ["process", "kill"],
      ["child", "pid"],
      ["child", "kill"],
    ]) {
      expect(controller).not.toContain(forbidden.join("."));
    }
    expect(controller).not.toContain("kill(-");
    expect(controller).not.toContain(".pid");
  });

  test("PLANTED: BOOT and START share one absolute child deadline", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-start-budget-"));
    const plant = join(dir, "started.sh");
    const startedMarker = join(dir, "target-started");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
printf started > "$1"
printf '%s\\n' '{"plant":"started"}'
`,
      { mode: 0o700 },
    );
    let refusal: unknown;
    try {
      await runShell([startedMarker], withoutS6Env(), plant, {
        runTimeoutMs: 300,
        controlReadyDelayMs: 200,
        controlStartedDelayMs: 200,
        postKillSettleMs: 500,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(
      /BOOT\/READY|START\/STARTED|outer supervisor protocol failure/,
    );
    expect(() => statSync(startedMarker)).toThrow();
  });

  test("PLANTED: a never-connect supervisor is directly retired before capability", async () => {
    const started = Date.now();
    let refusal: unknown;
    try {
      await runShell([], withoutS6Env(), SCRIPT, {
        runTimeoutMs: 100,
        postKillSettleMs: 500,
        supervisorNeverConnect: true,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("outer supervisor did not connect");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("PLANTED: a second accepted capability connection is a typed refusal", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-second-"));
    const plant = join(dir, "would-pass.sh");
    writeFileSync(plant, `#!/usr/bin/env bash\nprintf '%s\\n' '{"plant":"pass"}'\n`, {
      mode: 0o700,
    });
    let refusal: unknown;
    try {
      await runShell([], withoutS6Env(), plant, {
        runTimeoutMs: 2_000,
        postKillSettleMs: 500,
        afterControlAccept: async (port) => {
          const second = createConnection({ host: "127.0.0.1", port });
          try {
            await once(second, "connect");
          } finally {
            second.destroy();
          }
        },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("multiple supervisor capability connections");
  });

  test("PLANTED: the sealed listener refuses a late post-settlement connection", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-late-second-"));
    const plant = join(dir, "would-pass.sh");
    writeFileSync(plant, `#!/usr/bin/env bash\nprintf '%s\\n' '{"plant":"pass"}'\n`, {
      mode: 0o700,
    });
    const run = await runShell([], withoutS6Env(), plant, {
      runTimeoutMs: 2_000,
      postKillSettleMs: 1_000,
      probeLateSecondConnection: true,
    });
    expect(run.exitCode, diag(run)).toBe(0);
    expect(run.stdout, diag(run)).toContain('{"plant":"pass"}');
  });

  test("PLANTED: target receives no capability fd or nonce-bearing variable", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-fd-"));
    const plant = join(dir, "inspect-fds.sh");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
for fd in 3 4 5 6 7 8 9; do
  if eval ": <&\${fd}" 2>/dev/null || eval ": >&\${fd}" 2>/dev/null; then
    printf '%s\\n' '{"plant":"fd-leaked"}'
    exit 41
  fi
done
if [[ -n "\${token+x}" || -n "\${boot_kind+x}" || -n "\${start_token+x}" ]]; then
  printf '%s\\n' '{"plant":"token-variable-leaked"}'
  exit 42
fi
printf '%s\\n' '{"plant":"isolated"}'
`,
      { mode: 0o700 },
    );
    const run = await runShell([], withoutS6Env(), plant, { runTimeoutMs: 2_000 });
    expect(run.exitCode, diag(run)).toBe(0);
    expect(run.stdout, diag(run)).toContain('{"plant":"isolated"}');
  });

  test("PLANTED: an early payload exit before readiness emits no TERM/KILL", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-early-exit-"));
    const plant = join(dir, "early-exit.sh");
    const missingReady = join(dir, "never-ready");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
printf '%s\\n' '{"plant":"early-exit"}'
exit 7
`,
      { mode: 0o700 },
    );
    const commands: Array<"TERM" | "KILL"> = [];
    let refusal: unknown;
    try {
      await runShell([], withoutS6Env(), plant, {
        armAfterFileExists: missingReady,
        runTimeoutMs: 50,
        postKillSettleMs: 500,
        onControlSignal: (signal) => commands.push(signal),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("deadline plant exited before readiness: exit=7");
    expect(commands).toEqual([]);
  });

  test("PLANTED: a late extra record after KILL acknowledgement cannot green", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-extra-"));
    const plant = join(dir, "extra-record.sh");
    writeFileSync(plant, `#!/usr/bin/env bash\nprintf '%s\\n' '{"plant":"pass"}'\n`, {
      mode: 0o700,
    });
    let refusal: unknown;
    try {
      await runShell([], withoutS6Env(), plant, {
        runTimeoutMs: 2_000,
        postKillSettleMs: 500,
        extraRecordAfterKillAck: true,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("outer supervisor protocol failure");
  });

  test("PLANTED: TERM and KILL acknowledgements share one cleanup deadline", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-clean-budget-"));
    const plant = join(dir, "term-resistant.sh");
    const ready = join(dir, "ready");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
trap '' TERM
printf ready > "$1"
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    const commands: Array<"TERM" | "KILL"> = [];
    const started = Date.now();
    let refusal: unknown;
    try {
      await runShell([ready], withoutS6Env(), plant, {
        armAfterFileExists: ready,
        runTimeoutMs: 25,
        killGraceMs: 20,
        postKillSettleMs: 180,
        controlAckDelayMs: 120,
        onControlSignal: (signal) => commands.push(signal),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/KILL command failed|acknowledgement timeout/);
    expect(commands).toEqual(["TERM"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("PLANTED: timeout TERM completion revokes the pending KILL before reap", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-term-"));
    const plant = join(dir, "term-exit.sh");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
trap 'printf term-observed > "$2"; exit 42' TERM
printf ready > "$1"
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    const ready = join(dir, "ready");
    const termObserved = join(dir, "term-observed");
    const run = await runShell([ready, termObserved], withoutS6Env(), plant, {
      armAfterFileExists: ready,
      runTimeoutMs: 50,
      killGraceMs: 300,
    });
    expect(run.timedOut, diag(run)).toBe(true);
    expect(run.exitCode, diag(run)).toBe(42);
    expect(readFileSync(termObserved, "utf8"), diag(run)).toBe("term-observed");
    expect(run.escalationFired, diag(run)).toBe(false);
    expect(run.cleanupUnproven, diag(run)).toBe(true);
  });

  test("PLANTED: a TERM-resistant timeout causally reaches KILL escalation", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-kill-"));
    const plant = join(dir, "term-resistant.sh");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
trap '' TERM
printf ready > "$1"
printf '{"plant":"ready"}\\n'
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    const ready = join(dir, "ready");
    const run = await runShell([ready], withoutS6Env(), plant, {
      armAfterFileExists: ready,
      runTimeoutMs: 50,
      killGraceMs: 100,
    });
    expect(run.timedOut, diag(run)).toBe(true);
    expect(run.escalationFired, diag(run)).toBe(true);
    expect(run.cleanupUnproven, diag(run)).toBe(true);
  });

  test("PLANTED: a failed outer KILL dispatch refuses within a fixed bound", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-kill-fail-"));
    const plant = join(dir, "kill-dispatch-failure.sh");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
trap 'printf term-observed > "$2"' TERM
printf ready > "$1"
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    const ready = join(dir, "ready");
    const termObserved = join(dir, "term-observed");
    const commands: Array<"TERM" | "KILL"> = [];
    const started = Date.now();
    let refusal: unknown;
    try {
      await runShell([ready, termObserved], withoutS6Env(), plant, {
        armAfterFileExists: ready,
        runTimeoutMs: 50,
        killGraceMs: 50,
        postKillSettleMs: 100,
        failKillDispatch: true,
        onControlSignal: (signal) => commands.push(signal),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("cleanup unproven: supervisor KILL command failed");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(commands).toEqual(["TERM"]);
    expect(readFileSync(termObserved, "utf8")).toBe("term-observed");
  });

  test("PLANTED: exact typed lifecycle records are wired in both polarities", () => {
    // A real terminal/survivor record is authoritative, while the same words in
    // a detail field or another suite are not. Exit 125 is independently the
    // script's reserved cleanup-unproven status.
    expect(
      shellLifecycleFromRecords(
        '{"suite":"s6-cross-plane-auth","assertion":"no-child-survivors","status":"fail"}',
        1,
      ),
    ).toEqual({ cleanupUnproven: true, survivors: true });
    expect(
      shellLifecycleFromRecords(
        '{"suite":"s6-cross-plane-auth","status":"blocked","code":"CLEANUP_UNPROVEN"}',
        125,
      ),
    ).toEqual({ cleanupUnproven: true, survivors: true });
    expect(
      shellLifecycleFromRecords(
        '{"suite":"s6-cross-plane-auth","status":"pass","detail":"CLEANUP_UNPROVEN no-child-survivors fail"}',
        0,
      ),
    ).toEqual({ cleanupUnproven: false, survivors: false });
    expect(
      shellLifecycleFromRecords(
        '{"suite":"another-suite","status":"blocked","code":"CLEANUP_UNPROVEN"}',
        0,
      ),
    ).toEqual({ cleanupUnproven: false, survivors: false });
    expect(shellLifecycleFromRecords("", 125)).toEqual({
      cleanupUnproven: true,
      survivors: true,
    });
  });

  test("PLANTED: an in-budget typed cleanup refusal reaches the outer verdict", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-cleanup-terminal-"));
    const plant = join(dir, "cleanup-unproven.sh");
    writeFileSync(
      plant,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"suite":"s6-cross-plane-auth","status":"blocked","code":"CLEANUP_UNPROVEN"}\'\nexit 125\n',
      { mode: 0o700 },
    );
    const run = await runShell([], withoutS6Env(), plant, { runTimeoutMs: 2_000 });
    expect(run.timedOut, diag(run)).toBe(false);
    expect(run.exitCode, diag(run)).toBe(125);
    expect(run.cleanupUnproven, diag(run)).toBe(true);
    expect(run.survivors, diag(run)).toBe(true);
  });

  test("an over-cap capture is rejected, not truncated", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    expect(self).toContain("class OverCapture");
    expect(self).toContain("capture exceeded");
  });

  test("capture authority stays on the original held inode", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    const reader = self.slice(
      self.indexOf("function readBounded("),
      self.indexOf("interface OuterControlListener"),
    );
    const controller = self.slice(
      self.indexOf("async function runShell("),
      self.indexOf("/** Failure context."),
    );
    expect(controller).toContain("fsConstants.O_EXCL");
    expect(controller).toContain("fsConstants.O_NOFOLLOW");
    expect(controller).toContain("readBounded(stdoutFd, stdoutPath, stdoutCaptureIdentity)");
    expect(reader).toContain("while (offset < size)");
    expect(reader).toContain("after.size !== before.size");
    expect(reader).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(reader).not.toContain("statSync(path)");
    expect(controller.indexOf("readBounded(stdoutFd")).toBeLessThan(
      controller.indexOf("releaseCaptureFds()", controller.indexOf("readBounded(stdoutFd")),
    );
  });

  test(
    "an ordinary run leaves no survivor in the group this controller leads",
    async () => {
      // The claim is scoped to OUR group. The script's own nested groups are
      // covered by its plants below; this controller cannot see them, and on a
      // hard-killed run it reports `cleanupUnproven` rather than pretending to.
      const run = await sharedSelfTest();
      expect(run.timedOut, diag(run)).toBe(false);
      expect(run.cleanupUnproven, diag(run)).toBe(false);
      expect(run.survivors, diag(run)).toBe(false);
    },
    SHELL_TIMEOUT_MS,
  );

  test("a hard-killed run is reported as cleanup-unproven, not contained", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    // A pgid ledger was tried and removed: signalling from bare pgids risks a
    // recycled group, and censusing them is fail-open. So the hard-kill path
    // makes no containment claim in either direction.
    // Scoped to the controller: a whole-file ban would match this assertion.
    const controller = self.slice(
      self.indexOf("async function runShell("),
      self.indexOf("/** Failure context."),
    );
    expect(controller).toContain(
      "const cleanupUnproven = timedOut || shellLifecycle.cleanupUnproven;",
    );
    expect(controller).toContain("shellLifecycleFromRecords(stdout, exitCode)");
    expect(controller).not.toContain("S6_PGID_LEDGER");
    expect(controller).not.toContain("ledgerSurvivors");
    expect(code(SCRIPT)).not.toContain("ledger_note");
  });

  test(
    "the script's own plants cover the descendant, timeout and signal paths",
    async () => {
      // The shell's own `normal-exit-sweeps-group` plant proves the sweep; this
      // asserts the harness reports no survivor for that same run.
      const run = await sharedSelfTest();
      expect(run.stdout, diag(run)).toContain(
        '"assertion":"normal-exit-sweeps-group","status":"pass"',
      );
      expect(run.stdout, diag(run)).toContain('"assertion":"timeout-sweeps-group","status":"pass"');
      expect(run.stdout, diag(run)).toContain(
        '"assertion":"term-signal-reaps-descendants","status":"pass"',
      );
      expect(run.survivors, diag(run)).toBe(false);
    },
    SHELL_TIMEOUT_MS,
  );
});

describe("anti-vacuity: the blocked exit is load-bearing", () => {
  test(
    "deleting the required blocked exit makes the boundary test fail",
    async () => {
      // If the suite still passed against a script whose `exit "$EX_CONFIG"`
      // was removed, the exit-78 assertion would be decoration.
      const source = read(SCRIPT);
      const marker = '    CLEANED_UP=1\n    exit "$EX_CONFIG"\n  fi';
      expect(source).toContain(marker);
      const mutant = source.replace(marker, "    CLEANED_UP=1\n  fi");
      expect(mutant).not.toBe(source);

      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-mutant-"));
      const mutantPath = join(dir, "mutant.sh");
      writeFileSync(mutantPath, mutant, { mode: 0o700 });

      const run = await runShell([], withoutS6Env(), mutantPath);
      expect(run.timedOut, diag(run)).toBe(false);
      // The real script exits 78 here. The mutant must not, or the assertion
      // in "with no configuration it blocks at 78" proves nothing.
      expect(run.exitCode, diag(run)).not.toBe(78);
    },
    SHELL_TIMEOUT_MS,
  );
});
