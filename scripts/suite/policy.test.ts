import { describe, expect, test } from "bun:test";
import {
  BASELINE_REQUIRED,
  EXTRA_REQUIRED,
  isSuite,
  orderSuites,
  ROOT_UNITS,
  requiredSuitesFor,
  SUITE_DESCRIPTION,
  SUITE_SCRIPT,
  SUITES,
} from "./policy.ts";

describe("suite policy", () => {
  test("every suite the acceptance criteria names is exposed", () => {
    // OPS.1: typecheck, lint, test:unit, test:contract, test:integration, test:e2e,
    // test:security, test:performance.
    const exposed: string[] = [...SUITES];
    expect(exposed.sort()).toEqual([
      "contract",
      "e2e",
      "integration",
      "lint",
      "performance",
      "security",
      "typecheck",
      "unit",
    ]);
  });

  test("each suite maps to exactly one package script and one description", () => {
    for (const suite of SUITES) {
      expect(SUITE_SCRIPT[suite]).toBeTruthy();
      expect(SUITE_DESCRIPTION[suite].length).toBeGreaterThan(10);
    }
    const scripts = SUITES.map((suite) => SUITE_SCRIPT[suite]);
    expect(new Set(scripts).size).toBe(scripts.length);
  });

  test("script names follow the AGENTS.md entry-point vocabulary", () => {
    expect(SUITE_SCRIPT.typecheck).toBe("typecheck");
    expect(SUITE_SCRIPT.lint).toBe("lint");
    expect(SUITE_SCRIPT.unit).toBe("test:unit");
    expect(SUITE_SCRIPT.contract).toBe("test:contract");
    expect(SUITE_SCRIPT.integration).toBe("test:integration");
    expect(SUITE_SCRIPT.security).toBe("test:security");
    expect(SUITE_SCRIPT.performance).toBe("test:performance");
    expect(SUITE_SCRIPT.e2e).toBe("test:e2e");
  });

  test("orderSuites returns CI doctrine order and de-duplicates", () => {
    expect(orderSuites(["e2e", "typecheck", "unit", "typecheck"])).toEqual([
      "typecheck",
      "unit",
      "e2e",
    ]);
    expect(orderSuites([])).toEqual([]);
  });

  test("isSuite rejects near-misses instead of silently accepting them", () => {
    expect(isSuite("unit")).toBe(true);
    expect(isSuite("test:unit")).toBe(false);
    expect(isSuite("units")).toBe(false);
    expect(isSuite("")).toBe(false);
  });

  test("every code-bearing package owes the baseline gates", () => {
    expect(requiredSuitesFor("packages/anything-new")).toEqual([...BASELINE_REQUIRED]);
    expect(requiredSuitesFor("apps/wire")).toContain("typecheck");
    expect(requiredSuitesFor("apps/wire")).toContain("integration");
    expect(requiredSuitesFor("packages/contracts")).toContain("contract");
  });

  test("the Worker owes the plan's contract, integration, security and budget gates", () => {
    // apps/wire is the single writer (Fable §14.1) and owns the §15 budgets.
    expect([...(EXTRA_REQUIRED["apps/wire"] ?? [])].sort()).toEqual([
      "contract",
      "integration",
      "performance",
      "security",
    ]);
  });

  test("required suites are declared at the root, never derived from a package's own file", () => {
    // Fable §17.0: a feature diff must not be able to relax its own gate. The policy map is
    // keyed by directory, so the only way to change a requirement is a root-owned diff.
    for (const [dir, suites] of Object.entries(EXTRA_REQUIRED)) {
      expect(dir.startsWith("/")).toBe(false);
      expect(suites.length).toBeGreaterThan(0);
      for (const suite of suites) expect(isSuite(suite)).toBe(true);
    }
  });

  test("typecheck, lint and unit always have a root-owned unit so they are never vacuous", () => {
    expect(ROOT_UNITS.typecheck).toBe("toolchain:typecheck");
    expect(ROOT_UNITS.lint).toBe("toolchain:lint");
    expect(ROOT_UNITS.unit).toBe("toolchain:test");
  });
});
