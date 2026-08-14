#!/usr/bin/env bun
/**
 * Per-package suite entry points for `@asimposium/wire`.
 *
 * Consumer: the root dispatcher (`scripts/suite/cli.ts`), which runs
 * `bun run test:<suite>` inside this package. Root policy
 * (`scripts/suite/policy.ts`) decides which suites this package owes; this file
 * only decides how each one is invoked, and never whether it is required — a
 * package must not be able to relax its own gate (Fable §17.0).
 *
 * Gate it enforces: a suite this package cannot yet honestly run must exit
 * non-zero with a named blocker, not with an encouraging message. The observed
 * defect class is the vacuously-green entry point: a `test:integration` that
 * prints "nothing to do" and returns 0, which reads in CI as coverage that does
 * not exist.
 *
 * Deletion condition: when every suite below is `implemented`, this file has no
 * remaining job and the scripts should call `bun test test/<suite>` directly.
 *
 * Diagnostics are one NDJSON record per suite on stdout (tool, tool version,
 * package, package version, suite, duration_ms, status, reproduction command)
 * with a human line on stderr. Records carry repository-relative paths only:
 * no absolute paths, no environment values, no credential-shaped strings.
 *
 * Exit codes: 0 pass · 1 the suite ran and failed · 2 usage · 78 the suite is
 * declared but deliberately blocked on named future work.
 */

import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
/** Repository-relative label. Never an absolute path. */
const PACKAGE_DIR = "apps/wire";

/**
 * The root-owned convention for "this gate is deliberately blocked on named future work",
 * as opposed to "this gate ran and something is broken": 78, `EX_CONFIG` from sysexits(3).
 * The definition lives at the root (`scripts/suite/policy.ts`, `BLOCKED_EXIT_CODE`), where a
 * package cannot redefine the meaning of its own gate inside a feature diff (Fable §17.0);
 * it is repeated as a literal here rather than imported, because a workspace package must not
 * reach across the boundary into root tooling.
 *
 * A blocked suite is never green. This process still exits non-zero and still prints the
 * blocker; the code only tells a reader which of the two non-zero meanings applies, so that a
 * real regression landing inside an already-red suite remains visible.
 */
const BLOCKED_EXIT_CODE = 78;

interface ImplementedSuite {
  status: "implemented";
  /** Directories, relative to the package root, passed to `bun test`. */
  dirs: readonly string[];
  covers: string;
}

interface PendingSuite {
  status: "pending";
  /** Tests that run automatically before this honest downstream blocked verdict. */
  preflight?: {
    /** Directories, relative to the package root, passed to `bun test`. */
    dirs: readonly string[];
    covers: string;
    /**
     * A fast test that is expected to report a named capability blocker. The
     * dispatcher turns only that exact no-authority result into this suite's
     * machine-readable blocked record; every other result is a regression.
     */
    expectedBlocked?: {
      file: string;
      code: string;
      exitCode: number;
      covers: string;
    };
  };
  /** The exact missing thing, named by bead where one exists. */
  blockedOn: string;
  /** What may NOT be substituted to turn this green early. */
  forbiddenSubstitutes: string;
}

type Suite = ImplementedSuite | PendingSuite;

