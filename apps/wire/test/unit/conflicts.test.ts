import { describe, expect, test } from "bun:test";
import type { NormalizeConflictRequest } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  loadProblemConflicts,
  renderConflictsHtml,
  renderConflictsMarkdown,
  validateConflictSubstance,
} from "../../src/ledger/conflicts";

describe("W5.5 / conflicts ledger unit tests", () => {
  const validRequest: NormalizeConflictRequest = {
    claims: [
      { claim_id: "C-A1", version: 1 },
      { claim_id: "C-B2", version: 2 },
    ],
    aligned_definitions:
      "Both agents define prime gaps as consecutive prime differences p_{n+1} - p_n.",
    aligned_scope:
      "Finite positive integers strictly greater than 2 under standard Peano arithmetic.",
    aligned_quantifiers:
      "For all epsilon > 0, there exists N such that for all n > N the bound holds.",
    smallest_disagreement:
      "Claim A bounds the gap by O(log^2 p) whereas Claim B claims an unconditional lower bound of Omega(log^3 p).",
    agreed_facts: [
      "The prime number theorem implies average gap is log p.",
      "Cramer's heuristic suggests upper bound of O(log^2 p).",
    ],
    discriminating_tests: [
      "Compute explicit gap extremes in the range [10^12, 10^14].",
      "Formalize the sieve reduction lemma in Lean 4 to check quantifier order.",
    ],
  };

  describe("validateConflictSubstance", () => {
    test("accepts valid conflict request", () => {
      const result = validateConflictSubstance(validRequest);
      expect(result.valid).toBe(true);
    });

    test("rejects identical claims", () => {
      const result = validateConflictSubstance({
        ...validRequest,
        claims: [
          { claim_id: "C-A1", version: 1 },
          { claim_id: "C-A1", version: 2 },
        ],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("distinct claim IDs");
      }
    });

    test("rejects short or placeholder alignment fields", () => {
      const shortDefs = validateConflictSubstance({
        ...validRequest,
        aligned_definitions: "short",
      });
      expect(shortDefs.valid).toBe(false);

      const placeholderScope = validateConflictSubstance({
        ...validRequest,
        aligned_scope: "placeholder",
      });
      expect(placeholderScope.valid).toBe(false);

      const lowWordCount = validateConflictSubstance({
        ...validRequest,
        aligned_quantifiers: "quantifiers quantifiers",
      });
      expect(lowWordCount.valid).toBe(false);
    });

    test("rejects empty agreed facts or discriminating tests", () => {
      const noFacts = validateConflictSubstance({
        ...validRequest,
        agreed_facts: [],
      });
      expect(noFacts.valid).toBe(false);

      const noTests = validateConflictSubstance({
        ...validRequest,
        discriminating_tests: [],
      });
      expect(noTests.valid).toBe(false);
    });
  });

  describe("loadProblemConflicts", () => {
    test("returns empty and omission when problem does not exist", async () => {
      const db = {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
          }),
        }),
      } as unknown as D1Database;

      const result = await loadProblemConflicts(db, "P-MISSING");
      expect(result.conflicts).toHaveLength(0);
      expect(result.omitted).toContain("problem not found");
    });

    test("loads and parses conflict records", async () => {
      const mockRows = [
        {
          conflict_id: "CF-1",
          problem_id: "P-MATH",
          seq: 1,
          claim_a_id: "C-A1",
          claim_a_version: 1,
          claim_b_id: "C-B2",
          claim_b_version: 2,
          aligned_definitions: "Shared definition of prime gaps.",
          aligned_scope: "Positive integers greater than 2.",
          aligned_quantifiers: "Universal quantifier over all primes.",
          smallest_disagreement: "O(log^2 p) vs Omega(log^3 p).",
          agreed_facts_json: JSON.stringify(["Fact 1", "Fact 2"]),
          discriminating_tests_json: JSON.stringify(["Test 1"]),
          status: "open",
          resolution: null,
          author_fellow_id: "F-FELLOW-1",
          created_at: "2026-09-09T00:00:00.000Z",
          resolved_at: null,
          actor_sponsor_id: "SPON-1",
          actor_session_id: "SES-1",
          model_string_self_declared: "model-x",
          harness: "harness-y",
          payload_sha256: "abc",
          payload_json: "{}",
          content_available: 1,
        },
      ];

      const db = {
        prepare: (_query: string) => ({
          bind: (..._args: unknown[]) => ({
            first: async () => ({ public_seq: 100, status: "open" }),
            all: async () => ({ results: mockRows }),
          }),
        }),
      } as unknown as D1Database;

      const result = await loadProblemConflicts(db, "P-MATH");
      const first = result.conflicts[0];
      expect(first).toBeDefined();
      if (!first) throw new Error("expected conflict");
      expect(first.conflict_id).toBe("CF-1");
      expect(first.claims[0]?.claim_id).toBe("C-A1");
      expect(first.claims[1]?.claim_id).toBe("C-B2");
      expect(first.agreed_facts).toEqual(["Fact 1", "Fact 2"]);
      expect(first.discriminating_tests).toEqual(["Test 1"]);
      expect(first.status).toBe("open");
    });
  });

  describe("renderConflictsMarkdown", () => {
    test("renders empty state", () => {
      const md = renderConflictsMarkdown("P-EMPTY", []);
      expect(md).toContain("# Normalized Conflicts for Problem `P-EMPTY`");
      expect(md).toContain("No normalized conflicts recorded");
    });

    test("renders conflicts correctly with omissions", () => {
      const conflicts = [
        {
          conflict_id: "CF-1",
          problem_id: "P-MATH",
          seq: 1,
          claims: [
            { claim_id: "C-A1", version: 1 },
            { claim_id: "C-B2", version: 2 },
          ] as [{ claim_id: string; version: number }, { claim_id: string; version: number }],
          aligned_definitions: "Standard definitions.",
          aligned_scope: "Standard arithmetic.",
          aligned_quantifiers: "For all primes.",
          smallest_disagreement: "Disagreement on asymptopia.",
          agreed_facts: ["Fact 1"],
          discriminating_tests: ["Test 1"],
          status: "open" as const,
          resolution: null,
          author_fellow_id: "F-FELLOW-1",
          sponsor_id: "SPON-1",
          session_id: "SES-1",
          model_string_self_declared: "model-x",
          harness: "harness-y",
          created_at: "2026-09-09T00:00:00.000Z",
          resolved_at: null,
        },
      ];

      const md = renderConflictsMarkdown("P-MATH", conflicts, ["sample omission"]);
      expect(md).toContain("## Conflict `CF-1`");
      expect(md).toContain("`C-A1@1` vs `C-B2@2`");
      expect(md).toContain("### Smallest Disagreement");
      expect(md).toContain("Disagreement on asymptopia.");
      expect(md).toContain("### Agreed Facts");
      expect(md).toContain("- Fact 1");
      expect(md).toContain("### Deliberate Omissions");
      expect(md).toContain("- sample omission");
    });
  });

  describe("renderConflictsHtml", () => {
    test("renders html page with conflict cards and back links", () => {
      const conflicts = [
        {
          conflict_id: "CF-1",
          problem_id: "P-MATH",
          seq: 1,
          claims: [
            { claim_id: "C-A1", version: 1 },
            { claim_id: "C-B2", version: 2 },
          ] as [{ claim_id: string; version: number }, { claim_id: string; version: number }],
          aligned_definitions: "Standard definitions.",
          aligned_scope: "Standard arithmetic.",
          aligned_quantifiers: "For all primes.",
          smallest_disagreement: "Disagreement on asymptopia.",
          agreed_facts: ["Fact 1"],
          discriminating_tests: ["Test 1"],
          status: "resolved" as const,
          resolution: "Resolved by counterexample in C-C.",
          author_fellow_id: "F-FELLOW-1",
          sponsor_id: "SPON-1",
          session_id: "SES-1",
          model_string_self_declared: "model-x",
          harness: "harness-y",
          created_at: "2026-09-09T00:00:00.000Z",
          resolved_at: "2026-09-09T01:00:00.000Z",
        },
      ];

      const html = renderConflictsHtml("P-MATH", conflicts);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("CF-1");
      expect(html).toContain("C-A1@1");
      expect(html).toContain("C-B2@2");
      expect(html).toContain("resolved");
      expect(html).toContain("Resolved by counterexample in C-C.");
      expect(html).toContain("/p/P-MATH/conflicts.json");
      expect(html).toContain("/p/P-MATH/conflicts.md");
    });
  });
});
