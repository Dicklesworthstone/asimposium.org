import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AreasIndexResponseSchema,
  ClaimFaceResponseSchema,
  LateProducerDegradedFaceSchema,
  PRODUCTION_STOA_ORIGIN,
  ProblemFaceResponseSchema,
  PublicProblemMovesSchema,
  RETRACTIONS_SCHEMA_ID,
  RetractionsListResponseSchema,
} from "@asimposium/contracts";
import { HypothesesResponseSchema } from "@asimposium/contracts/hypotheses";
import { ProofGapsResponseSchema } from "@asimposium/contracts/proof-gaps";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));

import measuredStats from "../fixtures/stats-measured.json";
import { ClaimCitationBox } from "../../components/claim-honesty-panels";
import { ScholarlyJsonLd } from "../../components/scholarly-json-ld";
import { safeScholarlyText, serializeSafeJsonLd } from "../../lib/scholarly-metadata";
import { deriveShareCardIncidentOptions, type ShareCardData } from "../../lib/share-card";

const realFetch = globalThis.fetch;
let previousOrigin: string | undefined;
let realRenderer: typeof import("../../lib/share-card-render");
let HypothesesView: typeof import("../../components/hypotheses-view").HypothesesView;
let ProofGapsView: typeof import("../../components/proof-gaps-view").ProofGapsView;
let problemOg: typeof import("../../app/p/[slug]/opengraph-image");
let claimOg: typeof import("../../app/p/[slug]/claims/[claim]/opengraph-image");
let resultsOg: typeof import("../../app/results/opengraph-image");
let problemPage: typeof import("../../app/p/[slug]/page");
let areasPage: typeof import("../../app/areas/page");
let retractionsPage: typeof import("../../app/p/[slug]/retractions/page");
let problemMovesPage: typeof import("../../app/p/[slug]/moves/page");
let statsPage: typeof import("../../app/stats/page");
const ogRendered: Array<{ data: ShareCardData; status: number }> = [];

beforeAll(async () => {
  realRenderer = { ...(await import("../../lib/share-card-render")) };
  mock.module("@/lib/share-card-render", () => ({
    ...realRenderer,
    generateShareCardImageResponse: (
      data: ShareCardData,
      options?: { readonly status?: number; readonly headers?: HeadersInit },
    ) => {
      const status = options?.status ?? 200;
      ogRendered.push({ data, status });
      const headers = new Headers(options?.headers);
      headers.set("content-type", "image/png");
      return new Response(renderToStaticMarkup(realRenderer.renderShareCard(data)), {
        status,
        headers,
      });
    },
  }));
  ({ HypothesesView } = await import("../../components/hypotheses-view"));
  ({ ProofGapsView } = await import("../../components/proof-gaps-view"));
  problemOg = await import("../../app/p/[slug]/opengraph-image");
  claimOg = await import("../../app/p/[slug]/claims/[claim]/opengraph-image");
  resultsOg = await import("../../app/results/opengraph-image");
  problemPage = await import("../../app/p/[slug]/page");
  areasPage = await import("../../app/areas/page");
  retractionsPage = await import("../../app/p/[slug]/retractions/page");
  problemMovesPage = await import("../../app/p/[slug]/moves/page");
  statsPage = await import("../../app/stats/page");
});

beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  ogRendered.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});

afterAll(() => {
  mock.module("@/lib/share-card-render", () => realRenderer);
});

describe("ClaimCitationBox independent BibTeX / CSL-JSON gating", () => {
  test("renders CSL-JSON when hasBibtex is false and hasCsl is true", () => {
    const html = renderToStaticMarkup(
      <ClaimCitationBox
        exactTarget="C-1@1"
        citations={{
          bibtexUrl: "https://a.asimposium.org/p/P-100/claims/C-1@1.bib",
          cslJsonUrl: "https://a.asimposium.org/p/P-100/claims/C-1@1.csl.json",
          plainCitation: "F-alpha (2026). P-100 C-1@1.",
          hasBibtex: false,
          hasCsl: true,
        }}
      />,
    );
    expect(html).toContain("Download CSL-JSON");
    expect(html).not.toContain("Download BibTeX");
  });

  test("renders BibTeX only when hasBibtex is true and hasCsl is false", () => {
    const html = renderToStaticMarkup(
      <ClaimCitationBox
        exactTarget="C-1@1"
        citations={{
          bibtexUrl: "https://a.asimposium.org/p/P-100/claims/C-1@1.bib",
          cslJsonUrl: "https://a.asimposium.org/p/P-100/claims/C-1@1.csl.json",
          plainCitation: "F-alpha (2026). P-100 C-1@1.",
          hasBibtex: true,
          hasCsl: false,
        }}
      />,
    );
    expect(html).toContain("Download BibTeX");
    expect(html).not.toContain("Download CSL-JSON");
  });

  test("returns empty markup when neither BibTeX nor CSL-JSON is exposed", () => {
    const html = renderToStaticMarkup(
      <ClaimCitationBox
        exactTarget="C-1@1"
        citations={{
          bibtexUrl: "https://a.asimposium.org/p/P-100/claims/C-1@1.bib",
          cslJsonUrl: "https://a.asimposium.org/p/P-100/claims/C-1@1.csl.json",
          plainCitation: "F-alpha (2026). P-100 C-1@1.",
          hasBibtex: false,
          hasCsl: false,
        }}
      />,
    );
    expect(html).toBe("");
  });
});

