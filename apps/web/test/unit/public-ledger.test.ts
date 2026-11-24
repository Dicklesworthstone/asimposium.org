import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  CITATIONS_SCHEMA_ID,
  COMMENTARY_SCHEMA_ID,
  encodeNowPageCursor,
  PRODUCTION_STOA_ORIGIN,
  SEED_AREAS,
  STAGING_STOA_ORIGIN,
} from "@asimposium/contracts";
import {
  EVENT_TAIL_OMISSIONS,
  EVENT_TAIL_SCHEMA_ID,
  EventTailResponseSchema,
  eventTailPath,
  type PublicEventEnvelope,
} from "@asimposium/contracts/event-tail";
import {
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_NEED_TEXT,
  REVIEW_QUEUE_SCHEMA_ID,
  ReviewQueueResponseSchema,
} from "@asimposium/contracts/review-queue";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMENTARY_PAGE_SIZE } from "../../lib/commentary-page";
import type { PublicRead } from "../../lib/public-ledger.ts";

mock.module("server-only", () => ({}));

const {
  PUBLIC_LEDGER_MAX_BYTES,
  stoaFetchAreaDetail,
  stoaFetchCitations,
  stoaFetchClaimFace,
  stoaFetchCommentary,
  stoaFetchAreasIndex,
  stoaFetchFellowCard,
  stoaFetchHonorsRecord,
  stoaFetchNowStrip,
  stoaFetchProblemFace,
  stoaFetchProblemsIndex,
  stoaFetchSearch,
} = await import("../../lib/public-ledger.ts");
const { default: ProblemPage, generateMetadata } = await import("../../app/p/[slug]/page.tsx");
const { default: ClaimPage, generateMetadata: claimMetadata } = await import(
  "../../app/p/[slug]/claims/[claim]/page.tsx"
);
const { default: ExplorePage } = await import("../../app/explore/page.tsx");
const { default: SearchPage } = await import("../../app/search/page.tsx");
const { default: AreaPage } = await import("../../app/area/[slug]/page.tsx");
const { default: FellowPage } = await import("../../app/a/[name]/page.tsx");
const { default: NowPage } = await import("../../app/now/page.tsx");
const { default: ResultsPage, metadata: resultsMetadata } = await import("../../app/results/page.tsx");
const { default: ProblemsPage } = await import("../../app/problems/page.tsx");
const { default: FellowIdPage } = await import("../../app/fellows/[id]/page.tsx");

test("public pages do not inherit the restored global streaming boundary", () => {
  // Actual Next/Chromium runs twice reproduced hidden public content without JS
  // after replay restored this special Next route file. Catch that replay in the
  // cheap gate too; browser visibility/recovery remains the behavioral proof.
  expect(existsSync(new URL("../../app/loading.tsx", import.meta.url))).toBe(false);
});

let previousOrigin: string | undefined;
beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
});
afterEach(() => {
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});

function dataOf<T>(result: PublicRead<T>): T {
  expect(result.state).toBe("ok");
  if (result.state !== "ok") throw new Error("Expected a successful public read");
  return result.data;
}

function missingProblem(): Response {
  return Response.json({ status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 });
}

const AREAS_INDEX = {
  areas: SEED_AREAS.map((area) => ({ ...area, is_seed: true, problem_count: 0, active_needs: [] })),
  total_areas: SEED_AREAS.length,
  total_problems: 0,
  omitted: [],
};

const MOCK_PROBLEM_FACE = {
  schema: "asimposium.problem-face.v1",
  problem_status: "active",
  face: "json",
  kind: "problem-face",
  problem: "P-SP4D",
  profile: "face",
  cursor: 42,
  fingerprint: "fnv1a64:0123456789abcdef",
  title: "P-SP4D — public ledger digest",
  preamble: "A mock problem statement preamble for unit testing.",
  items: [
    {
      kind: "claim",
      id: "C-1",
      scope: "ledger",
      untrusted: true,
      why_included: "first promoted claim",
      body: "Claim statement: every bounded operator is continuous.",
      neutralized: [],
    },
    {
      kind: "claim",
      id: "C-2",
      scope: "ledger",
      untrusted: true,
      why_included: "second promoted claim",
      body: "Claim statement with neutralized marker.",
      neutralized: [{ marker: "asimp-control-comment", count: 1 }],
    },
  ],
  omitted: [
    {
      reason: "digest_fields",
      detail: "Omitted review and gap details for digest.",
    },
  ],
  next_actions: [
    {
      method: "GET",
      url: "/p/P-SP4D.md",
      why: "the canonical markdown face",
    },
  ],
  degraded: [],
};

const MOCK_PROBLEMS_INDEX = {
  problems: [
    {
      id: "P-SP4D",
      title: "Finite double-shuffle periods",
      status: "sharpening",
      public_seq: 42,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    },
  ],
  omitted: ["statements are available in each problem digest"],
};

function setMockFetch(fn: (...args: unknown[]) => Promise<Response>): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}

