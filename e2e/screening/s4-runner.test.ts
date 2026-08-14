import { describe, expect, test } from "bun:test";
import {
  assertS4CorpusShape,
  assertS4ManifestReadyForLiveRun,
  createS4Corpus,
  inspectS4ManifestReadiness,
} from "./s4-corpus";

describe("S-4 frozen corpus", () => {
  test("has diverse safe bodies and records that absent protected bodies BLOCK live accuracy evidence", async () => {
    const corpus = await createS4Corpus();
    expect(corpus).toHaveLength(200);
    expect(corpus.filter((example) => example.ground_truth === "legitimate")).toHaveLength(150);
    expect(corpus.filter((example) => example.ground_truth === "hard-reject")).toHaveLength(50);
    expect(corpus.filter((example) => example.aggregation_pair_id)).toHaveLength(10);
    expect(() => assertS4CorpusShape(corpus)).not.toThrow();
    expect(
      new Set(
        corpus
          .filter((example) => example.ground_truth === "legitimate")
          .map((example) => example.body),
      ).size,
    ).toBe(150);
    expect(inspectS4ManifestReadiness(corpus)).toEqual({
      status: "blocked",
      blockers: ["EVALUATED_BODY_DIGEST_MISSING", "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"],
    });
    await expect(assertS4ManifestReadyForLiveRun(corpus)).rejects.toThrow(
      "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE",
    );
  });
});
