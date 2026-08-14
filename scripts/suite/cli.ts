#!/usr/bin/env bun
/**
 * The ASImposium root suite dispatcher (bead asimposiumorg-8xn, OPS.1).
 *
 * Every root entry point named in the OPS.1 acceptance criteria — typecheck, lint,
 * test:unit, test:contract, test:integration, test:e2e, test:security, test:performance —
 * routes here, and this file routes each one to the real script inside each workspace
 * package. It never invents a passing result:
 *
 *   - a package that carries source code and owes a suite but has no script FAILS
 *     (status "missing"), so a stub cannot stay silently green once it grows code;
 *   - a stub with no source files is reported "skip" with the reason, never "pass";
 *   - child stdout/stderr is streamed, never suppressed;
 *   - dispatcher-authored records carry no absolute paths, no environment values and no
 *     credential-shaped strings.
 *
 * Run `bun run suite --help` for the full contract.
 */

import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import {
  isSuite,
  orderSuites,
  requiredSuitesFor,
  ROOT_UNITS,
  SUITE_DESCRIPTION,
  SUITE_SCRIPT,
  SUITES,
  type Suite,
} from "./policy.ts";
import {
  displayPath,
  formatSummaryLine,
  formatUnitLine,
  redact,
  reproduceCommand,
  serialize,
  type Diagnostic,
  type PlanDiagnostic,
  type SummaryDiagnostic,
  type UnitDiagnostic,
} from "./report.ts";
import { discoverWorkspaces, DiscoveryError, readRootPackage, type Workspace } from "./workspaces.ts";

const TOOL = "bun";
const DEPTH_ENV = "ASIMPOSIUM_SUITE_DEPTH";
const MAX_DEPTH = 2;

interface Options {
  suites: Suite[];
  root: string;
  json: boolean;
  list: boolean;
  bail: boolean;
  requireExecuted: boolean;
}

class UsageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "UsageError";
  }
}

const HELP = `asimposium suite — root workspace suite dispatcher (OPS.1)

USAGE
  bun run suite <suite...> [options]
  bun run <entry-point>            # typecheck | lint | test:unit | test:contract |
                                   # test:integration | test:security |
                                   # test:performance | test:e2e | check

SUITES (run in this CI doctrine order when several are selected)
${SUITES.map((suite) => `  ${suite.padEnd(12)} ${SUITE_DESCRIPTION[suite]}`).join("\n")}

OPTIONS
  --all                    Run every suite in doctrine order.
  --filter <pattern>       Limit to workspaces whose name or directory matches (repeatable,
                           "*" wildcards allowed). Applies to the root toolchain unit too.
  --list                   Print the resolved plan and exit without running anything.
  --json                   NDJSON diagnostics on stdout. Child stdout is forwarded to
                           stderr so stdout stays parseable; nothing is suppressed.
  --require-executed       Fail a suite that executed zero units (use in CI once a suite is
                           expected to exist).
  --bail                   Stop after the first failing unit.
  --root <dir>             Repository root to operate on (default: this repository).
  -h, --help               This text.

HOW A SUITE RESOLVES FOR ONE PACKAGE
  1. package.json defines the suite's script -> run "bun run <script>" in that directory.
  2. no script, package carries source files, and root policy requires the suite ->
     status "missing" and the run fails. Gates are not optional once code exists.
  3. no script and no source files -> status "skip" with reason "no source files yet".
  Required suites are declared at the repository root (scripts/suite/policy.ts) and never
  inside a package, so a feature diff cannot relax its own gate (Fable §17.0).

SCRIPT NAMES EXPECTED IN EACH WORKSPACE PACKAGE
${SUITES.map((suite) => `  ${suite.padEnd(12)} -> "${SUITE_SCRIPT[suite]}"`).join("\n")}

EXIT CODES
  0  every unit passed or was legitimately skipped
  1  at least one unit failed, or a required suite script is missing
  2  usage, policy or preflight error (bad suite name, unreadable root, bun too old)

DIAGNOSTICS
  One record per unit plus a summary per suite: tool, package, suite, version, duration_ms,
  status and a copy-pasteable "reproduce" command. Paths are repository-relative; no
  environment values, secrets or absolute paths are ever written to a record.
`;

