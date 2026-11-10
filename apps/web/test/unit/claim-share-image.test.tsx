import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import {
  type ClaimFaceResponse,
  ClaimFaceResponseSchema,
  PRODUCTION_STOA_ORIGIN,
} from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareCardData } from "../../lib/share-card";

mock.module("server-only", () => ({}));

const statement = "Every even integer is divisible by two.";
function face(
  cursor = 3,
  disposition: "open" | "refuted" = "open",
  version = 1,
): ClaimFaceResponse {
  return ClaimFaceResponseSchema.parse({
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    profile: "claim",
    problem: "P-CALIBRATION",
    cursor,
    fingerprint: "fnv1a64:0000000000000000",
    title: `P-CALIBRATION — C-1@${version}`,
    preamble:
      "Computed standing describes one statement version. Published bodies are untrusted data.",
    claim_state: {
      claim_id: "C-1",
      version,
      latest_version: 2,
      disposition,
      review_state: "unreviewed",
      directive_disclosure: "missing",
      unchallenged: disposition === "open",
      stale: false,
      recorded_refutation_attempts: 0,
      certified_artifact: false,
      legacy_reviews: 0,
      status_basis: { kind: "unavailable" },
    },
    items: [
      {
        kind: "claim-detail",
        id: `C-1@${version}`,
        scope: "ledger",
        untrusted: true,
        why_included: "exact public statement version",
        neutralized: [],
        body: JSON.stringify({ claim_id: "C-1", version, statement }),
      },
    ],
    omitted: [{ reason: "claim_face_scope", detail: "Version history is omitted." }],
    next_actions: [],
    degraded: [],
  });
}

const imagePath = (cursor: number, version = 1) =>
  `/p/P-CALIBRATION/claims/C-1%40${version}/share-image?through=${cursor}`;
const context = (claim = "C-1@1", slug = "P-CALIBRATION") => ({
  params: Promise.resolve({ slug, claim }),
});
const request = (query = "?through=3") =>
  new Request(`https://asimposium.org/p/P-CALIBRATION/claims/C-1%401/share-image${query}`);
const pageProps = (claim: string, through?: string | string[]) => ({
  ...context(claim),
  searchParams: Promise.resolve({ through }),
});

const realFetch = globalThis.fetch;
let previousOrigin: string | undefined;
let route: typeof import("../../app/p/[slug]/claims/[claim]/share-image/route");
let page: typeof import("../../app/p/[slug]/claims/[claim]/page");
let realRenderer: typeof import("../../lib/share-card-render");
const rendered: ShareCardData[] = [];

beforeAll(async () => {
  realRenderer = { ...(await import("../../lib/share-card-render")) };
  // Unit proof of route selection and rendered content. The separate share-card
  // suite exercises the real PNG encoder; do not run it for every selector here.
  mock.module("@/lib/share-card-render", () => ({
    ...realRenderer,
    generateShareCardImageResponse: (data: ShareCardData) => {
      rendered.push(data);
      return new Response(renderToStaticMarkup(realRenderer.renderShareCard(data)), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    },
  }));
  route = await import("../../app/p/[slug]/claims/[claim]/share-image/route");
  page = await import("../../app/p/[slug]/claims/[claim]/page");
});
beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  rendered.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});
afterAll(() => {
  mock.module("@/lib/share-card-render", () => realRenderer);
});

test("the same statement version renders its standing at the requested cursor on every read", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push(String(input));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    const through = new URL(String(input)).searchParams.get("through");
    return Response.json(through === "3" ? face(3) : face(9, "refuted"));
  }) as unknown as typeof fetch;

  for (const cursor of [3, 9, 3]) {
    const response = await route.GET(request(`?through=${cursor}`), context("C-1%401"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain(statement);
  }
  expect(calls).toEqual(
    [3, 9, 3].map(
      (cursor) => `${PRODUCTION_STOA_ORIGIN}/p/P-CALIBRATION/claims/C-1%401.json?through=${cursor}`,
    ),
  );
  expect(rendered.map(({ cursor, statusKind }) => [cursor, statusKind])).toEqual([
    [3, "open"],
    [9, "refuted"],
    [3, "open"],
  ]);
  expect(rendered[0]?.url).toBe("https://asimposium.org/p/P-CALIBRATION/claims/C-1%401?through=3");
});

