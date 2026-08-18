// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this suite asserts on the
// text of a bash script, where `${VAR}` is the shell expansion being checked, not a
// JavaScript template placeholder. Rewriting them would stop the assertions matching
// the source they exist to pin.
// biome-ignore-all lint/style/useTemplate: explicit concatenation keeps the outer
// protocol's token interpolation visually distinct from the embedded shell source.

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
import {
  claimNameForEnrollment,
  cookieDirectionIsProven,
  enrollmentIdIsValid,
  finalizeSessionCookieObservation,
  isExactGoogleAccountsOrigin,
  MAX_BROWSER_EVIDENCE_BYTES,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_S6_EVIDENCE_BYTES,
  performAtExactGoogleOwnerFrame,
  SessionCookieCollector,
  selectBrowserEvidenceBytes,
  selectGoogleLoginAction,
  selectHttpResponseBytes,
  selectHttpResponseTranscriptBytes,
  selectS6EvidenceAgainstExpected,
  selectS6EvidenceBytes,
  selectS6EvidenceV4,
  sessionCookieFinalizationVerdict,
  sessionCookiePolicyFromHeaders,
  writeAllSync,
} from "../../../../e2e/playwright/s6-cross-plane-runner";

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
 * the first connector (plus the explicit exact-one test seam). This deliberately
 * follows the repo-proven S1 socket transport:
 * nested Bun stdio pipes have lost bytes and thrown EPIPE under `bun test`.
 * A TCP port is not peer authority. Under the explicit harness assumption that
 * no competing active local connector races this private test, the nonce binds
 * the transcript of the FIRST connector before target fork. It does not
 * authenticate an OS peer (an ambient same-UID process could edit this workspace
 * too); the target then closes the descriptor. Exact-one and late-connector
 * refusal remain load-bearing transcript checks.
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

interface TestSocketPair {
  readonly parent: Socket;
  readonly peer: Socket;
  close(): Promise<void>;
}

/** Loopback pair used only by strict protocol parser/write plants below. */
async function testSocketPair(): Promise<TestSocketPair> {
  const server = createServer();
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test socket pair did not receive a TCP port");
  }
  const accepted = new Promise<Socket>((resolveAccepted) => {
    server.once("connection", (socket) => {
      socket.on("error", () => undefined);
      resolveAccepted(socket);
    });
  });
  const parent = createConnection({ host: "127.0.0.1", port: address.port });
  parent.on("error", () => undefined);
  await once(parent, "connect");
  const acceptedPeer = await accepted;
  const parentClosed = new Promise<void>((resolveClosed) => {
    parent.once("close", () => resolveClosed());
  });
  const peerClosed = new Promise<void>((resolveClosed) => {
    acceptedPeer.once("close", () => resolveClosed());
  });
  const serverClosed = new Promise<void>((resolveClosed, rejectClosed) => {
    server.close((error) => {
      if (error) rejectClosed(error);
      else resolveClosed();
    });
  });
  let closePromise: Promise<void> | undefined;
  return {
    parent,
    peer: acceptedPeer,
    close() {
      closePromise ??= (async () => {
        parent.destroy();
        acceptedPeer.destroy();
        await Promise.all([parentClosed, peerClosed, serverClosed]);
      })();
      return closePromise;
    },
  };
}

type BoundedResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "elapsed" };

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
type OuterSocketWrite = (bytes: Buffer, callback: (error?: Error | null) => void) => boolean;

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
  private readonly socketWrite: OuterSocketWrite;
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

  constructor(socket: Socket, token: string, socketWrite?: OuterSocketWrite) {
    this.socket = socket;
    this.token = token;
    this.socketWrite = socketWrite ?? ((bytes, callback) => socket.write(bytes, callback));
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
        this.socketWrite(bytes, (error) => {
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
    return this.request("BOOT\t" + this.token, "outer-ready:" + this.token, deadlineAt, () => {
      this.state = "ready";
    });
  }

  async start(deadlineAt: number): Promise<boolean> {
    if (this.state !== "ready") return false;
    return this.request("START\t" + this.token, "outer-started:" + this.token, deadlineAt, () => {
      this.state = "running";
    });
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

function feedProtocolPlant(protocol: OuterSupervisorProtocol, chunk: string): void {
  // This file owns the parser and its causal plants. Reaching the private byte
  // boundary directly makes split/coalesced framing deterministic instead of
  // depending on how the kernel happens to packetize two loopback writes.
  (
    protocol as unknown as {
      acceptBytes(bytes: Buffer): void;
    }
  ).acceptBytes(Buffer.from(chunk, "ascii"));
}

const OUTER_SETPGRP_PROGRAM =
  "use POSIX qw(dup dup2 close); pipe(my $reader,my $writer) or die $!; " +
  "my $r=fileno($reader); my $w=fileno($writer); " +
  "if ($r==9 && $w!=9) { $r=dup($r); die $! if $r<0; } " +
  "dup2($w,9) unless $w==9; dup2($r,8) unless $r==8; " +
  "close($r) if $r!=8 && $r!=9; " +
  "close($w) if $w!=8 && $w!=9; $^F=9; defined(setpgrp(0,0)) or die $!; " +
  "exec @ARGV or die $!;";

const OUTER_SUPERVISOR_PROGRAM = [
  'port="$1" unavailable="$2" stdout_file="$3" stderr_file="$4" ready_delay="$5" started_delay="$6" ack_delay="$7" extra_kill_record="$8" kill_hold_delay="$9"',
  "shift 9",
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
  '[[ "$kill_hold_delay" =~ ^(0|[0-9]+\\.[0-9][0-9][0-9])$ ]] || kill -KILL 0',
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
  "    if IFS= read -r -t 0.05 child_record <&8; then",
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
  '        [[ "$kill_hold_delay" == "0" ]] || { IFS= read -r -t "$kill_hold_delay" _ <&8 || :; }',
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

const OUTER_NEVER_CONNECT_PROGRAM = 'trap "" TERM HUP INT; kill -STOP "$BASHPID"; exit 99';
const OUTER_EXIT_BEFORE_CONNECT_PROGRAM = "exit 73";

interface ShellLifecycle {
  readonly cleanupUnproven: boolean;
  readonly ownedSameProcessGroupsSettled: boolean;
}

/**
 * Accept the trusted shell's nested-group verdict only from one strict positive
 * lifecycle terminal. Every byte is LF-delimited NDJSON for this suite; the
 * terminal is exact, unique and last. Missing, malformed, duplicate, late,
 * wrong-suite and exit-inconsistent transcripts all fail closed.
 */
function shellLifecycleFromRecords(stdout: string, exitCode: number): ShellLifecycle {
  const refused = (): ShellLifecycle => ({
    cleanupUnproven: true,
    ownedSameProcessGroupsSettled: false,
  });
  if (
    stdout.length === 0 ||
    !stdout.endsWith("\n") ||
    stdout.includes("\r") ||
    stdout.includes("\0") ||
    exitCode === 125
  ) {
    return refused();
  }
  const lines = stdout.slice(0, -1).split("\n");
  if (lines.length < 2 || lines.some((line) => line.length === 0)) return refused();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return refused();
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return refused();
    const record = parsed as Record<string, unknown>;
    if (record.suite !== "s6-cross-plane-auth" || JSON.stringify(record) !== line) return refused();
    records.push(record);
  }
  const lifecycleIndexes = records.flatMap((record, index) =>
    record.record_type === "lifecycle-terminal" ? [index] : [],
  );
  if (lifecycleIndexes.length !== 1 || lifecycleIndexes[0] !== records.length - 1) {
    return refused();
  }
  const lifecycleLine = lines.at(-1) as string;
  const lifecycle = records.at(-1) as Record<string, unknown>;
  if (
    JSON.stringify(lifecycle) !== lifecycleLine ||
    JSON.stringify(Object.keys(lifecycle)) !==
      JSON.stringify(["suite", "record_type", "status", "owned_same_process_groups"]) ||
    lifecycle.status !== "pass" ||
    lifecycle.owned_same_process_groups !== "settled"
  ) {
    return refused();
  }
  const keysAre = (record: Record<string, unknown>, expected: readonly string[]): boolean =>
    JSON.stringify(Object.keys(record)) === JSON.stringify(expected);
  const productionAssertion = (record: Record<string, unknown>): boolean =>
    keysAre(record, ["suite", "assertion", "status", "detail", "reproduce"]) &&
    typeof record.assertion === "string" &&
    record.assertion.length > 0 &&
    (record.status === "pass" || record.status === "fail") &&
    typeof record.detail === "string" &&
    record.detail.length > 0 &&
    record.reproduce === "bash scripts/e2e-s6-cross-plane-auth.sh";
  const selfTestAssertion = (record: Record<string, unknown>): boolean =>
    keysAre(record, ["suite", "assertion", "status", "detail"]) &&
    typeof record.assertion === "string" &&
    record.assertion.length > 0 &&
    (record.status === "pass" || record.status === "fail") &&
    typeof record.detail === "string" &&
    record.detail.length > 0;
  const aggregateKeys = ["suite", "status", "assertions", "failures", "reproduce"] as const;
  const selfTestKeys = ["suite", "status", "self_test", "failures"] as const;
  const blockedKeys = ["suite", "status", "code", "bead", "detail", "reproduce"] as const;
  const missingEnvironmentKeys = [
    "suite",
    "status",
    "code",
    "bead",
    "missing_env",
    "blocked_on",
    "forbidden_substitutes",
    "unit_coverage",
  ] as const;
  const hasProductTerminalShape = (record: Record<string, unknown>): boolean =>
    [aggregateKeys, selfTestKeys, blockedKeys, missingEnvironmentKeys].some((keys) =>
      keysAre(record, keys),
    );
  const productTerminal = records.at(-2) as Record<string, unknown>;
  const assertionsBeforeTerminal = records.slice(0, -2);
  if (assertionsBeforeTerminal.some(hasProductTerminalShape)) return refused();
  const failureCountBeforeTerminal = assertionsBeforeTerminal.filter(
    (record) => record.status === "fail",
  ).length;
  const assertions = productTerminal.assertions;
  const failures = productTerminal.failures;
  const aggregateTerminal =
    keysAre(productTerminal, aggregateKeys) &&
    assertionsBeforeTerminal.every(productionAssertion) &&
    Number.isSafeInteger(assertions) &&
    assertions === assertionsBeforeTerminal.length &&
    Number.isSafeInteger(failures) &&
    failures === failureCountBeforeTerminal &&
    productTerminal.reproduce === "bash scripts/e2e-s6-cross-plane-auth.sh" &&
    ((exitCode === 0 && productTerminal.status === "pass" && failures === 0) ||
      (exitCode === 1 && productTerminal.status === "fail" && (failures as number) > 0));
  const selfTestTerminal =
    keysAre(productTerminal, selfTestKeys) &&
    assertionsBeforeTerminal.every(selfTestAssertion) &&
    productTerminal.self_test === true &&
    Number.isSafeInteger(failures) &&
    failures === failureCountBeforeTerminal &&
    ((exitCode === 0 && productTerminal.status === "self_test_complete" && failures === 0) ||
      (exitCode === 1 && productTerminal.status === "fail" && (failures as number) > 0));
  const blockedTerminal =
    keysAre(productTerminal, blockedKeys) &&
    assertionsBeforeTerminal.every(productionAssertion) &&
    productTerminal.status === "blocked" &&
    typeof productTerminal.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(productTerminal.code) &&
    productTerminal.bead === "asimposiumorg-vw3" &&
    typeof productTerminal.detail === "string" &&
    productTerminal.detail.length > 0 &&
    productTerminal.reproduce === "bash scripts/e2e-s6-cross-plane-auth.sh" &&
    ((exitCode === 1 && productTerminal.code === "INTERRUPTED") || exitCode === 78);
  const missingEnvironmentTerminal =
    keysAre(productTerminal, missingEnvironmentKeys) &&
    assertionsBeforeTerminal.length === 0 &&
    exitCode === 78 &&
    productTerminal.status === "blocked" &&
    productTerminal.code === "PREVIEW_NOT_PROVISIONED" &&
    productTerminal.bead === "asimposiumorg-vw3" &&
    Array.isArray(productTerminal.missing_env) &&
    productTerminal.missing_env.length > 0 &&
    productTerminal.missing_env.every((name) => typeof name === "string" && name.length > 0) &&
    typeof productTerminal.blocked_on === "string" &&
    typeof productTerminal.forbidden_substitutes === "string" &&
    typeof productTerminal.unit_coverage === "string";
  const exitConsistent =
    aggregateTerminal || selfTestTerminal || blockedTerminal || missingEnvironmentTerminal;
  if (!exitConsistent) return refused();
  return { cleanupUnproven: false, ownedSameProcessGroupsSettled: true };
}

interface ShellRun {
  readonly exitCode: number;
  readonly stdout: string;
  /** Diagnostics only. Never asserted on: the contract is the stdout NDJSON. */
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Retirement was acknowledged and the direct outer supervisor then settled. */
  readonly outerSupervisorSettledAfterRetirementProtocol: boolean;
  /** Trusted script claim; null for arbitrary custom scripts outside this boundary. */
  readonly nestedOwnedSameProcessGroupsSettled: boolean | null;
  /**
   * True when the run had to be hard-killed, so its nested process groups
   * cannot be shown to have been reaped.
   *
   * This is NOT a containment claim in either direction — it records that the
   * question is unanswerable for that run, because the script's trap was cut
   * short and this controller cannot see groups it does not lead.
   */
  readonly cleanupUnproven: boolean;
  /** True only when the TERM grace expired before a child terminal record arrived. */
  readonly graceExpiredEscalation: boolean;
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
  /** Test-only ACK(KILL)-then-hold plant; eventual self-KILL remains armed. */
  readonly controlKillHoldMs?: number;
  /** Test-only hook after first accept and before listener sealing/token mint. */
  readonly afterControlAccept?: (port: number) => Promise<void>;
  /** Test-only post-settlement connect attempt; the sealed listener must refuse it. */
  readonly probeLateSecondConnection?: boolean;
  /** Test-only stopped helper that never opens the rendezvous. */
  readonly supervisorNeverConnect?: boolean;
  /** Test-only builtin-only supervisor exit before rendezvous connect. */
  readonly supervisorExitBeforeConnect?: boolean;
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
  const runsTrustedS6Script = resolve(root, script) === resolve(root, SCRIPT);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-run-"));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  // NO OWNERSHIP LEDGER. The outer supervisor is a live capability: after one
  // loopback accept, a parent-memory nonce binds the first-connector transcript
  // before target fork under the no-competing-active-local-connector assumption.
  // This is not peer authentication. The supervisor self-signals group zero; this parent never names
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
    let supervisorProgram = OUTER_SUPERVISOR_PROGRAM;
    if (options.supervisorNeverConnect === true) {
      supervisorProgram = OUTER_NEVER_CONNECT_PROGRAM;
    } else if (options.supervisorExitBeforeConnect === true) {
      supervisorProgram = OUTER_EXIT_BEFORE_CONNECT_PROGRAM;
    }
    deadlineAt = Date.now() + runTimeoutMs;
    const supervisorProcess = Bun.spawn({
      cmd: [
        "/usr/bin/perl",
        "-e",
        OUTER_SETPGRP_PROGRAM,
        "bash",
        "-c",
        supervisorProgram,
        "s6-outer-supervisor",
        String(controlListener.port),
        "126",
        stdoutPath,
        stderrPath,
        ((options.controlReadyDelayMs ?? 0) / 1_000).toFixed(3),
        ((options.controlStartedDelayMs ?? 0) / 1_000).toFixed(3),
        ((options.controlAckDelayMs ?? 0) / 1_000).toFixed(3),
        options.extraRecordAfterKillAck === true ? "1" : "0",
        ((options.controlKillHoldMs ?? 0) / 1_000).toFixed(3),
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
        // Before nonce-bound READY no payload can have been forked. The
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
    // production the first connector is sealed before the nonce is minted, so
    // no queued/late connection can silently replace the bound transcript.
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
    let graceExpiredEscalation = false;
    const assertCapabilityIntegrity = (): void => {
      const failure = controlListener?.protocolFailure() ?? liveProtocol.protocolFailure();
      if (failure !== undefined) throw failure;
    };
    const settleSupervisorUntil = async (
      cleanupDeadlineAt: number,
    ): Promise<number | undefined> => {
      const remaining = Math.max(0, cleanupDeadlineAt - Date.now());
      const settled = await within(supervisorExited as Promise<number>, remaining);
      if (settled.kind === "elapsed") return undefined;
      supervisorSettled = true;
      return settled.value;
    };
    const requireNaturalCapabilityCloseUntil = async (cleanupDeadlineAt: number): Promise<void> => {
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
        throw new Error("outer supervisor exited before readiness: exit=" + readinessRace.exitCode);
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
      deadlineTimer = setTimeout(
        () => {
          // The callback only latches authority. One sequential owner below sends
          // TERM/KILL over the live socket after the race resolves.
          timedOut = true;
          resolveDeadline({ kind: "deadline" });
        },
        Math.max(0, deadlineAt - Date.now()),
      );
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
      // still-live nonce-bound supervisor performs one group self-KILL.
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
      if (!(await liveProtocol.signal("TERM", cleanupDeadlineAt, false, options.onControlSignal))) {
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
        graceExpiredEscalation = true;
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

    // A run we had to hard-kill cannot claim its nested owned groups settled:
    // the script's trap was cut short. For the trusted S6 script, one strict
    // positive lifecycle terminal is the only nested-group evidence. Arbitrary
    // custom scripts may detach into another session and remain explicitly
    // outside that claim; the outer capability proves only an acknowledged
    // retirement command followed by direct supervisor settlement, not a
    // post-kill group census or arbitrary detached-descendant absence.
    const shellLifecycle = runsTrustedS6Script
      ? shellLifecycleFromRecords(stdout, exitCode)
      : undefined;
    const cleanupUnproven =
      timedOut || exitCode === 125 || (shellLifecycle?.cleanupUnproven ?? false);

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
      outerSupervisorSettledAfterRetirementProtocol: supervisorSettled,
      nestedOwnedSameProcessGroupsSettled: shellLifecycle?.ownedSameProcessGroupsSettled ?? null,
      cleanupUnproven,
      graceExpiredEscalation,
    };
  } finally {
    let teardownFailure: Error | undefined;
    const cleanupDeadlineAt = beginTeardownBudget(options.postKillSettleMs ?? POST_KILL_SETTLE_MS);
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
    const lateProtocolFailure = controlListener?.protocolFailure() ?? protocol?.protocolFailure();
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
    // Cleanup ownership is stronger than a pending return or primary exception:
    // an unclosed capability or unreaped supervisor must replace either with the
    // typed cleanup-unproven refusal.
    // biome-ignore lint/correctness/noUnsafeFinally: teardown failure must override earlier control flow.
    if (teardownFailure !== undefined) throw teardownFailure;
  }
}

/** Failure context. stderr appears here and nowhere else. */
function diag(run: ShellRun): string {
  const tail = run.stderr.slice(-2_000);
  return `exit=${run.exitCode} timedOut=${run.timedOut} outerSupervisorSettledAfterRetirementProtocol=${run.outerSupervisorSettledAfterRetirementProtocol} nestedGroupsSettled=${String(run.nestedOwnedSameProcessGroupsSettled)} stderr(tail)=${tail}`;
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
    const parser = runner.slice(
      runner.indexOf("function parseSessionCookieIssuance"),
      runner.indexOf("function summarizeSessionCookieIssuances"),
    );
    expect(parser).toContain('a.startsWith("domain=")');
    expect(parser).toContain("invalid Set-Cookie framing");
  });

  test("PLANTED: every issuance is policy-bearing in either arrival order", () => {
    const safe = "asimp.session=safe; Path=/; HttpOnly; Secure; SameSite=Lax";
    const domain =
      "asimp.session=unsafe; Path=/; Domain=.asimposium.org; HttpOnly; Secure; SameSite=Lax";
    for (const headers of [
      [domain, safe],
      [safe, domain],
    ]) {
      const policy = sessionCookiePolicyFromHeaders(headers);
      expect(policy.issuanceCount).toBe(2);
      expect(policy.hostOnly).toBe(false);
      expect(policy.httpOnly).toBe(true);
      expect(policy.secure).toBe(true);
      expect(policy.sameSiteLax).toBe(true);
    }
    expect(sessionCookiePolicyFromHeaders([safe.replace("; HttpOnly", "")]).httpOnly).toBe(false);
    expect(sessionCookiePolicyFromHeaders([safe.replace("; Secure", "")]).secure).toBe(false);
    expect(
      sessionCookiePolicyFromHeaders([safe.replace("SameSite=Lax", "SameSite=None")]).sameSiteLax,
    ).toBe(false);
  });

  test("PLANTED: a delayed unsafe issuance during close is terminal", async () => {
    const previewOrigin = "https://preview.example.test";
    const safe = "asimp.session=safe; Path=/; HttpOnly; Secure; SameSite=Lax";
    const unsafe =
      "asimp.session=unsafe; Path=/; Domain=.example.test; HttpOnly; Secure; SameSite=Lax";
    const collector = new SessionCookieCollector(previewOrigin);
    collector.observe({
      url: () => `${previewOrigin}/console`,
      headersArray: async () => [{ name: "set-cookie", value: safe }],
    });
    await collector.drain();

    let releaseHeaders!: () => void;
    const headerGate = new Promise<void>((resolve) => {
      releaseHeaders = resolve;
    });
    let headersRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      headersRequested = resolve;
    });
    const order: string[] = [];
    let settled = false;
    const finalizationPromise = finalizeSessionCookieObservation({
      snapshotJar: async () => {
        order.push("snapshot");
        return { apexFamilyCount: 1, scopedToApex: true, agentFamilyCount: 0 };
      },
      closeContext: async () => {
        order.push("close-context");
        collector.observe({
          url: () => `${previewOrigin}/late`,
          headersArray: async () => {
            order.push("headers-requested");
            headersRequested();
            await headerGate;
            order.push("headers-complete");
            return [{ name: "set-cookie", value: unsafe }];
          },
        });
      },
      closeFallback: async () => {
        order.push("close-browser");
      },
      stopObserving: () => {
        order.push("stop-observing");
        collector.stop();
      },
      drain: async () => {
        order.push("drain-start");
        await collector.drain();
        order.push("drain-finish");
      },
      summarize: () => collector.summarize(),
      observationFailures: () => collector.failures,
    }).then((result) => {
      settled = true;
      return result;
    });
    await requested;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseHeaders();
    const finalization = await finalizationPromise;
    const verdict = sessionCookieFinalizationVerdict(finalization);
    expect(finalization.policy.issuanceCount).toBe(2);
    expect(finalization.policy.hostOnly).toBe(false);
    expect(verdict.failureCode).toBe("COOKIE_POLICY_CHANGED_DURING_FLOW");
    expect(order).toEqual([
      "snapshot",
      "close-context",
      "headers-requested",
      "stop-observing",
      "drain-start",
      "headers-complete",
      "drain-finish",
      "close-browser",
    ]);
    const candidate = runner.indexOf("candidateRecord = {");
    const teardown = runner.indexOf("await teardownOnce()", candidate);
    const terminalVerdict = runner.indexOf(
      "sessionCookieFinalizationVerdict(cookieFinalization)",
      teardown,
    );
    expect(candidate).toBeGreaterThanOrEqual(0);
    expect(teardown).toBeGreaterThan(candidate);
    expect(terminalVerdict).toBeGreaterThan(teardown);
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

  test("PLANTED: credential fills are exact-Google-origin bound", async () => {
    expect(isExactGoogleAccountsOrigin("https://accounts.google.com/signin/v2/identifier")).toBe(
      true,
    );
    let fills = 0;
    const actionOrder: string[] = [];
    let liveOwnerFrameUrl = "https://accounts.google.com/signin/v2/identifier";
    const expectedMainFrame = {
      url: () => {
        actionOrder.push("owner-frame-url");
        return liveOwnerFrameUrl;
      },
    };
    const elementHandle = {
      ownerFrame: async () => {
        actionOrder.push("owner-frame");
        return expectedMainFrame;
      },
    };
    await performAtExactGoogleOwnerFrame(elementHandle, expectedMainFrame, async () => {
      actionOrder.push("fill");
      fills += 1;
    });
    expect(actionOrder).toEqual(["owner-frame", "owner-frame-url", "fill"]);
    for (const decoy of [
      "https://accounts.google.com.evil.test/",
      "https://evil.test/accounts.google.com",
      "https://evil.test/?next=accounts.google.com",
      "https://accounts.google.com@evil.test/",
      "http://accounts.google.com/",
      "https://accounts.google.com:444/",
      "https://accounts.google.com./",
      "not a URL",
    ]) {
      expect(isExactGoogleAccountsOrigin(decoy), decoy).toBe(false);
      liveOwnerFrameUrl = decoy;
      await expect(
        performAtExactGoogleOwnerFrame(elementHandle, expectedMainFrame, () => (fills += 1)),
      ).rejects.toThrow();
    }
    liveOwnerFrameUrl = "https://accounts.google.com/signin/v2/identifier";
    await expect(
      performAtExactGoogleOwnerFrame(
        { ownerFrame: async () => ({ url: () => liveOwnerFrameUrl }) },
        expectedMainFrame,
        () => (fills += 1),
      ),
    ).rejects.toThrow();
    await expect(
      performAtExactGoogleOwnerFrame(
        { ownerFrame: async () => null },
        expectedMainFrame,
        () => (fills += 1),
      ),
    ).rejects.toThrow();
    expect(fills).toBe(1);
    const login = runner.slice(
      runner.indexOf("const signIn ="),
      runner.indexOf("if (page.url() !== consoleUrl)"),
    );
    expect(login.match(/performAtExactGoogleOwnerFrame/g)).toHaveLength(2);
    const helper = runner.slice(
      runner.indexOf("export async function performAtExactGoogleOwnerFrame"),
      runner.indexOf("export type GoogleLoginAction"),
    );
    expect(helper).toContain("await elementHandle.ownerFrame()");
    expect(helper).toContain("ownerFrame !== expectedMainFrame");
    expect(helper).toContain("isExactGoogleAccountsOrigin(ownerFrame.url())");
    expect(login).not.toContain("/accounts\\.google\\.com/");
  });

  test("PLANTED: a pre-authenticated or anonymous page cannot skip Google credential use", () => {
    expect(selectGoogleLoginAction(0)).toBe("refuse");
    expect(selectGoogleLoginAction(1)).toBe("perform-google-login");
    expect(selectGoogleLoginAction(2)).toBe("refuse");
    expect(selectGoogleLoginAction(Number.NaN)).toBe("refuse");
    const login = runner.slice(
      runner.indexOf("const signIn ="),
      runner.indexOf("if (page.url() !== consoleUrl)"),
    );
    expect(login).toContain("selectGoogleLoginAction(await signIn.count())");
    expect(login).toContain("GOOGLE_LOGIN_PRECONDITION_FAILED");
    expect(login).not.toContain("if ((await signIn.count()) > 0)");
  });

  test("a Google challenge is blocked, never passed or failed silently", () => {
    expect(runner).toContain("GOOGLE_LOGIN_CHALLENGED");
    expect(runner).toContain("BLOCKED_EXIT");
  });
});

describe("exactly two WRONG_PRINCIPAL legs, each exact", () => {
  const source = code(SCRIPT);

  test("the bearer leg proves absent, live, then wrong-principal polarity in order", () => {
    const leg = shellFunction(source, "assert_bearer_on_sponsor_route_refused");
    const absentHello = leg.indexOf('http_request GET "${worker}${ROUTE_HELLO}" "" ""');
    const absentContract = leg.indexOf(
      "validate_http_response problem 401 UNAUTHORIZED",
      absentHello,
    );
    const absentPass = leg.indexOf('pass_record "hello-without-credential-refused"');
    const bearerAssignment = leg.indexOf('bearer_config="header =');
    const bearerHello = leg.indexOf(
      'http_request GET "${worker}${ROUTE_HELLO}" "" "$bearer_config"',
      bearerAssignment,
    );
    const helloContract = leg.indexOf("validate_http_response hello", bearerHello);
    const helloPass = leg.indexOf('pass_record "bearer-live-on-fellow-route"', helloContract);
    const sponsor = leg.indexOf("${worker}${ROUTE_PROPOSALS}", helloPass);
    const refusal = leg.indexOf("validate_http_response problem 403 WRONG_PRINCIPAL", sponsor);
    const refusalPass = leg.indexOf('pass_record "bearer-on-sponsor-route-refused"', refusal);
    expect(absentHello).toBeGreaterThanOrEqual(0);
    expect(absentContract).toBeGreaterThan(absentHello);
    expect(absentPass).toBeGreaterThan(absentContract);
    expect(bearerAssignment).toBeGreaterThan(absentPass);
    expect(bearerHello).toBeGreaterThan(bearerAssignment);
    expect(helloContract).toBeGreaterThan(bearerHello);
    expect(helloPass).toBeGreaterThan(helloContract);
    expect(sponsor).toBeGreaterThan(helloPass);
    expect(refusal).toBeGreaterThan(sponsor);
    expect(refusalPass).toBeGreaterThan(refusal);
    expect(leg.match(/bearer_config/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(leg.match(/bearer_config=/g)).toHaveLength(1);
  });

  test("direction B is the explicit live-cookie probe", () => {
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain("cookie-presented-to-agent-host-refused");
    const runner = read(RUNNER);
    expect(runner).toContain("forcedCookieContext.addCookies");
    expect(runner).toContain("maxRedirects: 0");
  });

  test("natural omission remains distinct from explicit presentation", () => {
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain("cookie-not-sent-to-agent-host");
    expect(leg).toContain("cookie-presented-to-agent-host-refused");
    const runner = read(RUNNER);
    expect(runner).toContain("cookie_omission_probe");
    expect(runner).toContain("cookie_present_probe");
  });

  test("PLANTED: every direction, status and code guard is independently causal", () => {
    const omission = { attached: false, status: 403, code: "WRONG_PRINCIPAL" } as const;
    const presented = { attached: true, status: 403, code: "WRONG_PRINCIPAL" } as const;
    expect(cookieDirectionIsProven(omission, presented)).toBe(true);
    for (const [plantedOmission, plantedPresented] of [
      [{ ...omission, attached: true }, presented],
      [{ ...omission, status: 200 }, presented],
      [{ ...omission, code: "UNAUTHORIZED" }, presented],
      [omission, { ...presented, attached: false }],
      [omission, { ...presented, status: 200 }],
      [omission, { ...presented, code: "UNAUTHORIZED" }],
    ] as const) {
      expect(cookieDirectionIsProven(plantedOmission, plantedPresented)).toBe(false);
    }
  });

  test("no leg accepts an arbitrary non-2xx, a curl 000, a 404 or a 5xx", () => {
    // The rejected revision passed the cookie direction on any non-2xx, so a
    // dead Worker (curl 000) read as a security proof.
    expect(source).not.toContain("=~ ^2");
    for (const leg of ["assert_bearer_on_sponsor_route_refused", "assert_cookie_changed_nothing"]) {
      const body = shellFunction(source, leg);
      expect(body).not.toMatch(/!=\s*"?2/);
      expect(body).toContain("validate_http_response problem 403 WRONG_PRINCIPAL");
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
      (n) =>
        n === "bearer-on-sponsor-route-refused" || n === "cookie-presented-to-agent-host-refused",
    );
    expect(new Set(legs).size).toBe(2);
  });
});

describe("one exact HTTP response contract tree", () => {
  const enrollmentId = "ASIMP-EN-0123456789ABCDEF";
  const name = claimNameForEnrollment(enrollmentId);
  const problem = {
    type: "https://asimposium.org/errors/WRONG_PRINCIPAL",
    title: "Wrong principal",
    status: 403,
    code: "WRONG_PRINCIPAL",
    detail: "This route requires a different principal.",
    fix_hint: "Use the correct principal type.",
  };
  const hello = {
    fellow: { fellow_id: "fel_s6", name, model: "test/no-inference", harness: "playwright" },
    granted_scopes: ["promote"],
    granted_resources: {},
    next_actions: [],
  };
  const proposal = {
    enrollment_id: enrollmentId,
    proposal_id: "proposal-s6",
    status: "pending",
    name,
    model: "test/no-inference",
    harness: "playwright",
    requested_scopes: ["promote"],
    requested_resources: {},
    effective_granted_scopes: null,
    effective_granted_resources: null,
    proposal_expires_at: 4_000_000_000,
  };
  const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));

  test("exact ProblemDocument and live hello contracts are required", () => {
    expect(
      selectHttpResponseBytes(bytes(problem), 403, {
        kind: "problem",
        status: 403,
        code: "WRONG_PRINCIPAL",
      }),
    ).toEqual({ kind: "problem", status: 403, code: "WRONG_PRINCIPAL" });
    expect(selectHttpResponseBytes(bytes(hello), 200, { kind: "hello" })).toEqual({
      kind: "hello",
    });
    // A shape-valid-looking garbage bearer refusal cannot establish that the
    // credential was first live on the Fellow route.
    expect(() => selectHttpResponseBytes(bytes(problem), 200, { kind: "hello" })).toThrow();
  });

  test("the exact 202 claim contract discards rather than returns its flow handle", () => {
    const claim = { flow_handle: `flow_v1.${"A".repeat(43)}` };
    expect(selectHttpResponseBytes(bytes(claim), 202, { kind: "claim" })).toEqual({
      kind: "claim",
    });
    expect(() =>
      selectHttpResponseBytes(bytes({ ...claim, extra: true }), 202, { kind: "claim" }),
    ).toThrow();
    expect(() => selectHttpResponseBytes(bytes(claim), 200, { kind: "claim" })).toThrow();
  });

  test("PLANTED: nested, duplicate, malformed, wrong-code and wrong-status problems refuse", () => {
    const expectation = { kind: "problem", status: 403, code: "WRONG_PRINCIPAL" } as const;
    expect(() =>
      selectHttpResponseBytes(
        bytes({ ...problem, nested: { code: "WRONG_PRINCIPAL" } }),
        403,
        expectation,
      ),
    ).toThrow();
    const duplicate = Buffer.from(
      JSON.stringify(problem).replace(
        '"code":"WRONG_PRINCIPAL"',
        '"code":"UNAUTHORIZED","code":"WRONG_PRINCIPAL"',
      ),
    );
    expect(() => selectHttpResponseBytes(duplicate, 403, expectation)).toThrow();
    expect(() => selectHttpResponseBytes(Buffer.from("{not-json"), 403, expectation)).toThrow();
    expect(() =>
      selectHttpResponseBytes(bytes({ ...problem, code: "UNAUTHORIZED" }), 403, expectation),
    ).toThrow();
    expect(() => selectHttpResponseBytes(bytes(problem), 401, expectation)).toThrow();
  });

  test("PLANTED: proposal attribution requires one exact pending card", () => {
    const expectation = {
      kind: "proposals-present",
      enrollmentId,
      name,
      model: "test/no-inference",
      harness: "playwright",
    } as const;
    expect(selectHttpResponseBytes(bytes({ proposals: [proposal] }), 200, expectation)).toEqual({
      kind: "proposals-present",
    });
    for (const proposals of [
      [],
      [proposal, proposal],
      [{ ...proposal, name: "s6-wrong" }],
      [{ ...proposal, model: "test/wrong" }],
      [{ ...proposal, harness: "wrong" }],
      [{ ...proposal, reasoning_effort: "high" }],
      [{ ...proposal, tools_note: "unexpected" }],
      [{ ...proposal, status: "approved" }],
      [{ ...proposal, effective_granted_scopes: ["promote"] }],
      [{ ...proposal, effective_granted_resources: {} }],
    ]) {
      expect(() => selectHttpResponseBytes(bytes({ proposals }), 200, expectation)).toThrow();
    }
    expect(
      selectHttpResponseBytes(bytes({ proposals: [] }), 200, {
        kind: "proposals-absent",
        enrollmentId,
      }),
    ).toEqual({ kind: "proposals-absent" });
    expect(() =>
      selectHttpResponseBytes(bytes({ proposals: [proposal] }), 200, {
        kind: "proposals-absent",
        enrollmentId,
      }),
    ).toThrow();
  });

  test("curl transcripts are byte-bounded and exact", () => {
    const transcript = Buffer.from(`${JSON.stringify(problem)}\n403`);
    expect(
      selectHttpResponseTranscriptBytes(transcript, {
        kind: "problem",
        status: 403,
        code: "WRONG_PRINCIPAL",
      }),
    ).toEqual({ kind: "problem", status: 403, code: "WRONG_PRINCIPAL" });
    for (const malformed of [
      Buffer.from(`${JSON.stringify(problem)}\n403\n`),
      Buffer.from(`${JSON.stringify(problem)}\n40x`),
      Buffer.from(`${JSON.stringify(problem)}\n403extra`),
      Buffer.concat([Buffer.alloc(MAX_HTTP_RESPONSE_BYTES + 1, 0x20), Buffer.from("\n403")]),
      Buffer.from([0xff, 0x0a, 0x34, 0x30, 0x33]),
    ]) {
      expect(() =>
        selectHttpResponseTranscriptBytes(malformed, {
          kind: "problem",
          status: 403,
          code: "WRONG_PRINCIPAL",
        }),
      ).toThrow();
    }
  });

  test("EnrollmentIdSchema boundaries replace the stale 26-character duplicate", () => {
    for (const body of ["0".repeat(10), "0123456789ABCDEF", "A".repeat(32)]) {
      expect(enrollmentIdIsValid(`ASIMP-EN-${body}`)).toBe(true);
    }
    for (const body of ["0".repeat(9), "A".repeat(33), "IIIIIIIIII", "bad_lowercase"]) {
      expect(enrollmentIdIsValid(`ASIMP-EN-${body}`)).toBe(false);
    }
    expect(claimNameForEnrollment("ASIMP-EN-0123456789ABCDEF")).toBe("s6-0123456789abcdef");
    expect(claimNameForEnrollment(`ASIMP-EN-${"A".repeat(32)}`).length).toBe(32);
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
      expect(body).toContain("validate_http_response problem 401 UNAUTHORIZED");
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
    expect(http).toContain("--max-filesize 65536");
    expect(http).toContain('HTTP_RESPONSE_FILE="$out_file"');
    expect(http).not.toContain("$(cat");
    const validator = shellFunction(source, "validate_http_response");
    expect(validator).toContain("--validate-http-response");
    expect(validator).toContain("HTTP_RESPONSE_FILE");
    expect(validator).not.toMatch(/grep|sed|head/);
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

  test("the live cookie value is used only inside the isolated Playwright probe", () => {
    const runner = read(RUNNER);
    const probe = runner.slice(
      runner.indexOf("forcedCookieContext = await browser.newContext()"),
      runner.indexOf("// The real Server Action"),
    );
    expect(probe).toContain("value: entry.value");
    expect(probe).toContain("forcedCookieContext.request.get");
    expect(probe).not.toContain("writeFile");
    expect(probe).not.toContain("console.");
    expect(probe).not.toContain("detail: entry.value");
    expect(source).not.toContain("ASIMP_S6_STORAGE_STATE");
  });

  test("the transient join secret and flow handle are never emitted or retained", () => {
    const runner = read(RUNNER);
    const claim = runner.slice(
      runner.indexOf("async function claimMintedEnrollment("),
      runner.indexOf("async function main()"),
    );
    expect(claim).toContain("secret: parsed.secret");
    expect(claim).not.toMatch(/emit\(|writeStdoutLine|writeFile|console\./);
    expect(claim).not.toContain("flow_handle");
    const selector = runner.slice(
      runner.indexOf("export function selectHttpResponseBytes("),
      runner.indexOf("export function selectHttpResponseTranscriptBytes("),
    );
    expect(selector).toContain('return { kind: "claim" }');
    expect(selector).not.toMatch(/return .*flow_handle/);
    expect(source).not.toContain("#v1.");
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
    const exact = runner.slice(
      runner.indexOf("async function exactProbeResult("),
      runner.indexOf("async function main("),
    );
    expect(exact).toContain("new URL(response.url()).href !== new URL(expectedUrl).href");
    const probe = runner.slice(runner.indexOf("const omissionResponse"));
    expect(probe.match(/maxRedirects: 0/g)?.length).toBe(2);
    expect(probe).toContain("AGENT_HOST_OMISSION_PROBE_REDIRECTED");
    expect(probe).toContain("AGENT_HOST_COOKIE_PRESENT_PROBE_REDIRECTED");
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
    expect(leg).toContain("--validate-record");
    expect(leg).toContain("$'pass\\t'");
    expect(leg).not.toContain("ASIMP-EN-");
    expect(read(RUNNER)).toContain("EnrollmentIdSchema.safeParse");
  });

  test("attribution uses strict current- and opposite-sponsor proposal contracts", () => {
    const leg = shellFunction(source, "assert_receipt_attributed");
    expect(leg).toContain('validate_http_response proposals-present "$RECEIPT"');
    expect(leg).toContain('validate_http_response proposals-absent "$RECEIPT"');
    expect(leg).toContain("other_sponsor");
    expect(leg).not.toContain("grep");
  });

  test("the runner proves the id was absent before the click", () => {
    const runner = read(RUNNER);
    expect(runner).toContain('page.locator("pre.pasteblock.join-url")');
    expect(runner).toContain("receiptCountBefore = await joinReceipt.count()");
    expect(runner).toContain("MINT_RECEIPT_BASELINE_FAILED");
    expect(runner).toContain("receiptCountBefore !== 0");
    expect(runner).not.toContain('locator("body").innerText()');
  });

  test("the dedicated receipt is exact-contract parsed and transiently claimed", () => {
    const runner = read(RUNNER);
    const receipt = runner.slice(
      runner.indexOf("const joinUrl = await joinReceipt.evaluate("),
      runner.indexOf("const receipt =", runner.indexOf("const joinUrl =")),
    );
    expect(receipt).toContain('element.matches("pre.pasteblock.join-url")');
    expect(receipt).toContain("claimMintedEnrollment(claimContext, joinUrl, workerUrl)");
    expect(receipt).not.toContain("innerText");
    const claim = runner.slice(
      runner.indexOf("async function claimMintedEnrollment("),
      runner.indexOf("async function main()"),
    );
    expect(claim).toContain("parseStoaJoinUrl(joinUrl)");
    expect(claim).toContain('new URL("/v1/fellows", workerUrl).href');
    expect(claim).toContain("FellowRegistrationRequestSchema.parse");
    expect(claim).toContain("maxRedirects: 0");
    expect(claim).toContain('response.headers()["cache-control"] !== "no-store"');
    expect(claim).toContain(
      'selectHttpResponseBytes(await response.body(), response.status(), { kind: "claim" })',
    );
    expect(claim).not.toContain("console.");
  });

  test("missing mint is blocked only by the exact provisioning signal", () => {
    const runner = read(RUNNER);
    const mint = runner.slice(
      runner.indexOf('const mint = page.getByRole("button"'),
      runner.indexOf("const joinReceipt ="),
    );
    const signal = mint.indexOf(
      "Join-URL minting is disabled because this deployment cannot prepare recoverable writes",
    );
    const blocked = mint.indexOf("CONSOLE_WRITES_NOT_PROVISIONED");
    const failed = mint.indexOf("CONSOLE_MINT_CONTROL_MISSING");
    expect(signal).toBeGreaterThanOrEqual(0);
    expect(blocked).toBeGreaterThan(signal);
    expect(failed).toBeGreaterThan(blocked);
  });

  test("browser executable absence is distinct from launch fault", () => {
    const runner = read(RUNNER);
    const launch = runner.slice(
      runner.indexOf("browser = await chromium.launch"),
      runner.indexOf("context = await browser.newContext()"),
    );
    expect(launch).toContain("isMissingBrowserExecutable(error)");
    expect(launch).toContain("PLAYWRIGHT_BROWSER_MISSING");
    expect(launch).toContain("PLAYWRIGHT_BROWSER_LAUNCH_FAILED");
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
    const entrypointStart = runner.indexOf("async function runEntrypoint()");
    const entrypointEnd = runner.indexOf("// Importing this module", entrypointStart);
    const publishStart = runner.indexOf("function publishTerminal(");
    const publishEnd = runner.indexOf("/**\n * Apply the lifecycle verdict", publishStart);
    expect(entrypointStart).toBeGreaterThanOrEqual(0);
    expect(entrypointEnd).toBeGreaterThan(entrypointStart);
    expect(publishStart).toBeGreaterThanOrEqual(0);
    expect(publishEnd).toBeGreaterThan(publishStart);
    const entrypoint = runner.slice(entrypointStart, entrypointEnd);
    const publish = runner.slice(publishStart, publishEnd);
    const select = entrypoint.indexOf(
      "resolveTerminalOutcome(outcome, teardownFailed, deadlineExceeded)",
    );
    const publishCall = entrypoint.indexOf("publishTerminal(terminal)");
    expect(select).toBeGreaterThanOrEqual(0);
    expect(publishCall).toBeGreaterThanOrEqual(0);
    expect(select).toBeLessThan(publishCall);
    const emitTerminal = publish.indexOf("emit(terminal.record)");
    const exitTerminal = publish.indexOf("process.exit(terminal.exitStatus)");
    expect(emitTerminal).toBeGreaterThanOrEqual(0);
    expect(exitTerminal).toBeGreaterThanOrEqual(0);
    expect(emitTerminal).toBeLessThan(exitTerminal);
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

describe("mandatory schema-v4 evidence is exact and fail-closed", () => {
  const source = code(SCRIPT);
  const evidence = {
    suite: "s6-cross-plane-auth",
    schema_version: 4,
    bead: "asimposiumorg-vw3",
    revision: {
      value: "a".repeat(64),
      source: "required_harness_input",
      verification: "format_only",
    },
    deployment: {
      id: "s6-paired-deployment:01",
      source: "required_harness_input",
      verification: "format_only",
      exercised_origins: {
        agora_host: "preview.vercel.app",
        stoa_host: "a-preview.asimposium.org",
        source: "exercised_https_origin",
      },
    },
    service_envelope: {
      kid: "s6-live-kid",
      method: "GET",
      action: "enrollment.proposals.list",
      payload_sha256: "b".repeat(64),
      principal_pseudonym: { scheme: "sha256", value: "c".repeat(64) },
      route_template: "/v1/enrollments/proposals",
      initial_response: { status: 200, code: null, latency_seconds: 2 },
      replay_response: { status: 401, code: "UNAUTHORIZED", latency_seconds: 3 },
    },
    cookie_assertions: {
      host_only: true,
      http_only: true,
      secure: true,
      same_site: "lax",
      scoped_to_apex: true,
      natural_agent_host: { attached: false, status: 403, code: "WRONG_PRINCIPAL" },
      explicit_agent_host: { attached: true, status: 403, code: "WRONG_PRINCIPAL" },
    },
    latency: { browser_leg_seconds: 11, run_seconds: 19 },
    assertions: 17,
    failures: 0,
  };
  const expectedEvidence = {
    revision: evidence.revision.value,
    deploymentId: evidence.deployment.id,
    agoraHost: evidence.deployment.exercised_origins.agora_host,
    stoaHost: evidence.deployment.exercised_origins.stoa_host,
    kid: evidence.service_envelope.kid,
    payloadSha256: evidence.service_envelope.payload_sha256,
    principalPseudonym: evidence.service_envelope.principal_pseudonym.value,
    initialLatencySeconds: evidence.service_envelope.initial_response.latency_seconds,
    replayLatencySeconds: evidence.service_envelope.replay_response.latency_seconds,
    browserLegSeconds: evidence.latency.browser_leg_seconds,
    runSeconds: evidence.latency.run_seconds,
    assertions: evidence.assertions,
    failures: evidence.failures,
  };

  test("the required variable set and pure missing-value rule are exact", () => {
    const start = source.indexOf("readonly REQUIRED_VARS=(");
    const end = source.indexOf("\n)", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const declaration = source.slice(start, end + 2);
    const names = [...declaration.matchAll(/^ {2}(ASIMP_S6_[A-Z0-9_]+)$/gm)].map((match) => {
      const name = match[1];
      if (name === undefined) throw new Error("required-variable capture was absent");
      return name;
    });
    expect(names).toEqual([
      "ASIMP_S6_PREVIEW_URL",
      "ASIMP_S6_WORKER_URL",
      "ASIMP_S6_TEST_GOOGLE_USER",
      "ASIMP_S6_TEST_GOOGLE_PASS",
      "ASIMP_S6_FELLOW_TOKEN",
      "ASIMP_S6_SIGNING_KEY_HEX",
      "ASIMP_S6_SIGNING_KID",
      "ASIMP_S6_SPONSOR_ID",
      "ASIMP_S6_REVISION",
      "ASIMP_S6_DEPLOYMENT_ID",
      "ASIMP_S6_EVIDENCE_DIR",
    ]);
    expect(source).not.toMatch(/ASIMP_S6_(?:AGORA|STOA)_DEPLOYMENT/);
    expect(shellFunction(source, "missing_vars")).toBe(`missing_vars() {
  local name
  for name in "\${REQUIRED_VARS[@]}"; do
    if [[ -z "\${!name:-}" ]]; then printf '%s\\n' "$name"; fi
  done`);
    const missingVars = (environment: Readonly<Record<string, string | undefined>>): string[] =>
      names.filter((name) => !environment[name]);
    const present = Object.fromEntries(names.map((name) => [name, "present"]));
    expect(missingVars(present)).toEqual([]);
    for (const name of names) {
      expect(missingVars({ ...present, [name]: "" }), name).toEqual([name]);
      expect(missingVars({ ...present, [name]: undefined }), name).toEqual([name]);
    }
  });

  test("PLANTED: the exact shell path predicate matches the pure table oracle", () => {
    const predicate = shellFunction(source, "valid_evidence_directory");
    expect(predicate).toBe(`valid_evidence_directory() {
  [[ "$1" == "e2e/artifacts/s6-cross-plane-auth" ]]`);
    const accepts = (value: string): boolean => value === "e2e/artifacts/s6-cross-plane-auth";
    expect(accepts("e2e/artifacts/s6-cross-plane-auth")).toBe(true);
    for (const unsafe of [
      "",
      "/tmp/s6-cross-plane-auth",
      "e2e/artifacts/s6-cross-plane-auth/",
      "e2e/artifacts/s6-cross-plane-auth/../escape",
      "e2e/artifacts/s6-cross-plane-auth-lookalike",
    ]) {
      expect(accepts(unsafe), unsafe).toBe(false);
    }
  });

  test("symlink components and invalid deployment configuration have typed blockers", () => {
    const symlinkGuard = shellFunction(source, "evidence_directory_has_symlink_component");
    expect(symlinkGuard).toContain('[[ -L "e2e" || -L "e2e/artifacts" ||');
    expect(symlinkGuard).toContain('-L "e2e/artifacts/s6-cross-plane-auth" ]]');
    const main = shellFunction(source, "main");
    const revisionCheck = main.indexOf('if [[ ! "$ASIMP_S6_REVISION" =~');
    const revisionBlocker = main.indexOf('blocked_record "REVISION_INVALID"');
    const deploymentCheck = main.indexOf('if [[ ! "$ASIMP_S6_DEPLOYMENT_ID" =~');
    const deploymentBlocker = main.indexOf('blocked_record "DEPLOYMENT_ID_INVALID"');
    const directoryCheck = main.indexOf('if ! valid_evidence_directory "$ASIMP_S6_EVIDENCE_DIR"');
    const symlinkCheck = main.indexOf("evidence_directory_has_symlink_component", directoryCheck);
    const directoryBlocker = main.indexOf('blocked_record "EVIDENCE_DIR_INVALID"');
    expect(revisionCheck).toBeGreaterThanOrEqual(0);
    expect(revisionBlocker).toBeGreaterThan(revisionCheck);
    expect(main.slice(revisionCheck, revisionBlocker)).toContain("^([0-9a-f]{40}|[0-9a-f]{64})$");
    expect(deploymentCheck).toBeGreaterThan(revisionBlocker);
    expect(deploymentBlocker).toBeGreaterThan(deploymentCheck);
    expect(main.slice(deploymentCheck, deploymentBlocker)).toContain(
      "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    );
    expect(directoryCheck).toBeGreaterThan(deploymentBlocker);
    expect(symlinkCheck).toBeGreaterThan(directoryCheck);
    expect(directoryBlocker).toBeGreaterThan(symlinkCheck);

    const writer = shellFunction(source, "write_evidence_bundle");
    const fixedRoot = writer.indexOf('valid_evidence_directory "$dir"');
    const beforeCreate = writer.indexOf("evidence_directory_has_symlink_component", fixedRoot);
    const create = writer.indexOf('mkdir -p "$dir"', beforeCreate);
    const afterCreate = writer.indexOf("evidence_directory_has_symlink_component", create);
    const finalPath = writer.indexOf('if [[ -L "$path" ]]', afterCreate);
    expect(fixedRoot).toBeGreaterThanOrEqual(0);
    expect(beforeCreate).toBeGreaterThan(fixedRoot);
    expect(create).toBeGreaterThan(beforeCreate);
    expect(afterCreate).toBeGreaterThan(create);
    expect(finalPath).toBeGreaterThan(afterCreate);
  });

  test("PLANTED: the shared exact schema validator rejects partial or overstated evidence", () => {
    expect(() => selectS6EvidenceV4(evidence)).not.toThrow();
    expect(() => selectS6EvidenceAgainstExpected(evidence, expectedEvidence)).not.toThrow();
    const canonical = Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8");
    expect(() => selectS6EvidenceBytes(canonical, expectedEvidence)).not.toThrow();
    const variants: unknown[] = [
      { ...evidence, schema_version: 3 },
      { ...evidence, extra: true },
      { ...evidence, revision: { ...evidence.revision, verification: "verified" } },
      { ...evidence, deployment: { ...evidence.deployment, verification: "verified" } },
      { ...evidence, deployment: { ...evidence.deployment, id: "bad deployment id" } },
      {
        ...evidence,
        deployment: {
          ...evidence.deployment,
          exercised_origins: {
            ...evidence.deployment.exercised_origins,
            stoa_host: evidence.deployment.exercised_origins.agora_host,
          },
        },
      },
      {
        ...evidence,
        service_envelope: { ...evidence.service_envelope, initial_response: null },
      },
      {
        ...evidence,
        service_envelope: {
          ...evidence.service_envelope,
          payload_sha256: "g".repeat(64),
        },
      },
      {
        ...evidence,
        cookie_assertions: {
          ...evidence.cookie_assertions,
          explicit_agent_host: {
            ...evidence.cookie_assertions.explicit_agent_host,
            attached: false,
          },
        },
      },
      { ...evidence, latency: { ...evidence.latency, browser_leg_seconds: -1 } },
    ];
    const { revision: _missingRevision, ...withoutRevision } = evidence;
    variants.push(withoutRevision);
    for (const variant of variants) expect(() => selectS6EvidenceV4(variant)).toThrow();
    const duplicateSchemaVersion = Buffer.from(
      `${JSON.stringify(evidence).replace(
        '"schema_version":4',
        '"schema_version":3,"schema_version":4',
      )}\n`,
      "utf8",
    );
    for (const malformed of [
      canonical.subarray(0, canonical.length - 1),
      Buffer.concat([canonical, canonical]),
      duplicateSchemaVersion,
      Buffer.from(` ${JSON.stringify(evidence)}\n`, "utf8"),
      Buffer.from(`${JSON.stringify(evidence)}\r\n`, "utf8"),
      Buffer.from([0xff, 0x0a]),
      Buffer.alloc(MAX_S6_EVIDENCE_BYTES + 1, 0x61),
    ]) {
      expect(() => selectS6EvidenceBytes(malformed, expectedEvidence)).toThrow();
    }
  });

  test("PLANTED: every homogeneous expected-value swap is refused", () => {
    const reject = (actual: typeof evidence): void => {
      expect(() => selectS6EvidenceV4(actual)).not.toThrow();
      expect(() => selectS6EvidenceAgainstExpected(actual, expectedEvidence)).toThrow();
      expect(() =>
        selectS6EvidenceBytes(Buffer.from(`${JSON.stringify(actual)}\n`, "utf8"), expectedEvidence),
      ).toThrow();
    };

    const textGroups: Array<
      Array<{
        get(value: typeof evidence): string;
        set(value: typeof evidence, replacement: string): void;
      }>
    > = [
      [
        {
          get: (value) => value.revision.value,
          set: (value, replacement) => {
            value.revision.value = replacement;
          },
        },
        {
          get: (value) => value.service_envelope.payload_sha256,
          set: (value, replacement) => {
            value.service_envelope.payload_sha256 = replacement;
          },
        },
        {
          get: (value) => value.service_envelope.principal_pseudonym.value,
          set: (value, replacement) => {
            value.service_envelope.principal_pseudonym.value = replacement;
          },
        },
      ],
      [
        {
          get: (value) => value.deployment.id,
          set: (value, replacement) => {
            value.deployment.id = replacement;
          },
        },
        {
          get: (value) => value.deployment.exercised_origins.agora_host,
          set: (value, replacement) => {
            value.deployment.exercised_origins.agora_host = replacement;
          },
        },
        {
          get: (value) => value.deployment.exercised_origins.stoa_host,
          set: (value, replacement) => {
            value.deployment.exercised_origins.stoa_host = replacement;
          },
        },
        {
          get: (value) => value.service_envelope.kid,
          set: (value, replacement) => {
            value.service_envelope.kid = replacement;
          },
        },
      ],
    ];
    for (const fields of textGroups) {
      for (let left = 0; left < fields.length; left += 1) {
        for (let right = left + 1; right < fields.length; right += 1) {
          const actual = structuredClone(evidence);
          const leftValue = fields[left]?.get(actual);
          const rightValue = fields[right]?.get(actual);
          if (leftValue === undefined || rightValue === undefined) throw new Error("bad plant");
          fields[left]?.set(actual, rightValue);
          fields[right]?.set(actual, leftValue);
          reject(actual);
        }
      }
    }

    const numericFields: Array<{
      get(value: typeof evidence): number;
      set(value: typeof evidence, replacement: number): void;
    }> = [
      {
        get: (value) => value.service_envelope.initial_response.latency_seconds,
        set: (value, replacement) => {
          value.service_envelope.initial_response.latency_seconds = replacement;
        },
      },
      {
        get: (value) => value.service_envelope.replay_response.latency_seconds,
        set: (value, replacement) => {
          value.service_envelope.replay_response.latency_seconds = replacement;
        },
      },
      {
        get: (value) => value.latency.browser_leg_seconds,
        set: (value, replacement) => {
          value.latency.browser_leg_seconds = replacement;
        },
      },
      {
        get: (value) => value.latency.run_seconds,
        set: (value, replacement) => {
          value.latency.run_seconds = replacement;
        },
      },
      {
        get: (value) => value.assertions,
        set: (value, replacement) => {
          value.assertions = replacement;
        },
      },
      {
        get: (value) => value.failures,
        set: (value, replacement) => {
          value.failures = replacement;
        },
      },
    ];
    for (let left = 0; left < numericFields.length; left += 1) {
      for (let right = left + 1; right < numericFields.length; right += 1) {
        const actual = structuredClone(evidence);
        const leftValue = numericFields[left]?.get(actual);
        const rightValue = numericFields[right]?.get(actual);
        if (leftValue === undefined || rightValue === undefined) throw new Error("bad plant");
        numericFields[left]?.set(actual, rightValue);
        numericFields[right]?.set(actual, leftValue);
        reject(actual);
      }
    }
  });

  test("the writer emits schema v4 from validator-latched actual tuples", () => {
    const writer = shellFunction(source, "write_evidence_bundle");
    const captureStart = writer.indexOf('  local -r expected_revision="$ASIMP_S6_REVISION"');
    const captureEnd = writer.indexOf("\n  local path=", captureStart);
    expect(captureStart).toBeGreaterThanOrEqual(0);
    expect(captureEnd).toBeGreaterThan(captureStart);
    expect(
      writer.slice(captureStart, captureEnd),
    ).toBe(`  local -r expected_revision="$ASIMP_S6_REVISION"
  local -r expected_deployment_id="$ASIMP_S6_DEPLOYMENT_ID"
  local -r expected_agora_host="$apex_host" expected_stoa_host="$agent_host"
  local -r expected_kid="\${ASIMP_S6_SIGNING_KID:-}"
  local -r expected_method="$EVIDENCE_ENVELOPE_METHOD"
  local -r expected_action="$EVIDENCE_ENVELOPE_ACTION"
  local -r expected_payload_sha256="$EVIDENCE_ENVELOPE_PAYLOAD_SHA256"
  local -r expected_principal_pseudonym="$EVIDENCE_ENVELOPE_PRINCIPAL_PSEUDONYM"
  local -r expected_route_template="$EVIDENCE_ENVELOPE_ROUTE_TEMPLATE"
  local -r expected_initial_status="$EVIDENCE_ENVELOPE_INITIAL_STATUS"
  local -r expected_initial_latency_seconds="$EVIDENCE_ENVELOPE_INITIAL_LATENCY_SECONDS"
  local -r expected_replay_status="$EVIDENCE_ENVELOPE_REPLAY_STATUS"
  local -r expected_replay_code="$EVIDENCE_ENVELOPE_REPLAY_CODE"
  local -r expected_replay_latency_seconds="$EVIDENCE_ENVELOPE_REPLAY_LATENCY_SECONDS"
  local -r expected_browser_leg_seconds="$BROWSER_LEG_LATENCY_SECONDS"
  local -r expected_run_seconds="$SECONDS"
  local -r expected_assertions="$ASSERTIONS" expected_failures="$FAILURES"`);
    expect(writer).toContain('"schema_version":4');
    expect(writer).toContain(
      '"revision":{"value":"%s","source":"required_harness_input","verification":"format_only"}',
    );
    expect(writer).toContain(
      '"deployment":{"id":"%s","source":"required_harness_input","verification":"format_only","exercised_origins":{"agora_host":"%s","stoa_host":"%s","source":"exercised_https_origin"}}',
    );
    expect(writer).toContain('"service_envelope":{"kid":"%s","method":"%s"');
    expect(writer).toContain('"cookie_assertions":{"host_only":true');
    expect(writer).toContain('"latency":{"browser_leg_seconds":%s,"run_seconds":%s}');

    const accepted = shellFunction(source, "assert_worker_accepts_valid_envelope");
    const acceptedContract = accepted.indexOf(
      'validate_http_response proposals-present "$RECEIPT"',
    );
    const acceptedLatch = accepted.indexOf('EVIDENCE_ENVELOPE_METHOD="GET"');
    expect(acceptedContract).toBeGreaterThanOrEqual(0);
    expect(acceptedLatch).toBeGreaterThan(acceptedContract);
    const replay = shellFunction(source, "assert_replay_refused");
    const replayContract = replay.indexOf("validate_http_response problem 401 UNAUTHORIZED");
    const replayLatch = replay.indexOf("EVIDENCE_ENVELOPE_REPLAY_STATUS=401");
    expect(replayContract).toBeGreaterThanOrEqual(0);
    expect(replayLatch).toBeGreaterThan(replayContract);
    const browser = shellFunction(source, "run_browser_leg");
    const normalizedPass = browser.indexOf('pass_record "cookie-presented-to-agent-host-refused"');
    const cookieLatch = browser.indexOf("EVIDENCE_COOKIE_ASSERTIONS_VALIDATED=1");
    expect(normalizedPass).toBeGreaterThanOrEqual(0);
    expect(cookieLatch).toBeGreaterThan(normalizedPass);

    const validator = shellFunction(source, "validate_evidence_bundle");
    expect(validator).toContain('minimal_env_command bun "$PLAYWRIGHT_RUNNER" --validate-evidence');
    expect(validator).toContain('run_bounded "$bound" "$validator_file" - "${MINIMAL_CMD[@]}"');
    const outcome = validator.indexOf('if [[ "$RUN_BOUNDED_OUTCOME" == "child" ]]');
    const exactSuccess = validator.indexOf("(( status == 0 )) || return 1", outcome);
    expect(outcome).toBeGreaterThanOrEqual(0);
    expect(exactSuccess).toBeGreaterThan(outcome);
    expect(validator.slice(0, exactSuccess)).not.toContain("read -r");
    const validatorInvocation = validator.slice(
      validator.indexOf("minimal_env_command bun"),
      validator.indexOf("run_bounded"),
    );
    let validatorArg = -1;
    for (const name of [
      "path",
      "expected_revision",
      "expected_deployment_id",
      "expected_agora_host",
      "expected_stoa_host",
      "expected_kid",
      "expected_payload_sha256",
      "expected_principal_pseudonym",
      "expected_initial_latency_seconds",
      "expected_replay_latency_seconds",
      "expected_browser_leg_seconds",
      "expected_run_seconds",
      "expected_assertions",
      "expected_failures",
    ]) {
      const next = validatorInvocation.indexOf(`"$${name}"`, validatorArg + 1);
      expect(next, name).toBeGreaterThan(validatorArg);
      validatorArg = next;
    }

    const modeCheck = writer.indexOf('if [[ "$mode" != "600" ]]');
    const actualValidation = writer.indexOf("validate_evidence_bundle", modeCheck);
    const evidencePath = writer.indexOf('EVIDENCE_PATH="$path"', actualValidation);
    expect(modeCheck).toBeGreaterThanOrEqual(0);
    expect(actualValidation).toBeGreaterThan(modeCheck);
    expect(evidencePath).toBeGreaterThan(actualValidation);
    const runSecondsCapture = writer.indexOf('local -r expected_run_seconds="$SECONDS"');
    const latencyRender = writer.indexOf(
      '"latency":{"browser_leg_seconds":%s,"run_seconds":%s}',
      runSecondsCapture,
    );
    expect(runSecondsCapture).toBeGreaterThanOrEqual(0);
    expect(latencyRender).toBeGreaterThan(runSecondsCapture);
    expect(actualValidation).toBeGreaterThan(latencyRender);
    expect(writer.slice(runSecondsCapture).match(/\$SECONDS/g)).toHaveLength(1);
    const writerInvocation = writer.slice(actualValidation, evidencePath);
    let writerArg = -1;
    for (const name of [
      "path",
      "expected_revision",
      "expected_deployment_id",
      "expected_agora_host",
      "expected_stoa_host",
      "expected_kid",
      "expected_payload_sha256",
      "expected_principal_pseudonym",
      "expected_initial_latency_seconds",
      "expected_replay_latency_seconds",
      "expected_browser_leg_seconds",
      "expected_run_seconds",
      "expected_assertions",
      "expected_failures",
    ]) {
      const next = writerInvocation.indexOf(`"$${name}"`, writerArg + 1);
      expect(next, name).toBeGreaterThan(writerArg);
      writerArg = next;
    }

    const runner = read(RUNNER);
    const cli = runner.indexOf('if (process.argv[2] === "--validate-evidence")');
    const readerStart = runner.indexOf("function readBoundedRegularFile(");
    const readerEnd = runner.indexOf("function browserRecordValidatorMode()", readerStart);
    const reader = runner.slice(readerStart, readerEnd);
    const fileMode = runner.indexOf("function evidenceValidatorMode()");
    expect(readerStart).toBeGreaterThanOrEqual(0);
    expect(readerEnd).toBeGreaterThan(readerStart);
    expect(reader).toContain("fsConstants.O_NOFOLLOW");
    expect(reader).toContain("!before.isFile() || before.size > maximumBytes");
    expect(reader).toContain("after.dev !== before.dev");
    expect(reader).toContain("after.ino !== before.ino");
    expect(reader).toContain("after.size !== before.size");
    expect(fileMode).toBeGreaterThan(readerEnd);
    expect(cli).toBeGreaterThan(fileMode);
    const evidenceMode = runner.slice(fileMode, cli);
    expect(evidenceMode).toContain(
      'readBoundedRegularFile(path, MAX_S6_EVIDENCE_BYTES, "S6 evidence file")',
    );
    expect(evidenceMode).toContain("expected,");
    for (const mapping of [
      "revision: process.argv[4]",
      "deploymentId: process.argv[5]",
      "agoraHost: process.argv[6]",
      "stoaHost: process.argv[7]",
      "kid: process.argv[8]",
      "payloadSha256: process.argv[9]",
      "principalPseudonym: process.argv[10]",
      "initialLatencySeconds: integer(11)",
      "replayLatencySeconds: integer(12)",
      "browserLegSeconds: integer(13)",
      "runSeconds: integer(14)",
      "assertions: integer(15)",
      "failures: integer(16)",
    ]) {
      expect(evidenceMode).toContain(mapping);
    }
  });

  test("finish cannot publish pass with an empty evidence path", () => {
    const finish = shellFunction(source, "finish");
    const write = finish.indexOf("write_evidence_bundle");
    const empty = finish.indexOf('if [[ -z "$EVIDENCE_PATH" ]]', write);
    const refusal = finish.indexOf('fail_record "evidence-present-before-pass"', empty);
    const failureVerdict = finish.indexOf("if (( FAILURES > 0 ))", refusal);
    const passVerdict = finish.indexOf(
      'emit "{\\"suite\\":\\"${SUITE}\\",\\"status\\":\\"pass\\"',
      failureVerdict,
    );
    expect(write).toBeGreaterThanOrEqual(0);
    expect(empty).toBeGreaterThan(write);
    expect(refusal).toBeGreaterThan(empty);
    expect(failureVerdict).toBeGreaterThan(refusal);
    expect(passVerdict).toBeGreaterThan(failureVerdict);
  });
});

describe("the run is bounded and proves its owned-group lifecycle", () => {
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
    const reap = finish.indexOf("reap_children");
    const scan = finish.indexOf("assert_no_secret_escaped");
    const refusal = finish.indexOf("CLEANUP_UNPROVEN");
    const evidence = finish.indexOf("write_evidence_bundle");
    expect(reap).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(evidence).toBeGreaterThanOrEqual(0);
    expect(reap).toBeLessThan(scan);
    expect(refusal).toBeLessThan(evidence);
  });

  test("anonymous supervisor authority exists before any payload fork", () => {
    const bounded = shellFunction(source, "run_bounded");
    const coprocess = bounded.indexOf("coproc S6_BOUNDED_SUPERVISOR");
    const payload = bounded.indexOf("exec {$ARGV[0]} @ARGV");
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

  test("INT/TERM are latched across coproc spawn, registration and READY adoption", () => {
    const bounded = shellFunction(source, "run_bounded");
    const clearLatch = bounded.indexOf('LATCHED_SIGNAL=""');
    const active = bounded.indexOf("SPAWN_REGISTRATION_ACTIVE=1");
    const coprocess = bounded.indexOf("coproc S6_BOUNDED_SUPERVISOR");
    const pid = bounded.indexOf("pid=$!");
    const register = bounded.indexOf('register_child "$pid" "$supervisor_token" "ordinary"');
    const resultFd = bounded.indexOf('exec 5<&"$coproc_read_fd"');
    const adopt = bounded.indexOf('adopt_group_control "$pid" "$supervisor_token"');
    const start = bounded.indexOf('GROUP_PROTOCOL_STATE="input"', adopt);
    const drain = bounded.lastIndexOf("end_spawn_registration_window", start);
    for (const member of [
      clearLatch,
      active,
      coprocess,
      pid,
      register,
      resultFd,
      adopt,
      drain,
      start,
    ]) {
      expect(member).toBeGreaterThanOrEqual(0);
    }
    expect(clearLatch).toBeLessThan(active);
    expect(active).toBeLessThan(coprocess);
    expect(coprocess).toBeLessThan(pid);
    expect(pid).toBeLessThan(register);
    expect(register).toBeLessThan(resultFd);
    expect(resultFd).toBeLessThan(adopt);
    expect(adopt).toBeLessThan(drain);
    expect(drain).toBeLessThan(start);
    const signal = shellFunction(source, "on_signal");
    expect(signal).toContain("SPAWN_REGISTRATION_ACTIVE == 1");
    expect(signal).toContain('LATCHED_SIGNAL="$signal"');
    const close = shellFunction(source, "end_spawn_registration_window");
    const deactivate = close.indexOf("SPAWN_REGISTRATION_ACTIVE=0");
    const snapshot = close.indexOf('local pending="$LATCHED_SIGNAL"');
    const clear = close.indexOf('LATCHED_SIGNAL=""', snapshot);
    expect(deactivate).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeGreaterThan(deactivate);
    expect(clear).toBeGreaterThan(snapshot);
    for (const seam of ["prereg", "handoff"]) {
      for (const dispatched of ["TERM", "INT"]) {
        expect(source).toContain(`registration_signal_plant ${seam} ${dispatched}`);
      }
    }
  });

  test("clean script terminals publish one exact owned-group lifecycle record", () => {
    const lifecycle = shellFunction(source, "publish_lifecycle_settled");
    expect(lifecycle).toContain("${#CHILD_PIDS[@]} == 0");
    expect(lifecycle).toContain('[[ -z "$GROUP_CONTROL_PID" ]]');
    expect(lifecycle).toContain(
      '\\"record_type\\":\\"lifecycle-terminal\\",\\"status\\":\\"pass\\",\\"owned_same_process_groups\\":\\"settled\\"',
    );
    expect(shellFunction(source, "on_exit")).toContain("publish_lifecycle_settled");
  });

  test("the blocked boundary pins its distinctive forbidden-substitutes clause", () => {
    const blocked = shellFunction(source, "emit_blocked_env_record");
    expect(blocked).toContain(
      "a mocked Worker or stubbed Auth.js presented as runtime proof; the in-process unit vectors relabelled as a live run; a hand-written transcript; a recorded fixture replayed as a deployment; a storage-state file presented as live cookie evidence",
    );
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
    expect(settlement).toContain('kernel_identity_state "-${pid}" group');
    expect(settlement).toContain("state == 1");
    const errno = shellFunction(source, "kernel_identity_state");
    expect(errno).toContain("Errno=ESRCH");
    expect(errno).toContain("? 1 : 2");
    const direct = shellFunction(source, "direct_child_settled_before_wait");
    expect(direct).toContain('kernel_identity_state "$pid" direct');
    expect(direct).toContain("kernel_state == 1");
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
  const passRecord = {
    tool: "playwright",
    package: "e2e",
    suite: "s6-cross-plane-browser",
    status: "pass",
    code: "OK",
    apex_host: "preview.example.test",
    agent_host: "a.example.test",
    cookie: {
      issuance_count: 2,
      host_only: true,
      http_only: true,
      secure: true,
      same_site: "lax",
      scoped_to_apex: true,
      present_for_agent_host: false,
    },
    cookie_omission_probe: { attached: false, status: 403, code: "WRONG_PRINCIPAL" },
    cookie_present_probe: { attached: true, status: 403, code: "WRONG_PRINCIPAL" },
    receipt: {
      enrollment_id: "ASIMP-EN-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      absent_before_action: true,
      dedicated_locator: true,
      exact_worker_origin: true,
      exact_join_path: true,
    },
    edge_request_id: null,
    detail: "exact causal fixture",
    duration_ms: 1,
  } as const;
  const encoded = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

  test("one runner-owned strict validator is the shell's only parser", () => {
    const leg = shellFunction(shell, "run_browser_leg");
    expect(leg).toContain("--validate-record");
    expect(runner).toContain("function browserRecordValidatorMode()");
    expect(runner).toContain("selectBrowserEvidenceBytes(");
    expect(leg).not.toContain("grep -F");
    expect(leg).not.toContain("tail -");
    expect(leg).not.toContain("sed -n");
    expect(leg).not.toContain('"host_only":true');
  });

  test("PLANTED: the strict evidence selector accepts only the complete pass", () => {
    expect(selectBrowserEvidenceBytes(encoded(passRecord), 0)).toEqual({
      kind: "pass",
      enrollmentId: passRecord.receipt.enrollment_id,
    });
    const cookieMutations: unknown[] = [
      { ...passRecord, cookie: { ...passRecord.cookie, issuance_count: 0 } },
      { ...passRecord, cookie: { ...passRecord.cookie, issuance_count: 1.5 } },
      { ...passRecord, cookie: { ...passRecord.cookie, issuance_count: "2" } },
      { ...passRecord, cookie: { ...passRecord.cookie, host_only: false } },
      { ...passRecord, cookie: { ...passRecord.cookie, http_only: false } },
      { ...passRecord, cookie: { ...passRecord.cookie, secure: false } },
      { ...passRecord, cookie: { ...passRecord.cookie, same_site: "none" } },
      { ...passRecord, cookie: { ...passRecord.cookie, scoped_to_apex: false } },
      { ...passRecord, cookie: { ...passRecord.cookie, present_for_agent_host: true } },
      {
        ...passRecord,
        cookie: { ...passRecord.cookie, unexpected: true },
      },
      {
        ...passRecord,
        cookie_omission_probe: { attached: true, status: 403, code: "WRONG_PRINCIPAL" },
      },
      {
        ...passRecord,
        cookie_omission_probe: { attached: false, status: 200, code: "WRONG_PRINCIPAL" },
      },
      {
        ...passRecord,
        cookie_omission_probe: { attached: false, status: 403.5, code: "WRONG_PRINCIPAL" },
      },
      {
        ...passRecord,
        cookie_omission_probe: { attached: false, status: 403, code: "UNAUTHORIZED" },
      },
      {
        ...passRecord,
        cookie_omission_probe: { attached: false, status: 403, code: null },
      },
      {
        ...passRecord,
        cookie_omission_probe: { ...passRecord.cookie_omission_probe, unexpected: true },
      },
      {
        ...passRecord,
        cookie_present_probe: { attached: false, status: 403, code: "WRONG_PRINCIPAL" },
      },
      {
        ...passRecord,
        cookie_present_probe: { attached: true, status: 200, code: "WRONG_PRINCIPAL" },
      },
      {
        ...passRecord,
        cookie_present_probe: { attached: true, status: 403.5, code: "WRONG_PRINCIPAL" },
      },
      {
        ...passRecord,
        cookie_present_probe: { attached: true, status: 403, code: "UNAUTHORIZED" },
      },
      {
        ...passRecord,
        cookie_present_probe: { attached: true, status: 403, code: null },
      },
      {
        ...passRecord,
        cookie_present_probe: { ...passRecord.cookie_present_probe, unexpected: true },
      },
    ];
    for (const mutation of cookieMutations) {
      expect(() => selectBrowserEvidenceBytes(encoded(mutation), 0)).toThrow();
    }
    expect(() =>
      selectBrowserEvidenceBytes(
        encoded({ ...passRecord, receipt: { ...passRecord.receipt, exact_worker_origin: false } }),
        0,
      ),
    ).toThrow();
    expect(() => selectBrowserEvidenceBytes(encoded(passRecord), 1)).toThrow();
  });

  test("PLANTED: malformed, duplicate, non-LF and over-cap transcripts refuse", () => {
    const valid = encoded(passRecord);
    expect(() => selectBrowserEvidenceBytes(Buffer.concat([valid, valid]), 0)).toThrow();
    expect(() => selectBrowserEvidenceBytes(valid.subarray(0, valid.length - 1), 0)).toThrow();
    expect(() => selectBrowserEvidenceBytes(Buffer.from([0xff, 0x0a]), 0)).toThrow();
    expect(() =>
      selectBrowserEvidenceBytes(Buffer.alloc(MAX_BROWSER_EVIDENCE_BYTES + 1, 0x61), 0),
    ).toThrow();
    const duplicateStatus = JSON.stringify(passRecord).replace(
      '"status":"pass"',
      '"status":"fail","status":"pass"',
    );
    expect(() =>
      selectBrowserEvidenceBytes(Buffer.from(`${duplicateStatus}\n`, "utf8"), 0),
    ).toThrow();
    expect(() =>
      selectBrowserEvidenceBytes(
        encoded({ ...passRecord, extra: { status: "pass", code: "OK" } }),
        0,
      ),
    ).toThrow();
    expect(() =>
      selectBrowserEvidenceBytes(
        encoded({
          ...passRecord,
          status: "fail",
          detail: 'misnested {"status":"pass","code":"OK"}',
        }),
        0,
      ),
    ).toThrow();
  });

  test("edge correlation remains nullable and is not a deployment gate", () => {
    expect(runner).toContain("edge_request_id");
    expect(runner).not.toContain('headers()["x-vercel-deployment-url"]');
    expect(shell).not.toContain("edge-request-identified");
    expect(shell).not.toMatch(/immutable deployment/i);
    expect(shell).not.toMatch(/pinned to deployment/i);
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
    const entrypoint = runner.slice(
      runner.indexOf("async function runEntrypoint()"),
      runner.indexOf("// Importing this module"),
    );
    const publish = runner.slice(
      runner.indexOf("function publishTerminal("),
      runner.indexOf("/**\n * Apply the lifecycle verdict"),
    );
    expect(entrypoint).toContain("error instanceof RunnerExit");
    expect(entrypoint).toContain(
      "resolveTerminalOutcome(outcome, teardownFailed, deadlineExceeded)",
    );
    expect(entrypoint).toContain("publishTerminal(terminal)");
    expect(publish).toContain("emit(terminal.record)");
    expect(publish).toContain("process.exit(terminal.exitStatus)");
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

  test("terminal bytes are fully synchronous before process.exit", () => {
    const writer = runner.slice(
      runner.indexOf("export function writeAllSync("),
      runner.indexOf("function emit("),
    );
    expect(writer).toContain("while (offset < bytes.length)");
    expect(writer).toContain("writer(fd, bytes, offset, bytes.length - offset)");
    expect(writer).toContain('code === "EINTR"');
    expect(writer).toContain("writeAllSync(1, Buffer.from");
    expect(runner).not.toContain("process.stdout.write(");
  });

  test("PLANTED: terminal writes retry EINTR, resume short writes, and reject no progress", () => {
    const calls: Array<[number, number]> = [];
    let attempt = 0;
    writeAllSync(7, Buffer.from("abcd"), (_fd, _bytes, offset, length) => {
      calls.push([offset, length]);
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error("interrupted"), { code: "EINTR" });
      }
      return attempt === 2 ? 2 : length;
    });
    expect(calls).toEqual([
      [0, 4],
      [0, 4],
      [2, 2],
    ]);
    expect(() => writeAllSync(7, Buffer.from("x"), () => 0)).toThrow(
      "synchronous writer made invalid progress",
    );
  });

  test("natural omission and explicit cookie presentation are named separately", () => {
    expect(runner).toContain("Direction A: natural browser eligibility");
    expect(runner).toContain("Direction B: a separate in-memory context explicitly presents");
    expect(runner).toContain("cookie_omission_probe");
    expect(runner).toContain("cookie_present_probe");
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
    const exact = body.indexOf("validate_http_response problem 401 UNAUTHORIZED");
    const failure = body.indexOf("fail_record", exact);
    expect(exact).toBeGreaterThanOrEqual(0);
    expect(failure).toBeGreaterThan(exact);
    expect(body).toContain("routing/content-type refusals are not accepted");
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
      expect(stdout, diag(run)).toContain('"assertion":"input-start-is-bounded","status":"pass"');
      expect(stdout, diag(run)).toContain('"assertion":"input-mid-is-bounded","status":"pass"');
      expect(stdout, diag(run)).toContain(
        '"assertion":"input-depart-mid-is-bounded","status":"pass"',
      );
      expect(stdout, diag(run)).toContain('"assertion":"typed-child-status-125","status":"pass"');
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
      for (const seam of ["prereg", "handoff"]) {
        for (const signal of ["TERM", "INT"]) {
          for (const suffix of [
            "registration-barrier-armed",
            "dispatch-succeeded",
            "is-interruption",
            "prevents-payload-fork",
            "exact-two-record-transcript",
          ]) {
            expect(stdout, diag(run)).toContain(
              `"assertion":"${seam}-${signal}-${suffix}","status":"pass"`,
            );
          }
        }
      }
      for (const assertion of [
        "direct-inspection-error-refuses-settlement",
        "direct-inspection-error-owner-eventually-reaped",
        "group-inspection-error-is-cleanup-unproven",
        "group-inspection-error-retains-owner",
        "group-inspection-error-owner-eventually-reaped",
      ]) {
        expect(stdout, diag(run)).toContain(`"assertion":"${assertion}","status":"pass"`);
      }
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

describe("the outer capability protocol is strict under stream framing", () => {
  test("the loopback claim is first-connector transcript binding, not peer authentication", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    const controller = self.slice(
      self.indexOf("async function runShell("),
      self.indexOf("/** Failure context."),
    );
    expect(controller).toContain("no-competing-active-local-connector assumption");
    expect(controller).toContain("This is not peer authentication.");
    expect(controller).not.toContain("target-authenticated");
    expect(controller).not.toContain("authenticated socket");
  });

  test("PLANTED: split READY and coalesced STARTED+CHILD parse exactly once", async () => {
    const pair = await testSocketPair();
    const token = "planttoken0123456789";
    const protocol = new OuterSupervisorProtocol(pair.parent, token);
    try {
      const boot = protocol.bootstrap(Date.now() + 500);
      feedProtocolPlant(protocol, "outer-rea");
      feedProtocolPlant(protocol, `dy:${token}\n`);
      expect(await boot).toBe(true);

      const start = protocol.start(Date.now() + 500);
      feedProtocolPlant(protocol, `outer-started:${token}\nouter-child:${token}:0\n`);
      expect(await start).toBe(true);
      expect(await protocol.terminal).toEqual({ kind: "child", status: 0 });

      feedProtocolPlant(protocol, `outer-child:${token}:0\n`);
      expect(protocol.protocolFailure()?.message).toContain("duplicate CHILD");
    } finally {
      protocol.expectClosure();
      await pair.close();
    }
  });

  test("PLANTED: write backpressure waits for callback and callback timeout refuses", async () => {
    const token = "planttokenbackpressure";
    const successPair = await testSocketPair();
    let callbackObserved = false;
    const delayedWrite: OuterSocketWrite = (_bytes, callback) => {
      setTimeout(() => {
        callbackObserved = true;
        callback();
      }, 10);
      return false;
    };
    const successProtocol = new OuterSupervisorProtocol(successPair.parent, token, delayedWrite);
    try {
      const boot = successProtocol.bootstrap(Date.now() + 500);
      feedProtocolPlant(successProtocol, `outer-ready:${token}\n`);
      expect(await boot).toBe(true);
      expect(callbackObserved).toBe(true);
    } finally {
      successProtocol.expectClosure();
      await successPair.close();
    }

    const timeoutPair = await testSocketPair();
    const stalledWrite: OuterSocketWrite = () => false;
    const timeoutProtocol = new OuterSupervisorProtocol(timeoutPair.parent, token, stalledWrite);
    try {
      const boot = timeoutProtocol.bootstrap(Date.now() + 100);
      feedProtocolPlant(timeoutProtocol, `outer-ready:${token}\n`);
      expect(await boot).toBe(false);
      expect(timeoutProtocol.protocolFailure()?.message).toContain("write callback timeout");
    } finally {
      timeoutProtocol.expectClosure();
      await timeoutPair.close();
    }
  });

  test("PLANTED: unsolicited ACK and close at each bootstrap boundary refuse", async () => {
    const token = "planttokenbootstrap";
    const earlyPair = await testSocketPair();
    const earlyProtocol = new OuterSupervisorProtocol(earlyPair.parent, token);
    try {
      const boot = earlyProtocol.bootstrap(Date.now() + 500);
      feedProtocolPlant(earlyProtocol, `outer-ack:${token}:TERM\n`);
      expect(await boot).toBe(false);
      expect(earlyProtocol.protocolFailure()?.message).toContain("out-of-order record");
    } finally {
      earlyProtocol.expectClosure();
      await earlyPair.close();
    }

    const beforeReadyPair = await testSocketPair();
    const beforeReadyProtocol = new OuterSupervisorProtocol(beforeReadyPair.parent, token);
    try {
      const boot = beforeReadyProtocol.bootstrap(Date.now() + 500);
      beforeReadyPair.peer.destroy();
      expect(await boot).toBe(false);
      expect(beforeReadyProtocol.protocolFailure()?.message).toContain(
        "before expected acknowledgement",
      );
    } finally {
      beforeReadyProtocol.expectClosure();
      await beforeReadyPair.close();
    }

    const beforeStartPair = await testSocketPair();
    const beforeStartProtocol = new OuterSupervisorProtocol(beforeStartPair.parent, token);
    try {
      const boot = beforeStartProtocol.bootstrap(Date.now() + 500);
      feedProtocolPlant(beforeStartProtocol, `outer-ready:${token}\n`);
      expect(await boot).toBe(true);
      const start = beforeStartProtocol.start(Date.now() + 500);
      beforeStartPair.peer.destroy();
      expect(await start).toBe(false);
      expect(beforeStartProtocol.protocolFailure()?.message).toContain(
        "before expected acknowledgement",
      );
    } finally {
      beforeStartProtocol.expectClosure();
      await beforeStartPair.close();
    }
  });
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
    expect(supervisor).toContain("$^F=9; defined(setpgrp(0,0)) or die $!;");
    expect(supervisor).not.toContain("POSIX::setpgrp");
    expect(supervisor).not.toContain("$^F=9; setpgrp(0,0) or die $!;");
    expect(supervisor).toContain("/dev/tcp/127.0.0.1/$port");
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

  test("PLANTED: supervisor exit wins the pre-connect race without a signal", async () => {
    const commands: Array<"TERM" | "KILL"> = [];
    let refusal: unknown;
    try {
      await runShell([], withoutS6Env(), SCRIPT, {
        runTimeoutMs: 500,
        postKillSettleMs: 500,
        supervisorExitBeforeConnect: true,
        onControlSignal: (signal) => commands.push(signal),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain(
      "outer supervisor exited before capability connect: exit=73",
    );
    expect(commands).toEqual([]);
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

  test("PLANTED: KILL acknowledgement without supervisor settlement is bounded", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-outer-kill-hold-"));
    const plant = join(dir, "term-resistant.sh");
    const ready = join(dir, "ready");
    writeFileSync(
      plant,
      `#!/usr/bin/env bash
trap '' TERM
printf ready > "$1"
while :; do IFS= read -r -t 30 _ || true; done
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
        killGraceMs: 10,
        postKillSettleMs: 75,
        controlKillHoldMs: 250,
        onControlSignal: (signal) => commands.push(signal),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("cleanup unproven");
    expect(commands).toEqual(["TERM", "KILL"]);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The supervisor retains its own eventual self-KILL after the parent has
    // honestly refused; let that bounded retirement finish before this plant
    // releases its test scope.
    await Bun.sleep(300);
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

  test("PLANTED: timeout TERM completion prevents grace-expiry escalation", async () => {
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
    expect(run.graceExpiredEscalation, diag(run)).toBe(false);
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
    expect(run.graceExpiredEscalation, diag(run)).toBe(true);
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
    expect((refusal as Error).message).toContain(
      "cleanup unproven: supervisor KILL command failed",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(commands).toEqual(["TERM"]);
    expect(readFileSync(termObserved, "utf8")).toBe("term-observed");
  });

  test("PLANTED: only one exact positive lifecycle terminal can prove settlement", () => {
    const assertionRecords = ["one", "two", "three"]
      .map(
        (assertion) =>
          `{"suite":"s6-cross-plane-auth","assertion":"${assertion}","status":"pass","detail":"plant","reproduce":"bash scripts/e2e-s6-cross-plane-auth.sh"}`,
      )
      .join("\n");
    const aggregate =
      '{"suite":"s6-cross-plane-auth","status":"pass","assertions":3,"failures":0,"reproduce":"bash scripts/e2e-s6-cross-plane-auth.sh"}';
    const lifecycle =
      '{"suite":"s6-cross-plane-auth","record_type":"lifecycle-terminal","status":"pass","owned_same_process_groups":"settled"}';
    const exact = `${assertionRecords}\n${aggregate}\n${lifecycle}\n`;
    const refused = { cleanupUnproven: true, ownedSameProcessGroupsSettled: false };
    expect(shellLifecycleFromRecords(exact, 0)).toEqual({
      cleanupUnproven: false,
      ownedSameProcessGroupsSettled: true,
    });
    for (const transcript of [
      `${assertionRecords}\n${aggregate}\n`,
      `not-json\n${assertionRecords}\n${aggregate}\n${lifecycle}\n`,
      `${assertionRecords}\n${aggregate}\n${lifecycle}`,
      `${assertionRecords}\n${aggregate}\n${lifecycle}\n${lifecycle}\n`,
      `${assertionRecords}\n${aggregate}\n${lifecycle}\n${aggregate}\n`,
      `${assertionRecords}\n${aggregate}\n${lifecycle.replace(
        "s6-cross-plane-auth",
        "another-suite",
      )}\n`,
      `${assertionRecords}\n${aggregate}\n${lifecycle.replace(
        '"owned_same_process_groups":"settled"',
        '"owned_same_process_groups":"settled","extra":true',
      )}\n`,
      ` ${assertionRecords}\n${aggregate}\n${lifecycle}\n`,
      `${assertionRecords}\n${aggregate}\n${aggregate}\n${lifecycle}\n`,
      `${assertionRecords}\n${aggregate.replace('"assertions":3', '"assertions":4')}\n${lifecycle}\n`,
      `{"suite":"s6-cross-plane-auth","assertion":"ordinary","status":"pass"}\n${aggregate}\n${lifecycle}\n`,
    ]) {
      expect(shellLifecycleFromRecords(transcript, 0)).toEqual(refused);
    }
    expect(shellLifecycleFromRecords(exact, 1)).toEqual(refused);
    expect(shellLifecycleFromRecords(exact, 125)).toEqual(refused);
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
    expect(run.outerSupervisorSettledAfterRetirementProtocol, diag(run)).toBe(true);
    expect(run.nestedOwnedSameProcessGroupsSettled, diag(run)).toBeNull();
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
    "an ordinary trusted run proves outer and nested owned-group settlement",
    async () => {
      // The claim is scoped to OUR group. The script's own nested groups are
      // covered by its plants below; this controller cannot see them, and on a
      // hard-killed run it reports `cleanupUnproven` rather than pretending to.
      const run = await sharedSelfTest();
      expect(run.timedOut, diag(run)).toBe(false);
      expect(run.cleanupUnproven, diag(run)).toBe(false);
      expect(run.outerSupervisorSettledAfterRetirementProtocol, diag(run)).toBe(true);
      expect(run.nestedOwnedSameProcessGroupsSettled, diag(run)).toBe(true);
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
      "timedOut || exitCode === 125 || (shellLifecycle?.cleanupUnproven ?? false)",
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
      expect(run.nestedOwnedSameProcessGroupsSettled, diag(run)).toBe(true);
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
