import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type {
  ProblemPublicationPreview,
  SponsorProblemGovernanceResponse,
  SynthesisDraftListResponse,
  SynthesisDraftRecord,
} from "@asimposium/contracts";
import { SYNTHESES_SCHEMA_ID, type SynthesesListResponse } from "@asimposium/contracts/syntheses";
import { CLAIMS_LIST_SCHEMA_ID, type ClaimsListResponse } from "@asimposium/contracts/claims-list";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicRead } from "../../lib/public-ledger";
import type { StoaCall } from "../../lib/stoa";
import { accessWorkspace } from "../fixtures/problem-governance";
import {
  publicationPreview,
  publicationProblem,
  publicationSponsor,
} from "../fixtures/problem-publication";
import { researchSynthesis } from "../fixtures/problem-research";

mock.module("server-only", () => ({}));
let identity: string | null;
let readResult: StoaCall<ProblemPublicationPreview>;
let failRead: boolean;
let draftResult: StoaCall<SynthesisDraftListResponse>;
const draftReads: unknown[][] = [];
const publishCalls: unknown[][] = [];
const reads: unknown[][] = [];
let governanceResult: StoaCall<SponsorProblemGovernanceResponse>;
const governanceReads: unknown[][] = [];
let realStoa: typeof import("../../lib/stoa");
let realGovernance: typeof import("../../lib/problem-governance");
let realAuth: typeof import("../../auth");
let realNavigation: typeof import("next/navigation");
let realSyntheses: typeof import("../../lib/public-syntheses");
let realLedger: typeof import("../../lib/public-ledger");
let claimResult: PublicRead<ClaimsListResponse>;
const claimReads: unknown[][] = [];
let synthesisResult: PublicRead<SynthesesListResponse>;
let failSynthesisRead: boolean;
const synthesisReads: unknown[][] = [];
let page: typeof import("../../app/console/problems/[problem]/page");
let cards: typeof import("../../app/console/problem-card");

beforeAll(async () => {
  realStoa = { ...(await import("../../lib/stoa")) };
  realGovernance = { ...(await import("../../lib/problem-governance")) };
  realAuth = { ...(await import("../../auth")) };
  realNavigation = { ...(await import("next/navigation")) };
  realSyntheses = { ...(await import("../../lib/public-syntheses")) };
  realLedger = { ...(await import("../../lib/public-ledger")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => (identity === null ? null : { user: { id: identity } }),
    signIn: async () => {},
  }));
  mock.module("@/lib/stoa", () => ({
    ...realStoa,
    stoaProblemPublicationPreview: async (...args: unknown[]) => {
      reads.push(args);
      if (failRead) throw new Error("PRIVATE_TRANSPORT_FAILURE");
      return readResult;
    },
  }));
  mock.module("@/lib/problem-governance", () => ({
    ...realGovernance,
    stoaListSynthesisDrafts: async (...args: unknown[]) => {
      draftReads.push(args);
      return draftResult;
    },
    stoaPublishSynthesisDraft: async (...args: unknown[]) => {
      publishCalls.push(args);
      return { ok: false, reason: "refused", status: 403 };
    },
    stoaProblemGovernance: async (...args: unknown[]) => {
      governanceReads.push(args);
      return governanceResult;
    },
  }));
  mock.module("next/navigation", () => ({
    ...realNavigation,
    useRouter: () => ({ refresh() {} }),
  }));
  mock.module("@/lib/public-syntheses", () => ({
    ...realSyntheses,
    stoaFetchSyntheses: async (...args: unknown[]) => {
      synthesisReads.push(args);
      if (failSynthesisRead) throw new Error("PUBLIC_DISCOVERY_FAILURE");
      return synthesisResult;
    },
  }));
  mock.module("@/lib/public-ledger", () => ({ ...realLedger,
    stoaFetchClaimsList: async (...args: unknown[]) => {
      claimReads.push(args);
      return claimResult;
    },
  }));
  page = await import("../../app/console/problems/[problem]/page");
  cards = await import("../../app/console/problem-card");
});
beforeEach(() => {
  identity = publicationSponsor;
  readResult = { ok: true, data: publicationPreview };
  failRead = false;
  reads.length = 0;
  draftReads.length = 0;
  publishCalls.length = 0;
  draftResult = { ok: false, reason: "unreachable" };
  governanceResult = { ok: false, reason: "refused", status: 404 };
  governanceReads.length = 0;
  synthesisReads.length = 0;
  synthesisResult = { state: "unavailable", reason: "network" };
  failSynthesisRead = false;
  claimResult = { state: "unavailable", reason: "network" };
  claimReads.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/stoa", () => realStoa);
  mock.module("@/lib/problem-governance", () => realGovernance);
  mock.module("next/navigation", () => realNavigation);
  mock.module("@/lib/public-syntheses", () => realSyntheses);
  mock.module("@/lib/public-ledger", () => realLedger);
});

