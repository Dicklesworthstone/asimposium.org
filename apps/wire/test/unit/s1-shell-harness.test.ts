import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EnrollmentHelloResponseSchema } from "@asimposium/contracts";

import {
  boundedLocalResponse,
  LOCAL_D1_COMPLETION_SKIP_PLANT,
  LOCAL_D1_EVIDENCE_CASES,
  LOCAL_RESPONSE_MAX_BYTES,
} from "../../src/enrollment/local-d1-client.ts";

// Most cases launch the harness through its own bounded controller. Bun's
// unrelated 5-second default can kill that controller during legitimate group
// retirement and leave the assertion reading a synthetic dangling-child exit.
// Explicit per-test bounds remain authoritative where they are declared below.
setDefaultTimeout(60_000);

/**
 * Lifecycle contract of the S-1 shell harness.
 *
 * `scripts/e2e-s1-cold-enrollment.sh` starts a real `wrangler dev` (workerd)
 * child. Three properties are asserted here because each one was previously
 * unproven, and each failure mode is one a developer meets as a confusing
 * second run rather than as an error:
 *
 *  - a caller-pinned port is validated and refused when busy, instead of being
 *    handed to wrangler to fail on later or, worse, being served by whatever was
 *    already listening;
 *  - two runs in parallel do not collide: ports and state directories are
 *    per-run, and both runs pass;
 *  - a TERM to the script terminates the whole child process group and retains
 *    the state directory, so nothing is orphaned holding a port or a D1 lock.
 *
 * The blocked external proof — three live harnesses, OAuth, staging — must stay
 * blocked, and is asserted here so a local pass can never be mistaken for it.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = "scripts/e2e-s1-cold-enrollment.sh";
const WRANGLER = resolve(REPO_ROOT, "apps/wire/node_modules/wrangler-s1-local/bin/wrangler.js");
const TRUSTED_ENV = "/usr/bin/env";
const STARTUP_CONTROL_NAMES = [
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "BASH_XTRACEFD",
  "PS4",
] as const;
const CAPTURE_TARGET_FUNCTION_HANDOFFS = [
  ["BASH_FUNC_printf%%", "S1_CAPTURE_TARGET_BASH_FUNC_PRINTF"],
  ["BASH_FUNC_set%%", "S1_CAPTURE_TARGET_BASH_FUNC_SET"],
] as const;
const TRUSTED_BASH_CANDIDATES = [
  "/opt/homebrew/bin/bash",
  "/usr/local/bin/bash",
  "/usr/bin/bash",
  "/bin/bash",
] as const;

function scrubStartupControls(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...environment };
  for (const name of STARTUP_CONTROL_NAMES) delete scrubbed[name];
  return scrubbed;
}

const locatedTrustedBash = TRUSTED_BASH_CANDIDATES.find(
  (candidate) =>
    spawnSync(candidate, ["-c", `test "\${BASH_VERSINFO[0]:-0}" -ge 4`], {
      env: scrubStartupControls(process.env),
      stdio: "ignore",
    }).status === 0,
);
if (locatedTrustedBash === undefined) throw new Error("S1_TEST_BASH_4_REQUIRED");
const TRUSTED_BASH: string = locatedTrustedBash;

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SocketCapture {
  port: number;
  connected: Promise<void>;
  finished: Promise<void>;
  reader: PipeReader;
  byteCount(): number;
  overflowed(): boolean;
  text(): string;
  close(): void;
}

const CAPTURE_LIMIT_BYTES = 256 * 1024;

async function socketCapture(): Promise<SocketCapture> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("expected a loopback TCP capture listener");
  }

  const decoder = new TextDecoder();
  const queued: Uint8Array[] = [];
  let captured = "";
  let capturedBytes = 0;
  let didOverflow = false;
  let ended = false;
  let pendingRead: ((result: { done: boolean; value?: Uint8Array }) => void) | undefined;
  let parentSide: Socket | undefined;
  let resolveFinished: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const finishReader = () => {
    if (ended) return;
    ended = true;
    captured += decoder.decode();
    pendingRead?.({ done: true });
    pendingRead = undefined;
    resolveFinished?.();
    resolveFinished = undefined;
  };
  const reader: PipeReader = {
    read() {
      const next = queued.shift();
      if (next) return Promise.resolve({ done: false, value: next });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolveRead) => {
        pendingRead = resolveRead;
      });
    },
    async cancel() {
      parentSide?.destroy();
      finishReader();
    },
  };
  const connected = new Promise<void>((resolveConnection) => {
    server.once("connection", (socket) => {
      parentSide = socket;
      socket.on("data", (chunk: Buffer) => {
        capturedBytes += chunk.byteLength;
        if (didOverflow || capturedBytes > CAPTURE_LIMIT_BYTES) {
          didOverflow = true;
          return;
        }
        const bytes = new Uint8Array(chunk);
        captured += decoder.decode(bytes, { stream: true });
        if (pendingRead) {
          const resolveRead = pendingRead;
          pendingRead = undefined;
          resolveRead({ done: false, value: bytes });
        } else {
          queued.push(bytes);
        }
      });
      socket.once("end", finishReader);
      socket.once("close", finishReader);
      socket.once("error", finishReader);
      server.close();
      resolveConnection();
    });
  });
  return {
    port: address.port,
    connected,
    finished,
    reader,
    byteCount: () => capturedBytes,
    overflowed: () => didOverflow,
    text: () => captured,
    close() {
      server.close();
      parentSide?.destroy();
      finishReader();
    },
  };
}

async function settleSocketCapture(capture: SocketCapture): Promise<string> {
  const connected = await Promise.race([
    capture.connected.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!connected) throw new Error("S1_CAPTURE_CONNECTION_TIMEOUT");
  const finished = await Promise.race([
    capture.finished.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!finished) throw new Error("S1_CAPTURE_EOF_TIMEOUT");
  assertCaptureComplete(capture);
  return capture.text();
}

function assertCaptureComplete(capture: SocketCapture): void {
  if (capture.overflowed()) {
    throw new Error(`S1_CAPTURE_LIMIT_EXCEEDED bytes=${capture.byteCount()}`);
  }
}

interface CapturedHarness {
  child: SpawnedHarness;
  stdoutCapture: SocketCapture;
  stderrCapture: SocketCapture;
  closeCaptures(): void;
}

interface FileCapturedHarness {
  child: SpawnedHarness;
  stdoutPath: string;
  stderrPath: string;
}

function spawnFileCapturedHarness(
  args: readonly string[],
  env: Record<string, string>,
  trace: boolean,
): FileCapturedHarness {
  const directory = mkdtempSync(join(tmpdir(), "asimposium-s1-test-capture."));
  const directoryEntry = lstatSync(directory);
  if (
    !directoryEntry.isDirectory() ||
    directoryEntry.isSymbolicLink() ||
    (directoryEntry.mode & 0o777) !== 0o700
  ) {
    throw new Error("S1_FILE_CAPTURE_DIRECTORY_UNTRUSTED");
  }
  const stdoutPath = join(directory, "stdout");
  const stderrPath = join(directory, "stderr");
  const captureFlags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const stdoutDescriptor = openSync(stdoutPath, captureFlags, 0o600);
  closeSync(stdoutDescriptor);
  const stderrDescriptor = openSync(stderrPath, captureFlags, 0o600);
  closeSync(stderrDescriptor);
  const launch = trace
    ? 'set -e; stdout="$1"; stderr="$2"; shift 2; exec 1>>"$stdout" 2>>"$stderr"; exec bash -x "$@"'
    : 'set -e; stdout="$1"; stderr="$2"; shift 2; exec 1>>"$stdout" 2>>"$stderr"; exec bash "$@"';
  const subprocess = spawn(
    "bash",
    ["-c", launch, "s1-test-capture", stdoutPath, stderrPath, SCRIPT, ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      // Bun 1.3.8 can close parent-opened numeric descriptors in nested test
      // children. The wrapper opens these already-created private files itself;
      // stderr stays inherited only until both redirections have succeeded.
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    subprocess.once("error", rejectExit);
    subprocess.once("exit", (code, signal) => {
      resolveExit(code ?? (signal === null ? 1 : 128));
    });
  });
  return {
    child: {
      exited,
      get exitCode() {
        return subprocess.exitCode;
      },
      kill(signal) {
        return subprocess.kill(signal);
      },
    },
    stdoutPath,
    stderrPath,
  };
}

function readStableFileCapture(path: string): string {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > CAPTURE_LIMIT_BYTES
  ) {
    throw new Error("S1_FILE_CAPTURE_UNTRUSTED");
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.nlink !== 1 ||
    after.size !== before.size ||
    bytes.byteLength !== before.size
  ) {
    throw new Error("S1_FILE_CAPTURE_DRIFT");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("S1_FILE_CAPTURE_UTF8_INVALID");
  }
}

async function spawnCapturedHarness(
  args: readonly string[],
  env: Record<string, string> = {},
  trace = false,
): Promise<CapturedHarness> {
  const [stdoutCapture, stderrCapture] = await Promise.all([socketCapture(), socketCapture()]);
  const launch = trace
    ? 'set -e; exec 3<>"/dev/tcp/127.0.0.1/$1"; exec 4<>"/dev/tcp/127.0.0.1/$2"; exec 1>&3 2>&4; shift 2; exec bash -x "$@"'
    : 'set -e; exec 3<>"/dev/tcp/127.0.0.1/$1"; exec 4<>"/dev/tcp/127.0.0.1/$2"; exec 1>&3 2>&4; shift 2; exec bash "$@"';
  const subprocess = spawn(
    "bash",
    [
      "-c",
      launch,
      "s1-test-capture",
      String(stdoutCapture.port),
      String(stderrCapture.port),
      SCRIPT,
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      // Bun 1.3's test runner can close anonymous stdout/stderr pipes before
      // the child begins executing. Start on inherited descriptors, then have
      // bash connect its output to these in-memory loopback listeners.
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    subprocess.once("error", rejectExit);
    subprocess.once("exit", (code, signal) => {
      resolveExit(code ?? (signal === null ? 1 : 128));
    });
  });
  const child: SpawnedHarness = {
    exited,
    get exitCode() {
      return subprocess.exitCode;
    },
    kill(signal) {
      return subprocess.kill(signal);
    },
  };
  return {
    child,
    stdoutCapture,
    stderrCapture,
    closeCaptures() {
      stdoutCapture.close();
      stderrCapture.close();
    },
  };
}

function safeCaptureSummary(value: string): string {
  const lines = value.split("\n").filter(Boolean);
  const codes = lines.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try {
      const parsed = JSON.parse(line) as { code?: unknown };
      return typeof parsed.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.code)
        ? [parsed.code]
        : [];
    } catch {
      return [];
    }
  });
  const phases = lines.flatMap((line) => {
    const match = line.match(/^\[s1-cold-enrollment\] ([a-z][a-z0-9-]{0,63})(?:\s|$)/);
    return match?.[1] ? [match[1]] : [];
  });
  return `bytes=${Buffer.byteLength(value)} lines=${lines.length} codes=${[...new Set(codes)].join(",") || "none"} phases=${[...new Set(phases)].join(",") || "none"}`;
}

function failureEvidence(run: Run): string {
  const relevantEnvironment = Object.keys(process.env)
    .filter((key) => /^(?:ASIMP_S1_|BASH|BUN|CI$|NODE|S1_|SHELLOPTS)/.test(key))
    .sort()
    .join(" ");
  return `exit=${run.exitCode}\nenv_keys=${relevantEnvironment || "none"}\nstdout=${safeCaptureSummary(run.stdout)}\nstderr=${safeCaptureSummary(run.stderr)}`;
}

async function runScript(
  args: readonly string[],
  env: Record<string, string> = {},
  trace = false,
): Promise<Run> {
  // Wrangler/Workerd exits with a ProxyWorker `Network connection lost` error
  // when this supported Bun starts the complete local-D1 tree beneath the live
  // TCP capture used by the phase-driven signal tests. Anonymous pipes are also
  // unreliable under `bun test`. Private regular files give ordinary runs a
  // stable capture in private, pre-created regular files without changing the
  // live-reader seam.
  const { child, stdoutPath, stderrPath } = spawnFileCapturedHarness(args, env, trace);
  try {
    const exitCode = await waitForExitBefore(child.exited, RUN_SCRIPT_TIMEOUT_MS);
    if (exitCode === undefined) {
      const forcedExit = await terminateExactChild(child);
      throw new Error(`script exceeded its test deadline; forced_exit=${String(forcedExit)}`);
    }
    const stdout = readStableFileCapture(stdoutPath);
    const stderr = readStableFileCapture(stderrPath);
    return { exitCode, stdout, stderr };
  } finally {
    await terminateExactChild(child);
  }
}

async function runCapturedProcess(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
  privilegedCapture = true,
): Promise<Run> {
  const [stdoutCapture, stderrCapture] = await Promise.all([socketCapture(), socketCapture()]);
  const targetEnvironment = { ...process.env, ...env };
  const captureEnvironment = scrubStartupControls(targetEnvironment);
  for (const name of STARTUP_CONTROL_NAMES) {
    const value = targetEnvironment[name];
    const handoffName = `S1_CAPTURE_TARGET_${name}`;
    if (value === undefined) delete captureEnvironment[handoffName];
    else captureEnvironment[handoffName] = value;
  }
  for (const [functionName, handoffName] of CAPTURE_TARGET_FUNCTION_HANDOFFS) {
    const value = targetEnvironment[functionName];
    if (value === undefined) delete captureEnvironment[handoffName];
    else captureEnvironment[handoffName] = value;
    // A privileged Bash may preserve an unimported BASH_FUNC_* variable for
    // its child. Remove the raw name so the target proof depends only on Perl's
    // explicit reintroduction; the false-green control remains unprivileged.
    if (privilegedCapture) delete captureEnvironment[functionName];
  }
  const launch = `set -e
exec 3<>"/dev/tcp/127.0.0.1/$1"
exec 4<>"/dev/tcp/127.0.0.1/$2"
exec 1>&3 2>&4
shift 2
exec /usr/bin/perl -e '
  my @names = qw(BASH_ENV ENV SHELLOPTS BASHOPTS BASH_XTRACEFD PS4);
  for my $name (@names) {
    my $handoff = "S1_CAPTURE_TARGET_$name";
    if (exists $ENV{$handoff}) { $ENV{$name} = $ENV{$handoff}; }
    else { delete $ENV{$name}; }
    delete $ENV{$handoff};
  }
  my @function_handoffs = (
    ["S1_CAPTURE_TARGET_BASH_FUNC_PRINTF", "BASH_FUNC_printf%%"],
    ["S1_CAPTURE_TARGET_BASH_FUNC_SET", "BASH_FUNC_set%%"],
  );
  for my $function_handoff (@function_handoffs) {
    my ($handoff, $name) = @$function_handoff;
    if (exists $ENV{$handoff}) { $ENV{$name} = $ENV{$handoff}; }
    else { delete $ENV{$name}; }
    delete $ENV{$handoff};
  }
  exec { $ARGV[0] } @ARGV or die "S1_CAPTURE_TARGET_EXEC_FAILED\\n";
' "$@"`;
  const subprocess = spawn(
    TRUSTED_ENV,
    [
      "-u",
      "BASH_ENV",
      "-u",
      "ENV",
      "-u",
      "SHELLOPTS",
      "-u",
      "BASHOPTS",
      "-u",
      "BASH_XTRACEFD",
      "-u",
      "PS4",
      TRUSTED_BASH,
      ...(privilegedCapture ? ["-p"] : []),
      "-c",
      launch,
      "s1-prestart-capture",
      String(stdoutCapture.port),
      String(stderrCapture.port),
      command,
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      env: captureEnvironment,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    subprocess.once("error", rejectExit);
    subprocess.once("exit", (code, signal) => {
      resolveExit(code ?? (signal === null ? 1 : 128));
    });
  });
  const child: SpawnedHarness = {
    exited,
    get exitCode() {
      return subprocess.exitCode;
    },
    kill(signal) {
      return subprocess.kill(signal);
    },
  };
  try {
    const exitCode = await waitForExitBefore(child.exited, RUN_SCRIPT_TIMEOUT_MS);
    if (exitCode === undefined) {
      await terminateExactChild(child);
      throw new Error("S1_DIRECT_SCRIPT_TIMEOUT");
    }
    const [stdout, stderr] = await Promise.all([
      settleSocketCapture(stdoutCapture),
      settleSocketCapture(stderrCapture),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await terminateExactChild(child);
    stdoutCapture.close();
    stderrCapture.close();
  }
}

function runDirectScript(args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  return runCapturedProcess(SCRIPT, args, env);
}

/** The runner's own NDJSON record, which is the last JSON line it prints. */
function record(run: Run): Record<string, unknown> {
  const line = records(run).at(-1);
  expect(line).toBeDefined();
  return line as Record<string, unknown>;
}

function records(run: Run): Array<Record<string, unknown>> {
  return run.stdout
    .trim()
    .split("\n")
    .filter((entry) => entry.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error("S1_OUTPUT_RECORD_INVALID");
      }
    });
}

