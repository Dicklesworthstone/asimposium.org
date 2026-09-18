import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  escapeFts5Query,
  parseExactReference,
  SearchQueryRequestSchema,
  SearchResponseSchema,
} from "../../src/search.ts";

describe("W6.8 Search contracts", () => {
  test("served JSON Schema and Zod agree on scoped and unscoped golden queries", async () => {
    const schema = await Bun.file(
      new URL("../../generated/ledger.schema.json", import.meta.url),
    ).json();
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema.properties.search_query_request);
    for (const [path, valid] of [
      ["valid/search-scoped-claim.json", true],
      ["invalid/search-unscoped-claim.json", false],
      ["valid/search-versioned-claim.json", true],
      ["invalid/search-unscoped-version.json", false],
      ["invalid/search-unsupported-cursor.json", false],
    ] as const) {
      const query = await Bun.file(new URL(`../fixtures/${path}`, import.meta.url)).json();
      expect(SearchQueryRequestSchema.safeParse(query).success).toBe(valid);
      expect(validate(query)).toBe(valid);
    }
    for (const cursor of ["", "next-page", null, 1]) {
      const query = { q: "bounded counterexample", cursor };
      expect(SearchQueryRequestSchema.safeParse(query).success).toBe(false);
      expect(validate(query)).toBe(false);
    }
  });
  describe("escapeFts5Query", () => {
    test("quotes plain whitespace-separated tokens", () => {
      expect(escapeFts5Query("riemann hypothesis")).toBe('"riemann" "hypothesis"');
    });

    test("strips special FTS punctuation without throwing syntax errors", () => {
      expect(escapeFts5Query("claim* :type: ^near {test}")).toBe('"claim" "type" "near" "test"');
    });

    test("quotes Boolean-looking words as literal required terms", () => {
      expect(escapeFts5Query("foo AND bar NOT baz OR qux")).toBe(
        '"foo" "AND" "bar" "NOT" "baz" "OR" "qux"',
      );
    });

    test("returns empty string for whitespace, retaining literal operator names", () => {
      expect(escapeFts5Query("")).toBe("");
      expect(escapeFts5Query("   ")).toBe("");
      expect(escapeFts5Query("AND OR NOT NEAR")).toBe('"AND" "OR" "NOT" "NEAR"');
    });

    test("preserves mathematical and compatibility characters for the index tokenizer", () => {
      // Query-only compatibility folding changes terms the index still distinguishes.
      expect(escapeFts5Query("𝑥 ℕ ﬁeld 2²")).toBe('"𝑥" "ℕ" "ﬁeld" "2²"');
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

    test("does not resolve problem-local claim IDs without a problem", () => {
      expect(parseExactReference("C-1")).toBeNull();
      expect(parseExactReference("C-9999")).toBeNull();
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

    test("resolves canonical claim faces and scoped version pins to the same exact target", () => {
      for (const host of ["asimposium.org", "a.asimposium.org", "a-staging.asimposium.org"]) {
        for (const suffix of ["", ".md", ".json", ".html", ".bib", ".csl.json"]) {
          expect(parseExactReference(`https://${host}/p/P-ALPHA/claims/C-1@2${suffix}`)).toEqual({
            kind: "claim",
            id: "C-1",
            problemId: "P-ALPHA",
            version: 2,
          });
        }
      }
      for (const q of [
        "P-ALPHA#C-1@2",
        "P-ALPHA/C-1@2",
        "https://a.asimposium.org/p/P-ALPHA#C-1@2",
        "https://a.asimposium.org/p/P-ALPHA/claims/C-1%402.json",
      ]) {
        expect(parseExactReference(q)).toEqual({
          kind: "claim",
          id: "C-1",
          problemId: "P-ALPHA",
          version: 2,
        });
      }
      expect(parseExactReference("https://asimposium.org/p/P-ALPHA/claims/C-1.json")).toEqual({
        kind: "claim",
        id: "C-1",
        problemId: "P-ALPHA",
      });
    });

    test("refuses ambiguous, unsafe or foreign canonical targets without a head fallback", () => {
      for (const target of [
        "C-1@0",
        "C-1@01",
        "C-1@-1",
        "C-1@9007199254740992",
        "C-1@2.5",
        "C-1@2.json.bib",
        "C-1%2F..",
        "%ZZ",
      ]) {
        expect(parseExactReference(`https://asimposium.org/p/P-ALPHA/claims/${target}`)).toBeNull();
      }
      for (const q of [
        "https://evil.example/p/P-ALPHA/claims/C-1@2",
        "https://asimposium.org.evil.example/p/P-ALPHA/claims/C-1@2",
        "https://evil@asimposium.org/p/P-ALPHA/claims/C-1@2",
        "https://asimposium.org/p/P--ALPHA/claims/C-1@2",
      ]) {
        expect(parseExactReference(q)).toBeNull();
      }
    });

    test("returns null for ordinary lexical queries", () => {
      expect(parseExactReference("prime numbers")).toBeNull();
      expect(parseExactReference("P-")).toBeNull();
      expect(parseExactReference("C-")).toBeNull();
      expect(parseExactReference("not an id P-123")).toBeNull();
      for (const query of ["P-#C-1", "P--ALPHA#C-1", "P-ALPHA#C-", "#C-1", "/C-1"]) {
        expect(parseExactReference(query)).toBeNull();
      }
    });
  });

  describe("SearchQueryRequestSchema", () => {
    test("requires enclosing problem for a local claim reference", () => {
      for (const q of ["C-1", " C-9999 ", "C-1@2"]) {
        const result = SearchQueryRequestSchema.safeParse({ q });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues[0]?.message).toContain("problem");
      }
      for (const q of ["P-ALPHA#C-1", "P-BETA/C-1", "the C-1 boundary"]) {
        expect(SearchQueryRequestSchema.safeParse({ q }).success).toBe(true);
      }
    });
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