async function render(problem = publicationProblem, query: Record<string, string | string[]> = {}) {
  return renderToStaticMarkup(
    await page.default({
      params: Promise.resolve({ problem }),
      searchParams: Promise.resolve(query),
    }),
  );
}

test("the private review server-renders all formulation fields, rights and actual authorship", async () => {
  const html = await render();
  for (const marker of [
    "PRIVATE_STATEMENT",
    "PRIVATE_FALSIFIER",
    "PRIVATE_MOTIVATION",
    "PRIVATE_SCOPE",
    "PRIVATE_OUT_OF_SCOPE",
    "PRIVATE_SUCCESS_CRITERIA",
    "PRIVATE_CANONICAL",
    "PRIVATE_VARIANT",
    "PRIVATE_REFERENCE",
    "PRIVATE_BOUNDARY",
  ]) {
    expect(html).toContain(marker);
  }
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("&lt;img src=x onerror=unsafe()&gt;");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("<h2>Scope</h2>");
  expect(html).toContain("<h2>Out of scope</h2>");
  expect(html).toContain("<h2>Success criteria</h2>");
  expect(html).toContain("<h2>Exact statement</h2>");
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
  expect(governanceReads).toHaveLength(0);
  expect(synthesisReads).toHaveLength(0);
  expect(page.dynamic).toBe("force-dynamic");
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
  expect(JSON.stringify(page.metadata)).not.toContain("Private finite paths");
});

test("a legacy publication preview does not invent research boundaries", async () => {
  readResult = {
    ok: true,
    data: {
      ...publicationPreview,
      problem: {
        ...publicationPreview.problem,
        scope: undefined,
        out_of_scope: undefined,
        success_criteria: undefined,
      },
    },
  };
  const html = await render();
  expect(html).toContain("PRIVATE_STATEMENT");
  expect(html).toContain("Publish reviewed statement");
  expect(html).not.toContain("<h2>Scope</h2>");
  expect(html).not.toContain("<h2>Out of scope</h2>");
  expect(html).not.toContain("<h2>Success criteria</h2>");
  expect(html).not.toContain("PRIVATE_SCOPE");
});

test("signed-out and noncanonical identities never load or render private formulations", async () => {
  for (const principal of [null, "someone@example.invalid"]) {
    identity = principal;
    const html = await render();
    expect(html).toContain("Sign in to review the private formulation");
    expect(html).not.toContain("PRIVATE_STATEMENT");
    expect(html).not.toContain("PRIVATE_SCOPE");
    expect(html).not.toContain("PRIVATE_OUT_OF_SCOPE");
    expect(html).not.toContain("PRIVATE_SUCCESS_CRITERIA");
    expect(html).not.toContain("private-reviewer");
    expect(html).not.toContain("Publish reviewed statement");
  }
  expect(reads).toHaveLength(0);
  expect(governanceReads).toHaveLength(0);
  expect(synthesisReads).toHaveLength(0);
});

