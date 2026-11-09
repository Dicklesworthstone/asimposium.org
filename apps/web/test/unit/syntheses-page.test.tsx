import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN, type SynthesisAnchor } from "@asimposium/contracts";
import {
  type SingleSynthesisResponse,
  SingleSynthesisResponseSchema,
  SYNTHESES_SCHEMA_ID,
  type SynthesesListResponse,
} from "@asimposium/contracts/syntheses";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseSynthesisConsoleQuery,
  parseSynthesisTarget,
  synthesisAnchorLinks,
  synthesisConsolePath,
  synthesisSelectionPage,
} from "../../lib/synthesis-view";
import { researchSynthesis, researchSynthesisResponse } from "../fixtures/problem-research";

mock.module("server-only", () => ({}));
const { readPublic, PUBLIC_LEDGER_MAX_BYTES } = await import("../../lib/public-ledger");
const { stoaFetchSyntheses, stoaFetchSynthesis, PUBLIC_SYNTHESES_MAX_BYTES } = await import("../../lib/public-syntheses");
const { default: SynthesesPage, generateMetadata: listMetadata } = await import("../../app/p/[slug]/syntheses/page");
const { default: SynthesisPage, generateMetadata: exactMetadata } = await import("../../app/p/[slug]/syntheses/[synthesis]/page");

function list(patch: Partial<SynthesesListResponse> = {}): SynthesesListResponse {
  return {
    schema: SYNTHESES_SCHEMA_ID, problem_id: "P-RESEARCH", cursor: 40,
    before: null, next_before: 12, syntheses: [researchSynthesis], omitted: ["page_limit"],
    ...patch,
  };
}
function exact(patch: Partial<SingleSynthesisResponse> = {}): SingleSynthesisResponse {
  return { ...researchSynthesisResponse, ...patch };
}
type Query = Record<string, string | string[] | undefined>;
const listProps = (query: Query = {}) => ({
  params: Promise.resolve({ slug: "P-RESEARCH" }), searchParams: Promise.resolve(query),
});
const exactProps = (target = "SYNTH-CLOSING@1", query: Query = {}) => ({
  params: Promise.resolve({ slug: "P-RESEARCH", synthesis: target }),
  searchParams: Promise.resolve(query),
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

test("public syntheses discovery renders immutable links and continues at the captured cut", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.method).toBe("GET");
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(list());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await SynthesesPage(listProps({ limit: "2" })));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-RESEARCH/syntheses.json?limit=2`]);
  expect(html).toContain("1 readable publication on this page");
  expect(html).toContain("at most 2 publication positions");
  expect(html).toContain("A total count is not provided");
  expect(html).toContain("Preview: The exact parity result");
  expect(html).toContain('href="/p/P-RESEARCH/syntheses/SYNTH-CLOSING%401"');
  expect(html).toContain('href="/p/P-RESEARCH/syntheses?through=40&amp;before=12&amp;limit=2"');
  expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-RESEARCH/syntheses.json?through=40&amp;limit=2`);
  expect(html).toContain("Publication alone does not resolve the problem");
  expect(html).not.toContain("<script>");
});

