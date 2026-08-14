/**
 * Planted negatives for the S-5 driver script (bead asimposiumorg-6jo).
 *
 * The handler tests cover the face; these cover the shell around it, where four defects were
 * proven by adversarial passes:
 *
 *  1. `ASIMP_S5_SEED` was interpolated into a JSON template by `printf`, so a caller could
 *     forge record keys — including a second `status` — and land credential-shaped text in
 *     a build log.
 *  2. the server was spawned before its cleanup existed and with no trap, so a SIGTERM
 *     (a CI timeout's usual signal) left workerd listening.
 *  3. the main port was fixed, so a leftover listener from an interrupted run could satisfy
 *     the next run's readiness probe and be compared against as if it were fresh.
 *  4. even with distinct main ports, both runs bound wrangler's default devtools inspector
 *     (9231), so one of two concurrent runs died on "Address already in use" while the other
 *     reported green — a flake whose survivor looks healthy.
 *
 * Each test below fails if the corresponding guard is removed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provenance } from "../../../../packages/render/scripts/provenance.ts";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = "scripts/e2e-s5-diptych.sh";
const DRIFT_AUTHORITY = "s5-private-provenance-authority-v1";
const DRIFT_CAPABILITY = "s5-private-provenance-capability-v1";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function startScript(env: Record<string, string>) {
  return Bun.spawn({
    cmd: ["bash", SCRIPT],
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collectScript(
  child: ReturnType<typeof startScript>,
  timeoutMs = 30_000,
): Promise<Run> {
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

async function runScript(env: Record<string, string>, timeoutMs = 30_000): Promise<Run> {
  return collectScript(startScript(env), timeoutMs);
}

async function runChecker(
  origin: string,
  timeoutMs = 30_000,
  overrides: Record<string, string> = {},
): Promise<Run> {
  const run = await provenance();
  const child = Bun.spawn({
    cmd: ["bun", "apps/wire/src/render-face/check.ts"],
    cwd: ROOT,
    env: {
      ...process.env,
      S5_ORIGIN: origin,
      S5_SEED: "s5-checker-adversarial-v1",
      S5_RUN_ID: "s5-checker-adversarial-run",
      S5_EXPECTED_SOURCE_DIGEST: run.source_digest,
      S5_EXPECTED_SOURCE_FILES: String(run.source_files),
      S5_EXPECTED_BUN_VERSION: run.bun_version,
      S5_EXPECTED_WRANGLER_VERSION: run.wrangler_version,
      ...overrides,
    },
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

async function runCheckerWithoutContract(origin: string): Promise<Run> {
  const env = { ...process.env };
  delete env.S5_EXPECTED_SOURCE_DIGEST;
  delete env.S5_EXPECTED_SOURCE_FILES;
  delete env.S5_EXPECTED_BUN_VERSION;
  delete env.S5_EXPECTED_WRANGLER_VERSION;
  const child = Bun.spawn({
    cmd: ["bun", "apps/wire/src/render-face/check.ts"],
    cwd: ROOT,
    env: {
      ...env,
      S5_ORIGIN: origin,
      S5_SEED: "s5-checker-adversarial-v1",
      S5_RUN_ID: "s5-checker-adversarial-run",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

const listeners: Server[] = [];
const httpListeners: HttpServer[] = [];
afterAll(() => {
  for (const server of listeners) server.close();
  for (const server of httpListeners) server.close();
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

interface PsFaultShim {
  readonly directory: string;
  readonly activate: () => void;
}

/**
 * A deterministic `ps` fault is injected only into the child shell's PATH. The test process
 * keeps the real process table, so its postcondition is independent of the broken observer.
 * All generated helper/state files inherit the caller's TMPDIR (USB-backed in this swarm).
 */
function psFaultShim(mode: "transient" | "permanent"): PsFaultShim {
  const directory = mkdtempSync(join(tmpdir(), "asimposium-s5-ps-fault-"));
  const activateFile = join(directory, "activate");
  const stateFile = join(directory, "state");
  const shim = join(directory, "ps");
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
if [[ -f ${JSON.stringify(activateFile)} ]]; then
  if [[ ${JSON.stringify(mode)} == transient && ! -f ${JSON.stringify(stateFile)} ]]; then
    : > ${JSON.stringify(stateFile)}
    exit 1
  fi
  if [[ ${JSON.stringify(mode)} == permanent ]]; then
    exit 1
  fi
fi
exec /bin/ps "$@"
`,
  );
  chmodSync(shim, 0o700);
  return { directory, activate: () => writeFileSync(activateFile, "active\n") };
}

async function answering(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__s5/face?format=md`, {
      signal: AbortSignal.timeout(2_000),
    });
    await response.text();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForAnswer(
  port: number,
  child?: ReturnType<typeof startScript>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await answering(port)) return true;
    if (child?.exitCode !== null) return false;
    await Bun.sleep(25);
  }
  return false;
}

