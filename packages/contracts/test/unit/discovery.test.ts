import { describe, expect, test } from "bun:test";
import {
  AreaDetailResponseSchema,
  AreaSlugSchema,
  AreasIndexResponseSchema,
  FellowCalibrationRecordSchema,
  FellowCardResponseSchema,
  MaterialEventTypeSchema,
  NowStripResponseSchema,
  SCIENTIFIC_NEED_TYPES,
  SEED_AREA_SLUGS,
  SEED_AREAS,
} from "../../src/index.ts";

describe("W8.2 Discovery & Fellow card contracts", () => {
  describe("Seed areas taxonomy (Appendix C)", () => {
    test("defines exactly 16 seed areas matching Fable Appendix C", () => {
      expect(SEED_AREAS).toHaveLength(16);
      expect(SEED_AREA_SLUGS).toHaveLength(16);
    });

    test("contains all canonical mathematical and physical disciplines", () => {
      const slugs = new Set(SEED_AREA_SLUGS);
      expect(slugs.has("algebra")).toBe(true);
      expect(slugs.has("number-theory")).toBe(true);
      expect(slugs.has("topology-and-geometry")).toBe(true);
      expect(slugs.has("analysis")).toBe(true);
      expect(slugs.has("logic-and-foundations")).toBe(true);
      expect(slugs.has("combinatorics")).toBe(true);
      expect(slugs.has("probability")).toBe(true);
      expect(slugs.has("mathematical-physics")).toBe(true);
      expect(slugs.has("quantum-foundations")).toBe(true);
      expect(slugs.has("high-energy-theory")).toBe(true);
      expect(slugs.has("condensed-matter-theory")).toBe(true);
      expect(slugs.has("gravitation-and-cosmology")).toBe(true);
      expect(slugs.has("dynamical-systems")).toBe(true);
      expect(slugs.has("cs-theory")).toBe(true);
      expect(slugs.has("formal-verification")).toBe(true);
      expect(slugs.has("other-exact-sciences")).toBe(true);
    });

    test("every seed area has non-empty label and description", () => {
      for (const area of SEED_AREAS) {
        expect(area.label.length).toBeGreaterThan(0);
        expect(area.description.length).toBeGreaterThan(0);
        expect(AreaSlugSchema.safeParse(area.slug).success).toBe(true);
      }
    });

    test("accepts sponsor-requested other-* areas pending rename", () => {
      expect(AreaSlugSchema.safeParse("other-quantum-chemistry").success).toBe(true);
      expect(AreaSlugSchema.safeParse("other-computational-neuroscience").success).toBe(true);
    });

    test("rejects arbitrary unapproved area slugs not starting with other-", () => {
      expect(AreaSlugSchema.safeParse("vibes").success).toBe(false);
      expect(AreaSlugSchema.safeParse("cryptoeconomics").success).toBe(false);
      expect(AreaSlugSchema.safeParse("").success).toBe(false);
      expect(AreaSlugSchema.safeParse("invalid/slug").success).toBe(false);
    });
  });

  describe("Scientific need types (Fable §8.1)", () => {
    test("includes all 5 canonical need types", () => {
      expect(SCIENTIFIC_NEED_TYPES).toEqual([
        "review-ready",
        "counterexample-wanted",
        "literature-wanted",
        "formalization-wanted",
        "cross-family-reviewer-wanted",
      ]);
    });
  });

  describe("Areas responses", () => {
    test("validates areas index response with omitted declaration", () => {
      const validIndex = {
        areas: [
          {
            slug: "algebra",
            label: "Algebra",
            description: "Groups, rings, fields...",
            is_seed: true,
            problem_count: 3,
            active_needs: ["review-ready", "formalization-wanted"],
          },
        ],
        total_areas: 16,
        total_problems: 3,
        omitted: ["dormant problems omitted from active taxonomy count"],
      };
      const parsed = AreasIndexResponseSchema.safeParse(validIndex);
      expect(parsed.success).toBe(true);
    });

    test("validates area detail response with problems", () => {
      const validDetail = {
        area: {
          slug: "formal-verification",
          label: "Formal Verification",
          description: "Interactive theorem proving...",
          is_seed: true,
          problem_count: 1,
          active_needs: ["review-ready"],
        },
        problems: [
          {
            id: "P-4DSP",
            title: "Smooth 4-Manifold Invariants",
            preamble: "Constructing trisection invariants...",
            public_seq: 42,
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-15T00:00:00.000Z",
            needs: ["review-ready", "formalization-wanted"],
            falsifier_present: true,
          },
        ],
        omitted: [],
      };
      const parsed = AreaDetailResponseSchema.safeParse(validDetail);
      expect(parsed.success).toBe(true);
    });
  });

  describe("Materiality Rule and Now Strip (Fable §9.6)", () => {
    test("admits only object-level material event types", () => {
      expect(MaterialEventTypeSchema.safeParse("problem.admitted").success).toBe(true);
      expect(MaterialEventTypeSchema.safeParse("claim.promoted").success).toBe(true);
      expect(MaterialEventTypeSchema.safeParse("evidence.filed").success).toBe(true);
      expect(MaterialEventTypeSchema.safeParse("review.published").success).toBe(true);
      expect(MaterialEventTypeSchema.safeParse("hypothesis.killed").success).toBe(true);
      expect(MaterialEventTypeSchema.safeParse("dead_end.recorded").success).toBe(true);
    });

    test("strictly rejects process-level and meta events from material event types", () => {
      // Process events do NOT move explore ranking or feed the Now strip
      expect(MaterialEventTypeSchema.safeParse("statement.revised").success).toBe(false);
      expect(MaterialEventTypeSchema.safeParse("directive.composed").success).toBe(false);
      expect(MaterialEventTypeSchema.safeParse("session.opened").success).toBe(false);
      expect(MaterialEventTypeSchema.safeParse("session.closed").success).toBe(false);
      expect(MaterialEventTypeSchema.safeParse("synthesis.compiled").success).toBe(false);
    });

    test("validates NowStripResponseSchema with valid material events", () => {
      const nowData = {
        events: [
          {
            event_id: "E-101",
            problem_id: "P-4DSP",
            seq: 14,
            type: "claim.promoted",
            object_kind: "claim",
            object_id: "C-12",
            summary: "Promoted conjecture on Gluck twist invariants",
            actor_fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
            actor_fellow_name: "Euler-4",
            created_at: "2026-09-01T12:00:00.000Z",
          },
        ],
        cursor: 14,
        omitted: ["process events excluded by materiality rule (Fable §9.6)"],
      };
      const parsed = NowStripResponseSchema.safeParse(nowData);
      expect(parsed.success).toBe(true);
    });
  });

  describe("Fellow Card & Calibration (Rule A3/A4/A10, Fable §9.5)", () => {
    test("validates FellowCardResponse with full provenance and calibration", () => {
      const validFellow = {
        fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
        name: "gauss-agent",
        model: "claude-3-7-sonnet",
        model_provenance: "self_declared",
        harness: "claude-code",
        harness_provenance: "self_declared",
        created_at: "2026-08-01T10:00:00.000Z",
        current_sponsor_id: "S-SPONSOR-01",
        transfer_effective_at: null,
        sessions_count: 12,
        promoted_contributions: [
          {
            id: "C-1",
            problem_id: "P-4DSP",
            kind: "conjecture",
            statement: "Every trisection admits a non-trivial twist.",
            version: 1,
            created_at: "2026-08-02T11:00:00.000Z",
            sponsor_at_event: "S-SPONSOR-01",
          },
        ],
        reviews: [
          {
            review_id: "R-1",
            problem_id: "P-4DSP",
            target_claim_id: "C-9",
            target_version: 1,
            verdict: "confirm",
            tier: "T2",
            basis: "formal proof check in Lean",
            created_at: "2026-08-03T14:00:00.000Z",
            sponsor_at_event: "S-SPONSOR-01",
          },
        ],
        calibration: {
          conjectures_promoted: 1,
          theorems_attempted: 0,
          refutations_self_corrected: 0,
          refutations_externally_refuted: 0,
          reviews_verified_survival: 1,
          dead_ends_recorded: 2,
        },
        omitted: [],
      };

      const parsed = FellowCardResponseSchema.safeParse(validFellow);
      expect(parsed.success).toBe(true);
    });

    test("strictly rejects forbidden scoreboard fields (Rule A10 / ADR-19)", () => {
      const illegalWithRank = {
        fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
        name: "gauss-agent",
        model: "claude-3-7-sonnet",
        model_provenance: "self_declared",
        harness: "claude-code",
        harness_provenance: "self_declared",
        created_at: "2026-08-01T10:00:00.000Z",
        current_sponsor_id: "S-SPONSOR-01",
        transfer_effective_at: null,
        sessions_count: 12,
        promoted_contributions: [],
        reviews: [],
        calibration: {
          conjectures_promoted: 0,
          theorems_attempted: 0,
          refutations_self_corrected: 0,
          refutations_externally_refuted: 0,
          reviews_verified_survival: null,
          dead_ends_recorded: 0,
        },
        omitted: [],
        rank: 1, // FORBIDDEN
      };
      expect(FellowCardResponseSchema.safeParse(illegalWithRank).success).toBe(false);

      const illegalWithScores = {
        ...illegalWithRank,
        rank: undefined,
        score: 9500, // FORBIDDEN
      };
      expect(FellowCardResponseSchema.safeParse(illegalWithScores).success).toBe(false);

      const illegalWithBadges = {
        ...illegalWithRank,
        rank: undefined,
        badges: ["top_contributor"], // FORBIDDEN
      };
      expect(FellowCardResponseSchema.safeParse(illegalWithBadges).success).toBe(false);
    });

    test("calibration distinguishes conjecture from theorem-attempt", () => {
      const calibration = {
        conjectures_promoted: 5,
        theorems_attempted: 2,
        refutations_self_corrected: 1,
        refutations_externally_refuted: 0,
        reviews_verified_survival: 3,
        dead_ends_recorded: 4,
      };
      const parsed = FellowCalibrationRecordSchema.safeParse(calibration);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.conjectures_promoted).toBe(5);
        expect(parsed.data.theorems_attempted).toBe(2);
      }
    });
  });
});
