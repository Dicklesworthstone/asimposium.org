import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The two non-zero meanings of this package's suite runner must stay distinguishable.
 *
 * `scripts/suites.ts` refuses to fake `integration` and `performance`, and says so with the
 * root-owned blocked code (78, `EX_CONFIG`; defined at `scripts/suite/policy.ts` as
 * `BLOCKED_EXIT_CODE` and repeated as a literal here rather than imported across the package
 * boundary). The danger this test exists to catch is the collapse of that distinction in
 * either direction: a blocked gate reported as a regression, or — the worse one — a real
 * regression laundered into the blocked class, where an already-red suite hides it.
 *
 * Nothing here asserts that integration or performance *works*. It asserts that they honestly
 * refuse, and that the refusal still names its blocker and its forbidden substitutes.
 */

const BLOCKED_EXIT_CODE = 78;
const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const BEADS_LEDGER = resolve(PACKAGE_ROOT, "../../.beads/issues.jsonl");
const RUNNER = "scripts/suites.ts";
const REAL_BINDING_LANE = resolve(PACKAGE_ROOT, "test/integration/s2-krater-real-bindings.test.ts");

/**
 * One emitted NDJSON record. The suite's own records carry tool/package versions
 * and a duration; the re-emitted child blocker deliberately does not, so those
 * members are optional here rather than asserted into existence by the type.
 */
interface Diagnostic {
  tool: string;
  tool_version?: string;
  package: string;
  package_version?: string;
  suite: string;
  duration_ms?: number;
  status: string;
  exit_code: number;
  code?: string;
  probe_rejection?: string;
  blocked_on?: string;
  forbidden_substitutes?: string;
  reproduce: string;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every NDJSON record the runner emitted, in emission order. */
  records: Diagnostic[];
  /** The suite's own final record. */
  record: Diagnostic;
}

function beadStatuses(): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const line of readFileSync(BEADS_LEDGER, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const issue = JSON.parse(line) as { id?: unknown; status?: unknown };
    if (typeof issue.id === "string" && typeof issue.status === "string") {
      statuses.set(issue.id, issue.status);
    }
  }
  return statuses;
}

