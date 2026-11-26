import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { type ClaimFaceResponse, type DeadEndsListResponse, type HypothesisEvidenceItemResponse, type RetractionsListResponse, PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePublicRecord, resolvePublicRecord } from "../../lib/public-record";

mock.module("server-only", () => ({}));
const { stoaFetchDeadEnds, stoaFetchPublicRecord, stoaFetchRetractions } = await import("../../lib/public-ledger");
const { default: PublicRecordPage, generateMetadata } = await import("../../app/r/[...slug]/page");
const { default: DeadEndsPage, generateMetadata: deadEndsMetadata } = await import("../../app/p/[slug]/dead-ends/page");

const { default: RetractionsPage, generateMetadata: retractionsMetadata } = await import("../../app/p/[slug]/retractions/page");

function retractionFace(): RetractionsListResponse {
  return {
    schema: "https://a.asimposium.org/schemas/retractions.v1.json",
    problem_id: "P-DEMO", cursor: 80, after: 0, scanned_through: 80,
    next_after: null, target: "R-55",
    retractions: [{
      retraction_id: "R-55", problem_id: "P-DEMO", seq: 72,
      target_object: "C-7@3", retraction_kind: "self-corrected",
      reason: "The exact statement omitted a boundary condition.",
      author_fellow_id: "F-AUTHOR", created_at: "2026-10-18T12:00:00.000Z",
    }],
    omitted: [],
  };
}

function deadEnd(): DeadEndsListResponse {
  return {
    schema: "https://a.asimposium.org/schemas/dead-ends.v1.json",
    problem_id: "P-DEMO",
    dead_ends: [{
      dead_end_id: "DE-7", problem_id: "P-DEMO", seq: 12,
      approach: "Enumerate every finite boundary case.",
      why_it_fails: "The proposed bound omits an admissible case.",
      retry_predicate: "Revisit after a justified bound is established.",
      author_fellow_id: "F-AUTHOR", created_at: "2026-10-18T12:00:00.000Z",
      superseded_by: "DE-19",
    }],
    omitted: ["Other dead ends are omitted from this exact-target view."],
  };
}

function evidence(): HypothesisEvidenceItemResponse {
  return {
    schema: "asimposium.hypothesis-evidence.v1", problem_id: "P-DEMO", cursor: 19,
    evidence_id: "E-7", bears_on: { kind: "hypothesis", id: "H-3" }, withdrawn: false,
    publication: {
      event_id: "EV-12", seq: 12, created_at: "2026-10-18T12:00:00.000Z", payload_sha256: "a".repeat(64),
      fellow_id: "F-AUTHOR", sponsor_id: "usr_sponsor", session_id: "SES-PUBLIC",
      model_self_declared: "Declared model", harness_self_declared: "Declared harness",
    },
    content: {
      bears_on_kind: "hypothesis", bears_on_id: "H-3", direction: "refutes", kind: "argument",
      source: { kind: "locator", locator: "https://example.test/refutation", excerpt: "A negative boundary value." },
      mode: "exploratory", body_md: "The boundary contradicts the predicted positivity.",
    },
    computed: { computed_class: "assertion", coercion_flags: [], drives_promotion: false },
    omitted: ["item_face_scope"],
  };
}

