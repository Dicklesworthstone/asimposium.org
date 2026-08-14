/**
 * G0 spike aggregation tests.
 *
 * Every spike here is a fixture written into a scratch directory. None of the
 * repository's real `scripts/e2e-s*.sh` gates run: they are costly integration
 * probes that touch staging, and a unit suite that invokes them is neither fast
 * nor honest about what it proved. The real manifest is checked for *shape*
 * only, which is the part this module actually owns.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_G0_SPIKE_IDS,
  assertCompleteG0Manifest,
  formatG0Summary,
  G0_SPIKES,
  G0ManifestError,
  type G0RunSummary,
  type G0Spike,
  type G0SpikeResult,
  REQUIRED_G0_SPIKE_IDS,
  runG0Cli,
  runG0Spikes,
  signalExitCode,
  summarize,
  validateSpikeManifest,
} from "./g0-spikes.ts";
import { BLOCKED_EXIT_CODE } from "./policy.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "asimposium-g0-spikes-"));
}

/** A spike fixture with real execute bits, which is now the entry requirement. */
function executable(root: string, id: G0Spike["id"], body: string): G0Spike {
  const script = `fixtures/${id}.sh`;
  const path = join(root, script);
  mkdirSync(join(root, "fixtures"), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\nset -u -o pipefail\n${body}\n`);
  chmodSync(path, 0o755);
  return { id, script };
}

/** Readable but not executable: the exact shape the old check waved through. */
function readableOnly(root: string, id: G0Spike["id"], body: string, mode = 0o644): G0Spike {
  const script = `fixtures/${id}-readable.sh`;
  const path = join(root, script);
  mkdirSync(join(root, "fixtures"), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, mode);
  return { id, script };
}

function codes(summary: G0RunSummary): string[] {
  return summary.results.map((result) => result.code);
}

async function waitFor(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

function result(overrides: Partial<G0SpikeResult> & Pick<G0SpikeResult, "status">): G0SpikeResult {
  return {
    id: "s1",
    code: overrides.status === "pass" ? "G0_SPIKE_PASSED" : "G0_SPIKE_FAILED",
    durationMs: 0,
    ...overrides,
  } as G0SpikeResult;
}

describe("D2 — the entry check requires execute bits, not readability", () => {
  test("an executable fixture runs and a readable-only sibling is refused", async () => {
    const root = fixtureRoot();
    const ranSentinel = join(root, "readable-only-executed");
    const summary = await runG0Spikes({
      root,
      spikes: [
        executable(root, "s1", "exit 0"),
        readableOnly(root, "s2", `printf ran > ${JSON.stringify(ranSentinel)}`),
      ],
      timeoutMs: 2_000,
    });

    expect(summary.results[0]?.code).toBe("G0_SPIKE_PASSED");
    expect(summary.results[1]?.code).toBe("G0_SPIKE_SCRIPT_NOT_EXECUTABLE");
    expect(summary.exitCode).toBe(1);
  });

  test("PLANTED: a readable-only script is never handed to the interpreter", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "planted-readable-executed");
    const summary = await runG0Spikes({
      root,
      spikes: [readableOnly(root, "s1", `printf executed > ${JSON.stringify(sentinel)}`)],
      timeoutMs: 2_000,
    });

    // The whole defect: the previous check tested `mode & 0o444`, so this file
    // was readable, therefore "runnable", therefore executed through bash.
    expect(summary.results[0]?.code).toBe("G0_SPIKE_SCRIPT_NOT_EXECUTABLE");
    await Bun.sleep(150);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("a mode-000 file, a directory, a missing path and an escaping path each refuse distinctly", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "fixtures", "a-directory.sh"), { recursive: true });
    const summary = await runG0Spikes({
      root,
      spikes: [
        readableOnly(root, "s1", "exit 0", 0o000),
        { id: "s2", script: "fixtures/a-directory.sh" },
        { id: "s3", script: "fixtures/definitely-missing.sh" },
        { id: "s5", script: "../outside-the-repository.sh" },
      ],
      timeoutMs: 2_000,
    });

    expect(codes(summary)).toEqual([
      "G0_SPIKE_SCRIPT_NOT_EXECUTABLE",
      "G0_SPIKE_SCRIPT_NOT_REGULAR_FILE",
      "G0_SPIKE_SCRIPT_MISSING",
      "G0_SPIKE_PATH_INVALID",
    ]);
    expect(summary.exitCode).toBe(1);
  });
});

describe("D3 — the aggregate has its own finite ceiling", () => {
  test("PLANTED: per-spike timeouts alone do not bound the run; the aggregate deadline does", async () => {
    const root = fixtureRoot();
    const startedAt = performance.now();
    const summary = await runG0Spikes({
      root,
      spikes: [
        executable(root, "s1", "while :; do sleep 0.01; done"),
        executable(root, "s2", "while :; do sleep 0.01; done"),
        executable(root, "s3", "while :; do sleep 0.01; done"),
      ],
      // Each spike could burn 5s on its own: three of them is 15s with no
      // aggregate bound. The 600ms ceiling is what actually stops the run.
      timeoutMs: 5_000,
      aggregateTimeoutMs: 600,
      terminationGraceMs: 100,
    });
    const elapsed = performance.now() - startedAt;

    expect(summary.results[0]?.code).toBe("G0_SPIKE_AGGREGATE_TIMEOUT");
    expect(summary.results.slice(1).map((entry) => entry.code)).toEqual([
      "G0_SPIKE_NOT_RUN",
      "G0_SPIKE_NOT_RUN",
    ]);
    expect(summary.exitCode).toBe(1);
    // Comfortably under the 15s an unbounded aggregate would have allowed.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  test("a spike stopped by its own limit is labelled a spike timeout, not an aggregate one", async () => {
    const root = fixtureRoot();
    const summary = await runG0Spikes({
      root,
      spikes: [executable(root, "s1", "while :; do sleep 0.01; done")],
      timeoutMs: 200,
      aggregateTimeoutMs: 30_000,
      terminationGraceMs: 100,
    });

    expect(summary.results[0]?.code).toBe("G0_SPIKE_TIMEOUT");
    expect(summary.exitCode).toBe(1);
  }, 20_000);

  test("every duration option refuses a non-finite or out-of-range value", async () => {
    const root = fixtureRoot();
    const spikes = [executable(root, "s1", "exit 0")];
    for (const field of ["timeoutMs", "aggregateTimeoutMs", "terminationGraceMs"] as const) {
      await expect(runG0Spikes({ root, spikes, [field]: 0 })).rejects.toThrow(TypeError);
      await expect(runG0Spikes({ root, spikes, [field]: 3_600_001 })).rejects.toThrow(TypeError);
      await expect(runG0Spikes({ root, spikes, [field]: 1.5 })).rejects.toThrow(TypeError);
    }
  });
});

describe("D4 — the entry point bridges SIGINT and SIGTERM", () => {
  test("SIGINT terminates the running group, still prints a summary, and exits 130", async () => {
    const root = fixtureRoot();
    const started = join(root, "cli-started");
    const leak = join(root, "cli-grandchild-leaked");
    const handlers = new Map<string, () => void>();
    const lines: string[] = [];
    const errors: string[] = [];

    const codePromise = runG0Cli({
      root,
      spikes: [
        executable(
          root,
          "s1",
          `(trap '' TERM; sleep 0.5; printf leaked > ${JSON.stringify(leak)}) &\n` +
            `printf started > ${JSON.stringify(started)}\n` +
            "while :; do sleep 0.01; done",
        ),
        executable(root, "s2", "exit 0"),
      ],
      timeoutMs: 10_000,
      terminationGraceMs: 100,
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line),
      onSignal: (signal, handler) => handlers.set(signal, handler),
      hardExit: () => {
        throw new Error("hardExit must not fire on a single signal");
      },
    });

    await waitFor(started);
    handlers.get("SIGINT")?.();
    const exitCode = await codePromise;
    await Bun.sleep(600);

    expect(exitCode).toBe(signalExitCode("SIGINT"));
    expect(exitCode).toBe(130);
    // The summary is still emitted: an interrupted run that prints nothing is
    // indistinguishable from a crash.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).suite).toBe("g0-spikes-integration");
    expect(errors.join("\n")).toContain("G0_SPIKES_INTERRUPTED");
    // The group really was terminated rather than orphaned.
    expect(existsSync(leak)).toBe(false);
  }, 25_000);

  test("SIGTERM exits 143 and a repeat signal escalates to a hard exit", async () => {
    const root = fixtureRoot();
    const started = join(root, "cli-term-started");
    const handlers = new Map<string, () => void>();
    const hardExits: number[] = [];
    const lines: string[] = [];

    const codePromise = runG0Cli({
      root,
      spikes: [
        executable(
          root,
          "s1",
          `printf started > ${JSON.stringify(started)}\nwhile :; do sleep 0.01; done`,
        ),
      ],
      timeoutMs: 10_000,
      terminationGraceMs: 100,
      log: (line) => lines.push(line),
      errorLog: () => {},
      onSignal: (signal, handler) => handlers.set(signal, handler),
      hardExit: (code) => hardExits.push(code),
    });

    await waitFor(started);
    handlers.get("SIGTERM")?.();
    handlers.get("SIGTERM")?.();
    const exitCode = await codePromise;

    expect(exitCode).toBe(signalExitCode("SIGTERM"));
    expect(exitCode).toBe(143);
    expect(hardExits).toEqual([143]);
  }, 25_000);

  test("an uninterrupted CLI run returns the summary's own exit code", async () => {
    const root = fixtureRoot();
    const lines: string[] = [];
    const exitCode = await runG0Cli({
      root,
      spikes: [executable(root, "s1", "exit 78")],
      timeoutMs: 2_000,
      log: (line) => lines.push(line),
      errorLog: () => {},
      onSignal: () => {},
    });

    expect(exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(JSON.parse(lines[0] as string).code).toBe("G0_SPIKES_BLOCKED");
  });

  test("the CLI turns a bad manifest into a fail-closed record instead of a stack trace", async () => {
    const root = fixtureRoot();
    const lines: string[] = [];
    const exitCode = await runG0Cli({
      root,
      spikes: [executable(root, "s1", "exit 0"), executable(root, "s1", "exit 0")],
      log: (line) => lines.push(line),
      errorLog: () => {},
      onSignal: () => {},
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(lines[0] as string);
    expect(record.code).toBe("G0_MANIFEST_DUPLICATE_ID");
    expect(record.status).toBe("fail");
  });
});

describe("D5 — a start failure is its own condition", () => {
  test("PLANTED: an unresolvable interpreter reports a spawn failure, not a signalling failure", async () => {
    const root = fixtureRoot();
    const summary = await runG0Spikes({
      root,
      spikes: [executable(root, "s1", "exit 0")],
      interpreter: "definitely-not-an-installed-interpreter",
      timeoutMs: 2_000,
    });

    expect(summary.results[0]?.code).toBe("G0_SPIKE_SPAWN_FAILED");
    // The defect being fixed: this used to surface as a process-group problem,
    // sending a reader to look for a kill that was never attempted.
    expect(summary.results[0]?.code).not.toBe("G0_SPIKE_PROCESS_GROUP_SIGNAL_FAILED");
    expect(summary.exitCode).toBe(1);
  });

  test("an interpreter carrying a path separator is refused outright", async () => {
    const root = fixtureRoot();
    const spikes = [executable(root, "s1", "exit 0")];
    await expect(runG0Spikes({ root, spikes, interpreter: "/bin/bash" })).rejects.toThrow(
      TypeError,
    );
    await expect(runG0Spikes({ root, spikes, interpreter: "../bash" })).rejects.toThrow(TypeError);
  });
});

describe("D6 — an empty run fails closed", () => {
  test("PLANTED: zero results is a failure, never a green gate", () => {
    const summary = summarize([], 0);

    expect(summary.status).toBe("fail");
    expect(summary.code).toBe("G0_SPIKES_NO_RESULTS");
    expect(summary.exitCode).toBe(1);
    // The defect: zero failures reduced to pass, so doing nothing looked exactly
    // like succeeding.
    expect(summary.status).not.toBe("pass");
    expect(summary.exitCode).not.toBe(0);
  });

  test("a single passing result is still allowed to be green", () => {
    expect(summarize([result({ status: "pass" })], 0).exitCode).toBe(0);
  });
});

describe("D7 — the manifest is validated exactly", () => {
  test("the shipped manifest covers S1-S6 with S4 owned elsewhere", () => {
    expect(() => assertCompleteG0Manifest(G0_SPIKES)).not.toThrow();
    expect(G0_SPIKES.map((spike) => spike.id)).toEqual([...REQUIRED_G0_SPIKE_IDS]);
    expect(G0_SPIKES.map((spike) => spike.id)).not.toContain("s4");
    expect(ALL_G0_SPIKE_IDS).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  test("PLANTED: a duplicate identifier is refused", () => {
    const spikes: G0Spike[] = [
      { id: "s1", script: "a.sh" },
      { id: "s2", script: "b.sh" },
      { id: "s1", script: "c.sh" },
    ];
    expect(() => validateSpikeManifest(spikes)).toThrow(G0ManifestError);
    expect(() => validateSpikeManifest(spikes)).toThrow(/G0_MANIFEST_DUPLICATE_ID/);
  });

  test("PLANTED: a missing identifier is refused by the complete-manifest check", () => {
    const spikes = G0_SPIKES.filter((spike) => spike.id !== "s3");
    expect(() => assertCompleteG0Manifest(spikes)).toThrow(/G0_MANIFEST_MISSING_ID/);
    // Structurally fine on its own — only completeness catches it, which is why
    // the two checks are separate.
    expect(() => validateSpikeManifest(spikes)).not.toThrow();
  });

  test("PLANTED: an unknown identifier is refused rather than silently skipped", () => {
    const spikes = [{ id: "s7", script: "scripts/nope.sh" } as unknown as G0Spike];
    expect(() => validateSpikeManifest(spikes)).toThrow(/G0_MANIFEST_UNKNOWN_ID/);
  });

  test("PLANTED: re-adding S4 here is refused because e2e owns that verdict", () => {
    const spikes: G0Spike[] = [
      ...G0_SPIKES,
      { id: "s4", script: "scripts/e2e-s4-screening-oauth.sh" },
    ];
    expect(() => assertCompleteG0Manifest(spikes)).toThrow(/G0_MANIFEST_S4_NOT_OWNED_HERE/);
  });

  test("an empty manifest and an empty script path are both refused", () => {
    expect(() => validateSpikeManifest([])).toThrow(/G0_MANIFEST_EMPTY/);
    expect(() => validateSpikeManifest([{ id: "s1", script: "" }])).toThrow(
      /G0_MANIFEST_PATH_INVALID/,
    );
  });

  test("runG0Spikes refuses an incoherent explicit manifest before spawning anything", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "should-never-run");
    const spike = executable(root, "s1", `printf ran > ${JSON.stringify(sentinel)}`);
    await expect(runG0Spikes({ root, spikes: [spike, spike] })).rejects.toThrow(G0ManifestError);
    await Bun.sleep(100);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("D8 — group cleanup is bounded and never signals a stale group", () => {
  test("a timed-out spike kills a TERM-ignoring grandchild before it can leak", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "grandchild-survived-timeout");
    const started = join(root, "grandchild-started");
    const summary = await runG0Spikes({
      root,
      spikes: [
        executable(
          root,
          "s1",
          `(trap '' TERM; sleep 0.4; printf leaked > ${JSON.stringify(sentinel)}) &\n` +
            `printf started > ${JSON.stringify(started)}\n` +
            "while :; do sleep 0.01; done",
        ),
      ],
      timeoutMs: 150,
      terminationGraceMs: 100,
    });

    expect(summary.results[0]?.code).toBe("G0_SPIKE_TIMEOUT");
    await waitFor(started);
    await Bun.sleep(600);
    expect(existsSync(sentinel)).toBe(false);
  }, 25_000);

  test("PLANTED: a group that dies immediately does not cost the full grace period", async () => {
    const root = fixtureRoot();
    const startedAt = performance.now();
    const summary = await runG0Spikes({
      root,
      // Exits the instant it is signalled and leaves nothing behind.
      spikes: [executable(root, "s1", "while :; do sleep 0.01; done")],
      timeoutMs: 150,
      // A three-second grace that must NOT be slept through.
      terminationGraceMs: 3_000,
    });
    const elapsed = performance.now() - startedAt;

    expect(summary.results[0]?.code).toBe("G0_SPIKE_TIMEOUT");
    // The old cleanup awaited the whole grace unconditionally, so this was
    // ~3.15s. Polling for the group to disappear returns as soon as it has.
    expect(elapsed).toBeLessThan(1_500);
  }, 25_000);

  test("PLANTED: a cleanly exiting spike's process group is never signalled afterwards", async () => {
    const root = fixtureRoot();
    const survivor = join(root, "clean-exit-background-survivor");
    const summary = await runG0Spikes({
      root,
      // The shell exits 0 immediately while a background descendant keeps
      // running. Nothing asked for termination, so nothing may be signalled.
      spikes: [
        executable(
          root,
          "s1",
          `(sleep 0.4; printf survived > ${JSON.stringify(survivor)}) &\nexit 0`,
        ),
      ],
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(summary.results[0]?.code).toBe("G0_SPIKE_PASSED");
    expect(summary.exitCode).toBe(0);
    await Bun.sleep(700);
    // The old code sent an unconditional SIGKILL to the group after every exit,
    // including clean ones — signalling a group id whose leader had already been
    // reaped. The descendant is the script's own choice and survives.
    expect(existsSync(survivor)).toBe(true);
  }, 25_000);

  test("PLANTED: a background process holding the inherited pipe cannot hang the runner", async () => {
    const root = fixtureRoot();
    const startedAt = performance.now();
    const summary = await runG0Spikes({
      root,
      // The shell exits at once, but the background subshell inherits stdout and
      // keeps the pipe open for two seconds. Waiting for `end` unconditionally
      // would block here with no timer left running to stop it.
      spikes: [executable(root, "s1", "(sleep 2; printf late) &\nexit 0")],
      timeoutMs: 5_000,
      postExitDrainMs: 150,
      terminationGraceMs: 100,
      diagnosticSink: () => {},
    });
    const elapsed = performance.now() - startedAt;

    expect(summary.results[0]?.code).toBe("G0_SPIKE_PASSED");
    expect(elapsed).toBeLessThan(1_200);
  }, 25_000);

  test("abort terminates the running group and later spikes never start", async () => {
    const root = fixtureRoot();
    const started = join(root, "abort-started");
    const leak = join(root, "abort-grandchild-leaked");
    const later = join(root, "abort-later-ran");
    const controller = new AbortController();
    const summaryPromise = runG0Spikes({
      root,
      spikes: [
        executable(
          root,
          "s1",
          `(trap '' TERM; sleep 0.5; printf leaked > ${JSON.stringify(leak)}) &\n` +
            `printf started > ${JSON.stringify(started)}\n` +
            "while :; do sleep 0.01; done",
        ),
        executable(root, "s2", `printf ran > ${JSON.stringify(later)}`),
      ],
      signal: controller.signal,
      timeoutMs: 10_000,
      terminationGraceMs: 100,
    });

    await waitFor(started);
    controller.abort();
    const summary = await summaryPromise;
    await Bun.sleep(700);

    expect(codes(summary)).toEqual(["G0_SPIKE_ABORTED", "G0_SPIKE_NOT_RUN"]);
    expect(summary.exitCode).toBe(1);
    expect(existsSync(leak)).toBe(false);
    // Recorded rather than omitted: a short results array would understate what
    // the gate was meant to cover.
    expect(existsSync(later)).toBe(false);
    expect(summary.results).toHaveLength(2);
  }, 25_000);

  test("a spike killed by a signal is a failure carrying the signal name", async () => {
    const root = fixtureRoot();
    const summary = await runG0Spikes({
      root,
      spikes: [executable(root, "s1", "kill -TERM $$")],
      timeoutMs: 2_000,
    });

    expect(summary.results[0]?.code).toBe("G0_SPIKE_SIGNALLED");
    expect(summary.results[0]?.signal).toBe("SIGTERM");
    expect(summary.exitCode).toBe(1);
  });
});

describe("D9 — child output stays out of the stdout contract", () => {
  test("PLANTED: child stdout reaches the diagnostic sink and never the aggregate JSON", async () => {
    const root = fixtureRoot();
    const captured: string[] = [];
    const marker = "SPIKE-STDOUT-WOULD-HAVE-CORRUPTED-THE-RECORD";
    const summary = await runG0Spikes({
      root,
      spikes: [executable(root, "s1", `printf '%s\\n' ${JSON.stringify(marker)}; exit 0`)],
      timeoutMs: 2_000,
      diagnosticSink: (text) => captured.push(text),
    });
    const serialized = formatG0Summary(summary, root);

    // Evidence preserved, labelled by spike...
    expect(captured.join("")).toContain(marker);
    expect(captured.join("")).toContain("g0 spike s1 stdout");
    // ...and absent from the one machine-readable line. Under `stdio: inherit`
    // this text landed on the same stdout as the record below.
    expect(serialized).not.toContain(marker);
    expect(JSON.parse(serialized).code).toBe("G0_SPIKES_PASSED");
  });

  test("child stderr is captured, labelled and still counted as evidence", async () => {
    const root = fixtureRoot();
    const captured: string[] = [];
    await runG0Spikes({
      root,
      spikes: [executable(root, "s1", "printf 'diagnostic detail\\n' >&2; exit 1")],
      timeoutMs: 2_000,
      diagnosticSink: (text) => captured.push(text),
    });

    expect(captured.join("")).toContain("g0 spike s1 stderr");
    expect(captured.join("")).toContain("diagnostic detail");
  });

  test("PLANTED: a credential printed by a spike is redacted before it is replayed", async () => {
    const root = fixtureRoot();
    const captured: string[] = [];
    const token = "asimp_ag_abcdefghijklmnop";
    await runG0Spikes({
      root,
      spikes: [executable(root, "s1", `printf '%s\\n' ${JSON.stringify(token)} >&2; exit 1`)],
      timeoutMs: 2_000,
      diagnosticSink: (text) => captured.push(text),
    });

    const text = captured.join("");
    expect(text).not.toContain(token);
    expect(text).not.toContain("asimp_ag_");
    expect(text).toContain("<redacted>");
  });

  test("captured output is bounded and the truncation is declared, not silent", async () => {
    const root = fixtureRoot();
    const captured: string[] = [];
    const summary = await runG0Spikes({
      root,
      spikes: [
        executable(root, "s1", "for i in $(seq 1 400); do printf 'aaaaaaaaaaaaaaaaaaaa\\n'; done"),
      ],
      timeoutMs: 5_000,
      maxCapturedBytes: 512,
      diagnosticSink: (text) => captured.push(text),
    });

    const body = captured.join("");
    // Ceiling honoured, with room for the label line.
    expect(body.length).toBeLessThan(1_024);
    expect(body).toContain("truncated at the capture ceiling");
    expect(summary.results[0]?.outputTruncated).toBe(true);
    expect(JSON.parse(formatG0Summary(summary, root)).spikes[0].output_truncated).toBe(true);
    // Bounding must not turn into a hang: the child still ran to completion.
    expect(summary.results[0]?.code).toBe("G0_SPIKE_PASSED");
  }, 25_000);

  test("the aggregate record redacts an absolute root and a credential-shaped label", () => {
    const root = fixtureRoot();
    const serialized = formatG0Summary(
      {
        status: "fail",
        code: "G0_SPIKES_FAILED",
        exitCode: 1,
        durationMs: 0,
        totals: { pass: 0, fail: 1, blocked: 0 },
        results: [
          {
            id: `${root}/asimp_ag_abcdefghijklmnop`,
            status: "fail",
            code: "G0_SPIKE_FAILED",
            durationMs: 0,
            exitCode: 1,
          },
        ],
      },
      root,
    );

    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("asimp_ag_");
    expect(serialized).toContain("<redacted>");
  });
});

describe("exit precedence", () => {
  test("pass alone is 0, a blocked spike is 78, and any failure outranks both", () => {
    const pass = result({ status: "pass" });
    const blocked = result({ id: "s2", status: "blocked", code: "G0_SPIKE_BLOCKED" });
    const fail = result({ id: "s3", status: "fail", code: "G0_SPIKE_FAILED" });

    expect(summarize([pass], 0).exitCode).toBe(0);
    expect(summarize([pass, blocked], 0).exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(summarize([pass, blocked, fail], 0).exitCode).toBe(1);
    expect(summarize([fail], 0).exitCode).toBe(1);
    expect(summarize([], 0).exitCode).toBe(1);

    expect(summarize([pass, blocked], 0).code).toBe("G0_SPIKES_BLOCKED");
    expect(summarize([pass, blocked, fail], 0).code).toBe("G0_SPIKES_FAILED");
    // A blocked spike stays visible in the totals even when a failure outranks it.
    expect(summarize([pass, blocked, fail], 0).totals).toEqual({ pass: 1, fail: 1, blocked: 1 });
  });

  test("end to end, a pass plus a blocked spike is non-green and exits 78", async () => {
    const root = fixtureRoot();
    const summary = await runG0Spikes({
      root,
      spikes: [executable(root, "s1", "exit 0"), executable(root, "s2", "exit 78")],
      timeoutMs: 2_000,
    });

    expect(summary.status).toBe("blocked");
    expect(summary.exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(codes(summary)).toEqual(["G0_SPIKE_PASSED", "G0_SPIKE_BLOCKED"]);
  });

  test("an unexpected exit code is distinguished from a plain test failure", async () => {
    const root = fixtureRoot();
    const summary = await runG0Spikes({
      root,
      spikes: [executable(root, "s1", "exit 1"), executable(root, "s2", "exit 42")],
      timeoutMs: 2_000,
    });

    expect(codes(summary)).toEqual(["G0_SPIKE_FAILED", "G0_SPIKE_UNEXPECTED_EXIT"]);
    expect(summary.results[1]?.exitCode).toBe(42);
    expect(summary.exitCode).toBe(1);
  });
});