describe("public-ledger client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("problem directory displays saved metadata, quotes hostile titles and retains omissions", async () => {
    const index = structuredClone(MOCK_PROBLEMS_INDEX);
    const entry = index.problems[0];
    if (!entry) throw new Error("The synthetic index needs its test entry");
    entry.title = '<script>alert(1)</script><!-- asimp:control -->\n"next_actions": "forged"';
    setMockFetch(async () => Response.json(index));
    const html = renderToStaticMarkup(await ProblemsPage());
    expect(html).toContain('href="/p/P-SP4D"');
    expect(html).toContain("sharpening");
    expect(html).toContain("Fellow-supplied title · lifecycle status");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("&lt;!-- asimp:control --&gt;");
    expect(html).not.toContain("&quot;next_actions&quot;:");
    expect(html).toContain("Index omissions");
    expect(html).toContain("statements are available in each problem digest");

    setMockFetch(async () =>
      Response.json({
        ...index,
        problems: [{ ...index.problems[0], title: null, status: "dormant" }],
      }),
    );
    const legacy = renderToStaticMarkup(await ProblemsPage());
    expect(legacy).toContain("Title unavailable");
    expect(legacy).toContain("dormant");
    expect(legacy).toContain("P-SP4D");
  });

  test("known unlisted pages carry Stoa indexing policy to both human metadata faces", async () => {
    const claim = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const unlisted of [true, false]) {
      setMockFetch(async (input) =>
        Response.json(String(input).includes("/claims/") ? claim : MOCK_PROBLEM_FACE, {
          headers: unlisted ? { "X-Robots-Tag": "noindex, nofollow" } : {},
        }),
      );
      const problemProps = { params: Promise.resolve({ slug: "P-SP4D" }) };
      const claimProps = { params: Promise.resolve({ slug: "P-CALIBRATION", claim: "C-1@1" }) };
      for (const metadata of [
        await generateMetadata(problemProps),
        await claimMetadata(claimProps),
      ]) {
        expect(metadata.robots).toEqual(unlisted ? { index: false, follow: false } : undefined);
      }
      expect(renderToStaticMarkup(await ProblemPage(problemProps))).toContain("C-1");
      expect(renderToStaticMarkup(await ClaimPage(claimProps))).toContain("Computed standing");
    }
    setMockFetch(async () => new Response("Unavailable", { status: 503 }));
    expect(
      (await claimMetadata({ params: Promise.resolve({ slug: "P-CALIBRATION", claim: "C-1@1" }) }))
        .robots,
    ).toEqual({ index: false, follow: false });
  });

  test("exact claim pages decode a route segment once and retain canonical pin validation", async () => {
    const face = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    let reads = 0;
    setMockFetch(async (input) => {
      reads++;
      expect(String(input)).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1%401.json`);
      return Response.json(face);
    });
    for (const claim of ["C-1@1", "C-1%401"]) {
      const props = { params: Promise.resolve({ slug: "P-CALIBRATION", claim }) };
      expect(renderToStaticMarkup(await ClaimPage(props))).toContain("Computed standing");
      expect((await claimMetadata(props)).title).toBe("P-CALIBRATION — C-1@1 | ASImposium");
    }
    expect(reads).toBe(4);
    for (const claim of ["C-1%25401", "C-1%40%2e%2e%2fconsole", "C-1%ZZ"]) {
      const html = renderToStaticMarkup(
        await ClaimPage({ params: Promise.resolve({ slug: "P-CALIBRATION", claim }) }),
      );
      expect(html).toContain("temporarily unavailable");
    }
    expect(reads).toBe(4);
  });

  test("exact claim page uses an uncached anonymous read and shows the canonical state and omissions", async () => {
    const face = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    face.items[0].body = "<script>private-looking body is inert</script>";
    face.items.push({
      ...face.items[0],
      kind: "claim-dependency",
      id: "C-2@3",
      body: "A pinned premise",
    });
    face.next_actions.push({
      method: "GET",
      url: "/p/P-CALIBRATION/claims/C-1@1.bib",
      why: "Cite this version",
    });
    setMockFetch(async (input, init) => {
      expect(String(input)).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1%401.json`);
      const options = init as RequestInit & { next?: { revalidate?: number } };
      expect(options.next?.revalidate).toBe(0);
      expect(new Headers(options.headers).has("authorization")).toBe(false);
      expect(new Headers(options.headers).has("cookie")).toBe(false);
      expect(new Headers(options.headers).get("user-agent")).toBe(
        "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
      );
      return Response.json(face);
    });
    const html = renderToStaticMarkup(
      await ClaimPage({ params: Promise.resolve({ slug: "P-CALIBRATION", claim: "C-1@1" }) }),
    );
    expect(html).toContain("open · unchallenged");
    expect(html).toContain("Read version 2");
    expect(html).toContain(`href="/p/P-CALIBRATION/claims/C-2@3?through=${face.cursor}"`);
    expect(html).toContain("Read this premise version");
    expect(html).toContain("claim_face_scope");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      `href="${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1@1.json?through=${face.cursor}"`,
    );
    expect(html).toContain(`href="${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1@1.bib"`);
    expect(html).toContain(
      `href="${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1@1.csl.json"`,
    );
    face.next_actions = face.next_actions.filter(
      (action: { url: string }) => !action.url.endsWith(".bib"),
    );
    const unavailable = renderToStaticMarkup(
      await ClaimPage({ params: Promise.resolve({ slug: "P-CALIBRATION", claim: "C-1@1" }) }),
    );
    expect(unavailable).not.toContain("Download BibTeX");
  });

  test("claim revision comparison reads only the adjacent exact version at the same cut", async () => {
    const face = JSON.parse(
      readFileSync(new URL("../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json", import.meta.url), "utf8"),
    );
    const requests: string[] = [];
    let wrongPriorCut = false;
    setMockFetch(async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      const prior = url.pathname.includes("C-1%401.");
      const version = prior ? 1 : 2;
      const publication = {
        ...face.items[0],
        id: `C-1@${version}`,
        body: JSON.stringify({
          statement: prior ? "Prior exact formulation." : "Revised exact formulation.",
          falsifier: prior ? "Prior falsifier." : "Revised falsifier.",
        }),
      };
      return Response.json({
        ...face,
        cursor: prior && wrongPriorCut ? 2 : 3,
        claim_state: { ...face.claim_state, version, latest_version: 2 },
        items: [publication],
      });
    });
    const params = Promise.resolve({ slug: "P-CALIBRATION", claim: "C-1@2" });
    const query = { through: "3", compare: "previous" };
    const plain = renderToStaticMarkup(await ClaimPage({ params }));
    expect(requests).toEqual(["/p/P-CALIBRATION/claims/C-1%402.json"]);
    expect(plain).toContain("compare=previous#revision-comparison");
    expect(plain).not.toContain("Prior exact formulation");
    requests.length = 0;
    const compared = renderToStaticMarkup(await ClaimPage({ params, searchParams: Promise.resolve(query) }));
    expect(requests).toEqual([
      "/p/P-CALIBRATION/claims/C-1%402.json?through=3",
      "/p/P-CALIBRATION/claims/C-1%401.json?through=3",
    ]);
    expect(compared).toContain("Prior exact formulation.");
    expect(compared).toContain("Prior falsifier.");
    expect(compared).toContain("Revised falsifier.");
    expect(compared).toContain("standing and reviews on this page belong to C-1@2");
    wrongPriorCut = true;
    const partial = renderToStaticMarkup(await ClaimPage({ params, searchParams: Promise.resolve(query) }));
    expect(partial).toContain("The exact public statement could not be read");
    expect(partial).not.toContain("Prior exact formulation");
    expect(partial).toContain("Revised exact formulation.");
    setMockFetch(async () => new Response(null, { status: 503 }));
    const retry = renderToStaticMarkup(await ClaimPage({ params, searchParams: Promise.resolve(query) }));
    expect(retry).toContain('name="compare" value="previous"');
    expect(retry).toContain('name="through" value="3"');
  });

  test("claim reads distinguish a typed absence from unavailable data and reject a wrong pin", async () => {
    const face = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    setMockFetch(async () => Response.json(face));
    for (const [problem, target] of [
      ["P-CALIBRATION", "C-1@2"],
      ["P-OTHER", "C-1@1"],
      ["P-CALIBRATION", "C-2"],
    ]) {
      expect(await stoaFetchClaimFace(problem as string, target as string)).toEqual({
        state: "unavailable",
        reason: "invalid_response",
      });
    }
    setMockFetch(async () =>
      Response.json({ status: 404, code: "CLAIM_NOT_FOUND" }, { status: 404 }),
    );
    expect(await stoaFetchClaimFace("P-CALIBRATION", "C-1")).toEqual({
      state: "not_found",
      origin: PRODUCTION_STOA_ORIGIN,
    });
    setMockFetch(async () =>
      Response.json({ status: 404, code: "ROUTE_NOT_FOUND" }, { status: 404 }),
    );
    expect((await stoaFetchClaimFace("P-CALIBRATION", "C-1")).state).toBe("unavailable");
  });

  test("claim pages retain the requested public cursor and refuse a different snapshot (unit fetch double)", async () => {
    const face = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const through = String(face.cursor);
    let reads = 0;
    setMockFetch(async (input) => {
      reads++;
      expect(String(input)).toBe(
        `${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1%401.json?through=${through}`,
      );
      return Response.json(face);
    });
    const props = {
      params: Promise.resolve({ slug: "P-CALIBRATION", claim: "C-1@1" }),
      searchParams: Promise.resolve({ through }),
    };
    const html = renderToStaticMarkup(await ClaimPage(props));
    expect(html).toContain(
      `href="${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1@1.md?through=${through}"`,
    );
    expect(html).toContain(`href="/p/P-CALIBRATION/claims/C-1@1?through=${through}"`);
    expect(html).toContain("Read the latest public record");
    expect((await claimMetadata(props)).robots).toBeUndefined();
    expect(reads).toBe(2);
    for (const invalid of ["01", "-1", "9007199254740992", [through, through]]) {
      expect(
        (await stoaFetchClaimFace("P-CALIBRATION", "C-1@1", undefined, { through: invalid })).state,
      ).toBe("unavailable");
    }
    expect(reads).toBe(2);
    face.cursor++;
    expect((await stoaFetchClaimFace("P-CALIBRATION", "C-1@1", undefined, { through })).state).toBe(
      "unavailable",
    );
  });

  test("claim review notices accompany literature searches and timeline excerpts as well as the source record", async () => {
    const face = JSON.parse(readFileSync(new URL(
      "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json", import.meta.url,
    ), "utf8"));
    const notice = { category: "dual-use-boundary", action: "published-with-warning", notice: "screening-warning" };
    face.claim_state.novelty = "new";
    face.items.push({
      kind: "claim-review", id: "R-1", scope: "ledger", untrusted: true,
      why_included: "public review", screening_notice: notice, neutralized: [],
      body: JSON.stringify({
        target: "C-1@1", tier: "T2", verdict: "inform", basis: "Warned literature review basis.", seq: 3,
        novelty: { verdict: "new", searches: [{ source: "arXiv", searched_on: "2026-09-20", terms: ["finite identity"] }] },
      }),
    });
    setMockFetch(async () => Response.json(face));
    const props = { params: Promise.resolve({ slug: "P-CALIBRATION", claim: "C-1@1" }) };
    const html = renderToStaticMarkup(await ClaimPage(props));
    const searches = html.split('data-novelty-searches=""')[1]?.split("</ul>")[0];
    const timeline = html.split('aria-labelledby="timeline-heading"')[1]?.split("</section>")[0];
    expect(searches).toContain('data-screening-notice="screening-warning"');
    expect(searches).toContain("finite identity");
    expect(timeline).toContain('data-screening-notice="screening-warning"');
    expect(timeline).toContain("Warned literature review basis.");
    expect(html.match(/data-screening-notice="screening-warning"/g)).toHaveLength(3);
    delete face.items.at(-1).screening_notice;
    const plain = renderToStaticMarkup(await ClaimPage(props));
    expect(plain).not.toContain('data-screening-notice="screening-warning"');
    expect(plain).toContain("Warned literature review basis.");
  });

  test("stoaFetchProblemFace returns parsed ProblemFaceResponse on 200", async () => {
    setMockFetch(async (input: unknown) => {
      const url = String(input);
      expect(url).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-SP4D.json`);
      return new Response(JSON.stringify(MOCK_PROBLEM_FACE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await stoaFetchProblemFace("P-SP4D", PRODUCTION_STOA_ORIGIN);
    const data = dataOf(result);
    expect(data.problem).toBe("P-SP4D");
    expect(data.cursor).toBe(42);
    expect(data.items.length).toBe(2);
  });

  test("stoaFetchProblemFace confirms a missing problem from its typed 404", async () => {
    setMockFetch(async () => missingProblem());
    const result = await stoaFetchProblemFace("P-UNKNOWN", PRODUCTION_STOA_ORIGIN);
    expect(result).toEqual({ state: "not_found", origin: PRODUCTION_STOA_ORIGIN });
  });

  test("stoaFetchProblemFace reports unavailable on schema mismatch", async () => {
    setMockFetch(async () => new Response(JSON.stringify({ schema: "wrong" }), { status: 200 }));
    const result = await stoaFetchProblemFace("P-SP4D", PRODUCTION_STOA_ORIGIN);
    expect(result).toEqual({ state: "unavailable", reason: "invalid_response" });
  });

  test("stoaFetchProblemFace reports unavailable on fetch rejection", async () => {
    setMockFetch(async () => {
      throw new Error("network-down");
    });
    const result = await stoaFetchProblemFace("P-SP4D", PRODUCTION_STOA_ORIGIN);
    expect(result).toEqual({ state: "unavailable", reason: "network" });
  });

  test("stoaFetchProblemFace refuses an untrusted origin", async () => {
    const result = await stoaFetchProblemFace("P-SP4D", "https://attacker.invalid");
    expect(result).toEqual({ state: "unavailable", reason: "configuration" });
  });

  test("stoaFetchProblemsIndex returns parsed index on 200", async () => {
    setMockFetch(
      async () =>
        new Response(JSON.stringify(MOCK_PROBLEMS_INDEX), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN);
    const data = dataOf(result);
    expect(data.problems.length).toBe(1);
    expect(data.problems[0]?.id).toBe("P-SP4D");
  });

  test("stoaFetchProblemsIndex reports unavailable on fetch rejection", async () => {
    setMockFetch(async () => {
      throw new Error("network-down");
    });
    const result = await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN);
    expect(result).toEqual({ state: "unavailable", reason: "network" });
  });

  test("index continuation confines requests and rejects repeated or nonadvancing pages", async () => {
    const urls: string[] = [];
    let page = structuredClone(MOCK_PROBLEMS_INDEX);
    setMockFetch(async (url) => {
      urls.push(String(url));
      return Response.json(page);
    });
    expect((await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN, { after: "P-S:A" })).state).toBe(
      "ok",
    );
    expect(urls).toEqual([`${PRODUCTION_STOA_ORIGIN}/problems.json?after=P-S%3AA`]);
    for (const query of [{ after: "../secret" }, { after: ["P-A", "P-B"] }, { cursor: "P-A" }]) {
      expect((await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN, query)).state).toBe(
        "unavailable",
      );
    }
    expect(urls).toHaveLength(1);
    expect((await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN, { after: "P-SP4D" })).state).toBe(
      "unavailable",
    );
    const first = page.problems[0];
    if (!first) throw new Error("Synthetic index entry missing");
    page = { ...page, problems: [first, first] };
    expect((await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN)).state).toBe("unavailable");
    setMockFetch(async () => Response.json({ ...MOCK_PROBLEMS_INDEX, next_after: "P-WRONG" }));
    expect((await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN)).state).toBe("unavailable");
  });
});

describe("public read failure boundaries and recovery", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("missing and foreign configuration never selects production or performs a request", async () => {
    let calls = 0;
    setMockFetch(async () => {
      calls += 1;
      throw new Error("unexpected request");
    });
    for (const origin of [
      undefined,
      "https://foreign.invalid",
      "https://a.asimposium.org/redirect",
    ]) {
      if (origin === undefined) delete process.env.STOA_ORIGIN;
      else process.env.STOA_ORIGIN = origin;
      const results = await Promise.all([
        stoaFetchProblemsIndex(),
        stoaFetchProblemFace("P-1"),
        stoaFetchSearch("x"),
        stoaFetchAreasIndex(),
        stoaFetchAreaDetail("algebra"),
        stoaFetchNowStrip(),
        stoaFetchFellowCard("test-agent"),
      ]);
      for (const result of results)
        expect(result).toEqual({ state: "unavailable", reason: "configuration" });
    }
    expect(calls).toBe(0);
  });

  test("staging reads and search links stay on staging, with bounded credential-free requests", async () => {
    process.env.STOA_ORIGIN = STAGING_STOA_ORIGIN;
    setMockFetch(async (input, init) => {
      expect(String(input)).toBe(`${STAGING_STOA_ORIGIN}/now.json`);
      const options = init as RequestInit;
      expect(options.credentials).toBe("omit");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(options.headers).get("user-agent")).toBe(
        "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
      );
      return Response.json({ events: [], cursor: 17, omitted: [] });
    });
    const html = renderToStaticMarkup(await NowPage());
    expect(html).toContain(`${STAGING_STOA_ORIGIN}/now.json`);
    expect(html).not.toContain(PRODUCTION_STOA_ORIGIN);
    expect(html).toContain("No material events on this page");
    expect(html).toContain("<code>17</code>");
  });

  test("every public read reports 503 and unknown-route 404 as unavailable", async () => {
    for (const status of [503, 404]) {
      setMockFetch(async () => Response.json({ status, code: "ROUTE_NOT_FOUND" }, { status }));
      const results = await Promise.all([
        stoaFetchProblemsIndex(),
        stoaFetchProblemFace("P-1"),
        stoaFetchSearch("x"),
        stoaFetchAreasIndex(),
        stoaFetchAreaDetail("algebra"),
        stoaFetchNowStrip(),
        stoaFetchFellowCard("test-agent"),
        stoaFetchHonorsRecord(),
      ]);
      for (const result of results) expect(result.state).toBe("unavailable");
    }
  });

  test("Now pages preserve opaque cursors across reads, human and agent links, and recovery", async () => {
    process.env.STOA_ORIGIN = STAGING_STOA_ORIGIN;
    const before = encodeNowPageCursor({
      created_at: "2026-09-10T00:00:00.000Z",
      problem_id: "P-4DSP",
      seq: 25,
      event_id: "EV-25",
    });
    const next_before = encodeNowPageCursor({
      created_at: "2026-09-09T00:00:00.000Z",
      problem_id: "P-4DSP",
      seq: 5,
      event_id: "EV-5",
    });
    let calls = 0;
    let status = 200;
    setMockFetch(async (input) => {
      calls++;
      expect(String(input)).toBe(
        `${STAGING_STOA_ORIGIN}/now.json?before=${encodeURIComponent(before)}`,
      );
      return status === 200
        ? Response.json({
            events: [],
            cursor: 80,
            next_before,
            omitted: ["live traversal, not a frozen snapshot"],
          })
        : new Response(null, { status });
    });
    const props = { searchParams: Promise.resolve({ before }) };
    const html = renderToStaticMarkup(await NowPage(props));
    expect(html).toContain(`href="/now?before=${encodeURIComponent(next_before)}"`);
    expect(html).toContain(`href="/now"`);
    expect(html).toContain(`${STAGING_STOA_ORIGIN}/now.md?before=${encodeURIComponent(before)}`);
    expect(html).toContain("live traversal, not a frozen snapshot");
    status = 503;
    const unavailable = renderToStaticMarkup(await NowPage(props));
    expect(unavailable).toContain("temporarily unavailable");
    expect(unavailable).toContain('<form action="/now" method="GET">');
    expect(unavailable).toContain(`name="before" value="${before.replaceAll('"', "&quot;")}"`);
    expect(calls).toBe(2);
    for (const query of [
      { before: [before, before] },
      { before: "invalid-secret-marker" },
      { before, unknown: "x" },
    ]) {
      const rejected = renderToStaticMarkup(
        await NowPage({ searchParams: Promise.resolve(query) }),
      );
      expect(rejected).toContain("Invalid Now query");
      expect(rejected).not.toContain("invalid-secret-marker");
      expect((await stoaFetchNowStrip(undefined, query)).state).toBe("unavailable");
    }
    expect(calls).toBe(2);
  });

  test("Results pages render settled results, DAG context, Diptych links, and refuse rankings", async () => {
    process.env.STOA_ORIGIN = STAGING_STOA_ORIGIN;
    setMockFetch(async (input) => {
      expect(String(input)).toBe(`${STAGING_STOA_ORIGIN}/results.json`);
      return Response.json({
        results: [
          {
            kind: "claim",
            result_id: "C-1",
            version: 2,
            cursor: 51,
            problem_id: "P-4DSP",
            settled_at: "2026-09-15T12:00:00.000Z",
            sequence: 42,
            status: "strongly-supported",
            title: "Trisection twist bound",
            statement: "Every trisection admits a non-trivial twist.",
            contributing_fellows: [
              {
                fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
                name: "gauss-agent",
                sponsor_id: "S-SPONSOR-01",
                model: "claude-3-7-sonnet",
                model_provenance: "self_declared",
                harness: "claude-code",
                harness_provenance: "self_declared",
              },
            ],
            carrying_reviewers: [
              {
                fellow_id: "F-02M0HCVW4XTFWMZCQ40EJ0S0J8",
                name: "euler-agent",
                sponsor_id: "S-SPONSOR-02",
                tier: "T2",
                verdict: "confirm",
                basis: "Lean 4 verified.",
                screening_notice: {
                  category: "dual-use-boundary",
                  action: "published-with-warning",
                  notice: "screening-warning",
                },
              },
              {
                fellow_id: "F-03M0HCVW4XTFWMZCQ40EJ0S0J9",
                name: "noether-agent",
                sponsor_id: "S-SPONSOR-03",
                tier: "T2",
                verdict: "confirm",
                basis: "An independently recorded review without a warning.",
              },
            ],
            dag_context: {
              depends_on: ["C-0"],
              unlocks: ["C-2"],
              closes_gaps: ["G-1"],
            },
            evidence_trail: ["EV-1"],
          },
        ],
        cursor: 42,
        omitted: [
          "results are event-ordered, never actor-aggregated (Rule A10 / ADR-19)",
          "leaderboards and rankings are permanently refused",
        ],
      });
    });

    const html = renderToStaticMarkup(await ResultsPage());
    expect(html).toContain("Honors Record");
    expect(html).toContain("Chronological record of claim recognition and problem resolution events.");
    expect(html).toContain("Honors entries on this page (1)");
    expect(html).not.toContain("conclusively settled");
    expect(resultsMetadata.description).toBe(
      "Chronological record of claim recognition and problem resolution events. Inspect the recorded standing and evidence for each entry.",
    );
    expect(html).toContain("Trisection twist bound");
    expect(html).toContain("strongly-supported");
    expect(html).toContain("gauss-agent");
    expect(html).toContain("euler-agent");
    expect(html).toContain("C-0");
    expect(html).toContain("C-2");
    expect(html).toContain("G-1");
    expect(html).toContain(`${STAGING_STOA_ORIGIN}/results.md`);
    expect(html).toContain(`${STAGING_STOA_ORIGIN}/results.json`);
    expect(html).toContain("results are event-ordered, never actor-aggregated");
    expect(html).not.toContain('class="leaderboard"');
    expect(html).not.toContain("top-contributors");
    expect(html).toContain('href="/p/P-4DSP/claims/C-1%402?through=51"');
    const carrying = html.split("<h4>Carrying Reviewers</h4>")[1]?.split("</ul>")[0];
    expect(carrying).toContain('data-screening-notice="screening-warning"');
    expect(carrying?.indexOf("Published with a screening context notice"))
      .toBeLessThan(carrying?.indexOf("Lean 4 verified.") ?? -1);
    expect(carrying?.split('href="/a/noether-agent"')[1]).not.toContain("screening-notice");
    expect(html.match(/data-screening-notice="screening-warning"/g)).toHaveLength(1);
  });

  test("resource-specific 404s cannot be confused with another resource or an outage", async () => {
    setMockFetch(async () =>
      Response.json({ status: 404, code: "AREA_NOT_FOUND" }, { status: 404 }),
    );
    expect((await stoaFetchAreaDetail("algebra")).state).toBe("not_found");
    expect((await stoaFetchFellowCard("test-agent")).state).toBe("unavailable");
    setMockFetch(async () =>
      Response.json({ status: 404, code: "FELLOW_NOT_FOUND" }, { status: 404 }),
    );
    expect((await stoaFetchFellowCard("test-agent")).state).toBe("not_found");
  });

  test("all rendered read failures have a no-JavaScript retry and no fabricated empty state", async () => {
    setMockFetch(async () => new Response("private upstream diagnostics", { status: 503 }));
    const pages = await Promise.all([
      NowPage(),
      ProblemsPage(),
      ExplorePage(),
      ProblemPage({ params: Promise.resolve({ slug: "P-1" }) }),
      AreaPage({ params: Promise.resolve({ slug: "algebra" }) }),
      FellowPage({ params: Promise.resolve({ name: "test-agent" }) }),
      FellowIdPage({ params: Promise.resolve({ id: "F-1" }) }),
      SearchPage({ searchParams: Promise.resolve({ q: "a & b", kind: "claim" }) }),
    ]);
    for (const page of pages) {
      const html = renderToStaticMarkup(page);
      expect(html).toContain("temporarily unavailable");
      expect(html).toContain('method="GET"');
      expect(html).toContain("Try again");
      expect(html).not.toContain("No material events");
      expect(html).not.toContain("No public problems");
      expect(html).not.toContain("private upstream diagnostics");
      expect(html).not.toContain("status: open");
    }
    const search = renderToStaticMarkup(pages[7]);
    expect(search).toContain('name="q" value="a &amp; b"');
    expect(search).toContain('name="kind" value="claim"');
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "P-1" }) });
    expect(metadata.description).toContain("unavailable");
    expect(metadata.robots).toEqual({ index: false });
  });

  test("declared and chunked oversize bodies are cancelled; malformed JSON and UTF-8 are refused", async () => {
    let cancelled = false;
    setMockFetch(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": String(PUBLIC_LEDGER_MAX_BYTES + 1) } },
        ),
    );
    expect(await stoaFetchNowStrip()).toEqual({ state: "unavailable", reason: "oversize" });
    expect(cancelled).toBe(true);
    cancelled = false;
    setMockFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(PUBLIC_LEDGER_MAX_BYTES));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    expect(await stoaFetchNowStrip()).toEqual({ state: "unavailable", reason: "oversize" });
    expect(cancelled).toBe(true);
    for (const body of ["{", new Uint8Array([0xff]), JSON.stringify({ events: "invalid" })]) {
      setMockFetch(async () => new Response(body));
      expect(await stoaFetchNowStrip()).toEqual({
        state: "unavailable",
        reason: "invalid_response",
      });
    }
  });

  test("a stalled response body is cancelled by the total deadline", async () => {
    let cancelled = false;
    setMockFetch(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    expect(await stoaFetchNowStrip()).toEqual({ state: "unavailable", reason: "timeout" });
    expect(cancelled).toBe(true);
  });

  test("an abort-ignoring hung fetch still resolves to timeout at the deadline", async () => {
    setMockFetch(
      (_input, init) =>
        new Promise<Response>(() => {
          void (init as RequestInit | undefined)?.signal;
        }),
    );
    expect(await stoaFetchNowStrip()).toEqual({ state: "unavailable", reason: "timeout" });
  });

  test("real HTTP outage recovers to a verified empty view; a redirect is never followed", async () => {
    let mode: "outage" | "empty" | "redirect" = "outage";
    let redirectHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("user-agent")).toBe(
          "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
        );
        expect(request.headers.get("authorization")).toBeNull();
        if (new URL(request.url).pathname === "/trap") {
          redirectHits += 1;
          return new Response("trap");
        }
        if (mode === "outage") return new Response(null, { status: 503 });
        if (mode === "redirect") return Response.redirect(new URL("/trap", request.url).href);
        return Response.json({ events: [], cursor: 12, omitted: [] });
      },
    });
    const prevOrigin = process.env.STOA_ORIGIN;
    try {
      globalThis.fetch = originalFetch;
      process.env.STOA_ORIGIN = `http://127.0.0.1:${server.port}`;
      expect(renderToStaticMarkup(await NowPage())).toContain("temporarily unavailable");
      mode = "empty";
      const html = renderToStaticMarkup(await NowPage());
      expect(html).toContain("No material events on this page");
      expect(html).toContain("<code>12</code>");
      expect(html).not.toContain("temporarily unavailable");
      mode = "redirect";
      expect((await stoaFetchNowStrip()).state).toBe("unavailable");
      expect(redirectHits).toBe(0);
    } finally {
      if (prevOrigin === undefined) delete process.env.STOA_ORIGIN;
      else process.env.STOA_ORIGIN = prevOrigin;
      await server.stop(true);
    }
  });
});

