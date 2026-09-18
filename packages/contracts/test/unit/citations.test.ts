import { describe, expect, test } from "bun:test";
import {
  CITATIONS_SCHEMA_ID,
  CitationIdSchema,
  CitationsListResponseSchema,
  CorrectCitationRequestSchema,
  CorrectCitationResponseSchema,
  canonicalizeLocator,
  computeCitationNormHash,
  LOCATOR_KINDS,
  LocatorKindSchema,
  PublicCitationTargetSchema,
  RecordCitationRequestSchema,
  RecordCitationResponseSchema,
  SingleCitationResponseSchema,
  SOURCE_PROVENANCES,
  SourceProvenanceSchema,
} from "../../src/index.ts";

describe("W5.8c Citations contracts", () => {
  describe("Citation identifier and locator primitives", () => {
    test("CitationIdSchema validates L-n IDs and rejects malformed ones", () => {
      expect(CitationIdSchema.safeParse("L-1").success).toBe(true);
      expect(CitationIdSchema.safeParse("L-42").success).toBe(true);
      expect(CitationIdSchema.safeParse("L-99999").success).toBe(true);

      expect(CitationIdSchema.safeParse("").success).toBe(false);
      expect(CitationIdSchema.safeParse("l-1").success).toBe(false);
      expect(CitationIdSchema.safeParse("C-1").success).toBe(false);
      expect(CitationIdSchema.safeParse("L-").success).toBe(false);
      expect(CitationIdSchema.safeParse("L-abc").success).toBe(false);
      expect(CitationIdSchema.safeParse("L--1").success).toBe(false);
    });

    test("PublicCitationTargetSchema validates head and version-pinned targets", () => {
      expect(PublicCitationTargetSchema.safeParse("L-1").success).toBe(true);
      expect(PublicCitationTargetSchema.safeParse("L-1@1").success).toBe(true);
      expect(PublicCitationTargetSchema.safeParse("L-42@3").success).toBe(true);

      expect(PublicCitationTargetSchema.safeParse("L-1@0").success).toBe(false);
      expect(PublicCitationTargetSchema.safeParse("L-1@-1").success).toBe(false);
      expect(PublicCitationTargetSchema.safeParse("L-1@").success).toBe(false);
      expect(PublicCitationTargetSchema.safeParse("invalid").success).toBe(false);
    });

    test("LocatorKindSchema covers all required locator kinds", () => {
      expect(LOCATOR_KINDS).toEqual(["doi", "arxiv", "url", "isbn", "manual", "model_memory"]);
      for (const kind of LOCATOR_KINDS) {
        expect(LocatorKindSchema.safeParse(kind).success).toBe(true);
      }
      expect(LocatorKindSchema.safeParse("unknown").success).toBe(false);
    });

    test("SourceProvenanceSchema covers retrieved and model_memory", () => {
      expect(SOURCE_PROVENANCES).toEqual(["retrieved", "model_memory"]);
      for (const prov of SOURCE_PROVENANCES) {
        expect(SourceProvenanceSchema.safeParse(prov).success).toBe(true);
      }
      expect(SourceProvenanceSchema.safeParse("synthetic").success).toBe(false);
    });
  });

  describe("Locator canonicalization", () => {
    test("canonicalizes DOI identifiers correctly", () => {
      const canonical1 = canonicalizeLocator("doi", "10.1000/182");
      expect(canonical1.canonical).toBe("10.1000/182");
      expect(canonical1.error).toBeUndefined();

      const canonical2 = canonicalizeLocator("doi", "https://doi.org/10.1000/182");
      expect(canonical2.canonical).toBe("10.1000/182");

      const canonical3 = canonicalizeLocator("doi", "http://dx.doi.org/10.1000/182");
      expect(canonical3.canonical).toBe("10.1000/182");

      const invalidDoi = canonicalizeLocator("doi", "not-a-doi");
      expect(invalidDoi.canonical).toBeNull();
      expect(invalidDoi.error).toBeDefined();
    });

    test("canonicalizes arXiv identifiers correctly", () => {
      const canonical1 = canonicalizeLocator("arxiv", "2301.00001");
      expect(canonical1.canonical).toBe("2301.00001");

      const canonical2 = canonicalizeLocator("arxiv", "arXiv:2301.00001v2");
      expect(canonical2.canonical).toBe("2301.00001v2");

      const canonical3 = canonicalizeLocator("arxiv", "https://arxiv.org/abs/2301.00001");
      expect(canonical3.canonical).toBe("2301.00001");

      const canonicalOld = canonicalizeLocator("arxiv", "math.NT/0301001");
      expect(canonicalOld.canonical).toBe("math.nt/0301001");

      const invalidArxiv = canonicalizeLocator("arxiv", "not-an-arxiv-id");
      expect(invalidArxiv.canonical).toBeNull();
      expect(invalidArxiv.error).toBeDefined();
    });

    test("canonicalizes URL locators correctly", () => {
      const canonical1 = canonicalizeLocator("url", "https://example.org/paper/");
      expect(canonical1.canonical).toBe("https://example.org/paper");

      const canonical2 = canonicalizeLocator("url", "https://example.org:443/paper#frag");
      expect(canonical2.canonical).toBe("https://example.org/paper");

      const invalidUrl = canonicalizeLocator("url", "ftp://example.org/paper");
      expect(invalidUrl.canonical).toBeNull();
      expect(invalidUrl.error).toBeDefined();
    });

    test("canonicalizes ISBN locators correctly", () => {
      const canonical1 = canonicalizeLocator("isbn", "978-3-16-148410-0");
      expect(canonical1.canonical).toBe("9783161484100");

      const canonical2 = canonicalizeLocator("isbn", "0-19-853453-1");
      expect(canonical2.canonical).toBe("0198534531");

      const invalidIsbn = canonicalizeLocator("isbn", "12345");
      expect(invalidIsbn.canonical).toBeNull();
      expect(invalidIsbn.error).toBeDefined();
    });

    test("handles manual and model_memory locators correctly", () => {
      const manual = canonicalizeLocator("manual", " Euclid's Elements, Book I ");
      expect(manual.canonical).toBe("Euclid's Elements, Book I");

      const memory = canonicalizeLocator("model_memory", undefined);
      expect(memory.canonical).toBeNull();
      expect(memory.error).toBeUndefined();
    });
  });

  describe("Norm-hash calculation for duplicate prevention", () => {
    test("produces identical hashes for equivalent canonicalized locators", () => {
      const hash1 = computeCitationNormHash(
        "Introduction to Algorithms",
        2009,
        "isbn",
        "9780262033848",
      );
      const hash2 = computeCitationNormHash(
        "Introduction to Algorithms",
        2009,
        "isbn",
        "9780262033848",
      );
      expect(hash1).toBe(hash2);
      expect(hash1).toBe("citation:isbn:9780262033848");
    });

    test("produces distinct hashes for different works", () => {
      const hash1 = computeCitationNormHash(
        "Introduction to Algorithms",
        2009,
        "doi",
        "10.5555/1614191",
      );
      const hash2 = computeCitationNormHash("Concrete Mathematics", 1994, "doi", "10.5555/190347");
      expect(hash1).not.toBe(hash2);
    });

    test("produces normalized memory hashes for model_memory citations", () => {
      const hash1 = computeCitationNormHash("Euler's Totient Theorem", 1736, "model_memory", null);
      const hash2 = computeCitationNormHash(
        "  euler's  totient   theorem  ",
        1736,
        "model_memory",
        null,
      );
      expect(hash1).toBe(hash2);
      expect(hash1).toBe("citation:memory:euler's totient theorem:1736");
    });
  });

  describe("RecordCitationRequestSchema", () => {
    test("validates a retrieved DOI citation", () => {
      const request = {
        title: "A simple proof of the prime number theorem",
        authors: ["Newman, D. J."],
        year: 1980,
        locator_kind: "doi",
        locator: "10.2307/2320499",
        excerpt: "An analytic proof using contour integration and Cauchy's theorem.",
        retrieved_at: "2026-09-01T12:00:00.000Z",
      };
      const parsed = RecordCitationRequestSchema.safeParse(request);
      expect(parsed.success).toBe(true);
    });

    test("validates a retrieved arXiv citation", () => {
      const request = {
        title: "Bounded gaps between primes",
        authors: ["Zhang, Y."],
        year: 2014,
        locator_kind: "arxiv",
        locator: "1305.5553",
        excerpt: "There exist infinitely many pairs of primes that differ by less than 70 million.",
        retrieved_at: "2026-09-01",
      };
      const parsed = RecordCitationRequestSchema.safeParse(request);
      expect(parsed.success).toBe(true);
    });

    test("validates a model_memory citation (Rule P8: no locator, no retrieved_at)", () => {
      const request = {
        title: "Euclid's proof of the infinitude of primes",
        authors: ["Euclid"],
        year: 1500,
        locator_kind: "model_memory",
        source_provenance: "model_memory",
        excerpt: "Assume finitely many primes p_1,...,p_n and consider N = p_1...p_n + 1.",
      };
      const parsed = RecordCitationRequestSchema.safeParse(request);
      expect(parsed.success).toBe(true);
    });

    test("refuses model_memory citation that specifies an external locator", () => {
      const request = {
        title: "Some paper",
        locator_kind: "model_memory",
        locator: "10.1000/182",
      };
      const parsed = RecordCitationRequestSchema.safeParse(request);
      expect(parsed.success).toBe(false);
    });

    test("refuses model_memory citation that asserts retrieved_at", () => {
      const request = {
        title: "Some paper",
        locator_kind: "model_memory",
        retrieved_at: "2026-09-01",
      };
      const parsed = RecordCitationRequestSchema.safeParse(request);
      expect(parsed.success).toBe(false);
    });

    test("refuses retrieved citation missing locator or retrieved_at", () => {
      const missingLocator = {
        title: "Some paper",
        locator_kind: "doi",
        retrieved_at: "2026-09-01",
      };
      expect(RecordCitationRequestSchema.safeParse(missingLocator).success).toBe(false);

      const missingDate = {
        title: "Some paper",
        locator_kind: "doi",
        locator: "10.1000/182",
      };
      expect(RecordCitationRequestSchema.safeParse(missingDate).success).toBe(false);
    });

    test("refuses invalid locator format for specified kind", () => {
      const badDoi = {
        title: "Some paper",
        locator_kind: "doi",
        locator: "not-a-valid-doi",
        retrieved_at: "2026-09-01",
      };
      expect(RecordCitationRequestSchema.safeParse(badDoi).success).toBe(false);
    });
  });

  describe("CorrectCitationRequestSchema", () => {
    test("validates a citation correction with base_version", () => {
      const request = {
        citation_id: "L-1",
        base_version: 1,
        title: "Corrected Title: A simple proof of the prime number theorem",
        authors: ["Newman, Donald J."],
        year: 1980,
        locator_kind: "doi",
        locator: "10.2307/2320499",
        excerpt: "Updated precise anchor from page 693.",
        retrieved_at: "2026-09-02",
        correction_rationale: "Corrected author full name and refined anchor excerpt.",
      };
      const parsed = CorrectCitationRequestSchema.safeParse(request);
      expect(parsed.success).toBe(true);
    });

    test("refuses non-positive base_version", () => {
      const request = {
        citation_id: "L-1",
        base_version: 0,
        title: "Title",
        locator_kind: "doi",
        locator: "10.2307/2320499",
        retrieved_at: "2026-09-02",
      };
      expect(CorrectCitationRequestSchema.safeParse(request).success).toBe(false);
    });
  });

  describe("Responses and item representations", () => {
    test("RecordCitationResponseSchema validates valid response", () => {
      const response = {
        ok: true,
        citation_id: "L-1",
        problem_id: "P-4DSP",
        version: 1,
        seq: 42,
        canonical_locator: "10.2307/2320499",
        norm_hash: "citation:doi:10.2307/2320499",
        source_provenance: "retrieved",
        unanchored: false,
        coercion_flags: [],
        created_at: "2026-09-01T12:00:00.000Z",
      };
      expect(RecordCitationResponseSchema.safeParse(response).success).toBe(true);
    });

    test("CorrectCitationResponseSchema validates valid correction response", () => {
      const response = {
        ok: true,
        citation_id: "L-1",
        problem_id: "P-4DSP",
        version: 2,
        base_version: 1,
        seq: 45,
        canonical_locator: "10.2307/2320499",
        norm_hash: "citation:doi:10.2307/2320499",
        source_provenance: "retrieved",
        unanchored: false,
        coercion_flags: [],
        created_at: "2026-09-02T12:00:00.000Z",
      };
      expect(CorrectCitationResponseSchema.safeParse(response).success).toBe(true);
    });

    test("CitationsListResponseSchema validates list face", () => {
      const list = {
        schema: CITATIONS_SCHEMA_ID,
        problem_id: "P-4DSP",
        citations: [
          {
            citation_id: "L-1",
            problem_id: "P-4DSP",
            version: 1,
            seq: 42,
            title: "Prime Number Theorem",
            authors: ["Newman, D. J."],
            year: 1980,
            locator_kind: "doi",
            locator: "10.2307/2320499",
            canonical_locator: "10.2307/2320499",
            excerpt: "Contour integration proof.",
            retrieved_at: "2026-09-01",
            source_provenance: "retrieved",
            unanchored: false,
            norm_hash: "citation:doi:10.2307/2320499",
            author_fellow_id: "fel_123",
            created_at: "2026-09-01T12:00:00.000Z",
          },
        ],
        omitted: [],
      };
      expect(CitationsListResponseSchema.safeParse(list).success).toBe(true);
    });

    test("SingleCitationResponseSchema validates single face with version history and associations", () => {
      const single = {
        schema: CITATIONS_SCHEMA_ID,
        citation: {
          citation_id: "L-1",
          problem_id: "P-4DSP",
          version: 2,
          seq: 45,
          title: "Prime Number Theorem (Revised)",
          authors: ["Newman, D. J."],
          year: 1980,
          locator_kind: "doi",
          locator: "10.2307/2320499",
          canonical_locator: "10.2307/2320499",
          excerpt: "Contour integration proof with exact lemma citation.",
          retrieved_at: "2026-09-02",
          source_provenance: "retrieved",
          unanchored: false,
          norm_hash: "citation:doi:10.2307/2320499",
          author_fellow_id: "fel_123",
          created_at: "2026-09-01T12:00:00.000Z",
          updated_at: "2026-09-02T12:00:00.000Z",
        },
        versions: [
          {
            citation_id: "L-1",
            problem_id: "P-4DSP",
            version: 1,
            seq: 42,
            title: "Prime Number Theorem",
            authors: ["Newman, D. J."],
            year: 1980,
            locator_kind: "doi",
            locator: "10.2307/2320499",
            canonical_locator: "10.2307/2320499",
            excerpt: "Contour integration proof.",
            retrieved_at: "2026-09-01",
            source_provenance: "retrieved",
            unanchored: false,
            norm_hash: "citation:doi:10.2307/2320499",
            author_fellow_id: "fel_123",
            created_at: "2026-09-01T12:00:00.000Z",
          },
        ],
        associated_claims: [
          {
            claim_id: "C-1",
            version: 1,
            statement: "The asymptotic density of primes satisfies pi(x) ~ x / ln(x).",
          },
        ],
        associated_evidence: [
          {
            evidence_id: "E-1",
            direction: "supports",
            bears_on_id: "C-1",
            computed_class: "citation",
          },
        ],
      };
      expect(SingleCitationResponseSchema.safeParse(single).success).toBe(true);
    });
  });
});
