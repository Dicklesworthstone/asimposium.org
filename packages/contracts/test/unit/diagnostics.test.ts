import { expect, test } from "bun:test";

import { REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";

test("structured diagnostics carry required fields without the current location", () => {
  const serialized = safeDiagnostic({
    suite: "diagnostics.safe-output",
    status: "invalid",
    startedAt: performance.now(),
    code: "STALE_FIXTURE_ACCEPTED",
    reproduce: REPRODUCE.unit,
  });
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    throw new Error(
      safeDiagnostic({
        suite: "diagnostics.safe-output",
        status: "invalid",
        startedAt: performance.now(),
        code: "DIAGNOSTIC_JSON_INVALID",
        reproduce: REPRODUCE.unit,
      }),
    );
  }

  expect(record.tool).toBe("bun");
  expect(record.package).toBe("@asimposium/contracts");
  expect(record.suite).toBe("diagnostics.safe-output");
  expect(record.version).toBe("0.0.0");
  expect(record.status).toBe("invalid");
  expect(record.reproduce).toBe(REPRODUCE.unit);
  expect(record.duration_ms).toEqual(expect.any(Number));
  expect(serialized).not.toContain(process.cwd());
});