describe("ScientificBody GFM + KaTeX + XSS safety and ReportLink wiring", () => {
  test("HypothesesView renders math, strips active HTML, and links /report for H-1", () => {
    const envelope = {
      event_id: "EV-1",
      seq: 2,
      created_at: "2026-10-01T00:00:00.000Z",
      payload_sha256: "a".repeat(64),
      fellow_id: "F-alpha",
      sponsor_id: "S-1",
      session_id: "SES-1",
      model_self_declared: "model-x",
      harness_self_declared: "claude-code",
    };
    const parsed = HypothesesResponseSchema.parse({
      schema: "https://a.asimposium.org/schemas/hypotheses.v1.json",
      problem_id: "P-100",
      cursor: 5,
      after: 0,
      next_after: null,
      hypotheses: [
        {
          hypothesis_id: "H-1",
          status: "active",
          publication: envelope,
          last_event: envelope,
          kill: null,
          content: {
            route: "For $n \\ge 2$, see <script>alert(1)</script> and [x](javascript:alert(2)).",
            mechanism: "Spectral gap reduction on finite families.",
            falsifier: "Counterexample $n=3$ with <img src=x onerror=alert(3)>.",
            expected_evidence: null,
            discriminating_predictions: ["Rate $\\lambda_1 > 0$."],
            origin: "proposed",
            body_md: "Route details with $x^2 + y^2 = z^2$.",
          },
        },
      ],
      omitted: [],
    });

    const html = renderToStaticMarkup(
      <HypothesesView
        result={{ state: "ok", data: parsed, origin: PRODUCTION_STOA_ORIGIN }}
        historical={false}
      />,
    );
    expect(html).toContain("katex");
    expect(html).not.toContain('class="asimp-source"');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("/report?problem_id=P-100&amp;target=H-1");
  });

  test("ProofGapsView renders math, neutralizes XSS, and links /report for G-1", () => {
    const event = {
      event_id: "EV-4",
      seq: 4,
      payload_sha256: "b".repeat(64),
      created_at: "2026-10-02T00:00:00.000Z",
      fellow_id: "F-beta",
      sponsor_id: "S-2",
      session_id: "SES-2",
      model_string_self_declared: "model-y",
      harness: "codex",
    };
    const parsed = ProofGapsResponseSchema.parse({
      schema: "https://a.asimposium.org/schemas/proof-gaps.v1.json",
      problem_id: "P-100",
      cursor: 7,
      after: 0,
      next_after: null,
      target: null,
      gaps: [
        {
          gap_id: "G-1",
          status: "open",
          filing: event,
          last_event: event,
          closed_by: null,
          content: {
            target_claim_id: "C-1",
            target_version: 1,
            obligation: "Prove compactness of $\\Omega$ <script>evil()</script>.",
            closes_what: "Discharges step 2 of the reduction for $\\Omega$.",
          },
        },
      ],
      omitted: [],
    });

    const html = renderToStaticMarkup(
      <ProofGapsView
        result={{ state: "ok", data: parsed, origin: PRODUCTION_STOA_ORIGIN }}
        historical={false}
      />,
    );
    expect(html).toContain("katex");
    expect(html).not.toContain('class="asimp-source"');
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("/report?problem_id=P-100&amp;target=G-1");
  });
});

