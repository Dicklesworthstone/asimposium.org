import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  type EvidenceListResponse,
  RESEARCH_LISTS_SCHEMA_ID,
  type ReviewListResponse,
} from "@asimposium/contracts/research-lists";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchListView } from "../../components/research-list-view";

mock.module("server-only", () => ({}));
const { stoaFetchEvidenceList, stoaFetchReviewsList } = await import("../../lib/public-research-lists");
const { default: EvidencePage, generateMetadata: evidenceMetadata } = await import("../../app/p/[slug]/evidence/page");
const { default: ReviewsPage, generateMetadata: reviewMetadata } = await import("../../app/p/[slug]/reviews/page");

const publication = {
  event_id: "evt-evidence-9", seq: 9, created_at: "2026-11-24T00:00:00.000Z",
  payload_sha256: "a".repeat(64), fellow_id: "FEL-1234", sponsor_id: "usr_original",
  session_id: "SES-1234", model_self_declared: "model/declaration", harness_self_declared: "local-harness",
};
function evidenceFace(patch: Partial<EvidenceListResponse> = {}): EvidenceListResponse {
  return {
    schema: RESEARCH_LISTS_SCHEMA_ID, problem_id: "P-DEMO", cursor: 40, after: 0,
    scanned_through: 12, next_after: 12, count: 1, omitted: ["page_limit"],
    evidence: [{ evidence_id: "E-3", publication,
      bears_on: { kind: "claim", id: "C-3", version: 2 }, kind: "computation",
      direction: "informs", mode: "exploratory", withdrawn: false,
      read_url: "/p/P-DEMO/evidence/E-3.json" }], ...patch,
  };
}
function reviewFace(patch: Partial<ReviewListResponse> = {}): ReviewListResponse {
  return {
    schema: RESEARCH_LISTS_SCHEMA_ID, problem_id: "P-DEMO", cursor: 40, after: 0,
    scanned_through: 12, next_after: 12, count: 1, omitted: ["page_limit"],
    reviews: [{ review_id: "R-3", publication,
      target: { claim_id: "C-3", version: 2 }, verdict: "cannot-verify",
      basis: "The supplied artifact does not exercise the boundary condition.",
      independence_tier: 2, withdrawn: true, read_url: "/p/P-DEMO/reviews/R-3.json" }], ...patch,
  };
}
const props = (query: Record<string, string | string[] | undefined> = {}) => ({
  params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve(query),
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

test("evidence is readable without scripts with exact targets, attribution and snapshot continuation", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(evidenceFace());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await EvidencePage(props()));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/evidence.json`]);
  expect(html).toContain('href="/p/P-DEMO/claims/C-3%402?through=40"');
  expect(html).toContain('href="/p/P-DEMO/evidence?through=40&amp;after=12"');
  expect(html).toContain('href="/r/p/P-DEMO/evidence/E-3"');
  expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/evidence/E-3.json`);
  expect(html).not.toContain("E-3.json?through=");
  expect(html).toContain("Sponsor at publication");
  expect(html).toContain("usr_original");
  expect(html).toContain("Model · self-declared");
  expect(html).toContain("model/declaration");
  expect(html).toContain("publication inventory, not a scientific assessment");
  expect(html).toContain("1 readable publication on this page");
});

