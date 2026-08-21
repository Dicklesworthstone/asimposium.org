import { describe, expect, test } from "bun:test";

import { firstCyclicEdge, wouldCreateCycle, type ClaimDepEdge } from "../../src/krater/claim-deps.ts";

const edge = (claimId: string, dependsOnClaimId: string): ClaimDepEdge => ({ claimId, dependsOnClaimId });

describe("P10 claim-dependency cycle check", () => {
  test("a self-dependency is a cycle", () => {
    expect(wouldCreateCycle([], "C-1", "C-1")).toBe(true);
  });

  test("a linear chain is clean", () => {
    const existing = [edge("C-2", "C-1"), edge("C-3", "C-2")];
    expect(wouldCreateCycle(existing, "C-4", "C-3")).toBe(false);
  });

  test("an edge that closes a loop is detected", () => {
    const existing = [edge("C-2", "C-1"), edge("C-3", "C-2")];
    // C-1 depends on C-3 would close C-1 -> C-3 -> C-2 -> C-1.
    expect(wouldCreateCycle(existing, "C-1", "C-3")).toBe(true);
  });

  test("a diamond is clean (two paths to one root are not a cycle)", () => {
    const existing = [edge("C-2", "C-1"), edge("C-3", "C-1"), edge("C-4", "C-2"), edge("C-4", "C-3")];
    expect(wouldCreateCycle(existing, "C-5", "C-4")).toBe(false);
  });

  test("firstCyclicEdge names the first offender across a proposed set", () => {
    const existing = [edge("C-2", "C-1")];
    const proposed = [edge("C-3", "C-2"), edge("C-1", "C-3")];
    const offender = firstCyclicEdge(existing, proposed);
    expect(offender).toEqual(edge("C-1", "C-3"));
  });

  test("a clean proposed set passes", () => {
    const existing = [edge("C-2", "C-1")];
    const proposed = [edge("C-3", "C-2"), edge("C-4", "C-3")];
    expect(firstCyclicEdge(existing, proposed)).toBeNull();
  });
});