interface ProcessEntry {
  pid: number;
  pgid: number;
  command: string;
}

function processTable(): readonly ProcessEntry[] {
  const result = Bun.spawnSync({
    cmd: ["ps", "-axo", "pid=,pgid=,command="],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("could not inspect local process ownership");
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] ?? "" }];
    });
}

function ownedMarkerMatches(marker: string): readonly ProcessEntry[] {
  return processTable().filter((entry) => entry.command.includes(`--s5-owned-marker=${marker}`));
}

async function waitForOwnedMarker(
  marker: string,
  child?: ReturnType<typeof startScript>,
): Promise<ProcessEntry | undefined> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const matches = ownedMarkerMatches(marker);
    if (matches.length === 1) return matches[0];
    if (child?.exitCode !== null) return undefined;
    await Bun.sleep(25);
  }
  return undefined;
}

async function waitForProcessGroupAbsence(pgid: number): Promise<readonly ProcessEntry[]> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const survivors = processTable().filter((entry) => entry.pgid === pgid);
    if (survivors.length === 0) return survivors;
    await Bun.sleep(25);
  }
  return processTable().filter((entry) => entry.pgid === pgid);
}

function reapExactOwnedGroupForTest(marker: string, pgid: number): void {
  // Test cleanup is itself ownership-gated: a failed regression must never leave an old-style
  // orphan behind, and it must never signal a numeric PGID that has been reused by another run.
  const matches = ownedMarkerMatches(marker).filter((entry) => entry.pgid === pgid);
  if (matches.length === 1) process.kill(-pgid, "SIGKILL");
}

async function runScriptCapturingOwnedGroup(
  env: Record<string, string>,
  seed: string,
  timeoutMs = 30_000,
): Promise<{ run: Run; ownedGroup: number | undefined }> {
  const child = startScript(env);
  const marker = `s5-diptych-owner-s5-${seed}-${child.pid}`;
  const markerProcess = await waitForOwnedMarker(marker, child);
  const run = await collectScript(child, timeoutMs);
  return { run, ownedGroup: markerProcess?.pgid };
}

function driftEnv(checkpoint: string): Record<string, string> {
  return {
    ASIMP_S5_TEST_PROVENANCE_AUTHORITY: DRIFT_AUTHORITY,
    ASIMP_S5_TEST_PROVENANCE_CAPABILITY: DRIFT_CAPABILITY,
    ASIMP_S5_TEST_PROVENANCE_DRIFT_AT: checkpoint,
  };
}

