import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureRepo } from "./fixtures.ts";
import {
  DiscoveryError,
  discoverWorkspaces,
  hasSourceFiles,
  readRootPackage,
} from "./workspaces.ts";

describe("root package reading", () => {
  test("reads the pin, the globs and the scripts that gate execution depends on", () => {
    const root = makeFixtureRepo({ rootScripts: { "toolchain:test": "bun -e ''" } });
    const rootPackage = readRootPackage(root);
    expect(rootPackage.packageManager).toBe("bun@1.3.8");
    expect(rootPackage.workspaces).toContain("apps/*");
    expect(rootPackage.scripts["toolchain:test"]).toBe("bun -e ''");
  });

  test("an unreadable root is a typed error, not a silent empty workspace list", () => {
    expect(() => readRootPackage(join(makeFixtureRepo(), "nowhere"))).toThrow(DiscoveryError);
  });

  test("malformed JSON reports where it failed instead of throwing a bare SyntaxError", () => {
    const root = makeFixtureRepo();
    writeFileSync(join(root, "package.json"), "{ not json ");
    try {
      readRootPackage(root);
      throw new Error("expected a DiscoveryError");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryError);
      expect((error as DiscoveryError).code).toBe("ROOT_PACKAGE_UNREADABLE");
    }
  });
});

describe("workspace discovery", () => {
  test("expands the real globs from package.json and orders results deterministically", () => {
    const root = makeFixtureRepo({
      packages: [
        { dir: "packages/render", name: "@fixture/render" },
        { dir: "apps/wire", name: "@fixture/wire" },
        { dir: "apps/web", name: "@fixture/web" },
      ],
    });
    const discovered = discoverWorkspaces(root).map((workspace) => workspace.dir);
    expect(discovered).toEqual(["apps/web", "apps/wire", "packages/render"]);
    expect(discoverWorkspaces(root).map((w) => w.dir)).toEqual(discovered);
  });

  test("nested workspaces such as e2e and e2e/gauntlet are both discovered", () => {
    const root = makeFixtureRepo({
      packages: [
        { dir: "e2e", name: "@fixture/e2e" },
        { dir: "e2e/gauntlet", name: "@fixture/gauntlet" },
      ],
    });
    expect(discoverWorkspaces(root).map((w) => w.dir)).toEqual(["e2e", "e2e/gauntlet"]);
  });

  test("a directory without a package.json is not a workspace", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "apps/web" }] });
    mkdirSync(join(root, "apps", "not-a-package"), { recursive: true });
    expect(discoverWorkspaces(root).map((w) => w.dir)).toEqual(["apps/web"]);
  });

  test("installed dependencies are never mistaken for workspace packages", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "apps/web" }] });
    const nested = join(root, "apps", "node_modules", "left-pad");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), '{"name":"left-pad","version":"1.0.0"}');
    expect(discoverWorkspaces(root).map((w) => w.name)).toEqual(["@fixture/apps-web"]);
  });

  test("scripts and versions are carried through so the dispatcher can route to them", () => {
    const root = makeFixtureRepo({
      packages: [
        {
          dir: "apps/wire",
          version: "1.2.3",
          scripts: { "test:unit": "bun test", lint: "oxlint" },
        },
      ],
    });
    const [workspace] = discoverWorkspaces(root);
    expect(workspace?.version).toBe("1.2.3");
    expect(workspace?.scripts["test:unit"]).toBe("bun test");
    expect(workspace?.scripts.lint).toBe("oxlint");
  });
});

describe("source detection: the trigger that turns gates on", () => {
  test("a package.json-only stub carries no source", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "packages/protocol" }] });
    expect(hasSourceFiles(join(root, "packages/protocol"))).toBe(false);
    expect(discoverWorkspaces(root)[0]?.hasSource).toBe(false);
  });

  test("a README and a JSON config are documentation, not code", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "packages/protocol" }] });
    const dir = join(root, "packages/protocol");
    writeFileSync(join(dir, "README.md"), "# protocol\n");
    writeFileSync(join(dir, "tsconfig.json"), "{}\n");
    expect(hasSourceFiles(dir)).toBe(false);
  });

  test("one source file anywhere in the package turns its gates on", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "packages/render", source: true }] });
    expect(discoverWorkspaces(root)[0]?.hasSource).toBe(true);
  });

  test("source found only inside build output or dependencies does not count", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "apps/web" }] });
    const dir = join(root, "apps/web");
    for (const ignored of ["node_modules/dep", "dist", ".next/static", "coverage"]) {
      mkdirSync(join(dir, ignored), { recursive: true });
      writeFileSync(join(dir, ignored, "index.js"), "module.exports = 1;\n");
    }
    expect(hasSourceFiles(dir)).toBe(false);
  });

  test("every source extension the monorepo can contain is recognised", () => {
    for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      const root = makeFixtureRepo({ packages: [{ dir: "apps/web" }] });
      writeFileSync(join(root, "apps/web", `file.${extension}`), "export {};\n");
      expect(hasSourceFiles(join(root, "apps/web"))).toBe(true);
    }
  });

  test("a missing directory is reported as sourceless rather than throwing", () => {
    expect(hasSourceFiles(join(makeFixtureRepo(), "does-not-exist"))).toBe(false);
  });

  test("a symlinked directory is not followed, so code cannot be borrowed from outside", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "packages/protocol", source: true }] });
    const consumer = makeFixtureRepo({ packages: [{ dir: "packages/empty" }] });
    // The link target really does carry source, so the assertion below is not vacuous.
    expect(hasSourceFiles(join(root, "packages/protocol"))).toBe(true);
    symlinkSync(join(root, "packages/protocol/src"), join(consumer, "packages/empty/src"), "dir");
    expect(hasSourceFiles(join(consumer, "packages/empty"))).toBe(false);
  });

  test("a symlink loop terminates instead of hanging the walk", () => {
    const root = makeFixtureRepo({ packages: [{ dir: "packages/empty" }] });
    const dir = join(root, "packages/empty");
    mkdirSync(join(dir, "inner"), { recursive: true });
    symlinkSync(dir, join(dir, "inner", "loop"), "dir");
    expect(hasSourceFiles(dir)).toBe(false);
  });
});
