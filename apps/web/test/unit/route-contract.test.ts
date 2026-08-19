import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import {
  formatViolations,
  readExportSurface,
  validateAgoraPackage,
  WRITE_PATH_EXEMPTIONS,
  type Violation,
  type ViolationCode,
} from "../../scripts/route-contract.ts";

const FIXTURES = join(dirname(import.meta.dir), "fixtures");

function scan(fixture: string): Violation[] {
  return validateAgoraPackage(join(FIXTURES, fixture));
}

function codes(violations: readonly Violation[]): ViolationCode[] {
  return violations.map((v) => v.code).sort();
}

describe("readExportSurface", () => {
  test("resolves function, const, destructured and clause exports", () => {
    const surface = readExportSurface(
      [
        "export function GET() {}",
        "export const dynamic = 'force-dynamic';",
        "export const { POST, PATCH } = handlers;",
        "const DELETE = () => {};",
        "export { DELETE };",
      ].join("\n"),
      "route.ts",
    );
    expect([...surface.names].sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "dynamic"]);
    expect(surface.hasDefault).toBe(false);
  });

  test("ignores type-only exports, which are erased at runtime", () => {
    const surface = readExportSurface(
      [
        "export type Thing = { id: string };",
        "export interface Other { id: string }",
        "type Hidden = number;",
        "export type { Hidden };",
        "export function GET() {}",
      ].join("\n"),
      "route.ts",
    );
    expect([...surface.names]).toEqual(["GET"]);
  });

  test("detects both forms of default export and not `export =`", () => {
    expect(readExportSurface("export default function Page() {}", "page.tsx").hasDefault).toBe(
      true,
    );
    expect(
      readExportSurface("function Page() {}\nexport default Page;", "page.tsx").hasDefault,
    ).toBe(true);
    expect(readExportSurface("declare const x: number;\nexport = x;", "legacy.ts").hasDefault).toBe(
      false,
    );
  });
});

describe("valid tree", () => {
  test("valid-minimal produces no violations", () => {
    const violations = scan("valid-minimal");
    expect(formatViolations(violations)).toBe("no violations");
    expect(violations).toHaveLength(0);
  });
});

describe("planted negatives — each rule must be able to fail", () => {
  test("WRITE_PATH_FORBIDDEN: Agora may not accept a write", () => {
    const violations = scan("invalid-write-path");
    const write = violations.find((v) => v.code === "WRITE_PATH_FORBIDDEN");
    expect(write).toBeDefined();
    expect(write?.rule).toBe("ASI-ONE-WRITER");
    expect(write?.file).toBe("app/api/claims/route.ts");
    // Every mutating method is named, and the read method is not.
    expect(write?.detail).toContain("DELETE, POST");
    expect(write?.detail).not.toContain("GET");
    expect(write?.fix_hint).toContain("a.asimposium.org");
  });

  test("ROUTE_PAGE_COLLISION: a segment is a page or a handler, not both", () => {
    const violations = scan("invalid-route-page-collision");
    expect(codes(violations)).toContain("ROUTE_PAGE_COLLISION");
    const hit = violations.find((v) => v.code === "ROUTE_PAGE_COLLISION");
    expect(hit?.rule).toBe("NEXT-APP-2");
    expect(hit?.file).toBe("app/dashboard/route.ts");
  });

  test("INVALID_ROUTE_EXPORT: route files export methods and config only", () => {
    const violations = scan("invalid-unknown-export");
    const hit = violations.find((v) => v.code === "INVALID_ROUTE_EXPORT");
    expect(hit?.rule).toBe("NEXT-APP-5");
    expect(hit?.file).toBe("app/api/thing/route.ts");
    expect(hit?.detail).toContain("formatThing");
    // The type export is erased and must not be reported.
    expect(violations.filter((v) => v.detail.includes("`Thing`"))).toHaveLength(0);
  });

  test("MISSING_ROOT_LAYOUT: the App Router requires a root layout", () => {
    const violations = scan("invalid-missing-root-layout");
    const hit = violations.find((v) => v.code === "MISSING_ROOT_LAYOUT");
    expect(hit?.rule).toBe("NEXT-APP-1");
    expect(hit?.file).toBe("app/layout.tsx");
  });

  test("DUPLICATE_DYNAMIC_SEGMENT: siblings must share one slug name", () => {
    const violations = scan("invalid-duplicate-dynamic");
    const hit = violations.find((v) => v.code === "DUPLICATE_DYNAMIC_SEGMENT");
    expect(hit?.rule).toBe("NEXT-APP-6");
    expect(hit?.file).toBe("app/p");
    expect(hit?.detail).toContain("id, slug");
  });

  test("PAGES_ROUTER_FORBIDDEN: the stack table forbids the Pages Router", () => {
    const violations = scan("invalid-pages-router");
    const hit = violations.find((v) => v.code === "PAGES_ROUTER_FORBIDDEN");
    expect(hit?.rule).toBe("ASI-STACK-1");
    expect(hit?.file).toBe("pages");
  });

  test("EMPTY_ROUTE_HANDLERS: a route file with no method 405s", () => {
    const violations = scan("invalid-empty-handlers");
    const hit = violations.find((v) => v.code === "EMPTY_ROUTE_HANDLERS");
    expect(hit?.rule).toBe("NEXT-APP-4");
    expect(hit?.file).toBe("app/api/empty/route.ts");
  });

  test("MISSING_DEFAULT_EXPORT: pages must have something to render", () => {
    const violations = scan("invalid-missing-default-export");
    const hit = violations.find((v) => v.code === "MISSING_DEFAULT_EXPORT");
    expect(hit?.rule).toBe("NEXT-APP-3");
    expect(hit?.file).toBe("app/about/page.tsx");
  });

  test("MISSING_APP_DIR: a package with no app/ is not an Agora", () => {
    const violations = validateAgoraPackage(join(FIXTURES, "does-not-exist"));
    expect(codes(violations)).toEqual(["MISSING_APP_DIR"]);
  });
});

describe("reported paths", () => {
  test("no violation ever carries an absolute path", () => {
    const fixtures = [
      "invalid-write-path",
      "invalid-route-page-collision",
      "invalid-unknown-export",
      "invalid-missing-root-layout",
      "invalid-duplicate-dynamic",
      "invalid-pages-router",
      "invalid-empty-handlers",
      "invalid-missing-default-export",
    ];
    for (const fixture of fixtures) {
      const violations = scan(fixture);
      expect(violations.length).toBeGreaterThan(0);
      for (const v of violations) {
        expect(v.file.startsWith("/")).toBe(false);
        expect(v.file).not.toContain(FIXTURES);
        expect(v.file).not.toContain("\\");
      }
    }
  });
});

describe("write-path exemptions", () => {
  test("the only exemption is the Auth.js endpoint, with its reason", () => {
    expect([...WRITE_PATH_EXEMPTIONS.keys()]).toEqual(["app/api/auth/[...nextauth]/route.ts"]);
    const reason = WRITE_PATH_EXEMPTIONS.get("app/api/auth/[...nextauth]/route.ts");
    expect(reason).toContain("session cookie");
    expect(reason).toContain("never reaches D1");
  });
});
