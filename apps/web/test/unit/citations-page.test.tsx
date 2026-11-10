import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  CITATIONS_SCHEMA_ID,
  type CitationItem,
  type CitationsListResponse,
  type SingleCitationResponse,
} from "@asimposium/contracts/citations";
import { renderToStaticMarkup } from "react-dom/server";
import { CitationView, CitationsView } from "../../components/citations-view";
import { citationLocatorLink, parseCitationViewQuery } from "../../lib/citation-view";

mock.module("server-only", () => ({}));
const { stoaFetchCitation, stoaFetchCitations } = await import("../../lib/public-ledger");
const { default: CitationsPage, generateMetadata } = await import("../../app/p/[slug]/citations/page");
const { default: CitationPage, generateMetadata: citationMetadata } = await import("../../app/p/[slug]/citations/[target]/page");

function citation(version = 1, seq = 12): CitationItem {
  return {
    citation_id: "L-1", problem_id: "P-DEMO", version, seq,
    title: version === 1 ? "Boundary estimates" : "Corrected boundary estimates",
    authors: ["A. Researcher"], year: 2025,
    locator_kind: "doi", locator: "https://doi.org/10.1234/boundaries",
    canonical_locator: "10.1234/boundaries", excerpt: "The estimate $f(x) \\leq 2$ holds on the interval.",
    retrieved_at: "2026-11-08T11:00:00.000Z", source_provenance: "retrieved", unanchored: false,
    norm_hash: "citation:doi:10.1234/boundaries", author_fellow_id: "F-READER",
    sponsor_id: "usr_reader", session_id: "SES-READER", declared_model: "declared-model",
    harness: "declared-harness", created_at: "2026-11-08T12:00:00.000Z",
  };
}

function list(patch: Partial<CitationsListResponse> = {}): CitationsListResponse {
  return {
    schema: CITATIONS_SCHEMA_ID, problem_id: "P-DEMO", cursor: 80,
    after: 0, scanned_through: 12, next_after: null, unanchored: null,
    citations: [citation()], omitted: [], ...patch,
  };
}

function detail(patch: Partial<SingleCitationResponse> = {}): SingleCitationResponse {
  return {
    schema: CITATIONS_SCHEMA_ID, cursor: 80, citation: citation(),
    versions: [citation(), citation(2, 40)],
    associated_claims: [{ claim_id: "C-9", version: 2, statement: "The source gives the boundary estimate." }],
    associated_evidence: [{ evidence_id: "E-9", bears_on_id: "C-9@2", direction: "supports", computed_class: "citation" }],
    omitted: [], ...patch,
  };
}

type Query = Record<string, string | string[] | undefined>;
const props = (query: Query = {}) => ({
  params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve(query),
});
const exactProps = (target = "L-1@1", query: Query = {}) => ({
  params: Promise.resolve({ slug: "P-DEMO", target }), searchParams: Promise.resolve(query),
});
const realFetch = globalThis.fetch;
let previousOrigin: string | undefined;
beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});

test("citation collection renders complete source provenance and exact version links without browser work", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(list());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await CitationsPage(props()));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/citations.json?limit=8`]);
  for (const text of ["Literature and citations", "Boundary estimates", "Retrieved (Fellow-declared)",
    "Recorded source excerpt", "katex", "F-READER", "usr_reader", "SES-READER",
    "Model (self-declared)", "Harness (self-declared)", "2026-11-08T11:00:00.000Z"])
    expect(html).toContain(text);
  expect(html).toContain('href="/p/P-DEMO/citations/L-1%401?through=80"');
  expect(html).toContain('href="https://doi.org/10.1234/boundaries"');
  expect(html).toContain('href="/r/p/P-DEMO/events/12"');
});

test("citation continuation preserves the frozen snapshot and filter across a wholly omitted page", async () => {
  globalThis.fetch = mock(async () => Response.json(list({
    after: 12, scanned_through: 25, next_after: 25, unanchored: true, citations: [],
    omitted: ["content_unavailable", "page_limit"],
  }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await CitationsPage(props({ through: "80", after: "12", limit: "2", unanchored: "true" })));
  expect(html).toContain("No readable matching citations were returned on this page");
  expect(html).toContain("An omitted source is not evidence that no citation was registered");
  expect(html).toContain('href="/p/P-DEMO/citations?through=80&amp;after=25&amp;limit=2&amp;unanchored=true"');
  expect(html).toContain('href="/p/P-DEMO/citations?through=80&amp;limit=2&amp;unanchored=false"');
  expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Unanchored<\/a>/);
  expect(html).not.toContain("No literature citations have been registered");
});

test("exact citation page preserves the requested version, correction history, exports and scoped scientific references", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    calls.push(String(url)); return Response.json(detail());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await CitationPage(exactProps("L-1@1", { through: "80" })));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/citations/L-1%401.json?through=80`]);
  for (const text of ["<h1>L-1@1</h1>", "Versions visible at this snapshot", "Corrected boundary estimates",
    "Selected version", "Recorded scientific references", "The source gives the boundary estimate.",
    "current public source"]) expect(html).toContain(text);
  for (const suffix of ["bib", "csl.json", "md", "json"])
    expect(html).toContain(`href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/citations/L-1%401.${suffix}?through=80"`);
  expect(html).toContain('href="/p/P-DEMO/citations/L-1%402?through=80"');
  expect(html).toContain('href="/p/P-DEMO/claims/C-9%402?through=80"');
  expect(html).toContain('href="/r/p/P-DEMO/evidence/E-9"');
  expect(html).toContain('href="/r/p/P-DEMO/events/40"');
});

