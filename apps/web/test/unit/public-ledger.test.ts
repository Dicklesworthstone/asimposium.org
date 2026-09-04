import { afterEach, describe, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));

const {
  stoaFetchAreaDetail,
  stoaFetchAreasIndex,
  stoaFetchFellowCard,
  stoaFetchNowStrip,
  stoaFetchProblemFace,
  stoaFetchProblemsIndex,
  stoaFetchSearch,
} = await import("../../lib/public-ledger.ts");
const { default: ProblemPage, generateMetadata } = await import("../../app/p/[slug]/page.tsx");
const { default: ExplorePage } = await import("../../app/explore/page.tsx");
const { default: SearchPage } = await import("../../app/search/page.tsx");
const { default: AreaPage } = await import("../../app/area/[slug]/page.tsx");
const { default: FellowPage } = await import("../../app/a/[name]/page.tsx");
const { default: NowPage } = await import("../../app/now/page.tsx");

const MOCK_PROBLEM_FACE = {
  schema: "asimposium.problem-face.v1",
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
      public_seq: 42,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    },
  ],
  omitted: ["titles land with problem lifecycle"],
};

function setMockFetch(fn: (...args: unknown[]) => Promise<Response>): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}

describe("public-ledger client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    expect(result).not.toBeNull();
    expect(result?.problem).toBe("P-SP4D");
    expect(result?.cursor).toBe(42);
    expect(result?.items.length).toBe(2);
  });

  test("stoaFetchProblemFace returns null on 404", async () => {
    setMockFetch(async () => new Response("Not Found", { status: 404 }));
    const result = await stoaFetchProblemFace("P-UNKNOWN", PRODUCTION_STOA_ORIGIN);
    expect(result).toBeNull();
  });

  test("stoaFetchProblemFace returns null on schema mismatch", async () => {
    setMockFetch(async () => new Response(JSON.stringify({ schema: "wrong" }), { status: 200 }));
    const result = await stoaFetchProblemFace("P-SP4D", PRODUCTION_STOA_ORIGIN);
    expect(result).toBeNull();
  });

  test("stoaFetchProblemFace returns null on fetch rejection", async () => {
    setMockFetch(async () => {
      throw new Error("network-down");
    });
    const result = await stoaFetchProblemFace("P-SP4D", PRODUCTION_STOA_ORIGIN);
    expect(result).toBeNull();
  });

  test("stoaFetchProblemFace returns null for untrusted origin", async () => {
    const result = await stoaFetchProblemFace("P-SP4D", "https://attacker.invalid");
    expect(result).toBeNull();
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
    expect(result).not.toBeNull();
    expect(result?.problems.length).toBe(1);
    expect(result?.problems[0]?.id).toBe("P-SP4D");
  });

  test("stoaFetchProblemsIndex returns null on fetch rejection", async () => {
    setMockFetch(async () => {
      throw new Error("network-down");
    });
    const result = await stoaFetchProblemsIndex(PRODUCTION_STOA_ORIGIN);
    expect(result).toBeNull();
  });
});

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
    setMockFetch(async () => new Response("Not Found", { status: 404 }));

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

  test("ProblemPage calls notFound when problem is not found", async () => {
    setMockFetch(async () => new Response("Not Found", { status: 404 }));

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
});

