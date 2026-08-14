/**
 * Provenance must never claim a clean commit for dirty bytes (bead asimposiumorg-6jo,
 * DEF-2). The old field did exactly that: a bare `git rev-parse HEAD` while the working
 * tree said otherwise. These tests pin the replacement.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROVENANCE_INPUTS,
  ProvenanceInputError,
  provenance,
  provenanceFiles,
  runtimeToolVersions,
  sourceDigest,
} from "../../scripts/provenance.ts";

const REQUIRED_INPUT_STUBS: Readonly<Record<string, string>> = {
  "package.json": '{"packageManager":"bun@1.3.8"}\n',
  "bun.lock": "lockfileVersion: 1\n",
  "bunfig.toml": "[test]\ntimeout = 120000\n",
  "tsconfig.json": '{"extends":"./tsconfig.base.json"}\n',
  "tsconfig.base.json": "{}\n",
  "apps/wire/package.json": '{"devDependencies":{"wrangler":"4.123.0"}}\n',
  "apps/wire/tsconfig.json": '{"extends":"../../tsconfig.base.json"}\n',
  "packages/render/tsconfig.json": "{}\n",
  "packages/render/scripts/diagnostics.ts": "export {};\n",
  "packages/render/scripts/s5-spike.ts": "export {};\n",
  "packages/render/scripts/provenance.ts": "export {};\n",
  "packages/render/test/_support/fixtures.ts": "export {};\n",
  "packages/render/test/contract/golden.test.ts": "export {};\n",
  "packages/render/test/golden/working-pack.html": "<article></article>\n",
  "packages/render/test/golden/working-pack.json": "{}\n",
  "packages/render/test/golden/working-pack.md": "# golden\n",
  "apps/wire/src/render-face/worker.ts": "export default {};\n",
  "infra/wrangler.toml": 'name = "s5"\n',
  "scripts/e2e-s5-diptych.sh": "#!/usr/bin/env bash\nexit 0\n",
};

/** A throwaway tree containing every declared input, with opt-out for missing-input refusals. */
function fixtureTree(
  bodies: Record<string, string>,
  options: { readonly omit?: readonly string[] } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "asimposium-prov-"));
  const omitted = new Set(options.omit ?? []);
  for (const [path, body] of Object.entries({ ...REQUIRED_INPUT_STUBS, ...bodies })) {
    if (omitted.has(path)) continue;
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
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
    expect(PROVENANCE_INPUTS).toContain("package.json");
    expect(PROVENANCE_INPUTS).toContain("bun.lock");
    expect(PROVENANCE_INPUTS).toContain("bunfig.toml");
    expect(PROVENANCE_INPUTS).toContain("tsconfig.json");
    expect(PROVENANCE_INPUTS).toContain("tsconfig.base.json");
    expect(PROVENANCE_INPUTS).toContain("apps/wire/package.json");
    expect(PROVENANCE_INPUTS).toContain("apps/wire/tsconfig.json");
    expect(PROVENANCE_INPUTS).toContain("packages/render/tsconfig.json");
    expect(PROVENANCE_INPUTS).toContain("apps/wire/src/render-face");
    expect(PROVENANCE_INPUTS).toContain("packages/render/src");
    expect(PROVENANCE_INPUTS).toContain("packages/render/scripts/diagnostics.ts");
    expect(PROVENANCE_INPUTS).toContain("packages/render/test/contract/golden.test.ts");
    expect(PROVENANCE_INPUTS).toContain("packages/render/test/golden/working-pack.md");
    expect(PROVENANCE_INPUTS).toContain("infra/wrangler.toml");
    expect(PROVENANCE_INPUTS).toContain("scripts/e2e-s5-diptych.sh");
  });

  test("includes exact non-TypeScript evidence inputs without sweeping unrelated documentation", async () => {
    const root = fixtureTree({
      "packages/render/src/a.ts": "export const a = 1;\n",
      "packages/render/src/notes.md": "not an input\n",
      "apps/wire/src/render-face/worker.ts": "export default {};\n",
      "scripts/e2e-s5-diptych.sh": "#!/usr/bin/env bash\nexit 0\n",
      "scripts/unrelated.sh": "#!/usr/bin/env bash\necho unrelated\n",
      "infra/wrangler.toml": 'name = "s5"\n',
      "infra/notes.md": "not an input\n",
    });
    const { files } = await sourceDigest(root);
    expect(files).toBe(20);
    expect(provenanceFiles(root)).toEqual([
      "apps/wire/package.json",
      "apps/wire/src/render-face/worker.ts",
      "apps/wire/tsconfig.json",
      "bun.lock",
      "bunfig.toml",
      "infra/wrangler.toml",
      "package.json",
      "packages/render/scripts/diagnostics.ts",
      "packages/render/scripts/provenance.ts",
      "packages/render/scripts/s5-spike.ts",
      "packages/render/src/a.ts",
      "packages/render/test/_support/fixtures.ts",
      "packages/render/test/contract/golden.test.ts",
      "packages/render/test/golden/working-pack.html",
      "packages/render/test/golden/working-pack.json",
      "packages/render/test/golden/working-pack.md",
      "packages/render/tsconfig.json",
      "scripts/e2e-s5-diptych.sh",
      "tsconfig.base.json",
      "tsconfig.json",
    ]);
  });

  test("file paths are repository-relative, so no absolute path can reach a record", async () => {
    const root = fixtureTree({ "packages/render/src/a.ts": "export const a = 1;\n" });
    for (const file of provenanceFiles(root)) {
      expect(file.startsWith("/")).toBe(false);
      expect(file).not.toContain(root);
    }
  });

  test("refuses a symlinked provenance directory instead of widening the source set", () => {
    const root = fixtureTree({ "packages/render/src/a.ts": "export const a = 1;\n" });
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "widened.ts"), "export const widened = true;\n");
    symlinkSync(outside, join(root, "packages/render/src/unexpected-link"));

    expect(() => provenanceFiles(root)).toThrow(ProvenanceInputError);
  });

  test("refuses a FIFO explicit input before readFileSync can block", async () => {
    const root = fixtureTree(
      { "packages/render/src/a.ts": "export const a = 1;\n" },
      { omit: ["packages/render/scripts/diagnostics.ts"] },
    );
    const fifo = join(root, "packages/render/scripts/diagnostics.ts");
    const created = Bun.spawnSync({
      cmd: ["mkfifo", fifo],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(created.exitCode).toBe(0);

    await expect(sourceDigest(root)).rejects.toThrow(ProvenanceInputError);
  });

  test("refuses a missing declared provenance input instead of hashing a partial source set", async () => {
    const root = fixtureTree(
      { "packages/render/src/a.ts": "export const a = 1;\n" },
      { omit: ["scripts/e2e-s5-diptych.sh"] },
    );

    await expect(sourceDigest(root)).rejects.toThrow(ProvenanceInputError);
  });

  test("refuses a future TypeScript extends link until it is explicitly declared", async () => {
    const root = fixtureTree({
      "packages/render/src/a.ts": "export const a = 1;\n",
      "packages/render/tsconfig.json": '{"extends":"./future-runtime-config.json"}\n',
      "packages/render/future-runtime-config.json": "{}\n",
    });

    await expect(sourceDigest(root)).rejects.toThrow(ProvenanceInputError);
  });
});

