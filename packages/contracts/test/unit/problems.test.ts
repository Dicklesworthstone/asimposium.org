import { expect, test } from "bun:test";
import {
  ClaimReanchorRequestSchema,
  ProblemClosingSynthesisSchema,
  ProblemDetailSchema,
  ProblemFamousGuardrailSchema,
  ProblemLifecycleActionRequestSchema,
  ProblemLifecycleContractsSchema,
  ProblemNoClaimBoundarySchema,
  ProblemResolutionDirectionSchema,
  ProblemStatementReviewRequestSchema,
  ProblemStatementReviewResponseSchema,
  ProblemStatementVersionSchema,
  ProblemStatusSchema,
  ProposeProblemRequestSchema,
  SaveProblemBriefRequestSchema,
  SponsorProblemBriefSchema,
} from "../../src/problems.ts";

test("W5.1 Problem lifecycle contracts validate all states and directions", () => {
  const validStatuses = [
    "private-draft",
    "sharpening",
    "active",
    "dormant",
    "under-result-review",
    "resolved",
    "retired",
  ];
  for (const status of validStatuses) {
    expect(ProblemStatusSchema.safeParse(status).success).toBe(true);
  }
  expect(ProblemStatusSchema.safeParse("unknown").success).toBe(false);

  const validDirections = ["affirmed", "refuted-as-stated", "closed-with-negative-result"];
  for (const dir of validDirections) {
    expect(ProblemResolutionDirectionSchema.safeParse(dir).success).toBe(true);
  }
  expect(ProblemResolutionDirectionSchema.safeParse("proven").success).toBe(false);
});

test("W5.1 Famous-problem guardrail enforces canonical formulation and standing banner", () => {
  const validGuardrail = {
    canonical_formulation: "Every even integer > 2 is the sum of two primes.",
    variant_distinctions:
      "Distinct from the weak Goldbach conjecture which applies to odd numbers.",
    authoritative_references: ["https://doi.org/10.1000/182"],
    standing_banner: "Resolutions require extraordinary independent verification.",
  };
  expect(ProblemFamousGuardrailSchema.safeParse(validGuardrail).success).toBe(true);

  // Empty references refused
  expect(
    ProblemFamousGuardrailSchema.safeParse({ ...validGuardrail, authoritative_references: [] })
      .success,
  ).toBe(false);
});

test("W5.1 Closing synthesis enforces no-claim boundary", () => {
  const validClosing = {
    summary: "The statement was refuted via counterexample at N=42.",
    no_claim_boundary: {
      verified: ["Finite range search up to N=10^6"],
      mechanisms: ["Exhaustive computational check"],
      independence_tiers: ["T2", "T3"],
      remaining_external_validation: ["Formal Lean 4 verification of the divisor bound"],
    },
  };
  expect(ProblemClosingSynthesisSchema.safeParse(validClosing).success).toBe(true);

  // Empty no_claim_boundary arrays refused
  expect(
    ProblemClosingSynthesisSchema.safeParse({
      ...validClosing,
      no_claim_boundary: { ...validClosing.no_claim_boundary, verified: [] },
    }).success,
  ).toBe(false);
});

test("W5.1 Problem statement versions enforce hash and positive version", () => {
  const validVersion = {
    problem_id: "P-4DSP",
    version: 1,
    statement: "Every even integer greater than 2 is sum of two primes.",
    norm_hash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    falsifier: "An even integer > 2 not expressible as sum of two primes.",
    motivation: "Core problem in additive number theory.",
    created_at: "2026-09-08T12:00:00.000Z",
  };
  expect(ProblemStatementVersionSchema.safeParse(validVersion).success).toBe(true);

  // Version <= 0 refused
  expect(ProblemStatementVersionSchema.safeParse({ ...validVersion, version: 0 }).success).toBe(
    false,
  );
  // Malformed norm_hash refused
  expect(
    ProblemStatementVersionSchema.safeParse({ ...validVersion, norm_hash: "not-sha" }).success,
  ).toBe(false);
});

test("W5.1 Sponsor problem brief enforces fields and status", () => {
  const validBrief = {
    id: "brief-goldbach-1",
    sponsor_id: "usr_01h7abc",
    assigned_fellow_id: "fel_01h7xyz",
    title: "Goldbach Conjecture Investigation",
    statement: "Every even integer greater than 2 is sum of two primes.",
    falsifier: "An even integer > 2 not expressible as sum of two primes.",
    motivation: "Foundational arithmetic.",
    areas: ["number-theory"],
    status: "active",
    created_at: "2026-09-08T12:00:00.000Z",
    updated_at: "2026-09-08T12:00:00.000Z",
  };
  expect(SponsorProblemBriefSchema.safeParse(validBrief).success).toBe(true);
  expect(SponsorProblemBriefSchema.safeParse({ ...validBrief, status: "invalid" }).success).toBe(
    false,
  );
});

