import { describe, expect, test } from "bun:test";
import {
  CONTRACT_PROBLEM_CODES,
  LEASE_OBJECT_KINDS,
  LEASE_STATUSES,
  LEASES_SCHEMA_ID,
  LeaseAcquireRequestSchema,
  LeaseAcquireResponseSchema,
  LeaseChallengeRequestSchema,
  LeaseChallengeResponseSchema,
  LeaseItemSchema,
  LeaseListResponseSchema,
  LeaseObjectKindSchema,
  LeaseReleaseRequestSchema,
  LeaseReleaseResponseSchema,
  LeaseStatusSchema,
  SponsorLeaseReleaseRequestSchema,
  SponsorLeaseReleaseResponseSchema,
} from "../../src/index.ts";

describe("W4.4 Leases contracts (Fable §7.5)", () => {
  describe("Enums & IDs", () => {
    test("LeaseObjectKindSchema supports all four public ledger lease targets", () => {
      expect(LEASE_OBJECT_KINDS).toEqual(["claim", "hypothesis", "proof_gap", "question"]);
      for (const kind of LEASE_OBJECT_KINDS) {
        expect(LeaseObjectKindSchema.safeParse(kind).success).toBe(true);
      }
      expect(LeaseObjectKindSchema.safeParse("problem").success).toBe(false);
      expect(LeaseObjectKindSchema.safeParse("review").success).toBe(false);
    });

    test("LeaseStatusSchema supports all five lease lifecycle states", () => {
      expect(LEASE_STATUSES).toEqual(["active", "released", "expired", "challenged", "abandoned"]);
      for (const status of LEASE_STATUSES) {
        expect(LeaseStatusSchema.safeParse(status).success).toBe(true);
      }
      expect(LeaseStatusSchema.safeParse("pending").success).toBe(false);
      expect(LeaseStatusSchema.safeParse("revoked").success).toBe(false);
    });

    test("LEASES_SCHEMA_ID matches canonical URL", () => {
      expect(LEASES_SCHEMA_ID).toBe("https://a.asimposium.org/schemas/leases.v1.json");
    });
  });

  describe("LeaseAcquireRequestSchema", () => {
    test("validates valid exclusive and parallel-safe requests", () => {
      const exclusive = {
        object: "C-12",
        objective: "Narrow parity barrier on odd residue classes",
        deliverable: "Refined bound claim C-12.1",
      };
      const parsedExclusive = LeaseAcquireRequestSchema.safeParse(exclusive);
      expect(parsedExclusive.success).toBe(true);
      if (parsedExclusive.success) {
        expect(parsedExclusive.data.parallel_safe).toBe(false);
        expect(parsedExclusive.data.ttl_seconds).toBe(7200);
      }

      const parallelSafe = {
        object: "H-3",
        objective: "Independent replication of numerical counterexample",
        deliverable: "Computational verification artifact",
        parallel_safe: true,
        ttl_seconds: 3600,
      };
      const parsedParallel = LeaseAcquireRequestSchema.safeParse(parallelSafe);
      expect(parsedParallel.success).toBe(true);
      if (parsedParallel.success) {
        expect(parsedParallel.data.parallel_safe).toBe(true);
        expect(parsedParallel.data.ttl_seconds).toBe(3600);
      }
    });

    test("rejects malformed or empty fields", () => {
      expect(
        LeaseAcquireRequestSchema.safeParse({
          object: "",
          objective: "test",
          deliverable: "test",
        }).success,
      ).toBe(false);

      expect(
        LeaseAcquireRequestSchema.safeParse({
          object: "C-1",
          objective: "",
          deliverable: "test",
        }).success,
      ).toBe(false);

      expect(
        LeaseAcquireRequestSchema.safeParse({
          object: "C-1",
          objective: "a".repeat(281),
          deliverable: "test",
        }).success,
      ).toBe(false);

      expect(
        LeaseAcquireRequestSchema.safeParse({
          object: "C-1",
          objective: "test",
          deliverable: "b".repeat(281),
        }).success,
      ).toBe(false);

      expect(
        LeaseAcquireRequestSchema.safeParse({
          object: "C-1",
          objective: "test",
          deliverable: "test",
          ttl_seconds: 30, // below min 60
        }).success,
      ).toBe(false);

      expect(
        LeaseAcquireRequestSchema.safeParse({
          object: "C-1",
          objective: "test",
          deliverable: "test",
          ttl_seconds: 10000, // above max 7200
        }).success,
      ).toBe(false);
    });
  });

  describe("LeaseItem & Responses", () => {
    test("validates complete LeaseItem and LeaseAcquireResponse", () => {
      const now = new Date().toISOString();
      const inTwoHours = new Date(Date.now() + 7200000).toISOString();
      const item = {
        lease_id: "L-123456",
        session_id: "SES-ABCDEF",
        problem_id: "P-456",
        object: "C-12",
        object_kind: "claim" as const,
        object_id: "CLM-999",
        fellow_id: "FEL-111",
        sponsor_id: "SPON-222",
        objective: "Prove lemma 2",
        deliverable: "Revised claim",
        parallel_safe: false,
        status: "active" as const,
        leased_at: now,
        leased_until: inTwoHours,
      };

      expect(LeaseItemSchema.safeParse(item).success).toBe(true);
      expect(
        LeaseAcquireResponseSchema.safeParse({
          ok: true,
          lease: item,
        }).success,
      ).toBe(true);
      expect(
        LeaseListResponseSchema.safeParse({
          ok: true,
          leases: [item],
        }).success,
      ).toBe(true);
    });

    test("validates release request and response", () => {
      expect(LeaseReleaseRequestSchema.safeParse({}).success).toBe(true);
      expect(LeaseReleaseRequestSchema.safeParse({ reason: "Finished work" }).success).toBe(true);

      const releaseResp = {
        ok: true as const,
        lease_id: "L-123456",
        object: "C-12",
        status: "released" as const,
        released_at: new Date().toISOString(),
        released_by: "FEL-111",
      };
      expect(LeaseReleaseResponseSchema.safeParse(releaseResp).success).toBe(true);
    });

    test("validates challenge request and response", () => {
      expect(LeaseChallengeRequestSchema.safeParse({ reason: "Abandoned lease" }).success).toBe(
        true,
      );
      expect(LeaseChallengeRequestSchema.safeParse({ reason: "   " }).success).toBe(false);
      expect(LeaseChallengeRequestSchema.safeParse({ reason: "" }).success).toBe(false);

      const challengeResp = {
        ok: true as const,
        lease_id: "L-123456",
        object: "C-12",
        status: "challenged" as const,
        challenged_by: "FEL-CHALLENGER",
        challenged_at: new Date().toISOString(),
        reason: "Lessee session has been idle for 2 hours with no workshop updates.",
      };
      expect(LeaseChallengeResponseSchema.safeParse(challengeResp).success).toBe(true);
    });

    test("validates sponsor lease release request and response", () => {
      const sponsorReq = {
        problem_id: "P-456",
        object: "C-12",
        reason: "Sponsor unblocking workstream",
      };
      expect(SponsorLeaseReleaseRequestSchema.safeParse(sponsorReq).success).toBe(true);

      const sponsorResp = {
        ok: true as const,
        lease_id: "L-123456",
        object: "C-12",
        status: "released" as const,
        released_at: new Date().toISOString(),
        released_by: "SPON-ADMIN",
      };
      expect(SponsorLeaseReleaseResponseSchema.safeParse(sponsorResp).success).toBe(true);
    });
  });

  describe("Teaching problem codes", () => {
    test("includes all lease lifecycle problem codes in CONTRACT_PROBLEM_CODES", () => {
      const requiredCodes = [
        "LEASED",
        "LEASE_BODY_INVALID",
        "LEASE_TARGET_NOT_FOUND",
        "LEASE_ALREADY_EXISTS",
        "LEASE_NOT_FOUND",
        "LEASE_NOT_ACTIVE",
        "LEASE_NOT_STALE",
        "LEASE_NOT_HOLDER",
        "NOT_LESSEE_SPONSOR",
        "LEASE_CHALLENGE_BODY_INVALID",
        "LEASE_RELEASE_BODY_INVALID",
        "SPONSOR_LEASE_RELEASE_BODY_INVALID",
      ];
      for (const code of requiredCodes) {
        expect(CONTRACT_PROBLEM_CODES as readonly string[]).toContain(code);
      }
    });
  });
});
