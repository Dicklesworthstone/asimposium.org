import { describe, expect, test } from "bun:test";
import {
  computeDeadEndNormHash,
  renderDeadEndsMarkdown,
  validateDeadEndSubstance,
} from "../../src/ledger/dead-ends";

describe("W5.8a dead-ends unit tests", () => {
  test("validateDeadEndSubstance accepts substantive negative knowledge", () => {
    const valid = validateDeadEndSubstance({
      approach: "Exhaustive branching analysis using 2-adic valuation limits.",
      why_it_fails: "Exponential divergence encountered at odd integer multipliers.",
      retry_predicate: "Worth retrying if a global non-archimedean metric bounds the branch width.",
      what_was_examined: "All modular trajectories up to depth 64.",
      scope_detection_floor: "k <= 32",
    });
    expect(valid.valid).toBe(true);
  });

  test("validateDeadEndSubstance refuses placeholder approaches", () => {
    const placeholders = ["failed", "n/a", "none", "test", "todo", "tbd"];
    for (const ph of placeholders) {
      const res = validateDeadEndSubstance({
        approach: ph,
        why_it_fails: "Exponential divergence encountered at odd integer multipliers.",
        retry_predicate: "Worth retrying if a global metric bounds the branch width.",
      });
      expect(res.valid).toBe(false);
    }
  });

  test("validateDeadEndSubstance refuses low-substance short or repetitive text", () => {
    const res = validateDeadEndSubstance({
      approach: "tried it it it it",
      why_it_fails: "did not work at all here",
      retry_predicate: "retry later",
    });
    expect(res.valid).toBe(false);
  });

  test("computeDeadEndNormHash normalizes whitespace, LaTeX math, and casing", async () => {
    const h1 = await computeDeadEndNormHash(
      "Bounding the   modular cycle length  using $2^k$ valuations.",
      "Cases with $k \\le 32$",
    );
    const h2 = await computeDeadEndNormHash(
      "bounding the modular cycle length using $2^k$ valuations.",
      "Cases with $k \\le 32$",
    );
    expect(h1).toBe(h2);

    const h3 = await computeDeadEndNormHash(
      "A completely different approach using spectral radius bounds.",
      "Random graphs",
    );
    expect(h1).not.toBe(h3);
  });

  test("renderDeadEndsMarkdown renders diptych face without aggregate counts", () => {
    const md = renderDeadEndsMarkdown("P-TEST", [
      {
        dead_end_id: "DE-1",
        problem_id: "P-TEST",
        seq: 5,
        approach: "Attempted bounding cycle length using 2-adic valuations.",
        why_it_fails: "Diverged at odd multipliers with exponential branch accumulation.",
        retry_predicate: "Worth retrying if branch width can be bounded analytically.",
        what_was_examined: "Modular residues modulo 2^64",
        scope_detection_floor: "k <= 32",
        retry_when: {
          kind: "claim-reaches",
          claim_id: "C-12",
          reaches: "corroborated",
        },
        author_fellow_id: "fel_123",
        created_at: "2026-09-09T12:00:00.000Z",
      },
    ]);

    expect(md).toContain("# Negative Evidence Ledger — P-TEST");
    expect(md).toContain("## DE-1 (seq: 5)");
    expect(md).toContain("- **Author**: fel_123");
    expect(md).toContain("- **Approach**: Attempted bounding cycle length");
    expect(md).toContain("- **Structured Trigger**: claim `C-12` reaches `corroborated`");
    // Rule A10: No aggregate metrics, no leaderboards, no count summaries
    expect(md).not.toContain("Total dead ends:");
    expect(md).not.toContain("Leaderboard");
  });

  test("renderDeadEndsMarkdown renders statement-revised and gap-closed triggers", () => {
    const md = renderDeadEndsMarkdown("P-TEST", [
      {
        dead_end_id: "DE-2",
        problem_id: "P-TEST",
        seq: 6,
        approach: "Attempted spectral gap analysis on the transition graph.",
        why_it_fails: "Eigenvalue clusters merge near the unit circle.",
        retry_predicate: "Worth retrying if the core problem statement is revised.",
        retry_when: { kind: "statement-revised" },
        author_fellow_id: "fel_123",
        created_at: "2026-09-09T13:00:00.000Z",
      },
      {
        dead_end_id: "DE-3",
        problem_id: "P-TEST",
        seq: 7,
        approach: "Attempted local homology computation around the singular locus.",
        why_it_fails: "Torsion obstructions do not vanish at degree 2.",
        retry_predicate: "Worth retrying if the foundational gap GAP-1 is closed.",
        retry_when: { kind: "gap-closed", gap_id: "GAP-1" },
        author_fellow_id: "fel_456",
        created_at: "2026-09-09T14:00:00.000Z",
      },
    ]);

    expect(md).toContain("problem statement revised");
    expect(md).toContain("proof gap `GAP-1` closed");
  });

  test("renderDeadEndsMarkdown handles empty list honestly", () => {
    const md = renderDeadEndsMarkdown("P-EMPTY", []);
    expect(md).toContain("# Negative Evidence Ledger — P-EMPTY");
    expect(md).toContain("No negative results recorded on this problem yet.");
  });

  test("validateDeadEndSubstance enforces word counts on why_it_fails and retry_predicate", () => {
    const whyShort = validateDeadEndSubstance({
      approach: "Exhaustive branching analysis using 2-adic valuation limits.",
      why_it_fails: "it broke",
      retry_predicate: "Worth retrying if a global non-archimedean metric bounds width.",
    });
    expect(whyShort.valid).toBe(false);

    const retryShort = validateDeadEndSubstance({
      approach: "Exhaustive branching analysis using 2-adic valuation limits.",
      why_it_fails: "Exponential divergence encountered at odd integer multipliers.",
      retry_predicate: "retry later",
    });
    expect(retryShort.valid).toBe(false);
  });
});
