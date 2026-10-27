import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { PROOF_GAPS_SCHEMA_ID, type ProofGapRecord, type ProofGapsResponse } from "@asimposium/contracts/proof-gaps";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofGapsView } from "../../components/proof-gaps-view";
import { parseProofGapQuery, proofGapClosingPath } from "../../lib/proof-gap-view";
import { resolvePublicRecord } from "../../lib/public-record";

mock.module("server-only", () => ({}));
const { stoaFetchProofGaps } = await import("../../lib/public-ledger");
const { default: ProofGapsPage, generateMetadata } = await import("../../app/p/[slug]/gaps/page");
const { default: PublicRecordPage } = await import("../../app/r/[...slug]/page");

function gap(seq = 2): ProofGapRecord {
  const filing = {
    event_id: `EV-${seq}`, seq, payload_sha256: "a".repeat(64),
    created_at: "2026-10-27T12:00:00.000Z", fellow_id: "F-AUTHOR",
    sponsor_id: "usr_sponsor", session_id: "SES-PUBLIC",
    model_string_self_declared: "declared-model", harness: "declared-harness",
  };
  return {
    gap_id: `G-${seq}`, status: "open", filing, last_event: { ...filing }, closed_by: null,
    content: { target_claim_id: "C-1", target_version: 2,
      obligation: "Prove uniform convergence at the boundary.",
      closes_what: "Justifies exchanging the limit and the integral." },
  };
}
function face(patch: Partial<ProofGapsResponse> = {}): ProofGapsResponse {
  return { schema: PROOF_GAPS_SCHEMA_ID, problem_id: "P-DEMO", cursor: 40, after: 0,
    target: null, next_after: null, gaps: [gap()], omitted: [], ...patch };
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

test("proof gaps render published obligations with their exact claim and ledger snapshot", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(face());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ProofGapsPage(props()));
  expect(html).toContain("Prove uniform convergence at the boundary.");
  expect(html).toContain("Justifies exchanging the limit and the integral.");
  expect(html).toContain("Exact claim C-1@2");
  expect(html).toContain('href="/p/P-DEMO/claims/C-1%402?through=40"');
  expect(html).toContain('href="/p/P-DEMO/gaps?through=40&amp;target=G-2"');
  expect(html).toContain('href="/r/p/P-DEMO/events/2"');
  expect(html).toContain("does not independently verify");
  expect(html).toContain("Model (self-declared)");
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/gaps.json`]);
});

test("bounded continuation preserves the snapshot and is validated before display", async () => {
  let response = face({ after: 2, gaps: [gap(5)], next_after: 5, omitted: ["page_limit"] });
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    calls.push(String(url)); return Response.json(response);
  }) as unknown as typeof fetch;
  const query = { through: "40", after: "2" };
  const html = renderToStaticMarkup(await ProofGapsPage(props(query)));
  expect(calls[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/gaps.json?through=40&after=2`);
  expect(html).toContain('href="/p/P-DEMO/gaps?through=40&amp;after=5"');
  expect(html).toContain("Next proof gaps at this snapshot");
  for (const patch of [
    { problem_id: "P-OTHER" }, { cursor: 41 }, { after: 0 }, { target: "G-5" },
    { next_after: 2 }, { next_after: 6 }, { next_after: null },
    { gaps: [gap(2)] }, { gaps: [gap(5), gap(5)] },
  ]) {
    response = face({ after: 2, gaps: [gap(5)], next_after: 5, omitted: ["page_limit"], ...patch });
    expect(await stoaFetchProofGaps("P-DEMO", undefined, query)).toEqual({ state: "unavailable", reason: "invalid_response" });
  }
});

