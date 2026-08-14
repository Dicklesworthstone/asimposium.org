/**
 * Fixture repositories for the suite dispatcher's own tests (bead asimposiumorg-8xn).
 *
 * These build real directories with real package.json files on disk and the tests run the
 * real CLI against them as a child process. Nothing here mocks the dispatcher; the only
 * thing "fake" is the repository under test, which is the point: it lets a deliberately
 * failing package be proven to fail without that defect ever entering this repository.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BLOCKED_EXIT_CODE } from "./policy.ts";

export interface FixturePackage {
  dir: string;
  name?: string;
  scripts?: Record<string, string>;
  /** Write a source file, which is what makes the package owe its required suites. */
  source?: boolean;
  version?: string;
}

export interface FixtureSpec {
  rootScripts?: Record<string, string>;
  packages?: FixturePackage[];
  /** null omits the pin entirely, which the dispatcher must reject. */
  packageManager?: string | null;
  workspaces?: string[];
}

/** A command that exits 0 without touching the network or the filesystem. */
export const PASS_COMMAND = 'bun -e "process.exit(0)"';

/** A command that writes to stderr and exits nonzero: the planted negative. */
export function failCommand(exitCode = 1): string {
  return `bun -e "console.error('planted failure'); process.exit(${exitCode})"`;
}

/**
 * A command that names its blocker on stderr and exits with the root-owned blocked code,
 * which is how a package says "this gate is deliberately unsatisfiable today".
 */
export function blockedCommand(): string {
  return (
    `bun -e "console.error('blocked on asimposiumorg-fixture: no namespace exists yet');` +
    ` process.exit(${BLOCKED_EXIT_CODE})"`
  );
}

/** A command that records that it ran, so `--list` can be proven not to execute anything. */
export function markerCommand(markerPath: string): string {
  return `bun -e 'require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")'`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Create a throwaway repository under the OS temp directory and return its absolute path. */
export function makeFixtureRepo(spec: FixtureSpec = {}): string {
  const root = mkdtempSync(join(tmpdir(), "asimposium-suite-"));
  const packageManager = spec.packageManager === undefined ? "bun@1.3.8" : spec.packageManager;

  writeJson(join(root, "package.json"), {
    name: "fixture-root",
    version: "0.0.0",
    private: true,
    ...(packageManager === null ? {} : { packageManager }),
    workspaces: spec.workspaces ?? ["apps/*", "packages/*", "e2e*", "e2e/*"],
    scripts: spec.rootScripts ?? {},
  });

  for (const entry of spec.packages ?? []) {
    const absolute = join(root, entry.dir);
    writeJson(join(absolute, "package.json"), {
      name: entry.name ?? `@fixture/${entry.dir.replace(/\//g, "-")}`,
      version: entry.version ?? "0.0.0",
      private: true,
      scripts: entry.scripts ?? {},
    });
    if (entry.source === true) {
      mkdirSync(join(absolute, "src"), { recursive: true });
      writeFileSync(join(absolute, "src", "index.ts"), "export const present = true;\n");
    }
  }

  return root;
}
