import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CITATIONS_SCHEMA_ID, SingleCitationResponseSchema } from "@asimposium/contracts/citations";
import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { Env } from "../../src/env.ts";
import {
  renderCitationsHtml,
  renderCitationsMarkdown,
  renderSingleCitationHtml,
  renderSingleCitationMarkdown,
} from "../../src/ledger/citations.ts";
import { handleSingleCitation } from "../../src/ledger/citations-http.ts";

const citation = {
  citation_id: "L-1",
  problem_id: "P-4DSP",
  version: 2,
  seq: 20,
  title: "A source with a corrected locator",
  authors: ["Research Author"],
  locator_kind: "doi",
  canonical_locator: "10.1000/182",
  source_provenance: "retrieved",
  unanchored: false,
  norm_hash: "citation:doi:10.1000/182",
  author_fellow_id: "F-author",
  created_at: "2026-09-02T12:00:00.000Z",
};
const face = SingleCitationResponseSchema.parse({
  schema: CITATIONS_SCHEMA_ID,
  cursor: 50,
  citation,
  versions: [{ ...citation, version: 1, seq: 10 }, citation],
  associated_claims: [
    { claim_id: "C-3", version: 2, statement: "The boundary construction mentions L-1@2." },
  ],
  associated_evidence: [],
  omitted: ["Some citation versions are unavailable in this public history."],
});

function links(body: string, format: "md" | "html"): URL[] {
  const matches = body.matchAll(format === "md" ? /\]\((\/p\/[^)]+)\)/g : /href="(\/p\/[^"]+)"/g);
  return [...matches].map((match) => {
    const path = match[1];
    if (path === undefined) throw new Error("Missing rendered link path");
    return new URL(path.replaceAll("&amp;", "&"), "https://a.asimposium.org");
  });
}

for (const format of ["md", "html"] as const) {
  test(`citation ${format} preserves its frozen cut through associated claims, history and exports`, () => {
    const body =
      format === "md"
        ? renderSingleCitationMarkdown("P-4DSP", face, face)
        : renderSingleCitationHtml("P-4DSP", face, face);
    expect(body).toContain("Public ledger cursor: 50.");
    expect(body).toContain(face.omitted[0] ?? "missing omission");
    expect(body).toContain("Deliberate Omissions");
    const rendered = links(body, format);
    expect(rendered.some((url) => url.pathname === `/p/P-4DSP/claims/C-3@2.${format}`)).toBe(true);
    expect(rendered.some((url) => url.pathname === `/p/P-4DSP/citations/L-1@1.${format}`)).toBe(
      true,
    );
    for (const suffix of ["json", "bib", "csl.json"])
      expect(rendered.some((url) => url.pathname === `/p/P-4DSP/citations/L-1@2.${suffix}`)).toBe(
        true,
      );
    expect(rendered.some((url) => url.pathname === "/p/P-4DSP/citations.html")).toBe(true);
    for (const url of rendered) expect(url.searchParams.get("through")).toBe("50");
  });

  test(`empty citation ${format} pages retain continuation and provenance filters`, () => {
    const view = {
      cursor: 50,
      after: 10,
      scanned_through: 20,
      next_after: 20,
      unanchored: false,
      limit: 3,
    };
    const omitted = ["Citations outside the requested unanchored filter are omitted."];
    const body =
      format === "md"
        ? renderCitationsMarkdown("P-4DSP", [], omitted, view)
        : renderCitationsHtml("P-4DSP", [], omitted, view);
    expect(body).toContain("Public ledger cursor: 50.");
    expect(body).toContain(omitted[0] ?? "missing omission");
    const rendered = links(body, format).filter((url) => url.pathname.includes("/citations."));
    const continuation = rendered.find((url) => url.searchParams.get("after") === "20");
    expect(continuation).toBeDefined();
    expect(continuation?.pathname).toBe(`/p/P-4DSP/citations.${format}`);
    for (const url of rendered) {
      expect(url.searchParams.get("through")).toBe("50");
      expect(url.searchParams.get("unanchored")).toBe("false");
      expect(url.searchParams.get("limit")).toBe("3");
    }
  });
}

/** Real SQLite read queries and committed SHA-256 source bytes. This is a
 * focused handler unit fixture, not a native D1 or ledger-chain proof. */
function canonicalSourceFixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,payload_sha256 TEXT,created_at TEXT,actor_fellow_id TEXT,
      actor_sponsor_id TEXT,actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,visibility TEXT,version INTEGER);
    CREATE TABLE screening_publications(event_id TEXT PRIMARY KEY,provenance_json TEXT);
    INSERT INTO problems VALUES('P-REVIEW',2,'open',0);`);
  function seed(sequence: number, kind: "citation" | "claim", id: string, value: unknown) {
    const payload = JSON.stringify(value);
    const digest = createHash("sha256").update(payload).digest("hex");
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        `E-${sequence}`,
        "P-REVIEW",
        sequence,
        kind === "citation" ? "citation.recorded" : "claim.created",
        kind,
        id,
        1,
        digest,
        "2026-09-02T00:00:00.000Z",
        "F-review",
        null,
        null,
        null,
        null,
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(`E-${sequence}`, digest, payload);
  }
  seed(1, "citation", "L-1", {
    citation_id: "L-1",
    title: "Canonical source",
    authors: ["Research Author"],
    locator_kind: "manual",
    locator: "Source passage",
    canonical_locator: "Source passage",
    retrieved_at: "2026-09-01T00:00:00.000Z",
    source_provenance: "retrieved",
    unanchored: false,
    norm_hash: "citation:manual:source passage",
  });
  seed(2, "claim", "C-1", {
    claim_id: "C-1",
    kind: "definition",
    statement: "The proof cites L-1 as background.",
  });
  const prepare = (query: string) => {
    let bindings: Array<string | number | null> = [];
    const statement = {
      bind(...values: Array<string | number | null>) {
        bindings = values;
        return statement;
      },
      async all() {
        return { success: true, results: sql.query(query).all(...bindings) };
      },
    };
    return statement;
  };
  const db = {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sql, env: { DB: db } as Env };
}

test("citation Content-Location preserves bare versus exact backlink semantics and response bytes", async () => {
  const fixture = canonicalSourceFixture();
  const app = new Hono<{ Bindings: Env }>();
  app.on(["GET", "HEAD"], "/p/:id/citations/:target", handleSingleCitation);
  try {
    for (const [target, mentions] of [
      ["L-1", 1],
      ["L-1@1", 0],
    ] as const) {
      const response = await app.request(
        `https://a.asimposium.org/p/P-REVIEW/citations/${target}.json`,
        {},
        fixture.env,
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      const face = SingleCitationResponseSchema.parse(JSON.parse(body));
      expect(face.associated_claims).toHaveLength(mentions);
      const location = response.headers.get("content-location");
      expect(location).toBe(`/p/P-REVIEW/citations/${encodeURIComponent(target)}.json?through=2`);
      if (location === null) throw new Error("Missing canonical citation location");
      const frozen = await app.request(
        new URL(location, "https://a.asimposium.org").href,
        {},
        fixture.env,
      );
      expect(frozen.status).toBe(200);
      expect(await frozen.text()).toBe(body);
      expect(frozen.headers.get("etag")).toBe(response.headers.get("etag"));
      expect(frozen.headers.get("content-location")).toBe(location);
      for (const format of ["md", "html"] as const) {
        const rendered = await app.request(
          `https://a.asimposium.org/p/P-REVIEW/citations/${target}.${format}?through=2`,
          {},
          fixture.env,
        );
        expect(rendered.status).toBe(200);
        const formatLinks = links(await rendered.text(), format).filter((url) =>
          url.pathname.includes("/citations/"),
        );
        expect(formatLinks.length).toBeGreaterThanOrEqual(3);
        for (const link of formatLinks) {
          expect(
            decodeURIComponent(link.pathname).startsWith(`/p/P-REVIEW/citations/${target}.`),
          ).toBe(true);
          expect(link.searchParams.get("through")).toBe("2");
        }
        const json = formatLinks.find(
          (url) => url.pathname === `/p/P-REVIEW/citations/${encodeURIComponent(target)}.json`,
        );
        if (json === undefined) throw new Error("Missing alternative JSON face");
        const alternate = await app.request(json.href, {}, fixture.env);
        expect(alternate.status).toBe(200);
        expect(await alternate.text()).toBe(body);
      }
    }
  } finally {
    fixture.sql.close();
  }
});
