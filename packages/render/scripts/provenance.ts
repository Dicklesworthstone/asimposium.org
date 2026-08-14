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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Repository-relative roots whose bytes decide a spike result. Order is irrelevant; paths sort. */
export const PROVENANCE_INPUTS: readonly string[] = [
  "packages/render/src",
  "packages/render/scripts/s5-spike.ts",
  "packages/render/scripts/provenance.ts",
  "apps/wire/src/render-face",
];

export interface Provenance {
  readonly revision: string;
  readonly revision_state: "clean" | "dirty" | "unknown";
  readonly source_digest: string;
  readonly source_files: number;
}

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
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

/** Every `.ts` file under the provenance inputs, repository-relative and sorted. */
export function provenanceFiles(root: string = repoRoot()): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      return;
    }
    if (stats.isFile()) {
      if (absolute.endsWith(".ts")) found.push(relative(root, absolute));
      return;
    }
    if (!stats.isDirectory()) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true, encoding: "utf8" })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(join(absolute, entry.name));
    }
  };
  for (const input of PROVENANCE_INPUTS) walk(join(root, input));
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
    parts.push(encoder.encode(`${file}\0`));
    parts.push(new Uint8Array(readFileSync(join(root, file))));
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
  return { revision, revision_state, source_digest: digest, source_files: files };
}