async function credentialEtagServer(
  credentialEtag: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((done, fail) => {
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const isTeachingRefusal =
        url.pathname !== "/__s5/face" ||
        request.method === "POST" ||
        url.searchParams.get("format") === "toon" ||
        url.searchParams.get("variant") === "everything";
      response.writeHead(isTeachingRefusal ? 400 : 200, {
        "content-type": isTeachingRefusal
          ? "application/problem+json; charset=utf-8"
          : "text/markdown; charset=utf-8",
        etag: credentialEtag,
        "x-content-type-options": "nosniff",
      });
      response.end(
        isTeachingRefusal
          ? JSON.stringify({
              code: "UNKNOWN_FORMAT",
              allowed: ["md", "json", "html-fragment"],
              fix_hint: "safe",
            })
          : "safe controlled response\n",
      );
    });
    httpListeners.push(server);
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        fail(new Error("no port assigned"));
        return;
      }
      done({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

async function malformedTeachingResponseServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((done, fail) => {
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const teaching = url.searchParams.get("format") === "toon";
      response.writeHead(teaching ? 400 : 200, {
        "content-type": teaching
          ? "application/problem+json; charset=utf-8"
          : "text/markdown; charset=utf-8",
        etag: '"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
        "x-content-type-options": "nosniff",
      });
      response.end(teaching ? "not-json" : "safe controlled response\n");
    });
    httpListeners.push(server);
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        fail(new Error("no port assigned"));
        return;
      }
      done({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

describe("phase-2 diagnostics are secret-safe", () => {
  test("a direct checker without the launch contract emits one fixed boundary refusal", async () => {
    const run = await runCheckerWithoutContract("http://127.0.0.1:1");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(run.stdout) as Record<string, unknown>).toMatchObject({
      assertion: "checker_boundary_refused",
      code: "CHECKER_BOUNDARY_REFUSED",
      bun_version: "unavailable",
      wrangler_version: "unavailable",
    });
  });

  test("an unexpected malformed Worker response emits a fixed main-boundary refusal", async () => {
    const server = await malformedTeachingResponseServer();
    let run: Run;
    try {
      run = await runChecker(server.origin);
    } finally {
      await server.close();
    }

    if (run === undefined) throw new Error("checker did not return a result");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toBe("");
    const records = run.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({
      assertion: "checker_runtime_refused",
      code: "CHECKER_RUNTIME_REFUSED",
      detail: "phase-2 checker stopped after an unexpected local Worker result",
      status: "fail",
    });
    expect(`${run.stdout}${run.stderr}`).not.toContain("SyntaxError");
    expect(`${run.stdout}${run.stderr}`).not.toContain(" at ");
  });

  test("a credential-shaped response ETag produces only a fixed parseable refusal", async () => {
    const credentialEtag = '"asimp_ag_responsecontrolledetag01"';
    const server = await credentialEtagServer(credentialEtag);
    let run: Run;
    try {
      run = await runChecker(server.origin);
    } finally {
      await server.close();
    }

    if (run === undefined) throw new Error("checker did not return a result");
    expect(run.exitCode).not.toBe(0);
    const records = run.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const refusals = records.filter((record) => record.assertion === "diagnostic_safety_refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      phase: "worker-served",
      status: "fail",
      code: "DIAGNOSTIC_SAFETY_REFUSED",
      detail: "a phase-2 diagnostic was refused by the secret-safety policy",
      run_id: "s5-checker-adversarial-run",
      seed: "s5-checker-adversarial-v1",
    });
    for (const record of records) {
      expect(record.seed).toBe("s5-checker-adversarial-v1");
      expect(record.source_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(record.source_files).toEqual(expect.any(Number));
    }

    const streams = `${run.stdout}${run.stderr}`;
    expect(streams).not.toContain(credentialEtag);
    expect(streams).not.toContain("asimp_ag_responsecontrolledetag01");
    expect(streams).not.toContain("DiagnosticSafetyError");
  });

  test("a raw long-hex response ETag produces the same fixed refusal without echo", async () => {
    const rawPrivateKeyCanary = "d".repeat(64);
    const server = await credentialEtagServer(`"${rawPrivateKeyCanary}"`);
    let run: Run;
    try {
      run = await runChecker(server.origin);
    } finally {
      await server.close();
    }

    if (run === undefined) throw new Error("checker did not return a result");
    expect(run.exitCode).not.toBe(0);
    const records = run.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const refusals = records.filter((record) => record.assertion === "diagnostic_safety_refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      assertion: "diagnostic_safety_refused",
      code: "DIAGNOSTIC_SAFETY_REFUSED",
      detail: "a phase-2 diagnostic was refused by the secret-safety policy",
      status: "fail",
    });
    const streams = `${run.stdout}${run.stderr}`;
    expect(streams).not.toContain(rawPrivateKeyCanary);
    expect(streams).not.toContain(rawPrivateKeyCanary.slice(0, 32));
    expect(streams).not.toContain("DiagnosticSafetyError");
  });

  const hostileIdentifiers = [
    ["raw 64-hex private-key canary", "d".repeat(64)],
    ["37-character lowercase-hex key", "0123456789abcdef0123456789abcdef01234"],
    ["digitless mixed-case separator secret", "AbCdEfGhIjKlMnOpQrStUvWxYz-_AbCdEfGh"],
    ["known live credential prefix", "sk_live_Aa1_Bb2-Cc3D"],
    ["absolute path", "/Users/rejected/checker-run-id"],
    ["quote", 'x","status":"pass'],
    ["newline", "line1\nline2"],
    ["overlong ordinary text", "a".repeat(65)],
  ] as const;

  for (const variable of ["S5_SEED", "S5_RUN_ID"] as const) {
    for (const [name, rejectedValue] of hostileIdentifiers) {
      test(`a hostile direct ${variable} ${name} becomes one fixed startup refusal without a stack`, async () => {
        const run = await runChecker("http://127.0.0.1:1", 30_000, { [variable]: rejectedValue });

        expect(run.exitCode).not.toBe(0);
        const records = run.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          assertion: "checker_boundary_refused",
          code: "CHECKER_BOUNDARY_REFUSED",
          detail: "phase-2 checker startup was refused by the safety boundary",
          phase: "worker-served",
          status: "fail",
          run_id: "s5-checker-refusal-v1",
          seed: "<refused>",
          revision: "unknown",
          revision_state: "unknown",
          source_digest: "unavailable",
          source_files: 0,
        });
        const streams = `${run.stdout}${run.stderr}`;
        expect(streams).not.toContain(rejectedValue);
        expect(streams).not.toContain(rejectedValue.slice(0, 16));
        expect(streams).not.toContain("/Users/");
        expect(streams).not.toContain("DiagnosticSafetyError");
        expect(streams).not.toContain(" at ");
      });
    }
  }

  const hostileOrigins = [
    ["HTTPS", "https://127.0.0.1:8787"],
    ["non-loopback host", "http://localhost:8787"],
    ["missing port", "http://127.0.0.1"],
    ["zero port", "http://127.0.0.1:0"],
    ["non-numeric port", "http://127.0.0.1:abc"],
    ["credentials", "http://user:pass@127.0.0.1:8787"],
    ["path", "http://127.0.0.1:8787/not-a-face"],
    ["query", "http://127.0.0.1:8787?next=elsewhere"],
    ["fragment", "http://127.0.0.1:8787#fragment"],
  ] as const;

  for (const [name, rejectedOrigin] of hostileOrigins) {
    test(`a direct ${name} S5_ORIGIN is a one-line no-SSRF refusal`, async () => {
      const run = await runChecker("http://127.0.0.1:1", 30_000, { S5_ORIGIN: rejectedOrigin });

      expect(run.exitCode).not.toBe(0);
      const records = run.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        assertion: "checker_boundary_refused",
        code: "CHECKER_BOUNDARY_REFUSED",
        detail: "phase-2 checker startup was refused by the safety boundary",
        status: "fail",
      });
      const streams = `${run.stdout}${run.stderr}`;
      expect(streams).not.toContain(rejectedOrigin);
      expect(streams).not.toContain("DiagnosticSafetyError");
      expect(streams).not.toContain(" at ");
    });
  }
});

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

  test("a non-default seed reaches every full S-5 phase coherently", async () => {
    const seed = "s5-long-legitimate-seed-0123456789abcdefghijkl";
    const run = await runScript({ ASIMP_S5_SEED: seed }, 180_000);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain('"seed":"<rejected>"');
    expect(run.stdout).toContain(`"seed":"${seed}"`);
    const records = run.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect([...new Set(records.map((record) => record.run_id))]).toHaveLength(1);
    expect([...new Set(records.map((record) => record.source_digest))]).toHaveLength(1);
    expect([...new Set(records.map((record) => record.source_files))]).toHaveLength(1);
    for (const record of records) {
      expect(record.seed).toBe(seed);
      expect(record.revision).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
      expect(["clean", "dirty", "unknown"]).toContain(String(record.revision_state));
      expect(record.source_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(record.source_files).toEqual(expect.any(Number));
    }
  }, 200_000);
});

