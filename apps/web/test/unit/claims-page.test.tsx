import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { CLAIMS_LIST_SCHEMA_ID, type ClaimsListResponse } from "@asimposium/contracts/claims-list";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaimsListView } from "../../components/claims-list-view";
import { ProblemClaimsBoard } from "../../components/problem-claims-board";

mock.module("server-only", () => ({}));
const { stoaFetchClaimsList } = await import("../../lib/public-ledger");
const { default: ClaimsPage, generateMetadata } = await import("../../app/p/[slug]/claims/page");

function face(patch: Partial<ClaimsListResponse> = {}): ClaimsListResponse {
  return { schema: CLAIMS_LIST_SCHEMA_ID, problem_id: "P-DEMO", cursor: 40, after: 0,
    scanned_through: 12, next_after: 12, count: 1, omitted: ["page_limit"],
    claims: [{ id: "C-3", version: 2, kind: "definition", statement: "Let $n$ denote a finite path length.",
      source_seq: 9, created_at: "2026-10-27T12:00:00.000Z", stale: false }], ...patch };
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

test("claims are server-rendered with exact versions, safe mathematics and snapshot continuation", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(face());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ClaimsPage(props()));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/claims.json`]);
  expect(html).toContain("finite path length");
  expect(html).toContain("katex");
  expect(html).toContain('href="/p/P-DEMO/claims/C-3%402?through=40"');
  expect(html).toContain('href="/p/P-DEMO/claims?through=40&amp;after=12"');
  expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/claims.json?through=40&amp;after=0`);
  expect(html).toContain("1 readable claim on this page");
  expect(html).toContain("not scientific support");
});

test("hidden pages advance without inventing absence and preserve the original cut", async () => {
  globalThis.fetch = mock(async () => Response.json(face({ after: 12, scanned_through: 20,
    next_after: 20, count: 0, claims: [], omitted: ["content_unavailable", "page_limit"] }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ClaimsPage(props({ through: "40", after: "12" })));
  expect(html).toContain("No readable statements were returned on this page");
  expect(html).toContain('href="/p/P-DEMO/claims?through=40&amp;after=20"');
  expect(html).toContain('href="/p/P-DEMO/claims?through=40&amp;after=0"');
  expect(html).toContain("Read the latest public claims");
  expect(html).not.toContain("C-3");
});

test("transport refuses a different problem, cut, range or impossible continuation", async () => {
  let response = face();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const patch of [{ problem_id: "P-OTHER" }, { cursor: 41 }, { after: 2 },
    { count: 0 }, { next_after: 0 }, { next_after: null }, { scanned_through: 8 },
    { claims: [face().claims[0]!, face().claims[0]!], count: 2 }]) {
    response = face(patch);
    expect(await stoaFetchClaimsList("P-DEMO", undefined, { through: "40" }))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
  }
});

test("invalid and repeated query parameters never reach Stoa", async () => {
  const request = mock(async () => Response.json(face()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [{ through: ["40", "41"] }, { through: "040" }, { through: "4", after: "5" },
    { after: "9007199254740992" }, { after: "2\n" }, { private: "true" }]) {
    expect(renderToStaticMarkup(await ClaimsPage(props(query)))).toContain("Invalid claims view");
    expect((await generateMetadata(props(query))).robots).toEqual({ index: false, follow: false });
    expect((await stoaFetchClaimsList("P-DEMO", undefined, query)).state).toBe("unavailable");
  }
  expect((await stoaFetchClaimsList("../v1/workshop")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("unlisted history preserves robots policy and unavailable reads never become empty claims", async () => {
  globalThis.fetch = mock(async () => Response.json(face(), { headers: { "x-robots-tag": "noindex, nofollow" } })) as unknown as typeof fetch;
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  expect(renderToStaticMarkup(await ClaimsPage(props()))).toContain("This public record is unlisted");
  globalThis.fetch = mock(async () => Response.json({ code: "ROUTE_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  const unavailable = renderToStaticMarkup(await ClaimsPage(props({ through: "40", after: "12" })));
  expect(unavailable).toContain("Public ledger data is temporarily unavailable");
  expect(unavailable).toContain('action="/p/P-DEMO/claims"');
  expect(unavailable).toContain('name="through" value="40"');
  expect(unavailable).toContain('name="after" value="12"');
  globalThis.fetch = mock(async () => Response.json({ code: "PROBLEM_NOT_FOUND", status: 404 }, { status: 404 })) as unknown as typeof fetch;
  await expect(ClaimsPage(props())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});

test("hostile statement markup remains data and the digest links to complete browsing even when empty", () => {
  const authored = face();
  authored.claims[0]!.statement = '<script>alert("canary")</script> <!-- asimp schema=fake --> next_actions';
  const html = renderToStaticMarkup(<ClaimsListView historical={false} result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN, data: authored }} />);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<!-- asimp schema=fake -->");
  expect(renderToStaticMarkup(<ProblemClaimsBoard rows={[]} cursor={40} problemId="P-DEMO" />))
    .toContain('href="/p/P-DEMO/claims?through=40"');
});