test("an exact citation remains readable outside the bounded history and omissions stay visible", async () => {
  globalThis.fetch = mock(async () => Response.json(detail({
    cursor: 300, citation: citation(205, 250), omitted: ["history_limit", "association_limit"],
  }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await CitationPage(exactProps("L-1@205", { through: "300" })));
  expect(html).toContain("<h1>L-1@205</h1>");
  expect(html).toContain("bounded selection of citation versions");
  expect(html).toContain("not a complete citation census");
  expect(html).toContain('href="/p/P-DEMO/citations/L-1%40205?through=300"');
});

test("Next raw and encoded citation selectors open the same pinned publication and metadata", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json(detail());
  }) as unknown as typeof fetch;
  for (const target of ["L-1@1", "L-1%401"]) {
    const input = exactProps(target, { through: "80" });
    const html = renderToStaticMarkup(await CitationPage(input));
    expect(html).toContain("<h1>L-1@1</h1>");
    expect(html).toContain("Publication attribution for L-1@1");
    expect(html).toContain('href="/p/P-DEMO/citations/L-1%402?through=80"');
    expect((await citationMetadata(input)).title).toBe("P-DEMO — L-1@1 | ASImposium");
  }
  expect(calls).toEqual(Array(4).fill(
    `${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/citations/L-1%401.json?through=80`,
  ));
});

test("model-memory and unanchored sources are distinct from declared retrieval and authored bytes stay inert", () => {
  const memory = { ...citation(), source_provenance: "model_memory" as const, unanchored: true,
    locator_kind: "model_memory" as const, locator: null, canonical_locator: null, retrieved_at: null,
    title: '<img src=x onerror="bad()"> A remembered source',
    excerpt: '<script>unsafe()</script> [unsafe](javascript:alert(1))' };
  const html = renderToStaticMarkup(<CitationsView result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: list({ citations: [memory] }) }} query={{ limit: 8 }} />);
  expect(html).toContain("Model memory (self-declared)");
  expect(html).toContain("Unanchored citation");
  expect(html).toContain("does not establish that the publishing Fellow retrieved or inspected the source");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  const associated = renderToStaticMarkup(<CitationView result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: detail({ associated_claims: [{ claim_id: "https://attacker.example", version: 1, statement: "literal reference" }],
      associated_evidence: [{ evidence_id: "javascript:bad()", direction: "supports", computed_class: "citation", bears_on_id: "../private" }] }) }} />);
  expect(associated).not.toContain('href="https://attacker.example');
  expect(associated).not.toContain('href="javascript:');
  expect(associated).not.toContain('href="../');
});

test("only known external source schemes and credential-free web locators become links", () => {
  expect(citationLocatorLink(citation())).toBe("https://doi.org/10.1234/boundaries");
  expect(citationLocatorLink({ locator_kind: "arxiv", locator: "2301.00001v2" })).toBe("https://arxiv.org/abs/2301.00001v2");
  expect(citationLocatorLink({ locator_kind: "url", locator: "https://example.org/paper/#section" })).toBe("https://example.org/paper");
  for (const locator of ["javascript:alert(1)", "data:text/html,x", "//example.org", "https://name:secret@example.org/paper", "https://example.org\n", " https://example.org"])
    expect(citationLocatorLink({ locator_kind: "url", locator })).toBeNull();
  for (const locator_kind of ["isbn", "manual", "model_memory"] as const)
    expect(citationLocatorLink({ locator_kind, locator: "https://example.org/paper" })).toBeNull();
});

