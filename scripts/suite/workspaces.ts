/**
 * Workspace discovery for the root suite dispatcher (bead asimposiumorg-8xn, OPS.1).
 *
 * Discovery reads the real `workspaces` globs out of the root package.json, so the
 * dispatcher can never drift from what `bun install` actually links.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { SCAN_IGNORED_DIRECTORIES, SOURCE_EXTENSIONS } from "./policy.ts";

export interface RootPackage {
  name: string;
  version: string;
  packageManager: string | undefined;
  workspaces: string[];
  scripts: Record<string, string>;
}

export interface Workspace {
  /** package.json "name" (falls back to the directory when a stub omits it). */
  name: string;
  /** Repository-relative POSIX directory. The repository root itself is ".". */
  dir: string;
  version: string;
  scripts: Record<string, string>;
  /** True once the package carries at least one source file: the moment it owes gates. */
  hasSource: boolean;
}

export class DiscoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DiscoveryError";
  }
}

function readJsonFile(absolutePath: string, code: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch {
    throw new DiscoveryError(code, `Cannot read ${absolutePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new DiscoveryError(code, `Cannot parse ${absolutePath}: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DiscoveryError(code, `${absolutePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  // npm also allows { workspaces: { packages: [...] } }; accept it so discovery never lies.
  if (typeof value === "object" && value !== null) {
    const packages = (value as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
}

export function readRootPackage(root: string): RootPackage {
  const parsed = readJsonFile(join(root, "package.json"), "ROOT_PACKAGE_UNREADABLE");
  return {
    name: typeof parsed.name === "string" ? parsed.name : "root",
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
    packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
    workspaces: stringArray(parsed.workspaces),
    scripts: stringRecord(parsed.scripts),
  };
}

function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

/** Expand one workspace pattern into the package.json paths it matches. */
function matchManifests(root: string, pattern: string): string[] {
  const normalized = pattern.replace(/\/+$/, "");
  const glob = new Bun.Glob(`${normalized}/package.json`);
  const matches: string[] = [];
  for (const match of glob.scanSync({ cwd: root, onlyFiles: true, dot: false })) {
    const posix = toPosix(match);
    if (posix.split("/").includes("node_modules")) continue;
    matches.push(posix);
  }
  return matches;
}

/**
 * Every workspace package linked by the root package.json globs, ordered by directory so
 * two runs at the same revision produce byte-identical plans.
 */
export function discoverWorkspaces(root: string): Workspace[] {
  const rootPackage = readRootPackage(root);
  const seen = new Map<string, Workspace>();

  for (const pattern of rootPackage.workspaces) {
    for (const manifest of matchManifests(root, pattern)) {
      const dir = manifest.slice(0, manifest.length - "/package.json".length) || ".";
      if (seen.has(dir)) continue;
      const parsed = readJsonFile(join(root, manifest), "WORKSPACE_PACKAGE_UNREADABLE");
      seen.set(dir, {
        name: typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : dir,
        dir,
        version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
        scripts: stringRecord(parsed.scripts),
        hasSource: hasSourceFiles(join(root, dir)),
      });
    }
  }

  return [...seen.values()].sort((left, right) => left.dir.localeCompare(right.dir));
}

/**
 * True when the directory carries at least one source file. A package.json plus a README
 * is a stub and owes nothing; the first `.ts` file in it turns every required suite on.
 */
export function hasSourceFiles(absoluteDir: string, maxDepth = 8): boolean {
  let budget = 20_000;

  const walk = (dir: string, depth: number): boolean => {
    if (depth > maxDepth || budget <= 0) return false;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return false;
    }
    const subdirectories: string[] = [];
    for (const entry of entries) {
      if (budget-- <= 0) return false;
      // isDirectory() is false for symlinks, so the walk never follows a link out of the
      // package (or into node_modules through one) and cannot be sent in a circle.
      if (entry.isDirectory()) {
        if (SCAN_IGNORED_DIRECTORIES.includes(entry.name)) continue;
        subdirectories.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot <= 0) continue;
      if (SOURCE_EXTENSIONS.includes(entry.name.slice(dot))) return true;
    }
    for (const subdirectory of subdirectories) {
      if (walk(subdirectory, depth + 1)) return true;
    }
    return false;
  };

  try {
    if (!statSync(absoluteDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return walk(absoluteDir, 0);
}
