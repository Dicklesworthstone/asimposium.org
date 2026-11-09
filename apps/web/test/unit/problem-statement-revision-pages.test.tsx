import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type {
  ProblemStatementProposalListResponse,
  ProblemStatementRevisionPreview,
} from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoaCall } from "../../lib/stoa";
import {
  revisionId,
  revisionPage,
  revisionPreview,
  revisionProblem,
  revisionSponsor,
} from "../fixtures/problem-statement-revision";

mock.module("server-only", () => ({}));
let principal: string | null;
let listResult: StoaCall<ProblemStatementProposalListResponse>;
let previewResult: StoaCall<ProblemStatementRevisionPreview>;
const listReads: unknown[][] = [];
const previewReads: unknown[][] = [];
let realAuth: typeof import("../../auth");
let realProposals: typeof import("../../lib/problem-statement-proposals");
let list: typeof import("../../app/console/problems/[problem]/revisions/page");
let detail: typeof import("../../app/console/problems/[problem]/revisions/[proposal]/page");
beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realProposals = { ...(await import("../../lib/problem-statement-proposals")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => (principal === null ? null : { user: { id: principal } }),
    signIn: async () => {},
  }));
  mock.module("@/lib/problem-statement-proposals", () => ({
    ...realProposals,
    stoaStatementProposals: async (...args: unknown[]) => {
      listReads.push(args);
      return listResult;
    },
    stoaStatementRevisionPreview: async (...args: unknown[]) => {
      previewReads.push(args);
      return previewResult;
    },
  }));
  list = await import("../../app/console/problems/[problem]/revisions/page");
  detail = await import("../../app/console/problems/[problem]/revisions/[proposal]/page");
});
beforeEach(() => {
  principal = revisionSponsor;
  listResult = { ok: true, data: revisionPage };
  previewResult = { ok: true, data: revisionPreview };
  listReads.length = 0;
  previewReads.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/problem-statement-proposals", () => realProposals);
});
const renderList = async (
  problem = revisionProblem,
  query: Record<string, string | string[] | undefined> = {},
) =>
  renderToStaticMarkup(
    await list.default({
      params: Promise.resolve({ problem }),
      searchParams: Promise.resolve(query),
    }),
  );
const renderDetail = async (
  problem = revisionProblem,
  proposal = revisionId,
  query: Record<string, string | string[] | undefined> = {},
) =>
  renderToStaticMarkup(
    await detail.default({
      params: Promise.resolve({ problem, proposal }),
      searchParams: Promise.resolve(query),
    }),
  );

test("the review page server-renders every exact field and Fellow attribution without scientific editors", async () => {
  const html = await renderDetail();
  for (const marker of [
    "PRIVATE_REVISION_STATEMENT",
    "PRIVATE_REVISION_FALSIFIER",
    "PRIVATE_REVISION_MOTIVATION",
    "PRIVATE_REVISION_SCOPE",
    "PRIVATE_REVISION_EXCLUSIONS",
    "PRIVATE_REVISION_SUCCESS",
    revisionPreview.proposal.author.fellow_id,
    revisionPreview.proposal.author.sponsor_id,
    revisionPreview.proposal.author.session_id,
    "fixture/research-model",
    "fixture-harness",
    "self-declared",
  ])
    expect(html).toContain(marker);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>untrusted");
  expect(html).toContain("&lt;img src=x onerror=unsafe()&gt;");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain('name="statement"');
  expect(html).toContain('name="confirm_statement_revision"');
  expect(html).toContain("Accept as statement S@4");
  expect(html).toContain(`/p/${revisionProblem}/statements/3`);
  expect(previewReads).toEqual([[revisionSponsor, revisionProblem, revisionId]]);
  expect(detail.dynamic).toBe("force-dynamic");
  expect(detail.metadata.robots).toEqual({ index: false, follow: false });
  expect(JSON.stringify(detail.metadata)).not.toContain("Finite paths");
});

test("private, accepted and stale proposals do not imply public disclosure or a fresh acceptance", async () => {
  previewResult = {
    ok: true,
    data: { ...revisionPreview, problem: { ...revisionPreview.problem, status: "private-draft" } },
  };
  const privateHtml = await renderDetail();
  expect(privateHtml).toContain("The revised draft remains private");
  expect(privateHtml).not.toContain(`/p/${revisionProblem}/statements/3`);
  for (const data of [
    {
      ...revisionPreview,
      can_accept: false,
      problem: { ...revisionPreview.problem, current_statement_version: 5 },
    },
    {
      ...revisionPreview,
      can_accept: false,
      proposal: {
        ...revisionPreview.proposal,
        status: "accepted" as const,
        accepted_statement_version: 4,
      },
    },
  ]) {
    previewResult = { ok: true, data };
    const html = await renderDetail();
    expect(html).not.toContain('name="confirm_statement_revision"');
    expect(html).not.toContain("Accept as statement S@");
    expect(html).toContain("No new acceptance is offered");
    expect(html).toContain("PRIVATE_REVISION_STATEMENT");
  }
});

test("missing current detail retains a metadata-only recovery surface without showing private content", async () => {
  previewResult = { ok: false, reason: "refused", status: 404, detail: "PRIVATE_TRANSPORT_TEXT" };
  const html = await renderDetail();
  expect(html).toContain("Exact proposal unavailable");
  expect(html).toContain("previously retained acceptance can still be recovered");
  expect(html).not.toContain("PRIVATE_REVISION");
  expect(html).not.toContain("PRIVATE_TRANSPORT_TEXT");
  expect(html).not.toContain('name="confirm_statement_revision"');
});

test("private lists are bounded choices with exact review URLs and honest pagination", async () => {
  listResult = {
    ok: true,
    data: { ...revisionPage, next_after: revisionId, omitted: ["page_limit"] },
  };
  const after = "SPR-02345678-1234-1234-1234-123456789abc";
  const html = await renderList(revisionProblem, { after });
  expect(html).toContain(`/console/problems/${revisionProblem}/revisions/${revisionId}`);
  expect(html).toContain(`?after=${revisionId}`);
  expect(html).toContain("More proposals remain");
  expect(html).not.toContain("PRIVATE_REVISION_STATEMENT");
  expect(listReads).toEqual([[revisionSponsor, revisionProblem, { after }]]);
  expect(list.dynamic).toBe("force-dynamic");
  expect(list.metadata.robots).toEqual({ index: false, follow: false });
});

test("anonymous, wrong-principal and malformed routes never request private candidate bytes", async () => {
  for (const account of [null, "person@example.invalid"]) {
    principal = account;
    expect(await renderList()).toContain("Sign in with Google");
    expect(await renderDetail()).toContain("Sign in with Google");
  }
  principal = revisionSponsor;
  for (const [problem, proposal, query] of [
    ["P-X\n", revisionId, {}],
    [revisionProblem, `${revisionId}\n`, {}],
    [revisionProblem, revisionId, { sponsor: revisionSponsor }],
  ] as const)
    expect(await renderDetail(problem, proposal, query)).not.toContain("PRIVATE_REVISION");
  for (const query of [
    { after: [revisionId, revisionId] },
    { after: `${revisionId}\n` },
    { extra: "1" },
  ])
    expect(await renderList(revisionProblem, query)).not.toContain(
      revisionPreview.proposal.author.fellow_id,
    );
  expect(listReads).toHaveLength(0);
  expect(previewReads).toHaveLength(0);
});