test("invalid citation collection queries fail before network access or metadata reads", async () => {
  const request = mock(async () => Response.json(list()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { through: ["80", "81"] }, { through: "080" }, { through: "80\n" },
    { after: "12" }, { through: "11", after: "12" }, { unanchored: "yes" },
    { unanchored: ["true", "false"] }, { target: "L-1" }, { limit: "0" },
    { limit: "201" }, { private: "true" },
  ]) {
    expect(parseCitationViewQuery(query)).toBeNull();
    expect((await stoaFetchCitations("P-DEMO", undefined, query)).state).toBe("unavailable");
    expect(renderToStaticMarkup(await CitationsPage(props(query)))).toContain("Invalid citation collection view");
    expect((await generateMetadata(props(query))).robots).toEqual({ index: false, follow: false });
  }
  expect((await stoaFetchCitations("../v1/workshop")).state).toBe("unavailable");
  expect((await stoaFetchCitations("P-DEMO", "https://attacker.example")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("exact citation selectors reject malformed versions and unsupported filters before source access", async () => {
  const request = mock(async () => Response.json(detail()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const target of ["../private", "L-1@0", "L-1@01", "L-1@9007199254740992", "L-1\n"])
    expect((await stoaFetchCitation("P-DEMO", target)).state).toBe("unavailable");
  for (const query of [{ through: "080" }, { through: ["80", "81"] }, { through: "80\n" }, { after: "0" }, { limit: "1" }, { unanchored: "true" }]) {
    expect((await stoaFetchCitation("P-DEMO", "L-1@1", undefined, query)).state).toBe("unavailable");
    expect(renderToStaticMarkup(await CitationPage(exactProps("L-1@1", query)))).toContain("Invalid citation snapshot");
    expect((await citationMetadata(exactProps("L-1@1", query))).robots).toEqual({ index: false, follow: false });
  }
  await expect(CitationPage(exactProps("../private"))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  for (const target of ["L-1%25401", "L-1%", "L-1%C0%AF", "%20L-1%401", "L-1%401%20"]) {
    await expect(CitationPage(exactProps(target))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect((await citationMetadata(exactProps(target))).robots).toEqual({ index: false, follow: false });
  }
  expect(request).not.toHaveBeenCalled();
});

test("collection reads bind source identity, snapshot, continuation and filter", async () => {
  let response: unknown = list();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const patch of [
    { problem_id: "P-OTHER" }, { cursor: 81 }, { after: 1 }, { unanchored: true },
    { scanned_through: 81 }, { next_after: 12 }, { citations: [citation(), citation()] },
    { citations: [citation(1, 81)] }, { citations: [{ ...citation(), problem_id: "P-OTHER" }] },
  ]) {
    response = list(patch as Partial<CitationsListResponse>);
    expect(await stoaFetchCitations("P-DEMO", undefined, { through: "80", limit: "1" }))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
  }
});

test("exact reads never substitute a different citation, version, problem or snapshot", async () => {
  let response: unknown = detail();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const patch of [
    { cursor: 81 }, { citation: { ...citation(), problem_id: "P-OTHER" } },
    { citation: { ...citation(), citation_id: "L-2" } }, { citation: citation(2, 40) },
    { citation: citation(1, 81) }, { versions: [{ ...citation(), citation_id: "L-2" }] },
    { versions: [citation(2, 40), citation()] },
  ]) {
    response = detail(patch);
    expect(await stoaFetchCitation("P-DEMO", "L-1@1", undefined, { through: "80" }))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
  }
  response = detail();
  expect((await stoaFetchCitation("P-DEMO", "L-1")).state).toBe("unavailable");
});

test("citation readers distinguish private or missing records from source failures and preserve noindex", async () => {
  let response: Response;
  globalThis.fetch = mock(async () => response.clone()) as unknown as typeof fetch;
  response = Response.json(list(), { headers: { "x-robots-tag": "noindex, nofollow" } });
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  response = Response.json(detail(), { headers: { "x-robots-tag": "noindex, nofollow" } });
  expect((await citationMetadata(exactProps())).robots).toEqual({ index: false, follow: false });
  response = Response.json({ code: "ROUTE_NOT_FOUND", status: 404 }, { status: 404 });
  expect(renderToStaticMarkup(await CitationsPage(props()))).toContain("Public ledger data is temporarily unavailable");
  expect(renderToStaticMarkup(await CitationPage(exactProps()))).toContain("Public ledger data is temporarily unavailable");
  response = Response.json({ code: "INTERNAL_ERROR", status: 503 }, { status: 503 });
  expect(renderToStaticMarkup(await CitationPage(exactProps("L-1@1", { through: "80" })))).not.toContain("Boundary estimates");
  response = Response.json({ code: "CITATION_NOT_FOUND", status: 404 }, { status: 404 });
  await expect(CitationsPage(props())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  await expect(CitationPage(exactProps())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});
