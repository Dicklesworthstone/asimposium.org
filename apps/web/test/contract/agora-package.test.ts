/**
 * Contract suite: the shipped `apps/web` package, not a fixture.
 *
 * The unit suite proves each rule *can* fire. This suite points the same rules
 * at the real tree, so a future commit that adds a write path to Agora, brings
 * back the Pages Router, widens the Auth.js cookie to the whole domain, or
 * drops a gate entry point turns `bun run test:contract` red.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  formatViolations,
  validateAgoraPackage,
  WRITE_PATH_EXEMPTIONS,
} from "../../scripts/route-contract.ts";

const PACKAGE_DIR = dirname(dirname(import.meta.dir));

function readPackageFile(relativePath: string): string {
  return readFileSync(join(PACKAGE_DIR, relativePath), "utf8");
}

describe("app router + one-writer contract, against the real tree", () => {
  test("apps/web satisfies every route-contract rule", () => {
    const violations = validateAgoraPackage(PACKAGE_DIR);
    // formatViolations first: a failure should read as the rule, not a diff.
    expect(formatViolations(violations)).toBe("no violations");
  });

  test("every declared write-path exemption still exists on disk", () => {
    for (const relativePath of WRITE_PATH_EXEMPTIONS.keys()) {
      expect(existsSync(join(PACKAGE_DIR, relativePath))).toBe(true);
    }
  });

  test("the app tree contains no Pages Router directory", () => {
    expect(existsSync(join(PACKAGE_DIR, "pages"))).toBe(false);
    expect(existsSync(join(PACKAGE_DIR, "src", "pages"))).toBe(false);
  });
});

describe("Propylon cookie shape (Fable §14.1) — source-level guard", () => {
  const authSource = readPackageFile("auth.ts");

  test("the sponsor session cookie is host-only: no domain is configured", () => {
    // A `domain` key here would send the sponsor cookie to a.asimposium.org,
    // which is exactly the cross-plane confusion WRONG_PRINCIPAL exists for.
    const cookieBlock = authSource.slice(authSource.indexOf("cookies:"));
    expect(cookieBlock).not.toMatch(/^\s*domain\s*:/m);
  });

  test("Google is the only configured provider", () => {
    expect(authSource).toContain("next-auth/providers/google");
    const providerImports = authSource.match(/from "next-auth\/providers\/\w+"/g);
    expect(providerImports).toHaveLength(1);
  });

  test("no credential is read at module scope", () => {
    // Auth.js resolves AUTH_* from the environment itself; reading secrets here
    // would bake them into a build artifact.
    const secretReads = authSource.match(/process\.env\[?["']?AUTH_/g);
    expect(secretReads).toBeNull();
  });
});

describe("OPS.1 gate entry points", () => {
  const manifest = JSON.parse(readPackageFile("package.json")) as {
    name: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  test("every suite named by the acceptance criteria is invocable", () => {
    for (const script of [
      "typecheck",
      "lint",
      "test",
      "test:unit",
      "test:contract",
      "test:integration",
      "test:e2e",
      "test:security",
      "test:performance",
    ]) {
      expect(manifest.scripts[script]).toBeDefined();
    }
  });

  test("toolchain versions are pinned exactly, not floated", () => {
    const allDeps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const [name, range] of Object.entries(allDeps)) {
      expect(`${name}@${range}`).toMatch(/@\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });

  test("the stack table is respected: App Router, Tailwind, Auth.js v5", () => {
    expect(manifest.dependencies["next"]).toMatch(/^16\./);
    expect(manifest.dependencies["next-auth"]).toMatch(/^5\./);
    expect(manifest.devDependencies["tailwindcss"]).toMatch(/^4\./);
    expect(readPackageFile("postcss.config.mjs")).toContain(
      "@tailwindcss/postcss",
    );
    expect(readPackageFile("app/globals.css")).toContain(
      '@import "tailwindcss"',
    );
  });
});