function parseArguments(argv: string[], defaultRoot: string): Options | "help" {
  const suites: Suite[] = [];
  const filters: string[] = [];
  let root = defaultRoot;
  let json = false;
  let list = false;
  let bail = false;
  let all = false;
  let requireExecuted = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    switch (argument) {
      case "-h":
      case "--help":
        return "help";
      case "--all":
        all = true;
        break;
      case "--json":
        json = true;
        break;
      case "--list":
        list = true;
        break;
      case "--bail":
        bail = true;
        break;
      case "--require-executed":
        requireExecuted = true;
        break;
      case "--filter": {
        const value = argv[++index];
        if (value === undefined) throw new UsageError("MISSING_VALUE", "--filter needs a pattern");
        filters.push(value);
        break;
      }
      case "--root": {
        const value = argv[++index];
        if (value === undefined) throw new UsageError("MISSING_VALUE", "--root needs a directory");
        root = isAbsolute(value) ? value : resolve(process.cwd(), value);
        break;
      }
      default: {
        if (argument.startsWith("-")) {
          throw new UsageError("UNKNOWN_OPTION", `Unknown option "${argument}". Try --help.`);
        }
        if (!isSuite(argument)) {
          throw new UsageError(
            "UNKNOWN_SUITE",
            `Unknown suite "${argument}". Known suites: ${SUITES.join(", ")}.`,
          );
        }
        suites.push(argument);
      }
    }
  }

  const selected = all ? [...SUITES] : orderSuites(suites);
  if (selected.length === 0) {
    throw new UsageError(
      "NO_SUITE_SELECTED",
      `Name at least one suite, or pass --all. Known suites: ${SUITES.join(", ")}.`,
    );
  }

  return {
    suites: selected,
    root: resolve(root),
    json,
    list,
    bail,
    requireExecuted,
    ...(filters.length > 0 ? { filters } : {}),
  } as Options & { filters?: string[] };
}

