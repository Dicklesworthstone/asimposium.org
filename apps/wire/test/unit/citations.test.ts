import { describe, expect, test } from "bun:test";
import {
  type CitationItem,
  CitationsListResponseSchema,
  type RecordCitationRequest,
  SingleCitationResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import {
  bibtexForCitation,
  computeCitationCanonicalAndHash,
  cslForCitation,
  loadProblemCitations,
  loadSingleCitation,
  renderCitationsHtml,
  renderCitationsMarkdown,
  renderSingleCitationHtml,
  renderSingleCitationMarkdown,
  validateCitationSubstance,
} from "../../src/ledger/citations";
import { createLedgerFaceRoutes } from "../../src/ledger-face";
import { readLedgerPackSection } from "../../src/sessions/ledger-pack";

describe("W5.8c / citations & source-provenance unit tests", () => {
  const validDoiRequest: RecordCitationRequest = {
    locator_kind: "doi",
    locator: "10.1007/s00222-020-00980-8",
    title: "Bounded gaps between primes",
    authors: ["Yitang Zhang"],
    year: 2014,
    excerpt: "Groundbreaking work establishing bounded prime gaps unconditionally.",
    retrieved_at: "2026-09-01T12:00:00.000Z",
  };

  const validArxivRequest: RecordCitationRequest = {
    locator_kind: "arxiv",
    locator: "1301.0001",
    title: "Sieve methods and prime distributions",
    authors: ["Jane Doe", "John Smith"],
    year: 2013,
    excerpt: "Survey of sieve bounds applicable to modular prime questions.",
    retrieved_at: "2026-09-02T10:00:00.000Z",
  };

  const validUrlRequest: RecordCitationRequest = {
    locator_kind: "url",
    locator: "https://example.org/papers/modular-cycles.pdf",
    title: "Modular Cycle Properties in Valuation Spaces",
    authors: ["Alice Mathematician"],
    year: 2022,
    excerpt: "Examines cycle bounds under p-adic valuations.",
    retrieved_at: "2026-09-03T08:00:00.000Z",
  };

  const validIsbnRequest: RecordCitationRequest = {
    locator_kind: "isbn",
    locator: "978-0-387-95385-4",
    title: "Algebraic Geometry",
    authors: ["Robin Hartshorne"],
    year: 1977,
    excerpt: "Standard reference for scheme-theoretic foundations and cohomology.",
    retrieved_at: "2026-09-03T08:00:00.000Z",
  };

  const validModelMemoryRequest: RecordCitationRequest = {
    locator_kind: "model_memory",
    title: "Cramer probabilistic heuristic on prime gaps",
    authors: [],
    excerpt: "Standard heuristic asserting prime gaps are asymptotic to log squared p.",
    source_provenance: "model_memory",
  };

  describe("validateCitationSubstance", () => {
    test("accepts valid requests for all locator kinds", () => {
      expect(validateCitationSubstance(validDoiRequest).valid).toBe(true);
      expect(validateCitationSubstance(validArxivRequest).valid).toBe(true);
      expect(validateCitationSubstance(validUrlRequest).valid).toBe(true);
      expect(validateCitationSubstance(validIsbnRequest).valid).toBe(true);
      expect(validateCitationSubstance(validModelMemoryRequest).valid).toBe(true);
    });

    test("rejects short or placeholder titles", () => {
      for (const badTitle of ["TODO", "cite", "paper", "ref", "test", "abc", "   "]) {
        const res = validateCitationSubstance({
          ...validDoiRequest,
          title: badTitle,
        });
        expect(res.valid).toBe(false);
      }
    });

    test("rejects short or low-substance excerpts", () => {
      for (const badExcerpt of ["short", "TODO", "placeholder", "cited here", "ref", ""]) {
        const res = validateCitationSubstance({
          ...validDoiRequest,
          excerpt: badExcerpt,
        });
        expect(res.valid).toBe(false);
      }
    });

    test("enforces Rule P8 on model_memory citations", () => {
      // Cannot have external locator
      const withLocator = validateCitationSubstance({
        ...validModelMemoryRequest,
        locator: "https://external.org",
      });
      expect(withLocator.valid).toBe(false);
      if (!withLocator.valid) {
        expect(withLocator.reason).toContain("cannot have an external locator");
      }

      // Cannot have retrieved_at
      const withRetrieved = validateCitationSubstance({
        ...validModelMemoryRequest,
        retrieved_at: "2026-09-01T00:00:00.000Z",
      });
      expect(withRetrieved.valid).toBe(false);
      if (!withRetrieved.valid) {
        expect(withRetrieved.reason).toContain("cannot have a retrieved_at timestamp");
      }

      // Cannot have retrieved provenance
      const nonAssertion = validateCitationSubstance({
        ...validModelMemoryRequest,
        source_provenance: "retrieved",
      });
      expect(nonAssertion.valid).toBe(false);
      if (!nonAssertion.valid) {
        expect(nonAssertion.reason).toContain("source_provenance must be 'model_memory'");
      }
    });

    test("validates external locator formats", () => {
      // DOI must look like a DOI
      const badDoi = validateCitationSubstance({
        ...validDoiRequest,
        locator: "invalid-doi-format",
      });
      expect(badDoi.valid).toBe(false);

      // arXiv must look like arXiv ID
      const badArxiv = validateCitationSubstance({
        ...validArxivRequest,
        locator: "totally-not-arxiv",
      });
      expect(badArxiv.valid).toBe(false);

      // URL must be http/https
      const badUrl = validateCitationSubstance({
        ...validUrlRequest,
        locator: "ftp://example.org/file.pdf",
      });
      expect(badUrl.valid).toBe(false);

      // ISBN must have 10 or 13 digits
      const badIsbn = validateCitationSubstance({
        ...validIsbnRequest,
        locator: "12345",
      });
      expect(badIsbn.valid).toBe(false);
    });
  });

  describe("computeCitationCanonicalAndHash", () => {
    test("canonicalizes DOI identifiers correctly", () => {
      const canonical1 = computeCitationCanonicalAndHash({
        ...validDoiRequest,
        locator: "https://doi.org/10.1007/S00222-020-00980-8",
      });
      const canonical2 = computeCitationCanonicalAndHash({
        ...validDoiRequest,
        locator: "10.1007/s00222-020-00980-8",
      });
      expect(canonical1.canonical_locator).toBe("10.1007/s00222-020-00980-8");
      expect(canonical2.canonical_locator).toBe("10.1007/s00222-020-00980-8");
      expect(canonical1.norm_hash).toBe(canonical2.norm_hash);
    });

    test("canonicalizes arXiv identifiers correctly", () => {
      const canonical1 = computeCitationCanonicalAndHash({
        ...validArxivRequest,
        locator: "https://arxiv.org/abs/1301.0001",
      });
      const canonical2 = computeCitationCanonicalAndHash({
        ...validArxivRequest,
        locator: "arXiv:1301.0001",
      });
      expect(canonical1.canonical_locator).toBe("1301.0001");
      expect(canonical2.canonical_locator).toBe("1301.0001");
      expect(canonical1.norm_hash).toBe(canonical2.norm_hash);

      const versioned = computeCitationCanonicalAndHash({
        ...validArxivRequest,
        locator: "https://arxiv.org/abs/1301.0001v2",
      });
      expect(versioned.canonical_locator).toBe("1301.0001v2");
    });

    test("canonicalizes URLs (trailing slashes stripped)", () => {
      const canonical1 = computeCitationCanonicalAndHash({
        ...validUrlRequest,
        locator: "https://example.org/papers/modular-cycles.pdf/",
      });
      const canonical2 = computeCitationCanonicalAndHash({
        ...validUrlRequest,
        locator: "https://example.org/papers/modular-cycles.pdf",
      });
      expect(canonical1.canonical_locator).toBe("https://example.org/papers/modular-cycles.pdf");
      expect(canonical1.norm_hash).toBe(canonical2.norm_hash);
    });

    test("canonicalizes ISBN (hyphens and whitespace stripped)", () => {
      const canonical1 = computeCitationCanonicalAndHash({
        ...validIsbnRequest,
        locator: "978-0-387-95385-4",
      });
      const canonical2 = computeCitationCanonicalAndHash({
        ...validIsbnRequest,
        locator: "9780387953854",
      });
      expect(canonical1.canonical_locator).toBe("9780387953854");
      expect(canonical1.norm_hash).toBe(canonical2.norm_hash);
    });

    test("model_memory hashes normalized title", () => {
      const canonical1 = computeCitationCanonicalAndHash({
        ...validModelMemoryRequest,
        title: "Cramer Probabilistic Heuristic on Prime Gaps",
      });
      const canonical2 = computeCitationCanonicalAndHash({
        ...validModelMemoryRequest,
        title: "cramer probabilistic heuristic on prime gaps",
      });
      expect(canonical1.canonical_locator).toBeNull();
      expect(canonical1.norm_hash).toBe(canonical2.norm_hash);
    });
  });

  describe("bibtexForCitation and cslForCitation", () => {
    test("generates valid BibTeX with special character escaping", () => {
      const bib = bibtexForCitation({
        citation_id: "L-1",
        problem_id: "P-MATH",
        version: 1,
        seq: 1,
        title: "Bounded gaps & sieves with 100% rigor #1",
        authors: ["Jane Doe", "John Smith"],
        year: 2020,
        locator_kind: "doi",
        locator: "10.1007/s00222-020-00980-8",
        canonical_locator: "10.1007/s00222-020-00980-8",
        source_provenance: "retrieved",
        unanchored: false,
        norm_hash: "test_hash_1",
        author_fellow_id: "F-1",
        created_at: "2026-09-01T12:00:00.000Z",
      });
      expect(bib).toContain("@article{L-1,");
      expect(bib).toContain("title = {Bounded gaps & sieves with 100% rigor #1},");
      expect(bib).toContain("author = {Jane Doe and John Smith},");
      expect(bib).toContain("doi = {10.1007/s00222-020-00980-8},");
      expect(bib).toContain("year = {2020},");
    });

    test("generates CSL-JSON item structure", () => {
      const csl = cslForCitation({
        citation_id: "L-2",
        problem_id: "P-MATH",
        version: 1,
        seq: 2,
        title: "Algebraic Geometry",
        authors: ["Robin Hartshorne"],
        year: 1977,
        locator_kind: "isbn",
        locator: "9780387953854",
        canonical_locator: "9780387953854",
        source_provenance: "retrieved",
        unanchored: false,
        norm_hash: "test_hash_2",
        author_fellow_id: "F-1",
        created_at: "2026-09-01T12:00:00.000Z",
      });
      expect(csl.id).toBe("L-2");
      expect(csl.type).toBe("book");
      expect(csl.title).toBe("Algebraic Geometry");
      expect(csl.author).toEqual([{ literal: "Robin Hartshorne" }]);
      expect(csl.issued).toEqual({ "date-parts": [[1977]] });
      expect(csl.ISBN).toBe("9780387953854");
    });
  });

  describe("renderCitationsMarkdown & renderCitationsHtml", () => {
    const sampleCitations: CitationItem[] = [
      {
        citation_id: "L-1",
        problem_id: "P-MATH",
        version: 2,
        seq: 5,
        locator_kind: "doi" as const,
        locator: "10.1007/s00222-020-00980-8",
        canonical_locator: "10.1007/s00222-020-00980-8",
        norm_hash: "abc123hash",
        title: "Bounded gaps between primes",
        authors: ["Yitang Zhang"],
        year: 2014,
        excerpt: "Foundational prime gap bounds.",
        retrieved_at: "2026-09-01T12:00:00.000Z",
        source_provenance: "retrieved",
        unanchored: false,
        author_fellow_id: "F-FELLOW-1",
        sponsor_id: "SPON-1",
        session_id: "SES-1",
        declared_model: "test-model",
        harness: "test-harness",
        created_at: "2026-09-01T12:00:00.000Z",
        updated_at: "2026-09-02T12:00:00.000Z",
      },
    ];

    test("renderCitationsMarkdown renders complete attribution and no leaderboards", () => {
      const md = renderCitationsMarkdown("P-MATH", sampleCitations, ["omission note"]);
      expect(md).toContain("# Literature & Citations — Problem P-MATH");
      expect(md).toContain("[L-1@v2] Bounded gaps between primes");
      expect(md).toContain("- **Authors**: Yitang Zhang (2014)");
      expect(md).toContain("- **Locator**: `doi` — 10.1007/s00222-020-00980-8");
      expect(md).toContain("- **Provenance**: `retrieved`");
      expect(md).toContain("- **Attribution**: Fellow `F-FELLOW-1` · Sponsor `SPON-1`");
      expect(md).toContain("### Deliberate Omissions");
      expect(md).toContain("- omission note");

      // Rule A10: No aggregate counts or leaderboards
      expect(md).not.toContain("Total citations:");
      expect(md).not.toContain("Leaderboard");
    });

    test("renderCitationsHtml renders HTML face with Diptych links", () => {
      const html = renderCitationsHtml("P-MATH", sampleCitations);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Literature & Citations");
      expect(html).toContain("L-1");
      expect(html).toContain("Bounded gaps between primes");
      expect(html).toContain("/p/P-MATH/citations.json");
      expect(html).toContain("/p/P-MATH/citations.md");
    });

    test("renderSingleCitationMarkdown renders detail, versions, and export links", () => {
      const sampleCitation = sampleCitations[0];
      if (!sampleCitation) throw new Error("sampleCitation missing");
      const md = renderSingleCitationMarkdown("P-MATH", {
        citation: sampleCitation,
        versions: [{ ...sampleCitation, version: 1, title: "Initial Title" }, sampleCitation],
        associated_claims: [{ claim_id: "C-1", version: 1, statement: "Claim 1 statement" }],
        associated_evidence: [
          {
            evidence_id: "E-1",
            direction: "supports",
            bears_on_id: "C-1",
            computed_class: "direct",
          },
        ],
      });
      expect(md).toContain("# Citation [L-1@v2] — Problem P-MATH");
      expect(md).toContain("### Version History");
      expect(md).toContain("- **v1**");
      expect(md).toContain("- **v2**");
      expect(md).toContain("### Associated Claims");
      expect(md).toContain("[C-1@v1]: Claim 1 statement");
      expect(md).toContain("/p/P-MATH/citations/L-1.bib");
      expect(md).toContain("/p/P-MATH/citations/L-1.csl.json");
    });

    test("renderSingleCitationHtml renders sanitized card and export links", () => {
      const sampleCitation = sampleCitations[0];
      if (!sampleCitation) throw new Error("sampleCitation missing");
      const html = renderSingleCitationHtml("P-MATH", {
        citation: sampleCitation,
        versions: [{ ...sampleCitation, version: 1, title: "Initial Title" }, sampleCitation],
        associated_claims: [{ claim_id: "C-1", version: 1, statement: "Claim 1 statement" }],
        associated_evidence: [
          {
            evidence_id: "E-1",
            direction: "supports",
            bears_on_id: "C-1",
            computed_class: "direct",
          },
        ],
      });
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("L-1");
      expect(html).toContain("/p/P-MATH/citations/L-1.bib");
      expect(html).toContain("/p/P-MATH/citations/L-1.csl.json");
    });
  });

  describe("loadProblemCitations and loadSingleCitation", () => {
    test("loadProblemCitations handles missing problem", async () => {
      const db = {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
          }),
        }),
      } as unknown as D1Database;

      const result = await loadProblemCitations(db, "P-MISSING");
      expect(result.citations).toHaveLength(0);
      expect(result.omitted).toContain("problem not found");
    });

    test("loadProblemCitations parses citation rows correctly", async () => {
      const mockRows = [
        {
          citation_id: "L-1",
          problem_id: "P-MATH",
          version: 1,
          seq: 10,
          locator_kind: "doi",
          locator: "10.1007/s00222-020-00980-8",
          canonical_locator: "10.1007/s00222-020-00980-8",
          norm_hash: "hash123",
          title: "Bounded gaps between primes",
          authors_json: JSON.stringify(["Yitang Zhang"]),
          year: 2014,
          venue: "Annals of Mathematics",
          volume: "179",
          issue: "3",
          pages: "1121-1174",
          context: "Foundational prime gap bounds.",
          retrieved_at: "2026-09-01T12:00:00.000Z",
          assertion_only: 0,
          author_fellow_id: "F-FELLOW-1",
          actor_sponsor_id: "SPON-1",
          actor_session_id: "SES-1",
          model_string_self_declared: "model-test",
          harness: "harness-test",
          created_at: "2026-09-01T12:00:00.000Z",
          corrected_at: null,
          content_available: 1,
        },
      ];

      const db = {
        prepare: (query: string) => ({
          bind: (..._args: unknown[]) => ({
            first: async () => ({ public_seq: 100, status: "open" }),
            all: async () => {
              if (query.includes("FROM citations")) {
                return { results: mockRows };
              }
              return { results: [] };
            },
          }),
        }),
      } as unknown as D1Database;

      const result = await loadProblemCitations(db, "P-MATH");
      expect(result.citations).toHaveLength(1);
      const c = result.citations[0];
      if (!c) throw new Error("c missing");
      expect(c.citation_id).toBe("L-1");
      expect(c.locator_kind).toBe("doi");
      expect(c.authors).toEqual(["Yitang Zhang"]);
      expect(c.source_provenance).toBe("retrieved");
      expect(c.unanchored).toBe(false);
    });

    test("loadSingleCitation loads specific version", async () => {
      const mockCitationRow = {
        citation_id: "L-1",
        problem_id: "P-MATH",
        version: 2,
        seq: 15,
        locator_kind: "doi",
        locator: "10.1007/s00222-020-00980-8",
        canonical_locator: "10.1007/s00222-020-00980-8",
        norm_hash: "hash123",
        title: "Bounded gaps between primes (v2)",
        authors_json: JSON.stringify(["Yitang Zhang"]),
        year: 2014,
        venue: "Annals of Mathematics",
        volume: "179",
        issue: "3",
        pages: "1121-1174",
        context: "Updated context note.",
        retrieved_at: "2026-09-01T12:00:00.000Z",
        assertion_only: 0,
        author_fellow_id: "F-FELLOW-1",
        actor_sponsor_id: "SPON-1",
        actor_session_id: "SES-1",
        model_string_self_declared: "model-test",
        harness: "harness-test",
        created_at: "2026-09-01T12:00:00.000Z",
        corrected_at: "2026-09-02T12:00:00.000Z",
        content_available: 1,
      };

      const mockVersionRow = {
        citation_id: "L-1",
        problem_id: "P-MATH",
        version: 1,
        seq: 10,
        locator_kind: "doi",
        locator: "10.1007/s00222-020-00980-8",
        canonical_locator: "10.1007/s00222-020-00980-8",
        norm_hash: "hash123",
        title: "Bounded gaps between primes (v1)",
        authors_json: JSON.stringify(["Yitang Zhang"]),
        year: 2014,
        venue: "Annals of Mathematics",
        volume: "179",
        issue: "3",
        pages: "1121-1174",
        context: "Initial context note.",
        retrieved_at: "2026-09-01T12:00:00.000Z",
        assertion_only: 0,
        author_fellow_id: "F-FELLOW-1",
        actor_sponsor_id: "SPON-1",
        actor_session_id: "SES-1",
        model_string_self_declared: "model-test",
        harness: "harness-test",
        created_at: "2026-09-01T12:00:00.000Z",
      };

      const db = {
        prepare: (query: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => {
              if (query.includes("FROM problems")) {
                return { public_seq: 100, status: "open" };
              }
              if (query.includes("FROM citation_versions")) {
                const requestedVersion = args[2];
                if (requestedVersion === 1) return mockVersionRow;
                return mockCitationRow;
              }
              if (query.includes("FROM citations")) {
                return mockCitationRow;
              }
              return null;
            },
            all: async () => {
              if (query.includes("FROM citation_versions")) {
                return {
                  results: [mockVersionRow, mockCitationRow],
                };
              }
              return { results: [] };
            },
          }),
        }),
      } as unknown as D1Database;

      // Load head (L-1)
      const headResult = await loadSingleCitation(db, "P-MATH", "L-1");
      expect(headResult).toBeDefined();
      if (!headResult) throw new Error("expected headResult");
      expect(headResult.citation.version).toBe(2);
      expect(headResult.citation.title).toBe("Bounded gaps between primes (v2)");
      expect(headResult.versions).toHaveLength(2);

      // Load specific version (L-1@1)
      const v1Result = await loadSingleCitation(db, "P-MATH", "L-1@1");
      expect(v1Result).toBeDefined();
      if (!v1Result) throw new Error("expected v1Result");
      expect(v1Result.citation.version).toBe(1);
      expect(v1Result.citation.title).toBe("Bounded gaps between primes (v1)");
    });
  });

  describe("Public Ledger Face Routes for Citations", () => {
    const problemRow = {
      id: "P-CITATIONS",
      public_seq: 10,
      status: "open",
      chain_digest: "chain-1",
      row_digest: "row-1",
      formulation_json: JSON.stringify({
        title: "Citation Test Problem",
        statement: "A test problem for citations.",
        falsifier: "A test falsifier.",
        motivation: "Testing citation faces.",
      }),
    };

    const citationRow = {
      citation_id: "L-1",
      problem_id: "P-CITATIONS",
      version: 1,
      seq: 2,
      locator_kind: "doi",
      locator: "10.1007/s00222-020-00980-8",
      canonical_locator: "10.1007/s00222-020-00980-8",
      norm_hash: "norm_hash_1",
      title: "Bounded gaps between primes",
      authors_json: JSON.stringify(["Yitang Zhang"]),
      year: 2014,
      venue: "Annals of Mathematics",
      volume: "179",
      issue: "3",
      pages: "1121-1174",
      context: "Foundational prime gap bounds.",
      retrieved_at: "2026-09-01T12:00:00.000Z",
      source_provenance: "retrieved",
      assertion_only: 0,
      author_fellow_id: "F-UNIT-CITATION",
      actor_sponsor_id: "SPON-1",
      actor_session_id: "SES-1",
      model_string_self_declared: "model-unit",
      harness: "harness-unit",
      created_at: "2026-09-01T12:00:00.000Z",
      corrected_at: null,
      content_available: 1,
    };

    const db = {
      prepare: (query: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (query.includes("FROM problems")) {
              if (args[0] === "P-CITATIONS") return problemRow;
              return null;
            }
            if (query.includes("FROM citations") || query.includes("FROM citation_versions")) {
              if (args[0] === "P-CITATIONS" && args[1] === "L-1") return citationRow;
              return null;
            }
            return null;
          },
          all: async () => {
            if (
              query.includes("FROM citations") &&
              !query.includes("WHERE problem_id = ? AND id = ?")
            ) {
              return { results: [citationRow] };
            }
            if (query.includes("FROM citation_versions")) {
              return {
                results: [citationRow],
              };
            }
            return { results: [] };
          },
        }),
      }),
    } as unknown as Env["DB"];

    const env = { DB: db } as unknown as Env;
    const app = createLedgerFaceRoutes();

    test("serves GET /p/:id/citations.json", async () => {
      const res = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations.json",
        {},
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = CitationsListResponseSchema.parse(await res.json());
      expect(body.citations).toHaveLength(1);
      expect(body.citations[0]?.citation_id).toBe("L-1");
      expect(body.citations[0]?.locator_kind).toBe("doi");
    });

    test("serves GET /p/:id/literature.json as canonical alias", async () => {
      const res = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/literature.json",
        {},
        env,
      );
      expect(res.status).toBe(200);
      const body = CitationsListResponseSchema.parse(await res.json());
      expect(body.citations).toHaveLength(1);
    });

    test("serves GET /p/:id/citations.md and .html", async () => {
      const mdRes = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations.md",
        {},
        env,
      );
      expect(mdRes.status).toBe(200);
      expect(mdRes.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      const mdText = await mdRes.text();
      expect(mdText).toContain("[L-1] Bounded gaps between primes");
      expect(mdText).toContain("Bounded gaps between primes");

      const htmlRes = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations.html",
        {},
        env,
      );
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const htmlText = await htmlRes.text();
      expect(htmlText).toContain("L-1");
      expect(htmlText).toContain("Bounded gaps between primes");
    });

    test("serves GET /p/:id/citations/:target in json, md, html, bib, and csl.json", async () => {
      // JSON single object
      const jsonRes = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations/L-1.json",
        {},
        env,
      );
      expect(jsonRes.status).toBe(200);
      const jsonObj = SingleCitationResponseSchema.parse(await jsonRes.json());
      expect(jsonObj.citation.citation_id).toBe("L-1");
      expect(jsonObj.citation.version).toBe(1);

      // Markdown
      const mdRes = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations/L-1.md",
        {},
        env,
      );
      expect(mdRes.status).toBe(200);
      expect(await mdRes.text()).toContain("# Citation [L-1] — Problem P-CITATIONS");

      // HTML
      const htmlRes = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations/L-1.html",
        {},
        env,
      );
      expect(htmlRes.status).toBe(200);
      expect(await htmlRes.text()).toContain("L-1");

      // BibTeX
      const bibRes = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations/L-1.bib",
        {},
        env,
      );
      expect(bibRes.status).toBe(200);
      expect(bibRes.headers.get("content-type")).toBe("application/x-bibtex; charset=utf-8");
      expect(await bibRes.text()).toContain("@article{L-1,");

      // CSL JSON
      const cslRes = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations/L-1.csl.json",
        {},
        env,
      );
      expect(cslRes.status).toBe(200);
      expect(cslRes.headers.get("content-type")).toBe(
        "application/vnd.citationstyles.csl+json; charset=utf-8",
      );
      const cslJson = (await cslRes.json()) as { id: string; title: string };
      expect(cslJson.id).toBe("L-1");
      expect(cslJson.title).toBe("Bounded gaps between primes");
    });

    test("returns 404 for missing problem or non-existent citation", async () => {
      const pNotFound = await app.request(
        "https://a.asimposium.org/p/P-NONEXISTENT/citations.json",
        {},
        env,
      );
      expect(pNotFound.status).toBe(404);

      const cNotFound = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations/L-999.json",
        {},
        env,
      );
      expect(cNotFound.status).toBe(404);
    });

    test("returns 304 on matching ETag", async () => {
      const first = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations.json",
        {},
        env,
      );
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const second = await app.request(
        "https://a.asimposium.org/p/P-CITATIONS/citations.json",
        { headers: { "if-none-match": etag ?? "" } },
        env,
      );
      expect(second.status).toBe(304);
    });

    test("readLedgerPackSection populates literature candidates", async () => {
      const mockResultRows = [
        {
          id: "L-1",
          version: 1,
          title: "Bounded gaps between primes",
          authors_json: JSON.stringify(["Yitang Zhang"]),
          year: 2014,
          locator_kind: "doi",
          locator: "10.1007/s00222-020-00980-8",
          canonical_locator: "10.1007/s00222-020-00980-8",
          excerpt: "Foundational prime gap bounds.",
          retrieved_at: "2026-09-01T12:00:00.000Z",
          source_provenance: "retrieved",
          unanchored: 0,
          event_id: "E-1",
          seq: 1,
          fellow_id: "F-FELLOW-1",
          sponsor_id: "SPON-1",
          session_id: "SES-1",
          model: "test-model",
          harness: "test-harness",
          content_available: 1,
        },
      ];

      const packDb = {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: mockResultRows }),
          }),
        }),
      } as unknown as Env["DB"];

      const section = await readLedgerPackSection(packDb, "P-CITATIONS", 10, "literature");
      expect(section.candidates).toHaveLength(1);
      expect(section.candidates[0]?.kind).toBe("citation");
      expect(section.candidates[0]?.id).toBe("L-1");
      expect(section.candidates[0]?.why_included).toContain("recorded literature");
      expect(section.omitted).toHaveLength(0);
    });
  });
});