function enrollmentEnv(origin: string): Record<string, string> {
  return {
    ASIMP_S1_JOIN_URL: `${origin}/join/ASIMP-EN-7F3K9M2Q8R#v1.${"A".repeat(43)}`,
    ASIMP_S1_FELLOW_NAME: "orchid-vector",
    ASIMP_S1_MODEL: "test-model",
    ASIMP_S1_HARNESS: "codex",
    ASIMP_S1_TEST_ALLOW_HTTP: "1",
    ASIMP_S1_LOOPBACK_SELF_TEST: "loopback-enrollment-v1",
  };
}

function validHelloResponse(
  origin: string,
  nextActions = [
    { action: "read", url: `${origin}/protocol.md`, reason: "read the protocol" },
    { action: "read", url: `${origin}/skill.md`, reason: "read the skill" },
  ],
) {
  return EnrollmentHelloResponseSchema.parse({
    fellow: {
      fellow_id: "fellow-s1-loopback",
      name: "orchid-vector",
      model: "test-model",
      harness: "codex",
    },
    granted_scopes: ["review"],
    granted_resources: {
      problem_binding: "P-7F3K",
      event_budget: 12,
      fellow_grant_expires_at: 1_900_000_000_000,
    },
    next_actions: nextActions,
  });
}

const OVERSIZED_RESPONSE_SENTINEL = "S1_OVERSIZE_RESPONSE_SENTINEL";
const OVERSIZED_RESPONSE_BYTES = new TextEncoder().encode(
  `${OVERSIZED_RESPONSE_SENTINEL}:${"x".repeat(300_000)}`,
);
const ARTIFACT_SCAN_EXACT_KEY_CANARY = "S1ArtifactScanCanary_0123456789abcdefghijkl";

function oversizedResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(OVERSIZED_RESPONSE_BYTES);
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function assertWranglerBlocked(): Promise<void> {
  const run = await runScript(["--local-d1"]);
  expect(run.exitCode).toBe(78);
  expect(record(run).status).toBe("blocked");
  expect(record(run).code).toBe("WRANGLER_REQUIRED");
}

function phaseValue(stderr: string, phase: string, key: string): string | undefined {
  const line = stderr.split("\n").find((entry) => entry.includes(` ${phase} `));
  return line?.match(new RegExp(`${key}=([^\\s]+)`))?.[1];
}

describe("the in-memory child-output transport", () => {
  test("reports malformed NDJSON without echoing its bytes", () => {
    expect(() => records({ exitCode: 1, stdout: '{"code":"BROKEN"', stderr: "" })).toThrow(
      "S1_OUTPUT_RECORD_INVALID",
    );
  });

  test("reassembles a terminal record split across delayed TCP packets", async () => {
    const capture = await socketCapture();
    const client = createConnection({ host: "127.0.0.1", port: capture.port });
    try {
      await once(client, "connect");
      client.write('{"code":"SPLIT_');
      await Bun.sleep(20);
      const closed = once(client, "close");
      client.end('RECORD"}\n');
      await closed;
      expect(await settleSocketCapture(capture)).toBe('{"code":"SPLIT_RECORD"}\n');
    } finally {
      client.destroy();
      capture.close();
    }
  });

  test("fails with a fixed code when a connected writer never closes", async () => {
    const capture = await socketCapture();
    const client = createConnection({ host: "127.0.0.1", port: capture.port });
    try {
      await once(client, "connect");
      client.write("partial");
      let failure = "";
      try {
        await settleSocketCapture(capture);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toBe("S1_CAPTURE_EOF_TIMEOUT");
    } finally {
      client.destroy();
      capture.close();
    }
  });

  test("caps output and reports only a byte count on overflow", async () => {
    const capture = await socketCapture();
    const client = createConnection({ host: "127.0.0.1", port: capture.port });
    try {
      await once(client, "connect");
      const closed = once(client, "close");
      client.end(Buffer.alloc(CAPTURE_LIMIT_BYTES + 1, 0x78));
      await closed;
      let failure = "";
      try {
        await settleSocketCapture(capture);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toBe(`S1_CAPTURE_LIMIT_EXCEEDED bytes=${CAPTURE_LIMIT_BYTES + 1}`);
      expect(failure.includes("xxxx")).toBe(false);
    } finally {
      client.destroy();
      capture.close();
    }
  });
});

describe("the local-D1 response boundary", () => {
  const decoder = new TextDecoder();
  const streamResponse = (bytes: Uint8Array, contentLength?: string): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      {
        headers: contentLength === undefined ? {} : { "content-length": contentLength },
      },
    );

  test("accepts an exact-limit streamed response whether Content-Length is present or absent", async () => {
    const bytes = new TextEncoder().encode("x".repeat(LOCAL_RESPONSE_MAX_BYTES));
    for (const contentLength of [undefined, String(LOCAL_RESPONSE_MAX_BYTES)]) {
      await expect(boundedLocalResponse(streamResponse(bytes, contentLength)).text()).resolves.toBe(
        decoder.decode(bytes),
      );
    }
  });

  test("PLANTED: missing and lying Content-Length values cannot bypass the streamed +1 byte cap", async () => {
    const sentinel = "S1_LOCAL_RESPONSE_OVER_LIMIT_SENTINEL";
    const bytes = new TextEncoder().encode(
      `${sentinel}${"x".repeat(LOCAL_RESPONSE_MAX_BYTES + 1 - sentinel.length)}`,
    );
    for (const contentLength of [undefined, "1", String(LOCAL_RESPONSE_MAX_BYTES + 1)]) {
      let failure = "";
      try {
        await boundedLocalResponse(streamResponse(bytes, contentLength)).text();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toBe("local-response-too-large");
      expect(failure).not.toContain(sentinel);
    }
  });
});

/** A real listener, so "busy" means busy rather than "we think it might be". */
function occupyPort(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("busy"),
  });
  const { port } = server;
  // `Server.port` is optional in Bun's types because a unix-socket server has
  // none. This one is TCP, and a test that pinned `undefined` as its port would
  // assert nothing at all, so the absence is an error rather than a fallback.
  if (typeof port !== "number") throw new Error("expected a TCP port for the squatter");
  return { port, stop: () => server.stop(true) };
}