const SUITES: Record<string, Suite> = {
  unit: {
    status: "implemented",
    dirs: ["test/unit", "test/split"],
    covers:
      "the Worker fetch handler, binding probes, response envelopes, the Drizzle/D1 client seam, and the pure S-3 split-policy/service contract",
  },
  contract: {
    status: "implemented",
    dirs: ["test/contract"],
    covers:
      "byte-exact wire format of this scaffold's own faces, plus binding-name agreement with infra/wrangler.toml; NOT the Fable §16.2 golden corpus",
  },
  security: {
    status: "implemented",
    dirs: ["test/security"],
    covers: "disclosure discipline on every face this scaffold serves",
  },
  integration: {
    status: "pending",
    preflight: {
      dirs: ["test/auth"],
      covers:
        "the S-6 local Workerd/D1 ingress lifecycle self-test; it is automatic local integration evidence, not deployed cross-plane proof",
      expectedBlocked: {
        file: "test/integration/s2-krater-real-bindings.test.ts",
        code: "S2_REAL_BINDING_PROOF_BLOCKED",
        exitCode: BLOCKED_EXIT_CODE,
        covers:
          "the S-2 real-binding lane is discovered and its missing explicit authority is classified as blocked; the opt-in 2x660-second lifecycle lane is not run",
      },
    },
    blockedOn:
      "asimposiumorg-p1g (OPS.3) and W2 Krater. `scripts/e2e-s2-krater.sh` already applies the numbered migrations and exercises local Workerd D1, but it is not a registered cross-slice integration suite and deliberately blocks on the missing Durable Object alarm and staging edge-cache evidence. What remains missing is a mock-free D1/R2 integration suite for the mounted Worker surfaces plus a configured R2 namespace and Durable Object alarm binding",
    forbiddenSubstitutes:
      "mocked or stubbed D1/R2 (AGENTS.md: do not mock D1 or R2 in integration tests); bun:sqlite standing in for D1; the shape-only shims in test/support/bindings.ts; an in-process fetch relabelled as integration; a `wrangler dev` process that starts, serves the health face and is reported as binding proof without a read or write crossing D1 or R2",
  },
  performance: {
    status: "pending",
    blockedOn:
      "asimposiumorg-233 (OPS.2a) and the Fable §15 budgets: no measured budget exists for this Worker, so there is no threshold to assert against",
    forbiddenSubstitutes:
      "a wall-clock micro-benchmark of the local handler presented as the §15 budget; a threshold derived from the first observed run; asserting only that the handler returns at all",
  },
};

const emit = (record: Record<string, unknown>): void => {
  console.log(JSON.stringify(record));
};

const note = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function packageIdentity(): Promise<{ name: string; version: string }> {
  const pkg = (await Bun.file(resolve(PACKAGE_ROOT, "package.json")).json()) as {
    name?: string;
    version?: string;
  };
  return { name: pkg.name ?? "unknown", version: pkg.version ?? "0.0.0" };
}

