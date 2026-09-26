import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CanonicalJsonError, canonicalJson } from "../../src/canonical-json.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../fixtures/canonical-json.vectors.json"), "utf8"),
) as { vectors: { id: string; input: string; canonical: string }[] };

describe("canonical JSON golden vectors (asimposiumorg-phg)", () => {
  for (const vector of vectors.vectors) {
    test(vector.id, () => {
      expect(canonicalJson(JSON.parse(vector.input))).toBe(vector.canonical);
      // Canonical output is a fixed point.
      expect(canonicalJson(JSON.parse(vector.canonical))).toBe(vector.canonical);
    });
  }

  test("values JSON text cannot express are refused, never dropped", () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { a: undefined },
      [undefined],
      sparse,
      () => 1,
      Symbol("s"),
      1n,
      { nested: { deep: Number.NEGATIVE_INFINITY } },
    ]) {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    }
  });

  test("a caller keeps its own refusal error class", () => {
    class CallerError extends Error {}
    expect(() =>
      canonicalJson({ a: Number.NaN }, (message) => {
        throw new CallerError(message);
      }),
    ).toThrow(CallerError);
  });
});