describe("the self-test and the blocked external proof", () => {
  test("PLANTED: skipping one non-legacy client completion refuses before it can write terminal evidence", async () => {
    expect(LOCAL_D1_EVIDENCE_CASES).toContain(LOCAL_D1_COMPLETION_SKIP_PLANT);
    const run = await runScript(["--self-test-client-evidence-completion-skip"]);
    expect(run.exitCode).toBe(0);
    expect(record(run)).toMatchObject({ code: "CLIENT_EVIDENCE_COMPLETION_SKIP_SELF_TEST_PASSED" });
    expect(phaseValue(run.stderr, "client-evidence-completion-skip-refused", "result")).toBe(
      "refused",
    );
    expect(phaseValue(run.stderr, "client-evidence-completion-skip-refused", "code")).toBe(
      "evidence-case-order",
    );
    expect(`${run.stdout}\n${run.stderr}`).not.toContain("S1_LOCAL_RESPONSE_OVER_LIMIT_SENTINEL");
  });

  test("--self-test passes and leaks no fragment secret", async () => {
    const fragmentSentinel = "v1.S1FRAGMENT_SENTINEL_0123456789abcdefghijklm";
    const run = await runScript(["--self-test"]);
    if (run.exitCode !== 0) {
      throw new Error(`S1 self-test failed\n${failureEvidence(run)}`);
    }
    expect(record(run).code).toBe("SELF_TEST_PASSED");
    expect(run.stdout.includes(fragmentSentinel)).toBe(false);
    expect(run.stderr.includes(fragmentSentinel)).toBe(false);
    for (const fault of [
      "ps-malformed-after-self",
      "ps-truncated-tail",
      "ps-truncated-before-self",
    ]) {
      expect(run.stderr).toContain(`self-test-parser-refused fault=${fault} action=not-accepted`);
    }
    const stateDir = phaseValue(run.stderr, "state-retained", "dir") as string;
    expect(existsSync(stateDir)).toBe(true);
    const retained = retainedArtifacts(stateDir);
    expect(retained.files.length).toBeGreaterThanOrEqual(2);
    for (const artifact of retained.files) {
      expect(
        bytesContain(artifact.bytes, fragmentSentinel),
        `fragment leaked to retained artifact ${artifact.path}`,
      ).toBe(false);
    }

    // A settled child is never signalled by the test cleanup helper. This
    // plants the exact state that the old resolved-undefined Promise.race lost.
    let killCalls = 0;
    const settled: SpawnedHarness = {
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {
        killCalls += 1;
      },
    };
    expect(await terminateExactChild(settled)).toBe(0);
    expect(killCalls).toBe(0);

    const errno = (code: "ESRCH" | "EPERM") => Object.assign(new Error(code), { code });
    expect(
      processGone(123, () => {
        throw errno("ESRCH");
      }),
    ).toBe(true);
    expect(
      processGone(123, () => {
        throw errno("EPERM");
      }),
    ).toBe(false);
  });

  test("loopback: a rejected capsule GET emits a terminal failure even though its body is discarded", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("refused", { status: 503 }),
    });
    try {
      const run = await runScript([], enrollmentEnv(`http://127.0.0.1:${server.port}`));
      expect(run.exitCode).toBe(1);
      expect(record(run)).toMatchObject({
        status: "fail",
        code: "CAPSULE_REQUEST_FAILED",
      });
      expect(records(run)).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("loopback: a malformed poll response replaces an earlier proposal pass with a terminal failure", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"B".repeat(43)}` }, { status: 201 });
        }
        if (pathname === "/v1/fellows/flow") return Response.json({});
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const run = await runScript([], enrollmentEnv(`http://127.0.0.1:${server.port}`));
      expect(run.exitCode).toBe(1);
      expect(records(run).map((entry) => entry.code)).toEqual([
        "PROPOSAL_CREATED",
        "UNEXPECTED_RESPONSE_SHAPE",
      ]);
      expect(record(run)).toMatchObject({
        status: "fail",
        code: "UNEXPECTED_RESPONSE_SHAPE",
      });
    } finally {
      server.stop(true);
    }
  });

  test("loopback: a poll-body construction failure replaces PROPOSAL_CREATED with one terminal failure", async () => {
    let pollRequests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"B".repeat(43)}` }, { status: 201 });
        }
        if (pathname === "/v1/fellows/flow") pollRequests += 1;
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const run = await runScript([], {
        ...enrollmentEnv(`http://127.0.0.1:${server.port}`),
        S1_TEST_BODY_FAULT: "poll-body-construction",
      });
      expect(run.exitCode).toBe(1);
      expect(records(run).map((entry) => entry.code)).toEqual([
        "PROPOSAL_CREATED",
        "POLL_BODY_INVALID",
      ]);
      expect(record(run)).toMatchObject({
        status: "fail",
        code: "POLL_BODY_INVALID",
      });
      expect(pollRequests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("S1: an approved loopback flow sends its bearer only to hello and follows exactly the first safe read", async () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
    let origin = "";
    let helloAuthorization: string | null = null;
    let protocolAuthorization: string | null = null;
    let helloRequests = 0;
    let protocolRequests = 0;
    let skillRequests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (request.method === "POST" && pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
        }
        if (request.method === "POST" && pathname === "/v1/fellows/flow") {
          return Response.json({
            status: "approved",
            token,
            hello_url: `${origin}/v1/hello`,
            suggested_next: "GET /v1/hello with the bearer token",
          });
        }
        if (request.method === "GET" && pathname === "/v1/hello") {
          helloRequests += 1;
          helloAuthorization = request.headers.get("authorization");
          return Response.json(validHelloResponse(origin));
        }
        if (request.method === "GET" && pathname === "/protocol.md") {
          protocolRequests += 1;
          protocolAuthorization = request.headers.get("authorization");
          return new Response("protocol", { headers: { "Content-Type": "text/markdown" } });
        }
        if (request.method === "GET" && pathname === "/skill.md") {
          skillRequests += 1;
          return new Response("skill", { headers: { "Content-Type": "text/markdown" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    try {
      const run = await runScript([], enrollmentEnv(origin));
      expect(run.exitCode).toBe(0);
      expect(records(run).map((entry) => entry.code)).toEqual([
        "PROPOSAL_CREATED",
        "TOKEN_ISSUED",
        "HELLO_REACHED",
        "FIRST_SAFE_READ_COMPLETED",
        "LOCAL_TEST_ENROLLMENT_PASSED",
      ]);
      expect(record(run)).toMatchObject({ evidence_scope: "local-test" });
      expect(helloRequests).toBe(1);
      expect<string | null>(helloAuthorization).toBe(`Bearer ${token}`);
      expect(protocolRequests).toBe(1);
      expect(protocolAuthorization).toBeNull();
      expect(skillRequests).toBe(0);
      expect(run.stdout).not.toContain(token);
      expect(run.stderr).not.toContain(token);
      expect(run.stderr).not.toContain("state-retained");
    } finally {
      server.stop(true);
    }
  });

  for (const scenario of [
    {
      stage: "capsule",
      expectedCodes: ["RESPONSE_BODY_TOO_LARGE"],
      expectedPaths: ["/join/ASIMP-EN-7F3K9M2Q8R"],
    },
    {
      stage: "claim",
      expectedCodes: ["RESPONSE_BODY_TOO_LARGE"],
      expectedPaths: ["/join/ASIMP-EN-7F3K9M2Q8R", "/v1/fellows"],
    },
    {
      stage: "poll",
      expectedCodes: ["PROPOSAL_CREATED", "RESPONSE_BODY_TOO_LARGE"],
      expectedPaths: ["/join/ASIMP-EN-7F3K9M2Q8R", "/v1/fellows", "/v1/fellows/flow"],
    },
    {
      stage: "hello",
      expectedCodes: ["PROPOSAL_CREATED", "TOKEN_ISSUED", "RESPONSE_BODY_TOO_LARGE"],
      expectedPaths: ["/join/ASIMP-EN-7F3K9M2Q8R", "/v1/fellows", "/v1/fellows/flow", "/v1/hello"],
    },
    {
      stage: "first-read",
      expectedCodes: [
        "PROPOSAL_CREATED",
        "TOKEN_ISSUED",
        "HELLO_REACHED",
        "RESPONSE_BODY_TOO_LARGE",
      ],
      expectedPaths: [
        "/join/ASIMP-EN-7F3K9M2Q8R",
        "/v1/fellows",
        "/v1/fellows/flow",
        "/v1/hello",
        "/protocol.md",
      ],
    },
  ] as const) {
    test(`S1 PLANTED: a fast oversized ${scenario.stage} response is refused before parsing or a later request`, async () => {
      const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
      let origin = "";
      const paths: string[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const { pathname } = new URL(request.url);
          paths.push(pathname);
          if (request.method === "GET" && pathname.startsWith("/join/")) {
            return scenario.stage === "capsule"
              ? oversizedResponse()
              : Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
          }
          if (request.method === "POST" && pathname === "/v1/fellows") {
            return scenario.stage === "claim"
              ? oversizedResponse()
              : Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
          }
          if (request.method === "POST" && pathname === "/v1/fellows/flow") {
            return scenario.stage === "poll"
              ? oversizedResponse()
              : Response.json({
                  status: "approved",
                  token,
                  hello_url: `${origin}/v1/hello`,
                  suggested_next: "GET /v1/hello with the bearer token",
                });
          }
          if (request.method === "GET" && pathname === "/v1/hello") {
            return scenario.stage === "hello"
              ? oversizedResponse()
              : Response.json(validHelloResponse(origin));
          }
          if (request.method === "GET" && pathname === "/protocol.md") {
            return scenario.stage === "first-read"
              ? oversizedResponse()
              : new Response("protocol", { headers: { "Content-Type": "text/markdown" } });
          }
          return new Response("not found", { status: 404 });
        },
      });
      origin = `http://127.0.0.1:${server.port}`;
      try {
        const run = await runScript([], enrollmentEnv(origin));
        expect(run.exitCode).toBe(1);
        expect(records(run).map((entry) => entry.code)).toEqual([...scenario.expectedCodes]);
        expect(paths).toEqual([...scenario.expectedPaths]);
        expect(run.stdout).not.toContain(OVERSIZED_RESPONSE_SENTINEL);
        expect(run.stderr).not.toContain(OVERSIZED_RESPONSE_SENTINEL);
        expect(run.stdout).not.toContain(token);
        expect(run.stderr).not.toContain(token);
      } finally {
        server.stop(true);
      }
    });
  }

  test("S1 PLANTED: a hostile CURL_HOME cannot inject curlrc behavior into capsule, claim, or poll", async () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
    const curlHome = mkdtempSync(join(tmpdir(), "s1-hostile-curlrc-"));
    writeFileSync(join(curlHome, ".curlrc"), 'header = "X-S1-Hostile-Curlrc: injected"\n', {
      encoding: "utf8",
      mode: 0o600,
    });
    let origin = "";
    const hostileHeaderPaths: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.headers.has("x-s1-hostile-curlrc")) hostileHeaderPaths.push(pathname);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (request.method === "POST" && pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
        }
        if (request.method === "POST" && pathname === "/v1/fellows/flow") {
          return Response.json({
            status: "approved",
            token,
            hello_url: `${origin}/v1/hello`,
            suggested_next: "GET /v1/hello with the bearer token",
          });
        }
        if (request.method === "GET" && pathname === "/v1/hello") {
          return Response.json(validHelloResponse(origin));
        }
        if (request.method === "GET" && pathname === "/protocol.md") {
          return new Response("protocol", { headers: { "Content-Type": "text/markdown" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    try {
      const run = await runScript([], { ...enrollmentEnv(origin), CURL_HOME: curlHome });
      expect(run.exitCode).toBe(0);
      expect(records(run).map((entry) => entry.code)).toEqual([
        "PROPOSAL_CREATED",
        "TOKEN_ISSUED",
        "HELLO_REACHED",
        "FIRST_SAFE_READ_COMPLETED",
        "LOCAL_TEST_ENROLLMENT_PASSED",
      ]);
      expect(hostileHeaderPaths).toEqual([]);
      expect(run.stdout).not.toContain(token);
      expect(run.stderr).not.toContain(token);
    } finally {
      server.stop(true);
    }
  });

  test("S1 PLANTED: a valid hello for another Fellow is refused before the first read", async () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
    let origin = "";
    let helloAuthorization: string | null = null;
    let firstReadRequests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (request.method === "POST" && pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
        }
        if (request.method === "POST" && pathname === "/v1/fellows/flow") {
          return Response.json({
            status: "approved",
            token,
            hello_url: `${origin}/v1/hello`,
            suggested_next: "GET /v1/hello with the bearer token",
          });
        }
        if (request.method === "GET" && pathname === "/v1/hello") {
          helloAuthorization = request.headers.get("authorization");
          const response = validHelloResponse(origin);
          return Response.json({
            ...response,
            fellow: { ...response.fellow, name: "other-fellow" },
          });
        }
        if (request.method === "GET" && pathname === "/protocol.md") firstReadRequests += 1;
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    try {
      const run = await runScript([], enrollmentEnv(origin));
      expect(run.exitCode).toBe(1);
      expect(records(run).map((entry) => entry.code)).toEqual([
        "PROPOSAL_CREATED",
        "TOKEN_ISSUED",
        "HELLO_PRINCIPAL_MISMATCH",
      ]);
      expect<string | null>(helloAuthorization).toBe(`Bearer ${token}`);
      expect(firstReadRequests).toBe(0);
      expect(run.stdout).not.toContain(token);
      expect(run.stderr).not.toContain(token);
    } finally {
      server.stop(true);
    }
  });

  test("S1 PLANTED: bash -x cannot echo the join fragment or issued bearer", async () => {
    const fragmentSecret = `v1.${"D".repeat(43)}`;
    const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
    let origin = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (request.method === "POST" && pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
        }
        if (request.method === "POST" && pathname === "/v1/fellows/flow") {
          return Response.json({
            status: "approved",
            token,
            hello_url: `${origin}/v1/hello`,
            suggested_next: "GET /v1/hello with the bearer token",
          });
        }
        if (request.method === "GET" && pathname === "/v1/hello") {
          return Response.json({ ...validHelloResponse(origin), diagnostic: token });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    try {
      const run = await runScript(
        [],
        {
          ...enrollmentEnv(origin),
          ASIMP_S1_JOIN_URL: `${origin}/join/ASIMP-EN-7F3K9M2Q8R#${fragmentSecret}`,
        },
        true,
      );
      expect(run.exitCode).toBe(1);
      expect(record(run)).toMatchObject({ status: "fail", code: "TOKEN_ECHO_DETECTED" });
      expect(run.stdout).not.toContain(fragmentSecret);
      expect(run.stderr).not.toContain(fragmentSecret);
      expect(run.stdout).not.toContain(token);
      expect(run.stderr).not.toContain(token);
    } finally {
      server.stop(true);
    }
  });

  test("S1 PLANTED: trusted direct bootstrap scrubs startup hooks, xtrace, and PATH", async () => {
    const probeDir = mkdtempSync(join(tmpdir(), "s1-prestart-env-probe-"));
    const hostileBashEnv = join(probeDir, "hostile-bash-env");
    const hostileEnv = join(probeDir, "hostile-env");
    const hostileBin = join(probeDir, "hostile-bin");
    const hostileBash = join(hostileBin, "bash");
    const controlBashLeak = join(probeDir, "unsanitized-bash-env-leak");
    const controlPathLeak = join(probeDir, "unsanitized-path-leak");
    const directBashLeak = join(probeDir, "direct-bash-env-leak");
    const directEnvLeak = join(probeDir, "direct-env-leak");
    const directPathLeak = join(probeDir, "direct-path-leak");
    const controlFunctionLeak = join(probeDir, "unsanitized-function-leak");
    const directFunctionLeak = join(probeDir, "direct-function-leak");
    const controlCaptureSetLeak = join(probeDir, "unsanitized-capture-set-leak");
    const directCaptureSetLeak = join(probeDir, "direct-capture-set-leak");
    const captureHandoffPrintfLeak = join(probeDir, "privileged-capture-printf-handoff-leak");
    const captureHandoffSetLeak = join(probeDir, "privileged-capture-set-handoff-leak");
    const fragment = `v1.${"P".repeat(43)}`;
    const joinUrl = `http://127.0.0.1:1/join/ASIMP-EN-7F3K9M2Q8R#${fragment}`;
    const hostilePrintfFunction = `() { command printf "%s" "\${ASIMP_S1_JOIN_URL:-}" > "\${S1_PRESTART_FUNCTION_SENTINEL:?}"; command printf "$@"; }`;
    const hostileSetFunction = `() { command printf "%s" "\${ASIMP_S1_JOIN_URL:-}" > "\${S1_PRESTART_CAPTURE_SET_SENTINEL:?}"; builtin set "$@"; }`;
    writeFileSync(
      hostileBashEnv,
      `: "\${PS4:?}"\nprintf "%s" "\${ASIMP_S1_JOIN_URL:-}" > "\${S1_PRESTART_BASH_ENV_SENTINEL:?}"\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    // Bash's documented noninteractive hook is BASH_ENV. ENV is still
    // scrubbed by the direct bootstrap, but this is not a claim that Bash
    // would source it as a positive control.
    writeFileSync(
      hostileEnv,
      `printf "%s" "\${ASIMP_S1_JOIN_URL:-}" > "\${S1_PRESTART_ENV_SENTINEL:?}"\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    mkdirSync(hostileBin, { mode: 0o700 });
    writeFileSync(
      hostileBash,
      `#!/bin/sh\nprintf "%s" "\${ASIMP_S1_JOIN_URL:-}" > "\${S1_PRESTART_PATH_SENTINEL:?}"\nexit 97\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    const sharedEnvironment = {
      ASIMP_S1_JOIN_URL: joinUrl,
      ASIMP_S1_FELLOW_NAME: "orchid-vector",
      ASIMP_S1_MODEL: "test-model",
      ASIMP_S1_HARNESS: "codex",
      BASH_ENV: hostileBashEnv,
      ENV: hostileEnv,
      SHELLOPTS: "xtrace",
      BASHOPTS: "extglob",
      BASH_XTRACEFD: "2",
      PS4: `prestart-${fragment} `,
      // This scalar would have bypassed the prior BASH_VERSION-only gate when
      // /bin/sh was not Bash. The supported path must still re-exec Bash >=4.
      BASH_VERSION: "5.999.999",
      "BASH_FUNC_printf%%": hostilePrintfFunction,
      "BASH_FUNC_set%%": hostileSetFunction,
      PATH: `${hostileBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };

    // The unprivileged capture wrapper starts with `set -e` before its socket
    // redirections. An imported function can write the exact URL and retain
    // wrapper behavior through `builtin set "$@"`. The production capture
    // path below always starts its Bash with -p instead.
    const captureSetControl = await runCapturedProcess(
      TRUSTED_BASH,
      ["-c", ":"],
      {
        ASIMP_S1_JOIN_URL: joinUrl,
        "BASH_FUNC_set%%": hostileSetFunction,
        S1_PRESTART_CAPTURE_SET_SENTINEL: controlCaptureSetLeak,
      },
      false,
    );
    expect(captureSetControl.exitCode).toBe(0);
    expect(readFileSync(controlCaptureSetLeak, "utf8") === joinUrl).toBe(true);

    // The production wrapper is privileged, so imported functions do not run
    // in it. Its neutral handoffs must nevertheless restore each exact
    // BASH_FUNC_* entry for the unprivileged target immediately before exec.
    const captureFunctionHandoffControl = await runCapturedProcess(
      TRUSTED_BASH,
      ["-c", 'set -e\nprintf ""'],
      {
        ASIMP_S1_JOIN_URL: joinUrl,
        "BASH_FUNC_printf%%": hostilePrintfFunction,
        "BASH_FUNC_set%%": hostileSetFunction,
        S1_PRESTART_FUNCTION_SENTINEL: captureHandoffPrintfLeak,
        S1_PRESTART_CAPTURE_SET_SENTINEL: captureHandoffSetLeak,
      },
    );
    expect(captureFunctionHandoffControl.exitCode).toBe(0);
    expect(readFileSync(captureHandoffPrintfLeak, "utf8") === joinUrl).toBe(true);
    expect(readFileSync(captureHandoffSetLeak, "utf8") === joinUrl).toBe(true);

    // This explicit Bash control is unsupported. It proves the BASH_ENV hook
    // and inherited xtrace can read and emit the fragment before source lines.
    const hookControl = await runCapturedProcess(TRUSTED_BASH, [SCRIPT, "--self-test"], {
      ...sharedEnvironment,
      S1_PRESTART_BASH_ENV_SENTINEL: controlBashLeak,
      S1_PRESTART_ENV_SENTINEL: join(probeDir, "unsanitized-control-env-leak"),
      S1_PRESTART_FUNCTION_SENTINEL: controlFunctionLeak,
      "BASH_FUNC_set%%": "",
    });
    expect(hookControl.exitCode).toBe(0);
    expect(record(hookControl).code).toBe("SELF_TEST_PASSED");
    expect(existsSync(controlBashLeak)).toBe(true);
    expect(readFileSync(controlBashLeak, "utf8") === joinUrl).toBe(true);
    expect(readFileSync(controlFunctionLeak, "utf8") === joinUrl).toBe(true);
    expect(hookControl.stderr.includes(fragment)).toBe(true);

    // A bare PATH lookup invokes the fake interpreter and leaks the exact URL.
    // The supported direct path below must never touch that executable.
    const pathControl = await runCapturedProcess(TRUSTED_ENV, ["bash", SCRIPT, "--self-test"], {
      ...sharedEnvironment,
      BASH_ENV: "",
      ENV: "",
      SHELLOPTS: "",
      BASHOPTS: "",
      BASH_XTRACEFD: "",
      PS4: "",
      "BASH_FUNC_printf%%": "",
      "BASH_FUNC_set%%": "",
      S1_PRESTART_PATH_SENTINEL: controlPathLeak,
    });
    expect(readFileSync(controlPathLeak, "utf8") === joinUrl).toBe(true);
    expect(pathControl.exitCode).toBe(97);

    const started = performance.now();
    const direct = await runDirectScript(["--self-test"], {
      ...sharedEnvironment,
      S1_PRESTART_BASH_ENV_SENTINEL: directBashLeak,
      S1_PRESTART_ENV_SENTINEL: directEnvLeak,
      S1_PRESTART_PATH_SENTINEL: directPathLeak,
      S1_PRESTART_FUNCTION_SENTINEL: directFunctionLeak,
      S1_PRESTART_CAPTURE_SET_SENTINEL: directCaptureSetLeak,
    });
    expect(performance.now() - started).toBeLessThan(RUN_SCRIPT_TIMEOUT_MS);
    expect(direct.exitCode).toBe(0);
    expect(record(direct).code).toBe("SELF_TEST_PASSED");
    expect(existsSync(directBashLeak)).toBe(false);
    expect(existsSync(directEnvLeak)).toBe(false);
    expect(existsSync(directPathLeak)).toBe(false);
    expect(existsSync(directFunctionLeak)).toBe(false);
    expect(existsSync(directCaptureSetLeak)).toBe(false);
    expect(direct.stdout).not.toContain(fragment);
    expect(direct.stderr).not.toContain(fragment);
    const scriptSource = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    expect(
      scriptSource.startsWith(
        "#!/usr/bin/env -S -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS -u BASH_XTRACEFD -u PS4 /bin/sh -p\n# shellcheck shell=bash\n",
      ),
    ).toBe(true);
    expect(
      readFileSync(resolve(REPO_ROOT, "apps/wire/test/unit/s1-shell-harness.test.ts"), "utf8"),
    ).toContain('...(privilegedCapture ? ["-p"] : []),');
  }, 30_000);

  for (const scenario of [
    {
      name: "missing hello_url",
      approval: () => ({
        status: "approved",
        token: `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`,
      }),
      code: "HELLO_URL_INVALID",
    },
    {
      name: "malformed hello_url",
      approval: (origin: string) => ({
        status: "approved",
        token: `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`,
        hello_url: `${origin}/v1/hello?unexpected=query`,
        suggested_next: "GET /v1/hello with the bearer token",
      }),
      code: "HELLO_URL_INVALID",
    },
    {
      name: "noncanonical dot-segment hello_url",
      approval: (origin: string) => ({
        status: "approved",
        token: `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`,
        hello_url: `${origin}/v1/../v1/hello`,
        suggested_next: "GET /v1/hello with the bearer token",
      }),
      code: "HELLO_URL_INVALID",
    },
    {
      name: "malformed suggested_next",
      approval: (origin: string) => ({
        status: "approved",
        token: `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`,
        hello_url: `${origin}/v1/hello`,
        suggested_next: "POST /v1/hello with the bearer token",
      }),
      code: "SUGGESTED_NEXT_INVALID",
    },
  ]) {
    test(`S1 PLANTED: approved metadata with ${scenario.name} stops before hello with a fixed code`, async () => {
      let origin = "";
      let helloRequests = 0;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const { pathname } = new URL(request.url);
          if (request.method === "GET" && pathname.startsWith("/join/")) {
            return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
          }
          if (request.method === "POST" && pathname === "/v1/fellows") {
            return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
          }
          if (request.method === "POST" && pathname === "/v1/fellows/flow") {
            return Response.json(scenario.approval(origin));
          }
          if (request.method === "GET" && pathname === "/v1/hello") helloRequests += 1;
          return new Response("not found", { status: 404 });
        },
      });
      origin = `http://127.0.0.1:${server.port}`;
      try {
        const run = await runScript([], enrollmentEnv(origin));
        expect(run.exitCode).toBe(1);
        expect(records(run).map((entry) => entry.code)).toEqual([
          "PROPOSAL_CREATED",
          "TOKEN_ISSUED",
          scenario.code,
        ]);
        expect(helloRequests).toBe(0);
        expect(run.stdout).not.toContain(`asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`);
        expect(run.stderr).not.toContain(`asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`);
      } finally {
        server.stop(true);
      }
    });
  }

  test("S1 PLANTED: a cross-origin hello_url is refused without contacting the attacker", async () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
    let attackerRequests = 0;
    const attacker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        attackerRequests += 1;
        return new Response("attacker");
      },
    });
    let origin = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (request.method === "POST" && pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
        }
        if (request.method === "POST" && pathname === "/v1/fellows/flow") {
          return Response.json({
            status: "approved",
            token,
            hello_url: `http://127.0.0.1:${attacker.port}/v1/hello`,
            suggested_next: "GET /v1/hello with the bearer token",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    try {
      const run = await runScript([], enrollmentEnv(origin));
      expect(run.exitCode).toBe(1);
      expect(records(run).map((entry) => entry.code)).toEqual([
        "PROPOSAL_CREATED",
        "TOKEN_ISSUED",
        "HELLO_URL_INVALID",
      ]);
      expect(attackerRequests).toBe(0);
      expect(run.stdout).not.toContain(token);
      expect(run.stderr).not.toContain(token);
    } finally {
      server.stop(true);
      attacker.stop(true);
    }
  });

  for (const scenario of [
    { name: "absent next_actions", body: {}, code: "NEXT_ACTIONS_INVALID" },
    {
      name: "a malformed non-action granted_scopes field with a safe first read",
      body: (origin: string) => ({
        ...validHelloResponse(origin),
        granted_scopes: "review",
      }),
      code: "HELLO_RESPONSE_INVALID",
    },
    {
      name: "an unsafe first action",
      body: (origin: string) =>
        validHelloResponse(origin, [
          { action: "write", url: `${origin}/protocol.md`, reason: "unsafe" },
        ]),
      code: "NEXT_ACTION_UNSAFE",
    },
  ]) {
    test(`S1 PLANTED: hello with ${scenario.name} is refused before a follow-up request`, async () => {
      const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
      let origin = "";
      let helloAuthorization: string | null = null;
      let followUpRequests = 0;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const { pathname } = new URL(request.url);
          if (request.method === "GET" && pathname.startsWith("/join/")) {
            return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
          }
          if (request.method === "POST" && pathname === "/v1/fellows") {
            return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
          }
          if (request.method === "POST" && pathname === "/v1/fellows/flow") {
            return Response.json({
              status: "approved",
              token,
              hello_url: `${origin}/v1/hello`,
              suggested_next: "GET /v1/hello with the bearer token",
            });
          }
          if (request.method === "GET" && pathname === "/v1/hello") {
            helloAuthorization = request.headers.get("authorization");
            return Response.json(
              typeof scenario.body === "function" ? scenario.body(origin) : scenario.body,
            );
          }
          followUpRequests += 1;
          return new Response("not found", { status: 404 });
        },
      });
      origin = `http://127.0.0.1:${server.port}`;
      try {
        const run = await runScript([], enrollmentEnv(origin));
        expect(run.exitCode).toBe(1);
        expect(records(run).map((entry) => entry.code)).toEqual([
          "PROPOSAL_CREATED",
          "TOKEN_ISSUED",
          scenario.code,
        ]);
        expect<string | null>(helloAuthorization).toBe(`Bearer ${token}`);
        expect(followUpRequests).toBe(0);
        expect(run.stdout).not.toContain(token);
        expect(run.stderr).not.toContain(token);
      } finally {
        server.stop(true);
      }
    });
  }

  test("S1 PLANTED: a read action with a cross-origin URL is refused without contacting the attacker", async () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
    let attackerRequests = 0;
    const attacker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        attackerRequests += 1;
        return new Response("attacker");
      },
    });
    let origin = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (request.method === "POST" && pathname === "/v1/fellows") {
          return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
        }
        if (request.method === "POST" && pathname === "/v1/fellows/flow") {
          return Response.json({
            status: "approved",
            token,
            hello_url: `${origin}/v1/hello`,
            suggested_next: "GET /v1/hello with the bearer token",
          });
        }
        if (request.method === "GET" && pathname === "/v1/hello") {
          return Response.json(
            validHelloResponse(origin, [
              {
                action: "read",
                url: `http://127.0.0.1:${attacker.port}/protocol.md`,
                reason: "unsafe origin",
              },
            ]),
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    try {
      const run = await runScript([], enrollmentEnv(origin));
      expect(run.exitCode).toBe(1);
      expect(records(run).map((entry) => entry.code)).toEqual([
        "PROPOSAL_CREATED",
        "TOKEN_ISSUED",
        "NEXT_ACTION_UNSAFE",
      ]);
      expect(attackerRequests).toBe(0);
      expect(run.stdout).not.toContain(token);
      expect(run.stderr).not.toContain(token);
    } finally {
      server.stop(true);
      attacker.stop(true);
    }
  });

  for (const scenario of [
    { name: "same-origin disallowed path", path: "/v1/sessions" },
    { name: "same-origin query", path: "/protocol.md?unexpected=query" },
    { name: "same-origin dot-segment alias", path: "/v1/../protocol.md" },
    { name: "same-origin empty-query alias", path: "/protocol.md?" },
    { name: "same-origin empty-fragment alias", path: "/protocol.md#" },
  ]) {
    test(`S1 PLANTED: a read action with a ${scenario.name} is refused without a follow-up request`, async () => {
      const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
      let origin = "";
      let followUpRequests = 0;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const { pathname } = new URL(request.url);
          if (request.method === "GET" && pathname.startsWith("/join/")) {
            return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
          }
          if (request.method === "POST" && pathname === "/v1/fellows") {
            return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
          }
          if (request.method === "POST" && pathname === "/v1/fellows/flow") {
            return Response.json({
              status: "approved",
              token,
              hello_url: `${origin}/v1/hello`,
              suggested_next: "GET /v1/hello with the bearer token",
            });
          }
          if (request.method === "GET" && pathname === "/v1/hello") {
            return Response.json(
              validHelloResponse(origin, [
                { action: "read", url: `${origin}${scenario.path}`, reason: "unsafe target" },
              ]),
            );
          }
          followUpRequests += 1;
          return new Response("not found", { status: 404 });
        },
      });
      origin = `http://127.0.0.1:${server.port}`;
      try {
        const run = await runScript([], enrollmentEnv(origin));
        expect(run.exitCode).toBe(1);
        expect(records(run).map((entry) => entry.code)).toEqual([
          "PROPOSAL_CREATED",
          "TOKEN_ISSUED",
          "NEXT_ACTION_UNSAFE",
        ]);
        expect(followUpRequests).toBe(0);
        expect(run.stdout).not.toContain(token);
        expect(run.stderr).not.toContain(token);
      } finally {
        server.stop(true);
      }
    });
  }

  for (const scenario of ["hello", "first-read"] as const) {
    test(`S1 PLANTED: a ${scenario} response that echoes the bearer fails without exposing it`, async () => {
      const token = `asimp_ag_${"A".repeat(26)}_${"B".repeat(43)}`;
      let origin = "";
      let firstReadRequests = 0;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const { pathname } = new URL(request.url);
          if (request.method === "GET" && pathname.startsWith("/join/")) {
            return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
          }
          if (request.method === "POST" && pathname === "/v1/fellows") {
            return Response.json({ flow_handle: `flow_v1.${"C".repeat(43)}` }, { status: 201 });
          }
          if (request.method === "POST" && pathname === "/v1/fellows/flow") {
            return Response.json({
              status: "approved",
              token,
              hello_url: `${origin}/v1/hello`,
              suggested_next: "GET /v1/hello with the bearer token",
            });
          }
          if (request.method === "GET" && pathname === "/v1/hello") {
            return Response.json({
              ...validHelloResponse(origin, [
                { action: "read", url: `${origin}/protocol.md`, reason: "read" },
              ]),
              ...(scenario === "hello" ? { diagnostic: token } : {}),
            });
          }
          if (request.method === "GET" && pathname === "/protocol.md") {
            firstReadRequests += 1;
            return new Response(scenario === "first-read" ? `echo:${token}` : "protocol");
          }
          return new Response("not found", { status: 404 });
        },
      });
      origin = `http://127.0.0.1:${server.port}`;
      try {
        const run = await runScript([], enrollmentEnv(origin));
        expect(run.exitCode).toBe(1);
        expect(record(run)).toMatchObject({ status: "fail", code: "TOKEN_ECHO_DETECTED" });
        expect(firstReadRequests).toBe(scenario === "hello" ? 0 : 1);
        expect(run.stdout).not.toContain(token);
        expect(run.stderr).not.toContain(token);
        expect(run.stderr).not.toContain("state-retained");
      } finally {
        server.stop(true);
      }
    });
  }

  test("multiple arguments are rejected with a terminal typed failure", async () => {
    const run = await runScript(["--self-test", "unexpected"]);
    expect(run.exitCode).toBe(1);
    expect(records(run)).toHaveLength(1);
    expect(record(run)).toMatchObject({
      status: "fail",
      code: "ARGUMENT_COUNT_INVALID",
    });
  });

  test("kernel probe faults are validated and scoped to the kernel self-test", async () => {
    const invalid = await runScript(["--self-test"], {
      S1_KERNEL_PROBE_FAULT: "not-a-fault",
    });
    expect(invalid.exitCode).toBe(78);
    expect(record(invalid)).toMatchObject({
      status: "blocked",
      code: "KERNEL_PROBE_FAULT_INVALID",
    });

    const unscoped = await runScript(["--self-test-lifecycle"], {
      S1_KERNEL_PROBE_FAULT: "bun-exit-1",
    });
    expect(unscoped.exitCode).toBe(78);
    expect(record(unscoped)).toMatchObject({
      status: "blocked",
      code: "KERNEL_PROBE_FAULT_SCOPE_INVALID",
    });
  });

  test("transient inspection retries use one absolute high-resolution deadline", () => {
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    expect(source).toContain("absolute_time_us()");
    expect(source).toContain("transient_retry_deadline_us()");
    expect(source).toContain('transient_retry_deadline_elapsed "$deadline"');
    expect(source).not.toContain("SECONDS + TRANSIENT_INSPECTION_DEADLINE_SECONDS");
  });

  test("S1: the bearer header is sourced from curl stdin configuration, not curl argv", () => {
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    const curlBody = source.slice(
      source.indexOf("curl_body()"),
      source.indexOf("make_registration_body()"),
    );
    expect(curlBody).toContain('printf \'header = "Authorization: Bearer %s"\\n\' "$bearer_token"');
    expect(curlBody).toContain("curl --disable --silent --fail-with-body --config - --request GET");
    expect(curlBody.match(/\bcurl --disable\b/g)).toHaveLength(3);
    expect(curlBody.match(/--max-filesize "\$EXTERNAL_RESPONSE_MAX_BYTES"/g)).toHaveLength(3);
    expect(curlBody).toContain("bounded_response_body");
    expect(curlBody).not.toMatch(/\bcurl --(?!disable\b)/);
    expect(curlBody).not.toContain(
      'curl_headers+=(--header "Authorization: Bearer $bearer_token")',
    );
    expect(curlBody).not.toContain('--header "Authorization: Bearer $bearer_token"');
    expect(source).toContain(
      'import { EnrollmentHelloResponseSchema } from "@asimposium/contracts";',
    );
    expect(source).toContain("set +x");
    expect(source).toContain("readonly EXTERNAL_RESPONSE_MAX_BYTES=262144");
  });

  test("S1: every executable curl invocation disables caller curl configuration first", () => {
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    const curlInvocations = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => /(^|[|( ])curl\s/.test(line))
      .filter((line) => !line.includes("command -v curl"));
    expect(curlInvocations).toHaveLength(5);
    for (const invocation of curlInvocations) {
      expect(invocation).toMatch(/\bcurl --disable\b/);
    }
  });

  test("a NUL-bearing retained artifact is byte-scanned rather than omitted", () => {
    const sentinel = "v1.S1FRAGMENT_SENTINEL_0123456789abcdefghijklm";
    const prefix = new TextEncoder().encode("sqlite\u0000untrusted:");
    const suffix = new TextEncoder().encode(":tail");
    const needle = new TextEncoder().encode(sentinel);
    const bytes = new Uint8Array(prefix.length + needle.length + suffix.length);
    bytes.set(prefix);
    bytes.set(needle, prefix.length);
    bytes.set(suffix, prefix.length + needle.length);
    expect(bytes.includes(0)).toBe(true);
    expect(bytesContain(bytes, sentinel)).toBe(true);
  });

  test("S1 PLANTED: a missing external join origin stays blocked, never simulated", async () => {
    const run = await runScript([], {
      ASIMP_S1_JOIN_URL: "",
      ASIMP_S1_FELLOW_NAME: "",
      ASIMP_S1_MODEL: "",
      ASIMP_S1_HARNESS: "",
    });
    expect(run.exitCode).toBe(78);
    const emitted = record(run);
    expect(emitted.status).toBe("blocked");
    expect(emitted.code).toBe("STAGING_JOIN_URL_REQUIRED");
  });

  test("S1 PLANTED: loopback HTTP is blocked unless its explicit self-test mode is valid", async () => {
    const origin = `http://127.0.0.1:65535`;
    const missingMode = await runScript([], {
      ...enrollmentEnv(origin),
      ASIMP_S1_LOOPBACK_SELF_TEST: "",
    });
    expect(missingMode.exitCode).toBe(78);
    expect(record(missingMode)).toMatchObject({
      status: "blocked",
      code: "LOOPBACK_SELF_TEST_REQUIRED",
    });

    const invalidMode = await runScript([], {
      ...enrollmentEnv(origin),
      ASIMP_S1_LOOPBACK_SELF_TEST: "production",
    });
    expect(invalidMode.exitCode).toBe(78);
    expect(record(invalidMode)).toMatchObject({
      status: "blocked",
      code: "LOOPBACK_SELF_TEST_INVALID",
    });
  });

  test("S1 PLANTED: the loopback test switch cannot make a production origin eligible", async () => {
    const run = await runScript([], {
      ...enrollmentEnv("https://a.asimposium.org"),
      ASIMP_S1_TEST_ALLOW_HTTP: "1",
      ASIMP_S1_LOOPBACK_SELF_TEST: "loopback-enrollment-v1",
    });
    expect(run.exitCode).toBe(1);
    expect(record(run)).toMatchObject({ status: "fail", code: "JOIN_URL_INVALID" });
  });

  test.each([
    ["foreign", "https://evil.test"],
    ["production", "https://a.asimposium.org"],
    ["production lookalike", "https://a.asimposium.org.evil.test"],
    ["staging with a non-canonical port", "https://a-staging.asimposium.org:443"],
    ["malformed loopback port", "http://127.0.0.1:70000"],
  ])(
    "S1 PLANTED: a %s join origin is refused before curl can contact it",
    async (_label, origin) => {
      const run = await runScript([], {
        ...enrollmentEnv(origin),
        ASIMP_S1_TEST_ALLOW_HTTP: origin.startsWith("http://") ? "1" : "",
        ASIMP_S1_LOOPBACK_SELF_TEST: origin.startsWith("http://") ? "loopback-enrollment-v1" : "",
      });
      expect(run.exitCode).toBe(1);
      expect(records(run)).toHaveLength(1);
      expect(record(run)).toMatchObject({ status: "fail", code: "JOIN_URL_INVALID" });
    },
  );

  test("S1 PLANTED: a local non-loopback hostname is refused without contacting its listener", async () => {
    let attackerRequests = 0;
    const attacker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        attackerRequests += 1;
        return new Response("attacker");
      },
    });
    try {
      const run = await runScript([], {
        ...enrollmentEnv(`http://localhost:${attacker.port}`),
        ASIMP_S1_TEST_ALLOW_HTTP: "1",
      });
      expect(run.exitCode).toBe(1);
      expect(record(run)).toMatchObject({ status: "fail", code: "JOIN_URL_INVALID" });
      expect(attackerRequests).toBe(0);
    } finally {
      attacker.stop(true);
    }
  });

  test("S1 PLANTED: a default-port loopback join URL is refused without invoking curl", async () => {
    const probeDir = mkdtempSync(join(tmpdir(), "s1-default-port-curl-probe-"));
    const marker = join(probeDir, "curl-was-invoked");
    const fakeCurl = join(probeDir, "curl");
    writeFileSync(fakeCurl, '#!/usr/bin/env bash\n: > "$S1_TEST_CURL_MARKER"\nexit 97\n', {
      encoding: "utf8",
      mode: 0o700,
    });
    const run = await runScript([], {
      ...enrollmentEnv("http://127.0.0.1:80"),
      ASIMP_S1_TEST_ALLOW_HTTP: "1",
      S1_TEST_CURL_MARKER: marker,
      PATH: `${probeDir}:${process.env.PATH ?? ""}`,
    });
    expect(run.exitCode).toBe(1);
    expect(record(run)).toMatchObject({ status: "fail", code: "JOIN_URL_INVALID" });
    expect(existsSync(marker)).toBe(false);
  });

  test("an unsupported harness identity is blocked, not silently accepted", async () => {
    const run = await runScript([], {
      ASIMP_S1_JOIN_URL: `https://a.example.test/join/ASIMP-EN-7F3K9M2Q8R#v1.${"A".repeat(43)}`,
      ASIMP_S1_FELLOW_NAME: "orchid-vector",
      ASIMP_S1_MODEL: "test-model",
      ASIMP_S1_HARNESS: "not-a-real-harness",
    });
    expect(run.exitCode).toBe(78);
    expect(record(run).code).toBe("HARNESS_IDENTITY_UNSUPPORTED");
  });
});

