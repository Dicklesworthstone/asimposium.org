import { describe, expect, test } from "bun:test";

import {
  assertSecretSafe,
  buildDiagnostic,
  DiagnosticSafetyError,
  formatDiagnostic,
  type SuiteDiagnostic,
} from "../../scripts/diagnostics.ts";

function record(overrides: Partial<SuiteDiagnostic> = {}): SuiteDiagnostic {
  return {
    ...buildDiagnostic({
      package: "render",
      suite: "unit",
      target: "test/unit",
      duration_ms: 12,
      exit_code: 0,
      tool_version: "1.3.8",
      runtime: "bun-1.3.8",
    }),
    ...overrides,
  };
}

describe("buildDiagnostic", () => {
  test("answers tool, package, suite, version, duration, status and repro", () => {
    const built = record();
    expect(built.tool).toBe("bun test");
    expect(built.package).toBe("render");
    expect(built.suite).toBe("unit");
    expect(built.tool_version).toBe("1.3.8");
    expect(built.duration_ms).toBe(12);
    expect(built.status).toBe("pass");
    expect(built.repro).toBe("cd packages/render && bun test test/unit");
  });

  test("derives status from the real exit code rather than assuming success", () => {
    expect(
      buildDiagnostic({
        package: "render",
        suite: "unit",
        target: "test/unit",
        duration_ms: 1,
        exit_code: 1,
        tool_version: "1.3.8",
        runtime: "bun-1.3.8",
      }).status,
    ).toBe("fail");
  });
});

describe("assertSecretSafe", () => {
  test("accepts a repo-relative record", () => {
    expect(() => assertSecretSafe(record(), {})).not.toThrow();
  });

  test("refuses a local absolute path in the reproduction command", () => {
    expect(() =>
      assertSecretSafe(record({ repro: "cd /Users/someone/projects/x && bun test" }), {}),
    ).toThrow(DiagnosticSafetyError);
  });

  test("refuses a Windows absolute path", () => {
    expect(() => assertSecretSafe(record({ repro: "cd C:\\work\\x && bun test" }), {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("refuses a Fellow token prefix anywhere in the record", () => {
    expect(() => assertSecretSafe(record({ suite: "unit asimp_ag_abc123" }), {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("refuses an enrollment fragment secret", () => {
    expect(() => assertSecretSafe(record({ suite: "join#v1.s3cr3t" }), {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("refuses the value of a sensitive environment variable", () => {
    const env = { ASI_SERVICE_TOKEN: "supersecretvalue" };
    expect(() => assertSecretSafe(record({ runtime: "bun-1.3.8 supersecretvalue" }), env)).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("ignores short or non-sensitive environment values", () => {
    const env = { HOME_LABEL: "workstation", ASI_TOKEN: "abc" };
    expect(() =>
      assertSecretSafe(record({ runtime: "bun-1.3.8 workstation abc" }), env),
    ).not.toThrow();
  });
});

describe("formatDiagnostic", () => {
  test("emits one key-sorted NDJSON line", () => {
    const line = formatDiagnostic(record());
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line) as SuiteDiagnostic;
    expect(parsed.repro).toBe("cd packages/render && bun test test/unit");
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });
});