describe("provenance drift is fail-closed at every checkpoint", () => {
  const checkpoints = [
    "before_worker_launch",
    "after_worker_ready_before_checker",
    "after_checker",
  ] as const;

  for (const checkpoint of checkpoints) {
    test(`a planted ${checkpoint} drift emits a fixed refusal, leaves no owned process, and never greens`, async () => {
      const port = await freePort();
      expect(await answering(port)).toBe(false);
      const { run, ownedGroup } = await runScriptCapturingOwnedGroup(
        { ...driftEnv(checkpoint), S5_PORT: String(port) },
        "s5-fixed-seed-v1",
        180_000,
      );
      expect(run.exitCode).toBe(1);
      const records = run.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const drifts = records.filter((record) => record.assertion === "provenance_drift");
      expect(drifts).toHaveLength(1);
      expect(drifts[0]).toMatchObject({
        status: "fail",
        seed: "s5-fixed-seed-v1",
        detail: `source digest or input count changed at ${checkpoint}; refusing mixed evidence`,
      });
      expect(
        records.some((record) => record.assertion === "spike_summary" && record.status === "pass"),
      ).toBe(false);
      expect(records.find((record) => record.assertion === "spike_summary")?.status).toBe("fail");
      expect(`${run.stdout}${run.stderr}`).not.toContain(DRIFT_AUTHORITY);
      expect(`${run.stdout}${run.stderr}`).not.toContain(DRIFT_CAPABILITY);
      if (checkpoint === "before_worker_launch") {
        // This checkpoint must refuse before a local process group is ever created.
        expect(ownedGroup).toBeUndefined();
      } else {
        // The group was captured from the exact per-run marker while it was alive. An empty
        // post-run PGID is stronger than a closed HTTP port: it catches leaderless workerd
        // children that no longer answer this particular probe.
        expect(ownedGroup).toEqual(expect.any(Number));
        expect(await waitForProcessGroupAbsence(ownedGroup as number)).toEqual([]);
      }
      expect(await answering(port)).toBe(false);
    }, 200_000);
  }
});