describe("a pinned port is validated before anything is started", () => {
  for (const pinnedValues of [
    ["0", "80"],
    ["1023", "65536"],
    ["70000", "02000", "not-a-port"],
    ["-1", "8080 8080"],
  ]) {
    test(`S1 PLANTED: invalid pinned ports ${pinnedValues.map((value) => JSON.stringify(value)).join(", ")} are refused`, async () => {
      for (const pinned of pinnedValues) {
        const run = await runScript(["--local-d1"], { S1_LOCAL_PORT: pinned });
        expect(run.exitCode).toBe(78);
        expect(record(run).code).toBe("PINNED_PORT_INVALID");
        // Refused before any child, so no state directory and no wrangler start.
        expect(run.stderr).not.toContain("child-started");
      }
    });
  }

  test("PLANTED: a pinned port that is already listening is refused, not served by the squatter", async () => {
    const listener = occupyPort();
    try {
      const run = await runScript(["--local-d1"], {
        S1_LOCAL_PORT: String(listener.port),
      });
      expect(run.exitCode).toBe(78);
      expect(record(run).code).toBe("PINNED_PORT_BUSY");
      expect(run.stderr).not.toContain("child-started");
      // The squatter is untouched: the harness refuses rather than killing a
      // process it does not own.
      const probe = await fetch(`http://127.0.0.1:${listener.port}/`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(await probe.text()).toBe("busy");
    } finally {
      listener.stop();
    }
  });

  test("PLANTED: ownership observation stays inside the live Workerd binding", () => {
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    const start = source.indexOf("assert_port_ownership() {");
    const end = source.indexOf("terminal_local_client_failure() {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const ownership = source.slice(start, end);
    expect(ownership).toContain('curl_body "POST" "$origin/__s1/sponsor-enrollment-counts"');
    expect(ownership).toContain("scope=live-binding");
    // A second Wrangler opening the same persistence tree while `wrangler dev`
    // is live terminates the owned Workerd process on the supported runtime.
    expect(ownership).not.toContain("d1 execute");
    expect(ownership).not.toContain("run_named_with_deadline");
  });

  test("PLANTED: S1 pins the repaired proxy runtime without changing the general Wrangler pin", () => {
    const wireManifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "apps/wire/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, unknown> };
    const s1WranglerManifest = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, "apps/wire/node_modules/wrangler-s1-local/package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    const proxySource = readFileSync(
      resolve(REPO_ROOT, "apps/wire/node_modules/wrangler-s1-local/wrangler-dist/ProxyWorker.js"),
      "utf8",
    );
    const cliSource = readFileSync(
      resolve(REPO_ROOT, "apps/wire/node_modules/wrangler-s1-local/wrangler-dist/cli.js"),
      "utf8",
    );
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    const localClientSource = readFileSync(
      resolve(REPO_ROOT, "apps/wire/src/enrollment/local-d1-client.ts"),
      "utf8",
    );
    const localWorkerSource = readFileSync(
      resolve(REPO_ROOT, "apps/wire/src/enrollment/local-d1-worker.ts"),
      "utf8",
    );

    expect(wireManifest.devDependencies?.wrangler).toBe("4.123.0");
    expect(wireManifest.devDependencies?.["wrangler-s1-local"]).toBe(
      "https://pkg.pr.new/cloudflare/workers-sdk/wrangler@5fc41f0",
    );
    expect(s1WranglerManifest.version).toBe("4.124.0");
    expect(proxySource).toContain(
      '(request.method === "GET" || request.method === "HEAD") && attempt < 2',
    );
    expect(proxySource).toContain("attempt === 0 ? 0 : 250");
    expect(cliSource).toContain('event.reason.startsWith("Error inside ProxyWorker")');
    expect(cliSource).toContain("the affected request failed; the dev server continues");
    expect(source).toContain(
      'readonly LOCAL_WRANGLER="$REPO_ROOT/apps/wire/node_modules/wrangler-s1-local/bin/wrangler.js"',
    );
    expect(source).not.toContain(
      'readonly LOCAL_WRANGLER="$REPO_ROOT/apps/wire/node_modules/.bin/wrangler"',
    );
    for (const path of ["sponsor-enrollment-counts", "card"]) {
      expect(localClientSource).toContain(`get("/__s1/${path}"`);
      expect(localClientSource).not.toContain(`post("/__s1/${path}"`);
      expect(localWorkerSource).toContain(`url.pathname === "/__s1/${path}"`);
    }
    expect(localClientSource).toContain('post("/__s1/device-lookup"');
    expect(localClientSource).not.toContain('get("/__s1/device-lookup"');
  });

  test("an unpinned run allocates its own port and says which one", async () => {
    if (!existsSync(WRANGLER)) {
      await assertWranglerBlocked();
      return;
    }
    const run = await runScript(["--local-d1"]);
    if (run.exitCode !== 0) {
      throw new Error(`unscoped local-D1 run failed\n${failureEvidence(run)}`);
    }
    const port = Number(phaseValue(run.stderr, "port-allocated", "port"));
    const inspectorPort = Number(phaseValue(run.stderr, "inspector-port-allocated", "port"));
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(Number.isInteger(inspectorPort)).toBe(true);
    expect(inspectorPort).toBeGreaterThanOrEqual(1024);
    expect(inspectorPort).not.toBe(port);
    expect(phaseValue(run.stderr, "port-allocated", "pinned")).toBe("no");
    // Readiness is tied to this run's own D1 state, not merely to "something answered".
    expect(run.stderr).toContain("port-ownership-proven");
    expect(record(run)).toMatchObject({
      code: "LOCAL_D1_ENROLLMENT_PASSED",
      reproduce: "scripts/e2e-s1-cold-enrollment.sh --local-d1",
    });
    expect(phaseValue(run.stderr, "replay-key-artifact-scan", "result")).toBe("absent");
    const stateDir = phaseValue(run.stderr, "state-retained", "dir") as string;
    for (const root of [
      "runtime/home",
      "runtime/tmp",
      "runtime/cwd",
      "runtime/xdg-config",
      "runtime/xdg-cache",
      "runtime/xdg-data",
      "runtime/xdg-state",
      "runtime/xdg-runtime",
      "runtime/wrangler-cache",
      "runtime/wrangler-log",
      "runtime/wrangler-env",
      "runtime/bun-cache",
    ]) {
      expect(existsSync(`${stateDir}/${root}`), `missing confined runtime root ${root}`).toBe(true);
    }
    expect(run.stderr).toContain("retained-roots-reconciled phase=before-pass roots=1");
    expect(run.stderr).toContain("retained-roots-reconciled phase=exit roots=1");
    expect(phaseValue(run.stderr, "child-argv-secret-observed", "result")).toBe("absent");
    expect(phaseValue(run.stderr, "child-handoff-fd-observed", "result")).toBe("closed");
    expect(phaseValue(run.stderr, "client-streams-scanned", "scope")).toBe("closed-capture-inodes");
    expect(readFileSync(`${stateDir}/runtime/wrangler-env`, "utf8")).toBe(
      "AGORA_ORIGIN=https://asimposium.org\n",
    );
    const retained = retainedArtifacts(stateDir);
    expect(retained.files.length).toBeGreaterThanOrEqual(3);
    expect(Number(phaseValue(run.stderr, "replay-key-artifact-scan", "files"))).toBe(
      retained.files.length,
    );
    const scannedBytes = Number(phaseValue(run.stderr, "replay-key-artifact-scan", "bytes"));
    expect(Number.isSafeInteger(scannedBytes)).toBe(true);
    expect(scannedBytes).toBeGreaterThan(0);
    expect(scannedBytes).toBeLessThanOrEqual(
      retained.files.reduce((total, file) => total + file.bytes.length, 0),
    );
  }, 720_000);

  test("PLANTED: the retained-artifact scanner detects its exact non-credential canary", async () => {
    const run = await runScript(["--self-test-replay-artifact-scan"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("REPLAY_ARTIFACT_SCAN_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "replay-key-artifact-plant-refused", "result")).toBe("detected");
    expect(phaseValue(run.stderr, "replay-key-artifact-plant-refused", "artifact")).toBe(
      "nested-nul",
    );
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(ARTIFACT_SCAN_EXACT_KEY_CANARY);
  });

  test.each([
    ["join secret", "join-secret"],
    ["flow handle", "flow-handle"],
    ["Fellow bearer", "bearer"],
  ])(
    "PLANTED: the retained-artifact scanner refuses a %s-shaped canary without echoing it",
    async (_label, kind) => {
      const material =
        kind === "join-secret"
          ? `v1.${ARTIFACT_SCAN_EXACT_KEY_CANARY}`
          : kind === "flow-handle"
            ? `flow_v1.${ARTIFACT_SCAN_EXACT_KEY_CANARY}`
            : `asimp_ag_0123456789ABCDEFGHJKMNPQRS_${ARTIFACT_SCAN_EXACT_KEY_CANARY}`;
      const run = await runScript([`--self-test-secret-material-artifact-${kind}`]);
      expect(run.exitCode).toBe(0);
      expect(record(run).code).toBe("SECRET_MATERIAL_ARTIFACT_SCAN_SELF_TEST_PASSED");
      expect(phaseValue(run.stderr, "secret-material-artifact-plant-refused", "result")).toBe(
        "detected",
      );
      expect(phaseValue(run.stderr, "secret-material-artifact-plant-refused", "kind")).toBe(kind);
      expect(`${run.stdout}\n${run.stderr}`).not.toContain(material);
    },
  );

  test("PLANTED: an out-of-root runtime canary is refused before it can be created", async () => {
    const run = await runScript(["--self-test-runtime-root-outside"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("RUNTIME_ROOT_OUTSIDE_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "runtime-root-outside-refused", "result")).toBe("refused");
    expect(phaseValue(run.stderr, "runtime-root-outside-refused", "action")).toBe("not-created");
    expect(`${run.stdout}\n${run.stderr}`).not.toContain("s1-runtime-outside-canary-");
  });

  test("PLANTED: the replay derivation observer sees neither stdin entropy nor its key in the live Bun argv", async () => {
    const entropy = "0".repeat(64);
    const derivedKey = "A".repeat(43);
    const run = await runScript(["--self-test-replay-derivation-argv-observer"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("REPLAY_DERIVATION_ARGV_OBSERVER_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "replay-derivation-argv-observed", "result")).toBe("absent");
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(entropy);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(derivedKey);
  });

  test("PLANTED: after acknowledged private-FD adoption, the exact parked supervisor no longer holds fd9", async () => {
    const run = await runScript(["--self-test-private-handoff-fd"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("PRIVATE_HANDOFF_FD_CLOSURE_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "private-handoff-fd-observed", "result")).toBe("closed");
    expect(phaseValue(run.stderr, "private-handoff-fd-observed", "supervisor")).toBe("exact");
    expect(phaseValue(run.stderr, "private-handoff-fd-observed", "prelaunch-helper")).toBe(
      "closed",
    );
    expect(phaseValue(run.stderr, "private-handoff-fd-observed", "ambient-read")).toBe("refused");
    expect(phaseValue(run.stderr, "private-handoff-fd-observed", "ambient-write")).toBe("refused");
    expect(phaseValue(run.stderr, "private-handoff-fd-observed", "normal-ambient")).toBe("closed");
  }, 30_000);

  test("PLANTED: a hostile caller environment cannot enter the private runtime payload", async () => {
    const probeDir = mkdtempSync(join(tmpdir(), "s1-private-runtime-env-probe-"));
    const fakeExecutableMarker = join(probeDir, "hostile-env-was-invoked");
    const fakeEnv = join(probeDir, "env");
    const joinUrlSentinel = "S1_PRIVATE_RUNTIME_JOIN_URL_SENTINEL";
    const writableRootSentinel = join(probeDir, "caller-writable-root-sentinel");
    writeFileSync(fakeEnv, '#!/bin/sh\n: > "$S1_PRIVATE_RUNTIME_ENV_FAKE_MARKER"\nexit 97\n', {
      encoding: "utf8",
      mode: 0o700,
    });

    const run = await runScript(["--self-test-private-runtime-env"], {
      PATH: `${probeDir}:${process.env.PATH ?? ""}`,
      ASIMP_S1_JOIN_URL: joinUrlSentinel,
      HOME: writableRootSentinel,
      TMP: writableRootSentinel,
      TEMP: writableRootSentinel,
      XDG_CONFIG_HOME: writableRootSentinel,
      XDG_CACHE_HOME: writableRootSentinel,
      XDG_DATA_HOME: writableRootSentinel,
      XDG_STATE_HOME: writableRootSentinel,
      XDG_RUNTIME_DIR: writableRootSentinel,
      WRANGLER_CACHE_DIR: writableRootSentinel,
      WRANGLER_LOG_PATH: writableRootSentinel,
      BUN_INSTALL_CACHE_DIR: writableRootSentinel,
      S1_PRIVATE_RUNTIME_ENV_CONTROL_SENTINEL: joinUrlSentinel,
      S1_PRIVATE_RUNTIME_ENV_FAKE_MARKER: fakeExecutableMarker,
    });

    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("PRIVATE_RUNTIME_ENV_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "private-runtime-env-observed", "result")).toBe("isolated");
    expect(phaseValue(run.stderr, "private-runtime-env-observed", "scope")).toBe(
      "supervisor-payload",
    );
    expect(phaseValue(run.stderr, "private-runtime-env-observed", "path")).toBe("pinned");
    expect(phaseValue(run.stderr, "private-runtime-env-observed", "join-url")).toBe("absent");
    expect(phaseValue(run.stderr, "private-runtime-env-observed", "control")).toBe(
      "caller-visible",
    );
    expect(existsSync(fakeExecutableMarker)).toBe(false);
    for (const sentinel of [joinUrlSentinel, writableRootSentinel]) {
      expect(run.stdout).not.toContain(sentinel);
      expect(run.stderr).not.toContain(sentinel);
    }
  }, 30_000);

  test("PLANTED: the private Wrangler env-file contains only the canonical Agora binding", async () => {
    const run = await runScript(["--self-test-private-wrangler-env"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("PRIVATE_WRANGLER_ENV_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "private-wrangler-env-observed", "result")).toBe("exact");
    expect(phaseValue(run.stderr, "private-wrangler-env-observed", "binding")).toBe("AGORA_ORIGIN");
    expect(phaseValue(run.stderr, "private-wrangler-env-observed", "missing-lf")).toBe("refused");
    expect(phaseValue(run.stderr, "private-wrangler-env-observed", "extra-blank")).toBe("refused");
    expect(phaseValue(run.stderr, "private-wrangler-env-observed", "scope")).toBe(
      "private-env-file",
    );
  });

  test("PLANTED: only the strict allowlisted local-client cause is surfaced", async () => {
    const run = await runScript(["--self-test-client-failure-diagnostic"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("CLIENT_FAILURE_DIAGNOSTIC_ALLOWLIST_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "allowed")).toBe(
      "capsule-json-status",
    );
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "validator-stdout")).toBe(
      "empty",
    );
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "parent-code")).toBe(
      "fixed",
    );
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "rejected")).toBe(
      "withheld",
    );
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "malformed-utf8")).toBe(
      "withheld",
    );
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "duplicate")).toBe(
      "withheld",
    );
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "trailing")).toBe(
      "withheld",
    );
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "no-lf")).toBe("withheld");
    expect(phaseValue(run.stderr, "client-failure-diagnostic-allowlist", "scope")).toBe(
      "closed-capture-file",
    );
  });

  test("PLANTED: a +1-byte overflow still leaves its earlier secret-shaped client diagnostic for exact inode scanning", async () => {
    const cap = 256 * 1024;
    const run = await runScript(["--self-test-client-stream-overflow-secret"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("CLIENT_STREAM_OVERFLOW_SECRET_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "client-stream-overflow-secret-plant-refused", "result")).toBe(
      "detected",
    );
    const attemptedBytes = Number(
      phaseValue(run.stderr, "client-stream-overflow-secret-plant-refused", "attempted-bytes"),
    );
    const capturedBytes = Number(
      phaseValue(run.stderr, "client-stream-overflow-secret-plant-refused", "captured-bytes"),
    );
    expect(Number.isSafeInteger(attemptedBytes)).toBe(true);
    expect(Number.isSafeInteger(capturedBytes)).toBe(true);
    expect(
      Number(phaseValue(run.stderr, "client-stream-overflow-secret-plant-refused", "cap")),
    ).toBe(cap);
    expect(attemptedBytes).toBe(cap + 1);
    expect(capturedBytes).toBe(cap);
    expect(phaseValue(run.stderr, "client-stream-overflow-secret-plant-refused", "scope")).toBe(
      "closed-capture-inodes",
    );
  }, 30_000);

  test("PLANTED: both lsof empty-table conventions pass, while a held fd and diagnostic failure refuse", async () => {
    const run = await runScript(["--self-test-supervisor-fd-observer"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("SUPERVISOR_FD_OBSERVER_CONTROLS_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "supervisor-fd-observer-controls", "mac-empty")).toBe("accepted");
    expect(phaseValue(run.stderr, "supervisor-fd-observer-controls", "linux-empty")).toBe(
      "accepted",
    );
    expect(phaseValue(run.stderr, "supervisor-fd-observer-controls", "holder")).toBe("refused");
    expect(phaseValue(run.stderr, "supervisor-fd-observer-controls", "diagnostic")).toBe("refused");
  });

  /**
   * The client-evidence gate is what turns "the client exited 0" into "the
   * client proved these specific things", and its required-proof-slug clause is
   * what guards the two repaired S-1 findings. Until these modes existed the
   * gate had no negative at all: every real run presents a well-formed record,
   * so any clause could have been inverted and the suite would have stayed
   * green.
   *
   * Each mode drives the production `assert_local_client_evidence` against a
   * planted artifact and pairs it with an accepted control, so a refusal is
   * attributable to the single planted defect rather than to the fixture.
   */
  const EVIDENCE_MODES = [
    [
      "a missing record",
      "missing",
      "CLIENT_EVIDENCE_MISSING_SELF_TEST_PASSED",
      "client-evidence-missing-refused",
      "LOCAL_CLIENT_EVIDENCE_MISSING",
    ],
    [
      "a duplicate record",
      "duplicate",
      "CLIENT_EVIDENCE_DUPLICATE_SELF_TEST_PASSED",
      "client-evidence-duplicate-refused",
      "LOCAL_CLIENT_EVIDENCE_NOT_SINGLE_RECORD",
    ],
    [
      "one absent required proof slug",
      "proof-missing",
      "CLIENT_EVIDENCE_PROOF_MISSING_SELF_TEST_PASSED",
      "client-evidence-proof-missing-refused",
      "LOCAL_CLIENT_EVIDENCE_PROOF_MISSING",
    ],
    [
      "one absent mounted-device proof slug",
      "proof-missing-device",
      "CLIENT_EVIDENCE_PROOF_MISSING_SELF_TEST_PASSED",
      "client-evidence-proof-missing-refused",
      "LOCAL_CLIENT_EVIDENCE_PROOF_MISSING",
    ],
    [
      "one absent 24-hour durable-state proof slug",
      "proof-missing-expiry",
      "CLIENT_EVIDENCE_PROOF_MISSING_SELF_TEST_PASSED",
      "client-evidence-proof-missing-refused",
      "LOCAL_CLIENT_EVIDENCE_PROOF_MISSING",
    ],
    [
      "a duplicate case slug",
      "case-duplicate",
      "CLIENT_EVIDENCE_CASE_DUPLICATE_SELF_TEST_PASSED",
      "client-evidence-case-duplicate-refused",
      "LOCAL_CLIENT_EVIDENCE_CASE_DUPLICATE",
    ],
    [
      "an unknown case slug",
      "case-unknown",
      "CLIENT_EVIDENCE_CASE_UNKNOWN_SELF_TEST_PASSED",
      "client-evidence-case-unknown-refused",
      "LOCAL_CLIENT_EVIDENCE_CASE_UNKNOWN",
    ],
    [
      "a reordered case corpus",
      "case-reorder",
      "CLIENT_EVIDENCE_CASE_REORDER_SELF_TEST_PASSED",
      "client-evidence-case-reorder-refused",
      "LOCAL_CLIENT_EVIDENCE_CASE_ORDER_INVALID",
    ],
  ] as const;

  test.each(EVIDENCE_MODES)(
    "PLANTED: %s is refused with its own code, and the control is accepted",
    async (_label, mode, passCode, phase, refusalCode) => {
      const run = await runScript([`--self-test-client-evidence-${mode}`]);
      expect(run.exitCode).toBe(0);
      expect(record(run).code).toBe(passCode);

      // The refusal is the planted one, and the paired control was accepted by
      // the same gate — without that half, "refused" would prove nothing.
      expect(phaseValue(run.stderr, phase, "result")).toBe("refused");
      expect(phaseValue(run.stderr, phase, "code")).toBe(refusalCode);
      expect(phaseValue(run.stderr, phase, "control")).toBe("accepted");

      // Ordering: the only terminal record is the pass, emitted after the gate
      // assertions. A PASS reached before them would appear as an extra record.
      expect(records(run)).toHaveLength(1);

      // The fixtures carry a real per-run nonce; no part of a retained record
      // may ride out on either stream.
      expect(run.stdout).not.toContain("s1-local-d1-evidence");
      expect(run.stderr).not.toContain("s1-local-d1-evidence");
      expect(run.stdout).not.toContain("run_nonce");
      expect(run.stderr).not.toContain("run_nonce");
    },
  );

  test("PLANTED: evidence failure classes do not collapse onto one code", async () => {
    // Distinctness is the property an operator depends on: a missing record,
    // duplicate record, missing proof, duplicate case, unknown case, and a
    // reordered corpus all need different operator repairs. A gate that
    // reported one code for every class would pass each isolated refusal while
    // still being operationally useless.
    const distinctModes = [
      EVIDENCE_MODES[0], // missing record
      EVIDENCE_MODES[1], // duplicate record
      EVIDENCE_MODES[2], // missing proof (the next two rows are variants)
      EVIDENCE_MODES[5], // duplicate case
      EVIDENCE_MODES[6], // unknown case
      EVIDENCE_MODES[7], // reordered corpus
    ];
    const codes = await Promise.all(
      distinctModes.map(async ([, mode, , phase]) => {
        const run = await runScript([`--self-test-client-evidence-${mode}`]);
        return phaseValue(run.stderr, phase, "code");
      }),
    );
    expect(codes.every((code) => typeof code === "string")).toBe(true);
    expect(new Set(codes).size).toBe(distinctModes.length);
  }, 120_000);

  test("the production evidence gate imports the client's complete declared corpus", () => {
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    expect(LOCAL_D1_EVIDENCE_CASES.length).toBeGreaterThan(3);
    expect(new Set(LOCAL_D1_EVIDENCE_CASES).size).toBe(LOCAL_D1_EVIDENCE_CASES.length);
    expect(source).toContain(
      'import { LOCAL_D1_EVIDENCE_CASES } from "./apps/wire/src/enrollment/local-d1-client.ts";',
    );
    expect(source).toContain("record.cases.length !== required.length");
    expect(source).toContain("name === required[index]");
    expect(source).toContain("required.includes(name)");
    expect(source).toContain("LOCAL_CLIENT_EVIDENCE_CASE_UNKNOWN");
    expect(source).not.toContain("EVIDENCE_PROOF_SLUGS");
  });

  test("S1 regression surface: the rejected argv handoff strings are absent", () => {
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), "utf8");
    expect(source).toContain("CLOUDFLARE_INCLUDE_PROCESS_ENV=true");
    expect(source).toContain(
      'readonly LOCAL_WRANGLER_AGORA_ENV="AGORA_ORIGIN=https://asimposium.org"',
    );
    expect(source).toContain(
      'printf \'%s\\n\' "$LOCAL_WRANGLER_AGORA_ENV" >"$LOCAL_RUNTIME_WRANGLER_ENV_FILE"',
    );
    expect(source).toContain("private_wrangler_env_is_exact || return 1");
    expect(source).toContain("printf '%s' \"$LOCAL_WRANGLER_AGORA_ENV\"");
    expect(source).toContain("printf '%s\\n\\n' \"$LOCAL_WRANGLER_AGORA_ENV\"");
    expect(source).toContain('const allowedCodes = new Set(["capsule-json-status"]);');
    expect(source).toContain("const args = process.argv.slice(1);");
    expect(source).toContain("args.length !== 1");
    expect(source).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(source).toContain("bytes.at(-1) !== 0x0a");
    expect(source).toContain("bytes.indexOf(0x0a) !== bytes.length - 1");
    expect(source).toContain("const after = await file.stat();");
    expect(source).toContain("after.dev !== opened.dev || after.ino !== opened.ino");
    expect(source).toContain("after.size !== opened.size || bytes.length !== opened.size");
    expect(source).toContain("record !== `$" + "{JSON.stringify(parsed)}\\n`");
    expect(source).toContain("!allowedCodes.has(parsed.code)");
    expect(source).toContain(
      'local_client_failure_validator "$stderr_path" >/dev/null 2>/dev/null',
    );
    expect(source).toContain("printf '%s' \"capsule-json-status\"");
    expect(source).not.toContain("process.argv.length !== 3");
    expect(source).not.toContain("process.argv.length !== 2");
    expect(source).not.toContain("new TextDecoder().decode(await file.readFile())");
    expect(source).not.toContain("process.stdout.write(parsed.code)");
    for (const rejectedHandoff of [
      'export ENROLLMENT_REPLAY_KEY="$replay_key"',
      'export S1_LOCAL_STOA_ORIGIN="$origin"',
      'stoa_origin="$S1_LOCAL_STOA_ORIGIN"',
      'export STOA_ORIGIN="$stoa_origin"',
      'export "$agora_name=https://asimposium.org"',
      "export AGORA_ORIGIN=",
      "unset replay_key stoa_origin",
      "unset S1_LOCAL_REPLAY_KEY S1_LOCAL_STOA_ORIGIN",
    ]) {
      expect(source).not.toContain(rejectedHandoff);
    }
    expect(source).not.toContain('--var "ENROLLMENT_REPLAY_KEY:');
    expect(source).not.toContain('--var "STOA_ORIGIN:');
  });

  test("PLANTED: a typed failure still scans its retained tree after cleanup", async () => {
    const run = await runScript(["--self-test-replay-artifact-failure"]);
    expect(run.exitCode).toBe(1);
    expect(record(run).code).toBe("PLANTED_REPLAY_ARTIFACT_FAILURE");
    expect(phaseValue(run.stderr, "replay-key-artifact-scan", "result")).toBe("absent");
  });
});

function retainedArtifacts(root: string): {
  files: Array<{ path: string; bytes: Uint8Array }>;
} {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = retainedArtifacts(path);
      files.push(...nested.files);
    } else if (entry.isFile()) {
      const bytes = readFileSync(path);
      // Scan raw bytes rather than attempting text decoding: a NUL-containing
      // SQLite/local-state file is still an artifact in scope for secret proof.
      files.push({ path, bytes });
    } else throw new Error(`retained state contains a non-regular artifact: ${path}`);
  }
  return {
    files,
  };
}

function bytesContain(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  for (let start = 0; start <= bytes.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/** Independent of the script's own assertions: is this pid really gone? */
function processGone(
  pid: number,
  signalZero: (target: number) => unknown = (target) => process.kill(target, 0),
): boolean {
  try {
    signalZero(pid);
    return false;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = performance.now() + PROCESS_PROOF_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (processGone(pid)) return true;
    await Bun.sleep(50);
  }
  return processGone(pid);
}

async function waitForGroupExit(pgid: number): Promise<boolean> {
  const deadline = performance.now() + PROCESS_PROOF_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (processGone(-pgid)) return true;
    await Bun.sleep(50);
  }
  return processGone(-pgid);
}

/** Rebinding the loopback port proves the prior worker file descriptor is gone. */
async function waitForPortFree(port: number): Promise<boolean> {
  const deadline = performance.now() + PROCESS_PROOF_TIMEOUT_MS;
  while (performance.now() < deadline) {
    try {
      const listener = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response("probe"),
      });
      listener.stop(true);
      return true;
    } catch {
      await Bun.sleep(50);
    }
  }
  return false;
}

async function waitForFile(path: string): Promise<boolean> {
  const deadline = performance.now() + PROCESS_PROOF_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(50);
  }
  return existsSync(path);
}

interface SpawnedHarness {
  exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: "SIGHUP" | "SIGTERM" | "SIGKILL"): unknown;
}

// Two owned phases can each take a five-second TERM grace and a five-second
// post-KILL absence proof. Give the script both bounds plus scheduling margin
// before a test is allowed to force-stop only the Bun child it created.
const PROCESS_PROOF_TIMEOUT_MS = 5_000;
const HARNESS_CLEANUP_TIMEOUT_MS = 30_000;
const LOCAL_CHILD_START_TIMEOUT_MS = 150_000;
// The shell has separate 120 s migration, 45 s readiness, 15 s ownership HTTP,
// and 180 s client gates, followed by bounded group
// cleanup. Keep the parent beyond their complete serial composition so a
// correct terminal record is never replaced by the test controller's timeout.
const RUN_SCRIPT_TIMEOUT_MS = 600_000;

/** The small common surface shared by Bun's piped stderr readers. */
interface PipeReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/**
 * A pipe read itself must be bounded. An outer Date.now deadline is not enough:
 * a regressed harness may simply never write another byte, leaving `reader.read`
 * pending forever and hanging the test process before it can report the useful
 * retained-state diagnostics.
 */
async function readBefore(
  reader: PipeReader,
  timeoutMs: number,
): Promise<Awaited<ReturnType<PipeReader["read"]>> | undefined> {
  let cancelDeadline: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        cancelDeadline = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelDeadline?.();
  }
}

async function waitForExitBefore(
  exited: Promise<number>,
  timeoutMs: number,
): Promise<number | undefined> {
  let cancelDeadline: (() => void) | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        cancelDeadline = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelDeadline?.();
  }
}

/** Do not wait on a stuck pipe cancellation while trying to fail the test. */
function abandonReader(reader: PipeReader): void {
  void reader.cancel().catch(() => undefined);
}

/**
 * This is deliberately only the Bun-spawned script process. The script owns and
 * proves any workload groups itself; the test must never guess at a PGID or send
 * a broad signal while reporting a timeout.
 */
async function terminateExactChild(child: SpawnedHarness): Promise<number | undefined> {
  if (child.exitCode !== null) return child.exitCode;

  child.kill("SIGTERM");
  const gracefulExit = await waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
  if (gracefulExit !== undefined) return gracefulExit;

  // The exit promise and timeout can settle on adjacent turns. Re-read Bun's
  // synchronous exit state before escalation so a known-exited child is never
  // signalled through a numeric PID that the OS may already have recycled.
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGKILL");
  return waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
}

async function waitForStderrMarker(
  child: SpawnedHarness,
  reader: PipeReader,
  decoder: TextDecoder,
  marker: string,
  timeoutMs: number,
  initialStderr = "",
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  let stderr = initialStderr;
  while (!stderr.includes(marker)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const exitCode = await terminateExactChild(child);
      abandonReader(reader);
      throw new Error(
        `timed out waiting for ${marker}; child_exit=${String(exitCode)}; stderr=${safeCaptureSummary(stderr)}`,
      );
    }
    const chunk = await readBefore(reader, remaining);
    if (chunk === undefined) {
      const exitCode = await terminateExactChild(child);
      abandonReader(reader);
      throw new Error(
        `stream timed out waiting for ${marker}; child_exit=${String(exitCode)}; stderr=${safeCaptureSummary(stderr)}`,
      );
    }
    if (chunk.done) break;
    stderr += decoder.decode(chunk.value, { stream: true });
  }
  if (!stderr.includes(marker)) {
    const exitCode = await terminateExactChild(child);
    abandonReader(reader);
    throw new Error(
      `child exited before ${marker}; child_exit=${String(exitCode)}; stderr=${safeCaptureSummary(stderr)}`,
    );
  }
  return stderr;
}

