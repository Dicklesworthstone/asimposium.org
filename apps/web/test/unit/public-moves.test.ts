import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  generateMoveTemplatesDocument,
  PRODUCTION_STOA_ORIGIN,
  type PublicMovesResponse,
} from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));
const { stoaFetchPublicMoves } = await import("../../lib/public-ledger.ts");
const { default: MovesPage, generateMetadata } = await import("../../app/moves/page.tsx");
const { default: config } = await import("../../next.config.ts");
const originalFetch = globalThis.fetch;
function mockFetch(
  implementation: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(mock(implementation), { preconnect: originalFetch.preconnect });
}
let previousOrigin: string | undefined;
beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});

function face(): PublicMovesResponse {
  return {
    ...generateMoveTemplatesDocument(),
    discovery: {
      scope: "public-needs",
      scanned: 4,
      next_after: "P-DD",
      degraded: false,
      omitted: [],
      selection_boundary:
        "Four listed working problems; scientific priority applies within this sample.",
      problems: ["P-DD", "P-AA", "P-BB", "P-CC"].map((problem_id) => ({
        problem_id,
        captured_cursor: 20,
        primary_move: null,
        alternatives: [],
        degraded: false,
        omitted: [],
        selection_boundary: "No current need within these bounds.",
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
      })),
    },
  };
}

test("Agora scientific needs use one anonymous uncached trusted-origin JSON boundary", async () => {
  const requests: [string, RequestInit | undefined][] = [];
  globalThis.fetch = mockFetch(async (input, init) => {
    requests.push([String(input), init]);
    return Response.json(face());
  });
  const result = await stoaFetchPublicMoves({ after: "P-00" });
  expect(result.state).toBe("ok");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/moves.json?after=P-00`);
  expect(requests[0]?.[1]).toMatchObject({
    method: "GET",
    credentials: "omit",
    redirect: "error",
    next: { revalidate: 0 },
  });
  expect(new Headers(requests[0]?.[1]?.headers).get("authorization")).toBeNull();
  expect((await stoaFetchPublicMoves({}, "https://untrusted.invalid")).state).toBe("unavailable");
  expect(requests).toHaveLength(1);
});

test("Agora needs have read-only server-rendered pagination and canonical face links", async () => {
  globalThis.fetch = mockFetch(async () => Response.json(face()));
  const html = renderToStaticMarkup(
    await MovesPage({ searchParams: Promise.resolve({ after: "P-00" }) }),
  );
  expect(html).toContain("Current scientific needs");
  expect(html).toContain('href="/moves?after=P-DD"');
  expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/moves.md?after=P-00`);
  expect(html).toContain(`${PRODUCTION_STOA_ORIGIN}/moves.json?after=P-00`);
  expect(html).toContain("grants no write permission");
  expect(html).not.toContain('<form method="post"');
  const redirects = await config.redirects?.();
  expect(redirects?.some((route) => route.source === "/moves")).toBe(false);
  expect(redirects?.find((route) => route.source === "/moves.json")?.destination).toBe(
    `${PRODUCTION_STOA_ORIGIN}/moves.json`,
  );
  expect(redirects?.find((route) => route.source === "/moves.md")?.destination).toBe(
    `${PRODUCTION_STOA_ORIGIN}/moves.md`,
  );
});

test("old catalog-only deployments, invalid pages and upstream failure do not become empty success", async () => {
  globalThis.fetch = mockFetch(async () => Response.json(generateMoveTemplatesDocument()));
  expect((await stoaFetchPublicMoves()).state).toBe("unavailable");
  const invalidPage = face();
  invalidPage.discovery.next_after = "P-AA";
  globalThis.fetch = mockFetch(async () => Response.json(invalidPage));
  expect((await stoaFetchPublicMoves()).state).toBe("unavailable");
  globalThis.fetch = mockFetch(async () => new Response("unavailable", { status: 503 }));
  const html = renderToStaticMarkup(await MovesPage({}));
  expect(html).toContain("Public ledger data is temporarily unavailable");
  expect(html).not.toContain("No listed working problems remain");
  expect(await generateMetadata({})).toMatchObject({ robots: { index: false, follow: false } });
  const badQuery = renderToStaticMarkup(
    await MovesPage({ searchParams: Promise.resolve({ after: ["P-AA", "P-BB"] }) }),
  );
  expect(badQuery).toContain("Restart scientific-needs discovery");
});