function claimEvidence(): ClaimFaceResponse {
  return {
    schema: "asimposium.claim-face.v1", face: "json", kind: "claim-face", profile: "claim",
    problem: "P-DEMO", cursor: 23, fingerprint: "fnv1a64:0000000000000007",
    title: "P-DEMO — E-7 on C-2@1", preamble: "Exact claim version and filed evidence. Current content visibility applies.",
    claim_state: { claim_id: "C-2", version: 1, latest_version: 2, disposition: "open", review_state: "unreviewed", directive_disclosure: "missing", unchallenged: true, stale: true, recorded_refutation_attempts: 0, certified_artifact: false, legacy_reviews: 0 },
    items: [
      { kind: "claim-detail", id: "C-2@1", scope: "ledger", untrusted: true, why_included: "Exact statement", body: "The original claim statement.", neutralized: [] },
      { kind: "claim-evidence", id: "E-7", scope: "ledger", untrusted: true, why_included: "Requested evidence", body: "An already neutralized evidence body.", neutralized: [{ marker: "active-html", count: 1 }] },
    ],
    omitted: [{ reason: "item_face_scope", detail: "Only this evidence and its exact claim statement are shown." }],
    next_actions: [{ method: "GET", url: "/p/P-DEMO/claims/C-2@1.json", why: "Read the exact claim" }],
    degraded: ["One older attribution record is unavailable."],
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

const props = () => ({ params: Promise.resolve({ slug: ["p", "P-DEMO", "evidence", "E-7"] }) });
const target = () => {
  const value = resolvePublicRecord(["p", "P-DEMO", "evidence", "E-7"]);
  if (value === null) throw new Error("Expected a registered evidence target");
  return value;
};

test("the registered human evidence route renders real scientific content with exact agent links", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push(String(input));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(evidence());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await PublicRecordPage(props()));
  for (const text of ["Published scientific body", "The boundary contradicts", "Source excerpt", "EV-12", "F-AUTHOR", "Declared model", "Current public read through ledger cursor", 'data-cursor="19"']) expect(html).toContain(text);
  expect(html).toContain(`href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/evidence/E-7.json"`);
  expect(html).toContain(`href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/evidence/E-7.md"`);
  expect(html).not.toContain("Items (0)");
  expect(html).not.toContain("View canonical HTML fragment");
  expect(html).not.toContain("GLOBAL");
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/evidence/E-7.json`]);
});

test("the evidence reader binds both problem and evidence identity and refuses invented envelopes", async () => {
  for (const patch of [{ problem_id: "P-OTHER" }, { evidence_id: "E-8" }, { cursor: 0 }, { computed: null }]) {
    globalThis.fetch = mock(async () => Response.json({ ...evidence(), ...patch })) as unknown as typeof fetch;
    expect(await stoaFetchPublicRecord(target())).toEqual({ state: "unavailable", reason: "invalid_response" });
  }
  for (const value of ["some text", [], { body_md: "A body without a scientific envelope" }]) {
    expect(parsePublicRecord(value, target())).toBeNull();
  }
});

test("current withdrawal and noindex come from the source without a cached older body", async () => {
  let record = evidence();
  globalThis.fetch = mock(async () => Response.json(record, { headers: { "x-robots-tag": "noindex, nofollow" } })) as unknown as typeof fetch;
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  const initial = renderToStaticMarkup(await PublicRecordPage(props()));
  expect(initial).toContain("stay out of search indexes");
  expect(initial).toContain("<strong>not recorded</strong>");
  record = { ...record, cursor: 24, withdrawn: true, content: null, computed: null, omitted: ["item_face_scope", "content_unavailable"] };
  const withdrawn = renderToStaticMarkup(await PublicRecordPage(props()));
  expect(withdrawn).toContain("<strong>withdrawn</strong>");
  expect(withdrawn).toContain("Content unavailable");
  expect(withdrawn).toContain('data-cursor="24"');
  expect(withdrawn).not.toContain("The boundary contradicts");
});

test("unsupported history and private or malformed paths refuse before reading Stoa", async () => {
  const request = mock(async () => Response.json(evidence()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [{ through: "19" }, { through: ["19", "20"] }, { after: "0" }, { arbitrary: "value" }]) {
    const html = renderToStaticMarkup(await PublicRecordPage({ ...props(), searchParams: Promise.resolve(query) }));
    expect(html).toContain("Read the current public record");
    expect((await generateMetadata({ ...props(), searchParams: Promise.resolve(query) })).robots).toEqual({ index: false, follow: false });
  }
  for (const slug of [["v1", "sponsors", "profile"], ["p", "P-DEMO", "workshop", "W-1"], ["p", "P-DEMO", "evidence", ".."], ["p", "P-DEMO", "evidence", "E-7.json"], ["p", "P-DEMO", "evidence", "E-7?through=1"]]) {
    expect(resolvePublicRecord(slug)).toBeNull();
    await expect(PublicRecordPage({ params: Promise.resolve({ slug }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  }
  expect(request).not.toHaveBeenCalled();
});

test("registered hypothesis aliases reuse the existing human reader and preserve legitimate cuts", async () => {
  const request = mock(async () => Response.json(evidence()));
  globalThis.fetch = request as unknown as typeof fetch;
  const alias = { params: Promise.resolve({ slug: ["p", "P-DEMO", "hypotheses", "H-3"] }), searchParams: Promise.resolve({ through: "19" }) };
  try {
    await PublicRecordPage(alias);
    throw new Error("Expected a Next redirect");
  } catch (error) {
    expect((error as { digest?: string }).digest).toContain("/p/P-DEMO/hypotheses/H-3?through=19");
  }
  const invalid = renderToStaticMarkup(await PublicRecordPage({ ...alias, searchParams: Promise.resolve({ through: "019" }) }));
  expect(invalid).toContain("Invalid hypothesis cursor");
  expect(request).not.toHaveBeenCalled();
});

test("the registered dead-end alias reaches its typed reader without losing the exact target", async () => {
  const request = mock(async () => Response.json(deadEnd()));
  globalThis.fetch = request as unknown as typeof fetch;
  const alias = { params: Promise.resolve({ slug: ["p", "P-DEMO", "dead-ends", "DE-7"] }) };
  for (const query of [{}, { include_superseded: "true" }]) {
    let destination: string | undefined;
    try {
      await PublicRecordPage({ ...alias, searchParams: Promise.resolve(query) });
    } catch (error) {
      destination = (error as { digest?: string }).digest;
    }
    expect(destination).toContain("/p/P-DEMO/dead-ends?target=DE-7");
  }
  for (const query of [{ target: "DE-19" }, { through: "12" }, { include_superseded: ["true", "false"] }]) {
    const html = renderToStaticMarkup(await PublicRecordPage({ ...alias, searchParams: Promise.resolve(query) }));
    expect(html).toContain("Invalid dead-end view");
  }
  expect(request).not.toHaveBeenCalled();
});

test("an exact dead-end page requests the selected publication and preserves current supersession", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push(String(input));
    expect(options?.credentials).toBe("omit");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(deadEnd(), { headers: { "x-robots-tag": "noindex, nofollow" } });
  }) as unknown as typeof fetch;
  const selected = { params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve({ target: "DE-7" }) };
  const html = renderToStaticMarkup(await DeadEndsPage(selected));
  expect(html).toContain("Enumerate every finite boundary case.");
  expect(html).toContain("Superseded by");
  expect(html).toContain("DE-19");
  expect(html).toContain('href="/p/P-DEMO/dead-ends?target=DE-19"');
  expect(html).toContain(`href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/dead-ends.json?target=DE-7"`);
  expect(html).toContain(`href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/dead-ends.md?target=DE-7"`);
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/dead-ends.json?target=DE-7`]);
  expect((await deadEndsMetadata(selected)).robots).toEqual({ index: false, follow: false });
});

test("exact dead-end reads never replace a missing or mismatched publication with the list", async () => {
  const selected = { params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve({ target: "DE-7" }) };
  for (const rows of [[], [{ ...deadEnd().dead_ends[0]!, dead_end_id: "DE-8" }], [...deadEnd().dead_ends, { ...deadEnd().dead_ends[0]!, dead_end_id: "DE-8" }]]) {
    globalThis.fetch = mock(async () => Response.json({ ...deadEnd(), dead_ends: rows })) as unknown as typeof fetch;
    expect(await stoaFetchDeadEnds("P-DEMO", undefined, { target: "DE-7" })).toEqual({ state: "unavailable", reason: "invalid_response" });
    const html = renderToStaticMarkup(await DeadEndsPage(selected));
    expect(html).toContain("Public ledger data is temporarily unavailable");
    expect(html).toContain('action="/p/P-DEMO/dead-ends"');
    expect(html).toContain('name="target" value="DE-7"');
  }
  for (const code of ["DEAD_END_NOT_FOUND", "PROBLEM_NOT_FOUND"]) {
    globalThis.fetch = mock(async () => Response.json({ status: 404, code }, { status: 404 })) as unknown as typeof fetch;
    expect((await stoaFetchDeadEnds("P-DEMO", undefined, { target: "DE-7" })).state).toBe("not_found");
    await expect(DeadEndsPage(selected)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  }
  globalThis.fetch = mock(async () => Response.json({ status: 404, code: "ROUTE_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  expect(await stoaFetchDeadEnds("P-DEMO", undefined, { target: "DE-7" })).toEqual({ state: "unavailable", reason: "http" });
});

test("invalid or repeated dead-end selectors never silently fall back to a different view", async () => {
  const request = mock(async () => Response.json(deadEnd()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [{ target: "../../private" }, { target: ["DE-7", "DE-8"] }, { through: "12" }, { unknown: "value" }]) {
    const selected = { params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve(query) };
    const html = renderToStaticMarkup(await DeadEndsPage(selected));
    expect(html).toContain("Choose a dead-end history view");
    expect((await deadEndsMetadata(selected)).robots).toEqual({ index: false, follow: false });
  }
  expect(request).not.toHaveBeenCalled();
});

test("claim-target evidence keeps its exact statement, computed state, fingerprint and omission provenance", async () => {
  const record = claimEvidence();
  const before = JSON.stringify(record);
  globalThis.fetch = mock(async () => Response.json(record)) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await PublicRecordPage(props()));
  expect(html).toContain("The original claim statement");
  expect(html).toContain("Computed claim state");
  expect(html).toContain("&quot;stale&quot;: true");
  expect(html).toContain("fnv1a64:0000000000000007");
  expect(html).toContain("active-html×1");
  expect(html).toContain("Only this evidence and its exact claim statement");
  expect(html).toContain("One older attribution record is unavailable");
  expect(JSON.stringify(record)).toBe(before);
  record.items[1]!.id = "E-8";
  expect(parsePublicRecord(record, target())).toBeNull();
});

test("a generic claim-evidence record retains the warning on its exact claim statement", async () => {
  const record = claimEvidence();
  record.items[0]!.screening_notice = {
    category: "dual-use-boundary",
    action: "published-with-warning",
    notice: "screening-warning",
  };
  globalThis.fetch = mock(async () => Response.json(record)) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await PublicRecordPage(props()));
  expect(html).toContain("The original claim statement");
  expect(html).toContain("screening context notice: dual-use-boundary");
  expect(html).toContain("does not determine the scientific standing");
  expect(html).not.toContain("evaluated_context_digest");
});

test("a route miss stays unavailable; canonical missing objects and source failures do not become empty records", async () => {
  globalThis.fetch = mock(async () => Response.json({ status: 404, code: "ROUTE_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  const unavailable = renderToStaticMarkup(await PublicRecordPage(props()));
  expect(unavailable).toContain("Public ledger data is temporarily unavailable");
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  globalThis.fetch = mock(async () => Response.json({ status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  expect((await stoaFetchPublicRecord(target())).state).toBe("not_found");
});


test("registered correction aliases redirect to their exact snapshot without fetching a generic projection", async () => {
  const request = mock(async () => Response.json(retractionFace()));
  globalThis.fetch = request as unknown as typeof fetch;
  const alias = { params: Promise.resolve({ slug: ["p", "P-DEMO", "retractions", "R-55"] }) };
  for (const [query, destination] of [
    [{}, "/p/P-DEMO/retractions?target=R-55"],
    [{ through: "80", limit: "1" }, "/p/P-DEMO/retractions?through=80&limit=1&target=R-55"],
  ] as const) {
    let digest: string | undefined;
    try {
      await PublicRecordPage({ ...alias, searchParams: Promise.resolve(query) });
    } catch (error) {
      digest = (error as { digest?: string }).digest;
    }
    expect(digest).toContain(destination);
  }
  for (const query of [{ target: "R-1" }, { through: "80", after: "0" }, { through: ["80", "81"] }]) {
    expect(renderToStaticMarkup(await PublicRecordPage({
      ...alias, searchParams: Promise.resolve(query),
    }))).toContain("Invalid retraction view");
  }
  expect(resolvePublicRecord(["p", "P-DEMO", "retractions", "Q-1"])).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

test("exact correction pages bind the source identity and keep all canonical links at the selected cut", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push(String(input));
    expect(options?.credentials).toBe("omit");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(retractionFace(), { headers: { "x-robots-tag": "noindex, nofollow" } });
  }) as unknown as typeof fetch;
  const selected = {
    params: Promise.resolve({ slug: "P-DEMO" }),
    searchParams: Promise.resolve({ through: "80", target: "R-55" }),
  };
  const html = renderToStaticMarkup(await RetractionsPage(selected));
  expect(html).toContain("The exact statement omitted a boundary condition.");
  expect(html).toContain("Showing the exact correction R-55.");
  expect(html).toContain("stay out of search indexes");
  for (const face of ["md", "json"]) expect(html).toContain(
    `href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/retractions.${face}?through=80&amp;target=R-55"`,
  );
  expect(html).toContain('href="/p/P-DEMO/retractions?through=80"');
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/retractions.json?through=80&target=R-55`]);
  const metadata = await retractionsMetadata(selected);
  expect(metadata.robots).toEqual({ index: false, follow: false });
  expect(metadata.alternates?.canonical).toBe(
    "https://asimposium.org/p/P-DEMO/retractions?through=80&target=R-55",
  );
});

test("empty correction pages still offer the exact bounded continuation without JavaScript", async () => {
  globalThis.fetch = mock(async () => Response.json({
    ...retractionFace(), target: null, after: 12, scanned_through: 20,
    next_after: 20, retractions: [], omitted: ["page_limit"],
  })) as unknown as typeof fetch;
  const selected = {
    params: Promise.resolve({ slug: "P-DEMO" }),
    searchParams: Promise.resolve({ through: "80", after: "12", limit: "1" }),
  };
  const html = renderToStaticMarkup(await RetractionsPage(selected));
  expect(html).toContain("No readable retractions were returned on this page.");
  expect(html).toContain("More retractions in this snapshot");
  expect(html).toContain('href="/p/P-DEMO/retractions?through=80&amp;after=20&amp;limit=1"');
  expect(html.match(/aria-label="Retraction pages"/g)).toHaveLength(1);
});

test("correction pages reject wrong target, snapshot, problem and missing-source substitutions", async () => {
  const selected = {
    params: Promise.resolve({ slug: "P-DEMO" }),
    searchParams: Promise.resolve({ through: "80", target: "R-55" }),
  };
  for (const patch of [
    { problem_id: "P-OTHER" }, { target: "R-1" }, { cursor: 81, scanned_through: 81 },
    { retractions: [] },
    { retractions: [{ ...retractionFace().retractions[0]!, retraction_id: "R-1" }] },
  ]) {
    globalThis.fetch = mock(async () => Response.json({ ...retractionFace(), ...patch })) as unknown as typeof fetch;
    expect(await stoaFetchRetractions("P-DEMO", undefined, { through: "80", target: "R-55" }))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
    const html = renderToStaticMarkup(await RetractionsPage(selected));
    expect(html).toContain("Public ledger data is temporarily unavailable");
    expect(html).not.toContain("The exact statement omitted a boundary condition.");
  }
  globalThis.fetch = mock(async () => Response.json(
    { status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 },
  )) as unknown as typeof fetch;
  await expect(RetractionsPage(selected)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});

test("invalid correction selections do not fetch or silently reset the requested view", async () => {
  const request = mock(async () => Response.json(retractionFace()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { after: "0" }, { through: "80", after: "81" }, { through: "080" },
    { target: ["R-55", "R-1"] }, { target: "R-55", after: "0", through: "80" },
    { limit: "201" }, { status: "open" },
  ]) {
    const selected = { params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve(query) };
    expect(renderToStaticMarkup(await RetractionsPage(selected))).toContain("Choose a valid retraction view");
    expect((await retractionsMetadata(selected)).robots).toEqual({ index: false, follow: false });
  }
  expect(request).not.toHaveBeenCalled();
});
