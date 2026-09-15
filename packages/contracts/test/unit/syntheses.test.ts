import { describe, expect, test } from "bun:test";
import {
  SingleSynthesisResponseSchema,
  SYNTHESES_SCHEMA_ID,
  SynthesesListResponseSchema,
  SynthesisIdSchema,
  SynthesisItemSchema,
} from "../../src/index.ts";

describe("W5.8b Synthesis contracts", () => {
  describe("SynthesisIdSchema", () => {
    test("validates canonical IDs and rejects malformed ones", () => {
      expect(SynthesisIdSchema.safeParse("SYNTH-1").success).toBe(true);
      expect(SynthesisIdSchema.safeParse("SYNTH-1234567890ABCDEF").success).toBe(true);
      expect(SynthesisIdSchema.safeParse("SYNTH-FROZEN-CUT-42").success).toBe(true);

      expect(SynthesisIdSchema.safeParse("").success).toBe(false);
      expect(SynthesisIdSchema.safeParse("synth-1").success).toBe(false);
      expect(SynthesisIdSchema.safeParse("S-1").success).toBe(false);
      expect(SynthesisIdSchema.safeParse("SYNTH--DOUBLE").success).toBe(false);
    });
  });

  describe("SynthesisItemSchema", () => {
    const validSynthesis = {
      synthesis_id: "SYNTH-1",
      problem_id: "P-RIEMANN",
      seq: 15,
      covers_through: 12,
      body_md: "## State of the Problem\n\nAll non-trivial zeros lie on the critical line.",
      anchors: [
        {
          target_kind: "claim" as const,
          target_id: "C-1",
          target_version: 1,
          assertion_summary: "Prime factor existence holds",
        },
      ],
      omitted: ["Exploratory numerical bounds excluded"],
      selection_policy: "Include corroborated claims and verified bounds",
      dropped_single_author_count: 0,
      authoring_principal: "fel_12345",
      declared_model: "test-model/v1",
      created_at: new Date().toISOString(),
    };

    test("validates a canonical synthesis item", () => {
      expect(SynthesisItemSchema.safeParse(validSynthesis).success).toBe(true);
    });

    test("accepts optional attribution fields", () => {
      expect(
        SynthesisItemSchema.safeParse({
          ...validSynthesis,
          sponsor_id: "spn_123",
          session_id: "ses_456",
          harness: "codex",
        }).success,
      ).toBe(true);
    });

    test("rejects invalid problem or synthesis ID", () => {
      expect(
        SynthesisItemSchema.safeParse({
          ...validSynthesis,
          synthesis_id: "INVALID",
        }).success,
      ).toBe(false);
      expect(
        SynthesisItemSchema.safeParse({
          ...validSynthesis,
          problem_id: "invalid_problem",
        }).success,
      ).toBe(false);
    });

    test("rejects empty anchors", () => {
      expect(
        SynthesisItemSchema.safeParse({
          ...validSynthesis,
          anchors: [],
        }).success,
      ).toBe(false);
    });
  });

  describe("SynthesesListResponseSchema", () => {
    test("validates list response with schema URL", () => {
      const list = {
        schema: SYNTHESES_SCHEMA_ID,
        problem_id: "P-RIEMANN",
        syntheses: [
          {
            synthesis_id: "SYNTH-1",
            problem_id: "P-RIEMANN",
            seq: 15,
            covers_through: 12,
            body_md: "State of the problem",
            anchors: [{ target_kind: "claim" as const, target_id: "C-1" }],
            omitted: [],
            selection_policy: "Include all claims",
            dropped_single_author_count: 0,
            authoring_principal: "fel_1",
            declared_model: "test-model",
            created_at: new Date().toISOString(),
          },
        ],
        omitted: [],
      };
      expect(SynthesesListResponseSchema.safeParse(list).success).toBe(true);
    });
  });

  describe("SingleSynthesisResponseSchema", () => {
    test("validates single synthesis response with staleness", () => {
      const single = {
        schema: SYNTHESES_SCHEMA_ID,
        synthesis: {
          synthesis_id: "SYNTH-1",
          problem_id: "P-RIEMANN",
          seq: 15,
          covers_through: 12,
          body_md: "State of the problem",
          anchors: [{ target_kind: "claim" as const, target_id: "C-1" }],
          omitted: [],
          selection_policy: "Include all claims",
          dropped_single_author_count: 0,
          authoring_principal: "fel_1",
          declared_model: "test-model",
          created_at: new Date().toISOString(),
        },
        staleness: {
          material_events_since: 5,
          stale: true,
        },
      };
      expect(SingleSynthesisResponseSchema.safeParse(single).success).toBe(true);
    });
  });
});
