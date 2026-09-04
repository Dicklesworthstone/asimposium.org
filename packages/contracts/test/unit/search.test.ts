import { describe, expect, test } from "bun:test";
import {
  escapeFts5Query,
  parseExactReference,
  SearchQueryRequestSchema,
  SearchResponseSchema,
} from "../../src/search.ts";

describe("W6.8 Search contracts", () => {
  describe("escapeFts5Query", () => {
    test("quotes plain whitespace-separated tokens", () => {
      expect(escapeFts5Query("riemann hypothesis")).toBe('"riemann" "hypothesis"');
    });

    test("strips special FTS punctuation without throwing syntax errors", () => {
      expect(escapeFts5Query("claim* :type: ^near {test}")).toBe('"claim" "type" "near" "test"');
    });

    test("filters standalone boolean operators to avoid unexpected syntax", () => {
      expect(escapeFts5Query("foo AND bar NOT baz OR qux")).toBe('"foo" "bar" "baz" "qux"');
    });

    test("returns empty string when query consists entirely of operators or whitespace", () => {
      expect(escapeFts5Query("")).toBe("");
      expect(escapeFts5Query("   ")).toBe("");
      expect(escapeFts5Query("AND OR NOT NEAR")).toBe("");
    });

    test("normalizes Unicode via NFKC", () => {
      // ligature ﬁ -> fi, superscript ² -> 2
      expect(escapeFts5Query("ﬁeld 2²")).toBe('"field" "22"');
    });

    test("safely handles embedded double quotes without syntax error", () => {
      expect(escapeFts5Query('exact "quote" test')).toBe('"exact" "quote" "test"');
    });

    test("strips ASCII control characters", () => {
      expect(escapeFts5Query("hello\u0000world\u001Ftest")).toBe('"hello" "world" "test"');
    });
  });

  describe("parseExactReference", () => {
    test("detects exact problem IDs", () => {
      expect(parseExactReference("P-RIEMANN-01")).toEqual({
        kind: "problem",
        id: "P-RIEMANN-01",
      });
      expect(parseExactReference("  P-123  ")).toEqual({
        kind: "problem",
        id: "P-123",
      });
    });

    test("detects exact claim IDs", () => {
      expect(parseExactReference("C-1")).toEqual({
        kind: "claim",
        id: "C-1",
      });
      expect(parseExactReference("C-9999")).toEqual({
        kind: "claim",
        id: "C-9999",
      });
    });

    test("detects exact fellow IDs", () => {
      expect(parseExactReference("F-01M0HCVW4XTFWMZCQ40EJ0S0J7")).toEqual({
        kind: "fellow",
        id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
      });
    });

    test("detects composite problem#claim references", () => {
      expect(parseExactReference("P-RIEMANN-01#C-14")).toEqual({
        kind: "claim",
        id: "C-14",
        problemId: "P-RIEMANN-01",
      });
      expect(parseExactReference("P-123/C-456")).toEqual({
        kind: "claim",
        id: "C-456",
        problemId: "P-123",
      });
    });

    test("detects stable problem and claim URLs", () => {
      expect(parseExactReference("https://asimposium.org/p/P-RIEMANN-01")).toEqual({
        kind: "problem",
        id: "P-RIEMANN-01",
      });
      expect(parseExactReference("https://a.asimposium.org/p/P-123#C-42")).toEqual({
        kind: "claim",
        id: "C-42",
        problemId: "P-123",
      });
      expect(
        parseExactReference("https://staging.asimposium.org/fellows/F-01M0HCVW4XTFWMZCQ40EJ0S0J7"),
      ).toEqual({
        kind: "fellow",
        id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
      });
    });

    test("returns null for ordinary lexical queries", () => {
      expect(parseExactReference("prime numbers")).toBeNull();
      expect(parseExactReference("P-")).toBeNull();
      expect(parseExactReference("C-")).toBeNull();
      expect(parseExactReference("not an id P-123")).toBeNull();
    });
  });

  describe("SearchQueryRequestSchema", () => {
    test("validates valid query parameters", () => {
      const parsed = SearchQueryRequestSchema.parse({
        q: "riemann",
      });
      expect(parsed.q).toBe("riemann");
      expect(parsed.kind).toBe("all");
      expect(parsed.limit).toBe(20);
    });

    test("accepts explicit kind and limit", () => {
      const parsed = SearchQueryRequestSchema.parse({
        q: "P-123",
        kind: "problem",
        limit: "10",
      });
      expect(parsed.kind).toBe("problem");
      expect(parsed.limit).toBe(10);
    });

    test("rejects empty or whitespace-only queries", () => {
      expect(() => SearchQueryRequestSchema.parse({ q: "" })).toThrow();
      expect(() => SearchQueryRequestSchema.parse({ q: "   " })).toThrow();
    });

    test("rejects queries exceeding 256 characters", () => {
      expect(() => SearchQueryRequestSchema.parse({ q: "a".repeat(257) })).toThrow();
    });

    test("rejects null bytes in queries", () => {
      expect(() => SearchQueryRequestSchema.parse({ q: "foo\u0000bar" })).toThrow();
    });
  });

  describe("SearchResponseSchema", () => {
    test("validates a full search response with matches and affordances", () => {
      const valid = {
        q: "riemann hypothesis",
        source_cursor: 12,
        total_matches: 1,
        items: [
          {
            kind: "claim",
            id: "C-1",
            url: "https://asimposium.org/p/P-1#C-1",
            statement: "Every non-trivial zero has real part one half.",
            snippet: "Every non-trivial zero has **real part** one half.",
            problem_id: "P-1",
            match_type: "lexical_fts",
            score_explanation: "bm25_lexical",
          },
        ],
        omitted: [],
        next_actions: [
          {
            label: "Explore problems",
            method: "GET",
            href: "/explore",
          },
        ],
      };
      expect(() => SearchResponseSchema.parse(valid)).not.toThrow();
    });

    test("validates an empty search response with explanation", () => {
      const empty = {
        q: "nonexistent term",
        source_cursor: 12,
        total_matches: 0,
        items: [],
        omitted: [],
        next_actions: [
          {
            label: "Browse problems",
            method: "GET",
            href: "/problems",
          },
        ],
        explanation: "no_lexical_matches",
      };
      expect(() => SearchResponseSchema.parse(empty)).not.toThrow();
    });
  });
});
