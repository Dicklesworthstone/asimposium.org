import { describe, expect, test } from "bun:test";
import {
  CITATIONS_LIST_DEFAULT_LIMIT,
  CITATIONS_LIST_MAX_LIMIT,
  CITATIONS_SCHEMA_ID,
  CitationIdSchema,
  CitationItemSchema,
  CitationReadQuerySchema,
  CitationsListQuerySchema,
  CitationsListResponseSchema,
  CorrectCitationRequestSchema,
  CorrectCitationResponseSchema,
  canonicalizeLocator,
  citationMatchesQuery,
  citationPath,
  citationsListMatchesQuery,
  citationsListPath,
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
      for (const target of ["L-1\n", "L-1@2\n", "L-1@01", "L-1@9007199254740992", "L-1@2/extra"])
        expect(PublicCitationTargetSchema.safeParse(target).success).toBe(false);
      expect(PublicCitationTargetSchema.safeParse("L-1@9007199254740991").success).toBe(true);
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

  describe("Public citation selection and continuation", () => {
    const citation = CitationItemSchema.parse({
      citation_id: "L-1",
      problem_id: "P-4DSP",
      version: 2,
      seq: 45,
      title: "A checked source",
      authors: ["Research Author"],
      locator_kind: "doi",
      canonical_locator: "10.1000/182",
      source_provenance: "retrieved",
      unanchored: false,
      norm_hash: "citation:doi:10.1000/182",
      author_fellow_id: "F-author",
      created_at: "2026-09-02T12:00:00.000Z",
    });
    const page = CitationsListResponseSchema.parse({
      schema: CITATIONS_SCHEMA_ID,
      problem_id: "P-4DSP",
      cursor: 80,
      after: 40,
      scanned_through: 45,
      next_after: 45,
      unanchored: false,
      citations: [citation],
      omitted: ["Additional citation heads are available after this page."],
    });
    const single = SingleCitationResponseSchema.parse({
      schema: CITATIONS_SCHEMA_ID,
      cursor: 80,
      citation,
      versions: [{ ...citation, version: 1, seq: 20 }, citation],
      associated_claims: [],
      associated_evidence: [],
      omitted: [],
    });

    test("strict string queries preserve the selected snapshot and false provenance filter", () => {
      expect(CitationsListQuerySchema.parse({})).toEqual({});
      expect(
        CitationsListQuerySchema.parse({
          through: "80",
          after: "40",
          limit: "1",
          unanchored: "false",
        }),
      ).toEqual({
        through: 80,
        after: 40,
        limit: 1,
        unanchored: false,
      });
      expect(
        CitationsListQuerySchema.parse({
          through: "0",
          after: "0",
          limit: "200",
          unanchored: "true",
        }),
      ).toEqual({
        through: 0,
        after: 0,
        limit: 200,
        unanchored: true,
      });
      expect(CitationReadQuerySchema.parse({ through: "9007199254740991" })).toEqual({
        through: Number.MAX_SAFE_INTEGER,
      });
      expect(CITATIONS_LIST_DEFAULT_LIMIT).toBe(50);
      expect(CITATIONS_LIST_MAX_LIMIT).toBe(200);
    });

    test("queries reject lossy numbers, incompatible continuations and unsupported selectors", () => {
      for (const through of [
        "",
        "-1",
        "+1",
        "01",
        "1.0",
        "1e2",
        " 1",
        "1 ",
        "1\n",
        "0\n",
        "9007199254740992",
        1,
      ]) {
        expect(CitationsListQuerySchema.safeParse({ through }).success).toBe(false);
        expect(CitationReadQuerySchema.safeParse({ through }).success).toBe(false);
      }
      for (const query of [
        { after: "0" },
        { through: "40", after: "41" },
        { limit: "0" },
        { limit: "201" },
        { limit: "1\n" },
        { unanchored: true },
        { unanchored: "1" },
        { unanchored: "FALSE" },
        { unanchored: "false\n" },
        { target: "L-1" },
        { before: "40" },
        { through: ["40", "50"] },
      ])
        expect(CitationsListQuerySchema.safeParse(query).success).toBe(false);
      for (const query of [
        { after: "0" },
        { limit: "1" },
        { unanchored: "true" },
        { target: "L-1@1" },
      ])
        expect(CitationReadQuerySchema.safeParse(query).success).toBe(false);
    });

    test("an empty filtered or withheld page can advance without pretending the collection is complete", () => {
      expect(CitationsListResponseSchema.safeParse({ ...page, citations: [] }).success).toBe(true);
      for (const mutation of [
        { after: 46 },
        { scanned_through: 81 },
        { next_after: 40 },
        { next_after: 44 },
        { omitted: [] },
      ])
        expect(CitationsListResponseSchema.safeParse({ ...page, ...mutation }).success).toBe(false);
      expect(
        CitationsListResponseSchema.safeParse({ ...page, next_after: null, omitted: [] }).success,
      ).toBe(true);
    });

    test("list pages enforce unique scoped heads in sequence order within the selected cut and filter", () => {
      const other = { ...citation, citation_id: "L-2", seq: 44 };
      for (const citations of [
        [{ ...citation, problem_id: "P-OTHER" }],
        [{ ...citation, seq: 40 }],
        [{ ...citation, seq: 46 }],
        [{ ...citation, unanchored: true }],
        [citation, other],
        [other, { ...citation, citation_id: "L-2" }],
      ])
        expect(CitationsListResponseSchema.safeParse({ ...page, citations }).success).toBe(false);
      expect(
        CitationsListResponseSchema.safeParse({ ...page, citations: [other, citation] }).success,
      ).toBe(true);
      for (const key of [
        "cursor",
        "after",
        "scanned_through",
        "next_after",
        "unanchored",
      ] as const) {
        const incomplete: Record<string, unknown> = { ...page };
        delete incomplete[key];
        expect(CitationsListResponseSchema.safeParse(incomplete).success).toBe(false);
      }
    });

    test("a successful response must match its requested scope, snapshot, filter and page size", () => {
      const query = { through: 80, after: 40, limit: 1, unanchored: false };
      expect(citationsListMatchesQuery("P-4DSP", query, page)).toBe(true);
      expect(citationsListMatchesQuery("P-OTHER", query, page)).toBe(false);
      for (const changed of [{ through: 79 }, { after: 39 }, { unanchored: true }])
        expect(citationsListMatchesQuery("P-4DSP", { ...query, ...changed }, page)).toBe(false);
      expect(citationsListMatchesQuery("P-4DSP", { through: 80, after: 40 }, page)).toBe(false);
      const oversized = {
        ...page,
        after: 0,
        unanchored: null,
        citations: Array.from({ length: 51 }, (_, index) => ({
          ...citation,
          citation_id: `L-${index + 1}`,
          seq: index + 1,
        })),
        scanned_through: 51,
        next_after: 51,
      };
      expect(
        citationsListMatchesQuery("P-4DSP", {}, CitationsListResponseSchema.parse(oversized)),
      ).toBe(false);
    });

    test("exact citation histories reject mixed identities, future or reordered source versions", () => {
      for (const mutation of [
        { cursor: 44 },
        { versions: [citation, { ...citation, version: 1, seq: 20 }] },
        { versions: [{ ...citation, citation_id: "L-2" }] },
        { versions: [{ ...citation, problem_id: "P-OTHER" }] },
        { versions: [{ ...citation, seq: 81 }] },
        { versions: [citation, { ...citation, seq: 46 }] },
      ])
        expect(SingleCitationResponseSchema.safeParse({ ...single, ...mutation }).success).toBe(
          false,
        );
      const { cursor: _cursor, ...uncaptured } = single;
      expect(SingleCitationResponseSchema.safeParse(uncaptured).success).toBe(false);
    });

    test("exact selectors cannot silently substitute another citation, version, snapshot or stale head", () => {
      expect(citationMatchesQuery("P-4DSP", "L-1@2", { through: 80 }, single)).toBe(true);
      expect(citationMatchesQuery("P-4DSP", "L-1", {}, single)).toBe(true);
      expect(citationMatchesQuery("P-OTHER", "L-1", {}, single)).toBe(false);
      expect(citationMatchesQuery("P-4DSP", "L-2", {}, single)).toBe(false);
      expect(citationMatchesQuery("P-4DSP", "L-1@1", {}, single)).toBe(false);
      expect(citationMatchesQuery("P-4DSP", "L-1\n", {}, single)).toBe(false);
      expect(citationMatchesQuery("P-4DSP", "L-1", { through: 79 }, single)).toBe(false);
      const oldVersion = SingleCitationResponseSchema.parse({
        ...single,
        citation: { ...citation, version: 1, seq: 20 },
      });
      expect(citationMatchesQuery("P-4DSP", "L-1", {}, oldVersion)).toBe(false);
      expect(citationMatchesQuery("P-4DSP", "L-1@1", {}, oldVersion)).toBe(true);
    });

    test("links preserve frozen cuts, false filters and exact version identifiers across every face", () => {
      const query = { through: 80, after: 40, limit: 1, unanchored: false };
      expect(citationsListPath("P-4DSP")).toBe("/p/P-4DSP/citations");
      expect(citationsListPath("P-4DSP", "json", query)).toBe(
        "/p/P-4DSP/citations.json?through=80&after=40&limit=1&unanchored=false",
      );
      expect(citationsListPath("P-OTHER/path", "md", { through: 0 })).toBe(
        "/p/P-OTHER%2Fpath/citations.md?through=0",
      );
      for (const format of ["human", "json", "md", "html", "bib", "csl.json"] as const)
        expect(citationPath("P-4DSP", "L-1@2", format, { through: 80 })).toBe(
          `/p/P-4DSP/citations/L-1%402${format === "human" ? "" : `.${format}`}?through=80`,
        );
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
        cursor: 45,
        after: 0,
        scanned_through: 45,
        next_after: null,
        unanchored: null,
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
            screening_notice: {
              category: "dual-use-boundary",
              action: "published-with-warning",
              notice: "screening-warning",
            } as const,
          },
        ],
        omitted: [],
      };
      expect(CitationsListResponseSchema.safeParse(list).success).toBe(true);
      const item = list.citations[0];
      if (item === undefined) throw new Error("missing citation fixture");
      const parsed = CitationItemSchema.parse(item);
      expect(parsed.screening_notice).toEqual(item.screening_notice);
      expect(
        CitationItemSchema.safeParse({
          ...item,
          screening_notice: { ...item.screening_notice, model_version: "PRIVATE-DETECTOR" },
        }).success,
      ).toBe(false);
      expect(
        CitationItemSchema.safeParse({
          ...item,
          screening_notice: { ...item.screening_notice, notice: "unchecked" },
        }).success,
      ).toBe(false);
    });

    test("SingleCitationResponseSchema validates single face with version history and associations", () => {
      const single = {
        schema: CITATIONS_SCHEMA_ID,
        cursor: 45,
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
            screening_notice: {
              category: "dual-use-boundary",
              action: "published-with-warning",
              notice: "screening-warning",
            },
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
        omitted: [],
      };
      expect(SingleCitationResponseSchema.safeParse(single).success).toBe(true);
      const parsed = SingleCitationResponseSchema.parse(single);
      expect(parsed.citation.screening_notice).toBeUndefined();
      expect(parsed.versions[0]?.screening_notice?.notice).toBe("screening-warning");
    });
  });
});
