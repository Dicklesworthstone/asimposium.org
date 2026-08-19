#!/usr/bin/env bun
/**
 * Quality-gate runner for `@asimposium/web`.
 *
 * One entry point per suite named in the OPS.1 acceptance criteria. Each run
 * streams the underlying tool's stdout *and stderr* through untouched — a gate
 * that hides stderr is not evidence — and then prints one `ASIMP-GATE` record
 * (see `gate-record.ts`) carrying tool, package, suite, version, duration,
 * status, and a reproduction command.
 *
 * A suite this package owes but cannot yet honestly run exits non-zero with
 * `status:"not_implemented"` and the bead that must land first. It is excluded
 * from the default `bun run test` aggregate: a red gate that nothing can turn
 * green is noise, and a green gate that ran nothing is a lie. `test:security`
 * tells the truth when asked directly.
 *
 * A suite this package does NOT owe gets no script at all — see the note on
 * GATES below.
 *
 *   bun run typecheck | lint | test | test:unit | test:contract | test:security
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildGateRecord, formatGateRecord, type GateStatus } from "./gate-record.ts";

const PACKAGE_DIR = dirname(import.meta.dir);

/**
 * Exit code for a gate that is declared, owed, and honestly unimplemented.
 *
 * 78 is sysexits' EX_CONFIG, and the point is that it is *distinguishable*: a
 * root dispatcher must be able to tell "this gate is blocked on something
 * named" from "this gate ran and found a regression". A real test failure
 * passes the tool's own exit code through untouched, which for `bun test` and
 * `tsc` and `eslint` is 1 (or 2 for a tsc diagnostic). Collapsing the two into
 * one code is how a blocker gets mistaken for a bug and vice versa.
 */
const BLOCKED_EXIT_CODE = 78;

/** Usage error: the caller named a gate that does not exist. */
const USAGE_EXIT_CODE = 64;

type GateSpec =
  | {
      kind: "run";
      tool: string;
      /** npm package the version is read from, or "bun" for the runtime. */
      versionFrom: string;
      argv: readonly string[];
    }
  | {
      kind: "not_implemented";
      tool: string;
      blockedOn: string;
      note: string;
    };

const GATES: Record<string, GateSpec> = {
  typecheck: {
    kind: "run",
    tool: "tsc",
    versionFrom: "typescript",
    argv: ["tsc", "--noEmit"],
  },
  lint: {
    kind: "run",
    tool: "eslint",
    versionFrom: "eslint",
    // Warnings are failures: a gate that tolerates them stops being a gate.
    argv: ["eslint", ".", "--max-warnings", "0"],
  },
  unit: {
    kind: "run",
    tool: "bun test",
    versionFrom: "bun",
    argv: ["bun", "test", "/dev/null", "--timeout=120000", "test/unit"],
  },
  contract: {
    kind: "run",
    tool: "bun test",
    versionFrom: "bun",
    argv: ["bun", "test", "/dev/null", "--timeout=120000", "test/contract"],
  },
  // `security` is the only extra suite root policy assigns to apps/web
  // (scripts/suite/policy.ts). It is declared and unimplemented, and says so.
  //
  // integration / e2e / performance are deliberately absent: this package does
  // not owe them, and declaring a script the dispatcher would then execute
  // turned three root suites permanently red for no coverage. Human E2E against
  // staging lives in `e2e/` (Playwright + the Cold-Agent Gauntlet), which owns
  // the `e2e` suite; Agora's integration and budget work arrives with W8/W10
  // and will be declared here when there is something real to run.
  security: {
    kind: "not_implemented",
    tool: "none",
    blockedOn: "asimposiumorg-233",
    note: "Web security suite (CSP, XSS corpus, cache-leak paired tests — Fable §14.3) needs rendered pages and a session; W8/W10.",
  },
};

const REPRO: Record<string, string> = {
  typecheck: "bun run --filter @asimposium/web typecheck",
  lint: "bun run --filter @asimposium/web lint",
  unit: "bun run --filter @asimposium/web test:unit",
  contract: "bun run --filter @asimposium/web test:contract",
  security: "bun run --filter @asimposium/web test:security",
};

/**
 * Read a dependency's version without depending on hoisting layout: the
 * package may be installed locally (standalone clone) or hoisted to the
 * workspace root (bun workspaces).
 */
function toolVersion(packageName: string): string {
  if (packageName === "bun") return Bun.version;
  const candidates = [
    join(PACKAGE_DIR, "node_modules", packageName, "package.json"),
    join(PACKAGE_DIR, "..", "..", "node_modules", packageName, "package.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof (parsed as { version: unknown }).version === "string"
      ) {
        return (parsed as { version: string }).version;
      }
    } catch {
      // Fall through to the next candidate.
    }
  }
  return "unknown";
}

/** Make both possible `.bin` directories visible regardless of invocation. */
function binPath(): string {
  const extra = [
    join(PACKAGE_DIR, "node_modules", ".bin"),
    join(PACKAGE_DIR, "..", "..", "node_modules", ".bin"),
  ];
  return [...extra, process.env["PATH"] ?? ""].join(":");
}

function emit(
  suite: string,
  tool: string,
  version: string,
  status: GateStatus,
  exitCode: number,
  durationMs: number,
  extra: { blockedOn?: string; note?: string } = {},
): void {
  const record = buildGateRecord(
    {
      suite,
      tool,
      toolVersion: version,
      status,
      exitCode,
      durationMs,
      repro: REPRO[suite] ?? `bun run --filter @asimposium/web test:${suite}`,
      ...extra,
    },
    { runner: "bun", runnerVersion: Bun.version },
  );
  console.log(formatGateRecord(record));
}

const suite = process.argv[2];

if (suite === undefined || !(suite in GATES)) {
  console.error(
    `unknown gate '${suite ?? ""}'. known gates: ${Object.keys(GATES).sort().join(", ")}`,
  );
  process.exit(USAGE_EXIT_CODE);
}

const spec = GATES[suite] as GateSpec;

if (spec.kind === "not_implemented") {
  emit(suite, spec.tool, "n/a", "not_implemented", BLOCKED_EXIT_CODE, 0, {
    blockedOn: spec.blockedOn,
    note: spec.note,
  });
  console.error(
    `gate '${suite}' has no implementation in this package yet (blocked on ${spec.blockedOn}). ${spec.note}`,
  );
  process.exit(BLOCKED_EXIT_CODE);
}

const version = toolVersion(spec.versionFrom);
const started = performance.now();

const child = Bun.spawnSync({
  cmd: [...spec.argv],
  cwd: PACKAGE_DIR,
  // stdout and stderr are inherited: tool output reaches the caller verbatim.
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, PATH: binPath() },
});

const durationMs = performance.now() - started;
const exitCode = child.exitCode ?? 1;

emit(suite, spec.tool, version, exitCode === 0 ? "pass" : "fail", exitCode, durationMs);

process.exit(exitCode);