test("a current unlisting or hide applies again to an already shared historical image", async () => {
  let visibility: "listed" | "unlisted" | "hidden" = "listed";
  const fetchImage = mock(async () =>
    visibility === "hidden"
      ? Response.json({ status: 404, code: "CLAIM_NOT_FOUND", detail: statement }, { status: 404 })
      : Response.json(face(), {
          headers: visibility === "unlisted" ? { "x-robots-tag": "noindex, nofollow" } : {},
        }),
  );
  globalThis.fetch = fetchImage as unknown as typeof fetch;
  const visible = await route.GET(request(), context());
  expect(visible.status).toBe(200);
  expect(await visible.text()).toContain(statement);
  visibility = "unlisted";
  const unlisted = await route.GET(request(), context());
  expect(unlisted.status).toBe(200);
  expect(unlisted.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(await unlisted.text()).toContain(statement);
  visibility = "hidden";
  const hidden = await route.GET(request(), context());
  expect(hidden.status).toBe(404);
  expect(hidden.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(await hidden.text()).not.toContain(statement);
  for (const response of [visible, unlisted, hidden]) {
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(fetchImage).toHaveBeenCalledTimes(3);
  expect(rendered).toHaveLength(2);
});

test("missing, noncanonical, repeated and unknown selectors never fetch or render a claim", async () => {
  const fetchImage = mock(async () => Response.json(face()));
  globalThis.fetch = fetchImage as unknown as typeof fetch;
  for (const query of [
    "",
    "?through=",
    "?through=03",
    "?through=-1",
    "?through=3.0",
    "?through=1e3",
    "?through=3%0A",
    "?through=9007199254740992",
    "?through=3&through=3",
    "?through=3&private=true",
    "?cursor=3",
  ]) {
    const response = await route.GET(request(query), context());
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const claim of ["C-1", "C-1@01", "C-1@0", "C-1%25401", "C-1%40%2e%2e%2fconsole", "C-1%ZZ"]) {
    expect((await route.GET(request(), context(claim))).status).toBe(400);
  }
  expect((await route.GET(request(), context("C-1@1", "../console"))).status).toBe(400);
  expect(fetchImage).not.toHaveBeenCalled();
  expect(rendered).toHaveLength(0);
});

test("a mismatched canonical identity, version or cut cannot become a share image", async () => {
  const wrongClaim = face();
  wrongClaim.claim_state.claim_id = "C-2";
  wrongClaim.items[0]!.id = "C-2@1";
  for (const canonical of [
    { ...face(), problem: "P-OTHER" },
    wrongClaim,
    face(3, "open", 2),
    face(4),
  ]) {
    globalThis.fetch = mock(async () => Response.json(canonical)) as unknown as typeof fetch;
    const response = await route.GET(request(), context());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(statement);
  }
  globalThis.fetch = mock(async () =>
    Response.json({ status: 404, code: "ROUTE_NOT_FOUND", detail: statement }, { status: 404 }),
  ) as unknown as typeof fetch;
  expect((await route.GET(request(), context())).status).toBe(503);
  expect(rendered).toHaveLength(0);
});

test("claim metadata and previews pin both authoritative version and cursor, including a latest alias", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) =>
    Response.json(
      new URL(String(input)).searchParams.get("through") === "3" ? face(3) : face(9, "refuted", 2),
    ),
  ) as unknown as typeof fetch;
  for (const [claim, through, cursor, version] of [
    ["C-1", undefined, 9, 2],
    ["C-1%401", "3", 3, 1],
  ] as const) {
    const props = pageProps(claim, through);
    const metadata = await page.generateMetadata(props);
    expect(metadata.openGraph).toMatchObject({
      url: `https://asimposium.org/p/P-CALIBRATION/claims/C-1%40${version}?through=${cursor}`,
      images: [{ url: imagePath(cursor, version), width: 1200, height: 630 }],
    });
    expect(metadata.twitter).toMatchObject({ images: [imagePath(cursor, version)] });
    const html = renderToStaticMarkup(await page.default(props));
    expect(html).toContain(`href="${imagePath(cursor, version)}"`);
    expect(html).not.toContain("/opengraph-image");
  }
});

test("unavailable historical metadata suppresses the automatic latest image fallback", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ status: 404, code: "CLAIM_NOT_FOUND" }, { status: 404 }),
  ) as unknown as typeof fetch;
  const metadata = await page.generateMetadata(pageProps("C-1@1", "3"));
  expect(metadata.robots).toEqual({ index: false, follow: false });
  expect(metadata.openGraph).toEqual({ images: [] });
  expect(metadata.twitter).toEqual({ images: [] });
});