describe("ExplorePage Server Component", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("ExplorePage renders problems and scientific areas", async () => {
    setMockFetch(async () => new Response(JSON.stringify(MOCK_PROBLEMS_INDEX), { status: 200 }));

    const element = await ExplorePage();
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Explore Problems");
    expect(html).toContain("P-SP4D");
    expect(html).toContain("Algebra");
    expect(html).toContain("Number Theory");
    expect(html).toContain("Topology &amp; Geometry");
  });

  test("ExplorePage renders empty state when no problems exist", async () => {
    setMockFetch(
      async () =>
        new Response(
          JSON.stringify({
            problems: [],
            omitted: ["no problems currently on ledger"],
          }),
          { status: 200 },
        ),
    );

    const element = await ExplorePage();
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("No problems currently on the public ledger");
    expect(html).toContain("Open the sponsor console");
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

  test("stoaFetchSearch parses valid search response", async () => {
    setMockFetch(async () => new Response(JSON.stringify(MOCK_SEARCH_RESPONSE), { status: 200 }));
    const result = await stoaFetchSearch("riemann");
    expect(result).not.toBeNull();
    expect(result?.q).toBe("riemann");
    expect(result?.total_matches).toBe(1);
    expect(result?.items[0]?.id).toBe("P-RIEMANN-01");
  });

  test("stoaFetchSearch returns null on fetch failure", async () => {
    setMockFetch(async () => new Response("Internal Server Error", { status: 500 }));
    const result = await stoaFetchSearch("riemann");
    expect(result).toBeNull();
  });

  test("SearchPage renders search form with no query", async () => {
    const element = await SearchPage({ searchParams: Promise.resolve({}) });
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Public Ledger Search");
    expect(html).toContain("Search by keyword, exact ID");
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
    expect(html).toContain("search.md");
    expect(html).toContain("search.json");
    expect(html).toContain("Deliberate Omissions");
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
    calibration: {
      conjectures_promoted: 1,
      theorems_attempted: 0,
      refutations_self_corrected: 0,
      refutations_externally_refuted: 0,
      reviews_verified_survival: null,
      dead_ends_recorded: 0,
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
    expect(res).not.toBeNull();
    expect(res?.total_areas).toBe(1);
    expect(res?.areas?.[0]?.slug).toBe("topology-and-geometry");
  });

  test("stoaFetchAreaDetail parses area detail and problems", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_AREA_DETAIL), { status: 200 })) as unknown as typeof fetch;
    const res = await stoaFetchAreaDetail("topology-and-geometry");
    expect(res).not.toBeNull();
    expect(res?.area.slug).toBe("topology-and-geometry");
    expect(res?.problems).toHaveLength(1);
    expect(res?.problems?.[0]?.id).toBe("P-4DSP");
  });

  test("stoaFetchNowStrip parses material events", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_NOW_STRIP), { status: 200 })) as unknown as typeof fetch;
    const res = await stoaFetchNowStrip();
    expect(res).not.toBeNull();
    expect(res?.cursor).toBe(1);
    expect(res?.events).toHaveLength(1);
    expect(res?.events?.[0]?.type).toBe("claim.promoted");
  });

  test("stoaFetchFellowCard parses fellow card and calibration record", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_FELLOW_CARD), { status: 200 })) as unknown as typeof fetch;
    const res = await stoaFetchFellowCard("gauss-agent");
    expect(res).not.toBeNull();
    expect(res?.name).toBe("gauss-agent");
    expect(res?.model_provenance).toBe("self_declared");
    expect(res?.calibration.conjectures_promoted).toBe(1);
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

  test("FellowPage renders Fellow card with calibration record and no leaderboards", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_FELLOW_CARD), { status: 200 })) as unknown as typeof fetch;
    const element = await FellowPage({
      params: Promise.resolve({ name: "gauss-agent" }),
    });
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Fellow: <code>gauss-agent</code>");
    expect(html).toContain("self-declared; unverified by platform");
    expect(html).toContain("Calibration Record");
    expect(html).toContain("Conjectures Promoted");
    expect(html).toContain("No leaderboards, rankings, or streaks");
    expect(html).toContain("a/gauss-agent.md");
  });

  test("NowPage renders material events stream and materiality rule notice", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MOCK_NOW_STRIP), { status: 200 })) as unknown as typeof fetch;
    const element = await NowPage();
    expect(element).toBeDefined();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Now: Ledger Increments");
    expect(html).toContain("gauss-agent promoted claim C-1 on P-4DSP");
    expect(html).toContain("The Materiality Rule");
    expect(html).toContain("now.md");
  });
});
