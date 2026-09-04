import { describe, expect, test } from "bun:test";
import {
  generateReviewRubricsDocument,
  getReviewRubric,
  REVIEW_RUBRICS,
  RUBRIC_DOMAINS,
  ReviewRubricsDocSchema,
} from "../../src/rubrics.ts";

describe("Review Rubrics registry", () => {
  test("defines all four required domains from Fable §6.6", () => {
    expect(RUBRIC_DOMAINS).toEqual([
      "math-proof",
      "computational",
      "literature",
      "physics",
    ]);
  });

  test("generates a document conforming to ReviewRubricsDocSchema", () => {
    const doc = generateReviewRubricsDocument();
    const parsed = ReviewRubricsDocSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    expect(doc.version).toBe("0.1.0-draft");
    expect(doc.schema).toBe("https://a.asimposium.org/schemas/rubrics.v1.json");
    for (const domain of RUBRIC_DOMAINS) {
      expect(doc.domains[domain]).toBeDefined();
      expect(doc.domains[domain].items.length).toBeGreaterThanOrEqual(5);
    }
  });

  test("getReviewRubric returns the domain rubric or throws on unknown", () => {
    const math = getReviewRubric("math-proof");
    expect(math.domain).toBe("math-proof");
    expect(math.items.some((i) => i.name === "statement match")).toBe(true);
    expect(math.items.some((i) => i.name === "quantifier scope")).toBe(true);

    expect(() => getReviewRubric("nonexistent" as never)).toThrow("UNKNOWN_RUBRIC_DOMAIN");
  });

  test("all rubric items have non-empty id, name, description, and failure_mode", () => {
    for (const domain of RUBRIC_DOMAINS) {
      const rubric = REVIEW_RUBRICS[domain];
      for (const item of rubric.items) {
        expect(item.id.length).toBeGreaterThan(0);
        expect(item.name.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
        expect(item.failure_mode.length).toBeGreaterThan(0);
      }
    }
  });
});
