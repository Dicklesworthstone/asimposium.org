/**
 * Planted negatives for the S-5 driver script (bead asimposiumorg-6jo).
 *
 * The handler tests cover the face; these cover the shell around it, where three defects
 * were proven by an adversarial pass:
 *
 *  1. `ASIMP_S5_SEED` was interpolated into a JSON template by `printf`, so a caller could
 *     forge record keys — including a second `status` — and land credential-shaped text in
 *     a build log.
 *  2. the server was spawned before its cleanup existed and with no trap, so a SIGTERM
 *     (a CI timeout's usual signal) left workerd listening.
 *  3. the port was fixed, so a leftover listener from an interrupted run could satisfy the
 *     next run's readiness probe and be compared against as if it were fresh.
 *
 * Each test below fails if the corresponding guard is removed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = "scripts/e2e-s5-diptych.sh";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runScript(env: Record<string, string>, timeoutMs = 30_000): Promise<Run> {
  const child = Bun.spawn({
    cmd: ["bash", SCRIPT],
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

const listeners: Server[] = [];
afterAll(() => {
  for (const server of listeners) server.close();
});

/**
 * Ports are allocated by the kernel, never hard-coded: a fixed port makes the test itself
 * fail when another run — or anything else on the host — already holds it, which is the very
 * defect these tests exist to catch.
 */
function occupyFreePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    listeners.push(server);
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) done(address.port);
      else fail(new Error("no port assigned"));
    });
  });
}

/** A port the kernel just handed out and we immediately released. */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? done(port) : fail(new Error("no port assigned"))));
    });
  });
}

describe("a hostile seed cannot forge a diagnostic record", () => {
  const hostile: [string, string][] = [
    ["quote", 'x","status":"pass'],
    ["key injection", 'x","status":"pass","injected":"1'],
    ["newline", "line1\nline2"],
    ["credential shaped", "asimp_ag_01JQZXSEEDCANARY0123"],
    ["fragment shaped", "#v1.SEEDFRAGMENTsecret01"],
    ["overlong", "a".repeat(200)],
    ["path", "../../etc/passwd"],
    ["command substitution", "$(id)"],
  ];

  for (const [name, seed] of hostile) {
    test(`refuses a ${name} seed without echoing it`, async () => {
      const run = await runScript({ ASIMP_S5_SEED: seed });

      expect(run.exitCode).toBe(64);

      // Exactly one record, and it parses: a forged newline or quote would break both.
      const lines = run.stdout.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(record.assertion).toBe("seed_accepted");
      expect(record.status).toBe("fail");
      expect(record.seed).toBe("<rejected>");

      // The rejected value never reaches any stream: reporting a secret in the diagnostic
      // that refused it is the same leak with extra steps.
      const streams = `${run.stdout}${run.stderr}`;
      const distinctive = seed.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
      if (distinctive.length >= 6) expect(streams).not.toContain(distinctive);
      expect(streams).not.toContain("asimp_ag_01JQZX");
      expect(streams).not.toContain("SEEDFRAGMENT");
    });
  }

  test("a well-formed seed is accepted, so the guard is not simply refusing everything", async () => {
    // Reaches phase 1 and beyond; we only assert it was not rejected at the door.
    const run = await runScript({ ASIMP_S5_SEED: "s5-fixed-seed-v1" }, 180_000);
    expect(run.exitCode).not.toBe(64);
    expect(run.stdout).not.toContain('"seed":"<rejected>"');
    expect(run.stdout).toContain('"seed":"s5-fixed-seed-v1"');
  }, 200_000);
});

describe("a run never tests against a server it did not start", () => {
  test("a pinned port that is already occupied is refused, not reused", async () => {
    // We hold this listener for the duration: the script must refuse rather than test
    // against a server it does not own.
    const port = await occupyFreePort();
    const run = await runScript({ S5_PORT: String(port) }, 180_000);

    expect(run.exitCode).toBe(1);
    const records = run.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const refusal = records.find((record) => record.assertion === "phase2_worker_served");
    expect(refusal?.status).toBe("fail");
    expect(String(refusal?.detail)).toContain("already in use");
    // And it never claimed the spike passed against the stranger's listener.
    expect(
      records.some((record) => record.assertion === "spike_summary" && record.status === "pass"),
    ).toBe(false);
  }, 200_000);
});

describe("two full runs can share a machine", () => {
  test("two concurrent scripts both pass, with no port collision on either side", async () => {
    // The defect this covers: picking a free *main* port was not enough. Wrangler also binds
    // a devtools inspector whose default (9231) is fixed, so two runs collided there — one
    // died with "Address already in use 127.0.0.1:9231" and the other passed, which is the
    // worst possible shape: the survivor reports green and the suite looks healthy.
    const [first, second] = await Promise.all([runScript({}, 300_000), runScript({}, 300_000)]);

    for (const [label, run] of [
      ["first", first],
      ["second", second],
    ] as const) {
      expect(`${label} exit ${run.exitCode}`).toBe(`${label} exit 0`);
      expect(run.stderr).not.toContain("Address already in use");
      expect(run.stdout).not.toContain("Address already in use");

      const records = run.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // Green must mean the served phase actually ran, not that it was skipped.
      expect(records.filter((record) => record.phase === "worker-served").length).toBeGreaterThan(
        0,
      );
      const summary = records.find((record) => record.assertion === "spike_summary");
      expect(summary?.status).toBe("pass");
    }
  }, 320_000);
});

describe("an interrupted run leaves nothing listening", () => {
  async function answering(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__s5/face?format=md`);
      await response.text();
      return response.ok;
    } catch {
      return false;
    }
  }

  test("SIGTERM to the script takes the workerd it started down with it", async () => {
    const port = await freePort();
    // Ownership: nothing may be listening before the script starts, or a survivor from
    // elsewhere would make the post-kill assertion meaningless.
    expect(await answering(port)).toBe(false);
    const child = Bun.spawn({
      cmd: ["bash", SCRIPT],
      cwd: ROOT,
      env: { ...process.env, S5_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });

    let up = false;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (await answering(port)) {
        up = true;
        break;
      }
      if (child.exitCode !== null) break;
      await Bun.sleep(250);
    }
    // If the server never came up there is nothing to prove; fail loudly rather than pass
    // vacuously on a machine where wrangler could not start.
    expect(up).toBe(true);

    child.kill("SIGTERM");
    await child.exited;
    // Give the trap its escalation window (TERM, then KILL after ~2s).
    await Bun.sleep(3_000);

    expect(await answering(port)).toBe(false);
  }, 200_000);
});
