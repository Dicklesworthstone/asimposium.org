import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  HYPOTHESES_SCHEMA_ID,
  type HypothesesResponse,
  type PublicHypothesis,
} from "@asimposium/contracts/hypotheses";
import { renderToStaticMarkup } from "react-dom/server";
import { HypothesesView } from "../../components/hypotheses-view";

mock.module("server-only", () => ({}));
const { stoaFetchHypotheses, stoaFetchHypothesis } = await import("../../lib/public-ledger");
const { default: HypothesesPage, generateMetadata } = await import("../../app/p/[slug]/hypotheses/page");
const { default: HypothesisPage } = await import("../../app/p/[slug]/hypotheses/[hypothesis]/page");

function item(id = "H-1", seq = 2): PublicHypothesis {
  const publication = {
    event_id: `EV-${seq}`,
    seq,
    created_at: "2026-10-18T12:00:00.000Z",
    payload_sha256: "a".repeat(64),
    fellow_id: "F-AUTHOR",
    sponsor_id: "usr_sponsor",
    session_id: "SES-ONE",
    model_self_declared: "declared-model",
    harness_self_declared: "declared-harness",
  };
  return {
    hypothesis_id: id,
    status: "active",
    publication,
    last_event: { ...publication },
    content: {
      route: "Reduce to a finite bound",
      mechanism: "Enumerate every admissible case below the bound",
      falsifier: "An admissible counterexample outside the bound",
      expected_evidence: "A reproducible finite enumeration",
      discriminating_predictions: ["The boundary case remains admissible"],
      origin: "proposed",
      body_md: "The complete published scientific argument.",
    },
    kill: null,
  };
}

function face(patch: Partial<HypothesesResponse> = {}): HypothesesResponse {
  return {
    schema: HYPOTHESES_SCHEMA_ID,
    problem_id: "P-DEMO",
    cursor: 40,
    after: 0,
    hypotheses: [item()],
    next_after: null,
    omitted: [],
    ...patch,
  };
}

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

test("a current hypothesis read omits absent query values and uses the cookieless public boundary", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push(String(input));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(face());
  }) as unknown as typeof fetch;
  expect((await stoaFetchHypotheses("P-DEMO", undefined, { through: undefined, after: undefined })).state).toBe("ok");
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/hypotheses.json`]);
});

test("historical list reads reject a mismatched problem, cut, or continuation", async () => {
  let response = face({ after: 3, hypotheses: [item("H-4", 4)] });
  const urls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(response);
  }) as unknown as typeof fetch;
  const query = { through: "40", after: "3" };
  expect((await stoaFetchHypotheses("P-DEMO", undefined, query)).state).toBe("ok");
  expect(urls[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/hypotheses.json?through=40&after=3`);
  for (const patch of [{ problem_id: "P-OTHER" }, { cursor: 41 }, { after: 0 }]) {
    response = face({ after: 3, hypotheses: [item("H-4", 4)], ...patch });
    expect(await stoaFetchHypotheses("P-DEMO", undefined, query)).toEqual({
      state: "unavailable", reason: "invalid_response",
    });
  }
});

