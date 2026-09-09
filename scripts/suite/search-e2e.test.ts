import { describe, expect, test } from "bun:test";
import { runAllSearchE2EAssertions } from "./search-e2e";

describe("W6.8 Public Search E2E Suite", () => {
  test("all 19 search E2E assertions pass against real local D1 schema", async () => {
    const summary = await runAllSearchE2EAssertions();
    for (const r of summary.results) {
      if (!r.passed) {
        console.error(`Search assertion failed: ${r.name} - ${r.error}`);
      }
    }
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThanOrEqual(19);
    expect(summary.total).toBeGreaterThanOrEqual(19);
  });
});