test("invalid IDs and extra query parameters never initiate a private read", async () => {
  for (const [problem, query] of [
    ["../private", {}],
    ["P-REVIEW\n", {}],
    [publicationProblem, { sponsor: "usr_fedcba0987654321" }],
    [publicationProblem, { version: ["1", "2"] }],
    [publicationProblem, { synthesis: ["SYNTH-CLOSING", "SYNTH-OTHER"] }],
    [publicationProblem, { synthesis: "SYNTH-CLOSING@1" }],
    [publicationProblem, { before: "12" }],
    [publicationProblem, { through: "40", limit: "201" }],
  ] as const) {
    const html = await render(problem, query as Record<string, string | string[]>);
    expect(html).toContain("Choose an adopted private problem");
    expect(html).not.toContain("PRIVATE_STATEMENT");
  }
  expect(reads).toHaveLength(0);
  expect(governanceReads).toHaveLength(0);
  expect(synthesisReads).toHaveLength(0);
});

test("unavailable and unauthorized previews do not render stale content or publication controls", async () => {
  for (const result of [
    { ok: false, reason: "refused", status: 404 },
    { ok: false, reason: "refused", status: 403 },
    { ok: false, reason: "unconfigured" },
    { ok: false, reason: "unreachable" },
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
  const html = renderToStaticMarkup(
    <cards.ProblemManager
      sponsorId={publicationSponsor}
      fellows={[]}
      briefs={[]}
      configured
      problems={[
        {
          id: publicationProblem,
          title: publicationPreview.problem.title,
          status: "private-draft",
          unlisted: true,
          created_by_fellow_id: publicationPreview.author.fellow_id,
          current_statement_version: 2,
          created_at: "2026-10-26T12:00:00.000Z",
          updated_at: "2026-10-26T12:00:00.000Z",
        },
      ]}
    />,
  );
  expect(html).toContain(`/console/problems/${publicationProblem}`);
  expect(html).toContain("Review the complete formulation");
  expect(html).not.toContain("I have read the exact formulation");
  expect(html).not.toContain("PRIVATE_STATEMENT");
  for (const field of ["scope", "out_of_scope", "success_criteria"]) {
    expect(html).toContain(`name="${field}"`);
  }
  expect(html.match(/maxLength="4096"/g)).toHaveLength(3);
  expect(html).toContain("Optional: complete all three fields");
});

function publicGovernance(
  status: SponsorProblemGovernanceResponse["problem"]["status"],
): SponsorProblemGovernanceResponse {
  return {
    ...accessWorkspace,
    problem: {
      ...accessWorkspace.problem,
      id: publicationProblem,
      title: "Governed public research",
      status,
    },
    acting_sponsor_id: publicationSponsor,
    authority: {
      owner: true,
      steward: false,
      can_edit_access: !["resolved", "retired"].includes(status),
    },
  };
}

test("published active and dormant problems offer exact result pins after fresh signed governance", async () => {
  readResult = { ok: false, reason: "refused", status: 404 };
  for (const status of ["active", "dormant"] as const) {
    governanceResult = { ok: true, data: publicGovernance(status) };
    const html = await render();
    expect(html).toContain("Review problem results");
    expect(html).toContain("Governed public research");
    expect(html).toContain('name="result_claim_id"');
    expect(html).toContain('name="result_claim_version"');
    expect(html).toContain("Enter result review for this claim");
    expect(html).toContain("/console/disclosures");
    expect(html).not.toContain("PRIVATE_STATEMENT");
    expect(html).not.toContain("PRIVATE_MEMBER_ALPHA");
    expect(html).not.toContain("Publish reviewed statement");
    expect(html).not.toContain('name="closing_synthesis_id"');
  }
  expect(governanceReads).toEqual([
    [publicationSponsor, publicationProblem],
    [publicationSponsor, publicationProblem],
  ]);
  expect(synthesisReads).toHaveLength(0);
});

test("the sponsor can browse pinned result candidates and preserve selection across collection pages", async () => {
  readResult = { ok: false, reason: "refused", status: 404 };
  governanceResult = { ok: true, data: publicGovernance("active") };
  claimResult = { state: "ok", origin: "https://a.asimposium.org", data: {
    schema: CLAIMS_LIST_SCHEMA_ID, problem_id: publicationProblem, cursor: 40,
    after: 8, scanned_through: 12, next_after: 12, count: 1, omitted: ["page_limit"],
    claims: [{ id: "C-3", version: 2, kind: "lemma", statement: "A result for every integer $n$.",
      source_seq: 9, created_at: "2026-11-24T12:00:00.000Z", stale: false }],
  } };
  const html = await render(publicationProblem, { claim: "C-3@2", claim_through: "40", claim_after: "8" });
  expect(claimReads).toEqual([[publicationProblem, undefined, { through: "40", after: "8" }]]);
  expect(html).toContain("Load exact preview of C-3@2");
  expect(html).toContain("claim=C-3%402&amp;claim_through=40&amp;claim_after=12");
  expect(html).toContain('name="result_claim_id"');
  expect(html).toContain('value="C-3"');
  expect(html).toContain('value="2"');
  expect(html).toContain("Load the exact result claim");
  expect(html).not.toContain("Exact result claim C-3@2");
  expect(synthesisReads).toHaveLength(0);
});

test("untrusted result-selection queries fail before private reads", async () => {
  const queries: Record<string, string | string[]>[] = [
    { claim: ["C-3@1", "C-4@1"] }, { claim: "C-3@1", claim_through: "4", claim_after: "5" },
    { claim: "C-3@1", synthesis: "SYNTH-CLOSING" }, { claim: "C-3@1\n" },
  ];
  for (const query of queries) {
    expect(await render(publicationProblem, query)).toContain("Choose an adopted private problem");
  }
  expect(reads).toHaveLength(0);
  expect(governanceReads).toHaveLength(0);
  expect(claimReads).toHaveLength(0);
});

test("result review offers exact replacement selection alongside published closing synthesis", async () => {
  readResult = { ok: false, reason: "refused", status: 404 };
  governanceResult = { ok: true, data: publicGovernance("under-result-review") };
  claimResult = { state: "ok", origin: "https://a.asimposium.org", data: {
    schema: CLAIMS_LIST_SCHEMA_ID, problem_id: publicationProblem, cursor: 40,
    after: 0, scanned_through: 40, next_after: null, count: 1, omitted: [],
    claims: [{ id: "C-3", version: 2, kind: "lemma", statement: "A corrected result for every integer $n$.",
      source_seq: 39, created_at: "2026-11-24T12:00:00.000Z", stale: false }],
  } };
  const html = await render(publicationProblem, { claim: "C-3@2" });
  expect(html).toContain('name="closing_synthesis_id"');
  expect(html).toContain("Load the published closing synthesis");
  expect(html).toContain("immutable publication");
  expect(html).toContain("A preview is not a resolution receipt");
  expect(html).toContain("Famous-problem external-review requirements cannot be bypassed");
  expect(html).not.toContain("<textarea");
  expect(html).toContain('name="result_claim_id"');
  expect(html).toContain('name="result_claim_version"');
  expect(html).toContain('name="confirm_result_selection"');
  expect(html).toContain("Update the result under review");
  expect(html).toContain("Update result review to this claim");
  expect(html).toContain("earlier selections remain in its history");
  expect(html).toContain("Load exact preview of C-3@2");
  expect(html).toContain("Load the exact result claim");
  expect(html).toContain('value="C-3"');
  expect(html).toContain('value="2"');
  expect(html).not.toContain("Resolve using this exact synthesis");
  expect(html).toContain("Published synthesis choices are unavailable");
  expect(synthesisReads).toEqual([[publicationProblem, undefined, {}]]);
  expect(claimReads).toEqual([[publicationProblem, undefined, {}]]);
});

test("authorized result review browses captured publication choices and preselects without resolving", async () => {
  readResult = { ok: false, reason: "refused", status: 404 };
  governanceResult = { ok: true, data: publicGovernance("under-result-review") };
  synthesisResult = {
    state: "ok", origin: "https://a.asimposium.org", data: {
      schema: SYNTHESES_SCHEMA_ID, problem_id: publicationProblem, cursor: 40,
      before: 20, next_before: 12, omitted: ["page_limit"],
      syntheses: [{ ...researchSynthesis, problem_id: publicationProblem }],
    },
  };
  const html = await render(publicationProblem, {
    synthesis: "SYNTH-CLOSING", through: "40", before: "20", limit: "2",
  });
  expect(synthesisReads).toEqual([[publicationProblem, undefined, { through: "40", before: "20", limit: "2" }]]);
  expect(html).toContain("1 readable publication on this page at ledger snapshot 40");
  expect(html).toContain("Load exact preview of SYNTH-CLOSING");
  expect(html).toContain('value="SYNTH-CLOSING"');
  expect(html).toContain(`/console/problems/${publicationProblem}?through=40&amp;before=12&amp;limit=2&amp;synthesis=SYNTH-CLOSING`);
  expect(html).toContain(`/p/${publicationProblem}/syntheses/SYNTH-CLOSING%401`);
  expect(html).not.toContain("Exact published closing synthesis</h3>");
  expect(html).not.toContain("Resolve using this exact synthesis");
  expect(html).not.toContain(researchSynthesis.body_md);
  expect(html).not.toContain("PRIVATE_STATEMENT");
});

test("failed public discovery preserves manual exact preview without claiming a completed resolution", async () => {
  readResult = { ok: false, reason: "refused", status: 404 };
  governanceResult = { ok: true, data: publicGovernance("under-result-review") };
  failSynthesisRead = true;
  const html = await render(publicationProblem, { synthesis: "SYNTH-CLOSING" });
  expect(html).toContain("Published synthesis choices are unavailable");
  expect(html).toContain('name="closing_synthesis_id"');
  expect(html).toContain('value="SYNTH-CLOSING"');
  expect(html).toContain("Load the published closing synthesis");
  expect(html).not.toContain("PUBLIC_DISCOVERY_FAILURE");
  expect(html).not.toContain("Resolve using this exact synthesis");
});

test("terminal and sharpening problems report their real boundary instead of enabling new commands", async () => {
  readResult = { ok: false, reason: "refused", status: 404 };
  for (const [status, message] of [
    ["resolved", "Resolution is recorded"],
    ["retired", "This problem is retired"],
    ["sharpening", "Result review is not available yet"],
  ] as const) {
    governanceResult = { ok: true, data: publicGovernance(status) };
    const html = await render();
    expect(html).toContain(message);
    expect(html).not.toContain('name="closing_synthesis_id"');
    expect(html).not.toContain('name="result_claim_id"');
  }
  expect(synthesisReads).toHaveLength(0);
});

test("a private preview denial never grants public governance without the matching current authority", async () => {
  readResult = { ok: false, reason: "refused", status: 404 };
  const valid = publicGovernance("under-result-review");
  for (const data of [
    { ...valid, acting_sponsor_id: "usr_other_sponsor" },
    { ...valid, problem: { ...valid.problem, id: "P-OTHER" } },
    { ...valid, authority: { owner: false, steward: false, can_edit_access: true } },
    publicGovernance("private-draft"),
  ]) {
    governanceResult = { ok: true, data };
    const html = await render();
    expect(html).toContain("Publication review unavailable");
    expect(html).not.toContain("Governed public research");
    expect(html).not.toContain('name="result_claim_id"');
  }
  for (const failure of [
    { ok: false, reason: "refused", status: 403 },
    { ok: false, reason: "unconfigured" },
    { ok: false, reason: "unreachable" },
  ] as const) {
    governanceReads.length = 0;
    readResult = failure;
    governanceResult = { ok: true, data: valid };
    expect(await render()).not.toContain("Governed public research");
    expect(governanceReads).toHaveLength(0);
  }
  expect(synthesisReads).toHaveLength(0);
});

test("published problem cards link directly to the existing result governance page", () => {
  const html = renderToStaticMarkup(
    <cards.ProblemManager
      sponsorId={publicationSponsor}
      fellows={[]}
      briefs={[]}
      configured
      problems={[
        {
          id: publicationProblem,
          title: "Public research",
          status: "under-result-review",
          unlisted: false,
          created_by_fellow_id: "F-SCIENTIST",
          current_statement_version: 2,
          created_at: "2026-10-26T12:00:00.000Z",
          updated_at: "2026-10-26T12:00:00.000Z",
        },
      ]}
    />,
  );
  expect(html).toContain(`/console/problems/${publicationProblem}`);
  expect(html).toContain("Review result claims and resolution");
  expect(html).toContain("Manage admission and members");
});

async function renderDraftQueue(query: Record<string, string | string[]> = {}) {
  const queue = await import("../../app/console/problems/[problem]/syntheses/page");
  return renderToStaticMarkup(await queue.default({
    params: Promise.resolve({ problem: researchSynthesis.problem_id }),
    searchParams: Promise.resolve(query),
  }));
}

test("a Fellow's sponsor can inspect the full proposed publication without problem governance", async () => {
  identity = "usr_author_sponsor";
  const draft: SynthesisDraftRecord = {
    synthesis_id: researchSynthesis.synthesis_id, problem_id: researchSynthesis.problem_id,
    state: "draft", body_md: researchSynthesis.body_md,
    covers_through: researchSynthesis.covers_through, anchors: researchSynthesis.anchors,
    omitted: researchSynthesis.omitted, selection_policy: researchSynthesis.selection_policy,
    closing_resolution: researchSynthesis.closing_resolution, dropped_single_author_count: 2,
    author_fellow_id: researchSynthesis.authoring_principal, author_sponsor_id: identity,
    session_id: "S-RESEARCH", declared_model: "research-model", harness: "research-harness",
    published_by_principal_id: null, published_event_id: null, published_seq: null, published_at: null,
    created_at: "2026-10-27T00:00:00.000Z",
  };
  const after = { created_at: draft.created_at, synthesis_id: draft.synthesis_id };
  draftResult = { ok: true, data: {
    schema: SYNTHESES_SCHEMA_ID, problem_id: draft.problem_id, drafts: [draft], next_after: after,
  } };
  const html = await renderDraftQueue();
  expect(html.indexOf("Selection policy and declared omissions")).toBeLessThan(html.indexOf("Publish synthesis to ledger"));
  for (const value of [
    draft.selection_policy, draft.omitted[0]!, draft.author_fellow_id, "2 single-author findings",
    "C-3@1", "Declared verified scope", "Remaining external validation",
    draft.closing_resolution!.no_claim_boundary.remaining_external_validation[0]!,
    "Publish synthesis to ledger", "Older synthesis drafts", "&lt;script&gt;",
  ]) expect(html).toContain(value);
  expect(html).not.toContain("<script>untrusted()");
  expect(draftReads).toEqual([[identity, draft.problem_id, undefined]]);
  expect(governanceReads).toHaveLength(0);
  expect(reads).toHaveLength(0);
  const continuation = html.match(/href="([^"]+after_created_at=[^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!continuation) throw new Error("Expected an older-drafts link");
  draftResult = { ok: true, data: { schema: SYNTHESES_SCHEMA_ID, problem_id: draft.problem_id, drafts: [] } };
  const next = await renderDraftQueue(Object.fromEntries(new URL(continuation, "https://asimposium.org").searchParams));
  expect(draftReads.at(-1)).toEqual([identity, draft.problem_id, after]);
  expect(next).toContain("Newest synthesis drafts");
  expect(next).not.toContain("Publish synthesis to ledger");
});

test("a private synthesis queue distinguishes unavailable, invalid, empty and signed-out reads", async () => {
  expect(await renderDraftQueue()).toContain("Synthesis queue unavailable");
  draftReads.length = 0;
  expect(await renderDraftQueue({ after_synthesis: ["SYNTH-A", "SYNTH-B"] })).toContain("Open the synthesis queue");
  expect(draftReads).toHaveLength(0);
  identity = null;
  expect(await renderDraftQueue()).toContain("Sign in with Google");
  expect(draftReads).toHaveLength(0);
  expect(publishCalls).toHaveLength(0);
});

test("publication checks the current account again before submitting the private draft identifier", async () => {
  const { publishSynthesisDraftAction } = await import("../../app/console/problems/[problem]/actions");
  const { problem_id, synthesis_id } = researchSynthesis;
  const original = "usr_draft_author";
  identity = "usr_different_sponsor";
  expect((await publishSynthesisDraftAction(original, problem_id, synthesis_id)).ok).toBe(false);
  expect(publishCalls).toHaveLength(0);
  identity = original;
  const refused = await publishSynthesisDraftAction(original, problem_id, synthesis_id);
  expect(publishCalls).toEqual([[original, problem_id, synthesis_id]]);
  expect(refused.ok).toBe(false);
});
