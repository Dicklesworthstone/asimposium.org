import { Database } from "bun:sqlite";
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
    CREATE TABLE citations (problem_id TEXT, citation_id TEXT, title TEXT);
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
        expect(await loadSingleCitation(fixture.db, "P-MATH", "L-1")).toBeNull();
      } finally {
        fixture.sqlite.close();
      }
    });
  });

  describe("Public Ledger Face Routes for Citations", () => {
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
    test("literature packs omit oversized records whole and explain the omission", async () => {
      await withPublicCitation(async (fixture) => {
        await fixture.seed(
          sampleCitation({
            problem_id: "P-CITATIONS",
            version: 2,
            seq: 11,
            authors: Array.from({ length: 64 }, () => '"'.repeat(200)),
          }),
        );
        const pack = await readLedgerPackSection(fixture.db, "P-CITATIONS", 11, "literature");
        expect(pack.candidates).toHaveLength(0);
        expect(pack.omitted.some((item) => item.reason === "item_too_large")).toBe(true);
      });
    });
  });
});
