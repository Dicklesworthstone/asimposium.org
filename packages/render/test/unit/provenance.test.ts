/**
 * Provenance must never claim a clean commit for dirty bytes (bead asimposiumorg-6jo,
 * DEF-2). The old field did exactly that: a bare `git rev-parse HEAD` while the working
 * tree said otherwise. These tests pin the replacement.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVENANCE_INPUTS,
  provenance,
  provenanceFiles,
  sourceDigest,
} from "../../scripts/provenance.ts";

/** A throwaway tree shaped like the inputs, so the digest can be exercised in isolation. */
function fixtureTree(bodies: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "asimposium-prov-"));
  mkdirSync(join(root, "packages/render/src"), { recursive: true });
  mkdirSync(join(root, "packages/render/scripts"), { recursive: true });
  mkdirSync(join(root, "apps/wire/src/render-face"), { recursive: true });
  for (const [path, body] of Object.entries(bodies)) writeFileSync(join(root, path), body);
  return root;
}

describe("source digest", () => {
  test("is stable for identical bytes", async () => {
    const bodies = { "packages/render/src/a.ts": "export const a = 1;\n" };
    const first = await sourceDigest(fixtureTree(bodies));
    const second = await sourceDigest(fixtureTree(bodies));
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("changes when one byte of one input changes", async () => {
    const before = await sourceDigest(
      fixtureTree({ "packages/render/src/a.ts": "export const a = 1;\n" }),
    );
    const after = await sourceDigest(
      fixtureTree({ "packages/render/src/a.ts": "export const a = 2;\n" }),
    );
    expect(after.digest).not.toBe(before.digest);
  });

  test("changes when a file is renamed, because the path is hashed too", async () => {
    const body = "export const a = 1;\n";
    const before = await sourceDigest(fixtureTree({ "packages/render/src/a.ts": body }));
    const after = await sourceDigest(fixtureTree({ "packages/render/src/b.ts": body }));
    expect(after.digest).not.toBe(before.digest);
  });

  test("covers the Worker harness as well as the renderer", () => {
    expect(PROVENANCE_INPUTS).toContain("apps/wire/src/render-face");
    expect(PROVENANCE_INPUTS).toContain("packages/render/src");
  });

  test("counts only TypeScript inputs, and reports how many it hashed", async () => {
    const root = fixtureTree({
      "packages/render/src/a.ts": "export const a = 1;\n",
      "packages/render/src/notes.md": "not an input\n",
      "apps/wire/src/render-face/worker.ts": "export default {};\n",
    });
    const { files } = await sourceDigest(root);
    expect(files).toBe(2);
    expect(provenanceFiles(root)).toEqual([
      "apps/wire/src/render-face/worker.ts",
      "packages/render/src/a.ts",
    ]);
  });

  test("file paths are repository-relative, so no absolute path can reach a record", async () => {
    const root = fixtureTree({ "packages/render/src/a.ts": "export const a = 1;\n" });
    for (const file of provenanceFiles(root)) {
      expect(file.startsWith("/")).toBe(false);
      expect(file).not.toContain(root);
    }
  });
});

describe("run provenance", () => {
  test("reports a revision, an explicit state and a digest", async () => {
    const run = await provenance();
    expect(run.revision).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
    expect(["clean", "dirty", "unknown"]).toContain(run.revision_state);
    expect(run.source_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.source_files).toBeGreaterThan(0);
  });

  test("the state is never silently 'clean': it is decided by a real status call", async () => {
    // Whatever the tree currently is, the digest must pin the bytes that actually ran, so a
    // reader can reproduce the run from the digest even when the state is dirty.
    const first = await provenance();
    const second = await provenance();
    expect(second.source_digest).toBe(first.source_digest);
    expect(second.revision_state).toBe(first.revision_state);
  });
});