test("published reviews preserve verdict, review-time independence and withdrawals without manufacturing support", async () => {
  globalThis.fetch = mock(async () => Response.json(reviewFace())) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ReviewsPage(props()));
  expect(html).toContain("Published reviews");
  expect(html).toContain("cannot-verify");
  expect(html).toContain("The supplied artifact does not exercise the boundary condition.");
  expect(html).toContain("Independence at review time: <strong>T2</strong>");
  expect(html).toContain("At this snapshot: <strong>withdrawn</strong>");
  expect(html).toContain('href="/p/P-DEMO/claims/C-3%402?through=40"');
  expect(html).toContain('href="/p/P-DEMO/reviews?through=40&amp;after=12"');
  expect(html).toContain('href="/reviews?problem=P-DEMO"');
  expect(html).toContain('href="/r/p/P-DEMO/reviews/R-3"');
  expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/reviews.json?through=40&amp;after=0`);
});

test("a completely withheld historical page keeps the continuation for both inventories", async () => {
  globalThis.fetch = mock(async (url: string | URL | Request) => Response.json(String(url).includes("/evidence")
    ? evidenceFace({ after: 12, scanned_through: 20, next_after: 20, count: 0, evidence: [], omitted: ["content_unavailable", "page_limit"] })
    : reviewFace({ after: 12, scanned_through: 20, next_after: 20, count: 0, reviews: [], omitted: ["content_unavailable", "page_limit"] }))) as unknown as typeof fetch;
  for (const [kind, Page] of [["evidence", EvidencePage], ["reviews", ReviewsPage]] as const) {
    const html = renderToStaticMarkup(await Page(props({ through: "40", after: "12" })));
    expect(html).toContain("No readable publications were returned on this page");
    expect(html).toContain("do not establish that no work was published");
    expect(html).toContain(`href="/p/P-DEMO/${kind}?through=40&amp;after=20"`);
    expect(html).toContain(`href="/p/P-DEMO/${kind}?through=40&amp;after=0"`);
    expect(html).toContain(`Read the latest ${kind}`);
    expect(html).not.toContain("usr_original");
  }
});

test("typed readers reject source substitution, incorrect cuts and malformed collections", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const [makeFace, read] of [[evidenceFace, stoaFetchEvidenceList], [reviewFace, stoaFetchReviewsList]] as const) {
    for (const patch of [{ problem_id: "P-OTHER" }, { cursor: 41 }, { after: 2 },
      { count: 0 }, { next_after: 0 }, { next_after: null }, { scanned_through: 8 }]) {
      response = makeFace(patch);
      expect(await read("P-DEMO", undefined, { through: "40" }))
        .toEqual({ state: "unavailable", reason: "invalid_response" });
    }
  }
  const badUrl = evidenceFace();
  badUrl.evidence[0]!.read_url = "https://other.example/private";
  response = badUrl;
  expect((await stoaFetchEvidenceList("P-DEMO")).state).toBe("unavailable");
  response = { ...reviewFace(), workshop: "PRIVATE-RESEARCH-CANARY" };
  expect((await stoaFetchReviewsList("P-DEMO")).state).toBe("unavailable");
});

test("invalid or repeated query parameters make no request and stay out of indexes", async () => {
  const request = mock(async () => Response.json(evidenceFace()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [{ through: ["40", "41"] }, { through: "040" }, { after: "12" },
    { through: "4", after: "5" }, { after: "9007199254740992" }, { private: "true" }]) {
    expect(renderToStaticMarkup(await EvidencePage(props(query)))).toContain("Invalid evidence view");
    expect(renderToStaticMarkup(await ReviewsPage(props(query)))).toContain("Invalid reviews view");
    expect((await evidenceMetadata(props(query))).robots).toEqual({ index: false, follow: false });
    expect((await reviewMetadata(props(query))).robots).toEqual({ index: false, follow: false });
    expect((await stoaFetchEvidenceList("P-DEMO", undefined, query)).state).toBe("unavailable");
    expect((await stoaFetchReviewsList("P-DEMO", undefined, query)).state).toBe("unavailable");
  }
  expect((await stoaFetchEvidenceList("../v1/workshop")).state).toBe("unavailable");
  expect((await stoaFetchReviewsList("../v1/workshop")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("unlisted and unavailable inventories preserve source policy and exact retry parameters", async () => {
  for (const [Page, metadata, makeFace, kind] of [[EvidencePage, evidenceMetadata, evidenceFace, "evidence"], [ReviewsPage, reviewMetadata, reviewFace, "reviews"]] as const) {
    globalThis.fetch = mock(async () => Response.json(makeFace(), { headers: { "x-robots-tag": "noindex, nofollow" } })) as unknown as typeof fetch;
    expect((await metadata(props())).robots).toEqual({ index: false, follow: false });
    expect(renderToStaticMarkup(await Page(props()))).toContain("This public record is unlisted");
    globalThis.fetch = mock(async () => Response.json({ code: "ROUTE_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
    const html = renderToStaticMarkup(await Page(props({ through: "40", after: "12" })));
    expect(html).toContain("Public ledger data is temporarily unavailable");
    expect(html).toContain(`action="/p/P-DEMO/${kind}"`);
    expect(html).toContain('name="through" value="40"');
    expect(html).toContain('name="after" value="12"');
    expect(html).not.toContain("No publications were returned");
    globalThis.fetch = mock(async () => Response.json({ code: "PROBLEM_NOT_FOUND", status: 404 }, { status: 404 })) as unknown as typeof fetch;
    await expect(Page(props())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  }
});

test("hypothesis evidence has no invented claim version; unknown historical attribution remains unknown", () => {
  const face = evidenceFace();
  face.evidence[0]!.bears_on = { kind: "hypothesis", id: "H-3" };
  face.evidence[0]!.publication = { ...publication, fellow_id: null, sponsor_id: null,
    session_id: null, model_self_declared: null, harness_self_declared: null };
  const html = renderToStaticMarkup(<ResearchListView kind="evidence" historical={false}
    result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN, data: face }} />);
  expect(html).toContain('href="/p/P-DEMO/hypotheses/H-3?through=40"');
  expect(html).not.toContain("H-3@1");
  expect(html).not.toContain("/fellows/null");
  expect(html).toContain("Not recorded");
});

test("author-supplied review basis and model declarations remain inert data", () => {
  const face = reviewFace();
  face.reviews[0]!.basis = '<script>window.injected=true</script><img onerror="attack()">';
  face.reviews[0]!.independence_tier = null;
  face.reviews[0]!.publication = { ...publication, model_self_declared: '<img onerror="attack()">' };
  const html = renderToStaticMarkup(<ResearchListView kind="reviews" historical={false}
    result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN, data: face }} />);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Independence at review time: <strong>not recorded</strong>");
});