describe("the private provenance-drift seam is all-or-none and fail-closed", () => {
  const invalidConfigurations: readonly [string, Record<string, string>, string[]][] = [
    [
      "partial",
      { ASIMP_S5_TEST_PROVENANCE_DRIFT_AT: "before_worker_launch" },
      ["before_worker_launch"],
    ],
    [
      "wrong authority",
      {
        ...driftEnv("before_worker_launch"),
        ASIMP_S5_TEST_PROVENANCE_AUTHORITY: "wrong-authority",
      },
      ["wrong-authority"],
    ],
    [
      "wrong capability",
      {
        ...driftEnv("before_worker_launch"),
        ASIMP_S5_TEST_PROVENANCE_CAPABILITY: "wrong-capability",
      },
      ["wrong-capability"],
    ],
    ["unknown checkpoint", driftEnv("not-a-checkpoint"), ["not-a-checkpoint"]],
  ];

  for (const [name, env, rejectedValues] of invalidConfigurations) {
    test(`refuses ${name} configuration without a green summary or echo`, async () => {
      const run = await runScript(env, 180_000);
      expect(run.exitCode).toBe(64);
      const records = run.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        assertion: "provenance_test_seam_configuration",
        status: "fail",
        detail: "provenance test seam configuration was refused",
        seed: "s5-fixed-seed-v1",
      });
      expect(records[1]).toMatchObject({ assertion: "spike_summary", status: "fail" });
      expect(records.some((record) => record.status === "pass")).toBe(false);
      const streams = `${run.stdout}${run.stderr}`;
      for (const value of rejectedValues) expect(streams).not.toContain(value);
      expect(streams).not.toContain(DRIFT_AUTHORITY);
      expect(streams).not.toContain(DRIFT_CAPABILITY);
    }, 200_000);
  }
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

    const served: number[] = [];
    for (const [label, run] of [
      ["first", first],
      ["second", second],
    ] as const) {
      expect(`${label} exit ${run.exitCode}`).toBe(`${label} exit 0`);
      const streams = `${run.stdout}${run.stderr}`;
      expect(streams).not.toContain("Address already in use");
      // The inspector default is the specific address the collision happened on; naming it
      // keeps this test honest if wrangler ever changes how it reports a bind failure.
      expect(streams).not.toContain("9231");

      const records = run.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // Green must mean the served phase actually ran, not that it was skipped.
      const workerServed = records.filter((record) => record.phase === "worker-served").length;
      expect(workerServed).toBeGreaterThan(0);
      served.push(workerServed);
      const summary = records.find((record) => record.assertion === "spike_summary");
      expect(summary?.status).toBe("pass");
    }
    // Symmetry: a run that quietly degraded would serve fewer assertions than its twin.
    expect(served[0]).toBe(served[1] as number);
  }, 320_000);
});

