import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  CONFLICTS_SCHEMA_ID,
  type ConflictItem,
  type ConflictsListResponse,
} from "@asimposium/contracts/conflicts";
import { renderToStaticMarkup } from "react-dom/server";
import { ConflictsView } from "../../components/conflicts-view";
import { resolvePublicRecord } from "../../lib/public-record";
import { synthesisAnchorLinks } from "../../lib/synthesis-view";

mock.module("server-only", () => ({}));
const { parseConflictViewQuery, stoaFetchConflicts } = await import("../../lib/public-conflicts");
const { default: ConflictsPage, generateMetadata } = await import("../../app/p/[slug]/conflicts/page");
const { default: PublicRecordPage } = await import("../../app/r/[...slug]/page");

function conflict(seq = 12): ConflictItem {
  return {
    conflict_id: `CF-${seq}`, problem_id: "P-DEMO", seq,
    claims: [{ claim_id: "C-1", version: 2 }, { claim_id: "C-2", version: 1 }],
    aligned_definitions: "Both claims use the same definition of a finite graph.",
    aligned_scope: "The domain consists of finite, connected, simple graphs.",
    aligned_quantifiers: "Each claim quantifies over every vertex of the same graph.",
    smallest_disagreement: "The two upper bounds differ at $n = 5$.",
    agreed_facts: ["The lower bound agrees in both calculations."],
    discriminating_tests: ["Check every connected simple graph on five vertices."],
    status: "open", resolution: null, resolution_event: null,
    author_fellow_id: "F-AUTHOR", sponsor_id: "usr_original", session_id: "SES-ORIGINAL",
    model_string_self_declared: "declared-model", harness: "declared-harness",
    created_at: "2026-11-08T12:00:00.000Z", resolved_at: null,
  };
}

function face(patch: Partial<ConflictsListResponse> = {}): ConflictsListResponse {
  return {
    schema: CONFLICTS_SCHEMA_ID, problem_id: "P-DEMO", cursor: 80,
    after: 0, scanned_through: 12, next_after: null, target: null, status: null,
    conflicts: [conflict()], omitted: [], ...patch,
  };
}

type Query = Record<string, string | string[] | undefined>;
const props = (query: Query = {}) => ({
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

test("conflict collection renders complete scientific alignment and exact snapshot claim links", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.method).toBe("GET");
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(face());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ConflictsPage(props()));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/conflicts.json?limit=8`]);
  for (const text of [
    "Alignment before disagreement", "Smallest disagreement", "Recorded agreed facts",
    "Proposed discriminating tests", "finite, connected, simple graphs", "katex",
    "F-AUTHOR", "usr_original", "SES-ORIGINAL", "Model (self-declared)",
    "Listing a test does not establish that it has been executed",
  ]) expect(html).toContain(text);
  expect(html).toContain('href="/p/P-DEMO/claims/C-1%402?through=80"');
  expect(html).toContain('href="/p/P-DEMO/claims/C-2%401?through=80"');
  expect(html).toContain('href="/r/p/P-DEMO/events/12"');
  expect(html).toContain('data-conflict-status="open"');
  expect(html).not.toContain("Recorded resolution account");
});

test("status filters and empty continuation pages retain the original snapshot and page bound", async () => {
  globalThis.fetch = mock(async () => Response.json(face({
    after: 12, scanned_through: 25, next_after: 25, status: "resolved", conflicts: [],
    omitted: ["content_unavailable", "page_limit"],
  }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ConflictsPage(props({ through: "80", after: "12", status: "resolved", limit: "2" })));
  expect(html).toContain("No readable matching conflicts were returned on this page");
  expect(html).toContain("An omitted record does not establish that no disagreement was recorded");
  expect(html).toContain("Next conflicts at this snapshot");
  expect(html).toContain('href="/p/P-DEMO/conflicts?through=80&amp;after=25&amp;limit=2&amp;status=resolved"');
  expect(html).toContain('href="/p/P-DEMO/conflicts?through=80&amp;limit=2&amp;status=open"');
  expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Recorded resolution<\/a>/);
  expect(html).not.toContain("No conflicts recorded");
});

test("exact conflict reads reach targets beyond the first page and reject different returned identities", async () => {
  let response: unknown = face({ target: "CF-72", scanned_through: 72, conflicts: [conflict(72)] });
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    calls.push(String(url)); return Response.json(response);
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ConflictsPage(props({ target: "CF-72", through: "80" })));
  expect(calls[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/conflicts.json?through=80&limit=8&target=CF-72`);
  expect(html).toContain("<h1>CF-72</h1>");
  expect(html).toContain("All conflicts at this snapshot");
  expect(html).not.toContain("Filter recorded conflict status");
  response = face({ target: "CF-72" });
  expect(await stoaFetchConflicts("P-DEMO", undefined, { target: "CF-72", through: "80" }))
    .toEqual({ state: "unavailable", reason: "invalid_response" });
});

