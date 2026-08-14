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

interface Diagnostic {
  tool: string;
  tool_version: string;
  package: string;
  package_version: string;
  suite: string;
  duration_ms: number;
  status: "pass" | "fail" | "not_implemented";
  /** The process exit code this record was emitted with, so the class is self-describing. */
  exit_code: number;
  code?: string;
  blocked_on?: string;
  forbidden_substitutes?: string;
  reproduce: string;
}

const emit = (record: Diagnostic): void => {
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
    emit({
      ...base,
      tool: "none",
      tool_version: "n/a",
      duration_ms: 0,
      status: "not_implemented",
      exit_code: BLOCKED_EXIT_CODE,
      code: "SUITE_NOT_IMPLEMENTED",
      blocked_on: suite.blockedOn,
      forbidden_substitutes: suite.forbiddenSubstitutes,
    });
    note(`BLOCKED ${PACKAGE_DIR} ${name}: SUITE_NOT_IMPLEMENTED (exit ${BLOCKED_EXIT_CODE})`);
    note(`  blocked on: ${suite.blockedOn}`);
    note(`  must not be faked with: ${suite.forbiddenSubstitutes}`);
    note(`  reproduce: ${base.reproduce}`);
    return BLOCKED_EXIT_CODE;
  }

  const started = performance.now();
  // stdio is inherited: child output is never suppressed, so a cited green
  // result always has the run behind it in the same log.
  const child = Bun.spawn({
    cmd: ["bun", "test", ...suite.dirs],
    cwd: PACKAGE_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await child.exited;
  const duration = Math.round(performance.now() - started);

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