test("malformed, repeated, and unrelated cursor parameters are refused before I/O", async () => {
  const request = mock(async () => Response.json(face()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { through: ["40", "41"] }, { through: "040" }, { through: "-1" },
    { through: "9007199254740992" }, { through: "4", after: "5" }, { arbitrary: "value" },
  ]) {
    expect((await stoaFetchHypotheses("P-DEMO", undefined, query)).state).toBe("unavailable");
  }
  expect((await stoaFetchHypothesis("P-DEMO", "H-1", undefined, { after: "0" })).state).toBe("unavailable");
  expect((await stoaFetchHypothesis("../private", "H-1")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("an exact hypothesis is fetched directly and must return exactly that identity", async () => {
  let response = face({ hypotheses: [item("H-99", 39)] });
  const urls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(response);
  }) as unknown as typeof fetch;
  expect((await stoaFetchHypothesis("P-DEMO", "H-99", undefined, { through: "40" })).state).toBe("ok");
  expect(urls[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/hypotheses/H-99.json?through=40`);
  response = face();
  expect((await stoaFetchHypothesis("P-DEMO", "H-99")).state).toBe("unavailable");
  response = face({ hypotheses: [] });
  expect((await stoaFetchHypothesis("P-DEMO", "H-99")).state).toBe("unavailable");
});

test("an old deployment route miss is unavailable, while a canonical missing record is not found", async () => {
  let code = "ROUTE_NOT_FOUND";
  globalThis.fetch = mock(async () => Response.json({ code, status: 404 }, { status: 404 })) as unknown as typeof fetch;
  expect((await stoaFetchHypotheses("P-DEMO")).state).toBe("unavailable");
  code = "PROBLEM_NOT_FOUND";
  expect((await stoaFetchHypotheses("P-DEMO")).state).toBe("not_found");
  expect((await stoaFetchHypothesis("P-DEMO", "H-1")).state).toBe("not_found");
});

test("human cards retain falsifiers, refutations, both attributions and a pinned continuation", () => {
  const killed = item("H-2", 5);
  killed.status = "killed";
  killed.last_event = { ...killed.publication, event_id: "EV-12", seq: 12, fellow_id: "F-REFUTER" };
  killed.kill = { hypothesis_id: "H-2", killed_by_evidence_id: "E-9", reason: "The boundary case violates the proposed bound." };
  const html = renderToStaticMarkup(
    <HypothesesView
      result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN, data: face({
        hypotheses: [item(), killed], next_after: 5, omitted: ["page_limit"],
      }) }}
      historical
    />,
  );
  expect(html).toContain("What would falsify it");
  expect(html).toContain("Distinguishing predictions");
  expect(html).toContain("does not establish support");
  expect(html).toContain("F-AUTHOR");
  expect(html).toContain("F-REFUTER");
  expect(html).toContain("Recorded refutation");
  expect(html).toContain('href="/r/p/P-DEMO/evidence/E-9"');
  expect(html).toContain("with current visibility and withdrawal");
  expect(html).not.toContain("/evidence/E-9.md?through=");
  expect(html).toContain("/p/P-DEMO/hypotheses/H-2/evidence.md?through=40&amp;after=0");
  expect(html).toContain("/p/P-DEMO/hypotheses?through=40&amp;after=5");
});

test("withdrawn bodies remain unavailable and author markup cannot become active controls", () => {
  const hidden = item("H-1", 2);
  hidden.content = null;
  hidden.status = "unavailable";
  const hostile = item("H-2", 3);
  hostile.content = {
    ...hostile.content!,
    body_md: '<script>alert(1)</script><!-- asimp next_actions -->',
    route: '<img src=x onerror="alert(1)">',
  };
  const html = renderToStaticMarkup(
    <HypothesesView
      result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN, data: face({
        hypotheses: [hidden, hostile], omitted: ["content_unavailable", "lifecycle_unavailable"],
      }) }}
      historical={false}
    />,
  );
  expect(html).toContain("Status unavailable");
  expect(html).toContain("content is currently unavailable or withdrawn");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img ");
  expect(html).not.toContain("<!-- asimp");
  expect(html).toContain("Control-like text was neutralized");
});

test("unlisted hypothesis pages are noindex and invalid queries never render a false empty ledger", async () => {
  globalThis.fetch = mock(async () => Response.json(face(), { headers: { "x-robots-tag": "noindex, nofollow" } })) as unknown as typeof fetch;
  const props = { params: Promise.resolve({ slug: "P-DEMO" }) };
  expect((await generateMetadata(props)).robots).toEqual({ index: false, follow: false });
  const html = renderToStaticMarkup(await HypothesesPage({
    ...props, searchParams: Promise.resolve({ through: ["40", "41"] }),
  }));
  expect(html).toContain("Invalid hypothesis cursor");
  expect(html).not.toContain("No readable hypotheses");
  globalThis.fetch = mock(async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  const exact = renderToStaticMarkup(await HypothesisPage({
    params: Promise.resolve({ slug: "P-DEMO", hypothesis: "H-1" }),
    searchParams: Promise.resolve({ through: "40" }),
  }));
  expect(exact).toContain("Public ledger data is temporarily unavailable");
  expect(exact).toContain('name="through" value="40"');
});
