import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

async function runScript(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Run> {
  const child = Bun.spawn({
    cmd: ["bash", SCRIPT, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** The runner's own NDJSON record, which is the last JSON line it prints. */
function record(run: Run): Record<string, unknown> {
  const line = run.stdout
    .trim()
    .split("\n")
    .filter((entry) => entry.startsWith("{"))
    .at(-1);
  expect(line).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

function phaseValue(stderr: string, phase: string, key: string): string | undefined {
  const line = stderr.split("\n").find((entry) => entry.includes(` ${phase} `));
  return line?.match(new RegExp(`${key}=([^\\s]+)`))?.[1];
}

const listenerPorts: number[] = [];

/** A real listener, so "busy" means busy rather than "we think it might be". */
function occupyPort(): { port: number; stop: () => void } {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
  listenerPorts.push(server.port);
  return { port: server.port, stop: () => server.stop(true) };
}

describe("the self-test and the blocked external proof", () => {
  test("--self-test passes and leaks no fragment secret", async () => {
    const run = await runScript(["--self-test"]);
    expect(run.exitCode).toBe(0);
    expect(record(run).code).toBe("SELF_TEST_PASSED");
    expect(run.stdout).not.toContain("v1.");
    expect(run.stdout).not.toContain("AAAAAAAA");
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
  for (const pinned of ["0", "80", "1023", "65536", "70000", "not-a-port", "-1", "8080 8080"]) {
    test(`PLANTED: S1_LOCAL_PORT=${JSON.stringify(pinned)} is refused as invalid`, async () => {
      const run = await runScript(["--local-d1"], { S1_LOCAL_PORT: pinned });
      expect(run.exitCode).toBe(78);
      expect(record(run).code).toBe("PINNED_PORT_INVALID");
      // Refused before any child, so no state directory and no wrangler start.
      expect(run.stderr).not.toContain("child-started");
    });
  }

  test("PLANTED: a pinned port that is already listening is refused, not served by the squatter", async () => {
    const listener = occupyPort();
    try {
      const run = await runScript(["--local-d1"], { S1_LOCAL_PORT: String(listener.port) });
      expect(run.exitCode).toBe(78);
      expect(record(run).code).toBe("PINNED_PORT_BUSY");
      expect(run.stderr).not.toContain("child-started");
      // The squatter is untouched: the harness refuses rather than killing a
      // process it does not own.
      const probe = await fetch(`http://127.0.0.1:${listener.port}/`);
      expect(await probe.text()).toBe("busy");
    } finally {
      listener.stop();
    }
  });

  test("an unpinned run allocates its own port and says which one", async () => {
    if (!existsSync(WRANGLER)) {
      const run = await runScript(["--local-d1"]);
      expect(run.exitCode).toBe(78);
      expect(record(run).code).toBe("WRANGLER_REQUIRED");
      return;
    }
    const run = await runScript(["--local-d1"]);
    expect(run.exitCode).toBe(0);
    const port = Number(phaseValue(run.stderr, "port-allocated", "port"));
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(phaseValue(run.stderr, "port-allocated", "pinned")).toBe("no");
    // Readiness is tied to this run's own D1 state, not merely to "something answered".
    expect(run.stderr).toContain("port-ownership-proven");
    expect(record(run).code).toBe("LOCAL_D1_ENROLLMENT_PASSED");
  }, 120_000);
});

describe("lifecycle: parallel runs and signal handling", () => {
  test("PLANTED: two runs in parallel both pass, on distinct ports and state directories", async () => {
    if (!existsSync(WRANGLER)) return;
    const [first, second] = await Promise.all([
      runScript(["--local-d1"]),
      runScript(["--local-d1"]),
    ]);

    const detail = (run: Run) =>
      `exit=${run.exitCode} port=${phaseValue(run.stderr, "port-allocated", "port")} ` +
      `code=${String(record(run).code)}`;
    expect(`first ${detail(first)} | second ${detail(second)}`).toContain("exit=0 port=");
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
  }, 180_000);

  test("PLANTED: TERM terminates the whole child group and retains the state directory", async () => {
    if (!existsSync(WRANGLER)) return;
    const child = Bun.spawn({
      cmd: ["bash", SCRIPT, "--local-d1"],
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stderr incrementally so the TERM lands while the child is really up.
    const decoder = new TextDecoder();
    let stderr = "";
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !stderr.includes("child-started")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stderr += decoder.decode(chunk.value, { stream: true });
    }
    expect(stderr).toContain("child-started");

    const wranglerPid = Number(phaseValue(stderr, "child-started", "pid"));
    const stateDir = phaseValue(stderr, "state-retained", "dir") as string;
    expect(Number.isInteger(wranglerPid)).toBe(true);
    expect(stateDir).toBeDefined();

    child.kill("SIGTERM");
    const exitCode = await child.exited;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stderr += decoder.decode(chunk.value, { stream: true });
    }

    // A signalled run is a failure with a typed code, not a silent zero.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("INTERRUPTED");
    expect(stderr).toContain("state_retained=");

    // The whole group is gone: neither the wrangler shell nor its workerd
    // children survive. `kill(pid, 0)` throws once the process is reaped.
    let groupAlive = true;
    for (let attempt = 0; attempt < 100 && groupAlive; attempt += 1) {
      try {
        process.kill(-wranglerPid, 0);
        await Bun.sleep(100);
      } catch {
        groupAlive = false;
      }
    }
    expect(groupAlive).toBe(false);

    // State is retained, including the phase log, which is the whole point of
    // keeping it: an interrupted run is the one whose logs someone wants.
    expect(existsSync(stateDir)).toBe(true);
    const phases = readFileSync(`${stateDir}/phases.log`, "utf8");
    expect(phases).toContain("child-started");
    expect(phases).toContain("interrupted");
    // Logs carry lifecycle facts only, never the local replay key.
    expect(phases).not.toContain("AAAAAAAA");
  }, 180_000);
});
