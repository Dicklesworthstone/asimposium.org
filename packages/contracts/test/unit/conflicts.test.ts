import { describe, expect, test } from "bun:test";
import {
  CONFLICT_STATUSES,
  CONFLICTS_SCHEMA_ID,
  CONTRACT_PROBLEM_CODES,
  ConflictIdSchema,
  ConflictItemSchema,
  ConflictingClaimRefSchema,
  ConflictStatusSchema,
  ConflictsListResponseSchema,
  ContractProblemSchema,
  NormalizeConflictRequestSchema,
  NormalizeConflictResponseSchema,
  ProblemDocumentSchema,
  ProblemRuleSchema,
  ResolveConflictRequestSchema,
  ResolveConflictResponseSchema,
} from "../../src/index.ts";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

async function loadFixture(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(new URL(path, FIXTURES_ROOT)).text()) as unknown;
}

describe("W5.5 Conflicts contracts", () => {
  describe("Conflict schema primitives", () => {
    test("ConflictIdSchema validates canonical IDs and rejects malformed ones", () => {
      expect(ConflictIdSchema.safeParse("CF-1").success).toBe(true);
      expect(ConflictIdSchema.safeParse("CF-42").success).toBe(true);
      expect(ConflictIdSchema.safeParse("CF-1234567890ABCDEF").success).toBe(true);

      expect(ConflictIdSchema.safeParse("").success).toBe(false);
      expect(ConflictIdSchema.safeParse("cf-1").success).toBe(false);
      expect(ConflictIdSchema.safeParse("CONFLICT-1").success).toBe(false);
      expect(ConflictIdSchema.safeParse("CF--DOUBLE").success).toBe(false);
    });

    test("ConflictStatusSchema supports open, resolved, and persistent-uncertainty", () => {
      expect(CONFLICT_STATUSES).toEqual(["open", "resolved", "persistent-uncertainty"]);
      for (const status of CONFLICT_STATUSES) {
        expect(ConflictStatusSchema.safeParse(status).success).toBe(true);
      }
      expect(ConflictStatusSchema.safeParse("closed").success).toBe(false);
      expect(ConflictStatusSchema.safeParse("pending").success).toBe(false);
    });

    test("ConflictingClaimRefSchema validates versioned claim pins", () => {
      expect(ConflictingClaimRefSchema.safeParse({ claim_id: "C-1", version: 1 }).success).toBe(
        true,
      );
      expect(ConflictingClaimRefSchema.safeParse({ claim_id: "C-99", version: 3 }).success).toBe(
        true,
      );
      expect(ConflictingClaimRefSchema.safeParse({ claim_id: "C-1", version: 0 }).success).toBe(
        false,
      );
      expect(ConflictingClaimRefSchema.safeParse({ claim_id: "invalid", version: 1 }).success).toBe(
        false,
      );
    });
  });

  describe("NormalizeConflict contracts", () => {
    test("NormalizeConflictRequestSchema validates full normalization payload", () => {
      const valid = {
        problem_id: "P-456",
        claims: [
          { claim_id: "C-1", version: 1 },
          { claim_id: "C-2", version: 1 },
        ],
        aligned_definitions:
          "Both claims define S_k(x) as the truncated sum of divisor powers for k in [1, 5].",
        aligned_scope: "Evaluated on square-free integers in the range [10^6, 10^12].",
        aligned_quantifiers: "For all eps > 0, there exists N_0 such that the bound holds.",
        smallest_disagreement:
          "Whether the error term is bounded by O(x^{1/2+eps}) or Omega(x^{1/2} log x).",
        agreed_facts: [
          "The main asymptotic term has coefficient 1.",
          "The truncation point k=5 is identical across both formulations.",
        ],
        discriminating_tests: [
          "Compute explicit numerical values of S_5(10^9) with precision 10^-8.",
          "Verify the boundary condition at x = 2^31 - 1.",
        ],
      };
      expect(NormalizeConflictRequestSchema.safeParse(valid).success).toBe(true);
    });

    test("NormalizeConflictRequestSchema rejects identical conflicting claims", () => {
      const invalid = {
        claims: [
          { claim_id: "C-1", version: 1 },
          { claim_id: "C-1", version: 2 },
        ],
        aligned_definitions: "Both claims define S_k(x) as the truncated sum.",
        aligned_scope: "Evaluated on square-free integers.",
        aligned_quantifiers: "For all eps > 0.",
        smallest_disagreement: "Disagreement text.",
        agreed_facts: ["Fact 1"],
        discriminating_tests: ["Test 1"],
      };
      expect(NormalizeConflictRequestSchema.safeParse(invalid).success).toBe(false);
    });

    test("NormalizeConflictRequestSchema rejects underspecified normalization fields", () => {
      const base = {
        claims: [
          { claim_id: "C-1", version: 1 },
          { claim_id: "C-2", version: 1 },
        ],
        aligned_definitions: "Substantive definition alignment.",
        aligned_scope: "Substantive scope alignment.",
        aligned_quantifiers: "Substantive quantifier alignment.",
        smallest_disagreement: "Substantive smallest disagreement.",
        agreed_facts: ["Fact 1"],
        discriminating_tests: ["Test 1"],
      };

      // Empty agreed facts
      expect(NormalizeConflictRequestSchema.safeParse({ ...base, agreed_facts: [] }).success).toBe(
        false,
      );

      // Empty discriminating tests
      expect(
        NormalizeConflictRequestSchema.safeParse({ ...base, discriminating_tests: [] }).success,
      ).toBe(false);

      // Missing smallest disagreement
      expect(
        NormalizeConflictRequestSchema.safeParse({ ...base, smallest_disagreement: "" }).success,
      ).toBe(false);
    });

    test("NormalizeConflictResponseSchema validates canonical open response", () => {
      const res = {
        ok: true,
        conflict_id: "CF-1",
        problem_id: "P-456",
        status: "open",
        seq: 15,
        created_at: "2026-09-09T18:00:00.000Z",
      };
      expect(NormalizeConflictResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("ResolveConflict contracts", () => {
    test("ResolveConflictRequestSchema validates resolution and persistent-uncertainty", () => {
      const resolved = {
        status: "resolved",
        resolution: "Resolved by evidence E-10 disproving the narrower claim hypothesis.",
      };
      expect(ResolveConflictRequestSchema.safeParse(resolved).success).toBe(true);

      const persistent = {
        status: "persistent-uncertainty",
        resolution:
          "Both models are internally consistent within current axiomatic frameworks; independence result established.",
      };
      expect(ResolveConflictRequestSchema.safeParse(persistent).success).toBe(true);

      // Reject empty resolution
      expect(
        ResolveConflictRequestSchema.safeParse({ status: "resolved", resolution: "short" }).success,
      ).toBe(false);

      // Reject open status on resolve
      expect(
        ResolveConflictRequestSchema.safeParse({
          status: "open",
          resolution: "Valid text with enough chars.",
        }).success,
      ).toBe(false);
    });

    test("ResolveConflictResponseSchema validates canonical response", () => {
      const res = {
        ok: true,
        conflict_id: "CF-1",
        problem_id: "P-456",
        status: "resolved",
        seq: 18,
        resolved_at: "2026-09-09T18:30:00.000Z",
      };
      expect(ResolveConflictResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("Conflict item and public face", () => {
    test("ConflictItemSchema enforces Rule A3 total attribution and Diptych face", () => {
      const item = {
        conflict_id: "CF-1",
        problem_id: "P-456",
        seq: 15,
        claims: [
          { claim_id: "C-1", version: 1 },
          { claim_id: "C-2", version: 1 },
        ],
        aligned_definitions:
          "Both claims define S_k(x) as the truncated sum of divisor powers for k in [1, 5].",
        aligned_scope: "Evaluated on square-free integers in the range [10^6, 10^12].",
        aligned_quantifiers: "For all eps > 0, there exists N_0 such that the bound holds.",
        smallest_disagreement:
          "Whether the error term is bounded by O(x^{1/2+eps}) or Omega(x^{1/2} log x).",
        agreed_facts: [
          "The main asymptotic term has coefficient 1.",
          "The truncation point k=5 is identical across both formulations.",
        ],
        discriminating_tests: [
          "Compute explicit numerical values of S_5(10^9) with precision 10^-8.",
          "Verify the boundary condition at x = 2^31 - 1.",
        ],
        status: "open",
        author_fellow_id: "fel_alpha",
        sponsor_id: "usr_sponsor_1",
        session_id: "ses_1",
        model_string_self_declared: "claude-3-opus",
        harness: "claude-code/1.0",
        created_at: "2026-09-09T18:00:00.000Z",
      };
      expect(ConflictItemSchema.safeParse(item).success).toBe(true);

      const listRes = {
        schema: CONFLICTS_SCHEMA_ID,
        problem_id: "P-456",
        conflicts: [item],
        omitted: [],
      };
      expect(ConflictsListResponseSchema.safeParse(listRes).success).toBe(true);
    });
  });

  describe("Error codes, rule citations, and golden fixtures", () => {
    const EXPECTED_CODES = [
      "CONFLICT_BODY_INVALID",
      "CONFLICT_NOT_FOUND",
      "CONFLICT_TARGET_UNKNOWN",
      "CONFLICT_TARGET_IDENTICAL",
      "CONFLICT_ALREADY_SETTLED",
      "CONFLICT_ALREADY_NORMALIZED",
      "CONFLICT_NORMALIZATION_REQUIRED",
    ];

    test("CONTRACT_PROBLEM_CODES includes all W5.5 conflict error codes", () => {
      const codes = new Set<string>(CONTRACT_PROBLEM_CODES);
      for (const code of EXPECTED_CODES) {
        expect(codes.has(code)).toBe(true);
      }
    });

    test("ProblemRuleSchema includes §6.1 and ADR-21", () => {
      expect(ProblemRuleSchema.safeParse("§6.1").success).toBe(true);
      expect(ProblemRuleSchema.safeParse("ADR-21").success).toBe(true);
    });

    test("valid conflict golden fixtures parse as ContractProblemSchema", async () => {
      const fixtures = [
        "valid/problem-conflict-body-invalid.json",
        "valid/problem-conflict-not-found.json",
        "valid/problem-conflict-target-unknown.json",
        "valid/problem-conflict-target-identical.json",
        "valid/problem-conflict-already-settled.json",
        "valid/problem-conflict-already-normalized.json",
        "valid/problem-conflict-normalization-required.json",
      ];
      for (const path of fixtures) {
        const json = await loadFixture(path);
        const docResult = ProblemDocumentSchema.safeParse(json);
        expect(docResult.success, `ProblemDocumentSchema: ${path}`).toBe(true);
        const contractResult = ContractProblemSchema.safeParse(json);
        expect(contractResult.success, `ContractProblemSchema: ${path}`).toBe(true);
      }
    });

    test("invalid untaught conflict fixtures fail ContractProblemSchema", async () => {
      const fixtures = [
        "invalid/problem-conflict-body-invalid-untaught.json",
        "invalid/problem-conflict-not-found-untaught.json",
        "invalid/problem-conflict-target-unknown-untaught.json",
        "invalid/problem-conflict-target-identical-untaught.json",
        "invalid/problem-conflict-already-settled-untaught.json",
        "invalid/problem-conflict-already-normalized-untaught.json",
        "invalid/problem-conflict-normalization-required-untaught.json",
      ];
      for (const path of fixtures) {
        const json = await loadFixture(path);
        const contractResult = ContractProblemSchema.safeParse(json);
        expect(contractResult.success, `Untaught should fail: ${path}`).toBe(false);
      }
    });
  });
});
