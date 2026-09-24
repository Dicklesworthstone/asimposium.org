import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Observed defect (2026-09-24, asimposiumorg-1c09): five e2e gates wrapped their
// real-bindings run in `if [[ -f <test> ]]`, so deleting or renaming the real
// test turned the gate silently green. A gate must fail when its test is missing.
const scripts = resolve(import.meta.dir, "..");
const SKIP_IF_MISSING =
  /if\s+\[\[\s+-[fe]\s+[^\]]*test\/integration\/[^\]]*\]\]\s*;\s*then\s*\n\s*if\s+!/;

describe("e2e gates fail closed when their real-bindings test is missing", () => {
  const gates = readdirSync(scripts).filter((name) => /^e2e-.*\.sh$/.test(name));

  test("there are gates to check", () => {
    expect(gates.length).toBeGreaterThan(10);
  });

  test("no gate skips its real-bindings run when the test file is absent", () => {
    const offenders = gates.filter((name) =>
      SKIP_IF_MISSING.test(readFileSync(join(scripts, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("the detector recognises the pattern it guards against", () => {
    const planted = [
      "if [[ -f apps/wire/test/integration/x-real-bindings.mjs ]]; then",
      '  if ! "$node_binary" apps/wire/test/integration/x-real-bindings.mjs; then',
      "    exit 1",
      "  fi",
      "fi",
    ].join("\n");
    expect(SKIP_IF_MISSING.test(planted)).toBe(true);
    const failClosed = [
      "if [[ ! -f apps/wire/test/integration/x-real-bindings.mjs ]]; then",
      "  exit 1",
      "fi",
    ].join("\n");
    expect(SKIP_IF_MISSING.test(failClosed)).toBe(false);
  });
});

// Shim census (asimposiumorg-1c09). 22 feature beads were closed on suites that
// ran bun:sqlite, module mocks, stubbed fetch or pure functions while their
// acceptance required real bindings. Every *-e2e.ts suite must declare its proof
// level in proof-levels.json, and the declaration must match what it uses.
describe("e2e suites declare an honest proof level", () => {
  const suiteDir = resolve(import.meta.dir);
  const levels = JSON.parse(readFileSync(join(suiteDir, "proof-levels.json"), "utf8")) as Record<
    string,
    string
  >;
  const suites = readdirSync(suiteDir).filter((name) => name.endsWith("-e2e.ts"));
  const SHIM =
    /from "bun:sqlite"|mock\.module\(|globalThis\.fetch\s*=|spyOn\(globalThis, "fetch"\)/;
  const REAL = /real-bindings|createTestHarness|wrangler/;

  test("every suite is declared", () => {
    expect(suites.filter((name) => !(name in levels))).toEqual([]);
    expect(
      Object.keys(levels).filter((name) => name !== "$comment" && !suites.includes(name)),
    ).toEqual([]);
  });

  test("a suite using shims is never declared real", () => {
    const wrong = suites.filter(
      (name) =>
        SHIM.test(readFileSync(join(suiteDir, name), "utf8")) && levels[name] !== "in-process",
    );
    expect(wrong).toEqual([]);
  });

  test("a suite declared real actually drives a real lane", () => {
    const wrong = suites.filter(
      (name) => levels[name] === "real" && !REAL.test(readFileSync(join(suiteDir, name), "utf8")),
    );
    expect(wrong).toEqual([]);
  });

  test("the census detects a shim suite mislabelled real", () => {
    const planted = 'import { Database } from "bun:sqlite";';
    expect(SHIM.test(planted)).toBe(true);
  });
});