describe("an interrupted run leaves nothing listening", () => {
  test("a transient process-table failure is retried and never treated as an empty owned group", async () => {
    const port = await freePort();
    const fault = psFaultShim("transient");
    const child = startScript({ S5_PORT: String(port), PATH: `${fault.directory}:${process.env.PATH}` });
    const completion = collectScript(child, 30_000);
    const marker = `s5-diptych-owner-s5-s5-fixed-seed-v1-${child.pid}`;
    let ownedGroup: number | undefined;

    try {
      const markerProcess = await waitForOwnedMarker(marker, child);
      expect(markerProcess).toBeDefined();
      ownedGroup = markerProcess?.pgid;
      expect(await waitForAnswer(port, child)).toBe(true);

      fault.activate();
      child.kill("SIGTERM");
      const run = await completion;
      expect(run.exitCode).not.toBe(0);
      expect(await waitForProcessGroupAbsence(ownedGroup as number)).toEqual([]);
      expect(await answering(port)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      if (ownedGroup !== undefined) reapExactOwnedGroupForTest(marker, ownedGroup);
    }
  }, 200_000);

  test("permanent process-table uncertainty self-expires only the marked group", async () => {
    const port = await freePort();
    const fault = psFaultShim("permanent");
    const child = startScript({ S5_PORT: String(port), PATH: `${fault.directory}:${process.env.PATH}` });
    const completion = collectScript(child, 30_000);
    const marker = `s5-diptych-owner-s5-s5-fixed-seed-v1-${child.pid}`;
    let ownedGroup: number | undefined;

    try {
      const markerProcess = await waitForOwnedMarker(marker, child);
      expect(markerProcess).toBeDefined();
      ownedGroup = markerProcess?.pgid;
      expect(await waitForAnswer(port, child)).toBe(true);

      fault.activate();
      const run = await completion;
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout).not.toContain('"assertion":"spike_summary"');
      expect(await waitForProcessGroupAbsence(ownedGroup as number)).toEqual([]);
      expect(ownedMarkerMatches(marker)).toEqual([]);
      expect(await answering(port)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      if (ownedGroup !== undefined) reapExactOwnedGroupForTest(marker, ownedGroup);
    }
  }, 200_000);

  test("a decoy marker in another process group survives exact owned-group cleanup", async () => {
    const port = await freePort();
    const child = startScript({ S5_PORT: String(port) });
    const completion = collectScript(child, 30_000);
    const marker = `s5-diptych-owner-s5-s5-fixed-seed-v1-${child.pid}`;
    let ownedGroup: number | undefined;
    let decoy: ReturnType<typeof Bun.spawn> | undefined;

    try {
      const markerProcess = await waitForOwnedMarker(marker, child);
      expect(markerProcess).toBeDefined();
      ownedGroup = markerProcess?.pgid;
      expect(await waitForAnswer(port, child)).toBe(true);

      decoy = Bun.spawn({
        cmd: ["bash", "-c", "while :; do sleep 1; done", `--s5-owned-marker=${marker}`],
        cwd: ROOT,
        stdout: "ignore",
        stderr: "ignore",
      });
      await Bun.sleep(50);
      expect(processTable().some((entry) => entry.pid === decoy?.pid)).toBe(true);

      child.kill("SIGTERM");
      await completion;
      expect(await waitForProcessGroupAbsence(ownedGroup as number)).toEqual([]);
      expect(processTable().some((entry) => entry.pid === decoy?.pid)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      if (decoy !== undefined && decoy.exitCode === null) decoy.kill("SIGKILL");
      if (decoy !== undefined) await decoy.exited;
      if (ownedGroup !== undefined) reapExactOwnedGroupForTest(marker, ownedGroup);
    }
  }, 200_000);

  test("SIGTERM to the script takes its exact owned process group down with it", async () => {
    const port = await freePort();
    // Ownership: nothing may be listening before the script starts, or a survivor from
    // elsewhere would make the post-kill assertion meaningless.
    expect(await answering(port)).toBe(false);
    const child = startScript({ S5_PORT: String(port) });
    const completion = collectScript(child, 30_000);
    const marker = `s5-diptych-owner-s5-s5-fixed-seed-v1-${child.pid}`;

    try {
      const markerProcess = await waitForOwnedMarker(marker, child);
      expect(markerProcess).toBeDefined();
      const ownedGroup = markerProcess?.pgid as number;
      expect(await waitForAnswer(port, child)).toBe(true);

      child.kill("SIGTERM");
      await completion;
      expect(await waitForProcessGroupAbsence(ownedGroup)).toEqual([]);
      expect(await answering(port)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  }, 200_000);

  test("post-readiness Worker-leader death fails closed and reaps the exact marked group", async () => {
    const port = await freePort();
    const seed = "s5-owner-loss-XyZ-3927";
    const child = startScript({ ASIMP_S5_SEED: seed, S5_PORT: String(port) });
    const completion = collectScript(child, 30_000);
    const marker = `s5-diptych-owner-s5-${seed}-${child.pid}`;

    try {
      const markerProcess = await waitForOwnedMarker(marker, child);
      expect(markerProcess).toBeDefined();
      const ownedGroup = markerProcess?.pgid as number;
      // This is the process-group leader, not the group. The marker proves the numeric group
      // belongs to this exact run before the test signals the leader by its positive PID.
      expect(
        processTable().some((entry) => entry.pid === ownedGroup && entry.pgid === ownedGroup),
      ).toBe(true);
      expect(await waitForAnswer(port, child)).toBe(true);

      process.kill(ownedGroup, "SIGTERM");
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (!processTable().some((entry) => entry.pid === ownedGroup)) break;
        await Bun.sleep(25);
      }
      expect(processTable().some((entry) => entry.pid === ownedGroup)).toBe(false);
      expect(ownedMarkerMatches(marker)).toHaveLength(1);

      // Do not signal the controller: the post-readiness Worker death itself must cause its
      // checker/cleanup path to fail closed and leave no marked sidecar or process group.
      const run = await completion;
      expect(run.exitCode).not.toBe(0);
      expect(await waitForProcessGroupAbsence(ownedGroup)).toEqual([]);
      expect(ownedMarkerMatches(marker)).toEqual([]);
      expect(await answering(port)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  }, 200_000);

  test("SIGKILL controller loss is reaped by the exact marked sidecar", async () => {
    const port = await freePort();
    const seed = "s5-parent-loss-4821";
    const child = startScript({ ASIMP_S5_SEED: seed, S5_PORT: String(port) });
    const completion = collectScript(child, 30_000);
    const marker = `s5-diptych-owner-s5-${seed}-${child.pid}`;
    let ownedGroup: number | undefined;

    try {
      const markerProcess = await waitForOwnedMarker(marker, child);
      expect(markerProcess).toBeDefined();
      ownedGroup = markerProcess?.pgid;
      expect(await waitForAnswer(port, child)).toBe(true);

      process.kill(child.pid, "SIGKILL");
      const run = await completion;
      expect(run.exitCode).not.toBe(0);

      // Old cleanup was trap-only: SIGKILL made the controller vanish and left this exact
      // marker/group answering. The TERM-immune marker sees the *live* group leader reparent
      // away from the original controller, revalidates marker PID/PGID/argv, then reaps only
      // that group. Stream closure plus zero group/marker survivors prove the parent-loss path.
      expect(await waitForProcessGroupAbsence(ownedGroup as number)).toEqual([]);
      expect(ownedMarkerMatches(marker)).toEqual([]);
      expect(await answering(port)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      if (ownedGroup !== undefined) reapExactOwnedGroupForTest(marker, ownedGroup);
    }
  }, 200_000);

  test("an absent leader makes the exact marker self-expire without killing the controller", async () => {
    const port = await freePort();
    const seed = "s5-absent-leader-4821";
    const child = startScript({ ASIMP_S5_SEED: seed, S5_PORT: String(port) });
    const completion = collectScript(child, 30_000);
    const marker = `s5-diptych-owner-s5-${seed}-${child.pid}`;
    let ownedGroup: number | undefined;

    try {
      const markerProcess = await waitForOwnedMarker(marker, child);
      expect(markerProcess).toBeDefined();
      ownedGroup = markerProcess?.pgid;
      expect(
        processTable().some((entry) => entry.pid === ownedGroup && entry.pgid === ownedGroup),
      ).toBe(true);
      expect(await waitForAnswer(port, child)).toBe(true);

      // The exact validated group leader disappears first. That makes the marker's live
      // parent lookup empty; the old nonempty guard looped forever at this point.
      process.kill(ownedGroup as number, "SIGTERM");
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (!processTable().some((entry) => entry.pid === ownedGroup)) break;
        await Bun.sleep(25);
      }
      expect(processTable().some((entry) => entry.pid === ownedGroup)).toBe(false);

      // The marker's proven-absence branch is independent of controller loss. Wait for the
      // run to observe the dead Worker naturally; do not kill its controller in this test.
      const run = await completion;
      expect(run.exitCode).not.toBe(0);
      expect(await waitForProcessGroupAbsence(ownedGroup as number)).toEqual([]);
      expect(ownedMarkerMatches(marker)).toEqual([]);
      expect(await answering(port)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      if (ownedGroup !== undefined) reapExactOwnedGroupForTest(marker, ownedGroup);
    }
  }, 200_000);
});