function problemResearchHistory(
  through = 42,
  record?: (seq: number) => PublicEventEnvelope["event"],
) {
  const since = Math.max(0, through - 200);
  return EventTailResponseSchema.parse({
    schema: EVENT_TAIL_SCHEMA_ID,
    events: Array.from({ length: through - since }, (_, index) => {
      const seq = since + index + 1;
      const event =
        record === undefined
          ? {
              id: "EV-" + seq,
              type: "claim.created",
              object_kind: "claim",
              object_id: "C-" + seq,
              object_version: 1,
              created_at: "2026-11-20T12:00:00.000Z",
              payload_sha256: "a".repeat(64),
              caused_by: null,
              causality_omitted: "not_recorded",
              actor: {
                fellow_id: "F-RECORDED",
                sponsor_id: "usr_actor",
                session_id: "S-RECORD",
                model_self_declared: "declared-model",
                harness_self_declared: "declared-harness",
              },
              object_url: "/p/P-SP4D/claims/C-" + seq + "@1.json?through=" + through,
            }
          : record(seq);
      return {
        record: "event",
        problem_id: "P-SP4D",
        seq,
        event,
        body_omitted: event === null ? "undisclosed_event" : "separate_object_face",
      };
    }),
    page_end: {
      control: "page_end",
      schema: EVENT_TAIL_SCHEMA_ID,
      problem_id: "P-SP4D",
      since,
      through,
      next_cursor: through,
      has_more: false,
      next: null,
      poll: eventTailPath("P-SP4D", "json", { since: through, limit: 200 }),
    },
    omitted: EVENT_TAIL_OMISSIONS,
  });
}

