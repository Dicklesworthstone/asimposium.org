import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProblemPublicationPreview } from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa";
import { publicationPreview, publicationProblem, publicationSponsor } from "../fixtures/problem-publication";

mock.module("server-only", () => ({}));
let identity: string | null;
let readResult: StoaCall<ProblemPublicationPreview>;
let failRead: boolean;
const reads: unknown[][] = [];
let realStoa: typeof import("../../lib/stoa");
let realAuth: typeof import("../../auth");
let realNavigation: typeof import("next/navigation");
let page: typeof import("../../app/console/problems/[problem]/page");
let cards: typeof import("../../app/console/problem-card");

beforeAll(async () => {
  realStoa = { ...(await import("../../lib/stoa")) };
  realAuth = { ...(await import("../../auth")) };
  realNavigation = { ...(await import("next/navigation")) };
  mock.module("@/auth", () => ({ ...realAuth,
    auth: async () => identity === null ? null : { user: { id: identity } },
    signIn: async () => {},
  }));
  mock.module("@/lib/stoa", () => ({ ...realStoa,
    stoaProblemPublicationPreview: async (...args: unknown[]) => {
      reads.push(args);
      if (failRead) throw new Error("PRIVATE_TRANSPORT_FAILURE");
      return readResult;
    },
  }));
  mock.module("next/navigation", () => ({ ...realNavigation, useRouter: () => ({ refresh() {} }) }));
  page = await import("../../app/console/problems/[problem]/page");
  cards = await import("../../app/console/problem-card");
});
beforeEach(() => {
  identity = publicationSponsor;
  readResult = { ok: true, data: publicationPreview };
  failRead = false;
  reads.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/stoa", () => realStoa);
  mock.module("next/navigation", () => realNavigation);
});

async function render(problem = publicationProblem, query: Record<string, string | string[]> = {}) {
  return renderToStaticMarkup(await page.default({ params: Promise.resolve({ problem }), searchParams: Promise.resolve(query) }));
}

test("the private review server-renders all formulation fields, rights and actual authorship", async () => {
  const html = await render();
  for (const marker of ["PRIVATE_STATEMENT", "PRIVATE_FALSIFIER", "PRIVATE_MOTIVATION",
    "PRIVATE_CANONICAL", "PRIVATE_VARIANT", "PRIVATE_REFERENCE", "PRIVATE_BOUNDARY"]) {
    expect(html).toContain(marker);
  }
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("fixture/model");
  expect(html).toContain("fixture-harness");
  expect(html).toContain("self-declared");
  expect(html).toContain("No proposal session was recorded");
  expect(html).toContain("Acting publication sponsor");
  expect(html).toContain("Unlisted is not private");
  expect(html).toContain("approval-required");
  expect(html).toContain("CC BY 4.0");
  expect(html).toContain("patent deadlines");
  expect(html).toContain("independent statement review");
  expect(html).toContain('name="confirm_publication"');
  expect(html).toContain("Publish reviewed statement");
  expect(html).not.toContain('name="statement"');
  expect(reads).toEqual([[publicationSponsor, publicationProblem]]);
  expect(page.dynamic).toBe("force-dynamic");
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
  expect(JSON.stringify(page.metadata)).not.toContain("Private finite paths");
});

test("signed-out and noncanonical identities never load or render private formulations", async () => {
  for (const principal of [null, "someone@example.invalid"]) {
    identity = principal;
    const html = await render();
    expect(html).toContain("Sign in to review the private formulation");
    expect(html).not.toContain("PRIVATE_STATEMENT");
    expect(html).not.toContain("private-reviewer");
    expect(html).not.toContain("Publish reviewed statement");
  }
  expect(reads).toHaveLength(0);
});

test("invalid IDs and extra query parameters never initiate a private read", async () => {
  for (const [problem, query] of [
    ["../private", {}], ["P-REVIEW\n", {}],
    [publicationProblem, { sponsor: "usr_fedcba0987654321" }],
    [publicationProblem, { version: ["1", "2"] }],
  ] as const) {
    const html = await render(problem, query as Record<string, string | string[]>);
    expect(html).toContain("Choose an adopted private problem");
    expect(html).not.toContain("PRIVATE_STATEMENT");
  }
  expect(reads).toHaveLength(0);
});

test("unavailable and unauthorized previews do not render stale content or publication controls", async () => {
  for (const result of [
    { ok: false, reason: "refused", status: 404 },
    { ok: false, reason: "refused", status: 403 },
    { ok: false, reason: "unconfigured" }, { ok: false, reason: "unreachable" },
  ] as const) {
    readResult = result;
    const html = await render();
    expect(html).toContain("Publication review unavailable");
    expect(html).not.toContain("PRIVATE_STATEMENT");
    expect(html).not.toContain("Publish reviewed statement");
  }
  failRead = true;
  expect(await render()).not.toContain("PRIVATE_TRANSPORT_FAILURE");
});

test("the console leads to inspection instead of asking for blind publication consent", () => {
  const html = renderToStaticMarkup(<cards.ProblemManager fellows={[]} briefs={[]} configured problems={[{
    id: publicationProblem, title: publicationPreview.problem.title, status: "private-draft",
    unlisted: true, created_by_fellow_id: publicationPreview.author.fellow_id,
    current_statement_version: 2, created_at: "2026-10-26T12:00:00.000Z", updated_at: "2026-10-26T12:00:00.000Z",
  }]} />);
  expect(html).toContain(`/console/problems/${publicationProblem}`);
  expect(html).toContain("Review the complete formulation");
  expect(html).not.toContain("I have read the exact formulation");
  expect(html).not.toContain("PRIVATE_STATEMENT");
});