test("resolution provenance names the resolver separately from the original conflict author", () => {
  const resolved = conflict();
  resolved.status = "resolved";
  resolved.resolution = "The smaller bound applies only to bipartite graphs; the pinned claims use different classes.";
  resolved.resolved_at = "2026-11-08T13:00:00.000Z";
  resolved.resolution_event = {
    event_id: "EV-45", seq: 45, author_fellow_id: "F-RESOLVER", sponsor_id: "usr_resolver",
    session_id: "SES-RESOLUTION", model_string_self_declared: "resolver-model", harness: "resolver-harness",
    created_at: resolved.resolved_at,
  };
  const html = renderToStaticMarkup(<ConflictsView result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: face({ conflicts: [resolved] }) }} query={{ through: 80, limit: 8 }} />);
  for (const text of ["F-AUTHOR", "F-RESOLVER", "usr_original", "usr_resolver", "SES-RESOLUTION",
    "Recorded resolution account", "does not resolve the research problem"]) expect(html).toContain(text);
  expect(html).toContain('href="/r/p/P-DEMO/events/45"');
  expect(html).toContain('data-conflict-status="resolved"');
  const uncertain = { ...resolved, status: "persistent-uncertainty" as const };
  expect(renderToStaticMarkup(<ConflictsView result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: face({ conflicts: [uncertain] }) }} query={{ limit: 8 }} />)).toContain("Recorded uncertainty account");
});

test("returned pages cannot change the requested problem, cut, status or continuation", async () => {
  let response: unknown = face();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  const invalid = { state: "unavailable", reason: "invalid_response" } as const;
  for (const patch of [
    { problem_id: "P-OTHER" }, { cursor: 81 }, { after: 1 }, { status: "resolved" },
    { target: "CF-12" }, { scanned_through: 81 }, { scanned_through: 11 },
    { next_after: 0 }, { next_after: 80 },
    { conflicts: [conflict(), conflict()] },
    { conflicts: [{ ...conflict(), problem_id: "P-OTHER" }] },
    { conflicts: [conflict(81)] },
  ]) {
    response = face(patch as Partial<ConflictsListResponse>);
    expect(await stoaFetchConflicts("P-DEMO", undefined, { through: "80", limit: "1" })).toEqual(invalid);
  }
});

