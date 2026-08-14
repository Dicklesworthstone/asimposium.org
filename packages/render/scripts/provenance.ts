/**
 * Run provenance for the S-5 spike (bead asimposiumorg-6jo, DEF-2).
 *
 * A bare `git rev-parse HEAD` in a diagnostic record is a claim the record cannot keep: it
 * names a commit while the bytes that ran may be anything the working tree currently holds.
 * A reviewer reading `revision: 5353f0c` in a build log has no way to tell the two apart,
 * and provenance that can silently be wrong is worse than none.
 *
 * So a record carries three things instead of one:
 *   - `revision`      the commit HEAD points at, or "unknown" off a checkout;
 *   - `revision_state` "clean" or "dirty", decided by `git status --porcelain` over exactly
 *                      the inputs below — never assumed;
 *   - `source_digest`  SHA-256 over the exact renderer and spike sources that ran, which
 *                      pins the bytes whether or not the tree is clean.
 *
 * `source_digest` is the load-bearing field. `revision` is context.
 */

import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Repository-relative roots whose bytes decide a spike result. Order is irrelevant; paths sort. */
export const PROVENANCE_INPUTS: readonly string[] = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "tsconfig.base.json",
  "apps/wire/package.json",
  "apps/wire/tsconfig.json",
  "packages/render/tsconfig.json",
  "packages/render/src",
  "packages/render/scripts/diagnostics.ts",
  "packages/render/scripts/s5-spike.ts",
  "packages/render/scripts/provenance.ts",
  "packages/render/test/_support/fixtures.ts",
  "packages/render/test/contract/golden.test.ts",
  "packages/render/test/golden/working-pack.html",
  "packages/render/test/golden/working-pack.json",
  "packages/render/test/golden/working-pack.md",
  "apps/wire/src/render-face",
  "infra/wrangler.toml",
  "scripts/e2e-s5-diptych.sh",
];

export interface Provenance {
  readonly revision: string;
  readonly revision_state: "clean" | "dirty" | "unknown";
  readonly source_digest: string;
  readonly source_files: number;
  /** Exact Bun release declared by the lockfile-owning repository package manifest. */
  readonly bun_version: string;
  /** Exact Wrangler release declared by the unmounted S-5 Worker harness manifest. */
  readonly wrangler_version: string;
}

export interface RuntimeToolVersions {
  readonly bun_version: string;
  readonly wrangler_version: string;
}

/** An input that cannot be read without widening or blocking the evidence boundary. */
export class ProvenanceInputError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`refusing unsafe provenance input ${path}: ${reason}`);
    this.name = "ProvenanceInputError";
  }
}

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Read one executable input without following a symlink or opening a FIFO. Runtime version
 * declarations are part of the evidence boundary, so they receive the same no-follow,
 * regular-file treatment as the bytes eventually hashed by `sourceDigest`.
 */
function readRequiredRegularText(root: string, path: string): string {
  const absolute = join(root, path);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    if (isMissing(error)) throw new ProvenanceInputError(path, "declared input is missing");
    throw new ProvenanceInputError(path, "could not inspect input");
  }
  if (stats.isSymbolicLink()) throw new ProvenanceInputError(path, "symbolic links are not inputs");
  if (!stats.isFile()) throw new ProvenanceInputError(path, "entry is not a regular file");

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if (!fstatSync(descriptor).isFile())
      throw new ProvenanceInputError(path, "opened entry is not a regular file");
    return new TextDecoder().decode(readFileSync(descriptor));
  } catch (error) {
    if (error instanceof ProvenanceInputError) throw error;
    throw new ProvenanceInputError(path, "could not open regular input");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requiredJsonObject(root: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readRequiredRegularText(root, path));
  } catch (error) {
    if (error instanceof ProvenanceInputError) throw error;
    throw new ProvenanceInputError(path, "is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProvenanceInputError(path, "is not a JSON object");
  return value as Record<string, unknown>;
}

const TSCONFIG_INPUTS = [
  "tsconfig.json",
  "packages/render/tsconfig.json",
  "apps/wire/tsconfig.json",
] as const;

/**
 * A TypeScript `extends` file changes the emitted/runtime program just as surely as a source
 * file. Every discovered relative link must therefore already be an explicit provenance
 * input; a future config chain cannot silently fall outside the digest.
 */
function assertDeclaredTsconfigExtends(root: string): void {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const config = requiredJsonObject(root, path);
    const extendsValue = config.extends;
    if (extendsValue === undefined) return;
    if (typeof extendsValue !== "string" || !extendsValue.startsWith("."))
      throw new ProvenanceInputError(
        path,
        "extends must name an explicit relative provenance input",
      );
    const candidate = extendsValue.endsWith(".json") ? extendsValue : `${extendsValue}.json`;
    const target = relative(root, resolve(root, dirname(path), candidate));
    if (target === "" || target.startsWith("..") || !PROVENANCE_INPUTS.includes(target)) {
      throw new ProvenanceInputError(path, "extends target is not a declared provenance input");
    }
    visit(target);
  };
  for (const path of TSCONFIG_INPUTS) visit(path);
}

/**
 * The runner may invoke only the exact Bun and Wrangler releases declared by the executable
 * source set. Range declarations would make a green record depend on a mutable installer
 * decision, so they are refused rather than normalized.
 */