test("a wholly withheld page still advances and never claims the synthesis history is empty", async () => {
  globalThis.fetch = mock(async () => Response.json(list({
    before: 12, next_before: 6, syntheses: [], omitted: ["content_unavailable", "page_limit"],
  }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await SynthesesPage(listProps({ through: "40", before: "12", limit: "2" })));
  expect(html).toContain("No readable syntheses were returned on this page");
  expect(html).toContain("An omitted record is not evidence that no synthesis was published");
  expect(html).toContain('href="/p/P-RESEARCH/syntheses?through=40&amp;before=6&amp;limit=2"');
  expect(html).toContain('href="/p/P-RESEARCH/syntheses?through=40&amp;limit=2"');
  expect(html).toContain("Check for newer publications");
  expect(html).not.toContain("No published syntheses were returned");
});

test("empty public history is distinct from unavailable content and an unavailable deployment", async () => {
  globalThis.fetch = mock(async () => Response.json(list({
    syntheses: [], next_before: null, omitted: [],
  }))) as unknown as typeof fetch;
  const empty = renderToStaticMarkup(await SynthesesPage(listProps()));
  expect(empty).toContain("No published syntheses were returned in this range");
  expect(empty).not.toContain("Older syntheses at this snapshot");
  globalThis.fetch = mock(async () => Response.json({ code: "ROUTE_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  const unavailable = renderToStaticMarkup(await SynthesesPage(listProps({ through: "40", before: "12", limit: "2" })));
  expect(unavailable).toContain("Public ledger data is temporarily unavailable");
  expect(unavailable).toContain('action="/p/P-RESEARCH/syntheses"');
  for (const [name, value] of [["through", "40"], ["before", "12"], ["limit", "2"]]) {
    expect(unavailable).toContain(`name="${name}" value="${value}"`);
  }
  expect(unavailable).not.toContain("No published syntheses");
  globalThis.fetch = mock(async () => Response.json({ status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  await expect(SynthesesPage(listProps())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  await expect(SynthesisPage(exactProps())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});

test("the collection refuses mismatched snapshot, identity, sequence and continuation responses", async () => {
  let response: unknown = list();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  const invalid = { state: "unavailable", reason: "invalid_response" } as const;
  for (const patch of [
    { problem_id: "P-OTHER" }, { cursor: 41 }, { before: 13 },
    { next_before: null }, { next_before: 41 },
    { syntheses: [researchSynthesis, researchSynthesis] },
    { syntheses: [{ ...researchSynthesis, problem_id: "P-OTHER" }] },
    { syntheses: [{ ...researchSynthesis, seq: 41 }] },
    { syntheses: [{ ...researchSynthesis, covers_through: 12 }] },
    { syntheses: [{ ...researchSynthesis, anchors: [{ target_kind: "claim", target_id: "C-3", target_seq: 12 }] }] },
  ] satisfies Partial<SynthesesListResponse>[]) {
    response = list(patch);
    expect(await stoaFetchSyntheses("P-RESEARCH", undefined, { through: "40" })).toEqual(invalid);
  }
  response = list({ syntheses: [
    { ...researchSynthesis, synthesis_id: "SYNTH-NEW", seq: 13 }, researchSynthesis,
  ] });
  expect(await stoaFetchSyntheses("P-RESEARCH", undefined, { limit: "1" })).toEqual(invalid);
});

test("invalid or repeated collection parameters do not cause outbound requests", async () => {
  const request = mock(async () => Response.json(list()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { before: "12" }, { through: "11", before: "12" }, { through: "040" },
    { through: ["40", "41"] }, { before: "1\n", through: "40" },
    { through: "9007199254740992" }, { limit: "0" }, { limit: "201" }, { private: "true" },
  ]) {
    expect(renderToStaticMarkup(await SynthesesPage(listProps(query)))).toContain("Invalid synthesis collection view");
    expect((await listMetadata(listProps(query))).robots).toEqual({ index: false, follow: false });
    expect((await stoaFetchSyntheses("P-RESEARCH", undefined, query)).state).toBe("unavailable");
  }
  expect((await stoaFetchSyntheses("../v1/workshop")).state).toBe("unavailable");
  expect((await stoaFetchSyntheses("P-RESEARCH", "https://attacker.example")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("an exact digest renders the complete scientific work, safe mathematics and recorded limits", async () => {
  const body = `A finite result gives $n^2 \\geq 0$.\n\n${"A detailed argument. ".repeat(100)}\n\nEND-OF-COMPLETE-DIGEST\n\n<script>untrusted()</script> [unsafe](javascript:alert(1))`;
  globalThis.fetch = mock(async () => Response.json(exact({
    synthesis: { ...researchSynthesis, body_md: body, anchors: [
      { target_kind: "claim", target_id: "C-3", target_version: 1, target_seq: 3, assertion_summary: "<img src=x onerror=bad()>" },
      { target_kind: "statement", target_id: "P-RESEARCH", target_version: 2, target_seq: 1 },
      { target_kind: "conflict", target_id: "javascript:alert(1)", target_seq: 7 },
    ] },
    staleness: { material_events_since: 2, stale: true },
  }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await SynthesisPage(exactProps()));
  for (const text of [
    "Complete published digest", "END-OF-COMPLETE-DIGEST", "katex", "Recorded source anchors",
    "F-RESEARCH-AUTHOR", "self-declared-model", "self-declared-harness", "S-RESEARCH",
    "Only the exact finite parity result.", "A recorded refutation attempt and two independent write-up checks.",
    "No formal-kernel or outside expert review is claimed.", "Unrelated exploratory findings.",
    "2 later material events were recorded", "does not establish that the problem has been resolved",
  ]) expect(html).toContain(text);
  expect(html).toContain('href="/p/P-RESEARCH/claims/C-3%401?through=11"');
  expect(html).toContain('href="/p/P-RESEARCH/statements/2?through=11"');
  expect(html).toContain('href="/r/p/P-RESEARCH/events/7"');
  expect(html).toContain('href="/r/p/P-RESEARCH/events/12"');
  expect(html).toContain('href="/console/problems/P-RESEARCH?synthesis=SYNTH-CLOSING"');
  expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-RESEARCH/syntheses/SYNTH-CLOSING%401.json`);
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<textarea");
});

test("exact responses must match the requested publication and report coherent freshness", async () => {
  let response = exact();
  const request = mock(async () => Response.json(response));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const patch of [
    { synthesis: { ...researchSynthesis, synthesis_id: "SYNTH-OTHER" } },
    { synthesis: { ...researchSynthesis, problem_id: "P-OTHER" } },
    { synthesis: { ...researchSynthesis, covers_through: researchSynthesis.seq } },
    { staleness: { material_events_since: 0, stale: true } },
    { staleness: { material_events_since: 1, stale: false } },
  ]) {
    response = exact(patch);
    expect(await stoaFetchSynthesis("P-RESEARCH", "SYNTH-CLOSING@1"))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
  }
  response = exact();
  expect((await stoaFetchSynthesis("P-RESEARCH", "SYNTH-CLOSING")).state).toBe("ok");
  expect((await stoaFetchSynthesis("P-RESEARCH", "SYNTH-CLOSING@1")).state).toBe("ok");
  expect(renderToStaticMarkup(await SynthesisPage(exactProps()))).toContain("freshness check does not verify the digest");
});

test("unsupported exact versions or historical parameters never silently read another publication", async () => {
  const request = mock(async () => Response.json(exact()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const target of ["SYNTH-CLOSING@2", "SYNTH-CLOSING@01", "SYNTH-CLOSING\n", "../v1/workshop", "SYNTH--X"]) {
    expect(parseSynthesisTarget(target)).toBeNull();
    expect((await stoaFetchSynthesis("P-RESEARCH", target)).state).toBe("unavailable");
    await expect(SynthesisPage(exactProps(target))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  }
  for (const query of [{ through: "11" }, { through: ["11", "12"] }, { unknown: "1" }]) {
    expect(renderToStaticMarkup(await SynthesisPage(exactProps("SYNTH-CLOSING@1", query))))
      .toContain("historical cursors and other query parameters are not supported");
    expect((await exactMetadata(exactProps("SYNTH-CLOSING@1", query))).robots)
      .toEqual({ index: false, follow: false });
  }
  expect(request).not.toHaveBeenCalled();
});

test("public collection and exact metadata retain current source noindex policy", async () => {
  globalThis.fetch = mock(async () => Response.json(list(), { headers: { "x-robots-tag": "noindex, nofollow" } })) as unknown as typeof fetch;
  expect((await listMetadata(listProps())).robots).toEqual({ index: false, follow: false });
  expect(renderToStaticMarkup(await SynthesesPage(listProps()))).toContain("A guessable URL is not private");
  globalThis.fetch = mock(async () => Response.json(exact(), { headers: { "x-robots-tag": "noindex, nofollow" } })) as unknown as typeof fetch;
  expect((await exactMetadata(exactProps())).robots).toEqual({ index: false, follow: false });
  expect(renderToStaticMarkup(await SynthesisPage(exactProps()))).toContain("A guessable URL is not private");
});

test("large valid synthesis sources use an explicit budget without weakening existing public reads", async () => {
  const large = exact({ synthesis: { ...researchSynthesis, omitted: Array.from({ length: 700 }, () => "x".repeat(1900)) } });
  expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(PUBLIC_LEDGER_MAX_BYTES);
  globalThis.fetch = mock(async () => Response.json(large)) as unknown as typeof fetch;
  expect((await stoaFetchSynthesis("P-RESEARCH", "SYNTH-CLOSING")).state).toBe("ok");
  expect(await readPublic("/p/P-RESEARCH/syntheses/SYNTH-CLOSING.json", PRODUCTION_STOA_ORIGIN, SingleSynthesisResponseSchema, 0))
    .toEqual({ state: "unavailable", reason: "oversize" });
  globalThis.fetch = mock(async () => Response.json(exact(), { headers: { "content-length": String(PUBLIC_SYNTHESES_MAX_BYTES + 1) } })) as unknown as typeof fetch;
  expect(await stoaFetchSynthesis("P-RESEARCH", "SYNTH-CLOSING"))
    .toEqual({ state: "unavailable", reason: "oversize" });
  globalThis.fetch = mock(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(PUBLIC_SYNTHESES_MAX_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  }))) as unknown as typeof fetch;
  expect(await stoaFetchSynthesis("P-RESEARCH", "SYNTH-CLOSING"))
    .toEqual({ state: "unavailable", reason: "oversize" });
  const request = mock(async () => Response.json(exact()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const budget of [0, -1, 1.5, Number.POSITIVE_INFINITY, PUBLIC_SYNTHESES_MAX_BYTES + 1]) {
    expect(await readPublic("/p/P-RESEARCH/syntheses/SYNTH-CLOSING.json", PRODUCTION_STOA_ORIGIN, SingleSynthesisResponseSchema, 0, undefined, undefined, budget))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
  }
  expect(request).not.toHaveBeenCalled();
});

test("anchor links respect known route grammars, exact versions and the author's covered cursor", () => {
  const link = (anchor: SynthesisAnchor) => synthesisAnchorLinks("P-RESEARCH", anchor, 11);
  expect(link({ target_kind: "claim", target_id: "C-3", target_version: 2, target_seq: 3 }))
    .toEqual({ human: "/p/P-RESEARCH/claims/C-3%402?through=11", event: "/r/p/P-RESEARCH/events/3" });
  expect(link({ target_kind: "hypothesis", target_id: `H-${"a".repeat(64)}`, target_version: 1 }).human)
    .toBe(`/p/P-RESEARCH/hypotheses/H-${"a".repeat(64)}?through=11`);
  expect(link({ target_kind: "statement", target_id: "P-RESEARCH", target_version: 2 }).human)
    .toBe("/p/P-RESEARCH/statements/2?through=11");
  expect(link({ target_kind: "citation", target_id: "L-3", target_version: 2 }).agent)
    .toBe("/p/P-RESEARCH/citations/L-3%402.json?through=11");
  expect(link({ target_kind: "citation", target_id: "L-3", target_version: 2 }).human)
    .toBe("/p/P-RESEARCH/citations/L-3%402?through=11");
  for (const anchor of [
    { target_kind: "claim", target_id: "C-3" },
    { target_kind: "claim", target_id: "//attacker.example", target_version: 1 },
    { target_kind: "hypothesis", target_id: "H-INVENTED", target_version: 1 },
    { target_kind: "statement", target_id: "P-OTHER", target_version: 2 },
    { target_kind: "conflict", target_id: "javascript:alert(1)" },
  ] satisfies SynthesisAnchor[]) expect(link(anchor)).toEqual({});
  expect(link({ target_kind: "claim", target_id: " C-3", target_version: 1, target_seq: 3 }))
    .toEqual({ event: "/r/p/P-RESEARCH/events/3" });
  expect(link({ target_kind: "conflict", target_id: "X-1", target_seq: 12 })).toEqual({});
});

test("sponsor query selection is only an identifier and slim metadata, never scientific command content", () => {
  const parsed = parseSynthesisConsoleQuery({ synthesis: "SYNTH-CLOSING", through: "40", before: "12", limit: "2" });
  expect(parsed).toEqual({ selected: "SYNTH-CLOSING", list: { through: 40, before: 12, limit: 2 } });
  expect(synthesisConsolePath("P-RESEARCH", parsed?.selected, parsed?.list))
    .toBe("/console/problems/P-RESEARCH?through=40&before=12&limit=2&synthesis=SYNTH-CLOSING");
  for (const query of [{ synthesis: ["SYNTH-CLOSING", "SYNTH-OTHER"] }, { synthesis: "SYNTH-CLOSING@1" },
    { synthesis: "SYNTH-CLOSING\n" }, { summary: "authored by a sponsor" }, { before: "12" }]) {
    expect(parseSynthesisConsoleQuery(query)).toBeNull();
  }
  const selection = synthesisSelectionPage(list());
  expect(selection.choices[0]?.can_preview).toBe(true);
  expect(selection.choices[0]?.closing?.result_claim).toEqual({ claim_id: "C-3", version: 1 });
  expect(JSON.stringify(selection)).not.toContain(researchSynthesis.body_md);
  expect(JSON.stringify(selection)).not.toContain("no_claim_boundary");
  expect(JSON.stringify(selection)).not.toContain("Unrelated exploratory findings");
  const tooLong = synthesisSelectionPage(list({ syntheses: [{ ...researchSynthesis, body_md: "x".repeat(8193) }] }));
  expect(tooLong.choices[0]?.can_preview).toBe(false);
});