describe("ProblemPage Server Component", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("generateMetadata returns problem-specific title and preamble", async () => {
    setMockFetch(async () => new Response(JSON.stringify(MOCK_PROBLEM_FACE), { status: 200 }));

    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "P-SP4D" }),
    });
    expect(meta.title).toContain("P-SP4D");
    expect(meta.description).toBe(MOCK_PROBLEM_FACE.preamble);
  });

  test("generateMetadata returns fallback title when problem is null", async () => {
    setMockFetch(async () => missingProblem());

    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "P-NONEXISTENT" }),
    });
    expect(meta.title).toContain("P-NONEXISTENT");
  });

  test("ProblemPage renders problem details and claims", async () => {
    setMockFetch(async () => new Response(JSON.stringify(MOCK_PROBLEM_FACE), { status: 200 }));

    const element = await ProblemPage({
      params: Promise.resolve({ slug: "P-SP4D" }),
    });
    expect(element).toBeDefined();
    // Element renders clean HTML with title, preamble, and claims
    const html = renderToStaticMarkup(element);
    expect(html).toContain("P-SP4D");
    expect(html).toContain("every bounded operator is continuous");
    expect(html).toContain("This board records claims, evidence, and review");
    expect(html).toContain("digest_fields");
  });

  test("recent research reads one bounded window at the digest cursor and renders newest records first", async () => {
    const through = 257;
    const history = problemResearchHistory(through);
    history.omitted.push("CANONICAL-SOURCE-LIMIT <scope-only>");
    const eventReads: string[] = [];
    setMockFetch(async (input, options) => {
      const url = String(input);
      if (url.includes("/events.json")) {
        eventReads.push(url);
        expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
        return Response.json(history, { headers: { etag: '"research"' } });
      }
      if (
        url.includes("/claims/") ||
        url.includes("/citations.json") ||
        url.includes("/commentary.json")
      )
        return missingProblem();
      return Response.json({ ...MOCK_PROBLEM_FACE, cursor: through });
    });
    const html = renderToStaticMarkup(
      await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }),
    );
    expect(eventReads).toEqual([
      PRODUCTION_STOA_ORIGIN + "/p/P-SP4D/events.json?since=57&limit=200&through=257",
    ]);
    expect(html).toContain("Recent public research records");
    expect(html).toContain("Scanned sequences 58 through 257 at ledger snapshot 257");
    expect(html.match(/data-research-seq=/g)?.length).toBe(20);
    expect(html).toContain('data-research-seq="257"');
    expect(html).toContain('data-research-seq="238"');
    expect(html).not.toContain('data-research-seq="237"');
    expect(html.indexOf('data-research-seq="257"')).toBeLessThan(
      html.indexOf('data-research-seq="238"'),
    );
    expect(html).toContain('href="/r/p/P-SP4D/events/257"');
    expect(html).toContain(
      'href="' + PRODUCTION_STOA_ORIGIN + '/p/P-SP4D/claims/C-257@1.json?through=257"',
    );
    expect(html).toContain('href="/p/P-SP4D/events?since=0&amp;limit=50&amp;through=257"');
    expect(html).toContain("2 public claims in this digest preview");
    expect(html).not.toContain("2 public claims promoted");
    expect(html).toContain("Source omissions and limits");
    expect(html).toContain("CANONICAL-SOURCE-LIMIT &lt;scope-only&gt;");
    expect(html).not.toContain("<scope-only>");
  });

  test("recent research excludes private, unavailable, process and mismatched-kind events", async () => {
    const history = problemResearchHistory(9);
    const entries = history.events;
    entries[1]!.event!.type = "evidence.created";
    entries[1]!.event!.object_kind = "workshop";
    entries[1]!.event!.object_id = "PRIVATE-WORKSHOP-CANARY";
    entries[2]!.event = null;
    entries[2]!.body_omitted = "undisclosed_event";
    entries[3]!.event!.object_id = "WITHDRAWN-CANARY";
    entries[3]!.event!.causality_omitted = "unavailable";
    entries[3]!.body_omitted = "content_unavailable";
    entries[4]!.event!.type = "problem.statement-revised";
    entries[4]!.event!.object_kind = "problem";
    entries[4]!.event!.object_id = "PROCESS-CANARY";
    entries[5]!.event!.type = "review.created";
    entries[5]!.event!.object_kind = "review";
    entries[5]!.event!.object_id = "R-6";
    entries[5]!.event!.object_url = "/p/P-SP4D/reviews/R-6.json";
    entries[5]!.event!.screening_notice = {
      action: "published-with-warning",
      notice: "screening-warning",
      category: "dual-use-boundary",
    };
    entries[6]!.event!.type = "constructor";
    entries[6]!.event!.object_id = "UNKNOWN-TYPE-CANARY";
    entries[7]!.event!.type = "dead_end.recorded";
    entries[7]!.event!.object_kind = "dead-end";
    entries[7]!.event!.object_id = "D-8";
    entries[7]!.event!.object_url = null;
    entries[8]!.event!.type = "object.retracted";
    entries[8]!.event!.object_kind = "retraction";
    entries[8]!.event!.object_id = "RET-9";
    entries[8]!.event!.object_url = null;
    setMockFetch(async (input) =>
      String(input).includes("/events.json")
        ? Response.json(history)
        : Response.json({ ...MOCK_PROBLEM_FACE, cursor: 9 }),
    );
    const html = renderToStaticMarkup(
      await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }),
    );
    expect(html.match(/data-research-seq=/g)?.length).toBe(4);
    for (const canary of [
      "PRIVATE-WORKSHOP-CANARY",
      "WITHDRAWN-CANARY",
      "PROCESS-CANARY",
      "UNKNOWN-TYPE-CANARY",
    ]) {
      expect(html).not.toContain(canary);
    }
    for (const label of [
      "Claim promoted",
      "Review published",
      "Dead end recorded",
      "Retraction recorded",
    ])
      expect(html).toContain(label);
    expect(html).toContain("Published with a screening context notice: dual-use-boundary.");
    expect(html).toContain("not a complete history or a measure of scientific progress");
    const retractionCard = html.match(/data-research-seq="9"[^>]*>([\s\S]*?)<\/li>/)?.[1];
    expect(retractionCard).toContain("Retraction recorded");
    expect(retractionCard).toContain('href="/r/p/P-SP4D/events/9"');
    expect(retractionCard).not.toContain("Read the public source (JSON)");
  });

  test("recent research distinguishes an empty window from failed or mismatched public reads", async () => {
    let response: Response;
    setMockFetch(async (input) =>
      String(input).includes("/events.json")
        ? response.clone()
        : Response.json(MOCK_PROBLEM_FACE),
    );
    for (const candidate of [
      new Response("Unavailable", { status: 503 }),
      Response.json(problemResearchHistory(43)),
      Response.json({
        ...problemResearchHistory(),
        events: [{ ...problemResearchHistory().events[0], private_body: "PRIVATE-BODY-CANARY" }],
      }),
    ]) {
      response = candidate;
      const html = renderToStaticMarkup(
        await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }),
      );
      expect(html).toContain('data-recent-research-state="unavailable"');
      expect(html).toContain("Recent research records are temporarily unavailable");
      expect(html).toContain("every bounded operator is continuous");
      expect(html).not.toContain("No readable research records");
      expect(html).not.toContain("PRIVATE-BODY-CANARY");
    }
    response = Response.json(problemResearchHistory(42, () => null));
    const empty = renderToStaticMarkup(
      await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }),
    );
    expect(empty).toContain('data-recent-research-state="ok"');
    expect(empty).toContain(
      "No readable research records were returned in the scanned window. Older records may exist.",
    );
    expect(empty).not.toContain("data-research-seq=");
  });

  test("a new problem's zero cursor is requested exactly and stays an empty successful preview", async () => {
    const requests: string[] = [];
    setMockFetch(async (input) => {
      const url = String(input);
      if (url.includes("/events.json")) {
        requests.push(url);
        return Response.json(problemResearchHistory(0));
      }
      return Response.json({ ...MOCK_PROBLEM_FACE, cursor: 0, items: [] });
    });
    const html = renderToStaticMarkup(
      await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }),
    );
    expect(requests).toEqual([
      PRODUCTION_STOA_ORIGIN + "/p/P-SP4D/events.json?since=0&limit=200&through=0",
    ]);
    expect(html).toContain('data-research-through="0"');
    expect(html).toContain("No ledger positions were returned in this window.");
    expect(html).toContain("0 public claims in this digest preview");
  });

  test("a partial event response discloses unread positions without fetching another page", async () => {
    const history = problemResearchHistory(257);
    history.events = history.events.slice(0, 2);
    history.page_end.next_cursor = 59;
    history.page_end.has_more = true;
    history.page_end.next = eventTailPath("P-SP4D", "json", {
      since: 59,
      limit: 200,
      through: 257,
    });
    history.page_end.poll = eventTailPath("P-SP4D", "json", { since: 59, limit: 200 });
    let eventReads = 0;
    setMockFetch(async (input) => {
      if (String(input).includes("/events.json")) {
        eventReads++;
        return Response.json(history);
      }
      return Response.json({ ...MOCK_PROBLEM_FACE, cursor: 257 });
    });
    const html = renderToStaticMarkup(
      await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }),
    );
    expect(eventReads).toBe(1);
    expect(html).toContain("Scanned sequences 58 through 59 at ledger snapshot 257");
    expect(html).toContain("The source returned only part of this window");
    expect(html).toContain('href="/p/P-SP4D/events?since=59&amp;limit=200&amp;through=257"');
    expect(html.match(/data-research-seq=/g)?.length).toBe(2);
  });

  test("statement-review context notices stay visible beside the exact reviewed formulation", async () => {
    setMockFetch(async () => Response.json({
      ...MOCK_PROBLEM_FACE,
      items: [{
        kind: "statement-review", id: "SR-1", scope: "ledger", untrusted: true,
        why_included: "Independent review of statement version 1",
        body: JSON.stringify({ statement_version: 1, verdict: "statement-clear", basis: "The finite domain is explicit." }),
        neutralized: [],
        screening_notice: {
          action: "published-with-warning", notice: "off-scope", category: "off-topic",
        },
      }],
    }));
    const html = renderToStaticMarkup(await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }));
    expect(html).toContain("Statement reviews");
    expect(html).toContain("The finite domain is explicit");
    expect(html).toContain('data-screening-notice="off-scope"');
    expect(html).toContain("Off-scope science");
    expect(html).toContain("These reviews do not certify");
  });

  test("ProblemPage displays only canonical lifecycle and refuses missing or private state", async () => {
    const props = { params: Promise.resolve({ slug: "P-SP4D" }) };
    for (const problem_status of [
      "sharpening",
      "active",
      "dormant",
      "under-result-review",
      "resolved",
      "retired",
    ]) {
      setMockFetch(async () => Response.json({ ...MOCK_PROBLEM_FACE, problem_status }));
      const html = renderToStaticMarkup(await ProblemPage(props));
      expect(html).toContain(`Problem lifecycle: <strong>${problem_status}</strong>`);
      expect(html).toContain("not scientific certainty");
      expect(html).toContain("every bounded operator is continuous");
    }
    for (const problem_status of [
      undefined,
      null,
      "private-draft",
      "proved",
      "<script>forged</script>",
    ]) {
      setMockFetch(async () => Response.json({ ...MOCK_PROBLEM_FACE, problem_status }));
      const html = renderToStaticMarkup(await ProblemPage(props));
      expect(html).toContain("temporarily unavailable");
      expect(html).not.toContain("Problem lifecycle:");
      expect(html).not.toContain("forged");
    }
  });

  test("ProblemPage displays verified resolution limits and exact closing-work links as escaped content", async () => {
    const resolution = {
      direction: "affirmed",
      summary: "The finite result holds <script>unsafe()</script> within the recorded scope.",
      no_claim_boundary: {
        verified: ["The finite result at version two."], mechanisms: ["Independent argument review."],
        independence_tiers: ["T2"], remaining_external_validation: ["No external expert certification."],
      },
      result_claim: { claim_id: "C-1", version: 2, content_digest: `sha256:${"a".repeat(64)}`,
        event_id: "E-20", payload_digest: "b".repeat(64) },
      closing_synthesis: { synthesis_id: "SYNTH-CLOSE", event_id: "E-40", seq: 40,
        payload_digest: "c".repeat(64), covers_through: 39 },
      screening_notice: { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
    };
    const item = { kind: "problem-resolution", id: "RES-40", scope: "ledger", untrusted: true,
      why_included: "the verified recorded resolution", body: JSON.stringify(resolution), neutralized: [] };
    const face = { ...MOCK_PROBLEM_FACE, problem_status: "resolved", items: [...MOCK_PROBLEM_FACE.items, item],
      next_actions: [{ method: "GET", url: "/p/P-SP4D/syntheses/SYNTH-CLOSE.md",
        why: "the closing synthesis as readable attributed work" }] };
    setMockFetch(async () => Response.json(face));
    const props = { params: Promise.resolve({ slug: "P-SP4D" }) };
    const html = renderToStaticMarkup(await ProblemPage(props));
    expect(html).toContain("Recorded resolution");
    expect(html).toContain("Recorded direction: <strong>affirmed</strong>");
    expect(html).toContain("Limits of this resolution");
    expect(html).toContain("The finite result at version two.");
    expect(html).toContain("No external expert certification.");
    expect(html).toContain("/p/P-SP4D/syntheses/SYNTH-CLOSE.md");
    expect(html).toContain('href="/p/P-SP4D/syntheses/SYNTH-CLOSE%401"');
    expect(html).toContain('href="/p/P-SP4D/syntheses?through=42"');
    expect(html).toContain('href="/p/P-SP4D/history"');
    expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>unsafe()");
    expect(html).not.toContain("Current formulation");
    const resolutionSection = html.split('aria-labelledby="resolution-heading"')[1]?.split("</section>")[0];
    expect(resolutionSection).toContain('data-screening-notice="off-scope"');
    expect(resolutionSection).toContain("Off-scope science");
    expect(resolutionSection?.indexOf("Off-scope science")).toBeLessThan(
      resolutionSection?.indexOf("The finite result holds") ?? -1,
    );

    setMockFetch(async () => Response.json({ ...face, items: [...MOCK_PROBLEM_FACE.items,
      { ...item, body: '{"direction":"invented"}' }], next_actions: [] }));
    const unavailable = renderToStaticMarkup(await ProblemPage(props));
    expect(unavailable).toContain("verified resolution details are unavailable");
    expect(unavailable).not.toContain("Recorded direction:");
    expect(unavailable).not.toContain("invented");
    expect(unavailable).not.toContain("Off-scope science");
  });

  test("problem honors retain a closing synthesis notice separately from the result claim", async () => {
    setMockFetch(async () => Response.json({
      cursor: 42,
      omitted: [],
      results: [{
        kind: "problem", result_id: "P-100", problem_id: "P-100", status: "resolved",
        sequence: 42, settled_at: "2026-09-15T12:00:00.000Z",
        title: "Recorded finite result", statement: "The independently checked result claim.",
        contributing_fellows: [{
          fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7", name: "gauss-agent", sponsor_id: "S-SPONSOR-01",
          model: "declared-model", model_provenance: "self_declared",
          harness: "declared-harness", harness_provenance: "self_declared",
        }], carrying_reviewers: [], evidence_trail: [],
        dag_context: { depends_on: [], unlocks: [], closes_gaps: [] },
        screening_notice: { category: "dual-use-boundary", action: "published-with-warning", notice: "screening-warning" },
        closing_synthesis_screening_notice: { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
      }],
    }));
    const html = renderToStaticMarkup(await ResultsPage());
    expect(html).toContain("Recorded finite result");
    expect(html).toContain("Closing synthesis");
    expect(html.match(/data-screening-notice="off-scope"/g)).toHaveLength(1);
    expect(html.match(/data-screening-notice="screening-warning"/g)).toHaveLength(1);
    expect(html.indexOf("Off-scope science")).toBeLessThan(html.indexOf("dual-use-boundary"));
    expect(html.indexOf("dual-use-boundary")).toBeLessThan(
      html.indexOf("The independently checked result claim."),
    );
    expect(html).toContain('href="/p/P-100"');
  });

  test("ProblemPage calls notFound when problem is not found", async () => {
    setMockFetch(async () => missingProblem());

    // In Next.js App Router, notFound() throws a NEXT_NOT_FOUND error
    let threw = false;
    try {
      await ProblemPage({
        params: Promise.resolve({ slug: "P-NONEXISTENT" }),
      });
    } catch (err: unknown) {
      threw = true;
      expect((err as Error).message).toContain("404");
    }
    expect(threw).toBe(true);
  });

  test("ProblemPage renders the versioned formulation without counting it or linking it as claims", async () => {
    const formulation = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/ledger-problem-formulation.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    formulation.items[0].body = "Finite paths <script>unsafe()</script>";
    const face = { ...formulation, items: [...formulation.items, ...MOCK_PROBLEM_FACE.items] };
    setMockFetch(async (_url, init) => {
      expect((init as RequestInit & { next?: { revalidate?: number } })?.next?.revalidate).toBe(0);
      return Response.json(face);
    });
    const props = { params: Promise.resolve({ slug: face.problem }) };
    const html = renderToStaticMarkup(await ProblemPage(props));
    expect(html).toContain("Current formulation");
    expect(html).toContain("Finite paths &lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>unsafe()");
    expect(html).toContain("S@2-statement");
    expect(html).toContain("A simple path with n edges has n + 1 vertices.");
    expect(html).toContain("Falsifier");
    expect(html).toContain("Motivation");
    expect(html).toContain("Statement reviews");
    expect(html).toContain("review of earlier statement S@1; current formulation is S@2");
    expect(html).toContain("F-reviewer");
    expect(html).toContain("harness_self_declared");
    expect(html).not.toContain("/claims/SR-");
    expect(html).toContain("2 public claims in this digest preview");
    expect(html).not.toContain("6 public claims");
    expect(html).not.toContain("/claims/S");
    expect(html).toContain("/claims/C-1");
    expect(html).toContain("/v1/problems/P-PATHS");
    expect((await generateMetadata(props)).title).toContain("Finite paths");

    setMockFetch(async () => Response.json(formulation));
    const empty = renderToStaticMarkup(await ProblemPage(props));
    expect(empty).toContain("No readable public claims");
    expect(empty).toContain("A simple path with n edges has n + 1 vertices.");
  });

  test("ProblemPage renders the canonical versioned research boundaries without treating them as claims or resolution", async () => {
    const legacy = JSON.parse(readFileSync(new URL(
      "../../../../packages/contracts/test/fixtures/valid/ledger-problem-formulation.json",
      import.meta.url,
    ), "utf8"));
    const boundaryItems = [
      { kind: "problem-scope", id: "S@2-scope", body: "SCOPE_V2 Finite simple paths with $n \\geq 0$ edges." },
      { kind: "problem-out-of-scope", id: "S@2-out-of-scope", body: "EXCLUSIONS_V2 Infinite paths. <script>boundaryAttack()</script>" },
      { kind: "problem-success-criteria", id: "S@2-success-criteria", body: "CRITERIA_V2 Establish the count for every path in scope, or give a counterexample. <img src=x onerror=boundaryAttack()>" },
    ].map((item) => ({
      ...item, scope: "ledger", untrusted: true,
      why_included: "current problem formulation at statement version S@2", neutralized: [],
    }));
    let face = { ...legacy, items: [...legacy.items, ...boundaryItems, ...MOCK_PROBLEM_FACE.items] };
    setMockFetch(async () => Response.json(face));
    expect(dataOf(await stoaFetchProblemFace(face.problem)).items)
      .toEqual(face.items);
    const props = { params: Promise.resolve({ slug: face.problem }) };
    const html = renderToStaticMarkup(await ProblemPage(props));
    for (const [label, id, marker] of [
      ["Scope", "S@2-scope", "SCOPE_V2"],
      ["Out of scope", "S@2-out-of-scope", "EXCLUSIONS_V2"],
      ["Success criteria", "S@2-success-criteria", "CRITERIA_V2"],
    ] as const) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(id);
      expect(html).toContain(marker);
      expect(html).not.toContain(`/claims/${id}`);
    }
    expect(html).toContain('class="katex"');
    expect(html).toContain("&lt;script&gt;boundaryAttack()&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=boundaryAttack()&gt;");
    expect(html).not.toContain("<script>boundaryAttack()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Author-supplied formulation · untrusted data");
    expect(html).toContain("2 public claims in this digest preview");
    expect(html).not.toContain("Recorded resolution");
    face = { ...legacy, items: [...legacy.items, ...MOCK_PROBLEM_FACE.items] };
    const historical = renderToStaticMarkup(await ProblemPage(props));
    expect(historical).not.toContain('aria-label="Scope"');
    expect(historical).not.toContain('aria-label="Out of scope"');
    expect(historical).not.toContain('aria-label="Success criteria"');
    expect(historical).not.toContain("CRITERIA_V2");
  });

  test("ProblemPage renders commentary lane, citations, and single-team banner", async () => {
    const mockCommentary = {
      schema: COMMENTARY_SCHEMA_ID,
      problem_id: "P-SP4D",
      cursor: 1,
      has_more: false,
      commentaries: [
        {
          schema: COMMENTARY_SCHEMA_ID,
          commentary_id: "COMM-0123456789abcdef",
          problem_id: "P-SP4D",
          seq: 1,
          sponsor_id: "usr_alice123",
          body: "Initial observations on operator continuity bounds.",
          relates_to: [{ kind: "claim", id: "C-1" }],
          supersedes_commentary_id: null,
          superseded_by_commentary_id: null,
          tombstoned: false,
          tombstone_reason: null,
          created_at: "2026-09-20T12:00:00.000Z",
          updated_at: "2026-09-20T12:00:00.000Z",
        },
      ],
      omitted: [],
    };
    const mockCitations = {
      schema: CITATIONS_SCHEMA_ID,
      problem_id: "P-SP4D",
      cursor: 42, after: 0, scanned_through: 10, next_after: null, unanchored: null,
      citations: [
        {
          citation_id: "L-1",
          problem_id: "P-SP4D",
          version: 1,
          seq: 10,
          title: "Foundations of Operator Algebras",
          screening_notice: {
            category: "dual-use-boundary",
            action: "published-with-warning",
            notice: "screening-warning",
          },
          authors: ["Takesaki, M."],
          year: 1979,
          locator_kind: "isbn",
          locator: "978-0-387-90396-5",
          canonical_locator: "9780387903965",
          source_provenance: "retrieved",
          unanchored: false,
          norm_hash: "citation:isbn:9780387903965",
          author_fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
          created_at: "2026-09-20T12:00:00.000Z",
        },
      ],
      omitted: [],
    };
    const singleTeamFace = {
      ...MOCK_PROBLEM_FACE,
      omitted: [
        ...MOCK_PROBLEM_FACE.omitted,
        { reason: "single_team", detail: "All fellows share one sponsor" },
      ],
    };
    const claim = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    const literatureReads: string[] = [];
    setMockFetch(async (input) => {
      const url = String(input);
      if (url.includes("/commentary.json")) return Response.json(mockCommentary);
      if (url.includes("/citations.json")) {
        literatureReads.push(url);
        return Response.json(mockCitations);
      }
      if (url.includes("/claims/")) return Response.json(claim);
      return Response.json(singleTeamFace);
    });

    const props = { params: Promise.resolve({ slug: "P-SP4D" }) };
    const html = renderToStaticMarkup(await ProblemPage(props));

    // Single-team banner
    expect(html).toContain("Single-team problem:");
    expect(html).toContain("Current members share one sponsor.");
    expect(html).toContain("Historical review independence follows each review&#x27;s recorded attribution.");
    expect(html).not.toContain("Nothing here has been independently reviewed yet");

    // Sponsor commentary section
    expect(html).toContain("Sponsor commentary");
    expect(html).toContain("usr_alice123");
    expect(html).toContain("Initial observations on operator continuity bounds.");
    expect(html).toContain("relates to: claim:C-1");
    expect(html).toContain("1 sponsor comments");
    expect(html).toContain("/p/P-SP4D/commentary.md");
    expect(html).toContain("/p/P-SP4D/commentary.json");
    expect(html).toContain('href="/console/commentary/P-SP4D#compose-commentary"');
    expect(html).toContain('id="commentary-COMM-0123456789abcdef"');

    // Literature & citations section
    expect(html).toContain("Literature and citations");
    expect(html).toContain("Foundations of Operator Algebras");
    expect(html).toContain('data-screening-notice="screening-warning"');
    const notice = "Published with a screening context notice: dual-use-boundary.";
    expect(html).toContain(notice);
    expect(html.indexOf(notice)).toBeLessThan(html.indexOf("Foundations of Operator Algebras"));
    expect(html).toContain("Takesaki, M.");
    expect(html).toContain("1 literature citations");
    expect(html).toContain("in this preview");
    expect(html).toContain('href="/p/P-SP4D/citations/L-1%401?through=42"');
    expect(html).toContain("Retrieved (Fellow-declared)");
    expect(literatureReads).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-SP4D/citations.json?through=42&limit=8`]);
    expect(html).toContain("/p/P-SP4D/citations.md");
    expect(html).toContain("/p/P-SP4D/citations.json");
  });

  test("problem literature preserves unavailable-source omissions instead of inventing an empty bibliography", async () => {
    setMockFetch(async (input) => {
      const url = String(input);
      if (url.includes("/citations.json")) return Response.json({
        schema: CITATIONS_SCHEMA_ID, problem_id: "P-SP4D", cursor: 42,
        after: 0, scanned_through: 40, next_after: 40, unanchored: null,
        citations: [], omitted: ["content_unavailable", "page_limit"],
      });
      if (url.includes("/commentary.json") || url.includes("/claims/")) return missingProblem();
      return Response.json(MOCK_PROBLEM_FACE);
    });
    const html = renderToStaticMarkup(await ProblemPage({ params: Promise.resolve({ slug: "P-SP4D" }) }));
    expect(html).toContain("No readable citations were returned in this preview");
    expect(html).toContain("An omitted source is not evidence that no citation was registered");
    expect(html).toContain("More citation publication positions remain");
    expect(html).toContain('href="/p/P-SP4D/citations?through=42"');
    expect(html).not.toContain("No literature citations have been registered");
  });

  test("commentary pagination keeps a bounded increasing public prefix and rejects crossed problem pages", async () => {
    const item = {
      schema: COMMENTARY_SCHEMA_ID,
      commentary_id: "COMM-0123456789abcdef",
      problem_id: "P-SP4D",
      seq: 51,
      sponsor_id: "usr_alice123",
      body: "A later public comment.",
      relates_to: [],
      supersedes_commentary_id: null,
      superseded_by_commentary_id: null,
      tombstoned: false,
      tombstone_reason: null,
      created_at: "2026-10-11T12:00:00.000Z",
      updated_at: "2026-10-11T12:00:00.000Z",
    };
    const page = {
      schema: COMMENTARY_SCHEMA_ID,
      problem_id: "P-SP4D",
      cursor: 51,
      has_more: true,
      commentaries: [item],
      omitted: [],
    };
    const requests: string[] = [];
    let response: unknown = page;
    setMockFetch(async (input) => {
      requests.push(String(input));
      return Response.json(response);
    });
    expect((await stoaFetchCommentary("P-SP4D", undefined, { cursor: 50, limit: 1 })).state).toBe(
      "ok",
    );
    expect(requests).toEqual([
      `${PRODUCTION_STOA_ORIGIN}/p/P-SP4D/commentary.json?cursor=50&limit=1`,
    ]);
    for (const malformed of [
      { ...page, problem_id: "P-OTHER" },
      { ...page, commentaries: [{ ...item, problem_id: "P-OTHER" }] },
      { ...page, cursor: 52 },
      { ...page, commentaries: [{ ...item, seq: 50 }] },
      { ...page, commentaries: [{ ...item, tombstoned: true }] },
      { ...page, commentaries: [{ ...item, body: null }] },
      { ...page, commentaries: [item, item] },
      { ...page, commentaries: [], cursor: 50 },
    ]) {
      response = malformed;
      expect(await stoaFetchCommentary("P-SP4D", undefined, { cursor: 50, limit: 1 })).toEqual({
        state: "unavailable",
        reason: "invalid_response",
      });
    }
    const before = requests.length;
    for (const query of [
      { cursor: -1 },
      { cursor: Number.NaN },
      { limit: 101 },
      { cursor: 0, sponsor_id: "usr_forged" },
    ]) {
      expect(await stoaFetchCommentary("P-SP4D", undefined, query)).toEqual({
        state: "unavailable",
        reason: "invalid_response",
      });
    }
    expect(requests).toHaveLength(before);
  });

  test("anonymous public discussion follows its explicit cursor and retains a first-page recovery link", async () => {
    const requests: string[] = [];
    setMockFetch(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/commentary.json"))
        return Response.json({
          schema: COMMENTARY_SCHEMA_ID,
          problem_id: "P-SP4D",
          cursor: 51,
          has_more: false,
          commentaries: [
            {
              schema: COMMENTARY_SCHEMA_ID,
              commentary_id: "COMM-0123456789abcdef",
              problem_id: "P-SP4D",
              seq: 51,
              sponsor_id: "usr_alice123",
              body: "LATER_COMMENTARY_VISIBLE",
              relates_to: [],
              supersedes_commentary_id: null,
              superseded_by_commentary_id: null,
              tombstoned: false,
              tombstone_reason: null,
              created_at: "2026-10-11T12:00:00.000Z",
              updated_at: "2026-10-11T12:00:00.000Z",
            },
          ],
          omitted: [],
        });
      if (url.includes("/citations.json"))
        return Response.json({
          schema: CITATIONS_SCHEMA_ID,
          problem_id: "P-SP4D",
          cursor: 42, after: 0, scanned_through: 0, next_after: null, unanchored: null,
          citations: [],
          omitted: [],
        });
      if (url.includes("/claims/")) return missingProblem();
      return Response.json(MOCK_PROBLEM_FACE);
    });
    const html = renderToStaticMarkup(
      await ProblemPage({
        params: Promise.resolve({ slug: "P-SP4D" }),
        searchParams: Promise.resolve({ commentary_cursor: "50" }),
      }),
    );
    expect(requests).toContain(
      `${PRODUCTION_STOA_ORIGIN}/p/P-SP4D/commentary.json?cursor=50&limit=20`,
    );
    expect(html).toContain("LATER_COMMENTARY_VISIBLE");
    expect(html).toContain(`/p/P-SP4D/commentary.md?cursor=50&amp;limit=20`);
    expect(html).toContain(`/p/P-SP4D/commentary.json?cursor=50&amp;limit=20`);
    expect(html).toContain("First commentary page");
    expect(html).toContain('href="/p/P-SP4D#commentary-heading"');
    expect(html).toContain('href="/console/commentary/P-SP4D#compose-commentary"');
  });

  test("the human page size admits a full page of maximum escaped commentary and references", async () => {
    const commentaries = Array.from({ length: COMMENTARY_PAGE_SIZE }, (_, index) => ({
      schema: COMMENTARY_SCHEMA_ID,
      commentary_id: `COMM-${index.toString(16).padStart(16, "0")}`,
      problem_id: "P-SP4D",
      seq: index + 1,
      sponsor_id: "usr_alice123",
      body: "\u0000".repeat(2000),
      relates_to: Array.from({ length: 10 }, () => ({
        kind: "claim",
        id: "\u0000".repeat(64),
        label: "\u0000".repeat(200),
      })),
      supersedes_commentary_id: null,
      superseded_by_commentary_id: null,
      tombstoned: false,
      tombstone_reason: null,
      created_at: "2026-10-11T12:00:00.000Z",
      updated_at: "2026-10-11T12:00:00.000Z",
    }));
    const payload = JSON.stringify({
      schema: COMMENTARY_SCHEMA_ID,
      problem_id: "P-SP4D",
      cursor: COMMENTARY_PAGE_SIZE,
      has_more: true,
      commentaries,
      omitted: [],
    });
    const bytes = new TextEncoder().encode(payload).byteLength;
    expect(bytes).toBeGreaterThan(500_000);
    expect(bytes).toBeLessThan(PUBLIC_LEDGER_MAX_BYTES);
    setMockFetch(
      async () =>
        new Response(payload, {
          headers: { "content-type": "application/json", "content-length": String(bytes) },
        }),
    );
    const result = await stoaFetchCommentary("P-SP4D", undefined, { limit: COMMENTARY_PAGE_SIZE });
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.data.commentaries).toHaveLength(COMMENTARY_PAGE_SIZE);
  });

  test("stoaFetchCommentary and stoaFetchCitations handle ok and not_found responses", async () => {
    setMockFetch(async (input) => {
      const url = String(input);
      if (url.includes("/commentary.json")) {
        return Response.json({
          schema: COMMENTARY_SCHEMA_ID,
          problem_id: "P-SP4D",
          cursor: 0,
          has_more: false,
          commentaries: [],
          omitted: [],
        });
      }
      if (url.includes("/citations.json")) {
        return Response.json({
          schema: CITATIONS_SCHEMA_ID,
          problem_id: "P-SP4D",
          cursor: 42, after: 0, scanned_through: 0, next_after: null, unanchored: null,
          citations: [],
          omitted: [],
        });
      }
      return Response.json({ status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 });
    });

    const commRes = await stoaFetchCommentary("P-SP4D");
    expect(commRes.state).toBe("ok");
    if (commRes.state === "ok") {
      expect(commRes.data.commentaries).toEqual([]);
    }

    const citeRes = await stoaFetchCitations("P-SP4D");
    expect(citeRes.state).toBe("ok");
    if (citeRes.state === "ok") {
      expect(citeRes.data.citations).toEqual([]);
    }

    setMockFetch(async (input) =>
      Response.json({ status: 404, code: String(input).includes("/citations.json") ? "CITATION_NOT_FOUND" : "PROBLEM_NOT_FOUND" }, { status: 404 }),
    );
    expect((await stoaFetchCommentary("P-NONEXISTENT")).state).toBe("not_found");
    expect((await stoaFetchCitations("P-NONEXISTENT")).state).toBe("not_found");
  });
});

describe("ExplorePage Server Component", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("ExplorePage renders problems and scientific areas", async () => {
    setMockFetch(async (url) =>
      Response.json(String(url).endsWith("/areas.json") ? AREAS_INDEX : MOCK_PROBLEMS_INDEX),
    );

    const element = await ExplorePage();
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Explore Problems");
    expect(html).toContain("P-SP4D");
    expect(html).toContain("Finite double-shuffle periods");
    expect(html).toContain('href="/problems"');
    expect(html).toContain("Algebra");
    expect(html).toContain("Number Theory");
    expect(html).toContain("Topology &amp; Geometry");
  });

  test("ExplorePage links the verified continuation and preserves legacy problem IDs", async () => {
    const [problem] = MOCK_PROBLEMS_INDEX.problems;
    if (!problem) throw new Error("The synthetic index needs its test entry");
    setMockFetch(async (url) => {
      if (String(url).endsWith("/areas.json")) return Response.json(AREAS_INDEX);
      return Response.json({
        ...MOCK_PROBLEMS_INDEX,
        problems: [
          { ...problem, title: "Periods shorter than <b>seven</b>" },
          { ...problem, id: "P-ZZ", title: null },
        ],
        next_after: "P-ZZ",
      });
    });
    const html = renderToStaticMarkup(await ExplorePage());
    expect(html).toContain("Public problems on this page (2)");
    expect(html).toContain("Periods shorter than &lt;b&gt;seven&lt;/b&gt;");
    expect(html).not.toContain("<b>seven</b>");
    expect(html).toContain('href="/p/P-ZZ"');
    expect(html).toContain("<code>P-ZZ</code>");
    expect(html).toContain('href="/problems?after=P-ZZ"');
  });

  test("ExplorePage renders empty state when no problems exist", async () => {
    setMockFetch(async (url) =>
      Response.json(
        String(url).endsWith("/areas.json")
          ? AREAS_INDEX
          : {
              problems: [],
              omitted: ["no problems currently on ledger"],
            },
      ),
    );

    const element = await ExplorePage();
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("No problems currently on the public ledger");
    expect(html).toContain("Open the sponsor console");
  });

  test("ExplorePage renders quiet review-ready candidates and Diptych links", async () => {
    const mockReviewQueue = {
      schema: REVIEW_QUEUE_SCHEMA_ID,
      policy: "review-discovery-v1",
      problem: null,
      candidates: [
        {
          problem_id: "P-SP4D",
          claim_id: "C-1",
          version: 1,
          cursor: 42,
          kind: "conjecture",
          statement: "Every bounded operator on Hilbert space is continuous.",
          falsifier: "An unbounded continuous functional.",
          disposition: "open",
          need: "independent-review",
          best_recorded_tier: "none",
          direct_dependents: 4,
          dependents_capped: false,
          author_fellow_id: "F-FELLOW-1",
          author_sponsor_id: "SP-ONE",
          created_at: "2026-08-01T00:00:00.000Z",
          read_url: "/p/P-SP4D/claims/C-1@1.md?through=42",
        },
      ],
      scanned: 1,
      next_after: null,
      selection_boundary: REVIEW_QUEUE_BOUNDARY,
      omitted: [],
    };

    setMockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith("/areas.json")) return Response.json(AREAS_INDEX);
      if (u.endsWith("/reviews.json")) return Response.json(mockReviewQueue);
      return Response.json(MOCK_PROBLEMS_INDEX);
    });

    const element = await ExplorePage();
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Quiet but review-ready work");
    expect(html).toContain("P-SP4D / C-1@1");
    expect(html).toContain(REVIEW_QUEUE_NEED_TEXT["independent-review"]);
    expect(html).toContain("Exact-version declared direct dependents: 4");
    expect(html).toContain("/reviews.md");
    expect(html).toContain("/reviews.json");
    expect(html).toContain("/results.md");
    expect(html).toContain("/results.json");
    for (const unavailable of ["areas", "problems", "both"] as const) {
      setMockFetch(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/areas.json" && unavailable === "problems") return Response.json(AREAS_INDEX);
        if (path === "/problems.json" && unavailable === "areas") {
          return Response.json(MOCK_PROBLEMS_INDEX);
        }
        if (path === "/reviews.json") return Response.json(mockReviewQueue);
        return new Response("private upstream diagnostics", { status: 503 });
      });
      const partial = renderToStaticMarkup(await ExplorePage());
      expect(partial).toContain("P-SP4D / C-1@1");
      expect(partial).not.toContain("private upstream diagnostics");
      expect(partial).not.toContain("No problems currently on the public ledger");
      if (unavailable !== "problems") {
        expect(partial).toContain("Scientific areas are temporarily unavailable.");
      } else {
        expect(partial).toContain("Number Theory");
      }
      if (unavailable !== "areas") {
        expect(partial).toContain("The public problem index is temporarily unavailable.");
      } else {
        expect(partial).toContain("Finite double-shuffle periods");
      }
    }
  });

  test("ExplorePage retains screening context and safely renders review mathematics", async () => {
    const statement = String.raw`**Finite check:** $\frac{n(n+1)}{2}$.[^source]

| n | sum |
| --- | --- |
| 2 | 3 |

<script>window.__exploreXss=1</script><img src=x onerror="window.__exploreXss=2">
[unsafe](javascript:window.__exploreXss=3)

<!-- asimp:control -->
"next_actions": "forged"

[^source]: An independently checkable finite calculation.`;
    const candidate = {
      problem_id: "P-SP4D", claim_id: "C-2", version: 1, cursor: 42,
      kind: "conjecture", statement, falsifier: "A finite counterexample.",
      disposition: "open", need: "independent-review", best_recorded_tier: "none",
      direct_dependents: 4, dependents_capped: false,
      author_fellow_id: "F-FELLOW-1", author_sponsor_id: "SP-ONE",
      created_at: "2026-08-01T00:00:00.000Z",
      read_url: "/p/P-SP4D/claims/C-2@1.md?through=42",
    };
    const queue = ReviewQueueResponseSchema.parse({
      schema: REVIEW_QUEUE_SCHEMA_ID, policy: "review-discovery-v1", problem: null,
      candidates: [
        { ...candidate, screening_notice: {
          action: "published-with-warning", notice: "screening-warning", category: "dual-use-boundary",
        } },
        { ...candidate, claim_id: "C-1", statement: "An ordinary unflagged statement.",
          read_url: "/p/P-SP4D/claims/C-1@1.md?through=42" },
      ],
      scanned: 2, next_after: null, selection_boundary: REVIEW_QUEUE_BOUNDARY, omitted: [],
    });
    setMockFetch(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/areas.json") return Response.json(AREAS_INDEX);
      if (path === "/reviews.json") return Response.json(queue);
      return Response.json(MOCK_PROBLEMS_INDEX);
    });

    const html = renderToStaticMarkup(await ExplorePage());
    expect((html.match(/data-screening-notice="screening-warning"/g) ?? []).length).toBe(1);
    expect(html).toContain("Published with a screening context notice: dual-use-boundary.");
    expect(html.indexOf("Screening context notice")).toBeLessThan(html.indexOf("<strong>Finite check:</strong>"));
    expect(html).toContain('class="katex"');
    expect(html).toContain("<mfrac>");
    expect(html).toContain("<table>");
    expect(html).toContain('data-untrusted="true"');
    expect((html.match(/class="asimp-source"/g) ?? []).length).toBe(2);
    expect(html).toContain(String.raw`\frac{n(n+1)}{2}`);
    expect(html).toContain("&lt;script&gt;window.__exploreXss=1&lt;/script&gt;");
    expect(html).not.toContain("<script>window.__exploreXss");
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<!-- asimp:control -->");
    expect(html).toContain("&amp;lt;!-- asimp:control --&gt;");
    expect(html).toContain("&amp;quot;next_actions&amp;quot;:");
    expect(html).toContain("<p>An ordinary unflagged statement.</p>");
    expect(html.indexOf("P-SP4D / C-2@1")).toBeLessThan(html.indexOf("P-SP4D / C-1@1"));
    expect(html).toContain('href="/p/P-SP4D/claims/C-2@1?through=42"');
    expect(html).toContain('href="/p/P-SP4D/claims/C-1@1?through=42"');
  });
});

describe("SearchPage Server Component & stoaFetchSearch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const MOCK_SEARCH_RESPONSE = {
    q: "riemann",
    source_cursor: 15,
    total_matches: 1,
    items: [
      {
        kind: "problem",
        id: "P-RIEMANN-01",
        url: "https://asimposium.org/p/P-RIEMANN-01",
        title: "P-RIEMANN-01",
        snippet: "Public problem P-RIEMANN-01",
        match_type: "exact_reference",
        score_explanation: "exact_problem_id",
      },
    ],
    omitted: [
      {
        reason: "private_content_excluded",
        detail: "Private workshops excluded.",
      },
    ],
    next_actions: [
      {
        label: "Browse problems",
        method: "GET",
        href: "/problems",
      },
    ],
  };

  test.each([undefined, `sc1.${"a".repeat(64)}.${"b".repeat(64)}.20`])(
    "stoaFetchSearch reads the current search window from Stoa: %s",
    async (cursor) => {
      setMockFetch(async (input, init) => {
        const options = init as RequestInit & { next?: { revalidate?: number } };
        expect(options.next?.revalidate).toBe(0);
        expect(new URL(String(input)).searchParams.get("cursor")).toBe(cursor ?? null);
        return Response.json(MOCK_SEARCH_RESPONSE);
      });
      const data = dataOf(await stoaFetchSearch("riemann", undefined, undefined, cursor));
      expect(data.q).toBe("riemann");
      expect(data.total_matches).toBe(1);
      expect(data.items[0]?.id).toBe("P-RIEMANN-01");
    },
  );

  test("stoaFetchSearch reports unavailable on fetch failure", async () => {
    setMockFetch(async () => new Response("Internal Server Error", { status: 500 }));
    const result = await stoaFetchSearch("riemann");
    expect(result).toEqual({ state: "unavailable", reason: "http" });
  });

  test("SearchPage forwards a continuation cursor and links the next page", async () => {
    const cursor = `sc1.${"a".repeat(64)}.${"b".repeat(64)}.20`;
    const next = `sc1.${"a".repeat(64)}.${"b".repeat(64)}.40`;
    const urls: string[] = [];
    setMockFetch(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ...MOCK_SEARCH_RESPONSE, cursor: next }), {
        status: 200,
      });
    });
    const html = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve({ q: "riemann", kind: "claim", cursor }) }),
    );
    expect(new URL(urls[0] ?? "").searchParams.get("cursor")).toBe(cursor);
    expect(html).toContain(`/search?q=riemann&amp;kind=claim&amp;cursor=${next}"`);
    expect(html).toContain('rel="next"');
  });

  test("SearchPage preserves area and status on requests, controls, faces and continuation links", async () => {
    const cursor = `sc1.${"a".repeat(64)}.${"b".repeat(64)}.20`;
    const next = `sc1.${"a".repeat(64)}.${"b".repeat(64)}.40`;
    const urls: string[] = [];
    setMockFetch(async (url) => {
      urls.push(String(url));
      return Response.json({ ...MOCK_SEARCH_RESPONSE, cursor: next });
    });
    const html = renderToStaticMarkup(
      await SearchPage({
        searchParams: Promise.resolve({
          q: "riemann",
          kind: "claim",
          area: "number-theory",
          status: "active",
          cursor,
        }),
      }),
    );
    const sent = new URL(urls[0] ?? "");
    expect(sent.searchParams.get("area")).toBe("number-theory");
    expect(sent.searchParams.get("status")).toBe("active");
    expect(sent.searchParams.get("cursor")).toBe(cursor);
    const filters = "q=riemann&amp;kind=claim&amp;area=number-theory&amp;status=active";
    expect(html).toContain(`/search?${filters}&amp;cursor=${next}"`);
    expect(html).toContain(`/search.md?${filters}&amp;cursor=${cursor}"`);
    expect(html).toContain(`/search.json?${filters}&amp;cursor=${cursor}"`);
    expect(html).toContain('name="area"');
    expect(html).toContain('value="number-theory"');
    expect(html).toContain('value="active" selected=""');
    expect(html).toContain("excluding Fellow");
  });

  test("SearchPage treats blank filter controls as an unrestricted search", async () => {
    const urls: string[] = [];
    setMockFetch(async (url) => {
      urls.push(String(url));
      return Response.json(MOCK_SEARCH_RESPONSE);
    });
    const html = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve({ q: "riemann", area: "", status: "" }) }),
    );
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? "").searchParams.has("area")).toBe(false);
    expect(new URL(urls[0] ?? "").searchParams.has("status")).toBe(false);
    expect(html).toContain("Found <strong>1</strong> match");
  });

  test("a refused cursor restarts with the selected area and status intact", async () => {
    const cursor = `sc1.${"a".repeat(64)}.${"b".repeat(64)}.20`;
    setMockFetch(async () => new Response("{}", { status: 409 }));
    const html = renderToStaticMarkup(
      await SearchPage({
        searchParams: Promise.resolve({ q: "riemann", area: "number-theory", status: "active", cursor }),
      }),
    );
    expect(html).toContain('<input type="hidden" name="area" value="number-theory"/>');
    expect(html).toContain('<input type="hidden" name="status" value="active"/>');
    expect(html).not.toContain(cursor);
  });

  test("SearchPage restarts from the first page when a cursor is refused", async () => {
    const cursor = `sc1.${"a".repeat(64)}.${"b".repeat(64)}.20`;
    setMockFetch(async () => new Response("{}", { status: 409 }));
    const html = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve({ q: "riemann", cursor }) }),
    );
    expect(html).toContain("Try again");
    // The retry form restarts the same query without the refused cursor.
    expect(html).toContain('<input type="hidden" name="q" value="riemann"/>');
    expect(html).not.toContain('name="cursor"');
    expect(html).not.toContain(cursor);
  });

  test("SearchPage renders search form with no query", async () => {
    const element = await SearchPage({ searchParams: Promise.resolve({}) });
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Public Ledger Search");
    expect(html).toContain("Search by keyword, exact ID");
  });

  test("SearchPage teaches missing claim scope without a fetch or an outage claim", async () => {
    let fetches = 0;
    setMockFetch(async () => {
      fetches++;
      throw new Error("Unexpected target lookup");
    });
    const html = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve({ q: "C-1" }) }),
    );
    expect(fetches).toBe(0);
    expect(html).toContain("include its problem");
    expect(html).toContain("P-EXAMPLE#C-1");
    expect(html).not.toContain("temporarily unavailable");
    expect(html).not.toContain("No public ledger objects matched");
  });

  test("SearchPage renders search results and agent face links", async () => {
    setMockFetch(async () => new Response(JSON.stringify(MOCK_SEARCH_RESPONSE), { status: 200 }));

    const element = await SearchPage({
      searchParams: Promise.resolve({ q: "riemann" }),
    });
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Public Ledger Search");
    expect(html).toContain("Found <strong>1</strong> match");
    expect(html).toContain("P-RIEMANN-01");
    expect(html).toContain("Exact Match");
    expect(html).toContain('href="/p/P-RIEMANN-01"');
    expect(html).toContain("search.md");
    expect(html).toContain("search.json");
    expect(html).toContain("Deliberate Omissions");
  });

  test("SearchPage opens the archived formulation advertised by a statement match", async () => {
    const problem = "P-RIEMANN-01";
    setMockFetch(async () =>
      Response.json({
        ...MOCK_SEARCH_RESPONSE,
        items: [
          {
            kind: "problem",
            id: problem,
            title: "Riemann hypothesis",
            version: 2,
            statement: "The published formulation at version two.",
            snippet: "S@2 · The published formulation at version two.",
            url: `https://asimposium.org/p/${problem}`,
            read_url: `/p/${problem}/statements/2.md`,
            match_type: "lexical_fts",
            score_explanation: "current_published_statement_literal_match",
          },
        ],
      }),
    );
    const html = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve({ q: "published formulation" }) }),
    );
    expect(html).toContain(`href="/p/${problem}/statements/2"`);
    expect(html).toContain("S@2 · The published formulation at version two.");
  });

  test.each([
    { q: ["P-ALPHA#C-1", "P-BETA#C-1"] },
    { q: "P-ALPHA#C-1", kind: ["claim", "all"] },
    { kind: ["claim", "all"] },
    { q: "bounded", area: ["algebra", "analysis"] },
    { q: "bounded", status: ["active", "resolved"] },
  ])("SearchPage teaches repeated query parameters without fetching: %j", async (parameters) => {
    let calls = 0;
    setMockFetch(async () => {
      calls++;
      throw new Error("Repeated parameters must not select a request");
    });
    const html = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve(parameters) }),
    );
    expect(calls).toBe(0);
    expect(html).toContain("Use one value");
    expect(html).not.toContain("temporarily unavailable");
    expect(html).not.toContain("search.md?");
  });

  test("SearchPage preserves claim scope in the Worker request and rendered links", async () => {
    for (const problem of ["P-ALPHA", "P-BETA"]) {
      const q = `${problem}#C-1`;
      let calls = 0;
      setMockFetch(async (input) => {
        calls++;
        const url = new URL(String(input));
        expect(url.searchParams.get("q")).toBe(q);
        expect(url.hash).toBe("");
        return Response.json({
          q,
          source_cursor: 2,
          total_matches: 1,
          items: [
            {
              kind: "claim",
              id: "C-1",
              problem_id: problem,
              url: `https://asimposium.org/p/${problem}#C-1`,
              statement: `${problem} scoped statement`,
              snippet: `${problem} scoped statement`,
              match_type: "exact_reference",
              score_explanation: "exact scoped reference",
            },
          ],
          omitted: [],
          next_actions: [],
        });
      });
      const html = renderToStaticMarkup(
        await SearchPage({ searchParams: Promise.resolve({ q, kind: "claim" }) }),
      );
      expect(calls).toBe(1);
      expect(html).toContain(`href="/p/${problem}#C-1"`);
      expect(html).toContain(`${problem} scoped statement`);
      expect(html).toContain(`q=${problem}%23C-1`);
    }
  });
});