export function runtimeToolVersions(root: string = repoRoot()): RuntimeToolVersions {
  const rootPackage = requiredJsonObject(root, "package.json");
  const packageManager = rootPackage.packageManager;
  const bunMatch = typeof packageManager === "string" ? /^bun@(.+)$/.exec(packageManager) : null;
  if (bunMatch === null || !EXACT_SEMVER.test(bunMatch[1] ?? ""))
    throw new ProvenanceInputError(
      "package.json",
      "packageManager must pin bun to an exact version",
    );

  const wirePackage = requiredJsonObject(root, "apps/wire/package.json");
  const devDependencies = wirePackage.devDependencies;
  const wrangler =
    devDependencies !== null &&
    typeof devDependencies === "object" &&
    !Array.isArray(devDependencies)
      ? (devDependencies as Record<string, unknown>).wrangler
      : undefined;
  if (typeof wrangler !== "string" || !EXACT_SEMVER.test(wrangler))
    throw new ProvenanceInputError(
      "apps/wire/package.json",
      "devDependencies.wrangler must be an exact version",
    );
  return { bun_version: bunMatch[1] as string, wrangler_version: wrangler };
}

function git(args: string[]): { ok: boolean; out: string } {
  const child = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: child.exitCode === 0, out: new TextDecoder().decode(child.stdout).trim() };
}

/**
 * Executable provenance inputs, repository-relative and sorted.
 *
 * Directory inputs contribute TypeScript sources. Exact input files may use another
 * extension when they are invoked configuration or checked golden bytes. That admits the
 * named shell harness without accidentally pulling arbitrary documentation or shell files
 * from a broad directory into the evidence set.
 */
export function provenanceFiles(root: string = repoRoot()): string[] {
  assertDeclaredTsconfigExtends(root);
  const found: string[] = [];
  const walk = (absolute: string, explicitFile: boolean, requiredInput: boolean): void => {
    const path = relative(root, absolute);
    let stats: ReturnType<typeof lstatSync>;
    try {
      // `stat` follows a symlink, which lets a directory input silently widen the evidence
      // set. `lstat` is the no-follow boundary: every path is classified before traversal.
      stats = lstatSync(absolute);
    } catch (error) {
      // Only descendants of an existing declared directory may be absent. A declared root is
      // a required executable evidence input: silently skipping it would mint a digest for an
      // incomplete source set.
      if (isMissing(error) && !requiredInput) return;
      if (isMissing(error)) throw new ProvenanceInputError(path, "declared input is missing");
      throw new ProvenanceInputError(path, "could not inspect input");
    }
    if (stats.isSymbolicLink())
      throw new ProvenanceInputError(path, "symbolic links are not inputs");
    if (stats.isFile()) {
      if (absolute.endsWith(".ts") || explicitFile) {
        found.push(path);
      }
      return;
    }
    if (!stats.isDirectory())
      throw new ProvenanceInputError(path, "entry is not a regular file or directory");
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(absolute, { withFileTypes: true, encoding: "utf8" });
    } catch {
      throw new ProvenanceInputError(path, "could not read directory");
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(join(absolute, entry.name), false, false);
    }
  };
  for (const input of PROVENANCE_INPUTS) walk(join(root, input), true, true);
  return found.sort();
}

/**
 * SHA-256 over `path\0bytes\0` for each input file in sorted order. Path is included so a
 * rename is a different digest, and the separator keeps concatenation unambiguous.
 */
export async function sourceDigest(
  root: string = repoRoot(),
): Promise<{ digest: string; files: number }> {
  const files = provenanceFiles(root);
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const file of files) {
    const absolute = join(root, file);
    // Recheck immediately before read. This rejects a FIFO or a later symlink replacement
    // before `readFileSync` can block or follow it.
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink())
      throw new ProvenanceInputError(file, "symbolic links are not inputs");
    if (!stats.isFile()) throw new ProvenanceInputError(file, "entry is not a regular file");
    let descriptor: number | undefined;
    let bytes: Uint8Array;
    try {
      // O_NONBLOCK means a just-replaced FIFO cannot stall this process; O_NOFOLLOW keeps a
      // symlink replacement from escaping the lstat boundary between classification and read.
      descriptor = openSync(
        absolute,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      if (!fstatSync(descriptor).isFile())
        throw new ProvenanceInputError(file, "opened entry is not a regular file");
      bytes = new Uint8Array(readFileSync(descriptor));
    } catch (error) {
      if (error instanceof ProvenanceInputError) throw error;
      throw new ProvenanceInputError(file, "could not open regular input");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    parts.push(encoder.encode(`${file}\0`));
    parts.push(bytes);
    parts.push(encoder.encode("\0"));
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.byteLength;
  }
  const hashed = await crypto.subtle.digest("SHA-256", buffer);
  const hex = Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return { digest: `sha256:${hex}`, files: files.length };
}

/** Provenance for the current run. Never reports "clean" without having checked. */
export async function provenance(root: string = repoRoot()): Promise<Provenance> {
  const head = git(["rev-parse", "--short", "HEAD"]);
  const revision = head.ok && /^[0-9a-f]{7,40}$/.test(head.out) ? head.out : "unknown";

  // Ask only about the inputs that decide the result: a dirty file elsewhere in the
  // repository does not make *this* render unreproducible, and saying so would cry wolf.
  const status = git(["status", "--porcelain", "--", ...PROVENANCE_INPUTS]);
  const revision_state: Provenance["revision_state"] =
    revision === "unknown" || !status.ok ? "unknown" : status.out === "" ? "clean" : "dirty";

  const { digest, files } = await sourceDigest(root);
  return {
    revision,
    revision_state,
    source_digest: digest,
    source_files: files,
    ...runtimeToolVersions(root),
  };
}
