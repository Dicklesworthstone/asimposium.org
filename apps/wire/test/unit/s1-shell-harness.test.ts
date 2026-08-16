import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";

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
const WRANGLER = resolve(REPO_ROOT, "apps/wire/node_modules/.bin/wrangler");

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
  let pendingRead:
    ((result: { done: boolean; value?: Uint8Array }) => void) | undefined;
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

async function spawnCapturedHarness(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<CapturedHarness> {
  const [stdoutCapture, stderrCapture] = await Promise.all([
    socketCapture(),
    socketCapture(),
  ]);
  const subprocess = spawn(
    "bash",
    [
      "-c",
      'set -e; exec 3<>"/dev/tcp/127.0.0.1/$1"; exec 4<>"/dev/tcp/127.0.0.1/$2"; exec 1>&3 2>&4; shift 2; exec bash "$@"',
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
      return typeof parsed.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.code)
        ? [parsed.code]
        : [];
    } catch {
      return [];
    }
  });
  const phases = lines.flatMap((line) => {
    const match = line.match(
      /^\[s1-cold-enrollment\] ([a-z][a-z0-9-]{0,63})(?:\s|$)/,
    );
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
): Promise<Run> {
  const harness = await spawnCapturedHarness(args, env);
  const { child, stdoutCapture, stderrCapture } = harness;
  try {
    const exitCode = await waitForExitBefore(
      child.exited,
      RUN_SCRIPT_TIMEOUT_MS,
    );
    if (exitCode === undefined) {
      const forcedExit = await terminateExactChild(child);
      throw new Error(
        `script exceeded its test deadline; forced_exit=${String(forcedExit)}`,
      );
    }
    const [stdout, stderr] = await Promise.all([
      settleSocketCapture(stdoutCapture),
      settleSocketCapture(stderrCapture),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await terminateExactChild(child);
    harness.closeCaptures();
  }
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
  };
}

async function assertWranglerBlocked(): Promise<void> {
  const run = await runScript(["--local-d1"]);
  expect(run.exitCode).toBe(78);
  expect(record(run).status).toBe("blocked");
  expect(record(run).code).toBe("WRANGLER_REQUIRED");
}

function phaseValue(
  stderr: string,
  phase: string,
  key: string,
): string | undefined {
  const line = stderr.split("\n").find((entry) => entry.includes(` ${phase} `));
  return line?.match(new RegExp(`${key}=([^\\s]+)`))?.[1];
}

describe("the in-memory child-output transport", () => {
  test("reports malformed NDJSON without echoing its bytes", () => {
    expect(() =>
      records({ exitCode: 1, stdout: '{"code":"BROKEN"', stderr: "" }),
    ).toThrow("S1_OUTPUT_RECORD_INVALID");
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
      expect(await settleSocketCapture(capture)).toBe(
        '{"code":"SPLIT_RECORD"}\n',
      );
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
      expect(failure).toBe(
        `S1_CAPTURE_LIMIT_EXCEEDED bytes=${CAPTURE_LIMIT_BYTES + 1}`,
      );
      expect(failure.includes("xxxx")).toBe(false);
    } finally {
      client.destroy();
      capture.close();
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
  if (typeof port !== "number")
    throw new Error("expected a TCP port for the squatter");
  return { port, stop: () => server.stop(true) };
}

describe("the self-test and the blocked external proof", () => {
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
      expect(run.stderr).toContain(
        `self-test-parser-refused fault=${fault} action=not-accepted`,
      );
    }
    const stateDir = phaseValue(run.stderr, "state-retained", "dir") as string;
    expect(existsSync(stateDir)).toBe(true);
    const retained = retainedArtifacts(stateDir);
    expect(retained.files.length).toBeGreaterThanOrEqual(2);
    // NUL-containing files (such as local state) are byte-scanned, not skipped.
    // This asserts the count and refuses any artifact that was not scanned.
    expect(retained.scannedNulArtifacts).toBe(retained.nulArtifacts);
    expect(retained.unscannedNulArtifacts).toBe(0);
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

    const errno = (code: "ESRCH" | "EPERM") =>
      Object.assign(new Error(code), { code });
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

  test("D1: a rejected capsule GET emits a terminal failure even though its body is discarded", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("refused", { status: 503 }),
    });
    try {
      const run = await runScript(
        [],
        enrollmentEnv(`http://127.0.0.1:${server.port}`),
      );
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

  test("D1: a malformed poll response replaces an earlier proposal pass with a terminal failure", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname.startsWith("/join/")) {
          return Response.json({ enrollment_id: "ASIMP-EN-7F3K9M2Q8R" });
        }
        if (pathname === "/v1/fellows") {
          return Response.json(
            { flow_handle: `flow_v1.${"B".repeat(43)}` },
            { status: 201 },
          );
        }
        if (pathname === "/v1/fellows/flow") return Response.json({});
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const run = await runScript(
        [],
        enrollmentEnv(`http://127.0.0.1:${server.port}`),
      );
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

  test("D1: a poll-body construction failure replaces PROPOSAL_CREATED with one terminal failure", async () => {
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
          return Response.json(
            { flow_handle: `flow_v1.${"B".repeat(43)}` },
            { status: 201 },
          );
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
    expect(source).not.toContain(
      "SECONDS + TRANSIENT_INSPECTION_DEADLINE_SECONDS",
    );
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

  test("the external three-harness / OAuth / staging proof stays blocked, never simulated", async () => {
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
    ["70000", "not-a-port"],
    ["-1", "8080 8080"],
  ]) {
    test(`PLANTED: invalid pinned ports ${pinnedValues.map((value) => JSON.stringify(value)).join(", ")} are refused`, async () => {
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
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(phaseValue(run.stderr, "port-allocated", "pinned")).toBe("no");
    // Readiness is tied to this run's own D1 state, not merely to "something answered".
    expect(run.stderr).toContain("port-ownership-proven");
    expect(record(run)).toMatchObject({
      code: "LOCAL_D1_ENROLLMENT_PASSED",
      reproduce: "scripts/e2e-s1-cold-enrollment.sh --local-d1",
    });
    expect(phaseValue(run.stderr, "replay-key-artifact-scan", "result")).toBe(
      "absent",
    );
    const stateDir = phaseValue(run.stderr, "state-retained", "dir") as string;
    const retained = retainedArtifacts(stateDir);
    expect(retained.files.length).toBeGreaterThanOrEqual(3);
    expect(retained.scannedNulArtifacts).toBe(retained.nulArtifacts);
    expect(retained.unscannedNulArtifacts).toBe(0);
  }, 630_000);

  test("PLANTED: the retained-artifact scanner detects its exact non-credential canary", async () => {
    const run = await runScript(["--self-test-replay-artifact-scan"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("REPLAY_ARTIFACT_SCAN_SELF_TEST_PASSED");
    expect(
      phaseValue(run.stderr, "replay-key-artifact-plant-refused", "result"),
    ).toBe("detected");
  });
});

function retainedArtifacts(root: string): {
  files: Array<{ path: string; bytes: Uint8Array }>;
  nulArtifacts: number;
  scannedNulArtifacts: number;
  unscannedNulArtifacts: number;
} {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  let nulArtifacts = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = retainedArtifacts(path);
      files.push(...nested.files);
      nulArtifacts += nested.nulArtifacts;
    } else if (entry.isFile()) {
      const bytes = readFileSync(path);
      if (bytes.includes(0)) nulArtifacts += 1;
      // Scan raw bytes rather than attempting text decoding: a NUL-containing
      // SQLite/local-state file is still an artifact in scope for secret proof.
      files.push({ path, bytes });
    } else
      throw new Error(
        `retained state contains a non-regular artifact: ${path}`,
      );
  }
  return {
    files,
    nulArtifacts,
    scannedNulArtifacts: nulArtifacts,
    unscannedNulArtifacts: 0,
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
// The shell has separate 120 s migration, 45 s readiness, 15 s ownership HTTP,
// 30 s ownership-query, and 180 s client gates, followed by bounded group
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
async function terminateExactChild(
  child: SpawnedHarness,
): Promise<number | undefined> {
  if (child.exitCode !== null) return child.exitCode;

  child.kill("SIGTERM");
  const gracefulExit = await waitForExitBefore(
    child.exited,
    HARNESS_CLEANUP_TIMEOUT_MS,
  );
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
    expect(`${run.stderr}\n${JSON.stringify(emitted)}`).toContain(
      "lifecycle-group-retired",
    );
    expect(run.exitCode).toBe(0);
    expect(emitted.status).toBe("pass");
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");

    // The payload is complete, but a live, identity-pinned supervisor remains
    // with its descendant. That is what keeps later group cleanup authorized.
    const descendant = Number(
      phaseValue(run.stderr, "lifecycle-descendant", "pid"),
    );
    const leader = Number(
      phaseValue(run.stderr, "lifecycle-pinned-supervisor", "leader"),
    );
    expect(Number.isInteger(descendant)).toBe(true);
    expect(
      phaseValue(run.stderr, "lifecycle-pinned-supervisor", "status"),
    ).toBe("0");
    expect(
      phaseValue(run.stderr, "lifecycle-pinned-supervisor", "survivors")?.split(
        ",",
      ),
    ).toContain(String(descendant));
    expect(phaseValue(run.stderr, "lifecycle-group-retired", "cleanup")).toBe(
      "post-kill-absence-proven",
    );
    expect(run.stderr).not.toContain("lifecycle-table-incomplete");
    expect(
      phaseValue(run.stderr, "lifecycle-sole-visible-leader", "table"),
    ).toBe("complete");
    expect(
      phaseValue(run.stderr, "lifecycle-sole-visible-leader", "action"),
    ).toBe("group-kill");
    // Cleanup signalled the proven group, not the pid.
    expect(phaseValue(run.stderr, "lifecycle-killed", "scope")).toBe("group");
    expect(phaseValue(run.stderr, "lifecycle-killed", "pgid")).toBe(
      String(leader),
    );

    // Verified here, not merely reported by the script under test.
    expect(await waitForExit(descendant)).toBe(true);

    const stateDir = phaseValue(
      run.stderr,
      "lifecycle-state-retained",
      "dir",
    ) as string;
    expect(existsSync(stateDir)).toBe(true);
    const phases = readFileSync(`${stateDir}/phases.log`, "utf8");
    expect(phases).toContain("lifecycle-pinned-supervisor");
    expect(phases).toContain("lifecycle-group-retired");
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
    expect(
      phaseValue(run.stderr, "lifecycle-observation-retried", "reason"),
    ).toBe("validated-snapshot-omitted-required-pid");

    const descendant = Number(
      phaseValue(run.stderr, "lifecycle-descendant", "pid"),
    );
    const survivors = phaseValue(
      run.stderr,
      "lifecycle-pinned-supervisor",
      "survivors",
    );
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
      expect(phaseValue(run.stderr, `${phase}-preexec-kill`, "scope")).toBe(
        "direct",
      );
      const pid = Number(
        phaseValue(run.stderr, `${phase}-preexec-reaped`, "pid"),
      );
      expect(Number.isInteger(pid)).toBe(true);
      // This is independently checked outside the script: no direct child and
      // no group remain, while the log pins that no negative-PGID fallback ran.
      expect(await waitForExit(pid)).toBe(true);
      expect(await waitForGroupExit(pid)).toBe(true);
      const stateDir = phaseValue(
        run.stderr,
        "state-retained",
        "dir",
      ) as string;
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
    const pid = Number(
      phaseValue(run.stderr, "provisional-reuse-refused", "pid"),
    );
    expect(Number.isInteger(pid)).toBe(true);
    expect(
      phaseValue(run.stderr, "provisional-reuse-refused", "survived"),
    ).toBe("yes");
    expect(await waitForExit(pid)).toBe(true);
    expect(await waitForGroupExit(pid)).toBe(true);
  }, 60_000);

  test("PLANTED: persistent provisional inspection-unknown exhausts its bound without signalling", async () => {
    const run = await runScript(
      ["--self-test-provisional-inspection-unknown"],
      {
        S1_FAULT_INJECT: "provisional-inspection-unknown",
      },
    );
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe(
      "PROVISIONAL_INSPECTION_UNKNOWN_SELF_TEST_PASSED",
    );
    expect(run.stderr).toContain(
      "provisional-unknown-preexec-inspection-unknown",
    );
    expect(run.stderr).toContain("action=not-signalled deadline_s=1");
    const pid = Number(
      phaseValue(run.stderr, "provisional-inspection-refused", "pid"),
    );
    expect(Number.isInteger(pid)).toBe(true);
    expect(
      phaseValue(run.stderr, "provisional-inspection-refused", "survived"),
    ).toBe("yes");
    expect(await waitForExit(pid)).toBe(true);
    expect(await waitForGroupExit(pid)).toBe(true);
  }, 60_000);

  test("PLANTED: a descendant that ignores TERM is reported as a survivor and then killed", async () => {
    const run = await runScript(["--self-test-lifecycle-kill"]);
    const emitted = record(run);
    expect(`${run.stderr}\n${JSON.stringify(emitted)}`).toContain(
      "lifecycle-group-retired",
    );
    expect(run.exitCode).toBe(0);
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");

    const descendant = Number(
      phaseValue(run.stderr, "lifecycle-descendant", "pid"),
    );
    // TERM delivered, ignored, reported, escalated — in that order, and the
    // survivor is named rather than silently absorbed by a "terminated" line.
    expect(
      phaseValue(run.stderr, "lifecycle-survivors", "pids")?.split(","),
    ).toContain(String(descendant));
    expect(phaseValue(run.stderr, "lifecycle-survivors", "after_s")).toMatch(
      /^[0-9]+$/,
    );
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
    expect(phaseValue(run.stderr, "leader-absent-refused", "marker")).toBe(
      "exact",
    );
    expect(phaseValue(run.stderr, "leader-absent-refused", "reason")).toBe(
      "leader-absent",
    );
    expect(phaseValue(run.stderr, "leader-absent-refused", "action")).toBe(
      "not-signalled",
    );
    expect(run.stderr).toContain("unowned-group-unproven");
    expect(run.stderr).toContain("unowned-refused");
    expect(run.stderr).not.toContain("scope=pid-tree");
    const descendant = Number(
      phaseValue(run.stderr, "unowned-refused", "descendant"),
    );
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);
});

describe("lifecycle: containment failures stay fail-closed", () => {
  test("PLANTED: repeated exit-0 clients with live descendants launch and clean deterministically", async () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const run = await runScript(["--self-test-client-success-descendant"]);
      expect(
        `attempt=${attempt} exit=${run.exitCode}\n${run.stderr}`,
      ).toContain(`attempt=${attempt} exit=0`);
      expect(record(run).code).toBe(
        "CLIENT_SUCCESS_DESCENDANT_SELF_TEST_PASSED",
      );
      expect(run.stderr).toContain("client-complete-pinned");
      expect(run.stderr).toContain("client-complete-killed");
      const descendant = Number(
        phaseValue(run.stderr, "client-success-cleaned", "descendant"),
      );
      expect(await waitForExit(descendant)).toBe(true);
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
    const descendant = Number(
      phaseValue(run.stderr, "partial-ps-killed", "descendant"),
    );
    expect(await waitForExit(descendant)).toBe(true);

    const control = await runScript([
      "--self-test-partial-ps-negative-control",
    ]);
    expect(control.exitCode).toBe(0);
    expect(record(control).code).toBe(
      "PARTIAL_PS_NEGATIVE_CONTROL_SELF_TEST_PASSED",
    );
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
      expect(phaseValue(run.stderr, "ps-parser-refused", "survived")).toBe(
        "yes",
      );
      expect(phaseValue(run.stderr, "ps-parser-refused", "action")).toBe(
        "not-signalled",
      );
      const descendant = Number(
        phaseValue(run.stderr, "ps-parser-survivor-cleaned", "descendant"),
      );
      expect(Number.isInteger(descendant)).toBe(true);
      expect(await waitForExit(descendant)).toBe(true);
      const stateDir = phaseValue(
        run.stderr,
        "state-retained",
        "dir",
      ) as string;
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
    const descendant = Number(
      phaseValue(run.stderr, "cleanup-retry-first-failure", "descendant"),
    );
    const leader = Number(
      phaseValue(run.stderr, "cleanup-retry-first-failure", "leader"),
    );
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
    expect(run.stderr).toContain(
      "self-test-kernel-probe-refused fault=bun-exit-1 state=unknown",
    );
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
    expect(codes.slice(-2)).toEqual([
      "BODY_FAILURE_EXPECTED",
      "CLEANUP_INCOMPLETE",
    ]);
    expect(record(run).code).toBe("CLEANUP_INCOMPLETE");
    expect(run.stderr.indexOf("BODY_FAILURE_EXPECTED")).toBeLessThan(
      run.stderr.lastIndexOf("CLEANUP_INCOMPLETE"),
    );
    expect(run.stderr).toContain("cleanup-incomplete exit_status=1");
    const leader = Number(
      phaseValue(run.stderr, "cleanup-terminal-child", "leader"),
    );
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
    const descendant = Number(
      phaseValue(run.stderr, "exit-gate-child", "descendant"),
    );
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
    const descendant = Number(
      phaseValue(run.stderr, "exit-gate-child", "descendant"),
    );
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);

  test("terminal interrupt record is corrected after EXIT recovers its first cleanup attempt", async () => {
    const harness = await spawnCapturedHarness(
      ["--self-test-interrupt-cleanup-retry"],
      {
        S1_FAULT_INJECT: "ps-once",
      },
    );
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
      const leader = Number(
        phaseValue(stderr, "interrupt-retry-ready", "leader"),
      );
      expect(Number.isInteger(leader)).toBe(true);

      child.kill("SIGTERM");
      const exitCode = await waitForExitBefore(
        child.exited,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `interrupt cleanup retry did not exit; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(
        reader,
        decoder,
        stderr,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
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
    const leader = Number(
      phaseValue(run.stderr, "interrupt-retry-ready", "leader"),
    );
    expect(Number.isInteger(leader)).toBe(true);
    expect(await waitForGroupExit(leader)).toBe(true);
  }, 30_000);

  test("PLANTED: deadline expiry waits for group cleanup and returns 124 only after the descendant is gone", async () => {
    const run = await runScript(["--self-test-deadline"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("DEADLINE_SELF_TEST_PASSED");
    expect(run.stderr).toContain("deadline-killed");
    const descendant = Number(
      phaseValue(run.stderr, "deadline-cleaned", "descendant"),
    );
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);

  test("PLANTED: both named Wrangler phases time out only after their stubborn groups are gone", async () => {
    for (const phase of ["migration", "ownership-query"] as const) {
      const run = await runScript(["--self-test-named-phase"], {
        S1_NAMED_PHASE: phase,
        S1_NAMED_PHASE_BEHAVIOR: "deadline",
      });
      expect(run.exitCode, phase).toBe(0);
      expect(record(run).code, phase).toBe(
        "NAMED_PHASE_DEADLINE_SELF_TEST_PASSED",
      );
      expect(run.stderr, phase).toContain(`${phase}-started`);
      expect(run.stderr, phase).toContain(`${phase}-deadline-killed`);
      expect(run.stderr, phase).toContain(
        `named-phase-deadline-cleaned phase=${phase}`,
      );
      const descendant = Number(
        phaseValue(run.stderr, "named-phase-deadline-cleaned", "descendant"),
      );
      const leader = Number(phaseValue(run.stderr, `${phase}-started`, "pid"));
      expect(Number.isInteger(descendant), phase).toBe(true);
      expect(Number.isInteger(leader), phase).toBe(true);
      expect(await waitForExit(descendant), phase).toBe(true);
      expect(await waitForGroupExit(leader), phase).toBe(true);
    }
  }, 90_000);

  test("PLANTED: TERM during either named phase uses that phase's adopted ownership", async () => {
    for (const phase of ["migration", "ownership-query"] as const) {
      const harness = await spawnCapturedHarness(["--self-test-named-phase"], {
        S1_NAMED_PHASE: phase,
        S1_NAMED_PHASE_BEHAVIOR: "interrupt",
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
          `${phase}-started`,
          30_000,
        );
        const leader = Number(phaseValue(stderr, `${phase}-started`, "pid"));
        const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
        expect(Number.isInteger(leader), phase).toBe(true);
        expect(stateDir, phase).toBeDefined();
        expect(await waitForFile(`${stateDir}/descendant.pid`), phase).toBe(
          true,
        );
        child.kill("SIGTERM");
        const exitCode = await waitForExitBefore(
          child.exited,
          HARNESS_CLEANUP_TIMEOUT_MS,
        );
        expect(exitCode, phase).toBe(1);
        stderr = await drainStderrBefore(
          reader,
          decoder,
          stderr,
          HARNESS_CLEANUP_TIMEOUT_MS,
        );
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
        const descendant = Number(
          readFileSync(`${stateDir}/descendant.pid`, "utf8").trim(),
        );
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
    expect(
      phaseValue(run.stderr, "status-integrity-refused", "malformed"),
    ).toBe("tested-and-untrusted");
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
      expect(`window=${window}\n${run.stderr}`).toContain(
        "lifecycle-interrupt-deferred",
      );
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
        expect(
          phaseValue(run.stderr, "lifecycle-critical-window", "provisional"),
        ).toBe("none");
        expect(run.stderr).not.toContain("cont-authorized");
        continue;
      }

      expect(run.stderr).toContain("cont-authorized");
      const checkpointPid = Number(
        phaseValue(run.stderr, "lifecycle-critical-window", "provisional"),
      );
      const adoptedPhase =
        owner === "client" ? "client-adopted" : "critical-server-adopted";
      const adoptedPid = Number(phaseValue(run.stderr, adoptedPhase, "pid"));
      const ownedPid = Number.isInteger(checkpointPid)
        ? checkpointPid
        : adoptedPid;
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

    const detail = (run: Run) =>
      `exit=${run.exitCode} port=${phaseValue(run.stderr, "port-allocated", "port")} ` +
      `code=${String(record(run).code)}`;
    expect(`first ${detail(first)} | second ${detail(second)}`).toContain(
      "exit=0 port=",
    );
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const firstPort = phaseValue(first.stderr, "port-allocated", "port");
    const secondPort = phaseValue(second.stderr, "port-allocated", "port");
    expect(firstPort).toBeDefined();
    expect(secondPort).not.toBe(firstPort);

    const firstDir = phaseValue(first.stderr, "state-retained", "dir");
    const secondDir = phaseValue(second.stderr, "state-retained", "dir");
    expect(secondDir).not.toBe(firstDir);
    // Retained, both of them: no cleanup-by-deletion on either path.
    expect(existsSync(firstDir as string)).toBe(true);
    expect(existsSync(secondDir as string)).toBe(true);
  }, 480_000);

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
        90_000,
      );
      expect(stderr).toContain("child-started");

      const wranglerPid = Number(phaseValue(stderr, "child-started", "pid"));
      const localPort = Number(phaseValue(stderr, "child-started", "port"));
      const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
      expect(Number.isInteger(wranglerPid)).toBe(true);
      expect(Number.isInteger(localPort)).toBe(true);
      expect(stateDir).toBeDefined();

      child.kill("SIGTERM");
      const exitCode = await waitForExitBefore(
        child.exited,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `TERM did not stop the local-D1 harness; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(
        reader,
        decoder,
        stderr,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
      assertCaptureComplete(harness.stderrCapture);

      // A signalled run is a failure with a typed code, not a silent zero.
      expect(exitCode).not.toBe(0);
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
        90_000,
      );
      const supervisor = Number(phaseValue(stderr, "child-started", "pid"));
      const localPort = Number(phaseValue(stderr, "child-started", "port"));
      expect(Number.isInteger(supervisor)).toBe(true);
      expect(Number.isInteger(localPort)).toBe(true);

      child.kill("SIGHUP");
      const exitCode = await waitForExitBefore(
        child.exited,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `HUP did not stop the local-D1 harness; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(
        reader,
        decoder,
        stderr,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
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
      let stderr = await waitForStderrMarker(
        child,
        reader,
        decoder,
        "client-started",
        30_000,
      );
      expect(stderr).toContain("client-started");
      const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
      const supervisor = Number(phaseValue(stderr, "client-started", "pid"));
      expect(await waitForFile(`${stateDir}/descendant.pid`)).toBe(true);
      const descendant = Number(
        readFileSync(`${stateDir}/descendant.pid`, "utf8").trim(),
      );

      child.kill("SIGTERM");
      const exitCode = await waitForExitBefore(
        child.exited,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `TERM did not stop the client-phase harness; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(
        reader,
        decoder,
        stderr,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
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
      let stderr = await waitForStderrMarker(
        child,
        reader,
        decoder,
        "client-started",
        30_000,
      );
      const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
      const supervisor = Number(phaseValue(stderr, "client-started", "pid"));
      expect(await waitForFile(`${stateDir}/descendant.pid`)).toBe(true);
      const descendant = Number(
        readFileSync(`${stateDir}/descendant.pid`, "utf8").trim(),
      );

      child.kill("SIGTERM");
      stderr = await waitForStderrMarker(
        child,
        reader,
        decoder,
        "cleanup-begin",
        10_000,
        stderr,
      );
      // The first handler has installed the INT/TERM/HUP mask before it emits
      // cleanup-begin, so this is genuinely a second signal during cleanup.
      child.kill("SIGHUP");
      const exitCode = await waitForExitBefore(
        child.exited,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
      if (exitCode === undefined) {
        const forcedExit = await terminateExactChild(child);
        throw new Error(
          `second signal bypassed cleanup; forced_exit=${String(forcedExit)}; stderr=${safeCaptureSummary(stderr)}`,
        );
      }
      stderr = await drainStderrBefore(
        reader,
        decoder,
        stderr,
        HARNESS_CLEANUP_TIMEOUT_MS,
      );
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