async function runRunner(suite: string, cwd = runnerFixture()): Promise<Run> {
  const child = Bun.spawn({
    cmd: ["bun", RUNNER, suite],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Every record, not just the last one: a suite that re-publishes a child
  // capability record emits two, and the earlier one is exactly where a foreign
  // string could smuggle a path or a credential into this package's stream.
  const records: Diagnostic[] = [];
  for (const line of stdout.split("\n")) {
    const candidate = line.trim();
    if (candidate === "" || !candidate.startsWith("{")) continue;
    try {
      records.push(JSON.parse(candidate) as Diagnostic);
    } catch (error) {
      // Never swallowed, and never defaulted to an empty record: a runner that stops emitting a
      // parseable NDJSON diagnostic has broken the contract this suite exists to check, so the
      // failure has to name the suite and show what did arrive.
      const detail = error instanceof Error ? error.message : "unparseable";
      throw new Error(
        `${RUNNER} ${suite} emitted an unparseable NDJSON line (${detail}). stdout was: ${stdout.slice(0, 400)}`,
      );
    }
  }
  const record = records.at(-1);
  if (record === undefined) {
    throw new Error(
      `${RUNNER} ${suite} emitted no parseable diagnostic. stdout was: ${stdout.slice(0, 400)}`,
    );
  }
  return { exitCode, stdout, stderr, records, record };
}

/** The well-behaved capability record the real probe would emit with no authority. */
const BASE_PROBE_RECORD: Record<string, unknown> = {
  tool: "bun",
  package: "apps/wire",
  suite: "s2-krater-real-bindings",
  status: "blocked",
  exit_code: 78,
  code: "S2_REAL_BINDING_PROOF_BLOCKED",
  blocked_on: "explicit authority for the two real local Wrangler lifecycle runs",
  forbidden_substitutes: "a shell-only regression presented as real binding proof",
  reproduce: "fixture-only",
};

/** The exact key set the runner may republish on a child probe's behalf. */
const ALLOWED_BLOCKER_KEYS = [
  "blocked_on",
  "code",
  "exit_code",
  "forbidden_substitutes",
  "package",
  "reproduce",
  "status",
  "suite",
  "tool",
];

interface FixtureOptions {
  /** Merged over `BASE_PROBE_RECORD` to model a hostile or malformed probe. */
  readonly probeFields?: Record<string, unknown>;
  /** Written verbatim to the probe's stderr before it exits. */
  readonly probeStderr?: string;
}

/**
 * A throwaway copy of the real runner with tiny, deterministic suite members. Unit tests must
 * exercise the runner's classification and diagnostic contract without recursively launching
 * the real 60-second Workerd/D1 auth preflight. The latter belongs to the integration suite.
 */
function runnerFixture(options: FixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "wire-suite-regression-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "test", "auth"), { recursive: true });
  mkdirSync(join(dir, "test", "integration"), { recursive: true });
  mkdirSync(join(dir, "test", "security"), { recursive: true });
  mkdirSync(join(dir, "test", "unit"), { recursive: true });
  mkdirSync(join(dir, "test", "split"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "@asimposium/wire", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "scripts", "suites.ts"), readFileSync(join(PACKAGE_ROOT, RUNNER)));
  // The copied runner lives outside the repository, so module resolution never
  // walks up into the workspace. Link the real contracts package rather than
  // vendoring a copy: a duplicated scanner would let the fixture pass while the
  // shared credential families drifted, which is exactly what these plants exist
  // to catch. Only the one package the runner imports is linked.
  mkdirSync(join(dir, "node_modules", "@asimposium"), { recursive: true });
  symlinkSync(
    resolve(PACKAGE_ROOT, "../../packages/contracts"),
    join(dir, "node_modules", "@asimposium", "contracts"),
    "dir",
  );
  const passingTest = [
    'import { expect, test } from "bun:test";',
    "",
    'test("the isolated fixture passes", () => {',
    "  expect(true).toBe(true);",
    "});",
    "",
  ].join("\n");
  writeFileSync(join(dir, "test", "auth", "preflight.test.ts"), passingTest);
  writeFileSync(join(dir, "test", "security", "security.test.ts"), passingTest);
  const probeRecord = { ...BASE_PROBE_RECORD, ...(options.probeFields ?? {}) };
  writeFileSync(
    join(dir, "test", "integration", "s2-krater-real-bindings.test.ts"),
    [
      'if (process.argv[2] !== "--capability-probe") throw new Error("capability probe flag required");',
      `console.log(${JSON.stringify(JSON.stringify(probeRecord))});`,
      ...(options.probeStderr === undefined
        ? []
        : [`process.stderr.write(${JSON.stringify(`${options.probeStderr}\n`)});`]),
      "process.exit(78);",
      "",
    ].join("\n"),
  );
  return dir;
}

/**
 * Add one deliberate failure beneath the real runner copy. The regression travels through the
 * same unit-suite code path without leaving a failing fixture in this package's own tree.
 */
function plantRegression(): string {
  const dir = runnerFixture();
  writeFileSync(
    join(dir, "test", "split", "planted-regression.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      "",
      'test("a planted regression: the Worker returns the wrong status", () => {',
      "  expect(500).toBe(200);",
      "});",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("a deliberately blocked suite exits 78, never 0 and never 1", () => {
  for (const suite of ["integration", "performance"] as const) {
    test(`${suite} refuses with the root-owned blocked code`, async () => {
      const run = await runRunner(suite);
      expect(run.exitCode).toBe(BLOCKED_EXIT_CODE);
      expect(run.exitCode).not.toBe(0);
      expect(run.exitCode).not.toBe(1);
      expect(run.record.suite).toBe(suite);
      expect(run.record.status).toBe("not_implemented");
      expect(run.record.code).toBe("SUITE_NOT_IMPLEMENTED");
      expect(run.record.exit_code).toBe(BLOCKED_EXIT_CODE);
    }, 20_000);

    test(`${suite} logs its blocker in detail on stderr`, async () => {
      const run = await runRunner(suite);
      expect(run.stderr).toContain("BLOCKED");
      expect(run.stderr).toContain(`exit ${BLOCKED_EXIT_CODE}`);
      expect(run.stderr).toContain("blocked on:");
      expect(run.stderr).toContain("must not be faked with:");
      expect(run.stderr).toContain(`cd apps/wire && bun run test:${suite}`);
      expect((run.record.blocked_on ?? "").length).toBeGreaterThan(40);
      expect((run.record.blocked_on ?? "").length).toBeLessThanOrEqual(400);
      expect((run.record.forbidden_substitutes ?? "").length).toBeLessThanOrEqual(400);
    }, 20_000);
  }

  test("the integration blocker distinguishes local D1 and declared DO source from cross-slice proof", async () => {
    const run = await runRunner("integration");
    const blockedOn = run.record.blocked_on ?? "";
    const forbidden = run.record.forbidden_substitutes ?? "";
    // The existing local-D1 runner and declared DO are useful source evidence but
    // are not transmuted into a cross-slice D1/R2 or deployed-staging result.
    expect(blockedOn).toContain("asimposiumorg-rhg");
    expect(blockedOn).toContain("e2e-s2-krater.sh");
    expect(blockedOn).toContain("local Workerd D1");
    expect(blockedOn).toContain("source/config declare the KraterOutboxDrainer export");
    expect(blockedOn).toContain("across mounted D1 plus private/public R2");
    expect(blockedOn).not.toContain("missing Durable Object alarm");
    expect(blockedOn).not.toContain("Durable Object alarm binding");
    expect(forbidden).toContain("mocked or stubbed D1/R2");
    expect(forbidden).toContain("bun:sqlite");
    expect(forbidden).toContain("test/support/bindings.ts");
    expect(forbidden).toContain("wrangler dev");
  }, 20_000);

  test("the performance blocker still names the missing §15 budget", async () => {
    const run = await runRunner("performance");
    expect(run.record.blocked_on ?? "").toContain("asimposiumorg-0fs");
    expect(run.record.forbidden_substitutes ?? "").toContain("micro-benchmark");
  }, 20_000);

  test("pending suites name only existing unfinished Beads", async () => {
    const statuses = beadStatuses();
    for (const suite of ["integration", "performance"] as const) {
      const run = await runRunner(suite);
      const named =
        (run.record.blocked_on ?? "").match(/\basimposiumorg-[a-z0-9]+(?:\.[a-z0-9]+)*\b/g) ?? [];
      expect(named.length).toBeGreaterThan(0);
      for (const blocker of named) {
        expect(statuses.has(blocker)).toBe(true);
        const status = statuses.get(blocker);
        expect(status === "open" || status === "in_progress").toBe(true);
      }
    }
  }, 30_000);

  test("the integration diagnostic agrees with the outbox alarm source/config declarations", async () => {
    const run = await runRunner("integration");
    const blockedOn = run.record.blocked_on ?? "";
    const workerSource = readFileSync(resolve(PACKAGE_ROOT, "src/index.ts"), "utf8");
    const outboxSource = readFileSync(resolve(PACKAGE_ROOT, "src/krater/outbox-do.ts"), "utf8");
    const wranglerSource = readFileSync(resolve(PACKAGE_ROOT, "../../infra/wrangler.toml"), "utf8");

    expect(workerSource).toContain("export { createApp, KraterOutboxDrainer }");
    expect(workerSource).toContain('requestKraterOutbox(env, "/nudge")');
    expect(outboxSource).toContain("async alarm(): Promise<void>");
    expect(outboxSource).toContain("this.state.storage.setAlarm");
    expect(wranglerSource).toContain('name = "KRATER_OUTBOX"');
    expect(wranglerSource).toContain('class_name = "KraterOutboxDrainer"');
    expect(wranglerSource).toContain('crons = ["*/5 * * * *"]');
    expect(blockedOn).toContain("source/config declare");
    expect(blockedOn).not.toContain("missing Durable Object alarm");
    expect(blockedOn).not.toContain("Durable Object alarm binding");
  }, 20_000);

  test("every emitted record leaks no absolute path, home directory or credential shape", async () => {
    for (const suite of ["integration", "performance"] as const) {
      const run = await runRunner(suite);
      // Not just the suite's own final record: the integration run also
      // republishes a child capability record, and that is the one place a
      // foreign string enters this package's diagnostic stream.
      expect(run.records.length).toBeGreaterThan(0);
      for (const record of run.records) {
        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain("/Users/");
        expect(serialized).not.toContain("/home/");
        expect(serialized).not.toContain(PACKAGE_ROOT);
        expect(serialized).not.toContain(tmpdir());
        expect(serialized).not.toMatch(/asimp_ag_[A-Za-z0-9_-]{4,}/);
        expect(serialized).not.toMatch(/#v1\.[A-Za-z0-9._~-]{8,}/);
        expect(serialized).not.toMatch(/\b[A-Fa-f0-9]{32,}\b/);
      }
      expect(run.record.reproduce).toBe(`cd apps/wire && bun run test:${suite}`);
    }
  }, 40_000);

  test("the integration run republishes exactly one child blocker with exactly the allowed keys", async () => {
    const run = await runRunner("integration");
    expect(run.records.length).toBe(2);
    const child = run.records[0];
    expect(child).toBeDefined();
    expect(Object.keys(child as object).sort()).toEqual(ALLOWED_BLOCKER_KEYS);
    expect(child?.status).toBe("blocked");
    expect(child?.code).toBe("S2_REAL_BINDING_PROOF_BLOCKED");
    expect(child?.exit_code).toBe(BLOCKED_EXIT_CODE);
    expect(child?.suite).toBe("s2-krater-real-bindings");
  }, 30_000);

  test("a child probe cannot smuggle extra keys, a path or a credential into the republished blocker", async () => {
    const run = await runRunner(
      "integration",
      runnerFixture({
        probeFields: {
          cwd_absolute: "/Users/someone/checkout/apps/wire",
          env_snapshot: "S2_TOKEN=asimp_ag_deadbeefcafe",
          nested: { home: "/home/someone/.wrangler" },
        },
      }),
    );
    expect(run.exitCode).toBe(BLOCKED_EXIT_CODE);
    const child = run.records[0];
    expect(Object.keys(child as object).sort()).toEqual(ALLOWED_BLOCKER_KEYS);
    expect(run.stdout).not.toContain("cwd_absolute");
    expect(run.stdout).not.toContain("env_snapshot");
    expect(run.stdout).not.toContain("/Users/someone");
    expect(run.stdout).not.toContain("/home/someone");
    expect(run.stdout).not.toContain("asimp_ag_");
  }, 30_000);

  // Absolute-path forms are enumerated deliberately: a validator that only knows
  // /Users and /home lets /Volumes, /Library, an arbitrary POSIX root, a Windows
  // drive and a UNC share republish themselves while the header still promises
  // repository-relative paths only.
  for (const [label, probeFields, leak] of [
    [
      "a home directory path",
      { blocked_on: "missing /Users/someone/.wrangler/config.toml" },
      "/Users/someone",
    ],
    [
      "an arbitrary POSIX absolute path",
      { blocked_on: "missing /sensitive/path/creds.json" },
      "/sensitive/path",
    ],
    [
      "a macOS volume path",
      { blocked_on: "missing /Volumes/secret/wrangler.toml" },
      "/Volumes/secret",
    ],
    [
      "a macOS Library path",
      { forbidden_substitutes: "reading /Library/Secret/keychain" },
      "/Library/Secret",
    ],
    ["a Windows drive path", { reproduce: "run C:\\Users\\someone\\creds.bat" }, "C:\\Users"],
    [
      "a Windows drive path with forward slashes",
      { reproduce: "run C:/Users/someone/creds.bat" },
      "C:/Users",
    ],
    ["a UNC share path", { blocked_on: "missing \\\\fileserver\\share\\secret" }, "\\\\fileserver"],
    ["a file URL", { blocked_on: "missing file:///Volumes/secret/config" }, "file://"],
    [
      "a credential shape",
      { forbidden_substitutes: "token asimp_ag_deadbeefcafe123" },
      "asimp_ag_",
    ],
    ["an unbounded string", { reproduce: `cd apps/wire && ${"x".repeat(500)}` }, "xxxxxxxxxx"],
    [
      "a control character",
      { blocked_on: `explicit authority${String.fromCharCode(7)}injected` },
      undefined,
    ],
    ["a non-string", { reproduce: 42 }, undefined],
    // Shared-only families. None of these is a long hex run, an absolute path,
    // or a control character, so the suite-local guards cannot see them: if the
    // shared `containsCredentialShape` import regressed, these are the cases
    // that would silently start republishing.
    [
      "a Stripe-style live secret key",
      { forbidden_substitutes: "do not paste sk_live_51Abc7DefGhiJklMnoPqr" },
      "sk_live_",
    ],
    [
      "a GitHub personal access token",
      { blocked_on: "operator supplied ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv" },
      "ghp_",
    ],
    [
      "an Authorization bearer value",
      { reproduce: "curl -H 'Authorization: Bearer sB7xQ2mR9tZ4kL0w' https://a.asimposium.org" },
      "sB7xQ2mR9tZ4kL0w",
    ],
    [
      "an inline PEM private key",
      { blocked_on: "-----BEGIN PRIVATE KEY-----MIIBVgIBADXX-----END PRIVATE KEY-----" },
      "BEGIN PRIVATE KEY",
    ],
  ] as const) {
    test(`a blocker carrying ${label} is refused with exit 1, never republished`, async () => {
      const run = await runRunner("integration", runnerFixture({ probeFields }));
      expect(run.exitCode).toBe(1);
      expect(run.exitCode).not.toBe(BLOCKED_EXIT_CODE);
      expect(run.record.status).toBe("fail");
      expect(run.record.code).toBe("SUITE_PREFLIGHT_FAILED");
      expect(run.record.probe_rejection).toBe("PROBE_RECORD_TEXT_UNSAFE");
      // Only the suite's own failure record was emitted; nothing was republished.
      expect(run.records.length).toBe(1);
      expect(run.stdout).not.toContain('"status":"blocked"');
      if (leak !== undefined) expect(run.stdout).not.toContain(leak);
    }, 30_000);
  }

  // The mirror of the loop above: tightening the path rule must not start refusing
  // the prose and documentation links a real blocker is expected to carry.
  test("ordinary prose, relative paths and https links are still republished", async () => {
    const run = await runRunner(
      "integration",
      runnerFixture({
        probeFields: {
          blocked_on:
            "explicit authority for the two real local Wrangler lifecycle runs; see https://developers.cloudflare.com/d1/ for the binding contract",
          forbidden_substitutes:
            "mocked or stubbed D1/R2 (AGENTS.md: do not mock D1 or R2); the shims in test/support/bindings.ts; a 24/7 wrangler dev process",
          reproduce: "cd apps/wire && bun run test:integration:s2-real",
        },
      }),
    );
    expect(run.exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(run.records.length).toBe(2);
    const child = run.records[0];
    expect(child?.status).toBe("blocked");
    expect(child?.blocked_on).toContain("https://developers.cloudflare.com/d1/");
    expect(child?.forbidden_substitutes).toContain("D1/R2");
    expect(child?.forbidden_substitutes).toContain("test/support/bindings.ts");
    expect(child?.reproduce).toBe("cd apps/wire && bun run test:integration:s2-real");
    const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(packageJson.scripts?.["test:integration:s2-real"]).toBe(
      "S2_RUN_REAL_BINDING_INTEGRATION=1 bun test /dev/null --timeout=120000 test/integration/s2-krater-real-bindings.test.ts",
    );
  }, 30_000);

  test("prose that merely discusses credentials is still republished as blocked", async () => {
    // The mirror of the shared-family plants: the scanner must not turn the
    // vocabulary of a security blocker into a refusal. If these regress the
    // suite goes red on a false positive rather than silently leaking.
    const run = await runRunner(
      "integration",
      runnerFixture({
        probeFields: {
          blocked_on:
            "Bearer tokens are hashed before storage and the fragment secret never reaches a log",
          forbidden_substitutes:
            "a mocked keyring presented as real signing; see https://developers.cloudflare.com/d1/ and test/support/bindings.ts",
          reproduce: "cd apps/wire && bun run test:integration",
        },
      }),
    );
    expect(run.exitCode).toBe(BLOCKED_EXIT_CODE);
    expect(run.records.length).toBe(2);
    expect(run.records[0]?.status).toBe("blocked");
    expect(run.records[0]?.blocked_on).toContain("Bearer tokens are hashed");
    expect(run.records[0]?.forbidden_substitutes).toContain("test/support/bindings.ts");
  }, 30_000);

  test("a probe that also names its code on stderr is refused, and the refusal says why", async () => {
    const run = await runRunner(
      "integration",
      runnerFixture({ probeStderr: "S2_REAL_BINDING_PROOF_BLOCKED reported out of band" }),
    );
    expect(run.exitCode).toBe(1);
    expect(run.record.code).toBe("SUITE_PREFLIGHT_FAILED");
    expect(run.record.probe_rejection).toBe("PROBE_CODE_ON_STDERR");
    // The refusal names the observed rejection instead of asserting the opposite
    // of what happened; the probe did emit its code, in the wrong channel.
    expect(run.stderr).toContain("capability probe refused");
    expect(run.stderr).toContain("PROBE_CODE_ON_STDERR");
    expect(run.stderr).not.toContain("did not emit its named code");
  }, 30_000);

  test("a probe that exits 0 is refused rather than read as blocked", async () => {
    const dir = runnerFixture();
    writeFileSync(
      join(dir, "test", "integration", "s2-krater-real-bindings.test.ts"),
      [
        'if (process.argv[2] !== "--capability-probe") throw new Error("capability probe flag required");',
        `console.log(${JSON.stringify(JSON.stringify(BASE_PROBE_RECORD))});`,
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const run = await runRunner("integration", dir);
    expect(run.exitCode).toBe(1);
    expect(run.record.probe_rejection).toBe("PROBE_EXIT_CODE_UNEXPECTED");
  }, 30_000);
});

describe("a suite that actually ran keeps the ordinary exit codes", () => {
  test("an implemented suite that passes exits 0", async () => {
    // `security`, not `unit`: spawning the unit suite from inside the unit suite would recurse.
    const run = await runRunner("security");
    expect(run.exitCode).toBe(0);
    expect(run.record.status).toBe("pass");
    expect(run.record.exit_code).toBe(0);
    expect(run.record.tool).toBe("bun test");
  }, 30_000);

  test("a planted regression under the separately registered S-3 tree exits 1, not 78", async () => {
    const run = await runRunner("unit", plantRegression());
    expect(run.exitCode).toBe(1);
    expect(run.exitCode).not.toBe(BLOCKED_EXIT_CODE);
    expect(run.record.status).toBe("fail");
    expect(run.record.exit_code).toBe(1);
    expect(run.record.code).toBeUndefined();
    // The child's own failure is in the log, not summarised away.
    expect(run.stderr + run.stdout).toContain("planted regression");
  }, 30_000);

  test("a discovered blocked capability cannot overwrite an earlier real failure with exit 78", async () => {
    const fixture = plantRegression();
    const { S2_RUN_REAL_BINDING_INTEGRATION: _authority, ...environment } = process.env;
    const child = Bun.spawn({
      cmd: [
        "bun",
        "test",
        join(fixture, "test", "split", "planted-regression.test.ts"),
        REAL_BINDING_LANE,
      ],
      cwd: PACKAGE_ROOT,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(exitCode).not.toBe(BLOCKED_EXIT_CODE);
    expect(`${stdout}${stderr}`).toContain("a planted regression");
    expect(`${stdout}${stderr}`).not.toContain('"status":"blocked"');
  }, 20_000);

  test("an unknown suite is a usage error, distinct from both", async () => {
    const child = Bun.spawn({
      cmd: ["bun", RUNNER, "not-a-suite"],
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("usage:");
  }, 20_000);

  // A bare `SUITES[command]` lookup walks Object.prototype, so these names return
  // a truthy non-suite, slip past the usage branch, and crash in the runner with a
  // stack trace and an absolute path instead of the documented exit 2.
  for (const hostile of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
    test(`the prototype-chain argument ${hostile} is a usage error, not a crash`, async () => {
      const child = Bun.spawn({
        cmd: ["bun", RUNNER, hostile],
        cwd: PACKAGE_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(2);
      expect(exitCode).not.toBe(BLOCKED_EXIT_CODE);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("usage:");
      // No thrown error, no stack frame and no absolute path reached the operator.
      expect(stderr).not.toContain("TypeError");
      expect(stderr).not.toContain("error:");
      expect(stderr).not.toMatch(/^\s+at\s/m);
      expect(stderr).not.toContain("/Users/");
      expect(stderr).not.toContain(PACKAGE_ROOT);
      // A usage error runs nothing, so it emits no diagnostic record either.
      expect(stdout.trim()).toBe("");
    }, 20_000);
  }
});
