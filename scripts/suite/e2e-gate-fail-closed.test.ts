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
