/**
 * Root-owned suite policy for the ASImposium monorepo (bead asimposiumorg-8xn, OPS.1).
 *
 * This file is the single place that decides which suites exist, which order they run in,
 * and which workspace packages owe which suite. It deliberately lives at the repository
 * root and not inside any package: per Fable §17.0 ("gate diffs are never incidental"),
 * a package must not be able to relax its own gate inside a feature diff.
 */

/** Every suite the root exposes as an entry point, in CI doctrine order (Fable §13.3). */
export const SUITES = [
  "typecheck",
  "lint",
  "unit",
  "contract",
  "integration",
  "security",
  "performance",
  "e2e",
] as const;

export type Suite = (typeof SUITES)[number];

/** The package.json script each suite invokes inside a workspace package. */
export const SUITE_SCRIPT: Readonly<Record<Suite, string>> = {
  typecheck: "typecheck",
  lint: "lint",
  unit: "test:unit",
  contract: "test:contract",
  integration: "test:integration",
  security: "test:security",
  performance: "test:performance",
  e2e: "test:e2e",
};

/** One line per suite, printed by `--help`, so an arriving agent needs no external doc. */
export const SUITE_DESCRIPTION: Readonly<Record<Suite, string>> = {
  typecheck: "TypeScript compile check for every workspace package.",
  lint: "Lint and format check (Biome at the root; packages may run their own).",
  unit: "Fast in-process tests with no network, no D1, no browser.",
  contract: "Golden corpus + generated schema + face snapshot agreement (Fable §16.2).",
  integration: "Real bindings, no mocks of D1/R2 (AGENTS.md 'Testing And Verification').",
  security: "Auth boundary, injection, cache-leak and secret-handling checks (Fable §14).",
  performance: "Budget checks from Fable §15 (pack composition, cursor, deltas).",
  e2e: "Playwright human plane and the Cold-Agent Gauntlet (Fable §16.1, §16.3).",
};

/**
 * The one exit code a package script uses to say "this gate is deliberately blocked on
 * named future work", as distinct from "this gate ran and something is broken".
 *
 * Without it the dispatcher had exactly one non-zero meaning, so a package honestly
 * refusing to fake a gate it cannot yet satisfy — no D1 namespace, no staging origin, no
 * measured budget — was reported identically to a package whose tests are red. The
 * ambiguity runs both ways, and the second direction is the dangerous one: a real
 * regression landing inside an already-red suite changes nothing a reader can see.
 *
 * 78 is `EX_CONFIG` from sysexits(3) — "something was unconfigured or unavailable in the
 * environment" — which is exactly the claim a blocked gate makes. It lives here, at the
 * root, for the same reason the required-suite table does (Fable §17.0): a package must
 * not be able to redefine the meaning of its own gate inside a feature diff.
 *
 * A blocked unit is never green. The run still exits non-zero, and the record still
 * carries the reproduction command and the child's own detail.
 */
export const BLOCKED_EXIT_CODE = 78;

/** Owed by every workspace package that contains source code. */
export const BASELINE_REQUIRED: readonly Suite[] = ["typecheck", "lint", "unit"];

/**
 * Extra suites owed by specific workspaces, keyed by repository-relative directory.
 * Derived from the plan, not from convenience:
 *  - packages/contracts, packages/render: the golden corpus and the face snapshots (§16.2).
 *  - apps/wire: the only writer; owes contract, real-binding integration, security and the
 *    §15 performance budgets.
 *  - apps/web: the cross-plane auth and cache-privacy surface (§14.1, §14.3).
 *  - e2e, e2e/gauntlet: the flagship Cold-Agent Gauntlet and the human plane (§16.1).
 *
 * Deliberately NOT required yet: the §16.3 synthetic-Fellow load run under e2e. It cannot
 * be satisfied honestly until a deployed staging Worker exists (W10), and a required gate
 * whose only cheap satisfaction is a stub that exits 0 manufactures exactly the false
 * assurance Fable §17.0 forbids. The entry point still runs it the moment e2e defines
 * "test:performance".
 */
export const EXTRA_REQUIRED: Readonly<Record<string, readonly Suite[]>> = {
  "packages/contracts": ["contract"],
  "packages/render": ["contract"],
  "apps/wire": ["contract", "integration", "security", "performance"],
  "apps/web": ["security"],
  e2e: ["e2e"],
  "e2e/gauntlet": ["e2e"],
};

/**
 * Root-owned units. These run from the repository root for suites where the toolchain
 * itself is under test, so `typecheck`, `lint` and `unit` are never vacuously green on a
 * repository whose packages are still stubs.
 */
export const ROOT_UNITS: Readonly<Partial<Record<Suite, string>>> = {
  typecheck: "toolchain:typecheck",
  lint: "toolchain:lint",
  unit: "toolchain:test",
  integration: "toolchain:integration",
};

/** File extensions that make a workspace package "code-bearing" and therefore gate-owing. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  ".sh",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Directories never scanned when deciding whether a package carries source code. */
export const SCAN_IGNORED_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".wrangler",
  ".turbo",
  ".vercel",
  "coverage",
  "target",
  "artifacts",
];

export function isSuite(value: string): value is Suite {
  return (SUITES as readonly string[]).includes(value);
}

/** Suites a package at `dir` owes once it carries source code. */
export function requiredSuitesFor(dir: string): readonly Suite[] {
  const extra = EXTRA_REQUIRED[dir] ?? [];
  return [...BASELINE_REQUIRED, ...extra];
}

/** Sort an arbitrary suite selection into CI doctrine order, removing duplicates. */
export function orderSuites(selection: readonly Suite[]): Suite[] {
  return SUITES.filter((suite) => selection.includes(suite));
}
