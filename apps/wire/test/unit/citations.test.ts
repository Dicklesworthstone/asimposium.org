import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CITATIONS_SCHEMA_ID,
  type CitationItem,
  CitationsListResponseSchema,
  type RecordCitationRequest,
  SingleCitationResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { CitationReadError } from "../../src/ledger/citation-read";
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

function sampleCitation(overrides: Partial<CitationItem> = {}): CitationItem {
  return {
    citation_id: "L-1",
    problem_id: "P-MATH",
    version: 1,
    seq: 2,
    locator_kind: "doi",
    locator: "10.1007/s00222-020-00980-8",
    canonical_locator: "10.1007/s00222-020-00980-8",
    norm_hash: "citation:doi:10.1007/s00222-020-00980-8",
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
    ...overrides,
  };
}

/** Real SQLite SQL-unit fixture, not a deployed D1 or migration/chain proof. */
function citationDatabase(problemId = "P-MATH") {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE problems (
      id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER DEFAULT 0
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER,
      payload_sha256 TEXT, created_at TEXT, actor_fellow_id TEXT,
      actor_sponsor_id TEXT, actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT
    );
    CREATE TABLE event_content (
      event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT
    );
    CREATE TABLE content_controls (
      problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER
    );
    CREATE TABLE citations (problem_id TEXT, citation_id TEXT, title TEXT);
    CREATE TABLE screening_publications(event_id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL);
  `);
  sqlite
    .query("INSERT INTO problems (id, public_seq, status) VALUES (?, 100, 'open')")
    .run(problemId);
  sqlite
    .query("INSERT INTO citations VALUES (?, 'L-1', 'PRIVATE_PROJECTION_CANARY')")
    .run(problemId);
  const prepare = (sql: string) => {
    let values: Array<string | number | null> = [];
    const statement = {
      bind: (...args: Array<string | number | null>) => {
        values = args;
        return statement;
      },
      first: async () => sqlite.query(sql).get(...values) ?? null,
      all: async () => ({ success: true, results: sqlite.query(sql).all(...values) }),
    };
    return statement;
  };
  const db = {
    prepare,
    batch: async (statements: Array<ReturnType<typeof prepare>>) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  async function seed(item: CitationItem) {
    const payload = JSON.stringify({
      citation_id: item.citation_id,
      title: item.title,
      authors: item.authors,
      year: item.year ?? null,
      locator_kind: item.locator_kind,
      locator: item.locator ?? null,
      canonical_locator: item.canonical_locator ?? null,
      excerpt: item.excerpt ?? null,
      retrieved_at: item.retrieved_at ?? null,
      source_provenance: item.source_provenance,
      unanchored: item.unanchored,
      norm_hash: item.norm_hash,
      coercion_flags: [],
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const id = `${item.problem_id}-${item.seq}`;
    sqlite
      .query("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        item.problem_id,
        item.seq,
        item.version === 1 ? "citation.recorded" : "citation.corrected",
        "citation",
        item.citation_id,
        item.version,
        hash,
        item.created_at,
        item.author_fellow_id,
        item.sponsor_id ?? null,
        item.session_id ?? null,
        item.declared_model ?? null,
        item.harness ?? null,
      );
    sqlite.query("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, hash, payload);
    return id;
  }
  return { sqlite, db, seed };
}

async function withPublicCitation(
  run: (fixture: ReturnType<typeof citationDatabase>, env: Env) => Promise<void>,
) {
  const fixture = citationDatabase("P-CITATIONS");
  try {
    await fixture.seed(sampleCitation({ problem_id: "P-CITATIONS" }));
    await run(fixture, { DB: fixture.db } as unknown as Env);
  } finally {
    fixture.sqlite.close();
  }
}

const app = createLedgerFaceRoutes();
const publicUrl = "https://a.asimposium.org/p/P-CITATIONS";
const citationWarning = {
  category: "dual-use-boundary",
  action: "published-with-warning",
  notice: "screening-warning",
} as const;
const citationWarningText = "Published with a screening context notice: dual-use-boundary.";

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
      for (const request of [
        validDoiRequest,
        validArxivRequest,
        validUrlRequest,
        validIsbnRequest,
        validModelMemoryRequest,
      ]) {
        expect(validateCitationSubstance(request).valid).toBe(true);
      }
    });
    test("rejects short or placeholder titles", () => {
      for (const title of ["TODO", "cite", "paper", "ref", "test", "abc", "   "]) {
        expect(validateCitationSubstance({ ...validDoiRequest, title }).valid).toBe(false);
      }
    });
    test("rejects short or low-substance excerpts", () => {
      for (const excerpt of ["short", "TODO", "placeholder", "cited here", "ref", ""]) {
        expect(validateCitationSubstance({ ...validDoiRequest, excerpt }).valid).toBe(false);
      }
    });
    test("enforces Rule P8 on model_memory citations", () => {
      const withLocator = validateCitationSubstance({
        ...validModelMemoryRequest,
        locator: "https://external.org",
      });
      expect(withLocator.valid).toBe(false);
      if (!withLocator.valid)
        expect(withLocator.reason).toContain("cannot have an external locator");
      const withRetrieved = validateCitationSubstance({
        ...validModelMemoryRequest,
        retrieved_at: "2026-09-01T00:00:00.000Z",
      });
      expect(withRetrieved.valid).toBe(false);
      if (!withRetrieved.valid)
        expect(withRetrieved.reason).toContain("cannot have a retrieved_at timestamp");
      const nonAssertion = validateCitationSubstance({
        ...validModelMemoryRequest,
        source_provenance: "retrieved",
      });
      expect(nonAssertion.valid).toBe(false);
      if (!nonAssertion.valid)
        expect(nonAssertion.reason).toContain("source_provenance must be 'model_memory'");
    });
    test("validates external locator formats", () => {
      expect(
        validateCitationSubstance({ ...validDoiRequest, locator: "invalid-doi-format" }).valid,
      ).toBe(false);
      expect(
        validateCitationSubstance({ ...validArxivRequest, locator: "totally-not-arxiv" }).valid,
      ).toBe(false);
      expect(
        validateCitationSubstance({ ...validUrlRequest, locator: "ftp://example.org/file.pdf" })
          .valid,
      ).toBe(false);
      expect(validateCitationSubstance({ ...validIsbnRequest, locator: "12345" }).valid).toBe(
        false,
      );
    });
  });

  describe("computeCitationCanonicalAndHash", () => {
    test("canonicalizes DOI identifiers correctly", () => {
      const first = computeCitationCanonicalAndHash({
        ...validDoiRequest,
        locator: "https://doi.org/10.1007/S00222-020-00980-8",
      });
      const second = computeCitationCanonicalAndHash(validDoiRequest);
      expect(first.canonical_locator).toBe("10.1007/s00222-020-00980-8");
      expect(second.canonical_locator).toBe(first.canonical_locator);
      expect(first.norm_hash).toBe(second.norm_hash);
    });
    test("canonicalizes arXiv identifiers correctly", () => {
      const first = computeCitationCanonicalAndHash({
        ...validArxivRequest,
        locator: "https://arxiv.org/abs/1301.0001",
      });
      const second = computeCitationCanonicalAndHash({
        ...validArxivRequest,
        locator: "arXiv:1301.0001",
      });
      expect(first.canonical_locator).toBe("1301.0001");
      expect(second.canonical_locator).toBe(first.canonical_locator);
      expect(first.norm_hash).toBe(second.norm_hash);
      expect(
        computeCitationCanonicalAndHash({
          ...validArxivRequest,
          locator: "https://arxiv.org/abs/1301.0001v2",
        }).canonical_locator,
      ).toBe("1301.0001v2");
    });
    test("canonicalizes URLs (trailing slashes stripped)", () => {
      const first = computeCitationCanonicalAndHash({
        ...validUrlRequest,
        locator: "https://example.org/papers/modular-cycles.pdf/",
      });
      const second = computeCitationCanonicalAndHash(validUrlRequest);
      expect(first.canonical_locator).toBe("https://example.org/papers/modular-cycles.pdf");
      expect(first.norm_hash).toBe(second.norm_hash);
    });
    test("canonicalizes ISBN (hyphens and whitespace stripped)", () => {
      const first = computeCitationCanonicalAndHash(validIsbnRequest);
      const second = computeCitationCanonicalAndHash({
        ...validIsbnRequest,
        locator: "9780387953854",
      });
      expect(first.canonical_locator).toBe("9780387953854");
      expect(first.norm_hash).toBe(second.norm_hash);
    });
    test("model_memory hashes normalized title", () => {
      const first = computeCitationCanonicalAndHash({
        ...validModelMemoryRequest,
        title: "Cramer Probabilistic Heuristic on Prime Gaps",
      });
      const second = computeCitationCanonicalAndHash({
        ...validModelMemoryRequest,
        title: "cramer probabilistic heuristic on prime gaps",
      });
      expect(first.canonical_locator).toBeNull();
      expect(first.norm_hash).toBe(second.norm_hash);
    });
  });

  describe("bibtexForCitation and cslForCitation", () => {
    test("generates BibTeX fields", () => {
      const bib = bibtexForCitation(
        sampleCitation({
          title: "Bounded gaps & sieves with 100% rigor #1",
          authors: ["Jane Doe", "John Smith"],
          year: 2020,
        }),
      );
      expect(bib).toContain("@article{L-1,");
      expect(bib).toContain("title = {Bounded gaps & sieves with 100% rigor #1},");
      expect(bib).toContain("author = {Jane Doe and John Smith},");
      expect(bib).toContain("doi = {10.1007/s00222-020-00980-8},");
      expect(bib).toContain("year = {2020},");
    });
    test("generates CSL-JSON item structure", () => {
      const csl = cslForCitation(
        sampleCitation({
          citation_id: "L-2",
          title: "Algebraic Geometry",
          authors: ["Robin Hartshorne"],
          year: 1977,
          locator_kind: "isbn",
          locator: "9780387953854",
          canonical_locator: "9780387953854",
        }),
      );
      expect(csl.id).toBe("L-2");
      expect(csl.type).toBe("book");
      expect(csl.title).toBe("Algebraic Geometry");
      expect(csl.author).toEqual([{ literal: "Robin Hartshorne" }]);
      expect(csl.issued).toEqual({ "date-parts": [[1977]] });
      expect(csl.ISBN).toBe("9780387953854");
    });
    test("warning exports retain one standard note alongside retrieval or model-memory provenance", () => {
      for (const item of [
        sampleCitation({ screening_notice: citationWarning }),
        sampleCitation({
          screening_notice: citationWarning,
          locator_kind: "model_memory",
          locator: null,
          canonical_locator: null,
          retrieved_at: null,
          source_provenance: "model_memory",
          unanchored: true,
        }),
      ]) {
        const bib = bibtexForCitation(item);
        expect(bib).toContain(citationWarningText);
        expect(bib.match(/^ {2}note = /gm)).toHaveLength(1);
        expect(bib).toContain(
          item.retrieved_at ? `Retrieved: ${item.retrieved_at}` : "Source: model memory",
        );
        const csl = cslForCitation(item);
        expect(csl.note).toContain(citationWarningText);
        expect(csl).not.toHaveProperty("screening_notice");
        if (item.retrieved_at) expect(csl.accessed).toEqual({ raw: item.retrieved_at });
        else expect(csl.note).toContain("Source: model memory");
      }
      const forged = bibtexForCitation(
        sampleCitation({
          screening_notice: citationWarning,
          retrieved_at: "2026-09-01},\n  note = {FORGED-NOTE",
        }),
      );
      expect(forged).toContain(citationWarningText);
      expect(forged).not.toContain("2026-09-01},");
    });
  });

  describe("renderCitationsMarkdown & renderCitationsHtml", () => {
    const item = sampleCitation({ version: 2, seq: 5 });
    const detail = {
      citation: item,
      versions: [{ ...item, version: 1, seq: 2, title: "Initial Title" }, item],
      associated_claims: [{ claim_id: "C-1", version: 1, statement: "Claim 1 statement" }],
      associated_evidence: [
        { evidence_id: "E-1", direction: "supports", bears_on_id: "C-1", computed_class: "direct" },
      ],
    };
    test("renderCitationsMarkdown renders complete attribution and no leaderboards", () => {
      const md = renderCitationsMarkdown("P-MATH", [item], ["omission note"]);
      expect(md).toContain("# Literature & Citations — Problem P-MATH");
      expect(md).toContain("[L-1@v2] Bounded gaps between primes");
      expect(md).toContain("- **Authors**: Yitang Zhang (2014)");
      expect(md).toContain("- **Locator**: `doi` — 10.1007/s00222-020-00980-8");
      expect(md).toContain("- **Provenance**: `retrieved`");
      expect(md).toContain("- **Attribution**: Fellow `F-FELLOW-1` · Sponsor `SPON-1`");
      expect(md).toContain("### Deliberate Omissions");
      expect(md).toContain("- omission note");
      expect(md).not.toContain("Total citations:");
      expect(md).not.toContain("Leaderboard");
    });
    test("renderCitationsHtml renders HTML face with Diptych links", () => {
      const html = renderCitationsHtml("P-MATH", [item]);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Literature & Citations");
      expect(html).toContain("Bounded gaps between primes");
      expect(html).toContain("/p/P-MATH/citations.json");
      expect(html).toContain("/p/P-MATH/citations.md");
      expect(html).toContain("/p/P-MATH/citations/L-1@2.html");
    });
    test("renderSingleCitationMarkdown renders detail, versions, and pinned export links", () => {
      const md = renderSingleCitationMarkdown("P-MATH", detail);
      expect(md).toContain("# Citation [L-1@v2] — Problem P-MATH");
      expect(md).toContain("### Available Version History");
      expect(md).toContain("[v1](/p/P-MATH/citations/L-1@1.md)");
      expect(md).toContain("[v2](/p/P-MATH/citations/L-1@2.md)");
      expect(md).toContain("### Associated Claims");
      expect(md).toContain("[C-1@v1](/p/P-MATH/claims/C-1@1.md): Claim 1 statement");
      expect(md).toContain("/p/P-MATH/citations/L-1@2.bib");
      expect(md).toContain("/p/P-MATH/citations/L-1@2.csl.json");
      expect(md).not.toContain("/citations/L-1.bib");
    });
    test("renderSingleCitationHtml renders sanitized card and pinned export links", () => {
      const html = renderSingleCitationHtml("P-MATH", detail);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("L-1");
      expect(html).toContain("/p/P-MATH/citations/L-1@2.bib");
      expect(html).toContain("/p/P-MATH/citations/L-1@2.csl.json");
      expect(html).toContain("/p/P-MATH/claims/C-1@1.html");
      expect(html).not.toContain("/citations/L-1.bib");
    });
    test("citation reading faces retain current and historical warnings on the corresponding version", () => {
      const warned = { ...item, screening_notice: citationWarning };
      for (const body of [
        renderCitationsMarkdown("P-MATH", [warned]),
        renderCitationsHtml("P-MATH", [warned]),
      ]) {
        expect(body).toContain(citationWarningText);
        expect(body.indexOf(citationWarningText)).toBeLessThan(
          body.indexOf("Foundational prime gap bounds."),
        );
      }
      const original = detail.versions[0];
      if (original === undefined) throw new Error("missing historical citation fixture");
      const history = {
        ...detail,
        versions: [{ ...original, screening_notice: citationWarning }, item],
      };
      for (const render of [renderSingleCitationHtml, renderSingleCitationMarkdown]) {
        const body = render("P-MATH", history);
        expect(body).toContain(citationWarningText);
        expect(body.indexOf(citationWarningText)).toBeLessThan(body.indexOf("Initial Title"));
        expect(body.split(citationWarningText)).toHaveLength(2);
        const current = render("P-MATH", { ...detail, citation: warned, versions: [warned] });
        expect(current).toContain(citationWarningText);
        expect(current.indexOf(citationWarningText)).toBeLessThan(
          current.indexOf("Foundational prime gap bounds."),
        );
      }
    });
    test("associated claim notices precede the full statement in Markdown and HTML", () => {
      const claim = detail.associated_claims[0];
      if (claim === undefined) throw new Error("claim fixture missing");
      const warned = {
        ...detail,
        associated_claims: [
          {
            ...claim,
            screening_notice: {
              category: "dual-use-boundary",
              action: "published-with-warning",
              notice: "screening-warning",
            } as const,
          },
        ],
      };
      for (const render of [renderSingleCitationHtml, renderSingleCitationMarkdown]) {
        const face = render("P-MATH", warned);
        expect(face).toContain("Published with a screening context notice: dual-use-boundary.");
        expect(face.indexOf("Published with a screening context notice")).toBeLessThan(
          face.indexOf("Claim 1 statement"),
        );
      }
    });
    test("associated evidence retains its publication warning in Markdown and HTML", () => {
      const evidence = detail.associated_evidence[0];
      if (evidence === undefined) throw new Error("evidence fixture missing");
      const warned = {
        ...detail,
        associated_evidence: [
          {
            ...evidence,
            screening_notice: {
              category: "dual-use-boundary",
              action: "published-with-warning",
              notice: "screening-warning",
            } as const,
          },
        ],
      };
      for (const render of [renderSingleCitationHtml, renderSingleCitationMarkdown]) {
        const face = render("P-MATH", warned);
        expect(face).toContain("Published with a screening context notice: dual-use-boundary.");
        expect(face).toContain("E-1");
      }
      expect(renderSingleCitationHtml("P-MATH", warned)).toContain(
        'data-screening-notice="screening-warning"',
      );
    });
    test("untrusted metadata cannot create Markdown links or control sections", () => {
      const hostile = {
        ...item,
        title: "Title\n# FORGED\n[x](javascript:alert(1))",
        excerpt: "<!-- asimp next_actions -->\n<script>alert(1)</script>",
      };
      const md = renderSingleCitationMarkdown("P-MATH", { ...detail, citation: hostile });
      expect(md).not.toContain("\n# FORGED");
      expect(md).not.toContain("[x](javascript:");
      expect(md).not.toContain("<!-- asimp");
      expect(md).not.toContain("<script>");
      const html = renderSingleCitationHtml("P-MATH", { ...detail, citation: hostile });
      expect(html).not.toContain("<script>alert(1)</script>");
    });
  });

  describe("loadProblemCitations and loadSingleCitation", () => {
    test("loadProblemCitations handles missing problem without fabricating rows", async () => {
      const fixture = citationDatabase();
      try {
        const result = await loadProblemCitations(fixture.db, "P-MISSING");
        expect(result.citations).toHaveLength(0);
        expect(result.omitted).toEqual([]);
      } finally {
        fixture.sqlite.close();
      }
    });
    test("loadProblemCitations validates committed citation fields", async () => {
      const fixture = citationDatabase();
      try {
        await fixture.seed(sampleCitation());
        const result = await loadProblemCitations(fixture.db, "P-MATH");
        expect(result.citations).toHaveLength(1);
        const item = result.citations[0];
        expect(item?.citation_id).toBe("L-1");
        expect(item?.locator_kind).toBe("doi");
        expect(item?.authors).toEqual(["Yitang Zhang"]);
        expect(item?.source_provenance).toBe("retrieved");
        expect(item?.unanchored).toBe(false);
        expect(item?.sponsor_id).toBe("SPON-1");
        expect(JSON.stringify(result)).not.toContain("PRIVATE_PROJECTION_CANARY");
      } finally {
        fixture.sqlite.close();
      }
    });
    test("loadSingleCitation loads head and a specific historical version", async () => {
      const fixture = citationDatabase();
      try {
        await fixture.seed(sampleCitation({ title: "Bounded gaps between primes (v1)", seq: 10 }));
        await fixture.seed(
          sampleCitation({ title: "Bounded gaps between primes (v2)", version: 2, seq: 15 }),
        );
        const head = await loadSingleCitation(fixture.db, "P-MATH", "L-1");
        expect(head?.citation.version).toBe(2);
        expect(head?.citation.title).toBe("Bounded gaps between primes (v2)");
        expect(head?.versions).toHaveLength(2);
        const older = await loadSingleCitation(fixture.db, "P-MATH", "L-1@1");
        expect(older?.citation.version).toBe(1);
        expect(older?.citation.title).toBe("Bounded gaps between primes (v1)");
        const cut = await loadSingleCitation(fixture.db, "P-MATH", "L-1", { through: 10 });
        expect(cut?.citation.version).toBe(1);
        expect(cut?.versions).toHaveLength(1);
      } finally {
        fixture.sqlite.close();
      }
    });
    test("a valid checksum does not bypass the canonical citation schema", async () => {
      const fixture = citationDatabase();
      try {
        await fixture.seed(sampleCitation({ title: "x".repeat(1001) }));
        const result = await loadProblemCitations(fixture.db, "P-MATH");
        expect(result.citations).toHaveLength(0);
        expect(result.omitted.join(" ")).toContain("unavailable");
        await expect(loadSingleCitation(fixture.db, "P-MATH", "L-1")).rejects.toEqual(
          new CitationReadError("CONTENT_UNAVAILABLE"),
        );
      } finally {
        fixture.sqlite.close();
      }
    });
    test("continuations reach every selected head at the original cut after later corrections", async () => {
      const fixture = citationDatabase();
      try {
        for (let index = 1; index <= 52; index++)
          await fixture.seed(sampleCitation({ citation_id: `L-${index}`, seq: index }));
        await fixture.seed(
          sampleCitation({ version: 2, seq: 60, title: "Corrected first source" }),
        );
        const first = await loadProblemCitations(fixture.db, "P-MATH");
        expect(first.problem).toEqual({ id: "P-MATH", unlisted: 0 });
        expect(first.cursor).toBe(100);
        expect(first.after).toBe(0);
        expect(first.scanned_through).toBe(51);
        expect(first.next_after).toBe(51);
        expect(first.citations).toHaveLength(50);
        expect(first.citations[0]?.citation_id).toBe("L-2");
        expect(first.citations.at(-1)?.citation_id).toBe("L-51");
        const { problem: _scope, ...face } = first;
        expect(
          CitationsListResponseSchema.safeParse({
            schema: CITATIONS_SCHEMA_ID,
            problem_id: "P-MATH",
            ...face,
          }).success,
        ).toBe(true);

        await fixture.seed(
          sampleCitation({ citation_id: "L-52", version: 2, seq: 101, title: "Later correction" }),
        );
        await fixture.seed(
          sampleCitation({ citation_id: "L-53", seq: 102, title: "Later publication" }),
        );
        fixture.sqlite.query("UPDATE problems SET public_seq=102 WHERE id='P-MATH'").run();
        const second = await loadProblemCitations(fixture.db, "P-MATH", {
          through: first.cursor,
          after: first.next_after ?? 0,
        });
        expect(second.citations.map((item) => [item.citation_id, item.version, item.seq])).toEqual([
          ["L-52", 1, 52],
          ["L-1", 2, 60],
        ]);
        expect(second.cursor).toBe(100);
        expect(second.scanned_through).toBe(100);
        expect(second.next_after).toBeNull();
        expect(
          new Set([...first.citations, ...second.citations].map((item) => item.citation_id)).size,
        ).toBe(52);
        const fresh = await loadProblemCitations(fixture.db, "P-MATH", { limit: 200 });
        expect(fresh.citations.at(-2)?.version).toBe(2);
        expect(fresh.citations.at(-1)?.citation_id).toBe("L-53");
      } finally {
        fixture.sqlite.close();
      }
    });
    test("withheld and filtered heads advance empty pages without reviving older versions", async () => {
      const fixture = citationDatabase();
      try {
        await fixture.seed(sampleCitation({ seq: 1 }));
        await fixture.seed(sampleCitation({ version: 2, seq: 2, title: "WITHHELD_HEAD_CANARY" }));
        await fixture.seed(sampleCitation({ citation_id: "L-2", seq: 3 }));
        await fixture.seed(
          sampleCitation({
            citation_id: "L-3",
            seq: 4,
            unanchored: true,
            locator_kind: "model_memory",
            locator: null,
            canonical_locator: null,
            retrieved_at: null,
            source_provenance: "model_memory",
          }),
        );
        fixture.sqlite.exec("INSERT INTO content_controls VALUES('P-MATH','L-1@2','hidden',1)");
        const first = await loadProblemCitations(fixture.db, "P-MATH", {
          limit: 1,
          unanchored: true,
        });
        expect(first.citations).toEqual([]);
        expect(first.next_after).toBe(2);
        expect(first.omitted.join(" ")).toContain("unavailable");
        const second = await loadProblemCitations(fixture.db, "P-MATH", {
          through: first.cursor,
          after: first.next_after ?? 0,
          limit: 1,
          unanchored: true,
        });
        expect(second.citations).toEqual([]);
        expect(second.next_after).toBe(3);
        expect(second.omitted.join(" ")).toContain("filter");
        const third = await loadProblemCitations(fixture.db, "P-MATH", {
          through: first.cursor,
          after: second.next_after ?? 0,
          limit: 1,
          unanchored: true,
        });
        expect(third.citations.map((item) => item.citation_id)).toEqual(["L-3"]);
        expect(third.next_after).toBeNull();
        expect(third.scanned_through).toBe(first.cursor);
        expect(await loadSingleCitation(fixture.db, "P-MATH", "L-1")).toBeNull();
        expect((await loadSingleCitation(fixture.db, "P-MATH", "L-1@1"))?.citation.version).toBe(1);
        expect(JSON.stringify([first, second, third])).not.toContain("WITHHELD_HEAD_CANARY");
      } finally {
        fixture.sqlite.close();
      }
    });
    test("exact versions beyond the history window remain readable with bounded history disclosures", async () => {
      const fixture = citationDatabase();
      try {
        fixture.sqlite.query("UPDATE problems SET public_seq=300 WHERE id='P-MATH'").run();
        for (let version = 1; version <= 205; version++)
          await fixture.seed(
            sampleCitation({ version, seq: version, title: `Published source version ${version}` }),
          );
        for (const [target, version] of [
          ["L-1", 205],
          ["L-1@204", 204],
        ] as const) {
          const exact = await loadSingleCitation(fixture.db, "P-MATH", target);
          expect(exact?.citation.version).toBe(version);
          expect(exact?.cursor).toBe(300);
          expect(exact?.versions).toHaveLength(200);
          expect(exact?.omitted.join(" ")).toContain("bounded to 200");
          expect(exact?.problem).toEqual({ id: "P-MATH", unlisted: 0 });
          const { problem: _scope, ...face } = exact ?? {};
          expect(
            SingleCitationResponseSchema.safeParse({ schema: CITATIONS_SCHEMA_ID, ...face })
              .success,
          ).toBe(true);
        }
        expect(
          (await loadSingleCitation(fixture.db, "P-MATH", "L-1", { through: 201 }))?.citation
            .version,
        ).toBe(201);
        fixture.sqlite.exec("INSERT INTO content_controls VALUES('P-MATH','L-1@205','hidden',1)");
        expect(await loadSingleCitation(fixture.db, "P-MATH", "L-1")).toBeNull();
        expect((await loadSingleCitation(fixture.db, "P-MATH", "L-1@204"))?.citation.version).toBe(
          204,
        );
        fixture.sqlite.exec("INSERT INTO content_controls VALUES('P-MATH','L-1@205','visible',2)");
        fixture.sqlite
          .query("UPDATE event_content SET payload_json='{}' WHERE event_id='P-MATH-205'")
          .run();
        await expect(loadSingleCitation(fixture.db, "P-MATH", "L-1")).rejects.toEqual(
          new CitationReadError("CONTENT_UNAVAILABLE"),
        );
        expect((await loadProblemCitations(fixture.db, "P-MATH")).citations).toEqual([]);
      } finally {
        fixture.sqlite.close();
      }
    });
    test("the source-byte limit continues before the first whole record that exceeds it", async () => {
      const fixture = citationDatabase();
      try {
        const authors = Array.from({ length: 300 }, (_, index) => `${index}`.padEnd(195, "a"));
        for (let index = 1; index <= 80; index++)
          await fixture.seed(sampleCitation({ citation_id: `L-${index}`, seq: index, authors }));
        const first = await loadProblemCitations(fixture.db, "P-MATH", { limit: 200 });
        expect(first.citations.length).toBeGreaterThan(1);
        expect(first.citations.length).toBeLessThan(80);
        expect(first.omitted.join(" ")).toContain("source-byte budget");
        expect(first.next_after).toBe(first.citations.at(-1)?.seq ?? -1);
        const second = await loadProblemCitations(fixture.db, "P-MATH", {
          limit: 200,
          through: first.cursor,
          after: first.next_after ?? 0,
        });
        expect(second.citations[0]?.seq).toBe((first.next_after ?? 0) + 1);
        expect(second.next_after).toBeNull();
        expect([...first.citations, ...second.citations].map((item) => item.citation_id)).toEqual(
          Array.from({ length: 80 }, (_, index) => `L-${index + 1}`),
        );
        const exact = await loadSingleCitation(fixture.db, "P-MATH", "L-80@1");
        expect(exact?.citation.authors).toEqual(authors);
        fixture.sqlite.query("UPDATE problems SET public_seq=200 WHERE id='P-MATH'").run();
        for (let version = 2; version <= 40; version++)
          await fixture.seed(sampleCitation({ version, seq: version + 100, authors }));
        const deep = await loadSingleCitation(fixture.db, "P-MATH", "L-1");
        expect(deep?.citation.version).toBe(40);
        expect(deep?.citation.authors).toEqual(authors);
        expect(deep?.versions.length).toBeLessThan(40);
        expect(deep?.omitted.join(" ")).toContain("history source-byte budget");
      } finally {
        fixture.sqlite.close();
      }
    });
    test("invalid continuation bounds and future cuts are refused instead of silently clamped", async () => {
      const fixture = citationDatabase();
      try {
        await fixture.seed(sampleCitation());
        for (const query of [
          { after: 0 },
          { after: 3, through: 2 },
          { through: 101 },
          { limit: 201 },
          { limit: 1.5 },
          { through: -1 },
        ])
          await expect(loadProblemCitations(fixture.db, "P-MATH", query)).rejects.toEqual(
            new CitationReadError("CURSOR_INVALID"),
          );
        await expect(
          loadSingleCitation(fixture.db, "P-MATH", "L-1", { through: 101 }),
        ).rejects.toEqual(new CitationReadError("CURSOR_INVALID"));
        expect(
          (await loadProblemCitations(fixture.db, "P-MATH", { through: 0 })).citations,
        ).toEqual([]);
        expect(await loadSingleCitation(fixture.db, "P-MATH", "L-1@1", { through: 0 })).toBeNull();
        expect(await loadSingleCitation(fixture.db, "P-MATH", "L-1@1\n")).toBeNull();
      } finally {
        fixture.sqlite.close();
      }
    });
  });

  describe("Public Ledger Face Routes for Citations", () => {
    test("citation warnings survive all public faces and bibliography exports, invalidate caches, and stay withheld with hidden content", async () => {
      const receipt = JSON.parse(
        readFileSync(
          new URL(
            "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await withPublicCitation(async (fixture, env) => {
        const targets = [
          "citations.json",
          "citations.md",
          "citations.html",
          "literature.json",
          ...["json", "md", "html", "bib", "csl.json"].map((suffix) => `citations/L-1@1.${suffix}`),
        ];
        const originalEtags = new Map<string, string>();
        for (const target of targets) {
          const response = await app.request(`${publicUrl}/${target}`, {}, env);
          expect(response.status).toBe(200);
          const etag = response.headers.get("etag");
          if (etag === null) throw new Error("missing citation ETag");
          originalEtags.set(target, etag);
        }
        fixture.sqlite
          .query("INSERT INTO screening_publications VALUES('P-CITATIONS-2',?)")
          .run(JSON.stringify(receipt));
        for (const target of targets) {
          const response = await app.request(
            `${publicUrl}/${target}`,
            { headers: { "if-none-match": originalEtags.get(target) ?? "" } },
            env,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("etag")).not.toBe(originalEtags.get(target));
          const body = await response.text();
          expect(body).not.toContain(receipt.input_digest);
          expect(body).not.toContain(receipt.model_version);
          if (target.endsWith(".csl.json")) {
            expect(JSON.parse(body).note).toContain(citationWarningText);
          } else if (target.endsWith(".json")) {
            if (target.includes("L-1")) {
              const face = SingleCitationResponseSchema.parse(JSON.parse(body));
              expect(face.citation.screening_notice).toEqual(receipt.public_action);
              expect(face.versions[0]?.screening_notice).toEqual(receipt.public_action);
            } else {
              expect(
                CitationsListResponseSchema.parse(JSON.parse(body)).citations[0]?.screening_notice,
              ).toEqual(receipt.public_action);
            }
          } else expect(body).toContain(citationWarningText);
        }
        fixture.sqlite
          .query("UPDATE screening_publications SET provenance_json=?")
          .run(JSON.stringify({ ...receipt, private_detail: "PRIVATE-DETECTOR-CANARY" }));
        const corrupt = await app.request(`${publicUrl}/citations/L-1@1.bib`, {}, env);
        expect(corrupt.status).toBeGreaterThanOrEqual(500);
        expect(await corrupt.text()).not.toContain("PRIVATE-DETECTOR-CANARY");
        fixture.sqlite
          .query("INSERT INTO content_controls VALUES('P-CITATIONS','L-1@1','hidden',1)")
          .run();
        for (const suffix of ["json", "md", "html", "bib", "csl.json"]) {
          const hidden = await app.request(`${publicUrl}/citations/L-1@1.${suffix}`, {}, env);
          expect(hidden.status).toBe(404);
          expect(await hidden.text()).not.toContain(citationWarningText);
        }
        const list = await app.request(`${publicUrl}/citations.json`, {}, env);
        expect(list.status).toBe(200);
        expect(CitationsListResponseSchema.parse(await list.json()).citations).toEqual([]);
      });
    });
    test("serves GET /p/:id/citations.json", async () => {
      await withPublicCitation(async (_fixture, env) => {
        const response = await app.request(`${publicUrl}/citations.json`, {}, env);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
        const body = CitationsListResponseSchema.parse(await response.json());
        expect(body.citations).toHaveLength(1);
        expect(body.citations[0]?.citation_id).toBe("L-1");
        expect(body.citations[0]?.locator_kind).toBe("doi");
      });
    });
    test("serves GET /p/:id/literature.json as canonical alias", async () => {
      await withPublicCitation(async (_fixture, env) => {
        const response = await app.request(`${publicUrl}/literature.json`, {}, env);
        expect(response.status).toBe(200);
        expect(CitationsListResponseSchema.parse(await response.json()).citations).toHaveLength(1);
      });
    });
    test("serves GET /p/:id/citations.md and .html", async () => {
      await withPublicCitation(async (_fixture, env) => {
        const md = await app.request(`${publicUrl}/citations.md`, {}, env);
        expect(md.status).toBe(200);
        expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
        expect(await md.text()).toContain("[L-1] Bounded gaps between primes");
        const html = await app.request(`${publicUrl}/citations.html`, {}, env);
        expect(html.status).toBe(200);
        expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
        const text = await html.text();
        expect(text).toContain("L-1");
        expect(text).toContain("Bounded gaps between primes");
      });
    });
    test("serves a single citation in json, md, html, bib, and csl.json", async () => {
      await withPublicCitation(async (_fixture, env) => {
        const base = `${publicUrl}/citations/L-1`;
        const json = await app.request(`${base}.json`, {}, env);
        expect(json.status).toBe(200);
        const data = SingleCitationResponseSchema.parse(await json.json());
        expect(data.citation.citation_id).toBe("L-1");
        expect(data.citation.version).toBe(1);
        const md = await app.request(`${base}.md`, {}, env);
        expect(md.status).toBe(200);
        expect(await md.text()).toContain("# Citation [L-1] — Problem P-CITATIONS");
        const html = await app.request(`${base}.html`, {}, env);
        expect(html.status).toBe(200);
        expect(await html.text()).toContain("L-1");
        const bib = await app.request(`${base}.bib`, {}, env);
        expect(bib.status).toBe(200);
        expect(bib.headers.get("content-type")).toBe("application/x-bibtex; charset=utf-8");
        expect(await bib.text()).toContain("@article{L-1,");
        const csl = await app.request(`${base}.csl.json`, {}, env);
        expect(csl.status).toBe(200);
        expect(csl.headers.get("content-type")).toBe(
          "application/vnd.citationstyles.csl+json; charset=utf-8",
        );
        const cslData = (await csl.json()) as { id: string; title: string };
        expect(cslData.id).toBe("L-1");
        expect(cslData.title).toBe("Bounded gaps between primes");
      });
    });
    test("returns 404 for missing problem or non-existent citation", async () => {
      await withPublicCitation(async (_fixture, env) => {
        const missingProblem = await app.request(
          "https://a.asimposium.org/p/P-NONEXISTENT/citations.json",
          {},
          env,
        );
        expect(missingProblem.status).toBe(404);
        const missingCitation = await app.request(`${publicUrl}/citations/L-999.json`, {}, env);
        expect(missingCitation.status).toBe(404);
      });
    });
    test("returns 304 on matching ETag", async () => {
      await withPublicCitation(async (_fixture, env) => {
        const first = await app.request(`${publicUrl}/citations.json`, {}, env);
        const etag = first.headers.get("etag");
        expect(etag).toBeTruthy();
        const second = await app.request(
          `${publicUrl}/citations.json`,
          {
            headers: { "if-none-match": etag ?? "" },
          },
          env,
        );
        expect(second.status).toBe(304);
        expect(await second.text()).toBe("");
      });
    });
    test("old exact validators cannot conceal source corruption or turn failed reads into empty success", async () => {
      await withPublicCitation(async (fixture, env) => {
        const representations = new Map<string, { body: string; etag: string }>();
        for (const format of ["json", "md", "html", "bib", "csl.json"]) {
          const path = `${publicUrl}/citations/L-1@1.${format}?through=10`;
          const response = await app.request(path, {}, env);
          expect(response.status).toBe(200);
          const etag = response.headers.get("etag");
          expect(etag).toBeTruthy();
          representations.set(path, { body: await response.text(), etag: etag ?? "" });
        }
        const source = fixture.sqlite
          .query("SELECT payload_json FROM event_content WHERE event_id='P-CITATIONS-2'")
          .get() as { payload_json: string };
        fixture.sqlite
          .query(
            "UPDATE event_content SET payload_json=payload_json || ' ' WHERE event_id='P-CITATIONS-2'",
          )
          .run();
        for (const [path, original] of representations) {
          for (const method of ["GET", "HEAD"]) {
            const response = await app.request(
              path,
              { method, headers: { "if-none-match": original.etag } },
              env,
            );
            expect(response.status).toBe(503);
            expect(response.headers.get("cache-control")).toBe("private, no-store");
            expect(response.headers.get("retry-after")).toBeTruthy();
            expect(response.headers.get("etag")).toBeNull();
            const body = await response.text();
            if (method === "HEAD") expect(body).toBe("");
            else expect(JSON.parse(body).code).toBe("INTERNAL_ERROR");
            expect(body).not.toContain("Bounded gaps between primes");
            expect(body).not.toContain("PRIVATE_PROJECTION_CANARY");
          }
        }
        fixture.sqlite
          .query("UPDATE event_content SET payload_json=? WHERE event_id='P-CITATIONS-2'")
          .run(source.payload_json);
        for (const [path, original] of representations) {
          const response = await app.request(path, {}, env);
          expect(response.status).toBe(200);
          expect(await response.text()).toBe(original.body);
          expect(response.headers.get("etag")).toBe(original.etag);
        }
      });
    });
    test("readLedgerPackSection populates exact-version literature candidates", async () => {
      await withPublicCitation(async (fixture) => {
        const section = await readLedgerPackSection(fixture.db, "P-CITATIONS", 10, "literature");
        expect(section.candidates).toHaveLength(1);
        expect(section.candidates[0]?.kind).toBe("citation");
        expect(section.candidates[0]?.id).toBe("L-1@1");
        expect(section.candidates[0]?.why_included).toContain("committed public citation version");
        expect(section.candidates[0]?.untrusted).toBe(true);
        expect(section.candidates[0]?.body).toContain("/citations/L-1@1.md?through=10");
        expect(section.omitted).toHaveLength(0);
      });
    });
    test("literature packs preserve warnings on the exact citation version outside untrusted text", async () => {
      await withPublicCitation(async (fixture) => {
        const receipt = await Bun.file(
          new URL(
            "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
            import.meta.url,
          ),
        ).json();
        fixture.sqlite
          .query("INSERT INTO screening_publications VALUES (?, ?)")
          .run("P-CITATIONS-2", JSON.stringify(receipt));
        const warned = await readLedgerPackSection(fixture.db, "P-CITATIONS", 10, "literature");
        expect(warned.candidates[0]?.screening_notice).toEqual(receipt.public_action);
        expect(JSON.parse(warned.candidates[0]?.body ?? "{}").screening_notice).toBeUndefined();
        expect(JSON.stringify(warned)).not.toContain("configuration_digest");
        expect(JSON.stringify(warned)).not.toContain("input_digest");
        await fixture.seed(
          sampleCitation({
            problem_id: "P-CITATIONS",
            version: 2,
            seq: 11,
            title: "Corrected metadata without a publication warning",
          }),
        );
        const older = await readLedgerPackSection(fixture.db, "P-CITATIONS", 10, "literature");
        const current = await readLedgerPackSection(fixture.db, "P-CITATIONS", 11, "literature");
        expect(older.candidates[0]?.id).toBe("L-1@1");
        expect(older.candidates[0]?.screening_notice).toEqual(receipt.public_action);
        expect(current.candidates[0]?.id).toBe("L-1@2");
        expect(current.candidates[0]?.screening_notice).toBeUndefined();
        fixture.sqlite
          .query("UPDATE screening_publications SET provenance_json = ? WHERE event_id = ?")
          .run(JSON.stringify({ private_detail: "PRIVATE_SCREENING_CANARY" }), "P-CITATIONS-2");
        await expect(
          readLedgerPackSection(fixture.db, "P-CITATIONS", 10, "literature"),
        ).rejects.toThrow("PUBLIC_SCREENING_RECEIPT_UNAVAILABLE");
        expect(
          (await readLedgerPackSection(fixture.db, "P-CITATIONS", 11, "literature")).candidates[0]
            ?.screening_notice,
        ).toBeUndefined();
      });
    });
    test("metadata corrections preserve older pack and face snapshots", async () => {
      await withPublicCitation(async (fixture, env) => {
        await fixture.seed(
          sampleCitation({
            problem_id: "P-CITATIONS",
            version: 2,
            seq: 11,
            title: "Corrected metadata",
          }),
        );
        const older = await readLedgerPackSection(fixture.db, "P-CITATIONS", 10, "literature");
        const current = await readLedgerPackSection(fixture.db, "P-CITATIONS", 11, "literature");
        expect(older.candidates[0]?.id).toBe("L-1@1");
        expect(older.candidates[0]?.body).toContain("Bounded gaps between primes");
        expect(current.candidates[0]?.id).toBe("L-1@2");
        expect(current.candidates[0]?.body).toContain("Corrected metadata");
        const response = await app.request(`${publicUrl}/citations/L-1.json?through=10`, {}, env);
        expect(response.status).toBe(200);
        const face = SingleCitationResponseSchema.parse(await response.json());
        expect(face.citation.version).toBe(1);
        expect(face.versions).toHaveLength(1);
      });
    });
    test("redaction invalidates faces, exports, and old literature packs without fallback", async () => {
      await withPublicCitation(async (fixture, env) => {
        const before = await app.request(`${publicUrl}/citations.json`, {}, env);
        const etag = before.headers.get("etag");
        fixture.sqlite.exec("UPDATE event_content SET redacted_at = 'redacted'");
        const list = await app.request(
          `${publicUrl}/citations.json`,
          {
            headers: { "if-none-match": etag ?? "" },
          },
          env,
        );
        expect(list.status).toBe(200);
        expect(list.headers.get("etag")).not.toBe(etag);
        const data = CitationsListResponseSchema.parse(await list.json());
        expect(data.citations).toHaveLength(0);
        expect(data.omitted.join(" ")).toContain("unavailable");
        for (const suffix of ["json", "md", "html", "bib", "csl.json"]) {
          const response = await app.request(`${publicUrl}/citations/L-1@1.${suffix}`, {}, env);
          expect(response.status).toBe(404);
          const text = await response.text();
          expect(text).not.toContain("Bounded gaps between primes");
          expect(text).not.toContain("PRIVATE_PROJECTION_CANARY");
        }
        const pack = await readLedgerPackSection(fixture.db, "P-CITATIONS", 10, "literature");
        expect(pack.candidates).toHaveLength(0);
        expect(pack.omitted.map((item) => item.detail).join(" ")).toContain("unavailable");
      });
    });
    test("current problem hide withholds citation bytes at historical cuts until restored", async () => {
      await withPublicCitation(async (fixture, env) => {
        const before = await app.request(`${publicUrl}/citations.json`, {}, env);
        expect(before.status).toBe(200);
        const etag = before.headers.get("etag");
        expect(etag).toBeTruthy();
        const original = await before.text();
        expect(original).toContain("Bounded gaps between primes");
        expect(CitationsListResponseSchema.parse(JSON.parse(original)).citations).toHaveLength(1);
        const historical = new Map<string, { body: string; etag: string | null }>();
        for (const suffix of ["json", "md", "html", "bib", "csl.json"]) {
          const url = `${publicUrl}/citations/L-1@1.${suffix}?through=10`;
          const response = await app.request(url, {}, env);
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain("Bounded gaps between primes");
          const faceEtag = response.headers.get("etag");
          expect(faceEtag).toBeTruthy();
          historical.set(url, { body, etag: faceEtag });
        }
        fixture.sqlite
          .query("INSERT INTO content_controls VALUES ('P-CITATIONS', 'problem', 'hidden', 1)")
          .run();
        const list = await app.request(
          `${publicUrl}/citations.json`,
          {
            headers: { "if-none-match": etag ?? "" },
          },
          env,
        );
        // Collection scope is checked by the reader before accepting an old
        // validator, even without the application's outer hide middleware.
        expect(list.status).toBe(404);
        expect(list.headers.get("cache-control")).toBe("private, no-store");
        expect(list.headers.get("etag")).toBeNull();
        const hidden = await list.text();
        expect(hidden).not.toContain("Bounded gaps between primes");
        expect(hidden).not.toContain("PRIVATE_PROJECTION_CANARY");
        for (const url of historical.keys()) {
          const response = await app.request(url, {}, env);
          expect(response.status).toBe(404);
          const text = await response.text();
          expect(text).not.toContain("Bounded gaps between primes");
          expect(text).not.toContain("PRIVATE_PROJECTION_CANARY");
        }
        const pack = await readLedgerPackSection(fixture.db, "P-CITATIONS", 10, "literature");
        expect(pack.candidates.some((item) => item.kind === "citation")).toBe(false);
        expect(pack.candidates.every((item) => item.scope === "system")).toBe(true);
        expect(JSON.stringify(pack)).not.toContain("Bounded gaps between primes");
        expect(JSON.stringify(pack)).not.toContain("PRIVATE_PROJECTION_CANARY");
        fixture.sqlite
          .query("INSERT INTO content_controls VALUES ('P-CITATIONS', 'problem', 'visible', 2)")
          .run();
        const restored = await app.request(`${publicUrl}/citations.json`, {}, env);
        expect(restored.status).toBe(200);
        expect(await restored.text()).toBe(original);
        expect(restored.headers.get("etag")).toBe(etag);
        for (const [url, expected] of historical) {
          const response = await app.request(url, {}, env);
          expect(response.status).toBe(200);
          expect(await response.text()).toBe(expected.body);
          expect(response.headers.get("etag")).toBe(expected.etag);
        }
      });
    });
    test("literature packs omit oversized records whole and explain the omission", async () => {
      await withPublicCitation(async (fixture) => {
        const eventId = await fixture.seed(
          sampleCitation({
            problem_id: "P-CITATIONS",
            version: 2,
            seq: 11,
            authors: Array.from({ length: 64 }, () => '"'.repeat(200)),
          }),
        );
        const receipt = await Bun.file(
          new URL(
            "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
            import.meta.url,
          ),
        ).json();
        fixture.sqlite
          .query("INSERT INTO screening_publications VALUES (?, ?)")
          .run(eventId, JSON.stringify(receipt));
        const pack = await readLedgerPackSection(fixture.db, "P-CITATIONS", 11, "literature");
        expect(pack.candidates).toHaveLength(0);
        expect(pack.omitted.some((item) => item.reason === "item_too_large")).toBe(true);
        expect(pack.omitted).toContainEqual({
          reason: "item_too_large",
          detail: "literature:L-1@2",
        });
        expect(JSON.stringify(pack)).not.toContain("configuration_digest");
      });
    });
  });
});
