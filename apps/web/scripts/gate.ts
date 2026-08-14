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
 * Suites without an implementation exit non-zero with `status:"not_implemented"`
 * and the bead that must land first. They are deliberately excluded from the
 * default `bun run test` aggregate: a red gate that nothing can turn green is
 * noise, and a green gate that ran nothing is a lie. `test:<suite>` tells the
 * truth when asked directly.
 *
 *   bun run typecheck | lint | test | test:unit | test:contract
 *   bun run test:integration | test:e2e | test:security | test:performance
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildGateRecord,
  formatGateRecord,
  type GateStatus,
} from "./gate-record.ts";

const PACKAGE_DIR = dirname(import.meta.dir);

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
    argv: ["bun", "test", "test/unit"],
  },
  contract: {
    kind: "run",
    tool: "bun test",
    versionFrom: "bun",
    argv: ["bun", "test", "test/contract"],
  },
  integration: {
    kind: "not_implemented",
    tool: "none",
    blockedOn: "asimposiumorg-233",
    note: "Agora integration tests need the shared harness (OPS.2a) and a Worker to talk to (W4/W6). No mocks of D1 or R2 are permitted as a substitute.",
  },
  e2e: {
    kind: "not_implemented",
    tool: "none",
    blockedOn: "asimposiumorg-233",
    note: "Human E2E lives in e2e/ (Playwright against staging, mock-free) and needs W3 sign-in plus W8 pages. Not in this package's scope at OPS.1.",
  },
  security: {
    kind: "not_implemented",
    tool: "none",
    blockedOn: "asimposiumorg-233",
    note: "Web security suite (CSP, XSS corpus, cache-leak paired tests — Fable §14.3) needs rendered pages and a session; W8/W10.",
  },
  performance: {
    kind: "not_implemented",
    tool: "none",
    blockedOn: "asimposiumorg-233",
    note: "Agora performance budgets are measured against real problem pages and OG rendering; W8/W10.",
  },
};

const REPRO: Record<string, string> = {
  typecheck: "bun run --filter @asimposium/web typecheck",
  lint: "bun run --filter @asimposium/web lint",
  unit: "bun run --filter @asimposium/web test:unit",
  contract: "bun run --filter @asimposium/web test:contract",
  integration: "bun run --filter @asimposium/web test:integration",
  e2e: "bun run --filter @asimposium/web test:e2e",
  security: "bun run --filter @asimposium/web test:security",
  performance: "bun run --filter @asimposium/web test:performance",
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
  process.exit(64);
}

const spec = GATES[suite] as GateSpec;

if (spec.kind === "not_implemented") {
  emit(suite, spec.tool, "n/a", "not_implemented", 2, 0, {
    blockedOn: spec.blockedOn,
    note: spec.note,
  });
  console.error(
    `gate '${suite}' has no implementation in this package yet (blocked on ${spec.blockedOn}). ${spec.note}`,
  );
  process.exit(2);
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

emit(
  suite,
  spec.tool,
  version,
  exitCode === 0 ? "pass" : "fail",
  exitCode,
  durationMs,
);

process.exit(exitCode);
