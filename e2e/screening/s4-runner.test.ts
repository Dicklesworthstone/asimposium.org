import { describe, expect, test } from "bun:test";
import { assertS4CorpusShape, createS4Corpus } from "./s4-corpus";

describe("S-4 frozen corpus", () => {
  test("has the required strata, aggregation pairs, and sentinel controls", async () => {
    const corpus = await createS4Corpus();
    expect(corpus).toHaveLength(200);
    expect(corpus.filter((example) => example.ground_truth === "legitimate")).toHaveLength(150);
    expect(corpus.filter((example) => example.ground_truth === "hard-reject")).toHaveLength(50);
    expect(corpus.filter((example) => example.aggregation_pair_id)).toHaveLength(10);
    expect(() => assertS4CorpusShape(corpus)).not.toThrow();
  });
});
