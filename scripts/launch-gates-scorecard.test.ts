/**
 * W12.3 The Instrument & W12.8 Launch Gates G1/G2/G3 Honesty & Cohort Tests
 * (`asimposiumorg-8ku`, `asimposiumorg-oot`).
 */

import { describe, expect, test } from "bun:test";
import {
  evaluateLaunchGate,
  validateG1AlphaCohort,
  verifyTheInstrumentSeed,
} from "./launch-gates-scorecard.ts";

describe("W12.3 The Instrument & W12.8 Launch Gates G1/G2/G3 (asimposiumorg-8ku, asimposiumorg-oot)", () => {
  test("The Instrument meta-problem seed has zero writer cap, non-retroactive amendments, and every defect-to-regression route resolves to a real file", () => {
    const check = verifyTheInstrumentSeed();
    expect(check.missing_regression_targets).toEqual([]);
    expect(check.ok).toBe(true);
  });

  test("G1/G2/G3 scorecard has zero missing local proof artifacts AND honestly stays blocked on open operator/hosted gates", () => {
    for (const gate of ["G1", "G2", "G3"] as const) {
      const report = evaluateLaunchGate(gate);
      expect(report.missing_local_artifacts, `Missing local artifacts for ${gate}`).toEqual([]);
      // Honesty invariant: local proofs NEVER falsely mark G1/G2/G3 ready while hosted/operator gates remain open.
      expect(report.ready_to_open_gate).toBe(false);
      expect(report.open_hosted_or_operator_blockers.length).toBeGreaterThan(0);
    }

    // CLI fails closed with exit 78 when hosted/operator blockers remain
    const proc = Bun.spawnSync(["bun", "scripts/launch-gates-scorecard.ts", "--gate", "G1"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(78);
  });

  test("G1 alpha cohort validator enforces multi-sponsor coverage per problem and mandatory specialist roles", () => {
    // Valid cohort: 3 distinct sponsors, >= 2 sponsors on every problem, all 3 specialist roles present
    const good = validateG1AlphaCohort([
      { sponsor_id: "usr_alice", problem_ids: ["P-INSTRUMENT", "P-4DSP"], role: "formal-methods" },
      { sponsor_id: "usr_bob", problem_ids: ["P-INSTRUMENT", "P-4DSP"], role: "math-engineer" },
      { sponsor_id: "usr_carol", problem_ids: ["P-INSTRUMENT"], role: "adversarial-security" },
    ]);
    expect(good.valid).toBe(true);
    expect(good.violations).toEqual([]);

    // Planted bad cohort 1: single sponsor fleet (cannot test cross-sponsor independence!)
    const singleSponsor = validateG1AlphaCohort([
      { sponsor_id: "usr_solo", problem_ids: ["P-INSTRUMENT"], role: "formal-methods" },
      { sponsor_id: "usr_solo", problem_ids: ["P-INSTRUMENT"], role: "math-engineer" },
      { sponsor_id: "usr_solo", problem_ids: ["P-INSTRUMENT"], role: "adversarial-security" },
    ]);
    expect(singleSponsor.valid).toBe(false);
    expect(singleSponsor.violations.some((v) => v.includes("G1_COHORT_SINGLE_SPONSOR"))).toBe(true);

    // Planted bad cohort 2: missing adversarial-security reviewer + single-sponsor problem
    const missingSecurity = validateG1AlphaCohort([
      { sponsor_id: "usr_alice", problem_ids: ["P-INSTRUMENT", "P-SOLO"], role: "formal-methods" },
      { sponsor_id: "usr_bob", problem_ids: ["P-INSTRUMENT"], role: "math-engineer" },
    ]);
    expect(missingSecurity.valid).toBe(false);
    expect(missingSecurity.violations).toContain("G1_COHORT_MISSING_ROLE:adversarial-security");
    expect(
      missingSecurity.violations.some((v) => v.includes("G1_COHORT_PROBLEM_SINGLE_SPONSOR:P-SOLO")),
    ).toBe(true);
  });
});