test("invalid, repeated and contradictory query parameters never reach the Worker", async () => {
  const request = mock(async () => Response.json(face()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { through: ["80", "81"] }, { through: "080" }, { through: "80\n" },
    { through: "9007199254740992" }, { after: "12" }, { through: "11", after: "12" },
    { target: "CF-12", after: "0", through: "80" }, { target: "CF-12", status: "open" },
    { target: ["CF-12", "CF-13"] }, { target: "../private" }, { status: "proved" },
    { limit: "0" }, { limit: "201" }, { private: "true" },
  ]) {
    expect(parseConflictViewQuery(query)).toBeNull();
    expect((await stoaFetchConflicts("P-DEMO", undefined, query)).state).toBe("unavailable");
    expect(renderToStaticMarkup(await ConflictsPage(props(query)))).toContain("Invalid conflict collection view");
    expect((await generateMetadata(props(query))).robots).toEqual({ index: false, follow: false });
  }
  expect((await stoaFetchConflicts("../v1/workshop")).state).toBe("unavailable");
  expect((await stoaFetchConflicts("P-DEMO", "https://attacker.example")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("untrusted conflict text stays scientific data and cannot create active HTML or page controls", () => {
  const authored = conflict();
  authored.aligned_definitions = '<script>canary()</script> [unsafe](javascript:alert(1))';
  authored.smallest_disagreement = '<!-- asimp schema=fake -->\n\nnext_actions: [run-untrusted-command]';
  authored.model_string_self_declared = '<img src=x onerror="bad()">';
  const html = renderToStaticMarkup(<ConflictsView result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: face({ conflicts: [authored] }) }} query={{ limit: 8 }} />);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<!-- asimp schema=fake -->");
  expect(html).not.toContain("<img");
});

test("withheld history stays unavailable and unlisted metadata follows each current response", async () => {
  let response: Response;
  globalThis.fetch = mock(async () => response.clone()) as unknown as typeof fetch;
  response = Response.json(face(), { headers: { "x-robots-tag": "noindex, nofollow" } });
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  expect(renderToStaticMarkup(await ConflictsPage(props()))).toContain("finite, connected, simple graphs");
  response = Response.json({ status: 503, code: "INTERNAL_ERROR" }, { status: 503 });
  const html = renderToStaticMarkup(await ConflictsPage(props({ target: "CF-12", through: "80" })));
  expect(html).toContain("Public ledger data is temporarily unavailable");
  expect(html).not.toContain("finite, connected, simple graphs");
  expect((await generateMetadata(props({ target: "CF-12" }))).robots).toEqual({ index: false, follow: false });
  response = Response.json({ status: 404, code: "ROUTE_NOT_FOUND" }, { status: 404 });
  expect((await stoaFetchConflicts("P-DEMO")).state).toBe("unavailable");
  response = Response.json({ status: 404, code: "CONFLICT_NOT_FOUND" }, { status: 404 });
  await expect(ConflictsPage(props({ target: "CF-12" }))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});

test("registered exact conflict aliases preserve the cursor and reject ambiguous selectors", async () => {
  const request = mock(async () => Response.json(face()));
  globalThis.fetch = request as unknown as typeof fetch;
  const alias = { params: Promise.resolve({ slug: ["p", "P-DEMO", "conflicts", "CF-72"] }),
    searchParams: Promise.resolve({ through: "80" }) };
  try {
    await PublicRecordPage(alias); throw new Error("Expected redirect");
  } catch (error) {
    expect((error as { digest?: string }).digest).toContain("/p/P-DEMO/conflicts?through=80&target=CF-72");
  }
  for (const query of [{ through: "080" }, { target: "CF-13" }, { status: "open" }, { after: "0" }]) {
    expect(renderToStaticMarkup(await PublicRecordPage({ ...alias, searchParams: Promise.resolve(query) })))
      .toContain("Invalid conflict view");
  }
  expect(resolvePublicRecord(["p", "P-DEMO", "conflicts", "CF-12.json"])).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

test("synthesis conflict anchors link to exact disagreement history at the covered cursor", () => {
  expect(synthesisAnchorLinks("P-DEMO", {
    target_kind: "conflict", target_id: "CF-12", target_seq: 12,
  }, 80)).toEqual({
    human: "/p/P-DEMO/conflicts?through=80&target=CF-12",
    event: "/r/p/P-DEMO/events/12",
  });
  expect(synthesisAnchorLinks("P-DEMO", {
    target_kind: "conflict", target_id: "javascript:alert(1)", target_seq: 12,
  }, 80)).toEqual({ event: "/r/p/P-DEMO/events/12" });
});