test("W5.1 Fellow propose problem request validates inputs", () => {
  const validProposal = {
    title: "Goldbach Conjecture Investigation",
    statement: "Every even integer greater than 2 is sum of two primes.",
    falsifier: "An even integer > 2 not expressible as sum of two primes.",
    motivation: "Foundational arithmetic.",
    areas: ["number-theory"],
  };
  expect(ProposeProblemRequestSchema.safeParse(validProposal).success).toBe(true);

  // Title exceeding 120 chars refused
  expect(
    ProposeProblemRequestSchema.safeParse({ ...validProposal, title: "a".repeat(121) }).success,
  ).toBe(false);
  // Empty areas refused
  expect(ProposeProblemRequestSchema.safeParse({ ...validProposal, areas: [] }).success).toBe(
    false,
  );
  for (const areas of [["geometry"], ["other-"], ["other--path"], Array(33).fill("algebra")]) {
    expect(ProposeProblemRequestSchema.safeParse({ ...validProposal, areas }).success).toBe(false);
  }
  expect(
    ProposeProblemRequestSchema.safeParse({ ...validProposal, areas: ["other-path-enumeration"] })
      .success,
  ).toBe(true);
});

test("W5.1 Problem lifecycle action discriminated union parses valid transitions", () => {
  expect(ProblemLifecycleActionRequestSchema.safeParse({ action: "publish" }).success).toBe(true);
  expect(
    ProblemLifecycleActionRequestSchema.safeParse({
      action: "revise-statement",
      statement: "Revised statement",
      falsifier: "Revised falsifier",
      motivation: "Revised motivation",
    }).success,
  ).toBe(true);
  expect(
    ProblemLifecycleActionRequestSchema.safeParse({
      action: "enter-result-review",
    }).success,
  ).toBe(true);
  expect(
    ProblemLifecycleActionRequestSchema.safeParse({
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        summary: "Proof confirmed",
        no_claim_boundary: {
          verified: ["Steps 1-4"],
          mechanisms: ["Coq check"],
          independence_tiers: ["T2"],
          remaining_external_validation: ["Peer review"],
        },
      },
    }).success,
  ).toBe(true);
  expect(
    ProblemLifecycleActionRequestSchema.safeParse({
      action: "retire",
      reason: "Superseded by generalized formulation",
    }).success,
  ).toBe(true);

  // Unknown action refused
  expect(ProblemLifecycleActionRequestSchema.safeParse({ action: "delete" }).success).toBe(false);
});

test("W5.1 Claim reanchor request validates claim_id and base_version", () => {
  expect(
    ClaimReanchorRequestSchema.safeParse({
      claim_id: "C-1",
      base_version: 2,
    }).success,
  ).toBe(true);

  expect(
    ClaimReanchorRequestSchema.safeParse({
      claim_id: "invalid-claim",
      base_version: 2,
    }).success,
  ).toBe(false);

  expect(
    ClaimReanchorRequestSchema.safeParse({
      claim_id: "C-1",
      base_version: 0,
    }).success,
  ).toBe(false);
});

test("W5.1 Problem statement review contracts validate verdict and basis", () => {
  const validRequest = {
    verdict: "statement-clear",
    basis: "The formulation is rigorous, types are exact, and falsifier is sharp.",
  };
  expect(ProblemStatementReviewRequestSchema.safeParse(validRequest).success).toBe(true);

  // statement-unclear is also valid
  expect(
    ProblemStatementReviewRequestSchema.safeParse({
      ...validRequest,
      verdict: "statement-unclear",
    }).success,
  ).toBe(true);

  // Invalid verdict refused
  expect(
    ProblemStatementReviewRequestSchema.safeParse({
      ...validRequest,
      verdict: "clear",
    }).success,
  ).toBe(false);

  // Empty basis refused
  expect(
    ProblemStatementReviewRequestSchema.safeParse({
      ...validRequest,
      basis: "",
    }).success,
  ).toBe(false);

  // Valid response
  const validResponse = {
    reviewed: true,
    problem_id: "P-4DSP",
    verdict: "statement-clear",
    status: "active",
  };
  expect(ProblemStatementReviewResponseSchema.safeParse(validResponse).success).toBe(true);

  // Response with invalid status refused
  expect(
    ProblemStatementReviewResponseSchema.safeParse({
      ...validResponse,
      status: "non-existent-status",
    }).success,
  ).toBe(false);
});
