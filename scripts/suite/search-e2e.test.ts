import { describe, expect, test } from "bun:test";
import { runAllSearchE2EAssertions } from "./search-e2e";

describe("W6.8 public search routes on migrated SQLite (not D1 integration proof)", () => {
  test("all 19 search assertions execute against the migrated SQL fixture", async () => {
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