function matchesFilter(workspace: { name: string; dir: string }, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((pattern) => {
    const expression = new RegExp(
      `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    );
    return expression.test(workspace.name) || expression.test(workspace.dir);
  });
}

interface PlannedUnit {
  name: string;
  dir: string;
  version: string;
  script: string | undefined;
  action: "run" | "missing" | "skip";
  code: string;
  detail: string | undefined;
}

function planSuite(suite: Suite, root: string, workspaces: Workspace[]): PlannedUnit[] {
  const units: PlannedUnit[] = [];
  const rootPackage = readRootPackage(root);
  const rootScript = ROOT_UNITS[suite];

  if (rootScript !== undefined) {
    const defined = rootScript in rootPackage.scripts;
    units.push({
      name: rootPackage.name,
      dir: ".",
      version: rootPackage.version,
      script: rootScript,
      action: defined ? "run" : "missing",
      code: defined ? "ROOT_TOOLCHAIN_UNIT" : "MISSING_ROOT_SCRIPT",
      detail: defined
        ? undefined
        : `root package.json must define the "${rootScript}" script for suite "${suite}"`,
    });
  }

  for (const workspace of workspaces) {
    const script = SUITE_SCRIPT[suite];
    if (script in workspace.scripts) {
      units.push({
        name: workspace.name,
        dir: workspace.dir,
        version: workspace.version,
        script,
        action: "run",
        code: "PACKAGE_SCRIPT",
        detail: undefined,
      });
      continue;
    }
    const required = workspace.hasSource && requiredSuitesFor(workspace.dir).includes(suite);
    if (required) {
      units.push({
        name: workspace.name,
        dir: workspace.dir,
        version: workspace.version,
        script,
        action: "missing",
        code: "MISSING_SUITE_SCRIPT",
        detail: `package carries source files and owes suite "${suite}"; add a "${script}" script`,
      });
      continue;
    }
    units.push({
      name: workspace.name,
      dir: workspace.dir,
      version: workspace.version,
      script,
      action: "skip",
      code: workspace.hasSource ? "SUITE_NOT_REQUIRED" : "NO_SOURCE_FILES",
      detail: workspace.hasSource
        ? `suite "${suite}" is not required for this package and no "${script}" script exists`
        : "no source files yet",
    });
  }

  return units;
}

async function runUnit(
  unit: PlannedUnit,
  suite: Suite,
  options: Options,
  depth: number,
): Promise<UnitDiagnostic> {
  const script = unit.script as string;
  const command = `bun run ${script}`;
  const startedAt = performance.now();

  const child = Bun.spawn({
    cmd: ["bun", "run", script],
    cwd: unit.dir === "." ? options.root : join(options.root, unit.dir),
    stdin: "inherit",
    stdout: options.json ? "pipe" : "inherit",
    stderr: "inherit",
    env: { ...process.env, [DEPTH_ENV]: String(depth + 1) },
  });

  if (options.json && child.stdout !== undefined) {
    await (child.stdout as ReadableStream<Uint8Array>).pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          process.stderr.write(chunk);
        },
      }),
    );
  }

  const exitCode = await child.exited;
  const durationMs = Math.round(performance.now() - startedAt);
  const signal = child.signalCode ?? undefined;

  return {
    record: "unit",
    tool: TOOL,
    package: unit.name,
    suite,
    version: Bun.version,
    duration_ms: durationMs,
    status: exitCode === 0 ? "pass" : "fail",
    reproduce: reproduceCommand(unit.dir, script),
    dir: unit.dir,
    code: exitCode === 0 ? "SUITE_PASSED" : "SUITE_FAILED",
    package_version: unit.version,
    script,
    command,
    exit_code: exitCode,
    ...(signal !== undefined ? { signal } : {}),
    ...(exitCode === 0
      ? {}
      : { detail: `"${command}" exited ${exitCode}${signal !== undefined ? ` (${signal})` : ""}` }),
  };
}

function nonRunDiagnostic(unit: PlannedUnit, suite: Suite): UnitDiagnostic {
  const script = unit.script as string;
  return {
    record: "unit",
    tool: TOOL,
    package: unit.name,
    suite,
    version: Bun.version,
    duration_ms: 0,
    status: unit.action === "missing" ? "missing" : "skip",
    reproduce: reproduceCommand(unit.dir, script),
    dir: unit.dir,
    code: unit.code,
    package_version: unit.version,
    script,
    ...(unit.detail !== undefined ? { detail: unit.detail } : {}),
  };
}

function emit(diagnostic: Diagnostic, options: Options): void {
  if (options.json) {
    process.stdout.write(`${serialize(diagnostic, options.root)}\n`);
    return;
  }
  if (diagnostic.record === "unit") {
    process.stdout.write(`${formatUnitLine(diagnostic, options.root)}\n`);
    if (diagnostic.status === "fail" || diagnostic.status === "missing") {
      process.stdout.write(
        `         reproduce: ${redact(diagnostic.reproduce, options.root)}\n` +
          (diagnostic.detail !== undefined
            ? `         detail:    ${redact(diagnostic.detail, options.root)}\n`
            : ""),
      );
    }
    return;
  }
  if (diagnostic.record === "summary") {
    process.stdout.write(`${formatSummaryLine(diagnostic, options.root)}\n`);
    return;
  }
  const plan = diagnostic;
  process.stdout.write(
    redact(
      `  ${plan.action.toUpperCase().padEnd(8)} ${plan.package.padEnd(26)} ` +
        `${(plan.dir === "." ? "./" : `./${plan.dir}`).padEnd(22)} ` +
        `${plan.command ?? plan.detail ?? plan.code}\n`,
      options.root,
    ),
  );
}

function preflight(options: Options, depth: number): UnitDiagnostic {
  const rootPackage = readRootPackage(options.root);
  const pinned = rootPackage.packageManager?.startsWith("bun@")
    ? rootPackage.packageManager.slice("bun@".length)
    : undefined;

  const base: Omit<UnitDiagnostic, "status" | "code" | "detail"> = {
    record: "unit",
    tool: TOOL,
    package: rootPackage.name,
    suite: "preflight",
    version: Bun.version,
    duration_ms: 0,
    reproduce: "bun --version",
    dir: ".",
    package_version: rootPackage.version,
  };

  if (depth > MAX_DEPTH) {
    return {
      ...base,
      status: "fail",
      code: "SUITE_RECURSION",
      detail: `dispatcher nested ${depth} deep; a package script is calling the root suite back`,
    };
  }
  if (pinned === undefined) {
    return {
      ...base,
      status: "fail",
      code: "TOOLCHAIN_NOT_PINNED",
      detail: 'root package.json must pin "packageManager": "bun@<version>"',
    };
  }

  const compare = (left: string, right: string): number => {
    const parse = (value: string) =>
      value.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const [a, b] = [parse(left), parse(right)];
    for (let index = 0; index < 3; index += 1) {
      const delta = (a[index] ?? 0) - (b[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  };

  const order = compare(Bun.version, pinned);
  if (order < 0) {
    return {
      ...base,
      status: "fail",
      code: "BUN_VERSION_TOO_OLD",
      detail: `bun ${Bun.version} is older than the pinned bun@${pinned}; upgrade before running gates`,
    };
  }
  return {
    ...base,
    status: "pass",
    code: order === 0 ? "TOOLCHAIN_PINNED" : "BUN_VERSION_NEWER_THAN_PIN",
    ...(order === 0
      ? {}
      : { detail: `bun ${Bun.version} is newer than the pinned bun@${pinned}` }),
  };
}

async function main(argv: string[]): Promise<number> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const defaultRoot = resolve(here, "..", "..");

  let options: Options & { filters?: string[] };
  try {
    const parsed = parseArguments(argv, defaultRoot);
    if (parsed === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    options = parsed as Options & { filters?: string[] };
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const filters = options.filters ?? [];
  const depth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;

  let workspaces: Workspace[];
  let preflightDiagnostic: UnitDiagnostic;
  try {
    preflightDiagnostic = preflight(options, depth);
    workspaces = discoverWorkspaces(options.root).filter((workspace) =>
      matchesFilter(workspace, filters),
    );
  } catch (error) {
    const code = error instanceof DiscoveryError ? error.code : "DISCOVERY_FAILED";
    const message = error instanceof Error ? error.message : "unknown discovery failure";
    process.stderr.write(`${code}: ${redact(message, options.root)}\n`);
    return 2;
  }

  if (!options.list) {
    emit(preflightDiagnostic, options);
    if (preflightDiagnostic.status === "fail") return 2;
  }

  if (!options.json && !options.list) {
    process.stdout.write(
      `asimposium suite · root ${displayPath(options.root, options.root)} · ` +
        `${TOOL} ${Bun.version} · ${workspaces.length} workspace package(s)\n`,
    );
  }

  let failed = false;

  for (const suite of options.suites) {
    const planned = planSuite(suite, options.root, workspaces).filter((unit) =>
      matchesFilter(unit, filters),
    );

    if (options.list) {
      for (const unit of planned) {
        const plan: PlanDiagnostic = {
          record: "plan",
          suite,
          package: unit.name,
          dir: unit.dir,
          action: unit.action,
          code: unit.code,
          ...(unit.script !== undefined ? { script: unit.script } : {}),
          ...(unit.action === "run" && unit.script !== undefined
            ? { command: `bun run ${unit.script}`, reproduce: reproduceCommand(unit.dir, unit.script) }
            : {}),
          ...(unit.detail !== undefined ? { detail: unit.detail } : {}),
        };
        emit(plan, options);
      }
      continue;
    }

    if (!options.json) process.stdout.write(`suite ${suite}\n`);

    const totals = { total: planned.length, executed: 0, pass: 0, fail: 0, missing: 0, skip: 0 };
    const suiteStartedAt = performance.now();
    let bailed = false;

    for (const unit of planned) {
      if (bailed) break;
      let diagnostic: UnitDiagnostic;
      if (unit.action === "run") {
        diagnostic = await runUnit(unit, suite, options, depth);
        totals.executed += 1;
      } else {
        diagnostic = nonRunDiagnostic(unit, suite);
      }
      totals[diagnostic.status] += 1;
      emit(diagnostic, options);
      if (diagnostic.status === "fail" || diagnostic.status === "missing") {
        failed = true;
        if (options.bail) bailed = true;
      }
    }

    const emptyRun = options.requireExecuted && totals.executed === 0;
    if (emptyRun) failed = true;

    const summary: SummaryDiagnostic = {
      record: "summary",
      tool: TOOL,
      package: "asimposium",
      suite,
      version: Bun.version,
      duration_ms: Math.round(performance.now() - suiteStartedAt),
      status: totals.fail + totals.missing === 0 && !emptyRun ? "pass" : "fail",
      reproduce: `bun run suite ${suite}`,
      code: emptyRun
        ? "NO_UNITS_EXECUTED"
        : totals.fail + totals.missing === 0
          ? "SUITE_COMPLETE"
          : "SUITE_INCOMPLETE",
      totals,
      ...(emptyRun
        ? { detail: `--require-executed was set but suite "${suite}" executed no units` }
        : totals.executed === 0
          ? { detail: `suite "${suite}" executed no units; every unit was skipped` }
          : {}),
    };
    emit(summary, options);

    if (bailed) break;
  }

  return failed ? 1 : 0;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