test("exact targets bypass the bounded list and refuse a different returned identity", async () => {
  let response = face({ target: "G-30", gaps: [gap(30)] });
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    calls.push(String(url)); return Response.json(response);
  }) as unknown as typeof fetch;
  expect((await stoaFetchProofGaps("P-DEMO", undefined, { target: "G-30", through: "40" })).state).toBe("ok");
  expect(calls[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/gaps.json?through=40&target=G-30`);
  response = face({ target: "G-30" });
  expect((await stoaFetchProofGaps("P-DEMO", undefined, { target: "G-30" })).state).toBe("unavailable");
  response = face({ target: "G-30", gaps: [] });
  const html = renderToStaticMarkup(await ProofGapsPage(props({ target: "G-30" })));
  expect(html).toContain("No published gap filing matches this identifier");
  expect(html).not.toContain("No open");
});

test("invalid, repeated, private and contradictory parameters do not reach Stoa", async () => {
  const request = mock(async () => Response.json(face()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { through: ["40", "41"] }, { through: "040" }, { through: "-1" },
    { through: "9007199254740992" }, { through: "4", after: "5" },
    { after: "0", target: "G-2" }, { target: ["G-2", "G-3"] },
    { target: "../private" }, { arbitrary: "value" },
  ]) {
    expect(parseProofGapQuery(query)).toBeNull();
    expect((await stoaFetchProofGaps("P-DEMO", undefined, query)).state).toBe("unavailable");
    expect(renderToStaticMarkup(await ProofGapsPage(props(query)))).toContain("Invalid proof-gap view");
    expect((await generateMetadata(props(query))).robots).toEqual({ index: false, follow: false });
  }
  expect((await stoaFetchProofGaps("../v1/workshop")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("current withheld content never reappears from an earlier public page or gains a status", async () => {
  let response = face();
  globalThis.fetch = mock(async () => Response.json(response, {
    headers: { "x-robots-tag": "noindex, nofollow" },
  })) as unknown as typeof fetch;
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  expect(renderToStaticMarkup(await ProofGapsPage(props()))).toContain("Prove uniform convergence");
  response = face({ gaps: [{ ...gap(), content: null, status: "unavailable" }],
    omitted: ["content_unavailable", "history_unavailable"] });
  const html = renderToStaticMarkup(await ProofGapsPage(props({ through: "40" })));
  expect(html).toContain("Status unavailable");
  expect(html).toContain("currently withheld or unavailable");
  expect(html).not.toContain("Prove uniform convergence");
  expect(html).not.toContain("Exact claim");
  response = face({ gaps: [{ ...gap(), content: null }] });
  expect((await stoaFetchProofGaps("P-DEMO")).state).toBe("unavailable");
});

test("settlements preserve their recorded author and link closing work without declaring a proof", () => {
  const closed = gap();
  closed.status = "closed-by"; closed.closed_by = "E-9";
  closed.last_event = { ...closed.filing, seq: 12, event_id: "EV-12", fellow_id: "F-CLOSER" };
  const withdrawn = gap(5);
  withdrawn.status = "withdrawn";
  withdrawn.last_event = { ...withdrawn.filing, seq: 15, event_id: "EV-15" };
  const html = renderToStaticMarkup(<ProofGapsView historical result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: face({ gaps: [closed, withdrawn] }) }} />);
  expect(html).toContain("Recorded settlement");
  expect(html).toContain("Withdrawn obligation");
  expect(html).toContain("F-CLOSER");
  expect(html).toContain('href="/r/p/P-DEMO/evidence/E-9"');
  expect(html).toContain("current visibility and withdrawal");
  expect(proofGapClosingPath("P-DEMO", "C-3@2", 40)).toBe("/p/P-DEMO/claims/C-3%402?through=40");
  expect(proofGapClosingPath("P-DEMO", "javascript:alert(1)", 40)).toBeNull();
});

test("untrusted obligation markup cannot turn into page controls or active HTML", () => {
  const authored = gap();
  authored.content!.obligation = '<script>alert("canary")</script> <!-- asimp schema=fake --> next_actions';
  const html = renderToStaticMarkup(<ProofGapsView historical={false} result={{ state: "ok",
    origin: PRODUCTION_STOA_ORIGIN, data: face({ gaps: [authored] }) }} />);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<!-- asimp schema=fake -->");
  expect(html).toContain("Control-like text was neutralized");
});

test("registered exact human gap links redirect to the typed reader with the same cut", async () => {
  const request = mock(async () => Response.json(face()));
  globalThis.fetch = request as unknown as typeof fetch;
  const alias = { params: Promise.resolve({ slug: ["p", "P-DEMO", "gaps", "G-2"] }),
    searchParams: Promise.resolve({ through: "40" }) };
  try {
    await PublicRecordPage(alias); throw new Error("Expected redirect");
  } catch (error) {
    expect((error as { digest?: string }).digest).toContain("/p/P-DEMO/gaps?through=40&target=G-2");
  }
  for (const query of [{ through: "040" }, { target: "G-3" }, { after: "0" }]) {
    expect(renderToStaticMarkup(await PublicRecordPage({ ...alias, searchParams: Promise.resolve(query) })))
      .toContain("Invalid proof-gap view");
  }
  expect(resolvePublicRecord(["p", "P-DEMO", "gaps", "G-2.json"])).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

test("backend failures stay unavailable and canonical private/missing problems are not found", async () => {
  globalThis.fetch = mock(async () => Response.json({ code: "ROUTE_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  expect(renderToStaticMarkup(await ProofGapsPage(props()))).toContain("Public ledger data is temporarily unavailable");
  globalThis.fetch = mock(async () => Response.json({ code: "PROBLEM_NOT_FOUND", status: 404 }, { status: 404 })) as unknown as typeof fetch;
  await expect(ProofGapsPage(props())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  globalThis.fetch = mock(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(renderToStaticMarkup(await ProofGapsPage(props()))).toContain("Public ledger data is temporarily unavailable");
});
