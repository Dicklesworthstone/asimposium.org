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

async function runScript(args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
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

/** A real listener, so "busy" means busy rather than "we think it might be". */
function occupyPort(): { port: number; stop: () => void } {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
  const { port } = server;
  // `Server.port` is optional in Bun's types because a unix-socket server has
  // none. This one is TCP, and a test that pinned `undefined` as its port would
  // assert nothing at all, so the absence is an error rather than a fallback.
  if (typeof port !== "number") throw new Error("expected a TCP port for the squatter");
  return { port, stop: () => server.stop(true) };
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

/** Independent of the script's own assertions: is this pid really gone? */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processGone(pid)) return true;
    await Bun.sleep(50);
  }
  return processGone(pid);
}

describe("lifecycle: process-group cleanup reaches descendants, not just the leader", () => {
  test("PLANTED: a group whose leader exits and is reaped still loses its descendant", async () => {
    const run = await runScript(["--self-test-lifecycle"]);
    const emitted = record(run);
    expect(`${run.stderr}\n${JSON.stringify(emitted)}`).toContain("lifecycle-cleaned");
    expect(run.exitCode).toBe(0);
    expect(emitted.status).toBe("pass");
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");

    // The exercise really was the hard case: leader gone and reaped before
    // cleanup ran, with a descendant still alive at that moment.
    expect(phaseValue(run.stderr, "lifecycle-leader-exited", "reaped")).toBe("yes");
    const descendant = Number(phaseValue(run.stderr, "lifecycle-descendant", "pid"));
    const leader = Number(phaseValue(run.stderr, "lifecycle-leader-exited", "leader"));
    expect(Number.isInteger(descendant)).toBe(true);
    expect(phaseValue(run.stderr, "lifecycle-leader-exited", "survivors")).toBe(String(descendant));
    // Cleanup signalled the proven group, not the pid.
    expect(phaseValue(run.stderr, "lifecycle-terminated", "scope")).toBe("group");
    expect(phaseValue(run.stderr, "lifecycle-terminated", "pgid")).toBe(String(leader));

    // Verified here, not merely reported by the script under test.
    expect(await waitForExit(descendant)).toBe(true);

    const stateDir = phaseValue(run.stderr, "lifecycle-state-retained", "dir") as string;
    expect(existsSync(stateDir)).toBe(true);
    const phases = readFileSync(`${stateDir}/phases.log`, "utf8");
    expect(phases).toContain("lifecycle-leader-exited");
    expect(phases).toContain("lifecycle-cleaned");
    expect(phases).not.toContain("AAAAAAAA");
  }, 60_000);

  test("PLANTED: a descendant that ignores TERM is reported as a survivor and then killed", async () => {
    const run = await runScript(["--self-test-lifecycle-kill"]);
    const emitted = record(run);
    expect(`${run.stderr}\n${JSON.stringify(emitted)}`).toContain("lifecycle-cleaned");
    expect(run.exitCode).toBe(0);
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");

    const descendant = Number(phaseValue(run.stderr, "lifecycle-descendant", "pid"));
    // TERM delivered, ignored, reported, escalated — in that order, and the
    // survivor is named rather than silently absorbed by a "terminated" line.
    expect(phaseValue(run.stderr, "lifecycle-survivors", "pids")).toBe(String(descendant));
    expect(phaseValue(run.stderr, "lifecycle-survivors", "after_s")).toMatch(/^[0-9]+$/);
    expect(phaseValue(run.stderr, "lifecycle-killed", "signal")).toBe("KILL");
    expect(phaseValue(run.stderr, "lifecycle-killed", "scope")).toBe("group");
    expect(await waitForExit(descendant)).toBe(true);
  }, 60_000);

  test("PLANTED: an unowned child is cleaned as a pid tree, and the runner never signals its own group", async () => {
    const run = await runScript(["--self-test-lifecycle-unowned"]);
    const emitted = record(run);
    expect(`${run.stderr}\n${JSON.stringify(emitted)}`).toContain("lifecycle-cleaned");
    // Reaching its own final assertions is the proof that the runner did not
    // deliver a group signal to the group it shares with the child — a run that
    // signalled itself could not report anything.
    expect(run.exitCode).toBe(0);
    expect(emitted.code).toBe("LIFECYCLE_SELF_TEST_PASSED");
    expect(run.stderr).not.toContain("LIFECYCLE_SELF_SIGNALLED");
    expect(run.stderr).not.toContain("LIFECYCLE_CLEANUP_INCOMPLETE");
    // The child really did share this runner's group, so the fallback was the
    // branch under test rather than the group path taking a different name.
    expect(phaseValue(run.stderr, "lifecycle-unowned", "shared_pgid")).toMatch(/^[0-9]+$/);

    expect(phaseValue(run.stderr, "lifecycle-cleanup-scope", "scope")).toBe("pid-tree");
    expect(phaseValue(run.stderr, "lifecycle-terminated", "scope")).toBe("pid-tree");
    const targets = (phaseValue(run.stderr, "lifecycle-cleanup-scope", "targets") ?? "").split(",");
    const descendant = Number(phaseValue(run.stderr, "lifecycle-descendant", "pid"));
    const leader = Number(phaseValue(run.stderr, "lifecycle-descendant", "leader"));
    // The grandchild was in scope, which is the whole point of walking the tree.
    expect(targets).toContain(String(descendant));
    expect(targets.length).toBeGreaterThanOrEqual(2);

    expect(await waitForExit(descendant)).toBe(true);
    expect(await waitForExit(leader)).toBe(true);
  }, 60_000);
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