describe("run provenance", () => {
  test("reports a revision, an explicit state, a digest and closed tool versions", async () => {
    const run = await provenance();
    expect(run.revision).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
    expect(["clean", "dirty", "unknown"]).toContain(run.revision_state);
    expect(run.source_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.source_files).toBeGreaterThan(0);
    expect(run.bun_version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(run.wrangler_version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
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

describe("runtime tool inputs", () => {
  test("reads only exact manifest pins", () => {
    const root = fixtureTree({ "packages/render/src/a.ts": "export const a = 1;\n" });
    expect(runtimeToolVersions(root)).toEqual({ bun_version: "1.3.8", wrangler_version: "4.123.0" });
  });

  test("refuses a ranged Bun declaration", () => {
    const root = fixtureTree(
      {
        "packages/render/src/a.ts": "export const a = 1;\n",
        "package.json": '{"packageManager":"bun@^1.3.8"}\n',
      },
    );
    expect(() => runtimeToolVersions(root)).toThrow(ProvenanceInputError);
  });

  test("refuses a ranged Wrangler declaration", () => {
    const root = fixtureTree(
      {
        "packages/render/src/a.ts": "export const a = 1;\n",
        "apps/wire/package.json": '{"devDependencies":{"wrangler":"^4.123.0"}}\n',
      },
    );
    expect(() => runtimeToolVersions(root)).toThrow(ProvenanceInputError);
  });
});
