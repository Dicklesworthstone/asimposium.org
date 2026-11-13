import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  SingleSynthesisResponseSchema,
  SYNTHESES_SCHEMA_ID,
  SynthesesListQuerySchema,
  SynthesesListResponseSchema,
  SynthesisIdSchema,
  SynthesisItemSchema,
  SynthesizeRequestSchema,
  synthesesListMatchesQuery,
  synthesesListPath,
} from "../../src/index.ts";

describe("W5.8b Synthesis contracts", () => {
  test("warning goldens preserve public-only notices in Zod and generated JSON Schema", () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    const schema = read("../../generated/syntheses.schema.json");
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema.$defs.single);
    const valid = read("../fixtures/valid/synthesis-screening-notice.json");
    const invalid = read("../fixtures/invalid/synthesis-screening-notice.json");
    expect(SingleSynthesisResponseSchema.parse(valid)).toEqual(valid);
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    expect(SingleSynthesisResponseSchema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
    const { synthesis: item } = valid;
    const request = {
      covers_through: item.covers_through,
      body_md: item.body_md,
      anchors: item.anchors,
      omitted: item.omitted,
      selection_policy: item.selection_policy,
    };
    expect(SynthesizeRequestSchema.safeParse(request).success).toBe(true);
    expect(
      SynthesizeRequestSchema.safeParse({ ...request, screening_notice: item.screening_notice })
        .success,
    ).toBe(false);
    for (const notice of [
      { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
      { category: "injection", action: "published-with-warning", notice: "screening-warning" },
    ]) {
      const face = { ...valid, synthesis: { ...item, screening_notice: notice } };
      expect(SingleSynthesisResponseSchema.safeParse(face).success).toBe(true);
      expect(validate(face), JSON.stringify(validate.errors)).toBe(true);
    }
  });

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

    test("rejects impossible publication and anchor coverage", () => {
      for (const covers_through of [validSynthesis.seq, Number.MAX_SAFE_INTEGER + 1])
        expect(SynthesisItemSchema.safeParse({ ...validSynthesis, covers_through }).success).toBe(
          false,
        );
      expect(
        SynthesisItemSchema.safeParse({
          ...validSynthesis,
          anchors: [{ target_kind: "claim", target_id: "C-1", target_seq: 13 }],
        }).success,
      ).toBe(false);
    });
  });

  describe("SynthesesListResponseSchema", () => {
    test("validates list response with schema URL", () => {
      const list = {
        schema: SYNTHESES_SCHEMA_ID,
        problem_id: "P-RIEMANN",
        cursor: 15,
        before: null,
        next_before: null,
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
      expect(
        synthesesListMatchesQuery(
          "P-RIEMANN",
          { through: 15 },
          SynthesesListResponseSchema.parse(list),
        ),
      ).toBe(true);
      expect(
        synthesesListMatchesQuery(
          "P-RIEMANN",
          { through: 14 },
          SynthesesListResponseSchema.parse(list),
        ),
      ).toBe(false);
      for (const change of [
        { cursor: 14 },
        { before: 15 },
        { next_before: 15 },
        { omitted: ["page_limit"] },
        { syntheses: [list.syntheses[0], list.syntheses[0]] },
        { syntheses: [{ ...list.syntheses[0], problem_id: "P-OTHER" }] },
      ])
        expect(SynthesesListResponseSchema.safeParse({ ...list, ...change }).success).toBe(false);
      expect(
        SynthesesListResponseSchema.safeParse({ ...list, next_before: 15, omitted: ["page_limit"] })
          .success,
      ).toBe(true);
    });
  });

  test("synthesis query continuations are strict and preserve their snapshot", () => {
    expect(SynthesesListQuerySchema.parse({ through: "20", before: "12", limit: "8" })).toEqual({
      through: 20,
      before: 12,
      limit: 8,
    });
    expect(SynthesesListQuerySchema.parse({ through: "0" })).toEqual({ through: 0 });
    for (const query of [
      { before: "12" },
      { through: "10", before: "12" },
      { through: "01" },
      { through: "2junk" },
      { through: "9007199254740992" },
      { through: "2\n" },
      { before: "0", through: "2" },
      { limit: "0" },
      { limit: "201" },
      { skip: "1" },
    ])
      expect(SynthesesListQuerySchema.safeParse(query).success).toBe(false);
    expect(synthesesListPath("P-RIEMANN", "json", { through: 20, before: 12, limit: 8 })).toBe(
      "/p/P-RIEMANN/syntheses.json?through=20&before=12&limit=8",
    );
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