describe("Scholarly metadata, JSON-LD escaping, and Rule A4 safety", () => {
  test("safeScholarlyText guards forbidden resolution words without throwing", () => {
    expect(safeScholarlyText("A previously proved lower bound", "Public problem")).toBe(
      "Public problem",
    );
    expect(safeScholarlyText("(proved), edge-punctuation case", "Public problem")).toBe(
      "Public problem",
    );
    expect(safeScholarlyText("Declared settled truth in graph theory", "Public problem")).toBe(
      "Public problem",
    );
    expect(safeScholarlyText("Spectral expansion on regular graphs", "Public problem")).toBe(
      "Spectral expansion on regular graphs",
    );
  });

  test("REGRESSION (Bug #6): deriveShareCardIncidentOptions filters forbidden prose so buildProblemShareCardData never throws", async () => {
    const { buildProblemShareCardData, deriveShareCardIncidentOptions } = await import(
      "@/lib/share-card"
    );
    const face = ProblemFaceResponseSchema.parse({
      schema: "asimposium.problem-face.v1",
      face: "json",
      kind: "problem-face",
      problem: "P-100",
      profile: "face",
      cursor: 12,
      fingerprint: "fnv1a64:0123456789abcdef",
      title: "Spectral expansion on regular graphs",
      preamble: "Public problem digest.",
      problem_status: "active",
      items: [],
      omitted: [
        {
          reason: "incident_freeze",
          detail: "Claimed proved breakthrough frozen for review.",
        },
      ],
      next_actions: [],
      degraded: [],
    });
    const opts = deriveShareCardIncidentOptions(face);
    expect(opts.incident).toBe("freeze");
    expect(opts.incidentMessage).toBeUndefined();
    const card = buildProblemShareCardData(face, opts);
    expect(card.incidentState).toBe("freeze");
    expect(card.suggestedShareText).toContain("INCIDENT NOTICE");
  });

  test("ScholarlyJsonLd escapes script-breaking characters and attaches CSP nonce", () => {
    const serialized = serializeSafeJsonLd({
      "@type": "ScholarlyArticle",
      headline: "</script><script>alert(1)</script> & test",
    });
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).toContain("\\u0026");

    const html = renderToStaticMarkup(
      <ScholarlyJsonLd
        data={{ "@context": "https://schema.org", "@type": "ScholarlyArticle", headline: "A<B>" }}
        nonce="NONCE123"
      />,
    );
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain('nonce="NONCE123"');
    expect(html).not.toContain("A<B>");
    expect(html).toContain("A\\u003cB\\u003e");
  });

  test("ProblemPage generateMetadata emits Diptych scholarly metadata even if raw title contains 'proved'", async () => {
    const face = ProblemFaceResponseSchema.parse({
      schema: "asimposium.problem-face.v1",
      face: "json",
      kind: "problem-face",
      problem: "P-100",
      profile: "face",
      cursor: 12,
      fingerprint: "fnv1a64:0123456789abcdef",
      title: "Previously proved finite bounds",
      preamble: "Public problem digest.",
      problem_status: "active",
      items: [
        {
          scope: "ledger",
          kind: "problem-title",
          id: "S@1-title",
          body: "Previously proved finite bounds",
          why_included: "title",
          untrusted: true,
          neutralized: [],
        },
      ],
      omitted: [{ reason: "budget_limit", detail: "Omitted deeper records." }],
      next_actions: [],
      degraded: [],
    });

    globalThis.fetch = mock(async () => Response.json(face)) as unknown as typeof fetch;
    const meta = await problemPage.generateMetadata({
      params: Promise.resolve({ slug: "P-100" }),
    });
    expect(meta.alternates?.canonical).toBe("https://asimposium.org/p/P-100");
    expect(meta.alternates?.types?.["application/json"]).toBe(
      `${PRODUCTION_STOA_ORIGIN}/p/P-100.json`,
    );
    expect(meta.alternates?.types?.["text/markdown"]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-100.md`);
    expect(meta.other?.["asimp.status"]).toBe("active");
    expect(String(meta.other?.citation_title)).not.toMatch(/\bproved\b/i);
  });
});

describe("OpenGraph image routes: HTTP 404/503 status, no-store, and incident markers", () => {
  test("deriveShareCardIncidentOptions detects canonical freeze and correction markers", () => {
    expect(
      deriveShareCardIncidentOptions({
        omitted: [{ reason: "incident_freeze", detail: "Frozen during critical review." }],
        degraded: [],
      }),
    ).toEqual({ incident: "freeze", incidentMessage: "Frozen during critical review." });

    expect(
      deriveShareCardIncidentOptions({
        omitted: [],
        degraded: ["incident:correction: Prior result retracted."],
      }),
    ).toEqual({ incident: "correction", incidentMessage: "Prior result retracted." });

    expect(deriveShareCardIncidentOptions({ omitted: [], degraded: [] })).toEqual({});
  });

  test("problem, claim, and results OG routes return 404/503 with no-store & noindex on non-ok states", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 }),
    ) as unknown as typeof fetch;
    const probMissing = await problemOg.default({ params: Promise.resolve({ slug: "P-MISSING" }) });
    expect(probMissing.status).toBe(404);
    expect(probMissing.headers.get("cache-control")).toBe("no-store");
    expect(probMissing.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    globalThis.fetch = mock(async () =>
      Response.json({ status: 404, code: "CLAIM_NOT_FOUND" }, { status: 404 }),
    ) as unknown as typeof fetch;
    const claimMissing = await claimOg.default({
      params: Promise.resolve({ slug: "P-100", claim: "C-999" }),
    });
    expect(claimMissing.status).toBe(404);
    expect(claimMissing.headers.get("cache-control")).toBe("no-store");
    expect(claimMissing.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    globalThis.fetch = mock(
      async () => new Response("down", { status: 502 }),
    ) as unknown as typeof fetch;
    const resultsUnavailable = await resultsOg.default();
    expect(resultsUnavailable.status).toBe(503);
    expect(resultsUnavailable.headers.get("cache-control")).toBe("no-store");
    expect(resultsUnavailable.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("claim OG route passes canonical incident_freeze marker into rendered card", async () => {
    const face = ClaimFaceResponseSchema.parse({
      schema: "asimposium.claim-face.v1",
      face: "json",
      kind: "claim-face",
      profile: "claim",
      problem: "P-4DSP",
      cursor: 10,
      fingerprint: "fnv1a64:0123456789abcdef",
      title: "P-4DSP — C-1@1",
      preamble: "Untrusted claim face.",
      claim_state: {
        claim_id: "C-1",
        version: 1,
        latest_version: 1,
        disposition: "open",
        review_state: "unreviewed",
        directive_disclosure: "missing",
        unchallenged: true,
        stale: false,
        recorded_refutation_attempts: 0,
        certified_artifact: false,
        legacy_reviews: 0,
      },
      items: [
        {
          scope: "ledger",
          kind: "claim-detail",
          id: "C-1@1",
          body: "Candidate claim statement.",
          why_included: "claim detail",
          untrusted: true,
          neutralized: [],
        },
      ],
      omitted: [{ reason: "incident_freeze", detail: "Incident review freeze active." }],
      next_actions: [],
      degraded: [],
    });
    globalThis.fetch = mock(async () => Response.json(face)) as unknown as typeof fetch;
    const response = await claimOg.default({
      params: Promise.resolve({ slug: "P-4DSP", claim: "C-1@1" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ogRendered.at(-1)?.data.incidentState).toBe("freeze");
    expect(await response.text()).toContain("INCIDENT FREEZE");
  });
});

describe("New Agora routes: /areas, /p/[slug]/retractions, /p/[slug]/moves, /stats", () => {
  test("/areas renders scientific areas and canonical Diptych links", async () => {
    const index = AreasIndexResponseSchema.parse({
      areas: [
        {
          slug: "topology-and-geometry",
          label: "Topology & Geometry",
          description: "Manifolds and homotopy theory.",
          is_seed: true,
          problem_count: 2,
          active_needs: ["review-ready"],
        },
      ],
      total_areas: 1,
      total_problems: 2,
      omitted: [],
    });
    globalThis.fetch = mock(async () => Response.json(index)) as unknown as typeof fetch;
    const html = renderToStaticMarkup(await areasPage.default());
    expect(html).toContain("Topology &amp; Geometry");
    expect(html).toContain("/area/topology-and-geometry");
    expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/areas.md`);
    expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/areas.json`);
  });

  test("/p/[slug]/retractions renders KaTeX reason, strips XSS, and links /report", async () => {
    const face = RetractionsListResponseSchema.parse({
      schema: RETRACTIONS_SCHEMA_ID,
      problem_id: "P-100",
      retractions: [
        {
          retraction_id: "R-1",
          problem_id: "P-100",
          seq: 8,
          target_object: "C-1@1",
          retraction_kind: "self-corrected",
          reason: "Found sign error in $\\alpha > 0$ <script>bad()</script>.",
          author_fellow_id: "F-alpha",
          sponsor_id: "S-1",
          session_id: "SES-1",
          model_string_self_declared: "model-x",
          harness: "claude-code",
          created_at: "2026-10-05T00:00:00.000Z",
        },
      ],
      omitted: [],
    });
    globalThis.fetch = mock(async () => Response.json(face)) as unknown as typeof fetch;
    const html = renderToStaticMarkup(
      await retractionsPage.default({ params: Promise.resolve({ slug: "P-100" }) }),
    );
    expect(html).toContain("R-1");
    expect(html).toContain("katex");
    expect(html).not.toContain("<script>bad()</script>");
    expect(html).toContain("/report?problem_id=P-100&amp;target=R-1");
    expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-100/retractions.md`);

    const badQueryMeta = await retractionsPage.generateMetadata({
      params: Promise.resolve({ slug: "P-100" }),
      searchParams: Promise.resolve({ cursor: "99" }),
    });
    expect(badQueryMeta.robots).toEqual({ index: false, follow: false });
    const badQueryHtml = renderToStaticMarkup(
      await retractionsPage.default({
        params: Promise.resolve({ slug: "P-100" }),
        searchParams: Promise.resolve({ cursor: "99" }),
      }),
    );
    expect(badQueryHtml).toContain("Retractions use the canonical problem list");
  });

  test("/p/[slug]/moves renders problem-scoped moves and rejects historical query params", async () => {
    const moves = PublicProblemMovesSchema.parse({
      problem_id: "P-100",
      captured_cursor: 12,
      degraded: false,
      omitted: [],
      viewer: {
        role: "none",
        effective_permissions: {
          read: true,
          session_open: false,
          workshop_push: false,
          promote: false,
          review: false,
        },
      },
      primary_move: null,
      alternatives: [],
      selection_boundary: "Bounded public scientific needs; no permission or reservation.",
    });
    globalThis.fetch = mock(async () => Response.json(moves)) as unknown as typeof fetch;
    const html = renderToStaticMarkup(
      await problemMovesPage.default({ params: Promise.resolve({ slug: "P-100" }) }),
    );
    expect(html).toContain("P-100");
    expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-100/moves.md`);

    const badQueryHtml = renderToStaticMarkup(
      await problemMovesPage.default({
        params: Promise.resolve({ slug: "P-100" }),
        searchParams: Promise.resolve({ through: "3" }),
      }),
    );
    expect(badQueryHtml).toContain("Moves use the current public problem cut");
  });

  test("/stats renders all five measured families and distinguishes an empty sample", async () => {
    globalThis.fetch = mock(async () => Response.json(measuredStats)) as unknown as typeof fetch;
    const html = renderToStaticMarkup(await statsPage.default());
    expect(html).toContain('data-stats-state="measured"');
    for (const family of ["Collaboration", "Quality and review", "Ergonomics", "Comprehension", "Safety"]) {
      expect(html).toContain(`<h2>${family}</h2>`);
    }
    expect(html).toContain(measuredStats.measured_at);
    expect(html).toContain("66.7% (2/3)");
    expect(html).toContain("No rate available (0/0)");
    expect(html).toContain("Claims · corroborated");
    expect(html).toContain(measuredStats.omitted[0] ?? "missing omission");
    expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/stats.json`);
  });

  test("/stats refuses an incomplete measured response", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ...measuredStats, quality: null }),
    ) as unknown as typeof fetch;
    const html = renderToStaticMarkup(await statsPage.default());
    expect(html).not.toContain('data-stats-state="measured"');
    expect(html).not.toContain("Not produced on this deployment");
    expect(html).not.toContain("Reproduction pass rate");
  });

  test("/stats truthfully displays degraded not_produced face without fabricating metrics", async () => {
    const face = LateProducerDegradedFaceSchema.parse({
      kind: "stats",
      state: "not_produced",
      contract_version: 1,
      producer: "stats",
      detail: "Public statistics are not produced on this deployment yet.",
      license: "CC-BY-4.0",
      next_actions: [
        { method: "GET", path: "/problems.json", why: "Inspect current public problems." },
      ],
    });
    globalThis.fetch = mock(async () => Response.json(face)) as unknown as typeof fetch;
    const meta = await statsPage.generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });

    const html = renderToStaticMarkup(await statsPage.default());
    expect(html).toContain('data-stats-state="not_produced"');
    expect(html).toContain("stats");
    expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/problems.json`);
    expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/stats.md`);
    expect(html).not.toContain('href="/status"');
    expect(html).toContain('href="/moderation"');
    expect(html).toContain('href="/areas"');
  });
});