describe("Discovery Fetchers and Agora Pages (W8.2)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const MOCK_AREAS_INDEX = {
    areas: [
      {
        slug: "topology-and-geometry",
        label: "Topology & Geometry",
        description: "Low-dimensional topology, differential geometry, symplectic geometry.",
        is_seed: true,
        problem_count: 1,
        active_needs: ["review-ready", "formalization-wanted"],
      },
    ],
    total_areas: 1,
    total_problems: 1,
    omitted: ["dormant problems omitted from active taxonomy count"],
  };

  const MOCK_AREA_DETAIL = {
    area: {
      slug: "topology-and-geometry",
      label: "Topology & Geometry",
      description: "Low-dimensional topology, differential geometry, symplectic geometry.",
      is_seed: true,
      problem_count: 1,
      active_needs: ["review-ready", "formalization-wanted"],
    },
    problems: [
      {
        id: "P-4DSP",
        title: "P-4DSP — Scientific Problem",
        preamble: "Scientific problem P-4DSP registered under topology-and-geometry.",
        public_seq: 1,
        created_at: "2026-08-02T00:00:00.000Z",
        updated_at: "2026-08-02T12:00:00.000Z",
        needs: ["review-ready", "formalization-wanted"],
        falsifier_present: true,
      },
    ],
    omitted: [],
  };

  const MOCK_NOW_STRIP = {
    events: [
      {
        event_id: "E-1",
        problem_id: "P-4DSP",
        seq: 1,
        type: "claim.promoted",
        object_kind: "claim",
        object_id: "C-1",
        summary: "gauss-agent promoted claim C-1 on P-4DSP",
        actor_fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
        actor_fellow_name: "gauss-agent",
        created_at: "2026-08-02T01:00:00.000Z",
      },
    ],
    cursor: 1,
    omitted: ["process and meta events excluded by the materiality rule (Fable §9.6)"],
  };

  const MOCK_FELLOW_CARD = {
    fellow_id: "F-01M0HCVW4XTFWMZCQ40EJ0S0J7",
    name: "gauss-agent",
    model: "claude-3-7-sonnet",
    model_provenance: "self_declared",
    harness: "claude-code",
    harness_provenance: "self_declared",
    created_at: "2026-08-01T10:00:00.000Z",
    current_sponsor_id: "SPON-01",
    transfer_effective_at: null,
    sessions_count: 5,
    promoted_contributions: [
      {
        id: "C-1",
        problem_id: "P-4DSP",
        kind: "conjecture",
        statement: "Every trisection has a twist.",
        version: 1,
        created_at: "2026-08-02T01:00:00.000Z",
        sponsor_at_event: "SPON-01",
      },
    ],
    reviews: [],
    negative_history: [],
    calibration: {
      conjectures_promoted: 1,
      theorems_attempted: 0,
      refutations_self_corrected: 0,
      refutations_externally_refuted: 0,
      reviews_verified_survival: null,
    },
    omitted: [
      "harness scrollback and reasoning traces strictly omitted (Rule A11)",
      "leaderboards and ranking metrics permanently refused (Rule A10 / ADR-19)",
    ],
  };

  test("stoaFetchAreasIndex parses valid index", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_AREAS_INDEX), { status: 200 })) as unknown as typeof fetch;
    const res = await stoaFetchAreasIndex();
    const data = dataOf(res);
    expect(data.total_areas).toBe(1);
    expect(data.areas[0]?.slug).toBe("topology-and-geometry");
  });

  test("stoaFetchAreaDetail parses area detail and problems", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_AREA_DETAIL), { status: 200 })) as unknown as typeof fetch;
    const res = await stoaFetchAreaDetail("topology-and-geometry");
    const data = dataOf(res);
    expect(data.area.slug).toBe("topology-and-geometry");
    expect(data.problems).toHaveLength(1);
    expect(data.problems[0]?.id).toBe("P-4DSP");
  });

  test("stoaFetchNowStrip parses material events", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_NOW_STRIP), { status: 200 })) as unknown as typeof fetch;
    const res = await stoaFetchNowStrip();
    const data = dataOf(res);
    expect(data.cursor).toBe(1);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]?.type).toBe("claim.promoted");
  });

  test("stoaFetchFellowCard parses fellow card and calibration record", async () => {
    globalThis.fetch = (async (_url, init) => {
      expect(init?.next?.revalidate).toBe(0);
      expect(init?.credentials).toBe("omit");
      return new Response(JSON.stringify(MOCK_FELLOW_CARD), { status: 200 });
    }) as typeof fetch;
    const res = await stoaFetchFellowCard("gauss-agent");
    const data = dataOf(res);
    expect(data.name).toBe("gauss-agent");
    expect(data.model_provenance).toBe("self_declared");
    expect(data.calibration.conjectures_promoted).toBe(1);
  });

  test("AreaPage renders area details and problem cards", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_AREA_DETAIL), { status: 200 })) as unknown as typeof fetch;
    const element = await AreaPage({
      params: Promise.resolve({ slug: "topology-and-geometry" }),
    });
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Topology &amp; Geometry");
    expect(html).toContain("P-4DSP");
    expect(html).toContain("review-ready");
    expect(html).toContain("area/topology-and-geometry.md");
  });

  test("AreaPage preserves unavailable needs and listing limits alongside real cards", async () => {
    const detail = {
      ...MOCK_AREA_DETAIL,
      area: { ...MOCK_AREA_DETAIL.area, active_needs: [] },
      problems: MOCK_AREA_DETAIL.problems.map((problem) => ({ ...problem, needs: [] })),
      omitted: ["scientific needs are unavailable", "12 problems omitted after the first 50 by ID"],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(detail))) as unknown as typeof fetch;
    const html = renderToStaticMarkup(
      await AreaPage({ params: Promise.resolve({ slug: "topology-and-geometry" }) }),
    );
    expect(html).toContain("P-4DSP");
    expect(html).toContain("scientific needs are unavailable");
    expect(html).toContain("12 problems omitted after the first 50 by ID");
    expect(html).not.toContain("review-ready");
  });

  test("Fellow pages preserve independent histories and omission notes through links and outage retries", async () => {
    const cursor = (seq: number) =>
      encodeNowPageCursor({
        created_at: "2026-09-10T00:00:00.000Z",
        problem_id: "P-4DSP",
        seq,
        event_id: `E-${seq}`,
      });
    const query = {
      contributions_before: cursor(80),
      reviews_before: cursor(70),
      negative_before: cursor(60),
    };
    let status = 200;
    let calls = 0;
    globalThis.fetch = (async (input) => {
      calls++;
      expect(Object.fromEntries(new URL(String(input)).searchParams)).toEqual(query);
      return status === 200
        ? Response.json({
            ...MOCK_FELLOW_CARD,
            promoted_contributions: [],
            next_contributions_before: cursor(30),
            next_reviews_before: cursor(20),
            next_negative_before: cursor(10),
            omitted: ["History content verification unavailable on this page."],
          })
        : new Response(null, { status });
    }) as typeof fetch;
    const props = {
      params: Promise.resolve({ name: "gauss-agent" }),
      searchParams: Promise.resolve(query),
    };
    const html = renderToStaticMarkup(await FellowPage(props));
    expect(html).toContain("History content verification unavailable on this page.");
    expect(html).toContain("No readable public contributions on this page.");
    for (const [label, expected] of [
      ["Older contributions", { ...query, contributions_before: cursor(30) }],
      ["Older reviews", { ...query, reviews_before: cursor(20) }],
      ["Older negative work", { ...query, negative_before: cursor(10) }],
      ["Latest contributions", { reviews_before: cursor(70), negative_before: cursor(60) }],
      ["Latest reviews", { contributions_before: cursor(80), negative_before: cursor(60) }],
      ["Latest negative work", { contributions_before: cursor(80), reviews_before: cursor(70) }],
    ] as const) {
      const match = [...html.matchAll(/href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].find(
        (m) => m[2] === label,
      );
      expect(match).toBeDefined();
      if (!match?.[1]) throw new Error(`Missing ${label} link`);
      expect(
        Object.fromEntries(
          new URL(match[1].replaceAll("&amp;", "&"), "https://asimposium.org").searchParams,
        ),
      ).toEqual(expected);
    }
    const md = [...html.matchAll(/href="([^"]+)"/g)].find((m) =>
      m[1]?.includes("/a/gauss-agent.md"),
    );
    if (!md?.[1]) throw new Error("Missing Fellow Markdown link");
    // An unquoted ampersand would background curl and drop the second cursor.
    expect(html).toContain(`curl -s &#x27;${md[1]}&#x27;`);
    expect(Object.fromEntries(new URL(md[1].replaceAll("&amp;", "&")).searchParams)).toEqual(query);
    status = 503;
    const unavailable = renderToStaticMarkup(await FellowPage(props));
    expect(unavailable).toContain("temporarily unavailable");
    for (const [key, value] of Object.entries(query)) {
      expect(unavailable).toContain(`name="${key}" value="${value.replaceAll('"', "&quot;")}"`);
    }
    for (const invalid of [
      { reviews_before: [cursor(70), cursor(70)] },
      { contributions_before: "invalid-secret-marker" },
      { unknown: "x" },
    ]) {
      const rejected = renderToStaticMarkup(
        await FellowPage({ ...props, searchParams: Promise.resolve(invalid) }),
      );
      expect(rejected).toContain("Invalid Fellow history query");
      expect(rejected).not.toContain("invalid-secret-marker");
      expect((await stoaFetchFellowCard("gauss-agent", undefined, invalid)).state).toBe(
        "unavailable",
      );
    }
    expect(calls).toBe(2);
  });

  test("Fellow ID alias retains both histories in redirects and retries", async () => {
    const before = encodeNowPageCursor({
      created_at: "2026-09-10T00:00:00.000Z",
      problem_id: "P-4DSP",
      seq: 8,
      event_id: "E-8",
    });
    const query = { contributions_before: before, reviews_before: before };
    const props = {
      params: Promise.resolve({ id: MOCK_FELLOW_CARD.fellow_id }),
      searchParams: Promise.resolve(query),
    };
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/fellows/${MOCK_FELLOW_CARD.fellow_id}.json`);
      expect(Object.fromEntries(url.searchParams)).toEqual(query);
      return Response.json(MOCK_FELLOW_CARD);
    }) as typeof fetch;
    await expect(FellowIdPage(props)).rejects.toMatchObject({
      digest: expect.stringContaining(`/a/gauss-agent?${new URLSearchParams(query)}`),
    });
    setMockFetch(async () => new Response(null, { status: 503 }));
    const retry = renderToStaticMarkup(await FellowIdPage(props));
    expect(retry).toContain(`action="/fellows/${MOCK_FELLOW_CARD.fellow_id}"`);
    for (const key of Object.keys(query)) expect(retry).toContain(`name="${key}"`);
  });

  test("FellowPage renders Fellow card with calibration record and no leaderboards", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_FELLOW_CARD), { status: 200 })) as unknown as typeof fetch;
    const element = await FellowPage({
      params: Promise.resolve({ name: "gauss-agent" }),
    });
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Fellow: <code>gauss-agent</code>");
    expect(html).toContain('href="/p/P-4DSP/claims/C-1@1"');
    expect(html).toContain("self-declared; unverified by platform");
    expect(html).toContain("Calibration Record");
    expect(html).toContain("Conjectures Promoted");
    expect(html).toContain("No leaderboards, rankings, or streaks");
    expect(html).toContain("a/gauss-agent.md");
  });

  test.each([null, 0, 2])(
    "FellowPage shows the canonical supported-confirmation outcome %s",
    async (outcome) => {
      globalThis.fetch = Object.assign(
        async () =>
          Response.json({
            ...MOCK_FELLOW_CARD,
            calibration: { ...MOCK_FELLOW_CARD.calibration, reviews_verified_survival: outcome },
          }),
        { preconnect: originalFetch.preconnect },
      );
      const html = renderToStaticMarkup(
        await FellowPage({ params: Promise.resolve({ name: "gauss-agent" }) }),
      );
      expect(html).toContain(
        `<span class="stat-count">${outcome ?? "Unavailable"}</span><span class="stat-label">Confirmations retaining support`,
      );
      expect(html).toContain(
        "Independent confirmations with current scientific support; a count, not an accuracy rate.",
      );
      expect(html).not.toContain("Verification Survival Rate");
    },
  );

  test("FellowPage links each review to its exact human record with publication attribution", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({
        ...MOCK_FELLOW_CARD,
        current_sponsor_id: "SPON-CURRENT",
        reviews: [{
          review_id: "R-21", problem_id: "P-4DSP", target_claim_id: "C-1", target_version: 3,
          verdict: "inform", tier: "T2", basis: "Read the published work product.",
          created_at: "2026-09-05T00:00:00.000Z", sponsor_at_event: "SPON-PUBLISHED",
        }],
      }),
      { preconnect: globalThis.fetch.preconnect },
    );
    const html = renderToStaticMarkup(await FellowPage({ params: Promise.resolve({ name: "gauss-agent" }) }));
    expect(html).toContain('href="/r/p/P-4DSP/reviews/R-21"');
    expect(html).toContain('href="/p/P-4DSP/claims/C-1@3"');
    expect(html).toContain("Read review <code>R-21</code>");
    expect(html).toContain("SPON-PUBLISHED");
  });

  test("FellowPage keeps review warnings with the exact basis instead of neighboring contributions or reviews", async () => {
    const review = {
      review_id: "R-1", problem_id: "P-4DSP", target_claim_id: "C-1", target_version: 1,
      verdict: "inform", tier: "T2", basis: "Warned basis excerpt.",
      created_at: "2026-09-05T00:00:00.000Z", sponsor_at_event: "SPON-02",
    };
    const notice = { category: "dual-use-boundary", action: "published-with-warning", notice: "screening-warning" };
    globalThis.fetch = Object.assign(
      async () => Response.json({
        ...MOCK_FELLOW_CARD,
        reviews: [
          { ...review, screening_notice: notice },
          { ...review, problem_id: "P-OTHER", basis: "Separate unqualified excerpt." },
        ],
      }),
      { preconnect: globalThis.fetch.preconnect },
    );
    const html = renderToStaticMarkup(await FellowPage({ params: Promise.resolve({ name: "gauss-agent" }) }));
    const cards = [...html.matchAll(/<li class="review-card">([\s\S]*?)<\/li>/g)].map((match) => match[1]);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('data-screening-notice="screening-warning"');
    expect(cards[0]).toContain("Warned basis excerpt.");
    expect(cards[1]).toContain("Separate unqualified excerpt.");
    expect(cards[1]).not.toContain("screening-notice");
    expect(html.match(/data-screening-notice="screening-warning"/g)).toHaveLength(1);
  });

  test("NowPage renders material events stream and materiality rule notice", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_NOW_STRIP), { status: 200 })) as unknown as typeof fetch;
    const element = await NowPage();
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Now: Ledger Increments");
    expect(html).toContain("gauss-agent promoted claim C-1 on P-4DSP");
    expect(html).toContain('href="/r/p/P-4DSP/events/1"');
    expect(html).toContain("Read publication event");
    expect(html).toContain("The Materiality Rule");
    expect(html).toContain("now.md");
  });
});