async function runBunTests(
  dirs: readonly string[],
): Promise<{ exitCode: number; duration: number }> {
  const started = performance.now();
  // stdio is inherited: child output is never suppressed, so a cited green
  // result always has the run behind it in the same log.
  const child = Bun.spawn({
    cmd: ["bun", "test", ...dirs],
    cwd: PACKAGE_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await child.exited;
  return { exitCode, duration: Math.round(performance.now() - started) };
}

async function runExpectedBlockedPreflight(
  preflight: NonNullable<PendingSuite["preflight"]>["expectedBlocked"],
): Promise<{ ok: boolean; duration: number }> {
  if (preflight === undefined) return { ok: true, duration: 0 };
  const started = performance.now();
  // The real S-2 lifecycle lane is opt-in and can take 2x660 seconds. Remove
  // any ambient authority here: this automatic gate exercises only the test's
  // fast, named no-authority capability result.
  const { S2_RUN_REAL_BINDING_INTEGRATION: _realBindingAuthority, ...environment } = process.env;
  const child = Bun.spawn({
    // This is a capability probe, not a test-suite member. Executing the file directly keeps
    // its deliberate exit 78 out of broad `bun test` discovery, where a process-level exit
    // could otherwise overwrite an earlier real test failure.
    cmd: ["bun", preflight.file, "--capability-probe"],
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
  const duration = Math.round(performance.now() - started);
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const candidate = line.trim();
    if (candidate === "" || !candidate.startsWith("{")) continue;
    try {
      records.push(JSON.parse(candidate) as Record<string, unknown>);
    } catch {
      return { ok: false, duration };
    }
  }
  if (exitCode !== preflight.exitCode || stderr.includes(preflight.code) || records.length !== 1) {
    return { ok: false, duration };
  }
  const record = records[0];
  if (record === undefined) return { ok: false, duration };
  if (
    record.tool !== "bun" ||
    record.package !== PACKAGE_DIR ||
    record.status !== "blocked" ||
    record.exit_code !== preflight.exitCode ||
    record.code !== preflight.code ||
    record.suite !== "s2-krater-real-bindings" ||
    typeof record.blocked_on !== "string" ||
    typeof record.forbidden_substitutes !== "string" ||
    typeof record.reproduce !== "string"
  ) {
    return { ok: false, duration };
  }
  // Re-emit the exact validated child record from the real integration entry
  // point. The long lane was not authorized in this child environment.
  emit(record);
  note(`BLOCKED ${PACKAGE_DIR} integration preflight: ${preflight.code}`);
  note(`  ${preflight.covers}`);
  return { ok: true, duration };
}

async function runSuite(
  name: string,
  suite: Suite,
  identity: { name: string; version: string },
): Promise<number> {
  const base = {
    package: identity.name,
    package_version: identity.version,
    suite: name,
    reproduce: `cd ${PACKAGE_DIR} && bun run test:${name}`,
  } as const;

  if (suite.status === "pending") {
    const started = performance.now();
    const preflightCovers =
      suite.preflight === undefined
        ? undefined
        : [suite.preflight.covers, suite.preflight.expectedBlocked?.covers]
            .filter((cover): cover is string => cover !== undefined)
            .join("; ");
    if (suite.preflight !== undefined) {
      const { exitCode } = await runBunTests(suite.preflight.dirs);
      if (exitCode !== 0) {
        const duration = Math.round(performance.now() - started);
        emit({
          ...base,
          tool: "bun test",
          tool_version: Bun.version,
          duration_ms: duration,
          status: "fail",
          exit_code: 1,
          code: "SUITE_PREFLIGHT_FAILED",
        });
        note(`FAILED ${PACKAGE_DIR} ${name}: SUITE_PREFLIGHT_FAILED (exit 1)`);
        note(`  failed preflight: ${suite.preflight.covers}`);
        note(`  reproduce: ${base.reproduce}`);
        return 1;
      }
      const expectedBlocked = await runExpectedBlockedPreflight(suite.preflight.expectedBlocked);
      if (!expectedBlocked.ok) {
        const duration = Math.round(performance.now() - started);
        emit({
          ...base,
          tool: "bun test",
          tool_version: Bun.version,
          duration_ms: duration,
          status: "fail",
          exit_code: 1,
          code: "SUITE_PREFLIGHT_FAILED",
        });
        note(
          `FAILED ${PACKAGE_DIR} ${name}: expected blocker preflight did not emit its named code`,
        );
        note(`  reproduce: ${base.reproduce}`);
        return 1;
      }
    }
    emit({
      ...base,
      // A pending suite may still have executed its automatic preflight. Do
      // not claim no tool ran merely because the downstream suite remains
      // honestly blocked.
      tool: suite.preflight === undefined ? "none" : "bun test",
      tool_version: suite.preflight === undefined ? "n/a" : Bun.version,
      duration_ms: Math.round(performance.now() - started),
      status: "not_implemented",
      exit_code: BLOCKED_EXIT_CODE,
      code: "SUITE_NOT_IMPLEMENTED",
      preflight_covers: preflightCovers,
      preflight_blocked_code: suite.preflight?.expectedBlocked?.code,
      blocked_on: suite.blockedOn,
      forbidden_substitutes: suite.forbiddenSubstitutes,
    });
    note(`BLOCKED ${PACKAGE_DIR} ${name}: SUITE_NOT_IMPLEMENTED (exit ${BLOCKED_EXIT_CODE})`);
    note(`  blocked on: ${suite.blockedOn}`);
    note(`  must not be faked with: ${suite.forbiddenSubstitutes}`);
    note(`  reproduce: ${base.reproduce}`);
    return BLOCKED_EXIT_CODE;
  }

  const { exitCode, duration } = await runBunTests(suite.dirs);

  // An implemented suite reports only pass or fail. It never borrows the blocked code: a
  // suite that actually ran and went red is a regression, whatever else is unfinished.
  const status = exitCode === 0 ? "pass" : "fail";
  emit({
    ...base,
    tool: "bun test",
    tool_version: Bun.version,
    duration_ms: duration,
    status,
    exit_code: status === "pass" ? 0 : 1,
  });
  return status === "pass" ? 0 : 1;
}

const command = process.argv[2] ?? "list";

if (command === "list") {
  for (const [name, suite] of Object.entries(SUITES)) {
    note(
      suite.status === "implemented"
        ? `${name.padEnd(12)} implemented  ${suite.covers}`
        : `${name.padEnd(12)} pending      ${suite.blockedOn}`,
    );
  }
  process.exit(0);
}

const selected = SUITES[command];
if (selected === undefined) {
  note(`usage: bun scripts/suites.ts <list|${Object.keys(SUITES).join("|")}>`);
  process.exit(2);
}

process.exit(await runSuite(command, selected, await packageIdentity()));