async function drainStderrBefore(
  reader: PipeReader,
  decoder: TextDecoder,
  stderr: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      abandonReader(reader);
      throw new Error(
        `timed out draining stderr after signal; stderr=${safeCaptureSummary(stderr)}`,
      );
    }
    const chunk = await readBefore(reader, remaining);
    if (chunk === undefined) {
      abandonReader(reader);
      throw new Error(
        `timed out draining stderr after signal; stderr=${safeCaptureSummary(stderr)}`,
      );
    }
    if (chunk.done) return `${stderr}${decoder.decode()}`;
    stderr += decoder.decode(chunk.value, { stream: true });
  }
}

describe("lifecycle: process-group cleanup reaches descendants, not just the leader", () => {
  test("PLANTED: a payload that exits leaves its descendant to a pinned supervisor cleanup", async () => {
    const run = await runScript(["--self-test-lifecycle"]);
    const emitted = record(run);
    expect(`${run.stderr}\n${JSON.stringify(emitted)}`).toContain("lifecycle-group-retired");
    expect(run.exitCode).toBe(0);
    expect(emitted.status).toBe("pass");
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");

    // The payload is complete, but a live, identity-pinned supervisor remains
    // with its descendant. That is what keeps later group cleanup authorized.
    const descendant = Number(phaseValue(run.stderr, "lifecycle-descendant", "pid"));
    const leader = Number(phaseValue(run.stderr, "lifecycle-pinned-supervisor", "leader"));
    expect(Number.isInteger(descendant)).toBe(true);
    expect(phaseValue(run.stderr, "lifecycle-pinned-supervisor", "status")).toBe("0");
    expect(
      phaseValue(run.stderr, "lifecycle-pinned-supervisor", "survivors")?.split(","),
    ).toContain(String(descendant));
    expect(phaseValue(run.stderr, "lifecycle-group-retired", "cleanup")).toBe(
      "post-kill-absence-proven",
    );
    expect(run.stderr).not.toContain("lifecycle-table-incomplete");
    expect(phaseValue(run.stderr, "lifecycle-sole-visible-leader", "table")).toBe("complete");
    expect(phaseValue(run.stderr, "lifecycle-sole-visible-leader", "action")).toBe("group-kill");
    // Cleanup signalled the proven group, not the pid.
    expect(phaseValue(run.stderr, "lifecycle-killed", "scope")).toBe("group");
    expect(phaseValue(run.stderr, "lifecycle-killed", "pgid")).toBe(String(leader));

    // Verified here, not merely reported by the script under test.
    expect(await waitForExit(descendant)).toBe(true);

    const stateDir = phaseValue(run.stderr, "lifecycle-state-retained", "dir") as string;
    expect(existsSync(stateDir)).toBe(true);
    const phases = readFileSync(`${stateDir}/phases.log`, "utf8");
    expect(phases).toContain("lifecycle-pinned-supervisor");
    expect(phases).toContain("lifecycle-group-retired");
    const runtimeRootsReady = phases.indexOf("runtime-roots-ready");
    expect(runtimeRootsReady).toBeGreaterThanOrEqual(0);
    for (const phase of [
      "fixture-held-before-cont",
      "fixture-cont-authorized",
      "fixture-adopted",
      "fixture-started",
    ]) {
      const phaseIndex = phases.indexOf(phase);
      expect(phaseIndex).toBeGreaterThanOrEqual(0);
      expect(runtimeRootsReady).toBeLessThan(phaseIndex);
    }
    expect(phases.includes("AAAAAAAA")).toBe(false);
  }, 60_000);

  test("PLANTED: a valid snapshot missing the required descendant is retried before survivor proof", async () => {
    const run = await runScript(["--self-test-lifecycle-observation-partial"], {
      S1_FAULT_INJECT: "ps-partial",
    });
    const emitted = record(run);
    expect(run.exitCode).toBe(0);
    expect(emitted.status).toBe("pass");
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");
    expect(phaseValue(run.stderr, "lifecycle-observation-retried", "reason")).toBe(
      "validated-snapshot-omitted-required-pid",
    );

    const descendant = Number(phaseValue(run.stderr, "lifecycle-descendant", "pid"));
    const survivors = phaseValue(run.stderr, "lifecycle-pinned-supervisor", "survivors");
    expect(Number.isInteger(descendant)).toBe(true);
    expect(survivors?.split(",")).toContain(String(descendant));
    expect(phaseValue(run.stderr, "lifecycle-group-retired", "cleanup")).toBe(
      "post-kill-absence-proven",
    );
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);

  test("PLANTED: launch-proof faults reap exact stopped direct children before payload execution", async () => {
    for (const [argument, fault, code, phase] of [
      [
        "--self-test-preexec-not-stopped",
        "supervisor-not-stopped",
        "PREEXEC_NOT_STOPPED_SELF_TEST_PASSED",
        "preexec-not-stopped",
      ],
      [
        "--self-test-preexec-identity-unavailable",
        "identity-unavailable",
        "PREEXEC_IDENTITY_UNAVAILABLE_SELF_TEST_PASSED",
        "preexec-identity-unavailable",
      ],
    ] as const) {
      const run = await runScript([argument], { S1_FAULT_INJECT: fault });
      expect(run.exitCode).toBe(0);
      expect(record(run).code).toBe(code);
      expect(run.stderr).toContain(`${phase}-group-unproven`);
      expect(phaseValue(run.stderr, `${phase}-preexec-kill`, "scope")).toBe("direct");
      const pid = Number(phaseValue(run.stderr, `${phase}-preexec-reaped`, "pid"));
      expect(Number.isInteger(pid)).toBe(true);
      // This is independently checked outside the script: no direct child and
      // no group remain, while the log pins that no negative-PGID fallback ran.
      expect(await waitForExit(pid)).toBe(true);
      expect(await waitForGroupExit(pid)).toBe(true);
      const stateDir = phaseValue(run.stderr, "state-retained", "dir") as string;
      const phases = readFileSync(`${stateDir}/phases.log`, "utf8");
      expect(phases).toContain("preexec-failure-cleaned");
      expect(phases).toContain("payload=not-started");
      expect(phases).not.toContain("scope=group");
    }
  }, 60_000);

  test("PLANTED: PID reuse cannot authorize a provisional direct-child signal", async () => {
    const run = await runScript(["--self-test-provisional-pid-reuse"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("PROVISIONAL_PID_REUSE_SELF_TEST_PASSED");
    expect(run.stderr).toContain("provisional-reuse-preexec-identity-mismatch");
    expect(run.stderr).toContain("action=not-signalled");
    const pid = Number(phaseValue(run.stderr, "provisional-reuse-refused", "pid"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(phaseValue(run.stderr, "provisional-reuse-refused", "survived")).toBe("yes");
    expect(await waitForExit(pid)).toBe(true);
    expect(await waitForGroupExit(pid)).toBe(true);
  }, 60_000);

  test("PLANTED: persistent provisional inspection-unknown exhausts its bound without signalling", async () => {
    const run = await runScript(["--self-test-provisional-inspection-unknown"], {
      S1_FAULT_INJECT: "provisional-inspection-unknown",
    });
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("PROVISIONAL_INSPECTION_UNKNOWN_SELF_TEST_PASSED");
    expect(run.stderr).toContain("provisional-unknown-preexec-inspection-unknown");
    expect(run.stderr).toContain("action=not-signalled deadline_s=1");
    const pid = Number(phaseValue(run.stderr, "provisional-inspection-refused", "pid"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(phaseValue(run.stderr, "provisional-inspection-refused", "survived")).toBe("yes");
    expect(await waitForExit(pid)).toBe(true);
    expect(await waitForGroupExit(pid)).toBe(true);
  }, 60_000);

  test("PLANTED: a descendant that ignores TERM is reported as a survivor and then killed", async () => {
    const run = await runScript(["--self-test-lifecycle-kill"]);
    const emitted = record(run);
    expect(`${run.stderr}\n${JSON.stringify(emitted)}`).toContain("lifecycle-group-retired");
    expect(run.exitCode).toBe(0);
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");

    const descendant = Number(phaseValue(run.stderr, "lifecycle-descendant", "pid"));
    // TERM delivered, ignored, reported, escalated — in that order, and the
    // survivor is named rather than silently absorbed by a "terminated" line.
    expect(phaseValue(run.stderr, "lifecycle-survivors", "pids")?.split(",")).toContain(
      String(descendant),
    );
    expect(phaseValue(run.stderr, "lifecycle-survivors", "after_s")).toMatch(/^[0-9]+$/);
    expect(phaseValue(run.stderr, "lifecycle-killed", "signal")).toBe("KILL");
    expect(phaseValue(run.stderr, "lifecycle-killed", "scope")).toBe("group");
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);

  test("PLANTED: a dead leader without recorded group ownership is refused, not walked as a pid tree", async () => {
    const run = await runScript(["--self-test-unowned-refusal"]);
    const emitted = record(run);
    expect(run.exitCode).toBe(0);
    expect(emitted.code).toBe("UNOWNED_REFUSAL_SELF_TEST_PASSED");
    expect(run.stderr).toContain("leader-absent-refused");
    expect(phaseValue(run.stderr, "leader-absent-refused", "marker")).toBe("exact");
    expect(phaseValue(run.stderr, "leader-absent-refused", "reason")).toBe("leader-absent");
    expect(phaseValue(run.stderr, "leader-absent-refused", "action")).toBe("not-signalled");
    expect(run.stderr).toContain("unowned-group-unproven");
    expect(run.stderr).toContain("unowned-refused");
    expect(run.stderr).not.toContain("scope=pid-tree");
    const descendant = Number(phaseValue(run.stderr, "unowned-refused", "descendant"));
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);
});

describe("lifecycle: containment failures stay fail-closed", () => {
  test("PLANTED: the identity marker survives an argv prefix-only observation", async () => {
    const run = await runScript(["--self-test-client-success-descendant"], {
      S1_FAULT_INJECT: "ps-argv-prefix-only",
    });
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("CLIENT_SUCCESS_DESCENDANT_SELF_TEST_PASSED");
    expect(run.stderr).toContain("client-complete-pinned");
    expect(run.stderr).toContain("client-complete-killed");
    const descendant = Number(phaseValue(run.stderr, "client-success-cleaned", "descendant"));
    expect(Number.isInteger(descendant)).toBe(true);
    expect(phaseValue(run.stderr, "client-success-cleaned", "group_empty")).toBe("yes");
  }, 60_000);

  test("PLANTED: repeated exit-0 clients with live descendants launch and clean deterministically", async () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const run = await runScript(["--self-test-client-success-descendant"]);
      expect(`attempt=${attempt} exit=${run.exitCode}\n${run.stderr}`).toContain(
        `attempt=${attempt} exit=0`,
      );
      expect(record(run).code).toBe("CLIENT_SUCCESS_DESCENDANT_SELF_TEST_PASSED");
      expect(run.stderr).toContain("client-complete-pinned");
      expect(run.stderr).toContain("client-complete-killed");
      const descendant = Number(phaseValue(run.stderr, "client-success-cleaned", "descendant"));
      expect(Number.isInteger(descendant)).toBe(true);
      expect(phaseValue(run.stderr, "client-success-cleaned", "group_empty")).toBe("yes");
    }
  }, 120_000);

  test("D4: an observed valid-row omission is distinct from ordinary TERM-proof survivor cleanup", async () => {
    const run = await runScript(["--self-test-partial-ps"], {
      S1_FAULT_INJECT: "ps-partial",
    });
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("PARTIAL_PS_SELF_TEST_PASSED");
    expect(run.stderr).toContain("child-omitted-descendant-suspected");
    expect(run.stderr).toContain("child-killed");
    const descendant = Number(phaseValue(run.stderr, "partial-ps-killed", "descendant"));
    expect(Number.isInteger(descendant)).toBe(true);
    expect(phaseValue(run.stderr, "partial-ps-killed", "kernel_group")).toBe("absent");

    const control = await runScript(["--self-test-partial-ps-negative-control"]);
    expect(control.exitCode).toBe(0);
    expect(record(control).code).toBe("PARTIAL_PS_NEGATIVE_CONTROL_SELF_TEST_PASSED");
    expect(control.stderr).not.toContain("child-omitted-descendant-suspected");
    expect(control.stderr).not.toContain("child-table-incomplete");
    expect(control.stderr).toContain("child-survivors");
  }, 60_000);

  test("D7: malformed rows and a valid prefix missing the runner all refuse signals, then clean survivors", async () => {
    for (const fault of [
      "ps-malformed-after-self",
      "ps-truncated-tail",
      "ps-truncated-before-self",
    ] as const) {
      const run = await runScript(["--self-test-ps-parser-refusal"], {
        S1_FAULT_INJECT: fault,
      });
      expect(`fault=${fault}\n${run.stderr}`).toContain("ps-parser-refused");
      expect(run.exitCode).toBe(0);
      expect(record(run).code).toBe("PS_TABLE_PARSER_REFUSAL_SELF_TEST_PASSED");
      expect(phaseValue(run.stderr, "ps-parser-refused", "fault")).toBe(fault);
      expect(phaseValue(run.stderr, "ps-parser-refused", "survived")).toBe("yes");
      expect(phaseValue(run.stderr, "ps-parser-refused", "action")).toBe("not-signalled");
      const descendant = Number(phaseValue(run.stderr, "ps-parser-survivor-cleaned", "descendant"));
      expect(Number.isInteger(descendant)).toBe(true);
      expect(phaseValue(run.stderr, "ps-parser-survivor-cleaned", "group_empty")).toBe("yes");
      const stateDir = phaseValue(run.stderr, "state-retained", "dir") as string;
      const phases = readFileSync(`${stateDir}/phases.log`, "utf8");
      expect(phases.indexOf("ps-parser-refused")).toBeLessThan(
        phases.indexOf("ps-parser-survivor-cleaned"),
      );
    }
  }, 60_000);

  test("PLANTED: failed cleanup retains ownership for the EXIT retry", async () => {
    const run = await runScript(["--self-test-cleanup-retry"], {
      S1_FAULT_INJECT: "ps-once",
    });
    expect(run.exitCode).toBe(1);
    const emitted = record(run);
    expect(emitted.status).toBe("fail");
    expect(emitted.code).toBe("CLEANUP_RETRY_EXPECTED");
    expect(run.stdout).not.toContain('"status":"pass"');
    expect(run.stderr).toContain("child-inspection-unavailable");
    expect(run.stderr).toContain("cleanup-retry-first-failure");
    expect(run.stderr).toContain("child-killed");
    const descendant = Number(phaseValue(run.stderr, "cleanup-retry-first-failure", "descendant"));
    const leader = Number(phaseValue(run.stderr, "cleanup-retry-first-failure", "leader"));
    expect(await waitForExit(descendant)).toBe(true);
    expect(await waitForGroupExit(leader)).toBe(true);
  }, 60_000);

  test("D2: containment status 125 becomes a typed terminal failure", async () => {
    const run = await runScript(["--self-test-client-containment-terminal"]);
    expect(run.exitCode).toBe(1);
    expect(record(run)).toMatchObject({
      status: "fail",
      code: "LOCAL_D1_CLIENT_CONTAINMENT_UNPROVEN",
    });
    expect(records(run)).toHaveLength(1);
  });

  test("D3: an unmarked Bun exit 1 is unknown, not a kernel absence", async () => {
    const run = await runScript(["--self-test"]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("self-test-kernel-probe-refused fault=bun-exit-1 state=unknown");
  });

  test("unknown arguments have a typed terminal refusal", async () => {
    const run = await runScript(["--not-an-s1-mode"]);
    expect(run.exitCode).toBe(1);
    expect(record(run)).toMatchObject({
      status: "fail",
      code: "UNKNOWN_ARGUMENT",
    });
  });

  test("PLANTED: cleanup-incomplete is the final typed record after an already-nonzero body", async () => {
    const run = await runScript(["--self-test-cleanup-terminal-order"], {
      S1_FAULT_INJECT: "ps-unreadable",
    });
    expect(run.exitCode).toBe(1);
    const codes = records(run).map((entry) => entry.code);
    expect(codes.slice(-2)).toEqual(["BODY_FAILURE_EXPECTED", "CLEANUP_INCOMPLETE"]);
    expect(record(run).code).toBe("CLEANUP_INCOMPLETE");
    expect(run.stderr.indexOf("BODY_FAILURE_EXPECTED")).toBeLessThan(
      run.stderr.lastIndexOf("CLEANUP_INCOMPLETE"),
    );
    expect(run.stderr).toContain("cleanup-incomplete exit_status=1");
    const leader = Number(phaseValue(run.stderr, "cleanup-terminal-child", "leader"));
    expect(Number.isInteger(leader)).toBe(true);
    expect(await waitForGroupExit(leader)).toBe(true);
  }, 60_000);

  test("PLANTED: fault injection is test-only and cannot alter a local-D1 run", async () => {
    const run = await runScript(["--local-d1"], {
      S1_FAULT_INJECT: "ps-partial",
    });
    expect(run.exitCode).toBe(78);
    expect(record(run).code).toBe("FAULT_INJECTION_TEST_ONLY");
    expect(run.stderr).not.toContain("child-started");
  });

  test("PLANTED: EXIT cannot leave a pre-emitted pass green while its pinned group still runs", async () => {
    const run = await runScript(["--self-test-exit-gate"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("EXIT_GATE_SELF_TEST_PASSED");
    const descendant = Number(phaseValue(run.stderr, "exit-gate-child", "descendant"));
    expect(Number.isInteger(descendant)).toBe(true);
    expect(run.stderr).toContain("child-killed");
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);

  test("PLANTED: a one-shot EXIT inspection fault retries cleanup before preserving a pass", async () => {
    const run = await runScript(["--self-test-exit-gate"], {
      S1_FAULT_INJECT: "ps-once",
    });
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("EXIT_GATE_SELF_TEST_PASSED");
    expect(run.stderr).toContain("exit-cleanup-retry");
    expect(run.stderr).toContain("exit-cleanup-recovered");
    const descendant = Number(phaseValue(run.stderr, "exit-gate-child", "descendant"));
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);

  test("terminal interrupt record is corrected after EXIT recovers its first cleanup attempt", async () => {
    const harness = await spawnCapturedHarness(["--self-test-interrupt-cleanup-retry"], {
      S1_FAULT_INJECT: "ps-once",
    });
    const { child } = harness;
    const decoder = new TextDecoder();
    let reader: PipeReader | undefined;
    try {
      reader = harness.stderrCapture.reader;
      let stderr = await waitForStderrMarker(
        child,
        reader,
        decoder,
        "interrupt-retry-ready",
        30_000,
      );
      const leader = Number(phaseValue(stderr, "interrupt-retry-ready", "leader"));
      expect(Number.isInteger(leader)).toBe(true);

      child.kill("SIGTERM");
      const exitCode = await waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `interrupt cleanup retry did not exit; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(reader, decoder, stderr, HARNESS_CLEANUP_TIMEOUT_MS);
      assertCaptureComplete(harness.stderrCapture);
      const run = {
        exitCode,
        stdout: await settleSocketCapture(harness.stdoutCapture),
        stderr,
      };
      expect(records(run)).toHaveLength(1);
      expect(record(run)).toMatchObject({
        status: "fail",
        code: "INTERRUPTED_TERM",
      });
      expect(stderr).toContain("interrupted-cleanup-pending");
      expect(stderr).toContain("interrupted-cleanup-recovered");
      expect(stderr).not.toContain("CLEANUP_INCOMPLETE");
      expect(await waitForGroupExit(leader)).toBe(true);
    } finally {
      await terminateExactChild(child);
      if (reader) abandonReader(reader);
      harness.closeCaptures();
    }
  }, 60_000);

  test("PLANTED: a vanished controller cannot strand the interrupt-retry fixture", async () => {
    const run = await runScript(["--self-test-interrupt-cleanup-retry"], {
      S1_FAULT_INJECT: "ps-once",
    });
    expect(run.exitCode).toBe(1);
    expect(records(run).map((entry) => entry.code)).toEqual([
      "INTERRUPT_RETRY_CONTROLLER_DEADLINE",
    ]);
    expect(record(run).status).toBe("fail");
    expect(run.stderr).toContain("exit-cleanup-retry");
    expect(run.stderr).toContain("exit-cleanup-recovered");
    const leader = Number(phaseValue(run.stderr, "interrupt-retry-ready", "leader"));
    expect(Number.isInteger(leader)).toBe(true);
    expect(await waitForGroupExit(leader)).toBe(true);
  }, 30_000);

  test("PLANTED: deadline expiry waits for group cleanup and returns 124 only after the descendant is gone", async () => {
    const run = await runScript(["--self-test-deadline"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("DEADLINE_SELF_TEST_PASSED");
    expect(run.stderr).toContain("deadline-killed");
    const descendant = Number(phaseValue(run.stderr, "deadline-cleaned", "descendant"));
    expect(Number.isInteger(descendant)).toBe(true);
    expect(phaseValue(run.stderr, "deadline-cleaned", "group_empty")).toBe("yes");
  }, 60_000);

  test("PLANTED: the named Wrangler phase times out only after its stubborn group is gone", async () => {
    for (const phase of ["migration"] as const) {
      const run = await runScript(["--self-test-named-phase"], {
        S1_NAMED_PHASE: phase,
        S1_NAMED_PHASE_BEHAVIOR: "deadline",
      });
      expect(run.exitCode, phase).toBe(0);
      expect(record(run).code, phase).toBe("NAMED_PHASE_DEADLINE_SELF_TEST_PASSED");
      expect(run.stderr, phase).toContain(`${phase}-started`);
      expect(run.stderr, phase).toContain(`${phase}-deadline-killed`);
      expect(run.stderr, phase).toContain(`named-phase-deadline-cleaned phase=${phase}`);
      const descendant = Number(
        phaseValue(run.stderr, "named-phase-deadline-cleaned", "descendant"),
      );
      const leader = Number(phaseValue(run.stderr, `${phase}-started`, "pid"));
      expect(Number.isInteger(descendant), phase).toBe(true);
      expect(Number.isInteger(leader), phase).toBe(true);
      expect(phaseValue(run.stderr, "named-phase-deadline-cleaned", "group_empty"), phase).toBe(
        "yes",
      );
    }
  }, 90_000);

  test("PLANTED: TERM during the named phase uses that phase's adopted ownership", async () => {
    for (const phase of ["migration"] as const) {
      const harness = await spawnCapturedHarness(["--self-test-named-phase"], {
        S1_NAMED_PHASE: phase,
        S1_NAMED_PHASE_BEHAVIOR: "interrupt",
      });
      const { child } = harness;
      const decoder = new TextDecoder();
      let reader: PipeReader | undefined;
      try {
        reader = harness.stderrCapture.reader;
        let stderr = await waitForStderrMarker(child, reader, decoder, `${phase}-started`, 30_000);
        const leader = Number(phaseValue(stderr, `${phase}-started`, "pid"));
        const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
        expect(Number.isInteger(leader), phase).toBe(true);
        expect(stateDir, phase).toBeDefined();
        expect(await waitForFile(`${stateDir}/descendant.pid`), phase).toBe(true);
        child.kill("SIGTERM");
        const exitCode = await waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
        expect(exitCode, phase).toBe(1);
        stderr = await drainStderrBefore(reader, decoder, stderr, HARNESS_CLEANUP_TIMEOUT_MS);
        expect(
          record({
            exitCode: exitCode ?? 1,
            stdout: await settleSocketCapture(harness.stdoutCapture),
            stderr,
          }).code,
          phase,
        ).toBe("INTERRUPTED_TERM");
        expect(stderr, phase).toContain(`cleanup-begin signal=TERM`);
        expect(stderr, phase).toContain(`${phase}-`);
        const descendant = Number(readFileSync(`${stateDir}/descendant.pid`, "utf8").trim());
        expect(Number.isInteger(descendant), phase).toBe(true);
        expect(await waitForExit(descendant), phase).toBe(true);
        expect(await waitForGroupExit(leader), phase).toBe(true);
      } finally {
        await terminateExactChild(child);
        if (reader) abandonReader(reader);
        harness.closeCaptures();
      }
    }
  }, 120_000);

  test("PLANTED: missing status is running, while malformed and stale retained paths are untrusted", async () => {
    const run = await runScript(["--self-test-status-integrity"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("STATUS_INTEGRITY_SELF_TEST_PASSED");
    expect(run.stderr).toContain("status-integrity-refused");
    expect(phaseValue(run.stderr, "status-integrity-refused", "malformed")).toBe(
      "tested-and-untrusted",
    );
  });
});

describe("lifecycle: parallel runs and signal handling", () => {
  test("PLANTED: every launch, CONT, return, and CLIENT/SERVER adoption window defers interruption atomically", async () => {
    const windows = [
      ["before-background-spawn", "client"],
      ["after-background-spawn", "client"],
      ["after-stop-proof", "client"],
      ["after-identity-proof", "client"],
      ["before-cont-reproof", "client"],
      ["after-cont-release", "client"],
      ["function-return", "client"],
      ["caller-adoption-client", "client"],
      ["caller-adopted-client", "client"],
      ["caller-adoption-server", "server"],
      ["caller-adopted-server", "server"],
    ] as const;

    for (const [window, owner] of windows) {
      const run = await runScript(["--self-test-lifecycle-critical-window"], {
        S1_INTERRUPT_WINDOW: window,
        S1_INTERRUPT_OWNER: owner,
      });
      expect(`window=${window}\n${run.stderr}`).toContain("lifecycle-interrupt-deferred");
      expect(run.exitCode).toBe(1);
      expect(record(run).code).toBe("INTERRUPTED_TERM");
      expect(run.stderr).not.toContain("CLEANUP_INCOMPLETE");
      const deferredAt = run.stderr.indexOf("lifecycle-interrupt-deferred");
      const dispatchedAt = run.stderr.indexOf("lifecycle-critical-dispatch");
      const cleanupAt = run.stderr.indexOf("cleanup-begin");
      expect(deferredAt).toBeGreaterThanOrEqual(0);
      expect(dispatchedAt).toBeGreaterThan(deferredAt);
      expect(cleanupAt).toBeGreaterThan(dispatchedAt);

      if (window === "before-background-spawn") {
        expect(phaseValue(run.stderr, "lifecycle-critical-window", "provisional")).toBe("none");
        expect(run.stderr).not.toContain("cont-authorized");
        continue;
      }

      expect(run.stderr).toContain("cont-authorized");
      const checkpointPid = Number(
        phaseValue(run.stderr, "lifecycle-critical-window", "provisional"),
      );
      const adoptedPhase = owner === "client" ? "client-adopted" : "critical-server-adopted";
      const adoptedPid = Number(phaseValue(run.stderr, adoptedPhase, "pid"));
      const ownedPid = Number.isInteger(checkpointPid) ? checkpointPid : adoptedPid;
      expect(Number.isInteger(ownedPid)).toBe(true);
      expect(await waitForExit(ownedPid)).toBe(true);
      expect(await waitForGroupExit(ownedPid)).toBe(true);
    }
  }, 120_000);

  test("PLANTED: two runs in parallel both pass, on distinct ports and state directories", async () => {
    if (!existsSync(WRANGLER)) {
      await assertWranglerBlocked();
      return;
    }
    const [first, second] = await Promise.all([
      runScript(["--local-d1"]),
      runScript(["--local-d1"]),
    ]);

    const detail = (run: Run) => {
      const lastRecord = records(run).at(-1);
      const diagnostic = run.exitCode === 0 ? "" : ` ${failureEvidence(run).replaceAll("\n", ";")}`;
      return (
        `exit=${run.exitCode} port=${phaseValue(run.stderr, "port-allocated", "port")} ` +
        `code=${String(lastRecord?.code ?? "none")}${diagnostic}`
      );
    };
    expect(`first ${detail(first)} | second ${detail(second)}`).toContain("exit=0 port=");
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const firstPort = phaseValue(first.stderr, "port-allocated", "port");
    const secondPort = phaseValue(second.stderr, "port-allocated", "port");
    const firstInspectorPort = phaseValue(first.stderr, "inspector-port-allocated", "port");
    const secondInspectorPort = phaseValue(second.stderr, "inspector-port-allocated", "port");
    expect(firstPort).toBeDefined();
    expect(secondPort).not.toBe(firstPort);
    expect(firstInspectorPort).not.toBe(firstPort);
    expect(secondInspectorPort).not.toBe(secondPort);
    expect(firstInspectorPort).not.toBe(secondInspectorPort);

    const firstDir = phaseValue(first.stderr, "state-retained", "dir");
    const secondDir = phaseValue(second.stderr, "state-retained", "dir");
    expect(secondDir).not.toBe(firstDir);
    // Retained, both of them: no cleanup-by-deletion on either path.
    expect(existsSync(firstDir as string)).toBe(true);
    expect(existsSync(secondDir as string)).toBe(true);
  }, 720_000);

  test("PLANTED: TERM terminates the whole child group and retains the state directory", async () => {
    if (!existsSync(WRANGLER)) {
      await assertWranglerBlocked();
      return;
    }
    const harness = await spawnCapturedHarness(["--local-d1"]);
    const { child } = harness;

    // Read stderr incrementally so the TERM lands while the child is really up.
    const decoder = new TextDecoder();
    let reader: PipeReader | undefined;
    try {
      reader = harness.stderrCapture.reader;
      let stderr = await waitForStderrMarker(
        child,
        reader,
        decoder,
        "child-started",
        LOCAL_CHILD_START_TIMEOUT_MS,
      );
      expect(stderr).toContain("child-started");

      const wranglerPid = Number(phaseValue(stderr, "child-started", "pid"));
      const localPort = Number(phaseValue(stderr, "child-started", "port"));
      const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
      expect(Number.isInteger(wranglerPid)).toBe(true);
      expect(Number.isInteger(localPort)).toBe(true);
      expect(stateDir).toBeDefined();

      child.kill("SIGTERM");
      const exitCode = await waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `TERM did not stop the local-D1 harness; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(reader, decoder, stderr, HARNESS_CLEANUP_TIMEOUT_MS);
      assertCaptureComplete(harness.stderrCapture);

      // A signalled run is a failure with a typed code, not a silent zero.
      expect(exitCode).toBe(1);
      expect(
        record({
          exitCode,
          stdout: await settleSocketCapture(harness.stdoutCapture),
          stderr,
        }),
      ).toMatchObject({ status: "fail", code: "INTERRUPTED_TERM" });
      expect(stderr).toContain("INTERRUPTED");
      expect(stderr).toContain("state_retained=");

      // The whole group is gone: neither the wrangler shell nor its workerd
      // children survive. Only ESRCH proves that; EPERM remains a live/unknown
      // group and cannot satisfy this assertion.
      expect(await waitForGroupExit(wranglerPid)).toBe(true);
      expect(await waitForPortFree(localPort)).toBe(true);

      // State is retained, including the phase log, which is the whole point of
      // keeping it: an interrupted run is the one whose logs someone wants.
      expect(existsSync(stateDir)).toBe(true);
      const phases = readFileSync(`${stateDir}/phases.log`, "utf8");
      expect(phases).toContain("child-started");
      expect(phases).toContain("interrupted");
      expect(phases).toContain("replay-key-artifact-scan result=absent");
      // Logs carry lifecycle facts only, never the local replay key.
      expect(phases.includes("AAAAAAAA")).toBe(false);
    } finally {
      await terminateExactChild(child);
      if (reader) abandonReader(reader);
      harness.closeCaptures();
    }
  }, 480_000);

  test("PLANTED: HUP terminates the local-D1 worker group and releases its port FD", async () => {
    if (!existsSync(WRANGLER)) {
      await assertWranglerBlocked();
      return;
    }
    const harness = await spawnCapturedHarness(["--local-d1"]);
    const { child } = harness;
    const decoder = new TextDecoder();
    let reader: PipeReader | undefined;
    try {
      reader = harness.stderrCapture.reader;
      let stderr = await waitForStderrMarker(
        child,
        reader,
        decoder,
        "child-started",
        LOCAL_CHILD_START_TIMEOUT_MS,
      );
      const supervisor = Number(phaseValue(stderr, "child-started", "pid"));
      const localPort = Number(phaseValue(stderr, "child-started", "port"));
      expect(Number.isInteger(supervisor)).toBe(true);
      expect(Number.isInteger(localPort)).toBe(true);

      child.kill("SIGHUP");
      const exitCode = await waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `HUP did not stop the local-D1 harness; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(reader, decoder, stderr, HARNESS_CLEANUP_TIMEOUT_MS);
      assertCaptureComplete(harness.stderrCapture);

      expect(exitCode).toBe(1);
      expect(
        record({
          exitCode,
          stdout: await settleSocketCapture(harness.stdoutCapture),
          stderr,
        }).code,
      ).toBe("INTERRUPTED_HUP");
      expect(stderr).toContain("cleanup-begin signal=HUP");
      expect(await waitForGroupExit(supervisor)).toBe(true);
      // A successful rebind proves no workerd listener FD survived the HUP path.
      expect(await waitForPortFree(localPort)).toBe(true);
    } finally {
      await terminateExactChild(child);
      if (reader) abandonReader(reader);
      harness.closeCaptures();
    }
  }, 480_000);

  test("PLANTED: TERM during the client phase terminates the client supervisor group", async () => {
    const harness = await spawnCapturedHarness(["--self-test-client-group"]);
    const { child } = harness;
    const decoder = new TextDecoder();
    let reader: PipeReader | undefined;
    try {
      reader = harness.stderrCapture.reader;
      let stderr = await waitForStderrMarker(child, reader, decoder, "client-started", 30_000);
      expect(stderr).toContain("client-started");
      const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
      const supervisor = Number(phaseValue(stderr, "client-started", "pid"));
      expect(await waitForFile(`${stateDir}/descendant.pid`)).toBe(true);
      const descendant = Number(readFileSync(`${stateDir}/descendant.pid`, "utf8").trim());

      child.kill("SIGTERM");
      const exitCode = await waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `TERM did not stop the client-phase harness; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(reader, decoder, stderr, HARNESS_CLEANUP_TIMEOUT_MS);
      assertCaptureComplete(harness.stderrCapture);

      expect(exitCode).toBe(1);
      expect(
        record({
          exitCode,
          stdout: await settleSocketCapture(harness.stdoutCapture),
          stderr,
        }).code,
      ).toBe("INTERRUPTED_TERM");
      expect(stderr).toContain("INTERRUPTED s1-cold-enrollment");
      expect(stderr).toContain("client-killed");
      expect(await waitForExit(descendant)).toBe(true);
      expect(await waitForGroupExit(supervisor)).toBe(true);
    } finally {
      await terminateExactChild(child);
      if (reader) abandonReader(reader);
      harness.closeCaptures();
    }
  }, 60_000);

  test("PLANTED: a second signal after cleanup begins is masked until the zero-survivor gate finishes", async () => {
    const harness = await spawnCapturedHarness(["--self-test-client-group"]);
    const { child } = harness;
    const decoder = new TextDecoder();
    let reader: PipeReader | undefined;
    try {
      reader = harness.stderrCapture.reader;
      let stderr = await waitForStderrMarker(child, reader, decoder, "client-started", 30_000);
      const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
      const supervisor = Number(phaseValue(stderr, "client-started", "pid"));
      expect(await waitForFile(`${stateDir}/descendant.pid`)).toBe(true);
      const descendant = Number(readFileSync(`${stateDir}/descendant.pid`, "utf8").trim());

      child.kill("SIGTERM");
      stderr = await waitForStderrMarker(child, reader, decoder, "cleanup-begin", 10_000, stderr);
      // The first handler has installed the INT/TERM/HUP mask before it emits
      // cleanup-begin, so this is genuinely a second signal during cleanup.
      child.kill("SIGHUP");
      const exitCode = await waitForExitBefore(child.exited, HARNESS_CLEANUP_TIMEOUT_MS);
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `second signal bypassed cleanup; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(reader, decoder, stderr, HARNESS_CLEANUP_TIMEOUT_MS);
      assertCaptureComplete(harness.stderrCapture);

      expect(exitCode).toBe(1);
      expect(
        record({
          exitCode,
          stdout: await settleSocketCapture(harness.stdoutCapture),
          stderr,
        }).code,
      ).toBe("INTERRUPTED_TERM");
      expect(stderr).toContain("client-killed");
      expect(await waitForExit(descendant)).toBe(true);
      expect(await waitForGroupExit(supervisor)).toBe(true);
    } finally {
      await terminateExactChild(child);
      if (reader) abandonReader(reader);
      harness.closeCaptures();
    }
  }, 60_000);
});
